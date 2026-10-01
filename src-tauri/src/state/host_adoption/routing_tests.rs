//! The router over fake hosts: every assertion names the host that received a
//! frame, because "a Spawn happened" is true of the wrong implementation too.

use super::fake_hosts::*;
use super::*;
use crate::state::host_registry::{self, OrphanVerdict};
use crate::state::host_routing::{place, spawn_target, Placement, HOST_OWNERSHIP_PENDING};
use crate::state::host_table::QuiesceReason;
use crate::state::host_keys::KeyKind;
use std::time::{Instant as StdInstant, SystemTime};
use termflow_pty_protocol::SpawnSpec;

const CURRENT: &str = "cur";
const SEC: Duration = Duration::from_secs(1);

fn secs(n: u64) -> Duration {
    Duration::from_secs(n)
}

fn spawn_spec() -> SpawnSpec {
    SpawnSpec { shell: "sh".into(), args: vec![], env: vec![], env_remove: vec![], cwd: None, cols: 80, rows: 24 }
}

fn frozen(name: &str) -> HostCandidate {
    candidate(name, HostRole::Frozen)
}

/// An older host whose record was written `age_rank` seconds after the epoch:
/// a larger rank is a more recently advertised host.
fn frozen_at(name: &str, age_rank: u64) -> HostCandidate {
    HostCandidate { mtime: SystemTime::UNIX_EPOCH + secs(age_rank), ..frozen(name) }
}

fn machine(old: &[(&str, HostSpec)]) -> (Arc<World>, FakePort) {
    let world = World::new();
    world.add_host(CURRENT, HostSpec::default());
    let mut candidates = Vec::new();
    for (name, spec) in old {
        world.add_host(name, spec.clone());
        candidates.push(frozen(name));
    }
    candidates.push(candidate(CURRENT, HostRole::Current));
    let port = FakePort::new(&world, CURRENT);
    port.set_candidates(candidates);
    (world, port)
}

fn never(sessions: &[(&str, u32)]) -> HostSpec {
    HostSpec { list: ListBehavior::Never, ..holding(sessions) }
}

fn holding(keys: &[(&str, u32)]) -> HostSpec {
    HostSpec { sessions: keys.iter().map(|(k, pid)| meta(k, *pid)).collect(), ..HostSpec::default() }
}

fn restore(port: &FakePort, leaf: &str, session_key: Option<&str>) {
    assert!(host_registry::register_restoring_leaf(&port.intent_maps(), "main", leaf, session_key, StdInstant::now()));
}

async fn refusal(port: &FakePort, key: &str, overridden: bool) -> String {
    match place(port, key, overridden).await {
        Err(e) => e,
        Ok(Placement::InProcess { reason }) => panic!("fell back in-process instead of refusing: {reason}"),
        Ok(_) => panic!("expected the create to be refused"),
    }
}

#[derive(Debug, PartialEq)]
enum Did {
    Attached(HostChannel, u32),
    Spawned(HostChannel),
    InProcess,
}

/// Do what `spawn_routed` does with a placement: send the frame to the host the
/// placement names.
async fn execute(_requested_key: &str, placement: Placement) -> Did {
    match placement {
        Placement::Attach { channel, client, pid, ticket, session_key } => {
            client.attach_confirmed(&session_key, 0).await;
            drop(ticket);
            Did::Attached(channel, pid)
        }
        Placement::Spawn { channel, client, ticket, session_key } => {
            client.spawn_session(&session_key, &spawn_spec()).await.unwrap();
            drop(ticket);
            Did::Spawned(channel)
        }
        Placement::InProcess { .. } => Did::InProcess,
    }
}

async fn create(port: &FakePort, key: &str, overridden: bool) -> Did {
    match place(port, key, overridden).await {
        Ok(placement) => execute(key, placement).await,
        Err(e) => panic!("create refused: {e}"),
    }
}

fn assert_spawn_key(world: &World, host: &str, leaf: &str) {
    let keys = world.sessions(host, "Spawn");
    assert_eq!(keys.len(), 1, "exactly one Spawn on {host}");
    assert_eq!(crate::state::parse_session_key(&keys[0]), crate::state::SessionKeyKind::V2 { owner_leaf: leaf });
}

