use super::*;
use crate::pty_manager::ssh_helpers::HelperRoot;
use crate::state::{CreateAdmission, CreateMode, StageMode};
use crate::state::source_scan::{fn_body, production};
use termflow_pty_protocol::{ssh_prompt::HOST_REGISTRATION_ENV, SpawnSpec};

const LEAF: &str = "tm-ssh-create";
const PROCESS: &str = "pc-ssh-create";
const CONNECTION: &str = "saved-connection";

struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::fs::canonicalize(std::env::temp_dir()).unwrap()
            .join(format!("termflow-cp3d-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) { let _ = crate::pty_manager::ssh_helpers::remove_test_tree(&self.0); }
}

fn shell_spec(shell: &str, args: &[String]) -> SpawnSpec {
    crate::pty_manager::build_spawn_spec("test-key", Some(LEAF), Some(shell), "profile", Some(args), None, 80, 24, false)
}

// Model the next effect as a recording PTY, so a guard mutated to succeed
// cannot spawn WSL or run a custom command during this test.
#[derive(Default)]
struct PlacementProbe {
    created: Vec<SpawnSpec>,
    stdin: Vec<u8>,
}
impl PlacementProbe {
    fn create(&mut self, id: Option<&str>, shell: &str, args: &[String]) -> Result<(), String> {
        let supported = validate_create(id, Some(shell), Some(args))?;
        self.created.push(shell_spec(supported.as_deref().unwrap_or(shell), args));
        Ok(())
    }
}

fn assert_preflight_wiring() {
    let terminal = production(include_str!("../../commands/terminal.rs"));
    let legacy = fn_body(&terminal, "fn create_terminal(");
    let routed = fn_body(&terminal, "fn run_create(");
    // The needle omits the call's `(`: a call-shaped literal would itself be counted
    // as an unrouted spawn site by the api_spawn_routing census.
    assert!(legacy.find("ssh_shell::validate_create(").unwrap() < legacy.find("pty_manager::spawn_terminal").unwrap());
    for effect in ["ensure_elevated_host()", "place_process_create(", "host_fallback(", "PreparedShell::register(", "spawn_owned("] {
        assert!(routed.find("ssh_shell::validate_create(").unwrap() < routed.find(effect).unwrap(), "before {effect}");
    }
    for body in [&legacy, &routed] {
        assert!(!body.contains("ssh_sessions") && !body.contains("ssh_session_open") && !body.contains("write_input"));
        let tail = body.split("validate_create(").nth(1).unwrap();
        assert!(tail.split(';').next().unwrap().ends_with(")?"));
    }
}

#[test]
fn wsl_default_refused_before_session_or_terminal_bytes() {
    let fixture = Fixture::new();
    let mut probe = PlacementProbe::default();
    let args = ["-d".into(), "Ubuntu".into()];
    assert_eq!(probe.create(Some(CONNECTION), "wsl.exe", &args).unwrap_err(),
        "SSH connections launch in a native shell; WSL default profile not supported yet");
    assert!(probe.created.is_empty() && probe.stdin.is_empty());
    assert_eq!(std::fs::read_dir(&fixture.0).unwrap().count(), 0);
    assert_preflight_wiring();
    probe.create(None, "wsl.exe", &args).unwrap();
    assert_eq!(probe.created.len(), 1);
    assert_eq!(probe.created[0].shell, "wsl.exe");
    assert_eq!(probe.created[0].args.as_slice(), &args);
    assert!(!probe.created[0].env.iter().any(|(key, _)| key == HOST_REGISTRATION_ENV));
}

#[test]
fn unsupported_profile_reports_error_without_typing() {
    let fixture = Fixture::new();
    let ps = if cfg!(windows) { r"C:\Profiles\pwsh.exe" } else { "/opt/profiles/pwsh" };
    for (shell, args, expected) in [
        ("some-custom-shell", vec![], "supported interactive shell executable"),
        (ps, vec!["-File".into(), "custom.ps1".into()], "cannot compose with PowerShell"),
    ] {
        let mut probe = PlacementProbe::default();
        let error = probe.create(Some(CONNECTION), shell, &args).unwrap_err();
        assert!(error.starts_with("SSH readiness adapter:"), "{error}");
        assert!(error.contains(expected), "{error}");
        assert!(probe.created.is_empty() && probe.stdin.is_empty());
        assert_eq!(std::fs::read_dir(&fixture.0).unwrap().count(), 0);
        probe.create(None, shell, &args).unwrap();
        assert_eq!(probe.created[0].shell, shell);
        assert_eq!(probe.created[0].args, args);
    }
    assert_preflight_wiring();
}

#[cfg(windows)]
#[test]
fn built_in_windows_shell_names_resolve_without_path_lookup() {
    for exe in ["cmd.exe", "powershell.exe"] {
        let path = validate_create(Some(CONNECTION), Some(exe), None).unwrap().unwrap();
        assert!(std::path::Path::new(&path).is_absolute());
        assert!(path.ends_with(exe));
        assert_eq!(validate_create(None, Some(exe), None).unwrap(), None);
    }
}

#[test]
fn legacy_and_admitted_create_both_carry_same_launch_metadata() {
    let terminal = production(include_str!("../../commands/terminal.rs"));
    let legacy = fn_body(&terminal, "fn create_terminal(");
    assert!(legacy.contains("ssh_launch_connection_id,"));
    assert!(legacy.contains("ssh_launch_connection_id.as_deref(),"));
    let admitted = production(include_str!("../../commands/panes.rs"));
    assert!(fn_body(&admitted, "fn create_admitted_terminal(")
        .contains("ssh_launch_connection_id: request.ssh_launch_connection_id,"));
    let routed = fn_body(&terminal, "fn run_create(");
    assert!(routed.contains("let ssh_opt_in = ssh_launch_connection_id.is_some();"));
    let preflight = routed.find("require_host_registration(ssh_opt_in, client.ssh_prompt_registration())?").unwrap();
    let registration = routed.find("PreparedShell::register(").unwrap();
    assert!(preflight < registration && registration < routed.find("spawn_owned(").unwrap());
    let local = production(include_str!("../spawn.rs"));
    let local = fn_body(&local, "fn spawn_terminal(");
    assert!(local.find("PreparedShell::register(").unwrap() < local.find("open_pty(").unwrap());
    assert!(fn_body(&terminal, "fn host_fallback(").contains("ssh_launch_connection_id,"));
    assert!(routed.contains("if let Some(connection_id) = ssh_launch_connection_id.as_deref()"));
    assert!(routed.contains("&mut spec, true, connection_id)"));
    assert!(local.contains("&mut spec, false, connection_id)"));
    assert!(local.find("ssh_prompt_nonce(").unwrap() < local.find("thread::spawn(").unwrap());

    for hosted in [false, true] {
        let keys = HostKeys::default();
        let CreateAdmission::Run(cg) = keys.admit_create(LEAF, CreateMode::Mount).unwrap() else { panic!("create") };
        let channel = HostChannel::Primary;
        if hosted { keys.connect_fixture(channel, 1); }
        let placement = hosted.then_some((channel, "host-key", StageMode::Spawn));
        let (stage, _, _) = keys.stage_shell(LEAF, cg, PROCESS, placement).unwrap();
        if let Some(stage) = stage { assert!(keys.publish(&stage, PROCESS, 1)); }

        let shell = if cfg!(windows) { r"C:\Program Files\Git\bin\bash.exe" } else { "/bin/bash" };
        let mut spec = shell_spec(shell, &[]);
        let fixture = Fixture::new();
        let root = HelperRoot::open_app_data(&fixture.0).unwrap();
        let prepared = PreparedShell::register_in(&root, &keys, PROCESS, cg, &mut spec, hosted, "saved-id", |_| None).unwrap();
        assert_eq!(spec.args[0], "--rcfile");
        assert_eq!(keys.ssh_launch_connection(PROCESS).as_deref(), Some("saved-id"));
        let nonce = keys.ssh_prompt_nonce(PROCESS).expect("registered before launch");
        let entry = spec.env.iter().find(|(key, _)| key == HOST_REGISTRATION_ENV);
        assert_eq!(entry.map(|(_, value)| value.as_str()), hosted.then_some(nonce.as_str()));
        assert!(!spec.args.iter().any(|arg| arg.contains(nonce.as_str())));
        drop(prepared); // never submitted
    }
}

#[test]
fn api_and_fleet_spawn_requests_have_no_ssh_launch_metadata() {
    for (src, name) in [
        (include_str!("../../api_server/terminals/mod.rs"), "fn create_terminal("),
        (include_str!("../../api_server/fleet.rs"), "fn fleet_local_run("),
    ] {
        let src = production(src);
        let create = fn_body(&src, name);
        let request = create.split("SpawnRequest {").nth(1).expect("production spawn request");
        assert!(request.split('}').next().unwrap().contains("ssh_launch_connection_id: None,"));
    }
}

/// A first-run app-data dir can be deep enough that the helper root's own lock
/// stage, entry and hook paths pass MAX_PATH. Registration must still work for
/// every Windows profile kind (the adapter never resolves the shell itself, so
/// the Store pwsh alias spelling needs no install).
#[cfg(windows)]
#[test]
fn deep_first_run_app_data_registers_every_windows_shell() {
    let base = std::env::temp_dir().join(format!("tf-deep-{}", uuid::Uuid::new_v4()));
    let mut app_data = base.clone();
    for part in ["a".repeat(60), "b".repeat(60), "c".repeat(60), "d".repeat(40), "app.termflow.desktop".into()] {
        app_data.push(part);
    }
    assert!(app_data.as_os_str().len() > 260, "regression needs a path over MAX_PATH");
    let local = std::env::var("LOCALAPPDATA").unwrap();
    let shells = [
        format!(r"{local}\Microsoft\WindowsApps\Microsoft.PowerShell_8wekyb3d8bbwe\pwsh.exe"),
        system_shell("powershell.exe").unwrap(),
        system_shell("cmd.exe").unwrap(),
    ];
    {
        let root = HelperRoot::open_app_data(&app_data).expect("fresh nested app-data root over MAX_PATH");
        for shell in shells {
            let keys = HostKeys::default();
            let CreateAdmission::Run(cg) = keys.admit_create(LEAF, CreateMode::Mount).unwrap() else { panic!("create") };
            keys.stage_shell(LEAF, cg, PROCESS, None).unwrap();
            let mut spec = shell_spec(&shell, &[]);
            let prepared = PreparedShell::register_in(&root, &keys, PROCESS, cg, &mut spec, false, CONNECTION, |_| None)
                .unwrap_or_else(|e| panic!("{shell}: {e}"));
            assert!(keys.ssh_prompt_nonce(PROCESS).is_some(), "{shell}");
            drop(prepared); // never submitted: retires the hook entry
        }
        assert!(std::fs::read_dir(root.path()).unwrap().all(|e| e.unwrap().file_name() == "root.lock"), "hooks retired");
    }
    std::fs::remove_dir_all(&base).unwrap();
}
