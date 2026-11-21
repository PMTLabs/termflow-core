use super::*;
use crate::ssh::sftp::{tests::{browser, Tree}, watch::TokioClock};
use std::sync::atomic::{AtomicUsize, Ordering};

#[tokio::test]
async fn missing_baseline_attrs_disables_edit() {
    let remote = Tree::new();
    let local = Tree::new();
    fs::write(remote.path("a"), b"original").unwrap();
    let f = remote.fixture();
    f.connected().await;
    f.server.sftp_faults.lock().omit_attrs = true;
    let root = local.path("edits");
    let registry = EditRegistry::new(root.clone(), Arc::new(TokioClock));
    let err = registry.begin_edit(&browser(&f), "/a").await.err().unwrap();
    assert_eq!(err.code, FsCode::Unsupported);
    assert!(err.message.contains("editing needs modified time and size; Download still works"));
    assert!(!root.exists());
    assert!(!f.server.sftp_faults.lock().requests.iter().any(|(op, _)| op == "open"));
    f.registry.shutdown().await;
}

#[tokio::test]
async fn duplicate_open_reuses_single_edit_baseline() {
    let remote = Tree::new();
    let local = Tree::new();
    fs::write(remote.path("a.json"), b"original").unwrap();
    let f = remote.fixture();
    f.connected().await;
    let registry = EditRegistry::new(local.path("edits"), Arc::new(TokioClock));
    let client = browser(&f);
    let (first, second) = tokio::join!(registry.begin_edit(&client, "/a.json"), registry.begin_edit(&client, "/a.json"));
    let first = first.unwrap();
    assert!(Arc::ptr_eq(&first, &second.unwrap()));
    let record = first.record().await;
    assert_eq!(record.baseline.size, 8);
    assert_eq!(record.local_path.extension().unwrap(), "json");
    assert_eq!(fs::read(record.local_path).unwrap(), b"original");
    assert_eq!(f.server.sftp_faults.lock().requests.iter().filter(|(op, _)| op == "open").count(), 1);
    f.registry.shutdown().await;
}

#[tokio::test]
async fn torn_snapshot_download_retries_then_conflicts() {
    let remote = Tree::new();
    let local = Tree::new();
    let remote_file = remote.path("a");
    fs::write(&remote_file, b"original").unwrap();
    let f = remote.fixture();
    f.connected().await;
    let closes = Arc::new(AtomicUsize::new(0));
    let count = closes.clone();
    f.server.sftp_faults.lock().before = Some(Box::new(move |op, path| {
        if op == "close" && path == "/a" {
            let size = 9 + count.fetch_add(1, Ordering::SeqCst);
            fs::write(&remote_file, vec![b'x'; size]).unwrap();
        }
    }));
    let root = local.path("edits");
    let registry = EditRegistry::new(root.clone(), Arc::new(TokioClock));
    let err = registry.begin_edit(&browser(&f), "/a").await.err().unwrap();
    assert_eq!(err.code, FsCode::Conflict);
    assert_eq!(closes.load(Ordering::SeqCst), 2);
    assert!(registry.jobs().is_empty());
    assert_eq!(fs::read_dir(root).unwrap().count(), 0);
    f.registry.shutdown().await;
}

#[tokio::test]
async fn recover_surfaces_retained_jobs_and_drops_missing() {
    let remote = Tree::new();
    let local = Tree::new();
    let root = local.path("edits");
    let registry = EditRegistry::new(root.clone(), Arc::new(TokioClock));
    fs::write(remote.path("job.json"), b"keep").unwrap();
    fs::write(remote.path("missing"), b"discard record").unwrap();
    let f = remote.fixture();
    f.connected().await;
    let client = browser(&f);
    let present = registry.begin_edit(&client, "/job.json").await.unwrap().record().await;
    let missing = registry.begin_edit(&client, "/missing").await.unwrap().record().await;
    fs::remove_file(&missing.local_path).unwrap();
    let recovered = recover(&root).unwrap();
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].edit_id, present.edit_id);
    assert_eq!(recovered[0].state, EditState::Paused);
    assert_eq!(recovered[0].local_path, present.local_path);
    assert_eq!(present.local_path.file_name().unwrap(), "file.json");
    assert_eq!(fs::read(&present.local_path).unwrap(), b"keep");
    assert!(!missing.local_path.parent().unwrap().join(RECORD).exists());
    f.registry.shutdown().await;
}
