use super::*;
use crate::{
    commands::ssh_session::{open_core, reconnect_core},
    ssh::{
        metrics::sampler::{EventSink as MetricsEventSink, MetricsEvent},
        session::*,
        tests::{hop, wait_state, Fixture, MemoryStreams, Server},
    },
    state::{Completion, PaneReply, PaneResult, ShellStage, StagedShell},
};
use serde_json::{json, Value};
use std::{
    fmt::Write,
    sync::atomic::{AtomicUsize, Ordering::SeqCst},
};
use tokio::{
    sync::Notify,
    time::{sleep, timeout},
};

const A: &str = "tm-a";
const B: &str = "tm-b";
const C: &str = "tm-c";
const WAIT: Duration = Duration::from_secs(super::super::sampler::CADENCE.as_secs() * 2 + 8);
const QUIET: Duration =
    Duration::from_millis(super::super::sampler::CADENCE.as_millis() as u64 + 200);

#[derive(Default)]
struct Events(Mutex<Vec<(&'static str, Value)>>);
impl MetricsEventSink for Events {
    fn emit(&self, name: &'static str, payload: MetricsEvent<'_>) {
        self.0
            .lock()
            .push((name, serde_json::to_value(payload).unwrap()));
    }
}
impl Events {
    fn values(&self, name: &str, leaf: &str) -> Vec<Value> {
        self.0
            .lock()
            .iter()
            .filter(|(event, payload)| *event == name && payload["terminalId"] == leaf)
            .map(|(_, payload)| payload.clone())
            .collect()
    }
    fn samples(&self, leaf: &str) -> Vec<Value> {
        self.values("ssh-metrics:sample", leaf)
    }
}

#[derive(Clone, Copy)]
struct NativeFacts {
    visible: Option<bool>,
    minimized: Option<bool>,
    _focused: bool,
}
#[derive(Default)]
struct FakeWindows(Mutex<HashMap<String, NativeFacts>>);
impl FakeWindows {
    fn set(&self, label: &str, visible: Option<bool>, minimized: Option<bool>, focused: bool) {
        self.0.lock().insert(
            label.into(),
            NativeFacts {
                visible,
                minimized,
                _focused: focused,
            },
        );
    }
}
impl Visibility for FakeWindows {
    fn visible(&self, windows: Vec<WindowKey>) -> BoxFuture<'_, HashSet<WindowKey>> {
        Box::pin(async move {
            let facts = self.0.lock();
            windows
                .into_iter()
                .filter(|w| {
                    facts
                        .get(&w.label)
                        .is_some_and(|f| on_screen(f.visible, f.minimized))
                })
                .collect()
        })
    }
}

#[derive(Default)]
struct Wire {
    starts: AtomicUsize,
    mode: Mutex<Option<Reply>>,
    counters: Arc<crate::ssh::tests::Counters>,
}

enum Reply {
    Hang,
    Gate(Arc<Notify>),
}

fn server(host: &'static str) -> (Server, Arc<Wire>) {
    let mut server = Server::new(1, "alice");
    let wire = Arc::new(Wire {
        counters: server.counters.clone(),
        ..Wire::default()
    });
    let copy = wire.clone();
    server.exec_fixture = Some(Arc::new(move |channel, command, session| {
        let channel = channel.id();
        let command = std::str::from_utf8(command).unwrap();
        let (cmd, _) = command.rsplit_once(" || /bin/sh -c 'exit 125'").unwrap();
        let (_, nonce) = cmd.rsplit_once(' ').unwrap();
        let prefix = format!("__TFM_{nonce}_");
        let mut frame = format!("{prefix}V1_BEGIN__\n");
        for (key, value) in [
            ("platform", "Darwin"),
            ("hostname", host),
            ("architecture", "arm64"),
        ] {
            writeln!(
                frame,
                "{prefix}SECTION_{key}_BEGIN__\n{value}\n{prefix}SECTION_{key}_END_0__"
            )
            .unwrap();
        }
        writeln!(frame, "{prefix}V1_END__").unwrap();
        copy.starts.fetch_add(1, SeqCst);
        session.channel_success(channel)?;
        match copy.mode.lock().take() {
            Some(Reply::Hang) => {}
            Some(Reply::Gate(release)) => {
                let handle = session.handle();
                tokio::spawn(async move {
                    release.notified().await;
                    if handle.data(channel, frame.into_bytes()).await.is_ok() {
                        let _ = handle.exit_status_request(channel, 0).await;
                        let _ = handle.eof(channel).await;
                        let _ = handle.close(channel).await;
                    }
                });
            }
            None => {
                session.data(channel, frame.into_bytes())?;
                session.exit_status_request(channel, 0)?;
                session.eof(channel)?;
                session.close(channel)?;
            }
        }
        Ok(())
    }));
    (server, wire)
}

struct Targets;
impl TargetSource for Targets {
    fn resolve<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<SessionTarget, SessionError>> {
        Box::pin(async move {
            Ok(SessionTarget {
                hops: vec![hop(id, "alice")],
            })
        })
    }
}
struct Streams(HashMap<&'static str, MemoryStreams>);
impl StreamFactory for Streams {
    fn connect<'a>(
        &'a self,
        hop: &'a SessionHop,
    ) -> BoxFuture<'a, Result<BoxStream, SessionError>> {
        self.0[hop.connection_id.as_str()].connect(hop)
    }
}

