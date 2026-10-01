//! Source censuses for the lifecycle entry points. Exercising the real thing
//! needs a Tauri `AppHandle`, which the Windows test binary cannot build, so these
//! pin the WIRING from source: which entry point each exit, offload and update
//! path goes through, and in what order. They are class guards: a new path that
//! skips the quiesce, or closes a host it never disarmed, fails them.

use std::path::{Path, PathBuf};

fn src_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

fn read(rel: &str) -> String {
    let path = src_dir().join(rel);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read {} ({e})", path.display()))
        .replace("\r\n", "\n")
}

/// The text before the first `#[cfg(test)]`: what ships.
fn production(src: &str) -> &str {
    src.split("#[cfg(test)]").next().unwrap_or(src)
}

fn strip_comments(code: &str) -> String {
    code.lines()
        .map(|line| line.find("//").map_or(line, |i| &line[..i]))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The body of `fn <signature>`, found by counting braces from its opening `{`,
/// comments stripped. Fails loudly when the function is gone: a guard that cannot
/// find what it guards must not pass.
fn fn_body(src: &str, signature: &str) -> String {
    let start = src
        .find(signature)
        .unwrap_or_else(|| panic!("`{signature}` not found — this guard must fail loudly, not pass vacuously"));
    let rest = &src[start..];
    let open = rest.find('{').expect("no body");
    let mut depth = 0usize;
    for (i, c) in rest[open..].char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return strip_comments(&rest[open..open + i + 1]);
                }
            }
            _ => {}
        }
    }
    panic!("unbalanced braces after `{signature}`");
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// Every production source file, as `(path relative to src, text without tests)`.
/// Files that are only tests (`*_tests.rs`, `tests/`) are not production.
fn production_sources() -> Vec<(String, String)> {
    let mut files = Vec::new();
    rust_files(&src_dir(), &mut files);
    files
        .into_iter()
        .filter(|p| {
            let name = p.file_name().unwrap().to_string_lossy();
            !name.ends_with("_tests.rs") && name != "fake_hosts.rs" && !name.starts_with("test_")
        })
        .map(|p| {
            let rel = p.strip_prefix(src_dir()).unwrap().to_string_lossy().replace('\\', "/");
            let text = std::fs::read_to_string(&p).unwrap().replace("\r\n", "\n");
            let text = strip_comments(production(&text));
            (rel, text)
        })
        .collect()
}

fn position(body: &str, needle: &str) -> usize {
    body.find(needle).unwrap_or_else(|| panic!("`{needle}` not found in:\n{body}"))
}

#[test]
fn every_exit_offload_and_update_path_goes_through_a_quiesce() {
    // Each entry point takes its admission closure from the lifecycle module...
    let exit = fn_body(&read("commands/window.rs"), "pub fn disarm_then_exit");
    assert!(exit.contains(".exit_hosts()"), "the quit path must release every host: {exit}");
    let offload = fn_body(&read("commands/update.rs"), "pub async fn restart_for_update");
    let relaunch = fn_body(&read("commands/update.rs"), "pub async fn restart_keeping_terminals");
    for (name, body) in [("restart_for_update", &offload), ("restart_keeping_terminals", &relaunch)] {
        assert!(
            position(body, ".begin_offload()") < position(body, ".arm_detach("),
            "{name}: admission is closed BEFORE any host is armed: {body}"
        );
        assert!(
            position(body, ".arm_detach(") < position(body, ".exit("),
            "{name}: armed before exiting: {body}"
        );
    }
    let update = fn_body(&read("updater.rs"), "pub async fn update_and_restart");
    assert!(
        position(&update, "check_and_download") < position(&update, ".begin_update()")
            && position(&update, ".begin_update()") < position(&update, "arm_siblings(")
            && position(&update, ".begin_update()") < position(&update, ".arm_detach("),
        "the update commit closes admission after the download and before anything is armed: {update}"
    );

    // ...and that module is where the quiesce is taken, with the right reason.
    let lifecycle = read("state/host_lifecycle.rs");
    let lifecycle = production(&lifecycle);
    assert!(fn_body(lifecycle, "async fn exit_hosts").contains("QuiesceReason::Exit"));
    assert!(fn_body(lifecycle, "async fn begin_hold").contains(".quiesce(reason"));
    assert!(fn_body(lifecycle, "async fn begin_offload").contains("QuiesceReason::Offload"));
    assert!(fn_body(lifecycle, "async fn begin_update").contains("QuiesceReason::Update"));
}

