use super::*;

fn reload(port: &FakePort, previous: &Page) -> Page {
    let crate::state::PageRegistration::Registered { wi, pg } = port.table().keys().register_page(previous.label).unwrap() else { panic!("reload page"); };
    assert_eq!(wi, previous.wi);
    Page { label: previous.label, wi, pg, seq: 0, incarnation: 0 }
}

#[tokio::test]
async fn settling_after_restore_alternates_contention_and_binding() {
    let (world, port) = machine(HostSpec::default());
    let mut page = Page::new(&port, "owner");
    let (_, pc) = create(&port, &mut page, "tm-owned").await;
    let mut other = Page::new(&port, "other");
    let (control, control_pc) = create(&port, &mut other, "tm-control").await;
    assert_eq!(world.count_everywhere("Spawn"), 2);
    for generation in 2..=5 {
        page = reload(&port, &page);
        let entry = page.enter(&port, "tm-owned");
        let expected = if generation % 2 == 0 { PaneResult::Contended } else { PaneResult::Existing { pc: pc.clone() } };
        assert_eq!(page.send(&port, PaneOp::AdmitCreate { pi: entry.pi, mode: CreateMode::Mount }).0, expected);
        assert_eq!(page.send(&port, PaneOp::Settle).0, PaneResult::Ok);
        let owner = if generation % 2 == 0 { Owner::Orphaned } else { Owner::Pane(entry.pi) };
        assert_eq!(port.table().keys().pane_owner("tm-owned"), Some(owner));
        assert_eq!(port.table().keys().pane_owner("tm-control"), Some(Owner::Pane(control.pi)));
    }
    let listing = port.current_client().unwrap().list_sessions_numbered().await.unwrap();
    for process in [&pc, &control_pc] {
        assert!(listing.sessions.iter().any(|s| s.tab_id == session(&port, process) && s.alive));
    }
    assert_eq!(world.count_everywhere("Spawn"), 2);
    assert_eq!(world.count_everywhere("Close"), 0);
}

#[tokio::test]
async fn replacing_page_before_restore_rebinds_every_generation_without_releasing_sweep() {
    let (world, port) = machine(HostSpec::default());
    let mut page = Page::new(&port, "owner");
    let (_, first_pc) = create(&port, &mut page, "tm-first").await;
    let (_, second_pc) = create(&port, &mut page, "tm-second").await;
    let mut other = Page::new(&port, "other");
    let (control, control_pc) = create(&port, &mut other, "tm-control").await;
    let keys = port.table().keys();
    keys.begin_restore_participation(["owner".into(), "other".into()]);
    assert_eq!(world.count_everywhere("Spawn"), 3);
    for _ in 0..4 {
        let old_pg = page.pg;
        page = reload(&port, &page);
        // Use the native JSON command at the same FIFO head as bootstrap.
        let op: PaneOp = serde_json::from_value(serde_json::json!({ "kind": "replace_page" })).unwrap();
        let (result, effects) = page.send(&port, op);
        assert_eq!(result, PaneResult::Ok);
        assert!(!effects.release_restore_sweep);
        assert!(effects.closes.is_empty());
        assert_eq!(keys.restore_pending_count(), 2);
        assert!(keys.pane_op(page.label, PaneRequest { pg: old_pg, seq: 99, op: PaneOp::Settle }).is_err());
        for (leaf, pc) in [("tm-first", &first_pc), ("tm-second", &second_pc)] {
            assert_eq!(keys.pane_owner(leaf), Some(Owner::Orphaned));
            let entry = page.enter(&port, leaf);
            assert_eq!(page.send(&port, PaneOp::AdmitCreate { pi: entry.pi, mode: CreateMode::Mount }).0, PaneResult::Existing { pc: pc.clone() });
            assert_eq!(keys.pane_owner(leaf), Some(Owner::Pane(entry.pi)));
            assert_eq!(page.send(&port, PaneOp::AdmitCreate { pi: entry.pi, mode: CreateMode::Mount }).0, PaneResult::AlreadyBound { pc: pc.clone() });
            assert_eq!(page.send(&port, PaneOp::Bind { pi: entry.pi, pc: pc.clone(), via: BindVia::Named("reconcile".into()) }).0, PaneResult::Ok);
        }
        assert_eq!(keys.pane_owner("tm-control"), Some(Owner::Pane(control.pi)));
    }
    let (_, effects) = page.send(&port, PaneOp::Settle);
    assert!(effects.release_restore_sweep);
    assert_eq!(keys.restore_pending_count(), 1);
    let listing = port.current_client().unwrap().list_sessions_numbered().await.unwrap();
    assert_eq!(listing.sessions.len(), 3);
    for process in [&first_pc, &second_pc, &control_pc] {
        assert!(listing.sessions.iter().any(|s| s.tab_id == session(&port, process) && s.alive));
    }
    assert_eq!(world.count_everywhere("Spawn"), 3);
    assert_eq!(world.count_everywhere("Attach"), 0);
    assert_eq!(world.count_everywhere("Close"), 0);
}

