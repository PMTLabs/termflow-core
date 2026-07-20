//! GUI-side client for the PTY-host sidecar (Windows named pipe).
//!
//! Design:
//! - Fire-and-forget ops (stdin/resize/close/attach) are pushed onto an
//!   outbound channel and written by a background task, so synchronous Tauri
//!   command / API call sites never block on the pipe.
//! - Request/response ops (spawn→pid, list→sessions, arm→ack) carry a `req` id
//!   and await a oneshot resolved by the inbound reader task.
//! - Inbound `Stdout` is fed into the EXISTING `output_tx` broadcast (and bumps
//!   `output_produced` so the pipeline watchdog heartbeat holds), so every
//!   downstream processor — vt100 parser, history, coalesced emit — is
//!   untouched. `Exit`/`Gap` fire injected callbacks (cleanup+emit / repaint).
//!
//! The client depends on a few concrete pieces (not `AppState`) so it is
//! testable without the Windows `mock_app` crash and avoids an Arc cycle.

use crate::state::ChannelPayload;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use termflow_pty_protocol::{Control, Data, Frame, Response, SessionMeta, SpawnSpec};
use tokio::sync::broadcast;
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tokio::sync::oneshot;

/// Injected dependencies so the client stays decoupled from `AppState`.
#[derive(Clone)]
pub struct PtyHostDeps {
    pub output_tx: broadcast::Sender<ChannelPayload>,
    pub output_produced: Arc<AtomicU64>,
    /// Called on child exit: (tab_id, exit_cwd). Wire to cleanup + terminal:exit.
    pub on_exit: Arc<dyn Fn(String, Option<String>) + Send + Sync>,
    /// Called on an output discontinuity: (tab_id). Wire to a repaint nudge.
    pub on_gap: Arc<dyn Fn(String) + Send + Sync>,
    /// Called when the pipe closes unexpectedly (sidecar died / connection
    /// lost). Wire to surface a SessionClosedBanner on every host-owned pane.
    pub on_disconnect: Arc<dyn Fn() + Send + Sync>,
}

type PendingMap = Arc<Mutex<HashMap<u64, oneshot::Sender<Response>>>>;

/// True when the opt-in PTY-host sidecar path is active (Windows-only).
pub fn enabled() -> bool {
    cfg!(windows) && std::env::var("TERMFLOW_PTY_HOST").as_deref() == Ok("1")
}

#[derive(Clone)]
pub struct PtyHostClient {
    outbound: UnboundedSender<Frame>,
    pending: PendingMap,
    req_ctr: Arc<AtomicU64>,
    /// False if the sidecar had to be spawned WITHOUT `CREATE_BREAKAWAY_FROM_JOB`
    /// (a kill-on-close job denied breakaway) — hot-swap survival is then NOT
    /// guaranteed, so `restart_for_update` must refuse to arm.
    survives_hotswap: Arc<std::sync::atomic::AtomicBool>,
}

impl PtyHostClient {
    fn next_req(&self) -> u64 {
        self.req_ctr.fetch_add(1, Ordering::Relaxed)
    }

    /// Whether a hot-swap can be trusted to keep sessions alive (see field doc).
    pub fn survives_hotswap(&self) -> bool {
        self.survives_hotswap.load(Ordering::Acquire)
    }

    // --- fire-and-forget (sync-callable from command/API sites) ---

    pub fn write_stdin(&self, tab_id: &str, bytes: &[u8]) {
        let _ = self.outbound.send(Frame::Data(Data::Stdin {
            tab_id: tab_id.to_string(),
            bytes: bytes.to_vec(),
        }));
    }

    pub fn resize(&self, tab_id: &str, cols: u16, rows: u16) {
        let _ = self.outbound.send(Frame::Ctrl(Control::Resize {
            tab_id: tab_id.to_string(),
            cols,
            rows,
        }));
    }

    pub fn close(&self, tab_id: &str) {
        let _ = self.outbound.send(Frame::Ctrl(Control::Close {
            tab_id: tab_id.to_string(),
        }));
    }

    /// Force a repaint of a host-owned program by nudging the size and
    /// restoring it (the local `repaint_all_terminals` can't — there is no
    /// local master). Used on Gap and on reattach.
    pub fn nudge_repaint(&self, tab_id: &str, cols: u16, rows: u16) {
        let jiggle_rows = rows.saturating_sub(1).max(1);
        self.resize(tab_id, cols, jiggle_rows);
        self.resize(tab_id, cols, rows);
    }

