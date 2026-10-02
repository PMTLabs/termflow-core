use super::*;
use crate::state::{CreateAdmission, CreateMode, EndKind, CloseStorage, OwnerState};
use crate::state::host_keys::panes::Owner;
use std::collections::HashMap;

fn close_ingress(port: &FakePort, ingress: &str, pc: &str, leaf: &str) -> CloseStorage {
    let keys = port.table().keys();
    let policy = match ingress {
        "native" | "shared_delete" => CloseStorage::Delete,
        "api_process" | "api_leaf" | "fleet" | "shared_preserve" => CloseStorage::Preserve,
        _ => unreachable!(),
    };
    if ingress == "native" {
        let (result, effects) = keys.close_process_reap(pc, false);
        assert_eq!(result, PaneResult::Ok);
        for effect in effects {
            assert_eq!(effect, pc);
            assert!(port.end_owner(&effect, EndKind::Close(policy)));
        }
    } else {
        // API, fleet and the legacy native command share this production adapter.
        // The native wrapper wiring is pinned by the ingress source census.
        let reference = if ingress == "api_leaf" { leaf } else { pc };
        let target = crate::state::ingress::close_target(keys, reference).unwrap_or_else(|| reference.into());
        assert_eq!(target, pc);
        assert!(crate::state::ingress::close(keys, &target, policy, |effect| {
            assert_eq!(effect, pc);
            assert!(port.end_owner(effect, EndKind::Close(policy)));
        }));
    }
    policy
}
const INGRESSES: &[&str] = &["native", "api_process", "api_leaf", "fleet", "shared_preserve", "shared_delete"];

async fn spawning_machine() -> (Arc<World>, FakePort) {
    let world = World::new();
    world.add_host(HOST, HostSpec { track_spawns: true, ..HostSpec::default() });
    let port = FakePort::new(&world, HOST);
    port.set_candidates(vec![candidate(HOST, HostRole::Current)]);
    ensure_hosts(&port).await.unwrap();
    assert_eq!(world.count(HOST, "List"), 1);
    (world, port)
}

async fn registered_member(port: &FakePort, page: &mut Page, leaf: &str, now: Clock) -> (PaneEntry, String, String, u64) {
    let pc = super::super::owner_tests::create(port, leaf).await.unwrap();
    let key = port.0.terminals.get(&pc).unwrap().session_key.clone();
    let (cg, state) = port.table().keys().owner_state(leaf).unwrap();
    assert!(matches!(state, OwnerState::Registered(shell) if shell.process == pc));
    let entry = page.enter(port, leaf, Some(&key), now);
    assert_eq!(page.op(port, PaneOp::Bind { pi: entry.pi, pc: pc.clone(), via: crate::state::host_keys::panes::BindVia::Named("restore".into()) }, now), PaneResult::Ok);
    assert_eq!(port.table().keys().state(CHANNEL, &key), Some(KeyState::Bound(pc.clone())));
    (entry, pc, key, cg)
}

#[tokio::test]
async fn forced_close_of_restoring_transfer_retires_holder_before_gated_attach_completion() {
    for ingress in INGRESSES {
        for taken in [false, true] {
            restoring_transfer_close_case(ingress, taken).await;
        }
    }
}

