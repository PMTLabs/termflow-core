//! Adopting every pty-host that survived, independently of the others.
//!
//! An update leaves the previous build's host running next to the new build's
//! own, and either can be slow, busy or gone. Each candidate is therefore
//! connected on its own task under one overall deadline, sends its lifecycle
//! frame the moment it is connected (which revokes that host's absence clock)
//! and only then lists, and is published the moment it has been listed — a
//! slow old host never delays a fresh first tab, and never has its expiry
//! decided by a neighbour.
//!
//! What each host answered is the adoption barrier. A listing that was never
//! answered is *unknown*, not empty: a restored pane must wait for it instead of
//! being spawned over a session the host still holds.
//!
//! Everything here runs against [`AdoptionPort`], which `AppState` implements,
//! so the ordering and timing rules are testable without a Tauri `AppHandle`.

use super::host_table::{HostTable, LIFECYCLE_BUSY};
use super::types::FrozenHost;
use crate::elevated_host::{FrozenId, HostChannel};
use crate::pty_host_client::{HostCandidate, HostRole, PtyHostClient};
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use termflow_pty_protocol::SessionMeta;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::Instant;

/// Overall budget for one adoption round. Every candidate's own connect, lifecycle
/// frame and listing share it, so the round ends on time however many hosts are
/// slow. Longer than a healthy current-host spawn (grace 10 s + start-up 6 s).
pub(super) const ADOPTION_DEADLINE: Duration = Duration::from_secs(25);
const LIST_ATTEMPTS: u32 = 3;
/// Shorter than the client's default 10 s request timeout: a host that cannot
/// answer a listing in this long is treated as unresponsive and retried.
const LIST_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(3);
const LIST_RETRY_PAUSE: Duration = Duration::from_millis(500);

