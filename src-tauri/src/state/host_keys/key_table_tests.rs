use super::*;
use crate::state::source_scan::{production, fn_body};
use termflow_pty_protocol::SessionMeta;

const CHANNEL: HostChannel = HostChannel::Primary;

fn listing(request_no: u64, sessions: Vec<SessionMeta>) -> SessionListing {
    SessionListing { request_no, sessions }
}

#[test]
fn stale_attach_generation_cannot_publish_complete_or_abort_its_successor() {
    let keys = HostKeys::default();
    let meta = SessionMeta { tab_id: "exact".into(), pid: 73, alive: true, head_offset: 0, tail_offset: 0 };
    keys.listing(CHANNEL, &listing(1, vec![meta.clone()]), |_| false);
    let (old, pid) = keys.stage(CHANNEL, "exact", StageMode::Attach).unwrap();
    assert_eq!(pid, 73);
    assert!(keys.publish(&old, "pc-old", 1));
    keys.abort(&old);
    assert!(keys.eligible(CHANNEL, "exact"));
    assert!(!keys.routes.contains(CHANNEL, "exact"));
    let (new, pid) = keys.stage(CHANNEL, "exact", StageMode::Attach).unwrap();
    assert_eq!(pid, 73);
    assert_ne!(old.cg, new.cg);
    assert!(keys.publish(&new, "pc-new", 1));
    keys.abort(&old);
    assert!(!keys.publish(&old, "pc-old", 1));
    assert!(!keys.complete(&old, "pc-old"));
    assert_eq!(keys.routes.resolve(CHANNEL, "exact", 1, true), Some("pc-new".into()));
    assert!(keys.complete(&new, "pc-new"));
    keys.exit_process("pc-old");
    assert_eq!(keys.state(CHANNEL, "exact"), Some(KeyState::Bound("pc-new".into())));
    keys.exit_process("pc-new");
    assert_eq!(keys.state(CHANNEL, "exact"), Some(KeyState::Ending { close: CloseState::None, stamp: Some(0) }));
    let mut dead = meta;
    dead.alive = false;
    keys.listing(CHANNEL, &listing(2, vec![dead]), |_| false);
    assert_eq!(keys.state(CHANNEL, "exact"), None, "a qualifying dead reply releases, without reinserting the same key");
}

#[test]
fn sent_close_survives_stale_disconnect_and_omission_until_it_is_resent() {
    let keys = HostKeys::default();
    let (sender, mut frames) = tokio::sync::mpsc::unbounded_channel();
    keys.connect(CHANNEL, 7, sender, Arc::new(AtomicBool::new(true)));
    assert_eq!(keys.enqueue_listing(CHANNEL, || true), Some(1));
    let (stage, _) = keys.stage(CHANNEL, "closing", StageMode::Spawn).unwrap();
    assert!(keys.complete(&stage, "pc-closing"));
    keys.close(CHANNEL, "closing");
    assert!(matches!(frames.try_recv().unwrap(), Frame::Ctrl(Control::Close { tab_id }) if tab_id == "closing"));
    assert_eq!(keys.state(CHANNEL, "closing"), Some(KeyState::Ending { close: CloseState::Sent(7), stamp: Some(1) }));
    keys.disconnect(CHANNEL, 6);
    assert!(matches!(keys.state(CHANNEL, "closing"), Some(KeyState::Ending { close: CloseState::Sent(7), .. })));
    keys.disconnect(CHANNEL, 7);
    assert_eq!(keys.state(CHANNEL, "closing"), Some(KeyState::Ending { close: CloseState::Pending, stamp: None }));
    assert_eq!(keys.enqueue_listing(CHANNEL, || true), Some(2));
    keys.listing(CHANNEL, &listing(2, vec![]), |_| false);
    assert!(!keys.eligible(CHANNEL, "closing"));
    assert_eq!(keys.len(), 1);
    let (sender, mut frames) = tokio::sync::mpsc::unbounded_channel();
    keys.connect(CHANNEL, 8, sender.clone(), Arc::new(AtomicBool::new(true)));
    let request = keys.enqueue_listing(CHANNEL, || sender.send(Frame::Ctrl(Control::ListSessions { req: 17, token: Some("tok".into()) })).is_ok()).unwrap();
    assert!(matches!(frames.try_recv().unwrap(), Frame::Ctrl(Control::Close { tab_id }) if tab_id == "closing"));
    assert!(matches!(frames.try_recv().unwrap(), Frame::Ctrl(Control::ListSessions { req: 17, .. })));
    keys.listing(CHANNEL, &listing(request, vec![]), |_| false);
    assert_eq!(keys.state(CHANNEL, "closing"), None);
}

