//! Backlog 054: a prompt drawn before the typed launch line runs (PowerShell
//! re-prompting while a tiny pane settles) is not proof the line ran. The
//! payload must outlive that prompt, and the launch must follow the real child.
//! The re-prompt here is real: an out-of-band Enter makes the real shell print
//! a fresh ready OSC while the launch line is still held by the host peer.
use super::*;

#[cfg(windows)]
fn pwsh_profile() -> (String, Vec<String>) {
    let shell = std::env::var("TERMFLOW_TEST_PWSH").unwrap_or_else(|_| {
        let default = PathBuf::from(std::env::var_os("ProgramFiles").expect("ProgramFiles"))
            .join(r"PowerShell\7\pwsh.exe");
        default.to_str().unwrap().to_owned()
    });
    assert!(Path::new(&shell).is_file(), "required pwsh missing: set TERMFLOW_TEST_PWSH");
    (shell, vec!["-NoProfile".into(), "-NoLogo".into()])
}

/// The hosted fixture, keeping the loopback listener so the late line can connect.
async fn hosted_with(profile: (String, Vec<String>)) -> (Fixture, NativeShell, DuplexStream, TcpListener) {
    hosted_with_home(profile, None).await
}

async fn hosted_with_home(profile: (String, Vec<String>), home: Option<&Path>) -> (Fixture, NativeShell, DuplexStream, TcpListener) {
    let (tcp, port) = listener().await;
    let mut f = configured(port);
    if let Some(home) = home { Arc::get_mut(&mut f.port).unwrap().home = home.to_owned(); }
    let (core, mut peer) = tokio::io::duplex(64 * 1024);
    let (rd, wr) = tokio::io::split(core);
    let client = wire_client(rd, wr, host_deps());
    client.bind_sessions(f.keys(), HostChannel::Primary, 1);
    Arc::get_mut(&mut f.port).unwrap().host = Some(client);
    let (cg, staged) = f.stage();
    let mut shell = NativeShell::spawn(instrument_profile(&f, Vec::new(), profile));
    shell.bind(&f, cg, &staged);
    let sequence = shell.prompt(f.keys(), false).await;
    write_frame(&mut peer, &Frame::Data(Data::SshPrompt { tab_id: PROCESS.into(), nonce: NONCE.into(), sequence, stdin_writes: 0 })).await.unwrap();
    published(&f).await;
    (f, shell, peer, tcp)
}

async fn published(f: &Fixture) {
    tokio::time::timeout(DEADLINE, async {
        while !f.keys().launch_prompt_observed(PROCESS) { tokio::task::yield_now().await; }
    }).await.expect("host prompt was not published");
}

/// The attempt payload directory named by the typed line.
fn payload_dir(f: &Fixture, typed: &[u8]) -> PathBuf {
    let text = String::from_utf8_lossy(typed);
    let id = regex::Regex::new(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}").unwrap()
        .find(&text).expect("typed line names its payload").as_str().to_owned();
    fn find(dir: &Path, id: &str) -> Option<PathBuf> {
        for entry in std::fs::read_dir(dir).ok()?.flatten() {
            let path = entry.path();
            if !entry.file_type().ok()?.is_dir() { continue; }
            if entry.file_name() == id { return Some(path); }
            if let Some(found) = find(&path, id) { return Some(found); }
        }
        None
    }
    let dir = find(&f.port.home, &id).expect("payload directory published before the write");
    assert!(std::fs::read_dir(&dir).unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with("helper.")));
    dir
}

/// A real prompt redraw that is not the launch line returning: Enter reaches the
/// shell out of band (the launch line is still queued at the host peer).
async fn reprompt(f: &Fixture, shell: &mut NativeShell, peer: &mut DuplexStream) {
    shell.writer.lock().unwrap().write_all(b"\r").unwrap();
    let sequence = shell.prompt(f.keys(), false).await;
    // The host stamps a prompt read after the launch write with that one write.
    write_frame(peer, &Frame::Data(Data::SshPrompt { tab_id: PROCESS.into(), nonce: NONCE.into(), sequence, stdin_writes: 1 })).await.unwrap();
    published(f).await;
}

#[tokio::test]
async fn reprompt_before_the_typed_line_runs_keeps_the_payload_and_follows_the_child() {
    reprompt_then_line_runs(default_profile()).await;
}

#[cfg(windows)]
#[tokio::test]
async fn pwsh_reprompt_before_the_typed_line_runs_keeps_the_payload_and_follows_the_child() {
    reprompt_then_line_runs(pwsh_profile()).await;
}

