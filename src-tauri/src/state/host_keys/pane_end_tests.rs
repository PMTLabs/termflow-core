use super::*;

#[test]
fn restaging_a_source_member_moves_its_holder_out_of_the_old_transfer() {
    let keys = HostKeys::default();
    let mut source = Page::new(&keys, "source");
    let mut destination = Page::new(&keys, "destination");
    let a = source.entry("tm-a", true);
    let b = source.entry("tm-b", true);
    assert_eq!(source.op(&keys, PaneOp::Enter { panes: vec![a.clone(), b.clone()] }), PaneResult::Ok);
    let control = register_shell(&keys, &mut destination, "tm-control", "pc-control");
    let now = Instant::now();
    assert_eq!(source.op_at(&keys, PaneOp::Stash { tx: "old".into(), pairs: vec![a.clone(), b] }, now).0, PaneResult::Ok);
    assert_eq!(source.op_at(&keys, PaneOp::Stash { tx: "new".into(), pairs: vec![a] }, now + Duration::from_secs(59)).0, PaneResult::Ok);
    assert_eq!(keys.lock().panes.transfers.len(), 2);
    assert_eq!(keys.lock().panes.transfers["old"].members.len(), 1);
    keys.expire_transfers(now + TRANSFER_DEADLINE);
    assert!(keys.owner_state("tm-b").is_none());
    assert_eq!(keys.pane_owner("tm-a"), Some(Owner::Transfer { tx: "new".into(), taken: false }));
    assert!(keys.is_restoring_key("legacy-tm-a", now + TRANSFER_DEADLINE));
    let PaneResult::Taken { payload } = destination.op_at(&keys, PaneOp::Take { tx: "new".into() }, now + TRANSFER_DEADLINE).0 else { panic!("take"); };
    assert_eq!(payload.panes.len(), 1);
    assert_eq!(payload.panes[0].leaf, "tm-a");
    assert!(payload.panes[0].restore);
    assert_eq!(keys.pane_owner("tm-control"), Some(Owner::Pane(control.pi)));
}

#[test]
fn held_close_and_depart_remove_only_the_named_processless_owner() {
    for depart in [false, true] {
        let keys = HostKeys::default();
        let mut source = Page::new(&keys, "source");
        let mut destination = Page::new(&keys, "destination");
        let a = source.enter(&keys, "tm-a");
        let b = source.enter(&keys, "tm-b");
        assert_eq!(source.op(&keys, PaneOp::Stash { tx: "held".into(), pairs: vec![a, b] }), PaneResult::Ok);
        assert!(matches!(destination.op(&keys, PaneOp::Take { tx: "held".into() }), PaneResult::Taken { .. }));
        let a = destination.entry("tm-a", false);
        let b = destination.entry("tm-b", false);
        assert_eq!(destination.op(&keys, PaneOp::Adopt { tx: "held".into(), pairs: vec![a.clone(), b.clone()] }), PaneResult::Ok);
        assert!(matches!(keys.owner_state("tm-a"), Some((0, OwnerState::Held))));
        assert!(matches!(keys.owner_state("tm-b"), Some((0, OwnerState::Held))));
        let op = if depart { PaneOp::Depart { pi: a.pi } } else { PaneOp::Close { pi: a.pi } };
        let (result, effects) = destination.op_at(&keys, op, Instant::now());
        assert_eq!(result, PaneResult::Ok);
        assert!(effects.closes.is_empty());
        assert!(keys.owner_state("tm-a").is_none());
        assert_eq!(keys.pane_owner("tm-b"), Some(Owner::Pane(b.pi)));
        assert!(matches!(keys.owner_state("tm-b"), Some((0, OwnerState::Held))));
    }
}

