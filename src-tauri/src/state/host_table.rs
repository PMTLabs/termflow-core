//! Admission to the pty-host(s): who may start an operation that creates or
//! adopts host sessions, and when a lifecycle change (exit, offload, update
//! commit) or a host's retirement may proceed.
//!
//! There is deliberately no blocking lock. A `std::sync::Mutex` guards a small
//! table and is never held across an `.await` or while taking any other lock;
//! an operation asks to `begin` and is refused at once (never queued) when the
//! table is closing. Because nothing waits on a queue there is no writer
//! starvation, no recursive-read deadlock and no lock order to get wrong. The
//! one hazard left is a forgotten `Ticket`, which is RAII for that reason.

use super::{HostKeys, KeyStage};
use crate::elevated_host::HostChannel;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tokio::sync::{watch, Notify};

/// Prefix of the retryable error a create gets while the app is exiting or
/// updating. Renderer callers match on it.
pub const LIFECYCLE_BUSY: &str = "LIFECYCLE_BUSY";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuiesceReason {
    Exit,
    Offload,
    Update,
}

impl QuiesceReason {
    fn describe(self) -> &'static str {
        match self {
            QuiesceReason::Exit => "TermFlow is exiting",
            QuiesceReason::Offload => "TermFlow is preparing to hand its terminals to the next version",
            QuiesceReason::Update => "TermFlow is updating",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Lifecycle {
    Open,
    /// `holder` tells a guard whether the quiesce it is dropping is still the
    /// one in force.
    Quiescing { holder: u64, reason: QuiesceReason },
    /// Exit is sticky: the process is ending, nothing reopens admission.
    Exiting,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Admission {
    Open,
    Draining,
    Retired,
}

/// Why `begin` said no.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Busy {
    /// Exit, offload or update is in progress.
    Lifecycle(QuiesceReason),
    /// The host is being retired, or has been.
    Host(HostChannel, Admission),
    /// Nothing is published for this channel.
    NoSuchHost(HostChannel),
    Exhausted,
}

impl std::fmt::Display for Busy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Busy::Lifecycle(reason) => write!(f, "{LIFECYCLE_BUSY}: {}", reason.describe()),
            Busy::Host(channel, admission) => {
                write!(f, "terminal host {channel:?} is not accepting new sessions ({admission:?})")
            }
            Busy::NoSuchHost(channel) => write!(f, "terminal host {channel:?} is not connected"),
            Busy::Exhausted => write!(f, "{LIFECYCLE_BUSY}: lifecycle identity exhausted"),
        }
    }
}

impl std::error::Error for Busy {}

/// `drain_host` refused; try again on the next tick.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DrainRefusal {
    /// An operation holds a ticket on the host right now.
    InFlight,
    NotOpen(Admission),
    NoSuchHost,
}

struct HostSlot {
    channel: HostChannel,
    admission: Admission,
    inflight: u32,
    /// Identifies the connection published for this host. A callback that
    /// captured an older epoch belongs to a superseded connection.
    epoch: u64,
    /// The retirement ticker watching this host, while one runs. A host has at
    /// most one, however often its connection is replaced.
    ticker: Option<Arc<Notify>>,
}

struct Inner {
    lifecycle: Lifecycle,
    hosts: Vec<HostSlot>,
    /// Adoptions in flight: they target no host that is published yet, but a
    /// quiesce must still wait for them.
    adopting: u32,
    next_epoch: u64,
    next_holder: u64,
}

impl Inner {
    fn total_inflight(&self) -> u32 {
        self.adopting + self.hosts.iter().map(|h| h.inflight).sum::<u32>()
    }

    fn slot_mut(&mut self, channel: HostChannel) -> Option<&mut HostSlot> {
        self.hosts.iter_mut().find(|h| h.channel == channel)
    }
}

struct Shared {
    inner: Mutex<Inner>,
    routes: super::HostRoutes,
    keys: HostKeys,
    /// Total tickets in flight, level-triggered so a quiesce can never miss the
    /// moment it reaches zero.
    inflight: watch::Sender<u32>,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn publish_inflight(&self, inner: &Inner) {
        self.inflight.send_replace(inner.total_inflight());
    }
}

