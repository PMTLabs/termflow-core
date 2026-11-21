use super::*;

fn stash(from: &mut Page, rig: &Rig, pane: &Value, tx: &str) {
    assert_eq!(from.op(rig, json!({"kind":"stash","tx":tx,"pairs":[pane]})), PaneResult::Ok);
}
fn take(into: &mut Page, rig: &Rig, tx: &str) {
    assert!(matches!(into.op(rig, json!({"kind":"take","tx":tx})), PaneResult::Taken { .. }));
}
fn adopt(into: &mut Page, rig: &Rig, tx: &str, leaf: &str) -> Value {
    let entry = into.entry(leaf);
    assert_eq!(into.op(rig, json!({"kind":"adopt","tx":tx,"pairs":[entry]})), PaneResult::Ok);
    entry
}

#[tokio::test]
async fn reconnect_and_transfer_preserve_exact_session_map() {
    let rig = Rig::new();
    let mut left = Page::new(&rig, "left");
    let mut right = Page::new(&rig, "right");
    let (pane, ga) = rig.connected(&mut left, A).await;
    let (_, gb) = rig.connected(&mut right, B).await;
    let (x, y, moved) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    let release = Arc::new(Notify::new());
    *rig.wire[A].mode.lock() = Some(Reply::Gate(release.clone()));
    let old_floor = rig.watch(&left, A, x);
    rig.watch(&right, B, y);
    until(|| rig.starts(A) == 1).await;
    rig.sample(B, 1).await;
    sessions(&rig, &[A, B]);
    assert_eq!(snapshot(&rig), HashMap::from([
        expected(A, ga, true, &[(&left, x)], true), expected(B, gb, true, &[(&right, y)], false),
    ]));
    stash(&mut left, &rig, &pane, "handover");
    assert_eq!(snapshot(&rig)[A], expected(A, ga, true, &[(&left, x)], true).1);
    take(&mut right, &rig, "handover");
    assert_eq!(snapshot(&rig)[A], expected(A, ga, false, &[], true).1);
    assert_eq!(rig.registry.watch(left.label, left.pg, A, x), Err(SessionError::OwnerRetired));
    assert_eq!(rig.registry.watch(right.label, right.pg, A, moved), Err(SessionError::OwnerRetired));
    adopt(&mut right, &rig, "handover", A);
    sessions(&rig, &[A, B]);
    let fence = rig.watch(&right, A, moved);
    assert_eq!(fence.generation, ga);
    assert!(fence.sample_floor > old_floor.sample_floor);
    assert!(rig.events.samples(A).is_empty());
    assert_eq!(rig.starts(A), 1);
    release.notify_one();
    let sample = rig.sample(A, 1).await;
    assert_eq!(rig.starts(A), 2, "old placement's admitted result was discarded");
    assert!(sample["sampledAt"].as_u64().unwrap() > fence.sample_floor);
    assert_eq!(snapshot(&rig)[A], expected(A, ga, true, &[(&right, moved)], false).1);
    let next = reconnect_core(&rig.keys, &rig.f.registry, A).unwrap();
    assert!(next.generation > ga);
    rig.authenticate(A, next.generation).await;
    let after = rig.watch(&right, A, moved);
    assert_eq!(after.generation, next.generation);
    assert!(after.sample_floor > sample["sampledAt"].as_u64().unwrap());
    until(|| rig.events.samples(A).iter().any(|sample| sample["sampledAt"].as_u64().unwrap() > after.sample_floor)).await;
    sessions(&rig, &[A, B]);
    let current = snapshot(&rig);
    assert_eq!(current[A], expected(A, next.generation, true, &[(&right, moved)], false).1);
    assert_eq!(current[B].0, Some(gb));
    let (_, (_, _, b_consumers, _)) = expected(B, gb, true, &[(&right, y)], false);
    assert_eq!(current[B].2, b_consumers);
    rig.f.registry.shutdown().await;
}

