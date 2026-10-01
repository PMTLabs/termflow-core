//! The real client against a real `termflow-pty-host` process: the only place
//! "closing the transport makes the host see EOF" is proven end to end, rather
//! than against a duplex.
//!
//! Isolation: every host gets a randomised endpoint, a temp discovery record and
//! a private token; the test owns the child handle and is the only thing that
//! ever kills it. It never touches a real TermFlow profile and never looks
//! processes up by name. When the host binary has not been built the tests skip
//! with a message.
use super::*;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

struct RealHost {
    child: Child,
    endpoint: String,
    bin: PathBuf,
    _dir: test_dirs::TestDir,
    // Held for the host's whole life: see `test_dirs::child_process_gate`.
    _gate: std::sync::MutexGuard<'static, ()>,
}

impl Drop for RealHost {
    fn drop(&mut self) {
        // Our own child only; a no-op when it already exited.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn start_host() -> Option<RealHost> {
    let gate = test_dirs::child_process_gate();
    let Some(bin) = resolve_bundled_host_path() else {
        eprintln!("skipping: termflow-pty-host is not built (cargo build in src-tauri/pty-host)");
        return None;
    };
    let dir = test_dirs::tempdir().unwrap();
    let id = uuid::Uuid::new_v4().simple().to_string();
    let endpoint = if cfg!(windows) {
        format!(r"\\.\pipe\tf-real-{id}")
    } else {
        // Short on purpose: socket paths are limited to ~100 bytes.
        format!("/tmp/tf-real-{}/h.sock", &id[..8])
    };
    let child = Command::new(&bin)
        .env("TERMFLOW_PTY_PIPE", &endpoint)
        .env("TERMFLOW_PTY_TOKEN", "tok")
        .env("TERMFLOW_PTY_RECORD", dir.path().join("host-record.json"))
        .current_dir(dir.path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn the test host");
    Some(RealHost { child, endpoint, bin, _dir: dir, _gate: gate })
}

/// Connect to the host we started. `record_pid` makes the open wait for the
/// endpoint (up to the long grace window) instead of spawning a second host.
async fn connect(host: &RealHost) -> (PtyHostClient, conn_tests::Counters) {
    let (deps, counters) = conn_tests::deps();
    let (client, origin) = connect_or_spawn(
        &host.bin,
        None,
        &host.endpoint,
        "tok",
        Some(host.child.id()),
        deps,
    )
    .await
    .expect("connect to the test host");
    assert_eq!(origin, HostConnectionOrigin::Adopted, "we started it, the client only adopts");
    (client, counters)
}

async fn wait_for_exit(host: &mut RealHost, within: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + within;
    loop {
        if host.child.try_wait().unwrap().is_some() {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// An empty host exits once its GUI connection is gone. Dropping the client
/// cannot produce that (the reader still holds the stream); `close_transport`
/// must.
#[tokio::test]
async fn close_transport_makes_empty_host_exit() {
    let Some(mut host) = start_host() else { return };
    let (client, counters) = connect(&host).await;

    let listed = client.list_sessions().await.expect("a live host answers the listing");
    assert!(listed.is_empty());
    assert!(
        !wait_for_exit(&mut host, Duration::from_millis(1500)).await,
        "the host must stay up while its GUI connection is open"
    );

    assert!(client.close_transport().await);
    assert!(
        wait_for_exit(&mut host, Duration::from_secs(15)).await,
        "the empty host must exit after the transport is really closed"
    );
    assert_eq!(
        counters.disconnects.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "an intentional close is not a disconnect"
    );
}

/// The connection pid identifies the host we actually talk to, and the image
/// path it yields is classified against the root it runs from.
#[cfg(windows)]
#[tokio::test]
async fn real_host_origin_is_found_via_connection_pid() {
    let Some(mut host) = start_host() else { return };
    let (client, _counters) = connect(&host).await;
    assert_eq!(client.exe_origin.server_pid(), Some(host.child.id()));

    let host_dir = host.bin.parent().unwrap().to_path_buf();
    let elsewhere = test_dirs::tempdir().unwrap();
    assert_eq!(client.exe_origin.in_payload(Some(&host_dir), None), Some(true));
    assert_eq!(client.exe_origin.in_payload(Some(elsewhere.path()), None), Some(false));
    assert_eq!(client.exe_origin.in_payload(Some(&host_dir), Some(&host_dir)), Some(false));

    client.close_transport().await;
    assert!(wait_for_exit(&mut host, Duration::from_secs(15)).await);
}