fn is_pending(err: &str) -> bool {
    err.starts_with(&format!("{HOST_OWNERSHIP_PENDING}: "))
}

// ---- restoring panes wait ---------------------------------------------------

#[tokio::test(start_paused = true)]
async fn modern_restore_without_override_key_is_not_spawned_while_unresolved() {
    // The pane carries no sessionKey of its own: only the backend's restore
    // intent, keyed by its leaf, says it is not a fresh tab.
    let (world, port) = machine(&[("h1", never(&[("tm-modern", 5)]))]);
    restore(&port, "tm-modern", None);

    let err = refusal(&port, "tm-modern", false).await;
    assert!(is_pending(&err), "{err}");
    assert!(err.contains("h1"), "the error names the host it waits for: {err}");
    assert_eq!(world.count_everywhere("Spawn"), 0, "no Spawn frame to any host");
    assert_eq!(world.count_everywhere("Attach"), 0);

    // Split, remount or move: the same leaf asks again, and is held just the same.
    let again = refusal(&port, "tm-modern", false).await;
    assert!(is_pending(&again), "{again}");
    assert_eq!(world.count_everywhere("Spawn"), 0);
}

#[tokio::test(start_paused = true)]
async fn migrated_restore_same() {
    // A migrated pane protects its old exact key as well as its own leaf's
    // aliases; either spelling must keep its create waiting for the host.
    let (world, port) = machine(&[("h1", never(&[("tb-old", 7)]))]);
    restore(&port, "tm-new", Some("tb-old"));
    assert!(port.table().keys().is_restoring_key("tb-old", StdInstant::now()));
    assert!(port.table().keys().is_restoring_key("tm-new", StdInstant::now()), "the holder also protects its own leaf");

    let err = refusal(&port, "tb-old", true).await;
    assert!(is_pending(&err), "{err}");
    assert_eq!(world.count_everywhere("Spawn"), 0);

    // The host recovers; the pane attaches to the session under its old key.
    let (world, port) = machine(&[("h1", HostSpec { list: ListBehavior::SilentFor(secs(4)), ..holding(&[("tb-old", 7)]) })]);
    restore(&port, "tm-new", Some("tb-old"));
    let h1 = HostChannel::Frozen(FrozenId(1));
    assert_eq!(create(&port, "tb-old", true).await, Did::Attached(h1, 7));
    assert_eq!(world.sessions("h1", "Attach"), vec!["tb-old".to_string()]);
    assert_eq!(world.count_everywhere("Spawn"), 0);
}

#[tokio::test(start_paused = true)]
async fn unclaimed_keyed_create_unresolved_returns_pending_error() {
    // A migrated pane with no restore intent recorded at all: the key it
    // supplied is enough to make it keyed.
    let (world, port) = machine(&[("h1", never(&[]))]);
    let err = refusal(&port, "tb-legacy", true).await;
    assert!(err.starts_with("host-ownership-pending: "), "{err}");
    assert!(err.contains("h1"), "says which host it waits for: {err}");
    assert_eq!(world.count_everywhere("Spawn"), 0);
    assert_eq!(world.count_everywhere("Attach"), 0);
}

#[tokio::test(start_paused = true)]
async fn a_waiting_pane_attaches_when_its_host_resolves() {
    // The host answers only after 14 s; the pane's retries keep being refused,
    // never spawned, then attach on the host that holds the session.
    let slow = HostSpec { list: ListBehavior::SilentFor(secs(14)), ..holding(&[("tm-wait", 41)]) };
    let (world, port) = machine(&[("h1", slow)]);
    restore(&port, "tm-wait", None);

    let mut refusals = 0;
    let did = loop {
        match place(&port, "tm-wait", false).await {
            Err(e) if is_pending(&e) => {
                refusals += 1;
                assert!(refusals < 6, "the host never resolved");
                assert_eq!(world.count_everywhere("Spawn"), 0);
            }
            Err(e) => panic!("{e}"),
            Ok(placement) => break execute("tm-wait", placement).await,
        }
    };
    assert!(refusals >= 1, "it had to wait");
    assert_eq!(did, Did::Attached(HostChannel::Frozen(FrozenId(1)), 41));
    assert_eq!(world.count_everywhere("Spawn"), 0);
    assert_eq!(world.count(CURRENT, "Attach"), 0, "the attach went to the holder, not the current host");
    assert!(!port.table().keys().is_restoring_key("tm-wait", StdInstant::now()), "bound: nothing waits for the key any more");
}

