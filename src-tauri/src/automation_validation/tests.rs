use super::*;
use crate::automation_store::{
    ActionStep, Cadence, Clause, CompareOp, CondStep, MonitorStep, ParsePreset, ParseStep,
    ReadMode, SendTo, TimerStep,
};
use crate::automation_store::{AutomationRule, Criterion, TargetMode};

/// The same graph as a PRESENCE rule. `keep` is deliberately left at whatever the caller passed:
/// the point is that a text rule carries the field and never reads it.
fn text_graph(find: &str, keep: Keep) -> AutomationGraph {
    let mut g = graph(find, keep);
    g.cond = Some(CondStep { finds: Finds::Event, ..Default::default() });
    g
}

fn graph(find: &str, keep: Keep) -> AutomationGraph {
    AutomationGraph {
        layout: None,
        timer: None,
        monitor: Some(MonitorStep { read: ReadMode::NewOutput, cadence: Cadence::OnOutput, every_ms: 0, skip_typed_line: false }),
        parse: Some(ParseStep { preset: ParsePreset::Custom, literal: None, find: find.into(), keep }),
        cond: Some(CondStep { finds: Finds::Reading, op: Some(CompareOp::Gt), threshold: Some(25.0), ..Default::default() }),
        action: Some(ActionStep {
            message: "m".into(),
            send_to: SendTo::Matched,
            submit: true,
            cli_type: "default".into(),
            substitute: false,
        }),
        webhook: None,
    }
}

fn blocks(g: &AutomationGraph) -> bool {
    pattern_problems(g).iter().any(Problem::blocks)
}

#[test]
fn the_canonical_pattern_is_clean() {
    assert!(pattern_problems(&graph(r"ctx:(\d+)%", Keep::Brackets)).is_empty());
}

/// §10.2b's blocking half — the counterpart to `extract` refusing to fall back.
#[test]
fn brackets_with_no_capture_group_blocks() {
    assert!(blocks(&graph(r"\d+", Keep::Brackets)));
    assert!(
        !blocks(&graph(r"\d+", Keep::Whole)),
        "the same pattern is fine when the whole match IS the value"
    );
}

#[test]
fn an_uncompilable_pattern_blocks_and_says_why() {
    let problems = pattern_problems(&graph(r"ctx:(\d+%", Keep::Brackets));
    assert!(problems.iter().any(Problem::blocks));
    assert!(
        problems[0].message.contains("could not be understood"),
        "got {:?}",
        problems[0].message
    );
    // A blocked compile must not also report "no brackets" — one cause, one message.
    assert_eq!(problems.len(), 1);
}

#[test]
fn an_empty_pattern_blocks() {
    assert!(blocks(&graph("   ", Keep::Brackets)));
    assert_eq!(pattern_problems(&graph("", Keep::Brackets)).len(), 1);
}

/// More than one group is unusual, not invalid — losing a user's work to a validation rule is its
/// own bug.
#[test]
fn more_than_one_group_warns_but_does_not_block() {
    let problems = pattern_problems(&graph(r"(\w+):(\d+)%", Keep::Brackets));
    assert_eq!(problems.len(), 1);
    assert_eq!(problems[0].severity, Severity::Warns);
    assert!(!blocks(&graph(r"(\w+):(\d+)%", Keep::Brackets)));
}

/// Naming a group `value` says which one is meant, so there is nothing to warn about.
#[test]
fn a_named_value_group_silences_the_multi_group_warning() {
    assert!(pattern_problems(&graph(r"(?<name>\w+):(?<value>\d+)%", Keep::Brackets)).is_empty());
}

/// `keep: whole` does not care how many groups there are.
#[test]
fn keep_whole_never_warns_about_groups() {
    assert!(pattern_problems(&graph(r"(\w+):(\d+)%", Keep::Whole)).is_empty());
}

