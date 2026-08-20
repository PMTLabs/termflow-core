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
