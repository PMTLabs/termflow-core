//! Exit, offload, update commit and a sibling's update over fake hosts. Every
//! assertion names the host that received a frame: "a Shutdown was sent" is true
//! of an implementation that only ever talks to the current host.

use super::fake_hosts::*;
use super::*;
use crate::state::host_lifecycle::{
    begin_offload, begin_relaunch, begin_update, connected_retention, exit_hosts, owned_hosts, owned_hosts_now, sibling_arm,
    sibling_disarm, update_mode_of, update_refusal, LifecyclePort, SiblingArm, SiblingSlot, EXIT_QUIESCE_BOUND,
    HOLD_QUIESCE_BOUND, SIBLING_QUIESCE_BOUND,
};
use crate::state::host_routing::{place, Placement};
use crate::state::host_table::Busy;
use crate::state::update_survival::{FullReason, UpdateMode};
use crate::pty_host_client::HostRetention;
use termflow_pty_protocol::{ArmDetachPurpose, Control, Frame, CAP_ATTACH_ACK};

pub(super) const CURRENT: &str = "cur";
pub(super) const SEC: Duration = Duration::from_secs(1);

pub(super) fn secs(n: u64) -> Duration {
    Duration::from_secs(n)
}

impl LifecyclePort for FakePort {
    /// Like the real one: a bare connection, nothing started, nothing published.
    async fn connect_for_exit(&self, candidate: &HostCandidate) -> Result<PtyHostClient, String> {
        self.connect(candidate, HostRole::Frozen, None)
            .await
            .map(|opened| opened.client)
            .map_err(|failure| failure.reason)
    }

    fn arm_token(&self) -> String {
        "tok".to_string()
    }

    fn sibling_slot(&self) -> &SiblingSlot {
        &self.0.sibling_slot
    }
}

pub(super) fn frozen(name: &str) -> HostCandidate {
    candidate(name, HostRole::Frozen)
}

fn current() -> HostCandidate {
    candidate(CURRENT, HostRole::Current)
}

pub(super) fn holding(keys: &[(&str, u32)]) -> HostSpec {
    HostSpec { sessions: keys.iter().map(|(k, pid)| meta(k, *pid)).collect(), ..HostSpec::default() }
}

/// The current host and these older ones, all discovered.
pub(super) fn machine(old: &[(&str, HostSpec)]) -> (Arc<World>, FakePort) {
    machine_with_current(HostSpec::default(), old)
}

/// Like [`machine`], with the current host behaving as `current_spec` says.
fn machine_with_current(current_spec: HostSpec, old: &[(&str, HostSpec)]) -> (Arc<World>, FakePort) {
    let world = World::new();
    world.add_host(CURRENT, current_spec);
    let mut candidates = Vec::new();
    for (name, spec) in old {
        world.add_host(name, spec.clone());
        candidates.push(frozen(name));
    }
    candidates.push(current());
    let port = FakePort::new(&world, CURRENT);
    port.set_candidates(candidates);
    (world, port)
}

/// Every host adopted, as after start-up; their clients announce an exit, as the
/// real connection's capabilities make them.
pub(super) async fn adopted(old: &[(&str, HostSpec)]) -> (Arc<World>, FakePort) {
    let (world, port) = machine(old);
    rediscover_hosts(&port).await.unwrap();
    announce_capability(&port);
    (world, port)
}

fn announce_capability(port: &FakePort) {
    let clients = port.current_client().into_iter().chain(port.frozen_hosts().into_iter().map(|h| h.client));
    for client in clients {
        client.set_shutdown_control(true);
    }
}

/// A host that is running and advertised but this instance never adopted.
pub(super) fn undiscovered_until_now(world: &Arc<World>, port: &FakePort, name: &str, spec: HostSpec) -> HostCandidate {
    world.add_host(name, spec);
    let c = frozen(name);
    let mut all = port.candidates();
    all.insert(0, c.clone());
    port.set_candidates(all);
    c
}

/// How many frames each host has received so far.
pub(super) fn marks(world: &World, hosts: &[&str]) -> Vec<usize> {
    hosts.iter().map(|h| world.kinds(h).len()).collect()
}

/// What `host` received after its `from`th frame.
pub(super) fn since(world: &World, host: &str, from: usize) -> Vec<&'static str> {
    world.kinds(host)[from..].to_vec()
}

fn arm_frames(world: &World, host: &str) -> Vec<(u64, Option<ArmDetachPurpose>)> {
    world
        .frames_of(host)
        .into_iter()
        .filter_map(|f| match f {
            Frame::Ctrl(Control::ArmDetach { timeout_secs, purpose, .. }) => Some((timeout_secs, purpose)),
            _ => None,
        })
        .collect()
}

// ---- exit -------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn exit_disarms_shuts_down_and_closes_every_host() {
    let (world, port) = adopted(&[("h1", holding(&[("k1", 11)])), ("h2", HostSpec::default())]).await;
    let hosts = [CURRENT, "h1", "h2"];
    let before = marks(&world, &hosts);

    let report = exit_hosts(&port).await;
    tokio::time::sleep(SEC).await;

    for (host, from) in hosts.iter().zip(before) {
        assert_eq!(
            since(&world, host, from),
            ["Disarm", "Shutdown", "Eof"],
            "{host}: disarm, then the announcement, then the stream closed"
        );
    }
    assert_eq!(report.hosts.len(), 3, "every owned host is accounted for");
    assert!(report.problems().next().is_none(), "{:?}", report.hosts);
    assert!(report.drained);
}

