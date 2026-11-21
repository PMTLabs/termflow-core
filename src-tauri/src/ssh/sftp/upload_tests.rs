use super::*;
use crate::ssh::{
    session::SessionState,
    sftp::{
        edit::{EditRegistry, EditState},
        tests::{browser, Tree},
        watch::{hash_sample, poll_job, spool, TokioClock},
        RemoteFs,
    },
    tests::{wait_state, Fixture},
};
use std::{fs, path::Path, time::Duration};
use tokio::{sync::{oneshot, Semaphore}, time::timeout};

const OLD: &[u8] = b"base";
const EDIT: &[u8] = b"different local bytes";
const PATH: &str = "/a";
const LIMIT: Duration = Duration::from_secs(10);

struct Harness {
    fixture: Fixture,
    remote: Tree,
    _local: Tree,
    edits: Arc<EditRegistry>,
    job: Arc<EditJob>,
    uploader: Arc<SftpUploader>,
}

impl Harness {
    async fn new(advertise: bool) -> Self {
        let remote = Tree::new();
        fs::write(remote.path("a"), OLD).unwrap();
        let fixture = remote.fixture();
        fixture.server.sftp_faults.lock().omit_posix_rename = !advertise;
        fixture.connected().await;
        let fs = browser(&fixture);
        fs.chown(PATH, Some(1234), Some(2345)).await.unwrap();
        fs.chmod(PATH, 0o640).await.unwrap();
        let local = Tree::new();
        let edits = Arc::new(EditRegistry::new(local.path("edits"), Arc::new(TokioClock)));
        let job = edits.begin_edit(&fs, PATH).await.unwrap();
        fs::write(job.record().await.local_path, EDIT).unwrap();
        fixture.server.sftp_faults.lock().requests.clear();
        let uploader = Arc::new(SftpUploader::new(fixture.registry.clone()));
        Self { fixture, remote, _local: local, edits, job, uploader }
    }

    async fn save(&self) -> UploadResult {
        self.uploader.upload(&self.job, snapshot(&self.job.record().await.local_path)).await
    }

    async fn poll(&self) {
        poll_job(self.job.clone(), &self.fixture.registry, &self.uploader, &Arc::downgrade(&self.edits), None).await;
    }

    fn requests(&self) -> Vec<(String, String)> {
        self.fixture.server.sftp_faults.lock().requests.clone()
    }

    fn assert_no_staging(&self) {
        assert!(fs::read_dir(self.remote.root()).unwrap().all(|entry| {
            !entry.unwrap().file_name().to_string_lossy().ends_with(".tmp")
        }));
    }

    async fn assert_retained(&self) {
        assert_eq!(fs::read(self.job.record().await.local_path).unwrap(), EDIT);
        self.assert_no_staging();
    }

    async fn finish(self) {
        self.edits.shutdown().await;
        self.fixture.registry.shutdown().await;
    }
}

fn snapshot(path: &Path) -> EditSnapshot {
    spool(path, hash_sample(path).unwrap().unwrap().digest).unwrap().unwrap()
}

fn make_link(target: &Path, link: &Path) -> bool {
    #[cfg(unix)]
    let result = std::os::unix::fs::symlink(target, link);
    #[cfg(windows)]
    let result = std::os::windows::fs::symlink_file(target, link);
    if let Err(err) = result {
        #[cfg(windows)]
        if err.raw_os_error() == Some(windows_sys::Win32::Foundation::ERROR_PRIVILEGE_NOT_HELD as i32) {
            eprintln!("SKIPPED symlink row: Windows requires symlink creation privilege ({err})");
            return false;
        }
        panic!("Could not create fixture link: {err}");
    }
    true
}

#[tokio::test]
async fn mtime_or_size_change_blocks_upload_and_keeps_local_bytes() {
    for change in ["mtime", "size", "deleted", "symlink", "missing attrs"] {
        let h = Harness::new(true).await;
        let path = h.remote.path("a");
        let initial_time = fs::metadata(&path).unwrap().modified().unwrap();
        match change {
            "mtime" => fs::File::options().write(true).open(&path).unwrap()
                .set_modified(initial_time - Duration::from_secs(10)).unwrap(),
            "size" => {
                fs::write(&path, b"size changed").unwrap();
                fs::File::options().write(true).open(&path).unwrap().set_modified(initial_time).unwrap();
            }
            "deleted" => fs::remove_file(&path).unwrap(),
            "symlink" => {
                let target = h.remote.path("sentinel");
                fs::rename(&path, &target).unwrap();
                if !make_link(&target, &path) {
                    h.finish().await;
                    continue;
                }
            }
            "missing attrs" => h.fixture.server.sftp_faults.lock().omit_attrs = true,
            _ => unreachable!(),
        }
        assert_eq!(h.save().await, UploadResult::Conflict, "{change}");
        assert_eq!(h.requests(), [("lstat".to_owned(), PATH.to_owned())], "{change}");
        h.assert_retained().await;
        h.finish().await;
    }
}

