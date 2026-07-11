//! tmux Manager Module
//!
//! Provides tmux-based terminal backend for content reflow on resize.
//! Supports native tmux (Linux/macOS) and WSL tmux (Windows).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Command;

/// Error types for tmux operations
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum TmuxError {
    /// tmux is not available on this system
    NotAvailable,
    /// tmux command execution failed
    CommandFailed(String),
    /// Session not found
    SessionNotFound(String),
    /// Failed to parse tmux output
    ParseError(String),
    /// WSL-specific error
    WslError(String),
    /// Invalid session name
    InvalidSessionName(String),
}

impl std::fmt::Display for TmuxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TmuxError::NotAvailable => write!(f, "tmux is not available on this system"),
            TmuxError::CommandFailed(msg) => write!(f, "tmux command failed: {}", msg),
            TmuxError::SessionNotFound(name) => write!(f, "tmux session not found: {}", name),
            TmuxError::ParseError(msg) => write!(f, "failed to parse tmux output: {}", msg),
            TmuxError::WslError(msg) => write!(f, "WSL error: {}", msg),
            TmuxError::InvalidSessionName(name) => write!(f, "invalid tmux session name: {}", name),
        }
    }
}

impl std::error::Error for TmuxError {}

/// Terminal backend type
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TerminalBackend {
    /// Standard portable-pty backend (fallback)
    PortablePty,
    /// Native tmux on Linux/macOS
    TmuxNative,
    /// tmux via WSL on Windows
    TmuxWsl,
}

impl Default for TerminalBackend {
    fn default() -> Self {
        TerminalBackend::PortablePty
    }
}

/// tmux configuration and availability status
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TmuxConfig {
    /// Whether tmux is available (native or via WSL)
    pub available: bool,
    /// Path to tmux binary (or "wsl" for WSL-based tmux)
    pub tmux_path: String,
    /// WSL distribution name if using WSL (Windows only)
    pub wsl_distro: Option<String>,
    /// Default shell to use in tmux sessions
    pub default_shell: String,
    /// Additional tmux options
    pub options: HashMap<String, String>,
}

impl Default for TmuxConfig {
    fn default() -> Self {
        Self {
            available: false,
            tmux_path: String::new(),
            wsl_distro: None,
            default_shell: String::from("/bin/bash"),
            options: HashMap::new(),
        }
    }
}

/// Information about a WSL distribution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WslDistro {
    /// Distribution name (e.g., "Ubuntu", "Debian")
    pub name: String,
    /// Whether this is the default distribution
    pub is_default: bool,
    /// WSL version (1 or 2)
    pub version: u8,
    /// Current state (Running, Stopped, etc.)
    pub state: String,
    /// Whether tmux is available in this distro
    pub has_tmux: bool,
}

/// Captured terminal content from tmux
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapturedContent {
    /// The captured terminal content with ANSI escape sequences
    pub content: String,
    /// Number of lines in the captured content
    pub line_count: usize,
    /// Whether scrollback buffer was included
    pub includes_scrollback: bool,
    /// Cursor position as (row, col) if available
    pub cursor_position: Option<(u16, u16)>,
}

/// tmux session information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TmuxSession {
    /// Unique session identifier (maps to terminal ID)
    pub id: String,
    /// tmux session name (sanitized from id)
    pub session_name: String,
    /// Current column count
    pub cols: u16,
    /// Current row count
    pub rows: u16,
    /// Shell used in this session
    pub shell: String,
    /// WSL distribution if using WSL backend
    pub wsl_distro: Option<String>,
    /// ISO timestamp when session was created
    pub created_at: String,
    /// tmux server PID if available
    pub server_pid: Option<u32>,
}

/// Sanitize a terminal ID into a valid tmux session name.
///
/// tmux session names must:
/// - Not contain periods or colons
/// - Not start with a period
/// - Be non-empty
///
/// This function converts UUIDs and other IDs into valid session names.
pub fn sanitize_session_name(id: &str) -> String {
    if id.is_empty() {
        return String::from("session");
    }

    // Replace invalid characters with underscores
    let sanitized: String = id
        .chars()
        .map(|c| match c {
            '.' | ':' | ' ' | '\t' | '\n' | '\r' => '_',
            c if c.is_ascii_alphanumeric() || c == '-' || c == '_' => c,
            _ => '_',
        })
        .collect();

    // Ensure it doesn't start with a period (already handled above)
    // Prefix with 'at_' to make it clearly from auto-terminal
    format!("at_{}", sanitized)
}

