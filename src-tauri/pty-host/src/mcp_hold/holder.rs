//! The real MCP holder task (plan 054 §4.3, §4.4): binds exactly the sidecar's
//! address, answers agents with the wait message, and ends on `Stop`, on its
//! own handback grace, or on its own hard cap.
//!
//! The task owns its lifetime. The manager only commands it through a `watch`
//! (`Mode`) and never awaits it; `serve` awaits the root `JoinHandle` on every
//! return path. No holder or connection task does blocking work, and every
//! await is a `select!` with the stop signal or has a deadline, so on the
//! cooperative path the root resolves only after every child task has finished
//! and every socket is closed.

use super::http::{self, HoldCtx, Handled, SseOpen, SSE_PING, WRITE_DEADLINE};
use super::rpc::{self, Snapshot, Wait};
use super::{Mode, SpawnHolder};
use crate::transport::ActiveClock;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;
use termflow_pty_protocol::{McpHoldReason, McpHoldSpec};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{watch, OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinSet;
use tokio::time::{interval_at, sleep, sleep_until, timeout, Instant, MissedTickBehavior};

/// Open connections, process wide. A connection without a free permit is
/// dropped at once: no task, no read, no write.
pub const MAX_CONNECTIONS: usize = 32;
/// Open event streams. The ninth `GET /mcp` gets `503`.
pub const MAX_SSE: usize = 8;
/// From the stop order to the listener and every connection being closed.
pub const STOP_BOUND: Duration = Duration::from_secs(1);
/// How long a non-stream connection may keep finishing after the stop order.
const CONNECTION_STOP_GRACE: Duration = Duration::from_millis(250);
/// The holder stops itself this long (active time) after it started.
pub const HOLDER_MAX: Duration = Duration::from_secs(30 * 60);
/// The holder stops itself this long after the GUI claimed the hold.
pub const HANDBACK_GRACE: Duration = Duration::from_secs(60);
const BIND_FAST_RETRY: Duration = Duration::from_millis(100);
const BIND_FAST_WINDOW: Duration = Duration::from_secs(10);
const BIND_SLOW_RETRY: Duration = Duration::from_secs(1);
const BIND_LOG_EVERY: Duration = Duration::from_secs(30);
/// How often the hard cap is checked against the active clock.
const CAP_POLL: Duration = Duration::from_millis(250);
/// `: ping` cadence on an open event stream.
const SSE_PING_EVERY: Duration = Duration::from_secs(5);

// --- shared limits and environment -----------------------------------------

/// The two semaphores. They outlive any one holder (one holder task exists at a
/// time, see `McpHold`), so the bounds are process wide.
pub struct Limits {
    conn: Arc<Semaphore>,
    sse: Arc<Semaphore>,
}

impl Limits {
    pub fn new() -> Self {
        Self { conn: Arc::new(Semaphore::new(MAX_CONNECTIONS)), sse: Arc::new(Semaphore::new(MAX_SSE)) }
    }
}

impl Default for Limits {
    fn default() -> Self {
        Self::new()
    }
}

/// Everything a holder task needs besides its spec and its mode channel.
#[derive(Clone)]
pub struct HolderEnv {
    pub clock: Arc<dyn ActiveClock>,
    pub limits: Arc<Limits>,
    /// The host's current Local deadline (active-clock time), published by
    /// `serve`; `None` while none is established.
    pub deadline: watch::Receiver<Option<Duration>>,
}

/// Where `serve` publishes the host's current deadline for the holder.
pub type DeadlineSink = watch::Sender<Option<Duration>>;

impl HolderEnv {
    /// A fresh environment on `clock` and the sink that feeds its deadline.
    pub fn new(clock: Arc<dyn ActiveClock>) -> (Self, DeadlineSink) {
        let (tx, rx) = watch::channel(None);
        (Self { clock, limits: Arc::new(Limits::new()), deadline: rx }, tx)
    }
}

/// The production spawn function: a real holder task per accepted spec.
pub fn production_spawn(env: HolderEnv) -> SpawnHolder {
    Box::new(move |spec, mode| tokio::spawn(run(env.clone(), spec, mode)))
}

// --- active time -----------------------------------------------------------

/// Active time since the holder started. A failed clock sample does not
/// advance anything: the start is taken from the first successful sample.
struct ActiveTimer {
    clock: Arc<dyn ActiveClock>,
    start: Mutex<Option<Duration>>,
}

impl ActiveTimer {
    fn new(clock: Arc<dyn ActiveClock>) -> Self {
        let timer = Self { clock, start: Mutex::new(None) };
        let _ = timer.elapsed();
        timer
    }

    fn elapsed(&self) -> Option<Duration> {
        let now = self.clock.now()?;
        let mut start = self.start.lock().unwrap_or_else(PoisonError::into_inner);
        let start = *start.get_or_insert(now);
        Some(now.saturating_sub(start))
    }
}

// --- test gauges and hooks -------------------------------------------------

/// Thread-local, so they are exact under the current-thread runtime that
/// `#[tokio::test]` uses.
#[cfg(test)]
pub mod gauges {
    use std::cell::{Cell, RefCell};

    #[derive(Clone, Copy, Default, Debug)]
    pub struct Gauge {
        pub cur: usize,
        pub peak: usize,
    }

    thread_local! {
        pub static ROOT: Cell<Gauge> = const { Cell::new(Gauge { cur: 0, peak: 0 }) };
        pub static CONN: Cell<Gauge> = const { Cell::new(Gauge { cur: 0, peak: 0 }) };
        pub static SPEC_BYTES: Cell<Gauge> = const { Cell::new(Gauge { cur: 0, peak: 0 }) };
        pub static BIND_ATTEMPTS: Cell<u64> = const { Cell::new(0) };
        /// `JoinSet` entries the accept loop retains, finished-but-unjoined included
        /// (`cur` is the last sample, `peak` the maximum ever sampled).
        pub static RETAINED: Cell<Gauge> = const { Cell::new(Gauge { cur: 0, peak: 0 }) };
        /// Connections the accept loop took off the listener (permit or not).
        pub static ACCEPTED: Cell<u64> = const { Cell::new(0) };
        /// Connection tasks it spawned (it had a permit).
        pub static SPAWNED: Cell<u64> = const { Cell::new(0) };
        /// The local address of every listener the holder bound.
        pub static BOUND: RefCell<Vec<std::net::SocketAddr>> = const { RefCell::new(Vec::new()) };
        /// Ordered events across the manager and the holder.
        pub static ORDER: RefCell<Vec<&'static str>> = const { RefCell::new(Vec::new()) };
        /// Every started holder task as it ends (`"conn-dropped"` per connection
        /// task, `"root-end"` for the root), in the order the ends happened. A
        /// root that returns before its children are gone shows as `"root-end"`
        /// ahead of a `"conn-dropped"`, whatever the scheduler does afterwards.
        pub static TASK_ENDS: RefCell<Vec<&'static str>> = const { RefCell::new(Vec::new()) };
    }

    pub fn add(g: &'static std::thread::LocalKey<Cell<Gauge>>, n: usize) {
        g.with(|c| {
            let mut v = c.get();
            v.cur += n;
            v.peak = v.peak.max(v.cur);
            c.set(v);
        });
    }

    pub fn sub(g: &'static std::thread::LocalKey<Cell<Gauge>>, n: usize) {
        g.with(|c| {
            let mut v = c.get();
            v.cur = v.cur.saturating_sub(n);
            c.set(v);
        });
    }

    pub fn get(g: &'static std::thread::LocalKey<Cell<Gauge>>) -> Gauge {
        g.with(Cell::get)
    }

    /// Root task plus every connection task alive right now.
    pub fn live_tasks() -> usize {
        get(&ROOT).cur + get(&CONN).cur
    }

    pub fn bound() -> Vec<std::net::SocketAddr> {
        BOUND.with(|b| b.borrow().clone())
    }

    pub fn bind_attempts() -> u64 {
        BIND_ATTEMPTS.with(Cell::get)
    }

    /// Records how many `JoinSet` entries are retained right now.
    pub fn sample_retained(entries: usize) {
        RETAINED.with(|c| {
            let mut v = c.get();
            v.cur = entries;
            v.peak = v.peak.max(entries);
            c.set(v);
        });
    }

    pub fn accepted() -> u64 {
        ACCEPTED.with(Cell::get)
    }

    pub fn spawned() -> u64 {
        SPAWNED.with(Cell::get)
    }

    pub fn order() -> Vec<&'static str> {
        ORDER.with(|o| o.borrow().clone())
    }

    pub fn task_ends() -> Vec<&'static str> {
        TASK_ENDS.with(|o| o.borrow().clone())
    }
}

