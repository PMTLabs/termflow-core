//! Single-instance enforcement, keyed by the full profile identity.
//!
//! `tauri-plugin-single-instance` derives its mutex and relay-window names from
//! `app.config().identifier` alone. D7 forbids mutating the identifier (it moves
//! every Tauri-keyed root and would strand existing users' data), so we own this.
//!
//! Enforcement is UNCONDITIONAL for GUI processes. Rev 1 inherited bypasses for
//! `--api-port`/`--mcp-port`; those flags existed only as the pre-profile escape
//! hatch for a second instance and are superseded by `--profile` (D6). Keeping
//! them would let two processes share one profile's pipe -- the exact contention
//! this design exists to remove.
//!
//! UIPI direction: a medium-integrity process cannot `SendMessage` to a
//! high-integrity window. Because the mutex includes integrity, a medium launch
//! never *finds* an elevated instance's mutex — it starts its own instead of
//! silently vanishing. Verified by V5.
//!
//! Windows only. On Unix `lib.rs` keeps `tauri-plugin-single-instance` for the
//! primary profile, which is byte-for-byte the previous behaviour; a named
//! profile there is currently unenforced (it would contend for its own pipe if
//! launched twice). Tracked as a follow-up — Windows is the platform where
//! elevated second instances, the motivating case, exist at all.

use crate::profile::ProfileIdentity;

/// `Local\` keeps the object in the user's session, so two logged-in users are
/// never mutually exclusive.
pub fn mutex_name(id: &ProfileIdentity) -> String {
    format!(r"Local\termflow-instance.{}", id.key())
}

/// The relay window's class. Scoped too: an unscoped class would make
/// `FindWindowW` hand a second profile the *first* profile's window.
pub fn class_name(id: &ProfileIdentity) -> String {
    format!("termflow-instance-class.{}", id.key())
}

pub fn window_name(id: &ProfileIdentity) -> String {
    format!("termflow-instance-window.{}", id.key())
}

#[cfg(windows)]
pub use windows_impl::init;

#[cfg(windows)]
mod windows_impl {
    use super::{class_name, mutex_name, window_name};
    use crate::profile::ProfileIdentity;
    use std::ffi::CStr;
    use tauri::{
        plugin::{self, TauriPlugin},
        AppHandle, Manager, RunEvent, Runtime,
    };
    use windows_sys::Win32::{
        Foundation::{
            CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HWND, LPARAM, LRESULT, WPARAM,
        },
        System::{
            DataExchange::COPYDATASTRUCT,
            LibraryLoader::GetModuleHandleW,
            Threading::{CreateMutexW, ReleaseMutex},
        },
        UI::WindowsAndMessaging::{
            self as w32wm, CreateWindowExW, DefWindowProcW, DestroyWindow, FindWindowW,
            RegisterClassExW, SendMessageW, CREATESTRUCTW, GWLP_USERDATA, GWL_STYLE,
            WINDOW_LONG_PTR_INDEX, WM_COPYDATA, WM_CREATE, WM_DESTROY, WNDCLASSEXW, WS_EX_LAYERED,
            WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT, WS_OVERLAPPED, WS_POPUP,
            WS_VISIBLE,
        },
    };

    /// Arbitrary tag identifying our payload, so an unrelated `WM_COPYDATA`
    /// sender can never be mistaken for a second launch.
    const WMCOPYDATA_INSTANCE_ARGV: usize = 0x544D_4631; // "TMF1"

    /// The relay window is created immediately after the mutex, but a second
    /// launch can still land in that microscopic gap. Retry rather than fall
    /// through into a duplicate instance.
    const FIND_WINDOW_ATTEMPTS: u32 = 20;
    const FIND_WINDOW_INTERVAL_MS: u64 = 100;

    pub type OnSecondLaunch<R> = dyn FnMut(&AppHandle<R>, Vec<String>, String) + Send + 'static;

    struct MutexHandle(isize);
    struct TargetWindowHandle(isize);

    struct UserData<R: Runtime> {
        app: AppHandle<R>,
        callback: Box<OnSecondLaunch<R>>,
    }

    impl<R: Runtime> UserData<R> {
        unsafe fn from_hwnd_raw(hwnd: HWND) -> *mut Self {
            GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut Self
        }

        unsafe fn from_hwnd<'a>(hwnd: HWND) -> &'a mut Self {
            &mut *Self::from_hwnd_raw(hwnd)
        }

