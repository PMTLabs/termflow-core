// An injected, non-spawning inventory still uses the production resolver and
// wire-status adapter. No AppState, host process, or TCC service is needed.
use super::*;

pub(crate) struct WireInventory(pub Vec<PtyHostClient>);
impl SubjectSource for WireInventory {
    type Handle = PtyHostClient;
    fn snapshot(&self) -> Snapshot<PtyHostClient> {
        Snapshot {
            selected: Some(HostChannel::Primary),
            hosts: self.0.iter().enumerate().map(|(i, client)| Host {
                channel: if i == 0 { HostChannel::Primary } else { HostChannel::Frozen(crate::elevated_host::FrozenId(i as u64)) },
                handle: client.clone(), pid: Some(100 + i as u32),
                generation: Some(format!("g{i}")), capable: true, spawn_identity: None,
            }).collect(),
            disabled: false, helper_unavailable: false, reconnecting: false, app_sessions: false,
        }
    }
    async fn status(&self, client: &PtyHostClient) -> Result<(Option<bool>, Option<PermissionStatus>), ()> {
        wire_status(client).await
    }
    fn still_selected(&self, _: &Host<PtyHostClient>) -> bool { true }
}
impl WireInventory {
    pub async fn resolve(&self) -> ResolvedPermissionSubject {
        struct Verified;
        impl HostIdentityVerifier for Verified {
            fn verify(&self, _: u32) -> IdentityVerdict { IdentityVerdict::Matches("test-DR".into()) }
        }
        let (view, host, status, resolution_failed) = resolve_snapshot(self, self.snapshot(), &Verified).await;
        ResolvedPermissionSubject { view, host, status, resolution_failed }
    }
}
