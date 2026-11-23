//! Production bridge to 065's single resolver and locked store transaction.
use super::{
    auth::{AuthBinding, BoxFuture, SecretSink},
    session::{identity_path, AuthMethod, SessionError, SessionHop, SessionTarget, TargetSource},
    store::{Auth, Persisted, Reply, Store, StoreError},
    target,
};
use std::{path::PathBuf, sync::Arc};
use tokio_util::sync::CancellationToken;

type Changed = dyn Fn(&Reply) + Send + Sync;
#[derive(Clone)]
pub(crate) struct StoreAdapter {
    store: Store,
    home: PathBuf,
    changed: Arc<Changed>,
}

/// Native launch policy shared with future 066: explicit saved user wins;
/// otherwise the effective OS account name (not a spoofable USER/USERNAME).
/// No shell, WSL, or subprocess expansion.
pub(crate) fn effective_user(saved: &str) -> Result<String, SessionError> {
    let user = if saved.trim().is_empty() {
        native_username()?
    } else {
        saved.to_owned()
    };
    if user.trim().is_empty() || user.chars().any(char::is_control) {
        return Err(SessionError::InvalidTarget);
    }
    Ok(user)
}
#[cfg(windows)]
fn native_username() -> Result<String, SessionError> {
    #[link(name = "advapi32")]
    extern "system" {
        fn GetUserNameW(buffer: *mut u16, size: *mut u32) -> i32;
    }
    let mut buffer = vec![0u16; 257];
    let mut size = buffer.len() as u32;
    // SAFETY: buffer has size writable UTF-16 elements; the API includes NUL
    // in the returned length and cannot write beyond the supplied capacity.
    if unsafe { GetUserNameW(buffer.as_mut_ptr(), &mut size) } == 0 || size == 0 {
        return Err(SessionError::InvalidTarget);
    }
    String::from_utf16(&buffer[..size as usize - 1]).map_err(|_| SessionError::InvalidTarget)
}
#[cfg(unix)]
fn native_username() -> Result<String, SessionError> {
    let mut buffer = vec![0u8; 16 * 1024];
    loop {
        // SAFETY: getpwuid_r initializes passwd and returns pointers into buffer,
        // all consumed before either local is dropped; no shared libc storage.
        let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
        let mut result = std::ptr::null_mut();
        let code = unsafe {
            libc::getpwuid_r(
                libc::geteuid(),
                &mut pwd,
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                &mut result,
            )
        };
        if code == libc::ERANGE && buffer.len() < 1024 * 1024 {
            buffer.resize(buffer.len() * 2, 0);
            continue;
        }
        if code != 0 || result.is_null() || pwd.pw_name.is_null() {
            return Err(SessionError::InvalidTarget);
        }
        return unsafe { std::ffi::CStr::from_ptr(pwd.pw_name) }
            .to_str()
            .map(str::to_owned)
            .map_err(|_| SessionError::InvalidTarget);
    }
}
fn safe_error(error: StoreError) -> SessionError {
    match error.code.as_str() {
        "not-found" => SessionError::NotFound,
        "cancelled" => SessionError::Cancelled,
        "binding-mismatch" => SessionError::StaleAttempt,
        "read-error" | "invalid-json" | "io" | "store-read-only" => SessionError::StoreUnavailable,
        _ => SessionError::InvalidTarget,
    }
}
fn refusal(code: &str) -> StoreError {
    StoreError {
        field: None,
        code: code.into(),
        message: "SSH credential commit refused".into(),
    }
}
fn resolved(data: &Persisted, id: &str) -> Result<SessionTarget, SessionError> {
    let resolved = target::resolve(data, id).map_err(safe_error)?;
    session_target(&resolved, id)
}

