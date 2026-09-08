//! Lifecycle for the `termflow-fabric` peering sidecar.
//!
//! The fabric is spawned by binary name only (same machinery as the MCP
//! sidecar). This open-core repo has ZERO build dependency on it: if the binary
//! is absent, [`start_fabric`] returns `Err` and the caller treats that as
//! "peering not installed" (non-fatal). No fabric type ever crosses into this
//! crate — the boundary is the loopback control-API wire protocol (see
//! `docs/plan/008`), added in later tasks.

use std::path::Path;
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::ShellExt;

use crate::app_config::NetworkConfig;
use crate::state::AppState;

/// The fabric's peer-to-peer listener port (the socket remote peers connect to).
/// Distinct from the loopback control port (`fabric_control_port`, core↔fabric).
pub const FABRIC_PEER_PORT: u16 = 8790;

/// Environment handed to the `termflow-fabric` sidecar, derived from the current
/// network config plus the resolved control/peer ports and data dir.
///
/// **Unlike the MCP sidecar**, the core token is passed to the fabric regardless
/// of `expose_on_network`: the fabric must call the local API even when the API
/// is loopback-only, and it is a trusted local child (same host, spawned by us).
pub fn fabric_env(
    cfg: &NetworkConfig,
    control_port: u16,
    peer_port: u16,
    data_dir: &Path,
    owner_id: &str,
) -> Vec<(String, String)> {
    vec![
        (
            "TERMFLOW_FABRIC_CONTROL_PORT".into(),
            control_port.to_string(),
        ),
        ("TERMFLOW_FABRIC_PEER_PORT".into(), peer_port.to_string()),
        // This app instance's id; the fabric echoes it in `/health` so we can verify we
        // are talking to OUR fabric and never drive another instance's (review H6).
        ("TERMFLOW_FABRIC_OWNER_ID".into(), owner_id.to_string()),
        (
            "TERMFLOW_CORE_API_URL".into(),
            format!("http://localhost:{}", cfg.api_port),
        ),
        ("TERMFLOW_CORE_TOKEN".into(), cfg.auth_token.clone()),
        // Tie the sidecar's lifetime to this app process: if the app is killed
        // abruptly (Ctrl+C in `tauri dev`) the graceful RunEvent::Exit shutdown
        // never runs, so the fabric self-exits once this PID is gone.
        (
            "TERMFLOW_FABRIC_PARENT_PID".into(),
            std::process::id().to_string(),
        ),
        (
            "TERMFLOW_FABRIC_DATA_DIR".into(),
            data_dir.to_string_lossy().into_owned(),
        ),
    ]
}

/// Whether a network-config change alters the env the fabric consumes at spawn, so it must
/// be respawned to pick it up (review M6). The fabric's `TERMFLOW_CORE_API_URL` derives from
/// `api_port`, and it ALWAYS receives `TERMFLOW_CORE_TOKEN` (unlike the MCP sidecar, which
/// only gets it in networked mode — see `fabric_env`); `mcp_port`/`expose_on_network` don't
/// reach the fabric.
pub fn fabric_respawn_needed(old: &NetworkConfig, new: &NetworkConfig) -> bool {
    old.api_port != new.api_port || old.auth_token != new.auth_token
}

