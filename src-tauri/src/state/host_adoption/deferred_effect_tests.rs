use super::*;
use super::fake_hosts::*;
use super::owner_tests::{machine, create, until};
use super::panes::{reconnect_snapshot, reattach_listed};
use crate::state::{CloseStorage, Completion, CreateAdmission, CreateMode, EndKind, KeyState, CloseState, ShellStage, StageMode, StagedShell};
use crate::state::{host_registry, ingress};
use termflow_pty_protocol::{Data, Frame, Control};

const HOST: &str = "owner-host";
const PRIMARY: HostChannel = HostChannel::Primary;

pub(super) fn stage(port: &FakePort, channel: HostChannel, leaf: &str, key: &str) -> (u64, StagedShell, crate::state::Ticket) {
    let keys = port.table().keys();
    let CreateAdmission::Run(cg) = keys.admit_create(leaf, CreateMode::Mount).unwrap() else { panic!("admission") };
    let pc = port.0.ids.mint_process_id().unwrap();
    let (hosted, _, _) = keys.stage_shell(leaf, cg, &pc, Some((channel, key, StageMode::Attach))).unwrap();
    let hosted = hosted.unwrap();
    let mut ticket = port.table().begin(channel).unwrap();
    ticket.guard_key(hosted.clone());
    assert!(ticket.publish_key(&pc));
    port.register_terminal(&pc, key, channel);
    port.0.terminals.get_mut(&pc).unwrap().renderer_terminal_id = Some(leaf.into());
    (cg, StagedShell { process: pc, stage: ShellStage::Hosted(hosted) }, ticket)
}

pub(super) fn finish(port: &FakePort, leaf: &str, cg: u64, shell: &StagedShell) {
    assert!(matches!(port.table().keys().complete_shell(leaf, cg, shell), Completion::Registered));
}
fn abort(port: &FakePort, leaf: &str, cg: u64, shell: &StagedShell) {
    assert_eq!(port.table().keys().abort_create(leaf, cg).unwrap().process, shell.process);
    port.0.host_terminals.remove(&shell.process);
    port.0.terminals.remove(&shell.process);
}
pub(super) async fn fence(port: &FakePort, client: &PtyHostClient, channel: HostChannel) -> SessionListing {
    let listing = client.list_sessions_numbered().await.unwrap();
    port.apply_listing(channel, client, Some(&listing));
    listing
}

