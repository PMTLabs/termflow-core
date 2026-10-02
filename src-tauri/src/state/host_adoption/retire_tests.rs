//! Retiring an emptied older host over fake hosts, on the paused clock. Every
//! assertion names the host that received a frame: "a Shutdown was sent" is true
//! of an implementation that retires the wrong host, or one that retires a host
//! that was not empty.

use super::fake_hosts::*;
use super::reconnect::FrozenReconnect;
use super::*;
use crate::state::host_lifecycle::exit_hosts;
use crate::state::host_retire::{start_ticker, EMPTY_FOR, TICK};
use crate::state::host_routing::{place, Placement, HOST_OWNERSHIP_PENDING};
use crate::state::host_table::{Admission, QuiesceReason};
use crate::state::source_scan::{fn_body, production};
use crate::state::host_keys::KeyKind;
use std::sync::atomic::Ordering;

const CURRENT: &str = "cur";

fn secs(n: u64) -> Duration {
    Duration::from_secs(n)
}

fn millis(n: u64) -> Duration {
    Duration::from_millis(n)
}

fn holding(keys: &[(&str, u32)]) -> HostSpec {
    HostSpec { sessions: keys.iter().map(|(k, pid)| meta(k, *pid)).collect(), ..HostSpec::default() }
}

/// The current host plus these older ones, all discovered.
fn machine(old: &[(&str, HostSpec)]) -> (Arc<World>, FakePort) {
    let world = World::new();
    world.add_host(CURRENT, HostSpec::default());
    let mut candidates = Vec::new();
    for (name, spec) in old {
        world.add_host(name, spec.clone());
        candidates.push(candidate(name, HostRole::Frozen));
    }
    candidates.push(candidate(CURRENT, HostRole::Current));
    let port = FakePort::new(&world, CURRENT);
    port.set_candidates(candidates);
    (world, port)
}

/// Every host adopted, as after start-up, and then the older ones watched for
/// emptiness, with the current host already up (the older ones are adopted beside
/// it, so a look made while that is still going on would not see it). Their
/// clients announce an exit, as a real host's capabilities make them.
async fn retiring(old: &[(&str, HostSpec)]) -> (Arc<World>, FakePort) {
    let (world, port) = machine(old);
    rediscover_hosts(&port).await.unwrap();
    port.enable_retirement();
    for host in port.frozen_hosts() {
        host.client.set_shutdown_control(true);
        start_ticker(&port, host.id);
    }
    (world, port)
}

fn channel_of(port: &FakePort, endpoint: &str) -> HostChannel {
    HostChannel::Frozen(port.frozen_hosts().iter().find(|h| h.endpoint == endpoint).expect("registered").id)
}

fn frozen_id(port: &FakePort, endpoint: &str) -> FrozenId {
    match channel_of(port, endpoint) {
        HostChannel::Frozen(id) => id,
        other => unreachable!("{other:?}"),
    }
}

fn registered_endpoints(port: &FakePort) -> Vec<String> {
    port.frozen_hosts().into_iter().map(|h| h.endpoint).collect()
}

/// When `host` received its first `kind` frame, as a distance from `since`.
fn first_after(world: &World, host: &str, kind: &str, since: Instant) -> Option<Duration> {
    world.first_at(host, kind).map(|at| at.duration_since(since))
}

fn claim_state(port: &FakePort, key: &str) -> Option<KeyKind> {
    port.table().keys().snapshot(key).map(|c| c.state)
}

// ---- when a host is retired ---------------------------------------------------

