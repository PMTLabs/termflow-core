//! Preparing an adapter never spawns a shell, edits a dotfile, or changes the
//! ordinary spec. Its only side effect is publishing private startup hooks.

use crate::pty_manager::ssh_helpers::{Helper, HelperKind, HelperRoot, HelperUse, ProcessIdentity};
use std::{io, path::Path};
use termflow_pty_protocol::{ssh_prompt::valid_nonce, SpawnSpec};

#[path = "windows.rs"]
pub(crate) mod windows;

// The consumer is wired in Lane B; Lane A exercises this through real PTYs.
#[allow(dead_code)]
#[path = "launch.rs"]
pub(crate) mod launch;

const BASH_BOOTSTRAP: &str = "__TERMFLOW_SSH_BOOTSTRAP";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Dialect { Bash, Zsh, Fish }

#[derive(Clone, Copy)]
enum Paths { Native, Msys, Cygwin }

fn adapter_error(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

/// An instrumented copy, with the hook files pinned until the caller knows the
/// shell has exited (or knows it was never started). Dropping it conservatively
/// retains the in-flight markers, including across a GUI crash / hosted detach.
pub(crate) struct PosixAdapter {
    pub(crate) spec: SpawnSpec,
    hooks: Vec<(Helper, HelperUse)>,
}

impl PosixAdapter {
    pub(crate) fn finish_after_shell_quiescence(self) -> io::Result<()> {
        let mut result = Ok(());
        for (helper, usage) in self.hooks {
            if let Err(error) = helper.retire_quiescent_shell_hook().and_then(|_| usage.finish()) {
                result = Err(error);
            }
        }
        result
    }

    fn publish(&mut self, root: &HelperRoot, owner: &ProcessIdentity, paths: Paths, name: &str, content: &str) -> io::Result<String> {
        let helper = root.publish(owner.clone(), HelperKind::ShellHook, name, content.as_bytes())?;
        let usage = helper.acquire()?;
        let native_path = usage.path();
        self.hooks.push((helper, usage));
        shell_path(&native_path, paths)
    }
}

/// `inherited` supplies the environment of the chosen spawn backend, before
/// applying the ordinary spec's env_remove/env. `supervisor` is a live owner for
/// pre-spawn publication, not the as-yet-unknown child PID. Neither the nonce nor
/// the host registration metadata belongs in the shell's environment or argv.
pub(crate) fn instrument_posix(
    ordinary: &SpawnSpec,
    nonce: &str,
    root: &HelperRoot,
    supervisor: ProcessIdentity,
    inherited: impl Fn(&str) -> Option<String>,
) -> io::Result<PosixAdapter> {
    if !valid_nonce(nonce) { return Err(adapter_error("invalid SSH readiness nonce")); }
    if let Some(result) = windows::instrument(ordinary, nonce, root, &supervisor) {
        return result;
    }
    let (dialect, paths) = classify(&ordinary.shell)?;
    let args = inspect_args(dialect, &ordinary.args)?;
    let effective_env = |key: &str| {
        let eq = |candidate: &str| if cfg!(windows) { candidate.eq_ignore_ascii_case(key) } else { candidate == key };
        ordinary.env.iter().rev().find(|(k, _)| eq(k)).map(|(_, v)| v.clone())
            .or_else(|| if ordinary.env_remove.iter().any(|k| eq(k)) { None } else { inherited(key) })
    };
    // bash in POSIX/compatibility mode chooses different user startup files.
    if dialect == Dialect::Bash && (effective_env("POSIXLY_CORRECT").is_some()
        || effective_env("SHELLOPTS").is_some_and(|opts| opts.split(':').any(|opt| opt == "posix"))) {
        return Err(adapter_error("SSH readiness does not support a POSIX-mode bash profile"));
    }
    // Validate the root's spelling before publishing anything for this runtime.
    shell_path(root.path(), paths)?;
    let mut output = PosixAdapter { spec: ordinary.clone(), hooks: Vec::new() };
    let result = (|| -> io::Result<()> {
        match dialect {
            Dialect::Bash => {
                let source = if args.login {
                    format!("builtin set +o posix\nbuiltin unset POSIXLY_CORRECT\n{}{}{}", restore_export("ENV", effective_env("ENV").as_deref()),
                        restore_export(BASH_BOOTSTRAP, effective_env(BASH_BOOTSTRAP).as_deref()), BASH_LOGIN_RC)
                } else if let Some(rc) = args.rcfile {
                    bash_custom_rc(rc, paths)?
                } else {
                    "if [[ -r $HOME/.bashrc ]]; then builtin source \"$HOME/.bashrc\"; fi\n".into()
                };
                let hook = source + &BASH_HOOK.replace("@NONCE@", nonce);
                let helper = output.publish(root, &supervisor, paths, "sh", &hook)?;
                if args.login {
                    // bash ignores --rcfile on a native login. Use its interactive ENV
                    // ingress in POSIX mode with native profile loading suppressed; the
                    // wrapper immediately turns POSIX mode off and loads normal login
                    // profiles. This retains the real login_shell flag and avoids an
                    // extra system bashrc on distros that compile in SYS_BASHRC.
                    // A custom rcfile is only used for non-login shells, as in bash.
                    output.spec.args = ["--noprofile".into(), "--posix".into()]
                        .into_iter().chain(args.kept).collect();
                    output.spec.env.push((BASH_BOOTSTRAP.into(), helper));
                    // ENV expands its expression once: never evaluate a path as shell code.
                    output.spec.env.push(("ENV".into(), format!("${{{BASH_BOOTSTRAP}}}")));
                } else {
                    output.spec.args = ["--rcfile".into(), helper].into_iter().chain(args.kept).collect();
                }
            }
            Dialect::Zsh => {
                let stages: &[&str] = if args.login { &[".zshenv", ".zprofile", ".zshrc", ".zlogin"] }
                    else { &[".zshenv", ".zshrc"] };
                let mut next = None::<String>;
                // Each cp1 publication owns a single file. Link private ZDOTDIRs in
                // startup order, letting zsh still run its compiled-in global files
                // between phases. Every user file sees the actual user ZDOTDIR/HOME.
                for &stage in stages.iter().rev() {
                    let mut script = if stage == ".zshenv" {
                        restore_export("ZDOTDIR", effective_env("ZDOTDIR").as_deref())
                    } else { ZSH_RESTORE.into() };
                    script.push_str(&format!("if [[ -r \"${{ZDOTDIR-$HOME}}/{stage}\" ]]; then builtin source \"${{ZDOTDIR-$HOME}}/{stage}\"; fi\n"));
                    if let Some(dir) = next {
                        script.push_str(ZSH_SAVE);
                        script.push_str(&format!("export ZDOTDIR={}\n", sh_quote(&dir)));
                    } else {
                        script.push_str(&ZSH_HOOK.replace("@NONCE@", nonce));
                    }
                    let helper = output.publish(root, &supervisor, paths, stage, &script)?;
                    next = Some(helper.rsplit_once('/').ok_or_else(|| adapter_error("invalid zsh hook directory"))?.0.to_string());
                }
                output.spec.env.push(("ZDOTDIR".into(), next.expect("zsh has startup phases")));
            }
            Dialect::Fish => {
                let helper = output.publish(root, &supervisor, paths, "fish", &FISH_HOOK.replace("@NONCE@", nonce))?;
                output.spec.args.extend(["--init-command".into(), format!("source {}", fish_quote(&helper))]);
            }
        }
        Ok(())
    })();
    if let Err(error) = result {
        let _ = output.finish_after_shell_quiescence(); // nothing was submitted
        return Err(error);
    }
    Ok(output)
}

pub(super) fn is_powershell(executable: &str) -> bool {
    windows::dialect(executable) == Some(true)
}

pub(super) fn validate_profile(executable: &str, args: &[String]) -> io::Result<()> {
    if let Some(ps) = windows::dialect(executable) {
        return windows::validate_profile(executable, args, ps);
    }
    let (dialect, _) = classify(executable)?;
    inspect_args(dialect, args).map(|_| ())
}

fn classify(executable: &str) -> io::Result<(Dialect, Paths)> {
    let base = executable.rsplit(['/', '\\']).next().unwrap_or_default();
    let dialect = match base.to_ascii_lowercase().trim_end_matches(".exe") {
        "bash" => Dialect::Bash,
        "zsh" => Dialect::Zsh,
        "fish" => Dialect::Fish,
        _ => return Err(adapter_error("SSH readiness requires a supported interactive shell executable")),
    };
    if !Path::new(executable).is_absolute() {
        return Err(adapter_error("SSH readiness requires an absolute shell executable path"));
    }
    let paths = if cfg!(windows) {
        let components = executable.split(['/', '\\']).map(str::to_ascii_lowercase).collect::<Vec<_>>();
        if components.iter().any(|p| p.starts_with("cygwin")) { Paths::Cygwin }
        else if components.iter().any(|p| p == "git" || p.starts_with("msys")) { Paths::Msys }
        else { return Err(adapter_error("cannot identify the Windows POSIX shell runtime from the executable path")); }
    } else { Paths::Native };
    Ok((dialect, paths))
}

struct Args<'a> {
    login: bool,
    rcfile: Option<&'a str>,
    kept: Vec<String>,
}

