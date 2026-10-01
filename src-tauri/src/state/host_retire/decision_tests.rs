//! The pure part of retirement: what is enough to retire a host, and how emptiness
//! is counted. Every case differs from the retirable baseline in the one fact it
//! is about, so a verdict that ignores that fact fails its own case.

use super::*;

fn retirable() -> RetireFacts {
    RetireFacts {
        frozen: true,
        current_usable: true,
        sample: Sample::Answered { alive: 0 },
        panes: 0,
        unfinished_claims: 0,
        ticket_in_flight: false,
        empty_for: EMPTY_FOR,
    }
}

#[test]
fn the_baseline_is_retired() {
    assert_eq!(retire_decision(&retirable()), Verdict::Retire);
}

#[test]
fn never_with_live_session() {
    let facts = RetireFacts { sample: Sample::Answered { alive: 1 }, ..retirable() };
    assert_eq!(retire_decision(&facts), Verdict::Keep(Keep::LiveSession));
}

#[test]
fn current_unavailable() {
    // Older hosts are where new terminals go while the current one is down.
    let facts = RetireFacts { current_usable: false, ..retirable() };
    assert_eq!(retire_decision(&facts), Verdict::Keep(Keep::CurrentUnavailable));
    assert!(!observation_is_empty(Sample::Answered { alive: 0 }, 0, 0, false), "and the clock does not run");
}

#[test]
fn reserved_claim() {
    let facts = RetireFacts { unfinished_claims: 1, ..retirable() };
    assert_eq!(retire_decision(&facts), Verdict::Keep(Keep::ClaimHeld));
}

#[test]
fn a_registered_pane_keeps_the_host_even_when_the_listing_is_empty() {
    // The listing may have been built before the pane's session was created.
    let facts = RetireFacts { panes: 1, ..retirable() };
    assert_eq!(retire_decision(&facts), Verdict::Keep(Keep::PaneRegistered));
}

#[test]
fn in_flight_ticket() {
    let facts = RetireFacts { ticket_in_flight: true, ..retirable() };
    assert_eq!(retire_decision(&facts), Verdict::Keep(Keep::TicketInFlight));
}

#[test]
fn role_not_frozen() {
    let facts = RetireFacts { frozen: false, ..retirable() };
    assert_eq!(retire_decision(&facts), Verdict::Keep(Keep::NotFrozen));
}

#[test]
fn an_unanswered_sample_is_never_empty() {
    let facts = RetireFacts { sample: Sample::Unanswered, ..retirable() };
    assert_eq!(retire_decision(&facts), Verdict::Keep(Keep::Unanswered));
    assert!(!observation_is_empty(Sample::Unanswered, 0, 0, true));
}

#[test]
fn emptiness_must_last_the_whole_period() {
    let just_short = RetireFacts { empty_for: EMPTY_FOR - Duration::from_millis(1), ..retirable() };
    assert_eq!(retire_decision(&just_short), Verdict::Keep(Keep::NotEmptyLongEnough));
    let none_yet = RetireFacts { empty_for: Duration::ZERO, ..retirable() };
    assert_eq!(retire_decision(&none_yet), Verdict::Keep(Keep::NotEmptyLongEnough));
}

#[test]
fn only_a_quiet_answered_listing_counts_as_empty() {
    let answered = Sample::Answered { alive: 0 };
    assert!(observation_is_empty(answered, 0, 0, true));
    assert!(!observation_is_empty(Sample::Answered { alive: 1 }, 0, 0, true));
    assert!(!observation_is_empty(answered, 1, 0, true));
    assert!(!observation_is_empty(answered, 0, 1, true));
}

#[test]
fn unanswered_sample_resets_emptiness() {
    let start = Instant::now();
    let at = |secs: u64| start + Duration::from_secs(secs);
    let mut emptiness = Emptiness::default();

    assert_eq!(emptiness.observe(at(0), true), Duration::ZERO);
    assert_eq!(emptiness.observe(at(5), true), Duration::from_secs(5));
    // The host stops answering. The five seconds already seen do not carry over,
    // and neither does the time it was silent.
    assert_eq!(emptiness.observe(at(10), observation_is_empty(Sample::Unanswered, 0, 0, true)), Duration::ZERO);
    assert_eq!(emptiness.observe(at(15), true), Duration::ZERO, "the clock starts again at the first answer");
    assert_eq!(emptiness.observe(at(20), true), Duration::from_secs(5));
    assert_eq!(emptiness.observe(at(25), true), Duration::from_secs(10));
}

#[test]
fn a_session_appearing_restarts_the_clock() {
    let start = Instant::now();
    let at = |secs: u64| start + Duration::from_secs(secs);
    let mut emptiness = Emptiness::default();
    emptiness.observe(at(0), true);
    emptiness.observe(at(5), observation_is_empty(Sample::Answered { alive: 1 }, 0, 0, true));
    assert_eq!(emptiness.observe(at(10), true), Duration::ZERO);
}

#[test]
fn reset_forgets_the_clock() {
    let start = Instant::now();
    let mut emptiness = Emptiness::default();
    emptiness.observe(start, true);
    emptiness.reset();
    assert_eq!(emptiness.observe(start + Duration::from_secs(9), true), Duration::ZERO);
}