/// A session listed at adoption and reserved for a pane that never comes ends by
/// itself: no pane exists, so `on_exit` never runs. Only the ticker can notice.
#[tokio::test(start_paused = true)]
async fn unregistered_orphan_exit_retires_within_15s_via_ticker() {
    let (world, port) = retiring(&[("h1", holding(&[("k1", 11)])), ("h2", holding(&[("k2", 22)]))]).await;
    let h1 = channel_of(&port, "h1");
    assert_eq!(claim_state(&port, "k1"), Some(KeyKind::Listed), "the adoption reserved it");
    let current_frames = world.kinds(CURRENT).len();

    tokio::time::sleep(secs(1)).await;
    world.end_session("h1", "k1");
    let ended = Instant::now();

    tokio::time::sleep(secs(9)).await;
    assert_eq!(world.count("h1", "Shutdown"), 0, "ten seconds of emptiness have not been seen yet");
    tokio::time::sleep(secs(7)).await;

    let at = first_after(&world, "h1", "Shutdown", ended).expect("the emptied host is shut down");
    assert!(at >= EMPTY_FOR, "retired after {at:?}: before ten continuous seconds of emptiness");
    assert!(at <= secs(15), "retired {at:?} after its last session ended; the limit is 15 s");
    let kinds = world.kinds("h1");
    assert_eq!(
        &kinds[kinds.len() - 4..],
        ["List", "List", "Shutdown", "Eof"],
        "the look that found it empty, the one more look under the closure, then the shutdown, then the stream closed"
    );
    assert_eq!(port.0.table.admission(h1), Some(Admission::Retired));
    assert_eq!(registered_endpoints(&port), ["h2"], "only h1 left the registry");
    assert_eq!(claim_state(&port, "k1"), None, "the moot claim was dropped");
    assert!(port.barrier().unresolved().is_empty());

    // Nothing else was touched: not the other older host, not the current one.
    for other in ["h2", CURRENT] {
        assert_eq!(world.count(other, "Shutdown"), 0, "{other}");
        assert_eq!(world.count(other, "Eof"), 0, "{other}");
    }
    assert_eq!(world.kinds(CURRENT).len(), current_frames, "the current host is never sampled");
}

#[tokio::test(start_paused = true)]
async fn host_adopted_empty_is_retired_ten_seconds_after_adoption() {
    let (world, port) = retiring(&[("h1", HostSpec::default()), ("h2", holding(&[("k2", 22)]))]).await;
    let adopted = Instant::now();

    tokio::time::sleep(secs(9)).await;
    assert_eq!(world.count("h1", "Shutdown"), 0);
    tokio::time::sleep(secs(5)).await;

    // Looks at 0, 5 and 10 s: the first is at once, so ten seconds of emptiness have
    // been seen by the third, not the fourth.
    let at = first_after(&world, "h1", "Shutdown", adopted).expect("retired");
    assert!(at >= EMPTY_FOR && at <= EMPTY_FOR + secs(1), "retired {at:?} after adoption");
    assert_eq!(world.count("h2", "Shutdown"), 0, "a host with a live session stays");
    assert_eq!(registered_endpoints(&port), ["h2"]);
}

/// Adopting an older host is what starts its ticker: nothing else is told about it.
#[tokio::test(start_paused = true)]
async fn adoption_alone_starts_the_ticker_that_retires_an_empty_host() {
    let (world, port) = machine(&[("h1", HostSpec::default()), ("h2", holding(&[("k2", 22)]))]);
    port.enable_retirement();
    rediscover_hosts(&port).await.unwrap();
    for host in port.frozen_hosts() {
        host.client.set_shutdown_control(true);
    }
    let adopted = Instant::now();

    tokio::time::sleep(secs(30)).await;
    let at = first_after(&world, "h1", "Shutdown", adopted).expect("retired, though nobody started a ticker but adoption");
    assert!(at >= EMPTY_FOR && at <= EMPTY_FOR + TICK + secs(1), "{at:?}");
    assert_eq!(world.count("h2", "Shutdown"), 0);
}

/// The session is gone, or listed dead, by the time anyone asks: nothing is
/// running there, so the claim that was held for it must not keep the host.
#[tokio::test(start_paused = true)]
async fn listed_alive_exit_before_create_then_answered_dead_retires() {
    for listed_dead in [false, true] {
        let (world, port) = retiring(&[("h1", holding(&[("k1", 11)])), ("h2", holding(&[("k2", 22)]))]).await;
        assert_eq!(claim_state(&port, "k1"), Some(KeyKind::Listed), "listed alive at adoption");

        tokio::time::sleep(secs(1)).await;
        if listed_dead {
            world.end_session_listed_dead("h1", "k1");
        } else {
            world.end_session("h1", "k1");
        }
        tokio::time::sleep(secs(20)).await;

        assert_eq!(world.count("h1", "Shutdown"), 1, "listed_dead={listed_dead}");
        assert_eq!(claim_state(&port, "k1"), None, "listed_dead={listed_dead}");
        assert_eq!(world.count("h1", "Close"), 0, "nothing was closed: the session had ended by itself");
        assert_eq!(world.count("h2", "Shutdown"), 0);
    }
}

