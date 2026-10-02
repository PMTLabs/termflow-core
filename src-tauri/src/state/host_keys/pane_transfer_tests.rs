use super::*;

#[test]
fn stash_departed_source_keeps_authority_for_only_its_own_transfer_member() {
    let keys = HostKeys::default();
    let mut source = Page::new(&keys, "source");
    let mut destination = Page::new(&keys, "destination");
    let a = register_shell(&keys, &mut source, "tm-a", "pc-a");
    let b = register_shell(&keys, &mut source, "tm-b", "pc-b");
    let control = register_shell(&keys, &mut destination, "tm-control", "pc-control");
    assert_eq!(source.op(&keys, PaneOp::Depart { pi: a.pi }), PaneResult::Ok);
    assert_eq!(source.op(&keys, PaneOp::Stash { tx: "pair".into(), pairs: vec![a.clone(), b.clone()] }), PaneResult::Ok);
    assert_eq!(keys.pane_owner("tm-a"), Some(Owner::Transfer { tx: "pair".into(), taken: false }));
    assert_eq!(keys.pane_owner("tm-b"), Some(Owner::Transfer { tx: "pair".into(), taken: false }));
    assert!(matches!(source.op(&keys, PaneOp::Stash { tx: "pair".into(), pairs: vec![b.clone()] }), PaneResult::Rejected { .. }));
    let (result, effects) = source.op_at(&keys, PaneOp::Close { pi: a.pi }, Instant::now());
    assert_eq!(result, PaneResult::Ok);
    assert_eq!(effects.closes, vec!["pc-a"]);
    assert_eq!(keys.pane_owner("tm-b"), Some(Owner::Transfer { tx: "pair".into(), taken: false }));
    let PaneResult::Taken { payload } = destination.op(&keys, PaneOp::Take { tx: "pair".into() }) else { panic!("take"); };
    assert_eq!(payload.panes, vec![b.descriptor]);
    assert_eq!(source.op(&keys, PaneOp::Close { pi: b.pi }), PaneResult::Contended);
    assert_eq!(keys.pane_owner("tm-control"), Some(Owner::Pane(control.pi)));
    assert_eq!(keys.close_process_reap("pc-b", true), (PaneResult::Contended, vec![]));
}

#[test]
fn adopt_replay_enters_once_preserves_held_and_orphans_unnamed_shell() {
    let keys = HostKeys::default();
    let mut source = Page::new(&keys, "source");
    let mut destination = Page::new(&keys, "destination");
    let live = register_shell(&keys, &mut source, "tm-live", "pc-live");
    let waiting = source.entry("tm-waiting", true);
    assert_eq!(source.op(&keys, PaneOp::Enter { panes: vec![waiting.clone()] }), PaneResult::Ok);
    let control = register_shell(&keys, &mut destination, "tm-control", "pc-control");
    assert_eq!(source.op(&keys, PaneOp::Stash { tx: "move".into(), pairs: vec![live.clone(), waiting.clone()] }), PaneResult::Ok);
    assert!(matches!(keys.owner_state("tm-waiting"), Some((0, OwnerState::Held))));
    let source_copy = source.enter(&keys, "tm-waiting");
    assert_eq!(source.op(&keys, PaneOp::AdmitCreate { pi: source_copy.pi, mode: CreateMode::Mount }), PaneResult::Contended);
    let PaneResult::Taken { payload } = destination.op(&keys, PaneOp::Take { tx: "move".into() }) else { panic!("take"); };
    assert_eq!(payload.panes.len(), 2);
    assert!(payload.panes.iter().any(|p| p.leaf == "tm-waiting" && p.restore));
    assert_eq!(source.op(&keys, PaneOp::Adopt { tx: "move".into(), pairs: vec![] }), PaneResult::Contended);
    let adopted = destination.entry("tm-waiting", false);
    let request = PaneRequest { pg: destination.pg, seq: destination.seq + 1, op: PaneOp::Adopt { tx: "move".into(), pairs: vec![adopted.clone()] } };
    let (reply, effects) = keys.pane_op("destination", request.clone()).unwrap();
    assert_eq!(reply, PaneReply::Ack { result: PaneResult::Ok });
    assert!(effects.closes.is_empty());
    assert_eq!(keys.pane_owner("tm-waiting"), Some(Owner::Pane(adopted.pi)));
    assert_eq!(keys.pane_owner("tm-live"), Some(Owner::Orphaned));
    assert_eq!(keys.lock().panes.present.len(), 3); // control, delayed source copy, adopted copy
    for _ in 0..3 {
        assert_eq!(keys.pane_op("destination", request.clone()).unwrap().0, reply);
        assert_eq!(keys.lock().panes.present.len(), 3);
        assert_eq!(keys.pane_owner("tm-live"), Some(Owner::Orphaned));
    }
    destination.seq += 1;
    let cg = destination.admit(&keys, adopted.pi);
    assert!(matches!(keys.admitted_work("destination", destination.pg, "tm-waiting", cg).unwrap(), CreateAdmission::Run(actual) if actual == cg));
    assert_eq!(destination.op(&keys, PaneOp::AdmitCreate { pi: adopted.pi, mode: CreateMode::Mount }), PaneResult::Join { cg });
    assert_eq!(keys.pane_owner("tm-control"), Some(Owner::Pane(control.pi)));
}

