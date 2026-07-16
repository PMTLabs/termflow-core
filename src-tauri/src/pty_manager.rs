use crate::state::{AppState, Terminal, ChannelPayload};
use crate::tmux_manager::TerminalBackend;
use dashmap::DashMap;
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use std::thread;
use std::io::Read;
use uuid::Uuid;
use std::path::Path;
use std::fs;
use std::collections::HashMap;
use tauri::Emitter;
use sysinfo::{System, Pid};

/// PowerShell prompt integration injected via `-Command` (see `spawn_terminal`). Both
/// jobs are gated on a FileSystem location — a registry/cert PSDrive cwd is neither a
/// spawnable directory nor a valid Win32 cwd:
///   1. Sync the Win32 process cwd to `$PWD` so native children launched from the
///      prompt inherit the interactive directory. PowerShell's `Set-Location` updates
///      `$PWD` but NOT the process cwd, so without this `wsl` (and git, …) start in the
///      stale spawn dir; with it, `wsl` lands at the `/mnt/<drive>/…` mount of the
///      current directory automatically. Best-effort via `try { … } catch {}`: the
///      .NET setter raises a TERMINATING error (`SetValueInvocationException`) when the
///      FileSystem `$PWD` isn't a valid Win32 cwd — a deleted directory, a UNC/PSDrive
///      path, or a >MAX_PATH path on Windows PowerShell 5.1. Unguarded, that throw
///      aborts the whole `prompt` function EVERY prompt, suppressing the OSC report (2)
///      AND the user's prompt (3) — so the guard is mandatory, and `-ErrorAction`
///      wouldn't catch a property-assignment throw.
///   2. Report the cwd to the backend via OSC 9;9 (parsed by `parse_osc_cwd`).
///   3. Invoke the user's captured prompt so it's preserved.
const PS_CWD_INTEGRATION: &str = "$__atOrig = $function:prompt; function prompt { if ($PWD.Provider.Name -eq 'FileSystem') { try { [Environment]::CurrentDirectory = $PWD.ProviderPath } catch {}; [Console]::Write([string][char]27 + ']9;9;' + $PWD.ProviderPath + [string][char]27 + '\\') }; if ($__atOrig) { & $__atOrig } else { 'PS ' + $PWD.Path + '> ' } }";

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct ShellProfile {
    pub id: String,
    pub name: String,
    pub path: String,
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    pub cwd: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub is_default: bool,
    #[serde(default)]
    pub is_custom: bool,
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Default)]
pub struct ProfilesConfig {
    pub profiles: Vec<ShellProfile>,
    pub default_profile_id: Option<String>,
}

/// Get the profiles config file path
fn get_profiles_path() -> std::path::PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    Path::new(&home).join(".auto-terminal").join("profiles.json")
}

/// Load custom profiles from disk
pub fn load_custom_profiles() -> Vec<ShellProfile> {
    let path = get_profiles_path();
    if path.exists() {
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(config) = serde_json::from_str::<ProfilesConfig>(&content) {
                return config.profiles.into_iter().filter(|p| p.is_custom).collect();
            }
        }
    }
    Vec::new()
}

/// Save custom profiles to disk
pub fn save_custom_profiles(profiles: &[ShellProfile]) -> Result<(), String> {
    let path = get_profiles_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    
    let config = ProfilesConfig {
        profiles: profiles.to_vec(),
        default_profile_id: profiles.iter().find(|p| p.is_default).map(|p| p.id.clone()),
    };
    
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

/// Decode UTF-16LE output from Windows commands (like wsl.exe)
#[cfg(target_os = "windows")]
fn decode_utf16le_output(bytes: &[u8]) -> String {
    // Windows wsl.exe outputs UTF-16LE with BOM
    // Convert pairs of bytes to u16 values, then to String
    if bytes.len() < 2 {
        return String::new();
    }

    // Skip BOM if present (0xFF 0xFE)
    let start = if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        2
    } else {
        0
    };

    let u16_values: Vec<u16> = bytes[start..]
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .collect();

    String::from_utf16_lossy(&u16_values)
}

/// Detect WSL distributions on Windows
#[cfg(target_os = "windows")]
fn detect_wsl_distributions() -> Vec<ShellProfile> {
    use std::process::Command;

    let mut profiles = Vec::new();

    // Check if wsl.exe exists. CREATE_NO_WINDOW so this detection spawn doesn't
    // flash a console window at startup (this fn is Windows-only).
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut cmd = Command::new("wsl.exe");
    cmd.args(["-l", "-v"]).creation_flags(CREATE_NO_WINDOW);
    if let Ok(output) = cmd.output() {
        if output.status.success() {
            // Parse WSL output - it's UTF-16LE on Windows
            let stdout = decode_utf16le_output(&output.stdout);

            for line in stdout.lines().skip(1) {
                // Skip header line
                let line = line.trim();
                if line.is_empty() { continue; }

                // Parse: "* Ubuntu    Running    2" or "  Debian    Stopped    2"
                // Note: The '*' indicates WSL's default distro, NOT the terminal's default profile
                let line = line.trim_start_matches('*').trim();

                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 1 {
                    let distro_name = parts[0];
                    let version = parts.get(2).unwrap_or(&"2");

                    profiles.push(ShellProfile {
                        id: format!("wsl-{}", distro_name.to_lowercase()),
                        name: format!("WSL - {} (v{})", distro_name, version),
                        path: "wsl.exe".to_string(),
                        args: vec!["-d".to_string(), distro_name.to_string()],
                        env: HashMap::new(),
                        cwd: None,
                        icon: Some("terminal-linux".to_string()),
                        is_default: false, // WSL default != terminal default profile
                        is_custom: false,
                    });
                }
            }
        }
    }
    
    profiles
}

