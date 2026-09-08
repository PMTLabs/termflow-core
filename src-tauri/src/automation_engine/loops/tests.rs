use super::*;
// The fake, the canonical rule and the wiring are shared with the dry run's tests so there can
// only ever be one of each.
use crate::automation::roster::RosterRow;
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
    let source = strip_comments(include_str!("../loops.rs"));
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

// =============================================================================================
// The send's own fixtures (§10.7 – §10.9, §10.14c)
// =============================================================================================

/// A crossing that has been decided and not yet written — built exactly the way `evaluate_pair`
/// builds one, **including advancing the arm state first**, so a test of the rollback is a test of
/// the real starting position rather than of a state the engine never produces.
fn pending(
    engine: &Arc<AutomationEngine>,
    host: &Arc<dyn EngineHost>,
    rule_id: &str,
    prev: ArmState,
    at_ms: i64,
) -> PendingSend {
    let rule = engine
        .snapshot_live()
        .into_iter()
        .find(|l| l.rule.id == rule_id)
        .expect("the rule must be live for a send to have been decided");
    engine
        .runtime
        .set_arm(rule_id, "tm-1", ArmState::Fired { at_ms });
    PendingSend {
        pair: Pair {
            rule,
            tm: "tm-1".into(),
            pc: "pc-1".into(),
        },
        prev,
        label: host.label_for("tm-1"),
        at_ms,
        // None of this fixture's callers exercise substitution — they are the rollback/
        // serialisation suites, which vary the terminal and the queue, not the message.
        captures: None,
    }
}

/// Where each bracketed paste sits in the write log. One send is three writes — paste, focus-in,
/// submit — so two serialised sends put their pastes at 0 and 3, and two interleaved ones put them
/// side by side.
fn paste_positions(writes: &[String]) -> Vec<usize> {
    writes
        .iter()
        .enumerate()
        .filter(|(_, w)| w.starts_with("\x1b[200~"))
        .map(|(i, _)| i)
        .collect()
}

// =============================================================================================
// §10.7 — send serialisation
// =============================================================================================

/// **Two sends into one terminal, decided in one tick.** Route A is paste → 500 ms → focus-in →
/// submit, and without the per-leaf lock both tasks write their paste, both sleep, and the second
/// rule's text lands *inside* the first rule's composer line — which then submits both as one
/// message. That is not a lost automation, it is a wrong command typed at an agent.
///
/// The oracle is the POSITION of the two pastes, not the presence of the two messages: a lock-free
/// implementation satisfies "both messages appear somewhere" perfectly.
#[tokio::test(start_paused = true)]
async fn two_sends_to_one_terminal_never_interleave() {
    let (engine, fake, host) = wire(vec![
        ctx_rule_saying("au-1", "alpha speaking", 1),
        ctx_rule_saying("au-2", "bravo speaking", 2),
    ]);
    for id in ["au-1", "au-2"] {
        engine.runtime.set_arm(id, "tm-1", ArmState::armed());
    }
    engine.runtime.mark_dirty("pc-1");
    fake.say("pc-1", "ctx:63%\n");

    evaluate_tick(&engine, &host, 0, 1_000).await;
    tokio::time::sleep(Duration::from_millis(2_000)).await;

    let writes = fake.written();
    assert_eq!(
        writes.len(),
        6,
        "two sends of three writes each: {:?}",
        writes
    );
    assert_eq!(
        paste_positions(&writes),
        vec![0, 3],
        "a paste landed inside another send: {:?}",
        writes
    );

    // Order between the two is the scheduler's business; carrying ONE WHOLE message each is not.
    let mut carried: Vec<&str> = Vec::new();
    for i in [0usize, 3] {
        let alpha = writes[i].contains("alpha speaking");
        let bravo = writes[i].contains("bravo speaking");
        assert_ne!(
            alpha, bravo,
            "one paste carried both messages: {:?}",
            writes
        );
        carried.push(if alpha { "alpha" } else { "bravo" });
    }
    carried.sort_unstable();
    assert_eq!(
        carried,
        vec!["alpha", "bravo"],
        "both rules must have sent: {:?}",
        writes
    );
}

