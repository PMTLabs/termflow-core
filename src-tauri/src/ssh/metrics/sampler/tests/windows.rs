use super::*;

fn commands(wire: &Wire) -> Vec<bool> {
    wire.starts
        .lock()
        .iter()
        .map(|start| start.windows)
        .collect()
}

#[tokio::test]
async fn windows_probe_is_one_ordinary_tick_with_the_existing_deadline() {
    let (f, wire, events, sampler) = rig([Reply::UnframedExit(1), Reply::Hang, Reply::Good]);
    connect(&f, A).await;
    sampler.set_eligible(A, true).unwrap();
    let first = wire.started(1).await;
    assert_unavailable(&events.event(SAMPLE, 0).await, "Metrics command failed");
    let probe = wire.started(2).await;
    let jitter = Duration::from_millis(400);
    assert!((CADENCE - jitter..CADENCE + jitter).contains(&(probe - first)));
    sleep(ELIGIBILITY_WAKE).await;
    assert_eq!(commands(&wire), [false, true]);
    assert!(sampler.status(A).unwrap().2);
    assert!(events.events.lock().iter().all(|(name, _)| *name == SAMPLE));
    let control = events.event(CONTROL, 0).await;
    assert_eq!(control["pausedReason"], TIMEOUT);
    assert!((DEADLINE - jitter..DEADLINE + jitter).contains(&probe.elapsed()));
    assert_eq!(commands(&wire), [false, true]);
    sampler.resume(A).unwrap();
    assert_warming(&events.event(SAMPLE, 1).await);
    assert_eq!(commands(&wire), [false, true, false]);
    f.registry.shutdown().await;
}

#[tokio::test]
async fn windows_network_drive_watchdog_pauses_like_nfs() {
    let (f, wire, events, sampler) =
        rig([Reply::UnframedExit(1), Reply::WindowsWatchdog, Reply::Good]);
    let generation = connect(&f, A).await;
    sampler.set_eligible(A, true).unwrap();
    assert_unavailable(&events.event(SAMPLE, 0).await, "Metrics command failed");
    assert_eq!(
        events.event(CONTROL, 0).await,
        json!({
            "terminalId": A, "generation": generation, "pauseSeq": 1, "pausedReason": WINDOWS_WATCHDOG
        })
    );
    let completed = events.event(SAMPLE, 1).await;
    assert_eq!(completed["metrics"]["platform"], "Windows");
    assert_eq!(completed["metrics"]["host"]["hostname"], "WINHOST");
    assert_eq!(
        completed["metrics"]["partitions"]["mounts"][0]["source"],
        "C:"
    );
    assert_eq!(
        completed["metrics"]["nfs"],
        json!({"available":false,"reason":"Network drive usage watchdog expired"})
    );
    assert_warming(&completed);
    assert_eq!(
        sampler.fence(A).unwrap().paused_reason,
        Some(WINDOWS_WATCHDOG)
    );
    sleep(CADENCE + Duration::from_millis(100)).await;
    assert_eq!(commands(&wire), [false, true]);
    let receipt = sampler.resume(A).unwrap();
    assert_eq!(receipt.pause_seq, 2);
    assert_eq!(receipt.paused_reason, None);
    let next = events.event(SAMPLE, 2).await;
    assert_eq!(next["metrics"]["platform"], "Windows");
    assert_eq!(next["metrics"]["nfs"]["mounts"][0]["mountPoint"], "M:");
    assert_warming(&next);
    assert_eq!(commands(&wire), [false, true, true]);
    f.registry.shutdown().await;
}
