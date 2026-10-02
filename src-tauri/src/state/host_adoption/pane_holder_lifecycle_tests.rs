use super::*;
use crate::state::{CreateAdmission, CreateMode, OwnerState};
use std::collections::HashMap;

#[tokio::test]
async fn taken_waiting_holder_survives_rejected_source_close_and_moves_on_adopt() {
    let (world, port) = machine(&[K, "tm-control"]).await;
    let now = Clock::now();
    let mut source = Page::new(&port, "source");
    let mut destination = Page::new(&port, "destination");
    let a = source.enter(&port, "tm-a", Some(K), now);
    assert_eq!(source.op(&port, PaneOp::Stash { tx: "waiting".into(), pairs: vec![a.clone()], ui: None }, now), PaneResult::Ok);
    assert!(matches!(port.table().keys().owner_state("tm-a"), Some((0, OwnerState::Held))));
    let PaneResult::Taken { payload } = destination.op(&port, PaneOp::Take { tx: "waiting".into() }, now) else { panic!("take"); };
    assert!(payload.panes[0].restore);
    assert_eq!(port.table().keys().holder_count(), 1);
    let markers = port.table().keys().marker_count();
    source.close(&port, a.pi, now);
    assert_eq!(port.table().keys().holder_count(), 1);
    assert_eq!(port.table().keys().marker_count(), markers);
    close_control(&mut destination, &port, now);
    listing(&port, now).await;
    let after = fence(&port).await;
    assert_eq!(closes(&world), vec!["tm-control"]);
    assert!(after.sessions.iter().any(|s| s.tab_id == K && s.pid == 100));
    destination.incarnation += 1;
    let b = PaneEntry { pi: PaneIdentity { pg: destination.pg, seq: destination.incarnation }, descriptor: PaneDescriptor {
        pane_id: "destination-waiting".into(), leaf: "tm-a".into(), restore: false, override_key: None,
    } };
    assert_eq!(destination.op(&port, PaneOp::Adopt { tx: "waiting".into(), pairs: vec![b.clone()] }, now), PaneResult::Ok);
    assert!(port.table().keys().is_restoring_key(K, now));
    let PaneResult::Create { cg } = destination.op(&port, PaneOp::AdmitCreate { pi: b.pi, mode: CreateMode::Mount }, now) else { panic!("admission"); };
    assert!(matches!(port.table().keys().admitted_work(destination.label, destination.pg, "tm-a", cg).unwrap(), CreateAdmission::Run(actual) if actual == cg));
    let crate::state::host_routing::Placement::Attach { client, ticket, pid, session_key, .. } =
        crate::state::host_routing::place_owned(&port, "tm-a", Some(K), Some((cg, "pc-destination"))).await.unwrap() else { panic!("attach"); };
    assert_eq!(pid, 100); assert_eq!(session_key, K);
    assert!(ticket.publish_key("pc-destination"));
    assert_eq!(client.attach_confirmed(&session_key, 0).await, Some(true));
    assert!(matches!(port.table().keys().complete_shell("tm-a", cg, &StagedShell { process: "pc-destination".into(), stage: ShellStage::Hosted(ticket.key_stage().unwrap()) }), Completion::Registered));
    assert_eq!(world.sessions(HOST, "Attach"), vec![K]);
    assert_eq!(world.count(HOST, "Spawn"), 0);
    assert_eq!(closes(&world), vec!["tm-control"]);
}

