use super::{record_dir_for, runtime_host_dir};
use super::endpoints::{qualified_pipe_for, qualified_socket_for, host_file_for, named_generation};
use crate::profile::{Integrity, ProfileIdentity};
use std::path::Path;

const GEN_A: &str = "12345678aaaaaaaa";
const GEN_B: &str = "12345678bbbbbbbb";

#[test]
fn launch_generation_is_install_directory_identity_and_fallback_has_none() {
    let dir = super::test_dirs::tempdir().unwrap();
    let source = dir.path().join("bundled");
    std::fs::write(&source, b"host bytes").unwrap();
    let base = dir.path().join("runtime");
    let installed = super::resolve_launch_from(source.clone(), Some(&base));
    assert!(installed.path.starts_with(&base));
    assert_eq!(installed.generation.as_deref(), installed.path.parent().unwrap().file_name().unwrap().to_str());
    assert_eq!(installed.build_id, Some(super::hex_full(&super::sha256_file(&source).unwrap())));
    for base in [None, Some(source.as_path())] {
        let fallback = super::resolve_launch_from(source.clone(), base);
        assert_eq!(fallback.path, source);
        assert_eq!(fallback.generation, None);
        assert_eq!(fallback.build_id, installed.build_id);
    }
}

/// Off Windows no ConPTY pair ships, so the install directory is named by the host file's
/// digest alone and a host's advertised build id names its generation. If the install key
/// ever starts to include anything else there, this stops being true and the marker would
/// mis-judge every adopted host.
#[cfg(not(windows))]
#[test]
fn off_windows_the_generation_is_the_first_sixteen_digits_of_the_build_id() {
    let dir = super::test_dirs::tempdir().unwrap();
    let source = dir.path().join("bundled");
    std::fs::write(&source, b"host bytes").unwrap();
    let installed = super::resolve_launch_from(source, Some(&dir.path().join("runtime")));
    let build_id = installed.build_id.expect("a build id");
    assert_eq!(installed.generation.as_deref(), build_id.get(..16));
    assert_eq!(super::exe_origin::generation_of_build_id(&build_id), installed.generation);
}

#[test]
fn qualified_endpoints_distinct_per_generation() {
    let profile = id("work", Integrity::Medium);
    assert_ne!(qualified_pipe_for("u", &profile, Some(GEN_A)), qualified_pipe_for("u", &profile, Some(GEN_B)));
    assert_ne!(qualified_socket_for("/run/user/1", &profile, Some(GEN_A), 1), qualified_socket_for("/run/user/1", &profile, Some(GEN_B), 1));
    for name in ["host-record.json", "host.log"] {
        assert_eq!(host_file_for(Path::new("base"), Some(GEN_A), name), Path::new("base").join(GEN_A).join(name));
        assert_ne!(host_file_for(Path::new("base"), Some(GEN_A), name), host_file_for(Path::new("base"), Some(GEN_B), name));
    }
}

#[test]
fn two_profiles_sharing_a_prefix_get_distinct_sockets() {
    let a = id("abcdefghijklmnopqrstuvwxyz12345a", Integrity::Medium);
    let b = id("abcdefghijklmnopqrstuvwxyz12345b", Integrity::Medium);
    let a_socket = qualified_socket_for(&"x".repeat(200), &a, Some(GEN_A), 1234);
    let b_socket = qualified_socket_for(&"x".repeat(200), &b, Some(GEN_A), 1234);
    assert_ne!(a_socket, b_socket);
    assert!(a_socket.contains(&a.key()));
    assert!(b_socket.contains(&b.key()));
}

#[test]
fn socket_path_bytes_le_103() {
    let profile = id(&"a".repeat(32), Integrity::High);
    for dir in ["/tmp".to_string(), format!("/tmp/{}", "x".repeat(200)), format!("/tmp/{}", "é".repeat(40))] {
        let socket = qualified_socket_for(&dir, &profile, Some(GEN_A), 4294967295);
        assert!(socket.len() + 1 <= 103, "{socket}");
        assert!(socket.contains(&profile.key()));
        assert!(socket.ends_with(&format!(".{GEN_A}.sock")));
        if dir != "/tmp" { assert!(socket.starts_with("/tmp/tf-4294967295/")); }
    }
    let profile = id("default", Integrity::Medium);
    let name = format!("tfh.{}.{GEN_A}.sock", profile.key());
    let dir = format!("/{}", "x".repeat(100 - name.len()));
    assert_eq!(qualified_socket_for(&dir, &profile, Some(GEN_A), 1).len() + 1, 103);
    assert!(qualified_socket_for(&(dir + "x"), &profile, Some(GEN_A), 1).starts_with("/tmp/tf-1/"));
}

#[test]
fn gate_off_equals_legacy_naming() {
    for profile in [id("default", Integrity::Medium), id("work", Integrity::High)] {
        for generation in [None, Some(GEN_A)] {
            let g = named_generation(generation, false);
            assert_eq!(qualified_pipe_for("u", &profile, g), format!(r"\\.\pipe\termflow-pty-host.u.{}", profile.key()));
            assert_eq!(qualified_socket_for("/very/long/runtime", &profile, g, 1), format!("/very/long/runtime/termflow-pty-host.{}.sock", profile.key()));
            assert_eq!(host_file_for(Path::new("base"), g, "host-record.json"), Path::new("base/host-record.json"));
            assert_eq!(host_file_for(Path::new("base"), g, "host.log"), Path::new("base/host.log"));
        }
    }
    assert_eq!(named_generation(None, true), None);
    assert_eq!(named_generation(Some(GEN_A), true), Some(GEN_A));
}

#[cfg(unix)]
#[test]
fn short_dir_rejects_symlink_and_wrong_owner() {
    use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
    let tmp = super::test_dirs::tempdir().unwrap();
    let real = tmp.path().join("real");
    std::fs::create_dir(&real).unwrap();
    let link = tmp.path().join("link");
    symlink(&real, &link).unwrap();
    assert_eq!(super::endpoints::ensure_socket_parent(link.join("host.sock").to_str().unwrap()).unwrap_err().kind(), std::io::ErrorKind::PermissionDenied);
    let meta = std::fs::symlink_metadata(&real).unwrap();
    assert_eq!(super::endpoints::validate_socket_dir(&meta, meta.uid().wrapping_add(1)).unwrap_err().kind(), std::io::ErrorKind::PermissionDenied);
    super::endpoints::ensure_socket_parent(real.join("host.sock").to_str().unwrap()).unwrap();
    assert_eq!(std::fs::metadata(&real).unwrap().permissions().mode() & 0o777, 0o700);
}

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
