//! In-memory pty-hosts for the adoption tests: a duplex pipe wired into a real
//! `PtyHostClient` on one end, a small host on the other that answers like the
//! real one and records every frame it receives, per host identity.

use super::*;
use crate::pty_host_client::{wire_client, PtyHostDeps};
use super::panes::PanePort;
use crate::state::host_lifecycle::SiblingSlot;
use crate::state::host_routing::RoutingPort;
use crate::state::types::{FrozenHost, HostSessionClaim, Terminal};
use crate::state::{host_registry, ChannelPayload};
use dashmap::DashMap;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use termflow_pty_protocol::{
    read_frame, write_frame, Control, Data, Frame, HostRecord, Response, PROTOCOL_MAX, PROTOCOL_MIN,
};
use tokio::io::{duplex, DuplexStream};
use tokio::task::AbortHandle;

#[derive(Clone)]
pub(super) enum ListBehavior {
    Answer,
    /// Never answers a listing: the host is busy or wedged.
    Never,
    /// Drops listing requests received before this long after the world began,
    /// answers later ones: a host that recovers.
    SilentFor(Duration),
    /// Answers the first `n` listing requests of each connection, then goes
    /// silent: a host that stops answering after it was adopted.
    AnswerFirst(usize),
    /// Drops listing requests received from `.0` to `.1` after the world began,
    /// answers the rest: a host that goes quiet for a while and comes back.
    SilentBetween(Duration, Duration),
    /// Answers the first `answered` listing requests of each connection at once
    /// and every later one only after `delay`: a host that has become slow.
    SlowAfter { answered: usize, delay: Duration },
}

#[derive(Clone)]
pub(super) struct HostSpec {
    pub sessions: Vec<SessionMeta>,
    pub list: ListBehavior,
    /// How long connecting takes.
    pub connect_delay: Duration,
    /// The endpoint exists but nothing can be connected to it: the host is busy
    /// or slow, which is not the same as gone.
    pub unreachable: bool,
    /// Connecting is refused outright: nothing listens on the endpoint.
    pub refused: bool,
    /// Never acknowledges an arm: the request is received and ignored.
    pub no_arm_ack: bool,
    /// How long an arm is acknowledged after it was received.
    pub arm_delay: Duration,
    /// How long a session that was told to close is still listed. A real host
    /// reaps the session after it hears the close, not before.
    pub close_lag: Duration,
}

impl Default for HostSpec {
    fn default() -> Self {
        Self {
            sessions: Vec::new(),
            list: ListBehavior::Answer,
            connect_delay: Duration::ZERO,
            unreachable: false,
            refused: false,
            no_arm_ack: false,
            arm_delay: Duration::ZERO,
            close_lag: Duration::ZERO,
        }
    }
}

/// Recorded in place of a frame when a connection ends: the host saw EOF.
const EOF_MARK: &str = "\0connection closed";

pub(super) struct Recorded {
    pub host: String,
    pub at: Instant,
    pub frame: Frame,
}

impl Recorded {
    pub fn kind(&self) -> &'static str {
        match &self.frame {
            Frame::Ctrl(Control::Disarm { .. }) => "Disarm",
            Frame::Ctrl(Control::ListSessions { .. }) => "List",
            Frame::Ctrl(Control::Spawn { .. }) => "Spawn",
            Frame::Ctrl(Control::Attach { .. } | Control::AttachAcked { .. }) => "Attach",
            Frame::Ctrl(Control::ArmDetach { .. }) => "Arm",
            Frame::Ctrl(Control::Shutdown { .. }) => "Shutdown",
            Frame::Ctrl(Control::Close { tab_id }) if tab_id == EOF_MARK => "Eof",
            Frame::Ctrl(Control::Close { .. }) => "Close",
            Frame::Ctrl(Control::Resize { .. }) => "Resize",
            Frame::Data(Data::Stdin { .. }) => "Stdin",
            _ => "Other",
        }
    }

    /// The session a session-addressed frame is about.
    pub fn session(&self) -> Option<&str> {
        match &self.frame {
            Frame::Ctrl(
                Control::Spawn { tab_id, .. }
                | Control::Attach { tab_id, .. }
                | Control::AttachAcked { tab_id, .. }
                | Control::Resize { tab_id, .. }
                | Control::Close { tab_id },
            )
            | Frame::Data(Data::Stdin { tab_id, .. }) => Some(tab_id),
            _ => None,
        }
    }
}