/// A hook that makes the holder misbehave on stop, to pin the weaker
/// guarantees (forced abort, one holder task per process).
#[cfg(test)]
#[derive(Clone)]
pub enum StopHook {
    None,
    /// The holder never reacts to the stop order (a bug).
    Ignore,
    /// The holder finishes its shutdown only once the gate opens.
    Gate(watch::Receiver<bool>),
}

#[cfg(test)]
thread_local! {
    pub static STOP_HOOK: std::cell::RefCell<StopHook> = const { std::cell::RefCell::new(StopHook::None) };
}

/// Records an ordered event (manager and holder), test builds only.
pub fn note_order(event: &'static str) {
    #[cfg(test)]
    gauges::ORDER.with(|o| o.borrow_mut().push(event));
    #[cfg(not(test))]
    let _ = event;
}

#[derive(Clone, Copy)]
enum Kind {
    Root,
    Conn,
}

/// Counts a live task for the test gauges; free in production.
struct TaskGuard {
    #[cfg(test)]
    kind: Kind,
    #[cfg(test)]
    bytes: usize,
}

impl TaskGuard {
    fn new(kind: Kind, bytes: usize) -> Self {
        #[cfg(test)]
        {
            match kind {
                Kind::Root => {
                    gauges::add(&gauges::ROOT, 1);
                    gauges::add(&gauges::SPEC_BYTES, bytes);
                }
                Kind::Conn => gauges::add(&gauges::CONN, 1),
            }
            Self { kind, bytes }
        }
        #[cfg(not(test))]
        {
            let _ = (kind, bytes);
            Self {}
        }
    }
}

