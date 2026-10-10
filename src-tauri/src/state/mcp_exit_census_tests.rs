//! Source censuses for the MCP handover call sites (plan 055 T6): the handover call on each of the
//! three exit paths is live, awaited, carries the right reason, comes before the next step that can
//! fail or exit, and its result is released on every failure arm and committed on the success
//! tail. The compiler already rejects a later use of the moved `hold`; this pins what it cannot.
//!
//! Each negative case edits the real source text, asserts the edit took effect, and requires the
//! census to fail.

use super::live_call_census::{find_calls, word_uses, Block, Kind, Src, Sub};
use super::mcp_hold_census_tests::{mutate, mutate_in, norm};

const UPDATE_RS: &str = include_str!("../commands/update.rs");
const HANDOVER_RS: &str = include_str!("mcp_handover.rs");

/// One exit path: where it lives, what it must send, and what comes after the handover.
pub(crate) struct ExitPath {
    pub signature: &'static str,
    /// `McpHoldReason` variant the path must send.
    pub reason: &'static str,
    /// Calls that follow the handover and must not precede it (the next flush, apply or spawn).
    pub next: &'static [&'static str],
    /// Text of the statement whose failure arm must release the handover, if the path has one.
    pub failure_head: Option<&'static str>,
}

pub(crate) const RESTART_FOR_UPDATE: ExitPath = ExitPath {
    signature: "pub async fn restart_for_update(",
    reason: "Offload",
    next: &["flush_all_windows("],
    failure_head: None,
};

#[cfg(feature = "velopack-updates")]
pub(crate) const UPDATE_AND_RESTART: ExitPath = ExitPath {
    signature: "pub async fn update_and_restart(",
    reason: "OffloadUpdate",
    next: &["flush_all_windows(", "apply("],
    failure_head: Some("apply(info)"),
};

pub(crate) const RESTART_KEEPING_TERMINALS: ExitPath = ExitPath {
    signature: "pub async fn restart_keeping_terminals(",
    reason: "Relaunch",
    next: &["flush_all_windows(", "spawn_relaunch("],
    failure_head: Some("spawn_relaunch()"),
};

fn is_ident(text: &str) -> bool {
    !text.is_empty() && text != "_" && text.chars().all(|c| c.is_alphanumeric() || c == '_')
}

/// The statement of `block` whose normalised text is `want`, among its own top-level statements,
/// when it runs: a statement after one of the block's own `return`s does not count.
fn top_position(src: &Src, block: &Block, want: &str) -> Option<usize> {
    block.stmts.iter().position(|s| src.norm(&s.span) == want).filter(|i| block.is_unconditional(&block.stmts[*i].span))
}

fn occurrences(src: &Src, block: &Block, want: &str) -> usize {
    block.all_stmts().into_iter().filter(|s| src.norm(&s.span) == want).count()
}

/// The block a failed step runs: the body of an `if` or of an `Err(..)` arm directly under `stmt`.
fn failure_block(stmt: &super::live_call_census::Stmt) -> Option<&Block> {
    stmt.subs.iter().find_map(|sub| match sub {
        Sub::Block(b) if b.kind == Kind::If => Some(b),
        Sub::Match { arms, .. } => arms
            .iter()
            .find(|a| a.pattern.trim_start().starts_with("Err("))
            .and_then(|a| a.block.as_ref()),
        _ => None,
    })
}

