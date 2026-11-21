use super::*;

fn hop(id: &str, host: &str, port: u16) -> Hop {
    Hop {
        connection_id: id.into(),
        host: host.into(),
        port,
        user: id.into(),
        auth: Auth::Agent,
        identity_file: None,
    }
}

fn direct() -> (ResolvedTarget, KnownHostsPaths) {
    (
        ResolvedTarget {
            hops: vec![hop("target", "target.test", 2202)],
            extra_options: vec![("serveraliveinterval".into(), "30".into())],
        },
        KnownHostsPaths { target: "/private/target keys".into(), jump: None },
    )
}

#[test]
fn terminal_options_precede_exactly_one_destination() {
    let (mut target, mut trust) = direct();
    target.hops.insert(0, hop("jump", "jump.test", 2201));
    trust.jump = Some("/private/jump keys".into());
    let plan = build_launch_argv(&target, &trust, "/fixed/ssh", Path::new("/home/user")).unwrap();
    let outer = plan.preview_argv();
    let proxy = if cfg!(windows) {
        "ProxyCommand=<native-ssh-proxy>"
    } else {
        "ProxyCommand=/bin/sh '<private-proxy-helper>'"
    };
    assert_eq!(
        outer,
        [
            "/fixed/ssh", "-F", "none", "-o", "StrictHostKeyChecking=yes", "-o",
            "UserKnownHostsFile=\"/private/target keys\"", "-o", "GlobalKnownHostsFile=none",
            "-p", "2202", "-l", "target", "-o", "IdentityFile=none", "-o",
            "PreferredAuthentications=publickey", "-o", "ServerAliveInterval=30", "-o",
            proxy, "--", "target.test",
        ]
    );
    let child = plan.proxy.unwrap();
    assert_eq!(child[child.len() - 4..], ["-W", "target.test:2202", "--", "jump.test"]);
    assert!(!child.iter().any(|arg| arg.starts_with("ServerAliveInterval")));
    trust.jump = None;
    assert_eq!(build_launch_argv(&target, &trust, "/fixed/ssh", Path::new("/")).err().unwrap().code, "hop-mismatch");
}

#[test]
fn extra_options_allowlist_is_case_insensitive_and_rejects_unlisted_or_malformed_keys() {
    let (mut target, trust) = direct();
    let make = |target: &ResolvedTarget| build_launch_argv(target, &trust, "/fixed/ssh", Path::new("/"));
    assert!(make(&target).unwrap().preview_argv().contains(&"ServerAliveInterval=30".into()));
    for (key, value, code) in [
        ("ProxyCommand", "true", "option-not-allowed"),
        ("LocalCommand", "true", "option-not-allowed"),
        ("SessionType", "none", "option-not-allowed"),
        ("HostName", "elsewhere", "option-not-allowed"),
        ("ServerAliveInterval ", "1", "invalid-key"),
        ("SetEnv=TF_TEST", "1", "invalid-key"),
        ("", "1", "invalid-key"),
        ("SetEnv", "X=Y\nProxyCommand=true", "invalid-value"),
        ("SetEnv", "X=Y\r", "invalid-value"),
        ("SetEnv", "X=Y\0", "invalid-value"),
        ("SetEnv", "X=Y\t", "invalid-value"),
    ] {
        target.extra_options = vec![(key.into(), value.into())];
        assert_eq!(make(&target).err().unwrap().code, code, "{key:?}={value:?}");
    }
}

#[cfg(windows)]
#[test]
fn real_native_windows_openssh_parses_direct_launch_with_a_spaced_receipt_path() {
    let _gate = crate::pty_host_client::test_dirs::child_process_gate();
    let ssh = std::env::var("TERMFLOW_TEST_NATIVE_SSH")
        .expect("set TERMFLOW_TEST_NATIVE_SSH to the native Windows OpenSSH executable");
    let (target, mut trust) = direct();
    trust.target = r"C:\private receipt dir\target known hosts".into();
    let plan = build_launch_argv(&target, &trust, &ssh, Path::new(r"C:\Users\fixture")).unwrap();
    let output = std::process::Command::new(&ssh)
        .arg("-G")
        .args(&plan.preview_argv()[1..])
        .output()
        .expect("required native Windows OpenSSH executable missing");
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let config = String::from_utf8(output.stdout).unwrap();
    assert!(config.lines().any(|line| line == "userknownhostsfile C:/private receipt dir/target known hosts"));
    assert!(config.lines().any(|line| line == "hostname target.test"));
}

