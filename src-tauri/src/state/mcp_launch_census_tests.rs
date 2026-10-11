//! Plan 055 T3: the launch record is built from the same locals as the spawn and lives in the
//! process slot. The provenance census proves it on masked source, each subject in the context
//! its row of the execution-context table requires (setup before the spawn; the wrapper after it;
//! install and shutdown in their match arms), and kills the planted mutations.

use super::live_call_census::{
    chain, find_calls, method_calls, require_live_call, require_top_statement, word_uses, Src, Sub,
};
use super::mcp_hold_census_tests::{mutate, mutate_in, norm, production_sources};

const SIDECAR: &str = include_str!("../mcp_sidecar.rs");

const SIDECAR_FN: &str = "async fn start_mcp_sidecar(";
const LEGACY_FN: &str = "async fn start_mcp_legacy(";

const LET_LAUNCH: &str = "let (launch, env) = mcp_launch_env(cfg, crate::profile::current().integrity);";
const SIDECAR_LOOP: &str = "for (k, v) in env { sidecar_command = sidecar_command.env(k, v); }";
/// The same loop as it is laid out in the file, for the mutations that edit the text.
const SIDECAR_LOOP_SRC: &str = "for (k, v) in env {
        sidecar_command = sidecar_command.env(k, v);
    }";
const LET_PROCESS: &str = "let process = McpProcess { handle, launch };";
const LET_HANDLE_SIDECAR: &str = "let handle = McpProcessHandle::Sidecar { child, terminated: terminated_rx, };";
const LET_HANDLE_LEGACY: &str = "let handle = McpProcessHandle::Legacy(child);";
const SHUTDOWN_PROCESS: &str = "crate::shutdown_mcp_handle(process);";
const INSTALL_PROCESS: &str = "slot.install_if_current(generation, process)";
const SIDECAR_SPAWN_CALL: &str = "sidecar_command.spawn().map_err(|e| e.to_string())?";
const SIDECAR_SPAWN: &str = "let (mut rx, child) = sidecar_command.spawn().map_err(|e| e.to_string())?;";
const LEGACY_SPAWN: &str = "let child = cmd.spawn().map_err(|e| e.to_string())?;";
/// A command built afresh, without the launch environment.
const FRESH_SIDECAR: &str = "app_handle.shell().sidecar(\"termflow-mcp-server\").map_err(|e| e.to_string())?";
const FRESH_LEGACY: &str = "std::process::Command::new(\"node\").arg(&mcp_path)";
/// The legacy command builder, exactly (comments dropped): only additions follow `.envs(env)`.
const LEGACY_BUILDER: &str = "cmd.arg(&mcp_path).envs(env).env(\"AUTO_TERMINAL_INSTANCE_ID\", &state.instance_id)\
     .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());";
/// The only statements that may name the command between the launch environment and the spawn.
/// Pinned exactly, not parsed: a chain parser has to understand every call syntax to fail closed.
const SIDECAR_CONFIGURE: [&str; 1] = ["sidecar_command = sidecar_command.env(\"AUTO_TERMINAL_INSTANCE_ID\", &state.instance_id);"];
const LEGACY_CONFIGURE: [&str; 1] = ["cmd.creation_flags(CREATE_NO_WINDOW);"];
const FORBIDDEN_ENV: [&str; 4] = ["MCP_PORT", "MCP_HOST", "AUTO_TERMINAL_TOKEN", "AUTO_TERMINAL_API_TOKEN"];

