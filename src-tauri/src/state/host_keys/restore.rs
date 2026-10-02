//! Restore intent belongs to a pane incarnation, not to one spelling of its key.
//! Aliases are symbolic so sessions listed later receive the same protection.

use super::*;
use std::time::{Duration, Instant};
use super::super::{parse_session_key, SessionKeyKind};
#[cfg(test)]
use super::super::host_registry::OrphanVerdict;

const CLOSED_UNOWNED_TTL: Duration = Duration::from_secs(15 * 60);

#[cfg(test)]
#[path = "restore_fixture_tests.rs"]
mod fixture;

#[derive(Clone, Debug)]
pub(super) struct Aliases { pub leaf: String, pub override_key: Option<String> }
impl Aliases {
    pub(super) fn new(leaf: &str, override_key: Option<&str>) -> Self {
        Self { leaf: leaf.into(), override_key: override_key.map(str::to_string) }
    }
    pub(super) fn contains(&self, key: &str) -> bool {
        key == self.leaf || self.override_key.as_deref() == Some(key)
            || parse_session_key(key) == SessionKeyKind::V2 { owner_leaf: &self.leaf }
    }
    pub(super) fn intersects(&self, other: &Self) -> bool {
        self.contains(&other.leaf) || other.contains(&self.leaf)
            || other.override_key.as_deref().is_some_and(|k| self.contains(k))
            || self.override_key.as_deref().is_some_and(|k| other.contains(k))
    }
}
#[derive(Clone)]
pub(super) struct ClosedUnowned { pub aliases: Aliases, pub stamp: Instant }
impl ClosedUnowned {
    fn live(&self, now: Instant) -> bool { now.saturating_duration_since(self.stamp) < CLOSED_UNOWNED_TTL }
}

impl HostKeys {
    pub(crate) fn is_restoring_key(&self, key: &str, _now: Instant) -> bool {
        Self::protected(&self.lock(), key)
    }

    pub(super) fn protected(inner: &Inner, key: &str) -> bool {
        inner.panes.holders.values().any(|h| h.contains(key))
    }

    pub(super) fn unowned_due(inner: &Inner, key: &str, now: Instant) -> bool {
        !Self::protected(inner, key)
            && inner.closed_unowned.values().any(|m| m.live(now) && m.aliases.contains(key))
            && !inner.keys.iter().any(|((_, k), r)| k == key && matches!(r.state, KeyState::Held(_) | KeyState::Bound(_)))
    }

    #[cfg(test)]
    pub(in crate::state) fn orphan_verdict(&self, key: &str, now: Instant) -> OrphanVerdict {
        let inner = self.lock();
        if Self::protected(&inner, key) { OrphanVerdict::Restoring }
        else if Self::unowned_due(&inner, key, now) { OrphanVerdict::CloseUnowned }
        else { OrphanVerdict::Surface }
    }

    pub(super) fn settle_restore_markers(inner: &mut Inner, leaf: &str, key: Option<&str>) {
        let aliases = Aliases::new(leaf, key);
        inner.closed_unowned.retain(|_, m| !m.aliases.intersects(&aliases));
    }

    pub(super) fn register_pane_holder(inner: &mut Inner, pi: super::panes::PaneIdentity, descriptor: &super::panes::PaneDescriptor) {
        // A staged or registered shell in this leaf's current row already has
        // its placement. Another leaf sharing the override is not that proof.
        if inner.owners.get(&descriptor.leaf).is_some_and(|r| owners::shell_of(&r.state).is_some()) { return; }
        let aliases = Aliases::new(&descriptor.leaf, descriptor.override_key.as_deref());
        inner.closed_unowned.retain(|_, marker| !marker.aliases.intersects(&aliases));
        inner.panes.holders.insert(pi, aliases);
    }

    pub(super) fn forget_pane_holder(inner: &mut Inner, pi: super::panes::PaneIdentity, now: Instant) {
        let aliases = inner.panes.holders.remove(&pi).or_else(|| inner.panes.present.get(&pi)
            .map(|d| Aliases::new(&d.leaf, d.override_key.as_deref())));
        if let Some(aliases) = aliases {
            inner.closed_unowned.insert(pi, ClosedUnowned { aliases, stamp: now });
        }
    }

    pub(super) fn settle_pane_restore(inner: &mut Inner, leaf: &str) {
        let Some(row) = inner.owners.get(leaf) else { return; };
        let identities: Vec<_> = match &row.owner {
            super::panes::Owner::Pane(pi) | super::panes::Owner::Parked { by: pi, .. } => vec![*pi],
            super::panes::Owner::Transfer { tx, .. } => inner.panes.transfers.get(tx).into_iter()
                .flat_map(|t| t.members.iter().filter(|m| m.descriptor.leaf == leaf).map(|m| m.pi)).collect(),
            _ => Vec::new(),
        };
        for pi in identities { inner.panes.holders.remove(&pi); }
    }

    #[cfg(test)]
    pub(crate) fn settle_restore_markers_for_leaf(&self, leaf: &str, key: Option<&str>) {
        Self::settle_restore_markers(&mut self.lock(), leaf, key);
    }

    pub(crate) fn reap_expired_restore_intents(&self, now: Instant) {
        self.lock().closed_unowned.retain(|_, m| m.live(now));
    }

    #[cfg(test)]
    pub(crate) fn holder_count(&self) -> usize { self.lock().panes.holders.len() }
    #[cfg(test)]
    pub(crate) fn marker_count(&self) -> usize { self.lock().closed_unowned.len() }
    #[cfg(test)]
    pub(crate) fn unowned_close_due(&self, registered: bool, key: &str, now: Instant) -> bool {
        !registered && Self::unowned_due(&self.lock(), key, now)
    }
}