#[tokio::test(start_paused = true)]
async fn a_keyed_create_claimed_by_a_frozen_host_attaches_there_and_spawns_nowhere() {
    let (world, port) = machine(&[("h1", holding(&[("k1", 91)])), ("h2", holding(&[("k2", 92)]))]);
    restore(&port, "k1", None);

    let did = create(&port, "k1", false).await;
    let holder = port.frozen_hosts().into_iter().find(|h| h.endpoint == "h1").unwrap().id;
    assert_eq!(did, Did::Attached(HostChannel::Frozen(holder), 91));
    assert_eq!(world.sessions("h1", "Attach"), vec!["k1".to_string()], "the Attach reached the holder");
    assert_eq!(world.count("h2", "Attach"), 0);
    assert_eq!(world.count(CURRENT, "Attach"), 0);
    assert_eq!(world.count_everywhere("Spawn"), 0, "zero Spawn frames");
    assert!(!port.table().keys().is_restoring_key("k1", StdInstant::now()));
}

#[tokio::test(start_paused = true)]
async fn an_unclaimed_restore_spawns_once_every_host_answered_and_the_intent_is_dropped() {
    let (world, port) = machine(&[("h1", holding(&[("other", 3)]))]);
    restore(&port, "tm-brand-new", None);

    assert_eq!(create(&port, "tm-brand-new", false).await, Did::Spawned(HostChannel::Primary));
    assert_spawn_key(&world, CURRENT, "tm-brand-new");
    assert_eq!(world.count("h1", "Spawn"), 0);
    assert!(!port.table().keys().is_restoring_key("tm-brand-new", StdInstant::now()), "a later create is not held by a spent intent");
}

#[tokio::test(start_paused = true)]
async fn restoring_key_ttl_refreshed_on_each_keyed_create() {
    let (_world, port) = machine(&[("h1", never(&[]))]);
    let before = StdInstant::now() - secs(1);
    assert!(host_registry::register_restoring_leaf(&port.intent_maps(), "main", "tm-idle", None, before));
    let stamp = |port: &FakePort| port.table().keys().holder_stamp("main", "tm-idle").unwrap();

    let registered = stamp(&port);
    assert!(is_pending(&refusal(&port, "tm-idle", false).await));
    let first = stamp(&port);
    assert!(first > registered, "the first keyed create refreshed the intent");

    assert!(host_registry::register_restoring_leaf(&port.intent_maps(), "main", "tm-idle", None, before));
    assert!(is_pending(&refusal(&port, "tm-idle", false).await));
    assert!(stamp(&port) >= first, "and so did the second");

    // A fresh leaf neither creates an intent nor is held.
    assert_eq!(create(&port, "tm-fresh", false).await, Did::Spawned(HostChannel::Primary));
    assert!(!port.table().keys().is_restoring_key("tm-fresh", StdInstant::now()));
}

#[tokio::test(start_paused = true)]
async fn restoring_key_not_registered_for_an_already_live_session() {
    let (_world, port) = machine(&[]);
    port.register_terminal("pc-1", "tm-live", HostChannel::Primary);
    let maps = port.intent_maps();
    let now = StdInstant::now();

    assert!(!host_registry::register_restoring_leaf(&maps, "main", "tm-live", None, now));
    assert!(!host_registry::register_restoring_leaf(&maps, "main", "tm-moved", Some("tm-live"), now), "by its override key too");
    assert_eq!(port.table().keys().holder_count(), 0, "nothing would ever remove an entry for a live key");
    assert!(host_registry::register_restoring_leaf(&maps, "main", "tm-waiting", None, now));
    assert!(port.table().keys().is_restoring_key("tm-waiting", now));
}

// ---- fresh creates never wait ------------------------------------------------

