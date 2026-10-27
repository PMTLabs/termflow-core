//! Injectable interface for macOS privacy APIs. Native calls are added in step C.

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
}

pub struct SystemTcc;

impl Tcc for SystemTcc {
    fn status(&self) -> (PermissionState, PermissionState) {
        let state = unavailable();
        (state, state)
    }

    fn request(&self, _kind: PermissionKind) -> PermissionState {
        unavailable()
    }
}

// Step C replaces the macOS placeholder with native, process-aware FFI.
#[cfg(target_os = "macos")]
fn unavailable() -> PermissionState {
    PermissionState::Unknown
}
#[cfg(not(target_os = "macos"))]
fn unavailable() -> PermissionState {
    PermissionState::Unsupported
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn system_placeholder_never_prompts() {
        let expected = if cfg!(target_os = "macos") {
            PermissionState::Unknown
        } else {
            PermissionState::Unsupported
        };
        assert_eq!(SystemTcc.status(), (expected, expected));
        for kind in [
            PermissionKind::Accessibility,
            PermissionKind::ScreenRecording,
        ] {
            assert_eq!(SystemTcc.request(kind), expected);
        }
    }
}
