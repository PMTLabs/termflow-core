//! The MCP hold senders, `Hold::acked_hosts` and `choose_holder` over fake hosts (plan 055 T2).
//!
//! The fake host's MCP model is the subset of the real one these tests need: it is labelled as such
//! in `fake_hosts.rs`, and the real transitions are pinned by the host crate's own tests.

use super::fake_hosts::*;
use super::lifecycle_tests::{machine_with_current, CURRENT};
use super::*;
use crate::pty_host_client::{McpHoldOutcome, McpReleaseOutcome, McpSendError};
use crate::state::host_lifecycle::{begin_offload, begin_relaunch, AckedHost};
use crate::state::mcp_handover::choose_holder;
use termflow_pty_protocol::{ArmDetachPurpose, Control, Frame, McpHoldReason, McpHoldSpec};

const TOKEN: &str = "launch-token";

fn spec() -> McpHoldSpec {
    McpHoldSpec {
        port: 4310,
        configured_port: 4300,
        bind_host: "127.0.0.1".into(),
        auth_token: Some("bearer-x".into()),
        reason: McpHoldReason::OffloadUpdate,
        initialize_result: Some(r#"{"protocolVersion":"2025-11-25"}"#.into()),
        tools_list_result: Some(r#"{"tools":[]}"#.into()),
    }
}

fn capable() -> HostSpec {
    HostSpec { mcp_hold: true, ..HostSpec::default() }
}

/// The current host (behaving as `current`) and these older ones, adopted.
async fn adopted_with(current: HostSpec, old: &[(&str, HostSpec)]) -> (Arc<World>, FakePort) {
    let (world, port) = machine_with_current(current, old);
    rediscover_hosts(&port).await.unwrap();
    (world, port)
}

fn current_client(port: &FakePort) -> PtyHostClient {
    port.current_client().expect("the current host is adopted")
}

fn mcp_frames(world: &World, host: &str) -> Vec<&'static str> {
    world.kinds(host).into_iter().filter(|k| matches!(*k, "HoldMcp" | "ClaimMcp" | "ReleaseMcp")).collect()
}

#[tokio::test(start_paused = true)]
async fn a_client_without_the_bit_is_told_not_capable_and_writes_no_frame() {
    let (world, port) = adopted_with(HostSpec::default(), &[]).await;
    let client = current_client(&port);
    assert!(!client.mcp_hold());

    assert_eq!(client.hold_mcp(TOKEN, spec()).await, Ok(McpHoldOutcome::NotCapable));
    assert_eq!(client.release_mcp(TOKEN).await, Ok(McpReleaseOutcome::NotCapable));

    assert_eq!(mcp_frames(&world, CURRENT), Vec::<&str>::new(), "nothing reached the host");
    assert!(client.is_alive(), "and the connection is still up");
    assert!(client.list_sessions().await.is_some(), "and still answers");
    assert_eq!(world.mcp_state(CURRENT), McpState::Idle);
}

#[tokio::test(start_paused = true)]
async fn a_capable_client_sends_one_hold_with_every_field_and_is_accepted() {
    let (world, port) = adopted_with(capable(), &[]).await;
    let client = current_client(&port);
    assert!(client.mcp_hold());

    assert_eq!(client.hold_mcp(TOKEN, spec()).await, Ok(McpHoldOutcome::Accepted));

    let holds: Vec<_> = world
        .frames_of(CURRENT)
        .into_iter()
        .filter_map(|f| match f {
            Frame::Ctrl(Control::HoldMcp { token, spec, .. }) => Some((token, spec)),
            _ => None,
        })
        .collect();
    assert_eq!(holds, vec![(TOKEN.to_string(), spec())], "exactly one HoldMcp, token and spec as sent");
    assert_eq!(world.mcp_state(CURRENT), McpState::Pending);
    assert_eq!(client.pending_requests(), 0, "the answered request left no waiter");
}

#[tokio::test(start_paused = true)]
async fn a_rejection_carries_the_hosts_reason() {
    let reject = HostSpec { mcp_hold_reply: McpHoldReply::Reject("busy".into()), ..capable() };
    let (world, port) = adopted_with(reject, &[]).await;

    assert_eq!(current_client(&port).hold_mcp(TOKEN, spec()).await, Ok(McpHoldOutcome::Rejected("busy".into())));
    assert_eq!(world.mcp_state(CURRENT), McpState::Idle, "a refusal installs nothing");
}

#[tokio::test(start_paused = true)]
async fn a_host_already_holding_rejects_with_its_reason() {
    let (world, port) = adopted_with(capable(), &[]).await;
    world.set_mcp_running(CURRENT, McpRunning::Handback);

    assert_eq!(
        current_client(&port).hold_mcp(TOKEN, spec()).await,
        Ok(McpHoldOutcome::Rejected("already holding".into()))
    );
}

#[tokio::test(start_paused = true)]
async fn an_unanswered_hold_is_ambiguous_after_two_seconds_and_leaves_no_waiter() {
    let withheld = HostSpec { mcp_hold_reply: McpHoldReply::WithholdAfterAccept, ..capable() };
    let (world, port) = adopted_with(withheld, &[]).await;
    let client = current_client(&port);

    let started = tokio::time::Instant::now();
    assert_eq!(client.hold_mcp(TOKEN, spec()).await, Err(McpSendError::Ambiguous));
    let waited = started.elapsed();

    assert!(waited >= Duration::from_secs(2) && waited <= Duration::from_millis(2500), "bounded wait: {waited:?}");
    assert_eq!(client.pending_requests(), 0, "no response waiter is left in the client");
    assert_eq!(world.mcp_state(CURRENT), McpState::Pending, "the host did install the hold");
}

#[tokio::test(start_paused = true)]
async fn a_withheld_rejection_is_ambiguous_too() {
    let withheld = HostSpec { mcp_hold_reply: McpHoldReply::WithholdAfterReject, ..capable() };
    let (world, port) = adopted_with(withheld, &[]).await;

    assert_eq!(current_client(&port).hold_mcp(TOKEN, spec()).await, Err(McpSendError::Ambiguous));
    assert_eq!(world.mcp_state(CURRENT), McpState::Idle);
}

#[tokio::test(start_paused = true)]
async fn a_closed_pipe_is_not_sent_and_the_host_records_nothing() {
    let (world, port) = adopted_with(capable(), &[]).await;
    let client = current_client(&port);
    world.kill_connections(CURRENT);
    while client.is_alive() {
        tokio::task::yield_now().await;
    }

    let started = tokio::time::Instant::now();
    assert_eq!(client.hold_mcp(TOKEN, spec()).await, Err(McpSendError::NotSent));
    assert!(started.elapsed() < Duration::from_millis(100), "answered at once, not after the wait");
    assert_eq!(world.count(CURRENT, "HoldMcp"), 0, "the host never saw a hold");
    assert_eq!(client.pending_requests(), 0);
}

#[tokio::test(start_paused = true)]
async fn a_disarm_releases_a_pending_hold_and_an_absent_holder_but_not_a_handback() {
    for (before, after) in [
        (McpState::Pending, McpState::Idle),
        (McpState::Running(McpRunning::Absent), McpState::Idle),
        (McpState::Running(McpRunning::Handback), McpState::Running(McpRunning::Handback)),
    ] {
        let (world, port) = adopted_with(capable(), &[]).await;
        let client = current_client(&port);
        match before {
            McpState::Running(running) => world.set_mcp_running(CURRENT, running),
            _ => assert_eq!(client.hold_mcp(TOKEN, spec()).await, Ok(McpHoldOutcome::Accepted)),
        }
        assert_eq!(world.mcp_state(CURRENT), before);

        assert!(client.disarm().await);

        assert_eq!(world.mcp_state(CURRENT), after, "a Disarm leaves {before:?} as {after:?}");
    }
}

#[tokio::test(start_paused = true)]
async fn release_reports_whether_the_host_was_holding() {
    let (world, port) = adopted_with(capable(), &[]).await;
    let client = current_client(&port);
    assert_eq!(client.hold_mcp(TOKEN, spec()).await, Ok(McpHoldOutcome::Accepted));

    assert_eq!(client.release_mcp(TOKEN).await, Ok(McpReleaseOutcome::Released { was_holding: false }));
    assert_eq!(world.mcp_state(CURRENT), McpState::Idle, "a pending hold is released");

    world.set_mcp_running(CURRENT, McpRunning::Absent);
    assert_eq!(client.release_mcp(TOKEN).await, Ok(McpReleaseOutcome::Released { was_holding: true }));
    assert_eq!(world.mcp_state(CURRENT), McpState::Idle);
}

#[tokio::test(start_paused = true)]
async fn a_silent_host_never_answers_release() {
    let silent = HostSpec { mcp_silent: true, ..capable() };
    let (world, port) = adopted_with(silent, &[]).await;
    let client = current_client(&port);

    assert!(client.release_mcp(TOKEN).await.is_err());
    assert_eq!(client.hold_mcp(TOKEN, spec()).await, Err(McpSendError::Ambiguous));
    assert_eq!(
        mcp_frames(&world, CURRENT),
        ["ClaimMcp", "ReleaseMcp", "HoldMcp"],
        "the claim adoption made, then both were sent, none answered"
    );
    assert_eq!(world.mcp_state(CURRENT), McpState::Idle, "a silent host changes nothing");
    assert!(client.is_alive());
}

#[tokio::test(start_paused = true)]
async fn a_cancelled_request_leaves_no_waiter() {
    let silent = HostSpec { mcp_silent: true, ..capable() };
    let (_world, port) = adopted_with(silent, &[]).await;
    let client = current_client(&port);

    let hold = tokio::spawn({
        let client = client.clone();
        async move { client.hold_mcp(TOKEN, spec()).await }
    });
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(client.pending_requests(), 1, "the request is waiting for an answer that will not come");

    hold.abort();
    assert!(hold.await.unwrap_err().is_cancelled());

    assert_eq!(client.pending_requests(), 0, "dropping the future removed its waiter");
}

#[tokio::test(start_paused = true)]
async fn a_gated_accept_is_delivered_when_the_gate_opens_and_a_disarm_is_still_served_meanwhile() {
    let gate = Arc::new(EventGate::default());
    let gated = HostSpec { mcp_hold_reply: McpHoldReply::GatedAccept(gate.clone()), ..capable() };
    let (world, port) = adopted_with(gated, &[]).await;
    let client = current_client(&port);

    let hold = tokio::spawn({
        let client = client.clone();
        async move { client.hold_mcp(TOKEN, spec()).await }
    });
    gate.wait_reached(1).await;
    assert_eq!(world.mcp_state(CURRENT), McpState::Pending, "the frame was applied on arrival");

    assert!(client.disarm().await, "the read loop kept processing: a Disarm is applied and acked");
    assert_eq!(world.mcp_state(CURRENT), McpState::Idle);

    gate.release();
    assert_eq!(hold.await.unwrap(), Ok(McpHoldOutcome::Accepted), "the accept arrives when the gate opens");
}

#[tokio::test(start_paused = true)]
async fn a_gated_disarm_ack_is_applied_at_once_and_acknowledged_when_opened() {
    let gate = Arc::new(EventGate::default());
    let gated = HostSpec { gate_disarm_ack: Some(gate.clone()), ..capable() };
    let (world, port) = adopted_with(gated, &[]).await;
    let client = current_client(&port);
    assert_eq!(client.hold_mcp(TOKEN, spec()).await, Ok(McpHoldOutcome::Accepted));
    // Adoption disarmed the host before the test began; those acks are not what is waited for.
    let arrived = gate.count();
    gate.release_waiting();

    let disarm = tokio::spawn({
        let client = client.clone();
        async move { client.disarm().await }
    });
    gate.wait_reached(arrived + 1).await;
    assert_eq!(world.mcp_state(CURRENT), McpState::Idle, "applied when received");
    assert!(!disarm.is_finished(), "but not acknowledged yet");

    gate.release();
    assert!(disarm.await.unwrap());
}

// ---- choose_holder ----------------------------------------------------------------------------

fn acked(client: &PtyHostClient, name: &str, channel: Option<HostChannel>, capable: bool) -> AckedHost {
    let client = client.clone();
    client.set_mcp_hold(capable);
    AckedHost { name: name.into(), channel, client }
}

#[tokio::test(start_paused = true)]
async fn choose_holder_prefers_a_capable_primary_then_the_first_capable_frozen() {
    let (_world, port) = adopted_with(HostSpec::default(), &[("a", HostSpec::default()), ("b", HostSpec::default())]).await;
    // One connection per host: the bit is a property of the connection, set per row below.
    let primary = current_client(&port);
    let frozen = port.frozen_hosts();
    let (a, b) = (&frozen[0], &frozen[1]);
    let primary = |capable| acked(&primary, "primary", Some(HostChannel::Primary), capable);
    let first = |capable| acked(&a.client, "first", Some(HostChannel::Frozen(a.id)), capable);
    let second = |capable| acked(&b.client, "second", Some(HostChannel::Frozen(b.id)), capable);
    let name_of = |hosts: &[AckedHost]| choose_holder(hosts).map(|h| h.name.clone());

    assert_eq!(name_of(&[first(true), primary(true)]), Some("primary".into()), "a capable primary wins");
    assert_eq!(name_of(&[primary(false), first(true)]), Some("first".into()), "an incapable primary is skipped");
    assert_eq!(name_of(&[first(true), second(true)]), Some("first".into()), "the first frozen");
    assert_eq!(name_of(&[first(false), second(true)]), Some("second".into()), "an incapable frozen is skipped");
    assert_eq!(name_of(&[primary(false), first(false)]), None, "no capable host");
    assert_eq!(name_of(&[]), None, "no host at all");
    assert_eq!(name_of(&[acked(&a.client, "unplaced", None, true)]), None, "a host with no channel is not a holder");
}

// ---- acked_hosts through a real Hold -------------------------------------------------------

/// The endpoint a host's name was built from.
fn endpoint_of(name: &str) -> &str {
    name.strip_prefix("terminal host ").and_then(|rest| rest.split(' ').next()).unwrap_or(name)
}

#[tokio::test(start_paused = true)]
async fn an_offload_reports_every_armed_host_with_its_channel_and_its_armed_client() {
    let (world, port) = adopted_with(capable(), &[("h1", capable())]).await;
    let mut hold = begin_offload(&port).await.unwrap();
    hold.arm_detach(600, "tok", Some(ArmDetachPurpose::Local)).await.unwrap();

    let hosts = hold.acked_hosts();

    let mut names: Vec<_> = hosts.iter().map(|h| endpoint_of(&h.name).to_string()).collect();
    names.sort();
    assert_eq!(names, [CURRENT, "h1"], "both armed hosts, nothing else");
    for host in &hosts {
        let endpoint = endpoint_of(&host.name);
        let expected = if endpoint == CURRENT { HostChannel::Primary } else { HostChannel::Frozen(port.frozen_ids()[0]) };
        assert_eq!(host.channel, Some(expected), "{endpoint}: registered under its own channel");
        let counts = |world: &World| [CURRENT, "h1"].map(|h| world.count(h, "ReleaseMcp"));
        let before = counts(&world);
        host.client.release_mcp(TOKEN).await.unwrap();
        let after = counts(&world);
        let own = [CURRENT, "h1"].iter().position(|h| *h == endpoint).unwrap();
        for (i, (b, a)) in before.iter().zip(after).enumerate() {
            assert_eq!(a, b + usize::from(i == own), "{endpoint}: the armed client reaches its own host and no other");
        }
    }
    assert!(hold.release().await);
}

#[tokio::test(start_paused = true)]
async fn a_relaunch_host_that_failed_its_tolerated_arm_is_not_reported() {
    let refuses = HostSpec { no_arm_ack: true, ..capable() };
    let (_world, port) = adopted_with(capable(), &[("old", refuses)]).await;
    let mut hold = begin_relaunch(&port).await.expect("the current host is connected");
    hold.arm_detach(600, "tok", Some(ArmDetachPurpose::Local)).await.expect("only the current host must arm");

    let names: Vec<_> = hold.acked_hosts().iter().map(|h| endpoint_of(&h.name).to_string()).collect();

    assert_eq!(names, [CURRENT], "an unarmed host is never offered as a holder");
    assert!(hold.release().await);
}

#[tokio::test(start_paused = true)]
async fn commit_sends_no_disarm_and_release_sends_one_per_armed_host() {
    for commit in [true, false] {
        let (world, port) = adopted_with(capable(), &[("h1", capable())]).await;
        let mut hold = begin_offload(&port).await.unwrap();
        hold.arm_detach(600, "tok", Some(ArmDetachPurpose::Local)).await.unwrap();
        let hosts = [CURRENT, "h1"];
        let marks: Vec<usize> = hosts.iter().map(|h| world.kinds(h).len()).collect();

        if commit {
            hold.commit();
        } else {
            assert!(hold.release().await);
        }
        tokio::time::sleep(Duration::from_secs(1)).await;

        for (host, mark) in hosts.iter().zip(marks) {
            let disarms = world.kinds(host)[mark..].iter().filter(|k| **k == "Disarm").count();
            assert_eq!(disarms, usize::from(!commit), "{host}: commit={commit}");
        }
    }
}
