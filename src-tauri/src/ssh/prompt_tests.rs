use super::{session::*, tests::*};
use std::{sync::atomic::Ordering, time::Duration};
#[tokio::test]
async fn duplicate_or_stale_prompt_submission_is_refused() {
    for probe in [false, true] {
        let mut jump = Server::new(1, "bastion");
        jump.target = Some(Box::new(Server::new(2, "destination")));
        let mut jhop = hop("jump", "bastion");
        jhop.host = "jump.test".into();
        let f = Fixture::new(jump, vec![jhop, hop("c-a", "destination")], false);
        let id = if probe {
            f.registry.probe("c-a").unwrap()
        } else {
            f.registry.open("tm-a", "c-a", false, || true).unwrap();
            "tm-a".into()
        };
        let a = wait_state(&f.registry, &id, probe, SessionState::NeedsHostkey).await;
        f.registry
            .trust_host(&id, probe, Some(a.generation), a.prompt_id.as_deref(), true)
            .unwrap();
        let b = wait_state(&f.registry, &id, probe, SessionState::NeedsSecret).await;
        f.registry
            .submit_secret(
                &id,
                probe,
                Some(b.generation),
                b.prompt_id.as_deref(),
                "password-bastion".into(),
                false,
            )
            .unwrap();
        let c = wait_state(&f.registry, &id, probe, SessionState::NeedsHostkey).await;
        assert_eq!(a.generation, c.generation);
        assert_ne!(a.prompt_id, c.prompt_id);
        assert_eq!(c.prompt_target.as_ref().unwrap().connection_id, "c-a");
        assert_eq!(
            f.registry
                .trust_host(&id, probe, Some(a.generation), a.prompt_id.as_deref(), true),
            Err(SessionError::StaleAttempt)
        );
        f.registry
            .trust_host(&id, probe, Some(c.generation), c.prompt_id.as_deref(), true)
            .unwrap();
        let d = wait_state(&f.registry, &id, probe, SessionState::NeedsSecret).await;
        assert_eq!(
            f.registry.submit_secret(
                &id,
                probe,
                Some(b.generation),
                b.prompt_id.as_deref(),
                "password-bastion".into(),
                false
            ),
            Err(SessionError::StaleAttempt)
        );
        f.registry
            .submit_secret(
                &id,
                probe,
                Some(d.generation),
                d.prompt_id.as_deref(),
                "wrong-password".into(),
                true,
            )
            .unwrap();
        let e = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let v = f.registry.state(&id, probe).unwrap();
                if v.state == SessionState::NeedsSecret && v.prompt_id != d.prompt_id {
                    break v;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            f.registry.submit_secret(
                &id,
                probe,
                Some(d.generation),
                d.prompt_id.as_deref(),
                "wrong-password".into(),
                true
            ),
            Err(SessionError::StaleAttempt)
        );
        // The re-prompt after a rejected secret carries the code with its text (backlog 017).
        assert_eq!(
            (e.reason.clone(), e.error_code.as_deref()),
            (
                Some(SessionError::AuthRejected.reason()),
                Some("auth-rejected")
            )
        );
        assert_eq!(f.secrets.saves.load(Ordering::SeqCst), 0);
        f.registry
            .submit_secret(
                &id,
                probe,
                Some(e.generation),
                e.prompt_id.as_deref(),
                "password-destination".into(),
                false,
            )
            .unwrap();
        if !probe {
            f.registry
                .on_launch_lifecycle(
                    &id,
                    e.generation,
                    1,
                    LaunchState::Running,
                    Some("pc-a".into()),
                )
                .unwrap();
        }
        wait_state(&f.registry, &id, probe, SessionState::Connected).await;
        f.registry.shutdown().await;
    }
}
