use std::collections::HashMap;
use sysinfo::{Pid, System};
use super::spawn_spec::PS_CWD_INTEGRATION;

/// How deep the foreground descent may go before it gives up.
///
/// The walk reads a process table from a live OS, and a parent/child cycle — however it arises, a
/// pid reused between the enumeration of one level and the next included — would spin forever
/// inside the mutex `ProcSnapshot` holds while targeting resolves. The chain is also allocated now
/// rather than collapsed to its last element, so the bound caps an allocation as well as a loop.
/// Real chains are three or four deep: `pwsh -> claude.exe -> bun.exe -> conhost.exe`.
const MAX_FOREGROUND_DEPTH: usize = 32;

/// The chain of process ids from `start_pid` down to its deepest foreground descendant, taking the
/// newest child at each level.
///
/// Pure core of the descent, split out for exactly the reason [`has_live_children`] below is: the
/// walk IS the behaviour, and a live process table cannot be arranged into the shape a test needs.
/// `procs` yields `(pid, parent_pid)` for every process on the machine.
///
/// **It returns every level, not just the last, and that is the whole point.** The deepest
/// descendant answers "what was most recently spawned under this terminal", which is not the
/// question `Command contains` asks. Measured on a real machine: a terminal running the Claude CLI
/// is `pwsh -> claude.exe -> bun.exe -> conhost.exe`, so reading only the deepest level tested
/// `conhost.exe`'s command line and a rule matching `claude` selected nothing, on every tick,
/// forever. The agent is on the chain — just never at the end of it, because agents spawn helpers.
/// [`get_foreground_agent_with_exe`] never had this bug because it tests every level as it
/// descends, which is why per-agent colour schemes could name Claude while targeting could not.
fn foreground_chain_from(
    start_pid: u32,
    procs: impl Iterator<Item = (u32, Option<u32>)>,
) -> Vec<u32> {
    // Indexed once rather than re-scanning the whole table per level, which is what this descent
    // used to do. The chain is short; the process table is not.
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (pid, parent) in procs {
        if let Some(ppid) = parent {
            children.entry(ppid).or_default().push(pid);
        }
    }

    let mut chain = vec![start_pid];
    let mut current = start_pid;
    while chain.len() < MAX_FOREGROUND_DEPTH {
        // Highest pid is "newest" — the same heuristic this descent has always used.
        let Some(&newest) = children.get(&current).and_then(|kids| kids.iter().max()) else {
            break;
        };
        if chain.contains(&newest) {
            break;
        }
        chain.push(newest);
        current = newest;
    }
    chain
}

/// [`foreground_chain_from`] against a live process table.
fn foreground_chain(start_pid: u32, sys: &System) -> Vec<u32> {
    foreground_chain_from(
        start_pid,
        sys.processes()
            .values()
            .map(|p| (p.pid().as_u32(), p.parent().map(|ppid| ppid.as_u32()))),
    )
}

/// [`foreground_chain`] with each level's executable name attached, shell first.
///
/// A level sysinfo cannot report (protected, or cross-arch on Windows) keeps its place with an
/// EMPTY name rather than being dropped: it is still a real process whose cwd may be readable, and
/// removing it would silently shorten the chain — the same rule `foreground_command_lines` follows
/// for the same reason.
pub(crate) fn foreground_chain_named(parent_pid: u32, sys: &System) -> Vec<(u32, String)> {
    foreground_chain(parent_pid, sys)
        .into_iter()
        .map(|pid| {
            let name = sys
                .process(Pid::from(pid as usize))
                .map(|p| p.name().to_string_lossy().to_string())
                .unwrap_or_default();
            (pid, name)
        })
        .collect()
}

/// The Windows console-host helpers: `conhost.exe` / `OpenConsole.exe`.
///
/// These are ConPTY plumbing, not programs the user ran, and they sit at the END of a real
/// foreground chain: `pwsh -> claude.exe -> bun.exe -> conhost.exe` is a measurement off a live
/// machine, not an invention (see [`foreground_chain_from`]). Anything that reads only the deepest
/// link therefore reads the console host, which breaks in two separate ways:
///
///   * its PEB working directory is **`C:\WINDOWS`**, never the user's project — so a terminal
///     sitting in `D:\work\project` resolves clicked relative paths against `C:\WINDOWS` and every
///     of them is "not found", and the 30s cwd refresh PERSISTS `C:\WINDOWS` into the session
///     snapshot, reopening the terminal there on the next restart; and
///   * its NAME is what "which program is in front" reports — so a live Claude session is
///     announced as `conhost.exe` in the close-confirmation list and the peers panel.
///
/// Deliberately NOT applied to [`foreground_command_lines`]: automation's `Command contains`
/// matches against the RAW chain, and a user rule naming `conhost` must keep matching — which
/// `automation::targeting` asserts directly.
fn is_console_host(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let stem = lower.strip_suffix(".exe").unwrap_or(&lower);
    matches!(stem, "conhost" | "openconsole")
}

