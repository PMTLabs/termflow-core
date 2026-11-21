use super::*;
use crate::ssh::sftp::tests::{browser, generation, Tree};
use std::fs;

fn no_file_requests(f: &crate::ssh::tests::Fixture) {
    assert!(!f.server.sftp_faults.lock().requests.iter().any(|(op, _)| {
        matches!(op.as_str(), "open" | "read")
    }));
}

#[tokio::test]
async fn root_download_is_refused_before_the_picker_opens() {
    let remote = Tree::new();
    let f = remote.fixture();
    f.connected().await;
    let err = browser(&f).download_with_picker("/", &CancellationToken::new(), |_| async {
        panic!("the native picker must not open for /");
        #[allow(unreachable_code)]
        Ok(None)
    }).await.unwrap_err();
    assert_eq!((err.code, err.outcome), (FsCode::InvalidPath, FsOutcome::Unchanged));
    no_file_requests(&f);
}

#[tokio::test]
async fn download_folder_recreates_nested_tree_under_picked_parent() {
    let (remote, local) = (Tree::new(), Tree::new());
    fs::create_dir_all(remote.path("folder/sub/empty")).unwrap();
    fs::write(remote.path("folder/top.txt"), b"top").unwrap();
    let bytes: Vec<u8> = (0..=255).cycle().take(65_537).collect();
    fs::write(remote.path("folder/sub/data.bin"), &bytes).unwrap();
    let f = remote.fixture();
    f.connected().await;
    let picked = local.root().to_owned();
    let result = browser(&f).download_with_picker("/folder", &CancellationToken::new(), |picker| async move {
        assert!(matches!(picker, DownloadPicker::Folder));
        Ok(Some(picked))
    }).await.unwrap();
    let DownloadResult::Done { local_path, files, dirs } = result else { panic!("expected folder") };
    assert_eq!(local_path.canonicalize().unwrap(), local.path("folder").canonicalize().unwrap());
    assert_eq!((files, dirs), (2, 3));
    assert_eq!(fs::read(local.path("folder/top.txt")).unwrap(), b"top");
    assert_eq!(fs::read(local.path("folder/sub/data.bin")).unwrap(), bytes);
    assert_eq!(fs::read_dir(local.path("folder/sub/empty")).unwrap().count(), 0);
    f.registry.shutdown().await;
}

#[tokio::test]
async fn existing_folder_merge_refused() {
    let (remote, local) = (Tree::new(), Tree::new());
    fs::create_dir(remote.path("folder")).unwrap();
    fs::write(remote.path("folder/file"), b"remote").unwrap();
    fs::create_dir(local.path("folder")).unwrap();
    fs::write(local.path("folder/sentinel"), b"keep").unwrap();
    let f = remote.fixture();
    f.connected().await;
    let parent = local.root().canonicalize().unwrap();
    let err = browser(&f).download_dir("/folder", &parent, &CancellationToken::new()).await.unwrap_err();
    assert_eq!((err.code, err.outcome), (FsCode::Exists, FsOutcome::Unchanged));
    assert_eq!(err.path, "/folder");
    let displayed = display_path(parent.join("folder"));
    assert!(err.message.contains(displayed.to_string_lossy().as_ref()));
    assert_eq!(fs::read(local.path("folder/sentinel")).unwrap(), b"keep");
    assert_eq!(fs::read_dir(local.path("folder")).unwrap().count(), 1);
    no_file_requests(&f);
    f.registry.shutdown().await;
}

#[tokio::test]
async fn folder_partial_download_names_failed_path() {
    let (remote, local) = (Tree::new(), Tree::new());
    fs::create_dir_all(remote.path("folder/b-sub")).unwrap();
    fs::write(remote.path("folder/a"), b"committed").unwrap();
    fs::write(remote.path("folder/b-sub/denied"), b"refused").unwrap();
    fs::write(remote.path("folder/c"), b"not reached").unwrap();
    let f = remote.fixture();
    f.connected().await;
    f.server.sftp_faults.lock().deny.push(("read", "/folder/b-sub/denied".into()));
    let parent = local.root().canonicalize().unwrap();
    let err = browser(&f).download_dir("/folder", &parent, &CancellationToken::new()).await.unwrap_err();
    assert_eq!((err.code, err.outcome), (FsCode::PermissionDenied, FsOutcome::Partial));
    assert_eq!(err.path, "/folder/b-sub/denied");
    assert!(err.message.contains("/folder/b-sub/denied"));
    assert_eq!(err.completed_paths, Some(vec![display_path(parent.join("folder").join("a")).to_string_lossy().into_owned()]));
    assert_eq!(fs::read(local.path("folder/a")).unwrap(), b"committed");
    assert_eq!(fs::read_dir(local.path("folder/b-sub")).unwrap().count(), 0);
    assert!(!local.path("folder/c").exists());
    assert!(f.server.sftp_faults.lock().requests.iter().any(|(op, path)| op == "read" && path == "/folder/b-sub/denied"));
    f.registry.shutdown().await;
}

