//! What exit, offload, an update and a sibling's update do to the pty-hosts.
//!
//! An instance can own several hosts at once: the current generation's, any
//! older one that survived an update, and one it knows exists but has not
//! connected to yet. Every lifecycle change has to treat all of them alike, or
//! the shells of the one that was forgotten are lost (on exit: left running with
//! no window; on offload or update: killed with the old app).
//!
//! The *owned set* is every host this instance holds a registration for,
//! connected or not, every compatible host the adoption barrier is still waiting
//! for, and the current host. A host with no shared protocol is never part of it.
//!
//! All of it runs against [`LifecyclePort`], which `AppState` implements, so the
//! ordering and timing rules are testable over fake hosts without a Tauri
//! `AppHandle`.

use super::host_adoption::{barrier_key, AdoptionPort};
use super::host_connect::connect_existing;
use super::host_table::{Admission, Busy, HostTable, QuiesceGuard, QuiesceReason, LIFECYCLE_BUSY};
use super::types::{AppState, FrozenHost};
use super::update_survival::{describe_reasons, effective_mode, FullReason, HostOrigin, UpdateMode};
use crate::elevated_host::HostChannel;
use crate::pty_host_client::{HostCandidate, HostRetention, HostRole, PtyHostClient, PtyHostDeps};
use futures::future::join_all;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::Runtime;
use termflow_pty_protocol::ArmDetachPurpose;
use tokio::time::Instant;

/// How long an exit waits for operations in flight before it goes ahead anyway:
/// a quit must not hang on a create that is stuck behind a wedged host.
pub(super) const EXIT_QUIESCE_BOUND: Duration = Duration::from_secs(5);
/// How long an offload or update waits for the same operations before it gives
/// up and refuses. Longer than exit's: a spawn can legitimately take ~10 s.
pub(super) const HOLD_QUIESCE_BOUND: Duration = Duration::from_secs(12);
/// How long a sibling's arm request waits for the same operations. The instance
/// that asked gives up after `SIBLING_CALL_TIMEOUT_SECS`, so the answer, a named
/// refusal, has to come well inside that: an arm that finishes after its caller
/// left would hold admission closed for a window nobody will release.
pub(super) const SIBLING_QUIESCE_BOUND: Duration = Duration::from_secs(3);
const _: () = assert!(SIBLING_QUIESCE_BOUND.as_secs() + 1 < crate::sibling_coord::SIBLING_CALL_TIMEOUT_SECS);
/// One attempt, connect and announcement included, to reach a host exit holds no
/// connection to. Closing the stream afterwards has its own bound
/// (`PtyHostClient::close_transport`), so an attempt can take a little longer.
pub(super) const EXIT_REACH_BOUND: Duration = Duration::from_secs(3);

const NOT_CONNECTED: &str = "pty-host not connected — nothing to keep alive";

/// What the lifecycle code needs from the application beyond adoption.
pub(super) trait LifecyclePort: AdoptionPort {
    /// A bare connection to a host that exit holds none to, to tell it to stop. It
    /// must not start a host and must not publish anything: the host is not being
    /// adopted, it is being released.
    fn connect_for_exit(&self, candidate: &HostCandidate) -> impl Future<Output = Result<PtyHostClient, String>> + Send;
    /// The credential an arm is authenticated with.
    fn arm_token(&self) -> String;
    /// Whether the host behind `client` runs from inside the install root.
    fn exe_origin(&self, _endpoint: &str, client: &PtyHostClient) -> Option<bool> {
        client.exe_in_payload()
    }
    /// Where the hold a sibling's arm request took is kept until its disarm.
    fn sibling_slot(&self) -> &SiblingSlot;
}

// ---- the owned set --------------------------------------------------------

/// One host this instance is responsible for.
#[derive(Clone)]
pub struct OwnedHost {
    pub endpoint: String,
    pub generation: Option<String>,
    /// Set while the host is registered: the current host or an older one.
    pub channel: Option<HostChannel>,
    /// The connection, only while it is alive.
    pub client: Option<PtyHostClient>,
    /// Why what the host holds is not known yet, while the barrier waits for it.
    pub unresolved: Option<String>,
    /// `Some(true)` = inside the install root, `None` = could not be determined.
    pub exe_in_payload: Option<bool>,
    /// How to reach it when no connection is held.
    pub candidate: HostCandidate,
}

impl OwnedHost {
    /// How logs and refusals name the host.
    pub fn name(&self) -> String {
        match &self.generation {
            Some(generation) => format!("terminal host {} (generation {generation})", self.endpoint),
            None => format!("terminal host {}", self.endpoint),
        }
    }

    pub fn connected(&self) -> bool {
        self.client.is_some()
    }
}