#[tokio::test]
async fn exact_metrics_registry_matches_authority() {
    let rig = Rig::new();
    let mut left = Page::new(&rig, "left");
    let mut right = Page::new(&rig, "right");
    let (pane_a, ga) = rig.connected(&mut left, A).await;
    let (_, gb) = rig.connected(&mut left, B).await;
    let (pane_c, gc) = rig.connected(&mut right, C).await;
    let (a, canvas, b, c, moved, reload_b) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    rig.watch(&left, A, a);
    rig.watch(&left, A, canvas);
    rig.watch(&left, B, b);
    rig.watch(&right, C, c);
    for leaf in [A, B, C] { rig.sample(leaf, 1).await; }
    // Independent expectations follow each operation, not registry counts.
    assert_eq!(snapshot(&rig), HashMap::from([
        expected(A, ga, true, &[(&left, a), (&left, canvas)], false),
        expected(B, gb, true, &[(&left, b)], false), expected(C, gc, true, &[(&right, c)], false),
    ]));
    sessions(&rig, &[A, B, C]);
    rig.unwatch(&left, A, a);
    assert_eq!(snapshot(&rig)[A], expected(A, ga, true, &[(&left, canvas)], false).1);
    rig.windows.set(right.label, Some(false), Some(false), false);
    rig.registry.refresh(C).await;
    assert_eq!(snapshot(&rig)[C], expected(C, gc, false, &[(&right, c)], false).1);
    stash(&mut left, &rig, &pane_a, "move-a");
    assert_eq!(snapshot(&rig)[A], expected(A, ga, true, &[(&left, canvas)], false).1);
    take(&mut right, &rig, "move-a");
    assert_eq!(snapshot(&rig), HashMap::from([
        expected(A, ga, false, &[], false), expected(B, gb, true, &[(&left, b)], false),
        expected(C, gc, false, &[(&right, c)], false),
    ]));
    let moved_pane = adopt(&mut right, &rig, "move-a", A);
    rig.watch(&right, A, moved);
    assert_eq!(snapshot(&rig)[A], expected(A, ga, false, &[(&right, moved)], false).1);
    sessions(&rig, &[A, B, C]);
    let mut reload = Page::register(&rig, left.label);
    assert_eq!(reload.op(&rig, json!({"kind":"replace_page"})), PaneResult::Ok);
    assert_eq!(snapshot(&rig)[B], expected(B, gb, false, &[], false).1);
    let pane_b = reload.install_restored(&rig, B);
    assert_eq!(reload.op(&rig, json!({"kind":"settle"})), PaneResult::Ok);
    rig.watch(&reload, B, reload_b);
    rig.sample(B, 2).await;
    assert_eq!(snapshot(&rig), HashMap::from([
        expected(A, ga, false, &[(&right, moved)], false), expected(B, gb, true, &[(&reload, reload_b)], false),
        expected(C, gc, false, &[(&right, c)], false),
    ]));
    // Single-pane close, then the remaining window's two-pane tab close.
    assert_eq!(reload.op(&rig, json!({"kind":"close","pi":pane_b["pi"]})), PaneResult::Ok);
    sessions(&rig, &[A, C]);
    assert_eq!(snapshot(&rig), HashMap::from([
        expected(A, ga, false, &[(&right, moved)], false), expected(C, gc, false, &[(&right, c)], false),
    ]));
    assert_eq!(right.op(&rig, json!({"kind":"close","pi":moved_pane["pi"]})), PaneResult::Ok);
    assert_eq!(snapshot(&rig), HashMap::from([expected(C, gc, false, &[(&right, c)], false)]));
    assert_eq!(right.op(&rig, json!({"kind":"close","pi":pane_c["pi"]})), PaneResult::Ok);
    sessions(&rig, &[]);
    assert!(snapshot(&rig).is_empty());
    for leaf in [A, B, C] { until(|| rig.registry.sampler.status(leaf).is_none()).await; }
    sleep(QUIET).await;
    assert_eq!((rig.starts(A), rig.starts(B), rig.starts(C)), (1, 2, 1));
    assert_eq!((rig.events.samples(A).len(), rig.events.samples(B).len(), rig.events.samples(C).len()), (1, 2, 1));
    rig.f.registry.shutdown().await;
}

#[tokio::test]
async fn hide_unwatch_and_page_retirement_drain_before_discarding_telemetry() {
    for action in ["hide", "unwatch", "replace"] {
        let rig = Rig::new();
        let mut page = Page::new(&rig, "window");
        let (_, generation) = rig.connected(&mut page, A).await;
        let id = Uuid::new_v4();
        let release = Arc::new(Notify::new());
        *rig.wire[A].mode.lock() = Some(Reply::Gate(release.clone()));
        let floor = rig.watch(&page, A, id).sample_floor;
        until(|| rig.starts(A) == 1).await;
        let mut replacement = None;
        match action {
            "hide" => rig.windows.set(page.label, Some(false), Some(false), false),
            "unwatch" => rig.unwatch(&page, A, id),
            "replace" => {
                let mut next = Page::register(&rig, page.label);
                assert_eq!(next.op(&rig, json!({"kind":"replace_page"})), PaneResult::Ok);
                replacement = Some(next);
            }
            _ => unreachable!(),
        }
        sleep(QUIET).await;
        assert_eq!(rig.starts(A), 1, "{action}");
        assert_eq!(rig.closed(A), 0, "{action}: exec cancellation is not an eligibility effect");
        assert!(snapshot(&rig)[A].3, "{action}: local reader is still admitted");
        release.notify_one();
        // Peer-initiated CLOSE does not call the peer's client-close handler.
        until(|| !snapshot(&rig)[A].3).await;
        sleep(QUIET).await;
        assert_eq!(rig.starts(A), 1, "{action}");
        assert!(rig.events.samples(A).is_empty(), "{action}: ineligible result must not emit");
        assert!(rig.events.values("ssh-metrics:control", A).is_empty());
        let current = if let Some(ref mut next) = replacement {
            next.install_restored(&rig, A);
            assert_eq!(next.op(&rig, json!({"kind":"settle"})), PaneResult::Ok);
            next
        } else { &mut page };
        rig.windows.set(current.label, Some(true), Some(false), false);
        let fence = rig.watch(current, A, Uuid::new_v4());
        assert_eq!(fence.generation, generation);
        assert!(fence.sample_floor > floor);
        assert!(rig.sample(A, 1).await["sampledAt"].as_u64().unwrap() > fence.sample_floor);
        assert_eq!(rig.starts(A), 2, "{action}");
        rig.f.registry.shutdown().await;
    }
}

