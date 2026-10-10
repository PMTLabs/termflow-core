use super::fake_hosts::{meta, EventGate, HostSpec, World};
use std::sync::Arc;
use std::future::{poll_fn, Future};
use std::task::Poll;
use std::time::Duration;
use termflow_pty_protocol::{read_frame, write_frame, Control, Data, Frame, Response, SpawnSpec};

async fn receive(stream: &mut tokio::io::DuplexStream) -> Frame {
    tokio::time::timeout(Duration::from_secs(3), read_frame(stream)).await
        .expect("frame deadline").unwrap().unwrap()
}

#[tokio::test]
async fn request_holds_are_observable_and_do_not_delay_another_host() {
    for kind in ["Spawn", "Attach", "List", "Close"] {
        let world = World::new();
        let gate = Arc::new(EventGate::default());
        world.add_host("held", HostSpec {
            sessions: vec![meta("held-key", 101)],
            reply_gates: [(kind, gate.clone())].into_iter().collect(),
            ..HostSpec::default()
        });
        world.add_host("control", HostSpec { sessions: vec![meta("control-key", 202)], ..HostSpec::default() });
        let mut held = world.open("held").unwrap();
        let mut control = world.open("control").unwrap();
        let request = match kind {
            "Spawn" => Control::Spawn { req: 7, tab_id: "held-key".into(), spec: SpawnSpec {
                shell: "fake".into(), args: vec![], env: vec![], env_remove: vec![], cwd: None, cols: 80, rows: 24,
                initial_cursor_row: None,
            } },
            "Attach" => Control::AttachAcked { req: 7, tab_id: "held-key".into(), from_offset: 0 },
            "List" => Control::ListSessions { req: 7, token: None },
            _ => Control::Close { tab_id: "held-key".into() },
        };
        write_frame(&mut held, &Frame::Ctrl(request.clone())).await.unwrap();
        // Close has no response: use its following FIFO listing as the completion witness.
        if kind == "Close" {
            write_frame(&mut held, &Frame::Ctrl(Control::ListSessions { req: 7, token: None })).await.unwrap();
        }
        gate.wait_reached(1).await;
        assert_eq!(gate.count(), 1);
        assert_eq!(world.count("held", kind), 1);
        write_frame(&mut control, &Frame::Ctrl(Control::ListSessions { req: 8, token: None })).await.unwrap();
        assert_eq!(receive(&mut control).await, Frame::Resp(Response::SessionList {
            req: 8, sessions: vec![meta("control-key", 202)],
        }));
        assert_eq!(world.count("control", "List"), 1);
        // Poll without a timer: an ungated response would already be in the duplex buffer.
        let mut pending = Box::pin(read_frame(&mut held));
        assert!(poll_fn(|cx| Poll::Ready(pending.as_mut().poll(cx).is_pending())).await);
        drop(pending);
        gate.release();
        let expected = match kind {
            "Spawn" => Response::Spawned { req: 7, tab_id: "held-key".into(), pid: 4242 },
            "Attach" => Response::AttachAck { req: 7, tab_id: "held-key".into(), alive: true, tail_offset: 0 },
            "List" => Response::SessionList { req: 7, sessions: vec![meta("held-key", 101)] },
            _ => Response::SessionList { req: 7, sessions: vec![] },
        };
        assert_eq!(receive(&mut held).await, Frame::Resp(expected));
        if kind != "List" {
            assert_eq!(world.frames_for_session("held", "held-key"), vec![Frame::Ctrl(request)]);
        }
    }
}

