//! Where a new terminal goes: which host it is created on or attached to, and
//! when it has to wait instead.
//!
//! Two kinds of create. A *fresh* one (a new tab, a split, anything the API, MCP
//! or fleet asks for) mints its own session key, so no old host can be holding
//! it: it goes to the current host at once and never waits for an older one. A
//! *keyed* one (a pane restored from a saved layout, a migrated pane that still
//! carries its old key, or one a host has already listed) names a session that
//! may live on any host, so it waits for the hosts to answer and then attaches
//! where the session is. While a host has not answered, such a pane is never
//! spawned anywhere: the session may be on that host, and a second shell under
//! the same key would orphan it.
//!
//! Everything here runs against [`RoutingPort`], which `AppState` implements, so
//! the routing rules are testable over fake hosts without a Tauri `AppHandle`.

use super::host_adoption::{ensure_hosts, AdoptionPort};
use super::host_registry;
use super::host_table::{Admission, Busy, Ticket, LIFECYCLE_BUSY};
use super::types::AppState;
use super::{IdAllocator, KeyStage, StageMode, parse_session_key, SessionKeyKind};
use crate::elevated_host::HostChannel;
use crate::pty_host_client::PtyHostClient;
use dashmap::DashMap;
use std::time::{Duration, Instant};
use tauri::Runtime;

/// Prefix of the retryable error a keyed create gets while a host that might
/// hold its session has not answered. Renderer callers match on it.
pub const HOST_OWNERSHIP_PENDING: &str = "host-ownership-pending";

/// How long a keyed create waits for the hosts to answer before it reports the
/// session as pending.
const BARRIER_WAIT: Duration = Duration::from_secs(8);
/// Re-plans when the hosts change state between choosing one and taking its
/// admission ticket.
const PLACE_ATTEMPTS: u32 = 3;

/// Where a create was decided to go. The ticket keeps the host admitting the
/// operation until the caller is done with it.
pub enum Placement {
    /// The session already lives on `channel`: take it over there.
    Attach { channel: HostChannel, client: PtyHostClient, pid: u32, ticket: Ticket, session_key: String },
    /// Start a new session on `channel`.
    Spawn { channel: HostChannel, client: PtyHostClient, ticket: Ticket, session_key: String },
    /// No host is usable: run the shell in this process.
    InProcess { reason: String },
}

/// What the router needs from the application beyond adoption.
pub(super) trait RoutingPort: AdoptionPort {
    fn restoring_keys(&self) -> &DashMap<String, Instant>;
    fn closed_unowned(&self) -> &DashMap<String, Instant>;
    fn ids(&self) -> &IdAllocator;
    fn surface_ambiguous(&self, keys: &[String]);

    fn register_route(&self, channel: HostChannel, key: &str, process: &str) -> bool {
        self.table().epoch(channel).is_some_and(|epoch| self.table().keys().restore_route(channel, key, process, epoch))
    }
}

/// Claim the fresh key before publishing a shell. The live collision check is a
/// defensive redraw, not the uniqueness proof: the UUID retains 122 random bits.
fn claim_fresh_owned<P: RoutingPort>(port: &P, leaf: &str, channel: HostChannel, owner: Option<(u64, &str)>) -> Result<KeyStage, String> {
    loop {
        let key = port.ids().mint_session_key(leaf)?;
        if port.table().keys().occupied(channel, &key) { continue; }
        match stage_key(port, leaf, owner, channel, &key, StageMode::Spawn) {
            Ok((stage, _)) => return Ok(stage),
            Err(e) if e.starts_with("host-session-contended:") => continue,
            Err(e) => return Err(e),
        }
    }
}

fn surface_ambiguity<P: RoutingPort>(port: &P, leaf: &str) {
    let own: Vec<_> = port.table().keys().listed().into_iter()
        .filter(|(_, key)| parse_session_key(key) == SessionKeyKind::V2 { owner_leaf: leaf })
        .map(|(_, key)| key).collect();
    if own.len() > 1 {
        port.surface_ambiguous(&own);
    }
}

fn pending(reason: impl std::fmt::Display) -> String {
    format!("{HOST_OWNERSHIP_PENDING}: {reason}")
}

/// The live connection of `channel`. A host whose connection dropped stays
/// registered while it is reconnected, but there is nothing to attach through in
/// the meantime: attaching on the dead client would "succeed", and the reconnect
/// that follows would never attach a session registered after it began.
fn client_of<P: AdoptionPort>(port: &P, channel: HostChannel) -> Option<PtyHostClient> {
    match channel {
        HostChannel::Primary => port.current_client(),
        HostChannel::Frozen(id) => port.frozen_hosts().into_iter().find(|h| h.id == id).map(|h| h.client),
        HostChannel::Elevated => None,
    }
    .filter(PtyHostClient::is_alive)
}