/// The deepest level of a foreground chain that names a program the user actually ran.
///
/// `chain` is shell-first, so the search ends at the shell itself — a chain of nothing but console
/// hosts is impossible (the shell heads it), and an empty chain yields `None` for the caller to
/// fall back on.
fn deepest_real_program(chain: &[(u32, String)]) -> Option<u32> {
    chain
        .iter()
        .rev()
        .find(|(_, name)| !is_console_host(name))
        .map(|(pid, _)| *pid)
}

/// The working directory of the deepest chain level that BOTH names a real program and has a
/// readable cwd. `chain` is shell-first: `(name, cwd)` per level.
///
/// Climbing on an unreadable level (rather than giving up on it) generalises the old
/// `deepest.or_else(shell)` fallback to every level in between. That matters on the exact shape
/// this exists for — under `claude.exe` the readable, correct directory belongs to a MIDDLE link,
/// and jumping straight back to the shell would discard it. It also beats the shell for PowerShell
/// specifically, whose PEB cwd is frozen at its spawn directory and never follows `Set-Location`.
pub(crate) fn deepest_chain_cwd(chain: &[(String, Option<String>)]) -> Option<String> {
    chain
        .iter()
        .rev()
        .find(|(name, cwd)| cwd.is_some() && !is_console_host(name))
        .and_then(|(_, cwd)| cwd.clone())
}