fn candidate_for(endpoint: &str, generation: Option<String>, role: HostRole) -> HostCandidate {
    HostCandidate {
        generation,
        endpoint: endpoint.to_owned(),
        record: None,
        record_path: None,
        pid: None,
        mtime: std::time::SystemTime::UNIX_EPOCH,
        role,
    }
}

fn frozen_candidate(host: &FrozenHost) -> HostCandidate {
    HostCandidate { mtime: host.advertised, ..candidate_for(&host.endpoint, host.generation.clone(), HostRole::Frozen) }
}

/// The owned set from what is already known plus `discovered`. With nothing
/// discovered it is only as current as the last discovery round.
fn collect<P: LifecyclePort>(port: &P, discovered: &[HostCandidate]) -> Vec<OwnedHost> {
    let unresolved = port.barrier().unresolved();
    let reason_of = |endpoint: &str| {
        unresolved
            .iter()
            .find(|u| barrier_key(&u.endpoint) == barrier_key(endpoint))
            .map(|u| u.reason.clone())
    };
    // A host with no shared protocol is never owned, wherever it sits: the current
    // endpoint is shared across versions when the generation gate is off.
    let found = |endpoint: &str| {
        discovered
            .iter()
            .find(|c| c.compatible() && barrier_key(&c.endpoint) == barrier_key(endpoint))
            .cloned()
    };
    let mut hosts: Vec<OwnedHost> = Vec::new();

    // The current host: owned while connected, and also while its connection is
    // down but the host is still there to be reconnected to.
    let current_endpoint = port.current_endpoint();
    let current = port.current_client();
    let known = port.barrier().is_tracked(&barrier_key(&current_endpoint)) || found(&current_endpoint).is_some();
    if current.is_some() || known {
        let candidate = found(&current_endpoint)
            .unwrap_or_else(|| candidate_for(&current_endpoint, None, HostRole::Current));
        hosts.push(OwnedHost {
            endpoint: current_endpoint.clone(),
            generation: candidate.generation.clone(),
            channel: Some(HostChannel::Primary),
            exe_in_payload: current.as_ref().and_then(|c| port.exe_origin(&current_endpoint, c)),
            client: current.filter(PtyHostClient::is_alive),
            unresolved: reason_of(&current_endpoint),
            candidate,
        });
    }

    for host in port.frozen_hosts() {
        let channel = HostChannel::Frozen(host.id);
        if port.table().admission(channel) == Some(Admission::Retired) {
            continue;
        }
        hosts.push(OwnedHost {
            endpoint: host.endpoint.clone(),
            generation: host.generation.clone(),
            channel: Some(channel),
            exe_in_payload: port.exe_origin(&host.endpoint, &host.client),
            client: host.client.is_alive().then(|| host.client.clone()),
            unresolved: reason_of(&host.endpoint),
            candidate: found(&host.endpoint).unwrap_or_else(|| frozen_candidate(&host)),
        });
    }

    // Hosts the barrier is waiting for that were never connected: a busy host
    // an earlier offload left armed is exactly this.
    for waiting in &unresolved {
        let key = barrier_key(&waiting.endpoint);
        if hosts.iter().any(|h| barrier_key(&h.endpoint) == key) {
            continue;
        }
        let role = port.barrier().role_of(&key).unwrap_or(HostRole::Frozen);
        let candidate = found(&waiting.endpoint).unwrap_or_else(|| candidate_for(&waiting.endpoint, None, role));
        hosts.push(OwnedHost {
            endpoint: waiting.endpoint.clone(),
            generation: candidate.generation.clone(),
            channel: None,
            client: None,
            unresolved: Some(waiting.reason.clone()),
            exe_in_payload: None,
            candidate,
        });
    }
    hosts
}

/// The owned set without discovering anything.
pub(super) fn owned_hosts_now<P: LifecyclePort>(port: &P) -> Vec<OwnedHost> {
    collect(port, &[])
}

/// The owned set after looking for surviving hosts again, so that a host this
/// instance has not met yet (and may have armed in an earlier run) is part of it.
pub(super) async fn owned_hosts<P: LifecyclePort>(port: &P) -> Vec<OwnedHost> {
    let discovered = port.discover().await;
    let connected: Vec<String> = port
        .current_client()
        .map(|_| barrier_key(&port.current_endpoint()))
        .into_iter()
        .chain(port.frozen_hosts().iter().map(|h| barrier_key(&h.endpoint)))
        .collect();
    port.barrier().sync(&discovered, &connected);
    collect(port, &discovered)
}

fn names(hosts: &[&OwnedHost]) -> String {
    hosts.iter().map(|h| h.name()).collect::<Vec<_>>().join(", ")
}

// ---- verdicts -------------------------------------------------------------

