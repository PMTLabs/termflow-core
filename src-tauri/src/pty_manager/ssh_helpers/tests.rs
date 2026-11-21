use super::*;
use std::fs;
use std::sync::Barrier;

const CHILD_DATA: &str = "TERMFLOW_SSH_HELPER_TEST_DATA";

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        // Canonicalize only the test runner's temp parent (e.g. macOS /var -> /private/var).
        // Production never canonicalizes away an untrusted link component.
        let parent = fs::canonicalize(std::env::temp_dir()).unwrap();
        let path = parent.join(format!("tf-ssh-helpers-test-{}", Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn root(&self) -> HelperRoot {
        HelperRoot::open_app_data(&self.0).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        remove_test_tree(&self.0).expect("remove test-owned fixture only");
    }
}
fn owner() -> ProcessIdentity {
    ProcessIdentity::capture(std::process::id()).unwrap()
}
fn absent_owner() -> ProcessIdentity {
    ProcessIdentity {
        pid: u32::MAX,
        start_time: 1,
    }
}
fn payload(root: &HelperRoot) -> Helper {
    root.publish(
        owner(),
        HelperKind::AttemptPayload,
        "sh",
        b"fixed immutable payload\n",
    )
    .unwrap()
}
fn child(test: &str, app_data: &Path, hostile_temp: Option<&Path>) {
    let mut cmd = std::process::Command::new(std::env::current_exe().unwrap());
    cmd.args([
        "--exact",
        &format!("pty_manager::ssh_helpers::tests::{test}"),
        "--nocapture",
    ])
    .env(CHILD_DATA, app_data);
    if let Some(temp) = hostile_temp {
        cmd.env("TEMP", temp).env("TMP", temp).env("TMPDIR", temp);
    }
    let output = cmd
        .output()
        .expect("start filesystem test child, not the application");
    assert!(
        output.status.success(),
        "child failed: {} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("1 passed"),
        "child test must be reachable"
    );
}

#[cfg(unix)]
fn directory_link(target: &Path, link: &Path) {
    std::os::unix::fs::symlink(target, link).unwrap();
}
#[cfg(windows)]
fn directory_link(target: &Path, link: &Path) {
    // Directory junctions need no Developer Mode or symlink privilege. Failure is a setup
    // failure, never a skipped reparse-point oracle.
    let status = std::process::Command::new("cmd.exe")
        .args(["/D", "/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()
        .unwrap();
    assert!(
        status.status.success(),
        "junction setup failed: {} {}",
        String::from_utf8_lossy(&status.stdout),
        String::from_utf8_lossy(&status.stderr)
    );
}
#[cfg(unix)]
fn remove_directory_link(path: &Path) {
    fs::remove_file(path).unwrap();
}
#[cfg(windows)]
fn remove_directory_link(path: &Path) {
    fs::remove_dir(path).unwrap();
}

#[cfg(unix)]
fn unsafe_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o777)).unwrap();
}
#[cfg(windows)]
fn unsafe_permissions(path: &Path) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
    use windows_sys::Win32::Security::{
        SetFileSecurityW, DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
    };
    // Real on-disk ACL granting Everyone full control; owner is unchanged.
    let sddl: Vec<u16> = "D:P(A;;FA;;;WD)".encode_utf16().chain(Some(0)).collect();
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut sd = std::ptr::null_mut();
    unsafe {
        assert_ne!(
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut sd,
                std::ptr::null_mut()
            ),
            0
        );
        let result = SetFileSecurityW(
            path.as_ptr(),
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            sd,
        );
        windows_sys::Win32::Foundation::LocalFree(sd);
        assert_ne!(result, 0);
    }
}

