//! The reclaim registry, its cleanup owner and the claim adoption makes (plan 056 T2, T3), over
//! fake hosts. Every assertion names the host that received a frame and compares whole frames: the
//! token a host saw is the host lifecycle sentinel, never anything else.

use super::fake_hosts::*;
use super::lifecycle_tests::{machine_with_current, secs, CURRENT};
use super::*;
use crate::state::mcp_reclaim::{Claimed, McpReclaim, ReclaimBoot, ReleaseResult, SlotState, RECLAIM_LEASE};
use crate::state::mcp_snapshot_tests::{capture_logs, captured_logs};
use termflow_pty_protocol::{Control, Frame, McpHeld};

const A: &str = "host-a";
const B: &str = "host-b";

pub(super) fn held() -> McpHeld {
    McpHeld { port: 4310, configured_port: 4300, bind_host: "0.0.0.0".into() }
}

pub(super) fn holder() -> HostSpec {
    HostSpec { mcp_hold: true, mcp_held: Some(held()), ..HostSpec::default() }
}

fn millis(n: u64) -> Duration {
    Duration::from_millis(n)
}

/// Hosts that only the registry tests talk to, never adopted: nothing sends them a frame but the
/// code under test.
pub(super) fn bare(hosts: &[(&str, HostSpec)]) -> (Arc<World>, FakePort) {
    let world = World::new();
    for (name, spec) in hosts {
        world.add_host(name, spec.clone());
    }
    (world.clone(), FakePort::new(&world, CURRENT))
}

/// A connection to `host`, as adoption would make it, without any frame sent on it.
pub(super) async fn connect(port: &FakePort, host: &str, id: u64) -> PtyHostClient {
    port.connect(&candidate(host, HostRole::Frozen), HostRole::Frozen, Some((FrozenId(id), id)))
        .await
        .unwrap_or_else(|_| panic!("connect {host}"))
        .client
}

pub(super) fn claimed(client: PtyHostClient, host: &str, id: u64) -> Claimed {
    Claimed::new(held(), client, HostChannel::Frozen(FrozenId(id)), id, host.to_owned(), HOST_TOKEN.to_owned())
}

pub(super) async fn raw_claim(port: &FakePort, host: &str, id: u64) -> Claimed {
    claimed(connect(port, host, id).await, host, id)
}

/// The tokens of the `ReleaseMcp` frames `host` received.
pub(super) fn releases(world: &World, host: &str) -> Vec<String> {
    world
        .mcp_frames(host)
        .into_iter()
        .filter_map(|f| match f {
            Frame::Ctrl(Control::ReleaseMcp { token, .. }) => Some(token),
            _ => None,
        })
        .collect()
}

pub(super) async fn settle_tasks() {
    tokio::time::sleep(millis(100)).await;
}

// ---- T2: ordering ---------------------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn offer_then_decide_returns_the_claim() {
    let (world, port) = bare(&[(A, holder())]);
    let reclaim = McpReclaim::new();
    let woken = reclaim.subscribe();

    reclaim.offer(raw_claim(&port, A, 1).await);

    assert!(woken.has_changed().unwrap(), "the watch saw the stored claim");
    assert!(reclaim.has_claim());
    let mut boot = ReclaimBoot::new(reclaim.clone());
    assert_eq!(boot.decide(), Some(held()));
    assert!(!reclaim.has_claim(), "the claim moved into the guard");
    assert_eq!(releases(&world, A), Vec::<String>::new(), "deciding sends nothing");
    assert_eq!(boot.release().await, ReleaseResult::Released);
    assert_eq!(releases(&world, A), [HOST_TOKEN], "released once, with the host token");
}

#[tokio::test(start_paused = true)]
async fn late_claim_is_released_to_its_own_endpoint() {
    let (world, port) = bare(&[(A, holder()), (B, holder())]);
    let reclaim = McpReclaim::new();
    let mut boot = ReclaimBoot::new(reclaim.clone());
    assert_eq!(boot.decide(), None, "nothing was claimed when boot decided");

    reclaim.offer(raw_claim(&port, B, 2).await);
    settle_tasks().await;

    assert_eq!(releases(&world, B), [HOST_TOKEN], "the late claim went back to the host that made it, once");
    assert_eq!(releases(&world, A), Vec::<String>::new(), "and to no other");
    assert!(!reclaim.has_claim(), "a late claim is never stored");
    assert_eq!(reclaim.slot_state(), None);
}

