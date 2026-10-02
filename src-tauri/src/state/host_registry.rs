//! Ownership bookkeeping over the terminal projection and the shared session
//! authority. Free functions keep the rules testable without a Tauri AppHandle.

use super::types::{session_key_of, FrozenHost, Terminal};
use super::HostKeys;
use crate::elevated_host::{FrozenId, HostChannel};
use crate::pty_host_client::PtyHostClient;
use dashmap::DashMap;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Restore retries refresh this lifetime; marker expiry can only reduce closes.
pub(super) const RESTORE_INTENT_TTL: Duration = Duration::from_secs(15 * 60);

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

/// Resolve an inbound session only on its owning channel and current connection.
/// A duplicate key on another host must not feed or end the registered shell.
pub(super) fn resolve_inbound(
    host_terminals: &DashMap<String, HostChannel>,
    table: &super::host_table::HostTable,
    channel: HostChannel,
    epoch: u64,
    session_key: &str,
) -> Option<String> {
    let current = table.is_current(channel, epoch)
        && table.admission(channel) != Some(super::host_table::Admission::Retired);
    let process = table.routes().resolve(channel, session_key, epoch, current)?;
    if host_terminals.get(&process).is_some_and(|owner| *owner == channel) {
        Some(process)
    } else {
        table.routes().record_drop();
        None
    }
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
    keys: &HostKeys,
    host_terminals: &DashMap<String, HostChannel>,
    terminals: &DashMap<String, Terminal>,
    id: &str,
    bytes: &[u8],
    client_for: &dyn Fn(HostChannel) -> Option<PtyHostClient>,
) -> bool {
    let _ = (host_terminals, terminals);
    let Some(shell) = keys.with_registered(id, Clone::clone) else { return false; };
    let super::ShellStage::Hosted(stage) = &shell.stage else { return false; };
    match client_for(stage.channel) {
        Some(client) => client.write_registered(keys, id, stage.channel, &stage.key, bytes),
        None => false,
    }
}

/// Forward a resize to the host that owns `id`; false as for [`route_write`].
pub(super) fn route_resize(
    keys: &HostKeys,
    host_terminals: &DashMap<String, HostChannel>,
    terminals: &DashMap<String, Terminal>,
    id: &str,
    cols: u16,
    rows: u16,
    client_for: &dyn Fn(HostChannel) -> Option<PtyHostClient>,
) -> bool {
    let _ = (host_terminals, terminals);
    let Some(shell) = keys.with_registered(id, Clone::clone) else { return false; };
    let super::ShellStage::Hosted(stage) = &shell.stage else { return false; };
    match client_for(stage.channel) {
        Some(client) => client.resize_registered(keys, id, stage.channel, &stage.key, cols, rows),
        None => false,
    }
}

/// Nudge the owning host to repaint `id`. True when `id` is host-owned, whether
/// or not the nudge could be sent: there is no local master to jiggle instead.
pub(super) fn route_repaint(
    keys: &HostKeys,
    host_terminals: &DashMap<String, HostChannel>,
    terminals: &DashMap<String, Terminal>,
    id: &str,
    client_for: &dyn Fn(HostChannel) -> Option<PtyHostClient>,
) -> bool {
    let Some((channel, session_key)) = owner_of(host_terminals, terminals, id) else { return false };
    let Some(identity) = keys.session_identity(channel, &session_key, id) else { return true };
    let info = terminals.get(id).map(|t| (t.cols, t.rows));
    if let Some((cols, rows)) = info {
        if let Some(client) = client_for(channel) {
            client.repaint_owned(&identity, cols, rows);
        }
    }
    true
}

/// Ending remains ineligible until a later answered listing proves the effect.
#[cfg(test)]
pub(super) fn route_close(keys: &HostKeys, channel: HostChannel, session_key: &str) {
    keys.close(channel, session_key);
}

// ---- frozen host registry -------------------------------------------------

pub(super) fn next_frozen_id(frozen_host_seq: &AtomicU64) -> Result<FrozenId, String> {
    crate::checked_counter::advance(frozen_host_seq).map(|n| FrozenId(n - 1))
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

/// The name a pane's session has on the host: the key a migrated pane still
/// carries, else its leaf. The one place the two are told apart.
pub fn effective_session_key(leaf_id: &str, session_key: Option<&str>) -> String {
    session_key.unwrap_or(leaf_id).to_string()
}

/// Restore registration consults only the ownership authority.
pub(super) struct IntentMaps<'a> {
    pub keys: &'a HostKeys,
}

/// A persisted pane is about to mount. Live terminals bind without a create,
/// so they do not leave a waiting holder behind on renderer reload.
pub(super) fn register_restoring_leaf(
    maps: &IntentMaps,
    label: &str,
    leaf_id: &str,
    session_key: Option<&str>,
    now: Instant,
) -> bool {
    maps.keys.register_restoring_leaf(label, leaf_id, session_key, now)
}

/// Forget only this window's holder; its alias marker cannot override a holder
/// belonging to another restoring pane.
pub(super) fn forget_restoring_leaf(maps: &IntentMaps, label: &str, leaf_id: &str, now: Instant) {
    maps.keys.forget_restoring_leaf(label, leaf_id, now);
}

// ---- what a host's listing does ---------------------------------------------

/// The maps a host's answered listing is applied to.
pub(super) struct ListingMaps<'a> {
    pub host_terminals: &'a DashMap<String, HostChannel>,
    pub terminals: &'a DashMap<String, Terminal>,
    pub keys: &'a HostKeys,
}

/// Apply answered evidence and the unowned-close policy in the key cell's
/// critical section. Duplicate sessions on another host are reported, not killed.
pub(super) fn apply_answered_listing(
    maps: &ListingMaps,
    channel: HostChannel,
    source: &PtyHostClient,
    listing: &crate::pty_host_client::SessionListing,
    now: Instant,
) -> Vec<String> {
    // `meta.tab_id` is a SESSION key and `host_terminals` is keyed by process
    // id, so the ownership test below must go through this map. Comparing them
    // directly makes every live pane look unowned, which queues it for adoption
    // and lets a concurrent create re-adopt a LIVE session at offset 0 straight
    // into its parser.
    let unregistered = |key: &str| !session_registered_on_any_channel(maps.host_terminals, maps.terminals, key);
    if !source.apply_listing_on(maps.keys, channel, listing, now, unregistered) { return Vec::new(); }
    let owned_sessions = sessions_by_key(maps.host_terminals, maps.terminals, channel);
    let mut duplicates = Vec::new();
    for meta in &listing.sessions {
        let registered = session_registered_on_any_channel(maps.host_terminals, maps.terminals, &meta.tab_id);
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
    }
    duplicates
}

/// What to do with a live session that no pane claims.
#[cfg(test)]
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
#[cfg(test)]
pub(super) fn orphan_verdict(keys: &HostKeys, session_key: &str, now: Instant) -> OrphanVerdict {
    keys.orphan_verdict(session_key, now)
}

/// True for the first caller only: a notice that must be raised once.
pub(super) fn first_report(reported: &AtomicBool) -> bool {
    !reported.swap(true, Ordering::AcqRel)
}

#[cfg(test)]
mod registry_tests;
#[cfg(test)]
mod inbound_tests;
