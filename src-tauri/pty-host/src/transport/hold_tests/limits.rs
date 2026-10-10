//! Plan 054 T5: overload bounds (R1) and the token never leaving host memory (R2).

use super::*;
use crate::mcp_hold::holder::{gauges, HOLDER_MAX};

/// Claim first (so the pipe's `ListSessions` does not stop the holder), then
/// fill the event-stream slots, overrun the connection permits with slow
/// connections, and prove the pipe still serves.
#[tokio::test(start_paused = true)]
async fn overload_is_bounded() {
    let clock = Clock::new(0);
    let host = Host::start("overload", &clock);
    let port = free_port("127.0.0.1");
    offload(&host, spec(port, "127.0.0.1"), &["t1"]).await;
    assert!(wait_answers(port, Duration::from_secs(10)).await);

    // 1. Claim first.
    let mut gui = host.gui().await;
    assert!(gui.claim().await.is_some());

    // 2. Eight working event streams, each receiving a ping.
    let mut streams = Vec::new();
    for i in 0..8 {
        let mut s = Sse::open(port, &format!("s{i}")).await.expect("a stream");
        assert!(s.read_until(": holding\n\n", Duration::from_secs(5)).await, "stream {i} opened");
        streams.push(s);
    }
    advance(Duration::from_millis(5200)).await;
    for (i, s) in streams.iter_mut().enumerate() {
        assert!(s.read_until(": ping\n\n", Duration::from_secs(5)).await, "stream {i} got a ping");
    }

    // 3. A ninth gets 503 and is closed.
    let mut ninth = Sse::open(port, "nine").await.unwrap();
    assert!(ninth.read_until("503 Service Unavailable", Duration::from_secs(5)).await, "{:?}", ninth.text());
    assert!(ninth.ends_within(Duration::from_secs(2)).await);

    // 4. Forty slow connections that dribble a header. Eight permits are held
    // by the streams, so only 24 can be served; the other 16 are closed unread.
    let mut slow = Vec::new();
    for _ in 0..40 {
        let mut c = Sse { io: dial(port).expect("the listener accepts"), seen: Vec::new() };
        c.io.write_all(b"GET /mcp HTTP/1.1\r\nHost: x\r\n").await.unwrap();
        slow.push(c);
    }
    pump(Duration::from_millis(600)).await;
    let mut closed = 0;
    for c in &mut slow {
        match c.read_some(Duration::from_millis(20)).await {
            Read::Eof => closed += 1,
            Read::Data => panic!("a slow connection got a reply: {:?}", c.text()),
            Read::Timeout => {}
        }
        assert!(c.seen.is_empty(), "closed connections are closed without a reply");
    }
    assert_eq!(closed, 16, "40 slow connections, 24 permits left");
    assert_eq!(gauges::get(&gauges::CONN).peak, 32, "the connection tasks peaked at exactly the permits");

    // 5. The pipe still serves while the holder is.
    let started = std::time::Instant::now();
    assert_eq!(gui.list().await.len(), 1);
    assert!(started.elapsed() < Duration::from_secs(1), "ListSessions took {:?}", started.elapsed());
    assert_eq!(wait_text(port).await, None, "the permits are all taken, so even a new request is not served");

    // 6. After the release the gauges return to 0.
    assert!(gui.release().await);
    assert!(wait_refuses(port, STOP_BOUND).await);
    // The slow connections get their 250 ms (virtual) to finish, then are aborted.
    advance(Duration::from_millis(300)).await;
    assert!(pump_until(STOP_BOUND, || gauges::live_tasks() == 0).await, "tasks left: {}", gauges::live_tasks());
}

fn push(seen: &mut Vec<String>, raw: Option<Vec<u8>>) {
    seen.push(String::from_utf8_lossy(&raw.unwrap_or_default()).into_owned());
}

/// A sentinel bearer token is absent from every captured log line and every
/// response, across a tool call, wrong auth, bind failure, claim, release,
/// grace and cap.
#[tokio::test(start_paused = true)]
async fn token_never_logged_or_served() {
    let mut responses: Vec<String> = Vec::new();

    // Bind failure, a tool call, wrong auth, health, claim and release.
    {
        let clock = Clock::new(0);
        let host = Host::start("token-a", &clock);
        let port = free_port("127.0.0.1");
        let stranger = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
        offload(&host, spec(port, "127.0.0.1"), &["t1"]).await;
        advance(Duration::from_millis(450)).await;
        drop(stranger);
        advance(Duration::from_millis(250)).await;
        assert!(wait_answers(port, Duration::from_secs(10)).await);

        let limit = Duration::from_secs(3);
        push(&mut responses, exchange(port, &tools_call_request(Some(BEARER), "old"), limit).await);
        push(&mut responses, exchange(port, &tools_call_request(Some("wrong"), "old"), limit).await);
        push(&mut responses, exchange(port, &tools_call_request(None, "old"), limit).await);
        push(&mut responses, exchange(port, b"GET /health HTTP/1.1\r\nHost: x\r\n\r\n", limit).await);
        let mut gui = host.gui().await;
        gui.claim().await;
        push(&mut responses, exchange(port, &tools_call_request(Some(BEARER), "old"), limit).await);
        assert!(gui.release().await);
    }

    // The handback grace ending on its own.
    {
        let clock = Clock::new(0);
        let host = Host::start("token-b", &clock);
        let port = free_port("127.0.0.1");
        offload(&host, spec(port, "127.0.0.1"), &["t1"]).await;
        assert!(wait_answers(port, Duration::from_secs(10)).await);
        let mut gui = host.gui().await;
        gui.claim().await;
        advance(Duration::from_secs(61)).await;
        assert!(wait_refuses(port, Duration::from_secs(5)).await);
    }

    // The hard cap.
    {
        let clock = Clock::new(0);
        let host = Host::start("token-c", &clock);
        let port = free_port("127.0.0.1");
        offload(&host, spec(port, "127.0.0.1"), &["t1"]).await;
        assert!(wait_answers(port, Duration::from_secs(10)).await);
        for now in [800, 1600] {
            clock.set(now);
            let silent = host.gui().await;
            pump(Duration::from_millis(100)).await;
            drop(silent);
            advance(Duration::from_millis(600)).await;
        }
        clock.set(HOLDER_MAX.as_secs() + 1);
        advance(Duration::from_millis(800)).await;
        assert!(wait_refuses(port, Duration::from_secs(5)).await);
    }

    let logs = log_lines();
    for marker in ["still failing", "bound ", "claimed", "stop ordered", "handback grace ended", "hard cap reached"] {
        assert!(logs.iter().any(|l| l.contains(marker)), "the test must exercise {marker:?}: {logs:#?}");
    }
    for line in &logs {
        assert!(!line.contains(BEARER), "the token reached the log: {line}");
    }
    assert!(responses.len() >= 5 && responses.iter().all(|r| r.starts_with("HTTP/1.1 ")), "{responses:?}");
    for r in &responses {
        assert!(!r.contains(BEARER), "the token was served: {r}");
    }
}
