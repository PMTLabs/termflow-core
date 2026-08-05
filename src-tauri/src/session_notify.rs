//! Windows-only: turn OS session-change events (RDP / console switch) into a
//! `session:reconnect` event the renderer can react to.
//!
//! When a Remote Desktop session connects/disconnects or the console session is
//! locked/unlocked, Windows reattaches the desktop and ConPTY repaints every TUI
//! at once — a synchronized output burst. The renderer's `RunningActivityTracker`
//! otherwise misreads that burst as "every tab produced unseen output", so the
//! activity bell lights up on EVERY tab when you return to the machine.
//!
//! The tracker already drops this burst when it sees the DOM `visibilitychange`
//! event, but the Page Visibility API does NOT fire on an OS session
//! connect/disconnect (it only tracks visibility WITHIN a session), so RDP↔console
//! switches slipped through and the bell still rang. Here we hook the authoritative
//! signal — `WM_WTSSESSION_CHANGE` — and emit `session:reconnect` so the renderer
//! arms the same reconnect cooldown it uses for `visibilitychange`.
//!
//! The same window subclass also hooks `WM_POWERBROADCAST` and emits `system:resume`
//! when the machine wakes from standby. That is a rendering concern, not a bell one:
//! a suspend resets the GPU device and discards the WebGL glyph-atlas texture, which
//! xterm cannot detect and therefore never re-uploads — panes come back with the
//! correct background and no text. The renderer repairs it by forcing an atlas
//! re-upload (see `refreshGlyphAtlases` in terminal-core). A wake does NOT reliably
//! produce a session change (only a locked machine emits one), so this needs its own
//! signal.

#[cfg(windows)]
use std::sync::OnceLock;
#[cfg(windows)]
use tauri::{AppHandle, Emitter};

// Stored once so the (static) subclass proc can emit through it. The main window
// lives for the whole app, so a single registration is enough.
#[cfg(windows)]
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

// Arbitrary, stable subclass id for SetWindowSubclass on this window.
#[cfg(windows)]
const SUBCLASS_ID: usize = 0xA117_5E55; // mnemonic: "AuTo SESS"

// WM_WTSSESSION_CHANGE wParam codes (winuser.h). Stable Win32 values; not exposed
// as constants by the `windows` crate at this version, so defined locally. These
// are the "session became active again" transitions that precede the repaint burst.
#[cfg(windows)]
const WTS_CONSOLE_CONNECT: u32 = 0x1;
#[cfg(windows)]
const WTS_REMOTE_CONNECT: u32 = 0x3;
#[cfg(windows)]
const WTS_SESSION_UNLOCK: u32 = 0x8;

// WM_POWERBROADCAST wParam code (winuser.h), defined locally for the same reason as
// the WTS_* codes above. PBT_APMRESUMEAUTOMATIC is delivered on EVERY resume from
// sleep/hibernate, whether or not a user is present — which is exactly the coverage
// we want. Its sibling PBT_APMRESUMESUSPEND (0x7) is deliberately NOT handled: it is
// delivered only for user-triggered resumes, so it adds no coverage and would just
// emit a duplicate event (and a second atlas re-rasterization) on those wakes.
#[cfg(windows)]
const PBT_APMRESUMEAUTOMATIC: u32 = 0x12;

#[cfg(windows)]
unsafe extern "system" fn subclass_proc(
    hwnd: windows::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
    _uid_subclass: usize,
    _dwrefdata: usize,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::UI::Shell::DefSubclassProc;
    use windows::Win32::UI::WindowsAndMessaging::{WM_POWERBROADCAST, WM_WTSSESSION_CHANGE};

    if msg == WM_POWERBROADCAST {
        let code = wparam.0 as u32;
        log::info!("session_notify: WM_POWERBROADCAST code={code}");
        if code == PBT_APMRESUMEAUTOMATIC {
            if let Some(app) = APP_HANDLE.get() {
                if let Err(e) = app.emit("system:resume", code) {
                    log::warn!("session_notify: emit system:resume failed: {e}");
                }
            }
        }
    }

    if msg == WM_WTSSESSION_CHANGE {
        let code = wparam.0 as u32;
        // Diagnostic: log EVERY session-change code so we can confirm whether the
        // message even arrives on an RDP↔console switch (and with which code).
        log::info!("session_notify: WM_WTSSESSION_CHANGE code={code}");
        // Only the "session became active again" transitions precede the repaint
        // burst. Disconnect / lock events produce no output, so we ignore them.
        if code == WTS_CONSOLE_CONNECT || code == WTS_REMOTE_CONNECT || code == WTS_SESSION_UNLOCK {
            if let Some(app) = APP_HANDLE.get() {
                if let Err(e) = app.emit("session:reconnect", code) {
                    log::warn!("session_notify: emit session:reconnect failed: {e}");
                }
            }
        }
    }
    DefSubclassProc(hwnd, msg, wparam, lparam)
}

/// Register for session-change notifications on `window` and subclass it so
/// `WM_WTSSESSION_CHANGE` is translated into a `session:reconnect` Tauri event and
/// `WM_POWERBROADCAST` (resume from standby) into a `system:resume` one. Only the
/// session notifications need registering — `WM_POWERBROADCAST` is broadcast to
/// top-level windows already, so the subclass alone is enough to receive it.
/// Best-effort: every failure is logged and never fatal. No-op off Windows.
#[cfg(windows)]
pub fn install(window: &tauri::WebviewWindow, app: AppHandle) {
    use windows::Win32::System::RemoteDesktop::{
        WTSRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION,
    };
    use windows::Win32::UI::Shell::SetWindowSubclass;

    let hwnd = match window.hwnd() {
        Ok(h) => h,
        Err(e) => {
            log::warn!("session_notify: window.hwnd() unavailable: {e}");
            return;
        }
    };
    // First install wins (one main window for the app's lifetime).
    let _ = APP_HANDLE.set(app);

    unsafe {
        if !SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, 0).as_bool() {
            log::warn!("session_notify: SetWindowSubclass failed");
            return;
        }
        if let Err(e) = WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) {
            log::warn!("session_notify: WTSRegisterSessionNotification failed: {e}");
        }
    }
}

#[cfg(not(windows))]
pub fn install(_window: &tauri::WebviewWindow, _app: tauri::AppHandle) {}
