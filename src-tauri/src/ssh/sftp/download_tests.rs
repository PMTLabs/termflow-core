use super::*;
use crate::ssh::sftp::tests::{browser, generation, Tree};
use std::fs;

fn save_target(tree: &Tree, name: &str) -> FileTarget {
    FileTarget::from_save_dialog(tree.root().canonicalize().unwrap().join(name)).unwrap()
}

#[tokio::test]
async fn download_file_matches_binary_bytes_and_zero_byte_file() {
    let (remote, local) = (Tree::new(), Tree::new());
    let binary: Vec<u8> = (0..=255).cycle().take(100_003).collect();
    fs::write(remote.path("binary"), &binary).unwrap();
    fs::write(remote.path("empty"), b"").unwrap();
    fs::write(local.path("empty"), b"overwrite approved").unwrap();
    let f = remote.fixture();
    f.connected().await;
    let client = browser(&f);
    for (name, expected) in [("binary", binary.as_slice()), ("empty", b"".as_slice())] {
        let path = format!("/{name}");
        let outcome = client.download_file(&path, save_target(&local, name), &CancellationToken::new()).await.unwrap();
        assert_eq!(outcome.bytes_written, expected.len() as u64);
        assert_eq!(outcome.local_path.canonicalize().unwrap(), local.path(name).canonicalize().unwrap());
        assert_eq!(fs::read(outcome.local_path).unwrap(), expected);
        let requests = &f.server.sftp_faults.lock().requests;
        assert_eq!(requests.last(), Some(&("close".to_owned(), path)));
    }
    assert_eq!(fs::read_dir(local.root()).unwrap().count(), 2);
    f.registry.shutdown().await;
}

#[tokio::test]
async fn disconnect_during_download_keeps_previous_destination_and_no_success() {
    for op in ["read", "close"] {
        let (remote, local) = (Tree::new(), Tree::new());
        fs::write(remote.path("source"), b"remote data").unwrap();
        fs::write(local.path("dest"), b"preserve me").unwrap();
        let f = remote.fixture();
        f.connected().await;
        f.server.sftp_faults.lock().drop_connection_on = Some((op, "/source".into()));
        let err = browser(&f).download_file("/source", save_target(&local, "dest"), &CancellationToken::new())
            .await.unwrap_err();
        assert_eq!((err.code, err.outcome), (FsCode::Unknown, FsOutcome::Unchanged));
        assert!(f.server.sftp_faults.lock().requests.iter().any(|(seen, path)| seen == op && path == "/source"));
        assert_eq!(fs::read(local.path("dest")).unwrap(), b"preserve me");
        assert_eq!(fs::read_dir(local.root()).unwrap().count(), 1);
        f.registry.shutdown().await;
    }
}

#[cfg(any(unix, windows))]
#[tokio::test]
async fn download_refuses_remote_symlink() {
    let (remote, local) = (Tree::new(), Tree::new());
    fs::write(remote.path("sentinel"), b"do not read").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink("sentinel", remote.path("link")).unwrap();
    #[cfg(windows)]
    if let Err(err) = std::os::windows::fs::symlink_file(remote.path("sentinel"), remote.path("link")) {
        use windows_sys::Win32::Foundation::ERROR_PRIVILEGE_NOT_HELD;
        if err.raw_os_error() == Some(ERROR_PRIVILEGE_NOT_HELD as i32) {
            eprintln!("SKIPPED: Windows symbolic link creation requires Developer Mode or SeCreateSymbolicLinkPrivilege ({err})");
            return;
        }
        panic!("Could not create test link: {err}");
    }
    let f = remote.fixture();
    f.connected().await;
    let err = browser(&f).download_file("/link", save_target(&local, "dest"), &CancellationToken::new())
        .await.unwrap_err();
    assert_eq!((err.code, err.outcome), (FsCode::Unsupported, FsOutcome::Unchanged));
    assert_eq!(&f.server.sftp_faults.lock().requests[..], &[("init".into(), "".into()), ("lstat".into(), "/link".into())]);
    assert_eq!(fs::read_dir(local.root()).unwrap().count(), 0);
    f.registry.shutdown().await;
}

#[tokio::test]
async fn stale_generation_before_local_commit_writes_nothing() {
    let (remote, successor_root, local) = (Tree::new(), Tree::new(), Tree::new());
    fs::write(remote.path("source"), b"remote data").unwrap();
    let (f, successor) = (remote.fixture(), successor_root.fixture());
    f.connected().await;
    let old = generation(&f);
    f.use_server_for_next_connection(&successor.server);
    let err = browser(&f).download_with("/source", save_target(&local, "dest"), &CancellationToken::new(), || {
        assert_eq!(f.server.sftp_faults.lock().requests.last(), Some(&("close".into(), "/source".into())));
        f.registry.close("tm-a", false, Some(old)).unwrap();
        let next = f.registry.open("tm-a", "c-a", false, || true).unwrap();
        assert_ne!(next.generation, old);
    }).await.unwrap_err();
    assert_eq!((err.code, err.outcome), (FsCode::Stale, FsOutcome::Unchanged));
    assert_eq!(fs::read_dir(local.root()).unwrap().count(), 0);
    f.connected().await;
    assert!(successor.server.sftp_faults.lock().requests.is_empty());
    f.registry.shutdown().await;
}

#[tokio::test]
async fn cancellation_during_read_discards_staging() {
    let (remote, local) = (Tree::new(), Tree::new());
    fs::write(remote.path("source"), b"remote data").unwrap();
    let f = remote.fixture();
    f.connected().await;
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    f.server.sftp_faults.lock().before = Some(Box::new(move |op, path| {
        if (op, path) == ("read", "/source") {
            trigger.cancel();
        }
    }));
    let err = browser(&f).download_file("/source", save_target(&local, "dest"), &cancel).await.unwrap_err();
    assert_eq!((err.code, err.outcome), (FsCode::Cancelled, FsOutcome::Unchanged));
    assert_eq!(fs::read_dir(local.root()).unwrap().count(), 0);
    assert_eq!(f.server.sftp_faults.lock().requests.last(), Some(&("close".into(), "/source".into())));
    f.registry.shutdown().await;
}
