//! One generation-fenced app transport per stable terminal identity; probes are separate.
use super::{
    auth::{AuthBinding, BoxFuture, CredentialCipher, SecretKind, SecretSink},
    known_hosts::{lookup_token, KnownHosts, Verdict},
};
use parking_lot::{Mutex, RwLock};
use russh::{
    client,
    keys::{
        agent::client::{AgentClient, AgentStream},
        PrivateKeyWithHashAlg, PublicKeyOrCertificate,
    },
    ChannelMsg,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    future::Future,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    sync::{oneshot, watch},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "kebab-case")]
pub enum SessionError {
    NotConnected,
    NotFound,
    Cancelled,
    StaleAttempt,
    OwnerRetired,
    AdmissionClosed,
    InvalidTarget,
    HostKeyChanged,
    HostKeyRevoked,
    HostCertificateUnsupported,
    KnownHostsMalformed { line: usize },
    KnownHostsUnreadable,
    TrustWriteFailed,
    TrustAlreadyPinned,
    AuthRejected,
    AgentUnavailable,
    CapabilityUnavailable,
    TimedOut,
    TransportClosed,
    OutputTooLarge,
    MissingExitStatus,
    IdentityUnreadable,
    UnsupportedAuthentication,
    RememberUnavailable,
    StoreUnavailable,
}
impl SessionError {
    /// The kebab-case code, identical to the serde `code` tag. Snapshots carry it as
    /// `errorCode` so readers never match `reason()` text.
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotConnected => "not-connected",
            Self::NotFound => "not-found",
            Self::Cancelled => "cancelled",
            Self::StaleAttempt => "stale-attempt",
            Self::OwnerRetired => "owner-retired",
            Self::AdmissionClosed => "admission-closed",
            Self::InvalidTarget => "invalid-target",
            Self::HostKeyChanged => "host-key-changed",
            Self::HostKeyRevoked => "host-key-revoked",
            Self::HostCertificateUnsupported => "host-certificate-unsupported",
            Self::KnownHostsMalformed { .. } => "known-hosts-malformed",
            Self::KnownHostsUnreadable => "known-hosts-unreadable",
            Self::TrustWriteFailed => "trust-write-failed",
            Self::TrustAlreadyPinned => "trust-already-pinned",
            Self::AuthRejected => "auth-rejected",
            Self::AgentUnavailable => "agent-unavailable",
            Self::CapabilityUnavailable => "capability-unavailable",
            Self::TimedOut => "timed-out",
            Self::TransportClosed => "transport-closed",
            Self::OutputTooLarge => "output-too-large",
            Self::MissingExitStatus => "missing-exit-status",
            Self::IdentityUnreadable => "identity-unreadable",
            Self::UnsupportedAuthentication => "unsupported-authentication",
            Self::RememberUnavailable => "remember-unavailable",
            Self::StoreUnavailable => "store-unavailable",
        }
    }
    pub fn reason(&self) -> String {
        match self {
            Self::NotConnected => "The SSH connection is not open. Try again.".into(),
            Self::NotFound => "The saved SSH connection could not be found. It may have been deleted or changed.".into(),
            Self::Cancelled => "The SSH attempt was cancelled.".into(),
            Self::StaleAttempt => "This SSH attempt is no longer current. Try again.".into(),
            Self::OwnerRetired => "The SSH attempt was closed. Try again.".into(),
            Self::AdmissionClosed => "TermFlow is not accepting new SSH attempts. Reopen the app and try again.".into(),
            Self::InvalidTarget => "The SSH destination is not valid. Check the saved host, port, user and jump host settings.".into(),
            Self::HostKeyChanged => "The host key changed. Confirm the new fingerprint with the server's administrator before updating ~/.ssh/known_hosts. There is no override.".into(),
            Self::HostKeyRevoked => "The host key has been revoked. Contact the server's administrator before trying again.".into(),
            Self::HostCertificateUnsupported => "This app does not support host certificate trust. Ask the server's administrator about a supported host key.".into(),
            Self::KnownHostsMalformed { line } => format!("An entry in known_hosts could not be read at line {line}. Repair the file before connecting."),
            Self::KnownHostsUnreadable => "Could not read known_hosts. Check that the file is accessible.".into(),
            Self::TrustWriteFailed => "Could not save host trust safely. Check access to known_hosts before retrying.".into(),
            Self::TrustAlreadyPinned => "The host already has a saved key. Try again to verify it.".into(),
            Self::AuthRejected => "Authentication was not accepted. Check the server's allowed methods and the saved sign-in settings.".into(),
            Self::AgentUnavailable => "The OpenSSH agent could not sign in. Check that it is running, unlocked and has the correct key loaded.".into(),
            Self::CapabilityUnavailable => "The server did not allow a required SSH operation. If using a jump host, check that it allows forwarding to the target.".into(),
            Self::TimedOut => "The SSH connection timed out. Check the network and that the SSH service is listening on the configured port.".into(),
            Self::TransportClosed => "Could not open or keep the SSH connection. Check the host, port and network access.".into(),
            Self::OutputTooLarge => "The SSH response was too large. Try an operation that returns less output.".into(),
            Self::MissingExitStatus => "The server did not report how the command ended. Check its SSH logs before retrying.".into(),
            Self::IdentityUnreadable => "Could not read the selected key file. Check its location, permissions and format.".into(),
            Self::UnsupportedAuthentication => "This sign-in method is not supported. Check which methods the server allows and select a supported one.".into(),
            Self::RememberUnavailable => "The credential was not saved. Check access to the system keyring before using Remember again.".into(),
            Self::StoreUnavailable => "The SSH connection store is unavailable. Check that saved connections can be opened.".into(),
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AuthMethod {
    Key,
    Agent,
    Password,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHop {
    pub connection_id: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: AuthMethod,
    pub identity_file: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionTarget {
    pub hops: Vec<SessionHop>,
}
impl SessionTarget {
    pub(crate) fn validate(&mut self, connection: &str) -> Result<(), SessionError> {
        if self.hops.is_empty()
            || self.hops.len() > 2
            || self
                .hops
                .last()
                .is_none_or(|h| h.connection_id != connection)
        {
            return Err(SessionError::InvalidTarget);
        }
        if self.hops.len() == 2 && self.hops[0].connection_id == self.hops[1].connection_id {
            return Err(SessionError::InvalidTarget);
        }
        for h in &mut self.hops {
            h.host = super::known_hosts::canonical_host(&h.host)?;
            if h.host.is_empty()
                || h.host.starts_with('-')
                || h.host.chars().any(|c| c.is_whitespace() || c.is_control())
                || h.port == 0
                || h.user.is_empty()
            {
                return Err(SessionError::InvalidTarget);
            }
        }
        Ok(())
    }
}
pub trait TargetSource: Send + Sync {
    fn resolve<'a>(
        &'a self,
        connection_id: &'a str,
    ) -> BoxFuture<'a, Result<SessionTarget, SessionError>>;
}
pub struct UnavailableTargets;
impl TargetSource for UnavailableTargets {
    fn resolve<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<SessionTarget, SessionError>> {
        Box::pin(async { Err(SessionError::StoreUnavailable) })
    }
}
pub trait Stream: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> Stream for T {}
pub type BoxStream = Box<dyn Stream>;
pub type DynamicAgent = AgentClient<Box<dyn AgentStream + Send + Unpin>>;
pub trait StreamFactory: Send + Sync {
    fn connect<'a>(&'a self, hop: &'a SessionHop)
        -> BoxFuture<'a, Result<BoxStream, SessionError>>;
}
pub trait AgentFactory: Send + Sync {
    fn connect(&self) -> BoxFuture<'_, Result<DynamicAgent, SessionError>>;
}
pub struct NativeStreams;
impl StreamFactory for NativeStreams {
    fn connect<'a>(
        &'a self,
        hop: &'a SessionHop,
    ) -> BoxFuture<'a, Result<BoxStream, SessionError>> {
        Box::pin(async move {
            let stream = tokio::net::TcpStream::connect((hop.host.as_str(), hop.port))
                .await
                .map_err(|_| SessionError::TransportClosed)?;
            Ok(Box::new(stream) as BoxStream)
        })
    }
}
pub struct NativeAgent;
impl AgentFactory for NativeAgent {
    fn connect(&self) -> BoxFuture<'_, Result<DynamicAgent, SessionError>> {
        Box::pin(async {
            #[cfg(unix)]
            let agent = AgentClient::connect_env().await;
            #[cfg(windows)]
            let agent = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await;
            agent
                .map(|a| a.dynamic())
                .map_err(|_| SessionError::AgentUnavailable)
        })
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionState {
    Connecting,
    NeedsSecret,
    NeedsHostkey,
    Connected,
    Disconnected,
    Error,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Gate {
    Pending,
    Verified,
    NetworkError,
    Blocked,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostsPaths {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jump: Option<String>,
    pub target: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKey {
    pub algorithm: String,
    pub fingerprint_sha256: String,
    pub changed: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptTarget {
    pub connection_id: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub hop: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub probe_id: Option<String>,
    pub connection_id: String,
    pub state: SessionState,
    pub generation: u64,
    pub revision: u64,
    pub gate: Gate,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Code for `reason` when it has one (a `SessionError` code, or
    /// `saved-credential-unavailable`). Free-text disconnect reasons carry none,
    /// including "SSH transport closed": readers show their generic copy for it,
    /// as they did before codes existed. Written only through `set_reason`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub known_hosts_paths: Option<KnownHostsPaths>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret_kind: Option<SecretKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_key: Option<HostKey>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_target: Option<PromptTarget>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_id: Option<String>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SessionPhase {
    pub generation: u64,
    pub state: SessionState,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LaunchState {
    Typed,
    Running,
    Ended,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CurrentLaunch {
    pub generation: u64,
    pub state: Option<LaunchState>,
    pub connected: bool,
    pub process_id: Option<String>,
}
pub trait EventSink: Send + Sync {
    fn emit(&self, event: &'static str, view: &SessionView);
}
pub struct NoEvents;
impl EventSink for NoEvents {
    fn emit(&self, _: &'static str, _: &SessionView) {}
}
struct Pending {
    kind: PromptKind,
    sender: oneshot::Sender<Answer>,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum PromptKind {
    Secret,
    Trust,
}
enum Answer {
    Secret(Zeroizing<String>, bool),
    Trust(bool),
}
struct EntryState {
    view: SessionView,
    pending: Option<Pending>,
    authenticated: bool,
    unsaved_secret_warning: bool,
    launch: Option<LaunchState>,
    launch_seq: u64,
    process_id: Option<String>,
    transport: Option<Arc<SshSession>>,
}
struct Entry {
    owner_receipt: Option<u64>,
    inner: Mutex<EntryState>,
    cancel: CancellationToken,
    transitions: watch::Sender<SessionPhase>,
    task: Mutex<Option<JoinHandle<()>>>,
    events: Arc<dyn EventSink>,
}
impl Entry {
    fn update(&self, operation: impl FnOnce(&mut EntryState)) {
        let mut state = self.inner.lock();
        if self.cancel.is_cancelled() {
            return;
        }
        let previous = state.view.clone();
        let was_connected = state.view.state == SessionState::Connected;
        operation(&mut state);
        if was_connected && state.view.state != SessionState::Connected {
            self.cancel.cancel();
            state.transport.take();
            state.pending.take();
            state.authenticated = false;
        }
        if state.view != previous {
            self.publish_locked(&mut state);
        }
    }
    fn publish_locked(&self, state: &mut EntryState) {
        state.view.revision += 1;
        self.transitions.send_replace(SessionPhase {
            generation: state.view.generation,
            state: state.view.state,
        });
        // Sink must not call back into the registry. Tauri emit queues a redacted clone.
        self.events.emit(
            if state.view.probe_id.is_some() {
                "ssh-test:state"
            } else {
                "ssh-session:state"
            },
            &state.view,
        );
    }
    fn view(&self) -> SessionView {
        self.inner.lock().view.clone()
    }
    fn invalidate(&self, reason: Option<String>) {
        let mut s = self.inner.lock();
        // The first terminal transition owns the diagnostic. Late transport
        // callbacks/retirement must not erase a local-shell exit reason.
        if self.cancel.is_cancelled() {
            return;
        }
        let previous = s.view.clone();
        self.cancel.cancel();
        s.pending.take();
        s.authenticated = false;
        s.transport.take();
        let refusal = s.view.state == SessionState::Error;
        let host_key = refusal.then(|| s.view.host_key.clone()).flatten();
        let prompt_target = refusal.then(|| s.view.prompt_target.clone()).flatten();
        if !refusal {
            s.view.state = SessionState::Disconnected;
            set_reason(&mut s.view, reason, None);
            s.view.gate = Gate::Blocked;
        }
        clear_prompt(&mut s.view);
        s.view.host_key = host_key;
        s.view.prompt_target = prompt_target;
        if s.view != previous {
            self.publish_locked(&mut s);
        }
    }
    async fn wait<T>(
        &self,
        duration: Duration,
        future: impl Future<Output = Result<T, SessionError>>,
    ) -> Result<T, SessionError> {
        tokio::select! { biased; _ = self.cancel.cancelled() => Err(SessionError::Cancelled), result = tokio::time::timeout(duration, future) => result.map_err(|_| SessionError::TimedOut)? }
    }
    /// Network budget excludes time spent awaiting an explicit human trust prompt.
    async fn handshake<T>(
        &self,
        future: impl Future<Output = Result<T, SessionError>>,
    ) -> Result<T, SessionError> {
        tokio::pin!(future);
        let mut changes = self.transitions.subscribe();
        let mut remaining = Duration::from_secs(15);
        loop {
            let prompting = matches!(
                changes.borrow_and_update().state,
                SessionState::NeedsHostkey | SessionState::NeedsSecret
            );
            let start = tokio::time::Instant::now();
            tokio::select! { biased;
                _ = self.cancel.cancelled() => return Err(SessionError::Cancelled),
                result = &mut future => return result,
                _ = tokio::time::sleep(remaining), if !prompting => return Err(SessionError::TimedOut),
                _ = changes.changed() => {},
            }
            if !prompting {
                remaining = remaining.saturating_sub(start.elapsed());
            }
        }
    }
    async fn prompt(
        &self,
        kind: PromptKind,
        target: PromptTarget,
        secret_kind: Option<SecretKind>,
        host_key: Option<HostKey>,
        reason: Option<(String, &'static str)>,
    ) -> Result<Answer, SessionError> {
        let (send, receive) = oneshot::channel();
        {
            let mut s = self.inner.lock();
            if self.cancel.is_cancelled() {
                return Err(SessionError::Cancelled);
            }
            s.view.state = if kind == PromptKind::Secret {
                SessionState::NeedsSecret
            } else {
                SessionState::NeedsHostkey
            };
            s.view.prompt_id = Some(uuid::Uuid::new_v4().to_string());
            s.view.prompt_target = Some(target);
            s.view.secret_kind = secret_kind;
            s.view.host_key = host_key;
            let (reason, code) = reason.unzip();
            set_reason(&mut s.view, reason, code);
            s.pending = Some(Pending { kind, sender: send });
            self.publish_locked(&mut s);
        }
        self.wait(Duration::from_secs(300), async {
            receive.await.map_err(|_| SessionError::Cancelled)
        })
        .await
    }
    fn submit(
        &self,
        generation: Option<u64>,
        prompt_id: Option<&str>,
        kind: PromptKind,
        answer: Answer,
    ) -> Result<(), SessionError> {
        let mut s = self.inner.lock();
        if self.cancel.is_cancelled()
            || generation.is_some_and(|g| g != s.view.generation)
            || prompt_id.is_some_and(|p| s.view.prompt_id.as_deref() != Some(p))
            || s.pending.as_ref().is_none_or(|p| p.kind != kind)
        {
            return Err(SessionError::StaleAttempt);
        }
        // Exactly one outstanding responder; compatibility without promptId is unambiguous.
        let pending = s.pending.take().ok_or(SessionError::StaleAttempt)?;
        clear_prompt(&mut s.view);
        s.view.state = SessionState::Connecting;
        self.publish_locked(&mut s);
        pending
            .sender
            .send(answer)
            .map_err(|_| SessionError::StaleAttempt)
    }
}
/// The runtime that owns session engines: the caller's Tokio context when it
/// has one, otherwise Tauri's shared runtime (sync commands have none).
fn engine_runtime() -> tokio::runtime::Handle {
    tokio::runtime::Handle::try_current()
        .unwrap_or_else(|_| tauri::async_runtime::handle().inner().clone())
}
/// Prompt warning code: a saved secret could not be read, so the prompt asks again.
pub(crate) const SAVED_CREDENTIAL_UNAVAILABLE: &str = "saved-credential-unavailable";
/// The only writer of `view.reason`: the code travels with the text it names.
fn set_reason(view: &mut SessionView, reason: Option<String>, code: Option<&str>) {
    view.error_code = reason.as_ref().and(code).map(str::to_string);
    view.reason = reason;
}
/// Sets `reason` and `errorCode` from one error.
fn set_error_reason(view: &mut SessionView, error: Option<&SessionError>) {
    set_reason(
        view,
        error.map(SessionError::reason),
        error.map(SessionError::code),
    );
}
fn clear_prompt(view: &mut SessionView) {
    view.prompt_id = None;
    view.prompt_target = None;
    view.secret_kind = None;
    view.host_key = None;
}

pub struct Dependencies {
    pub targets: Arc<dyn TargetSource>,
    pub streams: Arc<dyn StreamFactory>,
    pub agents: Arc<dyn AgentFactory>,
    pub secrets: Arc<dyn SecretSink>,
    pub events: Arc<dyn EventSink>,
    pub known_hosts: KnownHosts,
    pub home: PathBuf,
}
pub(super) fn native_home() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .unwrap_or_default()
}

impl Dependencies {
    pub fn native(
        events: Arc<dyn EventSink>,
        store: crate::ssh::store::Store,
        changed: Arc<dyn Fn(&crate::ssh::store::Reply) + Send + Sync>,
    ) -> Self {
        let home = native_home();
        let adapter = Arc::new(super::store_adapter::StoreAdapter::new(
            store,
            home.clone(),
            changed,
        ));
        Self {
            targets: adapter.clone(),
            streams: Arc::new(NativeStreams),
            agents: Arc::new(NativeAgent),
            secrets: adapter,
            events,
            known_hosts: KnownHosts {
                path: home.join(".ssh/known_hosts"),
            },
            home,
        }
    }
}
struct RegistryState {
    panes: HashMap<String, Arc<Entry>>,
    probes: HashMap<String, Arc<Entry>>,
    admitting: bool,
}
pub struct SessionRegistry {
    inner: Mutex<RegistryState>,
    next: AtomicU64,
    retired: Mutex<Vec<JoinHandle<()>>>,
    deps: RwLock<Arc<Dependencies>>,
}
impl SessionRegistry {
    pub fn new(deps: Dependencies) -> Self {
        Self {
            inner: Mutex::new(RegistryState {
                panes: HashMap::new(),
                probes: HashMap::new(),
                admitting: true,
            }),
            next: AtomicU64::new(1),
            retired: Mutex::new(Vec::new()),
            deps: RwLock::new(Arc::new(deps)),
        }
    }
    /// Install the 065 adapter before admitting any sessions. Never swaps dependencies under an attempt.
    pub fn configure(&self, deps: Dependencies) -> Result<(), SessionError> {
        let registry = self.inner.lock();
        if !registry.panes.is_empty() || !registry.probes.is_empty() {
            return Err(SessionError::StaleAttempt);
        }
        *self.deps.write() = Arc::new(deps);
        Ok(())
    }
    fn entry(&self, id: &str, probe: bool) -> Result<Arc<Entry>, SessionError> {
        let s = self.inner.lock();
        (if probe { &s.probes } else { &s.panes })
            .get(id)
            .cloned()
            .ok_or(SessionError::NotFound)
    }
    pub fn state(&self, id: &str, probe: bool) -> Result<SessionView, SessionError> {
        Ok(self.entry(id, probe)?.view())
    }
    /// Admission and final membership check run under the registry fence. The callback
    /// may briefly lock ownership; ownership effects MUST dispatch after dropping it.
    pub fn open(
        self: &Arc<Self>,
        id: &str,
        connection: &str,
        probe: bool,
        owner: impl Fn() -> bool,
    ) -> Result<SessionView, SessionError> {
        self.open_owned(id, connection, probe, None, owner)
    }
    pub fn open_owned(
        self: &Arc<Self>,
        id: &str,
        connection: &str,
        probe: bool,
        owner_receipt: Option<u64>,
        owner: impl Fn() -> bool,
    ) -> Result<SessionView, SessionError> {
        let mut registry = self.inner.lock();
        if !registry.admitting {
            return Err(SessionError::AdmissionClosed);
        }
        if !probe && !owner() {
            return Err(SessionError::OwnerRetired);
        }
        let map = if probe {
            &mut registry.probes
        } else {
            &mut registry.panes
        };
        if let Some(entry) = map.get(id) {
            if entry.view().connection_id == connection && entry.owner_receipt == owner_receipt {
                return Ok(entry.view());
            }
        }
        if let Some(old) = map.remove(id) {
            self.retire_entry(&old);
        }
        let generation = self.next.fetch_add(1, Ordering::Relaxed);
        let view = SessionView {
            terminal_id: (!probe).then(|| id.into()),
            probe_id: probe.then(|| id.into()),
            connection_id: connection.into(),
            state: SessionState::Connecting,
            generation,
            revision: 0,
            gate: Gate::Pending,
            reason: None,
            error_code: None,
            known_hosts_paths: None,
            secret_kind: None,
            host_key: None,
            prompt_target: None,
            prompt_id: None,
        };
        let (transitions, _) = watch::channel(SessionPhase {
            generation,
            state: SessionState::Connecting,
        });
        let deps = self.deps.read().clone();
        let entry = Arc::new(Entry {
            owner_receipt,
            inner: Mutex::new(EntryState {
                view,
                pending: None,
                authenticated: false,
                unsaved_secret_warning: false,
                launch: None,
                launch_seq: 0,
                process_id: None,
                transport: None,
            }),
            cancel: CancellationToken::new(),
            transitions,
            task: Mutex::new(None),
            events: deps.events.clone(),
        });
        map.insert(id.into(), entry.clone());
        if !probe && !owner() {
            map.remove(id);
            entry.invalidate(None);
            return Err(SessionError::OwnerRetired);
        }
        let result = entry.view();
        let task_entry = entry.clone();
        // Tauri runs sync commands on the main thread, outside any Tokio
        // context, so a bare tokio::spawn panics there and aborts the app.
        let task = engine_runtime().spawn(async move {
            run_engine(task_entry, deps).await;
        });
        *entry.task.lock() = Some(task);
        Ok(result)
    }
    pub fn probe(self: &Arc<Self>, connection: &str) -> Result<String, SessionError> {
        let id = uuid::Uuid::new_v4().to_string();
        self.open(&id, connection, true, || true)?;
        Ok(id)
    }
    pub fn close(
        &self,
        id: &str,
        probe: bool,
        generation: Option<u64>,
    ) -> Result<(), SessionError> {
        let mut registry = self.inner.lock();
        let map = if probe {
            &mut registry.probes
        } else {
            &mut registry.panes
        };
        if let Some(entry) = map.get(id) {
            if generation.is_some_and(|g| g != entry.view().generation) {
                return Err(SessionError::StaleAttempt);
            }
        }
        if let Some(entry) = map.remove(id) {
            self.retire_entry(&entry);
        }
        Ok(())
    }
    fn retire_entry(&self, entry: &Entry) {
        entry.invalidate(None);
        if let Some(task) = entry.task.lock().take() {
            let mut retired = self.retired.lock();
            retired.retain(|task| !task.is_finished());
            retired.push(task);
        }
    }
    pub fn retire_owner(&self, id: &str, receipt: u64) {
        let mut registry = self.inner.lock();
        if registry
            .panes
            .get(id)
            .is_some_and(|e| e.owner_receipt == Some(receipt))
        {
            if let Some(entry) = registry.panes.remove(id) {
                self.retire_entry(&entry);
            }
        }
    }
    pub fn reconnect(
        self: &Arc<Self>,
        id: &str,
        owner: impl Fn() -> bool,
    ) -> Result<SessionView, SessionError> {
        let receipt = self.entry(id, false)?.owner_receipt;
        self.reconnect_owned(id, receipt, owner)
    }
    pub fn reconnect_owned(
        self: &Arc<Self>,
        id: &str,
        receipt: Option<u64>,
        owner: impl Fn() -> bool,
    ) -> Result<SessionView, SessionError> {
        if !owner() {
            return Err(SessionError::OwnerRetired);
        }
        let view = self.state(id, false)?;
        self.close(id, false, Some(view.generation))?;
        self.open_owned(id, &view.connection_id, false, receipt, owner)
    }
    pub fn submit_secret(
        &self,
        id: &str,
        probe: bool,
        generation: Option<u64>,
        prompt: Option<&str>,
        secret: String,
        remember: bool,
    ) -> Result<(), SessionError> {
        self.entry(id, probe)?.submit(
            generation,
            prompt,
            PromptKind::Secret,
            Answer::Secret(Zeroizing::new(secret), remember),
        )
    }
    pub fn trust_host(
        &self,
        id: &str,
        probe: bool,
        generation: Option<u64>,
        prompt: Option<&str>,
        accept: bool,
    ) -> Result<(), SessionError> {
        self.entry(id, probe)?
            .submit(generation, prompt, PromptKind::Trust, Answer::Trust(accept))
    }
    pub fn subscribe_transitions(
        &self,
        terminal_id: &str,
    ) -> Result<watch::Receiver<SessionPhase>, SessionError> {
        Ok(self.entry(terminal_id, false)?.transitions.subscribe())
    }
    /// Hold the registry fence across the launch transaction. Take the input
    /// barrier inside the callback, not before entering this method:
    /// open_owned's membership callback also takes it in that order.
    pub(super) fn with_launch_session<T, E>(
        &self,
        terminal_id: &str,
        f: impl FnOnce(Option<(&SessionView, Option<u64>, bool, &dyn Fn() -> SessionView)>) -> Result<T, E>,
    ) -> Result<T, E> {
        let registry = self.inner.lock();
        let Some(entry) = registry.panes.get(terminal_id) else {
            return f(None);
        };
        let view = entry.view();
        let cancelled = entry.cancel.is_cancelled();
        let cancel = || {
            entry.invalidate(Some("SSH launch cancelled".into()));
            entry.view()
        };
        f(Some((&view, entry.owner_receipt, cancelled, &cancel)))
    }

    pub fn current_launch(&self, terminal_id: &str) -> Option<CurrentLaunch> {
        let e = self.entry(terminal_id, false).ok()?;
        let s = e.inner.lock();
        Some(CurrentLaunch {
            generation: s.view.generation,
            state: s.launch,
            connected: s.view.state == SessionState::Connected && !e.cancel.is_cancelled(),
            process_id: s.process_id.clone(),
        })
    }
    pub fn on_launch_lifecycle(
        &self,
        terminal_id: &str,
        generation: u64,
        launch_seq: u64,
        launch: LaunchState,
        process_id: Option<String>,
    ) -> Result<(), SessionError> {
        let e = self.entry(terminal_id, false)?;
        let mut s = e.inner.lock();
        if s.view.generation != generation || launch_seq <= s.launch_seq || e.cancel.is_cancelled()
        {
            return Err(SessionError::StaleAttempt);
        }
        s.launch_seq = launch_seq;
        s.launch = Some(launch);
        s.process_id = process_id;
        if launch == LaunchState::Ended {
            e.cancel.cancel();
            s.pending.take();
            s.transport.take();
            s.authenticated = false;
            s.view.state = SessionState::Disconnected;
            s.view.gate = Gate::Blocked;
            set_reason(&mut s.view, Some("ssh in the terminal ended".into()), None);
            clear_prompt(&mut s.view);
        } else if s.authenticated && launch == LaunchState::Running {
            s.view.state = SessionState::Connected;
            let warning = s.unsaved_secret_warning;
            set_error_reason(
                &mut s.view,
                warning.then_some(&SessionError::RememberUnavailable),
            );
        }
        e.publish_locked(&mut s);
        Ok(())
    }
    pub fn disconnect(&self, id: &str, reason: &str) {
        if let Ok(e) = self.entry(id, false) {
            e.invalidate(Some(reason.into()));
        }
    }
    pub fn disconnect_generation(&self, id: &str, generation: u64, reason: &str) {
        let registry = self.inner.lock();
        if let Some(e) = registry.panes.get(id) {
            if e.view().generation == generation {
                e.invalidate(Some(reason.into()));
            }
        }
    }
    pub fn lease(&self, id: &str) -> Result<Arc<SshSession>, SessionError> {
        let e = self.entry(id, false)?;
        let s = e.inner.lock();
        if e.cancel.is_cancelled() || s.view.state != SessionState::Connected {
            return Err(SessionError::NotConnected);
        }
        s.transport.clone().ok_or(SessionError::NotConnected)
    }
    pub fn owner_map(&self) -> HashMap<String, (String, SessionState)> {
        self.inner
            .lock()
            .panes
            .iter()
            .map(|(id, e)| {
                let v = e.view();
                (id.clone(), (v.connection_id, v.state))
            })
            .collect()
    }
    pub fn reconcile(&self, owner: impl Fn(&str) -> bool) {
        self.reconcile_owners(|id, _| owner(id));
    }
    pub fn reconcile_owners(&self, owner: impl Fn(&str, Option<u64>) -> bool) {
        let mut registry = self.inner.lock();
        registry.panes.retain(|id, e| {
            if owner(id, e.owner_receipt) {
                true
            } else {
                self.retire_entry(e);
                false
            }
        });
    }
    pub async fn shutdown(&self) {
        let entries = {
            let mut s = self.inner.lock();
            s.admitting = false;
            let mut entries: Vec<_> = s.panes.drain().map(|(_, e)| e).collect();
            entries.extend(s.probes.drain().map(|(_, e)| e));
            entries
        };
        let mut tasks: Vec<_> = self.retired.lock().drain(..).collect();
        for e in entries {
            e.invalidate(None);
            if let Some(task) = e.task.lock().take() {
                tasks.push(task);
            }
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        for mut task in tasks {
            if tokio::time::timeout_at(deadline, &mut task).await.is_err() {
                task.abort();
                let _ = task.await;
            }
        }
    }
}

struct ClientHandler {
    entry: Arc<Entry>,
    deps: Arc<Dependencies>,
    hop: SessionHop,
    is_target: bool,
}
impl client::Handler for ClientHandler {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let result = self.verify_key(key).await;
        if let Err(error) = &result {
            if matches!(
                error,
                SessionError::HostKeyChanged | SessionError::HostKeyRevoked
            ) {
                if let PublicKeyOrCertificate::PublicKey { key, .. } = key {
                    self.entry.update(|s| {
                        apply_failure(s, error.clone());
                        s.view.host_key = Some(HostKey {
                            algorithm: key.algorithm().to_string(),
                            fingerprint_sha256: key
                                .fingerprint(ssh_key::HashAlg::Sha256)
                                .to_string(),
                            changed: true,
                        });
                        s.view.prompt_target = Some(prompt_target(&self.hop, self.is_target));
                    });
                }
            } else {
                fail(&self.entry, error.clone());
            }
        }
        Ok(result.is_ok())
    }
    async fn disconnected(
        &mut self,
        _: client::DisconnectReason<Self::Error>,
    ) -> Result<(), Self::Error> {
        self.entry.invalidate(Some("SSH transport closed".into()));
        Ok(())
    }
}
impl ClientHandler {
    async fn verify_key(&self, key: &PublicKeyOrCertificate) -> Result<(), SessionError> {
        let PublicKeyOrCertificate::PublicKey { key, .. } = key else {
            return Err(SessionError::HostCertificateUnsupported);
        };
        if !acceptable_key(key) {
            return Err(SessionError::UnsupportedAuthentication);
        }
        let token = lookup_token(&self.hop.host, self.hop.port);
        let verdict = self
            .deps
            .known_hosts
            .verify(token.clone(), key.clone())
            .await?;
        if verdict == Verdict::Unknown {
            self.entry.update(|s| s.view.gate = Gate::Blocked);
            let host_key = HostKey {
                algorithm: key.algorithm().to_string(),
                fingerprint_sha256: key.fingerprint(ssh_key::HashAlg::Sha256).to_string(),
                changed: false,
            };
            match self
                .entry
                .prompt(
                    PromptKind::Trust,
                    prompt_target(&self.hop, self.is_target),
                    None,
                    Some(host_key),
                    None,
                )
                .await?
            {
                Answer::Trust(true) => {
                    match self
                        .deps
                        .known_hosts
                        .trust(token.clone(), key.clone(), self.entry.cancel.clone())
                        .await
                    {
                        Ok(()) => {}
                        Err(SessionError::TrustAlreadyPinned) => {} // concurrent identical Trust: reverify, never append twice
                        Err(e) => return Err(e),
                    }
                }
                _ => return Err(SessionError::Cancelled),
            }
        }
        // Fresh revalidation is required before releasing the launch gate.
        if self.deps.known_hosts.verify(token, key.clone()).await? != Verdict::Verified {
            return Err(SessionError::TrustWriteFailed);
        }
        if self.entry.cancel.is_cancelled() {
            return Err(SessionError::Cancelled);
        }
        if self.is_target {
            let path = self.deps.known_hosts.path.to_string_lossy().into_owned();
            self.entry.update(|s| {
                s.view.gate = Gate::Verified;
                s.view.known_hosts_paths = Some(KnownHostsPaths {
                    jump: (s
                        .view
                        .known_hosts_paths
                        .as_ref()
                        .is_some_and(|p| p.jump.is_some()))
                    .then(|| path.clone()),
                    target: path.clone(),
                });
            });
        }
        Ok(())
    }
}
fn acceptable_key(key: &ssh_key::PublicKey) -> bool {
    if matches!(key.algorithm(), ssh_key::Algorithm::Dsa) {
        return false;
    }
    if let Some(rsa) = key.key_data().rsa() {
        return rsa
            .n()
            .as_positive_bytes()
            .and_then(|b| {
                b.split_first()
                    .map(|(msb, rest)| rest.len() * 8 + 8 - msb.leading_zeros() as usize)
            })
            .unwrap_or(0)
            >= 2048;
    }
    true
}
fn prompt_target(hop: &SessionHop, target: bool) -> PromptTarget {
    PromptTarget {
        connection_id: hop.connection_id.clone(),
        host: hop.host.clone(),
        port: hop.port,
        user: hop.user.clone(),
        hop: if target { "target" } else { "jump" }.into(),
    }
}
fn fail(entry: &Entry, error: SessionError) {
    entry.update(|s| apply_failure(s, error));
}
fn apply_failure(s: &mut EntryState, error: SessionError) {
    // Never relabel a security refusal from the callback as a network error.
    if s.view.state == SessionState::Error {
        return;
    }
    s.view.state = if error == SessionError::Cancelled {
        SessionState::Disconnected
    } else {
        SessionState::Error
    };
    s.view.gate = if matches!(
        error,
        SessionError::TransportClosed | SessionError::TimedOut
    ) && s.view.gate == Gate::Pending
    {
        Gate::NetworkError
    } else {
        Gate::Blocked
    };
    set_error_reason(&mut s.view, Some(&error));
    s.pending.take();
    clear_prompt(&mut s.view);
}
async fn run_engine(entry: Arc<Entry>, deps: Arc<Dependencies>) {
    let result = connect_engine(entry.clone(), deps).await;
    if let Err(error) = result {
        fail(&entry, error);
    }
}
async fn connect_engine(entry: Arc<Entry>, deps: Arc<Dependencies>) -> Result<(), SessionError> {
    let connection = entry.view().connection_id;
    let mut target = entry
        .wait(Duration::from_secs(15), deps.targets.resolve(&connection))
        .await?;
    target.validate(&connection)?;
    if target.hops.len() == 2 {
        entry.update(|s| {
            s.view.known_hosts_paths = Some(KnownHostsPaths {
                jump: Some(deps.known_hosts.path.to_string_lossy().into_owned()),
                target: deps.known_hosts.path.to_string_lossy().into_owned(),
            })
        });
    }
    let mut handles: Vec<client::Handle<ClientHandler>> = Vec::new();
    for (index, hop) in target.hops.iter().enumerate() {
        let stream: BoxStream = if let Some(jump) = handles.last() {
            let channel = entry
                .wait(Duration::from_secs(15), async {
                    jump.channel_open_direct_tcpip(&hop.host, hop.port as u32, "127.0.0.1", 0)
                        .await
                        .map_err(|_| SessionError::CapabilityUnavailable)
                })
                .await?;
            Box::new(channel.into_stream())
        } else {
            entry
                .wait(Duration::from_secs(15), deps.streams.connect(hop))
                .await?
        };
        let mut config = client::Config {
            keepalive_interval: Some(Duration::from_secs(15)),
            keepalive_max: 3,
            ..Default::default()
        };
        // russh's default key list still includes ssh-rsa/SHA-1 as a last resort.
        config.preferred.key = config
            .preferred
            .key
            .iter()
            .filter(|a| {
                !matches!(
                    a,
                    ssh_key::Algorithm::Rsa { hash: None } | ssh_key::Algorithm::Dsa
                )
            })
            .cloned()
            .collect::<Vec<_>>()
            .into();
        let handler = ClientHandler {
            entry: entry.clone(),
            deps: deps.clone(),
            hop: hop.clone(),
            is_target: index + 1 == target.hops.len(),
        };
        let mut handle = entry
            .handshake(async {
                client::connect_stream(Arc::new(config), stream, handler)
                    .await
                    .map_err(|_| SessionError::TransportClosed)
            })
            .await?;
        authenticate(
            &entry,
            &deps,
            hop,
            index + 1 == target.hops.len(),
            &mut handle,
        )
        .await?;
        handles.push(handle);
    }
    let target = handles.pop().ok_or(SessionError::TransportClosed)?;
    let session = Arc::new(SshSession {
        handle: tokio::sync::Mutex::new(target),
        cancel: entry.cancel.clone(),
        sftp: tokio::sync::Mutex::new(None),
    });
    entry.update(|s| {
        s.authenticated = true;
        s.transport = Some(session.clone());
        s.view.state = if s.view.probe_id.is_some() || s.launch == Some(LaunchState::Running) {
            SessionState::Connected
        } else {
            SessionState::Connecting
        };
        let warning = s.view.state == SessionState::Connected && s.unsaved_secret_warning;
        set_error_reason(
            &mut s.view,
            warning.then_some(&SessionError::RememberUnavailable),
        );
        clear_prompt(&mut s.view);
    });
    // Handler callbacks observe real transport completion. Holding the bastion handle
    // keeps direct-tcpip alive; no agent forwarding is ever requested.
    entry.cancel.cancelled().await;
    {
        let h = session.handle.lock().await;
        let _ = tokio::time::timeout(
            Duration::from_millis(250),
            h.disconnect(russh::Disconnect::ByApplication, "closed", ""),
        )
        .await;
    }
    for h in handles {
        let _ = tokio::time::timeout(
            Duration::from_millis(250),
            h.disconnect(russh::Disconnect::ByApplication, "closed", ""),
        )
        .await;
    }
    Ok(())
}
pub(crate) fn identity_path(home: &std::path::Path, identity: &str) -> PathBuf {
    let relative = identity.strip_prefix("~/");
    #[cfg(windows)]
    let relative = relative.or_else(|| identity.strip_prefix("~\\"));
    relative.map_or_else(|| PathBuf::from(identity), |relative| home.join(relative))
}
async fn connect_agent(
    entry: &Entry,
    agents: &dyn AgentFactory,
) -> Result<DynamicAgent, SessionError> {
    entry.wait(Duration::from_secs(30), agents.connect()).await
}
async fn authenticate(
    entry: &Arc<Entry>,
    deps: &Arc<Dependencies>,
    hop: &SessionHop,
    is_target: bool,
    handle: &mut client::Handle<ClientHandler>,
) -> Result<(), SessionError> {
    if hop.auth == AuthMethod::Agent {
        let mut agent = connect_agent(entry, deps.agents.as_ref()).await?;
        let identities = entry
            .wait(Duration::from_secs(30), async {
                agent
                    .request_identities()
                    .await
                    .map_err(|_| SessionError::AgentUnavailable)
            })
            .await?;
        let mut rejected = false;
        for identity in identities {
            let russh::keys::agent::AgentIdentity::PublicKey { key, .. } = identity else {
                continue;
            };
            let hash = entry
                .wait(Duration::from_secs(30), async {
                    handle
                        .best_supported_rsa_hash()
                        .await
                        .map(|h| h.flatten())
                        .map_err(|_| SessionError::AgentUnavailable)
                })
                .await?;
            if !acceptable_key(&key) || (key.algorithm().is_rsa() && hash.is_none()) {
                continue;
            }
            let accepted = entry
                .wait(Duration::from_secs(30), async {
                    handle
                        .authenticate_publickey_with(&hop.user, key, hash, &mut agent)
                        .await
                        .map(|r| r.success())
                        .map_err(|_| SessionError::AgentUnavailable)
                })
                .await?;
            if accepted {
                return Ok(());
            }
            rejected = true;
        }
        return Err(if rejected {
            SessionError::AuthRejected
        } else {
            SessionError::AgentUnavailable
        });
    }
    let identity = if hop.auth == AuthMethod::Key {
        let identity = hop
            .identity_file
            .as_ref()
            .ok_or(SessionError::IdentityUnreadable)?;
        let path = identity_path(&deps.home, identity);
        Some(
            entry
                .wait(Duration::from_secs(15), async {
                    tokio::task::spawn_blocking(move || {
                        let bytes = std::fs::read_to_string(path)
                            .map_err(|_| SessionError::IdentityUnreadable)?;
                        ssh_key::PrivateKey::from_openssh(Zeroizing::new(bytes).as_bytes())
                            .map_err(|_| SessionError::IdentityUnreadable)
                    })
                    .await
                    .map_err(|_| SessionError::IdentityUnreadable)?
                })
                .await?,
        )
    } else {
        None
    };
    let fingerprint = identity.as_ref().map(|k| {
        k.public_key()
            .fingerprint(ssh_key::HashAlg::Sha256)
            .to_string()
    });
    let binding = AuthBinding::for_hop(hop, fingerprint);
    let kind = if hop.auth == AuthMethod::Password {
        SecretKind::Password
    } else {
        SecretKind::Passphrase
    };
    let cipher = CredentialCipher::default();
    let needs_secret =
        hop.auth == AuthMethod::Password || identity.as_ref().is_some_and(|k| k.is_encrypted());
    let mut remember_unavailable = false;
    let mut saved = if needs_secret {
        match entry
            .wait(Duration::from_secs(30), deps.secrets.load(&binding))
            .await
        {
            Ok(Some(ciphertext)) => match entry
                .wait(
                    Duration::from_secs(30),
                    cipher.open(kind, binding.clone(), ciphertext),
                )
                .await
            {
                Ok(secret) => Some(secret),
                Err(_) => {
                    remember_unavailable = true;
                    None
                }
            },
            Ok(None) => None,
            Err(_) => {
                remember_unavailable = true;
                None
            }
        }
    } else {
        None
    };
    let mut reason = remember_unavailable.then(|| {
        (
            "Saved credential unavailable. Enter it again; Remember may be unavailable."
                .to_string(),
            SAVED_CREDENTIAL_UNAVAILABLE,
        )
    });
    for _ in 0..3 {
        let (secret, remember) = if needs_secret {
            if let Some(saved) = saved.take() {
                (saved, false)
            } else {
                match entry
                    .prompt(
                        PromptKind::Secret,
                        prompt_target(hop, is_target),
                        Some(kind),
                        None,
                        reason.clone(),
                    )
                    .await?
                {
                    Answer::Secret(secret, remember) => (secret, remember),
                    _ => return Err(SessionError::StaleAttempt),
                }
            }
        } else {
            (Zeroizing::new(String::new()), false)
        };
        let accepted = if hop.auth == AuthMethod::Password {
            entry
                .wait(Duration::from_secs(30), async {
                    handle
                        .authenticate_password(&hop.user, secret.as_str())
                        .await
                        .map(|r| r.success())
                        .map_err(|_| SessionError::AuthRejected)
                })
                .await?
        } else {
            let key = identity.clone().ok_or(SessionError::IdentityUnreadable)?;
            let pass = secret.clone();
            let decoded = entry
                .wait(Duration::from_secs(30), async {
                    tokio::task::spawn_blocking(move || {
                        if key.is_encrypted() {
                            key.decrypt(pass.as_bytes())
                                .map_err(|_| SessionError::AuthRejected)
                        } else {
                            Ok(key)
                        }
                    })
                    .await
                    .map_err(|_| SessionError::IdentityUnreadable)?
                })
                .await;
            match decoded {
                Ok(key) => {
                    let hash = entry
                        .wait(Duration::from_secs(30), async {
                            handle
                                .best_supported_rsa_hash()
                                .await
                                .map(|h| h.flatten())
                                .map_err(|_| SessionError::AuthRejected)
                        })
                        .await?;
                    if !acceptable_key(key.public_key())
                        || (key.algorithm().is_rsa() && hash.is_none())
                    {
                        return Err(SessionError::UnsupportedAuthentication);
                    }
                    entry
                        .wait(Duration::from_secs(30), async {
                            handle
                                .authenticate_publickey(
                                    &hop.user,
                                    PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                                )
                                .await
                                .map(|r| r.success())
                                .map_err(|_| SessionError::AuthRejected)
                        })
                        .await?
                }
                Err(SessionError::AuthRejected) => false,
                Err(e) => return Err(e),
            }
        };
        if accepted {
            if remember {
                let result = async {
                    let ciphertext = cipher.seal(kind, binding.clone(), secret).await?;
                    // Cancellation is checked before the atomic compare-binding writer.
                    if entry.cancel.is_cancelled() {
                        return Err(SessionError::Cancelled);
                    }
                    deps.secrets
                        .set_secret_if_binding_matches(&binding, ciphertext, entry.cancel.clone())
                        .await
                }
                .await;
                if result.is_err() {
                    entry.update(|s| {
                        s.unsaved_secret_warning = true;
                    });
                }
            }
            return Ok(());
        }
        if !needs_secret {
            return Err(SessionError::AuthRejected);
        }
        let rejected = SessionError::AuthRejected;
        reason = Some((rejected.reason(), rejected.code()));
    }
    Err(SessionError::AuthRejected)
}

pub struct SshSession {
    handle: tokio::sync::Mutex<client::Handle<ClientHandler>>,
    cancel: CancellationToken,
    sftp: tokio::sync::Mutex<Option<Arc<russh_sftp::client::SftpSession>>>,
}
#[derive(Debug, PartialEq, Eq)]
pub struct ExecOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit: u32,
}
pub type ExecResult = ExecOutput;
pub struct ExecOpts {
    pub deadline: Duration,
    pub stdout_cap: usize,
    pub stderr_cap: usize,
    pub cancel: CancellationToken,
}
impl Default for ExecOpts {
    fn default() -> Self {
        Self {
            deadline: Duration::from_secs(30),
            stdout_cap: 1024 * 1024,
            stderr_cap: 1024 * 1024,
            cancel: CancellationToken::new(),
        }
    }
}
impl SshSession {
    pub fn cancellation(&self) -> CancellationToken {
        self.cancel.child_token()
    }
    pub async fn exec(&self, command: &str) -> Result<ExecOutput, SessionError> {
        self.exec_with(
            command,
            ExecOpts {
                cancel: self.cancel.child_token(),
                ..Default::default()
            },
        )
        .await
    }
    pub async fn exec_bounded(
        &self,
        command: &str,
        cap: usize,
        timeout: Duration,
    ) -> Result<ExecOutput, SessionError> {
        self.exec_with(
            command,
            ExecOpts {
                deadline: timeout,
                stdout_cap: cap,
                stderr_cap: cap,
                ..Default::default()
            },
        )
        .await
    }
    pub async fn exec_with(
        &self,
        command: &str,
        opts: ExecOpts,
    ) -> Result<ExecOutput, SessionError> {
        let deadline = tokio::time::Instant::now() + opts.deadline;
        let mut channel = tokio::select! {
            biased;
            _ = self.cancel.cancelled() => return Err(SessionError::Cancelled),
            _ = opts.cancel.cancelled() => return Err(SessionError::Cancelled),
            result = tokio::time::timeout_at(deadline, async { self.handle.lock().await.channel_open_session().await }) =>
                result.map_err(|_| SessionError::TimedOut)?.map_err(|_| SessionError::TransportClosed)?,
        };
        let command = command.to_owned();
        let generation_cancel = self.cancel.clone();
        let request_cancel = opts.cancel;
        // The reader owns the channel and closes it on every failure. This task is
        // always joined before returning; request cancellation never touches the session.
        let reader = tokio::spawn(async move {
            let result = tokio::select! {
                biased;
                _ = generation_cancel.cancelled() => Err(SessionError::Cancelled),
                _ = request_cancel.cancelled() => Err(SessionError::Cancelled),
                _ = tokio::time::sleep_until(deadline) => Err(SessionError::TimedOut),
                result = async {
                    channel.exec(true, command).await.map_err(|_| SessionError::TransportClosed)?;
                    let (mut stdout, mut stderr, mut exit, mut acknowledged) = (Vec::new(), Vec::new(), None, false);
                    while let Some(message) = channel.wait().await {
                        match message {
                            ChannelMsg::Success => acknowledged = true,
                            ChannelMsg::Failure => return Err(SessionError::CapabilityUnavailable),
                            ChannelMsg::Data { data } => append_bounded(&mut stdout, &data, opts.stdout_cap.min(1024 * 1024))?,
                            ChannelMsg::ExtendedData { data, .. } => append_bounded(&mut stderr, &data, opts.stderr_cap.min(1024 * 1024))?,
                            ChannelMsg::ExitStatus { exit_status } => exit = Some(exit_status),
                            _ => {},
                        }
                    }
                    if !acknowledged { return Err(SessionError::CapabilityUnavailable); }
                    Ok(ExecOutput { stdout, stderr, exit: exit.ok_or(SessionError::MissingExitStatus)? })
                } => result,
            };
            if result.is_err() {
                let _ = tokio::time::timeout(Duration::from_millis(250), channel.close()).await;
            }
            result
        });
        let result = reader.await.map_err(|_| SessionError::TransportClosed)?;
        if self.cancel.is_cancelled() {
            Err(SessionError::Cancelled)
        } else {
            result
        }
    }
    /// Evict only the failed lease, never a replacement opened concurrently.
    pub async fn evict_sftp(&self, failed: &SftpLease) -> bool {
        let mut cached = self.sftp.lock().await;
        if cached
            .as_ref()
            .is_some_and(|client| Arc::ptr_eq(client, &failed.client))
        {
            *cached = None;
            true
        } else {
            false
        }
    }
    pub async fn sftp(&self) -> Result<SftpLease, SessionError> {
        self.guard(Duration::from_secs(30), async {
            let mut cached = self.sftp.lock().await;
            if cached.is_none() {
                let mut ch = self
                    .handle
                    .lock()
                    .await
                    .channel_open_session()
                    .await
                    .map_err(|_| SessionError::TransportClosed)?;
                ch.request_subsystem(true, "sftp")
                    .await
                    .map_err(|_| SessionError::TransportClosed)?;
                loop {
                    match ch.wait().await {
                        Some(ChannelMsg::Success) => break,
                        Some(ChannelMsg::Failure) | None => {
                            let _ = ch.close().await;
                            return Err(SessionError::CapabilityUnavailable);
                        }
                        _ => {}
                    }
                }
                let sftp = russh_sftp::client::SftpSession::new(ch.into_stream())
                    .await
                    .map_err(|_| SessionError::CapabilityUnavailable)?;
                sftp.set_timeout(30);
                *cached = Some(Arc::new(sftp));
            }
            Ok(SftpLease {
                client: cached
                    .as_ref()
                    .ok_or(SessionError::CapabilityUnavailable)?
                    .clone(),
                cancel: self.cancel.clone(),
            })
        })
        .await
    }
    async fn guard<T>(
        &self,
        timeout: Duration,
        future: impl Future<Output = Result<T, SessionError>>,
    ) -> Result<T, SessionError> {
        let result = tokio::select! { biased; _ = self.cancel.cancelled() => Err(SessionError::Cancelled), result = tokio::time::timeout(timeout, future) => result.map_err(|_| SessionError::TimedOut)? };
        if self.cancel.is_cancelled() {
            Err(SessionError::Cancelled)
        } else {
            result
        }
    }
}
pub struct SftpLease {
    client: Arc<russh_sftp::client::SftpSession>,
    cancel: CancellationToken,
}
impl SftpLease {
    /// All operations are scoped through this fence; never expose an unfenced client.
    pub async fn request<T>(
        &self,
        operation: impl for<'a> FnOnce(
            &'a russh_sftp::client::SftpSession,
        ) -> BoxFuture<'a, Result<T, SessionError>>,
    ) -> Result<T, SessionError> {
        let result = tokio::select! { biased; _ = self.cancel.cancelled() => return Err(SessionError::Cancelled), result = tokio::time::timeout(Duration::from_secs(30), operation(&self.client)) => result.map_err(|_| SessionError::TimedOut)? };
        if self.cancel.is_cancelled() {
            Err(SessionError::Cancelled)
        } else {
            result
        }
    }
}
#[cfg(test)]
#[path = "review_tests.rs"]
mod review_tests;
#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;

pub fn append_bounded(buffer: &mut Vec<u8>, data: &[u8], cap: usize) -> Result<(), SessionError> {
    if data.len() > cap.saturating_sub(buffer.len()) {
        return Err(SessionError::OutputTooLarge);
    }
    buffer.extend_from_slice(data);
    Ok(())
}