#[tokio::test]
async fn staged_carried_holder_survives_rejected_close_after_placement_aborts() {
    let (world, port) = machine(&[K, "tm-control"]).await;
    let now = Clock::now();
    let mut source = Page::new(&port, "source");
    let mut destination = Page::new(&port, "destination");
    let a = source.enter(&port, "tm-a", Some(K), now);
    let PaneResult::Create { cg } = source.op(&port, PaneOp::AdmitCreate { pi: a.pi, mode: CreateMode::Mount }, now) else { panic!("admission"); };
    let keys = port.table().keys();
    assert!(matches!(keys.admitted_work(source.label, source.pg, "tm-a", cg).unwrap(), CreateAdmission::Run(actual) if actual == cg));
    let crate::state::host_routing::Placement::Attach { ticket, session_key, .. } =
        crate::state::host_routing::place_owned(&port, "tm-a", Some(K), Some((cg, "pc-aborted"))).await.unwrap() else { panic!("attach"); };
    assert_eq!(session_key, K);
    assert_eq!(keys.state(CHANNEL, K), Some(KeyState::Held(cg)));
    assert_eq!(source.op(&port, PaneOp::Stash { tx: "staged".into(), pairs: vec![a.clone()], ui: None }, now), PaneResult::Ok);
    assert_eq!(keys.abort_create("tm-a", cg).unwrap().process, "pc-aborted");
    drop(ticket);
    assert!(keys.owner_state("tm-a").is_none());
    assert_eq!(keys.state(CHANNEL, K), Some(KeyState::Listed));
    assert_eq!(keys.holder_count(), 1);
    source.close(&port, a.pi, now);
    assert_eq!(keys.holder_count(), 1);
    assert_eq!(keys.marker_count(), 0);
    close_control(&mut destination, &port, now);
    listing(&port, now).await;
    assert!(fence(&port).await.sessions.iter().any(|s| s.tab_id == K && s.pid == 100));
    assert_eq!(closes(&world), vec!["tm-control"]);
    let PaneResult::Taken { payload } = destination.op(&port, PaneOp::Take { tx: "staged".into() }, now) else { panic!("take"); };
    assert!(payload.panes[0].restore);
    assert_eq!(payload.panes[0].override_key.as_deref(), Some(K));
}

#[tokio::test]
async fn restoring_successor_entered_during_attach_keeps_session_after_old_work_aborts() {
    let gate = Arc::new(EventGate::default());
    let world = World::new();
    world.add_host(HOST, HostSpec { sessions: vec![meta(K, 100), meta("tm-control", 101)], reply_gates: HashMap::from([("Attach", gate.clone())]), ..HostSpec::default() });
    let port = FakePort::new(&world, HOST);
    port.set_candidates(vec![candidate(HOST, HostRole::Current)]);
    ensure_hosts(&port).await.unwrap();
    let keys = port.table().keys();
    let now = Clock::now();
    let mut old = Page::new(&port, "owner");
    let a = old.enter(&port, "tm-a", Some(K), now);
    let PaneResult::Create { cg } = old.op(&port, PaneOp::AdmitCreate { pi: a.pi, mode: CreateMode::Mount }, now) else { panic!("admission"); };
    assert!(matches!(keys.admitted_work(old.label, old.pg, "tm-a", cg).unwrap(), CreateAdmission::Run(actual) if actual == cg));
    let crate::state::host_routing::Placement::Attach { client, ticket, session_key, .. } =
        crate::state::host_routing::place_owned(&port, "tm-a", Some(K), Some((cg, "pc-old"))).await.unwrap() else { panic!("attach"); };
    assert_eq!(session_key, K);
    assert!(ticket.publish_key("pc-old"));
    let identity = keys.session_identity(CHANNEL, K, "pc-old").unwrap();
    let pending = tokio::spawn(async move { client.attach_owned(&identity, 0).await });
    gate.wait_reached(1).await;
    assert_eq!(world.sessions(HOST, "Attach"), vec![K]);
    assert_eq!(keys.state(CHANNEL, K), Some(KeyState::Held(cg)));
    let PageRegistration::Registered { pg, .. } = keys.register_page(old.label).unwrap() else { panic!("successor"); };
    let mut successor = Page { label: old.label, wi: old.wi, pg, seq: 0, incarnation: 0 };
    let b = successor.enter(&port, "tm-a", Some(K), now);
    assert_eq!(keys.holder_count(), 2, "staged old work is not the new copy's capability");
    assert_eq!(successor.op(&port, PaneOp::Settle, now), PaneResult::Ok);
    assert_eq!(keys.holder_count(), 1);
    pending.abort();
    assert!(pending.await.unwrap_err().is_cancelled());
    // The create guard's abort sink releases failed Attach without closing it.
    let aborted = keys.abort_create("tm-a", cg).unwrap();
    assert_eq!(aborted.process, "pc-old");
    drop(ticket);
    assert_eq!(keys.state(CHANNEL, K), Some(KeyState::Listed));
    gate.release();
    let mut other = Page::new(&port, "other");
    let marker = other.enter(&port, "tm-alias", Some(K), now);
    other.close(&port, marker.pi, now);
    close_control(&mut other, &port, now);
    listing(&port, now).await;
    let after = fence(&port).await;
    assert_eq!(closes(&world), vec!["tm-control"]);
    assert!(after.sessions.iter().any(|s| s.tab_id == K && s.pid == 100));
    assert!(keys.is_restoring_key(K, now));
    let PaneResult::Create { cg: next } = successor.op(&port, PaneOp::AdmitCreate { pi: b.pi, mode: CreateMode::Mount }, now) else { panic!("new admission"); };
    assert_ne!(next, cg);
    assert!(matches!(keys.admitted_work(successor.label, successor.pg, "tm-a", next).unwrap(), CreateAdmission::Run(actual) if actual == next));
    let crate::state::host_routing::Placement::Attach { client, ticket, pid, .. } =
        crate::state::host_routing::place_owned(&port, "tm-a", Some(K), Some((next, "pc-new"))).await.unwrap() else { panic!("successor attach"); };
    assert_eq!(pid, 100);
    assert!(ticket.publish_key("pc-new"));
    let identity = keys.session_identity(CHANNEL, K, "pc-new").unwrap();
    let work = tokio::spawn(async move { client.attach_owned(&identity, 0).await });
    gate.wait_reached(2).await;
    gate.release();
    assert_eq!(work.await.unwrap().unwrap(), Some(true));
    assert!(matches!(keys.complete_shell("tm-a", next, &StagedShell { process: "pc-new".into(), stage: ShellStage::Hosted(ticket.key_stage().unwrap()) }), Completion::Registered));
    assert_eq!(world.sessions(HOST, "Attach"), vec![K, K]);
    assert_eq!(keys.state(CHANNEL, K), Some(KeyState::Bound("pc-new".into())));
    assert_eq!(closes(&world), vec!["tm-control"]);
}

