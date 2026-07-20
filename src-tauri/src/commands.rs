use tauri::State;
use crate::state::AppState;
use crate::pty_manager;
use jsonwebtoken::{encode, Header, EncodingKey};
use serde::{Deserialize, Serialize};
use chrono::{Utc, Duration};
use std::collections::HashMap;
use std::io::Write;
use sysinfo::System;

#[tauri::command]
pub async fn get_shell_profiles() -> Result<Vec<pty_manager::ShellProfile>, String> {
    Ok(pty_manager::get_available_shells())
}

/// Filenames the [`read_legal_document`] command may resolve, bundled under `legal/` as
/// Tauri resources (see `bundle.resources` in `tauri.conf.json` / `tauri.pro.conf.json`).
/// A fixed whitelist so a caller can never resolve an arbitrary path.
pub const LEGAL_DOCUMENTS: &[&str] = &[
    "EULA.txt",
    "PRIVACY.txt",
    "LICENSE-apache-2.0.txt",
    "LICENSE-fabric-fsl.txt",
    "THIRD-PARTY-NOTICES.txt",
];

/// Read a bundled legal/agreement document shipped as a Tauri resource under `legal/`.
/// Drives the About & Legal panel and the first-run EULA modal. Only whitelisted names
/// resolve; a missing resource (e.g. the Pro-only FSL text in an OSS build) is a clear Err
/// the UI treats as "not included in this build".
#[tauri::command]
pub async fn read_legal_document(app: tauri::AppHandle, name: String) -> Result<String, String> {
    use tauri::Manager;
    if !LEGAL_DOCUMENTS.contains(&name.as_str()) {
        return Err(format!("unknown legal document: {name}"));
    }
    let path = app
        .path()
        .resolve(format!("legal/{name}"), tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("resolve {name}: {e}"))?;
    std::fs::read_to_string(&path).map_err(|e| format!("{name} is not available in this build: {e}"))
}

/// Windows OS build number (e.g. 26200) for xterm's `windowsPty.buildNumber`, so the
/// terminal's ConPTY wrapping/reflow heuristics match the real backend (builds >= 21376
/// disable the legacy heuristic that corrupts full-width TUIs like codex). Returns 0 on
/// non-Windows or if it can't be determined — the frontend then assumes a modern build.
#[cfg(windows)]
#[tauri::command]
pub fn get_os_build_number() -> u32 {
    // sysinfo reads the version via RtlGetVersion under the hood. The string format
    // varies ("10.0.26200", "26200", "11 (26200)"), so take the largest numeric token —
    // the build number always dwarfs the major/minor components.
    let combined = format!(
        "{} {}",
        sysinfo::System::os_version().unwrap_or_default(),
        sysinfo::System::kernel_version().unwrap_or_default()
    );
    combined
        .split(|c: char| !c.is_ascii_digit())
        .filter_map(|t| t.parse::<u32>().ok())
        .max()
        .unwrap_or(0)
}

#[cfg(not(windows))]
#[tauri::command]
pub fn get_os_build_number() -> u32 {
    0
}

#[tauri::command]
pub async fn create_terminal(
    state: State<'_, AppState>,
    cols: u16,
    rows: u16,
    profile_id: Option<String>,
    cwd: Option<String>,
    tab_id: Option<String>,
) -> Result<String, String> {
    let profiles = pty_manager::get_available_shells();
    let mut shell_name = "default".to_string();

    // Resolve the requested profile by id/name. The UI sends "default" as a
    // placeholder when no profile is chosen, which matches no real profile — so
    // when the id is missing OR unknown we fall back to the `is_default` profile
    // (e.g. zsh on macOS) rather than to a bare system shell (which on macOS is
    // the old /bin/bash, producing the "default interactive shell is now zsh" note).
    let chosen = match profile_id.as_deref() {
        Some(id) => profiles
            .iter()
            .find(|p| p.id == id || p.name.eq_ignore_ascii_case(id)),
        None => None,
    }
    .or_else(|| profiles.iter().find(|p| p.is_default));

    let (shell_path, shell_args, shell_cwd) = if let Some(profile) = chosen {
        shell_name = profile.id.clone();
        let effective_cwd = if cwd.is_some() { cwd } else { profile.cwd.clone() };
        (Some(profile.path.clone()), Some(profile.args.clone()), effective_cwd)
    } else {
        // No profiles at all — let spawn_terminal pick a system fallback.
        (None, None, cwd)
    };
    
    let terminal_name = format!("Terminal-{}", shell_name);

    // Opt-in PTY-host sidecar path (Windows). Requires a stable tab_id as the
    // reattach key; without one we fall through to the in-process path.
    if crate::pty_host_client::enabled() {
        if let Some(tid) = tab_id.clone() {
            return create_host_terminal(
                state.inner(),
                tid,
                cols,
                rows,
                shell_path,
                shell_name,
                shell_args,
                shell_cwd,
            )
            .await;
        }
    }

    let id = pty_manager::spawn_terminal(
        state.inner().clone(),
        cols,
        rows,
        shell_path,
        shell_args,
        shell_cwd,
        shell_name,
        terminal_name
    )?;

    if let Some(tab_id) = tab_id {
        if let Some(mut entry) = state.terminals.get_mut(&id) {
            entry.tab_id = Some(tab_id.clone());
        }
        // Restore path: if this renderer id has scrollback persisted from a prior
        // session, stage it as a one-shot prefix. The /snapshot endpoint prepends it
        // on this terminal's first hydration, so the engine's existing reset()+write
        // replay shows "old scrollback → divider → fresh prompt" with no engine change.
        if let Some(chunks) = state.history_store.get(&tab_id) {
            if !chunks.is_empty() {
                let mut prefix = chunks.concat();
                prefix.push_str(crate::state::REPLAY_SEPARATOR);
                state.replay_prefix.insert(id.clone(), prefix);
            }
        }
    }

    Ok(id)
}

/// Spawn a terminal hosted by the PTY-host sidecar. The app terminalId IS the
/// stable `tab_id` (the reattach key), so the sidecar session, the output
/// broadcast id, and the vt100 screen key all align — live routing works with
/// no change to the output pipeline, and reattach-by-tab_id after a hot-swap is
/// consistent. On failure, falls back to the in-process spawn path.
#[allow(clippy::too_many_arguments)]
async fn create_host_terminal(
    state: &AppState,
    id: String,
    cols: u16,
    rows: u16,
    shell_path: Option<String>,
    shell_name: String,
    shell_args: Option<Vec<String>>,
    cwd: Option<String>,
) -> Result<String, String> {
    // Reattach path: if the sidecar already holds this session (survived a
    // hot-swap), attach + replay instead of spawning a fresh shell.
    if state.ensure_pty_host().await.is_ok() && state.host_reattach_pending.remove(&id).is_some() {
        if let Some(client) = state.pty_host_clone() {
            state.terminals.insert(
                id.clone(),
                crate::state::Terminal {
                    id: id.clone(),
                    pid: 0, // real pid not carried across reattach (milestone A)
                    shell: shell_name.clone(),
                    name: format!("Terminal-{}", shell_name),
                    created_at: chrono::Local::now().to_rfc3339(),
                    cols,
                    rows,
                    backend: crate::tmux_manager::TerminalBackend::PortablePty,
                    tab_id: Some(id.clone()),
                    last_input_source: None,
                    last_input_at: None,
                },
            );
            state.init_screen(&id, rows, cols);
            state.host_terminals.insert(id.clone(), ());
            // Register routing BEFORE attach releases replay bytes, then nudge a
            // repaint so a live TUI redraws into the reconstructed screen.
            client.attach(&id, 0);
            client.nudge_repaint(&id, cols, rows);
            return Ok(id);
        }
    }

    // Connect (or spawn) the sidecar, then spawn the session.
    let host_result = async {
        state.ensure_pty_host().await?;
        let client = state
            .pty_host_clone()
            .ok_or_else(|| "pty-host not connected".to_string())?;
        let spec = pty_manager::build_spawn_spec(
            &id,
            shell_path.as_deref(),
            &shell_name,
            shell_args.as_deref(),
            cwd.as_deref(),
            cols,
            rows,
        );
        let pid = client.spawn_session(&id, &spec).await?;
        Ok::<u32, String>(pid)
    }
    .await;

    let pid = match host_result {
        Ok(pid) => pid,
        Err(e) => {
            // Graceful fallback: a missing sidecar / connect failure must not
            // break terminal creation — spawn in-process instead.
            log::warn!("pty-host spawn failed ({e}); falling back to in-process");
            let name = format!("Terminal-{}", shell_name);
            let fallback_id = pty_manager::spawn_terminal(
                state.clone(),
                cols,
                rows,
                shell_path,
                shell_args,
                cwd,
                shell_name,
                name,
            )?;
            if let Some(mut entry) = state.terminals.get_mut(&fallback_id) {
                entry.tab_id = Some(id);
            }
            return Ok(fallback_id);
        }
    };

    // Register the host-owned terminal. Keyed by the stable id (== tab_id).
    state.terminals.insert(
        id.clone(),
        crate::state::Terminal {
            id: id.clone(),
            pid,
            shell: shell_name.clone(),
            name: format!("Terminal-{}", shell_name),
            created_at: chrono::Local::now().to_rfc3339(),
            cols,
            rows,
            backend: crate::tmux_manager::TerminalBackend::PortablePty,
            tab_id: Some(id.clone()),
            last_input_source: None,
            last_input_at: None,
        },
    );
    state.init_screen(&id, rows, cols);
    state.host_terminals.insert(id.clone(), ());

    // Restore path: stage persisted scrollback as a one-shot prefix (same as the
    // in-process path — the /snapshot endpoint prepends it on first hydration).
    if let Some(chunks) = state.history_store.get(&id) {
        if !chunks.is_empty() {
            let mut prefix = chunks.concat();
            prefix.push_str(crate::state::REPLAY_SEPARATOR);
            state.replay_prefix.insert(id.clone(), prefix);
        }
    }

    Ok(id)
}