        fn run_callback(&mut self, args: Vec<String>, cwd: String) {
            (self.callback)(&self.app, args, cwd)
        }
    }

    /// Acquire the identity's lock, or relay this launch's argv to the instance
    /// that already holds it and exit.
    pub fn init<R: Runtime>(
        identity: &ProfileIdentity,
        callback: Box<OnSecondLaunch<R>>,
    ) -> TauriPlugin<R> {
        let class = encode_wide(class_name(identity));
        let window = encode_wide(window_name(identity));
        let mutex = encode_wide(mutex_name(identity));
        let key = identity.key();

        plugin::Builder::new("termflow-instance-lock")
            .setup(move |app, _api| {
                let hmutex =
                    unsafe { CreateMutexW(std::ptr::null(), true.into(), mutex.as_ptr()) };

                if unsafe { GetLastError() } != ERROR_ALREADY_EXISTS {
                    app.manage(MutexHandle(hmutex as _));
                    let userdata = Box::into_raw(Box::new(UserData {
                        app: app.clone(),
                        callback,
                    }));
                    let hwnd = create_event_target_window::<R>(&class, &window, userdata);
                    app.manage(TargetWindowHandle(hwnd as _));
                    return Ok(());
                }

                // Another process owns this identity. Hand it our argv so it can
                // open the requested folder (or just focus), then step aside.
                for attempt in 1..=FIND_WINDOW_ATTEMPTS {
                    let hwnd = unsafe { FindWindowW(class.as_ptr(), window.as_ptr()) };
                    if !hwnd.is_null() {
                        relay_argv(hwnd);
                        app.cleanup_before_exit();
                        std::process::exit(0);
                    }
                    if attempt < FIND_WINDOW_ATTEMPTS {
                        std::thread::sleep(std::time::Duration::from_millis(
                            FIND_WINDOW_INTERVAL_MS,
                        ));
                    }
                }

                // Fail closed. Continuing would put two processes on one profile's
                // pipe, lock and ports -- precisely what this design removes.
                log::error!(
                    "[INSTANCE] Profile '{key}' is already running but its relay window never \
                     appeared; refusing to start a duplicate. Use --profile to run a second \
                     instance."
                );
                app.cleanup_before_exit();
                std::process::exit(1);
            })
            .on_event(|app, event| {
                if let RunEvent::Exit = event {
                    destroy(app);
                }
            })
            .build()
    }

    fn relay_argv(hwnd: HWND) {
        let cwd = std::env::current_dir().unwrap_or_default();
        let cwd = cwd.to_str().unwrap_or_default();
        let args = std::env::args().collect::<Vec<String>>().join("|");
        let data = format!("{cwd}|{args}\0");
        let bytes = data.as_bytes();
        let cds = COPYDATASTRUCT {
            dwData: WMCOPYDATA_INSTANCE_ARGV,
            cbData: bytes.len() as _,
            lpData: bytes.as_ptr() as _,
        };
        unsafe { SendMessageW(hwnd, WM_COPYDATA, 0, &cds as *const _ as _) };
    }

    pub fn destroy<R: Runtime, M: Manager<R>>(manager: &M) {
        if let Some(hmutex) = manager.try_state::<MutexHandle>() {
            unsafe {
                ReleaseMutex(hmutex.0 as _);
                CloseHandle(hmutex.0 as _);
            }
        }
        if let Some(hwnd) = manager.try_state::<TargetWindowHandle>() {
            unsafe { DestroyWindow(hwnd.0 as _) };
        }
    }