impl Drop for TaskGuard {
    fn drop(&mut self) {
        #[cfg(test)]
        match self.kind {
            Kind::Root => {
                gauges::sub(&gauges::ROOT, 1);
                gauges::sub(&gauges::SPEC_BYTES, self.bytes);
                gauges::TASK_ENDS.with(|e| e.borrow_mut().push("root-end"));
            }
            Kind::Conn => {
                gauges::sub(&gauges::CONN, 1);
                gauges::TASK_ENDS.with(|e| e.borrow_mut().push("conn-dropped"));
            }
        }
    }
}

// --- the holder ------------------------------------------------------------

/// What every connection of one holder shares.
struct Shared {
    token: Option<String>,
    snapshot: Snapshot,
    reason: McpHoldReason,
    timer: ActiveTimer,
    clock: Arc<dyn ActiveClock>,
    deadline: watch::Receiver<Option<Duration>>,
    sse: Arc<Semaphore>,
    /// Set when the holder is closing for any reason: ends event streams.
    closing: watch::Receiver<bool>,
}

impl Shared {
    /// Sampled once per POST: mode, elapsed and remaining for the wait message.
    fn wait(&self, mode: &watch::Receiver<Mode>) -> Wait {
        let now = self.clock.now();
        let deadline = *self.deadline.borrow();
        Wait {
            mode: *mode.borrow(),
            elapsed: self.timer.elapsed(),
            remaining: deadline.zip(now).map(|(at, now)| at.saturating_sub(now)),
        }
    }
}

/// The holder task. Returns once the listener and every connection are gone.
pub async fn run(env: HolderEnv, mut spec: McpHoldSpec, mut mode: watch::Receiver<Mode>) {
    let snapshot_bytes = spec.initialize_result.as_ref().map_or(0, String::len)
        + spec.tools_list_result.as_ref().map_or(0, String::len);
    let _root = TaskGuard::new(Kind::Root, snapshot_bytes);

    let addr = match spec.bind_host.parse::<IpAddr>() {
        Ok(ip) => SocketAddr::new(ip, spec.port),
        Err(_) => {
            // The manager only accepts IP literals; this is defence in depth.
            log::error!("[MCP-HOLD] bind_host is not an IP literal; holder not started");
            return;
        }
    };
    let (closing_tx, closing_rx) = watch::channel(false);
    let shared = Arc::new(Shared {
        token: spec.auth_token.take().filter(|t| !t.is_empty()),
        snapshot: Snapshot::new(spec.initialize_result.take(), spec.tools_list_result.take()),
        reason: spec.reason,
        timer: ActiveTimer::new(env.clock.clone()),
        clock: env.clock.clone(),
        deadline: env.deadline.clone(),
        sse: env.limits.sse.clone(),
        closing: closing_rx,
    });
    drop(spec);

    let mut set: JoinSet<()> = JoinSet::new();
    let reason = serve_loop(addr, &env, &shared, &mut mode, &mut set).await;
    log::info!("[MCP-HOLD] holder ending: {reason}");

    // Stop (<= STOP_BOUND): the listener is already dropped; event streams end;
    // other connections get a short grace, then everything is aborted and waited for.
    let _ = closing_tx.send(true);
    if timeout(CONNECTION_STOP_GRACE, drain(&mut set)).await.is_err() {
        set.abort_all();
    }
    set.shutdown().await;
    #[cfg(test)]
    after_close().await;
    log::info!("[MCP-HOLD] holder stopped");
}

