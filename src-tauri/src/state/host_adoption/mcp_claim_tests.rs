//! `PtyHostClient::claim_mcp` over fake hosts (plan 056 T1): the gate, the frame on the wire and
//! the bounded wait.
//!
//! These tests send their own claims with a token of their own, so they hold whether or not the
//! adoption that made the connection sent a claim first; the frames they assert on are the ones
//! that carry that token.

use super::fake_hosts::*;
use super::lifecycle_tests::{machine_with_current, CURRENT};
use super::*;
use crate::pty_host_client::{McpClaimOutcome, McpSendError};
use termflow_pty_protocol::{Control, Frame, McpHeld};

const TOKEN: &str = "claim-token-056";

/// Non-default in every field, so a reply that dropped or swapped one is seen.
fn held() -> McpHeld {
    McpHeld { port: 4310, configured_port: 4300, bind_host: "0.0.0.0".into() }
}

fn holder() -> HostSpec {
    HostSpec { mcp_hold: true, mcp_held: Some(held()), ..HostSpec::default() }
}

async fn adopted_with(current: HostSpec) -> (Arc<World>, FakePort) {
    let (world, port) = machine_with_current(current, &[]);
    rediscover_hosts(&port).await.unwrap();
    (world, port)
}

/// The claims `host` received that carry `TOKEN`, whole.
fn claims_with_token(world: &World, host: &str) -> Vec<Frame> {
    world
        .mcp_frames(host)
        .into_iter()
        .filter(|f| matches!(f, Frame::Ctrl(Control::ClaimMcp { token, .. }) if token == TOKEN))
        .collect()
}

#[tokio::test(start_paused = true)]
async fn claim_mcp_not_capable_writes_nothing() {
    let (world, port) = adopted_with(HostSpec { mcp_held: Some(held()), ..HostSpec::default() }).await;
    let client = port.current_client().expect("the current host is adopted");
    assert!(!client.mcp_hold());
    let before = world.mcp_state(CURRENT);

    assert_eq!(client.claim_mcp(TOKEN).await, Ok(McpClaimOutcome::NotCapable));

    assert_eq!(world.mcp_frames(CURRENT), Vec::<Frame>::new(), "no MCP frame reached a host without the bit");
    assert_eq!(client.pending_requests(), 0, "and no waiter was registered");
    assert!(client.is_alive() && client.list_sessions().await.is_some(), "the connection is untouched");
    assert_eq!(world.mcp_state(CURRENT), before, "the host's MCP state was not touched");
}

#[tokio::test(start_paused = true)]
async fn claim_mcp_sends_host_token_and_returns_held() {
    let (world, port) = adopted_with(holder()).await;
    let client = port.current_client().expect("the current host is adopted");
    assert!(client.mcp_hold());

    assert_eq!(client.claim_mcp(TOKEN).await, Ok(McpClaimOutcome::Held(Some(held()))));

    let sent = claims_with_token(&world, CURRENT);
    assert_eq!(sent.len(), 1, "exactly one claim with this token: {sent:?}");
    let Frame::Ctrl(Control::ClaimMcp { req, token }) = &sent[0] else { unreachable!() };
    assert_eq!(sent[0], Frame::Ctrl(Control::ClaimMcp { req: *req, token: TOKEN.into() }), "whole frame");
    assert_ne!(*req, 0, "a correlated request");
    assert_eq!(token, TOKEN);
    assert_eq!(world.mcp_state(CURRENT), McpState::Running(McpRunning::Handback), "the host moved to handback");
    assert_eq!(client.pending_requests(), 0, "the answered request left no waiter");
}

#[tokio::test(start_paused = true)]
async fn claim_mcp_from_a_host_with_nothing_held_is_held_none() {
    let (_world, port) = adopted_with(HostSpec { mcp_hold: true, ..HostSpec::default() }).await;
    let client = port.current_client().expect("the current host is adopted");

    assert_eq!(client.claim_mcp(TOKEN).await, Ok(McpClaimOutcome::Held(None)));
}

#[tokio::test(start_paused = true)]
async fn a_repeated_claim_stays_in_handback_and_answers_the_same() {
    let (world, port) = adopted_with(holder()).await;
    let client = port.current_client().expect("the current host is adopted");

    let first = client.claim_mcp(TOKEN).await;
    let second = client.claim_mcp(TOKEN).await;

    assert_eq!(first, Ok(McpClaimOutcome::Held(Some(held()))));
    assert_eq!(second, first);
    assert_eq!(world.mcp_state(CURRENT), McpState::Running(McpRunning::Handback));
}

#[tokio::test(start_paused = true)]
async fn claim_mcp_timeout_leaves_no_waiter() {
    let (world, port) = adopted_with(HostSpec { mcp_silent: true, ..holder() }).await;
    let client = port.current_client().expect("the current host is adopted");

    let started = tokio::time::Instant::now();
    assert_eq!(client.claim_mcp(TOKEN).await, Err(McpSendError::Ambiguous));
    let waited = started.elapsed();

    assert!(waited >= Duration::from_secs(2) && waited <= Duration::from_millis(2500), "bounded wait: {waited:?}");
    assert_eq!(client.pending_requests(), 0, "no response waiter is left in the client");
    assert_eq!(claims_with_token(&world, CURRENT).len(), 1, "the frame was sent once");
}

#[tokio::test(start_paused = true)]
async fn a_claim_on_a_closed_pipe_is_not_sent() {
    let (world, port) = adopted_with(holder()).await;
    let client = port.current_client().expect("the current host is adopted");
    world.kill_connections(CURRENT);
    while client.is_alive() {
        tokio::task::yield_now().await;
    }

    let started = tokio::time::Instant::now();
    assert_eq!(client.claim_mcp(TOKEN).await, Err(McpSendError::NotSent));
    assert!(started.elapsed() < Duration::from_millis(100), "answered at once, not after the wait");
    assert_eq!(claims_with_token(&world, CURRENT).len(), 0, "the host never saw it");
    assert_eq!(client.pending_requests(), 0);
}
