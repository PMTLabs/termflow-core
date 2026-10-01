use super::fake_hosts::*;
use super::*;
use crate::state::host_routing::{place_for_leaf, place_process, Placement, RoutingPort};
use crate::state::{IdAllocator, SessionKeyKind, parse_session_key};
use std::collections::VecDeque;
use termflow_pty_protocol::{Control, Data, Frame, SpawnSpec};

const HOST: &str = "identity-host";
const A: &str = "0123456789ab4cde8fab0123456789ab";
const B: &str = "0123456789ab4cde8fab0123456789ac";
const C: &str = "0123456789ab4cde8fab0123456789ad";

fn draws(values: &[&str]) -> IdAllocator {
    let ids = Arc::new(Mutex::new(values.iter().map(|v| uuid::Uuid::parse_str(v).unwrap()).collect::<VecDeque<_>>()));
    IdAllocator::new(move || ids.lock().unwrap().pop_front().ok_or_else(|| "random source failed".into()))
}

fn machine(sessions: Vec<termflow_pty_protocol::SessionMeta>, ids: IdAllocator) -> (Arc<World>, FakePort) {
    let world = World::new();
    world.add_host(HOST, HostSpec { sessions, ..HostSpec::default() });
    let port = FakePort::new(&world, HOST).with_ids(ids);
    port.set_candidates(vec![candidate(HOST, HostRole::Current)]);
    (world, port)
}

fn spec() -> SpawnSpec {
    SpawnSpec { shell: "fake".into(), args: vec![], env: vec![], env_remove: vec![], cwd: None, cols: 80, rows: 24 }
}

async fn execute(port: &FakePort, process: &str, placement: Placement) -> String {
    match placement {
        Placement::Spawn { channel, client, ticket, session_key } => {
            port.register_terminal(process, &session_key, channel);
            assert_eq!(client.spawn_session(&session_key, &spec()).await.unwrap(), 4242);
            assert!(ticket.complete_key(process));
            drop(ticket);
            session_key
        }
        Placement::Attach { channel, client, pid, ticket, session_key } => {
            port.register_terminal(process, &session_key, channel);
            assert!(pid > 0);
            assert_eq!(client.attach_confirmed(&session_key, 0).await, Some(true));
            assert!(ticket.complete_key(process));
            drop(ticket);
            session_key
        }
        Placement::InProcess { reason } => panic!("unexpected fallback: {reason}"),
    }
}

#[tokio::test]
async fn hosted_process_and_session_ids_use_injected_uuid_bits_and_fail_before_publication() {
    let (world, port) = machine(vec![], draws(&[A, B]));
    let (process, placement) = place_process(&port, "tm-leaf", None).await.unwrap();
    assert_eq!(process, format!("pc-{A}"));
    let key = execute(&port, &process, placement).await;
    assert_eq!(key, format!("tm-leaf~{B}"));
    assert_eq!(world.sessions(HOST, "Spawn"), vec![key.clone()]);
    assert!(port.0.terminals.contains_key(&process));
    assert!(world.frames_for_session(HOST, &key).iter().any(|frame| matches!(frame, Frame::Ctrl(Control::Spawn { tab_id, .. }) if tab_id == &key)));

    // No process draw, then a process draw followed by a failed session draw.
    for ids in [draws(&[]), draws(&[C])] {
        let (world, port) = machine(vec![], ids);
        assert_eq!(place_process(&port, "tm-leaf", None).await.err().unwrap(), "random source failed");
        assert_eq!(world.count_everywhere("Spawn"), 0);
        assert!(port.table().keys().is_empty());
        assert!(port.0.terminals.is_empty());
        assert_eq!(port.table().inflight(HostChannel::Primary), 0);
    }
}

#[tokio::test]
async fn a_live_session_collision_redraws_instead_of_spawning_the_existing_key() {
    let first = format!("tm-leaf~{A}");
    for claim_only in [false, true] {
        let (world, port) = machine(vec![], draws(&[A, B]));
        ensure_hosts(&port).await.unwrap();
        port.register_terminal("pc-control", &first, HostChannel::Primary);
        if claim_only {
            port.table().routes().remove_process("pc-control");
            assert_eq!(port.table().keys().state(HostChannel::Primary, &first), Some(crate::state::KeyState::Bound("pc-control".into())));
            assert!(!port.table().routes().contains(HostChannel::Primary, &first));
        } else {
            port.table().keys().clear_fixture();
            assert!(port.table().routes().contains(HostChannel::Primary, &first));
        }
        let placement = place_for_leaf(&port, "tm-leaf", None).await.unwrap();
        let second = execute(&port, "pc-second", placement).await;
        assert_eq!(second, format!("tm-leaf~{B}"));
        assert_eq!(world.sessions(HOST, "Spawn"), vec![second]);
        assert!(port.0.terminals.contains_key("pc-control"));
        assert!(world.frames_for_session(HOST, &first).is_empty());
    }
}

