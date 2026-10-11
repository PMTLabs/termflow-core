//! The handover transaction and its rollback over fake hosts and the snapshot fixture (plan 055
//! T5 and T7). Every test drives the production `handover_txn`, then `release`, `commit` or a drop;
//! the fake host's `mcp_state` is the oracle for what the host ended up doing.
//!
//! These run on real time: the snapshot talks to a real loopback socket, which a paused clock
//! would race.

use super::fake_hosts::*;
use super::lifecycle_tests::{machine_with_current, CURRENT};
use super::*;
use crate::state::host_lifecycle::{begin_offload, Hold};
use crate::state::host_table::Busy;
use crate::state::mcp_handover::{handover_txn, Cleanup, HandedOver, HandoverInputs, HandoverPort, SentState};
use crate::state::mcp_snapshot_tests::{
    capture_logs, captured_logs, config_at_the_body_cap, config_with_token, Fixture, INIT_RESULT, LIST_RESULT,
};
use crate::state::types::McpLaunch;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use termflow_pty_protocol::{encode, ArmDetachPurpose, Control, Frame, McpHoldReason, McpHoldSpec, MAX_FRAME_LEN};
use tokio::task::JoinHandle;

/// The credential the hold is authenticated with: not the sidecar's bearer token, and not any
/// global, so a frame that carries the wrong one cannot match by accident.
const HOST_TOK: &str = "HOST_TOK_5e2a";
const SIDECAR_TOKEN: &str = "sidecar-bearer-9c1d";
const CONFIGURED: u16 = 4300;

struct TestPort {
    lock: Arc<tokio::sync::Mutex<()>>,
    inputs: HandoverInputs,
    reads: AtomicUsize,
    /// Whether the lock was held by someone while `read_inputs` ran.
    read_under_lock: AtomicBool,
    read_signal: tokio::sync::Notify,
}

impl TestPort {
    fn new(launch: Option<McpLaunch>) -> Arc<Self> {
        Arc::new(Self {
            lock: Arc::new(tokio::sync::Mutex::new(())),
            inputs: HandoverInputs { launch, configured_port: CONFIGURED },
            reads: AtomicUsize::new(0),
            read_under_lock: AtomicBool::new(false),
            read_signal: tokio::sync::Notify::new(),
        })
    }
}

impl HandoverPort for TestPort {
    fn network_op_lock(&self) -> Arc<tokio::sync::Mutex<()>> {
        self.lock.clone()
    }

    fn read_inputs(&self) -> HandoverInputs {
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.read_under_lock.store(self.lock.try_lock().is_err(), Ordering::SeqCst);
        self.read_signal.notify_one();
        self.inputs.clone()
    }

    fn host_token(&self) -> String {
        HOST_TOK.to_string()
    }
}

struct Rig {
    world: Arc<World>,
    port: FakePort,
    tp: Arc<TestPort>,
    fixture: Fixture,
    hold: Option<Hold>,
    hosts: Vec<String>,
    marks: Vec<usize>,
}

fn capable() -> HostSpec {
    HostSpec { mcp_hold: true, ..HostSpec::default() }
}

fn reply(mcp_hold_reply: McpHoldReply) -> HostSpec {
    HostSpec { mcp_hold_reply, ..capable() }
}

/// The current host and these older ones, adopted and armed by an offload; the sidecar fixture
/// is up and `TestPort` points at it.
async fn rig(current: HostSpec, frozen: &[(&str, HostSpec)]) -> Rig {
    rig_with(current, frozen, Some(SIDECAR_TOKEN), true).await
}

async fn rig_with(current: HostSpec, frozen: &[(&str, HostSpec)], token: Option<&str>, launch: bool) -> Rig {
    let (world, port) = machine_with_current(current, frozen);
    rediscover_hosts(&port).await.unwrap();
    let fixture = Fixture::start(config_with_token(token)).await;
    let tp = TestPort::new(launch.then(|| fixture.launch()));
    let mut hold = begin_offload(&port).await.unwrap();
    hold.arm_detach(600, "tok", Some(ArmDetachPurpose::Local)).await.unwrap();
    let hosts: Vec<String> = std::iter::once(CURRENT).chain(frozen.iter().map(|(name, _)| *name)).map(str::to_owned).collect();
    let marks = hosts.iter().map(|h| world.kinds(h).len()).collect();
    Rig { world, port, tp, fixture, hold: Some(hold), hosts, marks }
}

