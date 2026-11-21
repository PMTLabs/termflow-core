use super::*;

#[tokio::test]
async fn timeout_surviving_remote_child_pauses_automatic_collectors() {
    // T1 exercises a surviving shell child. Here the memory peer reports both
    // watchdog statuses; the worker must not treat a normal SSH CLOSE as proof
    // the watchdog terminated its child.
    for exit in [124, 137] {
        let (ping, pong) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
        let (f, wire, events, sampler) = rig([Reply::WatchdogWithChild {
            exit,
            ping: ping.clone(),
            pong: pong.clone(),
        }]);
        let generation = connect(&f, A).await;
        sampler.set_eligible(A, true).unwrap();
        assert_eq!(events.event("ssh-metrics:control", 0).await, json!({
            "terminalId": A, "generation": generation, "pauseSeq": 1,
            "pausedReason": "Metrics paused: NFS usage watchdog expired"
        }));
        let completed = events.event(SAMPLE, 0).await;
        assert_eq!(completed["metrics"]["partitions"]["mounts"][0]["source"], "/dev/test");
        assert_eq!(completed["metrics"]["nfs"]["available"], false);
        assert_eq!(events.events.lock()[0].0, CONTROL);
        assert_eq!(events.events.lock()[1].0, SAMPLE);
        assert_warming(&completed);
        let prior_worker = sampler.existing(A).unwrap();
        let renewed = sampler.fence(A).unwrap();
        sampler.set_eligible(A, false).unwrap();
        let remount = sampler.fence(A).unwrap();
        sampler.set_eligible(A, true).unwrap();
        assert!(Arc::ptr_eq(&prior_worker, &sampler.existing(A).unwrap()));
        assert_eq!(remount.pause_seq, renewed.pause_seq);
        assert_eq!(remount.paused_reason, renewed.paused_reason);
        assert!(remount.sample_floor > renewed.sample_floor);
        sleep(CADENCE * 2 + Duration::from_millis(100)).await;
        ping.notify_one();
        timeout(WAIT, pong.notified()).await.expect("child survived exec close");
        assert_eq!(wire.count(), 1); // No automatic collector after remount or ticks.
        assert_eq!(events.events.lock().len(), 2);
        if exit == 124 {
            let resumed = sampler.resume(A).unwrap();
            assert_eq!(events.event(CONTROL, 1).await, json!({
                "terminalId": A,"generation": generation,"pauseSeq": 2,"pausedReason":null
            }));
            assert_eq!(resumed.pause_seq, 2);
            assert_eq!(resumed.paused_reason, None);
        } else {
            let fresh = reconnect(&f).await;
            let fence = sampler.fence(A).unwrap();
            assert!(fresh > generation);
            assert_eq!(fence.generation, fresh);
            assert_eq!(fence.pause_seq, 0);
            assert_eq!(fence.paused_reason, None);
            assert_eq!(events.event(CONTROL, 1).await, json!({
                "terminalId": A,"generation": fresh,"pauseSeq": 0,"pausedReason":null
            }));
        }
        assert_warming(&events.event(SAMPLE, 1).await);
        assert_advancing(&events.event(SAMPLE, 2).await);
        f.registry.shutdown().await;
    }
}

#[tokio::test]
async fn ineligible_admitted_timeout_drains_and_still_latches() {
    let (f, wire, events, sampler) = rig([Reply::Hang]);
    let generation = connect(&f, A).await;
    sampler.set_eligible(A, true).unwrap();
    let start = wire.started(1).await;
    // Hide/last unwatch/page retirement are identical at the sampler seam.
    sampler.set_eligible(A, false).unwrap();
    sleep(CADENCE + Duration::from_millis(100)).await;
    assert_eq!(wire.count(), 1);
    assert_eq!(wire.closed.closed_channels.load(SeqCst), 0, "visibility must not cancel the exec");
    assert!(events.events.lock().is_empty());
    assert_eq!(events.event(CONTROL, 0).await, json!({
        "terminalId": A,"generation": generation,"pauseSeq": 1,"pausedReason": TIMEOUT
    }));
    assert!(start.elapsed() >= DEADLINE - Duration::from_millis(100));
    assert_eq!(events.events.lock().len(), 1);
    assert_eq!(sampler.fence(A).unwrap().paused_reason, Some(TIMEOUT));
    sampler.set_eligible(A, true).unwrap();
    sleep(CADENCE + Duration::from_millis(100)).await;
    assert_eq!(wire.count(), 1);
    sampler.resume(A).unwrap();
    assert_warming(&events.event(SAMPLE, 0).await);
    assert_advancing(&events.event(SAMPLE, 1).await);
    f.registry.shutdown().await;
}

