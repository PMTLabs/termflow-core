//! Tests for dial-out mode (plan 045). Here the test harness plays the GUI's
//! role as the pipe SERVER and the code under test (`serve_dial`) dials out
//! as the CLIENT — the reverse of every other transport test in this crate.
//! That reversal is the entire point of this mode (see `dial.rs`), so a test
//! suite that only proved the normal listener direction still works would
//! pass even if dial-out mode were entirely inert.

use super::serve_dial;
use crate::transport::{connect, Endpoint, Listener};
use std::time::Duration;
use termflow_pty_protocol::{read_frame, write_frame, Control, Data, Frame, SpawnSpec};

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
    let sidecar = tokio::spawn(serve_dial(sidecar_ep, Some("tok".into())));

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
