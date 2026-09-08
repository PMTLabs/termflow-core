use super::*;
use crate::automation_engine::eval::ArmState;
use crate::automation_store::{
    ActionStep, AutomationGraph, Cadence, Clause, CompareOp, CondStep, Criterion, Finds, Keep,
    LogOrder, LogScope, MonitorStep, ParsePreset, ParseStep, ReadMode, SendTo, Source,
    TargetMode, Test, TextOp, SUPPORTED_SCHEMA_VERSION,
};

fn rule(id: &str, find: &str) -> AutomationRule {
    AutomationRule {
        id: id.to_string(),
        name: format!("rule {}", id),
        enabled: true,
        runs_once: false,
        target_mode: TargetMode::Pinned,
        criterion: Criterion::AllTerminals,
        criterion_value: String::new(),
        follow_new: true,
        target_ids: vec!["tm-1".to_string()],
        excluded_ids: vec![],
        exclude_criterion: None,
        exclude_criterion_value: String::new(),
        completed_at: None,
        verbose_until: None,
        sort_order: 1,
        schema_version: SUPPORTED_SCHEMA_VERSION,
        graph: AutomationGraph {
            layout: None,
            timer: None,
            monitor: Some(MonitorStep {
                read: ReadMode::NewOutput,
                cadence: Cadence::OnOutput,
                every_ms: 0,
                skip_typed_line: false,
            }),
            parse: Some(ParseStep {
                preset: ParsePreset::Custom,
                literal: None,
                find: find.to_string(),
                keep: Keep::Brackets,
            }),
            cond: Some(CondStep {
                finds: Finds::Reading,
                op: Some(CompareOp::Gt),
                threshold: Some(25.0),
                ..Default::default()
            }),
            action: Some(ActionStep {
                message: "prepare to do context-hand-off".to_string(),
                send_to: SendTo::Matched,
                submit: true,
                cli_type: "default".to_string(),
                substitute: false,
            }),
            webhook: None,
        },
        created_at: 1_000,
        updated_at: 1_000,
    }
}

/// A v1 rule's graph: `op`/`threshold` set, `clauses` empty — built on the existing `rule()`
/// fixture rather than a parallel one, varying only what the table test needs to vary.
fn v1_graph(finds: Finds, keep: Keep, pattern: &str) -> AutomationGraph {
    let mut g = rule("au-v1", pattern).graph;
    g.cond_mut().finds = finds;
    g.parse_mut().keep = keep;
    g
}

/// A v2 rule that already has clauses — folding must leave it alone.
fn v2_graph_with_two_clauses() -> AutomationGraph {
    let mut g = rule("au-v2", "x").graph;
    g.cond_mut().clauses = vec![
        Clause {
            source: Source::Whole,
            test: Test::Text { op: TextOp::Contains, value: "err".into() },
        },
        Clause { source: Source::Group(1), test: Test::Number { op: CompareOp::Gt, value: Some(1.0) } },
    ];
    g
}

// -----------------------------------------------------------------------------------------
// §5.4 — folding a v1 rule into the clause list it always meant
// -----------------------------------------------------------------------------------------

/// The three branches of `extract()`'s `keep` handling, as a table — the mapping is the
/// whole point, and testing one row would leave two silently wrong.
#[test]
fn v1_rules_fold_into_the_clause_list_exactly_as_extract_chose() {
    for (finds, keep, pattern, want) in [
        (Finds::Reading, Keep::Brackets, r"ctx:(?P<value>\d+)%", Some(Source::Named("value".into()))),
        (Finds::Reading, Keep::Brackets, r"ctx:(\d+)%", Some(Source::Group(1))),
        (Finds::Reading, Keep::Whole, r"ctx:\d+%", Some(Source::Whole)),
        (Finds::Event, Keep::Brackets, r"API error (\d+)", None),
    ] {
        let mut g = v1_graph(finds, keep, pattern);
        fold_v1_clauses(&mut g, &Regex::new(pattern).unwrap());
        match want {
            Some(src) => {
                assert_eq!(g.cond_ref().clauses.len(), 1, "{pattern}");
                assert_eq!(g.cond_ref().clauses[0].source, src, "{pattern}");
            }
            None => assert!(
                g.cond_ref().clauses.is_empty(),
                "a word rule folds to ZERO clauses — the empty list IS 'fire on the match'"
            ),
        }
    }
}

#[test]
fn folding_does_not_touch_a_rule_that_already_has_clauses() {
    let mut g = v2_graph_with_two_clauses();
    let before = g.cond_ref().clauses.clone();
    fold_v1_clauses(&mut g, &Regex::new("x").unwrap());
    assert_eq!(g.cond_ref().clauses, before);
}

fn live_ids(engine: &AutomationEngine) -> Vec<String> {
    engine.snapshot_live().iter().map(|l| l.rule.id.clone()).collect()
}

fn log_rows(store: &AutomationStore) -> Vec<String> {
    store
        .load_automation_log(&LogScope::All, LogOrder::Asc, 100)
        .unwrap()
        .into_iter()
        .map(|e| e.detail)
        .collect()
}

// -----------------------------------------------------------------------------------------
// §7.3 — the rule source
// -----------------------------------------------------------------------------------------

/// What reaches the live set, as a LIST: every reason a rule is refused, and the one reason it is
/// refused SILENTLY. A filter tested with one rule cannot show which rules it kept.
#[test]
fn reload_runs_the_runnable_rules_and_says_why_it_refused_the_rest() {
    let store = AutomationStore::new_in_memory();
    store.save_rule(&rule("au-live", r"ctx:(\d+)%")).unwrap();

    let mut off = rule("au-off", r"ctx:(\d+)%");
    off.enabled = false;
    store.save_rule(&off).unwrap();

    let mut done = rule("au-done", r"ctx:(\d+)%");
    done.completed_at = Some(5);
    store.save_rule(&done).unwrap();

    let mut future = rule("au-future", r"ctx:(\d+)%");
    future.schema_version = SUPPORTED_SCHEMA_VERSION + 1;
    store.save_rule(&future).unwrap();

    store.save_rule(&rule("au-bad", r"ctx:(\d+%")).unwrap();

    let engine = AutomationEngine::new(0);
    let report = engine.reload(&store, 7_000).unwrap();

    assert_eq!(live_ids(&engine), vec!["au-live"]);
    assert_eq!(report.live, 1);
    assert!(report.emit, "a refusal the user must see is worth an activity event");

    // In `list_rules` order (`ORDER BY sort_order, id`), which is the order the log rows land in.
    let reasons: Vec<String> = report.skipped.iter().map(|(id, _)| id.clone()).collect();
    assert_eq!(reasons, vec!["au-bad", "au-future"], "and ONLY these two are reported");

    let rows = log_rows(&store);
    assert_eq!(rows.len(), 2, "a disabled or completed rule is normal, not a failure: {:?}", rows);
    assert!(rows[0].contains("could not be understood"), "{}", rows[0]);
    assert!(rows[1].contains("needs a newer version"), "{}", rows[1]);
}

#[test]
fn reload_logs_a_real_malformed_webhook_value_without_its_url() {
    let secret = "https://hooks.example.invalid/reload-credential";
    let malformed = format!(
        r#"{{"webhook":{{"provider":"{secret}","url":"{secret}","body":"done"}}}}"#
    );
    let store = AutomationStore::new_in_memory();
    store.insert_raw_graph_for_test("au-malformed", &malformed);

    let engine = AutomationEngine::new(0);
    let report = engine.reload(&store, 7_000).expect("reload malformed row");
    assert_eq!(report.skipped.len(), 1, "the malformed row was really skipped");
    assert!(!report.skipped[0].1.contains(secret), "reload reason leaked: {:?}", report.skipped);

    let rows = log_rows(&store);
    assert_eq!(rows.len(), 1, "reload wrote its real activity row");
    assert!(!rows[0].contains(secret), "activity detail leaked: {}", rows[0]);
}

