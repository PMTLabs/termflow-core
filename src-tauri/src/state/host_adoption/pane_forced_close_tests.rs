use super::*;
use crate::state::{CreateAdmission, CreateMode, EndKind, CloseStorage, OwnerState};
use crate::state::host_keys::panes::Owner;
use std::collections::HashMap;

#[tokio::test]
async fn forced_close_of_restoring_transfer_retires_holder_before_gated_attach_completion() {
    let gate = Arc::new(EventGate::default());
    let world = World::new();
    world.add_host(HOST, HostSpec { sessions: vec![meta(K, 100), meta("tm-a", 101), meta("tm-protected", 102), meta("tm-control", 103)], reply_gates: HashMap::from([("Attach", gate.clone())]), ..HostSpec::default() });
    let port = FakePort::new(&world, HOST);
    port.set_candidates(vec![candidate(HOST, HostRole::Current)]);
    ensure_hosts(&port).await.unwrap();
    let keys = port.table().keys();
    let now = Clock::now();
    let mut source = Page::new(&port, "source");
    let mut other = Page::new(&port, "other");
    let a = source.enter(&port, "tm-a", Some(K), now);
    let protected = other.enter(&port, "tm-holder", Some("tm-protected"), now);
    let control = other.enter(&port, "tm-live", None, now);
    other.register_local(&port, &control, now);
    assert_eq!(keys.resolve_process("tm-live", false).as_deref(), Some("pc-local"));
    let PaneResult::Create { cg } = source.op(&port, PaneOp::AdmitCreate { pi: a.pi, mode: CreateMode::Mount }, now) else { panic!("admission"); };
    assert!(matches!(keys.admitted_work(source.label, source.pg, "tm-a", cg).unwrap(), CreateAdmission::Run(actual) if actual == cg));
    let crate::state::host_routing::Placement::Attach { client, ticket, session_key, .. } =
        crate::state::host_routing::place_owned(&port, "tm-a", Some(K), Some((cg, "pc-closing"))).await.unwrap() else { panic!("attach"); };
    assert_eq!(session_key, K);
    assert!(ticket.publish_key("pc-closing"));
    port.register_terminal("pc-closing", K, CHANNEL);
    let identity = keys.session_identity(CHANNEL, K, "pc-closing").unwrap();
    let pending = tokio::spawn(async move { client.attach_owned(&identity, 0).await });
    gate.wait_reached(1).await;
    assert_eq!(world.sessions(HOST, "Attach"), vec![K]);
    assert_eq!(keys.state(CHANNEL, K), Some(KeyState::Held(cg)));
    assert_eq!(source.op(&port, PaneOp::Stash { tx: "waiting".into(), pairs: vec![a], ui: None }, now), PaneResult::Ok);
    assert_eq!(keys.holder_count(), 2);
    assert!(keys.is_restoring_key("tm-a", now));
    assert_eq!(keys.pane_owner("tm-a"), Some(Owner::Transfer { tx: "waiting".into(), taken: false }));
    assert_eq!(keys.close_process_reap("pc-closing", true), (PaneResult::Contended, vec![]));
    assert_eq!(keys.holder_count(), 2);
    assert_eq!(keys.close_process_reap("pc-closing", false), (PaneResult::Ok, vec![]));
    assert_eq!(keys.holder_count(), 1);
    assert!(!keys.is_restoring_key("tm-a", now));
    assert!(keys.is_restoring_key("tm-protected", now));
    assert!(matches!(keys.owner_state("tm-a"), Some((actual, OwnerState::Placing { cancel: Some(CloseStorage::Delete), .. })) if actual == cg));
    gate.release();
    assert_eq!(pending.await.unwrap().unwrap(), Some(true));
    let shell = StagedShell { process: "pc-closing".into(), stage: ShellStage::Hosted(ticket.key_stage().unwrap()) };
    crate::state::owner_lifecycle::finish_create(keys, "tm-a", cg, &shell, |_| panic!("original placement"), |kind| {
        assert_eq!(kind, EndKind::Close(CloseStorage::Delete));
        assert!(port.end_owner("pc-closing", kind));
    });
    assert_eq!(*port.0.deleted.lock().unwrap(), vec!["tm-a"]);
    assert!(keys.owner_state("tm-a").is_none());
    let alias = other.enter(&port, "tm-marker", Some("tm-a"), now);
    other.close(&port, alias.pi, now);
    let protected_alias = other.enter(&port, "tm-other-marker", Some("tm-protected"), now);
    other.close(&port, protected_alias.pi, now);
    close_control(&mut other, &port, now);
    listing(&port, now).await;
    let after = fence(&port).await;
    let mut actual_closes = closes(&world);
    actual_closes.sort();
    let mut expected_closes = vec![K.to_string(), "tm-a".into(), "tm-control".into()];
    expected_closes.sort();
    assert_eq!(actual_closes, expected_closes);
    assert!(!after.sessions.iter().any(|s| s.tab_id == K || s.tab_id == "tm-a" || s.tab_id == "tm-control"));
    assert!(after.sessions.iter().any(|s| s.tab_id == "tm-protected" && s.pid == 102));
    assert_eq!(keys.holder_count(), 1);
    assert!(keys.is_restoring_key("tm-protected", now));
    assert_eq!(keys.resolve_process("tm-live", false).as_deref(), Some("pc-local"));
    assert_eq!(keys.pane_owner("tm-live"), Some(Owner::Pane(control.pi)));
    // Keep the unrelated holder's source identity explicit in the oracle.
    assert_eq!(protected.pi.pg, other.pg);
}
