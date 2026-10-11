//! MCP startup's two phases (plan 056 T5): the survivor round, the bounded claim wait, the rule, the
//! release, the forced port and every fallback, over fake hosts and a fake `McpBootIo` on the paused
//! clock. Each fixture uses distinct held and picked ports (`P = 42040`, `PICK = 42050`), so a
//! start on the wrong port cannot pass for the right one.

use super::fake_hosts::*;
use super::lifecycle_tests::{machine_with_current, secs, CURRENT};
use super::mcp_reclaim_tests::{connect, releases, settle_tasks};
use crate::state::mcp_reclaim::Claimed;
use super::*;
use crate::app_config::NetworkConfig;
use crate::network_commands::PortOwner;
use crate::state::mcp_reclaim::{
    prepare_reclaim, reclaim_rule, start_mcp, BootInputs, Decision, McpBootIo, CLAIM_WAIT, IDENTITY_WAIT,
};
use std::sync::atomic::{AtomicBool, Ordering};
use termflow_pty_protocol::McpHeld;

const P: u16 = 42040;
const PICK: u16 = 42050;
const API: u16 = 42030;
const HOLDER: &str = "h1";

fn millis(n: u64) -> Duration {
    Duration::from_millis(n)
}

fn cfg() -> NetworkConfig {
    NetworkConfig { api_port: API, mcp_port: P, ..NetworkConfig::defaults() }
}

fn holding_p() -> HostSpec {
    HostSpec { mcp_hold: true, mcp_held: Some(McpHeld { port: P, configured_port: P, bind_host: "127.0.0.1".into() }), ..HostSpec::default() }
}

/// A claim of the holder `h1`, reporting `P` held for the configuration `cfg()`.
fn claimed(client: PtyHostClient, host: &str, id: u64) -> Claimed {
    Claimed::new(
        held_with(P, P, "127.0.0.1"),
        client,
        HostChannel::Frozen(FrozenId(id)),
        id,
        host.to_owned(),
        HOST_TOKEN.to_owned(),
    )
}

fn inputs(port: &FakePort, cfg: NetworkConfig) -> BootInputs {
    BootInputs { own_id: "own-056".into(), cfg, reclaim: port.reclaim().clone() }
}

type RoundStarter = Box<dyn FnOnce() -> tokio::task::JoinHandle<()> + Send>;

/// A boot IO that records what it was asked, with the number of `ReleaseMcp` frames the holder had
/// received at that moment: the order of the release against everything else is thereby observable.
struct FakeIo {
    world: Arc<World>,
    events: Mutex<Vec<(String, usize)>>,
    /// When each event happened, on the paused clock.
    times: Mutex<Vec<(String, tokio::time::Instant)>>,
    round: Mutex<Option<RoundStarter>>,
    quiet: Arc<AtomicBool>,
    /// When set, quietness is the real barrier's, as in production.
    barrier: Option<Barrier>,
    spawn_ok: Box<dyn Fn(u16) -> bool + Send + Sync>,
    owner: Box<dyn Fn(u16) -> PortOwner + Send + Sync>,
    /// How long each identity probe takes before it answers.
    probe: Duration,
    /// When set, each identity probe answers only once this is notified.
    probe_gate: Option<Arc<tokio::sync::Notify>>,
    pick: Option<u16>,
}

impl FakeIo {
    fn new(world: &Arc<World>) -> Self {
        Self {
            world: world.clone(),
            events: Mutex::new(Vec::new()),
            times: Mutex::new(Vec::new()),
            round: Mutex::new(None),
            quiet: Arc::new(AtomicBool::new(true)),
            barrier: None,
            spawn_ok: Box::new(|_| true),
            owner: Box::new(|_| PortOwner::OwnedBySelf),
            probe: Duration::ZERO,
            probe_gate: None,
            pick: Some(PICK),
        }
    }

