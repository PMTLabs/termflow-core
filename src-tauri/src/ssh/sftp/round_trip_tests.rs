use super::{
    tests::{browser, generation, Tree},
    upload::SftpUploader,
    watch::{poll_job, TokioClock},
    DownloadOutcome, EditRegistry, EditState, FileTarget, FsCode, FsOutcome, RemoteKind,
};
use std::{fs, sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn sftp_server_all_actions_round_trip() {
    let (remote, local) = (Tree::new(), Tree::new());
    let bytes = b"TermFlow\0\xff\n";
    fs::write(remote.path("source"), bytes).unwrap();
    let f = remote.fixture();
    f.connected().await;
    let client = browser(&f);

    let listing = client.list("/").await.unwrap();
    assert_eq!(listing.path, "/");
    assert_eq!(listing.session_generation, generation(&f));
    assert_eq!(
        listing.entries.len(),
        fs::read_dir(remote.root()).unwrap().count()
    );
    assert_eq!(listing.entries[0].path, "/source");
    assert_eq!(listing.entries[0].kind, RemoteKind::File);
    assert_eq!(fs::read(remote.path("source")).unwrap(), bytes);

    client.mkdir("/folder").await.unwrap();
    client.mkdir("/folder/nested").await.unwrap();
    assert_eq!(fs::read_dir(remote.path("folder")).unwrap().count(), 1);
    assert_eq!(
        fs::read_dir(remote.path("folder/nested")).unwrap().count(),
        0
    );
    client.create("/folder/empty").await.unwrap();
    assert_eq!(fs::read(remote.path("folder/empty")).unwrap(), b"");

    let path = "/folder/nested/renamed";
    let disk = remote.path("folder/nested/renamed");
    client.rename("/source", path).await.unwrap();
    assert!(!remote.path("source").exists());
    assert_eq!(fs::read(&disk).unwrap(), bytes);
    let stat = client.stat(path).await.unwrap();
    assert_eq!(stat.entry.path, path);
    assert_eq!(stat.entry.kind, RemoteKind::File);
    assert_eq!(
        stat.entry.size,
        Some(fs::metadata(&disk).unwrap().len().to_string())
    );
    assert!(stat.link_target.is_none());

    client.chmod(path, 0o640).await.unwrap();
    assert_eq!(client.stat(path).await.unwrap().entry.mode, Some(0o100640));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&disk).unwrap().permissions().mode() & 0o7777,
            0o640
        );
    }
    // The protocol fixture models ownership without changing the OS owner.
    client.chown(path, Some(1234), Some(2345)).await.unwrap();
    let attrs = client.stat(path).await.unwrap().entry;
    assert_eq!(
        (attrs.uid, attrs.gid, attrs.mode),
        (Some(1234), Some(2345), Some(0o100640))
    );
    assert_eq!(fs::read(&disk).unwrap(), bytes);

    let cancel = CancellationToken::new();
    let parent = local.root().canonicalize().unwrap();
    let target = parent.join("single.bin");
    let file = client
        .download_file(path, FileTarget::no_replace(target.clone()), &cancel)
        .await
        .unwrap();
    assert_eq!(
        (file.local_path, file.bytes_written),
        (target.clone(), bytes.len() as u64)
    );
    assert_eq!(fs::read(target).unwrap(), bytes);
    assert_eq!(fs::read(&disk).unwrap(), bytes);
    let DownloadOutcome {
        local_path,
        files,
        dirs,
    } = client
        .download_dir("/folder", &parent, &cancel)
        .await
        .unwrap();
    assert_eq!((local_path, files, dirs), (parent.join("folder"), 2, 2));
    assert_eq!(
        fs::read(local.path("folder/nested/renamed")).unwrap(),
        bytes
    );
    assert_eq!(fs::read(local.path("folder/empty")).unwrap(), b"");
    assert_eq!(fs::read(&disk).unwrap(), bytes);
    assert_eq!(fs::read(remote.path("folder/empty")).unwrap(), b"");

    client.delete("/folder/empty", false, true).await.unwrap();
    assert!(!remote.path("folder/empty").exists());
    assert_eq!(fs::read(&disk).unwrap(), bytes);
    client.delete("/folder", true, true).await.unwrap();
    assert!(!remote.path("folder").exists());
    assert_eq!(fs::read_dir(remote.root()).unwrap().count(), 0);
    assert_eq!(
        fs::read(local.path("folder/nested/renamed")).unwrap(),
        bytes
    );
    f.registry.shutdown().await;
}

