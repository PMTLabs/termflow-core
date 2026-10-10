//! Plan 054 T2: the MCP-hold rows of the manager state machine (§4.3), driven
//! through the same calls the transport makes, against a stub holder task that
//! records the modes it is commanded into.
//!
//! Every test asserts the reply's `req` and full value (or the absence of a
//! reply) and the resulting state in full, never just "something happened".

use super::*;
use crate::mcp_hold::{Mode, SpawnHolder, View};
use std::sync::{Arc, Mutex};
use termflow_pty_protocol::{McpHeld, McpHoldReason, McpHoldSpec};
use tokio::sync::mpsc::error::TryRecvError;
use tokio::sync::{watch, Notify};

#[derive(Default)]
struct StubLog {
    /// Every spec a holder was started with, in order.
    specs: Vec<McpHoldSpec>,
    /// Every mode the stub task observed, in order.
    modes: Vec<Mode>,
    /// A receiver per started holder, to read the stored `watch` value.
    probes: Vec<watch::Receiver<Mode>>,
}

struct Harness {
    m: SessionManager,
    resp: tokio::sync::mpsc::Receiver<Response>,
    _events: tokio::sync::mpsc::Receiver<Data>,
    log: Arc<Mutex<StubLog>>,
    /// `false` freezes the stub: it does nothing, not even read its mode.
    gate: watch::Sender<bool>,
    /// Makes the stub end by itself (grace, hard cap or panic stand-in).
    end: Arc<Notify>,
}

/// A connection, as `run_connection` sees it: the first authenticated
/// lifecycle frame adopts, later ones do not.
struct Conn {
    adopted: bool,
}

fn new_conn() -> Conn {
    Conn { adopted: false }
}

fn harness(frozen: bool) -> Harness {
    let log = Arc::new(Mutex::new(StubLog::default()));
    let (gate, gate_rx) = watch::channel(!frozen);
    let end = Arc::new(Notify::new());
    let spawn: SpawnHolder = {
        let log = log.clone();
        let end = end.clone();
        Box::new(move |spec, mut rx| {
            {
                let mut l = log.lock().unwrap();
                l.specs.push(spec);
                l.probes.push(rx.clone());
            }
            let log = log.clone();
            let end = end.clone();
            let mut gate = gate_rx.clone();
            tokio::spawn(async move {
                let _ = gate.wait_for(|open| *open).await;
                loop {
                    let mode = *rx.borrow_and_update();
                    log.lock().unwrap().modes.push(mode);
                    if mode == Mode::Stop {
                        break;
                    }
                    tokio::select! {
                        changed = rx.changed() => if changed.is_err() { break },
                        _ = end.notified() => break,
                    }
                }
            })
        })
    };
    let (etx, erx) = tokio::sync::mpsc::channel(1024);
    let (rtx, rrx) = tokio::sync::mpsc::channel(1024);
    Harness {
        m: SessionManager::new_with_holder_spawn(etx, rtx, Some("tok".into()), true, spawn),
        resp: rrx,
        _events: erx,
        log,
        gate,
        end,
    }
}

impl Harness {
    /// What the transport does with one received control frame.
    fn send(&mut self, conn: &mut Conn, ctrl: Control) {
        if !conn.adopted && self.m.authenticates_lifecycle(&ctrl) {
            self.m.on_gui_connect(&ctrl);
            conn.adopted = true;
        }
        self.m.handle_control(ctrl);
    }

    /// Send on a fresh connection and return the one reply.
    fn reply(&mut self, ctrl: Control) -> Response {
        self.send(&mut new_conn(), ctrl);
        self.next_reply()
    }

    fn next_reply(&mut self) -> Response {
        self.resp.try_recv().expect("the handler must have enqueued a reply synchronously")
    }

    fn assert_no_reply(&mut self) {
        assert_eq!(self.resp.try_recv().unwrap_err(), TryRecvError::Empty, "a reply was enqueued");
    }

    /// Let the stub task run until it is idle.
    async fn settle(&self) {
        for _ in 0..16 {
            tokio::task::yield_now().await;
        }
    }

    fn modes(&self) -> Vec<Mode> {
        self.log.lock().unwrap().modes.clone()
    }

    fn spawned(&self) -> Vec<McpHoldSpec> {
        self.log.lock().unwrap().specs.clone()
    }

