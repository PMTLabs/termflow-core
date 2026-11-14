//! All transport fixtures use duplex streams, injected trust paths and memory keys.
use super::{
    auth::{AuthBinding, BoxFuture, SecretSink},
    known_hosts::KnownHosts,
    session::*,
};
use parking_lot::Mutex;
use russh::{
    server::{self, Auth, Msg, Session},
    Channel, ChannelId,
};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

pub fn key(seed: u8) -> ssh_key::PrivateKey {
    ssh_key::PrivateKey::from(ssh_key::private::Ed25519Keypair::from_seed(&[seed; 32]))
}
#[derive(Default)]
pub struct Counters {
    pub live_connections: AtomicUsize,
    pub handshakes: AtomicUsize,
    pub auth: AtomicUsize,
    pub subsystems: AtomicUsize,
    pub closed_channels: AtomicUsize,
    pub principals: Mutex<Vec<String>>,
    pub direct_addresses: Mutex<Vec<(String, u32)>>,
}
#[derive(Clone)]
pub struct Server {
    pub host: ssh_key::PrivateKey,
    pub client: ssh_key::PublicKey,
    pub password: String,
    pub user: String,
    pub counters: Arc<Counters>,
    pub refuse: bool,
    pub target: Option<Box<Server>>,
    pub deny_jump: bool,
    channels: Arc<Mutex<HashMap<ChannelId, Channel<Msg>>>>,
}
impl Server {
    pub fn new(seed: u8, user: &str) -> Self {
        Self {
            host: key(seed),
            client: key(seed + 10).public_key().clone(),
            password: format!("password-{user}"),
            user: user.into(),
            counters: Arc::new(Counters::default()),
            refuse: false,
            target: None,
            deny_jump: false,
            channels: Arc::new(Mutex::new(HashMap::new())),
        }
    }
    fn start(self, stream: BoxStream) {
        self.counters.handshakes.fetch_add(1, Ordering::SeqCst);
        let config = server::Config {
            keys: vec![self.host.clone()],
            auth_rejection_time: Duration::ZERO,
            auth_rejection_time_initial: Some(Duration::ZERO),
            ..Default::default()
        };
        let counters = self.counters.clone();
        counters.live_connections.fetch_add(1, Ordering::SeqCst);
        tokio::spawn(async move {
            if let Ok(server) = server::run_stream(Arc::new(config), stream, self).await {
                let _ = server.await;
            }
            counters.live_connections.fetch_sub(1, Ordering::SeqCst);
        });
    }
}
impl server::Handler for Server {
    type Error = russh::Error;
    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        self.counters.auth.fetch_add(1, Ordering::SeqCst);
        self.counters.principals.lock().push(user.into());
        Ok(if user == self.user && password == self.password {
            Auth::Accept
        } else {
            Auth::reject()
        })
    }
    async fn auth_publickey(
        &mut self,
        user: &str,
        key: server::VerifiedPublicKey<'_>,
    ) -> Result<Auth, Self::Error> {
        self.counters.auth.fetch_add(1, Ordering::SeqCst);
        self.counters.principals.lock().push(user.into());
        Ok(
            if user == self.user && key.public_key.key_data() == self.client.key_data() {
                Auth::Accept
            } else {
                Auth::reject()
            },
        )
    }
    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut Session,
    ) -> Result<(), Self::Error> {
        self.channels.lock().insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }
    async fn channel_close(&mut self, id: ChannelId, _: &mut Session) -> Result<(), Self::Error> {
        self.counters.closed_channels.fetch_add(1, Ordering::SeqCst);
        self.channels.lock().remove(&id);
        Ok(())
    }
    async fn exec_request(
        &mut self,
        ch: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if self.refuse {
            session.channel_failure(ch)?;
            return Ok(());
        }
        session.channel_success(ch)?;
        if data == b"hang" {
            return Ok(());
        }
        if data == b"oversize" {
            let handle = session.handle();
            tokio::spawn(async move {
                for _ in 0..128 {
                    if handle.data(ch, vec![b'x'; 16384]).await.is_err() {
                        break;
                    }
                }
                // Leave the channel open: the output-cap reader must close it.
            });
            return Ok(());
        }
        session.data(ch, b"fixture-output".to_vec())?;
        session.extended_data(ch, 1, b"fixture-stderr".to_vec())?;
        if data != b"no-exit" {
            session.exit_status_request(ch, 7)?;
        }
        session.eof(ch)?;
        session.close(ch)?;
        Ok(())
    }
    async fn subsystem_request(
        &mut self,
        ch: ChannelId,
        _: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.counters.subsystems.fetch_add(1, Ordering::SeqCst);
        if self.refuse {
            session.channel_failure(ch)?;
            return Ok(());
        }
        session.channel_success(ch)?;
        let channel = self.channels.lock().remove(&ch).unwrap();
        tokio::spawn(async move {
            let mut stream = channel.into_stream();
            let mut init = [0; 9];
            if stream.read_exact(&mut init).await.is_ok() {
                assert_eq!(init, [0, 0, 0, 5, 1, 0, 0, 0, 3]);
                let _ = stream.write_all(&[0, 0, 0, 5, 2, 0, 0, 0, 3]).await;
                let mut discard = [0; 1024];
                while stream.read(&mut discard).await.is_ok_and(|n| n > 0) {}
            }
        });
        Ok(())
    }
    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<Msg>,
        host: &str,
        port: u32,
        _: &str,
        _: u32,
        reply: server::ChannelOpenHandle,
        _: &mut Session,
    ) -> Result<(), Self::Error> {
        if self.deny_jump {
            return Ok(());
        }
        self.counters
            .direct_addresses
            .lock()
            .push((host.into(), port));
        if let Some(target) = self.target.clone() {
            reply.accept().await;
            target.start(Box::new(channel.into_stream()));
        }
        Ok(())
    }
}
pub struct MemoryStreams(pub Server);
impl StreamFactory for MemoryStreams {
    fn connect<'a>(&'a self, _: &'a SessionHop) -> BoxFuture<'a, Result<BoxStream, SessionError>> {
        Box::pin(async move {
            let (server, client) = tokio::io::duplex(64 * 1024);
            self.0.clone().start(Box::new(server));
            Ok(Box::new(client) as BoxStream)
        })
    }
}
#[derive(Default)]
pub struct Capture(pub Mutex<Vec<SessionView>>);
impl EventSink for Capture {
    fn emit(&self, _: &'static str, view: &SessionView) {
        self.0.lock().push(view.clone());
    }
}
pub struct Targets(pub SessionTarget);
impl TargetSource for Targets {
    fn resolve<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<SessionTarget, SessionError>> {
        Box::pin(async { Ok(self.0.clone()) })
    }
}
#[derive(Default)]
pub struct Secrets {
    pub values: Mutex<HashMap<String, (AuthBinding, String)>>,
    pub saves: AtomicUsize,
}
impl SecretSink for Secrets {
    fn load<'a>(
        &'a self,
        binding: &'a AuthBinding,
    ) -> BoxFuture<'a, Result<Option<String>, SessionError>> {
        Box::pin(async move {
            Ok(self
                .values
                .lock()
                .get(&binding.connection_id)
                .filter(|(b, _)| b == binding)
                .map(|(_, s)| s.clone()))
        })
    }
    fn set_secret_if_binding_matches<'a>(
        &'a self,
        binding: &'a AuthBinding,
        ciphertext: String,
        cancel: CancellationToken,
    ) -> BoxFuture<'a, Result<(), SessionError>> {
        Box::pin(async move {
            let mut values = self.values.lock();
            if cancel.is_cancelled() {
                return Err(SessionError::Cancelled);
            }
            if values
                .get(&binding.connection_id)
                .is_some_and(|(b, _)| b != binding)
            {
                return Err(SessionError::StaleAttempt);
            }
            self.saves.fetch_add(1, Ordering::SeqCst);
            values.insert(binding.connection_id.clone(), (binding.clone(), ciphertext));
            Ok(())
        })
    }
}
pub struct Fixture {
    pub registry: Arc<SessionRegistry>,
    pub server: Server,
    pub events: Arc<Capture>,
    pub secrets: Arc<Secrets>,
    pub path: PathBuf,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(self.path.parent().unwrap());
    }
}
pub fn hop(connection: &str, user: &str) -> SessionHop {
    SessionHop {
        connection_id: connection.into(),
        host: "target.test".into(),
        port: 22,
        user: user.into(),
        auth: AuthMethod::Password,
        identity_file: None,
    }
}
impl Fixture {
    pub fn new(server: Server, hops: Vec<SessionHop>, trusted: bool) -> Self {
        let root = std::env::temp_dir().join(format!("tf-memory-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("known_hosts");
        if trusted {
            let mut bytes = format!(
                "{} {}\n",
                super::known_hosts::lookup_token(&hops[0].host, hops[0].port),
                server.host.public_key().to_openssh().unwrap()
            );
            if let Some(target) = &server.target {
                bytes.push_str(&format!(
                    "{} {}\n",
                    super::known_hosts::lookup_token(
                        &hops.last().unwrap().host,
                        hops.last().unwrap().port
                    ),
                    target.host.public_key().to_openssh().unwrap()
                ));
            }
            std::fs::write(&path, bytes).unwrap();
        }
        let events = Arc::new(Capture::default());
        let secrets = Arc::new(Secrets::default());
        let registry = Arc::new(SessionRegistry::new(Dependencies {
            targets: Arc::new(Targets(SessionTarget { hops })),
            streams: Arc::new(MemoryStreams(server.clone())),
            agents: Arc::new(NativeAgent),
            secrets: secrets.clone(),
            events: events.clone(),
            known_hosts: KnownHosts { path: path.clone() },
            home: root,
        }));
        Self {
            registry,
            server,
            events,
            secrets,
            path,
        }
    }
    pub async fn connected(&self) -> (String, Arc<SshSession>) {
        self.registry.open("tm-a", "c-a", false, || true).unwrap();
        let v = wait_state(&self.registry, "tm-a", false, SessionState::NeedsSecret).await;
        self.registry
            .submit_secret(
                "tm-a",
                false,
                Some(v.generation),
                v.prompt_id.as_deref(),
                self.server.password.clone(),
                false,
            )
            .unwrap();
        self.registry
            .on_launch_lifecycle(
                "tm-a",
                v.generation,
                1,
                LaunchState::Running,
                Some("pc-a".into()),
            )
            .unwrap();
        wait_state(&self.registry, "tm-a", false, SessionState::Connected).await;
        ("tm-a".into(), self.registry.lease("tm-a").unwrap())
    }
}
pub async fn wait_state(
    registry: &SessionRegistry,
    id: &str,
    probe: bool,
    expected: SessionState,
) -> SessionView {
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let view = registry.state(id, probe).unwrap();
            if view.state == expected {
                return view;
            }
            assert!(
                !matches!(view.state, SessionState::Error | SessionState::Disconnected),
                "unexpected {view:?}, expected {expected:?}"
            );
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .expect("state transition deadline")
}

#[tokio::test]
async fn spike_memory_handshake_exec_sftp() {
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
    let (_, session) = f.connected().await;
    assert_eq!(
        session.exec("fixture").await.unwrap(),
        ExecOutput {
            stdout: b"fixture-output".to_vec(),
            stderr: b"fixture-stderr".to_vec(),
            exit: 7
        }
    );
    session.sftp().await.unwrap();
    assert_eq!(f.server.counters.subsystems.load(Ordering::SeqCst), 1);
    f.registry.shutdown().await;
}
#[test]
fn spike_manifest_pins_one_backend_and_key_version() {
    let manifest = include_str!("../../Cargo.toml");
    let lock = include_str!("../../Cargo.lock");
    assert!(manifest.contains("russh = { version = \"=0.65.1\", default-features = false, features = [\"ring\", \"rsa\"] }"));
    assert!(manifest.contains("rust-version = \"1.89\""));
    assert!(!lock.contains("name = \"aws-lc"));
    assert_eq!(lock.matches("name = \"ssh-key\"").count(), 1);
}
#[tokio::test]
async fn duplicate_open_has_one_exact_owner_and_one_transport() {
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
    let a = f.registry.open("tm-a", "c-a", false, || true).unwrap();
    let b = f.registry.open("tm-a", "c-a", false, || true).unwrap();
    assert_eq!(a.generation, b.generation);
    wait_state(&f.registry, "tm-a", false, SessionState::NeedsSecret).await;
    assert_eq!(
        f.registry.owner_map(),
        HashMap::from([("tm-a".into(), ("c-a".into(), SessionState::NeedsSecret))])
    );
    assert_eq!(f.server.counters.handshakes.load(Ordering::SeqCst), 1);
    f.registry.shutdown().await;
}
#[tokio::test]
async fn refused_subsystem_and_exec_are_not_success() {
    let mut server = Server::new(1, "alice");
    server.refuse = true;
    let f = Fixture::new(server, vec![hop("c-a", "alice")], true);
    let (_, session) = f.connected().await;
    assert_eq!(
        session.exec("fixture").await,
        Err(SessionError::CapabilityUnavailable)
    );
    assert!(matches!(
        session.sftp().await,
        Err(SessionError::CapabilityUnavailable)
    ));
    f.registry.shutdown().await;
}
#[tokio::test]
async fn exec_requires_ack_exit_and_bounded_output() {
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
    let (_, session) = f.connected().await;
    assert_eq!(
        session.exec("no-exit").await,
        Err(SessionError::MissingExitStatus)
    );
    tokio::time::sleep(Duration::from_millis(30)).await;
    let closed_before = f.server.counters.closed_channels.load(Ordering::SeqCst);
    assert_eq!(
        session
            .exec_bounded("oversize", 1024, Duration::from_secs(2))
            .await,
        Err(SessionError::OutputTooLarge)
    );
    tokio::time::timeout(Duration::from_secs(1), async {
        while f.server.counters.closed_channels.load(Ordering::SeqCst) <= closed_before {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(session.exec("fixture").await.is_ok());
    f.registry.shutdown().await;
}
#[tokio::test]
async fn sftp_init_is_single_per_generation_and_refusal_is_not_success() {
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
    let (_, session) = f.connected().await;
    let (a, b) = tokio::join!(session.sftp(), session.sftp());
    a.unwrap();
    b.unwrap();
    assert_eq!(f.server.counters.subsystems.load(Ordering::SeqCst), 1);
    assert_eq!(f.server.counters.auth.load(Ordering::SeqCst), 1);
    f.registry.shutdown().await;
}
#[tokio::test]
async fn close_cancels_inflight_exec() {
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
    let (_, session) = f.connected().await;
    let task = tokio::spawn(async move { session.exec("hang").await });
    tokio::time::sleep(Duration::from_millis(30)).await;
    f.registry.close("tm-a", false, None).unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap(),
        Err(SessionError::Cancelled)
    );
    f.registry.shutdown().await;
}
#[tokio::test]
async fn cancel_one_exec_keeps_session_and_sftp() {
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
    let (_, session) = f.connected().await;
    let sftp = session.sftp().await.unwrap();
    let cancel = CancellationToken::new();
    let token = cancel.clone();
    let cloned = session.clone();
    let task = tokio::spawn(async move {
        cloned
            .exec_with(
                "hang",
                ExecOpts {
                    cancel: token,
                    ..Default::default()
                },
            )
            .await
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    cancel.cancel();
    assert_eq!(task.await.unwrap(), Err(SessionError::Cancelled));
    assert_eq!(
        f.registry.state("tm-a", false).unwrap().state,
        SessionState::Connected
    );
    assert!(session.exec("fixture").await.is_ok());
    sftp.request(|_| Box::pin(async { Ok(()) })).await.unwrap();
    assert!(f.server.counters.closed_channels.load(Ordering::SeqCst) > 0);
    f.registry.shutdown().await;
}
#[tokio::test]
async fn exec_deadline_returns_timedout_and_closes_channel() {
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
    let (_, session) = f.connected().await;
    assert_eq!(
        session
            .exec_with(
                "hang",
                ExecOpts {
                    deadline: Duration::from_millis(60),
                    ..Default::default()
                }
            )
            .await,
        Err(SessionError::TimedOut)
    );
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(f.server.counters.closed_channels.load(Ordering::SeqCst) > 0);
    assert!(session.exec("fixture").await.is_ok());
    f.registry.shutdown().await;
}
#[tokio::test]
async fn old_lease_fails_after_disconnect() {
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
    let (_, session) = f.connected().await;
    f.registry.disconnect("tm-a", "ended");
    assert_eq!(session.exec("fixture").await, Err(SessionError::Cancelled));
    assert!(matches!(
        f.registry.lease("tm-a"),
        Err(SessionError::NotConnected)
    ));
    f.registry.shutdown().await;
}
#[tokio::test]
async fn probe_connects_without_terminal_signal() {
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
    let id = f.registry.probe("c-a").unwrap();
    let v = wait_state(&f.registry, &id, true, SessionState::NeedsSecret).await;
    f.registry
        .submit_secret(
            &id,
            true,
            Some(v.generation),
            v.prompt_id.as_deref(),
            f.server.password.clone(),
            false,
        )
        .unwrap();
    let v = wait_state(&f.registry, &id, true, SessionState::Connected).await;
    assert!(v.terminal_id.is_none());
    assert_eq!(v.probe_id.as_deref(), Some(id.as_str()));
    assert!(f.registry.owner_map().is_empty());
    f.registry.shutdown().await;
}
#[tokio::test]
async fn password_bad_then_good_never_echoed() {
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
    let id = f.registry.probe("c-a").unwrap();
    let a = wait_state(&f.registry, &id, true, SessionState::NeedsSecret).await;
    f.registry
        .submit_secret(
            &id,
            true,
            Some(a.generation),
            a.prompt_id.as_deref(),
            "sentinel-bad-password".into(),
            true,
        )
        .unwrap();
    let b = wait_new_prompt(&f.registry, &id, true, &a).await;
    assert_eq!(f.secrets.saves.load(Ordering::SeqCst), 0);
    assert_eq!(
        f.registry.submit_secret(
            &id,
            true,
            Some(a.generation),
            a.prompt_id.as_deref(),
            f.server.password.clone(),
            true
        ),
        Err(SessionError::StaleAttempt)
    );
    f.registry
        .submit_secret(
            &id,
            true,
            Some(b.generation),
            b.prompt_id.as_deref(),
            f.server.password.clone(),
            true,
        )
        .unwrap();
    wait_state(&f.registry, &id, true, SessionState::Connected).await;
    assert_eq!(f.secrets.saves.load(Ordering::SeqCst), 1);
    let views = serde_json::to_string(&*f.events.0.lock()).unwrap();
    assert!(!views.contains("sentinel-bad-password"));
    assert!(!views.contains(&f.server.password));
    assert!(!views.is_empty());
    f.registry.shutdown().await;
}
async fn wait_new_prompt(
    registry: &SessionRegistry,
    id: &str,
    probe: bool,
    old: &SessionView,
) -> SessionView {
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let v = registry.state(id, probe).unwrap();
            if v.state == old.state && v.prompt_id != old.prompt_id && v.prompt_id.is_some() {
                return v;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap()
}
#[tokio::test]
async fn jump_and_target_use_distinct_credentials_and_pins() {
    let mut jump = Server::new(1, "bastion");
    let target = Server::new(2, "destination");
    let target_counts = target.counters.clone();
    jump.target = Some(Box::new(target));
    let mut jhop = hop("jump", "bastion");
    jhop.host = "jump.test".into();
    let f = Fixture::new(jump, vec![jhop, hop("c-a", "destination")], true);
    let id = f.registry.probe("c-a").unwrap();
    let a = wait_state(&f.registry, &id, true, SessionState::NeedsSecret).await;
    assert_eq!(a.prompt_target.as_ref().unwrap().hop, "jump");
    f.registry
        .submit_secret(
            &id,
            true,
            Some(a.generation),
            a.prompt_id.as_deref(),
            "password-bastion".into(),
            false,
        )
        .unwrap();
    let b = wait_new_prompt(&f.registry, &id, true, &a).await;
    assert_eq!(b.prompt_target.as_ref().unwrap().connection_id, "c-a");
    assert_eq!(b.generation, a.generation);
    assert_eq!(
        f.registry.submit_secret(
            &id,
            true,
            Some(a.generation),
            a.prompt_id.as_deref(),
            "password-bastion".into(),
            false
        ),
        Err(SessionError::StaleAttempt)
    );
    f.registry
        .submit_secret(
            &id,
            true,
            Some(b.generation),
            b.prompt_id.as_deref(),
            "password-destination".into(),
            false,
        )
        .unwrap();
    wait_state(&f.registry, &id, true, SessionState::Connected).await;
    assert_eq!(*f.server.counters.principals.lock(), vec!["bastion"]);
    assert_eq!(*target_counts.principals.lock(), vec!["destination"]);
    f.registry.shutdown().await;
}
#[tokio::test]
async fn unknown_host_cancel_blocks_launch_and_auth() {
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], false);
    let id = f.registry.probe("c-a").unwrap();
    let a = wait_state(&f.registry, &id, true, SessionState::NeedsHostkey).await;
    assert_eq!(a.gate, Gate::Blocked);
    assert_eq!(f.server.counters.auth.load(Ordering::SeqCst), 0);
    f.registry
        .trust_host(&id, true, Some(a.generation), a.prompt_id.as_deref(), false)
        .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_ne!(f.registry.state(&id, true).unwrap().gate, Gate::Verified);
    assert!(!f.path.exists());
    f.registry.shutdown().await;
}
#[tokio::test]
async fn trust_then_auth_releases_exact_path_receipt() {
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], false);
    let id = f.registry.probe("c-a").unwrap();
    let a = wait_state(&f.registry, &id, true, SessionState::NeedsHostkey).await;
    f.registry
        .trust_host(&id, true, Some(a.generation), a.prompt_id.as_deref(), true)
        .unwrap();
    let b = wait_state(&f.registry, &id, true, SessionState::NeedsSecret).await;
    assert_eq!(b.gate, Gate::Verified);
    assert_eq!(
        b.known_hosts_paths.unwrap().target,
        f.path.to_string_lossy()
    );
    f.registry
        .submit_secret(&id, true, None, None, f.server.password.clone(), false)
        .unwrap();
    wait_state(&f.registry, &id, true, SessionState::Connected).await;
    f.registry.shutdown().await;
}