/// **A schedule rule has no pattern, and no pattern is not a broken pattern** (plan 032 §6.4).
///
/// `reload` used to ask `pattern_refused_at_load(&graph.parse.find)` of every rule, and a rule
/// with no parse step at all has no `find` to ask about — the first version of task 19 skipped
/// it with a refusal row, because `LiveRule.re` was a mandatory `Regex`. It is optional now, so
/// the two pattern gates apply only to a rule that HAS a pattern, and this rule runs.
#[test]
fn a_schedule_rule_with_no_pattern_is_admitted() {
    let store = AutomationStore::new_in_memory();
    store.save_rule(&crate::automation_engine::test_host::schedule_only_rule("au-sched")).unwrap();

    let engine = AutomationEngine::new(0);
    // **`reload_at` at 08:00, not `reload` at epoch 0, and the seam is load-bearing here.**
    // `reload` derives the local day from `now_ms`, and epoch 0 is 19:00 the previous evening
    // west of UTC and midnight on it — so this rule's 09:00 target is "already past" on a
    // CI runner in one zone and not in another, and the seeding then writes the §7 suppression
    // row on exactly half the world's machines. The assertion below is about a PATTERN, so it
    // is pinned to a morning where nothing is suppressed. `reload_at`'s own doc says this is
    // what the seam is for.
    let report = engine.reload_at(&store, 0, at(monday_2026_09_07(), 8 * 60)).unwrap();

    assert_eq!(report.live, 1, "no pattern is not a broken pattern");
    assert!(report.skipped.is_empty(), "{:?}", report.skipped);
    assert!(log_rows(&store).is_empty(), "and nothing was written to the log about it");
    assert_eq!(live_ids(&engine), vec!["au-sched"]);

    // The absence reaches the live set as an ABSENCE, never as a defaulted match-everything
    // pattern — which is what an `unwrap_or_default()` anywhere on this path would produce.
    let live = engine.snapshot_live();
    assert!(live[0].re.is_none(), "a rule with no pattern must carry no compiled regex");
}

/// **A rule with nothing to watch and no schedule is refused at load, and says so** — it must
/// not be live-and-inert.
///
/// Since §3.1 made the monitor step optional this shape passed validation, saved *enabled*,
/// counted in `report.live` and was walked four times a second only to fall out at the
/// evaluator's monitor guard: running by every reading the user has, and unable to fire. The
/// same is true of `AfterMatch` with no monitor — a delay is parked at a crossing and there is
/// nothing here that can cross.
///
/// **Three rules, and the third is the point.** A refusal keyed on "no monitor" alone would
/// take the whole of milestone 4 out with it, so the schedule rule is in the fixture to say
/// that a `DailyAt` timer IS something to run on. `au-live` is here for the same reason a
/// filter tested with one rule cannot show which rules it kept.
///
/// **`inert` and `delayed` plant via the enable-gate bypass (R7 review).** `automation_validation`
/// now refuses to save either shape *enabled* at all (`timer.neverRuns`), which is R7 closing
/// this exact gap in the right layer — but this test is about `reload_at`'s OWN skip, the
/// second-line gate for a row that reached the shape some other way (an older build, or a
/// direct write), and that row has to exist in the store for the test to exercise it.
#[test]
fn a_rule_with_nothing_to_watch_and_no_schedule_is_skipped_with_a_reason() {
    let store = AutomationStore::new_in_memory();
    store.save_rule(&rule("au-live", r"ctx:(\d+)%")).unwrap();
    store.save_rule(&crate::automation_engine::test_host::schedule_only_rule("au-sched")).unwrap();

    let mut inert = rule("au-inert", r"ctx:(\d+)%");
    inert.graph.monitor = None;
    store.save_rule_bypassing_the_enable_gate_for_tests(&inert).unwrap();

    let mut delayed = rule("au-delay", r"ctx:(\d+)%");
    delayed.graph.monitor = None;
    delayed.graph.timer = Some(TimerStep { mode: TimerMode::AfterMatch { delay_ms: 30_000 } });
    store.save_rule_bypassing_the_enable_gate_for_tests(&delayed).unwrap();

    let engine = AutomationEngine::new(0);
    // 08:00, for `a_schedule_rule_with_no_pattern_is_admitted`'s reason: `au-sched` is a 09:00
    // rule, and a row count is only an oracle for refusals while nothing else is writing rows.
    let report = engine.reload_at(&store, 7_000, at(monday_2026_09_07(), 8 * 60)).unwrap();

    assert_eq!(
        live_ids(&engine),
        vec!["au-live", "au-sched"],
        "a schedule rule has no monitor either, and runs on the clock"
    );
    assert_eq!(report.live, 2, "`report.live` counts what can actually run");

    // In `list_rules` order (`ORDER BY sort_order, id`), which is the order the log rows land in.
    let skipped: Vec<String> = report.skipped.iter().map(|(id, _)| id.clone()).collect();
    assert_eq!(skipped, vec!["au-delay", "au-inert"]);
    for (id, why) in &report.skipped {
        assert_eq!(
            why, "this rule has nothing to watch and no schedule, so it can never run",
            "{id}"
        );
    }
    assert_eq!(log_rows(&store).len(), 2, "one row per load, per refused rule");
}

/// A Monday, as a local ordinal day. `schedule_only_rule`'s mask is Mon–Fri, so the rule this
/// module seeds is one that genuinely could fire on the day the test names.
fn monday_2026_09_07() -> i32 {
    use chrono::Datelike;
    let date = chrono::NaiveDate::from_ymd_opt(2026, 9, 7).expect("a real date");
    assert_eq!(date.weekday(), chrono::Weekday::Mon);
    date.num_days_from_ce()
}

fn at(day_ordinal: i32, minute_of_day: i32) -> schedule::LocalTime {
    schedule::LocalTime { day_ordinal, minute_of_day }
}

