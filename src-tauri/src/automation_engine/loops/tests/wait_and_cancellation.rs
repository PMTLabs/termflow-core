use super::super::*;
use super::open_second_terminal;
use crate::automation_engine::test_host::*;
use crate::automation_store::Finds;

// =============================================================================================
// §6.1, §6.2 — the Wait step, on the tick that already runs
// =============================================================================================

/// *Detect `API error` → wait 30 s → send `resume`.* The crossing types NOTHING; the send is
/// parked and drained by a later pass of the same 250 ms tick.
///
/// Pre-armed, so the single crossing is the first `evaluate_tick` below rather than a first
/// sight — `Unseen` + true arms and never sends (settled decision 7), and the shape matches
/// `a_crossing_types_the_resolved_message`.
///
/// The two later ticks are deliberately NOT dirty and NOT due: the pair's dirty flag was spent
/// by the crossing, so `due_now` is false for both. A drain placed behind the cadence gate
/// would never run at all on the terminal this feature is for — one that goes quiet after the
/// error it printed.
#[tokio::test(start_paused = true)]
async fn a_delay_holds_the_send_then_fires_it() {
    let (engine, fake, host) = rig_with_rule(|g| {
        g.parse_mut().find = "API error".into();
        g.cond_mut().finds = Finds::Event;
        g.action_mut().message = "resume".into();
        g.timer = Some(TimerStep {
            mode: TimerMode::AfterMatch { delay_ms: 30_000 },
        });
    });
    engine.runtime.set_arm("au-1", "tm-1", ArmState::armed());
    engine.runtime.mark_dirty("pc-1");
    fake.say("pc-1", "API error");

    evaluate_tick(&engine, &host, 0, 1_000).await;
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    assert!(
        fake.written().is_empty(),
        "nothing may be typed at the crossing: {:?}",
        fake.written()
    );

    evaluate_tick(&engine, &host, 0, 20_000).await;
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    assert!(
        fake.written().is_empty(),
        "still holding at 19s: {:?}",
        fake.written()
    );

    evaluate_tick(&engine, &host, 0, 31_001).await;
    tokio::time::sleep(Duration::from_millis(2_000)).await;
    assert!(
        fake.written().iter().any(|w| w.contains("resume")),
        "the parked message never fired: {:?}",
        fake.written()
    );
}

/// **The crossing is SPENT at decide time, and the park does not give it back.**
///
/// `set_arm` writes `Fired` before the park, which is the whole of "no double-park" (§6.2). The
/// tempting wrong move is to roll the arm back to `prev` on the grounds that nothing was sent
/// yet — and then the pair crosses again on the very next tick, parks a *new* send, and the
/// deadline runs away from the message for as long as the condition stays true.
///
/// The oracle is the DEADLINE, not the send count: a re-park keeps the count at one and only
/// moves `due_at_ms`, so a test that only counted messages would pass a rule that never fires.
#[tokio::test(start_paused = true)]
async fn a_parked_send_is_not_re_parked_by_the_crossing_it_already_spent() {
    let (engine, fake, host) = rig_with_rule(|g| {
        g.parse_mut().find = "API error".into();
        g.cond_mut().finds = Finds::Event;
        g.action_mut().message = "resume".into();
        g.timer = Some(TimerStep {
            mode: TimerMode::AfterMatch { delay_ms: 30_000 },
        });
    });
    engine.runtime.set_arm("au-1", "tm-1", ArmState::armed());
    engine.runtime.mark_dirty("pc-1");
    fake.say("pc-1", "API error");

    evaluate_tick(&engine, &host, 0, 1_000).await;
    assert_eq!(
        engine.runtime.parked_at("au-1", "tm-1"),
        Some(31_000),
        "the crossing must park its send"
    );
    assert_eq!(
        engine.runtime.arm_state("au-1", "tm-1"),
        ArmState::Fired { at_ms: 1_000 },
        "the crossing has happened even though nothing was sent"
    );

    // The error is still on screen and the terminal keeps printing, so the pair is due over and
    // over for the whole of the wait.
    for t in [1_500i64, 2_000, 5_000, 20_000] {
        engine.runtime.mark_dirty("pc-1");
        evaluate_tick(&engine, &host, 0, t).await;
        tokio::time::sleep(Duration::from_millis(1_500)).await;
        assert_eq!(
            engine.runtime.parked_at("au-1", "tm-1"),
            Some(31_000),
            "the deadline moved at {t}: the pair crossed a second time while its send waited"
        );
        assert!(
            fake.written().is_empty(),
            "nothing may be typed before the deadline: {:?}",
            fake.written()
        );
    }

    // `due_at_ms` is the moment it may go, not the moment after.
    evaluate_tick(&engine, &host, 0, 31_000).await;
    tokio::time::sleep(Duration::from_millis(2_000)).await;
    assert_eq!(
        times_sent(&fake, "resume"),
        1,
        "exactly one message: {:?}",
        fake.written()
    );
    assert_eq!(
        engine.runtime.parked_at("au-1", "tm-1"),
        None,
        "a drained send must leave no entry behind"
    );
}

