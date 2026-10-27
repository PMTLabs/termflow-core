//! Non-spawning permission-subject selection, with PID-based code verification.
use super::host_adoption::AdoptionPort;
use super::host_generation::ServingHosts;
use super::host_routing::spawn_target;
use super::types::AppState;
use crate::elevated_host::HostChannel;
use crate::pty_host_client::{PermissionOutcome, PermissionStatus, PtyHostClient};
use serde::Serialize;
use tauri::Runtime;

pub(crate) mod host_identity;
pub(crate) const HELPER_BUNDLE_ID: &str = crate::helper_identity::HELPER_IDENTIFIER;
const APP_BUNDLE_ID: &str = "app.termflow.desktop";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum IdentityVerdict { Matches, Different, Unverifiable }

/// Implementations must compare the host's code identity, not its build hash or capability.
pub(crate) trait HostIdentityVerifier {
    fn verify(&self, pid: u32) -> IdentityVerdict;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PermissionTarget { Host, HostLegacy, App, Unresolved }

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubjectIdentity {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OtherHostReason { Legacy, DifferentIdentity, Unverified }

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OtherHost {
    pub pid: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<String>,
    pub reason: OtherHostReason,
}

/// The routing/identity part of PermissionView. The operation's epoch and
/// permission states are supplied by the command layer in the next step.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PermissionSubject {
    pub target: PermissionTarget,
    pub subject: SubjectIdentity,
    pub other_hosts: Vec<OtherHost>,
    pub app_sessions: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SpawnIdentity { App, Helper }

#[derive(Clone)]
struct Host<H> {
    channel: HostChannel,
    handle: H,
    pid: Option<u32>,
    generation: Option<String>,
    capable: bool,
    // Set only for a spawn whose PID was matched to the connection's peer.
    spawn_identity: Option<SpawnIdentity>,
}

#[derive(Clone)]
struct Snapshot<H> {
    selected: Option<HostChannel>,
    hosts: Vec<Host<H>>,
    disabled: bool,
    helper_unavailable: bool,
    reconnecting: bool,
    app_sessions: bool,
}

/// This port intentionally has no spawn, discovery, or connection operation.
trait SubjectSource {
    type Handle: Clone;
    fn snapshot(&self) -> Snapshot<Self::Handle>;
    async fn status(&self, handle: &Self::Handle) -> Result<(Option<bool>, Option<PermissionStatus>), ()>;
    fn still_selected(&self, host: &Host<Self::Handle>) -> bool;
}

fn identity(responsible: Option<bool>, fallback: Option<SpawnIdentity>) -> Option<SpawnIdentity> {
    responsible.map(|v| if v { SpawnIdentity::Helper } else { SpawnIdentity::App }).or(fallback)
}

fn other_reason<H>(host: &Host<H>, verifier: &impl HostIdentityVerifier) -> Option<OtherHostReason> {
    if !host.capable { return Some(OtherHostReason::Legacy); }
    match host.pid.map(|pid| verifier.verify(pid)).unwrap_or(IdentityVerdict::Unverifiable) {
        IdentityVerdict::Matches => None,
        IdentityVerdict::Different => Some(OtherHostReason::DifferentIdentity),
        IdentityVerdict::Unverifiable => Some(OtherHostReason::Unverified),
    }
}

#[cfg(test)]
async fn resolve<S: SubjectSource>(source: &S, verifier: &impl HostIdentityVerifier) -> PermissionSubject {
    resolve_snapshot(source, source.snapshot(), verifier).await.0
}

async fn resolve_snapshot<S: SubjectSource>(source: &S, snapshot: Snapshot<S::Handle>, verifier: &impl HostIdentityVerifier) -> (PermissionSubject, Option<S::Handle>, Option<PermissionStatus>) {
    let selected = snapshot.selected.and_then(|c| snapshot.hosts.iter().find(|h| h.channel == c));
    let mut result = PermissionSubject { target: PermissionTarget::Unresolved, subject: SubjectIdentity::default(), other_hosts: Vec::new(), app_sessions: snapshot.app_sessions };
    let mut covered = None;
    let mut selected_handle = None;
    let mut status = None;
    if snapshot.disabled {
        result.target = PermissionTarget::App;
        result.subject.pid = Some(std::process::id());
        result.subject.bundle_id = Some(APP_BUNDLE_ID.into());
    } else if let Some(host) = selected {
        if !host.capable && source.still_selected(host) {
            result.target = PermissionTarget::HostLegacy;
            result.subject = SubjectIdentity { pid: host.pid, generation: host.generation.clone(), bundle_id: None };
            covered = Some(host.channel);
        } else if other_reason(host, verifier).is_none() {
            // A failed or disconnected request never falls back to the app.
            if let Ok((responsible, evidence)) = source.status(&host.handle).await {
                if source.still_selected(host) {
                    match identity(responsible, host.spawn_identity) {
                        Some(SpawnIdentity::Helper) => {
                            result.target = PermissionTarget::Host;
                            result.subject = SubjectIdentity { pid: host.pid, generation: host.generation.clone(), bundle_id: Some(HELPER_BUNDLE_ID.into()) };
                            covered = Some(host.channel);
                            selected_handle = Some(host.handle.clone());
                            status = evidence;
                        }
                        Some(SpawnIdentity::App) => {
                            result.target = PermissionTarget::App;
                            result.subject.pid = Some(std::process::id());
                            result.subject.bundle_id = Some(APP_BUNDLE_ID.into());
                            covered = Some(host.channel);
                        }
                        None => {}
                    }
                }
            }
        }
    } else if snapshot.helper_unavailable && !snapshot.reconnecting {
        result.target = PermissionTarget::App;
        result.subject.pid = Some(std::process::id());
        result.subject.bundle_id = Some(APP_BUNDLE_ID.into());
    }
    for host in &snapshot.hosts {
        if Some(host.channel) == covered { continue; }
        let reason = other_reason(host, verifier).or_else(|| {
            (result.target == PermissionTarget::App && host.capable).then_some(OtherHostReason::DifferentIdentity)
        });
        if let (Some(pid), Some(reason)) = (host.pid, reason) {
            result.other_hosts.push(OtherHost { pid, generation: host.generation.clone(), reason });
        }
    }
    (result, selected_handle, status)
}

fn host_snapshot(channel: HostChannel, client: PtyHostClient, generation: Option<String>) -> Host<PtyHostClient> {
    let pid = client.server_pid();
    #[cfg(target_os = "macos")]
    let spawn_identity = if pid.is_some() {
        client.host_permission_identity().map(|v| match v {
            crate::pty_host_client::HostPermissionIdentity::App => SpawnIdentity::App,
            crate::pty_host_client::HostPermissionIdentity::Helper => SpawnIdentity::Helper,
        })
    } else { None };
    #[cfg(not(target_os = "macos"))]
    let spawn_identity = None;
    Host { channel, pid, generation, capable: client.permissions(), spawn_identity, handle: client }
}

impl<R: Runtime> SubjectSource for AppState<R> {
    type Handle = PtyHostClient;
    fn snapshot(&self) -> Snapshot<Self::Handle> {
        // Neither spawn_target nor this inventory starts or discovers a host.
        let selected = spawn_target(self).map(|(channel, _)| channel);
        let serving = ServingHosts::assemble(self.pty_host_clone(), None, |_| None, self.frozen_hosts());
        let registered = serving.primary.is_some() || !serving.frozen.is_empty()
            || self.host_table.epoch(HostChannel::Primary).is_some();
        let mut hosts = Vec::new();
        if let Some(client) = serving.primary.filter(PtyHostClient::is_alive) {
            let generation = if client.spawned_here() {
                crate::pty_host_client::running_generation()
            } else {
                serving.primary_generation.or_else(|| client.host_generation())
            };
            hosts.push(host_snapshot(HostChannel::Primary, client, generation));
        }
        for host in serving.frozen.into_iter().filter(|host| host.client.is_alive()) {
            let generation = host.generation.or_else(|| host.client.host_generation());
            hosts.push(host_snapshot(HostChannel::Frozen(host.id), host.client, generation));
        }
        let reconnecting = !self.host_barrier.unresolved().is_empty() || self.host_barrier.any_in_flight()
            || (selected.is_none() && registered);
        let disabled = !crate::pty_host_client::enabled();
        #[cfg(target_os = "macos")]
        let helper_unavailable = !disabled && selected.is_none() && !reconnecting && crate::pty_host_client::release_helper_unavailable();
        #[cfg(not(target_os = "macos"))]
        let helper_unavailable = false;
        Snapshot {
            selected, hosts, reconnecting, helper_unavailable,
            disabled,
            app_sessions: self.terminals.iter().any(|t| !self.host_terminals.contains_key(t.key())),
        }
    }
    async fn status(&self, client: &PtyHostClient) -> Result<(Option<bool>, Option<PermissionStatus>), ()> {
        match client.permission_status().await {
            Ok(PermissionOutcome::Reply(status)) => Ok((status.self_responsible, Some(status))),
            _ => Err(()),
        }
    }
    fn still_selected(&self, host: &Host<PtyHostClient>) -> bool {
        spawn_target(self).is_some_and(|(channel, client)| {
            channel == host.channel && client.is_alive()
                && client.session_epoch(channel) == host.handle.session_epoch(channel)
                && client.server_pid() == host.pid
        })
    }
}

/// Selects only among existing connections and never starts a host.
pub(crate) struct ResolvedPermissionSubject {
    pub view: PermissionSubject,
    pub host: Option<PtyHostClient>,
    pub status: Option<PermissionStatus>,
}

pub(crate) async fn permission_subject<R: Runtime>(state: &AppState<R>) -> ResolvedPermissionSubject {
    let snapshot = state.snapshot();
    let verifier = host_identity::ProductionVerifier::new(snapshot.hosts.iter().map(|host| host.handle.clone()));
    let (view, host, status) = resolve_snapshot(state, snapshot, &verifier).await;
    ResolvedPermissionSubject { view, host, status }
}

#[cfg(test)]
#[path = "permissions/subject_tests.rs"]
mod tests;
