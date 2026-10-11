//! Isolated, owned real processes. Never uses connect_or_spawn or production paths.
use super::*;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

pub(crate) fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

// Canonicalize even a missing leaf: junctions/symlinks in its parent still count.
pub(crate) fn canonical(path: &Path) -> PathBuf {
    if !path.is_absolute() {
        return canonical(&std::env::current_dir().unwrap().join(path));
    }
    if path.exists() {
        return path.canonicalize().expect("canonical path");
    }
    let parent = path.parent().expect("path has a parent");
    canonical(parent).join(path.file_name().expect("path has a name"))
}
fn components(path: &Path) -> Vec<String> {
    path.components()
        .map(|c| {
            let s = c.as_os_str().to_string_lossy().to_string();
            if cfg!(windows) {
                s.to_lowercase()
            } else {
                s
            }
        })
        .collect()
}
fn beneath(path: &Path, root: &Path) -> bool {
    components(path).starts_with(&components(root))
}

pub(crate) fn guard_path(path: &Path, temp: Option<&Path>) -> PathBuf {
    let p = canonical(path);
    let parts = components(&p);
    assert!(
        !parts
            .iter()
            .any(|s| s.to_lowercase().starts_with("target-pro-windows")),
        "unsafe Pro path: {}",
        p.display()
    );
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        assert!(
            !beneath(&p, &canonical(&PathBuf::from(local).join("TermFlow"))),
            "unsafe installed TermFlow path: {}",
            p.display()
        );
    }
    let r = canonical(&repo());
    let allowed = beneath(&p, &r.join("src-tauri/target"))
        || beneath(&p, &r.join("src-tauri/pty-host/target"))
        || (beneath(&p, &r.join(".claude/worktrees")) && parts.iter().any(|s| s == "target"))
        || temp.is_some_and(|t| beneath(&p, &canonical(t)));
    assert!(allowed, "unsafe path outside test roots: {}", p.display());
    p
}

pub(crate) fn prerequisite(message: &str) -> Option<PathBuf> {
    assert_ne!(
        std::env::var("TERMFLOW_E2E_REQUIRED").as_deref(),
        Ok("1"),
        "required real-process prerequisite missing: {message}"
    );
    eprintln!("skipping real-process test: {message}");
    None
}
/// Can a child of this process outlive it? Not when this process sits in a kill-on-close job that
/// refuses breakaway — which is how Cargo runs Windows test binaries. A host spawned from here then
/// inherits the job and rightly refuses every arm, so the arming tests could only fail. That is a
/// missing prerequisite, decided before any setup (D2), not an after-setup skip.
#[cfg(windows)]
pub(crate) fn children_can_outlive_this_process() -> Result<(), String> {
    #[repr(C)]
    struct BasicLimit {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }
    #[repr(C)]
    struct ExtendedLimit {
        basic: BasicLimit,
        io_counters: [u64; 6],
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> *mut core::ffi::c_void;
        fn IsProcessInJob(process: *mut core::ffi::c_void, job: *mut core::ffi::c_void, result: *mut i32) -> i32;
        fn QueryInformationJobObject(
            job: *mut core::ffi::c_void, class: i32, info: *mut core::ffi::c_void, len: u32, ret: *mut u32,
        ) -> i32;
    }
    const EXTENDED_LIMIT_INFORMATION: i32 = 9;
    const BREAKAWAY_OK: u32 = 0x0800;
    const SILENT_BREAKAWAY_OK: u32 = 0x1000;
    const KILL_ON_JOB_CLOSE: u32 = 0x2000;
    // SAFETY: plain Win32 queries on the current process and its own job; the buffer is a
    // correctly sized repr(C) JOBOBJECT_EXTENDED_LIMIT_INFORMATION.
    unsafe {
        let mut in_job = 0;
        if IsProcessInJob(GetCurrentProcess(), std::ptr::null_mut(), &mut in_job) == 0 {
            return Err("IsProcessInJob failed".into());
        }
        if in_job == 0 {
            return Ok(());
        }
        let mut info: ExtendedLimit = std::mem::zeroed();
        let mut ret = 0;
        if QueryInformationJobObject(
            std::ptr::null_mut(),
            EXTENDED_LIMIT_INFORMATION,
            &mut info as *mut _ as *mut core::ffi::c_void,
            std::mem::size_of::<ExtendedLimit>() as u32,
            &mut ret,
        ) == 0
        {
            return Err("QueryInformationJobObject failed".into());
        }
        let flags = info.basic.limit_flags;
        if flags & KILL_ON_JOB_CLOSE != 0 && flags & (BREAKAWAY_OK | SILENT_BREAKAWAY_OK) == 0 {
            return Err("this process runs in a kill-on-close job that refuses breakaway (Cargo runs Windows \
                        tests that way); run the built test executable outside it, see \
                        docs/ci/mcp-hold-real-process-tests.md"
                .into());
        }
        Ok(())
    }
}