    fn with_round(self, starter: impl FnOnce() -> tokio::task::JoinHandle<()> + Send + 'static) -> Self {
        *self.round.lock().unwrap() = Some(Box::new(starter));
        self
    }

    /// The real survivor round over `port`.
    fn with_survivor_round(mut self, port: &FakePort) -> Self {
        self.barrier = Some(port.barrier().clone());
        let port = port.clone();
        self.with_round(move || tokio::spawn(async move { let _ = adopt_survivors(&port).await; }))
    }

    fn note(&self, what: impl Into<String>) {
        let releases = self.world.count(HOLDER, "ReleaseMcp");
        let what = what.into();
        self.times.lock().unwrap().push((what.clone(), tokio::time::Instant::now()));
        self.events.lock().unwrap().push((what, releases));
    }

    /// When `what` first happened.
    fn at(&self, what: &str) -> tokio::time::Instant {
        let times = self.times.lock().unwrap();
        times.iter().find(|(name, _)| name == what).unwrap_or_else(|| panic!("{what} never happened")).1
    }

    fn events(&self) -> Vec<(String, usize)> {
        self.events.lock().unwrap().clone()
    }

    fn names(&self) -> Vec<String> {
        self.events().into_iter().map(|(name, _)| name).collect()
    }
}

impl McpBootIo for FakeIo {
    fn start_round(&self) -> tokio::task::JoinHandle<()> {
        self.note("start_round");
        match self.round.lock().unwrap().take() {
            Some(starter) => starter(),
            None => tokio::spawn(async {}),
        }
    }

    fn quiet(&self) -> bool {
        match &self.barrier {
            Some(barrier) => !barrier.any_in_flight(),
            None => self.quiet.load(Ordering::SeqCst),
        }
    }

    async fn pick_mcp(&self, _cfg: &NetworkConfig, _own_id: &str, _api_port: u16) -> Option<u16> {
        self.note("pick_mcp");
        self.pick
    }

    async fn spawn(&self, _cfg: &NetworkConfig, port: u16) -> bool {
        self.note(format!("spawn:{port}"));
        (self.spawn_ok)(port)
    }

    async fn owns(&self, _own_id: &str, port: u16) -> PortOwner {
        self.note(format!("owns:{port}"));
        tokio::time::sleep(self.probe).await;
        if let Some(gate) = &self.probe_gate {
            gate.notified().await;
        }
        (self.owner)(port)
    }

    fn stop(&self) {
        self.note("stop");
    }
}

/// The current host plus the holder `h1`, with the real survivor round as the IO's round.
fn world_with_holder(spec: HostSpec) -> (Arc<World>, FakePort, FakeIo) {
    let (world, port) = machine_with_current(HostSpec::default(), &[(HOLDER, spec)]);
    let io = FakeIo::new(&world).with_survivor_round(&port);
    (world, port, io)
}

// ---- the rule ---------------------------------------------------------------------------------------

fn held_with(port: u16, configured: u16, host: &str) -> McpHeld {
    McpHeld { port, configured_port: configured, bind_host: host.into() }
}

#[test]
fn an_unchanged_config_gives_use() {
    assert_eq!(reclaim_rule(Some(&held_with(P, P, "127.0.0.1")), P, "127.0.0.1"), Decision::Use(P));
}

#[test]
fn a_fallback_launch_gives_use_of_the_held_port() {
    assert_eq!(reclaim_rule(Some(&held_with(PICK, P, "127.0.0.1")), P, "127.0.0.1"), Decision::Use(PICK));
}

#[test]
fn a_changed_mcp_port_gives_changed() {
    assert!(matches!(reclaim_rule(Some(&held_with(P, P, "127.0.0.1")), P + 20, "127.0.0.1"), Decision::Changed(_)));
    // measured against the configured port at offload, not the effective one
    assert!(matches!(reclaim_rule(Some(&held_with(PICK, P, "127.0.0.1")), PICK, "127.0.0.1"), Decision::Changed(_)));
}

