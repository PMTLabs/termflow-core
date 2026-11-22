use super::*;
use std::sync::{Arc, mpsc};

#[test]
fn last_member_close_or_restash_ends_drag_and_observer_without_losing_carried_holder() {
    for restash in [false, true] {
        let keys = HostKeys::default();
        let mut source = Page::new(&keys, "source");
        let mut destination = Page::new(&keys, "destination");
        let a = source.entry("tm-a", true);
        let b = source.entry("tm-b", true);
        assert_eq!(source.op(&keys, PaneOp::Enter { panes: vec![a.clone(), b.clone()] }), PaneResult::Ok);
        let control = register_shell(&keys, &mut destination, "tm-control", "pc-control");
        assert_eq!(source.op(&keys, PaneOp::Stash { tx: "old".into(), pairs: vec![a.clone()], ui: Some(serde_json::json!("old")) }), PaneResult::Ok);
        let observer = keys.watch_transfer(source.label, source.pg, "old").unwrap();
        keys.begin_pane_drag(source.label, source.pg, "old", |_| {}, |_| {}).unwrap();
        assert_eq!(keys.lock().panes.active_drag.as_deref(), Some("old"));
        assert_eq!(*observer.borrow(), None);
        let op = if restash { PaneOp::Stash { tx: "new".into(), pairs: vec![a], ui: Some(serde_json::json!("new")) } }
            else { PaneOp::Close { pi: a.pi } };
        assert_eq!(source.op(&keys, op), PaneResult::Ok);
        assert_eq!(*observer.borrow(), Some(false));
        assert!(!keys.lock().panes.transfers.contains_key("old"));
        assert!(keys.lock().panes.active_drag.is_none());
        if restash { assert!(keys.is_restoring_key("legacy-tm-a", Instant::now())); }
        else {
            assert!(!keys.is_restoring_key("legacy-tm-a", Instant::now()));
            assert_eq!(source.op(&keys, PaneOp::Stash { tx: "new".into(), pairs: vec![b], ui: Some(serde_json::json!("new")) }), PaneResult::Ok);
        }
        keys.begin_pane_drag(source.label, source.pg, "new", |_| {}, |_| {}).unwrap();
        assert_eq!(keys.claim_pane_drag(destination.label, destination.pg, "new", |_, _| {}).unwrap(), Some(serde_json::json!("new")));
        assert_eq!(keys.pane_owner("tm-control"), Some(Owner::Pane(control.pi)));
    }
}

#[test]
fn partial_member_removal_keeps_drag_and_empty_stash_is_rejected() {
    let keys = HostKeys::default();
    let mut source = Page::new(&keys, "source");
    let mut destination = Page::new(&keys, "destination");
    let a = source.enter(&keys, "tm-a");
    let b = source.enter(&keys, "tm-b");
    assert!(matches!(source.op(&keys, PaneOp::Stash { tx: "empty".into(), pairs: vec![], ui: None }), PaneResult::Rejected { .. }));
    assert_eq!(source.op(&keys, PaneOp::Stash { tx: "pair".into(), pairs: vec![a.clone(), b.clone()], ui: Some(serde_json::json!("pair")) }), PaneResult::Ok);
    let observer = keys.watch_transfer(source.label, source.pg, "pair").unwrap();
    keys.begin_pane_drag(source.label, source.pg, "pair", |_| {}, |_| {}).unwrap();
    assert_eq!(source.op(&keys, PaneOp::Close { pi: a.pi }), PaneResult::Ok);
    assert_eq!(keys.lock().panes.transfers["pair"].members.len(), 1);
    assert_eq!(keys.lock().panes.transfers["pair"].members[0].pi, b.pi);
    assert_eq!(*observer.borrow(), None);
    assert_eq!(keys.lock().panes.active_drag.as_deref(), Some("pair"));
    assert_eq!(keys.claim_pane_drag(destination.label, destination.pg, "pair", |_, _| {}).unwrap(), Some(serde_json::json!("pair")));
    assert!(matches!(destination.op(&keys, PaneOp::Take { tx: "pair".into() }), PaneResult::Taken { .. }));
    assert_eq!(*observer.borrow(), Some(true));
}

