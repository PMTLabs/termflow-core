//! Plan 055 T3: the launch record is built from the same locals as the spawn and lives in the
//! process slot. The provenance census proves it on masked source, each subject in the context
//! its row of the execution-context table requires (setup before the spawn; the wrapper after it;
//! install and shutdown in their match arms), and kills the planted mutations.

use super::live_call_census::{chain, find_calls, require_top_statement, word_uses, Src, Sub};
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
const SHUTDOWN_PROCESS: &str = "crate::shutdown_mcp_handle(process);";
const INSTALL_PROCESS: &str = "slot.install_if_current(generation, process)";
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
    let spawns: Vec<usize> =
        (0..body.stmts.len()).filter(|i| src.masked[at(*i).clone()].contains(".spawn(")).collect();
    let [spawn_idx] = spawns[..] else {
        return Err(format!("expected one top-level spawn statement, found {}", spawns.len()));
    };
    // The owning statement applies exactly that `env`; the receiver and arguments are child spans.
    let (consumer_idx, applied_to) = if legacy {
        let idx = (0..body.stmts.len())
            .find(|i| src.norm(at(*i)).starts_with("cmd.arg("))
            .ok_or("the command builder statement is gone")?;
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
        (idx, args.end + 1)
    } else {
        let idx = require_top_statement(&src, &body, SIDECAR_LOOP)?;
        (idx, at(idx).end)
    };
    if !(let_idx < consumer_idx && consumer_idx < spawn_idx) {
        return Err("the environment must be built, then applied, then the command spawned".into());
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
    ];
    for (name, source) in cases {
        assert!(check_spawn_provenance(&source, SIDECAR_FN, false).is_err(), "the census let this sidecar mutation through: {name}");
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
    ];
    for (name, source) in cases {
        assert!(check_spawn_provenance(&source, LEGACY_FN, true).is_err(), "the census let this legacy mutation through: {name}");
    }
}
