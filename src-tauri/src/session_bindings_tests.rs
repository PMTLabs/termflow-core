use super::*;

struct Rig {
    bindings: SessionBindings,
    now: Instant,
    closed: Vec<String>,
}

impl Rig {
    fn new() -> Self { Self { bindings: SessionBindings::default(), now: Instant::now(), closed: vec![] } }
    fn create(&self, leaf: &str, window: &str) -> Creating {
        self.bindings.begin_create(leaf, window, self.now).unwrap()
    }
    fn finish(&mut self, create: Creating, process: &str) {
        if !create.complete(process, self.now) { self.closed.push(process.to_string()); }
    }
    fn close(&mut self, leaf: &str, window: &str) {
        if let Some(process) = self.bindings.close(leaf, window) { self.closed.push(process); }
    }
    fn bind(&self, leaf: &str, window: &str, process: &str) -> BindResult {
        self.bindings.bind(leaf, window, Some(process), self.now)
    }
    fn reap(&mut self, at: Instant) { self.closed.extend(self.bindings.reap_unbound(at)); }
}

fn bound(process: &str) -> BindResult { BindResult::Bound { process_id: process.into() } }

#[test]
fn move_then_close_at_destination_invalidates_the_sources_create() {
    let mut rig = Rig::new();
    let create = rig.create("leaf", "source");
    rig.bindings.release("leaf", "source", rig.now);
    rig.close("leaf", "destination");
    rig.finish(create, "shell-source");
    assert_eq!(rig.closed, ["shell-source"]);
    assert_eq!(rig.bindings.holder("leaf"), None);
    assert_eq!(rig.bind("leaf", "destination", "shell-source"), BindResult::None);
}

#[test]
fn close_in_another_window_closes_the_actual_holder_exactly_once() {
    let mut rig = Rig::new();
    let create = rig.create("leaf", "creator");
    rig.finish(create, "shell-creator");
    assert_eq!(rig.bindings.holder("leaf").as_deref(), Some("creator"));
    rig.close("leaf", "other");
    rig.close("leaf", "creator");
    assert_eq!(rig.closed, ["shell-creator"]);
    assert_eq!(rig.bindings.holder("leaf"), None);
}

#[test]
fn close_before_barrier_resolution_is_not_erased_by_create_completion() {
    let mut rig = Rig::new();
    let create = rig.create("leaf", "source");
    rig.close("leaf", "other");
    // A provisional registration is indexed before the host request completes.
    assert_eq!(rig.bind("leaf", "other", "provisional"), BindResult::None);
    rig.finish(create, "final-fallback-shell");
    assert_eq!(rig.closed, ["final-fallback-shell"]);
}

#[test]
fn destination_never_completes_requires_no_offer_and_does_not_leak() {
    let mut rig = Rig::new();
    let create = rig.create("leaf", "source");
    rig.finish(create, "shell");
    assert_eq!(rig.bindings.holder("leaf").as_deref(), Some("source"));
    assert_eq!(rig.bind("leaf", "destination", "shell"), BindResult::Refused);
    rig.bindings.release("leaf", "source", rig.now);
    rig.reap(rig.now + UNBOUND_GRACE);
    rig.reap(rig.now + UNBOUND_GRACE + Duration::from_secs(60));
    assert_eq!(rig.closed, ["shell"]);
    assert_eq!(rig.bindings.holder("leaf"), None);
}

#[test]
fn second_window_cannot_bind_a_shell_that_the_first_shows() {
    let mut rig = Rig::new();
    let create = rig.create("leaf", "first");
    rig.finish(create, "shell-first");
    assert_eq!(rig.bind("leaf", "second", "shell-first"), BindResult::Refused);
    assert_eq!(rig.bindings.holder("leaf").as_deref(), Some("first"));
    assert!(rig.closed.is_empty());
}

#[test]
fn closing_one_copy_preserves_the_other_windows_migrated_restore_intent() {
    let mut rig = Rig::new();
    rig.bindings.register_intent("leaf", "old-key", "first", rig.now);
    rig.bindings.register_intent("leaf", "old-key", "second", rig.now);
    let create = rig.create("leaf", "first");
    rig.close("leaf", "first");
    assert!(rig.bindings.has_intent("leaf", rig.now));
    assert!(rig.bindings.has_key_intent("old-key", rig.now));
    rig.finish(create, "old-host-shell");
    assert_eq!(rig.closed, ["old-host-shell"]);
    rig.close("leaf", "second");
    assert!(!rig.bindings.has_key_intent("old-key", rig.now));
}

#[test]
fn window_teardown_releases_only_its_bindings_including_an_inflight_create() {
    let mut rig = Rig::new();
    let a = rig.create("a", "destroyed");
    let b = rig.create("b", "survivor");
    rig.finish(b, "shell-b");
    rig.bindings.destroy_window("destroyed", rig.now);
    rig.finish(a, "shell-a");
    assert_eq!(rig.bindings.holder("a"), None);
    assert_eq!(rig.bindings.holder("b").as_deref(), Some("survivor"));
    assert_eq!(rig.bind("a", "destroyed", "shell-a"), BindResult::Refused);
    rig.reap(rig.now + UNBOUND_GRACE);
    assert_eq!(rig.closed, ["shell-a"]);
}

