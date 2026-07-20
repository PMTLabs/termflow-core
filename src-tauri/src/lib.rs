pub mod state;
pub mod context_menu;
pub mod session_notify;
pub mod app_config;
mod history_store;
pub mod network_commands;
pub mod pty_manager;
pub mod pty_host_client;
pub mod commands;
pub mod open_commands;
pub mod api_server;
pub mod event_bus;
pub mod recording_service;
pub mod recording_endpoints;
pub mod search_service;
pub mod search_endpoints;
pub mod layout_manager;
pub mod layout_endpoints;
pub mod tmux_manager;
pub mod fabric_manager;
pub mod peer_commands;
mod native_notify;
mod shell_integration;

use tauri::{Manager, Emitter, RunEvent, WindowEvent};
use tauri_plugin_shell::ShellExt;

use tokio::sync::broadcast;
use crate::state::{AppState, McpProcessHandle};

use clap::Parser;

/// Gracefully shutdown the MCP server process
pub(crate) fn shutdown_mcp_server(state: &AppState) {
    if let Ok(mut guard) = state.mcp_process.lock() {
        if let Some(child) = guard.take() {
            match child {
                McpProcessHandle::Legacy(mut handle) => {
                    log::info!("[MCP] Shutting down MCP Server (PID: {})...", handle.id());
                    if let Err(e) = handle.kill() {
                        log::warn!("[MCP] Failed to kill legacy MCP Server: {}", e);
                    }
                    if let Err(e) = handle.wait() {
                        log::warn!("[MCP] Failed to wait for legacy MCP Server: {}", e);
                    }
                }
                McpProcessHandle::Sidecar(handle) => {
                    log::info!("[MCP] Shutting down MCP Server sidecar...");
                    if let Err(e) = handle.kill() {
                        log::warn!("[MCP] Failed to kill sidecar MCP Server: {}", e);
                    }
                }
            }

            log::info!("[MCP] MCP Server terminated");
        }
    }
}

async fn wait_for_mcp_health(port: u16) -> bool {
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
                log::info!("[MCP] MCP Server healthy after {} attempt(s)", attempt);
                return true;
            }
            Ok(response) => {
                log::debug!("[MCP] Health check attempt {} returned status: {}", attempt, response.status());
            }
            Err(e) => {
                log::debug!("[MCP] Health check attempt {} failed: {}", attempt, e);
            }
        }
    }

    log::warn!("[MCP] MCP Server health check failed after 10 attempts");
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
fn mcp_respawn_needed(
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

    let _ = wait_for_mcp_health(cfg.mcp_port).await;
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

    let _ = wait_for_mcp_health(cfg.mcp_port).await;
    Ok(())
}

/// Kill any running MCP server, then (re)start it from the given config. Tries
/// the bundled sidecar first and falls back to the legacy node path in dev.
pub async fn respawn_mcp(
    app_handle: tauri::AppHandle,
    state: AppState,
    cfg: &app_config::NetworkConfig,
) {
    shutdown_mcp_server(&state);
    // Let the previous process fully release its port before rebinding. The
    // sidecar handle is killed (not waited), so give it a generous margin to
    // avoid an EADDRINUSE on the fresh listener; health-check + legacy fallback
    // cover the rare case it's still slow.
    tokio::time::sleep(tokio::time::Duration::from_millis(400)).await;

    match start_mcp_sidecar(app_handle.clone(), state.clone(), cfg).await {
        Ok(_) => return,
        Err(e) => log::warn!("[MCP] Sidecar startup failed, falling back to legacy node path: {}", e),
    }
    if let Err(e) = start_mcp_legacy(state, cfg).await {
        log::error!("[MCP] Failed to start MCP server: {}", e);
    }
}

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
   /// Run in headless mode (no GUI)
   #[arg(long, default_value_t = false)]
   headless: bool,
   /// Override the API server port for THIS run — e.g. to launch a second instance
   /// without a port conflict. Runtime-only; not persisted to the shared config.
   #[arg(long)]
   api_port: Option<u16>,
   /// Override the MCP server port for THIS run. Runtime-only; not persisted.
   #[arg(long)]
   mcp_port: Option<u16>,
   /// Open a new terminal rooted at this folder.
   #[arg(long = "path")]
   path: Option<String>,
   /// Positional fallback used by file managers and command-line users.
   #[arg(value_name = "PATH")]
   positional_path: Option<String>,
}

#[cfg(test)]
mod cli_args_tests {
    use super::Args;
    use clap::Parser;

    #[test]
    fn parses_port_overrides() {
        let a = Args::try_parse_from(["app", "--api-port", "42041", "--mcp-port", "42042"]).unwrap();
        assert_eq!(a.api_port, Some(42041));
        assert_eq!(a.mcp_port, Some(42042));
    }

    #[test]
    fn ports_default_to_none() {
        let a = Args::try_parse_from(["app"]).unwrap();
        assert_eq!(a.api_port, None);
        assert_eq!(a.mcp_port, None);
        assert!(!a.headless);
    }

    #[test]
    fn parses_path_flag_and_positional() {
        // --path flag
        let a = Args::try_parse_from(["app", "--path", "C:/proj"]).unwrap();
        assert_eq!(a.path.as_deref(), Some("C:/proj"));
        assert_eq!(a.positional_path, None);
        // positional fallback (file managers pass the folder as a bare arg)
        let b = Args::try_parse_from(["app", "/home/user/proj"]).unwrap();
        assert_eq!(b.path, None);
        assert_eq!(b.positional_path.as_deref(), Some("/home/user/proj"));
        // `--path` wins when both are given (matches `args.path.or(positional_path)`)
        let c = Args::try_parse_from(["app", "--path", "A", "B"]).unwrap();
        assert_eq!(c.path.as_deref(), Some("A"));
        assert_eq!(c.positional_path.as_deref(), Some("B"));
        // absent
        let d = Args::try_parse_from(["app"]).unwrap();
        assert_eq!(d.path, None);
        assert_eq!(d.positional_path, None);
    }
}

