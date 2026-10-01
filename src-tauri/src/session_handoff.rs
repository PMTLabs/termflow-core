//! Single-use hand-off of a just-created shell from the window that created it to
//! the window the pane moved to.
//!
//! A pane can move to another window while its first create is still in flight.
//! Both windows then ask for the same session; one create wins and registers the
//! terminal, the other is refused. If the winner is the window the pane left, it
//! binds nothing and OFFERS the process here once its create returns. The window
//! that has the pane takes it, at most once.
//!
//! The refusal comes at claim time but the offer only after the winner's host
//! request (an attach or a spawn, bounded at ten seconds) has finished, so the
//! refused window cannot assume the offer is already there. [`HandoffOffers::take`]
//! therefore answers with three states: the process (`Taken`), "a create for this
//! leaf is still running, ask again" (`InFlight`), or nothing (`NoOffer`). A
//! create is marked in flight from the moment it holds the session's claim until
//! `spawn_routed` returns; the claim itself cannot say this, because it is
//! `Registered` as soon as the terminal is indexed, before the slow host request.
//!
//! An offer is deliberately explicit. Looking the process up by leaf and binding
//! whatever is registered would also take over a shell another window is still
//! showing (a saved layout loaded while one of its tabs lives in a detached
//! window), leaving two windows typing into one shell. For the same reason an
//! offer names the process it hands over and is refused unless that is the
//! process registered for the leaf.
//!
//! Known limits. The hand-off knows nothing about which window shows a leaf, so a
//! live shell can end up registered with no pane until the app restarts (when it
//! is surfaced as a recovered terminal) if:
//! - the pane is closed in a window other than the one that issued the create,
//!   e.g. it is moved and then closed at the destination while the source's
//!   create is still running;
//! - the destination gives up before the offer arrives (a create that outlasts its
//!   wait) and the user then closes its failed pane;
//! - the offer call itself fails;
//! - the leaf is present in two windows at once (a moved pane for an instant, or
//!   a saved layout loaded while one of its tabs lives in another window).
//!
//! A later change makes the backend own which window holds each shell, which
//! closes these.
//!
//! Lives in its own file, like `identity_index`, so it is testable without an
//! `AppHandle`.

use crate::identity_index::IdentityIndex;
use dashmap::DashMap;
use serde::Serialize;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// How long an offer stays takeable. Long enough for a moved pane that mounts
/// late (a new window still booting) to ask after the source's offer; short
/// enough that a forgotten offer cannot hand a shell to an unrelated later pane.
const OFFER_TTL: Duration = Duration::from_secs(60);

/// The answer to a take.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status")]
pub enum HandoffTake {
    /// The offered terminal; the offer is spent.
    #[serde(rename = "taken", rename_all = "camelCase")]
    Taken { process_id: String },
    /// Nothing is on offer yet, but a create for this leaf is still running and
    /// may offer when it returns.
    #[serde(rename = "inFlight")]
    InFlight,
    /// Nothing is on offer and no create for this leaf is running.
    #[serde(rename = "none")]
    NoOffer,
}

#[derive(Clone, Default)]
pub struct HandoffOffers {
    /// leaf -> (offered process id, when it was offered)
    offers: Arc<DashMap<String, (String, Instant)>>,
    /// leaf -> number of creates currently running for it
    creating: Arc<DashMap<String, u32>>,
}

/// Marks a create for a leaf as running until dropped.
pub struct CreateInFlight {
    creating: Arc<DashMap<String, u32>>,
    leaf: String,
}

impl Drop for CreateInFlight {
    fn drop(&mut self) {
        use dashmap::mapref::entry::Entry;
        if let Entry::Occupied(mut o) = self.creating.entry(self.leaf.clone()) {
            if *o.get() > 1 {
                *o.get_mut() -= 1;
            } else {
                o.remove();
            }
        }
    }
}

impl HandoffOffers {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record that a create for `leaf` holds its session and has not returned. Call
    /// it only once the session's claim is held: a refused create must not mark
    /// itself, or it would read its own mark as a winner still running.
    pub fn begin_create(&self, leaf: &str) -> CreateInFlight {
        *self.creating.entry(leaf.to_string()).or_insert(0) += 1;
        CreateInFlight { creating: self.creating.clone(), leaf: leaf.to_string() }
    }

    /// Offer `process_id`, the terminal the caller's create produced for `leaf`.
    /// Refused (`false`, nothing recorded) unless it is the terminal registered
    /// for the leaf: an offer for an absent process could never be honoured, and
    /// one for a process the caller did not create would make a shell another
    /// window shows takeable.
    pub fn offer(&self, identity: &IdentityIndex, leaf: &str, process_id: &str, now: Instant) -> bool {
        self.reap_expired(now);
        if identity.process_for_leaf(leaf).as_deref() != Some(process_id) {
            return false;
        }
        self.offers.insert(leaf.to_string(), (process_id.to_string(), now));
        true
    }