// =============================================================================================
// I3 — a suspend leaves stale parked delays to fire hours late
// =============================================================================================

/// **Oracle (a).** A parked send whose `due_at_ms` is already more than `MAX_DELAY_MS` in the
/// past when the resume branch runs must be dropped, not merely left to fire on the very next
/// tick into whatever is now in that terminal.
#[tokio::test(start_paused = true)]
async fn a_resume_drops_a_parked_send_stale_beyond_max_delay_ms() {
    let (engine, fake, host) = rig_with_rule(|g| {
        g.parse_mut().find = "API error".into();
        g.cond_mut().finds = Finds::Event;
        g.action_mut().message = "resume".into();
        g.timer = Some(TimerStep {
            mode: TimerMode::AfterMatch { delay_ms: 30_000 },
        });
    });
    engine.runtime.set_arm("au-1", "tm-1", ArmState::armed());
    engine.runtime.mark_dirty("pc-1");
    fake.say("pc-1", "API error");

    // The crossing, at the ordinary per-tick entry point, parks a send due at 31_000.
    evaluator_step(&engine, &host, 0, None, 1_000).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(
        engine.runtime.parked_at("au-1", "tm-1"),
        Some(31_000),
        "premise: the crossing must park its send"
    );

    // A suspend that outlasts `MAX_DELAY_MS` past the send's own due time.
    let woke_at = 31_000 + crate::automation_validation::MAX_DELAY_MS + 1;
    evaluator_step(&engine, &host, 0, Some(1_000), woke_at).await;
    tokio::time::sleep(Duration::from_millis(1_500)).await;

    assert!(
        engine.runtime.parked_at("au-1", "tm-1").is_none(),
        "a stale parked send must be dropped on resume, not merely left to fire"
    );
    assert!(
        fake.written().is_empty(),
        "a stale parked send fired into whatever is now in the terminal: {:?}",
        fake.written()
    );
}

