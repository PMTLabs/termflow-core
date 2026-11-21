//! Process-qualified admission: reserve a local FIFO turn or enqueue hosted input under
//! the ownership barrier. A local turn is requalified at its head, then all admission
//! guards are dropped before writer I/O. Close can therefore kill a blocked local child,
//! and neither the reader nor other terminals wait on that child's writer.
use parking_lot::{Condvar, Mutex, RwLock, RwLockWriteGuard};
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
            return Ok(InputDispatch::Complete(()));
        }
        if !local_first && backend.hosted(process) {
            return Err(source.missing(process));
        }
        if let Some(writer) = backend.local_writer(process) {
            return Ok(InputDispatch::local(move || {
                let mut writer = writer.lock().map_err(|_| source.poisoned())?;
                writer.write_all(bytes).map_err(|e| WriteFailure {
                    kind: FailureKind::Write,
                    message: e.to_string(),
                })?;
                if local_first {
                    let _ = writer.flush();
                }
                Ok(())
            }));
        }
        if local_first && backend.enqueue_hosted(permit, bytes) {
            return Ok(InputDispatch::Complete(()));
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
    stdin_writes: u64,
    epoch: u64,
    host: Option<HostPrompt>,
}
#[derive(Clone, Debug)]
struct HostPrompt {
    channel: crate::elevated_host::HostChannel,
    key: String,
    epoch: u64,
}
pub(crate) struct LaunchBoundary {
    pub returned: bool,
    pub extra_input: bool,
    pub transport_lost: bool,
}

#[derive(Clone)]
struct Attempt {
    id: Uuid,
    submitted: bool,
}
struct RegisteredPrompt {
    connection_id: Option<String>,
    generation: u64,
    nonce: String,
    prompt_order: termflow_pty_protocol::ssh_prompt::PromptOrder,
    stdin_writes: u64,
    shell: Option<(String, super::ssh_helpers::ProcessIdentity, Option<crate::ssh::launch_process::Identity>)>,
}

/// A foreign authority (SSH registry + store) held only for queue admission
/// and the local FIFO-head decision. It must be acquired before the input locks.
pub(crate) trait InputFence<E> {
    fn qualify<T>(&self, work: impl FnOnce() -> Result<T, E>) -> Result<T, E>;
}

struct Unfenced;
impl<E> InputFence<E> for Unfenced {
    fn qualify<T>(&self, work: impl FnOnce() -> Result<T, E>) -> Result<T, E> { work() }
}

/// Selection happens under admission. A hosted callback performs only its nonblocking
/// FIFO send and returns Complete; all local writer acquisition/I/O belongs in Local.
pub enum InputDispatch<'io, T, E> {
    Complete(T),
    Local(Box<dyn FnOnce() -> Result<T, E> + 'io>),
}
impl<'io, T, E> InputDispatch<'io, T, E> {
    pub fn local(write: impl FnOnce() -> Result<T, E> + 'io) -> Self {
        Self::Local(Box::new(write))
    }
}

#[derive(Default)]
struct LocalFifo {
    head: Mutex<u64>,
    advanced: Condvar,
}
impl LocalFifo {
    fn wait(&self, turn: u64) -> LocalTurn<'_> {
        let mut head = self.head.lock();
        while *head != turn {
            self.advanced.wait(&mut head);
        }
        LocalTurn(self)
    }
}

// A refused head, an I/O error, or an unwinding writer still advances the FIFO.
struct LocalTurn<'a>(&'a LocalFifo);
impl Drop for LocalTurn<'_> {
    fn drop(&mut self) {
        *self.0.head.lock() += 1;
        self.0.advanced.notify_all();
    }
}

