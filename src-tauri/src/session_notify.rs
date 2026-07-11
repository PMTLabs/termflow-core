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
    use windows::Win32::UI::WindowsAndMessaging::WM_WTSSESSION_CHANGE;

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
/// `WM_WTSSESSION_CHANGE` is translated into a `session:reconnect` Tauri event.
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