/// One spawn path builds its launch record and its environment from one `mcp_launch_env` call,
/// applies exactly that environment, and installs the process it spawned together with that record.
fn check_spawn_provenance(text: &str, signature: &str, legacy: bool) -> Result<(), String> {
    let src = Src::production(text);
    let body = src.try_function(signature)?;
    let whole = body.open..body.close + 1;
    let masked = &src.masked[whole.clone()];
    let at = |stmt: usize| &body.stmts[stmt].span;

    // One call, no other builder.
    if find_calls(masked, "mcp_launch_env(").len() != 1 {
        return Err("the function must call mcp_launch_env exactly once".into());
    }
    if !find_calls(masked, "mcp_env(").is_empty() {
        return Err("the function builds an environment outside mcp_launch_env".into());
    }
    // Setup: unconditional, before the spawn.
    let let_idx = require_top_statement(&src, &body, LET_LAUNCH)?;
    // The spawn is one live call, on the very command the environment is applied to, and its
    // child is bound by the statement that makes it.
    let (receiver, spawn_head) = if legacy { ("cmd", "letchild=") } else { ("sidecar_command", "let(mutrx,child)=") };
    let spawn_at = require_live_call(&body, &method_calls(&src, whole.clone(), "spawn"), "`.spawn(`")?;
    let spawn_idx = body.top_index(spawn_at).ok_or("the spawn is outside every statement")?;
    let spawned = src.masked[..spawn_at].trim_end();
    let receiver_ok = spawned.strip_suffix(receiver).is_some_and(|rest| {
        !rest.ends_with(|c: char| c.is_alphanumeric() || c == '_' || c == '.' || c == ':')
    });
    if !receiver_ok {
        return Err(format!("the spawn is not called on `{receiver}`, the command the environment is applied to"));
    }
    if !src.norm(at(spawn_idx)).starts_with(spawn_head) {
        return Err(format!("the spawn statement must bind the child: `{spawn_head}...`"));
    }
    // The owning statement applies exactly that `env`; the receiver and arguments are child spans.
    let (consumer_idx, applied_to) = if legacy {
        let idx = body
            .live_position(|s| src.norm(&s.span).starts_with("cmd.arg("))
            .ok_or("the command builder statement is gone or does not run")?;
        let c = chain(&src, at(idx));
        let envs: Vec<_> = c.calls.iter().filter(|(name, _)| name == "envs").collect();
        let [(_, args)] = envs[..] else {
            return Err("the builder chain must call .envs(..) exactly once".into());
        };
        if c.root != "cmd" || src.norm(args) != "env" {
            return Err(format!(
                "the builder chain must apply exactly `.envs(env)` to `cmd`, found `{}` on `{}`",
                src.norm(args),
                c.root
            ));
        }
        // The whole builder is pinned: nothing can follow `.envs(env)` unseen, whatever its syntax.
        if src.norm(at(idx)) != norm(LEGACY_BUILDER) {
            return Err(format!("the legacy builder is not exactly the pinned chain: `{}`", src.norm(at(idx))));
        }
        (idx, args.end + 1)
    } else {
        let idx = require_top_statement(&src, &body, SIDECAR_LOOP)?;
        (idx, at(idx).end)
    };
    if !(let_idx < consumer_idx && consumer_idx < spawn_idx) {
        return Err("the environment must be built, then applied, then the command spawned".into());
    }
    // Between the two, the command is only configured further, never replaced and never stripped.
    // Fail closed: every statement that names the receiver, up to the spawn's own receiver (inside a
    // block initializer as well as before it), is exactly one of the pinned configuration statements;
    // a new one fails the census until it is reviewed and pinned here.
    let pinned: Vec<String> = (if legacy { &LEGACY_CONFIGURE[..] } else { &SIDECAR_CONFIGURE[..] }).iter().map(|s| norm(s)).collect();
    let receiver_at = spawned.len() - receiver.len();
    for found in word_uses(&src.masked, at(consumer_idx).end..receiver_at, receiver) {
        let stmt = body.deepest_stmt(found).ok_or("a use outside every statement")?;
        let text = src.norm(&stmt.span);
        if !pinned.contains(&text) {
            return Err(format!("`{receiver}` is used between the environment and the spawn in an unpinned statement: `{text}`"));
        }
    }
    // Nothing overrides a launch fact once the environment is applied.
    for call in [".env(", ".envs("] {
        for found in src.masked[applied_to..body.close].match_indices(call).map(|(i, _)| applied_to + i) {
            let open = found + call.len() - 1;
            let close = super::live_call_census::find_close(&src, open);
            let args = &src.code[open..=close];
            if let Some(name) = FORBIDDEN_ENV.iter().find(|n| args.contains(*n)) {
                return Err(format!("`{call}` overrides {name} after the environment is applied"));
            }
        }
    }
    // `launch` and `env` are bound once and read only where they must be.
    let consumer = src.norm(at(consumer_idx));
    for (word, allowed) in
        [("launch", vec![norm(LET_LAUNCH), norm(LET_PROCESS)]), ("env", vec![norm(LET_LAUNCH), consumer])]
    {
        for found in word_uses(&src.masked, whole.clone(), word) {
            let stmt = body.deepest_stmt(found).ok_or("a use outside every statement")?;
            let text = src.norm(&stmt.span);
            if !allowed.contains(&text) {
                return Err(format!("`{word}` is used in `{text}`"));
            }
        }
    }
    // The process is wrapped once with that launch, after the spawn and before the slot-lock match.
    let process_idx = require_top_statement(&src, &body, LET_PROCESS)?;
    // The spawned child is the one wrapped: it reaches the handle and nothing else takes it.
    let handle_idx = require_top_statement(&src, &body, if legacy { LET_HANDLE_LEGACY } else { LET_HANDLE_SIDECAR })?;
    if !(spawn_idx < handle_idx && handle_idx < process_idx) {
        return Err("the handle must wrap the child after the spawn and before the process".into());
    }
    for (word, allowed) in [("child", vec![spawn_idx, handle_idx]), ("handle", vec![handle_idx, process_idx])] {
        for found in word_uses(&src.masked, whole.clone(), word) {
            let top = body.top_index(found).ok_or("a use outside every statement")?;
            let read_only = src.norm(&body.deepest_stmt(found).ok_or("a use outside every statement")?.span) == "letpid=child.id();";
            if !(allowed.contains(&top) || (word == "child" && read_only)) {
                return Err(format!("`{word}` is used in `{}`", src.norm(at(top))));
            }
        }
    }
    let installs: Vec<usize> =
        (0..body.stmts.len()).filter(|i| src.masked[at(*i).clone()].contains("install_if_current(")).collect();
    let [install_idx] = installs[..] else {
        return Err(format!("expected one top-level slot-lock match, found {}", installs.len()));
    };
    if !(spawn_idx < process_idx && process_idx < install_idx) {
        return Err("the process must be built after the spawn and before the slot-lock match".into());
    }
    if !body.is_unconditional(at(install_idx)) {
        return Err("the slot-lock match does not run (it is conditional or after a return)".into());
    }
    // And that same local is installed in the Ok arm, shut down in the Err arm.
    let Some(Sub::Match { arms, .. }) = body.stmts[install_idx].subs.iter().find(|s| matches!(s, Sub::Match { .. }))
    else {
        return Err("the install statement is no longer a match".into());
    };
    let ok_arm = arms.iter().find(|a| a.pattern.starts_with("Ok(")).ok_or("no Ok arm")?;
    if src.norm(&ok_arm.body) != norm(INSTALL_PROCESS) {
        return Err(format!("the Ok arm must be exactly `{INSTALL_PROCESS}`, found `{}`", src.norm(&ok_arm.body)));
    }
    let err_arm = arms.iter().find(|a| a.pattern.starts_with("Err(")).ok_or("no Err arm")?;
    let shuts = err_arm
        .block
        .as_ref()
        .is_some_and(|b| b.live_position(|s| src.norm(&s.span) == norm(SHUTDOWN_PROCESS)).is_some());
    if !shuts {
        return Err(format!("the Err arm must shut the process down with `{SHUTDOWN_PROCESS}`"));
    }
    for found in word_uses(&src.masked, whole, "process") {
        let stmt = body.deepest_stmt(found).ok_or("a use outside every statement")?;
        let text = src.norm(&stmt.span);
        if !(ok_arm.body.contains(&found) || text == norm(LET_PROCESS) || text == norm(SHUTDOWN_PROCESS)) {
            return Err(format!("`process` is used in `{text}`"));
        }
    }
    Ok(())
}

