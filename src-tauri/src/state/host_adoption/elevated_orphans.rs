//! One-shot post-placement recovery; deliberately not part of the shared sweep.
use super::{listing_is_current, PanePort, PtyHostClient};
use crate::elevated_host::HostChannel;
use crate::state::host_table::Admission;
use std::{collections::HashMap, time::Duration};

pub(in crate::state) async fn run<P: PanePort>(port: &P, client: &PtyHostClient, epoch: u64) {
    let channel = HostChannel::Elevated;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(termflow_pty_protocol::LOCAL_HOLD_ACTIVE_SECS);
    while port.table().keys().restore_pending_count() != 0 {
        if tokio::time::Instant::now() >= deadline {
            log::warn!("[ADMIN] orphan pass timed out waiting for window restore");
            return;
        }
        if !listing_is_current(port.table(), channel, epoch, client, Admission::Open) { return; }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    for _ in 0..3 {
        let Some(listing) = client.list_sessions_numbered_within(Duration::from_secs(5)).await else { continue; };
        if !listing_is_current(port.table(), channel, epoch, client, Admission::Open) { return; }
        port.apply_listing(channel, client, Some(&listing));
        let claims: Vec<_> = port.panes_on(channel).into_keys().collect();
        let plan = crate::state::reattach::plan_reattach(&claims, &listing.sessions, &HashMap::new());
        super::panes::surface_orphans(port, plan.orphans, channel);
        return;
    }
}
