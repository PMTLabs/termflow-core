//! Windows named-pipe server for the PTY host.
//!
//! Correctness notes (dual review):
//! - The `SessionManager` is built ONCE and outlives every connection.
//! - `server` entering the main loop is ALWAYS an already-connected instance
//!   (first connected before the loop; a reconnect connected in the Hold branch
//!   and carried straight in). The accepted connection is never dropped/re-made.
//! - The armed hold uses ONE absolute deadline; a reconnect never restarts it.
//! - A transient connect error during Hold does NOT terminate the sidecar — it
//!   retries until the deadline, so held sessions survive a flaky reconnect.
//! - On disconnect the outbound backlog is PURGED: reattach replays from the
//!   bounded ring, so Hold retains only the rings (no unbounded queue).
//! - Outbound channels are BOUNDED; the reader drops + emits a Gap on overflow.

#![cfg(windows)]

use crate::manager::{Disposition, SessionManager};
use std::time::{Duration, Instant};
use termflow_pty_protocol::{read_frame, write_frame, Control, Data, Frame, Response};
use tokio::io::AsyncWriteExt;
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use tokio::sync::mpsc::Receiver;
use tokio::sync::oneshot;

/// Bounded outbound channel depth (frames). On overflow the reader drops the
/// frame (bytes remain in the ring) and emits a Gap so the GUI resyncs.
const CHAN_CAP: usize = 8192;

/// Create a pipe server instance. Task 7 replaces the body with an owner-only
/// DACL. Under the strictly-sequential lifecycle the previous instance is fully
/// released before the next is created, so `first_pipe_instance(true)` is used
/// every cycle as an ownership guard against a squatter.
pub fn secured_server(name: &str) -> std::io::Result<NamedPipeServer> {
    ServerOptions::new().first_pipe_instance(true).create(name)
}

/// Run the host until teardown.
pub async fn serve(pipe_name: String, token: Option<String>) -> std::io::Result<()> {
    let (events_tx, mut events_rx) = tokio::sync::mpsc::channel::<Data>(CHAN_CAP);
    let (resp_tx, mut resp_rx) = tokio::sync::mpsc::channel::<Response>(CHAN_CAP);
    let mut mgr = SessionManager::new(events_tx, resp_tx, token);

    // Accept the FIRST connection.
    let mut server = secured_server(&pipe_name)?;
    server.connect().await?;

    loop {
        let (erx, rrx) = run_connection(&mut mgr, server, events_rx, resp_rx).await;
        events_rx = erx;
        resp_rx = rrx;

        match mgr.on_gui_disconnect() {
            Disposition::TearDown => return Ok(()),
            Disposition::Hold { deadline } => {
                // Purge stale backlog: reattach replays from the ring, so Hold
                // must not retain a pre-disconnect queue.
                while events_rx.try_recv().is_ok() {}
                while resp_rx.try_recv().is_ok() {}
                match wait_for_reconnect(&pipe_name, deadline).await {
                    Some(s) => server = s, // already connected → loop top
                    None => return Ok(()), // safety-timeout teardown
                }
            }
        }
    }
}

/// Wait for a GUI to reconnect, until the absolute `deadline`. Tolerates
/// transient connect / listener-creation errors (retries) so a flaky reconnect
/// during a hot-swap does not kill held sessions. Returns the connected server,
/// or None if the deadline elapsed.
async fn wait_for_reconnect(pipe_name: &str, deadline: Instant) -> Option<NamedPipeServer> {
    loop {
        if Instant::now() >= deadline {
            return None;
        }
        let next = match secured_server(pipe_name) {
            Ok(s) => s,
            Err(_) => {
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        tokio::select! {
            r = next.connect() => match r {
                Ok(()) => return Some(next),
                Err(_) => {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
            },
            _ = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => {
                return None;
            }
        }
    }
}

/// Serve one connected client until it disconnects. Returns the event/response
/// receivers so the next connection can reuse them.
async fn run_connection(
    mgr: &mut SessionManager,
    server: NamedPipeServer,
    events_rx: Receiver<Data>,
    resp_rx: Receiver<Response>,
) -> (Receiver<Data>, Receiver<Response>) {
    let (mut rd, mut wr) = tokio::io::split(server);
    let (stop_tx, mut stop_rx) = oneshot::channel::<()>();

    let writer = tokio::spawn(async move {
        let mut events_rx = events_rx;
        let mut resp_rx = resp_rx;
        loop {
            tokio::select! {
                _ = &mut stop_rx => break,
                d = events_rx.recv() => match d {
                    Some(d) => {
                        if write_frame(&mut wr, &Frame::Data(d)).await.is_err() { break; }
                    }
                    None => break,
                },
                r = resp_rx.recv() => match r {
                    Some(r) => {
                        if write_frame(&mut wr, &Frame::Resp(r)).await.is_err() { break; }
                    }
                    None => break,
                },
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
    use termflow_pty_protocol::SpawnSpec;
    use tokio::net::windows::named_pipe::ClientOptions;

    fn echo_spec() -> SpawnSpec {
        SpawnSpec {
            shell: "cmd.exe".into(),
            args: vec!["/c".into(), "echo persist".into()],
            env: vec![],
            env_remove: vec![],
            cwd: None,
            cols: 80,
            rows: 24,
        }
    }

    #[tokio::test]
    async fn client_spawns_session_and_receives_output() {
        let pipe = r"\\.\pipe\termflow-pty-host-test-spawn";
        let srv = tokio::spawn(serve(pipe.to_string(), Some("tok".into())));
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

        let mut client = ClientOptions::new().open(pipe).unwrap();
        write_frame(
            &mut client,
            &Frame::Ctrl(Control::Spawn {
                req: 1,
                tab_id: "t1".into(),
                spec: echo_spec(),
            }),
        )
        .await
        .unwrap();

        let mut got = String::new();
        let _ = tokio::time::timeout(std::time::Duration::from_secs(15), async {
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
        let pipe = r"\\.\pipe\termflow-pty-host-test-reattach";
        let srv = tokio::spawn(serve(pipe.to_string(), Some("tok".into())));
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

        {
            let mut c1 = ClientOptions::new().open(pipe).unwrap();
            let spec = SpawnSpec {
                shell: "cmd.exe".into(),
                args: vec!["/k".into(), "echo persist".into()],
                env: vec![],
                env_remove: vec![],
                cwd: None,
                cols: 80,
                rows: 24,
            };
            write_frame(
                &mut c1,
                &Frame::Ctrl(Control::Spawn {
                    req: 1,
                    tab_id: "t1".into(),
                    spec,
                }),
            )
            .await
            .unwrap();
            let _ = tokio::time::timeout(std::time::Duration::from_secs(10), async {
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
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), async {
                while let Ok(Some(f)) = read_frame(&mut c1).await {
                    if matches!(f, Frame::Resp(Response::ArmAck { .. })) {
                        break;
                    }
                }
            })
            .await;
            // Drop c1 → GUI-exit simulation.
        }

        tokio::time::sleep(std::time::Duration::from_millis(300)).await;

        let mut c2 = ClientOptions::new().open(pipe).unwrap();
        write_frame(&mut c2, &Frame::Ctrl(Control::ListSessions { req: 3 }))
            .await
            .unwrap();
        let mut has_t1 = false;
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), async {
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
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), async {
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
}
