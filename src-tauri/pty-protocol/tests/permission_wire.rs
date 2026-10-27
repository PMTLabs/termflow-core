use termflow_pty_protocol::{decode, encode, ArmDetachPurpose, Control, Data, Frame, McpHeld, McpHoldReason, McpHoldSpec, PermissionKind, PermissionState, Response, SessionMeta, SpawnSpec, CAP_PERMISSIONS};
use serde::Deserialize;

fn old_frames() -> Vec<Frame> {
    let t = || "tab".to_string();
    let token = || "tok".to_string();
    let spec = SpawnSpec { shell: "sh".into(), args: vec!["-l".into()], env: vec![("K".into(), "V".into())], env_remove: vec!["X".into()], cwd: Some("/tmp".into()), cols: 80, rows: 24, initial_cursor_row: Some(2) };
    let hold = McpHoldSpec { port: 42, configured_port: 43, bind_host: "::1".into(), auth_token: Some("a".into()), reason: McpHoldReason::Relaunch, initialize_result: Some("{}".into()), tools_list_result: Some("[]".into()) };
    let sessions = vec![SessionMeta { tab_id: t(), pid: 17, head_offset: 3, tail_offset: 8, alive: true }];
    vec![
        Frame::Ctrl(Control::Spawn { req: 7, tab_id: t(), spec }),
        Frame::Ctrl(Control::Resize { tab_id: t(), cols: 80, rows: 24 }),
        Frame::Ctrl(Control::Close { tab_id: t() }),
        Frame::Ctrl(Control::ListSessions { req: 7, token: Some(token()) }),
        Frame::Ctrl(Control::Attach { req: 7, tab_id: t(), from_offset: 8 }),
        Frame::Ctrl(Control::ArmDetach { req: 7, timeout_secs: 60, token: token(), purpose: Some(ArmDetachPurpose::Local) }),
        Frame::Ctrl(Control::Disarm { req: 7 }),
        Frame::Ctrl(Control::AttachAcked { req: 7, tab_id: t(), from_offset: 8 }),
        Frame::Ctrl(Control::Shutdown { req: 7, token: token() }),
        Frame::Ctrl(Control::HoldMcp { req: 7, token: token(), spec: hold }),
        Frame::Ctrl(Control::ClaimMcp { req: 7, token: token() }),
        Frame::Ctrl(Control::ReleaseMcp { req: 7, token: token() }),
        Frame::Resp(Response::Spawned { req: 7, tab_id: t(), pid: 17 }),
        Frame::Resp(Response::SpawnFailed { req: 7, tab_id: t(), error: "err".into() }),
        Frame::Resp(Response::SessionList { req: 7, sessions }),
        Frame::Resp(Response::ArmAck { req: 7, deadline_ms: 13 }),
        Frame::Resp(Response::DisarmAck { req: 7 }),
        Frame::Resp(Response::AttachAck { req: 7, tab_id: t(), alive: true, tail_offset: 8 }),
        Frame::Resp(Response::ShutdownAck { req: 7 }),
        Frame::Resp(Response::McpHoldAck { req: 7, accepted: false, reason: Some("no".into()) }),
        Frame::Resp(Response::McpClaimAck { req: 7, held: Some(McpHeld { port: 42, configured_port: 43, bind_host: "::1".into() }) }),
        Frame::Resp(Response::McpReleaseAck { req: 7, was_holding: true }),
        Frame::Data(Data::Stdout { tab_id: t(), offset: 8, bytes: vec![1, 2] }),
        Frame::Data(Data::Gap { tab_id: t(), at_offset: 8 }),
        Frame::Data(Data::Exit { tab_id: t(), exit_cwd: Some("/tmp".into()) }),
    ]
}

/// Golden bytes captured from commit 2b6d1eb's encoder using these exact fixtures.
#[test]
fn existing_control_and_response_layouts_match_base_goldens() {
    let frames = old_frames();
    let goldens: Vec<_> = include_str!("permission_wire_golden.txt").lines().collect();
    assert_eq!(frames.len(), goldens.len());
    for (frame, golden) in frames.iter().zip(goldens) {
        let actual = encode(frame).iter().map(|b| format!("{b:02x}")).collect::<String>();
        assert_eq!(actual, golden, "{frame:?}");
    }
}

#[test]
fn every_permission_frame_kind_and_state_roundtrips() {
    assert_eq!(CAP_PERMISSIONS, 1 << 6);
    let kinds = [PermissionKind::Accessibility, PermissionKind::ScreenRecording];
    let states = [PermissionState::Granted, PermissionState::NotGranted, PermissionState::Unsupported, PermissionState::Unknown];
    let mut frames = vec![Frame::Ctrl(Control::PermissionStatus { req: 19, token: "tok".into() })];
    for kind in kinds {
        frames.push(Frame::Ctrl(Control::RequestPermission { req: 20, token: "tok".into(), kind }));
        for state in states {
            frames.push(Frame::Resp(Response::PermissionRequested { req: 21, kind, state }));
        }
    }
    for accessibility in states {
        for screen_recording in states {
            frames.push(Frame::Resp(Response::PermissionStatusReply { req: 22, accessibility, screen_recording }));
        }
    }
    for frame in frames {
        let bytes = encode(&frame);
        assert_eq!(decode(bytes[0], &bytes[5..]).unwrap(), frame);
    }
}

// Mirror of the codec immediately before this change; only host-to-client
// variants matter. A real non-capable client never sends permission controls.
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
enum OldResponse {
    Spawned { req: u64, tab_id: String, pid: u32 },
    SpawnFailed { req: u64, tab_id: String, error: String },
    SessionList { req: u64, sessions: Vec<SessionMeta> },
    ArmAck { req: u64, deadline_ms: u64 },
    DisarmAck { req: u64 },
    AttachAck { req: u64, tab_id: String, alive: bool, tail_offset: u64 },
    ShutdownAck { req: u64 },
    McpHoldAck { req: u64, accepted: bool, reason: Option<String> },
    McpClaimAck { req: u64, held: Option<McpHeld> },
    McpReleaseAck { req: u64, was_holding: bool },
}
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
enum OldHostFrame { Ctrl(()), Resp(OldResponse), Data(Data) }

#[test]
fn non_capable_client_can_decode_all_old_host_frames() {
    for frame in old_frames().into_iter().filter(|f| !matches!(f, Frame::Ctrl(_))) {
        let bytes = encode(&frame);
        bincode::deserialize::<OldHostFrame>(&bytes[5..]).unwrap_or_else(|e| panic!("{frame:?}: {e}"));
    }
    for frame in [
        Frame::Resp(Response::PermissionStatusReply { req: 1, accessibility: PermissionState::Granted, screen_recording: PermissionState::NotGranted }),
        Frame::Resp(Response::PermissionRequested { req: 2, kind: PermissionKind::Accessibility, state: PermissionState::Granted }),
    ] {
        assert!(bincode::deserialize::<OldHostFrame>(&encode(&frame)[5..]).is_err());
    }
}