/// R8's own canonical rule, and the dimension this suite was missing entirely: **a presence rule
/// needs no brackets whatever `keep` says**, because `re.is_match` never reads the field. Both
/// `keep` rules shipped scoped to the field instead of to the step that reads it, so every text
/// rule was refused by the enable path.
#[test]
fn a_presence_rule_is_never_judged_on_a_field_it_does_not_read() {
    for keep in [Keep::Brackets, Keep::Whole] {
        let g = text_graph(r"FAILED \d+ test", keep);
        assert!(
            pattern_problems(&g).is_empty(),
            "a text rule with keep={:?} has nothing wrong with it: {:?}",
            keep,
            pattern_problems(&g)
        );
        // Same scoping at the warning, not just the block — the group COUNT is not a text rule's
        // business either.
        let many = text_graph(r"(\w+):(\d+)%", keep);
        assert!(pattern_problems(&many).is_empty(), "got {:?}", pattern_problems(&many));
    }
}

/// The paired positive, so "never reports anything" cannot be how the test above passes: the same
/// group-less pattern IS a blocking problem for the numeric rule that actually reads `keep`.
#[test]
fn the_same_pattern_still_blocks_for_the_numeric_rule_that_reads_keep() {
    assert!(blocks(&graph(r"FAILED \d+ test", Keep::Brackets)));
    assert!(!blocks(&text_graph(r"FAILED \d+ test", Keep::Brackets)));
}

/// JS regex syntax is a superset, so a pattern that previews fine in the editor can fail here —
/// which is exactly why compilation is mandatory backend-side.
#[test]
fn a_js_only_construct_is_refused_rather_than_silently_accepted() {
    assert!(compile(r"(?=lookahead)").is_err(), "Rust's regex has no lookahead");
    assert!(compile(r"ctx:(\d+)%").is_ok());
}
// =============================================================================================
// §10.18b — the whole-rule rules, and R10's only backend oracle
// =============================================================================================

fn valid_rule() -> AutomationRule {
    AutomationRule {
        id: "au-1".into(),
        name: "ctx".into(),
        enabled: false,
        runs_once: false,
        target_mode: TargetMode::Pinned,
        criterion: Criterion::AllTerminals,
        criterion_value: String::new(),
        follow_new: true,
        target_ids: vec!["tm-1".into()],
        excluded_ids: vec![],
        exclude_criterion: None,
        exclude_criterion_value: String::new(),
        completed_at: None,
        verbose_until: None,
        sort_order: 1,
        schema_version: crate::automation_store::SUPPORTED_SCHEMA_VERSION,
        graph: graph(r"ctx:(\d+)%", Keep::Brackets),
        created_at: 1,
        updated_at: 1,
    }
}

fn fields(rule: &AutomationRule) -> Vec<String> {
    problems(rule).into_iter().filter(Problem::blocks).map(|p| p.field).collect()
}

/// The canonical rule is clean, which is what makes every row below able to fail.
#[test]
fn the_canonical_rule_has_nothing_wrong_with_it() {
    assert_eq!(problems(&valid_rule()), vec![], "the fixture itself is invalid");
}

/// **All five categories, as a table.** Each row breaks exactly one thing and names the step that
/// owns it, so the editor can point at the right panel — and so a rule that blocks for the wrong
/// reason fails here rather than being reported as "1 problem" and looking correct.
#[test]
fn each_of_the_five_categories_blocks_and_names_its_own_step() {
    let cases: Vec<(&str, Box<dyn Fn(&mut AutomationRule)>, &str)> = vec![
        (
            "a pinned rule with nothing picked",
            Box::new(|r: &mut AutomationRule| r.target_ids.clear()),
            "targets",
        ),
        (
            "a criterion rule with nothing to match on",
            Box::new(|r: &mut AutomationRule| {
                r.target_mode = TargetMode::Rule;
                r.criterion = Criterion::TabNameContains;
                r.criterion_value = "  ".into();
            }),
            "targets",
        ),
        (
            "a timer faster than the engine can tick",
            Box::new(|r: &mut AutomationRule| {
                r.graph.monitor_mut().cadence = Cadence::Timer;
                r.graph.monitor_mut().every_ms = MIN_TIMER_MS - 1;
            }),
            "monitor",
        ),
        (
            "a pattern that will not compile",
            Box::new(|r: &mut AutomationRule| r.graph.parse_mut().find = r"ctx:(\d+%".into()),
            "parse",
        ),
        (
            "a numeric rule with no threshold",
            Box::new(|r: &mut AutomationRule| r.graph.cond_mut().threshold = None),
            "cond",
        ),
        (
            "a numeric rule with no operator",
            Box::new(|r: &mut AutomationRule| r.graph.cond_mut().op = None),
            "cond",
        ),
        (
            "nothing to type",
            Box::new(|r: &mut AutomationRule| r.graph.action_mut().message = "   ".into()),
            "action",
        ),
    ];

    for (what, break_it, field) in cases {
        let mut rule = valid_rule();
        break_it(&mut rule);
        assert_eq!(fields(&rule), vec![field.to_string()], "{}", what);
    }
}