#[tokio::test]
async fn listings_choose_own_leaf_then_exact_override_then_legacy_and_leave_ambiguity_recoverable() {
    let own = format!("tm-leaf~{A}");
    let second = format!("tm-leaf~{B}");
    let other = format!("tm-other~{A}");
    for (listed, override_key, expected) in [
        (vec![own.as_str(), other.as_str(), "tm-leaf"], Some(other.as_str()), Some(own.as_str())),
        (vec![own.as_str(), second.as_str(), other.as_str(), "tm-leaf"], Some(other.as_str()), None),
        (vec![other.as_str(), "tm-leaf"], Some(other.as_str()), Some(other.as_str())),
        (vec!["tm-leaf"], None, Some("tm-leaf")),
        (vec![other.as_str()], None, None),
        (vec![other.as_str()], Some(other.as_str()), Some(other.as_str())),
    ] {
        let (world, port) = machine(listed.iter().map(|key| meta(key, 11)).collect(), draws(&[C]));
        let placement = place_for_leaf(&port, "tm-leaf", override_key).await.unwrap();
        assert_eq!(world.count(HOST, "List"), 1, "candidate came from an answered host listing");
        let chosen = execute(&port, "pc-chosen", placement).await;
        match expected {
            Some(key) => {
                assert_eq!(chosen, key);
                assert_eq!(world.sessions(HOST, "Attach"), vec![key.to_string()]);
                assert_eq!(world.count_everywhere("Spawn"), 0);
            }
            None => {
                assert_eq!(chosen, format!("tm-leaf~{C}"));
                assert!(!listed.contains(&chosen.as_str()));
                assert_eq!(world.sessions(HOST, "Spawn"), vec![chosen]);
                assert_eq!(world.count_everywhere("Attach"), 0);
            }
        }
        if listed.contains(&second.as_str()) {
            let mut recovered = port.0.recovered.lock().unwrap().clone();
            recovered.sort();
            assert_eq!(recovered, vec![own.clone(), second.clone()]);
            assert!(port.table().keys().eligible(HostChannel::Primary, &own));
            assert!(port.table().keys().eligible(HostChannel::Primary, &second));
        }
    }

    let (world, port) = machine(vec![meta(&own, 11), meta("tm-leaf", 22)], draws(&[C]));
    ensure_hosts(&port).await.unwrap();
    port.table().keys().stage(HostChannel::Primary, &own, crate::state::StageMode::Attach).unwrap();
    let chosen = execute(&port, "pc-unclaimed", place_for_leaf(&port, "tm-leaf", Some(&own)).await.unwrap()).await;
    assert_eq!(chosen, "tm-leaf", "a claimed own-leaf key and claimed override are both skipped");
    assert_eq!(world.sessions(HOST, "Attach"), vec!["tm-leaf"]);
    assert_eq!(world.count_everywhere("Spawn"), 0);
}

async fn output(port: &FakePort, receiver: &mut tokio::sync::broadcast::Receiver<crate::state::ChannelPayload>, world: &World, key: &str, bytes: &[u8]) {
    world.inject_frame(HOST, 0, Frame::Data(Data::Stdout { tab_id: key.into(), offset: 10, bytes: bytes.to_vec() }), None);
    let payload = tokio::time::timeout(Duration::from_secs(3), receiver.recv()).await.unwrap().unwrap();
    assert_eq!(payload.data, bytes);
    let expected = port.0.terminals.iter().find(|entry| entry.session_key == key).unwrap().id.clone();
    assert_eq!(payload.id, expected);
}

async fn await_drops(port: &FakePort, count: u64) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while port.table().routes().dropped_frames() < count { tokio::task::yield_now().await; }
    }).await.expect("injected frames were not processed");
    assert_eq!(port.table().routes().dropped_frames(), count);
}

#[tokio::test]
async fn late_frames_for_a_closed_key_never_feed_or_end_the_replacement() {
    let (world, port) = machine(vec![], draws(&[A, B]));
    let first = execute(&port, "pc-first", place_for_leaf(&port, "tm-leaf", None).await.unwrap()).await;
    assert_eq!(parse_session_key(&first), SessionKeyKind::V2 { owner_leaf: "tm-leaf" });
    let mut receiver = port.0.output.subscribe();
    output(&port, &mut receiver, &world, &first, b"first-control").await;
    let held_output = Arc::new(EventGate::default());
    let held_exit = Arc::new(EventGate::default());
    world.inject_frame(HOST, 0, Frame::Data(Data::Stdout { tab_id: first.clone(), offset: 900, bytes: b"late-first".to_vec() }), Some(held_output.clone()));
    world.inject_frame(HOST, 0, Frame::Data(Data::Exit { tab_id: first.clone(), exit_cwd: Some("old-cwd".into()) }), Some(held_exit.clone()));
    held_output.wait_reached(1).await;
    held_exit.wait_reached(1).await;
    port.table().routes().remove_process("pc-first");
    port.0.host_terminals.remove("pc-first");
    port.0.terminals.remove("pc-first");
    port.table().keys().close(HostChannel::Primary, &first);
    let client = port.current_client().unwrap();
    let session_key = first.as_str();
    port.table().keys().close(HostChannel::Primary, session_key);
    let listed = client.list_sessions().await.unwrap();
    assert!(!listed.iter().any(|meta| meta.tab_id == first), "FIFO listing proves Close was applied");
    assert_eq!(world.sessions(HOST, "Close"), vec![first.clone()]);
    let second = execute(&port, "pc-second", place_for_leaf(&port, "tm-leaf", None).await.unwrap()).await;
    assert_ne!(first, second);
    assert_eq!(second, format!("tm-leaf~{B}"));
    output(&port, &mut receiver, &world, &second, b"second-control").await;
    assert_eq!(world.count(HOST, "Spawn"), 2);
    assert_eq!(held_output.count(), 1);
    assert_eq!(held_exit.count(), 1);
    held_output.release();
    held_exit.release();
    await_drops(&port, 2).await;
    assert!(receiver.try_recv().is_err());
    assert!(port.0.exits.lock().unwrap().is_empty());
    assert!(port.0.terminals.contains_key("pc-second"));
    assert_eq!(*port.0.offsets.get(&second).unwrap(), 24);
    assert_eq!(*port.0.offsets.get(&first).unwrap(), 23, "late output did not advance the old offset either");
}