struct ProcessInput {
    owner: OwnerStamp,
    local_fifo: Option<Arc<LocalFifo>>,
    next_local_turn: u64,
    ssh_prompt: Option<RegisteredPrompt>,
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
            local_fifo: None,
            next_local_turn: 0,
            ssh_prompt: None,
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
    fn cancel_attempt(&mut self, submitted: bool) -> Result<(), Refusal> {
        let next_epoch = self.lease_epoch.checked_add(1).ok_or(Refusal::StaleAttempt)?;
        // Unsubmitted cancellation is not input: preserve the exact prompt and
        // its input generation. A submitted turn may have written even on error.
        if submitted {
            self.invalidate_ready()?;
        }
        self.attempt = None;
        self.lease_epoch = next_epoch;
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
    host: Option<&'a HostPrompt>,
}
impl InputPermit<'_> {
    pub fn process(&self) -> &str {
        self.process
    }
    pub(crate) fn host_prompt(&self) -> bool {
        self.host.is_some()
    }
    pub(crate) fn admits_host(&self, channel: crate::elevated_host::HostChannel, key: &str, epoch: u64) -> bool {
        self.host.is_none_or(|host| host.channel == channel && host.key == key && host.epoch == epoch)
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
        self.prepare_ssh_input_ordered(process)
    }

    // Callers must already hold the input ownership barrier.
    pub(crate) fn prepare_ssh_input_ordered(&self, process: &str) -> Result<LaunchTicket, Refusal> {
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
        let submitted = state.attempt.as_ref().filter(|a| a.id == ticket.id)
            .ok_or(Refusal::StaleAttempt)?.submitted;
        state.cancel_attempt(submitted)
    }

    #[cfg(test)]
    pub(crate) fn register_ssh_prompt(&self, process: &str, generation: u64, nonce: &str) -> Result<(), Refusal> {
        self.register_tagged_ssh_prompt(process, generation, nonce, None)
    }

    pub(crate) fn register_tagged_ssh_prompt(
        &self, process: &str, generation: u64, nonce: &str, connection_id: Option<&str>,
    ) -> Result<(), Refusal> {
        let _order = self.input.ownership.read();
        let owner = self.ssh_prompt_stamp(process).ok_or(Refusal::StaleAttempt)?;
        if owner.generation != generation || !termflow_pty_protocol::ssh_prompt::valid_nonce(nonce) {
            return Err(Refusal::StaleAttempt);
        }
        let entry = self.input.process(process, &owner);
        let mut state = entry.lock();
        state.owner(&owner)?;
        if state.ssh_prompt.is_some() || state.input_generation != 0 {
            return Err(Refusal::StaleAttempt);
        }
        state.ssh_prompt = Some(RegisteredPrompt { connection_id: connection_id.map(str::to_owned), generation, nonce: nonce.into(), prompt_order: Default::default(), stdin_writes: 0, shell: None });
        Ok(())
    }

    pub(crate) fn bind_ssh_shell(&self, process: &str, shell: String, identity: super::ssh_helpers::ProcessIdentity) {
        let birth = crate::ssh::launch_process::Identity::shell(&identity);
        let entry = self.input.processes.lock().get(process).cloned();
        if let Some(entry) = entry {
            if let Some(prompt) = entry.lock().ssh_prompt.as_mut() {
                prompt.shell = Some((shell, identity, birth));
            }
        }
    }

    pub(crate) fn ssh_shell_identity(&self, process: &str) -> Option<(String, super::ssh_helpers::ProcessIdentity, Option<crate::ssh::launch_process::Identity>)> {
        let entry = self.input.processes.lock().get(process)?.clone();
        let state = entry.lock();
        state.ssh_prompt.as_ref()?.shell.clone()
    }

    /// Observe without consuming. An adopted owner can rebind the exact lock,
    /// not mint a replacement after ordinary input has taken over.
    pub(crate) fn launch_ready_ordered(&self, ticket: &mut LaunchTicket) -> Result<Option<ReadyEpoch>, Refusal> {
        let process = &ticket.lease.process;
        let owner = self.input_stamp(process).ok_or(Refusal::StaleAttempt)?;
        let entry = self.input.processes.lock().get(process).cloned().ok_or(Refusal::StaleAttempt)?;
        let mut state = entry.lock();
        state.owner(&owner)?;
        if !state.attempt.as_ref().is_some_and(|a| a.id == ticket.id && !a.submitted) {
            return Err(Refusal::StaleAttempt);
        }
        ticket.lease = state.lease(process);
        Ok(state.ready.clone().filter(|ready| self.ready_transport_current(ready)))
    }