/// Hosts nothing can be asked of, because no connection to them is held.
fn disconnected_refusal(hosts: &[OwnedHost]) -> Option<String> {
    let gone: Vec<&OwnedHost> = hosts.iter().filter(|h| !h.connected()).collect();
    if gone.is_empty() {
        return None;
    }
    Some(format!(
        "pty-host not connected — {} cannot be reached, so its terminals cannot be kept alive",
        names(&gone)
    ))
}

/// Hosts whose terminals are not known yet.
pub(super) fn unresolved_refusal(hosts: &[OwnedHost]) -> Option<String> {
    let waiting: Vec<&OwnedHost> = hosts.iter().filter(|h| h.unresolved.is_some()).collect();
    if waiting.is_empty() {
        return None;
    }
    Some(format!(
        "{} has not reported its terminals yet; try again in a moment",
        names(&waiting)
    ))
}

/// Could every owned host keep its shells alive if this instance went away armed?
/// The message names each host that cannot.
pub fn offload_refusal(hosts: &[OwnedHost]) -> Result<(), String> {
    if hosts.is_empty() {
        return Err(NOT_CONNECTED.to_string());
    }
    if let Some(reason) = disconnected_refusal(hosts).or_else(|| unresolved_refusal(hosts)) {
        return Err(reason);
    }
    hotswap_refusal(hosts)
}

/// Hosts that cannot outlive this process: one that could not break away from a
/// kill-on-close job dies with the app, armed or not.
fn hotswap_refusal(hosts: &[OwnedHost]) -> Result<(), String> {
    let bound: Vec<&OwnedHost> =
        hosts.iter().filter(|h| h.client.as_ref().is_some_and(|c| !c.survives_hotswap())).collect();
    if bound.is_empty() {
        return Ok(());
    }
    Err(format!(
        "hot-swap unavailable: the sidecar could not break away from a kill-on-close job ({})",
        names(&bound)
    ))
}

pub(super) fn origins(hosts: &[OwnedHost]) -> Vec<HostOrigin> {
    hosts.iter().map(|h| HostOrigin { name: h.name(), exe_in_payload: h.exe_in_payload }).collect()
}

/// The mode an update would have to run in, given where the hosts run from. The
/// release's own mode is not read yet and counts as offload.
pub(super) fn update_mode_of(hosts: &[OwnedHost]) -> (UpdateMode, Vec<FullReason>) {
    effective_mode(UpdateMode::Offload, &origins(hosts))
}

/// Refuse an update that would have to close terminals, naming why.
pub fn update_refusal(hosts: &[OwnedHost]) -> Result<(), String> {
    match update_mode_of(hosts) {
        (UpdateMode::Offload, _) => Ok(()),
        (UpdateMode::Full, reasons) => Err(format!(
            "cannot update while terminals are kept running: {}",
            describe_reasons(&reasons)
        )),
    }
}

/// The least a retention promise says across `hosts`: an unknown one beats
/// everything, then the shortest bounded one, and only if all are indefinite is
/// the answer indefinite. No host at all is unknown, never indefinite.
pub(super) fn worst_retention(retentions: impl IntoIterator<Item = HostRetention>) -> HostRetention {
    let mut any = false;
    let mut worst = HostRetention::Indefinite;
    for retention in retentions {
        any = true;
        worst = match (worst, retention) {
            (HostRetention::Unknown, _) | (_, HostRetention::Unknown) => HostRetention::Unknown,
            (HostRetention::Bounded { active_secs: a }, HostRetention::Bounded { active_secs: b }) => {
                HostRetention::Bounded { active_secs: a.min(b) }
            }
            (bounded @ HostRetention::Bounded { .. }, HostRetention::Indefinite)
            | (HostRetention::Indefinite, bounded @ HostRetention::Bounded { .. }) => bounded,
            (HostRetention::Indefinite, HostRetention::Indefinite) => HostRetention::Indefinite,
        };
    }
    if any { worst } else { HostRetention::Unknown }
}

/// What the connected hosts promise, worst of all of them. A host that is owned
/// but not connected promises nothing we know of.
pub(super) fn connected_retention<P: LifecyclePort>(port: &P) -> HostRetention {
    worst_retention(owned_hosts_now(port).iter().map(|h| {
        h.client.as_ref().map_or(HostRetention::Unknown, PtyHostClient::host_retention)
    }))
}

// ---- arming ---------------------------------------------------------------

type Named = (String, PtyHostClient);

async fn disarm_hosts(hosts: &[Named]) -> bool {
    let acked = join_all(hosts.iter().map(|(name, client)| async move {
        let acknowledged = client.disarm().await;
        if !acknowledged {
            log::error!("[HOTSWAP] {name} never acknowledged the disarm; it may keep holding its detach window");
        }
        acknowledged
    }))
    .await;
    acked.into_iter().all(|ok| ok)
}

