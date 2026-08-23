//! Owns all hosted sessions and the arm/disarm hold state machine.
//!
//! Invariants (dual review):
//! - The armed hold uses ONE absolute deadline captured at arm time; a
//!   reconnect never restarts it, and `ArmAck` always reports that stored
//!   deadline (never a value recomputed from a later, differing request).
//! - `timeout_secs` is bounded and the deadline uses checked arithmetic, so a
//!   token-bearing peer cannot overflow-panic the sidecar.
//! - On a GUI disconnect while NOT armed, all sessions are dropped → TearDown.
//! - An arm is spent by the first frame received on a connection, so it can
//!   never outlive the GUI-absence it was set for. Keyed on a frame rather than
//!   on accept: a peer that connects and never speaks has adopted nothing.
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
/// How long teardown waits for child process trees to be reaped before exiting
/// anyway. Kills run in parallel, so this bounds the TOTAL wait, not each one.
const TEARDOWN_KILL_GRACE: Duration = Duration::from_secs(5);

pub enum Disposition {
    TearDown,
    Hold,
}

pub struct SessionManager {
    sessions: HashMap<String, Session>,
    /// Absolute monotonic deadline; `Some` once armed, captured exactly once.
    armed_deadline: Option<Instant>,
    /// Epoch-ms mirror of `armed_deadline` for honest `ArmAck` reporting.
    armed_deadline_ms: Option<u64>,
    expected_token: Option<String>,
    /// Whether this host can actually outlive the GUI (Windows: broke away from
    /// a kill-on-close job; Unix: is a session leader). If false, arming is a
    /// lie — the OS would kill us with the GUI — so we refuse to ArmAck.
    survivable: bool,
    events: Sender<Data>,
    responses: Sender<Response>,
}

impl SessionManager {
    pub fn new(
        events: Sender<Data>,
        responses: Sender<Response>,
        expected_token: Option<String>,
        survivable: bool,
    ) -> Self {
        Self {
            sessions: HashMap::new(),
            armed_deadline: None,
            armed_deadline_ms: None,
            expected_token,
            survivable,
            events,
            responses,
        }
    }

    #[cfg(test)]
    pub fn is_armed(&self) -> bool {
        self.armed_deadline.is_some()
    }

    /// Number of hosted sessions whose child is still running. Drives the
    /// non-destructive hold (design §10.4): the host stays alive while this is
    /// > 0 and only tears down once nothing live remains to preserve.
    pub fn live_session_count(&self) -> usize {
        self.sessions.values().filter(|s| s.is_alive()).count()
    }