#[test]
fn unbound_grace_boundary_closes_once_and_never_reaps_a_bound_or_creating_shell() {
    let mut rig = Rig::new();
    let a = rig.create("a", "window");
    let b = rig.create("b", "window");
    let c = rig.create("c", "window");
    rig.finish(a, "shell-a");
    rig.finish(b, "shell-b");
    rig.bindings.release("a", "window", rig.now);
    rig.bindings.release("c", "window", rig.now);
    rig.reap(rig.now + UNBOUND_GRACE - Duration::from_nanos(1));
    assert!(rig.closed.is_empty());
    rig.reap(rig.now + UNBOUND_GRACE);
    assert_eq!(rig.closed, ["shell-a"]);
    assert_eq!(rig.bindings.holder("b").as_deref(), Some("window"));
    assert_eq!(rig.bind("a", "destination", "shell-a"), BindResult::None);
    drop(c);
    rig.reap(rig.now + UNBOUND_GRACE);
    assert_eq!(rig.closed, ["shell-a"]);
}

#[test]
fn single_window_create_bind_close_and_restart_are_unchanged() {
    let mut rig = Rig::new();
    let create = rig.create("leaf", "main");
    rig.finish(create, "shell-1");
    assert_eq!(rig.bind("leaf", "main", "shell-1"), bound("shell-1"));
    rig.close("leaf", "main");
    let create = rig.create("leaf", "main");
    rig.finish(create, "shell-2");
    assert_eq!(rig.bind("leaf", "main", "shell-2"), bound("shell-2"));
    assert_eq!(rig.closed, ["shell-1"]);
}

#[test]
fn released_shell_has_one_atomic_binding_winner() {
    let mut rig = Rig::new();
    let create = rig.create("leaf", "source");
    rig.finish(create, "shell");
    rig.bindings.release("leaf", "source", rig.now);
    let winners = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..8).map(|i| {
            let bindings = &rig.bindings;
            let now = rig.now;
            scope.spawn(move || {
                let label = format!("destination-{i}");
                (label.clone(), bindings.bind("leaf", &label, Some("shell"), now))
            })
        }).collect();
        handles.into_iter().map(|h| h.join().unwrap())
            .filter(|(_, result)| *result == bound("shell")).collect::<Vec<_>>()
    });
    assert_eq!(winners.len(), 1);
    assert_eq!(rig.bindings.holder("leaf"), Some(winners[0].0.clone()));
}

#[test]
fn stale_source_release_cannot_remove_the_destination_holder() {
    let mut rig = Rig::new();
    let create = rig.create("leaf", "source");
    rig.finish(create, "shell");
    rig.bindings.release("leaf", "source", rig.now);
    assert_eq!(rig.bind("leaf", "destination", "shell"), bound("shell"));
    rig.bindings.release("leaf", "source", rig.now);
    assert_eq!(rig.bindings.holder("leaf").as_deref(), Some("destination"));
    rig.reap(rig.now + UNBOUND_GRACE);
    assert!(rig.closed.is_empty());
}

#[test]
fn absent_or_stale_registration_cannot_be_bound() {
    let bindings = SessionBindings::default();
    let now = Instant::now();
    assert_eq!(bindings.bind("absent", "window", None, now), BindResult::None);
    let create = bindings.begin_create("leaf", "source", now).unwrap();
    assert!(create.complete("shell-1", now));
    bindings.release("leaf", "source", now);
    assert_eq!(bindings.bind("leaf", "dest", Some("shell-2"), now), BindResult::None);
    bindings.forget_process("shell-1");
    assert_eq!(bindings.bind("leaf", "dest", None, now), BindResult::None);
}

#[test]
fn leaves_are_independent_and_only_the_final_process_is_published() {
    let mut rig = Rig::new();
    let a = rig.create("a", "source");
    let b = rig.create("b", "source");
    rig.bindings.release("a", "source", rig.now);
    assert_eq!(rig.bind("a", "dest", "provisional-host-shell"), BindResult::Pending);
    rig.finish(a, "fallback-shell");
    assert_eq!(rig.bind("a", "dest", "fallback-shell"), bound("fallback-shell"));
    assert_eq!(rig.bind("b", "dest", "other-provisional"), BindResult::Pending);
    rig.finish(b, "other-shell");
    assert_eq!(rig.bindings.holder("b").as_deref(), Some("source"));
}

#[test]
fn cancelled_create_releases_reservation_and_retry_can_create_again() {
    let rig = Rig::new();
    let first = rig.create("leaf", "source");
    let error = match rig.bindings.begin_create("leaf", "dest", rig.now) {
        Err(error) => error,
        Ok(_) => panic!("expected refusal"),
    };
    assert!(error.starts_with("host-ownership-pending:"));
    drop(first);
    let second = rig.create("leaf", "dest");
    assert!(second.complete("shell-dest", rig.now));
    assert_eq!(rig.bindings.holder("leaf").as_deref(), Some("dest"));
}

