use super::super::*;
use crate::automation::roster::RosterRow;
use crate::automation_engine::test_host::*;

// =============================================================================================
// §10.14c — a runs-once rule
// =============================================================================================

/// **R6, both halves.** A `runs_once` rule fires exactly once *in this session* — driven below its
/// threshold and back above it with no reload anywhere — and stays completed across one.
///
/// The second rule is the control, and it is what makes the first assertion mean anything: the
/// identical drive makes `au-many` fire twice, so "no second send" cannot pass because the fixture
/// never re-armed anything in the first place.
#[tokio::test(start_paused = true)]
async fn a_runs_once_rule_fires_once_in_the_same_session_and_stays_completed_across_a_reload() {
    let mut once = ctx_rule_saying("au-once", "once only", 1);
    once.runs_once = true;
    let (engine, fake, host) = wire(vec![once, ctx_rule_saying("au-many", "every time", 2)]);
    for id in ["au-once", "au-many"] {
        engine.runtime.set_arm(id, "tm-1", ArmState::armed());
    }

    // The crossing.
    fake.say("pc-1", "ctx:63%\n");
    engine.runtime.mark_dirty("pc-1");
    evaluate_tick(&engine, &host, 0, 1_000).await;
    tokio::time::sleep(Duration::from_millis(2_000)).await;

    assert!(
        !engine.is_live("au-once"),
        "§7.8: completion is an in-memory event FIRST"
    );
    assert_eq!(
        engine.runtime.arm_state("au-once", "tm-1"),
        ArmState::Unseen,
        "and it takes the rule's arm keys with it"
    );
    assert_eq!(
        fake.store
            .list_rules()
            .unwrap()
            .into_iter()
            .find(|r| r.id == "au-once")
            .unwrap()
            .completed_at,
        Some(1_000),
        "the row is written second, with the decision's own stamp"
    );

    // Below the threshold and back above it, with no reload at all — the drive that re-arms a rule
    // and fires it again.
    //
    // **Past the settle window, and that is now further out than it looks.** Two rules crossed on
    // this terminal in one tick, so the second one queued: its write landed a queue wait plus a
    // paste-to-submit gap after the decision, and §2.6 layer 2 runs for `ECHO_SETTLE_MS` from
    // THERE. A tick inside that window evaluates nothing at all, so driving the value down at
    // 3_000 left the control rule never re-armed and the assertion below asserting nothing.
    for (t, screen) in [(6_000i64, "ctx:18%\n"), (8_000, "ctx:63%\n")] {
        fake.say("pc-1", screen);
        engine.runtime.mark_dirty("pc-1");
        evaluate_tick(&engine, &host, 0, t).await;
        tokio::time::sleep(Duration::from_millis(2_000)).await;
    }

    assert_eq!(
        times_sent(&fake, "once only"),
        1,
        "a runs-once rule fired twice in one session"
    );
    assert_eq!(
        times_sent(&fake, "every time"),
        2,
        "the control never re-armed, so the assertion above proves nothing"
    );

    // (b) The next launch: a fresh engine loads the same store and must not run it at all.
    let next = Arc::new(AutomationEngine::new(0));
    next.reload(&fake.store, 6_000).unwrap();
    assert!(
        !next.is_live("au-once"),
        "the reload filter is the second line of defence"
    );
    assert!(
        next.is_live("au-many"),
        "and only the completed rule is filtered"
    );

    next.runtime
        .set_watched("au-once", ["tm-1".to_string()].into());
    next.runtime.set_arm("au-once", "tm-1", ArmState::armed());
    fake.say("pc-1", "ctx:77%\n");
    next.runtime.mark_dirty("pc-1");
    evaluate_tick(&next, &host, 0, 7_000).await;
    tokio::time::sleep(Duration::from_millis(2_000)).await;
    assert_eq!(
        times_sent(&fake, "once only"),
        1,
        "a completed rule ran after a reload"
    );
}

/// **The completion nobody was told about.**
///
/// `mark_completed` writes `completed_at` and `complete_rule` drops the rule from the live set —
/// and for a long time that was the whole of it. No window was told, so every open Settings list
/// went on drawing the row as *Armed · waiting* and *Not fired since it started running*, with a
/// live toggle and no Reset, until the page was remounted. Both strings mean the opposite of what
/// had just happened. Seen in the GUI on the running build, on a rule whose own activity log
/// showed the `sent` row two lines away.
///
/// The test above arranged this exact state and asserted the store row and the live set — the two
/// things the ENGINE owns. Neither can see whether anyone was told, and that is the whole gap: a
/// completion is not finished when the engine knows about it.
///
/// `au-many` is the control, and it is what makes the assertion mean anything. It takes the same
/// crossing and fires from it, so *"the engine announced au-once"* cannot pass by announcing
/// every fire — only by announcing the one that changed what a rule IS.
#[tokio::test(start_paused = true)]
async fn completing_a_runs_once_rule_tells_every_window_to_refetch_it() {
    let mut once = ctx_rule_saying("au-once", "once only", 1);
    once.runs_once = true;
    let (engine, fake, host) = wire(vec![once, ctx_rule_saying("au-many", "every time", 2)]);
    for id in ["au-once", "au-many"] {
        engine.runtime.set_arm(id, "tm-1", ArmState::armed());
    }

    fake.say(
        "pc-1", "ctx:63%
",
    );
    engine.runtime.mark_dirty("pc-1");
    evaluate_tick(&engine, &host, 0, 1_000).await;
    tokio::time::sleep(Duration::from_millis(2_000)).await;

    assert_eq!(
        times_sent(&fake, "once only"),
        1,
        "the runs-once rule never fired"
    );
    assert_eq!(
        times_sent(&fake, "every time"),
        1,
        "the control never fired"
    );
    assert_eq!(
        fake.announced(),
        vec!["au-once".to_string()],
        "a completed rule must tell the windows to refetch it, and a repeatable fire must not"
    );
}

