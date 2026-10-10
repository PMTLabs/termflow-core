//! Plan 055 T8 (I2), the sibling-coordination path: a sibling's arm request arms this instance's
//! hosts with purpose `None` and never hands over the MCP port. The sibling's own update owns its
//! handover; this instance keeps listening. Two censuses, each with planted mutations that must fail:
//!
//! - `sibling_arm` in `host_lifecycle.rs` arms with `None` and neither it nor the rest of the file
//!   names the handover;
//! - the handover is called from nowhere but the three exit paths (so no sibling-facing handler,
//!   `sibling_coord` or API route can start one).

use super::live_call_census::{find_calls, word_uses, Src};
use super::mcp_hold_census_tests::mutate;

const LIFECYCLE_RS: &str = include_str!("host_lifecycle.rs");
const SIBLING_ARM: &str = "pub(super) async fn sibling_arm<";
const SIBLING_DISARM: &str = "pub(super) async fn sibling_disarm<";

/// Words that belong to the handover and to no sibling path.
const HANDOVER_WORDS: [&str; 3] = ["send_mcp_hold", "McpHoldReason", "HandedOver"];

fn check_sibling_arm(text: &str) -> Result<(), String> {
    let src = Src::production(text);

    // Nothing in the file's production code names the handover.
    for word in HANDOVER_WORDS {
        if !find_calls(&src.masked, word).is_empty() {
            return Err(format!("host_lifecycle.rs names `{word}`"));
        }
    }

    // The sibling's arm: one `arm_detach`, with purpose `None`, and the hold is kept for the disarm.
    let arm = src.try_function(SIBLING_ARM)?;
    let region = arm.open..arm.close + 1;
    let arms = find_calls(&src.masked[region.clone()], "hold.arm_detach(");
    if arms.len() != 1 {
        return Err(format!("`sibling_arm` must call `hold.arm_detach(` exactly once, found {}", arms.len()));
    }
    let open = region.start + arms[0] + "hold.arm_detach".len();
    let close = super::live_call_census::find_close(&src, open);
    let args: String = src.code[open + 1..close].chars().filter(|c| !c.is_whitespace()).collect();
    if args != "timeout_secs,&port.arm_token(),None" {
        return Err(format!("`sibling_arm` arms with `({args})`, not `(timeout_secs, &port.arm_token(), None)`"));
    }
    if !word_uses(&src.masked, region.clone(), "Local").is_empty() {
        return Err("`sibling_arm` mentions the Local purpose".into());
    }
    let kept = arm.stmts.iter().filter(|s| src.norm(&s.span) == "slot.keep(arm,hold);").count();
    if kept != 1 {
        return Err(format!("`sibling_arm` must keep the hold for the sibling's disarm with `slot.keep(arm, hold);`, found {kept}"));
    }

    // The disarm side only releases.
    let disarm = src.try_function(SIBLING_DISARM)?;
    if !find_calls(&src.masked[disarm.open..disarm.close + 1], "arm_detach(").is_empty() {
        return Err("`sibling_disarm` arms".into());
    }
    Ok(())
}

/// Every production file that calls `send_mcp_hold(`; `files` are (relative path, text).
fn check_callers(files: &[(String, String)]) -> Result<(), String> {
    let allowed = ["commands/update.rs", "updater.rs"];
    let mut calls = 0;
    for (name, text) in files {
        let src = Src::production(text);
        let hits = find_calls(&src.masked, "send_mcp_hold(");
        if name == "state/mcp_handover.rs" || name == "state/mod.rs" {
            continue; // the definition and its re-export
        }
        if hits.is_empty() {
            continue;
        }
        if !allowed.contains(&name.as_str()) {
            return Err(format!("{name} calls `send_mcp_hold(`; only the three exit paths may"));
        }
        calls += hits.len();
    }
    if calls != 3 {
        return Err(format!("expected exactly three `send_mcp_hold(` calls (the three exit paths), found {calls}"));
    }
    Ok(())
}

fn production_files() -> Vec<(String, String)> {
    fn walk(dir: &std::path::Path, root: &std::path::Path, out: &mut Vec<(String, String)>) {
        for entry in std::fs::read_dir(dir).expect("source directory") {
            let path = entry.expect("source entry").path();
            if path.is_dir() {
                walk(&path, root, out);
                continue;
            }
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            if path.extension().is_none_or(|e| e != "rs") || name.ends_with("_tests.rs") || name == "tests.rs" || name == "fake_hosts.rs" || name == "source_scan.rs" || name == "live_call_census.rs" {
                continue;
            }
            let relative = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
            out.push((relative, std::fs::read_to_string(&path).expect("read source")));
        }
    }
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut out = Vec::new();
    walk(&root, &root, &mut out);
    out
}

#[test]
fn the_sibling_arm_arms_with_no_purpose_and_the_file_never_names_the_handover() {
    check_sibling_arm(LIFECYCLE_RS).unwrap();
}