    pub fn attach(&self, tab_id: &str, from_offset: u64) {
        let req = self.next_req();
        let _ = self.outbound.send(Frame::Ctrl(Control::Attach {
            req,
            tab_id: tab_id.to_string(),
            from_offset,
        }));
    }

    // --- request/response (async) ---

    async fn request(&self, make: impl FnOnce(u64) -> Control) -> Option<Response> {
        let req = self.next_req();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(req, tx);
        if self.outbound.send(Frame::Ctrl(make(req))).is_err() {
            self.pending.lock().unwrap().remove(&req);
            return None;
        }
        // Bounded wait so a dead sidecar can't hang a caller forever.
        match tokio::time::timeout(std::time::Duration::from_secs(10), rx).await {
            Ok(Ok(resp)) => Some(resp),
            _ => {
                self.pending.lock().unwrap().remove(&req);
                None
            }
        }
    }

    /// Spawn a session; returns the child PID on success.
    pub async fn spawn_session(&self, tab_id: &str, spec: &SpawnSpec) -> Result<u32, String> {
        let tab = tab_id.to_string();
        let spec = spec.clone();
        match self
            .request(move |req| Control::Spawn {
                req,
                tab_id: tab,
                spec,
            })
            .await
        {
            Some(Response::Spawned { pid, .. }) => Ok(pid),
            Some(Response::SpawnFailed { error, .. }) => Err(error),
            _ => Err("pty-host: no response to spawn".to_string()),
        }
    }

    pub async fn list_sessions(&self) -> Vec<SessionMeta> {
        match self.request(|req| Control::ListSessions { req }).await {
            Some(Response::SessionList { sessions, .. }) => sessions,
            _ => Vec::new(),
        }
    }

    /// Arm the hot-swap hold; returns the epoch-ms deadline on ack.
    pub async fn arm_detach(&self, timeout_secs: u64, token: &str) -> Result<u64, String> {
        let token = token.to_string();
        match self
            .request(move |req| Control::ArmDetach {
                req,
                timeout_secs,
                token,
            })
            .await
        {
            Some(Response::ArmAck { deadline_ms, .. }) => Ok(deadline_ms),
            _ => Err("pty-host: no ArmAck".to_string()),
        }
    }

    pub async fn disarm(&self) {
        let _ = self.request(|req| Control::Disarm { req }).await;
    }
}

/// Build a client around already-connected pipe halves. Split out so tests can
/// drive it over an in-memory duplex without a real named pipe.
#[cfg(windows)]
pub fn wire_client<R, W>(rd: R, wr: W, deps: PtyHostDeps) -> PtyHostClient
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
    W: tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    use termflow_pty_protocol::{read_frame, write_frame};

    let (outbound, mut out_rx) = unbounded_channel::<Frame>();
    let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
    let req_ctr = Arc::new(AtomicU64::new(1));

    // Writer task.
    tokio::spawn(async move {
        let mut wr = wr;
        while let Some(f) = out_rx.recv().await {
            if write_frame(&mut wr, &f).await.is_err() {
                break;
            }
        }
    });

    // Reader task.
    let pending_r = pending.clone();
    tokio::spawn(async move {
        let mut rd = rd;
        loop {
            match read_frame(&mut rd).await {
                Ok(Some(Frame::Data(Data::Stdout { tab_id, bytes, .. }))) => {
                    let _ = deps.output_tx.send(ChannelPayload {
                        id: tab_id,
                        data: bytes,
                    });
                    deps.output_produced.fetch_add(1, Ordering::Relaxed);
                }
                Ok(Some(Frame::Data(Data::Gap { tab_id, .. }))) => {
                    (deps.on_gap)(tab_id);
                }
                Ok(Some(Frame::Data(Data::Exit { tab_id, exit_cwd }))) => {
                    (deps.on_exit)(tab_id, exit_cwd);
                }
                Ok(Some(Frame::Resp(resp))) => {
                    let req = resp_req(&resp);
                    if let Some(tx) = pending_r.lock().unwrap().remove(&req) {
                        let _ = tx.send(resp);
                    }
                }
                Ok(Some(_)) => {} // GUI never receives Ctrl / Stdin
                Ok(None) | Err(_) => break, // pipe closed
            }
        }
        // Pipe closed: surface the loss so host-owned panes don't hang silently.
        (deps.on_disconnect)();
    });

    PtyHostClient {
        outbound,
        pending,
        req_ctr,
        survives_hotswap: Arc::new(std::sync::atomic::AtomicBool::new(true)),
    }
}

