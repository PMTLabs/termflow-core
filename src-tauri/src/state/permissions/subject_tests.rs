use super::*;
use crate::elevated_host::FrozenId;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Fake {
    snapshot: Snapshot<u32>,
    replies: HashMap<u32, Result<Option<bool>, ()>>,
    spawn_count: AtomicUsize,
    still_selected: bool,
}
impl SubjectSource for Fake {
    type Handle = u32;
    fn snapshot(&self) -> Snapshot<u32> { self.snapshot.clone() }
    async fn status(&self, handle: &u32) -> Result<(Option<bool>, Option<PermissionStatus>), ()> {
        self.replies.get(handle).copied().unwrap_or(Err(())).map(|responsible| (responsible, None))
    }
    fn still_selected(&self, _: &Host<u32>) -> bool { self.still_selected }
}
struct Verifier(HashMap<u32, IdentityVerdict>);
impl HostIdentityVerifier for Verifier {
    fn verify(&self, pid: u32) -> IdentityVerdict { self.0.get(&pid).cloned().unwrap_or(IdentityVerdict::Unverifiable) }
}
fn host(channel: HostChannel, pid: u32, capable: bool) -> Host<u32> {
    Host { channel, handle: pid, pid: Some(pid), generation: Some(format!("gen{pid}")), capable, spawn_identity: None }
}
fn fixture(selected: Option<HostChannel>, hosts: Vec<Host<u32>>) -> Fake {
    Fake { snapshot: Snapshot { selected, hosts, disabled: false, helper_unavailable: false, reconnecting: false, app_sessions: false }, replies: HashMap::from([(1, Ok(Some(true))), (2, Ok(Some(true)))]), spawn_count: AtomicUsize::new(0), still_selected: true }
}
fn matched() -> IdentityVerdict { IdentityVerdict::Matches("same canonical DR".into()) }
fn verifier() -> Verifier { Verifier(HashMap::from([(1, matched()), (2, matched())])) }

#[tokio::test]
async fn subject_table_and_no_spawn() {
    let current = HostChannel::Primary;
    let frozen = HostChannel::Frozen(FrozenId(1));
    let mut rows = vec![
        ("capable current", fixture(Some(current), vec![host(current, 1, true)]), PermissionTarget::Host, vec![], false),
        ("legacy current", fixture(Some(current), vec![host(current, 1, false)]), PermissionTarget::HostLegacy, vec![], false),
        ("capable frozen-only", fixture(Some(frozen), vec![host(frozen, 2, true)]), PermissionTarget::Host, vec![], false),
        ("legacy frozen-only", fixture(Some(frozen), vec![host(frozen, 2, false)]), PermissionTarget::HostLegacy, vec![], false),
        ("mixed generations", fixture(Some(current), vec![host(current, 1, true), host(frozen, 2, false)]), PermissionTarget::Host, vec![(2, OtherHostReason::Legacy)], false),
        ("cold boot", fixture(None, vec![]), PermissionTarget::Unresolved, vec![], false),
    ];
    let mut with_app = fixture(Some(current), vec![host(current, 1, true)]);
    with_app.snapshot.app_sessions = true;
    rows.push(("host and in-process", with_app, PermissionTarget::Host, vec![], true));
    let mut reconnecting = fixture(None, vec![]);
    reconnecting.snapshot.reconnecting = true;
    reconnecting.snapshot.helper_unavailable = true;
    rows.push(("reconnecting", reconnecting, PermissionTarget::Unresolved, vec![], false));
    let mut disabled = fixture(None, vec![]);
    disabled.snapshot.disabled = true;
    rows.push(("host disabled", disabled, PermissionTarget::App, vec![], false));
    let mut rejected = fixture(None, vec![]);
    rejected.snapshot.helper_unavailable = true;
    rows.push(("release helper rejected", rejected, PermissionTarget::App, vec![], false));
    let mut not_admitting = fixture(None, vec![host(current, 1, true)]);
    not_admitting.snapshot.reconnecting = true;
    rows.push(("not admitting", not_admitting, PermissionTarget::Unresolved, vec![], false));
    for (name, fake, target, others, app_sessions) in rows {
        let result = resolve(&fake, &verifier()).await;
        assert_eq!(result.target, target, "{name}");
        assert_eq!(result.other_hosts.iter().map(|h| (h.pid, h.reason)).collect::<Vec<_>>(), others, "{name}");
        assert_eq!(result.app_sessions, app_sessions, "{name}");
        if matches!(target, PermissionTarget::Host | PermissionTarget::HostLegacy) {
            assert_eq!(result.subject.pid, fake.snapshot.hosts.first().and_then(|h| h.pid), "{name}");
            assert!(result.subject.generation.is_some(), "{name}");
        }
        assert_eq!(fake.spawn_count.load(Ordering::SeqCst), 0, "{name}");
    }
}

