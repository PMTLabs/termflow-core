//! SFTP primitives scoped to a browser's terminal and expected session generation.
mod download;
pub(crate) mod edit;
pub(crate) mod insert;
pub(crate) mod launch;
pub mod local_target;
mod ops;
mod types;
mod upload;
pub(crate) mod watch;
#[cfg(test)]
mod tests;

pub use download::{DownloadOutcome, DownloadPicker, DownloadResult, FileDownloadOutcome};
pub use local_target::FileTarget;
pub use types::*;

use super::{
    auth::BoxFuture,
    session::{SessionError, SessionRegistry, SftpLease, SshSession},
};
use russh_sftp::{
    client::{error::Error as WireError, RawSftpSession},
    protocol::{FileAttributes, OpenFlags, StatusCode},
};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

const MAX_ENTRIES: usize = 50_000;
const MAX_DEPTH: usize = 64;

pub fn valid_child_name(name: &str) -> bool {
    !matches!(name, "" | "." | "..") && !name.contains(['/', '\0', '\u{fffd}'])
}

pub fn child_path(parent: &str, name: &str) -> Option<String> {
    valid_child_name(name).then(|| format!("{}/{name}", parent.trim_end_matches('/')))
}

fn validate(operation: &'static str, path: &str, destructive: bool) -> Result<(), FsError> {
    if path == "/" && !destructive {
        return Ok(());
    }
    let components = path.strip_prefix('/').ok_or_else(|| invalid(operation, path))?;
    if !components.split('/').all(valid_child_name) {
        return Err(invalid(operation, path));
    }
    if components.split('/').count() > MAX_DEPTH {
        return Err(budget(operation, path));
    }
    Ok(())
}

fn invalid(operation: &'static str, path: &str) -> FsError {
    error(operation, path, FsCode::InvalidPath, FsOutcome::Unchanged, "Expected an actionable absolute POSIX path.")
}

fn budget(operation: &'static str, path: &str) -> FsError {
    error(operation, path, FsCode::Unsupported, FsOutcome::Unchanged, "Remote listing/path exceeds the entry or depth budget.")
}

pub(super) fn error(operation: &'static str, path: &str, code: FsCode, outcome: FsOutcome, detail: &str) -> FsError {
    let message = match outcome {
        FsOutcome::Unknown => format!("Could not confirm {operation} on {path}; reconnect and refresh."),
        FsOutcome::Partial => format!("Partially completed {operation} on {path}. {detail} Refresh to reconcile."),
        FsOutcome::Unchanged if code == FsCode::PermissionDenied => format!("Permission denied on {path}. Nothing was changed."),
        FsOutcome::Unchanged => format!("{operation} on {path}: {detail}"),
    };
    FsError { code, operation, path: path.into(), message, outcome, completed_paths: None, retained_local_path: None }
}

fn session_error(op: &'static str, path: &str, failure: SessionError, sent: bool) -> FsError {
    let (code, detail) = match failure {
        SessionError::NotConnected => (FsCode::NotConnected, "SSH is not connected."),
        SessionError::CapabilityUnavailable => (FsCode::Unsupported, "SFTP is unavailable."),
        SessionError::Cancelled => (FsCode::Cancelled, "SSH request cancelled."),
        SessionError::StaleAttempt => (FsCode::Stale, "The SSH session has changed."),
        _ => (FsCode::Io, "SSH transport failed or timed out."),
    };
    error(op, path, code, if sent { FsOutcome::Unknown } else { FsOutcome::Unchanged }, detail)
}

fn status(err: &WireError) -> Option<StatusCode> {
    match err {
        WireError::Status(reply) => Some(reply.status_code),
        _ => None,
    }
}

fn wire_error(op: &'static str, path: &str, err: WireError, sent: bool) -> FsError {
    let (code, detail) = match status(&err) {
        Some(StatusCode::PermissionDenied) => (FsCode::PermissionDenied, "Permission denied."),
        Some(StatusCode::NoSuchFile) => (FsCode::NotFound, "Remote path not found."),
        Some(StatusCode::OpUnsupported) => (FsCode::Unsupported, "Operation not supported by the SFTP server."),
        _ => (FsCode::Io, "SFTP request failed."),
    };
    let unknown = sent && matches!(status(&err), None | Some(StatusCode::NoConnection | StatusCode::ConnectionLost));
    error(op, path, code, if unknown { FsOutcome::Unknown } else { FsOutcome::Unchanged }, detail)
}

struct Admission<'a> {
    fs: &'a RemoteFs<'a>,
    session: Arc<SshSession>,
    connection_id: String,
    lease: SftpLease,
    op: &'static str,
}

