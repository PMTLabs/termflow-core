use super::{record_dir_for, runtime_host_dir};
use crate::profile::{Integrity, ProfileIdentity};
use std::path::Path;

fn id(name: &str, integrity: Integrity) -> ProfileIdentity {
    ProfileIdentity { channel: "rel", name: name.into(), integrity }
}

#[test]
fn the_default_identity_keeps_todays_pipe_and_record() {
    // Renaming either would orphan shells surviving from a previous build.
    let default = id("default", Integrity::Medium);
    assert!(record_dir_for(Path::new("base"), &default)
        .ends_with(Path::new("host").join("rel")));
    #[cfg(windows)]
    assert_eq!(
        super::pipe_for("TESTUSER", &default),
        r"\\.\pipe\termflow-pty-host.TESTUSER.rel"
    );
}

#[test]
fn each_identity_gets_its_own_pipe_and_its_own_record_dir() {
    let a = id("work", Integrity::Medium);
    let b = id("work", Integrity::High);
    let c = id("default", Integrity::Medium);
    // The rev-1 bug: the pipe was scoped but the record was not, and
    // ensure_pty_host_inner SUBSTITUTES the record's endpoint for the
    // computed pipe (state.rs:712-729) -- so scoping the pipe alone did
    // nothing at all.
    let dir = |i| record_dir_for(Path::new("base"), i);
    assert_ne!(dir(&a), dir(&b));
    assert_ne!(dir(&a), dir(&c));
    assert_ne!(dir(&b), dir(&c));
    #[cfg(windows)]
    {
        assert_ne!(super::pipe_for("u", &a), super::pipe_for("u", &b));
        assert_ne!(super::pipe_for("u", &a), super::pipe_for("u", &c));
    }
}

/// C1 regression guard: the host runtime dir must NEVER live under the
/// Velopack install root (`…\TermFlow\`), or Update.exe kills the armed
/// host during an update and Setup.exe can't rename the root.
#[test]
fn host_dir_is_outside_the_velopack_install_root() {
    let dir = runtime_host_dir().expect("runtime dir resolves in test env");
    let s = dir.to_string_lossy().replace('/', "\\");
    assert!(
        s.contains("app.termflow.desktop"),
        "host dir should be keyed by app identifier: {s}"
    );
    assert!(
        !s.contains("\\TermFlow\\host"),
        "host dir must not be inside the Velopack root: {s}"
    );
}
