//! Ownership bookkeeping for pty-host sessions, kept as free functions over the
//! `AppState` maps so the rules are unit-testable without a Tauri `AppHandle`
//! (the `integration-tests` feature that builds one breaks the Windows test
//! binary). `AppState` methods in `terminals.rs` are thin wrappers; the
//! parameter names deliberately equal the field names so the source census in
//! `terminals.rs` can see every removal.

use super::terminals::HOST_SESSION_CONTENDED;
use super::types::{
    session_key_of, FrozenHost, HostSessionClaim, HostSessionClaimState, Terminal,
};
use crate::elevated_host::{FrozenId, HostChannel};
use crate::pty_host_client::PtyHostClient;
use dashmap::DashMap;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use termflow_pty_protocol::SessionMeta;

/// How long a restore intent or an unowned close is remembered. Restore intent
/// is refreshed by every keyed create, so this only reaps leaves nobody retries.
pub(super) const RESTORE_INTENT_TTL: Duration = Duration::from_secs(15 * 60);

fn intent_expired(stamped: Instant, now: Instant) -> bool {
    now.saturating_duration_since(stamped) >= RESTORE_INTENT_TTL
}

// ---- claims ---------------------------------------------------------------

/// Reserve a listed session for the renderer which already knows it, on the
/// host whose listing reported it. An entry operation so recovery cannot slip a
/// second owner between the observation and the reservation.
pub(super) fn reserve_session(
    host_session_claims: &DashMap<String, HostSessionClaim>,
    session_key: &str,
    pid: u32,
    channel: HostChannel,
) {
    host_session_claims
        .entry(session_key.to_string())
        .or_insert(HostSessionClaim {
            state: HostSessionClaimState::Reserved,
            pid,
            process_id: None,
            channel,
        });
}

/// Claim a session for backend registration. A recovery create consumes the
/// Reserved entry established from a host's authoritative listing and gets back
/// the pid AND the host that listing came from. A vacant key is a fresh spawn:
/// the claim records `fresh_channel`, where that spawn is headed.
pub(super) fn claim_registration(
    host_session_claims: &DashMap<String, HostSessionClaim>,
    session_key: &str,
    fresh_channel: HostChannel,
) -> Result<Option<(u32, HostChannel)>, String> {
    use dashmap::mapref::entry::Entry;
    match host_session_claims.entry(session_key.to_string()) {
        Entry::Vacant(v) => {
            v.insert(HostSessionClaim {
                state: HostSessionClaimState::RegistrationInProgress,
                pid: 0,
                process_id: None,
                channel: fresh_channel,
            });
            Ok(None)
        }
        Entry::Occupied(mut o) => match o.get().state {
            HostSessionClaimState::Reserved => {
                let (pid, channel) = (o.get().pid, o.get().channel);
                o.get_mut().state = HostSessionClaimState::RegistrationInProgress;
                Ok(Some((pid, channel)))
            }
            HostSessionClaimState::Registered => Err(format!(
                "{HOST_SESSION_CONTENDED}: host session {session_key} is already registered"
            )),
            _ => Err(format!(
                "{HOST_SESSION_CONTENDED}: host session {session_key} is claimed by another recovery"
            )),
        },
    }
}

/// Undo a claim transition whose operation never got as far as `Registered`: a
/// taken-over Reserved claim is put back (`restore`) so a retry can claim it
/// again, a fresh claim is removed. A claim that did reach `Registered` (or
/// belongs to someone else by now) is left alone.
pub(super) fn release_unfinished_claim(
    host_session_claims: &DashMap<String, HostSessionClaim>,
    session_key: &str,
    restore: Option<HostSessionClaim>,
) {
    use dashmap::mapref::entry::Entry;
    if let Entry::Occupied(mut o) = host_session_claims.entry(session_key.to_string()) {
        if o.get().state == HostSessionClaimState::RegistrationInProgress {
            match restore {
                Some(reserved) => {
                    o.insert(reserved);
                }
                None => {
                    o.remove();
                }
            }
        }
    }
}

/// The host that listed `session_key` and is waiting for a pane to take it over,
/// when no pane has done so yet.
pub(super) fn reserved_channel(
    host_session_claims: &DashMap<String, HostSessionClaim>,
    session_key: &str,
) -> Option<HostChannel> {
    host_session_claims
        .get(session_key)
        .filter(|claim| claim.state == HostSessionClaimState::Reserved)
        .map(|claim| claim.channel)
}

