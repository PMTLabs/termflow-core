use super::*;
use crate::pty_manager::spawn_spec::{build_spawn_spec_with, PS_CWD_INTEGRATION};

pub(super) fn installed(var: &str, path: PathBuf) -> String {
    let path = std::env::var_os(var).map(PathBuf::from).unwrap_or(path);
    assert!(path.is_absolute() && path.is_file(), "required Windows shell missing: set {var} ({path:?})");
    path.into_os_string().into_string().expect("Unicode shell path")
}

pub(super) fn system32() -> PathBuf {
    PathBuf::from(std::env::var_os("SystemRoot").expect("SystemRoot")).join("System32")
}

pub(super) fn ordinary(f: &Fixture, shell: &str, args: &[&str]) -> SpawnSpec {
    let args = args.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    build_spawn_spec_with(PC, Some(LEAF), Some(shell), "fixture", Some(&args),
        f.0.to_str(), 120, 32, false, |_| None)
}

fn visible_has(p: &Prompts, text: &str) -> bool {
    String::from_utf8_lossy(&p.visible).contains(text)
}

#[test]
fn powershell_original_prompt_and_cwd_hook_survive() {
    let _gate = crate::pty_host_client::test_dirs::child_process_gate();
    assert_powershell_prompt_and_cwd(false);
}

#[test]
fn powershell_readiness_works_under_restricted_execution_policy() {
    let _gate = crate::pty_host_client::test_dirs::child_process_gate();
    assert_powershell_prompt_and_cwd(true);
}

#[test]
fn ssh_powershell_command_never_contains_nonce() {
    let f = Fixture::new();
    let ordinary = ordinary(&f, r"C:\fixture\powershell.exe", &["-NoProfile"]);
    let adapter = f.instrument(&ordinary);
    assert_eq!(adapter.spec.args[adapter.spec.args.len() - 2], "-Command");
    assert!(!adapter.spec.args.iter().any(|arg| arg.contains(NONCE)));
    assert!(!adapter.spec.env.iter().any(|(_, value)| value.contains(NONCE)));
    adapter.finish_after_shell_quiescence().unwrap();
}

