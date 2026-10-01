use super::fake_hosts::*;
use super::*;
use crate::state::host_routing::{place_owned, Placement};
use crate::state::owner_lifecycle::finish_create;
use crate::state::{CreateAdmission, CreateMode, CloseAction, CloseStorage, EndKind, OwnerState, ShellStage, StagedShell, Completion, KeyState, CloseState};
use termflow_pty_protocol::{Data, Frame, SpawnSpec};

const HOST: &str = "owner-host";
const CHANNEL: HostChannel = HostChannel::Primary;
pub(super) fn machine(mut spec: HostSpec) -> (Arc<World>, FakePort) {
    let world = World::new();
    spec.track_spawns = true;
    world.add_host(HOST, spec);
    let port = FakePort::new(&world, HOST);
    port.set_candidates(vec![candidate(HOST, HostRole::Current)]);
    (world, port)
}
fn spec() -> SpawnSpec {
    SpawnSpec { shell: "fake".into(), args: vec![], env: vec![], env_remove: vec![], cwd: None, cols: 80, rows: 24 }
}
pub(super) async fn until(mut predicate: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while !predicate() { tokio::task::yield_now().await; }
    }).await.expect("owner/host transition deadline");
}
fn admit(port: &FakePort, leaf: &str) -> u64 {
    match port.table().keys().admit_create(leaf, CreateMode::Mount).unwrap() {
        CreateAdmission::Run(cg) => cg,
        _ => panic!("new placement expected"),
    }
}
fn current(port: &FakePort, leaf: &str) -> StagedShell {
    match port.table().keys().owner_state(leaf).unwrap().1 {
        OwnerState::Placing { stage: Some(s), .. } | OwnerState::Registered(s) | OwnerState::Closing(s) => s,
        _ => panic!("shell not staged"),
    }
}
fn key(shell: &StagedShell) -> String {
    match &shell.stage { ShellStage::Hosted(s) => s.key.clone(), _ => panic!("hosted shell") }
}
fn finish(port: &FakePort, leaf: &str, cg: u64, shell: &StagedShell) -> Completion {
    let result = finish_create(port.table().keys(), leaf, cg, shell, |s| {
        if matches!(s.stage, ShellStage::Local) { port.0.killed.lock().unwrap().push(s.process.clone()); }
        port.0.host_terminals.remove(&s.process);
        port.0.terminals.remove(&s.process);
    }, |kind| { assert!(port.end_owner(&shell.process, kind)); });
    if matches!(result, Completion::Exited) {
        port.0.host_terminals.remove(&shell.process);
        port.0.terminals.remove(&shell.process);
    }
    result
}
pub(super) fn close(port: &FakePort, reference: &str, policy: CloseStorage) -> bool {
    match port.table().keys().close_process(reference, policy) {
        CloseAction::Cancelled => true,
        CloseAction::End { process, .. } => port.end_owner(&process, EndKind::Close(policy)),
        CloseAction::Missing => false,
    }
}
async fn run(port: &FakePort, leaf: &str, cg: u64) -> Result<String, String> {
    let process = port.0.ids.mint_process_id()?;
    let placement = place_owned(port, leaf, None, Some((cg, &process))).await?;
    let (channel, client, ticket, session_key, attach) = match placement {
        Placement::Spawn { channel, client, ticket, session_key } => (channel, client, ticket, session_key, false),
        Placement::Attach { channel, client, ticket, session_key, .. } => (channel, client, ticket, session_key, true),
        Placement::InProcess { reason } => panic!("unexpected fallback {reason}"),
    };
    assert!(ticket.publish_key(&process));
    port.register_terminal(&process, &session_key, channel);
    port.0.terminals.get_mut(&process).unwrap().renderer_terminal_id = Some(leaf.into());
    let shell = current(port, leaf);
    assert_eq!(shell.process, process);
    if attach { client.attach_confirmed(&session_key, 0).await; }
    else { assert_eq!(client.spawn_session(&session_key, &spec()).await?, 4242); }
    finish(port, leaf, cg, &shell);
    Ok(process)
}
pub(super) async fn create(port: &FakePort, leaf: &str) -> Result<String, String> {
    match port.table().keys().admit_create(leaf, CreateMode::Mount)? {
        CreateAdmission::Run(cg) => run(port, leaf, cg).await,
        CreateAdmission::Existing(pc) => Ok(pc),
        CreateAdmission::Join(waiter) => CreateAdmission::joined(waiter, crate::state::JOIN_DEADLINE).await,
    }
}