#[test]
fn a_changed_bind_host_gives_changed() {
    assert!(matches!(reclaim_rule(Some(&held_with(P, P, "127.0.0.1")), P, "0.0.0.0"), Decision::Changed(_)));
}

#[test]
fn no_claim_gives_no_claim() {
    assert_eq!(reclaim_rule(None, P, "127.0.0.1"), Decision::NoClaim);
}

// ---- Use ----------------------------------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn use_holds_until_api_bound_then_releases_and_spawns_held_port() {
    let (world, port, io) = world_with_holder(holding_p());

    let prepared = prepare_reclaim(&io, inputs(&port, cfg())).await;
    assert_eq!(prepared.decision(), &Decision::Use(P));
    assert_eq!(prepared.reserved(), [P], "the API bind must not take the held port");
    assert_eq!(world.count(HOLDER, "ReleaseMcp"), 0, "the holder serves through the API bind");

    // lib.rs binds the API here.
    io.note("bind_api");
    tokio::time::sleep(millis(100)).await;
    let started = start_mcp(prepared, API, &io).await;

    assert_eq!(started, Some(P));
    assert_eq!(releases(&world, HOLDER), [HOST_TOKEN], "released once, with the host token");
    assert_eq!(
        io.events(),
        [
            ("start_round".to_string(), 0),
            ("bind_api".to_string(), 0),
            (format!("spawn:{P}"), 1),
            (format!("owns:{P}"), 1),
        ],
        "bind, then release, then spawn on the held port, then the identity check; the search never ran"
    );
}

#[tokio::test(start_paused = true)]
async fn fallback_launch_reuses_held_port() {
    let spec = HostSpec { mcp_held: Some(held_with(PICK, P, "127.0.0.1")), ..holding_p() };
    let (_world, port, io) = world_with_holder(spec);

    let prepared = prepare_reclaim(&io, inputs(&port, cfg())).await;
    assert_eq!(prepared.reserved(), [PICK]);
    let started = start_mcp(prepared, API, &io).await;

    assert_eq!(started, Some(PICK), "a launch that had fallen back keeps the port it had");
    assert!(io.names().contains(&format!("spawn:{PICK}")));
    assert!(!io.names().contains(&"pick_mcp".to_string()));
}

// ---- Changed and NoClaim -------------------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn changed_releases_inside_prepare_and_searches() {
    let (world, port, io) = world_with_holder(holding_p());

    let prepared = prepare_reclaim(&io, inputs(&port, NetworkConfig { mcp_port: P + 20, ..cfg() })).await;

    assert!(matches!(prepared.decision(), Decision::Changed(_)));
    assert_eq!(releases(&world, HOLDER), [HOST_TOKEN], "released before the API bind");
    assert_eq!(prepared.reserved(), Vec::<u16>::new(), "the held port is not reserved");
    let started = start_mcp(prepared, API, &io).await;
    assert_eq!(started, Some(PICK));
    assert_eq!(io.names(), ["start_round", "pick_mcp", &format!("spawn:{PICK}")]);
    assert_eq!(releases(&world, HOLDER).len(), 1, "and not released again");
}

#[tokio::test(start_paused = true)]
async fn a_changed_bind_host_releases_and_searches() {
    let (world, port, io) = world_with_holder(holding_p());

    let prepared =
        prepare_reclaim(&io, inputs(&port, NetworkConfig { expose_on_network: true, ..cfg() })).await;

    assert!(matches!(prepared.decision(), Decision::Changed(_)), "{:?}", prepared.decision());
    assert_eq!(releases(&world, HOLDER), [HOST_TOKEN]);
}

