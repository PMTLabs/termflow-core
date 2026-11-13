use super::{
    auth::{AuthBinding, NoSecrets},
    session::*,
    tests::*,
};
use std::sync::Arc;
#[tokio::test]
async fn rsa_sha2_key_file_authenticates_without_secret_prompt() {
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
    let bytes = include_str!("fixtures/client_rsa");
    let key = russh::keys::decode_secret_key(bytes, None).unwrap();
    let mut server = f.server.clone();
    server.client = key.public_key().clone();
    let identity = f.path.with_file_name("rsa_identity");
    std::fs::write(&identity, bytes).unwrap();
    let target = SessionHop {
        auth: AuthMethod::Key,
        identity_file: Some(identity.to_string_lossy().into_owned()),
        ..hop("c-a", "alice")
    };
    f.registry
        .configure(Dependencies {
            targets: Arc::new(Targets(SessionTarget { hops: vec![target] })),
            streams: Arc::new(MemoryStreams(server)),
            agents: Arc::new(NativeAgent),
            secrets: f.secrets.clone(),
            events: f.events.clone(),
            known_hosts: super::known_hosts::KnownHosts {
                path: f.path.clone(),
            },
            home: f.path.parent().unwrap().into(),
        })
        .unwrap();
    let id = f.registry.probe("c-a").unwrap();
    wait_state(&f.registry, &id, true, SessionState::Connected).await;
    assert!(f
        .events
        .0
        .lock()
        .iter()
        .all(|v| v.state != SessionState::NeedsSecret));
    f.registry.shutdown().await;
}
#[tokio::test]
async fn keyring_failure_prompts_without_overwriting_ciphertext() {
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
    let binding = AuthBinding::for_hop(&hop("c-a", "alice"), None);
    f.secrets
        .values
        .lock()
        .insert("c-a".into(), (binding, "v1:broken-ciphertext".into()));
    let id = f.registry.probe("c-a").unwrap();
    let view = wait_state(&f.registry, &id, true, SessionState::NeedsSecret).await;
    assert!(view.reason.as_deref().unwrap().contains("unavailable"));
    f.registry
        .submit_secret(
            &id,
            true,
            Some(view.generation),
            view.prompt_id.as_deref(),
            f.server.password.clone(),
            false,
        )
        .unwrap();
    wait_state(&f.registry, &id, true, SessionState::Connected).await;
    assert_eq!(f.secrets.values.lock()["c-a"].1, "v1:broken-ciphertext");
    f.registry.shutdown().await;
}
#[tokio::test]
async fn remember_write_failure_reports_connected_not_saved() {
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
    f.registry
        .configure(Dependencies {
            targets: Arc::new(Targets(SessionTarget {
                hops: vec![hop("c-a", "alice")],
            })),
            streams: Arc::new(MemoryStreams(f.server.clone())),
            agents: Arc::new(NativeAgent),
            secrets: Arc::new(NoSecrets),
            events: f.events.clone(),
            known_hosts: super::known_hosts::KnownHosts {
                path: f.path.clone(),
            },
            home: f.path.parent().unwrap().into(),
        })
        .unwrap();
    let id = f.registry.probe("c-a").unwrap();
    let view = wait_state(&f.registry, &id, true, SessionState::NeedsSecret).await;
    f.registry
        .submit_secret(
            &id,
            true,
            Some(view.generation),
            view.prompt_id.as_deref(),
            f.server.password.clone(),
            true,
        )
        .unwrap();
    let connected = wait_state(&f.registry, &id, true, SessionState::Connected).await;
    assert!(connected.reason.as_deref().unwrap().contains("not saved"));
    f.registry.shutdown().await;
}
