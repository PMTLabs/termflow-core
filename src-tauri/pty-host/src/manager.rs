//! Owns all hosted sessions and the arm/disarm hold state machine.
//!
//! Key invariants (from the dual review):
//! - The armed hold uses ONE absolute deadline captured at arm time. A
//!   reconnect never restarts it, so a client that reconnects and drops before
//!   disarming cannot extend the hold indefinitely.
//! - On a GUI disconnect while NOT armed, all sessions are dropped and the
//!   disposition is `TearDown` (identical to today's quit/crash behavior).
//! - `Attach` replay is delegated to `Session::attach`, which snapshots and
//!   enables streaming atomically (no duplicate / dropped bytes).

use crate::session::Session;
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use termflow_pty_protocol::{Control, Data, Response, SessionMeta};
use tokio::sync::mpsc::UnboundedSender;

pub enum Disposition {
    TearDown,
    Hold { deadline: Instant },
}

pub struct SessionManager {
    sessions: HashMap<String, Session>,
    /// Some(deadline) once armed; None otherwise. Captured once at arm time.
    armed_deadline: Option<Instant>,
    /// Launch token the GUI must present in `ArmDetach` to arm the hold.
    expected_token: Option<String>,
    events: UnboundedSender<Data>,
    responses: UnboundedSender<Response>,
}

impl SessionManager {
    pub fn new(
        events: UnboundedSender<Data>,
        responses: UnboundedSender<Response>,
        expected_token: Option<String>,
    ) -> Self {
        Self {
            sessions: HashMap::new(),
            armed_deadline: None,
            expected_token,
            events,
            responses,
        }
    }

    pub fn tab_ids(&self) -> Vec<String> {
        self.sessions.keys().cloned().collect()
    }

    pub fn is_armed(&self) -> bool {
        self.armed_deadline.is_some()
    }

    fn ring_cap() -> usize {
        // Per-session replay cap; see spec §9 / plan Global Constraints.
        256 * 1024
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
                match Session::spawn(tab_id.clone(), &spec, Self::ring_cap(), self.events.clone()) {
                    Ok(s) => {
                        let pid = s.pid();
                        // A freshly spawned session streams live immediately —
                        // Spawn only arrives while a GUI is connected. (Detach
                        // hold later flips this off via `detach_all`.)
                        s.set_attached(true);
                        self.sessions.insert(tab_id.clone(), s);
                        let _ = self.responses.send(Response::Spawned { req, tab_id, pid });
                    }
                    Err(e) => {
                        let _ = self.responses.send(Response::SpawnFailed {
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
                let _ = self.responses.send(Response::SessionList {
                    req,
                    sessions: self.session_metas(),
                });
            }
            Control::Attach {
                req: _,
                tab_id,
                from_offset,
            } => {
                if let Some(s) = self.sessions.get(&tab_id) {
                    let (start_offset, bytes, _gap) = s.attach(from_offset);
                    if !bytes.is_empty() {
                        let _ = self.events.send(Data::Stdout {
                            tab_id,
                            offset: start_offset,
                            bytes,
                        });
                    }
                }
            }
            Control::ArmDetach {
                req,
                timeout_secs,
                token,
            } => {
                // Reject a mismatched token silently (no ack) so an
                // unauthorized peer cannot arm the hold.
                if self.expected_token.as_deref() != Some(token.as_str()) {
                    log::warn!("ArmDetach rejected: token mismatch");
                    return;
                }
                // Capture the absolute deadline ONCE.
                if self.armed_deadline.is_none() {
                    self.armed_deadline = Some(Instant::now() + Duration::from_secs(timeout_secs));
                }
                let deadline_ms = now_ms() + timeout_secs * 1000;
                let _ = self.responses.send(Response::ArmAck { req, deadline_ms });
            }
            Control::Disarm { req } => {
                self.armed_deadline = None;
                let _ = self.responses.send(Response::DisarmAck { req });
            }
        }
    }

    pub fn handle_stdin(&mut self, tab_id: &str, bytes: &[u8]) {
        if let Some(s) = self.sessions.get(tab_id) {
            let _ = s.write_stdin(bytes);
        }
    }

    /// Close every session whose tab_id is not in `keep` (orphan pruning on
    /// reattach — spec §6 "kill by default").
    pub fn close_absent(&mut self, keep: &HashSet<String>) {
        let drop_ids: Vec<String> = self
            .sessions
            .keys()
            .filter(|id| !keep.contains(*id))
            .cloned()
            .collect();
        for id in drop_ids {
            self.sessions.remove(&id);
        }
    }

    /// Detach all sessions from live streaming (used when the GUI drops but the
    /// hold is armed — the reader keeps filling rings, silently).
    pub fn detach_all(&self) {
        for s in self.sessions.values() {
            s.set_attached(false);
        }
    }

    /// True once the armed hold's absolute deadline has passed.
    pub fn deadline_expired(&self) -> bool {
        matches!(self.armed_deadline, Some(d) if Instant::now() >= d)
    }

    /// Decide what to do when the GUI connection drops.
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
    use tokio::sync::mpsc::unbounded_channel;

    fn mgr() -> (
        SessionManager,
        tokio::sync::mpsc::UnboundedReceiver<Data>,
        tokio::sync::mpsc::UnboundedReceiver<Response>,
    ) {
        let (etx, erx) = unbounded_channel();
        let (rtx, rrx) = unbounded_channel();
        (
            SessionManager::new(etx, rtx, Some("tok".into())),
            erx,
            rrx,
        )
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
        // A second arm (e.g. reconnect path) must NOT push the deadline out.
        m.handle_control(Control::ArmDetach {
            req: 2,
            timeout_secs: 9999,
            token: "tok".into(),
        });
        assert_eq!(m.armed_deadline.unwrap(), first, "deadline not restarted");
    }
}
