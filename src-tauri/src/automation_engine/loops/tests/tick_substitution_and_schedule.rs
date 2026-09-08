use super::super::*;
use super::open_terminal;
use crate::automation_engine::test_host::*;
use crate::automation_store::{AutomationRule, Finds, Keep};
use chrono::{Datelike, Local, NaiveDate, TimeZone, Weekday};

// =============================================================================================
// §10.5 — the tap
// =============================================================================================

/// Twenty payloads over a channel of four: every id ends up dirty, and the `Lagged` the small
/// channel forces marks every live terminal rather than dropping the window.
#[tokio::test(start_paused = true)]
async fn the_tap_marks_every_terminal_and_recovers_from_a_lagged_window() {
    let fake = Arc::new(
        FakeHost::new()
            .with_terminal("tm-1", "pc-1", "a")
            .with_terminal("tm-2", "pc-2", "b"),
    );
    let host: Arc<dyn EngineHost> = fake.clone();
    let engine = Arc::new(AutomationEngine::new(0));
    let (tx, rx) = tokio::sync::broadcast::channel::<ChannelPayload>(4);

    // Twenty into a channel of four, before the tap has read any of them: the receiver is
    // guaranteed to see `Lagged`, which is the case that must not silently drop terminals.
    for i in 0..20 {
        let _ = tx.send(ChannelPayload {
            id: format!("pc-{}", i % 2 + 1),
            data: vec![b'x'],
        });
    }
    let tap = tokio::spawn(run_tap(engine.clone(), host.clone(), rx));
    tokio::time::sleep(Duration::from_millis(50)).await;

    assert!(engine.runtime.is_dirty("pc-1"), "pc-1 never marked");
    assert!(
        engine.runtime.is_dirty("pc-2"),
        "a lagged window must mark every live terminal"
    );

    engine.stop();
    tokio::time::sleep(Duration::from_millis(BASE_TICK_MS * 3)).await;
    assert!(
        tap.is_finished(),
        "the tap must return once `stopping` is set"
    );
    drop(tx);
}

/// The "never reads `payload.data`" half, source-derived — it is not observable from outside the
/// tap, so a runtime assertion could not make the claim at all.
#[test]
fn the_tap_body_never_reads_the_payload_bytes() {
    let source = strip_comments(include_str!("../../loops.rs"));
    let start = source
        .find("pub async fn run_tap(")
        .expect("run_tap must exist");
    let rest = &source[start..];
    let end = rest
        .find("\n}\n")
        .expect("its body must be closed at column zero");
    let body = &rest[..end];
    assert!(
        !body.contains(".data"),
        "the tap carries a SIGNAL, not data: the parser already has every byte, losslessly"
    );
    assert!(
        body.contains("mark_dirty"),
        "and it must actually mark something"
    );
}

// =============================================================================================
// §10.6b — all three loops
// =============================================================================================

