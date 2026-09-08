use super::super::*;
use super::{open_second_terminal, pending};
use crate::automation::roster::RosterRow;
use crate::automation_engine::test_host::*;

// =============================================================================================
// The M3 review's round 1
// =============================================================================================

/// **R17 / §2.8, on the row it was written for.** A crossing decides, the user closes the tab, and
/// the send fails: the `failed` row must still carry the name the terminal had when the rule
/// decided. Resolving it at write time returns `None` for exactly this row.
#[tokio::test(start_paused = true)]
async fn a_log_row_carries_the_name_the_terminal_had_when_the_rule_decided() {
    let (engine, fake, host) = wired();
    let send = pending(&engine, &host, "au-1", ArmState::armed(), 1_000);
    // The decision has been made and carried; NOW the terminal goes away completely.
    fake.close("tm-1");

    run_crossing(engine.clone(), host.clone(), send).await;

    let rows = log_rows(&fake.store);
    assert_eq!(rows.len(), 1, "{:?}", rows);
    assert_eq!(rows[0].2.as_deref(), Some("codex · core"), "{:?}", rows);
    assert!(
        host.label_for("tm-1").is_none(),
        "the premise: there is genuinely no name left to look up"
    );
}

/// The paired positive: a row written while the terminal is open carries its name too, so
/// "carries the decide-time label" is not satisfied by hard-coding one.
#[tokio::test(start_paused = true)]
async fn a_sent_row_carries_the_name_as_well() {
    let (engine, fake, host) = wired();
    let send = pending(&engine, &host, "au-1", ArmState::armed(), 1_000);

    run_crossing(engine.clone(), host.clone(), send).await;
    tokio::time::sleep(Duration::from_millis(1_500)).await;

    let rows = log_rows(&fake.store);
    assert_eq!(rows.len(), 1, "{:?}", rows);
    assert_eq!(rows[0].0, "Sent");
    assert_eq!(rows[0].2.as_deref(), Some("codex · core"));
}

/// And so does a row that sent NOTHING, which is most of the rows a working rule writes.
///
/// `log_rows(..).2` is read at three places and every one of them is a `Sent` or `Failed` row, so
/// hard-coding `None` for every `held` / `re-armed` / `no-match` row passed the whole suite while
/// the Name column R17 specifies went blank for the ordinary case.
#[tokio::test(start_paused = true)]
async fn a_row_that_sent_nothing_carries_the_name_as_well() {
    let (engine, fake, host) = wired();
    // Fired and still true: `held`, which is a Decision-class row and so not verbose-gated.
    engine
        .runtime
        .set_arm("au-1", "tm-1", ArmState::Fired { at_ms: 500 });
    fake.say("pc-1", "ctx:63%\n");
    engine.runtime.mark_dirty("pc-1");

    evaluate_tick(&engine, &host, 0, 1_000).await;

    let rows = log_rows(&fake.store);
    assert_eq!(rows.len(), 1, "{:?}", rows);
    assert_ne!(
        rows[0].0, "Sent",
        "the premise: nothing was sent — {:?}",
        rows
    );
    assert_eq!(rows[0].2.as_deref(), Some("codex · core"), "{:?}", rows);
    assert!(fake.written().is_empty());
}

