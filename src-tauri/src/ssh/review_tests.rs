//! Regression tests for review round 1. All transports and trust paths are isolated.
use super::*;
use crate::ssh::tests::*;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

#[test]
fn rsa_policy_uses_exact_bits_and_native_home_expansion() {
    fn string(bytes: &mut Vec<u8>, value: &[u8]) {
        bytes.extend((value.len() as u32).to_be_bytes());
        bytes.extend(value);
    }
    for (first, accepted) in [(1, false), (0x7f, false), (0x80, true)] {
        let mut bytes = Vec::new();
        string(&mut bytes, b"ssh-rsa");
        string(&mut bytes, &[1, 0, 1]);
        let mut modulus = vec![0xff; 256];
        modulus[0] = first;
        if first == 0x80 {
            modulus.insert(0, 0);
        }
        string(&mut bytes, &modulus);
        let key = ssh_key::PublicKey::from_bytes(&bytes).unwrap();
        assert_eq!(acceptable_key(&key), accepted);
    }
    let home = PathBuf::from("fixture-home");
    assert_eq!(identity_path(&home, "~/.ssh/key"), home.join(".ssh/key"));
    #[cfg(windows)]
    assert_eq!(identity_path(&home, "~\\.ssh\\key"), home.join(".ssh\\key"));
}

#[tokio::test]
async fn agent_connect_cancellation_remains_cancelled() {
    struct PendingAgent;
    impl AgentFactory for PendingAgent {
        fn connect(&self) -> BoxFuture<'_, Result<DynamicAgent, SessionError>> {
            Box::pin(std::future::pending())
        }
    }
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
    f.registry.open("tm-a", "c-a", false, || true).unwrap();
    let e = f.registry.entry("tm-a", false).unwrap();
    let future = connect_agent(&e, &PendingAgent);
    tokio::pin!(future);
    tokio::select! { _ = &mut future => panic!("unexpected agent completion"), _ = tokio::time::sleep(Duration::from_millis(10)) => {} }
    e.cancel.cancel();
    assert!(matches!(future.await, Err(SessionError::Cancelled)));
    f.registry.shutdown().await;
}

#[tokio::test]
async fn revoked_other_key_allows_trust_and_refusal_publishes_once() {
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], false);
    std::fs::write(
        &f.path,
        format!("@revoked * {}\n", key(3).public_key().to_openssh().unwrap()),
    )
    .unwrap();
    let id = f.registry.probe("c-a").unwrap();
    let v = wait_state(&f.registry, &id, true, SessionState::NeedsHostkey).await;
    f.registry
        .trust_host(&id, true, None, v.prompt_id.as_deref(), true)
        .unwrap();
    wait_state(&f.registry, &id, true, SessionState::NeedsSecret).await;
    f.registry.shutdown().await;
    for revoked in [false, true] {
        let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], false);
        let public = if revoked { key(1) } else { key(2) };
        std::fs::write(
            &f.path,
            format!(
                "{}target.test {}\n",
                if revoked { "@revoked " } else { "" },
                public.public_key().to_openssh().unwrap()
            ),
        )
        .unwrap();
        let id = f.registry.probe("c-a").unwrap();
        wait_state(&f.registry, &id, true, SessionState::Error).await;
        tokio::time::sleep(Duration::from_millis(30)).await;
        let errors: Vec<_> = f
            .events
            .0
            .lock()
            .iter()
            .filter(|v| v.state == SessionState::Error)
            .cloned()
            .collect();
        assert_eq!(errors.len(), 1);
        assert!(errors[0].host_key.as_ref().unwrap().changed);
        let e = f.registry.entry(&id, true).unwrap();
        let revision = e.view().revision;
        e.update(|_| {});
        assert_eq!(e.view().revision, revision);
        f.registry.shutdown().await;
    }
}

