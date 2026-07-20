//! Owns all hosted sessions and the arm/disarm hold state machine.
//!
//! Invariants (dual review):
//! - The armed hold uses ONE absolute deadline captured at arm time; a
//!   reconnect never restarts it, and `ArmAck` always reports that stored
//!   deadline (never a value recomputed from a later, differing request).
//! - `timeout_secs` is bounded and the deadline uses checked arithmetic, so a
//!   token-bearing peer cannot overflow-panic the sidecar.
//! - On a GUI disconnect while NOT armed, all sessions are dropped → TearDown.
//! - `Attach` replay/live-enable/exit-reemit is fully delegated to
//!   `Session::attach`, which does it atomically under the ring lock.

use crate::session::Session;
use std::collections::HashMap;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use termflow_pty_protocol::{Control, Data, Response, SessionMeta};
use tokio::sync::mpsc::Sender;

/// Upper bound on an armed hold (24h). Prevents overflow and unbounded holds.
const MAX_ARM_SECS: u64 = 24 * 60 * 60;
/// Per-session replay ring cap (see spec §9 / plan Global Constraints).
const RING_CAP: usize = 256 * 1024;

pub enum Disposition {
    TearDown,
    Hold { deadline: Instant },
}

pub struct SessionManager {
    sessions: HashMap<String, Session>,
    /// Absolute monotonic deadline; `Some` once armed, captured exactly once.
    armed_deadline: Option<Instant>,
    /// Epoch-ms mirror of `armed_deadline` for honest `ArmAck` reporting.
    armed_deadline_ms: Option<u64>,
    expected_token: Option<String>,
    events: Sender<Data>,
    responses: Sender<Response>,
}

impl SessionManager {
    pub fn new(
        events: Sender<Data>,
        responses: Sender<Response>,
        expected_token: Option<String>,
    ) -> Self {
        Self {
            sessions: HashMap::new(),
            armed_deadline: None,
            armed_deadline_ms: None,
            expected_token,
            events,
            responses,
        }
    }

    pub fn is_armed(&self) -> bool {
        self.armed_deadline.is_some()
    }

    fn session_metas(&self) -> Vec<SessionMeta> {
        self.sessions
            .values()
            .map(|s| SessionMeta {
                tab_id: s.tab_id.clone(),
                head_offset: s.ring_head(),
                tail_offset: s.ring_tail(),
                alive: s.is_alive(),
            })
            .collect()
    }

    pub fn handle_control(&mut self, ctrl: Control) {
        match ctrl {
            Control::Spawn { req, tab_id, spec } => {
                // Spawn only arrives while a GUI is connected → attach from
                // byte 0 so early startup output is streamed, not lost.
                match Session::spawn(tab_id.clone(), &spec, RING_CAP, self.events.clone(), true) {
                    Ok(s) => {
                        let pid = s.pid();
                        self.sessions.insert(tab_id.clone(), s);
                        let _ = self.responses.try_send(Response::Spawned { req, tab_id, pid });
                    }
                    Err(e) => {
                        let _ = self.responses.try_send(Response::SpawnFailed {
                            req,
                            tab_id,
                            error: e.to_string(),
                        });
                    }
                }
            }
            Control::Resize { tab_id, cols, rows } => {
                if let Some(s) = self.sessions.get(&tab_id) {
                    let _ = s.resize(cols, rows);
                }
            }
            Control::Close { tab_id } => {
                self.sessions.remove(&tab_id);
            }
            Control::ListSessions { req } => {
                let _ = self.responses.try_send(Response::SessionList {
                    req,
                    sessions: self.session_metas(),
                });
            }
            Control::Attach {
                req: _,
                tab_id,
                from_offset,
            } => {
                // Fully delegated: session.attach emits Gap+replay+Exit and
                // enables live streaming atomically under the ring lock.
                if let Some(s) = self.sessions.get(&tab_id) {
                    s.attach(from_offset);
                }
            }
            Control::ArmDetach {
                req,
                timeout_secs,
                token,
            } => {
                if self.expected_token.as_deref() != Some(token.as_str()) {
                    log::warn!("ArmDetach rejected: token mismatch");
                    return;
                }
                let capped = timeout_secs.min(MAX_ARM_SECS);
                // Capture the deadline ONCE (checked add against overflow).
                if self.armed_deadline.is_none() {
                    let deadline = Instant::now()
                        .checked_add(Duration::from_secs(capped))
                        .unwrap_or_else(Instant::now);
                    self.armed_deadline = Some(deadline);
                    self.armed_deadline_ms = Some(now_ms().saturating_add(capped.saturating_mul(1000)));
                }
                // Always acknowledge the STORED deadline, never a recomputed one.
                let deadline_ms = self.armed_deadline_ms.unwrap_or_else(now_ms);
                let _ = self.responses.try_send(Response::ArmAck { req, deadline_ms });
            }
            Control::Disarm { req } => {
                self.armed_deadline = None;
                self.armed_deadline_ms = None;
                let _ = self.responses.try_send(Response::DisarmAck { req });
            }
        }
    }