/// A criterion rule watching **all** terminals needs no value — the one criterion that is complete
/// on its own. Without this the rule above would refuse the simplest rule in the feature.
#[test]
fn watching_all_terminals_needs_no_criterion_value() {
    let mut rule = valid_rule();
    rule.target_mode = TargetMode::Rule;
    rule.criterion = Criterion::AllTerminals;
    rule.criterion_value = String::new();
    rule.target_ids.clear();
    assert_eq!(problems(&rule), vec![]);
}

/// A timer AT the floor is fine; only faster than the engine can tick is refused. The off-by-one
/// is the whole content of the rule.
#[test]
fn a_timer_exactly_at_the_floor_is_allowed() {
    let mut rule = valid_rule();
    rule.graph.monitor_mut().cadence = Cadence::Timer;
    rule.graph.monitor_mut().every_ms = MIN_TIMER_MS;
    assert_eq!(problems(&rule), vec![]);

    // And `every_ms` is meaningless for an output-driven rule, so it must not be judged there —
    // the struct carries the field whatever the cadence says.
    let mut on_output = valid_rule();
    on_output.graph.monitor_mut().cadence = Cadence::OnOutput;
    on_output.graph.monitor_mut().every_ms = 0;
    assert_eq!(problems(&on_output), vec![], "a field is judged by the step that READS it");
}

/// §2.6, told to the user before it happens — and **only a warning**, because the needle guard
/// handles it and losing work to a validation rule is its own bug.
#[test]
fn a_message_matching_its_own_pattern_warns_and_never_blocks() {
    let mut rule = valid_rule();
    rule.graph.parse_mut().find = "HANDOFF".into();
    rule.graph.cond = Some(CondStep { finds: Finds::Event, ..Default::default() });
    rule.graph.action_mut().message = "HANDOFF now".into();

    let found = problems(&rule);
    assert_eq!(found.len(), 1, "{:?}", found);
    assert_eq!(found[0].severity, Severity::Warns);
    assert_eq!(found[0].field, "action");
    assert!(fields(&rule).is_empty(), "a warning must not gate the toggle");
}

/// Blocking problems come first, whatever order they were found in: the row toggle's `title` shows
/// ONE of these, and showing a style note while the rule cannot run is the wrong one.
///
/// **The fixture is chosen so discovery order is warning-THEN-block.** The multi-group warning
/// comes from the pattern step and the empty message from the action step, which is two steps
/// later — so an implementation that never sorts fails here. The first version of this test broke
/// the targets step, whose block is discovered first anyway, and the mutant lived.
#[test]
fn blocking_problems_come_before_warnings() {
    let mut rule = valid_rule();
    rule.graph.parse_mut().find = r"ctx:(\d+)(%)".into();
    rule.graph.action_mut().message = String::new();

    let found = problems(&rule);
    assert_eq!(found.len(), 2, "{:?}", found);
    assert!(found[0].blocks() && found[0].field == "action", "{:?}", found);
    assert!(!found[1].blocks() && found[1].field == "parse", "{:?}", found);
}

// =============================================================================================
// PLAN 10.19b: THE SHARED FIXTURE
// =============================================================================================