/// The machine: which hosts are running, what each received, which host
/// processes were started.
/// A session that ended on its host by itself (not because it was closed).
struct Ended {
    host: String,
    session: String,
    /// Still listed, with `alive: false`, instead of gone from the listing.
    listed_dead: bool,
}

pub(super) struct World {
    started: Instant,
    hosts: Mutex<HashMap<String, (HostSpec, Vec<AbortHandle>)>>,
    log: Arc<Mutex<Vec<Recorded>>>,
    ended: Arc<Mutex<Vec<Ended>>>,
    /// Endpoints a host process was started for, in order.
    pub started_processes: Mutex<Vec<String>>,
    pub spawn_fails: AtomicBool,
    /// Connecting to a frozen host panics, as a bug in the port would.
    pub connect_panics: AtomicBool,
}

impl World {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            started: Instant::now(),
            hosts: Mutex::new(HashMap::new()),
            log: Arc::new(Mutex::new(Vec::new())),
            ended: Arc::new(Mutex::new(Vec::new())),
            started_processes: Mutex::new(Vec::new()),
            spawn_fails: AtomicBool::new(false),
            connect_panics: AtomicBool::new(false),
        })
    }

    pub fn add_host(&self, endpoint: &str, spec: HostSpec) {
        self.hosts.lock().unwrap().insert(endpoint.to_owned(), (spec, Vec::new()));
    }

    /// The host becomes (or stops being) something nothing can connect to.
    pub fn set_unreachable(&self, endpoint: &str, unreachable: bool) {
        if let Some((spec, _)) = self.hosts.lock().unwrap().get_mut(endpoint) {
            spec.unreachable = unreachable;
        }
    }

    /// A session of `host` ends on its own, as a shell does when its program
    /// exits: the host stops listing it, with no `Close` ever received.
    pub fn end_session(&self, host: &str, session: &str) {
        self.ended.lock().unwrap().push(Ended { host: host.to_owned(), session: session.to_owned(), listed_dead: false });
    }

    /// Like [`Self::end_session`], but the host still lists the session, dead.
    pub fn end_session_listed_dead(&self, host: &str, session: &str) {
        self.ended.lock().unwrap().push(Ended { host: host.to_owned(), session: session.to_owned(), listed_dead: true });
    }

    /// The host dies: every connection to it drops.
    pub fn kill_connections(&self, endpoint: &str) {
        if let Some((_, tasks)) = self.hosts.lock().unwrap().get_mut(endpoint) {
            for task in tasks.drain(..) {
                task.abort();
            }
        }
    }

    fn open(&self, endpoint: &str) -> Option<DuplexStream> {
        let mut hosts = self.hosts.lock().unwrap();
        let (spec, tasks) = hosts.get_mut(endpoint)?;
        if spec.unreachable {
            return None;
        }
        let (client, server) = duplex(64 * 1024);
        let task = tokio::spawn(serve(
            endpoint.to_owned(),
            spec.clone(),
            self.started,
            self.log.clone(),
            self.ended.clone(),
            server,
        ));
        tasks.push(task.abort_handle());
        Some(client)
    }

    fn spec(&self, endpoint: &str) -> Option<HostSpec> {
        self.hosts.lock().unwrap().get(endpoint).map(|(s, _)| s.clone())
    }

    pub fn frames(&self, host: &str) -> Vec<(Instant, &'static str)> {
        self.log
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.host == host)
            .map(|r| (r.at, r.kind()))
            .collect()
    }

    pub fn kinds(&self, host: &str) -> Vec<&'static str> {
        self.frames(host).into_iter().map(|(_, k)| k).collect()
    }

    /// The sessions `host` received a `kind` frame for, in order.
    pub fn sessions(&self, host: &str, kind: &str) -> Vec<String> {
        self.log
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.host == host && r.kind() == kind)
            .filter_map(|r| r.session().map(str::to_owned))
            .collect()
    }

    pub fn count(&self, host: &str, kind: &str) -> usize {
        self.kinds(host).into_iter().filter(|k| *k == kind).count()
    }

    /// Frames of `kind` received by any host.
    pub fn count_everywhere(&self, kind: &str) -> usize {
        self.log.lock().unwrap().iter().filter(|r| r.kind() == kind).count()
    }

    /// Every frame `host` received, with its contents, in order.
    pub fn frames_of(&self, host: &str) -> Vec<Frame> {
        self.log.lock().unwrap().iter().filter(|r| r.host == host).map(|r| r.frame.clone()).collect()
    }

    pub fn first_at(&self, host: &str, kind: &str) -> Option<Instant> {
        self.frames(host).into_iter().find(|(_, k)| *k == kind).map(|(at, _)| at)
    }
}

