//! Stop WebView2 rendering while a window is minimized (Windows only).
//!
//! **Why this is needed at all.** A plain Chromium window that gets minimized is marked
//! occluded by the browser, which throttles rAF and stops the compositor; measured on the
//! same streaming-terminal workload, that took a page from 23% of one core to 3% — an 88%
//! cut the platform performs for free. A WebView2 hosted by Tauri does not get it: the
//! host owns visibility, and nothing was clearing it, so a minimized TermFlow kept
//! painting. Measured on the nightly build with an idle Canvas tab, minimizing moved the
//! renderer only 26% -> 19%.
//!
//! `ICoreWebView2Controller::SetIsVisible(false)` is the documented way to say "this
//! webview is not on screen"; WebView2 then stops rendering it. It is the same signal
//! Chromium derives from occlusion internally, handed over explicitly.
//!
//! **This does not touch the shells.** Only painting stops. PTY output keeps arriving and
//! xterm keeps parsing it into its buffer, exactly as for a background tab — restoring the
//! window repaints from that buffer.
//!
//! **The failure mode to respect is a window that comes back BLANK**, which is what a
//! missed restore looks like. Two things guard against it: the visible=true path runs on
//! every event that can mean "not minimized" (focus gained, resize, move) rather than on a
//! single one, and the cached state is only ever written after the COM call actually
//! succeeded, so a failed hide cannot leave us believing the webview is hidden when it is
//! not — the next event simply tries again.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::OnceLock;

/// Last visibility WE successfully applied, per window label.
///
/// Purely a call filter: `WindowEvent::Moved`/`Resized` fire per frame while a window is
/// dragged, and `SetIsVisible` is a cross-process COM call. Absent means "never set",
/// which is treated as visible — the WebView2 default.
fn cache() -> &'static Mutex<HashMap<String, bool>> {
    static CACHE: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Drop the record for a window that is gone, so a label reused by a later window does not
/// inherit a stale "already hidden" and skip its first real call.
pub fn forget(label: &str) {
    if let Ok(mut c) = cache().lock() {
        c.remove(label);
    }
}

/// Apply the window's CURRENT minimized state to its webview.
///
/// Deliberately takes no `visible` argument: every call site would otherwise have to
/// re-derive "is this event a minimize?", and the one that got it wrong would be the one
/// that leaves a blank window. Asking the window itself is always right.
pub fn sync(window: &tauri::WebviewWindow) {
    // `is_minimized()` failing is not evidence of anything; treat it as on-screen, which is
    // the safe direction (a webview that renders when it needn't costs CPU; one that does
    // not render when it should is a blank app).
    let minimized = window.is_minimized().unwrap_or(false);
    set_visible(window, !minimized);
}

/// Bring a window back to the user AND make its webview visible again.
///
/// **The single entry point for a programmatic restore**, deliberately, because the failure
/// it prevents is silent and severe. `sync` is otherwise only reached from
/// `on_window_event`, so every restore depends on Windows emitting a `Focused` / `Resized`
/// that reaches our handler. That is true today — `WM_SIZE(SIZE_RESTORED)` and
/// `WM_SETFOCUS` both fire on a normal restore — but it is a property of the platform and
/// the framework, not of this code, and if it ever fails to hold the symptom is a window
/// that comes back **blank**: correct size, correct title, nothing painted.
///
/// Calling `sync` here makes the restore self-sufficient rather than event-dependent. It is
/// cheap: `sync` filters repeats, so when the event path also fires (the normal case) the
/// second call is a no-op that never reaches COM.
///
/// A test in this module asserts no other file calls `unminimize()` directly. That is the
/// point of routing it through here — a gate that lives in the CALLERS is one that every
/// future caller opts out of by simply not knowing about it.
pub fn restore_and_focus(window: &tauri::WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    sync(window);
}

#[cfg(windows)]
fn set_visible(window: &tauri::WebviewWindow, visible: bool) {
    let label = window.label().to_string();

    // Skip the COM round-trip when nothing changed. Checked before `with_webview` because
    // that call hops to the main thread.
    {
        let Ok(c) = cache().lock() else { return };
        if c.get(&label).copied().unwrap_or(true) == visible {
            return;
        }
    }

    let for_closure = label.clone();
    let result = window.with_webview(move |webview| unsafe {
        // Same access path as `context_menu::install` — the controller is what owns
        // visibility; `CoreWebView2` (the page) has no equivalent.
        if let Err(e) = webview.controller().SetIsVisible(visible) {
            log::warn!("webview_power: SetIsVisible({visible}) failed for {for_closure}: {e}");
            return;
        }
        if let Ok(mut c) = cache().lock() {
            c.insert(for_closure.clone(), visible);
        }
    });

    if let Err(e) = result {
        log::warn!("webview_power: with_webview unavailable for {label}: {e}");
    }
}

/// No-op off Windows. macOS and Linux webviews are occlusion-tracked by their own
/// compositors, so there is nothing equivalent to hand over.
#[cfg(not(windows))]
fn set_visible(_window: &tauri::WebviewWindow, _visible: bool) {}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cache must default to "visible" for an unknown label, or the very first
    /// minimize would be filtered out as a no-op and never reach WebView2.
    #[test]
    fn unknown_label_is_treated_as_visible() {
        let c = cache().lock().unwrap();
        assert_eq!(c.get("never-seen").copied().unwrap_or(true), true);
    }

    /// The class, not the instance.
    ///
    /// Two call sites needed the restore-time `sync` when this was written
    /// (`show_or_focus_main_window` and the Window menu's `focus:<label>` entry), and the
    /// obvious fix was to add a line to each. That is the shape of bug that comes back: the
    /// THIRD restore path, written months from now by someone who has never read this file,
    /// silently omits it and ships a window that restores blank.
    ///
    /// So the gate lives in `restore_and_focus` and this test makes bypassing it a build
    /// failure rather than a code-review question.
    #[test]
    fn no_other_file_restores_a_window_directly() {
        const SOURCES: [(&str, &str); 2] = [
            ("lib.rs", include_str!("lib.rs")),
            ("commands.rs", include_str!("commands.rs")),
        ];
        for (name, src) in SOURCES {
            assert!(
                !src.contains(".unminimize()"),
                "{name} calls .unminimize() directly. Use webview_power::restore_and_focus \
                 instead, or the webview stays invisible and the window restores BLANK."
            );
        }
    }

    /// Guards the guard: if `include_str!` ever pointed at the wrong file, or the sources
    /// were emptied, the assertion above would pass vacuously and prove nothing.
    #[test]
    fn the_scanned_sources_are_real() {
        const LIB: &str = include_str!("lib.rs");
        const COMMANDS: &str = include_str!("commands.rs");
        assert!(LIB.contains("on_window_event"), "lib.rs is not the file this test thinks it is");
        assert!(COMMANDS.contains("pub async fn"), "commands.rs is not the file this test thinks it is");
    }

    #[test]
    fn forget_clears_a_label() {
        cache().lock().unwrap().insert("w1".into(), false);
        assert_eq!(cache().lock().unwrap().get("w1").copied(), Some(false));
        forget("w1");
        assert_eq!(cache().lock().unwrap().get("w1").copied(), None);
        // And a reused label is back to the visible default, so its first hide still fires.
        assert_eq!(cache().lock().unwrap().get("w1").copied().unwrap_or(true), true);
    }
}