#[tokio::test(start_paused = true)]
async fn a_claim_after_a_decided_claim_from_another_connection_is_late() {
    let (world, port) = bare(&[(A, holder()), (B, holder())]);
    let reclaim = McpReclaim::new();
    reclaim.offer(raw_claim(&port, A, 1).await);
    let mut boot = ReclaimBoot::new(reclaim.clone());
    assert!(boot.decide().is_some());

    reclaim.offer(raw_claim(&port, B, 2).await);
    settle_tasks().await;

    assert_eq!(releases(&world, B), [HOST_TOKEN]);
    assert_eq!(releases(&world, A), Vec::<String>::new(), "the decided claim is still held by the guard");
    assert_eq!(reclaim.slot_state(), Some(SlotState::Held));
}

#[tokio::test(start_paused = true)]
async fn same_connection_reoffer_keeps_the_claim() {
    let (world, port) = bare(&[(A, holder())]);
    let reclaim = McpReclaim::new();
    let first = raw_claim(&port, A, 1).await;
    let first_at = first.at;
    reclaim.offer(first);
    tokio::time::sleep(secs(10)).await;

    // The same connection reports again (a re-list, a retried unanswered host).
    reclaim.offer(raw_claim(&port, A, 1).await);
    settle_tasks().await;

    assert_eq!(releases(&world, A), Vec::<String>::new(), "a repeat is not a duplicate: nothing is released");
    assert_eq!(reclaim.slot_state(), Some(SlotState::Held));
    let mut boot = ReclaimBoot::new(reclaim.clone());
    assert_eq!(boot.decide(), Some(held()));
    assert_eq!(boot.claimed_at(), Some(first_at), "the original claim, with its original time, is the one kept");
    assert_eq!(releases(&world, A), Vec::<String>::new());
    drop(boot);
}

#[tokio::test(start_paused = true)]
async fn a_reoffer_from_the_decided_connection_sends_no_frame() {
    let (world, port) = bare(&[(A, holder())]);
    let reclaim = McpReclaim::new();
    reclaim.offer(raw_claim(&port, A, 1).await);
    let mut boot = ReclaimBoot::new(reclaim.clone());
    assert!(boot.decide().is_some());

    reclaim.offer(raw_claim(&port, A, 1).await);
    settle_tasks().await;

    assert_eq!(releases(&world, A), Vec::<String>::new());
    assert_eq!(reclaim.slot_state(), Some(SlotState::Held));
    assert_eq!(boot.release().await, ReleaseResult::Released);
    assert_eq!(releases(&world, A), [HOST_TOKEN], "and the one claim is released once");
}

#[tokio::test(start_paused = true)]
async fn an_offer_from_another_connection_before_the_decision_is_released_alone() {
    let (world, port) = bare(&[(A, holder()), (B, holder())]);
    let reclaim = McpReclaim::new();
    reclaim.offer(raw_claim(&port, A, 1).await);

    reclaim.offer(raw_claim(&port, B, 2).await);
    settle_tasks().await;

    assert_eq!(releases(&world, B), [HOST_TOKEN], "only the second is released");
    assert_eq!(releases(&world, A), Vec::<String>::new());
    let mut boot = ReclaimBoot::new(reclaim.clone());
    assert_eq!(boot.decide(), Some(held()), "the first is still the stored claim");
    drop(boot);
}

// ---- T2: releases ---------------------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn release_survives_caller_cancellation() {
    let (world, port) = bare(&[(A, holder())]);
    let gate = Arc::new(EventGate::default());
    world.gate_release_acks(A, &gate);
    let reclaim = McpReclaim::new();
    reclaim.offer(raw_claim(&port, A, 1).await);
    let mut boot = ReclaimBoot::new(reclaim.clone());

    let waiting = tokio::spawn(async move { boot.release().await });
    gate.wait_reached(1).await;
    waiting.abort();
    assert!(waiting.await.unwrap_err().is_cancelled());
    gate.release();
    settle_tasks().await;

    assert_eq!(reclaim.slot_state(), Some(SlotState::Released), "the release completed without its caller");
    assert_eq!(releases(&world, A), [HOST_TOKEN], "and was sent once");
}

