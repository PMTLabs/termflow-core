use super::*;
use std::sync::{Arc, Mutex};

type Notices = Arc<Mutex<Vec<(String, String)>>>;
fn publish(keys: &HostKeys, page: &Page, tx: &str, notices: &Notices) {
    let active = notices.clone();
    let ended = notices.clone();
    let observer_keys = keys.clone();
    keys.begin_pane_drag(page.label, page.pg, tx, move |notice| {
        active.lock().unwrap().push(("active".into(), notice["token"].as_str().unwrap().into()));
    }, move |token| {
        // This query would deadlock if the observer ran under ownership.
        assert!(observer_keys.pane_owner("tm-control").is_some());
        ended.lock().unwrap().push(("ended".into(), token));
    }).unwrap();
    keys.flush_deliveries();
    assert_eq!(notices.lock().unwrap().last(), Some(&("active".into(), tx.into())));
}

#[test]
fn terminal_drag_paths_publish_exact_ended_notice_and_preserve_unrelated_active_token() {
    for ending in ["claim", "end", "close", "forced_close", "api_process", "api_leaf", "fleet", "shared_delete", "restash", "adopt", "cancel", "self_take", "staged_expiry", "taken_expiry", "destination_end", "source_end", "taken_source_end", "source_settle", "destination_settle"] {
        for unrelated_active in [false, true] {
            let keys = HostKeys::default();
            let mut source = Page::new(&keys, "source");
            let mut destination = Page::new(&keys, "destination");
            let mut control = Page::new(&keys, "control");
            let claimant = Page::new(&keys, "claimant");
            let a = register_shell(&keys, &mut source, "tm-a", "pc-a");
            let b = register_shell(&keys, &mut control, "tm-control", "pc-control");
            let now = Instant::now();
            assert_eq!(source.op_at(&keys, PaneOp::Stash { tx: "a".into(), pairs: vec![a.clone()], ui: Some(serde_json::json!("a-ui")) }, now).0, PaneResult::Ok);
            assert_eq!(control.op_at(&keys, PaneOp::Stash { tx: "b".into(), pairs: vec![b.clone()], ui: Some(serde_json::json!("b-ui")) }, now).0, PaneResult::Ok);
            let b_observer = keys.watch_transfer(control.label, control.pg, "b").unwrap();
            let notices = Notices::default();
            publish(&keys, &source, "a", &notices);
            if unrelated_active {
                assert!(keys.end_pane_drag(source.label, source.pg, "a", false, |_| {}).unwrap());
                keys.flush_deliveries();
                assert_eq!(notices.lock().unwrap().as_slice(), &[("active".into(), "a".into()), ("ended".into(), "a".into())]);
                publish(&keys, &control, "b", &notices);
            }
            if ["adopt", "taken_expiry", "destination_end", "taken_source_end", "destination_settle"].contains(&ending) {
                assert!(matches!(destination.op_at(&keys, PaneOp::Take { tx: "a".into() }, now).0, PaneResult::Taken { .. }));
            }
            match ending {
                "claim" => assert_eq!(keys.claim_pane_drag(destination.label, destination.pg, "a", |_, _| {}).unwrap(), (!unrelated_active).then(|| serde_json::json!("a-ui"))),
                "end" => assert_eq!(keys.end_pane_drag(source.label, source.pg, "a", false, |_| {}).unwrap(), !unrelated_active),
                "close" => assert_eq!(source.op(&keys, PaneOp::Close { pi: a.pi }), PaneResult::Ok),
                "forced_close" => assert_eq!(keys.close_process_reap("pc-a", false), (PaneResult::Ok, vec!["pc-a".into()])),
                "api_process" | "api_leaf" | "fleet" | "shared_delete" => {
                    let policy = if ending == "shared_delete" { CloseStorage::Delete } else { CloseStorage::Preserve };
                    let reference = if ending == "api_leaf" { "tm-a" } else { "pc-a" };
                    let target = crate::state::ingress::close_target(&keys, reference).unwrap();
                    assert_eq!(target, "pc-a");
                    assert!(crate::state::ingress::close(&keys, &target, policy, |pc| {
                        assert_eq!(pc, "pc-a");
                        assert!(keys.end_process(pc, EndKind::Close(policy), |leaf| assert_eq!(leaf, "tm-a")).is_some());
                    }));
                }
                "restash" => assert_eq!(source.op(&keys, PaneOp::Stash { tx: "restashed".into(), pairs: vec![a], ui: None }), PaneResult::Ok),
                "adopt" => {
                    let entered = destination.entry("tm-a", false);
                    assert_eq!(destination.op(&keys, PaneOp::Adopt { tx: "a".into(), pairs: vec![entered.clone()] }), PaneResult::Ok);
                    assert_eq!(keys.pane_owner("tm-a"), Some(Owner::Pane(entered.pi)));
                }
                "cancel" => assert_eq!(source.op(&keys, PaneOp::Cancel { tx: "a".into() }), PaneResult::Ok),
                "self_take" => assert_eq!(source.op(&keys, PaneOp::Take { tx: "a".into() }), PaneResult::Ok),
                "staged_expiry" | "taken_expiry" => {
                    // B is younger than A, so expiring A must not end B.
                    keys.lock().panes.transfers.get_mut("b").unwrap().stamp = now + Duration::from_secs(30);
                    keys.expire_transfers(now + TRANSFER_DEADLINE);
                }
                "destination_end" => { keys.destroy_window(destination.label, destination.wi); }
                "source_end" | "taken_source_end" => { keys.destroy_window(source.label, source.wi); }
                "source_settle" => {
                    let mut successor = Page::register(&keys, source.label, source.wi);
                    assert_eq!(successor.op(&keys, PaneOp::Settle), PaneResult::Ok);
                }
                "destination_settle" => {
                    let mut successor = Page::register(&keys, destination.label, destination.wi);
                    assert_eq!(successor.op(&keys, PaneOp::Settle), PaneResult::Ok);
                }
                _ => unreachable!(),
            }
            if ["source_end", "taken_source_end", "source_settle"].contains(&ending) {
                assert_eq!(keys.pane_owner("tm-a"), Some(Owner::Transfer { tx: "a".into(), taken: ending == "taken_source_end" }));
                assert_eq!(keys.lock().panes.transfers["a"].members[0].descriptor.leaf, "tm-a");
                assert_eq!(keys.resolve_process("tm-a", false).as_deref(), Some("pc-a"));
            }
            keys.flush_deliveries();
            let expected = if unrelated_active {
                vec![("active".into(), "a".into()), ("ended".into(), "a".into()), ("active".into(), "b".into())]
            } else { vec![("active".into(), "a".into()), ("ended".into(), "a".into())] };
            assert_eq!(*notices.lock().unwrap(), expected, "{ending}, unrelated={unrelated_active}");
            assert_eq!(keys.resolve_process("tm-control", false).as_deref(), Some("pc-control"));
            assert_eq!(*b_observer.borrow(), None);
            assert_eq!(keys.lock().panes.transfers["b"].members[0].pi, b.pi);
            if !unrelated_active { publish(&keys, &control, "b", &notices); }
            assert_eq!(keys.lock().panes.active_drag.as_deref(), Some("b"));
            assert_eq!(keys.claim_pane_drag(claimant.label, claimant.pg, "b", |_, _| {}).unwrap(), Some(serde_json::json!("b-ui")));
            keys.flush_deliveries();
            assert_eq!(notices.lock().unwrap().last(), Some(&("ended".into(), "b".into())));
        }
    }
}