/// Per-instance fabric data directory (identity keypair, trusted-peer registry).
/// Dev/prod isolated so a `tauri dev` session never reads a production install's
/// keys and vice-versa. Best-effort created; absence is not fatal here.
fn fabric_data_dir(app: &AppHandle) -> std::path::PathBuf {
    use tauri::Manager;
    let base = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    let name = if crate::app_config::is_dev() {
        "fabric.dev"
    } else {
        "fabric"
    };
    let dir = base.join(name);
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Poll for a report without delaying the event bridge.  Old fabric binaries do
/// not self-report a build and are deliberately accepted as `Unverified`.
async fn wait_for_fabric_health(control_port: u16, owner: &str, expected_build: &str) -> crate::mcp_sidecar::SidecarAcceptance {
    // 500ms cadence; the budget covers first-run latency (Ed25519 keygen + OS keychain
    // access, which on Windows can block on a Credential Manager prompt) so the "healthy"
    // log line still fires on a slow cold start rather than a spurious failure warning.
    const HEALTH_ATTEMPTS: u32 = 40; // 40 × 500ms ≈ 20s
    wait_for_fabric_health_within(control_port, owner, expected_build, HEALTH_ATTEMPTS).await
}

/// Split out only so a test can exhaust the budget without waiting the real
/// ~20 s; production always passes the full budget.
async fn wait_for_fabric_health_within(
    control_port: u16,
    owner: &str,
    expected_build: &str,
    attempts: u32,
) -> crate::mcp_sidecar::SidecarAcceptance {
    // Bounded-timeout client so an unresponsive port can't stall each attempt for the OS default.
    let client = crate::network_commands::localhost_client(1500);
    for attempt in 1..=attempts {
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
        let url = format!("http://127.0.0.1:{}/health", control_port);
        let result = match &client {
            Some(c) => c.get(&url).send().await,
            None => reqwest::get(&url).await,
        };
        match result {
            Ok(resp) if resp.status().is_success() => {
                let health: serde_json::Value = resp.json().await.unwrap_or_default();
                let observed_owner = health.get("owner_id").and_then(|v| v.as_str());
                let observed_build = health.get("build_id").and_then(|v| v.as_str()).filter(|s| !s.is_empty());
                match crate::mcp_sidecar::classify_sidecar_report(observed_owner, owner, observed_build, Some(expected_build)) {
                    Some(result) => return result,
                    None => log::debug!("[FABRIC] health attempt {attempt} has no owner id yet"),
                }
            }
            Ok(resp) => log::debug!(
                "[FABRIC] Health check attempt {} returned status: {}",
                attempt,
                resp.status()
            ),
            Err(e) => log::debug!("[FABRIC] Health check attempt {} failed: {}", attempt, e),
        }
    }
    // Exhausting the budget means we heard NOTHING — which is exactly what the
    // cadence comment above predicts on a first run that blocks on a Credential
    // Manager prompt. Rejected stops our own fabric child, so returning it here
    // would kill peering in the one scenario that budget was written for.
    log::warn!(
        "[FABRIC] Fabric health did not answer in {} attempts — continuing unverified",
        attempts
    );
    crate::mcp_sidecar::SidecarAcceptance::Unverified
}

/// Spawn the `termflow-fabric` sidecar. On spawn failure (binary absent / not
/// bundled) this logs and returns `Err` — the caller treats that as "peering not
/// installed" and continues; the rest of the app is unaffected.
///
/// Mirrors `start_mcp_sidecar` in `lib.rs`: resolve the sidecar by name, apply
/// [`fabric_env`], spawn, store the child in `state.fabric_process`, drain the
/// event stream, then best-effort health-poll the loopback control port.
pub async fn start_fabric(app: AppHandle, state: AppState) -> Result<(), String> {
    log::info!("[FABRIC] Starting termflow-fabric sidecar...");

    let control_port = state.fabric_control_port;
    let data_dir = fabric_data_dir(&app);
    let mut cfg = state.network.read().clone();
    // `TERMFLOW_CORE_API_URL` must name the port we ACTUALLY bound, not the one that was
    // configured. When a sibling instance holds the configured port we walk forward and
    // serve elsewhere — and the sidecar was still being pointed at the configured number,
    // i.e. at the OTHER app's core API, carrying OUR token. The boot path already patched
    // the MCP sidecar this way (`lib.rs`, "Same for the fabric and the renderer"); the
    // fabric and the renderer were the two that never got it.
    //
    // `None` REFUSES rather than falling back to the configured port: with no API of our
    // own, that port is exactly where a sibling is listening, so the fallback would point
    // the fabric at another app's core and authenticate to it with our token.
    let effective_api = state.effective_endpoints.read().api_port;
    let Some(api_port) = effective_api else {
        return Err(
            "this instance is serving no API port; refusing to start the fabric against the \
             configured port, which may belong to another instance"
                .to_string(),
        );
    };
    cfg.api_port = api_port;

    let (launch_path, build_id) = crate::mcp_sidecar::resolved_tauri_sidecar("termflow-fabric")
        .map_err(|e| format!("fabric build identity unavailable: {e}"))?;
    let mut sidecar_command = app
        .shell()
        .sidecar("termflow-fabric")
        .map_err(|e| e.to_string())?;
    for (k, v) in fabric_env(&cfg, control_port, FABRIC_PEER_PORT, &data_dir, &state.instance_id) {
        sidecar_command = sidecar_command.env(k, v);
    }

    let generation = state
        .fabric_process
        .lock()
        .map_err(|_| "fabric process slot lock poisoned".to_string())?
        .claim_generation();
    let (mut rx, child) = sidecar_command.spawn().map_err(|e| e.to_string())?;
    log::info!("[FABRIC] termflow-fabric sidecar spawned");
    let installed = match state.fabric_process.lock() {
        Ok(mut slot) => slot.install_if_current(generation, child),
        Err(_) => {
            let _ = child.kill();
            return Err("fabric process slot lock poisoned after spawn; killed uninstalled child".to_string());
        }
    };
    match installed {
        Ok(Some(displaced_child)) => { let _ = displaced_child.kill(); }
        Ok(None) => {}
        Err(stale_child) => {
            let _ = stale_child.kill();
            return Ok(());
        }
    }
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);

    // Drain the sidecar's stdout/stderr/event stream so its pipe never fills and
    // blocks the child (same pattern as the MCP sidecar). Crucially, watch for
    // `Terminated`: if the fabric crashes or exits on its own, clear
    // `state.fabric_process` so `fabric_alive()` reflects reality. Otherwise the
    // handle lingers forever, `fabric_alive()` stays true, and `subscribe_fabric_events`
    // hammers `GET /events` against a dead port every 1s indefinitely.
    let drain_state = state.clone();
    let drain_stop = stop_tx.clone();
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;
        while let Some(event) = rx.recv().await {
            if let CommandEvent::Terminated(payload) = event {
                let _ = drain_stop.send(true);
                // Only clear the handle if we still own the current generation. During a
                // respawn the OLD child is killed and a NEW one stored ~immediately; if the
                // old child's Terminated arrives after that, this guard stops it from nulling
                // the new child's handle (which would kill the event bridge and orphan the
                // fabric) (re-review: fabric respawn stale-child race).
                let cleared = match drain_state.fabric_process.lock() {
                    Ok(mut slot) => slot.clear_if_current(generation),
                    Err(_) => {
                        log::error!("[FABRIC] process slot lock poisoned while recording termination for generation {generation}");
                        break;
                    }
                };
                if cleared {
                    log::warn!(
                        "[FABRIC] termflow-fabric terminated (code={:?}, signal={:?}); clearing process handle",
                        payload.code,
                        payload.signal
                    );
                } else {
                    log::debug!(
                        "[FABRIC] stale fabric child (gen {generation}) terminated after respawn; keeping current handle"
                    );
                }
            }
        }
    });

    // Start the SSE event bridge UNCONDITIONALLY, right after storing the child — do NOT
    // gate it on the health poll. `subscribe_fabric_events` self-guards on `fabric_alive()`
    // and reconnects every 1s while the child handle is present, so an early start simply
    // retries `GET /events` until the fabric answers. Previously this was gated on a 5s
    // health poll (10×500ms); on a slow first run (Ed25519 keygen + OS keychain access —
    // Windows Credential Manager can prompt) the poll timed out even though the fabric later
    // came up, so the bridge NEVER started that session and no `peer:event` (incl. incoming
    // pairing requests) reached the renderer until an app restart.
    let verify_state = state.clone();
    let stream_build_id = build_id.clone();
    tauri::async_runtime::spawn(subscribe_fabric_events(app, state, generation, stream_build_id, stop_rx));

    // A new child handle is not proof that the shared control port is its
    // listener.  Verify asynchronously so slow first-run key generation cannot
    // lose pairing events; only a rejection stops OUR generation's handle.
    tauri::async_runtime::spawn(async move {
        match wait_for_fabric_health(control_port, &verify_state.instance_id, &build_id).await {
            crate::mcp_sidecar::SidecarAcceptance::Verified => log::info!("[FABRIC] build-verified descriptor={}", launch_path.display()),
            crate::mcp_sidecar::SidecarAcceptance::Unverified => log::warn!("[FABRIC] owner matched but build identity unavailable; continuing unverified"),
            crate::mcp_sidecar::SidecarAcceptance::Rejected => {
                log::error!("[FABRIC] foreign or mismatched listener; stopping only our spawned generation");
                let _ = stop_tx.send(true);
                shutdown_fabric_generation(&verify_state, generation);
            }
        }
    });

    Ok(())
}

