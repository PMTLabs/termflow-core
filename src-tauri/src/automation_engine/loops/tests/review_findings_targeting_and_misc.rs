use super::super::*;
use super::{open_second_terminal, pending};
use crate::automation_engine::test_host::*;

/// **A pair that read NOTHING has not spent its terminal's output** — the other mutation survivor.
///
/// §4.5's dormant terminal: the leaf resolves, the process is dirty, and `tail` finds no parser
/// because it closed between this tick's leaf resolution and the read. That pair WAS due and WAS
/// picked, and it is not in `owed`, so `settled_processes` named its process and the tick cleared
/// a signal nobody had read — permanently, if that was the last thing the terminal printed, which
/// is the normal end of a build. It is the door `settled_processes`'s own enumeration said did not
/// exist.
#[tokio::test(start_paused = true)]
async fn a_tick_that_could_not_read_a_terminal_leaves_it_dirty() {
    let (engine, fake, host) = wired();
    // Dirty, and no screen at all: nothing has ever `say`ed anything on pc-1.
    engine.runtime.mark_dirty("pc-1");

    evaluate_tick(&engine, &host, 0, 1_000).await;

    assert_eq!(
        engine.runtime.arm_state("au-1", "tm-1"),
        ArmState::Unseen,
        "the premise: nothing was evaluated, so no arm state moved"
    );
    assert!(log_rows(&fake.store).is_empty(), "§4.5: no read, no row");
    assert!(
        engine.runtime.is_dirty("pc-1"),
        "the tick spent a signal no pair could read"
    );

    // The paired positive, so this is not satisfied by never clearing anything.
    fake.say("pc-1", "ctx:18%\n");
    evaluate_tick(&engine, &host, 0, 2_000).await;
    assert!(
        !engine.runtime.is_dirty("pc-1"),
        "an ordinary read must still spend the signal"
    );
}

/// The other half of B-2's fix, and it had no oracle: **only a `runs_once` rule is deduped.**
///
/// Dropping the `runs_once &&` guard is a one-word mutation that survived the whole suite. It
/// turns the per-tick dedupe into one send per RULE per tick forever, so the canonical rule
/// watching three terminals types into one of them and leaves the other two `Fired` with nothing
/// sent — silently, because the arm state advances either way. A fix needs its negative case
/// pinned as firmly as its positive one, or the next edit is free to over-apply it.
#[tokio::test(start_paused = true)]
async fn a_repeating_rule_still_sends_to_every_terminal_it_watches() {
    let (engine, fake, host) = wire(vec![ctx_rule_saying("au-many", "every one", 1)]);
    open_second_terminal(&fake);
    engine
        .runtime
        .set_watched("au-many", ["tm-1".to_string(), "tm-2".to_string()].into());
    for tm in ["tm-1", "tm-2"] {
        engine.runtime.set_arm("au-many", tm, ArmState::armed());
    }
    fake.say("pc-1", "ctx:63%\n");
    fake.say("pc-2", "ctx:63%\n");
    engine.runtime.mark_dirty("pc-1");
    engine.runtime.mark_dirty("pc-2");

    evaluate_tick(&engine, &host, 0, 1_000).await;
    tokio::time::sleep(Duration::from_millis(2_000)).await;

    assert_eq!(
        times_sent(&fake, "every one"),
        2,
        "R6 bounds a runs-once rule, not every rule: {:?}",
        fake.written()
    );
    assert!(engine.is_live("au-many"), "and nothing completed it");
}

