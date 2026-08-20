use axum::{
    extract::{Path, State},
    response::IntoResponse,
    routing::{get, post, delete, put},
    Json, Router,
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    extract::Request,
    http::StatusCode,
    http::header::{AUTHORIZATION, CONTENT_TYPE, HOST, ORIGIN},
    http::{HeaderValue, Method},
    middleware::{self, Next},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashSet;
use std::fs;
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use tower_http::cors::CorsLayer;
use crate::state::{AppState, ChannelPayload};
use crate::pty_manager::{self, ShellProfile};
use crate::tmux_manager::{self, CapturedContent, TerminalBackend};
use crate::recording_endpoints::{
    start_recording, stop_recording, list_recordings, get_recording,
    get_recording_info, delete_recording, export_recording, get_recording_status,
    get_active_recordings
};
use crate::search_endpoints::{
    search, get_suggestions, clear_index, get_search_history
};
use crate::layout_endpoints::{get_layout, save_layout};
use crate::canvas_endpoints;
use futures::{sink::SinkExt, stream::StreamExt};
use tauri::Emitter;
use tokio::sync::broadcast;
use chrono::{Utc, Duration};
use jsonwebtoken::{encode, Header, EncodingKey};

/// Constant-time string comparison, so token checks don't leak length/content
/// via timing. The token guards a terminal-I/O (RCE-capable) surface.
fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// The renderer's own origins. Windows/Android serve the app over
/// `http(s)://tauri.localhost`; macOS/Linux use the `tauri://localhost` custom
/// protocol. In debug the renderer is served by the Vite dev server declared as
/// `devUrl` in `tauri.conf.json`, so it must be allowed too — omitting it 403s
/// the dev renderer on day one.
const APP_ORIGINS: &[&str] = &[
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
];
#[cfg(debug_assertions)]
const DEV_ORIGIN: &str = "http://localhost:42010";

fn origin_is_app(origin: &str) -> bool {
    if APP_ORIGINS.contains(&origin) {
        return true;
    }
    #[cfg(debug_assertions)]
    {
        return origin == DEV_ORIGIN;
    }
    #[cfg(not(debug_assertions))]
    false
}

/// Reject a `Host` that is not a loopback name. Defence in depth against DNS
/// rebinding: a page on `attacker.example` (resolving to 127.0.0.1) reaches a
/// loopback-bound server, and requests it makes without an `Origin` header would
/// otherwise pass. Absent header ⇒ nothing to validate.
fn host_is_loopback(host: Option<&str>) -> bool {
    let Some(h) = host else { return true };
    let name = if let Some(rest) = h.strip_prefix('[') {
        match rest.split_once(']') {
            Some((inner, _)) => inner,
            None => return false,
        }
    } else {
        h.rsplit_once(':').map(|(n, _)| n).unwrap_or(h)
    };
    name == "localhost"
        || name == "::1"
        || name
            .parse::<std::net::Ipv4Addr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
}

/// Is this request's provenance acceptable?
///
/// D1 keeps the loopback API unauthenticated, so provenance is what stops a web
/// page in the user's browser from driving the user's terminals. A request with
/// NO `Origin` — curl, the MCP sidecar, user scripts — is still allowed: those
/// are the documented clients and a browser always sends one.
fn origin_allowed(origin: Option<&str>, host: Option<&str>) -> bool {
    host_is_loopback(host) && origin.map(origin_is_app).unwrap_or(true)
}

/// Explicit CORS, replacing `CorsLayer::permissive()`. Permissive echoed back
/// whatever `Origin` it was given, so any web page could read API responses —
/// the provenance gate above would be pointless if the browser were still told
/// the response is readable by anyone.
fn cors_layer() -> CorsLayer {
    // `mut` is only used by the debug-only dev-origin push below.
    #[allow(unused_mut)]
    let mut origins: Vec<HeaderValue> = APP_ORIGINS
        .iter()
        .filter_map(|o| HeaderValue::from_str(o).ok())
        .collect();
    #[cfg(debug_assertions)]
    if let Ok(v) = HeaderValue::from_str(DEV_ORIGIN) {
        origins.push(v);
    }
    CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([AUTHORIZATION, CONTENT_TYPE])
        .max_age(std::time::Duration::from_secs(600))
}

/// Must this request carry a bearer token?
///
/// D1 keeps loopback open for NORMAL instances — curl, the MCP sidecar and user
/// scripts stay zero-friction. An ELEVATED instance is a different risk class:
/// an unauthenticated write there turns any medium-integrity process on the
/// machine into Medium→High privilege escalation, because the API spawns
/// processes. Provenance checks alone do not cover that — they only stop
/// browsers, not local programs.
pub fn auth_required(integrity: crate::profile::Integrity, expose: bool) -> bool {
    expose || integrity == crate::profile::Integrity::High
}

/// Routes that require a bearer token **regardless** of `auth_required`.
///
/// D1 leaves a NORMAL instance's loopback API unauthenticated so curl, the MCP
/// sidecar and user scripts stay zero-friction. That trade is fine for terminal
/// verbs, whose blast radius is this user's own shells. It is not fine for a
/// verb that changes another process's shutdown semantics: `/api/hotswap/arm`
/// makes a sibling hold a detach window it never asked for, and any local
/// process could call it.
///
/// The cost of requiring a token here is zero — the only legitimate caller is a
/// sibling instance, which already holds the token from our `InstanceRecord`.
pub fn route_always_requires_token(path: &str) -> bool {
    path.starts_with("/api/hotswap/")
}

/// Start the API server on an already-bound listener. Binding happens in the
/// caller so a bind failure is surfaced BEFORE the old server is torn down
/// (no "silent success with no server" window).
pub async fn start_api_server(
    state: AppState,
    listener: TcpListener,
    expose: bool,
    shutdown: tokio::sync::oneshot::Receiver<()>,
) {
    // The auth gate reads the access token LIVE from shared state on each request,
    // so rotating the token takes effect WITHOUT restarting this server — no
    // dropped UI connections and no same-port rebind race. See `rotate_auth_token`.
    let auth_net = state.network.clone();
    let require_auth = auth_required(crate::profile::current().integrity, expose);
    log::info!(
        "[API] auth {} (expose={expose}, profile={})",
        if require_auth { "REQUIRED" } else { "not required" },
        crate::profile::current().key()
    );
    let app = Router::new()
        // Standard health check
        .route("/health", get(health_check))
        // Monitor compatibility routes (with /api prefix)
        .route("/api/health", get(health_check))
        .route("/api/auth/token", post(generate_token_handler))
        .route("/api/terminals", get(list_terminals))
        .route("/api/terminals", post(create_terminal))
        .route("/api/terminals/:id", get(get_terminal))
        .route("/api/terminals/:id", delete(delete_terminal))
        .route("/api/terminals/:id/size", get(get_terminal_size))
        .route("/api/terminals/:id/size", post(resize_terminal))
        .route("/api/terminals/:id/resize", post(resize_terminal))
        .route("/api/terminals/:id/input", post(write_terminal))
        .route("/api/terminals/:id/output", get(get_terminal_output))
        .route("/api/terminals/:id/snapshot", get(get_terminal_snapshot))
        .route("/api/terminals/:id/full-scrollback", get(get_terminal_full_scrollback))
        .route("/api/terminals/:id/reset", post(reset_terminal))
        // Profile management routes
        .route("/api/profiles", get(list_profiles))
        .route("/api/profiles", post(create_profile))
        .route("/api/profiles/:id", get(get_profile_by_id))
        .route("/api/profiles/:id", put(update_profile))
        .route("/api/profiles/:id", delete(delete_profile))
        .route("/api/profiles/:id/default", post(set_default_profile))
        // Execute prompt (AI integration)
        .route("/api/terminals/:id/execute", post(execute_prompt))
        .route("/api/terminals/:id/prompt", post(execute_prompt))
        // Batch send (fan-out to multiple terminals)
        .route("/api/terminals/batch/execute", post(batch_execute_prompt))
        .route("/api/terminals/batch/input", post(batch_write_terminal))
        // Fleet responder loopback (fabric -> core): run a sentinel-wrapped command
        // in a persistent labeled terminal and long-poll until the sentinel/timeout.
        .route("/api/fleet/local-run", post(fleet_local_run))
        // Fleet routing (MCP → core → local | fabric-proxied). Static paths, so they
        // never collide with `/api/terminals/:id`. Registered before the auth layer.
        .route("/api/fleet/machines", get(fleet_machines))
        .route("/api/fleet/terminals", get(fleet_terminals))
        .route("/api/fleet/execute", post(fleet_execute))
        .route("/api/fleet/screen", post(fleet_screen))
        .route("/api/fleet/close", post(fleet_close))
        // System info endpoints
        // Sibling coordination for an update (design 014 §B3). Token-gated
        // unconditionally — see `route_always_requires_token`.
        .route("/api/hotswap/arm", post(hotswap_arm))
        .route("/api/hotswap/disarm", post(hotswap_disarm))
        .route("/api/system/info", get(get_system_info))
        .route("/api/system/metrics", get(get_system_metrics))
        // Process endpoints
        .route("/api/processes", get(get_active_processes))
        .route("/api/processes/:id/metrics", get(get_process_metrics))
        // Recording endpoints
        .route("/api/recordings/start", post(start_recording))
        .route("/api/recordings/stop/:id", post(stop_recording))
        .route("/api/recordings", get(list_recordings))
        .route("/api/recordings/:id", get(get_recording).delete(delete_recording))
        .route("/api/recordings/:id/info", get(get_recording_info))
        .route("/api/recordings/:id/export", post(export_recording))
        .route("/api/recordings/status/:terminalId", get(get_recording_status))
        .route("/api/recordings/active", get(get_active_recordings))
        // Search endpoints
        .route("/api/search", post(search))
        .route("/api/search/suggestions", get(get_suggestions))
        .route("/api/search/history", get(get_search_history))
        .route("/api/search/index", delete(clear_index))
        // Layout endpoints
        .route("/api/layout", get(get_layout).post(save_layout))
        .route("/api/canvas/graph", get(canvas_endpoints::get_graph))
        .route("/api/canvas/edges", post(canvas_endpoints::create_edge))
        .route("/api/canvas/edges/:id", delete(canvas_endpoints::delete_edge).patch(canvas_endpoints::patch_edge))
        .route("/api/canvas/nodes", put(canvas_endpoints::put_nodes))
        .route("/api/terminals/:id/connections", get(canvas_endpoints::get_connections))
        // Test capture endpoints
        .route("/api/test/start", post(start_test_capture))
        .route("/api/test/stop", post(stop_test_capture))
        .route("/api/test/capture-backend", post(capture_backend))
        .route("/api/test/capture-frontend", post(capture_frontend))
        .route("/api/test/compare/:test_id/:terminal_id", get(compare_captures))
        .route("/api/test/list", get(list_captures))
        // tmux reflow-aware endpoints
        .route("/api/terminals/:id/resize-reflow", post(resize_with_reflow))
        .route("/api/terminals/:id/capture", get(capture_terminal_content))
        .route("/api/system/tmux-status", get(get_tmux_status))
        .route("/api/ws", get(ws_handler)) // Also support /api/ws for monitor
        .route("/ws", get(ws_handler))
        // Auth gate: enforced when exposed on the network OR when this instance
        // runs elevated (D5). A normal loopback instance stays open (backward
        // compatible). Added before CORS so CORS wraps it.
        .layer(middleware::from_fn(move |req: Request, next: Next| {
            let auth_net = auth_net.clone();
            async move {
                let path = req.uri().path().to_string();
                // Checked BEFORE the `!require_auth` early return below — that
                // return is exactly what would otherwise leave these routes wide
                // open on a normal instance (design 014 §B-D5).
                if !require_auth && !route_always_requires_token(&path) {
                    return next.run(req).await;
                }
                // Health stays open so the Settings page can always poll status.
                if path == "/health" || path == "/api/health" {
                    return next.run(req).await;
                }
                // Read the current token live (guard dropped before any await), so a
                // rotation applies to this running server without a restart.
                let token = auth_net.read().auth_token.clone();
                let authorized = if path == "/ws" || path == "/api/ws" {
                    // Browsers can't set WS headers, so the token rides as a query
                    // param. Parse properly (exact key=value), not a substring scan.
                    req.uri()
                        .query()
                        .map(|q| {
                            q.split('&').any(|kv| {
                                let mut it = kv.splitn(2, '=');
                                it.next() == Some("token")
                                    && it.next().map(|v| ct_eq(v, &token)).unwrap_or(false)
                            })
                        })
                        .unwrap_or(false)
                } else {
                    req.headers()
                        .get(AUTHORIZATION)
                        .and_then(|h| h.to_str().ok())
                        .map(|h| ct_eq(h, &format!("Bearer {}", token)))
                        .unwrap_or(false)
                };
                if authorized {
                    next.run(req).await
                } else {
                    (StatusCode::UNAUTHORIZED, "unauthorized").into_response()
                }
            }
        }))
        // Provenance gate, outside the auth gate so it runs first. Applies in
        // every mode: when the loopback API is unauthenticated (D1) this is the
        // only thing standing between a web page and the user's terminals.
        .layer(middleware::from_fn(move |req: Request, next: Next| async move {
            let origin = req
                .headers()
                .get(ORIGIN)
                .and_then(|h| h.to_str().ok())
                .map(str::to_owned);
            let host = req
                .headers()
                .get(HOST)
                .and_then(|h| h.to_str().ok())
                .map(str::to_owned);
            // When exposed the listener is deliberately non-loopback, so the
            // Host is legitimately not a loopback name; only the Origin applies.
            let host = if expose { None } else { host };
            if origin_allowed(origin.as_deref(), host.as_deref()) {
                next.run(req).await
            } else {
                log::warn!(
                    "[API] rejected request from origin={:?} host={:?}",
                    origin,
                    host
                );
                (StatusCode::FORBIDDEN, "forbidden origin").into_response()
            }
        }))
        .layer(cors_layer())
        .with_state(state);

    let local = listener.local_addr();
    log::info!("API server listening on {:?}", local);
    let _ = axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let _ = shutdown.await;
        })
        .await;
    log::info!("API server on {:?} stopped", local);
}

async fn health_check(State(state): State<AppState>) -> impl IntoResponse {
    Json(health_body(&state.instance_id))
}

/// The `/health` response body. Kept as a pure function (no runtime-typed
/// `AppState`, no axum) so the exact contract the startup smoke test depends on
/// — `status: "ok"` plus this process's identity — is directly unit-testable.
/// The identity lets a second instance probing this port tell "this is mine"
/// from "another instance owns it" (P0b conflict detection).
fn health_body(instance_id: &str) -> serde_json::Value {
    json!({
        "status": "ok",
        "app": "auto-terminal",
        "instanceId": instance_id,
    })
}

/// The identity + status block every terminal-shaped API response carries.
///
/// One function so `list_terminals`, `create_terminal` and `get_terminal`
/// cannot drift — they were three hand-copied `json!` literals that already
/// disagreed (`get_terminal` omitted `promptHook`, and used mode "default").
///
/// Key contract (design 011 §4), all of it load-bearing for existing clients:
///   `id` / `processId` — the PTY routing key. Unchanged.
///   `terminalId`       — the renderer LEAF. Two id FORMS, describing who minted
///                        the leaf and NOT the pane's shape: `tb-*` for a
///                        renderer-created tab root (leaf == owner), `tm-*` for
///                        split panes AND for every API-created terminal,
///                        including a solo root. Root/solo/split is determined
///                        only by the pane-tree structure, never by the prefix.
///   `tabId`            — DEPRECATED alias of `terminalId`. Kept byte-identical
///                        so no existing API/MCP client breaks. Removing it is
///                        a major-version change, explicitly not done here.
///   `owningTabId`      — NEW: the tab that owns the leaf. `null` for a
///                        headless (no-renderer-pane) terminal.
/// Resolve any caller-supplied terminal reference to THIS RUN's process id.
///
/// Prefix-dispatched deliberately. Before design 014 the id spaces overlapped —
/// a renderer-created tab's root leaf *was* its tab id — so the only way to
/// reject a tab id passed where a terminal was meant was documentation
/// (`mcp-server/src/server.ts` spent 25 lines explaining it). Now the prefix IS
/// the type, and an agent holding a `tb-` for a two-pane tab gets told so.
///
/// Wrong SPACE is a 400: the caller has a bug we can name. Right space but
/// absent is a 404: the terminal is simply gone. Collapsing those would make a
/// stale `pc-` (per-run, so stale after any restart) look like a client bug.
pub fn resolve_terminal_ref(
    state: &AppState,
    id: &str,
) -> Result<String, (StatusCode, String)> {
    let resolved = match classify_terminal_ref(id)? {
        // `tm-` is the DURABLE id and the one MCP hands out, so it resolves
        // through the index rather than being a map key itself.
        TerminalRef::Leaf => state.identity.process_for_leaf(id),
        TerminalRef::Process => state.terminals.contains_key(id).then(|| id.to_string()),
    };
    resolved.ok_or_else(|| (StatusCode::NOT_FOUND, format!("no live terminal for `{id}`")))
}

/// Which id space a caller-supplied reference belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalRef {
    /// `tm-` — durable across restarts.
    Leaf,
    /// `pc-` (or a legacy id) — this run only.
    Process,
}

/// The SHAPE half of resolution, split out so it is testable without an
/// `AppState` (the `tauri::test` feature crashes the Windows test binary).
///
/// Rejection is by prefix, never by liveness: a tab id that happens to match no
/// live terminal must still be told it is a tab id, or the caller learns
/// nothing and retries the same mistake.
pub fn classify_terminal_ref(id: &str) -> Result<TerminalRef, (StatusCode, String)> {
    if id.starts_with("tb-") {
        return Err((
            StatusCode::BAD_REQUEST,
            format!(
                "`{id}` is a TAB id, not a terminal. Pass a terminal id (`tm-…`) or a process \
                 id (`pc-…`); to name a tab, use the `owningTabId` field."
            ),
        ));
    }
    if id.starts_with("pn-") {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("`{id}` is a PANE id, not a terminal. Pass a terminal id (`tm-…`)."),
        ));
    }
    Ok(if id.starts_with("tm-") { TerminalRef::Leaf } else { TerminalRef::Process })
}

fn terminal_identity_json(t: &crate::state::Terminal, mode: &str) -> serde_json::Value {
    json!({
        "id": t.id,
        "processId": t.id,
        "terminalId": t.renderer_terminal_id,
        "tabId": t.renderer_terminal_id,
        "owningTabId": t.owning_tab_id,
        // Diagnostic only — nothing addresses a terminal by this. It is the
        // pty-host's own key, equal to `terminalId` except for a terminal
        // migrated from a pre-014 build, where it is the legacy `tb-`
        // (design 014 §A5). Exposed so a support question about a terminal that
        // will not reattach is answerable without reading the host's state.
        "sessionKey": t.session_key,
        "name": t.name,
        "profile": t.shell,
        "status": "running",
        "pid": t.pid,
        "createdAt": t.created_at,
        "mode": mode,
        // Command-suggest reads this on reload-reattach to re-seed its prompt
        // gate DISARMED; the ARMED decision is sampled pre-mount via
        // probe_reattach_prompt_gate, NOT here (review 008 M-1).
        "promptHook": t.prompt_hook,
    })
}

async fn list_terminals(State(state): State<AppState>) -> impl IntoResponse {
    let terminals: Vec<_> = state.terminals.iter().map(|e| terminal_identity_json(e.value(), "ui")).collect();
    // Owner discriminator. Terminals live in this process's own AppState, so
    // every entry above belongs to this instance by construction — the useful
    // guarantee is therefore at the RESPONSE level: a client that reaches the
    // wrong instance's port (a stale configured port, a fallback bind) can see
    // that it did, and refuse to reattach to or reap terminals that are not its
    // own. Per-terminal tagging would say the same thing N times.
    Json(json!({
        "terminals": terminals,
        "instance": crate::profile::current().key(),
    }))
}

#[derive(Debug, Serialize, Deserialize)]
struct Claims {
    sub: String,
    permissions: Vec<String>,
    exp: usize,
    iat: usize,
}

#[derive(serde::Deserialize)]
struct AuthReq {
    #[serde(rename = "clientId")]
    client_id: Option<String>,
    permissions: Option<Vec<String>>,
}

async fn generate_token_handler(
    State(state): State<AppState>,
    Json(payload): Json<AuthReq>,
) -> impl IntoResponse {
    let client_id = payload.client_id.unwrap_or_else(|| "unknown".to_string());
    let permissions = payload.permissions.unwrap_or_else(|| vec!["*".to_string()]);
    let exp = Utc::now() + Duration::hours(24);
    
    let claims = Claims {
        sub: client_id,
        permissions: permissions.clone(),
        exp: exp.timestamp() as usize,
        iat: Utc::now().timestamp() as usize,
    };

    let token = match encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(state.jwt_secret.as_bytes()),
    ) {
        Ok(t) => t,
        Err(e) => {
            log::error!("Failed to generate token: {}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "Failed to generate token" }))).into_response()
        },
    };

    Json(json!({
        "token": token,
        "expiresIn": "24h",
        "permissions": permissions
    })).into_response()
}

#[derive(serde::Deserialize)]
struct CreateTerminalReq {
    cols: Option<u16>,
    rows: Option<u16>,
    #[serde(alias = "profileId")]
    profile_id: Option<String>,
    profile: Option<String>, // monitor sends 'profile' instead of 'profile_id'
    shell_type: Option<String>,
    name: Option<String>,
    cwd: Option<String>,
    #[serde(alias = "tabId")]
    tab_id: Option<String>,
    /// The tab that should own the new pane. Preferred over `tab_id`, which is
    /// ambiguous for a split (a client reading `tabId` back off a split pane
    /// gets a `tm-` LEAF, not a tab).
    #[serde(alias = "owningTabId")]
    owning_tab_id: Option<String>,
    #[serde(alias = "paneId")]
    pane_id: Option<String>,
    direction: Option<String>,
    /// The terminal whose agent asked for this spawn, if any. Drives the canvas
    /// auto-connect (`plan/013` Task 20). Accepts either id space — it is resolved
    /// through `AppState::resolve_renderer_id` before it reaches the edge store.
    #[serde(alias = "parentTerminalId")]
    parent_terminal_id: Option<String>,
}

/// The two renderer identities an API-created terminal registers.
#[derive(Debug, PartialEq, Eq)]
struct ApiSpawnIdentity {
    /// Unique per UI pane. The `terminal_history` PRIMARY KEY and the
    /// `terminalId` of every response.
    renderer_terminal_id: String,
    /// The tab the pane belongs to.
    owning_tab_id: String,
}

/// Mint a renderer id: `<prefix>-<9 hex chars of a v4 uuid>`, matching the
/// format the renderer's own generator produces (`utils/id.ts:1-8`).
fn mint_renderer_id(prefix: &str) -> String {
    let raw = uuid::Uuid::new_v4().to_string().replace('-', "");
    format!("{prefix}-{}", &raw[..9])
}

