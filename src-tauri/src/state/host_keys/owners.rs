//! Leaf admission and shell lifetime share the exact-session mutex. A process
//! reference never falls back to a leaf lookup, even after that leaf restarts.

use super::*;
use tokio::sync::watch;
use std::time::Duration;

pub const JOIN_DEADLINE: Duration = Duration::from_secs(12);
fn retry() -> String { "host-ownership-pending: terminal placement changed; retry".into() }

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
pub enum CreateMode { Mount, Restart }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseStorage { Delete, Preserve }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EndKind { Exit, Close(CloseStorage) }
#[derive(Clone, Debug)]
pub enum ShellStage { Hosted(KeyStage), Local }
#[derive(Clone, Debug)]
pub struct StagedShell { pub process: String, pub stage: ShellStage }
#[derive(Clone, Debug)]
pub enum OwnerState {
    Held,
    Placing { stage: Option<StagedShell>, staged_exited: bool, cancel: Option<CloseStorage> },
    Registered(StagedShell),
    Closing(StagedShell),
}
pub(super) struct Row {
    pub(super) cg: u64,
    pub(super) state: OwnerState,
    pub(super) owner: super::panes::Owner,
    pub(super) admitted_pg: Option<u64>,
    pub(super) started: bool,
    pub(super) outcome: watch::Sender<Option<Result<String, String>>>,
}
pub enum Admission {
    Run(u64),
    Join(watch::Receiver<Option<Result<String, String>>>),
    Existing(String),
}
impl Admission {
    pub async fn joined(mut receiver: watch::Receiver<Option<Result<String, String>>>, deadline: Duration) -> Result<String, String> {
        tokio::time::timeout(deadline, async move {
            loop {
                if let Some(result) = receiver.borrow_and_update().clone() { return result; }
                if receiver.changed().await.is_err() { return Err(retry()); }
            }
        }).await.unwrap_or_else(|_| Err(retry()))
    }
}
#[derive(Debug)]
pub enum Completion { Registered, Cancel(CloseStorage), Exited, Stale }
#[derive(Debug)]
pub enum CloseAction { Cancelled, End { leaf: String, process: String }, Missing }
pub struct Ended { pub leaf: String, pub shell: StagedShell }

pub(super) fn shell_of(state: &OwnerState) -> Option<&StagedShell> {
    match state {
        OwnerState::Held => None,
        OwnerState::Placing { stage, .. } => stage.as_ref(),
        OwnerState::Registered(s) | OwnerState::Closing(s) => Some(s),
    }
}

impl HostKeys {
    pub fn admit_create(&self, leaf: &str, mode: CreateMode) -> Result<Admission, String> {
        let mut inner = self.lock();
        if let Some(row) = inner.owners.get(leaf) {
            return match &row.state {
                OwnerState::Held => Err(retry()),
                OwnerState::Placing { .. } => Ok(Admission::Join(row.outcome.subscribe())),
                OwnerState::Registered(shell) if mode == CreateMode::Mount => Ok(Admission::Existing(shell.process.clone())),
                OwnerState::Registered(_) => Err("host-session-contended: terminal already registered".into()),
                OwnerState::Closing(_) => Err(retry()),
            };
        }
        let cg = inner.sequence.checked_add(1).ok_or_else(retry)?;
        inner.sequence = cg;
        let (outcome, _) = watch::channel(None);
        inner.owners.insert(leaf.into(), Row { cg, state: OwnerState::Placing {
            stage: None, staged_exited: false, cancel: None,
        }, owner: super::panes::Owner::Headless, admitted_pg: None, started: true, outcome });
        Ok(Admission::Run(cg))
    }

    /// Stage and restage use the admission's generation, not a second counter.
    pub fn stage_shell(&self, leaf: &str, cg: u64, process: &str, hosted: Option<(HostChannel, &str, StageMode)>) -> Result<(Option<KeyStage>, u32, Option<StagedShell>), String> {
        self.set_stage(leaf, cg, process, hosted, false)
    }

