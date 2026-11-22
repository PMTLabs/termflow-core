use super::*;
use crate::ssh::tests::{hop, Fixture, Server};
use std::{cell::Cell, sync::atomic::Ordering, time::Duration};

const PIPELINE: u64 = 1;
const LEAF: &str = "tm-a";
const PROCESS: &str = "pc-a";
const PREFIX: &[u8] = b"\x1b]7;file://target.test/";
const COMPLETE: &[u8] = b"\x1b]7;file://target.test/ok\x07";

#[derive(Default)]
struct Capture(parking_lot::Mutex<Vec<CwdEvent>>);
impl CwdEventSink for Capture {
    fn emit_cwd(&self, event: CwdEvent) {
        self.0.lock().push(event);
    }
}
impl Capture {
    fn take(&self) -> Vec<CwdEvent> {
        std::mem::take(&mut *self.0.lock())
    }
}

fn fixture(server: Server) -> Fixture {
    Fixture::new(server, vec![hop("c-a", "alice")], true)
}

async fn connected() -> Fixture {
    let f = fixture(Server::new(1, "alice"));
    f.connected().await;
    f.registry.begin_cwd_pipeline(PIPELINE);
    f
}

fn leaf(process_id: &str) -> Option<String> {
    (process_id == PROCESS).then(|| LEAF.into())
}

fn payload(process_id: &str, data: &[u8]) -> ChannelPayload {
    ChannelPayload { id: process_id.into(), data: data.to_vec() }
}

fn feed(registry: &SessionRegistry, bytes: &[u8]) {
    registry.feed_remote_cwd(PIPELINE, &payload(PROCESS, bytes), leaf);
}

fn flush(registry: &SessionRegistry) -> Vec<CwdEvent> {
    let capture = Capture::default();
    registry.flush_remote_cwd(PIPELINE, leaf, &capture);
    capture.take()
}

#[test]
fn local_osc99_legacy_cwd_behavior_unchanged() {
    let raw = b"\x1b]9;9;D:\\a%20\x07  \x1b]9;9;D:\\b%20\x1b\\";
    assert_eq!(crate::pty_manager::parse_osc_cwd(raw).as_deref(), Some("D:\\b%20"));
    Osc7::default().feed(raw, |_| panic!("local OSC 9;9 entered remote follow"));
}

#[tokio::test]
#[allow(non_snake_case)]
async fn remote_event_uses_terminalId_not_processId() {
    let f = connected().await;
    let r = &f.registry;
    feed(r, b"\x1b]7;file://target.test/first\x07");
    feed(r, COMPLETE);
    let events = flush(r);
    let generation = r.current_launch(LEAF).unwrap().generation;
    assert_eq!(serde_json::to_value(events).unwrap(), serde_json::json!([{
        "terminalId": LEAF, "path": "/ok", "host": "target.test", "sessionGeneration": generation,
    }]));
}

#[tokio::test]
async fn local_host_wrong_host_and_old_generation_do_not_follow() {
    let f = connected().await;
    let r = &f.registry;
    for data in [
        &b"\x1b]7;file://localhost/home/me\x07"[..],
        b"\x1b]7;file://other.test/home/me\x07",
        b"\x1b]7;file:///home/me\x07",
    ] {
        feed(r, data);
    }
    assert!(flush(r).is_empty());
    let old_generation = r.current_launch(LEAF).unwrap().generation;
    feed(r, COMPLETE); // pending before reconnect
    feed(r, PREFIX); // partial before reconnect (same local PTY)
    r.reconnect(LEAF, || true).unwrap();
    f.connected().await;
    assert_ne!(r.current_launch(LEAF).unwrap().generation, old_generation);
    feed(r, b"stale\x07");
    assert!(flush(r).is_empty());
    feed(r, COMPLETE);
    assert_eq!(flush(r).len(), 1);
}

#[tokio::test]
async fn learned_hostname_is_scoped_to_the_session_generation() {
    let f = connected().await;
    let r = &f.registry;
    let entry = r.entry(LEAF, false).unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while entry.inner.lock().learned_hostname.is_none() {
            tokio::task::yield_now().await;
        }
    }).await.unwrap();
    feed(r, b"\x1b]7;file://fixture-host/learned\x07");
    assert_eq!(flush(r)[0].path, "/learned");
    assert_eq!(f.server.counters.hostname_requests.load(Ordering::SeqCst), 1);

    let mut next_server = Server::new(1, "alice");
    next_server.hostname_reply = None;
    f.use_server_for_next_connection(&next_server);
    r.reconnect(LEAF, || true).unwrap();
    f.connected().await;
    feed(r, b"\x1b]7;file://fixture-host/stale\x07");
    assert!(flush(r).is_empty());
}

