//! Plan 054 T5: the holder's own bounds (handback grace, hard cap, cleanup on
//! `serve` returning, event-stream cadence, silent reconnects).

use super::*;
use crate::mcp_hold::holder::{gauges, StopHook, HANDBACK_GRACE, HOLDER_MAX, STOP_HOOK};

/// On entering Handback the holder starts its own 60 s timer and stops when it
/// ends, with no frame needed. A second claim does not extend it.
#[tokio::test(start_paused = true)]
async fn grace_ends_handback_without_any_frame() {
    assert_eq!(HANDBACK_GRACE, Duration::from_secs(60));
    let clock = Clock::new(0);
    let host = Host::start("grace", &clock);
    let port = free_port("127.0.0.1");
    offload(&host, spec(port, "127.0.0.1"), &["t1"]).await;
    assert!(wait_answers(port, Duration::from_secs(10)).await);

    let mut gui = host.gui().await;
    assert_eq!(gui.claim().await, Some(held(port, "127.0.0.1"))); // t = 0
    advance(Duration::from_secs(30)).await;
    assert_eq!(gui.claim().await, Some(held(port, "127.0.0.1"))); // t = 30 s
    advance(Duration::from_secs(29)).await; // t = 59 s
    assert_eq!(wait_text(port).await, Some(handback_text("0s")), "still answering at 59 s");
    advance(Duration::from_secs(2)).await; // t = 61 s
    assert!(wait_refuses(port, Duration::from_secs(5)).await, "the grace counts from the FIRST claim");
    assert!(!host.finished());
    assert_eq!(gui.list().await.len(), 1, "the claiming GUI's connection is untouched");
}

/// Repeated silent connects and drops keep the holder in Absent while
/// refreshing the host's own deadline; only the holder's hard cap ends it, and
/// the shells are still alive then.
#[tokio::test]
async fn hard_cap_bounds_an_absent_holder() {
    assert_eq!(HOLDER_MAX, Duration::from_secs(30 * 60));
    let clock = Clock::new(0);
    let host = Host::start("hard-cap", &clock);
    let port = free_port("127.0.0.1");
    let pids = offload(&host, spec(port, "127.0.0.1"), &["t1", "t2"]).await;
    assert!(wait_answers(port, Duration::from_secs(10)).await);

    for (now, ago) in [(800, "13m20s"), (1600, "26m40s")] {
        clock.set(now);
        let silent = host.gui().await;
        pump(Duration::from_millis(100)).await;
        drop(silent);
        // The refreshed deadline is 900 s ahead of `now`: "about 15 minutes".
        wait_text_where(port, Duration::from_secs(10), |t| t == late_text(ago, 15)).await;
    }

    clock.set(HOLDER_MAX.as_secs() - 1);
    pump(Duration::from_millis(600)).await;
    assert_eq!(wait_text(port).await, Some(late_text("29m59s", 11)), "still answering one second before the cap");

    clock.set(HOLDER_MAX.as_secs() + 1);
    assert!(wait_refuses(port, Duration::from_secs(5)).await, "the cap stopped the holder");
    assert!(!host.finished(), "the host is still up");
    assert!(pids.iter().all(|p| pid_is_alive(*p)), "and so are its shells");
    assert!(log_lines().iter().any(|l| l.contains("hard cap reached")));
}

/// A real holder with two open streams and one mid-body POST, ended by
/// `Expired`: when `serve` resolves the live-task gauge is 0 and every client
/// reads EOF. The bug path (a holder that ignores Stop) is aborted and
/// `serve` still returns inside its bound.
#[tokio::test]
async fn serve_returns_only_after_holder_cleanup() {
    let clock = Clock::new(0);
    let mut host = Host::start("cleanup", &clock);
    let port = free_port("127.0.0.1");
    offload(&host, spec(port, "127.0.0.1"), &["t1"]).await;
    assert!(wait_answers(port, Duration::from_secs(10)).await);

    let mut s1 = Sse::open(port, "one").await.unwrap();
    let mut s2 = Sse::open(port, "two").await.unwrap();
    assert!(s1.read_until(": holding", Duration::from_secs(5)).await);
    assert!(s2.read_until(": holding", Duration::from_secs(5)).await);
    let mut mid = Sse { io: dial(port).unwrap(), seen: Vec::new() };
    mid.io
        .write_all(
            format!("POST /mcp HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {BEARER}\r\nContent-Length: 100\r\n\r\n{{")
                .as_bytes(),
        )
        .await
        .unwrap();
    pump(Duration::from_millis(100)).await;
    assert!(gauges::live_tasks() >= 4, "the root plus three connections: {}", gauges::live_tasks());

    // Only the ends caused by the stop: the earlier request's connection ended long ago.
    gauges::TASK_ENDS.with(|e| e.borrow_mut().clear());
    clock.set(900);
    (&mut host.srv).await.unwrap().unwrap();
    // Sampled by the wrapper in the poll that resolved `serve_with_clock`, not here
    // after this waiter was scheduled. The ends are an ORDER, so a root that
    // returned before its children (abort without awaiting) cannot hide behind
    // the scheduler running the children first.
    let at = at_return();
    assert_eq!(at.live_tasks, 0, "at the instant serve resolved, every holder task was already gone");
    assert_eq!(
        at.task_ends,
        ["conn-dropped", "conn-dropped", "conn-dropped", "root-end"],
        "every connection task ended before the root did, and before serve returned"
    );
    for (name, c) in [("stream one", &mut s1), ("stream two", &mut s2), ("mid-body POST", &mut mid)] {
        assert!(c.ends_within(Duration::from_millis(200)).await, "{name} reads EOF");
    }
    drop(host);

    // The bug path: a holder that never reacts to Stop. Only the weaker
    // guarantee holds: serve aborts it, logs, and returns within its bound.
    STOP_HOOK.with(|h| *h.borrow_mut() = StopHook::Ignore);
    let clock = Clock::new(0);
    let mut host = Host::start("cleanup-bug", &clock);
    let port = free_port("127.0.0.1");
    offload(&host, spec(port, "127.0.0.1"), &[]).await;
    assert!(wait_answers(port, Duration::from_secs(10)).await);
    let mut stuck = Sse::open(port, "one").await.unwrap();
    assert!(stuck.read_until(": holding", Duration::from_secs(5)).await);

    let expired = std::time::Instant::now();
    clock.set(900);
    (&mut host.srv).await.unwrap().unwrap();
    let took = expired.elapsed();
    assert!(took >= Duration::from_millis(1900), "serve waited out the bound before giving up: {took:?}");
    assert!(took < Duration::from_millis(3600), "serve returned within STOP_BOUND + 1.5 s (+ one recheck): {took:?}");
    assert!(log_lines().iter().any(|l| l.contains("did not stop within its bound")));
    assert!(pump_until(Duration::from_millis(500), || gauges::live_tasks() == 0).await, "the gauge reaches 0 shortly after");
}