    pub fn restage_shell(&self, leaf: &str, cg: u64, process: &str, hosted: Option<(HostChannel, &str, StageMode)>) -> Result<(Option<KeyStage>, u32, Option<StagedShell>), String> {
        self.set_stage(leaf, cg, process, hosted, true)
    }

    fn set_stage(&self, leaf: &str, cg: u64, process: &str, hosted: Option<(HostChannel, &str, StageMode)>, restage: bool) -> Result<(Option<KeyStage>, u32, Option<StagedShell>), String> {
        let mut inner = self.lock();
        let Some(row) = inner.owners.get(leaf).filter(|r| r.cg == cg) else { return Err(retry()) };
        let OwnerState::Placing { stage: old, .. } = &row.state else { return Err(retry()) };
        let old = old.clone();
        if old.is_some() != restage { return Err(retry()) }
        let (stage, pid) = if let Some((channel, key, mode)) = hosted {
            let address = (channel, key.to_string());
            let eligible = match mode {
                StageMode::Spawn => !inner.keys.contains_key(&address) && !self.routes.contains(channel, key),
                StageMode::Attach => inner.keys.get(&address).is_some_and(|r| r.state == KeyState::Listed),
            };
            if !eligible { return Err("host-session-contended: session is not eligible".into()) }
            if !Self::trim(&mut inner, channel, true) { return Err(retry()) }
            let pid = inner.keys.get(&address).map_or(0, |r| r.pid);
            let stage = KeyStage { channel, key: key.into(), cg, mode };
            inner.keys.insert(address, Record { state: KeyState::Held(cg), pid, order: std::time::Instant::now(), alive: true });
            (Some(stage), pid)
        } else { (None, 0) };
        if let Some(old) = &old { self.release_stage(&mut inner, old, false); }
        let row = inner.owners.get_mut(leaf).unwrap();
        if let OwnerState::Placing { stage: target, staged_exited, .. } = &mut row.state {
            *target = Some(StagedShell { process: process.into(), stage: stage.clone().map_or(ShellStage::Local, ShellStage::Hosted) });
            *staged_exited = false;
        }
        Self::settle_restore(&mut inner, leaf, hosted.map(|(_, key, _)| key));
        Ok((stage, pid, old))
    }

    fn release_stage(&self, inner: &mut Inner, shell: &StagedShell, authority_close: bool) {
        let ShellStage::Hosted(stage) = &shell.stage else { return };
        let address = (stage.channel, stage.key.clone());
        if !inner.keys.get(&address).is_some_and(|r| r.state == KeyState::Held(stage.cg)) { return }
        self.routes.remove_key(stage.channel, &stage.key);
        if stage.mode == StageMode::Attach && !authority_close {
            inner.keys.get_mut(&address).unwrap().state = KeyState::Listed;
        } else { Self::end(inner, stage.channel, &stage.key, CloseState::Pending); }
    }

    pub fn complete_shell(&self, leaf: &str, cg: u64, shell: &StagedShell) -> Completion {
        let mut inner = self.lock();
        let matching = inner.owners.get(leaf).is_some_and(|r| r.cg == cg && matches!(&r.state,
            OwnerState::Placing { stage: Some(s), .. } if s.process == shell.process));
        if !matching {
            self.release_stage(&mut inner, shell, false);
            return Completion::Stale;
        }
        let row = inner.owners.get_mut(leaf).unwrap();
        let OwnerState::Placing { staged_exited, cancel, .. } = row.state else { unreachable!() };
        if staged_exited && cancel.is_none() {
            self.end_staged_exit(&mut inner, shell);
            let row = inner.owners.remove(leaf).unwrap();
            row.outcome.send_replace(Some(Ok(shell.process.clone())));
            return Completion::Exited;
        }
        row.state = if cancel.is_some() { OwnerState::Closing(shell.clone()) } else { OwnerState::Registered(shell.clone()) };
        if let ShellStage::Hosted(stage) = &shell.stage {
            if let Some(record) = inner.keys.get_mut(&(stage.channel, stage.key.clone())) {
                if record.state == KeyState::Held(cg) { record.state = KeyState::Bound(shell.process.clone()); }
            }
        }
        Self::settle_pane_restore(&mut inner, leaf);
        Self::settle_restore(&mut inner, leaf, match &shell.stage {
            ShellStage::Hosted(stage) => Some(&stage.key), ShellStage::Local => None,
        });
        if let Some(policy) = cancel { Completion::Cancel(policy) } else {
            inner.owners.get(leaf).unwrap().outcome.send_replace(Some(Ok(shell.process.clone())));
            Completion::Registered
        }
    }

