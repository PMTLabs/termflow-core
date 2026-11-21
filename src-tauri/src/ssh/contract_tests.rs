//! Plan 070 T1: SSH IPC contract censuses (ledger: termflow-fabric docs/progress/123, section T1).
//!
//! Lexical inventory, not a proof that a link works; the ledger's named behavioural tests do that.
//! Every census walks the whole source tree (a moved or split file cannot empty it), matches syntax
//! rather than a hand-picked name list, normalises CRLF, ignores comments and test-only code, and
//! asserts its sets are non-empty before comparing them (positive control).
//!
//! Calibration (the final pass plants each and reverts it; each must turn the named test red):
//! - `ssh_contract_every_ssh_command_is_registered_once`: delete `$crate::commands::ssh_fs_stat` from
//!   the `ssh_handlers!` body (declared but unregistered); add it again to lib.rs's extras (registered
//!   twice); register a name that has no `#[tauri::command]` (registered but undeclared).
//! - `ssh_contract_every_emitted_ssh_event_is_named_in_the_ledger`: emit a new `"ssh-x:y"` literal
//!   from production code, or delete the `"ssh-fs:cwd"` emit in output_pipeline.rs.
//! - `ssh_contract_no_ssh_handler_on_rest_or_mcp`: add a `.route("/api/ssh/...")` or call into
//!   `crate::ssh::` from api_server, or register an `ssh_*` tool in mcp-server/src.

use regex::Regex;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// Events emitted on this branch (LANDED rows only).
const LEDGER_EVENTS: &[&str] = &[
    "ssh-fs:cwd",        // 068 output_pipeline.rs -> sshBridge onFsCwd
    "ssh-fs:edit-state", // 068 ssh/sftp/edit.rs AppEditEvents -> sshBridge onFsEditState
    "ssh-session:state", // 067 ssh/session.rs publish_locked -> tauri-bridge onSshSessionState
    "ssh-store:changed", // 065 commands/ssh_store.rs CHANGED -> sshBridge onChanged
    "ssh-test:state",    // 067 ssh/session.rs publish_locked (probe) -> tauri-bridge onSshTestState
];
// 070-rebase: PENDING after the sibling rebases, not asserted yet; move into LEDGER_EVENTS then.
//   "ssh-launch:state"    (066 ssh/launch/drive.rs)
//   "ssh-metrics:sample"  (069 ssh/metrics/sampler.rs SAMPLE)
//   "ssh-metrics:control" (069 ssh/metrics/sampler.rs CONTROL)

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// Every file under `dir` with one of `extensions`, as (path relative to `root`, LF text).
fn walk(dir: &Path, root: &Path, extensions: &[&str], out: &mut Vec<(String, String)>) {
    for entry in std::fs::read_dir(dir).expect("source directory") {
        let path = entry.expect("source entry").path();
        if path.is_dir() {
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            if name != "node_modules" && name != "target" && name != "dist" {
                walk(&path, root, extensions, out);
            }
            continue;
        }
        let ext = path.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default();
        if !extensions.contains(&ext.as_str()) {
            continue;
        }
        let relative = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
        let text = std::fs::read_to_string(&path).expect("read source").replace("\r\n", "\n");
        out.push((relative, text));
    }
}

fn is_test_file(relative: &str) -> bool {
    let name = relative.rsplit('/').next().unwrap_or(relative);
    name.ends_with("_tests.rs")
        || name == "tests.rs"
        || name.ends_with("test_server.rs")
        || relative.contains("/tests/")
        || relative.starts_with("tests/")
}

/// Production Rust under `src/`: comments blanked, test-only modules and functions removed.
fn production_rust() -> Vec<(String, String)> {
    let root = crate_dir().join("src");
    let mut files = Vec::new();
    walk(&root, &root, &["rs"], &mut files);
    files
        .into_iter()
        .filter(|(relative, _)| !is_test_file(relative))
        .map(|(relative, text)| (relative, without_test_items(&without_comments(&text))))
        .collect()
}

fn utf8_width(lead: u8) -> usize {
    match lead {
        0x00..=0x7f => 1,
        0xc0..=0xdf => 2,
        0xe0..=0xef => 3,
        _ => 4,
    }
}

