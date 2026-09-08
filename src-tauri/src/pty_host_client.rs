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
    /// Per-profile credential used to authenticate the first reconnect
    /// lifecycle probe to a held host.
    pub lifecycle_token: String,
    pub output_tx: broadcast::Sender<ChannelPayload>,
    pub output_produced: Arc<AtomicU64>,
    /// Called on child exit: `(process_id, session_key, exit_cwd)`.
    /// Wire to cleanup + terminal:exit.
    ///
    /// Takes BOTH ids because the two are no longer the same string (design 014
    /// §A1) and the exit path needs each for a different map: `process_id` keys
    /// the terminal/screen/cwd state, while `session_key` keys the host's own
    /// ring bookkeeping (`host_stream_offsets`).
    pub on_exit: Arc<dyn Fn(String, String, Option<String>) + Send + Sync>,
    /// Called on an output discontinuity: `(process_id)`. Wire to a repaint nudge.
    pub on_gap: Arc<dyn Fn(String) + Send + Sync>,
    /// pty-host session key → this run's process id.
    ///
    /// The host tags every inbound frame with its OWN session key, but our maps
    /// are keyed by process id. Injected rather than read from `AppState` so this
    /// module stays decoupled (and unit-testable without a Tauri AppHandle).
    pub resolve_process: Arc<dyn Fn(&str) -> Option<String> + Send + Sync>,
    /// Called when the pipe closes unexpectedly (sidecar died / connection
    /// lost). Wire to surface a SessionClosedBanner on every host-owned pane.
    pub on_disconnect: Arc<dyn Fn() + Send + Sync>,
    /// tab_id → next expected stdout ring offset (last `Stdout.offset + len`).
    /// Owned by `AppState` so it survives a client generation: after a pipe
    /// drop, the in-place reconnect reattaches each session from this offset
    /// and the ring replays exactly the bytes missed while disconnected.
    pub stream_offsets: Arc<dashmap::DashMap<String, u64>>,
}

type PendingMap = Arc<Mutex<HashMap<u64, oneshot::Sender<Response>>>>;

/// Map a pty-host session key to the process id our maps are keyed by.
///
/// Returns `None` for an unknown session, and every caller DROPS that frame.
/// Falling back to the raw session key is precisely what design 014 §A2 exists
/// to remove: it would route a stale session's bytes into whatever map entry
/// happens to share its name — the silent mis-routing that made a tab id and a
/// terminal id indistinguishable in the first place.
///
/// A thin wrapper over the lookup on purpose: it gives the routing rule a name
/// and a test, so the "never fall back" decision is pinned somewhere rather than
/// living implicitly in three call sites.
pub(crate) fn route_inbound(
    session_key: &str,
    lookup: impl Fn(&str) -> Option<String>,
) -> Option<String> {
    lookup(session_key)
}

/// True when the PTY-host sidecar path is active.
///
/// **Default-on** on every supported OS, in dev and release, so shells are
/// host-owned (and survive an app update / offload) out of the box.
/// `TERMFLOW_PTY_HOST=0` is the kill-switch, `=1` also forces on.
///
/// Unix used to be opt-in (`=1`) pending the packaged sidecar binary and plan
/// 003 RP-8 (installed, signed, failure-injection smoke). The binary half is
/// done — `tauri.pro.conf.json` bundles `binaries/termflow-pty-host` and
/// `publish-macos.sh` fails the build if it is missing from the `.app` — and
/// the exact configuration this flip makes default (Unix, sidecar on) already
/// passed an end-to-end hot-swap on real macOS. RP-8 itself has never run on
/// ANY OS, so leaving Unix off did not buy coverage Windows had; it only meant
/// Settings → Offload/Update refused with "pty-host not connected" on macOS
/// while Windows worked. Flipped on the maintainer's explicit instruction —
/// the same call already recorded for Windows in review 060 row 5, where the
/// in-process fallback is what contains the blast radius. RP-8 remains open and
/// still gates nothing else.
///
/// The automatic in-process fallback still covers a missing/failed sidecar, so
/// enabling it without a built sidecar just falls back.
pub fn enabled() -> bool {
    let env = std::env::var("TERMFLOW_PTY_HOST").ok();
    host_enabled(cfg!(windows), cfg!(unix), env.as_deref())
}

/// Pure decision core for [`enabled`], split out so the matrix is testable.
/// Every supported OS is default-on (opt-out with `=0`); an unsupported target
/// is always off, whatever the env says.
fn host_enabled(is_windows: bool, is_unix: bool, env: Option<&str>) -> bool {
    if is_windows || is_unix {
        return env != Some("0"); // default on; =0 kills, =1 forces on
    }
    false
}

#[cfg(test)]
mod enabled_tests;

#[derive(Clone)]
pub struct PtyHostClient {
    outbound: UnboundedSender<Frame>,
    pending: PendingMap,
    req_ctr: Arc<AtomicU64>,
    /// False if the sidecar had to be spawned WITHOUT `CREATE_BREAKAWAY_FROM_JOB`
    /// (a kill-on-close job denied breakaway) — hot-swap survival is then NOT
    /// guaranteed, so `restart_for_update` must refuse to arm.
    survives_hotswap: Arc<std::sync::atomic::AtomicBool>,
    /// True when the host's discovery record advertised `CAP_ATTACH_ACK`, so
    /// reattach can use the transactional `AttachAcked` (RP-3). A legacy host
    /// (no record) must only ever receive the fire-and-forget `Attach`.
    attach_acks: Arc<std::sync::atomic::AtomicBool>,
    /// Lifecycle policy copied from the selected connection plan. This is
    /// deliberately connection-owned so UI consumers never re-read a mutable
    /// discovery record after connecting.
    lifecycle: Arc<HostRetention>,
    /// Cleared by the reader task the moment the pipe closes (just before
    /// on_disconnect fires). Lets `ensure_pty_host` refuse to PUBLISH a client
    /// whose disconnect already ran — otherwise a drop during connection setup
    /// leaves a permanently-dead client installed that nothing will ever null.
    alive: Arc<std::sync::atomic::AtomicBool>,
    lifecycle_token: Arc<String>,
}