/// Detect tmux availability on the system.
///
/// On Linux/macOS: Checks for native tmux installation
/// On Windows: Checks for tmux within WSL distributions
///
/// Returns a `TmuxConfig` with availability information.
pub fn detect_tmux_availability() -> TmuxConfig {
    let mut config = TmuxConfig::default();

    #[cfg(target_os = "windows")]
    {
        // On Windows, check WSL for tmux
        if let Ok(distros) = detect_wsl_distros() {
            for distro in distros {
                if distro.has_tmux {
                    config.available = true;
                    config.tmux_path = String::from("wsl.exe");
                    config.wsl_distro = Some(distro.name.clone());
                    // Use bash as default shell in WSL
                    config.default_shell = String::from("/bin/bash");
                    log::info!(
                        "tmux available via WSL distribution: {}",
                        distro.name
                    );
                    break;
                }
            }
        }

        if !config.available {
            log::info!("tmux not available: no WSL distribution with tmux found");
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        // On Linux/macOS, check for native tmux
        if let Ok(tmux_path) = check_native_tmux() {
            config.available = true;
            config.tmux_path = tmux_path;
            // Detect default shell
            config.default_shell = detect_default_shell();
            log::info!("Native tmux available at: {}", config.tmux_path);
        } else {
            log::info!("tmux not available: not found in PATH or common locations");
        }
    }

    config
}

/// Detect available WSL distributions (Windows only).
///
/// Returns a list of WSL distributions with their tmux availability status.
#[cfg(target_os = "windows")]
pub fn detect_wsl_distros() -> Result<Vec<WslDistro>, TmuxError> {
    let mut cmd = Command::new("wsl.exe");
    cmd.args(["--list", "--verbose"]);
    hide_console(&mut cmd);
    let output = cmd
        .output()
        .map_err(|e| TmuxError::WslError(format!("Failed to run wsl.exe: {}", e)))?;

    if !output.status.success() {
        return Err(TmuxError::WslError(format!(
            "wsl --list --verbose failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }

    // WSL output is UTF-16LE encoded on Windows
    let stdout = decode_wsl_output(&output.stdout);
    parse_wsl_list_output(&stdout)
}

/// Detect available WSL distributions (stub for non-Windows platforms).
#[cfg(not(target_os = "windows"))]
pub fn detect_wsl_distros() -> Result<Vec<WslDistro>, TmuxError> {
    // WSL is Windows-only
    Ok(Vec::new())
}

/// Decode WSL command output from UTF-16LE to String.
#[cfg(target_os = "windows")]
fn decode_wsl_output(bytes: &[u8]) -> String {
    // WSL outputs UTF-16LE on Windows
    let u16_iter = bytes
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]));

    char::decode_utf16(u16_iter)
        .filter_map(|r| r.ok())
        .collect()
}

/// Parse the output of `wsl --list --verbose`.
#[cfg(target_os = "windows")]
fn parse_wsl_list_output(output: &str) -> Result<Vec<WslDistro>, TmuxError> {
    let mut distros = Vec::new();

    // Skip header line and empty lines
    for line in output.lines().skip(1) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        // Parse line format: "* Ubuntu    Running    2" or "  Debian    Stopped    1"
        // The asterisk indicates the default distribution
        let is_default = line.starts_with('*');
        let line = line.trim_start_matches('*').trim();

        // Split by whitespace
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 3 {
            let name = parts[0].to_string();
            let state = parts[1].to_string();
            let version = parts[2].parse::<u8>().unwrap_or(2);

            // Check if tmux is available in this distro
            let has_tmux = check_wsl_tmux(&name).is_ok();

            distros.push(WslDistro {
                name,
                is_default,
                version,
                state,
                has_tmux,
            });
        }
    }

    Ok(distros)
}

/// Check if tmux is installed in a specific WSL distribution.
#[cfg(target_os = "windows")]
pub fn check_wsl_tmux(distro: &str) -> Result<String, TmuxError> {
    let mut cmd = Command::new("wsl.exe");
    cmd.args(["-d", distro, "which", "tmux"]);
    hide_console(&mut cmd);
    let output = cmd
        .output()
        .map_err(|e| TmuxError::WslError(format!("Failed to check tmux in {}: {}", distro, e)))?;

    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !path.is_empty() {
            return Ok(path);
        }
    }

    // Also check common paths if 'which' fails
    let common_paths = ["/usr/bin/tmux", "/usr/local/bin/tmux"];
    for path in common_paths {
        let mut cmd = Command::new("wsl.exe");
        cmd.args(["-d", distro, "test", "-x", path]);
        hide_console(&mut cmd);
        let check = cmd.status();

        if let Ok(status) = check {
            if status.success() {
                return Ok(path.to_string());
            }
        }
    }

    Err(TmuxError::NotAvailable)
}