#[tokio::test]
async fn sftp_server_permission_denied_and_mid_operation_drop_never_success() {
    let remote = Tree::new();
    fs::write(remote.path("source"), b"keep").unwrap();
    let f = remote.fixture();
    f.connected().await;
    let client = browser(&f);
    f.server
        .sftp_faults
        .lock()
        .deny
        .push(("rename", "/source".into()));
    let err = client.rename("/source", "/target").await.unwrap_err();
    assert_eq!(
        (err.code, err.outcome, err.path.as_str()),
        (FsCode::PermissionDenied, FsOutcome::Unchanged, "/source")
    );
    assert_eq!(fs::read(remote.path("source")).unwrap(), b"keep");
    assert!(!remote.path("target").exists());

    // Apply the same mutation but drop the transport before its acknowledgement.
    {
        let mut faults = f.server.sftp_faults.lock();
        faults.deny.clear();
        faults.drop_connection_on = Some(("rename", "/source".into()));
    }
    let err = client.rename("/source", "/target").await.unwrap_err();
    assert_eq!(
        (err.outcome, err.path.as_str()),
        (FsOutcome::Unknown, "/source")
    );
    assert!(!remote.path("source").exists());
    assert_eq!(fs::read(remote.path("target")).unwrap(), b"keep");
    f.registry.shutdown().await;
}

