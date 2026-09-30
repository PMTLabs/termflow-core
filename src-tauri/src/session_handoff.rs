//! Single-use hand-off of a just-created shell from the window that created it to
//! the window the pane moved to.
//!
//! A pane can move to another window while its first create is still in flight.
//! Both windows then ask for the same session; one create wins and registers the
//! terminal, the other is refused. If the winner is the window the pane left, it
//! binds nothing and OFFERS the process here. The window that has the pane takes
//! it, exactly once.
//!
//! An offer is deliberately explicit. Looking the process up by leaf and binding
//! whatever is registered would also take over a shell another window is still
//! showing (a saved layout loaded while one of its tabs lives in a detached
//! window), leaving two windows typing into one shell.
//!
//! Lives in its own file, like `identity_index`, so it is testable without an
//! `AppHandle`.

use crate::identity_index::IdentityIndex;
use dashmap::DashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// How long an offer stays takeable. Long enough for the moved pane's own
/// refused create to arrive after the source's success; short enough that a
/// forgotten offer cannot hand a shell to an unrelated later pane.
const OFFER_TTL: Duration = Duration::from_secs(60);

#[derive(Clone, Default)]
pub struct HandoffOffers {
    /// leaf -> (offered process id, when it was offered)
    offers: Arc<DashMap<String, (String, Instant)>>,
}

impl HandoffOffers {
    pub fn new() -> Self {
        Self::default()
    }

    /// Offer the terminal currently registered for `leaf`. Refused (`false`, nothing
    /// recorded) when no terminal is registered for it: there is nothing to hand
    /// over, and an offer for an absent process could never be honoured.
    pub fn offer(&self, identity: &IdentityIndex, leaf: &str, now: Instant) -> bool {
        self.reap_expired(now);
        let Some(process_id) = identity.process_for_leaf(leaf) else {
            return false;
        };
        self.offers.insert(leaf.to_string(), (process_id, now));
        true
    }

    /// Take the offer for `leaf`, removing it in the same step so only one caller
    /// can ever get it. `None` when there is no live offer, it expired, or the
    /// terminal registered for the leaf is no longer the one that was offered.
    pub fn take(&self, identity: &IdentityIndex, leaf: &str, now: Instant) -> Option<String> {
        self.reap_expired(now);
        let (_, (process_id, _)) = self.offers.remove(leaf)?;
        (identity.process_for_leaf(leaf).as_deref() == Some(process_id.as_str())).then_some(process_id)
    }

    fn reap_expired(&self, now: Instant) {
        self.offers
            .retain(|_, (_, offered_at)| now.saturating_duration_since(*offered_at) < OFFER_TTL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity_with(leaf: &str, process_id: &str) -> IdentityIndex {
        let identity = IdentityIndex::new();
        identity.index(process_id, Some(leaf), process_id);
        identity
    }

    #[test]
    fn an_offer_is_taken_once() {
        let identity = identity_with("tm-moved", "pc-1");
        let offers = HandoffOffers::new();
        let now = Instant::now();
        assert!(offers.offer(&identity, "tm-moved", now));
        assert_eq!(offers.take(&identity, "tm-moved", now).as_deref(), Some("pc-1"));
        assert_eq!(offers.take(&identity, "tm-moved", now), None, "a second adopter gets nothing");
    }

    #[test]
    fn concurrent_takers_share_one_offer() {
        let identity = identity_with("tm-moved", "pc-1");
        let offers = HandoffOffers::new();
        let now = Instant::now();
        assert!(offers.offer(&identity, "tm-moved", now));
        let winners = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..8)
                .map(|_| scope.spawn(|| offers.take(&identity, "tm-moved", now)))
                .collect();
            handles.into_iter().filter_map(|h| h.join().unwrap()).count()
        });
        assert_eq!(winners, 1);
    }

    #[test]
    fn an_offer_expires() {
        let identity = identity_with("tm-moved", "pc-1");
        let offers = HandoffOffers::new();
        let now = Instant::now();
        assert!(offers.offer(&identity, "tm-moved", now));
        assert_eq!(
            offers.take(&identity, "tm-moved", now + OFFER_TTL),
            None,
            "an offer at its TTL is gone"
        );
        assert!(offers.offers.is_empty(), "an expired offer is not kept around");
    }

    #[test]
    fn an_offer_just_inside_its_ttl_is_still_takeable() {
        let identity = identity_with("tm-moved", "pc-1");
        let offers = HandoffOffers::new();
        let now = Instant::now();
        assert!(offers.offer(&identity, "tm-moved", now));
        let almost = now + OFFER_TTL - Duration::from_millis(1);
        assert_eq!(offers.take(&identity, "tm-moved", almost).as_deref(), Some("pc-1"));
    }

    #[test]
    fn a_leaf_with_no_registered_terminal_cannot_be_offered() {
        let identity = IdentityIndex::new();
        let offers = HandoffOffers::new();
        let now = Instant::now();
        assert!(!offers.offer(&identity, "tm-ghost", now));
        identity.index("pc-1", Some("tm-ghost"), "pc-1");
        assert_eq!(offers.take(&identity, "tm-ghost", now), None, "the refused offer recorded nothing");
    }

    #[test]
    fn a_take_fails_when_the_registered_process_changed() {
        let identity = identity_with("tm-moved", "pc-1");
        let offers = HandoffOffers::new();
        let now = Instant::now();
        assert!(offers.offer(&identity, "tm-moved", now));
        identity.unindex("pc-1");
        identity.index("pc-2", Some("tm-moved"), "pc-2");
        assert_eq!(offers.take(&identity, "tm-moved", now), None, "pc-2 was never offered");
        assert!(offers.offers.is_empty(), "a stale offer is dropped by the take that found it stale");
    }

    #[test]
    fn a_take_fails_after_the_offered_process_is_gone() {
        let identity = identity_with("tm-moved", "pc-1");
        let offers = HandoffOffers::new();
        let now = Instant::now();
        assert!(offers.offer(&identity, "tm-moved", now));
        identity.unindex("pc-1");
        assert_eq!(offers.take(&identity, "tm-moved", now), None);
    }

    #[test]
    fn offers_for_different_leaves_are_independent() {
        let identity = identity_with("tm-a", "pc-a");
        identity.index("pc-b", Some("tm-b"), "pc-b");
        let offers = HandoffOffers::new();
        let now = Instant::now();
        assert!(offers.offer(&identity, "tm-a", now));
        assert!(offers.offer(&identity, "tm-b", now));
        assert_eq!(offers.take(&identity, "tm-b", now).as_deref(), Some("pc-b"));
        assert_eq!(offers.take(&identity, "tm-a", now).as_deref(), Some("pc-a"));
    }
}
