//! The update that closes every terminal, over fake hosts and a fake application
//! around them. Every assertion names the host that received a frame and checks
//! the order things happened in (`events`): "the updater was launched" is true
//! of an implementation that launches it before the sibling check, and "no host
//! was closed" of one that never reaches them.

use super::fake_hosts::*;
use super::lifecycle_tests::{adopted, holding, marks, secs, since, undiscovered_until_now, CURRENT, SEC};
use super::*;
use crate::commands::UpdateRestart;
use crate::net_ports::InstanceRecord;
use crate::state::host_lifecycle::{exit_hosts_within, CloseBounds};
use crate::state::host_table::Busy;
use crate::state::update_full::{
    availability, run_full, ConfirmToken, Confirmation, FullRun, FullUpdatePort, Target,
};
use crate::state::update_survival::{FullReason, UpdateMode};
use crate::update_policy::UpdateMode as Marker;
use serde_json::json;
use std::sync::atomic::Ordering;

impl FullUpdatePort for FakePort {
    fn local_shells(&self) -> u32 {
        self.0.full.local_shells.load(Ordering::SeqCst)
    }

    fn live_siblings(&self) -> Result<Vec<InstanceRecord>, String> {
        note(self, "siblings");
        Ok(self.0.full.siblings.lock().unwrap().clone())
    }

    async fn flush_windows(&self) -> bool {
        note(self, "flush_windows");
        let half = *self.0.full.flush_takes.lock().unwrap() / 2;
        tokio::time::sleep(half).await;
        // Another instance starts while the windows are still answering.
        let appearing = std::mem::take(&mut *self.0.full.appear_during_flush.lock().unwrap());
        self.0.full.siblings.lock().unwrap().extend(appearing);
        tokio::time::sleep(half).await;
        true
    }

    fn abort_flush(&self) {
        self.0.full.aborted_flushes.fetch_add(1, Ordering::SeqCst);
        note(self, "abort_flush");
    }

    async fn flush_history(&self) {
        note(self, "flush_history");
    }

    async fn updater_alive(&self) -> bool {
        note(self, "updater_alive");
        !self.0.full.updater_dead.load(Ordering::SeqCst)
    }

    async fn close_all_hosts(&self, bounds: CloseBounds) {
        note(self, "close_hosts:start");
        let stall = *self.0.full.close_stalls.lock().unwrap();
        if !stall.is_zero() {
            // A runtime that is stuck, not one that is waiting.
            std::thread::sleep(stall);
        }
        exit_hosts_within(self, Some(bounds)).await;
        note(self, "close_hosts:end");
    }

    fn exit_app(&self) {
        self.0.full.app_exits.fetch_add(1, Ordering::SeqCst);
        note(self, "exit");
    }

    fn hard_exit(&self) {
        let thread = std::thread::current();
        self.0.full.hard_exits.lock().unwrap().push(HardExit {
            thread_name: thread.name().map(str::to_owned),
            thread: thread.id(),
            on_runtime: tokio::runtime::Handle::try_current().is_ok(),
        });
        note(self, "hard_exit");
    }

    fn watchdog_after(&self) -> Duration {
        *self.0.full.watchdog_after.lock().unwrap()
    }
}

fn note(port: &FakePort, event: &str) {
    port.0.full.events.lock().unwrap().push(event.to_owned());
}

fn events(port: &FakePort) -> Vec<String> {
    port.0.full.events.lock().unwrap().clone()
}

fn clear_events(port: &FakePort) {
    port.0.full.events.lock().unwrap().clear();
}

fn instance(profile: &str, pid: u32) -> InstanceRecord {
    InstanceRecord { profile: profile.into(), pid, api_port: Some(42035), mcp_port: None, token: Some("t".into()) }
}

fn target(version: &str, marker_mode: Marker) -> Target {
    Target { version: version.into(), marker_mode }
}

/// A release whose notes demand a full update.
fn marked() -> Target {
    target("2.0.0", Marker::Full)
}

fn token_of(asked: &Confirmation) -> ConfirmToken {
    ConfirmToken {
        target_version: asked.version.clone(),
        shell_count: asked.shell_count,
        unknown: asked.unknown,
        reasons: asked.reasons.clone(),
    }
}

