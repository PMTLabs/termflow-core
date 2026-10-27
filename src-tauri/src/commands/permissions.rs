//! Permission commands. Each operation retains exactly one resolved subject;
//! neither a failed host call nor a subject change redirects it to the app.
use crate::pty_host_client::{PermissionOutcome, PermissionStatus, PtyHostClient};
use crate::state::permissions::{OtherHost, PermissionSubject, PermissionTarget, SubjectIdentity};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::State;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionKind { Accessibility, ScreenRecording }

impl From<PermissionKind> for termflow_pty_protocol::PermissionKind {
    fn from(kind: PermissionKind) -> Self {
        match kind { PermissionKind::Accessibility => Self::Accessibility, PermissionKind::ScreenRecording => Self::ScreenRecording }
    }
}
impl From<PermissionKind> for termflow_macos_tcc::PermissionKind {
    fn from(kind: PermissionKind) -> Self {
        match kind { PermissionKind::Accessibility => Self::Accessibility, PermissionKind::ScreenRecording => Self::ScreenRecording }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PermState { Granted, NotGranted, Unsupported, Unknown }
impl From<termflow_pty_protocol::PermissionState> for PermState {
    fn from(state: termflow_pty_protocol::PermissionState) -> Self {
        use termflow_pty_protocol::PermissionState as P;
        match state { P::Granted => Self::Granted, P::NotGranted => Self::NotGranted, P::Unsupported => Self::Unsupported, P::Unknown => Self::Unknown }
    }
}
impl From<termflow_macos_tcc::PermissionState> for PermState {
    fn from(state: termflow_macos_tcc::PermissionState) -> Self {
        use termflow_macos_tcc::PermissionState as P;
        match state { P::Granted => Self::Granted, P::NotGranted => Self::NotGranted, P::Unsupported => Self::Unsupported, P::Unknown => Self::Unknown }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionView {
    epoch: u64,
    target: PermissionTarget,
    subject: SubjectIdentity,
    accessibility: PermState,
    screen_recording: PermState,
    other_hosts: Vec<OtherHost>,
    app_sessions: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

static EPOCH: AtomicU64 = AtomicU64::new(0);
fn next_epoch() -> Result<u64, String> {
    EPOCH.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |v| v.checked_add(1))
        .map(|v| v + 1).map_err(|_| "permission epoch exhausted".into())
}

struct Subject<H> {
    view: PermissionSubject,
    host: Option<H>,
    // The host status used to establish responsibility also supplies the
    // initial state; status commands must not issue a second query.
    status: Option<(PermState, PermState)>,
    resolution_failed: bool,
}
trait PermissionPort {
    type Host;
    async fn subject(&self) -> Subject<Self::Host>;
    async fn host_status(&self, host: &Self::Host) -> Result<(PermState, PermState), ()>;
    async fn host_request(&self, host: &Self::Host, kind: PermissionKind) -> Result<(), ()>;
    async fn app_status(&self) -> Result<(PermState, PermState), ()>;
    async fn app_request(&self, kind: PermissionKind) -> Result<(), ()>;
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpectedSubject {
    target: PermissionTarget,
    #[serde(flatten)]
    subject: SubjectIdentity,
}

async fn execute<P: PermissionPort>(port: &P, kind: Option<PermissionKind>, epoch: u64) -> PermissionView {
    execute_expected(port, kind, epoch, None).await
}

async fn execute_expected<P: PermissionPort>(port: &P, kind: Option<PermissionKind>, epoch: u64, expected: Option<ExpectedSubject>) -> PermissionView {
    let subject = port.subject().await;
    if kind.is_some() && expected.is_some_and(|expected| expected.target != subject.view.target || expected.subject != subject.view.subject) {
        return PermissionView { epoch, target: subject.view.target, subject: subject.view.subject, accessibility: PermState::Unknown, screen_recording: PermState::Unknown, other_hosts: subject.view.other_hosts, app_sessions: subject.view.app_sessions, error: Some("The permission target changed; nothing was requested".into()) };
    }
    let mut states = (PermState::Unknown, PermState::Unknown);
    let mut error = subject.resolution_failed.then(|| "Permission subject resolution failed".to_string());
    let result = match subject.view.target {
        PermissionTarget::Host => {
            if let Some(host) = &subject.host {
                match kind {
                    None => subject.status.ok_or(()),
                    Some(_) if subject.status.is_some_and(|(a, s)| a == PermState::Unknown || s == PermState::Unknown) => subject.status.ok_or(()),
                    Some(kind) => match port.host_request(host, kind).await {
                        Ok(()) => port.host_status(host).await,
                        Err(()) => Err(()),
                    },
                }
            } else { Err(()) }
        }
        PermissionTarget::App => {
            match kind {
                None => port.app_status().await,
                Some(kind) => match port.app_request(kind).await {
                    Ok(()) => port.app_status().await,
                    Err(()) => Err(()),
                },
            }
        }
        PermissionTarget::HostLegacy | PermissionTarget::Unresolved => Ok(states),
    };
    match result {
        Ok(value) => {
            states = value;
            if value.0 == PermState::Unknown || value.1 == PermState::Unknown {
                match subject.view.target {
                    PermissionTarget::Host => error = Some("TermFlow Host could not read the permission status".into()),
                    PermissionTarget::App => error = Some("TermFlow could not read the permission status".into()),
                    _ => {}
                }
            }
        },
        Err(()) => error = Some("Permission operation failed".into()),
    }
    PermissionView { epoch, target: subject.view.target, subject: subject.view.subject, accessibility: states.0, screen_recording: states.1, other_hosts: subject.view.other_hosts, app_sessions: subject.view.app_sessions, error }
}

trait Inventory {
    async fn resolve(&self) -> crate::state::permissions::ResolvedPermissionSubject;
    async fn resolve_status(&self) -> crate::state::permissions::ResolvedPermissionSubject { self.resolve().await }
    fn app_call(&self) {}
}
impl Inventory for AppState {
    async fn resolve(&self) -> crate::state::permissions::ResolvedPermissionSubject {
        crate::state::permissions::permission_subject(self).await
    }
    async fn resolve_status(&self) -> crate::state::permissions::ResolvedPermissionSubject {
        crate::state::permissions::permission_status_subject(self).await
    }
}
// Only read-only status commands may join an inventory resolution.
struct SystemPort<'a, S>(&'a S, bool);
impl<S: Inventory> PermissionPort for SystemPort<'_, S> {
    type Host = PtyHostClient;
    async fn subject(&self) -> Subject<Self::Host> {
        let resolved = if self.1 { self.0.resolve_status().await } else { self.0.resolve().await };
        Subject { view: resolved.view, host: resolved.host, status: resolved.status.map(host_states), resolution_failed: resolved.resolution_failed }
    }
    async fn host_status(&self, host: &PtyHostClient) -> Result<(PermState, PermState), ()> {
        match host.permission_status().await { Ok(PermissionOutcome::Reply(status)) => Ok(host_states(status)), _ => Err(()) }
    }
    async fn host_request(&self, host: &PtyHostClient, kind: PermissionKind) -> Result<(), ()> {
        match host.request_permission(kind.into()).await {
            Ok(PermissionOutcome::Reply(reply)) if reply.state != termflow_pty_protocol::PermissionState::Unknown => Ok(()),
            _ => Err(()),
        }
    }
    async fn app_status(&self) -> Result<(PermState, PermState), ()> {
        self.0.app_call();
        tokio::task::spawn_blocking(|| {
            use termflow_macos_tcc::Tcc;
            let (a, s) = termflow_macos_tcc::SystemTcc.status();
            Ok((a.into(), s.into()))
        }).await.map_err(|_| ())?
    }
    async fn app_request(&self, kind: PermissionKind) -> Result<(), ()> {
        self.0.app_call();
        tokio::task::spawn_blocking(move || {
            use termflow_macos_tcc::{PermissionState, Tcc};
            if termflow_macos_tcc::SystemTcc.request(kind.into()) == PermissionState::Unknown { Err(()) } else { Ok(()) }
        }).await.map_err(|_| ())?
    }
}
fn host_states(status: PermissionStatus) -> (PermState, PermState) {
    (status.accessibility.into(), status.screen_recording.into())
}

fn unsupported(epoch: u64, app_sessions: bool) -> PermissionView {
    PermissionView { epoch, target: PermissionTarget::App, subject: SubjectIdentity { pid: Some(std::process::id()), generation: None, bundle_id: Some("app.termflow.desktop".into()) }, accessibility: PermState::Unsupported, screen_recording: PermState::Unsupported, other_hosts: vec![], app_sessions, error: None }
}

fn in_process_sessions(state: &AppState) -> bool {
    state.terminals.iter().any(|t| !state.host_terminals.contains_key(t.key()))
}

#[tauri::command]
pub async fn macos_permission_status(state: State<'_, AppState>) -> Result<PermissionView, String> {
    let epoch = next_epoch()?;
    if !cfg!(target_os = "macos") { return Ok(unsupported(epoch, in_process_sessions(&state))); }
    Ok(execute(&SystemPort(&*state, true), None, epoch).await)
}

#[tauri::command]
pub async fn request_macos_permission(state: State<'_, AppState>, kind: PermissionKind, expected: Option<ExpectedSubject>) -> Result<PermissionView, String> {
    let epoch = next_epoch()?;
    if !cfg!(target_os = "macos") { return Ok(unsupported(epoch, in_process_sessions(&state))); }
    Ok(execute_expected(&SystemPort(&*state, false), Some(kind), epoch, expected).await)
}

#[cfg(test)]
#[path = "permissions_tests.rs"]
mod tests;
