use super::*;
use std::time::Duration;

const CHANNEL: HostChannel = HostChannel::Primary;
const BOUND: Duration = Duration::from_secs(3);

#[test]
fn missing_dead_and_superseded_bindings_cannot_publish_routes() {
    let keys = HostKeys::default();
    let (stage, _) = keys.stage(CHANNEL, "shared", StageMode::Spawn).unwrap();
    assert!(!keys.publish(&stage, "pc-P", 1));
    assert!(!keys.routes.contains(CHANNEL, "shared"));
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let live = Arc::new(AtomicBool::new(true));
    keys.connect(CHANNEL, 1, tx, live.clone());
    assert!(keys.publish(&stage, "pc-P", 1));
    assert!(keys.complete(&stage, "pc-P"));
    live.store(false, Ordering::Release);
    assert!(!keys.restore_route(CHANNEL, "shared", "pc-P", 1));
    keys.disconnect(CHANNEL, 1);
    assert!(!keys.restore_route(CHANNEL, "shared", "pc-P", 1));
    keys.connect_fixture(CHANNEL, 2);
    assert!(!keys.restore_route(CHANNEL, "shared", "pc-P", 1));
    assert!(keys.restore_route(CHANNEL, "shared", "pc-P", 2));
    keys.disconnect(CHANNEL, 1);
    keys.routes.remove_epoch(CHANNEL, 1);
    assert_eq!(keys.routes.resolve(CHANNEL, "shared", 2, true), Some("pc-P".into()));
}

#[test]
fn stale_stage_publication_cannot_replace_the_new_leaf_index() {
    let keys = HostKeys::default();
    let index = crate::identity_index::IdentityIndex::new();
    let CreateAdmission::Run(cg) = keys.admit_create("tm-leaf", CreateMode::Mount).unwrap() else { panic!("admission") };
    keys.stage_shell("tm-leaf", cg, "pc-P", None).unwrap();
    assert!(keys.publish_shell_projection("pc-P", || index.index("pc-P", Some("tm-leaf"), "pc-P")).is_some());
    assert_eq!(index.process_for_leaf("tm-leaf"), Some("pc-P".into()));
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (resume_tx, resume_rx) = std::sync::mpsc::channel();
    let delayed = std::thread::spawn({ let keys = keys.clone(); let index = index.clone(); move || {
        entered_tx.send(()).unwrap();
        resume_rx.recv_timeout(BOUND).unwrap();
        keys.publish_shell_projection("pc-P", || index.index("pc-P", Some("tm-leaf"), "pc-P")).is_some()
    }});
    entered_rx.recv_timeout(BOUND).unwrap();
    assert_eq!(keys.abort_create("tm-leaf", cg).unwrap().process, "pc-P");
    let CreateAdmission::Run(q_cg) = keys.admit_create("tm-leaf", CreateMode::Mount).unwrap() else { panic!("admission") };
    assert!(q_cg > cg);
    keys.stage_shell("tm-leaf", q_cg, "pc-Q", None).unwrap();
    assert!(keys.publish_shell_projection("pc-Q", || index.index("pc-Q", Some("tm-leaf"), "pc-Q")).is_some());
    assert!(matches!(keys.complete_shell("tm-leaf", q_cg, &StagedShell { process: "pc-Q".into(), stage: ShellStage::Local }), Completion::Registered));
    resume_tx.send(()).unwrap();
    assert!(!delayed.join().unwrap());
    index.unindex("pc-P");
    assert_eq!(index.process_for_leaf("tm-leaf"), Some("pc-Q".into()));
    assert_eq!(keys.resolve_process("tm-leaf", true), Some("pc-Q".into()));
}

#[test]
fn local_and_hosted_projection_callers_publish_the_index_inside_stage_authority() {
    use crate::state::source_scan::{fn_body, matching_brace};
    for (source, signature) in [
        (include_str!("../../commands/terminal.rs"), "fn register_host_terminal("),
        (include_str!("../../pty_manager/spawn.rs"), "pub fn spawn_terminal("),
    ] {
        let body = fn_body(source, signature);
        let start = body.find(".publish_shell_projection(").unwrap();
        let open = body[start..].find("|| {").unwrap() + start + 3;
        let effect = &body[open..=matching_brace(&body, open)];
        assert!(effect.contains(".identity.index("));
        assert!(effect.contains(".terminals.insert("));
        assert!(effect.contains(".init_screen("));
    }
}