#[test]
fn cancelling_transfer_after_source_ends_orphans_live_and_removes_held() {
    for taken in [false, true] {
        let keys = HostKeys::default();
        let mut source = Page::new(&keys, "source");
        let mut destination = Page::new(&keys, "destination");
        let live = register_shell(&keys, &mut source, "tm-live", "pc-live");
        let waiting = source.enter(&keys, "tm-waiting");
        let control = register_shell(&keys, &mut destination, "tm-control", "pc-control");
        assert_eq!(source.op(&keys, PaneOp::Stash { tx: "cancel".into(), pairs: vec![live, waiting] }), PaneResult::Ok);
        if taken { assert!(matches!(destination.op(&keys, PaneOp::Take { tx: "cancel".into() }), PaneResult::Taken { .. })); }
        assert_eq!(keys.destroy_window("source", source.wi).len(), 1);
        assert_eq!(keys.pane_owner("tm-live"), Some(Owner::Transfer { tx: "cancel".into(), taken }));
        assert_eq!(destination.op(&keys, PaneOp::Cancel { tx: "cancel".into() }), PaneResult::Ok);
        assert_eq!(keys.pane_owner("tm-live"), Some(Owner::Orphaned));
        assert!(keys.owner_state("tm-waiting").is_none());
        assert_eq!(keys.pane_owner("tm-control"), Some(Owner::Pane(control.pi)));
        assert!(matches!(destination.op(&keys, PaneOp::Cancel { tx: "cancel".into() }), PaneResult::Rejected { .. }));
    }
}

#[test]
fn ending_page_removes_ordinary_holders_with_other_page_live_control() {
    let keys = HostKeys::default();
    let mut page = Page::new(&keys, "owner");
    let mut other = Page::new(&keys, "other");
    let waiting = page.entry("tm-waiting", true);
    let control = other.entry("tm-control", true);
    assert_eq!(page.op(&keys, PaneOp::Enter { panes: vec![waiting] }), PaneResult::Ok);
    assert_eq!(other.op(&keys, PaneOp::Enter { panes: vec![control] }), PaneResult::Ok);
    let now = Instant::now();
    assert!(keys.is_restoring_key("legacy-tm-waiting", now));
    assert!(keys.is_restoring_key("legacy-tm-control", now));
    assert_eq!(keys.destroy_window("owner", page.wi).len(), 1);
    assert!(!keys.is_restoring_key("legacy-tm-waiting", now));
    assert!(keys.is_restoring_key("legacy-tm-control", now));
    assert_eq!(other.op(&keys, PaneOp::Settle), PaneResult::Ok);
}

#[test]
fn binding_registered_shell_cannot_renew_ended_transfer_holder() {
    let keys = HostKeys::default();
    let mut source = Page::new(&keys, "source");
    let mut destination = Page::new(&keys, "destination");
    let entry = source.entry("tm-waiting", true);
    assert_eq!(source.op(&keys, PaneOp::Enter { panes: vec![entry.clone()] }), PaneResult::Ok);
    let cg = source.admit(&keys, entry.pi);
    keys.stage_shell("tm-waiting", cg, "pc-waiting", None).unwrap();
    let control = register_shell(&keys, &mut destination, "tm-control", "pc-control");
    assert_eq!(source.op(&keys, PaneOp::Stash { tx: "complete".into(), pairs: vec![entry] }), PaneResult::Ok);
    assert!(keys.is_restoring_key("legacy-tm-waiting", Instant::now()));
    keys.complete_shell("tm-waiting", cg, &StagedShell { process: "pc-waiting".into(), stage: ShellStage::Local });
    assert!(!keys.is_restoring_key("legacy-tm-waiting", Instant::now()));
    let PaneResult::Taken { payload } = destination.op(&keys, PaneOp::Take { tx: "complete".into() }) else { panic!("take"); };
    assert_eq!(payload.panes.len(), 1);
    assert!(!payload.panes[0].restore);
    let adopted = destination.entry("tm-waiting", true);
    assert_eq!(destination.op(&keys, PaneOp::Adopt { tx: "complete".into(), pairs: vec![adopted.clone()] }), PaneResult::Ok);
    assert!(!keys.is_restoring_key("legacy-tm-waiting", Instant::now()));
    assert_eq!(destination.op(&keys, PaneOp::Bind { pi: adopted.pi, pc: "pc-waiting".into(), via: BindVia::Named("transfer".into()) }), PaneResult::Ok);
    assert_eq!(keys.pane_owner("tm-control"), Some(Owner::Pane(control.pi)));
}