impl PtyHostClient {
    /// Retention advertised for this connected host. `Unknown` covers legacy,
    /// absent, incomplete, and non-contract records; it never implies
    /// indefinite retention.
    pub fn host_retention(&self) -> HostRetention {
        (*self.lifecycle).clone()
    }

    pub fn set_lifecycle(&mut self, lifecycle: HostRetention) {
        self.lifecycle = Arc::new(lifecycle);
    }
    fn next_req(&self) -> u64 {
        self.req_ctr.fetch_add(1, Ordering::Relaxed)
    }

    /// Whether a hot-swap can be trusted to keep sessions alive (see field doc).
    pub fn survives_hotswap(&self) -> bool {
        self.survives_hotswap.load(Ordering::Acquire)
    }

    /// Mark that the connected host acks `AttachAcked` (set from its discovery
    /// record's `CAP_ATTACH_ACK`; see field doc).
    pub fn set_attach_acks(&self, v: bool) {
        self.attach_acks.store(v, Ordering::Release);
    }

    /// False once the pipe closed (reader task ended). See `alive` field doc.
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
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

    /// RP-3 transactional reattach: `AttachAcked` + wait for the host's
    /// `AttachAck` when the host advertised the capability; transparently fall
    /// back to the legacy fire-and-forget `Attach` otherwise. Returns whether
    /// the host confirmed the session as re-wired and alive (`None` = legacy
    /// host / no confirmation possible — treated as attached, as before).
    pub async fn attach_confirmed(&self, tab_id: &str, from_offset: u64) -> Option<bool> {
        if !self.attach_acks.load(Ordering::Acquire) {
            self.attach(tab_id, from_offset);
            return None;
        }
        let tab = tab_id.to_string();
        match self
            .request(move |req| Control::AttachAcked {
                req,
                tab_id: tab,
                from_offset,
            })
            .await
        {
            Some(Response::AttachAck { alive, tail_offset, .. }) => {
                log::info!(
                    "[HOTSWAP] AttachAck for {tab_id}: alive={alive} tail_offset={tail_offset}"
                );
                Some(alive)
            }
            _ => {
                // Ack-capable host didn't answer in time — the attach itself may
                // still have landed; log and treat like legacy.
                log::warn!("[HOTSWAP] no AttachAck for {tab_id} (timeout); assuming attached");
                None
            }
        }
    }

    // --- request/response (async) ---

    async fn request(&self, make: impl FnOnce(u64) -> Control) -> Option<Response> {
        // Bounded wait so a dead sidecar can't hang a caller forever.
        self.request_within(std::time::Duration::from_secs(10), make).await
    }

    /// `request` with an explicit deadline, for callers that cannot afford the
    /// default 10s — notably the quit path, which runs while the user waits for
    /// the window to go away.
    async fn request_within(
        &self,
        timeout: std::time::Duration,
        make: impl FnOnce(u64) -> Control,
    ) -> Option<Response> {
        let req = self.next_req();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(req, tx);
        if self.outbound.send(Frame::Ctrl(make(req))).is_err() {
            self.pending.lock().unwrap().remove(&req);
            return None;
        }
        match tokio::time::timeout(timeout, rx).await {
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

    /// `None` means the host did NOT answer (timeout / dead pipe) — callers
    /// must never treat that like an authoritative empty list, or a stale
    /// recovery pass would tear down live panes on a transport failure.
    pub async fn list_sessions(&self) -> Option<Vec<SessionMeta>> {
        let token = self.lifecycle_token.to_string();
        match self
            .request(move |req| Control::ListSessions {
                req,
                token: Some(token),
            })
            .await
        {
            Some(Response::SessionList { sessions, .. }) => Some(sessions),
            _ => None,
        }
    }

    /// Arm the hot-swap hold; returns the epoch-ms deadline on ack.
    pub async fn arm_detach(
        &self,
        timeout_secs: u64,
        token: &str,
        purpose: Option<termflow_pty_protocol::ArmDetachPurpose>,
    ) -> Result<u64, String> {
        let token = token.to_string();
        match self
            .request(move |req| Control::ArmDetach {
                req,
                timeout_secs,
                token,
                purpose,
            })
            .await
        {
            Some(Response::ArmAck { deadline_ms, .. }) => {
                log::info!("[HOTSWAP] host armed for detach (ack deadline_ms={deadline_ms})");
                Ok(deadline_ms)
            }
            _ => {
                log::warn!("[HOTSWAP] arm_detach got NO ArmAck — refusing to proceed");
                Err("pty-host: no ArmAck".to_string())
            }
        }
    }

    /// Release the detach hold. Returns whether the host actually acknowledged.
    ///
    /// The answer matters on the quit path: an unacknowledged disarm is
    /// indistinguishable from a successful one, and getting it wrong means
    /// exiting into a host that Holds — the user's shells and agent CLIs left
    /// running with no window and no tray. Retried once, because a single
    /// dropped request on a flaky pipe should not decide that.
    ///
    /// Each attempt is bounded well under the generic 10s request timeout: this
    /// runs while the user is waiting for the app to close.
    pub async fn disarm(&self) -> bool {
        const ATTEMPT_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(1200);
        const ATTEMPTS: usize = 2;

        log::info!("[HOTSWAP] disarming host (update aborted or normal quit)");
        for attempt in 1..=ATTEMPTS {
            if let Some(Response::DisarmAck { .. }) = self
                .request_within(ATTEMPT_TIMEOUT, |req| Control::Disarm { req })
                .await
            {
                return true;
            }
            log::warn!("[HOTSWAP] disarm attempt {attempt}/{ATTEMPTS} got no DisarmAck");
        }
        false
    }
}

/// Build a client around already-connected pipe halves. Split out so tests can
/// drive it over an in-memory duplex without a real named pipe.
#[cfg(any(windows, unix))]
pub fn wire_client<R, W>(rd: R, wr: W, deps: PtyHostDeps) -> PtyHostClient
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
    W: tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    use termflow_pty_protocol::{read_frame, write_frame};

    let (outbound, mut out_rx) = unbounded_channel::<Frame>();
    let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
    let req_ctr = Arc::new(AtomicU64::new(1));
    let alive = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let alive_r = alive.clone();
    let lifecycle_token = Arc::new(deps.lifecycle_token.clone());

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
                Ok(Some(Frame::Data(Data::Stdout { tab_id, offset, bytes }))) => {
                    // Ring bookkeeping stays in the HOST's id space — it is the
                    // host's own offset, and reattach replays from it.
                    deps.stream_offsets
                        .insert(tab_id.clone(), offset + bytes.len() as u64);
                    match route_inbound(&tab_id, |k| (deps.resolve_process)(k)) {
                        Some(id) => {
                            let _ = deps.output_tx.send(ChannelPayload { id, data: bytes });
                            deps.output_produced.fetch_add(1, Ordering::Relaxed);
                        }
                        None => log::warn!(
                            "pty-host: dropping Stdout for unknown session {tab_id}"
                        ),
                    }
                }
                Ok(Some(Frame::Data(Data::Gap { tab_id, .. }))) => {
                    match route_inbound(&tab_id, |k| (deps.resolve_process)(k)) {
                        Some(id) => (deps.on_gap)(id),
                        None => log::warn!("pty-host: dropping Gap for unknown session {tab_id}"),
                    }
                }
                Ok(Some(Frame::Data(Data::Exit { tab_id, exit_cwd }))) => {
                    // An exit for an unknown session still has cleanup value, but
                    // there is no process-keyed state to clean, so drop it rather
                    // than inventing an id.
                    match route_inbound(&tab_id, |k| (deps.resolve_process)(k)) {
                        Some(id) => (deps.on_exit)(id, tab_id, exit_cwd),
                        None => log::warn!("pty-host: dropping Exit for unknown session {tab_id}"),
                    }
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
        // Pipe closed: mark the client dead FIRST (so a concurrent
        // ensure_pty_host can refuse to publish it), then surface the loss.
        alive_r.store(false, Ordering::Release);
        (deps.on_disconnect)();
    });