#[tokio::test(start_paused = true)]
async fn no_claim_releases_nothing_and_searches() {
    let (world, port) = machine_with_current(HostSpec::default(), &[(HOLDER, HostSpec { mcp_hold: true, ..HostSpec::default() })]);
    let io = FakeIo::new(&world).with_survivor_round(&port);

    let prepared = prepare_reclaim(&io, inputs(&port, cfg())).await;
    assert_eq!(prepared.decision(), &Decision::NoClaim);
    assert_eq!(prepared.reserved(), Vec::<u16>::new());
    let started = start_mcp(prepared, API, &io).await;

    assert_eq!(started, Some(PICK));
    assert_eq!(world.count_everywhere("ReleaseMcp"), 0, "nothing was released");
    assert_eq!(io.names(), ["start_round", "pick_mcp", &format!("spawn:{PICK}")]);
}

#[tokio::test(start_paused = true)]
async fn the_normal_search_reports_no_server_when_nothing_is_free_or_the_spawn_fails() {
    let (world, port) = machine_with_current(HostSpec::default(), &[]);
    let mut io = FakeIo::new(&world);
    io.pick = None;
    let prepared = prepare_reclaim(&io, inputs(&port, cfg())).await;
    assert_eq!(start_mcp(prepared, API, &io).await, None, "no free port");

    let mut io = FakeIo::new(&world);
    io.spawn_ok = Box::new(|_| false);
    let prepared = prepare_reclaim(&io, inputs(&port, cfg())).await;
    assert_eq!(start_mcp(prepared, API, &io).await, None, "a rejected start publishes nothing");
}

// ---- fallbacks -------------------------------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn a_release_that_is_not_released_never_spawns_the_held_port() {
    let (world, port, io) = world_with_holder(holding_p());
    let prepared = prepare_reclaim(&io, inputs(&port, cfg())).await;
    assert_eq!(prepared.decision(), &Decision::Use(P));
    world.silence_mcp(HOLDER);

    let started = start_mcp(prepared, API, &io).await;

    assert_eq!(started, Some(PICK));
    assert!(!io.names().contains(&format!("spawn:{P}")), "no spawn of the held port: {:?}", io.names());
    assert_eq!(io.names(), ["start_round", "stop", "pick_mcp", &format!("spawn:{PICK}")]);
}

#[tokio::test(start_paused = true)]
async fn a_false_respawn_stops_then_searches() {
    let (_world, port, mut io) = world_with_holder(holding_p());
    io.spawn_ok = Box::new(|port| port != P);
    let prepared = prepare_reclaim(&io, inputs(&port, cfg())).await;

    let started = start_mcp(prepared, API, &io).await;

    assert_eq!(started, Some(PICK));
    assert_eq!(io.names(), ["start_round", &format!("spawn:{P}"), "stop", "pick_mcp", &format!("spawn:{PICK}")]);
}

#[tokio::test(start_paused = true)]
async fn identity_failure_stops_and_searches() {
    let (_world, port, mut io) = world_with_holder(holding_p());
    // Something answers the held port, but it is not this instance.
    io.owner = Box::new(|_| PortOwner::OwnedByOther);
    let prepared = prepare_reclaim(&io, inputs(&port, cfg())).await;
    let began = tokio::time::Instant::now();

    let started = start_mcp(prepared, API, &io).await;

    assert_eq!(started, Some(PICK), "never an unverified forced use of the held port");
    assert!(began.elapsed() >= IDENTITY_WAIT, "the identity was given its whole wait: {:?}", began.elapsed());
    let names = io.names();
    let spawn_p = names.iter().position(|n| n == &format!("spawn:{P}")).expect("the held port was tried");
    let stop = names.iter().position(|n| n == "stop").expect("and stopped");
    let pick = names.iter().position(|n| n == "pick_mcp").expect("and the search ran");
    assert!(spawn_p < stop && stop < pick, "{names:?}");
    assert!(names.iter().filter(|n| n.starts_with("owns:")).count() > 1, "the identity was polled: {names:?}");
}

/// An identity probe that answers as another instance until `after` past the start (the first probe
/// answers one `probe` delay after it, 200 ms in these fixtures), then as this one.
fn owned_after(after: Duration) -> Box<dyn Fn(u16) -> PortOwner + Send + Sync> {
    let first = Mutex::new(None::<tokio::time::Instant>);
    Box::new(move |_| {
        let now = tokio::time::Instant::now();
        let start = *first.lock().unwrap().get_or_insert(now) - millis(200);
        if now - start >= after { PortOwner::OwnedBySelf } else { PortOwner::OwnedByOther }
    })
}

