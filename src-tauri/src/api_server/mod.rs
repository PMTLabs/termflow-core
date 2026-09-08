use axum::{
    extract::Request,
    http::header::{AUTHORIZATION, HOST, ORIGIN},
    http::StatusCode,
    middleware::{self, Next},
    response::IntoResponse,
    routing::{delete, get, post, put},
    Router,
};
use tokio::net::TcpListener;
use crate::state::AppState;
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

mod auth;
mod capture;
mod exec;
mod fleet;
mod profiles;
mod system;
mod terminals;
mod ws;

use auth::{auth_required, cors_layer, ct_eq, generate_token_handler, origin_allowed, route_always_requires_token};
use capture::{
    capture_backend, capture_frontend, capture_terminal_content, compare_captures, get_tmux_status,
    list_captures, resize_with_reflow, start_test_capture, stop_test_capture,
};
use exec::{batch_execute_prompt, batch_write_terminal, execute_prompt};
use fleet::{fleet_close, fleet_execute, fleet_local_run, fleet_machines, fleet_screen, fleet_terminals};
use profiles::{create_profile, delete_profile, get_profile_by_id, list_profiles, set_default_profile, update_profile};
use system::{
    get_active_processes, get_process_metrics, get_system_info, get_system_metrics, hotswap_arm,
    hotswap_disarm,
};
use terminals::{
    create_terminal, delete_terminal, get_terminal, get_terminal_full_scrollback, get_terminal_output,
    get_terminal_screen, get_terminal_size, get_terminal_snapshot, health_check, list_terminals,
    reset_terminal, resize_terminal, write_terminal,
};
use ws::ws_handler;

// `crate::api_server::get_cli_pattern` is called externally from `automation_engine::loops`;
// this keeps that path resolving after the move to `exec.rs`.
pub(crate) use exec::get_cli_pattern;

// These three were `pub fn`/`pub enum` directly in `api_server.rs` (part of the crate's
// public surface via `pub mod api_server` in lib.rs), not because anything in-tree calls
// them, but so `crate::api_server::X` keeps resolving for any future external caller.
// Re-exported here to preserve that surface now that `terminals` is a private submodule.
pub use terminals::{classify_terminal_ref, resolve_terminal_ref, TerminalRef};

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
        .route("/api/terminals/:id/screen", get(get_terminal_screen))
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



#[cfg(test)]
mod tests {
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


    /// The `.route(...)` chain in `start_api_server`, sliced from `Router::new()` to the first
    /// `.layer(` — the auth middleware, and the first link in that chain that is not a route.
    ///
    /// Source-derived for the same reason as `get_terminal_screen_body` above: the router is built
    /// inline inside `start_api_server`, which wants an `AppState<Wry>` and an already-bound
    /// listener, and this test binary can produce neither. Nothing in-process can build the real
    /// router and ask it what it answers, so what it was BUILT FROM is read instead.
    ///
    /// There was no existing precedent for asserting a registration.
    /// `test_batch_routes_coexist_with_param_routes` builds its OWN replica router — that proves
    /// matchit tolerates those paths side by side, and would survive any deletion from the real
    /// chain. So this follows the wiring-from-source shape `canvas_endpoints.rs` established
    /// instead. The needle is exact call text, which a rustfmt reflow would break — loudly, which
    /// is the failure direction worth having.
    fn router_route_table() -> String {
        let source =
            crate::automation_engine::test_host::strip_comments(include_str!("mod.rs"));
        let code = &source[..source.find("#[cfg(test)]").expect("the tests must follow the code")];
        let start = code
            .find("Router::new()")
            .expect("`Router::new()` not found - this guard must fail loudly, not pass vacuously");
        let rest = &code[start..];
        let end = rest.find(".layer(").expect("the route chain must end at the first middleware");
        let table = rest[..end].to_string();
        // Diagnostic, not detective: a caller asking "is route X here?" cannot pass on a slice
        // that stopped early — `contains` just goes false — but it would report a MOVED slice as
        // a DELETED route and send the next reader to the wrong file. `/ws` is the last route
        // before the auth layer, so a slice holding it holds the whole chain.
        assert!(
            table.contains(".route(\"/ws\", get(ws_handler))"),
            "the route-chain slice stopped short of the last route - the chain moved:\n{table}"
        );
        table
    }

    /// `GET /api/terminals/:id/screen` must be REGISTERED, not merely implemented.
    ///
    /// The two tests above pin what the response body carries, that the handler goes through the
    /// helper that carries it, and what it reads the text from - and ALL of that survives deleting
    /// the `.route(...)` line, because both read source text rather than exercising the router. Nothing else in the crate notices either — the
    /// route has no in-tree caller, so an unrouted handler costs a `dead_code` warning at worst —
    /// and the one client, the rule editor's terminal hover card, turns the resulting 404 into a
    /// silent “Reading its screen…” that never resolves rather than an error anyone sees.
    #[test]
    fn the_screen_route_is_registered_as_a_get() {
        assert!(
            router_route_table()
                .contains(".route(\"/api/terminals/:id/screen\", get(get_terminal_screen))"),
            "GET /api/terminals/:id/screen must be on the router - a handler that exists is not \
             the same as a handler that is reachable"
        );
    }


}