/// Cheap to clone; every clone is the same table.
#[derive(Clone)]
pub struct HostTable {
    shared: Arc<Shared>,
}

impl Default for HostTable {
    fn default() -> Self {
        Self::new()
    }
}

impl HostTable {
    pub fn new() -> Self {
        let routes = super::HostRoutes::default();
        Self {
            shared: Arc::new(Shared {
                inner: Mutex::new(Inner {
                    lifecycle: Lifecycle::Open,
                    hosts: Vec::new(),
                    adopting: 0,
                    next_epoch: 0,
                    next_holder: 0,
                }),
                inflight: watch::channel(0).0,
                keys: HostKeys::new(routes.clone()),
                routes,
            }),
        }
    }

    pub fn keys(&self) -> &HostKeys { &self.shared.keys }

    pub fn routes(&self) -> &super::HostRoutes {
        &self.shared.routes
    }

    /// An epoch for a connection about to be made. The callbacks wired into it
    /// capture the value; `publish` makes it the host's current one.
    pub fn reserve_epoch(&self) -> Result<u64, String> {
        let mut inner = self.shared.lock();
        let epoch = inner.next_epoch.checked_add(1).ok_or("terminal host connection identity exhausted")?;
        inner.next_epoch = epoch;
        Ok(epoch)
    }

    /// Make `epoch` the current connection of `channel` and open it for
    /// admission. Publishing again (a reconnect) supersedes the old epoch;
    /// tickets already held on the host keep counting.
    ///
    /// A host that is being retired (`Draining`) or has been (`Retired`) is left
    /// exactly as it is, and `false` is returned: reopening it would admit
    /// creates to a host whose emptiness was just decided, and would make the
    /// retirement's own guard (bound to the old epoch) inert.
    pub fn publish(&self, channel: HostChannel, epoch: u64) -> bool {
        let mut inner = self.shared.lock();
        match inner.slot_mut(channel) {
            Some(slot) if slot.admission != Admission::Open || slot.epoch > epoch => false,
            Some(slot) => {
                if slot.epoch != epoch {
                    self.routes().remove_epoch(channel, slot.epoch);
                }
                slot.epoch = epoch;
                true
            }
            None => {
                inner.hosts.push(HostSlot { channel, admission: Admission::Open, inflight: 0, epoch, ticker: None });
                true
            }
        }
    }

    /// Is `epoch` still the connection published for `channel`? A callback of a
    /// superseded or never-published connection must do nothing.
    pub fn is_current(&self, channel: HostChannel, epoch: u64) -> bool {
        self.shared.lock().hosts.iter().any(|h| h.channel == channel && h.epoch == epoch)
    }

    pub fn admission(&self, channel: HostChannel) -> Option<Admission> {
        self.shared.lock().hosts.iter().find(|h| h.channel == channel).map(|h| h.admission)
    }

    /// The epoch of the connection currently published for `channel`.
    pub fn epoch(&self, channel: HostChannel) -> Option<u64> {
        self.shared.lock().hosts.iter().find(|h| h.channel == channel).map(|h| h.epoch)
    }

    /// Tickets in flight on `channel` right now.
    pub fn inflight(&self, channel: HostChannel) -> u32 {
        self.shared.lock().hosts.iter().find(|h| h.channel == channel).map_or(0, |h| h.inflight)
    }

    /// Why admission is closed right now: `None` while the table is open.
    /// `Some(QuiesceReason::Exit)` is permanent for the life of the process; the
    /// other reasons end when their guard is dropped.
    pub fn lifecycle_reason(&self) -> Option<QuiesceReason> {
        match self.shared.lock().lifecycle {
            Lifecycle::Open => None,
            Lifecycle::Quiescing { reason, .. } => Some(reason),
            Lifecycle::Exiting => Some(QuiesceReason::Exit),
        }
    }

