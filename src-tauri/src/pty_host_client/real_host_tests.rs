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
#[path = "real_key_exit_tests.rs"]
mod real_key_exit_tests;
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

#[cfg(windows)]
async fn raw_identity_connection(host: &RealHost) -> tokio::net::windows::named_pipe::NamedPipeClient {
    match open_with_grace(
        || std::future::ready(tokio::net::windows::named_pipe::ClientOptions::new().open(&host.endpoint)),
        live_host_probe(Some(host.child.id())), OPEN_GRACE_SHORT, OPEN_GRACE_LONG, OPEN_GRACE_STEP,
    ).await {
        OpenOutcome::Connected(stream) => stream,
        _ => panic!("the isolated host did not open its endpoint"),
    }
}

#[cfg(unix)]
async fn raw_identity_connection(host: &RealHost) -> tokio::net::UnixStream {
    match open_with_grace(
        || tokio::net::UnixStream::connect(&host.endpoint),
        live_host_probe(Some(host.child.id())), OPEN_GRACE_SHORT, OPEN_GRACE_LONG, OPEN_GRACE_STEP,
    ).await {
        OpenOutcome::Connected(stream) => stream,
        _ => panic!("the isolated host did not open its endpoint"),
    }
}

#[tokio::test]
async fn a_real_respawn_uses_a_new_key_and_rejects_held_output_from_the_closed_shell() {
    use std::sync::{Arc, Mutex, atomic::{AtomicBool, AtomicU64, Ordering}};
    use termflow_pty_protocol::{read_frame, write_frame, Frame, Data, SpawnSpec};
    use crate::state::{HostTable, mint_process_id, mint_session_key};
    use crate::elevated_host::HostChannel;
    let Some(host) = start_host() else { return };
    let stream = raw_identity_connection(&host).await;
    let (mut host_read, mut host_write) = tokio::io::split(stream);
    let (gui, relay) = tokio::io::duplex(65536);
    let (mut gui_read, gui_write) = tokio::io::split(relay);
    let gui_write = Arc::new(tokio::sync::Mutex::new(gui_write));
    let first_session_key = mint_session_key("tm-real").unwrap();
    let second_session_key = mint_session_key("tm-real").unwrap();
    assert_ne!(first_session_key, second_session_key);
    let process_first = mint_process_id().unwrap();
    let process_second = mint_process_id().unwrap();
    let table = HostTable::new();
    let epoch = table.reserve_epoch().unwrap();
    assert!(table.publish(HostChannel::Primary, epoch));
    table.routes().register(HostChannel::Primary, &first_session_key, &process_first, epoch);
    let armed = Arc::new(AtomicBool::new(false));
    let captured = Arc::new(Mutex::new(None));
    let (reached_tx, reached_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let (delivered_tx, delivered_rx) = tokio::sync::oneshot::channel();
    let reader = tokio::spawn({
        let (writer, key, armed, captured) = (gui_write.clone(), first_session_key.clone(), armed.clone(), captured.clone());
        async move {
            let mut hold = Some((reached_tx, release_rx, delivered_tx));
            let mut held = None;
            while let Ok(Some(frame)) = read_frame(&mut host_read).await {
                let target = matches!(&frame, Frame::Data(Data::Stdout { tab_id, bytes, .. })
                    if tab_id == &key && bytes.windows(b"OLD_SHELL_MARKER".len()).any(|b| b == b"OLD_SHELL_MARKER"));
                if target && armed.swap(false, Ordering::SeqCst) {
                    let (reached, release, delivered) = hold.take().unwrap();
                    if let Frame::Data(Data::Stdout { bytes, .. }) = &frame { *captured.lock().unwrap() = Some(bytes.clone()); }
                    let writer = writer.clone();
                    held = Some(tokio::spawn(async move {
                        reached.send(()).unwrap();
                        release.await.unwrap();
                        write_frame(&mut *writer.lock().await, &frame).await.unwrap();
                        delivered.send(()).unwrap();
                    }));
                } else {
                    write_frame(&mut *writer.lock().await, &frame).await.unwrap();
                }
            }
            if let Some(held) = held { held.abort(); }
        }
    });
    let writer = tokio::spawn(async move {
        while let Ok(Some(frame)) = read_frame(&mut gui_read).await {
            write_frame(&mut host_write, &frame).await.unwrap();
        }
    });
    let (output_tx, mut output) = tokio::sync::broadcast::channel(128);
    let exits = Arc::new(Mutex::new(Vec::new()));
    let deps = PtyHostDeps {
        lifecycle_token: "tok".into(), output_tx,
        output_produced: Arc::new(AtomicU64::new(0)), stream_offsets: Arc::new(dashmap::DashMap::new()),
        resolve_process: { let table = table.clone(); Arc::new(move |key| table.routes().resolve(
            HostChannel::Primary, key, epoch, table.is_current(HostChannel::Primary, epoch),
        )) },
        on_exit: { let exits = exits.clone(); Arc::new(move |process, _, _| exits.lock().unwrap().push(process)) },
        on_gap: Arc::new(|_| {}), on_disconnect: Arc::new(|| {}),
    };
    let (read, write) = tokio::io::split(gui);
    let client = wire_client(read, write, deps);
    let spec = SpawnSpec {
        shell: if cfg!(windows) { "cmd.exe" } else { "/bin/sh" }.into(),
        args: if cfg!(windows) { vec!["/D".into(), "/Q".into()] } else { vec!["-i".into()] },
        env: vec![], env_remove: vec![], cwd: None, cols: 80, rows: 24,
    };
    assert!(client.spawn_session(&first_session_key, &spec).await.unwrap() > 0);
    let initial = tokio::time::timeout(Duration::from_secs(5), output.recv()).await.unwrap().unwrap();
    assert_eq!(initial.id, process_first);
    assert!(!initial.data.is_empty());
    armed.store(true, Ordering::SeqCst);
    client.write_stdin(&first_session_key, b"echo OLD_SHELL_MARKER\r\n");
    tokio::time::timeout(Duration::from_secs(5), reached_rx).await.unwrap().unwrap();
    assert!(captured.lock().unwrap().as_ref().unwrap().windows(16).any(|b| b == b"OLD_SHELL_MARKER"));
    table.routes().remove_process(&process_first);
    client.close(&first_session_key);
    assert!(!client.list_sessions().await.unwrap().iter().any(|meta| meta.tab_id == first_session_key));
    table.routes().register(HostChannel::Primary, &second_session_key, &process_second, epoch);
    assert!(client.spawn_session(&second_session_key, &spec).await.unwrap() > 0);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let payload = output.recv().await.unwrap();
            if payload.id == process_second { assert!(!payload.data.is_empty()); break; }
            assert_eq!(payload.id, process_first, "only buffered first-shell control output may precede the replacement");
        }
    }).await.unwrap();
    while output.try_recv().is_ok() {}
    release_tx.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), delivered_rx).await.unwrap().unwrap();
    assert!(client.list_sessions().await.unwrap().iter().any(|meta| meta.tab_id == second_session_key && meta.alive));
    let late = captured.lock().unwrap().clone().unwrap();
    while let Ok(payload) = output.try_recv() {
        assert_eq!(payload.id, process_second);
        assert_ne!(payload.data, late, "the held old frame must not reach the replacement");
    }
    assert!(!exits.lock().unwrap().contains(&process_second));
    assert!(table.routes().dropped_frames() > 0);
    client.close(&second_session_key);
    assert!(client.list_sessions().await.unwrap().is_empty());
    assert!(client.close_transport().await);
    reader.abort();
    writer.abort();
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