struct WatchRig {
    f: Fixture,
    keys: HostKeys,
    registry: Arc<WatchRegistry>,
    windows: Arc<FakeWindows>,
    events: Arc<Events>,
    wire: HashMap<&'static str, Arc<Wire>>,
}

fn connection(leaf: &str) -> &'static str {
    match leaf {
        A => "c-a",
        B => "c-b",
        C => "c-c",
        _ => panic!("unexpected leaf: {leaf}"),
    }
}

impl WatchRig {
    fn new() -> Self {
        let (sa, a) = server("fixture-a");
        let (sb, b) = server("fixture-b");
        let (sc, c) = server("fixture-c");
        let f = Fixture::new(sa.clone(), vec![hop("c-a", "alice")], true);
        f.registry
            .configure(Dependencies {
                targets: Arc::new(Targets),
                streams: Arc::new(Streams(HashMap::from([
                    ("c-a", MemoryStreams(sa)),
                    ("c-b", MemoryStreams(sb)),
                    ("c-c", MemoryStreams(sc)),
                ]))),
                agents: Arc::new(NativeAgent),
                secrets: f.secrets.clone(),
                events: f.events.clone(),
                known_hosts: crate::ssh::known_hosts::KnownHosts {
                    path: f.path.clone(),
                },
                home: f.path.parent().unwrap().into(),
            })
            .unwrap();
        let keys = HostKeys::default();
        let events = Arc::new(Events::default());
        let windows = Arc::new(FakeWindows::default());
        let registry = WatchRegistry::new(
            keys.clone(),
            f.registry.clone(),
            events.clone(),
            windows.clone(),
        );
        Self {
            f,
            keys,
            registry,
            windows,
            events,
            wire: HashMap::from([(A, a), (B, b), (C, c)]),
        }
    }
    fn reconcile(&self) {
        self.f
            .registry
            .reconcile_owners(|leaf, receipt| self.keys.ssh_owner_receipt(leaf) == receipt);
        self.registry.reconcile();
    }
    async fn connected(&self, page: &mut Page, leaf: &str) -> (Value, u64) {
        let pane = page.enter(self, leaf);
        let opened = open_core(&self.keys, &self.f.registry, leaf, connection(leaf)).unwrap();
        let PaneResult::Create { cg } = page.op(
            self,
            json!({"kind":"admit_create", "mode":"Mount", "pi":pane["pi"]}),
        ) else {
            panic!("expected admitted placement");
        };
        let process = format!("{leaf}~local");
        self.keys.stage_shell(leaf, cg, &process, None).unwrap();
        assert!(matches!(
            self.keys.complete_shell(
                leaf,
                cg,
                &StagedShell {
                    process,
                    stage: ShellStage::Local
                }
            ),
            Completion::Registered
        ));
        self.authenticate(leaf, opened.generation).await;
        (pane, opened.generation)
    }
    async fn authenticate(&self, leaf: &str, generation: u64) {
        let prompt = wait_state(&self.f.registry, leaf, false, SessionState::NeedsSecret).await;
        self.f
            .registry
            .submit_secret(
                leaf,
                false,
                Some(generation),
                prompt.prompt_id.as_deref(),
                self.f.server.password.clone(),
                false,
            )
            .unwrap();
        self.f
            .registry
            .on_launch_lifecycle(leaf, generation, 1, LaunchState::Running, None)
            .unwrap();
        wait_state(&self.f.registry, leaf, false, SessionState::Connected).await;
    }
    fn starts(&self, leaf: &str) -> usize {
        self.wire[leaf].starts.load(SeqCst)
    }
    fn closed(&self, leaf: &str) -> usize {
        self.wire[leaf].counters.closed_channels.load(SeqCst)
    }
    fn watch(&self, page: &Page, leaf: &str, id: Uuid) -> Fence {
        self.registry.watch(page.label, page.pg, leaf, id).unwrap()
    }
    fn unwatch(&self, page: &Page, leaf: &str, id: Uuid) {
        self.registry
            .unwatch(page.label, page.pg, leaf, id)
            .unwrap();
    }
    async fn sample(&self, leaf: &str, n: usize) -> Value {
        until(|| self.events.samples(leaf).len() >= n).await;
        self.events.samples(leaf)[n - 1].clone()
    }
}

