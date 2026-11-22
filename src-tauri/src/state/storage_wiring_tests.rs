use super::source_scan::{fn_body, fn_spans, production, matching_brace};
use std::path::Path;

fn sources(root: &Path, here: &Path, out: &mut Vec<(String, String)>) {
    for entry in std::fs::read_dir(here).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_string_lossy();
        if name == "tests" || name == "tests.rs" || name.ends_with("_tests.rs") { continue; }
        if path.is_dir() { sources(root, &path, out); }
        else if path.extension().is_some_and(|s| s == "rs") {
            out.push((path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/"), production(&std::fs::read_to_string(path).unwrap())));
        }
    }
}
fn compact(text: &str) -> String { text.chars().filter(|c| !c.is_whitespace()).collect() }

// Membership comes from store access, not the allowlist. Unknown methods and
// new call sites fail closed. Alias writers are included separately below.
fn effects(text: &str) -> Vec<(String, String)> {
    let needles = ["history_store", "canvas_store", "persist_terminal_history(", "persist_history_snapshot(", "persist_snapshot(", "persist_registered_history("];
    let aliases = ["upsert", "rename_renderer_id", "prune", "add_command", "delete_command", "add_command_dir"];
    if !needles.iter().any(|needle| text.contains(needle))
        && !aliases.iter().any(|method| text.contains(&format!("store.{method}("))) { return vec![]; }
    let spans = fn_spans(text);
    let mut hits = Vec::new();
    for needle in needles {
        for (at, _) in text.match_indices(needle) {
            let Some((name, range)) = spans.iter().filter(|(_, r)| r.contains(&at)).min_by_key(|(_, r)| r.len()) else { continue };
            let rest = &text[at + needle.len()..range.end];
            let method = if needle.ends_with('(') { needle.trim_end_matches('(').to_string() } else {
                let Some(rest) = rest.trim_start().strip_prefix('.') else { continue };
                rest.trim_start().chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect()
            };
            hits.push((name.clone(), method));
        }
    }
    // History handles are cloned into workers; inspect their write methods too.
    for method in aliases {
        for (at, _) in text.match_indices(&format!("store.{method}(")) {
            if text[..at].chars().next_back().is_some_and(|c| c.is_alphanumeric() || c == '_') { continue; }
            let name = spans.iter().filter(|(_, r)| r.contains(&at)).min_by_key(|(_, r)| r.len()).unwrap().0.clone();
            hits.push((name, method.into()));
        }
    }
    hits
}
fn allowed(path: &str, function: &str, method: &str) -> bool {
    match method {
        "clone" | "get" | "get_by_id" | "all_edges" | "edges_for" => true,
        "init" | "prune_commands" | "prune_dir_usage" => path == "lib.rs" && function == "run",
        "persist_terminal_history" => path == "history_flush.rs" && ["flush_dirty_history", "flush_all_history"].contains(&function),
        "persist_registered_history" => path == "state/history.rs" && function == "persist_terminal_history",
        "persist_history_snapshot" => path == "state/owner_lifecycle.rs" && function == "end_shell",
        "persist_snapshot" => path == "state/history.rs" && ["persist_registered_history", "persist_history_snapshot"].contains(&function),
        "upsert" => path == "state/history.rs" && function == "persist_snapshot",
        "delete" | "delete_edges_for" => path == "state/owner_lifecycle.rs" && function == "end_shell",
        "insert_edge" => (path == "api_server/terminals/mod.rs" && function == "create_terminal") || (path == "canvas_endpoints.rs" && function == "create_edge"),
        "delete_edge" => path == "canvas_endpoints.rs" && function == "delete_edge",
        "update_label" => path == "canvas_endpoints.rs" && function == "patch_edge",
        "rename_renderer_id" => path == "commands/config_history.rs" && function == "rename_terminal_history",
        "prune" => path == "commands/config_history.rs" && function == "prune_terminal_history",
        "add_command" => path == "commands/config_history.rs" && function == "add_command_history",
        "delete_command" => path == "commands/config_history.rs" && function == "delete_command_history",
        "add_command_dir" => path == "commands/config_history.rs" && function == "add_command_dir_usage",
        _ => false,
    }
}
fn unlisted(path: &str, text: &str) -> Vec<(String, String)> {
    let hits = effects(text);
    hits.iter().filter(|(function, method)| {
        !allowed(path, function, method) || (
            !["clone", "get", "get_by_id", "all_edges", "edges_for", "init"].contains(&method.as_str())
            && hits.iter().filter(|hit| hit.0 == *function && hit.1 == *method).count() != 1
        )
    }).cloned().collect()
}
fn contains_section(body: &str, section: &str, effect: &str) {
    let at = body.find(section).unwrap_or_else(|| panic!("missing {section}"));
    let open = at + body[at..].find('{').unwrap();
    let close = matching_brace(body, open);
    assert!(body[open..close].contains(effect), "{effect} escaped {section}");
}

#[test]
fn storage_effect_population_is_classified_and_wired_to_qualified_or_leaf_intent_sections() {
    let planted = "fn rogue() { state.history_store.upsert(leaf, bytes, now); state.canvas_store.insert_edge(edge); }";
    assert_eq!(unlisted("new.rs", planted).len(), 2);
    assert_eq!(unlisted("new.rs", "fn rogue(store: &HistoryStore) { store.upsert(leaf, bytes, now); }").len(), 1);
    assert!(unlisted("new.rs", &production(&format!("#[cfg(test)] mod fixtures {{ {planted} }}"))).is_empty());
    assert_eq!(unlisted("canvas_endpoints.rs", "fn create_edge() { state.canvas_store.rogue_write(); }").len(), 1);
    assert_eq!(unlisted("canvas_endpoints.rs", "fn create_edge() { state.canvas_store.insert_edge(edge); state.canvas_store.insert_edge(extra); }").len(), 2);
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut scanned = Vec::new(); sources(&root, &root, &mut scanned);
    for required in ["history_flush.rs", "state/history.rs", "state/owner_lifecycle.rs", "canvas_endpoints.rs", "commands/config_history.rs", "api_server/terminals/mod.rs", "lib.rs"] {
        assert!(scanned.iter().any(|(path, _)| path == required), "missing census input {required}");
    }
    let mut count = 0;
    for (path, text) in &scanned {
        count += effects(text).len();
        assert!(unlisted(path, text).is_empty(), "unclassified storage access in {path}: {:?}", unlisted(path, text));
        assert!(!text.contains("history_persist_locks"));
    }
    assert!(count > 30, "the census must observe the real population");
    let history = production(include_str!("history.rs"));
    let qualified = fn_body(&history, "fn persist_registered_history(");
    assert!(qualified.contains("keys.write(leaf, process, || persist_snapshot("));
    assert!(fn_body(&history, "fn persist_terminal_history(").contains("persist_registered_history(self.host_table.keys()"));
    let flush = production(include_str!("../history_flush.rs"));
    for name in ["flush_dirty_history", "flush_all_history"] {
        assert!(fn_body(&flush, &format!("fn {name}(")).contains("state.persist_terminal_history(&id, now)"));
    }
    assert!(fn_body(&flush, "fn spawn_history_flush_task(").contains("spawn_blocking(move || flush_dirty_history(&state))"));
    let owner = production(include_str!("owner_lifecycle.rs"));
    let end = fn_body(&owner, "fn end_shell(");
    contains_section(&end, "keys().end_process(", "self.history_store.delete(leaf)");
    contains_section(&end, "keys().end_process(", "self.persist_history_snapshot(process, leaf");
    contains_section(&end, "keys().end_process(", "self.canvas_store.delete_edges_for(leaf)");
    let api = production(include_str!("../api_server/terminals/mod.rs"));
    let auto = compact(&fn_body(&api, "fn create_terminal("));
    assert!(auto.find("letparent_process=").unwrap() < auto.find("letspawned=").unwrap());
    assert_eq!(auto.matches("resolve_process(parent,false)").count(), 1);
    assert!(auto.contains("write_shells(&[(&edge.from_id,&parent_process),(&edge.to_id,&process),],||worker.canvas_store.insert_edge(&edge))"));
    let canvas = production(include_str!("../canvas_endpoints.rs"));
    assert!(compact(&fn_body(&canvas, "fn create_edge(")).contains("with_leaves(&[&edge.from_id,&edge.to_id],||state.canvas_store.insert_edge(&edge))"));
    assert!(fn_body(&canvas, "fn edit_stored_edge<").contains("with_leaves(&[&edge.from_id, &edge.to_id], edit)"));
    for name in ["delete_edge", "patch_edge"] {
        assert!(fn_body(&canvas, &format!("fn {name}(")).contains("edit_stored_edge("));
        assert!(fn_body(&canvas, &format!("fn {name}(")).contains("spawn_blocking("));
    }
    let config = production(include_str!("../commands/config_history.rs"));
    assert!(fn_body(&config, "fn rename_terminal_history(").contains("with_leaves(&[&from, &to], || store.rename_renderer_id(&from, &to))"));
    assert!(fn_body(&config, "fn prune_terminal_history(").contains("with_all(|| store.prune(&keep))"));
}

fn inversions(text: &str) -> Vec<String> {
    let mut hits = Vec::new();
    // Ownership is confined to HostKeys::lock. Bound each named guard by its
    // lexical block (or explicit drop), rather than flagging an earlier lookup.
    for declaration in ["let inner = self.lock();", "let mut inner = self.lock();"] {
        for (at, _) in text.match_indices(declaration) {
            let mut enclosing = (0, text.len());
            for (open, _) in text[..at].match_indices('{') {
                let end = matching_brace(text, open);
                if end > at && open >= enclosing.0 { enclosing = (open, end); }
            }
            let tail = &text[at + declaration.len()..enclosing.1];
            let until = tail.find("drop(inner)").unwrap_or(tail.len());
            if tail[..until].contains("leaf_storage::with_") { hits.push(declaration.into()); }
        }
    }
    hits
}
fn nested_sections(text: &str) -> Vec<String> {
    let mut hits = Vec::new();
    for operation in [".write(", ".write_shells(", ".end_process("] {
        for (at, _) in text.match_indices(operation) {
            if operation == ".write(" && !text[..at].ends_with("keys") && !text[..at].ends_with("keys()") { continue; }
            let after = &text[at..];
            let Some(closure) = after.find("||").or_else(|| after.find("|leaf|")) else { continue };
            let tail = &after[closure..];
            let Some(open) = tail.find('{') else { continue };
            // Expression-only closures end at the call's semicolon, not at a
            // brace in a later unrelated statement.
            if tail.find(';').is_some_and(|semi| semi < open) { continue; }
            let block = &tail[open..=matching_brace(tail, open)];
            if [".write(", ".write_shells(", ".end_process(", ".end_shell(", ".persist_terminal_history("].iter().any(|needle| block.contains(needle)) {
                hits.push(operation.into());
            }
        }
    }
    hits
}
#[test]
fn storage_sections_do_not_nest_or_acquire_a_stripe_under_ownership() {
    assert_eq!(inversions("fn planted() { let inner = self.lock(); leaf_storage::with_leaves(leaves, edit); } ").len(), 1);
    assert!(inversions("fn control() { let leaf = { let inner = self.lock(); find(inner) }; leaf_storage::with_leaves(leaves, edit); }").is_empty());
    assert_eq!(nested_sections("fn planted() { keys.write(leaf, pc, || { keys.end_process(pc, kind, |_| {}); }); }").len(), 1);
    assert_eq!(nested_sections("fn planted() { keys.write(leaf, pc, || { keys.write(leaf, pc, || {}); }); }").len(), 1);
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut scanned = Vec::new(); sources(&root, &root, &mut scanned);
    for (path, text) in scanned {
        assert!(nested_sections(&text).is_empty(), "nested storage closure in {path}");
        if path.starts_with("state/host_keys") { assert!(inversions(&text).is_empty(), "inverse lock acquisition in {path}"); }
        if ["history_store.rs", "canvas_store.rs"].contains(&path.as_str()) {
            assert!(!text.contains("leaf_storage::") && !text.contains(".end_process(") && !text.contains(".write_shells("), "store-internal code must remain a lock-order leaf: {path}");
        }
    }
    let owners = production(include_str!("host_keys/owners.rs"));
    let write = fn_body(&owners, "fn write_shells<");
    contains_section(&write, "leaf_storage::with_leaves(", "let inner = self.lock()");
    assert!(write.contains("OwnerState::Registered(shell) if shell.process == *process"));
    assert!(write.find("if valid { Some(storage()) }").unwrap() > write.find("let valid = {").unwrap());
    let end = fn_body(&owners, "fn end_process(");
    contains_section(&end, "leaf_storage::with_leaves(", "storage(&leaf)");
    contains_section(&end, "leaf_storage::with_leaves(", "inner.owners.remove(&leaf)");
    contains_section(&end, "leaf_storage::with_leaves(", "Self::mark_end(");
    let section_at = end.find("leaf_storage::with_leaves(").unwrap();
    let open = section_at + end[section_at..].find('{').unwrap();
    assert!(end.find("Self::send(").unwrap() > matching_brace(&end, open));
    assert!(fn_body(&production(include_str!("host_keys.rs")), "fn mark_end(").find("Self::send(").is_none());
}
