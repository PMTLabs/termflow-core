use super::*;
use crate::ssh::metrics::{check_collector_exit, collector_command, encode, CollectorError, COLLECT};
use std::fs::{self, DirBuilder};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{Duration, Instant};

fn find_executable(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path).find_map(|dir| {
        let candidate = dir.join(name);
        let metadata = fs::metadata(&candidate).ok()?;
        if metadata.is_file() && metadata.permissions().mode() & 0o111 != 0 {
            // Make relative PATH entries absolute without resolving symlinks:
            // multicall shells/utilities can use argv[0] to choose the applet.
            Some(std::env::current_dir().unwrap().join(candidate))
        } else {
            None
        }
    })
}

struct Host(PathBuf);

impl Host {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("tf-metrics-{}", uuid::Uuid::new_v4()));
        DirBuilder::new().mode(0o700).create(&root).unwrap();
        let host = Self(root);
        host.utility("awk", "exec \"$REAL_AWK\" \"$@\"");
        host.utility("uname", r#"case "$1" in -s) printf '%s\n' "$PLATFORM" ;; -n) printf 'test-host\n' ;; -m) printf 'test-arch\n' ;; esac"#);
        host.utility("cat", r#"
if [ "$PLATFORM" != Linux ]; then
    printf 'forbidden read: %s\n' "$1" >> "$TRACE"
    exit 91
fi
case "$1" in
    /etc/os-release) printf '%s\n' "$OS_RELEASE" ;;
    /proc/mounts) printf '%s' "$MOUNTS" ;;
    /proc/meminfo) printf 'MemTotal: 1000 kB\nMemAvailable: 600 kB\n' ;;
    /proc/stat) printf 'cpu 1 0 2 3 4 0 0 0\n' ;;
    /proc/net/dev) printf 'eth0: 11 0 0 0 0 0 0 0 23 0 0 0 0 0 0 0\n' ;;
    /proc/uptime) printf '50.05 0.00\n' ;;
    /proc/sys/kernel/random/boot_id) printf '87050553-fdeb-4f82-b9e8-f73aa869ac5b\n' ;;
    /proc/cpuinfo) printf 'processor : 0\n' ;;
    /proc/loadavg) printf '0.1 0.2 0.3 1/100 50\n' ;;
    *) exit 90 ;;
esac"#);
        host.utility("nproc", "printf '1\\n'");
        host.utility("who", "printf '%s' \"$WHO_ROWS\"; exit \"$WHO_STATUS\"");
        host.utility("sentinel", "printf 'executed' > sentinel-ran");
        host.utility("df", r#"
[ "$LC_ALL:$LANG:$TZ:$DF_BLOCK_SIZE:$BLOCK_SIZE:$BLOCKSIZE" = C:C:UTC:1024:1024:1024 ] || exit 91
case "$*" in
    '-l -P -T')
        if [ "$FALLBACK" = no ]; then printf '%s' "$LOCAL"; else printf 'failed typed stdout\n'; exit 1; fi ;;
    '-l -P') [ "$FALLBACK" = yes ] || exit 1
        printf 'Filesystem 1K-blocks Used Available Use%% Mounted on\n/dev/vda\n   100 30 60 34%% /\n' ;;
    '-P -T -t ext4') printf '%s' "$LOCAL"; [ "$FALLBACK" != unsupported ] ;;
    '-P -T -t xfs') printf 'Filesystem Type 1024-blocks Used Available Capacity Mounted on\n/dev/data xfs 100 30 60 34%% /data\n'; [ "$FALLBACK" != fail-second ] ;;
    '-P -t nfs -t nfs4')
        [ "$GUARDED" = yes ] || exit 92
        printf '%s' "$NFS"
        if [ "$TIMEOUT_MODE" = expire124 ] || [ "$TIMEOUT_MODE" = expire137 ]; then
            # Model a child outside channel/watchdog cleanup. It publishes
            # readiness, then lives until the test releases it (bounded at
            # 20 s, far beyond a collector run even on a loaded CI host).
            (
                : > child-ready
                attempt=0
                while [ "$attempt" -lt 100 ] && [ ! -f child-release ]; do
                    attempt=$((attempt + 1))
                    nap 0.2
                done
                : > child-exited
            ) </dev/null >/dev/null 2>&1 &
            attempt=0
            while [ "$attempt" -lt 100 ] && [ ! -f child-ready ]; do
                attempt=$((attempt + 1))
                nap 0.05
            done
        fi
        exit "$NFS_STATUS" ;;
    *) exit 93 ;;
