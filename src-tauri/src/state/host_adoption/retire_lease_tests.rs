//! Retirement and the MCP lease (plan 056 T4), on the paused clock with real retirement over fake
//! hosts: a frozen host whose holder was claimed is not retired while the app has not taken the port
//! back, and its emptiness clock starts over when the lease ends.
//!
//! Two shell-less frozen hosts: `holder` advertises the hold and is claimed at adoption; `control`
//! holds nothing and is retired as any empty host is. The control's `Shutdown` proves the ticker ran,
//! so the holder's absence of one is the lease and not a ticker that never looked.

use super::fake_hosts::*;
use super::*;
use crate::state::host_retire::{start_ticker, EMPTY_FOR, TICK};
use crate::state::mcp_reclaim::{ReclaimBoot, ReleaseResult};
use termflow_pty_protocol::{Control, Frame, McpHeld};

const CURRENT: &str = "cur";
const HOLDER: &str = "holder";
const CONTROL: &str = "control";

fn held() -> McpHeld {
    McpHeld { port: 4310, configured_port: 4300, bind_host: "0.0.0.0".into() }
}

/// Both hosts adopted with their claims recorded and the current host up, then watched for emptiness.
async fn leased() -> (Arc<World>, FakePort) {
    let world = World::new();
    world.add_host(CURRENT, HostSpec::default());
    world.add_host(HOLDER, HostSpec { mcp_hold: true, mcp_held: Some(held()), ..HostSpec::default() });
    world.add_host(CONTROL, HostSpec::default());
    let port = FakePort::new(&world, CURRENT);
    port.set_candidates(vec![
        candidate(HOLDER, HostRole::Frozen),
        candidate(CONTROL, HostRole::Frozen),
        candidate(CURRENT, HostRole::Current),
    ]);
    rediscover_hosts(&port).await.unwrap();
    port.enable_retirement();
    for host in port.frozen_hosts() {
        host.client.set_shutdown_control(true);
        start_ticker(&port, host.id);
    }
    (world, port)
}

fn shutdowns(world: &World, host: &str) -> usize {
    world.count(host, "Shutdown")
}

#[tokio::test(start_paused = true)]
async fn held_frozen_host_is_not_retired_while_leased() {
    let (world, port) = leased().await;
    assert!(port.reclaim().has_claim(), "the premise: adoption recorded the holder's claim");

    // Sidecar readiness delayed far beyond the emptiness period.
    tokio::time::sleep(EMPTY_FOR + 3 * TICK).await;

    assert_eq!(shutdowns(&world, CONTROL), 1, "the control host was retired, so the ticker ran");
    assert_eq!(shutdowns(&world, HOLDER), 0, "the claimed holder's host was kept");
    assert_eq!(world.mcp_state(HOLDER), McpState::Running(McpRunning::Handback), "and its holder still serves");
    assert_eq!(world.count(HOLDER, "Eof"), 0, "its connection was not closed");
    assert!(port.frozen_hosts().iter().any(|h| h.endpoint == HOLDER), "and it is still registered");
}

#[tokio::test(start_paused = true)]
async fn retirement_after_release_waits_a_fresh_empty_for() {
    let (world, port) = leased().await;
    tokio::time::sleep(EMPTY_FOR + 3 * TICK).await;
    assert_eq!(shutdowns(&world, HOLDER), 0, "held while the app has not taken the port");
    assert_eq!(shutdowns(&world, CONTROL), 1, "and the control host shows the ticker ran");

    let mut boot = ReclaimBoot::new(port.reclaim().clone());
    assert!(boot.decide().is_some());
    assert_eq!(boot.release().await, ReleaseResult::Released);
    let released = Instant::now();

    let releases: Vec<_> = world
        .mcp_frames(HOLDER)
        .into_iter()
        .filter(|f| matches!(f, Frame::Ctrl(Control::ReleaseMcp { .. })))
        .collect();
    let Some(Frame::Ctrl(Control::ReleaseMcp { req, token })) = releases.first().cloned() else {
        panic!("the holder's host received no ReleaseMcp: {releases:?}")
    };
    assert_eq!(releases, [Frame::Ctrl(Control::ReleaseMcp { req, token: HOST_TOKEN.into() })], "whole frame, once");
    assert_eq!(token, HOST_TOKEN);

    // Whatever the emptiness clock held while leased does not count: the host is not retired until it
    // has been seen empty for a whole fresh interval after the release.
    let mut retired_after = None;
    for _ in 0..(2 * (EMPTY_FOR + 2 * TICK).as_secs()) {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if let Some(at) = world.first_at(HOLDER, "Shutdown") {
            retired_after = Some(at.duration_since(released));
            break;
        }
    }
    let after = retired_after.expect("the released host is retired in the end");
    assert!(after >= EMPTY_FOR, "retired {after:?} after the release: before a fresh {EMPTY_FOR:?} of emptiness");
    assert!(after <= EMPTY_FOR + 2 * TICK, "retired {after:?} after the release; the limit is {:?}", EMPTY_FOR + 2 * TICK);
}
