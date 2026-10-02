//! Window lifecycle: new/detached windows, session ids, quit/flush, detach
//! payload stash/take, close/devtools, Settings routing, active-window get/set.
//! Split out of the former `commands.rs`.

use tauri::State;
use crate::state::{AppState, CloseBounds};
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
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
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
pub(crate) fn reserve_window_id(app: &tauri::AppHandle, build: crate::state::WindowBuildGuard) -> Result<crate::state::WindowBuildGuard, String> {
    use tauri::Manager as _;
    let state = app.try_state::<AppState>().ok_or("window state not ready")?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    Ok(build.with_stable_id(state.windows.clone(), id))
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

/// Register the calling renderer without waiting for a native build. The payload
/// is `{status: "Retry"}` or `{status: "Registered", wi, pg}`. Registration alone
/// never settles or ends an older page; the ordered page stream does that.
#[tauri::command]
pub(crate) fn register_page(
    app_handle: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<crate::state::PageRegistration, String> {
    use tauri::Manager as _;
    let Some(state) = app_handle.try_state::<AppState>() else {
        return Ok(crate::state::PageRegistration::Retry);
    };
    state.host_table.keys().register_page(window.label())
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
/// Releases every pty-host's detach arm, then ANNOUNCES the exit to each, before
/// exiting. Admission to the hosts is closed first and stays closed.
/// A host that loses its GUI *holds* its sessions instead of tearing them down
/// when it is armed — and, since the 2026-09-21 crash, also when the pipe just
/// drops with live children (a crashed GUI is indistinguishable from a quitting
/// one on the wire; see the sidecar's `on_gui_disconnect`). Exiting without
/// saying so therefore leaves the user's shells — and any agent CLI running
/// under them — alive with no window and no tray to reach them. Users read
/// "Exit" as "exit everything", so a quit must never leave that behind:
/// `disarm` ends the hold, `shutdown` tells the host this disconnect is final.
///
/// Deliberately NOT used by `restart_for_update` or the updater: those arm on
/// purpose and exit so terminals survive the swap.
pub fn disarm_then_exit(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        close_all_hosts(&app, None).await;
        app.exit(0);
    });
}

/// Everything a quit does to the shells' hosts, short of exiting: release every
/// pty-host this instance owns — the current one and any older one that survived
/// an update, connected or not, not just the primary; see `AppState::exit_hosts`
/// — then the elevated sidecar. That one is never armed for detach and never
/// restored elevated, so unlike the others it always tears down rather than
/// being disarmed. A no-op if no admin tab was ever opened this run.
///
/// With `bounds`, the hosts get that long and no more, for a caller that has
/// something else waiting for it (an update that has started its updater).
pub(crate) async fn close_all_hosts(app: &tauri::AppHandle, bounds: Option<CloseBounds>) {
    use tauri::Manager as _;

    // Clone out of the `State` borrow before awaiting.
    let state = app.try_state::<AppState>().map(|s| s.inner().clone());
    if let Some(state) = &state {
        state.exit_hosts_within(bounds).await;
    }
    if let Some(elevated) = state.map(|s| s.elevated_host.clone()) {
        elevated.shutdown().await;
    }
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
///
/// Returns whether THIS call is what marked the application as exiting. A caller
/// that backs out afterwards (an update that is abandoned) may clear the mark only
/// then: otherwise it would clear a quit's.
pub(crate) async fn flush_all_windows(app: &tauri::AppHandle) -> bool {
    use tauri::{Emitter, Manager as _};

    let Some(state) = app.try_state::<AppState>() else { return false };

    // A second Quit while a flush is in flight means "I am done waiting" — the
    // caller's own exit still proceeds; there is just nothing further to await.
    if !mark_exiting(&state.exiting) {
        log::info!("flush_all_windows: already flushing; not waiting again.");
        return false;
    }

    let expected: Vec<String> = app
        .webview_windows()
        .keys()
        .filter(|l| l.as_str() != "drag-preview")
        .cloned()
        .collect();
    if expected.is_empty() {
        return true;
    }

    state.flush_acks.clear();
    if let Err(e) = app.emit("app:flush-session", ()) {
        // Nothing will ack, so do not make the caller wait out the timeout.
        log::warn!("flush_all_windows: could not ask windows to flush ({e}); continuing.");
        return true;
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
    true
}

/// Mark the application as exiting. True when this call set the mark, false when
/// it was already set.
fn mark_exiting(exiting: &std::sync::atomic::AtomicBool) -> bool {
    !exiting.swap(true, std::sync::atomic::Ordering::SeqCst)
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

    /// Whoever's swap set the mark is the only one that may take it back: an update
    /// that backs out after a quit marked the application must leave the quit's mark.
    #[test]
    fn only_the_call_that_set_the_exit_mark_owns_it() {
        let exiting = std::sync::atomic::AtomicBool::new(false);
        assert!(mark_exiting(&exiting), "the first call sets it");
        assert!(!mark_exiting(&exiting), "a second one finds it set and owns nothing");
        assert!(exiting.load(std::sync::atomic::Ordering::SeqCst));
    }

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

/// Open a new app window that will reconstruct the detached tab/pane. The token
/// is carried in the window label (`detach-<token>`) so the new window can take
/// and adopt the transfer through its page stream on boot.
#[tauri::command]
pub async fn create_detached_window(
    app_handle: tauri::AppHandle,
    window: tauri::WebviewWindow,
    token: String,
    x: Option<f64>,
    y: Option<f64>,
    pg: u64,
    state: State<'_, AppState>,
) -> Result<String, String> {
    state.host_table.keys().verify_transfer_source(window.label(), pg, &token)?;
    let taken = state.host_table.keys().watch_transfer(window.label(), pg, &token)?;
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
    let build = crate::window_lifetime::reserve(&app_handle, &label)?;
    let build = reserve_window_id(&app_handle, build)?;
    let reserved = build.stable_id().map(str::to_string);
    let window = builder.build().map_err(|e| e.to_string())?;
    crate::window_lifetime::commit(build, &window)?;
    crate::context_menu::install(&window);
    crate::webview_recovery::install(&window);
    if let Some(id) = reserved {
        record_new_window(&app_handle, &window, id, (900, 600));
    }
    refresh_menu(&app_handle);
    if !super::panes::transfer_taken(taken).await { return Err("destination never took transfer".into()); }
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
    let build = crate::window_lifetime::reserve(app, &label)?;
    let build = reserve_window_id(app, build)?;
    let reserved = build.stable_id().map(str::to_string);
    let window = builder.build().map_err(|e| e.to_string())?;
    crate::window_lifetime::commit(build, &window)?;
    crate::context_menu::install(&window);
    crate::webview_recovery::install(&window);
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

    /// Drop `//` line comments AND `/* ... */` block comments (non-nested,
    /// may span lines). Without this the guards read our own prose: this
    /// module and the code it guards both *describe* exiting and disarming, and a
    /// sentence must never stand in for — or trip — an assertion about code. A
    /// call wrapped in a block comment (disabling it) must also read as absent,
    /// not merely as a line-commented one would.
    fn strip_line_comments(code: &str) -> String {
        let mut without_block = String::with_capacity(code.len());
        let mut rest = code;
        while let Some(start) = rest.find("/*") {
            without_block.push_str(&rest[..start]);
            match rest[start + 2..].find("*/") {
                Some(end) => rest = &rest[start + 2 + end + 2..],
                None => {
                    // Unterminated block comment: drop the remainder.
                    rest = "";
                    break;
                }
            }
        }
        without_block.push_str(rest);

        without_block
            .lines()
            .map(|l| match l.find("//") {
                Some(i) => &l[..i],
                None => l,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The `(start, end)` byte range of the `{ ... }` block whose opening
    /// brace is the first one at-or-after byte offset `at` (`start` is the
    /// position of `{`; `end` is one past the matching `}`), found by
    /// counting brace depth (not a naive next-`}`) so a nested block inside
    /// does not truncate the match early. Returns plain indices — rather
    /// than a borrowed `&str` — so callers that need the block's absolute
    /// end offset are not tempted to reconstruct it via pointer arithmetic
    /// against an owned copy (which is a dangling-pointer bug: a `.to_string()`
    /// of the slice lives in a different allocation than the original).
    fn block_range_at(src: &str, at: usize) -> (usize, usize) {
        let open = src[at..]
            .find('{')
            .map(|i| at + i)
            .unwrap_or_else(|| panic!("no `{{` at-or-after byte {at}"));
        let mut depth = 0i32;
        for (i, c) in src[open..].char_indices() {
            match c {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return (open, open + i + 1);
                    }
                }
                _ => {}
            }
        }
        panic!("unbalanced braces starting at byte {open}");
    }

    /// The `{ ... }` block text itself; see `block_range_at`.
    fn block_at(src: &str, at: usize) -> &str {
        let (start, end) = block_range_at(src, at);
        &src[start..end]
    }

    /// Remove `if false { ... }` and `#[cfg(any())] { ... }` dead blocks
    /// (including their condition/attribute) so a call placed inside one
    /// cannot satisfy an ordering check that only ever looked at textual
    /// position, never reachability.
    fn strip_dead_blocks(src: &str) -> String {
        let mut out = src.to_string();
        loop {
            let at = match (out.find("if false"), out.find("#[cfg(any())]")) {
                (Some(a), Some(b)) => Some(a.min(b)),
                (Some(a), None) => Some(a),
                (None, Some(b)) => Some(b),
                (None, None) => None,
            };
            let Some(at) = at else { break };
            let (_, block_end) = block_range_at(&out, at);
            out.replace_range(at..block_end, "");
        }
        out
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

    /// Plan 045 AC9: an elevated sidecar is never armed for detach and never
    /// restored elevated, so a real quit must tear it down before exiting —
    /// unlike the primary above, which is only disarmed. Order matters: after
    /// `exit(0)` the process is already gone, so a shutdown placed after it
    /// would never run.
    #[test]
    fn disarm_then_exit_shuts_down_the_elevated_host_before_exiting() {
        let window = source("commands/window.rs");
        let quit = strip_line_comments(&fn_body(&window, "pub fn disarm_then_exit"));
        let closes_at = quit.find("close_all_hosts(").unwrap_or_else(|| {
            panic!("the quit must close the hosts through `close_all_hosts`. Body:\n{quit}")
        });
        let exit_at = quit.find(".exit(").expect("disarm_then_exit must still exit");
        assert!(closes_at < exit_at, "the hosts are closed BEFORE exit(0). Body:\n{quit}");

        let body = fn_body(&window, "pub(crate) async fn close_all_hosts");
        let stripped = strip_line_comments(&body);
        assert!(
            stripped.contains("elevated_host") && stripped.contains("elevated.shutdown("),
            "close_all_hosts must tear down state.elevated_host. Body:\n{body}"
        );
        // Named receiver: the primary host now has a `.shutdown(` of its own on
        // this path, so the bare method name would match that call instead and
        // pin nothing about the elevated host.
        assert!(
            !has_process_exit(&stripped),
            "close_all_hosts must not exit: the update closes the hosts and exits itself. Body:\n{body}"
        );
    }

    /// Since the 2026-09-21 crash a host HOLDS live sessions on a bare
    /// disconnect (a crash and a quit look the same on the wire) and only tears
    /// down on an explicit `Shutdown`. Disarming alone is no longer a quit: a
    /// `disarm_then_exit` that forgets to announce the exit leaves the user's
    /// shells and agent CLIs running, unreachable, for the host's whole
    /// retention window — the exact orphan "Exit" must never produce.
    ///
    /// The quit hands every owned host to `exit_hosts` before `exit(0)`; what is
    /// done to each host lives in `release_host`, which requires the acks to be
    /// CHECKED (`if !client.shutdown().await` with a logged failure), placed after
    /// the disarm — the host clears its latch when a GUI adopts, and a stale arm
    /// released after the announcement would be the wrong order to reason about —
    /// and before the stream is closed.
    #[test]
    fn disarm_then_exit_announces_the_exit_to_every_host() {
        let window = source("commands/window.rs");
        let close = strip_line_comments(&fn_body(&window, "pub(crate) async fn close_all_hosts"));
        // Awaited: a future that is dropped releases nothing, and the exit would go
        // ahead with every host still held.
        let hosts_at = close.find(".exit_hosts_within(bounds).await").unwrap_or_else(|| {
            panic!("the quit must release every owned host via `exit_hosts_within(..).await`. Body:\n{close}")
        });
        let elevated_at = close.find("elevated.shutdown(").expect("the elevated host is torn down too");
        assert!(hosts_at < elevated_at, "the owned hosts are released first. Body:\n{close}");
        let quit = strip_line_comments(&fn_body(&window, "pub fn disarm_then_exit"));
        assert!(
            quit.contains("close_all_hosts(&app, None).await"),
            "a quit closes the hosts without a bound, and waits for it. Body:\n{quit}"
        );

        let release = strip_line_comments(&fn_body(
            &source("state/host_lifecycle.rs"),
            "async fn release_host",
        ));
        let if_at = release.find("if !client.shutdown().await").unwrap_or_else(|| {
            panic!("the shutdown ack must be checked via `if !client.shutdown().await`. Body:\n{release}")
        });
        let arm = block_at(&release, if_at);
        assert!(
            arm.contains("log::error!"),
            "an unacknowledged shutdown on the quit path must be logged. Block:\n{arm}"
        );
        let disarm_at = release.find("client.disarm(").expect("the disarm is still required");
        let close_at = release.find("client.close_transport(").expect("the stream is closed");
        assert!(
            disarm_at < if_at && if_at < close_at,
            "expected disarm, then shutdown, then close. Body:\n{release}"
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

    /// Plan 045 AC9, the offload path's half: `restart_for_update` keeps the
    /// PRIMARY host armed (tested above) but must still tear down the elevated
    /// one — admin tabs are never restored elevated across the swap.
    #[test]
    fn the_offload_path_shuts_down_the_elevated_host_before_exiting() {
        let body = fn_body(&source("commands/update.rs"), "pub async fn restart_for_update");
        let stripped = strip_line_comments(&body);
        assert!(
            stripped.contains("elevated_host") && stripped.contains(".shutdown("),
            "restart_for_update must tear down state.elevated_host. Body:\n{body}"
        );
        let shutdown_at = stripped.find(".shutdown(").expect("checked above");
        let exit_at = stripped.find(".exit(").expect("restart_for_update must still exit");
        assert!(
            shutdown_at < exit_at,
            "elevated_host.shutdown() must be awaited BEFORE exit(0). Body:\n{body}"
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

    /// `restart_keeping_terminals` (plan 044 T1) reuses the same arm step
    /// `restart_for_update` does, then — unlike offload — actually relaunches.
    /// The order is load-bearing: arming before flushing means a refused arm
    /// never touches the renderer, flushing before spawning means a tab's cwd
    /// is persisted before anything about the successor happens, and spawning
    /// before exit means we never terminate without a successor spawned.
    /// Also assert `.exit(` is reachable only via the spawn match's success
    /// path — after the match resolves, since the Err arm returns early —
    /// and that no anchor lives inside dead code (`if false { }` /
    /// `#[cfg(any())] { }`) that would otherwise still satisfy a purely
    /// textual/offset ordering check.
    #[test]
    fn restart_keeping_terminals_arms_flushes_spawns_then_exits() {
        let body = fn_body(
            &source("commands/update.rs"),
            "pub async fn restart_keeping_terminals",
        );
        let stripped = strip_line_comments(&body);
        let live = strip_dead_blocks(&stripped);

        let pos = |needle: &str| {
            live.find(needle)
                .unwrap_or_else(|| panic!("`{needle}` not found in reachable body:\n{live}"))
        };
        let preflight_at = pos("local_terminals_refusal");
        let admission_at = pos(".begin_relaunch()");
        let arm_at = pos("arm_detach");
        let flush_at = pos("flush_all_windows");
        let spawn_at = pos("spawn_relaunch");
        let exit_at = pos(".exit(");
        assert!(
            preflight_at < admission_at
                && admission_at < arm_at
                && arm_at < flush_at
                && flush_at < spawn_at
                && spawn_at < exit_at,
            "restart_keeping_terminals must local_terminals_refusal -> begin_relaunch -> arm_detach -> \
             flush_all_windows -> spawn_relaunch -> exit, in that order, reachably. Body:\n{live}"
        );

        let match_at = pos("match crate::relaunch::spawn_relaunch()");
        let (_, match_end) = block_range_at(&live, match_at);
        assert!(
            exit_at >= match_end,
            "`.exit(` must sit after the spawn match resolves — reachable only once \
             spawn_relaunch succeeded, since the Err arm returns early — not merely \
             somewhere lexically after the text `spawn_relaunch`. Body:\n{live}"
        );
    }

    /// Plan 045 AC9, the hot-swap-restart path's half: same obligation as
    /// `restart_for_update`, reachable only on the success path (a failed
    /// spawn returns early with nothing to tear down — no admin tab survives
    /// a process that never exits).
    #[test]
    fn restart_keeping_terminals_shuts_down_the_elevated_host_before_exiting() {
        let body = fn_body(
            &source("commands/update.rs"),
            "pub async fn restart_keeping_terminals",
        );
        let stripped = strip_line_comments(&body);
        let live = strip_dead_blocks(&stripped);
        assert!(
            live.contains("elevated_host") && live.contains(".shutdown("),
            "restart_keeping_terminals must tear down state.elevated_host. Body:\n{live}"
        );
        let shutdown_at = live.find(".shutdown(").expect("checked above");
        let exit_at = live.find(".exit(").expect("restart_keeping_terminals must still exit");
        assert!(
            shutdown_at < exit_at,
            "elevated_host.shutdown() must be awaited BEFORE exit(0). Body:\n{live}"
        );
    }

    /// The spawn-failure path must release the hold (disarming every host it
    /// armed) and must be the ONLY place this function does — the success path
    /// exits deliberately armed, same as `restart_for_update`, so the pty-hosts
    /// keep holding.
    ///
    /// Checks BLOCK containment (the release call must live inside the `Err(`
    /// arm's own block), not textual order — a release sitting between
    /// `spawn_relaunch` and `.exit(` purely by offset could still actually be
    /// inside the `Ok(` arm.
    #[test]
    fn restart_keeping_terminals_disarms_only_on_spawn_failure() {
        let body = fn_body(
            &source("commands/update.rs"),
            "pub async fn restart_keeping_terminals",
        );
        let stripped = strip_line_comments(&body);

        // Count CALLS (`.release(`), not the word: the branch also comments on it.
        let release_positions: Vec<_> = stripped.match_indices(".release(").collect();
        assert_eq!(
            release_positions.len(),
            1,
            "expected exactly one `.release(` call — only on the spawn-failure path. Body:\n{body}"
        );
        assert!(
            !stripped.contains(".disarm("),
            "a disarm that bypasses the hold would leave admission closed. Body:\n{body}"
        );

        let match_at = stripped
            .find("match crate::relaunch::spawn_relaunch()")
            .expect("spawn_relaunch match not found");
        let match_block = block_at(&stripped, match_at);
        let err_at = match_block
            .find("Err(")
            .expect("spawn match must have an Err( arm");
        let err_arm = block_at(match_block, err_at);
        assert!(
            err_arm.contains(".release("),
            "`.release(` must be inside the Err( arm's own block of the spawn_relaunch \
             match — not merely textually between spawn_relaunch and exit. Err arm:\n{err_arm}"
        );
    }

    /// `PtyHostClient::disarm` returns whether the host ACKED. A spawn failure
    /// that then loses the disarm leaves the host holding a 15-minute window
    /// under a fully connected GUI; the least this path can do is say so, and
    /// name the host. The release goes through `disarm_hosts`.
    ///
    /// Requires the ack to actually be CHECKED — an `if !acknowledged` condition
    /// whose block logs the failure — not merely evaluated and discarded
    /// (`let _ = client.disarm().await;`).
    #[test]
    fn restart_keeping_terminals_checks_the_disarm_ack() {
        let body = strip_line_comments(&fn_body(
            &source("state/host_lifecycle.rs"),
            "async fn disarm_hosts",
        ));
        assert!(body.contains("client.disarm().await"), "the disarm is sent. Body:\n{body}");
        let if_at = body.find("if !acknowledged").unwrap_or_else(|| {
            panic!("the disarm ack must be checked via `if !acknowledged`. Body:\n{body}")
        });
        let arm = block_at(&body, if_at);
        assert!(
            arm.contains("log::error!") && arm.contains("{name}"),
            "a disarm that goes unacknowledged must be logged by host name. Block:\n{arm}"
        );
    }

    /// Auto-recovery and the tray item can both call this for one death. The
    /// latch must be taken BEFORE any side effect (the preflight is the first
    /// one), and kept only on the success path — a failure that left it set
    /// would wedge the tray item for the life of the process.
    ///
    /// `keep = true` must sit at-or-after the END of the spawn match's block
    /// (block containment, not offset order): the Err arm returns early, so
    /// anything after the match's closing brace is reachable only via a
    /// successful spawn. A caller that sets `keep = true` BEFORE even
    /// attempting the spawn (so a failure leaves it set) would satisfy a
    /// purely textual "after spawn_relaunch, before exit" check while still
    /// being wrong.
    #[test]
    fn restart_keeping_terminals_is_single_flight() {
        let body = strip_line_comments(&fn_body(
            &source("commands/update.rs"),
            "pub async fn restart_keeping_terminals",
        ));
        let pos = |needle: &str| {
            body.find(needle)
                .unwrap_or_else(|| panic!("`{needle}` not found in body:\n{body}"))
        };
        let latch_at = pos("restart_in_flight.swap(true");
        // The first thing it looks at, and the first thing it changes.
        let preflight_at = pos("local_terminals_refusal");
        assert!(
            latch_at < preflight_at && latch_at < pos(".begin_relaunch()"),
            "the in-flight latch must be taken before the preflight. Body:\n{body}"
        );
        assert!(
            pos("RESTART_IN_FLIGHT") < preflight_at,
            "a second caller must be refused with RESTART_IN_FLIGHT before any side effect"
        );

        let match_at = pos("match crate::relaunch::spawn_relaunch()");
        let match_block = block_at(&body, match_at);
        let (_, match_end) = block_range_at(&body, match_at);
        let err_at = match_block
            .find("Err(")
            .expect("spawn match must have an Err( arm");
        let err_arm = block_at(match_block, err_at);
        assert!(
            err_arm.contains("return Err("),
            "the Err( arm of the spawn match must return early, so nothing after the \
             match runs on a failed spawn. Err arm:\n{err_arm}"
        );

        let keep_at = pos("keep = true");
        assert!(
            keep_at >= match_end,
            "`keep = true` must sit at-or-after the end of the spawn match — reachable \
             only via its Ok arm, since the Err arm returns early — found at byte \
             {keep_at}, match ends at byte {match_end}. Body:\n{body}"
        );
        assert!(
            keep_at < pos(".exit("),
            "the latch must be kept before exit. Body:\n{body}"
        );
    }

    /// `FlushPolicy::Skip` exists so the automatic path does not wait 1.5 s on
    /// a dead renderer (plan 044 R3). The order test above cannot see the
    /// guard; this one pins that `flush_all_windows` sits inside its block,
    /// and appears nowhere else in the body — an `if flush == ... {}` guard
    /// with an unconditional `flush_all_windows` call right after it would
    /// otherwise satisfy a proximity-only check.
    #[test]
    fn restart_keeping_terminals_flushes_only_for_the_renderer_policy() {
        let body = strip_line_comments(&fn_body(
            &source("commands/update.rs"),
            "pub async fn restart_keeping_terminals",
        ));
        let guard_at = body
            .find("if flush == FlushPolicy::Renderer")
            .expect("the Renderer guard must exist");
        let guard_block = block_at(&body, guard_at);
        assert!(
            guard_block.contains("flush_all_windows"),
            "flush_all_windows must sit INSIDE the FlushPolicy::Renderer guard's block. \
             Guard block:\n{guard_block}"
        );
        let flush_count = body.matches("flush_all_windows").count();
        assert_eq!(
            flush_count, 1,
            "flush_all_windows must be called exactly once in the body (inside the \
             guard); found {flush_count}. Body:\n{body}"
        );
    }

    #[test]
    fn settings_open_payload_serializes_detail_field() {
        use super::SettingsOpenPayload;
        let with_detail = SettingsOpenPayload {
            target: "main".into(),
            category: Some("automations".into()),
            detail: Some("list".into()),
        };
        let json = serde_json::to_string(&with_detail).unwrap();
        assert!(json.contains("\"detail\":\"list\""));

        let with_log = SettingsOpenPayload {
            target: "main".into(),
            category: Some("automations".into()),
            detail: Some("log:rule-123".into()),
        };
        let json_log = serde_json::to_string(&with_log).unwrap();
        assert!(json_log.contains("\"detail\":\"log:rule-123\""));

        let without_detail = SettingsOpenPayload {
            target: "main".into(),
            category: Some("automations".into()),
            detail: None,
        };
        let json_none = serde_json::to_string(&without_detail).unwrap();
        assert!(!json_none.contains("detail"));
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

