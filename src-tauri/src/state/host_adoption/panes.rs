//! What one host's answered listing means for the panes.
//!
//! Shared by every flow that lists a host after the fact (the primary's recovery
//! from a dropped pipe, an older host's reconnect, the periodic sweep), so each
//! decides per host: a host's listing is compared only with the panes that host
//! owns, never with another host's.

use super::{AdoptionPort, PtyHostClient};
use crate::elevated_host::HostChannel;
use crate::state::host_registry::{self, OrphanVerdict};
use crate::state::host_routing::RoutingPort;
use crate::state::terminals::{plan_reconnect, session_needs_surface};
use std::collections::HashMap;
use termflow_pty_protocol::SessionMeta;

/// What reconciling a listing needs from the application beyond adoption: the
/// panes, and the things done to them.
pub(in crate::state) trait PanePort: RoutingPort {
    /// The panes `channel` owns, as session key -> process id.
    fn panes_on(&self, channel: HostChannel) -> HashMap<String, String>;
    /// Whether any channel holds a live registration for this session key.
    fn registered_on_any_channel(&self, session_key: &str) -> bool;
    /// Whether this process id still belongs to some host.
    fn pane_is_host_owned(&self, process_id: &str) -> bool;
    /// Where each session's output was consumed to, by session key.
    fn saved_offsets(&self) -> HashMap<String, u64>;
    fn pane_size(&self, process_id: &str) -> (u16, u16);
    /// A pane whose session its host no longer has: end it.
    fn teardown_pane(&self, process_id: &str);
    /// Offer a live session no pane claims to the user as a recovered terminal.
    fn announce_recovered(&self, session_key: &str);
    /// A host that is gone for good: forget it, the closes owed to it and the
    /// sessions it was reserved for.
    fn forget_host(&self, id: crate::elevated_host::FrozenId);
}

/// The connected client of `channel`, if it has one.
pub(super) fn live_client<P: AdoptionPort>(port: &P, channel: HostChannel) -> Option<PtyHostClient> {
    match channel {
        HostChannel::Primary => port.current_client(),
        HostChannel::Frozen(id) => port
            .frozen_hosts()
            .into_iter()
            .find(|h| h.id == id)
            .map(|h| h.client)
            .filter(PtyHostClient::is_alive),
        HostChannel::Elevated => None,
    }
}

/// The sole path by which live host sessions that no known pane claims reach the
/// user. `channel` is the host whose listing reported `orphans`.
pub(in crate::state) fn surface_orphans<P: PanePort>(port: &P, orphans: Vec<SessionMeta>, channel: HostChannel) {
    for orphan in orphans {
        // A terminal can be created between a listing and this UI pass.
        // The current ownership map, rather than a restore snapshot, is
        // authoritative at the point recovery would become visible — and it
        // must see EVERY channel: the registration that raced the listing
        // may have landed on a different host than the one that listed it.
        if !session_needs_surface(port.registered_on_any_channel(&orphan.tab_id)) {
            continue;
        }
        if !port.table().keys().eligible(channel, &orphan.tab_id) { continue; }
        // Not registered yet does not mean unwanted. A pane restored from a
        // saved layout may still be waiting for this very session (its create
        // is retrying while a host answers), and turning the session into a
        // recovered tab would put a second owner on it. A session whose pane
        // the user closed while waiting is closed rather than shown.
        match host_registry::orphan_verdict(
            port.table().keys(),
            &orphan.tab_id,
            std::time::Instant::now(),
        ) {
            OrphanVerdict::Surface => {}
            OrphanVerdict::Restoring => {
                log::info!("[HOTSWAP] {} is held for a restored pane that is still waiting; not surfacing it", orphan.tab_id);
                continue;
            }
            OrphanVerdict::CloseUnowned => {
                log::info!("[HOTSWAP] closing {}: its pane was closed before its host was known", orphan.tab_id);
                port.table().keys().close_listed(channel, &orphan.tab_id, || {
                    !port.registered_on_any_channel(&orphan.tab_id)
                });
                continue;
            }
        }
        // The answered listing already recorded this exact key and PID.
        port.announce_recovered(&orphan.tab_id);
    }
}

/// Reconcile `channel`'s answered `sessions` with the panes it held.
///
/// `tabs` is the session keys of the panes it owned BEFORE the listing was
/// requested, and is the sole destructive authority: a terminal registered after
/// the host built its answer is absent from `sessions`, but that is not evidence
/// it has died. Fresh ownership is useful only to suppress orphan recovery.
/// `still_current` says whether this pass still owns the connection; once it does
/// not, a newer recovery does, and this one stops before any attach or teardown.
pub(super) async fn reattach_listed<P: PanePort>(
    port: &P,
    channel: HostChannel,
    client: &PtyHostClient,
    tabs: &[String],
    sessions: &[SessionMeta],
    still_current: &(dyn Fn() -> bool + Sync),
) {
    let by_session = port.panes_on(channel);
    let plan = plan_reconnect(tabs, sessions, &port.saved_offsets(), by_session.keys().cloned());
    log::info!(
        "[HOTSWAP] in-place reconnect: {} session(s) to reattach, {} lost, {} orphan(s) to recover",
        plan.reattach.len(),
        plan.teardown.len(),
        plan.orphans.len()
    );
    surface_orphans(port, plan.orphans, channel);
    for a in plan.reattach {
        if !still_current() {
            log::warn!("[HOTSWAP] recovery superseded mid-reattach; aborting pass");
            return;
        }
        // The pane may have been closed while the pipe was down (host_close
        // couldn't deliver Close then). Finish the close now instead of
        // reattaching a session nobody owns — else it lingers as a zombie.
        // `a.tab_id` is a SESSION key; ownership lives under the process id.
        let Some(process_id) = by_session.get(&a.tab_id).cloned().filter(|p| port.pane_is_host_owned(p)) else {
            log::info!("[HOTSWAP] {} was closed while disconnected; closing its host session", a.tab_id);
            host_registry::route_close(port.table().keys(), channel, &a.tab_id);
            continue;
        };
        if !port.register_route(channel, &a.tab_id, &process_id) { continue; }
        match client.attach_confirmed(&a.tab_id, a.from_offset).await {
            Some(true) => log::info!(
                "[HOTSWAP] reattached {} in place from offset {} (host-confirmed alive)",
                a.tab_id,
                a.from_offset
            ),
            Some(false) => log::warn!("[HOTSWAP] reattached {} but host reports it not alive", a.tab_id),
            None => log::info!(
                "[HOTSWAP] reattached {} in place from offset {} (legacy attach)",
                a.tab_id,
                a.from_offset
            ),
        }
        // Dimensions live under the PROCESS id; the nudge goes to the host,
        // so it stays addressed by the session key.
        let (cols, rows) = port.pane_size(&process_id);
        client.nudge_repaint(&a.tab_id, cols, rows);
        // The registered terminal remains the exclusive owner across an
        // in-place reconnect; deleting this claim would let a late create
        // register a second identity for the same live host session.
    }
    for t in plan.teardown {
        if !still_current() {
            log::warn!("[HOTSWAP] recovery superseded mid-teardown; aborting pass");
            return;
        }
        // `t` is a SESSION key; teardown operates on the process id. A pane
        // already closed while disconnected has nothing to tear down.
        let Some(process_id) = by_session.get(&t).cloned().filter(|p| port.pane_is_host_owned(p)) else {
            continue;
        };
        log::warn!("[HOTSWAP] session {t} not held by the reconnected host; closing its pane");
        port.teardown_pane(&process_id);
    }
}