/// The identity wait is bounded as a whole, probes included (review 317 R1): with slow probes, a
/// persistent mismatch gives up by `IDENTITY_WAIT` after the start, an own answer that only arrives past
/// that bound is not accepted, and one that arrives in time is.
#[tokio::test(start_paused = true)]
async fn identity_wait_bounds_slow_probes() {
    // A persistent mismatch: the poll ends no later than the bound.
    let (_world, port, mut io) = world_with_holder(holding_p());
    io.owner = Box::new(|_| PortOwner::OwnedByOther);
    io.probe = millis(200);
    let prepared = prepare_reclaim(&io, inputs(&port, cfg())).await;
    assert_eq!(start_mcp(prepared, API, &io).await, Some(PICK));
    let waited = io.at("stop") - io.at(&format!("spawn:{P}"));
    assert!(waited <= IDENTITY_WAIT, "the identity check overran its bound: {waited:?}");

    // Our own answer, but only past the bound: never accepted.
    let (_world, port, mut io) = world_with_holder(holding_p());
    io.probe = millis(200);
    let prepared = prepare_reclaim(&io, inputs(&port, cfg())).await;
    io.owner = owned_after(IDENTITY_WAIT + millis(100));
    assert_eq!(start_mcp(prepared, API, &io).await, Some(PICK), "an identity proven too late is no proof");
    assert!(io.names().contains(&"stop".to_string()), "{:?}", io.names());

    // Our own answer within the bound: the held port is kept.
    let (_world, port, mut io) = world_with_holder(holding_p());
    io.probe = millis(200);
    let prepared = prepare_reclaim(&io, inputs(&port, cfg())).await;
    io.owner = owned_after(secs(1));
    assert_eq!(start_mcp(prepared, API, &io).await, Some(P));
    assert!(!io.names().contains(&"stop".to_string()), "{:?}", io.names());
}

/// The race a timeout alone loses (review 318 N1): the probe's own answer and the deadline are both
/// ready when the check is next polled. `timeout` polls its future first, so the answer would win;
/// it was seen after the bound and must be rejected.
#[tokio::test(start_paused = true)]
async fn identity_seen_after_the_bound_is_rejected_even_when_ready_with_the_timeout() {
    let (world, _port) = machine_with_current(HostSpec::default(), &[]);
    let mut io = FakeIo::new(&world);
    let gate = Arc::new(tokio::sync::Notify::new());
    io.probe_gate = Some(gate.clone());
    let check = crate::state::mcp_reclaim::wait_for_identity(&io, "own-056", P);
    tokio::pin!(check);

    assert!(futures::poll!(&mut check).is_pending(), "the first probe is waiting for its answer");
    tokio::time::advance(IDENTITY_WAIT + millis(200)).await;
    gate.notify_one();

    assert!(!check.await, "an identity seen 200 ms past the bound is no proof");
    assert_eq!(io.names(), [format!("owns:{P}")], "one probe, answered late");

    // The control: the same answer before the bound is accepted.
    let mut io = FakeIo::new(&world);
    let gate = Arc::new(tokio::sync::Notify::new());
    io.probe_gate = Some(gate.clone());
    let check = crate::state::mcp_reclaim::wait_for_identity(&io, "own-056", P);
    tokio::pin!(check);
    assert!(futures::poll!(&mut check).is_pending());
    tokio::time::advance(IDENTITY_WAIT - millis(200)).await;
    gate.notify_one();
    assert!(check.await, "an identity seen within the bound is accepted");
}

