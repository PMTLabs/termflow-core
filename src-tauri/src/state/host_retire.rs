//! Retiring an older pty-host that has emptied.
//!
//! An update leaves the previous build's host running next to the new one. Its
//! shells keep running there, and when the last of them ends the host has nothing
//! left to do, so it is shut down. One ticker per older host watches for that:
//! every few seconds it asks the host what it holds, and a host that has held
//! nothing, and been owed nothing, for long enough is retired.
//!
//! The rules are deliberately one-sided. A host is retired only on evidence that
//! it is empty: a listing that was never answered is *unknown*, never empty, and
//! restarts the clock. And retiring is never done *to* something: a session that
//! is live, a pane that owns one, a claim a pane is taking over, an operation in
//! flight on the host, and any exit, offload or update in force all keep it.
//!
//! The decision is a pure function of facts ([`retire_decision`]); the ticker
//! only gathers them. Everything runs against [`PanePort`], which `AppState`
//! implements, so the timing and the interleavings are testable over fake hosts.

use super::host_adoption::{barrier_key, PanePort};
use super::host_registry;
use super::host_table::{Admission, DrainRefusal, QuiesceReason, TickerHandle};
use super::types::FrozenHost;
use crate::elevated_host::{FrozenId, HostChannel};
use crate::pty_host_client::HostRole;
use std::time::Duration;
use tokio::time::{Instant, MissedTickBehavior};

/// How often a host is looked at.
pub(super) const TICK: Duration = Duration::from_secs(5);
/// How long one listing is waited for. Shorter than the tick, so at most one
/// request to a host is awaited at a time; a late reply is discarded.
pub(super) const SAMPLE_TIMEOUT: Duration = Duration::from_secs(3);
/// How long a host must have been seen empty, without a break, before it is
/// retired. With the tick this puts the exit about 15 s after its last shell.
pub(super) const EMPTY_FOR: Duration = Duration::from_secs(10);

// ---- the decision -----------------------------------------------------------

/// What one look at a host found out about its sessions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Sample {
    /// The host answered; `alive` of the sessions it listed are still running.
    Answered { alive: usize },
    /// No answer in time, or not from the connection that was asked.
    Unanswered,
}

