//! Recovery of a dropped host connection, per host: every assertion names the
//! host that received a frame and the pane that was or was not closed, because
//! one host's recovery acting on another host's panes is the defect under test.

use super::fake_hosts::*;
use super::reconnect::FrozenReconnect;
use super::*;
use crate::state::host_lifecycle::{offload_refusal, owned_hosts_now, OwnedHost};
use crate::state::host_table::QuiesceReason;
use crate::state::source_scan::{fn_body, production};

const CURRENT: &str = "cur";
const SEC: Duration = Duration::from_secs(1);

fn secs(n: u64) -> Duration {
    Duration::from_secs(n)
}

fn holding(keys: &[(&str, u32)]) -> HostSpec {
    HostSpec { sessions: keys.iter().map(|(k, pid)| meta(k, *pid)).collect(), ..HostSpec::default() }
}

/// The current host plus these older hosts, all adopted.
async fn adopted(current: HostSpec, old: &[(&str, HostSpec)]) -> (Arc<World>, FakePort) {
    let world = World::new();
    world.add_host(CURRENT, current);
    let mut candidates = Vec::new();
    for (name, spec) in old {
        world.add_host(name, spec.clone());
        candidates.push(candidate(name, HostRole::Frozen));
    }
    candidates.push(candidate(CURRENT, HostRole::Current));
    let port = FakePort::new(&world, CURRENT);
    port.set_candidates(candidates);
    ensure_hosts(&port).await.unwrap();
    tokio::time::sleep(SEC).await;
    (world, port)
}

fn frozen_id(port: &FakePort, endpoint: &str) -> FrozenId {
    port.frozen_hosts().iter().find(|h| h.endpoint == endpoint).expect("registered").id
}

/// The epoch of the connection currently published for the older host.
fn epoch_of(port: &FakePort, id: FrozenId) -> u64 {
    port.0.table.epoch(HostChannel::Frozen(id)).expect("published")
}

/// The host's connection drops, as it does when its process or the pipe dies.
async fn drop_connection(world: &World, endpoint: &str) {
    world.kill_connections(endpoint);
    tokio::time::sleep(SEC).await;
}

fn torn_down(port: &FakePort) -> Vec<String> {
    port.0.torn_down.lock().unwrap().clone()
}

// ---- the primary's recovery leaves older hosts' panes alone --------------------

#[tokio::test(start_paused = true)]
async fn primary_listing_does_not_teardown_frozen_tabs() {
    let (world, port) = adopted(HostSpec::default(), &[("h1", holding(&[("k1", 11)]))]).await;
    let h1 = HostChannel::Frozen(frozen_id(&port, "h1"));
    port.register_terminal("pc-p", "tm-p", HostChannel::Primary);
    port.register_terminal("pc-1", "k1", h1);

    // The primary's pipe drops and the host that answers holds nothing of ours.
    drop_connection(&world, CURRENT).await;
    port.drop_current();
    reconnect_primary(&port, &[500, 1000]).await;

    assert_eq!(torn_down(&port), vec!["pc-p".to_string()], "only the primary's own pane is lost");
    assert!(port.0.host_terminals.contains_key("pc-1"), "the older host's pane is untouched");
    assert_eq!(world.count("h1", "Close"), 0);
    assert_eq!(world.count("h1", "Attach"), 0);
}

#[tokio::test(start_paused = true)]
async fn primary_recovery_reattaches_its_own_panes_and_only_those() {
    let (world, port) = adopted(holding(&[("tm-p", 5)]), &[("h1", holding(&[("k1", 11)]))]).await;
    let h1 = HostChannel::Frozen(frozen_id(&port, "h1"));
    port.register_terminal("pc-p", "tm-p", HostChannel::Primary);
    port.register_terminal("pc-1", "k1", h1);

    drop_connection(&world, CURRENT).await;
    port.drop_current();
    reconnect_primary(&port, &[500, 1000]).await;

    assert!(torn_down(&port).is_empty());
    assert_eq!(world.sessions(CURRENT, "Attach"), vec!["tm-p".to_string()], "reattached on the primary");
    assert_eq!(world.count("h1", "Attach"), 0, "and nothing was attached on the older host");
}