/// The reload seed has a two-part question: did the current daily target have an unobserved
/// window, and has *today* already spent it? This table covers the lifecycle combinations that
/// make those questions independent. The oracle is a `Held` row: a past target that is seeded
/// writes exactly one, while an unseeded target writes none.
#[test]
fn reload_seeds_only_unobserved_daily_target_windows_across_the_rule_lifecycle() {
    #[derive(Clone, Copy)]
    enum Presence {
        Reenabled,
        Live,
    }
    #[derive(Clone, Copy)]
    enum Mark {
        None,
        Today,
        EarlierDay,
    }
    #[derive(Clone, Copy)]
    enum Target {
        UnchangedAhead,
        UnchangedPast,
        MovedIntoPast,
        MovedIntoFuture,
    }
    struct Case {
        name: &'static str,
        presence: Presence,
        mark: Mark,
        target: Target,
        window: bool,
        seeded: bool,
        /// **The whole mark, day AND minute, for every row — not just the seeded ones.**
        /// Row count alone accepts a seed that files `(today, 0)`, and a seeded-only mark
        /// assertion accepts a reload that DROPS a retained mark, which would let the next
        /// tick send again. Both are stated here instead.
        mark_after: Option<(i32, i32)>,
    }

    let monday = monday_2026_09_07();
    let cases = [
        Case {
            name: "re-enabled / no mark / target already past",
            presence: Presence::Reenabled, mark: Mark::None, target: Target::UnchangedPast,
            window: true, seeded: true,
            mark_after: Some((monday, 9 * 60)),
        },
        Case {
            name: "re-enabled / earlier-day mark / target already past",
            presence: Presence::Reenabled, mark: Mark::EarlierDay, target: Target::UnchangedPast,
            window: true, seeded: true,
            mark_after: Some((monday, 9 * 60)),
        },
        Case {
            name: "re-enabled / today's mark / target already past",
            presence: Presence::Reenabled, mark: Mark::Today, target: Target::UnchangedPast,
            window: false, seeded: false,
            mark_after: Some((monday, 9 * 60)),
        },
        Case {
            name: "live / no mark / unchanged target still ahead",
            presence: Presence::Live, mark: Mark::None, target: Target::UnchangedAhead,
            window: false, seeded: false,
            mark_after: None,
        },
        Case {
            name: "live / no mark / unchanged target already past",
            presence: Presence::Live, mark: Mark::None, target: Target::UnchangedPast,
            window: false, seeded: false,
            mark_after: None,
        },
        Case {
            name: "live / no mark / target moved into the past",
            presence: Presence::Live, mark: Mark::None, target: Target::MovedIntoPast,
            window: true, seeded: true,
            mark_after: Some((monday, 9 * 60)),
        },
        Case {
            name: "live / no mark / target moved into the future",
            presence: Presence::Live, mark: Mark::None, target: Target::MovedIntoFuture,
            window: true, seeded: false,
            mark_after: None,
        },
        Case {
            name: "live / today's mark / target moved into the past",
            presence: Presence::Live, mark: Mark::Today, target: Target::MovedIntoPast,
            window: true, seeded: true,
            mark_after: Some((monday, 9 * 60)),
        },
        Case {
            name: "live / earlier-day mark / unchanged target",
            presence: Presence::Live, mark: Mark::EarlierDay, target: Target::UnchangedPast,
            window: false, seeded: false,
            mark_after: Some((monday - 1, 9 * 60)),
        },
    ];

    let now = at(monday, 14 * 60);
    for case in cases {
        let store = AutomationStore::new_in_memory();
        let mut sched = crate::automation_engine::test_host::schedule_only_rule("au-sched");
        let old_minute = match case.target {
            Target::UnchangedAhead | Target::MovedIntoPast => 17 * 60,
            Target::UnchangedPast | Target::MovedIntoFuture => 9 * 60,
        };
        sched.graph.timer = Some(TimerStep {
            mode: TimerMode::DailyAt { minute_of_day: old_minute, days: 0b0001_1111 },
        });
        store.save_rule(&sched).unwrap();

        let engine = AutomationEngine::new(0);
        engine.reload_at(&store, 0, at(monday, 8 * 60)).unwrap();
        match case.mark {
            Mark::None => {}
            Mark::Today => engine.runtime.set_last_fired_day("au-sched", monday, old_minute),
            Mark::EarlierDay => engine.runtime.set_last_fired_day("au-sched", monday - 1, old_minute),
        }

        if matches!(case.presence, Presence::Reenabled) {
            store.set_enabled_checked("au-sched", false).unwrap();
            engine.reload_at(&store, 1_000, at(monday, 8 * 60 + 30)).unwrap();
            store.set_enabled_checked("au-sched", true).unwrap();
        }

        match case.target {
            Target::MovedIntoPast | Target::MovedIntoFuture => {
                let new_minute = match case.target {
                    Target::MovedIntoPast => 9 * 60,
                    Target::MovedIntoFuture => 17 * 60,
                    Target::UnchangedAhead | Target::UnchangedPast => unreachable!(),
                };
                sched.graph.timer = Some(TimerStep {
                    mode: TimerMode::DailyAt { minute_of_day: new_minute, days: 0b0001_1111 },
                });
                sched.updated_at += 1;
                store.save_rule(&sched).unwrap();
            }
            Target::UnchangedAhead | Target::UnchangedPast => {}
        }

        // A moved target drops its old-minute mark in the forget loop before this predicate;
        // unchanged and re-enabled rules retain the mark reconciliation kept.
        let mark_at_filter = match case.target {
            Target::MovedIntoPast | Target::MovedIntoFuture => None,
            Target::UnchangedAhead | Target::UnchangedPast => match case.mark {
                Mark::None => None,
                Mark::Today => Some(monday),
                Mark::EarlierDay => Some(monday - 1),
            },
        };
        assert_eq!(
            has_unobserved_daily_window(
                matches!(case.presence, Presence::Reenabled),
                matches!(case.target, Target::MovedIntoPast | Target::MovedIntoFuture),
                false,
                mark_at_filter,
                monday,
            ),
            case.window,
            "{}: the candidate predicate has the expected unobserved window",
            case.name
        );

        engine.reload_at(&store, 2_000, now).unwrap();

        let entries = store.load_automation_log(&LogScope::All, LogOrder::Asc, 100).unwrap();
        assert_eq!(
            entries.len(),
            usize::from(case.seeded),
            "{}: a past target is seeded exactly when it had an unobserved window and today was unspent",
            case.name
        );
        if let Some(entry) = entries.first() {
            // Which rule, which KIND, and which target minute the words name. A row count
            // alone cannot tell a suppression apart from a failure, and every seeded row here
            // aims at 09:00, so the words are what bind the row to the target.
            assert_eq!(entry.rule_id, "au-sched", "{}: the row belongs to the rule", case.name);
            assert_eq!(
                entry.kind,
                LogKind::Held,
                "{}: nothing went wrong, so the row is Held rather than Failed",
                case.name
            );
            assert!(
                entry.detail.contains("09:00"),
                "{}: the row names the target it skipped, got {:?}",
                case.name,
                entry.detail
            );
        }
        assert_eq!(
            engine.runtime.last_fired_mark("au-sched"),
            case.mark_after,
            "{}: the spent-day mark after the reload, minute included",
            case.name
        );
    }
}

/// **The one window `invalidated_marks` catches and neither other term does.**
///
/// The lifecycle table above passes `false` for that term in every row, so deleting
/// `|| invalidated_mark` from `has_unobserved_daily_window` leaves the whole suite green — it
/// was a live term with nothing naming the event only it catches, which is the definition of
/// dead code with a rationale.
///
/// This is that event, and the other two terms provably cannot reach it. A rule that is live on
/// both sides of the reload is not `newly_live`. A rule whose `updated_at` did not change takes
/// the forget loop's early `continue`, so it is never `target_changed`. What is left is a mark
/// whose minute does not match the definition it is filed under: reconciliation drops it, and
/// the day it was standing for has not been observed by anything.
///
/// Written through the runtime rather than through the editor on purpose. No GUI path is known
/// to produce it — the walk files a mark under the live rule's own minute, and a store edit
/// bumps `updated_at` — so the term is defence against a future writer that files one under a
/// different minute. **That is exactly why it needs a test instead of a comment**: if the state
/// is ever reachable, this pins what the engine owes it; if the term is ever deleted, this says
/// what was lost.
#[test]
fn a_mark_filed_under_a_stale_minute_leaves_todays_target_unobserved() {
    let monday = monday_2026_09_07();
    let store = AutomationStore::new_in_memory();
    let mut sched = crate::automation_engine::test_host::schedule_only_rule("au-sched");
    sched.graph.timer = Some(TimerStep {
        mode: TimerMode::DailyAt { minute_of_day: 9 * 60, days: 0b0001_1111 },
    });
    store.save_rule(&sched).unwrap();

    let engine = AutomationEngine::new(0);
    // Live before and after, and never edited: `newly_live` and `target_changed` are both out.
    engine.reload_at(&store, 0, at(monday, 8 * 60)).unwrap();
    engine.runtime.set_last_fired_day("au-sched", monday, 17 * 60);

    engine.reload_at(&store, 1_000, at(monday, 14 * 60)).unwrap();

    assert_eq!(
        log_rows(&store).len(),
        1,
        "the stale-minute mark is reconciled away, so 09:00 today was never observed and is held"
    );
    assert_eq!(
        engine.runtime.last_fired_mark("au-sched"),
        Some((monday, 9 * 60)),
        "and the seed REFILES the mark under the minute the rule actually targets -- reading              only the day here would accept a seed that wrote (today, 0) and left the next reload              invalidating it all over again"
    );
}

/// **The 09:00 prompt must not arrive at 14:00 because the app started late** (§6.3, plan 028 Q3).
///
/// `schedule_due` compares `now >= target` — which is what keeps a spring-forward 02:30 schedule
/// alive on a day with no 02:30 — and an absent day mark plus a target three hours in the past is
/// spelled exactly like a crossing. The seeding in `reload` is the only thing that tells the two
/// apart, so this asserts the pair TOGETHER: what `reload` left behind, handed to the predicate.
/// Asserting `last_fired_day == Some(day)` alone would pass a seed the predicate ignored.
#[test]
fn a_schedule_missed_while_the_app_was_closed_does_not_fire_on_launch() {
    let store = AutomationStore::new_in_memory();
    let sched = crate::automation_engine::test_host::schedule_only_rule("au-sched");
    let TimerStep { mode } = sched.graph.timer.clone().expect("a schedule rule has a timer");
    store.save_rule(&sched).unwrap();

    let engine = AutomationEngine::new(0);
    let launch = at(monday_2026_09_07(), 14 * 60);
    engine.reload_at(&store, 0, launch).unwrap();

    assert_eq!(
        engine.runtime.last_fired_day("au-sched"),
        Some(launch.day_ordinal),
        "a 09:00 schedule loaded at 14:00 has already missed today"
    );
    assert!(
        !schedule::schedule_due(&mode, engine.runtime.last_fired_day("au-sched"), launch),
        "the prompt arrived on launch, five hours late"
    );
    // Tomorrow is a different day, and the rule is not broken — only today is spent.
    let tuesday = at(launch.day_ordinal + 1, 9 * 60);
    assert!(schedule::schedule_due(&mode, engine.runtime.last_fired_day("au-sched"), tuesday));
}

