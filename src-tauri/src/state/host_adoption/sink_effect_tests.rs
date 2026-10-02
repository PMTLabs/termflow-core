use super::*;
use super::fake_hosts::*;
use super::owner_tests::{machine, create};
use super::deferred_effect_tests::{stage, finish, fence};
use super::panes::{reconnect_snapshot, reattach_listed};
use crate::state::{host_registry, HostKeys, CreateAdmission, CreateMode, Completion, EndKind, ShellStage, StagedShell, KeyState};
use termflow_pty_protocol::{Control, Data, Frame};
use std::{collections::HashMap, time::Instant};

const HOST: &str = "owner-host";
const CHANNEL: HostChannel = HostChannel::Primary;
const BOUND: Duration = Duration::from_secs(3);

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn delayed_frozen_loss_cannot_overwrite_the_reconnected_barrier() {
    let world = World::new();
    world.add_host("cur", HostSpec { track_spawns: true, ..HostSpec::default() });
    world.add_host("old", HostSpec { sessions: vec![meta("control", 41)], ..HostSpec::default() });
    let port = FakePort::new(&world, "cur");
    port.set_candidates(vec![candidate("cur", HostRole::Current), candidate("old", HostRole::Frozen)]);
    rediscover_hosts(&port).await.unwrap();
    let host = port.frozen_hosts().pop().unwrap();
    let channel = HostChannel::Frozen(host.id);
    let key = barrier_key(&host.endpoint);
    assert_eq!(port.connect_count("old"), 1);
    assert!(port.barrier().unresolved().is_empty());
    // Current-connection loss really records uncertainty and reserves its retry.
    assert!(frozen_connection_lost(port.table(), port.barrier(), host.id, host.epoch, &host.endpoint));
    assert_eq!(port.barrier().unresolved(), vec![UnresolvedHost { endpoint: "old".into(), reason: "connection lost".into() }]);
    assert!(!port.barrier().needs_attempt_for(&key));
    assert!(port.barrier().lock().iter().find(|e| e.key == key).unwrap().retry_pending);
    port.barrier().finish_on(&key, &host.endpoint, HostRole::Frozen, Resolution::Resolved, Some((port.table(), channel, host.epoch)));
    assert!(host.client.close_transport().await);
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (resume_tx, resume_rx) = std::sync::mpsc::channel();
    let resume_rx = Mutex::new(resume_rx);
    *port.barrier().shared.lost_hook.lock().unwrap() = Some(Arc::new(move || {
        entered_tx.send(()).unwrap();
        resume_rx.lock().unwrap().recv_timeout(BOUND).unwrap();
    }));
    let delayed = std::thread::spawn({ let port = port.clone(); let host = host.clone(); move || {
        frozen_connection_lost(port.table(), port.barrier(), host.id, host.epoch, &host.endpoint)
    }});
    entered_rx.recv_timeout(BOUND).unwrap();
    assert!(tokio::time::timeout(BOUND, reconnect::reconnect_disconnected(&port)).await.unwrap());
    let current = port.frozen_hosts().pop().unwrap();
    assert!(current.epoch > host.epoch);
    assert_eq!(port.connect_count("old"), 2);
    assert_eq!(current.id, host.id);
    assert!(current.client.is_alive());
    assert_eq!(port.table().keys().state(channel, "control"), Some(KeyState::Listed));
    assert!(port.barrier().unresolved().is_empty());
    resume_tx.send(()).unwrap();
    assert!(!delayed.join().unwrap());
    // The successful-result writer is qualified at the same lock-local boundary.
    port.barrier().finish_on(&key, &host.endpoint, HostRole::Frozen, Resolution::Unresolved("stale answer".into()), Some((port.table(), channel, host.epoch)));
    assert!(port.barrier().unresolved().is_empty());
    {
        let entries = port.barrier().lock();
        let entry = entries.iter().find(|e| e.key == key).unwrap();
        assert_eq!(entry.resolution, Resolution::Resolved);
        assert!(!entry.retry_pending);
    }
    assert!(!port.barrier().needs_attempt_for(&key));
    let placement = tokio::time::timeout(BOUND, crate::state::host_routing::place_owned(&port, "tm-missing", Some("saved-missing"), None)).await.unwrap().unwrap();
    let crate::state::host_routing::Placement::Spawn { channel: target, client, ticket, session_key } = placement else { panic!("missing saved session must progress to fresh spawn") };
    assert_eq!(target, HostChannel::Primary);
    assert_ne!(session_key, "saved-missing");
    assert_eq!(world.count_everywhere("Spawn"), 0, "placement does not send the spawn itself");
    drop(ticket);
    assert!(client.close_transport().await);
    assert!(current.client.close_transport().await);
}