/// Decide both renderer identities for `POST /api/terminals`.
///
/// `mint` supplies the id so the decision is deterministically testable;
/// production passes `mint_renderer_id`.
///
/// Rules (design 011 §5 "The corrected write", as amended by option A — see
/// below):
///   * An explicit `owningTabId`, else `tabId`, is the OWNER — accepted verbatim
///     when it starts with `tb-`, exactly as `api_server.rs:494` did before.
///   * A `tm-` value in either field is a PANE id, not a tab id. Before P0-A it
///     was silently discarded and replaced with an unrelated fresh `tb-`
///     (ground-truth correction C3), so the pane appeared in the wrong tab. Fail
///     closed with a message naming the right field. The spec's §5 snippet does
///     not cover this case; this is a GAP FILL, flagged in the plan header.
///   * The leaf is ALWAYS a fresh `tm-`, unconditionally — see the comment at
///     the mint site below for why an API create may never claim a tab's root
///     (`tb-`) leaf, even for a brand-new, empty tab.
fn resolve_api_spawn_identity(
    tab_id: Option<&str>,
    owning_tab_id: Option<&str>,
    mut mint: impl FnMut(&str) -> String,
) -> Result<ApiSpawnIdentity, String> {
    let owner_hint = owning_tab_id
        .or(tab_id)
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let owning_tab_id = match owner_hint {
        Some(id) if id.starts_with("tb-") => id.to_string(),
        Some(id) if id.starts_with("tm-") => {
            return Err(format!(
                "'{id}' is a pane (leaf) id, not a tab id — pass the owning tab id \
                 (the `owningTabId` field of GET /api/terminals/{{id}})"
            ))
        }
        // Absent, blank, or an unrecognised format: mint one, as before.
        _ => mint("tb"),
    };

    // OPTION A (design 011, root-leaf revision): an API/MCP create NEVER takes
    // a tab's root (`tb-`) leaf — it always mints a fresh `tm-`, even for a
    // brand-new, currently-empty tab.
    //
    // This used to be conditional: a create landing in an empty tab claimed the
    // tab id itself as its leaf (leaf == owner), guarded by `RootLeafClaims` +
    // an `owner_has_live_terminal` scan against the TOCTOU window between that
    // decision and `spawn_terminal` registering its `Terminal`
    // (`pty_manager.rs:862-871`). That guard closed the race between two API
    // creates, but not the race this path can never see: `commands::create_terminal`
    // (the renderer path) *must* be able to reclaim a tab's root leaf when the
    // user restarts an exited root pane — it cannot be refused. So the REST-first
    // ordering (API create claims `tb-a` and commits to it, then the renderer's
    // restart of the same tab also registers `tb-a`) produced two live terminals
    // on one `terminal_history` PRIMARY KEY regardless of how tight the API-side
    // claim was, because the claim only ever covered API-vs-API contention, not
    // API-vs-renderer.
    //
    // The API path cannot distinguish "this is a genuinely new tab" from "this
    // tab's root pane just exited and is about to be restarted by the renderer"
    // — both look identical from here (an owner with no live terminal). Guessing
    // wrong is exactly what produced the duplicate-leaf bug. Rather than narrow
    // that window further, this removes the contention: only
    // `commands::create_terminal` may ever claim a `tb-` root leaf now, so there
    // is nobody left to race it. `RootLeafClaims` (`state.rs`) still exists and
    // is still used there — see `commands.rs`.
    let renderer_terminal_id = mint("tm");

    Ok(ApiSpawnIdentity { renderer_terminal_id, owning_tab_id })
}

async fn create_terminal(
    State(state): State<AppState>,
    Json(payload): Json<CreateTerminalReq>,
) -> impl IntoResponse {
    // Resolve profile if provided (handle multiple field names for compatibility)
    let profile_to_use = payload.profile_id.clone()
        .or(payload.profile.clone())
        .or(payload.shell_type.clone());

    let profiles = crate::pty_manager::get_available_shells();

    // Find the profile to use: 
    // 1. Try to match by ID
    // 2. Try to match by name (case-insensitive)
    // 3. Fall back to default profile
    let profile = if let Some(id_or_name) = profile_to_use.as_ref() {
        profiles.iter().find(|p| p.id == *id_or_name)
            .or_else(|| profiles.iter().find(|p| p.name.to_lowercase() == id_or_name.to_lowercase()))
            // Unknown/placeholder profile (e.g. "default") falls back to the default
            // profile rather than None, which would spawn a bare /bin/bash.
            .or_else(|| profiles.iter().find(|p| p.is_default))
    } else {
        profiles.iter().find(|p| p.is_default)
    };

    let mut shell_name = "default".to_string();
    let (shell_path, shell_args, shell_cwd) = if let Some(profile) = profile {
        shell_name = profile.id.clone();
        // Priority: payload.cwd > profile.cwd
        let effective_cwd = if payload.cwd.is_some() { payload.cwd } else { profile.cwd.clone() };
        (Some(profile.path.clone()), Some(profile.args.clone()), effective_cwd)
    } else {
        // Fallback if no profiles found at all
        (None, None, payload.cwd)
    };

    let terminal_name = payload.name.unwrap_or_else(|| format!("Terminal-{}", shell_name));

    let cols = payload.cols.unwrap_or(80);
    let rows = payload.rows.unwrap_or(24);
    log::info!("Creating terminal with size {}x{}, profile: {}", cols, rows, shell_name);

    // Resolve BOTH renderer identities BEFORE the spawn, so the Terminal
    // registers with them up front (review 062 F-01: patching an id in after
    // spawn returns races a fast-exiting shell's exit-path persist, which then
    // files the final scrollback under the ephemeral pc- id).
    let identity = match resolve_api_spawn_identity(
        payload.tab_id.as_deref(),
        payload.owning_tab_id.as_deref(),
        mint_renderer_id,
    ) {
        Ok(i) => i,
        Err(e) => {
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))).into_response()
        }
    };

    // Routed like the renderer's own create: sidecar-hosted when the PTY host is
    // available, in-process only as a fallback. Spawning DIRECTLY in-process here
    // is what made every agent/MCP-created terminal un-offloadable — one of them
    // alive was enough for `hotswap_preflight` to refuse Offload & Close, because
    // a hot-swap really would have killed it (plan 019).
    //
    // No restored scrollback, as before: `resolve_api_spawn_identity` always mints
    // a FRESH `tm-*` leaf, so the `stage_scrollback` inside the routed spawn can
    // never find a stored row for it.
    let spawned = crate::commands::spawn_routed(
        &state,
        crate::commands::SpawnRequest {
            leaf_id: identity.renderer_terminal_id.clone(),
            // Freshly minted leaf, so nothing legacy to preserve.
            session_key: None,
            owning_tab_id: Some(identity.owning_tab_id.clone()),
            cols,
            rows,
            shell_path,
            shell_name: shell_name.clone(),
            shell_args,
            cwd: shell_cwd,
            name: Some(terminal_name.clone()),
        },
    )
    .await;
    match spawned {
        Ok(id) => {
            // Auto-connect: record that the calling agent spawned this terminal
            // (`plan/013` Task 20, design 010 §7.1). Written HERE rather than in the
            // renderer so the graph is correct even when no window is focused, or when
            // Canvas Mode has never been opened.
            //
            // Both endpoints are renderer LEAF ids. `identity.renderer_terminal_id` is the
            // leaf P0-A minted for this create — a fresh `tm-*` when the owning tab already
            // held a live terminal, the tab's own `tb-*` when it did not (design/011 D7).
            // Using `owning_tab_id` would point every split's edge at its tab's root pane,
            // and would then be dropped as a self-edge whenever the caller IS that root pane.
            if let Some(parent_raw) = payload.parent_terminal_id.as_deref() {
                match state.resolve_renderer_id(parent_raw) {
                    Some(parent_id) if parent_id != identity.renderer_terminal_id => {
                        let edge = crate::canvas_store::CanvasEdge::new(
                            parent_id,
                            identity.renderer_terminal_id.clone(),
                            None,
                            "agent",
                        );
                        // Never fail the spawn for a graph write. Task 16 returns `Result`
                        // precisely so this is a LOGGED failure rather than a silent one.
                        if let Err(e) = state.canvas_store.insert_edge(&edge) {
                            log::warn!("[CANVAS] auto-connect edge not stored: {}", e);
                        }
                    }
                    Some(_) => log::debug!(
                        "[CANVAS] auto-connect skipped: {} spawned itself",
                        parent_raw
                    ),
                    None => log::warn!(
                        "[CANVAS] auto-connect skipped: unknown parent {}",
                        parent_raw
                    ),
                }
            }

            // Notify the UI to create a tab for this new terminal. We BROADCAST (a
            // bare emit_to is documented as not reaching the JS listener here — see
            // commands.rs resolve_tab_drop) and carry the routing target in the
            // payload: every window receives it, but only the one whose label equals
            // `targetWindow` acts on it (the same pattern as app:close-requested).
            let target_window = state.resolve_active_window_label();
            if let Err(e) = state.app_handle.emit("api:createTerminalTab", serde_json::json!({
                "name": terminal_name,
                "profile": shell_name,
                // This key carries the backend PROCESS id (Mode 0 in App.tsx reads
                // it as one), unlike a REST response where `terminalId` is the leaf.
                // Since plan 019 the two COINCIDE for a sidecar-hosted terminal —
                // the map key IS the leaf — and differ only on a fallback spawn, so
                // read the key you need by NAME here, never by "the one that looks
                // different from the others".
                "terminalId": id,
                "tabId": Some(identity.owning_tab_id.clone()),
                // NEW, unambiguous names — see App.tsx Modes 0/1.
                "processId": id,
                "rendererTerminalId": identity.renderer_terminal_id.clone(),
                "owningTabId": identity.owning_tab_id.clone(),
                "paneId": payload.pane_id,
                "direction": payload.direction,
                // PLACEMENT ONLY. The edge is already in the store by this point; the
                // renderer needs this to fan the new node out from its caller, not to
                // decide whether a connection exists.
                "parentTerminalId": payload.parent_terminal_id,
                "targetWindow": target_window
            })) {
                log::warn!("Failed to emit api:createTerminalTab: {}", e);
            }

            if let Some(t) = state.terminals.get(&id) {
                (StatusCode::OK, Json(terminal_identity_json(t.value(), "ui"))).into_response()
            } else {
                (StatusCode::OK, Json(json!({ "id": id, "status": "running" }))).into_response()
            }
        },
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e }))).into_response(),
    }
}

async fn delete_terminal(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    // Normalise the caller-supplied reference to this run's map key. The API
    // reports the DURABLE tm- leaf as `terminalId`, but the per-terminal maps
    // are keyed by the per-run pc- id (design 014 A3). Without this, the
    // documented round trip - read `terminalId`, then address it - 404s.
    let id = state.resolve_ref(&id);
    // Take the pid first (guard drops at end of statement, before cleanup).
    let Some(pid) = state.terminals.get(&id).map(|t| t.pid) else {
        return Json(json!({ "error": "Terminal not found" }));
    };
    // Parity with the UI close path: host-owned → tell the sidecar to close the
    // session; otherwise kill the local shell tree. Then clean up every map.
    if !state.host_close(&id) {
        crate::pty_manager::kill_process_tree(pid);
    }
    state.cleanup_terminal_state(&id);
    Json(json!({ "status": "ok" }))
}

async fn reset_terminal(
    State(_state): State<AppState>,
    Path(_id): Path<String>,
) -> impl IntoResponse {
    // Mock reset for now
    Json(json!({ "status": "ok" }))
}

#[derive(serde::Deserialize)]
struct ResizeReq {
    cols: u16,
    rows: u16,
}

async fn resize_terminal(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(payload): Json<ResizeReq>,
) -> impl IntoResponse {
    // Normalise the caller-supplied reference to this run's map key. The API
    // reports the DURABLE tm- leaf as `terminalId`, but the per-terminal maps
    // are keyed by the per-run pc- id (design 014 A3). Without this, the
    // documented round trip - read `terminalId`, then address it - 404s.
    let id = state.resolve_ref(&id);
    log::info!("Resize request for terminal {}: {}x{}", id, payload.cols, payload.rows);

    // Host-owned terminals resize via the sidecar.
    if state.host_resize(&id, payload.cols, payload.rows) {
        if let Some(mut terminal) = state.terminals.get_mut(&id) {
            terminal.cols = payload.cols;
            terminal.rows = payload.rows;
        }
        state.resize_screen(&id, payload.rows, payload.cols);
        return Json(json!({ "status": "ok", "cols": payload.cols, "rows": payload.rows })).into_response();
    }

    if let Some(master_mutex) = state.ptys.get(&id) {
        let master = match master_mutex.lock() {
            Ok(m) => m,
            Err(_) => {
                return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "terminal pty mutex poisoned" }))).into_response();
            }
        };
        let new_size = portable_pty::PtySize {
            rows: payload.rows,
            cols: payload.cols,
            pixel_width: 0,
            pixel_height: 0,
        };

        match master.resize(new_size) {
            Ok(_) => {
                if let Some(mut terminal) = state.terminals.get_mut(&id) {
                    terminal.cols = payload.cols;
                    terminal.rows = payload.rows;
                }
                // Keep the authoritative screen parser in sync for faithful snapshots.
                state.resize_screen(&id, payload.rows, payload.cols);
                log::info!("Terminal {} resized successfully to {}x{}", id, payload.cols, payload.rows);
                Json(json!({ "status": "ok", "cols": payload.cols, "rows": payload.rows })).into_response()
            }
            Err(e) => {
                log::error!("Failed to resize terminal {}: {}", id, e);
                Json(json!({ "error": e.to_string() })).into_response()
            }
        }
    } else {
        log::warn!("Terminal {} not found for resize", id);
        Json(json!({ "error": "Terminal not found" })).into_response()
    }
}

/// The `terminal:external-activity` event body. Pure so the routing contract —
/// which id the renderer is supposed to flash a tab with — is unit-testable.
///
/// `terminal_id`/`processId` is the DashMap KEY (a `pc-*` id on the in-process
/// path, the renderer leaf on the sidecar path). It is deliberately NOT the
/// same thing `terminalId` means in a REST response; `rendererTerminalId` is
/// the new, unambiguous name for the leaf.
fn external_activity_payload(
    process_id: &str,
    renderer_terminal_id: Option<&str>,
    owning_tab_id: Option<&str>,
) -> serde_json::Value {
    json!({
        // Unchanged for existing consumers.
        "terminalId": process_id,
        "tabId": renderer_terminal_id,
        // NEW, unambiguous names.
        "processId": process_id,
        "rendererTerminalId": renderer_terminal_id,
        // NEW: what `flagTabActivity` actually needs. A `tm-*` leaf resolves
        // against nothing in `state.tabs`, so before P0-A a split pane's
        // activity indicator was silently dropped (design 011 §1.1 item 4).
        "owningTabId": owning_tab_id,
    })
}

/// Emit a one-shot "external interaction" signal so the UI can flash the owning
/// tab. Fired only from the external-only REST handlers (write input / execute
/// prompt) — user keystrokes go through a Tauri invoke command and never reach
/// here. Best-effort; never fails the request.
fn emit_external_activity<R: tauri::Runtime>(state: &AppState<R>, terminal_id: &str) {
    // This is the single chokepoint for API/MCP-driven writes, so tag the
    // terminal's last-write source here. It lets the renderer keep an agent's
    // color scheme "sticky" when API/MCP (not the user) ended the agent.
    if let Some(mut t) = state.terminals.get_mut(terminal_id) {
        t.last_input_source = Some("api".to_string());
        t.last_input_at = Some(chrono::Utc::now().timestamp_millis());
    }
    let (renderer_terminal_id, owning_tab_id) = state
        .terminals
        .get(terminal_id)
        .map(|t| (t.renderer_terminal_id.clone(), t.owning_tab_id.clone()))
        .unwrap_or((None, None));
    if let Err(e) = state.app_handle.emit(
        "terminal:external-activity",
        external_activity_payload(
            terminal_id,
            renderer_terminal_id.as_deref(),
            owning_tab_id.as_deref(),
        ),
    ) {
        log::trace!("Failed to emit terminal:external-activity: {}", e);
    }
}

#[derive(serde::Deserialize)]
struct WriteReq {
    data: String,
}

/// Write raw bytes to a single terminal's PTY. Shared by the single-id
/// `/input` handler and the batch `/batch/input` handler.
fn write_data_to_terminal(
    state: &AppState,
    id: &str,
    data: &str,
) -> Result<(), (StatusCode, String)> {
    use std::io::Write;
    // Host-owned terminals: forward to the sidecar.
    if state.host_write(id, data.as_bytes()) {
        emit_external_activity(state, id);
        return Ok(());
    }
    // Clone the writer Arc out of the map, dropping the DashMap shard guard
    // before locking the inner Mutex.
    let writer_mutex = match state.shell_writer_channels.get(id) {
        Some(r) => r.clone(),
        None => return Err((StatusCode::NOT_FOUND, "Terminal not found".to_string())),
    };
    {
        let mut writer = writer_mutex
            .lock()
            .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "terminal writer mutex poisoned".to_string()))?;
        writer
            .write_all(data.as_bytes())
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    }
    emit_external_activity(state, id);
    Ok(())
}

async fn write_terminal(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(payload): Json<WriteReq>,
) -> impl IntoResponse {
    // Normalise the caller-supplied reference to this run's map key. The API
    // reports the DURABLE tm- leaf as `terminalId`, but the per-terminal maps
    // are keyed by the per-run pc- id (design 014 A3). Without this, the
    // documented round trip - read `terminalId`, then address it - 404s.
    let id = state.resolve_ref(&id);
    match write_data_to_terminal(&state, &id, &payload.data) {
        Ok(()) => Json(json!({ "status": "ok" })).into_response(),
        // Preserve the original handler's exact behavior: "not found" returned
        // HTTP 200 with an error body (implicit default status), not 404.
        Err((StatusCode::NOT_FOUND, _)) => Json(json!({ "error": "Terminal not found" })).into_response(),
        Err((code, msg)) => (code, Json(json!({ "error": msg }))).into_response(),
    }
}

#[derive(serde::Deserialize)]
struct OutputQuery {
    last_lines: Option<usize>,
    lines: Option<usize>,  // Number of lines to return (most recent if offset=0)
    offset: Option<usize>, // Line offset for pagination (0 = return last N lines)
    #[allow(dead_code)]
    clean: Option<String>, // Kept for backwards compat, ANSI is now always stripped
}

fn render_terminal_history(
    history: &std::collections::VecDeque<String>,
    rows: u16,
    cols: u16,
) -> String {
    let mut parser = vt100::Parser::new(rows.max(1), cols.max(1), 10_000);

    for chunk in history.iter() {
        parser.process(chunk.as_bytes());
    }

    parser.screen().contents()
}

fn terminal_size_for_output(state: &AppState, id: &str) -> (u16, u16) {
    state
        .terminals
        .get(id)
        .map(|terminal| (terminal.rows.max(1), terminal.cols.max(1)))
        .unwrap_or((24, 80))
}

async fn get_terminal_size(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    // Normalise the caller-supplied reference to this run's map key. The API
    // reports the DURABLE tm- leaf as `terminalId`, but the per-terminal maps
    // are keyed by the per-run pc- id (design 014 A3). Without this, the
    // documented round trip - read `terminalId`, then address it - 404s.
    let id = state.resolve_ref(&id);
    if let Some(terminal) = state.terminals.get(&id) {
        Json(json!({ "cols": terminal.cols, "rows": terminal.rows })).into_response()
    } else {
        (StatusCode::NOT_FOUND,
         Json(json!({ "error": "Terminal not found" }))).into_response()
    }
}

async fn get_terminal_output(
    State(state): State<AppState>,
    Path(id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<OutputQuery>,
) -> impl IntoResponse {
    // Normalise the caller-supplied reference to this run's map key. The API
    // reports the DURABLE tm- leaf as `terminalId`, but the per-terminal maps
    // are keyed by the per-run pc- id (design 014 A3). Without this, the
    // documented round trip - read `terminalId`, then address it - 404s.
    let id = state.resolve_ref(&id);
    // Clone the chunks under a brief inner lock (Arc cloned via get_history, so
    // no DashMap shard guard is held here), then render with NO locks held —
    // rendering replays up to ~1MB through a vt100 parser, and doing that under
    // the history lock starved the PTY output consumer (app-wide output stall).
    let chunks = state
        .get_history(&id)
        .map(|h| h.lock().unwrap_or_else(|p| p.into_inner()).clone());
    if let Some(history) = chunks {
        {
            let (rows, cols) = terminal_size_for_output(&state, &id);
            let cleaned = render_terminal_history(&history, rows, cols);

            // Split into individual lines
            let all_lines: Vec<String> = cleaned
                .lines()
                .map(|s| s.trim_end().to_string())
                .filter(|s| !s.is_empty())
                .collect();

            let total_lines = all_lines.len();

            // Apply offset and lines limit for pagination
            let offset = query.offset.unwrap_or(0);
            let requested = query.lines.or(query.last_lines).unwrap_or(50);

            // If offset=0, return the LAST N lines (most recent); otherwise paginate from offset
            let page_lines: Vec<String> = if offset == 0 {
                all_lines.iter().rev().take(requested).cloned().collect::<Vec<_>>().into_iter().rev().collect()
            } else {
                all_lines.into_iter().skip(offset).take(requested).collect()
            };

            // raw: the returned page joined into a single string (single source of truth)
            let raw_page = page_lines.join("\n");

            return Json(json!({
                "totalLines": total_lines,
                "offset": offset,
                "raw": raw_page
            }));
        }
    }

    // Return empty if not found or empty
    Json(json!({
        "totalLines": 0,
        "offset": 0,
        "raw": ""
    }))
}

/// Returns a styled escape-sequence snapshot of the terminal's current visible
/// screen, taken from the backend's authoritative vt100 parser. Written into a
/// freshly-reset xterm of the same size it reproduces the screen exactly (colors
/// + cursor position), so a reconnecting client stays in sync with what the
/// running TUI believes is on screen. This is the foundation of smooth hydration.
///
/// The snapshot is taken at the parser's current size; clients align the size by
/// calling resize first. Any `cols`/`rows` query params are accepted (for
/// forward-compatibility) but intentionally ignored to avoid read-side resizing.
async fn get_terminal_snapshot(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    // Normalise the caller-supplied reference to this run's map key. The API
    // reports the DURABLE tm- leaf as `terminalId`, but the per-terminal maps
    // are keyed by the per-run pc- id (design 014 A3). Without this, the
    // documented round trip - read `terminalId`, then address it - 404s.
    let id = state.resolve_ref(&id);
    // Restore replay (one-shot): when a previous-session scrollback prefix is staged,
    // serve it ALONE — do NOT append the freshly-spawned shell's current screen.
    // That screen comes from `contents_formatted()`, which BEGINS with an
    // erase-display (\x1b[2J); appended after the prefix it wipes the just-replayed
    // scrollback before it can scroll into xterm's scrollback (so a short restored
    // session — e.g. an `ls` that still fits on screen — vanished entirely). With
    // prefix-only, the fresh shell's own live output paints the current screen right
    // after the divider, pushing the restored content up into scrollback where the
    // user can scroll back to it.
    if let Some((_, prefix)) = state.replay_prefix.remove(&id) {
        log::info!("Restored {} bytes of prior-session scrollback for terminal {}", prefix.len(), id);
        let (rows, cols) = terminal_size_for_output(&state, &id);
        return Json(json!({ "snapshot": prefix, "rows": rows, "cols": cols }));
    }
    match state.screen_snapshot(&id) {
        Some(mut bytes) => {
            // Re-assert live input modes (mouse tracking, bracketed paste, focus
            // reporting, application cursor/keypad) after the screen content:
            // contents_formatted() does not include them, and a rehydrating xterm
            // (window reload, tab moved to another window) starts from a reset —
            // without this the mode state a running TUI already asserted is lost,
            // e.g. the suggest-popup suppression signals for agent CLIs.
            bytes.extend_from_slice(&state.input_modes_snapshot(&id));
            let snapshot = String::from_utf8_lossy(&bytes).to_string();
            let (rows, cols) = terminal_size_for_output(&state, &id);
            Json(json!({ "snapshot": snapshot, "rows": rows, "cols": cols }))
        }
        None => {
            log::warn!("Snapshot requested for {} but no screen parser exists", id);
            Json(json!({ "snapshot": "", "rows": 0, "cols": 0 }))
        }
    }
}

/// Returns the FULL rendered scrollback (not just the current visible screen)
/// from the backend's authoritative vt100 parser. Unlike `get_terminal_snapshot`
/// (current screen only, for reattach hydration), this reproduces the entire
/// session history — the parser's scrollback survives `2J`/`3J` clears for
/// content that already scrolled into history (see
/// `state.rs::full_scrollback_survives_2j_3j_for_already_scrolled_history`), so
/// this is also correct to call after a client-side wipe (e.g. codex's
/// resize-triggered ED3 erasing xterm's OWN accumulated scrollback) even though
/// the LIVE xterm view lost that content.
async fn get_terminal_full_scrollback(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    // Normalise the caller-supplied reference to this run's map key. The API
    // reports the DURABLE tm- leaf as `terminalId`, but the per-terminal maps
    // are keyed by the per-run pc- id (design 014 A3). Without this, the
    // documented round trip - read `terminalId`, then address it - 404s.
    let id = state.resolve_ref(&id);
    match state.full_scrollback_snapshot(&id) {
        Some(mut bytes) => {
            // Re-assert live input modes (mouse tracking, bracketed paste, focus
            // reporting, application cursor/keypad) after the content, same as
            // get_terminal_snapshot above: full_scrollback_snapshot's replay is a
            // reset()+write() on the client, which drops whatever modes the still-
            // running program already asserted (it won't re-send them mid-session).
            bytes.extend_from_slice(&state.input_modes_snapshot(&id));
            let blob = String::from_utf8_lossy(&bytes).to_string();
            let (rows, cols) = terminal_size_for_output(&state, &id);
            Json(json!({ "blob": blob, "rows": rows, "cols": cols }))
        }
        None => Json(json!({ "blob": "", "rows": 0, "cols": 0 })),
    }
}

// Profile management endpoints

async fn list_profiles() -> impl IntoResponse {
    let profiles = pty_manager::get_available_shells();
    Json(json!({ "profiles": profiles }))
}

async fn get_profile_by_id(Path(id): Path<String>) -> impl IntoResponse {
    match pty_manager::get_profile(&id) {
        Some(profile) => (StatusCode::OK, Json(json!(profile))),
        None => (StatusCode::NOT_FOUND, Json(json!({ "error": "Profile not found" }))),
    }
}

#[derive(serde::Deserialize)]
struct CreateProfileReq {
    name: String,
    path: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: std::collections::HashMap<String, String>,
    cwd: Option<String>,
    icon: Option<String>,
}

async fn create_profile(Json(payload): Json<CreateProfileReq>) -> impl IntoResponse {
    let profile = ShellProfile {
        id: String::new(), // Will be auto-generated
        name: payload.name,
        path: payload.path,
        args: payload.args,
        env: payload.env,
        cwd: payload.cwd,
        icon: payload.icon,
        is_default: false,
        is_custom: true,
    };
    
    match pty_manager::add_custom_profile(profile) {
        Ok(id) => (StatusCode::CREATED, Json(json!({ "id": id, "status": "created" }))),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e }))),
    }
}

