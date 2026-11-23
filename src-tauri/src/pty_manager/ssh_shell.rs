//! SSH-only prompt readiness and private startup adapters.
//!
//! Emit `ESC ] 633;TermFlowSshReady;<nonce>;<sequence> ST` (no spaces;
//! `ST` = `ESC \\`, or use BEL). The nonce is 32 lowercase hex digits, unique
//! to the registered process generation. Emit positive increasing decimal
//! sequence numbers, or for cmd PROMPT use `$E]633;TermFlowSshReady;<nonce>;$T$E\`
//! (24-hour `HH:MM:SS.hh`, including cmd's space-padded hour). A changed cmd
//! stamp may wrap or roll back; freshness still requires consistent live bytes
//! after the latest admitted input. Same-centisecond duplicates are ignored;
//! readiness waits for the next real prompt (Preparing still offers Cancel).
//! No hook takes a command or a secret.
//!
//! Stage the fresh process, generate a nonce with `new_nonce`, and register it
//! with `HostKeys::register_ssh_prompt` before starting its output reader. For a
//! hosted shell put the same nonce in the private SpawnSpec env entry
//! `termflow_pty_protocol::ssh_prompt::HOST_REGISTRATION_ENV`; the sidecar
//! consumes it as metadata, not as inherited shell environment. Do not register
//! reattached/replayed output. Neither source calls a writer or waits for one.

pub(crate) mod posix;

use super::input_gate::ReadyEpoch;
use crate::{elevated_host::HostChannel, state::HostKeys};
use termflow_pty_protocol::{da1::StartupDrain, ssh_prompt::PromptParser};

pub(crate) fn new_nonce() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

const WSL_REFUSAL: &str = "SSH connections launch in a native shell; WSL default profile not supported yet";
// The terminal-create commands carry string errors; this refusal is a wire code.
const HOST_REFUSAL: &str = "PtyHostOutdated";

pub(crate) fn validate_create(
    connection_id: Option<&str>, executable: Option<&str>, args: Option<&[String]>,
) -> Result<Option<String>, String> {
    let Some(id) = connection_id else { return Ok(None) };
    let executable = executable.unwrap_or_default();
    let base = executable.rsplit(['/', '\\']).next().unwrap_or_default();
    if base.eq_ignore_ascii_case("wsl.exe") || base.eq_ignore_ascii_case("wsl") {
        return Err(WSL_REFUSAL.into());
    }
    if id.trim().is_empty() {
        return Err("SSH readiness adapter requires a saved connection id".into());
    }
    #[cfg(windows)]
    let native;
    #[cfg(windows)]
    let executable = if executable.eq_ignore_ascii_case("cmd.exe") || executable.eq_ignore_ascii_case("powershell.exe") {
        // These built-in profiles use bare names. Do not let PATH or cwd select
        // a different executable for an instrumented shell.
        native = system_shell(executable).map_err(adapter_error)?;
        native.as_str()
    } else { executable };
    posix::validate_profile(executable, args.unwrap_or_default()).map_err(adapter_error)?;
    Ok(Some(executable.to_owned()))
}

#[cfg(windows)]
pub(crate) fn system_shell(executable: &str) -> std::io::Result<String> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;
    let mut buf = vec![0u16; 32768];
    let len = unsafe { GetSystemDirectoryW(buf.as_mut_ptr(), buf.len() as u32) } as usize;
    if len == 0 || len >= buf.len() { return Err(std::io::Error::last_os_error()); }
    let mut path = std::path::PathBuf::from(std::ffi::OsString::from_wide(&buf[..len]));
    if executable.eq_ignore_ascii_case("powershell.exe") { path.push(r"WindowsPowerShell\v1.0"); }
    path.push(executable);
    path.into_os_string().into_string().map_err(|_| std::io::Error::other("non-Unicode system shell path"))
}

/// Copy for an absent optional Windows feature; the preview and Connect share it.
pub(crate) const SSH_CLIENT_MISSING: &str =
    "Windows OpenSSH Client is not installed. Turn it on in Settings > System > Optional features > OpenSSH Client, then try again.";

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum NativeSshClient {
    /// The system directory could not be resolved.
    Unavailable,
    /// The path resolved but the optional OpenSSH Client feature is not installed.
    Missing,
}

/// system_shell only builds a path; the OpenSSH Client is an optional feature.
pub(crate) fn installed_ssh_client(path: std::io::Result<String>) -> Result<String, NativeSshClient> {
    let path = path.map_err(|_| NativeSshClient::Unavailable)?;
    if std::path::Path::new(&path).is_file() { Ok(path) } else { Err(NativeSshClient::Missing) }
}

#[cfg(windows)]
pub(crate) fn native_ssh_client() -> Result<String, NativeSshClient> {
    installed_ssh_client(system_shell(r"OpenSSH\ssh.exe"))
}

pub(crate) fn has_cwd_hook(executable: &str) -> bool {
    posix::is_powershell(executable)
}

fn adapter_error(error: std::io::Error) -> String {
    format!("SSH readiness adapter: {error}")
}

pub(crate) fn require_host_registration(opted_in: bool, capable: bool) -> Result<(), String> {
    if opted_in && !capable { Err(HOST_REFUSAL.into()) } else { Ok(()) }
}