/// Arm the sidecar hot-swap hold and quit the app so its `.exe` unlocks for a
/// rebuild. The sidecar keeps every PTY (and its CLI) alive; the next launch
/// reattaches. Refuses if the sidecar isn't connected or couldn't break away
/// from a kill-on-close job (survival not guaranteed).
#[tauri::command]
pub async fn restart_for_update(state: State<'_, AppState>) -> Result<(), String> {
    let client = state
        .pty_host_clone()
        .ok_or_else(|| "pty-host not connected — nothing to keep alive".to_string())?;
    if !client.survives_hotswap() {
        return Err(
            "hot-swap unavailable: the sidecar could not break away from a kill-on-close job"
                .to_string(),
        );
    }
    let token = crate::pty_host_client::resolve_token();
    // Arm and WAIT for the ack so we know the sidecar durably armed BEFORE we
    // exit and drop the pipe (10-minute safety window).
    client.arm_detach(600, &token).await?;
    log::info!("pty-host: armed hot-swap hold; exiting to release the .exe lock");
    state.app_handle.exit(0);
    Ok(())
}

/// The window label that API/MCP-created terminals currently route to (normalized to
/// a live window). The titlebar indicator reads this to show its ◉/○ state.
#[tauri::command]
pub fn get_active_window(state: State<'_, AppState>) -> String {
    state.resolve_active_window_label()
}

/// Make `label` the window that receives API/MCP-created terminals. Normalizes to a
/// live window, then broadcasts `active-window:changed` so every window's indicator
/// updates. Only one window is the target at a time.
#[tauri::command]
pub fn set_active_window(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    label: String,
) -> Result<(), String> {
    use tauri::Emitter;
    *state.active_window.write() = label;
    let resolved = state.resolve_active_window_label();
    *state.active_window.write() = resolved.clone();
    let _ = app.emit("active-window:changed", resolved);
    Ok(())
}