/// **The whole point of this module.**
///
/// One case list, read by this test and by `automationValidation.test.ts`. Two implementations
/// of one rule set diverge the first time only one of them is edited, and the divergence is
/// silent in both directions: the editor greys a toggle the backend would have allowed, or the
/// editor allows one the backend refuses and the user's rule is rejected by a command they
/// cannot see.
///
/// It compares `(severity, field, code)` **in order**, not the prose. One case is an
/// uncompilable pattern, whose message quotes the regex engine's own error text — and Rust's
/// `regex` and the browser's `RegExp` word that differently, so a fixture keyed on the message
/// could only be satisfied by weakening every case to a prefix match. Each side asserts its own
/// wording separately; the fixture asserts they agree about WHAT is wrong.
#[test]
fn the_shared_fixture_agrees_case_for_case() {
    #[derive(serde::Deserialize)]
    struct Fixture {
        cases: Vec<Case>,
    }
    #[derive(serde::Deserialize)]
    struct Case {
        name: String,
        rule: AutomationRule,
        expected: Vec<Expected>,
    }
    #[derive(serde::Deserialize)]
    struct Expected {
        severity: Severity,
        field: String,
        code: String,
    }

    let raw = include_str!(
        "../../../src/renderer/components/Automation/__fixtures__/automationValidationCases.json"
    );
    let fixture: Fixture = serde_json::from_str(raw).expect("the shared fixture parses");

    // A fixture that shrank to nothing would pass this test by having nothing to disagree
    // about. The count is a floor, not the exact number, so adding a case is not a two-file
    // edit.
    assert!(
        fixture.cases.len() >= 66,
        "the shared fixture has shrunk to {} cases",
        fixture.cases.len()
    );

    let mut codes = std::collections::HashSet::new();
    for case in &fixture.cases {
        let got: Vec<(Severity, String, String)> = problems(&case.rule)
            .into_iter()
            .map(|p| (p.severity, p.field, p.code))
            .collect();
        let want: Vec<(Severity, String, String)> = case
            .expected
            .iter()
            .map(|e| (e.severity, e.field.clone(), e.code.clone()))
            .collect();
        assert_eq!(got, want, "fixture case: {}", case.name);
        codes.extend(case.expected.iter().map(|e| e.code.clone()));
    }

    // Every rule this module can report has to appear in the fixture, or the two
    // implementations are only pinned to each other on the paths someone remembered.
    //
    // **This list is HAND-TYPED and this side has no way to derive it.** A `code` here is a
    // `&'static str` handed to `Problem::new`, not a variant of anything, so there is no
    // exhaustive table for the compiler to check a new one against — where the TypeScript
    // mirror derives its list from `BADGES`, which is a `Record<ProblemCode, string>` and fails
    // `tsc` on a missing key. A twenty-first code added to both implementations with no fixture
    // case therefore stays green HERE until someone adds it below; the TS side is the one that
    // would go red. Said out loud rather than left to look symmetrical, because pretending both
    // halves are protected is worse than one that is not.
    for code in [
        "targets.empty",
        "targets.criterion",
        "targets.excludeValueEmpty",
        "monitor.interval",
        "parse.empty",
        "parse.uncompilable",
        "parse.noBrackets",
        "parse.manyGroups",
        "cond.incomplete",
        "cond.unknownToken",
        "cond.clauseNeedsValue",
        "cond.badClausePattern",
        "cond.clauseWithoutParse",
        "timer.delayTooShort",
        "timer.delayTooLong",
        "timer.badMinute",
        "timer.noDays",
        "timer.scheduleWithMonitor",
        "timer.neverRuns",
        "action.empty",
        "action.echo",
        "action.tokenWithoutParse",
        "action.unknownToken",
        "rule.noDestination",
        "webhook.urlEmpty",
        "webhook.urlMalformed",
        "webhook.urlNotHttps",
        "webhook.bodyEmpty",
        "webhook.bodyNotJson",
    ] {
        assert!(codes.contains(code), "no fixture case produces `{code}`");
    }
}

/// **A message must name a control that is on screen.** This one said *"Choose how to compare
/// the value, and the number to compare it with"* — the `<select>` and `<input>` pair that was
/// deleted when `CondPanel` became a clause list (§5.9). Choosing *A reading that stays true* on
/// a rule with no clauses reached it immediately, and the editor blocked with instructions for
/// two controls that no longer exist.
///
/// `automationValidation.ts` asserts the same sentence, character for character: the shared
/// fixture compares `code` rather than prose, so the words are pinned once per implementation
/// and a change to either one has to be made in both.
#[test]
fn cond_incomplete_names_a_control_that_is_on_screen() {
    let mut rule = valid_rule();
    rule.graph.cond = Some(CondStep { finds: Finds::Reading, ..Default::default() });

    let found = problems(&rule);
    let incomplete = found
        .iter()
        .find(|p| p.code == "cond.incomplete")
        .unwrap_or_else(|| panic!("a Reading rule with no clauses must be incomplete: {found:?}"));
    assert_eq!(
        incomplete.message,
        "Add a comparison — this rule reads a value but has nothing to compare it with."
    );
}

