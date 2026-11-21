use super::*;
use crate::ssh::{sftp::{edit::recover, tests::{browser, Tree}}, tests::Fixture};
use std::sync::Mutex;
use tokio::{sync::{mpsc, oneshot, Semaphore}, time::timeout};

const LIMIT: Duration = Duration::from_secs(10);

struct ManualClock(mpsc::UnboundedSender<oneshot::Sender<()>>);
impl PollClock for ManualClock {
    fn wait(&self, period: Duration) -> BoxFuture<'_, ()> {
        assert_eq!(period, Duration::from_millis(750));
        Box::pin(async move {
            let (tick, wait) = oneshot::channel();
            if self.0.send(tick).is_ok() {
                let _ = wait.await;
            } else {
                std::future::pending::<()>().await;
            }
        })
    }
}

struct ClockDriver {
    requests: mpsc::UnboundedReceiver<oneshot::Sender<()>>,
    next: Option<oneshot::Sender<()>>,
}

impl ClockDriver {
    async fn tick(&mut self) {
        let tick = match self.next.take() {
            Some(tick) => tick,
            None => timeout(LIMIT, self.requests.recv()).await.unwrap().unwrap(),
        };
        tick.send(()).unwrap();
        // The poller only requests another interval after finishing this pass.
        self.next = Some(timeout(LIMIT, self.requests.recv()).await.unwrap().unwrap());
    }
}

struct Recorder {
    calls: Mutex<Vec<Vec<u8>>>,
    release_first: Option<Semaphore>,
}

impl Uploader for Recorder {
    async fn upload(&self, job: &EditJob, mut snapshot: EditSnapshot) -> UploadResult {
        let mut bytes = Vec::new();
        snapshot.reader().read_to_end(&mut bytes).unwrap();
        let baseline = Baseline { mtime: 42, size: bytes.len() as u64 };
        let first = {
            let mut calls = self.calls.lock().unwrap();
            calls.push(bytes);
            calls.len() == 1
        };
        if first {
            if let Some(gate) = &self.release_first {
                gate.acquire().await.unwrap().forget();
                // Re-read the same spool after a newer editor save. It must
                // still contain exactly the bytes initially handed to upload.
                use std::io::Seek;
                let reader = snapshot.reader();
                reader.rewind().unwrap();
                let mut same = Vec::new();
                reader.read_to_end(&mut same).unwrap();
                assert_eq!(same, self.calls.lock().unwrap()[0]);
            }
        }
        if job.cancellation().is_cancelled() { UploadResult::Paused } else { UploadResult::Uploaded(baseline) }
    }
}

struct Harness {
    fixture: Fixture,
    _remote: Tree,
    _local: Tree,
    root: PathBuf,
    edits: Arc<EditRegistry>,
    job: Arc<EditJob>,
    path: PathBuf,
    clock: ClockDriver,
    recorder: Arc<Recorder>,
}

impl Harness {
    async fn new(block_first: bool) -> Self {
        let remote = Tree::new();
        let local = Tree::new();
        let root = local.path("edits");
        fs::write(remote.path("a.txt"), b"orig").unwrap();
        let fixture = remote.fixture();
        fixture.connected().await;
        let (tx, requests) = mpsc::unbounded_channel();
        let edits = Arc::new(EditRegistry::new(root.clone(), Arc::new(ManualClock(tx))));
        let job = edits.begin_edit(&browser(&fixture), "/a.txt").await.unwrap();
        let path = job.record().await.local_path;
        let recorder = Arc::new(Recorder { calls: Mutex::new(Vec::new()), release_first: block_first.then(|| Semaphore::new(0)) });
        edits.start(fixture.registry.clone(), recorder.clone());
        Self { fixture, _remote: remote, _local: local, root, edits, job, path, clock: ClockDriver { requests, next: None }, recorder }
    }

    fn calls(&self) -> Vec<Vec<u8>> {
        self.recorder.calls.lock().unwrap().clone()
    }

    async fn wait_for(&self, count: usize, in_flight: bool) {
        timeout(LIMIT, async {
            loop {
                if self.calls().len() == count && self.job.data.lock().await.in_flight == in_flight {
                    return;
                }
                tokio::task::yield_now().await;
            }
        }).await.unwrap();
    }

    fn release(&self) {
        self.recorder.release_first.as_ref().unwrap().add_permits(1);
    }

    async fn finish(self) {
        self.edits.shutdown().await;
        self.fixture.registry.shutdown().await;
    }
}

fn replace(path: &Path, bytes: &[u8]) {
    let temp = path.with_extension("replacement");
    fs::write(&temp, bytes).unwrap();
    fs::rename(temp, path).unwrap();
}

#[tokio::test]
async fn initial_download_does_not_upload() {
    let mut h = Harness::new(false).await;
    for _ in 0..3 { h.clock.tick().await; }
    assert!(h.calls().is_empty());
    assert_eq!(h.job.record().await.last_uploaded_digest, hash_sample(&h.path).unwrap().unwrap().digest);
    h.finish().await;
}