    PtyHostClient {
        outbound,
        pending,
        req_ctr,
        survives_hotswap: Arc::new(std::sync::atomic::AtomicBool::new(true)),
        attach_acks: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        lifecycle: Arc::new(HostRetention::Unknown),
        alive,
        lifecycle_token,
    }
}

/// Outcome of trying to reach an already-running host BEFORE ever spawning one.
#[derive(Debug)]
enum OpenOutcome<T> {
    /// Connected to an existing host.
    Connected(T),
    /// No live host reachable and none advertised alive — spawning is safe.
    NoHost,
    /// A discovery record advertises a live host pid, but its endpoint never
    /// opened within the long grace window. Spawning now would mint a DUPLICATE
    /// host and race it for the pipe name (the sleep/wake duplicate-host bug),
    /// so the caller must surface an error instead.
    HostAliveUnreachable,
}

/// Grace window covering the host's disconnect→re-accept cycle (a fresh pipe
/// instance only exists once the host notices the old connection died and
/// accepts again). Retrying open for a moment prevents spawning a duplicate
/// during that window.
const OPEN_GRACE_SHORT: std::time::Duration = std::time::Duration::from_secs(2);
/// Longer window used while a discovery record says the host pid is ALIVE:
/// never give up into a spawn while the survivor exists.
const OPEN_GRACE_LONG: std::time::Duration = std::time::Duration::from_secs(10);
const OPEN_GRACE_STEP: std::time::Duration = std::time::Duration::from_millis(200);

/// Retry `try_open` until it succeeds or a grace window elapses. While
/// `record_pid_alive()` reports a live advertised host the LONG window applies
/// and expiry means `HostAliveUnreachable` (never spawn); otherwise the SHORT
/// window applies and expiry means `NoHost` (spawning is safe). Injected
/// closures keep this testable without a real pipe; `try_open` is async so the
/// Unix socket connect never blocks a worker thread.
async fn open_with_grace<T, TryOpen, Fut, PidAlive>(
    mut try_open: TryOpen,
    mut record_pid_alive: PidAlive,
    short_window: std::time::Duration,
    long_window: std::time::Duration,
    step: std::time::Duration,
) -> OpenOutcome<T>
where
    TryOpen: FnMut() -> Fut,
    Fut: std::future::Future<Output = std::io::Result<T>>,
    PidAlive: FnMut() -> bool,
{
    let start = tokio::time::Instant::now();
    loop {
        if let Ok(c) = try_open().await {
            return OpenOutcome::Connected(c);
        }
        let elapsed = start.elapsed();
        if record_pid_alive() {
            if elapsed >= long_window {
                return OpenOutcome::HostAliveUnreachable;
            }
        } else if elapsed >= short_window {
            return OpenOutcome::NoHost;
        }
        tokio::time::sleep(step).await;
    }
}

/// Probe for "the advertised host pid is a live `termflow-pty-host` process"
/// (name check guards against pid reuse). Throttled to one real OS query per
/// second — the grace loop ticks every 200ms and a per-tick sysinfo refresh
/// would be wasted work on an async worker thread (review 007 F-4). The
/// `System` is reused across probes.
fn live_host_probe(record_pid: Option<u32>) -> impl FnMut() -> bool {
    use sysinfo::{Pid, ProcessesToUpdate, System};
    let mut sys = System::new();
    let mut last_check: Option<std::time::Instant> = None;
    let mut last_alive = false;
    move || {
        let Some(pid) = record_pid else { return false };
        let now = std::time::Instant::now();
        let stale = last_check
            .map(|t| now.duration_since(t) >= std::time::Duration::from_secs(1))
            .unwrap_or(true);
        if stale {
            last_check = Some(now);
            let target = Pid::from_u32(pid);
            sys.refresh_processes(ProcessesToUpdate::Some(&[target]), true);
            // Linux truncates comm names to 15 chars (TASK_COMM_LEN), so the
            // full "termflow-pty-host" literal would false-negative there and
            // silently disable the duplicate-spawn guard — match the truncated
            // prefix, and accept a full exe-path basename match as well.
            last_alive = sys
                .process(target)
                .map(|p| {
                    p.name().to_string_lossy().starts_with("termflow-pty-ho")
                        || p.exe()
                            .and_then(|e| e.file_name())
                            .map(|n| n.to_string_lossy().starts_with("termflow-pty-host"))
                            .unwrap_or(false)
                })
                .unwrap_or(false);
        }
        last_alive
    }
}

