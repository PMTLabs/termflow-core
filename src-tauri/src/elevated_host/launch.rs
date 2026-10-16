//! `ShellExecuteExW` + `"runas"` launcher for the elevated sidecar (plan 045).
//!
//! Reference for the Win32 call shape: `open_commands.rs::os_open`, which uses
//! the simpler `ShellExecuteW` for the `"open"` verb — this module needs the
//! EXTENDED form (`ShellExecuteExW`) instead, because only that one can return
//! a process handle (`SEE_MASK_NOCLOSEPROCESS`), which the caller needs both
//! to read the launched PID (for `pipe_server`'s peer verification) and to
//! wait on the process at teardown.

use std::path::{Path, PathBuf};
use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_CANCELLED, HANDLE, HWND};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
use windows::Win32::System::Threading::GetProcessId;
use windows::Win32::UI::Shell::{
    ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
};
use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;
use windows::core::PCWSTR;

/// Owns the `HANDLE` to the launched elevated process (`SEE_MASK_NOCLOSEPROCESS`
/// hands it to us, so we must close it — `Drop` is the single closer). Windows
/// process handles are not thread-affine (unlike GDI/window handles), so moving
/// this across the oneshot channel below and into async state later (T4) is
/// sound.
pub struct LaunchedProcess {
    pub pid: u32,
    handle: HANDLE,
}

unsafe impl Send for LaunchedProcess {}

impl LaunchedProcess {
    pub fn from_handle(pid: u32, handle: HANDLE) -> Self {
        Self { pid, handle }
    }

    pub fn raw_handle(&self) -> HANDLE {
        self.handle
    }
}

impl Drop for LaunchedProcess {
    fn drop(&mut self) {
        if !self.handle.is_invalid() {
            // SAFETY: `self.handle` is a valid process handle owned exclusively
            // by this struct; nothing else closes it.
            let _ = unsafe { CloseHandle(self.handle) };
        }
    }
}

/// Outcome of one `ShellExecuteExW("runas", ...)` attempt.
pub enum LaunchOutcome {
    Ok(LaunchedProcess),
    /// The user denied the UAC prompt (`ERROR_CANCELLED`, 1223).
    Cancelled,
    /// Any other failure, carrying the raw Win32 error code for logging.
    Failed(u32),
}

/// Quote one argument for `ShellExecuteExW`'s `lpParameters`, which Windows
/// does not shell-parse itself — the CHILD process's own argv parsing
/// (`CommandLineToArgvW` convention, which `std::env::args()` on the far side
/// in `main.rs` already assumes) does. Only `--log <path>` can realistically
/// contain a space (a user profile directory); pipe names and UUID tokens
/// never do, but every argument is quoted uniformly rather than special-cased.
fn quote_arg(s: &str) -> String {
    if s.is_empty() || s.contains([' ', '"']) {
        format!("\"{}\"", s.replace('"', "\\\""))
    } else {
        s.to_string()
    }
}

/// Build the dial-out mode arguments (plan 045 §4.3, plan 058) as one `lpParameters`
/// string.
pub fn build_dial_out_parameters(
    pipe_name: &str,
    token: &str,
    log_path: &Path,
    survivor_record_path: Option<&Path>,
) -> String {
    let mut params = format!(
        "--connect-pipe {} --token {} --log {}",
        quote_arg(pipe_name),
        quote_arg(token),
        quote_arg(&log_path.to_string_lossy()),
    );
    if let Some(record) = survivor_record_path {
        params.push_str(&format!(" --survivor-record {}", quote_arg(&record.to_string_lossy())));
    }
    params
}

/// Build the reconnect helper mode arguments (plan 058 §3.2) as one `lpParameters`
/// string.
pub fn build_reconnect_parameters(
    reconnect_target: u32,
    rendezvous_pipe: &str,
    gui_pipe: &str,
    gui_pid: u32,
    token: &str,
) -> String {
    format!(
        "--reconnect-target {} --rendezvous-pipe {} --gui-pipe {} --gui-pid {} --token {}",
        reconnect_target,
        quote_arg(rendezvous_pipe),
        quote_arg(gui_pipe),
        gui_pid,
        quote_arg(token),
    )
}

/// Resolve the update-stable `termflow-pty-host.exe` and re-verify it immediately
/// before elevating (plan 058 §3.1 / T4): resolves and installs into
/// `runtime_host_dir()` outside the install root so it survives payload updates.
fn resolve_and_verify_host_path() -> Result<PathBuf, String> {
    let launch = crate::pty_host_client::resolve_host_launch()
        .ok_or_else(|| "no termflow-pty-host binary found to elevate".to_string())?;
    std::fs::metadata(&launch.path).map_err(|e| format!("cannot verify {}: {e}", launch.path.display()))?;
    Ok(launch.path)
}

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// `ERROR_CANCELLED` (1223) is the documented code `ShellExecuteExW` reports
/// when the user denies the UAC consent prompt. Every other code is a genuine
/// launch failure, not a user decision — collapsing the two would silently
/// turn a denied prompt into an error toast the user never asked to see
/// (plan 045 AC6: cancel must be a silent no-op).
fn classify_launch_error(code: u32) -> LaunchOutcome {
    if code == ERROR_CANCELLED.0 {
        LaunchOutcome::Cancelled
    } else {
        LaunchOutcome::Failed(code)
    }
}