#[tokio::test]
async fn ineligible_determinate_drain_discards_telemetry_and_restore_rewarms() {
    let release = Arc::new(Notify::new());
    let (f, wire, events, sampler) = rig([Reply::Good, Reply::Gate(release.clone())]);
    connect(&f, A).await;
    sampler.set_eligible(A, true).unwrap();
    assert_warming(&events.event(SAMPLE, 0).await);
    wire.started(2).await;
    let closed = wire.closed.closed_channels.load(SeqCst);
    sampler.set_eligible(A, false).unwrap();
    sleep(CADENCE + Duration::from_millis(100)).await;
    assert_eq!(wire.count(), 2);
    assert_eq!(wire.closed.closed_channels.load(SeqCst), closed, "admitted exec not cancelled");
    release.notify_one();
    timeout(WAIT, async {
        while wire.closed.closed_channels.load(SeqCst) <= closed {
            sleep(Duration::from_millis(2)).await;
        }
    }).await.unwrap();
    sleep(CADENCE + Duration::from_millis(100)).await;
    assert_eq!(wire.count(), 2);
    assert_eq!(events.events.lock().len(), 1, "drained result was not eligible telemetry");
    let restored = Instant::now();
    sampler.set_eligible(A, true).unwrap();
    assert!(wire.started(3).await - restored <= CADENCE + Duration::from_millis(100));
    let fresh = events.event(SAMPLE, 1).await;
    assert_warming(&fresh);
    assert_eq!(fresh["metrics"]["uptime"]["seconds"], json!(14.0));
    assert_advancing(&events.event(SAMPLE, 2).await);
    f.registry.shutdown().await;
}

#[tokio::test]
async fn ordinary_nfs_errors_keep_sampling_and_preserve_other_metrics() {
    let (f, wire, events, sampler) = rig([Reply::Nfs(1), Reply::Nfs(126), Reply::Nfs(127)]);
    connect(&f, A).await;
    sampler.set_eligible(A, true).unwrap();
    for index in 0..3 {
        let value = events.event(SAMPLE, index).await;
        assert_eq!(value["metrics"]["nfs"]["available"], false);
        assert_eq!(value["metrics"]["partitions"]["mounts"][0]["source"], "/dev/test");
        if index > 0 { assert_advancing(&value); }
    }
    let good = events.event(SAMPLE, 3).await;
    assert_eq!(good["metrics"]["nfs"], json!({"available":true,"mounts":[]}));
    assert_advancing(&good);
    assert!(events.events.lock().iter().all(|(name, _)| *name == SAMPLE));
    assert_eq!(wire.count(), 4);
    f.registry.shutdown().await;
}

#[tokio::test]
async fn terminal_retirement_keeps_slot_until_drain_and_removes_stamp_history() {
    let release = Arc::new(Notify::new());
    let (f, wire, events, sampler) = rig([Reply::Gate(release.clone())]);
    connect(&f, A).await;
    let first = sampler.fence(A).unwrap();
    sampler.set_eligible(A, true).unwrap();
    wire.started(1).await;
    sampler.retire(A);
    assert_eq!(sampler.set_eligible(A, true), Err(SessionError::OwnerRetired));
    assert_eq!(sampler.fence(A), Err(SessionError::OwnerRetired));
    assert_eq!(wire.closed.closed_channels.load(SeqCst), 0);
    release.notify_one();
    timeout(WAIT, async {
        while sampler.existing(A).is_some() { sleep(Duration::from_millis(2)).await; }
    }).await.unwrap();
    assert_eq!(wire.count(), 1);
    assert!(events.events.lock().is_empty());
    // 067 remains authoritative and a newly authorized same ID creates a new
    // slot, with no prior generation's reducer/floor/paused state in the slot.
    reconnect(&f).await;
    let next = sampler.fence(A).unwrap();
    assert!(next.generation > first.generation);
    assert_eq!(next.pause_seq, 0);
    sampler.set_eligible(A, true).unwrap();
    assert_warming(&events.event(SAMPLE, 0).await);
    assert_eq!(wire.count(), 2);
    f.registry.shutdown().await;
}