    fn ready_transport_current(&self, ready: &ReadyEpoch) -> bool {
        ready.host.as_ref().is_none_or(|host| self.publish_frame(host.channel, &host.key, host.epoch, &ready.process, || {}))
    }

    #[cfg(test)]
    pub(crate) fn launch_prompt_observed(&self, process: &str) -> bool {
        let entry = self.input.processes.lock().get(process).cloned();
        entry.is_some_and(|state| state.lock().ready.is_some())
    }

    /// Called under the input ordering lock. Adopting a pane changes its
    /// owner stamp, not the accepted command's stdin count or prompt epoch.
    pub(crate) fn launch_boundary(&self, ready: &ReadyEpoch, nonce: &str) -> Option<LaunchBoundary> {
        let entry = self.input.processes.lock().get(&ready.process)?.clone();
        let state = entry.lock();
        let prompt = state.ssh_prompt.as_ref().filter(|p| p.nonce == nonce)?;
        Some(LaunchBoundary {
            returned: state.prompt_epoch > ready.epoch,
            extra_input: Some(prompt.stdin_writes) != ready.stdin_writes.checked_add(1),
            transport_lost: ready.host.as_ref().is_some_and(|host| {
                !self.launch_host_epoch_alive(host.channel, host.epoch)
            }),
        })
    }

    pub(crate) fn ssh_launch_connection(&self, process: &str) -> Option<String> {
        let entry = self.input.processes.lock().get(process)?.clone();
        let state = entry.lock();
        state.ssh_prompt.as_ref()?.connection_id.clone()
    }

    // The caller has already verified the live pane, process and session under
    // the ownership barrier. Use the exact ticket id even after adoption
    // changes the owner stamp. Takeover or a successor ticket makes this a no-op.
    pub(crate) fn cancel_registered_launch_ordered(&self, ticket: &LaunchTicket) -> Result<(), Refusal> {
        let entry = self.input.processes.lock().get(&ticket.lease.process).cloned();
        let Some(entry) = entry else { return Ok(()) };
        let mut state = entry.lock();
        let Some(attempt) = state.attempt.as_ref().filter(|a| a.id == ticket.id) else { return Ok(()) };
        let submitted = attempt.submitted;
        state.cancel_attempt(submitted)
    }

    pub(crate) fn ssh_prompt_nonce(&self, process: &str) -> Option<String> {
        let entry = self.input.processes.lock().get(process)?.clone();
        let state = entry.lock();
        Some(state.ssh_prompt.as_ref()?.nonce.clone())
    }

    pub(crate) fn ssh_prompt_input_generation(&self, process: &str) -> Option<u64> {
        let entry = self.input.processes.lock().get(process)?.clone();
        let state = entry.lock();
        state.ssh_prompt.as_ref()?;
        // An owner change (move/transfer) is applied lazily by the next qualified
        // access, which bumps the generation. Stamp with the generation that access
        // will see, so a prompt read after the move is not refused as pre-move.
        // A further change before observation still mismatches and fails closed.
        let owner_changed = self.ssh_prompt_stamp(process).is_some_and(|owner| owner != state.owner);
        state.input_generation.checked_add(u64::from(owner_changed))
    }