async fn serve(
    host: String,
    spec: HostSpec,
    world_start: Instant,
    log: Arc<Mutex<Vec<Recorded>>>,
    ended: Arc<Mutex<Vec<Ended>>>,
    server: DuplexStream,
) {
    let (mut rd, mut wr) = tokio::io::split(server);
    let mut listings = 0usize;
    while let Ok(Some(frame)) = read_frame(&mut rd).await {
        log.lock().unwrap().push(Recorded { host: host.clone(), at: Instant::now(), frame: frame.clone() });
        let reply = match frame {
            Frame::Ctrl(Control::Disarm { req }) => Some(Response::DisarmAck { req }),
            Frame::Ctrl(Control::ListSessions { req, .. }) => {
                listings += 1;
                if let ListBehavior::SlowAfter { answered, delay } = &spec.list {
                    if listings > *answered {
                        tokio::time::sleep(*delay).await;
                    }
                }
                let answers = match &spec.list {
                    ListBehavior::Answer => true,
                    ListBehavior::Never => false,
                    ListBehavior::SilentFor(d) => Instant::now() >= world_start + *d,
                    ListBehavior::AnswerFirst(n) => listings <= *n,
                    ListBehavior::SilentBetween(from, to) => {
                        let now = Instant::now();
                        !(world_start + *from <= now && now < world_start + *to)
                    }
                    ListBehavior::SlowAfter { .. } => true,
                };
                // A session the host was told to close is no longer listed once its
                // close has taken effect.
                answers.then(|| Response::SessionList { req, sessions: still_open(&spec, &log, &ended, &host) })
            }
            Frame::Ctrl(Control::Spawn { req, tab_id, .. }) => Some(Response::Spawned { req, tab_id, pid: 4242 }),
            Frame::Ctrl(Control::AttachAcked { req, tab_id, .. }) => {
                Some(Response::AttachAck { req, tab_id, alive: true, tail_offset: 0 })
            }
            Frame::Ctrl(Control::ArmDetach { .. }) if spec.no_arm_ack => None,
            Frame::Ctrl(Control::ArmDetach { req, .. }) => {
                tokio::time::sleep(spec.arm_delay).await;
                Some(Response::ArmAck { req, deadline_ms: 0 })
            }
            Frame::Ctrl(Control::Shutdown { req, .. }) => Some(Response::ShutdownAck { req }),
            _ => None,
        };
        if let Some(reply) = reply {
            if write_frame(&mut wr, &Frame::Resp(reply)).await.is_err() {
                break;
            }
        }
    }
    // The client closed the stream (or died): what a real host reacts to.
    log.lock().unwrap().push(Recorded {
        host,
        at: Instant::now(),
        frame: Frame::Ctrl(Control::Close { tab_id: EOF_MARK.to_string() }),
    });
}

/// The sessions of `spec` that `host` has not closed yet: one is gone `close_lag`
/// after the `Close` for it was received.
fn still_open(spec: &HostSpec, log: &Mutex<Vec<Recorded>>, ended: &Mutex<Vec<Ended>>, host: &str) -> Vec<SessionMeta> {
    let log = log.lock().unwrap();
    let ended = ended.lock().unwrap();
    let now = Instant::now();
    let ended_here = |key: &str| ended.iter().find(|e| e.host == host && e.session == key);
    spec.sessions
        .iter()
        .filter(|s| {
            !log.iter().any(|r| {
                r.host == host
                    && r.kind() == "Close"
                    && r.session() == Some(s.tab_id.as_str())
                    && now.duration_since(r.at) >= spec.close_lag
            }) && !ended_here(&s.tab_id).is_some_and(|e| !e.listed_dead)
        })
        .map(|s| SessionMeta { alive: s.alive && ended_here(&s.tab_id).is_none(), ..s.clone() })
        .collect()
}

