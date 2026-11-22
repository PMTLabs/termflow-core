use super::fake_hosts::*;
use super::*;
use crate::state::host_routing::{place_for_leaf, place_process, Placement};
use crate::state::{CloseState, KeyState, StageMode};
use termflow_pty_protocol::{Control, Data, Frame, SpawnSpec};

const HOST: &str = "key-host";
const CHANNEL: HostChannel = HostChannel::Primary;

fn machine(spec: HostSpec) -> (Arc<World>, FakePort) {
    let world = World::new();
    world.add_host(HOST, spec);
    let port = FakePort::new(&world, HOST);
    port.set_candidates(vec![candidate(HOST, HostRole::Current)]);
    (world, port)
}

fn spec() -> SpawnSpec {
    SpawnSpec { shell: "fake".into(), args: vec![], env: vec![], env_remove: vec![], cwd: None, cols: 80, rows: 24, initial_cursor_row: None }
}

async fn until(mut predicate: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while !predicate() { tokio::task::yield_now().await; }
    }).await.expect("expected host/key transition did not arrive");
}

async fn finish(port: &FakePort, process: &str, placement: Placement) -> String {
    let (channel, client, ticket, session_key, attach) = match placement {
        Placement::Spawn { channel, client, ticket, session_key } => (channel, client, ticket, session_key, false),
        Placement::Attach { channel, client, ticket, session_key, .. } => (channel, client, ticket, session_key, true),
        Placement::InProcess { reason } => panic!("unexpected local placement: {reason}"),
    };
    assert!(matches!(port.table().keys().state(channel, &session_key), Some(KeyState::Held(_))));
    assert!(ticket.publish_key(process));
    port.register_terminal(process, &session_key, channel);
    if attach {
        assert_eq!(client.attach_confirmed(&session_key, 0).await, Some(true));
    } else {
        assert_eq!(client.spawn_session(&session_key, &spec()).await.unwrap(), 4242);
    }
    assert!(ticket.complete_key(process));
    assert_eq!(port.table().keys().state(channel, &session_key), Some(KeyState::Bound(process.into())));
    session_key
}

async fn create(port: &FakePort, leaf: &str, exact: Option<&str>) -> (String, String) {
    let (process, placement) = place_process(port, leaf, exact).await.unwrap();
    let key = finish(port, &process, placement).await;
    (process, key)
}

fn remove_pane(port: &FakePort, process: &str) {
    port.0.host_terminals.remove(process);
    port.0.terminals.remove(process);
}

async fn answered(port: &FakePort) -> crate::pty_host_client::SessionListing {
    let client = port.current_client().unwrap();
    let listing = client.list_sessions_numbered().await.unwrap();
    port.apply_listing(CHANNEL, &client, Some(&listing));
    listing
}

#[tokio::test]
async fn aborted_attach_can_move_to_another_leaf_but_authoritative_close_cannot() {
    let (world, port) = machine(HostSpec { sessions: vec![meta("legacy", 11), meta("control", 22)], ..HostSpec::default() });
    let old = place_for_leaf(&port, "tm-left", Some("legacy")).await.unwrap();
    let Placement::Attach { ticket, .. } = old else { panic!("listed key must attach") };
    assert!(ticket.publish_key("pc-left"));
    assert_eq!(port.table().routes().resolve(CHANNEL, "legacy", port.table().epoch(CHANNEL).unwrap(), true), Some("pc-left".into()));
    let disposed = Arc::new(EventGate::default());
    let abort = tokio::spawn({ let disposed = disposed.clone(); async move {
        ticket.abort_key();
        disposed.hold().await;
        drop(ticket);
    } });
    disposed.wait_reached(1).await;
    assert!(port.table().keys().eligible(CHANNEL, "legacy"));
    assert!(!port.table().routes().contains(CHANNEL, "legacy"));
    let (right, key) = create(&port, "tm-right", Some("legacy")).await;
    assert_eq!(key, "legacy");
    assert_eq!(world.sessions(HOST, "Attach"), vec!["legacy"]);
    disposed.release();
    abort.await.unwrap();
    assert_eq!(port.table().keys().state(CHANNEL, "legacy"), Some(KeyState::Bound(right)));
    assert_eq!(world.count_everywhere("Close"), 0, "an aborted Attach never owns the host session");

    // A separate listed key proves the negative candidate result is selective.
    let closing = place_for_leaf(&port, "tm-left", Some("control")).await.unwrap();
    let Placement::Attach { ticket, .. } = closing else { panic!("control must attach") };
    assert!(ticket.publish_key("pc-left-close"));
    crate::state::host_registry::route_close(port.table().keys(), CHANNEL, "control");
    drop(ticket);
    until(|| world.sessions(HOST, "Close") == vec!["control"]).await;
    assert!(matches!(port.table().keys().state(CHANNEL, "control"), Some(KeyState::Ending { close: CloseState::Sent(_), .. })));
    assert_eq!(port.table().keys().candidate("tm-right", Some("control")), None);
    assert_eq!(port.table().keys().candidate("tm-right", Some("legacy")), None, "the bound key is not listed either");
    world.begin_session(HOST, meta("other-listed", 33));
    answered(&port).await;
    assert_eq!(port.table().keys().candidate("tm-right", Some("other-listed")), Some((CHANNEL, "other-listed".into())));
}

