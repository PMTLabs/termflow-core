//! Encode one foreground launch for an already instrumented shell. ProxyCommand
//! has a different interpreter (OpenSSH's login shell); do not use this encoder there.

use super::{adapter_error, classify, fish_quote, sh_quote, windows, Dialect, Paths};
use crate::pty_manager::ssh_helpers::{Helper, HelperKind, HelperRoot, HelperUse, ProcessIdentity};
use std::{io, path::Path};

pub(crate) struct EncodedLaunch {
    bytes: Vec<u8>,
    argv: Vec<String>,
    payload: Option<(Helper, HelperUse)>,
    intermediary: Option<Vec<String>>,
}

impl EncodedLaunch {
    /// Submit these bytes as one admitted write. Includes Enter, not a second command.
    pub(crate) fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// Show the actual argv, not the private launcher's invocation.
    pub(crate) fn argv(&self) -> &[String] {
        &self.argv
    }

    pub(crate) fn intermediary(&self) -> Option<&[String]> {
        self.intermediary.as_deref()
    }

    /// Cancel/reconnect can retire the payload, but must keep its execution pin.
    pub(crate) fn retire_payload(&self) -> io::Result<()> {
        if let Some((helper, _)) = &self.payload {
            helper.cancel_attempt()?;
        }
        Ok(())
    }

    /// Only after positive evidence that the shell never received the command
    /// or the launcher and child have finished. Queue acceptance is not evidence.
    /// Dropping without this call conservatively leaves the in-flight pin.
    pub(crate) fn finish_after_quiescence(self) -> io::Result<()> {
        self.retire_payload()?;
        if let Some((_, usage)) = self.payload {
            usage.finish()?;
        }
        Ok(())
    }

    fn publish(
        &mut self,
        root: &HelperRoot,
        owner: ProcessIdentity,
        ext: &str,
        data: &[u8],
    ) -> io::Result<()> {
        let helper = root.publish(owner, HelperKind::AttemptPayload, ext, data)?;
        match helper.acquire() {
            Ok(usage) => self.payload = Some((helper, usage)),
            Err(error) => {
                let _ = helper.cancel_attempt();
                return Err(error);
            }
        }
        Ok(())
    }
}

/// `shell` is the executable of the registered adapter, not the selected
/// connection's login shell. `argv[0]` is the trusted, fixed executable path
/// in that runtime's spelling (e.g. `/c/...` for Git Bash). No argv value is
/// path-converted here. Terminal control characters cannot be typed literally.
pub(crate) fn encode_launch(
    shell: &str,
    argv: Vec<String>,
    root: &HelperRoot,
    owner: ProcessIdentity,
) -> io::Result<EncodedLaunch> {
    encode(shell, argv, root, owner, false)
}

/// Native POSIX OpenSSH selects ProxyCommand's interpreter using SHELL.
/// Qualify a fixed Bourne interpreter for just this child, not the user's
/// interactive shell/environment (whose rc can replace SHELL).
#[cfg(unix)]
pub(crate) fn encode_launch_with_posix_proxy(
    shell: &str,
    argv: Vec<String>,
    root: &HelperRoot,
    owner: ProcessIdentity,
) -> io::Result<EncodedLaunch> {
    if !Path::new("/usr/bin/env").is_file() || !Path::new("/bin/sh").is_file() {
        return Err(adapter_error("fixed POSIX proxy interpreter unavailable"));
    }
    encode(shell, argv, root, owner, true)
}

