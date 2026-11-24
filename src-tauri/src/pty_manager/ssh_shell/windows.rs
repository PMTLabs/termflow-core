//! Windows-family prompt-readiness wrappers and shared literal path validation.

use super::*;
use crate::pty_manager::spawn_spec::PS_CWD_INTEGRATION;

const CMD_BOOTSTRAP: &str = "__TERMFLOW_SSH_CMD_BOOTSTRAP";

pub(super) fn instrument(
    ordinary: &SpawnSpec, nonce: &str, root: &HelperRoot, owner: &ProcessIdentity,
) -> Option<io::Result<PosixAdapter>> {
    Some(prepare(ordinary, nonce, root, owner, dialect(&ordinary.shell)?))
}

pub(crate) fn dialect(executable: &str) -> Option<bool> {
    let base = executable.rsplit(['/', '\\']).next()?.to_ascii_lowercase();
    Some(match base.as_str() {
        "pwsh" | "pwsh.exe" | "powershell" | "powershell.exe" => true,
        "cmd" | "cmd.exe" if cfg!(windows) => false,
        _ => return None,
    })
}

pub(super) fn validate_profile(executable: &str, args: &[String], ps: bool) -> io::Result<()> {
    if !Path::new(executable).is_absolute() {
        return Err(adapter_error("SSH readiness requires an absolute shell executable path"));
    }
    if ps { validate_ps_flags(args) } else { cmd_flags(args).map(|_| ()) }
}

