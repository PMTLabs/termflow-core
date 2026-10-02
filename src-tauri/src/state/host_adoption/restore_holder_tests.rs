use super::fake_hosts::*;
use super::*;
use crate::state::host_registry::{self, ListingMaps, OrphanVerdict};
use crate::state::{CloseState, KeyState, Completion, ShellStage, StagedShell};
use crate::state::host_keys::panes::{PaneDescriptor, PaneEntry, PaneIdentity, PaneOp, PaneReply, PaneRequest, PaneResult};
use crate::state::host_keys::PageRegistration;
use std::time::Instant as Clock;
use termflow_pty_protocol::{Frame, Control};

const HOST: &str = "restore-holder-host";
const CHANNEL: HostChannel = HostChannel::Primary;
const K: &str = "tm-old~00000000000040008000000000000001";
const L1: &str = "tm-leaf~00000000000040008000000000000001";
const L2: &str = "tm-leaf~00000000000040008000000000000002";

struct Page { label: &'static str, wi: u64, pg: u64, seq: u64, incarnation: u64 }
impl Page {
    fn new(port: &FakePort, label: &'static str) -> Self {
        let keys = port.table().keys();
        let guard = keys.reserve_window(label).unwrap();
        let wi = guard.identity().1;
        guard.commit().unwrap();
        let PageRegistration::Registered { pg, .. } = keys.register_page(label).unwrap() else { panic!("page"); };
        Self { label, wi, pg, seq: 0, incarnation: 0 }
    }
    fn op(&mut self, port: &FakePort, op: PaneOp, now: Clock) -> PaneResult {
        self.seq += 1;
        let (reply, effects) = port.table().keys().pane_op_at(self.label, PaneRequest { pg: self.pg, seq: self.seq, op }, now).unwrap();
        assert!(effects.closes.is_empty(), "fixtures close only unowned listed sessions");
        let PaneReply::Ack { result } = reply else { panic!("ack"); };
        result
    }
    fn enter(&mut self, port: &FakePort, leaf: &str, key: Option<&str>, now: Clock) -> PaneEntry {
        self.incarnation += 1;
        let pi = PaneIdentity { pg: self.pg, seq: self.incarnation };
        let entry = PaneEntry { pi, descriptor: PaneDescriptor { pane_id: format!("pane-{}-{}", self.pg, pi.seq), leaf: leaf.into(), restore: true, override_key: key.map(str::to_string) } };
        assert_eq!(self.op(port, PaneOp::Enter { panes: vec![entry.clone()] }, now), PaneResult::Ok);
        entry
    }
    fn close(&mut self, port: &FakePort, pi: PaneIdentity, now: Clock) {
        assert_eq!(self.op(port, PaneOp::Close { pi }, now), PaneResult::Contended);
    }
    fn register_local(&mut self, port: &FakePort, entry: &PaneEntry, now: Clock) {
        let PaneResult::Create { cg } = self.op(port, PaneOp::AdmitCreate { pi: entry.pi, mode: crate::state::CreateMode::Mount }, now) else { panic!("create"); };
        let keys = port.table().keys();
        keys.stage_shell(&entry.descriptor.leaf, cg, "pc-local", None).unwrap();
        assert!(keys.is_restoring_key(&entry.descriptor.leaf, now), "stage is not registration");
        assert!(matches!(keys.complete_shell(&entry.descriptor.leaf, cg, &StagedShell { process: "pc-local".into(), stage: ShellStage::Local }), Completion::Registered));
    }
}
async fn machine(keys: &[&str]) -> (Arc<World>, FakePort) {
    let world = World::new();
    world.add_host(HOST, HostSpec { sessions: keys.iter().enumerate().map(|(i, k)| meta(k, 100 + i as u32)).collect(), ..HostSpec::default() });
    let port = FakePort::new(&world, HOST);
    port.set_candidates(vec![candidate(HOST, HostRole::Current)]);
    ensure_hosts(&port).await.unwrap();
    assert_eq!(world.count(HOST, "List"), 1);
    for key in keys { assert!(port.table().keys().eligible(CHANNEL, key)); }
    (world, port)
}
async fn listing(port: &FakePort, now: Clock) -> crate::pty_host_client::SessionListing {
    let client = port.current_client().unwrap();
    let answer = client.list_sessions_numbered().await.unwrap();
    host_registry::apply_answered_listing(&ListingMaps { host_terminals: &port.0.host_terminals, terminals: &port.0.terminals, keys: port.table().keys() }, CHANNEL, &client, &answer, now);
    answer
}
async fn fence(port: &FakePort) -> crate::pty_host_client::SessionListing {
    // This response witnesses all preceding Closes on the same FIFO.
    port.current_client().unwrap().list_sessions_numbered().await.unwrap()
}
fn closes(world: &World) -> Vec<String> {
    world.frames_of(HOST).into_iter().filter_map(|f| match f { Frame::Ctrl(Control::Close { tab_id }) => Some(tab_id), _ => None }).collect()
}
fn close_control(page: &mut Page, port: &FakePort, now: Clock) {
    let entry = page.enter(port, "tm-control", None, now);
    page.close(port, entry.pi, now);
}

#[tokio::test]
async fn shared_override_remains_live_until_both_restoring_holders_forget() {
    let (world, port) = machine(&[K, "tm-control", "tm-stray"]).await;
    let now = Clock::now();
    let mut left = Page::new(&port, "left");
    let mut right = Page::new(&port, "right");
    let a = left.enter(&port, "tm-a", Some(K), now);
    let b = right.enter(&port, "tm-b", Some(K), now);
    let control = left.enter(&port, "tm-control", None, now);
    assert_eq!(port.table().keys().holder_count(), 3);
    left.close(&port, control.pi, now);
    left.close(&port, a.pi, now);
    assert_eq!(port.table().keys().marker_count(), 2);
    assert_eq!(port.table().keys().holder_count(), 1);
    let answer = listing(&port, now).await;
    assert_eq!(answer.sessions.len(), 3);
    let after = fence(&port).await;
    assert_eq!(closes(&world), vec!["tm-control"]);
    assert!(after.sessions.iter().any(|s| s.tab_id == K && s.pid == 100));
    assert!(port.table().keys().eligible(CHANNEL, K));
    assert_eq!(host_registry::orphan_verdict(port.table().keys(), K, now), OrphanVerdict::Restoring);
    super::panes::surface_orphans(&port, answer.sessions, CHANNEL);
    port.table().keys().flush_deliveries();
    assert_eq!(*port.0.recovered.lock().unwrap(), vec!["tm-stray"]);
    right.close(&port, b.pi, now);
    listing(&port, now).await;
    let after = fence(&port).await;
    assert_eq!(closes(&world), vec!["tm-control", K]);
    assert!(!after.sessions.iter().any(|s| s.tab_id == K));
    assert!(after.sessions.iter().any(|s| s.tab_id == "tm-stray" && s.pid == 102));
    assert!(matches!(port.table().keys().state(CHANNEL, K), Some(KeyState::Ending { close: CloseState::Sent(_), .. })));
    listing(&port, now).await;
    fence(&port).await;
    assert_eq!(closes(&world), vec!["tm-control", K]);
}

#[tokio::test]
async fn leaf_holder_protects_both_incarnations_and_legacy_and_new_holder_consumes_the_alias_marker() {
    let (world, port) = machine(&[L1, L2, "tm-leaf", "tm-control"]).await;
    let now = Clock::now();
    let mut left = Page::new(&port, "left");
    let mut right = Page::new(&port, "right");
    left.enter(&port, "tm-other", None, now);
    for key in [L1, L2, "tm-leaf"] { assert!(!port.table().keys().is_restoring_key(key, now)); }
    let old = right.enter(&port, "tm-leaf", None, now);
    for key in [L1, L2, "tm-leaf"] { assert!(port.table().keys().is_restoring_key(key, now)); }
    right.close(&port, old.pi, now);
    assert_eq!(port.table().keys().marker_count(), 1);
    for key in [L1, L2, "tm-leaf"] { assert!(port.table().keys().unowned_close_due(false, key, now)); }
    let successor = right.enter(&port, "tm-leaf", None, now);
    assert_eq!(port.table().keys().marker_count(), 0);
    close_control(&mut left, &port, now);
    listing(&port, now).await;
    let after = fence(&port).await;
    assert_eq!(closes(&world), vec!["tm-control"]);
    for key in [L1, L2, "tm-leaf"] { assert!(after.sessions.iter().any(|s| s.tab_id == key)); }
    right.register_local(&port, &successor, now);
    assert_eq!(port.table().keys().holder_count(), 1);
    assert_eq!(port.table().keys().marker_count(), 1);
    listing(&port, now).await;
    fence(&port).await;
    assert_eq!(closes(&world), vec!["tm-control"]);
}

#[tokio::test]
async fn override_protection_uses_the_exact_key_even_when_its_owner_leaf_differs() {
    let (world, port) = machine(&[K, "tm-old~00000000000040008000000000000002", "tm-old", "tm-control"]).await;
    let now = Clock::now();
    let mut left = Page::new(&port, "left");
    let mut right = Page::new(&port, "right");
    let a = left.enter(&port, "tm-source", Some(K), now);
    let b = right.enter(&port, "tm-new", Some(K), now);
    left.close(&port, a.pi, now);
    close_control(&mut left, &port, now);
    assert!(port.table().keys().is_restoring_key(K, now));
    for key in ["tm-old~00000000000040008000000000000002", "tm-old"] {
        assert!(!port.table().keys().is_restoring_key(key, now));
        assert!(!port.table().keys().unowned_close_due(false, key, now));
    }
    listing(&port, now).await;
    fence(&port).await;
    assert_eq!(closes(&world), vec!["tm-control"]);
    assert!(port.table().keys().eligible(CHANNEL, K));
    right.close(&port, b.pi, now);
    listing(&port, now).await;
    let after = fence(&port).await;
    assert_eq!(closes(&world), vec!["tm-control", K]);
    assert_eq!(after.sessions.len(), 2);
}

#[tokio::test]
async fn a_new_holder_consumes_intersecting_markers_across_different_leaves() {
    for (old_leaf, old_override, new_leaf, new_override) in [("tm-source", Some(K), "tm-new", Some(K)), ("tm-old", None, "tm-new", Some(K)), ("tm-source", Some(K), "tm-old", None)] {
        let (world, port) = machine(&[K, old_leaf, "tm-control"]).await;
        let now = Clock::now();
        let mut left = Page::new(&port, "left");
        let mut right = Page::new(&port, "right");
        let old = left.enter(&port, old_leaf, old_override, now);
        left.close(&port, old.pi, now);
        assert_eq!(port.table().keys().marker_count(), 1);
        assert!(port.table().keys().unowned_close_due(false, K, now));
        let new = right.enter(&port, new_leaf, new_override, now);
        assert_eq!(port.table().keys().marker_count(), 0);
        right.register_local(&port, &new, now);
        assert_eq!(port.table().keys().holder_count(), 0);
        close_control(&mut left, &port, now);
        listing(&port, now).await;
        let after = fence(&port).await;
        assert_eq!(closes(&world), vec!["tm-control"]);
        assert_eq!(after.sessions.len(), 2);
        assert!(port.table().keys().eligible(CHANNEL, K));
        assert!(port.table().keys().eligible(CHANNEL, old_leaf));
    }
}

#[tokio::test]
async fn closing_one_incarnation_cannot_remove_another_windows_same_leaf_holder() {
    let (world, port) = machine(&[L1, "tm-control"]).await;
    let now = Clock::now();
    let mut left = Page::new(&port, "left");
    let mut right = Page::new(&port, "right");
    let a = left.enter(&port, "tm-leaf", None, now);
    let b = right.enter(&port, "tm-leaf", Some(L1), now);
    assert_ne!(a.pi, b.pi);
    assert_eq!(port.table().keys().holder_count(), 2);
    left.close(&port, a.pi, now);
    left.close(&port, a.pi, now);
    assert_eq!(port.table().keys().holder_count(), 1);
    close_control(&mut left, &port, now);
    listing(&port, now).await;
    fence(&port).await;
    assert_eq!(closes(&world), vec!["tm-control"]);
    right.close(&port, b.pi, now);
    listing(&port, now).await;
    fence(&port).await;
    assert_eq!(closes(&world), vec!["tm-control", L1]);
}

#[tokio::test]
async fn blocked_present_stream_survives_sixteen_minutes_until_depart_or_page_end() {
    for page_end in [false, true] {
        let (world, port) = machine(&[K, "tm-expired-marker", "tm-control"]).await;
        let t0 = Clock::now();
        let mut left = Page::new(&port, "left");
        let mut right = Page::new(&port, "right");
        let held = left.enter(&port, "tm-held", Some(K), t0);
        let expired = right.enter(&port, "tm-expired-marker", None, t0);
        right.close(&port, expired.pi, t0);
        assert_eq!(port.table().keys().holder_count(), 1);
        // A withheld head leaves subsequent work out of sequence. No later op
        // or refresh can run on this page while its holder must stay present.
        let blocked = PaneRequest { pg: left.pg, seq: left.seq + 2, op: PaneOp::Depart { pi: held.pi } };
        let (reply, effects) = port.table().keys().pane_op_at(left.label, blocked, t0).unwrap();
        assert_eq!(reply, PaneReply::Resync { next_seq: left.seq + 1 });
        assert!(effects.closes.is_empty());
        let later = t0 + Duration::from_secs(16 * 60);
        port.table().keys().reap_expired_restore_intents(later);
        assert_eq!(port.table().keys().holder_count(), 1);
        assert_eq!(port.table().keys().marker_count(), 0);
        let closing = right.enter(&port, "tm-closing", Some(K), later);
        right.close(&port, closing.pi, later);
        close_control(&mut right, &port, later);
        listing(&port, later).await;
        let after = fence(&port).await;
        assert_eq!(closes(&world), vec!["tm-control"]);
        assert!(after.sessions.iter().any(|s| s.tab_id == K && s.pid == 100));
        assert!(after.sessions.iter().any(|s| s.tab_id == "tm-expired-marker"));
        assert!(port.table().keys().eligible(CHANNEL, K));
        if page_end {
            assert_eq!(port.table().keys().destroy_window(left.label, left.wi).len(), 1);
        } else { assert_eq!(left.op(&port, PaneOp::Depart { pi: held.pi }, later), PaneResult::Ok); }
        assert_eq!(port.table().keys().holder_count(), 0);
        listing(&port, later).await;
        fence(&port).await;
        assert_eq!(closes(&world), vec!["tm-control", K]);
    }
}

#[tokio::test]
async fn late_original_page_end_preserves_reused_labels_successor_holder() {
    let (world, port) = machine(&[K, "tm-control"]).await;
    let now = Clock::now();
    let mut old = Page::new(&port, "reused");
    old.enter(&port, "tm-held", Some(K), now);
    let mut successor = Page::new(&port, "reused");
    let next = successor.enter(&port, "tm-held", Some(K), now);
    let mut control = Page::new(&port, "control");
    close_control(&mut control, &port, now);
    assert_eq!(port.table().keys().holder_count(), 2);
    assert_eq!(port.table().keys().destroy_window(old.label, old.wi).len(), 1);
    assert_eq!(port.table().keys().holder_count(), 1);
    let marker = control.enter(&port, "tm-other", Some(K), now);
    control.close(&port, marker.pi, now);
    listing(&port, now).await;
    fence(&port).await;
    assert_eq!(closes(&world), vec!["tm-control"]);
    successor.close(&port, next.pi, now);
    listing(&port, now).await;
    fence(&port).await;
    assert_eq!(closes(&world), vec!["tm-control", K]);
}

#[tokio::test]
async fn staged_and_taken_transfer_members_protect_listed_keys_until_transfer_end() {
    for taken in [false, true] {
        let (world, port) = machine(&[K, "tm-control"]).await;
        let now = Clock::now();
        let mut source = Page::new(&port, "source");
        let mut destination = Page::new(&port, "destination");
        let held = source.enter(&port, "tm-held", Some(K), now);
        assert_eq!(source.op(&port, PaneOp::Stash { ui: None, tx: "tx".into(), pairs: vec![held] }, now), PaneResult::Ok);
        if taken {
            let PaneResult::Taken { payload } = destination.op(&port, PaneOp::Take { tx: "tx".into() }, now) else { panic!("taken"); };
            assert_eq!(payload.panes.len(), 1);
            assert!(payload.panes[0].restore);
            assert_eq!(payload.panes[0].override_key.as_deref(), Some(K));
        }
        assert_eq!(port.table().keys().destroy_window(source.label, source.wi).len(), 1);
        assert_eq!(port.table().keys().holder_count(), 1);
        let closing = destination.enter(&port, "tm-other", Some(K), now);
        destination.close(&port, closing.pi, now);
        close_control(&mut destination, &port, now);
        listing(&port, now).await;
        fence(&port).await;
        assert_eq!(closes(&world), vec!["tm-control"]);
        assert!(port.table().keys().eligible(CHANNEL, K));
        let ended = now + Duration::from_secs(60);
        port.table().keys().expire_transfers(ended);
        assert_eq!(port.table().keys().holder_count(), 0);
        listing(&port, ended).await;
        fence(&port).await;
        assert_eq!(closes(&world), vec!["tm-control", K]);
    }
}

#[tokio::test]
async fn hosted_registration_ends_only_its_own_holder_and_same_leaf_reload_is_a_noop() {
    let (world, port) = machine(&[K, "tm-control"]).await;
    let now = Clock::now();
    let mut left = Page::new(&port, "left");
    let mut right = Page::new(&port, "right");
    let a = left.enter(&port, "tm-a", Some(K), now);
    let b = right.enter(&port, "tm-b", Some(K), now);
    assert_eq!(port.table().keys().holder_count(), 2);
    let PaneResult::Create { cg } = left.op(&port, PaneOp::AdmitCreate { pi: a.pi, mode: crate::state::CreateMode::Mount }, now) else { panic!("admission"); };
    let crate::state::host_routing::Placement::Attach { client, ticket, session_key, .. } =
        crate::state::host_routing::place_owned(&port, "tm-a", Some(K), Some((cg, "pc-restored"))).await.unwrap() else { panic!("attach"); };
    assert_eq!(session_key, K);
    assert_eq!(port.table().keys().holder_count(), 2, "stage must retain both present capabilities");
    assert!(ticket.publish_key("pc-restored"));
    assert_eq!(client.attach_confirmed(&session_key, 0).await, Some(true));
    assert_eq!(world.sessions(HOST, "Attach"), vec![K]);
    let shell = StagedShell { process: "pc-restored".into(), stage: ShellStage::Hosted(ticket.key_stage().unwrap()) };
    assert!(matches!(port.table().keys().complete_shell("tm-a", cg, &shell), Completion::Registered));
    assert_eq!(port.table().keys().holder_count(), 1);
    assert!(!port.table().keys().is_restoring_key("tm-a", now));
    assert!(port.table().keys().is_restoring_key("tm-b", now));
    assert!(port.table().keys().is_restoring_key(K, now));
    right.enter(&port, "tm-a", Some(K), now);
    assert_eq!(port.table().keys().holder_count(), 1, "only the current owner row suppresses same-leaf registration");
    close_control(&mut right, &port, now);
    listing(&port, now).await;
    fence(&port).await;
    assert_eq!(closes(&world), vec!["tm-control"]);
    assert_eq!(port.table().keys().state(CHANNEL, K), Some(KeyState::Bound("pc-restored".into())));
    assert_eq!(right.op(&port, PaneOp::Depart { pi: b.pi }, now), PaneResult::Ok);
    assert_eq!(port.table().keys().holder_count(), 0);
    assert!(!port.table().keys().is_restoring_key(K, now));
    assert_eq!(closes(&world), vec!["tm-control"]);
}

#[tokio::test]
async fn replayed_enter_cannot_renew_holder_or_consume_a_later_close_marker() {
    let (world, port) = machine(&[K, "tm-control"]).await;
    let now = Clock::now();
    let mut left = Page::new(&port, "left");
    let mut right = Page::new(&port, "right");
    let held = left.enter(&port, "tm-held", Some(K), now);
    let closing = right.enter(&port, "tm-other", Some(K), now);
    right.close(&port, closing.pi, now);
    assert_eq!(port.table().keys().holder_count(), 1);
    assert_eq!(port.table().keys().marker_count(), 1);
    let mut replay = held.clone();
    replay.descriptor.override_key = Some("unrelated".into());
    let (reply, effects) = port.table().keys().pane_op_at(left.label, PaneRequest {
        pg: left.pg, seq: left.seq, op: PaneOp::Enter { panes: vec![replay] },
    }, now).unwrap();
    assert_eq!(reply, PaneReply::Ack { result: PaneResult::Ok });
    assert!(effects.closes.is_empty());
    assert_eq!(port.table().keys().holder_count(), 1);
    assert_eq!(port.table().keys().marker_count(), 1);
    assert!(port.table().keys().is_restoring_key(K, now));
    assert!(!port.table().keys().is_restoring_key("unrelated", now));
    close_control(&mut right, &port, now);
    listing(&port, now).await;
    fence(&port).await;
    assert_eq!(closes(&world), vec!["tm-control"]);
    left.close(&port, held.pi, now);
    listing(&port, now).await;
    fence(&port).await;
    assert_eq!(closes(&world), vec!["tm-control", K]);
}

#[test]
fn restore_listing_policy_reads_shared_ownership_in_one_step() {
    use crate::state::source_scan::fn_body;
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let keys = std::fs::read_to_string(root.join("state/host_keys.rs")).unwrap();
    let listing = fn_body(&keys, "pub(crate) fn listing_on(");
    for needle in ["let mut inner = self.lock()", "c.epoch == epoch", "Self::apply_listing(&mut inner,"] { assert!(listing.contains(needle)); }
    let apply = fn_body(&keys, "fn apply_listing(");
    for needle in ["Self::unowned_due(", "KeyState::Listed", "Self::end(inner,"] { assert!(apply.contains(needle)); }
    let body = fn_body(&keys, "pub fn close_listed(");
    for needle in ["let mut inner = self.lock()", "Self::unowned_due(&inner,", "KeyState::Listed", "Self::end(&mut inner,"] { assert!(body.contains(needle)); }
    let restore = std::fs::read_to_string(root.join("state/host_keys/restore.rs")).unwrap();
    let policy = fn_body(&restore, "pub(super) fn unowned_due(");
    for needle in ["Self::protected(inner,", "inner.closed_unowned", "inner.keys", "KeyState::Held", "KeyState::Bound"] { assert!(policy.contains(needle)); }
    let panes = std::fs::read_to_string(root.join("state/host_keys/panes.rs")).unwrap();
    assert!(fn_body(&panes, "fn insert_panes(").contains("Self::register_pane_holder(inner, entry.pi, &entry.descriptor)"));
}