#[tokio::test(start_paused = true)]
async fn exit_attempts_unreachable_compatible_host_within_3s_and_logs_by_name() {
    let (world, port) = adopted(&[]).await;
    // A compatible host that is known to exist but takes a minute to accept.
    undiscovered_until_now(&world, &port, "slow", HostSpec { connect_delay: secs(60), ..HostSpec::default() });
    let started = Instant::now();

    let report = exit_hosts(&port).await;

    assert!(started.elapsed() <= secs(3) + Duration::from_millis(200), "took {:?}", started.elapsed());
    assert!(started.elapsed() >= secs(3), "the attempt is given its whole 3 s, not abandoned early");
    let failed: Vec<_> = report.problems().collect();
    assert_eq!(failed.len(), 1, "{:?}", report.hosts);
    assert!(failed[0].name.contains("slow"), "the failure is logged by host name: {}", failed[0].name);
    assert!(failed[0].problem.as_deref().unwrap().contains("3 s"), "{:?}", failed[0].problem);
    assert!(world.kinds("slow").is_empty(), "nothing reached it");
    assert_eq!(world.kinds(CURRENT).last(), Some(&"Eof"), "the host it could reach was still released");
}

#[tokio::test(start_paused = true)]
async fn exit_reaches_a_host_it_never_adopted_although_its_own_quiesce_refuses_every_adoption() {
    let (world, port) = adopted(&[]).await;
    undiscovered_until_now(&world, &port, "legacy", HostSpec::default());

    exit_hosts(&port).await;
    tokio::time::sleep(SEC).await;

    // Exit's quiesce is sticky, so an ordinary adoption is refused for good...
    assert!(matches!(port.table().begin_adoption(), Err(Busy::Lifecycle(_))));
    // ...yet the host that was never adopted was reached, once, over a bare
    // connection that asks nothing of admission, and released.
    assert_eq!(world.kinds("legacy"), ["Disarm", "Shutdown", "Eof"]);
    assert_eq!(port.connect_count("legacy"), 1);
    assert_eq!(port.0.disconnects.load(std::sync::atomic::Ordering::SeqCst), 0, "closing a connection on purpose is not a loss");
    assert!(port.frozen_hosts().is_empty());
}

#[tokio::test(start_paused = true)]
async fn exit_disarms_and_closes_an_unresolved_armed_host_that_cannot_hear_a_shutdown() {
    let (world, port) = adopted(&[]).await;
    // An older host an earlier offload left armed: its record lists no shutdown
    // control, so `shutdown()` is a no-op for it and only the disarm releases it.
    let mut armed = frozen("armed");
    armed.record.as_mut().unwrap().capabilities = CAP_ATTACH_ACK;
    world.add_host("armed", HostSpec::default());
    let mut all = port.candidates();
    all.insert(0, armed);
    port.set_candidates(all);
    assert!(
        owned_hosts(&port).await.iter().any(|h| h.endpoint == "armed" && h.unresolved.is_some()),
        "precondition: it is owned and still unresolved"
    );

    let report = exit_hosts(&port).await;
    tokio::time::sleep(SEC).await;

    assert_eq!(
        world.kinds("armed"),
        ["Disarm", "Eof"],
        "disarmed so it stops holding for 900 s, no shutdown frame it cannot hear, then the stream closed"
    );
    assert!(report.problems().next().is_none(), "{:?}", report.hosts);
}

#[tokio::test(start_paused = true)]
async fn exit_reaches_a_registered_host_whose_connection_dropped() {
    let (world, port) = adopted(&[("h1", holding(&[("k1", 11)]))]).await;
    // The connection dies, the host does not: it still holds k1.
    world.kill_connections("h1");
    tokio::time::sleep(SEC).await;
    let before = world.kinds("h1").len();

    let report = exit_hosts(&port).await;
    tokio::time::sleep(SEC).await;

    assert_eq!(since(&world, "h1", before), ["Disarm", "Shutdown", "Eof"], "released over a fresh connection");
    assert_eq!(port.connect_count("h1"), 2, "the adoption's connection and exit's one");
    assert!(report.problems().next().is_none(), "{:?}", report.hosts);
}

#[tokio::test(start_paused = true)]
async fn exit_never_touches_incompatible_host() {
    let (world, port) = adopted(&[]).await;
    world.add_host("alien", HostSpec::default());
    let mut alien = frozen("alien");
    alien.record = Some(record("alien", 99, 99));
    let mut all = port.candidates();
    all.insert(0, alien);
    port.set_candidates(all);

    let report = exit_hosts(&port).await;
    tokio::time::sleep(SEC).await;

    assert_eq!(port.connect_count("alien"), 0, "no connection was even attempted");
    assert!(world.kinds("alien").is_empty());
    assert!(report.hosts.iter().all(|h| !h.name.contains("alien")), "it is not part of the owned set");
}

#[tokio::test(start_paused = true)]
async fn quiesce_timeout_exit_proceeds_offload_refuses() {
    let (world, port) = adopted(&[("h1", HostSpec::default())]).await;
    let hosts = [CURRENT, "h1"];
    // A create that never finishes holds a ticket.
    let _stuck = port.table().begin(HostChannel::Primary).unwrap();

    let started = Instant::now();
    let err = begin_offload(&port).await.err().expect("an offload must not go ahead over an operation in flight");
    assert!(err.starts_with(LIFECYCLE_BUSY), "{err}");
    assert!(started.elapsed() >= HOLD_QUIESCE_BOUND, "it waited for the whole bound first");
    assert_eq!(world.count_everywhere("Arm"), 0, "nothing was armed");
    assert!(port.table().begin(HostChannel::Primary).is_ok(), "a refused offload reopens admission");

    let before = marks(&world, &hosts);
    let started = Instant::now();
    let report = tokio::time::timeout(secs(60), exit_hosts(&port)).await.expect("exit must not wait forever");
    tokio::time::sleep(SEC).await;
    assert!(started.elapsed() >= EXIT_QUIESCE_BOUND && started.elapsed() < secs(15), "{:?}", started.elapsed());
    assert!(!report.drained, "the deadline passed with a ticket still held");
    for (host, from) in hosts.iter().zip(before) {
        assert_eq!(since(&world, host, from), ["Disarm", "Shutdown", "Eof"], "{host}: exit went ahead");
    }
}

