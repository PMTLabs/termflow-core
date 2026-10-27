use super::*;
use crate::state::permissions::{OtherHostReason, OtherHost};
use std::sync::Mutex;

struct Fake {
    target: PermissionTarget,
    calls: Mutex<Vec<&'static str>>,
    fail: bool,
    fail_status: bool,
}
impl PermissionPort for Fake {
    type Host = u32;
    async fn subject(&self) -> Subject<u32> {
        self.calls.lock().unwrap().push("resolve");
        if self.target == PermissionTarget::Host { self.calls.lock().unwrap().push("host-status"); }
        Subject { view: PermissionSubject { target: self.target, subject: SubjectIdentity { pid: Some(11), generation: Some("one".into()), bundle_id: None }, other_hosts: vec![], app_sessions: false }, host: (self.target == PermissionTarget::Host).then_some(11), status: Some((PermState::NotGranted, PermState::Granted)), resolution_failed: false }
    }
    async fn host_status(&self, host: &u32) -> Result<(PermState, PermState), ()> {
        assert_eq!(*host, 11);
        self.calls.lock().unwrap().push("host-status");
        if self.fail || self.fail_status { Err(()) } else { Ok((PermState::Granted, PermState::NotGranted)) }
    }
    async fn host_request(&self, host: &u32, kind: PermissionKind) -> Result<(), ()> {
        assert_eq!(*host, 11);
        assert_eq!(kind, PermissionKind::ScreenRecording);
        self.calls.lock().unwrap().push("host-request");
        if self.fail { Err(()) } else { Ok(()) }
    }
    async fn app_status(&self) -> Result<(PermState, PermState), ()> {
        self.calls.lock().unwrap().push("app-status");
        if self.fail { Err(()) } else { Ok((PermState::Granted, PermState::NotGranted)) }
    }
    async fn app_request(&self, kind: PermissionKind) -> Result<(), ()> {
        assert_eq!(kind, PermissionKind::ScreenRecording);
        self.calls.lock().unwrap().push("app-request");
        if self.fail { Err(()) } else { Ok(()) }
    }
}

#[tokio::test]
async fn dispatch_table_uses_one_subject_and_never_falls_back() {
    for target in [PermissionTarget::Host, PermissionTarget::HostLegacy, PermissionTarget::App, PermissionTarget::Unresolved] {
        for request in [false, true] {
            let fake = Fake { target, calls: Mutex::new(vec![]), fail: false, fail_status: false };
            let result = execute(&fake, request.then_some(PermissionKind::ScreenRecording), 1).await;
            let expected: &[&str] = match (target, request) {
                (PermissionTarget::Host, false) => &["resolve", "host-status"],
                (PermissionTarget::Host, true) => &["resolve", "host-status", "host-request", "host-status"],
                (PermissionTarget::App, false) => &["resolve", "app-status"],
                (PermissionTarget::App, true) => &["resolve", "app-request", "app-status"],
                _ => &["resolve"],
            };
            assert_eq!(*fake.calls.lock().unwrap(), expected, "{target:?} {request}");
            assert_eq!(result.target, target);
            assert_eq!(result.subject.pid, Some(11));
            if matches!(target, PermissionTarget::HostLegacy | PermissionTarget::Unresolved) {
                assert_eq!((result.accessibility, result.screen_recording), (PermState::Unknown, PermState::Unknown));
            }
        }
    }
    let fake = Fake { target: PermissionTarget::Host, calls: Mutex::new(vec![]), fail: true, fail_status: false };
    let result = execute(&fake, Some(PermissionKind::ScreenRecording), 1).await;
    assert_eq!((result.accessibility, result.screen_recording), (PermState::Unknown, PermState::Unknown));
    assert!(result.error.is_some());
    assert_eq!(*fake.calls.lock().unwrap(), ["resolve", "host-status", "host-request"]);
    let fake = Fake { target: PermissionTarget::Host, calls: Mutex::new(vec![]), fail: false, fail_status: true };
    let result = execute(&fake, Some(PermissionKind::ScreenRecording), 2).await;
    assert_eq!((result.accessibility, result.screen_recording), (PermState::Unknown, PermState::Unknown));
    assert!(result.error.is_some());
    assert_eq!(*fake.calls.lock().unwrap(), ["resolve", "host-status", "host-request", "host-status"]);
    let fake = Fake { target: PermissionTarget::App, calls: Mutex::new(vec![]), fail: true, fail_status: false };
    for kind in [None, Some(PermissionKind::ScreenRecording)] {
        let result = execute(&fake, kind, 3).await;
        assert!(result.error.is_some());
        assert_eq!((result.accessibility, result.screen_recording), (PermState::Unknown, PermState::Unknown));
    }
}