fn inspect_args(dialect: Dialect, ordinary: &[String]) -> io::Result<Args<'_>> {
    let err = || adapter_error("SSH readiness cannot compose with these shell startup flags");
    let mut output = Args { login: false, rcfile: None, kept: Vec::new() };
    let mut args = ordinary.iter();
    while let Some(arg) = args.next() {
        if dialect == Dialect::Bash && matches!(arg.as_str(), "--rcfile" | "--init-file") {
            let path = args.next().filter(|path| !path.is_empty()).ok_or_else(err)?;
            if output.rcfile.replace(path).is_some() { return Err(err()); }
            continue;
        }
        if dialect == Dialect::Fish && matches!(arg.as_str(), "-C" | "--init-command") {
            output.kept.push(arg.clone());
            output.kept.push(args.next().ok_or_else(err)?.clone());
            continue;
        }
        if dialect == Dialect::Fish && (arg.starts_with("--init-command=") || arg.starts_with("-C")) {
            output.kept.push(arg.clone());
            continue;
        }
        match arg.as_str() {
            "--login" => output.login = true,
            "--interactive" if dialect != Dialect::Bash => {}
            short if short.strip_prefix('-').is_some_and(|flags| !flags.is_empty() && flags.chars().all(|c| matches!(c, 'i' | 'l'))) => {
                output.login |= short.contains('l');
            }
            _ => return Err(err()),
        }
        output.kept.push(arg.clone());
    }
    Ok(output)
}

