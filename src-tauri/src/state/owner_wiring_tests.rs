use super::source_scan::{fn_body, fn_spans, production};
use std::path::Path;

fn sources(root: &Path, here: &Path, out: &mut Vec<(String, String)>) {
    for entry in std::fs::read_dir(here).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_string_lossy();
        if name == "tests" || name.ends_with("_tests.rs") { continue; }
        if path.is_dir() { sources(root, &path, out); }
        else if path.extension().is_some_and(|s| s == "rs") {
            out.push((path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/"), production(&std::fs::read_to_string(path).unwrap())));
        }
    }
}
fn removals(text: &str) -> Vec<String> {
    if ![".owners.remove(", ".owners.retain(", ".owners.clear("].iter().any(|needle| text.contains(needle)) { return Vec::new(); }
    let spans = fn_spans(text);
    let mut hits = Vec::new();
    for needle in [".owners.remove(", ".owners.retain(", ".owners.clear("] {
        for (at, _) in text.match_indices(needle) {
            hits.push(spans.iter().find(|(_, r)| r.contains(&at)).map_or("outside_function", |(n, _)| n).to_string());
        }
    }
    hits.sort();
    hits
}
#[test]
fn only_the_shared_ending_can_remove_a_registered_or_closing_owner() {
    assert_eq!(removals("fn planted() { inner.owners.remove(leaf); }"), vec!["planted"]);
    assert!(removals(&production("#[cfg(test)] mod fixture { fn planted() { inner.owners.remove(leaf); } }")).is_empty());
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut scanned = Vec::new();
    sources(&root, &root, &mut scanned);
    for required in ["commands/terminal.rs", "state/host_port.rs", "state/owner_lifecycle.rs", "pty_manager/spawn.rs", "api_server/fleet.rs"] {
        assert!(scanned.iter().any(|(p, _)| p == required), "missing census input {required}");
    }
    let mut count = 0;
    for (path, text) in &scanned {
        let hits = removals(text);
        count += hits.len();
        if path == "state/host_keys/owners.rs" {
            assert_eq!(hits, vec!["abort_create", "complete_shell", "end_process"]);
            let complete = fn_body(text, "fn complete_shell(");
            assert!(complete.contains("OwnerState::Placing { stage: Some(s), .. } if s.process == shell.process"));
            assert!(complete.find("if staged_exited && cancel.is_none()").unwrap() < complete.find(".owners.remove(").unwrap());
            let abort = fn_body(text, "fn abort_create(");
            assert!(abort.find("matches!(r.state, OwnerState::Placing { .. })").unwrap() < abort.find(".owners.remove(").unwrap());
            let end = fn_body(text, "fn end_process(");
            assert!(end.contains("OwnerState::Registered(s), EndKind::Exit"));
            assert!(end.contains("OwnerState::Closing(s), EndKind::Close(_)"));
            assert!(end.find("storage(&leaf)").unwrap() < end.find(".owners.remove(").unwrap());
            assert!(end.find(".owners.remove(").unwrap() < end.find("Self::mark_end(").unwrap());
        } else { assert!(hits.is_empty(), "parallel owner remover in {path}: {hits:?}"); }
    }
    assert_eq!(count, 3);
}

#[test]
fn process_ingress_and_each_exit_caller_reach_the_owner_authority() {
    let commands = production(include_str!("../commands/terminal.rs"));
    for name in ["write_terminal", "resize_terminal", "adopt_console_window"] {
        let body = fn_body(&commands, &format!("fn {name}("));
        assert!(body.contains("keys().resolve_process("), "{name} lost process qualification");
    }
    for name in ["set_terminal_owning_tab", "set_terminal_display_label", "set_terminal_title_color"] {
        assert!(fn_body(&commands, &format!("fn {name}(")).contains("state.metadata_leaf("));
    }
    assert!(fn_body(&commands, "fn close_terminal(").contains("state.close_process(&id, crate::state::CloseStorage::Delete)"));
    let owner = production(include_str!("owner_lifecycle.rs"));
    assert!(fn_body(&owner, "fn metadata_leaf(").contains("keys().resolve_process(reference.trim(), true)"));
    assert!(fn_body(&owner, "fn close_process(").contains("keys().close_process(reference, policy)"));
    let end = fn_body(&owner, "fn end_shell(");
    assert!(end.contains("persist_history_snapshot(process, leaf"));
    assert!(end.contains("history_store.delete(leaf)"));
    assert!(end.contains("canvas_store.delete_edges_for(leaf)"));
    assert!(end.find("keys().end_process(").unwrap() < end.find("self.forget_host_terminal(process)").unwrap());
    let port = production(include_str!("host_port.rs"));
    assert!(fn_body(&port, "fn host_deps(").contains("st_exit.exit_process(&process_id)"));
    let terminals = production(include_str!("terminals.rs"));
    assert!(fn_body(&terminals, "fn ensure_elevated_host_inner(").contains("st_exit.exit_process(&process_id)"));
    assert!(fn_body(&terminals, "fn teardown_host_terminal(").contains("self.exit_process(id)"));
    let local = production(include_str!("../pty_manager/spawn.rs"));
    let spawn = fn_body(&local, concat!("fn spawn_", "terminal("));
    assert!(spawn.contains("app_state.exit_process(&thread_id)"));
    assert!(spawn.find("keys.restage_shell(").unwrap() < spawn.find("openpty(").unwrap());
    assert!(spawn.find("app_state.complete_create(").unwrap() < spawn.find("thread::spawn(").unwrap());
    let run = fn_body(&commands, "fn run_create(");
    assert!(run.find("ticket.publish_key(").unwrap() < run.find("register_host_terminal(").unwrap());
    assert_eq!(run.matches("state.complete_create(&id, cg, &staged)").count(), 2);

    let api = production(include_str!("../api_server/terminals/mod.rs"));
    assert!(fn_body(&api, "fn delete_terminal(").contains("state.close_process(&id, crate::state::CloseStorage::Preserve)"));
    assert!(fn_body(&api, "fn resize_terminal(").contains("keys().resolve_process(&id, false)"));
    assert!(fn_body(&api, "fn write_data_to_terminal(").contains("keys().resolve_process(id, false)"));
    assert!(fn_body(&api, "fn write_terminal(").contains("write_data_to_terminal(&state, &id"));
    let reset = fn_body(&api, "fn reset_terminal(");
    assert_eq!(reset.matches("Json(").count(), 1);
    assert!(!reset.contains("state."));
    let exec = production(include_str!("../api_server/exec.rs"));
    assert!(fn_body(&exec, "fn send_prompt_to_terminal<").contains("keys().resolve_process(id, false)"));
    for (name, operation) in [("execute_prompt", "send_prompt_to_terminal"), ("batch_execute_prompt", "send_prompt_to_terminal"), ("batch_write_terminal", "write_data_to_terminal")] {
        let body = fn_body(&exec, &format!("fn {name}("));
        assert!(body.contains("state.resolve_ref("));
        assert!(body.contains(operation));
    }
    let writer = production(include_str!("../automation/send.rs"));
    assert!(fn_body(&writer, "fn write(&self, pc: &str, bytes: &[u8]) -> Result<(), String> {").contains("keys().resolve_process(pc, false)"));
    let fleet = production(include_str!("../api_server/fleet.rs"));
    assert!(fn_body(&fleet, "fn fleet_close(").contains("state.close_process(&body.terminal_id, crate::state::CloseStorage::Preserve)"));
    let run = fn_body(&fleet, "fn fleet_local_run(");
    assert!(run.contains("state.resolve_ref(t)"));
    assert!(run.contains("send_prompt_to_terminal("));
    let ws = production(include_str!("../api_server/ws.rs"));
    let socket = fn_body(&ws, "fn handle_socket(");
    assert!(socket.contains("state.resolve_ref("));
    assert!(socket.contains("keys().resolve_process(terminal_id, false)"));
    let router = production(include_str!("../api_server/mod.rs"));
    assert!(router.contains("\"/api/terminals/:id/prompt\", post(execute_prompt)"));
    assert!(router.contains("\"/api/terminals/:id/execute\", post(execute_prompt)"));
}
