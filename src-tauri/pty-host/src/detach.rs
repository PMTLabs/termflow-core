//! Cross-platform "can I outlive the GUI?" assertion.
//!
//! Hot-swap only works if the detached sidecar survives the GUI process exiting.
//! Two very different mechanisms, one predicate:
//!
//! - **Windows:** a GUI launched from a terminal/IDE that itself runs inside a
//!   Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` would take the sidecar
//!   and its ConPTY children down when the GUI exits. The GUI spawns the sidecar
//!   with `CREATE_BREAKAWAY_FROM_JOB`; the sidecar verifies here that it is NOT
//!   trapped in a kill-on-close job.
//! - **Unix:** the GUI spawns the sidecar in its own session via `setsid`, so
//!   the sidecar is a session leader with no controlling terminal and is not in
//!   the GUI's process group — a GUI exit (or its `SIGHUP` to the foreground
//!   group) cannot reach it. We verify session leadership here.
//!
//! If the check fails, survival cannot be guaranteed, so the GUI's arm must
//! FAIL loudly rather than silently lose sessions.

#[cfg(windows)]
pub fn assert_survivable() -> Result<(), String> {
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::JobObjects::{
        IsProcessInJob, QueryInformationJobObject, JobObjectExtendedLimitInformation,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    unsafe {
        let process: HANDLE = GetCurrentProcess();
        let mut in_job: i32 = 0;
        // Passing a null job handle queries the process's CURRENT job.
        if IsProcessInJob(process, std::ptr::null_mut(), &mut in_job) == 0 {
            return Err("IsProcessInJob failed".into());
        }
        if in_job == 0 {
            return Ok(()); // not in any job → safe
        }
        // In a job: inspect its limit flags.
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        let size = std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
        let mut ret_len: u32 = 0;
        // A null job handle here means "the job associated with the calling
        // process".
        if QueryInformationJobObject(
            std::ptr::null_mut(),
            JobObjectExtendedLimitInformation,
            &mut info as *mut _ as *mut core::ffi::c_void,
            size,
            &mut ret_len,
        ) == 0
        {
            // Can't inspect the job → be conservative and treat as unsafe.
            return Err("QueryInformationJobObject failed".into());
        }
        if info.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE != 0 {
            return Err(
                "sidecar is in a kill-on-close job; hot-swap survival not guaranteed".into(),
            );
        }
        Ok(())
    }
}

#[cfg(unix)]
pub fn assert_survivable() -> Result<(), String> {
    // SAFETY: getsid(0)/getpid() are always-available, side-effect-free syscalls.
    let sid = unsafe { libc::getsid(0) };
    let pid = unsafe { libc::getpid() };
    is_session_leader(sid, pid)
}

/// Pure predicate for the Unix survivability rule: we must be our own session
/// leader (`sid == pid`). Split out so it is unit-testable without a fork.
#[cfg(unix)]
fn is_session_leader(sid: libc::pid_t, pid: libc::pid_t) -> Result<(), String> {
    if sid == -1 {
        return Err("getsid failed".into());
    }
    if sid == pid {
        Ok(())
    } else {
        Err("pty-host is not a session leader; hot-swap survival not guaranteed".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assert_survivable_runs_without_panicking() {
        // The result is environment-dependent: a CI/sandbox harness is often
        // itself inside a kill-on-close job (Windows) or not a session leader
        // (Unix), in which case the function correctly returns Err. We only
        // verify the syscall/FFI path executes cleanly without UB/panic. The
        // real semantics are proven by the setsid test below (Unix) and the
        // hot-swap smoke (Windows breakaway).
        let _ = assert_survivable();
    }

    #[cfg(unix)]
    #[test]
    fn session_leader_predicate() {
        assert!(is_session_leader(42, 42).is_ok(), "sid == pid ⇒ survivable");
        assert!(is_session_leader(1, 42).is_err(), "sid != pid ⇒ not survivable");
        assert!(is_session_leader(-1, 42).is_err(), "getsid failure ⇒ error");
    }

    // Real end-to-end check: a forked child that calls setsid() becomes a
    // session leader and passes assert_survivable(); a child that does NOT
    // setsid shares our session and fails. fork() in a multi-threaded test is
    // safe here because the child only calls async-signal-safe functions
    // (setsid/getsid/getpid/_exit) before exiting.
    #[cfg(unix)]
    #[test]
    fn survivable_after_setsid() {
        unsafe {
            let pid = libc::fork();
            assert!(pid >= 0, "fork failed");
            if pid == 0 {
                let sid = libc::setsid();
                let ok = sid != -1 && assert_survivable().is_ok();
                libc::_exit(if ok { 0 } else { 1 });
            }
            let mut status: libc::c_int = 0;
            libc::waitpid(pid, &mut status, 0);
            assert_eq!(
                libc::WEXITSTATUS(status),
                0,
                "a setsid child is a session leader ⇒ survivable"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn not_survivable_without_setsid() {
        unsafe {
            let pid = libc::fork();
            assert!(pid >= 0, "fork failed");
            if pid == 0 {
                // No setsid: the child shares our session, so it is not the
                // session leader ⇒ assert_survivable must fail.
                let ok = assert_survivable().is_ok();
                libc::_exit(if ok { 0 } else { 1 });
            }
            let mut status: libc::c_int = 0;
            libc::waitpid(pid, &mut status, 0);
            assert_eq!(
                libc::WEXITSTATUS(status),
                1,
                "a child sharing our session is not a leader ⇒ not survivable"
            );
        }
    }
}
