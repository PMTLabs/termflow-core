use super::*;
use std::time::Duration;
use termflow_pty_protocol::read_frame;

#[tokio::test]
async fn exhausted_wire_request_ids_enqueue_nothing_and_leave_no_pending_reply() {
    let (client, mut peer, _) = super::conn_tests::wired();
    client.req_ctr.store(u64::MAX - 1, Ordering::Release);
    client.attach("control", 9);
    let control = tokio::time::timeout(Duration::from_secs(3), read_frame(&mut peer)).await.unwrap().unwrap().unwrap();
    assert!(matches!(control, Frame::Ctrl(Control::Attach { req, tab_id, from_offset: 9 }) if req == u64::MAX - 1 && tab_id == "control"));
    client.attach("stale", 0);
    client.set_attach_acks(true);
    let session_key = "stale";
    assert_eq!(client.attach_confirmed(session_key, 0).await, None);
    assert!(client.list_sessions_numbered().await.is_none());
    let keys = crate::state::HostKeys::default();
    let channel = crate::elevated_host::HostChannel::Primary;
    client.bind_sessions(&keys, channel, 1);
    let (stage, _) = keys.stage(channel, "owned-control", crate::state::StageMode::Spawn).unwrap();
    assert!(keys.complete(&stage, "pc-control"));
    let identity = keys.session_identity(channel, "owned-control", "pc-control").unwrap();
    for ack in [false, true] {
        client.set_attach_acks(ack);
        assert_eq!(client.attach_owned(&identity, 0).await.unwrap_err(), "terminal host request identity exhausted");
    }
    assert!(!client.disarm().await);
    assert_eq!(client.pending_requests(), 0);
    assert_eq!(client.req_ctr.load(Ordering::Acquire), u64::MAX);
    // Non-request traffic remains usable and fences the absence of requests.
    let session_key = "live-control";
    client.resize(session_key, 93, 37);
    let fence = tokio::time::timeout(Duration::from_secs(3), read_frame(&mut peer)).await.unwrap().unwrap().unwrap();
    assert!(matches!(fence, Frame::Ctrl(Control::Resize { tab_id, cols: 93, rows: 37 }) if tab_id == "live-control"));
    assert!(client.close_transport().await);
}
