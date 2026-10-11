//! Only process-boundary adapters; adoption, ordering and boot remain production code.
use super::super::host_adoption::{AdoptionPort, ConnectFailure, Opened};
use super::super::host_lifecycle::{LifecyclePort, SiblingSlot};
use super::super::mcp_handover::{HandoverInputs, HandoverPort};
use super::*;
use crate::pty_host_client::real_process::{connect_only, RealHost};
use crate::pty_host_client::{HostCandidate, HostRole, PtyHostDeps, SessionListing};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub(super) struct HostInfo {
    pub candidate: HostCandidate,
    pub capable: bool,
}
#[derive(Clone)]
pub(super) struct RealPort(pub Arc<PortState>);
pub(super) struct PortState {
    table: HostTable,
    barrier: Barrier,
    flight: tokio::sync::Mutex<()>,
    hosts: Vec<HostInfo>,
    token: String,
    current: Mutex<Option<PtyHostClient>>,
    frozen: Mutex<Vec<FrozenHost>>,
    next: AtomicU64,
    host_terminals: dashmap::DashMap<String, HostChannel>,
    terminals: dashmap::DashMap<String, super::super::Terminal>,
    pub reclaim: McpReclaim,
    pub listings: Mutex<Vec<(HostChannel, Vec<termflow_pty_protocol::SessionMeta>)>>,
    pub late_gate: tokio::sync::Semaphore,
    pub gate_endpoint: Mutex<Option<String>>,
    pub claims: Mutex<Vec<(Instant, Option<termflow_pty_protocol::McpHeld>)>>,
    sibling: SiblingSlot,
}
impl RealPort {
    pub fn new(hosts: &[&RealHost], current: usize) -> Self {
        let infos = hosts
            .iter()
            .enumerate()
            .map(|(i, h)| {
                let record: termflow_pty_protocol::HostRecord =
                    serde_json::from_slice(&std::fs::read(&h.record).unwrap()).unwrap();
                HostInfo {
                    capable: record.capabilities & termflow_pty_protocol::CAP_MCP_HOLD != 0,
                    candidate: HostCandidate {
                        generation: Some(format!("generation-{i}")),
                        endpoint: h.endpoint.clone(),
                        pid: Some(h.child.0.id()),
                        record: Some(record),
                        record_path: Some(h.record.clone()),
                        mtime: std::time::SystemTime::now(),
                        role: if i == current {
                            HostRole::Current
                        } else {
                            HostRole::Frozen
                        },
                    },
                }
            })
            .collect();
        Self(Arc::new(PortState {
            table: HostTable::new(),
            barrier: Barrier::new(),
            flight: tokio::sync::Mutex::new(()),
            hosts: infos,
            token: hosts[0].token.clone(),
            current: Mutex::new(None),
            frozen: Mutex::new(vec![]),
            next: AtomicU64::new(0),
            host_terminals: dashmap::DashMap::new(),
            terminals: dashmap::DashMap::new(),
            reclaim: McpReclaim::new(),
            listings: Mutex::new(vec![]),
            late_gate: tokio::sync::Semaphore::new(0),
            gate_endpoint: Mutex::new(None),
            claims: Mutex::new(vec![]),
            sibling: SiblingSlot::default(),
        }))
    }
    pub fn clients(&self) -> Vec<PtyHostClient> {
        self.current_client()
            .into_iter()
            .chain(self.frozen_hosts().into_iter().map(|h| h.client))
            .collect()
    }
    pub async fn disconnect(&self) {
        for client in self.clients() {
            assert!(client.close_transport().await);
        }
    }
    pub async fn close(&self) {
        for client in self.clients() {
            if client.is_alive() {
                for session in client.list_sessions().await.unwrap() {
                    client.close(&session.tab_id);
                }
                assert!(client.list_sessions().await.unwrap().is_empty());
            }
            assert!(client.close_transport().await);
        }
    }
    pub fn deps(&self) -> PtyHostDeps {
        let (output_tx, _) = tokio::sync::broadcast::channel(128);
        PtyHostDeps {
            lifecycle_token: self.0.token.clone(),
            output_tx,
            output_produced: Arc::new(AtomicU64::new(0)),
            stream_offsets: Arc::new(dashmap::DashMap::new()),
            resolve_process: Arc::new(|_| None),
            on_exit: Arc::new(|_, _, _| {}),
            on_gap: Arc::new(|_| {}),
            on_disconnect: Arc::new(|| {}),
        }
    }
}
impl AdoptionPort for RealPort {
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
        self.0.hosts.iter().map(|h| h.candidate.clone()).collect()
    }
    fn current_endpoint(&self) -> String {
        self.0
            .hosts
            .iter()
            .find(|h| h.candidate.role == HostRole::Current)
            .unwrap()
            .candidate
            .endpoint
            .clone()
    }
    fn current_client(&self) -> Option<PtyHostClient> {
        self.0.current.lock().unwrap().clone()
    }
    fn frozen_hosts(&self) -> Vec<FrozenHost> {
        self.0.frozen.lock().unwrap().clone()
    }
    fn next_frozen_id(&self) -> Result<FrozenId, String> {
        super::super::host_registry::next_frozen_id(&self.0.next)
    }
    fn host_token(&self) -> String {
        self.0.token.clone()
    }
    fn reclaim(&self) -> &McpReclaim {
        &self.0.reclaim
    }
    async fn connect(
        &self,
        candidate: &HostCandidate,
        _role: HostRole,
        frozen: Option<(FrozenId, u64)>,
    ) -> Result<Opened, ConnectFailure> {
        let gated =
            self.0.gate_endpoint.lock().unwrap().as_deref() == Some(candidate.endpoint.as_str());
        if gated {
            self.0.late_gate.acquire().await.unwrap().forget();
        }
        let client = connect_only(
            &candidate.endpoint,
            candidate.pid.expect("owned pid"),
            self.deps(),
        )
        .await
        .map_err(|e| e.to_string())?;
        client.set_mcp_hold(
            self.0
                .hosts
                .iter()
                .find(|h| h.candidate.endpoint == candidate.endpoint)
                .unwrap()
                .capable,
        );
        client.set_attach_acks(true);
        let state = Arc::downgrade(&self.0);
        client.observe_claim(move |held| {
            if let Some(state) = state.upgrade() {
                state.claims.lock().unwrap().push((Instant::now(), held));
            }
        });
        let epoch = match frozen {
            Some((_, epoch)) => epoch,
            None => self.0.table.reserve_epoch()?,
        };
        Ok(Opened {
            client,
            epoch,
            build_id: None,
        })
    }
    fn apply_listing(
        &self,
        channel: HostChannel,
        client: &PtyHostClient,
        listing: Option<&SessionListing>,
    ) {
        if let Some(listing) = listing {
            let duplicates = super::super::host_registry::apply_answered_listing(
                &super::super::host_registry::ListingMaps {
                    host_terminals: &self.0.host_terminals,
                    terminals: &self.0.terminals,
                    keys: self.table().keys(),
                },
                channel,
                client,
                listing,
                std::time::Instant::now(),
            );
            assert!(
                duplicates.is_empty(),
                "isolated hosts unexpectedly duplicated a session key"
            );
            self.0
                .listings
                .lock()
                .unwrap()
                .push((channel, listing.sessions.clone()));
        }
    }
    fn publish_current(&self, client: &PtyHostClient) -> Result<(), String> {
        if !client.is_alive() {
            return Err("owned connection lost".into());
        }
        *self.0.current.lock().unwrap() = Some(client.clone());
        Ok(())
    }
    fn publish_frozen(&self, host: FrozenHost) {
        self.0.frozen.lock().unwrap().push(host);
    }
}
impl LifecyclePort for RealPort {
    async fn connect_for_exit(&self, candidate: &HostCandidate) -> Result<PtyHostClient, String> {
        connect_only(&candidate.endpoint, candidate.pid.unwrap(), self.deps())
            .await
            .map_err(|e| e.to_string())
    }
    fn arm_token(&self) -> String {
        self.0.token.clone()
    }
    fn sibling_slot(&self) -> &SiblingSlot {
        &self.0.sibling
    }
}
pub(super) struct HandoverIo {
    pub port: RealPort,
    pub inputs: HandoverInputs,
    pub lock: Arc<tokio::sync::Mutex<()>>,
}
impl HandoverPort for HandoverIo {
    fn network_op_lock(&self) -> Arc<tokio::sync::Mutex<()>> {
        self.lock.clone()
    }
    fn read_inputs(&self) -> HandoverInputs {
        self.inputs.clone()
    }
    fn host_token(&self) -> String {
        self.port.host_token()
    }
}