#[cfg(any(unix, windows))]
#[tokio::test]
async fn download_refuses_tree_with_remote_symlink_before_creating_anything() {
    let (remote, local) = (Tree::new(), Tree::new());
    fs::create_dir(remote.path("folder")).unwrap();
    fs::create_dir(remote.path("target")).unwrap();
    fs::write(remote.path("folder/a"), b"preflight must not copy this").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink("../target", remote.path("folder/z-link")).unwrap();
    #[cfg(windows)]
    if let Err(err) = std::os::windows::fs::symlink_dir(remote.path("target"), remote.path("folder/z-link")) {
        use windows_sys::Win32::Foundation::ERROR_PRIVILEGE_NOT_HELD;
        if err.raw_os_error() == Some(ERROR_PRIVILEGE_NOT_HELD as i32) {
            eprintln!("SKIPPED: Windows symbolic link creation requires Developer Mode or SeCreateSymbolicLinkPrivilege ({err})");
            return;
        }
        panic!("Could not create test link: {err}");
    }
    let f = remote.fixture();
    f.connected().await;
    let parent = local.root().canonicalize().unwrap();
    let err = browser(&f).download_dir("/folder", &parent, &CancellationToken::new()).await.unwrap_err();
    assert_eq!((err.code, err.outcome), (FsCode::Unsupported, FsOutcome::Unchanged));
    assert_eq!(err.path, "/folder/z-link");
    assert_eq!(fs::read_dir(local.root()).unwrap().count(), 0);
    no_file_requests(&f);
    assert!(!f.server.sftp_faults.lock().requests.iter().any(|(op, path)| op == "opendir" && path == "/folder/z-link"));
    f.registry.shutdown().await;
}

#[tokio::test]
async fn download_rejects_parent_escape_symlink_and_windows_name_collision() {
    let (remote, picked) = (Tree::new(), Tree::new());
    fs::create_dir(remote.path("folder")).unwrap();
    let f = remote.fixture();
    f.connected().await;
    let client = browser(&f);
    let parent = picked.root().canonicalize().unwrap();
    let cancel = CancellationToken::new();

    // Use the real wire server for names the host cannot create on disk.
    let mut invalid: Vec<String> = [
        "", "../x", "/x", "\\x", "a/b", "a\\b", "a:b", "x.", "x ", "con.txt", "pRn.tar.gz",
        "AUX", "nul", "x?", "x*", "x\"", "x<", "x>", "x|",
    ].into_iter().map(str::to_owned).collect();
    for dev in ["cOm", "lPt"] {
        for digit in ["1", "2", "3", "4", "5", "6", "7", "8", "9", "¹", "²", "³"] {
            for ext in ["", ".txt"] {
                invalid.push(format!("{dev}{digit}{ext}"));
            }
        }
    }
    for byte in (0..=0x1f).chain([0x7f]) {
        invalid.push(format!("x{}y", char::from(byte)));
    }
    for name in invalid {
        let path = format!("/folder/{name}");
        f.server.sftp_faults.lock().readdir_names = Some(vec![name]);
        let err = client.download_dir("/folder", &parent, &cancel).await.unwrap_err();
        assert_eq!((err.code, err.outcome), (FsCode::InvalidPath, FsOutcome::Unchanged));
        assert_eq!(err.path, path);
        assert_eq!(fs::read_dir(&parent).unwrap().count(), 0);
    }
    for path in ["/folder/.", "/folder/.."] {
        // Pseudo-entries in READDIR are ignored; they cannot be action paths.
        let err = client.download_dir(path, &parent, &cancel).await.unwrap_err();
        assert_eq!((err.code, err.outcome), (FsCode::InvalidPath, FsOutcome::Unchanged));
    }
    f.server.sftp_faults.lock().readdir_names = Some(vec!["A.txt".into(), "a.txt".into()]);
    let err = client.download_dir("/folder", &parent, &cancel).await.unwrap_err();
    assert_eq!((err.code, err.outcome), (FsCode::Conflict, FsOutcome::Unchanged));
    assert_eq!(err.path, "/folder/a.txt");
    assert_eq!(fs::read_dir(&parent).unwrap().count(), 0);
    no_file_requests(&f);
    f.registry.shutdown().await;
}