async fn restoring_transfer_close_case(ingress: &str, taken: bool) {
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
    let mut destination = Page::new(&port, "destination");
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
    let observer = keys.watch_transfer(source.label, source.pg, "waiting").unwrap();
    assert_eq!(*observer.borrow(), None);
    if taken {
        let PaneResult::Taken { payload } = destination.op(&port, PaneOp::Take { tx: "waiting".into() }, now) else { panic!("take"); };
        assert_eq!(payload.panes.len(), 1);
        assert_eq!(payload.panes[0].leaf, "tm-a");
        assert!(payload.panes[0].restore);
        assert_eq!(*observer.borrow(), Some(true));
    }
    let policy = close_ingress(&port, ingress, "pc-closing", "tm-a");
    assert_eq!(*observer.borrow(), Some(taken));
    assert!(keys.watch_transfer(source.label, source.pg, "waiting").is_err());
    assert_eq!(keys.holder_count(), 1);
    assert!(!keys.is_restoring_key("tm-a", now));
    assert!(keys.is_restoring_key("tm-protected", now));
    assert!(matches!(keys.owner_state("tm-a"), Some((actual, OwnerState::Placing { cancel: Some(actual_policy), .. })) if actual == cg && actual_policy == policy));
    gate.release();
    assert_eq!(pending.await.unwrap().unwrap(), Some(true));
    let shell = StagedShell { process: "pc-closing".into(), stage: ShellStage::Hosted(ticket.key_stage().unwrap()) };
    crate::state::owner_lifecycle::finish_create(keys, "tm-a", cg, &shell, |_| panic!("original placement"), |kind| {
        assert_eq!(kind, EndKind::Close(policy));
        assert!(port.end_owner("pc-closing", kind));
    });
    let expected_deleted: Vec<String> = if policy == CloseStorage::Delete { vec!["tm-a".into()] } else { vec![] };
    assert_eq!(*port.0.deleted.lock().unwrap(), expected_deleted);
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

#[tokio::test]
async fn process_close_ingresses_remove_only_the_closed_transfer_member() {
    for ingress in INGRESSES {
        let (world, port) = spawning_machine().await;
        let keys = port.table().keys();
        let now = Clock::now();
        let mut source = Page::new(&port, "source");
        let mut destination = Page::new(&port, "destination");
        let (a, pc_a, key_a, cg_a) = registered_member(&port, &mut source, "tm-a", now).await;
        let (b, pc_b, key_b, cg_b) = registered_member(&port, &mut source, "tm-b", now).await;
        let (control, pc_control, key_control, cg_control) = registered_member(&port, &mut destination, "tm-live", now).await;
        assert_eq!(world.count(HOST, "Spawn"), 3);
        let ui = serde_json::json!({ "terminals": [pc_a, pc_b] });
        assert_eq!(source.op(&port, PaneOp::Stash { tx: "pair".into(), pairs: vec![a.clone(), b.clone()], ui: Some(ui.clone()) }, now), PaneResult::Ok);
        let observer = keys.watch_transfer(source.label, source.pg, "pair").unwrap();
        assert_eq!(*observer.borrow(), None);
        assert_eq!(keys.owner_state("tm-a").unwrap().0, cg_a);
        close_ingress(&port, ingress, &pc_a, "tm-a");
        let after = fence(&port).await;
        assert_eq!(closes(&world), vec![key_a.clone()]);
        assert!(keys.owner_state("tm-a").is_none());
        assert!(!after.sessions.iter().any(|s| s.tab_id == key_a));
        assert_eq!(*observer.borrow(), None, "surviving member keeps the observer pending");
        let PaneResult::Taken { payload } = destination.op(&port, PaneOp::Take { tx: "pair".into() }, now) else { panic!("take survivor"); };
        assert_eq!(payload.panes, vec![PaneDescriptor { restore: false, ..b.descriptor.clone() }]);
        assert_eq!(payload.ui, Some(ui));
        assert_eq!(*observer.borrow(), Some(true));
        destination.incarnation += 1;
        let adopted = PaneEntry { pi: PaneIdentity { pg: destination.pg, seq: destination.incarnation }, descriptor: b.descriptor.clone() };
        assert_eq!(destination.op(&port, PaneOp::Adopt { tx: "pair".into(), pairs: vec![adopted.clone()] }, now), PaneResult::Ok);
        assert_eq!(keys.pane_owner("tm-b"), Some(Owner::Pane(adopted.pi)));
        assert_eq!(keys.owner_state("tm-b").unwrap().0, cg_b);
        assert_eq!(keys.resolve_process("tm-b", false), Some(pc_b.clone()));
        assert_eq!(keys.state(CHANNEL, &key_b), Some(KeyState::Bound(pc_b)));
        assert!(after.sessions.iter().any(|s| s.tab_id == key_b && s.pid == 4242 && s.alive));
        assert_eq!(keys.pane_owner("tm-live"), Some(Owner::Pane(control.pi)));
        assert_eq!(keys.owner_state("tm-live").unwrap().0, cg_control);
        assert_eq!(keys.state(CHANNEL, &key_control), Some(KeyState::Bound(pc_control)));
        assert!(after.sessions.iter().any(|s| s.tab_id == key_control && s.pid == 4242 && s.alive));
    }
}

#[tokio::test]
async fn last_member_process_close_ends_advertisement_and_observer_once() {
    for ingress in INGRESSES {
        let (world, port) = spawning_machine().await;
        let keys = port.table().keys();
        let now = Clock::now();
        let mut source = Page::new(&port, "source");
        let mut control_page = Page::new(&port, "control");
        let (a, pc, key, cg) = registered_member(&port, &mut source, "tm-a", now).await;
        let (control, control_pc, control_key, control_cg) = registered_member(&port, &mut control_page, "tm-live", now).await;
        assert_eq!(world.count(HOST, "Spawn"), 2);
        assert_eq!(source.op(&port, PaneOp::Stash { tx: "last".into(), pairs: vec![a], ui: Some(serde_json::json!("last-ui")) }, now), PaneResult::Ok);
        assert_eq!(control_page.op(&port, PaneOp::Stash { tx: "control-tx".into(), pairs: vec![control], ui: Some(serde_json::json!("control-ui")) }, now), PaneResult::Ok);
        let observer = keys.watch_transfer(source.label, source.pg, "last").unwrap();
        let control_observer = keys.watch_transfer(control_page.label, control_page.pg, "control-tx").unwrap();
        let notices = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let active = notices.clone();
        let ended = notices.clone();
        let observer_keys = keys.clone();
        keys.begin_pane_drag(source.label, source.pg, "last", move |notice| {
            active.lock().unwrap().push(format!("active:{}", notice["token"].as_str().unwrap()));
        }, move |token| {
            assert!(observer_keys.owner_state("tm-live").is_some());
            ended.lock().unwrap().push(format!("ended:{token}"));
        }).unwrap();
        keys.flush_deliveries();
        assert_eq!(*notices.lock().unwrap(), vec!["active:last"]);
        assert_eq!(*observer.borrow(), None);
        assert_eq!(keys.owner_state("tm-a").unwrap().0, cg);
        let policy = close_ingress(&port, ingress, &pc, "tm-a");
        keys.flush_deliveries();
        assert_eq!(*notices.lock().unwrap(), vec!["active:last", "ended:last"]);
        assert_eq!(*observer.borrow(), Some(false));
        assert!(keys.watch_transfer(source.label, source.pg, "last").is_err());
        assert!(!keys.end_pane_drag(source.label, source.pg, "last", false, |_| panic!("duplicate notice")).unwrap());
        assert!(!crate::state::ingress::close(keys, &pc, policy, |_| panic!("duplicate close")));
        keys.flush_deliveries();
        let after = fence(&port).await;
        assert_eq!(*notices.lock().unwrap(), vec!["active:last", "ended:last"]);
        assert_eq!(closes(&world), vec![key.clone()]);
        assert!(!after.sessions.iter().any(|s| s.tab_id == key));
        assert_eq!(*control_observer.borrow(), None);
        assert_eq!(keys.pane_owner("tm-live"), Some(Owner::Transfer { tx: "control-tx".into(), taken: false }));
        assert_eq!(keys.owner_state("tm-live").unwrap().0, control_cg);
        assert_eq!(keys.state(CHANNEL, &control_key), Some(KeyState::Bound(control_pc)));
        assert!(after.sessions.iter().any(|s| s.tab_id == control_key && s.pid == 4242 && s.alive));
        keys.begin_pane_drag(control_page.label, control_page.pg, "control-tx", |_| {}, |_| {}).unwrap();
        assert_eq!(keys.claim_pane_drag(source.label, source.pg, "control-tx", |_, _| {}).unwrap(), Some(serde_json::json!("control-ui")));
    }
}
