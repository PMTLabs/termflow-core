use super::launch::LaunchedProcess;
use std::path::{Path, PathBuf};
use termflow_pty_protocol::ElevatedSurvivorRecord;

/// Resolve the profile-scoped survivor rendezvous record shared by connect and quit.
pub(crate) fn survivor_record_path(runtime_dir: &Path, profile_key: &str) -> PathBuf {
    runtime_dir.join(format!("elevated-survivor-{profile_key}.json"))
}

/// Open the recorded host only if it is still active and its PID has not been reused.
/// The returned handle is owned by `LaunchedProcess` and can be retained by a reconnect.
pub(crate) fn open_live_process(record: &ElevatedSurvivorRecord) -> Option<LaunchedProcess> {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const STILL_ACTIVE: u32 = 259;

    // SAFETY: the queried handle is opened for the recorded PID and is either
    // transferred to LaunchedProcess or closed before this function returns.
    unsafe {
        let handle = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
            0,
            record.host_pid,
        );
        if handle.is_null() || (handle as isize) == -1 {
            return None;
        }
        let mut exit_code = 0u32;
        let ok_code = GetExitCodeProcess(handle, &mut exit_code) != 0;
        let mut creation = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let mut exit = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let mut kernel = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let mut user = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let ok_time =
            GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) != 0;
        let creation_time =
            ((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64;
        if ok_code
            && exit_code == STILL_ACTIVE
            && ok_time
            && creation_time == record.host_creation_time
        {
            Some(LaunchedProcess::from_handle(
                record.host_pid,
                windows::Win32::Foundation::HANDLE(handle as _),
            ))
        } else {
            CloseHandle(handle);
            None
        }
    }
}

/// Remove a dead survivor's record and only its matching stand-down request.
pub(crate) fn cleanup_dead_survivor_record(path: &Path, instance_id: u128) {
    let _ = termflow_pty_protocol::rendezvous::remove_elevated_survivor_if_owned(path, instance_id);
    if let Some(stand_down_path) =
        termflow_pty_protocol::rendezvous::elevated_stand_down_path_for_survivor(path)
    {
        let _ = termflow_pty_protocol::rendezvous::remove_elevated_stand_down_if_owned(
            &stand_down_path,
            instance_id,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(host_pid: u32, host_creation_time: u64, instance_id: u128) -> ElevatedSurvivorRecord {
        ElevatedSurvivorRecord {
            format: 1,
            user_sid: "S-1-5-21-test".into(),
            host_pid,
            host_creation_time,
            instance_id,
            rendezvous_pipe: r"\\.\pipe\termflow-admin-rendezvous.test.2345.nonce".into(),
            proto_min: 1,
            proto_max: 1,
            capabilities: 0,
        }
    }

    fn current_process_creation_time() -> u64 {
        use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
        use windows_sys::Win32::System::Threading::{
            GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        let handle =
            unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, std::process::id()) };
        assert!(
            !handle.is_null() && (handle as isize) != -1,
            "open current process"
        );
        let mut creation = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let mut exit = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let mut kernel = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let mut user = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let ok =
            unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) }
                != 0;
        unsafe { CloseHandle(handle) };
        assert!(ok, "query current process times");
        ((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64
    }

    #[test]
    fn live_process_match_requires_the_recorded_creation_time() {
        let creation_time = current_process_creation_time();
        let live = record(std::process::id(), creation_time, 1);
        assert!(open_live_process(&live).is_some());

        let reused_pid = record(std::process::id(), creation_time.wrapping_add(1), 1);
        assert!(open_live_process(&reused_pid).is_none());
    }

    #[test]
    fn dead_survivor_cleanup_removes_its_signal_but_spares_another_instance() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "termflow-dead-survivor-{}-{nonce}",
            std::process::id()
        ));
        let path = survivor_record_path(&dir, "default");
        let stand_down_path =
            termflow_pty_protocol::rendezvous::elevated_stand_down_path_for_survivor(&path)
                .unwrap();
        let owner = 0xDEADBEEF_CAFE_1234;
        let rec = record(2345, 6789, owner);

        termflow_pty_protocol::rendezvous::publish_elevated_survivor(&path, &rec).unwrap();
        termflow_pty_protocol::rendezvous::request_elevated_stand_down(&stand_down_path, owner)
            .unwrap();
        cleanup_dead_survivor_record(&path, owner);
        assert!(!path.exists(), "the dead survivor record should be removed");
        assert_eq!(
            termflow_pty_protocol::rendezvous::read_elevated_stand_down(&stand_down_path),
            None
        );

        termflow_pty_protocol::rendezvous::publish_elevated_survivor(&path, &rec).unwrap();
        let other_instance = owner.wrapping_add(1);
        termflow_pty_protocol::rendezvous::request_elevated_stand_down(
            &stand_down_path,
            other_instance,
        )
        .unwrap();
        cleanup_dead_survivor_record(&path, owner);
        assert!(
            !path.exists(),
            "the matching survivor record should be removed"
        );
        assert_eq!(
            termflow_pty_protocol::rendezvous::read_elevated_stand_down(&stand_down_path),
            Some(other_instance),
            "another instance's stand-down request must remain"
        );

        let parent = path.parent().unwrap();
        let _ = std::fs::remove_file(stand_down_path);
        let _ = std::fs::remove_dir(parent);
    }
}