/// **§2.4: keys are cleared when a terminal leaves the watch set.** Three of that sentence's four
/// events were implemented; this was the fourth.
///
/// The failure it prevents is silent and permanent: a `Command contains` rule watching a build
/// fires, the build ends, the terminal drops out of the matched set still holding `Fired` — and
/// when the next build starts it rejoins with that stale key, so the rule never fires again until
/// something drives its condition false first.
#[tokio::test(start_paused = true)]
async fn a_terminal_that_leaves_the_watch_set_loses_that_pairs_arm_state() {
    let (engine, fake, host) = wire(vec![ctx_rule("au-1")]);
    fake.roster.lock().unwrap().push(RosterRow {
        terminal_id: Some("tm-2".into()),
        process_id: "pc-2".into(),
        name: "Terminal-powershell".into(),
        shell: "powershell".into(),
        pid: 102,
        display_label: Some("second".into()),
        cwd: None,
        command_lines: Vec::new(),
    });
    fake.leaves
        .lock()
        .unwrap()
        .insert("tm-2".into(), "pc-2".into());

    // Both terminals match `All terminals`, and both have fired.
    targeting_tick(&engine, &host, 1_000);
    for tm in ["tm-1", "tm-2"] {
        engine
            .runtime
            .set_arm("au-1", tm, ArmState::Fired { at_ms: 500 });
        engine.runtime.set_last_eval("au-1", tm, 500);
        engine.runtime.record_fire("au-1", tm, 500);
    }

    // tm-2 stops matching.
    fake.close("tm-2");
    targeting_tick(&engine, &host, 3_000);

    assert_eq!(
        engine.runtime.arm_state("au-1", "tm-2"),
        ArmState::Unseen,
        "the stale key survived"
    );
    assert_eq!(engine.runtime.last_eval("au-1", "tm-2"), None);
    assert_eq!(
        engine.runtime.fire_record("au-1", "tm-2"),
        Some((1, 500)),
        "the FIRE HISTORY is not the arm state: a terminal that left the set has not un-fired"
    );
    assert_eq!(
        engine.runtime.arm_state("au-1", "tm-1"),
        ArmState::Fired { at_ms: 500 },
        "and the terminal that stayed is untouched"
    );
}

/// **A rollback restores; it must never CREATE.** Both sites, as a table \u2014 the queue-timeout
/// path and the quit path both write `prev` back, and one of them being guarded is not the class
/// being fixed.
///
/// A `tm-` leaf is REUSED: Ctrl+R restarts a terminal under the same id and session restore
/// re-registers it. A key resurrected after `cleanup_terminal_state` purged it means the next
/// terminal to carry that leaf starts `Armed` rather than `Unseen`, and settled decision 7 \u2014 a
/// terminal already above the threshold when it spawns must not fire without a crossing \u2014 is
/// broken on its first read.
#[tokio::test(start_paused = true)]
async fn a_rollback_never_resurrects_a_pair_the_teardown_already_purged() {
    for quitting in [false, true] {
        let (engine, fake, host) = wired();
        let send = pending(&engine, &host, "au-1", ArmState::armed(), 1_000);

        // The terminal closes mid-flight, and teardown purges every `tm-`keyed entry for it.
        fake.close("tm-1");
        engine.runtime.forget_terminal("tm-1");
        if quitting {
            engine.stop();
        }

        run_crossing(engine.clone(), host.clone(), send).await;

        assert_eq!(
            engine.runtime.arm_state("au-1", "tm-1"),
            ArmState::Unseen,
            "quitting={}: a dead pair came back as Armed",
            quitting
        );
    }
}

/// The paired positive, and it is what stops the fix above being "never roll back at all": a pair
/// the teardown did NOT purge is restored to exactly `prev`.
#[tokio::test(start_paused = true)]
async fn a_rollback_still_restores_a_pair_that_is_still_there() {
    for quitting in [false, true] {
        let (engine, fake, host) = wired();
        let send = pending(&engine, &host, "au-1", ArmState::re_armed(), 1_000);
        if quitting {
            engine.stop();
        } else {
            *fake.write_err.lock().unwrap() = Some("no writer".into());
        }

        run_crossing(engine.clone(), host.clone(), send).await;

        assert_eq!(
            engine.runtime.arm_state("au-1", "tm-1"),
            ArmState::re_armed(),
            "quitting={}: the rollback lost seen_fire, or did not happen",
            quitting
        );
    }
}

