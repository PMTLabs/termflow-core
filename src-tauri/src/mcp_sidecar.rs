use crate::app_config;
use crate::state::{AppState, McpProcessHandle};
use crate::shutdown_mcp_server;
use tauri_plugin_shell::ShellExt;

/// Poll the MCP server's `/health` until OUR sidecar answers.
///
/// A 200 is not enough: with per-profile instances another TermFlow's MCP server
/// can hold this port, and treating its reply as "healthy" would have us report
/// a running server we do not own — and quietly route this instance's tool calls
/// into the other app. The sidecar echoes `AUTO_TERMINAL_INSTANCE_ID`, so
/// compare it (`classify_health_owner`, the same rule the Settings check uses).
async fn wait_for_mcp_health(port: u16, own_id: &str) -> bool {
    // Bounded-timeout client so an unresponsive port can't stall each attempt for the
    // OS default (~20s); the 500ms poll cadence + 10 attempts bounds total wait.
    let client = crate::network_commands::localhost_client(1500);
    for attempt in 1..=10 {
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

        let result = match &client {
            Some(c) => c.get(format!("http://localhost:{}/health", port)).send().await,
            None => reqwest::get(format!("http://localhost:{}/health", port)).await,
        };
        match result {
            Ok(response) if response.status().is_success() => {
                let body: serde_json::Value =
                    response.json().await.unwrap_or_else(|_| serde_json::json!({}));
                let reported = body.get("instanceId").and_then(|v| v.as_str());
                let (healthy, conflict) =
                    crate::network_commands::classify_health_owner(reported, own_id);
                if healthy {
                    log::info!("[MCP] MCP Server healthy after {} attempt(s)", attempt);
                    return true;
                }
                if conflict {
                    log::error!(
                        "[MCP] port {port} is served by ANOTHER instance ({}) — this instance's \
                         MCP server is not running. Change the MCP port in Settings.",
                        reported.unwrap_or("unknown")
                    );
                    return false;
                }
                log::debug!("[MCP] Health check attempt {attempt}: no instanceId yet");
            }
            Ok(response) => {
                log::debug!("[MCP] Health check attempt {} returned status: {}", attempt, response.status());
            }
            Err(e) => {
                log::debug!("[MCP] Health check attempt {} failed: {}", attempt, e);
            }
        }
    }

    log::error!("[MCP] MCP Server health check failed after 10 attempts — MCP is NOT available");
    false
}

/// The environment the MCP server is launched with, derived from the current
/// network config. The same `AUTO_TERMINAL_TOKEN` is used both for incoming
/// client auth (when networked) and forwarded by the MCP server to the API.
fn mcp_env(cfg: &app_config::NetworkConfig) -> Vec<(String, String)> {
    let host = if cfg.expose_on_network { "0.0.0.0" } else { "127.0.0.1" };
    let token = if cfg.expose_on_network {
        cfg.auth_token.clone()
    } else {
        String::new()
    };
    vec![
        ("AUTO_TERMINAL_API_URL".into(), format!("http://localhost:{}", cfg.api_port)),
        ("MCP_PORT".into(), cfg.mcp_port.to_string()),
        ("MCP_HOST".into(), host.into()),
        ("AUTO_TERMINAL_TOKEN".into(), token),
        // Tie the sidecar's lifetime to this app process. If the app is killed
        // abruptly (e.g. Ctrl+C in `tauri dev`), the graceful RunEvent::Exit
        // shutdown never runs, so the sidecar self-exits when this PID is gone.
        ("MCP_PARENT_PID".into(), std::process::id().to_string()),
    ]
}

/// True only when a config change actually alters the sidecar's environment, so
/// we don't kill every client's in-memory MCP session on a no-op apply or on a
/// localhost token rotation (where the sidecar's token env is empty either way).
/// MCP_PARENT_PID is identical across both calls within this process, so it
/// cancels out of the comparison.
pub(crate) fn mcp_respawn_needed(
    old: &app_config::NetworkConfig,
    new: &app_config::NetworkConfig,
) -> bool {
    mcp_env(old) != mcp_env(new)
}