pub fn get_foreground_process_info(parent_pid: u32, sys_opt: Option<&System>) -> (u32, String) {
    let local_sys;
    let sys = if let Some(s) = sys_opt {
        s
    } else {
        local_sys = System::new_all();
        &local_sys
    };

    // The deepest descendant that is not console-host plumbing — "which program is in front".
    // Callers that need to recognise a program ANYWHERE under the shell take
    // `foreground_command_lines` instead.
    let chain = foreground_chain_named(parent_pid, sys);
    let pid = deepest_real_program(&chain).unwrap_or(parent_pid);
    let current_name = sys
        .process(Pid::from(pid as usize))
        .map(|p| p.name().to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    (pid, current_name)
}

/// The command line of EVERY process on the foreground chain under `parent_pid`, shell first.
///
/// `Command contains` matches when any of these contains the needle, which is the only reading of
/// "this terminal is running claude" that survives contact with a real agent — see
/// [`foreground_chain_from`] for the measurement that forced it.
///
/// It reads command lines rather than process NAMES because an npm-installed agent is `node.exe`,
/// the same reason `detect_agent` reads argv to disambiguate. Matching names would select every
/// node process on the machine at once.
///
/// A process sysinfo cannot report (protected, or cross-arch on Windows) is **skipped rather than
/// ending the chain**: it must read as "no match", never as "matches everything", and never as a
/// reason to stop looking at the levels below it. Falls back to the executable name when argv is
/// empty, which is what sysinfo returns for some system processes. An EMPTY vector means no scan
/// was taken this window, or nothing on the chain was readable — both are "no match". Plan 028 §4.4.
pub fn foreground_command_lines(parent_pid: u32, sys: &System) -> Vec<String> {
    foreground_chain(parent_pid, sys)
        .into_iter()
        .filter_map(|pid| {
            let process = sys.process(Pid::from(pid as usize))?;
            let argv: Vec<String> = process
                .cmd()
                .iter()
                .map(|s| s.to_string_lossy().to_string())
                .collect();
            Some(command_line_for(&argv, &process.name().to_string_lossy()))
        })
        .collect()
}

/// One process's command line, from its argv and its executable name.
///
/// Pure, because the two decisions in it cannot be reached by arranging a live process table: the
/// empty-argv fallback, and — the one that matters — dropping the prompt-integration arguments
/// **TermFlow itself injected** into the user's shell.
///
/// **Why the injected script must not be a haystack.** Both spawn paths (`spawn_terminal` and
/// `build_spawn_spec`) append `-NoExit -Command <PS_CWD_INTEGRATION>` to every interactive
/// PowerShell, and that script is ~300 characters of app-authored text containing `CurrentDirectory`,
/// `FileSystem`, `[Environment]`, `[Console]::Write`, `Provider.Name`, `ProviderPath`, `prompt`,
/// `try`, `catch`, `function`… Once `Command contains` began reading the SHELL link of the chain
/// (which it must, or an idle `pwsh` stops matching `pwsh`), every one of those words would select
/// EVERY PowerShell terminal in the app. A rule reading `command contains "dir"` with a send action
/// would then type into all of them on its first tick — and the user neither wrote that text nor can
/// see it. Matching on it is matching on an implementation detail of OSC 9;9 cwd reporting.
///
/// **Only the exact injected sequence is removed, never a user's own flags.** The script is compared
/// against the constant itself, and `-Command` / `-NoExit` are dropped only as the tokens
/// immediately preceding that exact match — so a profile that legitimately passes `-NoExit` keeps it.
pub fn command_line_for(argv: &[String], name: &str) -> String {
    let mut dropped = vec![false; argv.len()];
    for (i, arg) in argv.iter().enumerate() {
        if arg != PS_CWD_INTEGRATION {
            continue;
        }
        dropped[i] = true;
        if i >= 1 && argv[i - 1] == "-Command" {
            dropped[i - 1] = true;
            if i >= 2 && argv[i - 2] == "-NoExit" {
                dropped[i - 2] = true;
            }
        }
    }
    let kept: Vec<&str> = argv
        .iter()
        .zip(dropped)
        .filter_map(|(a, d)| (!d).then_some(a.as_str()))
        .collect();
    // Falls back to the executable name when argv is empty, which is what sysinfo returns for some
    // system processes — and when stripping consumed everything, which cannot happen for a real
    // spawn (argv[0] is the shell) but must not yield an empty string that `contains` treats as a
    // match for nothing.
    if kept.is_empty() {
        return name.to_string();
    }
    kept.join(" ")
}

/// Derive a friendly label for the foreground program in a pane, from a
/// process's executable name and full argv. Returns None for a plain shell (an
/// idle pane) so the caller reverts to tab/default theming; returns a friendly
/// name for ANY other program so any agent — known or future — can be colored.
///
/// Matching is case-insensitive. argv is scanned ONLY when the exe is a script
/// interpreter (node/python/…), so an ordinary command that merely takes an
/// agent's name as an argument (`git checkout claude`) is labeled by its own exe
/// (`git`), never by the argument. Theming stays opt-in: a returned label only
/// recolors a pane when the user has assigned it a color.
pub fn detect_agent(name: &str, cmd: &[String]) -> Option<String> {
    let lowered = name.to_ascii_lowercase();
    let exe = lowered.strip_suffix(".exe").unwrap_or(&lowered);

    // Plain shells are "idle" — no agent. Excluding them keeps revert-on-exit
    // working and lets get_foreground_agent's walk descend past a shell (or a
    // Windows `.cmd` npm-shim) to the program the user actually launched.
    const SHELLS: &[&str] = &[
        "pwsh", "powershell", "bash", "sh", "zsh", "fish", "cmd", "wsl",
        "nu", "dash", "ksh", "csh", "tcsh",
    ];
    if SHELLS.contains(&exe) {
        return None;
    }

    // Script interpreters host an agent (claude/gemini/aider/…) — the exe alone
    // is "node"/"python", so derive the real name from argv. Gating argv scanning
    // to interpreters is what stops a non-interpreter that merely takes an agent's
    // name as an argument (`git checkout claude`) from misdetecting.
    const INTERPRETERS: &[&str] = &["node", "bun", "deno", "npx", "python", "python3", "py"];
    if INTERPRETERS.contains(&exe) {
        return Some(derive_interpreted_label(cmd).unwrap_or_else(|| exe.to_string()));
    }

    // Any other program is labeled by its own executable name.
    Some(exe.to_string())
}

/// Derive an agent name from an interpreter's argv (argv[0] is the interpreter,
/// skipped). First honor unambiguous package/module markers for canonical names;
/// otherwise use the basename of the first non-flag argv token, stripped of a
/// script extension. None when argv has no usable token (bare REPL).
fn derive_interpreted_label(cmd: &[String]) -> Option<String> {
    let joined = cmd
        .iter()
        .skip(1)
        .map(|s| s.to_ascii_lowercase())
        .collect::<Vec<_>>()
        .join(" ");
    const MARKERS: &[(&str, &str)] = &[
        ("claude-code", "claude"),
        ("@anthropic-ai/claude", "claude"),
        ("gemini-cli", "gemini"),
        ("@google/gemini", "gemini"),
        ("cursor-agent", "cursor-agent"),
    ];
    for (needle, label) in MARKERS {
        if joined.contains(needle) {
            return Some((*label).to_string());
        }
    }
    for arg in cmd.iter().skip(1) {
        let a = arg.to_ascii_lowercase();
        if a.starts_with('-') {
            continue; // skip flags (e.g. `-m aider`, `--foo`)
        }
        let base = a.rsplit(|c| c == '/' || c == '\\').next().unwrap_or(&a);
        let stem = base
            .strip_suffix(".js")
            .or_else(|| base.strip_suffix(".mjs"))
            .or_else(|| base.strip_suffix(".cjs"))
            .or_else(|| base.strip_suffix(".ts"))
            .or_else(|| base.strip_suffix(".py"))
            .unwrap_or(base);
        if !stem.is_empty() {
            return Some(stem.to_string());
        }
    }
    None
}

/// Walk a shell's descendant chain and return the first non-shell program (the
/// shallowest descendant the user launched). Because `detect_agent` returns None
/// for shells and a name for anything else, the walk stops at that launched
/// program — so an agent that spawned a transient child (e.g. claude launching
/// `git`/`rg`) is still reported as the agent, not the transient child. Returns
/// None when only shells are found (an idle pane).
pub fn get_foreground_agent(parent_pid: u32, sys: &System) -> Option<String> {
    get_foreground_agent_with_exe(parent_pid, sys).map(|(agent, _)| agent)
}

/// Like [`get_foreground_agent`], but also returns the matched process's executable
/// path (absolute), so the caller can extract the binary's icon. The exe is `None`
/// when sysinfo can't report it (a protected or cross-arch process on Windows).
/// Walk semantics are identical to `get_foreground_agent`.
pub fn get_foreground_agent_with_exe(
    parent_pid: u32,
    sys: &System,
) -> Option<(String, Option<String>)> {
    // The SAME descent as everything else here, stopping at the first level `detect_agent` names.
    // It had its own copy of the walk until the chain was extracted, and that copy was the one
    // WITHOUT the depth cap and the cycle guard — on a path that also runs behind `/api/processes`
    // and `AgentSchemeTracker`, where a pid reused between two level enumerations would have spun
    // forever. The difference between this and `foreground_command_lines` was only ever where it
    // stops READING, never how it descends, so there was nothing here to keep.
    foreground_chain(parent_pid, sys).into_iter().find_map(|pid| {
        let p = sys.process(Pid::from(pid as usize))?;
        let name = p.name().to_string_lossy().to_string();
        let cmd: Vec<String> = p
            .cmd()
            .iter()
            .map(|s| s.to_string_lossy().to_string())
            .collect();
        detect_agent(&name, &cmd).map(|agent| (agent, p.exe().map(|e| e.to_string_lossy().to_string())))
    })
}

/// True iff any process in `procs` names `pid` as its parent. Pure core of
/// [`session_at_bare_prompt`], split out so the strict at-prompt policy is
/// testable without a live process table.
fn has_live_children(pid: u32, mut procs: impl Iterator<Item = (u32, Option<u32>)>) -> bool {
    procs.any(|(_, parent)| parent == Some(pid))
}

/// Strict "reattached session is sitting at a bare shell prompt" signal for the
/// command-suggest gate seed (design 006): true ONLY when the shell process
/// exists and has ZERO live children. Nested shells, agent CLIs, REPLs,
/// background jobs, a dead/unknown pid, or a transient prompt-hook child all
/// return false — the safe direction (a false `armed:true` would recreate the
/// popup-leak-into-agent bug; a false `armed:false` self-heals at next prompt).
pub fn session_at_bare_prompt(shell_pid: u32, sys: &System) -> bool {
    if shell_pid == 0 {
        return false;
    }
    let Some(process) = sys.process(Pid::from(shell_pid as usize)) else {
        return false;
    };
    // Identity guard: the prompt hook only ever targets interactive PowerShell,
    // so a pid that no longer names a pwsh/powershell process is a recycled or
    // stale pid (review 008 m-2) — uncertainty, never an armed seed.
    let name = process.name().to_string_lossy().to_ascii_lowercase();
    if !(name.starts_with("pwsh") || name.starts_with("powershell")) {
        return false;
    }
    !has_live_children(
        shell_pid,
        sys.processes()
            .values()
            .map(|p| (p.pid().as_u32(), p.parent().map(|pp| pp.as_u32()))),
    )
}

#[cfg(test)]
mod bare_prompt_tests {
    use super::{has_live_children, session_at_bare_prompt};

    #[test]
    fn no_children_means_bare() {
        // (pid, parent) pairs — nothing claims 42 as parent.
        let procs = vec![(42, None), (7, Some(1)), (9, Some(7))];
        assert!(!has_live_children(42, procs.into_iter()));
    }

    #[test]
    fn direct_child_means_not_bare() {
        let procs = vec![(42, None), (100, Some(42))];
        assert!(has_live_children(42, procs.into_iter()));
    }

    #[test]
    fn any_child_counts_even_a_shell() {
        // Strict mode: a nested shell (cmd/wsl under pwsh) is still a child —
        // deliberately NOT at-prompt (design 006: leak-safe direction).
        let procs = vec![(42, None), (100, Some(42)), (101, Some(100))];
        assert!(has_live_children(42, procs.into_iter()));
    }

    #[test]
    fn dead_or_zero_pid_is_never_bare_prompt() {
        let sys = sysinfo::System::new(); // empty snapshot: every pid is "dead"
        assert!(!session_at_bare_prompt(0, &sys), "pid 0 sentinel is uncertainty");
        assert!(!session_at_bare_prompt(4_000_000, &sys), "unknown pid is uncertainty");
    }

    /// Review 008 m-2: a live pid whose process is NOT pwsh/powershell is a
    /// recycled/stale identity (the hook only targets interactive PowerShell)
    /// and must never arm. The test binary's own pid is live but not pwsh.
    #[test]
    fn wrong_process_identity_is_never_bare_prompt() {
        let mut sys = sysinfo::System::new();
        let me = sysinfo::Pid::from_u32(std::process::id());
        sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[me]), true);
        assert!(
            sys.process(me).is_some(),
            "own process must be in the snapshot for this test to bite"
        );
        assert!(!session_at_bare_prompt(std::process::id(), &sys));
    }
}

