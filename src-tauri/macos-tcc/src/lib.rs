//! Injectable, process-local macOS TCC calls. The host is responsible for
//! calling screen recording and status APIs in its own short-lived child.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PermissionKind {
    Accessibility,
    ScreenRecording,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PermissionState {
    Granted,
    NotGranted,
    Unsupported,
    Unknown,
}

pub trait Tcc: Send + Sync {
    fn status(&self) -> (PermissionState, PermissionState);
    fn request(&self, kind: PermissionKind) -> PermissionState;
    fn self_responsible(&self) -> Option<bool> {
        None
    }
}
pub struct SystemTcc;

#[cfg(not(target_os = "macos"))]
impl Tcc for SystemTcc {
    fn status(&self) -> (PermissionState, PermissionState) {
        (PermissionState::Unsupported, PermissionState::Unsupported)
    }
    fn request(&self, _: PermissionKind) -> PermissionState {
        PermissionState::Unsupported
    }
}

// An absent symbol or a failed call is indeterminate, never a positive claim.
#[cfg(any(test, target_os = "macos"))]
fn responsibility_with(lookup: impl FnOnce() -> Option<i32>, pid: i32) -> Option<bool> {
    let responsible = lookup()?;
    (responsible > 0).then_some(responsible == pid)
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{responsibility_with, PermissionKind, PermissionState, SystemTcc, Tcc};
    use std::ffi::{c_char, c_void};
    use std::ptr;
    type CfRef = *const c_void;
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(options: CfRef) -> bool;
        static kAXTrustedCheckOptionPrompt: CfRef;
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFBooleanTrue: CfRef;
        fn CFDictionaryCreate(
            allocator: CfRef,
            keys: *const CfRef,
            values: *const CfRef,
            count: isize,
            key_callbacks: CfRef,
            value_callbacks: CfRef,
        ) -> CfRef;
        fn CFRelease(value: CfRef);
    }
    extern "C" {
        fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
        fn getpid() -> i32;
    }
    fn state(granted: bool) -> PermissionState {
        if granted {
            PermissionState::Granted
        } else {
            PermissionState::NotGranted
        }
    }
    impl Tcc for SystemTcc {
        fn status(&self) -> (PermissionState, PermissionState) {
            // SAFETY: no arguments or owned pointers; these are non-prompting APIs.
            unsafe {
                (
                    state(AXIsProcessTrusted()),
                    state(CGPreflightScreenCaptureAccess()),
                )
            }
        }
        fn request(&self, kind: PermissionKind) -> PermissionState {
            // SAFETY: keys and values are immortal CF constants, the dictionary
            // lives through the synchronous call, and is released exactly once.
            unsafe {
                match kind {
                    PermissionKind::Accessibility => {
                        let key = kAXTrustedCheckOptionPrompt;
                        let value = kCFBooleanTrue;
                        let options = CFDictionaryCreate(
                            ptr::null(),
                            &key,
                            &value,
                            1,
                            ptr::null(),
                            ptr::null(),
                        );
                        if options.is_null() {
                            return PermissionState::Unknown;
                        }
                        let result = AXIsProcessTrustedWithOptions(options);
                        CFRelease(options);
                        state(result)
                    }
                    PermissionKind::ScreenRecording => state(CGRequestScreenCaptureAccess()),
                }
            }
        }
        fn self_responsible(&self) -> Option<bool> {
            // SAFETY: Darwin RTLD_DEFAULT is (void *)-2. The symbol has the
            // documented spike signature pid_t(pid_t); null is never called.
            unsafe {
                let pid = getpid();
                responsibility_with(
                    || {
                        let symbol = dlsym(
                            (-2isize) as *mut c_void,
                            c"responsibility_get_pid_responsible_for_pid".as_ptr(),
                        );
                        if symbol.is_null() {
                            return None;
                        }
                        let function: unsafe extern "C" fn(i32) -> i32 =
                            std::mem::transmute(symbol);
                        Some(function(pid))
                    },
                    pid,
                )
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_or_failing_responsibility_symbol_is_unknown() {
        assert_eq!(responsibility_with(|| None, 12), None);
        assert_eq!(responsibility_with(|| Some(-1), 12), None);
        assert_eq!(responsibility_with(|| Some(0), 12), None);
        assert_eq!(responsibility_with(|| Some(12), 12), Some(true));
        assert_eq!(responsibility_with(|| Some(13), 12), Some(false));
    }
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn non_macos_stubs_are_unsupported() {
        assert_eq!(
            SystemTcc.status(),
            (PermissionState::Unsupported, PermissionState::Unsupported)
        );
        assert_eq!(
            SystemTcc.request(PermissionKind::Accessibility),
            PermissionState::Unsupported
        );
        assert_eq!(
            SystemTcc.request(PermissionKind::ScreenRecording),
            PermissionState::Unsupported
        );
        assert_eq!(SystemTcc.self_responsible(), None);
    }
}
