//! Tests for dial-out mode (plan 045). Here the test harness plays the GUI's
//! role as the pipe SERVER and the code under test (`serve_dial`) dials out
//! as the CLIENT — the reverse of every other transport test in this crate.
//! That reversal is the entire point of this mode (see `dial.rs`), so a test
//! suite that only proved the normal listener direction still works would
//! pass even if dial-out mode were entirely inert.

use super::serve_dial;
use crate::transport::{connect, Endpoint, Listener};
use std::time::Duration;
use termflow_pty_protocol::{read_frame, write_frame, Control, Data, Frame, Response, SpawnSpec};

fn test_endpoint(tag: &str) -> Endpoint {
    Endpoint(format!(
        r"\\.\pipe\termflow-dial-test-{}-{tag}",
        std::process::id()
    ))
}

fn persist_spec(stay: bool) -> SpawnSpec {
    let arg = if stay { "/k" } else { "/c" };
    SpawnSpec {
        shell: "cmd.exe".into(),
        args: vec![arg.into(), "echo persist".into()],
        env: vec![],
        env_remove: vec![],
        cwd: None,
        cols: 80,
        rows: 24,
        initial_cursor_row: None,
    }
}

/// A no-`--connect-pipe` sidecar is unaffected by this module: `Listener`
/// still binds and accepts exactly as before. Paired with the dial-out case
/// below per 08 §B-variant — without this, a change that made dial-out the
/// ONLY mode would still pass a suite that only exercised the new mode.
#[tokio::test]
async fn no_args_still_listens() {
    let ep = test_endpoint("no-args");
    let mut listener = Listener::bind(&ep).unwrap();
    let client_ep = ep.clone();
    let client = tokio::spawn(async move {
        for _ in 0..60 {
            if connect(&client_ep).await.is_ok() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("client never reached the default listener");
    });
    listener.accept().await.unwrap();
    client.await.unwrap();
}

#[tokio::test]
async fn dials_the_named_pipe_serves_a_spawn_then_exits_on_eof() {
    let ep = test_endpoint("dial-spawn");
    let mut gui_listener = Listener::bind(&ep).unwrap();

    let sidecar_ep = ep.clone();
    let sidecar = tokio::spawn(serve_dial(sidecar_ep, Some("tok".into()), None));

    let mut gui = gui_listener.accept().await.unwrap();
    write_frame(
        &mut gui,
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
        while let Ok(Some(f)) = read_frame(&mut gui).await {
            if let Frame::Data(Data::Stdout { bytes, .. }) = f {
                got.push_str(&String::from_utf8_lossy(&bytes));
                if got.contains("persist") {
                    break;
                }
            }
        }
    })
    .await;
    assert!(got.contains("persist"), "dial-out sidecar served the spawn");

    // GUI closes its end — the sidecar must exit rather than loop back to
    // accept a second connection: dial-out mode has no Hold path to fall
    // into, by construction (`survivable: false` in `serve_dial`).
    drop(gui);
    drop(gui_listener);
    let result = tokio::time::timeout(Duration::from_secs(5), sidecar).await;
    assert!(
        result.is_ok(),
        "dial-out sidecar must exit promptly on EOF, not wait for a reconnect"
    );
}