/// Everything the decision depends on, as observed at one moment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct RetireFacts {
    /// The host is not the current one, by endpoint and by role.
    pub frozen: bool,
    /// The current host is connected and admitting. While it is not, an older host
    /// is where new terminals go, and retiring it would leave them nowhere but
    /// this process.
    pub current_usable: bool,
    pub sample: Sample,
    /// Panes that own a session on the host.
    pub panes: usize,
    /// Claims a pane has not finished taking over (reserved or being registered).
    pub unfinished_claims: usize,
    /// An operation holds an admission ticket on the host.
    pub ticket_in_flight: bool,
    /// How long the host has been observed empty without a break.
    pub empty_for: Duration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Keep {
    NotFrozen,
    CurrentUnavailable,
    Unanswered,
    LiveSession,
    PaneRegistered,
    ClaimHeld,
    TicketInFlight,
    NotEmptyLongEnough,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Verdict {
    Retire,
    Keep(Keep),
}

/// Whether one observation counts towards emptiness. Only an answered listing
/// with nothing running, no pane on the host and no claim in progress does, and
/// not while the current host is unusable: the clock then starts over when it is
/// back.
pub(super) fn observation_is_empty(
    sample: Sample,
    panes: usize,
    unfinished_claims: usize,
    current_usable: bool,
) -> bool {
    current_usable && matches!(sample, Sample::Answered { alive: 0 }) && panes == 0 && unfinished_claims == 0
}

/// May the host be retired now? Each reason to keep it is checked on its own, so
/// the answer names the first one that applies.
pub(super) fn retire_decision(facts: &RetireFacts) -> Verdict {
    if !facts.frozen {
        return Verdict::Keep(Keep::NotFrozen);
    }
    if !facts.current_usable {
        return Verdict::Keep(Keep::CurrentUnavailable);
    }
    match facts.sample {
        Sample::Unanswered => return Verdict::Keep(Keep::Unanswered),
        Sample::Answered { alive } if alive > 0 => return Verdict::Keep(Keep::LiveSession),
        Sample::Answered { .. } => {}
    }
    if facts.panes > 0 {
        return Verdict::Keep(Keep::PaneRegistered);
    }
    if facts.unfinished_claims > 0 {
        return Verdict::Keep(Keep::ClaimHeld);
    }
    if facts.ticket_in_flight {
        return Verdict::Keep(Keep::TicketInFlight);
    }
    if facts.empty_for < EMPTY_FOR {
        return Verdict::Keep(Keep::NotEmptyLongEnough);
    }
    Verdict::Retire
}

/// How long the host has been empty, without a break. Any observation that is
/// not empty, an unanswered one included, starts it over.
#[derive(Default)]
pub(super) struct Emptiness {
    since: Option<Instant>,
}

impl Emptiness {
    /// Record an observation; returns how long the host has been empty as of it.
    pub(super) fn observe(&mut self, now: Instant, empty: bool) -> Duration {
        if !empty {
            self.since = None;
            return Duration::ZERO;
        }
        let since = *self.since.get_or_insert(now);
        now.saturating_duration_since(since)
    }

    pub(super) fn reset(&mut self) {
        self.since = None;
    }
}

// ---- the ticker -------------------------------------------------------------

/// Start watching the older host `id` for emptiness, unless it already is. For
/// the moment the host is adopted or its connection replaced.
pub(super) fn start_ticker<P: PanePort>(port: &P, id: FrozenId) {
    let Some(handle) = port.table().start_ticker(HostChannel::Frozen(id)) else { return };
    tokio::spawn(run_ticker(port.clone(), id, handle));
}

async fn run_ticker<P: PanePort>(port: P, id: FrozenId, handle: TickerHandle) {
    // The first tick is at once: a host adopted empty starts its clock then.
    let mut ticks = tokio::time::interval(TICK);
    // A look that ran long is not made up for with a burst.
    ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut emptiness = Emptiness::default();
    loop {
        tokio::select! {
            _ = ticks.tick() => {}
            _ = handle.nudged() => {}
        }
        if let Next::Stop = look(&port, id, &mut emptiness).await {
            return;
        }
    }
}

enum Next {
    Go,
    Stop,
}

/// The host as of one look, for the checks that must hold again later.
struct Seen {
    host: FrozenHost,
    channel: HostChannel,
    epoch: u64,
}

/// Which connection the host has now, if it can be looked at at all: it is
/// registered, open for admission, and its client is alive.
fn reachable<P: PanePort>(port: &P, id: FrozenId) -> Option<Seen> {
    let channel = HostChannel::Frozen(id);
    let host = port.frozen_hosts().into_iter().find(|h| h.id == id)?;
    let epoch = port.table().epoch(channel)?;
    (port.table().admission(channel) == Some(Admission::Open) && host.client.is_alive())
        .then_some(Seen { host, channel, epoch })
}

/// Is `host` an older host, going by where it lives and what role it was given?
fn is_frozen<P: PanePort>(port: &P, host: &FrozenHost) -> bool {
    let key = barrier_key(&host.endpoint);
    barrier_key(&port.current_endpoint()) != key && port.barrier().role_of(&key) != Some(HostRole::Current)
}

/// Ask the host what it holds. The answer counts only if it came through the
/// connection that was asked; an answered one also settles the claims it shows to
/// be moot.
async fn sample<P: PanePort>(port: &P, seen: &Seen) -> Sample {
    let listed = seen.host.client.list_sessions_within(SAMPLE_TIMEOUT).await;
    let Some(sessions) = listed else { return Sample::Unanswered };
    if !port.table().is_current(seen.channel, seen.epoch) || !seen.host.client.is_alive() {
        return Sample::Unanswered;
    }
    host_registry::drop_stale_reserved_claims(port.claims(), seen.channel, &sessions);
    Sample::Answered { alive: sessions.iter().filter(|s| s.alive).count() }
}

/// Is the current host connected and admitting? The same question the router asks
/// before it falls back to an older host.
fn current_usable<P: PanePort>(port: &P) -> bool {
    port.current_client().is_some_and(|client| client.is_alive())
        && port.table().admission(HostChannel::Primary) == Some(Admission::Open)
}

fn facts<P: PanePort>(port: &P, seen: &Seen, sample: Sample, empty_for: Duration) -> RetireFacts {
    RetireFacts {
        frozen: is_frozen(port, &seen.host),
        current_usable: current_usable(port),
        sample,
        panes: port.panes_on(seen.channel).len(),
        unfinished_claims: host_registry::unfinished_claims_on(port.claims(), seen.channel),
        ticket_in_flight: port.table().inflight(seen.channel) > 0,
        empty_for,
    }
}

/// One look at the host: ask it, remember whether it was empty, and retire it if
/// it has been for long enough.
async fn look<P: PanePort>(port: &P, id: FrozenId, emptiness: &mut Emptiness) -> Next {
    let channel = HostChannel::Frozen(id);
    match port.table().admission(channel) {
        None | Some(Admission::Retired) => return Next::Stop,
        // Someone else is deciding about the host right now.
        Some(Admission::Draining) => {
            emptiness.reset();
            return Next::Go;
        }
        Some(Admission::Open) => {}
    }
    match port.table().lifecycle_reason() {
        None => {}
        // The process is ending; the exit releases every host itself.
        Some(QuiesceReason::Exit) => return Next::Stop,
        // An offload or update holds the table: a retirement cannot commit while it
        // does, and the hosts are about to be armed or released by it. So nothing is
        // asked of them, and nothing seen before the hold counts after it.
        Some(_) => {
            emptiness.reset();
            return Next::Go;
        }
    }
    let Some(seen) = reachable(port, id) else {
        // Registered with no connection: its reconnect owns it, and a host gone
        // from the registry has nothing left to watch.
        emptiness.reset();
        return if port.frozen_hosts().iter().any(|h| h.id == id) { Next::Go } else { Next::Stop };
    };

    let answer = sample(port, &seen).await;
    let panes = port.panes_on(seen.channel).len();
    let claims = host_registry::unfinished_claims_on(port.claims(), seen.channel);
    let empty_for =
        emptiness.observe(Instant::now(), observation_is_empty(answer, panes, claims, current_usable(port)));
    match retire_decision(&facts(port, &seen, answer, empty_for)) {
        Verdict::Keep(why) => {
            log::debug!("[GEN] terminal host {} stays: {why:?}", seen.host.endpoint);
            Next::Go
        }
        Verdict::Retire => retire(port, &seen, emptiness).await,
    }
}

/// Retire a host that has been empty long enough. Admission is closed first, so
/// nothing new can start on it, and it is looked at once more under that closure
/// before anything irreversible is done; the host is retired only if that look
/// still finds it empty.
///
/// The last step is closing the connection (`close_transport`, bounded): the host
/// sees EOF and, being empty, exits by itself. This does not wait for the host's
/// process to be gone, because the connection holds no handle on it; a host that
/// does not exit is not noticed here, and is kept from being adopted again by the
/// retired mark in the barrier.
async fn retire<P: PanePort>(port: &P, seen: &Seen, emptiness: &mut Emptiness) -> Next {
    let endpoint = &seen.host.endpoint;
    let drain = match port.table().drain_host(seen.channel) {
        Ok(drain) => drain,
        Err(DrainRefusal::InFlight) => {
            log::info!("[GEN] terminal host {endpoint} is empty but an operation is in flight on it; will look again");
            return Next::Go;
        }
        Err(DrainRefusal::NotOpen(Admission::Retired) | DrainRefusal::NoSuchHost) => return Next::Stop,
        Err(DrainRefusal::NotOpen(_)) => return Next::Go,
    };
    log::info!("[GEN] terminal host {endpoint} has been empty for {EMPTY_FOR:?}; checking once more before retiring it");

    let answer = sample(port, seen).await;
    let still_this_host = port.table().epoch(seen.channel) == Some(seen.epoch)
        && port.frozen_hosts().iter().any(|h| h.id == seen.host.id && h.client.is_alive());
    let confirmed = still_this_host
        && retire_decision(&facts(port, seen, answer, EMPTY_FOR)) == Verdict::Retire;
    if !confirmed || !drain.retire_when_open() {
        // Dropping the guard (inside `retire_when_open` on the other path) reopens
        // the host. What was seen no longer holds, so the clock starts over.
        log::info!("[GEN] terminal host {endpoint} is not retired after all ({answer:?})");
        emptiness.reset();
        return Next::Go;
    }

    port.forget_host(seen.host.id);
    port.barrier().mark_retired(&barrier_key(endpoint), endpoint);
    log::info!("[GEN] retired terminal host {endpoint}: shutting it down");
    // An empty host exits when its GUI connection ends. A host that announces
    // exits is told this one is on purpose; the stream is then really closed.
    if !seen.host.client.shutdown().await {
        log::warn!("[GEN] retired terminal host {endpoint} did not acknowledge the shutdown");
    }
    if !seen.host.client.close_transport().await {
        log::warn!("[GEN] the connection to retired terminal host {endpoint} did not close in time");
    }
    Next::Stop
}

#[cfg(test)]
mod decision_tests;