#[tokio::test]
async fn same_key_on_another_channel_and_on_a_superseded_epoch_is_dropped() {
    let key = format!("tm-leaf~{A}");
    let (world, port) = machine(vec![], draws(&[B]));
    world.add_host("other-channel", HostSpec::default());
    port.set_candidates(vec![candidate("other-channel", HostRole::Frozen), candidate(HOST, HostRole::Current)]);
    ensure_hosts(&port).await.unwrap();
    port.register_terminal("pc-current", &key, HostChannel::Primary);
    let mut receiver = port.0.output.subscribe();
    output(&port, &mut receiver, &world, &key, b"current-control").await;
    for (endpoint, stale) in [("other-channel", false), (HOST, true)] {
        let gate = Arc::new(EventGate::default());
        for frame in [
            Data::Stdout { tab_id: key.clone(), offset: 999, bytes: b"wrong-connection".to_vec() },
            Data::Gap { tab_id: key.clone(), at_offset: 999 },
            Data::Exit { tab_id: key.clone(), exit_cwd: None },
        ] {
            world.inject_frame(endpoint, 0, Frame::Data(frame), Some(gate.clone()));
        }
        gate.wait_reached(3).await;
        if stale {
            let epoch = port.table().reserve_epoch().unwrap();
            assert!(port.table().publish(HostChannel::Primary, epoch));
            port.register_route(HostChannel::Primary, &key, "pc-current");
        }
        let before = port.table().routes().dropped_frames();
        assert_eq!(gate.count(), 3);
        for _ in 0..3 { gate.release(); }
        await_drops(&port, before + 3).await;
        assert!(receiver.try_recv().is_err());
        assert!(port.0.exits.lock().unwrap().is_empty());
        assert!(port.0.terminals.contains_key("pc-current"));
        assert_eq!(*port.0.offsets.get(&key).unwrap(), 25);
    }
}

#[test]
fn process_allocator_and_host_spawn_wiring_have_no_short_id_reconstruction() {
    use crate::state::source_scan::{fn_body, production};
    let commands = production(include_str!("../../commands/terminal.rs"));
    let body = fn_body(&commands, "async fn run_create(");
    assert!(body.contains("state.place_process_create(&id, session_key.as_deref(), cg).await?"));
    let local = production(include_str!("../../pty_manager/spawn.rs"));
    let local_body = fn_body(&local, "fn spawn_terminal(");
    assert!(local_body.contains("local_identity(&app_state.ids, renderer_terminal_id.as_deref())?"));
    assert!(local_body.find("local_identity(").unwrap() < local_body.find("openpty(").unwrap());
    assert!(fn_body(&local, "fn local_identity(").contains("ids.mint_process_id()?"));
    let routing = production(include_str!("../host_routing.rs"));
    assert!(fn_body(&routing, "async fn place_process_create(").contains("self.ids.mint_process_id()?"));
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    fn scan(path: &std::path::Path, hits: &mut Vec<String>) {
        for entry in std::fs::read_dir(path).unwrap() {
            let path = entry.unwrap().path();
            if path.file_name().is_some_and(|name| name == "tests" || name.to_string_lossy().ends_with("_tests.rs")) {
                continue;
            }
            if path.is_dir() { scan(&path, hits); }
            else if path.extension().is_some_and(|ext| ext == "rs") {
                let source = crate::state::source_scan::production(&std::fs::read_to_string(&path).unwrap());
                if source.contains("format!(\"pc-") { hits.push(path.file_name().unwrap().to_string_lossy().to_string()); }
            }
        }
    }
    let mut hits = Vec::new();
    scan(&root, &mut hits);
    assert_eq!(hits, vec!["incarnation_ids.rs"]);
    assert!(production("fn planted() { format!(\"pc-{}\", &raw[..9]); }").contains("format!(\"pc-"));
}