    pub fn abort_create(&self, leaf: &str, cg: u64) -> Option<StagedShell> {
        let mut inner = self.lock();
        if !inner.owners.get(leaf).is_some_and(|r| r.cg == cg && matches!(r.state, OwnerState::Placing { .. })) { return None }
        let row = inner.owners.remove(leaf).unwrap();
        row.outcome.send_replace(Some(Err(retry())));
        let shell = shell_of(&row.state).cloned();
        if let Some(shell) = &shell { self.release_stage(&mut inner, shell, false); }
        shell
    }

    pub fn owner_state(&self, leaf: &str) -> Option<(u64, OwnerState)> {
        self.lock().owners.get(leaf).map(|r| (r.cg, r.state.clone()))
    }

    pub fn owns_process(&self, process: &str) -> bool {
        self.lock().owners.values().any(|r| shell_of(&r.state).is_some_and(|s| s.process == process))
    }

    pub fn resolve_process(&self, reference: &str, placing: bool) -> Option<String> {
        let inner = self.lock();
        let row = if reference.starts_with("tm-") {
            inner.owners.get(reference)
        } else { inner.owners.values().find(|r| shell_of(&r.state).is_some_and(|s| s.process == reference)) }?;
        match &row.state {
            OwnerState::Registered(s) => Some(s.process.clone()),
            OwnerState::Placing { stage: Some(s), staged_exited: false, .. } if placing => Some(s.process.clone()),
            _ => None,
        }
    }

    pub fn close_process(&self, reference: &str, policy: CloseStorage) -> CloseAction {
        let mut inner = self.lock();
        let leaf = if reference.starts_with("tm-") { Some(reference.to_string()) } else {
            inner.owners.iter().find(|(_, r)| shell_of(&r.state).is_some_and(|s| s.process == reference)).map(|(l, _)| l.clone())
        };
        let Some(leaf) = leaf else { return CloseAction::Missing };
        Self::close_row_locked(&mut inner, leaf, policy)
    }

    fn close_row_locked(inner: &mut Inner, leaf: String, policy: CloseStorage) -> CloseAction {
        let Some(row) = inner.owners.get_mut(&leaf) else { return CloseAction::Missing };
        match &mut row.state {
            OwnerState::Placing { cancel, .. } => {
                // Deletion wins if a GUI close joins a non-destructive API close.
                if *cancel != Some(CloseStorage::Delete) { *cancel = Some(policy); }
                CloseAction::Cancelled
            }
            OwnerState::Registered(shell) => {
                let shell = shell.clone();
                row.state = OwnerState::Closing(shell.clone());
                CloseAction::End { leaf, process: shell.process }
            }
            OwnerState::Held | OwnerState::Closing(_) => CloseAction::Missing,
        }
    }

    pub(super) fn close_leaf_locked(inner: &mut Inner, leaf: &str, policy: CloseStorage, effects: &mut Vec<String>) {
        if Self::remove_held(inner, leaf) { return; }
        if let CloseAction::End { process, .. } = Self::close_row_locked(inner, leaf.into(), policy) { effects.push(process); }
    }

    /// Held rows have no shell, key or storage to end. Registered and Closing
    /// rows must instead pass through the stripe-protected process ending.
    pub(super) fn remove_held(inner: &mut Inner, leaf: &str) -> bool {
        if !inner.owners.get(leaf).is_some_and(|r| matches!(r.state, OwnerState::Held)) { return false; }
        inner.owners.remove(leaf);
        true
    }

