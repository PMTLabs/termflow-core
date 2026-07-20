//! Windows named-pipe server for the PTY host.
//!
//! Correctness notes (from the dual review):
//! - The `SessionManager` is built ONCE and outlives every connection.
//! - `server` entering the main loop is ALWAYS an already-connected instance
//!   (the first is connected before the loop; a reconnect is connected inside
//!   the Hold branch and carried straight in). So the accepted connection is
//!   never dropped and re-created — the bug that severed the reconnecting GUI.
//! - The armed hold uses ONE absolute deadline; a reconnect never restarts it.
//! - The per-connection writer task returns the event/response receivers so
//!   they survive across reconnects (queued frames are not lost with the task).

#![cfg(windows)]

use crate::manager::{Disposition, SessionManager};
use termflow_pty_protocol::{read_frame, write_frame, Control, Data, Frame, Response};
use tokio::io::AsyncWriteExt;
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::sync::oneshot;

/// Create a pipe server instance. Task 7 replaces the body with an owner-only
/// DACL; `first` controls `first_pipe_instance` (ownership guard).
pub fn secured_server(name: &str, first: bool) -> std::io::Result<NamedPipeServer> {
    ServerOptions::new()
        .first_pipe_instance(first)
        .create(name)
}

/// Run the host until teardown. Accepts one GUI client at a time; on an armed
/// disconnect it holds sessions and waits for a reconnect or the safety
/// deadline.
pub async fn serve(pipe_name: String, token: Option<String>) -> std::io::Result<()> {
    let (events_tx, mut events_rx) = tokio::sync::mpsc::unbounded_channel::<Data>();
    let (resp_tx, mut resp_rx) = tokio::sync::mpsc::unbounded_channel::<Response>();
    let mut mgr = SessionManager::new(events_tx, resp_tx, token);

    // Accept the FIRST connection.
    let mut server = secured_server(&pipe_name, true)?;
    server.connect().await?;

    loop {
        // `server` is an already-connected instance here.
        let (erx, rrx) = run_connection(&mut mgr, server, events_rx, resp_rx).await;
        events_rx = erx;
        resp_rx = rrx;

        match mgr.on_gui_disconnect() {
            Disposition::TearDown => return Ok(()),
            Disposition::Hold { deadline } => {
                let next = secured_server(&pipe_name, false)?;
                tokio::select! {
                    r = next.connect() => {
                        r?;
                        server = next; // already connected → straight into run_connection
                    }
                    _ = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => {
                        // Safety teardown: dropping `mgr` (return) drops all
                        // sessions, which kills their children.
                        return Ok(());
                    }
                }
            }
        }
    }
}

/// Serve one connected client until it disconnects. Returns the event/response
/// receivers so the next connection can reuse them.
async fn run_connection(
    mgr: &mut SessionManager,
    server: NamedPipeServer,
    events_rx: UnboundedReceiver<Data>,
    resp_rx: UnboundedReceiver<Response>,
) -> (UnboundedReceiver<Data>, UnboundedReceiver<Response>) {
    let (mut rd, mut wr) = tokio::io::split(server);
    let (stop_tx, mut stop_rx) = oneshot::channel::<()>();

    // Writer task: drains outbound events + responses to the client. Owns the
    // receivers and returns them when the connection ends.
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

    // Reader loop: dispatch inbound control/stdin into the manager.
    loop {
        match read_frame(&mut rd).await {
            Ok(Some(Frame::Ctrl(c))) => mgr.handle_control(c),
            Ok(Some(Frame::Data(Data::Stdin { tab_id, bytes }))) => {
                mgr.handle_stdin(&tab_id, &bytes)
            }
            Ok(Some(_)) => {}         // GUI never sends Resp/Stdout/Exit
            Ok(None) | Err(_) => break, // client disconnected
        }
    }

    let _ = stop_tx.send(());
    writer.await.unwrap_or_else(|_| {
        // The writer task cannot panic; if it were cancelled we cannot recover
        // the receivers, so make fresh ones (only reachable on runtime shutdown).
        let (_e_tx, e_rx) = tokio::sync::mpsc::unbounded_channel();
        let (_r_tx, r_rx) = tokio::sync::mpsc::unbounded_channel();
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
        // Give the server a moment to create + listen.
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

        // Connection 1: spawn a long-lived shell, arm, then drop the client.
        {
            let mut c1 = ClientOptions::new().open(pipe).unwrap();
            // A shell that stays alive so it survives the reconnect.
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
            // Wait for the Spawned ack so the session exists before arming.
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

        // Give the server time to observe the drop and hold.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;

        // Connection 2: reconnect, list sessions, attach, expect replay.
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