#[tokio::test(start_paused = true)]
async fn a_live_session_keeps_its_host_and_its_claim() {
    let (world, port) = retiring(&[("h1", holding(&[("k1", 11)]))]).await;
    tokio::time::sleep(secs(60)).await;

    for kind in ["Shutdown", "Eof", "Close"] {
        assert_eq!(world.count("h1", kind), 0, "{kind}");
    }
    assert_eq!(claim_state(&port, "k1"), Some(KeyKind::Listed));
    assert_eq!(registered_endpoints(&port), ["h1"]);
    assert!(world.count("h1", "List") >= 10, "it is looked at every tick, never given up on");
}

/// A claim a create is taking over right now is not moot, however the listing
/// looks, and neither is the host while that create holds its ticket.
#[tokio::test(start_paused = true)]
async fn a_claim_being_registered_is_kept_and_a_returned_one_is_dropped() {
    let (world, port) = retiring(&[("h1", holding(&[("k1", 11)]))]).await;
    let h1 = channel_of(&port, "h1");
    let held = place(&port, "k1", false).await.unwrap();
    assert!(matches!(held, Placement::Attach { channel, .. } if channel == h1));
    assert_eq!(claim_state(&port, "k1"), Some(KeyKind::Held));

    world.end_session("h1", "k1");
    tokio::time::sleep(secs(40)).await;
    assert_eq!(world.count("h1", "Shutdown"), 0, "the create is still holding the host");
    assert_eq!(claim_state(&port, "k1"), Some(KeyKind::Held));

    // The create gives up: its claim goes back, the next answered listing shows
    // the session gone, and the host retires.
    drop(held);
    assert_eq!(claim_state(&port, "k1"), Some(KeyKind::Listed));
    tokio::time::sleep(secs(20)).await;
    assert_eq!(claim_state(&port, "k1"), None);
    assert_eq!(world.count("h1", "Shutdown"), 1);
}

#[tokio::test(start_paused = true)]
async fn a_registered_pane_keeps_the_host_even_when_the_host_lists_nothing() {
    let (world, port) = retiring(&[("h1", HostSpec::default())]).await;
    let h1 = channel_of(&port, "h1");
    port.register_terminal("pc-1", "k1", h1);
    tokio::time::sleep(secs(60)).await;
    assert_eq!(world.count("h1", "Shutdown"), 0);

    // The pane goes (its session ended) and the host follows.
    port.0.host_terminals.remove("pc-1");
    port.0.terminals.remove("pc-1");
    tokio::time::sleep(secs(20)).await;
    assert_eq!(world.count("h1", "Shutdown"), 1);
}

#[tokio::test(start_paused = true)]
async fn ticket_taken_before_drain_blocks_retire() {
    let (world, port) = retiring(&[("h1", HostSpec::default()), ("h2", HostSpec::default())]).await;
    let h1 = channel_of(&port, "h1");
    let ticket = port.0.table.begin(h1).expect("h1 admits");

    tokio::time::sleep(secs(40)).await;
    assert_eq!(world.count("h2", "Shutdown"), 1, "the host nobody is using is retired");
    assert_eq!(world.count("h1", "Shutdown"), 0, "an operation in flight holds h1");
    assert_eq!(port.0.table.admission(h1), Some(Admission::Open), "and it was not left closed");
    assert!(registered_endpoints(&port).contains(&"h1".to_string()));

    drop(ticket);
    tokio::time::sleep(secs(10)).await;
    assert_eq!(world.count("h1", "Shutdown"), 1);
    assert_eq!(world.count("h2", "Shutdown"), 1, "once each");
}

/// Once the drain has committed, nothing is placed on the host: a fresh create
/// goes to another target, and where there is none it runs in process.
#[tokio::test(start_paused = true)]
async fn drain_committed_before_begin_selects_other_target() {
    let (world, port) = machine(&[("h1", HostSpec::default())]);
    rediscover_hosts(&port).await.unwrap();
    let h1 = channel_of(&port, "h1");
    let drain = port.0.table.drain_host(h1).expect("an idle host drains");

    match place(&port, "tm-fresh", false).await.unwrap() {
        Placement::Spawn { channel, .. } => assert_eq!(channel, HostChannel::Primary),
        _ => panic!("the create had somewhere to go"),
    }

    // The current host is gone as well: the draining host is not a fallback.
    port.drop_current();
    world.set_unreachable(CURRENT, true);
    match place(&port, "tm-fresh-2", false).await.unwrap() {
        Placement::InProcess { .. } => {}
        _ => panic!("a draining host must not take a new session"),
    }
    drain.retire();
    match place(&port, "tm-fresh-3", false).await.unwrap() {
        Placement::InProcess { .. } => {}
        _ => panic!("nor may a retired one"),
    }
    assert_eq!(world.count("h1", "Spawn"), 0, "no session was ever started on h1");
}

