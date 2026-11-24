use super::*;

#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
// The shared child-process gate intentionally outlives every owned child.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn pid_reuse_unrelated_manual_ssh_and_proxy_child_do_not_claim_launch() {
    let _gate = crate::pty_host_client::test_dirs::child_process_gate();
    use std::process::Stdio;
    use tokio::{net::TcpListener, process::Command as Spawn};
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port().to_string();
    #[cfg(windows)]
    let path = crate::pty_manager::ssh_shell::system_shell(r"OpenSSH\ssh.exe").unwrap();
    #[cfg(not(windows))]
    let path = "/usr/bin/ssh".to_owned();
    let exe = std::fs::canonicalize(&path).unwrap();
    let marker = marker();
    let cmd = Command {
        posix_fork_stub: false,
        shell: Identity::shell(&ProcessIdentity::capture(std::process::id()).unwrap()),
        exe,
        marker: marker.clone(),
        intermediary: None,
    };
    let args = ["-F", "none", "-o", "IdentityFile=none", "-o", "UserKnownHostsFile=none", "-o", "GlobalKnownHostsFile=none", "-p", &port, "--", "127.0.0.1"];
    let mut manual = Spawn::new(&path).args(args).stdin(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true).spawn().unwrap();
    let accept = || async { tokio::time::timeout(Duration::from_secs(10), listener.accept()).await.unwrap().unwrap().0 };
    let manual_peer = accept().await;
    assert!(cmd.sample().candidate.is_none(), "manual ssh cannot claim the command boundary");

    // Give the proxy-side descendant even the destination marker: crossing an
    // unapproved intermediary would still be wrong. This helper stays alive
    // until its SSH exits and can never exec in its place.
    #[cfg(unix)]
    let mut helper = {
        let mut child = Spawn::new("/bin/sh");
        child.args(["-c", "\"$@\" & wait", "fixture", &path, "-o", &marker]).args(args);
        child
    };
    #[cfg(windows)]
    let mut helper = {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let quote = |s: &str| format!("'{}'", s.replace('\'', "''"));
        let argv = ["-o", &marker].into_iter().chain(args).map(quote).collect::<Vec<_>>().join(" ");
        let script = format!("& {} {argv}; exit $LASTEXITCODE", quote(&path));
        let utf16 = script.encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<_>>();
        let mut child = Spawn::new(crate::pty_manager::ssh_shell::system_shell("powershell.exe").unwrap());
        child.args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &STANDARD.encode(utf16)]);
        child
    };
    let mut proxy = helper.stdin(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true).spawn().unwrap();
    let proxy_peer = accept().await;
    assert!(cmd.sample().candidate.is_none(), "a grandchild without the encoder's exact intermediary is not ours");

    let mut destination = Spawn::new(&path).args(["-o", &marker]).args(args)
        .stdin(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true).spawn().unwrap();
    let destination_peer = accept().await;
    let now = Instant::now();
    let sample = cmd.sample();
    let child = sample.candidate.expect("real marked destination");
    assert_eq!(child.pid.as_u32(), destination.id().unwrap());
    let mut tracker = Tracker::default();
    assert_eq!(tracker.sample(&sample, now, true), Observation::Wait);
    assert_eq!(tracker.sample(&cmd.sample(), now + CONFIRM_FOR, true), Observation::Running);

    // PID reuse cannot be requested portably. Keep the real sampled process
    // evidence and vary only the pinned native birth (same PID and executable).
    let mut reused = Tracker { running: Some(Identity { birth: child.birth ^ 1, ..child }), ..Default::default() };
    assert_eq!(reused.sample(&cmd.sample(), now + CONFIRM_FOR, true), Observation::Exited);
    assert_eq!(tracker.sample(&cmd.sample(), now + CONFIRM_FOR, true), Observation::Wait);
    drop((manual_peer, proxy_peer, destination_peer));
    for child in [&mut manual, &mut proxy, &mut destination] {
        tokio::time::timeout(Duration::from_secs(10), child.wait()).await.unwrap().unwrap();
    }
    assert_eq!(tracker.sample(&cmd.sample(), Instant::now(), true), Observation::Exited);
}

#[test]
fn fork_stub_requires_enabled_same_exe_and_only_marker_child() {
    let shell = Identity { pid: Pid::from_u32(1), birth: 1 };
    let stub = Identity { pid: Pid::from_u32(2), birth: 2 };
    let dest = Identity { pid: Pid::from_u32(3), birth: 3 };
    let other = Identity { pid: Pid::from_u32(4), birth: 4 };
    let mut cmd = Command {
        shell: Some(shell), exe: PathBuf::from("ssh.exe"), marker: "marker".into(),
        intermediary: None, posix_fork_stub: true,
    };
    assert_eq!(cmd.fork_stub_destination(shell, stub, || Some((true, vec![Some(dest)], true))), Some(dest));
    assert_eq!(cmd.fork_stub_destination(shell, stub, || Some((true, vec![Some(dest)], false))), None, "not the marker destination");
    assert_eq!(cmd.fork_stub_destination(shell, stub, || Some((false, vec![Some(dest)], true))), None, "different exe");
    assert_eq!(cmd.fork_stub_destination(shell, stub, || Some((true, vec![Some(dest), Some(other)], true))), None, "multiple children");
    assert_eq!(cmd.fork_stub_destination(shell, stub, || Some((true, vec![Some(dest), None], true))), None, "unreadable sibling");
    assert_eq!(cmd.fork_stub_destination(shell, stub, || Some((true, vec![None], true))), None, "unreadable only child");
    assert_eq!(cmd.fork_stub_destination(shell, Identity { birth: 0, ..stub }, || Some((true, vec![Some(dest)], true))), None);
    assert_eq!(cmd.fork_stub_destination(shell, stub, || Some((true, vec![Some(Identity { birth: 1, ..dest })], true))), None);
    cmd.posix_fork_stub = false;
    assert_eq!(cmd.fork_stub_destination(shell, stub, || Some((true, vec![Some(dest)], true))), None, "flag disabled");
}

#[test]
fn unreadable_observer_child_is_busy_but_older_child_is_ignored() {
    let older = Identity { pid: Pid::from_u32(1), birth: 9 };
    let current = Identity { birth: 10, ..older };
    assert!(shell_is_bare([Some(older)], 10));
    assert!(!shell_is_bare([Some(current)], 10));
    assert!(!shell_is_bare([Some(older), None], 10));
}

#[test]
fn stub_children_keep_unreadable_and_drop_only_provably_older() {
    let older = Identity { pid: Pid::from_u32(1), birth: 9 };
    let current = Identity { birth: 10, ..older };
    assert_eq!(not_older([Some(older), Some(current), None], 10), vec![Some(current), None]);
}
