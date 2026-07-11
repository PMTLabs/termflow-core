use crate::app_config::{self, NetworkConfig};
use crate::state::AppState;
use std::net::SocketAddr;
use tauri::State;

#[derive(serde::Serialize)]
pub struct NetworkInterface {
    pub name: String,
    pub label: String,
    pub ip: String,
}

/// Bind octets for the current expose flag.
fn host_octets(expose: bool) -> [u8; 4] {
    if expose {
        [0, 0, 0, 0]
    } else {
        [127, 0, 0, 1]
    }
}

/// A localhost HTTP client with a bounded timeout, so health/probe GETs never hang on
/// a service that accepts the TCP connection but never answers (a blackholed port).
/// Returns None only if the client backend fails to build (effectively never).
pub fn localhost_client(timeout_ms: u64) -> Option<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(timeout_ms))
        .build()
        .ok()
}

/// Who currently owns a localhost port, from this process's point of view (P0b).
#[derive(Debug, PartialEq, Eq)]
pub enum PortOwner {
    /// Nothing answered — safe to bind.
    Free,
    /// Our own running server answered (its /health reported our instance_id).
    OwnedBySelf,
    /// Another instance (or a foreign process) answered — must NOT hijack it.
    OwnedByOther,
}

/// Probe whether `port` on localhost is owned by another running instance of THIS
/// app, by GETting its `/health` and comparing the reported `instanceId` to ours.
///
/// This is the crux of cross-instance conflict detection: `bind_reuseaddr` keeps
/// `SO_REUSEADDR` (required for hot-restart), so a second process's bind would
/// SUCCEED and hijack the port — bind failure cannot be used to detect a conflict.
/// An active probe before binding (and on every health tick) is what surfaces it.
/// A non-responding port is `Free`; a response we can't identify as ours is
/// `OwnedByOther` (someone holds it — never hijack).
pub async fn probe_port_owner(port: u16, own_id: &str) -> PortOwner {
    let url = format!("http://127.0.0.1:{}/health", port);
    let client = match localhost_client(400) {
        Some(c) => c,
        None => return PortOwner::Free,
    };
    let resp = match client.get(&url).send().await {
        Ok(r) => r,
        Err(_) => return PortOwner::Free, // refused / timeout — nobody we can see
    };
    let body: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return PortOwner::OwnedByOther, // someone answered, but not our app
    };
    match body.get("instanceId").and_then(|v| v.as_str()) {
        Some(id) if id == own_id => PortOwner::OwnedBySelf,
        _ => PortOwner::OwnedByOther,
    }
}

/// Decide whether a bind to a probed port may proceed. A foreign owner is a hard
/// conflict (we must not hijack); Free / OwnedBySelf are fine to (re)bind.
pub fn classify_bind(owner: PortOwner) -> Result<(), String> {
    match owner {
        PortOwner::OwnedByOther => {
            Err("Port is already in use by another instance".to_string())
        }
        _ => Ok(()),
    }
}

/// Map a server's reported `/health` identity to `(healthy, conflict)` for a port we
/// expect to own. `reported`: `None` = unreachable; `Some(id)` = reachable, with `id`
/// the instanceId it advertised ("" if it didn't). Used for BOTH the API and MCP
/// health checks so a reachable-but-foreign server reads as a conflict, not healthy.
pub fn classify_health_owner(reported: Option<&str>, our_id: &str) -> (bool, bool) {
    match reported {
        None => (false, false),                    // unreachable → offline
        Some(id) if id == our_id => (true, false), // our own server
        Some(_) => (false, true),                  // another instance owns the port
    }
}

/// Send the shutdown signal to the currently-running API server (if any).
pub(crate) fn stop_running_api(state: &AppState) {
    if let Ok(mut guard) = state.api_shutdown.lock() {
        if let Some(tx) = guard.take() {
            let _ = tx.send(());
        }
    }
}