    /// The value stored in the `watch` of the most recent holder.
    fn stored_mode(&self) -> Mode {
        *self.log.lock().unwrap().probes.last().expect("a holder was started").borrow()
    }

    fn freeze(&self, frozen: bool) {
        self.gate.send_replace(!frozen);
    }
}

fn spec_a() -> McpHoldSpec {
    McpHoldSpec {
        port: 40123,
        configured_port: 40120,
        bind_host: "::1".into(),
        auth_token: Some("bearer-token-a".into()),
        reason: McpHoldReason::Relaunch,
        initialize_result: Some("{ \"protocolVersion\" : \"x\" }".into()),
        tools_list_result: Some("{\"tools\":[ ]}".into()),
    }
}

fn spec_b() -> McpHoldSpec {
    McpHoldSpec {
        port: 40999,
        configured_port: 40998,
        bind_host: "127.0.0.1".into(),
        auth_token: None,
        reason: McpHoldReason::Offload,
        initialize_result: None,
        tools_list_result: None,
    }
}

fn held_a() -> McpHeld {
    McpHeld { port: 40123, configured_port: 40120, bind_host: "::1".into() }
}

fn arm(purpose: Option<ArmDetachPurpose>) -> Control {
    Control::ArmDetach { req: 1, timeout_secs: 900, token: "tok".into(), purpose }
}

fn arm_local() -> Control {
    arm(Some(ArmDetachPurpose::Local))
}

fn hold(req: u64, spec: McpHoldSpec) -> Control {
    Control::HoldMcp { req, token: "tok".into(), spec }
}

fn claim(req: u64) -> Control {
    Control::ClaimMcp { req, token: "tok".into() }
}

fn release(req: u64) -> Control {
    Control::ReleaseMcp { req, token: "tok".into() }
}

fn accepted(req: u64) -> Response {
    Response::McpHoldAck { req, accepted: true, reason: None }
}

fn rejected(req: u64, reason: &str) -> Response {
    Response::McpHoldAck { req, accepted: false, reason: Some(reason.into()) }
}

/// A Local arm with a deadline and an accepted `HoldMcp`: state Pending. Returns
/// the connection that sent them, already adopted by the arm.
fn pending(h: &mut Harness, spec: McpHoldSpec) -> Conn {
    let mut conn = new_conn();
    h.send(&mut conn, arm_local());
    assert!(matches!(h.next_reply(), Response::ArmAck { req: 1, .. }));
    h.send(&mut conn, hold(7, spec));
    assert_eq!(h.next_reply(), accepted(7));
    conn
}

/// Pending, then the GUI goes away: the holder is started in Absent.
async fn absent(h: &mut Harness, spec: McpHoldSpec) -> LocalHold {
    pending(h, spec);
    assert!(matches!(h.m.on_gui_disconnect(), Disposition::Hold));
    let hold = h.m.begin_local_absence().expect("a Local arm opens the bounded absence");
    h.settle().await;
    hold
}

/// Absent, then a relaunched GUI claims on its own connection: Handback.
async fn handback(h: &mut Harness) -> Conn {
    absent(h, spec_a()).await;
    let mut conn = new_conn();
    h.send(&mut conn, claim(8));
    assert_eq!(h.next_reply(), Response::McpClaimAck { req: 8, held: Some(held_a()) });
    h.settle().await;
    conn
}