#[test]
fn helper_root_rejects_links_reparse_and_foreign_permissions() {
    let _gate = crate::pty_host_client::test_dirs::child_process_gate();
    let f = Fixture::new();
    let safe = f.0.join("safe app data ü");
    fs::create_dir(&safe).unwrap();
    let root = HelperRoot::open_app_data(&safe).unwrap();
    let helper = payload(&root);
    helper.verify().unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(root.path()).unwrap().permissions().mode() & 0o7777,
            0o700
        );
        assert_eq!(
            fs::metadata(helper.path()).unwrap().permissions().mode() & 0o7777,
            0o600
        );
    }
    let root_path = root.path().to_path_buf();
    let helper_path = helper.path();
    drop(helper);
    drop(root);
    // Both directory and file admission independently reject foreign access.
    unsafe_permissions(&helper_path);
    let root = HelperRoot::open_app_data(&safe).unwrap();
    let entry = root
        .dir
        .child(
            helper_path
                .parent()
                .unwrap()
                .file_name()
                .unwrap()
                .to_str()
                .unwrap(),
            false,
        )
        .unwrap();
    assert!(
        entry.read_file("helper.sh").is_err(),
        "foreign-accessible payload was admitted"
    );
    drop(entry);
    drop(root);
    unsafe_permissions(&root_path);
    assert!(
        HelperRoot::open_app_data(&safe).is_err(),
        "unsafe mode/DACL was repaired or accepted"
    );

    let other = f.0.join("outside");
    fs::create_dir(&other).unwrap();
    let linked_parent = f.0.join("linked-parent");
    directory_link(&other, &linked_parent);
    assert!(HelperRoot::open_app_data(&linked_parent.join("nested")).is_err());
    assert!(
        !other.join("nested").exists(),
        "followed an ancestor link before rejection"
    );
    remove_directory_link(&linked_parent);
    let linked_root_parent = f.0.join("linked-root-parent");
    fs::create_dir(&linked_root_parent).unwrap();
    let linked_root = linked_root_parent.join(FEATURE);
    directory_link(&other, &linked_root);
    assert!(HelperRoot::open_app_data(&linked_root_parent).is_err());
    assert_eq!(fs::read_dir(&other).unwrap().count(), 0);
    remove_directory_link(&linked_root);
    assert!(HelperRoot::open_app_data(Path::new("relative-app-data")).is_err());
}

#[test]
fn hostile_temp_cannot_replace_immutable_attempt_helper() {
    let _gate = crate::pty_host_client::test_dirs::child_process_gate();
    if let Some(data) = std::env::var_os(CHILD_DATA) {
        let root = HelperRoot::open_app_data(Path::new(&data)).unwrap();
        let helper = payload(&root);
        assert!(helper.path().starts_with(Path::new(&data)));
        assert!(!helper.path().starts_with(std::env::temp_dir()));
        helper.verify().unwrap();
        fs::write(
            Path::new(&data).join("child-helper-path"),
            helper.path().to_str().unwrap(),
        )
        .unwrap();
        return;
    }
    let f = Fixture::new();
    let app_data = f.0.join("real app data ü");
    let hostile = f.0.join("hostile-temp");
    fs::create_dir(&hostile).unwrap();
    fs::write(hostile.join("helper.sh"), b"hostile replacement").unwrap();
    child(
        "hostile_temp_cannot_replace_immutable_attempt_helper",
        &app_data,
        Some(&hostile),
    );
    let child_path = fs::read_to_string(app_data.join("child-helper-path")).unwrap();
    assert_eq!(fs::read(child_path).unwrap(), b"fixed immutable payload\n");
    assert_eq!(
        fs::read(hostile.join("helper.sh")).unwrap(),
        b"hostile replacement"
    );

    let root = f.root();
    let id = Uuid::new_v4();
    let helper = root
        .publish_id(
            id,
            owner(),
            HelperKind::AttemptPayload,
            "sh",
            b"original bytes",
        )
        .unwrap();
    assert!(root
        .publish_id(
            id,
            owner(),
            HelperKind::AttemptPayload,
            "sh",
            b"replacement"
        )
        .is_err());
    let entry = root.dir.child(&id.to_string(), false).unwrap();
    assert!(entry
        .publish_file("helper.sh", b"replacement via atomic publisher")
        .is_err());
    assert_eq!(entry.read_file("helper.sh").unwrap(), b"original bytes");
    helper.verify().unwrap();
    assert!(root
        .publish(owner(), HelperKind::AttemptPayload, "../sh", b"bad")
        .is_err());
    assert!(root
        .publish(
            owner(),
            HelperKind::AttemptPayload,
            "sh",
            &vec![0; MAX_FILE as usize + 1]
        )
        .is_err());
    let successor = payload(&root);
    assert_ne!(helper.path(), successor.path());
    drop(entry);
    // A hardlink replacement is refused too, not just symlinks/reparse directories.
    let outside = f.0.join("user-file");
    fs::write(&outside, b"user bytes must survive").unwrap();
    // The entry is sealed read-only; a same-user attacker can simply unseal it.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(helper.path().parent().unwrap(), fs::Permissions::from_mode(0o700)).unwrap();
    }
    fs::remove_file(helper.path()).unwrap();
    fs::hard_link(&outside, helper.path()).unwrap();
    assert!(helper.verify().is_err());
    assert!(helper.cancel_attempt().is_err());
    assert_eq!(fs::read(&outside).unwrap(), b"user bytes must survive");
}