/// **A resume that drops a parked send must tell the windows — and one that drops nothing
/// must not.**
///
/// `pairState` answers `'pending'` for any non-null `parkedAt`, with no expiry check, and the
/// renderer's countdown stops re-arming once the deadline passes. So the drop above left the row
/// reading *"Waiting to send · in 0s"* for a send that will never go out, until some unrelated
/// arm transition happened to repaint it. The seeding right beside it does emit; this did not.
///
/// **Both directions, because "mark dirty on every resume" passes the first half.** A wake that
/// dropped nothing has nothing to announce, and an unconditional mark would repaint every open
/// Settings page on every lid-open for the life of the app — the cost the targeting tick's own
/// diff exists to avoid.
#[tokio::test(start_paused = true)]
async fn a_resume_that_drops_a_parked_send_announces_it_and_one_that_drops_nothing_does_not() {
    let (engine, fake, host) = rig_with_rule(|g| {
        g.parse_mut().find = "API error".into();
        g.cond_mut().finds = Finds::Event;
        g.action_mut().message = "resume".into();
        g.timer = Some(TimerStep {
            mode: TimerMode::AfterMatch { delay_ms: 300_000 },
        });
    });
    engine.runtime.set_arm("au-1", "tm-1", ArmState::armed());
    engine.runtime.mark_dirty("pc-1");
    fake.say("pc-1", "API error");

    // The crossing parks a send due at 301_000 (five minutes out).
    evaluator_step(&engine, &host, 0, None, 1_000).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(
        engine.runtime.parked_at("au-1", "tm-1"),
        Some(301_000),
        "premise: it is parked"
    );

    // A resume that drops nothing: over `RESUME_GAP_MS`, and the send is not yet even due.
    let quiet = fake.states.load(std::sync::atomic::Ordering::Relaxed);
    evaluator_step(&engine, &host, 0, Some(1_000), 120_000).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(
        fake.states.load(std::sync::atomic::Ordering::Relaxed),
        quiet,
        "a wake that dropped nothing repainted every open Settings page anyway"
    );

    // A resume that DOES drop it. The rate limit is long since spent at this distance, so a
    // state event here is this drop's own and not a coalesced earlier one.
    let woke_at = 301_000 + crate::automation_validation::MAX_DELAY_MS + 1;
    evaluator_step(&engine, &host, 0, Some(120_000), woke_at).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(
        engine.runtime.parked_at("au-1", "tm-1").is_none(),
        "premise: the send was stale enough to drop"
    );
    assert!(
        fake.states.load(std::sync::atomic::Ordering::Relaxed) > quiet,
        "the send was dropped and the row was left counting down to a message that never comes"
    );
}

/// **Oracle (b), in the opposite direction.** This fix can eat the feature it protects: a
/// parked send that is NOT yet stale must survive a resume unharmed, and an ordinary tick after
/// that resume must still deliver it once it is actually due.
///
/// The window is deliberately still inside `MAX_DELAY_MS` at the moment of resume — proving the
/// staleness bound is genuinely conditional on age, not merely on "was this a resume". Mutating
/// the bound to unconditional (drop on any resume, regardless of age) kills this test: the
/// still-waiting send would vanish at the `assert_eq!` right after the resume, before the
/// ordinary tick ever gets a chance to deliver it.
#[tokio::test(start_paused = true)]
async fn an_ordinary_tick_still_delivers_a_send_that_survived_a_resume() {
    let (engine, fake, host) = rig_with_rule(|g| {
        g.parse_mut().find = "API error".into();
        g.cond_mut().finds = Finds::Event;
        g.action_mut().message = "resume".into();
        g.timer = Some(TimerStep {
            mode: TimerMode::AfterMatch { delay_ms: 300_000 },
        });
    });
    engine.runtime.set_arm("au-1", "tm-1", ArmState::armed());
    engine.runtime.mark_dirty("pc-1");
    fake.say("pc-1", "API error");

    // The crossing parks a send due at 301_000 (five minutes out).
    evaluator_step(&engine, &host, 0, None, 1_000).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(engine.runtime.parked_at("au-1", "tm-1"), Some(301_000));

    // A brief suspend at the two-minute mark: long enough to be a resume (> RESUME_GAP_MS),
    // and nowhere near `MAX_DELAY_MS` past the send's due time — indeed still before it.
    evaluator_step(&engine, &host, 0, Some(1_000), 120_000).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(
        engine.runtime.parked_at("au-1", "tm-1"),
        Some(301_000),
        "a resume dropped a send that was not yet stale"
    );
    assert!(
        fake.written().is_empty(),
        "the send is not due yet: {:?}",
        fake.written()
    );

    // An ordinary tick, once the wait is genuinely over, must still deliver it.
    evaluator_step(&engine, &host, 0, Some(120_000), 301_001).await;
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    assert!(
        fake.written().iter().any(|w| w.contains("resume")),
        "an ordinary tick failed to deliver a send that survived an earlier resume: {:?}",
        fake.written()
    );
}