/// **B-1, source-derived: the engine's `spawn` must use Tauri's runtime, not tokio's directly.**
///
/// `.setup()` runs on the main thread from the tao event-loop callback with no tokio runtime
/// entered, so a bare `tokio::spawn` panics and takes the app's startup with it. This cannot be a
/// runtime assertion — a test binary always has a runtime, which is exactly why 700 green tests
/// said nothing about it. Every other setup-time task in `lib.rs` uses the wrapper, including
/// `spawn_history_flush_task`, the function this call sits directly beneath.
#[test]
fn the_engine_is_spawned_on_tauris_runtime_because_setup_has_none() {
    // **Comments stripped, and `ends_with` rather than `contains`.** The first version of this
    // test searched the whole text preceding the call for `"tauri::async_runtime::"`, and that
    // text was the comment explaining why the call must be `tauri::async_runtime::spawn`. The
    // mutation to `tokio::spawn` survived it. `ends_with` can only be satisfied by the characters
    // immediately before the call — by the call itself.
    let engine = strip_comments(include_str!("../../../automation_engine.rs"));
    let start = engine
        .find("pub fn spawn<R: tauri::Runtime>")
        .expect("spawn must exist");
    let body = &engine[start..];
    let outer = body.find("spawn({").expect("it must spawn something");
    assert!(
        body[..outer].ends_with("tauri::async_runtime::"),
        "the OUTER spawn runs from `.setup()`, where no runtime is entered, so it must go \
         through Tauri's wrapper; the call reads `{}spawn({{`",
        body[..outer]
            .rsplit('\n')
            .next()
            .unwrap_or_default()
            .trim_start()
    );

    let lib = strip_comments(include_str!("../../../lib.rs"));
    let setup_start = lib
        .find("spawn_history_flush_task(state.clone());")
        .expect("the setup site");
    // Windowed by LINES rather than bytes: `strip_comments` drops comment-only lines and leaves
    // trailing ones, so a multi-byte character landing inside a fixed byte window panics with a
    // slice error instead of failing with this test's own message.
    let setup = lib[setup_start..]
        .lines()
        .take(12)
        .collect::<Vec<_>>()
        .join("\n");
    let setup = setup.as_str();
    assert!(
        !setup.contains("tokio::spawn"),
        "a bare tokio::spawn beside the setup call is the same panic by another name"
    );
    // And that the engine is STARTED at all. Everything above is a claim about how `spawn` is
    // written; deleting the call to it from `.setup()` satisfied every one of them, and the whole
    // feature would simply not run while 723 tests stayed green.
    assert!(
        setup.contains("automation_engine::spawn(state.clone());"),
        "nothing starts the automation engine: the loops never run"
    );
}

/// **B-2: R6 is per RULE, not per pair.** A `runs_once` rule watching two terminals crosses on
/// both in one tick, and the send lock is per LEAF — so two tasks take two different locks and two
/// messages go out on a rule the user asked to run once.
///
/// §10.14c could not see this: its fixture has one terminal. *A fixture that varies only the rule
/// dimension cannot test a rule that reads the terminal dimension too* — the standing lesson, now
/// at a fourth site.
#[tokio::test(start_paused = true)]
async fn a_runs_once_rule_sends_once_across_every_terminal_it_watches() {
    let mut once = ctx_rule_saying("au-once", "once only", 1);
    once.runs_once = true;
    let (engine, fake, host) = wire(vec![once]);
    open_second_terminal(&fake);
    engine
        .runtime
        .set_watched("au-once", ["tm-1".to_string(), "tm-2".to_string()].into());
    for tm in ["tm-1", "tm-2"] {
        engine.runtime.set_arm("au-once", tm, ArmState::armed());
    }
    fake.say("pc-1", "ctx:63%\n");
    fake.say("pc-2", "ctx:63%\n");
    engine.runtime.mark_dirty("pc-1");
    engine.runtime.mark_dirty("pc-2");

    evaluate_tick(&engine, &host, 0, 1_000).await;
    tokio::time::sleep(Duration::from_millis(2_000)).await;

    assert_eq!(
        times_sent(&fake, "once only"),
        1,
        "a runs-once rule typed into every terminal it watches: {:?}",
        fake.written()
    );
    assert_eq!(
        log_rows(&fake.store)
            .iter()
            .filter(|(k, _, _)| k == "Sent")
            .count(),
        1,
        "and it logged every one of them"
    );
    assert!(!engine.is_live("au-once"));
}

