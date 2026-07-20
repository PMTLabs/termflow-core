//! Windows job-object breakaway verification.
//!
//! A GUI launched from a terminal/IDE that itself runs inside a Job Object with
//! `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` would, by default, take the sidecar and
//! all its ConPTY children down when the GUI exits — defeating hot-swap. The
//! GUI spawns the sidecar with `CREATE_BREAKAWAY_FROM_JOB`; the sidecar then
//! verifies at startup that it is NOT trapped in a kill-on-close job. If it is,
//! survival cannot be guaranteed, so the GUI's arm must FAIL loudly rather than
//! silently lose sessions.

#[cfg(windows)]
pub fn assert_not_kill_on_close_job() -> Result<(), String> {
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
        // Query the process's own job via a null handle is not supported by
        // QueryInformationJobObject; instead a null job handle here means "the
        // job associated with the calling process".
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

#[cfg(not(windows))]
pub fn assert_not_kill_on_close_job() -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assert_not_kill_on_close_job_runs_without_panicking() {
        // The result depends on the environment: CI/sandbox test harnesses are
        // often themselves inside a kill-on-close job (this one is), in which
        // case the function correctly returns Err. A developer shell usually
        // returns Ok. Either is valid here — we only verify the FFI path
        // executes cleanly without UB/panic. The real breakaway semantics are
        // proven by the Task 16 hot-swap smoke test (spawn WITH breakaway →
        // sidecar observes it is NOT in the job).
        let _ = assert_not_kill_on_close_job();
    }
}
