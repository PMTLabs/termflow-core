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

use super::host_table::{Admission, HostTable, QuiesceReason, LIFECYCLE_BUSY};
use super::types::FrozenHost;
use crate::elevated_host::{FrozenId, HostChannel};
use crate::pty_host_client::{HostCandidate, HostRole, PtyHostClient};
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use crate::pty_host_client::SessionListing;
#[cfg(test)]
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
    /// An attempt is in flight for this host, or its connection dropped after it
    /// was adopted. Either way no discovery round starts another attempt on it,
    /// so nothing else may assume a retry is coming. A dropped connection is
    /// settled by that one host's reconnect, never by a discovery round.
    retry_pending: bool,
    /// A reconnect of this host is running. At most one is, whoever asks.
    reconnecting: bool,
    /// Someone asked for a reconnect while one was running: the connection it was
    /// about to replace is not the one that dropped last.
    reconnect_again: bool,
    /// The host was retired: it is being shut down on purpose and must not be
    /// adopted again while its process is still discoverable. Whatever else is
    /// recorded about it (an outcome, a `forget`), the mark stays until `sync`
    /// finds the host gone.
    retired: bool,
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
                        reconnecting: false,
                        reconnect_again: false,
                        retired: false,
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
                // A retired host's answer is moot: nothing waits for it.
                Some(entry) if entry.retired => {}
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
                    reconnecting: false,
                    reconnect_again: false,
                    retired: false,
                }),
            }
        }
        self.notify();
    }

    /// Stop tracking a host that cannot be connected to at all, so it no longer
    /// holds the panes that wait for the hosts to answer. A later discovery that
    /// still finds its endpoint tracks it again and finds it gone again.
    pub fn forget(&self, key: &str) {
        self.lock().retain(|e| e.key != key || e.retired);
        self.notify();
    }

    /// The host was retired. It no longer holds anything a pane could wait for,
    /// and no round adopts it again; the mark goes once the host's process is no
    /// longer discovered (`sync`).
    pub fn mark_retired(&self, key: &str, endpoint: &str) {
        {
            let mut entries = self.lock();
            match entries.iter_mut().find(|e| e.key == key) {
                Some(entry) => {
                    entry.resolution = Resolution::Resolved;
                    entry.retry_pending = false;
                    entry.retired = true;
                }
                None => entries.push(Entry {
                    key: key.to_owned(),
                    endpoint: endpoint.to_owned(),
                    role: HostRole::Frozen,
                    resolution: Resolution::Resolved,
                    retry_pending: false,
                    reconnecting: false,
                    reconnect_again: false,
                    retired: true,
                }),
            }
        }
        self.notify();
    }

    pub fn is_retired(&self, key: &str) -> bool {
        self.lock().iter().any(|e| e.key == key && e.retired)
    }

    /// An attempt on a host that was never tracked failed: there is nothing to
    /// record, because no host process was found behind it.
    pub fn abandon_attempt(&self, key: &str) {
        if let Some(entry) = self.lock().iter_mut().find(|e| e.key == key) {
            entry.retry_pending = false;
        }
        self.notify();
    }

    /// The connection to a resolved host dropped: what it holds is unknown again.
    /// A rediscovery does not retry it (`retry_pending` stays set): the host's own
    /// reconnect does, and until that settles it the host keeps holding every pane
    /// that waits for the hosts to answer.
    pub fn mark_lost(&self, key: &str, reason: &str) {
        if let Some(entry) = self.lock().iter_mut().find(|e| e.key == key) {
            entry.resolution = Resolution::Unresolved(reason.to_owned());
            entry.retry_pending = true;
        }
        self.notify();
    }

    /// Claim the right to reconnect `key`. `None` when a reconnect of it is
    /// already running; that one is told (see [`ReconnectGuard::rerun`]) that
    /// another was asked for. The claim is released when the guard is dropped.
    pub fn begin_reconnect(&self, key: &str) -> Option<ReconnectGuard<'_>> {
        if let Some(entry) = self.lock().iter_mut().find(|e| e.key == key) {
            if entry.reconnecting {
                entry.reconnect_again = true;
                return None;
            }
            entry.reconnecting = true;
            entry.reconnect_again = false;
        }
        Some(ReconnectGuard { barrier: self, key: key.to_owned(), released: false })
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