#[test]
fn adopted_placing_copy_joins_original_admission_in_destination_page() {
    let keys = HostKeys::default();
    let mut source = Page::new(&keys, "source");
    let mut destination = Page::new(&keys, "destination");
    let entry = source.enter(&keys, "tm-waiting");
    let cg = source.admit(&keys, entry.pi);
    assert!(matches!(keys.admitted_work("source", source.pg, "tm-waiting", cg).unwrap(), CreateAdmission::Run(actual) if actual == cg));
    let control = register_shell(&keys, &mut destination, "tm-control", "pc-control");
    assert_eq!(source.op(&keys, PaneOp::Stash { tx: "placing".into(), pairs: vec![entry] }), PaneResult::Ok);
    assert!(matches!(destination.op(&keys, PaneOp::Take { tx: "placing".into() }), PaneResult::Taken { .. }));
    let entry = destination.entry("tm-waiting", false);
    assert_eq!(destination.op(&keys, PaneOp::Adopt { tx: "placing".into(), pairs: vec![entry.clone()] }), PaneResult::Ok);
    assert_eq!(destination.op(&keys, PaneOp::AdmitCreate { pi: entry.pi, mode: CreateMode::Mount }), PaneResult::Join { cg });
    assert!(matches!(keys.admitted_work("destination", destination.pg, "tm-waiting", cg).unwrap(), CreateAdmission::Join(_)));
    assert_eq!(keys.pane_owner("tm-control"), Some(Owner::Pane(control.pi)));
}

#[test]
fn transfer_timeouts_are_non_destructive_and_taken_resets_injected_deadline() {
    for taken in [false, true] {
        let keys = HostKeys::default();
        let mut source = Page::new(&keys, "source");
        let mut destination = Page::new(&keys, "destination");
        let live = register_shell(&keys, &mut source, "tm-live", "pc-live");
        let waiting = source.entry("tm-waiting", true);
        assert_eq!(source.op(&keys, PaneOp::Enter { panes: vec![waiting.clone()] }), PaneResult::Ok);
        let control = register_shell(&keys, &mut destination, "tm-control", "pc-control");
        let now = Instant::now();
        let (result, effects) = source.op_at(&keys, PaneOp::Stash { tx: "timeout".into(), pairs: vec![live, waiting] }, now);
        assert_eq!(result, PaneResult::Ok);
        assert!(effects.wake_transfers);
        let mut deadline = now + TRANSFER_DEADLINE;
        if taken {
            let (result, effects) = destination.op_at(&keys, PaneOp::Take { tx: "timeout".into() }, now + Duration::from_secs(59));
            assert!(matches!(result, PaneResult::Taken { .. }));
            assert!(effects.wake_transfers);
            keys.expire_transfers(deadline);
            assert_eq!(keys.pane_owner("tm-live"), Some(Owner::Transfer { tx: "timeout".into(), taken: true }));
            deadline += Duration::from_secs(59);
        }
        keys.expire_transfers(deadline - Duration::from_nanos(1));
        assert!(matches!(keys.owner_state("tm-waiting"), Some((0, OwnerState::Held))));
        assert!(keys.is_restoring_key("legacy-tm-waiting", deadline));
        keys.expire_transfers(deadline);
        assert_eq!(keys.pane_owner("tm-live"), Some(Owner::Orphaned));
        assert!(matches!(keys.owner_state("tm-live"), Some((_, OwnerState::Registered(s))) if s.process == "pc-live"));
        assert!(keys.owner_state("tm-waiting").is_none());
        assert!(!keys.is_restoring_key("legacy-tm-waiting", deadline));
        assert_eq!(keys.pane_owner("tm-control"), Some(Owner::Pane(control.pi)));
        assert!(matches!(destination.op(&keys, PaneOp::Take { tx: "timeout".into() }), PaneResult::Rejected { .. }));
    }
}

