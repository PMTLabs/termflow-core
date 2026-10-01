//! Getting a host back after its connection dropped.
//!
//! Each host recovers on its own. The primary's drop reattaches the primary's
//! panes; an older host's drop retries that host's endpoint and reattaches only
//! the panes that host owned. A host's listing is never compared with another
//! host's panes, so one host's recovery cannot tear down a neighbour's tabs.

use super::panes::{reattach_listed, PanePort};
use super::{
    adopt, barrier_key, reconnect_current, wait_for_reopen, Failure, FrozenHost, HostChannel, HostRole, PtyHostClient,
    ADOPTION_DEADLINE, LIFECYCLE_BUSY, LIST_ATTEMPTS, LIST_RETRY_PAUSE,
};
use crate::elevated_host::FrozenId;
use crate::state::host_table::{Admission, DrainRefusal, QuiesceReason};
use futures::future::join_all;
use std::time::Duration;
use termflow_pty_protocol::SessionMeta;
use tokio::time::Instant;

/// Waits between reconnect attempts, whichever host dropped.
pub(in crate::state) const RECONNECT_BACKOFF_MS: &[u64] = &[500, 1000, 2000, 4000, 8000, 8000, 8000];

/// Ask a freshly reconnected host for its sessions. Only an ANSWERED listing is
/// authority: a timeout or dead pipe must never read as "the host has no
/// sessions", which would tear down every live pane on a transport failure.
async fn list_with_retries(client: &PtyHostClient) -> Option<Vec<SessionMeta>> {
    for attempt in 0..LIST_ATTEMPTS {
        if let Some(sessions) = client.list_sessions().await {
            return Some(sessions);
        }
        if attempt + 1 < LIST_ATTEMPTS {
            tokio::time::sleep(LIST_RETRY_PAUSE).await;
        }
    }
    None
}

/// Reconnect-first recovery after the primary's pipe dropped (sleep/wake resume,
/// transient I/O error): bounded-backoff reconnect to the SURVIVING host, then
/// reattach every still-held session in place from its saved ring offset (the
/// ring replays exactly the bytes missed while disconnected). Only sessions the
/// reconnected host no longer holds — or a fully failed reconnect — get the old
/// destructive teardown.
///
/// Only the primary's panes are considered: an older host's session never
/// appears in the primary's listing, so it would read as lost.
pub(in crate::state) async fn reconnect_primary<P: PanePort>(port: &P, backoff_ms: &[u64]) {
    log::info!("[GEN] reconnecting current terminal host {}", port.current_endpoint());
    let channel = HostChannel::Primary;
    // This whole pass runs in the HOST's id space: `plan_reattach` matches
    // against `SessionMeta.tab_id` and `host_stream_offsets` is keyed the
    // same way. `host_terminals` is keyed by our `pc-` process id, so comparing
    // the two directly matches NOTHING and sends every live terminal to
    // teardown — i.e. a transient pipe drop (sleep/wake) would destroy every
    // shell. Translate once, here.
    let initial_by_session = port.panes_on(channel);
    // Do not return when the app currently owns no tabs: the host can still
    // hold live sessions which must be recovered into visible terminals.
    let tabs: Vec<String> = initial_by_session.keys().cloned().collect();
    let connected = reconnect_current(port, backoff_ms).await;
    let client = if connected { port.current_client() } else { None };
    let Some(client) = client else {
        // Exit closes admission for good and ends the connection itself; a drop
        // seen then is the exit, not a host that went away.
        if port.table().lifecycle_reason() == Some(QuiesceReason::Exit) {
            log::info!("[HOTSWAP] pty-host pipe dropped while exiting; leaving {} host pane(s) alone", tabs.len());
            return;
        }
        log::error!("[HOTSWAP] could not reconnect to any pty-host; closing {} host pane(s)", tabs.len());
        // A pane the user closed while this was going on is already gone.
        for process_id in initial_by_session.values().filter(|p| port.pane_is_host_owned(p)) {
            port.teardown_pane(process_id);
        }
        return;
    };
    // The connection this pass is allowed to act on. If the pipe drops (or a
    // newer connection lands) mid-pass, a NEWER recovery owns the state —
    // this pass must stop before any attach/teardown.
    let Some(epoch) = port.table().epoch(channel) else { return };
    let still_current = || port.table().is_current(channel, epoch) && port.current_client().is_some();
    let Some(sessions) = list_with_retries(&client).await else {
        log::error!(
            "[HOTSWAP] host never answered ListSessions during recovery; \
             leaving {} pane(s) untouched (a later drop or create retries)",
            tabs.len()
        );
        return;
    };
    if !still_current() {
        log::warn!("[HOTSWAP] recovery superseded (epoch {epoch} stale); aborting pass");
        return;
    }
    reattach_listed(port, channel, &client, &tabs, &sessions, &still_current).await;
}