#[tokio::test]
async fn overlong_osc_is_bounded_and_cleanup_drops_parser_state() {
    let f = connected().await;
    let r = &f.registry;
    feed(r, PREFIX);
    feed(r, &[b'x'; 8192]);
    feed(r, b"\x07");
    assert!(flush(r).is_empty());
    feed(r, COMPLETE); // pending event to purge as well as the next fragment
    feed(r, PREFIX);
    let mapped = Cell::new(true);
    let resolve = |id: &str| if mapped.get() { leaf(id) } else { None };
    r.remove_cwd_process(Some(LEAF), PROCESS, || mapped.set(false));
    r.feed_remote_cwd(PIPELINE, &payload(PROCESS, b"tail\x07"), &resolve);
    assert!(r.cwd_streams.lock().by_process.is_empty());
    let sink = Capture::default();
    r.flush_remote_cwd(PIPELINE, &resolve, &sink);
    assert!(sink.take().is_empty());
}

#[tokio::test]
async fn lagged_or_restarted_pipeline_cannot_join_old_fragment() {
    let f = connected().await;
    let r = &f.registry;
    feed(r, PREFIX);
    r.reset_cwd_pipeline(PIPELINE);
    feed(r, b"post-lag\x07");
    assert!(flush(r).is_empty());

    feed(r, PREFIX);
    let current = PIPELINE + 1;
    r.begin_cwd_pipeline(current);
    r.feed_remote_cwd(current, &payload(PROCESS, b"post-restart\x07"), leaf);
    let sink = Capture::default();
    r.flush_remote_cwd(current, leaf, &sink);
    assert!(sink.take().is_empty());
    r.feed_remote_cwd(current, &payload(PROCESS, COMPLETE), leaf);
    r.reset_cwd_pipeline(PIPELINE); // obsolete consumer may not clear the successor
    r.flush_remote_cwd(PIPELINE, leaf, &sink);
    assert!(sink.take().is_empty());
    r.flush_remote_cwd(current, leaf, &sink);
    assert_eq!(sink.take().len(), 1);
}

#[tokio::test]
async fn native_and_sidecar_output_reach_same_remote_cwd_parser() {
    let f = connected().await;
    let r = &f.registry;
    // The native reader and sidecar stdout publisher both send ChannelPayload
    // on output_tx. Exercise that shared boundary, not either live PTY.
    let (tx, mut rx) = tokio::sync::broadcast::channel(2);
    let native = ChannelPayload { id: PROCESS.into(), data: PREFIX.to_vec() };
    let sidecar = ChannelPayload { id: PROCESS.into(), data: b"shared\x1b\\".to_vec() };
    tx.send(native).unwrap();
    tx.send(sidecar).unwrap();
    for _ in 0..2 {
        r.feed_remote_cwd(PIPELINE, &rx.recv().await.unwrap(), leaf);
    }
    assert_eq!(flush(r)[0].path, "/shared");
}

#[tokio::test]
async fn slow_hostname_or_list_does_not_block_terminal_output() {
    let mut server = Server::new(1, "alice");
    server.hostname_reply = None; // acknowledge exec but never return data or exit
    let f = fixture(server);
    f.connected().await;
    let r = &f.registry;
    r.begin_cwd_pipeline(PIPELINE);
    tokio::time::timeout(Duration::from_secs(2), async {
        while f.server.counters.hostname_requests.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
    }).await.unwrap();
    feed(r, PREFIX);
    feed(r, b"while-hostname-is-blocked\x07");
    assert_eq!(flush(r)[0].path, "/while-hostname-is-blocked");
    assert!(r.entry(LEAF, false).unwrap().inner.lock().learned_hostname.is_none());
    assert_eq!(f.server.counters.closed_channels.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn ended_launch_stops_cwd_events_immediately() {
    let f = connected().await;
    let r = &f.registry;
    feed(r, COMPLETE);
    feed(r, PREFIX);
    let generation = r.current_launch(LEAF).unwrap().generation;
    r.on_launch_lifecycle(LEAF, generation, 2, LaunchState::Ended, Some(PROCESS.into())).unwrap();
    assert!(r.cwd_streams.lock().by_process.is_empty());
    feed(r, b"tail\x07");
    feed(r, COMPLETE);
    assert!(flush(r).is_empty());
    assert!(r.cwd_streams.lock().by_process.is_empty());
}

#[tokio::test]
async fn process_replacement_drops_old_fragment_and_event() {
    let f = connected().await;
    let r = &f.registry;
    feed(r, COMPLETE);
    feed(r, PREFIX);
    let generation = r.current_launch(LEAF).unwrap().generation;
    r.on_launch_lifecycle(LEAF, generation, 2, LaunchState::Running, Some("pc-b".into())).unwrap();
    assert!(r.cwd_streams.lock().by_process.is_empty());
    feed(r, COMPLETE); // old process still has a leaf mapping in this fixture
    let resolve = |_: &str| Some(LEAF.into());
    r.feed_remote_cwd(PIPELINE, &payload("pc-b", b"tail\x07"), resolve);
    let sink = Capture::default();
    r.flush_remote_cwd(PIPELINE, resolve, &sink);
    assert!(sink.take().is_empty());
    r.feed_remote_cwd(PIPELINE, &payload("pc-b", COMPLETE), resolve);
    r.flush_remote_cwd(PIPELINE, resolve, &sink);
    assert_eq!(sink.take().len(), 1);
}