/// Under paused time: three pings at 5 s intervals with the session header
/// echoed; a stop ends the stream within a second and leaves no task behind.
#[tokio::test(start_paused = true)]
async fn sse_stream_pings_until_stop() {
    let clock = Clock::new(0);
    let host = Host::start("sse-pings", &clock);
    let port = free_port("127.0.0.1");
    offload(&host, spec(port, "127.0.0.1"), &["t1"]).await;
    assert!(wait_answers(port, Duration::from_secs(10)).await);

    let mut sse = Sse::open(port, "sess-xyz").await.unwrap();
    assert!(sse.read_until(": holding\n\n", Duration::from_secs(5)).await);
    let head = sse.text();
    assert!(head.starts_with("HTTP/1.1 200 OK\r\n"), "{head:?}");
    assert!(head.contains("Content-Type: text/event-stream\r\n"));
    assert!(head.contains("mcp-session-id: sess-xyz\r\n"), "the session id is echoed");

    // Exactly one ping per 5 s: none a tenth of a second early, one a tenth late.
    let pings = |sse: &Sse| sse.text().matches(": ping\n\n").count();
    for n in 1..=3usize {
        advance(Duration::from_millis(if n == 1 { 4900 } else { 4800 })).await;
        while matches!(sse.read_some(Duration::from_millis(30)).await, Read::Data) {}
        assert_eq!(pings(&sse), n - 1, "no ping before {} s: {:?}", 5 * n, sse.text());
        advance(Duration::from_millis(200)).await;
        while matches!(sse.read_some(Duration::from_millis(30)).await, Read::Data) {}
        assert_eq!(pings(&sse), n, "one ping per 5 s: {:?}", sse.text());
    }

    let mut old_gui = host.gui().await;
    let req = old_gui.req();
    old_gui.send(Control::Disarm { req }).await;
    assert_eq!(old_gui.resp().await, Response::DisarmAck { req });
    assert!(sse.ends_within(Duration::from_secs(1)).await, "a stop ends the stream within a second");
    assert!(pump_until(Duration::from_secs(1), || gauges::live_tasks() == 0).await, "no holder or connection task is left");
}

/// A silent connect-and-drop re-enters the hold: the SAME holder keeps its
/// listener and streams, it does not bind again, and its message follows the
/// host's new deadline.
#[tokio::test(start_paused = true)]
async fn silent_reconnect_keeps_the_same_holder() {
    let clock = Clock::new(0);
    let host = Host::start("silent", &clock);
    let port = free_port("127.0.0.1");
    offload(&host, spec(port, "127.0.0.1"), &["t1"]).await;
    assert!(wait_answers(port, Duration::from_secs(10)).await);
    clock.set(650);
    assert_eq!(wait_text(port).await, Some(late_text("10m50s", 4)), "deadline 900, now 650");

    let mut sse = Sse::open(port, "sess-1").await.unwrap();
    assert!(sse.read_until(": holding\n\n", Duration::from_secs(5)).await);
    let attempts = gauges::bind_attempts();
    assert_eq!(attempts, 1);

    let silent = host.gui().await;
    pump(Duration::from_millis(100)).await;
    drop(silent);
    // The new deadline is 650 + 900: fifteen minutes remain, not four.
    wait_text_where(port, Duration::from_secs(10), |t| t == late_text("10m50s", 15)).await;

    advance(Duration::from_millis(5200)).await;
    assert!(sse.read_until(": ping\n\n", Duration::from_secs(5)).await, "the stream survived: {:?}", sse.text());
    assert!(!matches!(sse.read_some(Duration::from_millis(30)).await, Read::Eof));
    assert_eq!(gauges::bind_attempts(), attempts, "no second bind: it is the same holder");
    assert_eq!(gauges::get(&gauges::ROOT).peak, 1, "and the same task");
}
