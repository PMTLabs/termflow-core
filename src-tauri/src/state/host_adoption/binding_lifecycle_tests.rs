//! Ownership interleavings through the shared close operation and real client
//! transport. Every effect names the host, session, run and surviving PID.
use super::fake_hosts::*;
use super::*;
use crate::session_bindings::{BindResult, SessionBindings};
use crate::state::host_registry;
use dashmap::DashMap;
use std::sync::mpsc;
use std::time::Instant as StdInstant;
use termflow_pty_protocol::SpawnSpec;

fn spec() -> SpawnSpec {
    SpawnSpec { shell: "sh".into(), args: vec![], env: vec![], env_remove: vec![], cwd: None, cols: 80, rows: 24 }
}

async fn hosts() -> (Arc<World>, FakePort) {
    let world = World::new();
    world.add_host("current", HostSpec { sessions: vec![meta("key-q", 222)], ..HostSpec::default() });
    world.add_host("frozen", HostSpec { sessions: vec![meta("key-p", 111)], ..HostSpec::default() });
    let port = FakePort::new(&world, "current");
    port.set_candidates(vec![candidate("current", HostRole::Current), candidate("frozen", HostRole::Frozen)]);
    ensure_hosts(&port).await.unwrap();
    rediscover_hosts(&port).await.unwrap();
    (world, port)
}

#[tokio::test]
async fn selected_close_blocks_restart_until_cleanup_and_routes_exactly_once_to_frozen() {
    let (world, port) = hosts().await;
    let frozen = port.frozen_hosts().into_iter().find(|h| h.endpoint == "frozen").unwrap();
    let current = port.current_client().unwrap();
    let bindings = SessionBindings::default();
    let now = StdInstant::now();
    assert!(bindings.begin_create("leaf", "holder", now).unwrap().complete("pc-p", now));
    let selected = bindings.close("leaf", "holder").unwrap();
    assert_eq!(selected, "pc-p");
    let pending = Arc::new(DashMap::new());
    let (entered_tx, entered_rx) = mpsc::channel();
    let (resume_tx, resume_rx) = mpsc::channel();
    let b = bindings.clone();
    let client = frozen.client.clone();
    let channel = HostChannel::Frozen(frozen.id);
    let pending_close = pending.clone();
    let closer = std::thread::spawn(move || {
        b.close_process_with(&selected, true, |delete_history| {
            assert!(delete_history);
            entered_tx.send(()).unwrap();
            resume_rx.recv().unwrap();
            host_registry::route_close(&pending_close, channel, "key-p", Some(client));
        });
    });
    entered_rx.recv().unwrap();
    // Gate is between lifecycle selection and physical Close/cleanup.
    assert!(bindings.begin_create("leaf", "holder", now).is_err());
    bindings.close_process_with("pc-p", true, |_| panic!("duplicate physical close"));
    resume_tx.send(()).unwrap();
    closer.join().unwrap();
    frozen.client.list_sessions().await.unwrap();
    assert!(pending.is_empty());
    assert_eq!(world.sessions("frozen", "Close"), ["key-p"]);
    assert_eq!(world.count("current", "Close"), 0);
    let surviving = current.list_sessions().await.unwrap();
    assert!(surviving.iter().any(|s| s.tab_id == "key-q" && s.pid == 222 && s.alive));
    assert!(bindings.begin_create("leaf", "destination", now).unwrap().complete("pc-q", now));
    // A stale process-addressed close cannot invalidate the new holder/run.
    bindings.close_process_with("pc-p", true, |_| panic!("old run closed twice"));
    assert_eq!(bindings.bind("leaf", "destination", Some("pc-q"), now), BindResult::Bound { process_id: "pc-q".into() });
    assert_eq!(world.count_everywhere("Close"), 1);
}

#[tokio::test]
async fn close_before_spawn_defers_the_provisional_run_until_the_final_result_exists() {
    let (world, port) = hosts().await;
    let frozen = port.frozen_hosts().into_iter().find(|h| h.endpoint == "frozen").unwrap();
    let bindings = SessionBindings::default();
    let now = StdInstant::now();
    let creating = bindings.begin_headless_create("fresh-leaf", now).unwrap();
    // Producer stages identity before its indexed registration becomes visible.
    bindings.stage_process("fresh-leaf", "pc-new");
    assert_eq!(bindings.bind("fresh-leaf", "window", Some("pc-new"), now), BindResult::Pending);
    // An explicit API close is selected before Spawn is queued.
    bindings.close_process_with("pc-new", false, |_| panic!("Close preceded Spawn"));
    assert_eq!(world.count_everywhere("Close"), 0);
    let session_key = "fresh-key";
    let pid = frozen.client.spawn_session(session_key, &spec()).await.unwrap();
    assert!(pid > 0);
    assert!(!creating.complete("pc-new", now));
    let pending = DashMap::new();
    bindings.close_process_with("pc-new", true, |delete_history| {
        assert!(!delete_history, "API cancellation retains history even after deferred completion");
        host_registry::route_close(&pending, HostChannel::Frozen(frozen.id), "fresh-key", Some(frozen.client.clone()));
    });
    bindings.close_process_with("pc-new", false, |_| panic!("duplicate close"));
    let sessions = frozen.client.list_sessions().await.unwrap();
    assert_eq!(world.sessions("frozen", "Spawn"), ["fresh-key"]);
    assert_eq!(world.sessions("frozen", "Close"), ["fresh-key"]);
    assert!(!sessions.iter().any(|s| s.tab_id == "fresh-key" && s.alive));
    assert!(sessions.iter().any(|s| s.tab_id == "key-p" && s.pid == 111 && s.alive));
    assert_eq!(world.count("current", "Close"), 0);
}