/// Check one exit path of `text` (the source of the file that holds it).
pub(crate) fn check_exit_path(text: &str, path: &ExitPath) -> Result<(), String> {
    let src = Src::production(text);
    let body = src.try_function(path.signature)?;
    let in_body = body.open..body.close + 1;

    // The anchor: the end of the top-level statement that contains the Local arm. For the updater
    // that is the whole `if let Err(..) = ..arm_detach(.., Local).await { .. }` block, not the
    // occurrence of `Local` inside its condition.
    let locals = find_calls(&src.masked[in_body.clone()], "termflow_pty_protocol::ArmDetachPurpose::Local");
    if locals.len() != 1 {
        return Err(format!("expected exactly one Local arm in the function, found {}", locals.len()));
    }
    let anchor_at = in_body.start + locals[0];
    let anchor_index = body.top_index(anchor_at).ok_or("the Local arm is not a top-level statement")?;
    let anchor = &body.stmts[anchor_index];
    if !find_calls(&src.masked[anchor.span.clone()], "send_mcp_hold").is_empty() {
        return Err("the arm's own error block sends the handover".into());
    }

    // 1. Exactly one handover statement, live, awaited, at the anchor's continuation depth.
    let sends: Vec<usize> = find_calls(&src.masked[in_body.clone()], "send_mcp_hold").iter().map(|at| in_body.start + at).collect();
    if sends.len() != 1 {
        return Err(format!("expected exactly one `send_mcp_hold` in the function, found {}", sends.len()));
    }
    let index = body.top_index(sends[0]).ok_or("the handover is not a top-level statement")?;
    if body.constructs_at(sends[0]).iter().any(Kind::is_conditional) {
        return Err("the handover sits inside a conditional, closure or async construct".into());
    }
    if index <= anchor_index {
        return Err("the handover comes before the arm's successful continuation".into());
    }
    let stmt = &body.stmts[index];
    let normalised = src.norm(&stmt.span);
    let rest = normalised.strip_prefix("let").ok_or("the handover is not bound with `let`")?;
    let (handed, rest) = rest.split_once('=').ok_or("the handover is not bound with `let`")?;
    if !is_ident(handed) {
        return Err(format!("the handover is bound to `{handed}`, which drops it at once"));
    }
    let rest = rest.strip_prefix("send_mcp_hold(").ok_or("the binding is not the handover call")?;
    let (operand, rest) = rest.split_once(',').ok_or("the handover call has no arguments")?;
    if operand != "state" && operand != "&state" {
        return Err(format!("the handover is given `{operand}`, not the function's own state"));
    }
    let tail = format!("hold,McpHoldReason::{}).await;", path.reason);
    if rest != tail {
        return Err(format!("the handover is not `…(hold, McpHoldReason::{}).await;` but `…{rest}`", path.reason));
    }

    // 2. Before the path's next flush, apply or spawn.
    for next in path.next {
        let first = find_calls(&src.masked[anchor.span.end..in_body.end], next).first().map(|at| anchor.span.end + at);
        if first.is_some_and(|at| at < stmt.span.start) {
            return Err(format!("`{next}` comes before the handover"));
        }
    }

    // 3. `hold` has moved: no later release or commit through it.
    for at in word_uses(&src.masked, stmt.span.end..in_body.end, "hold") {
        let after = src.masked[at + "hold".len()..].trim_start();
        if after.starts_with(".release(") || after.starts_with(".commit(") {
            return Err("`hold.release()` / `hold.commit()` is still called after the handover".into());
        }
    }

    // 4. The failure arm releases the handover itself, awaited, before it returns.
    if let Some(head) = path.failure_head {
        let failing = body.stmts[index + 1..]
            .iter()
            .find(|s| src.masked[s.span.clone()].contains(head))
            .ok_or_else(|| format!("no statement after the handover contains `{head}`"))?;
        let arm = failure_block(failing).ok_or("the failing step has no failure arm")?;
        let release = format!("{handed}.release().await;");
        if occurrences(&src, &body, &release) != 1 {
            return Err(format!("`{release}` must appear exactly once in the function"));
        }
        let at = top_position(&src, arm, &release).ok_or_else(|| format!("the failure arm does not run `{release}` unconditionally"))?;
        let returns = arm
            .stmts
            .iter()
            .position(|s| src.norm(&s.span).starts_with("returnErr(") || src.norm(&s.span).starts_with("return"))
            .ok_or("the failure arm does not return")?;
        if at > returns {
            return Err("the release comes after the arm's return".into());
        }
    } else if occurrences(&src, &body, &format!("{handed}.release().await;")) != 0 {
        return Err("a path with no failure arm releases the handover".into());
    }

    // 5. The success tail commits it, before the process exits.
    let commit = format!("{handed}.commit();");
    if occurrences(&src, &body, &commit) != 1 {
        return Err(format!("`{commit}` must appear exactly once in the function"));
    }
    let commit_at = top_position(&src, &body, &commit).ok_or_else(|| format!("`{commit}` is not an unconditional statement of the function"))?;
    let exit_at = body.stmts[index + 1..]
        .iter()
        .position(|s| find_calls(&src.masked[s.span.clone()], "exit(").len() + src.masked[s.span.clone()].matches(".exit(").count() > 0)
        .map(|p| index + 1 + p)
        .ok_or("the path never exits")?;
    if commit_at > exit_at {
        return Err("the commit comes after the process exits".into());
    }
    if commit_at <= index {
        return Err("the commit comes before the handover".into());
    }
    Ok(())
}

// ---- the real paths -----------------------------------------------------------------------------

#[test]
fn restart_for_update_hands_over_with_the_offload_reason_and_commits_before_it_exits() {
    check_exit_path(UPDATE_RS, &RESTART_FOR_UPDATE).unwrap();
}