// ---- session-key maps -----------------------------------------------------

/// Every terminal owned by `channel`, as `session_key -> process_id`. Other
/// channels' terminals are excluded: a host's listing is compared only against
/// what that host owns, or one host's answer would tear down (or adopt) another
/// host's panes.
pub(super) fn sessions_by_key(
    host_terminals: &DashMap<String, HostChannel>,
    terminals: &DashMap<String, Terminal>,
    channel: HostChannel,
) -> HashMap<String, String> {
    host_terminals
        .iter()
        .filter(|e| *e.value() == channel)
        .filter_map(|e| {
            let process_id = e.key().clone();
            terminals
                .get(&process_id)
                .map(|t| (session_key_of(&t), process_id))
        })
        .collect()
}

/// Whether any channel — primary, elevated or any frozen host — has a live
/// registration for `session_key`. The guard for decisions that must hold
/// whichever host happened to report the key.
pub(super) fn session_registered_on_any_channel(
    host_terminals: &DashMap<String, HostChannel>,
    terminals: &DashMap<String, Terminal>,
    session_key: &str,
) -> bool {
    host_terminals.iter().any(|e| {
        terminals
            .get(e.key())
            .is_some_and(|t| session_key_of(&t) == session_key)
    })
}

// ---- pending closes -------------------------------------------------------

/// Consume the tombstone for `session_key` if it is owed to `channel`. A host
/// reporting a key whose close is owed to a different host leaves it alone.
pub(super) fn take_pending_close(
    host_close_pending: &DashMap<String, HostChannel>,
    session_key: &str,
    channel: HostChannel,
) -> bool {
    host_close_pending
        .remove_if(session_key, |_, owed_to| *owed_to == channel)
        .is_some()
}

/// Drop the tombstones owed to `channel` — an answered listing from that host
/// no longer has them. Tombstones owed to other hosts are untouched: only their
/// own host's answer can say they are moot.
pub(super) fn prune_pending_closes(
    host_close_pending: &DashMap<String, HostChannel>,
    channel: HostChannel,
) {
    host_close_pending.retain(|_, owed_to| *owed_to != channel);
}

/// Drop the claims a host listed but no pane has taken over. For a host that is
/// gone for good: its sessions went with it, and a restoring pane must not wait
/// for a session on a host nobody can reach.
pub(super) fn forget_reserved_claims_on(
    host_session_claims: &DashMap<String, HostSessionClaim>,
    channel: HostChannel,
) {
    host_session_claims
        .retain(|_, claim| !(claim.state == HostSessionClaimState::Reserved && claim.channel == channel));
}

// ---- live operations on a terminal ------------------------------------------

/// Where `id` lives: the host that owns it and the name that host knows it by.
fn owner_of(
    host_terminals: &DashMap<String, HostChannel>,
    terminals: &DashMap<String, Terminal>,
    id: &str,
) -> Option<(HostChannel, String)> {
    let channel = *host_terminals.get(id)?.value();
    let session_key = terminals.get(id).map(|t| session_key_of(&t))?;
    Some((channel, session_key))
}

/// Forward keystrokes to the host that owns `id`. False when `id` is not
/// host-owned or that host has no connection: the caller must surface the
/// failure rather than report input that went nowhere as delivered, and must
/// never hand it to another host.
pub(super) fn route_write(
    host_terminals: &DashMap<String, HostChannel>,
    terminals: &DashMap<String, Terminal>,
    id: &str,
    bytes: &[u8],
    client_for: &dyn Fn(HostChannel) -> Option<PtyHostClient>,
) -> bool {
    let Some((channel, session_key)) = owner_of(host_terminals, terminals, id) else { return false };
    match client_for(channel) {
        Some(client) => {
            client.write_stdin(&session_key, bytes);
            true
        }
        None => false,
    }
}

/// Forward a resize to the host that owns `id`; false as for [`route_write`].
pub(super) fn route_resize(
    host_terminals: &DashMap<String, HostChannel>,
    terminals: &DashMap<String, Terminal>,
    id: &str,
    cols: u16,
    rows: u16,
    client_for: &dyn Fn(HostChannel) -> Option<PtyHostClient>,
) -> bool {
    let Some((channel, session_key)) = owner_of(host_terminals, terminals, id) else { return false };
    match client_for(channel) {
        Some(client) => {
            client.resize(&session_key, cols, rows);
            true
        }
        None => false,
    }
}

