//! Process-qualified input admission. The ownership read barrier is retained through enqueue;
//! ownership replacement/transfer takes its write side BEFORE taking HostKeys' mutex. A blocked
//! PTY write never holds the ownership mutex and cannot stop output from draining. Independent
//! terminals retain independent writer locks and may write concurrently.
use parking_lot::{Mutex, RwLock, RwLockWriteGuard};
use std::collections::HashMap;
use std::sync::Arc;
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OwnerStamp {
    pub generation: u64,
    pub owner: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    InputLocked,
    StaleAttempt,
    NotFound,
    NotReady,
}
impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::InputLocked => "InputLocked: SSH launch is preparing",
            Self::StaleAttempt => "StaleAttempt: terminal input lease expired",
            Self::NotFound => "Terminal not found",
            Self::NotReady => "SSH shell is not ready",
        })
    }
}
impl From<Refusal> for String {
    fn from(error: Refusal) -> Self {
        error.to_string()
    }
}
impl From<Refusal> for std::io::Error {
    fn from(error: Refusal) -> Self {
        Self::new(std::io::ErrorKind::PermissionDenied, error.to_string())
    }
}
impl From<Refusal> for (axum::http::StatusCode, String) {
    fn from(error: Refusal) -> Self {
        let status = match error {
            Refusal::InputLocked => axum::http::StatusCode::LOCKED,
            Refusal::NotFound => axum::http::StatusCode::NOT_FOUND,
            _ => axum::http::StatusCode::CONFLICT,
        };
        (status, error.to_string())
    }
}

