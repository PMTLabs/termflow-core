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
use super::types::{AppState, HostSessionClaim};
use crate::elevated_host::HostChannel;
use crate::pty_host_client::PtyHostClient;
use dashmap::DashMap;
use std::sync::Arc;
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
    Attach { channel: HostChannel, client: PtyHostClient, pid: u32, ticket: Ticket },
    /// Start a new session on `channel`.
    Spawn { channel: HostChannel, client: PtyHostClient, ticket: Ticket },
    /// No host is usable: run the shell in this process.
    InProcess { reason: String },
}

/// What the router needs from the application beyond adoption.
pub(super) trait RoutingPort: AdoptionPort {
    fn claims(&self) -> &Arc<DashMap<String, HostSessionClaim>>;
    fn restoring_keys(&self) -> &DashMap<String, Instant>;
    fn closed_unowned(&self) -> &DashMap<String, Instant>;
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

/// Decide where the create for `session_key` goes and take its admission.
///
/// `override_key` says the caller supplied the session key (a migrated pane)
/// rather than letting it follow the leaf. Errors are for the caller to return
/// as they are: `LIFECYCLE_BUSY` while the app is exiting or updating (the create
/// must not fall back in-process), `host-ownership-pending:` for a keyed create
/// whose session may be on a host that has not answered, or the contention error
/// of a session another create already holds.
pub(super) async fn place<P: RoutingPort>(
    port: &P,
    session_key: &str,
    override_key: bool,
) -> Result<Placement, String> {
    // Exit, offload and update commit close admission to every host. Say so up
    // front: once exit has begun closing the hosts none of them is a usable target
    // any more, and the create would be run in this process instead of refused.
    if let Some(reason) = port.table().lifecycle_reason() {
        log::info!("[GEN] create {session_key} refused during {reason:?}");
        return Err(Busy::Lifecycle(reason).to_string());
    }
    log::debug!("[GEN] placing terminal {session_key} (override={override_key})");
    let keyed = override_key
        || host_registry::is_restoring_key(port.restoring_keys(), session_key, Instant::now())
        || host_registry::reserved_channel(port.claims(), session_key).is_some();
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
        let held_by = host_registry::reserved_channel(port.claims(), session_key);
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

        let mut ticket = match port.table().begin(channel) {
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
        let claimed = host_registry::claim_registration(port.claims(), session_key, channel)?;
        ticket.guard_claim(port.claims(), session_key, claimed);
        match claimed {
            Some((pid, from)) if from == channel => {
                settle(port, session_key);
                log::info!("[GEN] attaching {session_key} on {channel:?} (pid {pid})");
                return Ok(Placement::Attach { channel, client, pid, ticket });
            }
            // The claim moved to another host, or vanished, between looking and
            // taking it. Dropping the ticket puts it back; plan again.
            Some(_) => continue,
            None if held_by.is_some() => continue,
            None => {
                settle(port, session_key);
                log::info!("[GEN] spawning {session_key} on {channel:?}");
                return Ok(Placement::Spawn { channel, client, ticket });
            }
        }
    }
    match refused {
        Some(busy) => Ok(Placement::InProcess { reason: busy.to_string() }),
        None => Err(pending("the terminal hosts changed while placing it")),
    }
}

/// The create is going ahead: nothing waits for this key any more, and a close
/// recorded for it while its host was unknown is superseded.
fn settle<P: RoutingPort>(port: &P, session_key: &str) {
    host_registry::forget_restoring_key(port.restoring_keys(), session_key, None);
    host_registry::forget_closed_unowned(port.closed_unowned(), session_key, None);
}

impl<R: Runtime> RoutingPort for AppState<R> {
    fn claims(&self) -> &Arc<DashMap<String, HostSessionClaim>> {
        &self.host_session_claims
    }

    fn restoring_keys(&self) -> &DashMap<String, Instant> {
        &self.restoring_keys
    }

    fn closed_unowned(&self) -> &DashMap<String, Instant> {
        &self.closed_unowned
    }
}

impl<R: Runtime> AppState<R> {
    /// Decide where the create for `session_key` goes; see [`place`].
    pub async fn place_create(&self, session_key: &str, override_key: bool) -> Result<Placement, String> {
        place(self, session_key, override_key).await
    }
}