/// Pure stall detector for the output-pipeline watchdog: returns the updated
/// consecutive-stall tick count. A stall tick is "producers advanced but the
/// consumer heartbeat didn't" — i.e. PTYs are emitting output that nobody is
/// delivering. Any other combination resets the count.
fn stall_ticks(
    produced: u64,
    consumed: u64,
    last_produced: u64,
    last_consumed: u64,
    prev_ticks: u8,
) -> u8 {
    if produced != last_produced && consumed == last_consumed {
        prev_ticks.saturating_add(1)
    } else {
        0
    }
}

/// Spawn the single PTY output consumer (generation-tagged). It drains the
/// broadcast channel and (1) feeds the authoritative vt100 screen parser,
/// (2) appends raw chunks to the history buffer, (3) emits terminal:data to
/// all windows. The watchdog respawns it with a bumped generation if it ever
/// stalls; a superseded instance exits at the generation check below.
fn spawn_output_consumer(state: AppState, generation: u64) {
    let mut rx = state.output_tx.subscribe();
    tauri::async_runtime::spawn(async move {
        log::info!("[PIPELINE] output consumer started (gen {})", generation);
        // Coalesce the renderer emit (terminal:data) so a TUI's back-to-back frames —
        // e.g. codex's redraw followed by its SEPARATE cursor-reposition frame — reach the
        // webview as ONE write. Otherwise the multi-hop IPC spreads them across xterm's
        // paint boundary and the in-between cursor position flickers ("cursor flash"). ONLY
        // the emit is deferred (by at most EMIT_COALESCE_MS): the authoritative screen
        // parser, history, watchdog heartbeat and Lagged handling below all still run
        // per-chunk and in-order. The byte cap flushes a large burst immediately so bulk
        // output never waits on the timer (and the buffer can't grow unbounded).
        const EMIT_COALESCE_MS: u64 = 5;
        const EMIT_FLUSH_BYTES: usize = 16 * 1024;
        let mut emit_buf: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        let mut flush_at: Option<tokio::time::Instant> = None;
        loop {
            // When output is buffered, wait for the next chunk only until the flush
            // deadline — if it elapses first, emit the coalesced batch and loop. When
            // nothing is buffered, block for the next chunk exactly as before.
            let recv_result = match flush_at {
                Some(deadline) => match tokio::time::timeout_at(deadline, rx.recv()).await {
                    Ok(r) => r,
                    Err(_elapsed) => {
                        for (id, data) in emit_buf.drain() {
                            let _ = state.app_handle.emit(
                                "terminal:data",
                                serde_json::json!({ "id": id, "data": data }),
                            );
                        }
                        flush_at = None;
                        continue;
                    }
                },
                None => rx.recv().await,
            };
            // Don't die on Lagged (a transient slow-consumer burst): that would
            // permanently stop feeding the authoritative screen parser AND the
            // terminal:data emit for every terminal. Only stop when the channel
            // is closed (mirrors the SSE path in api_server.rs).
            let payload = match recv_result {
                Ok(payload) => payload,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    // Flush any coalesced output before exiting.
                    for (id, data) in emit_buf.drain() {
                        let _ = state.app_handle.emit(
                            "terminal:data",
                            serde_json::json!({ "id": id, "data": data }),
                        );
                    }
                    break;
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    log::warn!(
                        "PTY output listener lagged behind, dropped {} message(s); requesting repaint",
                        n
                    );
                    // Dropped chunks corrupt in-place TUI redraws (the missing
                    // bytes carried erase/cursor sequences). Force the apps to
                    // repaint so the screen parser and xterm self-heal instead
                    // of accumulating stale frames. The pending coalesced emit is
                    // stale now too — drop it; the repaint resyncs.
                    emit_buf.clear();
                    flush_at = None;
                    state.repaint_all_terminals_debounced(2_000);
                    continue;
                }
            };

            // Exit if the watchdog respawned a newer consumer while this one
            // was wedged — a recovered stale instance must not double-process.
            if state
                .consumer_generation
                .load(std::sync::atomic::Ordering::SeqCst)
                != generation
            {
                log::warn!(
                    "[PIPELINE] output consumer gen {} superseded; exiting",
                    generation
                );
                break;
            }

            // Consumer heartbeat for the watchdog.
            state
                .output_consumed
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);

            let data_str = String::from_utf8_lossy(&payload.data).to_string();

            // Feed the authoritative screen parser with the exact raw bytes.
            // This always reflects the true current screen and is what the
            // client hydrates from on reconnect (no heuristics involved).
            state.feed_screen(&payload.id, &payload.data);

            // Track the shell-reported cwd from OSC 9;9 / OSC 7 sequences (backlog
            // 004). Authoritative for shells whose process cwd isn't live (PowerShell).
            if let Some(cwd) = pty_manager::parse_osc_cwd(&payload.data) {
                if state.terminals.contains_key(&payload.id) {
                    // Only emit when the cwd actually changed, so the renderer's live
                    // cwd map (Stream 4) updates on every `cd` without a per-prompt spam.
                    let changed = state
                        .terminal_cwds
                        .get(&payload.id)
                        .map(|v| *v != cwd)
                        .unwrap_or(true);
                    state.terminal_cwds.insert(payload.id.clone(), cwd.clone());
                    if changed {
                        let _ = state.app_handle.emit(
                            "terminal:cwd",
                            serde_json::json!({ "id": payload.id, "cwd": cwd }),
                        );
                    }
                }
            }

            // Buffer history as raw chunks — ONLY for terminals that still
            // exist. `.entry().or_insert_with()` would silently resurrect the
            // history entry for a terminal that was just closed (a late
            // broadcast chunk arriving after cleanup). The double-check after
            // the insert closes the residual TOCTOU window where
            // cleanup_terminal_state runs between the contains_key above and
            // the entry insert. Mirrors the feed_screen guard (state.rs).
            if state.terminals.contains_key(&payload.id) {
                // Clone the Arc out of the entry and DROP the shard guard at the
                // end of this statement. The inner Mutex below must never be
                // locked while a shard guard is held — that nesting let slow API
                // readers (history render under lock) starve this consumer, and
                // with it output delivery for EVERY terminal (the root cause of
                // the app-wide output stall).
                let history_arc = state
                    .terminal_history
                    .entry(payload.id.clone())
                    .or_insert_with(|| {
                        std::sync::Arc::new(std::sync::Mutex::new(
                            std::collections::VecDeque::new(),
                        ))
                    })
                    .clone();

                // Detect PTY resize refresh patterns that would overwrite content when replayed.
                // Key distinction:
                // - Initial setup: has clear screen (\x1b[2J) - should be STORED
                // - Resize refresh: has window manipulation (ends with 't') then cursor home - should be SKIPPED
                //
                // Resize refresh looks like: \x1b[?25l\x1b[8;20;115t\x1b[HPowerShell...
                // Initial setup looks like: \x1b[?9001h...\x1b[?25l\x1b[2J\x1b[m\x1b[HPowerShell...
                let mut idx = std::cmp::min(100, data_str.len());
                while idx > 0 && !data_str.is_char_boundary(idx) {
                    idx -= 1;
                }
                let check_prefix = &data_str[..idx];

                // Window manipulation (CSI Ps t) followed by cursor home is the key resize indicator
                // Pattern: ...t\x1b[H (e.g., \x1b[8;20;115t\x1b[H)
                let has_window_manip_then_home = check_prefix.contains("t\x1b[H");

                // Also detect hide cursor + cursor home WITHOUT clear screen (resize refresh)
                let has_hide_cursor = check_prefix.contains("\x1b[?25l");
                let has_cursor_home = check_prefix.contains("\x1b[H");
                let has_clear_screen = check_prefix.contains("\x1b[2J");

                // Resize refresh: has hide cursor + cursor home but NO clear screen
                let is_resize_without_clear = has_hide_cursor && has_cursor_home && !has_clear_screen;

                // Skip if:
                // 1. Window manipulation followed by cursor home (definite resize)
                // 2. Hide cursor + cursor home without clear screen (resize redraw)
                let is_full_refresh = has_window_manip_then_home || is_resize_without_clear;

                {
                    // Recover a poisoned mutex instead of skipping: a panic while
                    // holding it can't leave the VecDeque invalid, and silently
                    // skipping would freeze history forever (invisible to the
                    // watchdog, since the heartbeat keeps advancing). Scoped so
                    // the guard drops before the map double-check below.
                    let mut history = match history_arc.lock() {
                        Ok(guard) => guard,
                        Err(poisoned) => {
                            log::warn!(
                                "[PIPELINE] history mutex poisoned for {}; recovering",
                                payload.id
                            );
                            poisoned.into_inner()
                        }
                    };
                    if is_full_refresh {
                        log::debug!(
                            "Full screen refresh pattern detected (len={}, skipping history storage)",
                            data_str.len()
                        );
                        // Skip storing resize refresh chunks to history.
                        // These chunks contain cursor HOME (\x1b[H) which overwrites content
                        // when replayed from API.
                    } else {
                        // Store normal chunks (non-resize-refresh output)
                        history.push_back(data_str.clone());

                        // Cap history at 500 chunks (not lines) to limit memory
                        // Each chunk can contain multiple lines
                        while history.len() > 500 {
                            history.pop_front();
                        }

                        // Also cap total size to ~1MB
                        let mut total_size: usize = history.iter().map(|s| s.len()).sum();
                        while total_size > 1_000_000 && history.len() > 1 {
                            if let Some(removed) = history.pop_front() {
                                total_size -= removed.len();
                            }
                        }
                    }
                }

                // Mark this terminal's scrollback dirty for the next flush. Only when
                // we actually stored a chunk (resize-refresh frames are skipped above
                // and must not trip a write). Harmless if the double-check below then
                // removes the terminal — the flush skips vanished terminals.
                if !is_full_refresh {
                    state.history_dirty.insert(payload.id.clone(), ());
                }

                // Double-check after the insert: cleanup_terminal_state may have
                // run between the contains_key above and the entry insert,
                // orphaning the entry we just (re)created. Either ordering is now
                // covered — cleanup-before-insert is caught here; cleanup-after-here
                // removes the entry itself.
                if !state.terminals.contains_key(&payload.id) {
                    state.terminal_history.remove(&payload.id);
                }
            }

            // Check if test capture is enabled and capture raw output
            if state
                .test_capture_enabled
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                if let Some(test_id) = state.test_capture_id.read().as_ref() {
                    let capture_path = state
                        .test_capture_dir
                        .join(format!("backend-{}-{}.txt", test_id, payload.id));

                    // Append to file (don't overwrite - we want full history)
                    use std::io::Write;
                    if let Ok(mut file) = std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(&capture_path)
                    {
                        let _ = file.write_all(data_str.as_bytes());
                    }
                }
            }

            // Coalesce the renderer emit (see top of loop): buffer per-id and flush on a
            // short deadline, or immediately once large, so a TUI's back-to-back frames
            // reach the webview as one write. feed_screen/history/heartbeat above already
            // ran per-chunk, so the authoritative state is unaffected by this batching.
            emit_buf
                .entry(payload.id.clone())
                .or_default()
                .push_str(&data_str);
            if emit_buf.values().map(|s| s.len()).sum::<usize>() >= EMIT_FLUSH_BYTES {
                for (id, data) in emit_buf.drain() {
                    let _ = state.app_handle.emit(
                        "terminal:data",
                        serde_json::json!({ "id": id, "data": data }),
                    );
                }
                flush_at = None;
            } else if flush_at.is_none() {
                flush_at = Some(
                    tokio::time::Instant::now()
                        + tokio::time::Duration::from_millis(EMIT_COALESCE_MS),
                );
            }
        }
        log::info!("[PIPELINE] output consumer (gen {}) exited", generation);
    });
}

