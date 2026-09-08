use std::path::Path;

/// PowerShell prompt integration injected via `-Command` (see `spawn_terminal`). Both
/// jobs are gated on a FileSystem location — a registry/cert PSDrive cwd is neither a
/// spawnable directory nor a valid Win32 cwd:
///   1. Sync the Win32 process cwd to `$PWD` so native children launched from the
///      prompt inherit the interactive directory. PowerShell's `Set-Location` updates
///      `$PWD` but NOT the process cwd, so without this `wsl` (and git, …) start in the
///      stale spawn dir; with it, `wsl` lands at the `/mnt/<drive>/…` mount of the
///      current directory automatically. Best-effort via `try { … } catch {}`: the
///      .NET setter raises a TERMINATING error (`SetValueInvocationException`) when the
///      FileSystem `$PWD` isn't a valid Win32 cwd — a deleted directory, a UNC/PSDrive
///      path, or a >MAX_PATH path on Windows PowerShell 5.1. Unguarded, that throw
///      aborts the whole `prompt` function EVERY prompt, suppressing the OSC report (2)
///      AND the user's prompt (3) — so the guard is mandatory, and `-ErrorAction`
///      wouldn't catch a property-assignment throw.
///   2. Report the cwd to the backend via OSC 9;9 (parsed by `parse_osc_cwd`).
///   3. Invoke the user's captured prompt so it's preserved.
pub(crate) const PS_CWD_INTEGRATION: &str = "$__atOrig = $function:prompt; function prompt { if ($PWD.Provider.Name -eq 'FileSystem') { try { [Environment]::CurrentDirectory = $PWD.ProviderPath } catch {}; [Console]::Write([string][char]27 + ']9;9;' + $PWD.ProviderPath + [string][char]27 + '\\') }; if ($__atOrig) { & $__atOrig } else { 'PS ' + $PWD.Path + '> ' } }";

/// Foreign-terminal identity env vars scrubbed from every spawned child so a CLI
/// can't detect (and mis-adapt to) whatever terminal the APP was launched from.
/// Module-level so the in-process spawn path and `build_spawn_spec` (sidecar
/// path) share ONE list — no drift.
pub const FOREIGN_TERMINAL_ENV: &[&str] = &[
    "WT_SESSION",                 // Windows Terminal
    "WT_PROFILE_ID",
    "WARP_TERMINAL_SESSION_UUID", // Warp
    "WARP_IS_LOCAL_SHELL_SESSION",
    "WARP_HONOR_PS1",
    "KITTY_WINDOW_ID",            // kitty
    "KITTY_PID",
    "ALACRITTY_LOG",              // Alacritty
    "ALACRITTY_WINDOW_ID",
    "KONSOLE_VERSION",            // Konsole
    "VTE_VERSION",                // GNOME/VTE family
    "ZED_TERM",                   // Zed
    "WEZTERM_PANE",               // WezTerm
    "WEZTERM_EXECUTABLE",
    "ITERM_SESSION_ID",           // iTerm2
    "LC_TERMINAL",
    "LC_TERMINAL_VERSION",
    "TERM_SESSION_ID",            // Apple Terminal
    "TILIX_ID",                   // Tilix
    "TERMINATOR_UUID",            // Terminator
];

/// PTY-host CONTROL variables the GUI passes to the sidecar PROCESS (its
/// connection secret + locator). They MUST be scrubbed from every PTY child:
/// the sidecar's children inherit its environment, so without this a program in
/// any host-owned shell could read `$TERMFLOW_PTY_TOKEN` — the auth for
/// `ArmDetach`/control — and drive the host over its pipe/socket. Scrubbed on
/// BOTH spawn paths so the two never drift. NOTE: `TERMFLOW_TERMINAL_ID` is
/// deliberately NOT here — it is the per-tab identity the child is meant to see.
pub const HOST_CONTROL_ENV: &[&str] = &[
    "TERMFLOW_PTY_TOKEN",
    "TERMFLOW_PTY_PIPE",
    "TERMFLOW_PTY_INSTANCE",
    "TERMFLOW_PTY_DISCOVERY",
];