#[tokio::test]
async fn second_stat_catches_change_during_staging() {
    let h = Harness::new(true).await;
    let original = h.remote.path("a");
    h.fixture.server.sftp_faults.lock().before = Some(Box::new(move |op, path| {
        if op == "close" && path.ends_with(".tmp") {
            let file = fs::File::options().write(true).open(&original).unwrap();
            file.set_modified(file.metadata().unwrap().modified().unwrap() - Duration::from_secs(10)).unwrap();
        }
    }));
    assert_eq!(h.save().await, UploadResult::Conflict);
    assert_eq!(fs::read(h.remote.path("a")).unwrap(), OLD);
    assert!(h.requests().iter().any(|(op, _)| op == "write"));
    assert!(!h.requests().iter().any(|(op, _)| op == POSIX_RENAME));
    h.assert_retained().await;
    h.finish().await;
}

#[tokio::test]
async fn remote_write_close_or_rename_error_never_reports_uploaded() {
    for refused in ["write", "close", POSIX_RENAME] {
        let h = Harness::new(true).await;
        h.fixture.server.sftp_faults.lock().deny.push((refused, "*.tmp".into()));
        let before = h.job.record().await;
        h.poll().await;
        h.poll().await;
        timeout(LIMIT, async {
            while h.job.record().await.state != EditState::Error {
                tokio::task::yield_now().await;
            }
        }).await.unwrap();
        let after = h.job.record().await;
        assert_eq!(before.last_uploaded_digest, after.last_uploaded_digest);
        assert_eq!(before.baseline, after.baseline);
        let requests = h.requests();
        assert!(requests.iter().any(|(op, _)| op == refused));
        assert_eq!(requests.iter().any(|(op, _)| op == POSIX_RENAME), refused == POSIX_RENAME);
        assert_eq!(fs::read(h.remote.path("a")).unwrap(), OLD);
        h.assert_retained().await;
        h.poll().await;
        h.poll().await;
        assert_eq!(requests, h.requests());
        h.finish().await;
    }
}

#[tokio::test]
async fn unsupported_atomic_replace_preserves_original() {
    for advertised in [false, true] {
        let h = Harness::new(advertised).await;
        h.fixture.server.sftp_faults.lock().reject_posix_rename = true;
        assert_eq!(h.save().await, UploadResult::Unsupported);
        assert_eq!(fs::read(h.remote.path("a")).unwrap(), OLD);
        assert!(!h.requests().iter().any(|(op, path)| (op == "remove" && path == PATH) || op == "rename"));
        assert_eq!(h.requests().iter().any(|(op, _)| op == "open"), advertised);
        h.assert_retained().await;
        h.finish().await;
    }
}

#[tokio::test]
async fn metadata_preservation_denied_aborts_before_replace() {
    let h = Harness::new(true).await;
    h.fixture.server.sftp_faults.lock().deny.push(("setstat", "*.tmp".into()));
    assert!(matches!(h.save().await, UploadResult::Error(_)));
    assert_eq!(fs::read(h.remote.path("a")).unwrap(), OLD);
    assert!(h.requests().iter().any(|(op, _)| op == "setstat"));
    assert!(!h.requests().iter().any(|(op, _)| op == POSIX_RENAME));
    h.assert_retained().await;
    h.finish().await;
}

#[tokio::test]
async fn successful_upload_replaces_bytes_and_preserves_mode_and_owner() {
    let h = Harness::new(true).await;
    let path = h.job.record().await.local_path;
    let bytes = vec![0xab; 70_000];
    fs::write(&path, &bytes).unwrap();
    let digest = hash_sample(&path).unwrap().unwrap().digest;
    h.poll().await;
    h.poll().await;
    let record = timeout(LIMIT, async {
        loop {
            let record = h.job.record().await;
            if record.last_uploaded_digest == digest { break record; }
            assert_ne!(record.state, EditState::Error);
            tokio::task::yield_now().await;
        }
    }).await.unwrap();
    let attrs = browser(&h.fixture).stat(PATH).await.unwrap().entry;
    assert_eq!(fs::read(h.remote.path("a")).unwrap(), bytes);
    assert_eq!((attrs.mode.unwrap() & 0o7777, attrs.uid, attrs.gid), (0o640, Some(1234), Some(2345)));
    assert_eq!(record.baseline, Baseline { mtime: attrs.mtime.unwrap(), size: bytes.len() as u64 });
    assert!(h.requests().iter().filter(|(op, _)| op == "write").count() >= 3);
    h.assert_no_staging();
    h.finish().await;
}