/// True while the fabric child handle is present (cleared by [`shutdown_fabric`]).
/// The SSE subscriber uses this to stop reconnecting once the fabric is shut down.
pub(crate) fn fabric_alive<R: tauri::Runtime>(state: &AppState<R>) -> bool {
    fabric_installed(state)
}

/// Whether the peering fabric child is currently running (its handle is stored).
/// This is the open-core gate every `/api/fleet/*` handler consults: remote fleet
/// ops with no fabric present return HTTP 501 "peering not installed" (the roster
/// endpoint still returns self). Same check as [`fabric_alive`], exported for the
/// fleet router in `api_server.rs`.
pub(crate) fn fabric_installed<R: tauri::Runtime>(state: &AppState<R>) -> bool {
    state
        .fabric_process
        .lock()
        .map(|g| g.is_present())
        .unwrap_or(false)
}

/// Pure predicate: is an `Option` handle present? Extracted so the gate's logic is
/// unit-testable without constructing an `AppState` (which needs `mock_app`).
/// Subscribe to the fabric's SSE event stream (`GET /events` on the loopback
/// control port) and re-emit each event to the renderer as a `peer:event` Tauri
/// event (bridged to a DOM `CustomEvent` in `tauri-bridge.ts`). The stream is
/// long-lived; on drop or error it reconnects after a short delay, but only while
/// the fabric is still alive (its child handle is present).
async fn subscribe_fabric_events(
    app: AppHandle,
    state: AppState,
    generation: u64,
    expected_build: String,
    mut stop: tokio::sync::watch::Receiver<bool>,
) {
    let url = format!("http://127.0.0.1:{}/events", state.fabric_control_port);
    // A dedicated client with NO total request timeout: SSE is a long-lived stream,
    // so the bounded-timeout localhost client used for one-shot control calls would
    // abort it. reqwest's default builder sets no request timeout.
    let client = reqwest::Client::builder()
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    while fabric_generation_is_current(&state, generation) && !subscription_cancelled(&stop) {
        match stream_fabric_events(&app, &client, &url, &state.instance_id, &expected_build, &mut stop).await {
            Ok(()) => log::debug!("[FABRIC] event stream closed; will reconnect"),
            Err(e) => log::debug!("[FABRIC] event stream error: {}; will reconnect", e),
        }
        if !fabric_generation_is_current(&state, generation) || subscription_cancelled(&stop) {
            break;
        }
        tokio::select! {
            _ = tokio::time::sleep(tokio::time::Duration::from_millis(1000)) => {}
            _ = stop.changed() => break,
        }
    }
    log::info!("[FABRIC] event subscriber stopped for generation {generation}");
}

