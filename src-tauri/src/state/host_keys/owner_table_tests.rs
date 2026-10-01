use super::*;
use std::sync::atomic::AtomicUsize;
use std::time::Duration;

fn admit(keys: &HostKeys, leaf: &str) -> u64 {
    match keys.admit_create(leaf, CreateMode::Mount).unwrap() {
        CreateAdmission::Run(cg) => cg,
        _ => panic!("new admission expected"),
    }
}

#[test]
fn exhausted_admission_sequence_changes_no_owner_or_key() {
    let keys = HostKeys::default();
    let cg = admit(&keys, "tm-control");
    keys.stage_shell("tm-control", cg, "pc-control", None).unwrap();
    let control = StagedShell { process: "pc-control".into(), stage: ShellStage::Local };
    assert!(matches!(keys.complete_shell("tm-control", cg, &control), Completion::Registered));
    keys.lock().sequence = u64::MAX;
    assert!(keys.admit_create("tm-refused", CreateMode::Mount).is_err());
    assert!(keys.owner_state("tm-refused").is_none());
    assert_eq!(keys.resolve_process("pc-control", false), Some("pc-control".into()));
    assert!(matches!(keys.admit_create("tm-control", CreateMode::Mount).unwrap(), CreateAdmission::Existing(pc) if pc == "pc-control"));
    assert_eq!(keys.len(), 0);
}

#[test]
fn stale_host_completion_releases_only_its_generation_and_failed_attach_owns_no_close() {
    for mode in [StageMode::Spawn, StageMode::Attach] {
        let keys = HostKeys::default();
        if mode == StageMode::Attach {
            keys.listing(HostChannel::Primary, &SessionListing { request_no: 1, sessions: vec![termflow_pty_protocol::SessionMeta {
                tab_id: "legacy".into(), pid: 17, head_offset: 0, tail_offset: 0, alive: true,
            }] }, |_| false);
        }
        let cg = admit(&keys, "tm-leaf");
        let (stage, pid, _) = keys.stage_shell("tm-leaf", cg, "pc-old", Some((HostChannel::Primary, "legacy", mode))).unwrap();
        assert_eq!(pid, if mode == StageMode::Attach { 17 } else { 0 });
        let stage = stage.unwrap();
        assert_eq!(stage.cg, cg);
        assert!(!keys.publish(&stage, "pc-wrong", 1));
        assert!(!keys.complete(&stage, "pc-old"));
        keys.abort(&stage);
        keys.exit_process("pc-old");
        assert_eq!(keys.state(HostChannel::Primary, "legacy"), Some(KeyState::Held(cg)));
        assert!(matches!(keys.owner_state("tm-leaf"), Some((_, OwnerState::Placing { .. }))));
        assert!(keys.publish(&stage, "pc-old", 1));
        let old = keys.abort_create("tm-leaf", cg).unwrap();
        assert_eq!(old.process, "pc-old");
        let newer = admit(&keys, "tm-leaf");
        let (next, _, _) = keys.stage_shell("tm-leaf", newer, "pc-new", Some((HostChannel::Primary, "new-key", StageMode::Spawn))).unwrap();
        let next = next.unwrap();
        assert!(newer > cg);
        assert!(matches!(keys.complete_shell("tm-leaf", cg, &old), Completion::Stale));
        assert_eq!(keys.state(HostChannel::Primary, "new-key"), Some(KeyState::Held(newer)));
        assert_eq!(keys.owner_state("tm-leaf").unwrap().0, newer);
        assert!(keys.publish(&next, "pc-new", 1));
        let new = StagedShell { process: "pc-new".into(), stage: ShellStage::Hosted(next) };
        assert!(matches!(keys.complete_shell("tm-leaf", newer, &new), Completion::Registered));
        assert_eq!(keys.resolve_process("pc-new", false), Some("pc-new".into()));
        match mode {
            StageMode::Spawn => assert!(matches!(keys.state(HostChannel::Primary, "legacy"), Some(KeyState::Ending { close: CloseState::Pending, .. }))),
            StageMode::Attach => assert_eq!(keys.state(HostChannel::Primary, "legacy"), Some(KeyState::Listed)),
        }
    }
}

#[test]
fn concurrent_duplicate_endings_persist_once_and_keep_the_row_until_storage_finishes() {
    let keys = HostKeys::default();
    let cg = admit(&keys, "tm-leaf");
    keys.stage_shell("tm-leaf", cg, "pc-shell", None).unwrap();
    keys.complete_shell("tm-leaf", cg, &StagedShell { process: "pc-shell".into(), stage: ShellStage::Local });
    assert!(keys.note_exit("pc-shell"));
    let persisted = Arc::new(AtomicUsize::new(0));
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let first = std::thread::spawn({ let keys = keys.clone(); let persisted = persisted.clone(); move || {
        keys.end_process("pc-shell", EndKind::Exit, |leaf| {
            assert_eq!(leaf, "tm-leaf");
            persisted.fetch_add(1, Ordering::SeqCst);
            entered_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        }).is_some()
    }});
    entered_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(persisted.load(Ordering::SeqCst), 1);
    assert_eq!(keys.resolve_process("pc-shell", false), Some("pc-shell".into()));
    assert!(matches!(keys.admit_create("tm-leaf", CreateMode::Mount).unwrap(), CreateAdmission::Existing(pc) if pc == "pc-shell"));
    let (arrived_tx, arrived_rx) = std::sync::mpsc::channel();
    let duplicate = std::thread::spawn({ let keys = keys.clone(); let persisted = persisted.clone(); move || {
        arrived_tx.send(()).unwrap();
        keys.end_process("pc-shell", EndKind::Exit, |_| { persisted.fetch_add(1, Ordering::SeqCst); }).is_some()
    }});
    arrived_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(persisted.load(Ordering::SeqCst), 1);
    release_tx.send(()).unwrap();
    assert!(first.join().unwrap());
    assert!(!duplicate.join().unwrap());
    assert_eq!(persisted.load(Ordering::SeqCst), 1);
    assert!(keys.owner_state("tm-leaf").is_none());
    assert!(admit(&keys, "tm-leaf") > cg);
}