pub(super) fn meta(key: &str, pid: u32) -> SessionMeta {
    SessionMeta { tab_id: key.into(), pid, head_offset: 0, tail_offset: 0, alive: true }
}

pub(super) fn candidate(endpoint: &str, role: HostRole) -> HostCandidate {
    HostCandidate {
        generation: Some(endpoint.to_owned()),
        endpoint: endpoint.to_owned(),
        record: Some(record(endpoint, PROTOCOL_MIN, PROTOCOL_MAX)),
        record_path: None,
        pid: Some(1000),
        mtime: std::time::SystemTime::UNIX_EPOCH,
        role,
    }
}

pub(super) fn record(endpoint: &str, proto_min: u16, proto_max: u16) -> HostRecord {
    HostRecord {
        format: 1,
        instance_id: 1,
        pid: 1000,
        proto_min,
        proto_max,
        endpoint: endpoint.to_owned(),
        capabilities: termflow_pty_protocol::CAP_ATTACH_ACK | termflow_pty_protocol::CAP_SHUTDOWN_CONTROL,
        lifecycle: None,
        build_id: None,
    }
}

pub(super) struct Inner {
    pub world: Arc<World>,
    pub table: HostTable,
    pub barrier: Barrier,
    flight: tokio::sync::Mutex<()>,
    candidates: Mutex<Vec<HostCandidate>>,
    current_endpoint: String,
    current: Mutex<Option<PtyHostClient>>,
    frozen: Mutex<Vec<FrozenHost>>,
    next_id: AtomicU32,
    pub claims: Arc<DashMap<String, HostSessionClaim>>,
    pub restoring_keys: DashMap<String, std::time::Instant>,
    pub restoring_leaf_keys: DashMap<String, String>,
    pub closed_unowned: DashMap<String, std::time::Instant>,
    pub host_close_pending: DashMap<String, HostChannel>,
    pub host_terminals: DashMap<String, HostChannel>,
    pub terminals: DashMap<String, Terminal>,
    pub discovers: AtomicUsize,
    /// Every `connect` the port was asked to make.
    pub connects: Mutex<Vec<(String, HostRole)>>,
    /// Every listing applied: the channel and how many sessions (`None` = unanswered).
    pub listings: Mutex<Vec<(HostChannel, Option<usize>)>>,
    pub disconnects: AtomicUsize,
    pub duplicates: Mutex<Vec<String>>,
    /// Process ids of the panes torn down, in order.
    pub torn_down: Mutex<Vec<String>>,
    /// Session keys offered to the user as recovered terminals, in order.
    pub recovered: Mutex<Vec<String>>,
    /// What the table said about the primary slot each time the current client
    /// was made visible.
    pub admission_when_published: Mutex<Vec<Option<crate::state::host_table::Admission>>>,
    pub frozen_admission_when_published: Mutex<Vec<Option<crate::state::host_table::Admission>>>,
    /// Where a host's executable is said to run from, by endpoint, for the hosts a
    /// test decided it for; any other host is classified from an image path in the
    /// runtime directory, as a real one would be.
    pub exe_origins: Mutex<HashMap<String, Option<bool>>>,
    /// The hold a sibling's arm keeps.
    pub sibling_slot: SiblingSlot,
    /// Whether adopting an older host starts its retirement ticker, as it does in
    /// the application. Off unless a test is about retirement, so the tests of
    /// everything else see no sampling.
    pub retirement: AtomicBool,
}

/// `AppState`'s stand-in: the same port, over a fake machine.
#[derive(Clone)]
pub(super) struct FakePort(pub Arc<Inner>);

impl FakePort {
    pub fn new(world: &Arc<World>, current_endpoint: &str) -> Self {
        Self(Arc::new(Inner {
            world: world.clone(),
            table: HostTable::new(),
            barrier: Barrier::new(),
            flight: tokio::sync::Mutex::new(()),
            candidates: Mutex::new(Vec::new()),
            current_endpoint: current_endpoint.to_owned(),
            current: Mutex::new(None),
            frozen: Mutex::new(Vec::new()),
            next_id: AtomicU32::new(1),
            claims: Arc::new(DashMap::new()),
            restoring_keys: DashMap::new(),
            restoring_leaf_keys: DashMap::new(),
            closed_unowned: DashMap::new(),
            host_close_pending: DashMap::new(),
            host_terminals: DashMap::new(),
            terminals: DashMap::new(),
            discovers: AtomicUsize::new(0),
            connects: Mutex::new(Vec::new()),
            listings: Mutex::new(Vec::new()),
            disconnects: AtomicUsize::new(0),
            duplicates: Mutex::new(Vec::new()),
            torn_down: Mutex::new(Vec::new()),
            recovered: Mutex::new(Vec::new()),
            admission_when_published: Mutex::new(Vec::new()),
            frozen_admission_when_published: Mutex::new(Vec::new()),
            exe_origins: Mutex::new(HashMap::new()),
            sibling_slot: SiblingSlot::default(),
            retirement: AtomicBool::new(false),
        }))
    }