/// **A completion that never reached disk must still retire the rule, and must not be silent.**
///
/// `mark_completed` reports `Ok(false)` when no row matched — the rule was deleted from another
/// window inside this very crossing — which is as un-persisted as `Err`, and the old code read
/// only the `Err` arm, so this case passed for a successful write.
///
/// The review's proposed remedy was to skip `complete_rule` when the write fails, so that memory
/// and disk agree. **That is the one change this test forbids.** Dropping the in-memory
/// retirement re-arms the rule on the next dip and fires it again in this same session, on every
/// crossing — the defect §7.8's ordering exists to prevent. What the failure genuinely costs is
/// the NEXT launch, which no ordering can save, so the honest answer is to say so where a user
/// will see it rather than leave the row describing the rule as armed with nothing anywhere to
/// contradict it.
#[tokio::test(start_paused = true)]
async fn a_completion_that_did_not_reach_disk_still_retires_the_rule_and_says_so() {
    let mut once = ctx_rule_saying("au-once", "once only", 1);
    once.runs_once = true;
    let (engine, fake, host) = wire(vec![once]);
    engine.runtime.set_arm("au-once", "tm-1", ArmState::armed());

    // The row goes away between load and crossing, so the stamp has nothing to write to.
    fake.store.delete_rule("au-once").unwrap();

    fake.say("pc-1", "ctx:63%\n");
    engine.runtime.mark_dirty("pc-1");
    evaluate_tick(&engine, &host, 0, 1_000).await;
    tokio::time::sleep(Duration::from_millis(2_000)).await;

    assert_eq!(
        times_sent(&fake, "once only"),
        1,
        "the rule never fired, so nothing below is proved"
    );
    assert!(
        !engine.is_live("au-once"),
        "a failed stamp took the in-memory retirement with it, so the rule can fire again now"
    );
    assert_eq!(
        fake.announced(),
        vec!["au-once".to_string()],
        "the windows were not told"
    );
    let log = log_details(&fake.store);
    assert!(
        log.iter().any(|(kind, detail)| kind == "Failed"
            && detail.contains("may run again after a restart")),
        "a completion that did not persist left nothing a user could ever see: {:?}",
        log
    );
}

/// **A `tm-` leaf outlives the run it points at, and `process_for_leaf` cannot say so.**
///
/// The leaf is durable across Ctrl+R and `IdentityIndex::index` overwrites its mapping on every
/// spawn, so a send that queued against one run resolves to its REPLACEMENT by the time it
/// reaches the front of the queue. The closed-terminal guard is blind to this: it asks only
/// whether the leaf still resolves, and it does — at a shell that never printed the matched
/// text, which with `submit: true` then runs the message there.
///
/// A table, because the negative alone passes vacuously — "nothing was typed" is equally true of
/// a rule that never fired. And `pc-2` goes into `leaves`, which is what makes it a process the
/// fake will accept a write to: an unregistered id would have been refused by the fake for its
/// own reasons and made this guard look effective while doing nothing.
#[tokio::test(start_paused = true)]
async fn a_terminal_that_restarted_inside_the_queue_wait_is_never_typed_into() {
    for (restarted, want) in [(true, 0usize), (false, 1usize)] {
        let (engine, fake, host) = wire(vec![ctx_rule_saying("au-1", "handing off", 1)]);
        engine.runtime.set_arm("au-1", "tm-1", ArmState::armed());
        fake.say("pc-1", "ctx:63%\n");
        engine.runtime.mark_dirty("pc-1");

        // The crossing is DECIDED here and written during the sleep below — the restart lands in
        // exactly that window.
        evaluate_tick(&engine, &host, 0, 1_000).await;
        if restarted {
            fake.leaves
                .lock()
                .unwrap()
                .insert("tm-1".into(), "pc-2".into());
        }
        tokio::time::sleep(Duration::from_millis(2_000)).await;

        assert_eq!(
            times_sent(&fake, "handing off"),
            want,
            "restarted={}: a message decided from one run reached a different one",
            restarted
        );
    }
}

// =============================================================================================
// §10.18d (local half) — the missing map reaches first paint
// =============================================================================================