#[test]
fn forgetting_one_host_removes_every_kind_without_touching_the_other_host() {
    let keys = HostKeys::default();
    let other = HostChannel::Elevated;
    for channel in [CHANNEL, other] {
        keys.listing(channel, &listing(1, vec![SessionMeta { tab_id: "listed".into(), pid: 1, alive: true, head_offset: 0, tail_offset: 0 }]), |_| false);
        let (held, _) = keys.stage(channel, "held", StageMode::Spawn).unwrap();
        assert!(keys.publish(&held, "pc-held", 1));
        let (bound, _) = keys.stage(channel, "bound", StageMode::Spawn).unwrap();
        assert!(keys.complete(&bound, "pc-bound"));
        keys.close(channel, "pending");
        let (ended, _) = keys.stage(channel, "none", StageMode::Spawn).unwrap();
        keys.exit(channel, &ended.key);
    }
    assert_eq!(keys.len(), 10);
    keys.forget(CHANNEL);
    assert_eq!(keys.len(), 5);
    for key in ["listed", "held", "bound", "pending", "none"] {
        assert_eq!(keys.state(CHANNEL, key), None);
        assert!(keys.state(other, key).is_some());
    }
    assert!(!keys.routes.contains(CHANNEL, "held"));
    assert!(keys.routes.contains(other, "held"));
}

#[test]
fn failed_listing_enqueue_and_exhausted_sequences_publish_nothing() {
    let keys = HostKeys::default();
    assert_eq!(keys.enqueue_listing(CHANNEL, || false), None);
    assert_eq!(keys.enqueue_listing(CHANNEL, || true), Some(1));
    keys.lock().channels.get_mut(&CHANNEL).unwrap().requests = u64::MAX;
    assert_eq!(keys.enqueue_listing(CHANNEL, || panic!("exhausted clock must not enqueue")), None);
    keys.lock().sequence = u64::MAX;
    assert!(keys.stage(CHANNEL, "fresh", StageMode::Spawn).is_err());
    assert_eq!(keys.state(CHANNEL, "fresh"), None);
    assert!(!keys.routes.contains(CHANNEL, "fresh"));
}

#[test]
fn session_lifecycle_has_one_authority_and_one_wire_close_sender() {
    fn sources(dir: &std::path::Path, root: &std::path::Path, out: &mut Vec<(String, String)>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() { sources(&path, root, out); continue; }
            let name = path.file_name().unwrap().to_string_lossy();
            if path.extension().is_some_and(|e| e == "rs") && !name.ends_with("_tests.rs") && name != "tests.rs" && name != "fake_hosts.rs" {
                out.push((path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/"), production(&std::fs::read_to_string(path).unwrap())));
            }
        }
    }
    const RAW_CLOSE: &str = concat!("client.", "close(");
    fn violations(text: &str) -> Vec<&str> {
        ["HostSessionClaim", "host_session_claims", "host_close_pending", "retired_keys", "reserved_keys", "Control::Close", RAW_CLOSE, "close_session("]
            .into_iter().filter(|needle| text.contains(needle)).collect()
    }
    // A planted production hit must be detected, while test fixtures are cut.
    let planted = production(concat!("fn wrong() { host_close_pending.insert(k, v); client.", "close(k); }\n#[cfg(test)] mod fixture { fn raw() { Control::Close; } }"));
    assert_eq!(violations(&planted), vec!["host_close_pending", RAW_CLOSE]);
    assert_eq!(violations(&production("fn wrong() { Control::Close; HostSessionClaim; }")), vec!["HostSessionClaim", "Control::Close"]);
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut scanned = vec![];
    sources(&root, &root, &mut scanned);
    for name in ["pty_host_client.rs", "state/host_keys.rs", "state/host_registry.rs", "state/host_table.rs", "state/host_routing.rs", "state/host_adoption/panes.rs", "commands/terminal.rs"] {
        assert!(scanned.iter().any(|(path, _)| path == name), "missing census input {name}");
    }
    for (path, text) in &scanned {
        let hits = violations(text);
        if path == "state/host_keys.rs" {
            assert_eq!(hits, vec!["Control::Close"]);
            assert_eq!(text.matches("Control::Close").count(), 1);
            assert!(fn_body(text, "fn send(").contains("Control::Close"));
        } else {
            assert!(hits.is_empty(), "parallel session authority or raw Close in {path}: {hits:?}");
        }
    }
    // AppHandle construction is not portable; lock the production command's
    // wiring to the same Ticket transitions exercised with real wire frames.
    let command = scanned.iter().find(|(p, _)| p == "commands/terminal.rs").unwrap();
    let body = fn_body(&command.1, "async fn spawn_routed(");
    assert!(body.find("ticket.publish_key(").unwrap() < body.find("register_host_terminal(").unwrap());
    let failure = &body[body.find("Err(e) =>").unwrap()..];
    assert!(failure.find("ticket.abort_key()").unwrap() < failure.find("state.cleanup_terminal_state(").unwrap());
    assert!(failure.find("state.cleanup_terminal_state(").unwrap() < failure.find("host_fallback(").unwrap());
    let fallback = fn_body(&command.1, "fn host_fallback(");
    assert!(fallback.contains(concat!("pty_manager::spawn_", "terminal(")));
    let table = scanned.iter().find(|(p, _)| p == "state/host_table.rs").unwrap();
    assert!(fn_body(&table.1, "pub fn guard_key(").contains("self.stages.push(stage)"));
}
