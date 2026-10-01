use super::*;
use crate::elevated_host::FrozenId;
use crate::state::types::{HostSessionClaim, HostSessionClaimState};
use futures::FutureExt;
use std::time::Duration;

const PRIMARY: HostChannel = HostChannel::Primary;
const OLD: HostChannel = HostChannel::Frozen(FrozenId(1));
const BOUND: Duration = Duration::from_secs(5);

fn table_with_hosts() -> HostTable {
    let table = HostTable::new();
    table.publish(PRIMARY, table.reserve_epoch());
    table.publish(OLD, table.reserve_epoch());
    table
}

fn is_lifecycle_busy(busy: &Busy) -> bool {
    busy.to_string().starts_with(LIFECYCLE_BUSY)
}

/// `quiesce` with nothing in flight completes without being polled twice.
fn quiesced_now(table: &HostTable, reason: QuiesceReason) -> Result<QuiesceGuard, Busy> {
    table
        .quiesce(reason, BOUND)
        .now_or_never()
        .expect("nothing is in flight, so the quiesce must not wait")
}

#[tokio::test]
async fn begin_fails_fast_when_quiescing() {
    let table = table_with_hosts();
    // A ticket in flight keeps the quiesce waiting, so the table is Quiescing
    // but not yet drained: the moment a waiting implementation would hang.
    let held = table.begin(PRIMARY).unwrap();
    let waiting = tokio::spawn({
        let table = table.clone();
        async move { table.quiesce(QuiesceReason::Offload, BOUND).await }
    });
    tokio::task::yield_now().await;
    assert!(!waiting.is_finished(), "the quiesce must be waiting for the held ticket");

    // `begin` is synchronous; it answers at once on both hosts.
    for channel in [PRIMARY, OLD] {
        let busy = table.begin(channel).err().expect("admission is closed");
        assert!(is_lifecycle_busy(&busy), "{busy}");
    }
    assert!(is_lifecycle_busy(&table.begin_adoption().err().unwrap()));
    drop(held);
    drop(waiting.await.unwrap().unwrap());
}

#[tokio::test]
async fn begin_fails_fast_when_draining() {
    let table = table_with_hosts();
    let drain = table.drain_host(OLD).expect("idle host drains");
    assert_eq!(table.begin(OLD).err(), Some(Busy::Host(OLD, Admission::Draining)));
    // Only the draining host is closed.
    drop(table.begin(PRIMARY).expect("another host is unaffected"));
    drop(drain);
    drop(table.begin(OLD).expect("an abandoned drain reopens the host"));
}

#[tokio::test]
async fn retired_host_stays_closed() {
    let table = table_with_hosts();
    table.drain_host(OLD).unwrap().retire();
    assert_eq!(table.admission(OLD), Some(Admission::Retired));
    assert_eq!(table.begin(OLD).err(), Some(Busy::Host(OLD, Admission::Retired)));
}

#[tokio::test]
async fn drain_host_is_refused_not_awaited_while_a_ticket_is_held() {
    let table = table_with_hosts();
    let held = table.begin(OLD).unwrap();
    assert_eq!(table.drain_host(OLD).err(), Some(DrainRefusal::InFlight));
    assert_eq!(table.admission(OLD), Some(Admission::Open), "a refused drain must not close the host");
    // A ticket on another host does not block this one.
    let other = table.begin(PRIMARY).unwrap();
    drop(held);
    assert!(table.drain_host(OLD).is_ok());
    drop(other);
}

#[tokio::test]
async fn quiesce_waits_for_inflight_then_reopens_on_guard_drop() {
    let table = table_with_hosts();
    let a = table.begin(PRIMARY).unwrap();
    let b = table.begin(OLD).unwrap();
    let mut quiesce = Box::pin(table.quiesce(QuiesceReason::Update, BOUND));
    assert!(quiesce.as_mut().now_or_never().is_none(), "two tickets are in flight");
    drop(a);
    assert!(quiesce.as_mut().now_or_never().is_none(), "one ticket is still in flight");
    drop(b);
    let guard = quiesce.await.unwrap();
    assert!(guard.drained());
    assert!(guard.holders().is_empty());

    assert!(is_lifecycle_busy(&table.begin(PRIMARY).err().unwrap()), "closed while the guard is held");
    drop(guard);
    drop(table.begin(PRIMARY).expect("the guard's drop reopens a Quiescing table"));
    drop(table.begin_adoption().expect("adoption reopens too"));
}