/// Whether `Name {` at `at` builds a value, as opposed to declaring or implementing the type.
fn constructs(src: &Src, at: usize) -> bool {
    let before = src.masked[..at].trim_end();
    !["struct", "for", "impl"].iter().any(|keyword| before.ends_with(keyword))
}

/// Nothing but the two spawn paths builds a `McpProcess`, only `mcp_launch_env` builds a
/// `McpLaunch`, and no `AppState` field is a launch record of its own.
fn check_construction_sites(files: &[(String, String)]) -> Result<(), String> {
    let mut process_sites = 0;
    for (name, text) in files {
        let src = Src::production(text);
        for found in find_calls(&src.masked, "McpProcess {") {
            if !constructs(&src, found) {
                continue;
            }
            process_sites += 1;
            let inside = [SIDECAR_FN, LEGACY_FN]
                .iter()
                .any(|signature| src.try_function(signature).is_ok_and(|b| (b.open..b.close).contains(&found)));
            if !inside {
                return Err(format!("{name} constructs a McpProcess outside the two spawn paths"));
            }
        }
        for found in find_calls(&src.masked, "McpLaunch {") {
            if !constructs(&src, found) {
                continue;
            }
            let inside = src
                .try_function("pub(crate) fn mcp_launch_env(")
                .is_ok_and(|b| (b.open..b.close).contains(&found));
            if !inside {
                return Err(format!("{name} constructs a McpLaunch outside mcp_launch_env"));
            }
        }
        if name == "types.rs" {
            let app_state = src.braced_after("pub struct AppState<");
            if src.masked[app_state].contains("McpLaunch") {
                return Err("an AppState field is a launch record of its own".into());
            }
        }
    }
    if process_sites != 2 {
        return Err(format!("expected McpProcess to be built in exactly two places, found {process_sites}"));
    }
    Ok(())
}