/// Connect to the sidecar's pipe, spawning it (detached, breaking away from any
/// kill-on-close job) if it isn't already running.
#[cfg(windows)]
pub async fn connect_or_spawn(
    sidecar: &std::path::Path,
    pipe: &str,
    token: &str,
    deps: PtyHostDeps,
) -> std::io::Result<PtyHostClient> {
    use std::time::Duration;
    use tokio::net::windows::named_pipe::ClientOptions;

    let mut survives = true;
    let conn = match ClientOptions::new().open(pipe) {
        Ok(c) => c,
        Err(_) => {
            // No sidecar yet → spawn it, then retry-connect with backoff.
            survives = spawn_sidecar_detached(sidecar, pipe, token)?;
            let mut conn = None;
            for _ in 0..40 {
                tokio::time::sleep(Duration::from_millis(150)).await;
                if let Ok(c) = ClientOptions::new().open(pipe) {
                    conn = Some(c);
                    break;
                }
            }
            conn.ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "pty-host sidecar did not open its pipe",
                )
            })?
        }
    };
    let (rd, wr) = tokio::io::split(conn);
    let client = wire_client(rd, wr, deps);
    client
        .survives_hotswap
        .store(survives, std::sync::atomic::Ordering::Release);
    Ok(client)
}

/// Spawn the sidecar detached from the GUI's lifetime. Returns whether it broke
/// away from a job (i.e. whether hot-swap survival can be trusted). Falls back
/// to spawning WITHOUT breakaway (still runs, but won't survive a kill-on-close
/// job) rather than failing outright.
#[cfg(windows)]
fn spawn_sidecar_detached(
    sidecar: &std::path::Path,
    pipe: &str,
    token: &str,
) -> std::io::Result<bool> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;

    let base = || {
        let mut c = Command::new(sidecar);
        c.env("TERMFLOW_PTY_PIPE", pipe)
            .env("TERMFLOW_PTY_TOKEN", token)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        c
    };

    // Prefer breaking away from any kill-on-close job so the sidecar outlives
    // the GUI. If the job denies breakaway, CreateProcess fails with that flag;
    // fall back to a non-broken-away spawn and report survival as unavailable.
    match base()
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB)
        .spawn()
    {
        Ok(_) => Ok(true),
        Err(_) => {
            base()
                .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
                .spawn()?;
            log::warn!(
                "pty-host: spawned WITHOUT job breakaway; hot-swap survival not guaranteed"
            );
            Ok(false)
        }
    }
}

/// Non-Windows stub: the sidecar path is Windows-only in milestone A. The flag
/// gate forces off elsewhere, so this is never reached at runtime.
#[cfg(not(windows))]
pub async fn connect_or_spawn(
    _sidecar: &std::path::Path,
    _pipe: &str,
    _token: &str,
    _deps: PtyHostDeps,
) -> std::io::Result<PtyHostClient> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "pty-host sidecar is Windows-only in milestone A",
    ))
}

/// Per-user pipe name so two users on one machine never collide. `dev` vs
/// `release` is distinguished by the debug_assertions flag.
pub fn resolve_pipe() -> String {
    let user = std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "user".to_string());
    let chan = if cfg!(debug_assertions) { "dev" } else { "rel" };
    format!(r"\\.\pipe\termflow-pty-host.{user}.{chan}")
}

/// A launch token shared by all app instances (persisted to a per-user temp
/// file) so a hot-swapped instance can still arm the SAME running sidecar.
/// Created on first use. Same trust scope as the owner-only pipe.
pub fn resolve_token() -> String {
    if let Ok(t) = std::env::var("TERMFLOW_PTY_TOKEN") {
        if !t.is_empty() {
            return t;
        }
    }
    let user = std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "user".to_string());
    let path = std::env::temp_dir().join(format!("termflow-pty-host-{user}.token"));
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let t = existing.trim().to_string();
        if !t.is_empty() {
            return t;
        }
    }
    let token = uuid::Uuid::new_v4().to_string();
    let _ = std::fs::write(&path, &token);
    token
}

