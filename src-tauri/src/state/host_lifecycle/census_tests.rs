//! Source censuses for the lifecycle entry points. Exercising the real thing
//! needs a Tauri `AppHandle`, which the Windows test binary cannot build, so these
//! read the wiring from source.
//!
//! What they read is the production text of every file under `src` (inline test
//! modules cut out, comments dropped) and the bodies of named functions in it.
//! What they pin:
//! - which entry point the quit, the offload, the restart and the update call, and
//!   in what order;
//! - that `.quiesce(` and `.arm_detach(` are called only from the functions listed
//!   here, and that an arm comes after admission was closed;
//! - the order of the three steps that end a host's connection.
//!
//! They do not run anything, and they cannot see a new function that reaches the
//! same effect through a path they do not name: they are lists of the known
//! callers, not a proof that no other caller exists. Each census that scans
//! every file also has a test with a planted violation, so it is known to see one.

use crate::state::source_scan::{callers_of, enclosing_fn, fn_body, production};
use std::path::{Path, PathBuf};

fn src_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

/// The production text of one source file, relative to `src`.
fn read(rel: &str) -> String {
    let path = src_dir().join(rel);
    production(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {} ({e})", path.display())))
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

/// Every production source file, as `(path relative to src, production text)`.
/// Files that are only tests are not production.
fn production_sources() -> Vec<(String, String)> {
    let mut files = Vec::new();
    rust_files(&src_dir(), &mut files);
    files
        .into_iter()
        .filter(|p| {
            let name = p.file_name().unwrap().to_string_lossy();
            !name.ends_with("_tests.rs")
                && !matches!(name.as_ref(), "fake_hosts.rs" | "source_scan.rs" | "tests.rs")
                && !name.starts_with("test_")
        })
        .map(|p| {
            let rel = p.strip_prefix(src_dir()).unwrap().to_string_lossy().replace('\\', "/");
            let text = production(&std::fs::read_to_string(&p).unwrap());
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
    assert!(exit.contains(".exit_hosts().await"), "the quit path must release every host: {exit}");
    let update_rs = read("commands/update.rs");
    for (name, signature, begin) in [
        ("restart_for_update", "pub async fn restart_for_update", ".begin_offload()"),
        ("restart_keeping_terminals", "pub async fn restart_keeping_terminals", ".begin_relaunch()"),
    ] {
        let body = fn_body(&update_rs, signature);
        assert!(position(&body, begin) < position(&body, ".arm_detach("), "{name}: admission is closed BEFORE any host is armed: {body}");
        assert!(position(&body, ".arm_detach(") < position(&body, ".exit("), "{name}: armed before exiting: {body}");
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
    assert!(fn_body(&lifecycle, "async fn exit_hosts").contains("QuiesceReason::Exit"));
    assert!(fn_body(&lifecycle, "async fn close_admission").contains(".quiesce(reason"));
    assert!(fn_body(&lifecycle, "async fn begin_hold").contains("close_admission("));
    assert!(fn_body(&lifecycle, "async fn begin_relaunch").contains("close_admission("));
    assert!(fn_body(&lifecycle, "async fn sibling_arm").contains("close_admission("));
    assert!(fn_body(&lifecycle, "async fn begin_offload").contains("QuiesceReason::Offload"));
    assert!(fn_body(&lifecycle, "async fn begin_update").contains("QuiesceReason::Update"));
}

/// Where each `.quiesce(` call is, as `(file, function)`.
fn quiesce_callers(sources: &[(String, String)]) -> Vec<(String, Option<String>)> {
    let mut callers = Vec::new();
    for (file, text) in sources {
        for caller in callers_of(text, ".quiesce(") {
            callers.push((file.clone(), caller));
        }
    }
    callers.sort();
    callers
}

#[test]
fn only_the_lifecycle_module_closes_admission() {
    // Quiescers are exactly exit and the one place an offload, an update, a
    // restart and a sibling's arm close it.
    assert_eq!(
        quiesce_callers(&production_sources()),
        [
            ("state/host_lifecycle.rs".to_string(), Some("close_admission".to_string())),
            ("state/host_lifecycle.rs".to_string(), Some("exit_hosts".to_string())),
        ],
        "a new `.quiesce(` call is a new lifecycle path: route it through host_lifecycle"
    );
}

#[test]
fn a_planted_quiesce_is_seen() {
    let planted = vec![(
        "state/terminals.rs".to_string(),
        production("impl S { async fn sneaky(&self) { let _g = self.host_table.quiesce(R, B).await; } }"),
    )];
    assert_eq!(quiesce_callers(&planted), [("state/terminals.rs".to_string(), Some("sneaky".to_string()))]);
}

#[test]
fn no_path_closes_a_host_without_a_disarm() {
    let lifecycle = read("state/host_lifecycle.rs");
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

/// The functions allowed to call `.arm_detach(`, and where the arm is made. All of
/// them but `arm_hosts` itself arm through a `Hold`, which they take first.
const ARMERS: &[(&str, &str)] = &[
    ("state/host_lifecycle.rs", "arm_hosts"),
    ("state/host_lifecycle.rs", "sibling_arm"),
    ("commands/update.rs", "restart_for_update"),
    ("commands/update.rs", "restart_keeping_terminals"),
    ("updater.rs", "update_and_restart"),
];

/// What admission is closed with before a `Hold` may arm.
const CLOSERS: &[&str] = &[".begin_offload()", ".begin_relaunch()", ".begin_update()", "close_admission("];

/// Every `.arm_detach(` outside the client itself that is not made by a listed
/// function, or by one of them before it closed admission. Whatever the receiver
/// is called.
fn arm_violations(sources: &[(String, String)]) -> Vec<String> {
    let mut violations = Vec::new();
    for (file, text) in sources.iter().filter(|(file, _)| file != "pty_host_client.rs") {
        for (at, _) in text.match_indices(".arm_detach(") {
            let function = enclosing_fn(text, at).unwrap_or_default();
            if !ARMERS.contains(&(file.as_str(), function.as_str())) {
                violations.push(format!("{file}: `{function}` arms a host"));
                continue;
            }
            if function != "arm_hosts" {
                let start = text[..at].rfind(&format!("fn {function}")).unwrap_or(0);
                if !CLOSERS.iter().any(|closer| text[start..at].contains(closer)) {
                    violations.push(format!("{file}: `{function}` arms before it closes admission"));
                }
            }
        }
    }
    violations
}

#[test]
fn no_one_arms_a_host_except_through_the_all_or_nothing_helper() {
    assert_eq!(arm_violations(&production_sources()), Vec::<String>::new());
    let lifecycle = read("state/host_lifecycle.rs");
    assert_eq!(lifecycle.matches("client.arm_detach(").count(), 1, "only arm_hosts asks a host to arm");
    assert!(fn_body(&lifecycle, "async fn arm_hosts").contains("client.arm_detach("));
}

#[test]
fn a_planted_arm_is_seen_whatever_its_receiver_is_called() {
    let source = |file: &str, text: &str| (file.to_string(), production(text));
    // A client picked up anywhere, called anything.
    let elsewhere = [source("state/terminals.rs", "impl S { fn sneaky(&self) { let h = self.pty_host_clone().unwrap(); h.arm_detach(1, t, None); } }")];
    assert_eq!(arm_violations(&elsewhere), ["state/terminals.rs: `sneaky` arms a host"]);
    // A listed function that did not close admission first.
    let unguarded = [source("commands/update.rs", "async fn restart_for_update() { let mut hold = other(); hold.arm_detach(1, t, None).await; }")];
    assert_eq!(arm_violations(&unguarded), ["commands/update.rs: `restart_for_update` arms before it closes admission"]);
    // The same, in a test module, is not production.
    let test_only = [source("state/terminals.rs", "#[cfg(test)] mod t { fn x(c: C) { c.arm_detach(1, t, None); } }")];
    assert!(arm_violations(&test_only).is_empty());
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