#[tokio::test(start_paused = true)]
async fn quiesce_timeout_names_the_holders_and_a_released_guard_reopens() {
    let table = table_with_hosts();
    let _held = table.begin(OLD).unwrap();
    let _adopting = table.begin_adoption().unwrap();
    let guard = table.quiesce(QuiesceReason::Offload, Duration::from_secs(3)).await.unwrap();
    assert!(!guard.drained(), "a ticket outlived the bound");
    let mut holders = guard.holders().to_vec();
    holders.sort_by_key(|(channel, _)| channel.is_some());
    assert_eq!(holders, vec![(None, 1), (Some(OLD), 1)]);
    // Offload and update release and refuse on timeout: admission must come back.
    drop(guard);
    drop(table.begin(PRIMARY).expect("releasing the timed-out guard reopens the table"));
}

#[tokio::test]
async fn offload_and_update_quiesce_are_mutually_exclusive() {
    let table = table_with_hosts();
    let offload = quiesced_now(&table, QuiesceReason::Offload).unwrap();
    assert!(is_lifecycle_busy(&quiesced_now(&table, QuiesceReason::Update).err().unwrap()));
    assert!(is_lifecycle_busy(&quiesced_now(&table, QuiesceReason::Offload).err().unwrap()));
    drop(offload);

    let update = quiesced_now(&table, QuiesceReason::Update).unwrap();
    assert!(is_lifecycle_busy(&quiesced_now(&table, QuiesceReason::Offload).err().unwrap()));
    // The refused attempts did not release the update's hold.
    assert!(table.begin(PRIMARY).is_err());
    drop(update);
    drop(table.begin(PRIMARY).unwrap());
}

#[tokio::test]
async fn refusing_offload_during_exit_does_not_reopen_admission() {
    let table = table_with_hosts();
    let exit = quiesced_now(&table, QuiesceReason::Exit).unwrap();

    // The refused Offload (and Update) must not reopen anything when they go.
    let refused = quiesced_now(&table, QuiesceReason::Offload).err().expect("Exit holds");
    assert!(is_lifecycle_busy(&refused));
    assert!(quiesced_now(&table, QuiesceReason::Update).is_err());

    for channel in [PRIMARY, OLD] {
        assert!(is_lifecycle_busy(&table.begin(channel).err().unwrap()), "admission stays closed");
    }
    assert!(is_lifecycle_busy(&table.begin_adoption().err().unwrap()));

    // Not even Exit's own guard reopens it: the process is ending.
    drop(exit);
    assert_eq!(table.lifecycle(), Lifecycle::Exiting);
    assert!(table.begin(PRIMARY).is_err());
    assert!(quiesced_now(&table, QuiesceReason::Offload).is_err());
}

#[tokio::test]
async fn exit_taking_over_an_offload_quiesce_is_not_undone_by_the_offload_guard() {
    let table = table_with_hosts();
    let offload = quiesced_now(&table, QuiesceReason::Offload).unwrap();
    let exit = quiesced_now(&table, QuiesceReason::Exit).unwrap();
    drop(offload);
    assert!(
        is_lifecycle_busy(&table.begin(PRIMARY).err().unwrap()),
        "the offload guard must not reopen a table Exit now holds"
    );
    drop(exit);
    assert!(table.begin(PRIMARY).is_err());
}

#[tokio::test]
async fn the_quiescer_can_still_connect_while_holding_the_quiesce() {
    let table = table_with_hosts();
    let exit = quiesced_now(&table, QuiesceReason::Exit).unwrap();
    assert!(table.begin_adoption().is_err(), "everyone else is refused");
    let ticket = table.begin_as_quiescer(&exit);
    assert_eq!(ticket.channel(), None);
    drop(ticket);
}

#[tokio::test]
async fn a_superseded_epoch_is_no_longer_current() {
    let table = HostTable::new();
    let first = table.reserve_epoch();
    assert!(!table.is_current(OLD, first), "nothing is published yet");
    table.publish(OLD, first);
    assert!(table.is_current(OLD, first));
    let second = table.reserve_epoch();
    table.publish(OLD, second);
    assert!(!table.is_current(OLD, first));
    assert!(table.is_current(OLD, second));
    assert!(!table.is_current(PRIMARY, second), "an epoch belongs to one channel");
}