/// A reconnect that was already on its way when the host was retired does
/// nothing: no connection, no frame, nobody torn down.
#[tokio::test(start_paused = true)]
async fn reconnect_task_spawned_before_retire_is_inert() {
    let (world, port) = retiring(&[("h1", HostSpec::default()), ("h2", holding(&[("k2", 22)]))]).await;
    let id = frozen_id(&port, "h1");
    let epoch = port.0.table.epoch(HostChannel::Frozen(id)).unwrap();
    let early = tokio::spawn({
        let port = port.clone();
        async move { reconnect_frozen(&port, id, epoch, &[500, 1000]).await }
    });

    tokio::time::sleep(secs(20)).await;
    assert_eq!(world.count("h1", "Shutdown"), 1);
    assert_eq!(early.await.unwrap(), FrozenReconnect::Inert);
    // Asked again after the retirement, with the connection that was retired.
    assert_eq!(reconnect_frozen(&port, id, epoch, &[500, 1000]).await, FrozenReconnect::Inert);

    assert_eq!(port.connect_count("h1"), 1, "h1 was connected once, at adoption, and never again");
    assert_eq!(port.0.disconnects.load(Ordering::SeqCst), 0, "closing on purpose is not a drop that would reconnect");
    assert!(port.0.torn_down.lock().unwrap().is_empty());
    assert_eq!(world.count("h2", "Shutdown"), 0);
}

#[tokio::test(start_paused = true)]
async fn a_retired_host_is_not_adopted_again_while_its_process_lingers() {
    let (world, port) = retiring(&[("h1", HostSpec::default()), ("h2", holding(&[("k2", 22)]))]).await;
    tokio::time::sleep(secs(20)).await;
    assert_eq!(world.count("h1", "Shutdown"), 1);
    let key = barrier_key("h1");
    assert!(port.barrier().is_retired(&key));

    // Discovery still finds the process for a moment: it is not adopted again.
    rediscover_hosts(&port).await.unwrap();
    assert_eq!(port.connect_count("h1"), 1);
    assert_eq!(registered_endpoints(&port), ["h2"]);
    assert!(port.barrier().unresolved().is_empty(), "a retired host holds no pane back");

    // Once it is gone from discovery the mark goes with it.
    port.set_candidates(vec![candidate("h2", HostRole::Frozen), candidate(CURRENT, HostRole::Current)]);
    rediscover_hosts(&port).await.unwrap();
    assert!(!port.barrier().is_retired(&key));
}

// ---- the final check under the closure -----------------------------------------

/// The final look is made with admission closed, and the host is retired only if
/// it still finds the host empty. Ten seconds of emptiness have been seen at the
/// third look; the last one then comes back unanswered, or with a session.
#[tokio::test(start_paused = true)]
async fn a_final_check_that_is_unanswered_keeps_the_host_and_reopens_it() {
    // Answers the adoption's listing and the looks at 0, 5 and 10 s, then nothing.
    let goes_quiet = HostSpec { list: ListBehavior::AnswerFirst(4), ..HostSpec::default() };
    let (world, port) = retiring(&[("h1", goes_quiet), ("h2", holding(&[("k2", 22)]))]).await;
    let h1 = channel_of(&port, "h1");

    tokio::time::sleep(secs(10) + millis(200)).await;
    assert_eq!(port.0.table.admission(h1), Some(Admission::Draining), "the final check is under way");
    tokio::time::sleep(secs(60)).await;

    for kind in ["Shutdown", "Eof", "Close"] {
        assert_eq!(world.count("h1", kind), 0, "{kind}: an unanswered final check is not an empty host");
    }
    assert_eq!(port.0.table.admission(h1), Some(Admission::Open), "the host was reopened");
    assert!(registered_endpoints(&port).contains(&"h1".to_string()));
    assert!(port.0.table.begin(h1).is_ok(), "and takes new sessions again");
}