/// The updater is started by `launch`, which here only records that it was and
/// answers `launched`.
async fn run(
    port: &FakePort,
    target: &Target,
    confirm: Option<ConfirmToken>,
    launched: Result<(), String>,
) -> Result<FullRun<()>, String> {
    let recorder = port.clone();
    run_full(port, target, confirm, (), move |()| async move {
        note(&recorder, "launch");
        launched
    })
    .await
}

/// What the user is asked, the first time.
async fn asked(port: &FakePort, target: &Target) -> Confirmation {
    match run(port, target, None, Ok(())).await {
        Ok(FullRun::NeedsConfirmation(asked)) => asked,
        other => panic!("expected to be asked first, got {other:?}"),
    }
}

/// A machine where the user has agreed to updating to `marked()`.
async fn agreed(old: &[(&str, HostSpec)]) -> (Arc<World>, FakePort, ConfirmToken) {
    let (world, port) = adopted(old).await;
    let token = token_of(&asked(&port, &marked()).await);
    clear_events(&port);
    (world, port, token)
}

/// A real-time machine: the watchdog is a thread, so what it does cannot be seen
/// in paused time.
fn quick(port: &FakePort, watchdog: Duration) {
    *port.0.full.flush_takes.lock().unwrap() = Duration::from_millis(10);
    *port.0.full.watchdog_after.lock().unwrap() = watchdog;
}

const HOSTS: [&str; 3] = [CURRENT, "h1", "h2"];

fn two_old_hosts() -> [(&'static str, HostSpec); 2] {
    [("h1", holding(&[("k1", 11), ("k2", 12)])), ("h2", holding(&[("k3", 13)]))]
}

fn instances_closed(world: &World, from: &[usize]) -> Vec<Vec<&'static str>> {
    HOSTS.iter().zip(from).map(|(host, from)| since(world, host, *from)).collect()
}

// ---- asking ---------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn the_first_call_asks_and_changes_nothing_but_looking() {
    let (world, port) = adopted(&two_old_hosts()).await;
    port.0.full.local_shells.store(2, Ordering::SeqCst);
    let before = marks(&world, &HOSTS);

    let asked = asked(&port, &marked()).await;

    assert_eq!(asked.version, "2.0.0");
    assert_eq!(asked.shell_count, 3 + 2, "three shells on the hosts, two outside them");
    assert!(!asked.unknown);
    assert_eq!(asked.reasons, [FullReason::Marker]);
    assert_eq!(events(&port), ["siblings"], "no window was flushed and no updater started");
    assert_eq!(instances_closed(&world, &before), [vec!["List"], vec!["List"], vec!["List"]]);
    assert!(port.table().begin(HostChannel::Primary).is_ok(), "creation was never stopped");
}

#[tokio::test(start_paused = true)]
async fn the_count_sums_answered_hosts_and_local_shells_and_flags_an_unanswered_host() {
    let dead = SessionMeta { alive: false, ..meta("kdead", 14) };
    let (_world, port) = adopted(&[
        ("h1", HostSpec { sessions: vec![meta("k1", 11), meta("k2", 12), dead], ..HostSpec::default() }),
        ("h2", HostSpec { list: ListBehavior::SilentBetween(secs(5), secs(1000)), ..holding(&[("k3", 13)]) }),
    ])
    .await;
    port.0.full.local_shells.store(3, Ordering::SeqCst);

    let answered = asked(&port, &marked()).await;
    assert_eq!((answered.shell_count, answered.unknown), (2 + 1 + 3, false), "an ended shell is not a shell");

    tokio::time::sleep(secs(6)).await;
    let silent = asked(&port, &marked()).await;
    assert!(silent.unknown, "a host that does not answer is unknown, not empty");
    assert_eq!(silent.shell_count, 2 + 3, "and what it might hold is not counted as if it were known");
}