/// Map only argv[0] for the *outer* shell. Known-hosts and identity arguments
/// still use the fixed OpenSSH executable's native path spelling.
#[cfg(windows)]
pub(crate) fn native_ssh_outer_path(shell: &str, ssh: &str) -> io::Result<String> {
    if windows::dialect(shell).is_some() {
        return Ok(ssh.into());
    }
    let (_, paths) = classify(shell)?;
    if matches!(paths, Paths::Cygwin) {
        return Err(adapter_error("native OpenSSH argv is not qualified under Cygwin"));
    }
    shell_path(Path::new(ssh), paths)
}

fn shell_path(path: &Path, paths: Paths) -> io::Result<String> {
    let path = path.to_str().ok_or_else(|| adapter_error("SSH hook path is not valid Unicode"))?;
    match paths {
        Paths::Native if path.starts_with('/') => Ok(path.into()),
        Paths::Native => Err(adapter_error("SSH hook path is not absolute")),
        Paths::Msys | Paths::Cygwin => {
            let path = path.strip_prefix(r"\\?\").unwrap_or(path);
            let bytes = path.as_bytes();
            if bytes.len() < 3 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' || !matches!(bytes[2], b'\\' | b'/') {
                return Err(adapter_error("SSH hook is not on a Windows drive-letter path"));
            }
            let mount = if matches!(paths, Paths::Cygwin) { "/cygdrive" } else { "" };
            Ok(format!("{mount}/{}{}", bytes[0].to_ascii_lowercase() as char, path[2..].replace('\\', "/")))
        }
    }
}

