use super::*;
use std::sync::mpsc;

#[test]
fn ui_payload_and_taken_observer_do_not_decide_ownership_or_renew_a_duplicate_token() {
    let keys = HostKeys::default();
    let mut source = Page::new(&keys, "source");
    let mut destination = Page::new(&keys, "destination");
    let entry = register_shell(&keys, &mut source, "tm-live", "pc-live");
    let control = register_shell(&keys, &mut destination, "tm-control", "pc-control");
    let ui = serde_json::json!({ "processId": "pc-control", "paneTree": { "terminalId": "tm-control" }, "scrollback": "carried", "zoom": 1.4 });
    assert_eq!(source.op(&keys, PaneOp::Stash { tx: "token".into(), pairs: vec![entry.clone()], ui: Some(ui.clone()) }), PaneResult::Ok);
    let observer = keys.watch_transfer(source.label, source.pg, "token").unwrap();
    assert_eq!(*observer.borrow(), None);
    assert!(matches!(source.op(&keys, PaneOp::Stash { tx: "token".into(), pairs: vec![entry], ui: Some(serde_json::json!("replacement")) }), PaneResult::Rejected { .. }));
    let PaneResult::Taken { payload } = destination.op(&keys, PaneOp::Take { tx: "token".into() }) else { panic!("take"); };
    assert_eq!(payload.ui, Some(ui));
    assert_eq!(*observer.borrow(), Some(true));
    assert_eq!(payload.panes[0].leaf, "tm-live");
    let invalid = destination.entry("tm-control", false);
    assert!(matches!(destination.op(&keys, PaneOp::Adopt { tx: "token".into(), pairs: vec![invalid] }), PaneResult::Rejected { .. }));
    let adopted = destination.entry("tm-live", false);
    assert_eq!(destination.op(&keys, PaneOp::Adopt { tx: "token".into(), pairs: vec![adopted.clone()] }), PaneResult::Ok);
    assert_eq!(keys.pane_owner("tm-live"), Some(Owner::Pane(adopted.pi)));
    assert_eq!(keys.pane_owner("tm-control"), Some(Owner::Pane(control.pi)));
    assert_eq!(keys.resolve_process("tm-live", false).as_deref(), Some("pc-live"));
}

#[test]
fn untaken_expiry_notifies_failure_while_taken_expiry_preserves_the_positive_receipt() {
    for taken in [false, true] {
        let keys = HostKeys::default();
        let mut source = Page::new(&keys, "source");
        let mut destination = Page::new(&keys, "destination");
        let entry = register_shell(&keys, &mut source, "tm-live", "pc-live");
        let control = register_shell(&keys, &mut destination, "tm-control", "pc-control");
        let now = Instant::now();
        assert_eq!(source.op_at(&keys, PaneOp::Stash { tx: "expiry".into(), pairs: vec![entry], ui: Some(serde_json::json!({ "title": "kept" })) }, now).0, PaneResult::Ok);
        let observer = keys.watch_transfer(source.label, source.pg, "expiry").unwrap();
        assert_eq!(*observer.borrow(), None);
        if taken { assert!(matches!(destination.op_at(&keys, PaneOp::Take { tx: "expiry".into() }, now).0, PaneResult::Taken { .. })); }
        keys.expire_transfers(now + Duration::from_secs(59));
        assert_eq!(keys.pane_owner("tm-live"), Some(Owner::Transfer { tx: "expiry".into(), taken }));
        keys.expire_transfers(now + Duration::from_secs(60));
        assert_eq!(*observer.borrow(), Some(taken));
        assert_eq!(keys.pane_owner("tm-live"), Some(Owner::Orphaned));
        assert_eq!(keys.pane_owner("tm-control"), Some(Owner::Pane(control.pi)));
        assert_eq!(keys.resolve_process("tm-live", false).as_deref(), Some("pc-live"));
    }
}

#[test]
fn queued_drag_receipts_keep_original_pages_and_late_source_calls_cannot_route_successor_panes() {
    let keys = HostKeys::default();
    let mut source = Page::new(&keys, "source");
    let mut target = Page::new(&keys, "target");
    let entry = register_shell(&keys, &mut source, "tm-live", "pc-live");
    let control = register_shell(&keys, &mut target, "tm-control", "pc-control");
    assert_eq!(source.op(&keys, PaneOp::Stash { tx: "drag".into(), pairs: vec![entry], ui: Some(serde_json::json!({ "title": "live" })) }), PaneResult::Ok);
    let (reached, at_gate) = mpsc::channel();
    let (release, gate) = mpsc::channel();
    let (sent, receipts) = mpsc::channel();
    keys.begin_pane_drag(source.label, source.pg, "drag", move |notice| {
        reached.send(()).unwrap();
        gate.recv_timeout(Duration::from_secs(3)).unwrap();
        sent.send(notice).unwrap();
    }, |_| {}).unwrap();
    at_gate.recv_timeout(Duration::from_secs(3)).unwrap();
    let (sent, routed) = mpsc::channel();
    assert!(keys.route_pane_transfer(source.label, source.pg, "drag", target.label, move |notice| { sent.send(notice).unwrap(); }).unwrap());
    let old_pg = target.pg;
    let old_wi = target.wi;
    let mut successor = Page::new(&keys, "target");
    let replacement = register_shell(&keys, &mut successor, "tm-successor", "pc-successor");
    assert!(keys.claim_pane_drag("target", old_pg, "drag", |_, _| panic!("old target cannot claim")).is_err());
    release.send(()).unwrap();
    let begin = receipts.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(begin["pg"], source.pg);
    let route = routed.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(route["pg"], old_pg); assert_eq!(route["wi"], old_wi);
    assert_ne!(route["pg"], successor.pg);
    assert_eq!(keys.pane_owner("tm-control"), Some(Owner::Pane(control.pi)));
    assert_eq!(keys.pane_owner("tm-successor"), Some(Owner::Pane(replacement.pi)));
    let mut new_source = Page::new(&keys, "source");
    let new_control = register_shell(&keys, &mut new_source, "tm-new-source", "pc-new-source");
    assert!(keys.begin_pane_drag("source", source.pg, "drag", |_| panic!("old source cannot begin"), |_| panic!("old source cannot end")).is_err());
    assert!(keys.end_pane_drag("source", source.pg, "drag", false, |_| panic!("old source cannot cancel")).is_err());
    assert!(keys.route_pane_transfer("source", source.pg, "drag", "target", |_| panic!("old source cannot route")).is_err());
    let (sent, claimed) = mpsc::channel();
    assert_eq!(keys.claim_pane_drag("target", successor.pg, "drag", move |source, tx| { sent.send((source, tx)).unwrap(); }).unwrap(), Some(serde_json::json!({ "title": "live" })));
    let (source_notice, tx) = claimed.recv_timeout(Duration::from_secs(3)).unwrap();
    assert!(source_notice.is_none(), "a reused source label is not the original page");
    assert_eq!(tx, "drag");
    assert_eq!(keys.pane_owner("tm-new-source"), Some(Owner::Pane(new_control.pi)));
    assert_eq!(keys.pane_owner("tm-live"), Some(Owner::Transfer { tx: "drag".into(), taken: false }));
}