#[tokio::test(start_paused = true)]
async fn a_token_that_differs_in_any_field_asks_again() {
    let (world, port, token) = agreed(&two_old_hosts()).await;
    type Change = fn(&mut ConfirmToken);
    let changes: [(&str, Change); 4] = [
        ("version", |t| t.target_version = "2.0.1".into()),
        ("count", |t| t.shell_count += 1),
        ("unknown", |t| t.unknown = !t.unknown),
        ("reasons", |t| t.reasons.clear()),
    ];
    for (what, change) in changes {
        let mut stale = token.clone();
        change(&mut stale);
        let before = marks(&world, &HOSTS);

        let out = run(&port, &marked(), Some(stale), Ok(())).await.unwrap();

        match out {
            FullRun::NeedsConfirmation(fresh) => assert_eq!(token_of(&fresh), token, "{what}: asked what is true"),
            other => panic!("{what}: a stale agreement was honoured: {other:?}"),
        }
        assert_eq!(events(&port), ["siblings"], "{what}: nothing was started");
        assert!(instances_closed(&world, &before).iter().all(|f| f == &["List"]), "{what}");
        clear_events(&port);
    }
}

#[tokio::test(start_paused = true)]
async fn availability_a_download_b_asks_again() {
    let (world, port, token_for_a) = agreed(&two_old_hosts()).await;
    let before = marks(&world, &HOSTS);

    // The user agreed to 2.0.0; the download turned out to be 2.1.0, also full.
    let b = target("2.1.0", Marker::Full);
    let out = run(&port, &b, Some(token_for_a.clone()), Ok(())).await.unwrap();
    match out {
        FullRun::NeedsConfirmation(fresh) => {
            assert_eq!(fresh.version, "2.1.0", "asked about what was downloaded, not what was announced");
            assert_eq!((fresh.shell_count, fresh.reasons), (token_for_a.shell_count, token_for_a.reasons.clone()));
        }
        other => panic!("an agreement to another release was honoured: {other:?}"),
    }

    // The other direction: availability said an offload (an unmarked release), the
    // download is marked.
    let a = availability(&port, Marker::Offload, || Ok(())).unwrap();
    assert_eq!((a.mode, a.reasons.as_slice()), (UpdateMode::Offload, &[][..]));
    let out = run(&port, &marked(), None, Ok(())).await.unwrap();
    assert!(
        matches!(&out, FullRun::NeedsConfirmation(c) if c.reasons == [FullReason::Marker]),
        "a download that turned out to need a full update asks first: {out:?}"
    );
    assert_eq!(events(&port), ["siblings", "siblings"]);
    assert!(instances_closed(&world, &before).iter().all(|f| f == &["List", "List"]));
}

#[tokio::test(start_paused = true)]
async fn unmarked_download_with_unsafe_host_is_still_full() {
    let (world, port) = adopted(&[("h1", holding(&[("k1", 11)])), ("h2", HostSpec::default())]).await;
    port.set_exe_origin("h1", Some(true));
    port.set_exe_origin("h2", None);
    let unmarked = target("2.0.0", Marker::Offload);

    let a = availability(&port, Marker::Offload, || Ok(())).unwrap();
    assert_eq!(a.mode, UpdateMode::Full, "an unmarked release does not make a host that would be killed safe");

    let asked = asked(&port, &unmarked).await;
    assert!(
        matches!(&asked.reasons[..], [FullReason::HostInPayload(inside), FullReason::HostOriginUnknown(mystery)]
            if inside.contains("h1") && mystery.contains("h2")),
        "each reason names its own host: {:?}",
        asked.reasons
    );

    // Honoured through commit as well.
    clear_events(&port);
    let before = marks(&world, &HOSTS);
    let out = run(&port, &unmarked, Some(token_of(&asked)), Ok(())).await.unwrap();
    assert!(matches!(out, FullRun::Exited), "{out:?}");
    assert!(events(&port).contains(&"launch".to_string()));
    for (host, from) in HOSTS.iter().zip(before) {
        assert_eq!(since(&world, host, from).last(), Some(&"Eof"), "{host} was closed");
    }
}

#[tokio::test(start_paused = true)]
async fn marker_full_becomes_unmarked_download_offloads_when_all_hosts_safe() {
    let (world, port, stale_token) = agreed(&two_old_hosts()).await;
    let a = availability(&port, Marker::Full, || Ok(())).unwrap();
    assert_eq!((a.mode, a.reasons), (UpdateMode::Full, vec![FullReason::Marker]));
    clear_events(&port);
    let before = marks(&world, &HOSTS);

    let out = run(&port, &target("2.1.0", Marker::Offload), Some(stale_token), Ok(())).await.unwrap();

    assert!(matches!(out, FullRun::Offload(())), "the download is an offload: {out:?}");
    assert!(events(&port).is_empty(), "nothing was asked, flushed or started: {:?}", events(&port));
    assert!(instances_closed(&world, &before).iter().all(Vec::is_empty), "no host received anything");
}