#[tokio::test]
async fn pre_close_answer_cannot_release_a_sent_ending_even_when_it_omits_the_key() {
    for show_key in [false, true] {
        let gate = Arc::new(ListGate::default());
        let (world, port) = machine(HostSpec { list: ListBehavior::GatedAfter { answered: 1, gate: gate.clone() }, ..HostSpec::default() });
        let (process, key) = create(&port, "tm-close", None).await;
        if show_key { world.begin_session(HOST, meta(&key, 11)); }
        let client = port.current_client().unwrap();
        let before = tokio::spawn({ let client = client.clone(); async move { client.list_sessions_numbered().await.unwrap() } });
        tokio::time::timeout(Duration::from_secs(3), gate.reached.notified()).await.unwrap();
        assert_eq!(world.count(HOST, "List"), 2);
        crate::state::host_registry::route_close(port.table().keys(), CHANNEL, &key);
        remove_pane(&port, &process);
        let expected = Some(KeyState::Ending { close: CloseState::Sent(port.table().epoch(CHANNEL).unwrap()), stamp: Some(2) });
        assert_eq!(port.table().keys().state(CHANNEL, &key), expected);
        gate.release.notify_one();
        let before = before.await.unwrap();
        assert_eq!(before.request_no, 2);
        assert_eq!(before.iter().any(|s| s.tab_id == key), show_key);
        port.apply_listing(CHANNEL, &client, Some(&before));
        assert_eq!(port.table().keys().state(CHANNEL, &key), expected);
        until(|| world.sessions(HOST, "Close") == vec![key.clone()]).await;
        world.end_session(HOST, &key);
        let after = tokio::spawn({ let client = client.clone(); async move { client.list_sessions_numbered().await.unwrap() } });
        tokio::time::timeout(Duration::from_secs(3), gate.reached.notified()).await.unwrap();
        gate.release.notify_one();
        let after = after.await.unwrap();
        assert_eq!(after.request_no, 3);
        assert!(!after.iter().any(|s| s.tab_id == key));
        port.apply_listing(CHANNEL, &client, Some(&after));
        assert_eq!(port.table().keys().state(CHANNEL, &key), None);
    }
}

