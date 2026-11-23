//! Per-terminal sampling. The owner/visibility layer supplies eligibility; this
//! layer owns cadence, exec admission, baselines and host-protection state.
use super::{
    check_collector_exit, collector_command,
    model::{Metrics, MetricsSnapshot},
    protocol::{self, RawSample},
    reduce::Reducer,
};
use crate::ssh::{
    auth::BoxFuture,
    session::{engine_runtime, ExecOpts, ExecOutcome, SessionError, SessionRegistry, SshSession},
    sessions::with_session,
};
use parking_lot::Mutex;
use serde::Serialize;
use std::{
    collections::HashMap,
    future::Future,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{sync::Notify, time::Instant};

pub(super) const CADENCE: Duration = Duration::from_secs(2);
const DEADLINE: Duration = Duration::from_secs(5);
const STDOUT_CAP: usize = 1024 * 1024;
const STDERR_CAP: usize = 16 * 1024;
const SAMPLE: &str = "ssh-metrics:sample";
const CONTROL: &str = "ssh-metrics:control";
const TIMEOUT: &str = "Metrics paused: host didn't answer in 5 s";
const WATCHDOG: &str = "Metrics paused: NFS usage watchdog expired";
const CLEANUP: &str = "Metrics paused: could not clean up metrics exec";

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fence {
    pub sample_floor: u64,
    pub generation: u64,
    pub pause_seq: u64,
    pub paused_reason: Option<&'static str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsControl<'a> {
    pub terminal_id: &'a str,
    pub generation: u64,
    pub pause_seq: u64,
    pub paused_reason: Option<&'static str>,
}

#[derive(Clone, Copy, Serialize)]
#[serde(untagged)]
pub enum MetricsEvent<'a> {
    Sample(&'a MetricsSnapshot),
    Control(&'a MetricsControl<'a>),
}

/// Queue a local event synchronously. Called at admission, under the terminal
/// and session-entry fences; must not re-enter either registry or query native state.
pub trait EventSink: Send + Sync {
    fn emit(&self, name: &'static str, event: MetricsEvent<'_>);
}

impl<R: tauri::Runtime> EventSink for tauri::AppHandle<R> {
    fn emit(&self, name: &'static str, event: MetricsEvent<'_>) {
        let _ = tauri::Emitter::emit(self, name, event);
    }
}

pub struct SamplerRegistry {
    sessions: Arc<SessionRegistry>,
    events: Arc<dyn EventSink>,
    workers: Arc<Workers>,
    observer: Option<Arc<dyn EligibilityObserver>>,
}

/// Refresh the authoritative watch/visibility decision outside sampler locks.
/// Used at collection admission and again before offering telemetry.
pub(crate) trait EligibilityObserver: Send + Sync {
    fn refresh<'a>(&'a self, terminal_id: &'a str) -> BoxFuture<'a, ()>;
}

type Workers = Mutex<HashMap<String, Arc<Terminal>>>;

impl SamplerRegistry {
    pub fn new(sessions: Arc<SessionRegistry>, events: Arc<dyn EventSink>) -> Self {
        Self {
            sessions,
            events,
            workers: Arc::default(),
            observer: None,
        }
    }

    pub(crate) fn observing(
        sessions: Arc<SessionRegistry>,
        events: Arc<dyn EventSink>,
        observer: Arc<dyn EligibilityObserver>,
    ) -> Self {
        Self {
            sessions,
            events,
            workers: Arc::default(),
            observer: Some(observer),
        }
    }

    /// Hidden owners need a cheap eligibility wake, but no remote work. With
    /// no registered owners there is no periodic eligibility wake at all.
    pub(crate) fn set_observed(&self, terminal_id: &str, observed: bool) {
        if let Some(worker) = self.existing(terminal_id) {
            let mut state = worker.state.lock();
            if !state.retired && state.observed != observed {
                state.observed = observed;
                worker.wake.notify_one();
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn status(&self, id: &str) -> Option<(Option<u64>, bool, bool)> {
        let worker = self.existing(id)?;
        let state = worker.state.lock();
        Some((state.generation, state.eligible && !state.retired, state.in_flight))
    }

    /// Apply the authoritative eligibility decision for this terminal. Callers
    /// arbitrate owners and native visibility before updating this seam. `false`
    /// never cancels an admitted exec, including on last unwatch/page retirement.
    pub fn set_eligible(&self, terminal_id: &str, eligible: bool) -> Result<(), SessionError> {
        let worker = if eligible {
            self.worker_for(terminal_id)?
        } else if let Some(worker) = self.existing(terminal_id) {
            worker
        } else {
            return Ok(());
        };
        worker.set_eligible(eligible)
    }

    /// Reserve a consumer-local floor without changing cadence or rate baselines.
    pub fn fence(&self, terminal_id: &str) -> Result<Fence, SessionError> {
        self.worker_for(terminal_id)?
            .fence(&self.sessions, &*self.events, false)
    }

    /// The caller has verified the current consumer. Never opens a session.
    pub fn resume(&self, terminal_id: &str) -> Result<Fence, SessionError> {
        self.existing(terminal_id)
            .ok_or(SessionError::NotConnected)?
            .fence(&self.sessions, &*self.events, true)
    }

    /// Permanently retire a terminal (not just a watcher). Keep the worker slot
    /// reserved until the drain finishes. Only 067 teardown cancels the exec.
    pub fn retire(&self, terminal_id: &str) {
        if let Some(worker) = self.existing(terminal_id) {
            worker.retire();
        }
    }

    fn existing(&self, terminal_id: &str) -> Option<Arc<Terminal>> {
        self.workers.lock().get(terminal_id).cloned()
    }

    fn worker_for(&self, terminal_id: &str) -> Result<Arc<Terminal>, SessionError> {
        let mut workers = self.workers.lock();
        if let Some(worker) = workers.get(terminal_id) {
            return Ok(worker.clone());
        }
        // No worker for an unknown id, a disconnected terminal, or a pane-less probe.
        self.sessions.admit_connected(terminal_id, |_, _| Ok(()))?;
        let worker = Arc::new(Terminal::new(terminal_id));
        workers.insert(terminal_id.into(), worker.clone());
        let running = worker.clone();
        let sessions = self.sessions.clone();
        let events = self.events.clone();
        let workers = Arc::downgrade(&self.workers);
        let observer = self.observer.clone();
        engine_runtime().spawn(async move {
            running
                .run(&sessions, &*events, observer.as_deref(), |lease| collect(&sessions, &running.id, lease))
                .await;
            if let Some(workers) = workers.upgrade() {
                workers.lock().remove(&running.id);
            }
        });
        Ok(worker)
    }
}

impl Drop for SamplerRegistry {
    fn drop(&mut self) {
        for worker in self.workers.lock().values() {
            worker.retire();
        }
    }
}

#[derive(Default)]
struct State {
    retired: bool,
    eligible: bool,
    observed: bool,
    #[cfg(test)]
    in_flight: bool,
    disarmed: bool,
    generation: Option<u64>,
    pause_seq: u64,
    paused_reason: Option<&'static str>,
    // Changing eligibility or resuming invalidates telemetry from a draining
    // exec, but does not invalidate its indeterminate-work outcome.
    telemetry_epoch: u64,
    last_stamp: u64,
    reducer: Reducer,
    last_warning: Option<Instant>,
}

impl State {
    fn reserve(&mut self, wall_ms: u64) -> u64 {
        self.last_stamp = wall_ms.max(self.last_stamp + 1);
        self.last_stamp
    }

    fn forget_telemetry(&mut self) {
        self.telemetry_epoch += 1;
        self.reducer.reset();
    }

    fn sync_generation(&mut self, id: &str, events: &dyn EventSink, generation: u64) {
        if self.generation == Some(generation) {
            return;
        }
        let reconnect = self.generation.replace(generation).is_some();
        self.forget_telemetry();
        self.disarmed = false;
        self.pause_seq = 0;
        self.paused_reason = None;
        if reconnect {
            self.control(id, events, generation);
        }
    }

    fn control(&self, id: &str, events: &dyn EventSink, generation: u64) {
        events.emit(
            CONTROL,
            MetricsEvent::Control(&MetricsControl {
                terminal_id: id,
                generation,
                pause_seq: self.pause_seq,
                paused_reason: self.paused_reason,
            }),
        );
    }

    fn warn(&mut self, id: &str, reason: &'static str) {
        let now = Instant::now();
        if self.last_warning.is_none_or(|last| now - last >= Duration::from_secs(30)) {
            self.last_warning = Some(now);
            log::warn!("[SSH-METRICS] {id}: {reason}");
        }
    }
}

struct Terminal {
    id: String,
    state: Mutex<State>,
    wake: Notify,
}

struct Tick {
    generation: u64,
    lease: Arc<SshSession>,
    telemetry_epoch: u64,
    sampled_at: u64,
    started: Instant,
}

enum Action {
    Stop,
    Wait(Option<Instant>),
    Collect(Tick),
}

impl Terminal {
    fn new(id: &str) -> Self {
        Self {
            id: id.into(),
            state: Mutex::default(),
            wake: Notify::new(),
        }
    }

    fn set_eligible(&self, eligible: bool) -> Result<(), SessionError> {
        let mut state = self.state.lock();
        if state.retired {
            return Err(SessionError::OwnerRetired);
        }
        if state.eligible != eligible {
            state.eligible = eligible;
            state.forget_telemetry();
            self.wake.notify_one();
        }
        Ok(())
    }

    fn retire(&self) {
        let mut state = self.state.lock();
        state.retired = true;
        state.eligible = false;
        state.forget_telemetry();
        self.wake.notify_one();
    }

    fn fence(
        &self,
        sessions: &SessionRegistry,
        events: &dyn EventSink,
        resume: bool,
    ) -> Result<Fence, SessionError> {
        self.fence_at(sessions, events, resume, wall_now_ms)
    }

    fn fence_at(
        &self,
        sessions: &SessionRegistry,
        events: &dyn EventSink,
        resume: bool,
        wall_ms: impl FnOnce() -> u64,
    ) -> Result<Fence, SessionError> {
        let mut state = self.state.lock();
        if state.retired {
            return Err(SessionError::OwnerRetired);
        }
        let fence = sessions.admit_connected(&self.id, |generation, _| {
            state.sync_generation(&self.id, events, generation);
            if resume {
                state.forget_telemetry();
                state.pause_seq += 1;
                state.paused_reason = None;
                state.control(&self.id, events, generation);
            }
            Ok(Fence {
                sample_floor: state.reserve(wall_ms()),
                generation,
                pause_seq: state.pause_seq,
                paused_reason: state.paused_reason,
            })
        })?;
        // A fresh fence may be the first notice of a replacement session.
        self.wake.notify_one();
        Ok(fence)
    }

    #[cfg(test)]
    fn plan_tick(
        &self,
        sessions: &SessionRegistry,
        events: &dyn EventSink,
        not_before: Instant,
        wall_ms: impl FnOnce() -> u64,
    ) -> Action {
        self.plan_checked(sessions, events, not_before, true, wall_ms)
    }

    fn plan_checked(
        &self,
        sessions: &SessionRegistry,
        events: &dyn EventSink,
        not_before: Instant,
        visibility_checked: bool,
        wall_ms: impl FnOnce() -> u64,
    ) -> Action {
        let mut state = self.state.lock();
        if state.retired {
            return Action::Stop;
        }
        let result = sessions.admit_connected(&self.id, |generation, lease| {
            state.sync_generation(&self.id, events, generation);
            let started = Instant::now();
            Ok((state.eligible
                && visibility_checked
                && !state.disarmed
                && state.paused_reason.is_none()
                && started >= not_before)
                .then(|| Tick {
                    generation,
                    lease: lease.clone(),
                    telemetry_epoch: state.telemetry_epoch,
                    sampled_at: state.reserve(wall_ms()),
                    started,
                }))
        });
        let now = Instant::now();
        let waking = state.eligible || state.observed;
        match result {
            Ok(Some(tick)) => {
                #[cfg(test)]
                { state.in_flight = true; }
                Action::Collect(tick)
            }
            Ok(None) if waking && (!visibility_checked || not_before > now) => {
                Action::Wait(Some(not_before.max(now)))
            }
            Ok(None) => Action::Wait(waking.then(|| now + CADENCE)),
            Err(_) => {
                state.forget_telemetry();
                Action::Wait(waking.then(|| now + CADENCE))
            }
        }
    }

    fn observing(&self) -> bool {
        let state = self.state.lock();
        state.observed && !state.retired
    }

    async fn run<F, Fut>(
        &self, sessions: &SessionRegistry, events: &dyn EventSink,
        observer: Option<&dyn EligibilityObserver>, collect: F,
    )
    where
        F: Fn(Arc<SshSession>) -> Fut,
        Fut: Future<Output = (ExecOutcome, String)>,
    {
        let mut next = Instant::now();
        loop {
            // A receiver is tied to one 067 entry; reacquire on each wake so
            // replacement cannot leave us subscribed to a retired generation.
            let mut transition = sessions.subscribe_transitions(&self.id).ok();
            let visibility_checked = if let Some(observer) = observer {
                if Instant::now() >= next && self.observing() {
                    observer.refresh(&self.id).await;
                    true
                } else {
                    false
                }
            } else {
                true
            };
            // Don't let the clock crossing a boundary between these two
            // checks turn an unchecked window into an admitted collection.
            match self.plan_checked(sessions, events, next, visibility_checked, wall_now_ms) {
                Action::Stop => break,
                Action::Wait(until) => {
                    tokio::select! {
                        _ = self.wake.notified() => {},
                        _ = async {
                            if let Some(changes) = &mut transition {
                                let _ = changes.changed().await;
                            } else {
                                std::future::pending::<()>().await;
                            }
                        } => {},
                        _ = async {
                            if let Some(until) = until {
                                tokio::time::sleep_until(until).await;
                            } else {
                                std::future::pending::<()>().await;
                            }
                        } => {},
                    }
                }
                Action::Collect(tick) => {
                    // No select/drop here. Even when losing all owners, await
                    // the real reader and feed its outcome to the pause latch.
                    let (outcome, nonce) = collect(tick.lease.clone()).await;
                    if let Some(observer) = observer.filter(|_| self.observing()) {
                        observer.refresh(&self.id).await;
                    }
                    let _ = self.finish(sessions, events, &tick, classify(&outcome, &nonce));
                    next = next_start(tick.started, Instant::now());
                }
            }
        }
    }

    fn finish(
        &self,
        sessions: &SessionRegistry,
        events: &dyn EventSink,
        tick: &Tick,
        result: Reading<'_>,
    ) -> Result<(), SessionError> {
        let mut state = self.state.lock();
        #[cfg(test)]
        { state.in_flight = false; }
        if state.retired {
            return Err(SessionError::OwnerRetired);
        }
        if state.generation != Some(tick.generation) {
            return Err(SessionError::NotConnected);
        }
        let eligible = state.eligible && state.telemetry_epoch == tick.telemetry_epoch;
        // Reduce outside the session-entry lock. If the lease was revoked while
        // reducing, the second admission below discards this result and baseline.
        let (metrics, pause) = match result {
            Reading::Sample(raw) if eligible => (Some(state.reducer.reduce_at(raw, tick.started.into_std())), None),
            Reading::Sample(_) => (None, None),
            Reading::Unavailable(reason) => {
                state.reducer.reset();
                state.warn(&self.id, reason);
                (eligible.then(|| Metrics::unavailable(reason)), None)
            }
            Reading::IndeterminateRemoteWork { reason, completed } => {
                let metrics = completed.filter(|_| eligible).map(|raw| state.reducer.reduce_at(raw, tick.started.into_std()));
                state.reducer.reset();
                (metrics, Some(reason))
            }
            Reading::Discard { disarm } => {
                state.reducer.reset();
                state.disarmed |= disarm;
                (None, None)
            }
        };
        let admitted = sessions.admit_connected(&self.id, |generation, lease| {
            if generation != tick.generation || !Arc::ptr_eq(lease, &tick.lease) {
                return Err(SessionError::NotConnected);
            }
            if let Some(reason) = pause {
                state.pause_seq += 1;
                state.paused_reason = Some(reason);
                state.warn(&self.id, reason);
                state.control(&self.id, events, generation);
            }
            if let Some(metrics) = metrics {
                events.emit(
                    SAMPLE,
                    MetricsEvent::Sample(&MetricsSnapshot {
                        terminal_id: self.id.clone(),
                        sampled_at: tick.sampled_at,
                        metrics,
                    }),
                );
            }
            Ok(())
        });
        if admitted.is_err() {
            state.reducer.reset();
        }
        admitted
    }
}

fn next_start(start: Instant, finished: Instant) -> Instant {
    // First strictly future boundary, anchored to the admitted start. No
    // catch-up tick, including after a multi-period overrun or OS suspension.
    let remainder = (finished.duration_since(start).as_nanos() % CADENCE.as_nanos()) as u64;
    finished + CADENCE - Duration::from_nanos(remainder)
}

fn wall_now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

async fn collect(
    sessions: &SessionRegistry,
    terminal_id: &str,
    admitted: Arc<SshSession>,
) -> (ExecOutcome, String) {
    let (command, nonce) = collector_command();
    let result = with_session(sessions, terminal_id, |lease| async move {
        // with_session may have acquired a replacement since tick admission.
        if !Arc::ptr_eq(&lease, &admitted) {
            return Err(SessionError::NotConnected);
        }
        Ok(lease
            .exec_with_cleanup(
                &command,
                ExecOpts {
                    deadline: DEADLINE,
                    stdout_cap: STDOUT_CAP,
                    stderr_cap: STDERR_CAP,
                    cancel: lease.cancellation(),
                },
            )
            .await)
    })
    .await;
    (result.unwrap_or_else(ExecOutcome::from), nonce)
}

enum Reading<'a> {
    Sample(RawSample<'a>),
    Unavailable(&'static str),
    IndeterminateRemoteWork {
        reason: &'static str,
        completed: Option<RawSample<'a>>,
    },
    Discard { disarm: bool },
}

fn classify<'a>(outcome: &'a ExecOutcome, nonce: &str) -> Reading<'a> {
    if matches!(&outcome.result, Err(SessionError::TimedOut)) {
        return paused(TIMEOUT);
    }
    if outcome.cleanup_failure.is_some() {
        return paused(CLEANUP);
    }
    let output = match &outcome.result {
        Ok(output) => output,
        Err(error) => return classify_error(error),
    };
    if let Err(error) = check_collector_exit(output.exit) {
        return Reading::Unavailable(match error {
            super::CollectorError::Unavailable => "Metrics collector unavailable",
            super::CollectorError::Failed(_) => "Metrics command failed",
        });
    }
    match protocol::parse(&output.stdout, nonce) {
        Ok(raw) if raw.nfs_watchdog_expired => Reading::IndeterminateRemoteWork {
            reason: WATCHDOG,
            completed: Some(raw),
        },
        Ok(raw) => Reading::Sample(raw),
        Err(reason) => Reading::Unavailable(reason),
    }
}

fn paused(reason: &'static str) -> Reading<'static> {
    Reading::IndeterminateRemoteWork { reason, completed: None }
}

fn classify_error(error: &SessionError) -> Reading<'static> {
    use SessionError::*;
    match error {
        TimedOut => paused(TIMEOUT),
        OutputTooLarge => Reading::Unavailable("Metrics output exceeded limit"),
        CapabilityUnavailable => Reading::Unavailable("Metrics exec unavailable"),
        TransportClosed => Reading::Unavailable("Metrics transport closed"),
        MissingExitStatus => Reading::Unavailable("Metrics exit status missing"),
        Cancelled => Reading::Discard { disarm: false },
        NotConnected | NotFound | StaleAttempt | OwnerRetired | AdmissionClosed | InvalidTarget
        | HostKeyChanged | HostKeyRevoked | HostCertificateUnsupported | KnownHostsMalformed { .. }
        | KnownHostsUnreadable | TrustWriteFailed | TrustAlreadyPinned | AuthRejected
        | AgentUnavailable | IdentityUnreadable | IdentityEncryptionUnsupported | UnsupportedAuthentication | RememberUnavailable
        | StoreUnavailable => Reading::Discard { disarm: true },
    }
}

#[cfg(test)]
mod tests;