#[tokio::test]
async fn concurrent_mounts_share_one_spawn_and_a_registered_mount_reuses_it() {
    let gate = Arc::new(EventGate::default());
    let (world, port) = machine(HostSpec { reply_gates: std::collections::HashMap::from([("Spawn", gate.clone())]), ..HostSpec::default() });
    let first = tokio::spawn({ let port = port.clone(); async move { create(&port, "tm-leaf").await } });
    gate.wait_reached(1).await;
    let shell = current(&port, "tm-leaf");
    assert_eq!(world.sessions(HOST, "Spawn"), vec![key(&shell)]);
    let CreateAdmission::Join(waiter) = port.table().keys().admit_create("tm-leaf", CreateMode::Mount).unwrap() else { panic!("join expected") };
    let join = tokio::spawn(CreateAdmission::joined(waiter, crate::state::JOIN_DEADLINE));
    assert!(!join.is_finished());
    // A different leaf admits and stages while the first reply is held. Its
    // Spawn is queued independently; the host itself answers its FIFO serially.
    let other = tokio::spawn({ let port = port.clone(); async move { create(&port, "tm-control").await } });
    until(|| matches!(port.table().keys().owner_state("tm-control"), Some((_, OwnerState::Placing { stage: Some(_), .. })))).await;
    assert_ne!(current(&port, "tm-control").process, shell.process);
    gate.release();
    assert_eq!(first.await.unwrap().unwrap(), shell.process);
    assert_eq!(join.await.unwrap().unwrap(), shell.process);
    gate.wait_reached(2).await;
    gate.release();
    let control = other.await.unwrap().unwrap();
    assert_ne!(control, shell.process);
    assert_eq!(world.count_everywhere("Spawn"), 2);
    assert_eq!(create(&port, "tm-leaf").await.unwrap(), shell.process);
    assert_eq!(world.count_everywhere("Spawn"), 2);
    assert!(port.table().keys().admit_create("tm-leaf", CreateMode::Restart).err().unwrap().starts_with("host-session-contended:"));
}

#[tokio::test(start_paused = true)]
async fn join_deadline_and_abort_are_retryable_without_new_admission() {
    let (_, port) = machine(HostSpec::default());
    let cg = admit(&port, "tm-leaf");
    let CreateAdmission::Join(waiter) = port.table().keys().admit_create("tm-leaf", CreateMode::Mount).unwrap() else { panic!("join") };
    assert!(CreateAdmission::joined(waiter, Duration::from_millis(5)).await.unwrap_err().starts_with("host-ownership-pending:"));
    assert_eq!(port.table().keys().owner_state("tm-leaf").unwrap().0, cg);
    let CreateAdmission::Join(waiter) = port.table().keys().admit_create("tm-leaf", CreateMode::Mount).unwrap() else { panic!("join") };
    assert!(port.table().keys().abort_create("tm-leaf", cg).is_none());
    assert!(CreateAdmission::joined(waiter, Duration::from_millis(5)).await.unwrap_err().starts_with("host-ownership-pending:"));
    assert!(admit(&port, "tm-leaf") > cg);
    assert!(admit(&port, "tm-control") > cg);
}