#[test]
fn only_the_lifecycle_module_closes_admission() {
    // Quiescers are exactly exit and the offload/update hold: two call sites.
    let mut callers = Vec::new();
    for (file, text) in production_sources() {
        for _ in text.matches(".quiesce(") {
            callers.push(file.clone());
        }
    }
    callers.sort();
    assert_eq!(
        callers,
        ["state/host_lifecycle.rs", "state/host_lifecycle.rs"],
        "a new `.quiesce(` call is a new lifecycle path: route it through host_lifecycle"
    );
}

#[test]
fn no_path_closes_a_host_without_a_disarm() {
    let lifecycle = read("state/host_lifecycle.rs");
    let lifecycle = strip_comments(production(&lifecycle));
    let release = fn_body(&lifecycle, "async fn release_host");
    let (disarm, shutdown, close) = (
        position(&release, "client.disarm("),
        position(&release, "client.shutdown("),
        position(&release, "client.close_transport("),
    );
    assert!(disarm < shutdown && shutdown < close, "disarm, then announce, then close: {release}");

    // The one place a host is closed, and the one place it is announced to.
    assert_eq!(lifecycle.matches("close_transport(").count(), 1, "{lifecycle}");
    assert_eq!(lifecycle.matches("client.shutdown(").count(), 1, "{lifecycle}");

    // Both ways of releasing an owned host (connected, or reached just for the
    // purpose) end in it.
    assert!(fn_body(&lifecycle, "async fn exit_one").contains("release_host("));
    assert!(fn_body(&lifecycle, "async fn reach_and_release").contains("release_host("));
}

#[test]
fn no_one_arms_a_host_except_through_the_all_or_nothing_helper() {
    for (file, text) in production_sources() {
        if file == "pty_host_client.rs" || file == "state/host_lifecycle.rs" {
            continue;
        }
        for (at, _) in text.match_indices(".arm_detach(") {
            let receiver: String = text[..at].trim_end().chars().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect();
            assert_ne!(receiver, "client", "{file}: arms a host directly instead of through the hold or sibling_arm");
        }
    }
    let lifecycle = read("state/host_lifecycle.rs");
    let lifecycle = strip_comments(production(&lifecycle));
    assert_eq!(lifecycle.matches("client.arm_detach(").count(), 1, "only arm_hosts asks a host to arm");
    assert!(fn_body(&lifecycle, "async fn arm_hosts").contains("client.arm_detach("));
}

#[test]
fn the_sibling_handlers_act_on_the_whole_owned_set() {
    let system = read("api_server/system.rs");
    let arm = fn_body(&system, "pub(crate) async fn hotswap_arm");
    let disarm = fn_body(&system, "pub(crate) async fn hotswap_disarm");
    assert!(arm.contains(".sibling_arm("), "{arm}");
    assert!(disarm.contains(".sibling_disarm("), "{disarm}");
    for body in [&arm, &disarm] {
        assert!(!body.contains("pty_host_clone"), "a handler on one client only: {body}");
    }
}

#[test]
fn the_preflights_and_retention_read_the_owned_set_not_the_primary() {
    let update = read("commands/update.rs");
    let hotswap = fn_body(&update, "pub fn hotswap_preflight");
    assert!(hotswap.contains("owned_hosts_now") && hotswap.contains("offload_refusal"), "{hotswap}");
    assert!(!hotswap.contains("pty_host_clone"), "{hotswap}");
    let update_preflight = fn_body(&update, "pub fn update_preflight");
    assert!(update_preflight.contains("update_refusal"), "{update_preflight}");
    let retention = fn_body(&update, "pub fn connected_host_retention");
    assert!(retention.contains("connected_retention") && !retention.contains("pty_host_clone"), "{retention}");
}