impl Rig {
    async fn hand(&mut self) -> HandedOver {
        self.hand_for(McpHoldReason::Offload).await
    }

    async fn hand_for(&mut self, reason: McpHoldReason) -> HandedOver {
        let handed = handover_txn(&*self.tp, self.hold.take().expect("not handed yet"), reason).await;
        if self.tp.reads.load(Ordering::SeqCst) > 0 {
            assert!(self.tp.read_under_lock.load(Ordering::SeqCst), "the inputs were read without the lock held");
        }
        handed
    }

    /// The frame kinds `host` received since the hosts were armed.
    fn since(&self, host: &str) -> Vec<&'static str> {
        let at = self.hosts.iter().position(|h| h == host).unwrap();
        self.world.kinds(host)[self.marks[at]..].to_vec()
    }

    fn count_since(&self, host: &str, kind: &str) -> usize {
        self.since(host).into_iter().filter(|k| *k == kind).count()
    }

    /// MCP frames any host received since the hosts were armed: what the handover sent. The claims
    /// adoption made before the arm are not the handover's.
    fn mcp_frames_anywhere(&self) -> usize {
        self.hosts.iter().map(|h| ["HoldMcp", "ClaimMcp", "ReleaseMcp"].iter().map(|k| self.count_since(h, k)).sum::<usize>()).sum()
    }

    fn client(&self) -> PtyHostClient {
        self.port.current_client().expect("the current host is adopted")
    }

    /// Wait until `host`'s connection is gone on the client's side too.
    async fn kill(&self, host: &str) {
        let client = self.client();
        self.world.kill_connections(host);
        tokio::time::timeout(Duration::from_secs(3), async {
            while client.is_alive() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the client noticed the closed pipe");
    }

    /// The lifecycle quiesce is still in force: neither a create nor an adoption is admitted.
    fn admission_closed(&self) -> bool {
        matches!(self.port.table().begin(HostChannel::Primary), Err(Busy::Lifecycle(_)))
            && matches!(self.port.table().begin_adoption(), Err(Busy::Lifecycle(_)))
    }

    /// The quiesce is over: a create and an adoption are each admitted (their tickets are dropped
    /// at once). Not the negation of `admission_closed`, which either one reopening would satisfy.
    fn admission_open(&self) -> bool {
        let creates = self.port.table().begin(HostChannel::Primary).is_ok();
        let adoption = self.port.table().begin_adoption().is_ok();
        creates && adoption
    }
}

fn compete(lock: &Arc<tokio::sync::Mutex<()>>) -> JoinHandle<()> {
    let lock = lock.clone();
    tokio::spawn(async move {
        let _guard = lock.lock().await;
    })
}

async fn still_blocked(competitor: &JoinHandle<()>, why: &str) {
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert!(!competitor.is_finished(), "the network lock was free: {why}");
}

async fn acquired(competitor: JoinHandle<()>, why: &str) {
    tokio::time::timeout(Duration::from_secs(6), competitor)
        .await
        .unwrap_or_else(|_| panic!("the network lock never became free: {why}"))
        .unwrap();
}

async fn until(what: &str, mut done: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(6), async {
        while !done() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for {what}"));
}

fn hold_frames(world: &World, host: &str) -> Vec<(u64, String, McpHoldSpec)> {
    world
        .frames_of(host)
        .into_iter()
        .filter_map(|f| match f {
            Frame::Ctrl(Control::HoldMcp { req, token, spec }) => Some((req, token, spec)),
            _ => None,
        })
        .collect()
}

fn release_frames(world: &World, host: &str) -> Vec<String> {
    world
        .frames_of(host)
        .into_iter()
        .filter_map(|f| match f {
            Frame::Ctrl(Control::ReleaseMcp { token, .. }) => Some(token),
            _ => None,
        })
        .collect()
}

// ---- T5: which host, what it is sent ---------------------------------------------------------

#[tokio::test]
async fn the_primary_gets_the_single_hold_with_the_launch_the_snapshot_and_the_reason() {
    let mut rig = rig(capable(), &[("f1", capable())]).await;
    let launch = rig.fixture.launch();
    assert_ne!(launch.port, CONFIGURED, "the premise: the effective port is not the configured one");

    let handed = rig.hand_for(McpHoldReason::OffloadUpdate).await;

    assert_eq!(handed.sent(), SentState::Accepted);
    let holds = hold_frames(&rig.world, CURRENT);
    assert_eq!(holds.len(), 1, "exactly one hold on the primary");
    assert_eq!(hold_frames(&rig.world, "f1").len(), 0, "and none on the frozen host");
    let (_, token, spec) = &holds[0];
    assert_eq!(token, HOST_TOK, "authenticated with the host token, never the sidecar's bearer");
    assert_eq!(
        *spec,
        McpHoldSpec {
            port: launch.port,
            configured_port: CONFIGURED,
            bind_host: "127.0.0.1".into(),
            auth_token: Some(SIDECAR_TOKEN.into()),
            reason: McpHoldReason::OffloadUpdate,
            initialize_result: Some(INIT_RESULT.into()),
            tools_list_result: Some(LIST_RESULT.into()),
        },
        "the launch, the configured port, the reason and the snapshot, byte for byte"
    );
    assert_eq!(rig.tp.reads.load(Ordering::SeqCst), 1, "the inputs were read once");
    assert!(handed.release().await.1);
}

#[tokio::test]
async fn a_primary_without_the_bit_leaves_the_hold_to_a_capable_frozen_host() {
    let mut rig = rig(HostSpec::default(), &[("f1", capable()), ("f2", capable())]).await;

    let handed = rig.hand().await;

    assert_eq!(handed.sent(), SentState::Accepted);
    assert_eq!(rig.world.count(CURRENT, "HoldMcp"), 0, "the primary was never sent a frame it cannot decode");
    assert_eq!(hold_frames(&rig.world, "f1").len(), 1, "the first capable frozen host holds");
    assert_eq!(hold_frames(&rig.world, "f2").len(), 0);
    handed.release().await;
}

#[tokio::test]
async fn with_no_capable_host_or_no_launch_no_mcp_frame_is_sent_anywhere() {
    let mut no_host = rig(HostSpec::default(), &[("f1", HostSpec::default())]).await;
    let handed = no_host.hand().await;
    assert_eq!(handed.sent(), SentState::None);
    assert_eq!(no_host.mcp_frames_anywhere(), 0);
    assert_eq!(no_host.fixture.requests(), 0, "and the sidecar was not even asked for a snapshot");
    handed.release().await;

    let mut no_launch = rig_with(capable(), &[("f1", capable())], None, false).await;
    let handed = no_launch.hand().await;
    assert_eq!(handed.sent(), SentState::None);
    assert_eq!(no_launch.mcp_frames_anywhere(), 0);
    assert_eq!(no_launch.fixture.requests(), 0);
    handed.release().await;
}

#[tokio::test]
async fn an_unanswered_hold_is_ambiguous_and_no_second_host_is_tried() {
    let mut rig = rig(reply(McpHoldReply::WithholdAfterAccept), &[("f1", capable())]).await;

    let handed = rig.hand().await;

    assert_eq!(handed.sent(), SentState::Ambiguous);
    assert_eq!(hold_frames(&rig.world, CURRENT).len(), 1);
    assert_eq!(hold_frames(&rig.world, "f1").len(), 0, "the primary may be holding: nobody else is asked");
    handed.release().await;
}

#[tokio::test]
async fn a_rejection_is_recorded_and_no_second_host_is_tried() {
    let mut rig = rig(reply(McpHoldReply::Reject("busy".into())), &[("f1", capable())]).await;

    let handed = rig.hand().await;

    assert_eq!(handed.sent(), SentState::Rejected("busy".into()));
    assert_eq!(hold_frames(&rig.world, "f1").len(), 0);
    handed.release().await;
}

#[tokio::test]
async fn a_hold_is_sent_only_to_armed_hosts() {
    // The older host will not arm, and an offload would refuse; a relaunch tolerates it.
    let (world, port) = machine_with_current(capable(), &[("old", HostSpec { no_arm_ack: true, ..capable() })]);
    rediscover_hosts(&port).await.unwrap();
    let fixture = Fixture::start(config_with_token(None)).await;
    let tp = TestPort::new(Some(fixture.launch()));
    let mut hold = crate::state::host_lifecycle::begin_relaunch(&port).await.unwrap();
    hold.arm_detach(600, "tok", Some(ArmDetachPurpose::Local)).await.unwrap();

    let handed = handover_txn(&*tp, hold, McpHoldReason::Relaunch).await;

    assert_eq!(handed.sent(), SentState::Accepted);
    assert_eq!(hold_frames(&world, CURRENT).len(), 1);
    assert_eq!(world.count("old", "HoldMcp"), 0);
    handed.release().await;
}

/// The frame cap is enforced on the frame the production handover sends, measured with the final
/// spec and the host credential: two results that each fit a reply but not one frame together.
#[tokio::test]
async fn a_snapshot_too_big_for_one_frame_reaches_the_host_without_its_tool_list() {
    // A long sidecar bearer widens the margin: it travels in the frame too.
    let sidecar_token = "b".repeat(512);
    let (config, init, list) = config_at_the_body_cap(&sidecar_token);
    let (world, port) = machine_with_current(capable(), &[]);
    rediscover_hosts(&port).await.unwrap();
    let fixture = Fixture::start(config).await;
    let tp = TestPort::new(Some(fixture.launch()));
    let mut hold = begin_offload(&port).await.unwrap();
    hold.arm_detach(600, "tok", Some(ArmDetachPurpose::Local)).await.unwrap();
    let whole = McpHoldSpec {
        port: fixture.launch().port,
        configured_port: CONFIGURED,
        bind_host: "127.0.0.1".into(),
        auth_token: Some(sidecar_token.clone()),
        reason: McpHoldReason::Offload,
        initialize_result: Some(init),
        tools_list_result: Some(list),
    };
    let payload = |spec: &McpHoldSpec| {
        encode(&Frame::Ctrl(Control::HoldMcp { req: u64::MAX, token: HOST_TOK.into(), spec: spec.clone() })).len() - 5
    };
    assert!(payload(&whole) > MAX_FRAME_LEN, "the premise: together the parts do not fit one frame");

    let handed = handover_txn(&*tp, hold, McpHoldReason::Offload).await;

    assert_eq!(handed.sent(), SentState::Accepted, "the host read the frame and accepted");
    let holds = hold_frames(&world, CURRENT);
    assert_eq!(holds.len(), 1);
    let (_, token, spec) = &holds[0];
    assert_eq!(token, HOST_TOK);
    assert_eq!(*spec, McpHoldSpec { tools_list_result: None, ..whole }, "the tool list went first; everything else is whole");
    assert!(payload(spec) <= MAX_FRAME_LEN);
    handed.release().await;
}

// ---- T5: the network lock (F4) -----------------------------------------------------------------

#[tokio::test]
async fn a_competing_network_operation_costs_the_hold_not_the_exit() {
    let mut rig = rig(capable(), &[]).await;
    let competitor = rig.tp.lock.clone().lock_owned().await;

    let started = Instant::now();
    let handed = rig.hand().await;

    let waited = started.elapsed();
    assert!(waited >= Duration::from_secs(2) && waited <= Duration::from_millis(2500), "bounded by the lock wait: {waited:?}");
    assert_eq!(handed.sent(), SentState::None);
    assert_eq!(rig.tp.reads.load(Ordering::SeqCst), 0, "nothing was read without the lock");
    assert_eq!(rig.mcp_frames_anywhere(), 0);
    drop(competitor);
    let (_, delivered) = handed.release().await;
    assert!(delivered);
}

#[tokio::test]
async fn the_lock_is_held_from_before_the_read_until_the_exit_commits_or_the_handover_is_released() {
    for commit in [false, true] {
        let gate = Arc::new(EventGate::default());
        let mut rig = rig(reply(McpHoldReply::GatedAccept(gate.clone())), &[]).await;
        let (tp, hold) = (rig.tp.clone(), rig.hold.take().unwrap());
        let txn = tokio::spawn(async move { handover_txn(&*tp, hold, McpHoldReason::Offload).await });
        rig.tp.read_signal.notified().await;
        let competitor = compete(&rig.tp.lock);
        gate.wait_reached(1).await;
        still_blocked(&competitor, "the transaction is still awaiting the gated reply").await;

        gate.release();
        let handed = txn.await.unwrap();
        assert_eq!(handed.sent(), SentState::Accepted);
        still_blocked(&competitor, "handover_txn returned, but the exit has not happened").await;

        if commit {
            handed.commit();
            tokio::time::sleep(Duration::from_millis(500)).await;
            assert!(!competitor.is_finished(), "after commit the lock is held for the rest of the process");
            competitor.abort();
            assert_eq!(rig.since(CURRENT), ["HoldMcp"], "a commit sends no ReleaseMcp and no Disarm");
            assert_eq!(rig.since("cur"), ["HoldMcp"]);
        } else {
            handed.release().await;
            acquired(competitor, "release has returned").await;
        }
    }
}

// ---- T7: rollback ----------------------------------------------------------------------------------

#[tokio::test]
async fn an_accepted_hold_is_released_to_its_host_only_and_then_every_host_is_disarmed() {
    let mut rig = rig(capable(), &[("f1", capable())]).await;
    let handed = rig.hand().await;
    assert_eq!(rig.world.mcp_state(CURRENT), McpState::Pending);

    let outcome = handed.release().await;

    assert_eq!(outcome, (Cleanup::Released { was_holding: false }, true));
    assert_eq!(rig.world.mcp_state(CURRENT), McpState::Idle);
    assert_eq!(rig.since(CURRENT), ["HoldMcp", "ReleaseMcp", "Disarm"], "in that order");
    assert_eq!(rig.since("f1"), ["Disarm"], "the other armed host is disarmed and never sent a ReleaseMcp");
    assert_eq!(release_frames(&rig.world, CURRENT), [HOST_TOK], "the release carries the same credential");
}

#[tokio::test]
async fn an_ambiguous_hold_is_undone_by_the_disarm_alone() {
    let mut rig = rig(reply(McpHoldReply::WithholdAfterAccept), &[]).await;
    let handed = rig.hand().await;
    assert_eq!(rig.world.mcp_state(CURRENT), McpState::Pending, "the host did install the hold");

    let outcome = handed.release().await;

    assert_eq!(outcome, (Cleanup::ViaDisarm, true));
    assert_eq!(release_frames(&rig.world, CURRENT).len(), 0, "no ReleaseMcp: the reply may have been a rejection");
    assert_eq!(rig.world.mcp_state(CURRENT), McpState::Idle, "the Disarm cleared the Pending hold");
}

#[tokio::test]
async fn a_holder_the_app_did_not_start_is_left_running() {
    let mut rig = rig(reply(McpHoldReply::WithholdAfterReject), &[]).await;
    rig.world.set_mcp_running(CURRENT, McpRunning::Handback);
    let handed = rig.hand().await;
    assert_eq!(handed.sent(), SentState::Ambiguous, "the refusal was lost");

    let outcome = handed.release().await;

    assert_eq!(outcome, (Cleanup::ViaDisarm, true));
    assert_eq!(release_frames(&rig.world, CURRENT).len(), 0);
    assert_eq!(rig.world.mcp_state(CURRENT), McpState::Running(McpRunning::Handback), "the foreign holder was not stopped");
}

#[tokio::test]
async fn a_rejected_hold_needs_no_release() {
    let mut rig = rig(reply(McpHoldReply::Reject("busy".into())), &[]).await;
    let handed = rig.hand().await;

    let outcome = handed.release().await;

    assert_eq!(outcome, (Cleanup::NotNeeded, true));
    assert_eq!(release_frames(&rig.world, CURRENT).len(), 0);
    assert_eq!(rig.count_since(CURRENT, "Disarm"), 1, "the hosts are still disarmed");
}

#[tokio::test]
async fn a_pipe_that_died_after_the_accept_is_an_unconfirmed_release() {
    let mut rig = rig(capable(), &[("f1", capable())]).await;
    let handed = rig.hand().await;
    rig.kill(CURRENT).await;

    let started = Instant::now();
    let (cleanup, delivered) = handed.release().await;

    assert!(matches!(cleanup, Cleanup::Unconfirmed(_)), "{cleanup:?}");
    assert!(!delivered, "the dead host could not acknowledge the disarm");
    assert!(started.elapsed() < Duration::from_millis(4900), "{:?}", started.elapsed());
    assert_eq!(rig.count_since("f1", "Disarm"), 1, "the other host is still disarmed");
}

#[tokio::test]
async fn a_host_that_stops_answering_after_the_accept_is_an_unconfirmed_release_on_a_live_connection() {
    let mut rig = rig(capable(), &[]).await;
    let handed = rig.hand().await;
    rig.world.silence_mcp(CURRENT);

    let started = Instant::now();
    let (cleanup, delivered) = handed.release().await;

    assert!(matches!(cleanup, Cleanup::Unconfirmed(_)), "{cleanup:?}");
    assert!(delivered, "the Disarm is not an MCP frame: it is still answered");
    assert!(started.elapsed() < Duration::from_millis(4900), "{:?}", started.elapsed());
    assert!(rig.client().is_alive(), "and the connection is still open");
}

#[tokio::test]
async fn an_ambiguous_hold_whose_disarm_is_lost_is_unconfirmed() {
    let mut rig = rig(reply(McpHoldReply::WithholdAfterAccept), &[]).await;
    let handed = rig.hand().await;
    rig.kill(CURRENT).await;

    let (cleanup, delivered) = handed.release().await;

    assert_eq!((cleanup, delivered), (Cleanup::ViaDisarm, false));
}

#[tokio::test]
async fn dropping_the_handover_keeps_the_lock_until_the_disarm_is_acknowledged() {
    let gate = Arc::new(EventGate::default());
    let mut rig = rig(capable(), &[("f1", capable())]).await;
    let handed = rig.hand().await;
    rig.world.gate_disarm_acks(CURRENT, &gate);
    let competitor = compete(&rig.tp.lock);

    drop(handed);
    gate.wait_reached(1).await;

    still_blocked(&competitor, "the Disarm has not been acknowledged yet").await;
    assert!(rig.admission_closed(), "and terminal admission stays closed with it");
    gate.release();
    acquired(competitor, "the Disarm was acknowledged").await;
    until("admission to reopen", || rig.admission_open()).await;
    assert_eq!(rig.since(CURRENT), ["HoldMcp", "ReleaseMcp", "Disarm"], "one cleanup sequence, no second Disarm");
    assert_eq!(rig.since("f1"), ["Disarm"]);
}

#[tokio::test]
async fn releasing_frees_the_lock_only_after_the_disarm_is_acknowledged() {
    let gate = Arc::new(EventGate::default());
    let mut rig = rig(capable(), &[]).await;
    let handed = rig.hand().await;
    rig.world.gate_disarm_acks(CURRENT, &gate);
    let competitor = compete(&rig.tp.lock);

    let release = tokio::spawn(handed.release());
    gate.wait_reached(1).await;
    still_blocked(&competitor, "release is still waiting for the Disarm").await;
    assert!(!release.is_finished());

    gate.release();
    assert_eq!(release.await.unwrap(), (Cleanup::Released { was_holding: false }, true));
    acquired(competitor, "release has returned").await;
}

#[tokio::test]
async fn an_ambiguous_handover_that_is_dropped_gets_a_disarm_and_no_release() {
    let mut rig = rig(reply(McpHoldReply::WithholdAfterAccept), &[]).await;
    let handed = rig.hand().await;
    let competitor = compete(&rig.tp.lock);

    drop(handed);
    acquired(competitor, "the cleanup finished").await;

    assert_eq!(rig.since(CURRENT), ["HoldMcp", "Disarm"], "Disarm only");
    assert_eq!(rig.world.mcp_state(CURRENT), McpState::Idle);
}

#[tokio::test]
async fn a_transaction_cancelled_while_the_reply_is_out_takes_the_ambiguous_safe_path() {
    let gate = Arc::new(EventGate::default());
    let mut rig = rig(reply(McpHoldReply::GatedAccept(gate.clone())), &[("f1", capable())]).await;
    let (tp, hold) = (rig.tp.clone(), rig.hold.take().unwrap());
    let txn = tokio::spawn(async move { handover_txn(&*tp, hold, McpHoldReason::Offload).await });
    rig.tp.read_signal.notified().await;
    gate.wait_reached(1).await;
    let competitor = compete(&rig.tp.lock);

    txn.abort();
    assert!(matches!(txn.await, Err(e) if e.is_cancelled()));
    acquired(competitor, "the cleanup's Disarm was acknowledged").await;

    assert_eq!(rig.since(CURRENT), ["HoldMcp", "Disarm"], "Disarm and no ReleaseMcp");
    assert_eq!(rig.since("f1"), ["Disarm"], "exactly one Disarm per armed host");
    assert_eq!(rig.world.mcp_state(CURRENT), McpState::Idle);
    assert_eq!(rig.client().pending_requests(), 0, "only the lease can explain this: the 2 s timeout has not run");
}

#[tokio::test]
async fn a_transaction_cancelled_while_waiting_for_the_lock_sends_nothing_and_disarms_once() {
    let mut rig = rig(capable(), &[("f1", capable())]).await;
    let held = rig.tp.lock.clone().lock_owned().await;
    let (tp, hold) = (rig.tp.clone(), rig.hold.take().unwrap());
    let txn = tokio::spawn(async move { handover_txn(&*tp, hold, McpHoldReason::Offload).await });
    tokio::time::sleep(Duration::from_millis(200)).await;

    txn.abort();
    assert!(matches!(txn.await, Err(e) if e.is_cancelled()));
    until("the disarms", || rig.count_since(CURRENT, "Disarm") == 1 && rig.count_since("f1", "Disarm") == 1).await;
    tokio::time::sleep(Duration::from_millis(300)).await;

    assert_eq!(rig.mcp_frames_anywhere(), 0);
    assert_eq!(rig.tp.reads.load(Ordering::SeqCst), 0, "the inputs were never read");
    assert_eq!(rig.count_since(CURRENT, "Disarm"), 1);
    assert_eq!(rig.count_since("f1", "Disarm"), 1);
    drop(held);
}

/// Cancelling the task that awaits `release` must not cancel the cleanup it started.
async fn a_cancelled_release_still_completes_its_cleanup(case: &str) {
    let gate = Arc::new(EventGate::default());
    let mut rig = rig(capable(), &[("f1", capable()), ("f2", capable())]).await;
    let handed = rig.hand().await;
    match case {
        "release-reply" => rig.world.gate_release_acks(CURRENT, &gate),
        _ => rig.world.gate_disarm_acks(CURRENT, &gate),
    }
    let competitor = compete(&rig.tp.lock);

    let waiter = tokio::spawn(handed.release());
    gate.wait_reached(1).await;
    waiter.abort();
    assert!(waiter.await.unwrap_err().is_cancelled());

    still_blocked(&competitor, &format!("{case}: the cleanup is still waiting for a reply")).await;
    assert!(rig.admission_closed(), "{case}: terminal admission is still closed");
    gate.release();
    acquired(competitor, case).await;
    until("admission to reopen", || rig.admission_open()).await;
    for host in ["cur", "f1", "f2"] {
        assert_eq!(rig.count_since(host, "Disarm"), 1, "{case}: exactly one Disarm on {host}");
    }
    assert_eq!(release_frames(&rig.world, CURRENT).len(), 1, "{case}: no second cleanup sequence");
}

#[tokio::test]
async fn a_release_cancelled_while_the_release_reply_is_gated_still_finishes() {
    a_cancelled_release_still_completes_its_cleanup("release-reply").await;
}

#[tokio::test]
async fn a_release_cancelled_while_a_disarm_ack_is_gated_still_finishes() {
    a_cancelled_release_still_completes_its_cleanup("disarm-ack").await;
}

#[tokio::test]
async fn a_release_polled_once_by_hand_and_dropped_still_finishes() {
    let mut rig = rig(capable(), &[("f1", capable()), ("f2", capable())]).await;
    let handed = rig.hand().await;
    let competitor = compete(&rig.tp.lock);

    // The first poll moves the parts into the spawned cleanup task, which has not run: this is a
    // current-thread runtime and the test has not yielded.
    let mut release = Box::pin(handed.release());
    assert!(futures::poll!(release.as_mut()).is_pending());
    drop(release);
    assert!(rig.admission_closed(), "the cleanup has not run, and admission is still closed");

    acquired(competitor, "the spawned cleanup ran to the end").await;
    until("admission to reopen", || rig.admission_open()).await;
    for host in ["cur", "f1", "f2"] {
        assert_eq!(rig.count_since(host, "Disarm"), 1, "exactly one Disarm on {host}");
    }
    assert_eq!(release_frames(&rig.world, CURRENT).len(), 1);
}

#[tokio::test]
async fn an_aborted_release_sender_leaves_no_waiter() {
    let gate = Arc::new(EventGate::default());
    let rig = rig(capable(), &[]).await;
    let client = rig.client();
    rig.world.gate_release_acks(CURRENT, &gate);
    let sender = tokio::spawn({
        let client = client.clone();
        async move { client.release_mcp(HOST_TOK).await }
    });
    gate.wait_reached(1).await;
    assert_eq!(client.pending_requests(), 1);

    sender.abort();
    assert!(sender.await.unwrap_err().is_cancelled());

    assert_eq!(client.pending_requests(), 0, "the lease removed the waiter at once, long before the 2 s timeout");
}

#[tokio::test]
async fn a_commit_sends_nothing_and_keeps_the_lock() {
    let mut rig = rig(capable(), &[("f1", capable())]).await;
    let handed = rig.hand().await;
    let competitor = compete(&rig.tp.lock);

    handed.commit();
    tokio::time::sleep(Duration::from_millis(400)).await;

    assert_eq!(rig.since(CURRENT), ["HoldMcp"], "no ReleaseMcp and no Disarm");
    assert_eq!(rig.since("f1"), Vec::<&str>::new());
    assert!(!competitor.is_finished(), "the lock stays held for the rest of the process");
    competitor.abort();
}

// ---- no runtime ---------------------------------------------------------------------------------------

#[tokio::test]
async fn a_handover_dropped_where_there_is_no_runtime_neither_panics_nor_sends() {
    capture_logs();
    let mut rig = rig(capable(), &[]).await;
    let handed = rig.hand().await;
    assert_eq!(handed.sent(), SentState::Accepted);
    let before = rig.world.kinds(CURRENT).len();

    std::thread::spawn(move || drop(handed)).join().expect("dropping without a runtime does not panic");
    tokio::time::sleep(Duration::from_millis(300)).await;

    assert_eq!(rig.world.kinds(CURRENT).len(), before, "no frame was sent");
    assert!(
        captured_logs().iter().any(|line| line.contains("no runtime; cleanup unconfirmed")),
        "the unconfirmed cleanup is logged"
    );
}