#[cfg(test)]
mod chain_tests {
    use super::{deepest_chain_cwd, deepest_real_program, is_console_host};
    use super::detect_agent;
    use super::{get_foreground_agent, get_foreground_agent_with_exe};
    use super::PS_CWD_INTEGRATION;
    use sysinfo::System;

    /// One level of a foreground chain, as `deepest_chain_cwd` consumes it.
    fn level(name: &str, cwd: Option<&str>) -> (String, Option<String>) {
        (name.to_string(), cwd.map(str::to_string))
    }

    /// **The defect, in the exact shape it was measured in on a live machine.**
    ///
    /// `pwsh -> claude.exe -> cmd.exe -> conhost.exe`, with every level's PEB working directory
    /// read off a running TermFlow. The chain's LAST link is the console host and its directory is
    /// `C:\WINDOWS`; every other link sits in the user's project. A cwd read that accepts the
    /// deepest link therefore answered `C:\WINDOWS` for a terminal open in
    /// `D:\work\project` — so every clicked relative path resolved under `C:\WINDOWS` and
    /// came back "not found", and the 30s refresh PERSISTED that directory into the session
    /// snapshot on top of it.
    ///
    /// This only became visible after an offload-and-update reattach because `state.terminal_cwds`
    /// (the OSC 9;9 map, which short-circuits this scan) is in-process app state: a restart empties
    /// it, and a PowerShell sitting inside a running agent emits no new prompt, so nothing refills
    /// it and the process fallback runs unopposed. cmd/bash/WSL/zsh never populate that map at all,
    /// so for them the fallback — and this bug — ran on every single tick.
    ///
    /// Asserted over the pure picker rather than a live process table for the same reason
    /// `foreground_chain_from` is: the walk IS the behaviour, and a real process tree cannot be
    /// arranged into the shape a test needs.
    #[test]
    fn the_cwd_walk_climbs_past_a_console_host_at_the_end_of_the_chain() {
        let chain = [
            level("pwsh.exe", Some(r"D:\work\project")),
            level("claude.exe", Some(r"D:\work\project")),
            level("cmd.exe", Some(r"D:\work\project")),
            level("conhost.exe", Some(r"C:\WINDOWS")),
        ];
        assert_eq!(
            deepest_chain_cwd(&chain).as_deref(),
            Some(r"D:\work\project"),
            "the console host's C:\\WINDOWS must never be a terminal's working directory"
        );
    }