#[test]
fn helper_exclusive_publish_and_safe_sweep() {
    let _gate = crate::pty_host_client::test_dirs::child_process_gate();
    if let Some(data) = std::env::var_os(CHILD_DATA) {
        let root = HelperRoot::open_app_data(Path::new(&data)).unwrap();
        root.publish(owner(), HelperKind::ShellHook, "sh", b"dead shell hook")
            .unwrap();
        root.publish(
            owner(),
            HelperKind::AttemptPayload,
            "json",
            b"abandoned payload",
        )
        .unwrap();
        let in_flight = payload(&root);
        let lease = in_flight.acquire().unwrap();
        // Simulate abrupt process loss without running a TermFlow instance or killing anything.
        // Returning ends this isolated test process; OS closes handles, persistent marker stays.
        std::mem::forget(lease);
        return;
    }
    let f = Fixture::new();
    let root = f.root();
    let id = Uuid::new_v4();
    let barrier = Arc::new(Barrier::new(3));
    let process = owner();
    let workers: Vec<_> = [b"first".to_vec(), b"second".to_vec()]
        .into_iter()
        .map(|content| {
            let barrier = barrier.clone();
            let data = f.0.clone();
            let process = process.clone();
            std::thread::spawn(move || {
                let independent_root = HelperRoot::open_app_data(&data).unwrap();
                barrier.wait();
                independent_root.publish_id(
                    id,
                    process,
                    HelperKind::AttemptPayload,
                    "json",
                    &content,
                )
            })
        })
        .collect();
    barrier.wait();
    let results: Vec<_> = workers.into_iter().map(|w| w.join().unwrap()).collect();
    assert_eq!(
        results.iter().filter(|r| r.is_ok()).count(),
        1,
        "exclusive reservation must have one winner"
    );
    let winner = results.into_iter().find_map(Result::ok).unwrap();
    winner.verify().unwrap();
    let bytes = fs::read(winner.path()).unwrap();
    assert!(bytes == b"first" || bytes == b"second");
    assert_eq!(
        root.dir.names().unwrap().len(),
        2,
        "one entry and root lock; no staging leaks"
    );
    let live_path = winner.path();
    let crash_data = f.0.join("crash-data");
    child("helper_exclusive_publish_and_safe_sweep", &crash_data, None);
    let recovered = HelperRoot::open_app_data(&crash_data).unwrap();
    assert_eq!(recovered.dir.names().unwrap().len(), 4);
    assert_eq!(
        recovered.sweep_abandoned().unwrap(),
        2,
        "dead hook + quiescent abandoned payload only"
    );
    assert_eq!(
        recovered.dir.names().unwrap().len(),
        2,
        "in-flight payload retained after crash"
    );
    assert_eq!(
        recovered.sweep_abandoned().unwrap(),
        0,
        "repeated sweep is safe"
    );
    assert_eq!(
        root.sweep_abandoned().unwrap(),
        0,
        "a live shell is not abandoned"
    );
    assert_eq!(fs::read(&live_path).unwrap(), bytes);

    let unknown_id = Uuid::new_v4();
    let unknown = root.dir.create_child(&unknown_id.to_string()).unwrap();
    unknown.publish_file("user.txt", b"user data").unwrap();
    let corrupt = root
        .publish(
            absent_owner(),
            HelperKind::AttemptPayload,
            "sh",
            b"original",
        )
        .unwrap();
    fs::write(corrupt.path(), b"modified content").unwrap();
    let mismatched = root
        .publish(absent_owner(), HelperKind::ShellHook, "sh", b"fixed")
        .unwrap();
    let bad_dir = root.dir.child(&mismatched.inner.name, false).unwrap();
    let mut bad_manifest = mismatched.inner.manifest.clone();
    bad_manifest.feature = "not-this-feature".into();
    fs::write(
        bad_dir.path().join(MANIFEST),
        serde_json::to_vec(&bad_manifest).unwrap(),
    )
    .unwrap();
    let outside = f.0.join("outside-for-sweep");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("user.txt"), b"outside data").unwrap();
    let linked = root.path().join(Uuid::new_v4().to_string());
    directory_link(&outside, &linked);
    assert_eq!(root.sweep_abandoned().unwrap(), 0);
    assert_eq!(unknown.read_file("user.txt").unwrap(), b"user data");
    assert_eq!(fs::read(corrupt.path()).unwrap(), b"modified content");
    assert_eq!(fs::read(outside.join("user.txt")).unwrap(), b"outside data");
    remove_directory_link(&linked);
    assert!(mismatched.path().exists());
    assert!(root.path().join(unknown_id.to_string()).exists());
}