/// Connect to the sidecar's pipe, spawning it (detached, breaking away from any
/// kill-on-close job) if it isn't already running. `record_pid` is the pid a
/// discovery record advertised (None = no record): while that pid is alive a
/// failed open retries instead of spawning, so a surviving host's re-accept
/// window can never race us into a duplicate host.
#[cfg(windows)]
pub async fn connect_or_spawn(
    sidecar: &std::path::Path,
    build_id: &str,
    pipe: &str,
    token: &str,
    record_pid: Option<u32>,
    deps: PtyHostDeps,
) -> std::io::Result<PtyHostClient> {
    use std::time::Duration;
    use tokio::net::windows::named_pipe::ClientOptions;

    let mut survives = true;
    let outcome = open_with_grace(
        || std::future::ready(ClientOptions::new().open(pipe)),
        live_host_probe(record_pid),
        OPEN_GRACE_SHORT,
        OPEN_GRACE_LONG,
        OPEN_GRACE_STEP,
    )
    .await;
    let conn = match outcome {
        OpenOutcome::Connected(c) => {
            // An already-running host (possibly spawned by a PREVIOUS app
            // version — this is the update-survival adoption path).
            log::info!("[HOTSWAP] adopted already-running pty-host on {pipe}");
            c
        }
        OpenOutcome::HostAliveUnreachable => {
            log::warn!(
                "[HOTSWAP] pty-host pid {:?} is alive but {pipe} never opened; \
                 REFUSING to spawn a duplicate host",
                record_pid
            );
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "a running pty-host is unreachable; not spawning a duplicate",
            ));
        }
        OpenOutcome::NoHost => {
            // No sidecar yet → spawn it, then retry-connect with backoff.
            log::info!("[HOTSWAP] no pty-host on {pipe}; spawning {}", sidecar.display());
            survives = spawn_sidecar_detached(sidecar, build_id, pipe, token)?;
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
    build_id: &str,
    pipe: &str,
    token: &str,
) -> std::io::Result<bool> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    // NOTE: deliberately NOT CREATE_NEW_PROCESS_GROUP. Microsoft documents that
    // flag as "CTRL+C signals will be disabled for all processes within the new
    // process group", and that group is every DESCENDANT of the root. Since the
    // host spawns all hosted shells, that made every shell — and every child
    // under it (bun/node/vite/...) — inherit "ignore Ctrl+C", so a raw \x03 hit
    // ConPTY but conhost never raised CTRL_C_EVENT and no foreground program
    // could be interrupted. (An idle PowerShell prompt still LOOKED fine because
    // PSReadLine aborts the input line off the keypress itself, no signal
    // involved.) DETACHED_PROCESS already gives us console detachment and
    // CREATE_BREAKAWAY_FROM_JOB the job independence hot-swap survival needs, so
    // the process-group flag bought nothing here and cost Ctrl+C entirely.

    // Run with CWD set to the host's own (update-stable) dir, never inheriting a
    // CWD inside the app payload — Velopack treats a process whose CWD is inside
    // the swapped `current\` tree as an update blocker it may kill (design §10.1).
    let workdir = sidecar.parent().map(std::path::Path::to_path_buf);
    let record = record_path();
    // Capture the sidecar's diagnostics. These previously went to Stdio::null(),
    // which made the host completely undiagnosable from the app side — every
    // warning it prints (failed job breakaway, serve errors, a failed CTRL+C
    // restore) vanished. Point them at a per-channel log file in the same
    // update-stable dir instead; truncated on each spawn, so it stays small.
    // Only lifecycle/error lines are written here — never session I/O.
    let log_path = runtime_host_dir().map(|d| d.join("host.log"));
    let base = move || {
        let mut c = Command::new(sidecar);
        c.env("TERMFLOW_PTY_PIPE", pipe)
            .env("TERMFLOW_PTY_TOKEN", token)
            .env("TERMFLOW_PTY_BUILD_ID", build_id)
            .stdin(Stdio::null());
        match log_path.as_ref().and_then(|p| std::fs::File::create(p).ok()) {
            Some(f) => {
                c.stdout(f.try_clone().expect("clone log file handle"));
                c.stderr(f);
            }
            None => {
                c.stdout(Stdio::null());
                c.stderr(Stdio::null());
            }
        }
        // RP-2: tell the host where to advertise itself (discovery record).
        if let Some(ref rp) = record {
            c.env("TERMFLOW_PTY_RECORD", rp);
        }
        if let Some(ref wd) = workdir {
            c.current_dir(wd);
        }
        c
    };

    // Prefer breaking away from any kill-on-close job so the sidecar outlives
    // the GUI. If the job denies breakaway, CreateProcess fails with that flag;
    // fall back to a non-broken-away spawn and report survival as unavailable.
    match base()
        .creation_flags(DETACHED_PROCESS | CREATE_BREAKAWAY_FROM_JOB)
        .spawn()
    {
        Ok(_) => {
            log::info!("[HOTSWAP] pty-host spawned WITH job breakaway (update-survivable)");
            Ok(true)
        }
        Err(_) => {
            base()
                .creation_flags(DETACHED_PROCESS)
                .spawn()?;
            log::warn!(
                "pty-host: spawned WITHOUT job breakaway; hot-swap survival not guaranteed"
            );
            Ok(false)
        }
    }
}

