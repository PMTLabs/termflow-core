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

/// Create a pipe server instance with an owner-only DACL so no other user on
/// the machine can connect. The SDDL `D:P(A;;GA;;;OW)` is a protected DACL that
/// grants GENERIC_ALL only to the pipe's OWNER (the creating user) — every other
/// principal has no ACE and is denied. `first_pipe_instance(true)` guards
/// against a squatter pre-creating the name (the previous instance is fully
/// released before the next is created in the sequential lifecycle).
pub fn secured_server(name: &str) -> std::io::Result<NamedPipeServer> {
    match owner_only_security_descriptor() {
        Some(psd) => {
            let mut sa = windows_sys::Win32::Security::SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<windows_sys::Win32::Security::SECURITY_ATTRIBUTES>()
                    as u32,
                lpSecurityDescriptor: psd,
                bInheritHandle: 0,
            };
            // SAFETY: `sa` outlives the call; `psd` is a valid self-relative SD
            // from ConvertStringSecurityDescriptor…; the pipe copies it, so we
            // free `psd` immediately after.
            let result = unsafe {
                ServerOptions::new().first_pipe_instance(true).create_with_security_attributes_raw(
                    name,
                    &mut sa as *mut _ as *mut std::ffi::c_void,
                )
            };
            unsafe {
                windows_sys::Win32::Foundation::LocalFree(psd as _);
            }
            result
        }
        None => ServerOptions::new().first_pipe_instance(true).create(name),
    }
}

/// Build a self-relative security descriptor restricting access to the owner.
/// Returns a pointer that MUST be freed with `LocalFree`. None on failure (the
/// caller falls back to the default pipe ACL).
fn owner_only_security_descriptor() -> Option<*mut std::ffi::c_void> {
    use windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
    // D: DACL, P: protected (no inheritance), one ACE: (Allow;;GenericAll;;;Owner)
    let sddl: Vec<u16> = "D:P(A;;GA;;;OW)\0".encode_utf16().collect();
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