    /// Start an operation that creates or attaches a session on `channel`. Never
    /// waits: it is refused the moment the table is closing or the host is not
    /// `Open`.
    pub fn begin(&self, channel: HostChannel) -> Result<Ticket, Busy> {
        let mut inner = self.shared.lock();
        Self::check_lifecycle(&inner)?;
        let slot = inner.slot_mut(channel).ok_or(Busy::NoSuchHost(channel))?;
        if slot.admission != Admission::Open {
            return Err(Busy::Host(channel, slot.admission));
        }
        slot.inflight += 1;
        self.shared.publish_inflight(&inner);
        Ok(Ticket::new(&self.shared, TicketTarget::Host(channel)))
    }

    /// Start adopting a host that is not published yet. Counted by a quiesce,
    /// refused while one is in force: an adoption begun during exit would
    /// publish a host nobody is left to shut down.
    pub fn begin_adoption(&self) -> Result<Ticket, Busy> {
        let mut inner = self.shared.lock();
        Self::check_lifecycle(&inner)?;
        inner.adopting += 1;
        self.shared.publish_inflight(&inner);
        Ok(Ticket::new(&self.shared, TicketTarget::Adoption))
    }

    /// An operation of the lifecycle owner that a quiesce must wait for, and that
    /// the quiesce it holds must not refuse: an offload's arm, which an exit taking
    /// the table over waits out before it releases the hosts. Requires the guard,
    /// so only the holder can call it.
    pub fn begin_as_quiescer(&self, _guard: &QuiesceGuard) -> Ticket {
        let mut inner = self.shared.lock();
        inner.adopting += 1;
        self.shared.publish_inflight(&inner);
        Ticket::new(&self.shared, TicketTarget::Adoption)
    }

    fn check_lifecycle(inner: &Inner) -> Result<(), Busy> {
        match inner.lifecycle {
            Lifecycle::Open => Ok(()),
            Lifecycle::Quiescing { reason, .. } => Err(Busy::Lifecycle(reason)),
            Lifecycle::Exiting => Err(Busy::Lifecycle(QuiesceReason::Exit)),
        }
    }

    /// Close admission and wait, outside the mutex and for at most `bound`, for
    /// every ticket to be returned (a request can legitimately take ~10 s).
    ///
    /// `Exit` is sticky: it moves the table to `Exiting`, which nothing ever
    /// reopens, and may take over from an offload or update quiesce. `Offload`
    /// and `Update` are refused with `LIFECYCLE_BUSY` unless the table is open,
    /// so they are mutually exclusive with each other and with Exit, and a
    /// refused one can never reopen admission under the one that holds it.
    ///
    /// On timeout the guard is still returned, with `drained() == false` and the
    /// holders listed: Exit proceeds anyway, offload and update drop the guard
    /// (reopening the table) and refuse.
    pub async fn quiesce(&self, reason: QuiesceReason, bound: Duration) -> Result<QuiesceGuard, Busy> {
        let holder = {
            let mut inner = self.shared.lock();
            match (inner.lifecycle, reason) {
                (Lifecycle::Open, _) | (Lifecycle::Exiting | Lifecycle::Quiescing { .. }, QuiesceReason::Exit) => {}
                _ => return Err(Self::check_lifecycle(&inner).expect_err("not open")),
            }
            let holder = inner.next_holder.checked_add(1).ok_or(Busy::Exhausted)?;
            inner.next_holder = holder;
            inner.lifecycle = match reason {
                QuiesceReason::Exit => Lifecycle::Exiting,
                _ => Lifecycle::Quiescing { holder, reason },
            };
            holder
        };
        let mut inflight = self.shared.inflight.subscribe();
        let drained = tokio::time::timeout(bound, inflight.wait_for(|n| *n == 0)).await.map(|r| r.is_ok());
        let drained = drained.unwrap_or(false);
        let holders = if drained {
            Vec::new()
        } else {
            let inner = self.shared.lock();
            let mut holders: Vec<(Option<HostChannel>, u32)> =
                inner.hosts.iter().filter(|h| h.inflight > 0).map(|h| (Some(h.channel), h.inflight)).collect();
            if inner.adopting > 0 {
                holders.push((None, inner.adopting));
            }
            holders
        };
        Ok(QuiesceGuard { shared: self.shared.clone(), holder, drained, holders })
    }