/// Arm every host, or none. The hosts are asked together; if any refuses, every
/// host that was asked is disarmed again, the refusing one included, because an
/// arm whose acknowledgement was lost may still have taken effect.
async fn arm_hosts(
    hosts: &[Named],
    timeout_secs: u64,
    token: &str,
    purpose: Option<ArmDetachPurpose>,
) -> Result<(), String> {
    let results = join_all(hosts.iter().map(|(name, client)| async move {
        (name, client.arm_detach(timeout_secs, token, purpose).await)
    }))
    .await;
    let failed: Vec<String> =
        results.iter().filter_map(|(name, result)| result.as_ref().err().map(|e| format!("{name}: {e}"))).collect();
    if failed.is_empty() {
        return Ok(());
    }
    log::warn!("[HOTSWAP] could not arm every host ({}); releasing the others", failed.join("; "));
    disarm_hosts(hosts).await;
    Err(failed.join("; "))
}

fn named_clients(hosts: &[OwnedHost]) -> Result<Vec<Named>, String> {
    hosts
        .iter()
        .map(|h| h.client.clone().map(|c| (h.name(), c)).ok_or_else(|| format!("{} is not connected", h.name())))
        .collect()
}

/// Admission to the hosts is closed and the hosts it will arm have been checked:
/// every owned host for an offload or update, only the current host and the
/// connected ones for a relaunch (see [`begin_relaunch`]). Dropping it reopens
/// admission; `commit` keeps it closed for the rest of the process. A hold
/// dropped while hosts are armed, or while an arm is still in flight, disarms
/// every host it asked first: admission is not reopened over a host nobody will
/// release.
pub struct Hold {
    /// Taken by `commit` (forgotten) and by `Drop` (kept until the disarm is done).
    guard: Option<QuiesceGuard>,
    table: HostTable,
    hosts: Vec<OwnedHost>,
    /// Hosts in `hosts` that may fail to arm without failing the hold.
    tolerated: Vec<String>,
    armed: Vec<Named>,
}

impl Hold {
    /// The hosts this hold looked at when it closed admission.
    pub fn hosts(&self) -> &[OwnedHost] {
        &self.hosts
    }

    /// The mode an update would have to run in, given where the hosts run from.
    pub fn update_mode(&self) -> (UpdateMode, Vec<FullReason>) {
        update_mode_of(&self.hosts)
    }

    /// Refuse an update that would have to close terminals.
    pub fn update_refusal(&self) -> Result<(), String> {
        update_refusal(&self.hosts)
    }

    /// Arm every owned host, or none: if one refuses, those already armed are
    /// disarmed before the error is returned. A relaunch hold is the exception:
    /// only the current host must arm, and any other host that will not is
    /// released again and left out while the rest stay armed.
    ///
    /// Exit may take the table over from this hold at any moment, and a host that
    /// is armed when it is shut down holds its shells for the whole arm window
    /// (armed wins over the shutdown). So the arm is registered as an operation in
    /// flight, which exit waits for, and is refused, or undone before it returns,
    /// when exit is in force: exit's disarm and shutdown always come after any arm.
    pub async fn arm_detach(
        &mut self,
        timeout_secs: u64,
        token: &str,
        purpose: Option<ArmDetachPurpose>,
    ) -> Result<(), String> {
        let named = named_clients(&self.hosts)?;
        let guard = self.guard.as_ref().expect("a hold keeps its guard until it ends");
        let _in_flight = self.table.begin_as_quiescer(guard);
        refuse_if_exiting(&self.table)?;
        // Every host is asked below, and an arm whose acknowledgement is still
        // pending may land: a hold dropped now (its caller gave up) must disarm all
        // of them. The failure paths below disarm for themselves and put back what
        // an earlier arm left.
        let previous = std::mem::replace(&mut self.armed, named.clone());
        let (optional, required): (Vec<Named>, Vec<Named>) =
            named.into_iter().partition(|(name, _)| self.tolerated.contains(name));
        if let Err(e) = arm_hosts(&required, timeout_secs, token, purpose).await {
            self.armed = previous;
            return Err(e);
        }
        let mut armed = required;
        // Each of the others stands on its own: one that will not arm is released
        // again and left out, and the rest stay armed.
        let results = join_all(optional.iter().map(|host| async move {
            arm_hosts(std::slice::from_ref(host), timeout_secs, token, purpose).await
        }))
        .await;
        for (host, result) in optional.into_iter().zip(results) {
            match result {
                Ok(()) => armed.push(host),
                Err(e) => log::warn!("[HOTSWAP] continuing without arming every host: {e}"),
            }
        }
        if let Err(exiting) = refuse_if_exiting(&self.table) {
            disarm_hosts(&armed).await;
            self.armed = previous;
            return Err(exiting);
        }
        self.armed = armed;
        Ok(())
    }