async fn update_profile(
    Path(id): Path<String>,
    Json(payload): Json<CreateProfileReq>,
) -> impl IntoResponse {
    let profile = ShellProfile {
        id: id.clone(),
        name: payload.name,
        path: payload.path,
        args: payload.args,
        env: payload.env,
        cwd: payload.cwd,
        icon: payload.icon,
        is_default: false,
        is_custom: true,
    };
    
    match pty_manager::update_custom_profile(&id, profile) {
        Ok(()) => (StatusCode::OK, Json(json!({ "status": "updated" }))),
        Err(e) => (StatusCode::NOT_FOUND, Json(json!({ "error": e }))),
    }
}

async fn delete_profile(Path(id): Path<String>) -> impl IntoResponse {
    match pty_manager::delete_custom_profile(&id) {
        Ok(()) => (StatusCode::OK, Json(json!({ "status": "deleted" }))),
        Err(e) => (StatusCode::NOT_FOUND, Json(json!({ "error": e }))),
    }
}

async fn set_default_profile(Path(_id): Path<String>) -> impl IntoResponse {
    // TODO: Implement set default profile
    Json(json!({ "status": "ok" }))
}

async fn get_terminal(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    // Normalise the caller-supplied reference to this run's map key. The API
    // reports the DURABLE tm- leaf as `terminalId`, but the per-terminal maps
    // are keyed by the per-run pc- id (design 014 A3). Without this, the
    // documented round trip - read `terminalId`, then address it - 404s.
    let id = state.resolve_ref(&id);
    if let Some(terminal) = state.terminals.get(&id) {
        let mut body = terminal_identity_json(terminal.value(), "default");
        // Canvas identity, so an agent learns which node and group it is in one call
        // (`plan/013` Task 19). Merged HERE rather than inside `terminal_identity_json`,
        // which has three call sites: adding it there would put a canvas-registry lock and a
        // SQLite query on EVERY entry of `list_terminals`, for a field that endpoint was never
        // asked to carry.
        if let Some(object) = body.as_object_mut() {
            object.insert(
                "node".to_string(),
                crate::canvas_endpoints::canvas_node_json(&state, &id),
            );
        }
        (StatusCode::OK, Json(body))
    } else {
        (StatusCode::NOT_FOUND, Json(json!({ "error": "Terminal not found" })))
    }
}

// CLI prompt patterns for AI integration
fn get_cli_pattern(cli_type: &str) -> Option<(&'static str, &'static str)> {
    // OS-aware line endings for raw PTY input
    let shell_enter = if cfg!(target_os = "windows") { "\r\n" } else { "\r" };
    
    match cli_type {
        "claude" => Some(("", "\x1b\r\r")), // Escape + two carriage returns (universal for Claude CLI)
        "gemini" | "gemini-probe" => Some(("", "\r")), // Temporary override per user
        // Codex and opencode TUIs submit on a plain CR. Deliberately NOT the copilot
        // pattern: Down-Arrow navigates composer/message history in both, so
        // `\x1b[B\r` risks submitting the wrong buffer. Verified live against
        // codex-cli 0.146.0 and opencode 1.18.9. See the paste/submit race note in
        // `send_prompt_to_terminal` — codex swallows a same-read-chunk CR, opencode
        // does not.
        "codex" | "codex-probe" => Some(("", "\r")),
        "opencode" | "opencode-probe" => Some(("", "\r")),
        "chatgpt" => Some(("", shell_enter)),
        "copilot" | "copilot-probe" => Some(("", "\x1b[B\r")), // Down Arrow + Enter for interactive menu bypass
        "default" | "shell" => {
            if cfg!(target_os = "macos") {
                Some(("", "\r\x0c"))
            } else {
                Some(("", shell_enter))
            }
        },
        _ => {
            if cli_type.ends_with("-probe") {
                Some(("", "\r"))
            } else {
                None
            }
        },
    }
}

/// Which shell dialect a target terminal runs, for sentinel-command wrapping.
/// pwsh/powershell collapse to `PowerShell`; bash/zsh/sh/wsl/dash to `Posix`;
/// cmd.exe to `Cmd` (frozen SENTINEL contract).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShellKind {
    PowerShell,
    Posix,
    Cmd,
}

/// Classify a shell from its profile path + name. Unknown shells fall back to
/// the platform default (cmd on Windows, posix elsewhere) — matching
/// `spawn_terminal`'s own last-resort fallback.
pub fn classify_shell_kind(path: &str, name: &str) -> ShellKind {
    let hay = format!("{} {}", path.to_ascii_lowercase(), name.to_ascii_lowercase());
    if hay.contains("powershell") || hay.contains("pwsh") {
        ShellKind::PowerShell
    } else if hay.contains("cmd") {
        ShellKind::Cmd
    } else if hay.contains("bash")
        || hay.contains("zsh")
        || hay.contains("wsl")
        || hay.contains("dash")
        || hay.contains("sh")
    {
        ShellKind::Posix
    } else if cfg!(target_os = "windows") {
        ShellKind::Cmd
    } else {
        ShellKind::Posix
    }
}

/// Wrap `command` so the shell prints a unique done-marker carrying the process
/// exit code on its own output line. The marker text is `@@TFDONE:NONCE:CODE@@`.
/// The variable is left UNEXPANDED in the command text so the terminal's echo of
/// the pasted command (which still shows `$LASTEXITCODE` / `%ERRORLEVEL%` / `$?`,
/// no digits) never matches `sentinel_exit_code`; only the executed output does.
pub fn build_sentinel_command(kind: ShellKind, command: &str, nonce: &str) -> String {
    match kind {
        ShellKind::PowerShell => {
            // $LASTEXITCODE is $null in a fresh session and after any cmdlet (it only tracks
            // EXTERNAL programs; cmdlets set $?). Guard so a NUMERIC code is ALWAYS emitted —
            // otherwise the marker reads "@@TFDONE:N:@@" (empty between the colons),
            // sentinel_exit_code never matches, and the run false-times-out.
            format!(
                "{} ; $c = if ($LASTEXITCODE -ne $null) {{ $LASTEXITCODE }} elseif ($?) {{ 0 }} else {{ 1 }} ; Write-Output \"@@TFDONE:{}:$c@@\"",
                command, nonce
            )
        }
        ShellKind::Posix => {
            format!("{} ; printf \"@@TFDONE:{}:%s@@\\n\" \"$?\"", command, nonce)
        }
        ShellKind::Cmd => {
            // `%ERRORLEVEL%` percent-expands at PARSE time (the stale, pre-command value), so
            // an `&`-chained echo would report the WRONG exit code. Run the marker in a child
            // `cmd /v:on /c` so delayed-expansion `!ERRORLEVEL!` reads the INHERITED
            // post-command exit code. `!...!` is not expanded by the outer shell, so it passes
            // literally to the child (which has delayed expansion enabled).
            format!("{} & cmd /v:on /c \"echo @@TFDONE:{}:!ERRORLEVEL!@@\"", command, nonce)
        }
    }
}

/// Scan decoded terminal output for THIS run's done-marker and return the exit
/// code. Equivalent to the regex `@@TFDONE:NONCE:(-?\d+)@@` but dependency-free:
/// finds `@@TFDONE:NONCE:`, then parses the signed integer up to the closing
/// `@@`. A non-numeric token (the command echo's literal variable) fails the
/// parse and the scan continues, so only the executed output line matches.
pub fn sentinel_exit_code(haystack: &str, nonce: &str) -> Option<i32> {
    let needle = format!("@@TFDONE:{}:", nonce);
    let mut from = 0;
    while let Some(rel) = haystack[from..].find(&needle) {
        let start = from + rel + needle.len();
        let rest = &haystack[start..];
        if let Some(end) = rest.find("@@") {
            if let Ok(code) = rest[..end].parse::<i32>() {
                return Some(code);
            }
        }
        from = start;
    }
    None
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecutePromptReq {
    prompt: String,
    #[serde(default = "default_cli_type")]
    cli_type: String,
    submission_signal: Option<String>,
    custom_pattern: Option<CustomPattern>,
}

#[derive(serde::Deserialize, Clone)]
struct CustomPattern {
    separator: Option<String>,
    end_indicator: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BatchExecuteReq {
    terminal_ids: Vec<String>,
    prompt: String,
    #[serde(default = "default_cli_type")]
    cli_type: String,
    submission_signal: Option<String>,
    custom_pattern: Option<CustomPattern>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BatchInputReq {
    terminal_ids: Vec<String>,
    data: String,
}

fn default_cli_type() -> String {
    "copilot".to_string()
}

/// Dedup terminal ids preserving first-seen order, so a fan-out never writes
/// the same content to one terminal twice.
fn dedup_preserve_order(ids: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    ids.iter().filter(|id| seen.insert((*id).clone())).cloned().collect()
}

// ---- Fleet routing (MCP → core) -------------------------------------------
//
// A pure, IO-free resolver decides whether a fleet request targets THIS machine
// or a remote peer, plus a presence-aware classifier that turns a resolution into
// an HTTP route. Both are unit-tested without an AppState; the async handlers
// (below) supply the roster + fabric presence and perform the IO.

/// One machine in the fleet roster (this instance plus any fabric peers).
#[derive(Debug, Clone)]
pub struct FleetMachine {
    pub machine_id: String,
    pub device_name: String,
    /// Canonical `"windows"|"macos"|"linux"`, or `None`/other for a peer whose OS is
    /// unknown or not one of the three (then targetable by machineId only).
    pub os: Option<String>,
    pub online: bool,
}

/// The outcome of resolving a fleet request against the roster.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FleetResolution {
    /// This machine handles it.
    Local,
    /// A remote peer, whole-machine (spawn a new terminal there).
    Remote { machine_id: String },
    /// A specific existing terminal on a remote peer.
    RemoteTerminal { machine_id: String, terminal_id: String },
    /// A `targetOS` matched more than one online peer.
    Ambiguous { candidates: Vec<String> },
    /// A `targetOS` matched no online peer.
    NoMatch,
}

/// A resolution combined with fabric presence — the concrete route the execute
/// handler takes. Separated from [`FleetResolution`] so the 501/409/404 mapping is
/// unit-testable without a live server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecuteRoute {
    Local,
    Proxy { device_id: String, terminal_id: Option<String> },
    NotInstalled,
    Ambiguous(Vec<String>),
    NoMatch,
}

/// Canonicalize a caller-supplied OS string: lowercase, then `osx`/`darwin` → `macos`
/// and `win`/`win32` → `windows`. Roster OS values are already canonical
/// (`std::env::consts::OS`), so aliasing is applied to the request side only.
fn alias_os(raw: &str) -> String {
    match raw.trim().to_lowercase().as_str() {
        "osx" | "darwin" | "macos" => "macos".to_string(),
        "win" | "win32" | "windows" => "windows".to_string(),
        other => other.to_string(),
    }
}

/// Pure resolver. Precedence: `terminalId` → `machineId` → `targetOS` → local.
/// `self_machine_id` is this instance's id; a match on it collapses to `Local`.
fn resolve_fleet_target(
    target_os: Option<&str>,
    machine_id: Option<&str>,
    terminal_id: Option<&str>,
    roster: &[FleetMachine],
    self_machine_id: &str,
) -> FleetResolution {
    let machine_id = machine_id.filter(|s| !s.is_empty());
    // 1. An explicit terminal id is the strongest signal. A remote machine id makes
    //    it a RemoteTerminal; otherwise the terminal is local (the handler still has
    //    the id to run in the existing local terminal).
    if let Some(tid) = terminal_id.filter(|s| !s.is_empty()) {
        return match machine_id {
            Some(mid) if mid != self_machine_id => FleetResolution::RemoteTerminal {
                machine_id: mid.to_string(),
                terminal_id: tid.to_string(),
            },
            _ => FleetResolution::Local,
        };
    }
    // 2. An explicit machine id: self → Local, else Remote (spawn a new terminal).
    if let Some(mid) = machine_id {
        return if mid == self_machine_id {
            FleetResolution::Local
        } else {
            FleetResolution::Remote { machine_id: mid.to_string() }
        };
    }
    // 3. targetOS: the UNIQUE online machine (self counts) with that canonical OS.
    if let Some(os) = target_os.filter(|s| !s.is_empty()) {
        let want = alias_os(os);
        let candidates: Vec<&FleetMachine> = roster
            .iter()
            .filter(|m| m.online && m.os.as_deref() == Some(want.as_str()))
            .collect();
        return match candidates.as_slice() {
            [] => FleetResolution::NoMatch,
            [only] => {
                if only.machine_id == self_machine_id {
                    FleetResolution::Local
                } else {
                    FleetResolution::Remote { machine_id: only.machine_id.clone() }
                }
            }
            many => FleetResolution::Ambiguous {
                candidates: many.iter().map(|m| m.machine_id.clone()).collect(),
            },
        };
    }
    // 4. No routing signal → run here.
    FleetResolution::Local
}

/// Fold a resolution together with fabric presence into the concrete execute route.
/// Remote work with the fabric absent becomes [`ExecuteRoute::NotInstalled`] (HTTP 501).
fn classify_fleet_route(res: FleetResolution, fabric_installed: bool) -> ExecuteRoute {
    match res {
        FleetResolution::Local => ExecuteRoute::Local,
        FleetResolution::Remote { machine_id } => {
            if fabric_installed {
                ExecuteRoute::Proxy { device_id: machine_id, terminal_id: None }
            } else {
                ExecuteRoute::NotInstalled
            }
        }
        FleetResolution::RemoteTerminal { machine_id, terminal_id } => {
            if fabric_installed {
                ExecuteRoute::Proxy { device_id: machine_id, terminal_id: Some(terminal_id) }
            } else {
                ExecuteRoute::NotInstalled
            }
        }
        FleetResolution::Ambiguous { candidates } => ExecuteRoute::Ambiguous(candidates),
        FleetResolution::NoMatch => ExecuteRoute::NoMatch,
    }
}

/// Parse one entry of the fabric `GET /peers` array into a [`FleetMachine`].
/// Returns `None` when `device_id` is absent (never fabricate a machine).
fn peer_value_to_machine(p: &serde_json::Value) -> Option<FleetMachine> {
    let machine_id = p.get("device_id").and_then(|v| v.as_str())?.to_string();
    Some(FleetMachine {
        machine_id,
        device_name: p.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        os: p.get("os").and_then(|v| v.as_str()).map(|s| s.to_string()),
        online: p.get("online").and_then(|v| v.as_bool()).unwrap_or(false),
    })
}

/// Serialize a machine for the `/api/fleet/machines` roster, tagging `self`.
fn machine_to_json(m: &FleetMachine, is_self: bool) -> serde_json::Value {
    json!({
        "machineId": m.machine_id,
        "deviceName": m.device_name,
        "os": m.os,
        "online": m.online,
        "self": is_self,
    })
}

/// This instance's display name for the roster: the OS hostname, mirroring the
/// `get_system_info` hostname logic.
fn self_hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "this-machine".to_string())
}

/// Build the fleet roster: this instance (always online) plus fabric peers when the
/// fabric child is present. Never errors — a fabric read failure yields self only.
async fn fleet_roster<R: tauri::Runtime>(state: &AppState<R>) -> Vec<FleetMachine> {
    let mut out = vec![FleetMachine {
        machine_id: state.instance_id.clone(),
        device_name: self_hostname(),
        os: Some(std::env::consts::OS.to_string()),
        online: true,
    }];
    if crate::fabric_manager::fabric_installed(state) {
        let client = crate::fabric_manager::FabricClient::new(state.fabric_control_port);
        if let Ok(raw) = client.get("/peers").await {
            if let Some(arr) = raw.get("peers").and_then(|v| v.as_array()) {
                out.extend(arr.iter().filter_map(peer_value_to_machine));
            }
        }
    }
    out
}

/// GET /api/fleet/machines — the fleet roster. Always includes THIS machine (online,
/// `self: true`); adds fabric peers when the fabric is present. Never 501: with no
/// fabric this returns exactly the self machine so an agent can still see where it is.
async fn fleet_machines(State(state): State<AppState>) -> impl IntoResponse {
    let roster = fleet_roster(&state).await;
    let machines: Vec<serde_json::Value> = roster
        .iter()
        .map(|m| machine_to_json(m, m.machine_id == state.instance_id))
        .collect();
    Json(json!({ "machines": machines }))
}

/// GET /api/fleet/terminals — this machine's terminals, each tagged with this
/// instance's machine identity so an agent can address them cross-machine. (Peer
/// terminals are addressed directly via `/api/fleet/screen` with the machineId an
/// agent learned from `/api/fleet/machines`.)
async fn fleet_terminals(State(state): State<AppState>) -> impl IntoResponse {
    let machine_id = state.instance_id.clone();
    let device_name = self_hostname();
    let os = std::env::consts::OS.to_string();
    let terminals: Vec<serde_json::Value> = state
        .terminals
        .iter()
        .map(|entry| {
            let t = entry.value();
            json!({
                "id": t.id,
                "title": t.name,
                "running": true,
                "machineId": machine_id,
                "os": os,
                "deviceName": device_name,
                // Identity parity with the other terminal responses (design 011
                // §4). The MCP `list_terminals` tool proxies this body verbatim.
                "terminalId": t.renderer_terminal_id,
                "owningTabId": t.owning_tab_id,
            })
        })
        .collect();
    Json(json!({ "terminals": terminals }))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct FleetExecuteReq {
    command: String,
    #[serde(rename = "targetOS")]
    target_os: Option<String>,
    machine_id: Option<String>,
    terminal_id: Option<String>,
    timeout_ms: Option<u64>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct FleetScreenReq {
    machine_id: Option<String>,
    terminal_id: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct FleetCloseReq {
    machine_id: Option<String>,
    terminal_id: String,
}

/// Clamp a requested fleet timeout to `[1000, 3_600_000]` ms, defaulting to 60 s.
/// Mirrors the responder-side clamp so both ends agree.
fn clamp_fleet_timeout(ms: Option<u64>) -> u64 {
    ms.unwrap_or(60_000).clamp(1_000, 3_600_000)
}

/// Run a command on THIS machine by proxying to the local responder endpoint
/// `POST /api/fleet/local-run` over loopback (using this instance's own api port +
/// token). Returns the responder JSON `{ terminalId, done, exitCode, screen }`.
async fn local_fleet_run(
    state: &AppState,
    command: &str,
    terminal_id: Option<&str>,
    timeout_ms: u64,
) -> Result<serde_json::Value, (StatusCode, String)> {
    let cfg = state.network.read().clone();
    // The EFFECTIVE port, emphatically not the configured one. This posts a command to be
    // RUN, with our bearer token attached: aimed at the configured port from a second
    // instance it executes in the sibling app's terminal instead of ours — the loudest
    // version of the wrong-instance bug, since it does not fail, it succeeds elsewhere.
    // No port of our own means no local responder to proxy to; failing is the only honest
    // answer, because the configured port is exactly where the wrong app is listening.
    let api_port = state
        .effective_endpoints
        .read()
        .api_port
        .ok_or_else(|| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "this instance is not serving an API port; cannot run locally".to_string(),
            )
        })?;
    let url = format!("http://127.0.0.1:{}/api/fleet/local-run", api_port);
    // Give the loopback call the full command budget plus margin so it doesn't abort
    // before the responder's own timeout returns a live (done=false) handle.
    let client = crate::network_commands::localhost_client(timeout_ms.saturating_add(5_000))
        .unwrap_or_else(reqwest::Client::new);
    let mut body = json!({ "command": command, "timeoutMs": timeout_ms });
    if let Some(tid) = terminal_id {
        body["terminalId"] = json!(tid);
    }
    let resp = client
        .post(&url)
        .bearer_auth(&cfg.auth_token)
        .json(&body)
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("local-run request failed: {e}")))?;
    let status = resp.status();
    let val: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("local-run bad response: {e}")))?;
    if !status.is_success() {
        return Err((StatusCode::BAD_GATEWAY, format!("local-run returned {status}")));
    }
    Ok(val)
}

/// Map a fabric `/fleet/*` proxy failure to an HTTP status + message. The fabric answers
/// 403 for a denied grant and 502 for a peer-side error; preserve 403, fold everything
/// else (incl. connect/timeout) to 502.
///
/// `e`'s Display now carries the fabric's own `{"error": ...}` reason rather than a bare
/// status line, so an MCP fleet caller learns WHY a remote op failed instead of reading
/// "502 Bad Gateway" (same defect as the pairing path — see `FabricError`).
fn map_fabric_fleet_error(
    op: &str,
    e: crate::fabric_manager::FabricError,
) -> (StatusCode, serde_json::Value) {
    if e.status() == Some(StatusCode::FORBIDDEN) {
        (StatusCode::FORBIDDEN, json!({ "error": format!("{op}: denied by peer") }))
    } else {
        (StatusCode::BAD_GATEWAY, json!({ "error": format!("{op}: {e}") }))
    }
}

/// The 501 body every remote fleet op returns when the fabric child is absent.
fn peering_not_installed() -> (StatusCode, Json<serde_json::Value>) {
    (StatusCode::NOT_IMPLEMENTED, Json(json!({ "error": "peering not installed" })))
}