/// **The message names the Wait mode switch the editor actually offers.**
///
/// The complement is asserted in the same test, and it is what makes this a rule about
/// `DailyAt` rather than about timers: a DELAY on a watching rule is exactly what a delay is
/// for. `automationValidation.ts` asserts the same sentence, character for character.
#[test]
fn the_schedule_with_monitor_message_names_the_workable_mode_switch() {
    let mut scheduled = valid_rule();
    scheduled.graph.timer = Some(TimerStep {
        mode: TimerMode::DailyAt { minute_of_day: 540, days: WEEKDAY_BITS_MASK },
    });
    assert!(scheduled.graph.monitor.is_some(), "the canonical rule watches something");

    let found = problems(&scheduled);
    let clash = found
        .iter()
        .find(|p| p.code == "timer.scheduleWithMonitor")
        .unwrap_or_else(|| panic!("a schedule silences this rule's monitor: {found:?}"));
    assert_eq!(
        clash.message,
        "A schedule fires on the clock, so this rule will not read its terminals. \
         Switch the Wait step back to after a match."
    );
    assert!(clash.blocks(), "a monitor that silently never runs must not be saveable enabled");

    // A DELAY on a watching rule is the point of a delay.
    let mut delayed = valid_rule();
    delayed.graph.timer = Some(TimerStep { mode: TimerMode::AfterMatch { delay_ms: 30_000 } });
    assert!(
        !problems(&delayed).iter().any(|p| p.code == "timer.scheduleWithMonitor"),
        "a delay does not stop the rule watching"
    );

    // And a GENUINE schedule rule — no monitor, no parse, no cond, exactly §6.3's shape — has
    // no read chain left to silence. Clearing `monitor` alone is NOT this shape (I2): the
    // canonical rule's `parse` and `cond` are still `Some`, so a test that only cleared
    // `monitor` would have passed on the very predicate I2 widened past.
    let mut only_schedule = scheduled.clone();
    only_schedule.graph.monitor = None;
    only_schedule.graph.parse = None;
    only_schedule.graph.cond = None;
    assert!(
        !problems(&only_schedule).iter().any(|p| p.code == "timer.scheduleWithMonitor"),
        "a schedule rule with no read chain at all has nothing to silence"
    );
}

/// **I2 — the skip is of the whole read chain, not the monitor.** §6.3's walk skips
/// `host.tail` for the WHOLE rule, so `parse` and/or `cond` without a `monitor` are silently
/// ignored by a `DailyAt` rule exactly as a monitor would be. The old predicate
/// (`monitor.is_some()` alone) let a `parse` + `DailyAt` graph with no monitor through `reload`
/// to run on the clock and silently never read its pattern.
///
/// Swept over the three fields independently, so a fix that widened only one of them (say,
/// `parse` but not `cond`) is caught rather than a single hand-picked case passing by luck.
#[test]
fn schedule_with_monitor_widens_to_any_read_step_not_only_the_monitor() {
    let daily = TimerMode::DailyAt { minute_of_day: 540, days: WEEKDAY_BITS_MASK };

    let cases: Vec<(&str, Box<dyn Fn(&mut AutomationGraph)>)> = vec![
        ("monitor alone", Box::new(|g: &mut AutomationGraph| {
            g.parse = None;
            g.cond = None;
        })),
        ("parse alone", Box::new(|g: &mut AutomationGraph| {
            g.monitor = None;
            g.cond = None;
        })),
        ("cond alone", Box::new(|g: &mut AutomationGraph| {
            g.monitor = None;
            g.parse = None;
        })),
    ];
    for (name, mutate) in cases {
        let mut rule = valid_rule();
        rule.graph.timer = Some(TimerStep { mode: daily.clone() });
        mutate(&mut rule.graph);
        assert!(
            problems(&rule).iter().any(|p| p.code == "timer.scheduleWithMonitor"),
            "{name} left on a `DailyAt` rule must still block: {:?}",
            problems(&rule)
        );
    }

    // The paired negative: none of the three present has nothing left to silence.
    let mut none_left = valid_rule();
    none_left.graph.timer = Some(TimerStep { mode: daily });
    none_left.graph.monitor = None;
    none_left.graph.parse = None;
    none_left.graph.cond = None;
    assert!(!problems(&none_left).iter().any(|p| p.code == "timer.scheduleWithMonitor"));
}