#[tokio::test(start_paused = true)]
async fn a_final_check_that_finds_a_session_keeps_the_host_and_reopens_it() {
    // Looks at 0, 5 and 10 s answer at once; the final check is slow, and a session
    // appears on the host while it is being waited for.
    let slow_check = HostSpec { list: ListBehavior::SlowAfter { answered: 4, delay: secs(1) }, ..HostSpec::default() };
    let (world, port) = retiring(&[("h1", slow_check), ("h2", holding(&[("k2", 22)]))]).await;
    let h1 = channel_of(&port, "h1");

    tokio::time::sleep(secs(10) + millis(200)).await;
    assert_eq!(port.0.table.admission(h1), Some(Admission::Draining), "the final check is under way");
    world.begin_session("h1", meta("k9", 99));
    tokio::time::sleep(secs(40)).await;

    for kind in ["Shutdown", "Eof", "Close"] {
        assert_eq!(world.count("h1", kind), 0, "{kind}: the host holds a running session");
    }
    assert_eq!(port.0.table.admission(h1), Some(Admission::Open));
    assert!(registered_endpoints(&port).contains(&"h1".to_string()));
}

// ---- the current host is down ------------------------------------------------

/// While the current host is down an older host is where new terminals go, so an
/// empty one is kept; once the current host is back the host is retired like any
/// other, after ten fresh seconds of emptiness.
#[tokio::test(start_paused = true)]
async fn an_older_host_is_kept_while_the_current_host_is_down_and_retired_after_it_returns() {
    let (world, port) = retiring(&[("h1", HostSpec::default())]).await;
    let h1 = channel_of(&port, "h1");
    port.drop_current();
    world.set_unreachable(CURRENT, true);

    tokio::time::sleep(secs(60)).await;
    for kind in ["Shutdown", "Eof"] {
        assert_eq!(world.count("h1", kind), 0, "{kind}: h1 is the only host a new terminal can go to");
    }
    match place(&port, "tm-fresh", false).await.unwrap() {
        Placement::Spawn { channel, .. } => assert_eq!(channel, h1, "the new terminal lands on the older host"),
        _ => panic!("the older host is usable, so the terminal must not run in this process"),
    }

    world.set_unreachable(CURRENT, false);
    rediscover_hosts(&port).await.unwrap();
    assert!(port.current_client().is_some(), "the current host is back");
    let back = Instant::now();
    tokio::time::sleep(secs(9)).await;
    assert_eq!(world.count("h1", "Shutdown"), 0, "the clock starts when the current host returns");
    tokio::time::sleep(secs(7)).await;
    let at = first_after(&world, "h1", "Shutdown", back).expect("retired once the current host is back");
    assert!(at >= EMPTY_FOR, "{at:?}");
}

// ---- the barrier --------------------------------------------------------------

#[test]
fn forgetting_a_host_does_not_erase_its_retirement() {
    let barrier = Barrier::new();
    let key = barrier_key("h1");
    barrier.mark_retired(&key, "h1");
    barrier.forget(&key);
    assert!(barrier.is_retired(&key), "the mark outlives a forget: the process may still be discoverable");

    // A host that was not retired is forgotten as before.
    barrier.finish(&barrier_key("h2"), "h2", HostRole::Frozen, Resolution::Resolved);
    barrier.forget(&barrier_key("h2"));
    assert!(!barrier.is_tracked(&barrier_key("h2")));
}

// ---- what is never retired ----------------------------------------------------

/// A host that stops answering is unknown, not empty, and what had been seen
/// before the silence does not count towards the ten seconds.
#[tokio::test(start_paused = true)]
async fn an_unanswered_sample_resets_emptiness() {
    let quiet = HostSpec { list: ListBehavior::SilentBetween(secs(7), secs(20)), ..HostSpec::default() };
    let (world, port) = retiring(&[("h1", quiet)]).await;
    let adopted = Instant::now();

    tokio::time::sleep(secs(40)).await;
    let at = first_after(&world, "h1", "Shutdown", adopted).expect("it answers again, and is empty, so it retires");
    // Empty since 0 s, silent 7-20 s, empty again from 20 s: retired at 30 s, not at
    // 10 s (unanswered counted as empty) nor at 20 s (the silence not resetting).
    assert!(at >= secs(29) && at <= secs(36), "retired after {at:?}");
    assert_eq!(registered_endpoints(&port), Vec::<String>::new());
}

