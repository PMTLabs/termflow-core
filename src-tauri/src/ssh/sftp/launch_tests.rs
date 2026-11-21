use super::*;
use crate::ssh::{
    session::SessionState,
    sftp::{
        edit::{EditEventSink, EditNotice},
        tests::{browser, generation, Tree},
        upload::SftpUploader,
        watch::{poll_job, TokioClock},
    },
    tests::{wait_state, Fixture},
};
use std::{fs, sync::Mutex, time::Duration};

#[derive(Default)]
struct Capture(Mutex<Vec<EditNotice>>);
impl EditEventSink for Capture {
    fn emit(&self, notice: EditNotice) {
        self.0.lock().unwrap().push(notice);
    }
}

#[derive(Default)]
struct Launcher {
    cancel: bool,
    fail: bool,
    calls: Mutex<Vec<(Option<String>, PathBuf)>>,
}

impl EditorLauncher for Launcher {
    fn text(&self, editor: Option<&str>, path: &Path) -> LaunchResult {
        self.calls.lock().unwrap().push((editor.map(str::to_owned), path.to_owned()));
        if self.fail { Err("launcher failed".into()) } else { Ok(LaunchOutcome::Launched) }
    }

    fn open_with<'a>(&'a self, path: &'a Path, _: &'a CancellationToken) -> BoxFuture<'a, LaunchResult> {
        Box::pin(async move {
            self.calls.lock().unwrap().push((None, path.to_owned()));
            Ok(if self.cancel { LaunchOutcome::Cancelled } else { LaunchOutcome::Launched })
        })
    }
}

struct Harness {
    remote: Tree,
    _local: Tree,
    fixture: Fixture,
    edits: Arc<EditRegistry>,
    root: PathBuf,
    capture: Arc<Capture>,
}

impl Harness {
    async fn new() -> Self {
        let remote = Tree::new();
        fs::write(remote.path("a"), b"base").unwrap();
        let fixture = remote.fixture();
        fixture.connected().await;
        let local = Tree::new();
        let root = local.path("edits");
        let capture = Arc::new(Capture::default());
        let edits = Arc::new(EditRegistry::with_sink(root.clone(), Arc::new(TokioClock), capture.clone()));
        fixture.registry.set_edit_registry(&edits);
        Self { remote, _local: local, fixture, edits, root, capture }
    }

    async fn open(&self, mode: OpenMode<'_>, launcher: &Launcher) -> Result<EditOpen, FsError> {
        self.edits.open(&browser(&self.fixture), "/a", mode, launcher).await
    }

    async fn finish(self) {
        self.edits.shutdown().await;
        self.fixture.registry.shutdown().await;
    }
}

#[tokio::test]
async fn picker_cancel_stops_watch_without_error_toast() {
    let h = Harness::new().await;
    let launcher = Launcher { cancel: true, ..Default::default() };
    assert!(matches!(h.open(OpenMode::With, &launcher).await.unwrap(), EditOpen::Other { state: OpenStatus::Cancelled }));
    assert!(h.edits.jobs().is_empty());
    assert!(!launcher.calls.lock().unwrap()[0].1.exists());
    let events = h.capture.0.lock().unwrap().clone();
    assert_eq!(events.iter().map(|e| e.state).collect::<Vec<_>>(), ["watching", "stopped"]);
    assert!(events.iter().all(|e| e.error.is_none()));
    h.finish().await;
}

#[tokio::test]
async fn second_open_cancel_or_failure_keeps_the_existing_edit_running() {
    let h = Harness::new().await;
    let first = h.open(OpenMode::Text(Some("editor")), &Launcher::default()).await.unwrap();
    let EditOpen::Opened { edit_id, local_path, .. } = first else { panic!("first open must launch") };
    let job = h.edits.jobs().pop().unwrap();
    let cancelled = Launcher { cancel: true, ..Default::default() };
    assert!(matches!(h.open(OpenMode::With, &cancelled).await.unwrap(), EditOpen::Other { state: OpenStatus::Cancelled }));
    let failing = Launcher { fail: true, ..Default::default() };
    let err = h.open(OpenMode::Text(Some("editor")), &failing).await.unwrap_err();
    assert_eq!((err.code, err.outcome), (FsCode::Io, FsOutcome::Unchanged));
    assert!(err.retained_local_path.is_none(), "the reused edit was not retained, it is still live");
    // Same job, still watching, copy untouched, and no stop notice was published for it.
    assert_eq!(h.edits.jobs().len(), 1);
    assert!(Arc::ptr_eq(&h.edits.jobs()[0], &job));
    assert!(!job.cancellation().is_cancelled());
    assert_eq!(job.record().await.edit_id, edit_id);
    assert_eq!(fs::read(&local_path).unwrap(), b"base");
    assert!(h.capture.0.lock().unwrap().iter().all(|n| n.state == "watching"));
    h.finish().await;
}

