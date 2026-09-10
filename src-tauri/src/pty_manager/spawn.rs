use crate::state::{AppState, ChannelPayload, Terminal};
use crate::tmux_manager::TerminalBackend;
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use std::thread;
use tauri::Emitter;
use uuid::Uuid;
use super::cwd::exit_cwd_for;
use super::spawn_spec::{FOREIGN_TERMINAL_ENV, HOST_CONTROL_ENV, PS_CWD_INTEGRATION, identity_env_value};

/// Find the last valid UTF-8 boundary in a byte slice.
/// Returns the index up to which the data is valid UTF-8.
/// Any bytes from this index onwards might be an incomplete multi-byte sequence.
fn find_utf8_boundary(data: &[u8]) -> usize {
    if data.is_empty() {
        return 0;
    }

    // Check if the entire slice is valid UTF-8
    if std::str::from_utf8(data).is_ok() {
        return data.len();
    }

    // Work backwards to find where the valid UTF-8 ends
    // UTF-8 continuation bytes start with 10xxxxxx (0x80-0xBF)
    // Start bytes are: 0xxxxxxx (ASCII), 110xxxxx, 1110xxxx, 11110xxx
    let len = data.len();

    // Check up to 4 bytes from the end (max UTF-8 sequence length)
    for i in 1..=4.min(len) {
        let pos = len - i;
        let byte = data[pos];

        // If this is a start byte (not a continuation byte)
        if byte < 0x80 || byte >= 0xC0 {
            // Check if the sequence from here to end is complete
            let expected_len = if byte < 0x80 {
                1 // ASCII
            } else if byte < 0xE0 {
                2 // 2-byte sequence
            } else if byte < 0xF0 {
                3 // 3-byte sequence
            } else {
                4 // 4-byte sequence
            };

            let actual_len = len - pos;

            if actual_len < expected_len {
                // Incomplete sequence - return position before this byte
                return pos;
            } else {
                // Complete sequence - validate it
                if std::str::from_utf8(&data[pos..]).is_ok() {
                    return len;
                } else {
                    // Invalid sequence, try earlier position
                    continue;
                }
            }
        }
    }

    // If we couldn't find a valid boundary, return 0 to be safe
    // This shouldn't happen with valid UTF-8 data
    0
}