/// Nudge the owning host to repaint `id`. True when `id` is host-owned, whether
/// or not the nudge could be sent: there is no local master to jiggle instead.
pub(super) fn route_repaint(
    host_terminals: &DashMap<String, HostChannel>,
    terminals: &DashMap<String, Terminal>,
    id: &str,
    client_for: &dyn Fn(HostChannel) -> Option<PtyHostClient>,
) -> bool {
    let Some(channel) = host_terminals.get(id).map(|e| *e.value()) else { return false };
    // The size and the name come from one record, so they stay consistent even
    // for a migrated terminal, where the session key is not the leaf.
    let info = terminals.get(id).map(|t| (t.cols, t.rows, t.session_key.clone()));
    if let Some((cols, rows, session_key)) = info {
        if let Some(client) = client_for(channel) {
            client.nudge_repaint(&session_key, cols, rows);
        }
    }
    true
}

/// Tell the host that owns a closed session to close it, or owe it that close.
/// A host with no live connection (a pipe that dropped, a reconnect in flight)
/// is told on its next answered listing, and only by that host: the tombstone
/// carries its channel. The elevated host is never reconnected, so a close that
/// cannot reach it is simply dropped.
pub(super) fn route_close(
    host_close_pending: &DashMap<String, HostChannel>,
    channel: HostChannel,
    session_key: &str,
    client: Option<PtyHostClient>,
) {
    match client {
        Some(client) if client.is_alive() => client.close(session_key),
        _ if channel != HostChannel::Elevated => {
            host_close_pending.insert(session_key.to_string(), channel);
        }
        _ => {}
    }
}

// ---- frozen host registry -------------------------------------------------

pub(super) fn next_frozen_id(frozen_host_seq: &AtomicU32) -> FrozenId {
    FrozenId(frozen_host_seq.fetch_add(1, Ordering::Relaxed))
}

/// The connected client of a registered frozen host. A host whose connection
/// dropped stays registered while it is reconnected, but has no client to act
/// on in the meantime: it answers like a disconnected primary, never with a dead
/// client that would swallow a keystroke and report success.
pub(super) fn frozen_client(
    frozen_hosts: &Mutex<Vec<FrozenHost>>,
    id: FrozenId,
) -> Option<PtyHostClient> {
    frozen_hosts
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .find(|h| h.id == id)
        .map(|h| h.client.clone())
        .filter(PtyHostClient::is_alive)
}