/// POST /api/fleet/execute — resolve target, then dispatch Local (loopback local-run)
/// or Remote (fabric `POST /fleet/exec`). Ambiguous OS → 409, unmatched OS → 404,
/// remote-with-no-fabric → 501. Response: `{ machineId, terminalId, deviceName, done,
/// exitCode, screen }`.
async fn fleet_execute(
    State(state): State<AppState>,
    Json(body): Json<FleetExecuteReq>,
) -> impl IntoResponse {
    if body.command.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "command must be a non-empty string" })))
            .into_response();
    }
    let roster = fleet_roster(&state).await;
    let roster_json: Vec<serde_json::Value> = roster
        .iter()
        .map(|m| machine_to_json(m, m.machine_id == state.instance_id))
        .collect();
    let res = resolve_fleet_target(
        body.target_os.as_deref(),
        body.machine_id.as_deref(),
        body.terminal_id.as_deref(),
        &roster,
        &state.instance_id,
    );
    let timeout_ms = clamp_fleet_timeout(body.timeout_ms);

    match classify_fleet_route(res, crate::fabric_manager::fabric_installed(&state)) {
        ExecuteRoute::Local => {
            match local_fleet_run(&state, &body.command, body.terminal_id.as_deref(), timeout_ms).await {
                Ok(v) => (StatusCode::OK, Json(json!({
                    "machineId": state.instance_id,
                    "deviceName": self_hostname(),
                    "terminalId": v.get("terminalId").cloned().unwrap_or(serde_json::Value::Null),
                    "done": v.get("done").and_then(|d| d.as_bool()).unwrap_or(false),
                    "exitCode": v.get("exitCode").cloned().unwrap_or(serde_json::Value::Null),
                    "screen": v.get("screen").cloned().unwrap_or(serde_json::Value::Null),
                }))).into_response(),
                Err((code, msg)) => (code, Json(json!({ "error": msg }))).into_response(),
            }
        }
        ExecuteRoute::Proxy { device_id, terminal_id } => {
            let device_name = roster
                .iter()
                .find(|m| m.machine_id == device_id)
                .map(|m| m.device_name.clone())
                .unwrap_or_else(|| device_id.clone());
            // The fabric long-polls the peer for up to `timeout_ms + 5s`. The DEFAULT
            // FabricClient is hard-capped at 5s (localhost_client(5000)), which would abort
            // every remote command >~5s with a spurious 502 — defeating the long-poll design.
            // Use a loopback client sized to the command budget (+10s margin), mirroring
            // `local_fleet_run`. The fabric control API is unauthenticated loopback, so no
            // bearer token is sent.
            let url = format!("http://127.0.0.1:{}/fleet/exec", state.fabric_control_port);
            let client = crate::network_commands::localhost_client(timeout_ms.saturating_add(10_000))
                .unwrap_or_else(reqwest::Client::new);
            let mut fbody = json!({
                "device_id": device_id,
                "command": body.command,
                "timeoutMs": timeout_ms,
            });
            if let Some(tid) = &terminal_id {
                fbody["terminalId"] = json!(tid);
            }
            match client.post(&url).json(&fbody).send().await {
                Ok(resp) if resp.status().is_success() => {
                    let v: serde_json::Value = resp.json().await.unwrap_or_else(|_| json!({}));
                    (StatusCode::OK, Json(json!({
                        "machineId": device_id,
                        "deviceName": device_name,
                        "terminalId": v.get("terminalId").cloned().unwrap_or(serde_json::Value::Null),
                        "done": v.get("done").and_then(|d| d.as_bool()).unwrap_or(false),
                        "exitCode": v.get("exitCode").cloned().unwrap_or(serde_json::Value::Null),
                        "screen": v.get("screen").cloned().unwrap_or(serde_json::Value::Null),
                    }))).into_response()
                }
                // Preserve the fabric's 403 with the spec-mandated, target-specific reason so
                // the agent knows whether to ask the user to flip the peer's fleet toggle or to
                // grant terminal Control; fold any other non-2xx / transport error to 502.
                Ok(resp) if resp.status() == StatusCode::FORBIDDEN => {
                    let msg = match &terminal_id {
                        Some(tid) => format!("no Control grant on terminal {tid}"),
                        None => "peer hasn't allowed fleet commands".to_string(),
                    };
                    (StatusCode::FORBIDDEN, Json(json!({ "error": msg }))).into_response()
                }
                Ok(resp) => {
                    let code = resp.status();
                    (StatusCode::BAD_GATEWAY,
                        Json(json!({ "error": format!("fleet_execute: peer returned {code}") }))).into_response()
                }
                Err(e) => {
                    // This leg drives its own reqwest client (the 5s FabricClient cap would
                    // abort a long FleetExec poll), so reaching here means no HTTP response
                    // ever arrived — the non-2xx cases are the `Ok(resp)` arms above.
                    let (code, msg) = map_fabric_fleet_error(
                        "fleet_execute",
                        crate::fabric_manager::FabricError::Transport(e),
                    );
                    (code, Json(msg)).into_response()
                }
            }
        }
        ExecuteRoute::NotInstalled => {
            let (code, body) = peering_not_installed();
            (code, body).into_response()
        }
        ExecuteRoute::Ambiguous(candidates) => (StatusCode::CONFLICT, Json(json!({
            "error": "ambiguous target: more than one online machine matches targetOS",
            "candidates": candidates,
            "machines": roster_json,
        }))).into_response(),
        ExecuteRoute::NoMatch => (StatusCode::NOT_FOUND, Json(json!({
            "error": "no online machine matches targetOS",
            "machines": roster_json,
        }))).into_response(),
    }
}

/// POST /api/fleet/screen — live screen of a terminal, Local (authoritative snapshot)
/// or Remote (fabric `POST /fleet/screen`). Response: `{ machineId, terminalId, title,
/// running, screen }`.
async fn fleet_screen(
    State(state): State<AppState>,
    Json(body): Json<FleetScreenReq>,
) -> impl IntoResponse {
    // machineId is explicit here (no OS matching), so the roster is unused → &[].
    let res = resolve_fleet_target(
        None,
        body.machine_id.as_deref(),
        Some(&body.terminal_id),
        &[],
        &state.instance_id,
    );
    match classify_fleet_route(res, crate::fabric_manager::fabric_installed(&state)) {
        ExecuteRoute::Local => {
            let Some(terminal) = state.terminals.get(&state.resolve_ref(&body.terminal_id)) else {
                return (StatusCode::NOT_FOUND, Json(json!({ "error": "Terminal not found" }))).into_response();
            };
            let title = terminal.name.clone();
            drop(terminal);
            // Plain text, not the replayable blob: this screen is read by a human or
            // an agent, and a full-screen TUI's formatted snapshot is mostly truecolor
            // SGR and cursor-op noise with the words buried in it.
            let screen = state.screen_text(&state.resolve_ref(&body.terminal_id)).unwrap_or_default();
            (StatusCode::OK, Json(json!({
                "machineId": state.instance_id,
                "terminalId": body.terminal_id,
                "title": title,
                "running": true,
                "screen": screen,
            }))).into_response()
        }
        ExecuteRoute::Proxy { device_id, terminal_id } => {
            let client = crate::fabric_manager::FabricClient::new(state.fabric_control_port);
            let fbody = json!({ "device_id": device_id, "terminalId": terminal_id });
            match client.post("/fleet/screen", fbody).await {
                Ok(v) => {
                    let mut obj = v.as_object().cloned().unwrap_or_default();
                    obj.insert("machineId".to_string(), json!(device_id));
                    (StatusCode::OK, Json(serde_json::Value::Object(obj))).into_response()
                }
                Err(e) => {
                    let (code, msg) = map_fabric_fleet_error("fleet_screen", e);
                    (code, Json(msg)).into_response()
                }
            }
        }
        ExecuteRoute::NotInstalled => {
            let (code, body) = peering_not_installed();
            (code, body).into_response()
        }
        // machineId is explicit, so OS-based Ambiguous/NoMatch are unreachable here.
        _ => (StatusCode::BAD_REQUEST, Json(json!({ "error": "unresolved screen target" }))).into_response(),
    }
}

/// POST /api/fleet/close — close a terminal, Local (kill + cleanup) or Remote (fabric
/// `POST /fleet/close`). Response: `{ machineId, terminalId, status }`.
async fn fleet_close(
    State(state): State<AppState>,
    Json(body): Json<FleetCloseReq>,
) -> impl IntoResponse {
    let res = resolve_fleet_target(
        None,
        body.machine_id.as_deref(),
        Some(&body.terminal_id),
        &[],
        &state.instance_id,
    );
    match classify_fleet_route(res, crate::fabric_manager::fabric_installed(&state)) {
        ExecuteRoute::Local => {
            let Some(pid) = state.terminals.get(&state.resolve_ref(&body.terminal_id)).map(|t| t.pid) else {
                return (StatusCode::NOT_FOUND, Json(json!({ "error": "Terminal not found" }))).into_response();
            };
            // Host-owned → close via the sidecar; else kill the local tree.
            if !state.host_close(&state.resolve_ref(&body.terminal_id)) {
                crate::pty_manager::kill_process_tree(pid);
            }
            state.cleanup_terminal_state(&state.resolve_ref(&body.terminal_id));
            (StatusCode::OK, Json(json!({
                "machineId": state.instance_id,
                "terminalId": body.terminal_id,
                "status": "ok",
            }))).into_response()
        }
        ExecuteRoute::Proxy { device_id, terminal_id } => {
            let client = crate::fabric_manager::FabricClient::new(state.fabric_control_port);
            let fbody = json!({ "device_id": device_id, "terminalId": terminal_id });
            match client.post("/fleet/close", fbody).await {
                Ok(_) => (StatusCode::OK, Json(json!({
                    "machineId": device_id,
                    "terminalId": terminal_id,
                    "status": "ok",
                }))).into_response(),
                Err(e) => {
                    let (code, msg) = map_fabric_fleet_error("fleet_close", e);
                    (code, Json(msg)).into_response()
                }
            }
        }
        ExecuteRoute::NotInstalled => {
            let (code, body) = peering_not_installed();
            (code, body).into_response()
        }
        _ => (StatusCode::BAD_REQUEST, Json(json!({ "error": "unresolved close target" }))).into_response(),
    }
}

/// Send a prompt (with its CLI-specific submit sequence) to a single terminal.
/// Shared by the single-id `/execute` handler and the batch `/batch/execute`
/// handler. On success returns the JSON body the single-id handler returns;
/// on failure returns `(status, message)`.
async fn send_prompt_to_terminal<R: tauri::Runtime>(
    state: &AppState<R>,
    id: &str,
    payload: &ExecutePromptReq,
) -> Result<serde_json::Value, (StatusCode, String)> {
    use std::io::Write;

    // Clone the writer Arc, dropping the DashMap shard guard before the
    // send/probe sleeps below (up to ~48 s total). Holding the shard guard
    // across those `.await`s blocked a concurrent create/close of any terminal
    // whose id hashes to the same shard for the full sleep duration.
    // Optional local writer: host-owned terminals have no local writer and route
    // their writes to the sidecar instead (see the write sites below).
    let writer_mutex = state.shell_writer_channels.get(id).map(|r| r.clone());
    if writer_mutex.is_none() && !state.is_host_owned(id) {
        return Err((StatusCode::NOT_FOUND, "Terminal not found".to_string()));
    }
    {
        // Determine pattern
        let (separator, end_indicator) = if let Some(signal) = &payload.submission_signal {
            ("", signal.as_str())
        } else if payload.cli_type == "custom" {
            if let Some(custom) = &payload.custom_pattern {
                (
                    custom.separator.as_deref().unwrap_or(""),
                    custom.end_indicator.as_str(),
                )
            } else {
                return Err((StatusCode::BAD_REQUEST, "Custom pattern requires end_indicator".to_string()));
            }
        } else if let Some((sep, end)) = get_cli_pattern(&payload.cli_type) {
            (sep, end)
        } else {
            return Err((StatusCode::BAD_REQUEST, format!("Unknown CLI type: {}", payload.cli_type)));
        };

        // The request is well-formed and will be dispatched to a valid terminal —
        // flash its tab. Placed after the validation above so a rejected (400)
        // request does not flash (see design spec 029 §5).
        emit_external_activity(state, id);

        // An EMPTY prompt is a deliberate "bare submit": skip the paste and write
        // only the submit sequence below. It presses Enter on a composer that
        // already holds text — the recovery when a TUI swallowed the first Enter
        // (see the same-read-chunk race note below). Callers that want a literal
        // blank line still get one, since the submit sequence is written either way.
        if !payload.prompt.is_empty() {
            // Send the prompt as a bracketed paste (CSI 200~ … 201~) so any newlines
            // embedded in the prompt are inserted as literal multi-line input rather
            // than being treated as Enter and submitting each line as a separate
            // command. The single submit is the end_indicator written after this.
            let inner = payload.prompt.replace("\r\n", "\r").replace('\n', "\r");
            let normalized_prompt = format!("\x1b[200~{}\x1b[201~", inner);

            // Write prompt - in scope to drop lock. Host-owned → sidecar.
            if let Some(wm) = &writer_mutex {
                let mut writer = wm
                    .lock()
                    .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "terminal writer mutex poisoned".to_string()))?;
                writer
                    .write_all(normalized_prompt.as_bytes())
                    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
                let _ = writer.flush();
            } else {
                state.host_write(id, normalized_prompt.as_bytes());
            }

            // Brief delay to allow the CLI tool to process the prompt text BEFORE the
            // submit sequence lands. This gap is load-bearing, not cosmetic: TUIs that
            // implement paste-burst handling (Codex, verified against codex-cli 0.146.0)
            // absorb a CR that arrives in the SAME read chunk as the bracketed-paste
            // terminator, leaving the text sitting unsubmitted in the composer. A busy
            // CLI that stops draining its input pipe can still coalesce the two reads
            // despite this delay — that is why an empty prompt (bare submit) exists as
            // the recovery path.
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
        }
        // Send Focus In sequence just in case the CLI tool uses Focus Tracking (\x1b[?1004h)
        // and is ignoring input because it thinks it's blurred.
        if let Some(wm) = &writer_mutex {
            let mut writer = wm
                .lock()
                .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "terminal writer mutex poisoned".to_string()))?;
            let _ = writer.write_all(b"\x1b[I");
            let _ = writer.flush();
        } else {
            state.host_write(id, b"\x1b[I");
        }

        // Handle Probing if requested (any cli_type ending in -probe)
        if payload.cli_type.ends_with("-probe") {
            log::debug!("Starting submission probe for CLI type: {} on terminal {}", payload.cli_type, id);
            let sequences = [
                ("\x1b[I\r", "Focus In + CR (\\x1b[I\\r)"),
                ("\x1b[B\r", "Down Arrow + CR"),
                ("\u{001b}[13;5u", "Ctrl + Enter (\\u001b[13;5u)"),
                ("\x1bOM", "Keypad Enter (\\x1bOM)"),
                ("\r", "Single CR (\\r)"),
                ("\n", "Single LF (\\n)"),
                ("\r\n", "CRLF (\\r\\n)"),
                ("\x04", "Ctrl + D (EOF)"),
                ("\x1b[A\r", "Up Arrow + CR"),
                ("\x1b[24;1R", "Simulated Cursor Position (\\x1b[24;1R)"),
                ("\x1b[?1;2c", "Simulated Device Attributes (\\x1b[?1;2c)"),
                ("\x1b[0n", "Simulated Status OK (\\x1b[0n)"),
                ("\x1b[24;1R\r", "Cursor Pos + Enter"),
                ("\x1b[201~\r", "End Paste + CR (\\x1b[201~\\r)"),
                ("\r\r", "Double CR (\\r\\r)"),
                ("\n\n", "Double LF (\\n\\n)"),
            ];

            for (seq, desc) in sequences {
                log::debug!("  Attempting submission: {} (bytes: {:?})", desc, seq.as_bytes());
                if let Some(wm) = &writer_mutex {
                    let mut writer = match wm.lock() {
                        Ok(w) => w,
                        Err(_) => {
                            log::warn!("send_prompt_to_terminal probe: writer mutex poisoned, aborting probe");
                            break;
                        }
                    };
                    if let Err(e) = writer.write_all(seq.as_bytes()) {
                        log::warn!("    Failed to write sequence: {}", e);
                        break;
                    }
                    let _ = writer.flush();
                } else {
                    state.host_write(id, seq.as_bytes());
                }
                tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
            }

            return Ok(json!({
                "success": true,
                "status": "Probe completed",
                "terminalId": id,
                "cliType": payload.cli_type
            }));
        }

        // Handle specific CLI logic if needed
        if payload.cli_type == "gemini" || payload.cli_type == "claude" || payload.cli_type == "copilot" {
            // Write end indicator immediately. Host-owned → sidecar.
            if let Some(wm) = &writer_mutex {
                let mut writer = wm
                    .lock()
                    .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "terminal writer mutex poisoned".to_string()))?;
                writer
                    .write_all(end_indicator.as_bytes())
                    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
                let _ = writer.flush();
            } else {
                state.host_write(id, end_indicator.as_bytes());
            }

            return Ok(json!({
                "success": true,
                "prompt": payload.prompt,
                "cliType": payload.cli_type
            }));
        }

        // Standard execution for other CLI types. Host-owned → sidecar.
        if let Some(wm) = &writer_mutex {
            let mut writer = wm
                .lock()
                .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "terminal writer mutex poisoned".to_string()))?;
            if !separator.is_empty() {
                let _ = writer.write_all(separator.as_bytes());
            }
            // Write end indicator
            writer
                .write_all(end_indicator.as_bytes())
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            let _ = writer.flush();
        } else {
            if !separator.is_empty() {
                state.host_write(id, separator.as_bytes());
            }
            state.host_write(id, end_indicator.as_bytes());
        }

        Ok(json!({
            "success": true,
            "prompt": payload.prompt,
            "cliType": payload.cli_type
        }))
    }
}

async fn execute_prompt(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(payload): Json<ExecutePromptReq>,
) -> impl IntoResponse {
    // Normalise the caller-supplied reference to this run's map key. The API
    // reports the DURABLE tm- leaf as `terminalId`, but the per-terminal maps
    // are keyed by the per-run pc- id (design 014 A3). Without this, the
    // documented round trip - read `terminalId`, then address it - 404s.
    let id = state.resolve_ref(&id);
    match send_prompt_to_terminal(&state, &id, &payload).await {
        Ok(body) => (StatusCode::OK, Json(body)),
        Err((code, msg)) => (code, Json(json!({ "error": msg }))),
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct FleetLocalRunReq {
    command: String,
    terminal_id: Option<String>,
    #[serde(default)]
    timeout_ms: Option<u64>,
    label: Option<String>,
}

/// Watch the broadcast output stream for THIS run's sentinel on `terminal_id`.
/// Returns `(done, exit_code)`: `(true, Some(code))` when the marker is seen,
/// `(false, None)` on timeout or if the channel closes first. Factored out of
/// the handler so it is unit-testable without an `AppState`/tauri runtime.
async fn watch_for_sentinel(
    mut rx: tokio::sync::broadcast::Receiver<ChannelPayload>,
    terminal_id: &str,
    nonce: &str,
    timeout: std::time::Duration,
) -> (bool, Option<i32>) {
    let watcher = async {
        // Accumulate across chunks: the marker can straddle a PTY read boundary.
        let mut acc = String::new();
        loop {
            match rx.recv().await {
                Ok(payload) => {
                    if payload.id != terminal_id {
                        continue;
                    }
                    acc.push_str(&String::from_utf8_lossy(&payload.data));
                    if let Some(code) = sentinel_exit_code(&acc, nonce) {
                        return Some(code);
                    }
                    // Bound the scan buffer for chatty commands; keep a tail large
                    // enough to hold a marker split across the drain boundary.
                    if acc.len() > 16384 {
                        let mut cut = acc.len() - 4096;
                        while cut < acc.len() && !acc.is_char_boundary(cut) {
                            cut += 1;
                        }
                        acc.drain(..cut);
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
            }
        }
    };
    match tokio::time::timeout(timeout, watcher).await {
        Ok(Some(code)) => (true, Some(code)),
        Ok(None) => (false, None),
        Err(_) => (false, None),
    }
}

/// Responder loopback endpoint: the fabric calls this to run a command locally
/// on behalf of a paired peer. Spawns-or-reuses a PERSISTENT labeled terminal,
/// injects a sentinel-wrapped command, and long-polls the live output until the
/// sentinel exit-code appears or the (clamped) timeout elapses. The terminal is
/// NEVER closed here — follow-up screen/close go through their own endpoints.
async fn fleet_local_run(
    State(state): State<AppState>,
    Json(payload): Json<FleetLocalRunReq>,
) -> impl IntoResponse {
    use tauri::Emitter;

    if payload.command.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "command must be a non-empty string" })),
        )
            .into_response();
    }
    // Clamp caller timeout to a sane band; default 60s (frozen contract).
    let timeout_ms = payload.timeout_ms.unwrap_or(60_000).clamp(1_000, 3_600_000);

    // Resolve the target terminal: reuse when the id is present AND live;
    // otherwise spawn a NEW persistent terminal from the default profile.
    let terminal_id = match payload.terminal_id.as_ref() {
        Some(tid) if state.terminals.contains_key(tid) => tid.clone(),
        // An explicit terminalId that is no longer live must NOT silently spawn a new
        // terminal: a stale per-terminal Control grant (left when a fleet terminal was
        // closed outside FleetClose) would otherwise run fresh commands after fleet_exec
        // was revoked. Fail explicitly.
        Some(_) => {
            return (StatusCode::NOT_FOUND, Json(json!({ "error": "terminal not found" }))).into_response();
        }
        None => {
            // KNOWN LIMITATION (cold-shell readiness): on a freshly-spawned terminal the shell's
            // profile (pwsh/cmd) may still be loading when the command is injected, so the first
            // command's bracketed-paste bytes can be dropped before the shell reads them, yielding a
            // false `done:false` timeout on an otherwise-trivial command. The reused-terminal path is
            // unaffected (already at a prompt). Mitigation deferred to backlog (prompt-readiness poll).
            let profiles = crate::pty_manager::get_available_shells();
            let profile = profiles.iter().find(|p| p.is_default);
            let (shell_path, shell_args, shell_cwd, shell_name) = match profile {
                Some(p) => (
                    Some(p.path.clone()),
                    Some(p.args.clone()),
                    p.cwd.clone(),
                    p.id.clone(),
                ),
                None => (None, None, None, "default".to_string()),
            };
            let terminal_name = payload.label.clone().unwrap_or_else(|| "Fleet".to_string());
            // Mint the renderer identity BEFORE the spawn. Patching
            // `entry.renderer_terminal_id` in afterwards is the exact pattern
            // `pty_manager.rs:704-708` records as a fixed bug (review 062 F-01):
            // a fast-exiting shell's exit-path persist can run in that window and
            // file the final scrollback under the ephemeral pc- id.
            let fleet_tab_id = mint_renderer_id("tb");
            // Routed exactly like every other create (plan 019): a fleet terminal
            // spawned in-process would block Offload & Close for as long as it lived.
            // Its identity is UNCHANGED — it keeps the `tb-*` it minted itself as
            // both owner and leaf, which design 011 §3 blesses precisely because it
            // minted it ("no create may take a root leaf it did not itself mint").
            let new_id = match crate::commands::spawn_routed(
                &state,
                crate::commands::SpawnRequest {
                    leaf_id: fleet_tab_id.clone(),
                    session_key: None,
                    owning_tab_id: Some(fleet_tab_id.clone()),
                    cols: 80,
                    rows: 24,
                    shell_path,
                    shell_name: shell_name.clone(),
                    shell_args,
                    cwd: shell_cwd,
                    name: Some(terminal_name.clone()),
                },
            )
            .await
            {
                Ok(id) => id,
                Err(e) => {
                    return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e })))
                        .into_response()
                }
            };
            // Make the fleet terminal VISIBLE as a labeled UI tab, mirroring
            // create_terminal. On the sidecar path the map key IS this leaf; only a
            // fallback spawn still mints a separate `pc-` key.
            let target_window = state.resolve_active_window_label();
            if let Err(e) = state.app_handle.emit(
                "api:createTerminalTab",
                serde_json::json!({
                    "name": terminal_name,
                    "profile": shell_name,
                    "terminalId": new_id,
                    "tabId": Some(fleet_tab_id.clone()),
                    "processId": new_id,
                    "rendererTerminalId": fleet_tab_id.clone(),
                    "owningTabId": fleet_tab_id.clone(),
                    "paneId": serde_json::Value::Null,
                    "direction": serde_json::Value::Null,
                    "targetWindow": target_window,
                }),
            ) {
                log::warn!("Failed to emit api:createTerminalTab for fleet terminal: {}", e);
            }
            new_id
        }
    };

    // Derive the shell dialect from the resolved terminal's profile so the
    // sentinel wrapping matches (pwsh vs posix vs cmd).
    let shell_profile_id = state.terminals.get(&terminal_id).map(|t| t.shell.clone());
    let kind = match shell_profile_id
        .as_deref()
        .and_then(crate::pty_manager::get_profile)
    {
        Some(p) => classify_shell_kind(&p.path, &p.name),
        None => crate::pty_manager::get_available_shells()
            .iter()
            .find(|p| p.is_default)
            .map(|p| classify_shell_kind(&p.path, &p.name))
            .unwrap_or(if cfg!(target_os = "windows") {
                ShellKind::Cmd
            } else {
                ShellKind::Posix
            }),
    };

    // Unique per-run nonce so a stale marker from a prior run can never match.
    let nonce = uuid::Uuid::new_v4().to_string().replace('-', "");
    let wrapped = build_sentinel_command(kind, payload.command.trim(), &nonce);

    // SUBSCRIBE before injecting so no output chunk (and thus the sentinel) can
    // be missed between the write and the start of the watch.
    let rx = state.output_tx.subscribe();

    // Inject via the existing prompt path (bracketed-paste + shell submit).
    let exec_req = ExecutePromptReq {
        prompt: wrapped,
        cli_type: "default".to_string(),
        submission_signal: None,
        custom_pattern: None,
    };
    if let Err((code, msg)) = send_prompt_to_terminal(&state, &terminal_id, &exec_req).await {
        return (code, Json(json!({ "error": msg }))).into_response();
    }

    let (done, exit_code) = watch_for_sentinel(
        rx,
        &terminal_id,
        &nonce,
        std::time::Duration::from_millis(timeout_ms),
    )
    .await;

    // Authoritative live screen; the terminal PERSISTS (never closed here). On
    // timeout, done=false/exitCode=null and the screen shows the in-progress run.
    // Plain text — same reader-facing rationale as fleet_screen.
    let screen = state.screen_text(&terminal_id).unwrap_or_default();

    (
        StatusCode::OK,
        Json(json!({
            "terminalId": terminal_id,
            "done": done,
            "exitCode": exit_code,
            "screen": screen,
        })),
    )
        .into_response()
}