#[cfg(not(target_os = "windows"))]
fn detect_wsl_distributions() -> Vec<ShellProfile> {
    Vec::new()
}

pub fn get_available_shells() -> Vec<ShellProfile> {
    let mut profiles = Vec::new();

    if cfg!(target_os = "windows") {
        // 1. PowerShell (Prefer v7 if available)
        let pwsh_7_path = r"C:\Program Files\PowerShell\7\pwsh.exe";
        if Path::new(pwsh_7_path).exists() {
            profiles.push(ShellProfile {
                id: "powershell".to_string(),
                name: "PowerShell 7".to_string(),
                path: pwsh_7_path.to_string(),
                args: vec![],
                env: HashMap::new(),
                cwd: None,
                icon: Some("terminal-powershell".to_string()),
                is_default: true,
                is_custom: false,
            });
        } else {
            profiles.push(ShellProfile {
                id: "powershell".to_string(),
                name: "PowerShell".to_string(),
                path: "powershell.exe".to_string(),
                args: vec![],
                env: HashMap::new(),
                cwd: None,
                icon: Some("terminal-powershell".to_string()),
                is_default: true,
                is_custom: false,
            });
        }

        // 2. Command Prompt
        profiles.push(ShellProfile {
            id: "cmd".to_string(),
            name: "Command Prompt".to_string(),
            path: "cmd.exe".to_string(),
            args: vec![],
            env: HashMap::new(),
            cwd: None,
            icon: Some("terminal-cmd".to_string()),
            is_default: false,
            is_custom: false,
        });
        
        // 3. Git Bash (Check multiple locations)
        let git_bash_paths = [
            r"C:\Program Files\Git\bin\bash.exe",
            r"C:\Program Files (x86)\Git\bin\bash.exe",
        ];
        for git_bash_path in git_bash_paths {
            if Path::new(git_bash_path).exists() {
                profiles.push(ShellProfile {
                    id: "git-bash".to_string(),
                    name: "Git Bash".to_string(),
                    path: git_bash_path.to_string(),
                    args: vec!["--login".to_string(), "-i".to_string()],
                    env: {
                        let mut env = HashMap::new();
                        env.insert("TERM".to_string(), "xterm-256color".to_string());
                        env
                    },
                    cwd: None,
                    icon: Some("terminal-bash".to_string()),
                    is_default: false,
                    is_custom: false,
                });
                break;
            }
        }
        
        // 4. Cygwin
        let cygwin_path = r"C:\cygwin64\bin\bash.exe";
        if Path::new(cygwin_path).exists() {
            profiles.push(ShellProfile {
                id: "cygwin".to_string(),
                name: "Cygwin Bash".to_string(),
                path: cygwin_path.to_string(),
                args: vec!["--login".to_string(), "-i".to_string()],
                env: HashMap::new(),
                cwd: None,
                icon: Some("terminal-bash".to_string()),
                is_default: false,
                is_custom: false,
            });
        }
        
        // 5. WSL distributions
        profiles.extend(detect_wsl_distributions());
        
    } else {
        // Unix-like systems
        let mut has_default = false;

        // Zsh (Primary on macOS)
        if Path::new("/bin/zsh").exists() {
            profiles.push(ShellProfile {
                id: "zsh".to_string(),
                name: "Zsh".to_string(),
                path: "/bin/zsh".to_string(),
                args: vec!["--login".to_string()],
                env: HashMap::new(),
                cwd: None,
                icon: Some("terminal-zsh".to_string()),
                is_default: true,
                is_custom: false,
            });
            has_default = true;
        } else if Path::new("/usr/bin/zsh").exists() {
             profiles.push(ShellProfile {
                id: "zsh".to_string(),
                name: "Zsh".to_string(),
                path: "/usr/bin/zsh".to_string(),
                args: vec!["--login".to_string()],
                env: HashMap::new(),
                cwd: None,
                icon: Some("terminal-zsh".to_string()),
                is_default: true,
                is_custom: false,
            });
            has_default = true;
        }

        // Bash (primary shell on most Linux distros — zsh/fish aren't always
        // installed, so without this, a fresh Linux box gets zero shell profiles
        // and the New Tab UI disables itself with nothing to fall back to).
        for bash_path in ["/bin/bash", "/usr/bin/bash"] {
            if Path::new(bash_path).exists() {
                profiles.push(ShellProfile {
                    id: "bash".to_string(),
                    name: "Bash".to_string(),
                    path: bash_path.to_string(),
                    args: vec!["--login".to_string()],
                    env: HashMap::new(),
                    cwd: None,
                    icon: Some("terminal-bash".to_string()),
                    is_default: !has_default,
                    is_custom: false,
                });
                break;
            }
        }

        // Fish
        for fish_path in ["/usr/bin/fish", "/usr/local/bin/fish", "/opt/homebrew/bin/fish"] {
            if Path::new(fish_path).exists() {
                profiles.push(ShellProfile {
                    id: "fish".to_string(),
                    name: "Fish".to_string(),
                    path: fish_path.to_string(),
                    args: vec!["--login".to_string()],
                    env: HashMap::new(),
                    cwd: None,
                    icon: Some("terminal-fish".to_string()),
                    is_default: false,
                    is_custom: false,
                });
                break;
            }
        }
    }
    
    // Add custom profiles from disk
    let custom_profiles = load_custom_profiles();
    profiles.extend(custom_profiles);
    
    profiles
}

