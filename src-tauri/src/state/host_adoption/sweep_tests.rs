//! The periodic sweep over every host. Assertions name the host that received a
//! frame or whose session was surfaced: a sweep that only ever looked at the
//! primary, or that treated "no answer" as "nothing there", passes any test that
//! does not.

use super::fake_hosts::*;
use super::*;
use crate::state::host_registry;
use crate::state::host_routing::{place, Placement};
use std::time::Instant as StdInstant;
use super::reconnect::SWEEP_RECONNECT_WAIT;

const CURRENT: &str = "cur";
const SEC: Duration = Duration::from_secs(1);

fn secs(n: u64) -> Duration {
    Duration::from_secs(n)
}

fn holding(keys: &[(&str, u32)]) -> HostSpec {
    HostSpec { sessions: keys.iter().map(|(k, pid)| meta(k, *pid)).collect(), ..HostSpec::default() }
}

fn machine(current: HostSpec, old: &[(&str, HostSpec)]) -> (Arc<World>, FakePort) {
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
    (world, port)
}

fn frozen_channel(port: &FakePort, endpoint: &str) -> HostChannel {
    HostChannel::Frozen(port.frozen_hosts().iter().find(|h| h.endpoint == endpoint).expect("registered").id)
}

fn recovered(port: &FakePort) -> Vec<String> {
    port.0.recovered.lock().unwrap().clone()
}

// ---- rediscovery ------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn busy_legacy_host_adopted_on_a_later_tick() {
    // The old host exists but cannot be connected to yet: busy, or still starting.
    let busy = HostSpec { unreachable: true, ..holding(&[("tm-old", 41)]) };
    let (world, port) = machine(HostSpec::default(), &[("legacy", busy)]);

    assert!(!sweep(&port).await, "a host that could not be reached means the sweep is not done");
    assert!(port.frozen_hosts().is_empty());
    assert_eq!(port.barrier().unresolved().len(), 1, "it is known, and held unresolved");
    let discovered = port.0.discovers.load(std::sync::atomic::Ordering::SeqCst);

    // Next tick it answers.
    world.set_unreachable("legacy", false);
    tokio::time::sleep(secs(60)).await;
    assert!(sweep(&port).await, "every host is in hand now");
    assert!(port.0.discovers.load(std::sync::atomic::Ordering::SeqCst) > discovered, "each tick rediscovers");
    let legacy = frozen_channel(&port, "legacy");
    assert_eq!(port.0.claims.get("tm-old").map(|c| c.channel), Some(legacy), "its session is reserved on it");
    assert!(port.barrier().unresolved().is_empty());
    assert_eq!(world.count_everywhere("Spawn"), 0);
    assert_eq!(recovered(&port), vec!["tm-old".to_string()], "and, unclaimed, it is offered to the user");
}

#[tokio::test(start_paused = true)]
async fn a_dropped_older_host_is_reconnected_by_the_sweep() {
    let (world, port) = machine(HostSpec::default(), &[("h1", holding(&[("k1", 11)]))]);
    ensure_hosts(&port).await.unwrap();
    tokio::time::sleep(SEC).await;
    let h1 = frozen_channel(&port, "h1");
    port.register_terminal("pc-1", "k1", h1);
    world.kill_connections("h1");
    tokio::time::sleep(SEC).await;
    assert!(!port.frozen_hosts()[0].client.is_alive());

    // Its own reconnect is not running (it never started, or gave up): the sweep retries it.
    assert!(sweep(&port).await);
    assert!(port.frozen_hosts()[0].client.is_alive(), "reconnected under the same id");
    assert_eq!(frozen_channel(&port, "h1"), h1);
    assert_eq!(world.sessions("h1", "Attach"), vec!["k1".to_string()], "and its pane was reattached on it");
    assert!(recovered(&port).is_empty());
}