    /// Stop admitting to an empty host so it can be retired. Fail-fast: it never
    /// waits for a ticket, so a cleanup on a path that itself holds one cannot
    /// stall. The guard reopens the host when dropped; `retire` keeps it closed.
    pub fn drain_host(&self, channel: HostChannel) -> Result<DrainGuard, DrainRefusal> {
        let mut inner = self.shared.lock();
        let slot = inner.slot_mut(channel).ok_or(DrainRefusal::NoSuchHost)?;
        if slot.inflight > 0 {
            return Err(DrainRefusal::InFlight);
        }
        if slot.admission != Admission::Open {
            return Err(DrainRefusal::NotOpen(slot.admission));
        }
        slot.admission = Admission::Draining;
        Ok(DrainGuard { shared: self.shared.clone(), channel, epoch: slot.epoch, retired: false })
    }

    /// Claim the one retirement ticker of `channel`. `None` when the host is not
    /// open for admission or already has a ticker. Dropping the handle frees the
    /// place, so a ticker that ends for any reason can be started again.
    pub fn start_ticker(&self, channel: HostChannel) -> Option<TickerHandle> {
        let mut inner = self.shared.lock();
        let slot = inner.slot_mut(channel)?;
        if slot.admission != Admission::Open || slot.ticker.is_some() {
            return None;
        }
        let wake = Arc::new(Notify::new());
        slot.ticker = Some(wake.clone());
        Some(TickerHandle { shared: self.shared.clone(), channel, wake })
    }

    /// Ask the ticker of `channel`, if any, to look at the host now instead of at
    /// its next tick. Remembered if the ticker is busy at the moment.
    pub fn nudge_ticker(&self, channel: HostChannel) {
        let wake = self.shared.lock().hosts.iter().find(|h| h.channel == channel).and_then(|h| h.ticker.clone());
        if let Some(wake) = wake {
            wake.notify_one();
        }
    }

    #[cfg(test)]
    fn lifecycle(&self) -> Lifecycle {
        self.shared.lock().lifecycle
    }
}

#[derive(Debug, Clone, Copy)]
enum TicketTarget {
    Host(HostChannel),
    Adoption,
}

/// Permission to run one operation. Dropping it returns the slot, wakes a
/// waiting quiesce and undoes any claim transition the operation made but did
/// not finish, so a cancelled or failed operation cannot leave a session
/// claimed.
pub struct Ticket {
    shared: Arc<Shared>,
    target: TicketTarget,
    stages: Vec<KeyStage>,
}

impl Ticket {
    fn new(shared: &Arc<Shared>, target: TicketTarget) -> Self {
        Self { shared: shared.clone(), target, stages: Vec::new() }
    }

    /// The host this ticket was taken on; `None` for an adoption.
    pub fn channel(&self) -> Option<HostChannel> {
        match self.target {
            TicketTarget::Host(channel) => Some(channel),
            TicketTarget::Adoption => None,
        }
    }

    /// Dropping unfinished work releases an Attach without owning its session,
    /// but retires an unknown-result Spawn with an exact-key Close.
    pub fn guard_key(&mut self, stage: KeyStage) { self.stages.push(stage); }

    pub fn publish_key(&self, process: &str) -> bool {
        self.stages.last().is_some_and(|s| {
            let epoch = self.shared.lock().hosts.iter().find(|h| h.channel == s.channel).map_or(0, |h| h.epoch);
            self.shared.keys.publish(s, process, epoch)
        })
    }

    pub(crate) fn key_stage(&self) -> Option<KeyStage> { self.stages.last().cloned() }

    pub fn complete_key(&self, process: &str) -> bool {
        self.stages.last().is_some_and(|s| self.shared.keys.complete(s, process))
    }

