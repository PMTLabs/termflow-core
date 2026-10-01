use super::fake_hosts::*;
use super::*;
use crate::state::host_registry;
use crate::state::host_table::{Admission, QuiesceReason};
use crate::state::types::HostSessionClaimState;
use std::sync::atomic::Ordering;
use termflow_pty_protocol::SpawnSpec;

const CURRENT: &str = "cur";
const SEC: Duration = Duration::from_secs(1);

fn secs(n: u64) -> Duration {
    Duration::from_secs(n)
}

fn spawn_spec() -> SpawnSpec {
    SpawnSpec {
        shell: "sh".into(),
        args: vec![],
        env: vec![],
        env_remove: vec![],
        cwd: None,
        cols: 80,
        rows: 24,
    }
}

fn frozen(name: &str) -> HostCandidate {
    candidate(name, HostRole::Frozen)
}

fn current() -> HostCandidate {
    candidate(CURRENT, HostRole::Current)
}

/// A machine with the current host running and these older hosts, all
/// discovered (current last, as a slow old host is the interesting case).
fn machine(old: &[(&str, HostSpec)]) -> (Arc<World>, FakePort) {
    let world = World::new();
    world.add_host(CURRENT, HostSpec::default());
    let mut candidates = Vec::new();
    for (name, spec) in old {
        world.add_host(name, spec.clone());
        candidates.push(frozen(name));
    }
    candidates.push(current());
    let port = FakePort::new(&world, CURRENT);
    port.set_candidates(candidates);
    (world, port)
}

fn never() -> HostSpec {
    HostSpec { list: ListBehavior::Never, ..HostSpec::default() }
}

fn holding(keys: &[(&str, u32)]) -> HostSpec {
    HostSpec { sessions: keys.iter().map(|(k, pid)| meta(k, *pid)).collect(), ..HostSpec::default() }
}

/// What a keyed create (a restoring pane) decides, reduced to the part the
/// barrier drives: wait for every host to settle, then attach where a claim says
/// the session lives, spawn on the current host only if nothing claims the key,
/// and never spawn while a host is unresolved.
#[derive(Debug, PartialEq)]
enum Keyed {
    Attached(HostChannel),
    Spawned,
    Pending(Vec<String>),
}

async fn keyed_create(port: &FakePort, session_key: &str) -> Keyed {
    let _ = ensure_hosts(port).await;
    if let Err(unresolved) = port.barrier().wait_resolved(secs(8)).await {
        return Keyed::Pending(unresolved.into_iter().map(|u| u.endpoint).collect());
    }
    match host_registry::claim_registration(&port.0.claims, session_key, HostChannel::Primary).unwrap() {
        Some((_, channel)) => {
            let client = port.client_for(channel).expect("the claimed host is registered");
            client.attach_confirmed(session_key, 0).await;
            Keyed::Attached(channel)
        }
        None => {
            port.current_client().unwrap().spawn_session(session_key, &spawn_spec()).await.unwrap();
            Keyed::Spawned
        }
    }
}

// ---- concurrency ------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn slow_first_host_does_not_starve_second_hosts_lifecycle_frame() {
    // h1 never answers its listing; h2's absence clock is about to run out, so
    // the lifecycle frame has to reach it long before h1 gives up (~10 s).
    let (world, port) = machine(&[("h1", never()), ("h2", holding(&[("k2", 22)]))]);
    let start = Instant::now();
    let ensure = tokio::spawn({
        let port = port.clone();
        async move { ensure_hosts(&port).await }
    });

    tokio::time::sleep(SEC).await;
    let expiry = start + secs(2);
    let h2_frame = world.first_at("h2", "Disarm").expect("h2 must have been sent its lifecycle frame");
    assert!(h2_frame < expiry, "h2's frame arrived {:?} after the start", h2_frame - start);
    assert_eq!(world.kinds("h2"), vec!["Disarm", "List"], "lifecycle frame first, then the listing");
    assert_eq!(world.kinds("h1")[0], "Disarm", "h1 gets the same treatment, and is still listing");
    // h2 is already published and resolved while h1 is still stuck.
    let registered = port.frozen_ids();
    assert_eq!(registered.len(), 1, "h2 is published; h1 is not until its listing ends");
    assert_eq!(port.0.claims.get("k2").unwrap().channel, HostChannel::Frozen(registered[0]));
    let unresolved: Vec<_> = port.barrier().unresolved().into_iter().map(|u| u.endpoint).collect();
    assert_eq!(unresolved, vec!["h1"]);
    assert!(ensure.is_finished(), "the current host is up, so ensure_hosts does not wait for h1");
    ensure.await.unwrap().unwrap();
}