/// **H-3's own fix had no oracle either.** `run_targeting` compares `(watched, missing)` against
/// the previous pass; reverting that tuple to `missing` alone survived the suite — the same hole
/// H-3 reported, fixed and then left unpinned, which is how a finding comes back.
///
/// A terminal JOINING is the case that separates them: an `All terminals` rule pins nothing, so
/// `missing` cannot move, while the payload gains a row every open Settings page has to be told
/// about.
#[tokio::test(start_paused = true)]
async fn the_targeting_loop_notices_a_terminal_joining_and_not_only_one_going_missing() {
    let (engine, fake, host) = wired();
    let targeting = tokio::spawn(run_targeting(engine.clone(), host.clone()));

    // The first pass adopts tm-1 and says so. Drained here, so what is asserted below is the
    // SECOND change and not this one.
    tokio::time::sleep(Duration::from_millis(TARGETING_TICK_MS / 2)).await;
    assert!(
        engine.take_state_emit(1_000),
        "the first pass must announce the rule's first leaf"
    );
    assert!(engine.runtime.watches("au-1", "tm-1"));

    // A second terminal opens. `All terminals` + `follow_new` adopts it.
    open_second_terminal(&fake);
    tokio::time::sleep(Duration::from_millis(TARGETING_TICK_MS * 2)).await;
    engine.stop();

    assert!(
        engine.runtime.watches("au-1", "tm-2"),
        "the premise: it was adopted"
    );
    assert!(
        engine.take_state_emit(10_000),
        "the watch set grew and no window was told; only `missing` was being diffed"
    );
    tokio::time::sleep(Duration::from_millis(TARGETING_TICK_MS * 2)).await;
    assert!(targeting.is_finished());

    // **And a pass with nothing to say says nothing.** Without this half, a loop that simply
    // called `mark_state_dirty()` every two seconds — no diff at all — passes both assertions
    // above and repaints every open Settings page for the life of the app.
    let (engine, _fake, host) = wired();
    let quiet = tokio::spawn(run_targeting(engine.clone(), host.clone()));
    tokio::time::sleep(Duration::from_millis(TARGETING_TICK_MS / 2)).await;
    assert!(
        engine.take_state_emit(1_000),
        "the premise: the first pass adopted tm-1"
    );
    tokio::time::sleep(Duration::from_millis(TARGETING_TICK_MS * 3)).await;
    engine.stop();
    assert!(
        !engine.take_state_emit(20_000),
        "three passes with an unchanged roster still announced something"
    );
    tokio::time::sleep(Duration::from_millis(TARGETING_TICK_MS * 2)).await;
    assert!(quiet.is_finished());
}

/// **M-1: the 250 ms floor is a second way to lose a terminal's output**, and `settled_processes`
/// covered only the first.
///
/// Two rules watch one terminal. A evaluated 300 ms ago and is due; B evaluated 100 ms ago and the
/// floor holds it off, so B never enters `due` at all — which is why no amount of reasoning about
/// `picked` can see it. A runs, the flag is spent on B's behalf, the terminal goes quiet, and B
/// never reads that output: no log line, no state change, nothing on screen.
#[tokio::test(start_paused = true)]
async fn a_pair_held_off_by_the_floor_keeps_its_terminals_output() {
    let (engine, fake, host) = wire(vec![
        ctx_rule_saying("au-a", "from A", 1),
        ctx_rule_saying("au-b", "from B", 2),
    ]);
    for id in ["au-a", "au-b"] {
        engine.runtime.set_watched(id, ["tm-1".to_string()].into());
        engine.runtime.set_arm(id, "tm-1", ArmState::armed());
    }
    // A last ran 300 ms ago (due); B ran 100 ms ago (held off by the floor).
    engine.runtime.set_last_eval("au-a", "tm-1", 700);
    engine.runtime.set_last_eval("au-b", "tm-1", 900);
    fake.say("pc-1", "ctx:18%\n");
    engine.runtime.mark_dirty("pc-1");

    evaluate_tick(&engine, &host, 0, 1_000).await;

    assert_eq!(
        engine.runtime.last_eval("au-a", "tm-1"),
        Some(1_000),
        "the premise: A was due and ran"
    );
    assert_eq!(
        engine.runtime.last_eval("au-b", "tm-1"),
        Some(900),
        "and B did not"
    );
    assert!(
        engine.runtime.is_dirty("pc-1"),
        "A spent the flag on B's behalf, and B never sees this output again"
    );

    // A tick where BOTH are past the floor: B reads that same output, and only now — with nobody
    // left owed — is the flag spent. (The guard is symmetric, so a tick at 1_200 would hold it
    // for A instead; that is the rule working, not a second bug.)
    evaluate_tick(&engine, &host, 0, 1_300).await;
    assert_eq!(engine.runtime.last_eval("au-b", "tm-1"), Some(1_300));
    assert!(
        !engine.runtime.is_dirty("pc-1"),
        "and now the flag is genuinely spent"
    );
}

