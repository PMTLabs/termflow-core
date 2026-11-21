//! Private editor copies and their crash-recovery records.
use super::{
    download::{check_remote_parents, transfer_file},
    error,
    local_target::{ensure_real_dir, is_link, validate_local_name},
    session_error, validate,
    watch::{hash_sample, PollClock},
    Admission, FileTarget, FsCode, FsError, FsOutcome, RemoteFs,
};
use crate::ssh::session::SshSession;
use russh_sftp::protocol::{FileAttributes, FileType};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::{self, DirBuilder, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::Manager;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const OP: &str = "edit";
const RECORD: &str = "job.json";

pub(crate) fn edit_root(app: &tauri::AppHandle) -> tauri::Result<PathBuf> {
    // Match history_flush's per-user app data and dev/profile isolation.
    Ok(app.path().app_data_dir()?.join(crate::app_config::dev_file("ssh-edits")))
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct Baseline {
    pub mtime: u32,
    pub size: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EditState {
    Watching,
    Uploading,
    Paused,
    Conflict,
    Error,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EditRecord {
    pub edit_id: Uuid,
    pub terminal_id: String,
    pub connection_id: String,
    pub session_generation: u64,
    pub remote_path: String,
    pub local_path: PathBuf,
    pub baseline: Baseline,
    pub last_uploaded_digest: String,
    pub state: EditState,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditNotice {
    pub terminal_id: String,
    pub edit_id: Uuid,
    pub path: String,
    pub state: &'static str,
    pub session_generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_path: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<&'static str>,
}

impl EditNotice {
    pub(super) fn current(record: &EditRecord, error: Option<&'static str>) -> Self {
        Self {
            terminal_id: record.terminal_id.clone(), edit_id: record.edit_id,
            path: record.remote_path.clone(), state: super::watch::state_name(record.state),
            session_generation: record.session_generation,
            local_path: Some(record.local_path.clone()), error,
        }
    }
}

/// Sinks may be called under job locks; they must not reenter the registry.
pub(crate) trait EditEventSink: Send + Sync {
    fn emit(&self, notice: EditNotice);
}

pub(crate) struct AppEditEvents(pub tauri::AppHandle);
impl EditEventSink for AppEditEvents {
    fn emit(&self, notice: EditNotice) {
        use tauri::Emitter;
        let _ = self.0.emit("ssh-fs:edit-state", notice);
    }
}

#[cfg(test)]
struct NoEvents;
#[cfg(test)]
impl EditEventSink for NoEvents {
    fn emit(&self, _: EditNotice) {}
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditStatus {
    #[serde(flatten)]
    pub notice: EditNotice,
    pub retained: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditStop {
    pub retained: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_path: Option<PathBuf>,
}

pub(crate) struct EditJob {
    pub(super) edit_id: Uuid,
    pub(super) generation: u64,
    local_path: PathBuf,
    pub(super) launching: tokio::sync::Mutex<()>,
    pub(super) data: Arc<tokio::sync::Mutex<JobData>>,
    pub(super) fence: CancellationToken,
    pub(super) session: Arc<SshSession>,
    pub(super) original_attrs: FileAttributes,
}

impl EditJob {
    pub(crate) async fn record(&self) -> EditRecord {
        self.data.lock().await.record.clone()
    }

    /// Checked alongside the pinned session before remote writes and commit.
    pub(crate) fn cancellation(&self) -> &CancellationToken {
        &self.fence
    }
}

#[derive(Debug)]
pub(super) struct JobData {
    pub record: EditRecord,
    pub candidate: Option<String>,
    pub in_flight: bool,
    // Terminal stop decision: later calls must not retry deletion of a retained copy.
    pub stopped: Option<bool>, // true = retained
}

type Key = (String, String);

pub struct EditRegistry {
    root: PathBuf,
    // Serialize baseline creation, not polling or shutdown. Recheck the shutdown
    // fence when publishing so a download underway cannot register late.
    opening: tokio::sync::Mutex<()>,
    jobs: Mutex<HashMap<Key, Arc<EditJob>>>,
    pub(super) retained: Mutex<HashMap<Uuid, EditNotice>>,
    pub(super) sink: Arc<dyn EditEventSink>,
    pub(super) shutdown: CancellationToken,
    pub(super) clock: Arc<dyn PollClock>,
    pub(super) poller_started: std::sync::atomic::AtomicBool,
}

impl EditRegistry {
    #[cfg(test)]
    pub(crate) fn new(root: PathBuf, clock: Arc<dyn PollClock>) -> Self {
        Self::with_sink(root, clock, Arc::new(NoEvents))
    }

    pub(crate) fn with_sink(root: PathBuf, clock: Arc<dyn PollClock>, sink: Arc<dyn EditEventSink>) -> Self {
        Self {
            root,
            opening: Default::default(),
            jobs: Default::default(),
            retained: Default::default(),
            sink,
            shutdown: CancellationToken::new(),
            clock,
            poller_started: false.into(),
        }
    }

    pub(crate) async fn begin_edit(&self, fs: &RemoteFs<'_>, remote_path: &str) -> Result<Arc<EditJob>, FsError> {
        validate(OP, remote_path, true)?;
        let key = (fs.terminal_id.to_owned(), remote_path.to_owned());
        let _opening = self.opening.lock().await;
        self.check_open(remote_path)?;
        if let Some(job) = self.jobs.lock().unwrap().get(&key).cloned() {
            // A stale IPC call must not obtain an edit belonging to a successor.
            fs.registry.lease_at(fs.terminal_id, fs.generation)
                .map_err(|e| session_error(OP, remote_path, e, false))?;
            if job.generation != fs.generation || job.fence.is_cancelled() {
                return Err(error(OP, remote_path, FsCode::Conflict, FsOutcome::Unchanged,
                    "The previous edit is still stopping."));
            }
            return Ok(job);
        }

        let a = fs.admit(OP, remote_path).await?;
        check_remote_parents(&a, remote_path, &self.shutdown).await?;
        let (mut before, _) = baseline(&a, remote_path).await?;
        let root = private_root(&self.root).map_err(|_| local_error(remote_path))?;
        let edit_id = Uuid::new_v4();
        let mut dir = PendingDir::new(root.join(edit_id.to_string())).map_err(|_| local_error(remote_path))?;
        let local_path = dir.0.as_ref().unwrap().join(local_name(remote_path));
        for attempt in 0..2 {
            if attempt != 0 {
                check_remote_parents(&a, remote_path, &self.shutdown).await?;
                (before, _) = baseline(&a, remote_path).await.map_err(|err| {
                    if snapshot_changed(&err) { torn(remote_path) } else { err }
                })?;
            }
            let download = transfer_file(&a, remote_path, FileTarget::no_replace(local_path.clone()), &self.shutdown, || {}).await;
            let stable = match download {
                Ok(download) => match baseline(&a, remote_path).await {
                    Ok((after, attrs)) => (before == after && download.bytes_written == before.size).then_some(attrs),
                    Err(err) if snapshot_changed(&err) => None,
                    Err(err) => return Err(err),
                },
                Err(err) if err.code == FsCode::NotFound => None,
                Err(err) => return Err(err),
            };
            let Some(original_attrs) = stable else {
                if attempt == 0 {
                    match fs::remove_file(&local_path) {
                        Ok(()) => {},
                        Err(e) if e.kind() == io::ErrorKind::NotFound => {},
                        Err(_) => return Err(local_error(remote_path)),
                    }
                    continue;
                }
                return Err(torn(remote_path));
            };
            let path = local_path.clone();
            let digest = tokio::task::spawn_blocking(move || hash_sample(&path)).await
                .ok().and_then(Result::ok).flatten().ok_or_else(|| local_error(remote_path))?.digest;
            let record = EditRecord {
                edit_id, terminal_id: key.0.clone(), connection_id: a.connection_id.clone(),
                session_generation: fs.generation, remote_path: key.1.clone(), local_path,
                baseline: before, last_uploaded_digest: digest, state: EditState::Watching,
            };
            write_record(&record).map_err(|_| local_error(remote_path))?;
            let job = Arc::new(EditJob {
                edit_id,
                generation: fs.generation,
                local_path: record.local_path.clone(),
                launching: Default::default(),
                data: Arc::new(tokio::sync::Mutex::new(JobData { record: record.clone(), candidate: None, in_flight: false, stopped: None })),
                fence: CancellationToken::new(),
                session: a.session.clone(),
                original_attrs,
            });
            let mut jobs = self.jobs.lock().unwrap();
            self.check_open(remote_path)?;
            a.recheck().map_err(|e| session_error(OP, remote_path, e, false))?;
            jobs.insert(key, job.clone());
            dir.0.take();
            self.sink.emit(EditNotice::current(&record, None));
            return Ok(job);
        }
        unreachable!("each edit download either succeeds or returns on the second attempt")
    }

    pub(crate) fn load_recovered(&self) -> io::Result<()> {
        self.retained.lock().unwrap().extend(recover(&self.root)?.into_iter().map(|record| {
            (record.edit_id, EditNotice::current(&record, None))
        }));
        Ok(())
    }

    pub(crate) async fn list(&self, terminal: &str, path: &str) -> Result<Vec<EditStatus>, FsError> {
        if path != "." { validate("editList", path, true)?; }
        let applies = |notice: &EditNotice| notice.terminal_id == terminal && (path == "." || notice.path == path);
        let jobs: Vec<_> = self.jobs.lock().unwrap().iter().filter(|((id, p), _)| {
            id == terminal && (path == "." || p == path)
        }).map(|(_, job)| job.clone()).collect();
        let mut statuses = HashMap::new();
        for job in jobs {
            let data = job.data.lock().await;
            if data.stopped.is_none() {
                let notice = EditNotice::current(&data.record, None);
                statuses.insert(notice.edit_id, EditStatus { notice, retained: false });
            }
        }
        for notice in self.retained.lock().unwrap().values().filter(|n| applies(n)) {
            statuses.insert(notice.edit_id, EditStatus { notice: notice.clone(), retained: true });
        }
        let mut result: Vec<_> = statuses.into_values().collect();
        result.sort_by(|a, b| (&a.notice.path, a.notice.edit_id).cmp(&(&b.notice.path, b.notice.edit_id)));
        Ok(result)
    }

    pub(crate) async fn stop_by_id(self: &Arc<Self>, terminal: &str, path: &str, id: Uuid) -> Result<EditStop, FsError> {
        validate("editStop", path, true)?;
        let job = self.jobs.lock().unwrap().get(&(terminal.to_owned(), path.to_owned()))
            .filter(|job| job.edit_id == id).cloned();
        if let Some(job) = job {
            let retained = self.stop(&job).await;
            return Ok(EditStop { retained, local_path: retained.then(|| job.local_path.clone()) });
        }
        let local_path = self.retained.lock().unwrap().get(&id)
            .filter(|notice| notice.terminal_id == terminal && notice.path == path)
            .and_then(|notice| notice.local_path.clone());
        Ok(EditStop { retained: local_path.is_some(), local_path })
    }

    fn check_open(&self, path: &str) -> Result<(), FsError> {
        if self.shutdown.is_cancelled() {
            return Err(error(OP, path, FsCode::Cancelled, FsOutcome::Unchanged, "Edit registry is shutting down."));
        }
        Ok(())
    }

    pub(super) fn jobs(&self) -> Vec<Arc<EditJob>> {
        self.jobs.lock().unwrap().values().cloned().collect()
    }

    pub(super) fn fence_terminal(&self, terminal: &str, generation: u64) -> Vec<Arc<EditJob>> {
        self.jobs.lock().unwrap().iter().filter_map(|((id, _), job)| {
            if id != terminal || job.generation != generation { return None; }
            job.fence.cancel();
            Some(job.clone())
        }).collect()
    }

    pub(super) fn fence_all(&self) -> Vec<Arc<EditJob>> {
        let jobs = self.jobs.lock().unwrap();
        self.shutdown.cancel();
        for job in jobs.values() {
            job.fence.cancel();
        }
        jobs.values().cloned().collect()
    }

    pub(super) fn forget(&self, job: &Arc<EditJob>) {
        self.jobs.lock().unwrap().retain(|_, current| !Arc::ptr_eq(current, job));
    }
}

async fn baseline(a: &Admission<'_>, path: &str) -> Result<(Baseline, FileAttributes), FsError> {
    let attrs = a.read(path, |c| Box::pin(c.lstat(path))).await?.attrs;
    if attrs.file_type() != FileType::File {
        return Err(error(OP, path, FsCode::Unsupported, FsOutcome::Unchanged, "Only regular remote files can be edited."));
    }
    match (attrs.mtime, attrs.size) {
        (Some(mtime), Some(size)) => Ok((Baseline { mtime, size }, attrs)),
        _ => Err(error(OP, path, FsCode::Unsupported, FsOutcome::Unchanged,
            "editing needs modified time and size; Download still works")),
    }
}

fn snapshot_changed(err: &FsError) -> bool {
    matches!(err.code, FsCode::NotFound | FsCode::Unsupported)
}

fn torn(path: &str) -> FsError {
    error(OP, path, FsCode::Conflict, FsOutcome::Unchanged,
        "Could not establish a stable remote file after retrying the download.")
}

fn local_name(path: &str) -> String {
    let leaf = path.rsplit('/').next().unwrap_or_default();
    let valid = |name: &str| validate_local_name(name).is_ok() && !name.eq_ignore_ascii_case(RECORD);
    if valid(leaf) {
        return leaf.into();
    }
    if let Some((_, ext)) = leaf.rsplit_once('.') {
        let fallback = format!("file.{ext}");
        if valid(&fallback) {
            return fallback;
        }
    }
    "file".into()
}

fn local_error(path: &str) -> FsError {
    error(OP, path, FsCode::Io, FsOutcome::Unchanged, "Could not stage a private editor copy.")
}

fn private_builder() -> DirBuilder {
    let mut builder = DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    // Windows inherits the user-only ACL from the app's per-user data dir.
    builder.recursive(false);
    builder
}

fn private_root(root: &Path) -> io::Result<PathBuf> {
    let parent = root.parent().ok_or(io::ErrorKind::InvalidInput)?;
    fs::create_dir_all(parent)?;
    let root = parent.canonicalize()?.join(root.file_name().ok_or(io::ErrorKind::InvalidInput)?);
    match private_builder().create(&root) {
        Ok(()) => {},
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {},
        Err(e) => return Err(e),
    }
    ensure_real_dir(&root).map_err(|_| io::Error::from(io::ErrorKind::PermissionDenied))?;
    Ok(root)
}

struct PendingDir(Option<PathBuf>);
impl PendingDir {
    fn new(path: PathBuf) -> io::Result<Self> {
        private_builder().create(&path)?;
        Ok(Self(Some(path)))
    }
}
impl Drop for PendingDir {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            if let Err(e) = fs::remove_dir_all(path) {
                log::warn!("Could not discard unfinished SSH edit staging: {e}");
            }
        }
    }
}

pub(super) fn write_record(record: &EditRecord) -> io::Result<()> {
    let dir = record.local_path.parent().ok_or(io::ErrorKind::InvalidInput)?;
    ensure_real_dir(dir).map_err(|_| io::Error::from(io::ErrorKind::PermissionDenied))?;
    let temp = dir.join(format!(".record-{}.tmp", Uuid::new_v4()));
    let mut file = OpenOptions::new().create_new(true).write(true).open(&temp)?;
    let result = (|| {
        serde_json::to_writer(&mut file, record)?;
        file.flush()?;
        file.sync_all()
    })();
    drop(file);
    let result = result.and_then(|()| fs::rename(&temp, dir.join(RECORD)));
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

pub(super) fn remove_record(local: &Path) -> io::Result<()> {
    let dir = local.parent().ok_or(io::ErrorKind::InvalidInput)?;
    fs::remove_file(dir.join(RECORD))?;
    // Never recursively delete an editor directory with user-created side files.
    let _ = fs::remove_dir(dir);
    Ok(())
}

/// Scan only edit-owned directories. Returned records are retained copies, not
/// jobs to resume. Damaged or unreadable records are left alone.
pub(crate) fn recover(root: &Path) -> io::Result<Vec<EditRecord>> {
    match fs::symlink_metadata(root) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Ok(meta) if meta.is_dir() && !is_link(&meta) => {},
        Ok(_) => return Err(io::ErrorKind::PermissionDenied.into()),
        Err(e) => return Err(e),
    }
    let root = root.canonicalize()?;
    let mut retained = Vec::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let dir = entry.path();
        let Some(id) = entry.file_name().to_str().and_then(|name| Uuid::parse_str(name).ok()) else { continue };
        if ensure_real_dir(&dir).is_err() {
            continue;
        }
        let path = dir.join(RECORD);
        if !fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_file() && !is_link(&meta)) {
            continue;
        }
        let parsed = fs::File::open(path).map(io::BufReader::new).and_then(|r| {
            serde_json::from_reader::<_, EditRecord>(r).map_err(io::Error::from)
        });
        let mut record = match parsed {
            Ok(record) if record.edit_id == id && record.local_path.parent() == Some(dir.as_path())
                && record.local_path.file_name().and_then(|name| name.to_str()).is_some_and(|name| local_name(name) == name) => record,
            _ => {
                log::warn!("Invalid SSH edit recovery record in {}", dir.display());
                continue;
            }
        };
        match fs::symlink_metadata(&record.local_path) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                if let Err(e) = remove_record(&record.local_path) {
                    log::warn!("Could not remove stale SSH edit record: {e}");
                }
                continue;
            }
            Ok(meta) if meta.is_file() && !is_link(&meta) => {},
            _ => record.state = EditState::Error,
        }
        if matches!(record.state, EditState::Watching | EditState::Uploading) {
            record.state = EditState::Paused;
        }
        retained.push(record);
    }
    Ok(retained)
}

#[cfg(test)]
#[path = "edit_tests.rs"]
mod tests;