/// Build a fully-resolved [`SpawnSpec`] for the PTY-host sidecar. Produces the
/// exact env/args/cwd the in-process path uses (shared consts), including the
/// `TERMFLOW_TERMINAL_ID` identity var and the PowerShell OSC 9;9 cwd
/// integration. The GUI owns this profile logic; the sidecar only executes it.
/// Whether this shell receives the injected OSC 9;9 prompt-render hook (see
/// `PS_CWD_INTEGRATION` / `build_spawn_spec`) — i.e. interactive PowerShell with
/// no `-Command`/`-File` invocation. This is the single source of truth for the
/// injection decision AND for the `Terminal.prompt_hook` flag the renderer reads
/// on reattach.
///
/// Why the flag matters: command-suggest's Windows suppression is the "prompt
/// gate" — while a hooked shell has rendered no prompt since the last submit
/// (an agent CLI like agy/codex owns the pty), typed input is never captured.
/// That gate lives only in the renderer's in-memory cache, so a full renderer
/// reload that reattaches to a still-alive PTY host session (PTY-host hot-swap /
/// app auto-update) forgets it and the history popup leaks keystrokes into the
/// CLI. Reporting this flag lets the renderer re-seed the gate as
/// `{seen:true, armed:false}` on reattach. A hookless shell (cmd, remote ssh)
/// reports false and keeps the ungated heuristic — seeding it would gate it
/// forever (no OSC ever re-arms it).
/// The value of `TERMFLOW_TERMINAL_ID` — the identity an in-terminal agent reads
/// to address **itself** over MCP (`get_my_terminal`, the `"me"` shorthand).
///
/// The **leaf**, because it is the durable id (design 014 §A3) and survives a
/// restart, unlike the per-run `pc-`. A headless spawn has no leaf and falls
/// back to the process id — such a terminal has no pane for an agent to sit in.
///
/// Before design 014 the two spawn paths disagreed: the sidecar path injected
/// the leaf and the in-process path injected the `pc-`, the drift
/// `canvas_store.rs` routes around via `resolve_renderer_id`. Worse, a
/// renderer-created leaf WAS the tab id, so this variable — named `TERMINAL_ID` —
/// handed agents a `tb-`, and an agent in a two-pane tab could not say which of
/// the two terminals it was.
pub(crate) fn identity_env_value(leaf: Option<&str>, process_id: &str) -> String {
    leaf.unwrap_or(process_id).to_string()
}

pub fn shell_emits_prompt_osc(
    shell_path: Option<&str>,
    shell_name: &str,
    shell_args: Option<&[String]>,
) -> bool {
    let is_powershell = shell_path
        .map(|p| {
            let p = p.to_ascii_lowercase();
            p.contains("powershell") || p.contains("pwsh")
        })
        .unwrap_or(false)
        || {
            let n = shell_name.to_ascii_lowercase();
            n.contains("powershell") || n.contains("pwsh")
        };
    let has_command_flag = shell_args
        .map(|args| {
            args.iter().any(|a| {
                let a = a.to_ascii_lowercase();
                a == "-command" || a == "-c" || a == "-encodedcommand" || a == "-file"
            })
        })
        .unwrap_or(false);
    is_powershell && !has_command_flag
}

/// Build the host spawn spec.
///
/// `tab_id` is the pty-host SESSION key; `leaf` is the renderer leaf. They are
/// equal for anything created on this build and differ for a migrated terminal,
/// which is why `TERMFLOW_TERMINAL_ID` takes the leaf specifically
/// (design 014 §A6.1).
pub fn build_spawn_spec(
    tab_id: &str,
    leaf: Option<&str>,
    shell_path: Option<&str>,
    shell_name: &str,
    shell_args: Option<&[String]>,
    cwd: Option<&str>,
    cols: u16,
    rows: u16,
) -> termflow_pty_protocol::SpawnSpec {
    let inject_prompt_hook = shell_emits_prompt_osc(shell_path, shell_name, shell_args);

    let shell = match shell_path {
        Some(p) => p.to_string(),
        None if cfg!(target_os = "windows") => "cmd.exe".to_string(),
        None => std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string()),
    };

    let env = vec![
        ("TERM".to_string(), "xterm-256color".to_string()),
        ("COLORTERM".to_string(), "truecolor".to_string()),
        ("TERMFLOW_TERMINAL_ID".to_string(), identity_env_value(leaf, tab_id)),
        ("TERM_PROGRAM".to_string(), "TermFlow".to_string()),
        (
            "TERM_PROGRAM_VERSION".to_string(),
            env!("CARGO_PKG_VERSION").to_string(),
        ),
    ];
    let env_remove: Vec<String> = FOREIGN_TERMINAL_ENV
        .iter()
        .chain(HOST_CONTROL_ENV.iter())
        .map(|s| s.to_string())
        .collect();

    let mut args: Vec<String> = shell_args.map(|a| a.to_vec()).unwrap_or_default();
    // Interactive PowerShell gets the cwd-sync + OSC 9;9 prompt integration.
    if inject_prompt_hook {
        args.push("-NoExit".to_string());
        args.push("-Command".to_string());
        args.push(PS_CWD_INTEGRATION.to_string());
    }

    // Honor a cwd only if it actually exists (mirrors the in-process path).
    let resolved_cwd = cwd.and_then(|dir| {
        if dir.is_empty() {
            return None;
        }
        let expanded = if dir.starts_with("~/") || dir == "~" {
            let home = std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .unwrap_or_else(|_| ".".to_string());
            if dir == "~" {
                home
            } else {
                dir.replacen('~', &home, 1)
            }
        } else {
            dir.to_string()
        };
        if Path::new(&expanded).is_dir() {
            Some(expanded)
        } else {
            None
        }
    });

    termflow_pty_protocol::SpawnSpec {
        shell,
        args,
        env,
        env_remove,
        cwd: resolved_cwd,
        cols,
        rows,
    }
}