#[tokio::test]
async fn empty_startup_settle_releases_listed_recovery_after_other_window_finishes() {
    let (world, port) = machine(&[K]).await;
    let keys = port.table().keys();
    let mut main = Page::new(&port, "main");
    let mut other = Page::new(&port, "other");
    keys.begin_restore_participation(["main".into(), "other".into()]);
    assert_eq!(keys.restore_pending_count(), 2);
    main.seq += 1;
    let request = PaneRequest { pg: main.pg, seq: main.seq, op: PaneOp::Settle };
    let (reply, effects) = keys.pane_op(main.label, request.clone()).unwrap();
    assert_eq!(reply, PaneReply::Ack { result: PaneResult::Ok });
    assert!(effects.release_restore_sweep);
    assert_eq!(keys.restore_pending_count(), 1);
    assert!(!keys.pane_op(main.label, request).unwrap().1.release_restore_sweep, "cached ack does not re-run the effect");
    assert_eq!(world.count(HOST, "List"), 1);
    assert!(port.0.recovered.lock().unwrap().is_empty());
    other.seq += 1;
    let (reply, effects) = keys.pane_op(other.label, PaneRequest { pg: other.pg, seq: other.seq, op: PaneOp::Settle }).unwrap();
    assert_eq!(reply, PaneReply::Ack { result: PaneResult::Ok });
    assert!(effects.release_restore_sweep);
    assert_eq!(keys.restore_pending_count(), 0);
    assert!(tokio::time::timeout(Duration::from_secs(3), sweep(&port)).await.unwrap());
    keys.flush_deliveries();
    assert_eq!(world.count(HOST, "List"), 2);
    assert_eq!(*port.0.recovered.lock().unwrap(), vec![K]);
    assert_eq!(closes(&world), Vec::<String>::new());
    assert!(fence(&port).await.sessions.iter().any(|s| s.tab_id == K && s.pid == 100));
}
