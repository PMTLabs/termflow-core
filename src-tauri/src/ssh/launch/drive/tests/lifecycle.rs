//! Full launch driver + real 067 engine + real instrumented PTY and native
//! OpenSSH. Terminal TCP and app-channel transports are deliberately separate.
use super::*;
use crate::{
    elevated_host::HostChannel,
    pty_host_client::{wire_client, PtyHostClient, PtyHostDeps},
    pty_manager::{input_gate::{write_input, InputSource}, ssh_helpers::HelperKind, ssh_shell::posix},
    ssh::sessions,
    state::{CloseStorage, EndKind},
};
use portable_pty::{Child, CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use std::sync::atomic::AtomicU64;
use termflow_pty_protocol::{read_frame, write_frame, Data, Frame, SpawnSpec, ssh_prompt::PromptParser};
use tokio::{io::DuplexStream, net::{TcpListener, TcpStream}, sync::{broadcast, mpsc}};

const DEADLINE: Duration = Duration::from_secs(15);

struct NativeShell {
    child: Box<dyn Child + Send + Sync>,
    _master: Box<dyn MasterPty + Send>,
    writer: LocalWriter,
    output: mpsc::UnboundedReceiver<Vec<u8>>,
    drain: StartupDrain,
    parser: PromptParser,
    seen_prompt: u64,
    visible: Vec<u8>,
    adapter: Option<posix::PosixAdapter>,
}

fn instrument(f: &Fixture) -> posix::PosixAdapter {
    #[cfg(windows)]
    let (shell, args) = (crate::pty_manager::ssh_shell::system_shell("powershell.exe").unwrap(), vec!["-NoProfile".into(), "-NoLogo".into()]);
    #[cfg(not(windows))]
    let (shell, args) = ("/bin/bash".into(), vec!["-i".into()]);
    let home = f.port.home.to_str().unwrap().to_owned();
    let spec = SpawnSpec {
        shell, args, cwd: Some(home.clone()), cols: 100, rows: 30, initial_cursor_row: None,
        env: vec![("HOME".into(), home), ("TERM".into(), "xterm".into())],
        env_remove: ["BASH_ENV", "ENV", "PROMPT_COMMAND", "SHELLOPTS", "POSIXLY_CORRECT", "SSH_AUTH_SOCK", "SSH_ASKPASS"].map(str::to_owned).to_vec(),
    };
    posix::instrument_posix(&spec, NONCE, &f.port.helper_root().unwrap(), ProcessIdentity::capture(std::process::id()).unwrap(), |_| None).unwrap()
}

impl NativeShell {
    fn spawn(adapter: posix::PosixAdapter) -> Self {
        let spec = &adapter.spec;
        let pair = NativePtySystem::default().openpty(PtySize { cols: spec.cols, rows: spec.rows, pixel_width: 0, pixel_height: 0 }).unwrap();
        let mut cmd = CommandBuilder::new(&spec.shell);
        cmd.args(&spec.args);
        cmd.cwd(spec.cwd.as_ref().unwrap());
        for key in &spec.env_remove { cmd.env_remove(key); }
        for (key, value) in &spec.env { cmd.env(key, value); }
        let child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let writer = Arc::new(std::sync::Mutex::new(pair.master.take_writer().unwrap()));
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut replies = termflow_pty_protocol::da1::StartupReplies::new(writer.clone(), PROCESS.into());
        let drain = replies.drain();
        let (tx, output) = mpsc::unbounded_channel();
        std::thread::spawn(move || {
            let mut da1 = termflow_pty_protocol::da1::StartupDa1::for_spawn(None);
            termflow_pty_protocol::pump::pump_output(&mut reader, |bytes| bytes.len(), &mut da1,
                |reply| replies.send(reply), |bytes| { let _ = tx.send(bytes); });
        });
        Self { child, writer, output, drain, _master: pair.master, parser: PromptParser::new(NONCE.into()),
            seen_prompt: 0, visible: Vec::new(), adapter: Some(adapter) }
    }
    fn pid(&self) -> u32 { self.child.process_id().unwrap() }
    fn bind(&self, f: &Fixture, cg: u64, staged: &StagedShell) {
        f.complete(cg, staged, self.adapter.as_ref().unwrap().spec.shell.clone(), ProcessIdentity::capture(self.pid()).unwrap());
    }
    async fn prompt(&mut self, keys: &HostKeys, local: bool) -> u64 {
        let before = self.seen_prompt;
        tokio::time::timeout(DEADLINE, async {
            while self.seen_prompt == before {
                let bytes = self.output.recv().await.expect("fixture shell exited before its prompt");
                self.feed(keys, bytes, local);
            }
            self.seen_prompt
        }).await.expect("real shell prompt")
    }
    fn feed(&mut self, keys: &HostKeys, bytes: Vec<u8>, local: bool) {
        let stamp = self.drain.is_drained().then(|| keys.ssh_prompt_input_generation(PROCESS)).flatten();
        let seen = &mut self.seen_prompt;
        let drain = &self.drain;
        self.visible.extend(self.parser.filter(bytes, stamp, |nonce, sequence, input_generation| {
            if !local || keys.observe_shell_prompt(PROCESS, nonce, sequence, PromptProof::Local { drain, input_generation }).is_ok() {
                *seen = sequence;
            }
        }));
    }
    async fn assert_shell_usable(&mut self, f: &Fixture, expected: &ProcessIdentity) {
        // The literal output is not present in the command echo.
        #[cfg(windows)]
        let bytes = b"Write-Output ('local-'+'still-alive')\r";
        #[cfg(not(windows))]
        let bytes = b"printf '%s%s\\n' local- still-alive\r";
        write_input(&*f.port, PROCESS, InputSource::Renderer, None, bytes).unwrap();
        self.prompt(f.keys(), true).await;
        assert!(String::from_utf8_lossy(&self.visible).contains("local-still-alive"));
        assert_eq!(&ProcessIdentity::capture(self.pid()).unwrap(), expected);
    }
}
impl Drop for NativeShell {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) { let _ = self.child.kill(); }
        if self.child.wait().is_ok() { let _ = self.adapter.take().unwrap().finish_after_shell_quiescence(); }
    }
}

