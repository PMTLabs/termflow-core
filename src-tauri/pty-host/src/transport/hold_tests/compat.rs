//! Plan 054 T7: an old GUI never starts or keeps a holder, and never receives a
//! frame it cannot decode.
//!
//! The legacy codec here is a mirror of the pre-054 wire (`34e13ce`): the same
//! enums in the same order, WITHOUT the trailing MCP variants, decoded with
//! bincode exactly as a shipped GUI decodes. A new variant has an index the
//! mirror does not know, so it fails to decode.

use super::*;
use serde::{Deserialize, Serialize};

/// The pre-MCP `Response`: seven variants.
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
enum LegacyResponse {
    Spawned { req: u64, tab_id: String, pid: u32 },
    SpawnFailed { req: u64, tab_id: String, error: String },
    SessionList { req: u64, sessions: Vec<SessionMeta> },
    ArmAck { req: u64, deadline_ms: u64 },
    DisarmAck { req: u64 },
    AttachAck { req: u64, tab_id: String, alive: bool, tail_offset: u64 },
    ShutdownAck { req: u64 },
}

/// What a legacy GUI can receive. (`Ctrl` is never sent by a host; its payload
/// is a placeholder that keeps the variant indices.)
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
enum LegacyHostFrame {
    Ctrl(()),
    Resp(LegacyResponse),
    Data(Data),
}

/// The shipped pre-purpose, pre-token request shapes a legacy GUI serializes.
#[derive(Serialize)]
#[allow(dead_code)]
enum LegacyControl {
    Spawn,
    Resize,
    Close,
    ListSessions { req: u64 },
    Attach,
    ArmDetach,
    Disarm { req: u64 },
}

#[derive(Serialize)]
enum LegacyOutFrame {
    Ctrl(LegacyControl),
}

fn legacy_wire(c: LegacyControl) -> Vec<u8> {
    let payload = bincode::serialize(&LegacyOutFrame::Ctrl(c)).unwrap();
    let mut out = vec![termflow_pty_protocol::PROTOCOL_VERSION];
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(&payload);
    out
}

/// One raw frame payload from the host, `None` on EOF or after `limit`.
async fn raw_frame(gui: &mut Gui, limit: Duration) -> Option<Vec<u8>> {
    gui.io.limit = limit;
    let mut version = [0u8; 1];
    gui.io.read_exact(&mut version).await.ok()?;
    assert_eq!(version[0], termflow_pty_protocol::PROTOCOL_VERSION);
    let mut len = [0u8; 4];
    gui.io.read_exact(&mut len).await.ok()?;
    let mut payload = vec![0u8; u32::from_le_bytes(len) as usize];
    gui.io.read_exact(&mut payload).await.ok()?;
    Some(payload)
}

/// A new GUI's hold is running; an old GUI reconnects and sends `frames`
/// (serialized as a shipped GUI serializes them). Returns what it received,
/// every reply decoded with the legacy codec.
async fn old_gui_reconnects(tag: &str, frames: Vec<LegacyControl>, replies_wanted: usize) -> (Host, u16, Vec<u32>, Vec<LegacyResponse>) {
    let clock = Clock::new(0);
    let host = Host::start(tag, &clock);
    let port = free_port("127.0.0.1");
    let pids = offload(&host, spec(port, "127.0.0.1"), &["t1"]).await;
    assert!(wait_answers(port, Duration::from_secs(10)).await, "the new GUI's hold is running");

    let mut old = host.gui().await;
    for f in frames {
        old.io.write_all(&legacy_wire(f)).await.unwrap();
    }
    let mut replies = Vec::new();
    while replies.len() < replies_wanted {
        let payload = raw_frame(&mut old, Duration::from_secs(10)).await.expect("a reply");
        let frame: LegacyHostFrame = bincode::deserialize(&payload)
            .unwrap_or_else(|e| panic!("a legacy GUI cannot decode a reply from the host: {e} ({payload:?})"));
        if let LegacyHostFrame::Resp(r) = frame {
            replies.push(r);
        }
    }
    // Nothing else is ever sent on that connection (no MCP ack of any kind).
    assert!(raw_frame(&mut old, Duration::from_millis(400)).await.is_none(), "no further reply of any kind");
    assert!(wait_refuses(port, STOP_BOUND).await, "the port closes");
    assert!(!host.finished());
    assert!(pids.iter().all(|p| pid_is_alive(*p)), "the shell is adopted, not torn down");
    (host, port, pids, replies)
}

fn assert_t1_listed(reply: &LegacyResponse, req: u64, pid: u32) {
    match reply {
        LegacyResponse::SessionList { req: r, sessions } if *r == req => {
            assert_eq!(sessions.len(), 1);
            assert_eq!((sessions[0].tab_id.as_str(), sessions[0].pid, sessions[0].alive), ("t1", pid, true));
        }
        other => panic!("expected the session list, got {other:?}"),
    }
}

/// The serialized legacy frames `Disarm`, then a tokenless `ListSessions`: every
/// reply decodes with the legacy codec and none is a new variant; the port
/// closes and the shell is adopted. The tokenless `ListSessions` alone does the
/// same (the sequence above cannot tell them apart, because `Disarm` already
/// ends the hold).
#[tokio::test]
async fn legacy_frames_never_keep_a_holder() {
    let (_host, _port, pids, replies) = old_gui_reconnects(
        "legacy-frames",
        vec![LegacyControl::Disarm { req: 1 }, LegacyControl::ListSessions { req: 2 }],
        2,
    )
    .await;
    assert!(matches!(&replies[0], LegacyResponse::DisarmAck { req: 1 }), "{:?}", replies[0]);
    assert_t1_listed(&replies[1], 2, pids[0]);

    let (_host, _port, pids, replies) =
        old_gui_reconnects("legacy-list-only", vec![LegacyControl::ListSessions { req: 3 }], 1).await;
    assert_t1_listed(&replies[0], 3, pids[0]);
}