    /// The climb does not stop at the first skip, and it does not give up and jump to the shell.
    ///
    /// `bun.exe -> conhost.exe` is the OTHER measured leaf shape, and above it sits a level the OS
    /// would not report (protected / cross-arch — sysinfo returns no cwd). The correct answer is the
    /// deepest level that has one, which here is the AGENT's directory — the one the user is
    /// actually working in, and the one the old `deepest.or_else(shell)` fallback threw away in
    /// favour of the shell's.
    ///
    /// The shell's directory is deliberately DIFFERENT from the agent's, so falling back to it is a
    /// distinguishable failure rather than an accidental pass.
    #[test]
    fn the_cwd_walk_climbs_past_a_level_the_os_will_not_report() {
        let chain = [
            level("pwsh.exe", Some(r"D:\work")),
            level("claude.exe", Some(r"D:\work\project")),
            level("bun.exe", None),
            level("conhost.exe", Some(r"C:\WINDOWS")),
        ];
        assert_eq!(
            deepest_chain_cwd(&chain).as_deref(),
            Some(r"D:\work\project"),
            "an unreadable level must be climbed past, not treated as the end of the walk"
        );
    }

    /// The deepest level still wins when nothing on the chain needs skipping — the climb must not
    /// have quietly become "prefer the shell". `codex` is the measured non-conhost leaf shape.
    #[test]
    fn the_cwd_walk_still_takes_the_deepest_level_when_it_is_a_real_program() {
        let chain = [
            level("pwsh.exe", Some(r"D:\work")),
            level("cmd.exe", Some(r"D:\work")),
            level("codex.exe", Some(r"D:\work\project\subdir")),
        ];
        assert_eq!(
            deepest_chain_cwd(&chain).as_deref(),
            Some(r"D:\work\project\subdir"),
        );
        // Nothing readable anywhere is still None, so callers fall back to the app default rather
        // than to a directory invented here.
        assert_eq!(deepest_chain_cwd(&[level("pwsh.exe", None)]), None);
        assert_eq!(deepest_chain_cwd(&[]), None);
    }