/// Connect to the sidecar's Unix socket, spawning it (detached into its own
/// session via `setsid`) if it isn't already running. Mirrors the Windows path:
/// grace-window try-connect (never duplicating a live advertised host) → spawn
/// + retry-connect with backoff.
#[cfg(unix)]
pub async fn connect_or_spawn(
    sidecar: &std::path::Path,
    build_id: &str,
    pipe: &str, // socket path on Unix
    token: &str,
    record_pid: Option<u32>,
    deps: PtyHostDeps,
) -> std::io::Result<PtyHostClient> {
    use std::time::Duration;
    use tokio::net::UnixStream;

    let mut survives = true;
    let outcome = open_with_grace(
        || UnixStream::connect(pipe),
        live_host_probe(record_pid),
        OPEN_GRACE_SHORT,
        OPEN_GRACE_LONG,
        OPEN_GRACE_STEP,
    )
    .await;
    let conn = match outcome {
        OpenOutcome::Connected(c) => {
            // An already-running host (possibly spawned by a PREVIOUS app
            // version — this is the update-survival adoption path).
            log::info!("[HOTSWAP] adopted already-running pty-host on {pipe}");
            c
        }
        OpenOutcome::HostAliveUnreachable => {
            log::warn!(
                "[HOTSWAP] pty-host pid {:?} is alive but {pipe} never opened; \
                 REFUSING to spawn a duplicate host",
                record_pid
            );
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "a running pty-host is unreachable; not spawning a duplicate",
            ));
        }
        OpenOutcome::NoHost => {
            // No sidecar yet → spawn it, then retry-connect with backoff.
            log::info!("[HOTSWAP] no pty-host on {pipe}; spawning {}", sidecar.display());
            survives = spawn_sidecar_detached(sidecar, build_id, pipe, token)?;
            let mut conn = None;
            for _ in 0..40 {
                tokio::time::sleep(Duration::from_millis(150)).await;
                if let Ok(c) = UnixStream::connect(pipe).await {
                    conn = Some(c);
                    break;
                }
            }
            conn.ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "pty-host sidecar did not open its socket",
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

/// Spawn the sidecar detached into its own session so a GUI exit (or a `SIGHUP`
/// to the GUI's process group) cannot reach it. Returns whether detachment is
/// trusted for hot-swap. On Unix there is no job-object trap: a successful spawn
/// implies a successful `setsid`, so survival is trusted (and the sidecar
/// re-verifies via `assert_survivable` and refuses to arm if it somehow isn't a
/// session leader).
#[cfg(unix)]
fn spawn_sidecar_detached(
    sidecar: &std::path::Path,
    build_id: &str,
    pipe: &str,
    token: &str,
) -> std::io::Result<bool> {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    // Run with CWD set to the host's own (update-stable) dir, never inheriting a
    // CWD inside the app payload — a Velopack swap of the payload must not
    // disrupt the running host (design §10.1).
    let workdir = sidecar.parent().map(std::path::Path::to_path_buf);
    let mut c = Command::new(sidecar);
    c.env("TERMFLOW_PTY_PIPE", pipe)
        .env("TERMFLOW_PTY_TOKEN", token)
        .env("TERMFLOW_PTY_BUILD_ID", build_id)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // RP-2: tell the host where to advertise itself (discovery record).
    if let Some(rp) = record_path() {
        c.env("TERMFLOW_PTY_RECORD", rp);
    }
    if let Some(ref wd) = workdir {
        c.current_dir(wd);
    }
    // Only `setsid` runs in pre_exec — it is async-signal-safe (dual-review H2).
    // We deliberately do NOT touch signal dispositions here; exec resets them,
    // so the sidecar and its future PTY children start with defaults (no
    // inherited SIGHUP-ignore). If setsid fails the child aborts before exec and
    // `spawn()` returns the error, so the caller falls back to in-process.
    unsafe {
        c.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    c.spawn()?;
    Ok(true)
}

/// Stub for exotic targets that are neither Windows nor Unix. `enabled()` is
/// always false there, so this is never reached at runtime.
#[cfg(not(any(windows, unix)))]
pub async fn connect_or_spawn(
    _sidecar: &std::path::Path,
    _build_id: &str,
    _pipe: &str,
    _token: &str,
    _record_pid: Option<u32>,
    _deps: PtyHostDeps,
) -> std::io::Result<PtyHostClient> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "pty-host sidecar is unsupported on this target",
    ))
}

/// Windows named-pipe name for an identity. Pure, so the naming invariant is
/// testable without touching the environment. `id.key()` is `"rel"` for the
/// default identity, so today's name is reproduced byte for byte.
#[cfg(windows)]
fn pipe_for(user: &str, id: &crate::profile::ProfileIdentity) -> String {
    format!(r"\\.\pipe\termflow-pty-host.{user}.{}", id.key())
}

/// Unix socket path for an identity. Same reasoning as `pipe_for`.
#[cfg(unix)]
fn socket_for(runtime_dir: &str, id: &crate::profile::ProfileIdentity) -> String {
    format!("{runtime_dir}/termflow-pty-host.{}.sock", id.key())
}

/// Per-user, per-identity endpoint so two users — or two profiles — on one
/// machine never collide. On Windows this is a named-pipe name; on Unix a socket
/// path in the user's runtime dir. The GUI passes this to the sidecar via
/// `TERMFLOW_PTY_PIPE`, so both agree by construction (the sidecar creates the
/// socket's parent dir on bind).
pub fn resolve_pipe() -> String {
    #[cfg(windows)]
    {
        let user = std::env::var("USERNAME")
            .or_else(|_| std::env::var("USER"))
            .unwrap_or_else(|_| "user".to_string());
        pipe_for(&user, crate::profile::current())
    }
    #[cfg(unix)]
    {
        socket_for(&unix_runtime_dir(), crate::profile::current())
    }
}