#[test]
fn restart_keeping_terminals_hands_over_releases_on_a_failed_spawn_and_commits_before_it_exits() {
    check_exit_path(UPDATE_RS, &RESTART_KEEPING_TERMINALS).unwrap();
}

/// Mutations shared by every path; `from` is text of the real handover statement.
fn handover_mutations(source: &str, handover: &str, reason: &str) -> Vec<(&'static str, String)> {
    let call = |from: &str, to: &str| mutate(source, from, to);
    let wrong_reason = if reason == "Relaunch" { "Offload" } else { "Relaunch" };
    vec![
        ("an unawaited call bound to `_`", call(handover, &handover.replace("let handed =", "let _ =").replace(".await;", ";"))),
        ("the handover dropped at once (`let _ = ….await`)", call(handover, &handover.replace("let handed =", "let _ ="))),
        ("a duplicated call", call(handover, &format!("{handover}\n    {}", handover.replace("let handed", "let handed_again")))),
        ("the wrong reason", call(handover, &handover.replace(&format!("McpHoldReason::{reason}"), &format!("McpHoldReason::{wrong_reason}")))),
        ("a substituted state operand", call(handover, &handover.replace("(state,", "(other_state,").replace("(&state,", "(&other_state,"))),
        ("the call inside a block comment", call(handover, &format!("/* {handover} */"))),
        ("the call inside a string literal", call(handover, &format!("let _s = \"{}\";", handover.replace('"', "'")))),
        ("the call inside `if false`", call(handover, &format!("if false {{ {handover} }}"))),
        ("the call inside a closure", call(handover, &format!("let _f = || {{ {handover} }};"))),
        ("the call inside an async block", call(handover, &format!("let _f = async {{ {handover} }};"))),
        ("a hold still released after the handover", call(handover, &format!("{handover}\n    hold.release().await;"))),
        ("a hold still committed after the handover", call(handover, &format!("{handover}\n    hold.commit();"))),
        ("an early return before the handover", call(handover, &format!("return Ok(());\n    {handover}"))),
    ]
}

const FOR_UPDATE_HANDOVER: &str =
    "let handed = send_mcp_hold(&state, hold, McpHoldReason::Offload).await;";
const KEEPING_HANDOVER: &str =
    "let handed = send_mcp_hold(&state, hold, McpHoldReason::Relaunch).await;";

#[test]
fn the_handover_census_kills_each_planted_mutation_on_restart_for_update() {
    let mut cases = handover_mutations(UPDATE_RS, FOR_UPDATE_HANDOVER, "Offload");
    cases.extend([
        ("the call after flush_all_windows", {
            let cut = mutate_in(UPDATE_RS, "pub async fn restart_for_update(", FOR_UPDATE_HANDOVER, "");
            mutate_in(&cut, "pub async fn restart_for_update(", "state.elevated_host.shutdown().await;", &format!("{FOR_UPDATE_HANDOVER}\n    state.elevated_host.shutdown().await;"))
        }),
        ("a missing commit", mutate_in(UPDATE_RS, "pub async fn restart_for_update(", "handed.commit();", "")),
        ("the commit inside `if false`", mutate_in(UPDATE_RS, "pub async fn restart_for_update(", "handed.commit();", "if false { handed.commit(); }")),
        ("the commit after the exit", {
            let cut = mutate_in(UPDATE_RS, "pub async fn restart_for_update(", "handed.commit();", "");
            mutate_in(&cut, "pub async fn restart_for_update(", "state.app_handle.exit(0);", "state.app_handle.exit(0);\n    handed.commit();")
        }),
        ("the commit on a different binding", mutate_in(UPDATE_RS, "pub async fn restart_for_update(", "handed.commit();", "other.commit();")),
        ("a release where there is no failure arm", mutate_in(UPDATE_RS, "pub async fn restart_for_update(", "handed.commit();", "handed.release().await;\n    handed.commit();")),
        ("an early return before the commit", mutate_in(UPDATE_RS, "pub async fn restart_for_update(", "handed.commit();", "return Ok(());\n    handed.commit();")),
    ]);
    for (name, source) in cases {
        let verdict = check_exit_path(&source, &RESTART_FOR_UPDATE);
        eprintln!("{name} => {verdict:?}");
        assert!(verdict.is_err(), "the census let this mutation through: {name}");
    }
}

