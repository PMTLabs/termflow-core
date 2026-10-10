//! The MCP hold: lets the host keep an MCP port answering while the GUI is away
//! (plan 054). This module is the manager-facing half only: the state the
//! manager keeps (`McpHold`), the command channel to the holder task (`Mode`)
//! and the handle the manager keeps to that task (`HolderHandle`).
//!
//! The holder task owns its own lifetime. The manager only sends it commands
//! through a `watch` and never awaits it, so every control handler stays
//! synchronous and every reply is enqueued by the handler of the frame it
//! answers (plan 054 §3, §4.3).
//!
//! The real holder (bind retry, HTTP, timers) lives in [`holder`]; the
//! production spawn function is [`holder::production_spawn`].

pub mod holder;
mod http;
mod message;
mod rpc;

use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll, Waker};
use std::time::Duration;
use termflow_pty_protocol::{McpHeld, McpHoldSpec};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::{timeout, timeout_at, Instant};

pub use holder::note_order;

/// What the manager tells the holder task to do. `Stop` is terminal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// The GUI is gone; answer agents with the "restarting" message.
    Absent,
    /// A relaunched GUI claimed the hold; answer with the "starting again" message.
    Handback,
    /// Close the listener and every connection, then end.
    Stop,
}

/// Starts a holder task for an accepted spec. A field of the manager so tests
/// inject a stub that records the modes it sees and ends on `Stop`. The task
/// must read the stored `Mode` at start and after every wake-up (not only on
/// change) and treat a dropped sender as `Stop`.
///
/// `Sync` as well as `Send`: the manager is borrowed (`&SessionManager`) across
/// awaits in `serve`, which is spawned onto a multi-threaded runtime.
///
/// Called from synchronous manager code that runs inside the tokio runtime, so
/// an implementation may `tokio::spawn`.
pub type SpawnHolder = Box<dyn FnMut(McpHoldSpec, watch::Receiver<Mode>) -> JoinHandle<()> + Send + Sync>;

/// The manager's grip on a running holder task.
pub struct HolderHandle {
    mode: watch::Sender<Mode>,
    join: JoinHandle<()>,
    held: McpHeld,
}

impl HolderHandle {
    fn finished(&self) -> bool {
        self.join.is_finished()
    }

    fn mode(&self) -> Mode {
        *self.mode.borrow()
    }

    /// Order the stop. `send_replace` stores the value even if the task has
    /// already dropped every receiver, so a task spawned late still sees it.
    fn order_stop(&self) {
        self.mode.send_replace(Mode::Stop);
    }
}

enum State {
    /// Nothing accepted, or the last holder was told to stop.
    Idle,
    /// `HoldMcp` accepted while a GUI is connected.
    Pending(McpHoldSpec),
    /// The holder task exists, in mode `Absent` or `Handback`.
    Running(HolderHandle),
}

/// Why a `HoldMcp` was refused for a reason that lives in this state (the
/// manager adds the arm-related reasons).
pub const REASON_ALREADY_HOLDING: &str = "already holding";
pub const REASON_PREVIOUS_STOPPING: &str = "previous holder still stopping";

/// The MCP-hold state machine (plan 054 §4.3). Pure bookkeeping: it never
/// blocks and never awaits the holder.
pub struct McpHold {
    state: State,
    /// A stopped holder whose task has not finished yet. `HoldMcp` is refused
    /// while it exists, so at most one holder task and one spec exist at a time.
    retiring: Option<HolderHandle>,
    spawn: SpawnHolder,
}

impl McpHold {
    pub fn new(spawn: SpawnHolder) -> Self {
        Self { state: State::Idle, retiring: None, spawn }
    }

    /// A holder that ended on its own (grace, hard cap, panic) reads as Idle,
    /// and a retired holder that finished stops blocking a new hold.
    fn reconcile(&mut self) {
        if matches!(&self.state, State::Running(h) if h.finished()) {
            if let State::Running(h) = std::mem::replace(&mut self.state, State::Idle) {
                log::info!("[MCP-HOLD] holder ended on its own; state is Idle");
                reap(h);
            }
        }
        if self.retiring.as_ref().is_some_and(HolderHandle::finished) {
            if let Some(h) = self.retiring.take() {
                reap(h);
            }
        }
    }

