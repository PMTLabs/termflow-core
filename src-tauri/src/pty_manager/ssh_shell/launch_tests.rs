use super::*;
use crate::pty_manager::ssh_shell::posix::launch::{encode_launch, sh_typed_quote};

fn owner() -> ProcessIdentity {
    ProcessIdentity::capture(std::process::id()).unwrap()
}

fn recorder(f: &Fixture) -> PathBuf {
    compile_argv_recorder(&f.0)
}

/// Also the outer recording `ssh` of the saved-launch end-to-end test (066 T10).
/// Callers hold the child-process gate.
pub(crate) fn compile_argv_recorder(dir: &Path) -> PathBuf {
    let destination = dir.join(format!("argv recorder's binary{}", std::env::consts::EXE_SUFFIX));
    let source = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src/pty_manager/ssh_shell/argv_recorder.rs");
    let compiler = std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
    let output = std::process::Command::new(compiler)
        .args(["--edition=2021", "--crate-name", "termflow_argv_recorder"])
        .arg(source)
        .arg("-o")
        .arg(&destination)
        .output()
        .expect("required fixture compiler rustc");
    assert!(output.status.success(), "recorder compilation failed: {}", String::from_utf8_lossy(&output.stderr));
    destination
}

fn table(unicode: bool) -> Vec<String> {
    let mut args = [
        "with spaces",
        "apostrophe's",
        "double\"quote",
        r#"slash-before\"quote"#,
        "trailing\\",
        "$(touch launch-canary)",
        "`touch launch-canary`",
        "; & | < > ^ % !",
        "%TF_PERCENT% !TF_PERCENT!",
        "x\" & echo bad > launch-canary & rem \"",
        "x'; touch launch-canary; #",
        "x'; [IO.File]::WriteAllText('launch-canary','bad'); #",
        "/path/that/msys/must/not/convert",
        "",
    ].map(str::to_owned).to_vec();
    if unicode {
        args.push("日本語 — café ☃".into());
    }
    args
}

fn exercise(
    f: &Fixture,
    ordinary: SpawnSpec,
    argv: Vec<String>,
    following: &str,
    marker: &str,
) -> Vec<u8> {
    exercise_after(f, ordinary, argv, None, following, marker)
}

/// D93 oracle: what a terminal of this size shows at the end. ConPTY consumes the launch's
/// own cursor restore/erase and repaints, so the raw stream is not evidence; the screen is.
fn final_screen(visible: &[u8], rows: u16, cols: u16) -> String {
    replay(visible, rows, cols).screen().contents()
}

/// Every row the terminal ever kept, scrollback first. Each later prompt reserves rows again,
/// so earlier output legitimately scrolls off the screen; it must still exist up here.
fn history(visible: &[u8], rows: u16, cols: u16) -> Vec<String> {
    let mut parser = replay(visible, rows, cols);
    parser.screen_mut().set_scrollback(usize::MAX);
    let kept = parser.screen().scrollback();
    let mut lines = Vec::new();
    for offset in (1..=kept).rev() {
        parser.screen_mut().set_scrollback(offset);
        lines.extend(parser.screen().rows(0, cols).next());
    }
    parser.screen_mut().set_scrollback(0);
    lines.extend(parser.screen().rows(0, cols));
    lines
}

fn replay(visible: &[u8], rows: u16, cols: u16) -> vt100::Parser {
    let mut parser = vt100::Parser::new(rows, cols, 10_000);
    // vt100 ignores IND (ESC D), which the POSIX hooks write raw. IND is exactly a bare line
    // feed: down one row, same column, scrolling at the bottom (the tty's CR mapping already
    // happened upstream, so a model LF is not followed by CR).
    let mut bytes = Vec::with_capacity(visible.len());
    let mut i = 0;
    while i < visible.len() {
        if visible[i] == 0x1b && visible.get(i + 1) == Some(&b'D') { bytes.push(b'\n'); i += 2; }
        else { bytes.push(visible[i]); i += 1; }
    }
    parser.process(&bytes);
    parser
}

