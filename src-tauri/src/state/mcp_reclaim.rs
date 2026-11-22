//! Taking the MCP port back from the pty-host that has been holding it (plan 056).
//!
//! After an offload, an offload update or a recovery relaunch a pty-host holds the MCP port for the
//! agents. A relaunched app announces itself to every host that advertises the hold (`ClaimMcp`,
//! the first frame of its adoption), is told what is held, and records it here. MCP startup then
//! decides: release the holder and start the sidecar on the held port, or fall back to today's
//! search.
//!
//! - [`McpReclaim`] is the registry: one claim, one cleanup owner ([`release_detached`]), shared by
//!   adoption (which offers), retirement (which asks for the lease) and boot (which decides).
//! - [`ReclaimBoot`] is the boot's guard: whatever the boot leaves unused is released.

use crate::app_config::NetworkConfig;
use crate::elevated_host::HostChannel;
use crate::network_commands::PortOwner;
use crate::pty_host_client::{McpReleaseOutcome, PtyHostClient};
use crate::state::AppState;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use termflow_pty_protocol::McpHeld;
use tokio::runtime::Handle;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::Instant;

/// How long MCP startup waits for a claim.
pub(crate) const CLAIM_WAIT: Duration = Duration::from_secs(5);
/// How long a claimed holder shields its host from retirement: the holder's own handback grace.
pub(crate) const RECLAIM_LEASE: Duration = Duration::from_secs(60);
/// How long, after the sidecar answered its health check, the held port is given to prove it is ours.
pub(crate) const IDENTITY_WAIT: Duration = Duration::from_secs(3);

// ---- the claim ------------------------------------------------------------------------------------

/// Where one claim's holder stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SlotState {
    /// Claimed, not released: the host is serving as a holder until it is told to stop.
    Held,
    /// A `ReleaseMcp` is in flight.
    Releasing,
    /// The host acknowledged the release.
    Released,
    /// No acknowledgement, the connection was gone, or there was no runtime. The holder either
    /// stopped on its disconnect or ends at its own grace.
    Unconfirmed,
}

/// The part of a claim that outlives the claim's owner: what the lease and the cleanup read and write.
struct Slot {
    channel: HostChannel,
    epoch: u64,
    at: Instant,
    state: Mutex<SlotState>,
}

impl Slot {
    fn state(&self) -> SlotState {
        *self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn set(&self, state: SlotState) {
        *self.state.lock().unwrap_or_else(|e| e.into_inner()) = state;
    }

    /// `Releasing` -> `Unconfirmed`; true when it changed.
    fn abandon(&self) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let was_releasing = *state == SlotState::Releasing;
        if was_releasing {
            *state = SlotState::Unconfirmed;
        }
        was_releasing
    }

    fn is_connection(&self, channel: HostChannel, epoch: u64) -> bool {
        self.channel == channel && self.epoch == epoch
    }
}

/// What a host reported it is holding, and everything needed to release it later.
pub(crate) struct Claimed {
    pub(crate) held: McpHeld,
    pub(crate) client: PtyHostClient,
    pub(crate) channel: HostChannel,
    pub(crate) epoch: u64,
    pub(crate) endpoint: String,
    /// The host lifecycle token the claim was authenticated with; the release uses the same one.
    pub(crate) token: String,
    pub(crate) at: Instant,
    /// The runtime that runs this claim's release, captured where the claim was made so a `Drop`
    /// on a thread with no runtime can still deliver it.
    rt: Handle,
    slot: Arc<Slot>,
}

impl Claimed {
    /// A claim made now. Must be called inside the runtime that will run its release.
    pub(crate) fn new(
        held: McpHeld, client: PtyHostClient, channel: HostChannel, epoch: u64, endpoint: String, token: String,
    ) -> Self {
        let at = Instant::now();
        let slot = Arc::new(Slot { channel, epoch, at, state: Mutex::new(SlotState::Held) });
        Self { held, client, channel, epoch, endpoint, token, at, rt: Handle::current(), slot }
    }
}

