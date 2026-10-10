//! Handing the MCP port to a pty-host on the three exit paths (plan 055).
//!
//! Three layers, each reachable by tests:
//! - [`handover`], the core: no `AppState`, no lock. It chooses the holder, takes the snapshot and
//!   sends `HoldMcp`, recording in a caller-owned [`SentState`] what the host may have seen.
//! - [`HandedOver`], the cleanup bundle: the one owner of every resource the handover acquired, from
//!   the first one, so every way out (commit, release, drop, cancellation) undoes the same things.
//! - [`handover_txn`], the transaction: the network-operation lock, the guarded read of the launch
//!   record, then the core, generic over a [`HandoverPort`] so tests drive the real code.

use super::host_lifecycle::{AckedHost, Hold};
use super::mcp_snapshot::{mcp_snapshot, SNAPSHOT_BUDGET};
use super::types::{AppState, GenerationSlot, McpLaunch, McpProcess};
use crate::app_config::NetworkConfig;
use crate::elevated_host::HostChannel;
use crate::pty_host_client::{McpHoldOutcome, McpReleaseOutcome, McpSendError, PtyHostClient};
use std::sync::Arc;
use std::time::Duration;
use termflow_pty_protocol::{encode, Control, Frame, McpHoldReason, McpHoldSpec, MAX_FRAME_LEN};
use tokio::sync::OwnedMutexGuard;

/// How long the transaction waits for the network-operation lock before it gives up the hold: a
/// settings change in progress must not hold the exit up.
const LOCK_WAIT: Duration = Duration::from_secs(2);

/// The host that should hold the port: the primary when it advertises `CAP_MCP_HOLD`, otherwise
/// the first frozen one that does. Only armed hosts are ever offered, so a relaunch host that
/// failed its tolerated arm is never chosen. `None` means no capable host: the agents reconnect
/// as they do today.
pub(super) fn choose_holder(hosts: &[AckedHost]) -> Option<&AckedHost> {
    let capable = |h: &&AckedHost| h.client.mcp_hold();
    let chosen = hosts
        .iter()
        .filter(|h| h.channel == Some(HostChannel::Primary))
        .find(capable)
        .or_else(|| hosts.iter().filter(|h| matches!(h.channel, Some(HostChannel::Frozen(_)))).find(capable));
    if chosen.is_none() {
        log::info!("[MCP-HOLD] no capable host; agents will reconnect as today");
    }
    chosen
}

/// The spec with whatever has to go for its `HoldMcp` frame to fit the protocol's frame cap. Runs
/// where the final spec and credential exist, just before the send, and measures the encoded
/// payload the reader enforces (`encode` prepends five transport bytes). The tool list goes first,
/// then the `initialize` result: a holder without them still answers, a frame over the cap kills
/// the connection.
pub(super) fn fit_to_frame(mut spec: McpHoldSpec, token: &str) -> McpHoldSpec {
    let payload_len = |spec: &McpHoldSpec| {
        let frame = Frame::Ctrl(Control::HoldMcp { req: u64::MAX, token: token.to_owned(), spec: spec.clone() });
        encode(&frame).len() - 5
    };
    if payload_len(&spec) > MAX_FRAME_LEN {
        log::warn!("[MCP-HOLD] the tool list does not fit the frame cap; the holder will not serve it");
        spec.tools_list_result = None;
    }
    if payload_len(&spec) > MAX_FRAME_LEN {
        log::warn!("[MCP-HOLD] the initialize result does not fit the frame cap; the holder will not serve it");
        spec.initialize_result = None;
    }
    spec
}

// ---- the core ---------------------------------------------------------------------------------

/// What the chosen host may have seen of this handover. Written by [`handover`] into storage the
/// caller owns, so a cancelled future still leaves the cleanup with the safe answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SentState {
    /// Nothing was enqueued: the host cannot have seen a hold.
    None,
    /// A `HoldMcp` was enqueued and no definite reply came: the host may be holding.
    Ambiguous,
    Accepted,
    Rejected(String),
}

/// What the transaction reads under the network-operation lock.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HandoverInputs {
    /// The running sidecar's launch record; `None` when the MCP server is disabled or not running.
    pub launch: Option<McpLaunch>,
    /// The network config's MCP port (provenance for the holder).
    pub configured_port: u16,
}