fn assert_launch_echo_erased(screen: &str) {
    // The last two are the cmd bootstrap: its block must never be echoed (it carries the nonce).
    for typed in ["builtin printf", "ConvertFrom-Json", "ssh-helpers-v1", "TermFlowSshReady", "endlocal"] {
        assert!(!screen.contains(typed), "typed launch text left on screen ({typed}):\n{screen}");
    }
}

/// `fill` runs first (to put the ready prompt on the bottom row) and must print FILL lines.
fn exercise_after(
    f: &Fixture,
    mut ordinary: SpawnSpec,
    argv: Vec<String>,
    fill: Option<&str>,
    following: &str,
    marker: &str,
) -> Vec<u8> {
    let (rows, cols) = (ordinary.rows, ordinary.cols);
    let record = f.0.join("argv.json");
    ordinary.env.push(("TF_ARGV_RECORD".into(), record.to_str().unwrap().into()));
    ordinary.env.push(("TF_PERCENT".into(), "expanded".into()));
    let adapter = f.instrument(&ordinary);
    let mut shell = Running::start(&adapter.spec);
    let mut prompts = Prompts::new();
    prompts.until(&shell, |p| p.count >= 1);
    if let Some(fill) = fill {
        let ready = prompts.count;
        shell.send(fill);
        prompts.until(&shell, |p| p.count > ready);
    }
    let before = prompts.count;
    let launch = encode_launch(&adapter.spec.shell, argv.clone(), &f.root(), owner()).unwrap();
    assert_eq!(launch.argv(), argv.as_slice());
    shell.send(std::str::from_utf8(launch.bytes()).unwrap());
    prompts.until(&shell, |p| p.count > before);
    let json = fs::read(&record).unwrap_or_else(|e| panic!(
        "recorder missing ({e}); PTY output: {}", String::from_utf8_lossy(&prompts.visible)
    ));
    let recorded: Vec<String> = serde_json::from_slice(&json).unwrap();
    assert_eq!(recorded.as_slice(), &argv[1..]);
    assert!(!f.0.join("launch-canary").exists(), "connection text executed in the shell");

    // A prompt boundary followed by another command in this same PTY proves
    // the launcher didn't replace or exit the interactive shell.
    let returned = prompts.count;
    thread::sleep(Duration::from_millis(75));
    shell.send(following);
    prompts.until(&shell, |p| p.count > returned && String::from_utf8_lossy(&p.visible).contains(marker));
    assert!(!f.0.join("launch-canary").exists());
    launch.finish_after_quiescence().unwrap();
    shell.send("exit 0\r");
    shell.wait_success();
    adapter.finish_after_shell_quiescence().unwrap();
    let screen = final_screen(&prompts.visible, rows, cols);
    assert_launch_echo_erased(&screen);
    let kept = history(&prompts.visible, rows, cols).join("\n");
    assert_launch_echo_erased(&kept);
    if fill.is_some() {
        // Exact count: an erase that starts above the prompt would delete on-screen FILL rows.
        let fills = kept.lines().filter(|line| line.trim_end() == "FILL").count();
        assert_eq!(fills, 30, "the erase must stop at the prompt, not wipe earlier output:\n{kept}");
    }
    prompts.visible
}