    /// Take the offer for `leaf`, removing it in the same step so only one caller
    /// can ever get it. Without a live offer (none made, it expired, or the
    /// terminal registered for the leaf is no longer the one that was offered) the
    /// answer says whether a create for the leaf is still running.
    pub fn take(&self, identity: &IdentityIndex, leaf: &str, now: Instant) -> HandoffTake {
        self.reap_expired(now);
        if let Some((_, (process_id, _))) = self.offers.remove(leaf) {
            if identity.process_for_leaf(leaf).as_deref() == Some(process_id.as_str()) {
                return HandoffTake::Taken { process_id };
            }
        }
        if self.creating.contains_key(leaf) {
            HandoffTake::InFlight
        } else {
            HandoffTake::NoOffer
        }
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

    fn taken(process_id: &str) -> HandoffTake {
        HandoffTake::Taken { process_id: process_id.to_string() }
    }

    #[test]
    fn an_offer_is_taken_once() {
        let identity = identity_with("tm-moved", "pc-1");
        let offers = HandoffOffers::new();
        let now = Instant::now();
        assert!(offers.offer(&identity, "tm-moved", "pc-1", now));
        assert_eq!(offers.take(&identity, "tm-moved", now), taken("pc-1"));
        assert_eq!(offers.take(&identity, "tm-moved", now), HandoffTake::NoOffer, "a second adopter gets nothing");
    }

    #[test]
    fn concurrent_takers_share_one_offer() {
        let identity = identity_with("tm-moved", "pc-1");
        let offers = HandoffOffers::new();
        let now = Instant::now();
        assert!(offers.offer(&identity, "tm-moved", "pc-1", now));
        let winners = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..8)
                .map(|_| scope.spawn(|| offers.take(&identity, "tm-moved", now)))
                .collect();
            handles
                .into_iter()
                .map(|h| h.join().unwrap())
                .filter(|answer| matches!(answer, HandoffTake::Taken { .. }))
                .count()
        });
        assert_eq!(winners, 1);
    }

    #[test]
    fn an_offer_expires() {
        let identity = identity_with("tm-moved", "pc-1");
        let offers = HandoffOffers::new();
        let now = Instant::now();
        assert!(offers.offer(&identity, "tm-moved", "pc-1", now));
        assert_eq!(
            offers.take(&identity, "tm-moved", now + OFFER_TTL),
            HandoffTake::NoOffer,
            "an offer at its TTL is gone"
        );
        assert!(offers.offers.is_empty(), "an expired offer is not kept around");
    }

    #[test]
    fn an_offer_just_inside_its_ttl_is_still_takeable() {
        let identity = identity_with("tm-moved", "pc-1");
        let offers = HandoffOffers::new();
        let now = Instant::now();
        assert!(offers.offer(&identity, "tm-moved", "pc-1", now));
        let almost = now + OFFER_TTL - Duration::from_millis(1);
        assert_eq!(offers.take(&identity, "tm-moved", almost), taken("pc-1"));
    }

    #[test]
    fn a_leaf_with_no_registered_terminal_cannot_be_offered() {
        let identity = IdentityIndex::new();
        let offers = HandoffOffers::new();
        let now = Instant::now();
        assert!(!offers.offer(&identity, "tm-ghost", "pc-1", now));
        identity.index("pc-1", Some("tm-ghost"), "pc-1");
        assert_eq!(
            offers.take(&identity, "tm-ghost", now),
            HandoffTake::NoOffer,
            "the refused offer recorded nothing"
        );
    }

    #[test]
    fn a_process_the_leaf_does_not_hold_cannot_be_offered() {
        // pc-1 is what another window shows for the leaf; a caller that did not
        // create it names some other process, or the right one for another leaf.
        let identity = identity_with("tm-moved", "pc-1");
        identity.index("pc-2", Some("tm-other"), "pc-2");
        let offers = HandoffOffers::new();
        let now = Instant::now();
        assert!(!offers.offer(&identity, "tm-moved", "pc-2", now), "pc-2 belongs to another leaf");
        assert!(!offers.offer(&identity, "tm-moved", "pc-9", now), "pc-9 is registered nowhere");
        assert!(offers.offers.is_empty(), "a refused offer records nothing");
        assert_eq!(offers.take(&identity, "tm-moved", now), HandoffTake::NoOffer);
        assert!(offers.offer(&identity, "tm-moved", "pc-1", now), "the registered process is accepted");
    }

    #[test]
    fn a_take_fails_when_the_registered_process_changed() {
        let identity = identity_with("tm-moved", "pc-1");
        let offers = HandoffOffers::new();
        let now = Instant::now();
        assert!(offers.offer(&identity, "tm-moved", "pc-1", now));
        identity.unindex("pc-1");
        identity.index("pc-2", Some("tm-moved"), "pc-2");
        assert_eq!(offers.take(&identity, "tm-moved", now), HandoffTake::NoOffer, "pc-2 was never offered");
        assert!(offers.offers.is_empty(), "a stale offer is dropped by the take that found it stale");
    }

    #[test]
    fn a_take_fails_after_the_offered_process_is_gone() {
        let identity = identity_with("tm-moved", "pc-1");
        let offers = HandoffOffers::new();
        let now = Instant::now();
        assert!(offers.offer(&identity, "tm-moved", "pc-1", now));
        identity.unindex("pc-1");
        assert_eq!(offers.take(&identity, "tm-moved", now), HandoffTake::NoOffer);
    }

    #[test]
    fn offers_for_different_leaves_are_independent() {
        let identity = identity_with("tm-a", "pc-a");
        identity.index("pc-b", Some("tm-b"), "pc-b");
        let offers = HandoffOffers::new();
        let now = Instant::now();
        assert!(offers.offer(&identity, "tm-a", "pc-a", now));
        assert!(offers.offer(&identity, "tm-b", "pc-b", now));
        assert_eq!(offers.take(&identity, "tm-b", now), taken("pc-b"));
        assert_eq!(offers.take(&identity, "tm-a", now), taken("pc-a"));
    }

    #[test]
    fn a_running_create_answers_in_flight_until_it_returns() {
        // The winner holds the claim and is registered (so the leaf resolves) but
        // has not offered: the take must say "ask again", not "nothing".
        let identity = identity_with("tm-moved", "pc-1");
        let offers = HandoffOffers::new();
        let now = Instant::now();
        assert_eq!(offers.take(&identity, "tm-moved", now), HandoffTake::NoOffer, "nothing is running yet");
        let create = offers.begin_create("tm-moved");
        assert_eq!(offers.take(&identity, "tm-moved", now), HandoffTake::InFlight);
        assert_eq!(
            offers.take(&identity, "tm-moved", now + Duration::from_secs(9)),
            HandoffTake::InFlight,
            "a slow host request does not end the wait by itself"
        );
        assert_eq!(offers.take(&identity, "tm-other", now), HandoffTake::NoOffer, "only that leaf's create counts");
        drop(create);
        assert_eq!(offers.take(&identity, "tm-moved", now), HandoffTake::NoOffer);
    }

    #[test]
    fn an_offer_wins_over_a_create_still_marked_running() {
        // The source offers while its create is still unwinding.
        let identity = identity_with("tm-moved", "pc-1");
        let offers = HandoffOffers::new();
        let now = Instant::now();
        let _create = offers.begin_create("tm-moved");
        assert!(offers.offer(&identity, "tm-moved", "pc-1", now));
        assert_eq!(offers.take(&identity, "tm-moved", now), taken("pc-1"));
        assert_eq!(offers.take(&identity, "tm-moved", now), HandoffTake::InFlight, "the offer is spent");
    }

    #[test]
    fn a_stale_offer_does_not_hide_a_running_create() {
        let identity = identity_with("tm-moved", "pc-1");
        let offers = HandoffOffers::new();
        let now = Instant::now();
        assert!(offers.offer(&identity, "tm-moved", "pc-1", now));
        identity.unindex("pc-1");
        identity.index("pc-2", Some("tm-moved"), "pc-2");
        let _create = offers.begin_create("tm-moved");
        assert_eq!(offers.take(&identity, "tm-moved", now), HandoffTake::InFlight);
    }

    #[test]
    fn overlapping_creates_for_one_leaf_keep_it_in_flight_until_the_last_returns() {
        let identity = identity_with("tm-moved", "pc-1");
        let offers = HandoffOffers::new();
        let now = Instant::now();
        let first = offers.begin_create("tm-moved");
        let second = offers.begin_create("tm-moved");
        drop(first);
        assert_eq!(offers.take(&identity, "tm-moved", now), HandoffTake::InFlight);
        drop(second);
        assert_eq!(offers.take(&identity, "tm-moved", now), HandoffTake::NoOffer);
        assert!(offers.creating.is_empty(), "no marks are left behind");
    }

    #[test]
    fn the_answers_reach_the_renderer_in_the_shape_it_reads() {
        let json = |take: &HandoffTake| serde_json::to_value(take).unwrap();
        assert_eq!(json(&taken("pc-1")), serde_json::json!({ "status": "taken", "processId": "pc-1" }));
        assert_eq!(json(&HandoffTake::InFlight), serde_json::json!({ "status": "inFlight" }));
        assert_eq!(json(&HandoffTake::NoOffer), serde_json::json!({ "status": "none" }));
    }
}