/// **`prev` rides along for thirty seconds so a failure can still roll back to it.**
///
/// `fail` restores the arm state to *exactly* where the crossing found it. For a parked send the
/// crossing was 30 s ago, so the only record of that state is the one `ParkedSend` carries — and
/// the two plausible substitutes are both wrong in a way that costs sends: `Unseen` + true only
/// ARMS (settled decision 7), so this pair would need two more crossings, and `Fired` would
/// leave it stuck holding forever.
#[tokio::test(start_paused = true)]
async fn a_parked_send_that_fails_rolls_the_arm_back_to_the_crossing_it_came_from() {
    let (engine, fake, host) = rig_with_rule(|g| {
        g.parse_mut().find = "API error".into();
        g.cond_mut().finds = Finds::Event;
        g.action_mut().message = "resume".into();
        g.timer = Some(TimerStep {
            mode: TimerMode::AfterMatch { delay_ms: 30_000 },
        });
    });
    engine.runtime.set_arm("au-1", "tm-1", ArmState::armed());
    engine.runtime.mark_dirty("pc-1");
    fake.say("pc-1", "API error");
    evaluate_tick(&engine, &host, 0, 1_000).await;
    assert_eq!(
        engine.runtime.parked_at("au-1", "tm-1"),
        Some(31_000),
        "the premise: it parked"
    );

    *fake.write_err.lock().unwrap() = Some("no writer".into());
    evaluate_tick(&engine, &host, 0, 31_000).await;
    tokio::time::sleep(Duration::from_millis(2_000)).await;

    let rows = log_rows(&fake.store);
    assert!(
        rows.iter().any(|(k, _, _)| k == "Failed"),
        "the premise: the write was refused — {rows:?}"
    );
    assert_eq!(
        engine.runtime.arm_state("au-1", "tm-1"),
        ArmState::armed(),
        "a failed parked send must roll back to the state the CROSSING found"
    );

    // And it is a real rollback: the next crossing parks again.
    *fake.write_err.lock().unwrap() = None;
    engine.runtime.mark_dirty("pc-1");
    evaluate_tick(&engine, &host, 0, 32_000).await;
    assert_eq!(
        engine.runtime.parked_at("au-1", "tm-1"),
        Some(62_000),
        "the pair could not cross again after its send failed"
    );
}

/// **The captures are the crossing's, not the screen's.**
///
/// Thirty seconds is a long time in a terminal. By the time the message goes out the matched
/// line has scrolled away entirely, so a send that resolved `$1` by re-reading would find
/// nothing at all — and §4.4 makes that a refusal, not a guess. `ParkedSend` carries them for
/// exactly this reason.
#[tokio::test(start_paused = true)]
async fn a_parked_send_resolves_its_tokens_against_the_crossing_not_the_later_screen() {
    let (engine, fake, host) = rig_with_rule(|g| {
        g.parse_mut().find = r"API error (\d+)".into();
        g.cond_mut().finds = Finds::Event;
        g.action_mut().message = "resume after $1".into();
        g.action_mut().substitute = true;
        g.timer = Some(TimerStep {
            mode: TimerMode::AfterMatch { delay_ms: 30_000 },
        });
    });
    engine.runtime.set_arm("au-1", "tm-1", ArmState::armed());
    engine.runtime.mark_dirty("pc-1");
    fake.say("pc-1", "API error 529");
    evaluate_tick(&engine, &host, 0, 1_000).await;
    assert!(
        fake.written().is_empty(),
        "the premise: the crossing parked rather than sending"
    );

    // Half a minute of build output later, nothing of the match is left anywhere.
    fake.say("pc-1", "all clear\n");
    evaluate_tick(&engine, &host, 0, 31_000).await;
    tokio::time::sleep(Duration::from_millis(2_000)).await;

    assert!(
        fake.written().iter().any(|w| w.contains("resume after 529")),
        "the token was resolved against the screen it fired into, not the match that fired it: \
         {:?} / {:?}",
        fake.written(),
        log_details(&fake.store)
    );
}