// ---- offload ----------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn offload_and_update_are_refused_while_another_lifecycle_change_holds() {
    let (world, port) = adopted(&[("h1", HostSpec::default())]).await;

    let hold = begin_offload(&port).await.unwrap();
    let refused = begin_update(&port).await.err().expect("an update commit cannot overlap an offload");
    assert!(refused.starts_with(LIFECYCLE_BUSY), "{refused}");
    assert_eq!(world.count_everywhere("Arm"), 0, "the refused one armed nothing");
    // The refusal must not have reopened admission under the offload that holds it.
    assert!(matches!(port.table().begin(HostChannel::Primary), Err(Busy::Lifecycle(_))));
    hold.release().await;

    exit_hosts(&port).await;
    for refused in [begin_offload(&port).await.err(), begin_update(&port).await.err()] {
        let refused = refused.expect("nothing is armed once exit has begun");
        assert!(refused.starts_with(LIFECYCLE_BUSY), "{refused}");
    }
    assert!(matches!(port.table().begin(HostChannel::Primary), Err(Busy::Lifecycle(_))), "exit never reopens");
}

#[tokio::test(start_paused = true)]
async fn offload_arms_every_generation() {
    let (world, port) = adopted(&[("h1", holding(&[("k1", 11)])), ("h2", HostSpec::default())]).await;

    let mut hold = begin_offload(&port).await.unwrap();
    hold.arm_detach(600, "tok", Some(ArmDetachPurpose::Local)).await.unwrap();

    for host in [CURRENT, "h1", "h2"] {
        assert_eq!(
            arm_frames(&world, host),
            [(600, Some(ArmDetachPurpose::Local))],
            "{host}: exactly one arm, with the purpose and window the offload asked for"
        );
    }
    assert!(matches!(port.table().begin(HostChannel::Primary), Err(Busy::Lifecycle(_))), "admission stays closed");
}

#[tokio::test(start_paused = true)]
async fn arm_failure_on_second_rolls_back_first() {
    let (world, port) = adopted(&[("h1", HostSpec { no_arm_ack: true, ..HostSpec::default() })]).await;
    let hosts = [CURRENT, "h1"];
    let before = marks(&world, &hosts);

    let mut hold = begin_offload(&port).await.unwrap();
    let err = hold.arm_detach(600, "tok", Some(ArmDetachPurpose::Local)).await.expect_err("one host never acked");

    assert!(err.contains("h1"), "the refusing host is named: {err}");
    assert_eq!(since(&world, CURRENT, before[0]), ["Arm", "Disarm"], "the host that did arm is released again");
    assert_eq!(
        since(&world, "h1", before[1]),
        ["Arm", "Disarm"],
        "the host that did not acknowledge is released too: its arm may have landed"
    );
    drop(hold);
    assert!(port.table().begin(HostChannel::Primary).is_ok(), "the failed offload reopens admission");
}

#[tokio::test(start_paused = true)]
async fn offload_refuses_when_frozen_disconnected() {
    let (world, port) = adopted(&[("h1", HostSpec::default())]).await;
    world.kill_connections("h1");
    tokio::time::sleep(SEC).await;

    let err = begin_offload(&port).await.err().expect("a disconnected host cannot be armed");

    assert!(err.contains("h1"), "the refusal names the host: {err}");
    assert_eq!(world.count_everywhere("Arm"), 0, "all or nothing: the host that was reachable is not armed either");
    assert!(port.table().begin(HostChannel::Primary).is_ok(), "the refusal reopens admission");
}

#[tokio::test(start_paused = true)]
async fn offload_refuses_when_candidate_unresolved() {
    let (world, port) = adopted(&[]).await;
    // A busy legacy host an earlier offload armed, never adopted by this run.
    undiscovered_until_now(&world, &port, "legacy", HostSpec::default());

    let err = begin_offload(&port).await.err().expect("a host that was never reached cannot be armed");

    assert!(err.contains("legacy"), "{err}");
    assert_eq!(world.count_everywhere("Arm"), 0);
    assert_eq!(port.connect_count("legacy"), 0, "the check does not touch it");
    assert!(port.table().begin(HostChannel::Primary).is_ok());
}

#[tokio::test(start_paused = true)]
async fn offload_refuses_when_a_connected_host_has_not_listed() {
    let (world, port) = adopted(&[("mute", HostSpec { list: ListBehavior::Never, ..HostSpec::default() })]).await;

    let err = begin_offload(&port).await.err().expect("what it holds is not known");

    assert!(err.contains("mute") && err.contains("not reported"), "{err}");
    assert_eq!(world.count_everywhere("Arm"), 0);
}

#[tokio::test(start_paused = true)]
async fn offload_with_no_host_keeps_the_existing_refusal() {
    let (_world, port) = machine(&[]);
    port.set_candidates(vec![]);
    let err = begin_offload(&port).await.err().unwrap();
    assert_eq!(err, "pty-host not connected — nothing to keep alive");
}

#[tokio::test(start_paused = true)]
async fn a_dropped_current_connection_is_still_owned_and_blocks_an_offload() {
    let (_world, port) = adopted(&[]).await;
    port.drop_current();

    let hosts = owned_hosts_now(&port);
    assert_eq!(hosts.len(), 1);
    assert!(!hosts[0].connected() && hosts[0].channel == Some(HostChannel::Primary));
    let err = begin_offload(&port).await.err().unwrap();
    assert!(err.contains(CURRENT) && err.starts_with("pty-host not connected"), "{err}");
}

#[tokio::test(start_paused = true)]
async fn the_owned_set_is_current_registry_and_unresolved_but_never_incompatible() {
    let (world, port) = adopted(&[("h1", HostSpec::default())]).await;
    undiscovered_until_now(&world, &port, "waiting", HostSpec::default());
    world.add_host("alien", HostSpec::default());
    let mut alien = frozen("alien");
    alien.record = Some(record("alien", 99, 99));
    let mut all = port.candidates();
    all.push(alien);
    port.set_candidates(all);

    let mut owned: Vec<(String, bool)> =
        owned_hosts(&port).await.into_iter().map(|h| (h.endpoint.clone(), h.connected())).collect();
    owned.sort();

    assert_eq!(
        owned,
        [(CURRENT.to_string(), true), ("h1".to_string(), true), ("waiting".to_string(), false)]
    );
}