#[test]
fn the_sibling_census_kills_each_planted_mutation() {
    let hand = "let _held = super::send_mcp_hold(&state, hold, McpHoldReason::Offload).await;";
    let cases: Vec<(&str, String)> = vec![
        (
            "a handover sent from the sibling arm",
            mutate(LIFECYCLE_RS, "    slot.keep(arm, hold);\n", &format!("    {hand}\n    slot.keep(arm, hold);\n")),
        ),
        (
            "the sibling arm armed with the Local purpose",
            mutate(LIFECYCLE_RS, "hold.arm_detach(timeout_secs, &port.arm_token(), None)", "hold.arm_detach(timeout_secs, &port.arm_token(), Some(ArmDetachPurpose::Local))"),
        ),
        (
            "the sibling arm armed with another token",
            mutate(LIFECYCLE_RS, "hold.arm_detach(timeout_secs, &port.arm_token(), None)", "hold.arm_detach(timeout_secs, &other_token, None)"),
        ),
        (
            "a second arm call in the sibling arm",
            mutate(LIFECYCLE_RS, "    slot.keep(arm, hold);\n", "    let _ = hold.arm_detach(timeout_secs, &port.arm_token(), None).await;\n    slot.keep(arm, hold);\n"),
        ),
        (
            "the sibling arm no longer keeps the hold",
            mutate(LIFECYCLE_RS, "    slot.keep(arm, hold);\n", ""),
        ),
        (
            "the sibling arm keeps the hold only conditionally",
            mutate(LIFECYCLE_RS, "    slot.keep(arm, hold);\n", "    if armed > 0 { slot.keep(arm, hold); }\n"),
        ),
        (
            "a handover sent from the sibling disarm",
            mutate(LIFECYCLE_RS, "    if let Some((_, hold)) = port.sibling_slot().take() {\n        return hold.release().await;", &format!("    if let Some((_, hold)) = port.sibling_slot().take() {{\n        {hand}\n        return hold.release().await;")),
        ),
        (
            "a handover sent from the spawned timeout task",
            mutate(LIFECYCLE_RS, "            hold.release().await;\n        }\n    });", &format!("            {hand}\n            hold.release().await;\n        }}\n    }});")),
        ),
        (
            "the reason type imported into the file",
            format!("use termflow_pty_protocol::McpHoldReason;\n{LIFECYCLE_RS}"),
        ),
        (
            "the handover module imported into the file",
            format!("use super::mcp_handover::HandedOver;\n{LIFECYCLE_RS}"),
        ),
        (
            "the sibling disarm arming",
            mutate(LIFECYCLE_RS, "    if let Some((_, hold)) = port.sibling_slot().take() {\n        return hold.release().await;", "    if let Some((_, mut hold)) = port.sibling_slot().take() {\n        let _ = hold.arm_detach(1, &port.arm_token(), None).await;\n        return hold.release().await;"),
        ),
    ];
    for (name, source) in cases {
        let verdict = check_sibling_arm(&source);
        eprintln!("{name} => {verdict:?}");
        assert!(verdict.is_err(), "the census let this mutation through: {name}");
    }
}

#[test]
fn a_comment_naming_the_handover_in_host_lifecycle_is_fine() {
    let commented = format!("{LIFECYCLE_RS}\n// the sibling arm never calls send_mcp_hold (McpHoldReason, HandedOver)\n");
    check_sibling_arm(&commented).unwrap();
}

#[test]
fn only_the_three_exit_paths_call_the_handover() {
    check_callers(&production_files()).unwrap();
}

#[test]
fn the_caller_census_kills_each_planted_mutation() {
    let real = production_files();
    let with = |name: &str, extra: &str| -> Vec<(String, String)> {
        let mut files = real.clone();
        match files.iter_mut().find(|(n, _)| n == name) {
            Some((_, text)) => text.push_str(extra),
            None => files.push((name.to_string(), extra.to_string())),
        }
        files
    };
    let call = "\nasync fn leak(state: &AppState, hold: Hold) { let _h = send_mcp_hold(state, hold, McpHoldReason::Offload).await; }\n";
    let cases: Vec<(&str, Vec<(String, String)>)> = vec![
        ("the sibling coordination module calls it", with("sibling_coord.rs", call)),
        ("an API handler calls it", with("api_server/terminals/mod.rs", call)),
        ("the sibling arm's own file calls it", with("state/host_lifecycle.rs", call)),
        ("a new file calls it", with("state/new_exit.rs", call)),
        ("a fourth call in the update command", with("commands/update.rs", call)),
        (
            "the update command lost a call",
            real.iter()
                .map(|(n, t)| {
                    if n == "commands/update.rs" {
                        (n.clone(), t.replacen("send_mcp_hold(&state, hold, McpHoldReason::Relaunch)", "other(&state, hold, McpHoldReason::Relaunch)", 1))
                    } else {
                        (n.clone(), t.clone())
                    }
                })
                .collect(),
        ),
    ];
    for (name, files) in cases {
        let verdict = check_callers(&files);
        eprintln!("{name} => {verdict:?}");
        assert!(verdict.is_err(), "the census let this mutation through: {name}");
    }
}
