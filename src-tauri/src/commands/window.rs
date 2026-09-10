//! Window lifecycle: new/detached windows, session ids, quit/flush, detach
//! payload stash/take, close/devtools, Settings routing, active-window get/set.
//! Split out of the former `commands.rs`.

use tauri::State;
use crate::state::AppState;
use super::menu::refresh_menu;

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

/// Payload for the `settings:open` broadcast — every window listens, but only the
/// one whose label matches `target` actually opens/activates the Settings tab.
#[derive(serde::Serialize, Clone)]
struct SettingsOpenPayload {
    target: String,
    category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

/// Open (or activate) the single Settings tab, always in the current main window —
/// regardless of which window this was invoked from. TermFlow supports multiple
/// windows, each with its own Redux store, so without routing through one
/// designated window, Settings opened from window B would only ever exist there.
/// Broadcasts `settings:open`; the targeted window's `installSettingsRouting`
/// listener does the actual tab creation/activation, and this also focuses that
/// window so the user actually sees it land.
#[tauri::command]
pub fn open_settings_in_main_window(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    category: Option<String>,
    detail: Option<String>,
) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    let target = state.resolve_main_window_label();
    app_handle
        .emit("settings:open", SettingsOpenPayload { target: target.clone(), category, detail })
        .map_err(|e| e.to_string())?;
    if let Some(w) = app_handle.get_webview_window(&target) {
        // Unlike the drag-reattach path, the user didn't just interact with the
        // target window — it may be minimized or on another desktop — so this is
        // a full restore, not just a focus.
        crate::webview_power::restore_and_focus(&w);
    }
    Ok(())
}

/// Reserve a stable session id for a window that is ABOUT to be built
/// (plan 018 Task 2).
///
/// Must run BEFORE `builder.build()`. The webview begins loading the moment it
/// is built, and its very first act is to resolve this id — a binding published
/// afterwards is a race whose losing side falls back to slot 0, silently merging
/// the new window into the main window's session. That is precisely the defect
/// this feature exists to remove, so the ordering is load-bearing, not a
/// micro-optimisation.
pub fn reserve_window_id(app: &tauri::AppHandle, label: &str) -> Option<String> {
    use tauri::Manager as _;
    let state = app.try_state::<AppState>()?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    state.windows.bind(label, &id);
    Some(id)
}

/// Record a just-built window's real geometry under its reserved id.
///
/// Best-effort on geometry: a window that cannot report its position is still
/// recorded, using the builder's defaults. An unrecorded window is one that
/// silently never restores — strictly worse than one restored at the wrong
/// coordinates.
pub fn record_new_window(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    id: String,
    fallback_size: (u32, u32),
) {
    use tauri::Manager as _;
    let Some(state) = app.try_state::<AppState>() else { return };
    let pos = window.outer_position().ok();
    let size = window.inner_size().ok();
    state.windows.register(crate::window_registry::WindowRecord {
        id,
        label: window.label().to_string(),
        x: pos.map(|p| p.x).unwrap_or(0),
        y: pos.map(|p| p.y).unwrap_or(0),
        width: size.map(|s| s.width).unwrap_or(fallback_size.0),
        height: size.map(|s| s.height).unwrap_or(fallback_size.1),
        maximized: window.is_maximized().unwrap_or(false),
        focused: false,
    });
    // A newly opened window takes focus; set it through the tracker so exactly
    // one record carries the flag.
    state.windows.note_focus(window.label());
}