    /// Reader-side observations wait for short admission metadata locks, never for
    /// a FIFO turn or a PTY writer. Contention alone does not consume a fresh prompt.
    /// Hosted observations have their real drain checked at the source (never a dummy drain).
    pub(crate) fn observe_shell_prompt(
        &self,
        process: &str,
        nonce: &str,
        sequence: u64,
        proof: super::ssh_shell::PromptProof<'_>,
    ) -> Result<ReadyEpoch, Refusal> {
        use super::ssh_shell::PromptProof;
        let _order = self.input.ownership.read();
        let entry = self.input.processes.lock().get(process).cloned().ok_or(Refusal::StaleAttempt)?;
        let mut state = entry.lock();
        let owner = self.ssh_prompt_stamp(process).ok_or(Refusal::StaleAttempt)?;
        state.owner(&owner)?;
        let registration = state.ssh_prompt.as_mut().ok_or(Refusal::StaleAttempt)?;
        if registration.generation != owner.generation || registration.nonce != nonce || !registration.prompt_order.advance(sequence) {
            return Err(Refusal::StaleAttempt);
        }
        match proof {
            PromptProof::Local { drain, input_generation } => {
                if !drain.is_drained() || input_generation != state.input_generation {
                    return Err(Refusal::NotReady);
                }
                Self::publish_prompt_epoch(process, owner, &mut state, None)
            }
            PromptProof::Hosted { channel, key, epoch, stdin_writes } => {
                if stdin_writes != registration.stdin_writes {
                    return Err(Refusal::NotReady);
                }
                let mut observed = Err(Refusal::NotReady);
                self.publish_frame(channel, key, epoch, process, || {
                    observed = Self::publish_prompt_epoch(process, owner, &mut state, Some(HostPrompt { channel, key: key.into(), epoch }));
                });
                observed
            }
        }
    }

    #[cfg(test)]
    fn observe_uninstrumented_test_prompt(&self, process: &str, drain: &termflow_pty_protocol::da1::StartupDrain) -> Result<ReadyEpoch, Refusal> {
        let _order = self.input.ownership.read();
        let owner = self.input_stamp(process).ok_or(Refusal::StaleAttempt)?;
        let entry = self.input.process(process, &owner);
        let mut state = entry.lock();
        state.owner(&owner)?;
        if !drain.is_drained() {
            return Err(Refusal::NotReady);
        }
        Self::publish_prompt_epoch(process, owner, &mut state, None)
    }

    fn publish_prompt_epoch(process: &str, owner: OwnerStamp, state: &mut ProcessInput, host: Option<HostPrompt>) -> Result<ReadyEpoch, Refusal> {
        state.prompt_epoch = state
            .prompt_epoch
            .checked_add(1)
            .ok_or(Refusal::StaleAttempt)?;
        let ready = ReadyEpoch {
            process: process.into(),
            owner,
            input_generation: state.input_generation,
            stdin_writes: state.ssh_prompt.as_ref().map_or(0, |p| p.stdin_writes),
            epoch: state.prompt_epoch,
            host,
        };
        state.ready = Some(ready.clone());
        Ok(ready)
    }

    pub fn admit_input<'io, T, E: From<Refusal>>(
        &self,
        process: &str,
        lease: Option<&InputLease>,
        enqueue: impl FnOnce(&InputPermit<'_>) -> Result<InputDispatch<'io, T, E>, E>,
    ) -> Result<T, E> {
        self.input_write(process, WriteKind::Ordinary(lease), enqueue)
    }

    pub fn admit_protocol_input<'io, T, E: From<Refusal>>(
        &self,
        process: &str,
        enqueue: impl FnOnce(&InputPermit<'_>) -> Result<InputDispatch<'io, T, E>, E>,
    ) -> Result<T, E> {
        self.input_write(process, WriteKind::Protocol, enqueue)
    }

    pub fn takeover_input<'io, T, E: From<Refusal>>(
        &self,
        process: &str,
        enqueue: impl FnOnce(&InputPermit<'_>) -> Result<InputDispatch<'io, T, E>, E>,
    ) -> Result<T, E> {
        self.input_write(process, WriteKind::Takeover, enqueue)
    }

    pub fn submit_ssh_input<'io, T, E: From<Refusal>>(
        &self,
        ticket: &LaunchTicket,
        ready: &ReadyEpoch,
        // Lane B's final trust/target/owner check and COMPLETE command+Enter enqueue live here.
        enqueue: impl FnOnce(&InputPermit<'_>) -> Result<InputDispatch<'io, T, E>, E>,
    ) -> Result<T, E> {
        self.input_write(
            &ticket.lease.process,
            WriteKind::Launch(ticket, ready),
            enqueue,
        )
    }