/// Get a specific profile by ID
pub fn get_profile(profile_id: &str) -> Option<ShellProfile> {
    get_available_shells().into_iter().find(|p| p.id == profile_id)
}

/// Add a custom profile
pub fn add_custom_profile(mut profile: ShellProfile) -> Result<String, String> {
    profile.is_custom = true;
    if profile.id.is_empty() {
        profile.id = format!("custom-{}", chrono::Utc::now().timestamp_millis());
    }
    
    let mut custom = load_custom_profiles();
    custom.push(profile.clone());
    save_custom_profiles(&custom)?;
    
    Ok(profile.id)
}

/// Update a custom profile
pub fn update_custom_profile(profile_id: &str, updates: ShellProfile) -> Result<(), String> {
    let mut custom = load_custom_profiles();
    if let Some(existing) = custom.iter_mut().find(|p| p.id == profile_id) {
        existing.name = updates.name;
        existing.path = updates.path;
        existing.args = updates.args;
        existing.env = updates.env;
        existing.cwd = updates.cwd;
        existing.icon = updates.icon;
        existing.is_default = updates.is_default;
        save_custom_profiles(&custom)?;
        Ok(())
    } else {
        Err("Custom profile not found".to_string())
    }
}

/// Delete a custom profile
pub fn delete_custom_profile(profile_id: &str) -> Result<(), String> {
    let mut custom = load_custom_profiles();
    let initial_len = custom.len();
    custom.retain(|p| p.id != profile_id);
    
    if custom.len() == initial_len {
        return Err("Custom profile not found".to_string());
    }
    
    save_custom_profiles(&custom)?;
    Ok(())
}


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