/// Fan out one prompt to several terminals. Always returns HTTP 200 with a
/// per-terminal `results` array; a single bad id never blocks the others.
async fn batch_execute_prompt(
    State(state): State<AppState>,
    Json(body): Json<BatchExecuteReq>,
) -> impl IntoResponse {
    if body.terminal_ids.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "terminalIds must be a non-empty array" })));
    }
    // An empty prompt is a valid "bare submit" fan-out (press Enter on every
    // target's composer), matching single-id execute_prompt's semantics.
    // Validate the request-global submit pattern ONCE, before fanning out. An
    // unknown cliType or a missing custom pattern is a malformed request (the
    // pattern is identical for every id), not a per-terminal failure — so return
    // 400 for the whole batch, matching single-id execute_prompt's semantics.
    if body.submission_signal.is_none() {
        if body.cli_type == "custom" {
            if body.custom_pattern.is_none() {
                return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Custom pattern requires end_indicator" })));
            }
        } else if get_cli_pattern(&body.cli_type).is_none() {
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": format!("Unknown CLI type: {}", body.cli_type) })));
        }
    }

    let ids: Vec<String> = dedup_preserve_order(&body.terminal_ids)
        .iter().map(|i| state.resolve_ref(i)).collect();
    let req = ExecutePromptReq {
        prompt: body.prompt.clone(),
        cli_type: body.cli_type.clone(),
        submission_signal: body.submission_signal.clone(),
        custom_pattern: body.custom_pattern.clone(),
    };

    let mut results = Vec::with_capacity(ids.len());
    let mut succeeded = 0usize;
    for id in &ids {
        match send_prompt_to_terminal(&state, id, &req).await {
            Ok(_) => {
                succeeded += 1;
                results.push(json!({ "terminalId": id, "success": true }));
            }
            Err((_, msg)) => {
                results.push(json!({ "terminalId": id, "success": false, "error": msg }));
            }
        }
    }

    let total = ids.len();
    (StatusCode::OK, Json(json!({
        "results": results,
        "summary": { "total": total, "succeeded": succeeded, "failed": total - succeeded }
    })))
}

/// Fan out a raw write to several terminals. Always returns HTTP 200 with a
/// per-terminal `results` array.
async fn batch_write_terminal(
    State(state): State<AppState>,
    Json(body): Json<BatchInputReq>,
) -> impl IntoResponse {
    if body.terminal_ids.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "terminalIds must be a non-empty array" })));
    }

    let ids: Vec<String> = dedup_preserve_order(&body.terminal_ids)
        .iter().map(|i| state.resolve_ref(i)).collect();
    let mut results = Vec::with_capacity(ids.len());
    let mut succeeded = 0usize;
    for id in &ids {
        match write_data_to_terminal(&state, id, &body.data) {
            Ok(()) => {
                succeeded += 1;
                results.push(json!({ "terminalId": id, "success": true }));
            }
            Err((_, msg)) => {
                results.push(json!({ "terminalId": id, "success": false, "error": msg }));
            }
        }
    }

    let total = ids.len();
    (StatusCode::OK, Json(json!({
        "results": results,
        "summary": { "total": total, "succeeded": succeeded, "failed": total - succeeded }
    })))
}

/// How long a sibling holds its detach window after being armed for our update.
///
/// Matches the value `update_and_restart` arms ITSELF with. A shorter window
/// would expire while the apply is still running and lose the very shells this
/// exists to save.
const SIBLING_ARM_SECS: u64 = 600;

/// Arm this instance's pty-host so its shells survive a sibling's update.
///
/// Called BY another instance, not by this one's UI. Velopack's apply kills our
/// GUI along with the updating instance; arming is what lets our shells outlive
/// it and reattach on the next launch (design 014 §B1).
///
/// Idempotent: a duplicate arm re-arms the same window, which is harmless and
/// keeps the caller's retry logic simple.
async fn hotswap_arm(State(state): State<AppState>) -> impl IntoResponse {
    let Some(client) = state.pty_host_clone() else {
        // No host means no shells to save; say so rather than claiming success,
        // so the caller can tell "prepared" from "nothing to prepare".
        return (StatusCode::SERVICE_UNAVAILABLE, "pty-host not connected").into_response();
    };
    let token = crate::pty_host_client::resolve_token();
    match client.arm_detach(SIBLING_ARM_SECS, &token).await {
        Ok(_) => {
            log::info!("[HOTSWAP] armed at a sibling's request ({SIBLING_ARM_SECS}s)");
            (StatusCode::OK, "armed").into_response()
        }
        Err(e) => {
            log::warn!("[HOTSWAP] refused a sibling's arm request: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, e).into_response()
        }
    }
}

/// Release a detach window armed by `hotswap_arm`.
///
/// The other half of the obligation: an update that arms siblings and then FAILS
/// must put them back, or every sibling holds a 600s window it never asked for.
/// Idempotent — disarming an unarmed host is a no-op.
async fn hotswap_disarm(State(state): State<AppState>) -> impl IntoResponse {
    let Some(client) = state.pty_host_clone() else {
        return (StatusCode::OK, "nothing to disarm").into_response();
    };
    client.disarm().await;
    (StatusCode::OK, "disarmed").into_response()
}

async fn get_system_info() -> impl IntoResponse {
    Json(json!({
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "version": env!("CARGO_PKG_VERSION"),
        "hostname": std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_else(|_| "unknown".to_string()),
        "uptime": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }))
}

async fn get_system_metrics() -> impl IntoResponse {
    // Basic metrics - could be enhanced with sysinfo crate
    Json(json!({
        "timestamp": chrono::Utc::now().to_rfc3339(),
        "cpu": {
            "usage": 0.0 // Would need sysinfo crate
        },
        "memory": {
            "total": 0,
            "used": 0,
            "free": 0
        }
    }))
}

async fn get_active_processes(State(state): State<AppState>) -> impl IntoResponse {
    use sysinfo::System;
    // System::new_all() enumerates every OS process (50-200ms, blocking) — run
    // it on the blocking pool so it doesn't stall the async executor.
    let sys = match tokio::task::spawn_blocking(System::new_all).await {
        Ok(sys) => sys,
        Err(e) => {
            log::warn!("get_active_processes: sysinfo snapshot task failed: {}", e);
            return Json(json!({ "processes": [], "count": 0 }));
        }
    };

    let processes: Vec<_> = state.terminals.iter().map(|entry| {
        let t = entry.value();
        
        // Get the actual foreground process info using the shared system snapshot
        let (actual_pid, actual_name) = crate::pty_manager::get_foreground_process_info(t.pid, Some(&sys));
        // Friendly coding-agent label (codex/claude/gemini/...) derived from the
        // foreground process's command line, plus that process's executable path
        // (for icon extraction). Both null when no agent is recognized; agentExe
        // alone is null when the OS won't report the path.
        let (agent, agent_exe) = match crate::pty_manager::get_foreground_agent_with_exe(t.pid, &sys) {
            Some((a, exe)) => (Some(a), exe),
            None => (None, None),
        };

        json!({
            "id": t.id,
            "pid": t.pid,
            "shell": t.shell,
            "name": t.name,
            "currentApp": {
                "pid": actual_pid,
                "name": actual_name
            },
            "agent": agent,
            "agentExe": agent_exe,
            "lastInputSource": t.last_input_source,
            "lastInputAt": t.last_input_at,
            "createdAt": t.created_at,
            "isAlive": true
        })
    }).collect();
    
    Json(json!({ "processes": processes, "count": processes.len() }))
}

async fn get_process_metrics(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    // Normalise the caller-supplied reference to this run's map key. The API
    // reports the DURABLE tm- leaf as `terminalId`, but the per-terminal maps
    // are keyed by the per-run pc- id (design 014 A3). Without this, the
    // documented round trip - read `terminalId`, then address it - 404s.
    let id = state.resolve_ref(&id);
    // Copy the pid out so the DashMap guard drops before any await.
    let Some(pid) = state.terminals.get(&id).map(|t| t.pid) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Process not found" })));
    };

    // sysinfo enumeration is blocking — keep it off the async executor.
    let (cpu, memory) = match tokio::task::spawn_blocking(move || {
        use sysinfo::{Pid, System};
        let sys = System::new_all();
        sys.process(Pid::from(pid as usize))
            .map(|p| (p.cpu_usage(), p.memory()))
            .unwrap_or((0.0, 0))
    })
    .await
    {
        Ok(v) => v,
        Err(e) => {
            log::warn!("get_process_metrics: sysinfo task failed: {}", e);
            (0.0, 0)
        }
    };

    (StatusCode::OK, Json(json!({
        "id": id,
        "cpu": cpu,
        "memory": memory,
        "timestamp": chrono::Utc::now().to_rfc3339()
    })))
}

// Test capture start/stop endpoints

#[derive(Deserialize)]
struct StartTestPayload {
    #[serde(rename = "testId")]
    test_id: String,
}

async fn start_test_capture(
    State(state): State<AppState>,
    Json(payload): Json<StartTestPayload>,
) -> impl IntoResponse {
    // Create test-captures directory
    let dir = &state.test_capture_dir;
    if let Err(e) = fs::create_dir_all(dir) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("Failed to create directory: {}", e) }))
        );
    }

    // Set test ID and enable capture
    *state.test_capture_id.write() = Some(payload.test_id.clone());
    state.test_capture_enabled.store(true, std::sync::atomic::Ordering::SeqCst);

    (
        StatusCode::OK,
        Json(json!({
            "success": true,
            "testId": payload.test_id,
            "message": "Test capture started"
        }))
    )
}

async fn stop_test_capture(
    State(state): State<AppState>,
) -> impl IntoResponse {
    state.test_capture_enabled.store(false, std::sync::atomic::Ordering::SeqCst);
    let test_id = state.test_capture_id.write().take();

    Json(json!({
        "success": true,
        "testId": test_id,
        "message": "Test capture stopped"
    }))
}

// Test capture payload structs

#[derive(Deserialize)]
struct CapturePayload {
    #[serde(rename = "terminalId")]
    terminal_id: String,
    #[serde(rename = "testId")]
    test_id: String,
    data: String,
}

#[derive(Deserialize)]
struct CaptureFrontendPayload {
    #[serde(rename = "terminalId")]
    terminal_id: String,
    #[serde(rename = "testId")]
    test_id: String,
    data: String,
    metadata: Option<serde_json::Value>,
}

#[derive(Serialize)]
struct CompareResult {
    #[serde(rename = "match")]
    is_match: bool,
    #[serde(rename = "backendSize")]
    backend_size: usize,
    #[serde(rename = "frontendSize")]
    frontend_size: usize,
    #[serde(rename = "backendExists")]
    backend_exists: bool,
    #[serde(rename = "frontendExists")]
    frontend_exists: bool,
    diff_summary: Option<String>,
}

#[derive(Serialize)]
struct CaptureFile {
    filename: String,
    #[serde(rename = "testId")]
    test_id: String,
    #[serde(rename = "terminalId")]
    terminal_id: String,
    source: String, // "backend" or "frontend"
    size: u64,
}

// Test capture endpoint handlers

async fn capture_backend(
    State(state): State<AppState>,
    Json(payload): Json<CapturePayload>,
) -> impl IntoResponse {
    let dir = &state.test_capture_dir;

    if let Err(e) = fs::create_dir_all(dir) {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({
            "error": format!("Failed to create directory: {}", e)
        })));
    }

    let filename = format!("backend-{}-{}.txt", payload.test_id, payload.terminal_id);
    let filepath = dir.join(&filename);

    match fs::write(&filepath, &payload.data) {
        Ok(_) => (StatusCode::OK, Json(json!({
            "status": "ok",
            "filename": filename,
            "size": payload.data.len()
        }))),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({
            "error": format!("Failed to write file: {}", e)
        }))),
    }
}

async fn capture_frontend(
    State(state): State<AppState>,
    Json(payload): Json<CaptureFrontendPayload>,
) -> impl IntoResponse {
    let dir = &state.test_capture_dir;

    if let Err(e) = fs::create_dir_all(dir) {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({
            "error": format!("Failed to create directory: {}", e)
        })));
    }

    let filename = format!("frontend-{}-{}.txt", payload.test_id, payload.terminal_id);
    let filepath = dir.join(&filename);

    match fs::write(&filepath, &payload.data) {
        Ok(_) => {
            // Also write metadata if present
            if let Some(metadata) = &payload.metadata {
                let meta_filename = format!("frontend-{}-{}.meta.json", payload.test_id, payload.terminal_id);
                let meta_filepath = dir.join(&meta_filename);
                let _ = fs::write(&meta_filepath, serde_json::to_string_pretty(metadata).unwrap_or_default());
            }

            (StatusCode::OK, Json(json!({
                "status": "ok",
                "filename": filename,
                "size": payload.data.len()
            })))
        },
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({
            "error": format!("Failed to write file: {}", e)
        }))),
    }
}

async fn compare_captures(
    State(state): State<AppState>,
    Path((test_id, terminal_id)): Path<(String, String)>,
) -> impl IntoResponse {
    let dir = &state.test_capture_dir;

    let backend_filename = format!("backend-{}-{}.txt", test_id, terminal_id);
    let frontend_filename = format!("frontend-{}-{}.txt", test_id, terminal_id);

    let backend_path = dir.join(&backend_filename);
    let frontend_path = dir.join(&frontend_filename);

    let backend_exists = backend_path.exists();
    let frontend_exists = frontend_path.exists();

    let backend_content = if backend_exists {
        fs::read_to_string(&backend_path).unwrap_or_default()
    } else {
        String::new()
    };

    let frontend_content = if frontend_exists {
        fs::read_to_string(&frontend_path).unwrap_or_default()
    } else {
        String::new()
    };

    let backend_size = backend_content.len();
    let frontend_size = frontend_content.len();
    let is_match = backend_exists && frontend_exists && backend_content == frontend_content;

    // Generate diff summary if both exist and don't match
    let diff_summary = if backend_exists && frontend_exists && !is_match {
        let backend_lines: Vec<&str> = backend_content.lines().collect();
        let frontend_lines: Vec<&str> = frontend_content.lines().collect();

        let mut diffs = Vec::new();
        let max_lines = backend_lines.len().max(frontend_lines.len());
        let mut diff_count = 0;

        for i in 0..max_lines {
            let b_line = backend_lines.get(i);
            let f_line = frontend_lines.get(i);

            if b_line != f_line {
                diff_count += 1;
                if diffs.len() < 10 { // Limit to first 10 diffs
                    diffs.push(format!(
                        "Line {}: backend={:?}, frontend={:?}",
                        i + 1,
                        b_line.unwrap_or(&"<missing>"),
                        f_line.unwrap_or(&"<missing>")
                    ));
                }
            }
        }

        if diff_count > 10 {
            diffs.push(format!("... and {} more differences", diff_count - 10));
        }

        Some(format!(
            "Total lines: backend={}, frontend={}. Differences: {}",
            backend_lines.len(),
            frontend_lines.len(),
            diffs.join("\n")
        ))
    } else {
        None
    };

    let result = CompareResult {
        is_match,
        backend_size,
        frontend_size,
        backend_exists,
        frontend_exists,
        diff_summary,
    };

    (StatusCode::OK, Json(result))
}

async fn list_captures(
    State(state): State<AppState>,
) -> impl IntoResponse {
    let dir = &state.test_capture_dir;

    if !dir.exists() {
        return (StatusCode::OK, Json(json!({ "captures": [], "count": 0 })));
    }

    let mut captures: Vec<CaptureFile> = Vec::new();

    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Some(filename) = path.file_name().and_then(|n| n.to_str()) {
                // Skip metadata files
                if filename.ends_with(".meta.json") {
                    continue;
                }

                // Parse filename: backend-{testId}-{terminalId}.txt or frontend-{testId}-{terminalId}.txt
                if filename.ends_with(".txt") {
                    let parts: Vec<&str> = filename.trim_end_matches(".txt").splitn(3, '-').collect();
                    if parts.len() == 3 {
                        let source = parts[0].to_string();
                        let test_id = parts[1].to_string();
                        let terminal_id = parts[2].to_string();
                        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);

                        captures.push(CaptureFile {
                            filename: filename.to_string(),
                            test_id,
                            terminal_id,
                            source,
                            size,
                        });
                    }
                }
            }
        }
    }

    let count = captures.len();
    (StatusCode::OK, Json(json!({ "captures": captures, "count": count })))
}

// ============================================================================
// tmux Reflow-Aware Endpoints
// ============================================================================

#[derive(Deserialize)]
struct ResizeReflowReq {
    cols: u16,
    rows: u16,
    capture_content: Option<bool>,
}

#[derive(Serialize)]
struct ResizeReflowResponse {
    status: String,
    cols: u16,
    rows: u16,
    content: Option<CapturedContent>,
    reflow_applied: bool,
}

/// Resize terminal with content reflow support.
///
/// For tmux backends, this resizes the session and captures the reflowed content.
/// For portable-pty backends, this falls back to standard resize (no reflow).
async fn resize_with_reflow(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(payload): Json<ResizeReflowReq>,
) -> impl IntoResponse {
    // Normalise the caller-supplied reference to this run's map key. The API
    // reports the DURABLE tm- leaf as `terminalId`, but the per-terminal maps
    // are keyed by the per-run pc- id (design 014 A3). Without this, the
    // documented round trip - read `terminalId`, then address it - 404s.
    let id = state.resolve_ref(&id);
    log::info!("Resize-reflow request for terminal {}: {}x{}", id, payload.cols, payload.rows);

    // Check if terminal exists and get its backend type
    let backend = match state.get_terminal_backend(&id) {
        Some(b) => b,
        None => {
            log::warn!("Terminal {} not found for resize-reflow", id);
            return (StatusCode::NOT_FOUND, Json(json!({ "error": "Terminal not found" }))).into_response();
        }
    };

    match backend {
        TerminalBackend::TmuxNative | TerminalBackend::TmuxWsl => {
            // tmux backend: resize session and capture reflowed content
            if let Some(session_mutex) = state.tmux_sessions.get(&id) {
                let session = match session_mutex.lock() {
                    Ok(s) => s,
                    Err(_) => {
                        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "tmux session mutex poisoned" }))).into_response();
                    }
                };
                let config = state.tmux_config.read();

                match tmux_manager::resize_session(&session, &config, payload.cols, payload.rows) {
                    Ok(captured) => {
                        if let Some(mut terminal) = state.terminals.get_mut(&id) {
                            terminal.cols = payload.cols;
                            terminal.rows = payload.rows;
                        }
                        log::info!("Terminal {} resized with reflow to {}x{}", id, payload.cols, payload.rows);
                        let response = ResizeReflowResponse {
                            status: "ok".to_string(),
                            cols: payload.cols,
                            rows: payload.rows,
                            content: if payload.capture_content.unwrap_or(true) { Some(captured) } else { None },
                            reflow_applied: true,
                        };
                        (StatusCode::OK, Json(serde_json::to_value(response).unwrap())).into_response()
                    }
                    Err(e) => {
                        log::error!("Failed to resize tmux session {}: {}", id, e);
                        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))).into_response()
                    }
                }
            } else {
                log::warn!("tmux session {} not found", id);
                (StatusCode::NOT_FOUND, Json(json!({ "error": "tmux session not found" }))).into_response()
            }
        }
        TerminalBackend::PortablePty => {
            // Host-owned terminals resize via the sidecar (no local master).
            if state.host_resize(&id, payload.cols, payload.rows) {
                if let Some(mut terminal) = state.terminals.get_mut(&id) {
                    terminal.cols = payload.cols;
                    terminal.rows = payload.rows;
                }
                state.resize_screen(&id, payload.rows, payload.cols);
                return Json(json!({ "status": "ok", "cols": payload.cols, "rows": payload.rows })).into_response();
            }
            // Portable-pty backend: standard resize without reflow
            if let Some(master_mutex) = state.ptys.get(&id) {
                let master = match master_mutex.lock() {
                    Ok(m) => m,
                    Err(_) => {
                        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "terminal pty mutex poisoned" }))).into_response();
                    }
                };
                let new_size = portable_pty::PtySize {
                    rows: payload.rows,
                    cols: payload.cols,
                    pixel_width: 0,
                    pixel_height: 0,
                };

                match master.resize(new_size) {
                    Ok(_) => {
                        if let Some(mut terminal) = state.terminals.get_mut(&id) {
                            terminal.cols = payload.cols;
                            terminal.rows = payload.rows;
                        }
                        // Keep the authoritative screen parser in sync so later
                        // snapshots reflect this size (the other resize paths do too).
                        state.resize_screen(&id, payload.rows, payload.cols);
                        log::info!("Terminal {} resized (no reflow) to {}x{}", id, payload.cols, payload.rows);
                        let response = ResizeReflowResponse {
                            status: "ok".to_string(),
                            cols: payload.cols,
                            rows: payload.rows,
                            content: None,
                            reflow_applied: false,
                        };
                        (StatusCode::OK, Json(serde_json::to_value(response).unwrap())).into_response()
                    }
                    Err(e) => {
                        log::error!("Failed to resize terminal {}: {}", id, e);
                        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))).into_response()
                    }
                }
            } else {
                log::warn!("PTY {} not found for resize", id);
                (StatusCode::NOT_FOUND, Json(json!({ "error": "Terminal not found" }))).into_response()
            }
        }
    }
}

#[derive(Deserialize)]
struct CapturePaneQuery {
    include_scrollback: Option<bool>,
}

