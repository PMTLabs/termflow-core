//! Windows-family prompt wrappers; no launcher or create-path integration.

use super::*;
use crate::pty_manager::spawn_spec::PS_CWD_INTEGRATION;

const CMD_BOOTSTRAP: &str = "__TERMFLOW_SSH_CMD_BOOTSTRAP";

pub(super) fn instrument(
    ordinary: &SpawnSpec, nonce: &str, root: &HelperRoot, owner: &ProcessIdentity,
) -> Option<io::Result<PosixAdapter>> {
    let base = ordinary.shell.rsplit(['/', '\\']).next()?.to_ascii_lowercase();
    let ps = match base.as_str() {
        "pwsh" | "pwsh.exe" | "powershell" | "powershell.exe" => true,
        "cmd" | "cmd.exe" if cfg!(windows) => false,
        _ => return None,
    };
    Some(prepare(ordinary, nonce, root, owner, ps))
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
        let (ext, script) = if ps { ("ps1", ps_script(nonce)) }
            else { ("cmd", CMD_SCRIPT.replace("@NONCE@", nonce)) };
        let helper = root.publish(owner.clone(), HelperKind::ShellHook, ext, script.as_bytes())?;
        let usage = helper.acquire()?;
        let path = usage.path();
        output.hooks.push((helper, usage));
        let path = literal_path(&path)?;
        if ps {
            if !args.iter().any(|a| a.eq_ignore_ascii_case("-NoExit")) {
                args.push("-NoExit".into());
            }
            args.extend(["-Command".into(), format!(". '{}'", path.replace('\'', "''"))]);
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

fn literal_path(path: &Path) -> io::Result<&str> {
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
    Ok(supplied.to_vec())
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

fn ps_script(nonce: &str) -> String {
    // Dot-source after normal profile startup, reusing the ordinary captured
    // prompt and cwd logic. Increment only after the captured prompt returns.
    let wrapper = PS_CWD_INTEGRATION.strip_suffix(" }").expect("PowerShell prompt wrapper");
    format!("$script:__termflowSshReadySequence = 0\n{wrapper}; $script:__termflowSshReadySequence++; [Console]::Write([string][char]27 + ']633;TermFlowSshReady;{nonce};' + $script:__termflowSshReadySequence + [string][char]27 + '\u{5c}') }}\n")
}

// Detect the existing delayed expansion state and keep it. In the off case,
// expand under setlocal, then return a FOR variable (expanded after metachar
// parsing) across endlocal. The assignment prefix protects leading EOL chars.
const CMD_SCRIPT: &str = "@set \"__TERMFLOW_SSH_CMD_BOOTSTRAP=\"\r\n\
@if not defined PROMPT set \"PROMPT=$P$G\"\r\n\
@if \"!\"==\"\" goto :delayed\r\n\
@setlocal EnableDelayedExpansion\r\n\
@for /f \"delims=\" %%P in (\"PROMPT=!PROMPT!$E]633;TermFlowSshReady;@NONCE@;$T$E\\\") do (\r\n\
    endlocal\r\n\
    set \"%%P\"\r\n\
)\r\n\
@goto :eof\r\n\
:delayed\r\n\
@set \"PROMPT=!PROMPT!$E]633;TermFlowSshReady;@NONCE@;$T$E\\\"\r\n";