    /// The offload or update will not happen: put the hosts back as they were and
    /// reopen admission. True when every host acknowledged the disarm.
    pub async fn release(mut self) -> bool {
        let armed = std::mem::take(&mut self.armed);
        armed.is_empty() || disarm_hosts(&armed).await
    }

    /// The process is about to exit armed. Admission stays closed until it does:
    /// reopening it would let a terminal be created on a host nobody will release.
    pub fn commit(mut self) {
        self.armed.clear();
        // Dropping the guard is what reopens the table.
        if let Some(guard) = self.guard.take() {
            std::mem::forget(guard);
        }
    }
}

impl Drop for Hold {
    fn drop(&mut self) {
        if self.armed.is_empty() {
            return;
        }
        log::error!("[HOTSWAP] a hold was dropped while hosts were still armed; disarming them");
        let armed = std::mem::take(&mut self.armed);
        let guard = self.guard.take();
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                runtime.spawn(async move {
                    disarm_hosts(&armed).await;
                    drop(guard);
                });
            }
            Err(_) => log::error!("[HOTSWAP] no runtime to disarm on; the hosts keep their detach window"),
        }
    }
}

/// An arm must not go ahead once exit is in force.
fn refuse_if_exiting(table: &HostTable) -> Result<(), String> {
    match table.lifecycle_reason() {
        Some(QuiesceReason::Exit) => Err(Busy::Lifecycle(QuiesceReason::Exit).to_string()),
        _ => Ok(()),
    }
}

/// Close admission and wait up to `bound` for the operations in flight. With
/// `strict` set, an operation still in flight at the bound refuses (admission
/// reopens); otherwise the caller goes ahead anyway, as exit does.
async fn close_admission<P: LifecyclePort>(
    port: &P,
    reason: QuiesceReason,
    bound: Duration,
    strict: bool,
) -> Result<QuiesceGuard, String> {
    let guard = port.table().quiesce(reason, bound).await.map_err(|busy| busy.to_string())?;
    if !guard.drained() {
        log::warn!("[GEN] {reason:?}: operations still in flight on {:?}", guard.holders());
        if strict {
            return Err(format!(
                "{LIFECYCLE_BUSY}: other terminal operations are still in progress; try again in a moment"
            ));
        }
    }
    Ok(guard)
}

/// Close admission for an offload or an update commit and check that every owned
/// host can be armed. Fails fast with `LIFECYCLE_BUSY` while another lifecycle
/// change is in force, and refuses (naming the host) when any owned host is
/// disconnected, has not reported its terminals, or cannot survive.
async fn begin_hold<P: LifecyclePort>(port: &P, reason: QuiesceReason) -> Result<Hold, String> {
    let guard = close_admission(port, reason, HOLD_QUIESCE_BOUND, true).await?;
    let hosts = owned_hosts(port).await;
    offload_refusal(&hosts)?;
    Ok(Hold { guard: Some(guard), table: port.table().clone(), hosts, tolerated: Vec::new(), armed: Vec::new() })
}

pub(super) async fn begin_offload<P: LifecyclePort>(port: &P) -> Result<Hold, String> {
    begin_hold(port, QuiesceReason::Offload).await
}

pub(super) async fn begin_update<P: LifecyclePort>(port: &P) -> Result<Hold, String> {
    begin_hold(port, QuiesceReason::Update).await
}

/// Close admission for an update that closes every terminal. Nothing is armed,
/// so no host has to be reachable, resolved or able to survive: the hold only
/// stops terminals being created while the owned set is looked at again, and
/// whoever holds it decides from [`Hold::hosts`] whether to go ahead. Fails fast
/// with `LIFECYCLE_BUSY` like [`begin_update`].
pub(super) async fn begin_full_update<P: LifecyclePort>(port: &P) -> Result<Hold, String> {
    let guard = close_admission(port, QuiesceReason::Update, HOLD_QUIESCE_BOUND, true).await?;
    let hosts = owned_hosts(port).await;
    Ok(Hold { guard: Some(guard), table: port.table().clone(), hosts, tolerated: Vec::new(), armed: Vec::new() })
}

