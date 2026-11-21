//! 066 T10: a saved launch end to end. The real 067 engine asks for trust, the
//! real instrumented default shell receives the typed command, and the outer
//! `ssh` is a recording executable that logs its argv and the trust file as it
//! was at exec, then hands the same argv to the real OpenSSH. A fake outer
//! alone cannot pass: the real client must log in with that trust file.
// The shared child-process gate is a std mutex (sync tests take it too) and is
// meant to outlive every awaited real child; each #[tokio::test] owns its runtime.
#![allow(clippy::await_holding_lock)]
use super::*;
use crate::pty_manager::ssh_shell::posix::tests::launch_tests::compile_argv_recorder;
use std::path::Path;

/// Same guard as the T1 real-OpenSSH oracles: required, never skipped.
fn real_ssh() -> String {
    #[cfg(windows)]
    {
        let ssh = crate::pty_manager::ssh_shell::system_shell(r"OpenSSH\ssh.exe").unwrap();
        assert!(Path::new(&ssh).is_file(), "required native Windows OpenSSH is missing: {ssh}");
        ssh
    }
    #[cfg(not(windows))]
    {
        std::env::var("TERMFLOW_TEST_SSH").unwrap_or_else(|_| "/usr/bin/ssh".into())
    }
}

struct Recorded {
    f: Fixture,
    shell: NativeShell,
    log: PathBuf,
    real: String,
    accept: tokio::task::JoinHandle<()>,
}
impl Drop for Recorded {
    fn drop(&mut self) { self.accept.abort(); }
}

/// The T5 local fixture, unpinned, with the recording `ssh` as the port's
/// executable and the fake server also listening on real loopback TCP.
async fn recorded(tcp: TcpListener, port: u16) -> Recorded {
    let mut f = keyed(port);
    // An allowlisted option the config oracle must see in the real client.
    f.store.transact(|store| {
        store.connections[0].extra_options = vec![("ServerAliveInterval".into(), "10".into())];
        Ok(())
    }, |_| {}).unwrap();
    let recorder = compile_argv_recorder(&f.port.home);
    let log = f.port.home.join("ssh invocations.jsonl");
    let real = real_ssh();
    Arc::get_mut(&mut f.port).unwrap().ssh = Some(recorder.to_str().unwrap().into());
    let env = vec![
        ("TF_ARGV_LOG".to_owned(), log.to_str().unwrap().to_owned()),
        ("TF_TRUST_FILE".to_owned(), f.trust_path.to_str().unwrap().to_owned()),
        ("TF_ARGV_EXEC".to_owned(), real.clone()),
    ];
    let server = f.server.clone();
    let accept = tokio::spawn(async move {
        while let Ok((stream, _)) = tcp.accept().await {
            server.clone().start(Box::new(stream));
        }
    });
    let (cg, staged) = f.stage();
    let mut shell = NativeShell::spawn(instrument_env(&f, env));
    shell.bind(&f, cg, &staged);
    let p = Arc::get_mut(&mut f.port).unwrap();
    p.writer = Arc::new(std::sync::Mutex::new(Box::new(Tee(shell.writer.clone(), p.record.clone()))));
    shell.prompt(f.keys(), true).await;
    Recorded { f, shell, log, real, accept }
}