// =============================================================================================
// R7 — a rule needs input steps XOR a schedule; anything else can never run
// =============================================================================================

/// **The oracle shape.** `blank → addStep 'timer' → addStep 'action' → type a message`: a Wait
/// step and an action, nothing that could ever cross the wait. Exactly one blocking problem —
/// not zero (this rule was previously admitted all the way to `reload`, which skipped it
/// silently) and not more than one (the default delay must not also trip `timer.delayTooShort`
/// or `timer.delayTooLong`).
#[test]
fn a_wait_with_nothing_to_cross_it_blocks_with_exactly_one_problem() {
    let mut rule = valid_rule();
    rule.graph.monitor = None;
    rule.graph.parse = None;
    rule.graph.cond = None;
    rule.graph.timer = Some(TimerStep { mode: TimerMode::AfterMatch { delay_ms: 30_000 } });
    rule.graph.action_mut().message = "resume".into();

    let found = problems(&rule);
    assert_eq!(
        found.iter().map(|p| p.code.as_str()).collect::<Vec<_>>(),
        vec!["timer.neverRuns"],
        "{found:?}"
    );
    assert!(found[0].blocks());
    assert_eq!(found[0].field, "timer");
    assert!(
        found[0].message.contains("Add one, or switch this Wait to run at a time of day"),
        "a Wait already on the canvas can be switched: {:?}",
        found[0].message
    );
}

/// **The wider shape (I2/R7 together): no timer at all, and no input steps either.** Reachable
/// through the API even though the editor cannot express "no steps, no timer, just a message" —
/// §3.1 makes all four of `monitor`/`parse`/`cond`/`timer` independently optional. The message
/// must not tell the user to "switch" a Wait step that does not exist (C1's own mistake).
#[test]
fn a_bare_graph_with_no_timer_and_no_input_steps_also_blocks() {
    let mut rule = valid_rule();
    rule.graph.monitor = None;
    rule.graph.parse = None;
    rule.graph.cond = None;
    rule.graph.timer = None;

    let found = problems(&rule);
    let never_runs = found
        .iter()
        .find(|p| p.code == "timer.neverRuns")
        .unwrap_or_else(|| panic!("a bare graph with no timer must still block: {found:?}"));
    assert!(
        !never_runs.message.to_lowercase().contains("switch"),
        "there is no Wait step on screen to switch: {:?}",
        never_runs.message
    );
    assert!(never_runs.message.contains("Add a Watch output step"));
}

/// **The paired negatives.** A genuine schedule rule (no input steps, but `DailyAt`) and an
/// ordinary rule (all three input steps, no timer at all) both run, and neither trips this code.
#[test]
fn a_schedule_or_a_complete_set_of_input_steps_never_trips_never_runs() {
    let scheduled = crate::automation_engine::test_host::schedule_only_rule("au-sched");
    assert!(
        !problems(&scheduled).iter().any(|p| p.code == "timer.neverRuns"),
        "{:?}",
        problems(&scheduled)
    );

    let mut ordinary = valid_rule();
    ordinary.graph.timer = None;
    assert!(
        !problems(&ordinary).iter().any(|p| p.code == "timer.neverRuns"),
        "{:?}",
        problems(&ordinary)
    );
}

