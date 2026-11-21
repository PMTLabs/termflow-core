//! Desktop launch registration. This layer never consumes a readiness epoch or
//! submits PTY input. The 067 registry remains authoritative for session state.
use super::session::{Gate, KnownHostsPaths, SessionRegistry, SessionState, SessionView};
use crate::{
    pty_manager::input_gate::{LaunchTicket, Refusal},
    state::{HostKeys, PaneIdentity},
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttemptReceipt {
    pub generation: u64,
    pub gate: Gate,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub known_hosts_paths: Option<KnownHostsPaths>,
}

impl From<&SessionView> for AttemptReceipt {
    fn from(view: &SessionView) -> Self {
        Self {
            generation: view.generation,
            gate: view.gate,
            reason: view.reason.clone(),
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
    Cancelled,
    Blocked,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub(crate) enum LaunchErrorCode {
    StaleAttempt,
    NotFound,
    InputLocked,
    UnsupportedContext,
    TrustBlocked,
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
}

#[derive(Default)]
pub(crate) struct LaunchRegistry(Mutex<HashMap<String, RegisteredAttempt>>);

#[derive(Clone, Copy)]
pub(crate) enum Operation<'a> {
    Launch(&'a str),
    Cancel,
    Query,
}

impl LaunchRegistry {
    /// T4 seam: extend this transaction at the registered-attempt boundary.
    /// Its ticket is process-qualified but is not authorization to send bytes.
    /// Adopted tickets still need a fresh owner/lease and readiness check in T4.
    /// Do not call the public input writer while holding this write barrier;
    /// it acquires the barrier itself.
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
        sessions.with_launch_session(terminal, |session| {
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
                } else if next.stage == LaunchStage::Preparing && view.gate == Gate::Blocked {
                    next.stage = LaunchStage::Blocked;
                    next.error = Some(TrustBlocked.into());
                }
                if next != entry.snapshot {
                    next.launch_seq = next.launch_seq.checked_add(1).ok_or(StaleAttempt)?;
                    next.revision = next.launch_seq;
                    if next.stage != LaunchStage::Preparing {
                        if let Some(ticket) = &entry.ticket {
                            keys.cancel_registered_launch_ordered(ticket)?;
                        }
                        entry.ticket = None;
                    }
                    if cancelling {
                        next.attempt.attempt_receipt = (&cancel_session()).into();
                    }
                    entry.snapshot = next;
                }
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
            let launch_seq = previous.map_or(0, |entry| entry.snapshot.launch_seq)
                .checked_add(1).ok_or(StaleAttempt)?;
            let blocked = view.gate == Gate::Blocked;
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
                stage: if blocked { LaunchStage::Blocked } else { LaunchStage::Preparing },
                error: blocked.then(|| TrustBlocked.into()),
            };
            attempts.insert(terminal.into(), RegisteredAttempt { snapshot: snapshot.clone(), ticket });
            Ok(snapshot)
        })
    }
}

#[cfg(test)]
#[path = "launch_tests.rs"]
mod tests;
