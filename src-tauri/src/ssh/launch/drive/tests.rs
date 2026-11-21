use super::*;
use crate::{
    commands::ssh_session::{open_core, reconnect_core},
    pty_manager::{input_gate::{InputPermit, LocalWriter}, ssh_shell::PromptProof},
    ssh::{
        auth::BoxFuture,
        known_hosts::{lookup_token, sync_probe, KnownHosts},
        launch::{LaunchAttemptRef, Operation},
        session::{BoxStream, Dependencies, NativeAgent, SessionError, SessionHop, SessionState, SessionView, StreamFactory},
        store::{Auth, Connection},
        store_adapter::StoreAdapter,
        tests::{key, wait_state, Capture, MemoryStreams, Server},
    },
    state::{Completion, PageRegistration, PaneReply, PaneRequest, PaneResult, ShellStage, StagedShell},
};
use parking_lot::{Condvar, Mutex};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use termflow_pty_protocol::da1::StartupDrain;

mod certificate_only;
#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
mod lifecycle;

const LEAF: &str = "tm-launch";
const PROCESS: &str = "pc-launch";
const CONNECTION: &str = "c-launch";
const JUMP: &str = "c-jump";
const NONCE: &str = "0123456789abcdef0123456789abcdef";
const SOURCE: &str = "source";
const TARGET: &str = "target";

#[derive(Default)]
struct Recorded {
    bytes: Mutex<Vec<u8>>,
    calls: Mutex<usize>,
    partial: AtomicBool,
    before_partial_error: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}
struct Recorder(Arc<Recorded>);
impl Write for Recorder {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let mut calls = self.0.calls.lock();
        *calls += 1;
        if self.0.partial.load(Ordering::SeqCst) {
            if *calls > 1 {
                if let Some(hook) = self.0.before_partial_error.lock().take() { hook(); }
                return Err(std::io::Error::other("injected write failure"));
            }
            self.0.bytes.lock().extend_from_slice(&bytes[..3]);
            return Ok(3);
        }
        self.0.bytes.lock().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
}

struct Port {
    keys: HostKeys,
    home: PathBuf,
    writer: LocalWriter,
    record: Arc<Recorded>,
    events: Mutex<Vec<Value>>,
    bare: AtomicBool,
    native_bare: bool,
    // T10: an outer recording executable in place of the native ssh path.
    ssh: Option<String>,
    before_encode: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    host: Option<crate::pty_host_client::PtyHostClient>,
    at_emit: Option<Arc<SessionRegistry>>,
    ingressed: Mutex<Vec<Option<LaunchState>>>,
}
impl InputBackend for Port {
    fn input_keys(&self) -> &HostKeys { &self.keys }
    fn local_writer(&self, process: &str) -> Option<LocalWriter> {
        (process == PROCESS).then(|| self.writer.clone())
    }
    fn hosted(&self, _: &str) -> bool { self.host.is_some() }
    fn enqueue_hosted(&self, permit: &InputPermit<'_>, bytes: &[u8]) -> bool {
        // Like AppState: a process with no host route is not enqueued, so
        // write_input falls through to its local writer.
        self.host.as_ref().is_some_and(|host| host.write_registered_admitted(
            &self.keys, permit, crate::elevated_host::HostChannel::Primary, PROCESS, bytes,
        ))
    }
}
impl LaunchPort for Port {
    fn helper_root(&self) -> Result<HelperRoot, LaunchError> {
        HelperRoot::open_app_data(&self.home).map_err(|_| Code::UnsupportedContext.into())
    }
    fn open_ssh(&self) -> Result<String, LaunchError> { self.ssh.clone().map_or_else(native_ssh, Ok) }
    fn bare_shell(&self, shell: &str, identity: &ProcessIdentity) -> bool {
        if let Some(hook) = self.before_encode.lock().take() { hook(); }
        self.bare.load(Ordering::SeqCst) && (!self.native_bare || native_bare_shell(shell, identity))
    }
    fn launch_state(&self, terminal: &str, state: &'static str) {
        if let Some(sessions) = &self.at_emit {
            self.ingressed.lock().push(sessions.current_launch(terminal).and_then(|v| v.state));
        }
        self.events.lock().push(serde_json::to_value(LaunchEvent { terminal_id: terminal, state }).unwrap());
    }

}
impl Drop for Port {
    fn drop(&mut self) { let _ = crate::pty_manager::ssh_helpers::remove_test_tree(&self.home); }
}

struct Unreachable;
impl StreamFactory for Unreachable {
    fn connect<'a>(&'a self, _: &'a SessionHop) -> BoxFuture<'a, Result<BoxStream, SessionError>> {
        Box::pin(async { Err(SessionError::TransportClosed) })
    }
}

struct Fixture {
    port: Arc<Port>,
    sessions: Arc<SessionRegistry>,
    launches: Arc<LaunchRegistry>,
    session_events: Arc<Capture>,
    store: Store,
    trust_path: PathBuf,
    owner: PaneIdentity,
    server: Server,
}

fn connection(id: &str, host: &str, user: &str, jump: Option<&str>) -> Connection {
    Connection {
        id: id.into(), folder_id: None, name: id.into(), host: host.into(), port: 22,
        user: user.into(), auth: Auth::Password, identity_file: None, jump_connection_id: jump.map(str::to_owned),
        extra_options: vec![], bookmarked: false, order: 0, last_used_at: None, secret: None,
    }
}
fn pane(pi: PaneIdentity) -> Value { json!({"pi": pi, "paneId": "pn-launch", "leaf": LEAF, "restore": false}) }
fn pin(host: &str, server: &Server) -> String {
    format!("{} {}\n", lookup_token(host, 22), server.host.public_key().to_openssh().unwrap())
}
impl Fixture {
    fn new(server: Server, unreachable: bool) -> Self {
        let streams: Arc<dyn StreamFactory> = if unreachable {
            Arc::new(Unreachable)
        } else {
            Arc::new(MemoryStreams(server.clone()))
        };
        Self::with_streams(server, streams)
    }