/// The other direction, and it is the one the seeding must not break: a schedule whose minute is
/// still ahead at launch is left unmarked, and fires when the tick reaches it.
#[test]
fn a_schedule_still_ahead_at_launch_fires_when_its_minute_arrives() {
    let store = AutomationStore::new_in_memory();
    let sched = crate::automation_engine::test_host::schedule_only_rule("au-sched");
    let TimerStep { mode } = sched.graph.timer.clone().expect("a schedule rule has a timer");
    store.save_rule(&sched).unwrap();

    let engine = AutomationEngine::new(0);
    let monday = monday_2026_09_07();
    engine.reload_at(&store, 0, at(monday, 8 * 60)).unwrap();

    assert_eq!(engine.runtime.last_fired_day("au-sched"), None, "09:00 has not happened yet");
    assert!(schedule::schedule_due(&mode, engine.runtime.last_fired_day("au-sched"), at(monday, 9 * 60)));
}

/// **The seeding runs AFTER the forget loop, and this is what says so.**
///
/// Saving a rule moves its `updated_at`, and `reload` drops everything that rule owns — the day
/// mark included. Seeded before that loop, the mark would be wiped for exactly the rules that
/// need it, and a schedule edited at 14:00 would deliver its 09:00 message on the next tick.
#[test]
fn a_schedule_edited_after_its_minute_is_re_seeded_rather_than_unmarked() {
    let store = AutomationStore::new_in_memory();
    let mut sched = crate::automation_engine::test_host::schedule_only_rule("au-sched");
    let TimerStep { mode } = sched.graph.timer.clone().expect("a schedule rule has a timer");
    store.save_rule(&sched).unwrap();

    let engine = AutomationEngine::new(0);
    let afternoon = at(monday_2026_09_07(), 14 * 60);
    engine.reload_at(&store, 0, afternoon).unwrap();

    // The user edits the rule's message and saves: `updated_at` moves, so `forget_rule` runs.
    sched.name = "renamed".into();
    sched.updated_at += 1;
    store.save_rule(&sched).unwrap();
    engine.reload_at(&store, 1_000, afternoon).unwrap();

    assert_eq!(engine.runtime.last_fired_day("au-sched"), Some(afternoon.day_ordinal));
    assert!(
        !schedule::schedule_due(&mode, engine.runtime.last_fired_day("au-sched"), afternoon),
        "an edit at 14:00 delivered the 09:00 message on the next tick"
    );
}

/// **An edit made after the rule has already fired must not write "today's run was skipped"** —
/// that row is a lie, and it is written into the record the user consults to find out what the
/// rule did.
///
/// `reload` purges a changed rule's `last_fired_day` (the store stamps `updated_at` on EVERY
/// save) and then re-seeds. The re-seed cannot tell *never fired today* from *fired today, the
/// mark was just deleted*, so it decided the day had been missed: the app runs across 09:00 and
/// sends, the user renames the rule at 09:30, and a `Held` row lands thirty minutes after the
/// `Sent` row for that same run saying nothing was watching the clock. Every subsequent save
/// wrote another one, and `Held` is Decision-class — the verbose gate cannot drop it — so with
/// `LOG_CAP` at 200 the duplicates evict the rule's real history.
///
/// **This asserts the ROWS, and that is the whole point.**
/// `a_schedule_edited_after_its_minute_is_re_seeded_rather_than_unmarked` above asserts only the
/// mark, which is exactly how this got through: the re-seed restores the same mark the fire
/// left, so the mark is right and the log is wrong.
#[test]
fn a_schedule_renamed_after_it_fired_writes_no_suppression_row() {
    let store = AutomationStore::new_in_memory();
    let mut sched = crate::automation_engine::test_host::schedule_only_rule("au-sched");
    store.save_rule(&sched).unwrap();

    let engine = AutomationEngine::new(0);
    let monday = monday_2026_09_07();
    // 08:00: the app is running BEFORE the minute, so nothing is seeded and nothing is said.
    engine.reload_at(&store, 0, at(monday, 8 * 60)).unwrap();
    assert_eq!(engine.runtime.last_fired_day("au-sched"), None, "premise: 09:00 is still ahead");

    // 09:00 arrives and the rule fires. `evaluate_tick` marks the day after the leaves and
    // `run_send` writes the `Sent` row; both are reproduced here rather than driven through the
    // loop, which needs a host this module has no business wiring for a `reload` test.
    engine.runtime.set_last_fired_day("au-sched", monday, 9 * 60);
    store
        .append(&AutomationLogEntry {
            id: 0,
            rule_id: "au-sched".into(),
            terminal_id: Some("tm-1".into()),
            terminal_name: Some("shell".into()),
            kind: LogKind::Sent,
            detail: "sent to shell".into(),
            at: 1_000,
        })
        .unwrap();

    // 09:30, and the user only renames it: same minute, same days.
    sched.name = "morning stand-up".into();
    sched.updated_at += 1;
    store.save_rule(&sched).unwrap();
    let report = engine.reload_at(&store, 2_000, at(monday, 9 * 60 + 30)).unwrap();

    let rows = store
        .load_automation_log(&crate::automation_store::LogScope::All, LogOrder::Asc, 100)
        .unwrap();
    assert_eq!(rows.len(), 1, "the rename wrote a row about a run that happened: {rows:?}");
    assert_eq!(rows[0].kind, LogKind::Sent, "the `Sent` row is still the last word: {rows:?}");
    assert!(!report.emit, "no row was written, so no window has anything to refetch");
    assert_eq!(
        engine.runtime.last_fired_day("au-sched"),
        Some(monday),
        "and the day is still spent, so the rename cannot send a second message today"
    );
}

/// Disabling stops the live rule but does not un-spend the schedule instant it already ran.
#[test]
fn a_schedule_re_enabled_after_it_fired_writes_no_suppression_row_or_second_send() {
    let store = AutomationStore::new_in_memory();
    let sched = crate::automation_engine::test_host::schedule_only_rule("au-sched");
    let TimerStep { mode } = sched.graph.timer.clone().expect("a schedule rule has a timer");
    store.save_rule(&sched).unwrap();

    let engine = AutomationEngine::new(0);
    let monday = monday_2026_09_07();
    engine.reload_at(&store, 0, at(monday, 8 * 60)).unwrap();
    engine.runtime.set_last_fired_day("au-sched", monday, 9 * 60);
    store
        .append(&AutomationLogEntry {
            id: 0,
            rule_id: "au-sched".into(),
            terminal_id: Some("tm-1".into()),
            terminal_name: Some("shell".into()),
            kind: LogKind::Sent,
            detail: "sent to shell".into(),
            at: 1_000,
        })
        .unwrap();

    store.set_enabled_checked("au-sched", false).unwrap();
    engine.reload_at(&store, 2_000, at(monday, 9 * 60 + 30)).unwrap();

    store.set_enabled_checked("au-sched", true).unwrap();
    let report = engine.reload_at(&store, 3_000, at(monday, 9 * 60 + 35)).unwrap();

    let rows = store
        .load_automation_log(&crate::automation_store::LogScope::All, LogOrder::Asc, 100)
        .unwrap();
    assert_eq!(rows.len(), 1, "re-enabling wrote a false suppression row: {rows:?}");
    assert_eq!(rows[0].kind, LogKind::Sent, "the sent row is still the last word: {rows:?}");
    assert!(!report.emit, "no row was written, so no window has anything to refetch");
    assert_eq!(engine.runtime.last_fired_day("au-sched"), Some(monday));
    assert!(
        !schedule::schedule_due(&mode, engine.runtime.last_fired_day("au-sched"), at(monday, 9 * 60 + 35)),
        "re-enabling allowed a second send today"
    );
}