pub fn spawn_terminal(
    app_state: AppState, 
    cols: u16, 
    rows: u16, 
    shell_path: Option<String>, 
    shell_args: Option<Vec<String>>, 
    cwd: Option<String>,
    shell_name: String,
    terminal_name: String
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
    cmd_builder.env("TERMFLOW_TERMINAL_ID", &id);

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
    const FOREIGN_TERMINAL_ENV: &[&str] = &[
        "WT_SESSION",                 // Windows Terminal
        "WT_PROFILE_ID",
        "WARP_TERMINAL_SESSION_UUID", // Warp
        "WARP_IS_LOCAL_SHELL_SESSION",
        "WARP_HONOR_PS1",
        "KITTY_WINDOW_ID",            // kitty
        "KITTY_PID",
        "ALACRITTY_LOG",              // Alacritty
        "ALACRITTY_WINDOW_ID",
        "KONSOLE_VERSION",            // Konsole
        "VTE_VERSION",                // GNOME/VTE family
        "ZED_TERM",                   // Zed
        "WEZTERM_PANE",               // WezTerm
        "WEZTERM_EXECUTABLE",
        "ITERM_SESSION_ID",           // iTerm2
        "LC_TERMINAL",
        "LC_TERMINAL_VERSION",
        "TERM_SESSION_ID",            // Apple Terminal
        "TILIX_ID",                   // Tilix
        "TERMINATOR_UUID",            // Terminator
    ];
    for key in FOREIGN_TERMINAL_ENV {
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

    // Register the terminal LAST: `terminals` is the existence gate for the
    // close/delete paths, so nothing may be observable until the writer, pty
    // master, and screen parser are all in place — otherwise a concurrent
    // delete could clean up half-constructed state and the remaining inserts
    // would resurrect orphaned entries no cleanup path ever removes.
    app_state.terminals.insert(id.clone(), Terminal {
        id: id.clone(),
        pid,
        shell: shell_name,
        name: terminal_name,
        created_at: chrono::Local::now().to_rfc3339(),
        cols,
        rows,
        backend: TerminalBackend::PortablePty,
        tab_id: Some(id.clone()),
        last_input_source: None,
        last_input_at: None,
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
    });

    Ok(id)
}

/// Kill a shell process tree (taskkill /T /F on Windows; kill -9 on the
/// process group on Unix). No-op for pid 0 (unknown).
pub fn kill_process_tree(pid: u32) {
    if pid == 0 {
        return;
    }
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

pub fn get_foreground_process_info(parent_pid: u32, sys_opt: Option<&System>) -> (u32, String) {
    let local_sys;
    let sys = if let Some(s) = sys_opt {
        s
    } else {
        local_sys = System::new_all();
        &local_sys
    };

    let mut current_pid = parent_pid;
    let mut current_name = "unknown".to_string();

    // Initialize with parent info
    if let Some(p) = sys.process(Pid::from(parent_pid as usize)) {
        current_name = p.name().to_string_lossy().to_string();
    }

    // Recursively find the "youngest" child (heuristic for foreground process)
    loop {
        let mut children: Vec<_> = sys.processes()
            .values()
            .filter(|p| {
                if let Some(ppid) = p.parent() {
                    ppid.as_u32() == current_pid
                } else {
                    false
                }
            })
            .collect();

        if children.is_empty() {
            break;
        }

        // Sort by PID descending to get the newest child
        children.sort_by(|a, b| b.pid().as_u32().cmp(&a.pid().as_u32()));
        
        let newest_child = children[0];
        current_pid = newest_child.pid().as_u32();
        current_name = newest_child.name().to_string_lossy().to_string();
    }

    (current_pid, current_name)
}

/// Derive a friendly label for the foreground program in a pane, from a
/// process's executable name and full argv. Returns None for a plain shell (an
/// idle pane) so the caller reverts to tab/default theming; returns a friendly
/// name for ANY other program so any agent — known or future — can be colored.
///
/// Matching is case-insensitive. argv is scanned ONLY when the exe is a script
/// interpreter (node/python/…), so an ordinary command that merely takes an
/// agent's name as an argument (`git checkout claude`) is labeled by its own exe
/// (`git`), never by the argument. Theming stays opt-in: a returned label only
/// recolors a pane when the user has assigned it a color.
pub fn detect_agent(name: &str, cmd: &[String]) -> Option<String> {
    let lowered = name.to_ascii_lowercase();
    let exe = lowered.strip_suffix(".exe").unwrap_or(&lowered);

    // Plain shells are "idle" — no agent. Excluding them keeps revert-on-exit
    // working and lets get_foreground_agent's walk descend past a shell (or a
    // Windows `.cmd` npm-shim) to the program the user actually launched.
    const SHELLS: &[&str] = &[
        "pwsh", "powershell", "bash", "sh", "zsh", "fish", "cmd", "wsl",
        "nu", "dash", "ksh", "csh", "tcsh",
    ];
    if SHELLS.contains(&exe) {
        return None;
    }

    // Script interpreters host an agent (claude/gemini/aider/…) — the exe alone
    // is "node"/"python", so derive the real name from argv. Gating argv scanning
    // to interpreters is what stops a non-interpreter that merely takes an agent's
    // name as an argument (`git checkout claude`) from misdetecting.
    const INTERPRETERS: &[&str] = &["node", "bun", "deno", "npx", "python", "python3", "py"];
    if INTERPRETERS.contains(&exe) {
        return Some(derive_interpreted_label(cmd).unwrap_or_else(|| exe.to_string()));
    }

    // Any other program is labeled by its own executable name.
    Some(exe.to_string())
}

/// Derive an agent name from an interpreter's argv (argv[0] is the interpreter,
/// skipped). First honor unambiguous package/module markers for canonical names;
/// otherwise use the basename of the first non-flag argv token, stripped of a
/// script extension. None when argv has no usable token (bare REPL).
fn derive_interpreted_label(cmd: &[String]) -> Option<String> {
    let joined = cmd
        .iter()
        .skip(1)
        .map(|s| s.to_ascii_lowercase())
        .collect::<Vec<_>>()
        .join(" ");
    const MARKERS: &[(&str, &str)] = &[
        ("claude-code", "claude"),
        ("@anthropic-ai/claude", "claude"),
        ("gemini-cli", "gemini"),
        ("@google/gemini", "gemini"),
        ("cursor-agent", "cursor-agent"),
    ];
    for (needle, label) in MARKERS {
        if joined.contains(needle) {
            return Some((*label).to_string());
        }
    }
    for arg in cmd.iter().skip(1) {
        let a = arg.to_ascii_lowercase();
        if a.starts_with('-') {
            continue; // skip flags (e.g. `-m aider`, `--foo`)
        }
        let base = a.rsplit(|c| c == '/' || c == '\\').next().unwrap_or(&a);
        let stem = base
            .strip_suffix(".js")
            .or_else(|| base.strip_suffix(".mjs"))
            .or_else(|| base.strip_suffix(".cjs"))
            .or_else(|| base.strip_suffix(".ts"))
            .or_else(|| base.strip_suffix(".py"))
            .unwrap_or(base);
        if !stem.is_empty() {
            return Some(stem.to_string());
        }
    }
    None
}

/// Walk a shell's descendant chain and return the first non-shell program (the
/// shallowest descendant the user launched). Because `detect_agent` returns None
/// for shells and a name for anything else, the walk stops at that launched
/// program — so an agent that spawned a transient child (e.g. claude launching
/// `git`/`rg`) is still reported as the agent, not the transient child. Returns
/// None when only shells are found (an idle pane).
pub fn get_foreground_agent(parent_pid: u32, sys: &System) -> Option<String> {
    get_foreground_agent_with_exe(parent_pid, sys).map(|(agent, _)| agent)
}

/// Like [`get_foreground_agent`], but also returns the matched process's executable
/// path (absolute), so the caller can extract the binary's icon. The exe is `None`
/// when sysinfo can't report it (a protected or cross-arch process on Windows).
/// Walk semantics are identical to `get_foreground_agent`.
pub fn get_foreground_agent_with_exe(
    parent_pid: u32,
    sys: &System,
) -> Option<(String, Option<String>)> {
    let mut current_pid = parent_pid;
    loop {
        if let Some(p) = sys.process(Pid::from(current_pid as usize)) {
            let name = p.name().to_string_lossy().to_string();
            let cmd: Vec<String> = p
                .cmd()
                .iter()
                .map(|s| s.to_string_lossy().to_string())
                .collect();
            if let Some(agent) = detect_agent(&name, &cmd) {
                let exe = p.exe().map(|e| e.to_string_lossy().to_string());
                return Some((agent, exe));
            }
        }
        // Descend to the newest child, mirroring get_foreground_process_info.
        let mut children: Vec<_> = sys
            .processes()
            .values()
            .filter(|p| {
                p.parent()
                    .map(|ppid| ppid.as_u32() == current_pid)
                    .unwrap_or(false)
            })
            .collect();
        if children.is_empty() {
            return None;
        }
        children.sort_by(|a, b| b.pid().as_u32().cmp(&a.pid().as_u32()));
        current_pid = children[0].pid().as_u32();
    }
}

/// Read a single process's current working directory (cross-platform via sysinfo).
fn cwd_of(sys: &System, pid: u32) -> Option<String> {
    sys.process(Pid::from(pid as usize))
        .and_then(|p| p.cwd())
        .map(|path| path.to_string_lossy().to_string())
}

/// Best-effort CWD of a terminal's foreground process. Walks to the youngest
/// descendant of `parent_pid` (so a `cd` inside a running program is reflected),
/// reading its cwd; falls back to the shell pid, then None. Returns None when the
/// OS won't report it (e.g. a protected/cross-arch process on Windows) so callers
/// can fall back to the app default.
///
/// NOTE: on Windows this reads the process's PEB working directory, which **cmd**
/// and Unix shells keep current but **PowerShell does NOT** update on `Set-Location`
/// — for PowerShell we rely on OSC cwd reporting (`parse_osc_cwd`) instead.
pub fn get_process_cwd(parent_pid: u32) -> Option<String> {
    get_process_cwd_with(&System::new_all(), parent_pid)
}

/// [`get_process_cwd`] against a process snapshot the caller already has.
///
/// `System::new_all()` is sysinfo's heaviest constructor (every process, plus cpu /
/// mem / disks / networks), so resolving a BATCH of terminals must scan once and
/// reuse it here, not once per terminal — see `commands::get_terminal_cwds`.
pub fn get_process_cwd_with(sys: &System, parent_pid: u32) -> Option<String> {
    let (fg_pid, _name) = get_foreground_process_info(parent_pid, Some(sys));
    cwd_of(sys, fg_pid).or_else(|| cwd_of(sys, parent_pid))
}

fn hex_digit(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Decode a `file://host/path` URI (OSC 7 payload) to a filesystem path, undoing
/// percent-encoding. Drops the scheme + host; on Windows a leading `/C:/...` becomes
/// `C:/...`. Percent-decoding operates on BYTES (re-assembled with `from_utf8_lossy`)
/// so a `%`-encoded multi-byte UTF-8 path decodes correctly and never panics on a
/// non-char-boundary slice.
fn file_uri_to_path(uri: &str) -> Option<String> {
    let after_scheme = uri.strip_prefix("file://")?;
    // Skip the host component up to the first '/'.
    let path_part = match after_scheme.find('/') {
        Some(i) => &after_scheme[i..],
        None => after_scheme,
    };
    let bytes = path_part.as_bytes();
    let mut out_bytes: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex_digit(bytes[i + 1]), hex_digit(bytes[i + 2])) {
                out_bytes.push((h << 4) | l);
                i += 3;
                continue;
            }
        }
        out_bytes.push(bytes[i]);
        i += 1;
    }
    let mut out = String::from_utf8_lossy(&out_bytes).into_owned();
    // `/C:/...` -> `C:/...` on Windows.
    if out.len() >= 3 && out.as_bytes()[0] == b'/' && out.as_bytes()[2] == b':' {
        out.remove(0);
    }
    if out.is_empty() { None } else { Some(out) }
}