#[tokio::test]
async fn natural_and_staged_exits_require_a_post_exit_listing_and_duplicate_exit_advances_the_stamp() {
    for staged in [false, true] {
        let gate = Arc::new(ListGate::default());
        let (world, port) = machine(HostSpec { list: ListBehavior::GatedAfter { answered: 1, gate: gate.clone() }, ..HostSpec::default() });
        let (process, placement) = place_process(&port, "tm-exit", None).await.unwrap();
        let Placement::Spawn { client, ticket, session_key, .. } = placement else { panic!("fresh Spawn") };
        assert!(ticket.publish_key(&process));
        port.register_terminal(&process, &session_key, CHANNEL);
        assert_eq!(client.spawn_session(&session_key, &spec()).await.unwrap(), 4242);
        if !staged { assert!(ticket.complete_key(&process)); }
        assert!(matches!(port.table().keys().state(CHANNEL, &session_key), Some(KeyState::Held(_) | KeyState::Bound(_))));
        let before = tokio::spawn({ let client = client.clone(); async move { client.list_sessions_numbered().await.unwrap() } });
        tokio::time::timeout(Duration::from_secs(3), gate.reached.notified()).await.unwrap();
        let exit = Arc::new(EventGate::default());
        world.inject_frame(HOST, 0, Frame::Data(Data::Exit { tab_id: session_key.clone(), exit_cwd: None }), Some(exit.clone()));
        exit.wait_reached(1).await;
        exit.release();
        let ending = Some(KeyState::Ending { close: CloseState::None, stamp: Some(2) });
        until(|| port.table().keys().state(CHANNEL, &session_key) == ending).await;
        assert_eq!(port.0.exits.lock().unwrap().as_slice(), std::slice::from_ref(&process));
        assert!(!ticket.complete_key(&process), "staged Exit cannot become Bound on completion");
        gate.release.notify_one();
        let before = before.await.unwrap();
        port.apply_listing(CHANNEL, &client, Some(&before));
        assert_eq!(port.table().keys().state(CHANNEL, &session_key), ending);

        // Attach can emit a second Exit after the original reader has exited.
        let between = tokio::spawn({ let client = client.clone(); async move { client.list_sessions_numbered().await.unwrap() } });
        tokio::time::timeout(Duration::from_secs(3), gate.reached.notified()).await.unwrap();
        let duplicate = Arc::new(EventGate::default());
        world.inject_frame(HOST, 0, Frame::Data(Data::Exit { tab_id: session_key.clone(), exit_cwd: None }), Some(duplicate.clone()));
        duplicate.wait_reached(1).await;
        duplicate.release();
        let ending = Some(KeyState::Ending { close: CloseState::None, stamp: Some(3) });
        until(|| port.table().keys().state(CHANNEL, &session_key) == ending).await;
        assert_eq!(port.0.exits.lock().unwrap().len(), 1, "duplicate Exit has no process effect");
        gate.release.notify_one();
        let between = between.await.unwrap();
        port.apply_listing(CHANNEL, &client, Some(&between));
        assert_eq!(port.table().keys().state(CHANNEL, &session_key), ending);
        drop(ticket);
        assert_eq!(world.count_everywhere("Close"), 0);
        let after = tokio::spawn({ let client = client.clone(); async move { client.list_sessions_numbered().await.unwrap() } });
        tokio::time::timeout(Duration::from_secs(3), gate.reached.notified()).await.unwrap();
        gate.release.notify_one();
        let after = after.await.unwrap();
        assert_eq!(after.request_no, 4);
        port.apply_listing(CHANNEL, &client, Some(&after));
        assert_eq!(port.table().keys().state(CHANNEL, &session_key), None);
    }
}