#[tokio::test]
async fn process_close_during_spawn_and_leaf_close_before_stage_cancel_exact_shells() {
    for before_stage in [false, true] {
        let gate = Arc::new(EventGate::default());
        let (world, port) = machine(HostSpec { reply_gates: std::collections::HashMap::from([("Spawn", gate.clone())]), ..HostSpec::default() });
        let cg = admit(&port, "tm-leaf");
        if before_stage { assert!(close(&port, "tm-leaf", CloseStorage::Preserve)); }
        let job = tokio::spawn({ let port = port.clone(); async move { run(&port, "tm-leaf", cg).await } });
        gate.wait_reached(1).await;
        let shell = current(&port, "tm-leaf");
        assert_eq!(world.sessions(HOST, "Spawn"), vec![key(&shell)]);
        if !before_stage { assert!(close(&port, &shell.process, CloseStorage::Delete)); }
        assert!(matches!(port.table().keys().owner_state("tm-leaf"), Some((_, OwnerState::Placing { cancel: Some(_), .. }))));
        assert!(port.0.terminals.contains_key(&shell.process));
        gate.release();
        assert_eq!(job.await.unwrap().unwrap(), shell.process);
        let client = port.current_client().unwrap();
        client.list_sessions_numbered().await.unwrap();
        assert_eq!(world.sessions(HOST, "Close"), vec![key(&shell)]);
        assert!(port.table().keys().owner_state("tm-leaf").is_none());
        assert!(!port.0.terminals.contains_key(&shell.process));
        assert_eq!(*port.0.deleted.lock().unwrap(), if before_stage { vec![] } else { vec!["tm-leaf".to_string()] });
        // Positive no-close control on the same host.
        let control = tokio::spawn({ let port = port.clone(); async move { create(&port, "tm-control").await } });
        gate.wait_reached(2).await;
        gate.release();
        let pc = control.await.unwrap().unwrap();
        assert_eq!(port.table().keys().resolve_process(&pc, false), Some(pc));
        assert_eq!(world.count_everywhere("Spawn"), 2);
        assert_eq!(world.count_everywhere("Close"), 1);
    }
}