/// Capture terminal content.
///
/// For tmux backends, this captures the pane content with optional scrollback.
/// For portable-pty backends, this returns the history buffer.
async fn capture_terminal_content(
    State(state): State<AppState>,
    Path(id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<CapturePaneQuery>,
) -> impl IntoResponse {
    // Normalise the caller-supplied reference to this run's map key. The API
    // reports the DURABLE tm- leaf as `terminalId`, but the per-terminal maps
    // are keyed by the per-run pc- id (design 014 A3). Without this, the
    // documented round trip - read `terminalId`, then address it - 404s.
    let id = state.resolve_ref(&id);
    log::info!("Capture content request for terminal {}", id);

    let backend = match state.get_terminal_backend(&id) {
        Some(b) => b,
        None => {
            return (StatusCode::NOT_FOUND, Json(json!({ "error": "Terminal not found" }))).into_response();
        }
    };

    match backend {
        TerminalBackend::TmuxNative | TerminalBackend::TmuxWsl => {
            // tmux backend: use capture-pane
            if let Some(session_mutex) = state.tmux_sessions.get(&id) {
                let session = match session_mutex.lock() {
                    Ok(s) => s,
                    Err(_) => {
                        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "tmux session mutex poisoned" }))).into_response();
                    }
                };
                let config = state.tmux_config.read();
                let include_scrollback = query.include_scrollback.unwrap_or(false);

                match tmux_manager::capture_content(&session, &config, include_scrollback) {
                    Ok(captured) => {
                        (StatusCode::OK, Json(serde_json::to_value(captured).unwrap())).into_response()
                    }
                    Err(e) => {
                        log::error!("Failed to capture tmux content for {}: {}", id, e);
                        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))).into_response()
                    }
                }
            } else {
                (StatusCode::NOT_FOUND, Json(json!({ "error": "tmux session not found" }))).into_response()
            }
        }
        TerminalBackend::PortablePty => {
            // Portable-pty backend: return history buffer.
            // Clone the chunks under a brief inner lock, then render with NO
            // locks held (see get_terminal_output — rendering under the history
            // lock starved the PTY output consumer).
            let chunks = state
                .get_history(&id)
                .map(|h| h.lock().unwrap_or_else(|p| p.into_inner()).clone());
            if let Some(history) = chunks {
                {
                    let (rows, cols) = terminal_size_for_output(&state, &id);
                    let content = render_terminal_history(&history, rows, cols);
                    let line_count = content.lines().count();

                    let captured = CapturedContent {
                        content,
                        line_count,
                        includes_scrollback: query.include_scrollback.unwrap_or(false),
                        cursor_position: None, // Not available for portable-pty
                    };
                    (StatusCode::OK, Json(serde_json::to_value(captured).unwrap())).into_response()
                }
            } else {
                // Return empty content if no history
                let captured = CapturedContent {
                    content: String::new(),
                    line_count: 0,
                    includes_scrollback: false,
                    cursor_position: None,
                };
                (StatusCode::OK, Json(serde_json::to_value(captured).unwrap())).into_response()
            }
        }
    }
}

#[derive(Serialize)]
struct TmuxStatusResponse {
    available: bool,
    tmux_path: String,
    wsl_distro: Option<String>,
    active_sessions: usize,
}

/// Get tmux availability status.
async fn get_tmux_status(
    State(state): State<AppState>,
) -> impl IntoResponse {
    let config = state.tmux_config.read();
    let active_sessions = state.tmux_sessions.len();

    let response = TmuxStatusResponse {
        available: config.available,
        tmux_path: config.tmux_path.clone(),
        wsl_distro: config.wsl_distro.clone(),
        active_sessions,
    };

    Json(serde_json::to_value(response).unwrap())
}

async fn ws_handler(

    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_socket(socket, state))
}

/// Per-connection WebSocket subscription filter for `output.data` forwarding.
///
/// A freshly-connected client defaults to `All` — it receives every terminal's
/// output, preserving the historical behaviour for existing API clients that
/// never send a `subscribe` message. Once the client sends
/// `{ "type":"subscribe", "terminalIds":[...] }`, the filter narrows to
/// `Only(set)` and forwards output for exactly those terminals (the fabric
/// sidecar always subscribes explicitly, so it gets scoped delivery).
#[derive(Debug, Clone)]
enum SubscriptionFilter {
    All,
    Only(HashSet<String>),
}

impl SubscriptionFilter {
    /// Default filter: forward output for every terminal.
    fn all() -> Self {
        SubscriptionFilter::All
    }

    /// Whether `output.data` for `terminal_id` should be forwarded to this client.
    fn wants(&self, terminal_id: &str) -> bool {
        match self {
            SubscriptionFilter::All => true,
            SubscriptionFilter::Only(ids) => ids.contains(terminal_id),
        }
    }

    /// Narrow the filter to exactly `ids` (invoked on a `subscribe` message).
    fn set(&mut self, ids: Vec<String>) {
        *self = SubscriptionFilter::Only(ids.into_iter().collect());
    }
}

