use super::*;
use crate::state::host_keys::PageRegistration;

#[path = "pane_transfer_tests.rs"]
mod transfer_tests;
#[path = "pane_end_tests.rs"]
mod end_tests;

struct Page { label: &'static str, wi: u64, pg: u64, seq: u64, incarnation: u64 }
impl Page {
    fn new(keys: &HostKeys, label: &'static str) -> Self {
        let guard = keys.reserve_window(label).unwrap();
        let wi = guard.identity().1;
        guard.commit().unwrap();
        Self::register(keys, label, wi)
    }
    fn register(keys: &HostKeys, label: &'static str, wi: u64) -> Self {
        let PageRegistration::Registered { wi: actual, pg } = keys.register_page(label).unwrap() else { panic!("page registration"); };
        assert_eq!(wi, actual);
        Self { label, wi, pg, seq: 0, incarnation: 0 }
    }
    fn entry(&mut self, leaf: &str, restore: bool) -> PaneEntry {
        self.incarnation += 1;
        PaneEntry { pi: PaneIdentity { pg: self.pg, seq: self.incarnation }, descriptor: PaneDescriptor { pane_id: format!("pane-{}-{}", self.pg, self.incarnation), leaf: leaf.into(), restore, override_key: restore.then(|| format!("legacy-{leaf}")) } }
    }
    fn op_at(&mut self, keys: &HostKeys, op: PaneOp, now: Instant) -> (PaneResult, PaneEffects) {
        self.seq += 1;
        let (reply, effects) = keys.pane_op_at(self.label, PaneRequest { pg: self.pg, seq: self.seq, op }, now).unwrap();
        let PaneReply::Ack { result } = reply else { panic!("expected immediate ack"); };
        (result, effects)
    }
    fn op(&mut self, keys: &HostKeys, op: PaneOp) -> PaneResult { self.op_at(keys, op, Instant::now()).0 }
    fn enter(&mut self, keys: &HostKeys, leaf: &str) -> PaneEntry {
        let entry = self.entry(leaf, false);
        assert_eq!(self.op(keys, PaneOp::Enter { panes: vec![entry.clone()] }), PaneResult::Ok);
        entry
    }
    fn admit(&mut self, keys: &HostKeys, pi: PaneIdentity) -> u64 {
        let PaneResult::Create { cg } = self.op(keys, PaneOp::AdmitCreate { pi, mode: CreateMode::Mount }) else { panic!("create"); };
        cg
    }
}
fn register_shell(keys: &HostKeys, page: &mut Page, leaf: &str, pc: &str) -> PaneEntry {
    let entry = page.enter(keys, leaf);
    let cg = page.admit(keys, entry.pi);
    assert!(matches!(keys.admitted_work(page.label, page.pg, leaf, cg).unwrap(), CreateAdmission::Run(actual) if actual == cg));
    keys.stage_shell(leaf, cg, pc, None).unwrap();
    assert!(matches!(keys.complete_shell(leaf, cg, &StagedShell { process: pc.into(), stage: ShellStage::Local }), Completion::Registered));
    entry
}

#[test]
fn same_copy_mount_reuses_while_other_copy_and_restart_contend() {
    let keys = HostKeys::default();
    let mut owner = Page::new(&keys, "owner");
    let mut other = Page::new(&keys, "other");
    let owned = register_shell(&keys, &mut owner, "tm-owned", "pc-owned");
    let control = register_shell(&keys, &mut other, "tm-control", "pc-control");
    let copy = other.enter(&keys, "tm-owned");
    assert_eq!(owner.op(&keys, PaneOp::AdmitCreate { pi: owned.pi, mode: CreateMode::Mount }), PaneResult::AlreadyBound { pc: "pc-owned".into() });
    assert_eq!(owner.op(&keys, PaneOp::AdmitCreate { pi: owned.pi, mode: CreateMode::Restart }), PaneResult::Contended);
    assert_eq!(other.op(&keys, PaneOp::AdmitCreate { pi: copy.pi, mode: CreateMode::Mount }), PaneResult::Contended);
    assert_eq!(other.op(&keys, PaneOp::Bind { pi: copy.pi, pc: "pc-owned".into(), via: BindVia::Named("reconcile".into()) }), PaneResult::Contended);
    assert_eq!(other.op(&keys, PaneOp::Close { pi: copy.pi }), PaneResult::Contended);
    assert_eq!(keys.pane_owner("tm-owned"), Some(Owner::Pane(owned.pi)));
    assert_eq!(keys.pane_owner("tm-control"), Some(Owner::Pane(control.pi)));
    assert_eq!(owner.op(&keys, PaneOp::Bind { pi: owned.pi, pc: "pc-owned".into(), via: BindVia::Named("reconcile".into()) }), PaneResult::Ok);
}

#[test]
fn departed_copy_can_close_but_cannot_admit_bind_or_depart_again() {
    let keys = HostKeys::default();
    let mut page = Page::new(&keys, "owner");
    let owned = register_shell(&keys, &mut page, "tm-owned", "pc-owned");
    let control = register_shell(&keys, &mut page, "tm-control", "pc-control");
    assert_eq!(page.op(&keys, PaneOp::Depart { pi: owned.pi }), PaneResult::Ok);
    assert_eq!(keys.pane_owner("tm-owned"), Some(Owner::Parked { pg: page.pg, by: owned.pi }));
    for op in [PaneOp::Depart { pi: owned.pi }, PaneOp::AdmitCreate { pi: owned.pi, mode: CreateMode::Mount }, PaneOp::Bind { pi: owned.pi, pc: "pc-owned".into(), via: BindVia::Named("restore".into()) }] {
        assert!(matches!(page.op(&keys, op), PaneResult::Rejected { .. }));
    }
    let (result, effects) = page.op_at(&keys, PaneOp::Close { pi: owned.pi }, Instant::now());
    assert_eq!(result, PaneResult::Ok);
    assert_eq!(effects.closes, vec!["pc-owned"]);
    assert!(matches!(keys.owner_state("tm-owned"), Some((_, OwnerState::Closing(s))) if s.process == "pc-owned"));
    let copy = page.enter(&keys, "tm-owned");
    assert_eq!(page.op(&keys, PaneOp::AdmitCreate { pi: copy.pi, mode: CreateMode::Mount }), PaneResult::Pending);
    assert_eq!(keys.pane_owner("tm-control"), Some(Owner::Pane(control.pi)));
    assert_eq!(page.op(&keys, PaneOp::Close { pi: owned.pi }), PaneResult::Ok);
}

#[test]
fn parked_bind_requires_same_window_and_orphan_bind_requires_recovery_via() {
    let keys = HostKeys::default();
    let mut old = Page::new(&keys, "owner");
    let mut other = Page::new(&keys, "other");
    let owned = register_shell(&keys, &mut old, "tm-owned", "pc-owned");
    let control = register_shell(&keys, &mut other, "tm-control", "pc-control");
    assert_eq!(old.op(&keys, PaneOp::Depart { pi: owned.pi }), PaneResult::Ok);
    let foreign = other.enter(&keys, "tm-owned");
    assert_eq!(other.op(&keys, PaneOp::Bind { pi: foreign.pi, pc: "pc-owned".into(), via: BindVia::Named("reconcile".into()) }), PaneResult::Contended);
    let mut successor = Page::register(&keys, "owner", old.wi);
    let replacement = successor.enter(&keys, "tm-owned");
    assert_eq!(successor.op(&keys, PaneOp::AdmitCreate { pi: replacement.pi, mode: CreateMode::Mount }), PaneResult::Existing { pc: "pc-owned".into() });
    assert_eq!(successor.op(&keys, PaneOp::Depart { pi: replacement.pi }), PaneResult::Ok);
    assert_eq!(keys.destroy_window("owner", old.wi).len(), 2);
    assert_eq!(keys.pane_owner("tm-owned"), Some(Owner::Orphaned));
    assert_eq!(other.op(&keys, PaneOp::Bind { pi: foreign.pi, pc: "pc-owned".into(), via: BindVia::Named("transfer".into()) }), PaneResult::Contended);
    assert_eq!(other.op(&keys, PaneOp::Bind { pi: foreign.pi, pc: "pc-wrong".into(), via: BindVia::Named("restore".into()) }), PaneResult::Contended);
    assert_eq!(other.op(&keys, PaneOp::Bind { pi: foreign.pi, pc: "pc-owned".into(), via: BindVia::Named("restore".into()) }), PaneResult::Ok);
    assert_eq!(keys.pane_owner("tm-owned"), Some(Owner::Pane(foreign.pi)));
    assert_eq!(keys.pane_owner("tm-control"), Some(Owner::Pane(control.pi)));
}

#[test]
fn headless_shell_binds_to_present_copy_and_reap_never_closes_pane_owner() {
    let keys = HostKeys::default();
    let mut page = Page::new(&keys, "owner");
    let control = register_shell(&keys, &mut page, "tm-control", "pc-control");
    let CreateAdmission::Run(cg) = keys.admit_create("tm-headless", CreateMode::Mount).unwrap() else { panic!("headless admission"); };
    keys.stage_shell("tm-headless", cg, "pc-headless", None).unwrap();
    keys.complete_shell("tm-headless", cg, &StagedShell { process: "pc-headless".into(), stage: ShellStage::Local });
    assert_eq!(keys.pane_owner("tm-headless"), Some(Owner::Headless));
    let entry = page.enter(&keys, "tm-headless");
    assert_eq!(page.op(&keys, PaneOp::Bind { pi: entry.pi, pc: "pc-headless".into(), via: BindVia::Named("reconcile".into()) }), PaneResult::Ok);
    assert_eq!(keys.close_process_reap("pc-headless", true), (PaneResult::Contended, vec![]));
    assert_eq!(keys.close_process_reap("pc-control", true), (PaneResult::Contended, vec![]));
    assert_eq!(page.op(&keys, PaneOp::Depart { pi: entry.pi }), PaneResult::Ok);
    assert_eq!(keys.close_process_reap("pc-headless", true), (PaneResult::Ok, vec!["pc-headless".into()]));
    assert_eq!(keys.pane_owner("tm-control"), Some(Owner::Pane(control.pi)));
    assert_eq!(keys.close_process_reap("pc-unknown", true), (PaneResult::Ok, vec![]));
    assert_eq!(keys.close_process_reap("pc-control", false), (PaneResult::Ok, vec!["pc-control".into()]));
}

#[test]
fn sequence_retry_replays_last_admission_once_and_foreign_sender_cannot_spend_it() {
    let keys = HostKeys::default();
    let mut owner = Page::new(&keys, "owner");
    let mut other = Page::new(&keys, "other");
    let owned = owner.enter(&keys, "tm-owned");
    let control = register_shell(&keys, &mut other, "tm-control", "pc-control");
    let request = PaneRequest { pg: owner.pg, seq: 2, op: PaneOp::AdmitCreate { pi: owned.pi, mode: CreateMode::Mount } };
    assert!(keys.pane_op("other", request.clone()).unwrap_err().contains("calling window"));
    let (reply, effects) = keys.pane_op("owner", request.clone()).unwrap();
    let PaneReply::Ack { result: PaneResult::Create { cg } } = reply.clone() else { panic!("admission"); };
    assert!(effects.closes.is_empty());
    assert_eq!(keys.owner_state("tm-owned").unwrap().0, cg);
    for _ in 0..3 {
        let (replayed, effects) = keys.pane_op("owner", request.clone()).unwrap();
        assert_eq!(replayed, reply);
        assert!(effects.closes.is_empty());
        assert_eq!(keys.owner_state("tm-owned").unwrap().0, cg);
    }
    assert_eq!(keys.pane_op("owner", PaneRequest { seq: 1, ..request.clone() }).unwrap().0, PaneReply::Resync { next_seq: 3 });
    assert_eq!(keys.pane_op("owner", PaneRequest { seq: 99, ..request }).unwrap().0, PaneReply::Resync { next_seq: 3 });
    owner.seq = 2;
    assert_eq!(owner.op(&keys, PaneOp::AdmitCreate { pi: owned.pi, mode: CreateMode::Mount }), PaneResult::Join { cg });
    assert!(keys.admitted_work("other", owner.pg, "tm-owned", cg).is_err());
    assert!(keys.admitted_work("owner", owner.pg, "tm-owned", cg + 1).is_err());
    assert!(keys.admitted_work("owner", owner.pg, "tm-other", cg).is_err());
    assert!(matches!(keys.admitted_work("owner", owner.pg, "tm-owned", cg).unwrap(), CreateAdmission::Run(actual) if actual == cg));
    assert!(matches!(keys.admitted_work("owner", owner.pg, "tm-owned", cg).unwrap(), CreateAdmission::Join(_)));
    assert_eq!(keys.pane_owner("tm-control"), Some(Owner::Pane(control.pi)));
}

#[tokio::test(start_paused = true)]
async fn admitted_join_deadline_retries_without_starting_second_placement() {
    let keys = HostKeys::default();
    let mut page = Page::new(&keys, "owner");
    register_shell(&keys, &mut page, "tm-control", "pc-control");
    let entry = page.enter(&keys, "tm-waiting");
    let cg = page.admit(&keys, entry.pi);
    assert!(matches!(keys.admitted_work("owner", page.pg, "tm-waiting", cg).unwrap(), CreateAdmission::Run(actual) if actual == cg));
    let CreateAdmission::Join(waiter) = keys.admitted_work("owner", page.pg, "tm-waiting", cg).unwrap() else { panic!("join"); };
    let task = tokio::spawn(CreateAdmission::joined(waiter, JOIN_DEADLINE));
    tokio::task::yield_now().await;
    tokio::time::advance(JOIN_DEADLINE - Duration::from_millis(1)).await;
    assert!(!task.is_finished());
    tokio::time::advance(Duration::from_millis(1)).await;
    assert!(task.await.unwrap().unwrap_err().starts_with("host-ownership-pending:"));
    assert_eq!(keys.owner_state("tm-waiting").unwrap().0, cg);
    assert!(matches!(keys.admitted_work("owner", page.pg, "tm-waiting", cg).unwrap(), CreateAdmission::Join(_)));
    assert!(keys.resolve_process("pc-control", false).is_some());
}

#[test]
fn page_end_orphans_live_shells_removes_held_and_preserves_other_window() {
    let keys = HostKeys::default();
    let mut page = Page::new(&keys, "owner");
    let mut other = Page::new(&keys, "other");
    let owned = register_shell(&keys, &mut page, "tm-owned", "pc-owned");
    let parked = register_shell(&keys, &mut page, "tm-parked", "pc-parked");
    assert_eq!(page.op(&keys, PaneOp::Depart { pi: parked.pi }), PaneResult::Ok);
    let pending = page.enter(&keys, "tm-pending");
    page.admit(&keys, pending.pi);
    let waiting = page.entry("tm-waiting", true);
    assert_eq!(page.op(&keys, PaneOp::Enter { panes: vec![waiting.clone()] }), PaneResult::Ok);
    assert_eq!(page.op(&keys, PaneOp::Stash { tx: "held".into(), pairs: vec![waiting.clone()] }), PaneResult::Ok);
    assert!(matches!(other.op(&keys, PaneOp::Take { tx: "held".into() }), PaneResult::Taken { .. }));
    let held = other.entry("tm-waiting", false);
    assert_eq!(other.op(&keys, PaneOp::Adopt { tx: "held".into(), pairs: vec![held.clone()] }), PaneResult::Ok);
    let control = register_shell(&keys, &mut other, "tm-control", "pc-control");
    assert_eq!(keys.pane_owner("tm-owned"), Some(Owner::Pane(owned.pi)));
    assert_eq!(keys.pane_owner("tm-waiting"), Some(Owner::Pane(held.pi)));
    assert_eq!(keys.destroy_window("owner", page.wi).len(), 1);
    for leaf in ["tm-owned", "tm-parked", "tm-pending"] { assert_eq!(keys.pane_owner(leaf), Some(Owner::Orphaned)); }
    assert_eq!(keys.pane_owner("tm-control"), Some(Owner::Pane(control.pi)));
    assert_eq!(keys.pane_owner("tm-waiting"), Some(Owner::Pane(held.pi)));
    assert!(keys.pane_op("owner", PaneRequest { pg: page.pg, seq: page.seq + 1, op: PaneOp::Settle }).is_err());
    assert_eq!(keys.close_process_reap("pc-owned", true), (PaneResult::Ok, vec!["pc-owned".into()]));
    assert_eq!(keys.destroy_window("other", other.wi).len(), 1);
    assert!(keys.owner_state("tm-waiting").is_none());
    assert!(!keys.is_restoring_key("legacy-tm-waiting", Instant::now()));
}

#[test]
fn settle_only_orphans_lower_pages_and_late_label_destroy_preserves_successor() {
    let keys = HostKeys::default();
    let mut old = Page::new(&keys, "owner");
    let mut other = Page::new(&keys, "other");
    register_shell(&keys, &mut old, "tm-old", "pc-old");
    let control = register_shell(&keys, &mut other, "tm-control", "pc-control");
    let mut settled = Page::register(&keys, "owner", old.wi);
    let current = register_shell(&keys, &mut settled, "tm-current", "pc-current");
    let mut higher = Page::register(&keys, "owner", old.wi);
    let high = register_shell(&keys, &mut higher, "tm-high", "pc-high");
    assert_eq!(settled.op(&keys, PaneOp::Settle), PaneResult::Ok);
    assert_eq!(keys.pane_owner("tm-old"), Some(Owner::Orphaned));
    assert_eq!(keys.pane_owner("tm-current"), Some(Owner::Pane(current.pi)));
    assert_eq!(keys.pane_owner("tm-high"), Some(Owner::Pane(high.pi)));
    let mut successor = Page::new(&keys, "owner");
    let replacement = register_shell(&keys, &mut successor, "tm-successor", "pc-successor");
    assert!(keys.pane_op("owner", PaneRequest { pg: settled.pg, seq: settled.seq + 1, op: PaneOp::Settle }).is_err());
    assert_eq!(keys.destroy_window("owner", old.wi).len(), 2);
    assert_eq!(keys.pane_owner("tm-successor"), Some(Owner::Pane(replacement.pi)));
    assert_eq!(keys.pane_owner("tm-control"), Some(Owner::Pane(control.pi)));
    assert_eq!(successor.op(&keys, PaneOp::Settle), PaneResult::Ok);
}

#[test]
fn stream_json_contract_uses_renderer_tags_and_field_names() {
    let keys = HostKeys::default();
    let mut page = Page::new(&keys, "owner");
    let value = serde_json::json!({ "pg": page.pg, "seq": 1, "op": { "kind": "enter", "panes": [{ "pi": { "pg": page.pg, "seq": 1 }, "paneId": "pane-json", "leaf": "tm-json", "override": "legacy-json", "restore": true }] } });
    let request: PaneRequest = serde_json::from_value(value).unwrap();
    assert_eq!(serde_json::to_value(keys.pane_op("owner", request).unwrap().0).unwrap(), serde_json::json!({ "status": "Ack", "result": { "status": "Ok" } }));
    page.seq = 1;
    assert_eq!(serde_json::to_value(page.op(&keys, PaneOp::AdmitCreate { pi: PaneIdentity { pg: page.pg, seq: 1 }, mode: CreateMode::Mount })).unwrap()["status"], "Create");
    let stale: PaneRequest = serde_json::from_value(serde_json::json!({ "pg": page.pg, "seq": 0, "op": { "kind": "settle" } })).unwrap();
    assert_eq!(serde_json::to_value(keys.pane_op("owner", stale).unwrap().0).unwrap(), serde_json::json!({ "status": "Resync", "nextSeq": 3 }));
    let offer: BindVia = serde_json::from_value(serde_json::json!({ "offer": 7 })).unwrap();
    assert!(matches!(offer, BindVia::Offer { offer: 7 }));
    assert!(matches!(serde_json::from_value::<PaneOp>(serde_json::json!({ "kind": "admit_create", "pi": { "pg": 1, "seq": 1 }, "mode": "Restart" })).unwrap(), PaneOp::AdmitCreate { mode: CreateMode::Restart, .. }));
}

#[test]
fn overflow_and_incarnation_reuse_refuse_without_spending_authority() {
    let keys = HostKeys::default();
    let mut page = Page::new(&keys, "owner");
    let entry = page.enter(&keys, "tm-control");
    assert!(matches!(page.op(&keys, PaneOp::Enter { panes: vec![entry.clone()] }), PaneResult::Rejected { .. }));
    assert_eq!(page.op(&keys, PaneOp::Depart { pi: entry.pi }), PaneResult::Ok);
    assert!(matches!(page.op(&keys, PaneOp::Enter { panes: vec![entry.clone()] }), PaneResult::Rejected { .. }));
    let copy = page.enter(&keys, "tm-new");
    keys.lock().sequence = u64::MAX;
    assert_eq!(page.op(&keys, PaneOp::AdmitCreate { pi: copy.pi, mode: CreateMode::Mount }), PaneResult::Retry);
    assert!(keys.owner_state("tm-new").is_none());
    keys.lock().panes.streams.get_mut(&page.pg).unwrap().next = u64::MAX;
    assert!(keys.pane_op("owner", PaneRequest { pg: page.pg, seq: u64::MAX, op: PaneOp::Depart { pi: copy.pi } }).is_err());
    assert_eq!(keys.lock().panes.present.get(&copy.pi), Some(&copy.descriptor));
}
