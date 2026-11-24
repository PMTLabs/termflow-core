//! Admission, one-shot dispatch and the accepted command's lifecycle.
use super::{refused, AttemptReceipt, Gate, LaunchError, LaunchErrorCode as Code, LaunchRegistry, LaunchSnapshot, LaunchStage};
use crate::{
    pty_manager::{
        input_gate::{BoundSshShell, InputBackend, InputDispatch, InputFence, LaunchTicket, ReadyEpoch},
        ssh_helpers::{HelperRoot, ProcessIdentity},
        ssh_shell::posix::launch::{self, EncodedLaunch},
    },
    ssh::{
        launch_argv::{build_launch_argv, ProxyRuntime, PublishedLaunch},
        launch_process::{self, Observation, Tracker, NO_START},
        session::{engine_runtime, LaunchDefinition, LaunchState, SessionRegistry},
        sessions,
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
struct LaunchEvent<'a> {
    terminal_id: &'a str,
    state: &'static str,
}

/// Admission and lifecycle tests use the same gate, argv encoder and native
/// watcher as the desktop. The port supplies the input and event endpoints.
pub(super) trait LaunchPort: InputBackend {
    fn helper_root(&self) -> Result<HelperRoot, LaunchError>;
    fn open_ssh(&self) -> Result<String, LaunchError>;
    fn bare_shell(&self, bound: &BoundSshShell) -> bool;
    fn launch_state(&self, terminal: &str, state: &'static str);
    #[cfg(test)]
    fn record_child_sample(&self) {}
}

impl<R: Runtime> LaunchPort for AppState<R> {
    fn helper_root(&self) -> Result<HelperRoot, LaunchError> {
        HelperRoot::for_app(&self.app_handle).map_err(|error| {
            log::warn!("SSH launch helper root unavailable: {error}");
            Code::UnsupportedContext.into()
        })
    }
    fn open_ssh(&self) -> Result<String, LaunchError> {
        let path = native_ssh()?;
        if !Path::new(&path).is_file() {
            return Err(Code::UnsupportedContext.into());
        }
        Ok(path)
    }
    fn bare_shell(&self, bound: &BoundSshShell) -> bool {
        native_bare_shell(bound)
    }
    fn launch_state(&self, terminal: &str, state: &'static str) {
        let _ = self.app_handle.emit("ssh-launch:state", LaunchEvent { terminal_id: terminal, state });
    }
}

#[cfg(any(windows, test))]
mod bare_shell;

fn native_bare_shell(bound: &BoundSshShell) -> bool {
    #[cfg(windows)]
    return bare_shell::native(bound);
    #[cfg(not(windows))]
    {
        let Some((identity, _)) = bound.effective_identity() else { return false };
        let mut system = sysinfo::System::new();
        system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        let pid = sysinfo::Pid::from_u32(identity.pid);
        system.process(pid).is_some_and(|process| {
            identity.is_live()
                && Path::new(&bound.shell).file_name().is_some_and(|name| {
                    name.to_string_lossy().eq_ignore_ascii_case(&process.name().to_string_lossy())
                })
                && !system.processes().values().any(|p| p.parent() == Some(pid))
        })
    }
}

pub(crate) fn native_powershell_launcher(shell: &str, identity: &ProcessIdentity) -> bool {
    use crate::pty_manager::ssh_shell::posix::windows;
    if windows::dialect(shell) != Some(true) {
        return false;
    }
    let mut system = sysinfo::System::new();
    let pid = sysinfo::Pid::from_u32(identity.pid);
    // The default process refresh does not populate argv in sysinfo 0.33.
    system.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::Some(&[pid]),
        true,
        sysinfo::ProcessRefreshKind::nothing()
            .with_cmd(sysinfo::UpdateKind::Always)
            .with_exe(sysinfo::UpdateKind::OnlyIfNotSet),
    );
    system.process(pid).is_some_and(|process| {
        identity.is_live()
            && Path::new(shell).file_name().is_some_and(|name| {
                name.to_string_lossy()
                    .eq_ignore_ascii_case(&process.name().to_string_lossy())
            })
            && process
                .cmd()
                .iter()
                .map(|arg| arg.to_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()
                .is_some_and(|argv| windows::has_powershell_launcher(&argv))
    })
}

pub(crate) fn encode_for_shell(
    shell: &str,
    args: Vec<String>,
    root: &HelperRoot,
    owner: ProcessIdentity,
    _hop_count: usize,
    powershell_hook: bool,
) -> std::io::Result<EncodedLaunch> {
    // The fixed POSIX proxy interpreter applies to Bourne/fish launch bodies,
    // not to PowerShell, whose encoder never uses that prefix.
    if powershell_hook {
        return launch::encode_launch_with_powershell_hook(shell, args, root, owner);
    }
    #[cfg(unix)]
    if _hop_count == 2 {
        return launch::encode_launch_with_posix_proxy(shell, args, root, owner);
    }
    launch::encode_launch(shell, args, root, owner)
}

fn native_ssh() -> Result<String, LaunchError> {
    #[cfg(windows)]
    return crate::pty_manager::ssh_shell::native_ssh_client().map_err(native_ssh_error);
    #[cfg(not(windows))]
    Ok("/usr/bin/ssh".into())
}

#[cfg_attr(not(windows), allow(dead_code))]
fn native_ssh_error(error: crate::pty_manager::ssh_shell::NativeSshClient) -> LaunchError {
    use crate::pty_manager::ssh_shell::NativeSshClient;
    match error {
        NativeSshClient::Missing => Code::SshClientMissing.into(),
        NativeSshClient::Unavailable => Code::UnsupportedContext.into(),
    }
}

pub(super) struct Payload {
    encoded: EncodedLaunch,
    proxy: PublishedLaunch,
    // Never serialized. These associate the process sample and command
    // boundary with this exact, immutable submission.
    _definition_revision: u64,
    ready: ReadyEpoch,
    nonce: String,
    command: launch_process::Command,
}

pub(super) struct Watcher {
    accepted_at: Instant,
    ended_at: Option<Instant>,
    child: Tracker,
}

impl Watcher {
    fn new(accepted_at: Instant) -> Self {
        Self { accepted_at, ended_at: None, child: Tracker::default() }
    }
}
impl Payload {
    pub(super) fn retire(&self) {
        let _ = self.encoded.retire_payload();
        let _ = self.proxy.retire_payload();
    }
    // Positive non-submission: even a proxy helper was never reachable.
    fn finish_unsubmitted(self) {
        let _ = self.encoded.finish_after_quiescence();
        let _ = self.proxy.finish_after_quiescence();
    }

    fn finish_after_return(self) {
        let _ = self.encoded.finish_after_quiescence();
        // The foreground command returned, but an abruptly terminated SSH
        // could have left an orphaned ProxyCommand about to open its script.
        // Retire that separate pin without guessing it is quiescent.
        let _ = self.proxy.retire_payload();
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
    bound: BoundSshShell,
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
        let marker = launch_process::marker();
        let encoded = (|| {
            let mut args = proxy.argv().to_vec();
            args.splice(1..1, ["-o".into(), marker.clone()]);
            #[cfg(windows)]
            {
                args[0] = crate::pty_manager::ssh_shell::posix::native_ssh_outer_path(&self.shell, &args[0])?;
            }
            encode_for_shell(
                &self.shell,
                args,
                &root,
                owner,
                self.definition.target.hops.len(),
                self.bound.effective_identity()
                    .is_some_and(|(identity, _)| native_powershell_launcher(&self.shell, &identity)),
            )
        })();
        match encoded {
            Ok(encoded) => Ok(Payload {
                command: launch_process::Command {
                    shell: None, posix_fork_stub: false, // Set in tick after shell resolution.
                    exe: std::fs::canonicalize(&ssh).unwrap_or_else(|_| PathBuf::from(ssh)),
                    marker,
                    intermediary: encoded.intermediary().map(<[String]>::to_vec),
                },
                encoded,
                proxy,
                _definition_revision: self.definition.revision,
                ready: self.ready.clone(),
                nonce: self.nonce.clone(),
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
    CheckPrompt(BoundSshShell),
    Submit(Box<Candidate>),
}

impl LaunchRegistry {
    pub(crate) fn start_native<R: Runtime>(
        self: &Arc<Self>, state: AppState<R>, store: Store, snapshot: &LaunchSnapshot,
    ) {
        let sessions = state.ssh_sessions.clone();
        self.start(Arc::new(state), sessions, store, crate::ssh::session::native_home(), snapshot);
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
            let mut observing = false;
            loop {
                let (registry, port, sessions, store, terminal, home) = (
                    registry.clone(), port.clone(), sessions.clone(), store.clone(), terminal.clone(), home.clone(),
                );
                let step = tokio::task::spawn_blocking(move || {
                    let driver = Driver {
                        registry: &registry, sessions: &sessions, store: &store,
                        port: &*port, terminal: &terminal, generation, home: &home,
                    };
                    if observing { driver.observe(Instant::now()) } else { driver.tick(Instant::now()) }
                }).await;
                match step {
                    Ok(true) => tokio::time::sleep(CHECK_INTERVAL).await,
                    Ok(false) if !observing => observing = true,
                    _ => break,
                }
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
            Step::CheckPrompt(bound) => {
                if !self.port.bare_shell(&bound) {
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
        if !self.port.bare_shell(&candidate.bound) {
            return self.wait_ready(now);
        }
        let Some((_, birth)) = candidate.bound.effective_identity() else {
            return self.wait_ready(now);
        };
        let mut payload = match candidate.encode(self.port, self.home) {
            Ok(payload) => payload,
            Err(err) => {
                self.finish(Err(err), None);
                return false;
            }
        };
        payload.command.shell = Some(birth);
        #[cfg(windows)]
        {
            payload.command.posix_fork_stub = crate::pty_manager::ssh_shell::posix::uses_native_fork_stub(&candidate.shell);
        }
        let possibly_written = Cell::new(false);
        let admitted = Cell::new(false);
        let waiting_trust = Cell::new(false);
        let waiting_shell = Cell::new(false);
        let bytes = payload.encoded.bytes();
        let result = self.keys().submit_ssh_input_fenced(&candidate.ticket, &candidate.ready,
            &Fence { driver: self, candidate: &candidate, waiting_trust: &waiting_trust, waiting_shell: &waiting_shell }, |permit| {
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
            payload.finish_unsubmitted();
            None
        };
        if waiting_shell.get() && !admitted.get() {
            return self.wait_ready(now);
        }
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
            let Some(bound) = keys.ssh_shell_identity(&process) else {
                return Self::end(keys, entry, next, LaunchStage::Error, Code::UnsupportedShell);
            };
            if !eligible(view.gate) {
                let _ = entry.update(next);
                return Step::CheckPrompt(bound);
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
                definition: definition.clone(), shell: bound.shell.clone(), bound,
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
            entry.watcher = Some(Watcher::new(Instant::now()));
            Some((entry.snapshot.launch_seq, entry.snapshot.attempt.process_incarnation.clone()))
        };
        let typed = match result {
            Err(err) => record(Err(err)),
            Ok(()) => self.sessions.with_launch_authority(self.terminal, |view, _, _, _| {
                // The app lease can fail during I/O. It does not undo writer
                // acceptance; explicit launch Cancel already changes the stage.
                if view.generation == self.generation {
                    record(Ok(()))
                } else {
                    record(Err(Code::TrustBlocked.into()))
                }
            }).unwrap_or_else(|| record(Err(Code::TrustBlocked.into()))),
        };
        if let Some(payload) = retiring { payload.retire(); }
        if let Some(payload) = payload { payload.retire(); }
        if let Some((seq, process)) = typed {
            self.emit(seq, process, LaunchState::Typed);
        }
    }

    fn observe(&self, now: Instant) -> bool {
        // Never poll the OS while holding ownership or the session registry.
        let (payload, running) = {
            let attempts = self.registry.0.lock();
            let Some(entry) = attempts.get(self.terminal) else { return false };
            if entry.snapshot.attempt.session_generation != self.generation { return false; }
            let Some(watch) = &entry.watcher else { return false };
            let running = (entry.snapshot.stage == LaunchStage::Running).then(|| watch.child.running()).flatten();
            (entry.payload.clone().expect("watcher pins an accepted payload"), running)
        };
        #[cfg(test)]
        self.port.record_child_sample();
        let sample = match running {
            Some(child) => payload.command.sample_running(child),
            None => payload.command.sample(),
        };
        let mut event = None;
        let mut finished = None;
        let mut retired = None;
        let keep = self.sessions.with_launch_authority(self.terminal, |view, placement, _, _| {
            let keys = self.keys();
            let _order = keys.input_owner_change();
            let mut attempts = self.registry.0.lock();
            let Some(entry) = attempts.get_mut(self.terminal) else { return false };
            if entry.snapshot.attempt.session_generation != self.generation {
                return false;
            }
            let process = entry.snapshot.attempt.process_incarnation.clone();
            let mut watch = match entry.watcher.take() {
                Some(watch) => watch,
                None => return false,
            };
            let valid = view.generation == self.generation && placement == Some(entry.placement)
                && keys.input_stamp(&process).is_some_and(|stamp| stamp.generation == entry.placement);
            let Some(boundary) = valid.then(|| keys.launch_boundary(&payload.ready, &payload.nonce)).flatten() else {
                retired = entry.payload.take();
                return false;
            };
            let returned = boundary.returned && sample.bare;
            let stage = entry.snapshot.stage;
            let transition = match stage {
                // Typed only: a Running ssh keeps being sampled by PID, so it survives a host hot-swap.
                LaunchStage::Typed if boundary.transport_lost => {
                    Some((LaunchStage::Ended, LaunchState::Ended, Some(Code::TransportClosed.into())))
                }
                LaunchStage::Typed if boundary.returned || now.saturating_duration_since(watch.accepted_at) >= NO_START => {
                    // Works with old hosts and with partial host-side writes:
                    // the queue has no delivery feedback and must not replay.
                    Some((LaunchStage::Ended, LaunchState::Ended, Some(typed_end_error(boundary.returned))))
                }
                LaunchStage::Running if boundary.returned => Some((LaunchStage::Ended, LaunchState::Ended, None)),
                LaunchStage::Typed | LaunchStage::Running => match watch.child.sample(&sample, now, !boundary.extra_input) {
                    Observation::Running => Some((LaunchStage::Running, LaunchState::Running, None)),
                    Observation::Exited => Some((LaunchStage::Ended, LaunchState::Ended, None)),
                    Observation::Wait => None,
                },
                LaunchStage::Ended => None,
                _ => return false,
            };
            if let Some((stage, state, error)) = transition {
                let mut next = entry.snapshot.clone();
                next.stage = stage;
                next.error = error;
                if let Some((owner, _)) = keys.mounted_launch_owner(self.terminal, &process) {
                    next.attempt.owner_incarnation = owner;
                }
                if entry.update(next).is_err() { return false; }
                if stage == LaunchStage::Ended { watch.ended_at = Some(now); }
                event = Some((entry.snapshot.launch_seq, process, state));
            }
            if let Some(ended_at) = watch.ended_at {
                if returned {
                    finished = entry.payload.take();
                    return false;
                }
                if boundary.transport_lost || now.saturating_duration_since(ended_at) >= NO_START {
                    retired = entry.payload.take();
                    return false;
                }
            }
            entry.watcher = Some(watch);
            true
        });
        drop(payload);
        if let Some((seq, process, state)) = event { self.emit(seq, process, state); }
        if let Some(payload) = finished {
            if let Ok(payload) = Arc::try_unwrap(payload) { payload.finish_after_return(); }
        }
        if let Some(payload) = retired { payload.retire(); }
        if keep.is_none() {
            // Session closed independently of its pane. Drop this exact
            // observer without removing the pane or retaining its payload.
            let retired = {
                let mut attempts = self.registry.0.lock();
                attempts.get_mut(self.terminal)
                    .filter(|entry| entry.snapshot.attempt.session_generation == self.generation)
                    .and_then(|entry| { entry.watcher = None; entry.payload.take() })
            };
            if let Some(payload) = retired { payload.retire(); }
        }
        keep.unwrap_or(false)
    }

    fn emit(&self, seq: u64, process: String, state: LaunchState) {
        let applied = sessions::on_launch_lifecycle(self.sessions, self.terminal, self.generation, seq, state, Some(process.clone()));
        if applied.is_ok() || self.sessions.observe_revoked_launch(self.terminal, self.generation, seq, state, &process) {
            self.port.launch_state(self.terminal, match state {
                LaunchState::Typed => "typed",
                LaunchState::Running => "running",
                LaunchState::Ended => "ended",
            });
        }
    }
}

struct Fence<'a, 'd, P> {
    driver: &'a Driver<'d, P>,
    candidate: &'a Candidate,
    waiting_trust: &'a Cell<bool>,
    waiting_shell: &'a Cell<bool>,
}
impl<P: LaunchPort> InputFence<LaunchError> for Fence<'_, '_, P> {
    fn qualify<T>(&self, work: impl FnOnce() -> Result<T, LaunchError>) -> Result<T, LaunchError> {
        let c = self.candidate;
        let d = self.driver;
        if !d.port.bare_shell(&c.bound) {
            // A prompt substitution can start after the readiness hook.
            self.waiting_shell.set(true);
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

// A returned shell after an accepted write means SSH ran and exited,
// regardless of whether the process sampler observed it.
fn typed_end_error(returned: bool) -> LaunchError {
    if returned {
        Code::SshExitedBeforeConnecting.into()
    } else {
        LaunchError {
            code: Code::WriteFailed,
            message: "SSH did not start in the terminal. The command was not retried.",
        }
    }
}

#[cfg(test)]
#[test]
fn returned_after_accepted_write_does_not_depend_on_sampling() {
    // Typed is reached only after writer acceptance; no PID sample is required.
    assert_eq!(typed_end_error(true).code, Code::SshExitedBeforeConnecting);
    // A NO_START timeout with no shell return is not evidence ssh exited.
    assert_eq!(typed_end_error(false).code, Code::WriteFailed);
}

#[cfg(test)]
mod tests;