/// A send that cannot take the terminal's queue within [`SEND_QUEUE_TIMEOUT_MS`] gives up: one
/// `failed` row, nothing typed, and the arm state back at **exactly** where it was.
///
/// `prev` is a RE-armed state here rather than a fresh `armed()`, and that is the point of the
/// test: rolling back to `ArmState::armed()` loses `seen_fire`, which puts a presence rule back to
/// reading the deep window and makes it re-fire on the very line it just let go (§2.2c). A
/// rollback that looks right and is not.
#[tokio::test(start_paused = true)]
async fn a_send_that_cannot_take_the_queue_fails_once_and_rolls_back_exactly() {
    let (engine, fake, host) = wired();
    let lock = engine.runtime.send_lock("tm-1");
    let _held = lock.lock().await;

    let send = pending(&engine, &host, "au-1", ArmState::re_armed(), 1_000);
    run_crossing(engine.clone(), host.clone(), send).await;

    assert!(
        fake.written().is_empty(),
        "a send that never got the queue must type nothing"
    );
    assert_eq!(
        engine.runtime.arm_state("au-1", "tm-1"),
        ArmState::re_armed(),
        "rolled back to a fresh Armed, losing seen_fire"
    );
    let rows = log_details(&fake.store);
    assert_eq!(rows.len(), 1, "exactly one row: {:?}", rows);
    assert_eq!(rows[0].0, "Failed");
    assert!(
        rows[0].1.contains("another rule was still sending"),
        "{:?}",
        rows
    );
    assert_eq!(
        engine.runtime.fire_record("au-1", "tm-1"),
        None,
        "a failed send never fired"
    );
}

// =============================================================================================
// §10.8 — the failure paths
// =============================================================================================

/// **Both delivery failures, as a table**, because they are one class: the message did not go out.
/// Each writes exactly one row, leaves the arm state where the decision found it, records no fire,
/// and leaves neither an echo needle nor a settle window behind — a send that half-happened is the
/// one outcome the log must never imply.
#[tokio::test(start_paused = true)]
async fn a_send_that_cannot_be_delivered_fails_once_and_leaves_the_pair_armed() {
    // (what breaks it, how to break it, what the row must say, writes actually attempted)
    let cases: Vec<(&str, fn(&FakeHost), &str, usize)> = vec![
        (
            "the terminal closed between the decision and our turn at the queue",
            |fake: &FakeHost| fake.close("tm-1"),
            "the terminal closed before the message was sent",
            0,
        ),
        (
            "the write itself was refused",
            |fake: &FakeHost| {
                *fake.write_err.lock().unwrap() = Some("terminal pc-1 has no writer".into());
            },
            "the message could not be sent",
            1,
        ),
    ];

    for (what, break_it, says, attempted) in cases {
        let (engine, fake, host) = wired();
        // The decision is made while the terminal is OPEN, and only then does the thing that
        // breaks the send happen. Building the send after breaking it would resolve the label
        // against an already-dead terminal, which is not the sequence §2.8 is about.
        let send = pending(&engine, &host, "au-1", ArmState::armed(), 1_000);
        break_it(&fake);

        run_crossing(engine.clone(), host.clone(), send).await;
        tokio::time::sleep(Duration::from_millis(1_500)).await;

        assert_eq!(
            fake.written().len(),
            attempted,
            "{}: a refused paste must not be followed by a submit — {:?}",
            what,
            fake.written()
        );
        assert_eq!(
            engine.runtime.arm_state("au-1", "tm-1"),
            ArmState::armed(),
            "{}",
            what
        );
        let rows = log_details(&fake.store);
        assert_eq!(rows.len(), 1, "{}: exactly one row, got {:?}", what, rows);
        assert_eq!(rows[0].0, "Failed", "{}: {:?}", what, rows);
        assert!(rows[0].1.contains(says), "{}: {:?}", what, rows);
        // R17 / §2.8. The `terminal closed` row is written when there is no name left to look
        // up, which is precisely why the decision carries one — and precisely the row the Name
        // column exists to serve. An oracle reading only `(kind, detail)` let a NULL through here.
        assert_eq!(
            log_rows(&fake.store)[0].2.as_deref(),
            Some("codex · core"),
            "{}: the log lost the terminal's name",
            what
        );
        assert_eq!(engine.runtime.fire_record("au-1", "tm-1"), None, "{}", what);
        assert!(
            engine.runtime.echoes_for("tm-1", 1_000).is_empty(),
            "{}: nothing was typed, so there is no echo to strip",
            what
        );
        assert!(
            !engine.runtime.is_settling("tm-1", 1_000),
            "{}: and no message is landing, so nothing must be held off this terminal",
            what
        );
    }
}