/// Check if tmux is installed in a specific WSL distribution (stub for non-Windows).
#[cfg(not(target_os = "windows"))]
pub fn check_wsl_tmux(_distro: &str) -> Result<String, TmuxError> {
    Err(TmuxError::WslError(
        "WSL is only available on Windows".to_string(),
    ))
}

/// Check for native tmux installation (Linux/macOS).
///
/// Returns the path to the tmux binary if found.
#[cfg(not(target_os = "windows"))]
pub fn check_native_tmux() -> Result<String, TmuxError> {
    // Try 'which tmux' first
    if let Ok(output) = Command::new("which").arg("tmux").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                // Verify it's executable
                if std::path::Path::new(&path).exists() {
                    return Ok(path);
                }
            }
        }
    }

    // Check common installation paths
    let common_paths = [
        "/usr/bin/tmux",
        "/usr/local/bin/tmux",
        "/opt/homebrew/bin/tmux", // macOS Homebrew on Apple Silicon
        "/home/linuxbrew/.linuxbrew/bin/tmux", // Linuxbrew
    ];

    for path in common_paths {
        if std::path::Path::new(path).exists() {
            // Verify it's executable
            if let Ok(metadata) = std::fs::metadata(path) {
                use std::os::unix::fs::PermissionsExt;
                if metadata.permissions().mode() & 0o111 != 0 {
                    return Ok(path.to_string());
                }
            }
        }
    }

    Err(TmuxError::NotAvailable)
}

/// Check for native tmux installation (stub for Windows).
#[cfg(target_os = "windows")]
pub fn check_native_tmux() -> Result<String, TmuxError> {
    // Native tmux doesn't exist on Windows
    Err(TmuxError::NotAvailable)
}

/// Detect the default shell on the system.
#[cfg(not(target_os = "windows"))]
fn detect_default_shell() -> String {
    // Check SHELL environment variable first
    if let Ok(shell) = std::env::var("SHELL") {
        if !shell.is_empty() {
            return shell;
        }
    }

    // Fallback to /bin/bash
    String::from("/bin/bash")
}

// ============================================================================
// Session Lifecycle Management Functions
// ============================================================================

