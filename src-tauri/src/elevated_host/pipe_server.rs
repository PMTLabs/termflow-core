//! Secured pipe listener for the elevated channel (plan 045).
//!
//! The connection direction for this channel is reversed from the primary
//! sidecar's: the GUI (medium integrity) is the pipe SERVER here, and the
//! elevated `termflow-pty-host.exe` dials OUT as the client. See
//! `docs/plan/045-open-admin-tab.md` §4.1 for why — a medium-integrity
//! process cannot open a High-integrity pipe (`NWNR`, `pipe_windows.rs` in
//! the pty-host crate), so the GUI cannot be the CLIENT of an elevated
//! server; it has to be the server the elevated process dials into.
//!
//! Two things this module must get right, because a mistake here is a
//! same-user Medium→High escalation, not just a bug:
//! - The DACL restricts the pipe to the CURRENT USER's SID only (an explicit
//!   owner, not the dynamic Owner-Rights SID — see the comment on
//!   `pipe_windows.rs::sddl_for` in the pty-host crate for why that SID
//!   resolves against the wrong owner for an elevated process). FAIL CLOSED
//!   if the SID cannot be resolved: no pipe is better than an unsecured one.
//! - Every accepted connection is verified against the PID `ShellExecuteExW`
//!   actually returned, AND that PID's token must be elevated. A same-user
//!   impostor that races the real elevated process to connect first is
//!   rejected and logged — it gains nothing: it cannot spawn anything
//!   elevated by connecting here, it only fails to reach the elevated host's
//!   frame loop, and the listener keeps waiting for the real peer.

use std::io;
use std::time::Instant;
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
};
use windows_sys::Win32::Security::{
    GetTokenInformation, TokenElevation, TokenUser, SECURITY_ATTRIBUTES, TOKEN_ELEVATION,
    TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::System::Pipes::GetNamedPipeClientProcessId;
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
};

/// A listener that mints a fresh secured pipe instance per accept attempt,
/// mirroring the pty-host crate's `pipe_windows::Listener` — the previous
/// instance is fully released before the next is created.
pub struct AdminPipeListener {
    pub name: String,
    sid: String,
}

impl AdminPipeListener {
    /// Create the listener's NAME and resolve the securing SID up front.
    /// Binds no pipe instance yet — none exists until the first
    /// `accept_verified` call, exactly like `pipe_windows::Listener::bind`.
    /// `profile_key` is folded into the name only for operator legibility in
    /// a process list; it carries no security meaning (the DACL and the
    /// random suffix do that work).
    pub fn create(profile_key: &str) -> io::Result<Self> {
        let sid = require_sid(current_user_sid_string())?;
        let random = uuid::Uuid::new_v4().simple().to_string();
        let name = format!(r"\\.\pipe\termflow-pty-host-admin.{profile_key}.{random}");
        Ok(Self { name, sid })
    }

    /// Accept connections, verifying each peer's PID and elevation, until a
    /// verified peer connects or `deadline` passes. A mismatched peer is
    /// dropped and logged; the listener then mints a fresh instance and keeps
    /// waiting — a launch that races an impostor must still succeed once the
    /// real elevated process connects.
    pub async fn accept_verified(
        &self,
        expected_pid: u32,
        deadline: Instant,
    ) -> io::Result<NamedPipeServer> {
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "timed out waiting for the elevated host to connect",
                ));
            }
            let server = secured_instance(&self.name, &self.sid)?;
            match tokio::time::timeout(remaining, server.connect()).await {
                Err(_) => {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "timed out waiting for the elevated host to connect",
                    ))
                }
                Ok(Err(e)) => return Err(e),
                Ok(Ok(())) => {}
            }
            match verify_peer(&server, expected_pid) {
                Ok(()) => return Ok(server),
                Err(reason) => {
                    log::error!(
                        "[ADMIN] rejected peer on the admin pipe (expected pid {expected_pid}): {reason}"
                    );
                    drop(server);
                    continue;
                }
            }
        }
    }
}