/// Scan a PTY output chunk for a shell-reported working directory, emitted as an
/// OSC sequence: `ESC ] 9 ; 9 ; <path> ST` (ConEmu/Windows-Terminal style, what our
/// PowerShell integration sends) or `ESC ] 7 ; file://host/<path> ST` (OSC 7, used
/// by many bash/zsh setups). ST is BEL (0x07) or `ESC \`. Returns the LAST cwd in
/// the chunk, if any. Per-chunk only — a sequence split across reads is missed and
/// re-reported on the next prompt.
pub fn parse_osc_cwd(data: &[u8]) -> Option<String> {
    let s = String::from_utf8_lossy(data);
    let mut last: Option<String> = None;
    for (idx, _) in s.match_indices("\u{1b}]") {
        let rest = &s[idx + 2..];
        let Some(end) = rest.find('\u{07}').or_else(|| rest.find("\u{1b}\\")) else {
            continue;
        };
        let payload = &rest[..end];
        if let Some(p) = payload.strip_prefix("9;9;") {
            if !p.is_empty() {
                last = Some(p.to_string());
            }
        } else if let Some(p) = payload.strip_prefix("7;") {
            if let Some(path) = file_uri_to_path(p) {
                last = Some(path);
            }
        }
    }
    last
}

/// Last-known cwd for a terminal, for the exit event (spec 045 §3.3).
/// MUST be called BEFORE `cleanup_terminal_state`, which removes `terminal_cwds`
/// — after cleanup this is unrecoverable and the renderer would silently fall
/// back to the profile default.
///
/// The OSC-reported cwd is the ONLY source here. Unlike `commands::get_terminal_cwd`
/// there is deliberately NO `get_process_cwd(pid)` fallback, because this runs from
/// the PTY reader loop only once that loop has BROKEN — i.e. the shell is already
/// dead. Scanning for its pid would:
///   1. almost always return None anyway (the process is gone), while
///   2. paying a full `System::new_all()` scan ON THE READER THREAD, delaying the
///      `terminal:exit` emit + cleanup by ~100-500ms (late ended-tint/banner), and
///   3. worst of all, silently return the WRONG directory if the OS had already
///      RECYCLED that pid onto an unrelated process — restart would then open in a
///      random directory, attributed to this terminal.
///
/// Non-PowerShell shells (cmd/bash/WSL/zsh), which never populate `terminal_cwds`,
/// lose nothing: the renderer's 30s `refreshLiveCwds` tick already snapshots their
/// cwd from a LIVE process, `setCwdSnapshot` ignores a falsy value so a `cwd: None`
/// exit payload cannot erase it, and restart precedence is
/// `getCwdSnapshot ?? takeInitialCwd ?? profile` — so they resume in the last
/// refreshed directory.
///
/// Takes the map directly (rather than `&AppState`) so this can be unit tested
/// without constructing a full `AppState`, which requires a real `AppHandle<Wry>`
/// (`tauri::test::mock_app()` yields `AppState<MockRuntime>` instead, and only
/// under the Linux/macOS-only `integration-tests` feature — see `api_server.rs`).
fn exit_cwd_for(terminal_cwds: &DashMap<String, String>, id: &str) -> Option<String> {
    terminal_cwds.get(id).map(|cwd| cwd.value().clone())
}