/// **M-5: `touch_target` had no production caller**, so `automation_targets` held rows only for
/// PINNED ids.
///
/// Two things were dead because of it: `label_at`'s third step (the rule's own snapshot) in
/// production, and the picker's *not open* row for a criterion-matched terminal, which draws a
/// label and a folder it had no source for (§4.3, R14). §10.12b asked for the final-persist
/// behaviour and no test could reach it, because nothing called the function.
#[test]
fn the_targeting_tick_records_what_each_rule_resolved() {
    let (engine, fake, host) = wired();
    fake.roster.lock().unwrap()[0].display_label = Some("codex · core".into());
    fake.roster.lock().unwrap()[0].cwd = Some("D:/sources/work".into());

    targeting_tick(&engine, &host, 1_000);

    let rows = fake.store.targets_for("au-1").unwrap();
    let row = rows
        .iter()
        .find(|r| r.0 == "tm-1")
        .unwrap_or_else(|| panic!("{:?}", rows));
    assert_eq!(
        row.1, "matched",
        "a criterion match is never pinned, so nothing else writes it"
    );
    assert_eq!(row.2.as_deref(), Some("codex · core"));
    assert_eq!(row.3.as_deref(), Some("D:/sources/work"));
}

/// **L-6: the engine is stopped FIRST.** Below `flush_all_history` — up to 30 s of scrollback —
/// and two sidecar shutdowns, the loops went on evaluating and could START a send through the
/// whole of them, which is the opposite of §2.1's "unstarted or complete".
///
/// Source-derived because the `Exit` arm is a closure inside `.run()`: there is no seam.
#[test]
fn the_exit_arm_stops_the_engine_before_anything_slow() {
    let lib = strip_comments(include_str!("../../../lib.rs"));
    let start = lib
        .find("if let RunEvent::Exit = event {")
        .expect("the Exit arm");
    let arm = lib[start..].lines().take(25).collect::<Vec<_>>().join("\n");
    let arm = arm.as_str();
    let stop = arm
        .find("automations.stop()")
        .expect("Exit must stop the engine");
    for slow in [
        "flush_all_history(",
        "shutdown_mcp_server(",
        "shutdown_fabric(",
    ] {
        let at = arm
            .find(slow)
            .unwrap_or_else(|| panic!("{} left the Exit arm", slow));
        assert!(stop < at, "the loops keep deciding across {}", slow);
    }
}

/// **The tick keeps the EARLIEST dirty generation it read**, and nothing could tell that from
/// keeping the latest, because the difference needs the TAP to move between two pairs of one tick.
///
/// Round 1's clearest lesson was that the fake could not reach the seams; this is the same lesson
/// one layer in. `on_leaf_lookup` fires between the first pair's read and the second's, exactly
/// where the real tap runs — on another worker, while the evaluator walks its pairs.
#[tokio::test(start_paused = true)]
async fn output_arriving_mid_tick_survives_that_ticks_clear() {
    let (engine, fake, host) = wire(vec![
        ctx_rule_saying("au-a", "from A", 1),
        ctx_rule_saying("au-b", "from B", 2),
    ]);
    for id in ["au-a", "au-b"] {
        engine.runtime.set_watched(id, ["tm-1".to_string()].into());
        engine.runtime.set_arm(id, "tm-1", ArmState::armed());
    }
    fake.say("pc-1", "ctx:18%\n");
    engine.runtime.mark_dirty("pc-1");

    // The tap, firing once AFTER the first pair read the generation and before the second did.
    let rt = engine.runtime.clone();
    let lookups = Arc::new(AtomicUsize::new(0));
    let seen = lookups.clone();
    *fake.on_leaf_lookup.lock().unwrap() = Some(Arc::new(move |_tm: &str| {
        if seen.fetch_add(1, Ordering::Relaxed) == 1 {
            rt.mark_dirty("pc-1");
        }
    }));

    evaluate_tick(&engine, &host, 0, 1_000).await;

    assert!(
        lookups.load(Ordering::Relaxed) >= 2,
        "the premise: both pairs resolved their leaf"
    );
    assert!(
        engine.runtime.is_dirty("pc-1"),
        "the tick cleared a signal that arrived after it had finished reading"
    );
}

/// A rule's snapshot rows are its OWN. Writing every roster row under every rule puts terminals
/// the rule does not watch into `targets_for`, which is what the picker draws as this rule's
/// targets — and `wired()`'s single always-matching terminal cannot see the difference.
#[test]
fn the_snapshot_is_written_only_for_terminals_the_rule_watches() {
    let mut only_one = ctx_rule("au-1");
    only_one.criterion = Criterion::TerminalIdIs;
    only_one.criterion_value = "tm-1".into();
    let (engine, fake, host) = wire(vec![only_one]);
    open_second_terminal(&fake);

    targeting_tick(&engine, &host, 1_000);

    let ids: Vec<String> = fake
        .store
        .targets_for("au-1")
        .unwrap()
        .into_iter()
        .map(|r| r.0)
        .collect();
    assert_eq!(
        ids,
        vec!["tm-1".to_string()],
        "a rule was given a snapshot row for a terminal it does not watch"
    );
}