#[tokio::test(start_paused = true)]
async fn a_release_that_is_not_acknowledged_ends_unconfirmed_and_ends_the_lease() {
    let (world, port) = bare(&[(A, HostSpec { mcp_silent: true, ..holder() })]);
    let reclaim = McpReclaim::new();
    let client = connect(&port, A, 1).await;
    let (channel, epoch) = (HostChannel::Frozen(FrozenId(1)), 1);
    reclaim.offer(claimed(client.clone(), A, 1));
    assert!(reclaim.lease_on(channel, epoch));
    let mut boot = ReclaimBoot::new(reclaim.clone());

    assert_eq!(boot.release().await, ReleaseResult::Unconfirmed);

    assert_eq!(reclaim.slot_state(), Some(SlotState::Unconfirmed));
    assert!(!reclaim.lease_on(channel, epoch), "a holder we could not reach is not waited for");
    assert_eq!(releases(&world, A), [HOST_TOKEN], "the frame was sent once");
    assert_eq!(client.pending_requests(), 0);
}

#[tokio::test(start_paused = true)]
async fn guard_drop_before_decide_releases() {
    let (world, port) = bare(&[(A, holder())]);
    let reclaim = McpReclaim::new();
    reclaim.offer(raw_claim(&port, A, 1).await);

    drop(ReclaimBoot::new(reclaim.clone()));
    settle_tasks().await;

    assert_eq!(releases(&world, A), [HOST_TOKEN], "an Open stored claim has a cleanup owner before any ticket exists");
    assert_eq!(reclaim.slot_state(), Some(SlotState::Released));
}

#[tokio::test(start_paused = true)]
async fn guard_drop_after_decide_releases() {
    let (world, port) = bare(&[(A, holder())]);
    let reclaim = McpReclaim::new();
    reclaim.offer(raw_claim(&port, A, 1).await);
    let mut boot = ReclaimBoot::new(reclaim.clone());
    assert!(boot.decide().is_some());

    drop(boot);
    settle_tasks().await;

    assert_eq!(releases(&world, A), [HOST_TOKEN]);
    assert_eq!(reclaim.slot_state(), Some(SlotState::Released));
}

#[tokio::test(start_paused = true)]
async fn a_released_guard_releases_nothing_again_on_drop() {
    let (world, port) = bare(&[(A, holder())]);
    let reclaim = McpReclaim::new();
    reclaim.offer(raw_claim(&port, A, 1).await);
    let mut boot = ReclaimBoot::new(reclaim);
    assert_eq!(boot.release().await, ReleaseResult::Released);
    assert_eq!(boot.release().await, ReleaseResult::NothingHeld);

    drop(boot);
    settle_tasks().await;

    assert_eq!(releases(&world, A), [HOST_TOKEN], "one release in all");
}

// ---- T2: the finalizer, with real runtimes ----------------------------------------------------

fn paused_runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread().enable_all().start_paused(true).build().expect("runtime")
}

const NOT_DELIVERED: &str = "[MCP] reclaim release not delivered (runtime gone)";

fn not_delivered_logged() -> bool {
    captured_logs().iter().any(|line| line == NOT_DELIVERED)
}

#[test]
fn release_from_drop_outside_runtime_is_delivered() {
    let rt = paused_runtime();
    let (world, port) = bare(&[(A, holder())]);
    let reclaim = McpReclaim::new();
    rt.block_on(async { reclaim.offer(raw_claim(&port, A, 1).await) });

    // No runtime is current on this thread: the guard drops outside it.
    drop(ReclaimBoot::new(reclaim.clone()));
    rt.block_on(settle_tasks());

    assert_eq!(releases(&world, A), [HOST_TOKEN], "delivered through the handle captured with the claim");
    assert_eq!(reclaim.slot_state(), Some(SlotState::Released));
}