#[test]
fn first_use_delivery_initialization_does_not_hold_page_authority() {
    for operation in ["begin", "claim", "end", "route"] {
        let keys = HostKeys::default();
        let mut source = Page::new(&keys, "source");
        let mut target = Page::new(&keys, "target");
        let a = source.enter(&keys, "tm-a");
        assert_eq!(source.op(&keys, PaneOp::Stash { tx: "drag".into(), pairs: vec![a], ui: Some(serde_json::json!("drag")) }), PaneResult::Ok);
        // Claim/end start with a real active transfer but no worker yet.
        if operation == "claim" || operation == "end" {
            let (delivery, _receiver) = mpsc::channel();
            keys.lock().panes.active_drag = Some(ActiveDrag { token: "drag".into(), delivery, ended: Box::new(|| {}) });
        }
        let (reached, at_gate) = mpsc::channel();
        let (release, gate) = mpsc::channel();
        let gate = std::sync::Mutex::new(gate);
        *keys.delivery_init_hook.lock().unwrap() = Some(Arc::new(move || {
            reached.send(()).unwrap();
            gate.lock().unwrap().recv_timeout(Duration::from_secs(3)).unwrap();
        }));
        let worker = std::thread::spawn({ let keys = keys.clone(); let source_pg = source.pg; let target_pg = target.pg; move || {
            match operation {
                "begin" => keys.begin_pane_drag("source", source_pg, "drag", |_| {}, |_| {}).unwrap(),
                "claim" => assert!(keys.claim_pane_drag("target", target_pg, "drag", |_, _| {}).unwrap().is_some()),
                "end" => assert!(keys.end_pane_drag("source", source_pg, "drag", false, |_| {}).unwrap()),
                _ => assert!(keys.route_pane_transfer("source", source_pg, "drag", "target", |_| {}).unwrap()),
            }
        }});
        at_gate.recv_timeout(Duration::from_secs(3)).unwrap();
        let target_pg = target.pg;
        let (progress, progressed) = mpsc::channel();
        let page_op = std::thread::spawn({ let keys = keys.clone(); move || {
            let entry = target.enter(&keys, "tm-progress");
            progress.send((entry.pi, keys.pane_owner("tm-a"))).unwrap();
        }});
        let (pi, owner) = progressed.recv_timeout(Duration::from_secs(2)).expect("page op progresses during worker initialization");
        assert_eq!(pi.pg, target_pg);
        assert_eq!(owner, Some(Owner::Transfer { tx: "drag".into(), taken: false }));
        release.send(()).unwrap();
        worker.join().unwrap(); page_op.join().unwrap();
        keys.flush_deliveries();
    }
}

#[test]
fn stale_settle_or_destroy_cannot_retire_successor_restore_participation() {
    let keys = HostKeys::default();
    let mut old = Page::new(&keys, "owner");
    let mut control = Page::new(&keys, "control");
    keys.begin_restore_participation(["owner".into(), "control".into()]);
    let newer = Page::register(&keys, old.label, old.wi);
    assert_eq!(keys.restore_pending_count(), 2);
    let (_, effects) = old.op_at(&keys, PaneOp::Settle, Instant::now());
    assert!(!effects.release_restore_sweep);
    assert_eq!(keys.restore_pending_count(), 2);
    let mut replacement = Page::new(&keys, "owner");
    keys.begin_restore_participation(["owner".into(), "control".into()]);
    assert!(keys.pane_op(old.label, PaneRequest { pg: newer.pg, seq: 1, op: PaneOp::Settle }).is_err());
    assert_eq!(keys.destroy_window(old.label, old.wi).len(), 2);
    assert_eq!(keys.restore_pending_count(), 2);
    assert!(replacement.op_at(&keys, PaneOp::Settle, Instant::now()).1.release_restore_sweep);
    assert_eq!(keys.restore_pending_count(), 1);
    assert_eq!(control.op(&keys, PaneOp::Settle), PaneResult::Ok);
    assert_eq!(keys.restore_pending_count(), 0);
}