#[tokio::test(start_paused = true)]
async fn a_primary_that_cannot_be_reached_closes_its_panes_by_process_id() {
    // The pane's session key (tm-p) is not its process id (pc-p): closing the pane
    // by the key it is known to the host by would close nothing.
    let (world, port) = adopted(HostSpec::default(), &[("h1", holding(&[("k1", 11)]))]).await;
    let h1 = HostChannel::Frozen(frozen_id(&port, "h1"));
    port.register_terminal("pc-p", "tm-p", HostChannel::Primary);
    port.register_terminal("pc-1", "k1", h1);

    drop_connection(&world, CURRENT).await;
    port.drop_current();
    world.set_unreachable(CURRENT, true);
    reconnect_primary(&port, &[500, 1000]).await;

    assert_eq!(torn_down(&port), vec!["pc-p".to_string()]);
    assert!(port.0.host_terminals.contains_key("pc-1"));
}

// ---- an older host recovers on its own ---------------------------------------------

#[tokio::test(start_paused = true)]
async fn reconnect_frozen_tears_down_only_own() {
    let (world, port) = adopted(
        holding(&[("tm-p", 5)]),
        &[("h1", holding(&[("k1", 11), ("k1b", 12)])), ("h2", holding(&[("k2", 22)]))],
    )
    .await;
    let (id1, id2) = (frozen_id(&port, "h1"), frozen_id(&port, "h2"));
    let h1 = HostChannel::Frozen(id1);
    port.register_terminal("pc-p", "tm-p", HostChannel::Primary);
    port.register_terminal("pc-1", "k1", h1);
    port.register_terminal("pc-1b", "k1b", h1);
    port.register_terminal("pc-2", "k2", HostChannel::Frozen(id2));
    let lost = epoch_of(&port, id1);

    // h1's connection drops; when it is back it no longer holds k1b.
    drop_connection(&world, "h1").await;
    world.add_host("h1", holding(&[("k1", 11)]));
    let outcome = reconnect_frozen(&port, id1, lost, &[500]).await;
    tokio::time::sleep(SEC).await;

    assert_eq!(outcome, FrozenReconnect::Reconnected);
    assert_eq!(torn_down(&port), vec!["pc-1b".to_string()], "only the pane h1 lost");
    assert_eq!(world.sessions("h1", "Attach"), vec!["k1".to_string()], "the pane it still holds is reattached on h1");
    assert_eq!(world.count("h2", "Attach"), 0);
    assert_eq!(world.count(CURRENT, "Attach"), 0);
    for kept in ["pc-p", "pc-1", "pc-2"] {
        assert!(port.0.host_terminals.contains_key(kept), "{kept} must survive another host's recovery");
    }
    // The host is a connected, resolved, current member of the registry again.
    let host = port.frozen_hosts().into_iter().find(|h| h.id == id1).unwrap();
    assert!(host.client.is_alive());
    assert_ne!(host.epoch, lost, "the new connection replaced the old one under the same id");
    assert!(port.0.table.is_current(h1, host.epoch));
    assert!(port.barrier().unresolved().is_empty());
    assert_eq!(port.frozen_hosts().len(), 2, "reconnected in place, not registered a second time");
}

#[tokio::test(start_paused = true)]
async fn reconnect_after_retire_is_noop() {
    let (world, port) = adopted(HostSpec::default(), &[("h1", holding(&[("k1", 11)]))]).await;
    let id = frozen_id(&port, "h1");
    let h1 = HostChannel::Frozen(id);
    port.register_terminal("pc-1", "k1", h1);
    let lost = epoch_of(&port, id);
    drop_connection(&world, "h1").await;

    // The host is retired before its reconnect gets going.
    port.0.table.drain_host(h1).unwrap().retire();
    let connects = port.connect_count("h1");
    assert_eq!(reconnect_frozen(&port, id, lost, &[500, 1000]).await, FrozenReconnect::Inert);
    assert_eq!(port.connect_count("h1"), connects, "no connection was attempted to a retired host");
    assert_eq!(port.0.table.admission(h1), Some(Admission::Retired), "and it was not reopened");
    assert!(torn_down(&port).is_empty());

    // The same when it is retired while a reconnect is backing off.
    let (world, port) = adopted(HostSpec::default(), &[("h2", holding(&[("k2", 22)]))]).await;
    let id = frozen_id(&port, "h2");
    let h2 = HostChannel::Frozen(id);
    port.register_terminal("pc-2", "k2", h2);
    let lost = epoch_of(&port, id);
    drop_connection(&world, "h2").await;
    world.set_unreachable("h2", true);
    let reconnect = tokio::spawn({
        let port = port.clone();
        async move { reconnect_frozen(&port, id, lost, &[500, 1000, 2000]).await }
    });
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!reconnect.is_finished(), "it is backing off");
    port.0.table.drain_host(h2).unwrap().retire();
    world.set_unreachable("h2", false);
    assert_eq!(reconnect.await.unwrap(), FrozenReconnect::Inert);
    assert_eq!(port.connect_count("h2"), 2, "the adoption and the one attempt before the retire");
    assert!(torn_down(&port).is_empty(), "a retired host's panes are not this reconnect's to close");
    assert_eq!(port.0.table.admission(h2), Some(Admission::Retired));
}

