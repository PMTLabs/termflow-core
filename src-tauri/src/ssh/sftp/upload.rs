//! Guarded, acknowledged write-back of immutable editor snapshots.
use super::{
    edit::{Baseline, EditJob, EditRecord},
    status,
    watch::{EditSnapshot, UploadResult, Uploader},
    BoxFuture, RawSftpSession, SessionError, SessionRegistry, SftpLease, WireError,
};
use russh_sftp::protocol::{FileAttributes, OpenFlags, Packet, StatusCode};
use std::{collections::HashMap, sync::{Arc, Mutex, Weak}};
use tokio::{io::AsyncReadExt, sync::Mutex as AsyncMutex};
use uuid::Uuid;

const POSIX_RENAME: &str = "posix-rename@openssh.com";
const UNKNOWN: &str = "Remote upload outcome unknown; reconnect and refresh. The local copy was retained.";
const REQUEST_FAILED: &str = "Remote upload request failed. The local copy was retained.";

type PathLocks = HashMap<(String, String), Weak<AsyncMutex<()>>>;

pub(super) struct SftpUploader {
    sessions: Arc<SessionRegistry>,
    paths: Mutex<PathLocks>,
}

impl SftpUploader {
    pub(super) fn new(sessions: Arc<SessionRegistry>) -> Self {
        Self { sessions, paths: Mutex::default() }
    }

    fn path_lock(&self, record: &EditRecord) -> Arc<AsyncMutex<()>> {
        let mut paths = self.paths.lock().unwrap();
        paths.retain(|_, lock| lock.strong_count() != 0);
        let entry = paths.entry((record.connection_id.clone(), record.remote_path.clone())).or_default();
        if let Some(lock) = entry.upgrade() {
            return lock;
        }
        let lock = Arc::new(AsyncMutex::new(()));
        *entry = Arc::downgrade(&lock);
        lock
    }

    /// SFTP has no compare-and-swap between the final lstat and rename:
    /// changes made on the server are detected by modified time and size.
    async fn save(&self, job: &EditJob, mut snapshot: EditSnapshot) -> Result<Baseline, UploadResult> {
        let record = job.record().await;
        let lock = self.path_lock(&record);
        let _guard = tokio::select! {
            biased;
            _ = job.cancellation().cancelled() => return Err(UploadResult::Paused),
            guard = lock.lock() => guard,
        };
        let pinned = Pinned { sessions: &self.sessions, job, record: &record };
        pinned.check(false)?;
        let lease = job.session.sftp().await.map_err(|_| {
            pinned.check(false).err().unwrap_or(UploadResult::Error(REQUEST_FAILED))
        })?;
        pinned.check(false)?;
        let remote = Upload { pinned, lease, staged: false };
        remote.check_original().await?;
        if !remote.lease.supports_posix_rename() {
            return Err(UploadResult::Unsupported);
        }
        let path = &record.remote_path;
        let (dir, name) = path.rsplit_once('/').ok_or(UploadResult::Error(REQUEST_FAILED))?;
        let temp = format!("{dir}/.{name}.termflow-{}.tmp", Uuid::new_v4());
        let payload = rename_payload(&temp, path)?;
        let input = snapshot.reader().try_clone().map_err(|_| UploadResult::Error("Could not read the local snapshot."))?;
        let mut input = tokio::fs::File::from_std(input);

        let flags = OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE;
        let mut initial = FileAttributes::empty();
        initial.permissions = Some(0o600);
        let handle = match remote.call(Request::Open, |c| Box::pin(c.open(temp.as_str(), flags, initial))).await {
            Ok(handle) => handle.handle,
            Err(e) => {
                if matches!(e, UploadResult::Error(UNKNOWN)) {
                    remote.cleanup(&temp).await;
                }
                return Err(e);
            }
        };
        let remote = Upload { staged: true, ..remote };
        let result = async {
            let written = remote.write_snapshot(&handle, &mut input).await;
            // Close on the pinned lease even after an aborted write or editor stop.
            let closed = remote.lease.request(|c| Box::pin(async move { Ok(c.close(handle).await) })).await;
            let closed = remote.reply(Request::Normal, closed);
            // A transport failure in CLOSE still makes the mutation outcome unknown.
            if matches!(closed, Err(UploadResult::Error(UNKNOWN))) {
                return Err(UploadResult::Error(UNKNOWN));
            }
            written?;
            closed?;

            remote.check_parents(&temp).await?;
            let attrs = remote.call(Request::Normal, |c| Box::pin(c.lstat(temp.as_str()))).await?.attrs;
            if !regular(&attrs) {
                return Err(UploadResult::Conflict);
            }
            let original = &job.original_attrs;
            // SFTP v3 carries uid/gid as a pair. Never send a fabricated owner.
            if let Some((uid, gid)) = original.uid.zip(original.gid) {
                let mut owner = FileAttributes::empty();
                owner.uid = Some(uid);
                owner.gid = Some(gid);
                remote.call(Request::Normal, |c| Box::pin(c.setstat(temp.as_str(), owner))).await?;
            }
            // chown can clear set-ID bits; restore mode last.
            if let Some(mode) = original.permissions {
                let mut permissions = FileAttributes::empty();
                permissions.permissions = Some(mode & 0o7777);
                remote.call(Request::Normal, |c| Box::pin(c.setstat(temp.as_str(), permissions))).await?;
            }
            remote.check_original().await?;
            remote.call(Request::Rename, |c| Box::pin(posix_rename(c, payload))).await
        }.await;
        if let Err(err) = result {
            remote.cleanup(&temp).await;
            return Err(err);
        }
        // The rename was acknowledged; the temp name no longer belongs to us.
        let attrs = remote.call(Request::Normal, |c| Box::pin(c.lstat(path.as_str()))).await
            .map_err(|e| if matches!(e, UploadResult::Error(UNKNOWN)) { e } else {
                UploadResult::Error("Remote replacement was acknowledged, but its new baseline could not be confirmed.")
            })?.attrs;
        baseline(&attrs).ok_or(UploadResult::Error("Remote replacement was acknowledged, but its new baseline is unavailable."))
    }
}