    fn with_streams(server: Server, streams: Arc<dyn StreamFactory>) -> Self {
        let f = Self::unplaced(server, streams);
        f.place();
        f
    }

    fn unplaced(server: Server, streams: Arc<dyn StreamFactory>) -> Self {
        let home = std::env::temp_dir().join(format!("tf-launch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&home).unwrap();
        // macOS temp paths can start at a symlink (e.g. /var -> /private/var).
        #[cfg(unix)]
        let home = std::fs::canonicalize(home).unwrap();
        let trust_path = home.join("known_hosts");
        let store = Store::new(home.join("connections.json"));
        let jump = server.target.is_some();
        store.transact(|data| {
            data.connections.push(connection(CONNECTION, "target.test", if jump { "destination" } else { &server.user }, jump.then_some(JUMP)));
            if jump { data.connections.push(connection(JUMP, "jump.test", &server.user, None)); }
            Ok(())
        }, |_| {}).unwrap();
        let adapter = Arc::new(StoreAdapter::new(store.clone(), home.clone(), Arc::new(|_| {})));
        let session_events = Arc::new(Capture::default());
        let sessions = Arc::new(SessionRegistry::new(Dependencies {
            targets: adapter.clone(), streams, agents: Arc::new(NativeAgent), secrets: adapter,
            events: session_events.clone(), known_hosts: KnownHosts { path: trust_path.clone() }, home: home.clone(),
        }));
        let record = Arc::new(Recorded::default());
        let writer: LocalWriter = Arc::new(std::sync::Mutex::new(Box::new(Recorder(record.clone()))));
        let port = Arc::new(Port {
            keys: HostKeys::default(), home, writer, record, events: Mutex::default(),
            bare: AtomicBool::new(true), native_bare: false, ssh: None, before_encode: Mutex::default(),
            host: None, at_emit: Some(sessions.clone()), ingressed: Mutex::default(),
        });
        let owner = Self::page(&port.keys, SOURCE);
        Self { port, sessions, launches: Arc::default(), session_events, store, trust_path, owner, server }
    }

    fn stage(&self) -> (u64, StagedShell) {
        let owner = self.owner;
        assert_eq!(self.op(SOURCE, owner, 1, json!({"kind":"enter","panes":[pane(owner)]})), PaneResult::Ok);
        let PaneResult::Create { cg } = self.op(SOURCE, owner, 2, json!({"kind":"admit_create","pi":owner,"mode":"Mount"})) else { panic!("fresh process") };
        self.keys().admitted_work(SOURCE, owner.pg, LEAF, cg).unwrap();
        let route = self.port.host.as_ref().map(|_| (crate::elevated_host::HostChannel::Primary, PROCESS, crate::state::StageMode::Spawn));
        let (host, _, _) = self.keys().stage_shell(LEAF, cg, PROCESS, route).unwrap();
        self.keys().register_tagged_ssh_prompt(PROCESS, cg, NONCE, Some(CONNECTION)).unwrap();
        if let Some(host) = &host { assert!(self.keys().publish(host, PROCESS, 1)); }
        (cg, StagedShell { process: PROCESS.into(), stage: host.map_or(ShellStage::Local, ShellStage::Hosted) })
    }

    fn complete(&self, cg: u64, staged: &StagedShell, shell: String, identity: ProcessIdentity) {
        self.keys().bind_ssh_shell(PROCESS, shell, identity);
        assert!(matches!(self.keys().complete_shell(LEAF, cg, staged), Completion::Registered));
    }

    fn place(&self) -> (u64, StagedShell) {
        let (cg, staged) = self.stage();
        #[cfg(windows)]
        let shell = crate::pty_manager::ssh_shell::system_shell("powershell.exe").unwrap();
        #[cfg(not(windows))]
        let shell = "/bin/bash".to_owned();
        self.complete(cg, &staged, shell, ProcessIdentity { pid: 10, start_time: 1 });
        (cg, staged)
    }
    fn direct() -> Self { Self::new(Server::new(1, "alice"), false) }
    fn jump() -> Self {
        let mut server = Server::new(1, "bastion");
        server.target = Some(Box::new(Server::new(2, "destination")));
        Self::new(server, false)
    }
    fn keys(&self) -> &HostKeys { &self.port.keys }
    fn page(keys: &HostKeys, window: &str) -> PaneIdentity {
        keys.reserve_window(window).unwrap().commit().unwrap();
        let PageRegistration::Registered { pg, .. } = keys.register_page(window).unwrap() else { panic!("page") };
        PaneIdentity { pg, seq: 1 }
    }
    fn op(&self, window: &str, pi: PaneIdentity, seq: u64, op: Value) -> PaneResult {
        let req: PaneRequest = serde_json::from_value(json!({"pg":pi.pg,"seq":seq,"op":op})).unwrap();
        let (reply, effects) = self.keys().pane_op(window, req).unwrap();
        for (leaf, receipt) in effects.ssh_retired { self.sessions.retire_owner(&leaf, receipt); }
        let PaneReply::Ack { result } = reply else { panic!("ack") };
        result
    }
    fn open(&self) -> LaunchAttemptRef {
        self.reference(&open_core(self.keys(), &self.sessions, LEAF, CONNECTION).unwrap())
    }
    fn reference(&self, view: &SessionView) -> LaunchAttemptRef {
        LaunchAttemptRef { session_generation: view.generation, attempt_receipt: view.into(), process_incarnation: PROCESS.into(), owner_incarnation: self.owner }
    }
    fn access(&self, attempt: &LaunchAttemptRef, op: Operation<'_>) -> Result<LaunchSnapshot, LaunchError> {
        self.launches.access(self.keys(), &self.sessions, SOURCE, LEAF, attempt.clone(), op)
    }
    fn register(&self, attempt: &LaunchAttemptRef) -> LaunchSnapshot {
        self.access(attempt, Operation::Launch(CONNECTION)).unwrap()
    }
    fn driver(&self, attempt: &LaunchAttemptRef) -> Driver<'_, Port> {
        Driver { registry: &self.launches, sessions: &self.sessions, store: &self.store, port: &self.port, terminal: LEAF, generation: attempt.session_generation, home: &self.port.home }
    }
    fn tick(&self, attempt: &LaunchAttemptRef) -> bool { self.driver(attempt).tick(Instant::now()) }
    fn ready(&self, sequence: u64) {
        let drain = StartupDrain::default();
        let input_generation = self.keys().ssh_prompt_input_generation(PROCESS).unwrap();
        self.keys().observe_shell_prompt(PROCESS, NONCE, sequence, PromptProof::Local { drain: &drain, input_generation }).unwrap();
    }
    fn seed(&self, contents: &str) { std::fs::write(&self.trust_path, contents).unwrap(); }
    fn zero(&self) {
        assert!(self.port.record.bytes.lock().is_empty());
        assert_eq!(*self.port.record.calls.lock(), 0);
        assert!(self.port.events.lock().is_empty());
    }
    fn typed_bytes(&self) -> Vec<u8> {
        let attempts = self.launches.0.lock();
        let entry = &attempts[LEAF];
        assert_eq!(entry.snapshot.stage, LaunchStage::Typed);
        let payload = entry.payload.as_ref().unwrap();
        assert_eq!(payload.encoded.bytes().last(), Some(&b'\r'));
        assert!(payload.encoded.argv().iter().any(|arg| arg == "StrictHostKeyChecking=yes"));
        assert!(payload.encoded.argv().iter().any(|arg| arg.starts_with("UserKnownHostsFile=") && arg.contains("known_hosts")));
        assert_eq!(self.sessions.current_launch(LEAF).unwrap().state, Some(LaunchState::Typed));
        payload.encoded.bytes().to_vec()
    }
    async fn phase(&self, phase: SessionState) -> SessionView { wait_state(&self.sessions, LEAF, false, phase).await }
    async fn gate(&self, gate: Gate) -> SessionView {
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                let view = self.sessions.state(LEAF, false).unwrap();
                if view.gate == gate { return view; }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        }).await.expect("engine gate deadline")
    }
    fn trust(&self, view: &SessionView, accept: bool) -> Result<(), SessionError> {
        self.sessions.trust_host(LEAF, false, Some(view.generation), view.prompt_id.as_deref(), accept)
    }
    fn secret(&self, view: &SessionView, pass: &str, remember: bool) -> Result<(), SessionError> {
        self.sessions.submit_secret(LEAF, false, Some(view.generation), view.prompt_id.as_deref(), pass.into(), remember)
    }
    async fn shutdown(&self) { self.sessions.shutdown().await; }
}