/// Mint one fresh, secured pipe instance. `first_pipe_instance(true)` refuses
/// to create a second instance of the same name — the same anti-squatting
/// guard `pipe_windows.rs` documents for the primary sidecar.
fn secured_instance(name: &str, sid: &str) -> io::Result<NamedPipeServer> {
    let psd = build_security_descriptor(sid).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            "cannot build the admin pipe's security descriptor; refusing to create an unsecured pipe",
        )
    })?;
    let mut sa = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: psd,
        bInheritHandle: 0,
    };
    // SAFETY: `sa` outlives the call; `psd` is a valid self-relative SD from
    // ConvertStringSecurityDescriptorToSecurityDescriptorW; the pipe copies
    // it, so it is freed immediately after.
    let result = unsafe {
        ServerOptions::new()
            .first_pipe_instance(true)
            .create_with_security_attributes_raw(name, &mut sa as *mut _ as *mut std::ffi::c_void)
    };
    unsafe { LocalFree(psd as _) };
    result
}

/// SDDL for the admin channel: owner-only DACL, MEDIUM mandatory label.
/// Deliberately `ME`, not `HI` — see the module doc and plan 045 §4.1: this
/// pipe must stay reachable by the elevated (High) peer that has to write
/// DOWN to it, which `NWNR` permits; an `HI` label here would make this pipe
/// exactly as unreachable as the brief's original design (plan 045 §3.3).
fn admin_pipe_sddl(sid: &str) -> String {
    format!("O:{sid}D:P(A;;GA;;;{sid})S:(ML;;NWNR;;;ME)")
}

fn build_security_descriptor(sid: &str) -> Option<*mut std::ffi::c_void> {
    let sddl: Vec<u16> = format!("{}\0", admin_pipe_sddl(sid))
        .encode_utf16()
        .collect();
    let mut psd: *mut std::ffi::c_void = std::ptr::null_mut();
    // SAFETY: `sddl` is a NUL-terminated wide string; `psd` receives an
    // allocation on success which the caller frees with `LocalFree`.
    let ok = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1, // SDDL_REVISION_1
            &mut psd,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 || psd.is_null() {
        None
    } else {
        Some(psd)
    }
}

/// Fail-closed mapping, pulled out of `create` so the "no pipe is better than
/// an unsecured one" behaviour is directly testable without depending on an
/// actual SID-lookup failure, which nothing in a normal test environment can
/// force deterministically.
fn require_sid(sid: Option<String>) -> io::Result<String> {
    sid.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            "cannot resolve the current user's SID; refusing to create an unsecured admin pipe",
        )
    })
}

fn current_user_sid_string() -> Option<String> {
    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return None;
        }
        let mut size = 0u32;
        GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut size);
        if size == 0 {
            CloseHandle(token);
            return None;
        }
        let mut buf = vec![0u8; size as usize];
        let ok = GetTokenInformation(
            token,
            TokenUser,
            buf.as_mut_ptr() as *mut std::ffi::c_void,
            size,
            &mut size,
        );
        CloseHandle(token);
        if ok == 0 {
            return None;
        }
        let user = &*(buf.as_ptr() as *const TOKEN_USER);
        let mut raw: *mut u16 = std::ptr::null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut raw) == 0 || raw.is_null() {
            return None;
        }
        let len = (0..).take_while(|&i| *raw.add(i) != 0).count();
        let s = String::from_utf16_lossy(std::slice::from_raw_parts(raw, len));
        LocalFree(raw as _);
        Some(s)
    }
}

/// Read the connected peer's PID and defer to the pure decision function.
/// Split out so the decision itself (`verify_peer_pid`) is unit-testable
/// without a real pipe or a real elevated process.
fn verify_peer(server: &NamedPipeServer, expected_pid: u32) -> Result<(), String> {
    use std::os::windows::io::AsRawHandle;
    let handle = server.as_raw_handle() as HANDLE;
    let mut actual_pid = 0u32;
    // SAFETY: `handle` is the connected pipe instance's valid handle for the
    // duration of this call.
    if unsafe { GetNamedPipeClientProcessId(handle, &mut actual_pid) } == 0 {
        return Err(format!(
            "GetNamedPipeClientProcessId failed: {}",
            io::Error::last_os_error()
        ));
    }
    verify_peer_pid(actual_pid, expected_pid, pid_is_elevated)
}