/// Snapshot of the registered frozen hosts.
pub(super) fn frozen_hosts_snapshot(frozen_hosts: &Mutex<Vec<FrozenHost>>) -> Vec<FrozenHost> {
    frozen_hosts.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

// ---- restore intent -------------------------------------------------------

/// Record that the pane owning `session_key` is being restored and must wait
/// for its host. A key that already has a live terminal is skipped, whichever
/// host or this process runs it: a renderer reload binds those without a create,
/// so nothing would ever remove the entry. Returns whether the key was recorded.
pub(super) fn register_restoring_key(
    restoring_keys: &DashMap<String, Instant>,
    terminals: &DashMap<String, Terminal>,
    session_key: &str,
    now: Instant,
) -> bool {
    if terminals.iter().any(|t| session_key_of(&t) == session_key) {
        return false;
    }
    restoring_keys.insert(session_key.to_string(), now);
    true
}

/// Extend an existing intent's life (every keyed create calls this). Never
/// creates one.
pub(super) fn refresh_restoring_key(
    restoring_keys: &DashMap<String, Instant>,
    session_key: &str,
    now: Instant,
) {
    if let Some(mut stamped) = restoring_keys.get_mut(session_key) {
        *stamped = now;
    }
}

pub(super) fn is_restoring_key(
    restoring_keys: &DashMap<String, Instant>,
    session_key: &str,
    now: Instant,
) -> bool {
    restoring_keys
        .get(session_key)
        .is_some_and(|stamped| !intent_expired(*stamped, now))
}

/// The SINGLE place `restoring_keys` entries are removed. `expired_at: None`
/// removes unconditionally; `Some(now)` removes only an entry still expired at
/// that moment, so a reap cannot discard an intent a create just refreshed.
pub(super) fn forget_restoring_key(
    restoring_keys: &DashMap<String, Instant>,
    session_key: &str,
    expired_at: Option<Instant>,
) -> bool {
    match expired_at {
        None => restoring_keys.remove(session_key).is_some(),
        Some(now) => restoring_keys
            .remove_if(session_key, |_, stamped| intent_expired(*stamped, now))
            .is_some(),
    }
}

pub(super) fn reap_expired_restoring_keys(restoring_keys: &DashMap<String, Instant>, now: Instant) {
    let expired: Vec<String> = restoring_keys
        .iter()
        .filter(|e| intent_expired(*e.value(), now))
        .map(|e| e.key().clone())
        .collect();
    for key in expired {
        forget_restoring_key(restoring_keys, &key, Some(now));
    }
}

// ---- closes while the owning host was unknown ----------------------------

/// The user closed a restored pane that never found its session: stop waiting
/// for it and remember to close the session if any host ever reports it.
pub(super) fn mark_closed_unowned(
    restoring_keys: &DashMap<String, Instant>,
    closed_unowned: &DashMap<String, Instant>,
    session_key: &str,
    now: Instant,
) {
    forget_restoring_key(restoring_keys, session_key, None);
    closed_unowned.insert(session_key.to_string(), now);
}

/// Should a session with this key, just reported by ANY host's answered
/// listing, be closed instead of adopted or surfaced? Only when the user closed
/// its pane while the owner was unknown AND nothing is registered for the key
/// on any channel — a new session reusing the key (a saved layout reloaded
/// after the close) must never be closed. Deliberately takes no host: it does
/// not matter which host reports it. Does not consume the entry; a fresh keyed
/// spawn or attach does, through `forget_closed_unowned`.
pub(super) fn unowned_close_due(
    closed_unowned: &DashMap<String, Instant>,
    registered_on_any_channel: bool,
    session_key: &str,
    now: Instant,
) -> bool {
    !registered_on_any_channel
        && closed_unowned
            .get(session_key)
            .is_some_and(|stamped| !intent_expired(*stamped, now))
}

/// The SINGLE place `closed_unowned` entries are removed; `expired_at` has the
/// same meaning as in `forget_restoring_key`.
pub(super) fn forget_closed_unowned(
    closed_unowned: &DashMap<String, Instant>,
    session_key: &str,
    expired_at: Option<Instant>,
) -> bool {
    match expired_at {
        None => closed_unowned.remove(session_key).is_some(),
        Some(now) => closed_unowned
            .remove_if(session_key, |_, stamped| intent_expired(*stamped, now))
            .is_some(),
    }
}

pub(super) fn reap_expired_closed_unowned(closed_unowned: &DashMap<String, Instant>, now: Instant) {
    let expired: Vec<String> = closed_unowned
        .iter()
        .filter(|e| intent_expired(*e.value(), now))
        .map(|e| e.key().clone())
        .collect();
    for key in expired {
        forget_closed_unowned(closed_unowned, &key, Some(now));
    }
}

// ---- restore intent by pane ------------------------------------------------

/// The name a pane's session has on the host: the key a migrated pane still
/// carries, else its leaf. The one place the two are told apart.
pub fn effective_session_key(leaf_id: &str, session_key: Option<&str>) -> String {
    session_key.unwrap_or(leaf_id).to_string()
}

/// The maps restore intent lives in.
pub(super) struct IntentMaps<'a> {
    pub restoring_keys: &'a DashMap<String, Instant>,
    pub restoring_leaf_keys: &'a DashMap<String, String>,
    pub closed_unowned: &'a DashMap<String, Instant>,
    pub terminals: &'a DashMap<String, Terminal>,
}

/// A persisted pane is about to mount: from now on a create for its session key
/// is a restore and waits for the hosts. Returns whether intent was recorded (a
/// key that is already live is not).
pub(super) fn register_restoring_leaf(
    maps: &IntentMaps,
    leaf_id: &str,
    session_key: Option<&str>,
    now: Instant,
) -> bool {
    let key = effective_session_key(leaf_id, session_key);
    if !register_restoring_key(maps.restoring_keys, maps.terminals, &key, now) {
        return false;
    }
    // The pane is being restored again, so an earlier close of it no longer
    // stands: the session it waits for is wanted.
    forget_closed_unowned(maps.closed_unowned, &key, None);
    if key != leaf_id {
        maps.restoring_leaf_keys.insert(leaf_id.to_string(), key);
    }
    true
}

/// The user closed a pane that never found its session. The renderer names the
/// pane by leaf; the key it was waiting under may be a migrated one.
pub(super) fn forget_restoring_leaf(maps: &IntentMaps, leaf_id: &str, now: Instant) {
    let key = maps
        .restoring_leaf_keys
        .remove(leaf_id)
        .map(|(_, key)| key)
        .unwrap_or_else(|| leaf_id.to_string());
    mark_closed_unowned(maps.restoring_keys, maps.closed_unowned, &key, now);
}