#[test]
fn a_disabled_schedule_moved_later_re_fires_at_its_new_minute_today() {
    let store = AutomationStore::new_in_memory();
    let mut sched = crate::automation_engine::test_host::schedule_only_rule("au-sched");
    store.save_rule(&sched).unwrap();

    let engine = AutomationEngine::new(0);
    let monday = monday_2026_09_07();
    engine.reload_at(&store, 0, at(monday, 8 * 60)).unwrap();
    engine.runtime.set_last_fired_day("au-sched", monday, 9 * 60);

    store.set_enabled_checked("au-sched", false).unwrap();
    engine.reload_at(&store, 1_000, at(monday, 9 * 60 + 30)).unwrap();

    sched.enabled = false;
    sched.graph.timer = Some(TimerStep {
        mode: TimerMode::DailyAt { minute_of_day: 17 * 60, days: 0b0001_1111 },
    });
    sched.updated_at += 1;
    store.save_rule(&sched).unwrap();
    engine.reload_at(&store, 2_000, at(monday, 10 * 60)).unwrap();

    store.set_enabled_checked("au-sched", true).unwrap();
    engine.reload_at(&store, 3_000, at(monday, 10 * 60)).unwrap();

    let TimerStep { mode } = sched.graph.timer.clone().expect("a schedule rule has a timer");
    assert_eq!(
        engine.runtime.last_fired_day("au-sched"),
        None,
        "a mark spent at 09:00 must not suppress the new 17:00 occurrence"
    );
    assert!(
        schedule::schedule_due(&mode, engine.runtime.last_fired_day("au-sched"), at(monday, 17 * 60)),
        "the disabled edit left today's 17:00 occurrence spent"
    );
}

#[test]
fn a_schedule_deleted_while_disabled_loses_its_spent_day() {
    let store = AutomationStore::new_in_memory();
    let sched = crate::automation_engine::test_host::schedule_only_rule("au-sched");
    store.save_rule(&sched).unwrap();

    let engine = AutomationEngine::new(0);
    let monday = monday_2026_09_07();
    engine.reload_at(&store, 0, at(monday, 8 * 60)).unwrap();
    engine.runtime.set_last_fired_day("au-sched", monday, 9 * 60);

    store.set_enabled_checked("au-sched", false).unwrap();
    engine.reload_at(&store, 1_000, at(monday, 9 * 60 + 30)).unwrap();
    assert!(store.delete_rule("au-sched").unwrap());
    engine.reload_at(&store, 2_000, at(monday, 10 * 60)).unwrap();

    assert_eq!(
        engine.runtime.last_fired_day("au-sched"),
        None,
        "a deleted disabled rule retained its spent-day mark"
    );
}

#[test]
fn an_unrelated_save_does_not_spend_a_live_schedule_that_the_next_tick_must_dispatch() {
    let store = AutomationStore::new_in_memory();
    let sched = crate::automation_engine::test_host::schedule_only_rule("au-sched");
    let mut other = crate::automation_engine::test_host::schedule_only_rule("au-other");
    other.graph.timer = Some(TimerStep {
        mode: TimerMode::DailyAt { minute_of_day: 17 * 60, days: 0b0001_1111 },
    });
    store.save_rule(&sched).unwrap();
    store.save_rule(&other).unwrap();

    let engine = AutomationEngine::new(0);
    let monday = monday_2026_09_07();
    engine.reload_at(&store, 0, at(monday, 8 * 60)).unwrap();

    // 09:01: saving the unrelated evening rule reloads both live rules, but the engine was
    // already watching the morning schedule when its minute passed.
    other.name = "renamed evening schedule".into();
    other.updated_at += 1;
    store.save_rule(&other).unwrap();
    let report = engine.reload_at(&store, 1_000, at(monday, 9 * 60 + 1)).unwrap();

    assert_eq!(
        engine.runtime.last_fired_day("au-sched"),
        None,
        "an unrelated save spent the unchanged schedule before its next evaluator tick"
    );
    assert!(!report.emit, "the unrelated save wrote a false missed-schedule row");
    assert!(log_rows(&store).is_empty(), "the unchanged schedule wrote a Held row: {:?}", log_rows(&store));
    let TimerStep { mode } = sched.graph.timer.clone().expect("a schedule rule has a timer");
    assert!(
        schedule::schedule_due(&mode, engine.runtime.last_fired_day("au-sched"), at(monday, 9 * 60 + 1)),
        "the next evaluator tick would not dispatch the 09:00 schedule"
    );
}

#[test]
fn a_deleted_schedule_loses_its_spent_day() {
    let store = AutomationStore::new_in_memory();
    let sched = crate::automation_engine::test_host::schedule_only_rule("au-sched");
    store.save_rule(&sched).unwrap();

    let engine = AutomationEngine::new(0);
    let monday = monday_2026_09_07();
    engine.reload_at(&store, 0, at(monday, 8 * 60)).unwrap();
    engine.runtime.set_last_fired_day("au-sched", monday, 9 * 60);

    assert!(store.delete_rule("au-sched").unwrap());
    engine.reload_at(&store, 1_000, at(monday, 9 * 60 + 30)).unwrap();
    assert_eq!(engine.runtime.last_fired_day("au-sched"), None, "a deleted rule retained engine state");
}

/// **Moving the schedule to a different minute is a NEW schedule, and it may fire today.**
///
/// The discriminator for keeping the day mark is *did the target minute move*, not *did the rule
/// change*: a rename leaves today's target instant exactly where it was and therefore spent,
/// while a move puts it somewhere the day has not been spent on. This is the direction
/// "always preserve" gets wrong — a 09:00 rule moved to 17:00 at 09:30 must ring at 17:00.
#[test]
fn a_schedule_moved_to_a_later_minute_fires_at_the_new_time_today() {
    let store = AutomationStore::new_in_memory();
    let mut sched = crate::automation_engine::test_host::schedule_only_rule("au-sched");
    store.save_rule(&sched).unwrap();

    let engine = AutomationEngine::new(0);
    let monday = monday_2026_09_07();
    engine.reload_at(&store, 0, at(monday, 8 * 60)).unwrap();
    engine.runtime.set_last_fired_day("au-sched", monday, 9 * 60);

    // 09:30: the user drags the time to 17:00.
    sched.graph.timer = Some(TimerStep {
        mode: TimerMode::DailyAt { minute_of_day: 17 * 60, days: 0b0001_1111 },
    });
    sched.updated_at += 1;
    store.save_rule(&sched).unwrap();
    engine.reload_at(&store, 2_000, at(monday, 9 * 60 + 30)).unwrap();

    assert_eq!(
        engine.runtime.last_fired_day("au-sched"),
        None,
        "17:00 has not gone by today, so nothing has spent it"
    );
    let TimerStep { mode } = sched.graph.timer.clone().expect("a schedule rule has a timer");
    assert!(
        schedule::schedule_due(
            &mode,
            engine.runtime.last_fired_day("au-sched"),
            at(monday, 17 * 60)
        ),
        "the rule was moved to 17:00 and then refused to ring at 17:00"
    );
}

/// **Changing only the WEEKDAYS keeps the day mark** — and this is where the ruling this branch
/// shipped differs from the one it was handed.
///
/// The brief's discriminator was *did the timer change*, which takes the mask with it. But
/// today's target instant is the `minute_of_day` alone: a Monday 09:00 that has already run is
/// spent whatever the mask is edited to at 09:30, so clearing the mark on a mask edit re-creates
/// the exact false row this fix exists to remove — *"09:00 went by while nothing was watching"*,
/// about a 09:00 that ran. The mask is consulted by `schedule_due` on every future day anyway,
/// so keeping the mark costs it nothing.
///
/// The price is named rather than hidden: a user who adds TODAY's weekday to the mask after the
/// minute has passed gets silence rather than a row explaining it — the same silence a rule
/// whose day was seeded on a masked-out morning already gets, and the direction the brief itself
/// calls safe (a missed extra send beats a false row).
#[test]
fn a_schedule_whose_weekdays_changed_keeps_the_day_it_already_spent() {
    let store = AutomationStore::new_in_memory();
    let mut sched = crate::automation_engine::test_host::schedule_only_rule("au-sched");
    store.save_rule(&sched).unwrap();

    let engine = AutomationEngine::new(0);
    let monday = monday_2026_09_07();
    engine.reload_at(&store, 0, at(monday, 8 * 60)).unwrap();
    engine.runtime.set_last_fired_day("au-sched", monday, 9 * 60);

    // 09:30: Mon-Fri becomes every day. Same minute; today has still run.
    sched.graph.timer = Some(TimerStep {
        mode: TimerMode::DailyAt { minute_of_day: 9 * 60, days: 0b0111_1111 },
    });
    sched.updated_at += 1;
    store.save_rule(&sched).unwrap();
    let report = engine.reload_at(&store, 2_000, at(monday, 9 * 60 + 30)).unwrap();

    assert_eq!(
        engine.runtime.last_fired_day("au-sched"),
        Some(monday),
        "adding a weekday does not un-run this morning"
    );
    assert!(!report.emit);
    assert!(
        log_rows(&store).is_empty(),
        "a mask edit said this morning was skipped: {:?}",
        log_rows(&store)
    );
}