    fn input_write<'io, T, E: From<Refusal>>(
        &self,
        process: &str,
        kind: WriteKind<'_>,
        enqueue: impl FnOnce(&InputPermit<'_>) -> Result<InputDispatch<'io, T, E>, E>,
    ) -> Result<T, E> {
        self.input_write_fenced(process, kind, &Unfenced, enqueue)
    }

    pub(crate) fn submit_ssh_input_fenced<'io, T, E: From<Refusal>>(
        &self,
        ticket: &LaunchTicket,
        ready: &ReadyEpoch,
        fence: &impl InputFence<E>,
        enqueue: impl FnOnce(&InputPermit<'_>) -> Result<InputDispatch<'io, T, E>, E>,
    ) -> Result<T, E> {
        self.input_write_fenced(&ticket.lease.process, WriteKind::Launch(ticket, ready), fence, enqueue)
    }

    fn input_write_fenced<'io, T, E: From<Refusal>>(
        &self,
        process: &str,
        kind: WriteKind<'_>,
        fence: &impl InputFence<E>,
        enqueue: impl FnOnce(&InputPermit<'_>) -> Result<InputDispatch<'io, T, E>, E>,
    ) -> Result<T, E> {
        let missing = if matches!(&kind, WriteKind::Launch(..) | WriteKind::Ordinary(Some(_))) {
            Refusal::StaleAttempt
        } else {
            Refusal::NotFound
        };
        let admitted = fence.qualify(|| {
            let _order = self.input.ownership.read();
            let owner = self.input_stamp(process).ok_or_else(|| missing.clone())?;
            let entry = self.input.process(process, &owner);
            let mut state = entry.lock();
            state.owner(&owner)?;
            let is_protocol = matches!(&kind, WriteKind::Protocol);
            match &kind {
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
                        || !self.ready_transport_current(ready)
                    {
                        return Err(Refusal::NotReady.into());
                    }
                    // Consume BEFORE enqueue: an I/O error may mean a partial write. Never retry it.
                    state.attempt.as_mut().unwrap().submitted = true;
                }
            }
            state.invalidate_ready()?;
            if !is_protocol {
                if let Some(prompt) = &mut state.ssh_prompt {
                    prompt.stdin_writes = prompt.stdin_writes.checked_add(1).ok_or(Refusal::StaleAttempt)?;
                }
            }
            let host = match &kind { WriteKind::Launch(_, ready) => ready.host.as_ref(), _ => None };
            let write = match enqueue(&InputPermit { process, host })? {
                InputDispatch::Complete(result) => return Ok(Ok(result)),
                InputDispatch::Local(write) => write,
            };
            let turn = state.next_local_turn;
            state.next_local_turn = turn.checked_add(1).ok_or(Refusal::StaleAttempt)?;
            let fifo = state.local_fifo.get_or_insert_with(Default::default).clone();
            drop(state);
            Ok(Err((owner, entry, fifo, turn, write)))
        })?;
        let (owner, entry, fifo, turn, write) = match admitted {
            Ok(result) => return Ok(result),
            Err(local) => local,
        };

        let _turn = fifo.wait(turn);
        fence.qualify(|| {
            let _start = self.input.ownership.read();
            let current = self.input_stamp(process).ok_or(missing)?;
            if current != owner {
                return Err(Refusal::StaleAttempt.into());
            }
            let state = entry.lock();
            match kind {
                WriteKind::Ordinary(Some(lease)) => state.check_lease(process, lease)?,
                WriteKind::Launch(ticket, _) => {
                    state.check_lease(process, &ticket.lease)?;
                    if !state.attempt.as_ref().is_some_and(|a| a.id == ticket.id && a.submitted) {
                        return Err(Refusal::StaleAttempt.into());
                    }
                }
                _ => {}
            }
            // Linearization point for starting this local write: a later takeover or
            // close cannot retract it. It can revoke queued launches and close may
            // interrupt the in-flight OS write. Keep only the FIFO turn across I/O.
            Ok(())
        })?;
        write()
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