fn invocations(log: &Path) -> Vec<Value> {
    std::fs::read_to_string(log).unwrap_or_default().lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn config(ssh: &str, args: &[String]) -> Vec<String> {
    let output = std::process::Command::new(ssh).arg("-G").args(args)
        .stdin(std::process::Stdio::null()).output()
        .expect("required real OpenSSH executable missing");
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8(output.stdout).unwrap().lines().map(str::to_owned).collect()
}

// Mutation targets: drive.rs `eligible` admitting a Pending/Blocked gate (the
// recorded trust bytes are then empty, and the real client refuses the host);
// launch_argv.rs `hop_argv` dropping UserKnownHostsFile/StrictHostKeyChecking
// or extra options (the -G oracle and the real login fail).
#[tokio::test]
async fn saved_ssh_launch_trust_then_shell_argv_end_to_end() {
    let _gate = crate::pty_host_client::test_dirs::child_process_gate();
    let (tcp, port) = listener().await;
    let mut r = recorded(tcp, port).await;
    let f = &r.f;
    let a = f.open();
    f.register(&a);
    let prompt = f.phase(SessionState::NeedsHostkey).await;
    assert!(f.tick(&a));
    assert_eq!(f.access(&a, Operation::Query).unwrap().stage, LaunchStage::WaitingTrust);
    f.zero();
    assert!(!r.log.exists(), "ssh ran before the host was trusted");

    f.trust(&prompt, true).unwrap();
    f.gate(Gate::Verified).await;
    assert!(!f.tick(&a));
    let typed = f.typed_bytes();
    assert_eq!(*f.port.record.bytes.lock(), typed);
    let argv = f.launches.0.lock()[LEAF].payload.as_ref().unwrap().encoded.argv().to_vec();
    assert_eq!(argv[0], f.port.ssh.clone().unwrap());

    // The same shell returns to its prompt after the real client's session.
    r.shell.prompt(f.keys(), false).await;
    assert!(String::from_utf8_lossy(&r.shell.visible).contains("launch-shell-ok"));

    // Outer recording executable: exactly one exec, the exact encoded argv, and
    // the durable pin already in the receipt's trust file at exec time.
    let pinned = std::fs::read_to_string(&f.trust_path).unwrap();
    assert!(pinned.contains(&lookup_token("127.0.0.1", port)));
    let calls = invocations(&r.log);
    assert_eq!(calls.len(), 1, "{calls:?}");
    assert_eq!(calls[0]["argv"], json!(argv[1..]));
    assert_eq!(calls[0]["trust"], json!(pinned));

    // Real OpenSSH process oracle: the engine's verifier plus one terminal login
    // that allocated a PTY with this saved row's key and trust file.
    let counters = &f.server.counters;
    assert_eq!(counters.handshakes.load(Ordering::SeqCst), 2);
    assert_eq!(counters.ptys.load(Ordering::SeqCst), 1);
    assert!(counters.principals.lock().iter().all(|user| user == "alice"));

    // Real OpenSSH config/option oracle over the recorded argv.
    let lines = config(&r.real, &argv[1..]);
    let has = |line: &str| lines.iter().any(|l| l == line);
    assert!(has("hostname 127.0.0.1") && has(&format!("port {port}")) && has("user alice"), "{lines:?}");
    assert!(has("stricthostkeychecking true") || has("stricthostkeychecking yes"), "{lines:?}");
    assert!(has("serveraliveinterval 10") && has("permitlocalcommand no"), "{lines:?}");
    let trust = f.trust_path.to_str().unwrap().replace('\\', "/");
    assert!(lines.iter().any(|l| l.strip_prefix("userknownhostsfile ").is_some_and(|p| p.replace('\\', "/") == trust)), "{lines:?}");
    f.shutdown().await;
}

// Mutation target: drive.rs `eligible` (or the WaitingTrust branch of `tick`)
// dispatching while the gate is Blocked after the trust prompt is cancelled.
#[tokio::test]
async fn untrusted_cancel_has_zero_ssh_execs() {
    let _gate = crate::pty_host_client::test_dirs::child_process_gate();
    let (tcp, port) = listener().await;
    let mut r = recorded(tcp, port).await;
    let shell_id = ProcessIdentity::capture(r.shell.pid()).unwrap();
    let f = &r.f;
    let a = f.open();
    f.register(&a);
    let prompt = f.phase(SessionState::NeedsHostkey).await;
    assert!(f.tick(&a));
    f.trust(&prompt, false).unwrap();
    let view = f.phase(SessionState::Disconnected).await;
    assert_eq!(view.gate, Gate::Blocked);
    assert!(!f.tick(&a));
    let blocked = f.access(&a, Operation::Query).unwrap();
    assert_eq!((blocked.stage, blocked.error.unwrap().code), (LaunchStage::Blocked, Code::TrustBlocked));
    f.zero();
    // The shell still runs ordinary commands; none of them is ssh.
    r.shell.assert_shell_usable(&r.f, &shell_id).await;
    let f = &r.f;
    assert!(!f.tick(&a));
    assert!(invocations(&r.log).is_empty(), "the recording ssh executed");
    assert!(std::fs::read_to_string(&f.trust_path).unwrap_or_default().is_empty());
    assert_eq!(f.server.counters.handshakes.load(Ordering::SeqCst), 1);
    assert_eq!(f.server.counters.ptys.load(Ordering::SeqCst), 0);
    f.shutdown().await;
}
