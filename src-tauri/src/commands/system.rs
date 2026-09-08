//! Shell profiles, legal documents, OS build number, executable icon extraction,
//! diagnostics/quit, notifications, background-mode toggle, connection health,
//! and API token generation. Split out of the former `commands.rs`.

use tauri::{Manager, State};
use crate::state::AppState;
use crate::pty_manager;
use jsonwebtoken::{encode, Header, EncodingKey};
use serde::{Deserialize, Serialize};
use chrono::{Utc, Duration};
use super::window::flush_then_exit;

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

/// Which profile this instance is. The renderer scopes its localStorage keys on
/// the returned `scope` — two instances share one WebView2 user-data folder, so
/// without it a named profile would overwrite the default profile's tabs.
#[tauri::command]
pub fn get_profile() -> crate::profile::ProfileInfo {
    crate::profile::current().info()
}

/// Stream 1: show an OS notification for background-tab activity, but ONLY when no
/// TermFlow window is focused (app-wide check — a focused window already gets the
/// in-app sound/toast, so notifying there too would be noisy/duplicate). `window_label`
/// + `tab_id` identify the exact destination when the notification is clicked.
/// Best-effort; failures are non-fatal.
///
/// Returns `false` when suppressed because a window was focused, and `true` when a
/// notification was *attempted*. `true` deliberately does NOT mean "the user saw a
/// toast": no platform here can promise that. The plugin fallback in particular spawns
/// an async task and discards the delivery result before returning
/// (tauri-plugin-notification desktop.rs), and macOS delivery happens on a background
/// thread. Do not build logic on `true` meaning "delivered".
///
/// Only a real click on the notification navigates (it emits `notification:activated`
/// with this `tab_id`); re-focusing a window never switches tabs.
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
    // One seam, three platform implementations (native_notify.rs). Each delivers the
    // notification AND wires up click activation; only the mechanism differs.
    match crate::native_notify::show_activity_notification(&app, &window_label, &tab_id, &body) {
        Ok(()) => log::info!("[NOTIFY] native notification accepted for tab {tab_id}"),
        Err(native_error) => {
            // Keep notifications best-effort even where the native path is unavailable
            // (WinRT disabled by policy, no D-Bus session, etc). The plugin toast has no
            // click callback, but is still preferable to silently dropping the activity
            // notification. Note the plugin returns Ok before it has actually tried to
            // deliver, so the map_err below only catches *scheduling* failures — this
            // logs "scheduled", never "shown".
            log::warn!("[NOTIFY] native notification failed: {native_error}; scheduling plugin fallback");
            use tauri_plugin_notification::NotificationExt;
            app.notification()
                .builder()
                .title("TermFlow")
                .body(body)
                .show()
                .map_err(|e| format!("native toast failed ({native_error}); plugin fallback failed: {e}"))?;
        }
    }
    Ok(true)
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
    flush_then_exit(&app_handle);
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
        // This window has already saved (the renderer awaits saveStateWithCwds
        // before invoking us), but any OTHER window still alive — a hidden one,
        // or one mid-teardown — has not, and exit() would skip its unload.
        flush_then_exit(&app_handle);
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

/// A missing artifact identity is unverified, not a conflicting identity. Only
/// a present, differing build ID can turn an otherwise owned MCP listener into
/// a conflict.
fn mcp_health_matches(
    reported_owner: Option<&str>,
    own_id: &str,
    observed_build: Option<&str>,
    expected_build: Option<&str>,
) -> (bool, bool) {
    let (owned, foreign) = crate::network_commands::classify_health_owner(reported_owner, own_id);
    if !owned {
        return (false, foreign);
    }
    if matches!((observed_build, expected_build), (Some(actual), Some(expected)) if !actual.is_empty() && actual != expected) {
        return (false, true);
    }
    (true, false)
}

#[tauri::command]
pub async fn check_connection_health(state: State<'_, AppState>) -> Result<Vec<ConnectionHealth>, String> {
    // Probe the ports we are ACTUALLY serving on, not the ones we were configured for.
    //
    // Under a second instance those differ (every release profile is configured for 42031;
    // only the first to start binds it), and probing the configured port asked the wrong
    // question in both directions: a healthy sibling on 42031 came back as a permanent
    // "conflict" badge for an instance whose own API on 42035 was fine, and once our own
    // server was stopped the same probe would have reported the sibling as OUR healthy one.
    //
    // `None` means we hold no port — stopped, or suppressed for an elevated profile — so
    // there is nothing of OURS to probe and "offline" is the answer without asking anyone.
    // The displayed URL still falls back to the configured port in that case: it is the
    // number in Settings and the one a restart would try first.
    let (effective_api, effective_mcp) = {
        let eff = state.effective_endpoints.read();
        (eff.api_port, eff.mcp_port)
    };
    let (api_port, mcp_port) = {
        let net = state.network.read();
        (
            effective_api.unwrap_or(net.api_port),
            effective_mcp.unwrap_or(net.mcp_port),
        )
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

    // Check API Server. `effective_api == None` short-circuits to offline rather than
    // probing the configured port — whatever answers there while we hold nothing is by
    // definition somebody else's server, and reporting it as ours would be a false green.
    let api_reported: Option<String> = match effective_api {
        None => None,
        Some(port) => match client.get(format!("http://localhost:{}/health", port)).send().await {
            Ok(r) if r.status().is_success() => {
                let j = r.json::<serde_json::Value>().await.unwrap_or_else(|_| serde_json::json!({}));
                Some(j.get("instanceId").and_then(|v| v.as_str()).unwrap_or("").to_string())
            }
            _ => None,
        },
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

    // Check MCP Server — ownership and a present build ID must both match. An
    // absent build ID remains an explicitly unverified legacy/Node outcome.
    let expected_mcp_build = crate::mcp_sidecar::resolved_tauri_sidecar("termflow-mcp-server")
        .ok()
        .map(|(_, build_id)| build_id);
    let (mcp_reported, mcp_build, mcp_clients): (Option<String>, Option<String>, Option<u32>) = match effective_mcp {
        None => (None, None, None),
        Some(port) => match client.get(format!("http://localhost:{}/health", port)).send().await {
            Ok(r) if r.status().is_success() => {
                let j = r.json::<serde_json::Value>().await.unwrap_or_else(|_| serde_json::json!({}));
                let id = j.get("instanceId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let build = j.get("buildId").and_then(|v| v.as_str()).map(str::to_string);
                let sessions = j.get("activeSessions").and_then(|v| v.as_u64()).map(|v| v as u32);
                (Some(id), build, sessions)
            }
            _ => (None, None, None),
        },
    };
    let (mcp_healthy, mcp_conflict) = mcp_health_matches(
        mcp_reported.as_deref(),
        &our_id,
        mcp_build.as_deref(),
        expected_mcp_build.as_deref(),
    );

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

#[cfg(test)]
mod health_tests {
    use super::mcp_health_matches;

    #[test]
    fn a_present_wrong_mcp_build_is_a_conflict_but_missing_identity_is_unverified() {
        assert_eq!(
            mcp_health_matches(Some("ours"), "ours", Some("wrong"), Some("expected")),
            (false, true)
        );
        assert_eq!(
            mcp_health_matches(Some("ours"), "ours", None, Some("expected")),
            (true, false)
        );
        assert_eq!(
            mcp_health_matches(Some("ours"), "ours", Some("wrong"), None),
            (true, false)
        );
    }
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