/// **The same rule, one tick later** — and the half that shipped open.
///
/// The test above varies the TERMINAL dimension and holds the tick at one, which is the standing
/// lesson (*a fixture that varies only one dimension cannot test a key with two*) applied to the
/// wrong axis. The in-tick dedupe it pinned scans the current tick's `sends` vector, so two
/// terminals crossing on consecutive ticks are two separate vectors and it sees neither; the only
/// cross-tick guard was `is_live`, which does not go false until `complete_rule` runs — after
/// `deliver` returns, one `PASTE_SUBMIT_GAP_MS` and two evaluator ticks later, plus any queue
/// wait. Two terminals printing 250 ms apart is not an edge case, it is what `AllTerminals` and
/// `follow_new` are for.
#[tokio::test(start_paused = true)]
async fn a_runs_once_rule_does_not_send_again_on_the_next_tick() {
    let mut once = ctx_rule_saying("au-once", "once only", 1);
    once.runs_once = true;
    let (engine, fake, host) = wire(vec![once]);
    open_second_terminal(&fake);
    engine
        .runtime
        .set_watched("au-once", ["tm-1".to_string(), "tm-2".to_string()].into());
    for tm in ["tm-1", "tm-2"] {
        engine.runtime.set_arm("au-once", tm, ArmState::armed());
    }

    // Only tm-1 crosses this tick: pc-2 is clean, so its pair is not due at all and the in-tick
    // dedupe never has two entries to compare.
    fake.say("pc-1", "ctx:63%\n");
    engine.runtime.mark_dirty("pc-1");
    evaluate_tick(&engine, &host, 0, 1_000).await;

    // 250 ms — one tick, and half the paste-to-submit gap. The first message has NOT landed, so
    // `complete_rule` has not run and `is_live` is still true.
    fake.say("pc-2", "ctx:63%\n");
    engine.runtime.mark_dirty("pc-2");
    evaluate_tick(&engine, &host, 0, 1_250).await;

    tokio::time::sleep(Duration::from_millis(4_000)).await;

    assert_eq!(
        times_sent(&fake, "once only"),
        1,
        "a runs-once rule sent again on the next tick: {:?}",
        fake.written()
    );
    assert_eq!(
        log_rows(&fake.store)
            .iter()
            .filter(|(k, _, _)| k == "Sent")
            .count(),
        1,
        "and logged both of them"
    );
    assert!(!engine.is_live("au-once"));
}

/// **A rollback returns the claim** — the survivor a mutation pass found, not the review.
///
/// The claim is taken where the crossing is DECIDED, so every path that produces no message has
/// to give it back: `fail`'s three (queue timeout, terminal closed, write refused) and the quit.
/// Without that, one failed write retires a single-run rule that has never sent anything —
/// silently, for the rest of the session, with the rule still showing as live.
#[tokio::test(start_paused = true)]
async fn a_runs_once_rule_whose_send_failed_can_still_send() {
    let mut once = ctx_rule_saying("au-once", "once only", 1);
    once.runs_once = true;
    let (engine, fake, host) = wire(vec![once]);
    engine
        .runtime
        .set_watched("au-once", ["tm-1".to_string()].into());
    engine.runtime.set_arm("au-once", "tm-1", ArmState::armed());
    *fake.write_err.lock().unwrap() = Some("no writer".into());

    fake.say("pc-1", "ctx:63%\n");
    engine.runtime.mark_dirty("pc-1");
    evaluate_tick(&engine, &host, 0, 1_000).await;
    tokio::time::sleep(Duration::from_millis(2_000)).await;

    // Counted in the LOG, not in the write log: the fake records a write before it refuses it,
    // so `written()` shows the attempt either way. A `Sent` row is only written after `deliver`
    // returns `Ok`.
    let sent_rows = |f: &FakeHost| {
        log_rows(&f.store)
            .iter()
            .filter(|(k, _, _)| k == "Sent")
            .count()
    };
    assert_eq!(sent_rows(&fake), 0, "the premise: the write was refused");
    assert!(
        engine.is_live("au-once"),
        "a failed send must not complete the rule"
    );
    assert_eq!(
        engine.runtime.arm_state("au-once", "tm-1"),
        ArmState::armed(),
        "the premise: the rollback restored the arm state, so a next crossing is possible"
    );

    // The next crossing. Everything is as it was, and the only thing that could stop it is a
    // claim nobody gave back.
    *fake.write_err.lock().unwrap() = None;
    engine.runtime.mark_dirty("pc-1");
    evaluate_tick(&engine, &host, 0, 4_000).await;
    tokio::time::sleep(Duration::from_millis(2_000)).await;

    assert_eq!(
        sent_rows(&fake),
        1,
        "the failed send kept the claim: this rule can never send again — {:?}",
        log_rows(&fake.store)
    );
}

