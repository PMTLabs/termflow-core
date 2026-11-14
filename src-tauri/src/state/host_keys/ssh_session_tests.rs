//! Real ownership authority, with memory transports, not renderer mount counts.
use super::*;
use crate::ssh::{auth::BoxFuture, session::*, tests::*};
use std::{collections::HashMap, sync::Arc};
struct DynamicTargets;
impl TargetSource for DynamicTargets {
    fn resolve<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<SessionTarget, SessionError>> { Box::pin(async move { Ok(SessionTarget { hops: vec![hop(id, "alice")] }) }) }
}
fn fixture() -> Fixture {
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
    f.registry.configure(Dependencies { targets: Arc::new(DynamicTargets), streams: Arc::new(MemoryStreams(f.server.clone())), agents: Arc::new(NativeAgent), secrets: f.secrets.clone(), events: f.events.clone(), known_hosts: crate::ssh::known_hosts::KnownHosts { path: f.path.clone() }, home: f.path.parent().unwrap().into() }).unwrap(); f
}
fn open(f: &Fixture, keys: &HostKeys, leaf: &str, connection: &str) {
    let receipt = keys.ssh_owner_receipt(leaf).unwrap();
    f.registry.open_owned(leaf, connection, false, Some(receipt), || keys.ssh_owner_receipt(leaf) == Some(receipt)).unwrap();
}
fn reconcile(f: &Fixture, keys: &HostKeys) { f.registry.reconcile_owners(|leaf, expected| keys.ssh_owner_receipt(leaf).is_some_and(|current| expected == Some(current))); }
#[tokio::test]
async fn held_nonretiring_transitions_preserve_receipt_and_reconnect() {
    for transition in ["depart", "cancel", "self-take", "abort", "staged-exit", "reload-settle", "unstarted-depart", "partial-adopt"] {
        let keys = HostKeys::default();
        let mut page = Page::new(&keys, "held-round2");
        let a = page.enter(&keys, "tm-a");
        let receipt = keys.ssh_owner_receipt("tm-a").unwrap();
        let f = fixture(); open(&f, &keys, "tm-a", "c-a");
        wait_state(&f.registry, "tm-a", false, SessionState::NeedsSecret).await;
        match transition {
            "depart" | "unstarted-depart" => {
                if transition == "unstarted-depart" { assert_eq!(page.admit(&keys, a.pi), receipt); }
                page.op(&keys, PaneOp::Depart { pi: a.pi });
                reconcile(&f, &keys);
                assert!(f.registry.state("tm-a", false).is_ok(), "depart parked receipt");
                let next = page.enter(&keys, "tm-a");
                assert_eq!(page.admit(&keys, next.pi), receipt);
            }
            "partial-adopt" => {
                let b = page.enter(&keys, "tm-b");
                page.op(&keys, PaneOp::Stash { tx: "partial".into(), pairs: vec![a, b], ui: None });
                let mut target = Page::new(&keys, "partial-target");
                target.op(&keys, PaneOp::Take { tx: "partial".into() });
                let b = target.entry("tm-b", false);
                assert_eq!(target.op(&keys, PaneOp::Adopt { tx: "partial".into(), pairs: vec![b] }), PaneResult::Ok);
                reconcile(&f, &keys);
                assert!(f.registry.state("tm-a", false).is_ok(), "omitted member parked at source");
                let next = page.enter(&keys, "tm-a");
                assert_eq!(page.admit(&keys, next.pi), receipt);
            }
            "reload-settle" => {
                let mut reload = Page::register(&keys, page.label, page.wi);
                assert_eq!(reload.op(&keys, PaneOp::Settle), PaneResult::Ok);
                reconcile(&f, &keys);
                assert!(f.registry.state("tm-a", false).is_ok(), "reload parked receipt");
                let next = reload.enter(&keys, "tm-a");
                assert_eq!(reload.admit(&keys, next.pi), receipt);
            }
            "cancel" | "self-take" => {
                page.op(&keys, PaneOp::Stash { tx: "round2".into(), pairs: vec![a], ui: None });
                page.op(&keys, if transition == "cancel" { PaneOp::Cancel { tx: "round2".into() } } else { PaneOp::Take { tx: "round2".into() } });
                reconcile(&f, &keys);
                assert!(f.registry.state("tm-a", false).is_ok(), "cancel parked receipt");
                let next = page.enter(&keys, "tm-a");
                assert_eq!(page.admit(&keys, next.pi), receipt);
            }
            _ => {
                assert_eq!(page.admit(&keys, a.pi), receipt);
                keys.admitted_work(page.label, page.pg, "tm-a", receipt).unwrap();
                if transition == "abort" { keys.abort_create("tm-a", receipt); }
                else {
                    let shell = StagedShell { process: "pc-early".into(), stage: ShellStage::Local };
                    keys.stage_shell("tm-a", receipt, "pc-early", None).unwrap();
                    keys.note_exit("pc-early");
                    assert!(matches!(keys.complete_shell("tm-a", receipt, &shell), Completion::Exited));
                }
            }
        }
        assert_eq!(keys.ssh_owner_receipt("tm-a"), Some(receipt), "{transition}");
        reconcile(&f, &keys);
        assert!(f.registry.state("tm-a", false).is_ok(), "{transition}");
        assert!(crate::commands::ssh_session::reconnect_core(&keys, &f.registry, "tm-a").is_ok(), "{transition}");
        f.registry.shutdown().await;
    }
}
#[tokio::test]
async fn held_retiring_transitions_remove_session() {
    for transition in ["close", "window", "expiry", "backend-close"] {
        let keys = HostKeys::default(); let mut page = Page::new(&keys, "held-retire");
        let a = page.enter(&keys, "tm-a"); let f = fixture(); open(&f, &keys, "tm-a", "c-a");
        match transition {
            "close" => { page.op(&keys, PaneOp::Close { pi: a.pi }); }
            "backend-close" => { keys.close_process("tm-a", CloseStorage::Delete); }
            "window" => { keys.destroy_window(page.label, page.wi); }
            _ => {
                page.op(&keys, PaneOp::Stash { tx: "expire-ssh".into(), pairs: vec![a], ui: None });
                keys.expire_transfers(Instant::now() + Duration::from_secs(120));
            }
        }
        reconcile(&f, &keys);
        assert!(f.registry.state("tm-a", false).is_err(), "{transition}");
        f.registry.shutdown().await;
    }
}
#[tokio::test]
async fn held_transfer_receipt_survives_admit_and_reconcile() {
    let keys = HostKeys::default();
    let mut source = Page::new(&keys, "held-source"); let mut target = Page::new(&keys, "held-target");
    let a = source.entry("tm-a", true);
    source.op(&keys, PaneOp::Enter { panes: vec![a.clone()] });
    source.op(&keys, PaneOp::Stash { ui: None, tx: "held-ssh".into(), pairs: vec![a] });
    let receipt = keys.ssh_owner_receipt("tm-a").unwrap(); assert_ne!(receipt, 0);
    let f = fixture(); crate::commands::ssh_session::open_core(&keys, &f.registry, "tm-a", "c-a").unwrap();
    target.op(&keys, PaneOp::Take { tx: "held-ssh".into() });
    let a = target.entry("tm-a", false); target.op(&keys, PaneOp::Adopt { tx: "held-ssh".into(), pairs: vec![a.clone()] });
    assert_eq!(target.admit(&keys, a.pi), receipt);
    reconcile(&f, &keys);
    assert!(f.registry.state("tm-a", false).is_ok());
    f.registry.shutdown().await;
}
#[tokio::test]
async fn exact_owner_map_survives_split_swap_detach_and_reload() {
    let keys = HostKeys::default(); let mut source = Page::new(&keys, "ssh-source"); let mut destination = Page::new(&keys, "ssh-destination");
    let a = register_shell(&keys, &mut source, "tm-a", "pc-a"); let b = register_shell(&keys, &mut source, "tm-b", "pc-b");
    let f = fixture(); open(&f, &keys, "tm-a", "c-a"); open(&f, &keys, "tm-b", "c-b");
    wait_state(&f.registry, "tm-a", false, SessionState::NeedsSecret).await; wait_state(&f.registry, "tm-b", false, SessionState::NeedsSecret).await;
    let exact = HashMap::from([("tm-a".into(), ("c-a".into(), SessionState::NeedsSecret)), ("tm-b".into(), ("c-b".into(), SessionState::NeedsSecret))]);
    assert_eq!(f.registry.owner_map(), exact);
    for pi in [a.pi, b.pi] { assert_eq!(source.op(&keys, PaneOp::Depart { pi }), PaneResult::Ok); }
    reconcile(&f, &keys); assert_eq!(f.registry.owner_map(), exact);
    let b = source.enter(&keys, "tm-b"); let a = source.enter(&keys, "tm-a");
    for (pi, pc) in [(b.pi, "pc-b"), (a.pi, "pc-a")] { assert_eq!(source.op(&keys, PaneOp::Bind { pi, pc: pc.into(), via: BindVia::Named("reconcile".into()) }), PaneResult::Ok); }
    reconcile(&f, &keys); assert_eq!(f.registry.owner_map(), exact);
    assert_eq!(source.op(&keys, PaneOp::Stash { ui: None, tx: "ssh-move".into(), pairs: vec![a, b] }), PaneResult::Ok); reconcile(&f, &keys); assert_eq!(f.registry.owner_map(), exact);
    assert!(matches!(destination.op(&keys, PaneOp::Take { tx: "ssh-move".into() }), PaneResult::Taken { .. }));
    let a = destination.entry("tm-a", false); let b = destination.entry("tm-b", false);
    assert_eq!(destination.op(&keys, PaneOp::Adopt { tx: "ssh-move".into(), pairs: vec![a.clone(), b.clone()] }), PaneResult::Ok); reconcile(&f, &keys); assert_eq!(f.registry.owner_map(), exact);
    keys.destroy_window(source.label, source.wi); reconcile(&f, &keys); assert_eq!(f.registry.owner_map(), exact);
    for pi in [a.pi, b.pi] { assert_eq!(destination.op(&keys, PaneOp::Depart { pi }), PaneResult::Ok); }
    let mut reload = Page::register(&keys, destination.label, destination.wi);
    for (leaf, pc) in [("tm-a", "pc-a"), ("tm-b", "pc-b")] { let entry = reload.enter(&keys, leaf); assert_eq!(reload.op(&keys, PaneOp::AdmitCreate { pi: entry.pi, mode: CreateMode::Mount }), PaneResult::Existing { pc: pc.into() }); }
    assert_eq!(reload.op(&keys, PaneOp::Settle), PaneResult::Ok); reconcile(&f, &keys); assert_eq!(f.registry.owner_map(), exact);
    keys.destroy_window(reload.label, reload.wi); reconcile(&f, &keys); assert!(f.registry.owner_map().is_empty()); f.registry.shutdown().await;
}
#[tokio::test]
async fn close_without_process_carries_receipt_and_stale_close_preserves_successor() {
    let keys = HostKeys::default(); let mut page = Page::new(&keys, "ssh-waiting"); let a = page.enter(&keys, "tm-a"); page.admit(&keys, a.pi);
    let f = fixture(); open(&f, &keys, "tm-a", "c-a"); wait_state(&f.registry, "tm-a", false, SessionState::NeedsSecret).await;
    let (result, effects) = page.op_at(&keys, PaneOp::Close { pi: a.pi }, Instant::now()); assert_eq!(result, PaneResult::Ok); assert!(effects.closes.is_empty()); assert_eq!(effects.ssh_retired.len(), 1);
    let entry = page.enter(&keys, "tm-a"); page.admit(&keys, entry.pi); // a genuinely new placement
    open(&f, &keys, "tm-a", "c-b"); let successor = f.registry.state("tm-a", false).unwrap();
    for (leaf, receipt) in effects.ssh_retired { f.registry.retire_owner(&leaf, receipt); }
    assert_eq!(f.registry.state("tm-a", false).unwrap().generation, successor.generation); assert_eq!(f.registry.owner_map()["tm-a"].0, "c-b"); f.registry.shutdown().await;
}