#[tokio::test]
async fn pending_gate_and_needs_hostkey_emit_zero_terminal_bytes() {
    for late_registration in [false, true] {
        let f = Fixture::direct();
        let mut attempt = f.open();
        // Renderer forgeries cannot become a verifier receipt.
        attempt.attempt_receipt.gate = Gate::Verified;
        attempt.attempt_receipt.known_hosts_paths = Some(super::super::KnownHostsPaths { target: "forged".into(), jump: None });
        if !late_registration {
            assert_eq!(f.register(&attempt).attempt.attempt_receipt.gate, Gate::Pending);
            f.ready(1);
            assert!(f.tick(&attempt));
            f.zero();
        }
        let prompt = f.phase(SessionState::NeedsHostkey).await;
        assert_eq!(prompt.gate, Gate::Blocked);
        if late_registration {
            assert_eq!(f.register(&attempt).stage, LaunchStage::WaitingTrust);
            assert!(f.tick(&attempt));
            f.zero();
            f.ready(1);
        }
        assert!(f.tick(&attempt));
        assert_eq!(f.access(&attempt, Operation::Query).unwrap().stage, LaunchStage::WaitingTrust);
        f.zero();
        f.trust(&prompt, true).unwrap();
        f.phase(SessionState::NeedsSecret).await;
        assert!(!f.tick(&attempt));
        assert_eq!(*f.port.record.bytes.lock(), f.typed_bytes());
        f.shutdown().await;
    }
}

#[tokio::test]
async fn jump_password_prompt_keeps_zero_bytes_until_target_verified() {
    let f = Fixture::jump();
    f.seed(&pin("jump.test", &f.server));
    let a = f.open();
    f.register(&a);
    f.ready(1);
    let jump = f.phase(SessionState::NeedsSecret).await;
    assert_eq!(jump.prompt_target.as_ref().unwrap().hop, "jump");
    assert_eq!(jump.gate, Gate::Pending);
    assert!(f.tick(&a));
    f.zero();
    // Remember commits to the store before verification of the target. This is
    // not a definition edit and must not break this generation's receipt.
    f.secret(&jump, &f.server.password, true).unwrap();
    let target = f.phase(SessionState::NeedsHostkey).await;
    assert_eq!(target.prompt_target.as_ref().unwrap().hop, "target");
    assert!(f.tick(&a));
    f.zero();
    f.trust(&target, true).unwrap();
    f.phase(SessionState::NeedsSecret).await;
    assert!(!f.tick(&a));
    assert!(!f.tick(&a));
    assert_eq!(*f.port.record.bytes.lock(), f.typed_bytes());
    assert_eq!(f.port.events.lock().as_slice(), &[json!({"terminalId":LEAF,"state":"typed"})]);
    f.shutdown().await;
}