#[test]
fn each_shell_receives_exact_argv_not_shell_code() {
    let _gate = crate::pty_host_client::test_dirs::child_process_gate();
    for dialect in matrix() {
        let f = Fixture::new();
        let mut spec = spec(&f, dialect, false);
        if dialect != Dialect::Fish {
            // A GUI-launched shell can lack a UTF-8 locale (macOS sets no LANG):
            // readline then reads typed 8-bit bytes as Meta key bindings.
            spec.env.push(("LC_ALL".into(), "C".into()));
        }
        let paths = classify(&spec.shell).unwrap().1;
        let mut argv = vec![shell_path(&recorder(&f), paths).unwrap()];
        argv.extend(table(true));
        exercise(&f, spec, argv, "echo 'TF_'\"RETURNED\"\r", "TF_RETURNED");
    }
    #[cfg(windows)]
    {
        use super::windows_tests::{installed, ordinary, system32};

        for (var, path, major, minor_check) in [
            ("TERMFLOW_TEST_PWSH", PathBuf::from(std::env::var_os("ProgramFiles").unwrap()).join(r"PowerShell\7\pwsh.exe"), 7, ""),
            ("TERMFLOW_TEST_POWERSHELL", system32().join(r"WindowsPowerShell\v1.0\powershell.exe"), 5, " -and $PSVersionTable.PSVersion.Minor -eq 1"),
        ] {
            let f = Fixture::new();
            let exe = installed(var, path);
            let spec = ordinary(&f, &exe, &["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Restricted"]);
            let mut argv = vec![recorder(&f).to_str().unwrap().into()];
            argv.extend(table(true));
            let following = format!("if ($PSVersionTable.PSVersion.Major -eq {major}{minor_check} -and (Get-ExecutionPolicy) -eq 'Restricted') {{ [Console]::WriteLine('TF_' + 'RETURNED') }}\r");
            exercise(&f, spec, argv, &following, "TF_RETURNED");
        }
        let f = Fixture::new();
        let exe = installed("TERMFLOW_TEST_CMD", system32().join("cmd.exe"));
        let spec = ordinary(&f, &exe, &["/D", "/Q", "/S", "/V:ON"]);
        let mut argv = vec![recorder(&f).to_str().unwrap().into()];
        argv.extend(table(true));
        exercise(&f, spec, argv, "echo TF_RETURNED\r", "TF_RETURNED");
    }
}

