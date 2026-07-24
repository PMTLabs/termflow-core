//! OS-neutral transport for the PTY host.
//!
//! A Windows named pipe (`pipe_windows`) or a Unix domain socket
//! (`socket_unix`) is presented through a common surface so the serve loop is
//! identical on every platform:
//! - `Listener::bind` acquires the endpoint; `Listener::accept` yields one
//!   connected `Stream` per GUI connection. Windows mints a fresh secured pipe
//!   instance per accept; Unix reuses the bound socket and screens the peer's
//!   credentials.
//! - `Stream` is `AsyncRead + AsyncWrite + Unpin + Send + 'static`, so the
//!   frame codec and the split-based reader/writer are unchanged across OSes.
//!
//! Correctness notes carried over from the original Windows `pipe.rs`:
//! - The `SessionManager` is built ONCE and outlives every connection.
//! - The loop always holds an already-connected stream (first connected before
//!   the loop; a reconnect connected inside the Hold branch and carried in).
//! - The armed hold uses ONE absolute deadline; a reconnect never restarts it.
//! - A transient accept error during Hold does NOT tear down the sidecar — it
//!   retries until the deadline, so held sessions survive a flaky reconnect.
//! - On disconnect the outbound backlog is PURGED: reattach replays from the
//!   bounded ring, so Hold retains only the rings (no unbounded queue).

use crate::manager::{Disposition, SessionManager};
use std::time::Duration;
use termflow_pty_protocol::{read_frame, write_frame, Data, Frame, Response};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc::Receiver;
use tokio::sync::oneshot;

#[cfg(windows)]
mod pipe_windows;
#[cfg(windows)]
pub use pipe_windows::{Listener, Stream};
#[cfg(all(windows, test))]
pub use pipe_windows::{connect, ClientStream};

#[cfg(unix)]
mod socket_unix;
#[cfg(unix)]
pub use socket_unix::{default_endpoint, Listener, Stream};
#[cfg(all(unix, test))]
pub use socket_unix::{connect, ClientStream};

/// Bounded outbound channel depth (frames). On overflow the reader drops the
/// frame (bytes remain in the ring) and emits a Gap so the GUI resyncs.
const CHAN_CAP: usize = 8192;

/// Where the host listens: a pipe name on Windows, a socket path on Unix.
#[derive(Clone, Debug)]
pub struct Endpoint(pub String);

/// Run the host until teardown. `survivable` is whether this process can outlive
/// the GUI (see `detach::assert_survivable`); when false the manager refuses to
/// acknowledge an arm so the GUI never exits expecting sessions to persist.
/// `record` is this host's discovery advertisement (path + content), re-written
/// before each served connection if the file went missing.
pub async fn serve(
    endpoint: Endpoint,
    token: Option<String>,
    survivable: bool,
    record: Option<(std::path::PathBuf, termflow_pty_protocol::HostRecord)>,
) -> std::io::Result<()> {
    let (events_tx, mut events_rx) = tokio::sync::mpsc::channel::<Data>(CHAN_CAP);
    let (resp_tx, mut resp_rx) = tokio::sync::mpsc::channel::<Response>(CHAN_CAP);
    let mut mgr = SessionManager::new(events_tx, resp_tx, token, survivable);

    let mut listener = Listener::bind(&endpoint)?;
    // Accept the FIRST connection.
    let mut stream = listener.accept().await?;

    loop {
        // Self-heal the discovery record: a duplicate host that lost the pipe
        // race may have clobbered-then-deleted it on exit, leaving this SURVIVOR
        // unadvertised (clients then downgrade to legacy attach and can't apply
        // the duplicate-spawn guard). Restore it when the file is gone; never
        // overwrite a PRESENT record — it could belong to a live newer host.
        if let Some((path, rec)) = &record {
            if !matches!(termflow_pty_protocol::read_record(path), Ok(Some(_))) {
                if let Err(e) = termflow_pty_protocol::write_record(path, rec) {
                    eprintln!("termflow-pty-host: could not re-write discovery record: {e}");
                }
            }
        }
        let (erx, rrx) = run_connection(&mut mgr, stream, events_rx, resp_rx).await;
        events_rx = erx;
        resp_rx = rrx;

        match mgr.on_gui_disconnect() {
            Disposition::TearDown => return Ok(()),
            Disposition::Hold => {
                // Purge stale backlog: reattach replays from the ring, so Hold
                // must not retain a pre-disconnect queue.
                while events_rx.try_recv().is_ok() {}
                while resp_rx.try_recv().is_ok() {}
                // C3 (design §10.4): hold WHILE any child is live — never abandon
                // a live session because the arm timer expired. Tear down only
                // once nothing live remains to preserve. The arm deadline is still
                // computed + reported in ArmAck for the GUI's UI, but it no longer
                // destroys sessions here.
                match wait_for_reconnect(&mut listener, &mgr).await {
                    Some(s) => stream = s, // already connected → loop top
                    None => return Ok(()), // all children exited → safe teardown
                }
            }
        }
    }
}