struct Page {
    label: &'static str,
    wi: u64,
    pg: u64,
    seq: u64,
    pane_seq: u64,
}
impl Page {
    fn new(rig: &WatchRig, label: &'static str) -> Self {
        rig.keys.reserve_window(label).unwrap().commit().unwrap();
        rig.windows.set(label, Some(true), Some(false), false);
        Self::register(rig, label)
    }
    fn register(rig: &WatchRig, label: &'static str) -> Self {
        let crate::state::PageRegistration::Registered { wi, pg } =
            rig.keys.register_page(label).unwrap()
        else {
            panic!("page")
        };
        Self {
            label,
            wi,
            pg,
            seq: 1,
            pane_seq: 1,
        }
    }
    fn entry(&mut self, leaf: &str) -> Value {
        let seq = self.pane_seq;
        self.pane_seq += 1;
        json!({"pi":{"pg":self.pg,"seq":seq},"paneId":format!("pane-{leaf}-{seq}"),"leaf":leaf,"restore":false})
    }
    fn op(&mut self, rig: &WatchRig, op: Value) -> PaneResult {
        let request = serde_json::from_value(json!({"pg":self.pg,"seq":self.seq,"op":op})).unwrap();
        let (reply, effects) = rig.keys.pane_op(self.label, request).unwrap();
        self.seq += 1;
        for (leaf, receipt) in effects.ssh_retired {
            rig.f.registry.retire_owner(&leaf, receipt);
        }
        rig.reconcile();
        let PaneReply::Ack { result } = reply else {
            panic!("expected page ack")
        };
        result
    }
    fn enter(&mut self, rig: &WatchRig, leaf: &str) -> Value {
        let entry = self.entry(leaf);
        assert_eq!(
            self.op(rig, json!({"kind":"enter","panes":[entry]})),
            PaneResult::Ok
        );
        entry
    }
    fn install_restored(&mut self, rig: &WatchRig, leaf: &str) -> Value {
        let pane = self.enter(rig, leaf);
        assert!(matches!(
            self.op(
                rig,
                json!({"kind":"admit_create","mode":"Mount","pi":pane["pi"]})
            ),
            PaneResult::Existing { .. }
        ));
        pane
    }
    fn destroy(&self, rig: &WatchRig) {
        rig.keys.destroy_window(self.label, self.wi);
        rig.reconcile();
    }
}

