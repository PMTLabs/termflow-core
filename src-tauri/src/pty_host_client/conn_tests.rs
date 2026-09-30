//! Transport close: the connection ends exactly one way, and ending it really
//! releases the stream. Driven over an in-memory duplex so the peer can observe
//! EOF; the real-host counterpart lives in `real_host_tests`.
use super::conn::Phase;
use super::*;
use std::sync::atomic::AtomicUsize;
use std::time::Duration;
use termflow_pty_protocol::read_frame;
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

pub(super) struct Counters {
    pub disconnects: Arc<AtomicUsize>,
    pub exits: Arc<AtomicUsize>,
}

pub(super) fn deps() -> (PtyHostDeps, Counters) {
    let (tx, _rx) = broadcast::channel(16);
    let disconnects = Arc::new(AtomicUsize::new(0));
    let exits = Arc::new(AtomicUsize::new(0));
    let (d, e) = (disconnects.clone(), exits.clone());
    let deps = PtyHostDeps {
        lifecycle_token: "tok".into(),
        output_tx: tx,
        output_produced: Arc::new(AtomicU64::new(0)),
        on_exit: Arc::new(move |_, _, _| {
            e.fetch_add(1, Ordering::SeqCst);
        }),
        on_gap: Arc::new(|_| {}),
        on_disconnect: Arc::new(move || {
            d.fetch_add(1, Ordering::SeqCst);
        }),
        stream_offsets: Arc::new(dashmap::DashMap::new()),
        resolve_process: Arc::new(|k: &str| Some(k.to_string())),
    };
    (deps, Counters { disconnects, exits })
}

/// A client wired to one end of a duplex; the other end is the "host".
pub(super) fn wired() -> (PtyHostClient, DuplexStream, Counters) {
    let (client_side, server) = tokio::io::duplex(64 * 1024);
    let (rd, wr) = tokio::io::split(client_side);
    let (deps, counters) = deps();
    (wire_client(rd, wr, deps), server, counters)
}

async fn until(what: &str, mut cond: impl FnMut() -> bool) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    while !cond() {
        assert!(tokio::time::Instant::now() < deadline, "timed out waiting for: {what}");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

fn count(c: &Arc<AtomicUsize>) -> usize {
    c.load(Ordering::SeqCst)
}

#[tokio::test]
async fn close_transport_releases_the_stream_and_is_silent() {
    let (client, mut server, c) = wired();
    assert!(client.close_transport().await, "both halves must be released within the bound");

    // EOF on the peer proves the WHOLE stream is gone. The halves share it, so
    // dropping only the writer's (what "drop the sender" does) would not do this.
    let mut buf = [0u8; 8];
    let n = tokio::time::timeout(Duration::from_secs(1), server.read(&mut buf))
        .await
        .expect("peer must see EOF")
        .unwrap();
    assert_eq!(n, 0);
    assert!(
        server.write_all(b"x").await.is_err(),
        "the read half must be gone too, not just the write half"
    );

    assert_eq!(client.conn.phase(), Phase::Closing);
    assert!(!client.is_alive());
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(count(&c.disconnects), 0, "an intentional close is not a disconnect");
}

#[tokio::test]
async fn close_is_idempotent_across_clones() {
    let (client, mut server, c) = wired();
    let clones: Vec<_> = (0..4).map(|_| client.clone()).collect();
    let results = close_all(clones).await;
    assert!(results.iter().all(|r| *r), "every concurrent close reports the stream released");

    // Later calls, on any clone, return at once with the same answer.
    let started = tokio::time::Instant::now();
    assert!(client.close_transport().await);
    assert!(client.clone().close_transport().await);
    assert!(started.elapsed() < Duration::from_millis(500));

    let mut buf = [0u8; 1];
    assert_eq!(server.read(&mut buf).await.unwrap(), 0);
    assert_eq!(client.conn.phase(), Phase::Closing);
    assert_eq!(count(&c.disconnects), 0);
}

async fn close_all(clones: Vec<PtyHostClient>) -> Vec<bool> {
    let tasks: Vec<_> = clones
        .into_iter()
        .map(|c| tokio::spawn(async move { c.close_transport().await }))
        .collect();
    let mut out = Vec::new();
    for t in tasks {
        out.push(t.await.unwrap());
    }
    out
}

#[tokio::test]
async fn natural_eof_still_fires_on_disconnect() {
    let (client, mut server, c) = wired();
    // A request that is waiting when the host goes away must not sit out its
    // 10 s timeout.
    let waiter = {
        let client = client.clone();
        tokio::spawn(async move { client.list_sessions().await })
    };
    assert!(matches!(
        read_frame(&mut server).await,
        Ok(Some(Frame::Ctrl(Control::ListSessions { .. })))
    ));
    drop(server);

    until("on_disconnect", || count(&c.disconnects) == 1).await;
    assert_eq!(client.conn.phase(), Phase::Lost);
    assert!(!client.is_alive());
    let answered = tokio::time::timeout(Duration::from_secs(2), waiter).await;
    assert!(answered.expect("pending request must fail promptly").unwrap().is_none());
    assert!(client.pending.lock().unwrap().is_empty());

    // Closing a connection that was already lost is a no-op for the callback.
    assert!(client.close_transport().await);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(count(&c.disconnects), 1);
}

/// A writer whose every write fails; the read side stays healthy and silent.
struct FailingWriter;

impl tokio::io::AsyncWrite for FailingWriter {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
        _: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::task::Poll::Ready(Err(std::io::ErrorKind::BrokenPipe.into()))
    }
    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::task::Poll::Ready(Ok(()))
    }
    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::task::Poll::Ready(Ok(()))
    }
}