/// The stable session id for the calling window (plan 018 Task 3).
///
/// The renderer resolves this BEFORE the bridge or `App` loads and derives its
/// `localStorage` keys from it, so every window persists its own tabs instead
/// of clobbering one shared key.
///
/// Returns `Err` for an unknown label rather than defaulting to slot 0. A silent
/// fallback would put two windows back on one key — the exact defect this
/// exists to fix — and would do it invisibly.
#[tauri::command]
pub fn get_window_session_id(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<String, String> {
    state
        .windows
        .id_for_label(window.label())
        .ok_or_else(|| format!("no window session id registered for label '{}'", window.label()))
}

/// Every window id the registry currently holds. The renderer sweeps orphaned
/// session blobs against this list (plan 018 Task 9).
#[tauri::command]
pub fn list_window_session_ids(state: State<'_, AppState>) -> Vec<String> {
    state.windows.snapshot().windows.into_iter().map(|w| w.id).collect()
}

// ----- Quit: give every window a chance to persist first ---------------------
//
// `AppHandle::exit` tears the process down without firing `CloseRequested` for
// any window, so no renderer gets its `beforeunload`. That was survivable while
// one shared key held the whole session — some window had almost certainly
// written it recently. With per-window sessions (plan 018) each window owns data
// only IT can write, so an unflushed window loses its tabs outright.

/// How long a quit will wait for windows to persist. A quit that hangs is worse
/// than a stale tab, so this is a hard ceiling, not a target.
const FLUSH_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(1500);

/// Ask every window to persist its session, then exit — or exit anyway once
/// `FLUSH_TIMEOUT` elapses.
/// The ONLY route from a user-initiated quit to `exit(0)`.
///
/// Releases the pty-host's detach arm before exiting. An armed host that loses
/// its GUI *holds* its sessions instead of tearing them down (see the sidecar's
/// `on_gui_disconnect`), so exiting while armed leaves the user's shells — and
/// any agent CLI running under them — alive with no window and no tray to reach
/// them. Users read "Exit" as "exit everything", so a quit must never leave that
/// behind.
///
/// Deliberately NOT used by `restart_for_update` or the updater: those arm on
/// purpose and exit so terminals survive the swap.
pub fn disarm_then_exit(app: &tauri::AppHandle) {
    use tauri::Manager as _;

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Resolve the client and drop the `State` borrow before awaiting.
        let client = app.try_state::<AppState>().and_then(|s| s.pty_host_clone());
        if let Some(client) = client {
            if !client.disarm().await {
                log::error!(
                    "quit: pty-host never acknowledged the disarm; it may keep \
                     holding sessions after we exit"
                );
            }
        }
        app.exit(0);
    });
}

/// Ask every window to persist its state — including the spec 045 §3.3 cwd
/// snapshot `saveStateWithCwds` refreshes just before saving — and wait up to
/// `FLUSH_TIMEOUT` for all of them to ack (`app:flush-session` / `flushSessionAck`,
/// see `App.tsx`). Does NOT disarm or exit the process; the caller decides what
/// happens next.
///
/// Split out of `flush_then_exit` so `restart_for_update` and
/// `update_and_restart` can run the SAME flush a normal quit runs before THEIR
/// exit too. Those two arm the pty-host and exit deliberately armed — they must
/// never route through `disarm_then_exit` — but they used to skip the flush
/// outright, so a tab offloaded/updated between autosave ticks came back on
/// relaunch with no persisted cwd and fell through to whatever directory
/// `CreateProcess` picked with none given (reported: `C:\Windows`).
pub(crate) async fn flush_all_windows(app: &tauri::AppHandle) {
    use tauri::{Emitter, Manager as _};

    let Some(state) = app.try_state::<AppState>() else { return };

    // A second Quit while a flush is in flight means "I am done waiting" — the
    // caller's own exit still proceeds; there is just nothing further to await.
    if state.exiting.swap(true, std::sync::atomic::Ordering::SeqCst) {
        log::info!("flush_all_windows: already flushing; not waiting again.");
        return;
    }

    let expected: Vec<String> = app
        .webview_windows()
        .keys()
        .filter(|l| l.as_str() != "drag-preview")
        .cloned()
        .collect();
    if expected.is_empty() {
        return;
    }

    state.flush_acks.clear();
    if let Err(e) = app.emit("app:flush-session", ()) {
        // Nothing will ack, so do not make the caller wait out the timeout.
        log::warn!("flush_all_windows: could not ask windows to flush ({e}); continuing.");
        return;
    }

    let acks = state.flush_acks.clone();
    let want = expected.len();
    let all_acked = wait_for_acks(&acks, want, FLUSH_TIMEOUT).await;
    if all_acked {
        log::info!("flush_all_windows: all {want} window(s) persisted.");
    } else {
        log::warn!(
            "flush_all_windows: {}/{} window(s) persisted before the {}ms deadline; continuing anyway.",
            acks.len(),
            want,
            FLUSH_TIMEOUT.as_millis()
        );
    }
}

pub fn flush_then_exit(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        flush_all_windows(&app).await;
        disarm_then_exit(&app);
    });
}

/// Wait until `want` windows have acked, or `timeout` elapses. Returns whether
/// every window acked.
///
/// Split out from `flush_then_exit` so the TIMEOUT path is testable: it is the
/// branch that matters (a renderer that never answers must not wedge the quit)
/// and the one a happy-path test would never reach.
async fn wait_for_acks(
    acks: &dashmap::DashMap<String, ()>,
    want: usize,
    timeout: std::time::Duration,
) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if acks.len() >= want {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}

