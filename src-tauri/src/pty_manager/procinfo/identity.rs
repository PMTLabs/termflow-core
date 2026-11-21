// sysinfo's public start_time is rounded to seconds. Use OS birth timestamps
// for identity (and exclude exited/zombie processes even before their reaper).
#[cfg(target_os = "linux")]
pub(crate) fn native_process_birth(pid: u32) -> Option<u64> {
    let stat = std::fs::read(format!("/proc/{pid}/stat")).ok()?;
    let end = stat.iter().rposition(|&b| b == b')')?;
    let mut fields = std::str::from_utf8(stat.get(end + 1..)?).ok()?.split_ascii_whitespace();
    if matches!(fields.next()?, "Z" | "X" | "x") { return None; }
    fields.nth(18)?.parse().ok() // field 22, after the state in field 3
}

#[cfg(target_os = "macos")]
pub(crate) fn native_process_birth(pid: u32) -> Option<u64> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::uninit();
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    // SAFETY: libproc writes at most size bytes into the writable buffer.
    let n = unsafe { libc::proc_pidinfo(pid as _, libc::PROC_PIDTBSDINFO, 0, info.as_mut_ptr().cast(), size) };
    if n != size { return None; }
    let info = unsafe { info.assume_init() };
    (info.pbi_status != libc::SZOMB).then_some(info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec)
}

#[cfg(windows)]
pub(crate) fn native_process_birth(pid: u32) -> Option<u64> {
    use windows_sys::Win32::{Foundation::{CloseHandle, FILETIME, WAIT_TIMEOUT}, System::Threading::{GetProcessTimes, OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE}};
    // SAFETY: the handle is owned by this call; all out parameters are writable.
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, 0, pid);
        if h.is_null() { return None; }
        let [mut start, mut exit, mut kernel, mut user]: [FILETIME; 4] = std::mem::zeroed();
        let live = GetProcessTimes(h, &mut start, &mut exit, &mut kernel, &mut user) != 0
            && WaitForSingleObject(h, 0) == WAIT_TIMEOUT;
        CloseHandle(h);
        live.then_some((u64::from(start.dwHighDateTime) << 32) | u64::from(start.dwLowDateTime))
    }
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
pub(crate) fn native_process_birth(_: u32) -> Option<u64> { None }