/// The host a fresh session is created on: the current host while it is
/// connected and admitting; failing that, the most recently advertised older
/// host that is; failing that, none (the shell runs in this process). Never a
/// host that is draining or retired. Only meaningful after adoption has tried
/// every host.
pub(super) fn spawn_target<P: AdoptionPort>(port: &P) -> Option<(HostChannel, PtyHostClient)> {
    let admitting = |channel| port.table().admission(channel) == Some(Admission::Open);
    if let Some(client) = port.current_client().filter(|c| c.is_alive()) {
        if admitting(HostChannel::Primary) {
            return Some((HostChannel::Primary, client));
        }
    }
    let mut older: Vec<_> = port
        .frozen_hosts()
        .into_iter()
        .filter(|h| h.client.is_alive() && admitting(HostChannel::Frozen(h.id)))
        .collect();
    // Newest record first; the generation only makes ties deterministic.
    older.sort_by(|a, b| b.advertised.cmp(&a.advertised).then_with(|| a.generation.cmp(&b.generation)));
    let host = older.into_iter().next()?;
    log::warn!(
        "[GEN] the current terminal host is not usable; new terminals go to the older host on {}",
        host.endpoint
    );
    Some((HostChannel::Frozen(host.id), host.client))
}

fn unresolved_hosts<P: AdoptionPort>(port: &P) -> Option<String> {
    let unresolved = port.barrier().unresolved();
    if unresolved.is_empty() {
        return None;
    }
    Some(
        unresolved
            .iter()
            .map(|u| format!("{} ({})", u.endpoint, u.reason))
            .collect::<Vec<_>>()
            .join(", "),
    )
}

/// Decide where the create for `leaf` goes and take its admission.
///
/// `override_key` is an exact persisted or recovered key, not a key to spawn.
/// Listed own-leaf keys take precedence over it. Errors are for the caller to return
/// as they are: `LIFECYCLE_BUSY` while the app is exiting or updating (the create
/// must not fall back in-process), `host-ownership-pending:` for a keyed create
/// whose session may be on a host that has not answered, or the contention error
/// of a session another create already holds.
pub(super) async fn place_owned<P: RoutingPort>(port: &P, leaf: &str, override_key: Option<&str>, owner: Option<(u64, &str)>) -> Result<Placement, String> {
    let session_key = override_key.unwrap_or(leaf);
    // Exit, offload and update commit close admission to every host. Say so up
    // front: once exit has begun closing the hosts none of them is a usable target
    // any more, and the create would be run in this process instead of refused.
    if let Some(reason) = port.table().lifecycle_reason() {
        log::info!("[GEN] create {session_key} refused during {reason:?}");
        return Err(Busy::Lifecycle(reason).to_string());
    }
    log::debug!("[GEN] placing terminal {leaf} (override={override_key:?})");
    let keyed = override_key.is_some()
        || host_registry::is_restoring_key(port.restoring_keys(), session_key, Instant::now())
        || port.table().keys().candidate(leaf, override_key).is_some();
    if keyed {
        host_registry::refresh_restoring_key(port.restoring_keys(), session_key, Instant::now());
    }

    if let Err(e) = ensure_hosts(port).await {
        if e.starts_with(LIFECYCLE_BUSY) {
            return Err(e);
        }
        if !keyed {
            return Ok(Placement::InProcess { reason: e });
        }
        // A keyed create may still find its session on a host that was reached;
        // whether it may be spawned is the barrier's call below.
        log::warn!("[GEN] {session_key}: {e}");
    }
    if keyed && port.barrier().wait_resolved(BARRIER_WAIT).await.is_err() {
        log::info!("[GEN] {session_key} is still waiting for a terminal host to answer");
    }

    let mut refused = None;
    for _ in 0..PLACE_ATTEMPTS {
        let selected = port.table().keys().candidate(leaf, override_key);
        let held_by = selected.as_ref().map(|(channel, _)| *channel);
        let (channel, client) = match held_by {
            Some(channel) => match client_of(port, channel) {
                Some(client) => (channel, client),
                None => return Err(pending(format!("the terminal host holding {session_key} is not connected"))),
            },
            None => {
                if keyed {
                    if let Some(hosts) = unresolved_hosts(port) {
                        return Err(pending(format!("waiting for terminal host {hosts}")));
                    }
                }
                match spawn_target(port) {
                    Some(target) => target,
                    None => {
                        let reason = refused.map_or_else(|| "no terminal host is usable".to_string(), |b: Busy| b.to_string());
                        return Ok(Placement::InProcess { reason });
                    }
                }
            }
        };

        let mut ticket = match begin_ticket(port, channel) {
            Ok(ticket) => ticket,
            Err(busy @ Busy::Lifecycle(_)) => return Err(busy.to_string()),
            // The host holding the session cannot be retired while it holds one,
            // so this is transient; the pane retries.
            Err(busy) if held_by.is_some() => return Err(pending(busy)),
            Err(busy) => {
                refused = Some(busy);
                continue;
            }
        };
        let Some(selected) = selected else {
            let stage = claim_fresh_owned(port, leaf, channel, owner)?;
            let key = stage.key.clone();
            ticket.guard_key(stage);
            surface_ambiguity(port, leaf);
            settle(port, session_key);
            log::info!("[GEN] spawning {key} on {channel:?}");
            return Ok(Placement::Spawn { channel, client, ticket, session_key: key });
        };
        let (_, selected) = selected;
        let (stage, pid) = stage_key(port, leaf, owner, channel, &selected, StageMode::Attach)?;
        ticket.guard_key(stage);
        settle(port, session_key);
        log::info!("[GEN] attaching {selected} on {channel:?} (pid {pid})");
        return Ok(Placement::Attach { channel, client, pid, ticket, session_key: selected });
    }
    match refused {
        Some(busy) => Ok(Placement::InProcess { reason: busy.to_string() }),
        None => Err(pending("the terminal hosts changed while placing it")),
    }
}

