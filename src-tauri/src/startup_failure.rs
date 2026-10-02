use std::sync::atomic::{AtomicI32, Ordering};

static REQUESTED_EXIT_CODE: AtomicI32 = AtomicI32::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MainWindowFailureAction {
    ExitPreservingPtyHosts { exit_code: i32 },
}

pub(crate) const fn main_window_failure_action() -> MainWindowFailureAction {
    MainWindowFailureAction::ExitPreservingPtyHosts { exit_code: 1 }
}

/// Remember the status the process must end with. `AppHandle::exit` does not
/// carry it to the OS: the run loop reports 0, so the exit handler applies it.
pub(crate) fn request_exit_code(code: i32) {
    REQUESTED_EXIT_CODE.store(code, Ordering::SeqCst);
}

pub(crate) fn requested_exit_code() -> Option<i32> {
    code_to_apply(REQUESTED_EXIT_CODE.load(Ordering::SeqCst))
}

fn code_to_apply(stored: i32) -> Option<i32> {
    (stored != 0).then_some(stored)
}

#[cfg(test)]
mod tests {
    use super::{code_to_apply, main_window_failure_action, MainWindowFailureAction};

    #[test]
    fn only_a_non_zero_requested_status_is_applied_at_exit() {
        assert_eq!(code_to_apply(0), None);
        assert_eq!(code_to_apply(1), Some(1));
        assert_eq!(code_to_apply(2), Some(2));
    }

    #[test]
    fn main_window_creation_failure_exits_nonzero_and_preserves_pty_hosts() {
        assert_eq!(
            main_window_failure_action(),
            MainWindowFailureAction::ExitPreservingPtyHosts { exit_code: 1 }
        );
    }
}