/// Close admission to restart this process while the hosts keep every terminal
/// alive (recovery from a dead webview, the tray's restart). That restart is the
/// only way out of a hollow process, so it is not held up by a host that cannot
/// be reached: it needs the current host, and arms every other host it is
/// connected to without failing when one of those will not arm. A host it holds
/// no connection to is left as it is, exactly as if the GUI had crashed. An
/// operation still in flight at the bound does not stop it either.
pub(super) async fn begin_relaunch<P: LifecyclePort>(port: &P) -> Result<Hold, String> {
    let guard = close_admission(port, QuiesceReason::Offload, HOLD_QUIESCE_BOUND, false).await?;
    let owned = owned_hosts_now(port);
    let Some(primary) = owned.iter().find(|h| h.channel == Some(HostChannel::Primary) && h.connected()) else {
        return Err(NOT_CONNECTED.to_string());
    };
    hotswap_refusal(std::slice::from_ref(primary))?;
    let (hosts, skipped): (Vec<OwnedHost>, Vec<OwnedHost>) = owned.into_iter().partition(OwnedHost::connected);
    for host in &skipped {
        log::warn!("[RECOVERY] {} is not connected; leaving it as it is", host.name());
    }
    let tolerated = hosts.iter().filter(|h| h.channel != Some(HostChannel::Primary)).map(OwnedHost::name).collect();
    Ok(Hold { guard: Some(guard), table: port.table().clone(), hosts, tolerated, armed: Vec::new() })
}

// ---- exit -----------------------------------------------------------------

/// What an exit did to each owned host.
#[derive(Debug, Default)]
pub struct ExitReport {
    /// Every operation in flight finished before the exit went ahead.
    pub drained: bool,
    pub hosts: Vec<HostExit>,
}

#[derive(Debug)]
pub struct HostExit {
    pub name: String,
    /// What went wrong, if the host was not released cleanly.
    pub problem: Option<String>,
}

impl ExitReport {
    pub fn problems(&self) -> impl Iterator<Item = &HostExit> {
        self.hosts.iter().filter(|h| h.problem.is_some())
    }
}

/// Does the host announce an exit (`Control::Shutdown`)? Only a record that
/// positively says it cannot is believed: announcing to a host that cannot hear
/// it costs one dropped frame, while not announcing to one that needs it leaves
/// every shell held after the user pressed Exit.
fn shutdown_capable(candidate: &HostCandidate) -> bool {
    candidate
        .record
        .as_ref()
        .is_none_or(|record| record.capabilities & termflow_pty_protocol::CAP_SHUTDOWN_CONTROL != 0)
}

/// End a connection to a host for good: stop it holding anything, tell it the
/// disconnect is final, and close the stream so it sees EOF. With a `deadline` the
/// acknowledgements are not waited for past it; the stream is closed either way.
async fn release_host(name: &str, client: &PtyHostClient, deadline: Option<Instant>) -> Option<String> {
    let announce = async {
        let mut problem = None;
        if !client.disarm().await {
            log::error!(
                "quit: {name} never acknowledged the disarm; it may keep holding sessions after we exit"
            );
            problem = Some("the disarm was not acknowledged".to_string());
        }
        if !client.shutdown().await {
            log::error!(
                "quit: {name} never acknowledged the shutdown; it will hold live sessions as a \
                 crash until its retention window expires"
            );
            problem = Some("the shutdown was not acknowledged".to_string());
        }
        problem
    };
    let problem = match deadline {
        Some(deadline) => tokio::time::timeout_at(deadline, announce)
            .await
            .unwrap_or_else(|_| Some("it did not acknowledge in time".to_string())),
        None => announce.await,
    };
    if !client.close_transport().await {
        log::warn!("quit: the connection to {name} did not close in time");
    }
    problem
}

/// Reach a host exit holds no connection to, once, and release it. The connect and
/// the announcement share [`EXIT_REACH_BOUND`]; closing the stream afterwards has
/// its own bound. The connection is a bare one that asks nothing of admission,
/// which exit's own quiesce keeps closed to every adoption.
async fn reach_and_release<P: LifecyclePort>(port: &P, host: &OwnedHost) -> HostExit {
    let name = host.name();
    let deadline = Instant::now() + EXIT_REACH_BOUND;
    let problem = match tokio::time::timeout_at(deadline, port.connect_for_exit(&host.candidate)).await {
        Err(_) => Some(format!("it did not accept a connection within {} s", EXIT_REACH_BOUND.as_secs())),
        Ok(Err(e)) => Some(e),
        Ok(Ok(client)) => {
            client.set_shutdown_control(shutdown_capable(&host.candidate));
            // The connection is made; the rest shares what is left of the bound.
            release_host(&name, &client, Some(deadline)).await
        }
    };
    if let Some(problem) = &problem {
        log::error!("quit: {name} was not shut down: {problem}");
    }
    HostExit { name, problem }
}

async fn exit_one<P: LifecyclePort>(port: &P, host: &OwnedHost, per_host: Option<Duration>) -> HostExit {
    match &host.client {
        Some(client) => {
            let name = host.name();
            let problem = release_host(&name, client, per_host.map(|bound| Instant::now() + bound)).await;
            HostExit { name, problem }
        }
        None => reach_and_release(port, host).await,
    }
}

/// How long closing every host may take when something is waiting for it: an
/// update that has already started the updater cannot wait on a wedged host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CloseBounds {
    /// What one connected host gets to acknowledge its disarm and shutdown.
    pub per_host: Duration,
    /// What all of them get together, discovery of the ones not yet met included.
    pub total: Duration,
}