struct SyncHold {
    entered: Arc<tokio::sync::Notify>,
    synced: Arc<tokio::sync::Notify>,
    release: Arc<(Mutex<bool>, Condvar)>,
    _guard: sync_probe::Guard,
}
impl SyncHold {
    fn new(path: &Path) -> Self {
        let entered = Arc::new(tokio::sync::Notify::new());
        let synced = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new((Mutex::new(false), Condvar::new()));
        let (a, b, lock) = (entered.clone(), synced.clone(), release.clone());
        let guard = sync_probe::at(path, move |synced| {
            if synced { b.notify_one(); return; }
            a.notify_one();
            let (mutex, cv) = &*lock;
            let mut ready = mutex.lock();
            while !*ready { cv.wait(&mut ready); }
        });
        Self { entered, synced, release, _guard: guard }
    }
    fn release(&self) {
        *self.release.0.lock() = true;
        self.release.1.notify_all();
    }
    async fn wait(notify: &tokio::sync::Notify) {
        tokio::time::timeout(Duration::from_secs(8), notify.notified()).await.unwrap();
    }
}
impl Drop for SyncHold { fn drop(&mut self) { self.release(); } }

#[tokio::test]
async fn trust_fsync_precedes_terminal_submit() {
    let f = Fixture::direct();
    let a = f.open();
    f.register(&a);
    f.ready(1);
    let prompt = f.phase(SessionState::NeedsHostkey).await;
    let hold = SyncHold::new(&f.trust_path);
    f.trust(&prompt, true).unwrap();
    SyncHold::wait(&hold.entered).await;
    // The prompt already cleared and bytes are visible, but trust has not fsynced.
    let writing_trust = f.sessions.state(LEAF, false).unwrap();
    assert_eq!((writing_trust.state, writing_trust.gate), (SessionState::Connecting, Gate::Blocked));
    assert_eq!(std::fs::read_to_string(&f.trust_path).unwrap(), pin("target.test", &f.server));
    assert!(f.tick(&a));
    assert_eq!(f.access(&a, Operation::Query).unwrap().stage, LaunchStage::WaitingTrust);
    f.zero();
    hold.release();
    SyncHold::wait(&hold.synced).await;
    f.gate(Gate::Verified).await;
    assert!(!f.tick(&a));
    assert_eq!(*f.port.record.bytes.lock(), f.typed_bytes());
    f.shutdown().await;
}

#[tokio::test]
async fn blocked_cancel_changed_key_type_certificate_revoked_and_policy_error_never_type() {
    use ssh_key::{certificate::{Builder, CertType}, public::{KeyData, RsaPublicKey}, Mpint, PublicKey};
    let other_type = PublicKey::new(KeyData::Rsa(RsaPublicKey::new(
        Mpint::from_positive_bytes(&[1, 0, 1]), Mpint::from_positive_bytes(&[0x9b; 256]),
    ).unwrap()), "fixture");
    for error in [SessionError::HostKeyChanged, SessionError::HostCertificateUnsupported,
        SessionError::HostKeyRevoked, SessionError::KnownHostsMalformed { line: 1 }, SessionError::Cancelled] {
        let f = Fixture::direct();
        match error {
            SessionError::HostKeyChanged => f.seed(&format!("target.test {}\n", other_type.to_openssh().unwrap())),
            SessionError::HostKeyRevoked => f.seed(&format!("@revoked {}", pin("target.test", &f.server))),
            SessionError::KnownHostsMalformed { .. } => f.seed("target.test ssh-ed25519 !!!\n"),
            SessionError::HostCertificateUnsupported => f.seed(&format!("@cert-authority {}", pin("target.test", &f.server))),
            _ => {}
        }
        let a = f.open();
        f.register(&a);
        f.ready(1);
        if error == SessionError::Cancelled {
            f.trust(&f.phase(SessionState::NeedsHostkey).await, false).unwrap();
        }
        // The prompt and its in-flight decision are also Blocked; await a
        // terminal state before asserting the final classification.
        let state = if error == SessionError::Cancelled { SessionState::Disconnected } else { SessionState::Error };
        let view = f.phase(state).await;
        assert_eq!(view.gate, Gate::Blocked);
        assert_eq!(view.reason.as_deref(), Some(error.reason().as_str()));
        assert!(!f.tick(&a));
        let blocked = f.access(&a, Operation::Query).unwrap();
        assert_eq!((blocked.stage, blocked.error.unwrap().code), (LaunchStage::Blocked, Code::TrustBlocked));
        f.zero();
        f.shutdown().await;
    }

    let mut server = Server::new(1, "alice");
    let mut cert = Builder::new(vec![1; 16], server.host.public_key().clone(), 1, 4_000_000_000).unwrap();
    cert.cert_type(CertType::Host).unwrap().key_id("fixture").unwrap().valid_principal("target.test").unwrap();
    server.host_certificate = Some(cert.sign(&key(5)).unwrap());

    // Regression control: do not change the stock 067 client to seek a
    // certificate when the peer also offers the plain key already pinned.
    let dual = Fixture::new(server.clone(), false);
    dual.seed(&pin("target.test", &dual.server));
    let a = dual.open();
    dual.register(&a);
    dual.ready(1);
    assert_eq!(dual.phase(SessionState::NeedsSecret).await.gate, Gate::Verified);
    assert!(!dual.tick(&a));
    assert_eq!(*dual.port.record.bytes.lock(), dual.typed_bytes());
    dual.shutdown().await;

    let advertised = Arc::new(AtomicBool::new(false));
    let streams = Arc::new(certificate_only::CertificateOnly { server: server.clone(), advertised: advertised.clone() });
    let only = Fixture::with_streams(server, streams);
    only.seed(&pin("target.test", &only.server));
    let a = only.open();
    only.register(&a);
    only.ready(1);
    let view = only.gate(Gate::Blocked).await;
    assert!(advertised.load(Ordering::SeqCst), "peer must actually offer the certificate-only KEXINIT");
    assert!(matches!(view.state, SessionState::Error | SessionState::Disconnected));
    assert!(view.prompt_id.is_none());
    assert!(!only.tick(&a));
    let blocked = only.access(&a, Operation::Query).unwrap();
    assert_eq!((blocked.stage, blocked.error.unwrap().code), (LaunchStage::Blocked, Code::TrustBlocked));
    assert_eq!(only.server.counters.auth.load(Ordering::SeqCst), 0);
    only.zero();
    only.shutdown().await;
}