/// §10.8's third failure, and the only one that happens at LOAD rather than at send: an
/// uncompilable pattern is reported once per load and never per tick.
///
/// `automation_engine.rs` asserts the same thing from the live set's side, where "nothing
/// evaluates it" could only be argued. Here eight real ticks run over it — which is the claim that
/// matters, and until M3b there was no evaluator to make it against.
#[tokio::test(start_paused = true)]
async fn an_uncompilable_pattern_is_reported_once_at_load_and_never_by_a_tick() {
    let mut bad = ctx_rule("au-bad");
    bad.graph.parse_mut().find = r"ctx:(\d+%".into();
    let (engine, fake, host) = wire(vec![bad]);

    assert_eq!(
        log_kinds(&fake.store),
        vec!["Failed".to_string()],
        "one row, written at load"
    );
    assert!(
        engine.snapshot_live().is_empty(),
        "and the rule is not running"
    );

    fake.say("pc-1", "ctx:63%\n");
    let mut cursor = 0;
    for t in 1..=8 {
        engine.runtime.mark_dirty("pc-1");
        cursor = evaluate_tick(&engine, &host, cursor, t * 1_000).await;
    }

    assert_eq!(
        log_kinds(&fake.store),
        vec!["Failed".to_string()],
        "a tick wrote a second row"
    );
    assert!(
        fake.written().is_empty(),
        "and an uncompilable rule must never send"
    );
}

// =============================================================================================
// §10.8b — the stop flag, at the one place a half-executed step is visible to a user
// =============================================================================================

#[tokio::test(start_paused = true)]
async fn a_quit_stops_a_queued_send_and_never_splits_one_already_typing() {
    // Queued: the flag is set before the first write, so nothing is typed at all.
    {
        let (engine, fake, host) = wired();
        let send = pending(&engine, &host, "au-1", ArmState::armed(), 1_000);
        engine.stop();

        run_crossing(engine.clone(), host.clone(), send).await;

        assert!(
            fake.written().is_empty(),
            "a send that started after the quit must type nothing"
        );
        assert_eq!(
            engine.runtime.arm_state("au-1", "tm-1"),
            ArmState::armed(),
            "and the crossing must still be able to fire next launch"
        );
        // No `failed` row, deliberately — and the reason used to be that `RunEvent::Exit` flushed
        // the log after setting this flag, so nobody would read it. `append` is write-through, so
        // that was never true and the row WOULD survive. The real reason is that nothing failed:
        // the arm state is restored, the crossing is still armed, and it fires on the next launch.
        // A row here would be the only trace of a non-event, in a 200-row log §3.3 reserves for
        // decisions a user can act on.
        assert!(
            log_kinds(&fake.store).is_empty(),
            "{:?}",
            log_details(&fake.store)
        );
    }

    // Already typing: the flag is set during the paste-to-submit gap and the submit still goes
    // out. A check between the two leaves the user's composer holding an unsent line.
    {
        let (engine, fake, host) = wired();
        let send = pending(&engine, &host, "au-1", ArmState::armed(), 1_000);
        let task = tokio::spawn(run_crossing(engine.clone(), host.clone(), send));

        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            fake.written().len(),
            1,
            "the paste must be out and the gap running"
        );
        engine.stop();
        tokio::time::sleep(Duration::from_millis(1_000)).await;
        assert!(task.is_finished(), "the send must not park on the flag");

        let writes = fake.written();
        assert_eq!(writes.len(), 3, "paste, focus-in, submit: {:?}", writes);
        assert_eq!(writes[2], "\x1b\r\r", "the submit itself: {:?}", writes);
        assert_eq!(
            engine.runtime.arm_state("au-1", "tm-1"),
            ArmState::Fired { at_ms: 1_000 },
            "a completed send is not rolled back"
        );
        assert!(log_kinds(&fake.store).contains(&"Sent".to_string()));
    }
}

// =============================================================================================
// §10.9 — the echo guard, end to end
// =============================================================================================