/// How a reconnect of an older host ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::state) enum FrozenReconnect {
    /// Connected again, and its panes were reconciled with what it holds.
    Reconnected,
    /// Nothing was done: the host was retired, another connection took over, a
    /// reconnect of it was already running, or the app is exiting.
    Inert,
    /// Every attempt failed and the host's panes were closed. `dropped` says the
    /// host itself was found dead and removed from the registry.
    GaveUp { dropped: bool },
}

enum Standing {
    Open,
    /// Being retired right now; it either reopens or goes.
    Draining,
    Gone,
}

fn registered<P: PanePort>(port: &P, id: FrozenId) -> Option<FrozenHost> {
    port.frozen_hosts().into_iter().find(|h| h.id == id)
}

fn standing<P: PanePort>(port: &P, id: FrozenId) -> Standing {
    if registered(port, id).is_none() {
        return Standing::Gone;
    }
    match port.table().admission(HostChannel::Frozen(id)) {
        Some(Admission::Open) => Standing::Open,
        Some(Admission::Draining) => Standing::Draining,
        Some(Admission::Retired) | None => Standing::Gone,
    }
}

/// Retry an older host's endpoint after its connection dropped, then reattach the
/// panes it owned. `lost_epoch` is the connection that dropped: if the host has
/// been given another since, or was retired, there is nothing to do.
///
/// An attempt refused because admission is closed waits for it to reopen and does
/// not use up a backoff step or close any pane. When every attempt fails the
/// host's panes are closed, as for the primary. If the host's process is also
/// gone it is dropped from the registry, as if retired, so that it never stays
/// "owned but disconnected" and blocks an offload or update until the next start.
///
/// Only one reconnect of a host runs. The connection it makes can itself drop
/// before the pass is over; that drop's own reconnect finds this one running and
/// leaves a note, and this one then runs again for the newer connection instead
/// of leaving the host unreachable until the next sweep.
pub(in crate::state) async fn reconnect_frozen<P: PanePort>(
    port: &P,
    id: FrozenId,
    lost_epoch: u64,
    backoff_ms: &[u64],
) -> FrozenReconnect {
    log::info!("[GEN] reconnecting frozen terminal host {id:?} from epoch {lost_epoch}");
    let Some(host) = registered(port, id) else { return FrozenReconnect::Inert };
    if !port.table().is_current(HostChannel::Frozen(id), lost_epoch) || host.client.is_alive() {
        return FrozenReconnect::Inert;
    }
    let key = barrier_key(&host.endpoint);
    let Some(mut claim) = port.barrier().begin_reconnect(&key) else { return FrozenReconnect::Inert };
    let mut reconnected = None;
    loop {
        let outcome = match (reconnect_frozen_pass(port, id, &key, backoff_ms).await, reconnected) {
            // The host is back already: the earlier pass did the work.
            (FrozenReconnect::Inert, Some(earlier)) => earlier,
            (outcome, _) => outcome,
        };
        if outcome != FrozenReconnect::Reconnected || !claim.rerun() {
            return outcome;
        }
        log::info!(
            "[GEN] terminal host {} dropped again while it was being reconnected; reconnecting again",
            host.endpoint
        );
        reconnected = Some(outcome);
    }
}

