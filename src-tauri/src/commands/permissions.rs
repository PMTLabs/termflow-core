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
}
trait PermissionPort {
    type Host;
    async fn subject(&self) -> Subject<Self::Host>;
    async fn host_status(&self, host: &Self::Host) -> Result<(PermState, PermState), ()>;
    async fn host_request(&self, host: &Self::Host, kind: PermissionKind) -> Result<(), ()>;
    async fn app_status(&self) -> Result<(PermState, PermState), ()>;
    async fn app_request(&self, kind: PermissionKind) -> Result<(), ()>;
}

async fn execute<P: PermissionPort>(port: &P, kind: Option<PermissionKind>, epoch: u64) -> PermissionView {
    let subject = port.subject().await;
    let mut states = (PermState::Unknown, PermState::Unknown);
    match subject.view.target {
        PermissionTarget::Host => {
            if let Some(host) = &subject.host {
                states = match kind {
                    None => subject.status.unwrap_or(states),
                    Some(kind) => match port.host_request(host, kind).await {
                        Ok(()) => port.host_status(host).await.unwrap_or(states),
                        Err(()) => states,
                    },
                };
            }
        }
        PermissionTarget::App => {
            states = match kind {
                None => port.app_status().await.unwrap_or(states),
                Some(kind) => match port.app_request(kind).await {
                    Ok(()) => port.app_status().await.unwrap_or(states),
                    Err(()) => states,
                },
            };
        }
        PermissionTarget::HostLegacy | PermissionTarget::Unresolved => {}
    }
    PermissionView { epoch, target: subject.view.target, subject: subject.view.subject, accessibility: states.0, screen_recording: states.1, other_hosts: subject.view.other_hosts, app_sessions: subject.view.app_sessions }
}

struct SystemPort<'a>(&'a AppState);
impl PermissionPort for SystemPort<'_> {
    type Host = PtyHostClient;
    async fn subject(&self) -> Subject<Self::Host> {
        let resolved = crate::state::permissions::permission_subject(self.0).await;
        Subject { view: resolved.view, host: resolved.host, status: resolved.status.map(host_states) }
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
        tokio::task::spawn_blocking(|| {
            use termflow_macos_tcc::Tcc;
            let (a, s) = termflow_macos_tcc::SystemTcc.status();
            (a.into(), s.into())
        }).await.map_err(|_| ())
    }
    async fn app_request(&self, kind: PermissionKind) -> Result<(), ()> {
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
    PermissionView { epoch, target: PermissionTarget::App, subject: SubjectIdentity { pid: Some(std::process::id()), generation: None, bundle_id: Some("app.termflow.desktop".into()) }, accessibility: PermState::Unsupported, screen_recording: PermState::Unsupported, other_hosts: vec![], app_sessions }
}

fn in_process_sessions(state: &AppState) -> bool {
    state.terminals.iter().any(|t| !state.host_terminals.contains_key(t.key()))
}

#[tauri::command]
pub async fn macos_permission_status(state: State<'_, AppState>) -> Result<PermissionView, String> {
    let epoch = next_epoch()?;
    if !cfg!(target_os = "macos") { return Ok(unsupported(epoch, in_process_sessions(&state))); }
    Ok(execute(&SystemPort(&state), None, epoch).await)
}

#[tauri::command]
pub async fn request_macos_permission(state: State<'_, AppState>, kind: PermissionKind) -> Result<PermissionView, String> {
    let epoch = next_epoch()?;
    if !cfg!(target_os = "macos") { return Ok(unsupported(epoch, in_process_sessions(&state))); }
    Ok(execute(&SystemPort(&state), Some(kind), epoch).await)
}

#[cfg(test)]
#[path = "permissions_tests.rs"]
mod tests;
