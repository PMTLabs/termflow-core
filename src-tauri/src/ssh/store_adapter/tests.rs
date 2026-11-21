use super::*;
use crate::ssh::{session::*, tests::*};
use std::sync::Mutex;

struct Setup {
    path: PathBuf,
    store: Store,
    adapter: StoreAdapter,
    events: Arc<Mutex<Vec<Reply>>>,
}
impl Setup {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("tf-ssh-adapter-{}", uuid::Uuid::new_v4()));
        let store = Store::new(path.join("connections.json"));
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let adapter = StoreAdapter::new(
            store.clone(),
            path.clone(),
            Arc::new(move |r| captured.lock().unwrap().push(r.clone())),
        );
        store
            .transact(
                |data| {
                    data.connections.push(row("c-a"));
                    data.connections.push(row("c-b"));
                    Ok(())
                },
                |_| {},
            )
            .unwrap();
        Self {
            path,
            store,
            adapter,
            events,
        }
    }
    fn bytes(&self) -> Vec<u8> {
        std::fs::read(self.path.join("connections.json")).unwrap()
    }
}
impl Drop for Setup {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}
fn row(id: &str) -> crate::ssh::store::Connection {
    crate::ssh::store::Connection {
        id: id.into(),
        folder_id: None,
        name: id.into(),
        host: "target.test".into(),
        port: 22,
        user: "alice".into(),
        auth: Auth::Password,
        identity_file: None,
        jump_connection_id: None,
        extra_options: vec![],
        bookmarked: false,
        order: if id == "c-a" { 0 } else { 1 },
        last_used_at: None,
        secret: None,
    }
}
fn binding() -> AuthBinding {
    AuthBinding::for_hop(&hop("c-a", "alice"), None)
}