#[tokio::test]
async fn republishing_keeps_tickets_of_the_old_connection_counted() {
    let table = table_with_hosts();
    let held = table.begin(OLD).unwrap();
    table.publish(OLD, table.reserve_epoch());
    assert_eq!(table.drain_host(OLD).err(), Some(DrainRefusal::InFlight));
    drop(held);
    assert!(table.drain_host(OLD).is_ok());
}

#[tokio::test]
async fn publishing_does_not_reopen_a_retired_host() {
    let table = table_with_hosts();
    let epoch = table.reserve_epoch();
    table.publish(OLD, epoch);
    table.drain_host(OLD).unwrap().retire();

    let later = table.reserve_epoch();
    assert!(!table.publish(OLD, later), "a retired host cannot be published again");
    assert_eq!(table.admission(OLD), Some(Admission::Retired));
    assert!(matches!(table.begin(OLD), Err(Busy::Host(OLD, Admission::Retired))));
    assert!(table.is_current(OLD, epoch), "and its epoch is untouched");
    assert!(!table.is_current(OLD, later));
}

#[tokio::test]
async fn publishing_during_a_drain_leaves_the_drain_in_charge() {
    let table = table_with_hosts();
    let epoch = table.reserve_epoch();
    table.publish(OLD, epoch);
    let drain = table.drain_host(OLD).unwrap();

    assert!(!table.publish(OLD, table.reserve_epoch()));
    assert_eq!(table.admission(OLD), Some(Admission::Draining), "still closed while the drain is decided");

    drop(drain);
    assert_eq!(table.admission(OLD), Some(Admission::Open), "the drain's guard still reopens its own host");
    assert!(table.publish(OLD, table.reserve_epoch()), "an open host publishes as before");
}

// ---- claims ---------------------------------------------------------------

fn reserved(pid: u32, channel: HostChannel) -> HostSessionClaim {
    HostSessionClaim { state: HostSessionClaimState::Reserved, pid, process_id: None, channel }
}

#[tokio::test]
async fn ticket_drop_releases_claim() {
    let table = table_with_hosts();
    let claims: Arc<DashMap<String, HostSessionClaim>> = Arc::new(DashMap::new());

    // A fresh claim the operation never finished is removed.
    {
        let mut ticket = table.begin(PRIMARY).unwrap();
        let claimed = host_registry::claim_registration(&claims, "fresh", PRIMARY).unwrap();
        ticket.guard_claim(&claims, "fresh", claimed);
        assert!(claims.contains_key("fresh"));
    }
    assert!(!claims.contains_key("fresh"), "a dropped ticket must not leave a session claimed");

    // A taken-over Reserved claim is put back, pid and host intact, so the
    // retry that follows can claim it again.
    claims.insert("held".into(), reserved(77, OLD));
    {
        let mut ticket = table.begin(OLD).unwrap();
        let claimed = host_registry::claim_registration(&claims, "held", OLD).unwrap();
        assert_eq!(claimed, Some((77, OLD)));
        ticket.guard_claim(&claims, "held", claimed);
        assert_eq!(claims.get("held").unwrap().state, HostSessionClaimState::RegistrationInProgress);
    }
    let restored = claims.get("held").expect("the reservation must survive a failed attach");
    assert_eq!((restored.state.clone(), restored.pid, restored.channel), (HostSessionClaimState::Reserved, 77, OLD));
    drop(restored);
    assert_eq!(
        host_registry::claim_registration(&claims, "held", OLD).unwrap(),
        Some((77, OLD)),
        "a retry can claim it again"
    );

    // A claim that reached Registered is the operation's result, not debris.
    claims.clear();
    {
        let mut ticket = table.begin(PRIMARY).unwrap();
        let claimed = host_registry::claim_registration(&claims, "done", PRIMARY).unwrap();
        ticket.guard_claim(&claims, "done", claimed);
        let mut claim = claims.get_mut("done").unwrap();
        claim.state = HostSessionClaimState::Registered;
        claim.process_id = Some("pc-1".into());
    }
    assert_eq!(claims.get("done").unwrap().state, HostSessionClaimState::Registered);
}

#[tokio::test]
async fn ticket_drop_also_returns_the_slot() {
    let table = table_with_hosts();
    let mut ticket = table.begin(PRIMARY).unwrap();
    let claims: Arc<DashMap<String, HostSessionClaim>> = Arc::new(DashMap::new());
    let claimed = host_registry::claim_registration(&claims, "k", PRIMARY).unwrap();
    ticket.guard_claim(&claims, "k", claimed);
    let mut quiesce = Box::pin(table.quiesce(QuiesceReason::Update, BOUND));
    assert!(quiesce.as_mut().now_or_never().is_none());
    drop(ticket);
    assert!(quiesce.await.unwrap().drained(), "dropping the ticket is what wakes a waiting quiesce");
}

