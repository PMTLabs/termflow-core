//! Native, read-only command projections. The paths here are labels, not a receipt.
use super::{
    launch_argv::build_launch_argv,
    session::{native_home, KnownHostsPaths},
    store::{ConnectionInput, Store, StoreError},
    target::resolve,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum PreviewSource {
    Saved { id: String },
    // Boxed: an unsaved editor draft is much larger than a saved id.
    Draft { draft: Box<ConnectionInput>, editing_id: Option<String> },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    argv: Vec<String>,
    /// Text for each shell the user may paste into; the first is the default.
    commands: Vec<ShellCommand>,
    store_revision: u64,
    config_notice: &'static str,
    wrapper: &'static str,
}

#[derive(Debug, Serialize)]
pub struct ShellCommand {
    shell: &'static str,
    label: &'static str,
    text: String,
    /// Why this text cannot be copied and run as-is.
    #[serde(skip_serializing_if = "Option::is_none")]
    unavailable: Option<&'static str>,
}

#[derive(Debug, Serialize)]
pub struct PreviewError {
    code: &'static str,
    message: &'static str,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    fields: Vec<StoreError>,
}
impl PreviewError {
    fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message, fields: vec![] }
    }
    fn unsupported() -> Self {
        Self::new("UnsupportedContext", "SSH preview requires native desktop paths.")
    }
    #[cfg_attr(not(windows), allow(dead_code))]
    fn native_ssh(error: crate::pty_manager::ssh_shell::NativeSshClient) -> Self {
        match error {
            crate::pty_manager::ssh_shell::NativeSshClient::Missing => {
                Self::new("SshClientMissing", crate::pty_manager::ssh_shell::SSH_CLIENT_MISSING)
            }
            crate::pty_manager::ssh_shell::NativeSshClient::Unavailable => Self::unsupported(),
        }
    }
    fn validation(error: StoreError) -> Self {
        if error.code == "not-found"
            && matches!(error.field.as_deref(), None | Some("connectionId"))
        {
            return Self::new("NotFound", "SSH connection not found.");
        }
        if matches!(error.field.as_deref(), Some("ssh" | "knownHostsPaths")) {
            return Self::unsupported();
        }
        Self { code: "Validation", message: "Check the SSH connection fields.", fields: vec![error] }
    }
}

pub fn connection_preview(store: &Store, source: PreviewSource) -> Result<Preview, PreviewError> {
    preview_in(store, source, || {
        #[cfg(windows)]
        let executable = crate::pty_manager::ssh_shell::native_ssh_client().map_err(PreviewError::native_ssh)?;
        #[cfg(not(windows))]
        let executable = "/usr/bin/ssh".into();
        Ok((executable, native_home()))
    })
}

fn preview_in(
    store: &Store,
    source: PreviewSource,
    native_paths: impl FnOnce() -> Result<(String, PathBuf), PreviewError>,
) -> Result<Preview, PreviewError> {
    let mut snapshot = store.preview_snapshot().map_err(|_| {
        PreviewError::new("StoreUnavailable", "SSH definitions could not be read.")
    })?;
    let id = match source {
        PreviewSource::Saved { id } => id,
        PreviewSource::Draft { mut draft, editing_id } => {
            // Replacing the edited row in memory also validates self references
            // and existing referrers, exactly as a real editor save would.
            if draft.id.is_some() && draft.id != editing_id {
                return Err(PreviewError::validation(StoreError::field("id", "editing-id-mismatch")));
            }
            draft.id = editing_id;
            snapshot.upsert_connection(*draft).map_err(PreviewError::validation)?;
            snapshot.connections.last().expect("upsert appends the row").id.clone()
        }
    };
    let target = resolve(&snapshot, &id).map_err(PreviewError::validation)?;
    let (ssh, home) = native_paths()?;
    let has_jump = target.hops.len() == 2;
    let trust = preview_trust(&home, has_jump)?;
    let plan = build_launch_argv(&target, &trust, &ssh, &home).map_err(PreviewError::validation)?;
    let argv = plan.preview_argv();
    let runnable = match plan.copyable_argv() {
        Ok(Some(argv)) => Ok(argv),
        Ok(None) => Err(PRIVATE_HELPER),
        Err(_) => Err(TOO_LONG),
    };
    let commands = shell_commands(&argv, runnable.as_deref().map_err(|why| *why), cfg!(windows));
    Ok(Preview {
        argv,
        commands,
        store_revision: snapshot.revision,
        config_notice: "~/.ssh/config does not apply to saved connections. Preview only; trust is not verified here.",
        wrapper: match (has_jump, cfg!(windows)) {
            (false, _) => "Direct native OpenSSH connection",
            (true, true) => "Jump via native OpenSSH ProxyCommand (shown symbolically)",
            (true, false) => "Jump via a private ProxyCommand helper (shown symbolically)",
        },
    })
}