#[tokio::test]
async fn stored_connection_and_jump_use_shared_resolver_and_native_blank_user() {
    let s = Setup::new();
    s.store
        .transact(
            |d| {
                d.connections[0].jump_connection_id = Some("c-b".into());
                d.connections[0].host = "Web_01.Internal.".into();
                d.connections[0].extra_options = vec![("Compression".into(), "yes".into())];
                d.connections[1].user = "".into();
                d.connections[1].port = 2222;
                Ok(())
            },
            |_| {},
        )
        .unwrap();
    let target = s.adapter.resolve("c-a").await.unwrap();
    assert_eq!(target.hops.len(), 2);
    assert_eq!(target.hops[0].connection_id, "c-b");
    assert_eq!(target.hops[0].port, 2222);
    assert_eq!(target.hops[0].user, effective_user("").unwrap());
    assert_eq!(target.hops[1].host, "web_01.internal");
    assert_eq!(target.hops[1].user, "alice");
    assert_eq!(
        s.adapter.resolve("deleted").await,
        Err(SessionError::NotFound)
    );
    s.store
        .transact(
            |d| {
                d.connections[0].jump_connection_id = None;
                d.delete_connection("c-a")
            },
            |_| {},
        )
        .unwrap();
    assert_eq!(s.adapter.resolve("c-a").await, Err(SessionError::NotFound));
}
#[tokio::test]
async fn invalid_saved_target_is_refused_before_transport() {
    let s = Setup::new();
    // 065 accepts repeated root dots; 067 must validate again.
    s.store
        .transact(
            |d| {
                d.connections[0].host = "host..".into();
                Ok(())
            },
            |_| {},
        )
        .unwrap();
    assert_eq!(
        s.adapter.resolve("c-a").await,
        Err(SessionError::InvalidTarget)
    );
    let mut data = s.store.snapshot().unwrap();
    data.connections[0].host = "a,*.prod".into();
    std::fs::write(
        s.path.join("connections.json"),
        serde_json::to_vec(&data).unwrap(),
    )
    .unwrap();
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
    f.registry
        .configure(Dependencies {
            targets: Arc::new(s.adapter.clone()),
            streams: Arc::new(MemoryStreams(f.server.clone())),
            agents: Arc::new(NativeAgent),
            secrets: f.secrets.clone(),
            events: f.events.clone(),
            known_hosts: crate::ssh::known_hosts::KnownHosts {
                path: f.path.clone(),
            },
            home: s.path.clone(),
        })
        .unwrap();
    f.registry.open("tm-a", "c-a", false, || true).unwrap();
    wait_state(&f.registry, "tm-a", false, SessionState::Error).await;
    assert_eq!(
        f.server
            .counters
            .handshakes
            .load(std::sync::atomic::Ordering::SeqCst),
        0
    );
    f.registry.shutdown().await;
}
#[tokio::test]
async fn remember_binding_mismatch_and_cancel_leave_disk_cache_revision_events_unchanged() {
    let s = Setup::new();
    let original = s.store.get().unwrap();
    let bytes = s.bytes();
    let mut b = binding();
    b.host = "changed.test".into();
    assert_eq!(
        s.adapter
            .set_secret_if_binding_matches(&b, "ciphertext".into(), CancellationToken::new())
            .await,
        Err(SessionError::StaleAttempt)
    );
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert_eq!(
        s.adapter
            .set_secret_if_binding_matches(&binding(), "ciphertext".into(), cancel)
            .await,
        Err(SessionError::Cancelled)
    );
    assert_eq!(s.bytes(), bytes);
    assert_eq!(s.store.get().unwrap(), original);
    assert!(s.events.lock().unwrap().is_empty());
}
#[tokio::test]
async fn key_identity_and_every_auth_binding_field_are_compared_on_fresh_store() {
    let s = Setup::new();
    let identity = s.path.join("identity");
    std::fs::write(&identity, include_str!("../fixtures/client_enc")).unwrap();
    s.store
        .transact(
            |d| {
                d.connections[0].auth = Auth::KeyFile;
                d.connections[0].identity_file = Some(identity.to_string_lossy().into());
                Ok(())
            },
            |_| {},
        )
        .unwrap();
    let target = s.adapter.resolve("c-a").await.unwrap();
    let key = ssh_key::PrivateKey::read_openssh_file(&identity).unwrap();
    let b = AuthBinding::for_hop(
        &target.hops[0],
        Some(
            key.public_key()
                .fingerprint(ssh_key::HashAlg::Sha256)
                .to_string(),
        ),
    );
    s.adapter
        .set_secret_if_binding_matches(&b, "v1:key-secret".into(), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        s.adapter.load(&b).await.unwrap().as_deref(),
        Some("v1:key-secret")
    );
    let bytes = s.bytes();
    let previous = s.store.get().unwrap();
    let event_count = s.events.lock().unwrap().len();
    for changed in [
        AuthBinding {
            user: "bob".into(),
            ..b.clone()
        },
        AuthBinding {
            port: 2222,
            ..b.clone()
        },
        AuthBinding {
            auth: AuthMethod::Password,
            ..b.clone()
        },
        AuthBinding {
            connection_id: "missing".into(),
            ..b.clone()
        },
        AuthBinding {
            identity_fingerprint: Some("SHA256:wrong".into()),
            ..b.clone()
        },
    ] {
        assert_eq!(
            s.adapter
                .set_secret_if_binding_matches(
                    &changed,
                    "replacement".into(),
                    CancellationToken::new()
                )
                .await,
            Err(SessionError::StaleAttempt)
        );
    }
    assert_eq!(s.bytes(), bytes);
    assert_eq!(s.store.get().unwrap(), previous);
    assert_eq!(s.events.lock().unwrap().len(), event_count);
    // Same configured path, different key: fresh fingerprint must refuse reuse.
    std::fs::write(identity, include_str!("../fixtures/client_rsa")).unwrap();
    assert_eq!(s.adapter.load(&b).await, Err(SessionError::StaleAttempt));
}
#[test]
fn cancellation_at_final_commit_fence_keeps_candidate_unpublished() {
    let s = Setup::new();
    let previous = s.store.get().unwrap();
    let bytes = s.bytes();
    let cancel = CancellationToken::new();
    let result = s.store.transact_checked(
        |d| {
            d.connections[0].secret = Some("must-not-commit".into());
            cancel.cancel();
            Ok(())
        },
        || {
            if cancel.is_cancelled() {
                Err(refusal("cancelled"))
            } else {
                Ok(())
            }
        },
        |_| panic!("cancelled candidate was published"),
    );
    assert_eq!(result.unwrap_err().code, "cancelled");
    assert_eq!(s.bytes(), bytes);
    assert_eq!(s.store.get().unwrap(), previous);
}
#[tokio::test]
async fn remember_merge_preserves_concurrent_bookmark_and_mark_used() {
    let s = Setup::new();
    let old = s.store.get().unwrap();
    // Hold an independent instance's transaction open while Remember starts.
    // The sink must acquire ConfigLock and reload after this candidate commits.
    let other = Store::new(s.path.join("connections.json"));
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let held = barrier.clone();
    let (ready, entered) = tokio::sync::oneshot::channel();
    let edit = tokio::task::spawn_blocking(move || {
        other.transact(
            |d| {
                d.set_bookmark("c-a", true)?;
                d.connections[0].last_used_at = Some("2026-11-13T12:00:00Z".into());
                d.connections[1].name = "unrelated edit".into();
                ready.send(()).unwrap();
                held.wait();
                Ok(())
            },
            |_| {},
        )
    });
    entered.await.unwrap();
    let adapter = s.adapter.clone();
    let save = tokio::spawn(async move {
        adapter
            .set_secret_if_binding_matches(
                &binding(),
                "v1:ciphertext".into(),
                CancellationToken::new(),
            )
            .await
    });
    tokio::task::yield_now().await;
    barrier.wait();
    let changed = edit.await.unwrap().unwrap();
    save.await.unwrap().unwrap();
    let fresh = Store::new(s.path.join("connections.json"));
    let data = fresh.snapshot().unwrap();
    assert!(data.revision > changed.revision);
    assert!(changed.revision > old.revision);
    assert!(data.connections[0].bookmarked);
    assert!(data.connections[0].last_used_at.is_some());
    assert_eq!(data.connections[1].name, "unrelated edit");
    assert_eq!(data.connections[0].secret.as_deref(), Some("v1:ciphertext"));
    assert_eq!(
        s.adapter.load(&binding()).await.unwrap().as_deref(),
        Some("v1:ciphertext")
    );
    let events = s.events.lock().unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0], fresh.get().unwrap());
    assert!(!serde_json::to_string(&events[0])
        .unwrap()
        .contains("ciphertext"));
}
#[tokio::test]
async fn settings_test_to_launch_uses_same_target_and_trust() {
    let s = Setup::new();
    let original = s.bytes();
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], false);
    f.registry
        .configure(Dependencies {
            targets: Arc::new(s.adapter.clone()),
            streams: Arc::new(MemoryStreams(f.server.clone())),
            agents: Arc::new(NativeAgent),
            secrets: Arc::new(s.adapter.clone()),
            events: f.events.clone(),
            known_hosts: crate::ssh::known_hosts::KnownHosts {
                path: f.path.clone(),
            },
            home: s.path.clone(),
        })
        .unwrap();
    let probe = f.registry.probe("c-a").unwrap();
    let trust = wait_state(&f.registry, &probe, true, SessionState::NeedsHostkey).await;
    assert_eq!(
        f.server
            .counters
            .auth
            .load(std::sync::atomic::Ordering::SeqCst),
        0
    );
    assert_eq!(trust.prompt_target.unwrap().host, "target.test");
    f.registry
        .trust_host(
            &probe,
            true,
            Some(trust.generation),
            trust.prompt_id.as_deref(),
            true,
        )
        .unwrap();
    let secret = wait_state(&f.registry, &probe, true, SessionState::NeedsSecret).await;
    f.registry
        .submit_secret(
            &probe,
            true,
            None,
            secret.prompt_id.as_deref(),
            "password-alice".into(),
            false,
        )
        .unwrap();
    let connected = wait_state(&f.registry, &probe, true, SessionState::Connected).await;
    let paths = connected.known_hosts_paths.unwrap();
    assert_eq!(paths.target, f.path.to_string_lossy());
    assert!(f.registry.owner_map().is_empty());
    assert_eq!(s.bytes(), original);
    f.registry.close(&probe, true, None).unwrap();
    f.registry.open("tm-a", "c-a", false, || true).unwrap();
    let secret = wait_state(&f.registry, "tm-a", false, SessionState::NeedsSecret).await;
    assert_eq!(secret.prompt_target.unwrap().host, "target.test");
    assert_eq!(secret.known_hosts_paths.unwrap(), paths);
    assert_eq!(secret.gate, Gate::Verified);
    f.registry
        .submit_secret(
            "tm-a",
            false,
            None,
            secret.prompt_id.as_deref(),
            "password-alice".into(),
            false,
        )
        .unwrap();
    f.registry
        .on_launch_lifecycle(
            "tm-a",
            secret.generation,
            1,
            LaunchState::Running,
            Some("pc-synthetic".into()),
        )
        .unwrap();
    wait_state(&f.registry, "tm-a", false, SessionState::Connected).await;
    // No mark-used is hidden in 067; 066 owns that distinct launch mutation.
    assert_eq!(s.bytes(), original);
    assert!(s.events.lock().unwrap().is_empty());
    f.registry.shutdown().await;
}
#[tokio::test]
async fn remember_store_write_failure_reports_connected_not_saved() {
    let s = Setup::new();
    let original = s.bytes();
    let mut adapter = s.adapter.clone();
    adapter.store = s.store.clone().failing_writer();
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
    f.registry
        .configure(Dependencies {
            targets: Arc::new(adapter.clone()),
            streams: Arc::new(MemoryStreams(f.server.clone())),
            agents: Arc::new(NativeAgent),
            secrets: Arc::new(adapter),
            events: f.events.clone(),
            known_hosts: crate::ssh::known_hosts::KnownHosts {
                path: f.path.clone(),
            },
            home: s.path.clone(),
        })
        .unwrap();
    f.registry.open("probe-a", "c-a", true, || true).unwrap();
    let v = wait_state(&f.registry, "probe-a", true, SessionState::NeedsSecret).await;
    f.registry
        .submit_secret(
            "probe-a",
            true,
            None,
            v.prompt_id.as_deref(),
            "password-alice".into(),
            true,
        )
        .unwrap();
    let v = wait_state(&f.registry, "probe-a", true, SessionState::Connected).await;
    assert!(v.reason.unwrap().contains("not saved"));
    assert_eq!(s.bytes(), original);
    assert!(s.events.lock().unwrap().is_empty());
    f.registry.shutdown().await;
}