fn assert_powershell_prompt_and_cwd(restricted: bool) {
    let pwsh = PathBuf::from(std::env::var_os("ProgramFiles").expect("ProgramFiles"))
        .join(r"PowerShell\7\pwsh.exe");
    for (var, exe, version) in [
        ("TERMFLOW_TEST_PWSH", pwsh, "7."),
        ("TERMFLOW_TEST_POWERSHELL", system32().join(r"WindowsPowerShell\v1.0\powershell.exe"), "5.1."),
    ] {
        let f = Fixture::new();
        fs::create_dir(f.0.join("new cwd")).unwrap();
        let mut flags = vec!["-NoLogo", "-NoProfile"];
        if restricted {
            flags.extend(["-ExecutionPolicy", "Restricted"]);
        }
        let mut ordinary = ordinary(&f, &installed(var, exe), &flags);
        ordinary.env.push(("TF_FIXTURE_RELEASE".into(), f.0.join("release").to_str().unwrap().into()));
        assert_eq!(ordinary.args.last().map(String::as_str), Some(PS_CWD_INTEGRATION));
        let adapter = f.instrument(&ordinary);
        let mut spec = adapter.spec.clone();
        // Simulate profile effects in inline text, without sourcing a script or
        // touching installed profiles. The production hook follows unchanged.
        let command = spec.args.last_mut().unwrap();
        let policy_check = if restricted {
            "if ((Get-ExecutionPolicy) -ne 'Restricted') { throw 'Expected Restricted' }; "
        } else { "" };
        *command = format!("{policy_check}Set-Location -LiteralPath 'new cwd'; \
            function prompt {{ 'FIXTURE_PS> ' }}; \
            [Console]::WriteLine('FIXTURE_PROFILE_' + $PSVersionTable.PSVersion); \
            while (-not [IO.File]::Exists($env:TF_FIXTURE_RELEASE)) {{ Start-Sleep -Milliseconds 50 }}; {command}");
        let mut shell = Running::start(&spec);
        let mut prompts = Prompts::new();
        prompts.until(&shell, |p| visible_has(p, &format!("FIXTURE_PROFILE_{version}")));
        prompts.stays_blocked(&shell);
        f.write("release", "go");
        prompts.until(&shell, |p| p.count >= 1 && visible_has(p, "FIXTURE_PS>"));
        assert_eq!(prompts.count, 1);
        let cwd = crate::pty_manager::parse_osc_cwd(&prompts.visible).expect("missing cwd OSC");
        let expected = f.0.join("new cwd");
        let normalize = |value: &str| value.trim_start_matches(r"\\?\").to_ascii_lowercase();
        assert_eq!(normalize(&cwd), normalize(expected.to_str().unwrap()));
        shell.send("[Console]::WriteLine('SECOND_' + 'COMMAND')\r");
        prompts.until(&shell, |p| p.count >= 2 && visible_has(p, "SECOND_COMMAND"));
        assert_eq!(prompts.count, 2);
        shell.send("exit\r");
        shell.wait_success();
        adapter.finish_after_shell_quiescence().unwrap();
    }
}

/// Native cmd AutoRun ordering not executed (registry-only); covered by a /D /K prelude substitute.
#[test]
fn cmd_prompt_and_prelude_survive() {
    let _gate = crate::pty_host_client::test_dirs::child_process_gate();
    let cmd = installed("TERMFLOW_TEST_CMD", system32().join("cmd.exe"));
    for delayed in ["/V:OFF", "/V:ON"] {
        let f = Fixture::new();
        let mut ordinary = ordinary(&f, &cmd, &["/D", "/S", "/Q", delayed]);
        ordinary.env.push(("PROMPT".into(), "FIXTURE_CMD$G$S".into()));
        let adapter = f.instrument(&ordinary);
        let mut spec = adapter.spec.clone();
        // Same cmd session and same bootstrap as production. Substituting the
        // /K prelude for native AutoRun avoids any dependency on the registry.
        let command = spec.args.last_mut().unwrap();
        *command = format!("set TF_PRELUDE=ran&echo FIXTURE_PRELUDE_RAN&{command}");
        let mut shell = Running::start(&spec);
        let mut prompts = Prompts::new();
        prompts.until(&shell, |p| p.count >= 1 && visible_has(p, "FIXTURE_CMD> "));
        assert_eq!(prompts.count, 1);
        let visible = String::from_utf8_lossy(&prompts.visible);
        assert!(visible.find("FIXTURE_PRELUDE_RAN").unwrap() < visible.find("FIXTURE_CMD> ").unwrap());
        // Keep the real-shell fixture out of the known same-centisecond case.
        // Duplicate rejection itself is covered deterministically in ssh_shell tests.
        thread::sleep(Duration::from_millis(100));
        shell.send("echo PRELUDE_VALUE=%TF_PRELUDE%\r");
        prompts.until(&shell, |p| p.count >= 2 && visible_has(p, "PRELUDE_VALUE=ran"));
        assert_eq!(prompts.count, 2);
        let visible = String::from_utf8_lossy(&prompts.visible);
        assert_eq!(visible.matches("FIXTURE_PRELUDE_RAN").count(), 1);
        assert_eq!(visible.matches("FIXTURE_CMD> ").count(), 2);
        shell.send("exit\r");
        shell.wait_success();
        adapter.finish_after_shell_quiescence().unwrap();
    }
}

#[test]
fn cmd_adapter_does_not_add_disable_autorun() {
    let f = Fixture::new();
    let ordinary = ordinary(&f, r"C:\Windows\System32\cmd.exe", &["/Q", "/V:ON"]);
    let adapter = f.instrument(&ordinary);
    assert!(adapter.spec.args.starts_with(&ordinary.args));
    assert!(!adapter.spec.args.iter().any(|arg| arg.eq_ignore_ascii_case("/D")));
    adapter.finish_after_shell_quiescence().unwrap();
}

#[test]
fn powershell_conflicting_command_flags_report_adapter_error() {
    let f = Fixture::new();
    let root = f.root();
    let owner = ProcessIdentity::capture(std::process::id()).unwrap();
    for shell in [r"C:\fixture\pwsh.exe", r"C:\fixture\powershell.exe"] {
        for flag in ["-Command", "-EncodedCommand", "-File", "-c", "-enc", "-f"] {
            let ordinary = ordinary(&f, shell, &[flag, "fixture"]);
            let before = ordinary.clone();
            let result = instrument_posix(&ordinary, NONCE, &root, owner.clone(), |_| None);
            assert!(matches!(result, Err(e) if e.kind() == io::ErrorKind::InvalidInput
                && e.to_string().contains("PowerShell -Command, -EncodedCommand or -File")), "{flag}");
            assert_eq!(ordinary, before);
        }
    }
}