#[tokio::test]
async fn verified_and_typed_network_error_require_ready_and_current_receipt() {
    for (unreachable, gate) in [(false, Gate::Verified), (true, Gate::NetworkError)] {
        let f = Fixture::new(Server::new(1, "alice"), unreachable);
        f.seed(&pin("target.test", &f.server));
        let stale = f.open();
        f.register(&stale);
        f.gate(gate).await;
        let a = f.reference(&reconnect_core(f.keys(), &f.sessions, LEAF).unwrap());
        f.register(&a);
        let view = f.gate(gate).await;
        assert_eq!(view.known_hosts_paths.unwrap().target, f.trust_path.to_str().unwrap());
        assert!(f.tick(&a));
        assert_eq!(f.access(&a, Operation::Query).unwrap().stage, LaunchStage::WaitingReady);
        f.ready(1);
        f.port.bare.store(false, Ordering::SeqCst);
        assert!(f.tick(&a));
        assert!(!f.tick(&stale));
        f.zero();
        f.port.bare.store(true, Ordering::SeqCst);
        assert!(!f.tick(&a));
        assert_eq!(*f.port.record.bytes.lock(), f.typed_bytes());
        f.shutdown().await;
    }
}

async fn retry_unsubmitted(path: &str) {
    let f = Fixture::direct();
    if path != "trust" && path != "cancel" { f.seed(&pin("target.test", &f.server)); }
    let a = f.open();
    f.register(&a);
    if path != "late timeout" { f.ready(1); }
    let next = match path {
        "cancel" => {
            f.phase(SessionState::NeedsHostkey).await;
            assert_eq!(f.access(&a, Operation::Cancel).unwrap().stage, LaunchStage::Cancelled);
            f.seed(&pin("target.test", &f.server));
            None
        }
        "trust" => {
            f.trust(&f.phase(SessionState::NeedsHostkey).await, false).unwrap();
            f.phase(SessionState::Disconnected).await;
            assert!(!f.tick(&a));
            assert_eq!(f.access(&a, Operation::Query).unwrap().error.unwrap().code, Code::TrustBlocked);
            f.seed(&pin("target.test", &f.server));
            None
        }
        "timeout" | "late timeout" => {
            f.gate(Gate::Verified).await;
            f.port.bare.store(false, Ordering::SeqCst);
            let start = Instant::now();
            assert!(f.driver(&a).tick(start));
            assert!(!f.driver(&a).tick(start + READY_TIMEOUT));
            assert_eq!(f.access(&a, Operation::Query).unwrap().error.unwrap().code, Code::Timeout);
            if path == "late timeout" { f.ready(1); }
            assert!(!f.tick(&a));
            f.port.bare.store(true, Ordering::SeqCst);
            None
        }
        "blocked replacement" => {
            f.seed("target.test ssh-ed25519 !!!\n");
            let blocked = f.reference(&reconnect_core(f.keys(), &f.sessions, LEAF).unwrap());
            f.phase(SessionState::Error).await;
            assert!(f.launches.0.lock()[LEAF].ticket.is_some());
            assert_eq!(f.register(&blocked).error.unwrap().code, Code::TrustBlocked);
            assert!(f.launches.0.lock()[LEAF].ticket.is_none());
            f.seed(&pin("target.test", &f.server));
            None
        }
        "stale" | "replacement" => {
            let next = f.reference(&reconnect_core(f.keys(), &f.sessions, LEAF).unwrap());
            if path == "stale" {
                assert!(!f.tick(&a));
                let entries = f.launches.0.lock();
                assert_eq!(entries[LEAF].snapshot.error.as_ref().unwrap().code, Code::StaleAttempt);
                assert!(entries[LEAF].ticket.is_none());
            } else {
                assert!(f.launches.0.lock()[LEAF].ticket.is_some());
            }
            Some(next)
        }
        _ => unreachable!(),
    };
    let next = next.unwrap_or_else(|| f.reference(&reconnect_core(f.keys(), &f.sessions, LEAF).unwrap()));
    f.register(&next);
    f.gate(Gate::Verified).await;
    f.zero();
    assert!(!f.tick(&next), "{path}: retry must type without a second prompt");
    assert_eq!(*f.port.record.bytes.lock(), f.typed_bytes());
    assert_eq!(*f.port.record.calls.lock(), 1);
    f.shutdown().await;
}