impl Uploader for SftpUploader {
    async fn upload(&self, job: &EditJob, snapshot: EditSnapshot) -> UploadResult {
        match self.save(job, snapshot).await {
            Ok(baseline) => UploadResult::Uploaded(baseline),
            Err(result) => result,
        }
    }
}

struct Pinned<'a> {
    sessions: &'a SessionRegistry,
    job: &'a EditJob,
    record: &'a EditRecord,
}

impl Pinned<'_> {
    fn check(&self, staged: bool) -> Result<(), UploadResult> {
        let r = self.record;
        match self.sessions.lease_at(&r.terminal_id, r.session_generation) {
            Ok((session, id)) if Arc::ptr_eq(&session, &self.job.session) && id == r.connection_id => {}
            Ok(_) | Err(SessionError::StaleAttempt) => return Err(UploadResult::Conflict),
            Err(SessionError::NotConnected) if !staged => return Err(UploadResult::Paused),
            Err(_) => return Err(UploadResult::Error(if staged { UNKNOWN } else { REQUEST_FAILED })),
        }
        if self.job.cancellation().is_cancelled() {
            return Err(UploadResult::Paused);
        }
        Ok(())
    }
}

struct Upload<'a> {
    pinned: Pinned<'a>,
    lease: SftpLease,
    staged: bool,
}

#[derive(Clone, Copy)]
enum Request { Stat, Open, Normal, Rename }