fn named_sources() -> Vec<(String, String)> {
    production_sources()
        .into_iter()
        .map(|(path, text)| (path.file_name().unwrap().to_string_lossy().to_string(), text))
        .collect()
}

#[test]
fn both_spawn_paths_build_apply_and_install_one_launch_record() {
    check_spawn_provenance(SIDECAR, SIDECAR_FN, false).unwrap();
    check_spawn_provenance(SIDECAR, LEGACY_FN, true).unwrap();
}

#[test]
fn only_the_spawn_paths_construct_a_process_and_only_the_builder_a_launch() {
    check_construction_sites(&named_sources()).unwrap();
}

#[test]
fn a_construction_outside_the_spawn_paths_is_caught() {
    let mut files = named_sources();
    files.push((
        "rogue.rs".into(),
        "fn rogue(handle: McpProcessHandle) { let _p = McpProcess { handle, launch: McpLaunch { port: 1, bind_host: String::new(), auth_token: None } }; }".into(),
    ));
    assert!(check_construction_sites(&files).is_err());
    let mut field = named_sources();
    for (name, text) in &mut field {
        if name == "types.rs" {
            *text = mutate(text, "pub mcp_process: Arc<Mutex<GenerationSlot<McpProcess>>>,", "pub mcp_process: Arc<Mutex<GenerationSlot<McpProcess>>>,\n    pub launch: McpLaunch,");
        }
    }
    assert!(check_construction_sites(&field).is_err(), "a second AppState copy of the launch record");
}