#[test]
fn partial_close_or_restash_returns_survivors_and_invalid_adopt_leaves_them_retryable() {
    for restash in [false, true] {
        let keys = HostKeys::default();
        let mut source = Page::new(&keys, "source");
        let mut destination = Page::new(&keys, "destination");
        let a = register_shell(&keys, &mut source, "tm-a", "pc-a");
        let b = register_shell(&keys, &mut source, "tm-b", "pc-b");
        let control = register_shell(&keys, &mut destination, "tm-control", "pc-control");
        let ui = serde_json::json!({ "paneTree": { "type": "split", "children": [{ "terminalId": "tm-a" }, { "terminalId": "tm-b" }] }, "terminals": ["pc-a", "pc-b"] });
        assert_eq!(source.op(&keys, PaneOp::Stash { tx: "pair".into(), pairs: vec![a.clone(), b.clone()], ui: Some(ui.clone()) }), PaneResult::Ok);
        let op = if restash { PaneOp::Stash { tx: "other".into(), pairs: vec![a], ui: None } } else { PaneOp::Close { pi: a.pi } };
        assert_eq!(source.op(&keys, op), PaneResult::Ok);
        let PaneResult::Taken { payload } = destination.op(&keys, PaneOp::Take { tx: "pair".into() }) else { panic!("take"); };
        assert_eq!(payload.panes, vec![b.descriptor]);
        assert_eq!(payload.ui, Some(ui));
        let invalid = destination.entry("tm-a", false);
        let valid = destination.entry("tm-b", false);
        assert!(matches!(destination.op(&keys, PaneOp::Adopt { tx: "pair".into(), pairs: vec![invalid.clone(), valid.clone()] }), PaneResult::Rejected { .. }));
        assert!(!keys.lock().panes.present.contains_key(&invalid.pi));
        assert!(!keys.lock().panes.present.contains_key(&valid.pi));
        assert_eq!(keys.pane_owner("tm-b"), Some(Owner::Transfer { tx: "pair".into(), taken: true }));
        assert_eq!(destination.op(&keys, PaneOp::Adopt { tx: "pair".into(), pairs: vec![valid.clone()] }), PaneResult::Ok);
        assert_eq!(keys.pane_owner("tm-b"), Some(Owner::Pane(valid.pi)));
        assert_eq!(keys.resolve_process("tm-b", false).as_deref(), Some("pc-b"));
        assert_eq!(keys.pane_owner("tm-control"), Some(Owner::Pane(control.pi)));
    }
}