/// End (exclusive) of the string literal opening at `open` (plain, byte or raw).
fn string_end(src: &str, open: usize) -> usize {
    let b = src.as_bytes();
    let hashes = b[..open].iter().rev().take_while(|c| **c == b'#').count();
    let raw = open > hashes && b[open - hashes - 1] == b'r';
    let start = open + 1;
    if raw {
        let close = format!("\"{}", "#".repeat(hashes));
        return src[start..].find(&close).map_or(b.len(), |at| start + at + close.len());
    }
    let mut i = start;
    while i < b.len() && b[i] != b'"' {
        i += if b[i] == b'\\' { 2 } else { 1 };
    }
    (i + 1).min(b.len())
}

/// End (exclusive) of a char literal at `open`, or `open + 1` for a lifetime (`'a`, `'static`).
fn char_end(b: &[u8], open: usize) -> usize {
    if b.get(open + 1) == Some(&b'\\') {
        let mut j = open + 3;
        while j < b.len() && j < open + 12 && b[j] != b'\'' {
            j += 1;
        }
        return if b.get(j) == Some(&b'\'') { j + 1 } else { open + 1 };
    }
    let Some(lead) = b.get(open + 1) else { return open + 1 };
    let after = open + 1 + utf8_width(*lead);
    if b.get(after) == Some(&b'\'') {
        after + 1
    } else {
        open + 1
    }
}

