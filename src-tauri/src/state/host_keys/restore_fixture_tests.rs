//! Adapters for older routing fixtures. Labels identify fixture windows only;
//! holder creation and ending go through the production page stream.
use super::*;
use super::super::panes::{PaneDescriptor, PaneEntry, PaneIdentity, PaneOp, PaneReply, PaneRequest, PaneResult};
use super::super::pages::PageRegistration;

impl HostKeys {
    fn test_restore_pane(&self, label: &str, leaf: &str) -> Option<PaneIdentity> {
        let id = format!("{label}/{leaf}");
        self.lock().panes.present.iter().filter(|(_, d)| d.pane_id == id).map(|(pi, _)| *pi).max_by_key(|pi| pi.pg)
    }
    pub(crate) fn test_restore_op(&self, label: &str, pi: PaneIdentity, op: PaneOp, now: Instant) -> PaneResult {
        let seq = self.lock().panes.streams[&pi.pg].next;
        let (reply, effects) = self.pane_op_at(label, PaneRequest { pg: pi.pg, seq, op }, now).unwrap();
        assert!(effects.closes.is_empty());
        let PaneReply::Ack { result } = reply else { panic!("fixture stream ack"); };
        result
    }
    pub(crate) fn enter_test_restore(&self, label: &str, leaf: &str, key: Option<&str>, now: Instant) -> bool {
        if let Some(pi) = self.test_restore_pane(label, leaf) {
            assert_eq!(self.test_restore_op(label, pi, PaneOp::Depart { pi }, now), PaneResult::Ok);
        }
        let page = match self.register_page(label).unwrap() {
            PageRegistration::Registered { pg, .. } => pg,
            PageRegistration::Retry => {
                self.reserve_window(label).unwrap().commit().unwrap();
                let PageRegistration::Registered { pg, .. } = self.register_page(label).unwrap() else { panic!("fixture page"); };
                pg
            }
        };
        let pi = PaneIdentity { pg: page, seq: 1 };
        let descriptor = PaneDescriptor { pane_id: format!("{label}/{leaf}"), leaf: leaf.into(), restore: true, override_key: key.map(str::to_string) };
        assert_eq!(self.test_restore_op(label, pi, PaneOp::Enter { panes: vec![PaneEntry { pi, descriptor }] }, now), PaneResult::Ok);
        self.lock().panes.holders.contains_key(&pi)
    }
    pub(crate) fn close_test_restore(&self, label: &str, leaf: &str, now: Instant) {
        if self.test_restore_pane(label, leaf).is_none() { self.enter_test_restore(label, leaf, None, now); }
        let pi = self.test_restore_pane(label, leaf).unwrap();
        assert_eq!(self.test_restore_op(label, pi, PaneOp::Close { pi }, now), PaneResult::Contended);
    }
    pub(crate) fn has_test_holder(&self, label: &str, leaf: &str) -> bool {
        self.test_restore_pane(label, leaf).is_some_and(|pi| self.lock().panes.holders.contains_key(&pi))
    }
    pub(crate) fn depart_test_restore(&self, label: &str, leaf: &str, now: Instant) {
        let pi = self.test_restore_pane(label, leaf).unwrap();
        assert_eq!(self.test_restore_op(label, pi, PaneOp::Depart { pi }, now), PaneResult::Ok);
    }
    pub(crate) fn admit_test_restore(&self, label: &str, leaf: &str, now: Instant) -> u64 {
        let pi = self.test_restore_pane(label, leaf).unwrap();
        let PaneResult::Create { cg } = self.test_restore_op(label, pi, PaneOp::AdmitCreate { pi, mode: CreateMode::Mount }, now) else { panic!("fixture admission"); };
        cg
    }
    pub(crate) fn settle_restoring_leaf(&self, leaf: &str, key: Option<&str>) {
        // Explicit fixture registration: the marker policy is production code;
        // pane departure releases the fixture's capability through the stream.
        let panes: Vec<_> = self.lock().panes.present.values().filter(|d| d.leaf == leaf)
            .map(|d| d.pane_id.split('/').next().unwrap().to_string()).collect();
        for label in panes { self.depart_test_restore(&label, leaf, Instant::now()); }
        self.settle_restore_markers_for_leaf(leaf, key);
    }
}