#[cfg(test)]
mod cwd_tests {
    use super::{get_process_cwd, get_process_cwd_with};

    use super::parse_osc_cwd;

    use super::detect_agent;

    use super::{get_foreground_agent, get_foreground_agent_with_exe};
    use super::PS_CWD_INTEGRATION;
    use sysinfo::System;

    #[test]
    fn ps_prompt_syncs_win32_cwd_and_reports_osc() {
        // Locks in the two prompt-integration jobs: the Win32 cwd sync (so `wsl`
        // auto-cd's to the mount) and the OSC 9;9 cwd report — both from $PWD's
        // FileSystem provider path, guarded on the FileSystem provider.
        // The sync MUST be wrapped in try/catch: the .NET setter throws a terminating
        // error on a deleted/UNC/>MAX_PATH FileSystem cwd, which unguarded would abort
        // the whole prompt (killing the OSC report + user prompt) on every prompt.
        assert!(
            PS_CWD_INTEGRATION
                .contains("try { [Environment]::CurrentDirectory = $PWD.ProviderPath } catch {}"),
            "prompt must sync the Win32 cwd (so native children like wsl inherit it) inside a try/catch"
        );
        assert!(
            PS_CWD_INTEGRATION.contains("]9;9;"),
            "prompt must still emit the OSC 9;9 cwd report"
        );
        assert!(PS_CWD_INTEGRATION.contains("$PWD.Provider.Name -eq 'FileSystem'"));
    }