#[tokio::test(start_paused = true)]
async fn a_retired_host_is_no_longer_owned() {
    let (_world, port) = adopted(&[("h1", HostSpec::default())]).await;
    let channel = HostChannel::Frozen(port.frozen_ids()[0]);
    port.table().drain_host(channel).unwrap().retire();

    let owned: Vec<_> = owned_hosts_now(&port).into_iter().map(|h| h.endpoint).collect();

    assert_eq!(owned, [CURRENT]);
}

#[tokio::test(start_paused = true)]
async fn release_disarms_every_armed_host_and_reopens_admission() {
    let (world, port) = adopted(&[("h1", HostSpec::default())]).await;
    let before = marks(&world, &[CURRENT, "h1"]);
    let mut hold = begin_offload(&port).await.unwrap();
    hold.arm_detach(600, "tok", Some(ArmDetachPurpose::Local)).await.unwrap();

    hold.release().await;

    assert_eq!(since(&world, CURRENT, before[0]), ["Arm", "Disarm"]);
    assert_eq!(since(&world, "h1", before[1]), ["Arm", "Disarm"]);
    assert!(port.table().begin(HostChannel::Primary).is_ok());
}

#[tokio::test(start_paused = true)]
async fn commit_keeps_admission_closed_until_the_process_ends() {
    let (_world, port) = adopted(&[]).await;
    let hold = begin_offload(&port).await.unwrap();

    hold.commit();

    assert!(matches!(port.table().begin(HostChannel::Primary), Err(Busy::Lifecycle(_))));
}

#[tokio::test(start_paused = true)]
async fn create_refused_with_lifecycle_busy_during_quiesce() {
    let (world, port) = adopted(&[("h1", HostSpec::default())]).await;
    let hold = begin_offload(&port).await.unwrap();

    let refused = place(&port, "tm-new", false).await.err().expect("a create is refused while the offload holds");
    assert!(refused.starts_with(LIFECYCLE_BUSY), "{refused}");
    assert_eq!(world.count_everywhere("Spawn"), 0, "and it did not fall back to spawning anywhere");

    hold.release().await;
    match place(&port, "tm-new", false).await {
        Ok(Placement::Spawn { channel, .. }) => assert_eq!(channel, HostChannel::Primary),
        other => panic!("expected a spawn on the current host once admission reopened, got {:?}", other.err()),
    }

    // The same during an exit, which never reopens.
    exit_hosts(&port).await;
    let refused = place(&port, "tm-late", false).await.err().expect("no create after exit began");
    assert!(refused.starts_with(LIFECYCLE_BUSY), "{refused}");
}

// ---- retention and update survival -------------------------------------------

#[tokio::test(start_paused = true)]
async fn retention_worst_of() {
    let (world, port) = adopted(&[("h1", HostSpec::default()), ("h2", HostSpec::default())]).await;
    let h1 = HostChannel::Frozen(port.frozen_ids()[0]);
    let h2 = HostChannel::Frozen(port.frozen_ids()[1]);
    port.set_retention(HostChannel::Primary, HostRetention::Indefinite);
    port.set_retention(h1, HostRetention::Bounded { active_secs: 900 });
    port.set_retention(h2, HostRetention::Bounded { active_secs: 300 });
    assert_eq!(
        connected_retention(&port),
        HostRetention::Bounded { active_secs: 300 },
        "the host with the shortest promise decides, not the current one"
    );

    port.set_retention(h2, HostRetention::Indefinite);
    assert_eq!(connected_retention(&port), HostRetention::Bounded { active_secs: 900 });

    // A host that is owned but not connected promises nothing we know of.
    undiscovered_until_now(&world, &port, "ghost", HostSpec::default());
    owned_hosts(&port).await;
    assert_eq!(connected_retention(&port), HostRetention::Unknown);
}

#[tokio::test(start_paused = true)]
async fn normal_unmarked_update_stays_offload_for_runtime_dir_hosts() {
    // Nothing here decides a verdict: each fake host is classified from the image
    // path the OS would report for a host started in the runtime directory, by the
    // same code a real connection goes through.
    assert!(crate::pty_host_client::runtime_host_dir().is_some(), "this machine has no data directory to install hosts in");
    let (world, port) = adopted(&[("h1", HostSpec::default()), ("h2", HostSpec::default())]).await;
    let hosts = owned_hosts_now(&port);
    assert_eq!(hosts.len(), 3);
    assert!(hosts.iter().all(|h| h.exe_in_payload == Some(false)), "{:?}", hosts.iter().map(|h| h.exe_in_payload).collect::<Vec<_>>());

    assert_eq!(update_mode_of(&hosts), (UpdateMode::Offload, vec![]));
    assert_eq!(update_refusal(&hosts), Ok(()));

    let mut hold = begin_update(&port).await.expect("an update commit goes ahead as it did before");
    assert_eq!(hold.update_mode(), (UpdateMode::Offload, vec![]));
    hold.arm_detach(600, "tok", Some(ArmDetachPurpose::Local)).await.unwrap();
    for host in [CURRENT, "h1", "h2"] {
        assert_eq!(arm_frames(&world, host).len(), 1, "{host} is armed");
    }
}

/// Where a host runs from is told from the image path the OS reports for the
/// process behind the connection. When that lookup finds nothing the origin is
/// unknown, and an unknown origin is not offloaded.
#[cfg(windows)]
#[tokio::test(start_paused = true)]
async fn a_host_whose_image_path_cannot_be_read_blocks_an_update() {
    let (_world, port) = adopted(&[("h1", HostSpec::default())]).await;
    assert_eq!(update_refusal(&owned_hosts_now(&port)), Ok(()));
    for host in port.frozen_hosts() {
        host.client.inject_exe_image(None);
    }

    let hosts = owned_hosts_now(&port);

    let (mode, reasons) = update_mode_of(&hosts);
    assert_eq!(mode, UpdateMode::Full);
    assert!(matches!(&reasons[..], [FullReason::HostOriginUnknown(name)] if name.contains("h1")), "{reasons:?}");
}