/// Bind `addr` with `SO_REUSEADDR` set, so a same-port hot-restart can rebind
/// immediately even while the just-stopped server's sockets are still lingering
/// — TIME_WAIT after a graceful close, or an upgraded WebSocket that axum's
/// graceful shutdown never force-closes (it drops the listener at once but waits
/// on in-flight connections before the serve future returns).
///
/// This is the crux of the Windows-only "Port did not free up" failure:
/// `tokio::net::TcpListener::bind` sets `SO_REUSEADDR` ONLY on Unix, so on macOS
/// the same-port rebind just works, but on Windows a fresh *exclusive* bind is
/// rejected with WSAEADDRINUSE (os error 10048) for as long as the prior socket
/// state lingers — far past the retry window below. Building the listener via
/// `TcpSocket` lets us opt into the reuse on every platform (matching Unix).
///
/// IMPORTANT: the INITIAL server bind at app startup (see `lib.rs`) must ALSO use
/// this, not a plain `TcpListener::bind`. On Windows a `SO_REUSEADDR` rebind that
/// collides with a still-lingering *non*-reuse socket fails with WSAEACCES
/// (os error 10013, "forbidden by its access permissions") — so the very first
/// "Save & apply (restart)" on a plain-bound initial socket would error out. With
/// both sockets `SO_REUSEADDR`, they coexist during the handover.
pub(crate) fn bind_reuseaddr(addr: SocketAddr) -> std::io::Result<tokio::net::TcpListener> {
    let socket = if addr.is_ipv4() {
        tokio::net::TcpSocket::new_v4()?
    } else {
        tokio::net::TcpSocket::new_v6()?
    };
    socket.set_reuseaddr(true)?;
    socket.bind(addr)?;
    socket.listen(1024)
}