#[tokio::test]
async fn hold_mcp_gate_matrix() {
    {
        // 1. Unarmed.
        let mut h = harness(false);
        assert_eq!(h.reply(hold(7, spec_a())), rejected(7, "not armed"));
        assert_eq!(h.m.mcp.view(), View::Idle);
        h.assert_no_reply();

        // 2. Purpose None WITH a deadline (a sibling hot-swap arm).
        let mut h = harness(false);
        let mut conn = new_conn();
        h.send(&mut conn, arm(None));
        assert!(h.m.is_armed());
        h.next_reply();
        assert_eq!(h.reply(hold(7, spec_a())), rejected(7, "arm is not a local offload"));
        assert_eq!(h.m.mcp.view(), View::Idle);

        // 3. A crash-hold Local, which has no deadline. Reached the real way:
        //    a live shell and an unannounced disconnect.
        let mut h = harness(false);
        h.m.handle_control(Control::Spawn { req: 2, tab_id: "crash-hold".into(), spec: long_lived_spec() });
        assert!(matches!(h.next_reply(), Response::Spawned { req: 2, .. }));
        assert!(matches!(h.m.on_gui_disconnect(), Disposition::Hold));
        assert_eq!(h.m.armed_purpose(), Some(ArmDetachPurpose::Local), "precondition: crash hold");
        assert!(!h.m.is_armed(), "precondition: a crash hold has no deadline");
        assert_eq!(h.reply(hold(7, spec_a())), rejected(7, "local arm has no deadline"));
        assert_eq!(h.m.mcp.view(), View::Idle);
        h.m.sessions.clear();

        // 4. A Local arm with a deadline, but a host NAME instead of an IP literal.
        let mut h = harness(false);
        let mut conn = new_conn();
        h.send(&mut conn, arm_local());
        h.next_reply();
        let mut named = spec_a();
        named.bind_host = "localhost".into();
        h.send(&mut conn, hold(7, named));
        assert_eq!(h.next_reply(), rejected(7, "bind_host is not an IP literal"));
        assert_eq!(h.m.mcp.view(), View::Idle);

        // 5. A retiring holder whose stub has not finished: stop was ordered,
        //    the frozen task has not run.
        let mut h = harness(true);
        absent(&mut h, spec_a()).await;
        let mut conn = new_conn();
        h.send(&mut conn, claim(8));
        h.next_reply();
        h.send(&mut conn, release(9));
        assert_eq!(h.next_reply(), Response::McpReleaseAck { req: 9, was_holding: true });
        h.send(&mut conn, arm_local());
        h.next_reply();
        h.send(&mut conn, hold(7, spec_b()));
        assert_eq!(h.next_reply(), rejected(7, "previous holder still stopping"));
        assert_eq!(h.m.mcp.view(), View::Idle, "a refused hold leaves the state unchanged");
        assert!(h.m.mcp.has_retiring());
        assert_eq!(h.spawned(), vec![spec_a()], "no second holder was started");

        // 6. Local + deadline + "::1": accepted, and the stored spec IS the sent
        //    spec, field by field.
        let mut h = harness(false);
        let mut conn = new_conn();
        h.send(&mut conn, arm_local());
        h.next_reply();
        let sent = spec_a();
        h.send(&mut conn, hold(7, sent.clone()));
        assert_eq!(h.next_reply(), accepted(7));
        h.assert_no_reply();
        let View::Pending(stored) = h.m.mcp.view() else { panic!("expected Pending") };
        assert_eq!(stored.port, 40123);
        assert_eq!(stored.configured_port, 40120);
        assert_eq!(stored.bind_host, "::1");
        assert_eq!(stored.auth_token.as_deref(), Some("bearer-token-a"));
        assert_eq!(stored.reason, McpHoldReason::Relaunch);
        assert_eq!(stored.initialize_result, sent.initialize_result);
        assert_eq!(stored.tools_list_result, sent.tools_list_result);
        assert_eq!(stored, sent);
        assert!(h.spawned().is_empty(), "Pending starts nothing while a GUI is connected");

        // A second accepted hold replaces the pending spec.
        h.send(&mut conn, hold(8, spec_b()));
        assert_eq!(h.next_reply(), accepted(8));
        assert_eq!(h.m.mcp.view(), View::Pending(spec_b()));
    }
}

#[tokio::test]
async fn hold_while_running_is_refused_as_already_holding() {
    for in_handback in [false, true] {
        let mut h = harness(false);
        if in_handback {
            handback(&mut h).await;
        } else {
            absent(&mut h, spec_a()).await;
        }
        let before = h.m.mcp.view();
        // The arm checks would pass here: Absent still has the offload's Local
        // arm; after a claim the new GUI has re-armed Local.
        if in_handback {
            h.m.handle_control(arm_local());
            h.next_reply();
        }
        assert!(h.m.is_armed());
        let mut conn = new_conn();
        h.send(&mut conn, hold(7, spec_b()));
        assert_eq!(h.next_reply(), rejected(7, "already holding"));
        assert_eq!(h.m.mcp.view(), before, "the running holder and its spec are untouched");
        assert_eq!(h.spawned(), vec![spec_a()]);
    }
}