/// Everything a quit does to the pty-hosts. Takes the sticky exit quiesce
/// (nothing reopens it), then releases every owned host at once: a connected one
/// is disarmed, told the exit is final and disconnected; one that is not
/// connected gets one bounded attempt, and a failure is logged by host name.
/// The exit goes ahead even if operations are still in flight at the deadline.
pub(super) async fn exit_hosts<P: LifecyclePort>(port: &P) -> ExitReport {
    exit_hosts_within(port, None).await
}

/// [`exit_hosts`] with the time it may take bounded when `bounds` is given. The
/// exit quiesce may take over from an update's: a full update closes the hosts
/// under the admission it already holds, and nothing reopens it afterwards.
pub(super) async fn exit_hosts_within<P: LifecyclePort>(port: &P, bounds: Option<CloseBounds>) -> ExitReport {
    let guard = match port.table().quiesce(QuiesceReason::Exit, EXIT_QUIESCE_BOUND).await {
        Ok(guard) => Some(guard),
        Err(busy) => {
            log::error!("quit: could not close admission to the terminal hosts ({busy}); continuing");
            None
        }
    };
    let drained = guard.as_ref().is_none_or(QuiesceGuard::drained);
    if !drained {
        let holders = guard.as_ref().map(QuiesceGuard::holders).unwrap_or_default();
        log::warn!("quit: exiting although operations are still in flight on {holders:?}");
    }
    let per_host = bounds.map(|b| b.per_host);
    let release = async {
        let owned = owned_hosts(port).await;
        join_all(owned.iter().map(|host| exit_one(port, host, per_host))).await
    };
    let hosts = match bounds {
        None => release.await,
        Some(bounds) => tokio::time::timeout(bounds.total, release).await.unwrap_or_else(|_| {
            log::error!("quit: the terminal hosts were not all released within {} s; going ahead", bounds.total.as_secs());
            vec![HostExit {
                name: "the terminal hosts".to_string(),
                problem: Some(format!("they were not all released within {} s", bounds.total.as_secs())),
            }]
        }),
    };
    ExitReport { drained, hosts }
}

// ---- a sibling's update ---------------------------------------------------

/// The outcome of a sibling asking this instance to arm for its update.
#[derive(Debug, PartialEq, Eq)]
pub enum SiblingArm {
    /// Every owned host is armed.
    Armed(usize),
    /// There is no host to arm.
    NothingToArm,
    /// An owned host cannot be armed or would not survive the update.
    Refused(String),
    /// The hosts were asked and at least one did not accept.
    Failed(String),
}

/// The hold a sibling's arm request keeps from the arm to its disarm, with a
/// number that tells the expiry of one arm from the next.
#[derive(Default)]
pub struct SiblingSlot {
    held: std::sync::Mutex<Option<(u64, Hold)>>,
    arms: AtomicU64,
}

impl SiblingSlot {
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<(u64, Hold)>> {
        self.held.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn take(&self) -> Option<(u64, Hold)> {
        self.lock().take()
    }

    fn take_if(&self, arm: u64) -> Option<Hold> {
        let mut held = self.lock();
        match held.as_ref() {
            Some((current, _)) if *current == arm => held.take().map(|(_, hold)| hold),
            _ => None,
        }
    }

    fn keep(&self, hold: Hold) -> u64 {
        let arm = self.arms.fetch_add(1, Ordering::AcqRel) + 1;
        *self.lock() = Some((arm, hold));
        arm
    }
}

/// Arm every host this instance owns so its shells outlive another instance's
/// update. It refuses when any owned host cannot be reached or has not reported
/// its terminals, or runs from inside the install root (or from somewhere
/// unknown), because the update would kill it: arming it would only pretend the
/// shells were safe.
///
/// Admission stays closed until the sibling's disarm, or until the arm window
/// ends: a re-list or a reconnect disarms the host it talks to, which would undo
/// the arm made for the other instance's update. It waits for operations in
/// flight only for `SIBLING_QUIESCE_BOUND` and refuses, naming why, so the
/// answer reaches the instance that is waiting for it.
pub(super) async fn sibling_arm<P: LifecyclePort>(port: &P, timeout_secs: u64) -> SiblingArm {
    let slot = port.sibling_slot();
    let mut hold = match slot.take() {
        // A repeated request arms the same window again.
        Some((_, hold)) => hold,
        None => {
            let guard = match close_admission(port, QuiesceReason::Update, SIBLING_QUIESCE_BOUND, true).await {
                Ok(guard) => guard,
                Err(reason) => return SiblingArm::Refused(reason),
            };
            let hosts = owned_hosts(port).await;
            if hosts.is_empty() {
                return SiblingArm::NothingToArm;
            }
            if let Some(reason) = disconnected_refusal(&hosts).or_else(|| unresolved_refusal(&hosts)) {
                return SiblingArm::Refused(reason);
            }
            if let Err(reason) = update_refusal(&hosts) {
                return SiblingArm::Refused(reason);
            }
            Hold { guard: Some(guard), table: port.table().clone(), hosts, tolerated: Vec::new(), armed: Vec::new() }
        }
    };
    let armed = hold.hosts.len();
    if let Err(e) = hold.arm_detach(timeout_secs, &port.arm_token(), None).await {
        hold.release().await;
        return SiblingArm::Failed(e);
    }
    let arm = slot.keep(hold);
    let port = port.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(timeout_secs)).await;
        if let Some(hold) = port.sibling_slot().take_if(arm) {
            log::warn!("[HOTSWAP] the detach window armed for a sibling ended; reopening admission");
            hold.release().await;
        }
    });
    SiblingArm::Armed(armed)
}