// ---- refusing ---------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn siblings_alive_refuses_full() {
    let (world, port) = adopted(&two_old_hosts()).await;
    port.0.full.siblings.lock().unwrap().push(instance("rel.alt", 41));
    let before = marks(&world, &HOSTS);

    let err = run(&port, &marked(), None, Ok(())).await.expect_err("a running sibling would lose its window");

    assert!(err.contains("rel.alt (pid 41)"), "it names the instance: {err}");
    assert_eq!(events(&port), ["siblings"]);
    assert!(instances_closed(&world, &before).iter().all(Vec::is_empty), "refused before looking at any host");
}

#[tokio::test(start_paused = true)]
async fn sibling_started_while_quiesce_is_gated_on_a_held_ticket_refuses_full() {
    let (world, port, token) = agreed(&two_old_hosts()).await;
    let before = marks(&world, &HOSTS);
    // A create that was admitted before the update began is still running.
    let ticket = port.table().begin(HostChannel::Primary).unwrap();
    let runner = port.clone();
    let update = tokio::spawn(async move { run(&runner, &marked(), Some(token), Ok(())).await });

    tokio::time::sleep(SEC).await;
    assert_eq!(events(&port), ["siblings"], "still waiting for the create: nothing started");
    // An instance is launched while the update waits for it.
    port.0.full.siblings.lock().unwrap().push(instance("rel.alt", 41));
    drop(ticket);
    let err = update.await.unwrap().expect_err("the check at the start would have missed this one");

    assert!(err.contains("rel.alt (pid 41)"), "{err}");
    assert!(!events(&port).contains(&"launch".to_string()), "the updater was never started: {:?}", events(&port));
    assert_eq!(port.0.full.aborted_flushes.load(Ordering::SeqCst), 1, "the exit latch the flush set was undone");
    assert!(instances_closed(&world, &before).iter().all(|f| f == &["List", "List"]), "no host was touched");
    assert!(port.table().begin(HostChannel::Primary).is_ok(), "admission reopened");
}

#[tokio::test(start_paused = true)]
async fn sibling_started_during_the_window_flush_refuses_full() {
    let (world, port, token) = agreed(&two_old_hosts()).await;
    assert!(port.0.full.siblings.lock().unwrap().is_empty(), "none is running when the update starts");
    port.0.full.appear_during_flush.lock().unwrap().push(instance("rel.work", 77));
    let before = marks(&world, &HOSTS);

    let err = run(&port, &marked(), Some(token), Ok(())).await.expect_err("started during the flush");

    assert!(err.contains("rel.work (pid 77)"), "{err}");
    assert_eq!(
        events(&port),
        ["siblings", "flush_windows", "flush_history", "siblings", "abort_flush"],
        "checked after the flushes, and the updater never started"
    );
    assert!(instances_closed(&world, &before).iter().all(|f| f == &["List", "List"]));
    assert!(port.table().begin(HostChannel::Primary).is_ok());
}

#[tokio::test(start_paused = true)]
async fn full_refuses_while_an_owned_host_is_unresolved() {
    let (world, port) = adopted(&[("mute", HostSpec { list: ListBehavior::Never, ..HostSpec::default() })]).await;
    undiscovered_until_now(&world, &port, "legacy", HostSpec::default());

    let err = run(&port, &marked(), None, Ok(())).await.expect_err("what they hold is not known");

    assert!(err.contains("mute") && err.contains("legacy"), "both are named: {err}");
    assert_eq!(events(&port), ["siblings"]);
    assert_eq!(port.connect_count("legacy"), 0, "refusing does not touch it");
}