#[test]
fn the_provenance_census_kills_each_planted_mutation_in_the_sidecar_path() {
    let in_sidecar = |from: &str, to: &str| mutate_in(SIDECAR, SIDECAR_FN, from, to);
    let cases: Vec<(&str, String)> = vec![
        ("a default launch in the process", in_sidecar(LET_PROCESS, "let process = McpProcess { handle, launch: McpLaunch::default() };")),
        ("a second mcp_launch_env feeding the launch", in_sidecar(LET_LAUNCH, &format!("{LET_LAUNCH}\n    let (launch, _other) = mcp_launch_env(&other_cfg, crate::profile::current().integrity);"))),
        ("launch.port assigned after the let", in_sidecar(LET_LAUNCH, &format!("{LET_LAUNCH}\n    launch.port = cfg.mcp_port;"))),
        ("the old builder instead of env", in_sidecar("for (k, v) in env {", "for (k, v) in mcp_env(cfg) {")),
        ("env rebound after the builder let", in_sidecar(LET_LAUNCH, &format!("{LET_LAUNCH}\n    let env = Vec::<(String, String)>::new();"))),
        ("MCP_PORT overridden after the env is applied", in_sidecar("    let generation = state", "    sidecar_command = sidecar_command.env(\"MCP_PORT\", \"42032\");\n    let generation = state")),
        ("the token fallback overridden after the env is applied", in_sidecar("    let generation = state", "    sidecar_command = sidecar_command.env(\"AUTO_TERMINAL_API_TOKEN\", \"x\");\n    let generation = state")),
        ("the env loop inside if false", in_sidecar(SIDECAR_LOOP_SRC, &format!("if false {{ {SIDECAR_LOOP} }}"))),
        ("the env loop inside a closure", in_sidecar(SIDECAR_LOOP_SRC, &format!("let _f = || {{ {SIDECAR_LOOP} }};"))),
        ("the env loop after the spawn", mutate_in(&in_sidecar(SIDECAR_LOOP_SRC, ""), SIDECAR_FN, "log::info!(\"[MCP] MCP sidecar spawned\");", &format!("log::info!(\"[MCP] MCP sidecar spawned\");
    {SIDECAR_LOOP}"))),
        ("a different process installed", in_sidecar(INSTALL_PROCESS, "slot.install_if_current(generation, other)")),
        ("the Err arm no longer shuts the process down", in_sidecar(SHUTDOWN_PROCESS, "drop(process);")),
        ("the wrapper built inside if false", in_sidecar(LET_PROCESS, &format!("if false {{ {LET_PROCESS} }}"))),
        ("an early return before the env loop", in_sidecar(SIDECAR_LOOP_SRC, &format!("return Ok(false);\n    {SIDECAR_LOOP}"))),
        ("an early return before the wrapper", in_sidecar(LET_PROCESS, &format!("return Ok(false);\n    {LET_PROCESS}"))),
        ("an early return between the wrapper and the install", in_sidecar(LET_PROCESS, &format!("{LET_PROCESS}\n    return Ok(false);"))),
        ("a return before the poisoned-lock shutdown", in_sidecar(SHUTDOWN_PROCESS, &format!("return Err(\"skip shutdown\".into());\n            {SHUTDOWN_PROCESS}"))),
        ("the configured spawn dead, a fresh command spawned", in_sidecar(SIDECAR_SPAWN, &format!("let (mut rx, child) = if false {{ {} }} else {{ {FRESH_SIDECAR}.spawn().map_err(|e| e.to_string())? }};", SIDECAR_SPAWN_CALL))),
        ("a fresh command spawned instead", in_sidecar(SIDECAR_SPAWN, &format!("let (mut rx, child) = {FRESH_SIDECAR}.spawn().map_err(|e| e.to_string())?;"))),
        ("the command replaced before the spawn", in_sidecar("    let generation = state", &format!("    sidecar_command = {FRESH_SIDECAR};\n    let generation = state"))),
        ("the command replaced inside the spawn's block initializer", in_sidecar(SIDECAR_SPAWN, &format!("let (mut rx, child) = {{\n        sidecar_command = {FRESH_SIDECAR};\n        {SIDECAR_SPAWN_CALL}\n    }};"))),
        ("a launch key removed by a generic call", in_sidecar("    // P0b: let the sidecar echo", "    sidecar_command = sidecar_command.env::<&str, &str>(\"MCP_PORT\", \"1\");\n    // P0b: let the sidecar echo")),
        ("the environment cleared after the loop",in_sidecar("    // P0b: let the sidecar echo", "    sidecar_command = sidecar_command.env_clear();\n    // P0b: let the sidecar echo")),
        ("the environment cleared inside the spawn's block initializer", in_sidecar(SIDECAR_SPAWN, &format!("let (mut rx, child) = {{\n        sidecar_command = sidecar_command.env_clear();\n        {SIDECAR_SPAWN_CALL}\n    }};"))),
        ("a different child wrapped", in_sidecar("McpProcessHandle::Sidecar {\n            child,", "McpProcessHandle::Sidecar {\n            child: other_child,")),
    ];
    for (name, source) in cases {
        let verdict = check_spawn_provenance(&source, SIDECAR_FN, false);
        eprintln!("{name} => {verdict:?}");
        assert!(verdict.is_err(), "the census let this sidecar mutation through: {name}");
    }
}

#[test]
fn the_provenance_census_kills_each_planted_mutation_in_the_legacy_path() {
    let in_legacy = |from: &str, to: &str| mutate_in(SIDECAR, LEGACY_FN, from, to);
    let envs = ".envs(env)\n";
    let cases: Vec<(&str, String)> = vec![
        ("a default launch in the process", in_legacy(LET_PROCESS, "let process = McpProcess { handle, launch: McpLaunch::default() };")),
        ("a second mcp_launch_env feeding the launch", in_legacy(LET_LAUNCH, &format!("{LET_LAUNCH}\n    let (launch, _other) = mcp_launch_env(&other_cfg, crate::profile::current().integrity);"))),
        ("launch.port assigned after the let", in_legacy(LET_LAUNCH, &format!("{LET_LAUNCH}\n    launch.port = cfg.mcp_port;"))),
        ("the old builder instead of env", in_legacy(".envs(env)", ".envs(mcp_env(cfg))")),
        ("env rebound after the builder let", in_legacy(LET_LAUNCH, &format!("{LET_LAUNCH}\n    let env = Vec::<(String, String)>::new();"))),
        ("MCP_PORT overridden after .envs", in_legacy(envs, ".envs(env)\n        .env(\"MCP_PORT\", \"42032\")\n")),
        ("the token fallback overridden after .envs", in_legacy(envs, ".envs(env)\n        .env(\"AUTO_TERMINAL_API_TOKEN\", \"x\")\n")),
        ("the environment applied inside if false", in_legacy(".envs(env)", "")
            .replacen("    // CREATE_NO_WINDOW so the node", "    if false { cmd.envs(env); }\n    // CREATE_NO_WINDOW so the node", 1)),
        ("a different process installed", in_legacy(INSTALL_PROCESS, "slot.install_if_current(generation, other)")),
        ("the Err arm no longer shuts the process down", in_legacy(SHUTDOWN_PROCESS, "drop(process);")),
        ("an early return before the launch let", in_legacy(LET_LAUNCH, &format!("return Ok(false);\n    {LET_LAUNCH}"))),
        ("an early return before the wrapper", in_legacy(LET_PROCESS, &format!("return Ok(false);\n    {LET_PROCESS}"))),
        ("an early return between the wrapper and the install", in_legacy(LET_PROCESS, &format!("{LET_PROCESS}\n    return Ok(false);"))),
        ("a return before the poisoned-lock shutdown", in_legacy(SHUTDOWN_PROCESS, &format!("return Err(\"skip shutdown\".into());\n            {SHUTDOWN_PROCESS}"))),
        ("the configured spawn dead, a fresh command spawned", in_legacy(LEGACY_SPAWN, &format!("let child = if false {{ cmd.spawn().map_err(|e| e.to_string())? }} else {{ {FRESH_LEGACY}.spawn().map_err(|e| e.to_string())? }};"))),
        ("a fresh command spawned instead", in_legacy(LEGACY_SPAWN, &format!("let child = {FRESH_LEGACY}.spawn().map_err(|e| e.to_string())?;"))),
        ("the command replaced before the spawn", in_legacy("    let generation = state", "    cmd = std::process::Command::new(\"node\");\n    let generation = state")),
        ("the command replaced inside the spawn's block initializer", in_legacy(LEGACY_SPAWN, "let child = {\n        cmd = std::process::Command::new(\"node\");\n        cmd.arg(&mcp_path);\n        cmd.spawn().map_err(|e| e.to_string())?\n    };")),
        ("the environment cleared in the builder chain", in_legacy(envs, ".envs(env)\n        .env_clear()\n")),
        ("the environment cleared in a later statement", in_legacy("    let generation = state", "    cmd.env_clear();\n    let generation = state")),
        ("a launch key removed by a generic call in a later statement", in_legacy("    let generation = state", "    cmd.env_remove::<&str>(\"MCP_PORT\");\n    let generation = state")),
        ("a launch key removed by a generic call in the builder chain", in_legacy(envs, ".envs(env)\n        .env_remove::<&str>(\"MCP_PORT\")\n")),
        ("a launch key overridden by a generic call in the builder chain", in_legacy(envs, ".envs(env)\n        .env::<&str, &str>(\"MCP_PORT\", \"42032\")\n")),
        ("a launch key removed after the environment", in_legacy("    let generation = state", "    cmd.env_remove(\"MCP_PORT\");\n    let generation = state")),
        ("a different child wrapped", in_legacy("McpProcessHandle::Legacy(child)", "McpProcessHandle::Legacy(other_child)")),
    ];
    for (name, source) in cases {
        let verdict = check_spawn_provenance(&source, LEGACY_FN, true);
        eprintln!("{name} => {verdict:?}");
        assert!(verdict.is_err(), "the census let this legacy mutation through: {name}");
    }
}