/// An exception is a criterion the roster must answer too. The fake deliberately exposes its
/// process-derived command lines only when `roster` was asked for `CommandContains`, mirroring
/// the production scan gate. Reverting the exclusion half of the criteria collection leaves the
/// line empty, so `tm-1` incorrectly remains watched and this test fails.
#[test]
fn targeting_requests_and_uses_command_lines_for_an_exclusion_criterion() {
    let mut rule = ctx_rule("au-exclude-claude");
    rule.criterion = Criterion::AllTerminals;
    rule.exclude_criterion = Some(Criterion::CommandContains);
    rule.exclude_criterion_value = "claude".into();
    let (engine, fake, host) = wire(vec![rule]);
    fake.scanned_command_lines
        .lock()
        .unwrap()
        .insert("tm-1".into(), vec!["pwsh.exe -Command claude".into()]);

    let pass = targeting_tick(&engine, &host, 1_000);

    assert!(
        fake.last_roster_criteria()
            .contains(&Criterion::CommandContains),
        "the exclusion must request the process scan that populates command lines"
    );
    assert_eq!(
        pass.watched.get("au-exclude-claude"),
        Some(&HashSet::new()),
        "the populated command line must make the exception remove tm-1"
    );
}

/// **`if report.emit` written as `if false` changed nothing any test could see**, in either of
/// the two places it was written. The decision now has one implementation, out where a test can
/// reach it.
///
/// `emit` is the STORE's answer — its verbose gate decides whether a row was actually written —
/// so a reload that refused a rule but wrote no row must announce nothing, or every open Settings
/// page re-queries the log for something that is not there.
#[test]
fn a_reload_announces_the_rules_it_refused_and_only_when_a_row_was_written() {
    use crate::automation_engine::{refusals_to_announce, ReloadReport};

    let refused = ReloadReport {
        live: 2,
        skipped: vec![
            ("au-1".into(), "that pattern could not be understood".into()),
            ("au-2".into(), "that pattern could not be understood".into()),
        ],
        emit: true,
    };
    assert_eq!(
        refusals_to_announce(&refused),
        Some(vec!["au-1".to_string(), "au-2".to_string()])
    );

    // The same refusals with `emit` false. **`reload` cannot produce this pair** — it sets `emit`
    // inside the very loop that fills `skipped` — so this row pins THIS FUNCTION's contract, that
    // `emit` is the gate and the list is not consulted when it is closed, rather than a state the
    // engine reaches.
    assert_eq!(
        refusals_to_announce(&ReloadReport {
            emit: false,
            ..refused
        }),
        None
    );

    // An empty `skipped` with `emit` set: also unreachable from `reload`, and also this function's
    // contract — an empty list is not `None`, because a caller with a reason to emit and no ids to
    // name still emits. *(This comment used to justify the row with "a row written by something
    // else in the same load"; `reload` has no such mechanism.)*
    assert_eq!(
        refusals_to_announce(&ReloadReport {
            live: 3,
            skipped: vec![],
            emit: true
        }),
        Some(vec![])
    );
}

/// The other half of `owed`, and the half my comment claimed without a test: **a TIMER rule
/// waiting out its interval is not owed this output**, because a timer pair does not read `dirty`
/// at all. Without the cadence check it would pin its terminal dirty for the whole interval, and
/// every on-output rule on that terminal would re-read the same text every 250 ms tick.
#[tokio::test(start_paused = true)]
async fn a_timer_rule_waiting_out_its_interval_does_not_pin_the_terminal_dirty() {
    let mut timer = ctx_rule_saying("au-timer", "on the minute", 2);
    timer.graph.monitor_mut().cadence = Cadence::Timer;
    timer.graph.monitor_mut().every_ms = 60_000;
    let (engine, fake, host) = wire(vec![ctx_rule_saying("au-out", "on output", 1), timer]);
    for id in ["au-out", "au-timer"] {
        engine.runtime.set_watched(id, ["tm-1".to_string()].into());
        engine.runtime.set_arm(id, "tm-1", ArmState::armed());
    }
    engine.runtime.set_last_eval("au-timer", "tm-1", 900);
    fake.say(
        "pc-1", "ctx:18%
",
    );
    engine.runtime.mark_dirty("pc-1");

    evaluate_tick(&engine, &host, 0, 1_000).await;

    assert_eq!(
        engine.runtime.last_eval("au-out", "tm-1"),
        Some(1_000),
        "the premise: the on-output rule was due and ran"
    );
    assert_eq!(
        engine.runtime.last_eval("au-timer", "tm-1"),
        Some(900),
        "and the timer rule has 59 seconds still to wait"
    );
    assert!(
        !engine.runtime.is_dirty("pc-1"),
        "a timer pair does not read `dirty`, so it is never owed this terminal's output"
    );
}