/// **A spent day says so, once** (§7) — otherwise the suppression is a silent absence.
///
/// The behaviour above is right and completely invisible: the user set a 09:00 reminder, it did
/// not arrive, and until this row there was nothing anywhere that named the reason. That is the
/// shape `absence-is-invisible-derive-the-check` is about, and the one this crate already
/// refuses for a rule refused at load and for a crossing that declined to send.
///
/// **Three loads, one row.** The bound is the assertion, not a comment: the row is gated on
/// `schedule_due` against the mark as it stands, so once the day is spent the predicate is
/// false and a second load writes nothing. Without that gate every launch, and every
/// `reload_after_commit` a Settings edit makes, would add a row for the same spent day.
#[test]
fn a_schedule_missed_while_the_app_was_closed_says_so_in_the_log_exactly_once() {
    let store = AutomationStore::new_in_memory();
    store
        .save_rule(&crate::automation_engine::test_host::schedule_only_rule("au-sched"))
        .unwrap();

    let engine = AutomationEngine::new(0);
    let launch = at(monday_2026_09_07(), 14 * 60);
    let report = engine.reload_at(&store, 5_000, launch).unwrap();
    assert!(report.emit, "a row was written, so the windows must be told to refetch the log");

    let rows = store
        .load_automation_log(&crate::automation_store::LogScope::All, LogOrder::Asc, 100)
        .unwrap();
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].kind, LogKind::Held, "nothing failed — the rule declined: {rows:?}");
    assert_eq!(
        rows[0].detail,
        "09:00 went by while nothing was watching the clock, so today's run was skipped"
    );
    assert_eq!(rows[0].terminal_id, None, "a schedule's suppression names no terminal");
    assert_eq!(rows[0].at, 5_000);

    // Two more loads of the same spent day. `reload_after_commit` runs on every definition
    // write, so an ungated row would make one Settings session a wall of identical lines.
    engine.reload_at(&store, 6_000, launch).unwrap();
    let later = engine.reload_at(&store, 7_000, at(launch.day_ordinal, 23 * 60)).unwrap();
    assert!(!later.emit, "a day already spent was reported again");
    assert_eq!(
        store
            .load_automation_log(&crate::automation_store::LogScope::All, LogOrder::Asc, 100)
            .unwrap()
            .len(),
        1,
        "one row per suppression, not one per load"
    );
}

/// **The row is narrower than the seed, and this is the difference.**
///
/// `target_already_past` ignores the weekday mask on purpose — marking a day the rule was never
/// going to run on costs nothing and keeps the seed a fact about the CLOCK. A row does not have
/// that freedom: *"09:00 went by, so today's run was skipped"* is simply false about a Sunday on
/// a weekdays-only rule, which never had a run today to skip. Gating the row on `schedule_due`
/// rather than on the seed's own predicate is what keeps the sentence true.
#[test]
fn a_day_the_schedule_never_ran_on_is_seeded_silently() {
    let store = AutomationStore::new_in_memory();
    store
        .save_rule(&crate::automation_engine::test_host::schedule_only_rule("au-sched"))
        .unwrap();

    let engine = AutomationEngine::new(0);
    // `schedule_only_rule` is Mon–Fri; 2026-09-07 is a Monday, so +6 is the Sunday after it.
    let sunday = at(monday_2026_09_07() + 6, 14 * 60);
    let report = engine.reload_at(&store, 5_000, sunday).unwrap();

    assert_eq!(
        engine.runtime.last_fired_day("au-sched"),
        Some(sunday.day_ordinal),
        "premise: the seed still runs — the row is what is narrower, not the mark"
    );
    assert!(!report.emit);
    assert!(
        store
            .load_automation_log(&crate::automation_store::LogScope::All, LogOrder::Asc, 100)
            .unwrap()
            .is_empty(),
        "a weekdays rule was told it had missed a Sunday"
    );
}

/// A schedule still ahead of the clock has missed nothing, and must not be told it has.
#[test]
fn a_schedule_still_ahead_at_launch_writes_no_row() {
    let store = AutomationStore::new_in_memory();
    store
        .save_rule(&crate::automation_engine::test_host::schedule_only_rule("au-sched"))
        .unwrap();

    let engine = AutomationEngine::new(0);
    engine.reload_at(&store, 5_000, at(monday_2026_09_07(), 8 * 60)).unwrap();

    assert!(
        store
            .load_automation_log(&crate::automation_store::LogScope::All, LogOrder::Asc, 100)
            .unwrap()
            .is_empty(),
        "09:00 has not happened yet, and the log said it had been missed"
    );
}

/// A delay rule has no day to seed: `AfterMatch` is parked at its crossing, not scheduled.
#[test]
fn an_after_match_rule_is_given_no_day() {
    let store = AutomationStore::new_in_memory();
    let mut delayed = rule("au-delay", r"ctx:(\d+)%");
    delayed.graph.timer =
        Some(TimerStep { mode: crate::automation_store::TimerMode::AfterMatch { delay_ms: 30_000 } });
    store.save_rule(&delayed).unwrap();

    let engine = AutomationEngine::new(0);
    engine.reload_at(&store, 0, at(monday_2026_09_07(), 23 * 60)).unwrap();

    assert_eq!(engine.runtime.last_fired_day("au-delay"), None);
}

/// §2.7: an uncompilable pattern is reported once per LOAD. The evaluator runs four times a second
/// and this must not be a row each time — which is why compilation happens here at all.
#[test]
fn a_bad_pattern_is_reported_once_per_load_and_never_per_tick() {
    let store = AutomationStore::new_in_memory();
    store.save_rule(&rule("au-bad", r"ctx:(\d+%")).unwrap();
    let engine = AutomationEngine::new(0);

    engine.reload(&store, 1_000).unwrap();
    assert_eq!(log_rows(&store).len(), 1);

    // The rule is not live, and the live set is the only thing a tick walks — so nothing can
    // evaluate it and nothing else can write a row. `loops.rs` makes the same claim by running
    // eight REAL ticks over it, which is the half this test cannot reach from here.
    assert!(engine.snapshot_live().is_empty());
    assert_eq!(log_rows(&store).len(), 1, "still one row, and no tick can add another");

    // **An EMPTY pattern is refused here too, and that is not a widening — it is the defect.**
    // `compile("")` SUCCEEDS: an empty regex matches every position of every string. So a rule
    // stored with one used to be admitted, and a presence rule fired on the first byte any
    // terminal printed. "Uncompilable" was never the same set as "unusable"; the store's save gate
    // exempts exactly what this refuses, so the two cannot drift apart again.
    let store = AutomationStore::new_in_memory();
    store.save_rule(&rule("au-empty", "   ")).unwrap();
    let engine = AutomationEngine::new(0);

    let report = engine.reload(&store, 1_000).unwrap();

    assert!(engine.snapshot_live().is_empty(), "an empty pattern matches EVERYTHING and it ran");
    assert_eq!(report.skipped.len(), 1, "{:?}", report.skipped);
    assert!(report.skipped[0].1.contains("nothing to look for"), "{:?}", report.skipped);

    // A second LOAD does report it again — that is a new load, and the user asked for one.
    engine.reload(&store, 2_000).unwrap();
    assert_eq!(log_rows(&store).len(), 2);
}