/// The bug-path hook: a holder that never reacts to the stop order.
fn ignores_stop() -> bool {
    #[cfg(test)]
    return STOP_HOOK.with(|h| matches!(*h.borrow(), StopHook::Ignore));
    #[cfg(not(test))]
    false
}

#[cfg(test)]
async fn after_close() {
    let hook = STOP_HOOK.with(|h| h.borrow().clone());
    if let StopHook::Gate(mut gate) = hook {
        let _ = gate.wait_for(|open| *open).await;
    }
}

async fn drain(set: &mut JoinSet<()>) {
    while let Some(res) = set.join_next().await {
        reap(res);
    }
}

/// Joins every connection task that has already finished, without waiting.
fn reap_finished(set: &mut JoinSet<()>) {
    while let Some(res) = set.try_join_next() {
        reap(res);
    }
    #[cfg(test)]
    gauges::sample_retained(set.len());
}

fn reap(res: Result<(), tokio::task::JoinError>) {
    if let Err(e) = res {
        if e.is_panic() {
            log::error!("[MCP-HOLD] a connection task panicked: {e}");
        }
    }
}

async fn until(at: Option<Instant>) {
    match at {
        Some(at) => sleep_until(at).await,
        None => std::future::pending().await,
    }
}

async fn accept_on(listener: &Option<TcpListener>) -> std::io::Result<(TcpStream, SocketAddr)> {
    match listener {
        Some(l) => l.accept().await,
        None => std::future::pending().await,
    }
}

