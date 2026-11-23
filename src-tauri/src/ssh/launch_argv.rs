//! Pure OpenSSH launch planning and private bastion payload publication.
//!
//! The caller owns receipt/generation admission. Paths and executables passed here
//! come from the backend, not IPC. A preview may pass path labels, not authority.
use super::{
    session::{identity_path, KnownHostsPaths},
    store::{bare_host, canonical_option, valid_host, Auth, StoreError},
    target::{Hop, ResolvedTarget},
};
use crate::pty_manager::ssh_helpers::{Helper, HelperKind, HelperRoot, HelperUse, ProcessIdentity};
use std::{io, path::Path};

#[cfg(test)]
#[path = "launch_argv_tests.rs"]
mod tests;

pub struct LaunchArgv {
    outer: Vec<String>,
    proxy: Option<Vec<String>>,
    destination: String,
}

/// The SSH executable's *runtime*, not the terminal profile's shell. POSIX
/// paths passed to this module must already use the selected runtime's spelling.
/// Select PosixOrFish only for a runtime whose ProxyCommand interpreter is
/// known to be Bourne-compatible or fish; WSL is not a native runtime.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProxyRuntime {
    /// Audited Bourne-compatible or fish login shell; fixed /bin/sh exists.
    PosixOrFish,
    /// Only the OS's System32/OpenSSH/ssh.exe, never Git/MSYS/Cygwin SSH.
    WindowsNative,
    Unsupported,
}

fn option(argv: &mut Vec<String>, key: &str, value: &str) {
    argv.extend(["-o".into(), format!("{key}={value}")]);
}

fn literal_path(path: &str, field: &str) -> Result<String, StoreError> {
    // OpenSSH expands ${ENV} (no literal escape) as well as percent tokens.
    if path.is_empty() || path.contains("${") || path.chars().any(char::is_control) {
        return Err(StoreError::field(field, "unsupported-path"));
    }
    // Win32 accepts forward slashes for normal drive paths. This avoids
    // relying on backslash unescaping in older inbox OpenSSH option parsers.
    #[cfg(windows)]
    let path = if path.starts_with(r"\\?\") || path.starts_with(r"\\.\") {
        return Err(StoreError::field(field, "unsupported-path"));
    } else {
        path.replace('\\', "/")
    };
    Ok(path.replace('%', "%%"))
}

fn hop_argv(ssh: &str, home: &Path, hop: &Hop, trust: &str) -> Result<Vec<String>, StoreError> {
    if hop.host.is_empty() || !valid_host(&hop.host) || hop.port == 0 {
        return Err(StoreError::field("host", "invalid"));
    }
    if hop.user.trim().is_empty() || hop.user.chars().any(char::is_control) {
        return Err(StoreError::field("user", "invalid"));
    }
    if trust.starts_with('~') || trust.eq_ignore_ascii_case("none") {
        return Err(StoreError::field("knownHostsPaths", "unsupported-path"));
    }
    let trust = literal_path(trust, "knownHostsPaths")?
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    let mut argv = vec![ssh.into(), "-F".into(), "none".into()];
    option(&mut argv, "StrictHostKeyChecking", "yes");
    option(&mut argv, "UserKnownHostsFile", &format!("\"{trust}\""));
    option(&mut argv, "GlobalKnownHostsFile", "none");
    argv.extend(["-p".into(), hop.port.to_string(), "-l".into(), hop.user.clone()]);
    match hop.auth {
        Auth::KeyFile => {
            let identity = hop.identity_file.as_deref().ok_or_else(|| {
                StoreError::field("identityFile", "required")
            })?;
            let identity = identity_path(home, identity);
            let identity = identity.to_str().ok_or_else(|| {
                StoreError::field("identityFile", "unsupported-path")
            })?;
            // The -i existence check uses the raw argv, before token expansion.
            // Use the config parser instead, preserving the same literal path.
            if identity.starts_with('~') || identity.eq_ignore_ascii_case("none") {
                return Err(StoreError::field("identityFile", "unsupported-path"));
            }
            let identity = literal_path(identity, "identityFile")?
                .replace('\\', "\\\\")
                .replace('"', "\\\"");
            option(&mut argv, "IdentityFile", &format!("\"{identity}\""));
            option(&mut argv, "IdentitiesOnly", "yes");
            option(&mut argv, "PreferredAuthentications", "publickey");
        }
        Auth::Agent => {
            option(&mut argv, "IdentityFile", "none");
            option(&mut argv, "PreferredAuthentications", "publickey");
        }
        Auth::Password => option(&mut argv, "PreferredAuthentications", "password"),
    }
    Ok(argv)
}

