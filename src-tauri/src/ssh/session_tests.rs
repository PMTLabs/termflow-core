use super::*;
use crate::ssh::tests::*;
#[tokio::test]
async fn with_session_denies_every_nonconnected_state() {
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
    f.connected().await;
    let e = f.registry.entry("tm-a", false).unwrap();
    for state in [
        SessionState::Connecting,
        SessionState::NeedsSecret,
        SessionState::NeedsHostkey,
        SessionState::Disconnected,
        SessionState::Error,
    ] {
        e.inner.lock().view.state = state;
        assert!(matches!(
            f.registry.lease("tm-a"),
            Err(SessionError::NotConnected)
        ));
    }
    e.inner.lock().view.state = SessionState::Connected;
    assert!(f.registry.lease("tm-a").is_ok());
    f.registry.shutdown().await;
}
struct Inspect {
    token: Mutex<Option<CancellationToken>>,
    checked: std::sync::atomic::AtomicBool,
}
impl EventSink for Inspect {
    fn emit(&self, _: &'static str, view: &SessionView) {
        if view.state == SessionState::Disconnected {
            if let Some(token) = self.token.lock().as_ref() {
                assert!(
                    token.is_cancelled(),
                    "lease was not revoked before disconnected publication"
                );
                self.checked.store(true, Ordering::SeqCst);
            }
        }
    }
}
#[tokio::test]
async fn lease_revoked_before_disconnected_published() {
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
    let inspect = Arc::new(Inspect {
        token: Mutex::new(None),
        checked: std::sync::atomic::AtomicBool::new(false),
    });
    let old = f.registry.deps.read().clone();
    f.registry
        .configure(Dependencies {
            targets: old.targets.clone(),
            streams: old.streams.clone(),
            agents: old.agents.clone(),
            secrets: old.secrets.clone(),
            events: inspect.clone(),
            known_hosts: old.known_hosts.clone(),
            home: old.home.clone(),
        })
        .unwrap();
    let (_, lease) = f.connected().await;
    *inspect.token.lock() = Some(lease.cancellation());
    let mut transitions = f.registry.subscribe_transitions("tm-a").unwrap();
    transitions.borrow_and_update();
    f.registry.disconnect("tm-a", "ended");
    assert!(inspect.checked.load(Ordering::SeqCst));
    assert!(lease.cancellation().is_cancelled());
    assert_eq!(transitions.borrow().state, SessionState::Disconnected);
    assert!(matches!(
        f.registry.lease("tm-a"),
        Err(SessionError::NotConnected)
    ));
    f.registry.shutdown().await;
}
#[tokio::test]
async fn transitions_follow_generation() {
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
    let first = f.registry.open("tm-a", "c-a", false, || true).unwrap();
    let mut watch = f.registry.subscribe_transitions("tm-a").unwrap();
    assert_eq!(
        *watch.borrow_and_update(),
        SessionPhase {
            generation: first.generation,
            state: SessionState::Connecting
        }
    );
    let v = wait_state(&f.registry, "tm-a", false, SessionState::NeedsSecret).await;
    f.registry
        .submit_secret(
            "tm-a",
            false,
            Some(v.generation),
            v.prompt_id.as_deref(),
            f.server.password.clone(),
            false,
        )
        .unwrap();
    f.registry
        .on_launch_lifecycle(
            "tm-a",
            v.generation,
            1,
            LaunchState::Running,
            Some("pc-a".into()),
        )
        .unwrap();
    wait_state(&f.registry, "tm-a", false, SessionState::Connected).await;
    assert_eq!(
        *watch.borrow_and_update(),
        SessionPhase {
            generation: first.generation,
            state: SessionState::Connected
        }
    );
    f.registry.disconnect("tm-a", "ended");
    assert_eq!(
        *watch.borrow_and_update(),
        SessionPhase {
            generation: first.generation,
            state: SessionState::Disconnected
        }
    );
    let second = f.registry.reconnect("tm-a", || true).unwrap();
    let mut watch2 = f.registry.subscribe_transitions("tm-a").unwrap();
    let v = wait_state(&f.registry, "tm-a", false, SessionState::NeedsSecret).await;
    f.registry
        .submit_secret(
            "tm-a",
            false,
            Some(v.generation),
            v.prompt_id.as_deref(),
            f.server.password.clone(),
            false,
        )
        .unwrap();
    f.registry
        .on_launch_lifecycle(
            "tm-a",
            v.generation,
            1,
            LaunchState::Running,
            Some("pc-b".into()),
        )
        .unwrap();
    wait_state(&f.registry, "tm-a", false, SessionState::Connected).await;
    assert!(second.generation > first.generation);
    assert_eq!(
        *watch2.borrow_and_update(),
        SessionPhase {
            generation: second.generation,
            state: SessionState::Connected
        }
    );
    f.registry.shutdown().await;
}
#[tokio::test]
async fn replacement_cannot_publish_old_connected() {
    struct DynamicTargets;
    impl TargetSource for DynamicTargets {
        fn resolve<'a>(
            &'a self,
            id: &'a str,
        ) -> BoxFuture<'a, Result<SessionTarget, SessionError>> {
            Box::pin(async move {
                Ok(SessionTarget {
                    hops: vec![hop(id, "alice")],
                })
            })
        }
    }
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
    let old = f.registry.deps.read().clone();
    f.registry
        .configure(Dependencies {
            targets: Arc::new(DynamicTargets),
            streams: old.streams.clone(),
            agents: old.agents.clone(),
            secrets: old.secrets.clone(),
            events: old.events.clone(),
            known_hosts: old.known_hosts.clone(),
            home: old.home.clone(),
        })
        .unwrap();
    f.registry.open("tm-a", "c-a", false, || true).unwrap();
    let a = wait_state(&f.registry, "tm-a", false, SessionState::NeedsSecret).await;
    let entry = f.registry.entry("tm-a", false).unwrap();
    let b = f.registry.open("tm-a", "c-b", false, || true).unwrap();
    entry.update(|s| {
        s.authenticated = true;
        s.view.state = SessionState::Connected;
    });
    let current = f.registry.state("tm-a", false).unwrap();
    assert_eq!(current.generation, b.generation);
    assert_eq!(current.connection_id, "c-b");
    assert_ne!(current.state, SessionState::Connected);
    assert_eq!(
        f.registry.submit_secret(
            "tm-a",
            false,
            Some(a.generation),
            a.prompt_id.as_deref(),
            "late".into(),
            true
        ),
        Err(SessionError::StaleAttempt)
    );
    f.registry.shutdown().await;
}
#[tokio::test]
async fn test_close_cancels_waiter_and_emits_no_late_success() {
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
    let id = f.registry.probe("c-a").unwrap();
    let view = wait_state(&f.registry, &id, true, SessionState::NeedsSecret).await;
    f.registry.close(&id, true, None).unwrap();
    assert_eq!(
        f.registry.submit_secret(
            &id,
            true,
            Some(view.generation),
            view.prompt_id.as_deref(),
            "late".into(),
            false
        ),
        Err(SessionError::NotFound)
    );
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(f
        .events
        .0
        .lock()
        .iter()
        .all(|v| v.state != SessionState::Connected));
    assert!(f.registry.owner_map().is_empty());
    f.registry.shutdown().await;
}
/// Tauri runs sync commands (ssh_test_connection, ssh_session_open) on the
/// main thread with no Tokio context. Opening there must not panic.
#[test]
fn open_from_a_thread_without_a_tokio_runtime_does_not_panic() {
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
    let registry = f.registry.clone();
    let id = std::thread::spawn(move || registry.probe("c-a"))
        .join()
        .expect("probe panicked outside a Tokio runtime")
        .unwrap();
    let view = tauri::async_runtime::block_on(wait_state(&f.registry, &id, true, SessionState::NeedsSecret));
    assert_eq!(view.state, SessionState::NeedsSecret);
    f.registry.close(&id, true, None).unwrap();
    tauri::async_runtime::block_on(f.registry.shutdown());
}
