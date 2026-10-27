use super::*;
use crate::manager::SessionManager;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Condvar,
};
use std::time::{Duration, Instant};
use termflow_pty_protocol::{Control, Data};

struct Blocking {
    calls: AtomicUsize,
    gate: (Mutex<bool>, Condvar),
}
impl Blocking {
    fn new() -> Self {
        Self {
            calls: AtomicUsize::new(0),
            gate: (Mutex::new(false), Condvar::new()),
        }
    }
    fn wait(&self) {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let mut open = self.gate.0.lock().unwrap();
        while !*open {
            open = self.gate.1.wait(open).unwrap();
        }
    }
    fn release(&self) {
        *self.gate.0.lock().unwrap() = true;
        self.gate.1.notify_all();
    }
}
impl Backend for Blocking {
    fn status(&self) -> (PermissionState, PermissionState) {
        self.wait();
        (PermissionState::Granted, PermissionState::NotGranted)
    }
    fn request(&self, _: PermissionKind) -> PermissionState {
        self.wait();
        PermissionState::Granted
    }
}
fn wait_for_calls(fake: &Blocking, count: usize) {
    let start = Instant::now();
    while fake.calls.load(Ordering::SeqCst) < count {
        assert!(start.elapsed() < Duration::from_secs(2));
        std::thread::sleep(Duration::from_millis(2));
    }
}
fn setup() -> (
    SessionManager,
    tokio::sync::mpsc::Receiver<Response>,
    Arc<Blocking>,
) {
    let (events, _) = tokio::sync::mpsc::channel::<Data>(64);
    let (responses, rx) = tokio::sync::mpsc::channel(64);
    let fake = Arc::new(Blocking::new());
    let mut manager = SessionManager::new(events, responses, Some("secret".into()), true);
    manager.set_permission_backend(fake.clone());
    manager.begin_connection();
    (manager, rx, fake)
}
fn request(req: u64, token: &str, kind: PermissionKind) -> Control {
    Control::RequestPermission {
        req,
        token: token.into(),
        kind,
    }
}
async fn next(rx: &mut tokio::sync::mpsc::Receiver<Response>) -> Response {
    tokio::time::timeout(Duration::from_secs(2), rx.recv())
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn bad_token_never_calls_backend_or_replies() {
    let (mut manager, mut rx, fake) = setup();
    manager.handle_control(request(1, "bad", PermissionKind::Accessibility));
    manager.handle_control(Control::PermissionStatus {
        req: 2,
        token: "bad".into(),
    });
    assert!(rx.try_recv().is_err());
    assert_eq!(fake.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn replies_preserve_request_id_and_kind() {
    for kind in [
        PermissionKind::Accessibility,
        PermissionKind::ScreenRecording,
    ] {
        let (mut manager, mut rx, fake) = setup();
        manager.handle_control(request(42, "secret", kind));
        wait_for_calls(&fake, 1);
        fake.release();
        assert_eq!(
            next(&mut rx).await,
            Response::PermissionRequested {
                req: 42,
                kind,
                state: PermissionState::Granted,
                self_responsible: None
            }
        );
    }
}

#[tokio::test]
async fn stalled_backend_does_not_block_session_and_lifecycle_controls() {
    let (mut manager, mut rx, fake) = setup();
    manager.handle_control(request(2, "secret", PermissionKind::Accessibility));
    wait_for_calls(&fake, 1);
    manager.handle_stdin("missing", b"hello");
    manager.handle_control(Control::Resize {
        tab_id: "missing".into(),
        cols: 80,
        rows: 24,
    });
    manager.handle_control(Control::ListSessions {
        req: 4,
        token: None,
    });
    manager.handle_control(Control::Disarm { req: 5 });
    assert!(matches!(
        rx.try_recv(),
        Ok(Response::SessionList { req: 4, .. })
    ));
    assert!(matches!(rx.try_recv(), Ok(Response::DisarmAck { req: 5 })));
    fake.release();
    assert!(matches!(
        next(&mut rx).await,
        Response::PermissionRequested { req: 2, .. }
    ));
}

#[cfg(unix)]
#[tokio::test]
async fn stalled_backend_allows_live_terminal_input_and_resize() {
    let (events, mut event_rx) = tokio::sync::mpsc::channel(64);
    let (responses, mut rx) = tokio::sync::mpsc::channel(64);
    let fake = Arc::new(Blocking::new());
    let mut manager = SessionManager::new(events, responses, Some("secret".into()), true);
    manager.set_permission_backend(fake.clone());
    manager.begin_connection();
    manager.handle_control(Control::Spawn {
        req: 1,
        tab_id: "live".into(),
        spec: termflow_pty_protocol::SpawnSpec {
            shell: "/bin/sh".into(),
            args: vec![
                "-c".into(),
                "read line; printf 'received:%s\\n' \"$line\"".into(),
            ],
            env: vec![],
            env_remove: vec![],
            cwd: None,
            cols: 80,
            rows: 24,
            initial_cursor_row: None,
        },
    });
    assert!(matches!(
        next(&mut rx).await,
        Response::Spawned { req: 1, .. }
    ));
    manager.handle_control(request(2, "secret", PermissionKind::Accessibility));
    wait_for_calls(&fake, 1);
    manager.handle_control(Control::Resize {
        tab_id: "live".into(),
        cols: 100,
        rows: 30,
    });
    manager.handle_stdin("live", b"hello\n");
    manager.handle_control(Control::ListSessions {
        req: 3,
        token: None,
    });
    assert!(matches!(
        next(&mut rx).await,
        Response::SessionList { req: 3, .. }
    ));
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut output = Vec::new();
        while let Some(event) = event_rx.recv().await {
            if let Data::Stdout { bytes, .. } = event {
                output.extend(bytes);
                if output
                    .windows(b"received:hello".len())
                    .any(|w| w == b"received:hello")
                {
                    return;
                }
            }
        }
        panic!("session exited before processing stdin");
    })
    .await
    .expect("terminal input stalled behind TCC");
    fake.release();
    assert!(matches!(
        next(&mut rx).await,
        Response::PermissionRequested { req: 2, .. }
    ));
    manager.handle_control(Control::Close {
        tab_id: "live".into(),
    });
}

#[tokio::test]
async fn coalesces_per_kind_and_answers_both() {
    let (mut manager, mut rx, fake) = setup();
    manager.handle_control(request(2, "secret", PermissionKind::Accessibility));
    wait_for_calls(&fake, 1);
    manager.handle_control(request(3, "secret", PermissionKind::Accessibility));
    manager.handle_control(request(4, "secret", PermissionKind::ScreenRecording));
    wait_for_calls(&fake, 2);
    assert_eq!(fake.calls.load(Ordering::SeqCst), 2);
    fake.release();
    let mut replies = vec![
        next(&mut rx).await,
        next(&mut rx).await,
        next(&mut rx).await,
    ];
    replies.sort_by_key(|r| match r {
        Response::PermissionRequested { req, .. } => *req,
        _ => 0,
    });
    for (req, kind) in [
        (2, PermissionKind::Accessibility),
        (3, PermissionKind::Accessibility),
        (4, PermissionKind::ScreenRecording),
    ] {
        assert_eq!(
            replies.remove(0),
            Response::PermissionRequested {
                req,
                kind,
                state: PermissionState::Granted,
                self_responsible: None
            }
        );
    }
}

#[tokio::test]
async fn closed_connection_drops_completion() {
    let (mut manager, mut rx, fake) = setup();
    manager.handle_control(Control::PermissionStatus {
        req: 10,
        token: "secret".into(),
    });
    wait_for_calls(&fake, 1);
    manager.end_connection();
    fake.release();
    assert!(tokio::time::timeout(Duration::from_millis(100), rx.recv())
        .await
        .is_err());
}

#[tokio::test]
async fn completion_after_replacement_is_delivered_only_to_new_waiter() {
    let (mut manager, mut rx, fake) = setup();
    manager.handle_control(Control::PermissionStatus {
        req: 10,
        token: "secret".into(),
    });
    wait_for_calls(&fake, 1);
    manager.end_connection();
    manager.begin_connection();
    manager.handle_control(Control::PermissionStatus {
        req: 11,
        token: "secret".into(),
    });
    assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
    fake.release();
    assert_eq!(
        next(&mut rx).await,
        Response::PermissionStatusReply {
            req: 11,
            accessibility: PermissionState::Granted,
            screen_recording: PermissionState::NotGranted,
            self_responsible: None
        }
    );
    assert!(tokio::time::timeout(Duration::from_millis(100), rx.recv())
        .await
        .is_err());
}