/// **The restart guard has to cover the WAIT, not just the queue.**
///
/// `run_send` compares `host.process_for_leaf(&tm)` at lock time against `send.pair.pc`. For a
/// parked send that field was filled at the DRAIN, from the same lookup — a value compared with
/// itself, so the guard covered the few milliseconds of queue wait and none of the 30 s to
/// 10 min park this milestone introduced.
///
/// `forget_terminal` is not the answer: it covers Ctrl+R, where the shell has exited and
/// `cleanup_terminal_state` purges, but `IdentityIndex::index` overwrites `leaf_to_process`
/// unconditionally on every spawn and purges nothing — so a leaf re-pointed at a live
/// replacement leaves the parked send in place, addressed at a run that never printed the
/// matched text. With `submit: true` the message is also RUN there.
///
/// A table, because the negative alone passes vacuously: "nothing was typed" is equally true of
/// a rule that never fired. The `Failed` row is asserted as well as the absent write, so a
/// send silently dropped for some other reason cannot pass as this guard working.
#[tokio::test(start_paused = true)]
async fn a_parked_send_whose_leaf_was_re_indexed_during_the_wait_is_never_typed_into() {
    for (restarted, want) in [(true, 0usize), (false, 1usize)] {
        let (engine, fake, host) = rig_with_rule(|g| {
            g.parse_mut().find = "API error".into();
            g.cond_mut().finds = Finds::Event;
            g.action_mut().message = "resume".into();
            g.timer = Some(TimerStep {
                mode: TimerMode::AfterMatch { delay_ms: 30_000 },
            });
        });
        engine.runtime.set_arm("au-1", "tm-1", ArmState::armed());
        engine.runtime.mark_dirty("pc-1");
        fake.say("pc-1", "API error");

        evaluate_tick(&engine, &host, 0, 1_000).await;
        assert_eq!(
            engine.runtime.parked_at("au-1", "tm-1"),
            Some(31_000),
            "restarted={restarted}: the premise — it parked"
        );

        if restarted {
            // A spawn re-indexing a LIVE leaf, which is all `IdentityIndex::index` does. Not a
            // `forget_terminal`, because that is the path this hazard is NOT on.
            fake.leaves
                .lock()
                .unwrap()
                .insert("tm-1".into(), "pc-2".into());
        }

        evaluate_tick(&engine, &host, 0, 31_001).await;
        tokio::time::sleep(Duration::from_millis(2_000)).await;

        assert_eq!(
            times_sent(&fake, "resume"),
            want,
            "restarted={}: a message decided from one run reached a different one: {:?}",
            restarted,
            fake.written()
        );
        if restarted {
            let log = log_details(&fake.store);
            assert!(
                log.iter().any(|(kind, detail)| kind == "Failed"
                    && detail.contains("the terminal restarted before the message was sent")),
                "the refusal must be a Failed row the user can see: {log:?}"
            );
        }
    }
}

// =============================================================================================
// §6.1 — the three cancellation gates, as three tests, never one parametrised one
// =============================================================================================
//
// They exercise three DIFFERENT routes into one purge. All three end at `forget_rule`, which
// `reload` calls for any rule absent from the map it just built or whose `updated_at` moved:
// disabled and deleted are absent (the `!enabled` filter is `reload`'s own, and a deleted row
// never comes back from `store.list_rules()`), while an edit keeps the rule live and moves
// `updated_at` instead. Disabled and deleted are additionally cut off by the walk in
// `evaluate_tick`, which visits only what is in `live`; an edited rule is still walked, so for
// it the purge is the whole of the gate. A single parametrised test could not tell the three
// routes apart if one of them rotted while the other two kept the test green.

