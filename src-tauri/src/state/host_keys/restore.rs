//! Restore intent belongs to a window's pane, not to one spelling of its key.
//! Aliases are symbolic so sessions listed later receive the same protection.

use super::*;
use std::time::Instant;
use super::super::{parse_session_key, SessionKeyKind, host_registry::RESTORE_INTENT_TTL};
#[cfg(test)]
use super::super::host_registry::OrphanVerdict;

#[derive(Clone, Debug)]
pub(super) struct Aliases { pub leaf: String, pub override_key: Option<String> }
impl Aliases {
    fn new(leaf: &str, override_key: Option<&str>) -> Self {
        Self { leaf: leaf.into(), override_key: override_key.map(str::to_string) }
    }
    fn contains(&self, key: &str) -> bool {
        key == self.leaf || self.override_key.as_deref() == Some(key)
            || parse_session_key(key) == SessionKeyKind::V2 { owner_leaf: &self.leaf }
    }
    fn intersects(&self, other: &Self) -> bool {
        self.contains(&other.leaf) || other.contains(&self.leaf)
            || other.override_key.as_deref().is_some_and(|k| self.contains(k))
            || self.override_key.as_deref().is_some_and(|k| other.contains(k))
    }
}
#[derive(Clone)]
pub(super) struct Intent { pub aliases: Aliases, pub stamp: Instant }
impl Intent {
    fn live(&self, now: Instant) -> bool { now.saturating_duration_since(self.stamp) < RESTORE_INTENT_TTL }
}

impl HostKeys {
    pub(crate) fn register_restoring_leaf(&self, label: &str, leaf: &str, override_key: Option<&str>, now: Instant, already_registered: impl FnOnce() -> bool) -> bool {
        let mut inner = self.lock();
        // Unstaged placement is still waiting for the hosts. Staged or live
        // ownership will bind without another restore registration.
        if inner.owners.get(leaf).is_some_and(|r| owners::shell_of(&r.state).is_some()) || already_registered() { return false; }
        let aliases = Aliases::new(leaf, override_key);
        inner.closed_unowned.retain(|_, marker| !marker.aliases.intersects(&aliases));
        inner.restore_holders.insert((label.into(), leaf.into()), Intent { aliases, stamp: now });
        true
    }

    pub(crate) fn forget_restoring_leaf(&self, label: &str, leaf: &str, now: Instant) {
        let mut inner = self.lock();
        let address = (label.into(), leaf.into());
        let aliases = inner.restore_holders.remove(&address).map_or_else(|| Aliases::new(leaf, None), |h| h.aliases);
        inner.closed_unowned.insert(address, Intent { aliases, stamp: now });
    }

    pub(crate) fn is_restoring_key(&self, key: &str, now: Instant) -> bool {
        Self::protected(&self.lock(), key, now)
    }

    /// A keyed retry refreshes matching holders but never creates an intent.
    pub(crate) fn refresh_restoring_key(&self, key: &str, now: Instant) {
        for holder in self.lock().restore_holders.values_mut().filter(|h| h.aliases.contains(key)) { holder.stamp = now; }
    }

    pub(super) fn protected(inner: &Inner, key: &str, now: Instant) -> bool {
        inner.restore_holders.values().any(|h| h.live(now) && h.aliases.contains(key))
    }

    pub(super) fn unowned_due(inner: &Inner, key: &str, now: Instant) -> bool {
        !Self::protected(inner, key, now)
            && inner.closed_unowned.values().any(|m| m.live(now) && m.aliases.contains(key))
            && !inner.keys.iter().any(|((_, k), r)| k == key && matches!(r.state, KeyState::Held(_) | KeyState::Bound(_)))
    }

    #[cfg(test)]
    pub(in crate::state) fn orphan_verdict(&self, key: &str, now: Instant) -> OrphanVerdict {
        let inner = self.lock();
        if Self::protected(&inner, key, now) { OrphanVerdict::Restoring }
        else if Self::unowned_due(&inner, key, now) { OrphanVerdict::CloseUnowned }
        else { OrphanVerdict::Surface }
    }

    /// Only this leaf's registration ends its holders. A shared override does
    /// not grant the registering pane authority to end another pane's intent.
    pub(super) fn settle_restore(inner: &mut Inner, leaf: &str, key: Option<&str>) {
        inner.restore_holders.retain(|(_, l), _| l != leaf);
        let aliases = Aliases::new(leaf, key);
        inner.closed_unowned.retain(|_, m| !m.aliases.intersects(&aliases));
    }

    pub(crate) fn reap_expired_restore_intents(&self, now: Instant) {
        let mut inner = self.lock();
        inner.restore_holders.retain(|_, h| h.live(now));
        inner.closed_unowned.retain(|_, m| m.live(now));
    }

    #[cfg(test)]
    pub(crate) fn holder_stamp(&self, label: &str, leaf: &str) -> Option<Instant> {
        self.lock().restore_holders.get(&(label.into(), leaf.into())).map(|h| h.stamp)
    }
    #[cfg(test)]
    pub(crate) fn holder_count(&self) -> usize { self.lock().restore_holders.len() }
    #[cfg(test)]
    pub(crate) fn marker_count(&self) -> usize { self.lock().closed_unowned.len() }
    #[cfg(test)]
    pub(crate) fn unowned_close_due(&self, registered: bool, key: &str, now: Instant) -> bool {
        !registered && Self::unowned_due(&self.lock(), key, now)
    }
    #[cfg(test)]
    pub(crate) fn settle_restoring_leaf(&self, leaf: &str, key: Option<&str>) {
        Self::settle_restore(&mut self.lock(), leaf, key);
    }
}
