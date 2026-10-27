use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

#[test]
fn cache_is_keyed_by_pid_and_invalidates() {
    let cache = IdentityCache::default();
    let calls = AtomicUsize::new(0);
    let lookup = |pid| { calls.fetch_add(1, Ordering::SeqCst); if pid == 1 { IdentityVerdict::Matches } else { IdentityVerdict::Different } };
    assert_eq!(cache.verify(1, lookup), IdentityVerdict::Matches);
    assert_eq!(cache.verify(1, lookup), IdentityVerdict::Matches);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(cache.verify(2, lookup), IdentityVerdict::Different);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    cache.clear();
    assert_eq!(cache.verify(2, lookup), IdentityVerdict::Different);
    assert_eq!(calls.load(Ordering::SeqCst), 3);
}

#[test]
fn staging_and_verifier_share_requirement_text() {
    use crate::helper_identity::{helper_requirement, DEBUG_REQUIREMENT, RELEASE_REQUIREMENT};
    assert_eq!(DEBUG_REQUIREMENT, "identifier \"app.termflow.desktop.pty-host\"");
    assert_eq!(RELEASE_REQUIREMENT, "identifier \"app.termflow.desktop.pty-host\" and anchor apple generic and certificate leaf[subject.OU] = \"68M75D67LJ\"");
    assert_eq!(helper_requirement(), if cfg!(debug_assertions) { DEBUG_REQUIREMENT } else { RELEASE_REQUIREMENT });
    let staging = include_str!("../../pty_host_client/bundle_staging.rs");
    let verifier = include_str!("host_identity.rs");
    assert!(staging.contains("crate::helper_identity::helper_requirement()"));
    assert!(verifier.contains("crate::helper_identity::helper_requirement()"));
}

#[cfg(target_os = "macos")]
#[test]
fn real_process_code_identity_and_dead_pid() {
    use crate::helper_identity::{DEBUG_REQUIREMENT, RELEASE_REQUIREMENT};
    use std::process::{Child, Command, Stdio};
    struct Temp(std::path::PathBuf);
    impl Drop for Temp { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
    struct Reaped(Option<Child>);
    impl Drop for Reaped { fn drop(&mut self) { if let Some(child) = &mut self.0 { let _ = child.kill(); let _ = child.wait(); } } }

    assert_ne!(macos::verify(std::process::id(), DEBUG_REQUIREMENT), IdentityVerdict::Matches);
    let dir = Temp(std::env::temp_dir().join(format!("tf-identity-{}", uuid::Uuid::new_v4())));
    std::fs::create_dir(&dir.0).unwrap();
    let source = dir.0.join("sleep.c");
    let exe = dir.0.join("sleeper");
    std::fs::write(&source, "#include <unistd.h>\nint main(void) { for (;;) sleep(60); }\n").unwrap();
    let output = Command::new("/usr/bin/cc").arg(&source).arg("-o").arg(&exe).output().unwrap();
    assert!(output.status.success(), "cc: {}", String::from_utf8_lossy(&output.stderr));
    let output = Command::new("/usr/bin/codesign").args(["--force", "-s", "-", "--identifier", "app.termflow.desktop.pty-host"]).arg(&exe).output().unwrap();
    assert!(output.status.success(), "codesign: {}", String::from_utf8_lossy(&output.stderr));
    let mut child = Reaped(Some(Command::new(&exe).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap()));
    let pid = child.0.as_ref().unwrap().id();
    // Wait for exec/signature initialization, not a TCC operation.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        if child.0.as_mut().unwrap().try_wait().unwrap().is_some() {
            child.0.take(); // try_wait already reaped it; never signal its recycled PID.
            panic!("signed test sleeper exited early");
        }
        if macos::verify(pid, DEBUG_REQUIREMENT) == IdentityVerdict::Matches { break; }
        assert!(std::time::Instant::now() < deadline, "signed sleeper did not match debug requirement");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert_eq!(macos::verify(pid, RELEASE_REQUIREMENT), IdentityVerdict::Different);
    child.0.as_mut().unwrap().kill().unwrap();
    child.0.as_mut().unwrap().wait().unwrap();
    child.0.take();
    assert_eq!(macos::verify(pid, DEBUG_REQUIREMENT), IdentityVerdict::Unverifiable);
}