#[tokio::test(start_paused = true)]
async fn equal_port_fallback_is_a_normal_spawn() {
    let (_world, port, mut io) = world_with_holder(holding_p());
    io.owner = Box::new(|_| PortOwner::Free);
    io.pick = Some(P);
    let prepared = prepare_reclaim(&io, inputs(&port, cfg())).await;

    let started = start_mcp(prepared, API, &io).await;

    assert_eq!(started, Some(P), "the search may legitimately pick the port again once it is free");
    let names = io.names();
    let pick = names.iter().position(|n| n == "pick_mcp").expect("it went through the search");
    let spawns: Vec<usize> = names.iter().enumerate().filter(|(_, n)| **n == format!("spawn:{P}")).map(|(i, _)| i).collect();
    assert_eq!(spawns.len(), 2, "the forced start, then the normal one: {names:?}");
    assert!(spawns[0] < pick && pick < spawns[1], "the second spawn comes from the search: {names:?}");
}

#[tokio::test(start_paused = true)]
async fn prepared_drop_releases_claim() {
    let (world, port, io) = world_with_holder(holding_p());
    let prepared = prepare_reclaim(&io, inputs(&port, cfg())).await;
    assert_eq!(prepared.decision(), &Decision::Use(P));
    assert_eq!(world.count(HOLDER, "ReleaseMcp"), 0);

    // The API bind failed: lib.rs drops what it prepared.
    drop(prepared);
    settle_tasks().await;

    assert_eq!(releases(&world, HOLDER), [HOST_TOKEN], "the claim went back to its host");
    assert_eq!(io.names(), ["start_round"], "and nothing was started");
}

#[tokio::test(start_paused = true)]
async fn a_cancelled_prepare_during_the_release_still_releases_once() {
    let (world, port, io) = world_with_holder(holding_p());
    let adopted = prepare_reclaim(&io, inputs(&port, cfg())).await;
    drop(adopted); // adoption and the first release are done; a second boot reuses the world
    settle_tasks().await;
    assert_eq!(releases(&world, HOLDER).len(), 1);

    // A boot whose Changed release is gated: cancelled while it waits.
    let (world, port, io) = world_with_holder(holding_p());
    let gate = Arc::new(EventGate::default());
    let task = tokio::spawn({
        let (port, gate, world) = (port.clone(), gate.clone(), world.clone());
        async move {
            // The gate applies to the release only (adoption's claim and disarm are not gated).
            world.gate_release_acks(HOLDER, &gate);
            let prepared = prepare_reclaim(&io, inputs(&port, NetworkConfig { mcp_port: P + 20, ..cfg() })).await;
            drop(prepared);
        }
    });
    gate.wait_reached(1).await;
    task.abort();
    let _ = task.await;
    gate.release();
    settle_tasks().await;

    assert_eq!(releases(&world, HOLDER), [HOST_TOKEN], "the detached release completed, once");
}

#[tokio::test(start_paused = true)]
async fn a_boot_cancelled_during_the_wait_makes_a_later_claim_late() {
    let (world, port) = machine_with_current(HostSpec::default(), &[(HOLDER, holding_p())]);
    let io = FakeIo::new(&world).with_round(|| tokio::spawn(std::future::pending::<()>()));
    let reclaim = port.reclaim().clone();
    let task = tokio::spawn({
        let inputs = inputs(&port, cfg());
        async move { prepare_reclaim(&io, inputs).await }
    });
    tokio::time::sleep(secs(1)).await;

    task.abort();
    let _ = task.await;
    reclaim.offer(claimed(connect(&port, HOLDER, 7).await, HOLDER, 7));
    settle_tasks().await;

    assert_eq!(releases(&world, HOLDER), [HOST_TOKEN], "exit during the wait: the guard dropped, so the claim is released");
}

// ---- the wake-up oracle ----------------------------------------------------------------------------------------

