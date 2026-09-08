use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use serde_json::json;
use crate::state::{AppState, ChannelPayload};
use super::exec::{
    build_sentinel_command, classify_shell_kind, send_prompt_to_terminal, sentinel_exit_code,
    ExecutePromptReq, ShellKind,
};
use super::terminals::mint_renderer_id;

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
pub(crate) fn alias_os(raw: &str) -> String {
    match raw.trim().to_lowercase().as_str() {
        "osx" | "darwin" | "macos" => "macos".to_string(),
        "win" | "win32" | "windows" => "windows".to_string(),
        other => other.to_string(),
    }
}

/// Pure resolver. Precedence: `terminalId` → `machineId` → `targetOS` → local.
/// `self_machine_id` is this instance's id; a match on it collapses to `Local`.
pub(crate) fn resolve_fleet_target(
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
pub(crate) fn classify_fleet_route(res: FleetResolution, fabric_installed: bool) -> ExecuteRoute {
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
pub(crate) fn peer_value_to_machine(p: &serde_json::Value) -> Option<FleetMachine> {
    let machine_id = p.get("device_id").and_then(|v| v.as_str())?.to_string();
    Some(FleetMachine {
        machine_id,
        device_name: p.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        os: p.get("os").and_then(|v| v.as_str()).map(|s| s.to_string()),
        online: p.get("online").and_then(|v| v.as_bool()).unwrap_or(false),
    })
}

/// Serialize a machine for the `/api/fleet/machines` roster, tagging `self`.
pub(crate) fn machine_to_json(m: &FleetMachine, is_self: bool) -> serde_json::Value {
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
pub(crate) fn self_hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "this-machine".to_string())
}

/// Build the fleet roster: this instance (always online) plus fabric peers when the
/// fabric child is present. Never errors — a fabric read failure yields self only.
pub(crate) async fn fleet_roster<R: tauri::Runtime>(state: &AppState<R>) -> Vec<FleetMachine> {
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
pub(crate) async fn fleet_machines(State(state): State<AppState>) -> impl IntoResponse {
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
pub(crate) async fn fleet_terminals(State(state): State<AppState>) -> impl IntoResponse {
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
pub(crate) struct FleetExecuteReq {
    command: String,
    #[serde(rename = "targetOS")]
    target_os: Option<String>,
    machine_id: Option<String>,
    terminal_id: Option<String>,
    timeout_ms: Option<u64>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FleetScreenReq {
    machine_id: Option<String>,
    terminal_id: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FleetCloseReq {
    machine_id: Option<String>,
    terminal_id: String,
}

/// Clamp a requested fleet timeout to `[1000, 3_600_000]` ms, defaulting to 60 s.
/// Mirrors the responder-side clamp so both ends agree.
pub(crate) fn clamp_fleet_timeout(ms: Option<u64>) -> u64 {
    ms.unwrap_or(60_000).clamp(1_000, 3_600_000)
}

/// Run a command on THIS machine by proxying to the local responder endpoint
/// `POST /api/fleet/local-run` over loopback (using this instance's own api port +
/// token). Returns the responder JSON `{ terminalId, done, exitCode, screen }`.
pub(crate) async fn local_fleet_run(
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
pub(crate) fn map_fabric_fleet_error(
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
pub(crate) fn peering_not_installed() -> (StatusCode, Json<serde_json::Value>) {
    (StatusCode::NOT_IMPLEMENTED, Json(json!({ "error": "peering not installed" })))
}

/// POST /api/fleet/execute — resolve target, then dispatch Local (loopback local-run)
/// or Remote (fabric `POST /fleet/exec`). Ambiguous OS → 409, unmatched OS → 404,
/// remote-with-no-fabric → 501. Response: `{ machineId, terminalId, deviceName, done,
/// exitCode, screen }`.
pub(crate) async fn fleet_execute(
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
pub(crate) async fn fleet_screen(
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
pub(crate) async fn fleet_close(
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


#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FleetLocalRunReq {
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
pub(crate) async fn watch_for_sentinel(
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
pub(crate) async fn fleet_local_run(
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
    let terminal_id = match payload.terminal_id.as_ref().map(|t| state.resolve_ref(t)) {
        // Normalised first: a fleet caller naming a terminal by the DURABLE `tm-`
        // id we reported to it would otherwise miss the `pc-`-keyed map and take
        // the not-found arm below (design 014 §A3).
        Some(tid) if state.terminals.contains_key(&tid) => tid,
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
            // A SEPARATE tm- leaf. Design 011 let this path use its own tb- as
            // its leaf, which was safe then because it minted the id itself. Design
            // 014 A1 is stricter: EVERY live terminal carries a tm- leaf, so a
            // field labelled terminal never shows a tab id. Reusing one id for
            // tab, leaf and owner is the collapse this design removes.
            let fleet_leaf_id = mint_renderer_id("tm");
            // Routed exactly like every other create (plan 019): a fleet terminal
            // spawned in-process would block Offload & Close for as long as it lived.
            // Its identity is UNCHANGED — it keeps the `tb-*` it minted itself as
            // both owner and leaf, which design 011 §3 blesses precisely because it
            // minted it ("no create may take a root leaf it did not itself mint").
            let new_id = match crate::commands::spawn_routed(
                &state,
                crate::commands::SpawnRequest {
                    leaf_id: fleet_leaf_id.clone(),
                    session_key: None,
                    claim_token: None,
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
                    "rendererTerminalId": fleet_leaf_id.clone(),
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



#[cfg(test)]
mod tests {
    use super::*;

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