struct Tee(LocalWriter, Arc<Recorded>);
impl Write for Tee {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let n = self.0.lock().unwrap().write(bytes)?;
        self.1.bytes.lock().extend_from_slice(&bytes[..n]);
        *self.1.calls.lock() += 1;
        Ok(n)
    }
    fn flush(&mut self) -> std::io::Result<()> { self.0.lock().unwrap().flush() }
}

fn configured(port: u16) -> Fixture {
    let server = Server::new(1, "alice");
    let mut f = Fixture::unplaced(server.clone(), Arc::new(MemoryStreams(server.clone())));
    Arc::get_mut(&mut f.port).unwrap().native_bare = true;
    // The fake server accepts just this key. No user config, default identities,
    // agent, real known_hosts or non-loopback address is used by this fixture.
    let private = key(11).to_openssh(ssh_key::LineEnding::LF).unwrap();
    let identity = f.port.helper_root().unwrap().publish(ProcessIdentity::capture(std::process::id()).unwrap(),
        HelperKind::AttemptPayload, "json", private.as_bytes()).unwrap();
    f.store.transact(|store| {
        let row = &mut store.connections[0];
        row.host = "127.0.0.1".into();
        row.port = port;
        row.auth = Auth::KeyFile;
        row.identity_file = Some(identity.path().to_str().unwrap().into());
        Ok(())
    }, |_| {}).unwrap();
    f.seed(&format!("{} {}\n", lookup_token("127.0.0.1", port), server.host.public_key().to_openssh().unwrap()));
    f
}

async fn local(port: u16) -> (Fixture, NativeShell) {
    let mut f = configured(port);
    let (cg, staged) = f.stage();
    let mut shell = NativeShell::spawn(instrument(&f));
    shell.bind(&f, cg, &staged);
    let p = Arc::get_mut(&mut f.port).unwrap();
    p.writer = Arc::new(std::sync::Mutex::new(Box::new(Tee(shell.writer.clone(), p.record.clone()))));
    shell.prompt(f.keys(), true).await;
    (f, shell)
}