#[tokio::test]
async fn changed_expected_subject_never_requests() {
    let fake = Fake { target: PermissionTarget::Unresolved, calls: Mutex::new(vec![]), fail: false, fail_status: false };
    let view = execute_expected(&fake, Some(PermissionKind::ScreenRecording), 1, Some(ExpectedSubject { target: PermissionTarget::Host, subject: SubjectIdentity::default() })).await;
    assert_eq!(view.error.as_deref(), Some("The permission target changed; nothing was requested"));
    assert_eq!(*fake.calls.lock().unwrap(), ["resolve"]);
    assert!(execute(&fake, None, 2).await.error.is_none());
}

struct ResolutionFailure;
impl PermissionPort for ResolutionFailure {
    type Host = ();
    async fn subject(&self) -> Subject<()> {
        Subject { view: PermissionSubject { target: PermissionTarget::Unresolved, subject: SubjectIdentity::default(), other_hosts: vec![], app_sessions: false }, host: None, status: None, resolution_failed: true }
    }
    async fn host_status(&self, _: &()) -> Result<(PermState, PermState), ()> { panic!("unexpected host call") }
    async fn host_request(&self, _: &(), _: PermissionKind) -> Result<(), ()> { panic!("unexpected host call") }
    async fn app_status(&self) -> Result<(PermState, PermState), ()> { panic!("unexpected app fallback") }
    async fn app_request(&self, _: PermissionKind) -> Result<(), ()> { panic!("unexpected app fallback") }
}

#[tokio::test]
async fn resolution_failure_surfaces_without_fallback() {
    for kind in [None, Some(PermissionKind::Accessibility)] {
        let result = execute(&ResolutionFailure, kind, 1).await;
        assert!(result.error.is_some());
        assert_eq!((result.accessibility, result.screen_recording), (PermState::Unknown, PermState::Unknown));
    }
}

impl Inventory for crate::state::permissions::WireInventory {
    async fn resolve(&self) -> crate::state::permissions::ResolvedPermissionSubject { self.resolve().await }
    fn app_call(&self) { panic!("app FFI must never be called") }
}

// Real SystemPort -> inventory resolver -> real WireClient, including follow-up
// status and request dispatch. The injected app boundary panics before any FFI.
async fn system_wire_case(case: u8) {
    use termflow_pty_protocol::{read_frame, write_frame, Control, Frame, Response, PermissionState as P};
    let (client, mut peer, _) = crate::pty_host_client::conn_tests::wired();
    client.set_permissions(true);
    let _keep_connected = client.clone();
    let task = tokio::spawn(async move {
        let inventory = crate::state::permissions::WireInventory(vec![client]);
        let expected = (case == 2).then(|| ExpectedSubject { target: PermissionTarget::Host, subject: SubjectIdentity { pid: Some(999), ..Default::default() } });
        execute_expected(&SystemPort(&inventory), Some(PermissionKind::Accessibility), 17, expected).await
    });
    let mut requests = 0;
    let mut statuses = 0;
    loop {
        tokio::select! {
            result = async { while !task.is_finished() { tokio::task::yield_now().await; } } => { let _ = result; break; }
            frame = read_frame(&mut peer) => {
                let response = match frame.unwrap().unwrap() {
                    Frame::Ctrl(Control::PermissionStatus { req, .. }) => {
                        statuses += 1;
                        let state = if case == 0 || statuses == 2 { P::Unknown } else { P::Granted };
                        Response::PermissionStatusReply { req, accessibility: state, screen_recording: state, self_responsible: Some(true) }
                    }
                    Frame::Ctrl(Control::RequestPermission { req, kind, .. }) => {
                        requests += 1;
                        Response::PermissionRequested { req, kind, state: P::Granted, self_responsible: Some(true) }
                    }
                    other => panic!("unexpected frame: {other:?}"),
                };
                write_frame(&mut peer, &Frame::Resp(response)).await.unwrap();
            }
        }
    }
    let view = task.await.unwrap();
    assert_eq!(requests, usize::from(case == 1), "captured RequestPermission frames");
    assert_eq!(statuses, if case == 1 { 2 } else { 1 });
    let json = serde_json::to_value(view).unwrap();
    assert!(json["error"].is_string(), "{json}");
    assert_eq!(json["accessibility"], "unknown");
    assert_eq!(json["screenRecording"], "unknown");
}
#[tokio::test]
async fn system_initial_unknown() { system_wire_case(0).await; }
#[tokio::test]
async fn system_followup_unknown() { system_wire_case(1).await; }
#[tokio::test]
async fn system_expected_mismatch() { system_wire_case(2).await; }