#[tokio::test(start_paused = true)]
async fn the_update_reports_each_host_that_cannot_survive_it() {
    let (_world, port) = adopted(&[("inside", HostSpec::default()), ("mystery", HostSpec::default())]).await;
    port.set_exe_origin("inside", Some(true));
    port.set_exe_origin("mystery", None);
    let hosts = owned_hosts_now(&port);

    let (mode, reasons) = update_mode_of(&hosts);

    assert_eq!(mode, UpdateMode::Full);
    assert_eq!(reasons.len(), 2, "{reasons:?}");
    assert!(matches!(&reasons[0], FullReason::HostInPayload(name) if name.contains("inside")), "{reasons:?}");
    assert!(matches!(&reasons[1], FullReason::HostOriginUnknown(name) if name.contains("mystery")), "{reasons:?}");
    let refusal = update_refusal(&hosts).unwrap_err();
    assert!(refusal.contains("inside") && refusal.contains("mystery"), "{refusal}");
    assert!(!refusal.contains(CURRENT), "the host that is safe is not named: {refusal}");
}

// ---- a sibling's update --------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn exhausted_sibling_arm_identity_refuses_before_arming_or_replacing_the_hold() {
    let (world, port) = adopted(&[]).await;
    port.sibling_slot().seed_arm_counter(u64::MAX - 1);
    assert_eq!(sibling_arm(&port, 600).await, SiblingArm::Armed(1));
    assert_eq!(arm_frames(&world, CURRENT), [(600, None)]);
    let SiblingArm::Refused(reason) = sibling_arm(&port, 600).await else { panic!("exhaustion must refuse") };
    assert!(reason.contains("identity exhausted"));
    assert_eq!(arm_frames(&world, CURRENT), [(600, None)]);
    assert_eq!(port.table().lifecycle_reason(), Some(QuiesceReason::Update));
    assert!(sibling_disarm(&port).await);
    assert_eq!(port.table().lifecycle_reason(), None);
}

#[tokio::test(start_paused = true)]
async fn sibling_arm_acts_on_every_owned_host_and_disarm_releases_them_all() {
    let (world, port) = adopted(&[("h1", HostSpec::default()), ("h2", HostSpec::default())]).await;
    let hosts = [CURRENT, "h1", "h2"];
    let before = marks(&world, &hosts);

    assert_eq!(sibling_arm(&port, 600).await, SiblingArm::Armed(3));
    for host in hosts {
        assert_eq!(arm_frames(&world, host), [(600, None)], "{host}: armed for the sibling's window, unlabelled");
    }

    assert!(sibling_disarm(&port).await);
    for (host, from) in hosts.iter().zip(before) {
        assert_eq!(since(&world, host, from), ["Arm", "Disarm"], "{host}");
    }
}

#[tokio::test(start_paused = true)]
async fn sibling_arm_refuses_when_its_host_is_in_payload_and_update_refuses_naming_it() {
    let (world, port) = adopted(&[("inside", HostSpec::default())]).await;
    port.set_exe_origin("inside", Some(true));

    let SiblingArm::Refused(reason) = sibling_arm(&port, 600).await else { panic!("the arm must be refused") };

    assert!(reason.contains("inside"), "the sibling says which of its hosts is the problem: {reason}");
    assert_eq!(world.count_everywhere("Arm"), 0, "no host was armed, the safe current one included");

    // The updating instance reads that refusal back and refuses naming the host.
    let sibling = crate::net_ports::InstanceRecord {
        profile: "rel.alt".into(),
        pid: 41,
        api_port: Some(42035),
        mcp_port: None,
        token: Some("tok".into()),
    };
    let relayed = reason.clone();
    let err = crate::sibling_coord::arm_siblings(&[sibling], move |_| std::future::ready(Err(relayed.clone())))
        .await
        .expect_err("the update must refuse");
    assert!(err.contains("rel.alt") && err.contains("inside"), "{err}");
}

#[tokio::test(start_paused = true)]
async fn sibling_arm_refuses_an_owned_host_whose_origin_is_unknown() {
    let (world, port) = adopted(&[("mystery", HostSpec::default())]).await;
    port.set_exe_origin("mystery", None);

    let SiblingArm::Refused(reason) = sibling_arm(&port, 600).await else { panic!("unknown fails closed") };

    assert!(reason.contains("mystery"), "{reason}");
    assert_eq!(world.count_everywhere("Arm"), 0);
}

#[tokio::test(start_paused = true)]
async fn sibling_arm_refuses_a_disconnected_host_and_with_no_host_has_nothing_to_arm() {
    let (world, port) = adopted(&[("h1", HostSpec::default())]).await;
    world.kill_connections("h1");
    tokio::time::sleep(SEC).await;
    let SiblingArm::Refused(reason) = sibling_arm(&port, 600).await else { panic!("h1 cannot be armed") };
    assert!(reason.contains("h1"), "{reason}");
    assert_eq!(world.count_everywhere("Arm"), 0);

    let (_world, empty) = machine(&[]);
    empty.set_candidates(vec![]);
    assert_eq!(sibling_arm(&empty, 600).await, SiblingArm::NothingToArm);
}

#[tokio::test(start_paused = true)]
async fn sibling_arm_failure_rolls_back_the_hosts_it_armed() {
    let (world, port) = adopted(&[("h1", HostSpec { no_arm_ack: true, ..HostSpec::default() })]).await;
    let before = marks(&world, &[CURRENT, "h1"]);

    let SiblingArm::Failed(reason) = sibling_arm(&port, 600).await else { panic!("h1 never acknowledges") };

    assert!(reason.contains("h1"), "{reason}");
    assert_eq!(since(&world, CURRENT, before[0]), ["Arm", "Disarm"]);
}

// ---- the owned set and incompatible hosts -------------------------------------