/// Bind `addr`, retrying briefly while the just-stopped server releases the port
/// (graceful shutdown is near-instant, so this normally succeeds on the 1st-2nd try).
async fn bind_with_retry(addr: SocketAddr, port: u16) -> Result<tokio::net::TcpListener, String> {
    let mut last = String::new();
    for attempt in 1..=15 {
        match bind_reuseaddr(addr) {
            Ok(l) => {
                log::info!("[NET] bound {} (SO_REUSEADDR) on attempt {}", addr, attempt);
                return Ok(l);
            }
            Err(e) => {
                last = e.to_string();
                log::warn!(
                    "[NET] bind {} attempt {}/15 failed despite SO_REUSEADDR: {}",
                    addr, attempt, last
                );
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        }
    }
    Err(format!("Port {} did not free up after restart: {}", port, last))
}

/// (Re)start the Axum API server with the given config.
///
/// Two paths, because the running server holds its own port:
/// - **Same address** (token rotation, expose unchanged, or a save that doesn't
///   change the port): the old server MUST be stopped first to free the port,
///   then we bind (with a short retry while it releases). The brief no-server
///   window is our own restart — acceptable.
/// - **Different address** (port change, or expose toggle that flips the host):
///   bind the new listener FIRST so a busy target port returns an error with the
///   old server still running — never a "stopped old, failed new, no server" gap.
///
/// `state.network` still holds the OLD config here (it's updated only after a
/// successful restart), so it gives us the currently-bound address.
///
/// Callers must hold `state.network_op_lock` so two restarts can't interleave
/// (which would race the single `api_shutdown` slot).
pub async fn restart_api_server(state: AppState, cfg: &NetworkConfig) -> Result<(), String> {
    let addr = SocketAddr::from((host_octets(cfg.expose_on_network), cfg.api_port));
    // P0b: never (re)bind a port another instance owns — we'd hijack it via
    // SO_REUSEADDR. Our own running server probes as OwnedBySelf, so a same-port
    // hot-restart is unaffected; only a port CHANGE onto a foreign-owned port errors.
    classify_bind(probe_port_owner(cfg.api_port, &state.instance_id).await)?;
    let old_addr = {
        let net = state.network.read();
        SocketAddr::from((host_octets(net.expose_on_network), net.api_port))
    };
    log::info!(
        "[NET] restart_api_server: target={} old={} same_addr={}",
        addr, old_addr, addr == old_addr
    );

    let listener = if addr == old_addr {
        // Same port/host — free it first, then rebind (SO_REUSEADDR via bind_with_retry).
        stop_running_api(&state);
        bind_with_retry(addr, cfg.api_port).await?
    } else {
        // New port/host — bind first (old server untouched on failure), then stop old.
        // SO_REUSEADDR lets the new host bind even when it overlaps the old one
        // (e.g. an expose toggle 127.0.0.1 <-> 0.0.0.0 on the same port).
        let l = bind_reuseaddr(addr)
            .map_err(|e| format!("Port {} is unavailable: {}", cfg.api_port, e))?;
        stop_running_api(&state);
        l
    };

    let (tx, rx) = tokio::sync::oneshot::channel();
    if let Ok(mut guard) = state.api_shutdown.lock() {
        *guard = Some(tx);
    }

    let expose = cfg.expose_on_network;
    let srv_state = state.clone();
    tauri::async_runtime::spawn(async move {
        crate::api_server::start_api_server(srv_state, listener, expose, rx).await;
    });
    Ok(())
}

#[tauri::command]
pub async fn get_network_config(state: State<'_, AppState>) -> Result<NetworkConfig, String> {
    Ok(state.network.read().clone())
}

#[tauri::command]
pub async fn list_network_interfaces() -> Result<Vec<NetworkInterface>, String> {
    let mut out = Vec::new();
    if let Ok(ifaces) = if_addrs::get_if_addrs() {
        for i in ifaces {
            if let std::net::IpAddr::V4(v4) = i.ip() {
                let label = if i.is_loopback() {
                    "loopback".to_string()
                } else {
                    i.name.clone()
                };
                out.push(NetworkInterface {
                    name: i.name.clone(),
                    label,
                    ip: v4.to_string(),
                });
            }
        }
    }
    // Loopback last so real LAN addresses lead.
    out.sort_by_key(|n| n.ip.starts_with("127."));
    Ok(out)
}

#[tauri::command]
pub async fn set_network_config(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    api_port: u16,
    mcp_port: u16,
    expose_on_network: bool,
) -> Result<NetworkConfig, String> {
    // Serialize with any other in-flight network mutation.
    let _op = state.network_op_lock.lock().await;

    let old = state.network.read().clone();
    let mut cfg = old.clone();
    cfg.api_port = api_port;
    cfg.mcp_port = mcp_port;
    cfg.expose_on_network = expose_on_network;

    // Restart API first (this validates the port); only then publish + touch MCP.
    restart_api_server((*state).clone(), &cfg).await?;
    // Publish the new config BEFORE the (possibly multi-second) respawn so the live
    // API auth gate and status reads see the new values immediately rather than the
    // stale ones during sidecar startup (matches rotate_auth_token's ordering).
    *state.network.write() = cfg.clone();
    // Only respawn the sidecar when its env actually changed — a no-op apply
    // shouldn't drop every client's in-memory MCP session.
    if crate::mcp_respawn_needed(&old, &cfg) {
        crate::respawn_mcp(app.clone(), (*state).clone(), &cfg).await;
    }
    // The fabric receives the core API URL + token via env at spawn only, so an api-port
    // change leaves it calling the core on a stale port (M6). Respawn it in lockstep.
    if crate::fabric_manager::fabric_respawn_needed(&old, &cfg) {
        crate::fabric_manager::respawn_fabric(app.clone(), (*state).clone()).await;
    }

    app_config::save(&app, &cfg)?;
    Ok(cfg)
}

#[tauri::command]
pub async fn rotate_auth_token(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<NetworkConfig, String> {
    let _op = state.network_op_lock.lock().await;

    let old = state.network.read().clone();
    let mut cfg = old.clone();
    cfg.auth_token = app_config::generate_token();

    // Publish the new token FIRST so the live API auth gate (see
    // `start_api_server`) uses it immediately. We deliberately DON'T restart the
    // Axum server here: the port/host are unchanged, the gate reads the token
    // from shared state, and restarting would drop every UI connection and race
    // the same-port rebind (the Windows "Port did not free up" failure). Only a
    // networked sidecar needs a respawn, since it receives the token via env at
    // spawn time; in localhost mode the sidecar's token env is empty, so the
    // rotation is a no-op for it and respawning would needlessly drop every MCP
    // session (mcp_respawn_needed encodes exactly that).
    *state.network.write() = cfg.clone();
    if crate::mcp_respawn_needed(&old, &cfg) {
        crate::respawn_mcp(app.clone(), (*state).clone(), &cfg).await;
    }
    // Unlike the MCP sidecar (token only matters in networked mode), the fabric ALWAYS
    // authenticates to the core with this token, so a rotation always leaves it stale (M6).
    if crate::fabric_manager::fabric_respawn_needed(&old, &cfg) {
        crate::fabric_manager::respawn_fabric(app.clone(), (*state).clone()).await;
    }
    app_config::save(&app, &cfg)?;
    Ok(cfg)
}

/// Which server(s) a stop/start action targets. Parsed from the renderer's string
/// arg; anything other than "api"/"mcp" (incl. "all" or empty) means both.
fn targets(target: &str) -> (bool, bool) {
    match target {
        "api" => (true, false),
        "mcp" => (false, true),
        _ => (true, true), // "all" / default
    }
}

/// Stop the selected server(s) (API and/or MCP). The app's own terminals are
/// unaffected (they use Tauri IPC, not the HTTP API), but external/agent access
/// goes offline — the window status dot reflects this via the health check turning
/// unhealthy. Config is left untouched; `start_servers` brings them back with it.
#[tauri::command]
pub async fn stop_servers(state: State<'_, AppState>, target: String) -> Result<(), String> {
    // Serialize with restart/apply so we can't race the api_shutdown slot.
    let _op = state.network_op_lock.lock().await;
    let (api, mcp) = targets(&target);
    if api {
        stop_running_api(&state);
    }
    if mcp {
        crate::shutdown_mcp_server(&state);
    }
    log::info!("[NET] stop_servers: target={} (api={} mcp={})", target, api, mcp);
    Ok(())
}

/// (Re)start the selected server(s) using the current persisted config. Binds the
/// API listener via the SO_REUSEADDR path so a recently-stopped port rebinds
/// cleanly, then respawns the MCP sidecar.
#[tauri::command]
pub async fn start_servers(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    target: String,
) -> Result<(), String> {
    let _op = state.network_op_lock.lock().await;
    let (api, mcp) = targets(&target);
    let cfg = state.network.read().clone();
    if api {
        restart_api_server((*state).clone(), &cfg).await?;
    }
    if mcp {
        crate::respawn_mcp(app.clone(), (*state).clone(), &cfg).await;
    }
    log::info!("[NET] start_servers: target={} (api={} mcp={})", target, api, mcp);
    Ok(())
}

#[cfg(test)]
mod port_owner_tests {
    use super::*;

    #[tokio::test]
    async fn probe_unbound_port_is_free() {
        // Nothing listens on this high port → Free, so a fresh bind proceeds.
        assert_eq!(probe_port_owner(59999, "self-id").await, PortOwner::Free);
    }

    #[test]
    fn owned_by_other_is_conflict_error() {
        assert!(classify_bind(PortOwner::OwnedByOther)
            .unwrap_err()
            .contains("another instance"));
    }

    #[test]
    fn free_and_self_are_bindable() {
        assert!(classify_bind(PortOwner::Free).is_ok());
        assert!(classify_bind(PortOwner::OwnedBySelf).is_ok());
    }

    #[test]
    fn health_owner_classification() {
        // unreachable → offline, not a conflict
        assert_eq!(classify_health_owner(None, "me"), (false, false));
        // our own server → healthy
        assert_eq!(classify_health_owner(Some("me"), "me"), (true, false));
        // another instance answered on our port → conflict
        assert_eq!(classify_health_owner(Some("other"), "me"), (false, true));
        // reachable but no identity (foreign / pre-identity build) → conflict
        assert_eq!(classify_health_owner(Some(""), "me"), (false, true));
    }
}