#[tokio::test(start_paused = true)]
async fn a_stale_connections_reconnect_and_a_second_reconnect_are_inert() {
    let (world, port) = adopted(HostSpec::default(), &[("h1", holding(&[("k1", 11)]))]).await;
    let id = frozen_id(&port, "h1");
    let lost = epoch_of(&port, id);
    drop_connection(&world, "h1").await;

    // A reconnect for a connection that is not the published one does nothing.
    assert_eq!(reconnect_frozen(&port, id, lost + 100, &[500]).await, FrozenReconnect::Inert);
    assert_eq!(port.connect_count("h1"), 1);

    // Only one reconnect of a host runs at a time, whoever asked.
    world.set_unreachable("h1", true);
    let first = tokio::spawn({
        let port = port.clone();
        async move { reconnect_frozen(&port, id, lost, &[500, 1000]).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(reconnect_frozen(&port, id, lost, &[500]).await, FrozenReconnect::Inert);
    first.abort();
}

#[tokio::test(start_paused = true)]
async fn the_drop_callback_of_a_retired_host_does_nothing() {
    let (_world, port) = adopted(HostSpec::default(), &[("h1", holding(&[("k1", 11)]))]).await;
    let id = frozen_id(&port, "h1");
    let h1 = HostChannel::Frozen(id);
    let epoch = epoch_of(&port, id);
    port.0.table.drain_host(h1).unwrap().retire();

    assert!(
        !frozen_connection_lost(&port.0.table, &port.0.barrier, id, epoch, "h1"),
        "a retired host's connection ending is expected, not a loss to recover from"
    );
    assert!(port.barrier().unresolved().is_empty(), "and it is not made unresolved again");
}

// ---- busy is not failure -------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn busy_refusal_during_quiesce_does_not_consume_reconnect_backoff_or_tear_down_panes() {
    // The primary.
    let (world, port) = adopted(holding(&[("tm-p", 5)]), &[]).await;
    port.register_terminal("pc-p", "tm-p", HostChannel::Primary);
    drop_connection(&world, CURRENT).await;
    port.drop_current();
    let guard = port.0.table.quiesce(QuiesceReason::Offload, secs(1)).await.unwrap();
    let reconnect = tokio::spawn({
        let port = port.clone();
        async move { reconnect_primary(&port, &[500, 1000]).await }
    });

    // Far longer than the whole backoff (1.5 s): a refusal that used up steps would
    // have given up and closed the pane by now.
    tokio::time::sleep(secs(20)).await;
    assert!(!reconnect.is_finished(), "it waits for admission to reopen");
    assert_eq!(port.connect_count(CURRENT), 1, "no connection is attempted while admission is closed");
    assert!(torn_down(&port).is_empty());
    drop(guard);
    tokio::time::sleep(secs(2)).await;
    reconnect.await.unwrap();
    assert_eq!(port.connect_count(CURRENT), 2, "one real attempt, with the whole backoff still ahead of it");
    assert!(torn_down(&port).is_empty());
    assert_eq!(world.sessions(CURRENT, "Attach"), vec!["tm-p".to_string()], "the pane was reattached, not closed");

    // An older host.
    let (world, port) = adopted(HostSpec::default(), &[("h1", holding(&[("k1", 11)]))]).await;
    let id = frozen_id(&port, "h1");
    port.register_terminal("pc-1", "k1", HostChannel::Frozen(id));
    let lost = epoch_of(&port, id);
    drop_connection(&world, "h1").await;
    let guard = port.0.table.quiesce(QuiesceReason::Update, secs(1)).await.unwrap();
    let reconnect = tokio::spawn({
        let port = port.clone();
        async move { reconnect_frozen(&port, id, lost, &[500, 1000]).await }
    });
    tokio::time::sleep(secs(20)).await;
    assert!(!reconnect.is_finished(), "it waits for admission to reopen");
    assert_eq!(port.connect_count("h1"), 1, "no connection is attempted while admission is closed");
    assert!(torn_down(&port).is_empty());
    drop(guard);
    tokio::time::sleep(secs(2)).await;
    assert_eq!(reconnect.await.unwrap(), FrozenReconnect::Reconnected);
    assert_eq!(port.connect_count("h1"), 2);
    assert!(torn_down(&port).is_empty());
    assert_eq!(world.sessions("h1", "Attach"), vec!["k1".to_string()]);
}

#[tokio::test(start_paused = true)]
async fn an_exit_in_progress_is_not_a_host_that_went_away() {
    let (world, port) = adopted(holding(&[("tm-p", 5)]), &[("h1", holding(&[("k1", 11)]))]).await;
    let id = frozen_id(&port, "h1");
    port.register_terminal("pc-p", "tm-p", HostChannel::Primary);
    port.register_terminal("pc-1", "k1", HostChannel::Frozen(id));
    let lost = epoch_of(&port, id);
    drop_connection(&world, CURRENT).await;
    drop_connection(&world, "h1").await;
    port.drop_current();
    let connects = (port.connect_count(CURRENT), port.connect_count("h1"));

    // Exit closes admission for good, and the hosts closing their ends is part of it.
    let _exit = port.0.table.quiesce(QuiesceReason::Exit, secs(1)).await.unwrap();
    reconnect_primary(&port, &[500, 1000]).await;
    assert_eq!(reconnect_frozen(&port, id, lost, &[500, 1000]).await, FrozenReconnect::Inert);

    assert!(torn_down(&port).is_empty(), "no pane is closed on the strength of an exit");
    assert_eq!((port.connect_count(CURRENT), port.connect_count("h1")), connects, "and nothing reconnects");
}

// ---- a host that is gone for good ----------------------------------------------------------

/// What discovery finds for an endpoint with no record and no process behind it.
fn probe_only(name: &str) -> HostCandidate {
    HostCandidate { record: None, pid: None, generation: None, ..candidate(name, HostRole::Frozen) }
}

#[tokio::test(start_paused = true)]
async fn crashed_frozen_host_is_dropped_and_offload_is_not_refused() {
    let (world, port) = adopted(
        HostSpec::default(),
        &[
            ("crashed", holding(&[("k1", 11)])),
            ("vanished", holding(&[("k2", 22)])),
            ("listener-down", holding(&[("k3", 33)])),
        ],
    )
    .await;
    let ids: Vec<_> = ["crashed", "vanished", "listener-down"].iter().map(|e| frozen_id(&port, e)).collect();
    for (id, (process, key)) in ids.iter().zip([("pc-1", "k1"), ("pc-2", "k2"), ("pc-3", "k3")]) {
        port.register_terminal(process, key, HostChannel::Frozen(*id));
    }
    assert!(offload_refusal(&owned_hosts_now(&port)).is_ok(), "everything is in hand before the crashes");
    let lost: Vec<_> = ids.iter().map(|id| epoch_of(&port, *id)).collect();
    for endpoint in ["crashed", "vanished", "listener-down"] {
        world.kill_connections(endpoint);
    }
    tokio::time::sleep(SEC).await;

    // crashed: its process is gone (a stale endpoint, no record, nothing alive);
    // vanished: discovery no longer sees it at all;
    // listener-down: a live process is advertised, but nothing accepts connections.
    world.add_host("crashed", HostSpec { refused: true, ..HostSpec::default() });
    world.add_host("listener-down", HostSpec { refused: true, ..HostSpec::default() });
    let mut stale = vec![probe_only("crashed"), candidate("listener-down", HostRole::Frozen)];
    stale.push(candidate(CURRENT, HostRole::Current));
    port.set_candidates(stale);

    let outcomes = [
        reconnect_frozen(&port, ids[0], lost[0], &[500, 1000]).await,
        reconnect_frozen(&port, ids[1], lost[1], &[500, 1000]).await,
        reconnect_frozen(&port, ids[2], lost[2], &[500, 1000]).await,
    ];
    assert_eq!(
        outcomes,
        [
            FrozenReconnect::GaveUp { dropped: true },
            FrozenReconnect::GaveUp { dropped: true },
            FrozenReconnect::GaveUp { dropped: false },
        ]
    );
    // Every host's panes were closed, as for a primary that cannot be reached.
    let mut closed = torn_down(&port);
    closed.sort();
    assert_eq!(closed, vec!["pc-1", "pc-2", "pc-3"]);

    // The dead ones are no longer owned, retired in the table and forgotten; the
    // one whose process is alive still is, and it is not in hand.
    let owned = owned_hosts_now(&port);
    let endpoints: Vec<_> = owned.iter().map(|o| o.endpoint.as_str()).collect();
    assert_eq!(endpoints, vec![CURRENT, "listener-down"]);
    assert!(!owned[1].connected());
    let refusal = offload_refusal(&owned).expect_err("an offload must still refuse for the host that may hold shells");
    assert!(refusal.contains("listener-down"), "and name it: {refusal}");
    assert!(!refusal.contains("crashed") && !refusal.contains("vanished"), "but not the dead ones: {refusal}");
    for dead in [ids[0], ids[1]] {
        assert_eq!(port.0.table.admission(HostChannel::Frozen(dead)), Some(Admission::Retired));
    }
    assert!(!port.barrier().is_tracked("crashed") && !port.barrier().is_tracked("vanished"));
    assert!(port.table().keys().listed().iter().all(|(channel, _)| *channel == HostChannel::Frozen(ids[2])), "nothing is still reserved on a dead host");
}

#[tokio::test(start_paused = true)]
async fn a_dropped_dead_host_leaves_nothing_that_blocks_an_offload() {
    let (world, port) = adopted(HostSpec::default(), &[("crashed", holding(&[("k1", 11)]))]).await;
    let id = frozen_id(&port, "crashed");
    let h = HostChannel::Frozen(id);
    port.register_terminal("pc-1", "k1", h);
    let lost = epoch_of(&port, id);
    drop_connection(&world, "crashed").await;
    // A close owed to the host when it died can never be delivered.
    port.table().keys().seed_pending(h, "k9");
    world.add_host("crashed", HostSpec { refused: true, ..HostSpec::default() });
    port.set_candidates(vec![candidate(CURRENT, HostRole::Current)]);

    assert_eq!(reconnect_frozen(&port, id, lost, &[500]).await, FrozenReconnect::GaveUp { dropped: true });

    let owned: Vec<OwnedHost> = owned_hosts_now(&port);
    assert_eq!(owned.len(), 1, "only the current host is owned: {:?}", owned.iter().map(|o| &o.endpoint).collect::<Vec<_>>());
    assert!(offload_refusal(&owned).is_ok(), "the dead host is not owned, so it cannot refuse an offload");
    assert_eq!(port.table().keys().state(h, "k9"), None);
    assert!(port.frozen_hosts().is_empty());
    // And a rediscovery does not bring it back while nothing lives there.
    rediscover_hosts(&port).await.unwrap();
    assert!(port.frozen_hosts().is_empty());
    assert!(offload_refusal(&owned_hosts_now(&port)).is_ok());
}

// ---- a stale answer cannot undo a newer one ----------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn a_stale_relist_of_the_current_host_does_not_overwrite_a_newer_resolved() {
    // The current host connected but never answered its listing: unresolved.
    let world = World::new();
    world.add_host(CURRENT, HostSpec { list: ListBehavior::Never, ..HostSpec::default() });
    let port = FakePort::new(&world, CURRENT);
    port.set_candidates(vec![candidate(CURRENT, HostRole::Current)]);
    ensure_hosts(&port).await.unwrap();
    assert_eq!(port.barrier().unresolved().len(), 1);

    // A create re-lists it in the background; that listing is slow to give up.
    ensure_hosts(&port).await.unwrap();
    tokio::time::sleep(SEC).await;

    // Meanwhile the connection drops and a new one is made to a host that answers.
    port.drop_current();
    world.add_host(CURRENT, HostSpec::default());
    ensure_hosts(&port).await.unwrap();
    assert!(port.barrier().unresolved().is_empty(), "the new connection's listing was answered");

    // The old listing finally gives up. It is about a connection nobody uses any
    // more, so it must not undo what the new one found out.
    tokio::time::sleep(secs(30)).await;
    assert!(port.barrier().unresolved().is_empty(), "a stale re-list must not mark the host unresolved again");
    assert!(port.barrier().wait_resolved(Duration::ZERO).await.is_ok());
}

// ---- a drop while a reconnect runs ------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn a_connection_that_drops_during_its_own_reconnect_is_reconnected_again() {
    // Every connection to h1 answers its first listing (the adoption's) and then goes
    // silent, so a reconnect spends its second listing waiting on a connection that
    // is about to die.
    let h1 = HostSpec { list: ListBehavior::AnswerFirst(1), ..holding(&[("k1", 11)]) };
    let (world, port) = adopted(HostSpec::default(), &[("h1", h1)]).await;
    let id = frozen_id(&port, "h1");
    port.register_terminal("pc-1", "k1", HostChannel::Frozen(id));
    let lost = epoch_of(&port, id);
    drop_connection(&world, "h1").await;
    let reconnect = tokio::spawn({
        let port = port.clone();
        async move { reconnect_frozen(&port, id, lost, &[500, 1000]).await }
    });
    tokio::time::sleep(secs(2)).await;
    let second = epoch_of(&port, id);
    assert_ne!(second, lost, "the reconnect has made its connection and is listing on it");
    assert!(!reconnect.is_finished());

    // That connection drops. Its drop's own reconnect finds the first one running.
    world.kill_connections("h1");
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(reconnect_frozen(&port, id, second, &[500, 1000]).await, FrozenReconnect::Inert);

    // The running one does not report the host reconnected on a connection that is
    // already dead: it goes round again for the newer drop.
    assert_eq!(reconnect.await.unwrap(), FrozenReconnect::Reconnected);
    assert_eq!(port.connect_count("h1"), 3, "the adoption, the reconnect, and the reconnect the drop asked for");
    let host = port.frozen_hosts().into_iter().find(|h| h.id == id).unwrap();
    assert!(host.client.is_alive(), "the host ends connected");
    assert!(port.0.table.is_current(HostChannel::Frozen(id), host.epoch));
    assert!(torn_down(&port).is_empty());
}