#[tokio::test(start_paused = true)]
async fn owned_host_drops_between_confirm_and_commit_re_asks_then_refuses() {
    let (world, port, token) = agreed(&[("h1", holding(&[("k1", 11)]))]).await;
    let ticket = port.table().begin(HostChannel::Primary).unwrap();
    let runner = port.clone();
    let update = tokio::spawn(async move { run(&runner, &marked(), Some(token), Ok(())).await });
    tokio::time::sleep(SEC).await;
    // The host goes away while the update waits for the create.
    world.set_unreachable("h1", true);
    world.kill_connections("h1");
    tokio::time::sleep(SEC).await;
    drop(ticket);

    let out = update.await.unwrap().unwrap();

    let fresh = match out {
        FullRun::NeedsConfirmation(fresh) => fresh,
        other => panic!("the count of what would be closed is no longer known: {other:?}"),
    };
    assert!(fresh.unknown, "the host that dropped did not say what it holds");
    assert!(!events(&port).contains(&"launch".to_string()) && !events(&port).contains(&"flush_windows".to_string()));

    // Agreeing to that does not get past the next look: the host is not resolved.
    let err = run(&port, &marked(), Some(token_of(&fresh)), Ok(())).await.expect_err("refused");
    assert!(err.contains("h1"), "{err}");
    assert!(!events(&port).contains(&"launch".to_string()));
}

#[tokio::test(start_paused = true)]
async fn scope_changes_between_confirm_and_quiesce_re_asks() {
    let (world, port, token) = agreed(&two_old_hosts()).await;
    let before = marks(&world, &HOSTS);
    let ticket = port.table().begin(HostChannel::Primary).unwrap();
    let runner = port.clone();
    let update = tokio::spawn(async move { run(&runner, &marked(), Some(token), Ok(())).await });
    tokio::time::sleep(SEC).await;
    // A terminal is created on a host while the update waits for the gate.
    world.begin_session("h1", meta("k-new", 99));
    drop(ticket);

    let out = update.await.unwrap().unwrap();

    match out {
        FullRun::NeedsConfirmation(fresh) => assert_eq!(fresh.shell_count, 4, "the new shell is counted"),
        other => panic!("an agreement to closing three shells was used for four: {other:?}"),
    }
    assert!(!events(&port).contains(&"flush_windows".to_string()), "{:?}", events(&port));
    assert!(
        instances_closed(&world, &before).iter().all(|f| f == &["List", "List"]),
        "looked at before and after the gate, and no host was closed"
    );
    assert!(port.table().begin(HostChannel::Primary).is_ok(), "admission reopened");
}

#[tokio::test(start_paused = true)]
async fn unknown_flag_flip_re_asks() {
    // h1 answers until 5 s in and then goes quiet; it holds nothing, so only the
    // flag can tell the two looks apart.
    let (world, port, token) = agreed(&[
        ("h1", HostSpec { list: ListBehavior::SilentBetween(secs(5), secs(1000)), ..HostSpec::default() }),
        ("h2", holding(&[("k3", 13)])),
    ])
    .await;
    assert!(!token.unknown);
    let before = marks(&world, &HOSTS);
    let ticket = port.table().begin(HostChannel::Primary).unwrap();
    let runner = port.clone();
    let update = tokio::spawn(async move { run(&runner, &marked(), Some(token), Ok(())).await });
    tokio::time::sleep(secs(6)).await;
    drop(ticket);

    let out = update.await.unwrap().unwrap();

    match out {
        FullRun::NeedsConfirmation(fresh) => {
            assert!(fresh.unknown);
            assert_eq!(fresh.shell_count, 1, "the count itself did not change");
        }
        other => panic!("a count that became unknown was treated as the one agreed to: {other:?}"),
    }
    assert!(instances_closed(&world, &before).iter().all(|f| f == &["List", "List"]), "no host was closed");
    assert!(!events(&port).contains(&"launch".to_string()));
}

// ---- committing and closing --------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn full_never_sends_arm_detach() {
    let (world, port, token) = agreed(&two_old_hosts()).await;
    let before = marks(&world, &HOSTS);

    let out = run(&port, &marked(), Some(token), Ok(())).await.unwrap();

    assert!(matches!(out, FullRun::Exited), "{out:?}");
    assert_eq!(world.count_everywhere("Arm"), 0, "the shells are meant to end: nothing is armed");
    for (host, frames) in HOSTS.iter().zip(instances_closed(&world, &before)) {
        assert_eq!(frames, ["List", "List", "Disarm", "Shutdown", "Eof"], "{host}: looked at twice, then closed for good");
    }
    assert_eq!(
        events(&port),
        [
            "siblings",
            "flush_windows",
            "flush_history",
            "siblings",
            "launch",
            "updater_alive",
            "close_hosts:start",
            "close_hosts:end",
            "exit",
        ]
    );
    assert!(matches!(port.table().begin(HostChannel::Primary), Err(Busy::Lifecycle(_))), "admission stays closed");
}