#[cfg(test)]
mod prompt_integration_tests {
    use super::PS_CWD_INTEGRATION;

    #[test]
    fn ps_prompt_syncs_win32_cwd_and_reports_osc() {
        // Locks in the two prompt-integration jobs: the Win32 cwd sync (so `wsl`
        // auto-cd's to the mount) and the OSC 9;9 cwd report — both from $PWD's
        // FileSystem provider path, guarded on the FileSystem provider.
        // The sync MUST be wrapped in try/catch: the .NET setter throws a terminating
        // error on a deleted/UNC/>MAX_PATH FileSystem cwd, which unguarded would abort
        // the whole prompt (killing the OSC report + user prompt) on every prompt.
        assert!(
            PS_CWD_INTEGRATION
                .contains("try { [Environment]::CurrentDirectory = $PWD.ProviderPath } catch {}"),
            "prompt must sync the Win32 cwd (so native children like wsl inherit it) inside a try/catch"
        );
        assert!(
            PS_CWD_INTEGRATION.contains("]9;9;"),
            "prompt must still emit the OSC 9;9 cwd report"
        );
        assert!(PS_CWD_INTEGRATION.contains("$PWD.Provider.Name -eq 'FileSystem'"));
    }

    #[test]
    fn build_spawn_spec_injects_identity_scrubs_foreign_and_wraps_ps() {
        let spec = super::build_spawn_spec(
            "pc-abc123",
            None,
            Some("powershell.exe"),
            "powershell",
            None,
            None,
            120,
            30,
        );
        // Identity env
        assert!(spec
            .env
            .iter()
            // AMENDED by design 014 §A6.1: the value is the LEAF when there is
            // one. This call passes `None` (a headless spawn with no renderer
            // pane), so it still falls back to the process id — which is what
            // this assertion now pins.
            .any(|(k, v)| k == "TERMFLOW_TERMINAL_ID" && v == "pc-abc123"));
        assert!(spec
            .env
            .iter()
            .any(|(k, v)| k == "TERM_PROGRAM" && v == "TermFlow"));
        // Foreign-terminal scrub shares the module const
        assert!(spec.env_remove.iter().any(|k| k == "WT_SESSION"));
        // Host-control secrets are scrubbed too (never leak the arm token into a shell)
        assert!(spec.env_remove.iter().any(|k| k == "TERMFLOW_PTY_TOKEN"));
        assert_eq!(
            spec.env_remove.len(),
            super::FOREIGN_TERMINAL_ENV.len() + super::HOST_CONTROL_ENV.len()
        );
        // Interactive PowerShell gets the OSC 9;9 cwd integration
        assert!(spec.args.iter().any(|a| a == "-NoExit"));
        assert!(spec.args.iter().any(|a| a.contains("]9;9;")));
        assert_eq!((spec.cols, spec.rows), (120, 30));
    }

    #[test]
    fn build_spawn_spec_skips_ps_wrap_when_command_flag_present() {
        // A profile that already drives -Command must NOT get the -NoExit wrap.
        let args = vec!["-Command".to_string(), "echo hi".to_string()];
        let spec = super::build_spawn_spec(
            "pc-x",
            None,
            Some("pwsh.exe"),
            "pwsh",
            Some(&args),
            None,
            80,
            24,
        );
        assert!(!spec.args.iter().any(|a| a == "-NoExit"));
    }