/// How a release ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReleaseResult {
    /// The host acknowledged: the holder's stop is ordered.
    Released,
    Unconfirmed,
    /// There was no claim to release.
    NothingHeld,
}

/// Ends a release's bookkeeping however its task ends. Moved into the release future: if the future
/// is dropped without completing (never polled, or dropped because the runtime shut down) the slot
/// leaves `Releasing` for `Unconfirmed` and says so.
struct Finalizer {
    pending: Option<Arc<Slot>>,
}

impl Finalizer {
    fn complete(mut self, result: ReleaseResult) {
        if let Some(slot) = self.pending.take() {
            slot.set(match result {
                ReleaseResult::Released => SlotState::Released,
                _ => SlotState::Unconfirmed,
            });
        }
    }
}

impl Drop for Finalizer {
    fn drop(&mut self) {
        if let Some(slot) = self.pending.take() {
            if slot.abandon() {
                log::warn!("[MCP] reclaim release not delivered (runtime gone)");
            }
        }
    }
}

/// The one cleanup of a claim, whatever route reaches it: an explicit release, a late or duplicate
/// claim, a dropped guard. The `ReleaseMcp` runs on its own task on the runtime captured with the
/// claim, so cancelling whoever awaits the result never cancels the wire action (the same
/// detach-then-await shape as the exit handover's cleanup).
pub(crate) fn release_detached(claimed: Claimed) -> JoinHandle<ReleaseResult> {
    let Claimed { client, token, endpoint, rt, slot, at, .. } = claimed;
    slot.set(SlotState::Releasing);
    let finalizer = Finalizer { pending: Some(slot) };
    rt.spawn(async move {
        let result = match client.release_mcp(&token).await {
            Ok(McpReleaseOutcome::Released { was_holding }) => {
                log::info!(
                    "[MCP] reclaim release acknowledged by {endpoint} (was_holding={was_holding}, claimed {:?} ago)",
                    at.elapsed()
                );
                ReleaseResult::Released
            }
            Ok(McpReleaseOutcome::NotCapable) => {
                log::warn!("[MCP] reclaim release not sent to {endpoint}: it no longer advertises the hold");
                ReleaseResult::Unconfirmed
            }
            Err(e) => {
                log::warn!("[MCP] reclaim release to {endpoint} unconfirmed: {e}");
                ReleaseResult::Unconfirmed
            }
        };
        finalizer.complete(result);
        result
    })
}

/// [`release_detached`], awaited. A task that failed has already been finalized as `Unconfirmed`.
async fn release_and_wait(claimed: Claimed) -> ReleaseResult {
    release_detached(claimed).await.unwrap_or(ReleaseResult::Unconfirmed)
}

// ---- the registry ---------------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// Boot has not decided yet: the first claim is stored for it.
    Open,
    /// Boot decided (or is done): a claim that arrives now is late.
    Decided,
}

struct Registry {
    phase: Phase,
    /// The claim boot has not taken yet (only while `Open`).
    stored: Option<Claimed>,
    /// The slot of the first claim, kept after boot took it so the lease keeps answering.
    slot: Option<Arc<Slot>>,
}

struct Shared {
    registry: Mutex<Registry>,
    changed: watch::Sender<u64>,
}

/// What the hosts reported holding, handed to MCP startup exactly once. Cheap to clone; every clone
/// is the same registry.
#[derive(Clone)]
pub struct McpReclaim {
    shared: Arc<Shared>,
}

impl Default for McpReclaim {
    fn default() -> Self {
        Self::new()
    }
}