#[test]
fn release_on_dead_runtime_is_unconfirmed() {
    capture_logs();
    let rt = paused_runtime();
    let (world, port) = bare(&[(A, holder())]);
    let reclaim = McpReclaim::new();
    let client = rt.block_on(connect(&port, A, 1));
    // The claim captures a runtime that is then shut down.
    let dead = paused_runtime();
    let claim = dead.block_on(async { claimed(client, A, 1) });
    drop(dead);
    reclaim.offer(claim);
    let mut boot = ReclaimBoot::new(reclaim.clone());

    let result = rt.block_on(boot.release());

    assert_eq!(result, ReleaseResult::Unconfirmed);
    assert_eq!(reclaim.slot_state(), Some(SlotState::Unconfirmed), "never left in Releasing");
    assert_eq!(releases(&world, A), Vec::<String>::new(), "nothing could be sent, and nothing was sent twice");
    assert!(not_delivered_logged(), "and it said so: {:?}", captured_logs());
}

#[test]
fn release_on_a_runtime_shut_down_before_the_first_poll_is_unconfirmed() {
    capture_logs();
    let rt = paused_runtime();
    let (world, port) = bare(&[(A, holder())]);
    let reclaim = McpReclaim::new();
    let client = rt.block_on(connect(&port, A, 1));
    // The captured runtime is alive but nothing drives it, so the spawned release is never polled.
    let idle = paused_runtime();
    let claim = idle.block_on(async { claimed(client, A, 1) });
    reclaim.offer(claim);

    drop(ReclaimBoot::new(reclaim.clone()));
    assert_eq!(reclaim.slot_state(), Some(SlotState::Releasing), "queued, not yet run");
    drop(idle);

    assert_eq!(reclaim.slot_state(), Some(SlotState::Unconfirmed));
    assert_eq!(releases(&world, A), Vec::<String>::new());
    assert!(not_delivered_logged(), "{:?}", captured_logs());
}

// ---- T2: the lease ----------------------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn lease_expires_with_grace() {
    let (_world, port) = bare(&[(A, holder())]);
    let reclaim = McpReclaim::new();
    let (channel, epoch) = (HostChannel::Frozen(FrozenId(1)), 1);
    assert!(!reclaim.lease_on(channel, epoch), "nothing is leased before a claim");
    reclaim.offer(raw_claim(&port, A, 1).await);

    assert!(reclaim.lease_on(channel, epoch));
    tokio::time::advance(RECLAIM_LEASE - secs(1)).await;
    assert!(reclaim.lease_on(channel, epoch), "still inside the holder's own grace");
    tokio::time::advance(secs(2)).await;
    assert!(!reclaim.lease_on(channel, epoch), "past the grace the holder stops by itself");
}

#[tokio::test(start_paused = true)]
async fn the_lease_is_only_for_the_claimed_connection() {
    let (_world, port) = bare(&[(A, holder())]);
    let reclaim = McpReclaim::new();
    reclaim.offer(raw_claim(&port, A, 1).await);

    assert!(reclaim.lease_on(HostChannel::Frozen(FrozenId(1)), 1));
    assert!(!reclaim.lease_on(HostChannel::Frozen(FrozenId(1)), 2), "a reconnected host's new epoch is not leased");
    assert!(!reclaim.lease_on(HostChannel::Frozen(FrozenId(2)), 1), "another host");
    assert!(!reclaim.lease_on(HostChannel::Primary, 1), "the primary");
}

#[tokio::test(start_paused = true)]
async fn the_lease_ends_when_the_release_is_acknowledged_and_holds_while_it_is_in_flight() {
    let (world, port) = bare(&[(A, holder())]);
    let gate = Arc::new(EventGate::default());
    world.gate_release_acks(A, &gate);
    let reclaim = McpReclaim::new();
    let (channel, epoch) = (HostChannel::Frozen(FrozenId(1)), 1);
    reclaim.offer(raw_claim(&port, A, 1).await);
    let mut boot = ReclaimBoot::new(reclaim.clone());
    let release = tokio::spawn(async move { boot.release().await });
    gate.wait_reached(1).await;

    assert_eq!(reclaim.slot_state(), Some(SlotState::Releasing));
    assert!(reclaim.lease_on(channel, epoch), "a release in flight still shields the host");
    gate.release();
    assert_eq!(release.await.unwrap(), ReleaseResult::Released);

    assert!(!reclaim.lease_on(channel, epoch), "released: nothing left to wait for");
}

// ---- T3: the claim settle makes ---------------------------------------------------------------------