/// **Both halves are required.** "Returns when `stopping` is set" is satisfied completely by a
/// loop body of `return`, which is the one implementation that must not pass — so each loop is
/// first shown doing observable work with the flag clear.
#[tokio::test(start_paused = true)]
async fn all_three_loops_work_first_and_then_return_when_stopping_is_set() {
    let (engine, fake, host) = wired();
    engine.runtime.set_watched("au-1", HashSet::new());
    fake.say("pc-1", "ctx:18%\n");
    let (tx, rx) = tokio::sync::broadcast::channel::<ChannelPayload>(16);

    let tap = tokio::spawn(run_tap(engine.clone(), host.clone(), rx));
    let evaluator = tokio::spawn(run_evaluator(engine.clone(), host.clone()));
    let targeting = tokio::spawn(run_targeting(engine.clone(), host.clone()));

    // The tap does work.
    let _ = tx.send(ChannelPayload {
        id: "pc-1".into(),
        data: vec![b'x'],
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(engine.runtime.is_dirty("pc-1"), "the tap did nothing");

    // The targeting tick does work: it re-resolves `All terminals` and adopts tm-1.
    tokio::time::sleep(Duration::from_millis(TARGETING_TICK_MS)).await;
    assert!(
        engine.runtime.watches("au-1", "tm-1"),
        "the targeting tick did nothing"
    );

    // And the evaluator does work: with a terminal watched and dirty, the pair evaluates.
    tokio::time::sleep(Duration::from_millis(BASE_TICK_MS * 4)).await;
    assert!(
        engine.runtime.last_eval("au-1", "tm-1").is_some(),
        "the evaluator did nothing"
    );

    engine.stop();
    tokio::time::sleep(Duration::from_millis(TARGETING_TICK_MS * 2)).await;
    assert!(tap.is_finished(), "tap");
    assert!(evaluator.is_finished(), "evaluator");
    assert!(targeting.is_finished(), "targeting");
    drop(tx);
}

// =============================================================================================
// The tick, end to end
// =============================================================================================

/// A first sight ARMS and never sends, and the crossing that follows sends exactly once — driven
/// through the real tick, so the arm machine, the depth read, the log and the write are all in
/// the same story rather than three separate ones.
#[tokio::test(start_paused = true)]
async fn a_crossing_sends_once_through_the_real_tick() {
    let (engine, fake, host) = wired();
    engine.runtime.mark_dirty("pc-1");
    fake.say("pc-1", "ctx:18%\n");

    let cursor = evaluate_tick(&engine, &host, 0, 1_000).await;
    assert_eq!(cursor, 0);
    assert!(
        fake.written().is_empty(),
        "a first sight must arm, never type"
    );
    assert_eq!(engine.runtime.arm_state("au-1", "tm-1"), ArmState::armed());
    // Nothing in the log, and that is the verbose gate doing its job: an ordinary check is the
    // outcome of most evaluations and would otherwise write four rows a second per pair.
    assert!(
        log_kinds(&fake.store).is_empty(),
        "an ungated check would flood the log"
    );
    assert!(
        !engine.runtime.is_dirty("pc-1"),
        "the only pair on pc-1 ran, so its flag is spent"
    );

    // The crossing. `dirty` again, and past the 250 ms floor.
    engine.runtime.mark_dirty("pc-1");
    fake.say("pc-1", "ctx:18%\nctx:63%\n");
    evaluate_tick(&engine, &host, cursor, 2_000).await;
    // The send is dispatched off the tick, and route A holds a 500 ms paste-to-submit gap.
    tokio::time::sleep(Duration::from_millis(1_500)).await;

    let writes = fake.written();
    assert!(
        writes
            .iter()
            .any(|w| w.contains("prepare to do context-hand-off")),
        "the message was never typed: {:?}",
        writes
    );
    assert_eq!(engine.runtime.fire_record("au-1", "tm-1"), Some((1, 2_000)));
    assert!(log_kinds(&fake.store).contains(&"Sent".to_string()));

    // §2.6: the needle is recorded against the TERMINAL, and the terminal is settling.
    assert_eq!(
        engine.runtime.echoes_for("tm-1", 2_000),
        vec!["prepare to do context-hand-off".to_string()]
    );
    assert!(engine.runtime.is_settling("tm-1", 2_100));
    // §2.6 layer 2 runs for `ECHO_SETTLE_MS` after the SEND, and the send finishes a
    // paste-to-submit gap after the decision. Measured from `send.at_ms` the window shut early by
    // exactly that gap, and behind a queue of sibling rules on one terminal it shut before the
    // message had even been typed — so the next tick read the rule's own echo as organic output.
    let gap = crate::automation::send::PASTE_SUBMIT_GAP_MS as i64;
    assert!(
        engine
            .runtime
            .is_settling("tm-1", 2_000 + ECHO_SETTLE_MS + 1),
        "the window closed a paste-to-submit gap too early"
    );
    assert!(!engine
        .runtime
        .is_settling("tm-1", 2_000 + gap + ECHO_SETTLE_MS + 1));
}

// =============================================================================================
// §4.2, §4.4 — substitution on the send path
// =============================================================================================

/// The crossing types the RESOLVED message, not the template — `$1`/`$2` swapped for the
/// pattern's own captures. Pre-armed rather than driven through a first-sight tick, so the one
/// `evaluate_tick` call is the crossing itself (`Armed` + true -> `Sent`), the same shape
/// `a_rule_re_arms_when_the_only_thing_left_on_screen_is_its_own_echo` uses to isolate a send.
#[tokio::test(start_paused = true)]
async fn a_crossing_types_the_resolved_message() {
    let (engine, fake, host) = rig_with_rule(|g| {
        g.parse_mut().find = r"FAILED (\d+) tests in (\S+)".into();
        g.cond_mut().finds = Finds::Event;
        g.action_mut().message = "Fix the $1 failing tests in $2".into();
        g.action_mut().substitute = true;
    });
    engine.runtime.set_arm("au-1", "tm-1", ArmState::armed());
    engine.runtime.mark_dirty("pc-1");
    fake.say("pc-1", "FAILED 17 tests in a.ts");

    evaluate_tick(&engine, &host, 0, 1_000).await;
    tokio::time::sleep(Duration::from_millis(1_500)).await;

    assert!(
        fake.written()
            .iter()
            .any(|w| w.contains("Fix the 17 failing tests in a.ts")),
        "the resolved message was never typed: {:?}",
        fake.written()
    );
}

/// **A schedule rule reads nothing, sends nothing, and logs nothing** — plan 032 §6.3, §6.4.
///
/// **Admission is not the property that protects the user.** `reload` admitting a patternless
/// rule (`a_schedule_rule_with_no_pattern_is_admitted`) is equally true of one whose absent
/// pattern was defaulted to `""` on the way in — and an empty regex matches every position of
/// every string, so THAT rule fires on the first byte any watched terminal prints and types
/// into a live agent. This is the test that tells the two apart, so it is deliberately run
/// against a terminal that HAS produced output and is marked dirty: every gate upstream of the
/// pattern is open, and the only thing standing between this rule and a send is that it has no
/// pattern to match with.
///
/// Eight ticks rather than one, so a rule that needs a second sight to cross cannot pass by
/// never getting one. The arm state is left `Unseen` on purpose: nothing may move it, which is
/// the third assertion.
///
/// Task 22 adds the branch that actually fires such a rule at its scheduled minute. Until then
/// "never" is the whole specification, and after it this test still holds for every minute that
/// is not the scheduled one.
#[tokio::test(start_paused = true)]
async fn a_schedule_rule_reads_nothing_sends_nothing_and_logs_nothing() {
    let (engine, fake, host) = wire(vec![schedule_only_rule("au-sched")]);
    assert_eq!(
        engine.snapshot_live().len(),
        1,
        "premise: the rule IS live and IS walked"
    );

    fake.say(
        "pc-1",
        "ctx:99% FAILED 3 tests
",
    );
    // **What `wire` already wrote, before the ticks run.** `wire` reloads at epoch 0 and §7's
    // seeding writes one `held` row for a schedule whose minute is already past *in the
    // runner's own zone* — 19:00 the previous evening west of UTC, midnight on it. So an
    // `is_empty()` oracle here asserts the runner's time zone, not the tick's behaviour. The
    // question this test asks is whether THE TICK logs, and a delta answers it in every zone.
    let before = log_rows(&fake.store);
    for tick in 0..8 {
        engine.runtime.mark_dirty("pc-1");
        evaluate_tick(&engine, &host, 0, 1_000 + tick * 250).await;
    }
    tokio::time::sleep(Duration::from_millis(1_500)).await;

    assert!(
        fake.written().is_empty(),
        "a rule with no pattern typed something: {:?}",
        fake.written()
    );
    assert_eq!(
        log_rows(&fake.store),
        before,
        "the tick wrote a log row: {:?}",
        log_rows(&fake.store)
    );
    assert_eq!(
        engine.runtime.arm_state("au-sched", "tm-1"),
        ArmState::Unseen,
        "nothing was read, so nothing may be spent — the arm state must not have moved"
    );
    assert_eq!(
        engine.runtime.last_eval("au-sched", "tm-1"),
        None,
        "and `set_last_eval` must not have run either"
    );
}

/// The paired positive, and the reason the test above is not vacuous.
///
/// Everything in this rig — the dirty flag, the watched set, the tick, the terminal's text —
/// is identical; only the pattern is present. If the rig itself were broken, this would be
/// silent too, and "sends nothing" would prove nothing at all.
#[tokio::test(start_paused = true)]
async fn the_same_rig_with_a_pattern_does_send() {
    let (engine, fake, host) = rig_with_rule(|g| {
        g.parse_mut().find = "FAILED".into();
        g.parse_mut().keep = Keep::Whole;
        g.cond_mut().finds = Finds::Event;
        g.action_mut().message = "stand-up notes?".into();
    });
    engine.runtime.set_arm("au-1", "tm-1", ArmState::armed());

    fake.say(
        "pc-1",
        "ctx:99% FAILED 3 tests
",
    );
    for tick in 0..8 {
        engine.runtime.mark_dirty("pc-1");
        evaluate_tick(&engine, &host, 0, 1_000 + tick * 250).await;
    }
    tokio::time::sleep(Duration::from_millis(1_500)).await;

    assert!(
        fake.written().iter().any(|w| w.contains("stand-up notes?")),
        "the rig cannot send at all, so the schedule rule's silence proves nothing: {:?}",
        fake.written()
    );
}

// =============================================================================================
// 6.3 — the schedule dispatch branch (task 22)
// =============================================================================================

/// The tick's `now_ms` for a given LOCAL wall-clock minute, with the weekday asserted.
///
/// **Built FROM local time, never a hard-coded epoch.** `evaluate_tick` converts `now_ms`
/// through `schedule::local_now`, which asks the machine's own zone — so a fixed timestamp is
/// 09:00 on one runner and 04:00 on another, and *"the tick crosses the minute"* would be a
/// claim about where the test happened to run. Going the other way pins the WALL CLOCK, which is
/// the only thing a schedule is written in. The weekday is asserted here for the same reason
/// `schedule.rs`'s own `day()` helper asserts it: a test that says "Monday" must not quietly be
/// about a Saturday, which the mask would refuse.
///
/// `.earliest()` is the fall-back hour's answer and is never exercised: a September morning is
/// not a skipped or repeated hour in any zone, so `None` here would mean a broken date.
fn at_local(y: i32, m: u32, d: u32, weekday: Weekday, hour: u32, minute: u32) -> i64 {
    let date = NaiveDate::from_ymd_opt(y, m, d).expect("a real date");
    assert_eq!(date.weekday(), weekday, "{date} is not a {weekday:?}");
    Local
        .from_local_datetime(&date.and_hms_opt(hour, minute, 0).expect("a real time"))
        .earliest()
        .expect("a local instant that exists")
        .timestamp_millis()
}

/// The local ordinal `at_local`'s day maps to — `last_fired_day`'s key.
fn day_ordinal(y: i32, m: u32, d: u32) -> i32 {
    NaiveDate::from_ymd_opt(y, m, d)
        .expect("a real date")
        .num_days_from_ce()
}

/// A rig with several terminals and each rule's watched set given explicitly.
///
/// `wire` mints exactly ONE terminal and points every rule at it, and that is precisely the
/// fixture a schedule rule can pass while broken: ask `schedule_due` per leaf, or mark the day on
/// the first one, and target one still fires. The standing lesson — *a fixture that varies only
/// the rule dimension cannot test a key with two* — at its fifth site.
///
/// The rules go through `reload`, like `wire`'s, so a fixture cannot run a rule the real load
/// path would have refused. `reload` also seeds `last_fired_day` from the epoch's local day,
/// which is a different day from any tick below and therefore never the reason one fires.
fn wire_targets(
    rules: Vec<AutomationRule>,
    terminals: &[(&str, &str)],
    watched: &[(&str, &[&str])],
) -> (Arc<AutomationEngine>, Arc<FakeHost>, Arc<dyn EngineHost>) {
    wire_targets_planted(rules, terminals, watched, false)
}

/// `wire_targets`, planting with `save_rule_bypassing_the_enable_gate_for_tests`.
///
/// For the one rule shape §7.8's enable gate now refuses to CREATE enabled: a monitor and a
/// `DailyAt` schedule together, which `timer.scheduleWithMonitor` blocks because the schedule
/// path silences the monitor for the whole rule. The row is still real rather than hypothetical
/// — a build older than that validation could enable one, and `reload` does not re-run the
/// check (its exemption is scoped to `parse.*`, on purpose) — and what it does when it gets here
/// is exactly what the two tests below pin. Same reason
/// `wire_bypassing_the_enable_gate` exists one module over for `action.unknownToken`.
fn wire_targets_bypassing_the_enable_gate(
    rules: Vec<AutomationRule>,
    terminals: &[(&str, &str)],
    watched: &[(&str, &[&str])],
) -> (Arc<AutomationEngine>, Arc<FakeHost>, Arc<dyn EngineHost>) {
    wire_targets_planted(rules, terminals, watched, true)
}

fn wire_targets_planted(
    rules: Vec<AutomationRule>,
    terminals: &[(&str, &str)],
    watched: &[(&str, &[&str])],
    bypass_enable_gate: bool,
) -> (Arc<AutomationEngine>, Arc<FakeHost>, Arc<dyn EngineHost>) {
    let fake = Arc::new(FakeHost::new());
    for (tm, pc) in terminals {
        open_terminal(&fake, tm, pc, tm);
    }
    for rule in &rules {
        if bypass_enable_gate {
            fake.store
                .save_rule_bypassing_the_enable_gate_for_tests(rule)
                .unwrap();
        } else {
            fake.store.save_rule(rule).unwrap();
        }
    }
    let engine = Arc::new(AutomationEngine::new(0));
    engine.reload(&fake.store, 0).unwrap();
    for (id, leaves) in watched {
        engine
            .runtime
            .set_watched(id, leaves.iter().map(|tm| tm.to_string()).collect());
    }
    let host: Arc<dyn EngineHost> = fake.clone();
    (engine, fake, host)
}

/// **A schedule rule sends to EVERY target when the minute arrives, and reads no screen** —
/// plan 032 6.3, task 22's own gate.
///
/// **Three targets, not one, and that is the whole point.** `last_fired_day` is keyed by the
/// RULE, so the question and the mark are rule-level while the sends are per leaf: ask once
/// before the leaves, push per leaf, mark after them. Asking per leaf, or marking on the first
/// one, fires target one and starves two and three — silently, because nothing in the engine
/// records a target it skipped, and no single-target fixture can see it.
///
/// **`au-read` is what makes the no-screen-read assertion mean anything.** An empty `tailed()`
/// is satisfied completely by a recorder that never records; a sibling rule reading its own
/// terminal in the same run puts exactly one entry in the list, so one assertion proves both
/// that the schedule rule read nothing and that a read would have shown up.
#[tokio::test(start_paused = true)]
async fn a_schedule_rule_sends_to_every_target_when_the_minute_arrives_and_reads_nothing() {
    let (engine, fake, host) = wire_targets(
        vec![
            schedule_only_rule("au-sched"),
            ctx_rule_saying("au-read", "a reader", 2),
        ],
        &[
            ("tm-1", "pc-1"),
            ("tm-2", "pc-2"),
            ("tm-3", "pc-3"),
            ("tm-4", "pc-4"),
        ],
        &[
            ("au-sched", &["tm-1", "tm-2", "tm-3"]),
            ("au-read", &["tm-4"]),
        ],
    );
    // The reader has output and sits below its threshold, so it reads, arms, and sends nothing.
    fake.say("pc-4", "ctx:5%\n");
    engine.runtime.mark_dirty("pc-4");

    evaluate_tick(&engine, &host, 0, at_local(2026, 9, 7, Weekday::Mon, 9, 0)).await;
    tokio::time::sleep(Duration::from_millis(2_000)).await;

    assert_eq!(
        sent_to(&fake, "stand-up notes?"),
        vec!["pc-1", "pc-2", "pc-3"],
        "every watched target gets the scheduled message, exactly once: {:?}",
        fake.written()
    );
    assert_eq!(
        fake.tailed(),
        vec!["pc-4"],
        "a schedule rule reads NO screen — and the reader proves a read would have been recorded"
    );
    let mut sent: Vec<String> = log_rows(&fake.store)
        .into_iter()
        .filter(|(kind, _, _)| kind == "Sent")
        .map(|(_, detail, _)| detail)
        .collect();
    sent.sort();
    assert_eq!(sent, vec!["sent to tm-1", "sent to tm-2", "sent to tm-3"]);

    // 6.3: a schedule rule has no arm state and must not disturb one.
    for tm in ["tm-1", "tm-2", "tm-3"] {
        assert_eq!(
            engine.runtime.arm_state("au-sched", tm),
            ArmState::Unseen,
            "{tm} armed"
        );
        assert_eq!(
            engine.runtime.last_eval("au-sched", tm),
            None,
            "{tm} was evaluated"
        );
    }
    assert_eq!(
        engine.runtime.last_fired_day("au-sched"),
        Some(day_ordinal(2026, 9, 7)),
        "the day is marked once the leaves are done"
    );
}

/// **Once a day.** The same minute again, and hours later the same day, send nothing more.
///
/// The third tick is not decoration: `run_send` opens an `ECHO_SETTLE_MS` settle window on every
/// terminal it writes to, so a second tick inside that window is refused by the settle gate
/// whether or not `schedule_due` was ever asked. Five hours later that window is long gone and
/// the only thing standing between the rule and a second message is `last_fired_day`.
#[tokio::test(start_paused = true)]
async fn a_schedule_rule_fires_once_a_day_and_not_again() {
    let (engine, fake, host) = wire_targets(
        vec![schedule_only_rule("au-sched")],
        &[("tm-1", "pc-1"), ("tm-2", "pc-2")],
        &[("au-sched", &["tm-1", "tm-2"])],
    );
    let nine = at_local(2026, 9, 7, Weekday::Mon, 9, 0);

    evaluate_tick(&engine, &host, 0, nine).await;
    tokio::time::sleep(Duration::from_millis(2_000)).await;
    assert_eq!(
        sent_to(&fake, "stand-up notes?"),
        vec!["pc-1", "pc-2"],
        "premise: it fired at all"
    );

    evaluate_tick(&engine, &host, 0, nine + BASE_TICK_MS as i64).await;
    evaluate_tick(&engine, &host, 0, at_local(2026, 9, 7, Weekday::Mon, 14, 0)).await;
    tokio::time::sleep(Duration::from_millis(2_000)).await;

    assert_eq!(
        times_sent(&fake, "stand-up notes?"),
        2,
        "a schedule fires once a day, not once a tick: {:?}",
        fake.written()
    );
}

/// **A dormant target does not stop the schedule reaching its siblings** (4.5).
///
/// `tm-2` resolves to no process at all and sorts BETWEEN its two siblings, so a branch that
/// gave up on the rule at the first unreachable leaf — or that marked the day there — would
/// leave `tm-3` out while `tm-1` looked perfectly healthy.
#[tokio::test(start_paused = true)]
async fn a_dormant_target_does_not_stop_the_schedule_reaching_its_siblings() {
    let (engine, fake, host) = wire_targets(
        vec![schedule_only_rule("au-sched")],
        &[("tm-1", "pc-1"), ("tm-3", "pc-3")],
        &[("au-sched", &["tm-1", "tm-2", "tm-3"])],
    );
    assert!(
        host.process_for_leaf("tm-2").is_none(),
        "premise: tm-2 is dormant"
    );

    evaluate_tick(&engine, &host, 0, at_local(2026, 9, 7, Weekday::Mon, 9, 0)).await;
    tokio::time::sleep(Duration::from_millis(2_000)).await;

    assert_eq!(
        sent_to(&fake, "stand-up notes?"),
        vec!["pc-1", "pc-3"],
        "a leaf with no process skips itself and nothing else: {:?}",
        fake.written()
    );
}

/// **The day is marked even when not one target was reachable** — and that is a ruling, not a
/// side effect.
///
/// A 09:00 rule whose terminals are all asleep at 09:00 sends nothing, and must not then deliver
/// its prompt to the first one that wakes at 14:00. Marking only when a send was actually pushed
/// is nagging on arrival, per terminal — the behaviour plan 028 Q3 ruled against for arm state
/// and which 6.3's launch seeding exists to prevent for exactly this rule kind.
///
/// The cost is the opposite edge: an app started at 08:59:59 whose leaves are not indexed by
/// 09:00 silently skips that day. A prompt typed late into a live agent is judged the worse of
/// the two.
///
/// **This is also the test that kills a day mark written inside the leaves loop.** With the
/// predicate asked once per rule, a per-leaf mark starves nobody in the same tick — but a rule
/// with no reachable leaf never reaches it at all, so the day is never spent and the rule fires
/// on arrival. The next-day tick is here so "does not fire" cannot be satisfied by a rule that
/// was killed outright.
#[tokio::test(start_paused = true)]
async fn a_schedule_whose_targets_were_all_asleep_does_not_nag_the_first_one_to_wake() {
    let (engine, fake, host) = wire_targets(
        vec![schedule_only_rule("au-sched")],
        &[],
        &[("au-sched", &["tm-1"])],
    );
    assert!(
        host.process_for_leaf("tm-1").is_none(),
        "premise: nothing is awake"
    );

    evaluate_tick(&engine, &host, 0, at_local(2026, 9, 7, Weekday::Mon, 9, 0)).await;
    tokio::time::sleep(Duration::from_millis(2_000)).await;
    assert_eq!(
        engine.runtime.last_fired_day("au-sched"),
        Some(day_ordinal(2026, 9, 7)),
        "the rule's turn for today passed, with nobody there to send to"
    );

    // The terminal wakes five hours later. Today is spent.
    open_terminal(&fake, "tm-1", "pc-1", "tm-1");
    evaluate_tick(&engine, &host, 0, at_local(2026, 9, 7, Weekday::Mon, 14, 0)).await;
    tokio::time::sleep(Duration::from_millis(2_000)).await;
    assert!(
        fake.written().is_empty(),
        "a 09:00 prompt was delivered at 14:00 because a terminal turned up: {:?}",
        fake.written()
    );

    // Tomorrow is not spent.
    evaluate_tick(&engine, &host, 0, at_local(2026, 9, 8, Weekday::Tue, 9, 0)).await;
    tokio::time::sleep(Duration::from_millis(2_000)).await;
    assert_eq!(
        sent_to(&fake, "stand-up notes?"),
        vec!["pc-1"],
        "a skipped day must not retire the rule: {:?}",
        fake.written()
    );
}

/// **A lid that opens at 10:00 must behave like an app STARTED at 10:00** — the wake path
/// `reload` never had.
///
/// `reload` seeds `last_fired_day` for a schedule whose minute has already gone by, and it runs
/// at spawn and from `reload_after_commit` and nowhere else. So a machine that slept at 18:00
/// on Monday and woke at 10:00 on Tuesday came back with MONDAY's mark against a Tuesday `now`,
/// and `10:00 >= 09:00` typed the stand-up prompt into a live agent an hour late — every
/// morning. A cold start at 10:00 was suppressed and a lid-open at 10:00 was not, which is one
/// situation with two answers.
///
/// The second tick is not decoration: it says the day was SPENT rather than merely deferred
/// past the wake, which is the difference between the seeding and a one-tick suppression. The
/// third says the rule is not retired — Wednesday still fires, driven by an ordinary 250 ms
/// step so the gap detector is not what is being asked.
#[tokio::test(start_paused = true)]
async fn a_schedule_missed_while_the_machine_slept_does_not_fire_on_wake() {
    let (engine, fake, host) = wire_targets(
        vec![schedule_only_rule("au-sched")],
        &[("tm-1", "pc-1")],
        &[("au-sched", &["tm-1"])],
    );
    let slept_at = at_local(2026, 9, 7, Weekday::Mon, 18, 0);
    let woke_at = at_local(2026, 9, 8, Weekday::Tue, 10, 0);

    evaluator_step(&engine, &host, 0, Some(slept_at), woke_at).await;
    tokio::time::sleep(Duration::from_millis(2_000)).await;

    assert!(
        fake.written().is_empty(),
        "the 09:00 prompt was typed into a live agent at 10:00 on the lid opening: {:?}",
        fake.written()
    );
    assert_eq!(
        engine.runtime.last_fired_day("au-sched"),
        Some(day_ordinal(2026, 9, 8)),
        "the wake spends today, exactly as a cold start at 10:00 would"
    );

    // Still spent four hours later — the day was marked, not the tick skipped.
    let tuesday_afternoon = at_local(2026, 9, 8, Weekday::Tue, 14, 0);
    evaluator_step(&engine, &host, 0, Some(woke_at), tuesday_afternoon).await;
    tokio::time::sleep(Duration::from_millis(2_000)).await;
    assert!(
        fake.written().is_empty(),
        "delivered later the same day: {:?}",
        fake.written()
    );

    // Wednesday, with the app genuinely awake across the minute.
    let wednesday = at_local(2026, 9, 9, Weekday::Wed, 9, 0);
    evaluator_step(
        &engine,
        &host,
        0,
        Some(wednesday - BASE_TICK_MS as i64),
        wednesday,
    )
    .await;
    tokio::time::sleep(Duration::from_millis(2_000)).await;
    assert_eq!(
        sent_to(&fake, "stand-up notes?"),
        vec!["pc-1"],
        "a suppressed morning must not retire the rule: {:?}",
        fake.written()
    );
}

/// **A morning the wake spent must say so in the log** (§7), and the activity event must carry
/// it.
///
/// The suppression itself is right and it is completely silent: the user set a 09:00 reminder,
/// the lid was shut at 09:00, and the only trace of the decision was a `DashMap` entry. The row
/// is the only thing that can answer *"why didn't it run?"*.
///
/// **`emit_activity`, not `emit_state`.** Nothing about a suppressed schedule moves an arm
/// state, so the state event this loop already sends at the end of `evaluate_tick` cannot carry
/// it — a window would repaint identical pills and never refetch the log.
///
/// The negative half is the same assertion the sibling test above makes about firing: an
/// ordinary 250 ms step across 09:00 must produce a SEND and no suppression row, because it was
/// not a wake.
#[tokio::test(start_paused = true)]
async fn a_morning_the_wake_spent_is_written_to_the_log() {
    let (engine, fake, host) = wire_targets(
        vec![schedule_only_rule("au-sched")],
        &[("tm-1", "pc-1")],
        &[("au-sched", &["tm-1"])],
    );
    let slept_at = at_local(2026, 9, 7, Weekday::Mon, 18, 0);
    let woke_at = at_local(2026, 9, 8, Weekday::Tue, 10, 0);
    // `wire` reloads at epoch 0, whose LOCAL time is past 09:00 west of UTC and not on it, so
    // what it left behind is the runner's time zone rather than this test's premise.
    let before = log_rows(&fake.store).len();
    let emits_before = fake.activity.load(std::sync::atomic::Ordering::Relaxed);

    evaluator_step(&engine, &host, 0, Some(slept_at), woke_at).await;
    tokio::time::sleep(Duration::from_millis(2_000)).await;

    let rows: Vec<_> = log_rows(&fake.store).split_off(before);
    assert_eq!(
        rows.len(),
        1,
        "the wake spent Tuesday and said nothing: {rows:?}"
    );
    assert_eq!(rows[0].0, "Held", "{rows:?}");
    assert_eq!(
        rows[0].1,
        "09:00 went by while nothing was watching the clock, so today's run was skipped",
        "{rows:?}"
    );
    assert_eq!(
        rows[0].2, None,
        "a schedule's suppression names no terminal: {rows:?}"
    );
    assert!(
        fake.activity.load(std::sync::atomic::Ordering::Relaxed) > emits_before,
        "the row was written and no window was told to refetch the log"
    );

    // Four hours later, still the same spent day: the bound is one row per suppression.
    let tuesday_afternoon = at_local(2026, 9, 8, Weekday::Tue, 14, 0);
    evaluator_step(&engine, &host, 0, Some(woke_at), tuesday_afternoon).await;
    tokio::time::sleep(Duration::from_millis(2_000)).await;
    assert_eq!(
        log_rows(&fake.store).len(),
        before + 1,
        "a second wake on a day already spent wrote it up again: {:?}",
        log_rows(&fake.store)
    );
}

/// **A schedule that FIRES writes no suppression row**, which is the half that stops the row
/// becoming a lie.
///
/// The gate is `schedule_due` against the mark as it stands, and `evaluate_tick` marks the day
/// *after* the leaves — so a tick that sends and a wake that suppresses both leave
/// `last_fired_day` at today, and only one of them may have written a row. Asserting the send
/// alone cannot see a spurious row; asserting the row count alone cannot see a lost send.
#[tokio::test(start_paused = true)]
async fn a_schedule_that_fires_on_the_tick_writes_no_suppression_row() {
    let (engine, fake, host) = wire_targets(
        vec![schedule_only_rule("au-sched")],
        &[("tm-1", "pc-1")],
        &[("au-sched", &["tm-1"])],
    );
    let nine = at_local(2026, 9, 7, Weekday::Mon, 9, 0);
    let before = log_rows(&fake.store).len();

    evaluator_step(&engine, &host, 0, Some(nine - BASE_TICK_MS as i64), nine).await;
    tokio::time::sleep(Duration::from_millis(2_000)).await;

    assert_eq!(
        sent_to(&fake, "stand-up notes?"),
        vec!["pc-1"],
        "{:?}",
        fake.written()
    );
    let rows: Vec<_> = log_rows(&fake.store).split_off(before);
    assert!(
        rows.iter().all(|(kind, _, _)| kind != "Held"),
        "a rule that fired was also told it had missed its minute: {rows:?}"
    );
}

/// **A resume that lands ON the target minute fires it — it has not been missed, it is due.**
///
/// `seed_missed_schedules` was handed only `now`, and `target_already_past` compares at MINUTE
/// granularity, so it could not tell how far into the unobserved gap the target fell. Suspend at
/// 08:58:50, resume at 09:00:00: the gap is 70 s, over `RESUME_GAP_MS`, `540 >= 540` marked the
/// day and wrote a `Held` row, and the walk in the very same step then read `fires_now = false`.
/// The 09:00 reminder was suppressed at the exact instant it was due, and the lateness can be
/// arbitrarily close to zero. `prev_tick_ms` is the value that answers it, and it was in scope at
/// the call site all along.
///
/// **Both halves are asserted.** The send alone cannot see a spurious row, and the row count
/// alone cannot see a lost send — the same pairing
/// `a_schedule_that_fires_on_the_tick_writes_no_suppression_row` makes for the ordinary tick.
#[tokio::test(start_paused = true)]
async fn a_resume_landing_on_the_target_minute_fires_rather_than_spending_the_day() {
    let (engine, fake, host) = wire_targets(
        vec![schedule_only_rule("au-sched")],
        &[("tm-1", "pc-1")],
        &[("au-sched", &["tm-1"])],
    );
    // `wire` reloads at epoch 0, whose LOCAL day may already be past 09:00 west of UTC.
    let before = log_rows(&fake.store).len();
    let slept_at = at_local(2026, 9, 7, Weekday::Mon, 8, 58) + 50_000;
    let woke_at = at_local(2026, 9, 7, Weekday::Mon, 9, 0);
    assert!(
        woke_at - slept_at > RESUME_GAP_MS,
        "premise: 70 s is a resume and not a slow tick, so the seeding branch is entered"
    );

    evaluator_step(&engine, &host, 0, Some(slept_at), woke_at).await;
    tokio::time::sleep(Duration::from_millis(2_000)).await;

    assert_eq!(
        sent_to(&fake, "stand-up notes?"),
        vec!["pc-1"],
        "the 09:00 reminder was suppressed at the instant it came due: {:?}",
        fake.written()
    );
    let rows: Vec<_> = log_rows(&fake.store).split_off(before);
    assert!(
        rows.iter().all(|(kind, _, _)| kind != "Held"),
        "a minute that had only just arrived was written up as gone by: {rows:?}"
    );
    assert_eq!(
        engine.runtime.last_fired_day("au-sched"),
        Some(day_ordinal(2026, 9, 7)),
        "premise: it is the SEND that marked the day, not the seed"
    );
}

/// **An ordinary tick does not re-seed, and this is the half that stops the fix eating the
/// feature.**
///
/// The gap check is what makes the re-seed conditional; run unconditionally it would mark every
/// schedule the instant its minute arrived — `target_already_past` is `now >= target`, the same
/// comparison `schedule_due` makes — and no schedule would ever fire again, on any machine, with
/// nothing in the log to say why. One 250 ms step across 09:00 is the whole assertion.
#[tokio::test(start_paused = true)]
async fn a_schedule_whose_minute_arrives_while_the_app_is_running_still_fires() {
    let (engine, fake, host) = wire_targets(
        vec![schedule_only_rule("au-sched")],
        &[("tm-1", "pc-1")],
        &[("au-sched", &["tm-1"])],
    );
    let nine = at_local(2026, 9, 7, Weekday::Mon, 9, 0);

    evaluator_step(&engine, &host, 0, Some(nine - BASE_TICK_MS as i64), nine).await;
    tokio::time::sleep(Duration::from_millis(2_000)).await;

    assert_eq!(
        sent_to(&fake, "stand-up notes?"),
        vec!["pc-1"],
        "a quarter-second tick was read as a resume and spent the day: {:?}",
        fake.written()
    );
    assert_eq!(
        engine.runtime.last_fired_day("au-sched"),
        Some(day_ordinal(2026, 9, 7)),
        "premise: it is the SEND that marked the day, not a re-seed"
    );
}

/// **A target inside another rule's settle window still gets the scheduled message.**
///
/// 2.6 layer 2 means *nothing READS this terminal*, and a schedule send reads nothing — the same
/// reason 6.2's parked drain sits above the same gate. Below it, a terminal that happened to be
/// inside another rule's `ECHO_SETTLE_MS` window at 09:00 would be skipped, and because the day is
/// marked whether or not a leaf was reachable, skipped for the whole day. Moving the branch under
/// the gate leaves every other test in this file green, which is why this one exists.
#[tokio::test(start_paused = true)]
async fn a_settling_target_still_receives_the_scheduled_message() {
    let (engine, fake, host) = wire_targets(
        vec![schedule_only_rule("au-sched")],
        &[("tm-1", "pc-1"), ("tm-2", "pc-2")],
        &[("au-sched", &["tm-1", "tm-2"])],
    );
    let nine = at_local(2026, 9, 7, Weekday::Mon, 9, 0);
    // Something else wrote into tm-2 a moment ago, so no reader may touch it.
    engine.runtime.settle_until("tm-2", nine + ECHO_SETTLE_MS);

    evaluate_tick(&engine, &host, 0, nine).await;
    tokio::time::sleep(Duration::from_millis(2_000)).await;

    assert_eq!(
        sent_to(&fake, "stand-up notes?"),
        vec!["pc-1", "pc-2"],
        "a settle window keeps readers out, not writers: {:?}",
        fake.written()
    );
}

/// **`prev` and `label` on the schedule route**, which are the two `PendingSend` fields 6.3
/// gives no obvious answer for.
///
/// `prev` is what `run_send`'s three failure paths roll the arm state back to, and a schedule
/// crossing has none to roll back to — so it is READ from the pair rather than assumed, which
/// makes `restore_arm` write back the value it just read. A constant `ArmState::Unseen` is a
/// harmless no-op for a rule with no monitor and destroys the arm state of a rule that has both,
/// which is why the fixture here is the hybrid — planted past the enable gate, which
/// `timer.scheduleWithMonitor` now closes against creating one, for the reason
/// `wire_targets_bypassing_the_enable_gate` gives.
///
/// `label` is resolved at DECIDE time for 2.8's reason: this row is written after the terminal is
/// gone, and a lookup at write time returns `None` for exactly the line the Name column serves.
#[tokio::test(start_paused = true)]
async fn a_failed_schedule_send_rolls_back_to_what_was_there_and_still_names_the_terminal() {
    let mut hybrid = ctx_rule_saying("au-both", "stand-up notes?", 1);
    hybrid.graph.timer = Some(TimerStep {
        mode: TimerMode::DailyAt {
            minute_of_day: 9 * 60,
            days: 0b0001_1111,
        },
    });
    let (engine, fake, host) = wire_targets_bypassing_the_enable_gate(
        vec![hybrid],
        &[("tm-1", "pc-1")],
        &[("au-both", &["tm-1"])],
    );
    engine
        .runtime
        .set_arm("au-both", "tm-1", ArmState::Fired { at_ms: 5 });
    // `wire`'s own reload may have written §7's suppression row already, depending on the
    // runner's zone — see `a_schedule_rule_reads_nothing_sends_nothing_and_logs_nothing`. The
    // rows this test is about are the ones the tick adds.
    let before = log_rows(&fake.store).len();

    // Decided while the terminal is open; it closes before the spawned send takes its turn.
    evaluate_tick(&engine, &host, 0, at_local(2026, 9, 7, Weekday::Mon, 9, 0)).await;
    fake.close("tm-1");
    tokio::time::sleep(Duration::from_millis(2_000)).await;

    assert!(
        fake.written().is_empty(),
        "{:?} reached a closed terminal",
        fake.written()
    );
    assert_eq!(
        engine.runtime.arm_state("au-both", "tm-1"),
        ArmState::Fired { at_ms: 5 },
        "the rollback wrote something other than what the decision found"
    );
    let rows: Vec<_> = log_rows(&fake.store).split_off(before);
    assert_eq!(rows.len(), 1, "exactly one row: {rows:?}");
    assert_eq!(rows[0].0, "Failed", "{rows:?}");
    assert!(
        rows[0]
            .1
            .contains("the terminal closed before the message was sent"),
        "{rows:?}"
    );
    assert_eq!(
        rows[0].2.as_deref(),
        Some("tm-1"),
        "the name must be the one resolved at decide time: {rows:?}"
    );
}

/// **R6 binds a schedule rule too.** The one `sends.push` in this module lives inside `admit`,
/// which is what applies the single-run claim; a schedule branch that pushed directly would opt
/// the whole rule kind out of `runs_once`, exactly as 6.2's parked route once did.
///
/// Two targets, because the claim is per RULE and a one-terminal fixture cannot tell a per-rule
/// claim from a per-pair one.
#[tokio::test(start_paused = true)]
async fn a_runs_once_schedule_rule_sends_once_across_every_target() {
    let mut once = schedule_only_rule("au-once");
    once.runs_once = true;
    let (engine, fake, host) = wire_targets(
        vec![once],
        &[("tm-1", "pc-1"), ("tm-2", "pc-2")],
        &[("au-once", &["tm-1", "tm-2"])],
    );

    evaluate_tick(&engine, &host, 0, at_local(2026, 9, 7, Weekday::Mon, 9, 0)).await;
    tokio::time::sleep(Duration::from_millis(2_000)).await;

    assert_eq!(
        times_sent(&fake, "stand-up notes?"),
        1,
        "a runs-once schedule typed into every target it watches: {:?}",
        fake.written()
    );
    assert!(!engine.is_live("au-once"), "and it never completed");
}

/// **The TIMER decides the path, not the absence of a monitor** — 6.3: *"a rule whose Timer is
/// in schedule mode takes a new evaluation path that never reads a screen"*.
///
/// **The editor now refuses to CREATE this row enabled, and the engine still has to run it.**
/// This comment used to say *"nothing forbids a rule from carrying both"*, which stopped being
/// true when `timer.scheduleWithMonitor` landed: 6.3's own note says the silencing "is a
/// consequence a user cannot see, so it is backed by a blocking validation problem". That is a
/// gate on the WRITE, not a proof the row cannot exist — a build older than the validation
/// could enable one, and `reload` does not re-check it (its exemption is scoped to `parse.*`).
/// Hence the bypassing rig. Gating the branch on `monitor.is_none()` instead would leave such a
/// row reading the window four times a second and firing on a crossing as well as on the clock
/// — two messages from one rule, on a path 6.3 says reads nothing.
///
/// Both halves are needed. At 08:00 the monitor would cross (armed, dirty, over the threshold)
/// and must not; at 09:00 the schedule fires and still nothing is read. `au-read` is the live
/// control on both ticks.
#[tokio::test(start_paused = true)]
async fn a_schedule_rule_that_also_has_a_monitor_reads_nothing_and_fires_on_the_clock() {
    let mut hybrid = ctx_rule_saying("au-both", "stand-up notes?", 1);
    hybrid.graph.timer = Some(TimerStep {
        mode: TimerMode::DailyAt {
            minute_of_day: 9 * 60,
            days: 0b0001_1111,
        },
    });
    let (engine, fake, host) = wire_targets_bypassing_the_enable_gate(
        vec![hybrid, ctx_rule_saying("au-read", "a reader", 2)],
        &[("tm-1", "pc-1"), ("tm-4", "pc-4")],
        &[("au-both", &["tm-1"]), ("au-read", &["tm-4"])],
    );
    // Everything the monitor path needs, so its silence is a refusal and not a missing input.
    engine.runtime.set_arm("au-both", "tm-1", ArmState::armed());
    fake.say("pc-1", "ctx:63%\n");
    fake.say("pc-4", "ctx:5%\n");
    engine.runtime.mark_dirty("pc-1");
    engine.runtime.mark_dirty("pc-4");

    evaluate_tick(&engine, &host, 0, at_local(2026, 9, 7, Weekday::Mon, 8, 0)).await;
    tokio::time::sleep(Duration::from_millis(2_000)).await;
    assert!(
        fake.written().is_empty(),
        "the monitor crossed on a rule the clock has not reached: {:?}",
        fake.written()
    );
    assert_eq!(
        fake.tailed(),
        vec!["pc-4"],
        "and the control read a window to prove it could"
    );

    engine.runtime.mark_dirty("pc-1");
    engine.runtime.mark_dirty("pc-4");
    evaluate_tick(&engine, &host, 0, at_local(2026, 9, 7, Weekday::Mon, 9, 0)).await;
    tokio::time::sleep(Duration::from_millis(2_000)).await;

    assert_eq!(
        sent_to(&fake, "stand-up notes?"),
        vec!["pc-1"],
        "the clock came and the rule did not fire: {:?}",
        fake.written()
    );
    assert_eq!(
        fake.tailed(),
        vec!["pc-4", "pc-4"],
        "only the control read a screen, on either tick"
    );
    assert_eq!(
        engine.runtime.arm_state("au-both", "tm-1"),
        ArmState::armed(),
        "the schedule path must not move an arm state it does not own"
    );
}

/// The regression this flag exists to prevent: `substitute: false` (the default) sends the
/// message byte for byte, `$` and all, even though it is syntactically full of tokens.
#[tokio::test(start_paused = true)]
async fn substitution_off_types_the_message_verbatim() {
    let (engine, fake, host) = rig_with_rule(|g| {
        g.parse_mut().find = r"FAILED (\d+)".into();
        g.cond_mut().finds = Finds::Event;
        g.action_mut().message = "awk '{print $1}'".into();
        g.action_mut().substitute = false;
    });
    engine.runtime.set_arm("au-1", "tm-1", ArmState::armed());
    engine.runtime.mark_dirty("pc-1");
    fake.say("pc-1", "FAILED 17");

    evaluate_tick(&engine, &host, 0, 1_000).await;
    tokio::time::sleep(Duration::from_millis(1_500)).await;

    assert!(
        fake.written()
            .iter()
            .any(|w| w.contains("awk '{print $1}'")),
        "the literal message was never typed: {:?}",
        fake.written()
    );
}

/// §4.4's last row. Validation should have caught this, so reaching it means a rule got here
/// another way — and the answer is still "type nothing": refuse the send and log the token
/// rather than type a live `$3` into a running agent.
///
/// **"Another way" is now named, not hypothetical.** Task 6's `action.unknownToken` refuses to
/// let `save_rule` create this exact row enabled, so the rig plants it directly, bypassing
/// that gate — standing in for a rule a build older than the validation already enabled. This
/// is the send-time defense that row still needs; `reload` does not re-run the check that
/// would have caught it, on purpose (its own exemption is scoped to `parse.*`).
#[tokio::test(start_paused = true)]
async fn an_unresolvable_token_refuses_the_send_and_logs_it() {
    let (engine, fake, host) = rig_with_rule_bypassing_the_enable_gate(|g| {
        g.parse_mut().find = r"FAILED (\d+)".into();
        g.cond_mut().finds = Finds::Event;
        g.action_mut().message = "Fix $3".into();
        g.action_mut().substitute = true;
    });
    engine.runtime.set_arm("au-1", "tm-1", ArmState::armed());
    engine.runtime.mark_dirty("pc-1");
    fake.say("pc-1", "FAILED 17");

    evaluate_tick(&engine, &host, 0, 1_000).await;
    tokio::time::sleep(Duration::from_millis(1_500)).await;

    assert!(
        fake.written().is_empty(),
        "nothing may be typed: {:?}",
        fake.written()
    );
    let log = log_details(&fake.store);
    assert!(
        log.iter().any(|(_, detail)| detail.contains("$3")),
        "the failure row must name the token, got: {log:?}"
    );
    assert!(
        log.iter().any(|(kind, _)| kind == "Failed"),
        "and it must be a Failed row: {log:?}"
    );
}