#[test]
fn native_windows_proxy_encoder_quotes_crt_argv_and_doubles_percent() {
    let child = [
        r"C:\Program Files\OpenSSH\ssh.exe",
        "-F",
        "none",
        r#"UserKnownHostsFile="C:/private %%h dir/jump known hosts""#,
        r#"say"hi\"#,
        "a&mkdir local-canary&rem %h",
        "",
    ].map(str::to_owned);
    assert_eq!(
        native_proxy_command(&child).unwrap(),
        r#""C:\Program Files\OpenSSH\ssh.exe" "-F" "none" "UserKnownHostsFile=\"C:/private %%%%h dir/jump known hosts\"" "say\"hi\\" "a&mkdir local-canary&rem %%h" """#,
    );
}

#[cfg(any(unix, windows))]
mod openssh {
    use super::*;
    use crate::ssh::tests::{key, Server};
    use ssh_key::LineEnding;
    use std::{
        fs::{self, DirBuilder},
        path::PathBuf,
        process::{Output, Stdio},
        time::Duration,
    };
    #[cfg(unix)]
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    use tokio::{net::TcpListener, process::Command};

    struct Temp(PathBuf);
    impl Temp {
        fn new(label: &str) -> Self {
            let parent = std::env::temp_dir();
            #[cfg(unix)]
            let parent = fs::canonicalize(parent).unwrap();
            let path = parent.join(format!("tf-ssh-{label}-{}", uuid::Uuid::new_v4()));
            #[cfg(unix)]
            DirBuilder::new().mode(0o700).create(&path).unwrap();
            #[cfg(windows)]
            DirBuilder::new().create(&path).unwrap();
            Self(path)
        }
        fn path(&self, name: &str) -> String {
            self.0.join(name).to_str().unwrap().into()
        }
        fn write(&self, name: &str, bytes: impl AsRef<[u8]>, _mode: u32) -> String {
            let path = self.path(name);
            fs::write(&path, bytes).unwrap();
            #[cfg(unix)]
            fs::set_permissions(&path, fs::Permissions::from_mode(_mode)).unwrap();
            path
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    async fn listen(server: Server) -> (u16, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                server.clone().start(Box::new(stream));
            }
        });
        (port, task)
    }

    struct Rig {
        temp: Temp,
        target: ResolvedTarget,
        trust: KnownHostsPaths,
        destination: Server,
        bastion: Option<Server>,
        listener: tokio::task::JoinHandle<()>,
    }
    impl Rig {
        async fn new(jump: bool, label: &str, target_host: &str) -> Self {
            let temp = Temp::new(label);
            let destination = Server::new(1, "target");
            let mut bastion = None;
            let (port, listener) = if jump {
                let mut server = Server::new(2, "jump");
                server.target = Some(Box::new(destination.clone()));
                let listening = listen(server.clone()).await;
                bastion = Some(server);
                listening
            } else {
                listen(destination.clone()).await
            };
            let target_port = if jump { if port == 2202 { 2203 } else { 2202 } } else { port };
            let mut target = ResolvedTarget { hops: vec![], extra_options: vec![
                ("ConnectTimeout".into(), "3".into()), ("LogLevel".into(), "DEBUG1".into()),
            ] };
            let mut trust = KnownHostsPaths { jump: None, target: String::new() };
            if let Some(server) = &bastion {
                let (hop, file) = Self::hop_files(&temp, server, 2, "127.0.0.1", port);
                target.hops.push(hop);
                trust.jump = Some(file);
            }
            let (hop, file) = Self::hop_files(&temp, &destination, 1, target_host, target_port);
            target.hops.push(hop);
            trust.target = file;
            Self { temp, target, trust, destination, bastion, listener }
        }
        fn hop_files(temp: &Temp, server: &Server, seed: u8, host: &str, port: u16) -> (Hop, String) {
            let mut hop = hop(&server.user, host, port);
            hop.auth = Auth::KeyFile;
            let private = key(seed + 10).to_openssh(LineEnding::LF).unwrap();
            #[cfg(unix)]
            let identity = temp.write(&format!("{} identity", server.user), private.as_bytes(), 0o600);
            #[cfg(windows)]
            let identity = {
                // Reuse the private ACL writer, not inherited TEMP permissions,
                // for the fake server's client key. This fixture file is data.
                let root = HelperRoot::open_app_data(&temp.0).unwrap();
                let helper = root.publish(
                    ProcessIdentity::capture(std::process::id()).unwrap(),
                    HelperKind::AttemptPayload, "json", private.as_bytes(),
                ).unwrap();
                helper.path().into_os_string().into_string().unwrap()
            };
            hop.identity_file = Some(identity);
            let known = format!("[{host}]:{port} {}\n", server.host.public_key().to_openssh().unwrap());
            (hop, temp.write(&format!("{} known hosts", server.user), known, 0o600))
        }
        #[cfg(unix)]
        async fn run(&self, ssh: &str, shell: &str, outer_bash: bool, trust: &KnownHostsPaths) -> Output {
            let root = HelperRoot::open_app_data(&self.temp.0).unwrap();
            let launch = build_launch_argv(&self.target, trust, ssh, &self.temp.0).unwrap()
                .publish(&root, ProcessIdentity::capture(std::process::id()).unwrap(), ProxyRuntime::PosixOrFish,
                    |path| Ok(path.to_str().unwrap().into())).unwrap();
            let mut cmd = if outer_bash {
                let mut cmd = Command::new("/bin/bash");
                cmd.args(["-c", "exec \"$@\"", "fixture"]);
                cmd.args(launch.argv());
                cmd
            } else {
                let mut cmd = Command::new(&launch.argv()[0]);
                cmd.args(&launch.argv()[1..]);
                cmd
            };
            cmd.current_dir(&self.temp.0).env("SHELL", shell).env_remove("SSH_AUTH_SOCK")
                .env("LC_ALL", "C").stdin(Stdio::null()).kill_on_drop(true);
            let output = tokio::time::timeout(Duration::from_secs(15), cmd.output()).await
                .expect("loopback SSH timed out").expect("required OpenSSH/shell fixture executable missing");
            // Stop retaining only after the successful marker proves the child consumed the payload.
            // On failures the process tree may still be unwinding; keep the pin until fixture drop.
            if output.status.success() {
                launch.finish_after_quiescence().unwrap();
            }
            output
        }
        #[cfg(unix)]
        fn recording_ssh(&self, real: &str) -> String {
            let script = format!(
                "#!/bin/sh\nfor arg do\n if [ \"$arg\" = -W ]; then\n  printf '%s\\0' \"$@\" > {}\n  break\n fi\ndone\nexec {} \"$@\"\n",
                shell_literal(&self.temp.path("inner argv")), shell_literal(real),
            );
            self.temp.write("recording ssh", script, 0o700)
        }
        #[cfg(unix)]
        fn inner(&self) -> Vec<String> {
            let bytes = fs::read(self.temp.path("inner argv")).unwrap();
            assert_eq!(bytes.last(), Some(&0));
            std::str::from_utf8(&bytes[..bytes.len()-1]).unwrap().split('\0').map(str::to_owned).collect()
        }
    }
    impl Drop for Rig {
        fn drop(&mut self) { self.listener.abort(); }
    }

    #[cfg(windows)]
    // The shared child-process gate intentionally outlives every owned child.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn real_native_windows_openssh_jump_reaches_target_through_isolated_proxy() {
        let _gate = crate::pty_host_client::test_dirs::child_process_gate();
        let ssh = crate::pty_manager::ssh_shell::system_shell(r"OpenSSH\ssh.exe").unwrap();
        assert!(Path::new(&ssh).is_file(), "required native Windows OpenSSH is missing: {ssh}");
        // This connection's actual key and receipt paths contain spaces, a
        // proxy token, and a cmd canary. They must remain literal at both hops.
        let rig = Rig::new(true, "native %h & mkdir local-canary & rem", "target.test").await;
        let run = |trust: &KnownHostsPaths| {
            let plan = build_launch_argv(&rig.target, trust, &ssh, &rig.temp.0).unwrap();
            let root = HelperRoot::open_app_data(&rig.temp.0).unwrap();
            let launch = plan.publish(
                &root,
                ProcessIdentity::capture(std::process::id()).unwrap(),
                ProxyRuntime::WindowsNative,
                |_| panic!("native proxy must not publish a helper"),
            ).unwrap();
            assert!(launch.payload.is_none());
            let argv = launch.argv();
            let mut cmd = Command::new(&argv[0]);
            cmd.args(&argv[1..]).current_dir(&rig.temp.0)
                .env("SHELL", rig.temp.path("no-such-shell.exe")).env_remove("SSH_TEST_ENVIRONMENT")
                .env_remove("SSH_AUTH_SOCK").stdin(Stdio::null()).kill_on_drop(true);
            async move {
                tokio::time::timeout(Duration::from_secs(15), cmd.output()).await
                    .expect("native SSH timed out").expect("native OpenSSH fixture failed to start")
            }
        };
        assert_login(&run(&rig.trust).await);
        let target = rig.target.hops.last().unwrap();
        let bastion = rig.bastion.as_ref().unwrap();
        assert_eq!(*bastion.counters.direct_addresses.lock(), vec![(target.host.clone(), target.port.into())]);
        assert!(bastion.counters.principals.lock().iter().any(|name| name == "jump"));
        assert!(rig.destination.counters.principals.lock().iter().any(|name| name == "target"));

        let wrong_jump = KnownHostsPaths {
            jump: Some(rig.trust.target.clone()),
            target: rig.trust.target.clone(),
        };
        let wrong_target = KnownHostsPaths {
            jump: rig.trust.jump.clone(),
            target: rig.trust.jump.clone().unwrap(),
        };
        for trust in [wrong_jump, wrong_target] {
            let output = run(&trust).await;
            assert!(!output.status.success());
            assert!(String::from_utf8_lossy(&output.stderr).contains("Host key verification failed"));
        }
        assert!(!Path::new(&rig.temp.path("local-canary")).exists());

        let foreign = build_launch_argv(&rig.target, &rig.trust, r"C:\Git\usr\bin\ssh.exe", &rig.temp.0).unwrap();
        assert_eq!(foreign.native_windows_argv().unwrap_err().kind(), io::ErrorKind::Unsupported);
    }

    #[cfg(unix)]
    fn real_ssh() -> String {
        std::env::var("TERMFLOW_TEST_SSH").unwrap_or_else(|_| "/usr/bin/ssh".into())
    }
    fn assert_login(output: &Output) {
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert_eq!(output.stdout, b"launch-shell-ok");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn jump_refuses_unproven_proxy_runtimes_before_publication() {
        let rig = Rig::new(true, "unsupported", "target.test").await;
        let root = HelperRoot::open_app_data(&rig.temp.0).unwrap();
        let plan = build_launch_argv(&rig.target, &rig.trust, "/fixed/ssh", &rig.temp.0).unwrap();
        for runtime in [ProxyRuntime::WindowsNative, ProxyRuntime::Unsupported] {
            let error = plan.publish(
                &root,
                ProcessIdentity::capture(std::process::id()).unwrap(),
                runtime,
                |_| panic!("must refuse before publishing a payload"),
            ).err().unwrap();
            assert_eq!(error.kind(), io::ErrorKind::Unsupported);
        }
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1); // root.lock only
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn real_openssh_known_hosts_paths_with_spaces_reach_target_and_jump_verbatim() {
        let _gate = crate::pty_host_client::test_dirs::child_process_gate();
        let rig = Rig::new(true, "paths with spaces", "target.test").await;
        let ssh = rig.recording_ssh(&real_ssh());
        let output = rig.run(&ssh, "/bin/sh", false, &rig.trust).await;
        assert_login(&output); // distinct real host keys exist only in these files
        assert!(String::from_utf8_lossy(&output.stderr).contains(&rig.trust.target));
        assert!(rig.inner().contains(&format!("UserKnownHostsFile=\"{}\"", rig.trust.jump.as_ref().unwrap())));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn real_openssh_proxy_helper_preserves_inner_argv_under_fish_login_shell() {
        let _gate = crate::pty_host_client::test_dirs::child_process_gate();
        let fish = std::env::var("TERMFLOW_TEST_FISH").unwrap_or_else(|_| "/usr/bin/fish".into());
        assert!(Path::new(&fish).is_file(), "required fish fixture missing (TERMFLOW_TEST_FISH)");
        let rig = Rig::new(true, "fish ' \\ % é $(touch${IFS}local-canary)", "target.test").await;
        // OpenSSH also expands ${...} in identity and trust paths. Put those under
        // a separate private root; only the helper and fixed executable exercise it.
        let files = Temp::new("literal files ' \\ % é");
        let mut rig = rig;
        for (index, (server, seed)) in [(rig.bastion.as_ref().unwrap(), 2), (&rig.destination, 1)].into_iter().enumerate() {
            let h = &rig.target.hops[index];
            let (replacement, known) = Rig::hop_files(&files, server, seed, &h.host, h.port);
            rig.target.hops[index] = replacement;
            if index == 0 { rig.trust.jump = Some(known); } else { rig.trust.target = known; }
        }
        let ssh = rig.recording_ssh(&real_ssh());
        assert_login(&rig.run(&ssh, &fish, true, &rig.trust).await);
        let jump = &rig.target.hops[0];
        let target = &rig.target.hops[1];
        let inner = rig.inner();
        assert_eq!(&inner[inner.len()-4..], &["-W".to_string(), format!("{}:{}", target.host, target.port), "--".into(), jump.host.clone()]);
        assert!(inner.windows(2).any(|args| args == ["-l", "jump"]));
        assert!(inner.windows(2).any(|args| args == ["-p".to_string(), jump.port.to_string()]));
        assert!(inner.iter().any(|arg| arg.starts_with("IdentityFile=") && arg.contains("jump identity")));
        assert_eq!(*rig.bastion.as_ref().unwrap().counters.direct_addresses.lock(), vec![(target.host.clone(), target.port.into())]);
        assert!(!Path::new(&rig.temp.path("local-canary")).exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn real_openssh_uses_distinct_receipt_known_hosts_paths_per_hop() {
        let _gate = crate::pty_host_client::test_dirs::child_process_gate();
        let rig = Rig::new(true, "separate", "target.test").await;
        let ssh = real_ssh();
        assert_login(&rig.run(&ssh, "/bin/sh", false, &rig.trust).await);
        let wrong_target = KnownHostsPaths { target: rig.trust.jump.clone().unwrap(), jump: rig.trust.jump.clone() };
        let wrong_jump = KnownHostsPaths { target: rig.trust.target.clone(), jump: Some(rig.trust.target.clone()) };
        for wrong in [wrong_target, wrong_jump] {
            let output = rig.run(&ssh, "/bin/sh", false, &wrong).await;
            assert!(!output.status.success());
            assert!(String::from_utf8_lossy(&output.stderr).contains("Host key verification failed"));
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn real_openssh_accepted_option_combinations_never_run_local_canary() {
        let _gate = crate::pty_host_client::test_dirs::child_process_gate();
        let mut rig = Rig::new(false, "allowed-options", "127.0.0.1").await;
        let reservation = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = reservation.local_addr().unwrap().port();
        drop(reservation);
        let literal = "$(touch${IFS}local-canary);literal";
        rig.target.extra_options.extend([
            ("serveraliveinterval".into(), "10".into()),
            ("ServerAliveCountMax".into(), "2".into()),
            ("DynamicForward".into(), format!("127.0.0.1:{port}")),
            ("ExitOnForwardFailure".into(), "yes".into()),
            ("SetEnv".into(), format!("TF_LAUNCH={literal}")),
        ]);
        let ssh = real_ssh();
        let plan = build_launch_argv(&rig.target, &rig.trust, &ssh, &rig.temp.0).unwrap();
        let config = inspect(&ssh, &plan.preview_argv()[1..]).await;
        assert!(config.lines().any(|line| line == "serveraliveinterval 10"));
        assert!(config.lines().any(|line| line == "serveralivecountmax 2"));
        let output = rig.run(&ssh, "/bin/sh", false, &rig.trust).await;
        assert_login(&output);
        assert!(String::from_utf8_lossy(&output.stderr).contains(&format!("Local forwarding listening on 127.0.0.1 port {port}")));
        assert!(rig.destination.counters.environment.lock().contains(&("TF_LAUNCH".into(), literal.into())));
        assert!(!Path::new(&rig.temp.path("local-canary")).exists());
        for key in ["LocalCommand", "PermitLocalCommand", "RemoteCommand", "SessionType"] {
            rig.target.extra_options.push((key.into(), "touch local-canary".into()));
            assert!(build_launch_argv(&rig.target, &rig.trust, &ssh, &rig.temp.0).is_err());
            rig.target.extra_options.pop();
        }
    }

    #[cfg(unix)]
    async fn inspect(ssh: &str, args: &[String]) -> String {
        let output = tokio::time::timeout(Duration::from_secs(10),
            Command::new(ssh).arg("-G").args(args).stdin(Stdio::null()).kill_on_drop(true).output())
            .await.unwrap().expect("required real OpenSSH executable missing");
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        String::from_utf8(output.stdout).unwrap()
    }

    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "requires externally staged user and system config in an isolated OpenSSH account/container"]
    async fn real_openssh_target_and_bastion_ignore_hostile_user_and_system_config() {
        let _gate = crate::pty_host_client::test_dirs::child_process_gate();
        // Do not change ~/.ssh or /etc/ssh from this test. A dedicated fixture
        // account/container supplies the passwd-home and compiled sysconf files.
        // The baseline makes a wrong executable/home/config path a hard failure.
        let ssh = std::env::var("TERMFLOW_TEST_HERMETIC_SSH").expect("required hermetic OpenSSH executable");
        let rig = Rig::new(true, "hostile-config", "target.test").await;
        for (host, redirected) in [("target.test", "hostile-user.invalid"), ("127.0.0.1", "hostile-system.invalid")] {
            let baseline = inspect(&ssh, &[host.into()]).await;
            assert!(baseline.lines().any(|line| line == format!("hostname {redirected}")));
            assert!(baseline.lines().any(|line| line == "permitlocalcommand yes"));
            assert!(baseline.lines().any(|line| line == "localcommand touch local-canary"));
            assert!(baseline.lines().any(|line| line == "proxycommand false"));
            assert!(baseline.lines().any(|line| line == "userknownhostsfile /nonexistent/hostile"));
        }
        let plan = build_launch_argv(&rig.target, &rig.trust, &ssh, &rig.temp.0).unwrap();
        let outer = plan.preview_argv();
        let inner = plan.proxy.as_ref().unwrap();
        for (argv, host) in [(&outer, "target.test"), (inner, "127.0.0.1")] {
            let config = inspect(&ssh, &argv[1..]).await;
            assert!(config.lines().any(|line| line == format!("hostname {host}")));
            assert!(config.lines().any(|line| line == "permitlocalcommand no"));
            assert!(!config.contains("/nonexistent/hostile"));
            assert!(!config.contains("proxycommand false"));
        }
        assert_login(&rig.run(&ssh, "/bin/sh", false, &rig.trust).await);
        assert!(!Path::new(&rig.temp.path("local-canary")).exists());
    }
}
