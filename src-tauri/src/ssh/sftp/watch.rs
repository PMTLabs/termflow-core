//! One bounded-memory poller for all private editor copies.
use super::{
    edit::{remove_record, write_record, Baseline, EditJob, EditRecord, EditRegistry, EditState, JobData},
    local_target::{ensure_real_dir, is_link},
    upload::SftpUploader,
    BoxFuture, SessionError, SessionRegistry,
};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, Metadata, OpenOptions},
    future::Future,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Arc, Weak},
    time::{Duration, SystemTime},
};
use tauri::{AppHandle, Emitter};
use tokio::time::{timeout_at, Instant};
use uuid::Uuid;

const PERIOD: Duration = Duration::from_millis(750);
const STOP_BUDGET: Duration = Duration::from_secs(2);

pub(crate) trait PollClock: Send + Sync {
    fn wait(&self, period: Duration) -> BoxFuture<'_, ()>;
}

pub(crate) struct TokioClock;
impl PollClock for TokioClock {
    fn wait(&self, period: Duration) -> BoxFuture<'_, ()> {
        Box::pin(tokio::time::sleep(period))
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum UploadResult {
    Uploaded(Baseline),
    Paused,
    Conflict,
    Unsupported,
    Error(&'static str),
}

/// Implement as `async fn upload(&self, job: &EditJob, snapshot: EditSnapshot)
/// -> UploadResult`. The uploader owns remote staging and must recheck the job fence and
/// pinned session before commit. Uploaded means acknowledged with a new baseline.
pub(crate) trait Uploader: Send + Sync + 'static {
    fn upload(&self, job: &EditJob, snapshot: EditSnapshot) -> impl Future<Output = UploadResult> + Send;
}

/// A private spool; the uploader only receives a read-only handle, not an
/// editor pathname to reopen. Drop removes the spool after closing the handle.
pub(crate) struct EditSnapshot {
    path: PathBuf,
    file: Option<File>,
    digest: String,
}

impl EditSnapshot {
    pub(crate) fn reader(&mut self) -> &mut File {
        self.file.as_mut().expect("snapshot has a reader until drop")
    }
}

impl Drop for EditSnapshot {
    fn drop(&mut self) {
        drop(self.file.take());
        if let Err(e) = fs::remove_file(&self.path) {
            log::warn!("Could not remove SSH edit snapshot: {e}");
        }
    }
}

impl EditRegistry {
    /// Call once from the app runtime. The task does not keep the registry alive.
    pub(crate) fn start(self: &Arc<Self>, sessions: Arc<SessionRegistry>, app: AppHandle) {
        let uploader = Arc::new(SftpUploader::new(sessions.clone()));
        self.start_with(sessions, uploader, Some(app));
    }

