//! Windows: give ConPTY's hidden pseudo-console window an owner.
//!
//! A console program that needs a GUI dialog parents it to `GetConsoleWindow()`.
//! Under ConPTY that handle is a 0x0 `PseudoConsoleWindow`, and the inbox
//! `CreatePseudoConsole` (what portable-pty uses) leaves it **hidden and
//! ownerless**. A dialog owned by such a window is created, but lands at (0,0)
//! at the back of the z-order — behind TermFlow, where the user never sees it.
//!
//! `az login` is the case that surfaced this: MSAL passes `GetConsoleWindow()`
//! to the WAM broker as the sign-in dialog's parent, so the prompt is invisible
//! and the CLI blocks forever on it. Ctrl+C can't rescue it either — the
//! process is parked in a native broker call, so CPython never gets to run its
//! SIGINT handler.
//!
//! Windows Terminal avoids this by calling `ConptyReparentPseudoConsole` +
//! `ConptyShowHidePseudoConsole`, exports of the `conpty.dll` it ships rather
//! than of the inbox API. Probing a live Windows Terminal session confirms the
//! end state those produce: its pseudo-console window is visible and owned by
//! the terminal's own `CASCADIA_HOSTING_WINDOW_CLASS` window. We reach the same
//! end state directly on the window itself, which needs no bundled DLL.
//!
//! Two ConPTY facts this relies on, both verified against a standalone
//! portable-pty harness:
//!   * the window exists as soon as the child attaches to the console — it is
//!     NOT created lazily on the first `GetConsoleWindow()` call (a child that
//!     never calls it still has one), so adopting once after spawn is enough;
//!   * there is exactly ONE window per pseudo console, owned by the first
//!     attached client. Adopting the shell's window therefore also covers every
//!     descendant that later attaches to the same console.

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::Input::KeyboardAndMouse::{EnableWindow, IsWindowEnabled};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetAncestor, GetClassNameW, GetWindowThreadProcessId, IsWindowVisible,
        SetWindowLongPtrW, ShowWindow, GA_ROOTOWNER, GWLP_HWNDPARENT, SW_SHOWNA,
    };

    /// EnumWindows callback returns: keep going / stop.
    const CONTINUE: BOOL = BOOL(1);
    const STOP: BOOL = BOOL(0);

    /// Window class ConPTY gives the per-console stand-in for a console window.
    const PSEUDO_CONSOLE_CLASS: &str = "PseudoConsoleWindow";

    /// The window appears when the child attaches to the console, which is
    /// essentially immediate but not synchronous with `spawn` returning. Poll
    /// briefly rather than racing it; a shell that dies instantly just costs us
    /// this many idle wake-ups on a detached thread.
    const ADOPT_ATTEMPTS: u32 = 40;
    const ADOPT_INTERVAL_MS: u64 = 100;

    unsafe fn class_name(hwnd: HWND) -> String {
        let mut buf = [0u16; 64];
        let n = GetClassNameW(hwnd, &mut buf);
        if n <= 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..n as usize])
    }

    unsafe fn window_pid(hwnd: HWND) -> u32 {
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        pid
    }

    struct Search {
        pid: u32,
        found: HWND,
    }

    unsafe extern "system" fn find_pseudo_console(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let search = &mut *(lparam.0 as *mut Search);
        if window_pid(hwnd) != search.pid || class_name(hwnd) != PSEUDO_CONSOLE_CLASS {
            return CONTINUE;
        }
        search.found = hwnd;
        STOP
    }

    /// The pseudo-console window belonging to `pid`, or null.
    unsafe fn pseudo_console_window(pid: u32) -> HWND {
        let mut search = Search {
            pid,
            found: HWND(std::ptr::null_mut()),
        };
        let _ = EnumWindows(
            Some(find_pseudo_console),
            LPARAM(&mut search as *mut Search as isize),
        );
        search.found
    }

    /// Owner window of `hwnd` (0 when it has none).
    unsafe fn owner_of(hwnd: HWND) -> HWND {
        GetAncestor(hwnd, GA_ROOTOWNER)
    }

    pub fn adopt(shell_pid: u32, owner: isize) {
        if shell_pid == 0 || owner == 0 {
            return;
        }
        // Detached: `spawn` must not block the caller for the poll window.
        std::thread::spawn(move || {
            let owner = HWND(owner as *mut c_void);
            for _ in 0..ADOPT_ATTEMPTS {
                unsafe {
                    let hwnd = pseudo_console_window(shell_pid);
                    if !hwnd.0.is_null() {
                        if owner_of(hwnd) == owner {
                            return; // already ours (re-bind of an unmoved pane)
                        }
                        SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, owner.0 as isize);
                        // SW_SHOWNA: the window is 0x0 and must never take focus;
                        // showing it only makes it a valid dialog owner. Windows
                        // Terminal's equivalent window is likewise visible.
                        let _ = ShowWindow(hwnd, SW_SHOWNA);
                        log::debug!(
                            "console_window: adopted pseudo-console window of pid {shell_pid}"
                        );
                        return;
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(ADOPT_INTERVAL_MS));
            }
            log::debug!("console_window: no pseudo-console window for pid {shell_pid}");
        });
    }

    /// True when some live dialog still legitimately owns `hwnd` as a modal.
    ///
    /// The pseudo-console windows we adopt are themselves visible children of
    /// the owner chain, so they must not count — otherwise every terminal would
    /// look like an open modal forever.
    unsafe fn has_live_modal(hwnd: HWND) -> bool {
        struct Probe {
            owner: HWND,
            found: bool,
        }
        unsafe extern "system" fn probe(candidate: HWND, lparam: LPARAM) -> BOOL {
            let p = &mut *(lparam.0 as *mut Probe);
            if candidate == p.owner
                || !IsWindowVisible(candidate).as_bool()
                || owner_of(candidate) != p.owner
                || class_name(candidate) == PSEUDO_CONSOLE_CLASS
            {
                return CONTINUE;
            }
            p.found = true;
            STOP
        }
        let mut p = Probe {
            owner: hwnd,
            found: false,
        };
        let _ = EnumWindows(Some(probe), LPARAM(&mut p as *mut Probe as isize));
        p.found
    }

    /// Re-enable any app window left disabled by a modal that died without
    /// restoring it.
    ///
    /// Owning console dialogs is the point of this module, and Windows disables
    /// a modal's owner for the dialog's lifetime. If that dialog's process is
    /// killed rather than dismissed — which TermFlow itself does on tab close,
    /// via `kill_process_tree`'s `taskkill /T /F` — the owner is never
    /// re-enabled and the whole app window stops responding to input while
    /// still painting normally. Run this whenever a terminal exits.
    pub fn unstick(owner: isize) {
        if owner == 0 {
            return;
        }
        unsafe {
            let hwnd = HWND(owner as *mut c_void);
            if IsWindowEnabled(hwnd).as_bool() || has_live_modal(hwnd) {
                return;
            }
            log::warn!("console_window: re-enabling app window left disabled by a dead modal");
            let _ = EnableWindow(hwnd, true);
        }
    }
}

#[cfg(windows)]
pub use imp::{adopt, unstick};

#[cfg(not(windows))]
pub fn adopt(_shell_pid: u32, _owner: isize) {}

#[cfg(not(windows))]
pub fn unstick(_owner: isize) {}

/// `unstick` every app window. Called from the terminal-exit paths, which know
/// a shell just died but not which window (if any) one of its dialogs owned.
pub fn unstick_all<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    #[cfg(windows)]
    {
        use tauri::Manager;
        for (_label, w) in app.webview_windows() {
            if let Ok(hwnd) = w.hwnd() {
                unstick(hwnd.0 as isize);
            }
        }
    }
    #[cfg(not(windows))]
    let _ = app;
}