/// Resolve the host binary, re-verify it, and elevate it via
/// `ShellExecuteExW("runas", …)` with `nShow = SW_HIDE` (plan 045 R4) on a
/// dedicated thread with its own apartment-threaded COM initialisation
/// (`ShellExecuteExW`'s documented requirement — the calling thread must be
/// COM-initialised, and this call must not share a thread with anything else
/// that has different COM expectations). Returns once the shell has either
/// launched the process or reported why it did not.
pub async fn run_as(parameters: String) -> LaunchOutcome {
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let outcome = run_as_blocking(&parameters);
        let _ = tx.send(outcome);
    });
    match rx.await {
        Ok(outcome) => outcome,
        // The launcher thread panicked before sending — treat as a generic
        // failure rather than silently hanging the caller.
        Err(_) => LaunchOutcome::Failed(0),
    }
}

fn run_as_blocking(parameters: &str) -> LaunchOutcome {
    let host_path = match resolve_and_verify_host_path() {
        Ok(p) => p,
        Err(e) => {
            log::error!("[ADMIN] {e}");
            return LaunchOutcome::Failed(0);
        }
    };

    // SAFETY: apartment-threaded COM init on this dedicated thread, per
    // ShellExecuteExW's documented requirement. Best-effort: a failure here
    // still lets ShellExecuteExW itself report the real outcome.
    let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };

    let file = to_wide(&host_path.to_string_lossy());
    let verb = to_wide("runas");
    let params = to_wide(parameters);

    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC,
        hwnd: HWND::default(),
        lpVerb: PCWSTR(verb.as_ptr()),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(params.as_ptr()),
        lpDirectory: PCWSTR::null(),
        nShow: SW_HIDE.0,
        ..Default::default()
    };

    // SAFETY: `info` is fully initialised; `file`/`verb`/`params` (the
    // `Vec<u16>` locals backing the PCWSTR fields) outlive this call.
    let result = unsafe { ShellExecuteExW(&mut info) };
    if let Err(_e) = result {
        // SAFETY: plain Win32 call; queried immediately after the failing
        // call, before any other Win32 API on this thread can clobber it.
        let code = unsafe { GetLastError() }.0;
        return classify_launch_error(code);
    }
    if info.hProcess.is_invalid() {
        // Successful per the BOOL/Result convention but no process handle —
        // treat as a failure rather than fabricate a PID.
        return LaunchOutcome::Failed(0);
    }
    // SAFETY: `info.hProcess` is the valid handle `ShellExecuteExW` just
    // returned, owned by this call via SEE_MASK_NOCLOSEPROCESS.
    let pid = unsafe { GetProcessId(info.hProcess) };
    LaunchOutcome::Ok(LaunchedProcess {
        pid,
        handle: info.hProcess,
    })
}

#[cfg(test)]
mod launch_tests {
    use super::*;

    #[test]
    fn error_1223_is_cancelled_and_every_other_code_is_failed() {
        assert!(matches!(classify_launch_error(1223), LaunchOutcome::Cancelled));
        for code in [0u32, 2, 5, 1223 + 1, 87] {
            assert!(
                matches!(classify_launch_error(code), LaunchOutcome::Failed(c) if c == code),
                "code {code} must classify as Failed, not Cancelled"
            );
        }
    }

    #[test]
    fn parameters_quote_only_the_argument_that_needs_it() {
        let p = build_dial_out_parameters(
            r"\\.\pipe\termflow-pty-host-admin.default.abc123",
            "5b6c1e8e-aaaa-bbbb-cccc-000000000000",
            Path::new(r"C:\Users\Jane Doe\AppData\Local\Temp\host-admin.log"),
            Some(Path::new(r"C:\Users\Jane Doe\AppData\Local\elevated-survivor-default.json")),
        );
        assert_eq!(
            p,
            r#"--connect-pipe \\.\pipe\termflow-pty-host-admin.default.abc123 --token 5b6c1e8e-aaaa-bbbb-cccc-000000000000 --log "C:\Users\Jane Doe\AppData\Local\Temp\host-admin.log" --survivor-record "C:\Users\Jane Doe\AppData\Local\elevated-survivor-default.json""#
        );
    }

    #[test]
    fn reconnect_parameters_format() {
        let p = build_reconnect_parameters(
            1234,
            r"\\.\pipe\termflow-admin-rendezvous.S-1-5-21.1234",
            r"\\.\pipe\termflow-pty-host-admin.default.xyz789",
            5678,
            "secret-token",
        );
        assert_eq!(
            p,
            r#"--reconnect-target 1234 --rendezvous-pipe \\.\pipe\termflow-admin-rendezvous.S-1-5-21.1234 --gui-pipe \\.\pipe\termflow-pty-host-admin.default.xyz789 --gui-pid 5678 --token secret-token"#
        );
    }
}
