//! Windows named-pipe transport.
//!
//! Each `accept()` mints a FRESH pipe instance with an owner-only DACL and
//! waits for exactly one client — the same lifecycle the host used before the
//! transport was made OS-neutral: the previous instance is fully released
//! (dropped when the connection ends) before the next is created, so
//! `first_pipe_instance(true)` continues to guard against a squatter.

#![cfg(windows)]

use super::Endpoint;
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
#[cfg(test)]
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};

/// The connected server end of one pipe instance. Implements
/// `AsyncRead + AsyncWrite + Unpin + Send`, so the neutral serve loop drives it
/// unchanged.
pub type Stream = NamedPipeServer;

/// The client end (returned by `connect`). Distinct from `Stream` on Windows:
/// a named pipe has separate server/client handle types. Test-only: the real
/// GUI client (`app` crate) is a separate binary and dials the pipe itself
/// rather than linking this crate.
#[cfg(test)]
pub type ClientStream = NamedPipeClient;

/// Owns the pipe NAME and mints a fresh secured instance per `accept()`.
pub struct Listener {
    name: String,
}

impl Listener {
    pub fn bind(endpoint: &Endpoint) -> std::io::Result<Self> {
        // The Windows pipe namespace is global; no filesystem object to create
        // up front. The instance itself is created (secured) in `accept()`.
        Ok(Self {
            name: endpoint.0.clone(),
        })
    }

    /// Create a secured pipe instance and wait for one client to connect.
    pub async fn accept(&mut self) -> std::io::Result<Stream> {
        let server = secured_server(&self.name)?;
        server.connect().await?;
        Ok(server)
    }
}

/// Connect to the host as a client. Test-only, see `ClientStream`.
#[cfg(test)]
pub async fn connect(endpoint: &Endpoint) -> std::io::Result<ClientStream> {
    ClientOptions::new().open(&endpoint.0)
}

/// Create a pipe server instance restricted to this process's own user and
/// integrity level. `first_pipe_instance(true)` guards against a squatter
/// pre-creating the name (the previous instance is fully released before the
/// next is created in the sequential lifecycle).
///
/// FAIL CLOSED. The previous version fell back to the default pipe ACL when it
/// could not build a descriptor — a hardening path that WIDENS access when
/// identity lookup fails is worse than no pipe at all, especially now that an
/// elevated instance runs its own host.
pub fn secured_server(name: &str) -> std::io::Result<NamedPipeServer> {
    let psd = owner_only_security_descriptor().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "cannot build pipe security descriptor; refusing to create an unsecured pipe",
        )
    })?;
    let mut sa = windows_sys::Win32::Security::SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<windows_sys::Win32::Security::SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: psd,
        bInheritHandle: 0,
    };
    // SAFETY: `sa` outlives the call; `psd` is a valid self-relative SD from
    // ConvertStringSecurityDescriptor…; the pipe copies it, so we free `psd`
    // immediately after.
    let result = unsafe {
        ServerOptions::new()
            .first_pipe_instance(true)
            .create_with_security_attributes_raw(name, &mut sa as *mut _ as *mut std::ffi::c_void)
    };
    unsafe {
        windows_sys::Win32::Foundation::LocalFree(psd as _);
    }
    result
}

/// The SDDL for a pipe only this user, at this integrity level, may touch.
///
/// - `O:<sid>` names the owner EXPLICITLY. The old descriptor used the dynamic
///   Owner-Rights SID (`;;;OW`), which resolves against the token's *default*
///   owner — for an elevated process that is usually `BUILTIN\Administrators`,
///   i.e. every admin on the box, not the one user we meant.
/// - `D:P(A;;GA;;;<sid>)` — protected DACL, GENERIC_ALL to that one SID.
/// - `S:(ML;;NWNR;;;HI|ME)` — a mandatory label. Without it a medium-integrity
///   process could open an elevated host's pipe, which is a Medium→High
///   escalation: the pipe controls process spawning.
fn sddl_for(sid: &str, elevated: bool) -> String {
    let label = if elevated { "HI" } else { "ME" };
    format!("O:{sid}D:P(A;;GA;;;{sid})S:(ML;;NWNR;;;{label})")
}

/// Build a self-relative security descriptor restricting access to this user.
/// Returns a pointer that MUST be freed with `LocalFree`. None if the user's SID
/// could not be determined — the caller must then refuse to create the pipe.
fn owner_only_security_descriptor() -> Option<*mut std::ffi::c_void> {
    use windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
    let sid = current_user_sid_string()?;
    let sddl: Vec<u16> = format!("{}\0", sddl_for(&sid, is_elevated()))
        .encode_utf16()
        .collect();
    let mut psd: *mut std::ffi::c_void = std::ptr::null_mut();
    // SDDL_REVISION_1 == 1
    let ok = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
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

/// This process's user SID in string form (`S-1-5-21-…`). Crate-local on
/// purpose: the sidecar is a separate binary and cannot call the app crate's
/// `profile` module.
fn current_user_sid_string() -> Option<String> {
    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE};
    use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows_sys::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return None;
        }
        // Two-call idiom: ask for the size, then fill a buffer of that size.
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
        // ConvertSidToStringSidW allocates with LocalAlloc; leaking it on every
        // accept() would grow the host's heap for the life of the machine.
        LocalFree(raw as _);
        Some(s)
    }
}

/// Whether this process runs elevated. Crate-local twin of the app's
/// `profile::elevation`, for the same separate-binary reason. Unknown ⇒ `false`:
/// a wrong `true` would stamp a HIGH label a medium process cannot even set,
/// failing pipe creation outright, whereas a wrong `false` still leaves the
/// owner-only DACL in place.
fn is_elevated() -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
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
mod sddl_tests {
    use super::*;

    #[test]
    fn the_descriptor_names_an_explicit_owner_and_label() {
        let sddl = sddl_for("S-1-5-21-1-2-3-1001", true);
        assert!(sddl.starts_with("O:S-1-5-21-1-2-3-1001"), "got: {sddl}");
        assert!(sddl.contains("(A;;GA;;;S-1-5-21-1-2-3-1001)"), "got: {sddl}");
        assert!(sddl.contains("S:(ML;;NWNR;;;HI)"), "got: {sddl}");
        // The dynamic Owner-Rights SID resolved against the token's DEFAULT
        // owner, which for an elevated process is usually BUILTIN\Administrators.
        assert!(!sddl.contains(";OW)"), "the ambiguous Owner-Rights ACE must be gone");
    }

    #[test]
    fn a_medium_process_gets_a_medium_label() {
        assert!(sddl_for("S-1-5-21-1-2-3-1001", false).contains("S:(ML;;NWNR;;;ME)"));
    }

    #[test]
    fn this_process_resolves_a_real_sid_so_the_pipe_can_be_secured() {
        // secured_server now REFUSES to create a pipe without this, so a failure
        // here is a total loss of host-owned terminals, not a hardening downgrade.
        let sid = current_user_sid_string().expect("current user SID must resolve");
        assert!(sid.starts_with("S-1-"), "got: {sid}");
    }
}