#[tokio::test(start_paused = true)]
async fn fresh_tab_during_unresolved_adoption_spawns_on_current_promptly() {
    let (world, port) = machine(&[("h1", never(&[("k1", 11)]))]);
    let did = tokio::time::timeout(SEC, create(&port, "tm-fresh", false))
        .await
        .expect("a fresh tab must not wait for the unresolved host");
    assert_eq!(did, Did::Spawned(HostChannel::Primary));
    assert_spawn_key(&world, CURRENT, "tm-fresh");
    assert!(
        world.kinds("h1").iter().all(|k| matches!(*k, "Disarm" | "List")),
        "the old host saw only its lifecycle frame and listings: {:?}",
        world.kinds("h1")
    );
    assert_eq!(port.table().keys().holder_count(), 0);
}

#[tokio::test(start_paused = true)]
async fn a_new_tab_spawns_on_the_current_host_only_and_leaves_the_old_hosts_sessions_alone() {
    let (world, port) = machine(&[("h1", holding(&[("k1", 11), ("k2", 12)]))]);
    assert_eq!(create(&port, "tm-new", false).await, Did::Spawned(HostChannel::Primary));
    tokio::time::sleep(SEC).await;

    assert_spawn_key(&world, CURRENT, "tm-new");
    assert_eq!(world.count("h1", "Spawn"), 0);
    assert_eq!(world.count("h1", "Attach"), 0);
    assert_eq!(world.count("h1", "Close"), 0);
    let h1 = HostChannel::Frozen(FrozenId(1));
    for key in ["k1", "k2"] {
        let claim = port.table().keys().snapshot(key).unwrap();
        assert_eq!((claim.state, claim.channel), (KeyKind::Listed, h1));
    }
}

// ---- lifecycle refusal -------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn lifecycle_busy_create_does_not_fall_back_in_process() {
    let (world, port) = machine(&[("h1", holding(&[("k1", 11)]))]);
    ensure_hosts(&port).await.unwrap();

    // Hosts are up, admission is closed for an offload.
    let guard = port.0.table.quiesce(QuiesceReason::Offload, secs(1)).await.unwrap();
    for (key, overridden) in [("tm-fresh", false), ("k1", false), ("tb-x", true)] {
        let err = refusal(&port, key, overridden).await;
        assert!(err.starts_with(LIFECYCLE_BUSY), "{key}: {err}");
    }
    drop(guard);

    // Exit: the current connection is gone, and adoption is refused too.
    port.drop_current();
    let exit = port.0.table.quiesce(QuiesceReason::Exit, secs(1)).await.unwrap();
    let err = refusal(&port, "tm-fresh", false).await;
    assert!(err.starts_with(LIFECYCLE_BUSY), "{err}");
    drop(exit);

    assert_eq!(world.count_everywhere("Spawn"), 0);
    assert_eq!(world.count_everywhere("Attach"), 0);
}

// ---- spawn_target -----------------------------------------------------------

fn target_channel(port: &FakePort) -> Option<HostChannel> {
    spawn_target(port).map(|(channel, _)| channel)
}

#[tokio::test(start_paused = true)]
async fn spawn_target_prefers_current() {
    let world = World::new();
    world.add_host(CURRENT, HostSpec::default());
    world.add_host("h1", HostSpec::default());
    let port = FakePort::new(&world, CURRENT);
    port.set_candidates(vec![frozen_at("h1", 500), candidate(CURRENT, HostRole::Current)]);
    ensure_hosts(&port).await.unwrap();
    rediscover_hosts(&port).await.unwrap();
    assert_eq!(port.frozen_ids().len(), 1, "an older host is available and newer than anything");

    let (channel, client) = spawn_target(&port).unwrap();
    assert_eq!(channel, HostChannel::Primary);
    let session_key = "tm-x";
    client.spawn_session(session_key, &spawn_spec()).await.unwrap();
    assert_eq!(world.sessions(CURRENT, "Spawn"), vec!["tm-x".to_string()]);
    assert_eq!(world.count("h1", "Spawn"), 0);
}