    #[test]
    fn osc_9_9_with_bel() {
        let data = b"prompt\x1b]9;9;D:\\sources\\demo\x07$ ";
        assert_eq!(parse_osc_cwd(data).as_deref(), Some("D:\\sources\\demo"));
    }

    #[test]
    fn osc_9_9_with_st() {
        let data = b"\x1b]9;9;/home/u/proj\x1b\\> ";
        assert_eq!(parse_osc_cwd(data).as_deref(), Some("/home/u/proj"));
    }

    #[test]
    fn osc_7_file_uri() {
        let data = b"\x1b]7;file://host/home/u/my%20proj\x07";
        assert_eq!(parse_osc_cwd(data).as_deref(), Some("/home/u/my proj"));
    }

    #[test]
    fn osc_7_windows_drive() {
        let data = b"\x1b]7;file://host/C:/work/app\x07";
        assert_eq!(parse_osc_cwd(data).as_deref(), Some("C:/work/app"));
    }

    #[test]
    fn osc_7_percent_encoded_non_ascii_decodes_without_panic() {
        // %C3%A9 is UTF-8 for 'é'; a raw '%' followed by a multi-byte char must not panic.
        let data = "\u{1b}]7;file://host/home/u/caf%C3%A9\u{07}".as_bytes();
        assert_eq!(parse_osc_cwd(data).as_deref(), Some("/home/u/café"));
        let raw_pct = "\u{1b}]9;9;D:\\a%中\u{07}".as_bytes();
        // OSC 9;9 isn't percent-decoded, but this must also not panic.
        assert_eq!(parse_osc_cwd(raw_pct).as_deref(), Some("D:\\a%中"));
    }

    #[test]
    fn returns_last_cwd_and_ignores_plain_text() {
        let data = b"no osc here";
        assert_eq!(parse_osc_cwd(data), None);
        let two = b"\x1b]9;9;/a\x07 ... \x1b]9;9;/b\x07";
        assert_eq!(parse_osc_cwd(two).as_deref(), Some("/b"));
    }

    #[test]
    fn detect_agent_native_exe_uses_own_name() {
        assert_eq!(detect_agent("codex.exe", &["codex".into()]), Some("codex".into()));
        assert_eq!(detect_agent("codex", &["codex".into()]), Some("codex".into()));
        // Any future native agent is labeled by its own name — no allowlist.
        assert_eq!(detect_agent("agy.exe", &["agy".into()]), Some("agy".into()));
        assert_eq!(detect_agent("aider", &["aider".into()]), Some("aider".into()));
    }

    #[test]
    fn detect_agent_shells_return_none() {
        for sh in ["pwsh", "powershell.exe", "bash", "zsh", "fish", "cmd.exe", "wsl", "nu"] {
            assert_eq!(detect_agent(sh, &[sh.into()]), None, "shell {sh} must be None");
        }
    }

    #[test]
    fn detect_agent_interpreter_marker_gives_canonical_name() {
        let claude = vec![
            "node".into(),
            "C:\\Users\\x\\AppData\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js".into(),
        ];
        assert_eq!(detect_agent("node", &claude), Some("claude".into()));
        assert_eq!(detect_agent("node", &["node".into(), "/usr/local/bin/claude".into()]), Some("claude".into()));
        let gemini = vec!["node".into(), "/usr/lib/node_modules/@google/gemini-cli/dist/gemini.js".into()];
        assert_eq!(detect_agent("node", &gemini), Some("gemini".into()));
        assert_eq!(detect_agent("python", &["python".into(), "-m".into(), "aider".into()]), Some("aider".into()));
    }

    #[test]
    fn detect_agent_interpreter_uses_script_basename_when_unknown() {
        // Open detection: an unknown script is labeled by its own basename, never
        // by an incidental agent-name elsewhere in the path.
        assert_eq!(detect_agent("node", &["node".into(), "server.js".into()]), Some("server".into()));
        assert_eq!(detect_agent("node", &["node".into(), "./codex-playground/run.js".into()]), Some("run".into()));
        assert_eq!(detect_agent("node", &["node".into(), "/home/gemini-stuff/build.js".into()]), Some("build".into()));
        // A direct basename invocation still yields that name.
        assert_eq!(detect_agent("node", &["node".into(), "/opt/tools/gemini.js".into()]), Some("gemini".into()));
    }

    #[test]
    fn detect_agent_arg_never_cross_misdetects() {
        // A non-interpreter taking an agent's name as an argument is labeled by its
        // OWN exe (open detection), and MUST NOT be labeled by the argument.
        assert_eq!(detect_agent("git", &["git".into(), "checkout".into(), "claude".into()]), Some("git".into()));
        assert_eq!(detect_agent("mkdir", &["mkdir".into(), "aider".into()]), Some("mkdir".into()));
        assert_eq!(detect_agent("grep", &["grep".into(), "gemini".into(), "file.txt".into()]), Some("grep".into()));
    }