/// The MCP-hold and lifecycle kinds of `host`, in the order it received them.
fn order(world: &World, host: &str) -> Vec<&'static str> {
    world.lifecycle_kinds(host)
}

fn claim_tokens(world: &World, host: &str) -> Vec<String> {
    world
        .mcp_frames(host)
        .into_iter()
        .filter_map(|f| match f {
            Frame::Ctrl(Control::ClaimMcp { token, .. }) => Some(token),
            _ => None,
        })
        .collect()
}

#[tokio::test(start_paused = true)]
async fn settle_claims_before_disarm_with_host_token() {
    let (world, port) = machine_with_current(HostSpec::default(), &[("h1", holder())]);

    rediscover_hosts(&port).await.unwrap();

    let sent = world.mcp_frames("h1");
    assert_eq!(sent.len(), 1, "one claim: {sent:?}");
    let Frame::Ctrl(Control::ClaimMcp { req, token }) = &sent[0] else { panic!("not a claim: {:?}", sent[0]) };
    assert_eq!(sent[0], Frame::Ctrl(Control::ClaimMcp { req: *req, token: HOST_TOKEN.into() }), "whole frame");
    assert_eq!(token, HOST_TOKEN, "the host lifecycle token, not a sidecar bearer");
    assert_eq!(&order(&world, "h1")[..3], ["ClaimMcp", "Disarm", "List"], "the claim is the first lifecycle frame");
    assert_eq!(world.mcp_state("h1"), McpState::Running(McpRunning::Handback), "the Disarm left the claimed holder alone");
    let h1 = port.frozen_hosts().into_iter().next().expect("adopted");
    let channel = HostChannel::Frozen(h1.id);
    assert!(
        port.reclaim().lease_on(channel, port.table().epoch(channel).unwrap()),
        "the registry names the connection the holder is serving through"
    );
    assert!(port.reclaim().has_claim());
}

#[tokio::test(start_paused = true)]
async fn the_disarm_waits_for_the_claims_answer() {
    let (world, port) = machine_with_current(HostSpec::default(), &[("h1", holder())]);
    let gate = Arc::new(EventGate::default());
    world.gate_claim_acks("h1", &gate);
    let adoption = tokio::spawn({
        let port = port.clone();
        async move { rediscover_hosts(&port).await }
    });
    gate.wait_reached(1).await;
    tokio::time::sleep(secs(1)).await;

    assert_eq!(order(&world, "h1"), ["ClaimMcp"], "the claim is out and unanswered: no Disarm and no listing yet");
    assert_eq!(world.mcp_state("h1"), McpState::Running(McpRunning::Handback));
    gate.release();
    adoption.await.unwrap().unwrap();

    assert_eq!(&order(&world, "h1")[..3], ["ClaimMcp", "Disarm", "List"]);
    assert!(port.reclaim().has_claim());
}

#[tokio::test(start_paused = true)]
async fn the_current_host_is_claimed_the_same_way() {
    let (world, port) = machine_with_current(holder(), &[]);

    rediscover_hosts(&port).await.unwrap();

    assert_eq!(&order(&world, CURRENT)[..3], ["ClaimMcp", "Disarm", "List"]);
    assert_eq!(claim_tokens(&world, CURRENT), [HOST_TOKEN]);
    assert_eq!(world.mcp_state(CURRENT), McpState::Running(McpRunning::Handback));
    assert!(port.reclaim().lease_on(HostChannel::Primary, port.table().epoch(HostChannel::Primary).unwrap()));
}

#[tokio::test(start_paused = true)]
async fn incapable_host_is_never_claimed() {
    // The same host spec, without the bit: nothing reaches it that it cannot decode (AC9).
    let old = HostSpec { mcp_hold: false, mcp_held: Some(held()), ..HostSpec::default() };
    let (world, port) = machine_with_current(HostSpec { mcp_hold: false, ..holder() }, &[("h1", old)]);

    rediscover_hosts(&port).await.unwrap();

    for host in ["h1", CURRENT] {
        assert_eq!(order(&world, host), ["Disarm", "List"], "{host}: today's order, and no MCP frame at all");
        assert_eq!(world.mcp_frames(host), Vec::<Frame>::new(), "{host}");
        assert!(!world.kinds(host).contains(&"Eof"), "{host}: the connection was not dropped");
    }
    assert!(!port.reclaim().has_claim());
}