/// Distinct legacy error/flush/route policies; bytes and errors of an ordinary terminal
/// remain those of its existing entry point. The shared dispatcher is exercised with real
/// local writers and the hosted FIFO, not a table of aliases for a fake gate.
#[derive(Clone, Copy, Debug)]
pub enum InputSource {
    Renderer,
    Rest,
    WebSocket,
    Automation,
}
pub type LocalWriter = Arc<std::sync::Mutex<Box<dyn std::io::Write + Send>>>;
pub trait InputBackend {
    fn input_keys(&self) -> &crate::state::HostKeys;
    fn local_writer(&self, process: &str) -> Option<LocalWriter>;
    fn hosted(&self, process: &str) -> bool;
    fn enqueue_hosted(&self, permit: &InputPermit<'_>, bytes: &[u8]) -> bool;
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailureKind {
    Missing,
    Locked,
    Stale,
    Write,
}
#[derive(Debug)]
pub struct WriteFailure {
    pub kind: FailureKind,
    pub message: String,
}
impl From<Refusal> for WriteFailure {
    fn from(error: Refusal) -> Self {
        Self {
            kind: match error {
                Refusal::NotFound => FailureKind::Missing,
                Refusal::InputLocked => FailureKind::Locked,
                _ => FailureKind::Stale,
            },
            message: error.to_string(),
        }
    }
}
impl InputSource {
    fn missing(self, process: &str) -> WriteFailure {
        WriteFailure {
            kind: FailureKind::Missing,
            message: match self {
                Self::WebSocket => "terminal not found".into(),
                Self::Automation => format!("terminal {} has no writer", process),
                _ => "Terminal not found".into(),
            },
        }
    }
    fn poisoned(self) -> WriteFailure {
        WriteFailure {
            kind: FailureKind::Write,
            message: match self {
                Self::Renderer => "Failed to lock writer",
                Self::WebSocket => "writer mutex poisoned",
                _ => "terminal writer mutex poisoned",
            }
            .into(),
        }
    }
}

pub fn write_input(
    backend: &impl InputBackend,
    process: &str,
    source: InputSource,
    lease: Option<&InputLease>,
    bytes: &[u8],
) -> Result<(), WriteFailure> {
    use std::io::Write;
    let result = backend.input_keys().admit_input(process, lease, |permit| {
        // Automation historically selects its local writer first and ignores flush errors.
        let local_first = matches!(source, InputSource::Automation);
        if !local_first && backend.enqueue_hosted(permit, bytes) {
            return Ok(());
        }
        if !local_first && backend.hosted(process) {
            return Err(source.missing(process));
        }
        if let Some(writer) = backend.local_writer(process) {
            let mut writer = writer.lock().map_err(|_| source.poisoned())?;
            writer.write_all(bytes).map_err(|e| WriteFailure {
                kind: FailureKind::Write,
                message: e.to_string(),
            })?;
            if local_first {
                let _ = writer.flush();
            }
            return Ok(());
        }
        if local_first && backend.enqueue_hosted(permit, bytes) {
            return Ok(());
        }
        Err(source.missing(process))
    });
    result.map_err(|e: WriteFailure| {
        if e.kind == FailureKind::Missing {
            source.missing(process)
        } else {
            e
        }
    })
}

impl<R: tauri::Runtime> InputBackend for crate::state::AppState<R> {
    fn input_keys(&self) -> &crate::state::HostKeys {
        self.host_table.keys()
    }
    fn local_writer(&self, process: &str) -> Option<LocalWriter> {
        self.shell_writer_channels.get(process).map(|r| r.clone())
    }
    fn hosted(&self, process: &str) -> bool {
        self.is_host_owned(process)
    }
    fn enqueue_hosted(&self, permit: &InputPermit<'_>, bytes: &[u8]) -> bool {
        self.host_write_admitted(permit, bytes)
    }
}

#[derive(Clone, Debug)]
pub struct InputLease {
    process: String,
    owner: OwnerStamp,
    epoch: u64,
}
#[derive(Clone, Debug)]
pub struct LaunchTicket {
    lease: InputLease,
    id: Uuid,
}
#[derive(Clone, Debug)]
pub struct ReadyEpoch {
    process: String,
    owner: OwnerStamp,
    input_generation: u64,
    epoch: u64,
}
#[derive(Clone)]
struct Attempt {
    id: Uuid,
    submitted: bool,
}
struct ProcessInput {
    owner: OwnerStamp,
    lease_epoch: u64,
    input_generation: u64,
    prompt_epoch: u64,
    ready: Option<ReadyEpoch>,
    attempt: Option<Attempt>,
}
impl ProcessInput {
    fn new(owner: OwnerStamp) -> Self {
        Self {
            owner,
            lease_epoch: 0,
            input_generation: 0,
            prompt_epoch: 0,
            ready: None,
            attempt: None,
        }
    }
    fn owner(&mut self, current: &OwnerStamp) -> Result<(), Refusal> {
        if &self.owner != current {
            self.lease_epoch = self
                .lease_epoch
                .checked_add(1)
                .ok_or(Refusal::StaleAttempt)?;
            self.input_generation = self
                .input_generation
                .checked_add(1)
                .ok_or(Refusal::StaleAttempt)?;
            self.ready = None;
            self.owner = current.clone();
            // Keep a preparing lock during transfer until a qualified new attempt/adoption.
            // Old receipts cannot cancel or submit under the new owner stamp.
        }
        Ok(())
    }
    fn lease(&self, process: &str) -> InputLease {
        InputLease {
            process: process.into(),
            owner: self.owner.clone(),
            epoch: self.lease_epoch,
        }
    }
    fn check_lease(&self, process: &str, lease: &InputLease) -> Result<(), Refusal> {
        if lease.process != process || lease.owner != self.owner || lease.epoch != self.lease_epoch
        {
            return Err(Refusal::StaleAttempt);
        }
        Ok(())
    }
    fn invalidate_ready(&mut self) -> Result<(), Refusal> {
        self.input_generation = self
            .input_generation
            .checked_add(1)
            .ok_or(Refusal::StaleAttempt)?;
        self.ready = None;
        Ok(())
    }
}

#[derive(Default)]
pub(crate) struct InputDomain {
    // Lock order: this barrier -> per-process input -> short HostKeys checks/enqueue.
    // Owner mutation: this barrier (exclusive) -> HostKeys. NEVER the reverse.
    ownership: RwLock<()>,
    processes: Mutex<HashMap<String, Arc<Mutex<ProcessInput>>>>,
}
impl InputDomain {
    pub(crate) fn forget(&self, process: &str) {
        self.processes.lock().remove(process);
    }
    pub(crate) fn ownership_change(&self) -> RwLockWriteGuard<'_, ()> {
        self.ownership.write()
    }
    fn process(&self, process: &str, owner: &OwnerStamp) -> Arc<Mutex<ProcessInput>> {
        self.processes
            .lock()
            .entry(process.into())
            .or_insert_with(|| Arc::new(Mutex::new(ProcessInput::new(owner.clone()))))
            .clone()
    }
}

/// Only this module can mint a permit, and it cannot outlive admission's callback. Low-level
/// hosted routing requires this capability; no locked refusal may fall back to a raw writer.
pub struct InputPermit<'a> {
    process: &'a str,
}
impl InputPermit<'_> {
    pub fn process(&self) -> &str {
        self.process
    }
}