#[tokio::test]
async fn remember_warning_survives_target_prompt_and_waits_for_running() {
    let mut jump = Server::new(1, "bastion");
    jump.target = Some(Box::new(Server::new(2, "alice")));
    let mut j = hop("jump", "bastion");
    j.host = "jump.test".into();
    let hops = vec![j, hop("c-a", "alice")];
    let f = Fixture::new(jump, hops.clone(), true);
    f.registry
        .configure(Dependencies {
            targets: Arc::new(Targets(SessionTarget { hops })),
            streams: Arc::new(MemoryStreams(f.server.clone())),
            agents: Arc::new(NativeAgent),
            secrets: Arc::new(crate::ssh::auth::NoSecrets),
            events: f.events.clone(),
            known_hosts: crate::ssh::known_hosts::KnownHosts {
                path: f.path.clone(),
            },
            home: f.path.parent().unwrap().into(),
        })
        .unwrap();
    let opened = f.registry.open("tm-a", "c-a", false, || true).unwrap();
    let v = wait_state(&f.registry, "tm-a", false, SessionState::NeedsSecret).await;
    f.registry
        .submit_secret(
            "tm-a",
            false,
            None,
            v.prompt_id.as_deref(),
            "password-bastion".into(),
            true,
        )
        .unwrap();
    let v = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let v = f.registry.state("tm-a", false).unwrap();
            if v.state == SessionState::NeedsSecret
                && v.prompt_target.as_ref().is_some_and(|p| p.hop == "target")
            {
                break v;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(!v
        .reason
        .as_deref()
        .unwrap_or_default()
        .contains("Connected;"));
    f.registry
        .submit_secret(
            "tm-a",
            false,
            None,
            v.prompt_id.as_deref(),
            "password-alice".into(),
            false,
        )
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while !f
            .registry
            .entry("tm-a", false)
            .unwrap()
            .inner
            .lock()
            .authenticated
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(!f
        .events
        .0
        .lock()
        .iter()
        .any(|v| v.state != SessionState::Connected
            && v.reason
                .as_deref()
                .is_some_and(|s| s.contains("Connected;"))));
    f.registry
        .on_launch_lifecycle("tm-a", opened.generation, 1, LaunchState::Running, None)
        .unwrap();
    let v = f.registry.state("tm-a", false).unwrap();
    assert_eq!(v.state, SessionState::Connected);
    assert!(v.reason.unwrap().contains("not saved"));
    f.registry.shutdown().await;
}

#[tokio::test]
async fn injection_targets_are_refused_without_writes_or_transport() {
    for host in [
        "good,*.prod",
        "*",
        "?",
        "!host",
        "|1|x|y",
        "@host",
        "#host",
        "[host]",
        "a/b",
        "a\\b",
        "a]:2222,[*.prod",
        "a:b",
        "-host",
        "a b",
    ] {
        let mut h = hop("c-a", "alice");
        h.host = host.into();
        let f = Fixture::new(Server::new(1, "alice"), vec![h], false);
        let id = f.registry.probe("c-a").unwrap();
        let v = wait_state(&f.registry, &id, true, SessionState::Error).await;
        assert_eq!(
            v.reason,
            Some(SessionError::InvalidTarget.reason()),
            "{host}"
        );
        assert!(!f.path.exists());
        assert_eq!(f.server.counters.handshakes.load(Ordering::SeqCst), 0);
        f.registry.shutdown().await;
    }
}

#[tokio::test]
async fn ipv6_direct_tcpip_uses_unbracketed_address_and_port_token() {
    for host in ["2001:db8::1", "[2001:db8::1]"] {
        let mut jump = Server::new(1, "bastion");
        jump.target = Some(Box::new(Server::new(2, "alice")));
        let mut j = hop("jump", "bastion");
        j.host = "jump.test".into();
        let mut h = hop("c-a", "alice");
        h.host = host.into();
        h.port = 2222;
        let f = Fixture::new(jump, vec![j, h], true);
        let id = f.registry.probe("c-a").unwrap();
        let v = wait_state(&f.registry, &id, true, SessionState::NeedsSecret).await;
        f.registry
            .submit_secret(
                &id,
                true,
                None,
                v.prompt_id.as_deref(),
                "password-bastion".into(),
                false,
            )
            .unwrap();
        let v = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let v = f.registry.state(&id, true).unwrap();
                if v.state == SessionState::NeedsSecret
                    && v.prompt_target.as_ref().is_some_and(|p| p.hop == "target")
                {
                    break v;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(v.prompt_target.as_ref().unwrap().host, "2001:db8::1");
        f.registry
            .submit_secret(
                &id,
                true,
                None,
                v.prompt_id.as_deref(),
                "password-alice".into(),
                false,
            )
            .unwrap();
        wait_state(&f.registry, &id, true, SessionState::Connected).await;
        assert_eq!(
            *f.server.counters.direct_addresses.lock(),
            vec![("2001:db8::1".into(), 2222)]
        );
        assert!(std::fs::read_to_string(&f.path)
            .unwrap()
            .contains("[2001:db8::1]:2222 "));
        f.registry.shutdown().await;
    }
}

#[tokio::test]
async fn dead_sftp_can_be_evicted_once_without_evicting_replacement() {
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
    let (_, session) = f.connected().await;
    let dead = session.sftp().await.unwrap();
    dead.request(|client| {
        Box::pin(async move {
            client
                .close()
                .await
                .map_err(|_| SessionError::TransportClosed)
        })
    })
    .await
    .unwrap();
    assert!(session.evict_sftp(&dead).await);
    assert!(!session.evict_sftp(&dead).await);
    let fresh = session.sftp().await.unwrap();
    assert!(!session.evict_sftp(&dead).await);
    fresh.request(|_| Box::pin(async { Ok(()) })).await.unwrap();
    assert_eq!(f.server.counters.subsystems.load(Ordering::SeqCst), 2);
    f.registry.shutdown().await;
}

#[tokio::test]
async fn with_session_awaits_exec_cancellation_cleanup() {
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
    let (_, session) = f.connected().await;
    let completed = Arc::new(AtomicBool::new(false));
    let done = completed.clone();
    let registry = f.registry.clone();
    let counts = f.server.counters.clone();
    let task = tokio::spawn(async move {
        crate::ssh::sessions::with_session(&registry, "tm-a", |s| async move {
            let result = s.exec("hang").await;
            // exec has joined its reader. Wait for the peer to observe its close.
            tokio::time::timeout(Duration::from_secs(1), async {
                while counts.closed_channels.load(Ordering::SeqCst) == 0 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            done.store(true, Ordering::SeqCst);
            result
        })
        .await
    });
    tokio::time::sleep(Duration::from_millis(40)).await;
    // Hold the transport's management handle so the generation shutdown cannot
    // overtake the exec channel's close on the wire.
    let management = session.handle.lock().await;
    f.registry.disconnect("tm-a", "test cancellation");
    assert_eq!(task.await.unwrap(), Err(SessionError::Cancelled));
    assert!(
        completed.load(Ordering::SeqCst),
        "operation/reader cleanup was dropped"
    );
    assert!(f.server.counters.closed_channels.load(Ordering::SeqCst) > 0);
    drop(management);
    f.registry.shutdown().await;
}