/// Comments replaced by spaces (byte offsets kept); string and char literals kept verbatim.
fn without_comments(src: &str) -> String {
    let b = src.as_bytes();
    let mut out = b.to_vec();
    let mut i = 0;
    while i < b.len() {
        if b[i..].starts_with(b"//") {
            let end = src[i..].find('\n').map_or(b.len(), |n| i + n);
            out[i..end].fill(b' ');
            i = end;
        } else if b[i..].starts_with(b"/*") {
            let start = i;
            let mut depth = 1;
            i += 2;
            while i < b.len() && depth > 0 {
                if b[i..].starts_with(b"/*") {
                    depth += 1;
                    i += 2;
                } else if b[i..].starts_with(b"*/") {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            for c in &mut out[start..i.min(b.len())] {
                if *c != b'\n' {
                    *c = b' ';
                }
            }
        } else if b[i] == b'"' {
            i = string_end(src, i);
        } else if b[i] == b'\'' {
            i = char_end(b, i);
        } else {
            i += 1;
        }
    }
    String::from_utf8(out).expect("comment blanking keeps UTF-8")
}

/// Index of the bracket closing the one at `open`, skipping string and char literals.
fn closing(src: &str, open: usize) -> usize {
    let b = src.as_bytes();
    let (opener, closer) = match b[open] {
        b'{' => (b'{', b'}'),
        b'[' => (b'[', b']'),
        _ => (b'(', b')'),
    };
    let mut depth = 0usize;
    let mut i = open;
    while i < b.len() {
        match b[i] {
            b'"' => {
                i = string_end(src, i);
                continue;
            }
            b'\'' => {
                i = char_end(b, i);
                continue;
            }
            c if c == opener => depth += 1,
            c if c == closer => {
                depth -= 1;
                if depth == 0 {
                    return i;
                }
            }
            _ => {}
        }
        i += 1;
    }
    panic!("unbalanced bracket at byte {open}");
}

/// True only for a cfg that holds in test builds alone: `test` or `all(.., test, ..)`.
/// `any(windows, test)` is production code on Windows and must stay in the census.
fn test_only_cfg(cfg: &str) -> bool {
    let cfg = cfg.trim();
    cfg == "test" || (cfg.starts_with("all(") && Regex::new(r"[(,]\s*test\s*[,)]").unwrap().is_match(cfg))
}

/// `#[cfg(test)]` (or `all(test, ..)`) modules and functions cut out of comment-free text.
fn without_test_items(src: &str) -> String {
    let item = Regex::new(
        r"#\[cfg\(([^\]]*)\)\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?(mod|(?:async\s+)?fn)\s+\w+",
    )
    .unwrap();
    let mut text = src.to_owned();
    let mut from = 0;
    loop {
        // Scoped so the Captures borrow of `text` ends before the text is edited.
        let step: Result<(usize, usize), usize> = {
            let Some(found) = item.captures_at(&text, from) else { break };
            let whole = found.get(0).unwrap();
            if test_only_cfg(&found[1]) {
                let rest = &text[whole.end()..];
                let brace = rest.find('{').map(|at| whole.end() + at);
                let semi = rest.find(';').map(|at| whole.end() + at);
                let end = match (&found[2] == "mod", semi, brace) {
                    (true, Some(s), Some(b)) if s < b => s + 1,
                    (true, Some(s), None) => s + 1,
                    (_, _, Some(b)) => closing(&text, b) + 1,
                    _ => text.len(),
                };
                Ok((whole.start(), end))
            } else {
                Err(whole.end())
            }
        };
        match step {
            Ok((start, end)) => {
                text.replace_range(start..end, "");
                from = start;
            }
            Err(next) => from = next,
        }
    }
    text
}

/// Up to 40 characters from `at`, for a failure message (never splits a UTF-8 character).
fn excerpt(text: &str, at: usize) -> String {
    text[at..].chars().take(40).collect()
}

fn line_of(text: &str, at: usize) -> usize {
    text[..at].matches('\n').count() + 1
}

#[test]
fn ssh_contract_every_ssh_command_is_registered_once() {
    let files = production_rust();
    assert!(files.len() > 50, "positive control: the walk found the crate ({} files)", files.len());

    // Declarations: every #[tauri::command] fn; any in an SSH module must be ssh_-prefixed.
    let command = Regex::new(
        r"#\[tauri::command[^\]]*\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)",
    )
    .unwrap();
    let mut declared: BTreeMap<String, String> = BTreeMap::new();
    let mut ssh_module_commands = 0;
    for (relative, text) in &files {
        let ssh_module = relative.starts_with("ssh/") || relative.starts_with("commands/ssh");
        for found in command.captures_iter(text) {
            let name = found[1].to_owned();
            if ssh_module {
                ssh_module_commands += 1;
                assert!(name.starts_with("ssh_"), "{relative}: SSH command {name} escapes the ssh_ census");
            }
            if name.starts_with("ssh_") {
                let at = format!("{relative}:{}", line_of(text, found.get(0).unwrap().start()));
                if let Some(previous) = declared.insert(name.clone(), at.clone()) {
                    panic!("{name} declared twice: {previous} and {at}");
                }
            }
        }
    }
    assert!(ssh_module_commands > 0, "positive control: SSH command modules were scanned");
    assert!(!declared.is_empty(), "positive control: ssh_ commands declared");

    // Registrations: every generate_handler!/ssh_handlers! body (the shared macro and lib.rs's
    // invocation with its extras), counted with multiplicity by the last path segment.
    let handler = Regex::new(r"\b(generate_handler|ssh_handlers)!\s*\[").unwrap();
    let mut registered: BTreeMap<String, usize> = BTreeMap::new();
    let mut lib_uses_macro = false;
    for (relative, text) in &files {
        for found in handler.captures_iter(text) {
            let open = found.get(0).unwrap().end() - 1;
            let body = &text[open + 1..closing(text, open)];
            if relative == "lib.rs" && &found[1] == "ssh_handlers" {
                lib_uses_macro = true;
            }
            for item in body.split(',').map(str::trim) {
                if item.is_empty() || !item.chars().all(|c| c.is_alphanumeric() || c == '_' || c == ':' || c == '$') {
                    continue;
                }
                let last = item.rsplit("::").next().unwrap();
                if last.starts_with("ssh_") {
                    *registered.entry(last.to_owned()).or_default() += 1;
                }
            }
        }
    }
    assert!(lib_uses_macro, "lib.rs must register through ssh_handlers!");
    assert!(!registered.is_empty(), "positive control: ssh_ handlers registered");
    let not_once: Vec<_> = registered.iter().filter(|(_, n)| **n != 1).collect();
    assert!(not_once.is_empty(), "registered other than exactly once: {not_once:?}");

    let declared_names: BTreeSet<&String> = declared.keys().collect();
    let registered_names: BTreeSet<&String> = registered.keys().collect();
    let unregistered: Vec<_> = declared_names.difference(&registered_names).map(|n| (n, &declared[*n])).collect();
    let undeclared: Vec<_> = registered_names.difference(&declared_names).collect();
    assert!(unregistered.is_empty(), "declared but not registered: {unregistered:?}");
    assert!(undeclared.is_empty(), "registered without a #[tauri::command] declaration: {undeclared:?}");
}

#[test]
fn ssh_contract_every_emitted_ssh_event_is_named_in_the_ledger() {
    let files = production_rust();
    // Emitters go through wrappers (EventSink::emit, StoreEmitter::changed, `const CHANGED`), so the
    // event name is taken from the literal itself; its file must still contain an emit call.
    let literal = Regex::new(r#""(ssh-[a-z-]+:[a-z-]+)""#).unwrap();
    let emit = Regex::new(r"\bemit(?:_to)?\s*\(").unwrap();
    let mut emitted: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (relative, text) in &files {
        for found in literal.captures_iter(text) {
            assert!(emit.is_match(text), "{relative}: {} named outside an emitting file", &found[1]);
            let at = format!("{relative}:{}", line_of(text, found.get(0).unwrap().start()));
            emitted.entry(found[1].to_owned()).or_default().push(at);
        }
    }
    assert!(!emitted.is_empty(), "positive control: ssh event literals found");
    let actual: BTreeSet<&str> = emitted.keys().map(String::as_str).collect();
    let ledger: BTreeSet<&str> = LEDGER_EVENTS.iter().copied().collect();
    assert_eq!(actual, ledger, "emitted ssh events vs ledger (sites: {emitted:?})");
}

#[test]
fn ssh_contract_no_ssh_handler_on_rest_or_mcp() {
    let ssh = Regex::new(r"(?i)\bssh").unwrap();

    // REST/fleet: every production file that builds an axum router, found by syntax, plus the whole
    // api_server tree (fleet, terminals, ws, exec, ...).
    let router = Regex::new(r"\bRouter\s*::\s*new\s*\(|\.route\s*\(").unwrap();
    let files = production_rust();
    let rest: Vec<&(String, String)> = files
        .iter()
        .filter(|(relative, text)| relative.starts_with("api_server/") || router.is_match(text))
        .collect();
    let routes: usize = rest.iter().map(|(_, text)| router.find_iter(text).count()).sum();
    assert!(rest.iter().any(|(relative, _)| relative == "api_server/mod.rs"), "positive control: REST router found");
    assert!(routes > 10, "positive control: REST routes found ({routes})");
    for (relative, text) in &rest {
        if let Some(found) = ssh.find(text) {
            panic!("{relative}:{} reaches SSH from REST: {:?}", line_of(text, found.start()), excerpt(text, found.start()));
        }
    }

    // MCP sidecar: the whole mcp-server/src tree (TypeScript), tests excluded, comments stripped.
    let mcp_root = crate_dir().join("..").join("mcp-server").join("src");
    let mut mcp = Vec::new();
    walk(&mcp_root, &mcp_root, &["ts"], &mut mcp);
    let mcp: Vec<(String, String)> = mcp.into_iter().filter(|(relative, _)| !relative.contains(".test.")).collect();
    assert!(!mcp.is_empty(), "positive control: mcp-server/src found");
    assert!(
        mcp.iter().any(|(_, text)| text.contains("get_terminal_output")),
        "positive control: MCP tool registrations found"
    );
    let block = Regex::new(r"(?s)/\*.*?\*/").unwrap();
    let line = Regex::new(r"(?m)^\s*//.*$").unwrap();
    for (relative, text) in &mcp {
        let code = line.replace_all(&block.replace_all(text, ""), "").into_owned();
        if let Some(found) = ssh.find(&code) {
            panic!("mcp-server/src/{relative} reaches SSH: {:?}", excerpt(&code, found.start()));
        }
    }
}
