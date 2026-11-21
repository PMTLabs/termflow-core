use super::*;
use crate::pty_manager::ssh_shell::posix::launch::encode_launch;

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
    mut ordinary: SpawnSpec,
    argv: Vec<String>,
    following: &str,
    marker: &str,
) -> Vec<u8> {
    let record = f.0.join("argv.json");
    ordinary.env.push(("TF_ARGV_RECORD".into(), record.to_str().unwrap().into()));
    ordinary.env.push(("TF_PERCENT".into(), "expanded".into()));
    let adapter = f.instrument(&ordinary);
    let mut shell = Running::start(&adapter.spec);
    let mut prompts = Prompts::new();
    prompts.until(&shell, |p| p.count >= 1);
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
    prompts.visible
}

#[test]
fn each_shell_receives_exact_argv_not_shell_code() {
    let _gate = crate::pty_host_client::test_dirs::child_process_gate();
    for dialect in matrix() {
        let f = Fixture::new();
        let spec = spec(&f, dialect, false);
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
    for (flag, expected) in [("/V:ON", "DELAYED-ON"), ("/V:OFF", "DELAYED-OFF")] {
        // Force the direct ASCII batch path, not the Unicode fallback.
        let base = std::env::temp_dir();
        let path = base.join(format!("termflow ssh argv {}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        let f = Fixture(path);
        let exe = recorder(&f);
        let exe = exe.to_str().unwrap();
        assert!(exe.is_ascii(), "native cmd fixture needs an ASCII temp path");
        let spec = ordinary(&f, &cmd, &["/D", "/Q", "/S", flag]);
        let mut argv = vec![exe.into()];
        argv.extend(table(false));
        let visible = exercise(
            &f, spec, argv,
            "if \"!TF_PERCENT!\"==\"expanded\" (echo DELAYED-ON) else (echo DELAYED-OFF)\r",
            expected,
        );
        // Verify the launcher echoes the real argv, even in a /Q profile.
        assert!(String::from_utf8_lossy(&visible).contains("%TF_PERCENT% !TF_PERCENT!"));
    }
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