#[tokio::test(start_paused = true)]
async fn spawn_target_never_picks_retired() {
    let world = World::new();
    world.spawn_fails.store(true, std::sync::atomic::Ordering::SeqCst);
    world.add_host("old", HostSpec::default());
    world.add_host("newer", HostSpec::default());
    let port = FakePort::new(&world, CURRENT);
    port.set_candidates(vec![frozen_at("old", 100), frozen_at("newer", 200)]);
    ensure_hosts(&port).await.unwrap();
    let ids = port.frozen_ids();
    let by_endpoint = |name: &str| {
        let host = port.frozen_hosts().into_iter().find(|h| h.endpoint == name).unwrap();
        HostChannel::Frozen(host.id)
    };
    let (old, newer) = (by_endpoint("old"), by_endpoint("newer"));
    assert_eq!(ids.len(), 2);
    assert_eq!(target_channel(&port), Some(newer), "the most recently advertised");

    // Retired: gone for good.
    port.0.table.drain_host(newer).unwrap().retire();
    assert_eq!(target_channel(&port), Some(old));

    // Draining is not admitting either, but it can come back.
    let draining = port.0.table.drain_host(old).unwrap();
    assert_eq!(target_channel(&port), None, "no host admits: the shell runs in-process");
    drop(draining);
    assert_eq!(target_channel(&port), Some(old));
}

#[tokio::test(start_paused = true)]
async fn most_recently_advertised_reversed_discovery_order() {
    // Whatever order discovery lists the hosts in, and whichever connects first,
    // the newer record wins.
    for (old_delay, new_delay) in [(SEC, Duration::ZERO), (Duration::ZERO, SEC)] {
        for reversed in [false, true] {
            let world = World::new();
            world.spawn_fails.store(true, std::sync::atomic::Ordering::SeqCst);
            world.add_host("old", HostSpec { connect_delay: old_delay, ..HostSpec::default() });
            world.add_host("new", HostSpec { connect_delay: new_delay, ..HostSpec::default() });
            let port = FakePort::new(&world, CURRENT);
            let mut candidates = vec![frozen_at("old", 100), frozen_at("new", 200)];
            if reversed {
                candidates.reverse();
            }
            port.set_candidates(candidates);
            ensure_hosts(&port).await.unwrap();

            let newest = port.frozen_hosts().into_iter().find(|h| h.endpoint == "new").unwrap();
            assert_eq!(
                target_channel(&port),
                Some(HostChannel::Frozen(newest.id)),
                "delays ({old_delay:?}, {new_delay:?}), reversed={reversed}"
            );
        }
    }
}

#[tokio::test(start_paused = true)]
async fn falls_back_frozen_then_in_process() {
    // The current host cannot start: a fresh tab lands on the older host.
    let world = World::new();
    world.spawn_fails.store(true, std::sync::atomic::Ordering::SeqCst);
    world.add_host("h1", holding(&[("k1", 11)]));
    let port = FakePort::new(&world, CURRENT);
    port.set_candidates(vec![frozen("h1")]);

    let did = create(&port, "tm-fresh", false).await;
    assert_eq!(did, Did::Spawned(HostChannel::Frozen(FrozenId(1))));
    assert_spawn_key(&world, "h1", "tm-fresh");
    assert_eq!(world.count(CURRENT, "Spawn"), 0);

    // Nothing usable anywhere: in-process.
    let empty = World::new();
    empty.spawn_fails.store(true, std::sync::atomic::Ordering::SeqCst);
    let port = FakePort::new(&empty, CURRENT);
    assert_eq!(create(&port, "tm-fresh", false).await, Did::InProcess);
    assert_eq!(empty.count_everywhere("Spawn"), 0);
}

// ---- orphan surfacing --------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn orphan_sweep_does_not_surface_a_restoring_key() {
    // The primary holds two live sessions no pane has claimed yet. One belongs to
    // a restored pane that is still waiting; the other is a genuine stray.
    let world = World::new();
    world.add_host(CURRENT, holding(&[("tm-wait", 5), ("tm-stray", 6)]));
    let port = FakePort::new(&world, CURRENT);
    port.set_candidates(vec![candidate(CURRENT, HostRole::Current)]);
    ensure_hosts(&port).await.unwrap();
    restore(&port, "tm-wait", None);

    // What the sweep does: list, compare with what the primary owns, surface the rest.
    let sessions = port.current_client().unwrap().list_sessions().await.unwrap();
    let owned: Vec<String> = Vec::new();
    let plan = crate::state::plan_reattach(&owned, &sessions, &std::collections::HashMap::new());
    let verdicts: Vec<(String, OrphanVerdict)> = plan
        .orphans
        .iter()
        .map(|o| {
            let verdict = host_registry::orphan_verdict(
                port.table().keys(),
                &o.tab_id,
                StdInstant::now(),
            );
            (o.tab_id.clone(), verdict)
        })
        .collect();
    assert_eq!(
        verdicts,
        vec![
            ("tm-wait".to_string(), OrphanVerdict::Restoring),
            ("tm-stray".to_string(), OrphanVerdict::Surface)
        ]
    );

    // And the waiting pane still gets its own session: an Attach, no Spawn.
    assert_eq!(create(&port, "tm-wait", false).await, Did::Attached(HostChannel::Primary, 5));
    assert_eq!(world.sessions(CURRENT, "Attach"), vec!["tm-wait".to_string()]);
    assert_eq!(world.count_everywhere("Spawn"), 0);
}