fn prepare(
    ordinary: &SpawnSpec, nonce: &str, root: &HelperRoot, owner: &ProcessIdentity, ps: bool,
) -> io::Result<PosixAdapter> {
    let mut args = if ps { ps_flags(&ordinary.args)? } else { cmd_flags(&ordinary.args)? };
    if !Path::new(&ordinary.shell).is_absolute() {
        return Err(adapter_error("SSH readiness requires an absolute shell executable path"));
    }

    literal_path(root.path())?;
    if !ps && ordinary.env_remove.iter().any(|key| key.eq_ignore_ascii_case(CMD_BOOTSTRAP)) {
        return Err(adapter_error("SSH readiness cmd bootstrap environment conflicts with the selected profile"));
    }
    let mut output = PosixAdapter { spec: ordinary.clone(), hooks: Vec::new() };
    let result = (|| {
        let (ext, payload) = if ps { ("txt", nonce.to_owned()) }
            else { ("cmd", CMD_SCRIPT.replace("@NONCE@", nonce).replace("@CMD_SAVE@", CMD_SAVE)) };
        let helper = root.publish(owner.clone(), HelperKind::ShellHook, ext, payload.as_bytes())?;
        let usage = helper.acquire()?;
        let path = usage.path();
        output.hooks.push((helper, usage));
        let path = literal_path(&path)?;
        if ps {
            if !args.iter().any(|a| a.eq_ignore_ascii_case("-NoExit")) {
                args.push("-NoExit".into());
            }
            args.extend(["-Command".into(), powershell_hook_command(path)?]);
        } else {
            // Expand a single cmd token after startup/AutoRun. Keeping the quotes
            // in the env value avoids relying on CRT argv quoting for cmd syntax.
            output.spec.env.retain(|(key, _)| !key.eq_ignore_ascii_case(CMD_BOOTSTRAP));
            output.spec.env.push((CMD_BOOTSTRAP.into(), format!("\"{path}\"")));
            args.extend(["/K".into(), format!("%{CMD_BOOTSTRAP}%")]);
        }
        output.spec.args = args;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = output.finish_after_shell_quiescence();
        return Err(error);
    }
    Ok(output)
}

pub(super) fn literal_path(path: &Path) -> io::Result<&str> {
    let err = || adapter_error("unsafe SSH readiness helper path");
    let path = path.to_str().ok_or_else(err)?;
    let path = if cfg!(windows) {
        let path = path.strip_prefix(r"\\?\").unwrap_or(path);
        let b = path.as_bytes();
        if b.len() < 3 || !b[0].is_ascii_alphabetic() || b[1] != b':' || b[2] != b'\\' {
            return Err(err());
        }
        path
    } else { path };
    if path.chars().any(|c| c.is_control() || matches!(c, '"' | '%' | '!' | '^' | '&' | '|' | '<' | '>')) {
        return Err(err());
    }
    Ok(path)
}

fn ps_flags(ordinary: &[String]) -> io::Result<Vec<String>> {
    // Remove only the exact tail supplied by the ordinary hosted/local builder.
    let supplied = ordinary.strip_suffix(&[
        "-NoExit".into(), "-Command".into(), PS_CWD_INTEGRATION.into(),
    ]).unwrap_or(ordinary);
    validate_ps_flags(supplied)?;
    Ok(supplied.to_vec())
}

fn validate_ps_flags(supplied: &[String]) -> io::Result<()> {
    let mut iter = supplied.iter();
    while let Some(flag) = iter.next() {
        let lower = flag.to_ascii_lowercase();
        let key = lower.trim_start_matches(['-', '/']);
        let key = key.split([':', '=']).next().unwrap_or_default();
        match key {
            "c" | "command" | "commandwithargs" | "cwa" | "e" | "ec" | "enc" |
            "encodedcommand" | "f" | "file" => {
                return Err(adapter_error("SSH readiness cannot compose with PowerShell -Command, -EncodedCommand or -File"));
            }
            "nologo" | "noprofile" | "noexit" if lower == format!("-{key}") => {}
            "executionpolicy" | "ep" | "workingdirectory" if lower == format!("-{key}") => {
                iter.next().filter(|v| !v.is_empty() && !v.starts_with('-'))
                    .ok_or_else(|| adapter_error("missing PowerShell profile flag value"))?;
            }
            _ => return Err(adapter_error("SSH readiness cannot compose with these PowerShell startup flags")),
        }
    }
    Ok(())
}

fn cmd_flags(ordinary: &[String]) -> io::Result<Vec<String>> {
    for flag in ordinary {
        if !matches!(flag.to_ascii_lowercase().as_str(),
            "/d" | "/q" | "/s" | "/a" | "/u" | "/e:on" | "/v:on" | "/v:off" | "/f:on" | "/f:off")
        {
            return Err(adapter_error("SSH readiness cannot compose with these cmd startup flags"));
        }
    }
    Ok(ordinary.to_vec())
}

const PS_HOOK_PREFIX: &str = "$script:__termflowSshReadyNonce = [System.IO.File]::ReadAllText('";
const PS_HOOK_SUFFIX: &str = "; $script:__termflowSshReadySequence++; $__tfRows = 1; try { $__tfWin = $Host.UI.RawUI.WindowSize; $__tfRows = [Math]::Max(1, [Math]::Min($__tfWin.Height - 1, [Math]::Ceiling(1200 / [Math]::Max(20, $__tfWin.Width)) + 1)) } catch {}; [Console]::Write(([string][char]27 + 'D') * $__tfRows + [string][char]27 + '[' + $__tfRows + 'A' + [string][char]27 + '7' + [string][char]27 + ']633;TermFlowSshReady;' + $script:__termflowSshReadyNonce + ';' + $script:__termflowSshReadySequence + [string][char]27 + '\\') }";

fn powershell_hook_tail(root: &str) -> String {
    let wrapper = PS_CWD_INTEGRATION
        .strip_suffix(" }")
        .expect("PowerShell prompt wrapper");
    let launcher = super::launch::ps_launch_body(&format!(
        "[IO.File]::ReadAllText([IO.Path]::Combine('{}', $id, 'helper.json'))",
        root.replace('\'', "''")
    ));
    format!("'); Microsoft.PowerShell.Utility\\Set-Variable -Name __termflowSshLaunch -Scope Script -Option Constant -ErrorAction Stop -Value {{ param([string]$id) if ($args.Count -ne 0 -or $id -cnotmatch '\\A[0-9a-f]{{8}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{12}}\\z') {{ throw 'Invalid SSH launch id' }}; $ErrorActionPreference = 'Stop'; {launcher} }}; $script:__termflowSshReadySequence = 0; {wrapper}{PS_HOOK_SUFFIX}")
}

pub(crate) fn powershell_hook_command(path: &str) -> io::Result<String> {
    // PowerShell also parses typographic single quotes as delimiters.
    if path.contains(['\u{2018}', '\u{2019}', '\u{201a}', '\u{201b}']) {
        return Err(adapter_error("unsafe SSH readiness PowerShell helper path"));
    }
    // Inline fixed code runs under Restricted/AllSigned. The helper is data only,
    // so the nonce stays out of the command line and the environment.
    let root = Path::new(path)
        .parent()
        .and_then(Path::parent)
        .and_then(Path::to_str)
        .ok_or_else(|| adapter_error("missing SSH readiness helper root"))?;
    Ok(format!(
        "{PS_HOOK_PREFIX}{}{tail}",
        path.replace('\'', "''"),
        tail = powershell_hook_tail(root)
    ))
}

pub(crate) fn is_powershell_hook_command(arg: &str) -> bool {
    let Some(encoded) = arg.strip_prefix(PS_HOOK_PREFIX) else {
        return false;
    };
    let Some((encoded, _)) = encoded.split_once("'); Microsoft.PowerShell.Utility") else {
        return false;
    };
    let path = encoded.replace("''", "'");
    let path_ref = Path::new(&path);
    path_ref.is_absolute()
        && path_ref.file_name().is_some_and(|name| name == "helper.txt")
        && literal_path(path_ref).is_ok_and(|literal| literal == path.as_str())
        && powershell_hook_command(&path).is_ok_and(|generated| generated == arg)
}

/// Only the exact current hook qualifies a running PowerShell for the short launch.
pub(crate) fn has_powershell_launcher(argv: &[String]) -> bool {
    argv.windows(2)
        .any(|pair| pair[0] == "-Command" && is_powershell_hook_command(&pair[1]))
}

// Quiet launch (see posix ECHO_MAX): reserve six IND rows, then save the cursor where the
// prompt starts; the launch batch restores it. PROMPT cannot compute a width-based reserve,
// so a prompt plus typed batch path taller than six rows can scroll the save away.
// Known limit (backlog 045): in a restored pane whose new shell starts on the bottom row,
// the typed path can stay on screen, about six rows above where the restore lands. Cause not
// yet established; pwsh in the same case is clean.
const CMD_SAVE: &str = "$ED$ED$ED$ED$ED$ED$E[6A$E7";

// Detect the existing delayed expansion state and keep it. In the off case,
// expand under setlocal, then return a FOR variable (expanded after metachar
// parsing) across endlocal. The assignment prefix protects leading EOL chars.
// `do @(`: with echo on, cmd echoes each FOR iteration's body even under `@for`; without
// the `@` the pane would show this block, nonce included, above the first prompt.
const CMD_SCRIPT: &str = "@set \"__TERMFLOW_SSH_CMD_BOOTSTRAP=\"\r\n\
@if not defined PROMPT set \"PROMPT=$P$G\"\r\n\
@if \"!\"==\"\" goto :delayed\r\n\
@setlocal EnableDelayedExpansion\r\n\
@for /f \"delims=\" %%P in (\"PROMPT=@CMD_SAVE@!PROMPT!$E]633;TermFlowSshReady;@NONCE@;$T$E\\\") do @(\r\n\
    endlocal\r\n\
    set \"%%P\"\r\n\
)\r\n\
@goto :eof\r\n\
:delayed\r\n\
@set \"PROMPT=@CMD_SAVE@!PROMPT!$E]633;TermFlowSshReady;@NONCE@;$T$E\\\"\r\n";