#[tokio::test]
async fn an_answered_second_listing_that_loses_its_pipe_keeps_the_queued_reconnect() {
    let gate = Arc::new(ListGate::default());
    let recovered = Arc::new(ListGate::default());
    let world = World::new();
    world.add_host(CURRENT, HostSpec::default());
    world.add_host("h1", holding(&[("k1", 731)]));
    let port = FakePort::new(&world, CURRENT);
    port.set_candidates(vec![candidate(CURRENT, HostRole::Current), candidate("h1", HostRole::Frozen)]);
    rediscover_hosts(&port).await.unwrap();
    let id = frozen_id(&port, "h1");
    let channel = HostChannel::Frozen(id);
    port.register_terminal("pc-1", "k1", channel);
    let lost = epoch_of(&port, id);
    let old_client = port.frozen_hosts().into_iter().find(|h| h.id == id).unwrap().client;
    world.kill_connections("h1");
    tokio::time::timeout(secs(2), async {
        while old_client.is_alive() { tokio::task::yield_now().await; }
    }).await.unwrap();
    world.add_host("h1", HostSpec {
        list: ListBehavior::GatedAfter { answered: 0, gate: gate.clone() },
        ..holding(&[("k1", 731)])
    });
    let reconnect = tokio::spawn({ let port = port.clone(); async move {
        reconnect_frozen(&port, id, lost, &[0]).await
    } });
    tokio::time::timeout(secs(2), gate.reached.notified()).await.unwrap();
    // Only the second listing includes this newly appeared, unclaimed shell.
    *gate.after_answer.lock().unwrap() = Some(Box::new({ let world = world.clone(); move || {
        world.begin_session("h1", meta("stale-orphan", 732));
    } }));
    gate.release.notify_one();
    tokio::time::timeout(secs(2), gate.reached.notified()).await.unwrap();
    let second = epoch_of(&port, id);
    assert_ne!(second, lost);
    *gate.after_answer.lock().unwrap() = Some(Box::new({
        let world = world.clone();
        let port = port.clone();
        let recovered = recovered.clone();
        move || {
            world.kill_connections("h1");
            world.end_session("h1", "stale-orphan");
            // Model the drop callback's reconnect notification synchronously so
            // it is queued before the answered listing is consumed.
            assert!(port.barrier().begin_reconnect(&barrier_key("h1")).is_none());
            world.add_host("h1", HostSpec {
                list: ListBehavior::GatedAfter { answered: 0, gate: recovered },
                ..holding(&[("k1", 731)])
            });
        }
    }));
    gate.release.notify_one();
    tokio::time::timeout(secs(2), recovered.reached.notified()).await.unwrap();
    assert_eq!(port.connect_count("h1"), 3, "initial adoption and both reconnects");
    assert_eq!(world.count_everywhere("Attach"), 0, "the stale listing must not reattach");
    assert_eq!(world.count_everywhere("Close"), 0);
    assert_eq!(port.0.listings.lock().unwrap().len(), 3, "current, initial frozen, and first reconnect adoption only");
    assert_eq!(port.table().keys().len(), 1, "no stale orphan keys were added");
    recovered.release.notify_one();
    // The second listing on the final connection uses the same gate.
    tokio::time::timeout(secs(2), recovered.reached.notified()).await.unwrap();
    recovered.release.notify_one();
    assert_eq!(tokio::time::timeout(secs(2), reconnect).await.unwrap().unwrap(), FrozenReconnect::Reconnected);
    let host = port.frozen_hosts().into_iter().find(|h| h.id == id).unwrap();
    assert!(host.client.is_alive());
    assert!(port.table().is_current(channel, host.epoch));
    assert_ne!(host.epoch, second);
    assert_eq!(world.sessions("h1", "Attach"), ["k1"]);
    assert!(torn_down(&port).is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_reconnect_asked_for_while_one_runs_is_not_run_a_second_time_when_the_host_is_back() {
    let (world, port) = adopted(HostSpec::default(), &[("h1", holding(&[("k1", 11)]))]).await;
    let id = frozen_id(&port, "h1");
    let lost = epoch_of(&port, id);
    drop_connection(&world, "h1").await;
    world.set_unreachable("h1", true);
    let reconnect = tokio::spawn({
        let port = port.clone();
        async move { reconnect_frozen(&port, id, lost, &[500, 1000, 2000]).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;

    // The sweep asks for the same host while it is backing off.
    assert_eq!(reconnect_frozen(&port, id, lost, &[500]).await, FrozenReconnect::Inert);
    world.set_unreachable("h1", false);

    assert_eq!(reconnect.await.unwrap(), FrozenReconnect::Reconnected);
    assert_eq!(port.connect_count("h1"), 3, "one attempt that failed and one that connected, no pass for the note left behind");
}
// ---- the application wiring --------------------------------------------------------------------

fn source_of(file: &str) -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("state").join(file);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read {} ({e})", path.display()))
        .replace("\r\n", "\n")
}

/// `AppState` is what the fake ports stand in for, and it cannot be built in a
/// unit test: pin the two places it hands a dropped connection and the periodic
/// tick to the flows tested above.
#[test]
fn a_dropped_older_host_and_the_sweep_reach_the_per_host_flows() {
    // The bodies of the functions themselves, not a stretch of text after their
    // names: a call in the next function must not satisfy these.
    let port = production(&source_of("host_port.rs"));
    let disconnect = fn_body(&port, "fn frozen_disconnect(");
    assert!(disconnect.contains("frozen_connection_lost(") && disconnect.contains("reconnect_frozen(&st, id, epoch,"));
    // The primary's own drop handler recovers the primary only.
    assert!(fn_body(&port, "fn primary_disconnect(").contains("reconnect_after_pipe_drop()"));

    let terminals = production(&source_of("terminals.rs"));
    assert!(fn_body(&terminals, "async fn run_host_restore_sweep(").contains("host_adoption::sweep(self)"));
    assert!(fn_body(&terminals, "pub async fn reconnect_after_pipe_drop(").contains("host_adoption::reconnect_primary(self,"));
}

