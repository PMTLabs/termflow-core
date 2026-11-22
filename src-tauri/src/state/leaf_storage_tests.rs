use super::{HostKeys, CreateAdmission, CreateMode, StagedShell, ShellStage, EndKind, CloseStorage, Completion};
use super::leaf_storage::{with_leaves, with_all, stripe_index};
use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
use std::time::Duration;

fn register(keys: &HostKeys, leaf: &str, pc: &str) {
    let CreateAdmission::Run(cg) = keys.admit_create(leaf, CreateMode::Mount).unwrap() else { panic!("new admission") };
    keys.stage_shell(leaf, cg, pc, None).unwrap();
    assert!(matches!(keys.complete_shell(leaf, cg, &StagedShell { process: pc.into(), stage: ShellStage::Local }), Completion::Registered));
}

#[test]
fn only_the_exact_registered_shell_can_write_and_nested_sections_fail_without_deadlock() {
    let keys = HostKeys::default();
    let leaf = "tm-storage-states";
    let ran = AtomicUsize::new(0);
    assert!(keys.write_shells(&[], || ran.fetch_add(1, Ordering::SeqCst)).is_none());
    assert!(keys.write(leaf, "pc-P", || ran.fetch_add(1, Ordering::SeqCst)).is_none());
    let CreateAdmission::Run(cg) = keys.admit_create(leaf, CreateMode::Mount).unwrap() else { panic!("admission") };
    keys.stage_shell(leaf, cg, "pc-P", None).unwrap();
    assert!(keys.write(leaf, "pc-P", || ran.fetch_add(1, Ordering::SeqCst)).is_none());
    assert!(matches!(keys.complete_shell(leaf, cg, &StagedShell { process: "pc-P".into(), stage: ShellStage::Local }), Completion::Registered));
    assert_eq!(keys.write(leaf, "pc-P", || ran.fetch_add(1, Ordering::SeqCst)), Some(0));
    assert!(keys.write(leaf, "pc-other", || ran.fetch_add(1, Ordering::SeqCst)).is_none());
    assert_eq!(ran.load(Ordering::SeqCst), 1);
    for nested_end in [false, true] {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            keys.write(leaf, "pc-P", || {
                if nested_end { keys.end_process("pc-P", EndKind::Exit, |_| {}); }
                else { keys.write(leaf, "pc-P", || {}); }
            });
        }));
        assert!(result.is_err(), "a nested section must fail before blocking");
        // Unwind resets the section marker and recovers this stripe's poison.
        assert_eq!(keys.write(leaf, "pc-P", || ran.fetch_add(1, Ordering::SeqCst)), Some(if nested_end { 2 } else { 1 }));
    }
    keys.close_process("pc-P", CloseStorage::Delete);
    assert!(keys.write(leaf, "pc-P", || ran.fetch_add(1, Ordering::SeqCst)).is_none());
    assert_eq!(ran.load(Ordering::SeqCst), 3);
    assert!(keys.end_process("pc-P", EndKind::Close(CloseStorage::Delete), |_| {}).is_some());
    register(&keys, leaf, "pc-Q");
    assert!(keys.write(leaf, "pc-P", || ran.fetch_add(1, Ordering::SeqCst)).is_none());
    assert_eq!(keys.write(leaf, "pc-Q", || ran.fetch_add(1, Ordering::SeqCst)), Some(3));
}

#[test]
fn colliding_leaves_complete_writes_endings_and_leaf_intent_edits_in_fixed_lock_order() {
    let first = "tm-collision".to_string();
    let second = (0..1000).map(|i| format!("tm-collision-{i}"))
        .find(|leaf| stripe_index(leaf) == stripe_index(&first)).unwrap();
    assert_ne!(first, second);
    assert_eq!(stripe_index(&first), stripe_index(&second));
    let keys = HostKeys::default();
    register(&keys, &first, "pc-first");
    register(&keys, &second, "pc-second");
    let canvas = Arc::new(crate::canvas_store::CanvasStore::new_in_memory());
    let edge = crate::canvas_store::CanvasEdge::new(first.clone(), second.clone(), None, "user");
    with_leaves(&[&first, &second], || { canvas.insert_edge(&edge).unwrap(); });
    assert_eq!(canvas.all_edges().unwrap().len(), 1);
    let writes = Arc::new(AtomicUsize::new(0));
    let edits = Arc::new(AtomicUsize::new(0));
    for (leaf, pc) in [(&first, "pc-first"), (&second, "pc-second")] {
        assert!(keys.write(leaf, pc, || writes.fetch_add(1, Ordering::SeqCst)).is_some());
    }
    assert_eq!(writes.load(Ordering::SeqCst), 2);
    let (finished, received) = std::sync::mpsc::channel();
    let mut threads = Vec::new();
    for lane in 0..12 {
        let keys = keys.clone(); let first = first.clone(); let second = second.clone();
        let finished = finished.clone(); let writes = writes.clone(); let edits = edits.clone();
        let canvas = canvas.clone(); let edge_id = edge.id.clone();
        threads.push(std::thread::spawn(move || {
            for _ in 0..50 {
                match lane % 3 {
                    0 => { keys.write(&first, "pc-first", || {
                            canvas.update_label(&edge_id, Some("shell:first")).unwrap();
                            writes.fetch_add(1, Ordering::SeqCst);
                        });
                        keys.write(&second, "pc-second", || {
                            canvas.update_label(&edge_id, Some("shell:second")).unwrap();
                            writes.fetch_add(1, Ordering::SeqCst);
                        }); }
                    1 => { with_leaves(&[&second, &first, &second], || {
                        keys.owner_state(&first); keys.owner_state(&second);
                        canvas.update_label(&edge_id, Some("user:intent")).unwrap();
                        edits.fetch_add(1, Ordering::SeqCst);
                    }); }
                    _ => { with_leaves(&[&first], || { keys.owner_state(&first); }); }
                }
            }
            finished.send(lane).unwrap();
        }));
    }
    let ended = Arc::new(AtomicUsize::new(0));
    for (leaf, pc) in [(first.clone(), "pc-first"), (second.clone(), "pc-second")] {
        let keys = keys.clone(); let finished = finished.clone(); let ended = ended.clone();
        let canvas = canvas.clone();
        threads.push(std::thread::spawn(move || {
            assert!(keys.end_process(pc, EndKind::Exit, |got| {
                assert_eq!(got, leaf); ended.fetch_add(1, Ordering::SeqCst);
                canvas.delete_edges_for(got).unwrap();
                // Ownership remains accessible during synchronous storage.
                assert_eq!(keys.resolve_process(pc, false).as_deref(), Some(pc));
            }).is_some());
            finished.send(99).unwrap();
        }));
    }
    for _ in 0..14 { received.recv_timeout(Duration::from_secs(3)).expect("stripe/owner lock-order deadline"); }
    for thread in threads { thread.join().unwrap(); }
    assert_eq!(ended.load(Ordering::SeqCst), 2);
    assert!(canvas.all_edges().unwrap().is_empty());
    assert_eq!(edits.load(Ordering::SeqCst), 200);
    assert!(writes.load(Ordering::SeqCst) >= 2);
    assert!(keys.owner_state(&first).is_none());
    assert!(keys.owner_state(&second).is_none());
    with_all(|| { assert!(keys.owner_state(&first).is_none()); });
    register(&keys, &first, "pc-new");
    assert_eq!(keys.write(&first, "pc-new", || "control"), Some("control"));
}
