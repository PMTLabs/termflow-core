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
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

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

// ---- frozen host registry -------------------------------------------------

pub(super) fn next_frozen_id(frozen_host_seq: &AtomicU32) -> FrozenId {
    FrozenId(frozen_host_seq.fetch_add(1, Ordering::Relaxed))
}

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
}

/// Snapshot of the registered frozen hosts.
pub(super) fn frozen_hosts_snapshot(frozen_hosts: &Mutex<Vec<FrozenHost>>) -> Vec<FrozenHost> {
    frozen_hosts.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

// ---- restore intent -------------------------------------------------------

/// Record that the pane owning `session_key` is being restored and must wait
/// for its host. A key that already has a live registration on some channel is
/// skipped: a renderer reload binds those without a create, so nothing would
/// ever remove the entry. Returns whether the key was recorded.
pub(super) fn register_restoring_key(
    restoring_keys: &DashMap<String, Instant>,
    host_terminals: &DashMap<String, HostChannel>,
    terminals: &DashMap<String, Terminal>,
    session_key: &str,
    now: Instant,
) -> bool {
    if session_registered_on_any_channel(host_terminals, terminals, session_key) {
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

#[cfg(test)]
mod registry_tests;