#[tokio::test(start_paused = true)]
async fn busy_host_never_accumulates_requests_and_is_not_retired() {
    let busy = HostSpec { list: ListBehavior::AnswerFirst(1), ..HostSpec::default() };
    let (world, port) = retiring(&[("h1", busy)]).await;
    let h1 = channel_of(&port, "h1");
    let client = port.client_for(h1).expect("connected");

    let mut most_waiting = 0;
    for _ in 0..120 {
        tokio::time::sleep(millis(500)).await;
        most_waiting = most_waiting.max(client.pending_requests());
        assert!(client.pending_requests() <= 1, "a silent host is asked one thing at a time");
    }
    assert_eq!(most_waiting, 1, "the host was being asked: the bound is not vacuous");
    // One listing at adoption, then one per tick; never a retry burst.
    let lists = world.count("h1", "List");
    assert!((10..=15).contains(&lists), "{lists} listing requests in 60 s");
    assert_eq!(client.pending_requests(), 0, "a request that timed out is gone, not queued");

    assert_eq!(world.count("h1", "Shutdown"), 0, "a host that never answers is never retired");
    assert_eq!(world.count("h1", "Eof"), 0);
    assert_eq!(world.count("h1", "Disarm"), 1, "only the adoption's");
    assert_eq!(port.0.table.admission(h1), Some(Admission::Open));
    assert!(client.is_alive());
}

#[tokio::test(start_paused = true)]
async fn a_host_with_no_connection_is_left_to_its_reconnect() {
    let (world, port) = retiring(&[("h1", HostSpec::default())]).await;
    tokio::time::sleep(secs(1)).await;
    world.kill_connections("h1");
    tokio::time::sleep(secs(1)).await;
    let client = port.frozen_hosts()[0].client.clone();
    assert!(!client.is_alive());

    tokio::time::sleep(secs(60)).await;
    assert_eq!(client.pending_requests(), 0, "nothing is asked of a host nobody is connected to");
    assert_eq!(world.count("h1", "Shutdown"), 0);
    assert_eq!(registered_endpoints(&port), ["h1"], "and it is not retired behind its reconnect's back");
}

#[tokio::test(start_paused = true)]
async fn a_single_current_host_has_no_ticker_and_sees_no_new_frames() {
    let (world, port) = machine(&[]);
    port.enable_retirement();
    ensure_hosts(&port).await.unwrap();
    tokio::time::sleep(secs(1)).await;
    let frames = world.kinds(CURRENT).len();

    tokio::time::sleep(secs(120)).await;
    assert_eq!(world.kinds(CURRENT).len(), frames);
    assert!(port.0.table.start_ticker(HostChannel::Primary).is_some(), "no ticker was ever started for it");
}

// ---- exit, offload and update -------------------------------------------------

/// An offload or update holds the table, and a retirement cannot commit while it
/// does: while one is in force the hosts are not sampled, and what was seen before
/// it does not count after.
#[tokio::test(start_paused = true)]
async fn nothing_is_sampled_while_a_hold_is_in_force_and_the_clock_starts_over_after() {
    let (world, port) = retiring(&[("h1", HostSpec::default())]).await;
    tokio::time::sleep(secs(1)).await;
    let hold = port.0.table.quiesce(QuiesceReason::Offload, secs(1)).await.unwrap();
    let frames = world.kinds("h1").len();

    tokio::time::sleep(secs(60)).await;
    assert_eq!(world.kinds("h1").len(), frames, "no look, no retirement, while the hosts are held");

    drop(hold);
    let resumed = Instant::now();
    tokio::time::sleep(secs(9)).await;
    assert_eq!(world.count("h1", "Shutdown"), 0, "the host was empty all along, but nobody saw it");
    tokio::time::sleep(secs(7)).await;
    let at = first_after(&world, "h1", "Shutdown", resumed).expect("retired once ten seconds were seen again");
    assert!(at >= EMPTY_FOR);
}

#[tokio::test(start_paused = true)]
async fn retire_never_runs_after_exit_took_the_table() {
    let (world, port) = retiring(&[("h1", HostSpec::default())]).await;
    let h1 = channel_of(&port, "h1");
    tokio::time::sleep(secs(6)).await;
    let _exit = port.0.table.quiesce(QuiesceReason::Exit, secs(1)).await.unwrap();
    let frames = world.kinds("h1").len();

    tokio::time::sleep(secs(120)).await;
    assert_eq!(world.kinds("h1").len(), frames, "the retirement machinery sends nothing once exit began");
    assert_eq!(registered_endpoints(&port), ["h1"], "and does not retire what exit is about to release");
    assert_ne!(port.0.table.admission(h1), Some(Admission::Retired));
    assert!(port.0.table.start_ticker(h1).is_some(), "the ticker has ended");
}