/// Watchdog: every 3s compare the producer/consumer counters; two consecutive
/// "produced advanced but consumed didn't" ticks (~6s of stalled delivery while
/// terminals are actively producing) trigger auto-heal — bump the generation,
/// respawn the consumer, notify the renderer, and force a repaint so terminals
/// visibly recover the frames lost while stalled.
fn spawn_pipeline_watchdog(state: AppState) {
    tauri::async_runtime::spawn(async move {
        let mut last_produced = 0u64;
        let mut last_consumed = 0u64;
        let mut ticks = 0u8;
        // Consecutive heals with zero consumer progress in between. If the
        // respawned consumer wedges on the same root cause every time, stop
        // spawning (each heal leaks the wedged task) and leave a loud log.
        let mut heals_without_progress = 0u32;
        const MAX_FRUITLESS_HEALS: u32 = 10;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            let produced = state
                .output_produced
                .load(std::sync::atomic::Ordering::Relaxed);
            let consumed = state
                .output_consumed
                .load(std::sync::atomic::Ordering::Relaxed);
            if consumed != last_consumed {
                // Consumer made progress — healing (if any) worked.
                heals_without_progress = 0;
            }
            ticks = stall_ticks(produced, consumed, last_produced, last_consumed, ticks);
            last_produced = produced;
            last_consumed = consumed;
            if ticks >= 2 {
                ticks = 0;
                if heals_without_progress >= MAX_FRUITLESS_HEALS {
                    if heals_without_progress == MAX_FRUITLESS_HEALS {
                        heals_without_progress += 1;
                        log::error!(
                            "[PIPELINE] consumer still stalled after {} heals; auto-heal disabled (restart the app)",
                            MAX_FRUITLESS_HEALS
                        );
                    }
                    continue;
                }
                heals_without_progress += 1;
                let gen = state
                    .consumer_generation
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                    + 1;
                log::error!(
                    "[PIPELINE] output consumer stalled (produced={} consumed={}); auto-heal engaging (gen {})",
                    produced,
                    consumed,
                    gen
                );
                spawn_output_consumer(state.clone(), gen);
                if let Err(e) = state.app_handle.emit(
                    "terminal:pipeline-healed",
                    serde_json::json!({ "generation": gen }),
                ) {
                    log::warn!("[PIPELINE] failed to emit pipeline-healed: {}", e);
                }
                // interval 0 = always repaint, but stamp the debounce window so
                // a Lagged event right after the heal doesn't double-jiggle.
                state.repaint_all_terminals_debounced(0);
            }
        }
    });
}