    fn session_metas(&self) -> Vec<SessionMeta> {
        self.sessions
            .values()
            .map(|s| SessionMeta {
                tab_id: s.tab_id.clone(),
                pid: s.pid(),
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
                // NO ack here — a legacy client cannot decode AttachAck.
                if let Some(s) = self.sessions.get(&tab_id) {
                    s.attach(from_offset);
                }
            }
            Control::AttachAcked {
                req,
                tab_id,
                from_offset,
            } => {
                // RP-3 transactional reattach: same wiring as Attach, but confirm
                // so the GUI can verify each session was re-wired. Only a client
                // that saw CAP_ATTACH_ACK in the discovery record sends this.
                let (alive, tail_offset) = match self.sessions.get(&tab_id) {
                    Some(s) => {
                        s.attach(from_offset);
                        (s.is_alive(), s.ring_tail())
                    }
                    None => (false, 0),
                };
                let _ = self.responses.try_send(Response::AttachAck {
                    req,
                    tab_id,
                    alive,
                    tail_offset,
                });
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
                // Defence in depth (dual-review H2): never acknowledge an arm we
                // can't honor. If we can't outlive the GUI, sending ArmAck would
                // let the GUI exit and lose every session. Withhold the ack so
                // the GUI's arm times out and it refuses to proceed.
                if !self.survivable {
                    log::warn!(
                        "ArmDetach rejected: host is not survivable (would die with the GUI)"
                    );
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

    /// A GUI has made itself heard on this connection. Release any arm that
    /// predates it.
    ///
    /// Called on the connection's FIRST RECEIVED FRAME, not on accept — opening
    /// the endpoint proves nothing about who is there (see `run_connection`).
    ///
    /// An arm is always set for a specific absence: an update or offload that
    /// armed and then exited, or a sibling arming us before its own update. A
    /// connected GUI ends that absence — it is here now and owns these sessions.
    /// Letting the arm outlive it makes a later ordinary quit Hold instead of
    /// tearing down, stranding the user's shells (and whatever agent CLIs run
    /// under them) with no window and no tray to reach them.
    ///
    /// The GUI also disarms explicitly on connect, but that call is lazy (it
    /// rides on the first terminal spawn, so a session that restores nothing
    /// never makes it) and unacknowledged, so it cannot be the only guarantee.
    pub fn on_gui_connect(&mut self) {
        if self.armed_deadline.is_some() {
            eprintln!("termflow-pty-host: GUI connected; releasing a pre-existing detach arm");
        }
        self.armed_deadline = None;
        self.armed_deadline_ms = None;
    }

    /// Kill every session and WAIT for the kills to actually run.
    ///
    /// `Session::kill` is deliberately backgrounded so an interactive
    /// `Control::Close` cannot stall the frame loop — but that is only safe
    /// while this process keeps running. Here it does not: the caller returns
    /// `TearDown`, `serve` returns, and the process exits within milliseconds —
    /// a race the kill thread may well win, but is not guaranteed to. Losing it
    /// costs more on Unix than on Windows: `kill_process_tree` signals
    /// in-process via `killpg`, so a thread that never ran means the signal is
    /// never sent at all, whereas a `taskkill.exe` that already launched
    /// completes on its own. Either way the shell is orphaned with no GUI left
    /// to reach it. Joining is what makes teardown actually tear down.
    ///
    /// Bounded: kills run in parallel and the deadline is absolute, so one
    /// wedged `taskkill` cannot hold the host open indefinitely.
    fn tear_down_sessions(&mut self) {
        let kills: Vec<_> = self.sessions.values().filter_map(|s| s.kill()).collect();
        // Dropping the sessions now reaches `Session::drop` → `kill()`, which
        // no-ops: every kill above latched `killing`.
        self.sessions.clear();
        if kills.is_empty() {
            return;
        }
        let deadline = Instant::now() + TEARDOWN_KILL_GRACE;
        for k in kills {
            // `JoinHandle` has no timed join, so poll `is_finished` against a
            // shared deadline rather than blocking on `join` per handle.
            while !k.is_finished() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            if k.is_finished() {
                let _ = k.join();
            } else {
                log::warn!("teardown: a child kill did not finish within the grace period");
            }
        }
    }

    pub fn on_gui_disconnect(&mut self) -> Disposition {
        match self.armed_deadline {
            Some(_) => {
                self.detach_all();
                Disposition::Hold
            }
            None => {
                self.tear_down_sessions();
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
        (
            SessionManager::new(etx, rtx, Some("tok".into()), true),
            erx,
            rrx,
        )
    }

    /// Like `mgr()` but the host is NOT survivable (can't outlive the GUI).
    fn mgr_unsurvivable() -> (
        SessionManager,
        tokio::sync::mpsc::Receiver<Data>,
        tokio::sync::mpsc::Receiver<Response>,
    ) {
        let (etx, erx) = channel(1024);
        let (rtx, rrx) = channel(1024);
        (
            SessionManager::new(etx, rtx, Some("tok".into()), false),
            erx,
            rrx,
        )
    }

    #[test]
    fn disconnect_without_arm_tears_down() {
        let (mut m, _e, _r) = mgr();
        assert!(matches!(m.on_gui_disconnect(), Disposition::TearDown));
    }

    /// A shell that outlives the teardown it was supposed to die in.
    fn long_lived_spec() -> termflow_pty_protocol::SpawnSpec {
        let (shell, args) = if cfg!(windows) {
            ("cmd.exe", vec!["/c".to_string(), "ping -n 60 127.0.0.1 >NUL".to_string()])
        } else {
            ("/bin/sh", vec!["-c".to_string(), "sleep 60".to_string()])
        };
        termflow_pty_protocol::SpawnSpec {
            shell: shell.into(),
            args,
            env: vec![],
            env_remove: vec![],
            cwd: None,
            cols: 80,
            rows: 24,
        }
    }

    /// Is this pid still a running process, asked of the OS rather than of our
    /// own `exited` tombstone — the tombstone is set by the reader thread and
    /// lags the actual death, so trusting it here would test our bookkeeping
    /// instead of the child.
    fn pid_is_alive(pid: u32) -> bool {
        #[cfg(unix)]
        {
            // Signal 0 performs error checking only: 0 ⇒ the pid exists.
            unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
        }
        #[cfg(windows)]
        {
            use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
            use windows_sys::Win32::System::Threading::{
                GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
            };
            // SAFETY: plain Win32 queries; the handle is closed on every path.
            unsafe {
                let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
                if h.is_null() {
                    return false; // gone (or unreachable, which is gone enough)
                }
                let mut code: u32 = 0;
                let ok = GetExitCodeProcess(h, &mut code) != 0;
                CloseHandle(h);
                ok && code == STILL_ACTIVE as u32
            }
        }
    }

    /// Teardown must not merely *start* the kills.
    ///
    /// `serve` returns the instant this reports `TearDown` and the process exits
    /// right after, so a backgrounded kill that has not run yet dies with it —
    /// on Unix `kill_process_tree` signals in-process, so the signal is never
    /// sent at all and the shell is orphaned. This is the regression the #61
    /// fix introduced by backgrounding `Session::kill`.
    ///
    /// Deliberately asserted with NO polling loop: "eventually dead" is true of
    /// a backgrounded kill too, so a poll would pass against the very bug this
    /// pins. The claim is specifically that the child is dead by the time the
    /// call RETURNS.
    ///
    /// TWO sessions, because one cannot tell "kills every session" from "kills
    /// the first session it finds" — and the teardown loop is exactly the shape
    /// that gets that wrong.
    #[test]
    fn unarmed_disconnect_reaps_every_child_before_returning() {
        let (mut m, _e, _r) = mgr();
        let mut pids = Vec::new();
        for tab in ["tab-teardown-a", "tab-teardown-b"] {
            let sess =
                Session::spawn(tab.into(), &long_lived_spec(), 4096, m.events.clone(), true)
                    .expect("spawn a long-lived child");
            let pid = sess.pid();
            assert!(pid > 0, "need a real pid to assert against");
            // Presence before absence: a liveness oracle that only ever checks
            // "gone" passes vacuously if the child never started.
            assert!(pid_is_alive(pid), "{tab} should be alive before teardown");
            m.sessions.insert(tab.into(), sess);
            pids.push((tab, pid));
        }

        assert!(matches!(m.on_gui_disconnect(), Disposition::TearDown));

        for (tab, pid) in pids {
            assert!(
                !pid_is_alive(pid),
                "on_gui_disconnect returned while {tab} (pid {pid}) was still alive — \
                 the kill was left running in a detached thread that dies with the process"
            );
        }
        assert!(
            m.sessions.is_empty(),
            "teardown reaped the children but kept the session records"
        );
    }

    /// An arm belongs to the GUI generation that set it. A NEW GUI connecting
    /// means whatever the arm was for (an update/offload that armed then exited,
    /// or a sibling's precautionary arm) is over — that GUI is here now and owns
    /// these sessions. Without this the arm outlives its reason, and the next
    /// completely normal quit sees it and Holds instead of tearing down, leaving
    /// the user's shells and agent CLIs running with no window and no tray.
    #[test]
    fn a_new_gui_connection_clears_a_stale_arm() {
        let (mut m, _e, _r) = mgr();
        m.handle_control(Control::ArmDetach {
            req: 1,
            timeout_secs: 600,
            token: "tok".into(),
        });
        assert!(m.is_armed(), "precondition: armed");

        m.on_gui_connect();

        assert!(!m.is_armed(), "a new GUI connection must clear the arm");
    }

    /// The consequence that actually matters: after a reconnect, a plain quit
    /// must destroy sessions rather than hold them for a GUI that never comes.
    #[test]
    fn quit_after_reconnect_tears_down_despite_earlier_arm() {
        let (mut m, _e, _r) = mgr();
        m.handle_control(Control::ArmDetach {
            req: 1,
            timeout_secs: 600,
            token: "tok".into(),
        });
        m.on_gui_connect();
        assert!(matches!(m.on_gui_disconnect(), Disposition::TearDown));
    }

    /// Clearing on connect must not break the flow the arm exists for: a GUI
    /// that connects and THEN arms (sibling offload, or its own pre-update arm)
    /// still holds on disconnect. Pins that `on_gui_connect` clears only arms
    /// that predate the connection, never one set during it.
    #[test]
    fn arming_after_connect_still_holds() {
        let (mut m, _e, _r) = mgr();
        m.on_gui_connect();
        m.handle_control(Control::ArmDetach {
            req: 1,
            timeout_secs: 600,
            token: "tok".into(),
        });
        assert!(matches!(m.on_gui_disconnect(), Disposition::Hold));
    }

    /// RP-3: `AttachAcked` for an UNKNOWN tab must still ack (alive:false) so a
    /// reattaching GUI is never left waiting on a session that isn't there.
    #[test]
    fn attach_acked_unknown_tab_acks_not_alive() {
        let (mut m, _e, mut r) = mgr();
        m.handle_control(Control::AttachAcked {
            req: 7,
            tab_id: "ghost".into(),
            from_offset: 0,
        });
        match r.try_recv() {
            Ok(Response::AttachAck { req, tab_id, alive, .. }) => {
                assert_eq!(req, 7);
                assert_eq!(tab_id, "ghost");
                assert!(!alive, "unknown tab must ack alive=false");
            }
            other => panic!("expected AttachAck, got {other:?}"),
        }
    }

    /// Legacy `Attach` must stay silent — an old client can't decode AttachAck.
    #[test]
    fn legacy_attach_never_acks() {
        let (mut m, _e, mut r) = mgr();
        m.handle_control(Control::Attach {
            req: 9,
            tab_id: "ghost".into(),
            from_offset: 0,
        });
        assert!(r.try_recv().is_err(), "plain Attach must not produce a response");
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
        assert!(matches!(m.on_gui_disconnect(), Disposition::Hold));
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
    fn arm_rejected_when_not_survivable() {
        let (mut m, _e, mut r) = mgr_unsurvivable();
        m.handle_control(Control::ArmDetach {
            req: 1,
            timeout_secs: 300,
            token: "tok".into(),
        });
        assert!(!m.is_armed(), "must not arm when not survivable");
        assert!(
            r.try_recv().is_err(),
            "must NOT send ArmAck when not survivable (GUI arm should time out)"
        );
        // And a disconnect tears down rather than falsely holding.
        assert!(matches!(m.on_gui_disconnect(), Disposition::TearDown));
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