    #[test]
    fn shell_emits_prompt_osc_only_for_interactive_powershell() {
        use super::shell_emits_prompt_osc;
        // Interactive PowerShell (by path or by profile name) is hooked.
        assert!(shell_emits_prompt_osc(Some("C:\\...\\powershell.exe"), "windows-powershell", None));
        assert!(shell_emits_prompt_osc(Some("pwsh"), "pwsh", None));
        assert!(shell_emits_prompt_osc(None, "PowerShell", None));
        // A -Command/-File invocation renders no interactive prompt -> not hooked.
        let cmd = vec!["-Command".to_string(), "echo hi".to_string()];
        assert!(!shell_emits_prompt_osc(Some("pwsh.exe"), "pwsh", Some(&cmd)));
        let file = vec!["-File".to_string(), "script.ps1".to_string()];
        assert!(!shell_emits_prompt_osc(Some("powershell.exe"), "powershell", Some(&file)));
        // Non-PowerShell shells are never hooked (no OSC ever re-arms the gate).
        assert!(!shell_emits_prompt_osc(Some("C:\\Windows\\System32\\cmd.exe"), "cmd", None));
        assert!(!shell_emits_prompt_osc(Some("/bin/bash"), "bash", None));
        // Decision must match build_spawn_spec's actual injection.
        let spec = super::build_spawn_spec("t", None, Some("powershell.exe"), "powershell", None, None, 80, 24);
        assert_eq!(
            spec.args.iter().any(|a| a.contains("]9;9;")),
            shell_emits_prompt_osc(Some("powershell.exe"), "powershell", None),
        );
    }
}

/// `TERMFLOW_TERMINAL_ID` — the identity an in-terminal agent reads to address
/// ITSELF over MCP. Design 014 §A6.1.
#[cfg(test)]
mod identity_env_tests {
    use super::{build_spawn_spec, identity_env_value};

    fn spec_identity(leaf: Option<&str>, session_key: &str) -> String {
        let spec = build_spawn_spec(session_key, leaf, Some("pwsh.exe"), "pwsh", None, None, 80, 24);
        spec.env
            .iter()
            .find(|(k, _)| k == "TERMFLOW_TERMINAL_ID")
            .map(|(_, v)| v.clone())
            .expect("every spawn must carry an identity")
    }

    #[test]
    fn the_identity_var_carries_the_leaf_not_the_process_id() {
        assert_eq!(identity_env_value(Some("tm-9f2c1a4b7"), "pc-abc123def"), "tm-9f2c1a4b7");
    }

    /// A headless API/fleet spawn has no renderer pane, so no leaf. Falling back
    /// to the process id is correct — there is no agent sitting in a pane there.
    #[test]
    fn a_headless_spawn_falls_back_to_the_process_id() {
        assert_eq!(identity_env_value(None, "pc-abc123def"), "pc-abc123def");
    }

    /// THE reported bug, pinned. A tab id in a variable named `TERMINAL_ID` is
    /// what leaves an agent in a two-pane tab unable to say which terminal it is.
    #[test]
    fn the_identity_var_is_never_a_tab_id() {
        let v = identity_env_value(Some("tm-9f2c1a4b7"), "pc-abc123def");
        assert!(!v.starts_with("tb-"), "TERMFLOW_TERMINAL_ID must never carry a tab id, got {v}");
    }

    /// A MIGRATED terminal: the host session key is still the old `tb-`, but the
    /// agent must see the new `tm-` leaf. Passing the session key here would put
    /// a tab-shaped id back into the variable.
    #[test]
    fn a_migrated_terminal_reports_its_new_leaf_not_its_legacy_session_key() {
        assert_eq!(spec_identity(Some("tm-new00001"), "tb-old00001"), "tm-new00001");
    }

    /// **The drift `canvas_store.rs:5-8` documents.** Asserting the two paths
    /// AGREE, rather than asserting each one's value separately — separate
    /// assertions are exactly what let them diverge in the first place.
    #[test]
    fn both_spawn_paths_inject_the_same_value_for_the_same_terminal() {
        let leaf = Some("tm-9f2c1a4b7");
        let process_id = "pc-abc123def";
        // The in-process path calls `identity_env_value` directly; the host path
        // routes through `build_spawn_spec`. Same inputs must give same output.
        assert_eq!(spec_identity(leaf, process_id), identity_env_value(leaf, process_id));
    }
}