    /// Adopted older hosts are watched for emptiness from now on.
    pub fn enable_retirement(&self) {
        self.0.retirement.store(true, Ordering::SeqCst);
    }

    pub fn candidates(&self) -> Vec<HostCandidate> {
        self.0.candidates.lock().unwrap().clone()
    }

    pub fn set_candidates(&self, candidates: Vec<HostCandidate>) {
        *self.0.candidates.lock().unwrap() = candidates;
    }

    /// Say where the host on `endpoint` runs from (`None` = could not be told).
    pub fn set_exe_origin(&self, endpoint: &str, in_payload: Option<bool>) {
        self.0.exe_origins.lock().unwrap().insert(endpoint.to_owned(), in_payload);
        let live = self.current_client().into_iter().filter(|_| endpoint == self.0.current_endpoint).chain(
            self.frozen_hosts().into_iter().filter(|h| h.endpoint == endpoint).map(|h| h.client),
        );
        for client in live {
            client.inject_exe_verdict(in_payload);
        }
    }

    /// What the OS would say about a host started from the runtime directory, where
    /// the app installs the hosts it starts. Without one (no data directory) the
    /// lookup finds nothing.
    fn installed_host_image() -> Option<std::path::PathBuf> {
        crate::pty_host_client::runtime_host_dir()
            .map(|dir| dir.join("0123456789abcdef").join("termflow-pty-host.exe"))
    }

    /// Give the host on `channel` a retention promise, as a discovery record would.
    pub fn set_retention(&self, channel: HostChannel, retention: crate::pty_host_client::HostRetention) {
        match channel {
            HostChannel::Frozen(id) => {
                if let Some(host) = self.0.frozen.lock().unwrap().iter_mut().find(|h| h.id == id) {
                    host.client.set_lifecycle(retention);
                }
            }
            _ => {
                if let Some(client) = self.0.current.lock().unwrap().as_mut() {
                    client.set_lifecycle(retention);
                }
            }
        }
    }

    /// The published current client goes away, as after a pipe drop.
    pub fn drop_current(&self) {
        *self.0.current.lock().unwrap() = None;
    }

    pub fn frozen_ids(&self) -> Vec<FrozenId> {
        self.0.frozen.lock().unwrap().iter().map(|h| h.id).collect()
    }

    pub fn client_for(&self, channel: HostChannel) -> Option<PtyHostClient> {
        match channel {
            HostChannel::Frozen(id) => host_registry::frozen_client(&self.0.frozen, id),
            _ => self.current_client(),
        }
    }

    /// A pane is registered for `session_key` on `channel`, as after a create.
    pub fn register_terminal(&self, process_id: &str, session_key: &str, channel: HostChannel) {
        self.0.host_terminals.insert(process_id.to_owned(), channel);
        self.0.terminals.insert(
            process_id.to_owned(),
            Terminal {
                id: process_id.to_owned(),
                pid: 0,
                shell: "test".to_owned(),
                name: "Terminal-test".to_owned(),
                created_at: String::new(),
                cols: 80,
                rows: 24,
                backend: crate::tmux_manager::TerminalBackend::PortablePty,
                renderer_terminal_id: Some(session_key.to_owned()),
                owning_tab_id: None,
                session_key: session_key.to_owned(),
                last_input_source: None,
                last_input_at: None,
                prompt_hook: false,
                display_label: None,
                title_color: None,
            },
        );
    }