#[tokio::test(start_paused = true)]
async fn a_frozen_host_is_published_as_soon_as_it_is_listed_not_jointly() {
    let (_world, port) = machine(&[("h1", never()), ("h2", HostSpec::default())]);
    let ensure = tokio::spawn({
        let port = port.clone();
        async move { rediscover_hosts(&port).await }
    });
    tokio::time::sleep(SEC).await;
    assert!(!ensure.is_finished(), "rediscovery waits for every host");
    assert!(port.current_client().is_some(), "current published while h1 is still listing");
    assert_eq!(
        port.0.table.admission(HostChannel::Frozen(port.frozen_ids().into_iter().next().unwrap())),
        Some(Admission::Open)
    );
    ensure.await.unwrap().unwrap();
    // Unanswered after three bounded attempts, not after the client's 10 s default.
    assert_eq!(port.barrier().unresolved().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn listing_attempts_are_three_and_each_bounded() {
    let (world, port) = machine(&[("h1", never())]);
    let start = Instant::now();
    rediscover_hosts(&port).await.unwrap();
    assert_eq!(world.count("h1", "List"), 3);
    // 3 x 3 s plus two 0.5 s pauses, after the (instant) lifecycle frame.
    let took = start.elapsed();
    assert!(took >= secs(10) && took < secs(11), "took {took:?}");
}

#[tokio::test(start_paused = true)]
async fn lifecycle_frame_precedes_the_listing_on_every_host() {
    let (world, port) = machine(&[("h1", HostSpec::default())]);
    ensure_hosts(&port).await.unwrap();
    rediscover_hosts(&port).await.unwrap();
    for host in ["h1", CURRENT] {
        let kinds = world.kinds(host);
        let disarm = kinds.iter().position(|k| *k == "Disarm").unwrap();
        let list = kinds.iter().position(|k| *k == "List").unwrap();
        assert!(disarm < list, "{host}: {kinds:?}");
    }
}

#[tokio::test(start_paused = true)]
async fn the_overall_deadline_bounds_every_candidate() {
    let (world, port) = machine(&[("slow", HostSpec { connect_delay: secs(60), ..HostSpec::default() })]);
    let start = Instant::now();
    rediscover_hosts(&port).await.unwrap();
    assert!(start.elapsed() <= ADOPTION_DEADLINE + SEC, "took {:?}", start.elapsed());
    let unresolved = port.barrier().unresolved();
    assert_eq!(unresolved.len(), 1);
    assert!(unresolved[0].reason.contains("timed out"), "{:?}", unresolved[0]);
    assert!(port.frozen_ids().is_empty());
    assert_eq!(world.count("slow", "Disarm"), 0);
}

#[tokio::test(start_paused = true)]
async fn concurrent_creates_connect_the_current_host_once() {
    let (world, port) = machine(&[]);
    let creates: Vec<_> = (0..5)
        .map(|_| {
            let port = port.clone();
            tokio::spawn(async move { ensure_hosts(&port).await })
        })
        .collect();
    for create in creates {
        create.await.unwrap().unwrap();
    }
    assert_eq!(port.connect_count(CURRENT), 1);
    assert_eq!(world.count(CURRENT, "Disarm"), 1);
}

// ---- unanswered is unknown --------------------------------------------------

#[tokio::test(start_paused = true)]
async fn unanswered_listing_is_unresolved_not_empty_and_the_host_is_still_registered() {
    let (_world, port) = machine(&[("h1", never())]);
    rediscover_hosts(&port).await.unwrap();
    let listings = port.0.listings.lock().unwrap().clone();
    let h1 = HostChannel::Frozen(port.frozen_ids()[0]);
    assert!(
        listings.contains(&(h1, None)),
        "an unanswered listing must be reported as unknown (None), never as an empty list: {listings:?}"
    );
    let unresolved = port.barrier().unresolved();
    assert_eq!(unresolved.len(), 1);
    assert_eq!(unresolved[0].endpoint, "h1");
    assert!(unresolved[0].reason.contains("ListSessions"));
}

#[tokio::test(start_paused = true)]
async fn frozen_list_delayed_restore_waits_not_spawns() {
    // h1 recovers 4 s in: after its first listing timed out, before its third.
    let old = HostSpec { list: ListBehavior::SilentFor(secs(4)), ..holding(&[("k1", 91)]) };
    let (world, port) = machine(&[("h1", old)]);
    let start = Instant::now();
    let outcome = keyed_create(&port, "k1").await;
    let waited = start.elapsed();

    let h1 = HostChannel::Frozen(port.frozen_ids()[0]);
    assert_eq!(outcome, Keyed::Attached(h1), "the restoring pane attaches on the host that holds it");
    assert!(waited > secs(3), "it must have waited for the host, not raced ahead: {waited:?}");
    assert_eq!(world.count_everywhere("Spawn"), 0, "no Spawn frame to any host");
    assert_eq!(world.count("h1", "Attach"), 1);
    assert_eq!(world.count(CURRENT, "Attach"), 0);
}

#[tokio::test(start_paused = true)]
async fn frozen_list_unanswered_no_spawn_anywhere() {
    let (world, port) = machine(&[("h1", never())]);
    let outcome = keyed_create(&port, "k1").await;
    assert_eq!(outcome, Keyed::Pending(vec!["h1".into()]), "the pane waits and names the host");
    assert_eq!(world.count_everywhere("Spawn"), 0, "no Spawn frame to ANY host, current included");
    assert_eq!(world.count_everywhere("Attach"), 0);
}

#[tokio::test(start_paused = true)]
async fn an_unclaimed_key_spawns_only_once_every_host_answered() {
    let (world, port) = machine(&[("h1", HostSpec::default())]);
    assert_eq!(keyed_create(&port, "brand-new").await, Keyed::Spawned);
    assert_eq!(world.count(CURRENT, "Spawn"), 1);
    assert_eq!(world.count("h1", "Spawn"), 0);
}

#[tokio::test(start_paused = true)]
async fn fresh_tab_spawns_on_current_with_one_candidate_unresolved_and_no_retry_pending() {
    let (world, port) = machine(&[("h1", never())]);
    ensure_hosts(&port).await.unwrap();
    // Let h1's attempt run out: it is now unresolved with nothing on its way.
    tokio::time::sleep(secs(30)).await;
    assert!(port.barrier().needs_attempt(), "h1 is unresolved and no retry is pending");
    let discovers = port.0.discovers.load(Ordering::SeqCst);
    let lists = world.count("h1", "List");

    // A fresh tab: ensure_hosts does not fast-return (it retries h1), but it
    // must not wait for h1 either, which an inline retry under the start lock would.
    tokio::time::timeout(SEC, ensure_hosts(&port))
        .await
        .expect("a fresh tab must not wait for the unresolved host")
        .unwrap();
    assert!(port.0.discovers.load(Ordering::SeqCst) > discovers, "no fast return while a retry is owed");
    port.current_client().unwrap().spawn_session("fresh", &spawn_spec()).await.unwrap();
    assert_eq!(world.count(CURRENT, "Spawn"), 1);
    assert_eq!(world.count("h1", "Spawn"), 0);

    // The retry did start, on its own task.
    tokio::time::sleep(secs(30)).await;
    assert!(world.count("h1", "List") > lists, "the unresolved host was retried in the background");
}

#[tokio::test(start_paused = true)]
async fn ensure_hosts_fast_returns_when_everything_is_connected_and_resolved() {
    let (_world, port) = machine(&[("h1", HostSpec::default())]);
    ensure_hosts(&port).await.unwrap();
    tokio::time::sleep(SEC).await;
    let discovers = port.0.discovers.load(Ordering::SeqCst);
    ensure_hosts(&port).await.unwrap();
    assert_eq!(port.0.discovers.load(Ordering::SeqCst), discovers);
}

#[tokio::test(start_paused = true)]
async fn a_current_host_that_never_answered_its_listing_does_not_delay_fresh_tabs() {
    let world = World::new();
    world.add_host(CURRENT, never());
    let port = FakePort::new(&world, CURRENT);
    port.set_candidates(vec![current()]);

    // The first connect waits for the listing, as adoption always has.
    ensure_hosts(&port).await.unwrap();
    assert!(port.current_client().is_some(), "published even though the listing was not answered");
    assert_eq!(port.barrier().unresolved().len(), 1);

    // Later creates re-list it in the background instead of waiting for it.
    let lists = world.count(CURRENT, "List");
    tokio::time::timeout(SEC, ensure_hosts(&port)).await.expect("must not wait for the re-list").unwrap();
    tokio::time::sleep(secs(30)).await;
    assert!(world.count(CURRENT, "List") > lists, "the re-list ran on its own task");
    assert_eq!(port.connect_count(CURRENT), 1, "the connected host is re-listed, not reconnected");
}

#[tokio::test(start_paused = true)]
async fn an_unresolved_host_with_a_retry_in_flight_is_not_attempted_twice() {
    let (world, port) = machine(&[("h1", never())]);
    ensure_hosts(&port).await.unwrap();
    // h1's attempt is still running; further rounds must neither wait nor pile on.
    for _ in 0..3 {
        ensure_hosts(&port).await.unwrap();
        rediscover_hosts(&port).await.unwrap();
    }
    tokio::time::sleep(secs(30)).await;
    assert_eq!(port.connect_count("h1"), 1);
    assert_eq!(world.count("h1", "Disarm"), 1);
}

// ---- current role -----------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn current_spawn_failure_still_adopts_frozen() {
    let world = World::new();
    world.spawn_fails.store(true, Ordering::SeqCst);
    world.add_host("h1", holding(&[("k1", 11)]));
    let port = FakePort::new(&world, CURRENT);
    // No current host exists, and none can be started.
    port.set_candidates(vec![frozen("h1")]);

    ensure_hosts(&port).await.expect("an older host is usable, so this is not a failure");
    assert!(port.current_client().is_none());
    let h1 = HostChannel::Frozen(port.frozen_ids()[0]);
    assert_eq!(port.0.claims.get("k1").unwrap().channel, h1, "its session is reserved on it");
    assert!(port.barrier().unresolved().is_empty());
    assert!(port.0.table.begin(h1).is_ok(), "and it accepts attaches");
    assert!(port.0.connects.lock().unwrap().contains(&(CURRENT.to_string(), HostRole::Current)));
}

#[tokio::test(start_paused = true)]
async fn current_spawn_failure_with_nothing_else_is_an_error() {
    let world = World::new();
    world.spawn_fails.store(true, Ordering::SeqCst);
    let port = FakePort::new(&world, CURRENT);
    let err = ensure_hosts(&port).await.unwrap_err();
    assert!(err.contains("no valid pty-host binary"), "{err}");
    // A host that does not exist holds nobody's panes.
    assert!(port.barrier().unresolved().is_empty());
}

#[tokio::test(start_paused = true)]
async fn current_failure_does_not_block_on_the_current_host_for_the_frozen_ones() {
    let world = World::new();
    world.spawn_fails.store(true, Ordering::SeqCst);
    world.add_host("h1", HostSpec::default());
    world.add_host("h2", never());
    let port = FakePort::new(&world, CURRENT);
    port.set_candidates(vec![frozen("h2"), frozen("h1")]);
    ensure_hosts(&port).await.unwrap();
    // With no current host the older ones are the fallback, so they are awaited.
    assert_eq!(port.frozen_ids().len(), 2);
    assert_eq!(world.count("h2", "List"), 3);
}

#[tokio::test(start_paused = true)]
async fn same_build_relaunch_no_second_process() {
    let world = World::new();
    world.add_host("h1", holding(&[("k1", 11)]));
    let first = FakePort::new(&world, CURRENT);
    first.set_candidates(vec![frozen("h1")]);
    ensure_hosts(&first).await.unwrap();
    assert_eq!(*world.started_processes.lock().unwrap(), vec![CURRENT.to_string()], "launch one starts the host");

    // Launch two: same build, same host. Discovery now finds it.
    let second = FakePort::new(&world, CURRENT);
    second.set_candidates(vec![frozen("h1"), current()]);
    ensure_hosts(&second).await.unwrap();
    assert_eq!(*world.started_processes.lock().unwrap(), vec![CURRENT.to_string()], "no second process");
    assert!(second.current_client().is_some());

    // The current host is running but briefly unreachable, and its record says
    // its process is alive: the connect must be told so and refuse to start another.
    world.add_host(
        CURRENT,
        HostSpec { unreachable: true, ..HostSpec::default() },
    );
    let third = FakePort::new(&world, CURRENT);
    third.set_candidates(vec![current()]);
    assert!(ensure_hosts(&third).await.is_err());
    assert_eq!(world.started_processes.lock().unwrap().len(), 1, "an unreachable host is not replaced");
    assert_eq!(
        third.barrier().unresolved().len(),
        1,
        "and its panes keep waiting for it: it may hold sessions"
    );
}

#[tokio::test(start_paused = true)]
async fn e_cur_pinned_transient_install_failure_does_not_rerole() {
    let (world, port) = machine(&[]);
    ensure_hosts(&port).await.unwrap();
    assert_eq!(port.barrier().role_of(CURRENT), Some(HostRole::Current));

    // A later discovery classifies the same endpoint as frozen, as a transient
    // install failure (generation = none) would if the role were recomputed.
    port.set_candidates(vec![frozen(CURRENT)]);
    rediscover_hosts(&port).await.unwrap();
    ensure_hosts(&port).await.unwrap();

    assert_eq!(port.barrier().role_of(CURRENT), Some(HostRole::Current), "one host keeps its one role");
    assert!(port.frozen_ids().is_empty(), "it must not be registered a second time as frozen");
    assert_eq!(port.connect_count(CURRENT), 1);
    assert_eq!(world.count(CURRENT, "Disarm"), 1);
}

// ---- barrier ----------------------------------------------------------------

fn incompatible(name: &str) -> HostCandidate {
    HostCandidate { record: Some(record(name, 200, 200)), ..frozen(name) }
}

#[tokio::test(start_paused = true)]
async fn incompatible_candidate_does_not_hold_restoring_panes() {
    let (world, port) = machine(&[("ok", holding(&[("k1", 5)]))]);
    world.add_host("new-proto", never());
    let mut candidates = port.candidates();
    candidates.insert(0, incompatible("new-proto"));
    port.set_candidates(candidates);

    // Barrier level: the incompatible host is not tracked, so it cannot block.
    port.barrier().sync(&port.candidates(), &[]);
    let tracked: Vec<_> = port.barrier().unresolved().into_iter().map(|u| u.endpoint).collect();
    assert!(!tracked.contains(&"new-proto".to_string()), "{tracked:?}");

    // Adoption level: it is never connected to, never sent a frame, and a
    // restoring pane is decided by the compatible hosts alone.
    assert_eq!(keyed_create(&port, "k1").await, Keyed::Attached(HostChannel::Frozen(port.frozen_ids()[0])));
    assert_eq!(port.connect_count("new-proto"), 0);
    assert!(world.kinds("new-proto").is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_compatible_unresolved_host_does_hold_them() {
    let (_world, port) = machine(&[("wedged", never())]);
    assert_eq!(keyed_create(&port, "k").await, Keyed::Pending(vec!["wedged".into()]));
}

#[tokio::test(start_paused = true)]
async fn a_host_that_vanished_from_discovery_stops_holding_panes() {
    let (_world, port) = machine(&[("gone", HostSpec { unreachable: true, ..HostSpec::default() })]);
    ensure_hosts(&port).await.unwrap();
    tokio::time::sleep(secs(30)).await;
    assert_eq!(port.barrier().unresolved().len(), 1, "a host that cannot be reached may hold sessions");

    // Its process died, so discovery no longer reports it.
    port.set_candidates(vec![current()]);
    rediscover_hosts(&port).await.unwrap();
    assert!(port.barrier().unresolved().is_empty());
    assert!(port.barrier().wait_resolved(Duration::ZERO).await.is_ok());
}

#[tokio::test(start_paused = true)]
async fn wait_resolved_returns_at_once_when_nothing_is_tracked() {
    let barrier = Barrier::new();
    barrier.wait_resolved(Duration::ZERO).await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn wait_resolved_times_out_naming_the_unresolved_host() {
    let barrier = Barrier::new();
    barrier.sync(&[frozen("h1"), frozen("h2")], &[]);
    barrier.finish("h2", "h2", HostRole::Frozen, Resolution::Resolved);
    let err = barrier.wait_resolved(secs(2)).await.unwrap_err();
    assert_eq!(err.len(), 1);
    assert_eq!(err[0].endpoint, "h1");
}

// ---- epochs -----------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn stale_epoch_callback_inert() {
    let (world, port) = machine(&[("h1", holding(&[("k1", 7)]))]);
    ensure_hosts(&port).await.unwrap();
    let id = port.frozen_ids()[0];
    let host = HostChannel::Frozen(id);
    let connection = port.0.table.is_current(host, port.frozen_hosts()[0].epoch);
    assert!(connection, "the published epoch is the connection's");
    assert!(port.barrier().unresolved().is_empty());

    // The host is reconnected: a newer epoch is published, then the OLD
    // connection finally reports its drop.
    let newer = port.0.table.reserve_epoch();
    port.0.table.publish(host, newer);
    world.kill_connections("h1");
    tokio::time::sleep(SEC).await;
    assert_eq!(port.0.disconnects.load(Ordering::SeqCst), 1, "the old connection really dropped");
    assert!(
        port.barrier().unresolved().is_empty(),
        "a superseded connection's drop must not mark the reconnected host unknown"
    );

    // The current connection's own drop is acted on.
    assert!(frozen_connection_lost(&port.0.table, &port.0.barrier, id, newer, "h1"));
    let unresolved = port.barrier().unresolved();
    assert_eq!(unresolved.len(), 1);
    assert_eq!(unresolved[0].reason, "connection lost");
    // No reconnect of a single older host exists yet: it stays unresolved, and a rediscovery must not start an attempt on it.
    assert!(!port.barrier().needs_attempt());
}

// ---- admission --------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn recursive_adoption_while_writer_pending_cannot_deadlock() {
    let (_world, port) = machine(&[("h1", HostSpec::default())]);
    ensure_hosts(&port).await.unwrap();
    // A create holds a ticket on the current host...
    let create = port.0.table.begin(HostChannel::Primary).unwrap();
    // ...Exit starts quiescing, waiting for it...
    let exit = tokio::spawn({
        let table = port.0.table.clone();
        async move { table.quiesce(QuiesceReason::Exit, secs(10)).await }
    });
    tokio::task::yield_now().await;
    assert!(!exit.is_finished());

    // ...and the create needs adoption (its connection dropped meanwhile).
    port.drop_current();
    let refused = tokio::time::timeout(secs(5), ensure_hosts(&port))
        .await
        .expect("the nested adoption must be refused, not queued behind the quiesce")
        .unwrap_err();
    assert!(refused.starts_with(LIFECYCLE_BUSY), "{refused}");

    // The create gives up, drops its ticket, and the quiesce completes.
    drop(create);
    let guard = tokio::time::timeout(secs(5), exit).await.expect("quiesce completes").unwrap().unwrap();
    assert!(guard.drained());
}

#[tokio::test(start_paused = true)]
async fn refusing_offload_during_exit_does_not_reopen_admission_for_adoption() {
    let (world, port) = machine(&[("h1", HostSpec::default())]);
    ensure_hosts(&port).await.unwrap();
    port.drop_current();
    let connects = port.0.connects.lock().unwrap().len();

    let exit = port.0.table.quiesce(QuiesceReason::Exit, secs(1)).await.unwrap();
    let refused = port.0.table.quiesce(QuiesceReason::Offload, secs(1)).await;
    assert!(refused.is_err());
    drop(refused);

    // begin and connect_host keep failing until the process ends.
    assert!(port.0.table.begin(HostChannel::Primary).is_err());
    for _ in 0..2 {
        let err = ensure_hosts(&port).await.unwrap_err();
        assert!(err.starts_with(LIFECYCLE_BUSY), "{err}");
    }
    let err = rediscover_hosts(&port).await.unwrap_err();
    assert!(err.starts_with(LIFECYCLE_BUSY), "{err}");
    assert_eq!(port.0.connects.lock().unwrap().len(), connects, "no connection was attempted");
    assert_eq!(world.count(CURRENT, "Disarm"), 1);
    drop(exit);
    assert!(port.0.table.begin(HostChannel::Primary).is_err(), "Exit never reopens");
}

#[tokio::test(start_paused = true)]
async fn quiesce_waits_for_an_adoption_in_flight() {
    let world = World::new();
    world.add_host(CURRENT, HostSpec { connect_delay: secs(2), ..HostSpec::default() });
    let port = FakePort::new(&world, CURRENT);
    port.set_candidates(vec![current()]);
    let ensure = tokio::spawn({
        let port = port.clone();
        async move { ensure_hosts(&port).await }
    });
    tokio::time::sleep(SEC).await;

    let start = Instant::now();
    let guard = port.0.table.quiesce(QuiesceReason::Offload, secs(10)).await.unwrap();
    assert!(guard.drained());
    assert!(start.elapsed() >= Duration::from_millis(900), "the adoption held a ticket: {:?}", start.elapsed());
    assert!(port.current_client().is_some(), "and was finished, not abandoned, when the quiesce returned");
    ensure.await.unwrap().unwrap();
}

#[tokio::test(start_paused = true)]
async fn adoption_ticket_is_returned_when_the_attempt_fails() {
    let world = World::new();
    world.spawn_fails.store(true, Ordering::SeqCst);
    let port = FakePort::new(&world, CURRENT);
    assert!(ensure_hosts(&port).await.is_err());
    let guard = port.0.table.quiesce(QuiesceReason::Update, secs(1)).await.unwrap();
    assert!(guard.drained(), "a failed adoption must not leak its ticket");
}

// ---- a primary that dropped ----------------------------------------------------

/// The primary is unreachable while an older host is fine: `ensure_hosts`
/// succeeds (an older host is usable), which says nothing about the primary. The
/// reconnect must keep its backoff and leave the panes alone until the primary is
/// really back.
#[tokio::test(start_paused = true)]
async fn reconnect_keeps_retrying_while_only_an_older_host_is_usable() {
    let (world, port) = machine(&[("h1", holding(&[("k1", 11)]))]);
    world.set_unreachable(CURRENT, true);
    let reconnect = tokio::spawn({
        let port = port.clone();
        async move { reconnect_current(&port, &[500, 1000, 2000]).await }
    });

    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(port.frozen_ids().len(), 1, "the first attempt did adopt the older host");
    assert_eq!(port.connect_count(CURRENT), 1);
    assert!(port.current_client().is_none());
    assert!(!reconnect.is_finished(), "an older host being usable does not end the reconnect");

    world.set_unreachable(CURRENT, false);
    tokio::time::sleep(secs(1)).await;
    assert!(reconnect.await.unwrap(), "the primary came back on a later attempt");
    assert_eq!(port.connect_count(CURRENT), 2, "retried once, after its first backoff");
    assert!(port.current_client().is_some());
}

#[tokio::test(start_paused = true)]
async fn reconnect_gives_up_only_after_every_backoff_step() {
    let (world, port) = machine(&[("h1", holding(&[("k1", 11)]))]);
    world.set_unreachable(CURRENT, true);
    let start = Instant::now();
    assert!(!reconnect_current(&port, &[500, 1000, 2000]).await);
    assert_eq!(port.connect_count(CURRENT), 3, "one attempt per step");
    assert!(start.elapsed() >= Duration::from_millis(3500), "{:?}", start.elapsed());
}

#[test]
fn the_pipe_drop_recovery_reconnects_through_reconnect_current() {
    let terminals = source_of("terminals.rs");
    let body = fn_body(&terminals, "pub async fn reconnect_after_pipe_drop(");
    assert!(body.contains("host_adoption::reconnect_current(self,"));
    assert!(!body.contains("ensure_pty_host"), "ensure_pty_host also succeeds on an older host alone");
}

// ---- publication --------------------------------------------------------------

/// A create that can see the current client takes a ticket on its slot. If the
/// slot were published after the client, that create would pass the host over.
#[tokio::test(start_paused = true)]
async fn the_primary_slot_is_open_before_the_current_client_is_visible() {
    let (_world, port) = machine(&[]);
    ensure_hosts(&port).await.unwrap();
    assert_eq!(
        *port.0.admission_when_published.lock().unwrap(),
        vec![Some(Admission::Open)],
        "what the table said at the moment the client was made visible"
    );
    assert_eq!(port.0.table.admission(HostChannel::Primary), Some(Admission::Open));
}

/// The same ordering for a frozen host: a keyed create for a session reserved on
/// it sees the client the moment it is visible and must find a slot to take a
/// ticket on, or it would be told the host is missing and retried.
#[tokio::test(start_paused = true)]
async fn a_frozen_slot_is_open_before_its_client_is_visible() {
    let (_world, port) = machine(&[("h1", HostSpec::default())]);
    ensure_hosts(&port).await.unwrap();
    assert_eq!(
        *port.0.frozen_admission_when_published.lock().unwrap(),
        vec![Some(Admission::Open)],
        "what the table said at the moment the frozen client was made visible"
    );
    assert_eq!(port.frozen_ids().len(), 1);
}

// ---- hosts that are gone ------------------------------------------------------

/// What discovery finds for an endpoint with no record and no process behind it,
/// such as a socket file a dead host left.
fn probe_only(name: &str) -> HostCandidate {
    HostCandidate { record: None, pid: None, generation: None, ..frozen(name) }
}

fn machine_with(stale: HostCandidate, spec: HostSpec) -> (Arc<World>, FakePort) {
    let world = World::new();
    world.add_host(CURRENT, HostSpec::default());
    world.add_host(&stale.endpoint, spec);
    let port = FakePort::new(&world, CURRENT);
    port.set_candidates(vec![stale, current()]);
    (world, port)
}

#[tokio::test(start_paused = true)]
async fn a_refused_probe_only_candidate_does_not_hold_a_restoring_pane() {
    let (world, port) = machine_with(probe_only("stale"), HostSpec { refused: true, ..HostSpec::default() });
    assert_eq!(keyed_create(&port, "k1").await, Keyed::Spawned, "nothing lives on the dead endpoint");
    assert!(port.barrier().unresolved().is_empty());
    assert!(!port.barrier().is_tracked("stale"), "dropped, not held unresolved");
    assert_eq!(world.count(CURRENT, "Spawn"), 1);
    assert_eq!(port.connect_count("stale"), 1);
}

#[tokio::test(start_paused = true)]
async fn a_busy_probe_only_candidate_keeps_its_restoring_pane_waiting() {
    let (world, port) = machine_with(probe_only("slow"), HostSpec { unreachable: true, ..HostSpec::default() });
    assert_eq!(keyed_create(&port, "k1").await, Keyed::Pending(vec!["slow".into()]));
    assert!(port.barrier().is_tracked("slow"));
    assert_eq!(world.count_everywhere("Spawn"), 0);
}

/// Its record says a process is alive behind the endpoint: it may just not be
/// listening yet, so a refusal is no proof that the host is gone.
#[tokio::test(start_paused = true)]
async fn a_refused_candidate_with_a_live_process_stays_unresolved() {
    let (world, port) = machine_with(frozen("starting"), HostSpec { refused: true, ..HostSpec::default() });
    assert_eq!(keyed_create(&port, "k1").await, Keyed::Pending(vec!["starting".into()]));
    assert_eq!(world.count_everywhere("Spawn"), 0);
}

// ---- a failing attempt --------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn a_panicking_attempt_does_not_strand_its_host() {
    let (world, port) = machine(&[("h1", holding(&[("k1", 11)]))]);
    world.connect_panics.store(true, Ordering::SeqCst);
    // The frozen attempt runs on its own task and nobody awaits it.
    ensure_hosts(&port).await.unwrap();
    tokio::time::sleep(SEC).await;
    assert_eq!(port.connect_count("h1"), 1, "the attempt did start, and panicked");
    assert!(port.barrier().needs_attempt_for("h1"), "the in-flight mark did not outlive the attempt");

    world.connect_panics.store(false, Ordering::SeqCst);
    rediscover_hosts(&port).await.unwrap();
    assert_eq!(port.connect_count("h1"), 2, "the host is tried again");
    assert!(port.barrier().unresolved().is_empty());
    assert_eq!(port.frozen_ids().len(), 1);
}

// ---- no ticket where keystrokes and closes flow -------------------------------

fn fn_body(src: &str, signature: &str) -> String {
    let start = src
        .find(signature)
        .unwrap_or_else(|| panic!("`{signature}` not found — this guard must fail loudly, not pass vacuously"));
    let rest = &src[start..];
    let open = rest.find('{').expect("no body");
    let mut depth = 0usize;
    for (i, c) in rest[open..].char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return rest[open..open + i + 1].to_string();
                }
            }
            _ => {}
        }
    }
    panic!("unbalanced braces after `{signature}`");
}