/// Forget which leaves waited under a key that is no longer waited for.
pub(super) fn prune_restoring_leaf_keys(
    restoring_leaf_keys: &DashMap<String, String>,
    restoring_keys: &DashMap<String, Instant>,
) {
    restoring_leaf_keys.retain(|_, key| restoring_keys.contains_key(key));
}

// ---- what a host's listing does ---------------------------------------------

/// The maps a host's answered listing is applied to.
pub(super) struct ListingMaps<'a> {
    pub host_terminals: &'a DashMap<String, HostChannel>,
    pub terminals: &'a DashMap<String, Terminal>,
    pub host_session_claims: &'a DashMap<String, HostSessionClaim>,
    pub host_close_pending: &'a DashMap<String, HostChannel>,
    pub closed_unowned: &'a DashMap<String, Instant>,
}

/// Settle the sessions `channel`'s host reported: deliver a close that was owed
/// to it, close a session whose pane was closed before its host was known, and
/// reserve the rest for the pane that will claim them. Returns the keys the host
/// reported that are already registered on a different host: two hosts holding
/// one session must be reported, but nothing is killed for it.
pub(super) fn apply_answered_listing(
    maps: &ListingMaps,
    channel: HostChannel,
    client: &PtyHostClient,
    surviving: &[SessionMeta],
    now: Instant,
) -> Vec<String> {
    // `meta.tab_id` is a SESSION key and `host_terminals` is keyed by process
    // id, so the ownership test below must go through this map. Comparing them
    // directly makes every live pane look unowned, which queues it for adoption
    // and lets a concurrent create re-adopt a LIVE session at offset 0 straight
    // into its parser.
    let owned_sessions = sessions_by_key(maps.host_terminals, maps.terminals, channel);
    let mut duplicates = Vec::new();
    for meta in surviving {
        // A close that couldn't reach the host while the pipe was down: deliver
        // it now instead of re-adopting the session.
        if take_pending_close(maps.host_close_pending, &meta.tab_id, channel) {
            log::info!(
                "[HOTSWAP] delivering deferred close for {} (closed while disconnected)",
                meta.tab_id
            );
            client.close(&meta.tab_id);
            continue;
        }
        let registered = session_registered_on_any_channel(maps.host_terminals, maps.terminals, &meta.tab_id);
        if unowned_close_due(maps.closed_unowned, registered, &meta.tab_id, now) {
            log::info!(
                "[HOTSWAP] closing {}: its pane was closed before its host was known",
                meta.tab_id
            );
            client.close(&meta.tab_id);
            continue;
        }
        // Only sessions the GUI does NOT already own belong in the adoption
        // queue. During an in-place pipe-drop recovery the live tabs are still
        // registered; queueing them would let a concurrent create re-adopt one
        // at offset 0 straight into its live parser.
        if !meta.alive || owned_sessions.contains_key(&meta.tab_id) {
            continue;
        }
        if registered {
            log::error!(
                "[HOTSWAP] host {channel:?} reports {} which is already registered on another host; \
                 leaving both alone",
                meta.tab_id
            );
            duplicates.push(meta.tab_id.clone());
            continue;
        }
        reserve_session(maps.host_session_claims, &meta.tab_id, meta.pid, channel);
    }
    duplicates
}

/// What to do with a live session that no pane claims.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum OrphanVerdict {
    /// Offer it to the user as a recovered terminal.
    Surface,
    /// A restored pane is still waiting for it; surfacing it would put a second
    /// owner on its session.
    Restoring,
    /// Its pane was closed before its host was known.
    CloseUnowned,
}

/// Decide for a live session with no registration on any channel.
pub(super) fn orphan_verdict(
    restoring_keys: &DashMap<String, Instant>,
    closed_unowned: &DashMap<String, Instant>,
    session_key: &str,
    now: Instant,
) -> OrphanVerdict {
    if unowned_close_due(closed_unowned, false, session_key, now) {
        OrphanVerdict::CloseUnowned
    } else if is_restoring_key(restoring_keys, session_key, now) {
        OrphanVerdict::Restoring
    } else {
        OrphanVerdict::Surface
    }
}

/// True for the first caller only: a notice that must be raised once.
pub(super) fn first_report(reported: &AtomicBool) -> bool {
    !reported.swap(true, Ordering::AcqRel)
}

#[cfg(test)]
mod registry_tests;
