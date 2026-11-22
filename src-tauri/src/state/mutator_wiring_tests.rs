use super::source_scan::{without_test_modules, fn_spans};
use std::path::Path;

fn production(source: &str) -> String {
    // Keep URL literals intact; trimming at every `//` corrupts Rust strings.
    without_test_modules(source).lines().filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>().join("\n")
}

fn violations(source: &str) -> Vec<String> {
    fn_spans(source).into_iter().filter_map(|(name, span)| {
        let body = &source[span];
        let writes_shell = [".host_write(", ".host_resize(", "master.resize(", "tmux_manager::resize_session(", "console_window::adopt("].iter().any(|n| body.contains(n));
        let edits_metadata = body.contains("ingress::metadata(");
        if (writes_shell && !body.contains("ingress::registered_target("))
            || (edits_metadata && !body.contains("state.metadata_leaf(")) { Some(name) } else { None }
    }).collect()
}
fn walk(path: &Path, scanned: &mut Vec<(String, String)>) {
    for entry in std::fs::read_dir(path).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_string_lossy();
        if name == "tests" || name == "tests.rs" || name.ends_with("_tests.rs") { continue; }
        if path.is_dir() { walk(&path, scanned); }
        else if path.extension().is_some_and(|e| e == "rs") {
            scanned.push((path.to_string_lossy().replace('\\', "/"), production(&std::fs::read_to_string(&path).unwrap())));
        }
    }
}
#[test]
fn shell_forwarding_wrappers_require_registered_ingress_including_capture_reflow() {
    assert_eq!(violations("fn planted_reflow() { state.host_resize(&id, 91, 37); }"), vec!["planted_reflow"]);
    assert!(violations("fn control() { ingress::registered_target(keys, &id); state.host_resize(&id, 91, 37); }").is_empty());
    assert_eq!(violations("fn planted_metadata() { ingress::metadata(keys, maps, &leaf, change); }"), vec!["planted_metadata"]);
    assert!(violations(&production("// fn comment() { state.host_resize(&id, 1, 1); }\n#[cfg(test)] mod fixture { fn planted() { state.host_resize(&id, 1, 1); } }")).is_empty());
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut scanned = Vec::new();
    for area in ["commands", "api_server", "automation"] { walk(&root.join(area), &mut scanned); }
    for required in ["commands/terminal.rs", "api_server/capture.rs", "api_server/ws.rs", "api_server/exec.rs", "api_server/fleet.rs", "automation/send.rs"] {
        assert!(scanned.iter().any(|(p, _)| p.ends_with(required)), "missing census input {required}");
    }
    let mut forwarding = Vec::new();
    for (path, text) in scanned {
        let found = std::panic::catch_unwind(|| violations(&text)).unwrap_or_else(|_| panic!("cannot scan mutator source {path}"));
        assert!(found.is_empty(), "unqualified forwarding in {path}: {found:?}");
        for (name, span) in fn_spans(&text) {
            if text[span].contains(".host_resize(") { forwarding.push(name); }
        }
    }
    forwarding.sort();
    assert_eq!(forwarding, vec!["resize_terminal", "resize_terminal", "resize_with_reflow"]);
}
