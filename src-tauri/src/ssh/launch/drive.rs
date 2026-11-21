//! T4 admission and dispatch. No SSH child or transport-lifecycle watcher here.
use super::{refused, AttemptReceipt, Gate, LaunchError, LaunchErrorCode as Code, LaunchRegistry, LaunchSnapshot, LaunchStage};
use crate::{
    pty_manager::{
        input_gate::{InputBackend, InputDispatch, InputFence, LaunchTicket, ReadyEpoch},
        ssh_helpers::{HelperRoot, ProcessIdentity},
        ssh_shell::posix::launch::{self, EncodedLaunch},
    },
    ssh::{
        launch_argv::{build_launch_argv, ProxyRuntime, PublishedLaunch},
        session::{engine_runtime, LaunchDefinition, LaunchState, SessionRegistry},
        store::Store,
        target,
    },
    state::{AppState, HostKeys, PaneIdentity},
};
use std::{cell::Cell, io::Write, path::{Path, PathBuf}, sync::Arc, time::{Duration, Instant}};
use tauri::{Emitter, Runtime};

const READY_TIMEOUT: Duration = Duration::from_secs(30);
const CHECK_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TypedEvent<'a> {
    terminal_id: &'a str,
    state: &'static str,
}

/// Production and integration tests share the actual gate, argv encoder and
/// writer. Only OS process evidence, private root and the sink are injected.
pub(super) trait LaunchPort: InputBackend {
    fn helper_root(&self) -> Result<HelperRoot, LaunchError>;
    fn open_ssh(&self) -> Result<String, LaunchError>;
    fn bare_shell(&self, shell: &str, identity: &ProcessIdentity) -> bool;
    fn typed(&self, terminal: &str);
}

impl<R: Runtime> LaunchPort for AppState<R> {
    fn helper_root(&self) -> Result<HelperRoot, LaunchError> {
        HelperRoot::for_app(&self.app_handle).map_err(|_| Code::UnsupportedContext.into())
    }
    fn open_ssh(&self) -> Result<String, LaunchError> {
        let path = native_ssh()?;
        if !Path::new(&path).is_file() {
            return Err(Code::UnsupportedContext.into());
        }
        Ok(path)
    }
    fn bare_shell(&self, shell: &str, identity: &ProcessIdentity) -> bool {
        let mut system = sysinfo::System::new();
        system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        let pid = sysinfo::Pid::from_u32(identity.pid);
        system.process(pid).is_some_and(|process| {
            process.start_time() == identity.start_time
                && Path::new(shell).file_name().is_some_and(|name| {
                    name.to_string_lossy().eq_ignore_ascii_case(&process.name().to_string_lossy())
                })
                && !system.processes().values().any(|p| p.parent() == Some(pid))
        })
    }
    fn typed(&self, terminal: &str) {
        let _ = self.app_handle.emit("ssh-launch:state", TypedEvent { terminal_id: terminal, state: "typed" });
    }
}

fn native_ssh() -> Result<String, LaunchError> {
    #[cfg(windows)]
    return crate::pty_manager::ssh_shell::system_shell(r"OpenSSH\ssh.exe")
        .map_err(|_| Code::UnsupportedContext.into());
    #[cfg(not(windows))]
    Ok("/usr/bin/ssh".into())
}

pub(super) struct Payload {
    encoded: EncodedLaunch,
    proxy: PublishedLaunch,
    // Non-serializable evidence for T5 to associate command-return boundaries
    // and descendant identity with precisely the accepted input.
    #[allow(dead_code)]
    submitted: Submission,
}

#[allow(dead_code)]
struct Submission {
    definition_revision: u64,
    ready: ReadyEpoch,
    nonce: String,
    shell: ProcessIdentity,
}
impl Payload {
    pub(super) fn retire(&self) {
        let _ = self.encoded.retire_payload();
        let _ = self.proxy.retire_payload();
    }
    // Exposed to the next lifecycle slice via the registered payload. A PTY
    // queue send or even a failed write cannot prove helper quiescence.
    pub(super) fn finish_after_quiescence(self) {
        let _ = self.encoded.finish_after_quiescence();
        let _ = self.proxy.finish_after_quiescence();
    }
}