    pub fn abort_key(&self) {
        for stage in &self.stages { self.shared.keys.abort(stage); }
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        {
            let mut inner = self.shared.lock();
            match self.target {
                TicketTarget::Host(channel) => {
                    if let Some(slot) = inner.slot_mut(channel) {
                        slot.inflight = slot.inflight.saturating_sub(1);
                    }
                }
                TicketTarget::Adoption => inner.adopting = inner.adopting.saturating_sub(1),
            }
            self.shared.publish_inflight(&inner);
        }
        for stage in self.stages.drain(..) {
            self.shared.keys.abort(&stage);
        }
    }
}

/// Holds the table closed. Dropping it reopens the table only if the quiesce it
/// stands for is still the one in force.
pub struct QuiesceGuard {
    shared: Arc<Shared>,
    holder: u64,
    drained: bool,
    holders: Vec<(Option<HostChannel>, u32)>,
}

impl QuiesceGuard {
    /// Whether every ticket was returned within the bound.
    pub fn drained(&self) -> bool {
        self.drained
    }

    /// When not drained, who still held tickets (`None` = adoptions).
    pub fn holders(&self) -> &[(Option<HostChannel>, u32)] {
        &self.holders
    }
}

impl Drop for QuiesceGuard {
    fn drop(&mut self) {
        let mut inner = self.shared.lock();
        if matches!(inner.lifecycle, Lifecycle::Quiescing { holder, .. } if holder == self.holder) {
            inner.lifecycle = Lifecycle::Open;
        }
    }
}

/// The place of a host's retirement ticker. Held by the ticker task for as long
/// as it runs.
pub struct TickerHandle {
    shared: Arc<Shared>,
    channel: HostChannel,
    wake: Arc<Notify>,
}

impl TickerHandle {
    /// Resolves when someone asked for the host to be looked at now.
    pub async fn nudged(&self) {
        self.wake.notified().await;
    }
}

impl Drop for TickerHandle {
    fn drop(&mut self) {
        let mut inner = self.shared.lock();
        if let Some(slot) = inner.slot_mut(self.channel) {
            if slot.ticker.as_ref().is_some_and(|t| Arc::ptr_eq(t, &self.wake)) {
                slot.ticker = None;
            }
        }
    }
}

/// A host closed to admission while its retirement is decided.
pub struct DrainGuard {
    shared: Arc<Shared>,
    channel: HostChannel,
    epoch: u64,
    retired: bool,
}

impl DrainGuard {
    /// The retirement is confirmed: the host stays closed for good.
    pub fn retire(mut self) {
        self.retired = true;
        let mut inner = self.shared.lock();
        if let Some(slot) = inner.slot_mut(self.channel) {
            if slot.epoch == self.epoch && slot.admission == Admission::Draining {
                slot.admission = Admission::Retired;
            }
        }
    }

    /// Confirm the retirement of a host that is merely empty, and only while no
    /// exit, offload or update has closed the table. Decided under the same lock
    /// as the table's lifecycle, so a retirement can never be committed after one
    /// of those took the hosts over: they then release the host themselves. When
    /// refused the host is reopened, as if the guard had been dropped.
    pub fn retire_when_open(mut self) -> bool {
        let mut inner = self.shared.lock();
        let open = inner.lifecycle == Lifecycle::Open;
        if let Some(slot) = inner.slot_mut(self.channel) {
            if open && slot.epoch == self.epoch && slot.admission == Admission::Draining {
                slot.admission = Admission::Retired;
                self.retired = true;
                return true;
            }
        }
        false
    }
}

impl Drop for DrainGuard {
    fn drop(&mut self) {
        if self.retired {
            return;
        }
        let mut inner = self.shared.lock();
        if let Some(slot) = inner.slot_mut(self.channel) {
            if slot.epoch == self.epoch && slot.admission == Admission::Draining {
                slot.admission = Admission::Open;
            }
        }
    }
}

#[cfg(test)]
mod table_tests;
#[cfg(test)]
mod counter_tests;