/// Releases a host's reconnect claim, however the reconnect ends.
pub struct ReconnectGuard<'a> {
    barrier: &'a Barrier,
    key: String,
    released: bool,
}

impl ReconnectGuard<'_> {
    /// Was a reconnect asked for while this one ran? If so the claim is kept and
    /// the caller must run again; if not the claim is released here, in the same
    /// step, so a request cannot slip in between the answer and the release.
    pub fn rerun(&mut self) -> bool {
        let mut entries = self.barrier.lock();
        let Some(entry) = entries.iter_mut().find(|e| e.key == self.key) else { return false };
        if std::mem::take(&mut entry.reconnect_again) {
            return true;
        }
        entry.reconnecting = false;
        self.released = true;
        false
    }
}

impl Drop for ReconnectGuard<'_> {
    fn drop(&mut self) {
        if self.released {
            return;
        }
        if let Some(entry) = self.barrier.lock().iter_mut().find(|e| e.key == self.key) {
            entry.reconnecting = false;
            entry.reconnect_again = false;
        }
    }
}

/// A frozen host's connection dropped. Only the connection currently published
/// for the host may act on it: a callback from a superseded connection is inert,
/// and so is one from a host that has been retired. Returns whether it acted.
pub(super) fn frozen_connection_lost(
    table: &HostTable,
    barrier: &Barrier,
    id: FrozenId,
    epoch: u64,
    endpoint: &str,
) -> bool {
    let channel = HostChannel::Frozen(id);
    if !table.is_current(channel, epoch) || table.admission(channel) == Some(Admission::Retired) {
        return false;
    }
    table.routes().remove_channel(channel);
    barrier.mark_lost(&barrier_key(endpoint), "connection lost");
    true
}

// ---- the port -------------------------------------------------------------

/// Why a host could not be connected to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ConnectFailure {
    pub reason: String,
    /// Nothing listens on the endpoint at all (connection refused, no such socket
    /// file or pipe), as opposed to a host that is busy or slow to answer.
    pub endpoint_gone: bool,
}