/// Best-effort current working directory of a terminal (backlog 004). Prefers the
/// shell-reported cwd parsed from OSC sequences (authoritative for PowerShell, whose
/// process cwd is not live), then falls back to the OS process cwd (cmd / Unix
/// shells keep that current). Returns `Ok(None)` for an unknown terminal or when
/// neither source has a value, so the renderer falls back to the app default.
///
/// The OSC hit is a cheap map lookup and stays on the async worker. The FALLBACK is
/// not: `get_process_cwd` runs a full `System::new_all()` scan (every process, plus a
/// re-scan per descendant generation), so it runs on a blocking worker — exactly as
/// `resolve_terminal_path` below does, and for the same reason. This command is fanned
/// out ONE INVOKE PER LIVE TERMINAL by the renderer's 30s cwd refresh, and every
/// non-PowerShell shell (cmd/WSL/bash/zsh — the OSC injection is PowerShell-only) takes
/// the fallback EVERY time. Left on the async pool, N concurrent scans would starve the
/// shared tokio workers that `write_terminal`/`resize_terminal` need, stalling
/// keystrokes and resizes.
#[tauri::command]
pub async fn get_terminal_cwd(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<String>, String> {
    if let Some(cwd) = state.terminal_cwds.get(&id) {
        return Ok(Some(cwd.value().clone()));
    }
    // Read the pid off `state` BEFORE the closure: `State` is not Send into it.
    let pid = match state.terminals.get(&id) {
        Some(t) => t.pid,
        None => return Ok(None),
    };
    tokio::task::spawn_blocking(move || pty_manager::get_process_cwd(pid))
        .await
        .map_err(|e| e.to_string())
}

/// [`get_terminal_cwd`] for MANY terminals, in ONE process scan.
///
/// The renderer's session-save refresh needs every live terminal's directory at once.
/// Per-terminal invokes meant N × `System::new_all()` — sysinfo's heaviest constructor
/// (every process, plus cpu / mem / disks / networks, 50-200ms) — because the OSC fast
/// path is only ever populated for PowerShell (pty_manager.rs injects PS_CWD_INTEGRATION),
/// so cmd / WSL / bash / zsh terminals — i.e. EVERY terminal on Linux — take the process
/// fallback on every single refresh.
///
/// Here the OSC hits are resolved first as cheap map lookups, and the scan happens ONCE
/// on a blocking worker (same reason as `get_terminal_cwd`: N concurrent scans on the
/// async pool would starve the workers `write_terminal` / `resize_terminal` need) and
/// only if at least one terminal actually needs it. Unknown terminals and unresolvable
/// directories map to `None`, so the renderer keeps its previous value.
#[tauri::command]
pub async fn get_terminal_cwds(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> Result<HashMap<String, Option<String>>, String> {
    let mut out: HashMap<String, Option<String>> = HashMap::new();
    // Read everything off `state` BEFORE the closure: `State` is not Send into it.
    let mut needs_scan: Vec<(String, u32)> = Vec::new();
    for id in ids {
        if let Some(cwd) = state.terminal_cwds.get(&id) {
            out.insert(id, Some(cwd.value().clone()));
            continue;
        }
        match state.terminals.get(&id) {
            Some(t) => needs_scan.push((id, t.pid)),
            None => {
                out.insert(id, None);
            }
        }
    }
    if needs_scan.is_empty() {
        return Ok(out);
    }

    let scanned = tokio::task::spawn_blocking(move || {
        let sys = System::new_all();
        needs_scan
            .into_iter()
            .map(|(id, pid)| (id, pid, pty_manager::get_process_cwd_with(&sys, pid)))
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| e.to_string())?;

    for (id, pid, cwd) in scanned {
        // Discard a result whose terminal died while we were scanning. The scan can
        // take 50-200ms, and a shell that exits inside that window frees its pid —
        // which Windows recycles aggressively, so `cwd` may belong to an unrelated
        // process that inherited the number. Attributing that to this terminal would
        // silently restart the user in a stranger's directory. `cleanup_terminal_state`
        // removes the entry on exit, so a still-matching pid means the shell we asked
        // about is the shell we measured. (The renderer closes the remaining sliver:
        // an exit invalidates any refresh that was in flight — see cwdSnapshot.ts.)
        let still_same_process = state.terminals.get(&id).map(|t| t.pid) == Some(pid);
        out.insert(id, if still_same_process { cwd } else { None });
    }
    Ok(out)
}

/// Resolve a relative path the terminal printed into the actual file(s) on disk
/// (backlog 003 follow-up). A coding agent that `cd`s into a subfolder prints paths
/// relative to ITS cwd, not the shell's — so the shell's OSC cwd misses them. We try,
/// in order: (1) the OSC-reported shell cwd, (2) the live foreground-process cwd (the
/// agent's real `chdir`), then (3) a bounded descendant search of the shell cwd. The
/// first base whose direct join exists wins (one result); otherwise the search may
/// return zero / one / many candidates (the renderer shows a picker for many).
///
/// The whole resolution — including the heavy `System::new_all()` process scan and the
/// fs walk — runs on a blocking worker so the UI thread / terminal output is never
/// stalled. Triggered only on a modifier+click, never per output line.
#[tauri::command]
pub async fn resolve_terminal_path(
    state: State<'_, AppState>,
    id: String,
    rel: String,
) -> Result<Vec<String>, String> {
    let osc_cwd = state.terminal_cwds.get(&id).map(|c| c.value().clone());
    let pid = state.terminals.get(&id).map(|t| t.pid);
    tokio::task::spawn_blocking(move || {
        let proc_cwd = pid.and_then(pty_manager::get_process_cwd);
        crate::open_commands::resolve_blocking(&[osc_cwd, proc_cwd], &rel)
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn write_terminal(
    state: State<'_, AppState>,
    id: String,
    data: String,
) -> Result<(), String> {
    // Host-owned terminals: forward keystrokes to the sidecar (still tag the
    // user-input source below).
    if !state.host_write(&id, data.as_bytes()) {
        // Clone the Arc, dropping the DashMap shard guard before locking.
        let writer_mutex = match state.shell_writer_channels.get(&id) {
            Some(r) => r.clone(),
            None => return Err("Terminal not found".to_string()),
        };
        {
            let mut writer = writer_mutex.lock().map_err(|_| "Failed to lock writer".to_string())?;
            writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        }
    }
    // Tag this terminal's last-write as user-driven (keystrokes/paste flow through
    // this invoke command, never the REST API). Drives the agent color-scheme
    // revert-on-user-exit behavior. Writer guard dropped above so we never nest the
    // DashMap shard guard under the writer mutex.
    if let Some(mut t) = state.terminals.get_mut(&id) {
        t.last_input_source = Some("user".to_string());
        t.last_input_at = Some(chrono::Utc::now().timestamp_millis());
    }
    Ok(())
}

#[tauri::command]
pub async fn resize_terminal(
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    // Host-owned terminals: forward the resize to the sidecar and update dims.
    if state.host_resize(&id, cols, rows) {
        if let Some(mut terminal) = state.terminals.get_mut(&id) {
            terminal.cols = cols;
            terminal.rows = rows;
        }
        return Ok(());
    }
    if let Some(master_mutex) = state.ptys.get(&id) {
        let master = master_mutex.lock().map_err(|_| "Failed to lock PTY master".to_string())?;
        master.resize(portable_pty::PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        }).map_err(|e| e.to_string())?;

        if let Some(mut terminal) = state.terminals.get_mut(&id) {
            terminal.cols = cols;
            terminal.rows = rows;
        }

        // Keep the authoritative screen parser in sync so snapshots reflow correctly.
        state.resize_screen(&id, rows, cols);

        Ok(())
    } else {
        Err("Terminal not found".to_string())
    }
}

#[derive(serde::Serialize)]
pub struct TerminalSize {
    pub cols: u16,
    pub rows: u16,
}

/// Read the backend's authoritative PTY size for a terminal. Cheap: reads the
/// stored size only (no parser render). The dimension auto-heal uses this to
/// detect UI<->backend column drift. Returns the last size the UI pushed via
/// resize_terminal (the backend has no independent notion of geometry).
#[tauri::command]
pub fn get_terminal_size(state: State<'_, AppState>, id: String) -> Result<TerminalSize, String> {
    if let Some(terminal) = state.terminals.get(&id) {
        Ok(TerminalSize { cols: terminal.cols, rows: terminal.rows })
    } else {
        Err("Terminal not found".to_string())
    }
}

#[tauri::command]
pub async fn save_config(app_handle: tauri::AppHandle, config: String) -> Result<(), String> {
    use tauri::Manager;
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
    // Per-instance filename (config.json / config.dev.json) so dev and prod
    // settings — not just the network block — stay isolated.
    let config_path = config_dir.join(crate::app_config::instance_config_name());
    std::fs::write(config_path, config).map_err(|e| e.to_string())?;
    Ok(())
}

/// Backlog 011: record one submitted command into the global command history.
/// Length/emptiness guards live here too (defense in depth vs the frontend).
/// The SQLite write runs on a blocking worker (codebase precedent: line 172) so
/// it never contends on the async runtime with the 30s scrollback flush, which
/// holds the same HistoryStore mutex while writing multi-MB blobs.
#[tauri::command]
pub async fn add_command_history(
    state: State<'_, AppState>,
    command: String,
) -> Result<(), String> {
    let trimmed = command.trim().to_string();
    if trimmed.is_empty() || trimmed.chars().count() > 500 {
        return Ok(()); // silently drop garbage; never an error the UI must handle
    }
    let store = state.history_store.clone();
    tokio::task::spawn_blocking(move || {
        store.add_command(&trimmed, chrono::Utc::now().timestamp_millis());
    })
    .await
    .map_err(|e| e.to_string())
}

/// Backlog 011: remove one command from the history (Shift+Delete on a
/// suggestion). Blocking worker for the same contention reason as add.
#[tauri::command]
pub async fn delete_command_history(
    state: State<'_, AppState>,
    command: String,
) -> Result<(), String> {
    let store = state.history_store.clone();
    tokio::task::spawn_blocking(move || store.delete_command(&command))
        .await
        .map_err(|e| e.to_string())
}

/// Backlog 011: most-recent-first command history for the suggestion popup.
#[tauri::command]
pub async fn load_command_history(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> Result<Vec<String>, String> {
    let store = state.history_store.clone();
    tokio::task::spawn_blocking(move || store.load_commands(limit.unwrap_or(2000).min(5000)))
        .await
        .map_err(|e| e.to_string())
}

/// Stream 4: record that a command was run in a directory (cwd-relevant ranking).
/// `dir` must already be normalized by the caller (forward-slash; lowercased on
/// Windows). Blocking worker for the same contention reason as add_command_history.
#[tauri::command]
pub async fn add_command_dir_usage(
    state: State<'_, AppState>,
    command: String,
    dir: String,
) -> Result<(), String> {
    let trimmed = command.trim().to_string();
    let dir = dir.trim().to_string();
    if trimmed.is_empty() || trimmed.chars().count() > 500 || dir.is_empty() {
        return Ok(()); // silently drop garbage / unknown-cwd (global history still records)
    }
    let store = state.history_store.clone();
    tokio::task::spawn_blocking(move || {
        store.add_command_dir(&trimmed, &dir, chrono::Utc::now().timestamp_millis());
    })
    .await
    .map_err(|e| e.to_string())
}

/// Stream 4: usage rows relevant to the current directory (exact + ancestors +
/// descendants) for the renderer to rank suggestions by cwd affinity.
#[tauri::command]
pub async fn load_command_dir_usage(
    state: State<'_, AppState>,
    cwd: String,
) -> Result<Vec<crate::history_store::DirUsageRow>, String> {
    let store = state.history_store.clone();
    tokio::task::spawn_blocking(move || store.load_dir_usage(&cwd))
        .await
        .map_err(|e| e.to_string())
}

/// Stream 1: show an OS notification for background-tab activity, but ONLY when no
/// TermFlow window is focused (app-wide check — a focused window already gets the
/// in-app sound/toast, so notifying there too would be noisy/duplicate). `window_label`
/// + `tab_id` identify the exact destination when a Windows toast is activated.
/// Best-effort; failures are non-fatal.
/// Returns `true` if a toast was actually shown, `false` if suppressed because a window
/// was focused. The renderer enqueues the tab for return-to-app routing ONLY when a
/// toast was shown, so merely re-focusing a window later never force-switches tabs for a
/// notification the user never received.
#[tauri::command]
pub fn show_activity_notification(
    app: tauri::AppHandle,
    window_label: String,
    tab_id: String,
    title: String,
) -> Result<bool, String> {
    use tauri::Manager;
    let any_focused = app
        .webview_windows()
        .iter()
        .filter(|(label, _)| label.as_str() != "drag-preview")
        .any(|(_, w)| w.is_focused().unwrap_or(false));
    if any_focused {
        // app is focused → in-app channels cover it; don't double-notify
        log::info!("show_activity_notification: a window is focused; suppressing OS toast for tab {tab_id}");
        return Ok(false);
    }
    log::info!("show_activity_notification: no window focused; showing OS toast for tab {tab_id} (window {window_label})");
    let body = if title.trim().is_empty() {
        "New terminal activity".to_string()
    } else {
        title
    };
    #[cfg(windows)]
    {
        match crate::native_notify::show_activity_notification(&app, &window_label, &tab_id, &body) {
            Ok(()) => log::info!("show_activity_notification: native WinRT toast shown for tab {tab_id}"),
            Err(native_error) => {
                // Keep notifications best-effort even on machines where WinRT is
                // disabled by policy. The plugin toast has no click callback, but is
                // still preferable to silently dropping the activity notification.
                log::warn!("Native activity notification failed: {native_error}; using plugin fallback");
                use tauri_plugin_notification::NotificationExt;
                app.notification()
                    .builder()
                    .title("TermFlow")
                    .body(body)
                    .show()
                    .map_err(|e| format!("native toast failed ({native_error}); plugin fallback failed: {e}"))?;
            }
        }
    }
    #[cfg(not(windows))]
    {
        use tauri_plugin_notification::NotificationExt;
        let _ = (&window_label, &tab_id);
        app.notification()
            .builder()
            .title("TermFlow")
            .body(body)
            .show()
            .map_err(|e| e.to_string())?;
    }
    Ok(true)
}

#[tauri::command]
pub async fn load_config(app_handle: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let config_path = config_dir.join(crate::app_config::instance_config_name());
    if config_path.exists() {
        std::fs::read_to_string(config_path).map_err(|e| e.to_string())
    } else {
        Ok("{}".to_string())
    }
}

#[tauri::command]
pub async fn close_terminal(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    // Get the terminal info to retrieve the PID + renderer id.
    let (pid, tab_id) = if let Some(terminal) = state.terminals.get(&id) {
        (terminal.pid, terminal.tab_id.clone())
    } else {
        return Err("Terminal not found".to_string());
    };

    // Host-owned: tell the sidecar to close the session (it kills the child);
    // otherwise kill the local process tree.
    if !state.host_close(&id) {
        // Kill the process tree (parent and all children)
        crate::pty_manager::kill_process_tree(pid);
    }

    // Clean up ALL state entries (incl. terminal_history/tmux_sessions, which
    // the old inline cleanup leaked). Dropping the pty also EOFs the reader.
    state.cleanup_terminal_state(&id);

    // Explicit user close: drop this terminal's persisted scrollback so a closed
    // tab never reappears on the next restart (shell-exit keeps it — see
    // cleanup_terminal_state).
    if let Some(tab_id) = tab_id {
        state.history_store.delete(&tab_id);
    }

    log::info!("Closed terminal {} with PID {}", id, pid);
    Ok(())
}

/// Delete persisted scrollback for every renderer id NOT in `keep_ids` — the startup
/// orphan sweep. The renderer passes the full set of ids its restored layout will use
/// (tab roots + split panes); everything else (closed tabs, crashed sessions) is reaped.
#[tauri::command]
pub async fn prune_terminal_history(
    state: State<'_, AppState>,
    keep_ids: Vec<String>,
) -> Result<(), String> {
    let keep: std::collections::HashSet<String> = keep_ids.into_iter().collect();
    state.history_store.prune(&keep);
    Ok(())
}

/// Background mode (Plan 010): persist the "keep running in background" setting and
/// mirror it into the live `AppState` atomic that the window-close/exit guard reads.
///
/// When true, closing the last window hides it to the tray and keeps the process
/// alive (so peering keeps running) instead of exiting; when false, the last window
/// close exits the app as before. Persisted to the shared instance config file so it
/// survives restarts and seeds the atomic at startup (see `run()` in lib.rs).
#[tauri::command]
pub fn set_keep_running_in_background(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    state.keep_running_in_background.store(enabled, Ordering::Relaxed);
    crate::app_config::merge_root_value(
        &app_handle,
        "keepRunningInBackground",
        serde_json::Value::Bool(enabled),
    )
}

/// Diagnostic logging bridge: lets the renderer mirror terminal diagnostics to
/// the Rust logger (and thus the `tauri dev` terminal stdout) without DevTools.
/// Gated on the frontend (disabled by default); see the renderer's diag util and
/// docs/024-terminal-diagnostics-logging.md.
#[tauri::command]
pub fn diag_log(msg: String) {
    log::info!("{}", msg);
}

/// Quit the whole app immediately. Used by the first-run EULA "Decline" action — if the
/// user won't accept the agreement, the app must not proceed.
#[tauri::command]
pub fn quit_app(app_handle: tauri::AppHandle) {
    log::info!("quit_app: exiting (EULA declined or explicit quit).");
    app_handle.exit(0);
}

/// Exit the app after the user confirms the close in the in-app dialog.
/// Uses exit() (not window.close()) so it doesn't re-trigger CloseRequested.
#[tauri::command]
pub fn confirm_close_app(app_handle: tauri::AppHandle, window: tauri::Window) {
    // Only the last remaining window quits the whole app; closing any other
    // window just destroys that window (its panes/PTYs are confirmed per-window).
    // The hidden tab tear-off preview window doesn't count as a real window.
    let count = app_handle
        .webview_windows()
        .keys()
        .filter(|label| label.as_str() != "drag-preview")
        .count();
    if count <= 1 {
        log::info!("Last window confirmed close; exiting app.");
        app_handle.exit(0);
    } else {
        log::info!("Closing window '{}' ({} window(s) remain).", window.label(), count - 1);
        if let Err(e) = window.destroy() {
            log::warn!("Failed to destroy window '{}': {}", window.label(), e);
        }
    }
}

#[derive(Serialize)]
pub struct ConnectionHealth {
    pub name: String,
    pub url: String,
    pub healthy: bool,
    pub active_clients: Option<u32>,
    /// True when the port is reachable but owned by ANOTHER instance (cross-instance
    /// conflict / hijack). The UI shows a "pick another port" message instead of a
    /// healthy badge. Mutually exclusive with `healthy`.
    #[serde(default)]
    pub conflict: bool,
}

#[tauri::command]
pub async fn check_connection_health(state: State<'_, AppState>) -> Result<Vec<ConnectionHealth>, String> {
    let (api_port, mcp_port) = {
        let net = state.network.read();
        (net.api_port, net.mcp_port)
    };
    let mut results = Vec::new();

    // Both the API and MCP /health echo this process's instanceId; a reachable port
    // reporting a DIFFERENT id is owned by another instance (cold-start race / hijack
    // for the API, a foreign sidecar for MCP), so it reads as a conflict rather than
    // healthy. classify_health_owner encodes that rule for both (P0b).
    let our_id = state.instance_id.clone();
    // Bounded-timeout client so a blackholed localhost port (accepts the connection
    // but never answers) can't hang this UI-polled command for the OS default ~20s.
    let client = crate::network_commands::localhost_client(1500)
        .ok_or_else(|| "failed to build HTTP client".to_string())?;

    // Check API Server.
    let api_reported: Option<String> =
        match client.get(format!("http://localhost:{}/health", api_port)).send().await {
            Ok(r) if r.status().is_success() => {
                let j = r.json::<serde_json::Value>().await.unwrap_or_else(|_| serde_json::json!({}));
                Some(j.get("instanceId").and_then(|v| v.as_str()).unwrap_or("").to_string())
            }
            _ => None,
        };
    let (api_healthy, api_conflict) =
        crate::network_commands::classify_health_owner(api_reported.as_deref(), &our_id);

    results.push(ConnectionHealth {
        name: "API Server".to_string(),
        url: format!("http://localhost:{}", api_port),
        healthy: api_healthy,
        active_clients: None,
        conflict: api_conflict,
    });

    // Check MCP Server — same ownership rule, plus activeSessions for the client count.
    let (mcp_reported, mcp_clients): (Option<String>, Option<u32>) =
        match client.get(format!("http://localhost:{}/health", mcp_port)).send().await {
            Ok(r) if r.status().is_success() => {
                let j = r.json::<serde_json::Value>().await.unwrap_or_else(|_| serde_json::json!({}));
                let id = j.get("instanceId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let sessions = j.get("activeSessions").and_then(|v| v.as_u64()).map(|v| v as u32);
                (Some(id), sessions)
            }
            _ => (None, None),
        };
    let (mcp_healthy, mcp_conflict) =
        crate::network_commands::classify_health_owner(mcp_reported.as_deref(), &our_id);

    results.push(ConnectionHealth {
        name: "MCP Server".to_string(),
        url: format!("http://localhost:{}/mcp", mcp_port),
        healthy: mcp_healthy,
        active_clients: mcp_clients,
        conflict: mcp_conflict,
    });

    // WebSocket inherits API health (same server)
    results.push(ConnectionHealth {
        name: "WebSocket".to_string(),
        url: format!("ws://localhost:{}/ws", api_port),
        healthy: api_healthy,
        active_clients: None,
        conflict: api_conflict,
    });

    Ok(results)
}

#[derive(Debug, Serialize, Deserialize)]
struct Claims {
    sub: String,
    permissions: Vec<String>,
    exp: usize,
    iat: usize,
}

#[tauri::command]
pub async fn generate_api_token(
    state: State<'_, AppState>,
    client_id: String, 
    permissions: Vec<String>
) -> Result<String, String> {
    let exp = Utc::now() + Duration::hours(24);
    let claims = Claims {
        sub: client_id,
        permissions,
        exp: exp.timestamp() as usize,
        iat: Utc::now().timestamp() as usize,
    };

    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(state.jwt_secret.as_bytes()),
    ).map_err(|e| e.to_string())?;

    Ok(token)
}

// ----- Detach / cross-window pane handoff -----------------------------------
//
// The PTY processes live in this shared backend (AppState), so moving a pane to
// a new window does NOT restart the shell. The source window serializes the
// moving unit into a single-use payload stashed here under a token; the new
// window fetches it and reattaches to the same live processes by id.

#[tauri::command]
pub fn stash_detach_payload(
    state: State<'_, AppState>,
    token: String,
    payload: serde_json::Value,
) -> Result<(), String> {
    state.detach_payloads.insert(token, payload);
    Ok(())
}

#[tauri::command]
pub fn take_detach_payload(
    state: State<'_, AppState>,
    token: String,
) -> Result<Option<serde_json::Value>, String> {
    Ok(state.detach_payloads.remove(&token).map(|(_, v)| v))
}

/// Open a new app window that will reconstruct the detached tab/pane. The token
/// is carried in the window label (`detach-<token>`) so the new window can read
/// it from its own label and call `take_detach_payload` on boot.
#[tauri::command]
pub async fn create_detached_window(
    app_handle: tauri::AppHandle,
    window: tauri::WebviewWindow,
    token: String,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<String, String> {
    let label = format!("detach-{}", token);
    // Match the main window (tauri.conf): empty/hidden title + Overlay title bar
    // so the custom in-app tab bar is the only header (no native "TermFlow"
    // text row, no doubled-up title bar).
    let mut builder = tauri::WebviewWindowBuilder::new(
        &app_handle,
        &label,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("TermFlow")
    .inner_size(900.0, 600.0)
    .resizable(true)
    // Frameless on Windows/Linux (the custom in-app title bar owns the chrome);
    // decorated on macOS so the Overlay title bar provides native traffic lights.
    .decorations(cfg!(target_os = "macos"));

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }

    // Position the new window under the cursor. We ask the OS for the actual
    // global cursor position rather than computing it from the source window +
    // client coords: that manual math breaks across monitors with different DPI
    // scale factors (and this webview zeroes screen coords on events anyway).
    // `cursor_position()` returns physical px in the global space, which is
    // exactly what `builder.position` expects in Tauri v2. The `x`/`y` client
    // coords are kept only as a fallback if the cursor query fails.
    // Nudge up/left so the cursor lands over the tab strip, not the corner.
    const OFFSET_X: f64 = 60.0;
    const OFFSET_Y: f64 = 16.0;
    let placed = if let Ok(p) = app_handle.cursor_position() {
        let scale = app_handle
            .monitor_from_point(p.x, p.y)
            .ok()
            .flatten()
            .map(|m| m.scale_factor())
            .unwrap_or(1.0);
        builder = builder.position(p.x - OFFSET_X * scale, p.y - OFFSET_Y * scale);
        true
    } else {
        false
    };
    if !placed {
        if let (Some(cx), Some(cy)) = (x, y) {
            if let (Ok(origin), Ok(scale)) = (window.inner_position(), window.scale_factor()) {
                let px = origin.x as f64 + (cx - OFFSET_X) * scale;
                let py = origin.y as f64 + (cy - OFFSET_Y) * scale;
                builder = builder.position(px, py);
            }
        }
    }

    let window = builder.build().map_err(|e| e.to_string())?;
    crate::context_menu::install(&window);
    refresh_menu(&app_handle);
    Ok(label)
}

/// Open a fresh, empty app window (File > New Window). Unlike a detached window,
/// it carries no payload: it boots with `?newWindow=1`, which skips session
/// restore and opens a single default terminal tab.
pub fn open_new_window(app: &tauri::AppHandle, path: Option<String>) -> Result<String, String> {
    let label = format!("window-{}", uuid::Uuid::new_v4().simple());
    let mut url = "index.html?newWindow=1".to_string();
    if let Some(path) = path {
        url.push_str("&path=");
        url.push_str(&percent_encode_url_component(&path));
    }
    // `mut` is only used by the macOS-only block below (Overlay title bar).
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        &label,
        tauri::WebviewUrl::App(url.into()),
    )
    .title("TermFlow")
    .inner_size(1280.0, 800.0)
    // Center like the main window (the tauri.conf `center` flag only applies to
    // the boot-time window, not builder-spawned ones).
    .center()
    .resizable(true)
    // Frameless on Windows/Linux (the custom in-app title bar owns the chrome);
    // decorated on macOS so the Overlay title bar provides native traffic lights.
    .decorations(cfg!(target_os = "macos"));

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }

    let window = builder.build().map_err(|e| e.to_string())?;
    crate::context_menu::install(&window);
    Ok(label)
}

/// Command wrapper so a new window can also be opened from the renderer.
#[tauri::command]
pub async fn create_new_window(app_handle: tauri::AppHandle) -> Result<String, String> {
    let label = open_new_window(&app_handle, None)?;
    refresh_menu(&app_handle);
    Ok(label)
}

fn percent_encode_url_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(byte as char);
        } else {
            use std::fmt::Write;
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
}

/// Return the cold-launch folder once. Subsequent renderer calls receive `None`.
#[tauri::command]
pub fn take_pending_open_path(state: tauri::State<'_, AppState>) -> Option<String> {
    state
        .pending_open_path
        .lock()
        .ok()
        .and_then(|mut path| path.take())
}

/// Destroy the calling window directly (no close-confirm). Used when a window is
/// emptied by dragging its last tab elsewhere. Done in the backend so it doesn't
/// require the `core:window:allow-destroy` capability on the renderer side.
#[tauri::command]
pub fn close_self_window(window: tauri::WebviewWindow) -> Result<(), String> {
    let label = window.label().to_string();
    window.destroy().map_err(|e| e.to_string())?;
    log::info!("close_self_window: destroyed '{}' (emptied)", label);
    Ok(())
}

/// Resolve a possibly-bare executable name (e.g. "cmd.exe", "wsl.exe") to a full
/// path by searching PATH, so the icon can be read from the real binary.
#[cfg(windows)]
fn resolve_executable(path: &str) -> Option<std::path::PathBuf> {
    let p = std::path::Path::new(path);
    if p.is_absolute() && p.exists() {
        return Some(p.to_path_buf());
    }
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join(path);
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    if p.exists() { Some(p.to_path_buf()) } else { None }
}

/// Pick the best binary to read an icon from. Most shells carry their own icon,
/// but Git Bash's profile points at `…\Git\bin\bash.exe`, which only has a
/// generic icon — the real Git Bash logo lives on the launcher `git-bash.exe`
/// in the Git root (what the Start Menu shortcut uses).
#[cfg(windows)]
fn icon_source_for(exe: &std::path::Path) -> std::path::PathBuf {
    let file = exe
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or("")
        .to_lowercase();
    if file == "bash.exe" {
        if let Some(git_root) = exe.parent().and_then(|p| p.parent()) {
            let launcher = git_root.join("git-bash.exe");
            if launcher.exists() {
                return launcher;
            }
        }
    }
    exe.to_path_buf()
}

/// Session cache of resolved icon data URLs, keyed by the raw `path` argument.
/// The per-OS helper (PowerShell/osascript) or filesystem scan runs at most once
/// per unique path per session. Only `Ok` results are cached — a transient failure
/// must stay retryable.
static ICON_CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, String>>> =
    std::sync::OnceLock::new();

/// Extract an executable's icon as a base64 image data URL, so the New Tab profile
/// list and the running-agent chip can show the real binary icon. Returns a
/// `data:image/png;base64,…` (or `image/svg+xml` for a Linux themed SVG) URL, or an
/// `Err` when no icon is available — callers fall back to a glyph/dot.
///
/// Extraction shells out to an OS-native helper rather than a native icon crate:
/// the available crates pull in `gtk-sys`, which conflicts with Tauri's native libs
/// on Windows. The per-OS work lives in `extract_executable_icon`; this wrapper only
/// memoizes.
#[tauri::command]
pub fn get_executable_icon(path: String) -> Result<String, String> {
    let cache = ICON_CACHE.get_or_init(Default::default);
    if let Some(hit) = cache.lock().ok().and_then(|m| m.get(&path).cloned()) {
        return Ok(hit);
    }
    let res = extract_executable_icon(&path);
    if let Ok(ref url) = res {
        if let Ok(mut m) = cache.lock() {
            m.insert(path.clone(), url.clone());
        }
    }
    res
}

/// Windows: read the embedded icon via the OS's built-in .NET `System.Drawing`
/// through PowerShell. `CREATE_NO_WINDOW` keeps the helper from flashing a console.
#[cfg(windows)]
fn extract_executable_icon(path: &str) -> Result<String, String> {
    let resolved = resolve_executable(path)
        .ok_or_else(|| format!("executable not found: {}", path))?;
    let icon_src = icon_source_for(&resolved);
    // PowerShell single-quoted strings escape a quote by doubling it.
    let escaped = icon_src.to_string_lossy().replace('\'', "''");
    let script = format!(
        "Add-Type -AssemblyName System.Drawing; \
         $i = [System.Drawing.Icon]::ExtractAssociatedIcon('{}'); \
         $ms = New-Object System.IO.MemoryStream; \
         $i.ToBitmap().Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); \
         [Convert]::ToBase64String($ms.ToArray())",
        escaped
    );

    let mut cmd = std::process::Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd.output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "icon extraction failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let b64 = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if b64.is_empty() {
        return Err("icon extraction returned no data".to_string());
    }
    Ok(format!("data:image/png;base64,{}", b64))
}

/// macOS: ask AppKit's `NSWorkspace` for the file's icon and encode it as PNG, via
/// JXA (`osascript -l JavaScript`) — available on a stock macOS with no Xcode. A real
/// `.app` bundle returns its own icon; a plain binary or script with no icon resource
/// (most coding-agent CLIs — `codex`, `opencode`, `aider`, a `node`/`python` shim, …)
/// gets macOS's *generic* icon: a blank document or a unix-executable glyph. We reject
/// that generic icon (return `Err`) so callers fall back to a glyph/dot rather than
/// showing the meaningless blank document. Detection compares the file's icon bytes
/// against the generic `public.unix-executable` and `public.data` icons — unlike
/// Windows/`ExtractAssociatedIcon`, `NSWorkspace.iconForFile` never returns null, so
/// the comparison is what stands in for "no icon".
#[cfg(target_os = "macos")]
fn extract_executable_icon(path: &str) -> Result<String, String> {
    // `{:?}` emits a quoted, escaped JS string literal for the path. Literal JS braces
    // are doubled ({{ }}) to survive `format!`.
    let script = format!(
        "ObjC.import('AppKit');\
         var ws = $.NSWorkspace.sharedWorkspace;\
         function enc(image) {{\
           if (!image) return '';\
           var rep = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);\
           return rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $()).base64EncodedStringWithOptions(0).js;\
         }}\
         var p = {:?};\
         var img = ws.iconForFile(p);\
         if (!img) throw new Error('no icon');\
         var actual = enc(img);\
         if (actual === enc(ws.iconForFileType('public.unix-executable')) || actual === enc(ws.iconForFileType('public.data'))) throw new Error('generic icon');\
         actual",
        path
    );
    let output = std::process::Command::new("osascript")
        .args(["-l", "JavaScript", "-e", &script])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "icon extraction failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let b64 = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if b64.is_empty() {
        return Err("icon extraction returned no data".to_string());
    }
    Ok(format!("data:image/png;base64,{}", b64))
}

/// Linux / other unix: ELF binaries carry no embedded icon, so resolve the
/// freedesktop **icon theme** by the executable's basename. Returns a PNG (or SVG)
/// data URL, or `Err` when no themed icon exists (most CLI agents) → chip shows the dot.
#[cfg(all(unix, not(target_os = "macos")))]
fn extract_executable_icon(path: &str) -> Result<String, String> {
    use base64::Engine as _;
    let stem = std::path::Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "no basename".to_string())?
        .to_string();
    let found = find_freedesktop_icon(&stem, &xdg_data_dirs())
        .ok_or_else(|| format!("no themed icon for {}", stem))?;
    let bytes = std::fs::read(&found).map_err(|e| e.to_string())?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let mime = if found.extension().and_then(|e| e.to_str()) == Some("svg") {
        "image/svg+xml"
    } else {
        "image/png"
    };
    Ok(format!("data:{};base64,{}", mime, b64))
}

/// freedesktop icon search roots: `$XDG_DATA_HOME` (or `~/.local/share`) first, then
/// `$XDG_DATA_DIRS` (default `/usr/local/share:/usr/share`).
#[cfg(all(unix, not(target_os = "macos")))]
fn xdg_data_dirs() -> Vec<std::path::PathBuf> {
    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    match std::env::var("XDG_DATA_HOME") {
        Ok(h) if !h.is_empty() => roots.push(h.into()),
        _ => {
            if let Ok(home) = std::env::var("HOME") {
                roots.push(std::path::Path::new(&home).join(".local/share"));
            }
        }
    }
    let dirs = std::env::var("XDG_DATA_DIRS")
        .unwrap_or_else(|_| "/usr/local/share:/usr/share".to_string());
    for d in dirs.split(':').filter(|s| !s.is_empty()) {
        roots.push(d.into());
    }
    roots
}

/// Look for `<name>.png|svg` under each root's `icons/hicolor/<size>/apps/` (largest
/// size first, then `scalable`) and `pixmaps/`. Returns the first match, PNG before
/// SVG at a given size.
#[cfg(all(unix, not(target_os = "macos")))]
fn find_freedesktop_icon(name: &str, roots: &[std::path::PathBuf]) -> Option<std::path::PathBuf> {
    const SIZES: &[&str] = &[
        "512x512", "256x256", "128x128", "96x96", "64x64", "48x48", "32x32", "24x24", "16x16",
        "scalable",
    ];
    for root in roots {
        for size in SIZES {
            let apps = root.join("icons/hicolor").join(size).join("apps");
            for ext in ["png", "svg"] {
                let c = apps.join(format!("{}.{}", name, ext));
                if c.is_file() {
                    return Some(c);
                }
            }
        }
        for ext in ["png", "svg"] {
            let c = root.join("pixmaps").join(format!("{}.{}", name, ext));
            if c.is_file() {
                return Some(c);
            }
        }
    }
    None
}

// ----- Application menu ------------------------------------------------------

/// Build the full app menu, including a Window submenu that lists every open
/// window (so the user can jump to any of them). Built manually (rather than from
/// the platform default) so we can own the Window list and the File submenu.
///
/// macOS only: the menu lives in the global menu bar there. On Windows/Linux a
/// native menu renders as an in-window menu bar that duplicates our custom title
/// bar, so we never build or install one (see `refresh_menu`).
#[cfg(target_os = "macos")]
fn build_app_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};

    let app_menu = SubmenuBuilder::new(app, "TermFlow")
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let new_window = MenuItemBuilder::with_id("new_window", "New Window")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new_window)
        .separator()
        .close_window()
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    // Window submenu: standard items, then one entry per open window. The focused
    // window shows a checkmark; clicking an entry activates that window (handled in
    // lib.rs `on_menu_event`, id `focus:<label>`).
    let mut window_builder = SubmenuBuilder::new(app, "Window").minimize().separator();
    // Prefer the renderer-reported title (active tab) from AppState; fall back to
    // the native window title only if no report has arrived yet.
    let reported = app.try_state::<AppState>().map(|s| s.window_titles.clone());
    let mut entries: Vec<(String, String, bool)> = app
        .webview_windows()
        .iter()
        .filter(|(label, _)| label.as_str() != PREVIEW_LABEL)
        .map(|(label, w)| {
            let title = reported
                .as_ref()
                .and_then(|m| m.get(label).map(|r| r.value().clone()))
                .or_else(|| w.title().ok())
                .unwrap_or_else(|| label.clone());
            let focused = w.is_focused().unwrap_or(false);
            (label.clone(), title, focused)
        })
        .collect();
    entries.sort_by(|a, b| a.1.to_lowercase().cmp(&b.1.to_lowercase()));
    for (label, title, focused) in entries {
        let item = CheckMenuItemBuilder::with_id(format!("focus:{}", label), title)
            .checked(focused)
            .build(app)?;
        window_builder = window_builder.item(&item);
    }
    let window_menu = window_builder.build()?;

    MenuBuilder::new(app)
        .items(&[&app_menu, &file_menu, &edit_menu, &window_menu])
        .build()
}