#[tokio::test]
async fn retry_after_user_cancel() { retry_unsubmitted("cancel").await; }
#[tokio::test]
async fn retry_after_trust_blocked() { retry_unsubmitted("trust").await; }
#[tokio::test]
async fn retry_after_ready_timeout() { retry_unsubmitted("timeout").await; }
#[tokio::test]
async fn retry_after_late_prompt() { retry_unsubmitted("late timeout").await; }
#[tokio::test]
async fn retry_after_stale_driver_end() { retry_unsubmitted("stale").await; }
#[tokio::test]
async fn retry_after_replacement() { retry_unsubmitted("replacement").await; }
#[tokio::test]
async fn retry_after_blocked_replacement() { retry_unsubmitted("blocked replacement").await; }

#[tokio::test]
async fn retry_after_submitted_cancel() { retry_after_submission("cancel").await; }
#[tokio::test]
async fn retry_after_submitted_replacement() { retry_after_submission("replacement").await; }
#[tokio::test]
async fn retry_after_partial_write() { retry_after_submission("partial").await; }

async fn retry_after_submission(path: &str) {
    let f = Fixture::direct();
    f.seed(&pin("target.test", &f.server));
    f.port.record.partial.store(path == "partial", Ordering::SeqCst);
    if path == "partial" {
        let port = Arc::downgrade(&f.port);
        *f.port.record.before_partial_error.lock() = Some(Box::new(move || {
            // Model a prompt arriving during local I/O, before the driver ends the attempt.
            let port = port.upgrade().unwrap();
            let input_generation = port.keys.ssh_prompt_input_generation(PROCESS).unwrap();
            port.keys.observe_shell_prompt(PROCESS, NONCE, 2, PromptProof::Local {
                drain: &StartupDrain::default(), input_generation,
            }).unwrap();
        }));
    }
    let a = f.open();
    f.register(&a);
    f.ready(1);
    f.gate(Gate::Verified).await;
    assert!(!f.tick(&a));
    if path == "cancel" {
        // Even a prompt observed between submission and cancellation is discarded.
        f.ready(2);
        assert_eq!(f.access(&a, Operation::Cancel).unwrap().stage, LaunchStage::Cancelled);
    } else if path == "partial" {
        assert_eq!(f.register(&a).error.unwrap().code, Code::WriteFailed);
        f.port.record.partial.store(false, Ordering::SeqCst);
    }
    let bytes = f.port.record.bytes.lock().clone();
    let calls = *f.port.record.calls.lock();
    assert!(!bytes.is_empty());
    let next = f.reference(&reconnect_core(f.keys(), &f.sessions, LEAF).unwrap());
    f.register(&next);
    f.gate(Gate::Verified).await;
    assert!(f.tick(&next), "{path}: must wait for a fresh prompt after submission");
    assert_eq!(*f.port.record.bytes.lock(), bytes);
    assert_eq!(*f.port.record.calls.lock(), calls);
    f.ready(3);
    assert!(!f.tick(&next));
    assert_eq!(*f.port.record.bytes.lock(), [bytes, f.typed_bytes()].concat());
    assert_eq!(*f.port.record.calls.lock(), calls + 1);
    f.shutdown().await;
}

#[tokio::test]
async fn startup_question_that_never_reaches_a_prompt_times_out_and_a_late_prompt_types_nothing() {
    // A startup file that stops on a question (zsh compinit's "insecure
    // directories ... [y]/[n]?") never reaches a prompt. The gate must fail
    // with Timeout, never wait on it, and an answer after that must not type.
    let f = Fixture::direct();
    f.seed(&pin("target.test", &f.server));
    let a = f.open();
    f.register(&a);
    f.gate(Gate::Verified).await;
    let start = Instant::now();
    let driver = f.driver(&a);
    assert!(driver.tick(start));
    assert_eq!(f.access(&a, Operation::Query).unwrap().stage, LaunchStage::WaitingReady);
    assert!(driver.tick(start + READY_TIMEOUT - Duration::from_millis(1)), "still inside the readiness window");
    assert!(!driver.tick(start + READY_TIMEOUT));
    let failed = f.access(&a, Operation::Query).unwrap();
    assert_eq!((failed.stage, failed.error.unwrap().code), (LaunchStage::Error, Code::Timeout));
    f.ready(1);
    assert!(!f.tick(&a));
    assert_eq!(f.access(&a, Operation::Query).unwrap().stage, LaunchStage::Error);
    f.zero();
    f.shutdown().await;
}

#[tokio::test]
async fn stale_ready_or_connection_edit_requires_new_verification() {
    for edit in [false, true] {
        let f = Fixture::direct();
        f.seed(&pin("target.test", &f.server));
        let a = f.open();
        f.register(&a);
        f.ready(1);
        f.phase(SessionState::NeedsSecret).await;
        let (port, store) = (f.port.clone(), f.store.clone());
        *f.port.before_encode.lock() = Some(Box::new(move || {
            if edit {
                // Edit and revert: equal argv does not redeem a stale revision.
                for port in [2222, 22] {
                    store.transact(|data| { data.connections[0].port = port; Ok(()) }, |_| {}).unwrap();
                }
            } else {
                port.keys.admit_protocol_input(PROCESS, |_| Ok::<_, crate::pty_manager::input_gate::Refusal>(InputDispatch::Complete(()))).unwrap();
            }
        }));
        assert!(!f.tick(&a));
        let error = f.access(&a, Operation::Query).unwrap();
        assert_eq!((error.stage, error.error.unwrap().code), (LaunchStage::Error, Code::StaleAttempt));
        f.zero();
        let next = f.reference(&reconnect_core(f.keys(), &f.sessions, LEAF).unwrap());
        f.register(&next);
        f.ready(2);
        f.phase(SessionState::NeedsSecret).await;
        assert!(!f.tick(&next));
        assert_eq!(*f.port.record.bytes.lock(), f.typed_bytes());
        f.shutdown().await;
    }
}