/// §10.9b — **the reason this function is not "build a fresh map".**
///
/// Two rules, both `Fired`. Disabling A must leave B exactly where it was. The easy implementation
/// clears B's keys too, so every B pair becomes `Unseen`; settled decision 7 then makes an
/// already-true condition count as a first sight, and **B goes silent until its next genuine
/// crossing** — no log line, no state change, nothing on screen. And the other half, which is
/// Q11: a rule the user EDITED does lose its keys, so an edit resets that rule's arm state.
#[test]
fn reload_preserves_the_arm_state_of_rules_it_did_not_change() {
    let store = AutomationStore::new_in_memory();
    store.save_rule(&rule("au-a", r"ctx:(\d+)%")).unwrap();
    store.save_rule(&rule("au-b", r"ctx:(\d+)%")).unwrap();
    let engine = AutomationEngine::new(0);
    engine.reload(&store, 1_000).unwrap();

    for id in ["au-a", "au-b"] {
        engine.runtime.set_arm(id, "tm-1", ArmState::Fired { at_ms: 500 });
        engine.runtime.set_last_eval(id, "tm-1", 500);
        engine.runtime.record_fire(id, "tm-1", 500);
        // All FOUR pair-keyed maps, arranged so the assertions below are not absence assertions
        // over keys that were never set. `last_decision` was added by a later round and purged at
        // all three sites without being asserted at any of them.
        engine.runtime.set_last_decision(id, "tm-1", crate::automation_engine::eval::Decision::Held);
    }

    // The user flips A off. B is untouched in the store.
    let mut off = rule("au-a", r"ctx:(\d+)%");
    off.enabled = false;
    off.updated_at = 2_000;
    store.save_rule(&off).unwrap();
    engine.reload(&store, 2_000).unwrap();

    assert_eq!(
        engine.runtime.arm_state("au-b", "tm-1"),
        ArmState::Fired { at_ms: 500 },
        "disabling one rule must not re-arm every other rule in the app"
    );
    assert_eq!(engine.runtime.last_eval("au-b", "tm-1"), Some(500));
    assert_eq!(engine.runtime.fire_record("au-b", "tm-1"), Some((1, 500)));
    assert_eq!(
        engine.runtime.last_decision("au-b", "tm-1"),
        Some(crate::automation_engine::eval::Decision::Held)
    );
    assert_eq!(
        engine.runtime.arm_state("au-a", "tm-1"),
        ArmState::Unseen,
        "and the rule that left the set does lose its keys"
    );
    assert_eq!(engine.runtime.last_eval("au-a", "tm-1"), None);
    assert_eq!(
        engine.runtime.fire_record("au-a", "tm-1"),
        None,
        "EVERY pair-keyed map, not just the one the assertion above happens to name"
    );
    assert_eq!(
        engine.runtime.last_decision("au-a", "tm-1"),
        None,
        "a stale decision makes the row that says the rule woke up read as a repeat, so the \
         verbose gate drops it"
    );

    // Q11: an EDIT to B resets B, and only B.
    engine.runtime.set_arm("au-b", "tm-1", ArmState::Fired { at_ms: 500 });
    let mut edited = rule("au-b", r"ctx:(\d+)%");
    edited.updated_at = 3_000;
    store.save_rule(&edited).unwrap();
    engine.reload(&store, 3_000).unwrap();
    assert_eq!(
        engine.runtime.arm_state("au-b", "tm-1"),
        ArmState::Unseen,
        "an edit resets that rule's arm state — Q11"
    );
}

/// A reload that changes nothing must change nothing. Without this the test above passes for an
/// implementation that only preserves state when some OTHER rule changed.
#[test]
fn an_identical_reload_is_a_no_op_for_every_rule() {
    let store = AutomationStore::new_in_memory();
    store.save_rule(&rule("au-a", r"ctx:(\d+)%")).unwrap();
    let engine = AutomationEngine::new(0);
    engine.reload(&store, 1_000).unwrap();
    engine.runtime.set_arm("au-a", "tm-1", ArmState::Fired { at_ms: 500 });

    engine.reload(&store, 2_000).unwrap();
    assert_eq!(engine.runtime.arm_state("au-a", "tm-1"), ArmState::Fired { at_ms: 500 });
}

/// "Un-ticking puts it back." An exclusion is a filter over the matched set, never a deletion from
/// it — and this must hold on a FROZEN (`follow_new: false`) rule, which is the case that can bake
/// the exclusion in. Spec §B3. Distinct timestamps are load-bearing: reload compares `updated_at`,
/// not content, so a same-millisecond save would not clear the set and the test would pass
/// vacuously.
#[test]
fn lifting_an_exclusion_restores_the_terminal_on_a_frozen_rule() {
    let fake = Arc::new(
        crate::automation_engine::test_host::FakeHost::new()
            .with_terminal("tm-a", "pc-a", "a")
            .with_terminal("tm-b", "pc-b", "b"),
    );
    let host: Arc<dyn crate::automation_engine::host::EngineHost> = fake.clone();
    let engine = Arc::new(AutomationEngine::new(0));

    let mut r = rule("au-frozen", r"ctx:(\d+)%");
    r.target_mode = TargetMode::Rule;
    r.criterion = Criterion::AllTerminals;
    r.criterion_value.clear();
    r.follow_new = false;
    r.updated_at = 1_000;
    fake.store.save_rule(&r).unwrap();
    engine.reload(&fake.store, 1_000).unwrap();
    crate::automation_engine::loops::targeting_tick(&engine, &host, 1_000);
    assert_eq!(
        engine.runtime.watched_for("au-frozen"),
        HashSet::from(["tm-a".to_string(), "tm-b".to_string()]),
        "premise: the frozen base set contains both terminals"
    );

    r.excluded_ids = vec!["tm-b".into()];
    r.updated_at = 2_000;
    fake.store.save_rule(&r).unwrap();
    engine.reload(&fake.store, 2_000).unwrap();
    assert!(
        engine.runtime.watched_for("au-frozen").is_empty(),
        "the changed timestamp must clear the frozen set before the next targeting pass"
    );
    crate::automation_engine::loops::targeting_tick(&engine, &host, 2_000);
    assert_eq!(
        engine.runtime.watched_for("au-frozen"),
        HashSet::from(["tm-a".to_string()]),
        "the exclusion filters tm-b from the frozen base set"
    );

    r.excluded_ids.clear();
    r.updated_at = 3_000;
    fake.store.save_rule(&r).unwrap();
    engine.reload(&fake.store, 3_000).unwrap();
    assert!(
        engine.runtime.watched_for("au-frozen").is_empty(),
        "lifting the exclusion must also clear the filtered frozen set"
    );
    crate::automation_engine::loops::targeting_tick(&engine, &host, 3_000);
    assert_eq!(
        engine.runtime.watched_for("au-frozen"),
        HashSet::from(["tm-a".to_string(), "tm-b".to_string()]),
        "the original matched terminal returns after a real save and reload"
    );
}

// -----------------------------------------------------------------------------------------
// §7.8 — completion is an in-memory event first
// -----------------------------------------------------------------------------------------

/// The half of R6 that a reload-based test cannot see: a completed rule must leave the live set
/// **in this session**, because `reload` runs from mutating store commands and completion is
/// raised by the engine, which is not one.
#[test]
fn a_completed_rule_leaves_the_live_set_without_waiting_for_a_reload() {
    let store = AutomationStore::new_in_memory();
    store.save_rule(&rule("au-once", r"ctx:(\d+)%")).unwrap();
    store.save_rule(&rule("au-other", r"ctx:(\d+)%")).unwrap();
    let engine = AutomationEngine::new(0);
    engine.reload(&store, 1_000).unwrap();
    engine.runtime.set_arm("au-once", "tm-1", ArmState::Fired { at_ms: 5 });
    engine.runtime.set_arm("au-other", "tm-1", ArmState::Fired { at_ms: 5 });
    engine.runtime.set_watched("au-once", ["tm-1".to_string()].into());
    engine.runtime.push_echo("tm-1", "hand off now", 99_999);

    engine.complete_rule("au-once");

    assert_eq!(live_ids(&engine), vec!["au-other"]);
    assert!(!engine.is_live("au-once"));
    assert_eq!(engine.runtime.arm_state("au-once", "tm-1"), ArmState::Unseen);
    assert!(engine.runtime.watched_for("au-once").is_empty());
    assert_eq!(
        engine.runtime.arm_state("au-other", "tm-1"),
        ArmState::Fired { at_ms: 5 },
        "completing one rule must not disturb another"
    );
    assert_eq!(
        engine.runtime.echoes_for("tm-1", 0),
        vec!["hand off now".to_string()],
        "echo needles are the TERMINAL's, not the rule's — §2.6 keys them that way so overlapping              rules recognise each other's injections"
    );
}

// -----------------------------------------------------------------------------------------
// §10.18d (local half) — the runtime object the row pills read
// -----------------------------------------------------------------------------------------