    pub fn handle_stdin(&mut self, tab_id: &str, bytes: &[u8]) {
        if let Some(s) = self.sessions.get(tab_id) {
            let _ = s.write_stdin(bytes);
        }
    }

    /// Detach all sessions from live streaming (GUI dropped but hold armed).
    pub fn detach_all(&self) {
        for s in self.sessions.values() {
            s.set_attached(false);
        }
    }

    pub fn on_gui_disconnect(&mut self) -> Disposition {
        match self.armed_deadline {
            Some(deadline) => {
                self.detach_all();
                Disposition::Hold { deadline }
            }
            None => {
                self.sessions.clear();
                Disposition::TearDown
            }
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc::channel;

    fn mgr() -> (
        SessionManager,
        tokio::sync::mpsc::Receiver<Data>,
        tokio::sync::mpsc::Receiver<Response>,
    ) {
        let (etx, erx) = channel(1024);
        let (rtx, rrx) = channel(1024);
        (SessionManager::new(etx, rtx, Some("tok".into())), erx, rrx)
    }

    #[test]
    fn disconnect_without_arm_tears_down() {
        let (mut m, _e, _r) = mgr();
        assert!(matches!(m.on_gui_disconnect(), Disposition::TearDown));
    }

    #[test]
    fn arm_with_good_token_then_disconnect_holds() {
        let (mut m, _e, _r) = mgr();
        m.handle_control(Control::ArmDetach {
            req: 1,
            timeout_secs: 300,
            token: "tok".into(),
        });
        assert!(m.is_armed());
        assert!(matches!(m.on_gui_disconnect(), Disposition::Hold { .. }));
    }

    #[test]
    fn arm_with_bad_token_is_rejected() {
        let (mut m, _e, _r) = mgr();
        m.handle_control(Control::ArmDetach {
            req: 1,
            timeout_secs: 300,
            token: "WRONG".into(),
        });
        assert!(!m.is_armed());
        assert!(matches!(m.on_gui_disconnect(), Disposition::TearDown));
    }

    #[test]
    fn disarm_reverts_to_teardown() {
        let (mut m, _e, _r) = mgr();
        m.handle_control(Control::ArmDetach {
            req: 1,
            timeout_secs: 300,
            token: "tok".into(),
        });
        m.handle_control(Control::Disarm { req: 2 });
        assert!(!m.is_armed());
        assert!(matches!(m.on_gui_disconnect(), Disposition::TearDown));
    }

    #[test]
    fn deadline_is_captured_once_not_restarted_on_rearm() {
        let (mut m, _e, _r) = mgr();
        m.handle_control(Control::ArmDetach {
            req: 1,
            timeout_secs: 300,
            token: "tok".into(),
        });
        let first = m.armed_deadline.unwrap();
        m.handle_control(Control::ArmDetach {
            req: 2,
            timeout_secs: 9999,
            token: "tok".into(),
        });
        assert_eq!(m.armed_deadline.unwrap(), first, "deadline not restarted");
    }

    #[test]
    fn arm_ack_reports_stored_deadline_not_recomputed() {
        let (mut m, _e, mut r) = mgr();
        m.handle_control(Control::ArmDetach {
            req: 1,
            timeout_secs: 300,
            token: "tok".into(),
        });
        let first_ack = match r.try_recv().unwrap() {
            Response::ArmAck { deadline_ms, .. } => deadline_ms,
            other => panic!("expected ArmAck, got {other:?}"),
        };
        // A second arm with a wildly different timeout must ack the SAME stored deadline.
        m.handle_control(Control::ArmDetach {
            req: 2,
            timeout_secs: 99999,
            token: "tok".into(),
        });
        let second_ack = match r.try_recv().unwrap() {
            Response::ArmAck { deadline_ms, .. } => deadline_ms,
            other => panic!("expected ArmAck, got {other:?}"),
        };
        assert_eq!(first_ack, second_ack, "ArmAck must report the stored deadline");
    }

    #[test]
    fn huge_timeout_does_not_panic() {
        let (mut m, _e, _r) = mgr();
        // Would overflow Instant+Duration without the cap/checked add.
        m.handle_control(Control::ArmDetach {
            req: 1,
            timeout_secs: u64::MAX,
            token: "tok".into(),
        });
        assert!(m.is_armed());
    }
}
