use super::*;
use termflow_pty_protocol::{read_frame, write_frame, PermissionKind, PermissionState};
use tokio::io::AsyncReadExt;
use std::time::Duration;

#[tokio::test]
async fn legacy_gate_writes_no_bytes() {
    let (client, mut peer, _) = conn_tests::wired();
    assert_eq!(client.permission_status().await.unwrap(), PermissionOutcome::NotCapable);
    assert_eq!(client.request_permission(PermissionKind::Accessibility).await.unwrap(), PermissionOutcome::NotCapable);
    let mut captured = [0u8; 1024];
    assert!(tokio::time::timeout(Duration::from_millis(100), peer.read(&mut captured)).await.is_err(), "legacy client must write no frames");
    assert!(client.pending.lock().unwrap().is_empty());
}

#[tokio::test]
async fn concurrent_replies_are_demultiplexed_and_unknown_req_ignored() {
    let (client, mut peer, _) = conn_tests::wired();
    client.set_permissions(true);
    let a = { let c = client.clone(); tokio::spawn(async move { c.permission_status().await }) };
    let b = { let c = client.clone(); tokio::spawn(async move { c.request_permission(PermissionKind::ScreenRecording).await }) };
    let mut status_req = None;
    let mut request_req = None;
    for _ in 0..2 {
        match read_frame(&mut peer).await.unwrap().unwrap() {
            Frame::Ctrl(Control::PermissionStatus { req, token }) => { assert_eq!(token, "tok"); status_req = Some(req); }
            Frame::Ctrl(Control::RequestPermission { req, token, kind }) => { assert_eq!(token, "tok"); assert_eq!(kind, PermissionKind::ScreenRecording); request_req = Some(req); }
            frame => panic!("unexpected {frame:?}"),
        }
    }
    let (s, r) = (status_req.unwrap(), request_req.unwrap());
    assert_ne!(s, r);
    write_frame(&mut peer, &Frame::Resp(Response::PermissionStatusReply { req: u64::MAX, accessibility: PermissionState::Unsupported, screen_recording: PermissionState::Unsupported, self_responsible: None })).await.unwrap();
    write_frame(&mut peer, &Frame::Resp(Response::PermissionRequested { req: r, kind: PermissionKind::ScreenRecording, state: PermissionState::Granted, self_responsible: Some(false) })).await.unwrap();
    write_frame(&mut peer, &Frame::Resp(Response::PermissionStatusReply { req: s, accessibility: PermissionState::NotGranted, screen_recording: PermissionState::Granted, self_responsible: Some(true) })).await.unwrap();
    assert_eq!(a.await.unwrap().unwrap(), PermissionOutcome::Reply(PermissionStatus { accessibility: PermissionState::NotGranted, screen_recording: PermissionState::Granted, self_responsible: Some(true) }));
    assert_eq!(b.await.unwrap().unwrap(), PermissionOutcome::Reply(PermissionRequest { kind: PermissionKind::ScreenRecording, state: PermissionState::Granted, self_responsible: Some(false) }));
}