#[test]
fn cancel_reconnect_retains_hooks_retires_only_quiescent_payloads() {
    let f = Fixture::new();
    let root = f.root();
    let hook = root
        .publish(
            owner(),
            HelperKind::ShellHook,
            "sh",
            b"persistent prompt hook",
        )
        .unwrap();
    let first = payload(&root);
    let use_a = first.acquire().unwrap();
    let use_b = first.acquire().unwrap();
    assert_eq!(use_a.path(), first.path());
    assert!(
        !hook.cancel_attempt().unwrap(),
        "Cancel cannot retire a shell-lifetime hook"
    );
    assert!(
        !hook.retire_after_process_end().unwrap(),
        "live shell is not ended"
    );
    assert!(
        !first.cancel_attempt().unwrap(),
        "in-flight payload is not quiescent"
    );
    assert!(
        first.acquire().is_err(),
        "retired payload cannot be reacquired"
    );
    let next = payload(&root);
    assert_ne!(
        next.path(),
        first.path(),
        "Reconnect must use a fresh immutable entry"
    );
    assert!(first.path().exists());
    assert_eq!(fs::read(hook.path()).unwrap(), b"persistent prompt hook");
    use_a.finish().unwrap();
    assert!(
        first.path().exists(),
        "another reader is still using the payload"
    );
    use_b.finish().unwrap();
    assert!(
        !first.path().exists(),
        "last quiescent execution retires cancelled payload"
    );
    assert!(
        next.path().exists(),
        "old cancellation cannot retire the successor"
    );
    assert!(next.cancel_attempt().unwrap());
    assert!(!next.path().exists());
    let uncertain = payload(&root);
    let abandoned_lease = uncertain.acquire().unwrap();
    drop(abandoned_lease); // A dropped future is not execution-completion evidence.
    assert!(!uncertain.cancel_attempt().unwrap());
    assert!(uncertain.path().exists());
    assert_eq!(root.sweep_abandoned().unwrap(), 0);
    assert!(uncertain.path().exists());
    assert!(hook.path().exists());
    hook.verify().unwrap();
    let ended_hook = root
        .publish(absent_owner(), HelperKind::ShellHook, "sh", b"ended hook")
        .unwrap();
    assert!(ended_hook.retire_after_process_end().unwrap());
    assert!(!ended_hook.path().exists());
    assert!(hook.path().exists());
}

/// A hook directory doubles as a shell's ZDOTDIR/HOME. Ubuntu's global zshrc runs
/// compinit there, and its `.zcompdump` used to make the entry untrusted to retire.
#[cfg(unix)]
#[test]
fn published_entries_are_sealed_against_shell_writes_and_still_retire() {
    let f = Fixture::new();
    let root = f.root();
    for name in [".zshrc", ".bash_profile"] {
        let hook = root.publish(owner(), HelperKind::ShellHook, name, b"hook\n").unwrap();
        let usage = hook.acquire().unwrap();
        let dir = hook.path().parent().unwrap().to_path_buf();
        assert!(fs::write(dir.join(".zcompdump"), b"dump").is_err(), "{name}: entry accepted a foreign file");
        hook.verify().unwrap();
        assert!(!usage.finish().unwrap());
        assert!(hook.retire_quiescent_shell_hook().unwrap());
        assert!(!dir.exists());
    }
}