/// Release the detach window `sibling_arm` set on every owned host and reopen
/// admission. True only if every one acknowledged; true too when there is nothing
/// to disarm.
pub(super) async fn sibling_disarm<P: LifecyclePort>(port: &P) -> bool {
    if let Some((_, hold)) = port.sibling_slot().take() {
        return hold.release().await;
    }
    let hosts: Vec<Named> =
        owned_hosts_now(port).into_iter().filter_map(|h| h.client.clone().map(|c| (h.name(), c))).collect();
    disarm_hosts(&hosts).await
}

// ---- AppState -------------------------------------------------------------

/// A connection that does nothing with what the host sends: exit only wants the
/// host to hear one frame.
fn inert_deps() -> PtyHostDeps {
    PtyHostDeps {
        lifecycle_token: crate::pty_host_client::resolve_token(),
        output_tx: tokio::sync::broadcast::channel::<crate::state::ChannelPayload>(1).0,
        output_produced: Arc::new(AtomicU64::new(0)),
        on_exit: Arc::new(|_, _, _| {}),
        on_gap: Arc::new(|_| {}),
        resolve_process: Arc::new(|_| None),
        on_disconnect: Arc::new(|| {}),
        stream_offsets: Arc::new(dashmap::DashMap::new()),
    }
}

impl<R: Runtime> LifecyclePort for AppState<R> {
    async fn connect_for_exit(&self, candidate: &HostCandidate) -> Result<PtyHostClient, String> {
        connect_existing(&candidate.endpoint, EXIT_REACH_BOUND, inert_deps())
            .await
            .map_err(|e| format!("could not connect to {}: {e}", candidate.endpoint))
    }

    fn arm_token(&self) -> String {
        crate::pty_host_client::resolve_token()
    }

    fn sibling_slot(&self) -> &SiblingSlot {
        &self.sibling_hold
    }
}

impl<R: Runtime> AppState<R> {
    /// Every host this instance owns, as far as is known without looking.
    pub fn owned_hosts_now(&self) -> Vec<OwnedHost> {
        owned_hosts_now(self)
    }

    /// The least retention any owned host promises.
    pub fn connected_retention(&self) -> HostRetention {
        connected_retention(self)
    }

    /// Release every owned host for a quit; see [`exit_hosts`].
    pub async fn exit_hosts(&self) -> ExitReport {
        exit_hosts(self).await
    }

    /// [`exit_hosts`] with its time bounded; see [`exit_hosts_within`].
    pub async fn exit_hosts_within(&self, bounds: Option<CloseBounds>) -> ExitReport {
        exit_hosts_within(self, bounds).await
    }

    /// Close admission and check the hosts for an offload.
    pub async fn begin_offload(&self) -> Result<Hold, String> {
        begin_offload(self).await
    }

    /// Close admission and check the hosts for an update commit.
    pub async fn begin_update(&self) -> Result<Hold, String> {
        begin_update(self).await
    }

    /// Close admission for an update that closes every terminal; see
    /// [`begin_full_update`].
    pub async fn begin_full_update(&self) -> Result<Hold, String> {
        begin_full_update(self).await
    }

    /// Close admission to restart this process with the hosts armed; see
    /// [`begin_relaunch`].
    pub async fn begin_relaunch(&self) -> Result<Hold, String> {
        begin_relaunch(self).await
    }

    /// Arm every owned host for a sibling's update; see [`sibling_arm`].
    pub async fn sibling_arm(&self, timeout_secs: u64) -> SiblingArm {
        sibling_arm(self, timeout_secs).await
    }

    /// Release what [`Self::sibling_arm`] armed.
    pub async fn sibling_disarm(&self) -> bool {
        sibling_disarm(self).await
    }
}

#[cfg(test)]
mod survival_tests;
#[cfg(test)]
mod census_tests;