impl Upload<'_> {
    async fn call<'a, T: Send + 'static>(
        &'a self,
        kind: Request,
        call: impl FnOnce(&'a RawSftpSession) -> BoxFuture<'a, Result<T, WireError>> + Send + 'a,
    ) -> Result<T, UploadResult> {
        self.pinned.check(self.staged)?;
        let reply = self.lease.request(|c| Box::pin(async move {
            // Recheck at submission, including the final atomic rename.
            Ok(match self.pinned.check(self.staged) {
                Ok(()) => Ok(call(c).await),
                Err(e) => Err(e),
            })
        })).await;
        match reply {
            Ok(checked) => self.reply(kind, Ok(checked?)),
            Err(err) => self.reply(kind, Err(err)),
        }
    }

    fn reply<T>(&self, kind: Request, reply: Result<Result<T, WireError>, SessionError>) -> Result<T, UploadResult> {
        let unknown = self.staged || matches!(kind, Request::Open);
        match reply {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(err)) => match status(&err) {
                Some(StatusCode::NoSuchFile) if matches!(kind, Request::Stat) => Err(UploadResult::Conflict),
                Some(StatusCode::OpUnsupported) if matches!(kind, Request::Rename) => Err(UploadResult::Unsupported),
                Some(StatusCode::PermissionDenied) => Err(UploadResult::Error("Permission denied during remote upload. The local copy was retained.")),
                None | Some(StatusCode::NoConnection | StatusCode::ConnectionLost) if unknown => Err(UploadResult::Error(UNKNOWN)),
                _ => Err(UploadResult::Error(REQUEST_FAILED)),
            },
            Err(_) if unknown => Err(UploadResult::Error(UNKNOWN)),
            Err(_) => Err(self.pinned.check(false).err().unwrap_or(UploadResult::Error(REQUEST_FAILED))),
        }
    }

    async fn check_parents(&self, path: &str) -> Result<(), UploadResult> {
        for (end, _) in path.match_indices('/').skip(1) {
            let parent = &path[..end];
            let attrs = self.call(Request::Stat, |c| Box::pin(c.lstat(parent))).await?.attrs;
            if attrs.permissions.map(|mode| mode & 0o170000) != Some(0o040000) {
                return Err(UploadResult::Conflict);
            }
        }
        Ok(())
    }

    async fn check_original(&self) -> Result<(), UploadResult> {
        let path = self.pinned.record.remote_path.as_str();
        self.check_parents(path).await?;
        let attrs = self.call(Request::Stat, |c| Box::pin(c.lstat(path))).await?.attrs;
        if baseline(&attrs) != Some(self.pinned.record.baseline) {
            return Err(UploadResult::Conflict);
        }
        Ok(())
    }

    async fn write_snapshot(&self, handle: &str, input: &mut tokio::fs::File) -> Result<(), UploadResult> {
        let mut buf = vec![0; 32 * 1024];
        let mut offset = 0;
        loop {
            let count = input.read(&mut buf).await.map_err(|_| UploadResult::Error("Could not read the local snapshot."))?;
            if count == 0 {
                return Ok(());
            }
            let chunk = buf[..count].to_vec();
            self.call(Request::Normal, |c| Box::pin(c.write(handle, offset, chunk))).await?;
            offset += count as u64;
        }
    }

    async fn cleanup(&self, temp: &str) {
        // Only the old lease is eligible for cleanup. Never reconnect to do it.
        match self.lease.request(|c| Box::pin(async move {
            for (end, _) in temp.match_indices('/').skip(1) {
                match c.lstat(&temp[..end]).await {
                    Ok(attrs) if attrs.attrs.permissions.map(|mode| mode & 0o170000) == Some(0o040000) => {},
                    _ => return Ok(Err(WireError::UnexpectedPacket)),
                }
            }
            Ok(c.remove(temp).await)
        })).await {
            Ok(Ok(_)) => {},
            Ok(Err(e)) if status(&e) == Some(StatusCode::NoSuchFile) => {},
            _ => log::warn!("Could not remove SSH edit staging file {temp}"),
        }
    }
}

fn regular(attrs: &FileAttributes) -> bool {
    attrs.permissions.map(|mode| mode & 0o170000) == Some(0o100000)
}

fn baseline(attrs: &FileAttributes) -> Option<Baseline> {
    if !regular(attrs) {
        return None;
    }
    Some(Baseline { mtime: attrs.mtime?, size: attrs.size? })
}

fn rename_payload(old: &str, new: &str) -> Result<Vec<u8>, UploadResult> {
    // russh-sftp emits EXTENDED's data verbatim; the two SSH strings own
    // their u32 big-endian byte lengths, with no enclosing data length.
    let mut data = Vec::new();
    for path in [old, new] {
        let len = u32::try_from(path.len()).map_err(|_| UploadResult::Error(REQUEST_FAILED))?;
        data.extend_from_slice(&len.to_be_bytes());
        data.extend_from_slice(path.as_bytes());
    }
    Ok(data)
}

async fn posix_rename(client: &RawSftpSession, payload: Vec<u8>) -> Result<(), WireError> {
    match client.extended(POSIX_RENAME, payload).await? {
        Packet::Status(reply) if reply.status_code == StatusCode::Ok => Ok(()),
        Packet::Status(reply) => Err(WireError::Status(reply)),
        _ => Err(WireError::UnexpectedPacket),
    }
}

#[cfg(test)]
#[path = "upload_tests.rs"]
mod tests;