fn stage_key<P: RoutingPort>(port: &P, leaf: &str, owner: Option<(u64, &str)>, channel: HostChannel, key: &str, mode: StageMode) -> Result<(KeyStage, u32), String> {
    if let Some((cg, process)) = owner {
        let (stage, pid, _) = port.table().keys().stage_shell(leaf, cg, process, Some((channel, key, mode)))?;
        Ok((stage.expect("hosted stage"), pid))
    } else { port.table().keys().stage(channel, key, mode) }
}

/// Take admission once, for either a normal or elevated placement.
fn begin_ticket<P: RoutingPort>(port: &P, channel: HostChannel) -> Result<Ticket, Busy> {
    port.table().begin(channel)
}

/// The create is going ahead: nothing waits for this key any more, and a close
/// recorded for it while its host was unknown is superseded.
fn settle<P: RoutingPort>(port: &P, session_key: &str) {
    host_registry::forget_restoring_key(port.restoring_keys(), session_key, None);
    host_registry::forget_closed_unowned(port.closed_unowned(), session_key, None);
}

impl<R: Runtime> RoutingPort for AppState<R> {
    fn restoring_keys(&self) -> &DashMap<String, Instant> {
        &self.restoring_keys
    }

    fn closed_unowned(&self) -> &DashMap<String, Instant> {
        &self.closed_unowned
    }

    fn ids(&self) -> &IdAllocator {
        &self.ids
    }

    fn surface_ambiguous(&self, keys: &[String]) {
        use super::host_adoption::PanePort;
        for key in keys {
            self.announce_recovered(key);
        }
    }
}

impl<R: Runtime> AppState<R> {
    pub(crate) fn place_elevated_create(&self, leaf: &str, override_key: Option<&str>, client: PtyHostClient, cg: u64, process: &str) -> Result<Placement, String> {
        let channel = HostChannel::Elevated;
        let mut ticket = begin_ticket(self, channel).map_err(|e| e.to_string())?;
        if let Some((owner, key)) = self.host_table.keys().candidate(leaf, override_key) {
            if owner != channel { return Err(pending("session belongs to a different terminal host")); }
            let (stage, pid) = stage_key(self, leaf, Some((cg, process)), channel, &key, StageMode::Attach)?;
            ticket.guard_key(stage);
            return Ok(Placement::Attach { channel, client, pid, ticket, session_key: key });
        }
        let stage = claim_fresh_owned(self, leaf, channel, Some((cg, process)))?;
        let key = stage.key.clone();
        ticket.guard_key(stage);
        surface_ambiguity(self, leaf);
        Ok(Placement::Spawn { channel, client, ticket, session_key: key })
    }

    /// Allocate before key staging, then place under the leaf's admission.
    pub(crate) async fn place_process_create(&self, leaf: &str, override_key: Option<&str>, cg: u64) -> Result<(String, Placement), String> {
        let process = self.ids.mint_process_id()?;
        let placement = place_owned(self, leaf, override_key, Some((cg, &process))).await?;
        Ok((process, placement))
    }
}

#[cfg(test)]
pub(super) async fn place_for_leaf<P: RoutingPort>(port: &P, leaf: &str, override_key: Option<&str>) -> Result<Placement, String> {
    place_owned(port, leaf, override_key, None).await
}

#[cfg(test)]
pub(super) async fn place_process<P: RoutingPort>(port: &P, leaf: &str, override_key: Option<&str>) -> Result<(String, Placement), String> {
    let process = port.ids().mint_process_id()?;
    let placement = place_for_leaf(port, leaf, override_key).await?;
    Ok((process, placement))
}

#[cfg(test)]
pub(super) async fn place<P: RoutingPort>(port: &P, leaf: &str, overridden: bool) -> Result<Placement, String> {
    place_for_leaf(port, leaf, overridden.then_some(leaf)).await
}