/// Adds context to a host spawn error, except the host refusal: the renderer matches that code
/// exactly, so a prefix would turn its actionable copy back into "Failed to start shell".
pub(crate) fn spawn_error(context: &str, error: String) -> String {
    if error == HOST_REFUSAL { error } else { format!("{context}: {error}") }
}

#[cfg(test)]
#[test]
fn spawn_error_keeps_the_host_refusal_code_exact() {
    let refusal = require_host_registration(true, false).unwrap_err();
    assert_eq!(spawn_error("SSH readiness host spawn failed", refusal), "PtyHostOutdated");
    assert_eq!(spawn_error("elevated spawn failed", "boom".into()), "elevated spawn failed: boom");
}

/// Retire unused helpers automatically; once a spawn might have reached a
/// child, only positive evidence of shell exit permits retirement.
pub(crate) struct PreparedShell(Option<posix::PosixAdapter>);

impl PreparedShell {
    pub(crate) fn register<R: tauri::Runtime>(
        app: &tauri::AppHandle<R>, keys: &HostKeys, process: &str, cg: u64,
        spec: &mut termflow_pty_protocol::SpawnSpec, hosted: bool, connection_id: &str,
    ) -> Result<Self, String> {
        use super::ssh_helpers::HelperRoot;
        let root = HelperRoot::for_app(app).map_err(|error| error.to_string())?;
        Self::register_in(&root, keys, process, cg, spec, hosted, connection_id, |key| std::env::var(key).ok())
    }

    // `register`'s inputs plus the injected helper root and inherited environment.
    #[allow(clippy::too_many_arguments)]
    fn register_in(
        root: &super::ssh_helpers::HelperRoot, keys: &HostKeys, process: &str, cg: u64,
        spec: &mut termflow_pty_protocol::SpawnSpec, hosted: bool, connection_id: &str, inherited: impl Fn(&str) -> Option<String>,
    ) -> Result<Self, String> {
        use super::ssh_helpers::ProcessIdentity;
        let owner = ProcessIdentity::capture(std::process::id()).map_err(adapter_error)?;
        let nonce = new_nonce();
        let adapter = posix::instrument_posix(spec, &nonce, root, owner, inherited)
            .map_err(adapter_error)?;
        let prepared = Self(Some(adapter));
        keys.register_tagged_ssh_prompt(process, cg, &nonce, Some(connection_id))
            .map_err(|error| format!("SSH readiness registration failed: {error:?}"))?;
        *spec = prepared.0.as_ref().expect("newly prepared").spec.clone();
        if hosted {
            spec.env.push((termflow_pty_protocol::ssh_prompt::HOST_REGISTRATION_ENV.into(), nonce));
        }
        Ok(prepared)
    }

    pub(crate) fn submitted(mut self) -> posix::PosixAdapter {
        self.0.take().expect("prepared shell was not submitted")
    }
}

impl Drop for PreparedShell {
    fn drop(&mut self) {
        if let Some(adapter) = self.0.take() {
            let _ = adapter.finish_after_shell_quiescence();
        }
    }
}

pub(crate) fn retain_until_quiescent(adapter: posix::PosixAdapter, quiescent: impl Fn() -> bool + Send + 'static) {
    tauri::async_runtime::spawn(async move {
        while !quiescent() {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
        if let Err(error) = adapter.finish_after_shell_quiescence() {
            log::warn!("SSH readiness helper retirement failed: {error}");
        }
    });
}

/// Bind the native pid/start time at spawn completion, never on a later
/// launch poll (where the pid might already have been reused).
pub(crate) fn bind_spawned_shell(keys: &HostKeys, process: &str, shell: &str, pid: u32) {
    if let Ok(identity) = super::ssh_helpers::ProcessIdentity::capture(pid) {
        keys.bind_ssh_shell(process, shell.to_owned(), identity);
    }
}

pub(crate) fn retain_hosted(adapter: posix::PosixAdapter, pid: u32) {
    if pid != 0 {
        retain_until_quiescent(adapter, move || super::ssh_helpers::ProcessIdentity::pid_quiescent(pid));
    }
    // Unknown pid: a conservative drop leaves the private execution pins intact.
}

pub(crate) enum PromptProof<'a> {
    Local { drain: &'a StartupDrain, input_generation: u64 },
    Hosted { channel: HostChannel, key: &'a str, epoch: u64, stdin_writes: u64 },
}

pub(super) fn filter_local_output(
    parser: &mut Option<PromptParser>,
    keys: &HostKeys,
    process: &str,
    drain: Option<&StartupDrain>,
    data: Vec<u8>,
    mut ready: impl FnMut(ReadyEpoch),
) -> Vec<u8> {
    let (Some(parser), Some(drain)) = (parser, drain) else { return data };
    let stamp = drain.is_drained().then(|| keys.ssh_prompt_input_generation(process)).flatten();
    parser.filter(data, stamp, |nonce, sequence, input_generation| {
        let proof = PromptProof::Local { drain, input_generation };
        if let Ok(epoch) = keys.observe_shell_prompt(process, nonce, sequence, proof) {
            ready(epoch);
        }
    })
}

#[cfg(test)]
#[path = "ssh_shell/tests.rs"]
mod tests;
#[cfg(test)]
#[path = "ssh_shell/create_tests.rs"]
mod create_tests;