    /// `/api/processes` reports "which program is in front", and it read the same deepest link —
    /// so a live Claude session was announced as `conhost.exe` in the close-confirmation list and
    /// the peers panel. Same chain, same skip, asserted where that answer is chosen.
    #[test]
    fn the_foreground_program_is_the_deepest_level_that_is_not_a_console_host() {
        let chain = [
            (100u32, "pwsh.exe".to_string()),
            (200, "claude.exe".to_string()),
            (300, "bun.exe".to_string()),
            (400, "conhost.exe".to_string()),
        ];
        assert_eq!(deepest_real_program(&chain), Some(300));
        // An empty chain has no answer; the caller falls back to the shell pid it asked about.
        assert_eq!(deepest_real_program(&[]), None);
    }

    /// A guard is only as good as the spellings it recognises, so this asserts the whole SET
    /// rather than one sample: both console hosts, both cases, with and without the extension —
    /// and, on the other side, that it does not swallow ordinary programs whose names merely
    /// CONTAIN one of the words. `conhost` matching by substring would drop a real program's
    /// directory on the floor, which is the same class of over-match the automation matcher was
    /// bitten by.
    #[test]
    fn the_console_host_guard_matches_every_spelling_and_nothing_else() {
        for name in ["conhost.exe", "CONHOST.EXE", "ConHost.Exe", "conhost", "OpenConsole.exe", "openconsole.exe", "openconsole", "OPENCONSOLE"] {
            assert!(is_console_host(name), "{name} must be recognised as a console host");
        }
        for name in ["cmd.exe", "pwsh.exe", "claude.exe", "node.exe", "bun.exe", "bash.exe", "codex.exe", "", "conhostile.exe", "myconhost.exe", "openconsole-viewer.exe", "conhost.exe.bak"] {
            assert!(!is_console_host(name), "{name} must NOT be treated as a console host");
        }
    }

    #[test]
    fn detect_agent_native_exe_uses_own_name() {
        assert_eq!(detect_agent("codex.exe", &["codex".into()]), Some("codex".into()));
        assert_eq!(detect_agent("codex", &["codex".into()]), Some("codex".into()));
        // Any future native agent is labeled by its own name — no allowlist.
        assert_eq!(detect_agent("agy.exe", &["agy".into()]), Some("agy".into()));
        assert_eq!(detect_agent("aider", &["aider".into()]), Some("aider".into()));
    }

    #[test]
    fn detect_agent_shells_return_none() {
        for sh in ["pwsh", "powershell.exe", "bash", "zsh", "fish", "cmd.exe", "wsl", "nu"] {
            assert_eq!(detect_agent(sh, &[sh.into()]), None, "shell {sh} must be None");
        }
    }

    #[test]
    fn detect_agent_interpreter_marker_gives_canonical_name() {
        let claude = vec![
            "node".into(),
            "C:\\Users\\x\\AppData\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js".into(),
        ];
        assert_eq!(detect_agent("node", &claude), Some("claude".into()));
        assert_eq!(detect_agent("node", &["node".into(), "/usr/local/bin/claude".into()]), Some("claude".into()));
        let gemini = vec!["node".into(), "/usr/lib/node_modules/@google/gemini-cli/dist/gemini.js".into()];
        assert_eq!(detect_agent("node", &gemini), Some("gemini".into()));
        assert_eq!(detect_agent("python", &["python".into(), "-m".into(), "aider".into()]), Some("aider".into()));
    }

    #[test]
    fn detect_agent_interpreter_uses_script_basename_when_unknown() {
        // Open detection: an unknown script is labeled by its own basename, never
        // by an incidental agent-name elsewhere in the path.
        assert_eq!(detect_agent("node", &["node".into(), "server.js".into()]), Some("server".into()));
        assert_eq!(detect_agent("node", &["node".into(), "./codex-playground/run.js".into()]), Some("run".into()));
        assert_eq!(detect_agent("node", &["node".into(), "/home/gemini-stuff/build.js".into()]), Some("build".into()));
        // A direct basename invocation still yields that name.
        assert_eq!(detect_agent("node", &["node".into(), "/opt/tools/gemini.js".into()]), Some("gemini".into()));
    }