#[tokio::test]
async fn wrong_token_never_mutates_any_state() {
    #[derive(Clone, Copy, Debug)]
    enum Start {
        Pending,
        Absent,
        Handback,
    }
    let frames = |bad: &str| {
        vec![
            Control::HoldMcp { req: 31, token: bad.into(), spec: spec_b() },
            Control::ClaimMcp { req: 32, token: bad.into() },
            Control::ReleaseMcp { req: 33, token: bad.into() },
        ]
    };
    for start in [Start::Pending, Start::Absent, Start::Handback] {
        for frame in frames("not-the-token") {
            let mut h = harness(false);
            let mut conn = match start {
                Start::Pending => {
                    pending(&mut h, spec_a());
                    new_conn()
                }
                Start::Absent => {
                    absent(&mut h, spec_a()).await;
                    new_conn()
                }
                Start::Handback => handback(&mut h).await,
            };
            h.settle().await;
            let before = (h.m.mcp.view(), h.modes(), h.m.generation, h.m.is_armed(), h.m.armed_purpose());
            let has_holder = !matches!(start, Start::Pending);
            let before_stored = has_holder.then(|| h.stored_mode());

            h.send(&mut conn, frame.clone());
            h.settle().await;

            let ctx = format!("{start:?} / {frame:?}");
            h.assert_no_reply();
            let after = (h.m.mcp.view(), h.modes(), h.m.generation, h.m.is_armed(), h.m.armed_purpose());
            assert_eq!(after, before, "{ctx}: state, stub modes, generation or arm changed");
            assert_eq!(has_holder.then(|| h.stored_mode()), before_stored, "{ctx}: the stored mode changed");
            assert_eq!(h.spawned().len(), usize::from(has_holder), "{ctx}: a holder was started or lost");
        }
    }
}

#[tokio::test]
async fn pending_cleared_by_each_clearing_event() {
    // Disarm.
    let mut h = harness(false);
    pending(&mut h, spec_a());
    assert_eq!(h.reply(Control::Disarm { req: 41 }), Response::DisarmAck { req: 41 });
    assert_eq!(h.m.mcp.view(), View::Idle);

    // Authenticated Shutdown.
    let mut h = harness(false);
    pending(&mut h, spec_a());
    assert_eq!(
        h.reply(Control::Shutdown { req: 42, token: "tok".into() }),
        Response::ShutdownAck { req: 42 }
    );
    assert_eq!(h.m.mcp.view(), View::Idle);

    // A re-arm that is not Local, on the connection that is already adopted (a
    // first-frame ArmDetach would clear Pending by adopting, which is the
    // adoption case below, not this one).
    let mut h = harness(false);
    let mut conn = pending(&mut h, spec_a());
    h.send(&mut conn, arm(None));
    assert!(matches!(h.next_reply(), Response::ArmAck { req: 1, .. }));
    assert_eq!(h.m.mcp.view(), View::Idle);

    // Adoption, by each kind of lifecycle frame.
    let adopters = [
        Control::ListSessions { req: 43, token: Some("tok".into()) },
        Control::ListSessions { req: 43, token: None },
        arm_local(), // an authenticated ArmDetach adopts first, then re-arms
    ];
    for adopter in adopters {
        let mut h = harness(false);
        pending(&mut h, spec_a());
        h.send(&mut new_conn(), adopter.clone());
        h.next_reply();
        // Including an ArmDetach{Local}: adoption spends the pending spec even
        // though the same frame re-arms Local (a Local re-arm alone keeps it,
        // see below).
        assert_eq!(h.m.mcp.view(), View::Idle, "{adopter:?}");
    }
    // ...including the claim itself, which reports nothing held.
    let mut h = harness(false);
    pending(&mut h, spec_a());
    assert_eq!(h.reply(claim(44)), Response::McpClaimAck { req: 44, held: None });
    assert_eq!(h.m.mcp.view(), View::Idle);

    // A Local re-arm does NOT clear it.
    let mut h = harness(false);
    let mut conn = pending(&mut h, spec_a());
    h.send(&mut conn, arm_local());
    assert!(matches!(h.next_reply(), Response::ArmAck { req: 1, .. }));
    assert_eq!(h.m.mcp.view(), View::Pending(spec_a()));

    // A wrong-token Shutdown neither clears it nor latches the shutdown.
    let mut h = harness(false);
    pending(&mut h, spec_a());
    h.m.handle_control(Control::Shutdown { req: 45, token: "nope".into() });
    h.assert_no_reply();
    assert_eq!(h.m.mcp.view(), View::Pending(spec_a()));
    assert!(!h.m.shutdown_requested());
}