/// **The targeting tick is the only thing that can compute `missing`, and neither consumer has a
/// roster.** So it parks its answer where they can read it — and the defect this pins is the
/// obvious alternative: `emit_state` and `get_automation_runtime` each passing an empty map,
/// which flickers every *not open* pill off the moment any rule fires and again on every repaint.
#[tokio::test(start_paused = true)]
async fn the_targeting_tick_parks_its_missing_map_where_first_paint_reads_it() {
    let mut pinned = ctx_rule("au-1");
    pinned.target_mode = TargetMode::Pinned;
    pinned.target_ids = vec!["tm-gone".into()];
    let (engine, _fake, host) = wire(vec![pinned]);

    // Before any tick, and inside the grace window, nothing is reported missing — §4.5: at t=0 the
    // live set is empty and session restore has not run.
    assert!(
        !is_missing(&engine, "au-1", "tm-gone"),
        "reported before the grace elapsed"
    );
    targeting_tick(&engine, &host, 1_000);
    assert!(
        !is_missing(&engine, "au-1", "tm-gone"),
        "the grace window did not hold"
    );

    // Past the grace, the pinned id is not in the roster and is reported — through the payload
    // first paint actually calls, not through the tick's return value.
    targeting_tick(&engine, &host, 120_000);
    assert!(
        is_missing(&engine, "au-1", "tm-gone"),
        "first paint cannot see what the tick found"
    );

    // And it is retracted the moment the terminal comes back, rather than latching.
    _fake
        .leaves
        .lock()
        .unwrap()
        .insert("tm-gone".into(), "pc-9".into());
    _fake.roster.lock().unwrap().push(RosterRow {
        terminal_id: Some("tm-gone".into()),
        process_id: "pc-9".into(),
        name: "Terminal-powershell".into(),
        shell: "powershell".into(),
        pid: 101,
        display_label: None,
        cwd: None,
        command_lines: Vec::new(),
    });
    targeting_tick(&engine, &host, 130_000);
    assert!(
        !is_missing(&engine, "au-1", "tm-gone"),
        "dormant, never dead — it came back"
    );
}

fn is_missing(engine: &Arc<AutomationEngine>, rule_id: &str, tm: &str) -> bool {
    engine
        .runtime_payload()
        .rules
        .get(rule_id)
        .and_then(|pairs| pairs.get(tm))
        .is_some_and(|p| p.missing)
}

// =============================================================================================
// §10.9b — the half `reload`'s own test cannot make: no SECOND message
// =============================================================================================

/// **Disabling one rule must not make another one send again.**
///
/// `automation_engine.rs` asserts that rule B's arm keys survive rule A's toggle. That is the
/// mechanism; this is the requirement. The easy `reload` — build a fresh map, drop the old keys —
/// makes every B pair `Unseen`, and settled decision 7 then counts an already-true condition as a
/// first sight: B goes silent until its next genuine crossing, with no log line and nothing on
/// screen. The visible half of that bug is the opposite one, and it is this test: a pair put back
/// to `Armed` types a second message into the user's terminal on the very next tick.
#[tokio::test(start_paused = true)]
async fn disabling_one_rule_does_not_make_another_one_send_again() {
    let (engine, fake, host) = wire(vec![
        ctx_rule_saying("au-a", "alpha speaking", 1),
        ctx_rule_saying("au-b", "bravo speaking", 2),
    ]);
    for id in ["au-a", "au-b"] {
        engine.runtime.set_arm(id, "tm-1", ArmState::armed());
    }
    fake.say("pc-1", "ctx:63%\n");
    engine.runtime.mark_dirty("pc-1");

    evaluate_tick(&engine, &host, 0, 1_000).await;
    tokio::time::sleep(Duration::from_millis(2_000)).await;
    assert_eq!(
        times_sent(&fake, "bravo speaking"),
        1,
        "the premise: B has fired once"
    );

    // The user flips A off. Nothing about B changed.
    let mut off = ctx_rule_saying("au-a", "alpha speaking", 1);
    off.enabled = false;
    off.updated_at = 2_000;
    fake.store.save_rule(&off).unwrap();
    engine.reload(&fake.store, 2_000).unwrap();

    // The value is still above the threshold, and B is still watching.
    engine.runtime.mark_dirty("pc-1");
    evaluate_tick(&engine, &host, 0, 5_000).await;
    tokio::time::sleep(Duration::from_millis(2_000)).await;

    assert_eq!(
        times_sent(&fake, "bravo speaking"),
        1,
        "B sent a second message because the reload re-armed it: {:?}",
        fake.written()
    );
    assert_eq!(
        engine.runtime.arm_state("au-b", "tm-1"),
        ArmState::Fired { at_ms: 1_000 },
        "and it is still Fired, at the instant it FIRST became true"
    );
    assert!(
        log_kinds(&fake.store).contains(&"Held".to_string()),
        "the decision must be `held`, and be visible as one: {:?}",
        log_kinds(&fake.store)
    );
    assert!(
        !engine.is_live("au-a"),
        "the premise: A really did leave the live set"
    );
}

