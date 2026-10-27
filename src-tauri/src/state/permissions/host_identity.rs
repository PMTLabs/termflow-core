//! Per-connection process-instance cache and macOS Security-framework verification.
use super::{HostIdentityVerifier, IdentityVerdict};
use crate::pty_host_client::PtyHostClient;
use std::collections::HashMap;
use std::sync::Mutex;

/// Darwin audit_token_t includes the PID version, not just a reusable PID.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct AuditToken(pub [u32; 8]);
impl AuditToken {
    pub(crate) fn pid(self) -> u32 { self.0[5] }
}

/// The cache belongs to one connection and one authenticated process instance.
#[derive(Default)]
pub(crate) struct IdentityCache(Mutex<Option<(AuditToken, IdentityVerdict)>>);
impl IdentityCache {
    pub(crate) fn verify(&self, token: Option<AuditToken>, lookup: impl FnOnce(AuditToken) -> IdentityVerdict) -> IdentityVerdict {
        let Some(token) = token else { return IdentityVerdict::Unverifiable; };
        let mut entry = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((cached_pid, verdict)) = *entry {
            if cached_pid == token { return verdict; }
        }
        let verdict = lookup(token);
        *entry = Some((token, verdict));
        verdict
    }
    pub(crate) fn clear(&self) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

/// A snapshot's PID-to-connection map; the cache itself survives subsequent
/// snapshots with the client and is invalidated with that connection.
pub(super) struct ProductionVerifier {
    clients: HashMap<u32, PtyHostClient>,
}
impl ProductionVerifier {
    pub(super) fn new(clients: impl IntoIterator<Item = PtyHostClient>) -> Self {
        let clients = clients.into_iter().filter_map(|c| c.server_pid().map(|p| (p, c))).collect();
        Self { clients }
    }
}
impl HostIdentityVerifier for ProductionVerifier {
    fn verify(&self, pid: u32) -> IdentityVerdict {
        self.clients.get(&pid).map(|c| c.host_identity_verdict(pid)).unwrap_or(IdentityVerdict::Unverifiable)
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn verify_token(_: AuditToken) -> IdentityVerdict { IdentityVerdict::Unverifiable }

#[cfg(target_os = "macos")]
pub(crate) fn verify_token(token: AuditToken) -> IdentityVerdict {
    macos::verify(token, crate::helper_identity::helper_requirement())
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{AuditToken, IdentityVerdict};
    use std::ffi::{c_char, c_void, CString};
    use std::ptr;

    type CFRef = *const c_void;
    const UTF8: u32 = 0x0800_0100;
    const ERR_SEC_CS_REQ_FAILED: i32 = -67050;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(allocator: CFRef, text: *const c_char, encoding: u32) -> CFRef;
        fn CFDataCreate(allocator: CFRef, bytes: *const u8, length: isize) -> CFRef;
        fn CFDictionaryCreate(allocator: CFRef, keys: *const CFRef, values: *const CFRef, count: isize, key_callbacks: *const c_void, value_callbacks: *const c_void) -> CFRef;
        fn CFRelease(object: CFRef);
        static kCFTypeDictionaryKeyCallBacks: c_void;
        static kCFTypeDictionaryValueCallBacks: c_void;
    }
    #[link(name = "Security", kind = "framework")]
    extern "C" {
        static kSecGuestAttributeAudit: CFRef;
        fn SecCodeCopyGuestWithAttributes(host: CFRef, attributes: CFRef, flags: u32, guest: *mut CFRef) -> i32;
        fn SecRequirementCreateWithString(text: CFRef, flags: u32, requirement: *mut CFRef) -> i32;
        fn SecCodeCheckValidity(code: CFRef, flags: u32, requirement: CFRef) -> i32;
    }
    struct Owned(CFRef);
    impl Owned {
        fn new(value: CFRef) -> Option<Self> { if value.is_null() { None } else { Some(Self(value)) } }
    }
    impl Drop for Owned { fn drop(&mut self) { unsafe { CFRelease(self.0) } } }

    pub(super) fn verify(token: AuditToken, requirement: &str) -> IdentityVerdict {
        if token.pid() == 0 { return IdentityVerdict::Unverifiable; }
        let Ok(text) = CString::new(requirement) else { return IdentityVerdict::Unverifiable; };
        unsafe {
            let Some(data) = Owned::new(CFDataCreate(ptr::null(), token.0.as_ptr().cast(), std::mem::size_of_val(&token) as isize)) else { return IdentityVerdict::Unverifiable; };
            let keys = [kSecGuestAttributeAudit];
            let values = [data.0];
            let Some(attributes) = Owned::new(CFDictionaryCreate(ptr::null(), keys.as_ptr(), values.as_ptr(), 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks)) else { return IdentityVerdict::Unverifiable; };
            let mut code = ptr::null();
            let status = SecCodeCopyGuestWithAttributes(ptr::null(), attributes.0, 0, &mut code);
            let code = Owned::new(code);
            if status != 0 { return IdentityVerdict::Unverifiable; }
            let Some(code) = code else { return IdentityVerdict::Unverifiable; };
            let Some(text) = Owned::new(CFStringCreateWithCString(ptr::null(), text.as_ptr(), UTF8)) else { return IdentityVerdict::Unverifiable; };
            let mut req = ptr::null();
            let status = SecRequirementCreateWithString(text.0, 0, &mut req);
            let req = Owned::new(req);
            if status != 0 { return IdentityVerdict::Unverifiable; }
            let Some(req) = req else { return IdentityVerdict::Unverifiable; };
            match SecCodeCheckValidity(code.0, 0, req.0) {
                0 => IdentityVerdict::Matches,
                ERR_SEC_CS_REQ_FAILED => IdentityVerdict::Different,
                _ => IdentityVerdict::Unverifiable,
            }
        }
    }
}

#[cfg(test)]
#[path = "host_identity_tests.rs"]
mod tests;