async fn reprompt_then_line_runs(profile: (String, Vec<String>)) {
    let _gate = crate::pty_host_client::test_dirs::child_process_gate();
    let (f, mut shell, mut peer, tcp) = hosted_with(profile).await;
    let a = f.open();
    f.accepted(&a).await;
    let typed = stdin_frame(&mut peer).await;
    let dir = payload_dir(&f, &typed);
    reprompt(&f, &mut shell, &mut peer).await;
    for _ in 0..3 {
        assert!(f.driver(&a).observe(Instant::now()), "observer stopped on a prompt that preceded the line");
    }
    assert!(dir.is_dir(), "payload deleted before the typed line ran");
    assert_eq!(f.access(&a, Operation::Query).unwrap().stage, LaunchStage::Typed);
    // The held line now reaches the shell and really runs: it must find its payload.
    shell.writer.lock().unwrap().write_all(&typed).unwrap();
    let remote = incoming(&tcp).await;
    f.observe_until(&a, LaunchStage::Running).await;
    // The earlier redraw must not end the now-running child.
    for _ in 0..3 {
        assert!(f.driver(&a).observe(Instant::now()));
        tokio::time::sleep(CHECK_INTERVAL).await;
    }
    let snapshot = f.access(&a, Operation::Query).unwrap();
    assert_eq!(snapshot.stage, LaunchStage::Running, "error {:?}", snapshot.error);
    assert_eq!(f.stages(), [json!("typed"), json!("running")]);
    drop(remote);
    f.observe_until(&a, LaunchStage::Ended).await;
    assert!(dir.is_dir(), "deleted before the shell returned");
    // The shell's own prompt after ssh exits is the proved return: only now
    // may the payload be deleted.
    let sequence = shell.prompt(f.keys(), false).await;
    write_frame(&mut peer, &Frame::Data(Data::SshPrompt { tab_id: PROCESS.into(), nonce: NONCE.into(), sequence, stdin_writes: 1 })).await.unwrap();
    published(&f).await;
    tokio::time::timeout(DEADLINE, async {
        while f.driver(&a).observe(Instant::now()) { tokio::time::sleep(CHECK_INTERVAL).await; }
    }).await.expect("the observer did not finish after the proved return");
    assert!(f.launches.0.lock()[LEAF].payload.is_none());
    assert!(!dir.exists(), "a proved return must finish the payload: {}", dir.display());
    f.shutdown().await;
}

/// A process that carries `marker` as one exact argv element and lives ~30 s,
/// like an ssh child that outlived the shell that typed it.
fn marker_decoy(marker: &str) -> std::process::Child {
    #[cfg(windows)]
    let child = std::process::Command::new(crate::pty_manager::ssh_shell::system_shell("powershell.exe").unwrap())
        .args(["-NoProfile", "-Command", "Start-Sleep 30 #", marker]).spawn();
    #[cfg(not(windows))]
    // bash (macOS /bin/sh) execs a lone `-c` command in place, so `sleep`
    // would replace the process and drop the marker from argv. The EXIT trap
    // keeps bash alive with its argv; bash on Linux too, so CI there covers it.
    let child = std::process::Command::new("/bin/bash").args(["-c", "trap : EXIT; sleep 30", marker]).spawn();
    child.unwrap()
}

async fn wait_for(what: &str, mut done: impl FnMut() -> bool) {
    tokio::time::timeout(DEADLINE, async {
        while !done() { tokio::time::sleep(CHECK_INTERVAL).await; }
    }).await.unwrap_or_else(|_| panic!("timed out waiting for {what}"));
}

/// An unconfirmed attempt (re-prompt, no child, NO_START) whose payload has
/// moved to the retained list and whose shell has since exited.
async fn retained_with_dead_shell() -> (Fixture, LaunchAttemptRef, PathBuf, String) {
    let (f, mut shell, mut peer, _tcp) = hosted_with(default_profile()).await;
    let a = f.open();
    f.accepted(&a).await;
    let typed = stdin_frame(&mut peer).await;
    let dir = payload_dir(&f, &typed);
    let marker = f.launches.0.lock()[LEAF].payload.as_ref().unwrap().marker().to_owned();
    reprompt(&f, &mut shell, &mut peer).await;
    let now = Instant::now();
    f.driver(&a).observe(now);
    f.driver(&a).observe(now + NO_START);
    assert!(!f.driver(&a).observe(now + 2 * NO_START));
    assert_eq!(f.launches.1.lock().len(), 1, "the ended attempt's payload is retained");
    drop(shell);
    wait_for("the shell to be gone", || f.launches.1.lock()[0].shell_gone()).await;
    assert!(dir.is_dir());
    (f, a, dir, marker)
}