#[tokio::test]
async fn same_leaf_restore_holder_survives_aborted_owner_projection_cleanup() {
    let (world, port) = machine(HostSpec { sessions: vec![meta("shared", 4242), meta("control", 4343)], ..HostSpec::default() });
    ensure_hosts(&port).await.unwrap();
    let keys = port.table().keys();
    let now = Instant::now();
    assert!(host_registry::register_restoring_leaf(&port.intent_maps(), "C", "tm-C", Some("shared"), now));
    let (cg, p, ticket) = stage(&port, CHANNEL, "tm-P", "shared");
    assert!(!host_registry::register_restoring_leaf(&port.intent_maps(), "reload", "tm-P", Some("shared"), now));
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (resume_tx, resume_rx) = std::sync::mpsc::channel();
    let cleanup = std::thread::spawn({ let port = port.clone(); let p = p.clone(); move || {
        assert_eq!(port.table().keys().abort_create("tm-P", cg).unwrap().process, p.process);
        entered_tx.send(()).unwrap();
        resume_rx.recv_timeout(BOUND).unwrap();
        port.0.host_terminals.remove(&p.process);
        port.0.terminals.remove(&p.process);
    }});
    entered_rx.recv_timeout(BOUND).unwrap();
    assert!(keys.owner_state("tm-P").is_none());
    assert!(port.0.terminals.contains_key(&p.process));
    assert_eq!(keys.state(CHANNEL, "shared"), Some(KeyState::Listed));
    host_registry::forget_restoring_leaf(&port.intent_maps(), "C", "tm-C", now);
    assert!(host_registry::register_restoring_leaf(&port.intent_maps(), "reload", "tm-P", Some("shared"), now));
    assert_eq!(keys.holder_stamp("reload", "tm-P"), Some(now));
    resume_tx.send(()).unwrap();
    cleanup.join().unwrap();
    drop(ticket);
    let client = port.current_client().unwrap();
    let answer = fence(&port, &client, CHANNEL).await;
    assert!(answer.sessions.iter().any(|s| s.tab_id == "shared" && s.alive && s.pid == 4242));
    assert_eq!(world.count_everywhere("Close"), 0);
    assert_eq!(keys.state(CHANNEL, "shared"), Some(KeyState::Listed));
    host_registry::forget_restoring_leaf(&port.intent_maps(), "reload", "tm-P", now);
    fence(&port, &client, CHANNEL).await;
    client.list_sessions_numbered().await.unwrap();
    assert_eq!(world.sessions(HOST, "Close"), vec!["shared"]);
    assert_eq!(keys.state(CHANNEL, "control"), Some(KeyState::Listed));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reconnect_publication_and_post_attach_repaint_reject_a_superseding_epoch_for_the_same_process() {
    for at_route in [true, false] {
        let attach_gate = Arc::new(EventGate::default());
        let (world, port) = machine(HostSpec { sessions: vec![meta("shared", 4242)],
            reply_gates: if at_route { HashMap::new() } else { HashMap::from([("Attach", attach_gate.clone())]) },
            ..HostSpec::default() });
        ensure_hosts(&port).await.unwrap();
        let old = port.current_client().unwrap();
        let old_epoch = old.session_epoch(CHANNEL).unwrap();
        let (cg, p, ticket) = stage(&port, CHANNEL, "tm-P", "shared");
        finish(&port, "tm-P", cg, &p);
        drop(ticket);
        let snapshot = reconnect_snapshot(&port, CHANNEL);
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (resume_tx, resume_rx) = std::sync::mpsc::channel();
        if at_route {
            let resume_rx = Mutex::new(resume_rx);
            *port.table().keys().route_hook.lock().unwrap() = Some(Arc::new(move || {
                entered_tx.send(()).unwrap();
                resume_rx.lock().unwrap().recv_timeout(BOUND).unwrap();
            }));
        }
        let pass = tokio::spawn({ let port = port.clone(); let old = old.clone(); async move {
            reattach_listed(&port, CHANNEL, &old, &snapshot, &[meta("shared", 4242)], &|| true).await;
        }});
        if at_route { entered_rx.recv_timeout(BOUND).unwrap(); }
        else { attach_gate.wait_reached(1).await; }
        let epoch = port.table().reserve_epoch().unwrap();
        assert!(epoch > old_epoch);
        let (rd, wr) = tokio::io::split(world.open(HOST).unwrap());
        let current = crate::pty_host_client::wire_client(rd, wr, port.deps(CHANNEL, epoch, Arc::new(|| {})));
        current.bind_sessions(port.table().keys(), CHANNEL, epoch);
        assert!(port.table().keys().restore_route(CHANNEL, "shared", &p.process, epoch));
        assert!(port.table().publish(CHANNEL, epoch));
        assert_eq!(port.table().routes().resolve(CHANNEL, "shared", epoch, true), Some(p.process.clone()));
        assert!(!port.table().keys().restore_route(CHANNEL, "shared", &p.process, old_epoch));
        assert!(!port.table().publish(CHANNEL, old_epoch));
        let mut output = port.0.output.subscribe();
        world.inject_frame(HOST, 1, Frame::Data(Data::Stdout { tab_id: "shared".into(), offset: 230, bytes: b"current-Q".to_vec() }), None);
        let seen = tokio::time::timeout(BOUND, output.recv()).await.unwrap().unwrap();
        assert_eq!((seen.id.as_str(), seen.data.as_slice()), (p.process.as_str(), b"current-Q".as_slice()));
        if at_route { resume_tx.send(()).unwrap(); }
        else { attach_gate.release(); }
        tokio::time::timeout(BOUND, pass).await.unwrap().unwrap();
        current.list_sessions_numbered().await.unwrap();
        old.list_sessions_numbered().await; // refused: does not enqueue stale evidence
        assert_eq!(world.count_everywhere("Attach"), usize::from(!at_route));
        assert_eq!(world.count_everywhere("Resize"), 0);
        assert_eq!(port.table().routes().resolve(CHANNEL, "shared", epoch, true), Some(p.process.clone()));
        assert_eq!(port.0.offsets.get("shared").map(|v| *v), Some(239));
        let identity = port.table().keys().session_identity(CHANNEL, "shared", &p.process).unwrap();
        assert!(current.repaint_owned(&identity, 93, 41));
        current.list_sessions_numbered().await.unwrap();
        assert_eq!(world.sessions(HOST, "Resize"), vec!["shared", "shared"]);
        world.inject_frame(HOST, 1, Frame::Data(Data::Stdout { tab_id: "shared".into(), offset: 239, bytes: b"live".to_vec() }), None);
        assert_eq!(tokio::time::timeout(BOUND, output.recv()).await.unwrap().unwrap().data, b"live");
        assert_eq!(port.0.offsets.get("shared").map(|v| *v), Some(243));
        assert!(old.close_transport().await);
        assert_eq!(port.table().routes().resolve(CHANNEL, "shared", epoch, true), Some(p.process));
        assert!(current.close_transport().await);
    }
}

#[tokio::test]
async fn registered_write_resize_and_reflow_recheck_inside_the_forwarding_window() {
    for operation in ["write", "resize", "reflow"] {
        let (world, port) = machine(HostSpec::default());
        let p = create(&port, "tm-leaf").await.unwrap();
        let p_key = port.0.terminals.get(&p).unwrap().session_key.clone();
        assert!(host_registry::route_write(port.table().keys(), &port.0.host_terminals, &port.0.terminals, &p, b"P-control", &|c| port.client_for(c)));
        fence(&port, &port.current_client().unwrap(), CHANNEL).await;
        assert_eq!(world.sessions(HOST, "Stdin"), vec![p_key.clone()]);
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (resume_tx, resume_rx) = std::sync::mpsc::channel();
        let delayed = std::thread::spawn({ let port = port.clone(); let p = p.clone(); move || {
            let resume_rx = Mutex::new(resume_rx);
            let lookup = |c| {
                // Called only AFTER production captured an admitted Registered route.
                entered_tx.send(c).unwrap();
                resume_rx.lock().unwrap().recv_timeout(BOUND).unwrap();
                port.client_for(c)
            };
            if operation == "write" {
                host_registry::route_write(port.table().keys(), &port.0.host_terminals, &port.0.terminals, &p, b"stale-P", &lookup)
            } else {
                host_registry::route_resize(port.table().keys(), &port.0.host_terminals, &port.0.terminals, &p, 99, 39, &lookup)
            }
        }});
        assert_eq!(entered_rx.recv_timeout(BOUND).unwrap(), CHANNEL);
        world.end_session(HOST, &p_key);
        assert!(port.table().keys().note_exit(&p));
        assert!(port.end_owner(&p, EndKind::Exit));
        let q = create(&port, "tm-leaf").await.unwrap();
        let q_key = port.0.terminals.get(&q).unwrap().session_key.clone();
        assert_ne!(p, q);
        assert!(host_registry::route_write(port.table().keys(), &port.0.host_terminals, &port.0.terminals, &q, b"Q-input", &|c| port.client_for(c)));
        assert!(host_registry::route_resize(port.table().keys(), &port.0.host_terminals, &port.0.terminals, &q, 93, 41, &|c| port.client_for(c)));
        resume_tx.send(()).unwrap();
        assert!(!delayed.join().unwrap());
        let listing = fence(&port, &port.current_client().unwrap(), CHANNEL).await;
        assert!(listing.sessions.iter().any(|s| s.tab_id == q_key && s.alive));
        assert_eq!(world.sessions(HOST, "Stdin"), vec![p_key.clone(), q_key.clone()]);
        assert_eq!(world.sessions(HOST, "Resize"), vec![q_key.clone()]);
        let q_frames = world.frames_for_session(HOST, &q_key);
        assert!(matches!(&q_frames[0], Frame::Ctrl(Control::Spawn { tab_id, .. }) if tab_id == &q_key));
        assert_eq!(&q_frames[1..], &[
            Frame::Data(Data::Stdin { tab_id: q_key.clone(), bytes: b"Q-input".to_vec() }),
            Frame::Ctrl(Control::Resize { tab_id: q_key, cols: 93, rows: 41 }),
        ]);
        assert_eq!(world.frames_for_session(HOST, &p_key).len(), 2, "only original Spawn and positive input control");
        assert_eq!(world.count_everywhere("Close"), 0);
    }
}

#[test]
fn recovery_delivery_can_reenter_and_block_without_holding_shell_authority() {
    let keys = HostKeys::default();
    keys.listing(CHANNEL, &SessionListing { request_no: 1, sessions: vec![meta("orphan", 4242), meta("next", 4343)] }, |_| false);
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (resume_tx, resume_rx) = std::sync::mpsc::channel();
    let observed = Arc::new(Mutex::new(Vec::new()));
    keys.recover_listed(CHANNEL, "orphan", || true, { let keys = keys.clone(); let observed = observed.clone(); move || {
        assert_eq!(keys.state(CHANNEL, "orphan"), Some(KeyState::Listed)); // reentrant observer
        entered_tx.send(()).unwrap();
        resume_rx.recv_timeout(BOUND).unwrap();
        observed.lock().unwrap().push("orphan");
    }});
    entered_rx.recv_timeout(BOUND).unwrap();
    let (progress_tx, progress_rx) = std::sync::mpsc::channel();
    let unrelated = std::thread::spawn({ let keys = keys.clone(); move || {
        assert!(keys.owner_state("tm-local").is_none());
        let CreateAdmission::Run(cg) = keys.admit_create("tm-local", CreateMode::Mount).unwrap() else { panic!("admission") };
        keys.stage_shell("tm-local", cg, "pc-local", None).unwrap();
        let shell = StagedShell { process: "pc-local".into(), stage: ShellStage::Local };
        assert!(matches!(keys.complete_shell("tm-local", cg, &shell), Completion::Registered));
        assert_eq!(keys.resolve_process("pc-local", true), Some("pc-local".into()));
        progress_tx.send(()).unwrap();
    }});
    progress_rx.recv_timeout(BOUND).unwrap();
    unrelated.join().unwrap();
    keys.recover_listed(CHANNEL, "next", || true, { let observed = observed.clone(); move || observed.lock().unwrap().push("next") });
    assert_eq!(keys.pending_deliveries(), 2);
    for _ in 0..100 {
        for key in ["orphan", "next"] {
            keys.recover_listed(CHANNEL, key, || true, || panic!("duplicate pending recovery"));
        }
    }
    assert_eq!(keys.pending_deliveries(), 2);
    assert!(observed.lock().unwrap().is_empty());
    resume_tx.send(()).unwrap();
    keys.flush_deliveries();
    assert_eq!(*observed.lock().unwrap(), vec!["orphan", "next"]);
    assert_eq!(keys.pending_deliveries(), 0);
    assert_eq!(keys.state(CHANNEL, "orphan"), Some(KeyState::Listed));
    // Completion clears the pending identity, so a later retry remains possible.
    keys.recover_listed(CHANNEL, "orphan", || true, { let observed = observed.clone(); move || observed.lock().unwrap().push("retry") });
    keys.flush_deliveries();
    assert_eq!(*observed.lock().unwrap(), vec!["orphan", "next", "retry"]);
}

#[tokio::test]
async fn repeated_sweeps_coalesce_recovery_behind_a_held_observer() {
    let (world, port) = machine(HostSpec { sessions: vec![meta("orphan", 41), meta("next", 42)], ..HostSpec::default() });
    ensure_hosts(&port).await.unwrap();
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (resume_tx, resume_rx) = std::sync::mpsc::channel();
    port.table().keys().recover_listed(CHANNEL, "orphan", || true, { let port = port.clone(); move || {
        entered_tx.send(()).unwrap();
        resume_rx.recv_timeout(BOUND).unwrap();
        port.0.recovered.lock().unwrap().push("orphan".into());
    }});
    entered_rx.recv_timeout(BOUND).unwrap();
    assert_eq!(port.table().keys().pending_deliveries(), 1);
    for _ in 0..20 { assert!(tokio::time::timeout(BOUND, sweep(&port)).await.unwrap()); }
    assert!(world.count(HOST, "List") >= 21);
    assert_eq!(port.table().keys().listed().len(), 2);
    assert_eq!(port.table().keys().pending_deliveries(), 2);
    assert!(port.0.recovered.lock().unwrap().is_empty());
    resume_tx.send(()).unwrap();
    port.table().keys().flush_deliveries();
    assert_eq!(*port.0.recovered.lock().unwrap(), vec!["orphan", "next"]);
    assert_eq!(port.table().keys().pending_deliveries(), 0);
    assert_eq!(world.count_everywhere("Close"), 0);
    assert_eq!(world.count_everywhere("Spawn"), 0);
}

#[test]
fn panicking_recovery_releases_its_identity_and_preserves_the_next_delivery() {
    let keys = HostKeys::default();
    keys.listing(CHANNEL, &SessionListing { request_no: 1, sessions: vec![meta("panic", 41), meta("next", 42)] }, |_| false);
    let seen = Arc::new(Mutex::new(Vec::new()));
    keys.recover_listed(CHANNEL, "panic", || true, { let seen = seen.clone(); move || {
        seen.lock().unwrap().push("panic");
        panic!("observer failure");
    }});
    keys.recover_listed(CHANNEL, "next", || true, { let seen = seen.clone(); move || seen.lock().unwrap().push("next") });
    keys.flush_deliveries();
    assert_eq!(*seen.lock().unwrap(), vec!["panic", "next"]);
    assert_eq!(keys.pending_deliveries(), 0);
    keys.recover_listed(CHANNEL, "panic", || true, { let seen = seen.clone(); move || seen.lock().unwrap().push("retry") });
    keys.flush_deliveries();
    assert_eq!(*seen.lock().unwrap(), vec!["panic", "next", "retry"]);
    assert_eq!(keys.pending_deliveries(), 0);
}