    pub(super) fn start_with(self: &Arc<Self>, sessions: Arc<SessionRegistry>, uploader: Arc<impl Uploader>, app: Option<AppHandle>) {
        if self.poller_started.swap(true, Ordering::AcqRel) {
            return;
        }
        let weak = Arc::downgrade(self);
        let clock = self.clock.clone();
        let shutdown = self.shutdown.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    biased;
                    _ = shutdown.cancelled() => break,
                    _ = clock.wait(PERIOD) => {},
                }
                let Some(registry) = weak.upgrade() else { break };
                for job in registry.jobs() {
                    if shutdown.is_cancelled() {
                        return;
                    }
                    poll_job(job, &sessions, &uploader, &weak, app.as_ref()).await;
                }
            }
        });
    }

    /// Returns true when the record/copy was retained rather than cleaned up.
    pub(crate) async fn stop(self: &Arc<Self>, job: &Arc<EditJob>) -> bool {
        self.stop_before(job, Instant::now() + STOP_BUDGET, || {}).await
    }

    pub(crate) async fn shutdown(self: &Arc<Self>) {
        let deadline = Instant::now() + STOP_BUDGET;
        for job in self.fence_all() {
            self.stop_before(&job, deadline, || {}).await;
        }
    }

    async fn stop_before(
        self: &Arc<Self>, job: &Arc<EditJob>, deadline: Instant, between_reads: impl FnOnce() + Send + 'static,
    ) -> bool {
        job.fence.cancel();
        let mut data = match timeout_at(deadline, job.data.clone().lock_owned()).await {
            Ok(data) => data,
            // An already-running stop owns the lock and is responsible for the
            // record. No cleanup is started by this timed-out caller.
            Err(_) => return true,
        };
        if let Some(retained) = data.stopped {
            return retained;
        }
        let local = data.record.local_path.clone();
        let mut clean = None;
        let state = if matches!(data.record.state, EditState::Conflict | EditState::Error) {
            data.record.state
        } else if data.in_flight || Instant::now() >= deadline {
            EditState::Paused
        } else {
            let path = local.clone();
            // The worker only reads. If the deadline expires it cannot later
            // delete anything, even if the underlying I/O never cancelled.
            let reads = tokio::task::spawn_blocking(move || {
                let first = hash_sample(&path)?;
                between_reads();
                Ok::<_, io::Error>((first, hash_sample(&path)?))
            });
            match timeout_at(deadline, reads).await {
                Ok(Ok(Ok((Some(first), Some(second))))) if first == second
                    && second.digest == data.record.last_uploaded_digest => {
                    clean = Some(second.stamp);
                    EditState::Paused
                }
                Ok(Ok(Ok(_))) | Err(_) => EditState::Paused,
                Ok(_) => EditState::Error,
            }
        };
        let registry = Arc::downgrade(self);
        let job = job.clone();
        let finish = tokio::task::spawn_blocking(move || {
            let mut retained_state = Some(state);
            if let Some(expected) = clean.filter(|_| Instant::now() < deadline) {
                // Revalidate the pathname against replacement since the second
                // read. An external writer can still race a pathname unlink.
                match current_stamp(&local) {
                    Ok(stamp) if stamp == expected && Instant::now() < deadline => {
                        if fs::remove_file(&local).is_ok() && remove_record(&local).is_ok() {
                            retained_state = None;
                        } else {
                            retained_state = Some(EditState::Error);
                        }
                    }
                    Ok(_) => {},
                    Err(_) => retained_state = Some(EditState::Error),
                }
            }
            if let Some(state) = retained_state {
                data.record.state = state;
                persist(&mut data);
            }
            let retained = retained_state.is_some();
            data.stopped = Some(retained);
            if !data.in_flight {
                if let Some(registry) = registry.upgrade() {
                    registry.forget(&job);
                }
            }
            retained
        });
        // A worker that missed the budget may finish persisting the retained
        // status, but it cannot start deleting a copy after the deadline.
        match timeout_at(deadline, finish).await {
            Ok(Ok(retained)) => retained,
            _ => true,
        }
    }
}

fn connected(job: &EditJob, record: &EditRecord, sessions: &SessionRegistry) -> Result<(), EditState> {
    match sessions.lease_at(&record.terminal_id, record.session_generation) {
        Ok((session, connection)) if Arc::ptr_eq(&session, &job.session) && connection == record.connection_id => Ok(()),
        Ok(_) | Err(SessionError::StaleAttempt) => Err(EditState::Conflict),
        Err(SessionError::NotConnected) => Err(EditState::Paused),
        Err(_) => Err(EditState::Error),
    }
}