/// **Disabled.** `set_enabled_checked` never touches `updated_at`, so the diff cannot be what
/// catches this one: `reload` drops the rule from the map it builds on `!rule.enabled` alone,
/// and an id that is absent from that map is one `forget_rule` is called for.
#[tokio::test(start_paused = true)]
async fn a_disabled_rule_does_not_fire_its_parked_send() {
    let (engine, fake, host) = rig_with_rule(|g| {
        g.parse_mut().find = "API error".into();
        g.cond_mut().finds = Finds::Event;
        g.action_mut().message = "resume".into();
        g.timer = Some(TimerStep {
            mode: TimerMode::AfterMatch { delay_ms: 30_000 },
        });
    });
    engine.runtime.set_arm("au-1", "tm-1", ArmState::armed());
    engine.runtime.mark_dirty("pc-1");
    fake.say("pc-1", "API error");

    evaluate_tick(&engine, &host, 0, 1_000).await;
    // Guard against the vacuous version: a test that never parked anything would trivially type
    // nothing and stay green forever.
    assert_eq!(
        engine.runtime.parked_at("au-1", "tm-1"),
        Some(31_000),
        "the premise: it parked"
    );

    fake.store.set_enabled_checked("au-1", false).unwrap();
    engine.reload(&fake.store, 2_000).unwrap();
    assert!(
        !engine.is_live("au-1"),
        "the premise: disabling drops it from the live set"
    );

    evaluate_tick(&engine, &host, 0, 31_001).await;
    tokio::time::sleep(Duration::from_millis(2_000)).await;
    assert!(
        fake.written().is_empty(),
        "a disabled rule's parked send must not fire: {:?}",
        fake.written()
    );
}

/// **Deleted.** The row is gone from the store entirely, so `reload` never sees it and it is
/// absent from `next` the same way a disabled rule is.
#[tokio::test(start_paused = true)]
async fn a_deleted_rule_does_not_fire_its_parked_send() {
    let (engine, fake, host) = rig_with_rule(|g| {
        g.parse_mut().find = "API error".into();
        g.cond_mut().finds = Finds::Event;
        g.action_mut().message = "resume".into();
        g.timer = Some(TimerStep {
            mode: TimerMode::AfterMatch { delay_ms: 30_000 },
        });
    });
    engine.runtime.set_arm("au-1", "tm-1", ArmState::armed());
    engine.runtime.mark_dirty("pc-1");
    fake.say("pc-1", "API error");

    evaluate_tick(&engine, &host, 0, 1_000).await;
    assert_eq!(
        engine.runtime.parked_at("au-1", "tm-1"),
        Some(31_000),
        "the premise: it parked"
    );

    assert!(
        fake.store.delete_rule("au-1").unwrap(),
        "the premise: the rule existed to delete"
    );
    engine.reload(&fake.store, 2_000).unwrap();
    assert!(
        !engine.is_live("au-1"),
        "the premise: a deleted rule is not live"
    );

    evaluate_tick(&engine, &host, 0, 31_001).await;
    tokio::time::sleep(Duration::from_millis(2_000)).await;
    assert!(
        fake.written().is_empty(),
        "a deleted rule's parked send must not fire: {:?}",
        fake.written()
    );
}

/// **Edited.** The rule stays enabled and stays live — `snapshot_live()` alone would still return
/// it, which is exactly why this test is not redundant with the other two: it is `reload`'s diff,
/// not the walk's outer filter, that has to do the work here.
#[tokio::test(start_paused = true)]
async fn an_edited_rule_does_not_fire_its_parked_send() {
    let (engine, fake, host) = rig_with_rule(|g| {
        g.parse_mut().find = "API error".into();
        g.cond_mut().finds = Finds::Event;
        g.action_mut().message = "resume".into();
        g.timer = Some(TimerStep {
            mode: TimerMode::AfterMatch { delay_ms: 30_000 },
        });
    });
    engine.runtime.set_arm("au-1", "tm-1", ArmState::armed());
    engine.runtime.mark_dirty("pc-1");
    fake.say("pc-1", "API error");

    evaluate_tick(&engine, &host, 0, 1_000).await;
    assert_eq!(
        engine.runtime.parked_at("au-1", "tm-1"),
        Some(31_000),
        "the premise: it parked"
    );

    let mut edited = fake
        .store
        .get_rule("au-1")
        .unwrap()
        .expect("the rule must still be in the store");
    edited.updated_at = 2_000;
    fake.store.save_rule(&edited).unwrap();
    engine.reload(&fake.store, 2_000).unwrap();
    assert!(
        engine.is_live("au-1"),
        "the premise: an edit keeps the rule live, unlike disable/delete"
    );
    // `forget_rule` (called because `updated_at` moved) also clears `watched`, which in
    // production the targeting tick re-derives from the rule's criteria within
    // `TARGETING_TICK_MS` — that tick does not run in this harness. Re-establishing it here is
    // NOT the thing under test; skipping it would let the walk skip "tm-1" for a reason that has
    // nothing to do with §6.1, and the test would pass vacuously for the wrong reason.
    engine
        .runtime
        .set_watched("au-1", ["tm-1".to_string()].into());

    evaluate_tick(&engine, &host, 0, 31_001).await;
    tokio::time::sleep(Duration::from_millis(2_000)).await;
    assert!(
        fake.written().is_empty(),
        "an edited rule's stale parked send must not fire: {:?}",
        fake.written()
    );
}

