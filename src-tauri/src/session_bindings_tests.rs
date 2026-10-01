use super::*;

struct Rig {
    bindings: SessionBindings,
    now: Instant,
    closed: Vec<String>,
    recovered: Vec<String>,
}

impl Rig {
    fn new() -> Self { Self { bindings: SessionBindings::default(), now: Instant::now(), closed: vec![], recovered: vec![] } }
    fn create(&self, leaf: &str, window: &str) -> Creating {
        self.bindings.begin_create(leaf, window, self.now).unwrap()
    }
    fn finish(&mut self, create: Creating, process: &str) {
        if !create.complete(process, self.now) { self.closed.push(process.to_string()); }
    }
    fn close(&mut self, leaf: &str, window: &str) {
        if let Some(process) = self.bindings.close(leaf, window) {
            self.bindings.close_process_with(&process, true, |_| self.closed.push(process.clone()));
        }
    }
    fn bind(&self, leaf: &str, window: &str, process: &str) -> BindResult {
        self.bindings.bind(leaf, window, Some(process), self.now)
    }
    fn reap(&mut self, at: Instant) { self.recovered.extend(self.bindings.reap_unbound(at)); }
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
fn refused_duplicate_close_preserves_the_actual_holder_until_its_own_close() {
    let mut rig = Rig::new();
    let create = rig.create("leaf", "creator");
    rig.finish(create, "shell-creator");
    assert_eq!(rig.bindings.holder("leaf").as_deref(), Some("creator"));
    rig.close("leaf", "other");
    assert!(rig.closed.is_empty());
    assert_eq!(rig.bindings.holder("leaf").as_deref(), Some("creator"));
    rig.close("leaf", "creator");
    rig.close("leaf", "creator");
    assert_eq!(rig.closed, ["shell-creator"]);
    assert_eq!(rig.bindings.holder("leaf"), None);
}

#[test]
fn close_before_barrier_resolution_is_not_erased_by_create_completion() {
    let mut rig = Rig::new();
    let create = rig.create("leaf", "source");
    rig.bindings.release_tree(&serde_json::json!({"terminalId": "leaf"}), "source", rig.now);
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
    assert_eq!(rig.recovered, ["shell"]);
    assert!(rig.closed.is_empty());
    assert_eq!(rig.bind("leaf", "destination", "shell"), bound("shell"));
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
    assert_eq!(rig.recovered, ["shell-a"]);
    assert!(rig.closed.is_empty());
}

#[test]
fn unbound_grace_surfaces_once_and_never_reaps_a_bound_or_staged_creating_shell() {
    let mut rig = Rig::new();
    let a = rig.create("a", "window");
    let b = rig.create("b", "window");
    let c = rig.create("c", "window");
    rig.finish(a, "shell-a");
    rig.finish(b, "shell-b");
    rig.bindings.release("a", "window", rig.now);
    rig.bindings.release("c", "window", rig.now);
    rig.bindings.stage_process("c", "pc-provisional-c");
    rig.reap(rig.now + UNBOUND_GRACE - Duration::from_nanos(1));
    assert!(rig.closed.is_empty());
    rig.reap(rig.now + UNBOUND_GRACE);
    assert_eq!(rig.recovered, ["shell-a"]);
    assert!(rig.closed.is_empty());
    assert_eq!(rig.bindings.holder("b").as_deref(), Some("window"));
    assert_eq!(rig.bind("a", "destination", "shell-a"), bound("shell-a"));
    assert_eq!(rig.bind("c", "destination", "pc-provisional-c"), BindResult::Pending);
    assert!(c.complete("pc-final-c", rig.now));
    assert_eq!(rig.bind("c", "destination", "pc-final-c"), bound("pc-final-c"));
    rig.reap(rig.now + UNBOUND_GRACE);
    assert_eq!(rig.recovered, ["shell-a"]);
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
    assert_eq!(rig.recovered, ["pc-provisional"]);
    assert!(rig.closed.is_empty());
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
    rig.recovered.sort();
    assert_eq!(rig.recovered, ["pc-live", "pc-waiting"]);
    assert!(rig.closed.is_empty());
}

#[test]
fn restore_intents_expire_but_keyed_retries_refresh_every_copy() {
    for removed in ["a", "b"] {
        let rig = Rig::new();
        rig.bindings.register_intent("leaf", "key", "a", rig.now);
        rig.bindings.register_intent("leaf", "key", "b", rig.now);
        rig.bindings.register_intent("control", "other-key", "control-window", rig.now);
        let almost = rig.now + INTENT_TTL - Duration::from_secs(1);
        rig.bindings.refresh_intents("key", almost);
        rig.bindings.destroy_window(removed, almost);
        let surviving = if removed == "a" { "b" } else { "a" };
        assert_eq!(rig.bindings.0.lock().unwrap().intents["leaf"][surviving].1, almost);
        assert!(rig.bindings.has_key_intent("key", rig.now + INTENT_TTL));
        assert!(!rig.bindings.has_key_intent("other-key", rig.now + INTENT_TTL));
        assert!(!rig.bindings.has_key_intent("key", almost + INTENT_TTL));
    }
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
fn broker_transfer_revokes_a_late_source_bind_before_source_event_delivery() {
    let mut rig = Rig::new();
    let creating = rig.create("leaf", "source");
    rig.bindings.stage_process("leaf", "pc-p");
    let tree = serde_json::json!({"terminalId": "leaf"});
    rig.bindings.transfer_tree(&tree, "source", "destination", rig.now);
    assert_eq!(rig.bind("leaf", "destination", "pc-p"), BindResult::Pending);
    // The source tree still exists: its completion arrives before removal.
    rig.finish(creating, "pc-p");
    assert_eq!(rig.bind("leaf", "source", "pc-p"), BindResult::None);
    assert_eq!(rig.bind("leaf", "destination", "pc-p"), bound("pc-p"));
    rig.bindings.transfer_tree(&tree, "destination", "source", rig.now);
    assert_eq!(rig.bind("leaf", "source", "pc-p"), bound("pc-p"));
    assert!(rig.closed.is_empty());
}

#[test]
fn transfer_before_source_reservation_prevents_a_late_source_create() {
    let rig = Rig::new();
    rig.bindings.transfer_tree(&serde_json::json!({"terminalId": "leaf"}), "source", "destination", rig.now);
    assert!(rig.bindings.begin_create("leaf", "source", rig.now).is_err());
    let creating = rig.create("leaf", "destination");
    assert!(creating.complete("pc-destination", rig.now));
    assert_eq!(rig.bind("leaf", "destination", "pc-destination"), bound("pc-destination"));
}

#[test]
fn restore_intent_and_delayed_release_protect_the_original_shell_until_install() {
    let mut rig = Rig::new();
    let creating = rig.create("leaf", "window");
    rig.finish(creating, "pc-p");
    rig.bindings.register_intent("leaf", "legacy-key", "window", rig.now);
    rig.bindings.release("leaf", "window", rig.now);
    rig.reap(rig.now + UNBOUND_GRACE + Duration::from_secs(60));
    assert!(rig.recovered.is_empty());
    assert!(rig.closed.is_empty());
    assert!(rig.bindings.has_key_intent("legacy-key", rig.now));
    assert_eq!(rig.bind("leaf", "window", "pc-p"), bound("pc-p"));
}

#[test]
fn exit_before_completion_does_not_resurrect_a_dead_run_or_block_restart() {
    let rig = Rig::new();
    let creating = rig.create("leaf", "window");
    rig.bindings.stage_process("leaf", "pc-p");
    rig.bindings.forget_process("pc-p");
    assert!(!creating.complete("pc-p", rig.now));
    assert_eq!(rig.bindings.holder("leaf"), None);
    assert_eq!(rig.bind("leaf", "window", "pc-p"), BindResult::None);
    let restart = rig.create("leaf", "window");
    assert!(restart.complete("pc-q", rig.now));
    assert_eq!(rig.bind("leaf", "window", "pc-q"), bound("pc-q"));
    rig.bindings.close_process_with("pc-p", true, |_| {});
    assert_eq!(rig.bind("leaf", "window", "pc-q"), bound("pc-q"));
}

#[test]
fn headless_create_defers_publication_and_preserves_api_history_on_final_close() {
    let bindings = SessionBindings::default();
    let now = Instant::now();
    let create = bindings.begin_headless_create("leaf", now).unwrap();
    bindings.stage_process("leaf", "pc-p");
    assert_eq!(bindings.bind("leaf", "window", Some("pc-p"), now), BindResult::Pending);
    bindings.close_process_with("pc-p", false, |_| panic!("provisional process closed"));
    bindings.forget_process("pc-p");
    bindings.stage_process("leaf", "pc-q");
    assert!(!create.complete("pc-q", now));
    let mut closed = vec![];
    bindings.close_process_with("pc-q", true, |delete| closed.push(("pc-q", delete)));
    assert_eq!(closed, [("pc-q", false)]);
    let create = bindings.begin_headless_create("headless", now).unwrap();
    assert!(create.complete("pc-headless", now));
    assert!(bindings.reap_unbound(now + INTENT_TTL).is_empty());
}

#[test]
fn missed_window_destruction_releases_only_missing_holders_for_recovery() {
    let mut rig = Rig::new();
    let p = rig.create("leaf-p", "gone-window");
    let q = rig.create("leaf-q", "live-window");
    rig.finish(p, "pc-p");
    rig.finish(q, "pc-q");
    rig.bindings.reconcile_windows(&HashSet::from(["live-window".to_string()]), rig.now);
    rig.reap(rig.now + UNBOUND_GRACE);
    assert_eq!(rig.recovered, ["pc-p"]);
    assert_eq!(rig.bindings.holder("leaf-q").as_deref(), Some("live-window"));
    assert!(rig.closed.is_empty());
}

#[test]
fn overlapping_restore_transactions_suppress_recovery_past_intent_expiry_until_all_settle() {
    let mut rig = Rig::new();
    let creating = rig.create("leaf", "window");
    rig.finish(creating, "pc-p");
    rig.bindings.release("leaf", "window", rig.now);
    rig.bindings.begin_restore("window");
    rig.bindings.begin_restore("window");
    rig.bindings.register_intent("leaf", "key", "window", rig.now);
    let later = rig.now + INTENT_TTL + Duration::from_secs(60);
    rig.reap(later);
    rig.bindings.end_restore("window");
    rig.reap(later);
    assert!(rig.recovered.is_empty());
    assert!(rig.bindings.has_key_intent("key", later));
    assert!(rig.closed.is_empty());
    rig.bindings.end_restore("window");
    rig.reap(later);
    assert_eq!(rig.recovered, ["pc-p"]);
    assert!(rig.bindings.prepare_recovery("pc-p", "window", later));
    assert_eq!(rig.bind("leaf", "window", "pc-p"), bound("pc-p"));
}

#[test]
fn stale_pane_close_cannot_cancel_a_new_reservation_even_with_a_stale_identity_index() {
    let rig = Rig::new();
    let creating = rig.create("leaf", "window");
    assert!(creating.complete("pc-p", rig.now));
    rig.bindings.forget_process("pc-p");
    let replacement = rig.create("leaf", "window");
    assert_eq!(rig.bindings.close_expected_registered_with("leaf", "window", Some("pc-p"), Some("pc-p"), rig.now, |_| {}), None);
    assert!(replacement.complete("pc-q", rig.now));
    assert_eq!(rig.bind("leaf", "window", "pc-q"), bound("pc-q"));
}

#[test]
fn recovery_rechecks_a_bind_or_restore_that_overtakes_selection() {
    let mut rig = Rig::new();
    let creating = rig.create("leaf", "source");
    rig.finish(creating, "pc-p");
    rig.bindings.transfer_tree(&serde_json::json!({"terminalId": "leaf"}), "source", "destination", rig.now);
    rig.reap(rig.now + UNBOUND_GRACE);
    assert_eq!(rig.recovered, ["pc-p"]);
    assert_eq!(rig.bind("leaf", "destination", "pc-p"), bound("pc-p"));
    assert!(!rig.bindings.prepare_recovery("pc-p", "source", rig.now + UNBOUND_GRACE));
    assert_eq!(rig.bindings.holder("leaf").as_deref(), Some("destination"));
    rig.bindings.release("leaf", "destination", rig.now);
    rig.bindings.begin_restore("destination");
    assert!(!rig.bindings.prepare_recovery("pc-p", "source", rig.now + UNBOUND_GRACE));
    assert!(rig.closed.is_empty());
}

#[test]
fn backend_leave_paths_use_window_bindings_not_offers() {
    use crate::automation_engine::test_host::strip_comments;
    let commands = strip_comments(include_str!("commands/terminal.rs"));
    let start = commands.find("pub fn forget_restoring_leaf(").unwrap();
    let end = commands[start..].find("pub fn bind_shell(").unwrap();
    let close = &commands[start..start + end];
    assert!(close.contains("close_leaf_incarnation_for_window(&leaf_id, window.label(), process_id.as_deref())"));
    assert!(close.contains("close_terminal_process(state.inner(), process)?"));
    assert!(commands.contains("session_bindings.close_process_with(&id, delete_history,"));
    assert!(commands.contains("session_bindings.stage_process(leaf, id)"));
    let lib = strip_comments(include_str!("lib.rs"));
    let destroyed = lib.find("if let WindowEvent::Destroyed = event").unwrap();
    assert!(lib[destroyed..].contains("session_bindings.destroy_window(window.label()"));
    let windows = strip_comments(include_str!("commands/window.rs"));
    assert!(windows.contains("if source != window.label()"));
    assert!(windows.contains("session_bindings.transfer_tree(tree, &source, window.label(),"));
    let drag = strip_comments(include_str!("commands/drag.rs"));
    assert!(drag.contains("g.source_label != window.label()"));
    assert!(drag.contains("session_bindings.transfer_tree(tree, &source_label, window.label(),"));
    let terminals = strip_comments(include_str!("state/terminals.rs"));
    assert!(terminals.contains("session_bindings.reap_unbound_except("));
    assert!(terminals.contains("self.announce_recovered(&key)"));
    assert!(terminals.contains("session_bindings.forget_process(id)"));
    let panes = strip_comments(include_str!("state/host_adoption/panes.rs"));
    assert!(panes.find("port.restoring(&orphan.tab_id,").unwrap()
        < panes.find("host_registry::reserve_session(").unwrap());
}

// Supplementary wiring checks; transport effects are tested over real clients.
#[test]
fn every_explicit_local_entrypoint_uses_reserved_publication_and_process_close() {
    use crate::automation_engine::test_host::strip_comments;
    let renderer = strip_comments(include_str!("commands/terminal.rs"));
    let api = strip_comments(include_str!("api_server/terminals/mod.rs"));
    let fleet = strip_comments(include_str!("api_server/fleet.rs"));
    for source in [&api, &fleet] {
        assert_eq!(source.matches("crate::commands::spawn_unowned_routed(").count(), 1);
        assert_eq!(source.matches("crate::commands::close_terminal_process_with_history(&state, id, false)").count(), 1);
        assert!(!source.contains("state.host_close("));
        assert!(!source.contains("kill_process_tree("));
    }
    let register = renderer.find("fn register_host_terminal(").unwrap();
    let stage = renderer[register..].find("session_bindings.stage_process(leaf, id)").unwrap();
    let index = renderer[register..].find("state.identity.index(").unwrap();
    let observable = renderer[register..].find("state.terminals.insert(").unwrap();
    assert!(stage < index && index < observable);
    let local = strip_comments(include_str!("pty_manager/spawn.rs"));
    assert!(local.find("session_bindings.stage_process(leaf, &id)").unwrap()
        < local.find("app_state.identity.index(").unwrap());
    let reserve = renderer.find("pub(crate) async fn spawn_unowned_routed(").unwrap();
    let body = &renderer[reserve..renderer[reserve..].find("pub(crate) async fn spawn_routed(").unwrap() + reserve];
    assert!(body.find("begin_headless_create(").unwrap() < body.find("spawn_routed(state, req).await").unwrap());
    assert!(body.contains("creating.complete(process,"));
}

#[test]
fn live_window_inventory_cannot_infer_a_missing_leaf_after_all_release_attempts_fail() {
    let mut rig = Rig::new();
    let create = rig.create("leaf", "live-window");
    rig.finish(create, "pc-p");
    rig.bindings.reconcile_windows(&HashSet::from(["live-window".to_string()]), rig.now);
    rig.reap(rig.now + INTENT_TTL);
    assert_eq!(rig.bindings.holder("leaf").as_deref(), Some("live-window"));
    assert!(rig.closed.is_empty());
    assert!(rig.recovered.is_empty());
}

#[test]
fn binding_answers_have_the_renderer_wire_shape() {
    assert_eq!(serde_json::to_value(bound("shell")).unwrap(), serde_json::json!({"status":"bound","processId":"shell"}));
    assert_eq!(serde_json::to_value(BindResult::Pending).unwrap(), serde_json::json!({"status":"pending"}));
    assert_eq!(serde_json::to_value(BindResult::Refused).unwrap(), serde_json::json!({"status":"refused"}));
    assert_eq!(serde_json::to_value(BindResult::None).unwrap(), serde_json::json!({"status":"none"}));
}