/// Identity of a host's endpoint for bookkeeping. Named-pipe names are
/// case-insensitive; socket paths are not.
pub(super) fn barrier_key(endpoint: &str) -> String {
    if endpoint
        .get(..9)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(r"\\.\pipe\"))
    {
        endpoint.to_lowercase()
    } else {
        endpoint.to_owned()
    }
}

// ---- barrier --------------------------------------------------------------

/// What we know about one host's sessions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolution {
    /// The host answered a listing; its claims are reserved.
    Resolved,
    /// We do not know what the host holds, and say why.
    Unresolved(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnresolvedHost {
    pub endpoint: String,
    pub reason: String,
}

struct Entry {
    key: String,
    endpoint: String,
    /// Assigned when the host is first seen and kept: one host never has two
    /// roles, however a later discovery classifies its endpoint.
    role: HostRole,
    resolution: Resolution,
    /// Something will settle this host: an attempt is in flight, or (after a
    /// lost connection) its own reconnect owns it. Nothing else may assume a
    /// retry is coming.
    retry_pending: bool,
}

struct BarrierShared {
    entries: Mutex<Vec<Entry>>,
    changed: watch::Sender<u64>,
}

/// Per-host resolution of the surviving hosts. Cheap to clone.
#[derive(Clone)]
pub struct Barrier {
    shared: Arc<BarrierShared>,
}

impl Default for Barrier {
    fn default() -> Self {
        Self::new()
    }
}

impl Barrier {
    pub fn new() -> Self {
        Self {
            shared: Arc::new(BarrierShared { entries: Mutex::new(Vec::new()), changed: watch::channel(0).0 }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Vec<Entry>> {
        self.shared.entries.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn notify(&self) {
        self.shared.changed.send_modify(|version| *version += 1);
    }

    /// Bring the table in line with a discovery pass. A compatible candidate
    /// becomes an unresolved entry. An incompatible one is never tracked: it is
    /// never owned, so it must not hold a restoring pane. An entry whose host is
    /// no longer discovered (its process is gone) and is not connected is
    /// dropped for the same reason.
    pub fn sync(&self, discovered: &[HostCandidate], connected: &[String]) {
        {
            let mut entries = self.lock();
            for candidate in discovered.iter().filter(|c| c.compatible()) {
                let key = barrier_key(&candidate.endpoint);
                if !entries.iter().any(|e| e.key == key) {
                    entries.push(Entry {
                        key,
                        endpoint: candidate.endpoint.clone(),
                        role: candidate.role,
                        resolution: Resolution::Unresolved("not connected yet".into()),
                        retry_pending: false,
                    });
                }
            }
            entries.retain(|e| {
                discovered
                    .iter()
                    .any(|c| c.compatible() && barrier_key(&c.endpoint) == e.key)
                    || connected.contains(&e.key)
            });
        }
        self.notify();
    }

    pub fn role_of(&self, key: &str) -> Option<HostRole> {
        self.lock().iter().find(|e| e.key == key).map(|e| e.role)
    }

    pub fn is_tracked(&self, key: &str) -> bool {
        self.lock().iter().any(|e| e.key == key)
    }

    /// Is the host unresolved with nothing on its way to settle it?
    pub fn needs_attempt_for(&self, key: &str) -> bool {
        self.lock()
            .iter()
            .any(|e| e.key == key && e.resolution != Resolution::Resolved && !e.retry_pending)
    }

    /// Is any host unresolved with nothing on its way to settle it?
    pub fn needs_attempt(&self) -> bool {
        self.lock()
            .iter()
            .any(|e| e.resolution != Resolution::Resolved && !e.retry_pending)
    }

    /// Claim the right to attempt `key`. False when an attempt is already in
    /// flight, so two rounds never connect the same host twice. A host that is
    /// not tracked (the current host about to be spawned) is always free.
    pub fn begin_attempt(&self, key: &str) -> bool {
        match self.lock().iter_mut().find(|e| e.key == key) {
            Some(entry) if entry.retry_pending => false,
            Some(entry) => {
                entry.retry_pending = true;
                true
            }
            None => true,
        }
    }

    /// An attempt ended with `resolution`. Records the host if it was not
    /// tracked and the outcome is a real one.
    pub fn finish(&self, key: &str, endpoint: &str, role: HostRole, resolution: Resolution) {
        {
            let mut entries = self.lock();
            match entries.iter_mut().find(|e| e.key == key) {
                Some(entry) => {
                    entry.resolution = resolution;
                    entry.retry_pending = false;
                }
                None => entries.push(Entry {
                    key: key.to_owned(),
                    endpoint: endpoint.to_owned(),
                    role,
                    resolution,
                    retry_pending: false,
                }),
            }
        }
        self.notify();
    }

    /// An attempt on a host that was never tracked failed: there is nothing to
    /// record, because no host process was found behind it.
    pub fn abandon_attempt(&self, key: &str) {
        if let Some(entry) = self.lock().iter_mut().find(|e| e.key == key) {
            entry.retry_pending = false;
        }
        self.notify();
    }

    /// The connection to a resolved host dropped: what it holds is unknown again,
    /// and its own reconnect — not a rediscovery — owns getting it back.
    pub fn mark_lost(&self, key: &str, reason: &str) {
        if let Some(entry) = self.lock().iter_mut().find(|e| e.key == key) {
            entry.resolution = Resolution::Unresolved(reason.to_owned());
            entry.retry_pending = true;
        }
        self.notify();
    }

    pub fn unresolved(&self) -> Vec<UnresolvedHost> {
        self.lock()
            .iter()
            .filter_map(|e| match &e.resolution {
                Resolution::Resolved => None,
                Resolution::Unresolved(reason) => {
                    Some(UnresolvedHost { endpoint: e.endpoint.clone(), reason: reason.clone() })
                }
            })
            .collect()
    }

    /// Wait for every tracked host to be resolved, for at most `bound`. `Err`
    /// names the hosts still unresolved: the caller must neither spawn over
    /// them nor treat them as empty.
    pub async fn wait_resolved(&self, bound: Duration) -> Result<(), Vec<UnresolvedHost>> {
        // Subscribe before looking, so a change between the two is not missed.
        let mut changed = self.shared.changed.subscribe();
        let settled = async {
            loop {
                if self.unresolved().is_empty() {
                    return;
                }
                if changed.changed().await.is_err() {
                    return;
                }
            }
        };
        match tokio::time::timeout(bound, settled).await {
            Ok(()) => Ok(()),
            Err(_) => Err(self.unresolved()),
        }
    }
}

/// A frozen host's connection dropped. Only the connection currently published
/// for the host may act on it: a callback from a superseded connection is inert.
/// Returns whether it acted.
pub(super) fn frozen_connection_lost(
    table: &HostTable,
    barrier: &Barrier,
    id: FrozenId,
    epoch: u64,
    endpoint: &str,
) -> bool {
    if !table.is_current(HostChannel::Frozen(id), epoch) {
        return false;
    }
    barrier.mark_lost(&barrier_key(endpoint), "connection lost");
    true
}

// ---- the port -------------------------------------------------------------

/// A connection made to a host, before its sessions are known.
pub(super) struct Opened {
    pub client: PtyHostClient,
    /// Identifies this connection to the callbacks wired into it.
    pub epoch: u64,
    pub build_id: Option<String>,
}

/// What adoption needs from the application. `AppState` implements it; tests
/// implement it over in-memory duplex connections.
pub(super) trait AdoptionPort: Clone + Send + Sync + 'static {
    fn table(&self) -> &HostTable;
    fn barrier(&self) -> &Barrier;
    /// Serialises the start of adoption rounds (not their completion).
    fn single_flight(&self) -> &tokio::sync::Mutex<()>;
    fn discover(&self) -> impl Future<Output = Vec<HostCandidate>> + Send;
    /// Where the current generation's host lives; fixed for the process.
    fn current_endpoint(&self) -> String;
    fn current_client(&self) -> Option<PtyHostClient>;
    /// Snapshot of the registered frozen hosts.
    fn frozen_hosts(&self) -> Vec<FrozenHost>;
    fn next_frozen_id(&self) -> FrozenId;
    /// Connect to `candidate`. The current role also starts its host when none is
    /// running; a frozen host is only ever connected to. `frozen` carries the id
    /// and epoch the connection's callbacks must capture.
    fn connect(
        &self,
        candidate: &HostCandidate,
        role: HostRole,
        frozen: Option<(FrozenId, u64)>,
    ) -> impl Future<Output = Result<Opened, String>> + Send;
    /// Reserve what `channel`'s answered listing reports and settle the closes
    /// owed to it. `None` = the host never answered; nothing is changed.
    fn apply_listing(&self, channel: HostChannel, client: &PtyHostClient, sessions: Option<&[SessionMeta]>);
    /// Publish the current host's client. Refuses one whose connection already
    /// dropped during setup, which nothing would ever clear.
    fn publish_current(&self, client: &PtyHostClient) -> Result<(), String>;
    fn publish_frozen(&self, host: FrozenHost);
}

fn frozen_for<P: AdoptionPort>(port: &P, key: &str) -> Option<FrozenHost> {
    port.frozen_hosts().into_iter().find(|h| barrier_key(&h.endpoint) == key)
}

/// Keys of the hosts we hold a connection to.
fn connected_keys<P: AdoptionPort>(port: &P) -> Vec<String> {
    let current = port.current_client().map(|_| barrier_key(&port.current_endpoint()));
    current
        .into_iter()
        .chain(port.frozen_hosts().iter().map(|h| barrier_key(&h.endpoint)))
        .collect()
}

/// Ask the host to hold nothing against us, then list what it has. The lifecycle
/// frame goes first so that a host whose absence clock is about to expire is
/// revoked before a slow listing is waited on. `None` = never answered.
async fn settle(client: &PtyHostClient, deadline: Instant) -> Option<Vec<SessionMeta>> {
    let work = async {
        if !client.disarm().await {
            log::warn!("[GEN] host did not acknowledge the disarm");
        }
        for attempt in 0..LIST_ATTEMPTS {
            if let Ok(Some(sessions)) = tokio::time::timeout(LIST_ATTEMPT_TIMEOUT, client.list_sessions()).await {
                return Some(sessions);
            }
            if !client.is_alive() {
                return None;
            }
            if attempt + 1 < LIST_ATTEMPTS {
                tokio::time::sleep(LIST_RETRY_PAUSE).await;
            }
        }
        None
    };
    tokio::time::timeout_at(deadline, work).await.unwrap_or(None)
}

const CONNECTION_LOST: &str = "connection lost during setup";

fn resolution_of(listing: &Option<Vec<SessionMeta>>) -> Resolution {
    match listing {
        Some(_) => Resolution::Resolved,
        None => Resolution::Unresolved("the host did not answer ListSessions".into()),
    }
}

/// Connect (or re-list) one host and publish it. The single implementation of
/// adopting a host, for both roles.
async fn adopt<P: AdoptionPort>(
    port: &P,
    candidate: &HostCandidate,
    role: HostRole,
    deadline: Instant,
) -> Result<Resolution, String> {
    // Held for the whole adoption so a quiesce waits for it; refused outright
    // once exit, offload or update has closed admission.
    let _ticket = port.table().begin_adoption().map_err(|busy| busy.to_string())?;
    let key = barrier_key(&candidate.endpoint);

    let existing = match role {
        HostRole::Current => port.current_client().map(|c| (HostChannel::Primary, c)),
        HostRole::Frozen => frozen_for(port, &key).map(|h| (HostChannel::Frozen(h.id), h.client)),
    };
    if let Some((channel, client)) = existing {
        // Already connected; only its listing is missing.
        let listing = settle(&client, deadline).await;
        port.apply_listing(channel, &client, listing.as_deref());
        return Ok(resolution_of(&listing));
    }

    let frozen = (role == HostRole::Frozen).then(|| (port.next_frozen_id(), port.table().reserve_epoch()));
    let opened = tokio::time::timeout_at(deadline, port.connect(candidate, role, frozen))
        .await
        .map_err(|_| "timed out connecting to the terminal host".to_string())??;
    let client = opened.client;
    let listing = settle(&client, deadline).await;
    match (role, frozen) {
        (HostRole::Frozen, Some((id, epoch))) => {
            let channel = HostChannel::Frozen(id);
            port.apply_listing(channel, &client, listing.as_deref());
            port.publish_frozen(FrozenHost {
                id,
                generation: candidate.generation.clone(),
                endpoint: candidate.endpoint.clone(),
                client: client.clone(),
                epoch,
                build_id: opened.build_id,
                advertised: candidate.mtime,
                exe_in_payload: client.exe_in_payload(),
            });
            port.table().publish(channel, epoch);
            // A drop that fired before the host was published was inert by
            // epoch; look once more, now that a later one would not be.
            if !client.is_alive() {
                frozen_connection_lost(port.table(), port.barrier(), id, epoch, &candidate.endpoint);
                return Err(CONNECTION_LOST.into());
            }
        }
        _ => {
            port.apply_listing(HostChannel::Primary, &client, listing.as_deref());
            port.publish_current(&client)?;
            port.table().publish(HostChannel::Primary, opened.epoch);
        }
    }
    Ok(resolution_of(&listing))
}

/// One attempt on one candidate, recorded in the barrier whatever happens.
async fn attempt<P: AdoptionPort>(
    port: P,
    candidate: HostCandidate,
    role: HostRole,
    deadline: Instant,
) -> Result<(), String> {
    let key = barrier_key(&candidate.endpoint);
    let outcome = adopt(&port, &candidate, role, deadline).await;
    match &outcome {
        Ok(resolution) => port.barrier().finish(&key, &candidate.endpoint, role, resolution.clone()),
        // Its own reconnect owns a dropped host from here; the barrier already
        // says so (`frozen_connection_lost`), and finishing would undo that.
        Err(reason) if reason == CONNECTION_LOST => {}
        Err(reason) if port.barrier().is_tracked(&key) => {
            port.barrier()
                .finish(&key, &candidate.endpoint, role, Resolution::Unresolved(reason.clone()))
        }
        Err(_) => port.barrier().abandon_attempt(&key),
    }
    outcome.map(|_| ())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Wait {
    /// Return once the current host has been dealt with; frozen hosts finish in
    /// the background. What a create needs.
    Current,
    /// Also wait for every frozen attempt. What a background sweep wants.
    All,
}

/// Make sure the current host is up and every surviving host has been tried.
///
/// Returns as soon as the current host is settled: a frozen host that is slow or
/// unreachable is left to finish on its own task (and show up as unresolved) and
/// is never waited on here. If the current host cannot be had, the frozen hosts
/// are awaited, since they are the fallback, and `Ok` means at least one host is
/// usable. A refusal because the app is exiting or updating is always an error
/// starting with `LIFECYCLE_BUSY`.
pub(super) async fn ensure_hosts<P: AdoptionPort>(port: &P) -> Result<(), String> {
    if port.current_client().is_some() && !port.barrier().needs_attempt() {
        return Ok(());
    }
    round(port, Wait::Current).await
}

/// Re-run adoption for candidates that were skipped, busy or unanswered, whether
/// or not the current host is up. For the router and the periodic sweep.
pub(super) async fn rediscover_hosts<P: AdoptionPort>(port: &P) -> Result<(), String> {
    round(port, Wait::All).await
}

async fn round<P: AdoptionPort>(port: &P, wait: Wait) -> Result<(), String> {
    let deadline = Instant::now() + ADOPTION_DEADLINE;
    let (current, background) = {
        let _start = port.single_flight().lock().await;
        if wait == Wait::Current && port.current_client().is_some() && !port.barrier().needs_attempt() {
            return Ok(());
        }
        let discovered = port.discover().await;
        port.barrier().sync(&discovered, &connected_keys(port));

        let mut current: Option<HostCandidate> = None;
        let mut frozen: Vec<(HostCandidate, HostRole)> = Vec::new();
        for candidate in discovered {
            let key = barrier_key(&candidate.endpoint);
            // Role is decided once per host; a rediscovery never re-classifies.
            let role = port.barrier().role_of(&key).unwrap_or(candidate.role);
            match role {
                HostRole::Current => current = Some(candidate),
                // Never owned, so never connected to.
                HostRole::Frozen if !candidate.compatible() => {}
                HostRole::Frozen => frozen.push((candidate, role)),
            }
        }
        // The current host may not exist yet: it is then started on its own endpoint.
        let current = current.unwrap_or_else(|| HostCandidate {
            generation: None,
            endpoint: port.current_endpoint(),
            record: None,
            record_path: None,
            pid: None,
            mtime: std::time::SystemTime::UNIX_EPOCH,
            role: HostRole::Current,
        });

        let mut background: Vec<JoinHandle<Result<(), String>>> = Vec::new();
        for (candidate, role) in frozen {
            let key = barrier_key(&candidate.endpoint);
            let connected = frozen_for(port, &key);
            let wanted = match &connected {
                None => true,
                Some(host) => host.client.is_alive() && port.barrier().needs_attempt_for(&key),
            };
            if wanted && port.barrier().begin_attempt(&key) {
                background.push(tokio::spawn(attempt(port.clone(), candidate, role, deadline)));
            }
        }

        // A current host that is not up is connected (or started) under the start
        // lock, so concurrent creates share one connect; the tasks above run beside
        // it. One that is up but never answered its listing is only re-listed, in
        // the background like the rest: a fresh tab does not wait for that.
        let key = barrier_key(&current.endpoint);
        let current_result = if port.current_client().is_none() {
            // Serialised by the start lock, so a stale re-list of the connection
            // that just dropped cannot make this skip the reconnect.
            port.barrier().begin_attempt(&key);
            Some(attempt(port.clone(), current, HostRole::Current, deadline).await)
        } else {
            if port.barrier().needs_attempt_for(&key) && port.barrier().begin_attempt(&key) {
                background.push(tokio::spawn(attempt(port.clone(), current, HostRole::Current, deadline)));
            }
            None
        };
        (current_result, background)
    };

    let current_failed = matches!(current, Some(Err(_)));
    if wait == Wait::All || current_failed {
        for task in background {
            if let Err(e) = task.await {
                log::error!("[GEN] host adoption task failed: {e}");
            }
        }
    }
    match current {
        Some(Err(e)) if e.starts_with(LIFECYCLE_BUSY) => Err(e),
        Some(Err(e)) if port.current_client().is_none() && port.frozen_hosts().is_empty() => Err(e),
        Some(Err(e)) => {
            log::warn!("[GEN] the current terminal host is unavailable ({e}); older hosts remain usable");
            Ok(())
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod fake_hosts;
#[cfg(test)]
mod adoption_tests;
#[cfg(test)]
mod routing_tests;