/// **R6 survives the delay.** A `runs_once` rule with a Wait step parks on every terminal that
/// crosses during the wait — the arm machine cannot stop that, because those are different
/// pairs — and they all come ripe on the same tick. The claim is what makes it one message, and
/// the parked route reaches it only because `admit` is shared: a gate written at one caller is a
/// gate the next caller opts out of.
#[tokio::test(start_paused = true)]
async fn a_runs_once_rule_that_parked_on_two_terminals_still_sends_once() {
    let mut once = ctx_rule_saying("au-once", "once only", 1);
    once.runs_once = true;
    once.graph.parse_mut().find = "API error".into();
    once.graph.cond_mut().finds = Finds::Event;
    once.graph.timer = Some(TimerStep {
        mode: TimerMode::AfterMatch { delay_ms: 30_000 },
    });
    let (engine, fake, host) = wire(vec![once]);
    open_second_terminal(&fake);
    engine
        .runtime
        .set_watched("au-once", ["tm-1".to_string(), "tm-2".to_string()].into());
    for tm in ["tm-1", "tm-2"] {
        engine.runtime.set_arm("au-once", tm, ArmState::armed());
    }

    fake.say("pc-1", "API error");
    engine.runtime.mark_dirty("pc-1");
    evaluate_tick(&engine, &host, 0, 1_000).await;
    fake.say("pc-2", "API error");
    engine.runtime.mark_dirty("pc-2");
    evaluate_tick(&engine, &host, 0, 1_250).await;
    assert_eq!(engine.runtime.parked_at("au-once", "tm-1"), Some(31_000));
    assert_eq!(
        engine.runtime.parked_at("au-once", "tm-2"),
        Some(31_250),
        "both parked"
    );

    evaluate_tick(&engine, &host, 0, 31_250).await;
    tokio::time::sleep(Duration::from_millis(4_000)).await;

    assert_eq!(
        times_sent(&fake, "once only"),
        1,
        "two parked sends came ripe together and both went out: {:?}",
        fake.written()
    );
    assert!(!engine.is_live("au-once"));
}