pub(super) async fn poll_job(
    job: Arc<EditJob>, sessions: &Arc<SessionRegistry>, uploader: &Arc<impl Uploader>,
    registry: &Weak<EditRegistry>, app: Option<&AppHandle>,
) {
    let can_sample = |data: &JobData| {
        !job.fence.is_cancelled() && !data.in_flight
            && !matches!(data.record.state, EditState::Conflict | EditState::Error)
    };
    let local = {
        let mut data = job.data.lock().await;
        if !can_sample(&data) {
            return;
        }
        if let Err(state) = connected(&job, &data.record, sessions) {
            let changed = data.record.state != state;
            set_state(&mut data, state);
            if changed {
                emit_state(app, &data.record, state_name(state), state_detail(state));
            }
            return;
        }
        set_state(&mut data, EditState::Watching);
        data.record.local_path.clone()
    };
    // Metadata checks bracket every read, but even unchanged metadata can hide
    // same-length writes. Hash registered files only, one blocking worker at a time.
    let path = local.clone();
    let sample = tokio::task::spawn_blocking(move || hash_sample(&path)).await;
    let digest = {
        let mut data = job.data.lock().await;
        if !can_sample(&data) {
            return;
        }
        let sample = match sample {
            Ok(Ok(sample)) => sample,
            _ => {
                set_state(&mut data, EditState::Error);
                return;
            }
        };
        let previous = std::mem::replace(&mut data.candidate, sample.map(|sample| sample.digest));
        match data.candidate.as_ref() {
            Some(digest) if previous.as_ref() == Some(digest) && *digest != data.record.last_uploaded_digest => digest.clone(),
            _ => return,
        }
    };
    let spool = tokio::task::spawn_blocking(move || spool(&local, digest)).await;
    let mut data = job.data.lock().await;
    if !can_sample(&data) {
        return;
    }
    if let Err(state) = connected(&job, &data.record, sessions) {
        set_state(&mut data, state);
        return;
    }
    let snapshot = match spool {
        Ok(Ok(Some(snapshot))) => snapshot,
        Ok(Ok(None)) => {
            data.candidate = None;
            return;
        }
        _ => {
            set_state(&mut data, EditState::Error);
            return;
        }
    };
    if job.fence.is_cancelled() {
        return;
    }
    data.in_flight = true;
    data.candidate = None;
    data.record.state = EditState::Uploading;
    drop(data);
    let uploader = uploader.clone();
    let sessions = sessions.clone();
    let registry = registry.clone();
    let hash = snapshot.digest.clone();
    let app = app.cloned();
    tokio::spawn(async move {
        let record = job.record().await;
        let result = if job.fence.is_cancelled() {
            UploadResult::Paused
        } else {
            match connected(&job, &record, &sessions) {
                Ok(()) => uploader.upload(&job, snapshot).await,
                Err(EditState::Paused) => UploadResult::Paused,
                Err(EditState::Conflict) => UploadResult::Conflict,
                Err(_) => UploadResult::Error("Could not reacquire the SSH session."),
            }
        };
        let mut data = job.data.lock().await;
        data.in_flight = false;
        if let UploadResult::Uploaded(baseline) = result {
            data.record.baseline = baseline;
            data.record.last_uploaded_digest = hash;
            if data.stopped.is_none() {
                data.record.state = EditState::Watching;
            }
            persist(&mut data);
            if data.stopped.is_none() {
                emit_state(app.as_ref(), &data.record, "uploaded", None);
            }
        } else if data.stopped.is_none() {
            let (state, name, detail) = match result {
                UploadResult::Paused => (EditState::Paused, "paused", None),
                UploadResult::Conflict => (EditState::Conflict, "conflict", state_detail(EditState::Conflict)),
                UploadResult::Unsupported => (EditState::Error, "unsupported", Some("The server does not support atomic replacement.")),
                UploadResult::Error(detail) => (EditState::Error, "error", Some(detail)),
                UploadResult::Uploaded(_) => unreachable!(),
            };
            set_state(&mut data, state);
            emit_state(app.as_ref(), &data.record, name, detail);
        }
        if data.stopped.is_some() {
            if let Some(registry) = registry.upgrade() {
                registry.forget(&job);
            }
        }
    });
}

fn state_name(state: EditState) -> &'static str {
    match state {
        EditState::Watching => "watching",
        EditState::Uploading => "uploading",
        EditState::Paused => "paused",
        EditState::Conflict => "conflict",
        EditState::Error => "error",
    }
}

fn state_detail(state: EditState) -> Option<&'static str> {
    match state {
        EditState::Conflict => Some("Reopen to establish a new baseline; changes made on the server are detected by modified time and size."),
        EditState::Error => Some("Could not reacquire the SSH session."),
        _ => None,
    }
}