impl From<String> for ConnectFailure {
    fn from(reason: String) -> Self {
        Self { reason, endpoint_gone: false }
    }
}

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
    ) -> impl Future<Output = Result<Opened, ConnectFailure>> + Send;
    /// Reserve what `channel`'s answered listing reports and settle the closes
    /// owed to it. `None` = the host never answered; nothing is changed.
    fn apply_listing(&self, channel: HostChannel, client: &PtyHostClient, sessions: Option<&SessionListing>);
    /// Publish the current host's client. Refuses one whose connection already
    /// dropped during setup, which nothing would ever clear.
    fn publish_current(&self, client: &PtyHostClient) -> Result<(), String>;
    fn publish_frozen(&self, host: FrozenHost);
    /// A frozen host was adopted and published (or reconnected under the same
    /// id): the moment to start watching it for emptiness.
    fn frozen_adopted(&self, _id: FrozenId) {}
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
async fn settle(client: &PtyHostClient, deadline: Instant) -> Option<SessionListing> {
    let work = async {
        if !client.disarm().await {
            log::warn!("[GEN] host did not acknowledge the disarm");
        }
        for attempt in 0..LIST_ATTEMPTS {
            if let Some(sessions) = client.list_sessions_numbered_within(LIST_ATTEMPT_TIMEOUT).await {
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

/// Validate an awaited answer before it can affect ownership or lifecycle state.
/// Retirement's final, read-only confirmation expects Draining; all ownership
/// mutations require Open admission.
pub(super) fn listing_is_current(
    table: &HostTable,
    channel: HostChannel,
    epoch: u64,
    client: &PtyHostClient,
    admission: Admission,
) -> bool {
    table.is_current(channel, epoch) && table.admission(channel) == Some(admission) && client.is_alive()
}

fn apply_validated_listing<P: AdoptionPort>(
    port: &P,
    channel: HostChannel,
    epoch: u64,
    client: &PtyHostClient,
    listing: Option<&SessionListing>,
) -> Result<(), Failure> {
    if !listing_is_current(port.table(), channel, epoch, client, Admission::Open) {
        return Err(Failure::Superseded);
    }
    port.apply_listing(channel, client, listing);
    Ok(())
}

const CONNECTION_LOST: &str = "connection lost during setup";

fn resolution_of(listing: &Option<SessionListing>) -> Resolution {
    match listing {
        Some(_) => Resolution::Resolved,
        None => Resolution::Unresolved("the host did not answer ListSessions".into()),
    }
}

/// What an adoption found out, and which connection it found it through.
struct Adopted {
    resolution: Resolution,
    channel: HostChannel,
    /// The connection the listing was asked of. If another one has been
    /// published for the host since, the answer is out of date.
    epoch: u64,
}

/// Connect (or re-list) one host and publish it. The single implementation of
/// adopting a host, for both roles. A frozen host that is already registered is
/// reconnected under its own id, so the panes that name it keep resolving.
async fn adopt<P: AdoptionPort>(
    port: &P,
    candidate: &HostCandidate,
    role: HostRole,
    deadline: Instant,
) -> Result<Adopted, Failure> {
    // Held for the whole adoption so a quiesce waits for it; refused outright
    // once exit, offload or update has closed admission.
    log::info!("[GEN] adopting {:?} terminal host {}", role, candidate.endpoint);
    let _ticket = port.table().begin_adoption().map_err(|busy| {
        log::info!("[GEN] adoption of {} refused: {busy}", candidate.endpoint);
        Failure::Other(busy.to_string())
    })?;
    let key = barrier_key(&candidate.endpoint);

    let registered = match role {
        HostRole::Current => None,
        HostRole::Frozen => frozen_for(port, &key),
    };
    let existing = match role {
        HostRole::Current => port.current_client().map(|c| (HostChannel::Primary, c)),
        HostRole::Frozen => registered
            .clone()
            .filter(|h| h.client.is_alive())
            .map(|h| (HostChannel::Frozen(h.id), h.client)),
    };
    if let Some((channel, client)) = existing {
        // Already connected; only its listing is missing.
        let epoch = port.table().epoch(channel).unwrap_or(0);
        let listing = settle(&client, deadline).await;
        apply_validated_listing(port, channel, epoch, &client, listing.as_ref())?;
        return Ok(Adopted { resolution: resolution_of(&listing), channel, epoch });
    }

    let frozen = (role == HostRole::Frozen).then(|| {
        let id = registered.map_or_else(|| port.next_frozen_id(), |h| h.id);
        (id, port.table().reserve_epoch())
    });
    let opened = tokio::time::timeout_at(deadline, port.connect(candidate, role, frozen))
        .await
        .map_err(|_| Failure::Other("timed out connecting to the terminal host".to_string()))?
        .map_err(|failure| match failure.endpoint_gone {
            true => Failure::EndpointGone(failure.reason),
            false => Failure::Other(failure.reason),
        })?;
    let client = opened.client;
    let channel = frozen.map_or(HostChannel::Primary, |(id, _)| HostChannel::Frozen(id));
    client.bind_sessions(port.table().keys(), channel, opened.epoch);
    let listing = settle(&client, deadline).await;
    let (channel, epoch) = match (role, frozen) {
        (HostRole::Frozen, Some((id, epoch))) => {
            let channel = HostChannel::Frozen(id);
            // Admission first, as for the current host below: a create that sees the
            // client must find a slot to take a ticket on. A host retired while it
            // was being reconnected must not be brought back by the connection.
            if !publish_admission(port, channel, epoch) {
                client.close_transport().await;
                return Err(Failure::Superseded);
            }
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
            // A drop that fired before the host was published was inert by
            // epoch; look once more, now that a later one would not be.
            if !client.is_alive() {
                frozen_connection_lost(port.table(), port.barrier(), id, epoch, &candidate.endpoint);
                return Err(Failure::ConnectionLost);
            }
            apply_validated_listing(port, channel, epoch, &client, listing.as_ref())?;
            port.frozen_adopted(id);
            (channel, epoch)
        }
        _ => {
            // Admission first: a create that sees the client must find a slot to
            // take a ticket on, or it would pass the host over.
            if !publish_admission(port, HostChannel::Primary, opened.epoch) {
                client.close_transport().await;
                return Err(Failure::Superseded);
            }
            port.publish_current(&client).map_err(Failure::Other)?;
            apply_validated_listing(port, HostChannel::Primary, opened.epoch, &client, listing.as_ref())?;
            (HostChannel::Primary, opened.epoch)
        }
    };
    Ok(Adopted { resolution: resolution_of(&listing), channel, epoch })
}

/// Open `channel` for admission on `epoch`. The table leaves a host that is
/// draining or retired as it is, and says so; an adoption must not do that
/// silently.
fn publish_admission<P: AdoptionPort>(port: &P, channel: HostChannel, epoch: u64) -> bool {
    if port.table().epoch(channel).is_some_and(|current| current > epoch) {
        return false;
    }
    let admitted = port.table().publish(channel, epoch);
    if !admitted {
        log::warn!("[GEN] {channel:?} is draining or retired; its connection was not opened for admission");
    }
    admitted
}

/// How an adoption ended without a listing.
enum Failure {
    /// The connection dropped after the host was adopted; the barrier already
    /// says so (`frozen_connection_lost`), and recording a failure would undo it.
    ConnectionLost,
    /// The connection or admission changed while its listing was awaited.
    Superseded,
    /// Nothing listens on the host's endpoint.
    EndpointGone(String),
    Other(String),
}

impl Failure {
    fn into_message(self) -> String {
        match self {
            Failure::ConnectionLost => CONNECTION_LOST.to_string(),
            Failure::Superseded => "the terminal host connection or admission changed".to_string(),
            Failure::EndpointGone(reason) | Failure::Other(reason) => reason,
        }
    }
}

/// Clears a host's in-flight mark if its attempt ends without recording an
/// outcome, a panic included: nothing else would ever clear it, and the host
/// would then never be tried again.
struct AttemptGuard<'a> {
    barrier: &'a Barrier,
    key: &'a str,
    recorded: bool,
}

impl Drop for AttemptGuard<'_> {
    fn drop(&mut self) {
        if !self.recorded {
            if std::thread::panicking() {
                log::error!("[GEN] the adoption attempt on {} panicked", self.key);
            }
            self.barrier.abandon_attempt(self.key);
        }
    }
}

/// One attempt on one candidate, recorded in the barrier whatever happens.
async fn attempt<P: AdoptionPort>(
    port: P,
    candidate: HostCandidate,
    role: HostRole,
    deadline: Instant,
) -> Result<(), String> {
    let key = barrier_key(&candidate.endpoint);
    let mut guard = AttemptGuard { barrier: port.barrier(), key: &key, recorded: false };
    let outcome = adopt(&port, &candidate, role, deadline).await;
    match &outcome {
        // The host was reconnected while this listing was in flight: the newer
        // connection recorded its own answer, which this older one must not undo.
        Ok(done) if !port.table().is_current(done.channel, done.epoch) => {
            log::info!("[GEN] discarding a listing of {} from a superseded connection", candidate.endpoint);
        }
        Ok(done) => port.barrier().finish(&key, &candidate.endpoint, role, done.resolution.clone()),
        // A dropped connection is left as the drop callback recorded it.
        Err(Failure::ConnectionLost) => {}
        // Discovery found this endpoint without any process behind it (an old
        // socket file, a pipe that vanished): nothing holds sessions there, so it
        // must not keep a restoring pane waiting. A host whose process is known to
        // be alive stays unresolved: it may just not be listening yet.
        Err(Failure::EndpointGone(reason)) if role == HostRole::Frozen && candidate.pid.is_none() => {
            log::info!("[GEN] nothing answers on {} ({reason}); dropping it", candidate.endpoint);
            port.barrier().forget(&key);
        }
        Err(Failure::EndpointGone(reason) | Failure::Other(reason)) if port.barrier().is_tracked(&key) => {
            port.barrier()
                .finish(&key, &candidate.endpoint, role, Resolution::Unresolved(reason.clone()))
        }
        Err(_) => port.barrier().abandon_attempt(&key),
    }
    guard.recorded = true;
    outcome.map(|_| ()).map_err(Failure::into_message)
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

/// Wait until admission is open again. `false` when it will never reopen because
/// the app is exiting.
///
/// For the backend operations that take a ticket (a reconnect among them): being
/// refused because of an exit, offload or update is no verdict on the host, so it
/// is neither retried against a backoff nor taken as the host being gone.
pub(super) async fn wait_for_reopen(table: &HostTable) -> bool {
    const POLL: Duration = Duration::from_millis(500);
    loop {
        match table.lifecycle_reason() {
            None => return true,
            Some(QuiesceReason::Exit) => return false,
            Some(_) => tokio::time::sleep(POLL).await,
        }
    }
}

/// Get the current host connected again after its connection dropped, waiting
/// `backoff_ms[i]` milliseconds after attempt `i` fails. Whether the current host
/// is back is asked of the published client, not of `ensure_hosts`: that also
/// succeeds when only an older host is usable, which is no help to the panes
/// that were on the current one.
///
/// An attempt refused because admission is closed (`LIFECYCLE_BUSY`) waits for it
/// to reopen and does not use up a backoff step; `false` then means the app is
/// exiting, not that the host could not be had.
pub(super) async fn reconnect_current<P: AdoptionPort>(port: &P, backoff_ms: &[u64]) -> bool {
    let mut step = 0;
    while step < backoff_ms.len() {
        let ms = backoff_ms[step];
        // A concurrent create may already have reconnected; otherwise try here.
        if port.current_client().is_some() {
            return true;
        }
        match ensure_hosts(port).await {
            Ok(()) if port.current_client().is_some() => return true,
            Err(e) if e.starts_with(LIFECYCLE_BUSY) => {
                if !wait_for_reopen(port.table()).await {
                    return false;
                }
                continue;
            }
            _ => {}
        }
        log::warn!(
            "[HOTSWAP] reconnect attempt {}/{} failed; retrying in {ms}ms",
            step + 1,
            backoff_ms.len()
        );
        tokio::time::sleep(Duration::from_millis(ms)).await;
        step += 1;
    }
    false
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
                // Retired on purpose and on its way out.
                HostRole::Frozen if port.barrier().is_retired(&key) => {}
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
            // A registered host whose connection is down is not retried here: its own
            // reconnect (`reconnect_frozen`) does that, one host at a time.
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

mod panes;
mod reconnect;
mod sweep;

#[cfg(all(test, feature = "integration-tests"))]
pub(super) use panes::surface_orphans;
pub(super) use panes::PanePort;
pub(super) use reconnect::{reconnect_frozen, reconnect_primary, RECONNECT_BACKOFF_MS};
pub(super) use sweep::sweep;

#[cfg(test)]
mod fake_hosts;
#[cfg(test)]
mod fake_hosts_gate_tests;
#[cfg(test)]
pub(crate) mod wiring_tests;
#[cfg(test)]
mod adoption_tests;
#[cfg(test)]
mod live_tests;
#[cfg(test)]
mod reconnect_tests;
#[cfg(test)]
mod sweep_tests;
#[cfg(test)]
mod routing_tests;
#[cfg(test)]
mod incarnation_tests;
#[cfg(test)]
mod key_lifecycle_tests;
#[cfg(test)]
mod owner_tests;
#[cfg(test)]
mod retire_tests;
#[cfg(test)]
mod retire_real_tests;
// The lifecycle tests drive the same fake hosts through `host_lifecycle`.
#[cfg(test)]
mod lifecycle_tests;
#[cfg(test)]
mod update_full_tests;