#[tokio::test]
async fn existing_closes_above_the_admission_cap_are_retained_and_resent_before_listing() {
    const CAP: usize = 2;
    let (world, port) = machine(HostSpec { sessions: vec![meta("listed-control", 99)], ..HostSpec::default() });
    port.table().keys().set_cap(CAP);
    let mut shells = Vec::new();
    for n in 0..=CAP { shells.push(create(&port, &format!("tm-{n}"), None).await); }
    assert_eq!(world.count(HOST, "Spawn"), CAP + 1);
    let client = port.current_client().unwrap();
    world.kill_connections(HOST);
    until(|| !client.is_alive()).await;
    for (process, key) in &shells {
        crate::state::host_registry::route_close(port.table().keys(), CHANNEL, key);
        remove_pane(&port, process);
        assert_eq!(port.table().keys().state(CHANNEL, key), Some(KeyState::Ending { close: CloseState::Pending, stamp: None }));
    }
    assert_eq!(port.table().keys().len(), CAP + 2, "three Pending plus the listed control");
    assert_eq!(world.count_everywhere("Close"), 0);
    for (_, key) in &shells {
        assert!(!port.table().keys().eligible(CHANNEL, key));
        assert_eq!(port.table().keys().candidate("tm-restoring", Some(key)), None);
    }
    super::panes::surface_orphans(&port, shells.iter().map(|(_, k)| meta(k, 11)).chain([meta("listed-control", 99)]).collect(), CHANNEL);
    port.table().keys().flush_deliveries();
    assert_eq!(port.0.recovered.lock().unwrap().as_slice(), &["listed-control"]);
    assert!(port.table().keys().stage(CHANNEL, "new-spawn", StageMode::Spawn).unwrap_err().starts_with("host-ownership-pending:"));
    assert!(port.table().keys().stage(CHANNEL, "listed-control", StageMode::Attach).unwrap_err().starts_with("host-ownership-pending:"));
    assert!(port.table().keys().eligible(CHANNEL, "listed-control"));
    assert_eq!(port.table().keys().len(), CAP + 2);

    port.drop_current();
    let old_log = world.kinds(HOST).len();
    let adopted = adopt(&port, &candidate(HOST, HostRole::Current), HostRole::Current, Instant::now() + ADOPTION_DEADLINE).await.unwrap_or_else(|_| panic!("reconnect"));
    assert_eq!(adopted.resolution, Resolution::Resolved);
    let log = world.kinds(HOST);
    let reconnect = &log[old_log..];
    let first_list = reconnect.iter().position(|k| *k == "List").unwrap();
    assert_eq!(reconnect[..first_list].iter().filter(|k| **k == "Close").count(), CAP + 1);
    let mut closed = world.sessions(HOST, "Close");
    closed.sort();
    let mut expected: Vec<_> = shells.iter().map(|(_, k)| k.clone()).collect();
    expected.sort();
    assert_eq!(closed, expected);
    for (_, key) in &shells { assert_eq!(port.table().keys().state(CHANNEL, key), None); }
    let (_, replacement) = create(&port, "tm-after-reconnect", None).await;
    assert_eq!(world.count(HOST, "Spawn"), CAP + 2);
    assert!(port.table().keys().state(CHANNEL, &replacement).is_some());
}

#[tokio::test]
async fn a_full_sent_cap_refuses_spawn_and_attach_placement_without_publishing() {
    let (world, port) = machine(HostSpec { sessions: vec![meta("eligible-control", 9)], ..HostSpec::default() });
    port.table().keys().set_cap(2);
    let mut closed = Vec::new();
    for n in 0..2 {
        let (process, key) = create(&port, &format!("tm-sent-{n}"), None).await;
        crate::state::host_registry::route_close(port.table().keys(), CHANNEL, &key);
        remove_pane(&port, &process);
        closed.push(key);
    }
    until(|| world.count(HOST, "Close") == 2).await;
    let cells: Vec<_> = closed.iter().map(|key| port.table().keys().state(CHANNEL, key)).collect();
    assert!(cells.iter().all(|s| matches!(s, Some(KeyState::Ending { close: CloseState::Sent(_), .. }))));
    let spawns = world.count(HOST, "Spawn");
    let attaches = world.count(HOST, "Attach");
    for exact in [None, Some("eligible-control")] {
        let error = match place_for_leaf(&port, "tm-refused", exact).await {
            Err(error) => error,
            Ok(_) => panic!("full non-evictable cap must refuse placement"),
        };
        assert!(error.starts_with("host-ownership-pending:"), "{error}");
        assert_eq!(port.table().keys().len(), 3);
        assert!(port.table().keys().eligible(CHANNEL, "eligible-control"));
        assert_eq!(port.table().inflight(CHANNEL), 0);
        assert_eq!(world.count(HOST, "Spawn"), spawns);
        assert_eq!(world.count(HOST, "Attach"), attaches);
        for (key, cell) in closed.iter().zip(&cells) { assert_eq!(&port.table().keys().state(CHANNEL, key), cell); }
    }
}

