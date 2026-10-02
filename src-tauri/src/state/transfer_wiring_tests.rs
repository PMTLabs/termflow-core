use super::source_scan::{fn_body, production};
use std::path::Path;

fn obsolete_calls(source: &str) -> Vec<String> {
    regex::Regex::new(r"\bhandoff_offers\s*\.\s*(offer|take|begin_create)\s*\(").unwrap()
        .captures_iter(&production(source)).map(|hit| hit[1].to_string()).collect()
}
fn scan(dir: &Path, root: &Path, found: &mut Vec<(String, Vec<String>)>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() { scan(&path, root, found); continue; }
        let name = path.file_name().unwrap().to_string_lossy();
        if path.extension().is_none_or(|ext| ext != "rs") || name.ends_with("_tests.rs") || name == "tests.rs" { continue; }
        let hits = obsolete_calls(&std::fs::read_to_string(&path).unwrap());
        if !hits.is_empty() { found.push((path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/"), hits)); }
    }
}

#[test]
fn transfer_paths_add_no_callers_to_the_compatibility_session_offer_table() {
    assert_eq!(obsolete_calls("fn planted() { state.handoff_offers.offer(&identity, leaf, pc, now); }"), vec!["offer"]);
    assert!(obsolete_calls("#[cfg(test)] mod tests { fn fixture() { state.handoff_offers.take(i, l, n); } }").is_empty());
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut found = Vec::new(); scan(&root, &root, &mut found);
    assert_eq!(found, vec![("commands/terminal.rs".into(), vec!["offer".into(), "take".into(), "begin_create".into()])]);
    let admitted = production(include_str!("../commands/panes.rs"));
    assert!(fn_body(&admitted, "fn create_admitted_terminal(").contains("admitted_work(window.label(), request.pg"));
    assert!(obsolete_calls(&admitted).is_empty());
}

#[test]
fn native_broker_build_and_wait_wrappers_preserve_page_qualification_outside_the_stream() {
    let drag = production(include_str!("../commands/drag.rs"));
    for (function, sink) in [
        ("begin_global_pane_drag", "begin_pane_drag(window.label(), pg"),
        ("claim_global_pane_drag", "claim_pane_drag(window.label(), pg"),
        ("resolve_orphan_global_drag", "end_pane_drag(window.label(), pg"),
        ("cancel_global_pane_drag", "end_pane_drag(window.label(), pg"),
        ("resolve_tab_drop", "route_pane_transfer(window.label(), pg"),
    ] {
        let body = fn_body(&drag, &format!("fn {function}("));
        assert!(body.contains("if let Some(pg) = pg"), "{function}");
        assert!(body.contains(sink), "{function}");
    }
    let window = production(include_str!("../commands/window.rs"));
    let build = fn_body(&window, "fn create_detached_window(");
    assert!(build.find("verify_transfer_source(window.label(), pg, &token)").unwrap() < build.find("builder.build()").unwrap());
    assert!(build.contains("watch_transfer(window.label(), pg, &token)"));
    assert!(build.contains("transfer_taken(taken).await"));
    let commands = production(include_str!("../commands/panes.rs"));
    let wait = fn_body(&commands, "fn wait_transfer_taken(");
    assert!(wait.contains("watch_transfer(window.label(), pg, &tx)?"));
    assert!(wait.contains("transfer_taken(receiver).await"));
    assert!(production(include_str!("../lib.rs")).contains("commands::wait_transfer_taken,"));
    let stream = fn_body(&commands, "fn pane_op(");
    assert!(!stream.contains("transfer_taken") && !stream.contains(".await"));
}