#[cfg(not(windows))]
pub(crate) fn children_can_outlive_this_process() -> Result<(), String> {
    Ok(())
}

pub(crate) fn host_binary(variable: &str) -> Option<PathBuf> {
    let selected = if let Some(p) = std::env::var_os(variable) {
        PathBuf::from(p) // Explicit selection must NEVER fall back.
    } else if variable == "TERMFLOW_E2E_OLD_HOST_BIN" {
        return prerequisite("TERMFLOW_E2E_OLD_HOST_BIN is not set");
    } else {
        let name = if cfg!(windows) {
            "termflow-pty-host.exe"
        } else {
            "termflow-pty-host"
        };
        let shared = repo().join("src-tauri/target/debug").join(name);
        if shared.exists() {
            shared
        } else {
            repo().join("src-tauri/pty-host/target/debug").join(name)
        }
    };
    let selected = guard_path(&selected, None);
    if !selected.is_file() {
        return prerequisite(&format!(
            "{variable}: {} is missing (no fallback)",
            selected.display()
        ));
    }
    Some(selected)
}

pub(crate) fn bun_binary() -> Option<PathBuf> {
    let name = if cfg!(windows) { "bun.exe" } else { "bun" };
    let bin = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .map(|p| p.join(name))
        .find(|p| p.is_file());
    let Some(bin) = bin else {
        return prerequisite("bun is not on PATH");
    };
    let bin = bin.canonicalize().expect("canonical Bun runtime");
    let mut version = OwnedChild(
        Command::new(&bin)
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("Bun version child"),
    );
    let end = std::time::Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(status) = version.0.try_wait().expect("Bun version status") {
            assert!(status.success());
            break;
        }
        assert!(std::time::Instant::now() < end, "Bun version timeout");
        std::thread::sleep(Duration::from_millis(10));
    }
    let mut text = String::new();
    std::io::Read::read_to_string(&mut version.0.stdout.take().unwrap(), &mut text).unwrap();
    eprintln!("real-process Bun {} ({})", text.trim(), bin.display());
    if !repo().join("mcp-server/node_modules").is_dir() {
        return prerequisite("mcp-server/node_modules is missing");
    }
    Some(bin)
}

