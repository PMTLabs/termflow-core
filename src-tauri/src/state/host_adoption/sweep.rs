//! The periodic sweep over every host.
//!
//! Each tick finds the hosts the app lost track of (a busy old host that never
//! answered, one whose connection dropped and whose own reconnect gave up),
//! asks every connected host what it holds, and offers the live sessions no pane
//! claims to the user. A sweep that could not hear from every host says so, so it
//! is tried again rather than counted as done.

use super::panes::{live_client, surface_orphans, PanePort};
use super::reconnect::reconnect_disconnected;
use super::{rediscover_hosts, HostChannel, PtyHostClient};
use crate::state::reattach::plan_reattach;
use crate::state::host_table::Admission;

/// The hosts this app is connected to right now, current first.
fn connected_hosts<P: PanePort>(port: &P) -> Vec<(HostChannel, PtyHostClient)> {
    let mut hosts: Vec<_> = live_client(port, HostChannel::Primary)
        .map(|client| (HostChannel::Primary, client))
        .into_iter()
        .collect();
    hosts.extend(
        port.frozen_hosts()
            .into_iter()
            .filter(|h| h.client.is_alive())
            .map(|h| (HostChannel::Frozen(h.id), h.client)),
    );
    hosts
}

/// Runs one sweep. `false` means it did NOT complete and must stay retryable: a
/// host could not be reached or did not answer its listing, and an unanswered
/// listing is unknown, never empty, so nothing is surfaced or torn down on it.
pub(in crate::state) async fn sweep<P: PanePort>(port: &P) -> bool {
    log::debug!("[GEN] sweeping terminal hosts");
    let mut complete = true;
    // Registered hosts whose connection is down get their reconnect again; only
    // one that is back, or found dead and dropped, counts as settled.
    if !reconnect_disconnected(port).await {
        complete = false;
    }
    // Hosts discovery knows that the registry does not, whether or not the current
    // host is up, and any whose listing was never answered.
    if let Err(e) = rediscover_hosts(port).await {
        log::warn!("[HOTSWAP] sweep could not reach the terminal hosts: {e}");
        return false;
    }
    if port.current_client().is_none() || !port.barrier().unresolved().is_empty() {
        complete = false;
    }
    for (channel, client) in connected_hosts(port) {
        let Some(epoch) = port.table().epoch(channel) else { continue };
        // An unanswered listing is unknown, never empty: do not surface or tear down.
        let Some(sessions) = client.list_sessions().await else {
            log::warn!("[HOTSWAP] {channel:?} did not answer the sweep's listing");
            complete = false;
            continue;
        };
        // A reconnect or retirement can finish while the listing is in flight.
        // Its older answer must not reserve sessions on a superseded connection.
        if !port.table().is_current(channel, epoch)
            || port.table().admission(channel) != Some(Admission::Open)
            || !client.is_alive()
        {
            log::info!("[GEN] discarding superseded sweep listing from {channel:?} epoch {epoch}");
            complete = false;
            continue;
        }
        // What this host is compared with is what this host owns.
        let claims: Vec<String> = port.panes_on(channel).into_keys().collect();
        let plan = plan_reattach(&claims, &sessions, &std::collections::HashMap::new());
        surface_orphans(port, plan.orphans, channel);
    }
    complete
}