/// Choose the holder, snapshot the sidecar and send it `HoldMcp`. Returns the host that accepted,
/// the one `ReleaseMcp` may be sent to; every other outcome leaves `None` and is in `sent`. After an
/// ambiguous send no second host is tried: the first may be holding.
pub(crate) async fn handover(
    acked: &[AckedHost], inputs: HandoverInputs, reason: McpHoldReason, host_token: &str, sent: &mut SentState,
) -> Option<PtyHostClient> {
    let Some(launch) = inputs.launch else {
        log::info!("[MCP-HOLD] no MCP sidecar is running; nothing to hand over");
        return None;
    };
    let holder = choose_holder(acked)?;
    let snapshot = mcp_snapshot(&launch, SNAPSHOT_BUDGET).await;
    let spec = fit_to_frame(
        McpHoldSpec {
            port: launch.port,
            configured_port: inputs.configured_port,
            bind_host: launch.bind_host,
            auth_token: launch.auth_token,
            reason,
            initialize_result: snapshot.initialize,
            tools_list_result: snapshot.tools_list,
        },
        host_token,
    );
    // Before the await: if this future is dropped while the frame is out, the cleanup must assume
    // the host may be holding.
    *sent = SentState::Ambiguous;
    let name = &holder.name;
    match holder.client.hold_mcp(host_token, spec).await {
        Ok(McpHoldOutcome::Accepted) => {
            log::info!("[MCP-HOLD] {name} accepted the hold ({reason:?})");
            *sent = SentState::Accepted;
            Some(holder.client.clone())
        }
        Ok(McpHoldOutcome::Rejected(why)) => {
            log::warn!("[MCP-HOLD] {name} rejected the hold: {why}");
            *sent = SentState::Rejected(why);
            None
        }
        Ok(McpHoldOutcome::NotCapable) => {
            log::info!("[MCP-HOLD] {name} no longer advertises the hold; nothing sent");
            *sent = SentState::None;
            None
        }
        Err(McpSendError::NotSent) => {
            log::warn!("[MCP-HOLD] the hold was not sent to {name}: its connection is closed");
            *sent = SentState::None;
            None
        }
        Err(McpSendError::Ambiguous) => {
            log::warn!("[MCP-HOLD] {name} did not answer the hold; it may be holding");
            None
        }
    }
}

// ---- the cleanup bundle -----------------------------------------------------------------------

/// How a cleanup undid the handover.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Cleanup {
    /// The accepting host answered `ReleaseMcp`.
    Released { was_holding: bool },
    /// The send was ambiguous: only the `Disarm` could undo it, and it does not stop a holder the
    /// app did not start.
    ViaDisarm,
    /// Nothing was sent, or the host refused: nothing to undo.
    NotNeeded,
    Unconfirmed(String),
}

struct Parts {
    hold: Hold,
    /// The network-operation lock, held from before the launch read until the exit commits.
    op: Option<OwnedMutexGuard<()>>,
    /// The host that accepted, the only one a `ReleaseMcp` may go to.
    target: Option<PtyHostClient>,
    sent: SentState,
    host_token: String,
}

/// Everything a handover acquired, with one owner. `commit`, `release` and `Drop` each take the
/// parts exactly once.
pub struct HandedOver {
    parts: Option<Parts>,
}

impl HandedOver {
    /// The hold the handover wraps, for the code that still reads it (hosts, update mode).
    pub fn hold(&self) -> &Hold {
        &self.parts.as_ref().expect("a handover keeps its parts until it ends").hold
    }

    /// What the chosen host may have seen, for tests.
    #[cfg(test)]
    pub(crate) fn sent(&self) -> SentState {
        self.parts.as_ref().map(|p| p.sent.clone()).unwrap_or(SentState::None)
    }

    /// The process is about to exit with the hosts armed. Sends nothing; the network lock stays
    /// held for the rest of the process, so a settings change cannot move the sidecar before it
    /// ends (the same pattern `Hold::commit` uses for its admission guard).
    pub fn commit(mut self) {
        if let Some(parts) = self.parts.take() {
            parts.hold.commit();
            if let Some(op) = parts.op {
                std::mem::forget(op);
            }
        }
    }

    /// The exit will not happen: undo the handover and put the hosts back. The cleanup runs on its
    /// own task, so cancelling this wait never cancels the cleanup.
    pub async fn release(mut self) -> (Cleanup, bool) {
        let Some(parts) = self.parts.take() else {
            return (Cleanup::NotNeeded, true);
        };
        match spawn_cleanup(parts) {
            Some(task) => task.await.unwrap_or_else(|_| (Cleanup::Unconfirmed("cleanup task failed".into()), false)),
            None => (Cleanup::Unconfirmed("no runtime".into()), false),
        }
    }
}

impl Drop for HandedOver {
    fn drop(&mut self) {
        if let Some(parts) = self.parts.take() {
            drop(spawn_cleanup(parts));
        }
    }
}

/// Run [`cleanup`] on the runtime, as one task that outlives its caller. Without a runtime nothing
/// can be sent: the parts drop, and the hold's own drop logs what it cannot disarm.
fn spawn_cleanup(parts: Parts) -> Option<tokio::task::JoinHandle<(Cleanup, bool)>> {
    match tokio::runtime::Handle::try_current() {
        Ok(runtime) => Some(runtime.spawn(cleanup(parts))),
        Err(_) => {
            log::error!("[MCP-HOLD] no runtime; cleanup unconfirmed");
            None
        }
    }
}

