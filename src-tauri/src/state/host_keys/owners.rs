//! Leaf admission and shell lifetime share the exact-session mutex. A process
//! reference never falls back to a leaf lookup, even after that leaf restarts.

use super::*;
use tokio::sync::watch;
use std::time::Duration;

pub const JOIN_DEADLINE: Duration = Duration::from_secs(12);
fn retry() -> String { "host-ownership-pending: terminal placement changed; retry".into() }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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
    Placing { stage: Option<StagedShell>, staged_exited: bool, cancel: Option<CloseStorage> },
    Registered(StagedShell),
    Closing(StagedShell),
}
pub(super) struct Row {
    pub(super) cg: u64,
    pub(super) state: OwnerState,
    outcome: watch::Sender<Option<Result<String, String>>>,
    end_lock: Arc<Mutex<()>>,
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
        OwnerState::Placing { stage, .. } => stage.as_ref(),
        OwnerState::Registered(s) | OwnerState::Closing(s) => Some(s),
    }
}

impl HostKeys {
    pub fn admit_create(&self, leaf: &str, mode: CreateMode) -> Result<Admission, String> {
        let mut inner = self.lock();
        if let Some(row) = inner.owners.get(leaf) {
            return match &row.state {
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
        }, outcome, end_lock: Arc::new(Mutex::new(())) });
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
            OwnerState::Closing(_) => CloseAction::Missing,
        }
    }

    /// A placement can exit before its Spawn/Attach reply is delivered.
    pub fn note_exit(&self, process: &str) -> bool {
        let mut inner = self.lock();
        let Some(row) = inner.owners.values_mut().find(|r| shell_of(&r.state).is_some_and(|s| s.process == process)) else { return false };
        match &mut row.state {
            OwnerState::Registered(_) => true,
            OwnerState::Placing { staged_exited, .. } => { *staged_exited = true; false }
            OwnerState::Closing(_) => false,
        }
    }

    /// Storage effects finish before the row disappears and admits its successor.
    /// The per-row lock serializes duplicate endings without holding ownership
    /// during I/O. A leaf storage lock can wrap this entire operation.
    pub fn end_process(&self, process: &str, kind: EndKind, storage: impl FnOnce(&str)) -> Option<Ended> {
        let (leaf, end_lock) = {
            let inner = self.lock();
            let (leaf, row) = inner.owners.iter().find(|(_, r)| shell_of(&r.state).is_some_and(|s| s.process == process))?;
            (leaf.clone(), row.end_lock.clone())
        };
        let _ending = end_lock.lock().unwrap_or_else(|e| e.into_inner());
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
            Self::end(&mut inner, stage.channel, &stage.key, close);
        }
        row.outcome.send_replace(Some(Ok(process.into())));
        Some(Ended { leaf, shell })
    }
}