#[tokio::test]
async fn cold_settings_then_created_pane_changes_subject_without_settings_spawning() {
    let mut fake = fixture(None, vec![]);
    assert_eq!(resolve(&fake, &verifier()).await.target, PermissionTarget::Unresolved);
    fake.snapshot.selected = Some(HostChannel::Primary);
    fake.snapshot.hosts.push(host(HostChannel::Primary, 1, true));
    assert_eq!(resolve(&fake, &verifier()).await.target, PermissionTarget::Host);
    assert_eq!(fake.spawn_count.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn self_responsibility_takes_precedence_over_pid_matched_spawn_identity() {
    for responsible in [Some(true), Some(false), None] {
        for fallback in [Some(SpawnIdentity::Helper), Some(SpawnIdentity::App), None] {
            let mut h = host(HostChannel::Primary, 1, true);
            h.spawn_identity = fallback; // only supplied by the adapter after PID matching
            let mut fake = fixture(Some(HostChannel::Primary), vec![h]);
            fake.replies.insert(1, Ok(responsible));
            let expected = match responsible.map(|b| if b { SpawnIdentity::Helper } else { SpawnIdentity::App }).or(fallback) {
                Some(SpawnIdentity::Helper) => PermissionTarget::Host,
                Some(SpawnIdentity::App) => PermissionTarget::App,
                None => PermissionTarget::Unresolved,
            };
            assert_eq!(resolve(&fake, &verifier()).await.target, expected, "{responsible:?} {fallback:?}");
        }
    }
    let mut missing_pid = host(HostChannel::Primary, 1, true);
    missing_pid.pid = None;
    missing_pid.spawn_identity = None; // unverified peer cannot supply a fallback
    let mut fake = fixture(Some(HostChannel::Primary), vec![missing_pid]);
    fake.replies.insert(1, Ok(None));
    assert_eq!(resolve(&fake, &verifier()).await.target, PermissionTarget::Unresolved);
}

#[tokio::test]
async fn identity_verdicts_and_failed_or_stale_status_never_become_a_subject() {
    let current = HostChannel::Primary;
    let frozen = HostChannel::Frozen(FrozenId(1));
    for (verdict, reason) in [(IdentityVerdict::Different, OtherHostReason::DifferentIdentity), (IdentityVerdict::Unverifiable, OtherHostReason::Unverified)] {
        // Both hosts can claim the same bundle id; only verified DR matters.
        let fake = fixture(Some(current), vec![host(current, 1, true), host(frozen, 2, true)]);
        let v = Verifier(HashMap::from([(1, matched()), (2, verdict.clone())]));
        let result = resolve(&fake, &v).await;
        assert_eq!(result.target, PermissionTarget::Host);
        assert_eq!(result.other_hosts, vec![OtherHost { pid: 2, generation: Some("gen2".into()), reason }]);
        let v = Verifier(HashMap::from([(1, verdict), (2, matched())]));
        let result = resolve(&fake, &v).await;
        assert_eq!(result.target, PermissionTarget::Unresolved);
        assert_eq!(result.subject.pid, None);
        assert_eq!(result.other_hosts[0].reason, reason);
    }
    let mut fake = fixture(Some(current), vec![host(current, 1, true)]);
    fake.replies.insert(1, Err(()));
    let (view, host, status, failed) = resolve_snapshot(&fake, fake.snapshot(), &verifier()).await;
    assert_eq!(view.target, PermissionTarget::Unresolved);
    assert!(host.is_none() && status.is_none() && failed);
    fake.replies.insert(1, Ok(Some(true)));
    fake.still_selected = false;
    assert_eq!(resolve(&fake, &verifier()).await.target, PermissionTarget::Unresolved);
}

pub(super) async fn assert_different_dr(first: IdentityVerdict, second: IdentityVerdict) {
    let current = HostChannel::Primary;
    let frozen = HostChannel::Frozen(FrozenId(1));
    let fake = fixture(Some(current), vec![host(current, 1, true), host(frozen, 2, true)]);
    let result = resolve(&fake, &Verifier(HashMap::from([(1, first), (2, second)]))).await;
    assert_eq!(result.target, PermissionTarget::Host);
    assert_eq!(result.other_hosts[0].reason, OtherHostReason::DifferentIdentity);
}

#[test]
fn serialization_contract_and_production_adapter_are_non_spawning() {
    let view = PermissionSubject { target: PermissionTarget::HostLegacy, subject: SubjectIdentity { pid: Some(1), generation: None, bundle_id: None }, other_hosts: vec![OtherHost { pid: 2, generation: None, reason: OtherHostReason::DifferentIdentity }], app_sessions: true };
    let json = serde_json::to_value(view).unwrap();
    assert_eq!(json["target"], "hostLegacy");
    assert_eq!(json["otherHosts"][0]["reason"], "differentIdentity");
    assert_eq!(json["appSessions"], true);
    let src = include_str!("../permissions.rs");
    let adapter = src.split("impl<R: Runtime> SubjectSource").nth(1).unwrap().split("#[cfg(test)]").next().unwrap();
    assert!(adapter.contains("spawn_target(self)"));
    for forbidden in ["ensure_hosts(", "connect_or_spawn(", "resolve_host_launch(", "spawn_sidecar"] { assert!(!adapter.contains(forbidden), "{forbidden}"); }
}