    pub fn intent_maps(&self) -> host_registry::IntentMaps<'_> {
        host_registry::IntentMaps {
            restoring_keys: &self.0.restoring_keys,
            restoring_leaf_keys: &self.0.restoring_leaf_keys,
            closed_unowned: &self.0.closed_unowned,
            terminals: &self.0.terminals,
        }
    }

    /// Duplicate keys reported by the listings applied so far.
    pub fn duplicates(&self) -> Vec<String> {
        self.0.duplicates.lock().unwrap().clone()
    }

    pub fn connect_count(&self, endpoint: &str) -> usize {
        self.0.connects.lock().unwrap().iter().filter(|(e, _)| e == endpoint).count()
    }

    fn deps(&self, on_disconnect: Arc<dyn Fn() + Send + Sync>) -> PtyHostDeps {
        PtyHostDeps {
            lifecycle_token: "tok".into(),
            output_tx: tokio::sync::broadcast::channel::<ChannelPayload>(16).0,
            output_produced: Arc::new(AtomicU64::new(0)),
            on_exit: Arc::new(|_, _, _| {}),
            on_gap: Arc::new(|_| {}),
            resolve_process: Arc::new(|k: &str| Some(k.to_string())),
            on_disconnect,
            stream_offsets: Arc::new(DashMap::new()),
        }
    }
}

impl AdoptionPort for FakePort {
    fn table(&self) -> &HostTable {
        &self.0.table
    }

    fn barrier(&self) -> &Barrier {
        &self.0.barrier
    }

    fn single_flight(&self) -> &tokio::sync::Mutex<()> {
        &self.0.flight
    }

    async fn discover(&self) -> Vec<HostCandidate> {
        self.0.discovers.fetch_add(1, Ordering::SeqCst);
        self.0.candidates.lock().unwrap().clone()
    }

    fn current_endpoint(&self) -> String {
        self.0.current_endpoint.clone()
    }

    fn current_client(&self) -> Option<PtyHostClient> {
        self.0.current.lock().unwrap().clone()
    }

    fn frozen_hosts(&self) -> Vec<FrozenHost> {
        self.0.frozen.lock().unwrap().clone()
    }

    fn next_frozen_id(&self) -> FrozenId {
        FrozenId(self.0.next_id.fetch_add(1, Ordering::SeqCst))
    }

    /// Like the real pair: a frozen host is only connected to; the current
    /// role adopts a running host, refuses to start a second one while the
    /// record's process is alive, and otherwise (nothing answers, nothing known
    /// to be alive) starts one.
    async fn connect(
        &self,
        candidate: &HostCandidate,
        role: HostRole,
        frozen: Option<(FrozenId, u64)>,
    ) -> Result<Opened, ConnectFailure> {
        self.0.connects.lock().unwrap().push((candidate.endpoint.clone(), role));
        let world = &self.0.world;
        let endpoint = candidate.endpoint.as_str();
        if role == HostRole::Frozen && world.connect_panics.load(Ordering::SeqCst) {
            panic!("the port failed while connecting {endpoint}");
        }
        if let Some(spec) = world.spec(endpoint) {
            tokio::time::sleep(spec.connect_delay).await;
            if spec.refused {
                return Err(ConnectFailure { reason: format!("connection refused on {endpoint}"), endpoint_gone: true });
            }
        }
        let stream = match world.open(endpoint) {
            Some(stream) => stream,
            None if role == HostRole::Frozen => return Err(format!("nothing answers on {endpoint}").into()),
            None if candidate.pid.is_some() => {
                return Err("a running pty-host is unreachable; not spawning a duplicate".to_string().into())
            }
            None if world.spawn_fails.load(Ordering::SeqCst) => return Err("no valid pty-host binary".to_string().into()),
            None => {
                world.started_processes.lock().unwrap().push(endpoint.to_owned());
                world.add_host(endpoint, HostSpec::default());
                world.open(endpoint).expect("a host was just started")
            }
        };
        let (rd, wr) = tokio::io::split(stream);
        let port = self.clone();
        let (on_disconnect, epoch): (Arc<dyn Fn() + Send + Sync>, u64) = match frozen {
            Some((id, epoch)) => {
                let endpoint = endpoint.to_owned();
                (
                    Arc::new(move || {
                        port.0.disconnects.fetch_add(1, Ordering::SeqCst);
                        frozen_connection_lost(&port.0.table, &port.0.barrier, id, epoch, &endpoint);
                    }),
                    epoch,
                )
            }
            None => (
                Arc::new(move || {
                    port.0.disconnects.fetch_add(1, Ordering::SeqCst);
                }),
                self.0.table.reserve_epoch(),
            ),
        };
        let client = wire_client(rd, wr, self.deps(on_disconnect));
        client.set_attach_acks(true);
        client.inject_exe_image(Self::installed_host_image());
        if let Some(verdict) = self.0.exe_origins.lock().unwrap().get(endpoint) {
            client.inject_exe_verdict(*verdict);
        }
        Ok(Opened { client, epoch, build_id: None })
    }