async fn connect(h: &Harness, terminal: &str) -> u64 {
    let f = &h.fixture;
    let state = wait_state(&f.registry, terminal, false, SessionState::NeedsSecret).await;
    f.registry.submit_secret(terminal, false, Some(state.generation), state.prompt_id.as_deref(), f.server.password.clone(), false).unwrap();
    f.registry.on_launch_lifecycle(terminal, state.generation, 1, crate::ssh::session::LaunchState::Running, Some(format!("pc-{terminal}"))).unwrap();
    wait_state(&f.registry, terminal, false, SessionState::Connected).await.generation
}

#[tokio::test]
async fn reconnect_generation_change_pauses_without_request() {
    let h = Harness::new(true).await;
    h.fixture.registry.disconnect("tm-a", "fixture disconnect");
    assert_eq!(h.save().await, UploadResult::Paused);
    h.fixture.registry.reconnect("tm-a", || true).unwrap();
    assert_ne!(connect(&h, "tm-a").await, h.job.record().await.session_generation);
    assert_eq!(h.save().await, UploadResult::Conflict);
    assert!(h.requests().is_empty());
    h.assert_retained().await;
    h.finish().await;
}

#[tokio::test]
async fn disconnect_and_reconnect_do_not_replay_dirty_edit() {
    let h = Harness::new(true).await;
    h.poll().await; // Dirty candidate observed once but not yet admitted.
    h.fixture.registry.disconnect("tm-a", "fixture disconnect");
    h.poll().await;
    assert_eq!(h.job.record().await.state, EditState::Paused);
    h.fixture.registry.reconnect("tm-a", || true).unwrap();
    connect(&h, "tm-a").await;
    for _ in 0..3 { h.poll().await; }
    assert_eq!(h.job.record().await.state, EditState::Conflict);
    assert!(h.requests().is_empty());
    assert_eq!(fs::read(h.remote.path("a")).unwrap(), OLD);
    h.assert_retained().await;
    h.finish().await;
}

#[tokio::test]
async fn same_path_uploads_from_two_jobs_serialize() {
    let h = Harness::new(true).await;
    h.fixture.registry.open("tm-b", "c-a", false, || true).unwrap();
    let generation = connect(&h, "tm-b").await;
    let second = h.edits.begin_edit(&RemoteFs::new(&h.fixture.registry, "tm-b", generation), PATH).await.unwrap();
    let local = second.record().await.local_path;
    fs::write(&local, b"second edit").unwrap();

    let (at_close, close_seen) = oneshot::channel();
    let at_close = Mutex::new(Some(at_close));
    let gate = Arc::new(Semaphore::new(0));
    {
        let mut faults = h.fixture.server.sftp_faults.lock();
        faults.requests.clear();
        faults.hold_temp_close_ack = Some(gate.clone());
        faults.before = Some(Box::new(move |op, path| {
            if op == "close" && path.ends_with(".tmp") {
                if let Some(tx) = at_close.lock().unwrap().take() { let _ = tx.send(()); }
            }
        }));
    }
    let first = tokio::spawn({
        let job = h.job.clone();
        let uploader = h.uploader.clone();
        async move { uploader.upload(&job, snapshot(&job.record().await.local_path)).await }
    });
    timeout(LIMIT, close_seen).await.unwrap().unwrap();
    let waiting = h.uploader.upload(&second, snapshot(&local));
    tokio::pin!(waiting);
    tokio::select! {
        biased;
        result = &mut waiting => panic!("Second edit escaped serialization: {result:?}"),
        _ = std::future::ready(()) => {},
    }
    // Both uploads hold references to the same per-path lock, but the second
    // has not sent even a preflight lstat while the first awaits CLOSE.
    assert_eq!(h.uploader.paths.lock().unwrap().values().next().unwrap().strong_count(), 2);
    assert_eq!(h.requests().iter().filter(|(op, _)| op == "lstat").count(), 1);
    gate.add_permits(1);
    assert!(matches!(timeout(LIMIT, first).await.unwrap().unwrap(), UploadResult::Uploaded(_)));
    assert_eq!(timeout(LIMIT, &mut waiting).await.unwrap(), UploadResult::Conflict);
    assert_eq!(h.requests().iter().filter(|(op, _)| op == "open").count(), 1);
    assert_eq!(fs::read(h.remote.path("a")).unwrap(), EDIT);
    assert_eq!(fs::read(&local).unwrap(), b"second edit");
    h.assert_no_staging();
    // waiting borrows the uploader until the pinned future is dropped.
    h.edits.shutdown().await;
    h.fixture.registry.shutdown().await;
}