#[tokio::test]
async fn sftp_server_editor_save_conflict_preserves_both_copies() {
    let (remote, local) = (Tree::new(), Tree::new());
    let original = remote.path("notes.txt");
    fs::write(&original, b"base").unwrap();
    let f = remote.fixture();
    f.connected().await;
    let edits = Arc::new(EditRegistry::new(local.path("edits"), Arc::new(TokioClock)));
    let job = edits.begin_edit(&browser(&f), "/notes.txt").await.unwrap();
    let record = job.record().await;
    assert_eq!(record.state, EditState::Watching);
    assert_eq!(fs::read(&record.local_path).unwrap(), b"base");
    f.server.sftp_faults.lock().requests.clear();

    fs::write(&original, b"server-side change").unwrap();
    fs::write(&record.local_path, b"user's unsaved bytes").unwrap();
    let uploader = Arc::new(SftpUploader::new(f.registry.clone()));
    let registry = Arc::downgrade(&edits);
    // Two identical samples are a stable save; drive the production poller
    // without a desktop editor or a wall-clock polling interval.
    for _ in 0..2 {
        poll_job(job.clone(), &f.registry, &uploader, &registry).await;
    }
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let state = job.record().await.state;
            if state != EditState::Uploading {
                assert_eq!(state, EditState::Conflict);
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("save did not settle");
    assert_eq!(
        f.server.sftp_faults.lock().requests,
        [("lstat".into(), "/notes.txt".into())]
    );
    assert_eq!(fs::read(&original).unwrap(), b"server-side change");
    assert_eq!(fs::read_dir(remote.root()).unwrap().count(), 1);
    let stopped = edits
        .stop_by_id("tm-a", "/notes.txt", record.edit_id)
        .await
        .unwrap();
    assert!(stopped.retained);
    assert_eq!(
        stopped.local_path.as_deref(),
        Some(record.local_path.as_path())
    );
    assert_eq!(
        fs::read(record.local_path).unwrap(),
        b"user's unsaved bytes"
    );
    edits.shutdown().await;
    f.registry.shutdown().await;
}

#[cfg(all(unix, feature = "integration-tests"))]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_fs_commands_invoke_real_server() {
    // Spawns a real shell for the insertion check, so it holds the child-process gate.
    let _gate = crate::pty_host_client::test_dirs::child_process_gate();
    use crate::state::AppState;
    use serde::Deserialize;
    use serde_json::{json, Value};
    use tauri::{
        ipc::{CallbackFn, InvokeBody},
        test,
        webview::InvokeRequest,
        Manager,
    };

    // AppState::new reads profile-scoped files. Run the mock app in a child
    // with a disposable home rather than changing process-wide test env.
    const ISOLATED: &str = "TF_SFTP_ROUND_TRIP_ISOLATED";
    if std::env::var_os(ISOLATED).is_none() {
        let home = Tree::new();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                concat!(module_path!(), "::ssh_fs_commands_invoke_real_server")
                    .split_once("::")
                    .unwrap()
                    .1,
                "--exact",
            ])
            .env(ISOLATED, "1")
            .env("HOME", home.root())
            .env("USERPROFILE", home.root())
            .env("XDG_CONFIG_HOME", home.root())
            .env("XDG_DATA_HOME", home.root())
            .env_remove("SSH_AUTH_SOCK")
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success() && stdout.contains("1 passed"),
            "{stdout}\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }

    // Production reply types are Serialize-only. Decode the renderer-facing
    // contract into test-owned types rather than changing production derives.
    #[derive(Debug, Deserialize, PartialEq)]
    #[serde(rename_all = "camelCase")]
    enum WireKind {
        File,
    }
    #[derive(Debug, Deserialize, PartialEq)]
    struct WireStat {
        name: String,
        path: String,
        kind: WireKind,
        size: String,
    }
    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct WireListing {
        path: String,
        session_generation: u64,
        entries: Vec<WireStat>,
    }
    #[derive(Debug, Deserialize, PartialEq)]
    #[serde(rename_all = "camelCase")]
    enum WireCode {
        PermissionDenied,
    }
    #[derive(Debug, Deserialize, PartialEq)]
    #[serde(rename_all = "camelCase")]
    enum WireOutcome {
        Unchanged,
    }
    #[derive(Debug, Deserialize)]
    struct WireFsError {
        code: WireCode,
        operation: String,
        path: String,
        outcome: WireOutcome,
        message: String,
    }

    let remote = Tree::new();
    fs::write(remote.path("source"), b"IPC").unwrap();
    let f = remote.fixture();
    f.connected().await;
    let app = test::mock_builder()
        .invoke_handler(crate::ssh_handlers![])
        .build(test::mock_context(test::noop_assets()))
        .unwrap();
    let (tx, _) = tokio::sync::broadcast::channel(16);
    let mut state = AppState::new(
        tx,
        app.handle().clone(),
        crate::app_config::NetworkConfig::defaults(),
    );
    state.ssh_sessions = f.registry.clone();
    app.manage(state);
    let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let invoke = |cmd: &str, body: Value| {
        test::get_ipc_response(
            &window,
            InvokeRequest {
                cmd: cmd.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body: InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: test::INVOKE_KEY.into(),
            },
        )
    };
    let expected = generation(&f);
    let request =
        |path: &str| json!({"terminalId": "tm-a", "expectedGeneration": expected, "path": path});

    let list = invoke("ssh_fs_list", request("/"))
        .unwrap()
        .deserialize::<WireListing>()
        .unwrap();
    assert_eq!(
        (
            list.path.as_str(),
            list.session_generation,
            list.entries.len()
        ),
        ("/", expected, 1)
    );
    let stat = invoke("ssh_fs_stat", request("/source"))
        .unwrap()
        .deserialize::<WireStat>()
        .unwrap();
    assert_eq!(
        stat,
        WireStat {
            name: "source".into(),
            path: "/source".into(),
            kind: WireKind::File,
            size: "3".into()
        }
    );
    assert_eq!(list.entries, [stat]);
    invoke("ssh_fs_mkdir", request("/folder"))
        .unwrap()
        .deserialize::<()>()
        .unwrap();
    assert!(remote.path("folder").is_dir());

    let mut rename = request("/source");
    rename["newPath"] = json!("/folder/renamed");
    f.server
        .sftp_faults
        .lock()
        .deny
        .push(("rename", "/source".into()));
    let err: WireFsError =
        serde_json::from_value(invoke("ssh_fs_rename", rename.clone()).unwrap_err()).unwrap();
    assert_eq!(
        (
            err.code,
            err.outcome,
            err.operation.as_str(),
            err.path.as_str()
        ),
        (
            WireCode::PermissionDenied,
            WireOutcome::Unchanged,
            "rename",
            "/source"
        )
    );
    assert!(err.message.contains("Nothing was changed"));
    assert_eq!(fs::read(remote.path("source")).unwrap(), b"IPC");
    assert_eq!(fs::read_dir(remote.path("folder")).unwrap().count(), 0);
    f.server.sftp_faults.lock().deny.clear();

    invoke("ssh_fs_rename", rename)
        .unwrap()
        .deserialize::<()>()
        .unwrap();
    assert!(!remote.path("source").exists());
    assert_eq!(fs::read(remote.path("folder/renamed")).unwrap(), b"IPC");
    let mut delete = request("/folder");
    delete["recursive"] = json!(true);
    delete["confirmed"] = json!(true);
    invoke("ssh_fs_delete", delete)
        .unwrap()
        .deserialize::<()>()
        .unwrap();
    assert_eq!(fs::read_dir(remote.root()).unwrap().count(), 0);
    f.registry.shutdown().await;
}