#[tokio::test]
async fn reconnect_continuation_cannot_close_or_repaint_a_rebound_attach_key() {
    for frozen in [false, true] {
        let world = World::new();
        let gate = Arc::new(EventGate::default());
        world.add_host(HOST, HostSpec {
            sessions: vec![meta("shared", 4242), meta("control", 4343)],
            reply_gates: std::collections::HashMap::from([("Attach", gate.clone())]),
            ..HostSpec::default()
        });
        world.add_host("fresh", HostSpec::default());
        let port = FakePort::new(&world, if frozen { "fresh" } else { HOST });
        port.set_candidates(if frozen {
            vec![candidate(HOST, HostRole::Frozen), candidate("fresh", HostRole::Current)]
        } else { vec![candidate(HOST, HostRole::Current)] });
        ensure_hosts(&port).await.unwrap();
        until(|| !frozen || !port.frozen_hosts().is_empty()).await;
        let channel = if frozen { HostChannel::Frozen(port.frozen_hosts()[0].id) } else { PRIMARY };
        let client = port.client_for(channel).unwrap();
        let keys = port.table().keys();
        let (cg, p, ticket) = stage(&port, channel, "tm-P", "shared");
        let identity = keys.session_identity(channel, "shared", &p.process).unwrap();
        assert_eq!(identity.cg, Some(cg));
        let failed_attach = tokio::spawn({ let client = client.clone(); let identity = identity.clone(); async move { client.attach_owned(&identity, 17).await } });
        gate.wait_reached(1).await;
        let snapshot = reconnect_snapshot(&port, channel);
        assert_eq!(snapshot["shared"].process, p.process);
        let resumed = Arc::new(EventGate::default());
        let old_pass = tokio::spawn({ let port = port.clone(); let client = client.clone(); let resumed = resumed.clone(); let old_pc = p.process.clone(); async move {
            resumed.hold().await;
            reattach_listed(&port, channel, &client, &snapshot, &[meta("shared", 4242)], &|| true).await;
            assert!(!port.table().keys().cleanup_session_projection(channel, "shared", &old_pc, || {
                port.0.offsets.remove("shared");
            }));
        }});
        resumed.wait_reached(1).await;
        abort(&port, "tm-P", cg, &p);
        assert_eq!(keys.state(channel, "shared"), Some(KeyState::Listed));
        drop(ticket);
        gate.release();
        assert_eq!(failed_attach.await.unwrap().unwrap(), Some(true));
        let (q_cg, q, q_ticket) = stage(&port, channel, "tm-R", "shared");
        assert!(q_cg > cg);
        let q_attach = tokio::spawn({ let client = client.clone(); let identity = keys.session_identity(channel, "shared", &q.process).unwrap(); async move { client.attach_owned(&identity, 23).await } });
        gate.wait_reached(2).await;
        gate.release();
        assert_eq!(q_attach.await.unwrap().unwrap(), Some(true));
        finish(&port, "tm-R", q_cg, &q);
        assert_eq!(keys.state(channel, "shared"), Some(KeyState::Bound(q.process.clone())));
        port.0.offsets.insert("shared".into(), 239);
        resumed.release();
        old_pass.await.unwrap();
        let listing = fence(&port, &client, channel).await;
        assert_eq!(world.sessions(HOST, "Attach"), vec!["shared", "shared"]);
        assert_eq!(world.count_everywhere("Close"), 0);
        assert_eq!(world.count_everywhere("Resize"), 0);
        assert!(listing.sessions.iter().any(|s| s.tab_id == "shared" && s.pid == 4242 && s.alive));
        assert_eq!(port.table().routes().resolve(channel, "shared", port.table().epoch(channel).unwrap(), true), Some(q.process.clone()));
        assert!(port.0.terminals.contains_key(&q.process));
        assert_eq!(port.0.offsets.get("shared").map(|o| *o), Some(239));
        assert!(keys.cleanup_session_projection(channel, "shared", &q.process, || { port.0.offsets.remove("shared"); }));
        assert!(!port.0.offsets.contains_key("shared"));
        drop(q_ticket);

        // When the original cell still names the missing pane, close is owed.
        let (control_cg, control, control_ticket) = stage(&port, channel, "tm-control", "control");
        finish(&port, "tm-control", control_cg, &control);
        let snapshot = reconnect_snapshot(&port, channel);
        port.0.host_terminals.remove(&control.process);
        port.0.terminals.remove(&control.process);
        let control_snapshot = std::collections::HashMap::from([("control".into(), snapshot["control"].clone())]);
        reattach_listed(&port, channel, &client, &control_snapshot, &[meta("control", 4343)], &|| true).await;
        fence(&port, &client, channel).await;
        assert_eq!(world.sessions(HOST, "Close"), vec!["control"]);
        assert_eq!(keys.state(channel, "shared"), Some(KeyState::Bound(q.process)));
        drop(control_ticket);
    }
}

