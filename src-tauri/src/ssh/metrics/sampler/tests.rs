use super::*;
use crate::ssh::{
    session::{LaunchState, SessionState},
    tests::{hop, wait_state, Fixture, Server},
};
use russh::{server, ChannelId};
use serde_json::{json, Value};
use std::{collections::VecDeque, fmt::Write, sync::atomic::{AtomicUsize, Ordering::SeqCst}};
use tokio::time::{sleep, timeout};

mod reader;
mod scheduler;

const A: &str = "tm-a";
const B: &str = "tm-b";
const WAIT: Duration = Duration::from_secs(8);
const WIRE_STDOUT_CAP: usize = 1_048_576;
const WIRE_STDERR_CAP: usize = 16_384;

#[derive(Default)]
struct Capture {
    events: Mutex<Vec<(&'static str, Value)>>,
    changed: Notify,
}

impl EventSink for Capture {
    fn emit(&self, name: &'static str, event: MetricsEvent<'_>) {
        self.events.lock().push((name, serde_json::to_value(event).unwrap()));
        self.changed.notify_one();
    }
}

impl Capture {
    async fn event(&self, name: &str, index: usize) -> Value {
        timeout(WAIT, async {
            loop {
                if let Some(value) = self.events.lock().iter()
                    .filter(|(kind, _)| *kind == name).nth(index).map(|(_, v)| v.clone())
                {
                    return value;
                }
                self.changed.notified().await;
            }
        }).await.unwrap_or_else(|_| panic!("missing {name}[{index}]: {:?}", self.events.lock()))
    }
}

#[derive(Clone, Default)]
enum Reply {
    #[default]
    Good,
    Nfs(u8),
    WatchdogWithChild { exit: u8, ping: Arc<Notify>, pong: Arc<Notify> },
    Hang,
    Gate(Arc<Notify>),
    Exit(u32),
    BadBytes(Vec<u8>),
    NoAck,
    NoStatus,
    NoClose,
    AtCaps,
    Flood { stdout: usize, stderr: usize },
}

#[derive(Default)]
struct Wire {
    starts: Mutex<Vec<Instant>>,
    changed: Notify,
    replies: Mutex<VecDeque<Reply>>,
    closed: Arc<crate::ssh::tests::Counters>,
    pumps: Arc<AtomicUsize>,
}

impl Wire {
    fn count(&self) -> usize { self.starts.lock().len() }

    async fn started(&self, count: usize) -> Instant {
        timeout(WAIT, async {
            loop {
                if let Some(at) = self.starts.lock().get(count - 1).copied() {
                    return at;
                }
                self.changed.notified().await;
            }
        }).await.expect("real collector exec request")
    }