/// **A parked send dropped for losing the single-run claim must say so.**
///
/// Three terminals cross, three park, all ripe on one tick: `admit` claims for the first and
/// drops the rest. That is R6 working — the sibling test above is the proof — but it was
/// entirely silent. The pair had been visibly *"Waiting to send"* for up to ten minutes, the
/// countdown reached zero, and nothing anywhere said why no message arrived. And if the admitted
/// one then times out, `fail` gives the claim back while the others are already gone, so the rule
/// sends nothing at all and still says nothing.
///
/// **The rollback is deliberately not fixed here.** What `runs_once` should mean across
/// simultaneous crossings is a design question, not a defect with an obvious answer; the SILENCE
/// is the defect, and it is the whole of this test.
///
/// Which of the two loses is not fixed — the walk reads a `HashSet` of leaves — so the
/// assertion is the RELATION: exactly one row, naming the terminal that did not receive the
/// message. Asserting a fixed name would pin the iteration order instead of the behaviour.
#[tokio::test(start_paused = true)]
async fn a_parked_send_dropped_for_losing_the_claim_says_so() {
    let mut once = ctx_rule_saying("au-once", "once only", 1);
    once.runs_once = true;
    once.graph.parse_mut().find = "API error".into();
    once.graph.cond_mut().finds = Finds::Event;
    once.graph.timer = Some(TimerStep {
        mode: TimerMode::AfterMatch { delay_ms: 30_000 },
    });
    let (engine, fake, host) = wire(vec![once]);
    open_second_terminal(&fake);
    engine
        .runtime
        .set_watched("au-once", ["tm-1".to_string(), "tm-2".to_string()].into());
    for tm in ["tm-1", "tm-2"] {
        engine.runtime.set_arm("au-once", tm, ArmState::armed());
    }

    fake.say("pc-1", "API error");
    engine.runtime.mark_dirty("pc-1");
    evaluate_tick(&engine, &host, 0, 1_000).await;
    fake.say("pc-2", "API error");
    engine.runtime.mark_dirty("pc-2");
    evaluate_tick(&engine, &host, 0, 1_250).await;
    assert_eq!(engine.runtime.parked_at("au-once", "tm-1"), Some(31_000));
    assert_eq!(
        engine.runtime.parked_at("au-once", "tm-2"),
        Some(31_250),
        "premise: both parked"
    );

    evaluate_tick(&engine, &host, 0, 31_250).await;
    tokio::time::sleep(Duration::from_millis(4_000)).await;

    let sent = sent_to(&fake, "once only");
    assert_eq!(
        sent.len(),
        1,
        "premise: R6 still lets exactly one through: {:?}",
        fake.written()
    );
    let loser = if sent[0] == "pc-1" {
        "second"
    } else {
        "codex · core"
    };

    let dropped: Vec<_> = log_rows(&fake.store)
        .into_iter()
        .filter(|(_, detail, _)| detail.starts_with("not sent"))
        .collect();
    assert_eq!(
        dropped.len(),
        1,
        "a parked send was dropped for losing the claim and nothing was written: {:?}",
        log_rows(&fake.store)
    );
    assert_eq!(
        dropped[0].0, "Held",
        "nothing failed — the rule was asked and the rule declined: {dropped:?}"
    );
    assert_eq!(
        dropped[0].1,
        "not sent — this rule runs once, and another terminal had already claimed its one send"
    );
    assert_eq!(
        dropped[0].2.as_deref(),
        Some(loser),
        "the row must name the terminal that did NOT receive the message: {dropped:?}"
    );
}

/// A terminal that is not live is DORMANT, not dead: no evaluation, no log line, no state change.
/// The natural wrong implementation — treating an absent terminal as "condition false" — re-arms
/// every rule on every terminal that is merely closed for a moment.
#[tokio::test(start_paused = true)]
async fn a_dormant_terminal_produces_no_evaluation_and_no_log_line() {
    let (engine, fake, host) = wired();
    engine
        .runtime
        .set_arm("au-1", "tm-1", ArmState::Fired { at_ms: 5 });
    engine.runtime.mark_dirty("pc-1");
    // Watched, but the leaf resolves to nothing: session restore has not re-registered it.
    fake.close("tm-1");

    evaluate_tick(&engine, &host, 0, 1_000).await;

    assert_eq!(
        engine.runtime.arm_state("au-1", "tm-1"),
        ArmState::Fired { at_ms: 5 }
    );
    assert_eq!(engine.runtime.last_eval("au-1", "tm-1"), None);
    assert!(log_kinds(&fake.store).is_empty());
}

/// §2.6 layer 2: nothing reads a terminal while it is settling after a send — which is what stops
/// the burst on the `OnOutput` cadence, where the echo chunk itself marks the terminal dirty.
#[tokio::test(start_paused = true)]
async fn a_settling_terminal_is_not_evaluated_by_any_rule() {
    let (engine, fake, host) = wired();
    engine.runtime.mark_dirty("pc-1");
    fake.say("pc-1", "ctx:63%\n");
    engine.runtime.settle_until("tm-1", 5_000);

    evaluate_tick(&engine, &host, 0, 1_000).await;
    assert_eq!(
        engine.runtime.last_eval("au-1", "tm-1"),
        None,
        "settling means untouched"
    );

    // And once the window closes it evaluates normally again.
    evaluate_tick(&engine, &host, 0, 5_001).await;
    assert_eq!(engine.runtime.last_eval("au-1", "tm-1"), Some(5_001));
}