#[tokio::test(start_paused = true)]
async fn history_flushed_before_updater_launch() {
    let (_world, port, token) = agreed(&two_old_hosts()).await;

    run(&port, &marked(), Some(token), Ok(())).await.unwrap();

    let events = events(&port);
    let at = |what: &str| events.iter().position(|e| e == what).unwrap_or_else(|| panic!("{what} in {events:?}"));
    assert!(at("flush_windows") < at("flush_history"), "{events:?}");
    assert!(at("flush_history") < at("launch"), "the exit hooks do not run when the watchdog ends the process: {events:?}");
    assert!(at("launch") < at("close_hosts:start"));
}

#[tokio::test(start_paused = true)]
async fn launch_failure_leaves_hosts_untouched() {
    let (world, port, token) = agreed(&two_old_hosts()).await;
    watchdog_due_soon(&port);
    let before = marks(&world, &HOSTS);

    let err = run(&port, &marked(), Some(token), Err("could not start Update.exe".into()))
        .await
        .expect_err("the error is the launch's");

    assert_eq!(err, "could not start Update.exe");
    for (host, frames) in HOSTS.iter().zip(instances_closed(&world, &before)) {
        assert_eq!(frames, ["List", "List"], "{host}: looked at, never disarmed, shut down or closed");
    }
    assert_eq!(
        events(&port),
        ["siblings", "flush_windows", "flush_history", "siblings", "launch", "abort_flush"]
    );
    assert_eq!(port.0.full.app_exits.load(Ordering::SeqCst), 0);
    assert!(port.table().begin(HostChannel::Primary).is_ok(), "admission reopened");
    std::thread::sleep(Duration::from_millis(250));
    assert!(port.0.full.hard_exits.lock().unwrap().is_empty(), "no watchdog was started for an update that did not start");
}

/// A watchdog that would fire within the test if one were started.
fn watchdog_due_soon(port: &FakePort) {
    *port.0.full.watchdog_after.lock().unwrap() = Duration::from_millis(50);
}

#[tokio::test(start_paused = true)]
async fn updater_not_alive_before_closure_does_not_close_shells() {
    let (world, port, token) = agreed(&two_old_hosts()).await;
    watchdog_due_soon(&port);
    port.0.full.updater_dead.store(true, Ordering::SeqCst);
    let before = marks(&world, &HOSTS);

    let err = run(&port, &marked(), Some(token), Ok(())).await.expect_err("nothing can be updated");

    assert!(err.contains("updater"), "{err}");
    for (host, frames) in HOSTS.iter().zip(instances_closed(&world, &before)) {
        assert_eq!(frames, ["List", "List"], "{host}: its shells were not closed for an update that is not coming");
    }
    let events = events(&port);
    assert_eq!(events.last().map(String::as_str), Some("abort_flush"), "{events:?}");
    assert!(events.contains(&"updater_alive".to_string()));
    assert!(!events.iter().any(|e| e.starts_with("close_hosts") || e == "exit"), "{events:?}");
    assert!(port.table().begin(HostChannel::Primary).is_ok(), "admission reopened");
    std::thread::sleep(Duration::from_millis(250));
    assert!(port.0.full.hard_exits.lock().unwrap().is_empty(), "and no watchdog will end the process later");
}