#[tokio::test]
async fn local_partial_write_is_not_retried_or_reported_typed() {
    let f = Fixture::direct();
    f.seed(&pin("target.test", &f.server));
    f.port.record.partial.store(true, Ordering::SeqCst);
    let a = f.open();
    f.register(&a);
    f.ready(1);
    f.phase(SessionState::NeedsSecret).await;
    assert!(!f.tick(&a));
    let error = f.register(&a);
    assert_eq!((error.stage, error.error.unwrap().code), (LaunchStage::Error, Code::WriteFailed));
    f.ready(2);
    assert!(!f.tick(&a));
    assert_eq!(*f.port.record.calls.lock(), 2, "write_all attempted completion, never replayed the command");
    {
        let attempts = f.launches.0.lock();
        let pending = attempts[LEAF].payload.as_ref().expect("uncertain execution retains helper pins");
        assert_eq!(f.port.record.bytes.lock().as_slice(), &pending.encoded.bytes()[..3]);
    }
    assert!(f.port.events.lock().is_empty());
    assert_eq!(f.sessions.current_launch(LEAF).unwrap().state, None);
    f.shutdown().await;
}

#[tokio::test]
async fn close_or_cancel_during_trust_cannot_resurrect_launch() {
    for close in [false, true] {
        let f = Fixture::direct();
        let a = f.open();
        f.register(&a);
        f.ready(1);
        let prompt = f.phase(SessionState::NeedsHostkey).await;
        let hold = SyncHold::new(&f.trust_path);
        f.trust(&prompt, true).unwrap();
        SyncHold::wait(&hold.entered).await;
        if close {
            assert_eq!(f.op(SOURCE, f.owner, 3, json!({"kind":"close","pi":f.owner})), PaneResult::Ok);
        } else {
            assert_eq!(f.access(&a, Operation::Cancel).unwrap().stage, LaunchStage::Cancelled);
        }
        hold.release();
        SyncHold::wait(&hold.synced).await;
        assert!(!f.tick(&a));
        f.zero();
        assert!(!f.session_events.0.lock().iter().any(|v| v.gate == Gate::Verified));
        if close { assert!(f.sessions.owner_map().is_empty()); }
        else { assert_eq!(f.access(&a, Operation::Query).unwrap().stage, LaunchStage::Cancelled); }
        f.shutdown().await;
    }
}

#[tokio::test]
async fn reconnect_retypes_once_and_reopens_channel_same_terminal_id() {
    let f = Fixture::direct();
    f.seed(&pin("target.test", &f.server));
    let a = f.open();
    let (mut bytes, mut previous) = (Vec::new(), 0);
    let mut attempt = a;
    for generation_index in 1..=2 {
        assert!(attempt.session_generation > previous);
        previous = attempt.session_generation;
        f.register(&attempt);
        let prompt = f.phase(SessionState::NeedsSecret).await;
        assert!(f.tick(&attempt));
        assert_eq!(*f.port.record.bytes.lock(), bytes);
        f.ready(generation_index);
        assert!(!f.tick(&attempt));
        bytes.extend(f.typed_bytes());
        assert!(!f.tick(&attempt));
        assert_eq!(*f.port.record.bytes.lock(), bytes);
        let snapshot = f.register(&attempt);
        assert_eq!(snapshot.terminal_id, LEAF);
        f.secret(&prompt, &f.server.password, false).unwrap();
        // T5 is not in this slice: provide the separate running signal only to
        // prove the re-opened 067 channel belongs to the fresh generation.
        f.sessions.on_launch_lifecycle(LEAF, attempt.session_generation, snapshot.launch_seq + 1, LaunchState::Running, Some(PROCESS.into())).unwrap();
        assert_eq!(f.phase(SessionState::Connected).await.generation, attempt.session_generation);
        if generation_index == 1 {
            attempt = f.reference(&reconnect_core(f.keys(), &f.sessions, LEAF).unwrap());
        }
    }
    assert_eq!(f.server.counters.handshakes.load(Ordering::SeqCst), 2);
    assert_eq!(f.server.counters.auth.load(Ordering::SeqCst), 2);
    assert_eq!(*f.port.record.calls.lock(), 2);
    assert_eq!(f.port.events.lock().as_slice(), &[json!({"terminalId":LEAF,"state":"typed"}), json!({"terminalId":LEAF,"state":"typed"})]);
    f.shutdown().await;
}

#[tokio::test]
async fn jump_to_target_prompt_keeps_current_prompt_id() {
    let f = Fixture::jump();
    let a = f.open();
    f.register(&a);
    f.ready(1);
    let jump_trust = f.phase(SessionState::NeedsHostkey).await;
    f.trust(&jump_trust, true).unwrap();
    let jump_secret = f.phase(SessionState::NeedsSecret).await;
    assert_eq!(jump_secret.gate, Gate::Blocked);
    assert!(f.tick(&a));
    assert_eq!(f.access(&a, Operation::Query).unwrap().stage, LaunchStage::WaitingTrust);
    f.zero();
    f.secret(&jump_secret, &f.server.password, false).unwrap();
    let target_trust = f.phase(SessionState::NeedsHostkey).await;
    assert_eq!(jump_trust.generation, target_trust.generation);
    assert_ne!(jump_trust.prompt_id, target_trust.prompt_id);
    assert_eq!(f.trust(&jump_trust, true), Err(SessionError::StaleAttempt));
    assert!(f.tick(&a));
    f.zero();
    f.trust(&target_trust, true).unwrap();
    let target_secret = f.phase(SessionState::NeedsSecret).await;
    assert_eq!(jump_secret.generation, target_secret.generation);
    assert_ne!(jump_secret.prompt_id, target_secret.prompt_id);
    assert_eq!(f.secret(&jump_secret, "password-destination", false), Err(SessionError::StaleAttempt));
    f.secret(&target_secret, "password-destination", false).unwrap();
    assert!(!f.tick(&a));
    assert_eq!(*f.port.record.bytes.lock(), f.typed_bytes());
    f.shutdown().await;
}