#[tokio::test]
async fn claim_moves_absent_to_handback_and_reports_spec() {
    let mut h = harness(false);
    absent(&mut h, spec_a()).await;
    assert_eq!(h.modes(), vec![Mode::Absent]);
    assert!(h.m.is_armed(), "precondition: the offload arm is still in force");

    let mut conn = new_conn();
    h.send(&mut conn, claim(8));
    h.settle().await;
    assert_eq!(
        h.next_reply(),
        Response::McpClaimAck {
            req: 8,
            held: Some(McpHeld { port: 40123, configured_port: 40120, bind_host: "::1".into() }),
        }
    );
    h.assert_no_reply();
    assert!(!h.m.is_armed(), "the claim adopts: the arm is cleared");
    assert_eq!(h.m.armed_purpose(), None);
    assert_eq!(h.modes(), vec![Mode::Absent, Mode::Handback]);
    assert_eq!(h.m.mcp.view(), View::Running(Mode::Handback, held_a()));

    // A second claim: the same `held` under its own req, no new mode.
    h.send(&mut conn, claim(9));
    h.settle().await;
    assert_eq!(h.next_reply(), Response::McpClaimAck { req: 9, held: Some(held_a()) });
    assert_eq!(h.modes(), vec![Mode::Absent, Mode::Handback], "the stub saw no new mode");
    assert_eq!(h.stored_mode(), Mode::Handback);
    assert_eq!(h.spawned().len(), 1);
}

#[tokio::test]
async fn old_gui_frames_stop_an_absent_holder() {
    let stoppers = [
        Control::Disarm { req: 51 },
        Control::ListSessions { req: 52, token: None },
        Control::ListSessions { req: 53, token: Some("tok".into()) },
    ];
    for frame in stoppers {
        let mut h = harness(false);
        absent(&mut h, spec_a()).await;
        h.send(&mut new_conn(), frame.clone());
        h.settle().await;
        let reply = h.next_reply();
        match &frame {
            Control::Disarm { req } => assert_eq!(reply, Response::DisarmAck { req: *req }),
            Control::ListSessions { req, .. } => {
                assert_eq!(reply, Response::SessionList { req: *req, sessions: vec![] })
            }
            _ => unreachable!(),
        }
        assert_eq!(h.modes(), vec![Mode::Absent, Mode::Stop], "{frame:?}");
        assert_eq!(h.m.mcp.view(), View::Idle, "{frame:?}");
    }

    let bystanders = [
        Control::ListSessions { req: 54, token: Some("wrong".into()) },
        Control::Resize { tab_id: "x".into(), cols: 100, rows: 30 },
    ];
    for frame in bystanders {
        let mut h = harness(false);
        absent(&mut h, spec_a()).await;
        h.send(&mut new_conn(), frame.clone());
        h.settle().await;
        assert_eq!(h.modes(), vec![Mode::Absent], "{frame:?} must not stop the holder");
        assert_eq!(h.stored_mode(), Mode::Absent, "{frame:?}");
        assert_eq!(h.m.mcp.view(), View::Running(Mode::Absent, held_a()), "{frame:?}");
    }
}