#[tokio::test(start_paused = true)]
async fn an_incompatible_host_on_the_current_endpoint_is_neither_owned_nor_touched() {
    // With the generation gate off the current endpoint is shared across versions:
    // the host there may speak no protocol we do.
    let world = World::new();
    world.add_host(CURRENT, HostSpec::default());
    let port = FakePort::new(&world, CURRENT);
    let mut alien = current();
    alien.record = Some(record(CURRENT, 99, 99));
    port.set_candidates(vec![alien]);

    assert!(owned_hosts(&port).await.is_empty(), "a host with no shared protocol is never owned");
    let report = exit_hosts(&port).await;
    tokio::time::sleep(SEC).await;

    assert_eq!(port.connect_count(CURRENT), 0, "exit did not even connect to it");
    assert!(world.kinds(CURRENT).is_empty(), "and sent it no frame: {:?}", world.kinds(CURRENT));
    assert!(report.hosts.is_empty(), "{:?}", report.hosts);
}

// ---- exit and a hold that is arming --------------------------------------------

#[tokio::test(start_paused = true)]
async fn exit_waits_for_an_arm_in_flight_and_ends_every_host_disarmed_then_shut_down() {
    let slow_to_ack = HostSpec { arm_delay: secs(2), ..HostSpec::default() };
    let (world, port) = adopted(&[("h1", slow_to_ack)]).await;
    let hosts = [CURRENT, "h1"];
    let before = marks(&world, &hosts);
    let mut hold = begin_offload(&port).await.unwrap();
    let arming = tokio::spawn(async move {
        let armed = hold.arm_detach(600, "tok", Some(ArmDetachPurpose::Local)).await;
        (armed, hold)
    });
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(world.count("h1", "Arm"), 1, "the arm is out and h1's acknowledgement is still 2 s away");

    // The user quits meanwhile: exit takes the table over from the offload.
    let report = exit_hosts(&port).await;
    tokio::time::sleep(SEC).await;

    let (armed, _hold) = arming.await.unwrap();
    let refusal = armed.expect_err("an arm that exit overtook did not happen");
    assert!(refusal.starts_with(LIFECYCLE_BUSY), "{refusal}");
    for (host, from) in hosts.iter().zip(before) {
        assert_eq!(
            since(&world, host, from),
            ["Arm", "Disarm", "Disarm", "Shutdown", "Eof"],
            "{host}: the arm is undone, then exit's disarm and shutdown come last, so the host is not left armed"
        );
    }
    assert!(report.drained, "exit waited for the arm instead of going ahead of it");
    assert!(report.problems().next().is_none(), "{:?}", report.hosts);
}

#[tokio::test(start_paused = true)]
async fn an_arm_that_starts_after_exit_began_is_refused_and_sends_nothing() {
    let (world, port) = adopted(&[("h1", HostSpec::default())]).await;
    let hosts = [CURRENT, "h1"];
    let before = marks(&world, &hosts);
    let mut hold = begin_offload(&port).await.unwrap();

    exit_hosts(&port).await;
    tokio::time::sleep(SEC).await;
    let refusal = hold
        .arm_detach(600, "tok", Some(ArmDetachPurpose::Local))
        .await
        .expect_err("the offload lost the table to exit");

    assert!(refusal.starts_with(LIFECYCLE_BUSY), "{refusal}");
    assert_eq!(world.count_everywhere("Arm"), 0, "no host was asked to arm after it was released");
    for (host, from) in hosts.iter().zip(before) {
        assert_eq!(since(&world, host, from), ["Disarm", "Shutdown", "Eof"], "{host}");
    }
}

#[tokio::test(start_paused = true)]
async fn a_relaunch_whose_current_host_answers_after_exit_took_over_arms_no_older_host() {
    // The current host acknowledges after exit's quiesce bound: exit goes ahead and
    // closes every host, and the relaunch then finds the table taken from it.
    let slow_current = HostSpec { arm_delay: EXIT_QUIESCE_BOUND + secs(2), ..HostSpec::default() };
    let (world, port) = machine_with_current(slow_current, &[("old", HostSpec::default())]);
    rediscover_hosts(&port).await.unwrap();
    announce_capability(&port);
    let hosts = [CURRENT, "old"];
    let mut hold = begin_relaunch(&port).await.expect("the current host is connected");
    let arming = tokio::spawn(async move {
        let armed = hold.arm_detach(600, "tok", Some(ArmDetachPurpose::Local)).await;
        (armed, hold)
    });
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(world.count(CURRENT, "Arm"), 1, "the arm is out and the current host's acknowledgement is still pending");
    let before = marks(&world, &hosts);

    exit_hosts(&port).await;
    tokio::time::sleep(secs(10)).await;

    let (armed, _hold) = arming.await.unwrap();
    let refusal = armed.expect_err("a relaunch that exit overtook did not happen");
    assert!(refusal.starts_with(LIFECYCLE_BUSY), "{refusal}");
    assert_eq!(world.count("old", "Arm"), 0, "the older host was never asked to arm after exit took over");
    assert_eq!(
        since(&world, "old", before[1]),
        ["Disarm", "Shutdown", "Eof"],
        "the older host only saw exit's disarm and shutdown, so it is not left armed"
    );
    assert_eq!(
        since(&world, CURRENT, before[0]).iter().filter(|kind| **kind == "Arm").count(),
        0,
        "the current host's late acknowledgement is not followed by another arm"
    );
    assert_eq!(since(&world, CURRENT, before[0]).last(), Some(&"Eof"), "the current host ends shut down, not armed");
}

// ---- a hold that is dropped ------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn a_hold_dropped_while_an_arm_is_still_pending_disarms_the_host_before_admission_reopens() {
    let slow_to_ack = HostSpec { arm_delay: secs(2), ..HostSpec::default() };
    let (world, port) = adopted(&[("h1", slow_to_ack)]).await;
    let hosts = [CURRENT, "h1"];
    let before = marks(&world, &hosts);
    let mut hold = begin_offload(&port).await.unwrap();
    let arming = tokio::spawn(async move { hold.arm_detach(600, "tok", Some(ArmDetachPurpose::Local)).await });
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(world.count("h1", "Arm"), 1, "the arm is out and h1's acknowledgement is still 2 s away");

    // The caller gives up: the arm future and the hold with it are dropped mid-arm.
    arming.abort();
    assert!(arming.await.unwrap_err().is_cancelled());
    assert!(
        matches!(port.table().begin(HostChannel::Primary), Err(Busy::Lifecycle(_))),
        "admission is not reopened over hosts that were asked to arm"
    );
    tokio::time::sleep(secs(5)).await;

    // (h1 answers the disarm only after its slow arm, so the client's one retry of
    // an unanswered disarm may reach it twice.)
    for (host, from) in hosts.iter().zip(before) {
        let frames = since(&world, host, from);
        assert_eq!(frames[0], "Arm", "{host}: {frames:?}");
        assert!(frames.len() > 1 && frames[1..].iter().all(|k| *k == "Disarm"), "{host}: the arm that may have landed is undone: {frames:?}");
    }
    assert!(port.table().begin(HostChannel::Primary).is_ok(), "and admission reopens once they are released");
}