async fn start_mcp_sidecar(
    app_handle: tauri::AppHandle,
    state: AppState,
    cfg: &app_config::NetworkConfig,
) -> Result<(), String> {
    log::info!("[MCP] Starting MCP Server sidecar...");

    let mut sidecar_command = app_handle
        .shell()
        .sidecar("termflow-mcp-server")
        .map_err(|e| e.to_string())?;
    for (k, v) in mcp_env(cfg) {
        sidecar_command = sidecar_command.env(k, v);
    }
    // P0b: let the sidecar echo our identity on /health so the Settings health check
    // can tell OUR sidecar from another instance's that happens to own the MCP port.
    sidecar_command = sidecar_command.env("AUTO_TERMINAL_INSTANCE_ID", &state.instance_id);

    let (mut rx, child) = sidecar_command.spawn().map_err(|e| e.to_string())?;
    log::info!("[MCP] MCP sidecar spawned");

    if let Ok(mut guard) = state.mcp_process.lock() {
        *guard = Some(McpProcessHandle::Sidecar(child));
    }

    tauri::async_runtime::spawn(async move {
        while rx.recv().await.is_some() {}
    });

    let _ = wait_for_mcp_health(cfg.mcp_port, &state.instance_id).await;
    Ok(())
}

async fn start_mcp_legacy(
    state: AppState,
    cfg: &app_config::NetworkConfig,
) -> Result<(), String> {
    log::info!("[MCP] Starting MCP Server via legacy node fallback...");

    let possible_paths = [
        std::path::PathBuf::from("../mcp-server/build/index.js"),
        std::path::PathBuf::from("../../mcp-server/build/index.js"),
    ];

    let mcp_path = possible_paths
        .iter()
        .filter_map(|p| std::fs::canonicalize(p).ok())
        .next()
        .ok_or_else(|| "Could not find MCP server build at any expected path".to_string())?;

    log::info!("[MCP] Found MCP server at: {:?}", mcp_path);

    let mut cmd = std::process::Command::new("node");
    cmd.arg(&mcp_path)
        .envs(mcp_env(cfg))
        // P0b: identity for owner-aware MCP health (see start_mcp_sidecar).
        .env("AUTO_TERMINAL_INSTANCE_ID", &state.instance_id)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    // CREATE_NO_WINDOW so the node fallback doesn't flash a console window.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let child = cmd.spawn().map_err(|e| e.to_string())?;

    let pid = child.id();
    log::info!("[MCP] MCP Server spawned with PID: {}", pid);

    if let Ok(mut guard) = state.mcp_process.lock() {
        *guard = Some(McpProcessHandle::Legacy(child));
    }

    let _ = wait_for_mcp_health(cfg.mcp_port, &state.instance_id).await;
    Ok(())
}

/// Kill any running MCP server, then (re)start it from the given config. Tries
/// the bundled sidecar first and falls back to the legacy node path in dev.
/// Returns whether an MCP server is now running and forwarding to OUR core API.
///
/// The boolean is load-bearing: callers publish `effective_endpoints.mcp_port` from it, and
/// writing a port for a sidecar that never came up advertises an endpoint nobody serves.
pub async fn respawn_mcp(
    app_handle: tauri::AppHandle,
    state: AppState,
    cfg: &app_config::NetworkConfig,
) -> bool {
    // Point the sidecar at the API port we ACTUALLY bound. The boot path patches this into
    // the config it passes; every OTHER caller hands over the CONFIGURED one, and on a
    // second instance those differ — so an apply, a token rotation or a Start would leave
    // the sidecar forwarding every MCP tool call into the SIBLING app's terminals. Patched
    // here rather than at each call site so a new caller cannot forget it; it is a no-op
    // for the boot path, which already passes the same value.
    //
    // **`None` REFUSES rather than falling back to the configured port.** That fallback is
    // the very bug this change exists to remove: with no API of our own, the configured port
    // is precisely where a sibling instance is listening, so spawning a forwarder aimed at it
    // hands another app our token and routes every tool call into its terminals.
    let effective_api = state.effective_endpoints.read().api_port;
    let Some(api_port) = effective_api else {
        log::warn!(
            "[MCP] Not started: this instance is serving no API port, and the configured one \
             ({}) may belong to another instance",
            cfg.api_port
        );
        shutdown_mcp_server(&state);
        return false;
    };
    let mut patched = cfg.clone();
    patched.api_port = api_port;
    let cfg = &patched;

    shutdown_mcp_server(&state);
    // Let the previous process fully release its port before rebinding. The
    // sidecar handle is killed (not waited), so give it a generous margin to
    // avoid an EADDRINUSE on the fresh listener; health-check + legacy fallback
    // cover the rare case it's still slow.
    tokio::time::sleep(tokio::time::Duration::from_millis(400)).await;

    match start_mcp_sidecar(app_handle.clone(), state.clone(), cfg).await {
        Ok(_) => return true,
        Err(e) => log::warn!("[MCP] Sidecar startup failed, falling back to legacy node path: {}", e),
    }
    match start_mcp_legacy(state, cfg).await {
        Ok(_) => true,
        Err(e) => {
            log::error!("[MCP] Failed to start MCP server: {}", e);
            false
        }
    }
}