#[tokio::test]
async fn unsolicited_frames_can_be_held_and_delivered_after_close_on_an_exact_connection() {
    let world = World::new();
    world.add_host("host", HostSpec { sessions: vec![meta("key", 303)], ..HostSpec::default() });
    let mut old = world.open("host").unwrap();
    let mut other = world.open("host").unwrap();
    write_frame(&mut old, &Frame::Ctrl(Control::Close { tab_id: "key".into() })).await.unwrap();
    write_frame(&mut old, &Frame::Ctrl(Control::ListSessions { req: 9, token: None })).await.unwrap();
    assert_eq!(receive(&mut old).await, Frame::Resp(Response::SessionList { req: 9, sessions: vec![] }));
    assert_eq!(world.sessions("host", "Close"), vec!["key"]);
    for data in [
        Data::Stdout { tab_id: "key".into(), offset: 42, bytes: b"late".to_vec() },
        Data::Exit { tab_id: "key".into(), exit_cwd: Some("late-cwd".into()) },
        Data::Gap { tab_id: "key".into(), at_offset: 99 },
    ] {
        let frame = Frame::Data(data);
        let gate = Arc::new(EventGate::default());
        world.inject_frame("host", 0, frame.clone(), Some(gate.clone()));
        gate.wait_reached(1).await;
        assert_eq!(gate.count(), 1);
        let control = Frame::Data(Data::Stdout { tab_id: "control".into(), offset: 1, bytes: vec![77] });
        world.inject_frame("host", 1, control.clone(), None);
        assert_eq!(receive(&mut other).await, control.clone());
        world.inject_frame("host", 0, control.clone(), None);
        assert_eq!(receive(&mut old).await, control);
        let mut pending = Box::pin(read_frame(&mut old));
        assert!(poll_fn(|cx| Poll::Ready(pending.as_mut().poll(cx).is_pending())).await);
        drop(pending);
        gate.release();
        assert_eq!(receive(&mut old).await, frame);
    }
}

/// 054: the fake host WITHOUT the MCP bit is what the 055/056 sender tests send
/// nothing to. Its record lacks the bit, and if a frame did reach it the
/// connection would drop, as a shipped host's does on an unknown variant. A host
/// WITH the bit answers all three.
#[tokio::test]
async fn a_host_without_the_mcp_bit_drops_the_connection_on_an_mcp_frame() {
    use super::fake_hosts::{record, record_with_mcp_hold};
    use termflow_pty_protocol::{CAP_MCP_HOLD, PROTOCOL_MAX, PROTOCOL_MIN};
    assert_eq!(record("h", PROTOCOL_MIN, PROTOCOL_MAX).capabilities & CAP_MCP_HOLD, 0);
    assert_eq!(record_with_mcp_hold("h", PROTOCOL_MIN, PROTOCOL_MAX).capabilities & CAP_MCP_HOLD, CAP_MCP_HOLD);

    let hold = || Control::HoldMcp {
        req: 7,
        token: "t".into(),
        spec: termflow_pty_protocol::McpHoldSpec {
            port: 1,
            configured_port: 1,
            bind_host: "127.0.0.1".into(),
            auth_token: None,
            reason: termflow_pty_protocol::McpHoldReason::Offload,
            initialize_result: None,
            tools_list_result: None,
        },
    };
    let world = World::new();
    world.add_host("old", HostSpec::default());
    world.add_host("new", HostSpec { mcp_hold: true, ..HostSpec::default() });

    let mut old = world.open("old").unwrap();
    write_frame(&mut old, &Frame::Ctrl(hold())).await.unwrap();
    let ended = tokio::time::timeout(Duration::from_secs(3), read_frame(&mut old)).await.expect("the host reacts");
    assert!(matches!(ended, Ok(None) | Err(_)), "no reply, the connection is gone: {ended:?}");
    assert_eq!(world.count("old", "HoldMcp"), 1, "the frame is recorded before the drop");

    let mut new = world.open("new").unwrap();
    write_frame(&mut new, &Frame::Ctrl(hold())).await.unwrap();
    assert_eq!(receive(&mut new).await, Frame::Resp(Response::McpHoldAck { req: 7, accepted: true, reason: None }));
    write_frame(&mut new, &Frame::Ctrl(Control::ClaimMcp { req: 8, token: "t".into() })).await.unwrap();
    assert_eq!(receive(&mut new).await, Frame::Resp(Response::McpClaimAck { req: 8, held: None }));
    write_frame(&mut new, &Frame::Ctrl(Control::ReleaseMcp { req: 9, token: "t".into() })).await.unwrap();
    assert_eq!(receive(&mut new).await, Frame::Resp(Response::McpReleaseAck { req: 9, was_holding: false }));
    assert_eq!(world.kinds("new"), vec!["HoldMcp", "ClaimMcp", "ReleaseMcp"]);
}