#[tokio::test]
async fn destroyed_window_preserves_orphaned_shells_and_other_window_ownership() {
    let (world, port) = machine(HostSpec::default());
    let mut page = Page::new(&port, "owner");
    let (_, pc) = create(&port, &mut page, "tm-owned").await;
    let (parked, parked_pc) = create(&port, &mut page, "tm-parked").await;
    assert_eq!(page.send(&port, PaneOp::Depart { pi: parked.pi }).0, PaneResult::Ok);
    let mut other = Page::new(&port, "other");
    let (control, control_pc) = create(&port, &mut other, "tm-control").await;
    assert_eq!(world.count_everywhere("Spawn"), 3);
    let keys = port.table().keys();
    assert_eq!(keys.destroy_window(page.label, page.wi), vec![crate::state::PageIdentity { wi: page.wi, pg: page.pg }]);
    for leaf in ["tm-owned", "tm-parked"] { assert_eq!(keys.pane_owner(leaf), Some(Owner::Orphaned)); }
    assert_eq!(keys.pane_owner("tm-control"), Some(Owner::Pane(control.pi)));
    let listing = port.current_client().unwrap().list_sessions_numbered().await.unwrap();
    for process in [&pc, &parked_pc, &control_pc] {
        assert!(listing.sessions.iter().any(|s| s.tab_id == session(&port, process) && s.alive));
    }
    assert_eq!(world.count_everywhere("Close"), 0);
    let restored = other.enter(&port, "tm-owned");
    assert_eq!(other.send(&port, PaneOp::Bind { pi: restored.pi, pc: pc.clone(), via: BindVia::Named("restore".into()) }).0, PaneResult::Ok);
    assert_eq!(keys.pane_owner("tm-owned"), Some(Owner::Pane(restored.pi)));
    assert_eq!(world.count_everywhere("Spawn"), 3);
}

#[tokio::test]
async fn reload_during_a_started_create_joins_the_same_work() {
    let gate = Arc::new(EventGate::default());
    let (world, port) = machine(HostSpec { reply_gates: HashMap::from([("Spawn", gate.clone())]), ..HostSpec::default() });
    let mut page = Page::new(&port, "owner");
    let entry = page.enter(&port, "tm-waiting");
    let cg = page.admit(&port, &entry);
    let first = tokio::spawn({ let port = port.clone(); let pg = page.pg; async move { run(&port, "owner", pg, "tm-waiting", cg).await } });
    gate.wait_reached(1).await;
    let mut other = Page::new(&port, "other");
    let control = other.enter(&port, "tm-control");
    other.admit(&port, &control);
    page = reload(&port, &page);
    let op: PaneOp = serde_json::from_value(serde_json::json!({ "kind": "replace_page" })).unwrap();
    assert_eq!(page.send(&port, op).0, PaneResult::Ok);
    assert_eq!(port.table().keys().pane_owner("tm-waiting"), Some(Owner::Orphaned));
    let successor = page.enter(&port, "tm-waiting");
    assert_eq!(page.send(&port, PaneOp::AdmitCreate { pi: successor.pi, mode: CreateMode::Mount }).0, PaneResult::Join { cg });
    assert_eq!(port.table().keys().pane_owner("tm-waiting"), Some(Owner::Pane(successor.pi)));
    assert_eq!(port.table().keys().pane_owner("tm-control"), Some(Owner::Pane(control.pi)));
    let joined = tokio::spawn({ let port = port.clone(); let pg = page.pg; async move { run(&port, "owner", pg, "tm-waiting", cg).await } });
    gate.release();
    let pc = first.await.unwrap().unwrap();
    assert_eq!(joined.await.unwrap().unwrap(), pc);
    assert!(matches!(port.table().keys().owner_state("tm-waiting"), Some((_, OwnerState::Registered(s))) if s.process == pc));
    assert_eq!(port.table().keys().pane_owner("tm-waiting"), Some(Owner::Pane(successor.pi)));
    assert_eq!(page.send(&port, PaneOp::AdmitCreate { pi: successor.pi, mode: CreateMode::Mount }).0, PaneResult::AlreadyBound { pc: pc.clone() });
    port.current_client().unwrap().list_sessions_numbered().await.unwrap();
    assert_eq!(world.count_everywhere("Spawn"), 1);
    assert_eq!(world.count_everywhere("Close"), 0);
}