#[cfg(test)]
mod respawn_tests {
    use super::mcp_respawn_needed;
    use crate::app_config::NetworkConfig;

    fn base() -> NetworkConfig {
        NetworkConfig {
            api_port: 42031,
            mcp_port: 42032,
            expose_on_network: false,
            auth_token: "tok-a".into(),
        }
    }

    #[test]
    fn identical_config_does_not_need_respawn() {
        assert!(!mcp_respawn_needed(&base(), &base()));
    }

    #[test]
    fn localhost_token_rotation_does_not_need_respawn() {
        // In localhost mode the sidecar's token env is empty regardless of the
        // stored auth_token, so rotating it must NOT drop active sessions.
        let old = base();
        let mut new = base();
        new.auth_token = "tok-b".into();
        assert!(!mcp_respawn_needed(&old, &new));
    }

    #[test]
    fn networked_token_rotation_needs_respawn() {
        // When exposed, the sidecar receives the token via env, so a rotation
        // genuinely requires a respawn.
        let mut old = base();
        old.expose_on_network = true;
        let mut new = old.clone();
        new.auth_token = "tok-b".into();
        assert!(mcp_respawn_needed(&old, &new));
    }

    #[test]
    fn mcp_port_change_needs_respawn() {
        let old = base();
        let mut new = base();
        new.mcp_port = 50000;
        assert!(mcp_respawn_needed(&old, &new));
    }

    #[test]
    fn api_port_change_needs_respawn() {
        let old = base();
        let mut new = base();
        new.api_port = 50001;
        assert!(mcp_respawn_needed(&old, &new));
    }

    #[test]
    fn expose_toggle_needs_respawn() {
        let old = base();
        let mut new = base();
        new.expose_on_network = true;
        assert!(mcp_respawn_needed(&old, &new));
    }

    /// The geometry handler must decide a window is TRACKED before it asks whether it is
    /// maximized. A tripwire over source, because the thing being guarded is a cost, not a
    /// result: both orderings record exactly the same geometry, and the wrong one is only
    /// visible as an app that freezes on macOS while a borderless window is dragged.
    ///
    /// `is_maximized()` is not a read on macOS. tao cannot ask AppKit whether a borderless
    /// window is zoomed without temporarily swapping its style mask to Titled|Resizable and
    /// back, and each swap rebuilds the window's entire NSThemeFrame. Evaluated as an
    /// argument to `note_geometry` — which then discards it for an unregistered label — that
    /// ran twice per frame for every move of the `drag-preview` window and pegged the main
    /// thread for the whole drag.
    ///
    /// Comments are stripped first: the fix is explained in a comment that names
    /// `is_maximized`, and an explanation must not be able to satisfy the test that polices it.
    #[test]
    fn geometry_tracking_checks_the_label_before_asking_is_maximized() {
        const SRC: &str = include_str!("lib.rs");
        let anchor = SRC
            .find("state.windows.note_geometry(")
            .expect("the geometry handler moved; this tripwire needs re-anchoring");
        let start = SRC[..anchor]
            .rfind("WindowEvent::Moved")
            .expect("the Moved/Resized guard moved; this tripwire needs re-anchoring");
        let code: String = SRC[start..]
            .lines()
            .map(|l| l.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n");

        let gate = code
            .find("id_for_label")
            .expect("geometry tracking must gate on a registered label, or drag-preview reaches is_maximized()");
        let query = code
            .find("is_maximized")
            .expect("the handler no longer reads is_maximized; re-check what this test is for");
        assert!(
            gate < query,
            "the label gate must come BEFORE is_maximized(): reaching that call for an \
             untracked window is what froze the app during a tab drag on macOS"
        );
    }
}