fn emit_state(app: Option<&AppHandle>, record: &EditRecord, state: &str, detail: Option<&str>) {
    if let Some(app) = app {
        let _ = app.emit("ssh-fs:edit-state", serde_json::json!({
            "terminalId": record.terminal_id,
            "editId": record.edit_id,
            "path": record.remote_path,
            "state": state,
            "sessionGeneration": record.session_generation,
            "localPath": record.local_path,
            "error": detail,
        }));
    }
}

fn set_state(data: &mut JobData, state: EditState) {
    if data.record.state != state {
        data.candidate = None;
        data.record.state = state;
        persist(data);
    }
}

fn persist(data: &mut JobData) {
    if let Err(e) = write_record(&data.record) {
        data.record.state = EditState::Error;
        log::warn!("Could not persist SSH edit recovery state: {e}");
    }
}

#[derive(Debug, PartialEq, Eq)]
struct Stamp {
    len: u64,
    modified: Option<SystemTime>,
    created: Option<SystemTime>,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
    #[cfg(windows)]
    identity: (u32, u32, u32),
}

fn stamp(_file: &File, meta: Metadata) -> io::Result<Stamp> {
    if !meta.is_file() || is_link(&meta) {
        return Err(io::ErrorKind::InvalidData.into());
    }
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    #[cfg(windows)]
    let identity = {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION};
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(_file.as_raw_handle(), &mut info) } == 0 {
            return Err(io::Error::last_os_error());
        }
        (info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow)
    };
    Ok(Stamp {
        len: meta.len(), modified: meta.modified().ok(), created: meta.created().ok(),
        #[cfg(unix)]
        identity: (meta.dev(), meta.ino(), meta.ctime(), meta.ctime_nsec()),
        #[cfg(windows)]
        identity,
    })
}

fn open_local(path: &Path) -> io::Result<(File, Stamp)> {
    let parent = path.parent().ok_or(io::ErrorKind::InvalidInput)?;
    ensure_real_dir(parent).map_err(|_| io::Error::from(io::ErrorKind::PermissionDenied))?;
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_file() || is_link(&meta) {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    let stamp = stamp(&file, file.metadata()?)?;
    Ok((file, stamp))
}

fn current_stamp(path: &Path) -> io::Result<Stamp> {
    open_local(path).map(|(_, stamp)| stamp)
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct Sample {
    pub digest: String,
    stamp: Stamp,
}

pub(super) fn hash_sample(path: &Path) -> io::Result<Option<Sample>> {
    read_sample(path, io::sink())
}

fn read_sample(path: &Path, mut destination: impl Write) -> io::Result<Option<Sample>> {
    let (mut file, before) = match open_local(path) {
        Ok(open) => open,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let mut digest = Sha256::new();
    let mut buf = [0; 32 * 1024];
    let mut count = 0u64;
    loop {
        let size = file.read(&mut buf)?;
        if size == 0 {
            break;
        }
        count += size as u64;
        if count > before.len {
            return Ok(None);
        }
        digest.update(&buf[..size]);
        destination.write_all(&buf[..size])?;
    }
    if count != before.len || stamp(&file, file.metadata()?)? != before {
        return Ok(None);
    }
    match current_stamp(path) {
        Ok(after) if after == before => Ok(Some(Sample { digest: format!("{:x}", digest.finalize()), stamp: after })),
        Ok(_) => Ok(None),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

pub(super) fn spool(path: &Path, digest: String) -> io::Result<Option<EditSnapshot>> {
    let dir = path.parent().ok_or(io::ErrorKind::InvalidInput)?;
    ensure_real_dir(dir).map_err(|_| io::Error::from(io::ErrorKind::PermissionDenied))?;
    let temp = dir.join(format!(".snapshot-{}.tmp", Uuid::new_v4()));
    let mut file = OpenOptions::new().create_new(true).write(true).open(&temp)?;
    let mut snapshot = EditSnapshot { path: temp, file: None, digest };
    let copied = read_sample(path, &mut file);
    drop(file);
    if !copied?.is_some_and(|sample| sample.digest == snapshot.digest) {
        return Ok(None);
    }
    snapshot.file = Some(open_local(&snapshot.path)?.0);
    Ok(Some(snapshot))
}

#[cfg(test)]
#[path = "watch_tests.rs"]
mod tests;