#[tokio::test]
async fn handback_ignores_adoption_steps() {
    let mut h = harness(false);
    let mut conn = handback(&mut h).await;
    assert_eq!(h.modes(), vec![Mode::Absent, Mode::Handback]);

    h.send(&mut conn, Control::Disarm { req: 61 });
    assert_eq!(h.next_reply(), Response::DisarmAck { req: 61 });
    h.send(&mut conn, Control::ListSessions { req: 62, token: None });
    assert_eq!(h.next_reply(), Response::SessionList { req: 62, sessions: vec![] });
    h.send(&mut conn, arm_local());
    assert!(matches!(h.next_reply(), Response::ArmAck { req: 1, .. }));
    h.send(&mut conn, Control::AttachAcked { req: 64, tab_id: "t".into(), from_offset: 0 });
    assert_eq!(
        h.next_reply(),
        Response::AttachAck { req: 64, tab_id: "t".into(), alive: false, tail_offset: 0 }
    );
    h.settle().await;
    assert_eq!(h.modes(), vec![Mode::Absent, Mode::Handback], "the stub saw no Stop");
    assert_eq!(h.m.mcp.view(), View::Running(Mode::Handback, held_a()));

    // A lifecycle frame on ANOTHER connection (an adoption) leaves it alone too.
    h.send(&mut new_conn(), Control::ListSessions { req: 65, token: None });
    assert_eq!(h.next_reply(), Response::SessionList { req: 65, sessions: vec![] });
    h.settle().await;
    assert_eq!(h.modes(), vec![Mode::Absent, Mode::Handback]);

    // An authenticated Shutdown does stop it.
    h.send(&mut conn, Control::Shutdown { req: 66, token: "tok".into() });
    assert_eq!(h.next_reply(), Response::ShutdownAck { req: 66 });
    h.settle().await;
    assert_eq!(h.modes(), vec![Mode::Absent, Mode::Handback, Mode::Stop]);
    assert_eq!(h.m.mcp.view(), View::Idle);
}

#[tokio::test(start_paused = true)]
async fn release_acks_synchronously() {
    let mut h = harness(true); // the stub is frozen: it never polls
    absent(&mut h, spec_a()).await;
    assert!(h.modes().is_empty(), "precondition: the frozen stub has not run at all");

    // The ack is already queued the instant the handler returns.
    h.m.handle_control(release(21));
    assert_eq!(
        h.resp.try_recv().expect("the ack must be enqueued by the handler itself"),
        Response::McpReleaseAck { req: 21, was_holding: true }
    );
    assert_eq!(h.stored_mode(), Mode::Stop, "the watch already holds Stop");
    assert!(h.modes().is_empty(), "the stub still has not run: the ack did not wait for it");
    assert_eq!(h.m.mcp.view(), View::Idle);
    assert!(h.m.mcp.has_retiring(), "the stopped holder is retiring, unfinished");

    // A duplicate release, while the first is still stopping.
    h.m.handle_control(release(22));
    assert_eq!(h.next_reply(), Response::McpReleaseAck { req: 22, was_holding: false });

    // Unfreeze: the stub reads the stored Stop at once and finishes within the bound.
    h.freeze(false);
    let mut waited = std::time::Duration::ZERO;
    while h.m.mcp.has_retiring() {
        assert!(waited < std::time::Duration::from_secs(1), "the holder must finish within STOP_BOUND");
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        waited += std::time::Duration::from_millis(10);
    }
    assert_eq!(h.modes(), vec![Mode::Stop]);
    h.m.handle_control(release(23));
    assert_eq!(h.next_reply(), Response::McpReleaseAck { req: 23, was_holding: false });

    // Release from Pending: nothing was holding, and Pending becomes Idle.
    let mut h = harness(false);
    pending(&mut h, spec_a());
    h.m.handle_control(release(24));
    assert_eq!(h.next_reply(), Response::McpReleaseAck { req: 24, was_holding: false });
    assert_eq!(h.m.mcp.view(), View::Idle);
    // ...and from Idle.
    h.m.handle_control(release(25));
    assert_eq!(h.next_reply(), Response::McpReleaseAck { req: 25, was_holding: false });
}

#[tokio::test]
async fn claiming_gui_disconnect_stops_holder() {
    // Nothing live: the disconnect is a TearDown, and the holder is stopped.
    let mut h = harness(false);
    let _conn = handback(&mut h).await;
    assert!(matches!(h.m.on_gui_disconnect(), Disposition::TearDown));
    h.settle().await;
    assert_eq!(h.modes(), vec![Mode::Absent, Mode::Handback, Mode::Stop]);
    assert_eq!(h.m.mcp.view(), View::Idle);

    // With a live shell: the disposition logic still runs afterwards (a crash
    // hold), and the stopped holder is not resurrected by the new absence.
    let mut h = harness(false);
    let _conn = handback(&mut h).await;
    h.m.handle_control(Control::Spawn { req: 2, tab_id: "live".into(), spec: long_lived_spec() });
    assert!(matches!(h.next_reply(), Response::Spawned { req: 2, .. }));
    assert!(matches!(h.m.on_gui_disconnect(), Disposition::Hold));
    assert!(h.m.begin_local_absence().is_some());
    h.settle().await;
    assert_eq!(h.modes(), vec![Mode::Absent, Mode::Handback, Mode::Stop]);
    assert_eq!(h.m.mcp.view(), View::Idle);
    assert_eq!(h.spawned().len(), 1, "no second holder");
    h.m.sessions.clear();
}