/// Wait for a GUI to reconnect while the host still owns at least one LIVE
/// child. Unlike a destructive arm timeout, this never abandons live sessions on
/// a timer (design §10.4): it returns `Some(stream)` on reconnect, or `None`
/// ONLY once every hosted child has exited (nothing left to preserve → safe
/// teardown). Liveness is re-checked on a short interval so a child that exits
/// while detached eventually releases the host. Transient accept errors retry so
/// a flaky reconnect does not drop held sessions.
async fn wait_for_reconnect(listener: &mut Listener, mgr: &SessionManager) -> Option<Stream> {
    const RECHECK: Duration = Duration::from_millis(500);
    loop {
        if mgr.live_session_count() == 0 {
            return None;
        }
        tokio::select! {
            r = listener.accept() => match r {
                Ok(s) => return Some(s),
                Err(_) => {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
            },
            _ = tokio::time::sleep(RECHECK) => continue, // re-check liveness
        }
    }
}

/// Serve one connected client until it disconnects. Returns the event/response
/// receivers so the next connection can reuse them. Generic over the concrete
/// `Stream` so the exact same body runs over a named pipe or a Unix socket.
async fn run_connection<S>(
    mgr: &mut SessionManager,
    stream: S,
    events_rx: Receiver<Data>,
    resp_rx: Receiver<Response>,
) -> (Receiver<Data>, Receiver<Response>)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (mut rd, mut wr) = tokio::io::split(stream);
    let (stop_tx, mut stop_rx) = oneshot::channel::<()>();

    let writer = tokio::spawn(async move {
        let mut events_rx = events_rx;
        let mut resp_rx = resp_rx;
        loop {
            // Pick the next frame (or stop / channel-closed).
            let frame = tokio::select! {
                biased;
                _ = &mut stop_rx => break,
                d = events_rx.recv() => match d { Some(d) => Frame::Data(d), None => break },
                r = resp_rx.recv() => match r { Some(r) => Frame::Resp(r), None => break },
            };
            // Write it, but let `stop` interrupt a write that blocks on a full
            // socket buffer (a half-open peer that stopped reading). Without this,
            // a reader-side disconnect could never tear this task down and the
            // serve loop would wedge (RP-2 review F; latent in the original
            // Windows loop). A frame dropped here is fine: the backlog is purged
            // on disconnect and reattach replays from the ring.
            tokio::select! {
                biased;
                _ = &mut stop_rx => break,
                res = write_frame(&mut wr, &frame) => {
                    if res.is_err() { break; }
                }
            }
        }
        let _ = wr.shutdown().await;
        (events_rx, resp_rx)
    });

    loop {
        match read_frame(&mut rd).await {
            Ok(Some(Frame::Ctrl(c))) => mgr.handle_control(c),
            Ok(Some(Frame::Data(Data::Stdin { tab_id, bytes }))) => {
                mgr.handle_stdin(&tab_id, &bytes)
            }
            Ok(Some(_)) => {}
            Ok(None) | Err(_) => break,
        }
    }

    let _ = stop_tx.send(());
    writer.await.unwrap_or_else(|_| {
        let (_e_tx, e_rx) = tokio::sync::mpsc::channel(CHAN_CAP);
        let (_r_tx, r_rx) = tokio::sync::mpsc::channel(CHAN_CAP);
        (e_rx, r_rx)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use termflow_pty_protocol::{Control, SpawnSpec};

    /// A per-OS endpoint under a directory we own, unique to this test process.
    fn test_endpoint(tag: &str) -> Endpoint {
        #[cfg(windows)]
        {
            Endpoint(format!(r"\\.\pipe\termflow-test-{}-{tag}", std::process::id()))
        }
        #[cfg(unix)]
        {
            // A private 0700 dir (created by Listener::bind's ensure_owner_dir).
            Endpoint(format!(
                "/tmp/termflow-test-{}/{tag}.sock",
                std::process::id()
            ))
        }
    }

    /// A shell that prints "persist" and stays/exits, per OS.
    fn persist_spec(stay: bool) -> SpawnSpec {
        #[cfg(windows)]
        {
            let arg = if stay { "/k" } else { "/c" };
            SpawnSpec {
                shell: "cmd.exe".into(),
                args: vec![arg.into(), "echo persist".into()],
                env: vec![],
                env_remove: vec![],
                cwd: None,
                cols: 80,
                rows: 24,
            }
        }
        #[cfg(unix)]
        {
            let script = if stay {
                "echo persist; sleep 30"
            } else {
                "echo persist"
            };
            SpawnSpec {
                shell: "/bin/sh".into(),
                args: vec!["-c".into(), script.into()],
                env: vec![],
                env_remove: vec![],
                cwd: None,
                cols: 80,
                rows: 24,
            }
        }
    }

    #[tokio::test]
    async fn transport_roundtrip() {
        let ep = test_endpoint("roundtrip");
        let mut listener = Listener::bind(&ep).unwrap();
        let server = tokio::spawn(async move {
            let mut s = listener.accept().await.unwrap();
            // Echo exactly one frame back, then close.
            if let Ok(Some(f)) = read_frame(&mut s).await {
                let _ = write_frame(&mut s, &f).await;
            }
            let _ = s.shutdown().await;
            // Keep the listener alive until the client has read the echo.
            drop(listener);
        });

        let mut client = connect_with_retry(&ep).await;
        let ping = Frame::Ctrl(Control::ListSessions { req: 42 });
        write_frame(&mut client, &ping).await.unwrap();
        let echoed = read_frame(&mut client).await.unwrap().unwrap();
        assert!(
            matches!(echoed, Frame::Ctrl(Control::ListSessions { req: 42 })),
            "frame round-tripped over the transport"
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn client_spawns_session_and_receives_output() {
        let ep = test_endpoint("spawn");
        let srv = tokio::spawn(serve(ep.clone(), Some("tok".into()), true, None));

        let mut client = connect_with_retry(&ep).await;
        write_frame(
            &mut client,
            &Frame::Ctrl(Control::Spawn {
                req: 1,
                tab_id: "t1".into(),
                spec: persist_spec(false),
            }),
        )
        .await
        .unwrap();

        let mut got = String::new();
        let _ = tokio::time::timeout(Duration::from_secs(15), async {
            while let Ok(Some(f)) = read_frame(&mut client).await {
                if let Frame::Data(Data::Stdout { bytes, .. }) = f {
                    got.push_str(&String::from_utf8_lossy(&bytes));
                    if got.contains("persist") {
                        break;
                    }
                }
            }
        })
        .await;
        assert!(got.contains("persist"), "spawned session streamed output");
        srv.abort();
    }

    #[tokio::test]
    async fn sessions_survive_arm_disconnect_reconnect() {
        let ep = test_endpoint("reattach");
        let srv = tokio::spawn(serve(ep.clone(), Some("tok".into()), true, None));

        {
            let mut c1 = connect_with_retry(&ep).await;
            write_frame(
                &mut c1,
                &Frame::Ctrl(Control::Spawn {
                    req: 1,
                    tab_id: "t1".into(),
                    spec: persist_spec(true),
                }),
            )
            .await
            .unwrap();
            let _ = tokio::time::timeout(Duration::from_secs(10), async {
                while let Ok(Some(f)) = read_frame(&mut c1).await {
                    if matches!(f, Frame::Resp(Response::Spawned { .. })) {
                        break;
                    }
                }
            })
            .await;
            write_frame(
                &mut c1,
                &Frame::Ctrl(Control::ArmDetach {
                    req: 2,
                    timeout_secs: 300,
                    token: "tok".into(),
                }),
            )
            .await
            .unwrap();
            let _ = tokio::time::timeout(Duration::from_secs(5), async {
                while let Ok(Some(f)) = read_frame(&mut c1).await {
                    if matches!(f, Frame::Resp(Response::ArmAck { .. })) {
                        break;
                    }
                }
            })
            .await;
            // Drop c1 → GUI-exit simulation.
        }

        tokio::time::sleep(Duration::from_millis(300)).await;

        let mut c2 = connect_with_retry(&ep).await;
        write_frame(&mut c2, &Frame::Ctrl(Control::ListSessions { req: 3 }))
            .await
            .unwrap();
        let mut has_t1 = false;
        let _ = tokio::time::timeout(Duration::from_secs(5), async {
            while let Ok(Some(f)) = read_frame(&mut c2).await {
                if let Frame::Resp(Response::SessionList { sessions, .. }) = f {
                    has_t1 = sessions.iter().any(|s| s.tab_id == "t1");
                    break;
                }
            }
        })
        .await;
        assert!(has_t1, "session t1 survived the reconnect");

        write_frame(
            &mut c2,
            &Frame::Ctrl(Control::Attach {
                req: 4,
                tab_id: "t1".into(),
                from_offset: 0,
            }),
        )
        .await
        .unwrap();
        let mut replay = String::new();
        let _ = tokio::time::timeout(Duration::from_secs(5), async {
            while let Ok(Some(f)) = read_frame(&mut c2).await {
                if let Frame::Data(Data::Stdout { bytes, .. }) = f {
                    replay.push_str(&String::from_utf8_lossy(&bytes));
                    if replay.contains("persist") {
                        break;
                    }
                }
            }
        })
        .await;
        assert!(replay.contains("persist"), "reattach replayed prior output");
        srv.abort();
    }

    /// C3 (design §10.4): a LIVE session must survive past an EXPIRED (short) arm
    /// deadline — the host holds while children live and never kills on a timer.
    /// The old destructive timeout would have torn down and killed the session.
    #[tokio::test]
    async fn live_session_survives_expired_arm() {
        let ep = test_endpoint("c3-survive");
        let srv = tokio::spawn(serve(ep.clone(), Some("tok".into()), true, None));

        {
            let mut c1 = connect_with_retry(&ep).await;
            write_frame(
                &mut c1,
                &Frame::Ctrl(Control::Spawn {
                    req: 1,
                    tab_id: "t1".into(),
                    spec: persist_spec(true), // stays alive (sleep 30 / cmd /k)
                }),
            )
            .await
            .unwrap();
            let _ = tokio::time::timeout(Duration::from_secs(10), async {
                while let Ok(Some(f)) = read_frame(&mut c1).await {
                    if matches!(f, Frame::Resp(Response::Spawned { .. })) {
                        break;
                    }
                }
            })
            .await;
            // Arm with a SHORT 1s timeout, then drop the client (GUI exit).
            write_frame(
                &mut c1,
                &Frame::Ctrl(Control::ArmDetach {
                    req: 2,
                    timeout_secs: 1,
                    token: "tok".into(),
                }),
            )
            .await
            .unwrap();
            let _ = tokio::time::timeout(Duration::from_secs(5), async {
                while let Ok(Some(f)) = read_frame(&mut c1).await {
                    if matches!(f, Frame::Resp(Response::ArmAck { .. })) {
                        break;
                    }
                }
            })
            .await;
        }

        // Wait well PAST the 1s arm deadline. The fix holds the session because
        // its child is alive; the old code would have torn down + killed it.
        tokio::time::sleep(Duration::from_millis(1800)).await;

        let mut c2 = connect_with_retry(&ep).await;
        write_frame(&mut c2, &Frame::Ctrl(Control::ListSessions { req: 3 }))
            .await
            .unwrap();
        let mut has_t1 = false;
        let _ = tokio::time::timeout(Duration::from_secs(5), async {
            while let Ok(Some(f)) = read_frame(&mut c2).await {
                if let Frame::Resp(Response::SessionList { sessions, .. }) = f {
                    has_t1 = sessions.iter().any(|s| s.tab_id == "t1");
                    break;
                }
            }
        })
        .await;
        assert!(has_t1, "live session survived past the expired arm deadline");
        srv.abort();
    }

    /// A missing discovery record must be re-written before the next served
    /// connection (self-heal after a duplicate host clobbered-then-deleted it),
    /// so the surviving host stays advertised (caps, duplicate-spawn guard).
    #[tokio::test]
    async fn missing_discovery_record_is_rehealed_on_reconnect() {
        use termflow_pty_protocol::{HostRecord, HOST_RECORD_FORMAT, PROTOCOL_MAX, PROTOCOL_MIN};
        let ep = test_endpoint("heal-record");
        let dir = std::env::temp_dir().join(format!("tf-heal-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("host-record.json");
        let rec = HostRecord {
            format: HOST_RECORD_FORMAT,
            instance_id: 7,
            pid: std::process::id(),
            proto_min: PROTOCOL_MIN,
            proto_max: PROTOCOL_MAX,
            endpoint: ep.0.clone(),
            capabilities: termflow_pty_protocol::CAP_ATTACH_ACK,
        };
        termflow_pty_protocol::write_record(&path, &rec).unwrap();
        let srv = tokio::spawn(serve(
            ep.clone(),
            Some("tok".into()),
            true,
            Some((path.clone(), rec)),
        ));

        {
            // Spawn a live child and arm, so the disconnect Holds (host survives).
            let mut c1 = connect_with_retry(&ep).await;
            write_frame(
                &mut c1,
                &Frame::Ctrl(Control::Spawn {
                    req: 1,
                    tab_id: "t1".into(),
                    spec: persist_spec(true),
                }),
            )
            .await
            .unwrap();
            let _ = tokio::time::timeout(Duration::from_secs(10), async {
                while let Ok(Some(f)) = read_frame(&mut c1).await {
                    if matches!(f, Frame::Resp(Response::Spawned { .. })) {
                        break;
                    }
                }
            })
            .await;
            write_frame(
                &mut c1,
                &Frame::Ctrl(Control::ArmDetach {
                    req: 2,
                    timeout_secs: 300,
                    token: "tok".into(),
                }),
            )
            .await
            .unwrap();
            let _ = tokio::time::timeout(Duration::from_secs(5), async {
                while let Ok(Some(f)) = read_frame(&mut c1).await {
                    if matches!(f, Frame::Resp(Response::ArmAck { .. })) {
                        break;
                    }
                }
            })
            .await;
        }

        // Simulate the duplicate-host aftermath: the record vanishes.
        std::fs::remove_file(&path).unwrap();

        // Reconnect and complete one round-trip: the serve loop heals the
        // record at the top of the new connection, before serving it.
        let mut c2 = connect_with_retry(&ep).await;
        write_frame(&mut c2, &Frame::Ctrl(Control::ListSessions { req: 3 }))
            .await
            .unwrap();
        let _ = tokio::time::timeout(Duration::from_secs(5), async {
            read_frame(&mut c2).await
        })
        .await;
        assert!(path.exists(), "surviving host must re-advertise itself");
        srv.abort();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Connect a client, retrying for a few seconds so the test tolerates the
    /// server not having created/bound its endpoint yet.
    async fn connect_with_retry(ep: &Endpoint) -> ClientStream {
        for _ in 0..60 {
            if let Ok(c) = connect(ep).await {
                return c;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        connect(ep).await.expect("client failed to connect")
    }
}