impl Admission<'_> {
    fn recheck(&self) -> Result<(), SessionError> {
        let (session, connection) = self.fs.registry.lease_at(self.fs.terminal_id, self.fs.generation)?;
        if !Arc::ptr_eq(&self.session, &session) || self.connection_id != connection {
            return Err(SessionError::StaleAttempt);
        }
        Ok(())
    }

    async fn request<'a, T: Send + 'static>(
        &'a self,
        path: &str,
        mutation: bool,
        call: impl FnOnce(&'a RawSftpSession) -> BoxFuture<'a, Result<T, WireError>> + Send + 'a,
    ) -> Result<Result<T, WireError>, FsError> {
        let sent = Arc::new(AtomicBool::new(false));
        let marker = sent.clone();
        self.lease.request(|client| Box::pin(async move {
            if mutation {
                self.recheck()?;
                // Once the mutation starts polling there is no reliable send/ack
                // boundary on cancellation. Treat the in-flight request as unknown.
                marker.store(true, Ordering::Relaxed);
            }
            Ok(call(client).await)
        })).await.map_err(|err| {
            let sent = sent.load(Ordering::Relaxed);
            // Cancellation may win before polling the mutation. If there is
            // already a successor, report the request as stale, not in flight.
            let err = if !sent && err == SessionError::Cancelled
                && self.recheck() == Err(SessionError::StaleAttempt)
            {
                SessionError::StaleAttempt
            } else {
                err
            };
            session_error(self.op, path, err, sent)
        })
    }

    async fn read<'a, T: Send + 'static>(
        &'a self,
        path: &str,
        call: impl FnOnce(&'a RawSftpSession) -> BoxFuture<'a, Result<T, WireError>> + Send + 'a,
    ) -> Result<T, FsError> {
        self.request(path, false, call).await?.map_err(|err| wire_error(self.op, path, err, false))
    }

    async fn exists(&self, path: &str) -> Result<bool, FsError> {
        match self.read(path, |c| Box::pin(c.lstat(path))).await {
            Ok(_) => Ok(true),
            Err(e) if e.code == FsCode::NotFound => Ok(false),
            Err(e) => Err(e),
        }
    }

    async fn mutation_result<T>(
        &self,
        path: &str,
        destination: &str,
        result: Result<T, WireError>,
    ) -> Result<T, FsError> {
        let err = match result {
            Ok(value) => return Ok(value),
            Err(err) => err,
        };
        if let WireError::Status(reply) = &err {
            if reply.status_code == StatusCode::Failure {
                // SFTP v3 has no EXISTS status; never parse errors for display.
                let exists = ["file exists", "file already exists", "already exists"]
                    .iter().any(|known| reply.error_message.trim().eq_ignore_ascii_case(known));
                if exists || self.exists(destination).await == Ok(true) {
                    return Err(error(self.op, destination, FsCode::Exists, FsOutcome::Unchanged, "Remote destination already exists."));
                }
            }
        }
        Err(wire_error(self.op, path, err, true))
    }
}

pub struct RemoteFs<'a> {
    registry: &'a SessionRegistry,
    terminal_id: &'a str,
    generation: u64,
}

impl<'a> RemoteFs<'a> {
    pub fn new(registry: &'a SessionRegistry, terminal_id: &'a str, expected_generation: u64) -> Self {
        Self { registry, terminal_id, generation: expected_generation }
    }