fn fabric_generation_is_current<R: tauri::Runtime>(state: &AppState<R>, generation: u64) -> bool {
    match state.fabric_process.lock() {
        Ok(slot) => slot.is_current(generation),
        Err(_) => {
            log::error!("[FABRIC] process slot lock poisoned while checking generation {generation}; stopping subscription without classifying it stale");
            false
        }
    }
}

fn subscription_cancelled(stop: &tokio::sync::watch::Receiver<bool>) -> bool {
    *stop.borrow()
}

/// Open the SSE stream once and pump events until it ends or errors. Reads the
/// body chunk-by-chunk (no `stream` feature needed), buffers raw bytes, and parses
/// standard SSE framing: `data:` field lines accumulate until a blank line closes
/// the event. Each event is emitted as `peer:event` with the parsed JSON payload,
/// falling back to the raw string when a data field isn't valid JSON.
async fn stream_fabric_events(
    app: &AppHandle,
    client: &reqwest::Client,
    url: &str,
    own_id: &str,
    expected_build: &str,
    stop: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<(), reqwest::Error> {
    if subscription_cancelled(stop) {
        return Ok(());
    }
    let request = client
        .get(url)
        .header("Accept", "text/event-stream")
        .send();
    let mut resp = tokio::select! {
        _ = stop.changed() => return Ok(()),
        response = request => response?,
    }
    .error_for_status()?;

    // Starting the bridge is deliberately independent from the slow startup
    // verifier, but a successful /events response is not identity evidence.
    // Verify this listener before it can emit a connection marker or payload.
    if !stream_identity_allows_events(client, url, own_id, expected_build, stop).await? {
        log::warn!("[FABRIC] refusing events from an unverified control listener");
        return Ok(());
    }

    // Signal the renderer that the event stream (re)connected, so it can re-hydrate the
    // pending-approvals consent queue — a pairing staged while the stream was down would
    // otherwise be missed until a full renderer remount (re-review: M4 reconnect gap).
    emit_peer_event(app, "{\"type\":\"FabricStreamConnected\"}");

    // Bound the framing buffers so a fabric that streams an endless line with no newline
    // (buggy or hostile) can't grow memory without limit (review L4 / agy SEC-02).
    const MAX_SSE_BUFFER: usize = 64 * 1024;

    let mut buf: Vec<u8> = Vec::new();
    let mut data = String::new();

    loop {
        let chunk = tokio::select! {
            _ = stop.changed() => return Ok(()),
            chunk = resp.chunk() => chunk?,
        };
        let Some(chunk) = chunk else { break };
        buf.extend_from_slice(&chunk);
        // A newline (0x0A) never appears inside a UTF-8 multibyte sequence, so
        // splitting the raw byte buffer on it is always codepoint-safe.
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = buf.drain(..=pos).collect();
            // Trim the trailing \n and an optional preceding \r (CRLF).
            let mut end = line_bytes.len() - 1;
            if end > 0 && line_bytes[end - 1] == b'\r' {
                end -= 1;
            }
            let line = String::from_utf8_lossy(&line_bytes[..end]);
            if line.is_empty() {
                // Blank line = event boundary: dispatch what we accumulated.
                if !data.is_empty() {
                    emit_peer_event(app, &data);
                    data.clear();
                }
            } else if let Some(rest) = line.strip_prefix("data:") {
                // SSE allows one optional space after the field colon.
                let rest = rest.strip_prefix(' ').unwrap_or(rest);
                if !data.is_empty() {
                    data.push('\n');
                }
                data.push_str(rest);
            }
            // Other SSE fields (event:/id:/retry:) and `:`-comments are ignored.
        }
        // After draining every complete line, `buf` holds only an incomplete trailing line
        // and `data` an unterminated event. If either has blown past the cap, the fabric is
        // streaming without a boundary — drop the malformed accumulation to bound memory.
        if buf.len() > MAX_SSE_BUFFER || data.len() > MAX_SSE_BUFFER {
            log::warn!(
                "[FABRIC] SSE framing exceeded {MAX_SSE_BUFFER} bytes with no boundary; dropping buffer"
            );
            buf.clear();
            data.clear();
        }
    }
    // Stream ended without a trailing blank line: flush any pending event.
    if !data.is_empty() {
        emit_peer_event(app, &data);
    }
    Ok(())
}