#[test]
fn the_real_cap_evicts_only_oldest_no_effect_endings() {
    let keys = crate::state::HostKeys::default();
    keys.close(CHANNEL, "pending");
    for n in 0..=crate::state::host_keys::ENDING_CAP {
        let key = format!("ended-{n:05}");
        let (stage, _) = keys.stage(CHANNEL, &key, StageMode::Spawn).unwrap();
        assert!(keys.complete(&stage, &format!("pc-{n}")));
        keys.exit(CHANNEL, &key);
    }
    assert_eq!(keys.len(), crate::state::host_keys::ENDING_CAP);
    assert_eq!(keys.state(CHANNEL, "pending"), Some(KeyState::Ending { close: CloseState::Pending, stamp: None }));
    assert_eq!(keys.state(CHANNEL, "ended-00000"), None);
    assert_eq!(keys.state(CHANNEL, "ended-00001"), None);
    assert!(matches!(keys.state(CHANNEL, &format!("ended-{:05}", crate::state::host_keys::ENDING_CAP)), Some(KeyState::Ending { close: CloseState::None, .. })));
}

#[tokio::test]
async fn respawn_uses_another_key_while_the_old_close_is_still_retained() {
    let (world, port) = machine(HostSpec::default());
    let (old, first) = create(&port, "tm-respawn", None).await;
    crate::state::host_registry::route_close(port.table().keys(), CHANNEL, &first);
    remove_pane(&port, &old);
    let (new, second) = create(&port, "tm-respawn", None).await;
    assert_ne!(first, second);
    assert_ne!(old, new);
    assert_eq!(world.sessions(HOST, "Spawn"), vec![first.clone(), second.clone()]);
    assert_eq!(world.sessions(HOST, "Close"), vec![first.clone()]);
    assert!(matches!(port.table().keys().state(CHANNEL, &first), Some(KeyState::Ending { close: CloseState::Sent(_), .. })));
    assert_eq!(port.table().keys().state(CHANNEL, &second), Some(KeyState::Bound(new)));
}

#[tokio::test(start_paused = true)]
async fn spawn_timeout_retires_the_unknown_result_and_close_follows_spawn_on_the_fifo() {
    let gate = Arc::new(EventGate::default());
    let (world, port) = machine(HostSpec { reply_gates: std::collections::HashMap::from([("Spawn", gate.clone())]), ..HostSpec::default() });
    let (process, placement) = place_process(&port, "tm-timeout", None).await.unwrap();
    let Placement::Spawn { ticket, client, session_key, .. } = placement else { panic!("spawn") };
    assert!(ticket.publish_key(&process));
    port.register_terminal(&process, &session_key, CHANNEL);
    let spawned = tokio::spawn({ let session_key = session_key.clone(); let client = client.clone(); async move { client.spawn_session(&session_key, &spec()).await } });
    gate.wait_reached(1).await;
    assert_eq!(world.sessions(HOST, "Spawn"), vec![session_key.clone()]);
    assert_eq!(spawned.await.unwrap().unwrap_err(), "pty-host: no response to spawn");
    ticket.abort_key();
    remove_pane(&port, &process);
    assert!(matches!(port.table().keys().state(CHANNEL, &session_key), Some(KeyState::Ending { close: CloseState::Sent(_), .. })));
    assert!(!port.table().keys().eligible(CHANNEL, &session_key));
    // The host's gated Spawn handler prevents it reading the queued Close yet.
    assert_eq!(world.count_everywhere("Close"), 0);
    gate.release();
    let listing = client.list_sessions_numbered().await.unwrap();
    let frames = world.frames_for_session(HOST, &session_key);
    assert!(matches!(&frames[..], [Frame::Ctrl(Control::Spawn { .. }), Frame::Ctrl(Control::Close { tab_id })] if tab_id == &session_key));
    port.apply_listing(CHANNEL, &client, Some(&listing));
    assert_eq!(port.table().keys().state(CHANNEL, &session_key), None);
    drop(ticket);
    assert_eq!(world.sessions(HOST, "Close"), vec![session_key]);
}