impl crate::state::HostKeys {
    pub(crate) fn input_owner_change(&self) -> RwLockWriteGuard<'_, ()> {
        self.input.ownership_change()
    }

    pub fn input_lease(&self, process: &str) -> Result<InputLease, Refusal> {
        let _order = self.input.ownership.read();
        let owner = self.input_stamp(process).ok_or(Refusal::NotFound)?;
        let entry = self.input.process(process, &owner);
        let mut state = entry.lock();
        state.owner(&owner)?;
        if state.attempt.as_ref().is_some_and(|a| !a.submitted) {
            return Err(Refusal::InputLocked);
        }
        Ok(state.lease(process))
    }

    pub fn prepare_ssh_input(&self, process: &str) -> Result<LaunchTicket, Refusal> {
        let _order = self.input.ownership.read();
        let owner = self.input_stamp(process).ok_or(Refusal::NotFound)?;
        let entry = self.input.process(process, &owner);
        let mut state = entry.lock();
        state.owner(&owner)?;
        state.lease_epoch = state
            .lease_epoch
            .checked_add(1)
            .ok_or(Refusal::StaleAttempt)?;
        let id = Uuid::new_v4();
        state.attempt = Some(Attempt {
            id,
            submitted: false,
        });
        Ok(LaunchTicket {
            lease: state.lease(process),
            id,
        })
    }

    pub fn cancel_ssh_input(&self, ticket: &LaunchTicket) -> Result<(), Refusal> {
        let _order = self.input.ownership.read();
        let owner = self
            .input_stamp(&ticket.lease.process)
            .ok_or(Refusal::StaleAttempt)?;
        let entry = self.input.process(&ticket.lease.process, &owner);
        let mut state = entry.lock();
        state.owner(&owner)?;
        state.check_lease(&ticket.lease.process, &ticket.lease)?;
        if state.attempt.as_ref().map(|a| a.id) != Some(ticket.id) {
            return Err(Refusal::StaleAttempt);
        }
        state.attempt = None;
        state.lease_epoch = state
            .lease_epoch
            .checked_add(1)
            .ok_or(Refusal::StaleAttempt)?;
        state.invalidate_ready()
    }

    /// Called by the nonce/parser adapter only after startup replies are drained and current
    /// process provenance is established. A replay is NOT a prompt observation.
    pub fn observe_shell_prompt(
        &self,
        process: &str,
        drain: &termflow_pty_protocol::da1::StartupDrain,
    ) -> Result<ReadyEpoch, Refusal> {
        let _order = self.input.ownership.read();
        let owner = self.input_stamp(process).ok_or(Refusal::StaleAttempt)?;
        let entry = self.input.process(process, &owner);
        let mut state = entry.lock();
        state.owner(&owner)?;
        if !drain.is_drained() {
            return Err(Refusal::NotReady);
        }
        state.prompt_epoch = state
            .prompt_epoch
            .checked_add(1)
            .ok_or(Refusal::StaleAttempt)?;
        let ready = ReadyEpoch {
            process: process.into(),
            owner,
            input_generation: state.input_generation,
            epoch: state.prompt_epoch,
        };
        state.ready = Some(ready.clone());
        Ok(ready)
    }

    pub fn admit_input<T, E: From<Refusal>>(
        &self,
        process: &str,
        lease: Option<&InputLease>,
        enqueue: impl FnOnce(&InputPermit<'_>) -> Result<T, E>,
    ) -> Result<T, E> {
        self.input_write(process, WriteKind::Ordinary(lease), enqueue)
    }

    pub fn admit_protocol_input<T, E: From<Refusal>>(
        &self,
        process: &str,
        enqueue: impl FnOnce(&InputPermit<'_>) -> Result<T, E>,
    ) -> Result<T, E> {
        self.input_write(process, WriteKind::Protocol, enqueue)
    }

    pub fn takeover_input<T, E: From<Refusal>>(
        &self,
        process: &str,
        enqueue: impl FnOnce(&InputPermit<'_>) -> Result<T, E>,
    ) -> Result<T, E> {
        self.input_write(process, WriteKind::Takeover, enqueue)
    }

    pub fn submit_ssh_input<T, E: From<Refusal>>(
        &self,
        ticket: &LaunchTicket,
        ready: &ReadyEpoch,
        // Lane B's final trust/target/owner check and COMPLETE command+Enter enqueue live here.
        enqueue: impl FnOnce(&InputPermit<'_>) -> Result<T, E>,
    ) -> Result<T, E> {
        self.input_write(
            &ticket.lease.process,
            WriteKind::Launch(ticket, ready),
            enqueue,
        )
    }

    fn input_write<T, E: From<Refusal>>(
        &self,
        process: &str,
        kind: WriteKind<'_>,
        enqueue: impl FnOnce(&InputPermit<'_>) -> Result<T, E>,
    ) -> Result<T, E> {
        let _order = self.input.ownership.read();
        let missing = if matches!(&kind, WriteKind::Launch(..) | WriteKind::Ordinary(Some(_))) {
            Refusal::StaleAttempt
        } else {
            Refusal::NotFound
        };
        let owner = self.input_stamp(process).ok_or(missing)?;
        let entry = self.input.process(process, &owner);
        let mut state = entry.lock();
        state.owner(&owner)?;
        match kind {
            WriteKind::Ordinary(lease) => {
                if let Some(lease) = lease {
                    state.check_lease(process, lease)?;
                }
                if state.attempt.as_ref().is_some_and(|a| !a.submitted) {
                    return Err(Refusal::InputLocked.into());
                }
            }
            WriteKind::Protocol => {}
            WriteKind::Takeover => {
                state.lease_epoch = state
                    .lease_epoch
                    .checked_add(1)
                    .ok_or(Refusal::StaleAttempt)?;
                state.attempt = None;
            }
            WriteKind::Launch(ticket, ready) => {
                state.check_lease(process, &ticket.lease)?;
                if !state
                    .attempt
                    .as_ref()
                    .is_some_and(|a| a.id == ticket.id && !a.submitted)
                {
                    return Err(Refusal::StaleAttempt.into());
                }
                if ready.process != process
                    || ready.owner != owner
                    || ready.input_generation != state.input_generation
                    || state.ready.as_ref().map(|r| r.epoch) != Some(ready.epoch)
                {
                    return Err(Refusal::NotReady.into());
                }
                // Consume BEFORE enqueue: an I/O error may mean a partial write. Never retry it.
                state.attempt.as_mut().unwrap().submitted = true;
            }
        }
        state.invalidate_ready()?;
        // No HostKeys mutex is retained across local WriteFile. The ownership barrier and
        // this process's admission mutex remain held until writer/host FIFO acceptance.
        enqueue(&InputPermit { process })
    }
}

#[cfg(test)]
#[path = "input_gate/tests.rs"]
mod tests;

enum WriteKind<'a> {
    Ordinary(Option<&'a InputLease>),
    Protocol,
    Takeover,
    Launch(&'a LaunchTicket, &'a ReadyEpoch),
}