/// Emit one `peer:event` to the renderer, parsing `data` as JSON when possible so
/// the DOM side receives a structured payload rather than a string.
fn emit_peer_event(app: &AppHandle, data: &str) {
    let payload = serde_json::from_str::<serde_json::Value>(data)
        .unwrap_or_else(|_| serde_json::Value::String(data.to_string()));
    // Plan 010: a pairing request arriving while the app is hidden/unfocused fires a
    // native OS notification (the renderer shows an in-app dialog when a window IS
    // focused, so this only covers the background case).
    maybe_notify_pairing(app, &payload);
    if let Err(e) = app.emit("peer:event", payload) {
        log::warn!("[FABRIC] Failed to emit peer:event: {}", e);
    }
}

/// Fire a native "wants to pair" notification for an incoming `PairingRequested`
/// event, but ONLY when no real TermFlow window currently has focus — a focused
/// window already surfaces the in-app `PeerRequestDialog`, so notifying there too
/// would double-prompt. Best-effort: notification failures are logged, not fatal.
fn maybe_notify_pairing(app: &AppHandle, payload: &serde_json::Value) {
    use tauri::Manager;
    use tauri_plugin_notification::NotificationExt;

    if payload.get("type").and_then(|v| v.as_str()) != Some("PairingRequested") {
        return;
    }
    let any_focused = app
        .webview_windows()
        .iter()
        .filter(|(label, _)| label.as_str() != "drag-preview")
        .any(|(_, w)| w.is_focused().unwrap_or(false));
    if any_focused {
        return;
    }
    let device = payload
        .get("name")
        .and_then(|v| v.as_str())
        .or_else(|| payload.get("device_id").and_then(|v| v.as_str()))
        .or_else(|| payload.get("deviceId").and_then(|v| v.as_str()))
        .unwrap_or("A device");
    if let Err(e) = app
        .notification()
        .builder()
        .title("TermFlow")
        .body(format!("{} wants to pair", device))
        .show()
    {
        log::warn!("[FABRIC] Failed to show pairing notification: {}", e);
    }
}

/// Kill the running fabric sidecar, if any. Called from `RunEvent::Exit`.
/// Restart the fabric so it picks up changed core creds (API port / token), which it only
/// receives via env at spawn (review M6). No-op when the fabric isn't currently running
/// (absent build, or never started), so this never spawns a fabric that wasn't already up.
/// Reuses this instance's control port, so the SSE subscriber reconnects to the fresh
/// process (the old subscriber exits once `shutdown_fabric` clears the handle).
pub async fn respawn_fabric(app: AppHandle, state: AppState) {
    let was_running = state
        .fabric_process
        .lock()
        .map(|g| g.is_present())
        .unwrap_or(false);
    if !was_running {
        return;
    }
    shutdown_fabric(&state);
    // Let the old peer/control listeners release their ports before the fresh bind.
    tokio::time::sleep(tokio::time::Duration::from_millis(400)).await;
    if let Err(e) = start_fabric(app, state).await {
        log::warn!("[FABRIC] Respawn after network change failed: {}", e);
    }
}

pub fn shutdown_fabric(state: &AppState) {
    match state.fabric_process.lock() {
        Ok(mut slot) => shutdown_fabric_child(slot.take()),
        Err(_) => log::error!("[FABRIC] process slot lock poisoned during shutdown; unable to inspect ownership"),
    }
}