struct WirePort { client: PtyHostClient, target: PermissionTarget }
impl PermissionPort for WirePort {
    type Host = PtyHostClient;
    async fn subject(&self) -> Subject<PtyHostClient> {
        let status = if self.target == PermissionTarget::Host {
            match self.client.permission_status().await { Ok(PermissionOutcome::Reply(s)) => Some(host_states(s)), _ => None }
        } else { None };
        Subject { view: PermissionSubject { target: self.target, subject: SubjectIdentity::default(), other_hosts: vec![], app_sessions: false }, host: Some(self.client.clone()), status, resolution_failed: false }
    }
    async fn host_status(&self, client: &PtyHostClient) -> Result<(PermState, PermState), ()> {
        match client.permission_status().await { Ok(PermissionOutcome::Reply(s)) => Ok(host_states(s)), _ => Err(()) }
    }
    async fn host_request(&self, client: &PtyHostClient, kind: PermissionKind) -> Result<(), ()> {
        match client.request_permission(kind.into()).await { Ok(PermissionOutcome::Reply(_)) => Ok(()), _ => Err(()) }
    }
    async fn app_status(&self) -> Result<(PermState, PermState), ()> { panic!("unexpected app fallback") }
    async fn app_request(&self, _: PermissionKind) -> Result<(), ()> { panic!("unexpected app fallback") }
}

#[tokio::test]
async fn captured_wire_frames_are_exact_and_legacy_writes_nothing() {
    use termflow_pty_protocol::{read_frame, write_frame, Control, Frame, Response, PermissionState};
    use tokio::io::AsyncReadExt;
    let (client, mut peer, _) = crate::pty_host_client::conn_tests::wired();
    client.set_permissions(true);
    let task = tokio::spawn(async move { execute(&WirePort { client, target: PermissionTarget::Host }, Some(PermissionKind::ScreenRecording), 1).await });
    for index in 0..3 {
        let frame = read_frame(&mut peer).await.unwrap().unwrap();
        let response = match (index, frame) {
            (0 | 2, Frame::Ctrl(Control::PermissionStatus { req, token })) => { assert_eq!(token, "tok"); Response::PermissionStatusReply { req, accessibility: PermissionState::Granted, screen_recording: PermissionState::NotGranted, self_responsible: Some(true) } }
            (1, Frame::Ctrl(Control::RequestPermission { req, token, kind })) => { assert_eq!(token, "tok"); assert_eq!(kind, termflow_pty_protocol::PermissionKind::ScreenRecording); Response::PermissionRequested { req, kind, state: PermissionState::Granted, self_responsible: Some(true) } }
            (_, other) => panic!("unexpected frame {index}: {other:?}"),
        };
        write_frame(&mut peer, &Frame::Resp(response)).await.unwrap();
    }
    let view = task.await.unwrap();
    assert_eq!(view.accessibility, PermState::Granted);
    assert_eq!(view.screen_recording, PermState::NotGranted);
    let (client, mut peer, _) = crate::pty_host_client::conn_tests::wired();
    let port = WirePort { client, target: PermissionTarget::HostLegacy };
    let view = execute(&port, Some(PermissionKind::ScreenRecording), 2).await;
    assert_eq!(view.target, PermissionTarget::HostLegacy);
    let mut bytes = [0u8; 512];
    assert!(tokio::time::timeout(std::time::Duration::from_millis(100), peer.read(&mut bytes)).await.is_err(), "legacy host received bytes");
}

#[test]
fn epoch_and_contract() {
    let a = next_epoch().unwrap();
    let b = next_epoch().unwrap();
    assert!(b > a);
    let stub = unsupported(b, true);
    assert_eq!(stub.target, PermissionTarget::App);
    assert_eq!((stub.accessibility, stub.screen_recording), (PermState::Unsupported, PermState::Unsupported));
    assert!(stub.app_sessions);
    let view = PermissionView { epoch: b, target: PermissionTarget::HostLegacy, subject: SubjectIdentity { pid: Some(1), generation: None, bundle_id: Some("id".into()) }, accessibility: PermState::NotGranted, screen_recording: PermState::Unknown, other_hosts: vec![OtherHost { pid: 2, generation: None, reason: OtherHostReason::DifferentIdentity }], app_sessions: true, error: Some("failed".into()) };
    let json = serde_json::to_value(view).unwrap();
    assert_eq!(json["target"], "hostLegacy");
    assert_eq!(json["accessibility"], "notGranted");
    assert_eq!(json["screenRecording"], "unknown");
    assert_eq!(json["subject"]["bundleId"], "id");
    assert_eq!(json["otherHosts"][0]["reason"], "differentIdentity");
    assert_eq!(json["appSessions"], true);
    assert_eq!(json["error"], "failed");
    assert!(serde_json::to_value(stub).unwrap().get("error").is_none());
    assert_eq!(serde_json::from_str::<PermissionKind>("\"screenRecording\"").unwrap(), PermissionKind::ScreenRecording);
}

#[test]
fn invoke_names_match_bridge() {
    let lib = include_str!("../lib.rs");
    let bridge = include_str!("../../../src/renderer/api/tauri-bridge.ts");
    for (registration, name) in [("commands::macos_permission_status", "macos_permission_status"), ("commands::request_macos_permission", "request_macos_permission"), ("open_commands::open_permission_pane", "open_permission_pane")] {
        assert!(lib.contains(registration));
        assert!(bridge.contains(&format!("invoke('{name}'")));
    }
}
