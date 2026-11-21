//! Desktop launch registration and one-shot PTY launch. The 067 registry
//! remains authoritative for verification, prompts and session ownership.
mod drive;
use super::session::{Gate, KnownHostsPaths, SessionRegistry, SessionState, SessionView};
use crate::{
    pty_manager::input_gate::{LaunchTicket, Refusal},
    state::{HostKeys, PaneIdentity},
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::{Arc, atomic::{AtomicU64, Ordering}}};

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttemptReceipt {
    pub generation: u64,
    pub gate: Gate,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// The code for `reason`, copied with it (see `SessionView::error_code`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub known_hosts_paths: Option<KnownHostsPaths>,
}

impl From<&SessionView> for AttemptReceipt {
    fn from(view: &SessionView) -> Self {
        Self {
            generation: view.generation,
            gate: view.gate,
            reason: view.reason.clone(),
            error_code: view.error_code.clone(),
            known_hosts_paths: view.known_hosts_paths.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LaunchAttemptRef {
    pub session_generation: u64,
    pub attempt_receipt: AttemptReceipt,
    pub process_incarnation: String,
    pub owner_incarnation: PaneIdentity,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum LaunchStage {
    Preparing,
    WaitingReady,
    WaitingTrust,
    Typed,
    Running,
    Ended,
    Cancelled,
    Blocked,
    Error,
}
impl LaunchStage {
    fn waiting(self) -> bool {
        matches!(self, Self::Preparing | Self::WaitingReady | Self::WaitingTrust)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub(crate) enum LaunchErrorCode {
    StaleAttempt,
    NotFound,
    InputLocked,
    UnsupportedShell,
    UnsupportedContext,
    TrustBlocked,
    Timeout,
    WriteFailed,
    TransportClosed,
    StoreUnavailable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct LaunchError {
    pub code: LaunchErrorCode,
    pub message: &'static str,
}

impl From<LaunchErrorCode> for LaunchError {
    fn from(code: LaunchErrorCode) -> Self {
        let message = match code {
            LaunchErrorCode::StaleAttempt => "The SSH launch attempt is no longer current.",
            LaunchErrorCode::NotFound => "No SSH launch attempt is registered for this terminal.",
            LaunchErrorCode::InputLocked => "Terminal input is locked by an SSH launch.",
            LaunchErrorCode::UnsupportedContext => "This local shell was not prepared for this saved SSH connection.",
            LaunchErrorCode::TrustBlocked => "The SSH session refused the launch.",
            LaunchErrorCode::UnsupportedShell => "This shell cannot safely run the saved SSH connection.",
            LaunchErrorCode::Timeout => "Return to the local shell prompt, then retry the SSH connection.",
            LaunchErrorCode::WriteFailed => "Writing the SSH command failed. It was not retried.",
            LaunchErrorCode::TransportClosed => "The terminal writer is unavailable.",
            LaunchErrorCode::StoreUnavailable => "SSH connection definitions could not be read.",
        };
        Self { code, message }
    }
}

impl From<Refusal> for LaunchError {
    fn from(refusal: Refusal) -> Self {
        match refusal {
            Refusal::InputLocked => LaunchErrorCode::InputLocked,
            _ => LaunchErrorCode::StaleAttempt,
        }
        .into()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LaunchSnapshot {
    pub terminal_id: String,
    pub connection_id: String,
    pub attempt: LaunchAttemptRef,
    pub revision: u64,
    pub launch_seq: u64,
    pub stage: LaunchStage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<LaunchError>,
}

struct RegisteredAttempt {
    snapshot: LaunchSnapshot,
    ticket: Option<LaunchTicket>,
    driving: bool,
    waiting_since: Option<std::time::Instant>,
    placement: u64,
    // Only a proved command return can finish these pins after acceptance.
    payload: Option<Arc<drive::Payload>>,
    watcher: Option<drive::Watcher>,
}

impl RegisteredAttempt {
    fn update(&mut self, mut next: LaunchSnapshot) -> Result<(), LaunchError> {
        if next != self.snapshot {
            next.launch_seq = next_sequence()?;
            next.revision = next.launch_seq;
            self.snapshot = next;
        }
        Ok(())
    }
}

#[derive(Default)]
pub(crate) struct LaunchRegistry(Mutex<HashMap<String, RegisteredAttempt>>);

fn next_sequence() -> Result<u64, LaunchError> {
    // A single monotonic source avoids keeping tombstones for closed terminal
    // ids. Allocation for a terminal always occurs under its registry lock.
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    SEQUENCE.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |seq| seq.checked_add(1))
        .map(|seq| seq + 1).map_err(|_| LaunchErrorCode::StaleAttempt.into())
}

// 067 uses Blocked both for a live trust wait (including the trust write
// after the prompt clears) and for refusals. The network exception is an
// Error session with an explicitly different gate; it is not a refusal.
fn refused(view: &SessionView, cancelled: bool) -> bool {
    cancelled || (view.gate != Gate::NetworkError
        && matches!(view.state, SessionState::Error | SessionState::Disconnected))
}

#[derive(Clone, Copy)]
pub(crate) enum Operation<'a> {
    Launch(&'a str),
    Cancel,
    Query,
}

impl LaunchRegistry {
    /// Retire only processes that no longer have their original placement.
    /// Transfers preserve that placement even while there is no mounted pane.
    pub(crate) fn reconcile_processes(&self, keys: &HostKeys) {
        let mut retired = Vec::new();
        {
            let _order = keys.input_owner_change();
            self.0.lock().retain(|_, entry| {
                let keep = keys.input_stamp(&entry.snapshot.attempt.process_incarnation)
                    .is_some_and(|stamp| stamp.generation == entry.placement);
                if !keep { retired.extend(entry.payload.take()); }
                keep
            });
        }
        for payload in retired { payload.retire(); }
    }

    /// Validate desktop placement and reserve/coalesce the exact attempt.
    /// The worker separately requalifies the ticket at submission; this
    /// transaction never calls the Lane A writer inside its ownership guard.
    pub(crate) fn access(
        &self,
        keys: &HostKeys,
        sessions: &SessionRegistry,
        window: &str,
        terminal: &str,
        requested: LaunchAttemptRef,
        op: Operation<'_>,
    ) -> Result<LaunchSnapshot, LaunchError> {
        use LaunchErrorCode::{NotFound, StaleAttempt, TrustBlocked, UnsupportedContext};
        if requested.session_generation != requested.attempt_receipt.generation {
            return Err(StaleAttempt.into());
        }
        let mut retired_payload = None;
        let result = sessions.with_launch_session(terminal, |session| {
            let _order = keys.input_owner_change();
            let placement = keys
                .launch_placement(window, terminal, requested.owner_incarnation, &requested.process_incarnation)
                .ok_or(StaleAttempt)?;
            let mut attempts = self.0.lock();
            let previous = attempts.get_mut(terminal);
            let Some((view, receipt, cancelled, cancel_session)) = session else {
                return Err(if previous.is_some() { StaleAttempt } else { NotFound }.into());
            };
            if view.generation != requested.session_generation
                || receipt != Some(placement)
                || matches!(op, Operation::Launch(id) if id != view.connection_id.as_str())
            {
                return Err(StaleAttempt.into());
            }

            let current = previous.as_ref().is_some_and(|entry| {
                entry.snapshot.attempt.session_generation == view.generation
            });
            let authoritative = LaunchAttemptRef {
                attempt_receipt: view.into(),
                ..requested
            };
            if current {
                let entry = previous.expect("current attempt exists");
                let mut next = entry.snapshot.clone();
                if next.attempt.process_incarnation != authoritative.process_incarnation
                    || next.connection_id != view.connection_id
                {
                    return Err(StaleAttempt.into());
                }
                next.attempt = authoritative;
                let cancelling = matches!(op, Operation::Cancel) && next.stage != LaunchStage::Cancelled;
                if cancelling {
                    next.stage = LaunchStage::Cancelled;
                    next.error = None;
                    if let Some(ticket) = entry.ticket.take() {
                        keys.cancel_registered_launch_ordered(&ticket)?;
                    }
                    entry.watcher = None;
                    retired_payload = entry.payload.take();
                    next.attempt.attempt_receipt = (&cancel_session()).into();
                }
                entry.update(next)?;
                return Ok(entry.snapshot.clone());
            }

            if !matches!(op, Operation::Launch(_)) {
                return Err(if previous.is_some() { StaleAttempt } else { NotFound }.into());
            }
            // An ended shell can leave its disconnected 067 view behind. A fresh
            // process must not register a second attempt for that generation.
            if cancelled && view.state == SessionState::Disconnected {
                return Err(StaleAttempt.into());
            }
            if keys.ssh_launch_connection(&authoritative.process_incarnation).as_deref()
                != Some(view.connection_id.as_str())
            {
                return Err(UnsupportedContext.into());
            }
            let launch_seq = next_sequence()?;
            let blocked = refused(view, cancelled);
            let ticket = if blocked {
                None
            } else {
                Some(keys.prepare_ssh_input_ordered(&authoritative.process_incarnation)?)
            };
            let snapshot = LaunchSnapshot {
                terminal_id: terminal.into(),
                connection_id: view.connection_id.clone(),
                attempt: authoritative,
                revision: launch_seq,
                launch_seq,
                stage: if blocked {
                    LaunchStage::Blocked
                } else if view.gate == Gate::Blocked {
                    LaunchStage::WaitingTrust
                } else {
                    LaunchStage::Preparing
                },
                error: blocked.then(|| TrustBlocked.into()),
            };
            let entry = RegisteredAttempt {
                snapshot: snapshot.clone(),
                ticket,
                driving: false,
                waiting_since: None,
                placement,
                payload: None,
                watcher: None,
            };
            if let Some(old) = attempts.insert(terminal.into(), entry) {
                if let Some(ticket) = &old.ticket {
                    keys.cancel_registered_launch_ordered(ticket)?;
                }
                retired_payload = old.payload;
            }
            Ok(snapshot)
        });
        if let Some(payload) = retired_payload {
            payload.retire();
        }
        result
    }
}

#[cfg(test)]
#[path = "launch_tests.rs"]
mod tests;