struct Candidate {
    process: String,
    owner: PaneIdentity,
    placement: u64,
    ticket: LaunchTicket,
    ready: ReadyEpoch,
    nonce: String,
    receipt: AttemptReceipt,
    definition: LaunchDefinition,
    shell: String,
    identity: ProcessIdentity,
}

impl Candidate {
    fn encode(&self, port: &impl LaunchPort, home: &Path) -> Result<Payload, LaunchError> {
        let paths = self.receipt.known_hosts_paths.as_ref().ok_or(Code::UnsupportedContext)?;
        let ssh = port.open_ssh()?;
        let argv = build_launch_argv(&self.definition.target, paths, &ssh, home)
            .map_err(|_| Code::UnsupportedContext)?;
        let root = port.helper_root()?;
        let owner = ProcessIdentity::capture(std::process::id()).map_err(|_| Code::UnsupportedContext)?;
        #[cfg(windows)]
        let runtime = ProxyRuntime::WindowsNative;
        #[cfg(not(windows))]
        let runtime = ProxyRuntime::PosixOrFish;
        let proxy = argv.publish(&root, owner.clone(), runtime, |path| {
            path.to_str().map(str::to_owned).ok_or_else(|| std::io::Error::other("non-Unicode SSH helper path"))
        }).map_err(|_| Code::UnsupportedContext)?;
        let encoded = (|| {
            #[allow(unused_mut)]
            let mut args = proxy.argv().to_vec();
            #[cfg(windows)]
            {
                args[0] = crate::pty_manager::ssh_shell::posix::native_ssh_outer_path(&self.shell, &args[0])?;
            }
            #[cfg(unix)]
            if self.definition.target.hops.len() == 2 {
                return launch::encode_launch_with_posix_proxy(&self.shell, args, &root, owner);
            }
            launch::encode_launch(&self.shell, args, &root, owner)
        })();
        match encoded {
            Ok(encoded) => Ok(Payload {
                encoded,
                proxy,
                submitted: Submission {
                    definition_revision: self.definition.revision,
                    ready: self.ready.clone(),
                    nonce: self.nonce.clone(),
                    shell: self.identity.clone(),
                },
            }),
            Err(_) => {
                let _ = proxy.finish_after_quiescence();
                Err(Code::UnsupportedShell.into())
            }
        }
    }
}

fn eligible(gate: Gate) -> bool {
    matches!(gate, Gate::Verified | Gate::NetworkError)
}

struct Driver<'a, P> {
    registry: &'a LaunchRegistry,
    sessions: &'a SessionRegistry,
    store: &'a Store,
    port: &'a P,
    terminal: &'a str,
    generation: u64,
    home: &'a Path,
}

enum Step {
    Stop,
    Wait,
    CheckPrompt(String, ProcessIdentity),
    Submit(Box<Candidate>),
}

impl LaunchRegistry {
    pub(crate) fn start_native<R: Runtime>(
        self: &Arc<Self>, state: AppState<R>, store: Store, snapshot: &LaunchSnapshot,
    ) {
        let sessions = state.ssh_sessions.clone();
        self.start(Arc::new(state), sessions, store, super::session::native_home(), snapshot);
    }

    pub(super) fn start<P: LaunchPort + Send + Sync + 'static>(
        self: &Arc<Self>, port: Arc<P>, sessions: Arc<SessionRegistry>, store: Store,
        home: PathBuf, snapshot: &LaunchSnapshot,
    ) {
        let terminal = snapshot.terminal_id.clone();
        let generation = snapshot.attempt.session_generation;
        {
            let mut attempts = self.0.lock();
            let Some(entry) = attempts.get_mut(&terminal) else { return };
            if entry.snapshot.attempt.session_generation != generation || !entry.snapshot.stage.waiting() || entry.driving {
                return;
            }
            entry.driving = true;
        }
        let registry = self.clone();
        engine_runtime().spawn(async move {
            loop {
                let (registry, port, sessions, store, terminal, home) = (
                    registry.clone(), port.clone(), sessions.clone(), store.clone(), terminal.clone(), home.clone(),
                );
                let step = tokio::task::spawn_blocking(move || Driver {
                    registry: &registry, sessions: &sessions, store: &store,
                    port: &*port, terminal: &terminal, generation, home: &home,
                }.tick(Instant::now())).await;
                if !matches!(step, Ok(true)) { break; }
                tokio::time::sleep(CHECK_INTERVAL).await;
            }
        });
    }
}