esac"#);
        host
    }

    fn install_timeout(&self) {
        self.utility("timeout", r#"
[ "$*" = '-s KILL 2 df -P -t nfs -t nfs4' ] || exit 93
[ "$TIMEOUT_MODE" != unsupported ] || exit 125
shift 3
GUARDED=yes "$@"
status=$?
case "$TIMEOUT_MODE" in
    expire124) exit 124 ;;
    expire137) exit 137 ;;
    *) exit "$status" ;;
esac"#);
    }

    fn utility(&self, name: &str, body: &str) {
        self.script(name, &format!("printf '%s\\n' \"$0 $*\" >> \"$TRACE\"\n{body}"));
    }

    fn script(&self, name: &str, body: &str) {
        let path = self.0.join(name);
        fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }

    fn run(&self, env: &[(&str, &str)]) -> (String, String, Vec<String>) {
        let (command, nonce) = collector_command();
        let text = self.invoke(&command, env);
        let trace = fs::read_to_string(self.0.join("trace")).unwrap();
        // Based on recorded calls, not a fake exec counter. 'sh' counts any
        // extra shell invocation beyond the outer SSH-shell stand-in.
        let prefix = format!("{}/", self.0.display());
        let trace: Vec<_> = trace.lines().map(|line| line.strip_prefix(&prefix).unwrap_or(line).to_owned()).collect();
        assert_eq!(trace.iter().filter(|call| call.as_str() == "collector-entry").count(), 1);
        (text, nonce, trace)
    }

    fn invoke(&self, command: &str, env: &[(&str, &str)]) -> String {
        String::from_utf8(self.invoke_success(Path::new("/bin/sh"), &[], command, env)).unwrap()
    }

    fn invoke_raw(&self, shell: &Path, flags: &[&str], command: &str, env: &[(&str, &str)]) -> Output {
        let real_awk = find_executable("awk").expect("POSIX awk is required for collector controls");
        let mut cmd = Command::new(shell);
        cmd.args(flags).arg("-c").arg(command).current_dir(&self.0).env_clear()
            .env("PATH", &self.0).env("HOME", &self.0).env("XDG_CONFIG_HOME", &self.0)
            .env("REAL_AWK", real_awk).env("TRACE", self.0.join("trace"))
            .envs([
                ("PLATFORM", "Linux"), ("OS_RELEASE", "NAME='Test Linux'\nVERSION_ID=11"),
                ("FALLBACK", "no"), ("MOUNTS", MOUNTS), ("LOCAL", LOCAL), ("NFS", NFS),
                ("TIMEOUT_MODE", "return"), ("NFS_STATUS", "0"), ("WHO_STATUS", "0"),
            ]);
        for &(key, value) in env {
            cmd.env(key, value);
        }
        self.script("sh", r#"printf 'collector-entry\n' >> "$TRACE"
[ "$1" = -c ] || exit 90
printf '%s' "$2" > collector-input || exit 91
if [ -n "$FAKE_UTMP" ]; then
    # Intercept only the production existence probes; do not depend on host utmp.
    probe='test() {
        case "$*" in
            "-e /var/run/utmp") [ "$FAKE_UTMP" = yes ] ;;
            "-e /run/utmp") return 1 ;;
            *) command test "$@" ;;
        esac
    }'
    exec /bin/sh -x -c "$probe