fn sh_quote(value: &str) -> String { format!("'{}'", value.replace('\'', "'\"'\"'")) }
fn fish_quote(value: &str) -> String { format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'")) }

fn restore_export(key: &str, value: Option<&str>) -> String {
    match value {
        Some(value) => format!("builtin export {key}={}\n", sh_quote(value)),
        None => format!("builtin unset {key}\n"),
    }
}

fn bash_custom_rc(rc: &str, paths: Paths) -> io::Result<String> {
    let literal = if let Some(suffix) = rc.strip_prefix("~/") {
        format!("\"$HOME\"/{}", sh_quote(suffix))
    } else if !matches!(paths, Paths::Native) && rc.as_bytes().get(1) == Some(&b':') {
        sh_quote(&shell_path(Path::new(rc), paths)?)
    } else if rc.contains('/') {
        sh_quote(rc)
    } else {
        sh_quote(&format!("./{rc}")) // do not let source resolve a bare name via PATH
    };
    Ok(format!("if [[ -r {literal} ]]; then builtin source {literal}; fi\n"))
}

const BASH_LOGIN_RC: &str = r#"if [[ -r /etc/profile ]]; then builtin source /etc/profile; fi
if [[ -r $HOME/.bash_profile ]]; then builtin source "$HOME/.bash_profile"
elif [[ -r $HOME/.bash_login ]]; then builtin source "$HOME/.bash_login"
elif [[ -r $HOME/.profile ]]; then builtin source "$HOME/.profile"
fi
"#;

const BASH_HOOK: &str = r#"
__termflow_ssh_seq=0
__termflow_ssh_ready() {
    local __termflow_ssh_status=$? __termflow_ssh_flags=$-
    case $__termflow_ssh_flags in *x*) builtin set +x ;; esac
    __termflow_ssh_seq=$((__termflow_ssh_seq + 1))
    builtin printf '\033]633;TermFlowSshReady;@NONCE@;%s\007' "$__termflow_ssh_seq"
    case $__termflow_ssh_flags in *x*) builtin set -x ;; esac
    return "$__termflow_ssh_status"
}
# Even a profile with allexport on must not export the nonce-bearing function.
builtin export -n -f __termflow_ssh_ready
__termflow_pc_attrs=$(builtin declare -p PROMPT_COMMAND 2>/dev/null || :)
__termflow_pc_attrs=${__termflow_pc_attrs#declare -}
case ${__termflow_pc_attrs%% *} in
    *a*) if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )); then
             PROMPT_COMMAND+=(__termflow_ssh_ready)
         else
             PROMPT_COMMAND[0]=${PROMPT_COMMAND[0]:+$PROMPT_COMMAND$'\n'}__termflow_ssh_ready
         fi ;;
    *) PROMPT_COMMAND=${PROMPT_COMMAND:+$PROMPT_COMMAND$'\n'}__termflow_ssh_ready ;;
esac
builtin unset __termflow_pc_attrs
"#;

const ZSH_SAVE: &str = r#"builtin unset __termflow_zdotdir __termflow_zdotdir_attrs
if (( ${+ZDOTDIR} )); then
    __termflow_zdotdir=$ZDOTDIR
    __termflow_zdotdir_attrs=${(t)ZDOTDIR}
fi
"#;

const ZSH_RESTORE: &str = r#"builtin unset ZDOTDIR
if (( ${+__termflow_zdotdir} )); then
    ZDOTDIR=$__termflow_zdotdir
    if [[ $__termflow_zdotdir_attrs == *export* ]]; then builtin export ZDOTDIR; fi
fi
builtin unset __termflow_zdotdir __termflow_zdotdir_attrs
"#;

const ZSH_HOOK: &str = r#"
typeset -gi __termflow_ssh_seq=0
__termflow_ssh_ready() {
    setopt localoptions noxtrace
    (( ++__termflow_ssh_seq ))
    builtin printf '\033]633;TermFlowSshReady;@NONCE@;%s\007' "$__termflow_ssh_seq"
}
typeset -ga precmd_functions
precmd_functions+=(__termflow_ssh_ready)
"#;

const FISH_HOOK: &str = r#"
set -gu __termflow_ssh_seq 0
function __termflow_ssh_ready --on-event fish_prompt
    set -l fish_trace
    set -gu __termflow_ssh_seq (math $__termflow_ssh_seq + 1)
    builtin printf '\033]633;TermFlowSshReady;@NONCE@;%s\007' $__termflow_ssh_seq
end
"#;

#[cfg(test)]
#[path = "posix_tests.rs"]
pub(crate) mod tests;