/// Plan argv without launching, publishing a file, reading config, or consulting
/// the environment. `ssh` is a trusted absolute native or POSIX-runtime path.
/// `trust` is the per-hop receipt paths (or labels, for display only).
pub fn build_launch_argv(
    target: &ResolvedTarget,
    trust: &KnownHostsPaths,
    ssh: &str,
    home: &Path,
) -> Result<LaunchArgv, StoreError> {
    if !(ssh.starts_with('/') || Path::new(ssh).is_absolute())
        || ssh.chars().any(char::is_control)
    {
        return Err(StoreError::field("ssh", "unsupported-path"));
    }
    let (jump, destination) = match (target.hops.as_slice(), trust.jump.as_deref()) {
        ([destination], None) => (None, destination),
        ([jump, destination], Some(path)) => (Some((jump, path)), destination),
        _ => return Err(StoreError::field("knownHostsPaths", "hop-mismatch")),
    };
    let mut outer = hop_argv(ssh, home, destination, &trust.target)?;
    if target.extra_options.len() > 32 {
        return Err(StoreError::field("extraOptions", "too-many"));
    }
    for (key, value) in &target.extra_options {
        option(&mut outer, canonical_option(key, value)?, value);
    }
    let host = bare_host(&destination.host);
    let proxy = jump
        .map(|(jump, path)| -> Result<Vec<String>, StoreError> {
            let mut child = hop_argv(ssh, home, jump, path)?;
            // A resolved literal, not OpenSSH %h/%p expansions in shell code.
            let endpoint = if host.contains(':') {
                format!("[{host}]:{}", destination.port)
            } else {
                format!("{host}:{}", destination.port)
            };
            child.extend(["-W".into(), endpoint, "--".into(), bare_host(&jump.host).into()]);
            Ok(child)
        })
        .transpose()?;
    Ok(LaunchArgv { outer, proxy, destination: host.into() })
}

