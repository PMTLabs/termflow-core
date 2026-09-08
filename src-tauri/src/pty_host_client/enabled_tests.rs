use super::host_enabled;

/// `(is_windows, is_unix)` for every OS shape `enabled()` can pass in.
/// Asserted as a TABLE, not per-OS: Unix diverging from Windows here is
/// exactly the bug this flip fixed (macOS refused Offload/Update while
/// Windows worked), so every supported OS must answer identically.
const SUPPORTED: [(bool, bool); 2] = [(true, false), (false, true)];

#[test]
fn every_supported_os_is_default_on() {
    for (win, unix) in SUPPORTED {
        assert!(host_enabled(win, unix, None), "({win},{unix}) no override → on by default");
        assert!(host_enabled(win, unix, Some("1")), "({win},{unix}) =1 forces on");
    }
}

#[test]
fn zero_is_the_kill_switch_on_every_supported_os() {
    for (win, unix) in SUPPORTED {
        assert!(!host_enabled(win, unix, Some("0")), "({win},{unix}) =0 opts out");
    }
}

/// An unrecognised value is NOT the kill-switch — only the exact `"0"` is.
/// Guards the `!=` from being loosened into "anything but 1 is off", which
/// would silently re-disable the sidecar for a stray/misspelled value.
#[test]
fn only_the_exact_zero_disables() {
    for (win, unix) in SUPPORTED {
        for env in ["", "00", "false", "no", "2"] {
            assert!(
                host_enabled(win, unix, Some(env)),
                "({win},{unix}) {env:?} is not the kill-switch — only \"0\" is"
            );
        }
    }
}

#[test]
fn unsupported_target_is_always_off() {
    assert!(!host_enabled(false, false, Some("1")));
    assert!(!host_enabled(false, false, None));
    assert!(!host_enabled(false, false, Some("0")));
}