#[tokio::test]
async fn cancelled_picker_opens_no_remote_file() {
    let remote = Tree::new();
    fs::write(remote.path("source"), b"not read").unwrap();
    let f = remote.fixture();
    f.connected().await;
    let result = browser(&f).download_with_picker("/source", &CancellationToken::new(), |picker| async {
        assert!(matches!(picker, DownloadPicker::Save { default_name: Some(name) } if name == "source"));
        Ok(None)
    }).await.unwrap();
    assert!(matches!(result, DownloadResult::Cancelled));
    assert!(f.server.sftp_faults.lock().requests.iter().any(|(op, path)| op == "lstat" && path == "/source"));
    no_file_requests(&f);
    f.registry.shutdown().await;
}

#[tokio::test]
async fn save_picker_resolves_parent_and_replaces_confirmed_target() {
    let (remote, local) = (Tree::new(), Tree::new());
    fs::write(remote.path("source"), b"downloaded").unwrap();
    fs::create_dir(local.path("real")).unwrap();
    fs::write(local.path("real/dest"), b"overwrite approved").unwrap();
    #[cfg(unix)]
    let picked = {
        std::os::unix::fs::symlink("real", local.path("alias")).unwrap();
        local.path("alias/dest")
    };
    #[cfg(not(unix))]
    let picked = local.path("real/dest");
    let f = remote.fixture();
    f.connected().await;
    let result = browser(&f).download_with_picker("/source", &CancellationToken::new(), |picker| async move {
        assert!(matches!(picker, DownloadPicker::Save { default_name: Some(name) } if name == "source"));
        Ok(Some(picked))
    }).await.unwrap();
    let destination = display_path(local.path("real/dest").canonicalize().unwrap());
    assert_eq!(serde_json::to_value(result).unwrap(), serde_json::json!({
        "status": "done", "localPath": destination, "files": 1, "dirs": 0,
    }));
    assert_eq!(fs::read(local.path("real/dest")).unwrap(), b"downloaded");
    f.registry.shutdown().await;
}

#[tokio::test]
async fn picker_return_after_session_close_does_not_start_transfer() {
    let (remote, local) = (Tree::new(), Tree::new());
    fs::write(remote.path("source"), b"not read").unwrap();
    let f = remote.fixture();
    f.connected().await;
    let old = generation(&f);
    let err = browser(&f).download_with_picker("/source", &CancellationToken::new(), |_| async {
        f.registry.close("tm-a", false, Some(old)).unwrap();
        Ok(Some(local.path("dest")))
    }).await.unwrap_err();
    assert_eq!((err.code, err.outcome), (FsCode::NotConnected, FsOutcome::Unchanged));
    no_file_requests(&f);
    assert_eq!(fs::read_dir(local.root()).unwrap().count(), 0);
    f.registry.shutdown().await;
}

#[tokio::test]
async fn picker_return_after_reconnect_is_stale() {
    let (remote, successor_root, local) = (Tree::new(), Tree::new(), Tree::new());
    fs::write(remote.path("source"), b"not read").unwrap();
    fs::write(successor_root.path("source"), b"also not read").unwrap();
    let (f, successor) = (remote.fixture(), successor_root.fixture());
    f.connected().await;
    let old = generation(&f);
    let err = browser(&f).download_with_picker("/source", &CancellationToken::new(), |_| async {
        f.use_server_for_next_connection(&successor.server);
        f.registry.close("tm-a", false, Some(old)).unwrap();
        f.connected().await;
        assert_ne!(generation(&f), old);
        Ok(Some(local.path("dest")))
    }).await.unwrap_err();
    assert_eq!((err.code, err.outcome), (FsCode::Stale, FsOutcome::Unchanged));
    no_file_requests(&f);
    assert!(successor.server.sftp_faults.lock().requests.is_empty());
    assert_eq!(fs::read_dir(local.root()).unwrap().count(), 0);
    f.registry.shutdown().await;
}

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
        assert_eq!((err.code, err.outcome), (FsCode::Io, FsOutcome::Unchanged));
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