/// The one routine every way out of a handover runs: release the host that accepted (or leave it
/// to the disarm), disarm every armed host, log what happened, and only then let the network lock
/// go.
async fn cleanup(parts: Parts) -> (Cleanup, bool) {
    let Parts { hold, op, target, sent, host_token } = parts;
    let outcome = match (&sent, &target) {
        (SentState::Accepted, Some(target)) => match target.release_mcp(&host_token).await {
            Ok(McpReleaseOutcome::Released { was_holding }) => Cleanup::Released { was_holding },
            Ok(McpReleaseOutcome::NotCapable) => Cleanup::Unconfirmed("the host no longer advertises the hold".into()),
            Err(e) => Cleanup::Unconfirmed(e),
        },
        (SentState::Accepted, None) => Cleanup::Unconfirmed("the accepting host is not known".into()),
        (SentState::Ambiguous, _) => Cleanup::ViaDisarm,
        (SentState::None | SentState::Rejected(_), _) => Cleanup::NotNeeded,
    };
    // Awaited here, so the hold's own drop never finds armed hosts and never schedules a second,
    // unawaited disarm.
    let delivered = hold.release().await;
    let line = match (&outcome, delivered) {
        (Cleanup::Released { was_holding }, _) => format!("released (was_holding={was_holding})"),
        (Cleanup::ViaDisarm, true) => "via disarm (delivered=true)".to_string(),
        (Cleanup::ViaDisarm, false) => "via disarm (delivered=false): unconfirmed".to_string(),
        (Cleanup::NotNeeded, _) => "not needed".to_string(),
        (Cleanup::Unconfirmed(e), _) => format!("unconfirmed: {e}"),
    };
    log::info!("[MCP-HOLD] rollback: {line}");
    drop(op);
    (outcome, delivered)
}

// ---- the transaction --------------------------------------------------------------------------

/// What the transaction needs from the application.
pub(crate) trait HandoverPort {
    /// The lock every network command takes; the transaction holds it until the exit commits.
    fn network_op_lock(&self) -> Arc<tokio::sync::Mutex<()>>;
    /// The launch record and configured port, read only once the lock is held.
    fn read_inputs(&self) -> HandoverInputs;
    /// The credential the hold is authenticated with, the one the arm used.
    fn host_token(&self) -> String;
}

/// Lock the network operations, read the sidecar's launch record, hand the port to one host. The
/// bundle is built before anything else, so cancelling this future at any await still undoes what
/// was acquired.
pub(crate) async fn handover_txn<P: HandoverPort>(port: &P, hold: Hold, reason: McpHoldReason) -> HandedOver {
    let mut handed = HandedOver {
        parts: Some(Parts { hold, op: None, target: None, sent: SentState::None, host_token: port.host_token() }),
    };
    let lock = port.network_op_lock();
    let Ok(guard) = tokio::time::timeout(LOCK_WAIT, lock.lock_owned()).await else {
        log::warn!("[MCP-HOLD] a network operation is in progress; no hold sent, the exit continues");
        return handed;
    };
    let parts = handed.parts.as_mut().expect("the bundle was just built");
    parts.op = Some(guard);
    let inputs = port.read_inputs();
    let acked = parts.hold.acked_hosts();
    parts.target = handover(&acked, inputs, reason, &parts.host_token, &mut parts.sent).await;
    log::info!("[MCP-HOLD] handover finished: {:?}", parts.sent);
    handed
}

/// The slot's launch record and the configured port, as the transaction reads them.
pub(crate) fn handover_inputs(slot: &GenerationSlot<McpProcess>, network: &NetworkConfig) -> HandoverInputs {
    HandoverInputs { launch: slot.current().map(|process| process.launch.clone()), configured_port: network.mcp_port }
}

impl<R: tauri::Runtime> HandoverPort for AppState<R> {
    fn network_op_lock(&self) -> Arc<tokio::sync::Mutex<()>> {
        self.network_op_lock.clone()
    }

    fn read_inputs(&self) -> HandoverInputs {
        handover_inputs(&self.mcp_process.lock().unwrap_or_else(|e| e.into_inner()), &self.network.read())
    }

    fn host_token(&self) -> String {
        crate::pty_host_client::resolve_token()
    }
}

/// Hand the MCP port to a pty-host as the app begins to exit; see [`handover_txn`].
pub async fn send_mcp_hold(state: &AppState, hold: Hold, reason: McpHoldReason) -> HandedOver {
    handover_txn(state, hold, reason).await
}
