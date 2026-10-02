use super::*;
use super::fake_hosts::*;
use super::owner_tests::{machine, until};
use crate::state::host_keys::panes::*;
use crate::state::{CreateAdmission, CreateMode, EndKind, CloseStorage, OwnerState, ShellStage, StagedShell};
use crate::state::host_routing::{place_owned, Placement};
use termflow_pty_protocol::SpawnSpec;
use std::collections::HashMap;

#[path = "pane_transfer_effect_tests.rs"]
mod transfer_tests;
#[path = "pane_lifecycle_effect_tests.rs"]
mod lifecycle_tests;

struct Page { label: &'static str, wi: u64, pg: u64, seq: u64, incarnation: u64 }
impl Page {
    fn new(port: &FakePort, label: &'static str) -> Self {
        let guard = port.table().keys().reserve_window(label).unwrap();
        let wi = guard.identity().1;
        guard.commit().unwrap();
        let crate::state::PageRegistration::Registered { pg, .. } = port.table().keys().register_page(label).unwrap() else { panic!("page"); };
        Self { label, wi, pg, seq: 0, incarnation: 0 }
    }
    fn send(&mut self, port: &FakePort, op: PaneOp) -> (PaneResult, PaneEffects) {
        self.seq += 1;
        let (reply, effects) = port.table().keys().pane_op(self.label, PaneRequest { pg: self.pg, seq: self.seq, op }).unwrap();
        let PaneReply::Ack { result } = reply else { panic!("ack"); };
        (result, effects)
    }
    fn enter(&mut self, port: &FakePort, leaf: &str) -> PaneEntry {
        self.incarnation += 1;
        let entry = PaneEntry { pi: PaneIdentity { pg: self.pg, seq: self.incarnation }, descriptor: PaneDescriptor { pane_id: format!("pane-{}-{}", self.pg, self.incarnation), leaf: leaf.into(), restore: false, override_key: None } };
        assert_eq!(self.send(port, PaneOp::Enter { panes: vec![entry.clone()] }).0, PaneResult::Ok);
        entry
    }
    fn admit(&mut self, port: &FakePort, entry: &PaneEntry) -> u64 {
        let PaneResult::Create { cg } = self.send(port, PaneOp::AdmitCreate { pi: entry.pi, mode: CreateMode::Mount }).0 else { panic!("admit"); };
        cg
    }
}
async fn run(port: &FakePort, label: &str, pg: u64, leaf: &str, cg: u64) -> Result<String, String> {
    match port.table().keys().admitted_work(label, pg, leaf, cg)? {
        CreateAdmission::Existing(pc) => Ok(pc),
        CreateAdmission::Join(waiter) => CreateAdmission::joined(waiter, crate::state::JOIN_DEADLINE).await,
        CreateAdmission::Run(actual) => {
            assert_eq!(actual, cg);
            let pc = port.0.ids.mint_process_id()?;
            let (channel, client, ticket, key) = match place_owned(port, leaf, None, Some((cg, &pc))).await? {
                Placement::Spawn { channel, client, ticket, session_key } => (channel, client, ticket, session_key),
                _ => panic!("fresh spawn"),
            };
            assert!(ticket.publish_key(&pc));
            let identity = port.table().keys().session_identity(channel, &key, &pc).unwrap();
            port.register_terminal(&pc, &key, channel);
            port.0.terminals.get_mut(&pc).unwrap().renderer_terminal_id = Some(leaf.into());
            assert_eq!(client.spawn_owned(&identity, &SpawnSpec { shell: "fake".into(), args: vec![], env: vec![], env_remove: vec![], cwd: None, cols: 80, rows: 24 }).await?, 4242);
            let shell = StagedShell { process: pc.clone(), stage: ShellStage::Hosted(ticket.key_stage().unwrap()) };
            crate::state::owner_lifecycle::finish_create(port.table().keys(), leaf, cg, &shell, |_| panic!("stale fixture"), |kind| { assert!(port.end_owner(&pc, kind)); });
            Ok(pc)
        }
    }
}
async fn create(port: &FakePort, page: &mut Page, leaf: &str) -> (PaneEntry, String) {
    let entry = page.enter(port, leaf);
    let cg = page.admit(port, &entry);
    let pc = run(port, page.label, page.pg, leaf, cg).await.unwrap();
    (entry, pc)
}
fn session(port: &FakePort, pc: &str) -> String { port.0.terminals.get(pc).unwrap().session_key.clone() }

#[tokio::test]
async fn admitted_spawn_reply_does_not_block_stream_and_join_uses_one_cg() {
    let gate = Arc::new(EventGate::default());
    let (world, port) = machine(HostSpec { reply_gates: HashMap::from([("Spawn", gate.clone())]), ..HostSpec::default() });
    let mut page = Page::new(&port, "owner");
    let entry = page.enter(&port, "tm-waiting");
    let cg = page.admit(&port, &entry);
    let first = tokio::spawn({ let port = port.clone(); let pg = page.pg; async move { run(&port, "owner", pg, "tm-waiting", cg).await } });
    gate.wait_reached(1).await;
    assert_eq!(world.count_everywhere("Spawn"), 1);
    let pc = port.table().keys().resolve_process("tm-waiting", true).unwrap();
    assert_eq!(page.send(&port, PaneOp::AdmitCreate { pi: entry.pi, mode: CreateMode::Mount }).0, PaneResult::Join { cg });
    let join = tokio::spawn({ let port = port.clone(); let pg = page.pg; async move { run(&port, "owner", pg, "tm-waiting", cg).await } });
    let control = page.enter(&port, "tm-control");
    let control_cg = page.admit(&port, &control);
    assert_ne!(control_cg, cg);
    assert_eq!(page.send(&port, PaneOp::Settle).0, PaneResult::Ok);
    assert!(!first.is_finished());
    assert!(!join.is_finished());
    let other = tokio::spawn({ let port = port.clone(); let pg = page.pg; async move { run(&port, "owner", pg, "tm-control", control_cg).await } });
    until(|| port.table().keys().resolve_process("tm-control", true).is_some()).await;
    gate.release();
    assert_eq!(first.await.unwrap().unwrap(), pc);
    assert_eq!(join.await.unwrap().unwrap(), pc);
    gate.wait_reached(2).await;
    gate.release();
    let control_pc = other.await.unwrap().unwrap();
    assert_ne!(control_pc, pc);
    assert_eq!(world.count_everywhere("Spawn"), 2);
    assert_eq!(port.table().keys().pane_owner("tm-waiting"), Some(Owner::Pane(entry.pi)));
}

#[tokio::test]
async fn close_reply_is_immediate_and_delayed_end_cannot_touch_replacement() {
    let (world, port) = machine(HostSpec::default());
    let mut page = Page::new(&port, "owner");
    let (entry, pc) = create(&port, &mut page, "tm-owned").await;
    let (_, control_pc) = create(&port, &mut page, "tm-control").await;
    let p_key = session(&port, &pc);
    let control_key = session(&port, &control_pc);
    assert_eq!(world.count_everywhere("Spawn"), 2);
    let (result, effects) = page.send(&port, PaneOp::Close { pi: entry.pi });
    assert_eq!(result, PaneResult::Ok);
    assert_eq!(effects.closes, vec![pc.clone()]);
    let gate = Arc::new(EventGate::default());
    let ending = tokio::spawn({ let port = port.clone(); let pc = effects.closes[0].clone(); let gate = gate.clone(); async move { gate.hold().await; port.end_owner(&pc, EndKind::Close(CloseStorage::Delete)) } });
    gate.wait_reached(1).await;
    let replacement = page.enter(&port, "tm-owned");
    assert_eq!(page.send(&port, PaneOp::AdmitCreate { pi: replacement.pi, mode: CreateMode::Mount }).0, PaneResult::Pending);
    assert!(matches!(port.table().keys().owner_state("tm-owned"), Some((_, OwnerState::Closing(s))) if s.process == pc));
    assert_eq!(world.count_everywhere("Close"), 0);
    gate.release();
    assert!(ending.await.unwrap());
    port.current_client().unwrap().list_sessions_numbered().await.unwrap();
    assert_eq!(world.sessions("owner-host", "Close"), vec![p_key.clone()]);
    assert_eq!(*port.0.deleted.lock().unwrap(), vec!["tm-owned"]);
    let cg = page.admit(&port, &replacement);
    let successor = run(&port, "owner", page.pg, "tm-owned", cg).await.unwrap();
    let q_key = session(&port, &successor);
    assert_ne!(successor, pc);
    assert_ne!(q_key, p_key);
    assert_eq!(world.count_everywhere("Spawn"), 3);
    let late = tokio::spawn({ let port = port.clone(); let pc = pc.clone(); let gate = gate.clone(); async move { gate.hold().await; port.end_owner(&pc, EndKind::Close(CloseStorage::Delete)) } });
    gate.wait_reached(2).await;
    assert_eq!(page.send(&port, PaneOp::Close { pi: entry.pi }).0, PaneResult::Contended);
    gate.release();
    assert!(!late.await.unwrap());
    let listing = port.current_client().unwrap().list_sessions_numbered().await.unwrap();
    assert_eq!(world.sessions("owner-host", "Close"), vec![p_key]);
    assert!(listing.sessions.iter().any(|s| s.tab_id == q_key && s.alive));
    assert!(listing.sessions.iter().any(|s| s.tab_id == control_key && s.alive));
    assert_eq!(*port.0.deleted.lock().unwrap(), vec!["tm-owned"]);
}

#[tokio::test]
async fn page_end_during_gated_spawn_orphans_completion_without_closing_shell() {
    let gate = Arc::new(EventGate::default());
    let (world, port) = machine(HostSpec { reply_gates: HashMap::from([("Spawn", gate.clone())]), ..HostSpec::default() });
    let mut page = Page::new(&port, "owner");
    let entry = page.enter(&port, "tm-waiting");
    let cg = page.admit(&port, &entry);
    let task = tokio::spawn({ let port = port.clone(); let pg = page.pg; async move { run(&port, "owner", pg, "tm-waiting", cg).await } });
    gate.wait_reached(1).await;
    let mut other = Page::new(&port, "other");
    let control = other.enter(&port, "tm-control");
    other.admit(&port, &control);
    assert_eq!(port.table().keys().destroy_window("owner", page.wi).len(), 1);
    assert_eq!(port.table().keys().pane_owner("tm-waiting"), Some(Owner::Orphaned));
    assert_eq!(port.table().keys().pane_owner("tm-control"), Some(Owner::Pane(control.pi)));
    assert_eq!(world.count_everywhere("Spawn"), 1);
    let new = other.enter(&port, "tm-waiting");
    assert_eq!(other.send(&port, PaneOp::AdmitCreate { pi: new.pi, mode: CreateMode::Mount }).0, PaneResult::Contended);
    gate.release();
    let pc = task.await.unwrap().unwrap();
    assert!(matches!(port.table().keys().owner_state("tm-waiting"), Some((_, OwnerState::Registered(s))) if s.process == pc));
    assert_eq!(port.table().keys().pane_owner("tm-waiting"), Some(Owner::Orphaned));
    assert_eq!(other.send(&port, PaneOp::Bind { pi: new.pi, pc: pc.clone(), via: BindVia::Named("reconcile".into()) }).0, PaneResult::Ok);
    port.current_client().unwrap().list_sessions_numbered().await.unwrap();
    assert_eq!(world.count_everywhere("Spawn"), 1);
    assert_eq!(world.count_everywhere("Close"), 0);
    assert_eq!(port.table().keys().pane_owner("tm-waiting"), Some(Owner::Pane(new.pi)));
}

#[tokio::test]
async fn delayed_original_window_end_cannot_orphan_reused_label_successor() {
    let (world, port) = machine(HostSpec::default());
    let mut original = Page::new(&port, "owner");
    let (_, old_pc) = create(&port, &mut original, "tm-old").await;
    let gate = Arc::new(EventGate::default());
    let ending = tokio::spawn({ let port = port.clone(); let wi = original.wi; let gate = gate.clone(); async move { gate.hold().await; port.table().keys().destroy_window("owner", wi) } });
    gate.wait_reached(1).await;
    let mut successor = Page::new(&port, "owner");
    let (entry, new_pc) = create(&port, &mut successor, "tm-successor").await;
    let mut control = Page::new(&port, "other");
    let (control_entry, control_pc) = create(&port, &mut control, "tm-control").await;
    assert_eq!(world.count_everywhere("Spawn"), 3);
    gate.release();
    assert_eq!(ending.await.unwrap().len(), 1);
    assert_eq!(port.table().keys().pane_owner("tm-old"), Some(Owner::Orphaned));
    assert_eq!(port.table().keys().pane_owner("tm-successor"), Some(Owner::Pane(entry.pi)));
    assert_eq!(port.table().keys().pane_owner("tm-control"), Some(Owner::Pane(control_entry.pi)));
    assert_eq!(successor.send(&port, PaneOp::Settle).0, PaneResult::Ok);
    port.current_client().unwrap().list_sessions_numbered().await.unwrap();
    assert_eq!(world.count_everywhere("Close"), 0);
    for pc in [old_pc, new_pc, control_pc] { assert!(port.table().keys().resolve_process(&pc, false).is_some()); }
}

#[tokio::test]
async fn close_cancels_admitted_unstarted_and_gated_placements_but_not_control() {
    for started in [false, true] {
        let gate = Arc::new(EventGate::default());
        let (world, port) = machine(HostSpec { reply_gates: HashMap::from([("Spawn", gate.clone())]), ..HostSpec::default() });
        let mut page = Page::new(&port, "owner");
        let entry = page.enter(&port, "tm-cancel");
        let cg = page.admit(&port, &entry);
        let mut task = None;
        if started {
            task = Some(tokio::spawn({ let port = port.clone(); let pg = page.pg; async move { run(&port, "owner", pg, "tm-cancel", cg).await } }));
            gate.wait_reached(1).await;
        }
        assert_eq!(page.send(&port, PaneOp::Close { pi: entry.pi }).0, PaneResult::Ok);
        if started {
            assert!(matches!(port.table().keys().owner_state("tm-cancel"), Some((_, OwnerState::Placing { cancel: Some(CloseStorage::Delete), .. }))));
        } else {
            assert!(port.table().keys().owner_state("tm-cancel").is_none());
        }
        let control = page.enter(&port, "tm-control");
        page.admit(&port, &control);
        assert_eq!(port.table().keys().pane_owner("tm-control"), Some(Owner::Pane(control.pi)));
        if !started {
            assert!(run(&port, "owner", page.pg, "tm-cancel", cg).await.unwrap_err().starts_with("host-ownership-pending:"));
            assert_eq!(world.count_everywhere("Spawn"), 0);
            assert_eq!(world.count_everywhere("Close"), 0);
            assert!(port.0.deleted.lock().unwrap().is_empty());
            continue;
        }
        assert_eq!(world.count_everywhere("Spawn"), 1);
        gate.release();
        let pc = task.unwrap().await.unwrap().unwrap();
        port.current_client().unwrap().list_sessions_numbered().await.unwrap();
        assert_eq!(world.count_everywhere("Close"), 1);
        assert_eq!(*port.0.deleted.lock().unwrap(), vec!["tm-cancel"]);
        assert!(port.table().keys().owner_state("tm-cancel").is_none());
        assert!(port.table().keys().resolve_process(&pc, false).is_none());
        assert_eq!(port.table().keys().pane_owner("tm-control"), Some(Owner::Pane(control.pi)));
    }
}