    async fn admit(&self, op: &'static str, path: &str) -> Result<Admission<'_>, FsError> {
        let (session, connection_id) = self.registry.lease_at(self.terminal_id, self.generation)
            .map_err(|err| session_error(op, path, err, false))?;
        let lease = session.sftp().await.map_err(|err| session_error(op, path, err, false))?;
        Ok(Admission { fs: self, session, connection_id, lease, op })
    }

    pub async fn list(&self, path: &str) -> Result<RemoteListing, FsError> {
        self.list_bounded(path, MAX_ENTRIES).await
    }

    async fn list_bounded(&self, path: &str, limit: usize) -> Result<RemoteListing, FsError> {
        let op = "list";
        if path != "." {
            validate(op, path, false)?;
        }
        let a = self.admit(op, path).await?;
        let resolved = a.read(path, |c| Box::pin(c.realpath(path))).await?.files.into_iter().next()
            .ok_or_else(|| error(op, path, FsCode::Io, FsOutcome::Unchanged, "No path returned by REALPATH."))?.filename;
        let path = resolved.as_str();
        validate(op, path, false)?;
        let handle = a.read(path, |c| Box::pin(c.opendir(path))).await?.handle;
        let listing = async {
            let mut entries = Vec::new();
            let mut seen = 0;
            loop {
                let batch = match a.request(path, false, |c| Box::pin(c.readdir(handle.as_str()))).await? {
                    Ok(batch) => batch,
                    Err(err) if status(&err) == Some(StatusCode::Eof) => break,
                    Err(err) => return Err(wire_error(op, path, err, false)),
                };
                if batch.files.is_empty() {
                    return Err(error(op, path, FsCode::Io, FsOutcome::Unchanged, "Empty READDIR packet without EOF."));
                }
                seen += batch.files.len();
                if seen > limit {
                    return Err(budget(op, path));
                }
                for file in batch.files {
                    if matches!(file.filename.as_str(), "." | "..") {
                        continue;
                    }
                    let (name, child) = match child_path(path, &file.filename) {
                        Some(child) => {
                            validate(op, &child, false)?;
                            (file.filename, child)
                        }
                        // russh-sftp decodes invalid wire UTF-8 lossily. An empty
                        // path is deliberately non-actionable, never an alias.
                        None => (format!("{} (read-only: invalid name)", file.filename.escape_default()), String::new()),
                    };
                    entries.push(RemoteEntry::new(name, child, file.attrs));
                }
            }
            Ok(entries)
        }.await;
        let closed = a.read(path, |c| Box::pin(c.close(handle))).await;
        let entries = listing?;
        closed?;
        Ok(RemoteListing { path: resolved, entries, session_generation: self.generation })
    }

    pub async fn stat(&self, path: &str) -> Result<RemoteStat, FsError> {
        let op = "stat";
        validate(op, path, false)?;
        let a = self.admit(op, path).await?;
        let attrs = a.read(path, |c| Box::pin(c.lstat(path))).await?.attrs;
        let name = if path == "/" { path } else { path.rsplit('/').next().unwrap_or(path) };
        let entry = RemoteEntry::new(name.into(), path.into(), attrs);
        let link_target = if entry.kind == RemoteKind::Symlink {
            let reply = a.read(path, |c| Box::pin(c.readlink(path))).await?;
            let target = reply.files.into_iter().next().ok_or_else(|| {
                error(op, path, FsCode::Io, FsOutcome::Unchanged, "No target returned by READLINK.")
            })?.filename;
            Some(if target.contains('\u{fffd}') { target.escape_default().to_string() } else { target })
        } else {
            None
        };
        Ok(RemoteStat { entry, link_target })
    }

    pub async fn mkdir(&self, path: &str) -> Result<(), FsError> {
        let op = "mkdir";
        validate(op, path, true)?;
        let a = self.admit(op, path).await?;
        let reply = a.request(path, true, |c| Box::pin(c.mkdir(path, FileAttributes::empty()))).await?;
        a.mutation_result(path, path, reply).await.map(|_| ())
    }

    pub async fn create(&self, path: &str) -> Result<(), FsError> {
        let op = "create";
        validate(op, path, true)?;
        let a = self.admit(op, path).await?;
        let flags = OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE;
        let reply = a.request(path, true, |c| Box::pin(c.open(path, flags, FileAttributes::empty()))).await?;
        let handle = a.mutation_result(path, path, reply).await?.handle;
        // CLOSE itself does not mutate the namespace, but a failure cannot undo
        // the already acknowledged OPEN. Do not retry the exclusive creation.
        match a.request(path, false, |c| Box::pin(c.close(handle))).await {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(err)) => {
                let wire = wire_error(op, path, err, true);
                if wire.outcome == FsOutcome::Unknown { return Err(wire); }
                let mut partial = error(op, path, wire.code, FsOutcome::Partial, "File created but close was refused.");
                partial.completed_paths = Some(vec![path.into()]);
                Err(partial)
            }
            Err(err) => Err(error(op, path, err.code, FsOutcome::Unknown, "")),
        }
    }

    pub async fn rename(&self, path: &str, new_path: &str) -> Result<(), FsError> {
        let op = "rename";
        validate(op, path, true)?;
        validate(op, new_path, true)?;
        let a = self.admit(op, path).await?;
        // Vanilla SFTP v3 RENAME is no-replace. Never use the OpenSSH
        // overwriting extension here, even if advertised.
        if a.exists(new_path).await? {
            return Err(error(op, new_path, FsCode::Exists, FsOutcome::Unchanged, "Remote destination already exists."));
        }
        let reply = a.request(path, true, |c| Box::pin(c.rename(path, new_path))).await?;
        a.mutation_result(path, new_path, reply).await.map(|_| ())
    }
}