/// Per-user runtime directory for the Unix socket, mirroring the sidecar's
/// `socket_unix::runtime_dir`: `$XDG_RUNTIME_DIR/termflow` (Linux), else
/// `$TMPDIR/termflow` (macOS), else `/tmp/termflow-<user>`. The sidecar creates
/// and 0700-secures it on bind.
#[cfg(unix)]
fn unix_runtime_dir() -> String {
    if let Some(d) = std::env::var_os("XDG_RUNTIME_DIR") {
        if !d.is_empty() {
            return format!("{}/termflow", d.to_string_lossy().trim_end_matches('/'));
        }
    }
    #[cfg(target_os = "macos")]
    if let Some(d) = std::env::var_os("TMPDIR") {
        if !d.is_empty() {
            return format!("{}/termflow", d.to_string_lossy().trim_end_matches('/'));
        }
    }
    let user = std::env::var("USER").unwrap_or_else(|_| "user".to_string());
    format!("/tmp/termflow-{user}")
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
    // The token authorizes ArmDetach (control of the sidecar), so it must never
    // be world-readable on a shared /tmp. Tighten an existing file to 0600 first
    // (upgrade from a pre-hardening version); no-op if absent.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let t = existing.trim().to_string();
        if !t.is_empty() {
            return t;
        }
    }
    let token = uuid::Uuid::new_v4().to_string();
    write_token_owner_only(&path, &token);
    token
}

/// Persist the launch token owner-only. On Unix create it `0600` so no other
/// user can read the `ArmDetach` secret; on Windows `temp_dir()` is already a
/// per-user location, so a plain write suffices.
fn write_token_owner_only(path: &std::path::Path, token: &str) {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        match std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
        {
            Ok(mut f) => {
                let _ = f.write_all(token.as_bytes());
            }
            Err(_) => {
                let _ = std::fs::write(path, token); // best-effort fallback
            }
        }
    }
    #[cfg(windows)]
    {
        let _ = std::fs::write(path, token);
    }
}

/// Host binary filename for the current platform.
fn host_binary_name() -> &'static str {
    if cfg!(windows) {
        "termflow-pty-host.exe"
    } else {
        "termflow-pty-host"
    }
}

/// The per-user, **update-stable** runtime dir the host is installed into and
/// executed from — deliberately OUTSIDE anything an installer or updater ever
/// touches. Keyed by the app identifier (`app.termflow.desktop`, the same dir
/// Tauri uses for logs/app-data), NOT the Velopack install root:
///
/// C1 (design 003 §10.1, proven live in the 0.1.0→0.1.1 RP-0 run): Velopack's
/// `Update.exe apply --root %LOCALAPPDATA%\TermFlow` kills every process running
/// from under the install ROOT before swapping — not just `current\`. The
/// previous `%LOCALAPPDATA%\TermFlow\host\…` location was inside that kill zone,
/// so an armed host died with the update anyway. `Setup.exe` likewise renames
/// the whole root (rollback), which a running host inside it blocks.
///
/// Old copies under the previous location are simply orphaned (the Windows
/// uninstaller removes the root; dev/mac copies are a few MB) — the stable pipe
/// name means a still-running old-dir host keeps working regardless.
/// Qualified by the full profile identity so dev/release — and two profiles, and
/// a normal instance beside an elevated one — never collide.
///
/// Scoping the pipe alone was NOT enough (plan 011 rev 1's blocking bug):
/// `ensure_pty_host_inner` reads the record here and, on `ConnectPlan::Bootstrap`,
/// substitutes the record's advertised endpoint for the computed pipe
/// (`state.rs:712-729`) — so an unscoped record redirected profile B straight
/// onto profile A's host.
pub fn runtime_host_dir() -> Option<std::path::PathBuf> {
    let base = if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from)
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME")
            .map(|h| std::path::PathBuf::from(h).join("Library").join("Application Support"))
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(std::path::PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME")
                    .map(|h| std::path::PathBuf::from(h).join(".local").join("share"))
            })
    }?;
    Some(record_dir_for(&base, crate::profile::current()))
}

/// Pure form of [`runtime_host_dir`], so the identity-scoping invariant can be
/// asserted without an environment.
fn record_dir_for(
    base: &std::path::Path,
    id: &crate::profile::ProfileIdentity,
) -> std::path::PathBuf {
    base.join("app.termflow.desktop").join("host").join(id.key())
}

/// Tests for the quit-path disarm contract. `disarm` is the last thing that
/// stands between a user-confirmed Exit and a host that Holds instead of tearing
/// down, so "did it actually land?" has to be answerable — a fire-and-forget
/// disarm that silently lost its request looks exactly like a successful one.
#[cfg(test)]
mod disarm_tests;

#[cfg(test)]
mod runtime_dir_tests;

/// Where the running host advertises itself (RP-2 discovery). Lives in the
/// update-stable runtime dir (per-user + per-identity, matching the pipe name's
/// scope) so it survives updates alongside the host itself. Absent file ⇒
/// legacy host or none running.
///
/// The sidecar never computes this path — the GUI passes it as
/// `TERMFLOW_PTY_RECORD`, so scoping it here scopes the writer too.
pub fn record_path() -> Option<std::path::PathBuf> {
    runtime_host_dir().map(|d| d.join("host-record.json"))
}

/// SHA-256 of a file's bytes.
fn sha256_file(path: &std::path::Path) -> std::io::Result<[u8; 32]> {
    use sha2::{Digest, Sha256};
    let bytes = std::fs::read(path)?;
    let mut h = Sha256::new();
    h.update(&bytes);
    Ok(h.finalize().into())
}