    /// Why a new `HoldMcp` cannot be taken regardless of the arm, if so.
    pub fn hold_blocker(&mut self) -> Option<&'static str> {
        self.reconcile();
        if matches!(self.state, State::Running(_)) {
            return Some(REASON_ALREADY_HOLDING);
        }
        if self.retiring.is_some() {
            return Some(REASON_PREVIOUS_STOPPING);
        }
        None
    }

    /// Store an accepted spec (Idle or Pending -> Pending). The caller has
    /// already checked [`McpHold::hold_blocker`] and the arm.
    pub fn set_pending(&mut self, spec: McpHoldSpec) {
        self.reconcile();
        if matches!(self.state, State::Running(_)) {
            return; // unreachable through the manager; never replace a live holder
        }
        self.state = State::Pending(spec);
    }

    /// Pending -> Idle. A running holder is untouched.
    pub fn clear_pending(&mut self) {
        self.reconcile();
        if matches!(self.state, State::Pending(_)) {
            self.state = State::Idle;
        }
    }

    /// Order the holder to stop and forget the pending spec. Returns whether a
    /// running holder was stopped (`McpReleaseAck::was_holding`). The stopped
    /// task moves to `retiring` until it has finished.
    pub fn stop(&mut self) -> bool {
        self.reconcile();
        match std::mem::replace(&mut self.state, State::Idle) {
            State::Running(h) => {
                h.order_stop();
                note_order("holder-stop-ordered");
                log::info!("[MCP-HOLD] stop ordered");
                self.retiring = Some(h);
                true
            }
            State::Pending(_) | State::Idle => false,
        }
    }

    /// Whether a holder task is running and has not ended on its own. Read-only
    /// (it does not reap), so the transport can ask it between awaits.
    pub fn is_running(&self) -> bool {
        matches!(&self.state, State::Running(h) if !h.finished())
    }

    /// Orders every holder to stop and hands over their join handles, so
    /// `serve` can await the cleanup on its way out (see [`finish`]).
    pub fn take_for_shutdown(&mut self) -> Vec<JoinHandle<()>> {
        self.stop();
        self.state = State::Idle;
        self.retiring.take().into_iter().map(|h| h.join).collect()
    }

    /// `ClaimMcp` from an authenticated GUI. Running (Absent) moves to Handback;
    /// Running (Handback) is idempotent and does not extend the grace. Reports
    /// what is held whether or not the bind has succeeded yet.
    pub fn claim(&mut self) -> Option<McpHeld> {
        self.reconcile();
        match &self.state {
            State::Running(h) => {
                if h.mode() == Mode::Absent {
                    h.mode.send_replace(Mode::Handback);
                    log::info!("[MCP-HOLD] claimed; handing back");
                }
                Some(h.held.clone())
            }
            State::Pending(_) => {
                self.state = State::Idle;
                None
            }
            State::Idle => None,
        }
    }

    /// A GUI adopted this host by an authenticated lifecycle frame. Pending is
    /// spent. A running holder in Absent stops unless the frame was the claim.
    pub fn on_adopted(&mut self, by_claim: bool) {
        self.reconcile();
        match &self.state {
            State::Pending(_) => self.state = State::Idle,
            State::Running(h) if h.mode() == Mode::Absent && !by_claim => {
                self.stop();
            }
            _ => {}
        }
    }

    /// `Disarm`: spends Pending and stops an Absent holder (only an old GUI
    /// sends `Disarm` before adopting). A Handback holder is unchanged.
    pub fn on_disarm(&mut self) {
        self.reconcile();
        match &self.state {
            State::Pending(_) => self.state = State::Idle,
            State::Running(h) if h.mode() == Mode::Absent => {
                self.stop();
            }
            _ => {}
        }
    }

    /// The connection ended. If it was the claiming GUI's, stop the holder; a
    /// holder in Absent survives (a silent connect-and-drop re-enters the hold).
    pub fn on_disconnect(&mut self) {
        self.reconcile();
        if matches!(&self.state, State::Running(h) if h.mode() == Mode::Handback) {
            self.stop();
        }
    }

    /// A Local absence was established (`begin_local_absence` returned `Some`).
    /// Pending starts the holder in Absent; Running is left alone: the same
    /// task keeps its listener and connections across a silent-reconnect
    /// re-entry.
    pub fn on_absence_begun(&mut self) {
        self.reconcile();
        if !matches!(self.state, State::Pending(_)) {
            return;
        }
        let State::Pending(spec) = std::mem::replace(&mut self.state, State::Idle) else {
            return;
        };
        let held = McpHeld {
            port: spec.port,
            configured_port: spec.configured_port,
            bind_host: spec.bind_host.clone(),
        };
        let (mode, rx) = watch::channel(Mode::Absent);
        let join = (self.spawn)(spec, rx);
        log::info!("[MCP-HOLD] holder started for port {}", held.port);
        self.state = State::Running(HolderHandle { mode, join, held });
    }

    #[cfg(test)]
    pub fn view(&mut self) -> View {
        self.reconcile();
        match &self.state {
            State::Idle => View::Idle,
            State::Pending(spec) => View::Pending(spec.clone()),
            State::Running(h) => View::Running(h.mode(), h.held.clone()),
        }
    }

    #[cfg(test)]
    pub fn has_retiring(&mut self) -> bool {
        self.reconcile();
        self.retiring.is_some()
    }
}

/// A test-only snapshot of [`McpHold`]'s state.
#[cfg(test)]
#[derive(Debug, Clone, PartialEq)]
pub enum View {
    Idle,
    Pending(McpHoldSpec),
    Running(Mode, McpHeld),
}

/// Reap a finished holder: a panic is logged here, once, by whoever notices.
fn reap(handle: HolderHandle) {
    let mut join = handle.join;
    let mut cx = Context::from_waker(Waker::noop());
    if let Poll::Ready(Err(e)) = Pin::new(&mut join).poll(&mut cx) {
        if e.is_panic() {
            log::error!("[MCP-HOLD] holder task panicked: {e}");
        }
    }
}

/// Awaits the holders' root tasks on `serve`'s way out. On the cooperative path
/// a root resolves only after its listener and every connection are gone. The
/// forced abort is a safety net for a bug: it guarantees completion shortly
/// after, not exactly at, the return (plan 054 §4.3 "Bounds").
pub async fn finish(handles: Vec<JoinHandle<()>>) {
    let deadline = Instant::now() + holder::STOP_BOUND + Duration::from_secs(1);
    for mut handle in handles {
        match timeout_at(deadline, &mut handle).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                if e.is_panic() {
                    log::error!("[MCP-HOLD] holder task panicked: {e}");
                }
            }
            Err(_) => {
                log::error!("[MCP-HOLD] holder did not stop within its bound; aborting it");
                handle.abort();
                if timeout(Duration::from_millis(500), &mut handle).await.is_err() {
                    log::error!("[MCP-HOLD] aborted holder still not finished");
                }
            }
        }
    }
}