#[test]
fn the_handover_census_kills_each_planted_mutation_on_restart_keeping_terminals() {
    let sig = "pub async fn restart_keeping_terminals(";
    let mut cases = handover_mutations(UPDATE_RS, KEEPING_HANDOVER, "Relaunch");
    cases.extend([
        ("the call after flush_all_windows", {
            let cut = mutate_in(UPDATE_RS, sig, KEEPING_HANDOVER, "");
            mutate_in(&cut, sig, "let pid = match", &format!("{KEEPING_HANDOVER}\n    let pid = match"))
        }),
        ("the call after the spawn", {
            let cut = mutate_in(UPDATE_RS, sig, KEEPING_HANDOVER, "");
            mutate_in(&cut, sig, "log::info!(\"[RECOVERY] relaunch spawned", &format!("{KEEPING_HANDOVER}\n    log::info!(\"[RECOVERY] relaunch spawned"))
        }),
        ("an unawaited release", mutate_in(UPDATE_RS, sig, "handed.release().await;", "handed.release();")),
        ("the release inside `if false`", mutate_in(UPDATE_RS, sig, "handed.release().await;", "if false { handed.release().await; }")),
        ("the release in a closure", mutate_in(UPDATE_RS, sig, "handed.release().await;", "let _f = || { handed.release() };")),
        ("the release in an async block", mutate_in(UPDATE_RS, sig, "handed.release().await;", "let _f = async { handed.release().await; };")),
        ("the release after the arm's return", mutate_in(UPDATE_RS, sig, "handed.release().await;\n            return Err(e);", "return Err(e);\n            handed.release().await;")),
        ("the release on a different binding", mutate_in(UPDATE_RS, sig, "handed.release().await;", "other.release().await;")),
        ("a missing release", mutate_in(UPDATE_RS, sig, "handed.release().await;", "")),
        ("a missing commit", mutate_in(UPDATE_RS, sig, "handed.commit();", "")),
        ("the commit inside `if false`", mutate_in(UPDATE_RS, sig, "handed.commit();", "if false { handed.commit(); }")),
        ("the commit after the exit", {
            let cut = mutate_in(UPDATE_RS, sig, "handed.commit();", "");
            mutate_in(&cut, sig, "app.exit(0);", "app.exit(0);\n    handed.commit();")
        }),
        ("an early return before the commit", mutate_in(UPDATE_RS, sig, "handed.commit();", "return Ok(());\n    handed.commit();")),
    ]);
    for (name, source) in cases {
        let verdict = check_exit_path(&source, &RESTART_KEEPING_TERMINALS);
        eprintln!("{name} => {verdict:?}");
        assert!(verdict.is_err(), "the census let this mutation through: {name}");
    }
}

// ---- the production wiring of the handover itself -----------------------------------------------

const WRAPPER_BODY: &str = "handover_txn(state,hold,reason).await";
const NETWORK_LOCK_BODY: &str = "self.network_op_lock.clone()";
const READ_INPUTS_BODY: &str =
    "handover_inputs(&self.mcp_process.lock().unwrap_or_else(|e|e.into_inner()),&self.network.read())";
const HOST_TOKEN_BODY: &str = "crate::pty_host_client::resolve_token()";

/// The body of `signature` normalised, as one expression.
fn body_text(src: &Src, signature: &str) -> Result<String, String> {
    let body = src.try_function(signature)?;
    Ok(src.norm(&(body.open + 1..body.close)))
}

fn check_handover_wiring(text: &str) -> Result<(), String> {
    let src = Src::production(text);
    let wrapper = body_text(&src, "pub async fn send_mcp_hold(")?;
    if wrapper != WRAPPER_BODY {
        return Err(format!("send_mcp_hold's body is not the single `handover_txn` call: {wrapper}"));
    }
    let impl_range = src.braced_after("impl<R: tauri::Runtime> HandoverPort for AppState<R>");
    let port = Src::new(&src.code[impl_range]);
    for (signature, expected) in [
        ("fn network_op_lock(", NETWORK_LOCK_BODY),
        ("fn read_inputs(", READ_INPUTS_BODY),
        ("fn host_token(", HOST_TOKEN_BODY),
    ] {
        let body = body_text(&port, signature)?;
        if body != expected {
            return Err(format!("`{signature}` is not the pinned expression: {body}"));
        }
    }
    let txn = src.try_function("pub(crate) async fn handover_txn<P: HandoverPort>(")?;
    let in_txn = txn.open..txn.close + 1;
    let first_await = src.masked[in_txn.clone()].find(".await").map(|at| in_txn.start + at).ok_or("handover_txn never awaits")?;
    let built = word_uses(&src.masked, in_txn.clone(), "HandedOver")
        .into_iter()
        .find(|at| src.masked[at + "HandedOver".len()..].trim_start().starts_with('{'))
        .ok_or("handover_txn never builds the bundle")?;
    if built > first_await {
        return Err("handover_txn builds the bundle after its first await".into());
    }
    let stored = top_position(&src, &txn, "parts.op=Some(guard);").ok_or("the guard is not stored in the bundle")?;
    let read = txn
        .stmts
        .iter()
        .position(|s| src.masked[s.span.clone()].contains("read_inputs("))
        .ok_or("handover_txn never reads the inputs")?;
    if read <= stored {
        return Err("the inputs are read before the guard is stored".into());
    }
    if find_calls(&src.masked[in_txn], "read_inputs(").len() != 1 {
        return Err("the inputs must be read exactly once".into());
    }
    Ok(())
}