#[tokio::test]
async fn finished_holder_reads_as_idle() {
    let mut h = harness(false);
    absent(&mut h, spec_a()).await;
    assert_eq!(h.m.mcp.view(), View::Running(Mode::Absent, held_a()));

    // The stub ends by itself (grace, hard cap or panic).
    h.end.notify_one();
    h.settle().await;

    // The manager reconciles to Idle the next time it looks...
    assert_eq!(h.m.mcp.view(), View::Idle);
    assert!(!h.m.mcp.has_retiring(), "it ended on its own: it was never retiring");
    // ...so a later HoldMcp is accepted instead of "already holding".
    let mut conn = new_conn();
    h.send(&mut conn, hold(71, spec_b()));
    assert_eq!(h.next_reply(), accepted(71));
    assert_eq!(h.m.mcp.view(), View::Pending(spec_b()));

    // A claim after the holder ended holds nothing.
    let mut h = harness(false);
    absent(&mut h, spec_a()).await;
    h.end.notify_one();
    h.settle().await;
    assert_eq!(h.reply(claim(72)), Response::McpClaimAck { req: 72, held: None });
}

#[tokio::test]
async fn pending_starts_the_holder_on_local_absence_with_the_stored_spec() {
    let mut h = harness(false);
    pending(&mut h, spec_a());
    assert!(h.spawned().is_empty());
    assert!(matches!(h.m.on_gui_disconnect(), Disposition::Hold));
    assert!(h.spawned().is_empty(), "the disconnect alone starts nothing: the absence does");
    assert!(h.m.begin_local_absence().is_some());
    h.settle().await;
    assert_eq!(h.spawned(), vec![spec_a()]);
    assert_eq!(h.modes(), vec![Mode::Absent]);
    assert_eq!(h.m.mcp.view(), View::Running(Mode::Absent, held_a()));
}

#[tokio::test]
async fn silent_reconnect_reentry_keeps_the_same_holder() {
    let mut h = harness(false);
    absent(&mut h, spec_a()).await;
    // A connection that never adopts drops: serve runs the Hold branch again.
    assert!(matches!(h.m.on_gui_disconnect(), Disposition::Hold));
    assert!(h.m.begin_local_absence().is_some());
    h.settle().await;
    assert_eq!(h.spawned().len(), 1, "the SAME task keeps its listener");
    assert_eq!(h.modes(), vec![Mode::Absent]);
    assert_eq!(h.m.mcp.view(), View::Running(Mode::Absent, held_a()));
}

#[tokio::test]
async fn an_absence_that_is_not_local_or_a_teardown_stops_the_holder() {
    // The arm lost its Local label (simulated: no frame produces this while a
    // holder runs, since Disarm and adoption stop it first).
    let mut h = harness(false);
    absent(&mut h, spec_a()).await;
    h.m.armed_purpose = None;
    assert!(matches!(h.m.on_gui_disconnect(), Disposition::Hold));
    assert!(h.m.begin_local_absence().is_none());
    h.settle().await;
    assert_eq!(h.modes(), vec![Mode::Absent, Mode::Stop]);
    assert_eq!(h.m.mcp.view(), View::Idle);

    // TearDown (nothing armed, nothing live).
    let mut h = harness(false);
    absent(&mut h, spec_a()).await;
    h.m.armed_purpose = None;
    h.m.armed_deadline = None;
    assert!(matches!(h.m.on_gui_disconnect(), Disposition::TearDown));
    h.settle().await;
    assert_eq!(h.modes(), vec![Mode::Absent, Mode::Stop]);
    assert_eq!(h.m.mcp.view(), View::Idle);
}

#[tokio::test]
async fn expiry_stops_the_holder() {
    let mut h = harness(false);
    let hold = absent(&mut h, spec_a()).await;
    h.m.expire_local_hold(hold);
    h.settle().await;
    assert_eq!(h.modes(), vec![Mode::Absent, Mode::Stop]);
    assert_eq!(h.m.mcp.view(), View::Idle);
}
