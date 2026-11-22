//! Read-only metrics projection over the existing pane/page authority.
use super::{owners::OwnerState, panes::Owner, HostKeys, Inner};

impl HostKeys {
    /// Metrics uses a read-only view of the same placement authority. Unlike
    /// session admission, a watch may not create or reserve an ownership row.
    pub(crate) fn metrics_placement(&self, leaf: &str) -> Option<u64> {
        Self::metrics_placement_locked(&self.lock(), leaf)
    }

    fn metrics_placement_locked(inner: &Inner, leaf: &str) -> Option<u64> {
        let row = inner.owners.get(leaf)?;
        (row.ssh_reserved && row.cg != 0
            && !matches!(row.owner, Owner::Orphaned | Owner::Headless)
            && !matches!(row.state, OwnerState::Closing(_))).then_some(row.cg)
    }

    pub(crate) fn metrics_sender(&self, label: &str, pg: u64) -> Option<u64> {
        self.lock().window_pages.sender(label, pg).ok().map(|page| page.wi)
    }

    /// An untaken transfer still belongs to its admitted source. Once taken,
    /// neither side may watch until the destination adopts an actual pane.
    pub(crate) fn metrics_owner(&self, label: &str, pg: u64, leaf: &str) -> Option<(u64, u64)> {
        let inner = self.lock();
        let page = inner.window_pages.sender(label, pg).ok()?;
        let receipt = Self::metrics_placement_locked(&inner, leaf)?;
        let belongs = match &inner.owners.get(leaf)?.owner {
            Owner::Pane(pi) => pi.pg == page.pg
                && inner.panes.present.get(pi).is_some_and(|pane| pane.leaf == leaf),
            Owner::Transfer { tx, taken: false } => inner.panes.transfers.get(tx).is_some_and(|t| {
                t.source == page.pg && t.members.iter().any(|m| m.descriptor.leaf == leaf)
            }),
            _ => false,
        };
        belongs.then_some((page.wi, receipt))
    }
}
