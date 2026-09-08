use super::{install_host_into, host_binary_name};

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