impl Fixture {
    async fn accepted(&self, a: &LaunchAttemptRef) -> LaunchSnapshot {
        self.register(a);
        self.gate(Gate::Verified).await;
        assert!(!self.tick(a));
        let snapshot = self.access(a, Operation::Query).unwrap();
        assert_eq!(snapshot.stage, LaunchStage::Typed);
        assert_eq!(self.sessions.current_launch(LEAF).unwrap().state, Some(LaunchState::Typed));
        snapshot
    }
    async fn observe_until(&self, a: &LaunchAttemptRef, expected: LaunchStage) {
        let end = Instant::now() + DEADLINE;
        loop {
            self.driver(a).observe(Instant::now());
            if self.launches.0.lock()[LEAF].snapshot.stage == expected { return; }
            assert!(Instant::now() < end, "did not observe {expected:?}: {:?}", self.port.events.lock().as_slice());
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
    fn stages(&self) -> Vec<Value> {
        self.port.events.lock().iter().map(|e| {
            assert_eq!(e["terminalId"], LEAF);
            e["state"].clone()
        }).collect()
    }
    fn adopt_pane(&self) -> PaneIdentity {
        let target = Self::page(self.keys(), TARGET);
        assert!(matches!(self.op(TARGET, target, 1, json!({"kind":"take","tx":"t5-move"})), PaneResult::Taken { .. }));
        assert_eq!(self.op(TARGET, target, 2, json!({"kind":"adopt","tx":"t5-move","pairs":[pane(target)]})), PaneResult::Ok);
        target
    }
}

async fn listener() -> (TcpListener, u16) {
    let tcp = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = tcp.local_addr().unwrap().port();
    (tcp, port)
}
async fn incoming(listen: &TcpListener) -> TcpStream {
    tokio::time::timeout(DEADLINE, listen.accept()).await.expect("native ssh never dialed the loopback peer").unwrap().0
}

#[tokio::test]
async fn ssh_exit_emits_ended_while_local_shell_stays_alive() {
    let (tcp, port) = listener().await;
    let (f, mut shell) = local(port).await;
    let shell_id = ProcessIdentity::capture(shell.pid()).unwrap();
    let a = f.open();
    let typed = f.accepted(&a).await;
    let remote = incoming(&tcp).await;
    f.observe_until(&a, LaunchStage::Running).await;
    let running = f.access(&a, Operation::Query).unwrap();
    drop(remote);
    // No prompt fed to the observer yet: the tracked process really exited.
    f.observe_until(&a, LaunchStage::Ended).await;
    let ended = f.access(&a, Operation::Query).unwrap();
    assert!(typed.launch_seq < running.launch_seq && running.launch_seq < ended.launch_seq);
    assert_eq!(ended.revision, ended.launch_seq);
    assert!(ended.error.is_none());
    shell.prompt(f.keys(), true).await;
    assert!(!f.driver(&a).observe(Instant::now()));
    assert!(f.launches.0.lock()[LEAF].payload.is_none());
    assert_eq!(f.stages(), [json!("typed"), json!("running"), json!("ended")]);
    shell.assert_shell_usable(&f, &shell_id).await;
    f.shutdown().await;
}

#[tokio::test]
async fn healthy_app_channel_cannot_mask_terminal_ssh_end() {
    let (tcp, port) = listener().await;
    let (f, _shell) = local(port).await;
    let a = f.open();
    f.accepted(&a).await;
    let remote = incoming(&tcp).await;
    f.observe_until(&a, LaunchStage::Running).await;
    f.phase(SessionState::Connected).await;
    let lease = f.sessions.lease(LEAF).unwrap();
    assert_eq!(lease.exec("fixture").await.unwrap().exit, 7);
    drop(remote);
    f.observe_until(&a, LaunchStage::Ended).await;
    assert_eq!(f.sessions.owner_map(), std::collections::HashMap::from([(LEAF.into(), (CONNECTION.into(), SessionState::Disconnected))]));
    assert!(matches!(f.sessions.lease(LEAF), Err(SessionError::NotConnected)));
    assert!(lease.exec("fixture").await.is_err());
    f.shutdown().await;
}

#[tokio::test]
async fn immediate_ssh_failure_never_claims_running() {
    let (tcp, port) = listener().await;
    let (f, mut shell) = local(port).await;
    let a = f.open();
    f.accepted(&a).await;
    let remote = incoming(&tcp).await;
    let now = Instant::now();
    // Even successive positive native snapshots inside the confirmation
    // interval cannot report this short-lived child as running.
    assert!(f.driver(&a).observe(now));
    assert!(f.driver(&a).observe(now));
    drop(remote);
    shell.prompt(f.keys(), true).await;
    f.observe_until(&a, LaunchStage::Ended).await;
    assert_eq!(f.stages(), [json!("typed"), json!("ended")]);
    assert_eq!(f.access(&a, Operation::Query).unwrap().error.unwrap().code, Code::WriteFailed);
    f.shutdown().await;
}

#[tokio::test]
async fn real_emitter_calls_ingress_before_renderer_event() {
    let (tcp, port) = listener().await;
    let (f, _shell) = local(port).await;
    let a = f.open();
    f.accepted(&a).await;
    let remote = incoming(&tcp).await;
    f.observe_until(&a, LaunchStage::Running).await;
    drop(remote);
    f.observe_until(&a, LaunchStage::Ended).await;
    assert_eq!(f.stages(), [json!("typed"), json!("running"), json!("ended")]);
    assert_eq!(*f.port.ingressed.lock(), [Some(LaunchState::Typed), Some(LaunchState::Running), Some(LaunchState::Ended)]);
    f.shutdown().await;
}

#[tokio::test]
async fn queued_old_generation_or_launch_seq_cannot_disconnect_new_session() {
    let (tcp, port) = listener().await;
    let (f, mut shell) = local(port).await;
    let a = f.open();
    f.accepted(&a).await;
    let remote = incoming(&tcp).await;
    f.observe_until(&a, LaunchStage::Running).await;
    drop(remote);
    shell.prompt(f.keys(), true).await;
    f.observe_until(&a, LaunchStage::Ended).await;
    let first_end = f.access(&a, Operation::Query).unwrap();
    let b = f.reference(&reconnect_core(f.keys(), &f.sessions, LEAF).unwrap());
    f.accepted(&b).await;
    let remote = incoming(&tcp).await;
    f.observe_until(&b, LaunchStage::Running).await;
    f.phase(SessionState::Connected).await;
    let running = f.access(&b, Operation::Query).unwrap();
    assert!(running.launch_seq > first_end.launch_seq);
    let events = f.stages();
    // New sequence with old generation; current generation with old sequence.
    for (generation, seq) in [(a.session_generation, u64::MAX), (b.session_generation, running.launch_seq - 1)] {
        assert_eq!(sessions::on_launch_lifecycle(&f.sessions, LEAF, generation, seq, LaunchState::Ended, Some(PROCESS.into())), Err(SessionError::StaleAttempt));
        assert!(f.sessions.lease(LEAF).is_ok());
        assert_eq!(f.sessions.current_launch(LEAF).unwrap().state, Some(LaunchState::Running));
        assert_eq!(f.stages(), events);
    }
    drop(remote);
    f.observe_until(&b, LaunchStage::Ended).await;
    assert!(matches!(f.sessions.lease(LEAF), Err(SessionError::NotConnected)));
    assert_eq!(f.sessions.current_launch(LEAF).unwrap().generation, b.session_generation);
    assert_eq!(f.stages().last(), Some(&json!("ended")));
    f.shutdown().await;
}

#[tokio::test]
async fn detach_reattach_adopts_watcher_without_second_write() {
    let (tcp, port) = listener().await;
    let (f, _shell) = local(port).await;
    let a = f.open();
    let typed = f.accepted(&a).await;
    let bytes = f.port.record.bytes.lock().clone();
    let remote = incoming(&tcp).await;
    assert_eq!(f.op(SOURCE, f.owner, 3, json!({"kind":"stash","tx":"t5-move","pairs":[pane(f.owner)]})), PaneResult::Ok);
    f.launches.reconcile_processes(f.keys());
    f.observe_until(&a, LaunchStage::Running).await;
    let target = f.adopt_pane();
    f.launches.reconcile_processes(f.keys());
    assert_eq!(f.access(&a, Operation::Query), Err(Code::StaleAttempt.into()));
    let adopted = LaunchAttemptRef { owner_incarnation: target, ..a.clone() };
    let adopted_snapshot = f.launches.access(f.keys(), &f.sessions, TARGET, LEAF, adopted.clone(), Operation::Launch(CONNECTION)).unwrap();
    assert!(adopted_snapshot.launch_seq > typed.launch_seq);
    assert_eq!(adopted_snapshot.stage, LaunchStage::Running);
    assert!(!f.tick(&adopted));
    f.observe_until(&adopted, LaunchStage::Running).await;
    f.phase(SessionState::Connected).await;
    assert_eq!(*f.port.record.bytes.lock(), bytes);
    drop(remote);
    f.observe_until(&adopted, LaunchStage::Ended).await;
    assert_eq!(f.stages(), [json!("typed"), json!("running"), json!("ended")]);
    assert_eq!(f.sessions.owner_map(), std::collections::HashMap::from([(LEAF.into(), (CONNECTION.into(), SessionState::Disconnected))]));
    f.shutdown().await;
}

#[tokio::test]
async fn close_cleans_observer_and_session_exact_map() {
    let (tcp, port) = listener().await;
    let (f, _shell) = local(port).await;
    let a = f.open();
    f.accepted(&a).await;
    let remote = incoming(&tcp).await;
    f.observe_until(&a, LaunchStage::Running).await;
    let other = PaneIdentity { pg: f.owner.pg, seq: 2 };
    assert_eq!(f.op(SOURCE, f.owner, 3, json!({"kind":"enter","panes":[{"pi":other,"paneId":"pn-other","leaf":"tm-other"}]})), PaneResult::Ok);
    let other_session = open_core(f.keys(), &f.sessions, "tm-other", CONNECTION).unwrap();
    let untouched = wait_state(&f.sessions, "tm-other", false, SessionState::Connecting).await;
    assert_eq!(untouched.generation, other_session.generation);
    assert_eq!(f.op(SOURCE, f.owner, 4, json!({"kind":"close","pi":f.owner})), PaneResult::Ok);
    let _ = f.keys().end_process(PROCESS, EndKind::Close(CloseStorage::Delete), |_| {});
    f.launches.reconcile_processes(f.keys());
    drop(remote);
    assert!(!f.driver(&a).observe(Instant::now()));
    assert!(f.launches.0.lock().is_empty());
    assert_eq!(f.sessions.owner_map(), std::collections::HashMap::from([("tm-other".into(), (CONNECTION.into(), SessionState::Connecting))]));
    assert_eq!(f.stages(), [json!("typed"), json!("running")]);
    f.shutdown().await;
}

fn host_deps() -> PtyHostDeps {
    let (tx, _) = broadcast::channel(256);
    PtyHostDeps {
        lifecycle_token: "t5-host-fixture".into(), output_tx: tx, output_produced: Arc::new(AtomicU64::new(0)),
        stream_offsets: Arc::default(), on_disconnect: Arc::new(|| {}), on_gap: Arc::new(|_| {}),
        on_exit: Arc::new(|_, _, _| {}), resolve_process: Arc::new(|key| (key == PROCESS).then(|| PROCESS.to_owned())),
    }
}

async fn hosted() -> (Fixture, NativeShell, DuplexStream) {
    let (_socket, port) = listener().await;
    let mut f = configured(port);
    let (core, mut peer) = tokio::io::duplex(64 * 1024);
    let (rd, wr) = tokio::io::split(core);
    let client = wire_client(rd, wr, host_deps());
    client.bind_sessions(f.keys(), HostChannel::Primary, 1);
    Arc::get_mut(&mut f.port).unwrap().host = Some(client);
    let (cg, staged) = f.stage();
    let mut shell = NativeShell::spawn(instrument(&f));
    shell.bind(&f, cg, &staged);
    let sequence = shell.prompt(f.keys(), false).await;
    write_frame(&mut peer, &Frame::Data(Data::SshPrompt { tab_id: PROCESS.into(), nonce: NONCE.into(), sequence, stdin_writes: 0 })).await.unwrap();
    // Wait for the real client reader to publish the sidecar prompt.
    tokio::time::timeout(DEADLINE, async {
        while !f.keys().launch_prompt_observed(PROCESS) { tokio::task::yield_now().await; }
    }).await.unwrap();
    (f, shell, peer)
}

async fn stdin_frame(peer: &mut DuplexStream) -> Vec<u8> {
    let frame = tokio::time::timeout(DEADLINE, read_frame(peer)).await.unwrap().unwrap();
    let Some(Frame::Data(Data::Stdin { tab_id, bytes })) = frame else { panic!("unexpected frame {frame:?}") };
    assert_eq!(tab_id, PROCESS);
    bytes
}

#[tokio::test]
async fn hosted_queue_acceptance_is_typed_not_running() {
    let (f, _shell, mut peer) = hosted().await;
    let a = f.open();
    f.accepted(&a).await;
    assert_eq!(stdin_frame(&mut peer).await, f.typed_bytes());
    // Host peer holds the accepted input; no SSH process or wire ack exists.
    assert!(f.driver(&a).observe(Instant::now()));
    assert_eq!(f.stages(), [json!("typed")]);
    assert_eq!(f.access(&a, Operation::Query).unwrap().stage, LaunchStage::Typed);
    f.shutdown().await;
}

#[tokio::test]
async fn host_write_error_after_enqueue_before_running_ends_visibly() {
    let (f, _shell, mut peer) = hosted().await;
    let a = f.open();
    f.accepted(&a).await;
    let bytes = stdin_frame(&mut peer).await;
    // Real host-side write failure while the framed connection remains live.
    // Legacy hosts supply no error frame; exercise the bounded no-start path.
    let (rd, mut writer) = std::io::pipe().unwrap();
    drop(rd);
    assert_eq!(writer.write_all(&bytes).unwrap_err().kind(), std::io::ErrorKind::BrokenPipe);
    assert!(f.driver(&a).observe(Instant::now()));
    f.driver(&a).observe(Instant::now() + NO_START);
    let snapshot = f.access(&a, Operation::Query).unwrap();
    assert_eq!(snapshot.stage, LaunchStage::Ended);
    assert_eq!(snapshot.error.unwrap().code, Code::WriteFailed);
    assert_eq!(f.stages(), [json!("typed"), json!("ended")]);
    assert!(!f.tick(&a));
    assert!(tokio::time::timeout(Duration::from_millis(100), read_frame(&mut peer)).await.is_err(), "queued input replayed");
    f.shutdown().await;
}

#[tokio::test]
async fn host_connection_loss_after_enqueue_is_not_replayed() {
    let (f, _shell, mut peer) = hosted().await;
    let a = f.open();
    f.accepted(&a).await;
    assert_eq!(stdin_frame(&mut peer).await, f.typed_bytes());
    drop(peer);
    tokio::time::timeout(DEADLINE, async {
        while f.keys().launch_host_epoch_alive(HostChannel::Primary, 1) { tokio::task::yield_now().await; }
    }).await.unwrap();
    let (core, mut replacement) = tokio::io::duplex(64 * 1024);
    let (rd, wr) = tokio::io::split(core);
    let next = wire_client(rd, wr, host_deps());
    next.bind_sessions(f.keys(), HostChannel::Primary, 2);
    assert!(f.keys().restore_route(HostChannel::Primary, PROCESS, PROCESS, 2));
    assert!(!f.driver(&a).observe(Instant::now()));
    let snapshot = f.access(&a, Operation::Query).unwrap();
    assert_eq!(snapshot.stage, LaunchStage::Ended);
    assert_eq!(snapshot.error.unwrap().code, Code::TransportClosed);
    assert!(!f.tick(&a));
    assert!(tokio::time::timeout(Duration::from_millis(100), read_frame(&mut replacement)).await.is_err(), "replayed on new epoch");
    assert!(f.port.record.bytes.lock().is_empty(), "fell back to local");
    f.shutdown().await;
}

#[tokio::test]
async fn revoked_app_channel_does_not_hide_the_terminal_exit() {
    let (tcp, port) = listener().await;
    let (f, _shell) = local(port).await;
    let a = f.open();
    f.accepted(&a).await;
    let remote = incoming(&tcp).await;
    f.observe_until(&a, LaunchStage::Running).await;
    f.phase(SessionState::Connected).await;
    f.sessions.disconnect(LEAF, "fixture app channel lost");
    assert!(f.driver(&a).observe(Instant::now()));
    assert_eq!(f.stages(), [json!("typed"), json!("running")]);
    drop(remote);
    f.observe_until(&a, LaunchStage::Ended).await;
    assert_eq!(f.stages().last(), Some(&json!("ended")));
    assert_eq!(f.sessions.current_launch(LEAF).unwrap().state, Some(LaunchState::Ended));
    assert_eq!(f.sessions.state(LEAF, false).unwrap().reason.as_deref(), Some("fixture app channel lost"));
    assert!(matches!(f.sessions.lease(LEAF), Err(SessionError::NotConnected)));
    f.shutdown().await;
}

#[tokio::test]
#[ignore = "requires an isolated native sidecar binary in TERMFLOW_TEST_PTY_HOST"]
async fn real_pty_host_accepts_once_and_observes_native_ssh_lifecycle() {
    use std::process::Stdio;
    let binary = std::env::var_os("TERMFLOW_TEST_PTY_HOST").expect("path to the matching-OS termflow-pty-host executable");
    let (tcp, port) = listener().await;
    let mut f = configured(port);
    let id = uuid::Uuid::new_v4().simple().to_string();
    #[cfg(windows)]
    let endpoint = format!(r"\\.\pipe\termflow-t5-{id}");
    #[cfg(unix)]
    let endpoint = {
        // Keep within sockaddr_un on macOS as well as Linux.
        let dir = std::env::temp_dir().join(format!("tf5-{}", &id[..12]));
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
        dir.join("s").into_os_string().into_string().unwrap()
    };
    let deps = host_deps();
    let mut host = tokio::process::Command::new(binary)
        .env("TERMFLOW_PTY_PIPE", &endpoint).env("TERMFLOW_PTY_TOKEN", &deps.lifecycle_token)
        .env_remove("TERMFLOW_PTY_RECORD").stdin(Stdio::null()).kill_on_drop(true).spawn().unwrap();
    let client = tokio::time::timeout(DEADLINE, async {
        loop {
            #[cfg(windows)]
            let stream = tokio::net::windows::named_pipe::ClientOptions::new().open(&endpoint);
            #[cfg(unix)]
            let stream = tokio::net::UnixStream::connect(&endpoint).await;
            if let Ok(stream) = stream {
                let (rd, wr) = tokio::io::split(stream);
                break wire_client(rd, wr, deps);
            }
            assert!(host.try_wait().unwrap().is_none(), "isolated test host exited before connecting");
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }).await.unwrap();
    client.bind_sessions(f.keys(), HostChannel::Primary, 1);
    client.set_ssh_prompt_registration(true);
    client.set_shutdown_control(true);
    Arc::get_mut(&mut f.port).unwrap().host = Some(client.clone());
    let (cg, staged) = f.stage();
    let mut adapter = instrument(&f);
    adapter.spec.env.push((termflow_pty_protocol::ssh_prompt::HOST_REGISTRATION_ENV.into(), NONCE.into()));
    let identity = f.keys().session_identity(HostChannel::Primary, PROCESS, PROCESS).unwrap();
    let pid = client.spawn_owned(&identity, &adapter.spec).await.unwrap();
    f.complete(cg, &staged, adapter.spec.shell.clone(), ProcessIdentity::capture(pid).unwrap());
    let a = f.open();
    let initial = f.register(&a);
    f.launches.start(f.port.clone(), f.sessions.clone(), f.store.clone(), f.port.home.clone(), &initial);
    let remote = incoming(&tcp).await;
    let wait_for = |state| {
        let (f, a) = (&f, &a);
        async move {
            tokio::time::timeout(DEADLINE, async {
                loop {
                    if f.access(a, Operation::Query).unwrap().stage == state { break; }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            }).await.unwrap()
        }
    };
    wait_for(LaunchStage::Running).await;
    f.phase(SessionState::Connected).await;
    drop(remote);
    wait_for(LaunchStage::Ended).await;
    // 067 ingress and the public sink follow the qualified snapshot; wait for
    // that event rather than racing the worker across the publication boundary.
    tokio::time::timeout(DEADLINE, async {
        while f.stages().last() != Some(&json!("ended")) { tokio::task::yield_now().await; }
    }).await.unwrap();
    assert_eq!(f.stages(), [json!("typed"), json!("running"), json!("ended")]);
    assert!(client.list_sessions().await.unwrap().iter().any(|s| s.tab_id == PROCESS && s.alive && s.pid == pid));
    assert!(tokio::time::timeout(Duration::from_millis(250), tcp.accept()).await.is_err(), "second TCP dial means replay");
    assert!(client.shutdown().await);
    assert!(client.close_transport().await);
    assert!(tokio::time::timeout(DEADLINE, host.wait()).await.unwrap().unwrap().success());
    adapter.finish_after_shell_quiescence().unwrap();
    #[cfg(unix)]
    std::fs::remove_dir(Path::new(&endpoint).parent().unwrap()).unwrap();
    f.shutdown().await;
}
