//! Retirement end to end: the real client against a real `termflow-pty-host`
//! process, watched by the real ticker. The fake hosts show which frames are
//! sent; only a real host shows that the process is gone afterwards.
//!
//! Isolation: the host gets a randomised endpoint, a temp discovery record and a
//! private token; the test owns the child handle and is the only thing that ever
//! kills it. It never touches a real TermFlow profile and never looks processes
//! up by name. When the host binary has not been built the test skips with a
//! message. It runs on the real clock: ten seconds of emptiness are waited for.

use super::fake_hosts::*;
use super::*;
use crate::pty_host_client::{connect_or_spawn, resolve_bundled_host_path, PtyHostDeps};
use crate::state::host_registry;
use crate::state::host_retire::{start_ticker, EMPTY_FOR, TICK};
use crate::state::host_table::Admission;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

struct RealHost {
    child: Child,
    endpoint: String,
    bin: PathBuf,
    dir: PathBuf,
    // Held for the host's whole life: see `test_dirs::child_process_gate`.
    _gate: std::sync::MutexGuard<'static, ()>,
}

impl Drop for RealHost {
    fn drop(&mut self) {
        // Our own child only; a no-op when it already exited.
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn start_host() -> Option<RealHost> {
    let gate = crate::pty_host_client::test_dirs::child_process_gate();
    let Some(bin) = resolve_bundled_host_path() else {
        eprintln!("skipping: termflow-pty-host is not built (cargo build in src-tauri/pty-host)");
        return None;
    };
    let id = uuid::Uuid::new_v4().simple().to_string();
    let dir = std::env::temp_dir().join(format!("tfhost-retire-{id}"));
    std::fs::create_dir(&dir).unwrap();
    let endpoint = if cfg!(windows) {
        format!(r"\\.\pipe\tf-retire-{id}")
    } else {
        // Short on purpose: socket paths are limited to ~100 bytes.
        format!("/tmp/tf-retire-{}/h.sock", &id[..8])
    };
    let child = Command::new(&bin)
        .env("TERMFLOW_PTY_PIPE", &endpoint)
        .env("TERMFLOW_PTY_TOKEN", "tok")
        .env("TERMFLOW_PTY_RECORD", dir.join("host-record.json"))
        .current_dir(&dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn the test host");
    Some(RealHost { child, endpoint, bin, dir, _gate: gate })
}

async fn wait_for_exit(host: &mut RealHost, within: Duration) -> bool {
    let deadline = Instant::now() + within;
    loop {
        if host.child.try_wait().unwrap().is_some() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// An older host with nothing in it is retired by the ticker alone, and the host
/// process exits: the client really closes the stream, and the host sees EOF.
#[tokio::test]
async fn a_real_empty_host_exits_after_the_ticker_retires_it() {
    let Some(mut host) = start_host() else { return };
    let disconnects = Arc::new(AtomicUsize::new(0));
    let deps = PtyHostDeps {
        lifecycle_token: "tok".into(),
        output_tx: tokio::sync::broadcast::channel(16).0,
        output_produced: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        on_exit: Arc::new(|_, _, _| {}),
        on_gap: Arc::new(|_| {}),
        resolve_process: Arc::new(|k: &str| Some(k.to_string())),
        on_disconnect: {
            let disconnects = disconnects.clone();
            Arc::new(move || {
                disconnects.fetch_add(1, Ordering::SeqCst);
            })
        },
        stream_offsets: Arc::new(dashmap::DashMap::new()),
    };
    // `record_pid` makes the open wait for the endpoint instead of spawning a second host.
    let (client, _origin) = connect_or_spawn(&host.bin, None, &host.endpoint, "tok", Some(host.child.id()), deps)
        .await
        .expect("connect to the test host");
    client.set_shutdown_control(true);
    assert!(client.list_sessions().await.expect("a live host answers").is_empty());

    // Adopted as an older host of an application whose current host lives elsewhere.
    let world = World::new();
    let port = FakePort::new(&world, "somewhere-else");
    let id = port.next_frozen_id();
    let channel = HostChannel::Frozen(id);
    let epoch = port.0.table.reserve_epoch();
    assert!(port.0.table.publish(channel, epoch));
    port.publish_frozen(FrozenHost {
        id,
        generation: None,
        endpoint: host.endpoint.clone(),
        client: client.clone(),
        epoch,
        build_id: None,
        advertised: std::time::SystemTime::UNIX_EPOCH,
        exe_in_payload: Some(false),
    });
    port.0.barrier.finish(&barrier_key(&host.endpoint), &host.endpoint, HostRole::Frozen, Resolution::Resolved);
    start_ticker(&port, id);

    // While the host is held open by its GUI connection and has not been empty
    // long enough, it stays: only the retirement can be why it later goes.
    tokio::time::sleep(EMPTY_FOR - Duration::from_secs(4)).await;
    assert!(host.child.try_wait().unwrap().is_none(), "the host exited before it was retired");
    assert_eq!(port.0.table.admission(channel), Some(Admission::Open));

    assert!(
        wait_for_exit(&mut host, EMPTY_FOR + TICK + Duration::from_secs(10)).await,
        "the retired host's process must exit"
    );
    assert_eq!(port.0.table.admission(channel), Some(Admission::Retired));
    assert!(port.frozen_hosts().is_empty(), "it left the registry");
    assert!(!client.is_alive(), "the client's transport was closed");
    assert_eq!(disconnects.load(Ordering::SeqCst), 0, "closing on purpose is not a drop that would reconnect");
    assert!(host_registry::unfinished_claims_on(&port.0.claims, channel) == 0);
}