/// A round that stores a claim at `at` and then stays pending for a long time.
fn claiming_round(port: &FakePort, world: &Arc<World>, at: Duration) -> impl FnOnce() -> tokio::task::JoinHandle<()> + Send + 'static {
    let (port, world) = (port.clone(), world.clone());
    move || {
        tokio::spawn(async move {
            tokio::time::sleep(at).await;
            let client = connect(&port, HOLDER, 5).await;
            port.reclaim().offer(claimed(client, HOLDER, 5));
            let _ = &world;
            tokio::time::sleep(secs(100)).await;
        })
    }
}

fn plain_world() -> (Arc<World>, FakePort) {
    let world = World::new();
    world.add_host(HOLDER, holding_p());
    (world.clone(), FakePort::new(&world, CURRENT))
}

async fn elapsed_of_prepare(io: &FakeIo, port: &FakePort) -> (Duration, crate::state::mcp_reclaim::Prepared) {
    let began = tokio::time::Instant::now();
    let prepared = prepare_reclaim(io, inputs(port, cfg())).await;
    (began.elapsed(), prepared)
}

#[tokio::test(start_paused = true)]
async fn claim_arrival_wakes_the_wait() {
    let (world, port) = plain_world();
    let mut io = FakeIo::new(&world).with_round(claiming_round(&port, &world, secs(1)));
    io.quiet = Arc::new(AtomicBool::new(false));

    let (elapsed, prepared) = elapsed_of_prepare(&io, &port).await;

    assert!(elapsed >= secs(1) && elapsed <= secs(1) + millis(200), "decided {elapsed:?} after the start, at the claim");
    assert_eq!(prepared.decision(), &Decision::Use(P));
}

#[tokio::test(start_paused = true)]
async fn a_round_that_ended_with_no_attempt_in_flight_decides_at_once() {
    let (world, port) = plain_world();
    let io = FakeIo::new(&world);

    let (elapsed, prepared) = elapsed_of_prepare(&io, &port).await;

    assert!(elapsed <= millis(200), "decided {elapsed:?} after the start");
    assert_eq!(prepared.decision(), &Decision::NoClaim);
}

#[tokio::test(start_paused = true)]
async fn a_claim_stored_before_the_wait_decides_at_once() {
    let (world, port) = plain_world();
    port.reclaim().offer(claimed(connect(&port, HOLDER, 5).await, HOLDER, 5));
    let mut io = FakeIo::new(&world).with_round(|| tokio::spawn(std::future::pending::<()>()));
    io.quiet = Arc::new(AtomicBool::new(false));

    let (elapsed, prepared) = elapsed_of_prepare(&io, &port).await;

    assert!(elapsed <= millis(200), "decided {elapsed:?} after the start");
    assert_eq!(prepared.decision(), &Decision::Use(P));
}

#[tokio::test(start_paused = true)]
async fn nothing_arriving_decides_at_the_bound() {
    let (world, port) = plain_world();
    let mut io = FakeIo::new(&world).with_round(|| tokio::spawn(std::future::pending::<()>()));
    io.quiet = Arc::new(AtomicBool::new(false));

    let (elapsed, prepared) = elapsed_of_prepare(&io, &port).await;

    assert!(elapsed >= CLAIM_WAIT && elapsed <= CLAIM_WAIT + millis(200), "decided {elapsed:?} after the start");
    assert_eq!(prepared.decision(), &Decision::NoClaim);
}

#[tokio::test(start_paused = true)]
async fn an_ended_round_waits_for_the_attempt_still_in_flight() {
    let (world, port) = plain_world();
    let io = FakeIo::new(&world);
    io.quiet.store(false, std::sync::atomic::Ordering::SeqCst);
    let quiet = io.quiet.clone();
    tokio::spawn(async move {
        tokio::time::sleep(secs(2)).await;
        quiet.store(true, std::sync::atomic::Ordering::SeqCst);
    });

    let (elapsed, prepared) = elapsed_of_prepare(&io, &port).await;

    assert!(elapsed >= secs(2) && elapsed <= secs(2) + millis(200), "decided {elapsed:?} after the start, once adoption was quiet");
    assert_eq!(prepared.decision(), &Decision::NoClaim);
}