#[tokio::test]
async fn reopen_after_conflict_takes_a_fresh_baseline_and_keeps_the_old_copy() {
    let h = Harness::new().await;
    let EditOpen::Opened { edit_id: old_id, local_path: old_path, .. } =
        h.open(OpenMode::Text(Some("editor")), &Launcher::default()).await.unwrap() else { panic!() };
    fs::write(&old_path, b"mine").unwrap();
    // Arrange the watcher's terminal Conflict outcome (an upload found the server copy changed).
    h.edits.jobs()[0].data.lock().await.record.state = EditState::Conflict;
    fs::write(h.remote.path("a"), b"server change").unwrap();
    let EditOpen::Opened { edit_id: new_id, local_path: new_path, .. } =
        h.open(OpenMode::Text(Some("editor")), &Launcher::default()).await.unwrap() else { panic!("reopen must launch") };
    assert_ne!(new_id, old_id, "reopen must not hand back the dead conflicted job");
    assert_ne!(new_path, old_path);
    assert_eq!(fs::read(&new_path).unwrap(), b"server change", "fresh baseline from the server");
    assert_eq!(fs::read(&old_path).unwrap(), b"mine", "the conflicted copy is retained");
    let listed = h.edits.list("tm-a", ".").await.unwrap();
    assert!(listed.iter().any(|e| e.retained && e.notice.edit_id == old_id));
    assert!(listed.iter().any(|e| !e.retained && e.notice.edit_id == new_id));
    assert_eq!(h.edits.jobs().len(), 1);
    h.finish().await;
}