    #[test]
    fn foreground_agent_delegates_to_with_exe_variant() {
        // The test binary has no child processes, so both the label-only and the
        // exe-aware walk return None from the test pid — proving get_foreground_agent
        // is a faithful projection of get_foreground_agent_with_exe.
        let sys = System::new_all();
        let pid = std::process::id();
        let label_only = get_foreground_agent(pid, &sys);
        let with_exe = get_foreground_agent_with_exe(pid, &sys);
        assert_eq!(label_only, with_exe.clone().map(|(a, _)| a));
    }

    /// The batch command (`commands::get_terminal_cwds`) resolves EVERY requested pid
    /// against one shared `System::new_all()` instead of paying that scan per terminal.
    /// That reuse is only safe if it is a faithful projection of the owned-scan
    /// version, which is what this pins.
    #[test]
    fn process_cwd_with_a_shared_system_matches_the_owned_scan() {
        let pid = std::process::id();
        let sys = System::new_all();
        assert_eq!(get_process_cwd_with(&sys, pid), get_process_cwd(pid));
    }

    #[test]
    fn process_cwd_resolves_for_current_process() {
        // The test binary has no child processes, so the foreground walk returns
        // the test pid itself; its cwd must equal the process's working directory.
        let pid = std::process::id();
        let got = get_process_cwd(pid);
        // cwd() can be None on a locked-down platform; only assert when present.
        if let Some(cwd) = got {
            let expected = std::env::current_dir().unwrap();
            assert_eq!(std::path::Path::new(&cwd), expected.as_path());
        }
    }

    // exit_cwd_for takes the DashMap directly rather than `&AppState`: an
    // `AppState<Wry>` (what spawn_terminal/exit_cwd_for actually use) needs a real
    // `AppHandle<Wry>`, which cannot be constructed in a unit test on this platform
    // (`tauri::test::mock_app()` yields `AppState<MockRuntime>`, gated behind the
    // Linux/macOS-only `integration-tests` feature — see api_server.rs). Testing
    // the map directly exercises the same logic without that machinery.
    use super::exit_cwd_for;
    use dashmap::DashMap;

    /// Spec 045 §3.3: the exit payload must carry the cwd, because
    /// cleanup_terminal_state() wipes `terminal_cwds` BEFORE the event is emitted
    /// — so a renderer-side get_terminal_cwd() after the event can only ever
    /// return None. This pins the ordering the fix depends on. The removal below
    /// mirrors exactly what cleanup_terminal_state does to this map.
    #[test]
    fn exit_cwd_is_read_before_cleanup_wipes_it() {
        let terminal_cwds: DashMap<String, String> = DashMap::new();
        terminal_cwds.insert("t-1".to_string(), "D:\\work\\project".to_string());

        // What the exit path must do: capture first...
        let captured = exit_cwd_for(&terminal_cwds, "t-1");
        assert_eq!(captured.as_deref(), Some("D:\\work\\project"));

        // ...then clean up. After cleanup the value is unrecoverable.
        terminal_cwds.remove("t-1");
        assert!(exit_cwd_for(&terminal_cwds, "t-1").is_none());
    }

    #[test]
    fn exit_cwd_is_none_for_an_unknown_terminal() {
        let terminal_cwds: DashMap<String, String> = DashMap::new();
        assert!(exit_cwd_for(&terminal_cwds, "nope").is_none());
    }

    /// Replaces `exit_cwd_falls_back_to_live_process_cwd_when_absent_from_terminal_cwds`,
    /// which was green over a branch production can never reach: it fed exit_cwd_for
    /// the TEST BINARY's own (live) pid, while in production exit_cwd_for only ever
    /// runs after the PTY reader loop broke — i.e. the shell's pid is already DEAD.
    /// The scan therefore returned None (after a costly `System::new_all()` on the
    /// reader thread), or, if the OS had recycled the pid, some unrelated process's
    /// directory. The fallback is gone; a miss must be a cheap, honest None.
    ///
    /// Non-PowerShell shells (the ones that never populate `terminal_cwds`) are
    /// covered by the renderer's live `refreshLiveCwds` tick instead — see the
    /// exit_cwd_for doc comment.
    #[test]
    fn exit_cwd_is_none_when_no_osc_cwd_was_reported() {
        let terminal_cwds: DashMap<String, String> = DashMap::new();
        // A cmd/bash terminal: known to the app, but it never reported an OSC cwd.
        // Even with a resolvable live pid available, exit_cwd_for must not go
        // looking for one — at exit time that pid is dead and possibly recycled.
        terminal_cwds.insert("other".to_string(), "D:\\elsewhere".to_string());
        assert!(exit_cwd_for(&terminal_cwds, "t-1").is_none());
    }
}
