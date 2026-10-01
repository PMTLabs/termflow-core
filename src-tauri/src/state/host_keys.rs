//! One lifecycle record for each exact session on each host. Ending records
//! keep an outstanding close from becoming an attach candidate again.

use crate::elevated_host::HostChannel;
use crate::pty_host_client::SessionListing;
use super::{HostRoutes, restore_candidate};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, atomic::{AtomicBool, Ordering}};
use termflow_pty_protocol::{Control, Frame};
use tokio::sync::mpsc::UnboundedSender;

mod owners;
mod restore;
pub use owners::{Admission as CreateAdmission, CreateMode, CloseStorage, EndKind, ShellStage, StagedShell, OwnerState, Completion, CloseAction, JOIN_DEADLINE};

pub const ENDING_CAP: usize = 4096;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CloseState { Pending, Sent(u64), None }

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KeyState {
    Listed,
    Held(u64),
    Bound(String),
    Ending { close: CloseState, stamp: Option<u64> },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StageMode { Spawn, Attach }

#[derive(Clone, Debug)]
pub struct KeyStage {
    pub channel: HostChannel,
    pub key: String,
    pub cg: u64,
    pub mode: StageMode,
}

struct Record { state: KeyState, pid: u32, order: std::time::Instant, alive: bool }

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyKind { Listed, Held, Bound, Ending }
#[cfg(test)]
pub struct KeySnapshot { pub channel: HostChannel, pub pid: u32, pub state: KeyKind }

struct Connection { epoch: u64, sender: UnboundedSender<Frame>, alive: Arc<AtomicBool> }
#[derive(Default)]
struct Channel { requests: u64, answered: u64, connection: Option<Connection> }
struct Inner {
    keys: HashMap<(HostChannel, String), Record>,
    channels: HashMap<HostChannel, Channel>,
    sequence: u64,
    owners: HashMap<String, owners::Row>,
    restore_holders: HashMap<(String, String), restore::Intent>,
    closed_unowned: HashMap<(String, String), restore::Intent>,
    cap: usize,
}

#[derive(Clone)]
pub struct HostKeys { inner: Arc<Mutex<Inner>>, routes: HostRoutes }

impl Default for HostKeys {
    fn default() -> Self { Self::new(HostRoutes::default()) }
}

impl HostKeys {
    pub fn new(routes: HostRoutes) -> Self {
        Self { inner: Arc::new(Mutex::new(Inner {
            keys: HashMap::new(), channels: HashMap::new(), sequence: 0, owners: HashMap::new(),
            restore_holders: HashMap::new(), closed_unowned: HashMap::new(), cap: ENDING_CAP,
        })), routes }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> { self.inner.lock().unwrap_or_else(|e| e.into_inner()) }

    #[cfg(test)]
    pub fn set_cap(&self, cap: usize) { self.lock().cap = cap; }

    pub fn state(&self, channel: HostChannel, key: &str) -> Option<KeyState> {
        self.lock().keys.get(&(channel, key.to_string())).map(|r| r.state.clone())
    }

    pub fn eligible(&self, channel: HostChannel, key: &str) -> bool {
        self.state(channel, key) == Some(KeyState::Listed)
    }

    pub fn listed(&self) -> Vec<(HostChannel, String)> {
        self.lock().keys.iter().filter(|(_, r)| r.state == KeyState::Listed)
            .map(|((c, k), _)| (*c, k.clone())).collect()
    }

    pub fn candidate(&self, leaf: &str, exact: Option<&str>) -> Option<(HostChannel, String)> {
        let inner = self.lock();
        let listed: Vec<_> = inner.keys.iter().filter(|(_, r)| r.state == KeyState::Listed)
            .map(|((c, k), _)| (*c, k.as_str())).collect();
        let key = restore_candidate(leaf, exact, listed.iter().map(|(_, k)| *k))?;
        listed.iter().find(|(_, k)| *k == key).map(|(c, k)| (*c, k.to_string()))
    }

    pub fn occupied(&self, channel: HostChannel, key: &str) -> bool {
        self.lock().keys.contains_key(&(channel, key.to_string())) || self.routes.contains(channel, key)
    }

    fn trim(inner: &mut Inner, channel: HostChannel, for_admission: bool) -> bool {
        loop {
            let count = inner.keys.iter().filter(|((c, _), r)| *c == channel && matches!(r.state, KeyState::Ending { .. })).count();
            if count < inner.cap || (!for_admission && count <= inner.cap) { return true; }
            let oldest = inner.keys.iter().filter(|((c, _), r)| *c == channel
                && matches!(r.state, KeyState::Ending { close: CloseState::None, .. }))
                .min_by_key(|(_, r)| r.order).map(|(k, _)| k.clone());
            match oldest { Some(k) => { inner.keys.remove(&k); }, None => return !for_admission }
        }
    }

    /// Set Held before anything can publish a process or emit Spawn/Attach.
    pub fn stage(&self, channel: HostChannel, key: &str, mode: StageMode) -> Result<(KeyStage, u32), String> {
        let mut inner = self.lock();
        let address = (channel, key.to_string());
        let eligible = match mode {
            StageMode::Spawn => !inner.keys.contains_key(&address) && !self.routes.contains(channel, key),
            StageMode::Attach => inner.keys.get(&address).is_some_and(|r| r.state == KeyState::Listed),
        };
        if !eligible { return Err(format!("{}: session {key} is not eligible", super::terminals::HOST_SESSION_CONTENDED)); }
        let cg = inner.sequence.checked_add(1).ok_or("host-ownership-pending: session sequence exhausted")?;
        if !Self::trim(&mut inner, channel, true) { return Err("host-ownership-pending: terminal host has outstanding session endings".into()); }
        inner.sequence = cg;
        let pid = inner.keys.get(&address).map_or(0, |r| r.pid);
        inner.keys.insert(address, Record { state: KeyState::Held(cg), pid, order: std::time::Instant::now(), alive: true });
        Ok((KeyStage { channel, key: key.to_string(), cg, mode }, pid))
    }

    pub fn publish(&self, stage: &KeyStage, process: &str, epoch: u64) -> bool {
        let inner = self.lock();
        if let Some(row) = inner.owners.values().find(|r| r.cg == stage.cg) {
            if !matches!(&row.state, OwnerState::Placing { stage: Some(shell), .. }
                if shell.process == process && matches!(&shell.stage, ShellStage::Hosted(h) if h.channel == stage.channel && h.key == stage.key)) {
                return false;
            }
        }
        if inner.keys.get(&(stage.channel, stage.key.clone())).is_some_and(|r| r.state == KeyState::Held(stage.cg)) {
            self.routes.register(stage.channel, &stage.key, process, epoch);
            true
        } else { false }
    }

    pub fn restore_route(&self, channel: HostChannel, key: &str, process: &str, epoch: u64) -> bool {
        let inner = self.lock();
        if inner.keys.get(&(channel, key.to_string())).is_some_and(|r| r.state == KeyState::Bound(process.to_string())) {
            self.routes.register(channel, key, process, epoch);
            true
        } else { false }
    }

    pub fn complete(&self, stage: &KeyStage, process: &str) -> bool {
        let mut inner = self.lock();
        // A leaf-owned stage completes its row and key together.
        if inner.owners.values().any(|r| r.cg == stage.cg) { return false; }
        let Some(record) = inner.keys.get_mut(&(stage.channel, stage.key.clone())) else { return false };
        if record.state != KeyState::Held(stage.cg) { return false; }
        record.state = KeyState::Bound(process.to_string());
        true
    }

    pub fn abort(&self, stage: &KeyStage) {
        let mut inner = self.lock();
        // The placement guard owns rollback of a leaf-owned stage. A ticket
        // dropping first must not retire its key separately from its owner row.
        if inner.owners.values().any(|r| r.cg == stage.cg) { return; }
        let address = (stage.channel, stage.key.clone());
        if !inner.keys.get(&address).is_some_and(|r| r.state == KeyState::Held(stage.cg)) { return; }
        self.routes.remove_key(stage.channel, &stage.key);
        match stage.mode {
            StageMode::Attach => { inner.keys.get_mut(&address).unwrap().state = KeyState::Listed; }
            StageMode::Spawn => { Self::end(&mut inner, stage.channel, &stage.key, CloseState::Pending); }
        }
    }

    fn send(inner: &mut Inner, channel: HostChannel, key: &str) {
        let Some(ch) = inner.channels.get(&channel) else { return };
        let Some(conn) = ch.connection.as_ref().filter(|c| c.alive.load(Ordering::Acquire)) else { return };
        // Close and listing enqueues share this mutex and the client's FIFO.
        // Read the listing count only after the Close has entered that queue.
        if conn.sender.send(Frame::Ctrl(Control::Close { tab_id: key.to_string() })).is_ok() {
            let state = KeyState::Ending { close: CloseState::Sent(conn.epoch), stamp: Some(ch.requests) };
            if let Some(r) = inner.keys.get_mut(&(channel, key.to_string())) { r.state = state; }
        }
    }

    fn end(inner: &mut Inner, channel: HostChannel, key: &str, close: CloseState) {
        Self::mark_end(inner, channel, key, close.clone());
        if close == CloseState::Pending { Self::send(inner, channel, key); }
    }

    fn mark_end(inner: &mut Inner, channel: HostChannel, key: &str, close: CloseState) {
        let stamp = (close == CloseState::None).then(|| inner.channels.get(&channel).map_or(0, |c| c.requests));
        let order = std::time::Instant::now();
        let r = inner.keys.entry((channel, key.to_string())).or_insert(Record { state: KeyState::Listed, pid: 0, order, alive: true });
        r.state = KeyState::Ending { close: close.clone(), stamp };
        r.order = order;
        // Existing sessions must always be allowed to owe a Close, even when
        // their population exceeds the admission cap.
        Self::trim(inner, channel, false);
    }

    pub fn close_listed(&self, channel: HostChannel, key: &str, due: impl FnOnce() -> bool) {
        let mut inner = self.lock();
        if inner.keys.get(&(channel, key.to_string())).is_some_and(|r| r.state == KeyState::Listed) && Self::unowned_due(&inner, key, std::time::Instant::now()) && due() {
            Self::end(&mut inner, channel, key, CloseState::Pending);
        }
    }

    pub fn close(&self, channel: HostChannel, key: &str) {
        let mut inner = self.lock();
        if let Some(KeyState::Ending { .. }) = inner.keys.get(&(channel, key.to_string())).map(|r| &r.state) { return; }
        self.routes.remove_key(channel, key);
        Self::end(&mut inner, channel, key, CloseState::Pending);
    }

    /// Unknown duplicate Exit frames still advance the ending's stamp: an old
    /// listing cannot retire an ending created by either reader or attach Exit.
    pub(crate) fn observe_exit(&self, channel: HostChannel, epoch: u64, key: &str) {
        let mut inner = self.lock();
        if !inner.channels.get(&channel).and_then(|c| c.connection.as_ref()).is_some_and(|c| c.epoch == epoch) { return; }
        self.apply_exit(&mut inner, channel, key);
    }

    pub fn exit(&self, channel: HostChannel, key: &str) {
        self.apply_exit(&mut self.lock(), channel, key);
    }

    fn apply_exit(&self, inner: &mut Inner, channel: HostChannel, key: &str) {
        let address = (channel, key.to_string());
        if let Some(row) = inner.owners.values_mut().find(|r| owners::shell_of(&r.state).is_some_and(|s|
            matches!(&s.stage, ShellStage::Hosted(h) if h.channel == channel && h.key == key))) {
            match &mut row.state {
                OwnerState::Registered(_) | OwnerState::Closing(_) => return,
                OwnerState::Placing { staged_exited, .. } => *staged_exited = true,
            }
        }
        if let Some(KeyState::Held(_) | KeyState::Bound(_) | KeyState::Ending { close: CloseState::None, .. }) = inner.keys.get(&address).map(|r| &r.state) {
            self.routes.remove_key(channel, key);
            Self::end(inner, channel, key, CloseState::None);
        }
    }

    pub fn exit_process(&self, process: &str) {
        let mut inner = self.lock();
        if inner.owners.values().any(|r| owners::shell_of(&r.state).is_some_and(|s| s.process == process)) { return; }
        let keys: Vec<_> = inner.keys.iter().filter(|(_, r)| r.state == KeyState::Bound(process.to_string()))
            .map(|(k, _)| k.clone()).collect();
        self.routes.remove_process(process);
        for (channel, key) in keys { Self::end(&mut inner, channel, &key, CloseState::None); }
    }

    pub fn disconnect(&self, channel: HostChannel, epoch: u64) {
        let mut inner = self.lock();
        if inner.channels.get(&channel).and_then(|c| c.connection.as_ref()).is_some_and(|c| c.epoch == epoch) {
            inner.channels.get_mut(&channel).unwrap().connection = None;
            self.routes.remove_channel(channel);
        }
        for ((c, _), r) in &mut inner.keys {
            if *c == channel && matches!(r.state, KeyState::Ending { close: CloseState::Sent(e), .. } if e == epoch) {
                r.state = KeyState::Ending { close: CloseState::Pending, stamp: None };
            }
        }
    }

    pub(crate) fn connect(&self, channel: HostChannel, epoch: u64, sender: UnboundedSender<Frame>, alive: Arc<AtomicBool>) {
        let mut inner = self.lock();
        let ch = inner.channels.entry(channel).or_default();
        if ch.connection.as_ref().is_some_and(|c| c.epoch > epoch) { return; }
        if let Some(old) = ch.connection.take() {
            if old.epoch != epoch {
                for ((c, _), r) in &mut inner.keys {
                    if *c == channel && matches!(r.state, KeyState::Ending { close: CloseState::Sent(e), .. } if e == old.epoch) {
                        r.state = KeyState::Ending { close: CloseState::Pending, stamp: None };
                    }
                }
                self.routes.remove_channel(channel);
            }
        }
        inner.channels.get_mut(&channel).unwrap().connection = Some(Connection { epoch, sender, alive });
        let pending: Vec<_> = inner.keys.iter().filter(|((c, _), r)| *c == channel
            && matches!(r.state, KeyState::Ending { close: CloseState::Pending, .. })).map(|((_, k), _)| k.clone()).collect();
        for key in pending { Self::send(&mut inner, channel, &key); }
    }

    pub(crate) fn enqueue_listing(&self, channel: HostChannel, enqueue: impl FnOnce() -> bool) -> Option<u64> {
        let mut inner = self.lock();
        let ch = inner.channels.entry(channel).or_default();
        let next = ch.requests.checked_add(1)?;
        if !enqueue() { return None; }
        ch.requests = next;
        Some(next)
    }

    /// Apply only answered listings. The unowned-close decision and the cell
    /// change occur in this same critical section; transport errors never enter.
    pub fn listing(&self, channel: HostChannel, listing: &SessionListing, close_unowned: impl Fn(&str) -> bool) {
        self.listing_at(channel, listing, std::time::Instant::now(), close_unowned);
    }

    pub(crate) fn listing_at(&self, channel: HostChannel, listing: &SessionListing, now: std::time::Instant, close_unowned: impl Fn(&str) -> bool) {
        let mut inner = self.lock();
        let ch = inner.channels.entry(channel).or_default();
        if listing.request_no <= ch.answered { return; }
        ch.answered = listing.request_no;
        let mut released = std::collections::HashSet::new();
        inner.keys.retain(|(c, key), r| {
            if *c != channel { return true; }
            let shown = listing.sessions.iter().find(|s| s.tab_id == *key);
            match &r.state {
                KeyState::Listed => shown.is_some(),
                KeyState::Ending { close: CloseState::Sent(_), stamp: Some(s) } => !(listing.request_no > *s && shown.is_none()),
                KeyState::Ending { close: CloseState::None, stamp: Some(s) } => {
                    let keep = !(listing.request_no > *s && shown.is_none_or(|s| !s.alive));
                    if !keep { released.insert(key.clone()); }
                    keep
                },
                _ => true,
            }
        });
        for meta in &listing.sessions {
            if released.contains(&meta.tab_id) { continue; }
            let r = inner.keys.entry((channel, meta.tab_id.clone())).or_insert(Record { state: KeyState::Listed, pid: meta.pid, order: std::time::Instant::now(), alive: meta.alive });
            if r.state == KeyState::Listed {
                r.pid = meta.pid;
                r.alive = meta.alive;
                if Self::unowned_due(&inner, &meta.tab_id, now) && close_unowned(&meta.tab_id) {
                    Self::end(&mut inner, channel, &meta.tab_id, CloseState::Pending);
                }
            }
        }
    }

    pub fn unfinished_on(&self, channel: HostChannel) -> usize {
        self.lock().keys.iter().filter(|((c, _), r)| *c == channel && (matches!(r.state, KeyState::Held(_)) || (r.state == KeyState::Listed && r.alive))).count()
    }

    #[cfg(test)]
    pub fn seed_pending(&self, channel: HostChannel, key: &str) {
        self.lock().keys.insert((channel, key.into()), Record {
            state: KeyState::Ending { close: CloseState::Pending, stamp: None }, pid: 0, order: std::time::Instant::now(), alive: true,
        });
    }

    #[cfg(test)]
    pub fn len(&self) -> usize { self.lock().keys.len() }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool { self.len() == 0 }

    #[cfg(test)]
    pub fn contains_key(&self, key: &str) -> bool { self.lock().keys.keys().any(|(_, k)| k == key) }

    #[cfg(test)]
    pub fn remove_fixture(&self, key: &str) { self.lock().keys.retain(|(_, k), _| k != key); }

    #[cfg(test)]
    pub fn clear_fixture(&self) { self.lock().keys.clear(); }

    #[cfg(test)]
    pub fn snapshot(&self, key: &str) -> Option<KeySnapshot> {
        self.lock().keys.iter().find(|((_, k), _)| k == key).map(|((c, _), r)| KeySnapshot {
            channel: *c, pid: r.pid, state: match r.state {
                KeyState::Listed => KeyKind::Listed, KeyState::Held(_) => KeyKind::Held,
                KeyState::Bound(_) => KeyKind::Bound, KeyState::Ending { .. } => KeyKind::Ending,
            },
        })
    }

    pub fn forget(&self, channel: HostChannel) {
        let mut inner = self.lock();
        inner.keys.retain(|(c, _), _| *c != channel);
        inner.channels.remove(&channel);
        self.routes.remove_channel(channel);
    }
}

#[cfg(test)]
mod key_table_tests;
#[cfg(test)]
mod owner_table_tests;