/// **The settle window spans the QUEUE, not just the write.** Two rules crossing on one terminal
/// in one tick serialise on its lock, so the second send's message lands a queue wait later than
/// the first's — and §2.6 layer 2 runs for `ECHO_SETTLE_MS` from each write, not from the tick.
///
/// Round 1 moved the window from decide time to `deliver`'s own duration, which is the same defect
/// one step further back: the wait for the lock still fell outside it, so the second message's
/// window had already been running for the whole of its wait by the time it was typed.
#[tokio::test(start_paused = true)]
async fn a_queued_send_gets_its_full_settle_window_from_its_own_write() {
    let (engine, fake, host) = wire(vec![
        ctx_rule_saying("au-a", "first message", 1),
        ctx_rule_saying("au-b", "second message", 2),
    ]);
    for id in ["au-a", "au-b"] {
        engine.runtime.set_watched(id, ["tm-1".to_string()].into());
        engine.runtime.set_arm(id, "tm-1", ArmState::armed());
    }
    fake.say("pc-1", "ctx:63%\n");
    engine.runtime.mark_dirty("pc-1");

    evaluate_tick(&engine, &host, 0, 1_000).await;
    tokio::time::sleep(Duration::from_millis(4_000)).await;

    assert_eq!(
        times_sent(&fake, "first message"),
        1,
        "the premise: both sent"
    );
    assert_eq!(times_sent(&fake, "second message"), 1);

    // The first send lands one paste-to-submit gap after the decision; the second waits for the
    // lock through all of that and then takes another gap of its own.
    let gap = crate::automation::send::PASTE_SUBMIT_GAP_MS as i64;
    let second_landed = 1_000 + gap * 2;
    assert!(
        engine
            .runtime
            .is_settling("tm-1", second_landed + ECHO_SETTLE_MS - 1),
        "the queued send's window had already been running for the length of its wait"
    );
    assert!(!engine
        .runtime
        .is_settling("tm-1", second_landed + ECHO_SETTLE_MS + 1));
}


/// **B-3: the log records transitions.** A rule that is working sits `Fired` with its condition
/// true and decides `held` on every 250 ms tick. `Held` is a Decision-class kind, so it is never
/// gated — and the 200-row per-rule cap then evicts that rule's own `sent` row inside a minute,
/// which is the row §7.9's end-to-end story and GUI 9 check survives a relaunch.
#[tokio::test(start_paused = true)]
async fn a_rule_that_stays_true_logs_held_once_and_not_once_per_tick() {
    let (engine, fake, host) = wire(vec![ctx_rule("au-1")]);
    engine.runtime.set_arm("au-1", "tm-1", ArmState::armed());
    fake.say("pc-1", "ctx:63%\n");

    // The crossing, then nine more ticks with the value still above the threshold.
    for t in 1..=10 {
        engine.runtime.mark_dirty("pc-1");
        evaluate_tick(&engine, &host, 0, t * 3_000).await;
        tokio::time::sleep(Duration::from_millis(2_000)).await;
    }

    let kinds: Vec<String> = log_rows(&fake.store)
        .into_iter()
        .map(|(k, _, _)| k)
        .collect();
    assert_eq!(
        kinds.iter().filter(|k| *k == "Sent").count(),
        1,
        "the premise: it fired once: {:?}",
        kinds
    );
    assert_eq!(
        kinds.iter().filter(|k| *k == "Held").count(),
        1,
        "the first `held` is a transition and says something; the next nine are the same fact \
         again, and they evict the `sent` row: {:?}",
        kinds
    );
    assert_eq!(
        kinds.len(),
        2,
        "and nothing else was written at all: {:?}",
        kinds
    );
}

