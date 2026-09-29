use super::{host_binary_name, install_host_into};
#[cfg(windows)]
use super::{install_host_with_conpty, stage_conpty_into, CONPTY_FILES};

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
        assert!(!dir.join(f).exists(), "{f} must NOT sit beside the exe (defeats rollback)");
        assert_eq!(
            std::fs::read(dir.join("conpty").join(f)).unwrap(),
            std::fs::read(pair.join(f)).unwrap(),
            "{f} staged byte-for-byte"
        );
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
    // Changing ONLY one file of the pair must also change the key (each file).
    for (i, f) in CONPTY_FILES.iter().enumerate() {
        let p = root.join(format!("only-{i}"));
        fake_pair(&p, b"v1");
        std::fs::write(p.join(f), b"different").unwrap();
        let c = install_host_with_conpty(&host, &base, Some(&p)).unwrap();
        assert_ne!(a.parent(), c.parent(), "changing only {f} must not reuse the dir");
    }
    let none = install_host_with_conpty(&host, &base, None).unwrap();
    assert_ne!(a.parent(), b.parent(), "ConPTY bump must not reuse the old dir");
    assert_ne!(a.parent(), none.parent());
    assert!(!none.parent().unwrap().join("conpty").exists(), "no pair, no subfolder");
    let _ = std::fs::remove_dir_all(&root);
}

#[cfg(windows)]
#[test]
fn concurrent_stagers_all_succeed_and_leave_one_intact_pair() {
    let root = scratch();
    let pair = root.join("pair");
    fake_pair(&pair, b"v1");
    let dir = root.join("dir");
    std::fs::create_dir_all(&dir).unwrap();
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let (d, p) = (dir.clone(), pair.clone());
            std::thread::spawn(move || stage_conpty_into(&d, &p))
        })
        .collect();
    for h in handles {
        h.join().unwrap().expect("every racing stager must succeed");
    }
    for f in CONPTY_FILES {
        assert_eq!(
            std::fs::read(dir.join("conpty").join(f)).unwrap(),
            std::fs::read(pair.join(f)).unwrap()
        );
    }
    let names: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(names, vec!["conpty".to_string()], "no staging/stale leftovers: {names:?}");
    let _ = std::fs::remove_dir_all(&root);
}

/// A damaged published pair that a running host holds open must be left alone
/// (not half-deleted): repair fails, the directory stays, and no error is hidden.
#[cfg(windows)]
#[test]
fn repair_never_deletes_a_pair_that_is_in_use() {
    use std::os::windows::fs::OpenOptionsExt;
    let root = scratch();
    let pair = root.join("pair");
    fake_pair(&pair, b"v1");
    let dir = root.join("dir");
    std::fs::create_dir_all(&dir).unwrap();
    stage_conpty_into(&dir, &pair).unwrap();
    let live = dir.join("conpty").join(CONPTY_FILES[0]);
    // Hold the DLL open the way a loaded module is held (deny write/delete).
    let _held = std::fs::OpenOptions::new().read(true).share_mode(1).open(&live).unwrap();
    // Damage the OTHER file, so the pair is no longer intact.
    std::fs::write(dir.join("conpty").join(CONPTY_FILES[1]), b"damaged").unwrap();

    assert!(stage_conpty_into(&dir, &pair).is_err(), "repair of an in-use pair must fail loudly");
    assert!(live.is_file(), "in-use DLL must still be there");
    assert!(dir.join("conpty").join(CONPTY_FILES[1]).is_file(), "published dir left in place");
    let _ = std::fs::remove_dir_all(&root);
}