#[tokio::test(start_paused = true)]
async fn host_close_failure_after_launch_still_exits() {
    let (world, port, token) = agreed(&[
        ("h1", HostSpec { no_release_ack: true, ..holding(&[("k1", 11)]) }),
        ("h2", holding(&[("k2", 12)])),
    ])
    .await;
    let before = marks(&world, &HOSTS);

    let out = run(&port, &marked(), Some(token), Ok(())).await.unwrap();

    assert!(matches!(out, FullRun::Exited), "a host that does not answer does not keep the app open: {out:?}");
    assert_eq!(port.0.full.app_exits.load(Ordering::SeqCst), 1);
    let closed = instances_closed(&world, &before);
    assert_eq!(closed[2], ["List", "List", "Disarm", "Shutdown", "Eof"], "the healthy host was released in full");
    assert!(closed[1].contains(&"Disarm") && closed[1].contains(&"Shutdown"), "the silent one was asked: {:?}", closed[1]);
    assert_eq!(closed[1].last(), Some(&"Eof"), "and its connection was closed anyway: {:?}", closed[1]);
    assert_eq!(events(&port).last().map(String::as_str), Some("exit"));
}

#[tokio::test(start_paused = true)]
async fn a_host_gets_its_bound_to_acknowledge_and_no_more() {
    let (world, port) = adopted(&[("h1", HostSpec { no_release_ack: true, ..HostSpec::default() })]).await;
    let from = marks(&world, &[CURRENT, "h1"]);
    let started = Instant::now();

    let report = exit_hosts_within(&port, Some(CloseBounds { per_host: secs(1), total: secs(20) })).await;
    tokio::time::sleep(SEC).await;

    assert!(started.elapsed() < secs(3), "unbounded it would have retried for ~5 s: {:?}", started.elapsed());
    let silent: Vec<_> = report.problems().collect();
    assert_eq!(silent.len(), 1, "{:?}", report.hosts);
    assert!(silent[0].name.contains("h1") && silent[0].problem.as_deref().unwrap().contains("in time"), "{silent:?}");
    assert_eq!(since(&world, "h1", from[1]).last(), Some(&"Eof"), "its connection was closed after the bound");
    assert_eq!(since(&world, CURRENT, from[0]), ["Disarm", "Shutdown", "Eof"], "the others are not delayed by it");
}

#[tokio::test(start_paused = true)]
async fn closing_is_cut_off_at_the_total_bound() {
    let (world, port) = adopted(&[]).await;
    undiscovered_until_now(&world, &port, "slow", HostSpec { connect_delay: secs(60), ..HostSpec::default() });
    let from = marks(&world, &[CURRENT]);
    let started = Instant::now();

    let report = exit_hosts_within(&port, Some(CloseBounds { per_host: secs(1), total: secs(2) })).await;

    assert!(started.elapsed() >= secs(2) && started.elapsed() < secs(3), "{:?}", started.elapsed());
    assert!(
        report.problems().any(|h| h.problem.as_deref().is_some_and(|p| p.contains("within 2 s"))),
        "the cut-off is reported: {:?}",
        report.hosts
    );
    assert_eq!(since(&world, CURRENT, from[0]), ["Disarm", "Shutdown", "Eof"]);
    assert!(world.kinds("slow").is_empty(), "nothing reached it");
}

// ---- the watchdog --------------------------------------------------------------------

/// The closing stalls the runtime's only thread for 400 ms, as a hung runtime
/// would; the watchdog is due 100 ms after the updater started.
async fn run_with_a_stalled_runtime() -> (FakePort, Vec<String>) {
    let (_world, port, token) = agreed(&[("h1", holding(&[("k1", 11)]))]).await;
    quick(&port, Duration::from_millis(100));
    *port.0.full.close_stalls.lock().unwrap() = Duration::from_millis(400);
    let out = run(&port, &marked(), Some(token), Ok(())).await.unwrap();
    assert!(matches!(out, FullRun::Exited), "{out:?}");
    let events = events(&port);
    (port, events)
}