#[tokio::test(start_paused = true)]
async fn a_claim_after_the_deadline_from_the_still_running_round_is_released_once_to_its_own_endpoint() {
    let (world, port) = plain_world();
    let mut io = FakeIo::new(&world).with_round(claiming_round(&port, &world, secs(8)));
    io.quiet = Arc::new(AtomicBool::new(false));

    let (elapsed, prepared) = elapsed_of_prepare(&io, &port).await;
    assert!(elapsed >= CLAIM_WAIT);
    assert_eq!(prepared.decision(), &Decision::NoClaim);
    assert_eq!(world.count(HOLDER, "ReleaseMcp"), 0);
    tokio::time::sleep(secs(4)).await;

    assert_eq!(releases(&world, HOLDER), [HOST_TOKEN], "released once, to the host that made it");
    assert_eq!(prepared.reserved(), Vec::<u16>::new());
    drop(prepared);
}

// ---- the shared flight (review 315 N1) ---------------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn concurrent_round_attempt_holds_the_wait() {
    // The holder's connect is slow; a concurrent restore/create round owns its attempt.
    let slow = HostSpec { connect_delay: secs(1), ..holding_p() };
    let (world, port) = machine_with_current(HostSpec::default(), &[(HOLDER, slow)]);
    let concurrent = tokio::spawn({
        let port = port.clone();
        async move { rediscover_hosts(&port).await }
    });
    tokio::time::sleep(millis(10)).await;
    assert!(!port.barrier().unresolved().is_empty(), "the premise: the concurrent round has not finished the holder");
    assert!(port.current_client().is_some(), "and has published a Primary connection");
    let io = FakeIo::new(&world).with_survivor_round(&port);

    let (elapsed, prepared) = elapsed_of_prepare(&io, &port).await;

    assert!(elapsed >= millis(900) && elapsed <= secs(2), "the wait ended at the holder's claim, not at the end of the survivor round: {elapsed:?}");
    assert_eq!(prepared.decision(), &Decision::Use(P), "the claim a concurrent round made was used");
    assert_eq!(world.count(HOLDER, "ReleaseMcp"), 0, "and was not released as late");
    concurrent.await.unwrap().unwrap();
    drop(prepared);
}

#[tokio::test(start_paused = true)]
async fn survivor_round_attempts_no_synthesized_host() {
    // Cold boot: nothing discovered at all.
    let world = World::new();
    let port = FakePort::new(&world, CURRENT);
    adopt_survivors(&port).await.unwrap();
    assert_eq!(port.0.discovers.load(Ordering::SeqCst), 1, "it looked");
    assert!(port.0.connects.lock().unwrap().is_empty(), "and attempted no candidate");
    assert!(world.started_processes.lock().unwrap().is_empty(), "so started no host");
    assert!(port.current_client().is_none());

    // The same machine through the ordinary round does start the current host: the contrast that
    // proves the survivor round's silence is the flag and not an empty world.
    let world = World::new();
    let port = FakePort::new(&world, CURRENT);
    rediscover_hosts(&port).await.unwrap();
    assert_eq!(world.started_processes.lock().unwrap().as_slice(), [CURRENT.to_string()], "a synthesizing round starts it");
}

#[tokio::test(start_paused = true)]
async fn survivor_round_connects_a_discovered_current_host() {
    let (world, port) = machine_with_current(HostSpec::default(), &[]);
    adopt_survivors(&port).await.unwrap();
    assert_eq!(port.connect_count(CURRENT), 1);
    assert!(port.current_client().is_some());
    assert!(world.started_processes.lock().unwrap().is_empty(), "a running host is adopted, not started");
}

#[test]
fn the_waits_are_what_the_plan_says() {
    assert_eq!(CLAIM_WAIT, secs(5));
    assert_eq!(IDENTITY_WAIT, secs(3));
    assert_eq!(crate::state::mcp_reclaim::RECLAIM_LEASE, secs(60));
}