#[test]
fn the_production_wiring_of_the_handover_is_pinned() {
    check_handover_wiring(HANDOVER_RS).unwrap();
}

#[test]
fn the_wiring_census_kills_each_planted_mutation() {
    let cases: Vec<(&str, String)> = vec![
        (
            "a wrapper that returns without calling handover_txn",
            mutate(HANDOVER_RS, "    handover_txn(state, hold, reason).await\n}", "    let _ = (state, reason);\n    HandedOver { parts: None }\n}"),
        ),
        (
            "a wrapper given other arguments",
            mutate(HANDOVER_RS, "    handover_txn(state, hold, reason).await\n}", "    handover_txn(state, hold, McpHoldReason::Offload).await\n}"),
        ),
        (
            "a fresh lock instead of the application's",
            mutate(HANDOVER_RS, "        self.network_op_lock.clone()", "        Arc::new(tokio::sync::Mutex::new(()))"),
        ),
        (
            "the configured port from effective_endpoints",
            mutate(HANDOVER_RS, "&self.network.read())", "&self.effective_endpoints())"),
        ),
        (
            "the launch rebuilt from config",
            mutate(HANDOVER_RS, "handover_inputs(&self.mcp_process.lock().unwrap_or_else(|e| e.into_inner()), &self.network.read())", "HandoverInputs { launch: None, configured_port: self.network.read().mcp_port }"),
        ),
        (
            "a projection computed and then replaced by no launch",
            mutate(HANDOVER_RS, "handover_inputs(&self.mcp_process.lock().unwrap_or_else(|e| e.into_inner()), &self.network.read())", "HandoverInputs { launch: None, ..handover_inputs(&self.mcp_process.lock().unwrap_or_else(|e| e.into_inner()), &self.network.read()) }"),
        ),
        (
            "a fresh slot given to the projection",
            mutate(HANDOVER_RS, "handover_inputs(&self.mcp_process.lock().unwrap_or_else(|e| e.into_inner()), &self.network.read())", "handover_inputs(&GenerationSlot::new(), &self.network.read())"),
        ),
        (
            "a different credential",
            mutate(HANDOVER_RS, "        crate::pty_host_client::resolve_token()", "        String::new()"),
        ),
        (
            "the bundle built after the lock await",
            {
                mutate(
                    HANDOVER_RS,
                    "    let mut handed = HandedOver {\n        parts: Some(Parts { hold, op: None, target: None, sent: SentState::None, host_token: port.host_token() }),\n    };\n    let lock = port.network_op_lock();\n    let Ok(guard) = tokio::time::timeout(LOCK_WAIT, lock.lock_owned()).await else {\n        log::warn!(\"[MCP-HOLD] a network operation is in progress; no hold sent, the exit continues\");\n        return handed;\n    };",
                    "    let lock = port.network_op_lock();\n    let guard = tokio::time::timeout(LOCK_WAIT, lock.lock_owned()).await.expect(\"lock\");\n    let mut handed = HandedOver {\n        parts: Some(Parts { hold, op: None, target: None, sent: SentState::None, host_token: port.host_token() }),\n    };",
                )
            },
        ),
        (
            "the inputs read before the guard is stored",
            mutate(HANDOVER_RS, "    parts.op = Some(guard);\n    let inputs = port.read_inputs();", "    let inputs = port.read_inputs();\n    parts.op = Some(guard);"),
        ),
    ];
    for (name, source) in cases {
        let verdict = check_handover_wiring(&source);
        eprintln!("{name} => {verdict:?}");
        assert!(verdict.is_err(), "the census let this mutation through: {name}");
    }
    let _ = norm("");
}