#[test]
fn source_end_preserves_transfer_until_destination_end_or_deadline() {
    for taken in [false, true] {
        let keys = HostKeys::default();
        let mut source = Page::new(&keys, "source");
        let mut destination = Page::new(&keys, "destination");
        let mut control_page = Page::new(&keys, "control");
        let live = register_shell(&keys, &mut source, "tm-live", "pc-live");
        let waiting = source.entry("tm-waiting", true);
        assert_eq!(source.op(&keys, PaneOp::Enter { panes: vec![waiting.clone()] }), PaneResult::Ok);
        let control = register_shell(&keys, &mut control_page, "tm-control", "pc-control");
        let now = Instant::now();
        assert_eq!(source.op_at(&keys, PaneOp::Stash { tx: "move".into(), pairs: vec![live, waiting] }, now).0, PaneResult::Ok);
        if taken { assert!(matches!(destination.op_at(&keys, PaneOp::Take { tx: "move".into() }, now).0, PaneResult::Taken { .. })); }
        assert_eq!(keys.destroy_window("source", source.wi).len(), 1);
        assert_eq!(keys.pane_owner("tm-live"), Some(Owner::Transfer { tx: "move".into(), taken }));
        assert!(keys.is_restoring_key("legacy-tm-waiting", now));
        if taken { assert_eq!(keys.destroy_window("destination", destination.wi).len(), 1); }
        else { keys.expire_transfers(now + TRANSFER_DEADLINE); }
        assert_eq!(keys.pane_owner("tm-live"), Some(Owner::Orphaned));
        assert!(keys.owner_state("tm-waiting").is_none());
        assert_eq!(keys.pane_owner("tm-control"), Some(Owner::Pane(control.pi)));
        assert!(!keys.is_restoring_key("legacy-tm-waiting", now));
    }
}

#[test]
fn cancel_and_source_self_take_park_live_shell_and_remove_held() {
    for taken in [false, true] {
        for self_take in [false, true] {
            let keys = HostKeys::default();
            let mut source = Page::new(&keys, "source");
            let mut destination = Page::new(&keys, "destination");
            let live = register_shell(&keys, &mut source, "tm-live", "pc-live");
            let waiting = source.enter(&keys, "tm-waiting");
            let control = register_shell(&keys, &mut destination, "tm-control", "pc-control");
            assert_eq!(source.op(&keys, PaneOp::Stash { tx: "rollback".into(), pairs: vec![live.clone(), waiting] }), PaneResult::Ok);
            if taken { assert!(matches!(destination.op(&keys, PaneOp::Take { tx: "rollback".into() }), PaneResult::Taken { .. })); }
            assert_eq!(source.op(&keys, PaneOp::Adopt { tx: "rollback".into(), pairs: vec![] }), PaneResult::Contended);
            let op = if self_take { PaneOp::Take { tx: "rollback".into() } } else { PaneOp::Cancel { tx: "rollback".into() } };
            assert_eq!(source.op(&keys, op), PaneResult::Ok);
            assert_eq!(keys.pane_owner("tm-live"), Some(Owner::Parked { pg: source.pg, by: live.pi }));
            assert!(keys.owner_state("tm-waiting").is_none());
            let rebound = source.enter(&keys, "tm-live");
            assert_eq!(source.op(&keys, PaneOp::Bind { pi: rebound.pi, pc: "pc-live".into(), via: BindVia::Named("transfer".into()) }), PaneResult::Ok);
            assert_eq!(keys.pane_owner("tm-control"), Some(Owner::Pane(control.pi)));
            assert!(matches!(destination.op(&keys, PaneOp::Take { tx: "rollback".into() }), PaneResult::Rejected { .. }));
        }
    }
}