// ---- surfacing ------------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn orphan_on_frozen_surfaced_with_channel() {
    let (_world, port) = machine(holding(&[("tm-stray-p", 5)]), &[("h1", holding(&[("tm-stray-1", 6)]))]);
    ensure_hosts(&port).await.unwrap();
    tokio::time::sleep(SEC).await;
    let h1 = frozen_channel(&port, "h1");
    // Nothing is reserved when the sweep gets to them, so the reservation made when
    // a session is surfaced is the only thing that can name the host it lives on.
    port.0.claims.clear();

    assert!(sweep(&port).await);

    let mut surfaced = recovered(&port);
    surfaced.sort();
    assert_eq!(surfaced, vec!["tm-stray-1".to_string(), "tm-stray-p".to_string()]);
    let claim = |key: &str| port.0.claims.get(key).map(|c| (c.pid, c.channel));
    assert_eq!(claim("tm-stray-1"), Some((6, h1)), "the older host's session is reserved on the older host");
    assert_eq!(claim("tm-stray-p"), Some((5, HostChannel::Primary)));
}

#[tokio::test(start_paused = true)]
async fn a_session_another_host_has_registered_is_not_surfaced_by_this_one() {
    // The current host runs a pane for tm-dup; the older host lists the same key.
    let (_world, port) = machine(HostSpec::default(), &[("h1", holding(&[("tm-dup", 71)]))]);
    port.register_terminal("pc-1", "tm-dup", HostChannel::Primary);
    ensure_hosts(&port).await.unwrap();
    tokio::time::sleep(SEC).await;
    port.0.claims.clear();

    assert!(sweep(&port).await);
    assert!(recovered(&port).is_empty(), "a registration on any channel suppresses the recovery tab");
}

#[tokio::test(start_paused = true)]
async fn unanswered_keeps_sweep_retryable() {
    // h1 answered when it was adopted and then stops answering; h2 never did.
    let silent_later = HostSpec { list: ListBehavior::AnswerFirst(1), ..holding(&[("k1", 11)]) };
    let never = HostSpec { list: ListBehavior::Never, ..holding(&[("k2", 22)]) };
    let (world, port) = machine(holding(&[("tm-stray", 5)]), &[("h1", silent_later), ("h2", never)]);
    ensure_hosts(&port).await.unwrap();
    tokio::time::sleep(secs(15)).await;
    let h1 = frozen_channel(&port, "h1");
    port.register_terminal("pc-1", "k1", h1);

    assert!(!sweep(&port).await, "an unanswered listing is unknown: the sweep must be tried again");
    // Not empty: the pane on the host that did not answer is not lost, and not closed.
    assert!(port.0.host_terminals.contains_key("pc-1"));
    assert!(port.0.torn_down.lock().unwrap().is_empty());
    assert_eq!(world.count("h1", "Close"), 0);
    // The hosts that did answer are still swept.
    assert_eq!(recovered(&port), vec!["tm-stray".to_string()]);

    // And "again" works: a host that was only slow is in hand on a later tick.
    let (world, port) = machine(
        HostSpec::default(),
        &[("slow", HostSpec { list: ListBehavior::SilentFor(secs(100)), ..holding(&[("k3", 33)]) })],
    );
    assert!(!sweep(&port).await);
    assert!(port.barrier().needs_attempt(), "the host is owed another attempt");
    tokio::time::sleep(secs(100)).await;
    assert!(sweep(&port).await, "answered this time");
    assert_eq!(recovered(&port), vec!["k3".to_string()]);
    assert_eq!(world.count_everywhere("Spawn"), 0);
}