pub(crate) struct TestDir(PathBuf);
impl TestDir {
    pub(crate) fn new() -> Self {
        let root = canonical(&std::env::temp_dir());
        let p = root.join(format!("tf-e2e-057-{}", uuid::Uuid::new_v4()));
        guard_path(&p, Some(&root)); // Before file creation.
        std::fs::create_dir(&p).expect("private test directory");
        Self(p)
    }
    pub(crate) fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub(crate) struct OwnedChild(pub(crate) Child);
impl std::ops::Deref for OwnedChild {
    type Target = Child;
    fn deref(&self) -> &Child {
        &self.0
    }
}
impl std::ops::DerefMut for OwnedChild {
    fn deref_mut(&mut self) -> &mut Child {
        &mut self.0
    }
}
impl OwnedChild {
    pub(crate) async fn wait(&mut self, within: Duration) -> bool {
        let end = tokio::time::Instant::now() + within;
        loop {
            if self.0.try_wait().expect("owned child status").is_some() {
                return true;
            }
            if tokio::time::Instant::now() >= end {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}
impl Drop for OwnedChild {
    fn drop(&mut self) {
        // No process lookup, no kill-by-name. Only the child this guard spawned.
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
        }
        let end = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            if self.0.try_wait().ok().flatten().is_some() {
                break;
            }
            if std::time::Instant::now() >= end {
                if std::thread::panicking() {
                    eprintln!("owned child cleanup timed out: {}", self.0.id());
                } else {
                    panic!("owned child cleanup timed out: {}", self.0.id());
                }
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

pub(crate) struct RealHost {
    pub(crate) child: OwnedChild,
    pub(crate) endpoint: String,
    pub(crate) bin: PathBuf,
    pub(crate) token: String,
    pub(crate) record: PathBuf,
    pub(crate) log: PathBuf,
    _dir: TestDir,
}
impl RealHost {
    /// Ungated: the caller holds child_process_gate once for the whole rig.
    pub(crate) fn spawn(bin: &Path, token: &str) -> Self {
        let bin = guard_path(bin, None);
        let dir = TestDir::new();
        let id = uuid::Uuid::new_v4().simple().to_string();
        let endpoint = if cfg!(windows) {
            format!(r"\\.\pipe\tf-e2e-{id}")
        } else {
            dir.path().join("h.sock").to_string_lossy().into_owned()
        };
        let record = guard_path(&dir.path().join("record.json"), Some(dir.path()));
        let log = guard_path(&dir.path().join("host.log"), Some(dir.path()));
        let file = std::fs::File::create(&log).expect("private host log");
        let base = || {
            let mut c = Command::new(&bin);
            c.env("TERMFLOW_PTY_PIPE", &endpoint)
                .env("TERMFLOW_PTY_TOKEN", token)
                .env("TERMFLOW_PTY_RECORD", &record)
                .current_dir(dir.path())
                .stdin(Stdio::null())
                .stdout(file.try_clone().unwrap())
                .stderr(file.try_clone().unwrap());
            c
        };
        #[cfg(windows)]
        let child = {
            use std::os::windows::process::CommandExt;
            base()
                .creation_flags(0x0000_0008 | 0x0100_0000)
                .spawn()
                .or_else(|_| base().creation_flags(0x0000_0008).spawn())
                .expect("detached test host")
        };
        #[cfg(unix)]
        let child = {
            use std::os::unix::process::CommandExt;
            let mut c = base();
            // SAFETY: only async-signal-safe setsid in the fork child.
            unsafe {
                c.pre_exec(|| {
                    if libc::setsid() < 0 {
                        Err(std::io::Error::last_os_error())
                    } else {
                        Ok(())
                    }
                });
            }
            c.spawn().expect("detached test host")
        };
        Self {
            child: OwnedChild(child),
            endpoint,
            bin,
            token: token.into(),
            record,
            log,
            _dir: dir,
        }
    }
    pub(crate) async fn connect(&self) -> PtyHostClient {
        let (mut deps, _) = conn_tests::deps();
        deps.lifecycle_token = self.token.clone();
        let client = connect_only(&self.endpoint, self.child.0.id(), deps)
            .await
            .expect("connect-only to owned host");
        self.capabilities(&client).await;
        client
    }
    pub(crate) async fn capabilities(&self, client: &PtyHostClient) {
        let end = tokio::time::Instant::now() + Duration::from_secs(5);
        let record = loop {
            if let Ok(bytes) = std::fs::read(&self.record) {
                if let Ok(r) = serde_json::from_slice::<termflow_pty_protocol::HostRecord>(&bytes) {
                    break r;
                }
            }
            assert!(
                tokio::time::Instant::now() < end,
                "owned host did not advertise"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        };
        assert_eq!(
            record.pid,
            self.child.0.id(),
            "capabilities must describe our child"
        );
        client.set_mcp_hold(record.capabilities & termflow_pty_protocol::CAP_MCP_HOLD != 0);
        client.set_attach_acks(record.capabilities & termflow_pty_protocol::CAP_ATTACH_ACK != 0);
    }
}

/// Test-only opener: gone/unreachable means error, never spawn fallback.
pub(crate) async fn connect_only(
    endpoint: &str,
    pid: u32,
    deps: PtyHostDeps,
) -> std::io::Result<PtyHostClient> {
    #[cfg(windows)]
    let outcome = open_with_grace(
        || std::future::ready(tokio::net::windows::named_pipe::ClientOptions::new().open(endpoint)),
        live_host_probe(Some(pid)),
        OPEN_GRACE_SHORT,
        OPEN_GRACE_LONG,
        OPEN_GRACE_STEP,
    )
    .await;
    #[cfg(unix)]
    let outcome = tokio::time::timeout(
        OPEN_GRACE_LONG + OPEN_GRACE_STEP,
        open_with_grace(
            || tokio::net::UnixStream::connect(endpoint),
            live_host_probe(Some(pid)),
            OPEN_GRACE_SHORT,
            OPEN_GRACE_LONG,
            OPEN_GRACE_STEP,
        ),
    )
    .await
    .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "owned Unix socket open timed out"))?;
    let OpenOutcome::Connected(stream) = outcome else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotConnected,
            "owned host gone or unreachable; no spawn fallback",
        ));
    };
    #[cfg(windows)]
    let client = wire_pipe_client(stream, deps);
    #[cfg(unix)]
    let client = {
        let (rd, wr) = tokio::io::split(stream);
        wire_client(rd, wr, deps)
    };
    Ok(client)
}

#[test]
fn production_and_pro_paths_are_refused_even_when_missing() {
    for path in [
        repo().join("target-pro-windows-private/missing.exe"),
        repo().join("outside/missing.exe"),
    ] {
        assert!(std::panic::catch_unwind(|| guard_path(&path, None)).is_err());
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        assert!(std::panic::catch_unwind(|| guard_path(
            &PathBuf::from(local).join("TermFlow/missing.exe"),
            None
        ))
        .is_err());
    }
}

// The shared process-inspection gate intentionally outlives every owned child.
#[cfg(any(windows, target_os = "linux"))]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn explicit_missing_selection_fails_when_required_and_skips_otherwise() {
    use std::io::Read;
    let _gate = test_dirs::child_process_gate();
    let exe = guard_path(&std::env::current_exe().unwrap(), None);
    let missing = repo().join("src-tauri/target/debug/057-no-such-host.exe");
    assert!(!missing.exists());
    for required in [false, true] {
        let mut command = Command::new(&exe);
        command
            .args([
                "state::mcp_hold_e2e::handover::smoke_real_host_and_sidecar",
                "--exact",
                "--nocapture",
            ])
            .env("TERMFLOW_PTY_HOST_BIN", &missing)
            .env_remove("TERMFLOW_E2E_REQUIRED")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if required {
            command.env("TERMFLOW_E2E_REQUIRED", "1");
        }
        let mut child = OwnedChild(command.spawn().unwrap());
        assert!(
            child.wait(Duration::from_secs(5)).await,
            "bounded negative-control child"
        );
        let status = child.0.try_wait().unwrap().unwrap();
        let mut output = String::new();
        child
            .0
            .stdout
            .take()
            .unwrap()
            .read_to_string(&mut output)
            .unwrap();
        child
            .0
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut output)
            .unwrap();
        assert_eq!(
            status.success(),
            !required,
            "explicit missing override must never fall back: {output}"
        );
        assert!(
            output.contains(if required {
                "required real-process prerequisite missing"
            } else {
                "skipping real-process test"
            }),
            "{output}"
        );
        assert!(output.contains("no fallback"), "{output}");
        eprintln!("negative selection required={required}: {output}");
    }
}