impl<P: LaunchPort> Driver<'_, P> {
    fn keys(&self) -> &HostKeys { self.port.input_keys() }

    /// Returns true only when the worker should continue waiting. No sleep or
    /// session public state is used as authorization: polling just wakes the
    /// decision, which relies on the nonce epoch and 067's typed receipt.
    fn tick(&self, now: Instant) -> bool {
        let candidate = match self.pick(now) {
            Step::Wait => return true,
            Step::Stop => return false,
            Step::CheckPrompt(shell, identity) => {
                if !self.port.bare_shell(&shell, &identity) {
                    return self.wait_ready(now);
                }
                let mut attempts = self.registry.0.lock();
                let Some(entry) = attempts.get_mut(self.terminal) else { return false };
                if entry.snapshot.attempt.session_generation != self.generation || !entry.snapshot.stage.waiting() {
                    return false;
                }
                entry.waiting_since = None;
                let mut next = entry.snapshot.clone();
                next.stage = LaunchStage::WaitingTrust;
                let _ = entry.update(next);
                return true;
            }
            Step::Submit(candidate) => candidate,
        };
        if !self.port.bare_shell(&candidate.shell, &candidate.identity) {
            return self.wait_ready(now);
        }
        let payload = match candidate.encode(self.port, self.home) {
            Ok(payload) => payload,
            Err(err) => {
                self.finish(Err(err), None);
                return false;
            }
        };
        let possibly_written = Cell::new(false);
        let admitted = Cell::new(false);
        let waiting_trust = Cell::new(false);
        let bytes = payload.encoded.bytes();
        let result = self.keys().submit_ssh_input_fenced(&candidate.ticket, &candidate.ready,
            &Fence { driver: self, candidate: &candidate, waiting_trust: &waiting_trust }, |permit| {
                admitted.set(true);
                if self.keys().mounted_launch_owner(self.terminal, &candidate.process)
                    != Some((candidate.owner, candidate.placement))
                {
                    return Err(Code::StaleAttempt.into());
                }
                if permit.host_prompt() || self.port.hosted(permit.process()) {
                    if !permit.host_prompt() || !self.port.enqueue_hosted(permit, bytes) {
                        return Err(Code::TransportClosed.into());
                    }
                    possibly_written.set(true);
                    return Ok(InputDispatch::Complete(()));
                }
                let writer = self.port.local_writer(permit.process()).ok_or(Code::TransportClosed)?;
                let possibly_written = &possibly_written;
                Ok(InputDispatch::local(move || {
                    let mut writer = writer.lock().map_err(|_| Code::WriteFailed)?;
                    possibly_written.set(true);
                    writer.write_all(bytes).map_err(|_| Code::WriteFailed.into())
                }))
            },
        );
        let payload = if possibly_written.get() {
            Some(payload)
        } else {
            payload.finish_after_quiescence();
            None
        };
        // A live trust wait discovered before admission has not consumed the
        // ticket or prompt. At the local FIFO head it is already consumed:
        // never replay that turn, even if no bytes reached the writer.
        if waiting_trust.get() && !admitted.get() {
            return true;
        }
        self.finish(result, payload);
        false
    }

    fn pick(&self, now: Instant) -> Step {
        self.sessions.with_launch_authority(self.terminal, |view, placement, cancelled, definition| {
            let keys = self.keys();
            let _order = keys.input_owner_change();
            let mut attempts = self.registry.0.lock();
            let Some(entry) = attempts.get_mut(self.terminal) else { return Step::Stop };
            if entry.snapshot.attempt.session_generation != self.generation || !entry.snapshot.stage.waiting() {
                return Step::Stop;
            }
            let mut next = entry.snapshot.clone();
            if view.generation != self.generation {
                return Self::end(keys, entry, next, LaunchStage::Blocked, Code::StaleAttempt);
            }
            if view.connection_id != next.connection_id {
                return Self::end(keys, entry, next, LaunchStage::Error, Code::StaleAttempt);
            }
            next.attempt.attempt_receipt = view.into();
            if refused(view, cancelled) {
                return Self::end(keys, entry, next, LaunchStage::Blocked, Code::TrustBlocked);
            }
            let process = next.attempt.process_incarnation.clone();
            if !keys.owns_process(&process) {
                return Self::end(keys, entry, next, LaunchStage::Error, Code::TransportClosed);
            }
            let Some((owner, cg)) = keys.mounted_launch_owner(self.terminal, &process) else {
                return Self::waiting_ready(keys, entry, next, now);
            };
            if Some(cg) != placement || keys.ssh_launch_connection(&process).as_deref() != Some(view.connection_id.as_str()) {
                return Self::end(keys, entry, next, LaunchStage::Error, Code::StaleAttempt);
            }
            next.attempt.owner_incarnation = owner;
            let Some(ticket) = entry.ticket.as_mut() else { return Step::Stop };
            let ready = match keys.launch_ready_ordered(ticket) {
                Ok(Some(ready)) => ready,
                Ok(None) => return Self::waiting_ready(keys, entry, next, now),
                Err(_) => return Self::end(keys, entry, next, LaunchStage::Error, Code::StaleAttempt),
            };
            let Some((shell, identity)) = keys.ssh_shell_identity(&process) else {
                return Self::end(keys, entry, next, LaunchStage::Error, Code::UnsupportedShell);
            };
            if !eligible(view.gate) {
                let _ = entry.update(next);
                return Step::CheckPrompt(shell, identity);
            }
            let Some(definition) = definition else {
                return Self::end(keys, entry, next, LaunchStage::Error, Code::StoreUnavailable);
            };
            let Some(nonce) = keys.ssh_prompt_nonce(&process) else {
                return Self::end(keys, entry, next, LaunchStage::Error, Code::StaleAttempt);
            };
            let ticket = ticket.clone();
            let receipt = next.attempt.attempt_receipt.clone();
            let _ = entry.update(next);
            Step::Submit(Box::new(Candidate {
                process, owner, placement: cg, ticket, ready, nonce, receipt,
                definition: definition.clone(), shell, identity,
            }))
        }).unwrap_or_else(|| {
            self.finish(Err(Code::TrustBlocked.into()), None);
            Step::Stop
        })
    }

    fn wait_ready(&self, now: Instant) -> bool {
        let keys = self.keys();
        let _order = keys.input_owner_change();
        let mut attempts = self.registry.0.lock();
        let Some(entry) = attempts.get_mut(self.terminal) else { return false };
        if entry.snapshot.attempt.session_generation != self.generation || !entry.snapshot.stage.waiting() {
            return false;
        }
        let next = entry.snapshot.clone();
        matches!(Self::waiting_ready(keys, entry, next, now), Step::Wait)
    }

    fn waiting_ready(keys: &HostKeys, entry: &mut super::RegisteredAttempt, mut next: LaunchSnapshot, now: Instant) -> Step {
        let start = *entry.waiting_since.get_or_insert(now);
        if now.saturating_duration_since(start) >= READY_TIMEOUT {
            return Self::end(keys, entry, next, LaunchStage::Error, Code::Timeout);
        }
        next.stage = if next.attempt.attempt_receipt.gate == Gate::Blocked {
            LaunchStage::WaitingTrust
        } else {
            LaunchStage::WaitingReady
        };
        let _ = entry.update(next);
        Step::Wait
    }

    fn end(keys: &HostKeys, entry: &mut super::RegisteredAttempt, mut next: LaunchSnapshot, stage: LaunchStage, code: Code) -> Step {
        if let Some(ticket) = entry.ticket.take() {
            let _ = keys.cancel_registered_launch_ordered(&ticket);
        }
        next.stage = stage;
        next.error = Some(code.into());
        let _ = entry.update(next);
        Step::Stop
    }

    fn finish(&self, result: Result<(), LaunchError>, mut payload: Option<Payload>) {
        let mut retiring = None;
        let mut record = |result: Result<(), LaunchError>| {
            let keys = self.keys();
            let _order = keys.input_owner_change();
            let mut attempts = self.registry.0.lock();
            let entry = attempts.get_mut(self.terminal)?;
            if entry.snapshot.attempt.session_generation != self.generation || !entry.snapshot.stage.waiting() {
                return None;
            }
            entry.payload = payload.take().map(Arc::new);
            let mut next = entry.snapshot.clone();
            if let Err(err) = result {
                retiring = entry.payload.clone();
                let stage = if err.code == Code::TrustBlocked { LaunchStage::Blocked } else { LaunchStage::Error };
                Self::end(keys, entry, next, stage, err.code);
                return None;
            }
            // Writer acceptance only. Do not equate a queued hosted frame
            // with a child, a remote login, or even delivery to the PTY.
            next.stage = LaunchStage::Typed;
            entry.update(next).ok()?;
            Some((entry.snapshot.launch_seq, entry.snapshot.attempt.process_incarnation.clone()))
        };
        let typed = match result {
            Err(err) => record(Err(err)),
            Ok(()) => self.sessions.with_launch_authority(self.terminal, |view, _, cancelled, _| {
                if view.generation == self.generation && !cancelled {
                    record(Ok(()))
                } else {
                    record(Err(Code::TrustBlocked.into()))
                }
            }).unwrap_or_else(|| record(Err(Code::TrustBlocked.into()))),
        };
        if let Some(payload) = retiring { payload.retire(); }
        if let Some(payload) = payload { payload.retire(); }
        if let Some((seq, process)) = typed {
            if self.sessions.on_launch_lifecycle(self.terminal, self.generation, seq, LaunchState::Typed, Some(process)).is_ok() {
                self.port.typed(self.terminal);
            }
        }
    }
}