/// Resolve this instance's history DB path under the app data dir (dev/prod split,
/// mirroring app_config's instance filenames). Creates the dir. None on failure.
fn history_db_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    let name = if crate::app_config::is_dev() { "history.dev.db" } else { "history.db" };
    Some(dir.join(name))
}

/// Persist one terminal's RENDERED screen under its renderer id (tab_id).
/// Skips terminals that are gone or have no renderer id (e.g. API-created PTYs).
///
/// We persist the authoritative vt100 parser's FULL buffer (scrollback + visible
/// screen) rendered as styled lines — NOT the raw PTY byte stream. Raw replay is
/// broken for full-screen TUIs (codex, vim, htop): they redraw in place with absolute
/// cursor addressing + screen clears sized to the old terminal, so concatenating the
/// raw chunks into a fresh, possibly resized xterm paints garbage. The parser has
/// already resolved every chunk (fed unconditionally in the output consumer, before
/// the history filter) into a flat grid plus scrollback; rendering each row as its own
/// line (no screen-clear) reproduces the entire session history. 2J-cleared transient
/// frames never enter scrollback, so this stays TUI-safe (see render_full_scrollback).
fn persist_terminal_history(state: &AppState, id: &str, now_ms: i64) {
    let Some(tab_id) = state.terminals.get(id).and_then(|t| t.tab_id.clone()) else { return };
    // Skip when the parser is absent or the whole buffer is blank (brand-new or
    // already-cleared terminal) so we never persist a blank blob that would replay as
    // an empty "session restored" divider with nothing above it.
    let Some(snapshot) = state.full_scrollback_snapshot(id) else { return };
    let blob = String::from_utf8_lossy(&snapshot).into_owned();
    state.history_store.upsert(&tab_id, std::slice::from_ref(&blob), now_ms);
}