/// One full pass of [`reconnect_frozen`], for the claim it holds.
async fn reconnect_frozen_pass<P: PanePort>(
    port: &P,
    id: FrozenId,
    key: &str,
    backoff_ms: &[u64],
) -> FrozenReconnect {
    let channel = HostChannel::Frozen(id);
    let Some(host) = registered(port, id) else { return FrozenReconnect::Inert };
    if host.client.is_alive() {
        return FrozenReconnect::Inert;
    }

    // The panes this host owned before the attempt: the only ones whose fate its
    // answer may decide.
    let before = port.panes_on(channel);
    let tabs: Vec<String> = before.keys().cloned().collect();
    let mut step = 0;
    let mut gone = false;
    while step < backoff_ms.len() {
        match standing(port, id) {
            Standing::Gone => return FrozenReconnect::Inert,
            Standing::Draining => {
                tokio::time::sleep(Duration::from_millis(500)).await;
                continue;
            }
            Standing::Open => {}
        }
        // Discovery again rather than the record read at adoption: the record is
        // what says whether the host is alive and what it can do.
        let found = port.discover().await.into_iter().find(|c| barrier_key(&c.endpoint) == key);
        let deadline = Instant::now() + ADOPTION_DEADLINE;
        let outcome = match &found {
            Some(candidate) => adopt(port, candidate, HostRole::Frozen, deadline).await,
            None => Err(Failure::EndpointGone("the host is no longer discovered".to_string())),
        };
        match outcome {
            Ok(adopted) => {
                port.barrier().finish(key, &host.endpoint, HostRole::Frozen, adopted.resolution);
                let Some(client) = registered(port, id).map(|h| h.client) else { return FrozenReconnect::Inert };
                let still_current = || port.table().is_current(channel, adopted.epoch) && client.is_alive();
                match list_with_retries(&client).await {
                    Some(sessions) if still_current() => {
                        reattach_listed(port, channel, &client, &tabs, &sessions, &still_current).await;
                    }
                    Some(_) => log::warn!("[GEN] reconnect of {} superseded; aborting pass", host.endpoint),
                    None => log::error!(
                        "[GEN] terminal host {} never answered ListSessions after reconnecting; \
                         leaving {} pane(s) untouched",
                        host.endpoint,
                        tabs.len()
                    ),
                }
                return FrozenReconnect::Reconnected;
            }
            Err(Failure::Superseded) => return FrozenReconnect::Inert,
            Err(Failure::Other(refusal)) if refusal.starts_with(LIFECYCLE_BUSY) => {
                // Not the host's doing: wait for admission, then try this step again.
                if !wait_for_reopen(port.table()).await {
                    return FrozenReconnect::Inert;
                }
            }
            Err(failure) => {
                // Gone for good only if nothing answers AND no live process is
                // advertised behind the endpoint: a host that is merely busy or
                // not listening yet is not dead.
                gone = matches!(failure, Failure::EndpointGone(_)) && found.as_ref().is_none_or(|c| c.pid.is_none());
                log::warn!(
                    "[GEN] reconnect attempt {}/{} to terminal host {} failed ({}); retrying in {}ms",
                    step + 1,
                    backoff_ms.len(),
                    host.endpoint,
                    failure.into_message(),
                    backoff_ms[step]
                );
                tokio::time::sleep(Duration::from_millis(backoff_ms[step])).await;
                step += 1;
            }
        }
    }

    if matches!(standing(port, id), Standing::Gone) {
        return FrozenReconnect::Inert;
    }
    log::error!("[GEN] could not reconnect to terminal host {}; closing {} host pane(s)", host.endpoint, before.len());
    let still_owned = port.panes_on(channel);
    for process_id in before.values().filter(|p| still_owned.values().any(|o| o == *p)) {
        port.teardown_pane(process_id);
    }
    let dropped = gone && drop_dead_host(port, id, key, &host.endpoint);
    FrozenReconnect::GaveUp { dropped }
}

/// Remove a host whose process is gone from everything that counts it as owned.
/// Fail-fast like any retirement: a ticket in flight on the host leaves it for
/// the next sweep to find again.
fn drop_dead_host<P: PanePort>(port: &P, id: FrozenId, key: &str, endpoint: &str) -> bool {
    match port.table().drain_host(HostChannel::Frozen(id)) {
        Ok(drain) => drain.retire(),
        Err(DrainRefusal::NotOpen(Admission::Retired) | DrainRefusal::NoSuchHost) => {}
        Err(refusal) => {
            log::info!("[GEN] terminal host {endpoint} is dead but busy ({refusal:?}); dropping it on a later sweep");
            return false;
        }
    }
    port.forget_host(id);
    port.barrier().forget(key);
    log::warn!("[GEN] terminal host {endpoint} is gone; dropped it");
    true
}

/// How long one sweep waits for the reconnects it started before it goes on to
/// the hosts it can reach. A reconnect of a host that is alive but cannot be
/// connected takes minutes of backoff, and nothing else the sweep does depends on it.
pub(in crate::state) const SWEEP_RECONNECT_WAIT: Duration = Duration::from_secs(10);

/// Reconnect every registered older host whose connection is down: the sweep's
/// answer to a host whose own reconnect gave up, or never started. The hosts are
/// reconnected side by side, each on its own task, and waited for at most
/// [`SWEEP_RECONNECT_WAIT`] altogether; one still going then carries on by itself
/// (a reconnect of a host is single-flight, so the next sweep does not start a
/// second). True when every host was settled in time: back, or found dead and
/// dropped.
pub(in crate::state) async fn reconnect_disconnected<P: PanePort>(port: &P) -> bool {
    let mut running = Vec::new();
    for host in port.frozen_hosts().into_iter().filter(|h| !h.client.is_alive()) {
        let Some(epoch) = port.table().epoch(HostChannel::Frozen(host.id)) else { continue };
        let port = port.clone();
        running.push(tokio::spawn(async move {
            reconnect_frozen(&port, host.id, epoch, RECONNECT_BACKOFF_MS).await
        }));
    }
    match tokio::time::timeout(SWEEP_RECONNECT_WAIT, join_all(running)).await {
        Ok(outcomes) => outcomes.into_iter().all(|outcome| {
            matches!(outcome, Ok(FrozenReconnect::Reconnected | FrozenReconnect::GaveUp { dropped: true }))
        }),
        Err(_) => {
            log::warn!("[GEN] some terminal hosts are still being reconnected; the sweep goes on without them");
            false
        }
    }
}