    fn reply(&self, ch: ChannelId, command: &[u8], session: &mut server::Session, host: &str) -> Result<(), russh::Error> {
        let command = std::str::from_utf8(command).unwrap();
        let (prefix, suffix) = command.rsplit_once(" || /bin/sh -c 'exit 125'").unwrap();
        assert!(suffix.is_empty());
        let (_, nonce) = prefix.rsplit_once(' ').unwrap();
        assert_eq!(command, super::super::encode(nonce, super::super::COLLECT).unwrap());
        let index = {
            let mut starts = self.starts.lock();
            let index = starts.len() as u64;
            starts.push(Instant::now());
            index
        };
        self.changed.notify_one();
        let reply = self.replies.lock().pop_front().unwrap_or_default();
        if !matches!(reply, Reply::NoAck) {
            session.channel_success(ch)?;
        }
        let nfs = match &reply {
            Reply::Nfs(exit) | Reply::WatchdogWithChild { exit, .. } => *exit,
            _ => 0,
        };
        let valid = frame(nonce, host, index, nfs);
        match &reply {
            Reply::Hang => return Ok(()),
            Reply::WatchdogWithChild { ping, pong, .. } => {
                let (ping, pong) = (ping.clone(), pong.clone());
                tokio::spawn(async move {
                    // Model child work independent of the exec channel lifetime.
                    ping.notified().await;
                    pong.notify_one();
                });
                session.data(ch, valid)?;
            }
            Reply::Gate(release) => {
                let release = release.clone();
                let handle = session.handle();
                tokio::spawn(async move {
                    release.notified().await;
                    if handle.data(ch, valid).await.is_ok() {
                        let _ = handle.exit_status_request(ch, 0).await;
                        let _ = handle.eof(ch).await;
                        let _ = handle.close(ch).await;
                    }
                });
                return Ok(());
            }
            Reply::Flood { stdout, stderr } => {
                let (stdout, stderr) = (*stdout, *stderr);
                let handle = session.handle();
                let counters = self.closed.clone();
                let closed = counters.closed_channels.load(SeqCst);
                let active = self.pumps.clone();
                active.fetch_add(1, SeqCst);
                tokio::spawn(async move {
                    let pipe = |mut bytes: usize, stderr| {
                        let handle = handle.clone();
                        let counters = counters.clone();
                        async move {
                            while bytes != 0 && counters.closed_channels.load(SeqCst) == closed {
                                let chunk = bytes.min(8191);
                                let result = if stderr {
                                    handle.extended_data(ch, 1, vec![b'e'; chunk]).await
                                } else {
                                    handle.data(ch, vec![b'o'; chunk]).await
                                };
                                if result.is_err() { break; }
                                bytes -= chunk;
                            }
                        }
                    };
                    tokio::join!(pipe(stdout, false), pipe(stderr, true));
                    active.fetch_sub(1, SeqCst);
                    // No exit or close: returning early requires the real incremental caps.
                });
                return Ok(());
            }
            Reply::BadBytes(bytes) => {
                // An otherwise valid envelope. Lossy decoding or stripping
                // the bad preamble would incorrectly admit this sample.
                let mut data = bytes.clone();
                data.push(b'\n');
                data.extend(valid);
                session.data(ch, data)?;
            }
            Reply::AtCaps => {
                let padding = WIRE_STDOUT_CAP - valid.len();
                let mut stdout: Vec<_> = (1..=padding)
                    .map(|i| if i % 256 == 0 || i == padding { b'\n' } else { b'b' })
                    .collect();
                stdout.extend(valid);
                for chunk in stdout.chunks(8191) {
                    session.data(ch, chunk.to_vec())?;
                }
                session.extended_data(ch, 1, vec![b'e'; WIRE_STDERR_CAP])?;
            }
            _ => session.data(ch, valid)?,
        }
        if !matches!(reply, Reply::NoStatus) {
            session.exit_status_request(ch, if let Reply::Exit(code) = reply { code } else { 0 })?;
        }
        session.eof(ch)?;
        if !matches!(reply, Reply::NoClose) {
            session.close(ch)?;
        }
        Ok(())
    }
}

// Synthetic framed readings generated from the actual request nonce. Each
// interval advances remote uptime by 2 s, busy/idle by 10/30, RX/TX by 30/60.
fn frame(nonce: &str, host: &str, index: u64, nfs: u8) -> Vec<u8> {
    let prefix = format!("__TFM_{nonce}_");
    let mut body = format!("{prefix}V1_BEGIN__\n");
    let stat = format!("cpu {} 0 0 {} 0 0 0 0\nbtime 1000", 10 + 10 * index, 100 + 30 * index);
    let net = format!("eth0: {} 0 0 0 0 0 0 0 {} 0 0 0 0 0 0 0", 100 + 30 * index, 200 + 60 * index);
    let uptime = (10 + 2 * index).to_string();
    for (key, data, exit) in [
        ("platform", "Linux", 0), ("hostname", host, 0), ("architecture", "arm64", 0),
        ("stat", &stat, 0), ("meminfo", "MemTotal: 1000 kB\nMemAvailable: 750 kB", 0),
        ("netdev", &net, 0), ("uptime", &uptime, 0),
        ("bootId", "4ddb381e-fa3b-403a-b6b3-ea87b4a45089", 0), ("cpuinfo", "processor : 0", 0),
        ("nproc", "4", 0), ("loadavg", "1.25 1.00 0.75 1/10 100", 0),
        ("who", "zoe pts/0\nalex pts/1\nzoe pts/2", 0),
        ("dfLocal", "Filesystem Type 1024-blocks Used Available Capacity Mounted on\n/dev/test ext4 100 20 75 22% /", 0),
        ("dfNfs", "", nfs), ("mounts", "/dev/test / ext4 rw 0 0", 0),
        ("osRelease", "NAME='Test Linux'\nVERSION_ID=12", 0),
    ] {
        writeln!(body, "{prefix}SECTION_{key}_BEGIN__\n{data}\n{prefix}SECTION_{key}_END_{exit}__").unwrap();
    }
    writeln!(body, "{prefix}V1_END__").unwrap();
    body.into_bytes()
}

fn server(seed: u8, user: &str, host: &'static str, replies: impl IntoIterator<Item = Reply>) -> (Server, Arc<Wire>) {
    let mut server = Server::new(seed, user);
    let wire = Arc::new(Wire {
        replies: Mutex::new(replies.into_iter().collect()),
        closed: server.counters.clone(),
        ..Wire::default()
    });
    let copy = wire.clone();
    server.exec_fixture = Some(Arc::new(move |ch, command, session| copy.reply(ch, command, session, host)));
    (server, wire)
}

fn rig(replies: impl IntoIterator<Item = Reply>) -> (Fixture, Arc<Wire>, Arc<Capture>, Arc<SamplerRegistry>) {
    let (server, wire) = server(1, "alice", "sample-host", replies);
    let f = Fixture::new(server, vec![hop("c-a", "alice")], true);
    let capture = Arc::new(Capture::default());
    let sampler = Arc::new(SamplerRegistry::new(f.registry.clone(), capture.clone()));
    (f, wire, capture, sampler)
}

async fn connect(f: &Fixture, id: &str) -> u64 {
    let opened = f.registry.open(id, "c-a", false, || true).unwrap();
    let prompt = wait_state(&f.registry, id, false, SessionState::NeedsSecret).await;
    f.registry.submit_secret(id, false, Some(opened.generation), prompt.prompt_id.as_deref(), f.server.password.clone(), false).unwrap();
    f.registry.on_launch_lifecycle(id, opened.generation, 1, LaunchState::Running, None).unwrap();
    wait_state(&f.registry, id, false, SessionState::Connected).await.generation
}

async fn reconnect(f: &Fixture) -> u64 {
    f.registry.close(A, false, None).unwrap();
    connect(f, A).await
}

fn admit(worker: &Terminal, f: &Fixture, capture: &Capture, wall: u64) -> Tick {
    let Action::Collect(tick) = worker.plan_tick(&f.registry, capture, Instant::now(), || wall) else {
        panic!("expected eligible tick");
    };
    tick
}

async fn deliver(worker: &Terminal, f: &Fixture, capture: &Capture, tick: &Tick) {
    let (result, nonce) = collect(&f.registry, &worker.id, tick.lease.clone()).await;
    worker.finish(&f.registry, capture, tick, classify(&result, &nonce)).unwrap();
}

fn assert_rates(value: &Value, percent: Value, up: Value, down: Value) {
    assert_eq!(value["metrics"]["cpu"]["percent"], percent);
    assert_eq!(value["metrics"]["netUp"]["bytesPerSecond"], up);
    assert_eq!(value["metrics"]["netDown"]["bytesPerSecond"], down);
    for metric in ["cpu", "netUp", "netDown"] {
        assert_eq!(value["metrics"][metric]["available"], true);
    }
}

fn assert_warming(value: &Value) { assert_rates(value, Value::Null, Value::Null, Value::Null); }
fn assert_advancing(value: &Value) { assert_rates(value, json!(25.0), json!(30.0), json!(15.0)); }

#[tokio::test]
async fn cached_visibility_cannot_admit_a_tick_without_a_current_census() {
    let (f, wire, events, _) = rig([]);
    connect(&f, A).await;
    let terminal = Terminal::new(A);
    terminal.set_eligible(true).unwrap();
    let at = Instant::now();
    assert!(matches!(terminal.plan_checked(&f.registry, &*events, at, false, wall_now_ms), Action::Wait(Some(_))));
    assert_eq!(wire.count(), 0);
    let Action::Collect(tick) = terminal.plan_checked(&f.registry, &*events, at, true, wall_now_ms) else {
        panic!("fresh census must allow the eligible tick");
    };
    deliver(&terminal, &f, &events, &tick).await;
    assert_eq!(wire.count(), 1);
    f.registry.shutdown().await;
}

#[tokio::test]
async fn two_consumers_one_terminal_have_one_exec_worker() {
    let (f, wire, events, sampler) = rig([]);
    connect(&f, A).await;
    connect(&f, B).await;
    let floor_a = sampler.fence(A).unwrap().sample_floor;
    sampler.set_eligible(A, true).unwrap();
    let original = sampler.existing(A).unwrap();
    let second_floor_a = sampler.fence(A).unwrap().sample_floor;
    sampler.set_eligible(A, true).unwrap();
    let floor_b = sampler.fence(B).unwrap().sample_floor;
    sampler.set_eligible(B, true).unwrap();
    assert!(second_floor_a > floor_a);
    let a = events.event(SAMPLE, 0).await;
    let b = events.event(SAMPLE, 1).await;
    let by_id = HashMap::from([(a["terminalId"].as_str().unwrap(), a["sampledAt"].as_u64().unwrap()),
        (b["terminalId"].as_str().unwrap(), b["sampledAt"].as_u64().unwrap())]);
    assert_eq!(by_id.len(), 2);
    assert!(by_id[A] > floor_a && by_id[B] > floor_b);
    assert_eq!(wire.count(), 2);
    {
        let workers = sampler.workers.lock();
        assert_eq!(workers.len(), 2);
        assert_eq!(workers[A].id, A);
        assert_eq!(workers[B].id, B);
        assert!(Arc::ptr_eq(&workers[A], &original));
        assert!(!Arc::ptr_eq(&workers[A], &workers[B]));
    }
    f.registry.shutdown().await;
}

#[tokio::test]
async fn slow_exec_skips_ticks_never_bursts_or_overlaps() {
    let (f, _, events, _) = rig([]);
    connect(&f, A).await;
    tokio::time::pause(); // Only the cadence test substitutes time/exec duration.
    let worker = Arc::new(Terminal::new(A));
    worker.set_eligible(true).unwrap();
    let simulated = Arc::new(Mutex::new(VecDeque::from([
        (3000, SessionError::OutputTooLarge), (5000, SessionError::TimedOut),
        (1375, SessionError::Cancelled), (2401, SessionError::OutputTooLarge),
        (0, SessionError::OutputTooLarge),
    ])));
    let (started, mut starts) = tokio::sync::mpsc::unbounded_channel();
    let active = Arc::new(AtomicUsize::new(0));
    let runner = {
        let (worker, sessions, events, active) = (worker.clone(), f.registry.clone(), events.clone(), active.clone());
        tokio::spawn(async move {
            worker.run(&sessions, &*events, None, |_| {
                let (ms, error) = simulated.lock().pop_front().expect("unexpected catch-up exec");
                let (active, started) = (active.clone(), started.clone());
                async move {
                    assert_eq!(active.fetch_add(1, SeqCst), 0, "overlapping execs");
                    started.send(Instant::now()).unwrap();
                    sleep(Duration::from_millis(ms)).await;
                    assert_eq!(active.fetch_sub(1, SeqCst), 1);
                    (error.into(), String::new())
                }
            }).await;
        })
    };
    let first = timeout(WAIT, starts.recv()).await.unwrap().unwrap();
    let second = timeout(WAIT, starts.recv()).await.unwrap().unwrap();
    assert_eq!((second - first).as_millis(), 4000);
    events.event(CONTROL, 0).await; // The five-second timeout really disarms ticks.
    worker.fence(&f.registry, &*events, true).unwrap();
    for ms in [10000, 12000, 16000] {
        let actual = timeout(WAIT, starts.recv()).await.unwrap().unwrap();
        assert_eq!((actual - first).as_millis(), ms);
    }
    worker.retire();
    runner.await.unwrap();
    assert_eq!(active.load(SeqCst), 0);
    f.registry.shutdown().await;
}

#[tokio::test]
async fn disconnected_cannot_exec_or_emit_even_when_completion_is_late() {
    let release = Arc::new(Notify::new());
    let (f, wire, events, sampler) = rig([Reply::Good, Reply::Gate(release.clone())]);
    let (_, lease) = f.connected().await;
    let floor = sampler.fence(A).unwrap().sample_floor;
    sampler.set_eligible(A, true).unwrap();
    assert!(events.event(SAMPLE, 0).await["sampledAt"].as_u64().unwrap() > floor);
    wire.started(2).await;
    f.registry.disconnect(A, "ended");
    assert!(matches!(f.registry.lease(A), Err(SessionError::NotConnected)));
    let (outcome, _) = collect(&f.registry, A, lease).await;
    assert_eq!(outcome.result, Err(SessionError::NotConnected));
    sleep(CADENCE + Duration::from_millis(100)).await;
    // The generation cancelled and joined the real reader; no next work or late telemetry.
    assert_eq!(wire.count(), 2);
    assert_eq!(events.events.lock().len(), 1);
    release.notify_one();
    reconnect(&f).await;
    let fence = sampler.fence(A).unwrap();
    let fresh = events.event(SAMPLE, 1).await;
    assert!(fresh["sampledAt"].as_u64().unwrap() > fence.sample_floor);
    assert_warming(&fresh);
    assert_eq!(wire.count(), 3);
    f.registry.shutdown().await;
}

#[tokio::test]
async fn lease_recheck_blocks_emit_before_transition_observer_runs() {
    let (f, wire, events, _) = rig([]);
    let first_generation = connect(&f, A).await;
    // Drive exactly the worker's admission/completion paths with the observer
    // held; the old exec result is genuinely complete, not a Cancelled stub.
    let observer = f.registry.subscribe_transitions(A).unwrap();
    let worker = Terminal::new(A);
    worker.set_eligible(true).unwrap();
    let first = admit(&worker, &f, &events, 100);
    deliver(&worker, &f, &events, &first).await;
    let late = admit(&worker, &f, &events, 101);
    let (result, nonce) = collect(&f.registry, A, late.lease.clone()).await;
    assert!(result.result.is_ok());
    f.registry.disconnect(A, "ended before observer");
    assert!(observer.has_changed().unwrap());
    assert!(matches!(f.registry.lease(A), Err(SessionError::NotConnected)));
    assert_eq!(worker.state.lock().generation, Some(first_generation));
    assert_eq!(worker.finish(&f.registry, &*events, &late, classify(&result, &nonce)), Err(SessionError::NotConnected));
    assert_eq!(events.events.lock().len(), 1);
    let generation = reconnect(&f).await;
    assert!(generation > first_generation);
    let fresh = admit(&worker, &f, &events, 102);
    deliver(&worker, &f, &events, &fresh).await;
    assert_eq!(worker.finish(&f.registry, &*events, &late, classify(&result, &nonce)), Err(SessionError::NotConnected));
    assert_eq!(events.events.lock().len(), 3);
    assert_warming(&events.event(SAMPLE, 1).await);
    assert_eq!(wire.count(), 3);
    f.registry.shutdown().await;
}

#[tokio::test]
async fn watch_floor_survives_backward_wall_clock_and_late_event() {
    let (f, _, events, _) = rig([]);
    connect(&f, A).await;
    let worker = Terminal::new(A);
    worker.set_eligible(true).unwrap();
    let old = admit(&worker, &f, &events, 1000);
    let fence = worker.fence_at(&f.registry, &*events, false, || 50).unwrap();
    deliver(&worker, &f, &events, &old).await;
    let fresh = admit(&worker, &f, &events, 51);
    deliver(&worker, &f, &events, &fresh).await;
    let late = events.event(SAMPLE, 0).await;
    let live = events.event(SAMPLE, 1).await;
    assert_eq!((late["sampledAt"].as_u64(), fence.sample_floor, live["sampledAt"].as_u64()), (Some(1000), 1001, Some(1002)));
    let accept = |event: &Value| event["sampledAt"].as_u64().unwrap() > fence.sample_floor;
    assert!(!accept(&late) && accept(&live));
    assert_advancing(&live); // Fence renewal did not clear the shared baseline.
    f.registry.shutdown().await;
}

#[tokio::test]
async fn resume_clears_baseline_and_samples_within_two_seconds() {
    let (f, wire, events, sampler) = rig([]);
    let generation = connect(&f, A).await;
    sampler.set_eligible(A, true).unwrap();
    assert_warming(&events.event(SAMPLE, 0).await);
    assert_advancing(&events.event(SAMPLE, 1).await);
    let before = Instant::now();
    let fence = sampler.resume(A).unwrap();
    assert_eq!(events.event(CONTROL, 0).await, json!({"terminalId":A,"generation":generation,"pauseSeq":1,"pausedReason":null}));
    let start = wire.started(3).await;
    // Allow local scheduler jitter; the virtual-time test pins the exact boundary.
    assert!(start - before <= CADENCE + Duration::from_millis(100));
    let first = events.event(SAMPLE, 2).await;
    assert!(first["sampledAt"].as_u64().unwrap() > fence.sample_floor);
    assert_warming(&first);
    assert_advancing(&events.event(SAMPLE, 3).await);
    f.registry.shutdown().await;
}

#[tokio::test]
async fn metrics_emit_name_and_complete_payload_are_exact() {
    let (f, wire, events, _) = rig([Reply::Good, Reply::Good, Reply::Exit(7)]);
    connect(&f, A).await;
    let worker = Terminal::new(A);
    worker.set_eligible(true).unwrap();
    let tick = admit(&worker, &f, &events, 123_456);
    deliver(&worker, &f, &events, &tick).await;
    assert_eq!(events.events.lock()[0], ("ssh-metrics:sample", json!({
        "terminalId": A, "sampledAt": 123456, "metrics": {
            "host": {"available":true,"hostname":"sample-host","os":{"available":true,"name":"Test Linux 12"},"architecture":{"available":true,"name":"arm64"}},
            "cpu":{"available":true,"percent":null,"cores":{"available":true,"count":4},"load1":{"available":true,"value":1.25}},
            "ram":{"available":true,"usedBytes":256000,"totalBytes":1024000,"percent":25.0},
            "netUp":{"available":true,"bytesPerSecond":null}, "netDown":{"available":true,"bytesPerSecond":null},
            "uptime":{"available":true,"seconds":10.0}, "users":{"available":true,"count":3,"names":["alex","zoe"]},
            "partitions":{"available":true,"mounts":[{"source":"/dev/test","mountPoint":"/","fsType":"ext4","totalBytes":102400,"usedBytes":20480,"availableBytes":76800,"usedPercent":22}]},
            "nfs":{"available":true,"mounts":[]}
        }
    })));
    let distinct = admit(&worker, &f, &events, 123_457);
    deliver(&worker, &f, &events, &distinct).await;
    let sample = events.event(SAMPLE, 1).await;
    assert_eq!(sample["metrics"]["uptime"]["seconds"], json!(12.0));
    assert_advancing(&sample);
    let failed = admit(&worker, &f, &events, 123_458);
    deliver(&worker, &f, &events, &failed).await;
    let failure = events.event(SAMPLE, 2).await;
    assert_eq!(failure["sampledAt"], 123458);
    assert_unavailable(&failure, "Metrics command failed"); // Valid framed stdout, nonzero exec status.
    assert_eq!(wire.count(), 3);
    f.registry.shutdown().await;
}

fn assert_unavailable(sample: &Value, reason: &str) {
    let metrics = sample["metrics"].as_object().unwrap();
    let keys = ["host", "cpu", "ram", "netUp", "netDown", "uptime", "users", "partitions", "nfs"];
    assert_eq!(metrics.len(), keys.len());
    for key in keys {
        assert_eq!(metrics[key], json!({"available":false,"reason":reason}), "{key}");
    }
}

#[tokio::test]
async fn probe_never_watches_or_execs_metrics() {
    let (f, wire, events, sampler) = rig([]);
    let probe = f.registry.probe("c-a").unwrap();
    let prompt = wait_state(&f.registry, &probe, true, SessionState::NeedsSecret).await;
    f.registry.submit_secret(&probe, true, Some(prompt.generation), prompt.prompt_id.as_deref(), f.server.password.clone(), false).unwrap();
    wait_state(&f.registry, &probe, true, SessionState::Connected).await;
    assert_eq!(sampler.fence(&probe), Err(SessionError::NotConnected));
    assert_eq!(sampler.set_eligible(&probe, true), Err(SessionError::NotConnected));
    assert_eq!(sampler.resume(&probe), Err(SessionError::NotConnected));
    assert!(sampler.workers.lock().is_empty());
    assert_eq!(wire.count(), 0);
    assert!(events.events.lock().is_empty());
    connect(&f, A).await;
    sampler.set_eligible(A, true).unwrap();
    assert_eq!(events.event(SAMPLE, 0).await["terminalId"], A);
    assert_eq!(wire.count(), 1);
    f.registry.shutdown().await;
}

#[tokio::test]
async fn metrics_exec_samples_final_target_through_jump() {
    let (mut jump, bastion) = server(1, "bastion", "bastion-gauge", []);
    let (target, final_host) = server(2, "destination", "target-gauge", []);
    jump.target = Some(Box::new(target));
    let mut jump_hop = hop("jump", "bastion");
    jump_hop.host = "jump.test".into();
    let f = Fixture::new(jump, vec![jump_hop, hop("c-a", "destination")], true);
    let opened = f.registry.open(A, "c-a", false, || true).unwrap();
    let first = wait_state(&f.registry, A, false, SessionState::NeedsSecret).await;
    f.registry.submit_secret(A, false, Some(opened.generation), first.prompt_id.as_deref(), "password-bastion".into(), false).unwrap();
    let second = timeout(WAIT, async {
        loop {
            let v = f.registry.state(A, false).unwrap();
            assert_ne!(v.state, SessionState::Error, "{v:?}");
            if v.state == SessionState::NeedsSecret && v.prompt_id != first.prompt_id { break v; }
            sleep(Duration::from_millis(2)).await;
        }
    }).await.unwrap();
    f.registry.submit_secret(A, false, Some(opened.generation), second.prompt_id.as_deref(), "password-destination".into(), false).unwrap();
    f.registry.on_launch_lifecycle(A, opened.generation, 1, LaunchState::Running, None).unwrap();
    wait_state(&f.registry, A, false, SessionState::Connected).await;
    let events = Arc::new(Capture::default());
    let sampler = SamplerRegistry::new(f.registry.clone(), events.clone());
    sampler.set_eligible(A, true).unwrap();
    assert_eq!(events.event(SAMPLE, 0).await["metrics"]["host"]["hostname"], "target-gauge");
    assert_eq!((bastion.count(), final_host.count()), (0, 1));
    assert_eq!(*f.server.counters.direct_addresses.lock(), [("target.test".to_owned(), 22)]);
    f.registry.shutdown().await;
}

#[tokio::test]
async fn sync_eligibility_starts_worker_from_std_thread_without_tokio() {
    let (f, wire, events, sampler) = rig([]);
    connect(&f, A).await;
    let _sampler = std::thread::spawn(move || {
        assert!(tokio::runtime::Handle::try_current().is_err());
        sampler.set_eligible(A, true).unwrap();
        sampler
    }).join().unwrap();
    // Keep the owner alive until the fallback runtime produces a real sample.
    // (The registry is returned from the thread, not dropped there.)
    assert_eq!(events.event(SAMPLE, 0).await["terminalId"], A);
    assert_eq!(wire.count(), 1);
    f.registry.shutdown().await;
}