#[cfg(test)]
mod flush_tests {
    use super::*;
    use dashmap::DashMap;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    #[tokio::test]
    async fn a_window_that_never_acks_does_not_wedge_the_quit() {
        let acks: Arc<DashMap<String, ()>> = Arc::new(DashMap::new());
        acks.insert("main".into(), ());
        let started = Instant::now();
        // Two windows expected, one silent.
        let all = wait_for_acks(&acks, 2, Duration::from_millis(120)).await;
        assert!(!all, "must report the flush as incomplete");
        assert!(
            started.elapsed() >= Duration::from_millis(100),
            "must actually have waited for the deadline"
        );
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "and must not wait past it — a quit that hangs is worse than a stale tab"
        );
    }

    #[tokio::test]
    async fn all_acks_release_the_wait_early() {
        let acks: Arc<DashMap<String, ()>> = Arc::new(DashMap::new());
        let bg = acks.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(30)).await;
            bg.insert("main".into(), ());
            bg.insert("window-a".into(), ());
        });
        let started = Instant::now();
        assert!(wait_for_acks(&acks, 2, Duration::from_secs(30)).await);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "the wait must end on the acks, not on the timeout"
        );
    }

    #[tokio::test]
    async fn expecting_nobody_returns_immediately() {
        let acks: Arc<DashMap<String, ()>> = Arc::new(DashMap::new());
        assert!(wait_for_acks(&acks, 0, Duration::from_secs(30)).await);
    }
}