/// Drain the dirty set, writing each changed terminal once (called every 30s).
fn flush_dirty_history(state: &AppState) {
    let now = chrono::Utc::now().timestamp_millis();
    let ids: Vec<String> = state.history_dirty.iter().map(|e| e.key().clone()).collect();
    for id in ids {
        state.history_dirty.remove(&id);
        persist_terminal_history(state, &id, now);
    }
}

/// Flush EVERY live terminal (called once on graceful exit so the last <30s of
/// output survives even if it never tripped the interval).
fn flush_all_history(state: &AppState) {
    let now = chrono::Utc::now().timestamp_millis();
    let ids: Vec<String> = state.terminals.iter().map(|e| e.key().clone()).collect();
    for id in ids {
        persist_terminal_history(state, &id, now);
    }
}

/// Background task: flush dirty terminals' scrollback to disk every 30s. Throttled
/// (dirty-set driven) so idle terminals are never rewritten.
fn spawn_history_flush_task(state: AppState) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(30));
        loop {
            ticker.tick().await;
            flush_dirty_history(&state);
        }
    });
}

/// Build the system tray icon + menu (Plan 010). Reuses the app's default window
/// icon (no new asset). Left-click shows/focuses the main window; the context menu
/// offers Show TermFlow / Peers… / Quit. Tray failure is non-fatal (the app runs
/// without a tray), so background mode simply has no tray affordance in that case.
fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show = MenuItem::with_id(app, "tray_show", "Show TermFlow", true, None::<&str>)?;
    let peers = MenuItem::with_id(app, "tray_peers", "Peers…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray_quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &peers, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        // Left-click is handled by on_tray_icon_event (show window); the menu opens
        // on right-click only, so a left-click doesn't pop the menu instead.
        .show_menu_on_left_click(false)
        .tooltip("TermFlow")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray_show" => show_or_focus_main_window(app),
            "tray_peers" => {
                show_or_focus_main_window(app);
                // Best-effort: ask the renderer to jump to Settings → Peers. If no
                // window is listening yet the user still lands on a visible window.
                let _ = app.emit("tray:open-peers", ());
            }
            "tray_quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_or_focus_main_window(tray.app_handle());
            }
        });

    // Reuse the bundled window icon so no new asset is required.
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