/// First 8 bytes of a digest as hex (16 chars) — enough to key the install dir.
fn hex16(digest: &[u8; 32]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(16);
    for b in &digest[..8] {
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// Install the host binary into `base/<hash>/<name>`, idempotently and
/// atomically, verifying the copy's hash matches the source. Returns the
/// installed path. Split out (base as a param) so it is unit-testable without
/// touching the real per-user runtime dir.
fn install_host_into(
    src: &std::path::Path,
    base: &std::path::Path,
) -> std::io::Result<std::path::PathBuf> {
    let digest = sha256_file(src)?;
    let dir = base.join(hex16(&digest));
    let name = host_binary_name();
    let dest = dir.join(name);

    // Idempotent: an intact prior copy (matching hash) is reused as-is.
    if dest.exists() {
        if let Ok(d) = sha256_file(&dest) {
            if d == digest {
                return Ok(dest);
            }
        }
    }

    std::fs::create_dir_all(&dir)?;
    // Copy to a temp name in the SAME dir, then rename over — so a reader never
    // sees a half-written binary, and a locked/running old copy doesn't block us.
    let tmp = dir.join(format!(".{name}.tmp-{}", uuid::Uuid::new_v4()));
    std::fs::copy(src, &tmp)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&tmp)?.permissions();
        perms.set_mode(0o700); // owner rwx only
        std::fs::set_permissions(&tmp, perms)?;
    }
    // Integrity: verify the copy before publishing it.
    if sha256_file(&tmp)? != digest {
        let _ = std::fs::remove_file(&tmp);
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "pty-host: installed copy hash did not match source",
        ));
    }
    // TODO(RP-9/signing): in release, Authenticode/codesign-verify `dest` here
    // before it is ever executed. In dev the bundled host is unsigned.
    std::fs::rename(&tmp, &dest)?;
    Ok(dest)
}

/// Resolve the host path to run: locate the bundled/dev host, then install it
/// into the update-stable runtime dir and return THAT path. On any install
/// failure, fall back to the bundled path so terminals still work (they just
/// won't survive an update that swaps the payload).
pub fn resolve_host_path() -> Option<std::path::PathBuf> {
    resolve_host_launch().map(|launch| launch.path)
}

/// The exact descriptor used for both the host hash and `Command::new`.  The
/// full digest is retained: the runtime directory uses only its first 8 bytes.
/// A hash failure or missing source has no descriptor and callers must not
/// claim that a host is current.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostLaunch {
    pub path: std::path::PathBuf,
    pub build_id: String,
}

pub fn resolve_host_launch() -> Option<HostLaunch> {
    let src = resolve_bundled_host_path()?;
    let path = match runtime_host_dir() {
        Some(base) => match install_host_into(&src, &base) {
            Ok(dest) => dest,
            Err(e) => {
                log::warn!(
                    "pty-host: could not install host into runtime dir ({e}); \
                     running from bundled path (won't survive a payload swap)"
                );
                src
            }
        },
        None => {
            log::warn!("pty-host: no per-user runtime dir; running from bundled path");
            src
        }
    };
    let digest = sha256_file(&path).ok()?;
    Some(HostLaunch { path, build_id: hex_full(&digest) })
}

fn hex_full(digest: &[u8; 32]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(64);
    for b in digest { let _ = write!(s, "{b:02x}"); }
    s
}

/// What to do with a (possibly running) host, decided from its discovery record
/// BEFORE touching the wire — so a new app never speaks an incompatible protocol
/// at a legacy host and never force-kills sessions it can't control (C3/C4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectPlan {
    /// No record → a legacy (v1) host may be on the well-known endpoint, or none
    /// is running. Speak v1 directly (no bootstrap); spawn a host if none.
    LegacyOrNone,
    /// Compatible new host: connect `endpoint`, do the bootstrap handshake, speak
    /// the negotiated frame `version`.
    Bootstrap {
        endpoint: String,
        version: u16,
        instance_id: u128,
        host_caps: u32,
        lifecycle: HostRetention,
    },
    /// A new host is running but shares NO protocol version with us. Do NOT
    /// force-kill its sessions — coexist read-only / banner (design §10.3/§10.4).
    Incompatible { instance_id: u128 },
}

/// Three-state lifecycle exposure for app consumers. This is not a capability
/// bit: a bounded policy carries its active retention duration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostRetention {
    Unknown,
    Indefinite,
    Bounded { active_secs: u64 },
}

/// Hash handling for a discovered host.  A mismatched or legacy-unknown host is
/// deliberately adopted when its protocol/capabilities allow it; terminating
/// live terminals to enforce freshness would be the worse failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostBuildDisposition { Current, Stale { observed: String, expected: String }, Unknown }

pub fn host_build_disposition(record: Option<&termflow_pty_protocol::HostRecord>, expected: &str) -> HostBuildDisposition {
    match record.and_then(|r| r.build_id.as_deref()) {
        Some(observed) if observed == expected => HostBuildDisposition::Current,
        Some(observed) => HostBuildDisposition::Stale { observed: observed.into(), expected: expected.into() },
        None => HostBuildDisposition::Unknown,
    }
}

fn advertised_retention(rec: &termflow_pty_protocol::HostRecord) -> HostRetention {
    if rec.capabilities & termflow_pty_protocol::CAP_LIFECYCLE_CONTRACT == 0 {
        return HostRetention::Unknown;
    }
    match rec.lifecycle.as_ref() {
        Some(termflow_pty_protocol::LifecycleContract {
            version: 1,
            retention: termflow_pty_protocol::RetentionPolicy::Indefinite,
        }) => HostRetention::Indefinite,
        Some(termflow_pty_protocol::LifecycleContract {
            version: 1,
            retention: termflow_pty_protocol::RetentionPolicy::Bounded { active_secs },
        }) => HostRetention::Bounded {
            active_secs: *active_secs,
        },
        _ => HostRetention::Unknown,
    }
}

/// Decide how to connect from an already-read discovery record.
pub fn plan_connection(record: Option<termflow_pty_protocol::HostRecord>) -> ConnectPlan {
    match record {
        None => ConnectPlan::LegacyOrNone,
        Some(rec) => match termflow_pty_protocol::negotiate(
            (
                termflow_pty_protocol::PROTOCOL_MIN,
                termflow_pty_protocol::PROTOCOL_MAX,
            ),
            (rec.proto_min, rec.proto_max),
        ) {
            Some(version) => {
                let lifecycle = advertised_retention(&rec);
                ConnectPlan::Bootstrap {
                    endpoint: rec.endpoint,
                    version,
                    instance_id: rec.instance_id,
                    host_caps: rec.capabilities,
                    lifecycle,
                }
            }
            None => ConnectPlan::Incompatible {
                instance_id: rec.instance_id,
            },
        },
    }
}