/// Exit takes the table while the retirement is making its last check under the
/// drain. The check comes back "still empty", but the host now belongs to exit,
/// which releases it exactly once: the retirement neither commits nor shuts down.
#[tokio::test(start_paused = true)]
async fn exit_taking_the_table_during_the_final_check_leaves_the_host_to_exit() {
    let slow_final_check = HostSpec { list: ListBehavior::SlowAfter { answered: 4, delay: secs(1) }, ..HostSpec::default() };
    let (world, port) = retiring(&[("h1", slow_final_check), ("h2", holding(&[("k2", 22)]))]).await;
    let h1 = channel_of(&port, "h1");

    // Ten seconds of emptiness seen at the third tick: the retirement drained the
    // host and is waiting for its last listing.
    tokio::time::sleep(secs(10) + millis(200)).await;
    assert_eq!(port.0.table.admission(h1), Some(Admission::Draining), "the interleaving this test is about");
    let before = world.kinds("h1").len();

    let report = exit_hosts(&port).await;
    tokio::time::sleep(secs(2)).await;

    assert!(report.problems().next().is_none(), "{:?}", report.hosts);
    assert_eq!(
        &world.kinds("h1")[before..],
        ["Disarm", "Shutdown", "Eof"],
        "h1 was released once, by exit, and by nothing else"
    );
    assert_ne!(port.0.table.admission(h1), Some(Admission::Retired));
    assert_eq!(world.count("h2", "Shutdown"), 1, "exit released the other host too");
}

#[tokio::test(start_paused = true)]
async fn exit_leaves_a_host_that_was_already_retired_alone() {
    let (world, port) = retiring(&[("h1", HostSpec::default()), ("h2", holding(&[("k2", 22)]))]).await;
    tokio::time::sleep(secs(20)).await;
    assert_eq!(world.count("h1", "Shutdown"), 1);
    let before = world.kinds("h1").len();

    exit_hosts(&port).await;
    tokio::time::sleep(secs(2)).await;
    assert_eq!(world.kinds("h1").len(), before, "a retired host is not part of what exit releases");
    assert_eq!(&world.kinds("h2")[world.kinds("h2").len() - 3..], ["Disarm", "Shutdown", "Eof"]);
}

// ---- wiring -------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn one_ticker_per_host_survives_a_reconnect() {
    let (world, port) = retiring(&[("h1", holding(&[("k1", 11)]))]).await;
    let id = frozen_id(&port, "h1");
    let channel = HostChannel::Frozen(id);
    assert!(port.0.table.start_ticker(channel).is_none(), "adoption started the ticker");

    tokio::time::sleep(secs(1)).await;
    let epoch = port.0.table.epoch(channel).unwrap();
    world.kill_connections("h1");
    tokio::time::sleep(secs(1)).await;
    assert_eq!(reconnect_frozen(&port, id, epoch, &[500]).await, FrozenReconnect::Reconnected);
    assert!(port.0.table.start_ticker(channel).is_none(), "the reconnect did not start a second one");

    let lists = world.count("h1", "List");
    tokio::time::sleep(secs(12)).await;
    assert!(world.count("h1", "List") >= lists + 2, "the same ticker goes on through the new connection");
}

#[tokio::test(start_paused = true)]
async fn a_nudge_looks_at_the_host_between_ticks() {
    let (world, port) = retiring(&[("h1", holding(&[("k1", 11)]))]).await;
    let h1 = channel_of(&port, "h1");
    let adopted = Instant::now();
    tokio::time::sleep(secs(2) + millis(500)).await;
    let lists = world.count("h1", "List");

    port.0.table.nudge_ticker(h1);
    tokio::time::sleep(millis(100)).await;
    assert_eq!(world.count("h1", "List"), lists + 1);
    let at = world.frames("h1").into_iter().rev().find(|(_, kind)| *kind == "List").unwrap().0.duration_since(adopted);
    assert!(at > secs(2) && at < TICK, "looked at {at:?} after adoption, between the ticks at 0 s and 5 s");
}