#[tokio::test(start_paused = true)]
async fn a_host_holding_nothing_is_claimed_and_records_nothing() {
    let (world, port) = machine_with_current(HostSpec::default(), &[("h1", HostSpec { mcp_hold: true, ..HostSpec::default() })]);

    rediscover_hosts(&port).await.unwrap();

    assert_eq!(&order(&world, "h1")[..3], ["ClaimMcp", "Disarm", "List"]);
    assert!(!port.reclaim().has_claim());
}

#[tokio::test(start_paused = true)]
async fn an_unanswered_claim_changes_nothing_after_it() {
    let silent = HostSpec { mcp_silent: true, ..holder() };
    let (world, port) = machine_with_current(HostSpec::default(), &[("h1", silent)]);

    rediscover_hosts(&port).await.unwrap();

    assert_eq!(&order(&world, "h1")[..3], ["ClaimMcp", "Disarm", "List"], "the Disarm and listing follow the timed-out claim");
    assert!(!port.reclaim().has_claim(), "no answer, no claim");
    assert!(port.barrier().unresolved().is_empty(), "and the host was listed");
}

#[tokio::test(start_paused = true)]
async fn frozen_holder_claim_is_leased_before_the_ticker() {
    let (_world, port) = machine_with_current(HostSpec::default(), &[("h1", holder()), ("h2", HostSpec::default())]);

    rediscover_hosts(&port).await.unwrap();

    let leased = port.0.lease_at_adoption.lock().unwrap().clone();
    let id_of = |endpoint: &str| port.frozen_hosts().into_iter().find(|h| h.endpoint == endpoint).expect("adopted").id;
    assert!(leased.contains(&(id_of("h1"), true)), "the holder was leased when frozen_adopted ran: {leased:?}");
    assert!(leased.contains(&(id_of("h2"), false)), "and a host that holds nothing was not");
}

#[tokio::test(start_paused = true)]
async fn relist_does_not_release_the_claim() {
    // The first listing is never answered, so the host is adopted unresolved; the re-list runs on the
    // same connection and claims again.
    let slow = HostSpec { list: ListBehavior::SilentFor(secs(40)), ..holder() };
    let (world, port) = machine_with_current(HostSpec::default(), &[("h1", slow)]);
    rediscover_hosts(&port).await.unwrap();
    assert!(!port.barrier().unresolved().is_empty(), "the premise: the first listing went unanswered");
    assert_eq!(claim_tokens(&world, "h1"), [HOST_TOKEN]);
    tokio::time::sleep(secs(40)).await;

    rediscover_hosts(&port).await.unwrap();

    assert_eq!(claim_tokens(&world, "h1"), [HOST_TOKEN, HOST_TOKEN], "claimed again on the same connection");
    assert_eq!(world.count("h1", "ReleaseMcp"), 0, "the repeat is no duplicate: no ReleaseMcp");
    assert_eq!(world.mcp_state("h1"), McpState::Running(McpRunning::Handback));
    let h1 = port.frozen_hosts().into_iter().next().expect("adopted");
    let channel = HostChannel::Frozen(h1.id);
    assert!(port.reclaim().lease_on(channel, port.table().epoch(channel).unwrap()));
    assert!(port.reclaim().has_claim());
}

#[tokio::test(start_paused = true)]
async fn pending_closes_may_precede_the_claim_but_the_claim_precedes_disarm() {
    let (world, port) = machine_with_current(HostSpec::default(), &[("h1", holder())]);
    // A close owed to the host from before the connection existed; the first frozen host gets id 1.
    port.table().keys().close(HostChannel::Frozen(FrozenId(1)), "tm-owed");

    rediscover_hosts(&port).await.unwrap();

    let kinds = world.kinds("h1");
    let at = |kind: &str| kinds.iter().position(|k| *k == kind).unwrap_or_else(|| panic!("no {kind} in {kinds:?}"));
    assert!(at("Close") < at("ClaimMcp"), "the owed close was drained first: {kinds:?}");
    assert!(at("ClaimMcp") < at("Disarm"), "and the claim still precedes the Disarm: {kinds:?}");
    assert_eq!(world.mcp_state("h1"), McpState::Running(McpRunning::Handback));
}
