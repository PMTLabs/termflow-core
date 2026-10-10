//! Plan 054 T5: how the holder's life follows the host's (claim, release,
//! adoption, expiry, linger), through the real `serve_with_clock`.

use super::*;
use crate::mcp_hold::holder::{gauges, StopHook, STOP_HOOK};

fn dead_within(pids: &[u32], real: Duration) -> bool {
    let end = std::time::Instant::now() + real;
    loop {
        if pids.iter().all(|p| !pid_is_alive(*p)) {
            return true;
        }
        if std::time::Instant::now() >= end {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Done for real: an event stream is open; `ClaimMcp` is acked with the exact
/// `held`; then `Disarm`, `ListSessions` and `ArmDetach` arrive. The same
/// stream keeps receiving pings and a `tools/call` gets the Handback wording.
#[tokio::test(start_paused = true)]
async fn claim_keeps_serving_through_startup() {
    let clock = Clock::new(0);
    let host = Host::start("claim-serving", &clock);
    let port = free_port("127.0.0.1");
    offload(&host, spec(port, "127.0.0.1"), &["t1"]).await;
    assert!(wait_answers(port, Duration::from_secs(10)).await);
    assert_eq!(wait_text(port).await, Some(absent_text("0s")));

    let mut sse = Sse::open(port, "sess-1").await.expect("an event stream");
    assert!(sse.read_until(": holding\n\n", Duration::from_secs(5)).await);

    let mut gui = host.gui().await;
    assert_eq!(gui.claim().await, Some(held(port, "127.0.0.1")));

    let req = gui.req();
    gui.send(Control::Disarm { req }).await;
    assert_eq!(gui.resp().await, Response::DisarmAck { req });
    let sessions = gui.list().await;
    assert_eq!(sessions.len(), 1);
    assert!(sessions[0].alive && sessions[0].tab_id == "t1");
    gui.arm_local().await;
    let req = gui.req();
    gui.send(Control::AttachAcked { req, tab_id: "t1".into(), from_offset: 0 }).await;
    assert!(matches!(gui.resp().await, Response::AttachAck { req: r, alive: true, .. } if r == req));

    advance(Duration::from_millis(5200)).await;
    assert!(sse.read_until(": ping\n\n", Duration::from_secs(5)).await, "the stream kept pinging: {:?}", sse.text());
    assert_eq!(wait_text(port).await, Some(handback_text("0s")));
    assert!(!matches!(sse.read_some(Duration::from_millis(50)).await, Read::Eof), "no EOF on the open stream");
}

async fn release_case(bind_host: &str) {
    let clock = Clock::new(0);
    let host = Host::start("release", &clock);
    let port = free_port(bind_host);
    offload(&host, spec(port, bind_host), &["t1"]).await;
    assert!(wait_answers(port, Duration::from_secs(10)).await);

    // The holder bound EXACTLY the sidecar's address (wildcard and loopback binds
    // overlap on Windows, so a bind elsewhere would not show up as a conflict).
    let addr = SocketAddr::new(bind_host.parse().unwrap(), port);
    assert_eq!(gauges::bound(), vec![addr], "the holder's listener");
    let mut gui = host.gui().await;
    assert_eq!(gui.claim().await, Some(held(port, bind_host)));

    // One POST stuck mid-body and two open event streams.
    let mut mid = Sse { io: dial(port).unwrap(), seen: Vec::new() };
    mid.io
        .write_all(
            format!(
                "POST /mcp HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {BEARER}\r\nContent-Length: 100\r\n\r\n{{\"jsonrpc\""
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut s1 = Sse::open(port, "one").await.unwrap();
    let mut s2 = Sse::open(port, "two").await.unwrap();
    assert!(s1.read_until(": holding", Duration::from_secs(5)).await);
    assert!(s2.read_until(": holding", Duration::from_secs(5)).await);
    pump(Duration::from_millis(100)).await;

    let released = std::time::Instant::now();
    assert!(gui.release().await, "was_holding");

    // A same-address bind, retried every 50 ms, must succeed within STOP_BOUND.
    let mut rebound = None;
    while released.elapsed() < STOP_BOUND {
        match std::net::TcpListener::bind(addr) {
            Ok(l) => {
                rebound = Some(l);
                break;
            }
            Err(_) => pump(Duration::from_millis(50)).await,
        }
    }
    assert!(rebound.is_some(), "{bind_host}: the port was not bindable within {STOP_BOUND:?} of the release");

    // Every holder connection is closed within the same bound.
    for (name, s) in [("mid-body POST", &mut mid), ("stream one", &mut s1), ("stream two", &mut s2)] {
        let left = STOP_BOUND.saturating_sub(released.elapsed()).max(Duration::from_millis(20));
        assert!(s.ends_within(left).await, "{bind_host}: {name} did not reach EOF within the bound");
    }
    assert!(released.elapsed() < STOP_BOUND + Duration::from_millis(100), "the whole stop fits the bound");

    assert!(!gui.release().await, "a second release has nothing to stop");
}

#[tokio::test]
async fn release_closes_within_bound_and_port_rebinds_loopback() {
    release_case("127.0.0.1").await;
}

#[tokio::test]
async fn release_closes_within_bound_and_port_rebinds_wildcard() {
    release_case("0.0.0.0").await;
}

/// With a holder running and the Local deadline established, a host whose last
/// shell exited does not return `Empty`: it waits for its own deadline.
#[tokio::test]
async fn empty_host_lingers_until_its_own_deadline() {
    // First case: a GUI comes back during the linger and reclaims.
    let clock = Clock::new(100);
    let mut host = Host::start("linger-claim", &clock);
    let port = free_port("127.0.0.1");
    let pids = offload(&host, spec(port, "127.0.0.1"), &["t1"]).await;
    assert!(wait_answers(port, Duration::from_secs(10)).await);

    // The host's last shell exits while the GUI is away.
    crate::util::kill_process_tree(pids[0]);
    assert!(dead_within(&pids, Duration::from_secs(10)));
    pump(Duration::from_millis(1400)).await; // several 500 ms rechecks
    assert!(!host.finished(), "serve returned at Empty although a holder is running");
    assert_eq!(wait_text(port).await, Some(absent_text("0s")), "and the port still answers");

    let mut gui = host.gui().await;
    assert_eq!(gui.claim().await, Some(held(port, "127.0.0.1")));
    // The shell that exited is still listed, dead; the GUI closes it, leaving nothing.
    let listed = gui.list().await;
    assert_eq!(listed.len(), 1);
    assert!(!listed[0].alive);
    gui.send(Control::Close { tab_id: "t1".into() }).await;
    assert!(gui.list().await.is_empty(), "ListSessions on the now empty host");

    assert!(gui.release().await);
    assert!(wait_refuses(port, STOP_BOUND).await, "the port refuses within the bound");
    assert!(pump_until(STOP_BOUND, || gauges::live_tasks() == 0).await, "the holder task gauge reaches 0");

    // Releasing MCP never ends the host connection.
    let pid = gui.spawn("t2").await;
    assert!(gui.shell_echoes("t2").await, "the new shell echoes input");
    assert!(pid_is_alive(pid));
    assert!(!host.finished());

    // An announced exit after adoption: the host is unarmed, so it tears down.
    let req = gui.req();
    gui.send(Control::Shutdown { req, token: HOST_TOKEN.into() }).await;
    assert_eq!(gui.resp().await, Response::ShutdownAck { req });
    drop(gui);
    assert!(host.wait_finished(Duration::from_secs(60)).await, "serve returns after the GUI's exit");
    assert!((&mut host.srv).await.unwrap().is_ok());
    assert!(dead_within(&[pid], Duration::from_secs(10)));

    // Second case: no GUI comes. At 899 s the port answers; at 900 s serve returns.
    let clock = Clock::new(0);
    let host = Host::start("linger-expiry", &clock);
    let port = free_port("127.0.0.1");
    let pids = offload(&host, spec(port, "127.0.0.1"), &["t1"]).await;
    assert!(wait_answers(port, Duration::from_secs(10)).await);
    crate::util::kill_process_tree(pids[0]);
    assert!(dead_within(&pids, Duration::from_secs(10)));
    clock.set(899);
    pump(Duration::from_millis(1400)).await;
    assert!(!host.finished(), "still lingering at 899 s");
    assert_eq!(
        wait_text(port).await,
        Some(
            "TermFlow has not been reopened yet (restart, 14m59s ago). Your terminals are still running but \
             will be closed in less than a minute unless TermFlow is reopened. Retry later; do not \
             recreate terminals."
                .to_string()
        ),
        "the late wording, with the host's own remaining time"
    );
    clock.set(900);
    assert!(host.wait_finished(Duration::from_secs(10)).await, "serve returns at 900 s (Expired)");
    assert!(refuses(port), "and the port refuses");
    drop(host);

    // Third case: no holder. Empty returns at once, as today.
    let clock = Clock::new(0);
    let host = Host::start("linger-none", &clock);
    let mut gui = host.gui().await;
    let pid = gui.spawn("t1").await;
    gui.arm_local().await;
    drop(gui);
    pump(Duration::from_millis(300)).await;
    crate::util::kill_process_tree(pid);
    assert!(host.wait_finished(Duration::from_secs(10)).await, "no holder: Empty returns");
    drop(host);

    // Fourth case: a holder, but the deadline is AwaitingClock. Empty returns at once.
    let clock = Clock::new(0);
    let host = Host::start("linger-awaiting", &clock);
    let port = free_port("127.0.0.1");
    let mut gui = host.gui().await;
    let pid = gui.spawn("t1").await;
    gui.arm_local().await;
    gui.hold_accepted(spec(port, "127.0.0.1")).await;
    clock.fail();
    drop(gui);
    pump(Duration::from_millis(300)).await;
    crate::util::kill_process_tree(pid);
    assert!(host.wait_finished(Duration::from_secs(10)).await, "AwaitingClock: Empty returns");
    assert!(refuses(port));
}

/// At 900 s with live shells the shells are torn down, Stop was ordered before
/// the teardown began, and `serve` returns with a task gauge of 0.
#[tokio::test]
async fn expiry_is_not_lingered() {
    let clock = Clock::new(0);
    let mut host = Host::start("expiry", &clock);
    let port = free_port("127.0.0.1");
    let pids = offload(&host, spec(port, "127.0.0.1"), &["t1", "t2"]).await;
    assert!(wait_answers(port, Duration::from_secs(10)).await);
    assert!(pids.iter().all(|p| pid_is_alive(*p)));

    clock.set(900);
    assert!(host.wait_finished(Duration::from_secs(90)).await, "serve returns at the deadline");
    (&mut host.srv).await.unwrap().unwrap();
    assert_eq!(gauges::live_tasks(), 0, "no holder task or connection outlives serve");
    assert!(dead_within(&pids, Duration::from_secs(20)), "every shell is gone");
    assert_eq!(
        gauges::order(),
        vec!["holder-stop-ordered", "teardown-begin"],
        "Stop is ordered before the teardown begins"
    );
    assert!(refuses(port));
}

/// A `ClaimMcp`, `HoldMcp` and `ReleaseMcp` with a wrong token get no reply,
/// the holder keeps serving, and the Local timer is not revoked.
#[tokio::test]
async fn wrong_token_claim_through_serve_changes_nothing() {
    let clock = Clock::new(0);
    let host = Host::start("wrong-token", &clock);
    let port = free_port("127.0.0.1");
    let pids = offload(&host, spec(port, "127.0.0.1"), &["t1"]).await;
    assert!(wait_answers(port, Duration::from_secs(10)).await);

    let mut peer = host.gui().await;
    let wrong = || "not-the-token".to_string();
    peer.send(Control::ClaimMcp { req: 1, token: wrong() }).await;
    assert!(peer.silent_for(Duration::from_millis(300)).await, "a wrong-token claim gets no reply");
    peer.send(Control::HoldMcp { req: 2, token: wrong(), spec: spec(free_port("127.0.0.1"), "127.0.0.1") }).await;
    assert!(peer.silent_for(Duration::from_millis(300)).await, "a wrong-token hold gets no reply");
    peer.send(Control::ReleaseMcp { req: 3, token: wrong() }).await;
    assert!(peer.silent_for(Duration::from_millis(300)).await, "a wrong-token release gets no reply");

    assert_eq!(wait_text(port).await, Some(absent_text("0s")), "still Absent, still serving");
    clock.set(900);
    assert!(
        host.wait_finished(Duration::from_secs(90)).await,
        "the Local timer was revoked by a frame that never authenticated"
    );
    assert!(dead_within(&pids, Duration::from_secs(20)));
    assert!(refuses(port));
}

/// A peer that connects and sends only `Disarm`, keeping its pipe open, stops
/// an Absent holder.
#[tokio::test]
async fn absent_disarm_stops_the_holder() {
    let clock = Clock::new(0);
    let host = Host::start("disarm", &clock);
    let port = free_port("127.0.0.1");
    offload(&host, spec(port, "127.0.0.1"), &["t1"]).await;
    assert!(wait_answers(port, Duration::from_secs(10)).await);

    let mut peer = host.gui().await;
    let req = peer.req();
    peer.send(Control::Disarm { req }).await;
    assert_eq!(peer.resp().await, Response::DisarmAck { req });
    assert!(wait_refuses(port, STOP_BOUND).await, "the port refuses within the bound");
    assert!(!host.finished(), "the host itself is unaffected");
}

/// An old GUI's tokenless `ListSessions` adopts: the port closes and the live
/// shell (same pid and tab id) is listed and still echoes.
#[tokio::test]
async fn legacy_adoption_closes_the_port() {
    let clock = Clock::new(0);
    let host = Host::start("legacy-adopt", &clock);
    let port = free_port("127.0.0.1");
    let pids = offload(&host, spec(port, "127.0.0.1"), &["t1"]).await;
    assert!(wait_answers(port, Duration::from_secs(10)).await);

    let mut old = host.gui().await;
    old.send(Control::ListSessions { req: 5, token: None }).await;
    match old.resp().await {
        Response::SessionList { req: 5, sessions } => {
            assert_eq!(sessions.len(), 1);
            assert_eq!((sessions[0].tab_id.as_str(), sessions[0].pid, sessions[0].alive), ("t1", pids[0], true));
        }
        other => panic!("expected the session list, got {other:?}"),
    }
    assert!(wait_refuses(port, STOP_BOUND).await, "the port refuses within the bound");
    old.attach_tail("t1").await;
    assert!(old.shell_echoes("t1").await, "the shell is still alive and attached");
}

/// Expiry wins an exact tie; a claim one second earlier adopts; after a
/// release (no holder) the last shell's exit returns `Empty` as today.
#[tokio::test]
async fn expiry_tie_and_claim_before_expiry() {
    // The fake clock is at exactly 900 s when the claim arrives.
    let clock = Clock::new(0);
    let host = Host::start("tie", &clock);
    let port = free_port("127.0.0.1");
    let pids = offload(&host, spec(port, "127.0.0.1"), &["t1"]).await;
    assert!(wait_answers(port, Duration::from_secs(10)).await);
    let mut gui = host.gui().await;
    pump(Duration::from_millis(100)).await;
    clock.set(900);
    gui.send(Control::ClaimMcp { req: 1, token: HOST_TOKEN.into() }).await;
    let reply = gui.resp_within(Duration::from_secs(5)).await;
    assert!(!matches!(reply, Some(Response::McpClaimAck { .. })), "no claim ack at the tie: {reply:?}");
    assert!(host.wait_finished(Duration::from_secs(90)).await, "expiry won");
    assert!(dead_within(&pids, Duration::from_secs(20)), "the shells are torn down");
    assert!(refuses(port));
    drop(host);

    // One second earlier the claim adopts and the port is still served.
    let clock = Clock::new(0);
    let host = Host::start("before-expiry", &clock);
    let port = free_port("127.0.0.1");
    offload(&host, spec(port, "127.0.0.1"), &["t1"]).await;
    assert!(wait_answers(port, Duration::from_secs(10)).await);
    let mut gui = host.gui().await;
    clock.set(899);
    assert_eq!(gui.claim().await, Some(held(port, "127.0.0.1")));
    assert_eq!(wait_text(port).await, Some(handback_text("14m59s")));
    pump(Duration::from_millis(700)).await;
    assert!(!host.finished());
    assert_eq!(gui.list().await.iter().filter(|s| s.alive).count(), 1, "the shell is adopted");
    drop(gui);
    drop(host);

    // After a release there is no holder: the last shell's exit is `Empty`.
    let clock = Clock::new(0);
    let host = Host::start("empty-no-holder", &clock);
    let port = free_port("127.0.0.1");
    let pids = offload(&host, spec(port, "127.0.0.1"), &["t1"]).await;
    assert!(wait_answers(port, Duration::from_secs(10)).await);
    let mut gui = host.gui().await;
    assert!(gui.claim().await.is_some());
    assert!(gui.release().await);
    drop(gui);
    assert!(wait_refuses(port, STOP_BOUND).await);
    pump(Duration::from_millis(300)).await;
    crate::util::kill_process_tree(pids[0]);
    assert!(host.wait_finished(Duration::from_secs(10)).await, "Empty returns as today");
    assert!(refuses(port));
}

/// An unarmed drop starts no holder; a pending hold followed by a non-Local
/// re-arm starts none; an armed drop does start one.
#[tokio::test]
async fn crash_hold_and_non_local_rearm_never_start_a_holder() {
    // Unarmed: the hold is refused, and the crash hold that follows starts nothing.
    let clock = Clock::new(0);
    let host = Host::start("crash-hold", &clock);
    let port = free_port("127.0.0.1");
    let mut gui = host.gui().await;
    gui.spawn("t1").await;
    let refused = gui.hold(spec(port, "127.0.0.1")).await;
    assert_eq!(
        refused,
        Response::McpHoldAck { req: gui.req, accepted: false, reason: Some("not armed".into()) }
    );
    drop(gui);
    pump(Duration::from_millis(1300)).await;
    assert!(!host.finished(), "the crash hold keeps the shell");
    assert_eq!(gauges::get(&gauges::ROOT).peak, 0, "no holder task was ever started");
    assert_eq!(gauges::bind_attempts(), 0);
    assert!(refuses(port));
    drop(host);

    // Pending, then a non-Local re-arm, then the drop.
    let clock = Clock::new(0);
    let host = Host::start("non-local", &clock);
    let port = free_port("127.0.0.1");
    let mut gui = host.gui().await;
    gui.spawn("t1").await;
    gui.arm_local().await;
    gui.hold_accepted(spec(port, "127.0.0.1")).await;
    let req = gui.req();
    gui.send(Control::ArmDetach { req, timeout_secs: 600, token: HOST_TOKEN.into(), purpose: None }).await;
    assert!(matches!(gui.resp().await, Response::ArmAck { req: r, .. } if r == req));
    drop(gui);
    pump(Duration::from_millis(1300)).await;
    assert!(!host.finished());
    assert_eq!(gauges::get(&gauges::ROOT).peak, 0, "a pending hold dies with the Local arm");
    assert_eq!(gauges::bind_attempts(), 0);
    assert!(refuses(port));
    drop(host);

    // The paired positive case: an armed drop does start one.
    let clock = Clock::new(0);
    let host = Host::start("armed", &clock);
    let port = free_port("127.0.0.1");
    offload(&host, spec(port, "127.0.0.1"), &["t1"]).await;
    assert!(wait_answers(port, Duration::from_secs(10)).await);
    assert_eq!(gauges::get(&gauges::ROOT).peak, 1);
}

/// Holder 1 is slowed by a gate on its shutdown. A re-arm and a new `HoldMcp`
/// are refused while it is stopping and accepted once it has finished, and at
/// most one holder task and one spec ever exist.
#[tokio::test]
async fn one_holder_task_per_process() {
    let (gate_tx, gate_rx) = tokio::sync::watch::channel(false);
    STOP_HOOK.with(|h| *h.borrow_mut() = StopHook::Gate(gate_rx));
    let clock = Clock::new(0);
    let host = Host::start("one-holder", &clock);
    let port1 = free_port("127.0.0.1");
    let port2 = free_port("127.0.0.1");
    offload(&host, spec(port1, "127.0.0.1"), &["t1"]).await;
    assert!(wait_answers(port1, Duration::from_secs(10)).await);

    let mut gui = host.gui().await;
    assert!(gui.claim().await.is_some());
    assert!(gui.release().await);
    assert!(wait_refuses(port1, STOP_BOUND).await, "holder 1 closed its listener");

    gui.arm_local().await;
    let refused = gui.hold(spec(port2, "127.0.0.1")).await;
    assert_eq!(
        refused,
        Response::McpHoldAck { req: gui.req, accepted: false, reason: Some("previous holder still stopping".into()) }
    );

    gate_tx.send_replace(true);
    let mut accepted = false;
    for _ in 0..200 {
        if let Response::McpHoldAck { accepted: true, .. } = gui.hold(spec(port2, "127.0.0.1")).await {
            accepted = true;
            break;
        }
        pump(Duration::from_millis(20)).await;
    }
    assert!(accepted, "the same HoldMcp is accepted once holder 1 has finished");
    drop(gui);
    assert!(wait_answers(port2, Duration::from_secs(10)).await, "holder 2 serves");

    assert_eq!(gauges::get(&gauges::ROOT).peak, 1, "never more than one holder task");
    assert_eq!(gauges::get(&gauges::SPEC_BYTES).peak, SNAPSHOT_BYTES, "never more than one spec retained");
}