#[tokio::test]
async fn remembered_secret_never_appears_in_terminal_write_event_or_tag() {
    let secret = "unique-secret-that-must-not-leak";
    let mut server = Server::new(1, "alice");
    server.password = secret.into();
    let f = Fixture::new(server, false);
    f.seed(&pin("target.test", &f.server));
    let a = f.open();
    f.register(&a);
    let prompt = f.phase(SessionState::NeedsSecret).await;
    f.secret(&prompt, secret, true).unwrap();
    f.ready(1);
    assert!(!f.tick(&a));
    let snapshot = f.register(&a);
    f.sessions.on_launch_lifecycle(LEAF, a.session_generation, snapshot.launch_seq + 1, LaunchState::Running, Some(PROCESS.into())).unwrap();
    f.phase(SessionState::Connected).await;
    let saved = f.store.snapshot().unwrap().connections.remove(0).secret.unwrap();
    assert_ne!(saved, secret);
    let b = f.reference(&reconnect_core(f.keys(), &f.sessions, LEAF).unwrap());
    f.register(&b);
    f.gate(Gate::Verified).await;
    f.ready(2);
    assert!(!f.tick(&b));
    let next = f.register(&b);
    f.sessions.on_launch_lifecycle(LEAF, b.session_generation, next.launch_seq + 1, LaunchState::Running, Some(PROCESS.into())).unwrap();
    f.phase(SessionState::Connected).await;
    assert_eq!(f.server.counters.auth.load(Ordering::SeqCst), 2, "second attempt used Remember without a new prompt");
    assert_eq!(f.keys().ssh_launch_connection(PROCESS).as_deref(), Some(CONNECTION));
    let write = String::from_utf8(f.port.record.bytes.lock().clone()).unwrap();
    let output = json!({"launchEvents": *f.port.events.lock(), "sessionEvents": *f.session_events.0.lock(), "snapshot": next, "paneTagId": f.keys().ssh_launch_connection(PROCESS)}).to_string();
    let argv = serde_json::to_string(f.launches.0.lock()[LEAF].payload.as_ref().unwrap().encoded.argv()).unwrap();
    for redacted in [&write, &output, &argv] { assert!(!redacted.contains(secret) && !redacted.contains(&saved)); }
    f.shutdown().await;
}

#[tokio::test]
async fn exact_session_owner_map_matches_mounted_tagged_panes_after_move() {
    let f = Fixture::direct();
    f.seed(&pin("target.test", &f.server));
    let a = f.open();
    let original = f.register(&a);
    f.phase(SessionState::NeedsSecret).await;
    let owner_receipt = f.keys().ssh_owner_receipt(LEAF);
    assert_eq!(f.op(SOURCE, f.owner, 3, json!({"kind":"stash","tx":"move","pairs":[pane(f.owner)]})), PaneResult::Ok);
    let target = Fixture::page(f.keys(), TARGET);
    assert!(matches!(f.op(TARGET, target, 1, json!({"kind":"take","tx":"move"})), PaneResult::Taken { .. }));
    assert_eq!(f.op(TARGET, target, 2, json!({"kind":"adopt","tx":"move","pairs":[pane(target)]})), PaneResult::Ok);
    f.sessions.reconcile_owners(|id, receipt| f.keys().ssh_owner_receipt(id) == receipt);
    assert_eq!(f.sessions.owner_map(), [(LEAF.into(), (CONNECTION.into(), SessionState::NeedsSecret))].into());
    assert_eq!(f.keys().mounted_launch_owner(LEAF, PROCESS), owner_receipt.map(|cg| (target, cg)));
    assert_eq!(f.access(&a, Operation::Cancel), Err(Code::StaleAttempt.into()));
    f.ready(1);
    assert!(!f.tick(&a));
    let moved = LaunchAttemptRef { owner_incarnation: target, ..a };
    let snapshot = f.launches.access(f.keys(), &f.sessions, TARGET, LEAF, moved, Operation::Query).unwrap();
    assert_eq!(snapshot.attempt.session_generation, original.attempt.session_generation);
    assert_eq!(snapshot.attempt.owner_incarnation, target);
    assert_eq!(*f.port.record.bytes.lock(), f.typed_bytes());
    assert_eq!(f.op(TARGET, target, 3, json!({"kind":"close","pi":target})), PaneResult::Ok);
    assert!(f.sessions.owner_map().is_empty());
    f.shutdown().await;
}

#[test]
fn start_launch_worker_from_std_thread_without_runtime() {
    std::thread::spawn(|| {
        assert!(tokio::runtime::Handle::try_current().is_err());
        let f = Fixture::direct();
        f.seed(&pin("target.test", &f.server));
        let a = f.open();
        let snapshot = f.register(&a);
        f.ready(1);
        f.launches.start(f.port.clone(), f.sessions.clone(), f.store.clone(), f.port.home.clone(), &snapshot);
        f.launches.start(f.port.clone(), f.sessions.clone(), f.store.clone(), f.port.home.clone(), &snapshot);
        tauri::async_runtime::block_on(async {
            tokio::time::timeout(Duration::from_secs(8), async {
                while f.port.events.lock().is_empty() { tokio::time::sleep(Duration::from_millis(2)).await; }
            }).await.unwrap();
            assert_eq!(*f.port.record.bytes.lock(), f.typed_bytes());
            assert_eq!(f.port.events.lock().len(), 1);
            f.shutdown().await;
        });
    }).join().unwrap();
}