/// **§2.6 in the canonical rule's own shape.** Pattern `HANDOFF`, message `HANDOFF now`: a rule
/// whose message contains its own pattern is what breaks without the guard, and the rule this
/// whole feature was designed around is exactly that shape.
///
/// The needle is stripped, so once the real line has scrolled away the rule sees nothing and
/// **re-arms**. Without the strip it sits in `Fired` forever reading its own message — which is
/// indistinguishable from working until the day the condition happens again.
#[tokio::test(start_paused = true)]
async fn a_rule_re_arms_when_the_only_thing_left_on_screen_is_its_own_echo() {
    let (engine, fake, host) = wire(vec![presence_rule("au-1", "HANDOFF", "HANDOFF now", 1)]);
    engine.runtime.set_arm("au-1", "tm-1", ArmState::armed());
    engine.runtime.mark_dirty("pc-1");
    fake.say("pc-1", "building\nHANDOFF\n");

    evaluate_tick(&engine, &host, 0, 1_000).await;
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    assert_eq!(
        fake.written().len(),
        3,
        "the crossing must send: {:?}",
        fake.written()
    );
    assert_eq!(
        engine.runtime.echoes_for("tm-1", 1_000),
        vec!["HANDOFF now".to_string()]
    );

    // The real line has scrolled off. All that is left is what this rule typed.
    fake.say("pc-1", "HANDOFF now\n");
    engine.runtime.mark_dirty("pc-1");
    evaluate_tick(&engine, &host, 0, 4_000).await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    assert_eq!(
        engine.runtime.arm_state("au-1", "tm-1"),
        ArmState::re_armed(),
        "the rule read its own message and stayed Fired"
    );
    assert_eq!(fake.written().len(), 3, "and it must not have sent again");
    assert!(log_kinds(&fake.store).contains(&"ReArmed".to_string()));

    // The positive half. The strip removes the NEEDLE, not the window: a genuine match arriving
    // while the echo is still live is still seen — otherwise "never fires again" is how this test
    // passes.
    fake.say("pc-1", "HANDOFF now\nHANDOFF\n");
    engine.runtime.mark_dirty("pc-1");
    evaluate_tick(&engine, &host, 0, 7_000).await;
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    assert_eq!(
        fake.written().len(),
        6,
        "a real match beside the echo must still send: {:?}",
        fake.written()
    );
}

/// The **per-terminal** half of §2.6, and the reason the needle map is keyed by terminal rather
/// than by rule: rule A's message is echoed into a pane rule B is also watching, and B has no idea
/// A wrote it. A per-rule map hands B an empty needle list and B fires on A's message.
#[tokio::test(start_paused = true)]
async fn a_needle_one_rule_recorded_is_stripped_before_another_rule_reads_that_terminal() {
    let (engine, fake, host) = wire(vec![
        presence_rule("au-a", "HANDOFF", "HANDOFF now", 1),
        presence_rule("au-b", "now", "bravo saw it", 2),
    ]);
    for id in ["au-a", "au-b"] {
        engine.runtime.set_arm(id, "tm-1", ArmState::armed());
    }
    engine.runtime.mark_dirty("pc-1");
    fake.say("pc-1", "building\nHANDOFF\n");

    // A crosses. B sees no `now` at all and stays armed.
    evaluate_tick(&engine, &host, 0, 1_000).await;
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    assert_eq!(engine.runtime.arm_state("au-b", "tm-1"), ArmState::armed());
    assert_eq!(times_sent(&fake, "HANDOFF now"), 1);

    // A's message lands in the pane B is watching.
    fake.say("pc-1", "HANDOFF now\n");
    engine.runtime.mark_dirty("pc-1");
    evaluate_tick(&engine, &host, 0, 4_000).await;
    tokio::time::sleep(Duration::from_millis(1_500)).await;

    assert_eq!(
        engine.runtime.arm_state("au-b", "tm-1"),
        ArmState::armed(),
        "B fired on a message this feature typed itself"
    );
    assert_eq!(
        times_sent(&fake, "bravo saw it"),
        0,
        "B must not have sent: {:?}",
        fake.written()
    );

    // Paired positive: the same word arriving organically beside the echo DOES reach B.
    fake.say("pc-1", "HANDOFF now\nfinishing now\n");
    engine.runtime.mark_dirty("pc-1");
    evaluate_tick(&engine, &host, 0, 7_000).await;
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    assert_eq!(
        times_sent(&fake, "bravo saw it"),
        1,
        "the strip removes the needle, not the window: {:?}",
        fake.written()
    );
}

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
    let engine = strip_comments(include_str!("../../automation_engine.rs"));
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

    let lib = strip_comments(include_str!("../../lib.rs"));
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
    let lib = strip_comments(include_str!("../../lib.rs"));
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

/// A second live terminal, with ids that share no substring with the first (§7.4).
fn open_second_terminal(fake: &Arc<FakeHost>) {
    open_terminal(fake, "tm-2", "pc-2", "second");
}

/// One more terminal on a rig that is already built. `FakeHost::with_terminal` is the same thing
/// at construction time; this is the `&Arc<FakeHost>` form, and §6.3's fixtures need three and
/// four of them.
fn open_terminal(fake: &Arc<FakeHost>, tm: &str, pc: &str, label: &str) {
    fake.roster.lock().unwrap().push(RosterRow {
        terminal_id: Some(tm.into()),
        process_id: pc.into(),
        name: "Terminal-powershell".into(),
        shell: "powershell".into(),
        pid: 102,
        display_label: Some(label.into()),
        cwd: None,
        command_lines: Vec::new(),
    });
    fake.leaves.lock().unwrap().insert(tm.into(), pc.into());
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