    #[test]
    fn detect_agent_arg_never_cross_misdetects() {
        // A non-interpreter taking an agent's name as an argument is labeled by its
        // OWN exe (open detection), and MUST NOT be labeled by the argument.
        assert_eq!(detect_agent("git", &["git".into(), "checkout".into(), "claude".into()]), Some("git".into()));
        assert_eq!(detect_agent("mkdir", &["mkdir".into(), "aider".into()]), Some("mkdir".into()));
        assert_eq!(detect_agent("grep", &["grep".into(), "gemini".into(), "file.txt".into()]), Some("grep".into()));
    }

    #[test]
    fn foreground_agent_delegates_to_with_exe_variant() {
        // The test binary has no child processes, so both the label-only and the
        // exe-aware walk return None from the test pid — proving get_foreground_agent
        // is a faithful projection of get_foreground_agent_with_exe.
        let sys = System::new_all();
        let pid = std::process::id();
        let label_only = get_foreground_agent(pid, &sys);
        let with_exe = get_foreground_agent_with_exe(pid, &sys);
        assert_eq!(label_only, with_exe.clone().map(|(a, _)| a));
    }

    /// The chain starts at the pid it was ASKED about, never at some descendant.
    ///
    /// Named for the one property it can actually fail on: a walk that dropped its own start would
    /// still return something plausible here. The argv-rather-than-process-name claim this test
    /// used to carry in its name was never pinned by it — `"app.exe".contains("app")` is true of
    /// the exe name too — and now lives in `command_line_for`'s own table below, where a fixture
    /// can state it.
    #[test]
    fn foreground_command_lines_start_at_the_pid_they_were_asked_about() {
        let sys = System::new_all();
        let me = std::process::id();
        let lines = super::foreground_command_lines(me, &sys);
        assert!(!lines.is_empty(), "this process is in its own snapshot");
        // The FIRST line is this process itself — the chain starts at the pid it was asked about,
        // never at some descendant. A walk that dropped its own start would still return something
        // plausible here, which is why this asserts the head and not merely "somewhere in there".
        let exe_stem = std::env::current_exe()
            .ok()
            .and_then(|p| p.file_stem().map(|s| s.to_string_lossy().to_string()))
            .unwrap_or_default();
        assert!(
            lines[0].to_lowercase().contains(&exe_stem.to_lowercase()),
            "expected {:?} to name this executable ({:?})",
            lines[0],
            exe_stem
        );
    }

    /// **The defect this walk was rewritten for, in the shape it was measured in.**
    ///
    /// A terminal running the Claude CLI on Windows is `pwsh -> claude.exe -> bun.exe ->
    /// conhost.exe` — read off a live process table, not invented. The descent's LAST element is
    /// `conhost.exe`, so a matcher reading only the deepest descendant tested conhost's command
    /// line and `Command contains "claude"` selected nothing, on every tick, forever.
    ///
    /// The chain is asserted as an ordered LIST rather than by "does it contain the agent",
    /// because the ORDER carries two separate claims — that the walk starts at the terminal's own
    /// shell, and that it takes the newest child at each level — and a containment check states
    /// neither. `has_live_children`'s pure-core shape is the precedent for testing a process walk
    /// without a live process table.
    #[test]
    fn the_foreground_chain_keeps_every_level_not_only_the_deepest() {
        // (pid, parent). The agent sits in the middle, with a helper below it and an older
        // sibling beside it.
        let procs: [(u32, Option<u32>); 6] = [
            (100, None),      // pwsh — the terminal's own process
            (200, Some(100)), // claude.exe
            (150, Some(100)), // an OLDER sibling of the agent: never chosen over pid 200
            (300, Some(200)), // bun.exe, spawned by the agent
            (400, Some(300)), // conhost.exe
            (999, Some(555)), // an unrelated tree, which must not be walked into
        ];
        assert_eq!(
            super::foreground_chain_from(100, procs.into_iter()),
            vec![100, 200, 300, 400],
            "shell -> agent -> helper -> conhost, in order"
        );
        // (The point that the LAST level is precisely the one not naming the agent is asserted
        // where it bites, over `resolve` itself, in `automation/targeting.rs` — restating it here
        // as `.last() == Some(&400)` could not fail once the equality above has passed.)
    }