fn encode(
    shell: &str,
    argv: Vec<String>,
    root: &HelperRoot,
    owner: ProcessIdentity,
    posix_proxy: bool,
) -> io::Result<EncodedLaunch> {
    let exe = argv.first().ok_or_else(|| adapter_error("missing SSH executable"))?;
    if argv.iter().any(|arg| arg.chars().any(char::is_control)) {
        return Err(adapter_error("SSH argv contains a terminal control character"));
    }
    let dialect = windows::dialect(shell);
    let posix = if dialect.is_none() { Some(classify(shell)?) } else { None };
    let absolute = if matches!(posix, Some((_, Paths::Msys | Paths::Cygwin))) {
        exe.starts_with('/') && !exe.starts_with("//")
    } else {
        Path::new(exe).is_absolute()
    };
    if !absolute {
        return Err(adapter_error("SSH executable path must be absolute"));
    }
    let mut launch = EncodedLaunch { bytes: Vec::new(), argv, payload: None, intermediary: None };
    let result = (|| -> io::Result<String> {
        match (dialect, posix) {
            (Some(true), _) => {
                let data = ps_payload(&launch.argv)?;
                launch.publish(root, owner, "json", &data)?;
                let path = launch.payload.as_ref().unwrap().1.path();
                let path = windows::literal_path(&path)?;
                let source = format!("[IO.File]::ReadAllText({})", ps_quote(path)?);
                Ok(ps_launch(&source, false))
            }
            (Some(false), _) => {
                windows::literal_path(root.path())?;
                let (batch, intermediary) = cmd_batch(&launch.argv)?;
                launch.intermediary = intermediary;
                launch.publish(root, owner, "cmd", batch.as_bytes())?;
                let path = launch.payload.as_ref().unwrap().1.path();
                let path = windows::literal_path(&path)?;
                Ok(format!("\"{path}\""))
            }
            (None, Some((dialect, paths))) => {
                let quote = if dialect == Dialect::Fish { fish_quote } else { sh_quote };
                let literal = launch.argv.iter().map(|arg| quote(arg)).collect::<Vec<_>>().join(" ");
                // MSYS rewrites path-like args when spawning a native Windows exe.
                // Disable that only in the launched process's environment.
                let prefix = if matches!(paths, Paths::Msys) {
                    "MSYS2_ARG_CONV_EXCL='*' MSYS_NO_PATHCONV=1 "
                } else {
                    ""
                };
                let proxy = if posix_proxy { "/usr/bin/env SHELL=/bin/sh " } else { "" };
                Ok(format!("{prefix}command {proxy}{literal}"))
            }
            _ => unreachable!("classified shell"),
        }
    })();
    match result {
        Ok(command) => {
            launch.bytes = command.into_bytes();
            launch.bytes.push(b'\r');
            Ok(launch)
        }
        Err(error) => {
            let _ = launch.finish_after_quiescence(); // no bytes left this function
            Err(error)
        }
    }
}

fn ps_quote(path: &str) -> io::Result<String> {
    if path.contains(['\u{2018}', '\u{2019}', '\u{201a}', '\u{201b}']) {
        return Err(adapter_error("unsafe SSH PowerShell payload path"));
    }
    Ok(format!("'{}'", path.replace('\'', "''")))
}

// Inline fixed code works under Restricted. The literal path is used only to
// read JSON data, not to execute a .ps1 or evaluate its contents.
fn ps_launch(json_source: &str, echo: bool) -> String {
    let preview = if echo { "[Console]::WriteLine($data.preview); " } else { "" };
    format!("& {{ $data = ({json_source}) | ConvertFrom-Json; {preview}\
        $si = [System.Diagnostics.ProcessStartInfo]::new(); \
        $si.FileName = $data.exe; $si.UseShellExecute = $false; \
        $si.WorkingDirectory = $ExecutionContext.SessionState.Path.CurrentFileSystemLocation.ProviderPath; \
        if ($null -ne $si.PSObject.Properties['ArgumentList']) {{ \
            foreach ($arg in $data.argv) {{ $si.ArgumentList.Add([string]$arg) }} \
        }} else {{ $si.Arguments = $data.crt }}; \
        $child = [System.Diagnostics.Process]::Start($si); \
        try {{ $child.WaitForExit(); $global:LASTEXITCODE = $child.ExitCode }} \
        finally {{ $child.Dispose() }} }}")
}