#[tokio::test]
async fn hide_unwatch_and_page_retirement_during_timeout_keep_ordered_pause() {
    for action in ["hide", "unwatch", "replace"] {
        let rig = Rig::new();
        let mut page = Page::new(&rig, "window");
        let (_, generation) = rig.connected(&mut page, A).await;
        let old_id = Uuid::new_v4();
        *rig.wire[A].mode.lock() = Some(Reply::Hang);
        rig.watch(&page, A, old_id);
        until(|| rig.starts(A) == 1).await;
        let start = tokio::time::Instant::now();
        match action {
            "hide" => rig.windows.set(page.label, Some(false), Some(false), false),
            "unwatch" => rig.unwatch(&page, A, old_id),
            "replace" => {
                let mut next = Page::register(&rig, page.label);
                assert_eq!(next.op(&rig, json!({"kind":"replace_page"})), PaneResult::Ok);
                next.install_restored(&rig, A);
                assert_eq!(next.op(&rig, json!({"kind":"settle"})), PaneResult::Ok);
                page = next;
            }
            _ => unreachable!(),
        }
        sleep(QUIET).await;
        assert_eq!(rig.closed(A), 0, "{action}");
        assert!(snapshot(&rig)[A].3, "{action}: exec still draining");
        if action != "hide" { assert_eq!(snapshot(&rig)[A], expected(A, generation, false, &[], true).1); }
        until(|| rig.events.values("ssh-metrics:control", A).len() == 1).await;
        assert!(start.elapsed() >= Duration::from_millis(4800), "{action}: original deadline retained");
        assert_eq!(rig.events.values("ssh-metrics:control", A), vec![json!({
            "terminalId": A,"generation":generation,"pauseSeq":1,"pausedReason":"Metrics paused: host didn't answer in 5 s"
        })]);
        assert!(rig.events.samples(A).is_empty());
        rig.windows.set(page.label, Some(true), Some(false), false);
        let id = Uuid::new_v4();
        let receipt = rig.watch(&page, A, id);
        assert_eq!((receipt.pause_seq, receipt.paused_reason), (1, Some("Metrics paused: host didn't answer in 5 s")));
        sleep(QUIET).await;
        assert_eq!(rig.starts(A), 1, "{action}: turn-over/fence did not clear pause");
        let resumed = rig.registry.resume(page.label, page.pg, A, id).unwrap();
        assert_eq!(resumed.pause_seq, 2);
        assert!(rig.sample(A, 1).await["sampledAt"].as_u64().unwrap() > resumed.sample_floor);
        rig.f.registry.shutdown().await;
    }
}

#[tokio::test]
async fn retired_native_incarnation_cannot_reclaim_moved_terminal() {
    let rig = Rig::new();
    let mut old = Page::new(&rig, "reused-label");
    let mut target = Page::new(&rig, "target");
    let (pane, ga) = rig.connected(&mut old, A).await;
    let (source, moved, restarted) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    rig.watch(&old, A, source);
    rig.sample(A, 1).await;
    stash(&mut old, &rig, &pane, "moving");
    take(&mut target, &rig, "moving");
    adopt(&mut target, &rig, "moving", A);
    rig.watch(&target, A, moved);
    old.destroy(&rig); // crash with no unwatch or page settle
    let mut replacement = Page::new(&rig, old.label);
    let (_, gb) = rig.connected(&mut replacement, B).await;
    assert_ne!(old.wi, replacement.wi);
    rig.watch(&replacement, B, restarted);
    old.destroy(&rig); // delayed event must not affect the recycled label
    assert_eq!(rig.registry.watch(old.label, old.pg, A, source), Err(SessionError::OwnerRetired));
    assert_eq!(rig.registry.watch(replacement.label, replacement.pg, A, Uuid::new_v4()), Err(SessionError::OwnerRetired));
    rig.sample(A, 2).await;
    rig.sample(B, 1).await;
    sessions(&rig, &[A, B]);
    assert_eq!(snapshot(&rig), HashMap::from([
        expected(A, ga, true, &[(&target, moved)], false),
        expected(B, gb, true, &[(&replacement, restarted)], false),
    ]));
    rig.f.registry.shutdown().await;
}

#[tokio::test]
async fn sync_watch_starts_worker_from_std_thread_without_runtime() {
    let rig = Rig::new();
    let mut page = Page::new(&rig, "sync-window");
    rig.connected(&mut page, A).await;
    let registry = rig.registry.clone();
    let receipt = std::thread::spawn(move || {
        assert!(tokio::runtime::Handle::try_current().is_err());
        registry.watch(page.label, page.pg, A, Uuid::new_v4()).unwrap()
    }).join().unwrap();
    assert!(rig.sample(A, 1).await["sampledAt"].as_u64().unwrap() > receipt.sample_floor);
    assert_eq!(rig.starts(A), 1);
    rig.f.registry.shutdown().await;
}
