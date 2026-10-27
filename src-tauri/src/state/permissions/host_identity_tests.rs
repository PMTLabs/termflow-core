use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

#[test]
fn cache_is_keyed_by_full_token_and_invalidates() {
    let cache = IdentityCache::default();
    let calls = AtomicUsize::new(0);
    let mut a = AuditToken([0; 8]); a.0[5] = 42; a.0[7] = 1;
    let mut b = a; b.0[7] = 2;
    let lookup = |_| { calls.fetch_add(1, Ordering::SeqCst); IdentityVerdict::Matches("DR".into()) };
    assert_eq!(cache.verify(None, lookup), IdentityVerdict::Unverifiable);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(cache.verify(Some(a), lookup), IdentityVerdict::Matches("DR".into()));
    assert_eq!(cache.verify(Some(a), lookup), IdentityVerdict::Matches("DR".into()));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(cache.verify(Some(b), lookup), IdentityVerdict::Matches("DR".into()));
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    cache.clear();
    cache.verify(Some(b), lookup);
    assert_eq!(calls.load(Ordering::SeqCst), 3);
}

#[test]
fn staging_and_verifier_share_requirement_text() {
    use crate::helper_identity::{helper_requirement, DEBUG_REQUIREMENT, RELEASE_REQUIREMENT};
    assert_eq!(helper_requirement(), if cfg!(debug_assertions) { DEBUG_REQUIREMENT } else { RELEASE_REQUIREMENT });
    assert!(include_str!("../../pty_host_client/bundle_staging.rs").contains("crate::helper_identity::helper_requirement()"));
    assert!(include_str!("host_identity.rs").contains("crate::helper_identity::helper_requirement()"));
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn real_process_code_identity_and_dead_instance() {
    use crate::helper_identity::{DEBUG_REQUIREMENT, RELEASE_REQUIREMENT};
    use std::process::Command;
    struct Temp(std::path::PathBuf);
    impl Temp { fn path(&self) -> &std::path::Path { &self.0 } }
    impl Drop for Temp { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
    let dir = Temp(std::env::temp_dir().join(format!("tf-identity-{}", uuid::Uuid::new_v4())));
    std::fs::create_dir(dir.path()).unwrap();
    let source = dir.path().join("sleep.c");
    let exe = dir.path().join("sleeper");
    std::fs::write(&source, r#"
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <string.h>
int main(int argc, char **argv) {
 int s=socket(AF_UNIX, SOCK_STREAM, 0); struct sockaddr_un a={0};
 a.sun_family=AF_UNIX; strcpy(a.sun_path, argv[1]);
 if(connect(s,(struct sockaddr*)&a,sizeof(a))) return 1;
 sleep(2); return 0;
}
"#).unwrap();
    assert!(Command::new("/usr/bin/cc").arg(&source).arg("-o").arg(&exe).status().unwrap().success());
    assert!(Command::new("/usr/bin/codesign").args(["--force", "-s", "-", "--identifier", "app.termflow.desktop.pty-host"]).arg(&exe).status().unwrap().success());
    let path = dir.path().join("sock");
    let listener = tokio::net::UnixListener::bind(&path).unwrap();
    let mut child = Command::new(&exe).arg(&path).spawn().unwrap();
    let (socket, _) = listener.accept().await.unwrap();
    let token = crate::pty_host_client::unix_peer_token(&socket).unwrap();
    assert_eq!(token.pid(), child.id());
    let first = macos::verify(token, DEBUG_REQUIREMENT);
    assert!(matches!(&first, IdentityVerdict::Matches(_)));
    assert_eq!(macos::verify(token, RELEASE_REQUIREMENT), IdentityVerdict::Different);
    // A second permitted same-identifier process with a distinct actual DR.
    let second_exe = dir.path().join("sleeper2");
    std::fs::copy(&exe, &second_exe).unwrap();
    let output = Command::new("/usr/bin/codesign").args(["-d", "--verbose=4"]).arg(&second_exe).output().unwrap();
    let details = String::from_utf8_lossy(&output.stderr);
    let hash = details.lines().find_map(|l| l.strip_prefix("CDHash=")).unwrap();
    let requirement = format!("=designated => identifier \"app.termflow.desktop.pty-host\" and cdhash H\"{hash}\"");
    assert!(Command::new("/usr/bin/codesign").args(["--force", "-s", "-", "--identifier", "app.termflow.desktop.pty-host", "-r", &requirement]).arg(&second_exe).status().unwrap().success());
    let mut second = Command::new(&second_exe).arg(&path).spawn().unwrap();
    let (second_socket, _) = listener.accept().await.unwrap();
    let second_token = crate::pty_host_client::unix_peer_token(&second_socket).unwrap();
    let other = macos::verify(second_token, DEBUG_REQUIREMENT);
    assert!(matches!(&other, IdentityVerdict::Matches(_)));
    assert_ne!(first, other);
    // Feed real verifier evidence into the subject resolver, not a fabricated Different verdict.
    super::super::tests::assert_different_dr(first, other).await;
    assert!(second.wait().unwrap().success());
    assert!(child.wait().unwrap().success());
    assert_eq!(macos::verify(token, DEBUG_REQUIREMENT), IdentityVerdict::Unverifiable);
}