#[test]
fn lifecycle_busy_text_starts_with_the_retryable_prefix() {
    for reason in [QuiesceReason::Exit, QuiesceReason::Offload, QuiesceReason::Update] {
        assert!(Busy::Lifecycle(reason).to_string().starts_with("LIFECYCLE_BUSY"));
    }
    assert!(!Busy::NoSuchHost(OLD).to_string().starts_with(LIFECYCLE_BUSY));
}

// ---- retirement ------------------------------------------------------------

#[tokio::test]
async fn a_drained_host_retires_while_the_table_is_open() {
    let table = table_with_hosts();
    assert!(table.drain_host(OLD).unwrap().retire_when_open());
    assert_eq!(table.admission(OLD), Some(Admission::Retired));
    assert_eq!(table.begin(OLD).err(), Some(Busy::Host(OLD, Admission::Retired)));
}

/// Exit, offload and update each take the hosts over: a retirement that was about
/// to commit finds the table closed and leaves the host to them, open again, so
/// the lifecycle change sees exactly the hosts it expected.
#[tokio::test]
async fn retirement_is_refused_once_a_lifecycle_change_took_the_table() {
    for reason in [QuiesceReason::Exit, QuiesceReason::Offload, QuiesceReason::Update] {
        let table = table_with_hosts();
        let drain = table.drain_host(OLD).unwrap();
        let _guard = quiesced_now(&table, reason).unwrap();

        assert!(!drain.retire_when_open(), "{reason:?}");
        assert_eq!(table.admission(OLD), Some(Admission::Open), "{reason:?}: the host is back as it was");
        assert!(is_lifecycle_busy(&table.begin(OLD).err().unwrap()), "{reason:?}: and still closed by the lifecycle change");
    }
}

#[tokio::test]
async fn a_host_has_one_ticker_and_its_handle_gives_the_place_back() {
    let table = table_with_hosts();
    let first = table.start_ticker(OLD).expect("the first ticker");
    assert!(table.start_ticker(OLD).is_none(), "one per host");
    assert!(table.start_ticker(PRIMARY).is_some(), "another host has its own");
    // A reconnect replaces the connection, not the ticker.
    table.publish(OLD, table.reserve_epoch());
    assert!(table.start_ticker(OLD).is_none());
    drop(first);
    assert!(table.start_ticker(OLD).is_some(), "a ticker that ended can be started again");
}

#[tokio::test]
async fn no_ticker_is_started_for_a_host_that_is_closing_or_unknown() {
    let table = table_with_hosts();
    assert!(table.start_ticker(HostChannel::Frozen(FrozenId(9))).is_none());
    let drain = table.drain_host(OLD).unwrap();
    assert!(table.start_ticker(OLD).is_none());
    drop(drain);
    assert!(table.start_ticker(OLD).is_some());
}

#[tokio::test]
async fn a_nudge_reaches_only_the_ticker_of_that_host_and_is_remembered() {
    let table = table_with_hosts();
    let old = table.start_ticker(OLD).unwrap();
    let primary = table.start_ticker(PRIMARY).unwrap();

    // Nudged while the ticker is busy: the next wait ends at once.
    table.nudge_ticker(OLD);
    old.nudged().now_or_never().expect("a nudge made while nobody waited is not lost");
    assert!(old.nudged().now_or_never().is_none(), "and is spent by it");
    assert!(primary.nudged().now_or_never().is_none(), "the other host's ticker was not woken");
    // No ticker, no effect.
    table.nudge_ticker(HostChannel::Frozen(FrozenId(9)));
}

#[tokio::test]
async fn inflight_counts_the_tickets_of_that_host_only() {
    let table = table_with_hosts();
    assert_eq!(table.inflight(OLD), 0);
    let held = table.begin(OLD).unwrap();
    let other = table.begin(PRIMARY).unwrap();
    assert_eq!((table.inflight(OLD), table.inflight(PRIMARY)), (1, 1));
    drop(held);
    assert_eq!((table.inflight(OLD), table.inflight(PRIMARY)), (0, 1));
    drop(other);
    assert_eq!(table.inflight(HostChannel::Frozen(FrozenId(9))), 0);
}