#[tokio::test]
async fn process_and_wire_staged_exits_end_the_same_key_and_ticket_cannot_release_it() {
    for channel in [PRIMARY, HostChannel::Elevated] {
        for wire in [false, true] {
            let (world, port) = machine(HostSpec { sessions: vec![meta("exited", 4242), meta("control", 4343)], ..HostSpec::default() });
            ensure_hosts(&port).await.unwrap();
            let client = if channel == PRIMARY { port.current_client().unwrap() } else {
                let epoch = port.table().reserve_epoch().unwrap();
                assert!(port.table().publish(channel, epoch));
                let (rd, wr) = tokio::io::split(world.open(HOST).unwrap());
                let client = crate::pty_host_client::wire_client(rd, wr, port.deps(channel, epoch, Arc::new(|| {})));
                client.bind_sessions(port.table().keys(), channel, epoch);
                fence(&port, &client, channel).await;
                client
            };
            let (cg, p, ticket) = stage(&port, channel, "tm-P", "exited");
            let before = client.list_sessions_numbered().await.unwrap();
            let stamp = before.request_no;
            if wire {
                let delivered = Arc::new(EventGate::default());
                world.inject_frame(HOST, if channel == PRIMARY { 0 } else { 1 },
                    Frame::Data(Data::Exit { tab_id: "exited".into(), exit_cwd: None }), Some(delivered.clone()));
                delivered.wait_reached(1).await;
                delivered.release();
                until(|| matches!(port.table().keys().state(channel, "exited"), Some(KeyState::Ending { close: CloseState::None, .. }))).await;
            } else { assert!(!port.table().keys().note_exit(&p.process)); }
            let expected = Some(KeyState::Ending { close: CloseState::None, stamp: Some(stamp) });
            assert_eq!(port.table().keys().state(channel, "exited"), expected);
            assert!(!port.table().routes().contains(channel, "exited"));
            assert!(matches!(port.table().keys().complete_shell("tm-P", cg, &p), Completion::Exited));
            assert!(port.table().keys().owner_state("tm-P").is_none());
            drop(ticket);
            assert_eq!(port.table().keys().state(channel, "exited"), expected);
            // A reply requested before the exit is not release evidence.
            port.table().keys().listing(channel, &SessionListing { request_no: stamp, sessions: vec![] }, |_| false);
            assert_eq!(port.table().keys().state(channel, "exited"), expected);
            world.end_session(HOST, "exited");
            let after = fence(&port, &client, channel).await;
            assert!(after.request_no > stamp);
            assert!(port.table().keys().state(channel, "exited").is_none());
            assert_eq!(port.table().keys().state(channel, "control"), Some(KeyState::Listed));
            assert_eq!(world.count_everywhere("Close"), 0);
        }
    }
    let (_, port) = machine(HostSpec::default());
    let CreateAdmission::Run(cg) = port.table().keys().admit_create("tm-local", CreateMode::Mount).unwrap() else { panic!("admit") };
    port.table().keys().stage_shell("tm-local", cg, "pc-local", None).unwrap();
    assert!(!port.table().keys().note_exit("pc-local"));
    assert!(matches!(port.table().keys().complete_shell("tm-local", cg, &StagedShell { process: "pc-local".into(), stage: ShellStage::Local }), Completion::Exited));
    assert!(port.table().keys().owner_state("tm-local").is_none());
}

#[tokio::test]
async fn an_alias_holder_registers_while_another_leaf_is_attaching_and_survives_its_abort() {
    let gate = Arc::new(EventGate::default());
    let (world, port) = machine(HostSpec { sessions: vec![meta("shared", 4242), meta("control", 4343)],
        reply_gates: std::collections::HashMap::from([("Attach", gate.clone())]), ..HostSpec::default() });
    ensure_hosts(&port).await.unwrap();
    let now = std::time::Instant::now();
    assert!(host_registry::register_restoring_leaf(&port.intent_maps(), "C", "tm-C", Some("shared"), now));
    let (cg, p, ticket) = stage(&port, PRIMARY, "tm-P", "shared");
    let client = port.current_client().unwrap();
    let attach = tokio::spawn({ let client = client.clone(); let identity = port.table().keys().session_identity(PRIMARY, "shared", &p.process).unwrap(); async move { client.attach_owned(&identity, 0).await } });
    gate.wait_reached(1).await;
    assert!(host_registry::register_restoring_leaf(&port.intent_maps(), "R", "tm-R", Some("shared"), now));
    assert!(port.table().keys().has_test_holder("R", "tm-R"));
    assert!(!host_registry::register_restoring_leaf(&port.intent_maps(), "P-reload", "tm-P", Some("shared"), now));
    host_registry::forget_restoring_leaf(&port.intent_maps(), "C", "tm-C", now);
    abort(&port, "tm-P", cg, &p);
    drop(ticket);
    assert!(host_registry::register_restoring_leaf(&port.intent_maps(), "third", "tm-third", Some("shared"), now));
    host_registry::forget_restoring_leaf(&port.intent_maps(), "third", "tm-third", now);
    gate.release();
    assert_eq!(attach.await.unwrap().unwrap(), Some(true));
    let listing = fence(&port, &client, PRIMARY).await;
    assert_eq!(world.sessions(HOST, "Attach"), vec!["shared"]);
    assert_eq!(world.count_everywhere("Close"), 0);
    assert!(listing.sessions.iter().any(|s| s.tab_id == "shared" && s.alive && s.pid == 4242));
    assert_eq!(port.table().keys().state(PRIMARY, "shared"), Some(KeyState::Listed));
    assert!(port.table().keys().has_test_holder("R", "tm-R"));
    // Forgetting the final holder is a positive close control.
    host_registry::forget_restoring_leaf(&port.intent_maps(), "R", "tm-R", now);
    fence(&port, &client, PRIMARY).await;
    client.list_sessions_numbered().await.unwrap();
    assert_eq!(world.sessions(HOST, "Close"), vec!["shared"]);
    assert_eq!(port.table().keys().state(PRIMARY, "control"), Some(KeyState::Listed));
}