#[tokio::test]
async fn dials_arms_holds_and_reconnects_through_rendezvous() {
    let ep1 = test_endpoint("reconnect-gui1");
    let ep2 = test_endpoint("reconnect-gui2");
    let survivor_path = std::env::temp_dir().join(format!("tf-survivor-test-{}.json", std::process::id()));
    let _ = std::fs::remove_file(&survivor_path);

    let mut gui1_listener = Listener::bind(&ep1).unwrap();
    let sidecar_ep = ep1.clone();
    let survivor_clone = survivor_path.clone();
    let sidecar = tokio::spawn(serve_dial(sidecar_ep, Some("tok1".into()), Some(survivor_clone)));

    let mut gui1 = gui1_listener.accept().await.unwrap();

    // 1. Spawn a persistent session
    write_frame(
        &mut gui1,
        &Frame::Ctrl(Control::Spawn {
            req: 1,
            tab_id: "t-admin-1".into(),
            spec: persist_spec(true),
        }),
    )
    .await
    .unwrap();

    let _ = tokio::time::timeout(Duration::from_secs(15), async {
        while let Ok(Some(f)) = read_frame(&mut gui1).await {
            if let Frame::Data(Data::Stdout { bytes, .. }) = f {
                if String::from_utf8_lossy(&bytes).contains("persist") {
                    break;
                }
            }
        }
    })
    .await;

    // 2. Arm detach for offload
    write_frame(
        &mut gui1,
        &Frame::Ctrl(Control::ArmDetach {
            req: 2,
            timeout_secs: 900,
            token: "tok1".into(),
            purpose: Some(termflow_pty_protocol::ArmDetachPurpose::Local),
        }),
    )
    .await
    .unwrap();

    let ack = tokio::time::timeout(Duration::from_secs(5), async {
        while let Ok(Some(f)) = read_frame(&mut gui1).await {
            if let Frame::Resp(Response::ArmAck { req, .. }) = f {
                if req == 2 {
                    return true;
                }
            }
        }
        false
    })
    .await
    .unwrap();
    assert!(ack, "sidecar acknowledged ArmDetach");

    // 3. Drop GUI 1: sidecar must enter Hold and publish survivor record
    drop(gui1);
    drop(gui1_listener);

    let mut survivor = None;
    for _ in 0..60 {
        if let Ok(Some(rec)) = termflow_pty_protocol::read_elevated_survivor(&survivor_path) {
            survivor = Some(rec);
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let survivor = survivor.expect("survivor record was published");
    assert_eq!(survivor.host_pid, std::process::id());

    // 4. GUI 2 pre-binds listener
    let mut gui2_listener = Listener::bind(&ep2).unwrap();

    // 5. High Helper connects to rendezvous pipe and sends reconnect request
    let rendezvous_ep = Endpoint(survivor.rendezvous_pipe.clone());
    let mut rendezvous_client = connect(&rendezvous_ep).await.expect("connect to rendezvous pipe");

    let req = termflow_pty_protocol::ElevatedRendezvousRequest {
        version: termflow_pty_protocol::ELEVATED_RENDEZVOUS_VERSION,
        gui_pid: std::process::id(),
        target_pipe: ep2.0.clone(),
        auth_token: "tok2".into(),
    };
    termflow_pty_protocol::write_rendezvous_request(&mut rendezvous_client, &req).await.unwrap();

    let resp = termflow_pty_protocol::read_rendezvous_response(&mut rendezvous_client).await.unwrap();
    assert_eq!(resp.status, termflow_pty_protocol::ElevatedRendezvousStatus::Ok);

    // 6. Sidecar dials down to GUI 2
    let mut gui2 = gui2_listener.accept().await.expect("GUI 2 accepts re-dialed sidecar");

    // 7. GUI 2 sends ListSessions with the new token
    write_frame(
        &mut gui2,
        &Frame::Ctrl(Control::ListSessions {
            req: 10,
            token: Some("tok2".into()),
        }),
    )
    .await
    .unwrap();

    let sessions = tokio::time::timeout(Duration::from_secs(5), async {
        while let Ok(Some(f)) = read_frame(&mut gui2).await {
            if let Frame::Resp(Response::SessionList { req, sessions }) = f {
                if req == 10 {
                    return sessions;
                }
            }
        }
        vec![]
    })
    .await
    .unwrap();

    assert_eq!(sessions.len(), 1, "session survived hold and reattachment");
    assert_eq!(sessions[0].tab_id, "t-admin-1");
    assert!(sessions[0].alive);

    // 8. GUI 2 orders Shutdown on clean exit
    write_frame(
        &mut gui2,
        &Frame::Ctrl(Control::Shutdown {
            req: 11,
            token: "tok2".into(),
        }),
    )
    .await
    .unwrap();

    drop(gui2);
    drop(gui2_listener);

    let exited = tokio::time::timeout(Duration::from_secs(5), sidecar).await;
    assert!(exited.is_ok(), "sidecar exited promptly after Shutdown");
    let _ = std::fs::remove_file(&survivor_path);
}