/// **R7 and I2 are the two halves of one invariant, and a single graph must never trip both**
/// with contradictory advice (one saying "add a Watch step", the other "remove" one). They are
/// mutually exclusive by construction: `never_runs_problem` only fires when the rule is NOT
/// scheduled, and `timer.scheduleWithMonitor` only fires when it IS. Swept rather than asserted
/// for one shape, because "mutually exclusive by construction" is exactly the kind of claim a
/// single hand-picked case can make look true by accident.
#[test]
fn never_runs_and_schedule_with_monitor_are_mutually_exclusive() {
    for timer in [
        None,
        Some(TimerStep { mode: TimerMode::AfterMatch { delay_ms: 30_000 } }),
        Some(TimerStep {
            mode: TimerMode::DailyAt { minute_of_day: 540, days: WEEKDAY_BITS_MASK },
        }),
    ] {
        for (monitor, parse, cond) in [
            (true, true, true),
            (true, false, false),
            (false, true, false),
            (false, false, true),
            (false, false, false),
        ] {
            let mut rule = valid_rule();
            rule.graph.timer = timer.clone();
            if !monitor {
                rule.graph.monitor = None;
            }
            if !parse {
                rule.graph.parse = None;
            }
            if !cond {
                rule.graph.cond = None;
            }
            let found = problems(&rule);
            let codes: Vec<&str> = found.iter().map(|p| p.code.as_str()).collect();
            assert!(
                !(codes.contains(&"timer.neverRuns") && codes.contains(&"timer.scheduleWithMonitor")),
                "timer={timer:?} monitor={monitor} parse={parse} cond={cond}: {codes:?}"
            );
        }
    }
}

/// **Both delay bounds quote their own constant.** `timer.delayTooShort` restated its floor as
/// the literal words *"at least 1 second"* while `MIN_DELAY_MS` sat three lines above it, which
/// is a sentence that goes false the day the floor moves and says nothing when it does.
///
/// The cap's words are pinned here too, because they are the half that was WRONG: they blamed
/// the echo needle (see `MAX_DELAY_MS`), which no wait length can outlive.
/// `automationValidation.ts` asserts the same two sentences, built the same way.
#[test]
fn both_delay_bounds_quote_their_constant_rather_than_restating_it() {
    let with_delay = |delay_ms: i64| {
        let mut rule = valid_rule();
        rule.graph.timer = Some(TimerStep { mode: TimerMode::AfterMatch { delay_ms } });
        rule
    };

    let short = problems(&with_delay(MIN_DELAY_MS - 1));
    let short = short.iter().find(|p| p.code == "timer.delayTooShort").expect("under the floor");
    assert_eq!(
        short.message,
        format!("Wait at least {} second before sending.", MIN_DELAY_MS / 1_000)
    );

    let long = problems(&with_delay(MAX_DELAY_MS));
    let long = long.iter().find(|p| p.code == "timer.delayTooLong").expect("at the cap");
    assert_eq!(
        long.message,
        format!(
            "Wait less than {} minutes — a waiting message is held in memory and is lost if TermFlow quits.",
            MAX_DELAY_MS / 60_000
        )
    );
}

/// **`timer.badMinute` quotes the bound rather than restating it**, for the same reason both
/// delay bounds do: *"between 00:00 and 23:59"* typed out is a sentence that goes false the day
/// `MINUTES_PER_DAY` moves and says nothing when it does. The floor stays literal because zero is
/// what a minute-of-day counts from; there is no constant behind it to drift.
///
/// `automationValidation.ts` asserts this same sentence, built the same way — the shared fixture
/// compares `code`, so the words are pinned once per implementation.
#[test]
fn the_bad_minute_message_derives_the_last_minute_of_the_day() {
    let with_minute = |minute_of_day: i32| {
        let mut rule = valid_rule();
        rule.graph.timer = Some(TimerStep {
            mode: TimerMode::DailyAt { minute_of_day, days: WEEKDAY_BITS_MASK },
        });
        rule
    };

    let last = MINUTES_PER_DAY - 1;
    let want = format!("Pick a time between 00:00 and {:02}:{:02}.", last / 60, last % 60);
    assert_eq!(want, "Pick a time between 00:00 and 23:59.", "the derivation must read as a time");

    for minute in [-1, MINUTES_PER_DAY] {
        let found = problems(&with_minute(minute));
        let bad = found
            .iter()
            .find(|p| p.code == "timer.badMinute")
            .unwrap_or_else(|| panic!("minute_of_day {minute} is not a time of day: {found:?}"));
        assert_eq!(bad.message, want);
        assert!(bad.blocks(), "a schedule that cannot fire sensibly must not be saveable enabled");
    }

    // And the legal ends of the range report nothing at all.
    for minute in [0, MINUTES_PER_DAY - 1] {
        assert!(
            !problems(&with_minute(minute)).iter().any(|p| p.code == "timer.badMinute"),
            "minute_of_day {minute} is a time of day"
        );
    }
}