/// Locate the *bundled* sidecar binary (the source to install from), in
/// priority order:
/// 1. `TERMFLOW_PTY_HOST_BIN` explicit override.
/// 2. Next to the app executable (release / staged).
/// 3. Dev build locations under `pty-host/target/{release,debug}` resolved
///    both relative to the exe (`src-tauri/target/debug/…`) and to the cwd —
///    so `bun run dev` finds it with no env var once the sidecar is built.
pub fn resolve_bundled_host_path() -> Option<std::path::PathBuf> {
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

#[cfg(test)]
mod plan_tests;

#[cfg(test)]
mod install_tests;

#[cfg(test)]
mod grace_tests;

fn resp_req(r: &Response) -> u64 {
    match r {
        Response::Spawned { req, .. }
        | Response::SpawnFailed { req, .. }
        | Response::SessionList { req, .. }
        | Response::ArmAck { req, .. }
        | Response::DisarmAck { req }
        | Response::AttachAck { req, .. } => *req,
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
            lifecycle_token: "tok".into(),
            output_tx: tx,
            output_produced: produced.clone(),
            on_exit: Arc::new(|_, _, _| {}),
            on_gap: Arc::new(|_| {}),
            on_disconnect: Arc::new(|| {}),
            stream_offsets: Arc::new(dashmap::DashMap::new()),
            // Identity mapping: these tests predate the id split and assert the
            // pipe/framing behaviour, not the routing. A resolver that knows every
            // session keeps them measuring what they were written to measure.
            resolve_process: Arc::new(|k: &str| Some(k.to_string())),
        };
        (deps, rx, produced)
    }

    /// Design 014 §A3: the host speaks its own id space and every inbound frame
    /// is translated before it reaches our maps.
    #[test]
    fn route_inbound_maps_a_session_key_to_its_process_id() {
        let got = route_inbound("tb-legacy01", |k| {
            (k == "tb-legacy01").then(|| "pc-live0001".to_string())
        });
        assert_eq!(got.as_deref(), Some("pc-live0001"));
    }

    /// The "never fall back" rule. Echoing the session key back would route a
    /// stale session's bytes into whatever map entry shares its name — the exact
    /// silent mis-routing design 014 exists to remove.
    #[test]
    fn route_inbound_drops_an_unknown_session_rather_than_echoing_it() {
        assert_eq!(route_inbound("tb-ghost001", |_| None), None);
    }

    /// Holds for every terminal created on this build, which is why introducing
    /// the translation is a no-op until the ids actually diverge.
    #[test]
    fn route_inbound_is_identity_while_session_key_equals_process_id() {
        let got = route_inbound("pc-same0001", |k| Some(k.to_string()));
        assert_eq!(got.as_deref(), Some("pc-same0001"));
    }

    /// A migrated terminal: the host still calls it `tb-old`, our maps call it
    /// `pc-new`. Bytes must land on the process id.
    #[test]
    fn route_inbound_translates_a_migrated_sessions_legacy_key() {
        let got = route_inbound("tb-old00001", |k| {
            (k == "tb-old00001").then(|| "pc-new00001".to_string())
        });
        assert_eq!(got.as_deref(), Some("pc-new00001"), "a migrated session must still route");
    }

    #[tokio::test]
    async fn stdout_frames_reach_output_tx_and_bump_watchdog() {
        // Wire the client to one end of a duplex; feed Stdout from the other.
        let (client_side, server_side) = tokio::io::duplex(64 * 1024);
        let (crd, cwr) = tokio::io::split(client_side);
        let (mut srd, mut swr) = tokio::io::split(server_side);

        let (deps, mut rx, produced) = deps();
        let offsets = deps.stream_offsets.clone();
        let _client = wire_client(crd, cwr, deps);

        // Server pushes a Stdout frame to the client.
        write_frame(
            &mut swr,
            &Frame::Data(Data::Stdout {
                tab_id: "t1".into(),
                offset: 100,
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
        // The reader must record the NEXT expected ring offset (offset + len) so
        // an in-place reconnect can reattach without replaying or losing bytes.
        assert_eq!(offsets.get("t1").map(|v| *v), Some(105));
        let _ = (&mut srd,); // keep server read half alive
    }

    #[tokio::test]
    async fn attach_confirmed_uses_ack_when_capable_and_legacy_otherwise() {
        let (client_side, server_side) = tokio::io::duplex(64 * 1024);
        let (crd, cwr) = tokio::io::split(client_side);
        let (mut srd, mut swr) = tokio::io::split(server_side);

        let (deps, _rx, _p) = deps();
        let client = wire_client(crd, cwr, deps);

        // Legacy (acks off, the default): fire-and-forget Attach, returns None.
        let legacy = client.attach_confirmed("t-legacy", 0).await;
        assert_eq!(legacy, None, "no-cap host ⇒ legacy fire-and-forget");
        match read_frame(&mut srd).await {
            Ok(Some(Frame::Ctrl(Control::Attach { tab_id, .. }))) => {
                assert_eq!(tab_id, "t-legacy");
            }
            other => panic!("expected legacy Attach on the wire, got {other:?}"),
        }

        // Capable host: AttachAcked goes out, AttachAck resolves the call.
        client.set_attach_acks(true);
        let server = tokio::spawn(async move {
            if let Ok(Some(Frame::Ctrl(Control::AttachAcked { req, tab_id, .. }))) =
                read_frame(&mut srd).await
            {
                write_frame(
                    &mut swr,
                    &Frame::Resp(Response::AttachAck {
                        req,
                        tab_id,
                        alive: true,
                        tail_offset: 42,
                    }),
                )
                .await
                .unwrap();
            }
        });
        let confirmed = client.attach_confirmed("t-ack", 0).await;
        assert_eq!(confirmed, Some(true), "capable host ⇒ confirmed alive");
        server.await.unwrap();
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