#[allow(clippy::too_many_arguments)]
pub fn spawn_terminal(
    app_state: AppState,
    cols: u16,
    rows: u16,
    shell_path: Option<String>,
    shell_args: Option<Vec<String>>,
    cwd: Option<String>,
    shell_name: String,
    terminal_name: String,
    // The stable renderer LEAF id this terminal persists history under. Two id
    // FORMS, describing who minted the leaf and NOT the pane's shape: `tb-*` for
    // a renderer-created tab root, `tm-*` for split panes AND for every
    // API-created terminal, including a solo root. Root/solo/split is determined
    // only by the pane-tree structure, never by the prefix.
    // Registered WITH the Terminal before the reader
    // thread starts: a caller patching it in after spawn returns would race a
    // fast-exiting shell's exit-path persist, which would then file the final
    // scrollback under the ephemeral pc- id (review 062 agy F-01).
    //
    // `None` means NO renderer pane owns this PTY (headless API/fleet spawn).
    // It must NOT fall back to `id`: a `Some(pc-*)` value is persisted like any
    // other (`state.rs:642`), producing a history row keyed by an id that does
    // not survive a restart, and violating the invariant that a renderer
    // identity is always a `tb-*`/`tm-*` leaf (design 011 §5, corrected after
    // review 086). Before P0-A this fallback made the field never-None at
    // runtime (ground-truth correction C1).
    renderer_terminal_id: Option<String>,
    // The tab that owns the pane above; `None` when unknown. This is the ONLY
    // source of ownership — never derive it from `renderer_terminal_id` or its
    // prefix. It happens to equal the leaf for a renderer-created tab root that
    // has not been moved, but an API-created solo root is a `tm-*` leaf owned by
    // a different `tb-*` id, and any leaf keeps its id when reparented into
    // another tab (`set_terminal_owning_tab` exists for exactly that).
    owning_tab_id: Option<String>,
    // Restored scrollback (blob + divider) to seed the fresh parser with, BEFORE
    // the reader thread starts — so persisted history precedes live output and the
    // next flush preserves it instead of overwriting the stored row with only this
    // session's content (the scrollback-persistence "ratchet" bug).
    history_seed: Option<String>,
) -> Result<String, String> {
    let pty_system = NativePtySystem::default();
    
    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };

    // Detect PowerShell/pwsh so we can inject cwd reporting below: PowerShell does
    // NOT keep its OS process cwd current on Set-Location, so sysinfo can't see a
    // `cd` (backlog 004). We make it emit OSC 9;9 each prompt instead.
    let is_powershell = shell_path
        .as_deref()
        .map(|p| {
            let p = p.to_ascii_lowercase();
            p.contains("powershell") || p.contains("pwsh")
        })
        .unwrap_or(false)
        || {
            let n = shell_name.to_ascii_lowercase();
            n.contains("powershell") || n.contains("pwsh")
        };

    let mut cmd_builder = if let Some(path) = shell_path {
        CommandBuilder::new(path)
    } else if cfg!(target_os = "windows") {
        CommandBuilder::new("cmd.exe")
    } else {
        // Last-resort fallback: the user's login shell ($SHELL), not the old
        // /bin/bash (which on macOS prints the "default interactive shell is now
        // zsh" notice).
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        CommandBuilder::new(shell)
    };
    
    // Set standard terminal environment (ALL platforms). portable_pty inherits the
    // parent process env (no env_clear), so a spawned PTY only sees these if the APP
    // process already had them. `tauri dev` inherits COLORTERM from the launching dev
    // terminal, but the standalone build is launched with none — so codex/ratatui saw
    // no truecolor and collapsed its input-box background to the default bg (invisible,
    // in BOTH xterm renderers). Setting them explicitly makes the built app behave
    // identically regardless of how it's launched. xterm-256color is correct here: a
    // VT-capable ConPTY backend feeding a full VT xterm.js frontend.
    // Stable per-terminal id, generated before the command is built so it can be
    // injected into the child env (TERMFLOW_TERMINAL_ID) — an in-terminal agent
    // reads it to identify its own terminal to the MCP server ("me" / get_my_terminal).
    let raw_uuid = Uuid::new_v4().to_string().replace("-", "");
    let id = format!("pc-{}", &raw_uuid[..9]);

    cmd_builder.env("TERM", "xterm-256color");
    cmd_builder.env("COLORTERM", "truecolor");
    cmd_builder.env("TERMFLOW_TERMINAL_ID", identity_env_value(renderer_terminal_id.as_deref(), &id));

    // Identify ourselves — and stop leaking the identity of whatever terminal the
    // APP was launched from. Same inheritance mechanism as COLORTERM above, but
    // worse than cosmetic: `tauri dev` launched from Warp handed every PTY
    // TERM_PROGRAM=WarpTerminal, which made Claude Code enable the Kitty keyboard
    // protocol in dev builds only — Shift+Enter then behaved differently in dev vs
    // release (see docs/review 046-052 follow-up). CLIs also detect terminals via
    // the per-terminal session vars below, so overriding TERM_PROGRAM alone isn't
    // enough; scrub the known identity markers too.
    cmd_builder.env("TERM_PROGRAM", "TermFlow");
    cmd_builder.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    // Scrub foreign-terminal identity markers AND the PTY-host control secrets
    // (module consts shared with build_spawn_spec so the two paths never drift).
    for key in FOREIGN_TERMINAL_ENV.iter().chain(HOST_CONTROL_ENV.iter()) {
        cmd_builder.env_remove(key);
    }

    let mut has_command_flag = false;
    if let Some(args) = shell_args {
        has_command_flag = args.iter().any(|a| {
            let a = a.to_ascii_lowercase();
            a == "-command" || a == "-c" || a == "-encodedcommand" || a == "-file"
        });
        cmd_builder.args(args);
    }

    // Backlog 004: make PowerShell report its cwd via OSC 9;9 each prompt (the
    // backend parses it in parse_osc_cwd). We wrap any existing prompt so the user's
    // profile prompt is preserved. Skipped when the profile already drives a
    // -Command/-File (don't fight a custom non-interactive setup).
    if is_powershell && !has_command_flag {
        // Inject the cwd-sync + OSC 9;9 prompt integration (see PS_CWD_INTEGRATION).
        cmd_builder.arg("-NoExit");
        cmd_builder.arg("-Command");
        cmd_builder.arg(PS_CWD_INTEGRATION);
    }

    if let Some(dir) = cwd {
        if !dir.is_empty() {
            let expanded_dir = if dir.starts_with("~/") || dir == "~" {
                let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_else(|_| ".".to_string());
                if dir == "~" {
                    home
                } else {
                    dir.replacen("~", &home, 1)
                }
            } else {
                dir
            };
            // Only honor a cwd that actually exists: an inherited/stale cwd that was
            // removed must not fail the whole spawn — fall back to the default.
            if std::path::Path::new(&expanded_dir).is_dir() {
                cmd_builder.cwd(expanded_dir);
            }
        }
    }

    let pair = pty_system.openpty(size).map_err(|e| e.to_string())?;
    
    let child = pair.slave.spawn_command(cmd_builder).map_err(|e| e.to_string())?;
    let pid = child.process_id().unwrap_or(0);

    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    // Note: taking the writer might make the master unusable for writing if not cloned? 
    // Usually pair.master keeps its capabilities.
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    // Store writer
    app_state.shell_writer_channels.insert(id.clone(), std::sync::Arc::new(std::sync::Mutex::new(writer)));

    // Store master
    app_state.ptys.insert(id.clone(), std::sync::Mutex::new(pair.master));

    // Initialize the authoritative screen parser (source of truth for hydration)
    app_state.init_screen(&id, rows, cols);

    // Seed restored scrollback into the fresh parser now — after init_screen,
    // before the reader thread below can deliver any live output.
    if let Some(seed) = &history_seed {
        app_state.feed_screen(&id, seed.as_bytes());
    }

    // Register the terminal LAST: `terminals` is the existence gate for the
    // close/delete paths, so nothing may be observable until the writer, pty
    // master, and screen parser are all in place — otherwise a concurrent
    // delete could clean up half-constructed state and the remaining inserts
    // would resurrect orphaned entries no cleanup path ever removes.
    // Index alongside registration so a `tm-` lookup resolves for in-process
    // terminals too (design 014 §A3). This path never reaches the pty-host, so
    // its session key is its own id.
    app_state.identity.index(&id, renderer_terminal_id.as_deref(), &id);
    app_state.terminals.insert(id.clone(), Terminal {
        id: id.clone(),
        pid,
        shell: shell_name,
        name: terminal_name,
        created_at: chrono::Local::now().to_rfc3339(),
        cols,
        rows,
        backend: TerminalBackend::PortablePty,
        renderer_terminal_id,
        owning_tab_id,
        // In-process: there is no pty-host session, so the key this terminal is
        // known by IS its own id. Task 4 (design 014 §A2) splits the host path's
        // three identities; this path has no host to disagree with.
        session_key: id.clone(),
        last_input_source: None,
        last_input_at: None,
        // Mirrors the injected-hook decision above, so reattach can re-arm the
        // command-suggest prompt gate (see shell_emits_prompt_osc).
        prompt_hook: is_powershell && !has_command_flag,
        display_label: None,
        title_color: None,
    });

    // Spawn thread to read output
    let output_tx = app_state.output_tx.clone();
    let thread_id = id.clone();

    thread::spawn(move || {
        let mut reader = reader;
        // Use 4KB buffer to reduce chance of splitting UTF-8 sequences
        // Also keeps a pending buffer for incomplete UTF-8 at chunk boundaries
        let mut buffer = [0u8; 4096];
        let mut pending: Vec<u8> = Vec::new();

        loop {
            match reader.read(&mut buffer) {
                Ok(n) if n > 0 => {
                    // Combine pending bytes with new data
                    let mut data = if pending.is_empty() {
                        buffer[0..n].to_vec()
                    } else {
                        let mut combined = std::mem::take(&mut pending);
                        combined.extend_from_slice(&buffer[0..n]);
                        combined
                    };

                    // Find the last valid UTF-8 boundary
                    // Check if we might have an incomplete UTF-8 sequence at the end
                    let valid_end = find_utf8_boundary(&data);

                    if valid_end < data.len() {
                        // Save incomplete bytes for next iteration
                        pending = data[valid_end..].to_vec();
                        data.truncate(valid_end);
                    }

                    if !data.is_empty() {
                        // Producer heartbeat for the pipeline watchdog (lib.rs):
                        // "produced advances while consumed doesn't" = stalled consumer.
                        app_state.output_produced.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        // Send to channel (broadcast::Sender::send returns Result<usize, SendError>)
                        // We ignore error if no receivers
                        let _ = output_tx.send(ChannelPayload {
                            id: thread_id.clone(),
                            data,
                        });
                    }
                }
                Ok(_) => {
                    // EOF - send any remaining pending data
                    if !pending.is_empty() {
                        app_state.output_produced.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        let _ = output_tx.send(ChannelPayload {
                            id: thread_id.clone(),
                            data: pending,
                        });
                    }
                    break;
                }
                Err(_) => break, // Error
            }
        }
        // Spec 045 §3.3: capture the cwd BEFORE cleanup — cleanup_terminal_state
        // removes `terminal_cwds` and `terminals`, so this is the last moment the
        // shell's final directory is knowable. The renderer needs it to restart
        // the session in place (it cannot read it back afterwards).
        let exit_cwd = exit_cwd_for(&app_state.terminal_cwds, &thread_id);

        // Persist the final parser state BEFORE cleanup discards it — the periodic
        // flush only runs every 30s, so without this the session's last moments
        // never reach the history store. Harmless for explicit closes: close_terminal
        // deletes the row afterwards (a sub-ms interleave could leave an orphan row,
        // which the startup prune sweeps).
        app_state.persist_terminal_history(&thread_id, chrono::Utc::now().timestamp_millis());

        // Cleanup on exit
        log::info!("Terminal {} process exited, cleaning up state", thread_id);
        app_state.cleanup_terminal_state(&thread_id);

        // Notify UI
        if let Err(e) = app_state.app_handle.emit("terminal:exit", serde_json::json!({
            "id": thread_id,
            "exitCode": 0, // portable-pty doesn't easily give exit code here without more work
            "cwd": exit_cwd
        })) {
            log::warn!("Failed to emit terminal exit: {}", e);
        }

        // A dialog this shell owned (parented to the pseudo-console window we
        // adopt — see console_window) disables the app window while it is up.
        // If it died with the shell instead of being dismissed, nothing restores
        // that, and the whole window silently stops accepting input.
        crate::console_window::unstick_all(&app_state.app_handle);
    });

    Ok(id)
}

/// Kill a shell process tree (taskkill /T /F on Windows; kill -9 on the
/// process group on Unix). No-op for pid 0 (unknown).
///
/// Backgrounded on its own thread: every caller (`commands::close_terminal`,
/// `api_server::delete_terminal`, `api_server::fleet_close`) invokes this
/// inline from an async Tauri command / Axum handler. `taskkill /T /F` can
/// run 1-3s+ for a shell's whole process tree, and `.output()`/`.status()`
/// blocks synchronously — which stalls that specific tokio task (and the
/// worker thread running it) for the duration, same class of bug fixed for
/// the pty-host sidecar's `Session::kill()` (PR #61). None of the three
/// callers use the process's death as a signal before proceeding to
/// `cleanup_terminal_state`, so firing this off and returning immediately is
/// safe.
pub fn kill_process_tree(pid: u32) {
    if pid == 0 {
        return;
    }
    std::thread::spawn(move || kill_process_tree_blocking(pid));
}

fn kill_process_tree_blocking(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: spawn taskkill without allocating a console, so a
        // GUI app doesn't flash a command-line window on every tab close.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-9", &format!("-{}", pid)])
            .output();
    }
}
