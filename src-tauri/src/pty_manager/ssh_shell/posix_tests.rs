use super::*;
use crate::{pty_manager::ssh_shell::filter_local_output, state::{CreateAdmission, CreateMode, HostKeys, ShellStage, StagedShell}};
use portable_pty::{Child, CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use std::{fs, io::Write, path::PathBuf, sync::{mpsc, Arc, Mutex}, thread, time::{Duration, Instant}};
use termflow_pty_protocol::{da1::{StartupDa1, StartupDrain, StartupReplies}, pump::pump_output, ssh_prompt::PromptParser};

#[path = "ordinary_baseline.rs"]
mod baseline;

#[path = "launch_tests.rs"]
pub(crate) mod launch_tests;

#[cfg(windows)]
#[path = "windows_tests.rs"]
mod windows_tests;

const NONCE: &str = "0123456789abcdef0123456789abcdef";
const DEADLINE: Duration = Duration::from_secs(20);

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let temp = fs::canonicalize(std::env::temp_dir()).unwrap();
        // Windows canonical paths are verbatim (`\\?\C:\…`). A shell started in one
        // cannot resolve a relative Set-Location; a profile cwd is never verbatim.
        #[cfg(windows)]
        let temp = temp.to_str().and_then(|p| p.strip_prefix(r"\\?\")).map(PathBuf::from).unwrap_or(temp);
        let p = temp.join(format!("termflow ssh prómpt {}", uuid::Uuid::new_v4()));
        fs::create_dir(&p).unwrap();
        Self(p)
    }
    fn root(&self) -> HelperRoot { HelperRoot::open_app_data(&self.0).unwrap() }
    fn write(&self, name: &str, text: &str) {
        let path = self.0.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
    fn shell_path(&self, paths: Paths, name: &str) -> String { shell_path(&self.0.join(name), paths).unwrap() }
    fn instrument(&self, spec: &SpawnSpec) -> PosixAdapter {
        instrument_posix(spec, NONCE, &self.root(), ProcessIdentity::capture(std::process::id()).unwrap(), |_| None).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) { let _ = crate::pty_manager::ssh_helpers::remove_test_tree(&self.0); }
}

fn required_shell(dialect: Dialect) -> String {
    let (var, candidates): (&str, &[&str]) = match dialect {
        Dialect::Bash if cfg!(windows) => ("TERMFLOW_TEST_BASH", &[r"C:\Program Files\Git\bin\bash.exe", r"C:\Program Files (x86)\Git\bin\bash.exe"]),
        Dialect::Bash => ("TERMFLOW_TEST_BASH", &["/bin/bash", "/usr/bin/bash"]),
        Dialect::Zsh => ("TERMFLOW_TEST_ZSH", &["/bin/zsh", "/usr/bin/zsh"]),
        Dialect::Fish => ("TERMFLOW_TEST_FISH", &["/usr/bin/fish", "/usr/local/bin/fish"]),
    };
    if let Some(override_path) = std::env::var_os(var) {
        assert!(Path::new(&override_path).is_file(), "{var} does not name an installed executable");
        return override_path.into_string().expect("Unicode test shell path");
    }
    candidates.iter().find(|p| Path::new(**p).is_file()).map(|p| p.to_string())
        .unwrap_or_else(|| panic!("required {dialect:?} executable missing: set {var}"))
}

fn matrix() -> Vec<Dialect> {
    // Mac final pass has no fish installed; Linux/WSL is its required real fixture.
    if cfg!(windows) { vec![Dialect::Bash] }
    else if cfg!(target_os = "macos") { vec![Dialect::Bash, Dialect::Zsh] }
    else { vec![Dialect::Bash, Dialect::Zsh, Dialect::Fish] }
}

fn spec(f: &Fixture, dialect: Dialect, login: bool) -> SpawnSpec {
    spec_for(f, required_shell(dialect), dialect, login)
}

fn spec_for(f: &Fixture, shell: String, dialect: Dialect, login: bool) -> SpawnSpec {
    let paths = classify(&shell).unwrap().1;
    let home = f.shell_path(paths, "");
    let mut env: Vec<(String, String)> = vec![
        ("HOME".into(), home), ("TERM".into(), "xterm".into()),
        ("TF_LOG".into(), f.shell_path(paths, "startup.log")),
        ("XDG_CONFIG_HOME".into(), f.shell_path(paths, "config")),
        ("XDG_DATA_HOME".into(), f.shell_path(paths, "data")),
        ("XDG_STATE_HOME".into(), f.shell_path(paths, "state")),
    ];
    if dialect == Dialect::Zsh { env.push(("ZDOTDIR".into(), f.shell_path(paths, "zdot"))); }
    SpawnSpec {
        shell, args: if login { vec!["--login".into(), "-i".into()] } else { vec!["-i".into()] },
        env, env_remove: ["ENV", BASH_BOOTSTRAP, "BASH_ENV", "POSIXLY_CORRECT", "SHELLOPTS", "ZDOTDIR", "PROMPT_COMMAND"].map(str::to_string).to_vec(),
        cwd: Some(f.0.to_str().unwrap().to_string()), cols: 100, rows: 25, initial_cursor_row: None,
    }
}

struct Running {
    child: Box<dyn Child + Send + Sync>,
    _master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    output: mpsc::Receiver<Vec<u8>>,
    drain: StartupDrain,
}
impl Running {
    fn start(spec: &SpawnSpec) -> Self {
        let pair = NativePtySystem::default().openpty(PtySize { rows: spec.rows, cols: spec.cols, pixel_width: 0, pixel_height: 0 }).unwrap();
        let mut cmd = CommandBuilder::new(&spec.shell);
        cmd.args(&spec.args);
        for key in &spec.env_remove { cmd.env_remove(key); }
        for (key, value) in &spec.env { cmd.env(key, value); }
        if let Some(cwd) = &spec.cwd { cmd.cwd(cwd); }
        let child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let writer = Arc::new(Mutex::new(pair.master.take_writer().unwrap()));
        let mut replies = StartupReplies::new(writer.clone(), "real-posix-fixture".into());
        let drain = replies.drain();
        let (tx, output) = mpsc::channel();
        thread::spawn(move || {
            let mut da1 = StartupDa1::for_spawn(None);
            pump_output(&mut reader, |bytes| bytes.len(), &mut da1,
                |reply| replies.send(reply), |bytes| { let _ = tx.send(bytes); });
        });
        Self { child, _master: pair.master, writer, output, drain }
    }
    fn send(&self, text: &str) {
        let mut writer = self.writer.lock().unwrap();
        writer.write_all(text.as_bytes()).unwrap();
        writer.flush().unwrap();
    }
    fn wait_success(&mut self) {
        let until = Instant::now() + DEADLINE;
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(status.success(), "fixture shell exited unsuccessfully: {status:?}");
                return;
            }
            assert!(Instant::now() < until, "fixture shell failed to exit");
            thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for Running {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) { let _ = self.child.kill(); }
    }
}

const LEAF: &str = "tm-posix-fixture";
const PC: &str = "pc-posix-fixture";
struct Prompts {
    keys: HostKeys,
    parser: Option<PromptParser>,
    count: usize,
    visible: Vec<u8>,
}
impl Prompts {
    fn new() -> Self {
        let keys = HostKeys::default();
        let CreateAdmission::Run(cg) = keys.admit_create(LEAF, CreateMode::Mount).unwrap() else { panic!("fresh fixture") };
        keys.stage_shell(LEAF, cg, PC, None).unwrap();
        keys.register_ssh_prompt(PC, cg, NONCE).unwrap();
        keys.complete_shell(LEAF, cg, &StagedShell { process: PC.into(), stage: ShellStage::Local });
        Self { keys, parser: Some(PromptParser::new(NONCE.into())), count: 0, visible: Vec::new() }
    }
    fn feed(&mut self, shell: &Running, bytes: Vec<u8>) {
        let count = &mut self.count;
        self.visible.extend(filter_local_output(&mut self.parser, &self.keys, PC, Some(&shell.drain), bytes, |_| *count += 1));
    }
    fn until(&mut self, shell: &Running, ready: impl Fn(&Self) -> bool) {
        let deadline = Instant::now() + DEADLINE;
        while !ready(self) {
            let bytes = shell.output.recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap_or_else(|e| panic!("timed out awaiting a shell event ({e}): {}", String::from_utf8_lossy(&self.visible)));
            self.feed(shell, bytes);
        }
    }
    fn stays_blocked(&mut self, shell: &Running) {
        let until = Instant::now() + Duration::from_millis(250);
        loop {
            match shell.output.recv_timeout(until.saturating_duration_since(Instant::now())) {
                Ok(bytes) => self.feed(shell, bytes),
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(e) => panic!("fixture exited before release: {e}"),
            }
            assert_eq!(self.count, 0, "rc has not returned yet");
            if Instant::now() >= until { break; }
        }
        assert_eq!(self.count, 0);
    }
}

#[test]
fn ordinary_spawn_spec_is_unchanged() {
    use crate::pty_manager::{spawn::build_local_shell_command, spawn_spec::{build_spawn_spec_with, shell_emits_prompt_osc}};
    // Frozen profile-kind matrix, independent of what is installed on this machine.
    let profiles: &[(_, _, &[&str])] = &[
        (Some(r"C:\Program Files\PowerShell\7\pwsh.exe"), "PowerShell 7", &[]),
        (Some(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"), "Windows PowerShell", &[]),
        (Some("pwsh"), "PowerShell (PATH)", &["-Command", "custom"]),
        (Some("cmd.exe"), "Command Prompt", &[]),
        (Some("cmd.exe"), "Command Prompt with flags", &["/D", "/V:ON", "/Q"]),
        (Some(r"C:\Program Files\Git\bin\bash.exe"), "Git Bash", &["--login", "-i"]),
        (Some(r"C:\cygwin64\bin\bash.exe"), "Cygwin", &["--login", "-i"]),
        (Some("wsl.exe"), "WSL", &["-d", "Test distro"]),
        (Some("/bin/bash"), "Bash", &["--login"]),
        (Some("/bin/zsh"), "Zsh", &["--login"]),
        (Some("/usr/bin/fish"), "Fish", &["--login"]),
        (Some("/opt/custom shell"), "Custom", &["-c", "own command"]),
        (None, "Default shell", &[]),
        (None, "PowerShell by display name", &["-NoProfile"]),
    ];
    let cwd = std::env::current_dir().unwrap();
    let lookup = |k: &str| match k {
        "http_proxy" => Some("http://proxy.test.invalid".into()),
        "no_proxy" | "NO_PROXY" => Some("example.test,localhost".into()),
        _ => None,
    };
    for &(path, name, args) in profiles {
        let args = args.iter().map(|v| v.to_string()).collect::<Vec<_>>();
        for exempt in [false, true] {
            for dir in [None, Some(""), cwd.to_str(), Some("~/.__termflow_nonexistent_cwd__")] {
                let args = Some(args.as_slice());
                let actual = build_spawn_spec_with("pc-ordinary", Some("tm-ordinary"), path, name, args, dir, 97, 31, exempt, lookup);
                let expected = baseline::hosted("pc-ordinary", Some("tm-ordinary"), path, name, args, dir, 97, 31, exempt, lookup);
                assert_eq!(actual, expected, "hosted {name}");
                assert_eq!(shell_emits_prompt_osc(path, name, args), baseline::shell_emits_prompt_osc(path, name, args));
                let (actual, hook) = build_local_shell_command("pc-ordinary", "tm-ordinary", path.map(str::to_string), name, args.map(<[String]>::to_vec), dir.map(str::to_string), exempt, lookup);
                let (expected, golden_hook) = baseline::local("pc-ordinary", "tm-ordinary", path.map(str::to_string), name, args.map(<[String]>::to_vec), dir.map(str::to_string), exempt, lookup);
                assert_eq!(actual.get_argv(), expected.get_argv(), "local argv {name}");
                assert_eq!(actual.get_cwd(), expected.get_cwd(), "local cwd {name}");
                assert_eq!(actual.iter_full_env_as_str().collect::<Vec<_>>(), expected.iter_full_env_as_str().collect::<Vec<_>>(), "local env {name}");
                for (key, _) in std::env::vars_os() {
                    assert_eq!(actual.get_env(&key), expected.get_env(&key), "local inherited env {name}: {key:?}");
                }
                assert_eq!(hook, golden_hook, "local prompt flag {name}");
            }
        }
    }
}

fn log_line(name: &str) -> String { format!("printf '%s\\n' {name} >> \"$TF_LOG\"\n") }

#[test]
fn login_rc_files_run_in_original_order_once() {
    let _gate = crate::pty_host_client::test_dirs::child_process_gate();
    for dialect in matrix() {
        for login in [false, true] {
            let f = Fixture::new();
            let mut ordinary = spec(&f, dialect, login);
            let paths = classify(&ordinary.shell).unwrap().1;
            let expected: &[&str] = match (dialect, login) {
                (Dialect::Bash, false) => {
                    f.write("custom rc", &log_line("custom"));
                    ordinary.args.splice(..0, ["--rcfile".into(), f.shell_path(paths, "custom rc")]);
                    &["custom", "bash-prompt"]
                }
                (Dialect::Bash, true) => &["bash-profile", "bashrc", "bash-prompt"],
                (Dialect::Zsh, false) => &["zshenv", "zshrc", "user-precmd"],
                (Dialect::Zsh, true) => &["zshenv", "zprofile", "zshrc", "zlogin", "user-precmd"],
                (Dialect::Fish, _) => {
                    ordinary.args.extend(["--init-command".into(), log_line("fish-user-init")]);
                    &["fish-config", "fish-user-init"]
                }
            };
            if dialect == Dialect::Bash {
                // Exercise a real array on bash 5.1+, strings on the older bash (e.g. macOS 3.2).
                let prompt = format!("if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )); then\nPROMPT_COMMAND=( {})\nelse\nPROMPT_COMMAND=__fixture_user_prompt\nfi\n", "__fixture_user_prompt");
                let hook = format!("__fixture_user_prompt() {{\n{}}}\n{prompt}", log_line("bash-prompt"));
                f.write(".bashrc", &(log_line("bashrc") + &hook));
                f.write("custom rc", &(log_line("custom") + &hook));
                f.write(".bash_profile", &(log_line("bash-profile") + "shopt -q login_shell || exit 91\n[[ ! -o posix ]] || exit 92\nsource \"$HOME/.bashrc\"\n"));
                f.write(".bash_login", &log_line("must-not-source-bash-login"));
                f.write(".profile", &log_line("must-not-source-profile"));
            }
            if dialect == Dialect::Zsh {
                for phase in ["zshenv", "zprofile", "zshrc", "zlogin"] {
                    let mut script = log_line(phase);
                    if phase == "zshrc" {
                        script.push_str(&format!("__fixture_precmd() {{\n{}}}\nprecmd_functions+=(__fixture_precmd)\n", log_line("user-precmd")));
                    }
                    f.write(&format!("zdot/.{phase}"), &script);
                }
            }
            if dialect == Dialect::Fish { f.write("config/fish/config.fish", &log_line("fish-config")); }
            let mut normal = Running::start(&ordinary);
            normal.send("exit\r");
            normal.wait_success();
            drop(normal);
            let plain = fs::read_to_string(f.0.join("startup.log")).unwrap();
            assert_eq!(plain.lines().collect::<Vec<_>>(), expected, "baseline {dialect:?} login={login}");
            fs::remove_file(f.0.join("startup.log")).unwrap();
            let adapter = f.instrument(&ordinary);
            let mut hooked = Running::start(&adapter.spec);
            let mut prompts = Prompts::new();
            prompts.until(&hooked, |p| p.count > 0);
            assert_eq!(fs::read_to_string(f.0.join("startup.log")).unwrap(), plain, "must reach marker after user startup and prompt hooks");
            hooked.send("exit\r");
            hooked.wait_success();
            assert_eq!(fs::read_to_string(f.0.join("startup.log")).unwrap(), plain);
            adapter.finish_after_shell_quiescence().unwrap();
        }
    }
}

#[test]
fn slow_rc_cannot_receive_launch_before_real_prompt() {
    let _gate = crate::pty_host_client::test_dirs::child_process_gate();
    let f = Fixture::new();
    let ordinary = spec(&f, Dialect::Bash, false);
    let path = f.shell_path(classify(&ordinary.shell).unwrap().1, "release");
    f.write(".bashrc", &format!("printf 'FIXTURE_RC_WAITING\\n'\nwhile [ ! -f {} ]; do sleep 0.1; done\n", sh_quote(&path)));
    let adapter = f.instrument(&ordinary);
    let mut shell = Running::start(&adapter.spec);
    let mut prompts = Prompts::new();
    prompts.until(&shell, |p| String::from_utf8_lossy(&p.visible).contains("FIXTURE_RC_WAITING"));
    prompts.stays_blocked(&shell);
    f.write("release", "go");
    prompts.until(&shell, |p| p.count == 1);
    shell.send(":\r");
    prompts.until(&shell, |p| p.count == 2); // the same hook survives subsequent prompts
    shell.send("exit\r");
    shell.wait_success();
    adapter.finish_after_shell_quiescence().unwrap();
}

#[test]
fn rc_foreground_program_blocks_until_it_returns() {
    let _gate = crate::pty_host_client::test_dirs::child_process_gate();
    let f = Fixture::new();
    let ordinary = spec(&f, Dialect::Bash, false);
    f.write(".bashrc", "/bin/sh -c 'printf \"FIXTURE_CHILD_RUNNING\\n\"; IFS= read -r gate; [ \"$gate\" = release ]'\n");
    let adapter = f.instrument(&ordinary);
    let mut shell = Running::start(&adapter.spec);
    let mut prompts = Prompts::new();
    prompts.until(&shell, |p| String::from_utf8_lossy(&p.visible).contains("FIXTURE_CHILD_RUNNING"));
    prompts.stays_blocked(&shell);
    shell.send("release\r");
    prompts.until(&shell, |p| p.count == 1);
    shell.send("exit\r");
    shell.wait_success();
    adapter.finish_after_shell_quiescence().unwrap();
}

/// zsh's compinit stops on "insecure directories ... [y]/[n]?" when an fpath
/// directory is group/world-writable (Ubuntu's global zshrc runs compinit). That
/// question must hold the gate like any rc foreground read, and no directory the
/// helpers create may be one compaudit refuses.
#[cfg(unix)]
#[test]
fn zsh_compinit_question_holds_the_gate_and_helper_dirs_pass_compaudit() {
    use std::os::unix::fs::PermissionsExt;
    fn dirs_below(dir: &Path, skip: &Path, out: &mut Vec<PathBuf>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() && !path.is_symlink() && path != skip {
                out.push(path.clone());
                dirs_below(&path, skip, out);
            }
        }
    }
    let _gate = crate::pty_host_client::test_dirs::child_process_gate();
    for login in [false, true] {
        let f = Fixture::new();
        let ordinary = spec(&f, Dialect::Zsh, login);
        let paths = classify(&ordinary.shell).unwrap().1;
        let insecure = f.0.join("insecure fpath");
        fs::create_dir(&insecure).unwrap();
        fs::set_permissions(&insecure, fs::Permissions::from_mode(0o777)).unwrap();
        f.write("zdot/.zshrc", &format!("fpath=({} $fpath)\nautoload -Uz compinit\ncompinit -d {}\n",
            sh_quote(&f.shell_path(paths, "insecure fpath")), sh_quote(&f.shell_path(paths, "zcompdump"))));
        let compaudit = |dirs: &[PathBuf]| std::process::Command::new(&ordinary.shell)
            .args(["-fc", "autoload -Uz compaudit; compaudit \"$@\"", "compaudit"]).args(dirs).output().unwrap();
        assert!(!compaudit(&[insecure.clone()]).status.success(), "compaudit must refuse the planted directory");

        let adapter = f.instrument(&ordinary);
        let mut shell = Running::start(&adapter.spec);
        let mut prompts = Prompts::new();
        prompts.until(&shell, |p| String::from_utf8_lossy(&p.visible).contains("insecure directories"));
        prompts.stays_blocked(&shell);

        // Every directory under the app-data root, helper ZDOTDIRs included. The
        // root's own parent is the test temp dir, which is not ours.
        let mut dirs = Vec::new();
        dirs_below(&f.0, &insecure, &mut dirs);
        // The adapter appends its ZDOTDIR after the user's; the last entry is the one the child gets.
        let helper = adapter.spec.env.iter().rfind(|(k, _)| k == "ZDOTDIR").map(|(_, v)| PathBuf::from(v)).unwrap();
        assert_ne!(helper, f.0.join("zdot"), "found the user's ZDOTDIR, not the helper's");
        assert!(dirs.contains(&helper), "audit covers the helper ZDOTDIR {helper:?}");
        let audit = compaudit(&dirs);
        assert!(audit.status.success(), "login={login} helper dirs refused by compaudit: {}{}",
            String::from_utf8_lossy(&audit.stdout), String::from_utf8_lossy(&audit.stderr));

        shell.send("y"); // compinit reads one key
        prompts.until(&shell, |p| p.count == 1);
        shell.send("exit\r");
        shell.wait_success();
        adapter.finish_after_shell_quiescence().unwrap();
    }
}

#[test]
fn nonce_is_not_exported_to_child_processes() {
    let _gate = crate::pty_host_client::test_dirs::child_process_gate();
    for dialect in matrix() {
        let f = Fixture::new();
        let ordinary = spec(&f, dialect, true);
        if dialect == Dialect::Bash { f.write(".bash_profile", "set -a\n"); }
        let paths = classify(&ordinary.shell).unwrap().1;
        let adapter = f.instrument(&ordinary);
        assert!(!adapter.spec.args.iter().any(|a| a.contains(NONCE)));
        assert!(!adapter.spec.env.iter().any(|(k, v)| k.contains(NONCE) || v.contains(NONCE)));
        let mut shell = Running::start(&adapter.spec);
        Prompts::new().until(&shell, |p| p.count == 1);
        let output = f.shell_path(paths, "child.env");
        // Typed into the line editor, so keep it ASCII like the real launch encoder.
        let quoted = if dialect == Dialect::Fish { fish_quote(&output) } else { launch::sh_typed_quote(&output) };
        shell.send(&format!("command env > {quoted}; exit\r"));
        shell.wait_success();
        let captured = fs::read_to_string(f.0.join("child.env")).unwrap();
        assert!(captured.lines().any(|line| line.starts_with("TF_LOG=")), "external env actually ran");
        assert!(!captured.contains(NONCE), "{dialect:?} exported nonce");
        assert!(!captured.contains(BASH_BOOTSTRAP));
        if dialect == Dialect::Zsh {
            assert!(captured.lines().any(|line| line.trim_end_matches('\r') == format!("ZDOTDIR={}", f.shell_path(paths, "zdot"))));
        }
        adapter.finish_after_shell_quiescence().unwrap();
    }
}

#[test]
fn msys_and_cygwin_helper_paths_are_converted() {
    let path = Path::new(r"C:\Users\Joséphine Doe\hook.sh");
    assert_eq!(shell_path(path, Paths::Msys).unwrap(), "/c/Users/Joséphine Doe/hook.sh");
    assert_eq!(shell_path(path, Paths::Cygwin).unwrap(), "/cygdrive/c/Users/Joséphine Doe/hook.sh");
    assert_eq!(shell_path(Path::new(r"\\?\D:\term flow\hook.sh"), Paths::Msys).unwrap(), "/d/term flow/hook.sh");
    assert!(shell_path(Path::new(r"\\server\share\hook.sh"), Paths::Cygwin).is_err());
}

#[test]
fn unsupported_posix_profile_flags_report_adapter_error() {
    let f = Fixture::new();
    let root = f.root();
    let owner = ProcessIdentity::capture(std::process::id()).unwrap();
    for (dialect, name) in [(Dialect::Bash, "bash"), (Dialect::Zsh, "zsh"), (Dialect::Fish, "fish")] {
        let shell = if cfg!(windows) { format!(r"C:\msys64\usr\bin\{name}.exe") } else { format!("/fixture/{name}") };
        for flags in [&["-c", "exit"][..], &["-ilc", "exit"], &["--command=exit"], &["user-script.sh"]] {
            let mut ordinary = spec_for(&f, shell.clone(), dialect, false);
            ordinary.args.extend(flags.iter().map(|s| s.to_string()));
            let before = ordinary.clone();
            let result = instrument_posix(&ordinary, NONCE, &root, owner.clone(), |_| None);
            assert!(matches!(result, Err(e) if e.kind() == io::ErrorKind::InvalidInput));
            assert_eq!(ordinary, before);
        }
    }
    let mut unknown = spec_for(&f, if cfg!(windows) { r"C:\msys64\bin\bash.exe".into() } else { "/fixture/bash".into() }, Dialect::Bash, false);
    unknown.shell.push_str("-unknown");
    assert!(instrument_posix(&unknown, NONCE, &root, owner, |_| None).is_err());
}