#[tokio::test(start_paused = true)]
async fn orphan_sweep_does_not_surface_a_restoring_key_on_a_frozen_host() {
    // The older host holds two live sessions no pane has claimed yet. One belongs to
    // a restored pane that is still waiting; the other is a genuine stray.
    let (world, port) = machine(HostSpec::default(), &[("h1", holding(&[("tm-wait", 5), ("tm-stray", 6)]))]);
    ensure_hosts(&port).await.unwrap();
    tokio::time::sleep(SEC).await;
    let h1 = frozen_channel(&port, "h1");
    assert!(host_registry::register_restoring_leaf(&port.intent_maps(), "tm-wait", None, StdInstant::now()));

    assert!(sweep(&port).await);
    assert_eq!(recovered(&port), vec!["tm-stray".to_string()], "the waiting pane's session is not turned into a recovered tab");

    // The waiting pane still gets its own session: an Attach to the older host, no Spawn anywhere.
    let session_key = "tm-wait";
    match place(&port, session_key, false).await {
        Ok(Placement::Attach { channel, client, pid, ticket }) => {
            assert_eq!((channel, pid), (h1, 5));
            client.attach_confirmed(session_key, 0).await;
            drop(ticket);
        }
        Ok(Placement::Spawn { channel, .. }) => panic!("the restored pane was spawned fresh on {channel:?}"),
        Ok(Placement::InProcess { reason }) => panic!("fell back in-process: {reason}"),
        Err(e) => panic!("create refused: {e}"),
    }
    assert_eq!(world.sessions("h1", "Attach"), vec!["tm-wait".to_string()]);
    assert_eq!(world.count_everywhere("Spawn"), 0, "no Spawn frame for the key, on any host");
}

#[tokio::test(start_paused = true)]
async fn sweep_does_not_surface_a_superseded_or_retired_hosts_answer() {
    for retire in [false, true] {
        let delayed = HostSpec {
            list: ListBehavior::SlowAfter { answered: 1, delay: secs(2) },
            ..holding(&[("tm-stray", 61)])
        };
        let (world, port) = machine(HostSpec::default(), &[("h1", delayed)]);
        rediscover_hosts(&port).await.unwrap();
        let channel = frozen_channel(&port, "h1");
        port.0.claims.clear();
        let running = tokio::spawn({ let port = port.clone(); async move { sweep(&port).await } });
        while world.count("h1", "List") < 2 { tokio::task::yield_now().await; }
        if retire {
            port.table().drain_host(channel).unwrap().retire();
        } else {
            let epoch = port.table().reserve_epoch();
            assert!(port.table().publish(channel, epoch));
        }
        assert!(!running.await.unwrap(), "a stale answer leaves the sweep retryable");
        assert!(recovered(&port).is_empty(), "the old answer must not emit a recovery tab");
        assert!(!port.0.claims.contains_key("tm-stray"), "nor reserve a session on a stale host");
    }
}

// ---- a host that cannot be connected ----------------------------------------------------

#[tokio::test(start_paused = true)]
async fn a_host_that_cannot_be_connected_does_not_stall_the_sweep_of_the_others() {
    // "stuck" is registered and its process is alive, but nothing can connect to it:
    // its reconnect takes the better part of a minute to give up. "ok" is connected
    // and holds a session no pane claims.
    let (world, port) = machine(
        HostSpec::default(),
        &[("stuck", holding(&[("k9", 9)])), ("ok", holding(&[("tm-stray", 6)]))],
    );
    ensure_hosts(&port).await.unwrap();
    tokio::time::sleep(SEC).await;
    port.0.claims.clear();
    world.kill_connections("stuck");
    world.set_unreachable("stuck", true);
    tokio::time::sleep(SEC).await;
    assert!(!port.frozen_hosts().iter().find(|h| h.endpoint == "stuck").unwrap().client.is_alive());

    let tick = tokio::time::Instant::now();
    let complete = sweep(&port).await;
    let took = tick.elapsed();

    assert!(!complete, "the host that could not be reached means the sweep is not done");
    assert!(took >= SWEEP_RECONNECT_WAIT, "it gave the reconnect its chance first: {took:?}");
    assert!(took < SWEEP_RECONNECT_WAIT + secs(2), "and then went on instead of waiting out the whole backoff: {took:?}");
    assert_eq!(recovered(&port), vec!["tm-stray".to_string()], "the host that could be reached was swept in the same tick");

    // The reconnect carries on by itself, and the next tick does not start another.
    assert!(!sweep(&port).await);
    assert_eq!(world.count("stuck", "List"), 1, "only the adoption listed it");
    world.set_unreachable("stuck", false);
    tokio::time::sleep(secs(60)).await;
    let stuck = port.frozen_hosts().into_iter().find(|h| h.endpoint == "stuck").unwrap();
    assert!(stuck.client.is_alive(), "it is back once it can be reached");
    assert!(sweep(&port).await, "and a later tick finds everything in hand");
}