#[cfg(windows)]
#[test]
fn cmd_batch_delayed_expansion_is_scoped() {
    let _gate = crate::pty_host_client::test_dirs::child_process_gate();
    use super::windows_tests::{installed, ordinary, system32};

    let cmd = installed("TERMFLOW_TEST_CMD", system32().join("cmd.exe"));
    // The last case has echo on (no /Q), like a default cmd profile: the bootstrap's FOR
    // branch must not echo its block (prompt and nonce) into the pane.
    for (flags, expected) in [
        (&["/D", "/Q", "/S", "/V:ON"][..], "DELAYED-ON"),
        (&["/D", "/Q", "/S", "/V:OFF"][..], "DELAYED-OFF"),
        (&["/D", "/S", "/V:OFF"][..], "DELAYED-OFF"),
    ] {
        // Force the direct ASCII batch path, not the Unicode fallback.
        let base = std::env::temp_dir();
        let path = base.join(format!("termflow ssh argv {}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        let f = Fixture(path);
        let exe = recorder(&f);
        let exe = exe.to_str().unwrap();
        assert!(exe.is_ascii(), "native cmd fixture needs an ASCII temp path");
        let spec = ordinary(&f, &cmd, flags);
        let mut argv = vec![exe.into()];
        argv.extend(table(false));
        let (rows, cols) = (spec.rows, spec.cols);
        let visible = exercise(
            &f, spec, argv,
            "if \"!TF_PERCENT!\"==\"expanded\" (echo DELAYED-ON) else (echo DELAYED-OFF)\r",
            expected,
        );
        // D93 quiet launch: the batch no longer displays the argv; it restores the ready
        // hook's saved cursor and erases the prompt and typed path instead.
        let screen = final_screen(&visible, rows, cols);
        assert!(!screen.contains("%TF_PERCENT% !TF_PERCENT!"), "{screen}");
        assert!(!screen.contains("helper.cmd"), "{screen}");
    }
}

#[test]
fn bourne_typed_launch_is_ascii_for_any_argv() {
    let f = Fixture::new();
    let bash = if cfg!(windows) { r"C:\Program Files\Git\bin\bash.exe" } else { "/bin/bash" };
    let exe = if cfg!(windows) { "/c/Program Files/OpenSSH/ssh.exe" } else { "/usr/bin/ssh" };
    for shell in [bash.to_string(), bash.replace("bash", "zsh")] {
        let mut argv = vec![exe.to_string()];
        argv.extend(table(true));
        argv.push("pr\u{f3}mpt's \u{2603}".into());
        let launch = encode_launch(&shell, argv, &f.root(), owner()).unwrap();
        assert!(launch.bytes().is_ascii(), "{shell}: {}", String::from_utf8_lossy(launch.bytes()));
    }
    assert_eq!(sh_typed_quote("a\u{f3}'b"), r#"'a'$'\303\263'''"'"'b'"#);
}

#[test]
fn launcher_helpers_are_attempt_payloads_retained_until_quiescent() {
    let f = Fixture::new();
    let root = f.root();
    let mut cases = vec![if cfg!(windows) {
        (r"C:\test\powershell.exe", r"C:\test\ssh.exe")
    } else {
        ("/usr/bin/pwsh", "/usr/bin/ssh")
    }];
    if cfg!(windows) {
        cases.push((r"C:\test\cmd.exe", r"C:\test\ssh.exe"));
    }
    for &(shell, exe) in &cases {
        let launch = encode_launch(shell, vec![exe.into(), "%!&".into()], &root, owner()).unwrap();
        let suffix = if shell.ends_with("cmd.exe") { "cmd" } else { "json" };
        let dir = fs::read_dir(root.path()).unwrap().flatten().find(|entry| entry.path().is_dir()).unwrap().path();
        let manifest: serde_json::Value = serde_json::from_slice(&fs::read(dir.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest["kind"], "AttemptPayload");
        assert!(dir.join("in-flight").is_file());
        launch.retire_payload().unwrap();
        assert!(dir.join(format!("helper.{suffix}")).is_file(), "cancel removed a pinned payload");
        launch.finish_after_quiescence().unwrap();
        assert!(!dir.exists());
    }

    let (shell, exe) = cases[0];
    let uncertain = encode_launch(shell, vec![exe.into()], &root, owner()).unwrap();
    uncertain.retire_payload().unwrap();
    drop(uncertain);
    let dir = fs::read_dir(root.path()).unwrap().flatten().find(|entry| entry.path().is_dir()).unwrap().path();
    assert!(dir.join("in-flight").is_file(), "drop is not evidence of quiescence");
    assert!(dir.join("helper.json").is_file());
}
/// D93: every typed launch first restores the cursor the ready hook saved at the prompt start
/// and erases to the end of the screen, before anything else runs.
#[test]
fn every_typed_launch_erases_its_echo_first() {
    let f = Fixture::new();
    let exe = if cfg!(windows) { "/c/Program Files/OpenSSH/ssh.exe" } else { "/usr/bin/ssh" };
    let bash = if cfg!(windows) { r"C:\Program Files\Git\bin\bash.exe" } else { "/bin/bash" };
    let mut shells = vec![bash.to_string(), bash.replace("bash.exe", "zsh.exe").replace("/bash", "/zsh"),
        bash.replace("bash.exe", "fish.exe").replace("/bash", "/fish")];
    if cfg!(windows) {
        shells.extend([r"C:\Program Files\PowerShell\7\pwsh.exe".to_string(),
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe".to_string()]);
    }
    for shell in shells {
        let ps = shell.ends_with("pwsh.exe") || shell.ends_with("powershell.exe");
        let argv = if ps { vec![r"C:\Windows\System32\OpenSSH\ssh.exe".to_string(), "host".into()] }
            else { vec![exe.to_string(), "host".into()] };
        let launch = encode_launch(&shell, argv, &f.root(), owner()).unwrap();
        let typed = String::from_utf8_lossy(launch.bytes()).into_owned();
        let first = if ps { "& { [Console]::Write([string][char]27 + '8' + [string][char]27 + '[1G' + [string][char]27 + '[J'); $data = " }
            else { r"builtin printf '\033%s\033[1G\033[J' 8; " };
        assert!(typed.starts_with(first), "{shell}: {typed}");
        assert!(!typed.contains("preview"), "{shell}: the launch never displays its argv");
        launch.finish_after_quiescence().unwrap();
    }
}

/// The erase target exists: each ready hook reserves rows, then saves the cursor (DECSC)
/// before it reports readiness, and the reserve is sized from the shared ECHO_MAX.
#[test]
fn ready_hooks_save_the_cursor_before_reporting_readiness() {
    use crate::pty_manager::ssh_shell::posix::ECHO_MAX;
    let posix = include_str!("posix.rs");
    for hook in ["const BASH_HOOK", "const ZSH_HOOK", "const FISH_HOOK"] {
        let body = &posix[posix.find(hook).unwrap()..];
        let body = &body[..body.find("\"#;").unwrap()];
        let save = body.find(r"A\033%s' ").unwrap_or_else(|| panic!("{hook}: no DECSC"));
        assert!(save < body.find("633;TermFlowSshReady").unwrap(), "{hook}");
        assert!(body.contains("@ECHO_MAX@"), "{hook}");
    }
    assert_eq!(ECHO_MAX, "1200");
    let windows = include_str!("windows.rs");
    assert!(windows.contains("[Math]::Ceiling(1200 /"), "PowerShell reserve uses ECHO_MAX's value");
    assert!(windows.contains("'[' + $__tfRows + 'A' + [string][char]27 + '7' + [string][char]27 + ']633;TermFlowSshReady;'"));
    assert!(windows.contains("PROMPT=@CMD_SAVE@!PROMPT!") && windows.contains(r#"const CMD_SAVE: &str = "$ED$ED$ED$ED$ED$ED$E[6A$E7";"#));
}

/// D93 case (a): the ready prompt sits on the bottom row of a narrow pane and the typed
/// launch wraps many rows. The hook's reserve keeps its saved row on screen, so the launch
/// still erases the whole echo, and only the echo: the earlier output stays.
#[test]
fn launch_echo_is_erased_from_the_bottom_row_of_a_narrow_pane() {
    let _gate = crate::pty_host_client::test_dirs::child_process_gate();
    let posix_fill = format!("printf '{}'\r", "FILL\\n".repeat(30));
    for dialect in matrix() {
        let f = Fixture::new();
        let mut spec = spec(&f, dialect, false);
        (spec.cols, spec.rows) = (60, 24);
        if dialect != Dialect::Fish {
            spec.env.push(("LC_ALL".into(), "C".into()));
        }
        let paths = classify(&spec.shell).unwrap().1;
        let mut argv = vec![shell_path(&recorder(&f), paths).unwrap()];
        argv.extend(table(true));
        exercise_after(&f, spec, argv, Some(&posix_fill), "echo 'TF_'\"RETURNED\"\r", "TF_RETURNED");
    }
    #[cfg(windows)]
    {
        use super::windows_tests::{installed, ordinary, system32};
        for (var, path) in [
            ("TERMFLOW_TEST_PWSH", PathBuf::from(std::env::var_os("ProgramFiles").unwrap()).join(r"PowerShell\7\pwsh.exe")),
            ("TERMFLOW_TEST_POWERSHELL", system32().join(r"WindowsPowerShell\v1.0\powershell.exe")),
        ] {
            let f = Fixture::new();
            let mut spec = ordinary(&f, &installed(var, path), &["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Restricted"]);
            (spec.cols, spec.rows) = (60, 24);
            let mut argv = vec![recorder(&f).to_str().unwrap().into()];
            argv.extend(table(true));
            exercise_after(&f, spec, argv, Some("1..30 | ForEach-Object { 'FILL' }\r"),
                "[Console]::WriteLine('TF_' + 'RETURNED')\r", "TF_RETURNED");
        }
        // No cmd case here: under the system ConPTY this harness uses, cmd's prompt OSC after a
        // bottom-row scroll is intermittently not delivered (reproduced with CMD_SAVE reduced to
        // a bare $E7, so not the reserve). cmd's erase is covered by
        // cmd_batch_delayed_expansion_is_scoped, and at the bottom row by the D93 live check.
    }
}