/// The actual accept/reject decision, isolated from the OS calls that supply
/// its inputs. A peer is accepted only if BOTH hold: its PID is the one
/// `ShellExecuteExW` returned, and that PID's token is elevated. Checking PID
/// alone would accept a same-user process that raced to connect before the
/// real elevated host — the escalation this module exists to prevent.
fn verify_peer_pid(
    actual_pid: u32,
    expected_pid: u32,
    is_elevated: impl Fn(u32) -> bool,
) -> Result<(), String> {
    if actual_pid != expected_pid {
        return Err(format!(
            "peer pid {actual_pid} does not match the launched pid {expected_pid}"
        ));
    }
    if !is_elevated(actual_pid) {
        return Err(format!("peer pid {actual_pid} matched but its token is not elevated"));
    }
    Ok(())
}

/// Whether `pid`'s token carries the UAC-elevated (linked, full-privilege)
/// token. On Windows this is synonymous with High mandatory integrity — the
/// OS sets an elevated linked token's integrity to High as part of UAC token
/// filtering — so this is the same check `profile::elevation()` uses to
/// decide the WHOLE INSTANCE's own elevation, applied here to a peer PID
/// instead of `GetCurrentProcess()`. Unknown ⇒ `false`: a wrong `true` would
/// accept an unverified peer, whereas a wrong `false` only makes a legitimate
/// peer retry (the listener keeps accepting until `deadline`).
fn pid_is_elevated(pid: u32) -> bool {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return false;
        }
        let mut token: HANDLE = std::ptr::null_mut();
        let opened = OpenProcessToken(process, TOKEN_QUERY, &mut token) != 0;
        CloseHandle(process);
        if !opened {
            return false;
        }
        let mut e = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut size = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            &mut e as *mut _ as *mut std::ffi::c_void,
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut size,
        );
        CloseHandle(token);
        ok != 0 && e.TokenIsElevated != 0
    }
}

#[cfg(test)]
mod pipe_server_tests {
    use super::*;

    #[test]
    fn admin_channel_label_is_medium_so_a_high_peer_can_write_down() {
        let sddl = admin_pipe_sddl("S-1-5-21-1-2-3-1001");
        assert!(sddl.starts_with("O:S-1-5-21-1-2-3-1001"), "got: {sddl}");
        assert!(sddl.contains("(A;;GA;;;S-1-5-21-1-2-3-1001)"), "got: {sddl}");
        assert!(
            sddl.contains("S:(ML;;NWNR;;;ME)"),
            "the admin pipe must stay Medium so a High peer can still reach it: got {sddl}"
        );
        assert!(
            !sddl.contains(";HI)"),
            "an HI label here reintroduces the exact unreachability the brief's original design hit"
        );
    }

    #[test]
    fn refuses_to_create_a_pipe_without_a_resolvable_sid() {
        let err = require_sid(None).expect_err("no SID must fail closed, not fall back to an open ACL");
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn accepts_the_expected_peer_pid() {
        assert!(verify_peer_pid(4242, 4242, |_| true).is_ok());
    }

    #[test]
    fn rejects_a_peer_whose_pid_differs() {
        // Elevation is injected as unconditionally true here so the failure
        // can only be attributed to the PID check — this is the load-bearing
        // assertion: an accept-only test would still pass if this branch
        // were deleted entirely.
        let err = verify_peer_pid(4242, 9999, |_| true)
            .expect_err("a mismatched pid must never be accepted");
        assert!(err.contains("does not match"), "got: {err}");
    }

    #[test]
    fn rejects_a_matching_pid_that_is_not_elevated() {
        let err = verify_peer_pid(4242, 4242, |_| false)
            .expect_err("a matching pid whose token is not elevated must still be rejected");
        assert!(err.contains("not elevated"), "got: {err}");
    }
}