    fn apply_listing(&self, channel: HostChannel, client: &PtyHostClient, sessions: Option<&[SessionMeta]>) {
        self.0.listings.lock().unwrap().push((channel, sessions.map(<[_]>::len)));
        let Some(sessions) = sessions else { return };
        let duplicates = host_registry::apply_answered_listing(
            &host_registry::ListingMaps {
                host_terminals: &self.0.host_terminals,
                terminals: &self.0.terminals,
                host_session_claims: &self.0.claims,
                host_close_pending: &self.0.host_close_pending,
                closed_unowned: &self.0.closed_unowned,
            },
            channel,
            client,
            sessions,
            std::time::Instant::now(),
        );
        self.0.duplicates.lock().unwrap().extend(duplicates);
        host_registry::prune_pending_closes(&self.0.host_close_pending, channel);
    }

    fn publish_current(&self, client: &PtyHostClient) -> Result<(), String> {
        self.0.admission_when_published.lock().unwrap().push(self.0.table.admission(HostChannel::Primary));
        *self.0.current.lock().unwrap() = Some(client.clone());
        if !client.is_alive() {
            *self.0.current.lock().unwrap() = None;
            return Err("pty-host connection lost during setup".into());
        }
        Ok(())
    }

    fn frozen_adopted(&self, id: FrozenId) {
        if self.0.retirement.load(Ordering::SeqCst) {
            crate::state::host_retire::start_ticker(self, id);
        }
    }

    fn publish_frozen(&self, host: FrozenHost) {
        self.0.frozen_admission_when_published.lock().unwrap().push(self.0.table.admission(HostChannel::Frozen(host.id)));
        let mut hosts = self.0.frozen.lock().unwrap();
        match hosts.iter_mut().find(|h| h.id == host.id) {
            Some(known) => *known = host,
            None => hosts.push(host),
        }
    }
}

impl PanePort for FakePort {
    fn panes_on(&self, channel: HostChannel) -> HashMap<String, String> {
        host_registry::sessions_by_key(&self.0.host_terminals, &self.0.terminals, channel)
    }

    fn registered_on_any_channel(&self, session_key: &str) -> bool {
        host_registry::session_registered_on_any_channel(&self.0.host_terminals, &self.0.terminals, session_key)
    }

    fn pane_is_host_owned(&self, process_id: &str) -> bool {
        self.0.host_terminals.contains_key(process_id)
    }

    fn saved_offsets(&self) -> HashMap<String, u64> {
        HashMap::new()
    }

    fn pane_size(&self, process_id: &str) -> (u16, u16) {
        self.0.terminals.get(process_id).map(|t| (t.cols, t.rows)).unwrap_or((80, 24))
    }

    fn teardown_pane(&self, process_id: &str) {
        self.0.torn_down.lock().unwrap().push(process_id.to_owned());
        self.0.host_terminals.remove(process_id);
        self.0.terminals.remove(process_id);
    }

    fn announce_recovered(&self, session_key: &str) {
        self.0.recovered.lock().unwrap().push(session_key.to_owned());
    }

    fn forget_host(&self, id: FrozenId) {
        let channel = HostChannel::Frozen(id);
        self.0.frozen.lock().unwrap().retain(|h| h.id != id);
        host_registry::prune_pending_closes(&self.0.host_close_pending, channel);
        host_registry::forget_reserved_claims_on(&self.0.claims, channel);
    }
}

impl RoutingPort for FakePort {
    fn claims(&self) -> &Arc<DashMap<String, HostSessionClaim>> {
        &self.0.claims
    }

    fn restoring_keys(&self) -> &DashMap<String, std::time::Instant> {
        &self.0.restoring_keys
    }

    fn closed_unowned(&self) -> &DashMap<String, std::time::Instant> {
        &self.0.closed_unowned
    }
}