fn source_of(file: &str) -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("state").join(file);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read {} ({e})", path.display()))
        .replace("\r\n", "\n")
}

/// Keystrokes, resizes, closes and repaints must never be dropped because the
/// app is exiting, and listings and surfacing carry no admission either: none of
/// them may touch the admission table. (What each still does is asserted, so the
/// check cannot go vacuous if a function is emptied or renamed.)
#[test]
fn no_ticket_for_input_resize_close() {
    let terminals = source_of("terminals.rs");
    for (signature, still_does) in [
        ("pub fn host_write(", "write_stdin"),
        ("pub fn host_resize(", ".resize("),
        ("pub fn host_close(", ".close("),
        ("pub fn host_repaint(", "nudge_repaint"),
        ("pub(crate) fn surface_host_orphans(", "reserve_host_session"),
        ("async fn run_host_restore_sweep(", "list_sessions"),
    ] {
        let body = fn_body(&terminals, signature);
        assert!(body.contains(still_does), "{signature} no longer does `{still_does}` — update this census");
        for forbidden in ["host_table", ".begin(", "begin_adoption", "begin_as_quiescer", "Ticket"] {
            assert!(!body.contains(forbidden), "{signature} must not take a ticket (found `{forbidden}`)");
        }
    }
}

/// The only code in the state module that takes a ticket is adoption and the
/// router, which takes one per create.
#[test]
fn only_adoption_takes_a_ticket_in_the_state_module() {
    let mut takers = Vec::new();
    for file in [
        "terminals.rs",
        "host_port.rs",
        "host_connect.rs",
        "host_registry.rs",
        "host_adoption.rs",
        "host_routing.rs",
        "types.rs",
    ] {
        let src = source_of(file);
        for needle in [".begin(", ".begin_adoption(", ".begin_as_quiescer("] {
            if src.contains(needle) {
                takers.push(format!("{file}: {needle}"));
            }
        }
    }
    assert_eq!(
        takers,
        vec!["host_adoption.rs: .begin_adoption(".to_string(), "host_routing.rs: .begin(".to_string()]
    );
}

// ---- registry ---------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn listing_reserves_claims_on_the_listing_host_only() {
    let (_world, port) = machine(&[("h1", holding(&[("k1", 11)])), ("h2", holding(&[("k2", 22)]))]);
    ensure_hosts(&port).await.unwrap();
    tokio::time::sleep(SEC).await;
    let ids = port.frozen_ids();
    let claim = |k: &str| {
        let c = port.0.claims.get(k).unwrap();
        (c.state.clone(), c.pid, c.channel)
    };
    assert_eq!(claim("k1"), (HostSessionClaimState::Reserved, 11, HostChannel::Frozen(ids[0])));
    assert_eq!(claim("k2"), (HostSessionClaimState::Reserved, 22, HostChannel::Frozen(ids[1])));
}
