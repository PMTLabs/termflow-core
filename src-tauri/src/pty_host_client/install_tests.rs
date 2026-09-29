use super::{host_binary_name, install_host_into};
#[cfg(windows)]
use super::{install_host_with_conpty, CONPTY_FILES};

fn scratch() -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("tfhost-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn install_copies_verifies_and_is_idempotent() {
    let root = scratch();
    let src = root.join("bundled-host.bin");
    std::fs::write(&src, b"host-bytes-v1").unwrap();
    let base = root.join("runtime");

    let a = install_host_into(&src, &base).unwrap();
    assert!(a.exists(), "installed host should exist");
    assert_eq!(a.file_name().unwrap().to_str().unwrap(), host_binary_name());
    assert_eq!(std::fs::read(&a).unwrap(), b"host-bytes-v1", "content copied intact");

    // Second call with identical source: same path, no re-copy, no error.
    let b = install_host_into(&src, &base).unwrap();
    assert_eq!(a, b, "install is idempotent for identical content");

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn different_content_installs_to_a_different_hash_dir() {
    let root = scratch();
    let base = root.join("runtime");
    let s1 = root.join("h1");
    std::fs::write(&s1, b"version-one").unwrap();
    let s2 = root.join("h2");
    std::fs::write(&s2, b"version-two-different").unwrap();

    let p1 = install_host_into(&s1, &base).unwrap();
    let p2 = install_host_into(&s2, &base).unwrap();
    assert_ne!(
        p1.parent().unwrap(),
        p2.parent().unwrap(),
        "different content must install under a different hash dir"
    );

    let _ = std::fs::remove_dir_all(&root);
}

#[cfg(windows)]
fn fake_pair(dir: &std::path::Path, tag: &[u8]) {
    std::fs::create_dir_all(dir).unwrap();
    for f in CONPTY_FILES {
        std::fs::write(dir.join(f), [tag, f.as_bytes()].concat()).unwrap();
    }
}

#[cfg(windows)]
#[test]
fn conpty_pair_stages_into_a_subfolder_not_beside_the_host() {
    let root = scratch();
    let host = root.join("h");
    std::fs::write(&host, b"host").unwrap();
    let pair = root.join("pair");
    fake_pair(&pair, b"v1");
    let base = root.join("runtime");

    let dest = install_host_with_conpty(&host, &base, Some(&pair)).unwrap();
    let dir = dest.parent().unwrap();
    for f in CONPTY_FILES {
        assert!(dir.join("conpty").join(f).is_file(), "{f} staged under conpty/");
        assert!(!dir.join(f).exists(), "{f} must NOT sit beside the exe (defeats rollback)");
    }
    let leftovers = std::fs::read_dir(dir).unwrap().flatten()
        .filter(|e| e.file_name().to_string_lossy().contains(".staging-")).count();
    assert_eq!(leftovers, 0, "no staging dir left behind");

    // Idempotent; and a damaged pair is repaired.
    std::fs::write(dir.join("conpty").join(CONPTY_FILES[0]), b"tampered").unwrap();
    let again = install_host_with_conpty(&host, &base, Some(&pair)).unwrap();
    assert_eq!(dest, again);
    assert_eq!(
        std::fs::read(dir.join("conpty").join(CONPTY_FILES[0])).unwrap(),
        [b"v1".as_slice(), CONPTY_FILES[0].as_bytes()].concat(),
        "tampered staged file is restored"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[cfg(windows)]
#[test]
fn changing_only_the_conpty_pair_installs_to_a_new_dir() {
    let root = scratch();
    let host = root.join("h");
    std::fs::write(&host, b"host").unwrap();
    let (p1, p2) = (root.join("p1"), root.join("p2"));
    fake_pair(&p1, b"v1");
    fake_pair(&p2, b"v2");
    let base = root.join("runtime");

    let a = install_host_with_conpty(&host, &base, Some(&p1)).unwrap();
    let b = install_host_with_conpty(&host, &base, Some(&p2)).unwrap();
    let none = install_host_with_conpty(&host, &base, None).unwrap();
    assert_ne!(a.parent(), b.parent(), "ConPTY bump must not reuse the old dir");
    assert_ne!(a.parent(), none.parent());
    assert!(!none.parent().unwrap().join("conpty").exists(), "no pair, no subfolder");
    let _ = std::fs::remove_dir_all(&root);
}