#[tokio::test]
async fn a_live_marker_child_defers_the_reap_and_the_next_launch_reaps() {
    let _gate = crate::pty_host_client::test_dirs::child_process_gate();
    let (f, a, dir, marker) = retained_with_dead_shell().await;
    let mut decoy = marker_decoy(&marker);
    wait_for("the decoy's argv", || crate::ssh::launch_process::live_markers([marker.as_str()]).contains(&marker)).await;
    // Shell gone but a marker child alive: it may still use the payload.
    f.launches.reconcile_processes(f.keys());
    let _ = f.access(&a, Operation::Launch(CONNECTION));
    let still_live = crate::ssh::launch_process::live_markers([marker.as_str()]).contains(&marker);
    assert!(still_live, "the decoy lost its marker (exited or exec'd), so this test proves nothing");
    assert!(dir.is_dir(), "reaped while a marker child was alive");
    decoy.kill().unwrap();
    decoy.wait().unwrap();
    // The next launch operation in the pane reaps it (no reconcile needed).
    let _ = f.access(&a, Operation::Launch(CONNECTION));
    assert!(!dir.exists(), "the next launch did not reap: {}", dir.display());
    assert!(f.launches.1.lock().is_empty());
    f.shutdown().await;
}

#[tokio::test]
async fn dropping_the_registry_reaps_quiescent_payloads() {
    let _gate = crate::pty_host_client::test_dirs::child_process_gate();
    let (f, _a, dir, _marker) = retained_with_dead_shell().await;
    // Move it into a registry this test can drop, as at app exit.
    let registry = LaunchRegistry::default();
    registry.1.lock().extend(f.launches.1.lock().drain(..));
    drop(registry);
    assert!(!dir.exists(), "registry drop did not reap: {}", dir.display());
    f.shutdown().await;
}

#[tokio::test]
async fn reprompt_without_a_child_ends_at_no_start_and_retains_the_payload() {
    let _gate = crate::pty_host_client::test_dirs::child_process_gate();
    let (f, mut shell, mut peer, _tcp) = hosted_with(default_profile()).await;
    let a = f.open();
    f.accepted(&a).await;
    let typed = stdin_frame(&mut peer).await;
    let dir = payload_dir(&f, &typed);
    reprompt(&f, &mut shell, &mut peer).await;
    let now = Instant::now();
    assert!(f.driver(&a).observe(now));
    assert_eq!(f.access(&a, Operation::Query).unwrap().stage, LaunchStage::Typed);
    assert!(dir.is_dir());
    f.driver(&a).observe(now + NO_START);
    let snapshot = f.access(&a, Operation::Query).unwrap();
    assert_eq!(snapshot.stage, LaunchStage::Ended);
    assert_eq!(snapshot.error.unwrap().code, Code::SshExitedBeforeConnecting);
    assert_eq!(f.stages(), [json!("typed"), json!("ended")]);
    // No child was ever seen: the line may still run, so the payload stays.
    assert!(dir.is_dir(), "payload deleted without proof the typed line ran");
    f.shutdown().await;
}

#[tokio::test]
async fn reprompt_late_child_connects_without_reopening_ended_attempt() {
    let _gate = crate::pty_host_client::test_dirs::child_process_gate();
    let (f, mut shell, mut peer, tcp) = hosted_with(default_profile()).await;
    let a = f.open();
    f.accepted(&a).await;
    let typed = stdin_frame(&mut peer).await;
    let dir = payload_dir(&f, &typed);
    reprompt(&f, &mut shell, &mut peer).await;
    let now = Instant::now() + NO_START;
    f.driver(&a).observe(now);
    f.driver(&a).observe(now + NO_START);
    assert!(dir.is_dir());
    shell.writer.lock().unwrap().write_all(&typed).unwrap();
    let remote = incoming(&tcp).await;
    assert!(!f.driver(&a).observe(now + 2 * NO_START));
    assert_eq!(f.access(&a, Operation::Query).unwrap().stage, LaunchStage::Ended);
    drop(remote);
    f.shutdown().await;
}

#[tokio::test]
async fn reprompt_reaps_repeated_unconfirmed_attempts_after_shell_exit() {
    let _gate = crate::pty_host_client::test_dirs::child_process_gate();
    let (first, shell, peer, tcp) = hosted_with(default_profile()).await;
    let home = first.port.home.clone();
    let mut fixtures = vec![(first, shell, peer, tcp)];
    for _ in 0..2 {
        fixtures.push(hosted_with_home(default_profile(), Some(&home)).await);
    }
    let mut retained = Vec::new();
    for (f, mut shell, mut peer, tcp) in fixtures {
        let a = f.open();
        f.accepted(&a).await;
        let typed = stdin_frame(&mut peer).await;
        let dir = payload_dir(&f, &typed);
        reprompt(&f, &mut shell, &mut peer).await;
        shell.writer.lock().unwrap().write_all(&typed).unwrap();
        drop(incoming(&tcp).await);
        shell.prompt(f.keys(), false).await;
        let now = Instant::now() + NO_START;
        f.driver(&a).observe(now);
        f.driver(&a).observe(now + NO_START);
        assert!(dir.is_dir());
        retained.push((f, shell, dir));
    }
    let mut checked = Vec::new();
    for (f, shell, dir) in retained {
        drop(shell);
        f.launches.reconcile_processes(f.keys());
        assert!(!dir.exists(), "unreaped attempt: {}", dir.display());
        f.shutdown().await;
        checked.push(f);
    }
}