/// Locate the sidecar binary, in priority order:
/// 1. `TERMFLOW_PTY_HOST_BIN` explicit override.
/// 2. Next to the app executable (release / staged).
/// 3. Dev build locations under `pty-host/target/{release,debug}` resolved
///    both relative to the exe (`src-tauri/target/debug/…`) and to the cwd —
///    so `bun run dev` finds it with no env var once the sidecar is built.
pub fn resolve_sidecar_path() -> Option<std::path::PathBuf> {
    let name = if cfg!(windows) {
        "termflow-pty-host.exe"
    } else {
        "termflow-pty-host"
    };

    // 1. Explicit override.
    if let Ok(p) = std::env::var("TERMFLOW_PTY_HOST_BIN") {
        let pb = std::path::PathBuf::from(p);
        if pb.exists() {
            return Some(pb);
        }
    }

    let mut candidates: Vec<std::path::PathBuf> = Vec::new();

    // 2. Next to the app exe (release / staged) and 3a. dev, relative to the exe
    //    (exe is typically at src-tauri/target/{debug,release}/).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(name)); // staged next to app
            // src-tauri/target/<profile>/ -> ../../pty-host/target/{release,debug}/
            for profile in ["release", "debug"] {
                candidates.push(
                    dir.join("..")
                        .join("..")
                        .join("pty-host")
                        .join("target")
                        .join(profile)
                        .join(name),
                );
            }
        }
    }

    // 3b. Dev, relative to the working directory (repo root or src-tauri).
    if let Ok(cwd) = std::env::current_dir() {
        for base in [
            cwd.join("src-tauri").join("pty-host"),
            cwd.join("pty-host"),
        ] {
            for profile in ["release", "debug"] {
                candidates.push(base.join("target").join(profile).join(name));
            }
        }
    }

    candidates.into_iter().find(|p| p.exists())
}

fn resp_req(r: &Response) -> u64 {
    match r {
        Response::Spawned { req, .. }
        | Response::SpawnFailed { req, .. }
        | Response::SessionList { req, .. }
        | Response::ArmAck { req, .. }
        | Response::DisarmAck { req } => *req,
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;
    use termflow_pty_protocol::{read_frame, write_frame};

    fn deps() -> (
        PtyHostDeps,
        broadcast::Receiver<ChannelPayload>,
        Arc<AtomicU64>,
    ) {
        let (tx, rx) = broadcast::channel(256);
        let produced = Arc::new(AtomicU64::new(0));
        let deps = PtyHostDeps {
            output_tx: tx,
            output_produced: produced.clone(),
            on_exit: Arc::new(|_, _| {}),
            on_gap: Arc::new(|_| {}),
            on_disconnect: Arc::new(|| {}),
        };
        (deps, rx, produced)
    }

    #[tokio::test]
    async fn stdout_frames_reach_output_tx_and_bump_watchdog() {
        // Wire the client to one end of a duplex; feed Stdout from the other.
        let (client_side, server_side) = tokio::io::duplex(64 * 1024);
        let (crd, cwr) = tokio::io::split(client_side);
        let (mut srd, mut swr) = tokio::io::split(server_side);

        let (deps, mut rx, produced) = deps();
        let _client = wire_client(crd, cwr, deps);

        // Server pushes a Stdout frame to the client.
        write_frame(
            &mut swr,
            &Frame::Data(Data::Stdout {
                tab_id: "t1".into(),
                offset: 0,
                bytes: b"hello".to_vec(),
            }),
        )
        .await
        .unwrap();

        let payload = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(payload.id, "t1");
        assert_eq!(payload.data, b"hello");
        assert!(produced.load(Ordering::Relaxed) >= 1);
        let _ = (&mut srd,); // keep server read half alive
    }

    #[tokio::test]
    async fn spawn_request_resolves_on_spawned_response() {
        let (client_side, server_side) = tokio::io::duplex(64 * 1024);
        let (crd, cwr) = tokio::io::split(client_side);
        let (mut srd, mut swr) = tokio::io::split(server_side);

        let (deps, _rx, _p) = deps();
        let client = wire_client(crd, cwr, deps);

        // Server: read the Spawn control, reply Spawned with its req id.
        let server = tokio::spawn(async move {
            if let Ok(Some(Frame::Ctrl(Control::Spawn { req, tab_id, .. }))) =
                read_frame(&mut srd).await
            {
                write_frame(
                    &mut swr,
                    &Frame::Resp(Response::Spawned {
                        req,
                        tab_id,
                        pid: 4321,
                    }),
                )
                .await
                .unwrap();
            }
        });

        let spec = SpawnSpec {
            shell: "cmd.exe".into(),
            args: vec![],
            env: vec![],
            env_remove: vec![],
            cwd: None,
            cols: 80,
            rows: 24,
        };
        let pid = client.spawn_session("t1", &spec).await.unwrap();
        assert_eq!(pid, 4321);
        server.await.unwrap();
    }
}