/// **H-2: `automation:state` is an ARM TRANSITION event** (§7.2), and it fired only from a
/// successful send — so arming, re-arming and every rollback were silent and a row's pill sat on
/// whatever it last painted. Coalesced at ≤ 1/s, because a chatty terminal transitions four times
/// a second per pair.
#[tokio::test(start_paused = true)]
async fn an_arm_transition_emits_state_and_a_repeat_does_not() {
    let (engine, fake, host) = wire(vec![ctx_rule("au-1")]);
    fake.say("pc-1", "ctx:18%\n");

    // Unseen -> Armed is a transition.
    engine.runtime.mark_dirty("pc-1");
    evaluate_tick(&engine, &host, 0, 1_000).await;
    assert_eq!(fake.states.load(Ordering::Relaxed), 1, "arming was silent");

    // Armed -> Fired IS a transition, but it lands 300 ms later and the coalescer holds it.
    fake.say("pc-1", "ctx:63%\n");
    engine.runtime.mark_dirty("pc-1");
    evaluate_tick(&engine, &host, 0, 1_300).await;
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    assert_eq!(fake.states.load(Ordering::Relaxed), 1, "≤ 1/s, per §7.2");

    // Past the second, the held transition is announced — **deferred, not dropped**, which is the
    // whole reason this is a flag the tick drains rather than a "may I emit now?" question. This
    // tick evaluates nothing at all (the settle window runs from the LANDING, so it covers tm-1
    // until 3_300), and
    // the emit still lands.
    fake.say("pc-1", "ctx:18%\n");
    engine.runtime.mark_dirty("pc-1");
    evaluate_tick(&engine, &host, 0, 2_500).await;
    assert_eq!(
        fake.states.load(Ordering::Relaxed),
        2,
        "a refused emit was dropped, not deferred"
    );

    // Out of the settle window: Fired + false is a real transition, so it is announced.
    engine.runtime.mark_dirty("pc-1");
    evaluate_tick(&engine, &host, 0, 9_000).await;
    assert_eq!(
        engine.runtime.arm_state("au-1", "tm-1"),
        ArmState::re_armed()
    );
    assert_eq!(fake.states.load(Ordering::Relaxed), 3);

    // And still 18%: no transition at all now, so nothing to say however long we wait.
    engine.runtime.mark_dirty("pc-1");
    evaluate_tick(&engine, &host, 0, 20_000).await;
    assert_eq!(
        fake.states.load(Ordering::Relaxed),
        3,
        "a repeat is not a transition"
    );
}

/// **H-6: the rule can go away during the queue wait too.** The wait is up to ten seconds; a user
/// who turns a rule off must not still be typed at afterwards. Checked in the same critical section
/// as the terminal, because it is the same question.
#[tokio::test(start_paused = true)]
async fn a_rule_turned_off_while_its_send_waits_never_types() {
    let (engine, fake, host) = wired();
    let send = pending(&engine, &host, "au-1", ArmState::armed(), 1_000);
    engine.complete_rule("au-1");

    run_crossing(engine.clone(), host.clone(), send).await;
    tokio::time::sleep(Duration::from_millis(1_500)).await;

    assert!(fake.written().is_empty(), "{:?}", fake.written());
    let rows = log_rows(&fake.store);
    assert_eq!(rows.len(), 1, "{:?}", rows);
    assert!(rows[0].1.contains("turned off"), "{:?}", rows);
}

/// **H-5: every write is addressed by `pc-`, never by `tm-`** (§7.4).
///
/// The fixture's two ids are deliberately different strings, and the write log threw the id away —
/// so `deliver(.., &tm, ..)` instead of `&pc` passed every send test while addressing a map keyed
/// the other way. In production that is a send that silently goes nowhere.
#[tokio::test(start_paused = true)]
async fn every_write_is_addressed_by_the_process_id() {
    let (engine, fake, host) = wired();
    let send = pending(&engine, &host, "au-1", ArmState::armed(), 1_000);

    run_crossing(engine.clone(), host.clone(), send).await;
    tokio::time::sleep(Duration::from_millis(1_500)).await;

    let ids = fake.written_to();
    assert!(!ids.is_empty(), "the premise: something was written");
    assert!(
        ids.iter().all(|id| id == "pc-1"),
        "a write was addressed by leaf id: {:?}",
        ids
    );
}