/// An empty pattern matches every position of every string, so an unguarded echo check told
/// every half-built draft that its message matched a pattern it does not have.
#[test]
fn an_empty_pattern_does_not_warn_about_an_echo() {
    let mut rule = AutomationRule {
        id: "au-1".into(),
        name: "r".into(),
        enabled: false,
        runs_once: false,
        target_mode: TargetMode::Rule,
        criterion: Criterion::AllTerminals,
        criterion_value: String::new(),
        follow_new: true,
        target_ids: vec![],
        excluded_ids: vec![],
        exclude_criterion: None,
        exclude_criterion_value: String::new(),
        completed_at: None,
        verbose_until: None,
        sort_order: 0,
        schema_version: 1,
        graph: graph("", Keep::Whole),
        created_at: 0,
        updated_at: 0,
    };
    rule.graph.cond = Some(CondStep { finds: Finds::Event, ..Default::default() });
    rule.graph.action_mut().message = "anything at all".into();

    let found = problems(&rule);
    assert_eq!(found.len(), 1, "only the empty pattern, no echo warning: {found:?}");
    assert_eq!(found[0].code, "parse.empty");
}

/// **`value: None` is the ordinary case, not an edge one**, and the comment this test used to
/// carry ("unreachable through the product") was wrong the day `CondPanel` became a clause
/// list: switching a row from a text operator to a numeric one mints a clause with no
/// threshold, which is precisely §8's *"a numeric clause with no threshold"*. It travels the
/// wire as `{"value":null}` and must block, not decode-fail.
///
/// The non-finite half stays a defensive check — no JSON literal spells `NaN` or `Infinity`, so
/// it is pinned here by constructing the clause in code rather than through the shared fixture:
/// a branch that is promised but never exercised is a coverage hole with a rationale
/// (`a-comment-that-forbids-a-test`), not proof the branch does what it claims.
#[test]
fn a_numeric_clause_with_no_usable_value_needs_a_value() {
    let mut g = graph(r"ctx:(\d+)%", Keep::Brackets);
    g.cond = Some(CondStep {
        finds: Finds::Event,
        clauses: vec![Clause {
            source: Source::Whole,
            test: Test::Number { op: CompareOp::Gt, value: None },
        }],
        ..Default::default()
    });

    // The reachable one first: nothing entered yet.
    assert_eq!(
        clause_problems(&g).iter().map(|p| p.code.as_str()).collect::<Vec<_>>(),
        vec!["cond.clauseNeedsValue"],
        "a numeric clause with no threshold is §8's own wording for this code"
    );

    g.cond_mut().clauses[0].test = Test::Number { op: CompareOp::Gt, value: Some(f64::NAN) };
    let found = clause_problems(&g);
    assert_eq!(
        found.iter().map(|p| p.code.as_str()).collect::<Vec<_>>(),
        vec!["cond.clauseNeedsValue"],
        "a non-finite clause value must report the same code as an empty text value: {found:?}"
    );

    // Paired: `f64::INFINITY` is also non-finite and must trip the same guard, not merely NaN.
    g.cond_mut().clauses[0].test = Test::Number { op: CompareOp::Gt, value: Some(f64::INFINITY) };
    let found = clause_problems(&g);
    assert_eq!(found.iter().map(|p| p.code.as_str()).collect::<Vec<_>>(), vec!["cond.clauseNeedsValue"]);

    // And the paired positive: an ordinary finite value reports nothing at all.
    g.cond_mut().clauses[0].test = Test::Number { op: CompareOp::Gt, value: Some(25.0) };
    assert!(clause_problems(&g).is_empty(), "a finite value must not be flagged");
}