/// Binds, accepts and times. Returns why it ended; the listener is dropped
/// before it returns.
async fn serve_loop(
    addr: SocketAddr,
    env: &HolderEnv,
    shared: &Arc<Shared>,
    mode: &mut watch::Receiver<Mode>,
    set: &mut JoinSet<()>,
) -> &'static str {
    let started = Instant::now();
    let mut listener: Option<TcpListener> = None;
    let mut next_bind = started;
    let mut last_bind_log: Option<Instant> = None;
    let mut grace_at: Option<Instant> = None;
    loop {
        // The stored value is read at start and after every wake-up, never only
        // on change, so a Stop ordered before this task first ran ends it here,
        // before any bind.
        let current = *mode.borrow_and_update();
        // A dropped sender is a Stop too, and is seen here, before any bind, not
        // only by `changed()` after one: a holder spawned and then orphaned
        // before its first poll still has its last stored mode.
        if mode.has_changed().is_err() && !ignores_stop() {
            return "sender dropped";
        }
        match current {
            Mode::Stop if !ignores_stop() => return "stop ordered",
            Mode::Handback if grace_at.is_none() => {
                grace_at = Some(Instant::now() + HANDBACK_GRACE);
                log::info!("[MCP-HOLD] handback: grace {}s", HANDBACK_GRACE.as_secs());
            }
            _ => {}
        }
        if shared.timer.elapsed().is_some_and(|e| e >= HOLDER_MAX) {
            return "hard cap reached";
        }
        if grace_at.is_some_and(|t| Instant::now() >= t) {
            return "handback grace ended";
        }
        if listener.is_none() && Instant::now() >= next_bind {
            #[cfg(test)]
            gauges::BIND_ATTEMPTS.with(|c| c.set(c.get() + 1));
            match TcpListener::bind(addr).await {
                Ok(l) => {
                    log::info!("[MCP-HOLD] bound {addr}");
                    #[cfg(test)]
                    if let Ok(local) = l.local_addr() {
                        gauges::BOUND.with(|b| b.borrow_mut().push(local));
                    }
                    listener = Some(l);
                }
                Err(e) => {
                    let now = Instant::now();
                    if last_bind_log.is_none_or(|t| now.duration_since(t) >= BIND_LOG_EVERY) {
                        log::warn!("[MCP-HOLD] bind {addr} still failing: {e}");
                        last_bind_log = Some(now);
                    }
                    let retry = if now.duration_since(started) < BIND_FAST_WINDOW { BIND_FAST_RETRY } else { BIND_SLOW_RETRY };
                    next_bind = now + retry;
                }
            }
        }
        tokio::select! {
            biased;
            changed = mode.changed() => {
                if changed.is_err() {
                    // A dropped sender is a Stop. (The bug-path test hook ignores that
                    // too, and must not spin on the closed channel.)
                    if !ignores_stop() {
                        return "sender dropped";
                    }
                    sleep(Duration::from_millis(50)).await;
                }
            }
            accepted = accept_on(&listener) => match accepted {
                Ok((stream, _peer)) => {
                    #[cfg(test)]
                    gauges::ACCEPTED.with(|c| c.set(c.get() + 1));
                    // Under sustained accept readiness this `biased` arm always beats
                    // the `join_next` arm below, so finished tasks (their permits are
                    // already free) are joined here, right before the next spawn, so
                    // retained entries track the live tasks instead of growing with the
                    // connections served. On a current-thread runtime they never exceed
                    // the permits. On the multi-thread runtime a task can free its permit
                    // on another worker just before its handle reads as finished, so a
                    // reap can miss it and the set briefly holds a few more entries than
                    // there are permits; the next reap joins them (review 296 R4).
                    reap_finished(set);
                    match env.limits.conn.clone().try_acquire_owned() {
                        Ok(permit) => {
                            set.spawn(connection(stream, permit, shared.clone(), mode.clone()));
                            #[cfg(test)]
                            {
                                gauges::SPAWNED.with(|c| c.set(c.get() + 1));
                                gauges::sample_retained(set.len());
                            }
                        }
                        // No free permit: closed at once, unread and unanswered.
                        Err(_) => drop(stream),
                    }
                }
                Err(e) => {
                    log::warn!("[MCP-HOLD] accept failed: {e}");
                    tokio::select! {
                        _ = sleep(Duration::from_millis(50)) => {}
                        _ = mode.changed() => {}
                    }
                }
            },
            Some(res) = set.join_next(), if !set.is_empty() => {
                reap(res);
                #[cfg(test)]
                gauges::sample_retained(set.len());
            }
            _ = until(grace_at) => {}
            _ = until(listener.is_none().then_some(next_bind)) => {}
            _ = sleep(CAP_POLL) => {}
        }
    }
}

// --- connections -----------------------------------------------------------

async fn connection(
    mut stream: TcpStream,
    _permit: OwnedSemaphorePermit,
    shared: Arc<Shared>,
    mode: watch::Receiver<Mode>,
) {
    let _guard = TaskGuard::new(Kind::Conn, 0);
    let handled = {
        let wait = || shared.wait(&mode);
        let ctx = HoldCtx {
            auth_token: shared.token.as_deref(),
            snapshot: &shared.snapshot,
            reason: shared.reason,
            wait: &wait,
            new_session_id: rpc::default_session_id,
        };
        http::handle_connection(&mut stream, &ctx).await
    };
    if let Handled::Sse(open) = handled {
        serve_sse(stream, open, shared.sse.clone(), shared.closing.clone()).await;
    }
}