/// **Non-empty at first paint**, which is the whole point: `automationRowState` reads this, and an
/// empty object paints *Armed · waiting, Never fired* for every row forever while nothing fails.
#[test]
fn the_state_payload_is_populated_before_anything_has_ever_fired() {
    let store = AutomationStore::new_in_memory();
    store.save_rule(&rule("au-a", r"ctx:(\d+)%")).unwrap();
    let engine = AutomationEngine::new(0);
    engine.reload(&store, 1_000).unwrap();
    engine
        .runtime
        .set_watched("au-a", ["tm-1".to_string(), "tm-2".to_string()].into());

    let payload = engine.state_payload(&HashMap::new());
    let pairs = payload.rules.get("au-a").expect("the live rule must appear");
    assert_eq!(pairs.len(), 2, "one entry per watched terminal, before any evaluation");
    let p = &pairs["tm-1"];
    assert_eq!(p.state, "unseen");
    assert_eq!(p.fired_count, 0);
    assert_eq!(p.last_fired_at, None);
    assert!(!p.missing);
}

/// The three states of a rule's matched set, as a table — because two of them are an empty map
/// and the row treats them as opposites.
///
/// Never resolved => ABSENT, which the row reads as `waiting`. Resolved to nothing => PRESENT
/// and empty, which is the *Nothing to watch* error. Resolved to something => the pairs.
///
/// The middle row is the one that makes the first row safe: hiding an unresolved rule must not
/// also hide a rule that genuinely matches no terminal, or the error becomes unreachable.
#[test]
fn a_rule_is_absent_until_targeting_resolves_it_and_empty_only_when_nothing_matches() {
    let store = AutomationStore::new_in_memory();
    store.save_rule(&rule("au-a", r"ctx:(\d+)%")).unwrap();
    let engine = AutomationEngine::new(0);
    engine.reload(&store, 1_000).unwrap();

    assert!(
        !engine.state_payload(&HashMap::new()).rules.contains_key("au-a"),
        "a live rule the targeting loop has not reached yet must not claim nothing matches it",
    );

    engine.runtime.set_watched("au-a", HashSet::new());
    let resolved_to_nothing = engine.state_payload(&HashMap::new());
    assert_eq!(
        resolved_to_nothing.rules.get("au-a").map(|p| p.len()),
        Some(0),
        "resolved-and-matching-nothing is still reported, as an empty map",
    );

    engine.runtime.set_watched("au-a", ["tm-1".to_string()].into());
    assert_eq!(
        engine.state_payload(&HashMap::new()).rules["au-a"].len(),
        1,
    );
}

/// Every field moves for the right reason — and `fired_count` survives a re-arm, which is what
/// `arm` alone structurally cannot express.
#[test]
fn the_state_payload_reports_arm_state_fire_history_and_missing_separately() {
    let store = AutomationStore::new_in_memory();
    store.save_rule(&rule("au-a", r"ctx:(\d+)%")).unwrap();
    let engine = AutomationEngine::new(0);
    engine.reload(&store, 1_000).unwrap();
    engine
        .runtime
        .set_watched("au-a", ["tm-live".to_string(), "tm-gone".to_string()].into());

    engine.runtime.record_fire("au-a", "tm-live", 4_000);
    engine.runtime.record_fire("au-a", "tm-live", 9_000);
    engine.runtime.set_arm("au-a", "tm-live", ArmState::re_armed());

    let missing: HashMap<String, HashSet<String>> =
        [("au-a".to_string(), ["tm-gone".to_string()].into())].into();
    let payload = engine.state_payload(&missing);
    let pairs = &payload.rules["au-a"];

    let live = &pairs["tm-live"];
    assert_eq!(live.state, "armed", "re-armed is still `armed` to a row pill");
    assert_eq!(live.fired_count, 2, "the count must survive the re-arm that cleared `at_ms`");
    assert_eq!(live.last_fired_at, Some(9_000));
    assert!(!live.missing);

    let gone = &pairs["tm-gone"];
    assert!(gone.missing, "a pinned id that is not live is dormant, and says so");
    assert_eq!(gone.fired_count, 0);
}

/// **§7's `pending`: the parked deadline reaches the wire, per pair.**
///
/// `parked_at` had exactly one reader before this — `runtime.rs`'s own tests — so a park was a
/// fact the engine held and no window could see, and the row went on reading the ARM machine,
/// which says `Fired` from the moment the crossing is decided and knows nothing about the wait
/// that follows. That is the one-row-two-answers shape: *Fired · waiting to re-arm* over a
/// message that has not been typed.
///
/// Two terminals, because the field is pair-keyed and a one-terminal fixture cannot tell a
/// per-pair deadline from a per-rule one.
#[test]
fn the_state_payload_carries_each_pair_s_parked_deadline() {
    let store = AutomationStore::new_in_memory();
    store.save_rule(&rule("au-a", r"ctx:(\d+)%")).unwrap();
    let engine = AutomationEngine::new(0);
    engine.reload(&store, 1_000).unwrap();
    engine
        .runtime
        .set_watched("au-a", ["tm-waiting".to_string(), "tm-idle".to_string()].into());

    engine.runtime.park(
        "au-a",
        "tm-waiting",
        crate::automation::runtime::ParkedSend {
            due_at_ms: 31_000,
            pc: "pc-1".to_string(),
            captures: None,
            prev: ArmState::Unseen,
            label: None,
        },
    );

    let pairs = &engine.state_payload(&HashMap::new()).rules["au-a"];
    assert_eq!(
        pairs["tm-waiting"].parked_at,
        Some(31_000),
        "the deadline the row counts down to never left the engine"
    );
    assert_eq!(
        pairs["tm-idle"].parked_at, None,
        "a pair with nothing parked must not inherit its sibling's countdown"
    );

    // And it goes away when the send is drained, rather than lingering as a countdown to a
    // moment that has passed.
    engine.runtime.take_parked_due("au-a", "tm-waiting", 31_000).expect("ripe");
    let after = &engine.state_payload(&HashMap::new()).rules["au-a"];
    assert_eq!(after["tm-waiting"].parked_at, None);
}

/// One function behind the event and behind first paint, so §10.18d's "they agree" is true by
/// construction rather than by two implementations happening to match.
#[test]
fn the_event_payload_and_first_paint_are_the_same_function() {
    let store = AutomationStore::new_in_memory();
    store.save_rule(&rule("au-a", r"ctx:(\d+)%")).unwrap();
    let engine = AutomationEngine::new(0);
    engine.reload(&store, 1_000).unwrap();
    engine.runtime.set_watched("au-a", ["tm-1".to_string()].into());

    let a = engine.state_payload(&HashMap::new());
    let b = engine.state_payload(&HashMap::new());
    assert_eq!(
        serde_json::to_string(&a).unwrap(),
        serde_json::to_string(&b).unwrap()
    );
}

/// Launch must not look like shutdown, and `stop` must be the only thing that changes that.
#[test]
fn a_fresh_engine_is_not_stopping_until_it_is_stopped() {
    let engine = AutomationEngine::new(1_700_000_000_000);
    assert!(!engine.is_stopping(), "a fresh engine must not read as shutting down");
    engine.stop();
    assert!(engine.is_stopping());
    // Idempotent: `RunEvent::Exit` can fire more than once on some shutdown paths.
    engine.stop();
    assert!(engine.is_stopping());
}

/// The grace in §4.5 is measured from THIS process's engine start, so the value has to survive
/// construction rather than being recomputed by whoever asks.
#[test]
fn the_engine_remembers_when_it_started() {
    assert_eq!(AutomationEngine::new(1_700_000_000_000).started_at_ms(), 1_700_000_000_000);
    assert_eq!(AutomationEngine::default().started_at_ms(), 0);
}

/// One runtime, reachable through the engine — `AppState` holds the engine, and
/// `cleanup_terminal_state` reaches the maps through it. Two owners would be two lifetimes.
#[test]
fn the_engine_owns_the_one_runtime_every_caller_sees() {
    let engine = AutomationEngine::new(0);
    engine.runtime.set_arm("au-1", "tm-1", ArmState::Fired { at_ms: 5 });
    let shared = engine.runtime.clone();
    assert_eq!(shared.arm_state("au-1", "tm-1"), ArmState::Fired { at_ms: 5 });
    shared.forget_terminal("tm-1");
    assert_eq!(
        engine.runtime.arm_state("au-1", "tm-1"),
        ArmState::Unseen,
        "a clone of the Arc must be the same runtime, not a copy of it"
    );
}