/// Show + focus the app's primary window, unhiding/unminimizing it. If no real
/// window exists (e.g. the last one was torn off and destroyed while running in the
/// background), open a fresh one so the tray's Show/Peers actions always surface UI.
fn show_or_focus_main_window(app: &tauri::AppHandle) {
    let target = app.get_webview_window("main").or_else(|| {
        app.webview_windows()
            .into_iter()
            .find(|(label, _)| label.as_str() != "drag-preview")
            .map(|(_, w)| w)
    });
    if let Some(win) = target {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    } else if let Err(e) = commands::open_new_window(app, None) {
        log::warn!("Tray show: failed to open a new window: {}", e);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let args = Args::parse();
  let is_headless = args.headless;
  // Runtime-only port overrides (B5): applied to the loaded config before binding,
  // never persisted — so a second instance can start on free ports without touching
  // the shared config.json.
  let cli_api_port = args.api_port;
  let cli_mcp_port = args.mcp_port;
  let initial_open_path = args.path.or(args.positional_path);

  let mut builder = tauri::Builder::default();
  #[cfg(desktop)]
  {
    if !args.headless && args.api_port.is_none() && args.mcp_port.is_none() {
      builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        let path = Args::try_parse_from(argv)
          .ok()
          .and_then(|args| args.path.or(args.positional_path));
        if let Some(path) = path {
          if let Err(e) = commands::open_new_window(app, Some(path)) {
            log::error!("Open in TermFlow failed: {}", e);
          } else {
            commands::refresh_menu(app);
          }
        } else {
          // No path → a plain relaunch while already running: focus/raise (or recreate)
          // a window. Reuse the robust helper, which falls back to any real window and
          // creates one if none exist (e.g. tray-only or the main window was detached).
          show_or_focus_main_window(app);
        }
      }));
    }
  }

  builder
    .plugin(
      tauri_plugin_log::Builder::default()
        .level(log::LevelFilter::Info)  // Only INFO and above
        .level_for("tokio_tungstenite", log::LevelFilter::Warn)
        .level_for("tungstenite", log::LevelFilter::Warn)
        .level_for("hyper", log::LevelFilter::Warn)
        .level_for("reqwest", log::LevelFilter::Warn)
        .level_for("tower_http", log::LevelFilter::Warn)
        .build()
    )
    // Required for app_handle.shell().sidecar(...) used to launch the MCP server.
    // Without this the shell plugin state is unmanaged and `.shell()` panics
    // ("state() called before manage()"), silently killing the MCP launch task.
    .plugin(tauri_plugin_shell::init())
    // Native clipboard access (read/write) used by the renderer's paste path so it
    // never calls navigator.clipboard — which prompts the WebView clipboard popup.
    .plugin(tauri_plugin_clipboard_manager::init())
    // Native file picker for the Settings "Default editor" Browse… button.
    .plugin(tauri_plugin_dialog::init())
    // OS notifications (Plan 010): a native toast when a pairing request arrives
    // while no window is focused (tray/background mode).
    .plugin(tauri_plugin_notification::init())
    // Launch-at-login (Settings → Startup & Integration). LaunchAgent on macOS; Run
    // key on Windows; autostart .desktop on Linux. No launch args — a login start is
    // a normal GUI launch. Enable/disable/isEnabled are driven from the renderer.
    .plugin(tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        None,
    ))
    .setup(move |app| {
        // Unpackaged Windows apps need an AUMID registered before WinRT can
        // attribute and deliver native toast notifications. This is idempotent
        // and deliberately non-fatal so a registry policy cannot prevent launch.
        if let Err(e) = crate::native_notify::register_app_for_notifications() {
            log::warn!("Failed to register native notification identity: {}", e);
        }

        // Handle headless mode
        if is_headless {
            if let Some(window) = app.get_webview_window("main") {
                if let Err(e) = window.hide() {
                    log::error!("Failed to hide window in headless mode: {}", e);
                }
            } else {
                 // Try get_webview_window for Tauri v2 if get_window fails/not found? 
                 // Actually get_window is generic method on Manager. 
                 // In v2 it returns WebviewWindow. In v1 Window.
            }
            println!("Starting in HEADLESS mode (GUI hidden)");
        }

        // Channel for PTY output, shared by ALL terminals. Capacity must absorb
        // multi-terminal output bursts: at 100 slots a single `cargo build` could
        // fill it in milliseconds and Lagged receivers silently drop chunks
        // (WS clients + the terminal:data emit). 2048 × ≤4KB chunks ≈ 8MB cap.
        let (tx, _rx) = broadcast::channel(2048);

        // Load this instance's persisted network config (dev vs prod isolated by
        // filename + default ports). A freshly-generated token is persisted here.
        let mut network = crate::app_config::load_or_init(&app.handle());
        // Apply runtime-only CLI port overrides (not persisted) so a second instance
        // can launch on free ports without editing the shared config.
        if let Some(p) = cli_api_port {
            log::info!("[CONFIG] --api-port override: {} -> {}", network.api_port, p);
            network.api_port = p;
        }
        if let Some(p) = cli_mcp_port {
            log::info!("[CONFIG] --mcp-port override: {} -> {}", network.mcp_port, p);
            network.mcp_port = p;
        }
        log::info!(
            "[CONFIG] instance={} api_port={} mcp_port={} expose={}",
            crate::app_config::instance_config_name(),
            network.api_port, network.mcp_port, network.expose_on_network
        );

        // Initialize AppState with app handle + network config
        let state = AppState::new(tx, app.handle().clone(), network.clone());

        if let Some(path) = initial_open_path.clone() {
            match state.pending_open_path.lock() {
                Ok(mut pending) => *pending = Some(path),
                Err(e) => log::error!("Failed to store pending open path: {}", e),
            }
        }

        // Manage state in Tauri
        app.manage(state.clone());

        // Seed the background-mode flag from persisted settings (Plan 010) BEFORE any
        // window can close, so the exit guard reads the user's saved choice. The
        // renderer re-hydrates the same value into its toggle at boot.
        if let Some(keep) =
            crate::app_config::read_bool_setting(&app.handle(), "keepRunningInBackground")
        {
            state
                .keep_running_in_background
                .store(keep, std::sync::atomic::Ordering::Relaxed);
        }

        // System tray (Plan 010): reuse the app's window icon (no new asset). Left-
        // click shows/focuses the main window; the menu offers Show / Peers / Quit.
        // Failure is non-fatal — the app still runs without a tray.
        if let Err(e) = build_tray(app.handle()) {
            log::warn!("Failed to build system tray: {}", e);
        }

        // Build the app menu (File > New Window, Edit, and a Window submenu that
        // lists every open window). Rebuilt on window create/destroy/title-change.
        commands::refresh_menu(&app.handle());

        // Trim the WebView2 right-click menu (Windows) to Print + Inspect on the
        // primary window. New windows install the same filter at build time.
        if let Some(main) = app.get_webview_window("main") {
            crate::context_menu::install(&main);
            // Detect RDP/console session switches (Windows) and tell the renderer to
            // suppress the resulting ConPTY repaint burst — otherwise the activity
            // bell rings on every tab when you return to the machine. The DOM
            // visibilitychange path does NOT cover session connect/disconnect.
            crate::session_notify::install(&main, app.handle().clone());
        }

        // Get app handle for emitting events
        let app_handle = app.handle().clone();
        
        // Spawn API Server (REST + WebSocket on one port) from the loaded config. The
        // MCP sidecar is started INSIDE this task, only after the API-ownership check
        // passes — see the conflict branch below for why.
        let api_state = state.clone();
        let api_net = network.clone();
        let mcp_app_handle = app_handle.clone();
        let mcp_net = network.clone();
        // App handle for the fabric peering sidecar, spawned alongside MCP once the
        // API port is confirmed ours (the fabric calls back into the local API).
        let fabric_app_handle = app_handle.clone();
        let (api_sd_tx, api_sd_rx) = tokio::sync::oneshot::channel();
        if let Ok(mut g) = api_state.api_shutdown.lock() {
            *g = Some(api_sd_tx);
        }
        tauri::async_runtime::spawn(async move {
            let host = if api_net.expose_on_network { [0, 0, 0, 0] } else { [127, 0, 0, 1] };
            let addr = std::net::SocketAddr::from((host, api_net.api_port));
            // P0b: refuse to start if another instance already owns this port. With
            // SO_REUSEADDR our bind would otherwise SUCCEED and hijack the port, so we
            // probe /health first. We ALSO skip the MCP sidecar here: MCP forwards
            // every tool call to AUTO_TERMINAL_API_URL (= this api_port), so starting
            // it while the port belongs to ANOTHER instance would silently route MCP
            // operations into the other app. The Settings health check surfaces the
            // conflict and lets the user pick a different port (or use --api-port).
            if matches!(
                crate::network_commands::probe_port_owner(api_net.api_port, &api_state.instance_id).await,
                crate::network_commands::PortOwner::OwnedByOther
            ) {
                log::warn!(
                    "API port {} is already owned by another instance — not starting the API or MCP servers. \
                     Change the port in Settings > Connections (or pass --api-port) to run a second instance.",
                    api_net.api_port
                );
                return;
            }
            // Bind with SO_REUSEADDR (same path as the hot-restart) so the very
            // first "Save & apply (restart)" can rebind this same port even while
            // this initial socket is still lingering. A plain TcpListener::bind
            // would leave it non-reuse on Windows, and the SO_REUSEADDR rebind
            // would then fail with WSAEACCES (os error 10013). See bind_reuseaddr.
            match crate::network_commands::bind_reuseaddr(addr) {
                Ok(listener) => {
                    // Bound successfully → the API port is genuinely ours. Only NOW
                    // start the MCP sidecar (which forwards every tool call to this
                    // API), so a bind failure AFTER a Free/Self probe (cold-start
                    // race, stale non-HTTP process, permission error) can never leave
                    // a sidecar advertising our instanceId while pointing at a port we
                    // don't own.
                    let mcp_state = api_state.clone();
                    tauri::async_runtime::spawn(async move {
                        respawn_mcp(mcp_app_handle, mcp_state, &mcp_net).await;
                    });
                    // Spawn the peering fabric sidecar. Spawn failure (binary absent /
                    // not bundled) is logged and NON-FATAL — the open-core app runs
                    // fine with peering "not installed".
                    let fabric_state = api_state.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) =
                            crate::fabric_manager::start_fabric(fabric_app_handle, fabric_state)
                                .await
                        {
                            log::warn!(
                                "[FABRIC] termflow-fabric not started (peering not installed): {}",
                                e
                            );
                        }
                    });
                    crate::api_server::start_api_server(
                        api_state,
                        listener,
                        api_net.expose_on_network,
                        api_sd_rx,
                    )
                    .await;
                }
                Err(e) => log::error!("API bind failed on {}: {}", addr, e),
            }
        });
        
        // Spawn the PTY Output Listener (consumer generation 0) and the stall
        // watchdog that auto-heals it (respawn + repaint) if it ever wedges.
        // The consumer subscribes to the broadcast channel via state.output_tx.
        spawn_output_consumer(state.clone(), 0);
        spawn_pipeline_watchdog(state.clone());

        // Open the scrollback DB and start the 30s throttled flush task.
        if let Some(db) = history_db_path(&app.handle()) {
            state.history_store.init(&db);
            // Backlog 011: cap the global command history at startup.
            state.history_store.prune_commands(5000);
            // Stream 4: per-directory usage has higher (command,dir) cardinality; cap larger.
            state.history_store.prune_dir_usage(20000);
        }
        spawn_history_flush_task(state.clone());

        Ok(())
    })
    .invoke_handler(tauri::generate_handler![
        commands::create_terminal,
        commands::get_active_window,
        commands::set_active_window,
        commands::get_terminal_cwd,
        commands::get_terminal_cwds,
        commands::resolve_terminal_path,
        commands::get_os_build_number,
        open_commands::open_external,
        open_commands::open_path,
        open_commands::open_in_editor,
        commands::write_terminal,
        commands::resize_terminal,
        commands::get_terminal_size,
        commands::get_shell_profiles,
        commands::read_legal_document,
        commands::quit_app,
        commands::save_config,
        commands::load_config,
        commands::close_terminal,
        commands::prune_terminal_history,
        commands::add_command_history,
        commands::load_command_history,
        commands::delete_command_history,
        commands::add_command_dir_usage,
        commands::load_command_dir_usage,
        commands::show_activity_notification,
        commands::check_connection_health,
        commands::generate_api_token,
        network_commands::get_network_config,
        network_commands::set_network_config,
        network_commands::rotate_auth_token,
        network_commands::list_network_interfaces,
        network_commands::stop_servers,
        network_commands::start_servers,
        commands::diag_log,
        commands::confirm_close_app,
        commands::stash_detach_payload,
        commands::take_detach_payload,
        commands::create_detached_window,
        commands::begin_global_pane_drag,
        commands::claim_global_pane_drag,
        commands::resolve_orphan_global_drag,
        commands::cancel_global_pane_drag,
        commands::show_drag_preview,
        commands::move_drag_preview,
        commands::hide_drag_preview,
        commands::resolve_tab_drop,
        commands::create_new_window,
        commands::take_pending_open_path,
        shell_integration::install_file_manager_integration,
        shell_integration::uninstall_file_manager_integration,
        shell_integration::is_file_manager_integration_installed,
        commands::get_executable_icon,
        commands::refresh_window_menu,
        commands::set_window_title,
        commands::close_self_window,
        commands::set_keep_running_in_background,
        peer_commands::fabric_status,
        peer_commands::peers_list,
        peer_commands::pending_approvals_list,
        peer_commands::pairing_code_create,
        peer_commands::peer_add,
        peer_commands::peer_approve,
        peer_commands::peer_revoke,
        peer_commands::peer_set_grant,
        peer_commands::set_accept_peers,
        peer_commands::peer_set_fleet_exec
    ])
    .on_menu_event(|app, event| {
        let id = event.id().as_ref();
        if id == "new_window" {
            match commands::open_new_window(app, None) {
                Ok(_) => commands::refresh_menu(app),
                Err(e) => log::error!("New Window failed: {}", e),
            }
        } else if let Some(label) = id.strip_prefix("focus:") {
            // Window menu entry: bring that window to the front.
            if let Some(w) = app.get_webview_window(label) {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }
    })
    .on_window_event(|window, event| {
        // Intercept the native window close so the frontend can show an in-app
        // confirmation dialog. The actual exit happens via confirm_close_app.
        if let WindowEvent::CloseRequested { api, .. } = event {
            let app = window.app_handle();
            // Background mode (Plan 010): when "keep running in background" is on and
            // this is the LAST real window, hide it to the tray instead of prompting
            // to quit — the process (and peering) stays alive and the tray brings it
            // back. Earlier windows still go through the normal confirm-close flow.
            // Gated on a tray existing so we never hide the only window with no way
            // to reopen it.
            if window.label() != "drag-preview" && app.tray_by_id("main-tray").is_some() {
                let keep = app
                    .try_state::<AppState>()
                    .map(|s| {
                        s.keep_running_in_background
                            .load(std::sync::atomic::Ordering::Relaxed)
                    })
                    .unwrap_or(false);
                if keep {
                    let real_windows = app
                        .webview_windows()
                        .keys()
                        .filter(|l| l.as_str() != "drag-preview")
                        .count();
                    if real_windows <= 1 {
                        api.prevent_close();
                        if let Err(e) = window.hide() {
                            log::warn!("Failed to hide window to tray: {}", e);
                        }
                        return;
                    }
                }
            }
            api.prevent_close();
            // The frontend's global `listen` receives this in EVERY window
            // regardless of emit target, so we carry the closing window's label in
            // the payload and each window ignores it unless it's the target.
            let label = window.label().to_string();
            if let Err(e) = window.emit("app:close-requested", label.clone()) {
                log::warn!("Failed to emit app:close-requested for {}: {}", label, e);
            }
        }
        // A window went away — drop its recorded title and refresh the Window menu
        // so it no longer lists it.
        if let WindowEvent::Destroyed = event {
            let app = window.app_handle();
            if let Some(state) = app.try_state::<AppState>() {
                state.window_titles.remove(window.label());
                // If the window that just closed was the API/MCP target, re-point the
                // active window at a still-live window and notify every window so their
                // titlebar indicators don't strand on a dead label.
                if state.active_window.read().as_str() == window.label() {
                    let resolved = state.resolve_active_window_label_excluding(window.label());
                    *state.active_window.write() = resolved.clone();
                    use tauri::Emitter;
                    let _ = app.emit("active-window:changed", resolved);
                }
            }
            commands::refresh_menu(app);
            // Quit the whole app once the last *real* window is gone. Without this,
            // closing the final window via the destroy path (or dragging out its
            // last tab) leaves the process alive — the hidden `drag-preview` window
            // keeps it running — which orphans the backend + MCP sidecar (lingering
            // processes, a held API port). Only the preview may remain → exit.
            if window.label() != "drag-preview" {
                let real_windows = app
                    .webview_windows()
                    .keys()
                    .filter(|l| l.as_str() != "drag-preview")
                    .count();
                if real_windows == 0 {
                    // Background mode (Plan 010): if "keep running in background" is on
                    // and a tray exists to bring the app back, stay alive (peering
                    // keeps running) instead of exiting. This covers destroy paths that
                    // bypass CloseRequested's hide (tab tear-off, close_self_window).
                    let keep = app
                        .try_state::<AppState>()
                        .map(|s| {
                            s.keep_running_in_background
                                .load(std::sync::atomic::Ordering::Relaxed)
                        })
                        .unwrap_or(false);
                    if keep && app.tray_by_id("main-tray").is_some() {
                        log::info!(
                            "Last window destroyed but keep-running-in-background is on; staying alive in the tray."
                        );
                    } else {
                        log::info!("Last window destroyed; exiting app to avoid orphaned processes.");
                        app.exit(0);
                    }
                }
            }
        }
        // Focus changed — refresh so the active window's checkmark moves.
        if let WindowEvent::Focused(true) = event {
            commands::refresh_menu(window.app_handle());
        }
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app_handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<AppState>() {
                // Persist every terminal's scrollback before the process dies.
                flush_all_history(&state);
                // Gracefully shutdown MCP server on app exit
                shutdown_mcp_server(&state);
                // Gracefully shutdown the peering fabric sidecar on app exit.
                crate::fabric_manager::shutdown_fabric(&state);
            }
        }
    });
}

#[cfg(test)]
mod pipeline_tests {
    use super::stall_ticks;

    #[test]
    fn stall_tick_increments_when_producing_but_not_consuming() {
        // produced advanced, consumed frozen -> tick
        assert_eq!(stall_ticks(10, 5, 8, 5, 0), 1);
        assert_eq!(stall_ticks(12, 5, 10, 5, 1), 2);
    }

    #[test]
    fn stall_ticks_reset_when_consumer_advances() {
        // consumer moved -> healthy, reset
        assert_eq!(stall_ticks(12, 6, 10, 5, 1), 0);
    }

    #[test]
    fn stall_ticks_reset_when_idle() {
        // nothing produced -> not a stall (idle terminals are fine)
        assert_eq!(stall_ticks(10, 5, 10, 5, 1), 0);
    }

    #[test]
    fn stall_ticks_saturate_instead_of_overflowing() {
        assert_eq!(stall_ticks(10, 5, 8, 5, u8::MAX), u8::MAX);
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
}