#[tokio::test]
async fn reflow_ingress_rejects_placing_and_closing_and_never_resizes_a_rebound_key() {
    let (world, port) = machine(HostSpec { sessions: vec![meta("shared", 4242)], ..HostSpec::default() });
    ensure_hosts(&port).await.unwrap();
    let (cg, p, ticket) = stage(&port, PRIMARY, "tm-P", "shared");
    assert!(ingress::registered_target(port.table().keys(), &p.process).is_none());
    assert!(!host_registry::route_resize(port.table().keys(), &port.0.host_terminals, &port.0.terminals, &p.process, 91, 37, &|c| port.client_for(c)));
    let gate = Arc::new(EventGate::default());
    let delayed = tokio::spawn({ let port = port.clone(); let p = p.clone(); let gate = gate.clone(); async move {
        gate.hold().await;
        assert!(!host_registry::route_resize(port.table().keys(), &port.0.host_terminals, &port.0.terminals, &p.process, 99, 39, &|c| port.client_for(c)));
    }});
    gate.wait_reached(1).await;
    abort(&port, "tm-P", cg, &p);
    drop(ticket);
    let (q_cg, q, q_ticket) = stage(&port, PRIMARY, "tm-R", "shared");
    finish(&port, "tm-R", q_cg, &q);
    assert_eq!(ingress::registered_target(port.table().keys(), &q.process), Some(q.process.clone()));
    assert!(host_registry::route_resize(port.table().keys(), &port.0.host_terminals, &port.0.terminals, &q.process, 93, 41, &|c| port.client_for(c)));
    gate.release();
    delayed.await.unwrap();
    let client = port.current_client().unwrap();
    fence(&port, &client, PRIMARY).await;
    assert_eq!(world.frames_for_session(HOST, "shared"), vec![Frame::Ctrl(Control::Resize { tab_id: "shared".into(), cols: 93, rows: 41 })]);
    assert_eq!(port.table().keys().state(PRIMARY, "shared"), Some(KeyState::Bound(q.process.clone())));
    assert!(matches!(port.table().keys().close_process(&q.process, CloseStorage::Preserve), crate::state::CloseAction::End { .. }));
    assert!(ingress::registered_target(port.table().keys(), &q.process).is_none());
    assert!(!host_registry::route_resize(port.table().keys(), &port.0.host_terminals, &port.0.terminals, &q.process, 101, 43, &|c| port.client_for(c)));
    client.list_sessions_numbered().await.unwrap();
    assert_eq!(world.sessions(HOST, "Resize"), vec!["shared"]);
    drop(q_ticket);
}