/// Rebuild and apply the app menu. Call whenever the set of windows (or their
/// titles) changes so the Window submenu stays current.
pub fn refresh_menu(app: &tauri::AppHandle) {
    // macOS shows the app menu in the global menu bar. On Windows/Linux a native
    // menu becomes an in-window menu bar that duplicates the custom title bar, so
    // we install nothing there.
    #[cfg(target_os = "macos")]
    match build_app_menu(app) {
        Ok(menu) => {
            if let Err(e) = app.set_menu(menu) {
                log::error!("Failed to set menu: {}", e);
            }
        }
        Err(e) => log::error!("Failed to build menu: {}", e),
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Renderer-triggered menu refresh (e.g. after a window updates its title to the
/// active tab name) so the Window list shows meaningful names.
#[tauri::command]
pub fn refresh_window_menu(app_handle: tauri::AppHandle) {
    refresh_menu(&app_handle);
}

/// Set the calling window's display title (the active tab's title) and rebuild the
/// Window menu. The title is recorded in AppState first so the menu reads it
/// synchronously — no race against the not-yet-committed native title. We also set
/// the native title so macOS Mission Control / window lists stay in sync.
#[tauri::command]
pub fn set_window_title(
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    title: String,
) {
    state
        .window_titles
        .insert(window.label().to_string(), title.clone());
    let _ = window.set_title(&title);
    refresh_menu(window.app_handle());
}

// ----- Tab tear-off preview window ------------------------------------------
//
// A DOM ghost can't render outside its own window, so the live drag preview is a
// real, frameless, transparent, click-through, always-on-top window that follows
// the cursor across the whole desktop (and other monitors). It loads the app
// bundle with `?dragPreview=1`, which renders only a small window-shaped card.

const PREVIEW_LABEL: &str = "drag-preview";
const PREVIEW_W: f64 = 300.0;
const PREVIEW_H: f64 = 195.0;
// Place the card so the cursor sits over its title bar, not the corner.
const PREVIEW_OFFSET_X: f64 = 46.0;
const PREVIEW_OFFSET_Y: f64 = 18.0;

/// Convert a CLIENT (content-relative, logical CSS px) point in `window` to a
/// physical screen position, offset so the preview card sits under the cursor.
/// We use the source window's content origin + scale (reliable, top-left origin)
/// rather than `cursor_position()`, which errors in this app's webview.
fn preview_position(
    window: &tauri::WebviewWindow,
    cx: f64,
    cy: f64,
) -> Option<tauri::PhysicalPosition<f64>> {
    let origin = window.inner_position().ok()?;
    let scale = window.scale_factor().unwrap_or(1.0);
    Some(tauri::PhysicalPosition::new(
        origin.x as f64 + (cx - PREVIEW_OFFSET_X) * scale,
        origin.y as f64 + (cy - PREVIEW_OFFSET_Y) * scale,
    ))
}

/// Percent-encode a string for use as a URL query value (dependency-free).
fn encode_query(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{:02X}", b),
        })
        .collect()
}

/// Show (creating on first use) the tear-off preview at the cursor with `title`.
/// `x`/`y` are CLIENT coords in the calling (source) window.
#[tauri::command]
pub async fn show_drag_preview(
    app_handle: tauri::AppHandle,
    window: tauri::WebviewWindow,
    title: String,
    x: f64,
    y: f64,
) -> Result<(), String> {
    let win = if let Some(w) = app_handle.get_webview_window(PREVIEW_LABEL) {
        // Reuse the existing preview window; just refresh its title.
        let _ = w.emit("drag-preview:title", title.clone());
        w
    } else {
        let url = format!("index.html?dragPreview=1&title={}", encode_query(&title));
        let w = tauri::WebviewWindowBuilder::new(
            &app_handle,
            PREVIEW_LABEL,
            tauri::WebviewUrl::App(url.into()),
        )
        .inner_size(PREVIEW_W, PREVIEW_H)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .focused(false)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
        // Click-through so it never steals the in-flight drag's pointer events.
        let _ = w.set_ignore_cursor_events(true);
        w
    };

    if let Some(pos) = preview_position(&window, x, y) {
        let _ = win.set_position(pos);
    }
    let _ = win.show();
    Ok(())
}

/// Move the preview to follow the cursor (called per animation frame while
/// dragging). `x`/`y` are CLIENT coords in the calling (source) window.
#[tauri::command]
pub async fn move_drag_preview(
    app_handle: tauri::AppHandle,
    window: tauri::WebviewWindow,
    x: f64,
    y: f64,
) -> Result<(), String> {
    if let Some(win) = app_handle.get_webview_window(PREVIEW_LABEL) {
        if let Some(pos) = preview_position(&window, x, y) {
            let _ = win.set_position(pos);
        }
    }
    Ok(())
}

/// Hide the preview window (kept alive for reuse on the next drag).
#[tauri::command]
pub async fn hide_drag_preview(app_handle: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app_handle.get_webview_window(PREVIEW_LABEL) {
        let _ = win.hide();
    }
    Ok(())
}

/// Source-driven cross-window tab drop. macOS routes a button-drag's events to
/// the SOURCE window, so the destination window can't detect the release itself.
/// Instead the source reports the release point (CLIENT coords in the source
/// window) and we hit-test it against every other window's screen rect. If it
/// lands on one, we tell that window to reattach the tab (it takes the stashed
/// payload by `token`) and return true; otherwise return false so the caller
/// opens a new window. The payload must already be stashed under `token`.
#[tauri::command]
pub fn resolve_tab_drop(
    app_handle: tauri::AppHandle,
    window: tauri::WebviewWindow,
    token: String,
    x: f64,
    y: f64,
) -> Result<bool, String> {
    // Global physical point of the drop, from the source window's content origin.
    let (px, py) = match (window.inner_position(), window.scale_factor()) {
        (Ok(origin), Ok(scale)) => (origin.x as f64 + x * scale, origin.y as f64 + y * scale),
        _ => return Ok(false),
    };
    let source_label = window.label().to_string();
    log::info!(
        "resolve_tab_drop: drop=({:.0},{:.0}) source={} client=({:.0},{:.0})",
        px, py, source_label, x, y
    );
    for (label, w) in app_handle.webview_windows() {
        if label == source_label || label == PREVIEW_LABEL {
            continue;
        }
        if let (Ok(pos), Ok(size)) = (w.outer_position(), w.outer_size()) {
            let hit = point_in_rect(px, py, pos.x as f64, pos.y as f64, size.width as f64, size.height as f64);
            log::info!(
                "  candidate {} rect=({},{} {}x{}) hit={}",
                label, pos.x, pos.y, size.width, size.height, hit
            );
            if hit {
                // Broadcast with the target label in the payload; every window's
                // listener acts only if it IS the target. (Same proven pattern as
                // `app:close-requested`. A bare emit_to wasn't reaching the JS
                // listener, and w.emit would let the source steal its own payload.)
                let _ = app_handle.emit(
                    "tab-drag:reattach",
                    serde_json::json!({ "token": token, "target": label }),
                );
                let _ = w.set_focus(); // bring the receiving window to the front
                log::info!("resolve_tab_drop: reattaching into {}", label);
                return Ok(true);
            }
        } else {
            log::info!("  candidate {} position/size unavailable", label);
        }
    }
    log::info!("resolve_tab_drop: no window under drop point -> new window");
    Ok(false)
}

// ----- Cross-window drag broker (Phase 4, target-claims) --------------------
//
// Pointer events don't cross OS windows, so we don't try to guess coordinates
// from the source. Instead: the source registers an active drag and broadcasts
// it; whichever window the user releases over CLAIMS the pane using its own
// accurate local coordinates, then the source is told to remove its pane. If no
// window claims it (released over empty desktop), the source resolves it as an
// orphan and opens a new window.

use tauri::{Manager, Emitter};
use crate::state::GlobalDrag;

/// Pure point-in-rect test. Retained (unit-tested) for any future hit-testing.
pub fn point_in_rect(px: f64, py: f64, rx: f64, ry: f64, rw: f64, rh: f64) -> bool {
    px >= rx && px < rx + rw && py >= ry && py < ry + rh
}

/// Source registers an in-flight cross-window drag and stashes its payload. The
/// `pane-drag:active` broadcast lets every window know it may become a drop target.
#[tauri::command]
pub fn begin_global_pane_drag(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    window: tauri::Window,
    token: String,
    payload: serde_json::Value,
) -> Result<(), String> {
    state.detach_payloads.insert(token.clone(), payload);
    *state.active_global_drag.lock().map_err(|e| e.to_string())? = Some(GlobalDrag {
        token: token.clone(),
        source_label: window.label().to_string(),
    });
    let _ = app_handle.emit("pane-drag:active", token);
    Ok(())
}

/// A window the cursor was released over claims the active drag. Returns the
/// payload (so the claimer can insert the pane) and notifies the source to drop
/// its copy. Single-use: returns None if already claimed/cancelled.
#[tauri::command]
pub fn claim_global_pane_drag(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    token: String,
) -> Result<Option<serde_json::Value>, String> {
    let mut guard = state.active_global_drag.lock().map_err(|e| e.to_string())?;
    match guard.as_ref() {
        Some(g) if g.token == token => {
            let source_label = g.source_label.clone();
            *guard = None;
            drop(guard);
            let payload = state.detach_payloads.remove(&token).map(|(_, v)| v);
            if let Some(src) = app_handle.get_webview_window(&source_label) {
                let _ = src.emit("pane-drag:claimed", token.clone());
            }
            let _ = app_handle.emit("pane-drag:ended", ());
            Ok(payload)
        }
        _ => Ok(None),
    }
}

/// The SOURCE resolves a drag that no window claimed (released over empty desktop)
/// -> it should open a new window. Returns true if this caller still owns the
/// active drag (payload is left stashed for create_detached_window to consume).
#[tauri::command]
pub fn resolve_orphan_global_drag(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    window: tauri::Window,
    token: String,
) -> Result<bool, String> {
    let mut guard = state.active_global_drag.lock().map_err(|e| e.to_string())?;
    match guard.as_ref() {
        Some(g) if g.token == token && g.source_label == window.label() => {
            *guard = None;
            drop(guard);
            let _ = app_handle.emit("pane-drag:ended", ());
            Ok(true)
        }
        _ => Ok(false),
    }
}

/// Cancel an in-flight drag (cursor returned inside the source, or Escape).
#[tauri::command]
pub fn cancel_global_pane_drag(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    token: String,
) -> Result<(), String> {
    let mut guard = state.active_global_drag.lock().map_err(|e| e.to_string())?;
    let owns = matches!(guard.as_ref(), Some(g) if g.token == token);
    if owns {
        *guard = None;
    }
    drop(guard);
    state.detach_payloads.remove(&token);
    let _ = app_handle.emit("pane-drag:ended", ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::point_in_rect;

    #[test]
    fn point_inside_rect() {
        assert!(point_in_rect(50.0, 50.0, 0.0, 0.0, 100.0, 100.0));
        assert!(point_in_rect(0.0, 0.0, 0.0, 0.0, 100.0, 100.0)); // top-left inclusive
    }

    #[test]
    fn point_outside_rect() {
        assert!(!point_in_rect(150.0, 50.0, 0.0, 0.0, 100.0, 100.0));
        assert!(!point_in_rect(100.0, 50.0, 0.0, 0.0, 100.0, 100.0)); // right edge exclusive
        assert!(!point_in_rect(-1.0, 50.0, 0.0, 0.0, 100.0, 100.0));
    }
}

// Linux/other-unix freedesktop icon-theme lookup. Gated to unix (mirrors the
// `find_freedesktop_icon` cfg) so it validates on Linux CI without affecting the
// Windows/macOS build.
#[cfg(all(test, unix, not(target_os = "macos")))]
mod freedesktop_icon_tests {
    use super::find_freedesktop_icon;
    use std::fs;
    use std::path::PathBuf;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("agenticon_{}_{}", std::process::id(), tag));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn touch(path: &PathBuf) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"x").unwrap();
    }

    #[test]
    fn finds_app_png_in_hicolor() {
        let root = scratch("found");
        let icon = root.join("icons/hicolor/256x256/apps/mytool.png");
        touch(&icon);
        assert_eq!(
            find_freedesktop_icon("mytool", &[root.clone()]).as_deref(),
            Some(icon.as_path())
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn returns_none_when_absent() {
        let root = scratch("absent");
        fs::create_dir_all(root.join("icons/hicolor/256x256/apps")).unwrap();
        assert_eq!(find_freedesktop_icon("nope", &[root.clone()]), None);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn prefers_larger_size() {
        let root = scratch("size");
        let big = root.join("icons/hicolor/256x256/apps/dup.png");
        let small = root.join("icons/hicolor/48x48/apps/dup.png");
        touch(&big);
        touch(&small);
        assert_eq!(
            find_freedesktop_icon("dup", &[root.clone()]).as_deref(),
            Some(big.as_path())
        );
        let _ = fs::remove_dir_all(&root);
    }
}