#[test]
fn the_last_pane_of_an_older_host_nudges_its_ticker() {
    let terminals = production(include_str!("../terminals.rs"));
    let body = fn_body(&terminals, "pub fn forget_host_terminal(");
    assert!(body.contains("HostChannel::Frozen(_)"), "{body}");
    assert!(body.contains("host_table.nudge_ticker(channel)"), "{body}");
    let nudge = body.find("nudge_ticker").unwrap();
    assert!(
        body[..nudge].contains(".any(|e| *e.value() == channel)"),
        "only when no other pane is left on the host"
    );
}

#[test]
fn adopting_an_older_host_starts_its_ticker_and_nothing_else_does() {
    let adoption = production(include_str!("../host_adoption.rs"));
    let adopt = fn_body(&adoption, "async fn adopt<");
    assert!(adopt.contains("port.frozen_adopted(id)"), "adoption must start the host's ticker");
    let published = adopt.find("port.publish_frozen(").expect("adoption publishes the host");
    assert!(published < adopt.find("port.frozen_adopted(id)").unwrap(), "after it is published");

    let port = production(include_str!("../host_port.rs"));
    assert!(fn_body(&port, "fn frozen_adopted(").contains("host_retire::start_ticker(self, id)"));

    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut sources = Vec::new();
    for dir in ["state", "commands"] {
        scan(&root.join(dir), &root, &mut sources);
    }
    // (needle, the only files that may contain it). Each must be found in every
    // file listed, or the census has gone vacuous.
    for (needle, allowed) in [
        // Only adoption (through the port's hook) starts a ticker, and only the
        // ticker commits a retirement or places itself on a host's slot.
        ("host_retire::start_ticker(", &["state/host_port.rs"][..]),
        (".start_ticker(", &["state/host_retire.rs"][..]),
        (".retire_when_open(", &["state/host_retire.rs"][..]),
        // Bounded listings: the ticker's, adoption's own, and the count of what a
        // full update would close.
        ("list_sessions_numbered_within(", &["state/host_retire.rs", "state/host_adoption.rs", "state/update_full.rs"][..]),
    ] {
        for (file, text) in &sources {
            if text.contains(needle) {
                assert!(allowed.contains(&file.as_str()), "`{needle}` found in {file}: not a place that may do this");
            }
        }
        for file in allowed {
            let text = &sources.iter().find(|(f, _)| f == file).unwrap_or_else(|| panic!("{file} was not scanned")).1;
            assert!(text.contains(needle), "{file} no longer contains `{needle}`: update this census");
        }
    }
    // A timeout wrapped around a listing from outside would drop the request without
    // removing it from the client's pending map; the bound belongs inside it.
    assert!(sources.iter().any(|(_, text)| text.contains(".list_sessions_numbered(")), "no listing was found: vacuous");
    for (file, text) in &sources {
        for line in text.lines().filter(|l| l.contains("list_sessions")) {
            assert!(!line.contains("timeout("), "{file}: a listing is bounded with `list_sessions_within`, not an outer timeout: {line}");
        }
    }
}

fn scan(dir: &std::path::Path, root: &std::path::Path, out: &mut Vec<(String, String)>) {
    let mut entries: Vec<_> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().path()).collect();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            scan(&path, root, out);
            continue;
        }
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        if name.ends_with(".rs") && !name.ends_with("_tests.rs") && name != "fake_hosts.rs" {
            let relative = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
            out.push((relative, production(&std::fs::read_to_string(&path).unwrap())));
        }
    }
}

#[tokio::test(start_paused = true)]
async fn a_keyed_create_for_a_session_on_a_draining_host_waits() {
    // A keyed create for a session reserved on h1, while h1 is draining, is told
    // to wait: the host is not given away, and nothing is spawned in its place.
    let (world, port) = machine(&[("h1", holding(&[("k1", 11)]))]);
    rediscover_hosts(&port).await.unwrap();
    let h1 = channel_of(&port, "h1");
    let drain = port.0.table.drain_host(h1).unwrap();
    let refusal = place(&port, "k1", false).await.err().expect("the host is closed to admission");
    assert!(refusal.starts_with(HOST_OWNERSHIP_PENDING), "{refusal}");
    assert_eq!(world.count("h1", "Attach") + world.count("h1", "Spawn"), 0);
    assert_eq!(port.table().keys().candidate("k1", None).map(|(channel, _)| channel), Some(h1), "the claim is still waiting for its pane");
    drop(drain);
}