fn session_target(resolved: &target::ResolvedTarget, id: &str) -> Result<SessionTarget, SessionError> {
    let mut target = SessionTarget {
        hops: resolved
            .hops
            .iter()
            .cloned()
            .map(|h| SessionHop {
                connection_id: h.connection_id,
                host: h.host,
                port: h.port,
                user: h.user,
                auth: match h.auth {
                    Auth::KeyFile => AuthMethod::Key,
                    Auth::Agent => AuthMethod::Agent,
                    Auth::Password => AuthMethod::Password,
                },
                identity_file: h.identity_file,
            })
            .collect(),
    };
    // 065 extra_options belong only to the terminal launch, never russh.
    target.validate(id)?;
    Ok(target)
}
impl StoreAdapter {
    pub(crate) fn new(store: Store, home: PathBuf, changed: Arc<Changed>) -> Self {
        Self {
            store,
            home,
            changed,
        }
    }
    fn binding_matches(
        &self,
        data: &Persisted,
        expected: &AuthBinding,
    ) -> Result<bool, SessionError> {
        let target = resolved(data, &expected.connection_id)?;
        let hop = target.hops.last().ok_or(SessionError::InvalidTarget)?;
        let fingerprint = if hop.auth == AuthMethod::Key {
            let path = identity_path(
                &self.home,
                hop.identity_file
                    .as_deref()
                    .ok_or(SessionError::InvalidTarget)?,
            );
            Some(super::identity::read_identity(&path)?.fingerprint())
        } else {
            None
        };
        Ok(AuthBinding::for_hop(hop, fingerprint) == *expected)
    }
}
impl TargetSource for StoreAdapter {
    fn resolve_launch<'a>(
        &'a self, id: &'a str,
    ) -> BoxFuture<'a, Result<(SessionTarget, Option<super::session::LaunchDefinition>), SessionError>> {
        Box::pin(async move {
            let adapter = self.clone();
            let id = id.to_owned();
            tokio::task::spawn_blocking(move || {
                adapter.store.with_launch_snapshot(|data, revision| {
                    let target = target::resolve(data, &id).map_err(safe_error)?;
                    let session = session_target(&target, &id)?;
                    Ok((session, Some(super::session::LaunchDefinition { revision, target })))
                }).map_err(safe_error)?
            }).await.map_err(|_| SessionError::StoreUnavailable)?
        })
    }

    fn resolve<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<SessionTarget, SessionError>> {
        Box::pin(async move {
            let adapter = self.clone();
            let id = id.to_owned();
            tokio::task::spawn_blocking(move || {
                resolved(&adapter.store.snapshot().map_err(safe_error)?, &id)
            })
            .await
            .map_err(|_| SessionError::StoreUnavailable)?
        })
    }
}
impl SecretSink for StoreAdapter {
    fn load<'a>(
        &'a self,
        binding: &'a AuthBinding,
    ) -> BoxFuture<'a, Result<Option<String>, SessionError>> {
        Box::pin(async move {
            let adapter = self.clone();
            let binding = binding.clone();
            tokio::task::spawn_blocking(move || {
                let data = adapter.store.snapshot().map_err(safe_error)?;
                if !adapter.binding_matches(&data, &binding)? {
                    return Err(SessionError::StaleAttempt);
                }
                Ok(data
                    .connections
                    .iter()
                    .find(|c| c.id == binding.connection_id)
                    .and_then(|c| c.secret.clone()))
            })
            .await
            .map_err(|_| SessionError::StoreUnavailable)?
        })
    }
    fn set_secret_if_binding_matches<'a>(
        &'a self,
        binding: &'a AuthBinding,
        ciphertext: String,
        cancel: CancellationToken,
    ) -> BoxFuture<'a, Result<(), SessionError>> {
        Box::pin(async move {
            let adapter = self.clone();
            let binding = binding.clone();
            tokio::task::spawn_blocking(move || {
                adapter
                    .store
                    .transact_checked(
                        |data| {
                            if !adapter.binding_matches(data, &binding).unwrap_or(false) {
                                return Err(refusal("binding-mismatch"));
                            }
                            let row = data
                                .connections
                                .iter_mut()
                                .find(|c| c.id == binding.connection_id)
                                .ok_or_else(|| refusal("binding-mismatch"))?;
                            row.secret = Some(ciphertext);
                            Ok(())
                        },
                        || {
                            if cancel.is_cancelled() {
                                Err(refusal("cancelled"))
                            } else {
                                Ok(())
                            }
                        },
                        |reply| (adapter.changed)(reply),
                    )
                    .map(|_| ())
                    .map_err(safe_error)
            })
            .await
            .map_err(|_| SessionError::StoreUnavailable)?
        })
    }
}

#[cfg(test)]
mod tests;