#[tokio::test]
async fn write_failure_fires_on_disconnect_once() {
    let (client_side, mut server) = tokio::io::duplex(1024);
    let (rd, unused_wr) = tokio::io::split(client_side);
    drop(unused_wr); // the reader half alone keeps the stream open
    let (deps, c) = deps();
    let client = wire_client(rd, FailingWriter, deps);
    let tab_id = "t1";

    client.write_stdin(tab_id, b"x");

    until("on_disconnect", || count(&c.disconnects) == 1).await;
    assert_eq!(client.conn.phase(), Phase::Lost);
    assert!(!client.is_alive());

    // The reader was cancelled with it: its half is released (the host would see
    // EOF) even though the peer never closed or said anything.
    assert!(
        client.close_transport().await,
        "a write failure must also stop the reader and release its half"
    );
    assert!(server.write_all(b"x").await.is_err(), "the stream must be closed");

    // More failing writes and a later close never fire it again.
    client.write_stdin(tab_id, b"y");
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(count(&c.disconnects), 1);
}

/// Close and peer EOF at the same instant: exactly one of them decides the
/// outcome, and `on_disconnect` agrees with it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn close_vs_eof_race_single_winner() {
    let mut lost = 0;
    let mut closed = 0;
    for _ in 0..300 {
        let (client, server, c) = wired();
        let gate = Arc::new(tokio::sync::Barrier::new(2));
        let eof = {
            let gate = gate.clone();
            tokio::spawn(async move {
                gate.wait().await;
                drop(server);
            })
        };
        let close = {
            let (gate, client) = (gate.clone(), client.clone());
            tokio::spawn(async move {
                gate.wait().await;
                client.close_transport().await
            })
        };
        eof.await.unwrap();
        assert!(close.await.unwrap());

        match client.conn.phase() {
            Phase::Lost => {
                lost += 1;
                until("the single on_disconnect", || count(&c.disconnects) == 1).await;
            }
            Phase::Closing => closed += 1,
            Phase::Live => panic!("neither side won"),
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
        assert_eq!(
            count(&c.disconnects),
            usize::from(client.conn.phase() == Phase::Lost),
            "on_disconnect fires iff the loss won, and only once"
        );
    }
    eprintln!("race outcomes: lost={lost} closed={closed}");
}

/// Requests waiting when the transport is closed fail at once; "drop the sender
/// and hope" would leave them to the 10 s request timeout.
#[tokio::test]
async fn pending_request_fails_and_map_drains() {
    let (client, mut server, _c) = wired();
    let waiter = {
        let client = client.clone();
        tokio::spawn(async move { client.list_sessions().await })
    };
    // The host has the request and never answers it.
    assert!(matches!(
        read_frame(&mut server).await,
        Ok(Some(Frame::Ctrl(Control::ListSessions { .. })))
    ));
    assert_eq!(client.pending.lock().unwrap().len(), 1);

    assert!(client.close_transport().await);

    let answered = tokio::time::timeout(Duration::from_secs(2), waiter)
        .await
        .expect("the waiting request must fail as soon as the transport closes");
    assert!(answered.unwrap().is_none(), "a closed transport is not an empty list");
    assert!(client.pending.lock().unwrap().is_empty(), "the pending map must drain");

    // A request made after the close fails immediately and leaves nothing behind.
    let started = tokio::time::Instant::now();
    assert!(client.list_sessions().await.is_none());
    assert!(started.elapsed() < Duration::from_secs(1));
    assert!(client.pending.lock().unwrap().is_empty());
}

/// Closing the transport is not closing sessions: the client sends nothing on
/// the way out (no `Close`, `Shutdown` or `Disarm`) and reports no exits, so it
/// cannot manufacture deferred closes. Those tombstones live in the state layer
/// and are untouched by design.
#[tokio::test]
async fn close_leaves_pending_close_tombstones() {
    let (client, mut server, c) = wired();
    let tab_id = "t1";
    client.write_stdin(tab_id, b"a");
    assert!(matches!(
        read_frame(&mut server).await,
        Ok(Some(Frame::Data(Data::Stdin { .. })))
    ));

    assert!(client.close_transport().await);

    match tokio::time::timeout(Duration::from_secs(1), read_frame(&mut server)).await {
        Ok(Ok(None)) => {}
        other => panic!("expected a bare EOF with no frame after the close, got {other:?}"),
    }
    assert_eq!(count(&c.exits), 0);
    assert_eq!(count(&c.disconnects), 0);
}