/// Build a tmux command with optional WSL wrapper.
///
/// If config.wsl_distro is Some, wraps the command with `wsl.exe -d <distro> -e`.
/// Otherwise, runs tmux directly.
/// Apply CREATE_NO_WINDOW on Windows so spawning console programs (wsl.exe for
/// detection + tmux lifecycle) doesn't flash a command-line window from the GUI
/// app. No-op on other platforms.
#[allow(unused_variables)]
fn hide_console(cmd: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

fn build_tmux_command(config: &TmuxConfig, args: &[&str]) -> Command {
    let mut cmd = if let Some(ref distro) = config.wsl_distro {
        // WSL mode: wsl.exe -d <distro> -e tmux <args>
        let mut cmd = Command::new("wsl.exe");
        cmd.args(["-d", distro, "-e", "tmux"]);
        cmd.args(args);
        cmd
    } else {
        // Native mode: tmux <args>
        let mut cmd = Command::new(&config.tmux_path);
        cmd.args(args);
        cmd
    };
    hide_console(&mut cmd);
    cmd
}

/// Create a new tmux session.
///
/// # Arguments
/// * `config` - tmux configuration with path and WSL info
/// * `id` - Unique terminal identifier (will be sanitized for tmux)
/// * `cols` - Initial column count
/// * `rows` - Initial row count
/// * `shell` - Optional shell to use (defaults to config.default_shell)
/// * `cwd` - Optional working directory
///
/// # Returns
/// A `TmuxSession` struct on success, or `TmuxError` on failure.
pub fn spawn_session(
    config: &TmuxConfig,
    id: &str,
    cols: u16,
    rows: u16,
    shell: Option<&str>,
    cwd: Option<&str>,
) -> Result<TmuxSession, TmuxError> {
    if !config.available {
        return Err(TmuxError::NotAvailable);
    }

    let session_name = sanitize_session_name(id);
    let shell_to_use = shell.unwrap_or(&config.default_shell);

    // Build arguments: new-session -d -s <name> -x <cols> -y <rows>
    let cols_str = cols.to_string();
    let rows_str = rows.to_string();

    let mut args = vec![
        "new-session",
        "-d",
        "-s",
        &session_name,
        "-x",
        &cols_str,
        "-y",
        &rows_str,
    ];

    // Add working directory if specified
    if let Some(dir) = cwd {
        args.push("-c");
        args.push(dir);
    }

    // Add shell command
    args.push(shell_to_use);

    let mut cmd = build_tmux_command(config, &args);

    let output = cmd.output().map_err(|e| {
        TmuxError::CommandFailed(format!("Failed to spawn tmux session: {}", e))
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(TmuxError::CommandFailed(format!(
            "tmux new-session failed: {}",
            stderr.trim()
        )));
    }

    // Try to get server PID
    let server_pid = get_server_pid(config, &session_name).ok();

    // Create timestamp
    let created_at = chrono::Utc::now().to_rfc3339();

    Ok(TmuxSession {
        id: id.to_string(),
        session_name,
        cols,
        rows,
        shell: shell_to_use.to_string(),
        wsl_distro: config.wsl_distro.clone(),
        created_at,
        server_pid,
    })
}

/// Get the tmux server PID for a session.
fn get_server_pid(config: &TmuxConfig, session_name: &str) -> Result<u32, TmuxError> {
    let args = [
        "display-message",
        "-t",
        session_name,
        "-p",
        "#{pid}",
    ];

    let mut cmd = build_tmux_command(config, &args);
    let output = cmd.output().map_err(|e| {
        TmuxError::CommandFailed(format!("Failed to get server PID: {}", e))
    })?;

    if output.status.success() {
        let pid_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
        pid_str
            .parse::<u32>()
            .map_err(|_| TmuxError::ParseError(format!("Invalid PID: {}", pid_str)))
    } else {
        Err(TmuxError::CommandFailed("Failed to get server PID".to_string()))
    }
}

/// Resize a tmux session and capture the reflowed content.
///
/// # Arguments
/// * `session` - The tmux session to resize
/// * `config` - tmux configuration
/// * `cols` - New column count
/// * `rows` - New row count
///
/// # Returns
/// `CapturedContent` with the reflowed terminal content.
pub fn resize_session(
    session: &TmuxSession,
    config: &TmuxConfig,
    cols: u16,
    rows: u16,
) -> Result<CapturedContent, TmuxError> {
    if !config.available {
        return Err(TmuxError::NotAvailable);
    }

    let cols_str = cols.to_string();
    let rows_str = rows.to_string();

    // Resize the window: resize-window -t <session> -x <cols> -y <rows>
    let resize_args = [
        "resize-window",
        "-t",
        &session.session_name,
        "-x",
        &cols_str,
        "-y",
        &rows_str,
    ];

    let mut cmd = build_tmux_command(config, &resize_args);
    let output = cmd.output().map_err(|e| {
        TmuxError::CommandFailed(format!("Failed to resize tmux session: {}", e))
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Check if session doesn't exist
        if stderr.contains("no such session") || stderr.contains("session not found") {
            return Err(TmuxError::SessionNotFound(session.session_name.clone()));
        }
        return Err(TmuxError::CommandFailed(format!(
            "tmux resize-window failed: {}",
            stderr.trim()
        )));
    }

    // Capture the reflowed content (visible pane only, not scrollback)
    capture_content(session, config, false)
}

/// Capture terminal content from a tmux session.
///
/// # Arguments
/// * `session` - The tmux session to capture from
/// * `config` - tmux configuration
/// * `include_scrollback` - Whether to include scrollback history
///
/// # Returns
/// `CapturedContent` with terminal content and ANSI escape sequences.
pub fn capture_content(
    session: &TmuxSession,
    config: &TmuxConfig,
    include_scrollback: bool,
) -> Result<CapturedContent, TmuxError> {
    if !config.available {
        return Err(TmuxError::NotAvailable);
    }

    // Build capture-pane arguments:
    // -t <session> : target session
    // -p           : print to stdout
    // -e           : include escape sequences (ANSI colors)
    // -J           : join wrapped lines
    // -S -3000     : start from 3000 lines back (scrollback)
    let mut args = vec![
        "capture-pane",
        "-t",
        &session.session_name,
        "-p",
        "-e",
        "-J",
    ];

    if include_scrollback {
        args.push("-S");
        args.push("-3000");
    }

    let mut cmd = build_tmux_command(config, &args);
    let output = cmd.output().map_err(|e| {
        TmuxError::CommandFailed(format!("Failed to capture tmux content: {}", e))
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("no such session") || stderr.contains("session not found") {
            return Err(TmuxError::SessionNotFound(session.session_name.clone()));
        }
        return Err(TmuxError::CommandFailed(format!(
            "tmux capture-pane failed: {}",
            stderr.trim()
        )));
    }

    let content = String::from_utf8_lossy(&output.stdout).to_string();
    let line_count = content.lines().count();

    // Try to get cursor position
    let cursor_position = get_cursor_position(session, config).ok();

    Ok(CapturedContent {
        content,
        line_count,
        includes_scrollback: include_scrollback,
        cursor_position,
    })
}

/// Get the current cursor position in a tmux session.
fn get_cursor_position(session: &TmuxSession, config: &TmuxConfig) -> Result<(u16, u16), TmuxError> {
    let args = [
        "display-message",
        "-t",
        &session.session_name,
        "-p",
        "#{cursor_x},#{cursor_y}",
    ];

    let mut cmd = build_tmux_command(config, &args);
    let output = cmd.output().map_err(|e| {
        TmuxError::CommandFailed(format!("Failed to get cursor position: {}", e))
    })?;

    if output.status.success() {
        let pos_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let parts: Vec<&str> = pos_str.split(',').collect();
        if parts.len() == 2 {
            let x = parts[0].parse::<u16>().map_err(|_| {
                TmuxError::ParseError(format!("Invalid cursor x: {}", parts[0]))
            })?;
            let y = parts[1].parse::<u16>().map_err(|_| {
                TmuxError::ParseError(format!("Invalid cursor y: {}", parts[1]))
            })?;
            return Ok((y, x)); // Return as (row, col)
        }
    }

    Err(TmuxError::ParseError("Failed to parse cursor position".to_string()))
}

/// Send input to a tmux session.
///
/// # Arguments
/// * `session` - The tmux session to send input to
/// * `config` - tmux configuration
/// * `data` - Raw input bytes to send
///
/// # Returns
/// `Ok(())` on success, or `TmuxError` on failure.
pub fn send_input(
    session: &TmuxSession,
    config: &TmuxConfig,
    data: &[u8],
) -> Result<(), TmuxError> {
    if !config.available {
        return Err(TmuxError::NotAvailable);
    }

    // Convert bytes to string for send-keys
    // tmux send-keys -t <session> -l <data>
    // -l flag sends keys literally (no key name interpretation)
    let data_str = String::from_utf8_lossy(data);

    // Handle special case: empty input
    if data_str.is_empty() {
        return Ok(());
    }

    // For special keys like Enter, we need to handle them differently
    // The -l flag makes it literal, but some control characters need special handling
    let args = [
        "send-keys",
        "-t",
        &session.session_name,
        "-l",
        &data_str,
    ];

    let mut cmd = build_tmux_command(config, &args);
    let output = cmd.output().map_err(|e| {
        TmuxError::CommandFailed(format!("Failed to send input to tmux session: {}", e))
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("no such session") || stderr.contains("session not found") {
            return Err(TmuxError::SessionNotFound(session.session_name.clone()));
        }
        return Err(TmuxError::CommandFailed(format!(
            "tmux send-keys failed: {}",
            stderr.trim()
        )));
    }

    Ok(())
}

/// Send a special key (like Enter, Tab, etc.) to a tmux session.
///
/// # Arguments
/// * `session` - The tmux session to send the key to
/// * `config` - tmux configuration
/// * `key` - Key name as recognized by tmux (e.g., "Enter", "Tab", "Escape")
///
/// # Returns
/// `Ok(())` on success, or `TmuxError` on failure.
pub fn send_key(
    session: &TmuxSession,
    config: &TmuxConfig,
    key: &str,
) -> Result<(), TmuxError> {
    if !config.available {
        return Err(TmuxError::NotAvailable);
    }

    // send-keys without -l interprets key names
    let args = [
        "send-keys",
        "-t",
        &session.session_name,
        key,
    ];

    let mut cmd = build_tmux_command(config, &args);
    let output = cmd.output().map_err(|e| {
        TmuxError::CommandFailed(format!("Failed to send key to tmux session: {}", e))
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("no such session") || stderr.contains("session not found") {
            return Err(TmuxError::SessionNotFound(session.session_name.clone()));
        }
        return Err(TmuxError::CommandFailed(format!(
            "tmux send-keys failed: {}",
            stderr.trim()
        )));
    }

    Ok(())
}

/// Terminate a tmux session.
///
/// # Arguments
/// * `session` - The tmux session to kill
/// * `config` - tmux configuration
///
/// # Returns
/// `Ok(())` on success, or `TmuxError` on failure.
pub fn kill_session(
    session: &TmuxSession,
    config: &TmuxConfig,
) -> Result<(), TmuxError> {
    if !config.available {
        return Err(TmuxError::NotAvailable);
    }

    let args = [
        "kill-session",
        "-t",
        &session.session_name,
    ];

    let mut cmd = build_tmux_command(config, &args);
    let output = cmd.output().map_err(|e| {
        TmuxError::CommandFailed(format!("Failed to kill tmux session: {}", e))
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Session not found is actually ok for kill - it means it's already gone
        if stderr.contains("no such session") || stderr.contains("session not found") {
            log::debug!(
                "Session {} already terminated",
                session.session_name
            );
            return Ok(());
        }
        return Err(TmuxError::CommandFailed(format!(
            "tmux kill-session failed: {}",
            stderr.trim()
        )));
    }

    Ok(())
}

/// Check if a tmux session exists.
///
/// # Arguments
/// * `session_name` - The session name to check
/// * `config` - tmux configuration
///
/// # Returns
/// `true` if the session exists, `false` otherwise.
pub fn session_exists(
    session_name: &str,
    config: &TmuxConfig,
) -> bool {
    if !config.available {
        return false;
    }

    let args = [
        "has-session",
        "-t",
        session_name,
    ];

    let mut cmd = build_tmux_command(config, &args);
    cmd.status().map(|s| s.success()).unwrap_or(false)
}

/// List all tmux sessions.
///
/// # Arguments
/// * `config` - tmux configuration
///
/// # Returns
/// Vector of session names, or `TmuxError` on failure.
pub fn list_sessions(config: &TmuxConfig) -> Result<Vec<String>, TmuxError> {
    if !config.available {
        return Err(TmuxError::NotAvailable);
    }

    let args = [
        "list-sessions",
        "-F",
        "#{session_name}",
    ];

    let mut cmd = build_tmux_command(config, &args);
    let output = cmd.output().map_err(|e| {
        TmuxError::CommandFailed(format!("Failed to list tmux sessions: {}", e))
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // "no server running" is not an error - just means no sessions
        if stderr.contains("no server running") || stderr.contains("no sessions") {
            return Ok(Vec::new());
        }
        return Err(TmuxError::CommandFailed(format!(
            "tmux list-sessions failed: {}",
            stderr.trim()
        )));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let sessions: Vec<String> = stdout
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    Ok(sessions)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_session_name_uuid() {
        let uuid = "550e8400-e29b-41d4-a716-446655440000";
        let sanitized = sanitize_session_name(uuid);
        assert_eq!(sanitized, "at_550e8400-e29b-41d4-a716-446655440000");
        assert!(!sanitized.contains('.'));
        assert!(!sanitized.contains(':'));
    }

    #[test]
    fn test_sanitize_session_name_with_dots() {
        let name = "terminal.1.session";
        let sanitized = sanitize_session_name(name);
        assert_eq!(sanitized, "at_terminal_1_session");
        assert!(!sanitized.contains('.'));
    }

    #[test]
    fn test_sanitize_session_name_with_colons() {
        let name = "session:123:abc";
        let sanitized = sanitize_session_name(name);
        assert_eq!(sanitized, "at_session_123_abc");
        assert!(!sanitized.contains(':'));
    }

    #[test]
    fn test_sanitize_session_name_empty() {
        let name = "";
        let sanitized = sanitize_session_name(name);
        assert_eq!(sanitized, "session");
    }

    #[test]
    fn test_sanitize_session_name_special_chars() {
        let name = "test@session#1!";
        let sanitized = sanitize_session_name(name);
        assert_eq!(sanitized, "at_test_session_1_");
    }

    #[test]
    fn test_tmux_error_display() {
        let err = TmuxError::NotAvailable;
        assert_eq!(
            format!("{}", err),
            "tmux is not available on this system"
        );

        let err = TmuxError::SessionNotFound("test".to_string());
        assert_eq!(format!("{}", err), "tmux session not found: test");
    }

    #[test]
    fn test_terminal_backend_default() {
        let backend = TerminalBackend::default();
        assert_eq!(backend, TerminalBackend::PortablePty);
    }

    #[test]
    fn test_tmux_config_default() {
        let config = TmuxConfig::default();
        assert!(!config.available);
        assert!(config.tmux_path.is_empty());
        assert!(config.wsl_distro.is_none());
        assert_eq!(config.default_shell, "/bin/bash");
    }

    // ========================================================================
    // Session Lifecycle Tests
    // ========================================================================

    #[test]
    fn test_spawn_session_unavailable() {
        let config = TmuxConfig::default(); // available = false
        let result = spawn_session(&config, "test-id", 80, 24, None, None);
        assert!(result.is_err());
        match result.unwrap_err() {
            TmuxError::NotAvailable => {}
            _ => panic!("Expected NotAvailable error"),
        }
    }

    #[test]
    fn test_resize_session_unavailable() {
        let config = TmuxConfig::default();
        let session = TmuxSession {
            id: "test".to_string(),
            session_name: "at_test".to_string(),
            cols: 80,
            rows: 24,
            shell: "/bin/bash".to_string(),
            wsl_distro: None,
            created_at: "2024-01-01T00:00:00Z".to_string(),
            server_pid: None,
        };
        let result = resize_session(&session, &config, 120, 40);
        assert!(result.is_err());
        match result.unwrap_err() {
            TmuxError::NotAvailable => {}
            _ => panic!("Expected NotAvailable error"),
        }
    }

    #[test]
    fn test_capture_content_unavailable() {
        let config = TmuxConfig::default();
        let session = TmuxSession {
            id: "test".to_string(),
            session_name: "at_test".to_string(),
            cols: 80,
            rows: 24,
            shell: "/bin/bash".to_string(),
            wsl_distro: None,
            created_at: "2024-01-01T00:00:00Z".to_string(),
            server_pid: None,
        };
        let result = capture_content(&session, &config, false);
        assert!(result.is_err());
        match result.unwrap_err() {
            TmuxError::NotAvailable => {}
            _ => panic!("Expected NotAvailable error"),
        }
    }

    #[test]
    fn test_send_input_unavailable() {
        let config = TmuxConfig::default();
        let session = TmuxSession {
            id: "test".to_string(),
            session_name: "at_test".to_string(),
            cols: 80,
            rows: 24,
            shell: "/bin/bash".to_string(),
            wsl_distro: None,
            created_at: "2024-01-01T00:00:00Z".to_string(),
            server_pid: None,
        };
        let result = send_input(&session, &config, b"hello");
        assert!(result.is_err());
        match result.unwrap_err() {
            TmuxError::NotAvailable => {}
            _ => panic!("Expected NotAvailable error"),
        }
    }

    #[test]
    fn test_send_input_empty_data() {
        // Create a config that appears available but won't actually run
        // Empty input should return Ok without attempting command
        let mut config = TmuxConfig::default();
        config.available = true;
        config.tmux_path = "/nonexistent/tmux".to_string();

        let session = TmuxSession {
            id: "test".to_string(),
            session_name: "at_test".to_string(),
            cols: 80,
            rows: 24,
            shell: "/bin/bash".to_string(),
            wsl_distro: None,
            created_at: "2024-01-01T00:00:00Z".to_string(),
            server_pid: None,
        };

        // Empty input should succeed without running any command
        let result = send_input(&session, &config, b"");
        assert!(result.is_ok());
    }

    #[test]
    fn test_kill_session_unavailable() {
        let config = TmuxConfig::default();
        let session = TmuxSession {
            id: "test".to_string(),
            session_name: "at_test".to_string(),
            cols: 80,
            rows: 24,
            shell: "/bin/bash".to_string(),
            wsl_distro: None,
            created_at: "2024-01-01T00:00:00Z".to_string(),
            server_pid: None,
        };
        let result = kill_session(&session, &config);
        assert!(result.is_err());
        match result.unwrap_err() {
            TmuxError::NotAvailable => {}
            _ => panic!("Expected NotAvailable error"),
        }
    }

    #[test]
    fn test_session_exists_unavailable() {
        let config = TmuxConfig::default();
        let exists = session_exists("at_test", &config);
        assert!(!exists);
    }

    #[test]
    fn test_list_sessions_unavailable() {
        let config = TmuxConfig::default();
        let result = list_sessions(&config);
        assert!(result.is_err());
        match result.unwrap_err() {
            TmuxError::NotAvailable => {}
            _ => panic!("Expected NotAvailable error"),
        }
    }

    #[test]
    fn test_build_tmux_command_native() {
        let config = TmuxConfig {
            available: true,
            tmux_path: "/usr/bin/tmux".to_string(),
            wsl_distro: None,
            default_shell: "/bin/bash".to_string(),
            options: HashMap::new(),
        };

        let cmd = build_tmux_command(&config, &["new-session", "-d", "-s", "test"]);
        // On native, program should be the tmux_path
        assert_eq!(cmd.get_program(), "/usr/bin/tmux");
    }

    #[test]
    fn test_build_tmux_command_wsl() {
        let config = TmuxConfig {
            available: true,
            tmux_path: "wsl.exe".to_string(),
            wsl_distro: Some("Ubuntu".to_string()),
            default_shell: "/bin/bash".to_string(),
            options: HashMap::new(),
        };

        let cmd = build_tmux_command(&config, &["new-session", "-d", "-s", "test"]);
        // On WSL, program should be wsl.exe
        assert_eq!(cmd.get_program(), "wsl.exe");
    }

    #[test]
    fn test_captured_content_struct() {
        let content = CapturedContent {
            content: "hello world\n".to_string(),
            line_count: 1,
            includes_scrollback: false,
            cursor_position: Some((0, 5)),
        };
        assert_eq!(content.line_count, 1);
        assert!(!content.includes_scrollback);
        assert_eq!(content.cursor_position, Some((0, 5)));
    }

    #[test]
    fn test_tmux_session_struct() {
        let session = TmuxSession {
            id: "terminal-1".to_string(),
            session_name: "at_terminal-1".to_string(),
            cols: 120,
            rows: 40,
            shell: "/bin/zsh".to_string(),
            wsl_distro: Some("Ubuntu".to_string()),
            created_at: "2024-01-01T12:00:00Z".to_string(),
            server_pid: Some(12345),
        };
        assert_eq!(session.id, "terminal-1");
        assert_eq!(session.session_name, "at_terminal-1");
        assert_eq!(session.cols, 120);
        assert_eq!(session.rows, 40);
        assert_eq!(session.wsl_distro, Some("Ubuntu".to_string()));
        assert_eq!(session.server_pid, Some(12345));
    }
}