#[tokio::test]
async fn production_ingress_decisions_recheck_the_resolved_process_before_each_effect() {
    let (world, port) = machine(HostSpec::default());
    let p = create(&port, "tm-leaf").await.unwrap();
    let old_key = port.0.terminals.get(&p).unwrap().session_key.clone();
    let keys = port.table().keys();
    let write_target = ingress::registered_target(keys, "tm-leaf").unwrap();
    let resize_target = ingress::registered_target(keys, &p).unwrap();
    let metadata_target = ingress::metadata_target(keys, "tm-leaf").unwrap().unwrap();
    let close_target = ingress::close_target(keys, "tm-leaf").unwrap();
    assert_eq!([&write_target, &resize_target, &metadata_target, &close_target], [&p; 4]);
    let gate = Arc::new(EventGate::default());
    let old = tokio::spawn({ let port = port.clone(); let gate = gate.clone(); async move {
        gate.hold().await;
        let keys = port.table().keys();
        assert!(!host_registry::route_write(keys, &port.0.host_terminals, &port.0.terminals, &write_target, b"P input", &|c| port.client_for(c)));
        assert!(!host_registry::route_resize(keys, &port.0.host_terminals, &port.0.terminals, &resize_target, 81, 25, &|c| port.client_for(c)));
        for change in [ingress::Metadata::OwningTab("tb-wrong"), ingress::Metadata::Label(Some("wrong")), ingress::Metadata::Color(Some("red"))] {
            assert!(!ingress::metadata(keys, &port.0.terminals, &metadata_target, change).unwrap());
        }
        for policy in [CloseStorage::Delete, CloseStorage::Preserve] {
            assert!(!ingress::close(keys, &close_target, policy, |_| panic!("stale close effect")));
        }
    }});
    gate.wait_reached(1).await;
    world.end_session(HOST, &old_key);
    assert!(keys.note_exit(&p));
    assert!(port.end_owner(&p, EndKind::Exit));
    let q = create(&port, "tm-leaf").await.unwrap();
    let new_key = port.0.terminals.get(&q).unwrap().session_key.clone();
    assert_ne!(p, q);
    assert_eq!(world.count_everywhere("Spawn"), 2);
    assert_eq!(keys.state(PRIMARY, &new_key), Some(KeyState::Bound(q.clone())));
    assert!(ingress::metadata(keys, &port.0.terminals, &q, ingress::Metadata::OwningTab("tb-Q")).unwrap());
    assert!(ingress::metadata(keys, &port.0.terminals, &q, ingress::Metadata::Label(Some("Q label"))).unwrap());
    assert!(ingress::metadata(keys, &port.0.terminals, &q, ingress::Metadata::Color(Some("blue"))).unwrap());
    assert!(host_registry::route_write(keys, &port.0.host_terminals, &port.0.terminals, &q, b"Q input", &|c| port.client_for(c)));
    assert!(host_registry::route_resize(keys, &port.0.host_terminals, &port.0.terminals, &q, 93, 41, &|c| port.client_for(c)));
    gate.release();
    old.await.unwrap();
    let listing = fence(&port, &port.current_client().unwrap(), PRIMARY).await;
    assert!(listing.sessions.iter().any(|s| s.tab_id == new_key && s.alive));
    let frames = world.frames_for_session(HOST, &new_key);
    assert_eq!(frames.len(), 3);
    assert!(matches!(&frames[0], Frame::Ctrl(Control::Spawn { tab_id, .. }) if tab_id == &new_key));
    assert_eq!(&frames[1..], &[
        Frame::Data(Data::Stdin { tab_id: new_key.clone(), bytes: b"Q input".to_vec() }),
        Frame::Ctrl(Control::Resize { tab_id: new_key.clone(), cols: 93, rows: 41 }),
    ]);
    assert_eq!(world.count_everywhere("Close"), 0);
    let terminal = port.0.terminals.get(&q).unwrap();
    assert_eq!(terminal.owning_tab_id.as_deref(), Some("tb-Q"));
    assert_eq!(terminal.display_label.as_deref(), Some("Q label"));
    assert_eq!(terminal.title_color.as_deref(), Some("blue"));
    drop(terminal);
    // GUI deletion and REST/fleet preservation use this same production close
    // adapter. Exercise both policies with actual exact-key host effects.
    for (leaf, policy) in [("tm-leaf", CloseStorage::Delete), ("tm-rest", CloseStorage::Preserve), ("tm-fleet", CloseStorage::Preserve)] {
        let pc = create(&port, leaf).await.unwrap();
        let key = port.0.terminals.get(&pc).unwrap().session_key.clone();
        assert!(ingress::close(keys, &pc, policy, |pc| { assert!(port.end_owner(pc, EndKind::Close(policy))); }));
        port.current_client().unwrap().list_sessions_numbered().await.unwrap();
        assert!(world.sessions(HOST, "Close").contains(&key));
        assert!(!port.0.terminals.contains_key(&pc));
    }
    assert_eq!(world.count_everywhere("Close"), 3);
    assert_eq!(*port.0.deleted.lock().unwrap(), vec!["tm-leaf"]);
}
