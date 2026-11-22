use super::{session::*, tests::*};
use std::{sync::atomic::Ordering, time::Duration};
#[tokio::test]
async fn host_key_policy_table_blocks_auth_and_direct_trust() {
    let other = key(2).public_key().to_openssh().unwrap();
    let key = key(1).public_key().to_openssh().unwrap();
    let rsa = include_str!("fixtures/client_rsa.pub");
    let cases = [
        format!("target.test {other}\n"),
        format!("target.test {rsa}"),
        format!("target.test {key}\n@revoked target.test {key}\n"),
        format!("@cert-authority target.test {key}\n"),
        format!("@unknown target.test {key}\n"),
        "target.test ssh-ed25519 !!!\n".into(),
        // D81: a valid pattern in a list with a bad one still names this host, so it fails closed.
        format!("target.test,,bad {key}\n"),
        format!("@revoked target.test,,bad {key}\n"),
    ];
    // D81: a line whose host field cannot name this host is skipped as OpenSSH does. The host
    // stays unknown: the probe asks for trust, never auths or writes.
    for bytes in [
        format!("|1|broken|broken {key}\n"),
        format!("other.test,,bad {key}\n"),
        format!("|2|unsupported|bad {key}\n"),
    ] {
        let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], false);
        std::fs::write(&f.path, &bytes).unwrap();
        let id = f.registry.probe("c-a").unwrap();
        let v = wait_state(&f.registry, &id, true, SessionState::NeedsHostkey).await;
        assert!(v.host_key.is_some(), "{bytes}");
        assert_eq!(f.server.counters.auth.load(Ordering::SeqCst), 0);
        assert_eq!(std::fs::read_to_string(&f.path).unwrap(), bytes);
        assert!(!f.events.0.lock().iter().any(|v| v.gate == Gate::Verified));
        f.registry.shutdown().await;
    }
    for unreadable in ["directory", "oversized"] {
        let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], false);
        if unreadable == "directory" {
            std::fs::create_dir(&f.path).unwrap();
        } else {
            std::fs::write(&f.path, vec![b' '; 8 * 1024 * 1024 + 1]).unwrap();
        }
        let before = std::fs::metadata(&f.path).unwrap().len();
        let id = f.registry.probe("c-a").unwrap();
        let v = wait_state(&f.registry, &id, true, SessionState::Error).await;
        assert_eq!(v.reason, Some(SessionError::KnownHostsUnreadable.reason()));
        assert_eq!(v.error_code.as_deref(), Some("known-hosts-unreadable"));
        assert_eq!(
            f.registry.trust_host(&id, true, None, None, true),
            Err(SessionError::StaleAttempt)
        );
        assert_eq!(f.server.counters.auth.load(Ordering::SeqCst), 0);
        assert_eq!(std::fs::metadata(&f.path).unwrap().len(), before);
        assert!(!f.events.0.lock().iter().any(|v| v.gate == Gate::Verified));
        f.registry.shutdown().await;
    }
    for bytes in cases {
        let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], false);
        std::fs::write(&f.path, &bytes).unwrap();
        let id = f.registry.probe("c-a").unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let v = f.registry.state(&id, true).unwrap();
                if matches!(v.state, SessionState::Error | SessionState::Disconnected) {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(f.server.counters.auth.load(Ordering::SeqCst), 0);
        assert_eq!(
            f.registry.trust_host(&id, true, None, None, true),
            Err(SessionError::StaleAttempt)
        );
        assert_eq!(std::fs::read_to_string(&f.path).unwrap(), bytes);
        assert!(!f.events.0.lock().iter().any(|v| v.gate == Gate::Verified));
        f.registry.shutdown().await;
    }
    for bytes in [
        format!("target.test {key}\n@revoked * {other}\n"),
        format!("target.test {rsa}\ntarget.test {key}\n"),
    ] {
        let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], false);
        std::fs::write(&f.path, bytes).unwrap();
        f.connected().await;
        assert!(f.server.counters.auth.load(Ordering::SeqCst) > 0);
        f.registry.shutdown().await;
    }
}
#[tokio::test]
async fn cancel_waiting_jump_drops_both_handles() {
    let mut jump = Server::new(1, "bastion");
    let target = Server::new(2, "destination");
    let target_counts = target.counters.clone();
    jump.target = Some(Box::new(target));
    let mut jhop = hop("jump", "bastion");
    jhop.host = "jump.test".into();
    let f = Fixture::new(jump, vec![jhop, hop("c-a", "destination")], true);
    let id = f.registry.probe("c-a").unwrap();
    let a = wait_state(&f.registry, &id, true, SessionState::NeedsSecret).await;
    f.registry
        .submit_secret(
            &id,
            true,
            None,
            a.prompt_id.as_deref(),
            "password-bastion".into(),
            false,
        )
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let v = f.registry.state(&id, true).unwrap();
            if v.state == SessionState::NeedsSecret && v.prompt_id != a.prompt_id {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(target_counts.live_connections.load(Ordering::SeqCst), 1);
    f.registry.close(&id, true, None).unwrap();
    f.registry.shutdown().await;
    tokio::time::timeout(Duration::from_secs(1), async {
        while target_counts.live_connections.load(Ordering::SeqCst) != 0
            || f.server.counters.live_connections.load(Ordering::SeqCst) != 0
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(target_counts.auth.load(Ordering::SeqCst), 0);
    assert!(f.registry.owner_map().is_empty());
}
#[tokio::test]
async fn jump_direct_tcpip_denied_and_target_key_changed_never_connect() {
    for changed in [false, true] {
        let mut jump = Server::new(1, "bastion");
        let target = Server::new(2, "destination");
        let target_counts = target.counters.clone();
        jump.target = Some(Box::new(target));
        jump.deny_jump = !changed;
        let mut jhop = hop("jump", "bastion");
        jhop.host = "jump.test".into();
        let f = Fixture::new(jump, vec![jhop, hop("c-a", "destination")], true);
        if changed {
            let bytes = format!(
                "jump.test {}\ntarget.test {}\n",
                key(1).public_key().to_openssh().unwrap(),
                key(3).public_key().to_openssh().unwrap()
            );
            std::fs::write(&f.path, bytes).unwrap();
        }
        let id = f.registry.probe("c-a").unwrap();
        let a = wait_state(&f.registry, &id, true, SessionState::NeedsSecret).await;
        f.registry
            .submit_secret(
                &id,
                true,
                None,
                a.prompt_id.as_deref(),
                "password-bastion".into(),
                false,
            )
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let v = f.registry.state(&id, true).unwrap();
                if matches!(v.state, SessionState::Error | SessionState::Disconnected) {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(target_counts.auth.load(Ordering::SeqCst), 0);
        assert!(f.events.0.lock().iter().all(|v| v.gate != Gate::Verified));
        f.registry.shutdown().await;
    }
}