async fn stream_identity_allows_events(
    client: &reqwest::Client,
    events_url: &str,
    own_id: &str,
    expected_build: &str,
    stop: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<bool, reqwest::Error> {
    let health_url = events_url.strip_suffix("/events").unwrap_or(events_url).to_string() + "/health";
    let request = client.get(health_url).send();
    let response = tokio::select! {
        _ = stop.changed() => return Ok(false),
        response = request => response?,
    }.error_for_status()?;
    let body: serde_json::Value = response.json().await.unwrap_or_else(|_| serde_json::json!({}));
    let reported_owner = body.get("ownerId").or_else(|| body.get("instanceId")).and_then(|value| value.as_str());
    let observed_build = body.get("buildId").and_then(|value| value.as_str()).filter(|value| !value.is_empty());
    Ok(stream_identity_is_acceptable(reported_owner, own_id, observed_build, expected_build))
}

fn stream_identity_is_acceptable(
    reported_owner: Option<&str>, own_id: &str, observed_build: Option<&str>, expected_build: &str,
) -> bool {
    matches!(
        crate::mcp_sidecar::classify_sidecar_report(reported_owner, own_id, observed_build, Some(expected_build)),
        Some(crate::mcp_sidecar::SidecarAcceptance::Verified | crate::mcp_sidecar::SidecarAcceptance::Unverified)
    )
}

/// Stop only the current slot if it still belongs to this lifecycle operation.
fn shutdown_fabric_generation(state: &AppState, generation: u64) {
    match state.fabric_process.lock() {
        Ok(mut slot) => shutdown_fabric_child(slot.take_if_current(generation)),
        Err(_) => log::error!("[FABRIC] process slot lock poisoned during generation shutdown; unable to inspect ownership"),
    }
}

fn shutdown_fabric_child(child: Option<tauri_plugin_shell::process::CommandChild>) {
    if let Some(child) = child {
        log::info!("[FABRIC] Shutting down termflow-fabric sidecar...");
        if let Err(e) = child.kill() {
            log::warn!("[FABRIC] Failed to kill fabric sidecar: {}", e);
        }
        log::info!("[FABRIC] Fabric sidecar terminated");
    }
}

/// Thin async client for the fabric's loopback control API
/// (`http://127.0.0.1:{control_port}`). The control port is loopback-only and the
/// fabric is a trusted local child, so no auth header is attached here (the fabric
/// authenticates to the *core* API via `TERMFLOW_CORE_TOKEN`, not the other way).
///
/// The peer-management Tauri commands (`peer_commands.rs`) build one of these per
/// call from `state.fabric_control_port` and proxy a single control-API route each.
pub struct FabricClient {
    base: String,
    http: reqwest::Client,
}

/// A failed control-API call.
///
/// Split by layer, because the two mean completely different things to a user:
/// `Transport` is "the fabric isn't there / didn't answer", while `Status` is "the
/// fabric answered and explained itself". `reqwest::Error` alone cannot express the
/// latter: `error_for_status()` keeps only the status code and drops the response
/// body, so the fabric's `{"error": "..."}` reason — the only actionable part — was
/// discarded before it ever reached the UI. Pairing failures then all rendered as a
/// bare "fabric returned 502 Bad Gateway" while the fabric had said precisely why
/// (e.g. "pairing not enabled" on the remote).
#[derive(Debug)]
pub enum FabricError {
    /// The request never produced an HTTP response (connection refused, timeout, …).
    Transport(reqwest::Error),
    /// The fabric answered with a non-2xx; `message` is its explanation.
    Status {
        status: reqwest::StatusCode,
        message: String,
    },
}

impl FabricError {
    /// Nothing listening on the control port — the "fabric not installed / not up yet"
    /// signal `fabric_status` maps to `{ installed: false }`.
    pub fn is_connect(&self) -> bool {
        matches!(self, Self::Transport(e) if e.is_connect())
    }

    /// The control port accepted but never answered (blackholed).
    pub fn is_timeout(&self) -> bool {
        matches!(self, Self::Transport(e) if e.is_timeout())
    }

    /// The HTTP status, when the fabric actually answered.
    pub fn status(&self) -> Option<reqwest::StatusCode> {
        match self {
            Self::Status { status, .. } => Some(*status),
            Self::Transport(e) => e.status(),
        }
    }
}

impl std::fmt::Display for FabricError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Transport(e) => write!(f, "{e}"),
            // Lead with the fabric's own words; the status is the fallback when it
            // answered a non-2xx with no usable body.
            Self::Status { status, message } if message.is_empty() => {
                write!(f, "fabric returned {status}")
            }
            Self::Status { message, .. } => write!(f, "{message}"),
        }
    }
}