// POSIX sh and fish both concatenate adjacent quoted/unquoted fragments. Put
// backslashes/apostrophes outside the quotes, where both recognize the escape.
fn shell_literal(value: &str) -> String {
    let mut out = String::from("'");
    for ch in value.chars() {
        if matches!(ch, '\\' | '\'') {
            out.push_str("'\\");
            out.push(ch);
            out.push('\'');
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

#[cfg(any(windows, test))]
fn native_proxy_command(child: &[String]) -> io::Result<String> {
    use crate::pty_manager::ssh_shell::posix::launch::crt_arg;

    // Win32-OpenSSH strips its synthetic "exec " prefix and passes the raw
    // command to posix_spawnp -> CreateProcessW. No cmd.exe and no login shell.
    // Quote argv[0] too: Win32-OpenSSH preserves an already-quoted command line.
    // Percent escaping is for the *outer* SSH pass, including any % escapes
    // already destined for the bastion's known-hosts/identity option parser.
    let raw = child.iter().map(|arg| crt_arg(arg)).collect::<Vec<_>>().join(" ");
    let escaped = raw.replace('%', "%%");
    if escaped.encode_utf16().count() >= 32_767 {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "SSH proxy command too long"));
    }
    Ok(escaped)
}

fn posix_proxy_command(path: &str) -> String {
    format!("/bin/sh {}", shell_literal(&path.replace('%', "%%")))
}

impl LaunchArgv {
    fn render(&self, proxy_command: Option<&str>) -> Vec<String> {
        let mut argv = self.outer.clone();
        if let Some(command) = proxy_command {
            option(&mut argv, "ProxyCommand", command);
        }
        argv.extend(["--".into(), self.destination.clone()]);
        argv
    }

    /// Symbolic argv, only for display. Never execute or use as launch authority.
    pub fn preview_argv(&self) -> Vec<String> {
        let command = self.proxy.as_ref().map(|_| {
            if cfg!(windows) {
                "<native-ssh-proxy>".into()
            } else {
                posix_proxy_command("<private-proxy-helper>")
            }
        });
        self.render(command.as_deref())
    }

    /// The argv a user can run by hand, for the preview's Copy text: the
    /// native Windows ProxyCommand needs no private payload, but a POSIX jump
    /// runs a helper that only a real launch publishes, so it has none.
    /// An error is a native ProxyCommand too long for Windows to run at all.
    pub fn copyable_argv(&self) -> io::Result<Option<Vec<String>>> {
        let Some(child) = &self.proxy else { return Ok(Some(self.render(None))) };
        #[cfg(windows)]
        return native_proxy_command(child).map(|command| Some(self.render(Some(&command))));
        #[cfg(not(windows))]
        {
            let _ = child;
            Ok(None)
        }
    }

    /// Native Win32-OpenSSH has no payload to publish or retain. Select the
    /// system executable by provenance, not by the basename of a profile tool.
    #[cfg(windows)]
    pub fn native_windows_argv(&self) -> io::Result<Vec<String>> {
        let ssh = crate::pty_manager::ssh_shell::system_shell(r"OpenSSH\ssh.exe")?;
        if !self.outer[0].replace('/', "\\").eq_ignore_ascii_case(&ssh) {
            return Err(io::Error::new(io::ErrorKind::Unsupported, "expected system Win32-OpenSSH"));
        }
        let command = self.proxy.as_ref().map(|child| {
            let mut args = child.clone();
            args[0] = ssh.clone();
            native_proxy_command(&args)
        }).transpose()?;
        let mut argv = self.render(command.as_deref());
        argv[0] = ssh;
        Ok(argv)
    }

    /// Publish and pin the fixed-command bastion payload before exposing its argv.
    /// `runtime_path` maps the private native path into the chosen SSH runtime.
    /// Refuse unproven ProxyCommand transports rather than approximate quoting.
    pub fn publish(
        &self,
        root: &HelperRoot,
        owner: ProcessIdentity,
        runtime: ProxyRuntime,
        runtime_path: impl FnOnce(&Path) -> io::Result<String>,
    ) -> io::Result<PublishedLaunch> {
        let Some(child) = &self.proxy else {
            return Ok(PublishedLaunch { argv: self.render(None), payload: None });
        };
        #[cfg(windows)]
        if runtime == ProxyRuntime::WindowsNative {
            return Ok(PublishedLaunch { argv: self.native_windows_argv()?, payload: None });
        }
        if cfg!(windows) || runtime != ProxyRuntime::PosixOrFish {
            return Err(io::Error::new(io::ErrorKind::Unsupported, "unsupported SSH proxy runtime"));
        }
        if !child[0].starts_with('/') {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "expected POSIX runtime SSH path"));
        }
        // The private script contains exactly one command. exec preserves the
        // binary tunnel's stdin/stdout; no eval, interpolation or PATH lookup.
        let script = format!("exec {}\n", child.iter().map(|arg| shell_literal(arg)).collect::<Vec<_>>().join(" "));
        let helper = root.publish(owner, HelperKind::AttemptPayload, "sh", script.as_bytes())?;
        let prepared = (|| {
            let path = runtime_path(&helper.path())?;
            if !path.starts_with('/') || path.chars().any(char::is_control) {
                return Err(io::Error::new(io::ErrorKind::InvalidInput, "unsupported proxy helper path"));
            }
            Ok((self.render(Some(&posix_proxy_command(&path))), helper.acquire()?))
        })();
        match prepared {
            Ok((argv, usage)) => Ok(PublishedLaunch { argv, payload: Some((helper, usage)) }),
            Err(error) => {
                let _ = helper.cancel_attempt();
                Err(error)
            }
        }
    }
}

pub struct PublishedLaunch {
    argv: Vec<String>,
    payload: Option<(Helper, HelperUse)>,
}

impl PublishedLaunch {
    pub fn argv(&self) -> &[String] {
        &self.argv
    }

    pub fn retire_payload(&self) -> io::Result<()> {
        if let Some((helper, _)) = &self.payload {
            helper.cancel_attempt()?;
        }
        Ok(())
    }

    /// Only after proven non-submission or proof no child can use the payload.
    pub fn finish_after_quiescence(self) -> io::Result<()> {
        if let Some((helper, usage)) = self.payload {
            helper.cancel_attempt()?;
            usage.finish()?;
        }
        Ok(())
    }
}