#[test]
fn the_orphan_surfacing_site_consults_restore_intent_before_it_reserves_or_emits() {
    let panes = source_of("host_adoption/panes.rs");
    let body = fn_body(&panes, "pub(in crate::state) fn surface_orphans<");
    let verdict = body.find("host_registry::orphan_verdict(").expect("surfacing must consult the verdict");
    let eligible = body.find(".keys().eligible(").expect("surfacing requires a listed key");
    let emit = body.find("port.announce_recovered(").expect("surfacing announces the recovered session");
    assert!(eligible < emit && verdict < emit, "a listed key and a Surface verdict must precede emission");
    for needle in ["OrphanVerdict::Restoring =>", "OrphanVerdict::CloseUnowned =>"] {
        let arm = &body[body.find(needle).unwrap_or_else(|| panic!("no {needle} arm"))..];
        let arm = &arm[..arm.find("continue;").expect("the arm leaves the loop iteration")];
        assert!(!arm.contains("reserve_host_session") && !arm.contains("emit"), "{needle} must not surface");
    }

    // The three flows that surface orphans, the primary's pipe-drop recovery, an
    // older host's reconnect (both through `reattach_listed`) and the sweep, all go
    // through that one function, and the recovery-tab request is made in one place
    // in the state module: the port's `announce_recovered`, which only it calls.
    // Other files are not read here.
    assert_eq!(source_of("host_port.rs").matches("\"api:createTerminalTab\"").count(), 1);
    assert_eq!(source_of("terminals.rs").matches("\"api:createTerminalTab\"").count(), 0);
    assert!(fn_body(&panes, "pub(super) async fn reattach_listed<").contains("surface_orphans(port,"));
    assert!(fn_body(&source_of("host_adoption/sweep.rs"), "pub(in crate::state) async fn sweep<").contains("surface_orphans(port,"));
    let reconnect = source_of("host_adoption/reconnect.rs");
    // An older host's reconnect is `reconnect_frozen_pass`, run under `reconnect_frozen`'s claim.
    for flow in ["pub(in crate::state) async fn reconnect_primary<", "async fn reconnect_frozen_pass<"] {
        assert!(fn_body(&reconnect, flow).contains("reattach_listed("), "{flow} must reconcile through reattach_listed");
    }
    assert!(fn_body(&reconnect, "pub(in crate::state) async fn reconnect_frozen<").contains("reconnect_frozen_pass("));
    for file in ["host_adoption.rs", "host_adoption/panes.rs", "host_adoption/reconnect.rs", "host_adoption/sweep.rs"] {
        assert_eq!(source_of(file).matches(".announce_recovered(").count(), usize::from(file == "host_adoption/panes.rs"));
    }
}

// ---- closes of panes that never found their session -------------------------

