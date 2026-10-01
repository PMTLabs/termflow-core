//! Exit, offload, update commit and a sibling's update over fake hosts. Every
//! assertion names the host that received a frame: "a Shutdown was sent" is true
//! of an implementation that only ever talks to the current host.

use super::fake_hosts::*;
use super::*;
use crate::state::host_lifecycle::{
    begin_offload, begin_update, connected_retention, exit_hosts, owned_hosts, owned_hosts_now, sibling_arm,
    sibling_disarm, update_mode_of, update_refusal, LifecyclePort, SiblingArm, EXIT_QUIESCE_BOUND,
    HOLD_QUIESCE_BOUND,
};
use crate::state::host_routing::{place, Placement};
use crate::state::host_table::Busy;
use crate::state::update_survival::{FullReason, UpdateMode};
use crate::pty_host_client::HostRetention;
use termflow_pty_protocol::{ArmDetachPurpose, Control, Frame, CAP_ATTACH_ACK};

const CURRENT: &str = "cur";
const SEC: Duration = Duration::from_secs(1);

fn secs(n: u64) -> Duration {
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

    fn exe_origin(&self, endpoint: &str, _client: &PtyHostClient) -> Option<bool> {
        self.0.exe_origins.lock().unwrap().get(endpoint).copied().unwrap_or(Some(false))
    }
}

fn frozen(name: &str) -> HostCandidate {
    candidate(name, HostRole::Frozen)
}

fn current() -> HostCandidate {
    candidate(CURRENT, HostRole::Current)
}

fn holding(keys: &[(&str, u32)]) -> HostSpec {
    HostSpec { sessions: keys.iter().map(|(k, pid)| meta(k, *pid)).collect(), ..HostSpec::default() }
}

/// The current host and these older ones, all discovered.
fn machine(old: &[(&str, HostSpec)]) -> (Arc<World>, FakePort) {
    let world = World::new();
    world.add_host(CURRENT, HostSpec::default());
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
async fn adopted(old: &[(&str, HostSpec)]) -> (Arc<World>, FakePort) {
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
fn undiscovered_until_now(world: &Arc<World>, port: &FakePort, name: &str, spec: HostSpec) -> HostCandidate {
    world.add_host(name, spec);
    let c = frozen(name);
    let mut all = port.candidates();
    all.insert(0, c.clone());
    port.set_candidates(all);
    c
}

/// How many frames each host has received so far.
fn marks(world: &World, hosts: &[&str]) -> Vec<usize> {
    hosts.iter().map(|h| world.kinds(h).len()).collect()
}

/// What `host` received after its `from`th frame.
fn since(world: &World, host: &str, from: usize) -> Vec<&'static str> {
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
async fn exit_connect_is_not_refused_by_its_own_quiesce() {
    let (world, port) = adopted(&[]).await;
    undiscovered_until_now(&world, &port, "legacy", HostSpec::default());

    exit_hosts(&port).await;
    tokio::time::sleep(SEC).await;

    // Exit's quiesce is sticky, so an ordinary adoption is refused for good...
    assert!(matches!(port.table().begin_adoption(), Err(Busy::Lifecycle(_))));
    // ...yet the attempt on the host that was never adopted got through.
    assert_eq!(world.kinds("legacy"), ["Disarm", "Shutdown", "Eof"]);
    assert_eq!(port.connect_count("legacy"), 1);
}

#[tokio::test(start_paused = true)]
async fn exit_disarms_a_reachable_previously_unresolved_armed_host_without_shutdown_capability_and_it_exits() {
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
        "disarmed so it stops holding for 900 s, no shutdown frame it cannot hear, then closed so it exits"
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
    // Every fake host reports a runtime-dir origin unless told otherwise.
    let (world, port) = adopted(&[("h1", HostSpec::default()), ("h2", HostSpec::default())]).await;
    let hosts = owned_hosts_now(&port);
    assert_eq!(hosts.len(), 3);

    assert_eq!(update_mode_of(&hosts), (UpdateMode::Offload, vec![]));
    assert_eq!(update_refusal(&hosts), Ok(()));

    let mut hold = begin_update(&port).await.expect("an update commit goes ahead as it did before");
    assert_eq!(hold.update_mode(), (UpdateMode::Offload, vec![]));
    hold.arm_detach(600, "tok", Some(ArmDetachPurpose::Local)).await.unwrap();
    for host in [CURRENT, "h1", "h2"] {
        assert_eq!(arm_frames(&world, host).len(), 1, "{host} is armed");
    }
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
