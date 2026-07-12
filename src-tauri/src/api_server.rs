use axum::{
    extract::{Path, State},
    response::IntoResponse,
    routing::{get, post, delete, put},
    Json, Router,
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    extract::Request,
    http::StatusCode,
    http::header::AUTHORIZATION,
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
        // System info endpoints
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
        // Auth gate: enforced ONLY when exposed on the network. Localhost mode
        // stays open (backward compatible). Added before CORS so CORS wraps it.
        .layer(middleware::from_fn(move |req: Request, next: Next| {
            let auth_net = auth_net.clone();
            async move {
                if !expose {
                    return next.run(req).await;
                }
                let path = req.uri().path().to_string();
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
        .layer(CorsLayer::permissive())
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
    // Carry this process's identity so a second instance probing this port can tell
    // "this is mine" from "another instance owns it" (P0b conflict detection).
    Json(json!({
        "status": "ok",
        "app": "auto-terminal",
        "instanceId": state.instance_id,
    }))
}

async fn list_terminals(State(state): State<AppState>) -> impl IntoResponse {
    let terminals: Vec<_> = state.terminals.iter().map(|entry| {
        let t = entry.value();
        json!({
            "id": t.id,
            "processId": t.id,
            // Stable renderer id: `tm-` for a split pane, `tb-` for a root/solo
            // pane (where it equals the tabId). This is the UI-level terminal id.
            "terminalId": t.tab_id,
            "name": t.name,
            "profile": t.shell,
            "status": "running",
            "pid": t.pid,
            "createdAt": t.created_at,
            "mode": "ui",
            "tabId": t.tab_id
        })
    }).collect();
    Json(json!({ "terminals": terminals }))
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
    #[serde(alias = "paneId")]
    pane_id: Option<String>,
    direction: Option<String>,
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

    match crate::pty_manager::spawn_terminal(
        state.clone(),
        cols,
        rows,
        shell_path,
        shell_args,
        shell_cwd,
        shell_name.clone(),
        terminal_name.clone()
    ) {
        Ok(id) => {
            // Resolve or generate a proper tb- prefixed tab ID
            let tab_id = match payload.tab_id.as_ref() {
                Some(tid) if !tid.is_empty() => {
                    if tid.starts_with("tb-") {
                        tid.clone()
                    } else {
                        let raw_uuid = uuid::Uuid::new_v4().to_string().replace("-", "");
                        format!("tb-{}", &raw_uuid[..9])
                    }
                }
                _ => {
                    let raw_uuid = uuid::Uuid::new_v4().to_string().replace("-", "");
                    format!("tb-{}", &raw_uuid[..9])
                }
            };

            // Notify the UI to create a tab for this new terminal. We BROADCAST (a
            // bare emit_to is documented as not reaching the JS listener here — see
            // commands.rs resolve_tab_drop) and carry the routing target in the
            // payload: every window receives it, but only the one whose label equals
            // `targetWindow` acts on it (the same pattern as app:close-requested).
            let target_window = state.resolve_active_window_label();
            if let Err(e) = state.app_handle.emit("api:createTerminalTab", serde_json::json!({
                "name": terminal_name,
                "profile": shell_name,
                "terminalId": id, // Pass the actual backend ID
                "tabId": Some(tab_id.clone()),
                "paneId": payload.pane_id,
                "direction": payload.direction,
                "targetWindow": target_window
            })) {
                log::warn!("Failed to emit api:createTerminalTab: {}", e);
            }

            if let Some(mut entry) = state.terminals.get_mut(&id) {
                entry.tab_id = Some(tab_id);
            }

            if let Some(t) = state.terminals.get(&id) {
                let t = t.value();
                (StatusCode::OK, Json(json!({
                    "id": t.id,
                    "processId": t.id,
                    // Stable renderer id (`tm-` split / `tb-` root) — the UI terminal id.
                    "terminalId": t.tab_id,
                    "name": t.name,
                    "profile": t.shell,
                    "status": "running",
                    "pid": t.pid,
                    "createdAt": t.created_at,
                    "mode": "ui",
                    "tabId": t.tab_id
                }))).into_response()
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
    // Take the pid first (guard drops at end of statement, before cleanup).
    let Some(pid) = state.terminals.get(&id).map(|t| t.pid) else {
        return Json(json!({ "error": "Terminal not found" }));
    };
    // Parity with the UI close path: actually kill the shell, then clean up
    // every map (the old handler leaked terminal_history and left the shell
    // process running).
    crate::pty_manager::kill_process_tree(pid);
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
    log::info!("Resize request for terminal {}: {}x{}", id, payload.cols, payload.rows);

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
    let tab_id = state
        .terminals
        .get(terminal_id)
        .and_then(|t| t.tab_id.clone());
    if let Err(e) = state.app_handle.emit(
        "terminal:external-activity",
        json!({ "terminalId": terminal_id, "tabId": tab_id }),
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
    if let Some(terminal) = state.terminals.get(&id) {
        let t = terminal.value();
        (StatusCode::OK, Json(json!({
            "id": t.id,
            "processId": t.id,
            // Stable renderer id (`tm-` split / `tb-` root) — the UI terminal id.
            "terminalId": t.tab_id,
            "name": t.name,
            "profile": t.shell,
            "status": "running",
            "pid": t.pid,
            "createdAt": t.created_at,
            "mode": "default",
            "tabId": t.tab_id
        })))
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

    if payload.prompt.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "Prompt must be a non-empty string".to_string()));
    }

    // Clone the writer Arc, dropping the DashMap shard guard before the
    // send/probe sleeps below (up to ~48 s total). Holding the shard guard
    // across those `.await`s blocked a concurrent create/close of any terminal
    // whose id hashes to the same shard for the full sleep duration.
    let writer_mutex = match state.shell_writer_channels.get(id) {
        Some(r) => r.clone(),
        None => return Err((StatusCode::NOT_FOUND, "Terminal not found".to_string())),
    };
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

        // Send the prompt as a bracketed paste (CSI 200~ … 201~) so any newlines
        // embedded in the prompt are inserted as literal multi-line input rather
        // than being treated as Enter and submitting each line as a separate
        // command. The single submit is the end_indicator written after this.
        let inner = payload.prompt.replace("\r\n", "\r").replace('\n', "\r");
        let normalized_prompt = format!("\x1b[200~{}\x1b[201~", inner);

        // Write prompt - in scope to drop lock
        {
            let mut writer = writer_mutex
                .lock()
                .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "terminal writer mutex poisoned".to_string()))?;
            writer
                .write_all(normalized_prompt.as_bytes())
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            let _ = writer.flush();
        }

        // Brief delay to allow the CLI tool to process the prompt text
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
        // Send Focus In sequence just in case the CLI tool uses Focus Tracking (\x1b[?1004h)
        // and is ignoring input because it thinks it's blurred.
        {
            let mut writer = writer_mutex
                .lock()
                .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "terminal writer mutex poisoned".to_string()))?;
            let _ = writer.write_all(b"\x1b[I");
            let _ = writer.flush();
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
                {
                    let mut writer = match writer_mutex.lock() {
                        Ok(w) => w,
                        Err(_) => {
                            log::warn!("send_prompt_to_terminal probe: writer mutex poisoned, aborting probe");
                            break;
                        }
                    };
                    log::debug!("  Attempting submission: {} (bytes: {:?})", desc, seq.as_bytes());
                    if let Err(e) = writer.write_all(seq.as_bytes()) {
                        log::warn!("    Failed to write sequence: {}", e);
                        break;
                    }
                    let _ = writer.flush();
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
            // Write end indicator immediately
            {
                let mut writer = writer_mutex
                    .lock()
                    .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "terminal writer mutex poisoned".to_string()))?;
                writer
                    .write_all(end_indicator.as_bytes())
                    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
                let _ = writer.flush();
            }

            return Ok(json!({
                "success": true,
                "prompt": payload.prompt,
                "cliType": payload.cli_type
            }));
        }

        // Standard execution for other CLI types - in scope to drop lock
        {
            let mut writer = writer_mutex
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
                        let cut = acc.len() - 4096;
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
        _ => {
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
            let new_id = match crate::pty_manager::spawn_terminal(
                state.clone(),
                80,
                24,
                shell_path,
                shell_args,
                shell_cwd,
                shell_name.clone(),
                terminal_name.clone(),
            ) {
                Ok(id) => id,
                Err(e) => {
                    return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e })))
                        .into_response()
                }
            };
            // Make the fleet terminal VISIBLE as a labeled UI tab, mirroring
            // create_terminal. The backend (`pc-`) id stays the map key; the
            // `tb-` tab id is a cosmetic renderer alias.
            let raw_uuid = uuid::Uuid::new_v4().to_string().replace('-', "");
            let tab_id = format!("tb-{}", &raw_uuid[..9]);
            let target_window = state.resolve_active_window_label();
            if let Err(e) = state.app_handle.emit(
                "api:createTerminalTab",
                serde_json::json!({
                    "name": terminal_name,
                    "profile": shell_name,
                    "terminalId": new_id,
                    "tabId": Some(tab_id.clone()),
                    "paneId": serde_json::Value::Null,
                    "direction": serde_json::Value::Null,
                    "targetWindow": target_window,
                }),
            ) {
                log::warn!("Failed to emit api:createTerminalTab for fleet terminal: {}", e);
            }
            if let Some(mut entry) = state.terminals.get_mut(&new_id) {
                entry.tab_id = Some(tab_id);
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
    let screen = state
        .screen_snapshot(&terminal_id)
        .map(|b| String::from_utf8_lossy(&b).to_string())
        .unwrap_or_default();

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
    if body.prompt.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Prompt must be a non-empty string" })));
    }
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

    let ids = dedup_preserve_order(&body.terminal_ids);
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

    let ids = dedup_preserve_order(&body.terminal_ids);
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
                                // Clone the Arc, dropping the shard guard before locking.
                                let writer_arc = state
                                    .shell_writer_channels
                                    .get(terminal_id)
                                    .map(|r| r.clone());
                                let write_result: Result<(), String> = match writer_arc {
                                    Some(writer_mutex) => match writer_mutex.lock() {
                                        Ok(mut writer) => writer
                                            .write_all(data.as_bytes())
                                            .map_err(|e| e.to_string()),
                                        Err(_) => Err("writer mutex poisoned".to_string()),
                                    },
                                    None => Err("terminal not found".to_string()),
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
}
