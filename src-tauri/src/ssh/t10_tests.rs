//! Final acceptance paths: actual memory transport loss/blackhole and clean exit.
use super::{auth::BoxFuture, session::*, tests::*};
use parking_lot::Mutex;
use std::{
    collections::HashMap,
    sync::{atomic::Ordering, Arc},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

struct Relay {
    server: Server,
    blackhole: CancellationToken,
    stop: CancellationToken,
    tasks: Mutex<Vec<tokio::task::JoinHandle<()>>>,
}
impl Relay {
    fn new(server: Server) -> Arc<Self> {
        Arc::new(Self {
            server,
            blackhole: CancellationToken::new(),
            stop: CancellationToken::new(),
            tasks: Mutex::new(vec![]),
        })
    }
    async fn drain(&self) {
        self.stop.cancel();
        let tasks = std::mem::take(&mut *self.tasks.lock());
        for task in tasks {
            tokio::time::timeout(Duration::from_secs(1), task)
                .await
                .unwrap()
                .unwrap();
        }
        tokio::time::timeout(Duration::from_secs(1), async {
            while self.server.counters.live_connections.load(Ordering::SeqCst) != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("memory server tasks did not reach EOF");
    }
}
impl StreamFactory for Relay {
    fn connect<'a>(
        &'a self,
        hop: &'a SessionHop,
    ) -> BoxFuture<'a, Result<BoxStream, SessionError>> {
        Box::pin(async move {
            let mut remote = MemoryStreams(self.server.clone()).connect(hop).await?;
            let (mut peer, client) = tokio::io::duplex(64 * 1024);
            let stop = self.stop.clone();
            let blackhole = self.blackhole.clone();
            self.tasks.lock().push(tokio::spawn(async move {
                tokio::select! {
                    _ = stop.cancelled() => {},
                    _ = blackhole.cancelled() => { stop.cancelled().await; },
                    _ = tokio::io::copy_bidirectional(&mut peer, &mut remote) => {},
                }
                // Keep both sides open while blackholed, then genuine EOF on stop.
                drop((peer, remote));
            }));
            Ok(Box::new(client) as BoxStream)
        })
    }
}
struct Switchable(Mutex<Arc<Relay>>);
impl StreamFactory for Switchable {
    fn connect<'a>(
        &'a self,
        hop: &'a SessionHop,
    ) -> BoxFuture<'a, Result<BoxStream, SessionError>> {
        Box::pin(async move {
            let relay = self.0.lock().clone();
            relay.connect(hop).await
        })
    }
}
fn configure(f: &Fixture, relay: Arc<dyn StreamFactory>) {
    f.registry
        .configure(Dependencies {
            targets: Arc::new(Targets(SessionTarget {
                hops: vec![hop("c-a", "alice")],
            })),
            streams: relay,
            agents: Arc::new(NativeAgent),
            secrets: f.secrets.clone(),
            events: f.events.clone(),
            known_hosts: super::known_hosts::KnownHosts {
                path: f.path.clone(),
            },
            home: f.path.parent().unwrap().into(),
        })
        .unwrap();
}
async fn auth(f: &Fixture, id: &str, probe: bool) -> SessionView {
    let v = wait_state(&f.registry, id, probe, SessionState::NeedsSecret).await;
    f.registry
        .submit_secret(
            id,
            probe,
            Some(v.generation),
            v.prompt_id.as_deref(),
            f.server.password.clone(),
            false,
        )
        .unwrap();
    if !probe {
        f.registry
            .on_launch_lifecycle(
                id,
                v.generation,
                1,
                LaunchState::Running,
                Some("pc-acceptance".into()),
            )
            .unwrap();
    }
    wait_state(&f.registry, id, probe, SessionState::Connected).await
}
#[tokio::test]
async fn memory_end_to_end_trust_auth_exec_sftp_drop_reconnect() {
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], false);
    let relay = Relay::new(f.server.clone());
    let streams = Arc::new(Switchable(Mutex::new(relay.clone())));
    configure(&f, streams.clone());
    let first = f.registry.open("tm-a", "c-a", false, || true).unwrap();
    let trust = wait_state(&f.registry, "tm-a", false, SessionState::NeedsHostkey).await;
    assert_eq!(f.server.counters.auth.load(Ordering::SeqCst), 0);
    f.registry
        .trust_host(
            "tm-a",
            false,
            Some(first.generation),
            trust.prompt_id.as_deref(),
            true,
        )
        .unwrap();
    auth(&f, "tm-a", false).await;
    let lease = f.registry.lease("tm-a").unwrap();
    assert_eq!(
        lease.exec("fixture").await.unwrap(),
        ExecOutput {
            stdout: b"fixture-output".to_vec(),
            stderr: b"fixture-stderr".to_vec(),
            exit: 7
        }
    );
    lease.sftp().await.unwrap();
    assert_eq!(f.server.counters.subsystems.load(Ordering::SeqCst), 1);
    assert_eq!(*f.server.counters.principals.lock(), vec!["alice"]);
    // Drop the actual duplex relay, not a synthetic registry disconnect.
    relay.drain().await;
    wait_state(&f.registry, "tm-a", false, SessionState::Disconnected).await;
    assert!(lease.exec("stale").await.is_err());
    assert!(f.registry.lease("tm-a").is_err());
    let next_relay = Relay::new(f.server.clone());
    *streams.0.lock() = next_relay.clone();
    let second = f.registry.reconnect("tm-a", || true).unwrap();
    assert!(second.generation > first.generation);
    auth(&f, "tm-a", false).await;
    let renewed = f.registry.lease("tm-a").unwrap();
    assert_eq!(renewed.exec("fixture").await.unwrap().exit, 7);
    renewed.sftp().await.unwrap();
    assert_eq!(f.server.counters.handshakes.load(Ordering::SeqCst), 2);
    let mut sequence = vec![(first.generation, SessionState::Connecting)];
    sequence.extend(f.events.0.lock().iter().map(|v| (v.generation, v.state)));
    sequence.dedup();
    use SessionState::*;
    assert_eq!(
        sequence,
        vec![
            (first.generation, Connecting),
            (first.generation, NeedsHostkey),
            (first.generation, Connecting),
            (first.generation, NeedsSecret),
            (first.generation, Connecting),
            (first.generation, Connected),
            (first.generation, Disconnected),
            (second.generation, Connecting),
            (second.generation, NeedsSecret),
            (second.generation, Connecting),
            (second.generation, Connected),
        ]
    );
    f.registry.shutdown().await;
    next_relay.drain().await;
}
#[tokio::test]
async fn keepalive_blackhole_disconnects_within_budget() {
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
    let relay = Relay::new(f.server.clone());
    configure(&f, relay.clone());
    let (_, lease) = f.connected().await;
    relay.blackhole.cancel();
    tokio::task::yield_now().await;
    tokio::time::pause();
    for _ in 0..75 {
        tokio::time::advance(Duration::from_secs(1)).await;
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
        if f.registry.state("tm-a", false).unwrap().state == SessionState::Disconnected {
            break;
        }
    }
    assert_eq!(
        f.registry.state("tm-a", false).unwrap().state,
        SessionState::Disconnected
    );
    assert!(lease.exec("stale").await.is_err());
    tokio::time::resume();
    f.registry.shutdown().await;
    relay.drain().await;
}
#[tokio::test]
async fn app_exit_leaves_no_probe_session_task_or_stream() {
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
    let relay = Relay::new(f.server.clone());
    configure(&f, relay.clone());
    let (_, lease) = f.connected().await;
    let probe = f.registry.probe("c-a").unwrap();
    wait_state(&f.registry, &probe, true, SessionState::NeedsSecret).await;
    f.registry.shutdown().await;
    relay.drain().await;
    assert_eq!(f.registry.owner_map(), HashMap::new());
    assert_eq!(f.registry.state(&probe, true), Err(SessionError::NotFound));
    assert!(lease.exec("stale").await.is_err());
    assert_eq!(f.registry.probe("c-a"), Err(SessionError::AdmissionClosed));
    assert!(relay.tasks.lock().is_empty());
}
#[test]
fn ci_ssh_tests_are_default_on_all_three_os() {
    let workflow = include_str!("../../../.github/workflows/rust-tests.yml");
    for os in ["ubuntu-latest", "windows-latest", "macos-latest"] {
        assert!(workflow.contains(os), "missing OS {os}");
    }
    assert!(workflow.contains("cargo test ${{ matrix.test-args }}"));
    assert!(workflow.contains("cargo test --lib --no-run --message-format=json"));
    assert!(workflow.contains("& $executables[0] --nocapture"));
    let modules = include_str!("mod.rs");
    assert!(
        modules.contains("#[cfg(test)]\nmod t10_tests;")
            || modules.contains("#[cfg(test)]\r\nmod t10_tests;")
    );
    assert!(!modules.contains("#[cfg(feature = \"integration-tests\")]"));
}