struct Fence<'a, 'd, P> {
    driver: &'a Driver<'d, P>,
    candidate: &'a Candidate,
    waiting_trust: &'a Cell<bool>,
}
impl<P: LaunchPort> InputFence<LaunchError> for Fence<'_, '_, P> {
    fn qualify<T>(&self, work: impl FnOnce() -> Result<T, LaunchError>) -> Result<T, LaunchError> {
        let c = self.candidate;
        let d = self.driver;
        if !d.port.bare_shell(&c.shell, &c.identity) {
            return Err(Code::StaleAttempt.into());
        }
        // Store -> 067 membership/entry -> Lane A ownership barrier. Keep the
        // store edit/cancel fence until admission or FIFO head, not across I/O.
        d.store.with_launch_snapshot(|data, revision| {
            if revision != c.definition.revision
                || !target::resolve(data, &c.definition.target.hops.last().expect("validated target").connection_id)
                    .is_ok_and(|target| target == c.definition.target)
            {
                return Err(Code::StaleAttempt.into());
            }
            d.sessions.with_launch_authority(d.terminal, |view, owner, cancelled, definition| {
                if view.generation != d.generation || refused(view, cancelled) {
                    return Err(Code::TrustBlocked.into());
                }
                if owner != Some(c.placement) || definition != Some(&c.definition) {
                    return Err(Code::StaleAttempt.into());
                }
                if !eligible(view.gate) {
                    self.waiting_trust.set(true);
                    return Err(Code::StaleAttempt.into());
                }
                if view.gate != c.receipt.gate || view.known_hosts_paths != c.receipt.known_hosts_paths {
                    return Err(Code::StaleAttempt.into());
                }
                work()
            }).unwrap_or_else(|| Err(Code::TrustBlocked.into()))
        }).map_err(|_| Code::StoreUnavailable)?
    }
}

#[cfg(test)]
mod tests;