$2" "$3" "$4"
fi
exec /bin/sh -x "$@""#);
        // Don't put general host utilities (including ssh) on the fake PATH.
        self.utility("nap", "exec /bin/sleep \"$@\"");
        fs::write(self.0.join("trace"), "").unwrap();
        cmd.output().unwrap_or_else(|e| panic!("could not execute {}: {e}", shell.display()))
    }

    fn invoke_success(&self, shell: &Path, flags: &[&str], command: &str, env: &[(&str, &str)]) -> Vec<u8> {
        let out = self.invoke_raw(shell, flags, command, env);
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(out.status.success(), "shell failed: {stderr}");
        // An absolute '. /etc/os-release' would bypass PATH (and the fake cat).
        assert!(!stderr.lines().any(|line| line.starts_with("+ . ") || line.starts_with("+ source ")),
            "collector attempted to source data");
        out.stdout
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        if self.0.join("child-ready").exists() {
            let _ = fs::write(self.0.join("child-release"), "");
            for _ in 0..25 {
                if self.0.join("child-exited").exists() { break; }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(super) fn freebsd_has_no_proc_trace() {
    let host = Host::new();
    let (stdout, nonce, trace) = host.run(&[("PLATFORM", "FreeBSD")]);
    assert_freebsd(&parse(stdout.as_bytes(), &nonce).unwrap(), "test-host", "test-arch");
    let utilities: Vec<_> = trace.iter().filter(|line| !line.starts_with("awk ") && !line.starts_with("sh ") && *line != "collector-entry").map(String::as_str).collect();
    assert_eq!(utilities, ["uname -s", "uname -n", "uname -m"]);
}

#[test]
fn real_collector_freebsd_has_no_proc_trace() {
    freebsd_has_no_proc_trace();
}

#[test]
fn os_release_is_data_never_executed() {
    let host = Host::new();
    let hostile = "NAME='Test Linux'\nVERSION_ID=11\nBOGUS=$(sentinel)\nsentinel\n";
    let (stdout, nonce, trace) = host.run(&[("OS_RELEASE", hostile)]);
    assert_eq!(parse(stdout.as_bytes(), &nonce).unwrap().os.as_deref(), Ok("Test Linux 11"));
    assert!(trace.iter().any(|t| t == "cat /etc/os-release"));
    assert!(!trace.iter().any(|t| t.starts_with("sentinel ")));
    assert!(!host.0.join("sentinel-ran").exists());
}

#[test]
fn production_encoder_quotes_literal_shell_syntax() {
    let host = Host::new();
    let body = r#"printf '%s\n%s\n' 'It'"'"'s ! $literal $(sentinel) `sentinel` \\ % café
second line' "$1"

"#;
    let literal = "It's ! $literal $(sentinel) `sentinel` \\\\ % café\nsecond line";
    assert!(encode("'; sentinel #", body).is_none());
    assert_eq!(host.invoke(&encode(NONCE, body).unwrap(), &[]), format!("{literal}\n{NONCE}\n"));
    assert_eq!(fs::read(host.0.join("collector-input")).unwrap().as_slice(), body.as_bytes());
    assert!(!host.0.join("sentinel-ran").exists());
}

#[test]
fn collector_runs_identically_under_each_login_shell() {
    let host = Host::new();
    host.install_timeout();
    let (command, nonce) = collector_command();
    let hostile = [("OS_RELEASE", "NAME='Test Linux'\nVERSION_ID=11\nBAD=$(sentinel)\nsentinel")];
    let mut baseline = None;
    let mut missing_optional = Vec::new();
    for (name, flags) in [
        ("sh", &[][..]), ("bash", &[][..]), ("dash", &[][..]), ("zsh", &["-f"][..]),
        ("fish", &["--no-config"][..]), ("tcsh", &["-f"][..]),
    ] {
        let shell = if name == "sh" {
            PathBuf::from("/bin/sh")
        } else if let Some(path) = find_executable(name) {
            path
        } else {
            assert_ne!(name, "bash", "bash is required for the login-shell matrix");
            missing_optional.push(name);
            continue;
        };
        eprintln!("running {name}: {}", shell.display());
        let actual = host.invoke_success(&shell, flags, &command, &hostile);
        let sample = parse(&actual, &nonce).expect("login shell mangled the complete sample");
        assert_eq!(sample.os.as_deref(), Ok("Test Linux 11"));
        assert_eq!(fs::read(host.0.join("collector-input")).unwrap().as_slice(), COLLECT.as_bytes(), "{name}");
        assert!(!host.0.join("sentinel-ran").exists(), "{name}");
        if let Some(expected) = &baseline {
            assert_eq!(&actual, expected, "stdout differed under {name}");
        } else {
            baseline = Some(actual);
        }
    }
    if !missing_optional.is_empty() {
        eprintln!("missing optional shells: {}", missing_optional.join(", "));
        assert_eq!(std::env::var("TERMFLOW_TEST_OPTIONAL_SHELLS").as_deref(), Ok("skip"),
            "install the missing shells or explicitly opt out with TERMFLOW_TEST_OPTIONAL_SHELLS=skip");
    }
}

#[test]
fn missing_or_failed_decoder_is_typed_collector_unavailable() {
    let host = Host::new();
    let (command, _) = collector_command();
    fs::remove_file(host.0.join("awk")).unwrap();
    for simulated_failure in [false, true] {
        if simulated_failure {
            host.utility("awk", "exit 2");
        }
        let out = host.invoke_raw(Path::new("/bin/sh"), &[], &command, &[]);
        let code = out.status.code().expect("expected normal nonzero exit") as u32;
        assert_eq!(check_collector_exit(code), Err(CollectorError::Unavailable));
        assert!(out.stdout.is_empty());
        assert!(!host.0.join("collector-input").exists());
    }
    let success = encode(NONCE, "printf 'available\\n'\n").unwrap();
    host.utility("awk", "exec \"$REAL_AWK\" \"$@\"");
    assert_eq!(host.invoke(&success, &[]), "available\n");
    assert_eq!(check_collector_exit(0), Ok(()));
}

#[test]
fn df_busybox_fallback_stays_in_one_exec() {
    let host = Host::new();
    host.install_timeout();
    let (stdout, nonce, trace) = host.run(&[("FALLBACK", "yes")]);
    let s = parse(stdout.as_bytes(), &nonce).unwrap();
    assert_eq!(s.local.unwrap().iter().map(row).collect::<Vec<_>>(), [LOCAL_ROW]);
    assert_eq!(s.nfs.unwrap().iter().map(row).collect::<Vec<_>>(), [NFS_ROW]);
    assert_eq!(df_trace(&trace), ["df -l -P -T", "df -l -P", "timeout -s KILL 2 df -P -t nfs -t nfs4", "df -P -t nfs -t nfs4"]);
    assert_eq!(trace.iter().filter(|t| t.as_str() == "cat /proc/mounts").count(), 1);
    let mounts = format!("{MOUNTS}/dev/data /data xfs rw 0 0\n//host/share /smb cifs rw 0 0\nportal /portal fuse.portal rw 0 0\n");
    let (stdout, nonce, trace) = host.run(&[("FALLBACK", "busybox"), ("MOUNTS", &mounts)]);
    let s = parse(stdout.as_bytes(), &nonce).unwrap();
    assert_eq!(s.local.unwrap().iter().map(row).collect::<Vec<_>>(), [LOCAL_ROW, ("/dev/data", "/data", "xfs", 102400, 30720, 61440, 34)]);
    assert_eq!(df_trace(&trace), ["df -l -P -T", "df -l -P", "df -P -T -t ext4", "df -P -T -t xfs", "timeout -s KILL 2 df -P -t nfs -t nfs4", "df -P -t nfs -t nfs4"]);
    let (stdout, nonce, _) = host.run(&[("FALLBACK", "fail-second"), ("MOUNTS", &mounts)]);
    assert!(parse(stdout.as_bytes(), &nonce).unwrap().local.is_err());
    assert!(!stdout.contains("/dev/data xfs 100") && !stdout.contains(LOCAL.lines().nth(1).unwrap()));
    let stacked = format!("{MOUNTS}server:/root / nfs4 rw 0 0\n");
    let (stdout, nonce, trace) = host.run(&[("FALLBACK", "busybox"), ("MOUNTS", &stacked)]);
    assert!(parse(stdout.as_bytes(), &nonce).unwrap().local.is_err());
    assert_eq!(df_trace(&trace), ["df -l -P -T", "df -l -P", "timeout -s KILL 2 df -P -t nfs -t nfs4", "df -P -t nfs -t nfs4"]);
    let (stdout, nonce, trace) = host.run(&[("FALLBACK", "unsupported")]);
    let s = parse(stdout.as_bytes(), &nonce).unwrap();
    assert!(s.local.is_err());
    assert_eq!(s.nfs.unwrap().iter().map(row).collect::<Vec<_>>(), [NFS_ROW]);
    assert_eq!(df_trace(&trace), ["df -l -P -T", "df -l -P", "df -P -T -t ext4", "timeout -s KILL 2 df -P -t nfs -t nfs4", "df -P -t nfs -t nfs4"]);
}

#[test]
fn who_requires_login_records_only_when_empty() {
    let host = Host::new();
    for (utmp, body, expected) in [
        ("no", "", Err("Login records unavailable")),
        ("yes", "", Ok(0)),
        ("no", "alice pts/0\n", Ok(1)),
    ] {
        let (stdout, nonce, _) = host.run(&[("FAKE_UTMP", utmp), ("WHO_ROWS", body)]);
        let sample = parse(stdout.as_bytes(), &nonce).unwrap();
        assert_eq!(sample.section("who").unwrap().rows().map(|rows| rows.len()), expected);
    }
}

fn df_trace(trace: &[String]) -> Vec<&str> {
    trace.iter().map(String::as_str).filter(|t| t.starts_with("df ") || t.starts_with("timeout ")).collect()
}

#[test]
fn nfs_requires_safe_timeout_and_never_falls_back_unguarded() {
    let host = Host::new();
    let (stdout, nonce, trace) = host.run(&[]);
    let s = parse(stdout.as_bytes(), &nonce).unwrap();
    assert_eq!(s.nfs, Err("NFS usage requires timeout and df"));
    assert!(!s.nfs_watchdog_expired);
    assert_eq!(df_trace(&trace), ["df -l -P -T"]);
    host.install_timeout();
    let (stdout, nonce, trace) = host.run(&[("TIMEOUT_MODE", "unsupported")]);
    let s = parse(stdout.as_bytes(), &nonce).unwrap();
    assert_eq!(s.nfs, Err("Safe NFS usage unavailable"));
    assert!(!s.nfs_watchdog_expired);
    assert_eq!(df_trace(&trace), ["df -l -P -T", "timeout -s KILL 2 df -P -t nfs -t nfs4"]);
    assert_eq!(s.local.unwrap().iter().map(row).collect::<Vec<_>>(), [LOCAL_ROW]);

    let (stdout, nonce, trace) = host.run(&[("MOUNTS", "/dev/vda / ext4 rw 0 0\n")]);
    assert!(parse(stdout.as_bytes(), &nonce).unwrap().nfs.unwrap().is_empty());
    assert_eq!(df_trace(&trace), ["df -l -P -T"]);
}

#[test]
fn inner_nfs_watchdog_is_indeterminate_with_local_rows_and_surviving_child() {
    for (mode, exit) in [("expire124", 124), ("expire137", 137)] {
        let host = Host::new();
        host.install_timeout();
        let start = Instant::now();
        let (stdout, nonce, trace) = host.run(&[("TIMEOUT_MODE", mode)]);
        // The run returned while the surviving child (alive up to 20 s) still
        // runs: the collector never waits for it.
        assert!(start.elapsed() < Duration::from_secs(15));
        assert!(host.0.join("child-ready").exists());
        assert!(!host.0.join("child-exited").exists());
        let s = parse(stdout.as_bytes(), &nonce).unwrap();
        assert_eq!(s.section("dfNfs").unwrap().exit, exit);
        assert_eq!(s.nfs, Err("NFS usage watchdog expired"));
        assert!(s.nfs_watchdog_expired);
        assert_eq!(s.local.unwrap().iter().map(row).collect::<Vec<_>>(), [LOCAL_ROW]);
        assert_eq!(df_trace(&trace), ["df -l -P -T", "timeout -s KILL 2 df -P -t nfs -t nfs4", "df -P -t nfs -t nfs4"]);
    }
}

#[test]
fn ordinary_nfs_errors_and_missing_utilities_are_not_indeterminate_and_recover() {
    let host = Host::new();
    host.install_timeout();
    for status in ["1", "126", "127"] {
        let (stdout, nonce, trace) = host.run(&[("NFS_STATUS", status), ("WHO_STATUS", "126")]);
        let s = parse(stdout.as_bytes(), &nonce).unwrap();
        assert_eq!(s.section("dfNfs").unwrap().exit.to_string(), status);
        assert_eq!(s.section("who").unwrap().rows(), Err("Permission denied"));
        assert!(s.nfs.is_err());
        assert!(!s.nfs_watchdog_expired);
        assert_eq!(s.local.unwrap().iter().map(row).collect::<Vec<_>>(), [LOCAL_ROW]);
        assert_eq!(df_trace(&trace), ["df -l -P -T", "timeout -s KILL 2 df -P -t nfs -t nfs4", "df -P -t nfs -t nfs4"]);
    }
    fs::remove_file(host.0.join("who")).unwrap();
    let (stdout, nonce, _) = host.run(&[]);
    let s = parse(stdout.as_bytes(), &nonce).unwrap();
    assert_eq!(s.section("who").unwrap().exit, 127);
    assert_eq!(s.section("who").unwrap().rows(), Err("Required utility unavailable"));
    assert!(!s.nfs_watchdog_expired);
    assert_eq!(s.nfs.unwrap().iter().map(row).collect::<Vec<_>>(), [NFS_ROW]);
}

#[cfg(target_os = "linux")]
#[test]
fn darwin_production_command_runs_with_absolute_utilities_under_dash_and_posix_sh() {
    let host = Host::new();
    let fixture = include_str!("../../fixtures/darwin.txt");
    let nonce = "07100000000000000000000000000001";
    let raw = parse(fixture.as_bytes(), nonce).unwrap();
    let mut binds = Vec::new();
    for (name, path, key) in [
        ("sw_vers", "/usr/bin/sw_vers", "swVers"), ("vm_stat", "/usr/bin/vm_stat", "vmstat"),
        ("netstat", "/usr/sbin/netstat", "netstat"), ("iostat", "/usr/sbin/iostat", "iostat"),
        ("who", "/usr/bin/who", "who"), ("mount", "/sbin/mount", "mounts"),
        ("date", "/bin/date", "now"), ("df", "/bin/df", "dfLocal"),
    ] {
        let data = raw.section(key).unwrap().rows().unwrap().join("
");
        host.utility(name, &format!("/bin/cat <<'DATA'
{data}
DATA"));
        binds.push(format!("{}:{path}", host.0.join(name).display()));
    }
    let mut sysctl = String::from("case \"$2\" in
");
    for (name, key) in [("hw.logicalcpu", "ncpu"), ("hw.memsize", "memsize"), ("hw.pagesize", "pagesize"), ("kern.boottime", "boottime"), ("vm.loadavg", "loadavg")] {
        sysctl.push_str(&format!("{name}) /bin/cat <<'DATA'
{}
DATA
;;
", raw.section(key).unwrap().rows().unwrap().join("
")));
    }
    sysctl.push_str("*) exit 1 ;;
esac");
    host.utility("sysctl", &sysctl);
    binds.push(format!("{}:/usr/sbin/sysctl", host.0.join("sysctl").display()));
    for (shell, flags) in [("/bin/dash", &[][..]), ("/bin/bash", &["--posix"][..])] {
        fs::write(host.0.join("trace"), "").unwrap();
        host.script("sh", &format!("printf 'collector-entry\n' >> \"$TRACE\"
exec {shell} {} \"$@\"", flags.join(" ")));
        let (command, n) = collector_command();
        let mut cmd = Command::new(find_executable("proot").expect("install proot"));
        for bind in &binds { cmd.arg("-b").arg(bind); }
        let output = cmd.arg(shell).args(flags).arg("-c").arg(&command)
            .env_clear().env("LD_LIBRARY_PATH", std::env::var_os("LD_LIBRARY_PATH").unwrap_or_default())
            .env("PATH", &host.0).env("PLATFORM", "Darwin").env("TRACE", host.0.join("trace"))
            .env("REAL_AWK", find_executable("awk").unwrap()).output().expect("install proot for absolute-path Darwin fixture");
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let sample = parse(&output.stdout, &n).unwrap();
        assert_eq!(sample.platform, Platform::Darwin);
        assert_eq!(sample.nfs.as_ref().unwrap(), &[]);
        assert_eq!(sample.local.as_ref().unwrap().len(), 4);
        assert_eq!(sample.section("iostat").unwrap().rows().unwrap().len(), 4);
        let trace = fs::read_to_string(host.0.join("trace")).unwrap();
        let calls: Vec<_> = trace.lines().filter(|line| !line.starts_with(&format!("{}/awk ", host.0.display()))).map(|line| line.strip_prefix(&format!("{}/", host.0.display())).unwrap_or(line).trim_end()).collect();
        assert_eq!(calls, ["collector-entry", "uname -s", "uname -n", "uname -m", "/usr/bin/sw_vers", "/usr/sbin/sysctl -n hw.logicalcpu", "/usr/sbin/sysctl -n hw.memsize", "/usr/sbin/sysctl -n hw.pagesize", "/usr/sbin/sysctl -n kern.boottime", "/bin/date -u +%s", "/usr/sbin/sysctl -n vm.loadavg", "/usr/bin/vm_stat", "/usr/sbin/netstat -ibn", "/usr/sbin/iostat -c 2 -w 1", "/usr/bin/who", "/sbin/mount", "/bin/df -P -l -k"]);
        assert_eq!(calls.iter().filter(|line| **line == "collector-entry").count(), 1);
        for (mount_body, expected_exit) in [("exit 1", 125), ("printf '%s\n' 'server:/share on /net (nfs)'", 127)] {
            host.utility("mount", mount_body);
            fs::write(host.0.join("trace"), "").unwrap();
            let mut cmd = Command::new(find_executable("proot").unwrap());
            for bind in &binds { cmd.arg("-b").arg(bind); }
            for path in ["/usr/local/bin/timeout", "/usr/local/bin/gtimeout", "/opt/homebrew/bin/timeout", "/opt/homebrew/bin/gtimeout"] { cmd.arg("-b").arg(format!("/dev/null:{path}")); }
            let output = cmd.arg(shell).args(flags).arg("-c").arg(&command).env_clear()
                .env("LD_LIBRARY_PATH", std::env::var_os("LD_LIBRARY_PATH").unwrap_or_default())
                .env("PATH", &host.0).env("PLATFORM", "Darwin").env("TRACE", host.0.join("trace"))
                .env("REAL_AWK", find_executable("awk").unwrap()).output().unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
            let sample = parse(&output.stdout, &n).unwrap();
            assert_eq!(sample.section("dfNfs").unwrap().exit, expected_exit);
            let trace = fs::read_to_string(host.0.join("trace")).unwrap();
            assert_eq!(trace.lines().filter(|s| s.contains("/bin/df ")).collect::<Vec<_>>(), ["/bin/df -P -l -k"]);
        }
        let mounts = raw.section("mounts").unwrap().rows().unwrap().join("
");
        host.utility("mount", &format!("/bin/cat <<'DATA'
{mounts}
DATA"));

    }
}

#[cfg(target_os = "linux")]
#[test]
fn production_command_runs_with_original_awk() {
    let host = Host::new();
    let original = find_executable("original-awk").expect("install original-awk (BWK) for production encoder coverage");
    host.utility("awk", &format!("exec '{}' \"$@\"", original.display()));
    let (command, nonce) = collector_command();
    let output = host.invoke(&command, &[]);
    assert_eq!(parse(output.as_bytes(), &nonce).unwrap().platform, Platform::Linux);
}
