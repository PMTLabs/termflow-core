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
