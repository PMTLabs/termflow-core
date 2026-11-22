use super::{session::*, tests::*};
use std::{collections::HashMap, time::Duration};

#[tokio::test]
async fn terminal_ended_healthy_app_is_disconnected() {
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
    let (_, lease) = f.connected().await;
    let v = f.registry.state("tm-a", false).unwrap();
    f.registry
        .on_launch_lifecycle("tm-a", v.generation, 2, LaunchState::Ended, None)
        .unwrap();
    assert_eq!(
        f.registry.state("tm-a", false).unwrap().state,
        SessionState::Disconnected
    );
    assert!(lease.cancellation().is_cancelled());
    assert_eq!(lease.exec("fixture").await, Err(SessionError::Cancelled));
    f.registry.shutdown().await;
}
#[tokio::test]
async fn old_ended_event_does_not_disconnect_new_attempt() {
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
    let (_, old) = f.connected().await;
    let a = f.registry.state("tm-a", false).unwrap();
    let b = f.registry.reconnect("tm-a", || true).unwrap();
    assert_ne!(a.generation, b.generation);
    assert_eq!(
        f.registry
            .on_launch_lifecycle("tm-a", a.generation, 99, LaunchState::Ended, None),
        Err(SessionError::StaleAttempt)
    );
    assert_eq!(
        f.registry.state("tm-a", false).unwrap().generation,
        b.generation
    );
    assert!(old.cancellation().is_cancelled());
    assert_eq!(
        f.registry.close("tm-a", false, Some(a.generation)),
        Err(SessionError::StaleAttempt)
    );
    f.registry.shutdown().await;
}
#[tokio::test]
async fn out_of_order_launch_seq_is_ignored() {
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
    f.connected().await;
    let v = f.registry.state("tm-a", false).unwrap();
    f.registry
        .on_launch_lifecycle(
            "tm-a",
            v.generation,
            3,
            LaunchState::Running,
            Some("pc-a".into()),
        )
        .unwrap();
    assert_eq!(
        f.registry
            .on_launch_lifecycle("tm-a", v.generation, 2, LaunchState::Ended, None),
        Err(SessionError::StaleAttempt)
    );
    assert_eq!(
        f.registry.current_launch("tm-a").unwrap(),
        CurrentLaunch {
            generation: v.generation,
            state: Some(LaunchState::Running),
            connected: true,
            process_id: Some("pc-a".into())
        }
    );
    f.registry.shutdown().await;
}
#[tokio::test]
async fn tray_hide_keeps_owners_exit_empties_panes_and_probes() {
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
    f.connected().await;
    let probe = f.registry.probe("c-a").unwrap();
    f.registry.reconcile(|id| id == "tm-a"); // hide/transfer retains exact leaf
    assert_eq!(
        f.registry.owner_map(),
        HashMap::from([("tm-a".into(), ("c-a".into(), SessionState::Connected))])
    );
    f.registry.shutdown().await;
    assert!(f.registry.owner_map().is_empty());
    assert_eq!(f.registry.state(&probe, true), Err(SessionError::NotFound));
    assert_eq!(
        f.registry.open("tm-b", "c-a", false, || true),
        Err(SessionError::AdmissionClosed)
    );
}
#[tokio::test]
async fn close_waiting_pane_tab_and_final_window_cancel_all_prompts() {
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
    f.registry.open("tm-a", "c-a", false, || true).unwrap();
    f.registry.open("tm-b", "c-a", false, || true).unwrap();
    let a = wait_state(&f.registry, "tm-a", false, SessionState::NeedsSecret).await;
    wait_state(&f.registry, "tm-b", false, SessionState::NeedsSecret).await;
    f.registry.reconcile(|id| id == "tm-b");
    assert_eq!(
        f.registry.owner_map(),
        HashMap::from([("tm-b".into(), ("c-a".into(), SessionState::NeedsSecret))])
    );
    assert_eq!(
        f.registry.submit_secret(
            "tm-a",
            false,
            Some(a.generation),
            a.prompt_id.as_deref(),
            "secret".into(),
            false
        ),
        Err(SessionError::NotFound)
    );
    f.registry.reconcile(|_| false);
    assert!(f.registry.owner_map().is_empty());
    f.registry.shutdown().await;
}
#[tokio::test]
async fn reconnect_returns_new_generation_and_fresh_gate_after_trust() {
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
    f.connected().await;
    let a = f.registry.state("tm-a", false).unwrap();
    let b = f.registry.reconnect("tm-a", || true).unwrap();
    assert!(b.generation > a.generation);
    assert_eq!(b.gate, Gate::Pending);
    let v = wait_state(&f.registry, "tm-a", false, SessionState::NeedsSecret).await;
    assert_eq!(v.gate, Gate::Verified);
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
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        f.registry.state("tm-a", false).unwrap().state,
        SessionState::Connecting
    ); // no invented terminal running
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
    f.registry.shutdown().await;
}