fn preview_trust(home: &Path, has_jump: bool) -> Result<KnownHostsPaths, PreviewError> {
    if !home.is_absolute() {
        return Err(PreviewError::unsupported());
    }
    let path = home.join(".ssh/known_hosts");
    let path = path.to_str().ok_or_else(PreviewError::unsupported)?;
    Ok(KnownHostsPaths { target: path.into(), jump: has_jump.then(|| path.into()) })
}

const PRIVATE_HELPER: &str =
    "This jump host runs through a private helper that only TermFlow creates, so the command cannot be run by hand.";

const TOO_LONG: &str = "This jump host command is longer than Windows allows, so it cannot be run by hand.";

/// Quote the runnable argv for each shell the user may paste into. Connect
/// runs ssh directly with no shell, so the text targets the platform's usual
/// interactive shells and says which one it is for. Without a runnable argv
/// the symbolic one is shown with the reason, never as copyable.
fn shell_commands(symbolic: &[String], runnable: Result<&[String], &'static str>, windows: bool) -> Vec<ShellCommand> {
    let argv = runnable.unwrap_or(symbolic);
    let entry = |shell, label, quoted: Result<String, &'static str>| {
        let (text, unavailable) = match (runnable, quoted) {
            (Err(why), Ok(text)) => (text, Some(why)),
            (Ok(_), Ok(text)) => (text, None),
            (_, Err(reason)) => (posix_text(argv), Some(reason)),
        };
        ShellCommand { shell, label, text, unavailable }
    };
    if windows {
        vec![
            entry("powershell", "PowerShell", powershell_text(argv)),
            entry("cmd", "Command Prompt", cmd_text(argv)),
        ]
    } else {
        vec![entry("sh", "sh, bash or zsh", Ok(posix_text(argv)))]
    }
}

fn posix_text(argv: &[String]) -> String {
    let word = |arg: &String| {
        let plain = !arg.is_empty()
            && arg.chars().all(|c| c.is_ascii_alphanumeric() || "@%+=:,./_-".contains(c));
        if plain { arg.clone() } else { format!("'{}'", arg.replace('\'', r"'\''")) }
    };
    argv.iter().map(word).collect::<Vec<_>>().join(" ")
}

/// CommandLineToArgvW spelling, quoted only when the argument needs it.
fn windows_word(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '"']) {
        return arg.into();
    }
    crate::pty_manager::ssh_shell::posix::launch::crt_arg(arg)
}

fn powershell_text(argv: &[String]) -> Result<String, &'static str> {
    // PowerShell treats the typographic single quotes as quotes too.
    let literal = |arg: &str| {
        let mut out = String::from("'");
        for ch in arg.chars() {
            if matches!(ch, '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}') {
                out.push(ch);
            }
            out.push(ch);
        }
        out.push('\'');
        out
    };
    // Windows PowerShell 5.1 passes embedded double quotes unescaped and drops
    // empty arguments; PowerShell 7.3+ escapes them, and also re-splits and
    // re-quotes after --%. A single ArgumentList string is the one command line
    // both hand to ssh.exe verbatim, and nothing expands inside single quotes.
    let line = argv[1..].iter().map(|arg| windows_word(arg)).collect::<Vec<_>>().join(" ");
    Ok(format!(
        "Start-Process -FilePath {} -ArgumentList {} -NoNewWindow -Wait",
        literal(&argv[0]),
        literal(&line)
    ))
}

fn cmd_text(argv: &[String]) -> Result<String, &'static str> {
    if argv.iter().any(|arg| arg.contains('%')) {
        return Err("Command Prompt expands % in a pasted command; use PowerShell.");
    }
    let line = argv.iter().map(|arg| windows_word(arg)).collect::<Vec<_>>().join(" ");
    // cmd flips its quote state at every double quote, escaped or not, and
    // only treats metacharacters outside quotes as operators.
    let mut out = String::with_capacity(line.len());
    let mut quoted = false;
    for ch in line.chars() {
        if ch == '"' {
            quoted = !quoted;
        } else if !quoted && "^&|<>()".contains(ch) {
            out.push('^');
        }
        out.push(ch);
    }
    Ok(out)
}

#[cfg(test)]
#[path = "preview_tests.rs"]
mod tests;