pub(super) struct E2eBootIo {
    pub port: RealPort,
    pub bun: std::path::PathBuf,
    pub api: u16,
    pub own_id: String,
    sidecar: Mutex<Option<Sidecar>>,
    pub round_done: Arc<tokio::sync::Notify>,
    pub foreign_once: AtomicBool,
    pub stops: AtomicUsize,
    pub spawns: AtomicUsize,
}
impl E2eBootIo {
    pub fn new(rig: &Rig, port: RealPort) -> Self {
        Self {
            port,
            bun: rig.bun.clone(),
            api: rig.api_port,
            own_id: format!("own-{}", uuid::Uuid::new_v4()),
            sidecar: Mutex::new(None),
            round_done: Arc::new(tokio::sync::Notify::new()),
            foreign_once: AtomicBool::new(false),
            stops: AtomicUsize::new(0),
            spawns: AtomicUsize::new(0),
        }
    }
    pub fn inputs(&self, cfg: NetworkConfig) -> BootInputs {
        BootInputs {
            cfg,
            own_id: self.own_id.clone(),
            reclaim: self.port.reclaim().clone(),
        }
    }
    pub async fn completed(&self) {
        tokio::time::timeout(Duration::from_secs(20), self.round_done.notified())
            .await
            .expect("survivor round completed independently");
    }
}
impl McpBootIo for E2eBootIo {
    fn start_round(&self) -> tokio::task::JoinHandle<()> {
        let port = self.port.clone();
        let signal = self.round_done.clone();
        tokio::spawn(async move {
            super::super::host_adoption::adopt_survivors(&port)
                .await
                .unwrap();
            signal.notify_one();
        })
    }
    fn quiet(&self) -> bool {
        !self.port.barrier().any_in_flight()
    }
    async fn pick_mcp(&self, cfg: &NetworkConfig, own_id: &str, api_port: u16) -> Option<u16> {
        crate::net_ports::pick_mcp_port(
            cfg.mcp_port,
            crate::net_ports::DEFAULT_SPAN,
            own_id,
            &[api_port],
        )
        .await
    }
    async fn spawn(&self, cfg: &NetworkConfig, port: u16) -> bool {
        self.spawns.fetch_add(1, Ordering::SeqCst);
        let foreign = self.foreign_once.swap(false, Ordering::SeqCst);
        let id = if foreign { "foreign-057" } else { &self.own_id };
        let (launch, _) =
            crate::mcp_sidecar::mcp_launch_env(cfg, crate::profile::current().integrity);
        let mut s = Sidecar::spawn(
            &self.bun,
            self.api,
            port,
            &launch.bind_host,
            launch.auth_token.as_deref(),
            id,
        );
        s.wait_listening(port, id).await;
        *self.sidecar.lock().unwrap() = Some(s);
        true
    }
    async fn owns(&self, own_id: &str, port: u16) -> crate::network_commands::PortOwner {
        crate::network_commands::probe_port_owner(port, own_id).await
    }
    fn stop(&self) {
        self.stops.fetch_add(1, Ordering::SeqCst);
        self.sidecar.lock().unwrap().take();
    }
}