#[tokio::test]
async fn editor_launch_failure_retains_copy() {
    let h = Harness::new().await;
    let launcher = Launcher { fail: true, ..Default::default() };
    let err = h.open(OpenMode::Text(Some("editor")), &launcher).await.unwrap_err();
    assert_eq!(err.code, FsCode::Io);
    let path = PathBuf::from(err.retained_local_path.unwrap());
    assert_eq!(fs::read(&path).unwrap(), b"base");
    assert!(h.edits.jobs().is_empty());
    let list = h.edits.list("tm-a", "/a").await.unwrap();
    assert!(list[0].retained);
    assert_eq!(list[0].notice.local_path.as_ref(), Some(&path));
    assert_eq!(list[0].notice.state, "error");
    assert!(h.capture.0.lock().unwrap().last().unwrap().error.is_some());
    h.finish().await;
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn unconfigured_editor_never_executes_downloaded_exe_or_script() {
    let h = Harness::new().await;
    let launcher = Launcher::default();
    for name in ["payload.exe", "payload.sh"] {
        fs::write(h.remote.path(name), b"untrusted remote bytes").unwrap();
        let result = h.edits.open(&browser(&h.fixture), &format!("/{name}"), OpenMode::Text(None), &launcher).await.unwrap();
        assert!(matches!(result, EditOpen::Other { state: OpenStatus::NeedsEditor }));
    }
    assert!(launcher.calls.lock().unwrap().is_empty());
    assert!(h.edits.jobs().is_empty());
    h.finish().await;
}

#[tokio::test]
async fn configured_editor_receives_private_temp_path_not_remote_path() {
    let h = Harness::new().await;
    let launcher = Launcher::default();
    let EditOpen::Opened { local_path, .. } = h.open(OpenMode::Text(Some("editor")), &launcher).await.unwrap()
        else { panic!("expected opened job") };
    let calls = launcher.calls.lock().unwrap().clone();
    assert_eq!(calls, [(Some("editor".into()), local_path.clone())]);
    assert!(local_path.starts_with(h.root.canonicalize().unwrap()));
    assert_eq!(fs::read(local_path).unwrap(), b"base");
    h.finish().await;
}

#[tokio::test]
async fn edit_list_rehydrates_existing_job_without_second_watch() {
    let h = Harness::new().await;
    let launcher = Launcher::default();
    let EditOpen::Opened { edit_id, local_path, .. } = h.open(OpenMode::Text(Some("editor")), &launcher).await.unwrap()
        else { panic!("expected opened job") };
    for path in [".", "/a"] {
        let list = h.edits.list("tm-a", path).await.unwrap();
        assert_eq!(list.len(), 1);
        assert!(!list[0].retained);
        assert_eq!(list[0].notice.edit_id, edit_id);
        assert_eq!(list[0].notice.local_path.as_ref(), Some(&local_path));
    }
    assert_eq!(h.edits.jobs().len(), 1);
    assert_eq!(h.capture.0.lock().unwrap().len(), 1);
    assert_eq!(launcher.calls.lock().unwrap().len(), 1);
    h.finish().await;
}

#[tokio::test]
async fn edit_state_events_are_scoped_to_terminal() {
    let h = Harness::new().await;
    let other = h.remote.fixture();
    other.registry.open("tm-b", "c-a", false, || true).unwrap();
    let view = wait_state(&other.registry, "tm-b", false, SessionState::NeedsSecret).await;
    other.registry.submit_secret("tm-b", false, Some(view.generation), view.prompt_id.as_deref(), other.server.password.clone(), false).unwrap();
    other.registry.on_launch_lifecycle("tm-b", view.generation, 1, crate::ssh::session::LaunchState::Running, Some("pc-b".into())).unwrap();
    wait_state(&other.registry, "tm-b", false, SessionState::Connected).await;
    let a = h.edits.begin_edit(&browser(&h.fixture), "/a").await.unwrap().record().await;
    let b = h.edits.begin_edit(&RemoteFs::new(&other.registry, "tm-b", view.generation), "/a").await.unwrap().record().await;
    let stop = h.edits.stop_by_id("tm-a", "/a", b.edit_id).await.unwrap();
    assert!(!stop.retained);
    assert_eq!(h.edits.list("tm-b", ".").await.unwrap().len(), 1);
    h.edits.stop_by_id("tm-a", "/a", a.edit_id).await.unwrap();
    let notices = h.capture.0.lock().unwrap().clone();
    assert_eq!(notices.iter().map(|n| (n.terminal_id.as_str(), n.edit_id, n.state)).collect::<Vec<_>>(),
        [("tm-a", a.edit_id, "watching"), ("tm-b", b.edit_id, "watching"), ("tm-a", a.edit_id, "stopped")]);
    assert_eq!(notices[1].session_generation, view.generation);
    h.finish().await;
    other.registry.shutdown().await;
}

#[tokio::test]
async fn close_stops_future_commits_and_dirty_copy_survives_restart() {
    let h = Harness::new().await;
    let job = h.edits.begin_edit(&browser(&h.fixture), "/a").await.unwrap();
    let path = job.record().await.local_path;
    fs::write(&path, b"edit").unwrap(); // same size, never polled before close
    h.fixture.server.sftp_faults.lock().requests.clear();
    h.fixture.registry.close("tm-a", false, Some(generation(&h.fixture))).unwrap();
    let uploader = Arc::new(SftpUploader::new(h.fixture.registry.clone()));
    for _ in 0..2 {
        poll_job(job.clone(), &h.fixture.registry, &uploader, &Arc::downgrade(&h.edits)).await;
    }
    tokio::time::timeout(Duration::from_secs(5), async {
        while !h.edits.jobs().is_empty() { tokio::time::sleep(Duration::from_millis(5)).await; }
    }).await.unwrap();
    assert!(job.cancellation().is_cancelled());
    assert!(h.fixture.server.sftp_faults.lock().requests.is_empty());
    assert_eq!(fs::read(h.remote.path("a")).unwrap(), b"base");
    let restarted = EditRegistry::new(h.root.clone(), Arc::new(TokioClock));
    restarted.load_recovered().unwrap();
    let retained = restarted.list("tm-a", ".").await.unwrap();
    assert_eq!(retained.len(), 1);
    assert!(retained[0].retained);
    assert_eq!(retained[0].notice.local_path.as_ref(), Some(&path));
    assert_eq!(fs::read(path).unwrap(), b"edit");
    assert!(restarted.jobs().is_empty());
    h.finish().await;
}

#[cfg(all(windows, feature = "integration-tests"))]
#[test]
fn open_with_windows_reaches_main_thread_with_hwnd() {
    let root = Tree::new();
    let app = tauri::Builder::<tauri::Wry>::default().any_thread()
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "open-with-test", tauri::WebviewUrl::External("about:blank".parse().unwrap()))
        .visible(false).data_directory(root.path("webview")).build().unwrap();
    let owner = window.hwnd().unwrap().0 as usize;
    let ui_thread = std::thread::current().id();
    let path = root.path("a");
    let handle = app.handle().clone();
    let (tx, rx) = std::sync::mpsc::channel();
    tauri::async_runtime::spawn(async move {
        let expected_path = path.clone();
        let result = tokio::time::timeout(Duration::from_secs(10), with_windows_owner(
            window, path, CancellationToken::new(), move |hwnd, path| {
                if std::thread::current().id() != ui_thread || hwnd.0 as usize != owner || owner == 0 || path != expected_path.as_path() {
                    return Err("Wrong UI thread, owner HWND, or local filename".into());
                }
                Ok(LaunchOutcome::Cancelled)
            },
        )).await;
        let _ = tx.send(result);
        handle.exit(0);
    });
    app.run_return(|_, _| {});
    assert_eq!(rx.recv().unwrap().unwrap().unwrap(), LaunchOutcome::Cancelled);
}

#[cfg(not(windows))]
#[test]
#[ignore = "SHOpenWithDialog and HWND exist only on Windows"]
fn open_with_windows_reaches_main_thread_with_hwnd() {}