/// A window reporting that it has persisted its session (plan 018 Task 8).
#[tauri::command]
pub fn flush_session_ack(state: State<'_, AppState>, window: tauri::WebviewWindow) {
    state.flush_acks.insert(window.label().to_string(), ());
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
    .title(crate::profile::decorate_title("TermFlow"))
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

    // Must match every other webview's arguments exactly -- see gpu_preference.
    #[cfg(windows)]
    {
        builder = builder.additional_browser_args(crate::gpu_preference::browser_args());
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

    // Reserve BEFORE build (see reserve_window_id): a detached window saves its
    // own session from the moment it mounts, so it must know its id by then.
    let reserved = reserve_window_id(&app_handle, &label);
    let window = builder.build().map_err(|e| e.to_string())?;
    crate::context_menu::install(&window);
    if let Some(id) = reserved {
        record_new_window(&app_handle, &window, id, (900, 600));
    }
    refresh_menu(&app_handle);
    Ok(label)
}

/// Open a fresh, empty app window (File > New Window). Unlike a detached window,
/// it carries no payload: it boots with `?newWindow=1` and opens a single
/// default terminal tab.
///
/// `?newWindow=1` no longer means "skip session restore" (plan 018 Task 5). The
/// window gets its own session id, finds nothing saved under it, and the normal
/// post-restore decision opens the default tab. It still saves under that id, so
/// this window is restored like any other on the next start.
pub fn open_new_window(app: &tauri::AppHandle, path: Option<String>) -> Result<String, String> {
    let label = format!("window-{}", uuid::Uuid::new_v4().simple());
    let mut url = "index.html?newWindow=1".to_string();
    if let Some(path) = path {
        url.push_str("&path=");
        url.push_str(&percent_encode_url_component(&path));
    }
    // `mut` is only used by the macOS-only (Overlay title bar) and Windows-only
    // (GPU browser args) blocks below.
    #[cfg_attr(not(any(target_os = "macos", windows)), allow(unused_mut))]
    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        &label,
        tauri::WebviewUrl::App(url.into()),
    )
    .title(crate::profile::decorate_title("TermFlow"))
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

    // Must match every other webview's arguments exactly -- see gpu_preference.
    #[cfg(windows)]
    {
        builder = builder.additional_browser_args(crate::gpu_preference::browser_args());
    }

    // Reserve BEFORE build: the webview resolves its id as its first action.
    let reserved = reserve_window_id(app, &label);
    let window = builder.build().map_err(|e| e.to_string())?;
    crate::context_menu::install(&window);
    if let Some(id) = reserved {
        record_new_window(app, &window, id, (1280, 800));
    }
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

/// Open the WebView developer tools for the calling window.
///
/// The WebView2 right-click menu is cancelled outright (see `context_menu`), so
/// "Inspect" is gone; Settings → Updates is the only way in. The `devtools`
/// tauri feature is enabled unconditionally in Cargo.toml, so this works in
/// release builds too.
#[tauri::command]
pub fn open_devtools(window: tauri::WebviewWindow) {
    log::info!("open_devtools: opening for '{}'", window.label());
    window.open_devtools();
}

/// The quit path must leave nothing running. Asserted from source because the
/// real thing needs a live `AppHandle` plus a pty-host over a real pipe, which a
/// unit-test process cannot stand up (the `integration-tests` feature `mock_app`
/// needs breaks the Windows test binary).
///
/// These are CLASS guards, not instance guards: they pin that *no* exit in the
/// user-quit paths skips the disarm, so a future branch added to `flush_then_exit`
/// — or a new quit path in `lib.rs` — cannot quietly opt out and strand shells.
#[cfg(test)]
mod quit_teardown_wiring_tests {
    /// The body of `fn <name>` (or of a closure passed to `<name>`), found by
    /// counting braces from the first `{` after the signature.
    fn fn_body(src: &str, signature: &str) -> String {
        let start = src.find(signature).unwrap_or_else(|| {
            panic!("`{signature}` not found — this guard must fail loudly, not pass vacuously")
        });
        let rest = &src[start..];
        let open = rest.find('{').expect("no body");
        let mut depth = 0usize;
        for (i, c) in rest[open..].char_indices() {
            match c {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return rest[open..open + i + 1].to_string();
                    }
                }
                _ => {}
            }
        }
        panic!("unbalanced braces after `{signature}`");
    }

    /// Drop `//` line comments. Without this the guards read our own prose: this
    /// module and the code it guards both *describe* exiting and disarming, and a
    /// sentence must never stand in for — or trip — an assertion about code.
    fn strip_line_comments(code: &str) -> String {
        code.lines()
            .map(|l| match l.find("//") {
                Some(i) => &l[..i],
                None => l,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Whether `code` terminates the process by ANY spelling used in this repo.
    ///
    /// Matching `.exit(0)` alone was not enough: `std::process::exit(0)` has no
    /// `.` at all and is an established pattern here (`instance_lock.rs`,
    /// `lib.rs`), so a future quit fix written that way would sail past a guard
    /// that only knew the method-call form. `disarm_then_exit` — the sanctioned
    /// route — is removed first so it is never mistaken for a bare exit.
    fn has_process_exit(code: &str) -> bool {
        strip_line_comments(code)
            .replace("disarm_then_exit", "")
            .contains("exit(")
    }

    /// The guard's own detector, pinned. A class guard that misses a spelling is
    /// worse than no guard: it reports safety it never checked.
    #[test]
    fn the_detector_catches_every_spelling_of_a_process_exit() {
        assert!(has_process_exit("app.exit(0);"), "method call on app");
        assert!(
            has_process_exit("std::process::exit(0);"),
            "std::process::exit has no `.` — the spelling that defeated the first guard"
        );
        assert!(has_process_exit("app_handle.exit(0);"), "another receiver");
        assert!(
            has_process_exit("window.app_handle().exit(0);"),
            "chained receiver"
        );
        assert!(has_process_exit("std::process::exit(1);"), "nonzero status");

        assert!(
            !has_process_exit("disarm_then_exit(app);"),
            "the sanctioned route must not read as a bare exit"
        );
        assert!(
            !has_process_exit("// a bare exit(0) here would strand terminals"),
            "prose about exiting must not trip the guard"
        );
    }

    /// `file` is a path under `src/`, e.g. `"lib.rs"` or `"commands/window.rs"`
    /// (post-split: each function this module scans now lives in a specific
    /// `commands/*.rs`, not the former single `commands.rs`).
    fn source(file: &str) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join(file);
        std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("cannot read {} ({e})", path.display()))
            .replace("\r\n", "\n")
    }

    /// `flush_then_exit` has several early-exit branches (no state, nothing to
    /// flush, emit failed, a second impatient Quit). Every one of them must go
    /// through `disarm_then_exit`: an armed host that loses its GUI Holds, and a
    /// held host keeps the user's shells — and whatever agent CLIs run under
    /// them — alive with no window and no tray to reach them.
    #[test]
    fn every_flush_then_exit_branch_disarms_before_exiting() {
        let body = fn_body(&source("commands/window.rs"), "pub fn flush_then_exit");
        assert!(
            body.contains("disarm_then_exit"),
            "flush_then_exit must route its exits through disarm_then_exit. Body:\n{body}"
        );
        assert!(
            !has_process_exit(&body),
            "a branch of flush_then_exit still terminates the process directly, \
             skipping the disarm — that branch strands the user's terminals. Body:\n{body}"
        );
    }

    /// The quit path that does NOT go through `flush_then_exit`: destroying the
    /// last real window (tab tear-off, close_self_window) exits straight from the
    /// window-event handler. It is a user-initiated quit and needs the same
    /// guarantee — missing it was the whole reason to guard the class, not the
    /// single function.
    ///
    /// Scoped to the window-event closure, not the whole file: `lib.rs` also has
    /// a legitimate pre-builder `std::process::exit(2)` that runs before any
    /// `AppState` or pty-host exists, and a file-wide check would fail on it.
    #[test]
    fn the_last_window_destroyed_path_disarms_before_exiting() {
        let body = fn_body(&source("lib.rs"), ".on_window_event(");
        assert!(
            body.contains("disarm_then_exit"),
            "the last-window-destroyed exit must disarm the host first. Body:\n{body}"
        );
        assert!(
            !has_process_exit(&body),
            "the window-event handler still terminates the process directly, \
             skipping the disarm. Body:\n{body}"
        );
    }

    /// The other half of the contract. `restart_for_update` arms ON PURPOSE and
    /// exits so the shells survive the swap; disarming there would defeat the
    /// feature. Pins that the new choke point was not applied indiscriminately.
    #[test]
    fn the_offload_path_still_exits_while_armed() {
        let body = fn_body(&source("commands/update.rs"), "pub async fn restart_for_update");
        assert!(
            body.contains("arm_detach"),
            "restart_for_update must still arm. Body:\n{body}"
        );
        assert!(
            !strip_line_comments(&body).contains("disarm"),
            "restart_for_update must NOT disarm — it exits deliberately armed so \
             terminals survive the update. Body:\n{body}"
        );
    }

    /// The reported bug: `restart_for_update` used to arm and exit immediately,
    /// with no chance for the renderer to persist a just-`cd`'d tab's cwd (spec
    /// 045 §3.3). Pins that it now runs the same flush a normal quit runs — via
    /// the shared, non-disarming `flush_all_windows` — BEFORE the exit, not after
    /// (an ack that arrives after the process has already exited persists nothing).
    #[test]
    fn the_offload_path_flushes_cwd_state_before_exiting() {
        let body = fn_body(&source("commands/update.rs"), "pub async fn restart_for_update");
        assert!(
            body.contains("flush_all_windows"),
            "restart_for_update must flush every window's state (cwd snapshot \
             included) before exiting, or a relaunch loses the cwd of any tab \
             the last periodic autosave missed. Body:\n{body}"
        );
        let flush_at = body.find("flush_all_windows").expect("checked above");
        let exit_at = body.find(".exit(").expect("restart_for_update must still exit");
        assert!(
            flush_at < exit_at,
            "flush_all_windows must be awaited BEFORE exit(0) — after would persist \
             nothing, the process is already gone. Body:\n{body}"
        );
    }

    /// `flush_all_windows` is the shared piece both the normal quit path and the
    /// offload/update paths build on. It must never itself decide to disarm or
    /// exit — the three callers disagree on that (quit disarms, offload/update
    /// must not) — so the decision has to stay with the caller.
    #[test]
    fn flush_all_windows_never_disarms_or_exits_itself() {
        let body = fn_body(&source("commands/window.rs"), "async fn flush_all_windows");
        let stripped = strip_line_comments(&body);
        assert!(
            !stripped.contains("disarm"),
            "flush_all_windows must not disarm — that decision belongs to the \
             caller (disarm_then_exit for a real quit; nothing for offload/update). \
             Body:\n{body}"
        );
        assert!(
            !has_process_exit(&body),
            "flush_all_windows must not exit the process itself — callers that \
             need to stay armed (restart_for_update, update_and_restart) would \
             inherit an exit they never asked for. Body:\n{body}"
        );
    }
}

// ---------------------------------------------------------------------------
// Snippets import / export (plan/029 §8.3)
// ---------------------------------------------------------------------------
//
// TWO NARROW COMMANDS, NOT ONE GENERAL ONE — and deliberately Tauri-IPC only
// (decision D10).
//
// DO NOT add these to `api_server.rs`, and DO NOT give them an HTTP route.
// Tauri commands are not auto-exposed over HTTP: the embedded Axum API reuses a
// small, explicit set of functions (`commands::spawn_routed` and friends), so as
// long as these two stay off that list they are unreachable from the local REST
// surface and from the MCP sidecar. That property is the whole point. A general
// `write_text_file` / `read_text_file` pair would become an arbitrary-write and
// arbitrary-read primitive the moment somebody "helpfully" wired it into a route;
// a command that only ever moves snippet JSON to and from a `.json` path the user
// picked in a native dialog is not. `snippet_porting_tests` below pins that they
// are absent from `api_server.rs`, so this comment cannot rot silently.