    /// **The prompt script TermFlow injects is not a haystack** — the regression this guard exists
    /// for, and the cost of matching the shell link of the chain.
    ///
    /// Both spawn paths append `-NoExit -Command <PS_CWD_INTEGRATION>` to every interactive
    /// PowerShell. That is ~300 characters of app-authored text the user never wrote and cannot
    /// see. Left in, roughly thirty ordinary needles would select EVERY PowerShell terminal at
    /// once — and an automation rule with a send action would then type into all of them on its
    /// first tick.
    ///
    /// Asserted as a LIST, because "it does not over-match" is a claim about a SET and one sample
    /// cannot state it. The un-stripped line is asserted FIRST to contain every needle: without
    /// that half the list could quietly stop naming anything real and the test would pass by
    /// describing nothing.
    #[test]
    fn the_injected_prompt_script_is_not_matchable() {
        let argv: Vec<String> = vec![
            r"C:\Program Files\PowerShell\7\pwsh.exe".into(),
            "-NoExit".into(),
            "-Command".into(),
            PS_CWD_INTEGRATION.into(),
        ];
        // Only words the INJECTION contributes. A real `pwsh.exe` path legitimately carries
        // "Files" and "System32", and a rule matching those is matching something the command line
        // genuinely says — not this defect.
        // The last two are the injected FLAGS rather than the script body, and they earn their
        // place: stripping the script while leaving `-Command`/`-NoExit` behind is the partial fix
        // this list has to be able to fail on.
        const INJECTED_ONLY: &[&str] = &[
            "prompt", "console", "provider", "environment", "currentdirectory", "providerpath",
            "filesystem", "function", "catch", "atorig", "pwd", "command", "noexit",
        ];

        let unstripped = argv.join(" ").to_lowercase();
        for needle in INJECTED_ONLY {
            assert!(
                unstripped.contains(needle),
                "fixture no longer contains {:?} — this list is describing nothing",
                needle
            );
        }

        let line = super::command_line_for(&argv, "pwsh.exe");
        let lowered = line.to_lowercase();
        for needle in INJECTED_ONLY {
            assert!(
                !lowered.contains(needle),
                "{:?} would select every PowerShell terminal in the app: {:?}",
                needle,
                line
            );
        }
        // ...and the shell is still matchable, which is the entire reason its link is on the chain.
        assert!(lowered.contains("pwsh"), "the shell must stay matchable: {:?}", line);
    }

    /// The stripping is exact: a profile's OWN `-NoExit -Command` survives untouched.
    ///
    /// The tokens are dropped only as the ones immediately preceding a literal match on the
    /// constant, so a user driving their shell with a real `-Command` keeps every word of it —
    /// which is command line they wrote and expect to be able to match on.
    #[test]
    fn command_line_for_strips_only_the_injected_sequence() {
        let user: Vec<String> = vec![
            "pwsh.exe".into(),
            "-NoExit".into(),
            "-Command".into(),
            "Write-Host hi".into(),
        ];
        assert_eq!(
            super::command_line_for(&user, "pwsh.exe"),
            "pwsh.exe -NoExit -Command Write-Host hi"
        );

        // Empty argv is what sysinfo returns for some system processes: the name stands in.
        assert_eq!(super::command_line_for(&[], "conhost.exe"), "conhost.exe");

        // An ordinary agent command line is untouched, which is the common case.
        let agent: Vec<String> = vec!["node".into(), "C:/n/claude.js".into(), "--resume".into()];
        assert_eq!(
            super::command_line_for(&agent, "node.exe"),
            "node C:/n/claude.js --resume"
        );
    }

    /// A childless pid is its own chain, and so is one absent from the table.
    ///
    /// The absent case matters because the roster asks about a terminal's shell pid, and a shell
    /// that exited between the snapshot and the walk must yield "no match", never a panic and
    /// never someone else's chain.
    #[test]
    fn a_childless_or_unknown_start_is_a_one_element_chain() {
        let procs: [(u32, Option<u32>); 2] = [(100, None), (200, Some(100))];
        assert_eq!(super::foreground_chain_from(200, procs.into_iter()), vec![200]);
        assert_eq!(super::foreground_chain_from(7, procs.into_iter()), vec![7]);
    }

    /// A parent/child cycle must not hang the walk.
    ///
    /// Targeting runs this inside the mutex `ProcSnapshot` holds, so a spin here stops every
    /// automation in the app rather than just this one rule. Pid reuse between the enumeration of
    /// one level and the next is enough to produce one.
    #[test]
    fn a_parent_child_cycle_terminates() {
        let procs: [(u32, Option<u32>); 2] = [(1, Some(2)), (2, Some(1))];
        let chain = super::foreground_chain_from(1, procs.into_iter());
        // The equality is the whole guard: without the `contains` check the chain would run to the
        // depth cap as [1, 2, 1, 2, ...]. A `len() <= MAX_FOREGROUND_DEPTH` assertion would be
        // vacuous here — the loop condition guarantees it for every input, defect or not.
        assert_eq!(chain, vec![1, 2], "a pid already on the chain ends the walk");
    }

    /// The depth cap is real, and bounds a chain that never repeats a pid.
    #[test]
    fn a_very_deep_chain_stops_at_the_cap() {
        let procs: Vec<(u32, Option<u32>)> =
            (1..=200u32).map(|pid| (pid, if pid == 1 { None } else { Some(pid - 1) })).collect();
        assert_eq!(
            super::foreground_chain_from(1, procs.into_iter()).len(),
            super::MAX_FOREGROUND_DEPTH
        );
    }
}