#[test]
fn cancelled_host_request_keeps_its_provisional_shell_for_grace_cleanup_not_binding() {
    let mut rig = Rig::new();
    let create = rig.create("leaf", "source");
    rig.bindings.stage_process("leaf", "pc-provisional");
    drop(create);
    assert_eq!(rig.bind("leaf", "dest", "pc-provisional"), BindResult::Pending);
    rig.reap(Instant::now() + UNBOUND_GRACE);
    rig.reap(Instant::now() + UNBOUND_GRACE);
    assert_eq!(rig.closed, ["pc-provisional"]);
}

#[test]
fn consuming_a_move_tree_releases_waiting_and_live_leaves_without_a_final_source_call() {
    let mut rig = Rig::new();
    let waiting = rig.create("waiting", "source");
    let live = rig.create("live", "source");
    rig.finish(live, "pc-live");
    let tree = serde_json::json!({ "children": [
        { "terminalId": "live" }, { "children": [{ "terminalId": "waiting" }] }
    ] });
    rig.bindings.release_tree(&tree, "source", rig.now);
    assert_eq!(rig.bindings.holder("live"), None);
    assert_eq!(rig.bindings.holder("waiting"), None);
    rig.finish(waiting, "pc-waiting");
    // The destination never mounts and the renderer's release IPC never arrives.
    rig.reap(rig.now + UNBOUND_GRACE);
    rig.closed.sort();
    assert_eq!(rig.closed, ["pc-live", "pc-waiting"]);
}

#[test]
fn restore_intents_expire_but_keyed_retries_refresh_every_copy() {
    let rig = Rig::new();
    rig.bindings.register_intent("leaf", "key", "a", rig.now);
    rig.bindings.register_intent("leaf", "key", "b", rig.now);
    let almost = rig.now + INTENT_TTL - Duration::from_secs(1);
    rig.bindings.refresh_intents("key", almost);
    assert!(rig.bindings.has_key_intent("key", rig.now + INTENT_TTL));
    assert!(!rig.bindings.has_key_intent("key", almost + INTENT_TTL));
}

#[test]
fn process_addressed_close_defers_a_provisional_shell_then_closes_its_final_identity() {
    let mut rig = Rig::new();
    let creating = rig.create("leaf", "source");
    rig.bindings.stage_process("leaf", "pc-provisional");
    assert!(rig.bindings.defer_process_close("pc-provisional"));
    assert!(!rig.bindings.defer_process_close("pc-unrelated"));
    rig.finish(creating, "pc-final");
    assert_eq!(rig.closed, ["pc-final"]);
    assert!(!rig.bindings.defer_process_close("pc-final"));
}

#[test]
fn backend_leave_paths_use_window_bindings_not_offers() {
    use crate::automation_engine::test_host::strip_comments;
    let commands = strip_comments(include_str!("commands/terminal.rs"));
    let start = commands.find("pub fn forget_restoring_leaf(").unwrap();
    let end = commands[start..].find("pub fn bind_shell(").unwrap();
    let close = &commands[start..start + end];
    assert!(close.contains("close_leaf_for_window(&leaf_id, window.label())"));
    assert!(close.contains("close_terminal_process(state.inner(), process)?"));
    assert!(commands.contains("defer_process_close(&id)"));
    assert!(commands.contains("session_bindings.stage_process(leaf, id)"));
    let lib = strip_comments(include_str!("lib.rs"));
    let destroyed = lib.find("if let WindowEvent::Destroyed = event").unwrap();
    assert!(lib[destroyed..].contains("session_bindings.destroy_window(window.label()"));
    let windows = strip_comments(include_str!("commands/window.rs"));
    assert!(windows.contains("if source != window.label()"));
    assert!(windows.contains("session_bindings.release_tree(tree, &source,"));
    let drag = strip_comments(include_str!("commands/drag.rs"));
    assert!(drag.contains("g.source_label != window.label()"));
    assert!(drag.contains("session_bindings.release_tree(tree, &source_label,"));
    let terminals = strip_comments(include_str!("state/terminals.rs"));
    assert!(terminals.contains("session_bindings.reap_unbound("));
    assert!(terminals.contains("crate::commands::close_terminal_process(self, process_id)"));
    assert!(terminals.contains("session_bindings.forget_process(id)"));
    let panes = strip_comments(include_str!("state/host_adoption/panes.rs"));
    assert!(panes.find("port.restoring(&orphan.tab_id,").unwrap()
        < panes.find("host_registry::reserve_session(").unwrap());
}

#[test]
fn binding_answers_have_the_renderer_wire_shape() {
    assert_eq!(serde_json::to_value(bound("shell")).unwrap(), serde_json::json!({"status":"bound","processId":"shell"}));
    assert_eq!(serde_json::to_value(BindResult::Pending).unwrap(), serde_json::json!({"status":"pending"}));
    assert_eq!(serde_json::to_value(BindResult::Refused).unwrap(), serde_json::json!({"status":"refused"}));
    assert_eq!(serde_json::to_value(BindResult::None).unwrap(), serde_json::json!({"status":"none"}));
}
