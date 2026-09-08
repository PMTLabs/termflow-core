use super::{open_with_grace, OpenOutcome};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

// Millisecond-scale windows so the tests run on real time (no tokio
// test-util); the production constants only change the scale. SHORT is a
// generous multiple of STEP: under parallel-test scheduler load a 10ms
// sleep can overshoot, and a too-tight window flips Connected→NoHost
// (observed flake).
const SHORT: Duration = Duration::from_millis(250);
const LONG: Duration = Duration::from_millis(1000);
const STEP: Duration = Duration::from_millis(10);

fn not_found() -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::NotFound, "no pipe instance")
}

#[tokio::test]
async fn first_try_success_connects_immediately() {
    let out = open_with_grace(
        || std::future::ready(Ok::<_, std::io::Error>(7u32)),
        || false,
        SHORT,
        LONG,
        STEP,
    )
    .await;
    assert!(matches!(out, OpenOutcome::Connected(7)));
}

/// The host's disconnect→re-accept cycle leaves a short window with no pipe
/// instance. A failed first open must RETRY (and adopt), not spawn.
#[tokio::test]
async fn transient_failure_within_grace_still_connects() {
    let tries = AtomicU32::new(0);
    let out = open_with_grace(
        || {
            let n = tries.fetch_add(1, Ordering::Relaxed);
            std::future::ready(if n < 3 { Err(not_found()) } else { Ok(1u32) })
        },
        || false,
        SHORT,
        LONG,
        STEP,
    )
    .await;
    assert!(matches!(out, OpenOutcome::Connected(1)));
}

#[tokio::test]
async fn no_advertised_host_expires_to_no_host_after_short_window() {
    let out = open_with_grace(
        || std::future::ready(Err::<u32, _>(not_found())),
        || false,
        SHORT,
        LONG,
        STEP,
    )
    .await;
    assert!(matches!(out, OpenOutcome::NoHost), "spawn is allowed only here");
}

/// The core duplicate-host guard: while a discovery record's pid is alive,
/// an unreachable endpoint must NEVER resolve to NoHost (= spawn).
#[tokio::test]
async fn advertised_live_host_never_expires_into_a_spawn() {
    let out = open_with_grace(
        || std::future::ready(Err::<u32, _>(not_found())),
        || true,
        SHORT,
        LONG,
        STEP,
    )
    .await;
    assert!(matches!(out, OpenOutcome::HostAliveUnreachable));
}

/// A host that dies mid-grace releases the guard so a fresh spawn can heal.
#[tokio::test]
async fn host_dying_mid_grace_downgrades_to_no_host() {
    let checks = AtomicU32::new(0);
    let out = open_with_grace(
        || std::future::ready(Err::<u32, _>(not_found())),
        || checks.fetch_add(1, Ordering::Relaxed) < 5,
        SHORT,
        LONG,
        STEP,
    )
    .await;
    assert!(matches!(out, OpenOutcome::NoHost));
}