    /// A placement can exit before its Spawn/Attach reply is delivered.
    pub fn note_exit(&self, process: &str) -> bool {
        let mut inner = self.lock();
        let Some(row) = inner.owners.values_mut().find(|r| shell_of(&r.state).is_some_and(|s| s.process == process)) else { return false };
        match &mut row.state {
            OwnerState::Registered(_) => true,
            OwnerState::Placing { stage: Some(shell), staged_exited, .. } => {
                *staged_exited = true;
                let shell = shell.clone();
                self.end_staged_exit(&mut inner, &shell);
                false
            }
            OwnerState::Held | OwnerState::Placing { stage: None, .. } => false,
            OwnerState::Closing(_) => false,
        }
    }

    /// A stale shell cannot write the durable leaf of its replacement. Storage
    /// runs outside ownership, but removal must wait for this same stripe.
    pub fn write<T>(&self, leaf: &str, process: &str, storage: impl FnOnce() -> T) -> Option<T> {
        self.write_shells(&[(leaf, process)], storage)
    }

    /// An edge touches both endpoints; qualify both while holding their stripes.
    pub(crate) fn write_shells<T>(&self, shells: &[(&str, &str)], storage: impl FnOnce() -> T) -> Option<T> {
        if shells.is_empty() { return None; }
        let leaves: Vec<_> = shells.iter().map(|(leaf, _)| *leaf).collect();
        super::super::leaf_storage::with_leaves(&leaves, || {
            let valid = {
                let inner = self.lock();
                shells.iter().all(|(leaf, process)| inner.owners.get(*leaf).is_some_and(|row|
                    matches!(&row.state, OwnerState::Registered(shell) if shell.process == *process)))
            };
            if valid { Some(storage()) } else {
                log::debug!("Skipping stale shell storage write");
                None
            }
        })
    }

    /// Storage, recheck and row/key removal share one leaf critical section.
    pub fn end_process(&self, process: &str, kind: EndKind, storage: impl FnOnce(&str)) -> Option<Ended> {
        // Resolve only; release ownership before acquiring any stripe.
        let leaf = {
            let inner = self.lock();
            inner.owners.iter().find(|(_, r)| shell_of(&r.state).is_some_and(|s| s.process == process))?.0.clone()
        };
        let (ended, mut inner) = super::super::leaf_storage::with_leaves(&[&leaf], || {
            let valid = |r: &Row| match (&r.state, kind) {
                (OwnerState::Registered(s), EndKind::Exit) | (OwnerState::Closing(s), EndKind::Close(_)) => s.process == process,
                _ => false,
            };
            if !self.lock().owners.get(&leaf).is_some_and(&valid) { return None }
            storage(&leaf);
            let mut inner = self.lock();
            if !inner.owners.get(&leaf).is_some_and(valid) { return None }
            let row = inner.owners.remove(&leaf).unwrap();
            let shell = shell_of(&row.state).unwrap().clone();
            if let ShellStage::Hosted(stage) = &shell.stage {
                self.routes.remove_key(stage.channel, &stage.key);
                let close = if kind == EndKind::Exit { CloseState::None } else { CloseState::Pending };
                Self::mark_end(&mut inner, stage.channel, &stage.key, close);
            }
            row.outcome.send_replace(Some(Ok(process.into())));
            Some((Ended { leaf: leaf.clone(), shell }, inner))
        })?;
        // Retain ownership until the stripe is released and Close is enqueued:
        // reconnect must not send the newly Pending cell inside this section.
        if let ShellStage::Hosted(stage) = &ended.shell.stage {
            if matches!(inner.keys.get(&(stage.channel, stage.key.clone())).map(|r| &r.state),
                Some(KeyState::Ending { close: CloseState::Pending, .. })) {
                Self::send(&mut inner, stage.channel, &stage.key);
            }
        }
        drop(inner);
        Some(ended)
    }
}