fn ps_payload(argv: &[String]) -> io::Result<Vec<u8>> {
    let crt = crt_args(&argv[1..]);
    let preview = format!("{} {crt}", crt_arg(&argv[0]));
    if cfg!(windows) && preview.encode_utf16().count() >= 32767 {
        return Err(adapter_error("SSH argv exceeds the Windows native command line limit"));
    }
    serde_json::to_vec(&serde_json::json!({
        "exe": &argv[0], "argv": &argv[1..], "crt": crt, "preview": preview,
    })).map_err(io::Error::other)
}

fn crt_args(args: &[String]) -> String {
    args.iter().map(|arg| crt_arg(arg)).collect::<Vec<_>>().join(" ")
}

// Always quote, including empty arguments. A literal quote needs 2n+1
// backslashes and the closing delimiter needs 2n for a run of n backslashes.
pub(crate) fn crt_arg(arg: &str) -> String {
    let mut output = String::from("\"");
    let mut slashes = 0;
    for ch in arg.chars() {
        if ch == '\\' {
            slashes += 1;
            continue;
        }
        output.extend(std::iter::repeat_n('\\', if ch == '"' { 2 * slashes + 1 } else { slashes }));
        slashes = 0;
        output.push(ch);
    }
    output.extend(std::iter::repeat_n('\\', 2 * slashes));
    output.push('"');
    output
}

fn cmd_batch(argv: &[String]) -> io::Result<(String, Option<Vec<String>>)> {
    #[cfg(windows)]
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    // cmd reads batch text in the active console code page, not necessarily
    // UTF-8. Keep the batch ASCII. For Unicode, use the fixed system PS5.1
    // interpreter with inline fixed code and base64 JSON data. No chcp, policy
    // changes, script-file execution, or lossy OEM conversion.
    let (body, intermediary) = if argv.iter().any(|arg| !arg.is_ascii()) {
        #[cfg(windows)]
        {
            let ps = super::super::system_shell("powershell.exe")?;
            if !ps.is_ascii() {
                return Err(adapter_error("SSH cmd Unicode launcher requires an ASCII system interpreter path"));
            }
            let data = STANDARD.encode(ps_payload(argv)?);
            let source = format!("[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{data}'))");
            let command = ps_launch(&source, true).encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<_>>();
            let arg = STANDARD.encode(command);
            let body = format!("@{} -NoLogo -NoProfile -EncodedCommand {arg}", cmd_exe(&ps)?);
            (body, Some(vec![ps, "-NoLogo".into(), "-NoProfile".into(), "-EncodedCommand".into(), arg]))
        }
        #[cfg(not(windows))]
        {
            return Err(adapter_error("SSH cmd Unicode launcher requires Windows"));
        }
    } else {
        let exe = cmd_exe(&argv[0])?;
        let crt = crt_args(&argv[1..]);
        let args = cmd_escape(&crt);
        let display = cmd_escape(&format!("{} {crt}", crt_arg(&argv[0])));
        (format!("@echo {display}\r\n@{exe} {args}"), None)
    };
    if body.lines().any(|line| line.len() >= 8191) {
        return Err(adapter_error("SSH argv exceeds the cmd batch command line limit"));
    }
    Ok((format!("@setlocal DisableDelayedExpansion\r\n{body}\r\n"), intermediary))
}

fn cmd_exe(path: &str) -> io::Result<String> {
    let path = path.strip_prefix(r"\\?\").unwrap_or(path);
    if path.contains('"') || !Path::new(path).is_absolute() {
        return Err(adapter_error("unsafe SSH cmd executable path"));
    }
    // The executable token itself is quoted for cmd; batch percent expansion
    // still applies inside quotes. Delayed expansion is off in the batch.
    Ok(format!("\"{}\"", path.replace('%', "%%")))
}

fn cmd_escape(crt: &str) -> String {
    let mut escaped = String::new();
    for ch in crt.chars() {
        match ch {
            '%' => escaped.push_str("%%"),
            // Hide CRT quotes from cmd (which does not understand \"), and
            // protect every cmd metacharacter in that unquoted parse state.
            '"' | '^' | '&' | '|' | '<' | '>' | '(' | ')' => {
                escaped.push('^');
                escaped.push(ch);
            }
            _ => escaped.push(ch),
        }
    }
    escaped
}