/// Pull the human-readable reason out of a non-2xx fabric body: the `{"error": "..."}`
/// envelope every control-API handler returns, else the raw body text. Truncated so a
/// stray HTML error page can't flood a toast or dialog.
fn fabric_error_message(bytes: &[u8]) -> String {
    const MAX_CHARS: usize = 300;
    let text = serde_json::from_slice::<serde_json::Value>(bytes)
        .ok()
        .and_then(|v| {
            v.get("error")
                .and_then(|e| e.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| String::from_utf8_lossy(bytes).into_owned());
    let text = text.trim();
    if text.chars().count() > MAX_CHARS {
        text.chars().take(MAX_CHARS).collect::<String>() + "…"
    } else {
        text.to_string()
    }
}

impl FabricClient {
    /// Build a client targeting the fabric control API on `control_port`.
    /// Uses the shared bounded-timeout localhost client so a blackholed port can't
    /// hang a command; falls back to a default client only if the builder fails.
    pub fn new(control_port: u16) -> Self {
        let http = crate::network_commands::localhost_client(5000)
            .unwrap_or_else(reqwest::Client::new);
        Self {
            base: format!("http://127.0.0.1:{}", control_port),
            http,
        }
    }

    /// GET `{base}{path}` and parse the JSON body.
    pub async fn get(&self, path: &str) -> Result<serde_json::Value, FabricError> {
        self.send(self.http.get(self.url(path))).await
    }

    /// POST `{base}{path}` with a JSON `body` and parse the JSON response.
    pub async fn post(
        &self,
        path: &str,
        body: serde_json::Value,
    ) -> Result<serde_json::Value, FabricError> {
        self.send(self.http.post(self.url(path)).json(&body)).await
    }

    /// DELETE `{base}{path}` and parse the JSON response (if any).
    pub async fn delete(&self, path: &str) -> Result<serde_json::Value, FabricError> {
        self.send(self.http.delete(self.url(path))).await
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    /// Send a prepared request, surface a non-2xx as a [`FabricError::Status`] CARRYING
    /// the fabric's explanation, and parse the body otherwise.
    ///
    /// The body is read before the status is judged, deliberately: `error_for_status()`
    /// consumes the response and keeps only the code, which is what stripped the fabric's
    /// `{"error": ...}` reason out of every failure. An empty body (204 / no content, e.g.
    /// approve/revoke) parses as `Null` rather than erroring, and a non-JSON success body
    /// degrades to `Null` instead of failing.
    async fn send(
        &self,
        req: reqwest::RequestBuilder,
    ) -> Result<serde_json::Value, FabricError> {
        let resp = req.send().await.map_err(FabricError::Transport)?;
        let status = resp.status();
        let bytes = resp.bytes().await.map_err(FabricError::Transport)?;
        if !status.is_success() {
            return Err(FabricError::Status {
                status,
                message: fabric_error_message(&bytes),
            });
        }
        if bytes.is_empty() {
            Ok(serde_json::Value::Null)
        } else {
            Ok(serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_config::NetworkConfig;
    use std::path::Path;

    #[test]
    fn stream_acceptance_requires_the_spawned_owner_and_build_identity() {
        assert!(stream_identity_is_acceptable(Some("spawn-owner-g7"), "spawn-owner-g7", Some("build-g7"), "build-g7"));
        assert!(stream_identity_is_acceptable(Some("spawn-owner-g7"), "spawn-owner-g7", None, "build-g7"));
        assert!(!stream_identity_is_acceptable(Some("foreign-owner"), "spawn-owner-g7", Some("build-g7"), "build-g7"));
        assert!(!stream_identity_is_acceptable(Some("spawn-owner-g7"), "spawn-owner-g7", Some("wrong-build"), "build-g7"));
        assert!(!stream_identity_is_acceptable(None, "spawn-owner-g7", Some("build-g7"), "build-g7"));
    }

    #[test]
    fn fabric_env_carries_core_token_and_ports() {
        let cfg = NetworkConfig {
            api_port: 42031,
            mcp_port: 42032,
            expose_on_network: true,
            auth_token: "SECRET".into(),
        };
        let env = fabric_env(&cfg, 42060, 8790, Path::new("/tmp/f"), "inst-1234");
        let get = |k: &str| {
            env.iter()
                .find(|(ek, _)| ek == k)
                .map(|(_, v)| v.clone())
        };
        assert_eq!(get("TERMFLOW_CORE_TOKEN").unwrap(), "SECRET");
        assert_eq!(get("TERMFLOW_FABRIC_CONTROL_PORT").unwrap(), "42060");
        assert_eq!(get("TERMFLOW_CORE_API_URL").unwrap(), "http://localhost:42031");
        assert_eq!(get("TERMFLOW_FABRIC_OWNER_ID").unwrap(), "inst-1234");
    }

    #[test]
    fn fabric_respawn_needed_tracks_api_port_and_token_only() {
        let base = NetworkConfig {
            api_port: 42031,
            mcp_port: 42032,
            expose_on_network: true,
            auth_token: "TOK".into(),
        };
        // api_port change → fabric's core URL changed → respawn.
        let mut api = base.clone();
        api.api_port = 40000;
        assert!(fabric_respawn_needed(&base, &api));
        // token change → fabric always authenticates with it → respawn.
        let mut tok = base.clone();
        tok.auth_token = "NEW".into();
        assert!(fabric_respawn_needed(&base, &tok));
        // mcp_port / expose_on_network don't reach the fabric → no respawn.
        let mut mcp = base.clone();
        mcp.mcp_port = 40001;
        mcp.expose_on_network = false;
        assert!(!fabric_respawn_needed(&base, &mcp));
    }

    #[test]
    fn generation_slot_presence_reflects_installed_child() {
        // fabric_installed() reduces to "is the child handle present?" — pin that
        // predicate so the gate can't silently invert (installed when absent).
        let mut slot = crate::state::GenerationSlot::new();
        assert!(!slot.is_present());
        let generation = slot.claim_generation();
        slot.install_if_current(generation, ()).unwrap();
        assert!(slot.is_present());
    }

    #[tokio::test]
    async fn rejection_signal_cancels_a_generation_bound_subscription() {
        let (stop_tx, mut stop_rx) = tokio::sync::watch::channel(false);
        assert!(!super::subscription_cancelled(&stop_rx));
        stop_tx.send(true).unwrap();
        stop_rx.changed().await.unwrap();
        assert!(super::subscription_cancelled(&stop_rx));
    }

    #[test]
    fn event_bridge_is_started_before_the_async_identity_verification() {
        let source = include_str!("fabric_manager.rs");
        let bridge = source.find("spawn(subscribe_fabric_events").unwrap();
        let verify = bridge + source[bridge..].find("wait_for_fabric_health(control_port").unwrap();
        assert!(bridge < verify, "slow or unavailable build identity must not suppress pairing events");
    }
}

#[cfg(test)]
mod client_tests {
    use super::*;

    /// The cadence comment above this poll says its budget exists to cover a
    /// first run that blocks on a Windows Credential Manager prompt. `Rejected`
    /// stops our own fabric child, so returning it on an exhausted budget would
    /// kill peering in exactly the scenario the budget was written for — and
    /// this poll previously could not disable anything at all.
    #[tokio::test]
    async fn an_unanswered_fabric_health_budget_is_unverified_not_rejected() {
        let port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").expect("bind an ephemeral port");
            l.local_addr().expect("read the bound port").port()
        };
        assert_eq!(
            wait_for_fabric_health_within(port, "ours", "expected", 1).await,
            crate::mcp_sidecar::SidecarAcceptance::Unverified
        );
    }

    /// The `FabricClient` GETs `/health` from a real (stub) control server and
    /// parses the JSON body. Also proves the "not installed" signal: a request to a
    /// dead port surfaces as a `reqwest` connection error (what `fabric_status` maps
    /// to `{ installed: false }`).
    #[tokio::test]
    async fn client_parses_health_from_stub_server() {
        use axum::{routing::get, Json, Router};
        use tokio::net::TcpListener;

        let app = Router::new().route(
            "/health",
            get(|| async { Json(serde_json::json!({ "status": "ok", "peers": 2 })) }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let client = FabricClient::new(port);
        let health = client.get("/health").await.expect("stub /health parsed");
        assert_eq!(health["status"], "ok");
        assert_eq!(health["peers"], 2);

        // A port with nothing listening → connection error (the not-installed path).
        // Bind then immediately drop to obtain a port guaranteed to have no listener.
        let dead_port = {
            let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
            l.local_addr().unwrap().port()
        };
        let dead = FabricClient::new(dead_port);
        let err = dead.get("/health").await.expect_err("dead port must error");
        assert!(
            err.is_connect(),
            "unreachable control port must surface as a connection error, got: {err}"
        );
    }

    /// The regression this whole error type exists for: when the fabric answers a non-2xx
    /// it explains itself in an `{"error": ...}` body, and that explanation MUST reach the
    /// caller. The old `error_for_status()` dropped it, so a user whose peer had "Accept
    /// peers" switched off saw only "fabric returned 502 Bad Gateway" — nothing actionable
    /// — while the fabric had said exactly what was wrong.
    #[tokio::test]
    async fn non_2xx_carries_the_fabric_error_body_not_just_the_status() {
        use axum::http::StatusCode;
        use axum::{routing::post, Json, Router};
        use tokio::net::TcpListener;

        // The real body `control_api::add_peer` returns when the remote refuses to pair.
        let app = Router::new().route(
            "/peers/add",
            post(|| async {
                (
                    StatusCode::BAD_GATEWAY,
                    Json(serde_json::json!({
                        "error": "pairing rejected: 403 Forbidden: {\"error\":\"pairing not enabled\"}"
                    })),
                )
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let client = FabricClient::new(port);
        let err = client
            .post("/peers/add", serde_json::json!({}))
            .await
            .expect_err("a 502 must be an error");

        assert_eq!(err.status(), Some(reqwest::StatusCode::BAD_GATEWAY));
        assert!(!err.is_connect(), "a real HTTP answer is not a connect error");
        // The point: the reason survives all the way to the string a user is shown.
        assert!(
            err.to_string().contains("pairing not enabled"),
            "the fabric's reason must survive to the caller, got: {err}"
        );
    }

    /// A non-2xx with no usable body still degrades to something meaningful rather than
    /// an empty string.
    #[tokio::test]
    async fn non_2xx_without_a_body_falls_back_to_the_status() {
        use axum::http::StatusCode;
        use axum::{routing::get, Router};
        use tokio::net::TcpListener;

        let app = Router::new().route("/health", get(|| async { StatusCode::INTERNAL_SERVER_ERROR }));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let err = FabricClient::new(port)
            .get("/health")
            .await
            .expect_err("a 500 must be an error");
        assert!(
            err.to_string().contains("500"),
            "an empty error body must fall back to the status, got: {err}"
        );
    }

    /// A non-JSON error body (e.g. a proxy's HTML page) is passed through as text and
    /// truncated, so it can neither vanish nor flood the UI.
    #[test]
    fn error_message_handles_plain_text_and_truncates() {
        assert_eq!(
            fabric_error_message(br#"{"error":"pairing not enabled"}"#),
            "pairing not enabled"
        );
        assert_eq!(fabric_error_message(b"  plain text  "), "plain text");
        assert_eq!(fabric_error_message(b""), "");
        let long = "x".repeat(500);
        let out = fabric_error_message(long.as_bytes());
        assert_eq!(out.chars().count(), 301, "truncated to 300 chars + ellipsis");
        assert!(out.ends_with('…'));
    }
}