#[tokio::test(flavor = "current_thread")]
async fn watchdog_exits_when_closure_hangs() {
    let (port, events) = run_with_a_stalled_runtime().await;

    let at = |what: &str| events.iter().position(|e| e == what).unwrap_or_else(|| panic!("{what} in {events:?}"));
    assert_eq!(port.0.full.hard_exits.lock().unwrap().len(), 1);
    assert!(
        at("close_hosts:start") < at("hard_exit") && at("hard_exit") < at("close_hosts:end"),
        "the process was ended while the closing was still stuck, not after it: {events:?}"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn watchdog_runs_on_a_dedicated_os_thread_not_the_runtime() {
    let test_thread = std::thread::current().id();

    let (port, _events) = run_with_a_stalled_runtime().await;

    let exits = port.0.full.hard_exits.lock().unwrap();
    assert_eq!(exits.len(), 1);
    assert!(!exits[0].on_runtime, "a task on a stalled runtime cannot be relied on to run");
    assert_ne!(exits[0].thread, test_thread, "not the thread the runtime was stuck on");
    assert_eq!(exits[0].thread_name.as_deref(), Some("update-watchdog"));
}

// ---- availability ---------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn full_ignores_in_process_refusal_but_keeps_sibling_refusal() {
    let (_world, port) = adopted(&two_old_hosts()).await;
    port.0.full.local_shells.store(2, Ordering::SeqCst);
    let in_process = || Err("cannot hot-swap: some terminals are in-process".to_string());

    // An offload still refuses what it always refused.
    let err = availability(&port, Marker::Offload, in_process).unwrap_err();
    assert!(err.contains("in-process"), "{err}");

    // A full update does not ask.
    let full = availability(&port, Marker::Full, in_process).unwrap();
    assert_eq!((full.mode, full.reasons), (UpdateMode::Full, vec![FullReason::Marker]));
    port.set_exe_origin("h1", Some(true));
    let forced = availability(&port, Marker::Offload, in_process).unwrap();
    assert_eq!(forced.mode, UpdateMode::Full, "a host that would be killed makes an unmarked release full");
    assert!(matches!(&forced.reasons[..], [FullReason::HostInPayload(host)] if host.contains("h1")), "{:?}", forced.reasons);

    // The one refusal that still applies.
    port.0.full.siblings.lock().unwrap().push(instance("rel.alt", 41));
    let err = availability(&port, Marker::Full, || Ok(())).unwrap_err();
    assert!(err.contains("rel.alt (pid 41)"), "{err}");
}

#[tokio::test(start_paused = true)]
async fn full_availability_is_reachable_with_a_disconnected_primary() {
    let (_world, port) = adopted(&[]).await;
    port.drop_current();

    let full = availability(&port, Marker::Full, || Err("pty-host not connected".to_string())).unwrap();

    assert_eq!(full.mode, UpdateMode::Full);
    assert_eq!(full.reasons[0], FullReason::Marker);
    assert!(
        matches!(&full.reasons[1..], [FullReason::HostOriginUnknown(host)] if host.contains(CURRENT)),
        "a host nothing can be asked about is also said to run from somewhere unknown: {:?}",
        full.reasons
    );
}

// ---- what the renderer sees -----------------------------------------------------------------

#[test]
fn the_confirmation_and_its_answer_cross_the_wire_in_the_shape_the_renderer_reads() {
    let asked = Confirmation {
        version: "2.0.0".into(),
        shell_count: 3,
        unknown: true,
        reasons: vec![FullReason::Marker, FullReason::HostInPayload("terminal host h1".into())],
    };
    let reasons = json!([{ "kind": "marker" }, { "kind": "hostInPayload", "host": "terminal host h1" }]);
    let needs = serde_json::to_value(UpdateRestart::NeedsConfirmation(asked.clone())).unwrap();
    assert_eq!(
        needs,
        json!({ "outcome": "needsConfirmation", "version": "2.0.0", "shellCount": 3, "unknown": true, "reasons": reasons })
    );
    assert_eq!(serde_json::to_value(UpdateRestart::Started).unwrap(), json!({ "outcome": "started" }));

    let token: ConfirmToken = serde_json::from_value(
        json!({ "targetVersion": "2.0.0", "shellCount": 3, "unknown": true, "reasons": reasons }),
    )
    .unwrap();
    assert_eq!(token_of(&asked), token, "what the renderer sends back is what it was asked");

    let availability = crate::state::Availability { mode: UpdateMode::Full, reasons: asked.reasons };
    assert_eq!(
        serde_json::to_value(availability).unwrap(),
        json!({ "mode": "full", "reasons": reasons })
    );
}

#[test]
fn a_full_update_has_no_way_to_arm_a_host() {
    let source = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/state/update_full.rs"))
        .unwrap();
    let production = crate::state::source_scan::without_test_modules(&source);
    assert!(
        !production.contains("arm_detach") && !production.contains("begin_update(") && !production.contains("begin_offload("),
        "the shells are meant to end: this module must not arm, nor take an arming hold"
    );
}
