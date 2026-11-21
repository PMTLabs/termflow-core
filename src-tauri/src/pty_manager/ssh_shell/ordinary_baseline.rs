//! Frozen spawn command reference from be32c34. Only extracted from the spawn
//! functions and parameterized for the same process identity and proxy inputs.
//! Do not share production constants or startup decision code with this oracle.
use portable_pty::CommandBuilder;
use std::path::Path;

const PS_CWD_INTEGRATION: &str = "$__atOrig = $function:prompt; function prompt { if ($PWD.Provider.Name -eq 'FileSystem') { try { [Environment]::CurrentDirectory = $PWD.ProviderPath } catch {}; [Console]::Write([string][char]27 + ']9;9;' + $PWD.ProviderPath + [string][char]27 + '\\') }; if ($__atOrig) { & $__atOrig } else { 'PS ' + $PWD.Path + '> ' } }";

const FOREIGN_TERMINAL_ENV: &[&str] = &[
    "WT_SESSION",
    "WT_PROFILE_ID",
    "WARP_TERMINAL_SESSION_UUID",
    "WARP_IS_LOCAL_SHELL_SESSION",
    "WARP_HONOR_PS1",
    "KITTY_WINDOW_ID",
    "KITTY_PID",
    "ALACRITTY_LOG",
    "ALACRITTY_WINDOW_ID",
    "KONSOLE_VERSION",
    "VTE_VERSION",
    "ZED_TERM",
    "WEZTERM_PANE",
    "WEZTERM_EXECUTABLE",
    "ITERM_SESSION_ID",
    "LC_TERMINAL",
    "LC_TERMINAL_VERSION",
    "TERM_SESSION_ID",
    "TILIX_ID",
    "TERMINATOR_UUID",
];

const HOST_CONTROL_ENV: &[&str] = &[
    "TERMFLOW_PTY_TOKEN",
    "TERMFLOW_PTY_PIPE",
    "TERMFLOW_PTY_INSTANCE",
    "TERMFLOW_PTY_DISCOVERY",
];

const LOOPBACK_NO_PROXY: &[&str] = &["localhost", "127.0.0.1", "::1"];

const PROXY_VARS: &[&str] = &[
    "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy",
];

fn loopback_no_proxy_env(lookup: impl Fn(&str) -> Option<String>) -> Vec<(String, String)> {
    let proxy_configured = PROXY_VARS
        .iter()
        .any(|k| lookup(k).is_some_and(|v| !v.trim().is_empty()));
    if !proxy_configured {
        return Vec::new();
    }
    ["no_proxy", "NO_PROXY"]
        .into_iter()
        .filter_map(|key| {
            let existing: Vec<String> = lookup(key)
                .unwrap_or_default()
                .split([',', ' ', '\t'])
                .filter(|e| !e.is_empty())
                .map(str::to_string)
                .collect();
            let missing: Vec<String> = LOOPBACK_NO_PROXY
                .iter()
                .filter(|h| !existing.iter().any(|e| e == *h))
                .map(|h| h.to_string())
                .collect();
            if missing.is_empty() {
                return None;
            }
            let merged = existing.into_iter().chain(missing).collect::<Vec<_>>().join(",");
            Some((key.to_string(), merged))
        })
        .collect()
}

fn identity_env_value(leaf: Option<&str>, process_id: &str) -> String {
    leaf.unwrap_or(process_id).to_string()
}