#[tokio::test(start_paused = true)]
async fn a_hold_dropped_while_armed_disarms_its_hosts_before_admission_reopens() {
    let (world, port) = adopted(&[("h1", HostSpec::default())]).await;
    let before = marks(&world, &[CURRENT, "h1"]);
    let mut hold = begin_offload(&port).await.unwrap();
    hold.arm_detach(600, "tok", Some(ArmDetachPurpose::Local)).await.unwrap();

    // A path that neither released nor committed it.
    drop(hold);
    assert!(
        matches!(port.table().begin(HostChannel::Primary), Err(Busy::Lifecycle(_))),
        "admission is not reopened while the hosts are still armed"
    );
    tokio::time::sleep(SEC).await;

    assert_eq!(since(&world, CURRENT, before[0]), ["Arm", "Disarm"]);
    assert_eq!(since(&world, "h1", before[1]), ["Arm", "Disarm"]);
    assert!(port.table().begin(HostChannel::Primary).is_ok(), "and it is reopened once they are released");
}

// ---- restarting this process ------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn a_relaunch_arms_the_hosts_it_reaches_and_is_not_stopped_by_the_ones_it_cannot() {
    let (world, port) = adopted(&[
        ("up", HostSpec::default()),
        ("down", HostSpec::default()),
        ("mute", HostSpec { list: ListBehavior::Never, ..HostSpec::default() }),
        ("deaf", HostSpec { no_arm_ack: true, ..HostSpec::default() }),
    ])
    .await;
    world.kill_connections("down");
    tokio::time::sleep(SEC).await;
    let hosts = [CURRENT, "up", "down", "mute", "deaf"];
    let before = marks(&world, &hosts);
    let refused = begin_offload(&port).await.err().expect("an offload refuses with a host disconnected");
    assert!(refused.contains("down"), "{refused}");

    let mut hold = begin_relaunch(&port).await.expect("a restart is not an offload");
    hold.arm_detach(600, "tok", Some(ArmDetachPurpose::Local))
        .await
        .expect("a host that will not arm does not stop the restart");

    for host in [CURRENT, "up", "mute"] {
        assert_eq!(arm_frames(&world, host), [(600, Some(ArmDetachPurpose::Local))], "{host} is armed");
    }
    assert!(arm_frames(&world, "down").is_empty(), "nothing can be asked of a host with no connection");
    assert_eq!(since(&world, "deaf", before[4]), ["Arm", "Disarm"], "the host that did not acknowledge is released again");
    assert_eq!(since(&world, CURRENT, before[0]).last(), Some(&"Arm"), "and the others stay armed");
    assert_eq!(since(&world, "up", before[1]).last(), Some(&"Arm"));
    hold.commit();
    assert!(matches!(port.table().begin(HostChannel::Primary), Err(Busy::Lifecycle(_))));
}

#[tokio::test(start_paused = true)]
async fn a_relaunch_needs_the_current_host_and_is_not_stopped_by_an_operation_in_flight() {
    let (world, port) = adopted(&[("h1", HostSpec::default())]).await;

    // A create that never finishes: an offload refuses, a restart waits the same
    // bound and then goes ahead.
    let _stuck = port.table().begin(HostChannel::Frozen(port.frozen_ids()[0])).unwrap();
    let started = Instant::now();
    let hold = begin_relaunch(&port).await.expect("a stuck create does not stop the restart");
    assert!(started.elapsed() >= HOLD_QUIESCE_BOUND, "it still gave the operation its chance first");
    drop(hold);

    // Without the current host there is nothing it could keep alive.
    port.drop_current();
    let err = begin_relaunch(&port).await.err().expect("no current host");
    assert_eq!(err, "pty-host not connected — nothing to keep alive");
    assert!(port.table().begin(HostChannel::Frozen(port.frozen_ids()[0])).is_ok(), "and admission is reopened");
    assert_eq!(world.count_everywhere("Arm"), 0);
}

#[tokio::test(start_paused = true)]
async fn a_relaunch_whose_current_host_will_not_arm_fails_and_leaves_every_host_disarmed() {
    // Only the current host is deaf; the older ones would arm.
    let (world, port) = machine_with_current(
        HostSpec { no_arm_ack: true, ..HostSpec::default() },
        &[("h1", HostSpec::default()), ("h2", HostSpec::default())],
    );
    rediscover_hosts(&port).await.unwrap();
    announce_capability(&port);
    let hosts = [CURRENT, "h1", "h2"];
    let before = marks(&world, &hosts);

    let mut hold = begin_relaunch(&port).await.expect("the current host is connected");
    let err = hold
        .arm_detach(600, "tok", Some(ArmDetachPurpose::Local))
        .await
        .expect_err("a restart with the current host unarmed would lose its shells");

    assert!(err.contains(CURRENT), "the refusing host is named: {err}");
    assert_eq!(since(&world, CURRENT, before[0]), ["Arm", "Disarm"], "its arm may have landed, so it is released");
    for (host, from) in hosts.iter().zip(before) {
        let frames = since(&world, host, from);
        let (armed, disarmed) = (
            frames.iter().filter(|k| **k == "Arm").count(),
            frames.iter().filter(|k| **k == "Disarm").count(),
        );
        assert_eq!(armed, disarmed, "{host} ends disarmed: {frames:?}");
    }
    drop(hold);
    assert!(port.table().begin(HostChannel::Primary).is_ok(), "the failed restart reopens admission");
}