#[test]
fn failed_transfer_batches_have_no_partial_ownership_or_membership_changes() {
    let keys = HostKeys::default();
    let mut source = Page::new(&keys, "source");
    let mut destination = Page::new(&keys, "destination");
    let live = register_shell(&keys, &mut source, "tm-live", "pc-live");
    let control = register_shell(&keys, &mut destination, "tm-control", "pc-control");
    let missing = source.entry("tm-missing", false);
    assert_eq!(source.op(&keys, PaneOp::Stash { tx: "bad".into(), pairs: vec![live.clone(), missing.clone()] }), PaneResult::Contended);
    assert_eq!(keys.pane_owner("tm-live"), Some(Owner::Pane(live.pi)));
    assert_eq!(source.op(&keys, PaneOp::AdmitCreate { pi: live.pi, mode: CreateMode::Mount }), PaneResult::AlreadyBound { pc: "pc-live".into() });
    assert_eq!(source.op(&keys, PaneOp::Stash { tx: "good".into(), pairs: vec![live] }), PaneResult::Ok);
    assert!(matches!(destination.op(&keys, PaneOp::Take { tx: "good".into() }), PaneResult::Taken { .. }));
    let wrong = destination.entry("tm-wrong", false);
    assert!(matches!(destination.op(&keys, PaneOp::Adopt { tx: "good".into(), pairs: vec![wrong.clone()] }), PaneResult::Rejected { .. }));
    assert!(!keys.lock().panes.present.contains_key(&wrong.pi));
    assert_eq!(keys.pane_owner("tm-live"), Some(Owner::Transfer { tx: "good".into(), taken: true }));
    assert_eq!(keys.pane_owner("tm-control"), Some(Owner::Pane(control.pi)));
}

#[test]
fn restoring_pane_holder_survives_clock_advance_and_stage_until_own_registration() {
    let keys = HostKeys::default();
    let mut page = Page::new(&keys, "owner");
    let mut control_page = Page::new(&keys, "control");
    let entry = page.entry("tm-waiting", true);
    let control = control_page.entry("tm-control", true);
    assert_eq!(page.op(&keys, PaneOp::Enter { panes: vec![entry.clone()] }), PaneResult::Ok);
    assert_eq!(control_page.op(&keys, PaneOp::Enter { panes: vec![control.clone()] }), PaneResult::Ok);
    let now = Instant::now();
    keys.reap_expired_restore_intents(now + Duration::from_secs(16 * 60));
    assert!(keys.is_restoring_key("legacy-tm-waiting", now + Duration::from_secs(16 * 60)));
    let cg = page.admit(&keys, entry.pi);
    keys.stage_shell("tm-waiting", cg, "pc-waiting", None).unwrap();
    assert!(keys.is_restoring_key("legacy-tm-waiting", now + Duration::from_secs(16 * 60)));
    assert!(matches!(keys.complete_shell("tm-waiting", cg, &StagedShell { process: "pc-waiting".into(), stage: ShellStage::Local }), Completion::Registered));
    assert!(!keys.is_restoring_key("legacy-tm-waiting", now));
    assert!(keys.is_restoring_key("legacy-tm-control", now));
    assert_eq!(page.op(&keys, PaneOp::Depart { pi: entry.pi }), PaneResult::Ok);
    let copy = page.entry("tm-waiting", true);
    assert_eq!(page.op(&keys, PaneOp::Enter { panes: vec![copy.clone()] }), PaneResult::Ok);
    assert!(!keys.is_restoring_key("legacy-tm-waiting", now));
    assert_eq!(page.op(&keys, PaneOp::Bind { pi: copy.pi, pc: "pc-waiting".into(), via: BindVia::Named("restore".into()) }), PaneResult::Ok);
    assert!(keys.is_restoring_key("legacy-tm-control", now));
}