pub(super) fn shell_emits_prompt_osc(
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

#[allow(clippy::too_many_arguments)]
pub(super) fn hosted(
    tab_id: &str,
    leaf: Option<&str>,
    shell_path: Option<&str>,
    shell_name: &str,
    shell_args: Option<&[String]>,
    cwd: Option<&str>,
    cols: u16,
    rows: u16,
    exempt_loopback_from_proxy: bool,
    lookup: impl Fn(&str) -> Option<String>,
) -> termflow_pty_protocol::SpawnSpec {
    let inject_prompt_hook = shell_emits_prompt_osc(shell_path, shell_name, shell_args);

    let shell = match shell_path {
        Some(p) => p.to_string(),
        None if cfg!(target_os = "windows") => "cmd.exe".to_string(),
        None => std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string()),
    };

    let mut env = vec![
        ("TERM".to_string(), "xterm-256color".to_string()),
        ("COLORTERM".to_string(), "truecolor".to_string()),
        ("TERMFLOW_TERMINAL_ID".to_string(), identity_env_value(leaf, tab_id)),
        ("TERM_PROGRAM".to_string(), "TermFlow".to_string()),
        (
            "TERM_PROGRAM_VERSION".to_string(),
            env!("CARGO_PKG_VERSION").to_string(),
        ),
    ];
    if exempt_loopback_from_proxy {
        let no_proxy = loopback_no_proxy_env(lookup);
        if !no_proxy.is_empty() {
            log::debug!("[SPAWN] {tab_id}: exempting loopback from the configured proxy: {no_proxy:?}");
        }
        env.extend(no_proxy);
    }
    let env_remove: Vec<String> = FOREIGN_TERMINAL_ENV
        .iter()
        .chain(HOST_CONTROL_ENV.iter())
        .map(|s| s.to_string())
        .collect();

    let mut args: Vec<String> = shell_args.map(|a| a.to_vec()).unwrap_or_default();
    if inject_prompt_hook {
        args.push("-NoExit".to_string());
        args.push("-Command".to_string());
        args.push(PS_CWD_INTEGRATION.to_string());
    }

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
        initial_cursor_row: None,
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn local(
    id: &str,
    shell_identity: &str,
    shell_path: Option<String>,
    shell_name: &str,
    shell_args: Option<Vec<String>>,
    cwd: Option<String>,
    exempt_loopback_from_proxy: bool,
    lookup: impl Fn(&str) -> Option<String>,
) -> (CommandBuilder, bool) {
    let is_powershell = shell_path
        .as_deref()
        .map(|p| {
            let p = p.to_ascii_lowercase();
            p.contains("powershell") || p.contains("pwsh")
        })
        .unwrap_or(false)
        || {
            let n = shell_name.to_ascii_lowercase();
            n.contains("powershell") || n.contains("pwsh")
        };

    let mut cmd_builder = if let Some(path) = shell_path {
        CommandBuilder::new(path)
    } else if cfg!(target_os = "windows") {
        CommandBuilder::new("cmd.exe")
    } else {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        CommandBuilder::new(shell)
    };

    cmd_builder.env("TERM", "xterm-256color");
    cmd_builder.env("COLORTERM", "truecolor");
    cmd_builder.env("TERMFLOW_TERMINAL_ID", shell_identity);

    cmd_builder.env("TERM_PROGRAM", "TermFlow");
    cmd_builder.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    for key in FOREIGN_TERMINAL_ENV.iter().chain(HOST_CONTROL_ENV.iter()) {
        cmd_builder.env_remove(key);
    }
    if exempt_loopback_from_proxy {
        let no_proxy = loopback_no_proxy_env(lookup);
        if !no_proxy.is_empty() {
            log::debug!("[SPAWN] {id}: exempting loopback from the configured proxy: {no_proxy:?}");
        }
        for (key, value) in no_proxy {
            cmd_builder.env(key, value);
        }
    }

    let mut has_command_flag = false;
    if let Some(args) = shell_args {
        has_command_flag = args.iter().any(|a| {
            let a = a.to_ascii_lowercase();
            a == "-command" || a == "-c" || a == "-encodedcommand" || a == "-file"
        });
        cmd_builder.args(args);
    }

    if is_powershell && !has_command_flag {
        cmd_builder.arg("-NoExit");
        cmd_builder.arg("-Command");
        cmd_builder.arg(PS_CWD_INTEGRATION);
    }

    if let Some(dir) = cwd {
        if !dir.is_empty() {
            let expanded_dir = if dir.starts_with("~/") || dir == "~" {
                let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_else(|_| ".".to_string());
                if dir == "~" {
                    home
                } else {
                    dir.replacen("~", &home, 1)
                }
            } else {
                dir
            };
            if std::path::Path::new(&expanded_dir).is_dir() {
                cmd_builder.cwd(expanded_dir);
            }
        }
    }

    (cmd_builder, is_powershell && !has_command_flag)
}