/// One event stream: `: holding`, then `: ping` every 5 s, until the holder
/// closes or the client goes away. The ninth concurrent stream gets `503`.
pub async fn serve_sse<S>(mut stream: S, open: SseOpen, sse: Arc<Semaphore>, mut closing: watch::Receiver<bool>)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let Ok(_permit) = sse.try_acquire_owned() else {
        let _ = http::write_status(&mut stream, 503).await;
        return;
    };
    if http::write_sse_open(&mut stream, &open).await.is_err() {
        return;
    }
    let mut ping = interval_at(Instant::now() + SSE_PING_EVERY, SSE_PING_EVERY);
    ping.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut scratch = [0u8; 256];
    loop {
        tokio::select! {
            biased;
            changed = closing.changed() => {
                if changed.is_err() || *closing.borrow() {
                    break;
                }
            }
            _ = ping.tick() => {
                if http::write_deadline(&mut stream, SSE_PING.as_bytes()).await.is_err() {
                    break;
                }
            }
            // The client going away frees the stream slot without waiting for a failed ping.
            read = stream.read(&mut scratch) => {
                if matches!(read, Ok(0) | Err(_)) {
                    break;
                }
            }
        }
        if *closing.borrow() {
            break;
        }
    }
    let _ = timeout(WRITE_DEADLINE, stream.shutdown()).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use tokio::io::ReadBuf;

    /// A peer that never reads and never sends: it accepts the first `accept`
    /// bytes written to it, then blocks every write for ever.
    struct Stuck {
        accept: usize,
    }

    impl AsyncRead for Stuck {
        fn poll_read(self: Pin<&mut Self>, _: &mut Context<'_>, _: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
            Poll::Pending
        }
    }

    impl AsyncWrite for Stuck {
        fn poll_write(mut self: Pin<&mut Self>, _: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
            if self.accept == 0 {
                return Poll::Pending;
            }
            let n = buf.len().min(self.accept);
            self.accept -= n;
            Poll::Ready(Ok(n))
        }
        fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }
        fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    /// Lets the task run to its first await (so its timers start NOW), then
    /// moves virtual time by `by` and lets it react.
    async fn run_for(task: &tokio::task::JoinHandle<()>, by: Duration) -> bool {
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
        // In small steps, so a timer set by a reaction to an earlier step starts
        // when it would have in real time.
        let mut left = by;
        while !left.is_zero() {
            let step = left.min(Duration::from_millis(100));
            tokio::time::advance(step).await;
            for _ in 0..8 {
                tokio::task::yield_now().await;
            }
            left -= step;
        }
        task.is_finished()
    }

    fn open() -> SseOpen {
        SseOpen { session_id: Some("s".into()) }
    }

    struct FixedClock;

    impl ActiveClock for FixedClock {
        fn now(&self) -> Option<Duration> {
            Some(Duration::ZERO)
        }
    }

    /// Review 295 F5. The manager (or `serve`) is dropped before the spawned
    /// holder is first polled: the stored mode is still `Absent`, but nobody can
    /// ever change it again, and a dropped sender is a Stop. The holder must end
    /// without binding even once, whatever mode it was left with.
    #[tokio::test]
    async fn a_sender_dropped_before_the_first_poll_means_no_bind() {
        for left_with in [Mode::Absent, Mode::Handback] {
            let (env, _deadline) = HolderEnv::new(Arc::new(FixedClock));
            let spec = McpHoldSpec {
                port: 0,
                configured_port: 0,
                bind_host: "127.0.0.1".into(),
                auth_token: None,
                reason: McpHoldReason::Relaunch,
                initialize_result: None,
                tools_list_result: None,
            };
            let (tx, rx) = watch::channel(left_with);
            let task = production_spawn(env)(spec, rx);
            drop(tx);
            task.await.expect("the holder ends cleanly");
            assert_eq!(gauges::bind_attempts(), 0, "bound although its sender was gone ({left_with:?})");
            assert!(gauges::bound().is_empty(), "a listener was opened ({left_with:?})");
        }
    }

    /// A reader that never reads: the stream is dropped once `WRITE_DEADLINE`
    /// passes, not before, and not never.
    #[tokio::test(start_paused = true)]
    async fn a_slow_reader_that_accepts_nothing_is_dropped_at_the_write_deadline() {
        let (_closing_tx, closing) = watch::channel(false);
        let task = tokio::spawn(serve_sse(Stuck { accept: 0 }, open(), Arc::new(Semaphore::new(1)), closing));
        assert!(!run_for(&task, WRITE_DEADLINE - Duration::from_secs(1)).await, "not dropped early");
        assert!(run_for(&task, Duration::from_secs(2)).await, "dropped once the write deadline passed");
    }

    /// The same for a stream that opened fine and then stopped reading: the
    /// first ping that cannot be written ends it, `WRITE_DEADLINE` after it was due.
    #[tokio::test(start_paused = true)]
    async fn a_reader_that_stops_reading_is_dropped_at_the_ping_write_deadline() {
        let mut sent = Vec::new();
        http::write_sse_open(&mut sent, &open()).await.unwrap();
        let (_closing_tx, closing) = watch::channel(false);
        let task = tokio::spawn(serve_sse(Stuck { accept: sent.len() }, open(), Arc::new(Semaphore::new(1)), closing));
        assert!(!run_for(&task, SSE_PING_EVERY + WRITE_DEADLINE - Duration::from_secs(1)).await, "not dropped early");
        assert!(run_for(&task, Duration::from_secs(2)).await, "dropped once the ping's write deadline passed");
    }
}