async fn until(mut check: impl FnMut() -> bool) {
    timeout(WAIT, async {
        loop {
            if check() {
                break;
            }
            sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .expect("fixture state did not converge");
}

type SlotSnapshot = (Option<u64>, bool, HashSet<(String, u64, u64, Uuid)>, bool);
type Slots = HashMap<String, SlotSnapshot>;
fn snapshot(rig: &WatchRig) -> Slots {
    let slots = rig.registry.slots.lock().clone();
    slots
        .into_iter()
        .filter_map(|(leaf, entry)| {
            let slot = entry.lock();
            if !slot.established || slot.retired {
                return None;
            }
            let (generation, eligible, in_flight) =
                rig.registry.sampler.status(&leaf).expect("slot's worker");
            Some((
                leaf,
                (
                    generation,
                    eligible,
                    slot.consumers
                        .iter()
                        .map(|c| (c.window.label.clone(), c.window.wi, c.pg, c.id))
                        .collect(),
                    in_flight,
                ),
            ))
        })
        .collect()
}
fn expected(
    leaf: &str,
    generation: u64,
    eligible: bool,
    owners: &[(&Page, Uuid)],
    in_flight: bool,
) -> (String, SlotSnapshot) {
    (
        leaf.into(),
        (
            Some(generation),
            eligible,
            owners
                .iter()
                .map(|(page, id)| (page.label.into(), page.wi, page.pg, *id))
                .collect(),
            in_flight,
        ),
    )
}
fn sessions(rig: &WatchRig, leaves: &[&str]) {
    assert_eq!(
        rig.f.registry.owner_map(),
        leaves
            .iter()
            .map(|leaf| (
                (*leaf).to_owned(),
                (connection(leaf).to_owned(), SessionState::Connected)
            ))
            .collect::<HashMap<_, _>>()
    );
}

#[tokio::test]
async fn watch_registers_exact_terminal_consumer_and_returns_floor() {
    let rig = WatchRig::new();
    let mut page = Page::new(&rig, "owner");
    let (pane, generation) = rig.connected(&mut page, A).await;
    let id = Uuid::new_v4();
    assert!(matches!(
        rig.registry
            .watch(page.label, page.pg, pane["paneId"].as_str().unwrap(), id),
        Err(SessionError::OwnerRetired)
    ));
    let receipt = rig.watch(&page, A, id);
    assert_eq!(receipt.generation, generation);
    assert_eq!((receipt.pause_seq, receipt.paused_reason), (0, None));
    let sample = rig.sample(A, 1).await;
    assert_eq!(sample["terminalId"], A);
    assert!(sample["sampledAt"].as_u64().unwrap() > receipt.sample_floor);
    let renewed = rig.watch(&page, A, id);
    assert!(renewed.sample_floor > sample["sampledAt"].as_u64().unwrap());
    assert_eq!(
        snapshot(&rig),
        HashMap::from([expected(A, generation, true, &[(&page, id)], false)])
    );
    assert_eq!(rig.starts(A), 1);
    rig.f.registry.shutdown().await;
}

#[tokio::test]
async fn two_consumers_one_terminal_have_one_exec_worker() {
    let rig = WatchRig::new();
    let mut left = Page::new(&rig, "left");
    let mut right = Page::new(&rig, "right");
    let (_, ga) = rig.connected(&mut left, A).await;
    let (_, gb) = rig.connected(&mut right, B).await;
    let (x, y, z) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    rig.watch(&left, A, x);
    rig.watch(&left, A, y);
    rig.watch(&left, A, x); // Re-fence, not a third subscriber.
    rig.watch(&right, B, z);
    rig.sample(A, 1).await;
    rig.sample(B, 1).await;
    assert_eq!(
        snapshot(&rig),
        HashMap::from([
            expected(A, ga, true, &[(&left, x), (&left, y)], false),
            expected(B, gb, true, &[(&right, z)], false),
        ])
    );
    assert_eq!((rig.starts(A), rig.starts(B)), (1, 1));
    rig.unwatch(&left, A, x);
    rig.sample(A, 2).await;
    rig.sample(B, 2).await;
    assert_eq!(
        snapshot(&rig),
        HashMap::from([
            expected(A, ga, true, &[(&left, y)], false),
            expected(B, gb, true, &[(&right, z)], false),
        ])
    );
    rig.unwatch(&left, A, y);
    rig.sample(B, 3).await;
    assert_eq!(rig.starts(A), 2);
    rig.f.registry.shutdown().await;
}

#[tokio::test]
async fn hidden_or_minimized_owner_exec_count_stops_visible_unfocused_continues() {
    let rig = WatchRig::new();
    let mut a = Page::new(&rig, "a");
    let mut b = Page::new(&rig, "b");
    rig.connected(&mut a, A).await;
    rig.connected(&mut b, B).await;
    rig.windows.set(a.label, Some(false), Some(false), true);
    rig.windows.set(b.label, Some(true), Some(false), false);
    rig.watch(&a, A, Uuid::new_v4());
    rig.watch(&b, B, Uuid::new_v4());
    rig.sample(B, 2).await;
    assert_eq!(rig.starts(A), 0);
    rig.windows.set(a.label, Some(true), Some(true), true);
    rig.sample(B, 3).await;
    assert_eq!(rig.starts(A), 0);
    rig.windows.set(a.label, Some(true), None, false); // Native query error is not proof of visibility.
    rig.sample(B, 4).await;
    assert_eq!(rig.starts(A), 0);
    rig.windows.set(a.label, Some(true), Some(false), false);
    // No new registration or native event wakes the sampler; this is the hidden-owner poll.
    timeout(
        super::super::sampler::ELIGIBILITY_WAKE + Duration::from_millis(200),
        rig.sample(A, 1),
    )
    .await
    .expect("restored pane did not collect on the no-exec eligibility wake");
    assert!(rig.starts(B) >= 4);
    let wiring = include_str!("../watch.rs");
    assert!(
        wiring.contains("run_on_main_thread")
            && wiring.contains("window.is_visible()")
            && wiring.contains("window.is_minimized()")
    );
    assert!(
        !wiring.contains(".is_focused("),
        "native focus is not eligibility"
    );
    rig.f.registry.shutdown().await;
}

#[tokio::test]
async fn second_visible_owner_keeps_only_its_terminal_sampling() {
    let rig = WatchRig::new();
    let mut a = Page::new(&rig, "a");
    let mut b = Page::new(&rig, "b");
    let (_, ga) = rig.connected(&mut a, A).await;
    let (_, gb) = rig.connected(&mut b, B).await;
    let (x, y) = (Uuid::new_v4(), Uuid::new_v4());
    rig.watch(&a, A, x);
    rig.watch(&b, B, y);
    rig.sample(A, 1).await;
    rig.sample(B, 1).await;
    rig.windows.set(a.label, Some(false), Some(false), false);
    rig.sample(B, 3).await;
    assert_eq!(
        snapshot(&rig),
        HashMap::from([
            expected(A, ga, false, &[(&a, x)], false),
            expected(B, gb, true, &[(&b, y)], false),
        ])
    );
    assert_eq!(rig.starts(A), 1);
    assert_eq!(rig.events.samples(A).len(), 1);
    rig.f.registry.shutdown().await;
}

#[tokio::test]
async fn destroyed_window_and_last_unwatch_remove_exact_owners() {
    let rig = WatchRig::new();
    let mut left = Page::new(&rig, "left");
    let mut right = Page::new(&rig, "right");
    rig.connected(&mut left, A).await;
    let (_, gb) = rig.connected(&mut right, B).await;
    let (x, y, z) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    rig.watch(&left, A, x);
    rig.watch(&right, B, y);
    rig.sample(A, 1).await;
    rig.sample(B, 1).await;
    let mut reload = Page::register(&rig, right.label);
    assert_eq!(
        reload.op(&rig, json!({"kind":"replace_page"})),
        PaneResult::Ok
    );
    assert_eq!(snapshot(&rig)[B], expected(B, gb, false, &[], false).1);
    reload.install_restored(&rig, B);
    assert_eq!(reload.op(&rig, json!({"kind":"settle"})), PaneResult::Ok);
    rig.watch(&reload, B, z);
    left.destroy(&rig);
    rig.sample(B, 2).await;
    until(|| rig.registry.sampler.status(A).is_none()).await;
    sessions(&rig, &[B]);
    assert_eq!(
        snapshot(&rig),
        HashMap::from([expected(B, gb, true, &[(&reload, z)], false)])
    );
    rig.unwatch(&reload, B, z);
    rig.unwatch(&reload, B, z);
    sleep(QUIET).await;
    assert_eq!(
        snapshot(&rig),
        HashMap::from([expected(B, gb, false, &[], false)])
    );
    assert_eq!((rig.starts(A), rig.starts(B)), (1, 2));
    assert_eq!(rig.events.samples(A).len(), 1);
    rig.f.registry.shutdown().await;
}

#[tokio::test]
async fn old_consumer_cleanup_cannot_kill_replacement() {
    let rig = WatchRig::new();
    let mut page = Page::new(&rig, "owner");
    let (_, generation) = rig.connected(&mut page, A).await;
    let (old, new) = (Uuid::new_v4(), Uuid::new_v4());
    rig.watch(&page, A, old);
    rig.watch(&page, A, new);
    rig.unwatch(&page, A, old);
    rig.unwatch(&page, A, old);
    rig.sample(A, 1).await;
    assert_eq!(
        snapshot(&rig),
        HashMap::from([expected(A, generation, true, &[(&page, new)], false)])
    );
    assert_eq!(
        rig.registry.resume(page.label, page.pg, A, old),
        Err(SessionError::OwnerRetired)
    );
    let receipt = rig.registry.resume(page.label, page.pg, A, new).unwrap();
    assert_eq!(receipt.pause_seq, 1);
    rig.sample(A, 2).await;
    rig.unwatch(&page, A, new);
    sleep(QUIET).await;
    assert_eq!(
        snapshot(&rig),
        HashMap::from([expected(A, generation, false, &[], false)])
    );
    assert_eq!(rig.starts(A), 2);
    rig.f.registry.shutdown().await;
}

mod lifecycle;