    unsafe extern "system" fn instance_window_proc<R: Runtime>(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match msg {
            WM_CREATE => {
                let create_struct = &*(lparam as *const CREATESTRUCTW);
                let userdata = create_struct.lpCreateParams as *const UserData<R>;
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, userdata as _);
                0
            }
            WM_COPYDATA => {
                let cds_ptr = lparam as *const COPYDATASTRUCT;
                if (*cds_ptr).dwData == WMCOPYDATA_INSTANCE_ARGV {
                    let userdata = UserData::<R>::from_hwnd(hwnd);
                    let data = CStr::from_ptr((*cds_ptr).lpData as _).to_string_lossy();
                    let mut s = data.split('|');
                    let cwd = s.next().unwrap_or_default();
                    let args = s.map(|s| s.to_string()).collect();
                    userdata.run_callback(args, cwd.to_string());
                }
                1
            }
            WM_DESTROY => {
                let userdata = UserData::<R>::from_hwnd_raw(hwnd);
                drop(Box::from_raw(userdata));
                0
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }

    fn create_event_target_window<R: Runtime>(
        class_name: &[u16],
        window_name: &[u16],
        userdata: *const UserData<R>,
    ) -> HWND {
        unsafe {
            let class = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                style: 0,
                lpfnWndProc: Some(instance_window_proc::<R>),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: GetModuleHandleW(std::ptr::null()),
                hIcon: std::ptr::null_mut(),
                hCursor: std::ptr::null_mut(),
                hbrBackground: std::ptr::null_mut(),
                lpszMenuName: std::ptr::null(),
                lpszClassName: class_name.as_ptr(),
                hIconSm: std::ptr::null_mut(),
            };
            RegisterClassExW(&class);

            let hwnd = CreateWindowExW(
                // WS_EX_TOOLWINDOW keeps this helper window out of the taskbar for
                // good; without it Windows can surface it hours later.
                WS_EX_NOACTIVATE | WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_TOOLWINDOW,
                class_name.as_ptr(),
                window_name.as_ptr(),
                WS_OVERLAPPED,
                0,
                0,
                0,
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                GetModuleHandleW(std::ptr::null()),
                userdata as _,
            );
            SetWindowLongPtrW(hwnd, GWL_STYLE, (WS_VISIBLE | WS_POPUP) as isize);
            hwnd
        }
    }

    fn encode_wide(string: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
        std::os::windows::prelude::OsStrExt::encode_wide(string.as_ref())
            .chain(std::iter::once(0))
            .collect()
    }

    #[cfg(target_pointer_width = "32")]
    #[allow(non_snake_case)]
    unsafe fn SetWindowLongPtrW(hwnd: HWND, index: WINDOW_LONG_PTR_INDEX, value: isize) -> isize {
        w32wm::SetWindowLongW(hwnd, index, value as _) as _
    }

    #[cfg(target_pointer_width = "64")]
    #[allow(non_snake_case)]
    unsafe fn SetWindowLongPtrW(hwnd: HWND, index: WINDOW_LONG_PTR_INDEX, value: isize) -> isize {
        w32wm::SetWindowLongPtrW(hwnd, index, value)
    }

    #[cfg(target_pointer_width = "32")]
    #[allow(non_snake_case)]
    unsafe fn GetWindowLongPtrW(hwnd: HWND, index: WINDOW_LONG_PTR_INDEX) -> isize {
        w32wm::GetWindowLongW(hwnd, index) as _
    }

    #[cfg(target_pointer_width = "64")]
    #[allow(non_snake_case)]
    unsafe fn GetWindowLongPtrW(hwnd: HWND, index: WINDOW_LONG_PTR_INDEX) -> isize {
        w32wm::GetWindowLongPtrW(hwnd, index)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::Integrity;

    #[test]
    fn the_mutex_name_is_distinct_per_identity() {
        let n = |p: &str, i| {
            mutex_name(&ProfileIdentity {
                channel: "rel",
                name: p.into(),
                integrity: i,
            })
        };
        let names = [
            n("default", Integrity::Medium),
            n("default", Integrity::High),
            n("work", Integrity::Medium),
            n("work", Integrity::High),
        ];
        let mut u = names.to_vec();
        u.sort();
        u.dedup();
        assert_eq!(u.len(), 4, "each identity needs its own lock: {names:?}");
    }

    #[test]
    fn the_mutex_name_is_a_valid_win32_object_name() {
        let n = mutex_name(&ProfileIdentity {
            channel: "rel",
            name: "work".into(),
            integrity: Integrity::High,
        });
        assert!(!n.contains('\\') || n.starts_with("Local\\"), "got: {n}");
        assert!(n.len() < 260, "got: {n}");
    }

    #[test]
    fn the_relay_window_is_scoped_too() {
        // An unscoped class or title would make FindWindowW hand a second
        // profile the FIRST profile's window, relaying argv to the wrong app.
        let a = ProfileIdentity {
            channel: "rel",
            name: "default".into(),
            integrity: Integrity::Medium,
        };
        let b = ProfileIdentity {
            channel: "rel",
            name: "work".into(),
            integrity: Integrity::Medium,
        };
        assert_ne!(class_name(&a), class_name(&b));
        assert_ne!(window_name(&a), window_name(&b));
    }
}
