use super::*;
use std::sync::mpsc;

#[test]
fn delayed_source_observer_consumes_adopted_receipt_once() {
    let keys = std::sync::Arc::new(HostKeys::default());
    let mut source = Page::new(&keys, "source");
    let mut destination = Page::new(&keys, "destination");
    let entry = register_shell(&keys, &mut source, "tm-live", "pc-live");
    let control = register_shell(&keys, &mut destination, "tm-control", "pc-control");
    assert_eq!(source.op(&keys, PaneOp::Stash { tx: "late".into(), pairs: vec![entry], ui: None }), PaneResult::Ok);
    let (ready, reached) = mpsc::channel();
    let (release, gate) = mpsc::channel();
    let observer_keys = keys.clone();
    let pg = source.pg;
    let observer = std::thread::spawn(move || {
        ready.send(()).unwrap();
        gate.recv_timeout(Duration::from_secs(3)).unwrap();
        observer_keys.watch_transfer("source", pg, "late")
    });
    reached.recv_timeout(Duration::from_secs(3)).unwrap();
    assert!(matches!(destination.op(&keys, PaneOp::Take { tx: "late".into() }), PaneResult::Taken { .. }));
    let adopted = destination.entry("tm-live", false);
    assert_eq!(destination.op(&keys, PaneOp::Adopt { tx: "late".into(), pairs: vec![adopted.clone()] }), PaneResult::Ok);
    assert_eq!(keys.pane_owner("tm-live"), Some(Owner::Pane(adopted.pi)));
    assert_eq!(keys.resolve_process("tm-live", false).as_deref(), Some("pc-live"));
    assert_eq!(keys.pane_owner("tm-control"), Some(Owner::Pane(control.pi)));
    assert!(keys.watch_transfer("destination", destination.pg, "late").is_err());
    assert_eq!(keys.lock().panes.transfer_outcomes.get("late"), Some(&(source.pg, true)));
    release.send(()).unwrap();
    assert_eq!(*observer.join().unwrap().unwrap().borrow(), Some(true));
    assert!(keys.watch_transfer("source", pg, "late").is_err());
    assert!(keys.watch_transfer("source", pg, "unknown").is_err());
}

#[test]
fn delayed_observer_receives_false_for_each_untaken_ending() {
    for ending in ["expiry", "cancel", "close"] {
        let keys = std::sync::Arc::new(HostKeys::default());
        let mut source = Page::new(&keys, "source");
        let mut destination = Page::new(&keys, "destination");
        let entry = register_shell(&keys, &mut source, "tm-live", "pc-live");
        let control = register_shell(&keys, &mut destination, "tm-control", "pc-control");
        let now = Instant::now();
        assert_eq!(source.op_at(&keys, PaneOp::Stash { tx: ending.into(), pairs: vec![entry.clone()], ui: None }, now).0, PaneResult::Ok);
        let (ready, reached) = mpsc::channel();
        let (release, gate) = mpsc::channel();
        let observer_keys = keys.clone();
        let pg = source.pg;
        let observer = std::thread::spawn(move || {
            ready.send(()).unwrap();
            gate.recv_timeout(Duration::from_secs(3)).unwrap();
            observer_keys.watch_transfer("source", pg, ending)
        });
        reached.recv_timeout(Duration::from_secs(3)).unwrap();
        assert_eq!(keys.pane_owner("tm-live"), Some(Owner::Transfer { tx: ending.into(), taken: false }));
        match ending {
            "expiry" => keys.expire_transfers(now + TRANSFER_DEADLINE),
            "cancel" => assert_eq!(source.op(&keys, PaneOp::Cancel { tx: ending.into() }), PaneResult::Ok),
            _ => {
                let (result, effects) = source.op_at(&keys, PaneOp::Close { pi: entry.pi }, now);
                assert_eq!(result, PaneResult::Ok);
                assert_eq!(effects.closes, vec!["pc-live"]);
            }
        }
        assert_eq!(keys.lock().panes.transfer_outcomes.get(ending), Some(&(source.pg, false)));
        assert_eq!(keys.pane_owner("tm-control"), Some(Owner::Pane(control.pi)));
        assert_eq!(keys.resolve_process("tm-control", false).as_deref(), Some("pc-control"));
        release.send(()).unwrap();
        assert_eq!(*observer.join().unwrap().unwrap().borrow(), Some(false));
        assert!(keys.watch_transfer("source", pg, ending).is_err());
    }
}

