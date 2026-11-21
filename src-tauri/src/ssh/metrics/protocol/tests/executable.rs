use super::*;
use crate::ssh::metrics::{collector_command, encode};
use std::fs::{self, DirBuilder};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

struct Host(PathBuf);

impl Host {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("tf-metrics-{}", uuid::Uuid::new_v4()));
        DirBuilder::new().mode(0o700).create(&root).unwrap();
        let host = Self(root);
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
        host.utility("who", "exit \"$WHO_STATUS\"");
        host.utility("sentinel", "printf 'executed' > sentinel-ran");
        host.utility("df", r#"
[ "$LC_ALL:$LANG:$TZ:$DF_BLOCK_SIZE:$BLOCK_SIZE:$BLOCKSIZE" = C:C:UTC:1024:1024:1024 ] || exit 91
case "$*" in
    '-l -P -T')
        if [ "$FALLBACK" = no ]; then printf '%s' "$LOCAL"; else printf 'failed typed stdout\n'; exit 1; fi ;;
    '-l -P') [ "$FALLBACK" != unsupported ] || exit 1
        printf 'Filesystem 1K-blocks Used Available Use%% Mounted on\n/dev/vda\n   100 30 60 34%% /\n' ;;
    '-P -t nfs -t nfs4')
        [ "$GUARDED" = yes ] || exit 92
        printf '%s' "$NFS"
        if [ "$TIMEOUT_MODE" = expire124 ] || [ "$TIMEOUT_MODE" = expire137 ]; then
            # Model a child outside channel/watchdog cleanup. It publishes
            # readiness, then lives until the test releases it (bounded).
            (
                : > child-ready
                for attempt in 1 2 3 4 5 6 7 8 9 10; do
                    [ ! -f child-release ] || break
                    nap 0.2
                done
                : > child-exited
            ) </dev/null >/dev/null 2>&1 &
            for attempt in 1 2 3 4 5 6 7 8 9 10; do
                [ ! -f child-ready ] || break
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
        let path = self.0.join(name);
        fs::write(&path, format!("#!/bin/sh\nprintf '%s\\n' \"$0 $*\" >> \"$TRACE\"\n{body}\n")).unwrap();
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
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg(command).current_dir(&self.0).env_clear()
            .env("PATH", &self.0).env("TRACE", self.0.join("trace"))
            .envs([
                ("PLATFORM", "Linux"), ("OS_RELEASE", "NAME='Test Linux'\nVERSION_ID=11"),
                ("FALLBACK", "no"), ("MOUNTS", MOUNTS), ("LOCAL", LOCAL), ("NFS", NFS),
                ("TIMEOUT_MODE", "return"), ("NFS_STATUS", "0"), ("WHO_STATUS", "0"),
            ]);
        for &(key, value) in env {
            cmd.env(key, value);
        }
        self.utility("sh", "printf 'collector-entry\\n' >> \"$TRACE\"\nexec /bin/sh -x \"$@\"");
        // Don't put general host utilities (including ssh) on the fake PATH.
        self.utility("nap", "exec /bin/sleep \"$@\"");
        fs::write(self.0.join("trace"), "").unwrap();
        let out = cmd.output().expect("POSIX /bin/sh is required for collector controls");
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(out.status.success(), "shell failed: {stderr}");
        // An absolute '. /etc/os-release' would bypass PATH (and the fake cat).
        assert!(!stderr.lines().any(|line| line.starts_with("+ . ") || line.starts_with("+ source ")),
            "collector attempted to source data");
        String::from_utf8(out.stdout).unwrap()
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

pub(super) fn darwin_has_no_proc_trace() {
    let host = Host::new();
    let (stdout, nonce, trace) = host.run(&[("PLATFORM", "Darwin")]);
    assert_darwin(&parse(stdout.as_bytes(), &nonce).unwrap());
    let utilities: Vec<_> = trace.iter().filter(|line| !line.starts_with("sh ") && *line != "collector-entry").map(String::as_str).collect();
    assert_eq!(utilities, ["uname -s", "uname -n", "uname -m"]);
}

#[test]
fn real_collector_darwin_has_no_proc_trace() {
    darwin_has_no_proc_trace();
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
    let literal = "It's $literal $(sentinel) `sentinel`\nsecond line";
    let body = "printf '%s\\n%s\\n' 'It'\"'\"'s $literal $(sentinel) `sentinel`\nsecond line' \"$1\"";
    assert!(encode("'; sentinel #", body).is_none());
    assert_eq!(host.invoke(&encode(NONCE, body).unwrap(), &[]), format!("{literal}\n{NONCE}\n"));
    assert!(!host.0.join("sentinel-ran").exists());
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
    let (stdout, nonce, trace) = host.run(&[("FALLBACK", "unsupported")]);
    let s = parse(stdout.as_bytes(), &nonce).unwrap();
    assert!(s.local.is_err());
    assert_eq!(s.nfs.unwrap().iter().map(row).collect::<Vec<_>>(), [NFS_ROW]);
    assert_eq!(df_trace(&trace), ["df -l -P -T", "df -l -P", "timeout -s KILL 2 df -P -t nfs -t nfs4", "df -P -t nfs -t nfs4"]);
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
        assert!(start.elapsed() < Duration::from_secs(5));
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