#[tokio::test(start_paused = true)]
async fn closing_a_waiting_pane_closes_the_shell_when_its_host_resolves() {
    let slow = HostSpec { list: ListBehavior::SilentFor(secs(14)), ..holding(&[("tm-wait", 41)]) };
    let (world, port) = machine(&[("h1", slow)]);
    restore(&port, "tm-wait", None);
    assert!(is_pending(&refusal(&port, "tm-wait", false).await));

    // The user closes the pane while it waits.
    host_registry::forget_restoring_leaf(&port.intent_maps(), "main", "tm-wait", StdInstant::now());
    assert!(!port.table().keys().is_restoring_key("tm-wait", StdInstant::now()));
    assert!(port.table().keys().unowned_close_due(false, "tm-wait", StdInstant::now()));

    // Later the host answers. Its shell is closed, not adopted.
    for _ in 0..6 {
        rediscover_hosts(&port).await.unwrap();
        if port.barrier().unresolved().is_empty() {
            break;
        }
        tokio::time::sleep(secs(5)).await;
    }
    tokio::time::sleep(SEC).await;
    assert!(port.barrier().unresolved().is_empty(), "the host did resolve");
    assert_eq!(world.sessions("h1", "Close"), vec!["tm-wait".to_string()], "the Close reached the host that held it");
    assert!(!port.table().keys().eligible(HostChannel::Frozen(FrozenId(1)), "tm-wait"), "nothing ending is attachable");
    assert_eq!(world.count_everywhere("Spawn"), 0);
    assert_eq!(world.count(CURRENT, "Close"), 0);
}

#[tokio::test(start_paused = true)]
async fn closed_unowned_never_closes_a_registered_session() {
    // A saved layout reloaded after the close registered a NEW session under the
    // same key on that host. The host reports it: it is the user's, not a leftover.
    let (world, port) = machine(&[("h1", holding(&[("tm-reused", 61)]))]);
    let h1 = HostChannel::Frozen(FrozenId(1));
    port.register_terminal("pc-new", "tm-reused", h1);
    host_registry::forget_restoring_leaf(&port.intent_maps(), "main", "tm-reused", StdInstant::now());

    ensure_hosts(&port).await.unwrap();
    tokio::time::sleep(SEC).await;
    assert_eq!(port.frozen_ids(), vec![FrozenId(1)]);
    assert_eq!(world.count("h1", "Close"), 0, "a registered session is never closed on the strength of an old close");
    assert!(port.duplicates().is_empty(), "it is registered on the very host that reports it");
    assert_eq!(port.table().keys().state(h1, "tm-reused"), Some(crate::state::KeyState::Bound("pc-new".into())), "already owned");
}

#[tokio::test(start_paused = true)]
async fn duplicate_session_key_across_channels_is_reported() {
    // The current host already runs a pane for "tm-dup"; an older host then
    // reports a session under the same key.
    let (world, port) = machine(&[("h1", holding(&[("tm-dup", 71), ("tm-ok", 72)]))]);
    port.register_terminal("pc-1", "tm-dup", HostChannel::Primary);

    ensure_hosts(&port).await.unwrap();
    rediscover_hosts(&port).await.unwrap();
    tokio::time::sleep(SEC).await;

    assert_eq!(port.duplicates(), vec!["tm-dup".to_string()], "reported, and only that one");
    // Nothing is killed or taken over automatically.
    assert_eq!(world.count("h1", "Close"), 0);
    assert_eq!(world.count(CURRENT, "Close"), 0);
    assert_eq!(world.count_everywhere("Attach"), 0);
    assert_eq!(world.count_everywhere("Spawn"), 0);
    assert_eq!(port.table().keys().state(HostChannel::Primary, "tm-dup"), Some(crate::state::KeyState::Bound("pc-1".into())));
    assert!(port.table().keys().eligible(HostChannel::Frozen(FrozenId(1)), "tm-dup"), "the other host's key is listed, not automatically owned");
    assert!(port.table().keys().contains_key("tm-ok"), "other sessions are adopted as usual");
}

// ---- a host whose connection dropped -----------------------------------------