// ---- a sibling's arm holds admission ---------------------------------------------

#[tokio::test(start_paused = true)]
async fn sibling_arm_refuses_a_connected_host_that_has_not_listed() {
    let (world, port) = adopted(&[("mute", HostSpec { list: ListBehavior::Never, ..HostSpec::default() })]).await;

    let SiblingArm::Refused(reason) = sibling_arm(&port, 600).await else { panic!("what it holds is not known") };

    assert!(reason.contains("mute") && reason.contains("not reported"), "{reason}");
    assert_eq!(world.count_everywhere("Arm"), 0);
    assert!(port.table().begin(HostChannel::Primary).is_ok(), "a refused arm does not keep admission closed");
}

#[tokio::test(start_paused = true)]
async fn a_siblings_arm_gives_up_on_an_operation_in_flight_before_its_caller_does() {
    let (world, port) = adopted(&[("h1", HostSpec::default())]).await;
    // A create that never finishes.
    let _stuck = port.table().begin(HostChannel::Primary).unwrap();
    let started = Instant::now();

    let SiblingArm::Refused(reason) = sibling_arm(&port, 600).await else { panic!("the arm must be refused") };

    // The instance that asked stops waiting after SIBLING_CALL_TIMEOUT_SECS, so the
    // named reason has to be there before that, not after a hold-length wait.
    let call_timeout = secs(crate::sibling_coord::SIBLING_CALL_TIMEOUT_SECS);
    assert!(started.elapsed() < call_timeout, "answered after {:?}, past its caller's {call_timeout:?}", started.elapsed());
    assert!(started.elapsed() >= SIBLING_QUIESCE_BOUND, "the operation was still given its bound first");
    assert!(reason.starts_with(LIFECYCLE_BUSY) && reason.contains("in progress"), "{reason}");
    assert_eq!(world.count_everywhere("Arm"), 0, "nothing was armed");
    assert!(port.table().begin(HostChannel::Primary).is_ok(), "and the refusal left admission open");
}

#[tokio::test(start_paused = true)]
async fn a_siblings_arm_is_not_undone_by_a_reconnect_and_its_disarm_reopens_admission() {
    let (world, port) = adopted(&[("h1", holding(&[("k1", 11)]))]).await;
    let hosts = [CURRENT, "h1"];
    let before = marks(&world, &hosts);
    assert_eq!(sibling_arm(&port, 600).await, SiblingArm::Armed(2));

    // h1's connection drops and the sweep goes to reconnect it: a reconnect lists the
    // host, which disarms it first.
    world.kill_connections("h1");
    tokio::time::sleep(SEC).await;
    assert!(!sweep(&port).await, "the host could not be reconnected while admission is held");
    assert_eq!(port.connect_count("h1"), 1, "no connection was made to it");
    for (host, from) in hosts.iter().zip(&before) {
        assert!(!since(&world, host, *from).contains(&"Disarm"), "{host} was disarmed: {:?}", since(&world, host, *from));
    }
    assert!(matches!(port.table().begin(HostChannel::Primary), Err(Busy::Lifecycle(_))));
    let refused = place(&port, "tm-new", false).await.err().expect("no create while a sibling's arm is in force");
    assert!(refused.starts_with(LIFECYCLE_BUSY), "{refused}");

    // The sibling's update fails and it releases us. h1 is down, so it cannot hear it.
    assert!(!sibling_disarm(&port).await, "h1 has no connection to acknowledge on");
    assert_eq!(since(&world, CURRENT, before[0]).last(), Some(&"Disarm"), "the host that can hear it is released");
    assert!(port.table().begin(HostChannel::Primary).is_ok(), "and admission is open again");
    tokio::time::sleep(secs(2)).await;
    assert_eq!(port.connect_count("h1"), 2, "the reconnect went ahead once the hold ended");
}

#[tokio::test(start_paused = true)]
async fn a_siblings_arm_ends_with_its_window_and_a_repeated_arm_is_one_hold() {
    let (world, port) = adopted(&[("h1", HostSpec::default())]).await;
    let hosts = [CURRENT, "h1"];
    let before = marks(&world, &hosts);

    // The same request twice (the caller retries) arms twice and holds once.
    assert_eq!(sibling_arm(&port, 600).await, SiblingArm::Armed(2));
    assert_eq!(sibling_arm(&port, 600).await, SiblingArm::Armed(2));
    for (host, from) in hosts.iter().zip(&before) {
        assert_eq!(since(&world, host, *from), ["Arm", "Arm"], "{host}");
    }
    assert!(sibling_disarm(&port).await);
    for (host, from) in hosts.iter().zip(&before) {
        assert_eq!(since(&world, host, *from), ["Arm", "Arm", "Disarm"], "{host}");
    }
    assert!(port.table().begin(HostChannel::Primary).is_ok());

    // A sibling that never disarms (it crashed) does not keep this instance closed
    // for good: the hold ends with the window it armed.
    let before = marks(&world, &hosts);
    assert_eq!(sibling_arm(&port, 30).await, SiblingArm::Armed(2));
    assert!(matches!(port.table().begin(HostChannel::Primary), Err(Busy::Lifecycle(_))));
    tokio::time::sleep(secs(31)).await;
    assert!(port.table().begin(HostChannel::Primary).is_ok(), "admission reopened when the window ended");
    for (host, from) in hosts.iter().zip(&before) {
        assert_eq!(since(&world, host, *from), ["Arm", "Disarm"], "{host}");
    }

    // The expiry of an arm that was disarmed or replaced does nothing to the next one.
    assert_eq!(sibling_arm(&port, 30).await, SiblingArm::Armed(2));
    tokio::time::sleep(secs(20)).await;
    assert_eq!(sibling_arm(&port, 600).await, SiblingArm::Armed(2));
    tokio::time::sleep(secs(20)).await;
    assert!(matches!(port.table().begin(HostChannel::Primary), Err(Busy::Lifecycle(_))), "the older window's end did not release it");
}