/// Parse the OPTIONAL top-level `terminalIds` array from a `subscribe` message.
///
/// Returns `Some(ids)` ONLY when the field is explicitly present (even if empty), and
/// `None` when it is absent. The distinction matters: an absent field is the legacy
/// pattern-only subscribe (e.g. the shipping terminal-monitor client, which sends only
/// `payload.patterns`), and must leave the filter at `All` — narrowing it to `Only([])`
/// on an absent field would silently drop ALL of that client's live output.
fn parse_subscribe_ids(value: &serde_json::Value) -> Option<Vec<String>> {
    value.get("terminalIds").and_then(|v| v.as_array()).map(|arr| {
        arr.iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect()
    })
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    log::info!("New WebSocket connection established");
    
    // Send welcome message immediately
    let welcome = json!({
        "id": "welcome",
        "success": true,
        "data": { "version": "0.1.0", "mode": "tauri" }
    });
    if let Err(e) = sender.send(Message::Text(welcome.to_string())).await {
        log::warn!("Failed to send welcome message: {}", e);
        return;
    }

    let mut rx = state.output_tx.subscribe();
    let (tx_internal, mut rx_internal) = tokio::sync::mpsc::channel(100);

    // Per-connection output subscription filter, shared between this receiver
    // loop (which narrows it on a `subscribe` message) and the sender task
    // (which gates each `output.data` forward). Defaults to All.
    let filter = Arc::new(Mutex::new(SubscriptionFilter::all()));
    let sender_filter = Arc::clone(&filter);

    // Task to handle sending messages to the client
    let sender_task = tokio::spawn(async move {
        log::info!("[WS] Starting sender task, subscribed to broadcast channel");
        loop {
            tokio::select! {
                // Outgoing PTY data
                result = rx.recv() => {
                    match result {
                        Ok(msg) => {
                            // Per-connection subscription gating: skip terminals this
                            // client hasn't subscribed to. A client that never sent a
                            // `subscribe` stays `All` and receives everything. The lock
                            // guard is dropped before any `.await` below.
                            let wants = sender_filter
                                .lock()
                                .map(|f| f.wants(&msg.id))
                                .unwrap_or(true);
                            if !wants {
                                continue;
                            }

                            let data_str = String::from_utf8_lossy(&msg.data);

                            // Forward EVERY chunk to the WS client — including the
                            // hide-cursor + cursor-home redraws that full-screen TUIs
                            // (Claude Code, copilot, vim) emit on each keystroke.
                            // Previously these were dropped here as "resize refresh",
                            // which starved the web monitor of live updates and left it
                            // ~1s behind (it could only catch up via snapshot polling).
                            // The desktop app already emits all of it unconditionally
                            // ("Always emit data … so xterm.js can render TUI apps
                            // properly", lib.rs), and mirror mode sizes the monitor's
                            // xterm to the backend, so these chunks render correctly
                            // instead of garbling. The resize-refresh heuristic remains
                            // where it belongs — gating HISTORY storage in lib.rs.
                            let json = json!({
                                "type": "event",
                                "event": {
                                    "type": "output.data",
                                    "terminalId": msg.id,
                                    "data": {
                                        "content": data_str
                                    }
                                },
                                "timestamp": chrono::Utc::now().to_rfc3339()
                            });
                            if let Err(e) = sender.send(Message::Text(json.to_string())).await {
                                log::warn!("[WS] Failed to send message: {}", e);
                                break;
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            // Slow consumer falling behind — can fire thousands of times/sec under
                            // heavy PTY output; keep it off the warn level.
                            log::debug!("[WS] Broadcast lagged, dropped {} message(s)", n);
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            log::warn!("[WS] Broadcast channel closed");
                            break;
                        }
                    }
                }
                // Outgoing responses from internal handler (heartbeats, subscriptions)
                Some(resp) = rx_internal.recv() => {
                    if let Err(_) = sender.send(Message::Text(resp)).await {
                        break;
                    }
                }
                else => break,
            }
        }
        log::info!("[WS] Sender task ending");
    });

    // Loop for receiving messages from client
    while let Some(Ok(msg)) = receiver.next().await {
        if let Message::Text(text) = msg {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                let msg_id = value["id"].as_str().unwrap_or("");
                let msg_type = value["type"].as_str().unwrap_or("");
                
                match msg_type {
                    "heartbeat" => {
                        let resp = json!({
                            "id": msg_id,
                            "success": true,
                        });
                        let _ = tx_internal.send(resp.to_string()).await;
                    }
                    "subscribe" => {
                        // Narrow this connection's output filter to the requested terminals
                        // — but ONLY when `terminalIds` is explicitly present
                        // (`{ "type":"subscribe", "terminalIds":[...] }`). When the field is
                        // absent (legacy pattern-only subscribe, e.g. the terminal-monitor
                        // client sending just `payload.patterns`), leave the filter at `All`
                        // so the connection keeps receiving every terminal's output.
                        let ids = parse_subscribe_ids(&value);
                        if let Some(ref list) = ids {
                            if let Ok(mut f) = filter.lock() {
                                f.set(list.clone());
                            }
                        }
                        let resp = json!({
                            "id": msg_id,
                            "success": true,
                            "data": { "terminalIds": ids }
                        });
                        let _ = tx_internal.send(resp.to_string()).await;
                    }
                    "command" => {
                        let action = value["payload"]["action"].as_str().unwrap_or("");
                        match action {
                            "terminal:input" => {
                                let terminal_id = value["payload"]["terminalId"].as_str().unwrap_or("");
                                let data = value["payload"]["data"].as_str().unwrap_or("");

                                use std::io::Write;
                                // Host-owned terminals route to the sidecar; else
                                // write to the local writer (parity with the REST/
                                // Tauri input paths).
                                let write_result: Result<(), String> = if state
                                    .host_write(terminal_id, data.as_bytes())
                                {
                                    Ok(())
                                } else {
                                    // Clone the Arc, dropping the shard guard before locking.
                                    let writer_arc = state
                                        .shell_writer_channels
                                        .get(terminal_id)
                                        .map(|r| r.clone());
                                    match writer_arc {
                                        Some(writer_mutex) => match writer_mutex.lock() {
                                            Ok(mut writer) => writer
                                                .write_all(data.as_bytes())
                                                .map_err(|e| e.to_string()),
                                            Err(_) => Err("writer mutex poisoned".to_string()),
                                        },
                                        None => Err("terminal not found".to_string()),
                                    }
                                };

                                // WS input is an external channel (like the REST paths) —
                                // tag the last-write source so an agent ended via WS stays
                                // sticky rather than reverting. Writer guard already dropped.
                                if write_result.is_ok() {
                                    if let Some(mut t) = state.terminals.get_mut(terminal_id) {
                                        t.last_input_source = Some("api".to_string());
                                        t.last_input_at = Some(chrono::Utc::now().timestamp_millis());
                                    }
                                }

                                let resp = match write_result {
                                    Ok(()) => json!({ "id": msg_id, "success": true }),
                                    Err(e) => {
                                        // Previously discarded — the client saw success
                                        // while input was silently dropped (broken pipe).
                                        log::warn!("[WS] terminal:input write failed for {}: {}", terminal_id, e);
                                        json!({ "id": msg_id, "success": false, "error": e })
                                    }
                                };
                                let _ = tx_internal.send(resp.to_string()).await;
                            }
                            _ => {
                                let resp = json!({
                                    "id": msg_id,
                                    "success": true,
                                });
                                let _ = tx_internal.send(resp.to_string()).await;
                            }
                        }
                    }
                    _ => {
                        // Echo success for other message types to keep client happy
                        if !msg_id.is_empty() {
                            let resp = json!({
                                "id": msg_id,
                                "success": true,
                            });
                            let _ = tx_internal.send(resp.to_string()).await;
                        }
                    }
                }
            }
        }
    }
    
    log::info!("WebSocket connection closed");
    sender_task.abort();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity_sample() -> crate::state::Terminal {
        crate::state::Terminal {
            id: "pc-abc123def".into(),
            pid: 4242,
            shell: "pwsh".into(),
            name: "Terminal-pwsh".into(),
            created_at: "2026-08-14T10:00:00+07:00".into(),
            cols: 120,
            rows: 40,
            backend: crate::tmux_manager::TerminalBackend::PortablePty,
            renderer_terminal_id: Some("tm-9f2c1a4b7".into()),
            owning_tab_id: Some("tb-4e8d0c2f1".into()),
            session_key: "tm-9f2c1a4b7".into(),
            last_input_source: None,
            last_input_at: None,
            prompt_hook: true,
        }
    }

    /// The canvas `node` block belongs to `GET /api/terminals/:id` ALONE.
    ///
    /// `terminal_identity_json` has three call sites, and `list_terminals` is one of them. If
    /// the block were built in here it would take the canvas-registry read lock and run a
    /// SQLite query once PER TERMINAL on every list call — for a field that endpoint was never
    /// asked to carry, and that no client reads from it. `plan/013` Task 19 described the
    /// change as "after building the existing JSON", which reads as though the handler builds
    /// its own object; it does not.
    #[test]
    fn the_shared_identity_payload_carries_no_canvas_node_block() {
        let v = terminal_identity_json(&identity_sample(), "ui");
        assert!(
            v.get("node").is_none(),
            "the node block must be merged at the get_terminal call site, not here —              otherwise list_terminals pays for it on every entry"
        );
    }

    /// Exact key names, asserted (design 011 §7 test 4). `tabId` stays a
    /// DEPRECATED alias of `terminalId` — redefining it would silently break
    /// every existing API/MCP client (D4).
    #[test]
    fn an_identity_response_carries_all_three_ids_under_exact_keys() {
        let v = terminal_identity_json(&identity_sample(), "ui");
        assert_eq!(v["id"], json!("pc-abc123def"));
        assert_eq!(v["processId"], json!("pc-abc123def"));
        assert_eq!(v["terminalId"], json!("tm-9f2c1a4b7"));
        assert_eq!(v["tabId"], json!("tm-9f2c1a4b7"));
        assert_eq!(v["owningTabId"], json!("tb-4e8d0c2f1"));
        assert_eq!(v["mode"], json!("ui"));
        assert_eq!(v["promptHook"], json!(true));
    }

    /// design 011 §7 test 5: leaf == owner for a RENDERER-created tab root.
    /// Not a general root-pane invariant — an API-created root's leaf is a
    /// `tm-*` owned by a different `tb-*` id, so leaf != owner there.
    #[test]
    fn a_renderer_created_root_reports_the_same_value_for_leaf_and_owner() {
        let mut t = identity_sample();
        t.renderer_terminal_id = Some("tb-4e8d0c2f1".into());
        let v = terminal_identity_json(&t, "ui");
        assert_eq!(v["terminalId"], v["owningTabId"]);
    }

    /// Correction C1: before P0-A `tab_id` was never None, so this shape could
    /// not occur. It can now — a headless API/fleet spawn has no renderer pane —
    /// and it must serialise as JSON null, NOT as the `pc-` process id.
    #[test]
    fn a_headless_terminal_reports_null_identities_not_a_process_id() {
        let mut t = identity_sample();
        t.renderer_terminal_id = None;
        t.owning_tab_id = None;
        let v = terminal_identity_json(&t, "ui");
        assert_eq!(v["terminalId"], json!(null));
        assert_eq!(v["tabId"], json!(null));
        assert_eq!(v["owningTabId"], json!(null));
        // The PTY is still addressable — only the renderer identities are absent.
        assert_eq!(v["id"], json!("pc-abc123def"));
    }

    /// Correction C4. `flagTabActivity` (tabsSlice.ts:133-141) resolves its
    /// argument against `state.tabs`, which holds ONLY root tab ids — a `tm-*`
    /// leaf finds nothing and the dispatch silently no-ops. The payload must
    /// therefore carry the OWNER explicitly.
    #[test]
    fn a_split_panes_activity_payload_carries_the_owning_tab() {
        let v = external_activity_payload(
            "pc-abc123def",
            Some("tm-9f2c1a4b7"),
            Some("tb-4e8d0c2f1"),
        );
        assert_eq!(v["owningTabId"], json!("tb-4e8d0c2f1"));
        assert_eq!(v["rendererTerminalId"], json!("tm-9f2c1a4b7"));
    }

    /// The two pre-existing keys must not move: `terminalId` here has always
    /// been the PROCESS id (the DashMap key passed by the caller), unlike every
    /// REST response where it is the leaf. That asymmetry is why the new
    /// explicit `processId` / `rendererTerminalId` keys exist.
    #[test]
    fn the_legacy_activity_keys_are_unchanged() {
        let v = external_activity_payload(
            "pc-abc123def",
            Some("tm-9f2c1a4b7"),
            Some("tb-4e8d0c2f1"),
        );
        assert_eq!(v["terminalId"], json!("pc-abc123def"));
        assert_eq!(v["processId"], json!("pc-abc123def"));
        assert_eq!(v["tabId"], json!("tm-9f2c1a4b7"));
    }

    #[test]
    fn an_unknown_terminal_yields_nulls_rather_than_a_missing_key() {
        let v = external_activity_payload("pc-gone", None, None);
        assert_eq!(v["rendererTerminalId"], json!(null));
        assert_eq!(v["owningTabId"], json!(null));
        assert_eq!(v["terminalId"], json!("pc-gone"));
    }

    /// Deterministic id minting so the tests assert values, not shapes.
    fn counting_mint() -> impl FnMut(&str) -> String {
        let mut n = 0u32;
        move |prefix: &str| {
            n += 1;
            format!("{prefix}-{n:09}")
        }
    }

    /// THE REGRESSION TEST (design 011 §7 test 1), as amended by option A. Two
    /// API creates targeting the same tab must produce DISTINCT leaves and the
    /// SAME owner. Before P0-A both stored `tb-shared01` as `tab_id`, which is
    /// the `terminal_history` PRIMARY KEY: one PTY got reaped by StateManager's
    /// reconcile, and closing either pane deleted the other's scrollback.
    /// Originally this test drove the collision through the split-a-pane
    /// (`paneId`) flow specifically, alongside a sibling test for the no-`paneId`
    /// (Mode 2) shape. Option A removed `pane_id` from the decision entirely —
    /// EVERY API create takes this path now, `paneId` or not — so both shapes
    /// collapse onto the same two-calls-in-a-row test.
    #[test]
    fn spawn_identity_two_api_splits_get_distinct_leaves_and_one_owner() {
        let mut mint = counting_mint();
        let a = resolve_api_spawn_identity(Some("tb-shared01"), None, &mut mint).expect("split a");
        let b = resolve_api_spawn_identity(Some("tb-shared01"), None, &mut mint).expect("split b");

        assert_ne!(a.renderer_terminal_id, b.renderer_terminal_id);
        assert!(a.renderer_terminal_id.starts_with("tm-"));
        assert!(b.renderer_terminal_id.starts_with("tm-"));
        assert_eq!(a.owning_tab_id, "tb-shared01");
        assert_eq!(b.owning_tab_id, "tb-shared01");
    }

    /// THE PINNED BEHAVIOUR CHANGE (option A). Design 011 §7 test 5 used to read
    /// "the leaf equals the owner for a tab's FIRST live terminal" — true right
    /// up until the *renderer* path could ALSO be that tab's first live
    /// terminal (a user restarting an exited root pane, which `commands::create_terminal`
    /// can never refuse). An API create cannot tell "genuinely new tab" from
    /// "this tab's root just died" apart from this signal alone, and guessing
    /// wrong (claiming the root) is exactly what produced the duplicate-leaf
    /// bug: two live terminals sharing one `terminal_history` PRIMARY KEY. So an
    /// API create now NEVER claims the root leaf — not even here, into a
    /// brand-new empty tab with no `paneId`, the one shape that used to be the
    /// clearest-cut "obviously it's the root". This is the exact behaviour
    /// change P0-A/option A makes and the one this test exists to pin.
    #[test]
    fn spawn_identity_first_create_into_an_empty_tab_still_gets_a_fresh_tm_leaf() {
        let mut mint = counting_mint();
        let r = resolve_api_spawn_identity(Some("tb-shared01"), None, &mut mint).expect("root");
        assert!(
            r.renderer_terminal_id.starts_with("tm-"),
            "an API create must never take the tab's own id as its leaf, even \
             into a brand-new empty tab: got {}",
            r.renderer_terminal_id
        );
        assert_ne!(r.renderer_terminal_id, "tb-shared01");
        assert_eq!(r.owning_tab_id, "tb-shared01");
    }

    /// NEW (not a conversion). Pins the exact shape of the behaviour change in
    /// isolation, independent of the test above: no `paneId` at all (there is no
    /// such parameter any more), a brand-new tab with no id supplied by the
    /// caller (so it is minted here, same as any other API create), and the
    /// resulting pane still gets a `tm-` leaf with `owning_tab_id` correctly set
    /// to that freshly-minted tab. If this ever regresses to `leaf == owner`,
    /// this is the test that must fail.
    #[test]
    fn an_api_create_with_no_pane_id_into_a_brand_new_tab_gets_a_tm_leaf_not_the_tab_id() {
        let mut mint = counting_mint();
        let r = resolve_api_spawn_identity(None, None, &mut mint)
            .expect("brand-new tab, no ids supplied at all");
        assert!(
            r.renderer_terminal_id.starts_with("tm-"),
            "got {} instead of a tm- leaf",
            r.renderer_terminal_id
        );
        assert!(r.owning_tab_id.starts_with("tb-"));
        assert_eq!(
            r.owning_tab_id, "tb-000000001",
            "the owner is the freshly-minted tab, same as before option A"
        );
        assert_ne!(
            r.renderer_terminal_id, r.owning_tab_id,
            "the whole point: leaf and owner are no longer the same id"
        );
    }

    /// Design 011 §7 test 9 / D7 — the gap review 095 B1 found, which the suite
    /// previously asserted as CORRECT for the `pane_id`-absent-but-tab-occupied
    /// case only. Option A generalises the fix: it no longer depends on the tab
    /// already being occupied, or on any occupancy scan at all — a second create
    /// into the same tab (still no pane id) gets a distinct `tm-` leaf for
    /// exactly the same reason the FIRST one now does.
    #[test]
    fn spawn_identity_second_create_into_a_populated_tab_gets_a_distinct_leaf() {
        let mut mint = counting_mint();
        let root = resolve_api_spawn_identity(Some("tb-shared01"), None, &mut mint)
            .expect("first create");
        assert!(root.renderer_terminal_id.starts_with("tm-"));

        let second = resolve_api_spawn_identity(Some("tb-shared01"), None, &mut mint)
            .expect("second create");
        assert_ne!(
            second.renderer_terminal_id, root.renderer_terminal_id,
            "a renderer leaf id must be unique per live terminal"
        );
        assert!(
            second.renderer_terminal_id.starts_with("tm-"),
            "a tab's second pane is a split whatever the caller sent, got {}",
            second.renderer_terminal_id
        );
        assert_eq!(second.owning_tab_id, "tb-shared01", "and it stays in that tab");
    }

    /// THE T2-F1 REGRESSION TEST (external review 099), CONVERTED. This used to
    /// model the decision→registration window between an identity decision and
    /// `spawn_terminal`'s final `terminals` insert, and prove a claim held
    /// across it. Option A removes that window for the API path entirely:
    /// `resolve_api_spawn_identity` reads and writes no shared state at all —
    /// not `terminals`, not `RootLeafClaims` — so there is nothing to interleave
    /// and nothing left to race. What survives is the stronger property that
    /// makes the window irrelevant: however many API creates are interleaved for
    /// the same tab — sequential here, real concurrency in the test below —
    /// none of them may ever produce a `tb-` leaf.
    #[test]
    fn a_create_inside_another_creates_spawn_window_cannot_take_the_same_root_leaf() {
        let mut mint = counting_mint();

        // "A" decides its identity. Under the pre-option-A code its PTY was
        // still being built at this point, so it had NOT registered anywhere.
        let a = resolve_api_spawn_identity(Some("tb-shared01"), None, &mut mint)
            .expect("create A");
        assert!(a.renderer_terminal_id.starts_with("tm-"), "A is never the tab root");

        // "B" arrives INSIDE what used to be that window. There is no scan left
        // to go stale — B's answer never depended on A having registered.
        let b = resolve_api_spawn_identity(Some("tb-shared01"), None, &mut mint)
            .expect("create B");
        assert_ne!(
            b.renderer_terminal_id, a.renderer_terminal_id,
            "two live terminals must never carry the same renderer leaf"
        );
        assert!(b.renderer_terminal_id.starts_with("tm-"));
        assert_eq!(b.owning_tab_id, "tb-shared01", "and it still lands in that tab");

        // "C" arrives after "A" would have registered. Still just another split.
        let c = resolve_api_spawn_identity(Some("tb-shared01"), None, &mut mint)
            .expect("create C");
        assert!(
            c.renderer_terminal_id.starts_with("tm-"),
            "every API create into this tab is a split, in any order: {}",
            c.renderer_terminal_id
        );
    }

    /// CONVERTED. This used to prove a failed spawn releases its RAII root-leaf
    /// reservation, so a retry could still claim the root. Option A removes the
    /// reservation itself (`RootLeafClaims` is no longer consulted from the API
    /// path) — there is nothing to leak, because there is nothing to hold. What
    /// survives is the retry guarantee: a create that follows a failed one (real
    /// or simulated — resolution can't tell the difference, it has no side
    /// effects to undo) still independently mints its own fresh `tm-` leaf,
    /// never the tab id, and never collides with the attempt before it.
    #[test]
    fn a_failed_spawn_leaves_nothing_to_leak_and_the_retry_gets_its_own_tm_leaf() {
        let mut mint = counting_mint();

        // Stands in for an attempt whose `spawn_terminal` subsequently failed —
        // resolution itself has no state to roll back.
        let first = resolve_api_spawn_identity(Some("tb-shared01"), None, &mut mint)
            .expect("first create");
        assert!(first.renderer_terminal_id.starts_with("tm-"));

        let retry = resolve_api_spawn_identity(Some("tb-shared01"), None, &mut mint)
            .expect("retry");
        assert!(
            retry.renderer_terminal_id.starts_with("tm-"),
            "the tab is still empty, but a retry still never claims its id: {}",
            retry.renderer_terminal_id
        );
        assert_ne!(retry.renderer_terminal_id, first.renderer_terminal_id);
    }

    /// CONVERTED. Used to prove exactly one of many racing creates could win the
    /// root leaf under real thread concurrency (the atomicity of
    /// `RootLeafClaims::try_claim`). Option A makes that race structurally
    /// impossible for the API path — `resolve_api_spawn_identity` touches no
    /// shared state, so there is nothing for concurrent callers to contend over
    /// — so the stronger property this now pins is design 011's headline
    /// invariant directly: no API create, under ANY ordering or concurrency,
    /// ever produces a `tb-` renderer leaf. Real threads (not just sequential
    /// calls) still earn their keep here: they exercise `mint_renderer_id`'s
    /// uuid generation under genuine concurrency, proving leaf uniqueness holds
    /// even without a coordinating claim.
    #[test]
    fn no_racing_api_create_ever_gets_the_root_leaf() {
        const RACERS: usize = 8;
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(RACERS));

        let handles: Vec<_> = (0..RACERS)
            .map(|_| {
                let barrier = std::sync::Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    resolve_api_spawn_identity(Some("tb-shared01"), None, mint_renderer_id)
                        .expect("racing create")
                })
            })
            .collect();

        let results: Vec<_> = handles.into_iter().map(|h| h.join().expect("thread")).collect();

        assert!(
            results.iter().all(|id| id.renderer_terminal_id.starts_with("tm-")),
            "no racer may take the tab id as its leaf: {results:?}"
        );
        let leaves: std::collections::HashSet<_> =
            results.iter().map(|id| id.renderer_terminal_id.clone()).collect();
        assert_eq!(leaves.len(), RACERS, "every racer's leaf must be distinct: {leaves:?}");
        assert!(results.iter().all(|id| id.owning_tab_id == "tb-shared01"));
    }

    #[test]
    fn spawn_identity_no_caller_id_mints_a_tab_exactly_as_before() {
        let mut mint = counting_mint();
        let r = resolve_api_spawn_identity(None, None, &mut mint).expect("minted");
        assert_eq!(r.owning_tab_id, "tb-000000001");
        // Pre-option-A this asserted `r.renderer_terminal_id == r.owning_tab_id`
        // ("exactly as before" meant leaf == owner for a fresh tab). Now the
        // owner is still freshly minted exactly as before, but the leaf is not.
        assert!(r.renderer_terminal_id.starts_with("tm-"));
        assert_ne!(r.renderer_terminal_id, r.owning_tab_id);
    }

    #[test]
    fn spawn_identity_an_empty_or_unrecognised_tab_id_still_mints_rather_than_failing() {
        let mut mint = counting_mint();
        assert!(resolve_api_spawn_identity(Some("   "), None, &mut mint)
            .expect("blank")
            .owning_tab_id
            .starts_with("tb-"));
        assert!(resolve_api_spawn_identity(Some("legacy-monitor-id"), None, &mut mint)
            .expect("junk")
            .owning_tab_id
            .starts_with("tb-"));
    }

    /// Correction C3. `api_server.rs:494` recognised `tb-` ONLY: a caller that
    /// did the "right" thing and sent a genuine `tm-` id had it silently thrown
    /// away and replaced by an unrelated fresh `tb-`, so the pane landed in the
    /// WRONG tab with no diagnostic. Fail closed instead, and name the field
    /// that carries the correct value.
    #[test]
    fn spawn_identity_a_pane_leaf_id_in_the_tab_field_is_rejected_not_silently_replaced() {
        let mut mint = counting_mint();
        let err = resolve_api_spawn_identity(Some("tm-9f2c1a4b7"), None, &mut mint)
            .expect_err("a tm- id is a pane id, not a tab id");
        assert!(err.contains("tm-9f2c1a4b7"), "the message must name the offending id: {err}");
        assert!(err.contains("owningTabId"), "the message must name the right field: {err}");
    }

    /// An explicit `owningTabId` wins over `tabId` — it is the unambiguous field.
    #[test]
    fn spawn_identity_an_explicit_owning_tab_id_takes_precedence() {
        let mut mint = counting_mint();
        let r = resolve_api_spawn_identity(Some("tb-ignored1"), Some("tb-explicit"), &mut mint)
            .expect("explicit owner");
        assert_eq!(r.owning_tab_id, "tb-explicit");
        assert!(r.renderer_terminal_id.starts_with("tm-"));
    }

    fn identity_temp_db() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let mut p = std::env::temp_dir();
        p.push(format!(
            "termflow_identity_{}_{}.db",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_file(&p);
        p
    }

    /// Design 011 §7 test 2 — history isolation, end to end at the storage
    /// layer. Two API splits in one tab must occupy two rows, and closing one
    /// (`commands.rs:1028-1030` deletes by the renderer id) must leave the
    /// other's scrollback intact. Before P0-A both ids were `tb-shared01`, so
    /// the second upsert clobbered the first and the delete wiped both.
    #[test]
    fn two_api_splits_no_longer_share_one_history_row() {
        let mut mint = counting_mint();
        // Every API create mints a fresh `tm-` unconditionally now, so distinct
        // leaves need no occupancy probe to force them.
        let a = resolve_api_spawn_identity(Some("tb-shared01"), None, &mut mint).expect("split a");
        let b = resolve_api_spawn_identity(Some("tb-shared01"), None, &mut mint).expect("split b");

        let store = crate::history_store::HistoryStore::new();
        store.init(&identity_temp_db());
        store.upsert(&a.renderer_terminal_id, &["pane A scrollback".to_string()], 1);
        store.upsert(&b.renderer_terminal_id, &["pane B scrollback".to_string()], 2);

        assert_eq!(
            store.get(&a.renderer_terminal_id),
            Some(vec!["pane A scrollback".to_string()]),
            "pane A's history must not be overwritten by pane B's flush"
        );

        // Closing pane A.
        store.delete(&a.renderer_terminal_id);
        assert_eq!(store.get(&a.renderer_terminal_id), None);
        assert_eq!(
            store.get(&b.renderer_terminal_id),
            Some(vec!["pane B scrollback".to_string()]),
            "closing one split must not delete the other's scrollback"
        );
    }

    #[test]
    fn the_release_and_dev_renderers_are_both_allowed() {
        assert!(origin_allowed(Some("http://tauri.localhost"), Some("127.0.0.1:42031")));
        assert!(origin_allowed(Some("https://tauri.localhost"), Some("127.0.0.1:42031")));
        // macOS/Linux serve the app over the custom protocol instead.
        assert!(origin_allowed(Some("tauri://localhost"), Some("127.0.0.1:42031")));
        // tauri.conf.json:9 -- rev 1 omitted this and would have broken dev.
        #[cfg(debug_assertions)]
        assert!(origin_allowed(Some("http://localhost:42010"), Some("127.0.0.1:42031")));
    }

    #[test]
    fn requests_from_a_web_page_are_rejected() {
        assert!(!origin_allowed(Some("https://evil.example"), Some("127.0.0.1:42031")));
        assert!(!origin_allowed(Some("http://localhost:3000"), Some("127.0.0.1:42031")));
        // Near-misses on the app origin must not slip through a prefix check.
        assert!(!origin_allowed(Some("http://tauri.localhost.evil.example"), None));
        assert!(!origin_allowed(Some("http://evil.tauri.localhost"), None));
    }

    #[test]
    fn requests_with_no_origin_are_allowed() {
        // D1: curl, the MCP sidecar and user scripts are unchanged.
        assert!(origin_allowed(None, Some("127.0.0.1:42031")));
    }

    #[test]
    fn an_elevated_instance_requires_a_token_even_on_loopback() {
        use crate::profile::Integrity;
        // D1 keeps loopback open for NORMAL instances. An elevated instance is a
        // different risk class: an unauthenticated write becomes Medium->High
        // privilege escalation, so provenance checks are not sufficient there.
        assert!(auth_required(Integrity::High, /*expose*/ false));
        assert!(!auth_required(Integrity::Medium, false));
        assert!(auth_required(Integrity::Medium, true));
        assert!(auth_required(Integrity::High, true));
    }

    /// Design 014 §B-D5. `auth_required` is false for a normal, non-exposed
    /// instance, so its loopback API is unauthenticated — fine for terminal
    /// verbs, not fine for one that changes another process's shutdown
    /// semantics. Any local process could otherwise arm a sibling.
    #[test]
    fn the_hotswap_routes_always_require_a_token() {
        assert!(route_always_requires_token("/api/hotswap/arm"));
        assert!(route_always_requires_token("/api/hotswap/disarm"));
    }

    /// ...and ordinary routes keep D1's zero-friction loopback, or this would
    /// be a silent breaking change for curl and the MCP sidecar.
    #[test]
    fn ordinary_routes_keep_the_unauthenticated_loopback() {
        for path in ["/api/terminals", "/api/health", "/health", "/api/system/info", "/api/fleet/terminals"] {
            assert!(!route_always_requires_token(path), "{path} must not become token-gated");
        }
    }

    /// The prefix must not leak onto a route that merely starts similarly — a
    /// blanket `contains("hotswap")` would catch unrelated future paths.
    #[test]
    fn the_always_token_rule_is_scoped_to_the_hotswap_prefix() {
        assert!(!route_always_requires_token("/api/terminals/hotswap"));
        assert!(!route_always_requires_token("/api/hotswapping"));
    }

    #[test]
    fn every_allowed_origin_is_a_legal_header_value() {
        // `cors_layer` silently drops an origin that fails to parse, which would
        // 403 that renderer at runtime with no compile-time signal. Build it here
        // and check each candidate converts.
        for o in APP_ORIGINS {
            assert!(HeaderValue::from_str(o).is_ok(), "unusable origin: {o}");
        }
        #[cfg(debug_assertions)]
        assert!(HeaderValue::from_str(DEV_ORIGIN).is_ok());
        let _ = cors_layer();
    }

    #[test]
    fn dns_rebinding_hosts_are_rejected() {
        assert!(!origin_allowed(None, Some("attacker.example")));
        assert!(origin_allowed(None, Some("localhost:42031")));
        assert!(origin_allowed(None, Some("[::1]:42031")));
        assert!(origin_allowed(None, Some("127.0.0.1")));
        assert!(origin_allowed(None, None));
    }

    #[test]
    fn test_dedup_preserve_order_keeps_first_occurrence() {
        let input = vec![
            "a".to_string(), "b".to_string(), "a".to_string(),
            "c".to_string(), "b".to_string(),
        ];
        assert_eq!(dedup_preserve_order(&input), vec!["a", "b", "c"]);
    }

    #[test]
    fn test_dedup_preserve_order_empty() {
        let input: Vec<String> = vec![];
        assert!(dedup_preserve_order(&input).is_empty());
    }

    #[test]
    fn build_sentinel_command_per_shell() {
        assert_eq!(
            build_sentinel_command(ShellKind::PowerShell, "Get-Date", "N1"),
            "Get-Date ; $c = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 } ; Write-Output \"@@TFDONE:N1:$c@@\""
        );
        assert_eq!(
            build_sentinel_command(ShellKind::Posix, "ls -la", "N1"),
            "ls -la ; printf \"@@TFDONE:N1:%s@@\\n\" \"$?\""
        );
        assert_eq!(
            build_sentinel_command(ShellKind::Cmd, "dir", "N1"),
            "dir & cmd /v:on /c \"echo @@TFDONE:N1:!ERRORLEVEL!@@\""
        );
    }

    // NOTE for Task H2's integration test: exercise a REAL non-zero exit (e.g. a command
    // that exits 3) AND a PowerShell cmdlet (e.g. `Get-Date`) end-to-end, asserting the
    // captured exitCode is correct — the unit test above only checks the wrapper string,
    // which cannot catch cmd.exe parse-time expansion or PowerShell's $null $LASTEXITCODE.

    #[test]
    fn get_cli_pattern_submits_agent_tuis_with_a_plain_cr() {
        // Regression guard: codex/opencode must NOT inherit copilot's Down-Arrow
        // (`\x1b[B\r`), which navigates message history in both TUIs.
        assert_eq!(get_cli_pattern("codex"), Some(("", "\r")));
        assert_eq!(get_cli_pattern("opencode"), Some(("", "\r")));
        assert_eq!(get_cli_pattern("copilot"), Some(("", "\x1b[B\r")));
        // Unknown types still reject, so a typo'd cliType fails loudly (400)
        // rather than silently sending the wrong keystrokes.
        assert_eq!(get_cli_pattern("codexx"), None);
    }

    #[test]
    fn classify_shell_kind_maps_common_shells() {
        assert_eq!(
            classify_shell_kind(
                "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
                "Windows PowerShell"
            ),
            ShellKind::PowerShell
        );
        assert_eq!(classify_shell_kind("/usr/bin/pwsh", "PowerShell"), ShellKind::PowerShell);
        assert_eq!(
            classify_shell_kind("C:\\Windows\\System32\\cmd.exe", "Command Prompt"),
            ShellKind::Cmd
        );
        assert_eq!(classify_shell_kind("/bin/bash", "bash"), ShellKind::Posix);
        assert_eq!(classify_shell_kind("/bin/zsh", "zsh"), ShellKind::Posix);
        assert_eq!(classify_shell_kind("/bin/sh", "sh"), ShellKind::Posix);
    }

    #[test]
    fn sentinel_ignores_command_echo_and_reads_output() {
        let nonce = "deadbeef";
        // The echoed pasted command still carries the LITERAL $LASTEXITCODE token
        // (no digits between the colons) so it must NOT match.
        let echo = "pwsh> Get-Item x ; Write-Output \"@@TFDONE:deadbeef:$LASTEXITCODE@@\"";
        assert_eq!(sentinel_exit_code(echo, nonce), None);
        // The real executed output line carries the substituted number.
        let out = format!("{}\r\n@@TFDONE:deadbeef:0@@\r\n", echo);
        assert_eq!(sentinel_exit_code(&out, nonce), Some(0));
    }

    #[test]
    fn sentinel_parses_negative_exit_code() {
        assert_eq!(sentinel_exit_code("x\n@@TFDONE:n9:-1@@\n", "n9"), Some(-1));
        assert_eq!(sentinel_exit_code("no marker here", "n9"), None);
    }

    // Real runtime proof that the new `/batch/...` static routes coexist with the
    // `/:id/...` param routes. Router construction PANICS on a matchit conflict,
    // so building it without panicking IS the assertion — and it needs no AppState.
    #[test]
    fn test_batch_routes_coexist_with_param_routes() {
        async fn dummy() -> &'static str { "ok" }
        let _router: axum::Router<()> = axum::Router::new()
            .route("/api/terminals/:id/execute", axum::routing::post(dummy))
            .route("/api/terminals/:id/input", axum::routing::post(dummy))
            .route("/api/terminals/batch/execute", axum::routing::post(dummy))
            .route("/api/terminals/batch/input", axum::routing::post(dummy));
    }

    // The per-connection WS subscription filter: default `All` forwards every
    // terminal; after a `subscribe` it narrows to exactly the requested ids.
    #[test]
    fn subscription_filter_scopes_terminals() {
        let mut sub = SubscriptionFilter::all(); // default: everything
        assert!(sub.wants("tb-1"));
        assert!(sub.wants("anything"));

        sub.set(vec!["tb-2".into()]); // after subscribe
        assert!(!sub.wants("tb-1"));
        assert!(sub.wants("tb-2"));

        // Re-subscribing replaces the set rather than accumulating.
        sub.set(vec!["tb-3".into(), "tb-4".into()]);
        assert!(!sub.wants("tb-2"));
        assert!(sub.wants("tb-3"));
        assert!(sub.wants("tb-4"));

        // An empty subscribe scopes to nothing (opt-out of all output).
        sub.set(vec![]);
        assert!(!sub.wants("tb-3"));
    }

    // Regression: a `subscribe` WITHOUT a top-level `terminalIds` field (the shipping
    // terminal-monitor client sends only `payload.patterns`) must NOT narrow the filter.
    // The absent-vs-empty distinction lives in the handler's parse step, which the
    // `subscription_filter_scopes_terminals` test above does not exercise (it drives
    // `SubscriptionFilter::set` directly). Conflating the two — as the old
    // `value["terminalIds"].as_array()...unwrap_or_default()` did — yielded `Only([])` and
    // dropped ALL live output for that client.
    #[test]
    fn subscribe_without_terminal_ids_keeps_all() {
        // Pattern-only subscribe: no top-level terminalIds → parses to None → filter stays All.
        let pattern_only = json!({
            "type": "subscribe",
            "payload": { "patterns": ["output.data", "process.*"] }
        });
        assert_eq!(parse_subscribe_ids(&pattern_only), None, "absent terminalIds → None");

        let mut filter = SubscriptionFilter::all();
        if let Some(ids) = parse_subscribe_ids(&pattern_only) {
            filter.set(ids);
        }
        assert!(matches!(filter, SubscriptionFilter::All), "absent field leaves the filter at All");
        assert!(filter.wants("tb-anything"), "All still forwards every terminal's output");

        // An explicit `terminalIds` DOES narrow — including an explicit empty array
        // (opt-out), which is a deliberate scope-to-nothing distinct from the absent case.
        let scoped = json!({ "type": "subscribe", "terminalIds": ["tb-1", "tb-2"] });
        let ids = parse_subscribe_ids(&scoped).expect("present terminalIds → Some");
        filter.set(ids);
        assert!(filter.wants("tb-1"));
        assert!(!filter.wants("tb-3"));

        assert_eq!(
            parse_subscribe_ids(&json!({ "type": "subscribe", "terminalIds": [] })),
            Some(vec![]),
            "explicit empty array is Some([]) (opt-out), never None"
        );
    }

    // Regression guard for backlog 013: the writer value is `Arc<Mutex<..>>`, so a
    // send path clones the Arc and drops the DashMap shard guard before the long
    // inner-lock hold (the send/probe sleeps). This proves that once the Arc is
    // cloned out, a `remove` on the SAME shard proceeds even while the inner
    // writer lock is held — i.e. no shard guard is held across the hold. Under the
    // old bare-`Mutex` layout the caller kept the `Ref`, and this same-thread
    // `remove` on the same shard would deadlock instead of returning.
    #[test]
    fn test_writer_arc_lets_concurrent_remove_proceed_during_send() {
        use dashmap::DashMap;
        use std::io::Write;
        use std::sync::{Arc, Mutex};

        type Writer = Arc<Mutex<Box<dyn Write + Send>>>;
        let map: DashMap<String, Writer> = DashMap::new();
        let sink: Box<dyn Write + Send> = Box::new(Vec::<u8>::new());
        map.insert("term-1".to_string(), Arc::new(Mutex::new(sink)));

        // Send path: clone the Arc, dropping the shard guard.
        let writer_arc = map.get("term-1").map(|r| r.clone()).expect("writer present");
        // Simulate the mid-send state: inner writer lock held.
        let mut writer = writer_arc.lock().expect("inner lock");
        writer.write_all(b"in-flight prompt").expect("write");

        // A concurrent close removes the entry from the SAME shard. With the shard
        // guard already dropped this returns immediately (no deadlock).
        let removed = map.remove("term-1");
        assert!(removed.is_some(), "remove should proceed while a send holds the writer");
        drop(removed); // the closed terminal's map entry (and its Arc) is gone

        // The cloned Arc outlives the removal — the in-flight send still owns a
        // valid writer, and the map is now empty for the next lookup.
        drop(writer);
        assert_eq!(Arc::strong_count(&writer_arc), 1, "map's Arc dropped by remove");
        assert!(map.get("term-1").is_none(), "next write surfaces as Terminal not found");
    }

    // Integration guard for backlog 013 that drives the REAL `send_prompt_to_terminal`
    // handler (not a local re-implementation). It builds an `AppState<MockRuntime>` via
    // `tauri::test::mock_app()`, starts an in-flight send (which sleeps ~500 ms mid-send),
    // then times a concurrent same-shard `remove`. With the fix the send holds no DashMap
    // shard guard across its `.await`, so the remove returns immediately; the pre-fix code
    // held the shard read-guard across the sleep and this remove would block for the
    // remaining send duration — which this test's timing assertion catches.
    //
    // Gated behind the `integration-tests` feature because it needs tauri's `test`
    // feature (mock_app). Enabling that feature breaks the Rust test *binary* at loader
    // time on Windows (STATUS_ENTRYPOINT_NOT_FOUND), so this runs on Linux/macOS only:
    //   cargo test --features integration-tests
    // See docs/guides for the CI pipeline that exercises it.
    #[cfg(feature = "integration-tests")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn test_send_prompt_does_not_block_concurrent_removal() {
        use std::io::Write;
        use std::sync::{Arc, Mutex};
        use std::time::{Duration, Instant};
        use tokio::sync::oneshot;

        // A sink that fires a one-shot the first time the send writes to it. This is a
        // DETERMINISTIC sync point (no arbitrary sleep): the write only happens after
        // `send_prompt_to_terminal` has cloned the writer Arc and dropped the DashMap
        // Ref, so the test can start the concurrent remove exactly then. In the pre-fix
        // code the write fires while the Ref is still held, so the subsequent remove
        // blocks on the shard lock through the 500 ms sleep — still caught below.
        struct SignalOnWrite {
            started: Option<oneshot::Sender<()>>,
        }
        impl Write for SignalOnWrite {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                if let Some(tx) = self.started.take() {
                    let _ = tx.send(());
                }
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        let app = tauri::test::mock_app();
        let (tx, _rx) = tokio::sync::broadcast::channel(16);
        let state = AppState::new(
            tx,
            app.handle().clone(),
            crate::app_config::NetworkConfig::defaults(),
        );

        let id = "term-block-test".to_string();
        let (started_tx, started_rx) = oneshot::channel();
        let sink: Box<dyn Write + Send> = Box::new(SignalOnWrite { started: Some(started_tx) });
        state
            .shell_writer_channels
            .insert(id.clone(), Arc::new(Mutex::new(sink)));

        // Task A: a real in-flight send. cli_type "copilot" writes the prompt (fires the
        // signal), then sleeps 500 ms (the focus-in delay) before the end indicator.
        let state_a = state.clone();
        let id_a = id.clone();
        let sender = tokio::spawn(async move {
            let payload = ExecutePromptReq {
                prompt: "hello".to_string(),
                cli_type: "copilot".to_string(),
                submission_signal: None,
                custom_pattern: None,
            };
            send_prompt_to_terminal(&state_a, &id_a, &payload).await
        });

        // Deterministic barrier: proceed only once the send's first write lands — i.e.
        // the Arc has been cloned, the shard Ref dropped, and the send is now in its
        // 500 ms sleep. Bounded so a hang fails loudly instead of blocking forever.
        tokio::time::timeout(Duration::from_secs(5), started_rx)
            .await
            .expect("send did not reach its first write within 5s")
            .expect("send task dropped the signal sender");

        // A concurrent close removes the same-shard entry. Timed on a blocking thread so
        // a regression shows up as real wall-clock block: the pre-fix code holds the
        // shard read-guard through the 500 ms sleep (remove blocks ~500 ms); the fixed
        // code returns in microseconds. The 250 ms threshold sits well between the two.
        let start = Instant::now();
        let removed = tokio::task::spawn_blocking({
            let state = state.clone();
            let id = id.clone();
            move || state.shell_writer_channels.remove(&id).is_some()
        })
        .await
        .unwrap();
        let elapsed = start.elapsed();

        assert!(removed, "entry should have been present to remove");
        assert!(
            elapsed < Duration::from_millis(250),
            "same-shard remove blocked for {:?} — a writer path is holding the DashMap \
             shard guard across an .await (backlog 013 regression)",
            elapsed
        );

        // The in-flight send still owns its cloned Arc and completes successfully.
        let result = sender.await.unwrap();
        assert!(result.is_ok(), "send should still succeed after the concurrent remove");
    }

    // The `/health` contract the startup smoke test (scripts/smoke-test-release.mjs)
    // depends on: it polls this endpoint and treats `status: "ok"` as "the build
    // launched". Pin that body here so a rename (e.g. status → "healthy") can't
    // silently make the smoke gate un-satisfiable. The router wiring + real HTTP
    // binding are covered end-to-end by the smoke script against the built binary;
    // this guards the payload the handler serialises.
    #[test]
    fn health_body_reports_ok_status_and_instance_id() {
        let body = health_body("inst-abc123");
        assert_eq!(body["status"], "ok", "smoke test keys off status == ok");
        assert_eq!(body["app"], "auto-terminal");
        assert_eq!(
            body["instanceId"], "inst-abc123",
            "health must echo this process's instanceId for P0b conflict detection"
        );
    }

    #[test]
    fn test_render_terminal_history_replays_cursor_movement() {
        let mut history = std::collections::VecDeque::new();
        history.push_back("aaaaa\r\nbbbbb\r\nccccc".to_string());
        history.push_back("\x1b[H11111\r\n22222\r\n33333".to_string());

        let rendered = render_terminal_history(&history, 24, 80);

        assert_eq!(rendered.trim_end(), "11111\n22222\n33333");
    }

    #[test]
    fn test_render_terminal_history_overwrites_same_line() {
        let mut history = std::collections::VecDeque::new();
        history.push_back("loading".to_string());
        history.push_back("\rbooting".to_string());

        let rendered = render_terminal_history(&history, 24, 80);

        assert_eq!(rendered.trim_end(), "booting");
    }

    // The hydration snapshot relies on contents_formatted() round-tripping: a
    // freshly-reset terminal that consumes the snapshot must reproduce the exact
    // visible screen (including styles), so a reconnecting client stays in sync.
    #[test]
    fn test_formatted_snapshot_round_trips_screen() {
        let mut source = vt100::Parser::new(24, 80, 0);
        // Colored text plus cursor positioning, like a TUI redraw.
        source.process(b"\x1b[31mred\x1b[0m\r\nplain\r\n\x1b[5;10Hmoved");

        let snapshot = source.screen().contents_formatted();

        // Replay the snapshot into a fresh parser of the same size.
        let mut restored = vt100::Parser::new(24, 80, 0);
        restored.process(&snapshot);

        assert_eq!(
            restored.screen().contents(),
            source.screen().contents(),
            "snapshot replay must reproduce the source screen text"
        );
        // Styles (SGR colors/attrs) must round-trip too, not just plain text:
        // contents_formatted of the restored screen must equal the source's.
        assert_eq!(
            restored.screen().contents_formatted(),
            source.screen().contents_formatted(),
            "snapshot replay must reproduce styling, not just text"
        );
        // Cursor position must be preserved so incremental TUI redraws align.
        assert_eq!(
            restored.screen().cursor_position(),
            source.screen().cursor_position(),
            "snapshot replay must restore the cursor position"
        );
    }

    // Pins WHY the reader-facing screen (`/fleet/screen`, fleet execute) renders from
    // the grid via `contents()` instead of regex-stripping escapes out of
    // `contents_formatted()`: the formatted blob encodes runs of blanks as cursor ops,
    // so stripping silently collapses column alignment.
    #[test]
    fn plain_screen_text_keeps_alignment_that_escape_stripping_destroys() {
        let mut p = vt100::Parser::new(24, 80, 0);
        // Two columns, the second placed by absolute cursor positioning — the shape a
        // full-screen TUI (status bar, sidebar) produces.
        p.process(b"\x1b[1;1HNAME\x1b[1;40HSTATUS\r\n\x1b[2;1Hbuild\x1b[2;40Hok");

        let text = p.screen().contents();
        let first = text.lines().next().expect("a first row");
        // The gap survives as real spaces, so the columns still line up.
        assert!(first.starts_with("NAME"), "got {first:?}");
        assert_eq!(first.find("STATUS"), Some(39), "STATUS must stay in column 40");

        // Whereas the formatted blob carries no such spaces to preserve: it moves the
        // cursor instead, so dropping escapes would butt the columns together.
        let formatted = String::from_utf8_lossy(&p.screen().contents_formatted()).into_owned();
        assert!(
            !formatted.contains("NAME                                   STATUS"),
            "formatted blob is expected to encode the gap as cursor motion, not spaces"
        );
    }

    // set_size updates the grid dimensions so the snapshot has the right number
    // of rows/cols for the client viewport. Like a real VT it does NOT rewrap:
    // growing preserves content; shrinking clips beyond the new width (the running
    // program is expected to redraw on SIGWINCH). This test pins both facts.
    #[test]
    fn test_screen_set_size_updates_dimensions_and_clips() {
        // Growing preserves existing content and reports the new size.
        let mut grow = vt100::Parser::new(24, 80, 0);
        grow.process(b"hello world");
        grow.screen_mut().set_size(30, 100);
        assert_eq!(grow.screen().size(), (30, 100));
        assert!(grow.screen().contents().contains("hello world"));

        // Shrinking narrower than the content clips (does not reflow) — documenting
        // the real vt100 behavior the snapshot relies on.
        let mut shrink = vt100::Parser::new(24, 80, 0);
        let text = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWX"; // 59 chars
        shrink.process(text.as_bytes());
        shrink.screen_mut().set_size(24, 40);
        assert_eq!(shrink.screen().size(), (24, 40));
        let row0 = shrink.screen().contents();
        assert!(row0.starts_with(&text[..40]), "first 40 cols preserved");
        assert!(!row0.contains(text), "content beyond width is clipped, not reflowed");
    }

    #[tokio::test]
    async fn watch_for_sentinel_detects_exit_code_across_chunks() {
        let (tx, _keep) = tokio::sync::broadcast::channel::<ChannelPayload>(64);
        let rx = tx.subscribe();
        // Marker deliberately split across two chunks to prove reassembly.
        tx.send(ChannelPayload { id: "pc-1".into(), data: b"work\r\n@@TFDONE:abc12".to_vec() }).unwrap();
        tx.send(ChannelPayload { id: "pc-1".into(), data: b"3:0@@\r\n".to_vec() }).unwrap();
        let (done, code) =
            watch_for_sentinel(rx, "pc-1", "abc123", std::time::Duration::from_secs(2)).await;
        assert!(done);
        assert_eq!(code, Some(0));
    }

    #[tokio::test]
    async fn watch_for_sentinel_ignores_other_terminals_and_reads_negative() {
        let (tx, _keep) = tokio::sync::broadcast::channel::<ChannelPayload>(64);
        let rx = tx.subscribe();
        // A marker for a DIFFERENT terminal must be ignored.
        tx.send(ChannelPayload { id: "pc-other".into(), data: b"@@TFDONE:n1:0@@".to_vec() }).unwrap();
        tx.send(ChannelPayload { id: "pc-1".into(), data: b"boom\r\n@@TFDONE:n1:-1@@\r\n".to_vec() }).unwrap();
        let (done, code) =
            watch_for_sentinel(rx, "pc-1", "n1", std::time::Duration::from_secs(2)).await;
        assert!(done);
        assert_eq!(code, Some(-1));
    }

    #[tokio::test]
    async fn watch_for_sentinel_times_out_without_marker() {
        let (tx, _keep) = tokio::sync::broadcast::channel::<ChannelPayload>(64);
        let rx = tx.subscribe();
        tx.send(ChannelPayload { id: "pc-1".into(), data: b"still running...".to_vec() }).unwrap();
        let (done, code) =
            watch_for_sentinel(rx, "pc-1", "n1", std::time::Duration::from_millis(150)).await;
        assert!(!done);
        assert_eq!(code, None);
    }

    #[tokio::test]
    async fn watch_for_sentinel_survives_multibyte_drain_boundary() {
        let (tx, _keep) = tokio::sync::broadcast::channel::<ChannelPayload>(64);
        let rx = tx.subscribe();
        // 20000+ bytes of the 3-byte '€' (U+20AC) — forces the >16384 drain at a
        // cut offset that is NOT a char boundary (would panic before the fix).
        let big = "\u{20AC}".repeat(6667); // ~20001 bytes
        tx.send(ChannelPayload { id: "pc-1".into(), data: big.into_bytes() }).unwrap();
        tx.send(ChannelPayload { id: "pc-1".into(), data: b"@@TFDONE:n1:0@@\r\n".to_vec() }).unwrap();
        let (done, code) =
            watch_for_sentinel(rx, "pc-1", "n1", std::time::Duration::from_secs(2)).await;
        assert!(done);
        assert_eq!(code, Some(0));
    }

    mod fleet_tests {
        use super::super::*;

        fn m(id: &str, os: Option<&str>, online: bool) -> FleetMachine {
            FleetMachine {
                machine_id: id.to_string(),
                device_name: format!("dev-{id}"),
                os: os.map(|s| s.to_string()),
                online,
            }
        }

        #[test]
        fn alias_os_canonicalizes_known_aliases() {
            assert_eq!(alias_os("osx"), "macos");
            assert_eq!(alias_os("darwin"), "macos");
            assert_eq!(alias_os("macos"), "macos");
            assert_eq!(alias_os("win"), "windows");
            assert_eq!(alias_os("win32"), "windows");
            assert_eq!(alias_os("WINDOWS"), "windows");
            assert_eq!(alias_os("linux"), "linux");
            // Unknown OS passes through lowercased (targetable by machineId only).
            assert_eq!(alias_os("FreeBSD"), "freebsd");
        }

        #[test]
        fn terminal_id_with_remote_machine_is_remote_terminal() {
            let roster = [m("self", Some("windows"), true), m("other", Some("linux"), true)];
            let r = resolve_fleet_target(None, Some("other"), Some("t-1"), &roster, "self");
            assert_eq!(
                r,
                FleetResolution::RemoteTerminal {
                    machine_id: "other".into(),
                    terminal_id: "t-1".into()
                }
            );
        }

        #[test]
        fn terminal_id_on_self_or_without_machine_is_local() {
            let roster = [m("self", Some("windows"), true)];
            assert_eq!(
                resolve_fleet_target(None, Some("self"), Some("t-1"), &roster, "self"),
                FleetResolution::Local
            );
            assert_eq!(
                resolve_fleet_target(None, None, Some("t-1"), &roster, "self"),
                FleetResolution::Local
            );
        }

        #[test]
        fn machine_id_precedence_local_vs_remote() {
            let roster = [m("self", Some("windows"), true), m("other", Some("linux"), true)];
            assert_eq!(
                resolve_fleet_target(None, Some("self"), None, &roster, "self"),
                FleetResolution::Local
            );
            assert_eq!(
                resolve_fleet_target(None, Some("other"), None, &roster, "self"),
                FleetResolution::Remote { machine_id: "other".into() }
            );
        }

        #[test]
        fn os_unique_online_resolves_remote_or_local() {
            let roster = [m("self", Some("windows"), true), m("other", Some("linux"), true)];
            assert_eq!(
                resolve_fleet_target(Some("linux"), None, None, &roster, "self"),
                FleetResolution::Remote { machine_id: "other".into() }
            );
            // self counts toward OS matching.
            assert_eq!(
                resolve_fleet_target(Some("windows"), None, None, &roster, "self"),
                FleetResolution::Local
            );
        }

        #[test]
        fn os_alias_matches_canonical_roster_os() {
            let roster = [m("self", Some("windows"), true), m("mac1", Some("macos"), true)];
            assert_eq!(
                resolve_fleet_target(Some("darwin"), None, None, &roster, "self"),
                FleetResolution::Remote { machine_id: "mac1".into() }
            );
        }

        #[test]
        fn os_ambiguous_when_multiple_online_peers_share_os() {
            let roster = [
                m("self", Some("windows"), true),
                m("lin1", Some("linux"), true),
                m("lin2", Some("linux"), true),
            ];
            match resolve_fleet_target(Some("linux"), None, None, &roster, "self") {
                FleetResolution::Ambiguous { candidates } => {
                    assert_eq!(candidates, vec!["lin1".to_string(), "lin2".to_string()]);
                }
                other => panic!("expected Ambiguous, got {other:?}"),
            }
        }

        #[test]
        fn os_no_match_when_zero_or_only_offline() {
            let roster = [m("self", Some("windows"), true), m("lin1", Some("linux"), false)];
            // linux peer exists but is offline → NoMatch.
            assert_eq!(
                resolve_fleet_target(Some("linux"), None, None, &roster, "self"),
                FleetResolution::NoMatch
            );
            // no macos peer at all → NoMatch.
            assert_eq!(
                resolve_fleet_target(Some("macos"), None, None, &roster, "self"),
                FleetResolution::NoMatch
            );
        }

        #[test]
        fn no_signals_defaults_to_local() {
            let roster = [m("self", Some("windows"), true)];
            assert_eq!(
                resolve_fleet_target(None, None, None, &roster, "self"),
                FleetResolution::Local
            );
        }

        #[test]
        fn classify_maps_resolution_and_fabric_presence() {
            assert_eq!(classify_fleet_route(FleetResolution::Local, false), ExecuteRoute::Local);
            assert_eq!(
                classify_fleet_route(FleetResolution::Remote { machine_id: "o".into() }, true),
                ExecuteRoute::Proxy { device_id: "o".into(), terminal_id: None }
            );
            assert_eq!(
                classify_fleet_route(FleetResolution::Remote { machine_id: "o".into() }, false),
                ExecuteRoute::NotInstalled
            );
            assert_eq!(
                classify_fleet_route(
                    FleetResolution::RemoteTerminal { machine_id: "o".into(), terminal_id: "t".into() },
                    true
                ),
                ExecuteRoute::Proxy { device_id: "o".into(), terminal_id: Some("t".into()) }
            );
            assert_eq!(
                classify_fleet_route(
                    FleetResolution::RemoteTerminal { machine_id: "o".into(), terminal_id: "t".into() },
                    false
                ),
                ExecuteRoute::NotInstalled
            );
            assert_eq!(
                classify_fleet_route(FleetResolution::Ambiguous { candidates: vec!["a".into()] }, true),
                ExecuteRoute::Ambiguous(vec!["a".into()])
            );
            assert_eq!(classify_fleet_route(FleetResolution::NoMatch, true), ExecuteRoute::NoMatch);
        }

        #[test]
        fn peer_value_to_machine_reads_os_and_online() {
            let p = serde_json::json!({
                "device_id": "dev-x", "name": "Workstation", "os": "linux", "online": true
            });
            let machine = peer_value_to_machine(&p).expect("valid peer");
            assert_eq!(machine.machine_id, "dev-x");
            assert_eq!(machine.device_name, "Workstation");
            assert_eq!(machine.os.as_deref(), Some("linux"));
            assert!(machine.online);
            // Missing device_id → None (skip, don't fabricate a machine).
            assert!(peer_value_to_machine(&serde_json::json!({ "name": "x" })).is_none());
        }

        #[test]
        fn machine_to_json_tags_self_and_carries_os() {
            let mac = m("self", Some("windows"), true);
            let v = machine_to_json(&mac, true);
            assert_eq!(v["machineId"], "self");
            assert_eq!(v["deviceName"], "dev-self");
            assert_eq!(v["os"], "windows");
            assert_eq!(v["online"], true);
            assert_eq!(v["self"], true);
            // A peer with no OS serializes os:null and self:false.
            let peer = FleetMachine { machine_id: "p".into(), device_name: "P".into(), os: None, online: false };
            let pv = machine_to_json(&peer, false);
            assert!(pv["os"].is_null());
            assert_eq!(pv["self"], false);
        }

        // Gated: needs tauri's `test` feature (mock_app), Linux/macOS CI only.
        // Drives `fleet_roster` directly rather than the full HTTP server, because
        // `start_api_server`/handlers are pinned to AppState<Wry> while mock_app yields
        // MockRuntime. This still proves the open-core behavior: fabric absent -> self only.
        #[cfg(feature = "integration-tests")]
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn machines_returns_self_only_when_fabric_absent() {
            let app = tauri::test::mock_app();
            let (tx, _rx) = tokio::sync::broadcast::channel(16);
            let state = crate::state::AppState::new(
                tx,
                app.handle().clone(),
                crate::app_config::NetworkConfig::defaults(),
            );
            let self_id = state.instance_id.clone();

            // Fabric child is absent under mock_app -> roster is exactly the self machine.
            let roster = fleet_roster(&state).await;
            assert_eq!(roster.len(), 1);
            assert_eq!(roster[0].machine_id, self_id);
            assert!(roster[0].online);
            assert_eq!(roster[0].os.as_deref(), Some(std::env::consts::OS));

            // machine_to_json marks the self machine.
            let j = machine_to_json(&roster[0], true);
            assert_eq!(j["self"], true);
            assert_eq!(j["machineId"], self_id);
        }

        #[test]
        fn remote_target_without_fabric_is_501_not_installed() {
            // A remote (non-self) machine with the fabric absent must classify as
            // NotInstalled, which the dispatchers render as HTTP 501 "peering not installed".
            let roster = [m("self", Some("windows"), true), m("remote", Some("linux"), true)];
            let res = resolve_fleet_target(None, Some("remote"), None, &roster, "self");
            assert_eq!(classify_fleet_route(res, false), ExecuteRoute::NotInstalled);
            // The exact 501 body the dispatchers return for that route.
            let (status, body) = peering_not_installed();
            assert_eq!(status.as_u16(), 501);
            assert_eq!(body.0["error"], "peering not installed");
        }

        #[test]
        #[allow(non_snake_case)]
        fn fleet_execute_req_deserializes_targetOS_key() {
            // The MCP sidecar / frozen wire contract sends `targetOS` (capital S), not
            // the camelCase-derived `targetOs`. This must deserialize into target_os,
            // otherwise OS-targeted fleet commands silently resolve to Local.
            let req: FleetExecuteReq =
                serde_json::from_str(r#"{"command":"echo hi","targetOS":"macos"}"#).unwrap();
            assert_eq!(req.target_os.as_deref(), Some("macos"));
            // camelCase siblings still work.
            let req2: FleetExecuteReq = serde_json::from_str(
                r#"{"command":"x","machineId":"m","terminalId":"t","timeoutMs":5000}"#,
            )
            .unwrap();
            assert_eq!(req2.machine_id.as_deref(), Some("m"));
            assert_eq!(req2.terminal_id.as_deref(), Some("t"));
            assert_eq!(req2.timeout_ms, Some(5000));
        }
    }
}

#[cfg(test)]
mod create_terminal_req_tests {
    use super::*;

    // Design §12: this codebase has already shipped a silent serde-key misroute once (the
    // Fleet MCP `targetOS` bug), where a field deserialised to None and the feature simply
    // did nothing. `parent_terminal_id` fails exactly that way — the spawn still succeeds and
    // only the edge is missing.

    #[test]
    fn accepts_the_camel_case_wire_name() {
        let r: CreateTerminalReq =
            serde_json::from_str(r#"{"parentTerminalId":"pc-abc"}"#).unwrap();
        assert_eq!(r.parent_terminal_id.as_deref(), Some("pc-abc"));
    }

    #[test]
    fn accepts_the_snake_case_name() {
        let r: CreateTerminalReq =
            serde_json::from_str(r#"{"parent_terminal_id":"pc-abc"}"#).unwrap();
        assert_eq!(r.parent_terminal_id.as_deref(), Some("pc-abc"));
    }

    #[test]
    fn absent_parent_is_none_not_an_error() {
        let r: CreateTerminalReq = serde_json::from_str(r#"{"name":"x"}"#).unwrap();
        assert!(r.parent_terminal_id.is_none());
    }

    #[test]
    fn the_parent_field_does_not_disturb_the_tab_targeting_fields() {
        // The MCP hop sends owningTabId, paneId and direction alongside the new field. A
        // rename or a missing alias here is invisible at the HTTP boundary: the request still
        // deserialises, and the pane just lands in the wrong tab.
        let r: CreateTerminalReq = serde_json::from_str(
            r#"{"owningTabId":"tb-1","paneId":"tm-2","direction":"horizontal","parentTerminalId":"pc-3"}"#,
        )
        .unwrap();
        assert_eq!(r.owning_tab_id.as_deref(), Some("tb-1"));
        assert_eq!(r.pane_id.as_deref(), Some("tm-2"));
        assert_eq!(r.direction.as_deref(), Some("horizontal"));
        assert_eq!(r.parent_terminal_id.as_deref(), Some("pc-3"));
    }
}


/// Prefix-dispatched terminal resolution (design 014 §A3).
#[cfg(test)]
mod classify_terminal_ref_tests {
    use super::{classify_terminal_ref, TerminalRef};
    use axum::http::StatusCode;

    /// A tab id where a terminal is meant — THE reported MCP failure. Before
    /// design 014 this could not even be DETECTED: a renderer-created tab's root
    /// leaf WAS its tab id, so `tb-…` was a legitimate terminal reference for
    /// some panes and meaningless for others, and an agent in a two-pane tab had
    /// no way to say which terminal it meant.
    #[test]
    fn a_tab_id_is_rejected_and_names_the_field_to_use_instead() {
        let err = classify_terminal_ref("tb-4e8d0c2f1").expect_err("a tab id is not a terminal");
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert!(err.1.contains("TAB id"), "must say what it IS: {}", err.1);
        assert!(err.1.contains("owningTabId"), "must name the right field: {}", err.1);
        assert!(err.1.contains("tm-"), "must name the right id space: {}", err.1);
    }

    #[test]
    fn a_pane_id_is_rejected_and_names_the_field_to_use_instead() {
        let err = classify_terminal_ref("pn-4k2j9x1qa").expect_err("a pane id is not a terminal");
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert!(err.1.contains("PANE id"), "{}", err.1);
        assert!(err.1.contains("tm-"), "{}", err.1);
    }

    #[test]
    fn a_leaf_id_classifies_as_the_durable_space() {
        assert_eq!(classify_terminal_ref("tm-9f2c1a4b7").unwrap(), TerminalRef::Leaf);
    }

    #[test]
    fn a_process_id_classifies_as_the_per_run_space() {
        assert_eq!(classify_terminal_ref("pc-abc123def").unwrap(), TerminalRef::Process);
    }

    /// Rejection is by SHAPE, not by liveness: a tab id matching nothing live
    /// must still be told it is a tab id, or the caller retries the same
    /// mistake with no idea why it failed.
    #[test]
    fn a_tab_id_is_rejected_even_when_nothing_is_live() {
        assert_eq!(classify_terminal_ref("tb-anything").unwrap_err().0, StatusCode::BAD_REQUEST);
    }

    /// An id from before the prefixes existed must still route rather than 400 —
    /// rejecting it would break clients holding ids from an older build.
    #[test]
    fn an_unprefixed_legacy_id_is_treated_as_a_process_id() {
        assert_eq!(classify_terminal_ref("legacy-id-0001").unwrap(), TerminalRef::Process);
    }

    /// The prefixes must not leak onto ids that merely start similarly.
    #[test]
    fn the_prefix_rules_are_exact() {
        assert_eq!(classify_terminal_ref("tbx-0000").unwrap(), TerminalRef::Process);
        assert_eq!(classify_terminal_ref("pnx-0000").unwrap(), TerminalRef::Process);
        assert_eq!(classify_terminal_ref("tmx-0000").unwrap(), TerminalRef::Process);
    }
}