impl McpReclaim {
    pub fn new() -> Self {
        Self {
            shared: Arc::new(Shared {
                registry: Mutex::new(Registry { phase: Phase::Open, stored: None, slot: None }),
                changed: watch::channel(0).0,
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Registry> {
        self.shared.registry.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A host reported it is holding. The first claim before the decision is stored for boot; a
    /// repeat from the same connection is a no-op (a re-list, a retried unanswered host); anything
    /// else is released at once and logged.
    pub(crate) fn offer(&self, claimed: Claimed) {
        enum Verdict {
            Stored,
            Repeat,
            Duplicate(Claimed),
            Late(Claimed),
        }
        let verdict = {
            let mut registry = self.lock();
            let repeat = registry.slot.as_ref().is_some_and(|slot| slot.is_connection(claimed.channel, claimed.epoch));
            match (repeat, registry.phase, registry.slot.is_some()) {
                (true, _, _) => Verdict::Repeat,
                (false, Phase::Open, true) => Verdict::Duplicate(claimed),
                (false, Phase::Open, false) => {
                    registry.slot = Some(claimed.slot.clone());
                    registry.stored = Some(claimed);
                    Verdict::Stored
                }
                (false, Phase::Decided, _) => Verdict::Late(claimed),
            }
        };
        match verdict {
            Verdict::Stored => {
                self.shared.changed.send_modify(|version| *version += 1);
            }
            Verdict::Repeat => {}
            Verdict::Duplicate(claimed) => {
                log::warn!(
                    "[MCP] {} also reports holding the MCP port; releasing that claim (a duplicate)",
                    claimed.endpoint
                );
                drop(release_detached(claimed));
            }
            Verdict::Late(claimed) => {
                log::warn!(
                    "[MCP] {} reported holding the MCP port after the startup decision; releasing it \
                     (agents fall back to the normal port search)",
                    claimed.endpoint
                );
                drop(release_detached(claimed));
            }
        }
    }

    /// Wake-ups for a stored claim. Subscribe before reading [`Self::has_claim`].
    pub(crate) fn subscribe(&self) -> watch::Receiver<u64> {
        self.shared.changed.subscribe()
    }

    /// Is a claim waiting for boot?
    pub(crate) fn has_claim(&self) -> bool {
        self.lock().stored.is_some()
    }

    /// Boot's decision: later claims are late. Hands over the stored claim, if any, once.
    fn decide(&self) -> Option<Claimed> {
        let mut registry = self.lock();
        registry.phase = Phase::Decided;
        registry.stored.take()
    }

    /// Is the connection `(channel, epoch)` the one a claimed holder is serving through, and is that
    /// holder still ours to wait for: `Held` or `Releasing`, and younger than [`RECLAIM_LEASE`]. The
    /// retirement ticker keeps such a host.
    pub(crate) fn lease_on(&self, channel: HostChannel, epoch: u64) -> bool {
        let registry = self.lock();
        registry.slot.as_ref().is_some_and(|slot| {
            slot.is_connection(channel, epoch)
                && matches!(slot.state(), SlotState::Held | SlotState::Releasing)
                && Instant::now().saturating_duration_since(slot.at) < RECLAIM_LEASE
        })
    }

    /// Where the first claim's holder stands, for tests.
    #[cfg(test)]
    pub(crate) fn slot_state(&self) -> Option<SlotState> {
        self.lock().slot.as_ref().map(|slot| slot.state())
    }
}

/// Boot's hold on the registry. Whatever claim it has taken and not released is released when the
/// guard drops, so a cancelled or abandoned boot leaves nothing holding.
pub(crate) struct ReclaimBoot {
    reclaim: McpReclaim,
    claim: Option<Claimed>,
}

impl ReclaimBoot {
    pub(crate) fn new(reclaim: McpReclaim) -> Self {
        Self { reclaim, claim: None }
    }

    /// Take the decision: from now on a claim is late. Returns what the held claim reports.
    pub(crate) fn decide(&mut self) -> Option<McpHeld> {
        if let Some(claim) = self.reclaim.decide() {
            self.claim = Some(claim);
        }
        self.claim.as_ref().map(|claim| claim.held.clone())
    }

    /// Release the held claim, if any. The wire action is detached: dropping this future leaves it
    /// running.
    pub(crate) async fn release(&mut self) -> ReleaseResult {
        self.decide();
        match self.claim.take() {
            Some(claim) => release_and_wait(claim).await,
            None => ReleaseResult::NothingHeld,
        }
    }

    /// Where the claim this guard took stands, for logs.
    pub(crate) fn endpoint(&self) -> Option<&str> {
        self.claim.as_ref().map(|claim| claim.endpoint.as_str())
    }

    /// When the claim this guard took was first made, for tests.
    #[cfg(test)]
    pub(crate) fn claimed_at(&self) -> Option<Instant> {
        self.claim.as_ref().map(|claim| claim.at)
    }
}

impl Drop for ReclaimBoot {
    fn drop(&mut self) {
        self.decide();
        if let Some(claim) = self.claim.take() {
            log::info!("[MCP] releasing the claim on {} that startup did not use", claim.endpoint);
            drop(release_detached(claim));
        }
    }
}

// ---- the decision -------------------------------------------------------------------------------

/// What MCP startup does with what the hosts reported.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Decision {
    /// Release the holder and start the sidecar on this port, bypassing the search.
    Use(u16),
    /// A holder exists but the configuration moved on; the reason is for the log.
    Changed(String),
    /// Nothing was held, or nothing answered.
    NoClaim,
}

/// The configured-port rule. The held port is used when the holder was started for the
/// configuration that is in force now: the same configured MCP port and the same bind host. A launch
/// that had fallen back (`held.port != held.configured_port`) is still `Use(held.port)`: it was a
/// consequence of the configuration, not a change to it.
pub(crate) fn reclaim_rule(held: Option<&McpHeld>, configured_mcp_port: u16, launch_bind_host: &str) -> Decision {
    let Some(held) = held else { return Decision::NoClaim };
    if held.configured_port != configured_mcp_port {
        return Decision::Changed(format!(
            "the configured MCP port changed from {} to {configured_mcp_port}",
            held.configured_port
        ));
    }
    if held.bind_host != launch_bind_host {
        return Decision::Changed(format!("the bind host changed from {} to {launch_bind_host}", held.bind_host));
    }
    Decision::Use(held.port)
}

// ---- boot ---------------------------------------------------------------------------------------

/// What MCP startup does to the world, and asks of it. The real implementation is [`AppBootIo`], a
/// thin adapter whose every method is one delegation; tests supply a fake with timestamps.
pub(crate) trait McpBootIo {
    /// Start the survivor adoption round on its own task; the handle ends when the round does.
    fn start_round(&self) -> JoinHandle<()>;
    /// Is no adoption attempt in flight on any host?
    fn quiet(&self) -> bool;
    /// Today's search for an MCP port.
    fn pick_mcp(
        &self, cfg: &NetworkConfig, own_id: &str, api_port: u16,
    ) -> impl std::future::Future<Output = Option<u16>> + Send;
    /// Start the sidecar on `port`; false when it did not come up.
    fn spawn(&self, cfg: &NetworkConfig, port: u16) -> impl std::future::Future<Output = bool> + Send;
    /// Who answers `/health` on `port`.
    fn owns(&self, own_id: &str, port: u16) -> impl std::future::Future<Output = PortOwner> + Send;
    /// Stop the sidecar, if any.
    fn stop(&self);
}

/// What `lib.rs` hands boot: the instance identity, the configuration it started with and the
/// registry adoption fills.
pub(crate) struct BootInputs {
    pub(crate) own_id: String,
    pub(crate) cfg: NetworkConfig,
    pub(crate) reclaim: McpReclaim,
}

/// The survivor round, the claim wait and the decision, made. Owns the boot guard from the first line
/// of [`prepare_reclaim`]: dropping it releases whatever claim it still holds.
pub(crate) struct Prepared {
    guard: ReclaimBoot,
    decision: Decision,
    reserved: Vec<u16>,
    cfg: NetworkConfig,
    own_id: String,
}

impl Prepared {
    /// Ports the API bind must not take: the held MCP port while it is to be reused.
    pub(crate) fn reserved(&self) -> &[u16] {
        &self.reserved
    }

    #[cfg(test)]
    pub(crate) fn decision(&self) -> &Decision {
        &self.decision
    }
}

/// Polling period of the wait once the survivor round has ended, while a concurrent round's attempt
/// may still be in flight on a host.
const QUIET_POLL: Duration = Duration::from_millis(50);
/// Polling period of the identity check.
const IDENTITY_POLL: Duration = Duration::from_millis(250);

/// Wait for the first of: a stored claim, adoption being quiet (the survivor round has ended and no
/// attempt is in flight on any host, so a concurrent restore or create round that owns the holder's
/// attempt still holds the wait open), [`CLAIM_WAIT`].
async fn wait_for_claim<IO: McpBootIo>(io: &IO, reclaim: &McpReclaim, round: &mut JoinHandle<()>) {
    // Subscribe before reading, so a claim stored between the two is not missed.
    let mut stored = reclaim.subscribe();
    let deadline = Instant::now() + CLAIM_WAIT;
    let mut round_ended = false;
    loop {
        if reclaim.has_claim() {
            return;
        }
        if round_ended && io.quiet() {
            return;
        }
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => {
                log::warn!("[MCP] no claim and adoption not quiet after {CLAIM_WAIT:?}; starting the MCP server without one");
                return;
            }
            _ = stored.changed() => {}
            _ = &mut *round, if !round_ended => { round_ended = true; }
            _ = tokio::time::sleep(QUIET_POLL), if round_ended => {}
        }
    }
}

/// Phase one of MCP startup, before the API bind: adopt the surviving hosts (each is claimed as it is
/// adopted), wait for the claim, and decide. A `Changed` holder is released here; a `Use` holder keeps
/// serving until [`start_mcp`], so the agents are answered through the API bind.
pub(crate) async fn prepare_reclaim<IO: McpBootIo>(io: &IO, inputs: BootInputs) -> Prepared {
    let mut guard = ReclaimBoot::new(inputs.reclaim.clone());
    let BootInputs { own_id, cfg, reclaim } = inputs;
    let mut round = io.start_round();
    wait_for_claim(io, &reclaim, &mut round).await;
    let held = guard.decide();
    let launch_bind_host = crate::mcp_sidecar::mcp_launch_env(&cfg, crate::profile::current().integrity).0.bind_host;
    let decision = reclaim_rule(held.as_ref(), cfg.mcp_port, &launch_bind_host);
    let mut reserved = Vec::new();
    match &decision {
        Decision::NoClaim => log::info!("[MCP] reclaim: no host holds the MCP port; the normal port search follows"),
        Decision::Use(port) => {
            log::info!(
                "[MCP] reclaim: {} holds port {port} for the current configuration; it will be reused",
                guard.endpoint().unwrap_or("?")
            );
            reserved.push(*port);
        }
        Decision::Changed(reason) => {
            log::info!("[MCP] reclaim: {reason}; releasing the holder and using the configuration");
            let result = guard.release().await;
            log::info!("[MCP] reclaim: release of the superseded holder: {result:?}");
        }
    }
    Prepared { guard, decision, reserved, cfg, own_id }
}

/// Poll `/health` on `port` until our own instance answers it, for at most [`IDENTITY_WAIT`]. The bound
/// covers the probes as well as the pauses: an answer seen after it is not accepted, even one that was
/// ready when the timeout expired (a timeout polls its future before its deadline).
pub(crate) async fn wait_for_identity<IO: McpBootIo>(io: &IO, own_id: &str, port: u16) -> bool {
    let deadline = Instant::now() + IDENTITY_WAIT;
    let poll = async {
        while Instant::now() < deadline {
            if io.owns(own_id, port).await == PortOwner::OwnedBySelf {
                return Instant::now() <= deadline;
            }
            tokio::time::sleep(IDENTITY_POLL).await;
        }
        false
    };
    tokio::time::timeout_at(deadline, poll).await.unwrap_or(false)
}

/// Take the held port back: release the holder, start the sidecar on that port and prove it is ours.
/// `Err` names why not; the caller falls back to the normal search.
async fn reclaim_port<IO: McpBootIo>(
    guard: &mut ReclaimBoot, io: &IO, cfg: &NetworkConfig, own_id: &str, port: u16,
) -> Result<(), String> {
    match guard.release().await {
        ReleaseResult::Released => {}
        other => return Err(format!("the holder's release was not acknowledged ({other:?})")),
    }
    if !io.spawn(cfg, port).await {
        return Err(format!("the MCP server did not start on the held port {port}"));
    }
    if !wait_for_identity(io, own_id, port).await {
        return Err(format!("port {port} does not answer as this instance after the start"));
    }
    Ok(())
}

/// Phase two of MCP startup, after the API bind: start the sidecar on the held port when the decision
/// was `Use` and it proves to be ours, otherwise on whatever the normal search finds. `None` when no
/// MCP server is running.
pub(crate) async fn start_mcp<IO: McpBootIo>(prepared: Prepared, api_port: u16, io: &IO) -> Option<u16> {
    let Prepared { mut guard, decision, cfg, own_id, .. } = prepared;
    if let Decision::Use(port) = decision {
        let endpoint = guard.endpoint().unwrap_or("?").to_owned();
        match reclaim_port(&mut guard, io, &cfg, &own_id, port).await {
            Ok(()) => {
                log::info!("[MCP] reclaimed held port {port} from {endpoint}");
                return Some(port);
            }
            Err(reason) => {
                log::warn!("[MCP] reclaiming held port {port} failed ({reason}); falling back to the normal port search");
                io.stop();
            }
        }
    }
    match io.pick_mcp(&cfg, &own_id, api_port).await {
        Some(port) => {
            if io.spawn(&cfg, port).await {
                Some(port)
            } else {
                log::error!("[MCP] boot startup was rejected or failed; endpoint unpublished");
                None
            }
        }
        None => {
            log::error!("[MCP] no free MCP port near {} — the MCP server is NOT running", cfg.mcp_port);
            None
        }
    }
}

// ---- the real boot IO -----------------------------------------------------------------------------

/// [`McpBootIo`] over the application. Each method is one delegation, pinned by a source census.
pub(crate) struct AppBootIo {
    pub(crate) app: tauri::AppHandle,
    pub(crate) state: AppState,
}

/// The survivor round on its own task; a failure is logged, never fatal to boot.
async fn survivor_round(state: AppState) {
    if let Err(e) = state.adopt_survivors().await {
        log::warn!("[MCP] the survivor adoption round failed: {e}");
    }
}

impl McpBootIo for AppBootIo {
    fn start_round(&self) -> JoinHandle<()> {
        tokio::spawn(survivor_round(self.state.clone()))
    }

    fn quiet(&self) -> bool {
        !self.state.host_barrier.any_in_flight()
    }

    async fn pick_mcp(&self, cfg: &NetworkConfig, own_id: &str, api_port: u16) -> Option<u16> {
        crate::net_ports::pick_mcp_port(cfg.mcp_port, crate::net_ports::DEFAULT_SPAN, own_id, &[api_port]).await
    }

    async fn spawn(&self, cfg: &NetworkConfig, port: u16) -> bool {
        crate::respawn_mcp(self.app.clone(), self.state.clone(), &NetworkConfig { mcp_port: port, ..cfg.clone() }).await
    }

    async fn owns(&self, own_id: &str, port: u16) -> PortOwner {
        crate::network_commands::probe_port_owner(port, own_id).await
    }

    fn stop(&self) {
        crate::shutdown_mcp_server(&self.state);
    }
}
