//! In-memory pty-hosts for the adoption tests: a duplex pipe wired into a real
//! `PtyHostClient` on one end, a small host on the other that answers like the
//! real one and records every frame it receives, per host identity.

use super::*;
use crate::pty_host_client::{wire_client, PtyHostDeps};
use crate::state::types::{HostSessionClaim, FrozenHost};
use crate::state::{host_registry, ChannelPayload};
use dashmap::DashMap;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use termflow_pty_protocol::{
    read_frame, write_frame, Control, Frame, HostRecord, Response, PROTOCOL_MAX, PROTOCOL_MIN,
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
}

#[derive(Clone)]
pub(super) struct HostSpec {
    pub sessions: Vec<SessionMeta>,
    pub list: ListBehavior,
    /// How long connecting takes.
    pub connect_delay: Duration,
    /// The endpoint exists but nothing can be connected to it.
    pub unreachable: bool,
}

impl Default for HostSpec {
    fn default() -> Self {
        Self { sessions: Vec::new(), list: ListBehavior::Answer, connect_delay: Duration::ZERO, unreachable: false }
    }
}

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
            _ => "Other",
        }
    }
}

/// The machine: which hosts are running, what each received, which host
/// processes were started.
pub(super) struct World {
    started: Instant,
    hosts: Mutex<HashMap<String, (HostSpec, Vec<AbortHandle>)>>,
    log: Arc<Mutex<Vec<Recorded>>>,
    /// Endpoints a host process was started for, in order.
    pub started_processes: Mutex<Vec<String>>,
    pub spawn_fails: AtomicBool,
}

impl World {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            started: Instant::now(),
            hosts: Mutex::new(HashMap::new()),
            log: Arc::new(Mutex::new(Vec::new())),
            started_processes: Mutex::new(Vec::new()),
            spawn_fails: AtomicBool::new(false),
        })
    }

    pub fn add_host(&self, endpoint: &str, spec: HostSpec) {
        self.hosts.lock().unwrap().insert(endpoint.to_owned(), (spec, Vec::new()));
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
        let task = tokio::spawn(serve(endpoint.to_owned(), spec.clone(), self.started, self.log.clone(), server));
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

    pub fn count(&self, host: &str, kind: &str) -> usize {
        self.kinds(host).into_iter().filter(|k| *k == kind).count()
    }

    /// Frames of `kind` received by any host.
    pub fn count_everywhere(&self, kind: &str) -> usize {
        self.log.lock().unwrap().iter().filter(|r| r.kind() == kind).count()
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
    server: DuplexStream,
) {
    let (mut rd, mut wr) = tokio::io::split(server);
    while let Ok(Some(frame)) = read_frame(&mut rd).await {
        log.lock().unwrap().push(Recorded { host: host.clone(), at: Instant::now(), frame: frame.clone() });
        let reply = match frame {
            Frame::Ctrl(Control::Disarm { req }) => Some(Response::DisarmAck { req }),
            Frame::Ctrl(Control::ListSessions { req, .. }) => match &spec.list {
                ListBehavior::Answer => Some(Response::SessionList { req, sessions: spec.sessions.clone() }),
                ListBehavior::Never => None,
                ListBehavior::SilentFor(d) if Instant::now() < world_start + *d => None,
                ListBehavior::SilentFor(_) => Some(Response::SessionList { req, sessions: spec.sessions.clone() }),
            },
            Frame::Ctrl(Control::Spawn { req, tab_id, .. }) => Some(Response::Spawned { req, tab_id, pid: 4242 }),
            Frame::Ctrl(Control::AttachAcked { req, tab_id, .. }) => {
                Some(Response::AttachAck { req, tab_id, alive: true, tail_offset: 0 })
            }
            Frame::Ctrl(Control::ArmDetach { req, .. }) => Some(Response::ArmAck { req, deadline_ms: 0 }),
            Frame::Ctrl(Control::Shutdown { req, .. }) => Some(Response::ShutdownAck { req }),
            _ => None,
        };
        if let Some(reply) = reply {
            if write_frame(&mut wr, &Frame::Resp(reply)).await.is_err() {
                break;
            }
        }
    }
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
    pub discovers: AtomicUsize,
    /// Every `connect` the port was asked to make.
    pub connects: Mutex<Vec<(String, HostRole)>>,
    /// Every listing applied: the channel and how many sessions (`None` = unanswered).
    pub listings: Mutex<Vec<(HostChannel, Option<usize>)>>,
    pub disconnects: AtomicUsize,
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
            discovers: AtomicUsize::new(0),
            connects: Mutex::new(Vec::new()),
            listings: Mutex::new(Vec::new()),
            disconnects: AtomicUsize::new(0),
        }))
    }

    pub fn candidates(&self) -> Vec<HostCandidate> {
        self.0.candidates.lock().unwrap().clone()
    }

    pub fn set_candidates(&self, candidates: Vec<HostCandidate>) {
        *self.0.candidates.lock().unwrap() = candidates;
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
            HostChannel::Frozen(id) => self.0.frozen.lock().unwrap().iter().find(|h| h.id == id).map(|h| h.client.clone()),
            _ => self.current_client(),
        }
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
    ) -> Result<Opened, String> {
        self.0.connects.lock().unwrap().push((candidate.endpoint.clone(), role));
        let world = &self.0.world;
        let endpoint = candidate.endpoint.as_str();
        if let Some(spec) = world.spec(endpoint) {
            tokio::time::sleep(spec.connect_delay).await;
        }
        let stream = match world.open(endpoint) {
            Some(stream) => stream,
            None if role == HostRole::Frozen => return Err(format!("nothing answers on {endpoint}")),
            None if candidate.pid.is_some() => {
                return Err("a running pty-host is unreachable; not spawning a duplicate".into())
            }
            None if world.spawn_fails.load(Ordering::SeqCst) => return Err("no valid pty-host binary".into()),
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
        Ok(Opened { client, epoch, build_id: None })
    }

    fn apply_listing(&self, channel: HostChannel, _client: &PtyHostClient, sessions: Option<&[SessionMeta]>) {
        self.0.listings.lock().unwrap().push((channel, sessions.map(<[_]>::len)));
        for meta in sessions.unwrap_or_default() {
            if meta.alive {
                host_registry::reserve_session(&self.0.claims, &meta.tab_id, meta.pid, channel);
            }
        }
    }

    fn publish_current(&self, client: &PtyHostClient) -> Result<(), String> {
        *self.0.current.lock().unwrap() = Some(client.clone());
        if !client.is_alive() {
            *self.0.current.lock().unwrap() = None;
            return Err("pty-host connection lost during setup".into());
        }
        Ok(())
    }

    fn publish_frozen(&self, host: FrozenHost) {
        self.0.frozen.lock().unwrap().push(host);
    }
}