/// A session reserved on an older host is attached through that host's live
/// connection or not at all. While the host's reconnect is backing off its client
/// is dead: an attach on it "succeeds", and the reconnect that follows lists only
/// the panes it knew when it began, so the pane would look alive and never get its
/// output.
#[tokio::test(start_paused = true)]
async fn a_keyed_create_for_a_session_on_a_host_that_is_reconnecting_waits_and_then_attaches() {
    let (world, port) = machine(&[("h1", holding(&[("k1", 11)]))]);
    ensure_hosts(&port).await.unwrap();
    tokio::time::sleep(SEC).await;
    let id = port.frozen_ids()[0];
    let h1 = HostChannel::Frozen(id);
    let lost = port.0.table.epoch(h1).expect("published");
    world.kill_connections("h1");
    tokio::time::sleep(SEC).await;
    assert!(!port.frozen_hosts()[0].client.is_alive(), "the host's connection really dropped");
    world.set_unreachable("h1", true);
    let reconnect = tokio::spawn({
        let port = port.clone();
        async move { reconnect_frozen(&port, id, lost, &[5000, 20000, 20000]).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!reconnect.is_finished(), "the reconnect is backing off");

    // The create gives up waiting for the host (8 s) and must still not attach.
    let err = refusal(&port, "k1", false).await;
    assert!(is_pending(&err), "{err}");
    assert_eq!(world.count("h1", "Attach"), 0, "nothing was attached on the dead connection");
    assert_eq!(
        port.table().keys().snapshot("k1").map(|c| (c.state, c.channel)),
        Some((KeyKind::Listed, h1)),
        "and the session is still reserved for the pane that will retry"
    );

    // The host comes back; the same create now attaches through the new connection.
    world.set_unreachable("h1", false);
    assert_eq!(reconnect.await.unwrap(), super::reconnect::FrozenReconnect::Reconnected);
    assert_eq!(create(&port, "k1", false).await, Did::Attached(h1, 11));
    assert_eq!(world.sessions("h1", "Attach"), vec!["k1".to_string()], "attached once, on the host that holds it");
    assert_eq!(world.count(CURRENT, "Attach"), 0);
}

// ---- the router's caller ----------------------------------------------------

fn source_of(file: &str) -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("state").join(file);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read {} ({e})", path.display()))
        .replace("\r\n", "\n")
}

fn fn_body(src: &str, signature: &str) -> String {
    let start = src
        .find(signature)
        .unwrap_or_else(|| panic!("`{signature}` not found — this guard must fail loudly, not pass vacuously"));
    let rest = &src[start..];
    let open = rest.find('{').expect("no body");
    let mut depth = 0usize;
    for (i, c) in rest[open..].char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return rest[open..open + i + 1].to_string();
                }
            }
            _ => {}
        }
    }
    panic!("unbalanced braces after `{signature}`");
}

/// The router picks the host; `spawn_routed` must act on that choice and on no
/// other client. A second `pty_host_clone()` in it is a second, unticketed and
/// unrouted way to pick one.
#[test]
fn spawn_routed_has_no_other_pty_host_clone() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("commands").join("terminal.rs");
    let commands = std::fs::read_to_string(&path).unwrap().replace("\r\n", "\n");
    let wrapper = fn_body(&commands, "pub(crate) async fn spawn_routed(");
    assert!(wrapper.contains("state.admit_mount(&leaf).await?"));
    let body = fn_body(&commands, "async fn run_create(");

    for forbidden in ["pty_host_clone(", "ensure_pty_host("] {
        assert!(!body.contains(forbidden), "spawn_routed must not select a host itself (found `{forbidden}`)");
    }
    // A refusal is returned as it is; it is never turned into an in-process shell.
    assert!(
        body.contains("state.place_process_create(&id, session_key.as_deref(), cg).await?"),
        "the router's refusals (LIFECYCLE_BUSY, host-ownership-pending) must propagate with `?`"
    );
    // The client acted on is the one the placement carries.
    for call in ["attach_confirmed", "spawn_session"] {
        assert!(body.contains(&format!("client.{call}(")), "spawn_routed must act on the placement's client: {call}");
    }
    // It still falls back in-process when, and only when, the router says no host is usable.
    assert!(body.contains("Placement::InProcess { reason }"));
}

/// Only adoption and the router take admission tickets in the state module, and
/// the router takes exactly one per create.
#[test]
fn the_router_takes_one_ticket_per_create() {
    let routing = source_of("host_routing.rs");
    let production = crate::state::source_scan::without_test_modules(&routing);
    assert_eq!(production.matches(".begin(").count(), 1);
    assert!(fn_body(&production, "pub(super) async fn place_owned<").contains("begin_ticket(port, channel)"));
    assert_eq!(fn_body(&production, "pub(super) async fn place_owned<").matches("begin_ticket(").count(), 1);
    assert_eq!(fn_body(&production, "fn place_elevated_create(").matches("begin_ticket(").count(), 1);
    assert!(fn_body(&production, "fn begin_ticket<").contains("port.table().begin(channel)"));
}