#[tokio::test]
async fn atomic_replace_save_and_same_size_save_each_trigger_exactly_one_upload() {
    let mut h = Harness::new(false).await;
    replace(&h.path, b"first");
    h.clock.tick().await;
    h.clock.tick().await;
    h.wait_for(1, false).await;
    h.clock.tick().await;
    let modified = fs::metadata(&h.path).unwrap().modified().unwrap();
    fs::write(&h.path, b"other").unwrap();
    OpenOptions::new().write(true).open(&h.path).unwrap().set_modified(modified).unwrap();
    h.clock.tick().await;
    h.clock.tick().await;
    h.wait_for(2, false).await;
    h.clock.tick().await;
    h.clock.tick().await;
    assert_eq!(h.calls(), [b"first".to_vec(), b"other".to_vec()]);
    let record = recover(&h.root).unwrap().pop().unwrap();
    assert_eq!(record.baseline, Baseline { mtime: 42, size: 5 });
    assert_eq!(record.last_uploaded_digest, hash_sample(&h.path).unwrap().unwrap().digest);
    h.finish().await;
}

#[tokio::test]
async fn unstable_file_waits_for_two_equal_samples() {
    let mut h = Harness::new(false).await;
    fs::write(&h.path, b"one").unwrap();
    h.clock.tick().await;
    fs::remove_file(&h.path).unwrap();
    h.clock.tick().await;
    fs::write(&h.path, b"one").unwrap();
    h.clock.tick().await;
    assert!(h.calls().is_empty());
    fs::write(&h.path, b"two").unwrap();
    h.clock.tick().await;
    assert!(h.calls().is_empty());
    h.clock.tick().await;
    h.wait_for(1, false).await;
    assert_eq!(h.calls(), [b"two".to_vec()]);
    h.finish().await;
}

#[tokio::test]
async fn rapid_saves_serialize_and_last_snapshot_wins() {
    let mut h = Harness::new(true).await;
    fs::write(&h.path, b"first").unwrap();
    h.clock.tick().await;
    h.clock.tick().await;
    h.wait_for(1, true).await;
    fs::write(&h.path, b"intermediate").unwrap();
    h.clock.tick().await;
    h.clock.tick().await;
    replace(&h.path, b"latest");
    h.clock.tick().await;
    h.clock.tick().await;
    assert_eq!(h.calls(), [b"first".to_vec()]);
    h.release();
    h.wait_for(1, false).await;
    h.clock.tick().await;
    h.clock.tick().await;
    h.wait_for(2, false).await;
    assert_eq!(h.calls(), [b"first".to_vec(), b"latest".to_vec()]);
    h.finish().await;
}

#[tokio::test]
async fn paused_while_disconnected_never_uploads() {
    let mut h = Harness::new(false).await;
    h.fixture.registry.disconnect("tm-a", "test disconnect");
    fs::write(&h.path, b"edit").unwrap();
    for _ in 0..3 { h.clock.tick().await; }
    assert!(h.calls().is_empty());
    assert_eq!(h.job.record().await.state, EditState::Paused);
    h.finish().await;
}

#[tokio::test]
async fn unpolled_save_before_close_survives() {
    let mut h = Harness::new(false).await;
    h.clock.tick().await;
    assert_eq!(h.job.record().await.last_uploaded_digest, hash_sample(&h.path).unwrap().unwrap().digest);
    fs::write(&h.path, b"edit").unwrap(); // same size, no subsequent clock tick
    assert!(h.edits.stop(&h.job).await);
    let recovered = recover(&h.root).unwrap();
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].local_path, h.path);
    assert_eq!(recovered[0].state, EditState::Paused);
    assert_eq!(fs::read(&recovered[0].local_path).unwrap(), b"edit");
    assert!(h.calls().is_empty());
    h.finish().await;
}

#[tokio::test]
async fn atomic_replace_during_cleanup_retains_copy() {
    let h = Harness::new(false).await;
    let path = h.path.clone();
    assert!(h.edits.stop_before(&h.job, Instant::now() + STOP_BUDGET, move || replace(&path, b"edit")).await);
    let recovered = recover(&h.root).unwrap();
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].local_path, h.path);
    assert_eq!(fs::read(&h.path).unwrap(), b"edit");
    assert!(h.calls().is_empty());
    h.finish().await;
}

#[tokio::test]
async fn shutdown_during_upload_retains_copy_and_record() {
    let mut h = Harness::new(true).await;
    fs::write(&h.path, b"edit").unwrap();
    h.clock.tick().await;
    h.clock.tick().await;
    h.wait_for(1, true).await;
    fs::write(&h.path, b"orig").unwrap(); // matches the baseline, but upload is unresolved
    h.edits.shutdown().await;
    assert!(h.job.cancellation().is_cancelled());
    let recovered = recover(&h.root).unwrap();
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].local_path, h.path);
    assert_eq!(recovered[0].state, EditState::Paused);
    assert_eq!(fs::read(&h.path).unwrap(), b"orig");
    h.release();
    h.wait_for(1, false).await;
    h.finish().await;
}

#[tokio::test]
async fn clean_copy_is_removed_on_stop() {
    let h = Harness::new(false).await;
    assert!(!h.edits.stop(&h.job).await);
    assert!(!h.path.exists());
    assert!(!h.path.parent().unwrap().join("job.json").exists());
    assert!(recover(&h.root).unwrap().is_empty());
    assert!(h.calls().is_empty());
    h.finish().await;
}