#[test]
fn live_receiver_needs_no_retention_and_source_end_removes_late_receipts() {
    let keys = HostKeys::default();
    let mut source = Page::new(&keys, "source");
    let mut destination = Page::new(&keys, "destination");
    let control = register_shell(&keys, &mut destination, "tm-control", "pc-control");
    for live in [true, false] {
        let entry = source.enter(&keys, if live { "tm-live" } else { "tm-late" });
        let tx = if live { "live" } else { "late" };
        assert_eq!(source.op(&keys, PaneOp::Stash { tx: tx.into(), pairs: vec![entry], ui: None }), PaneResult::Ok);
        let receiver = live.then(|| keys.watch_transfer("source", source.pg, tx).unwrap());
        assert_eq!(source.op(&keys, PaneOp::Cancel { tx: tx.into() }), PaneResult::Ok);
        assert_eq!(keys.lock().panes.transfer_outcomes.contains_key(tx), !live);
        if let Some(receiver) = receiver { assert_eq!(*receiver.borrow(), Some(false)); }
    }
    assert!(keys.watch_transfer("source", source.pg, "live").is_err());
    assert_eq!(keys.lock().panes.transfer_outcomes.len(), 1);
    let entry = source.enter(&keys, "tm-pending");
    let now = Instant::now();
    assert_eq!(source.op_at(&keys, PaneOp::Stash { tx: "pending".into(), pairs: vec![entry], ui: None }, now).0, PaneResult::Ok);
    assert_eq!(keys.lock().panes.transfers.len(), 1);
    assert_eq!(keys.destroy_window("source", source.wi).len(), 1);
    assert!(keys.lock().panes.transfer_outcomes.is_empty());
    assert!(keys.lock().panes.transfer_outcome_order.is_empty());
    assert!(keys.watch_transfer("source", source.pg, "late").is_err());
    keys.expire_transfers(now + TRANSFER_DEADLINE);
    assert!(keys.lock().panes.transfers.is_empty());
    assert!(keys.lock().panes.transfer_outcomes.is_empty(), "ending after source death must not recreate its receipt");
    assert!(keys.lock().panes.transfer_outcome_order.is_empty());
    assert_eq!(keys.pane_owner("tm-control"), Some(Owner::Pane(control.pi)));
}

#[test]
fn retained_receipts_evict_oldest_and_block_token_reuse_until_consumed() {
    let keys = HostKeys::default();
    let mut source = Page::new(&keys, "source");
    let control = register_shell(&keys, &mut source, "tm-control", "pc-control");
    for index in 0..=super::super::transfers::TRANSFER_OUTCOME_CAP {
        let tx = format!("token-{index}");
        let entry = source.enter(&keys, &format!("tm-{index}"));
        assert_eq!(source.op(&keys, PaneOp::Stash { tx: tx.clone(), pairs: vec![entry], ui: None }), PaneResult::Ok);
        assert_eq!(source.op(&keys, PaneOp::Cancel { tx }), PaneResult::Ok);
    }
    assert_eq!(keys.lock().panes.transfer_outcomes.len(), super::super::transfers::TRANSFER_OUTCOME_CAP);
    assert!(keys.watch_transfer("source", source.pg, "token-0").is_err());
    let entry = source.enter(&keys, "tm-reuse");
    assert!(matches!(source.op(&keys, PaneOp::Stash { tx: "token-1".into(), pairs: vec![entry.clone()], ui: None }), PaneResult::Rejected { .. }));
    assert_eq!(*keys.watch_transfer("source", source.pg, "token-1").unwrap().borrow(), Some(false));
    assert_eq!(source.op(&keys, PaneOp::Stash { tx: "token-1".into(), pairs: vec![entry], ui: None }), PaneResult::Ok);
    assert_eq!(keys.pane_owner("tm-control"), Some(Owner::Pane(control.pi)));
    assert_eq!(keys.resolve_process("tm-control", false).as_deref(), Some("pc-control"));
}