#[tokio::test(start_paused = true)]
async fn timed_out_spawn_restages_atomically_and_keeps_leaf_cancellation_for_local_fallback() {
    let gate = Arc::new(EventGate::default());
    let (world, port) = machine(HostSpec { reply_gates: std::collections::HashMap::from([("Spawn", gate.clone())]), ..HostSpec::default() });
    let cg = admit(&port, "tm-leaf");
    let pc = port.0.ids.mint_process_id().unwrap();
    let Placement::Spawn { ticket, client, session_key, .. } = place_owned(&port, "tm-leaf", None, Some((cg, &pc))).await.unwrap() else { panic!("spawn") };
    assert!(ticket.publish_key(&pc));
    port.register_terminal(&pc, &session_key, CHANNEL);
    let request = tokio::spawn({ let client = client.clone(); let session_key = session_key.clone(); async move { client.spawn_session(&session_key, &spec()).await } });
    gate.wait_reached(1).await;
    assert!(close(&port, "tm-leaf", CloseStorage::Preserve));
    assert_eq!(request.await.unwrap().unwrap_err(), "pty-host: no response to spawn");
    let q = port.0.ids.mint_process_id().unwrap();
    let (_, _, old) = port.table().keys().restage_shell("tm-leaf", cg, &q, None).unwrap();
    assert_eq!(old.unwrap().process, pc);
    assert_eq!(current(&port, "tm-leaf").process, q);
    assert!(matches!(port.table().keys().state(CHANNEL, &session_key), Some(KeyState::Ending { close: CloseState::Sent(_), .. })));
    assert!(matches!(port.table().keys().owner_state("tm-leaf"), Some((_, OwnerState::Placing { cancel: Some(CloseStorage::Preserve), .. }))));
    let local = current(&port, "tm-leaf");
    assert!(matches!(finish(&port, "tm-leaf", cg, &local), Completion::Cancel(_)));
    assert_eq!(*port.0.killed.lock().unwrap(), vec![q]);
    assert!(port.table().keys().owner_state("tm-leaf").is_none());
    gate.release();
    client.list_sessions_numbered().await.unwrap();
    let frames = world.frames_for_session(HOST, &session_key);
    assert!(matches!(&frames[..], [Frame::Ctrl(termflow_pty_protocol::Control::Spawn { .. }), Frame::Ctrl(termflow_pty_protocol::Control::Close { tab_id })] if tab_id == &session_key));
    drop(ticket);
    assert_eq!(world.count_everywhere("Close"), 1);
    // A local control with no cancellation registers and is not killed.
    let cg = admit(&port, "tm-control");
    let control = port.0.ids.mint_process_id().unwrap();
    port.table().keys().stage_shell("tm-control", cg, &control, None).unwrap();
    assert!(matches!(finish(&port, "tm-control", cg, &current(&port, "tm-control")), Completion::Registered));
    assert_eq!(port.0.killed.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn stale_completion_kills_only_its_local_stage_and_cannot_publish_over_successor() {
    let (_, port) = machine(HostSpec::default());
    let old_cg = admit(&port, "tm-leaf");
    let old = StagedShell { process: "pc-00000000000040008000000000000001".into(), stage: ShellStage::Local };
    port.table().keys().stage_shell("tm-leaf", old_cg, &old.process, None).unwrap();
    assert_eq!(port.table().keys().abort_create("tm-leaf", old_cg).unwrap().process, old.process);
    let cg = admit(&port, "tm-leaf");
    let q = "pc-00000000000040008000000000000002";
    port.table().keys().stage_shell("tm-leaf", cg, q, None).unwrap();
    assert!(cg > old_cg);
    assert!(matches!(finish(&port, "tm-leaf", old_cg, &old), Completion::Stale));
    assert_eq!(*port.0.killed.lock().unwrap(), vec![old.process]);
    assert_eq!(current(&port, "tm-leaf").process, q);
    assert_eq!(port.table().keys().owner_state("tm-leaf").unwrap().0, cg);
    assert!(port.table().keys().stage_shell("tm-leaf", cg, "pc-wrong", None).is_err());
    assert!(port.table().keys().restage_shell("tm-leaf", old_cg, "pc-wrong", None).is_err());
    assert!(matches!(finish(&port, "tm-leaf", cg, &current(&port, "tm-leaf")), Completion::Registered));
    assert_eq!(port.table().keys().resolve_process(q, false), Some(q.into()));
    assert!(port.table().keys().abort_create("tm-leaf", old_cg).is_none());
}

#[tokio::test]
async fn host_exit_persists_once_duplicate_exit_is_dropped_and_staged_exit_never_registers() {
    let (world, port) = machine(HostSpec::default());
    let pc = create(&port, "tm-leaf").await.unwrap();
    let session_key = key(&current(&port, "tm-leaf"));
    assert_eq!(world.count_everywhere("Spawn"), 1);
    let gate = Arc::new(EventGate::default());
    world.inject_frame(HOST, 0, Frame::Data(Data::Exit { tab_id: session_key.clone(), exit_cwd: None }), Some(gate.clone()));
    gate.wait_reached(1).await;
    gate.release();
    until(|| port.0.persisted.lock().unwrap().len() == 1).await;
    assert_eq!(*port.0.persisted.lock().unwrap(), vec![pc.clone()]);
    assert_eq!(*port.0.exits.lock().unwrap(), vec![pc.clone()]);
    assert!(port.table().keys().owner_state("tm-leaf").is_none());
    let duplicate = Arc::new(EventGate::default());
    let dropped = port.table().routes().dropped_frames();
    world.inject_frame(HOST, 0, Frame::Data(Data::Exit { tab_id: session_key, exit_cwd: None }), Some(duplicate.clone()));
    duplicate.wait_reached(1).await;
    duplicate.release();
    until(|| port.table().routes().dropped_frames() > dropped).await;
    assert_eq!(port.0.persisted.lock().unwrap().len(), 1);
    let q = create(&port, "tm-leaf").await.unwrap();
    assert_ne!(pc, q);
    assert_eq!(world.count_everywhere("Spawn"), 2);
    port.teardown_pane(&q);
    port.teardown_pane(&q);
    assert_eq!(*port.0.persisted.lock().unwrap(), vec![pc, q.clone()]);
    assert_eq!(port.0.torn_down.lock().unwrap().iter().filter(|p| *p == &q).count(), 1);

    let gate = Arc::new(EventGate::default());
    world.add_host("staged-host", HostSpec { reply_gates: std::collections::HashMap::from([("Spawn", gate.clone())]), ..HostSpec::default() });
    let staged_port = FakePort::new(&world, "staged-host");
    staged_port.set_candidates(vec![candidate("staged-host", HostRole::Current)]);
    let job = tokio::spawn({ let port = staged_port.clone(); async move { create(&port, "tm-staged").await } });
    gate.wait_reached(1).await;
    let shell = current(&staged_port, "tm-staged");
    let exit = Arc::new(EventGate::default());
    world.inject_frame("staged-host", 0, Frame::Data(Data::Exit { tab_id: key(&shell), exit_cwd: None }), Some(exit.clone()));
    exit.wait_reached(1).await;
    exit.release();
    until(|| matches!(staged_port.table().keys().owner_state("tm-staged"), Some((_, OwnerState::Placing { staged_exited: true, .. })))).await;
    gate.release();
    assert_eq!(job.await.unwrap().unwrap(), shell.process);
    assert!(staged_port.table().keys().owner_state("tm-staged").is_none());
    assert!(!staged_port.0.terminals.contains_key(&shell.process));
    assert!(staged_port.0.persisted.lock().unwrap().is_empty());
    assert!(matches!(staged_port.table().keys().state(CHANNEL, &key(&shell)), Some(KeyState::Ending { close: CloseState::None, .. })));
}

#[tokio::test]
async fn closing_exit_is_inert_and_local_exit_uses_the_same_single_ending() {
    let (_, port) = machine(HostSpec::default());
    for closing in [false, true] {
        let leaf = if closing { "tm-closing" } else { "tm-local" };
        let cg = admit(&port, leaf);
        let pc = port.0.ids.mint_process_id().unwrap();
        port.table().keys().stage_shell(leaf, cg, &pc, None).unwrap();
        finish(&port, leaf, cg, &current(&port, leaf));
        assert_eq!(port.table().keys().resolve_process(&pc, false), Some(pc.clone()));
        if closing {
            assert!(matches!(port.table().keys().close_process(&pc, CloseStorage::Delete), CloseAction::End { .. }));
            assert!(!port.table().keys().note_exit(&pc));
            assert!(matches!(port.table().keys().owner_state(leaf), Some((_, OwnerState::Closing(_)))));
            assert!(port.table().keys().admit_create(leaf, CreateMode::Mount).err().unwrap().starts_with("host-ownership-pending:"));
            assert!(port.end_owner(&pc, EndKind::Close(CloseStorage::Delete)));
            assert_eq!(*port.0.deleted.lock().unwrap(), vec![leaf.to_string()]);
            assert_eq!(*port.0.killed.lock().unwrap(), vec![pc]);
        } else {
            assert!(port.table().keys().note_exit(&pc));
            assert!(port.end_owner(&pc, EndKind::Exit));
            assert!(!port.table().keys().note_exit(&pc));
            assert!(!port.end_owner(&pc, EndKind::Exit));
            assert_eq!(*port.0.persisted.lock().unwrap(), vec![pc]);
        }
        assert!(port.table().keys().owner_state(leaf).is_none());
    }
}

#[tokio::test]
async fn delayed_process_ingress_never_retargets_a_restarted_leaf_with_the_same_short_prefix() {
    let (world, port) = machine(HostSpec::default());
    let sequence = std::sync::atomic::AtomicUsize::new(1);
    let port = port.with_ids(crate::state::IdAllocator::new(move || {
        let n = sequence.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(uuid::Uuid::parse_str(&format!("000000000000400080000000{n:08x}")).unwrap())
    }));
    let p = create(&port, "tm-leaf").await.unwrap();
    let old_key = key(&current(&port, "tm-leaf"));
    assert_eq!(world.count_everywhere("Spawn"), 1);
    let mut output = port.0.output.subscribe();
    let arrival = Arc::new(EventGate::default());
    let observed = tokio::spawn({ let port = port.clone(); let p = p.clone(); let arrival = arrival.clone(); async move {
        arrival.hold().await;
        for action in ["gui-close", "rest-delete", "fleet-close", "input", "ws-input", "resize", "execute", "prompt", "batch-input", "batch-execute", "fleet-execute", "owner", "label", "color", "adopt"] {
            match action {
                "gui-close" | "rest-delete" | "fleet-close" => assert!(!close(&port, &p, CloseStorage::Preserve), "{action}"),
                _ => assert!(port.table().keys().resolve_process(&p, false).is_none(), "{action}"),
            }
        }
        assert!(!crate::state::retarget_owning_tab(&port.0.terminals, &p, "tb-wrong").unwrap());
        assert!(!crate::state::set_display_label(&port.0.terminals, &p, Some("wrong")).unwrap());
        assert!(!crate::state::set_title_color(&port.0.terminals, &p, Some("red")).unwrap());
    }});
    arrival.wait_reached(1).await;
    world.end_session(HOST, &old_key);
    assert!(port.table().keys().note_exit(&p));
    assert!(port.end_owner(&p, EndKind::Exit));
    let q = create(&port, "tm-leaf").await.unwrap();
    let new_key = key(&current(&port, "tm-leaf"));
    assert_ne!(p, q);
    assert_eq!(p.len(), 35);
    assert_eq!(q.len(), 35);
    assert_eq!(&p[..12], &q[..12]);
    assert_ne!(old_key, new_key);
    assert_eq!(world.count_everywhere("Spawn"), 2);
    assert_eq!(port.table().keys().resolve_process(&q, false), Some(q.clone()));
    arrival.release();
    observed.await.unwrap();
    assert_eq!(world.count_everywhere("Close"), 0);
    assert_eq!(port.table().keys().state(CHANNEL, &new_key), Some(KeyState::Bound(q.clone())));
    assert!(port.0.terminals.contains_key(&q));
    let control = crate::state::host_registry::route_write(&port.0.host_terminals, &port.0.terminals, &q, b"control", &|c| port.client_for(c));
    assert!(control);
    assert!(crate::state::host_registry::route_resize(&port.0.host_terminals, &port.0.terminals, &q, 91, 37, &|c| port.client_for(c)));
    assert!(crate::state::retarget_owning_tab(&port.0.terminals, &q, "tb-new").unwrap());
    assert!(crate::state::set_display_label(&port.0.terminals, &q, Some("new")).unwrap());
    assert!(crate::state::set_title_color(&port.0.terminals, &q, Some("blue")).unwrap());
    let client = port.current_client().unwrap();
    let listing = client.list_sessions_numbered().await.unwrap();
    assert!(listing.sessions.iter().any(|s| s.tab_id == new_key && s.alive));
    assert!(!listing.sessions.iter().any(|s| s.tab_id == old_key));
    assert!(world.sessions(HOST, "Stdin").contains(&new_key));
    assert!(world.sessions(HOST, "Resize").contains(&new_key));
    let frame = Arc::new(EventGate::default());
    world.inject_frame(HOST, 0, Frame::Data(Data::Stdout { tab_id: new_key.clone(), offset: 0, bytes: b"Q alive".to_vec() }), Some(frame.clone()));
    frame.wait_reached(1).await;
    frame.release();
    let got = tokio::time::timeout(Duration::from_secs(3), output.recv()).await.unwrap().unwrap();
    assert_eq!(got.id, q);
    assert_eq!(got.data, b"Q alive");
    assert_eq!(world.count_everywhere("Close"), 0);
    assert!(close(&port, "tm-leaf", CloseStorage::Preserve));
    client.list_sessions_numbered().await.unwrap();
    assert_eq!(world.sessions(HOST, "Close"), vec![new_key]);
    assert!(port.table().keys().owner_state("tm-leaf").is_none());
}

#[tokio::test]
async fn registered_process_close_controls_preserve_each_callers_storage_policy() {
    let (world, port) = machine(HostSpec::default());
    let mut closed = Vec::new();
    for (leaf, policy) in [("tm-gui", CloseStorage::Delete), ("tm-rest", CloseStorage::Preserve), ("tm-fleet", CloseStorage::Preserve)] {
        let pc = create(&port, leaf).await.unwrap();
        let session_key = key(&current(&port, leaf));
        assert_eq!(port.table().keys().resolve_process(&pc, false), Some(pc.clone()));
        assert!(close(&port, &pc, policy));
        port.current_client().unwrap().list_sessions_numbered().await.unwrap();
        closed.push(session_key);
        assert_eq!(world.sessions(HOST, "Close"), closed);
        assert!(!close(&port, &pc, policy));
        assert!(port.table().keys().owner_state(leaf).is_none());
    }
    assert_eq!(world.count_everywhere("Spawn"), 3);
    assert_eq!(*port.0.deleted.lock().unwrap(), vec!["tm-gui".to_string()]);
    assert!(port.0.persisted.lock().unwrap().is_empty());
}

#[tokio::test]
async fn elevated_channel_exit_ends_only_its_named_owner_once() {
    let (world, port) = machine(HostSpec::default());
    let channel = HostChannel::Elevated;
    let epoch = port.table().reserve_epoch();
    assert!(port.table().publish(channel, epoch));
    let stream = world.open(HOST).unwrap();
    let (rd, wr) = tokio::io::split(stream);
    let client = crate::pty_host_client::wire_client(rd, wr, port.deps(channel, epoch, Arc::new(|| {})));
    client.bind_sessions(port.table().keys(), channel, epoch);
    let mut shells = Vec::new();
    for leaf in ["tm-elevated", "tm-control"] {
        let cg = admit(&port, leaf);
        let pc = port.0.ids.mint_process_id().unwrap();
        let session_key = port.0.ids.mint_session_key(leaf).unwrap();
        let (stage, _, _) = port.table().keys().stage_shell(leaf, cg, &pc, Some((channel, &session_key, crate::state::StageMode::Spawn))).unwrap();
        assert!(port.table().keys().publish(&stage.unwrap(), &pc, epoch));
        port.register_terminal(&pc, &session_key, channel);
        assert_eq!(client.spawn_session(&session_key, &spec()).await.unwrap(), 4242);
        assert!(matches!(finish(&port, leaf, cg, &current(&port, leaf)), Completion::Registered));
        shells.push((pc, session_key));
    }
    assert_eq!(world.count_everywhere("Spawn"), 2);
    let (pc, session_key) = &shells[0];
    for count in 1..=2 {
        let gate = Arc::new(EventGate::default());
        let drops = port.table().routes().dropped_frames();
        world.inject_frame(HOST, 0, Frame::Data(Data::Exit { tab_id: session_key.clone(), exit_cwd: None }), Some(gate.clone()));
        gate.wait_reached(1).await;
        gate.release();
        if count == 1 { until(|| port.0.persisted.lock().unwrap().len() == 1).await; }
        else { until(|| port.table().routes().dropped_frames() > drops).await; }
        assert_eq!(*port.0.persisted.lock().unwrap(), vec![pc.clone()]);
        assert_eq!(*port.0.exits.lock().unwrap(), vec![pc.clone()]);
    }
    let (control, control_key) = &shells[1];
    assert_eq!(port.table().keys().resolve_process(control, false), Some(control.clone()));
    assert_eq!(port.table().keys().state(channel, control_key), Some(KeyState::Bound(control.clone())));
    assert_eq!(world.count_everywhere("Close"), 0);
}
