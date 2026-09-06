//! The Test button's evaluator (plan §6.5, §7.3, decision 9).
//!
//! **One function, whose whole design is that it cannot do the two things a dry run must not do.**
//! Every mutation the live path performs — `set_last_eval`, `set_arm`, and the send itself — lives in
//! `loops::evaluate_pair` and `loops::run_send`. The pure core it calls, `eval::evaluate`, takes the
//! arm state by value and returns a decision; it writes nothing. So this module reuses that core
//! verbatim and simply does not write, which is a stronger guarantee than a runtime flag: there is no
//! branch here that could take the wrong one.
//!
//! **There is deliberately no `Mode` enum.** §7.3 named this `evaluate_once(rule, tm, Mode::Dry)`, and
//! a `Mode::Live` variant would have no constructor: the live path is the three loops, which need a
//! `PendingSend` and not a `StepTrace`, so routing them through here would be a second implementation
//! rather than one. §7.3's actual requirement is *"reusing the pure core and the tail reader"* — that
//! is what a shared `eval::evaluate` call is — and M2's dual review already applied this exact ruling
//! to `watched_for`: a distinction nothing consumes is the inert scaffolding §2.1 rules against.
//! *Corrected in the plan.*
//!
//! **The verdict answers the CONDITION, not the arm machine.** The main use of the Test button is an
//! unsaved draft, which has no arm state to consult, and a rule that is working perfectly sits in
//! `Fired` — reporting *would not fire* for it would be the most confusing answer available. The arm
//! state is read for one reason only: §2.2c picks the read depth from it.

use crate::automation_engine::eval::{self, Outcome, Read, Truth};
use crate::automation_engine::host::{EngineHost, HostPort};
use crate::automation_engine::subst;
use crate::automation_engine::AutomationEngine;
use crate::automation_store::{AutomationLogEntry, AutomationRule, CompareOp, LogKind};

/// One step of the graph, as the editor's Test panel draws it.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepTrace {
    /// `monitor` | `parse` | `cond` | `action` — the graph's own four steps, always all four and
    /// always in this order, so the panel can draw the chain before it knows the answer.
    pub kind: String,
    /// `ok` | `failed` | `skipped`. `skipped` is a step that never ran because an earlier one failed;
    /// it is not a pass, and the panel must not draw it as one.
    pub status: String,
    pub detail: String,
}

/// What one dry run found.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DryRunReport {
    /// `would-fire` | `would-not-fire` | `unreadable`.
    ///
    /// `unreadable` is its own verdict rather than a *would not fire*: the rule was never judged at
    /// all, and telling a user their pattern does not match when nothing was read would send them off
    /// to edit a pattern that is fine.
    pub verdict: String,
    pub terminal_id: String,
    /// Resolved through `label_at`, exactly as a log row's is. `None` renders as an empty column and
    /// is never invented (§2.8).
    pub terminal_name: Option<String>,
    pub steps: Vec<StepTrace>,
}

pub const WOULD_FIRE: &str = "would-fire";
pub const WOULD_NOT_FIRE: &str = "would-not-fire";
pub const UNREADABLE: &str = "unreadable";

const MONITOR: &str = "monitor";
const PARSE: &str = "parse";
const COND: &str = "cond";
const ACTION: &str = "action";

fn step(kind: &str, status: &str, detail: String) -> StepTrace {
    StepTrace { kind: kind.to_string(), status: status.to_string(), detail }
}

fn skipped(kind: &str) -> StepTrace {
    step(kind, "skipped", "not reached".to_string())
}

fn symbol(op: CompareOp) -> &'static str {
    match op {
        CompareOp::Gt => ">",
        CompareOp::Gte => ">=",
        CompareOp::Lt => "<",
        CompareOp::Lte => "<=",
        CompareOp::Eq => "=",
        CompareOp::Neq => "!=",
    }
}

/// Run one rule against one terminal and report what each step did, **writing nothing anywhere except
/// the activity log** (plan §6.5, decision 9).
///
/// `rule` is passed by reference and may be an **unsaved draft** with an id that exists nowhere: that
/// is the point of taking the whole rule rather than an id, and it is what makes it physically
/// impossible for this path to load and touch a live rule's state.
pub fn evaluate_once(
    engine: &AutomationEngine,
    host: &dyn EngineHost,
    rule: &AutomationRule,
    tm: &str,
    now_ms: i64,
) -> DryRunReport {
    let terminal_name = host.label_for(tm);
    let pattern = rule.graph.parse.find.clone();

    let finish = |verdict: &str, steps: Vec<StepTrace>| -> DryRunReport {
        let report = DryRunReport {
            verdict: verdict.to_string(),
            terminal_id: tm.to_string(),
            terminal_name: terminal_name.clone(),
            steps,
        };
        // Decision 9: a test run is a row in the log like any other. `TestRun` is a Decision-class
        // kind, so the verbose gate cannot drop it — the user pressed a button and must see the line.
        let entry = AutomationLogEntry {
            id: 0,
            rule_id: rule.id.clone(),
            terminal_id: Some(tm.to_string()),
            terminal_name: terminal_name.clone(),
            kind: LogKind::TestRun,
            detail: format!("test run — {}", report.verdict),
            at: now_ms,
        };
        match host.store().append(&entry) {
            Ok(Some(outcome)) if outcome.emit => host.emit_activity(outcome.rule_ids),
            Ok(_) => {}
            Err(e) => log::warn!("automations: could not log the test run for {}: {}", rule.id, e),
        }
        report
    };

    // 1. Monitor. A terminal that is not live is not readable, and that is the whole answer.
    let Some(pc) = host.process_for_leaf(tm) else {
        return finish(
            UNREADABLE,
            vec![
                step(MONITOR, "failed", "that terminal is not open right now".to_string()),
                skipped(PARSE),
                skipped(COND),
                skipped(ACTION),
            ],
        );
    };

    // 2. The pattern has to compile before anything can be read for it. The editor's validation says
    //    the same thing, but a draft reaches this command whether or not the user looked at it.
    let re = match crate::automation_validation::compile(&pattern) {
        Ok(re) => re,
        Err(e) => {
            return finish(
                WOULD_NOT_FIRE,
                vec![
                    step(MONITOR, "ok", "the terminal is open".to_string()),
                    step(
                        PARSE,
                        "failed",
                        format!(
                            "that pattern could not be understood: {}",
                            e.lines().next().unwrap_or(&e).trim()
                        ),
                    ),
                    skipped(COND),
                    skipped(ACTION),
                ],
            );
        }
    };

    // 3. The same pure core the evaluator runs, over the same needle list, at the same depth. The arm
    //    state is READ (§2.2c picks the depth from it) and never written.
    let prev = engine.runtime.arm_state(&rule.id, tm);
    let echoes = engine.runtime.echoes_for(tm, now_ms);
    let port = HostPort(host);
    let Some(ev) = eval::evaluate(&rule.graph, &re, &echoes, prev, &port, &pc, now_ms) else {
        return finish(
            UNREADABLE,
            vec![
                step(MONITOR, "failed", "there is nothing to read from that terminal yet".to_string()),
                skipped(PARSE),
                skipped(COND),
                skipped(ACTION),
            ],
        );
    };

    let monitor = step(MONITOR, "ok", format!("read {}", eval::depth_words(ev.depth)));

    let parse = match &ev.outcome {
        Outcome::Numeric(Read::Value(v)) => {
            step(PARSE, "ok", format!("read {} from `{}`", eval::fmt_num(*v), pattern))
        }
        Outcome::Numeric(Read::Unparsed(saw)) => step(
            PARSE,
            "failed",
            // The one failure validation cannot catch: the pattern compiles, the capture is just the
            // wrong span. §2.2b, and this line is where a user meets it.
            format!("`{}` matched, but it captured `{}`, which is not a number", pattern, saw),
        ),
        Outcome::Numeric(Read::NoMatch) => step(
            PARSE,
            "failed",
            format!("nothing matching `{}` {}", pattern, eval::depth_words(ev.depth)),
        ),
        Outcome::Presence(true) => {
            step(PARSE, "ok", format!("`{}` matched {}", pattern, eval::depth_words(ev.depth)))
        }
        Outcome::Presence(false) => step(
            PARSE,
            "failed",
            format!("nothing matching `{}` {}", pattern, eval::depth_words(ev.depth)),
        ),
    };

    let cond = match (ev.condition, &ev.outcome) {
        (Truth::Unknown, _) => skipped(COND),
        (truth, Outcome::Numeric(Read::Value(v))) => {
            let (sym, t) = match (rule.graph.cond.op, rule.graph.cond.threshold) {
                (Some(op), Some(t)) => (symbol(op), eval::fmt_num(t)),
                // Unreachable through the enable path — a numeric rule with no operator is a blocking
                // validation problem — and `Unknown` above already caught it. Never a panic.
                _ => ("?", "?".to_string()),
            };
            let words = format!("{} {} {}", eval::fmt_num(*v), sym, t);
            match truth {
                Truth::True => step(COND, "ok", words),
                _ => step(COND, "failed", format!("{} is false", words)),
            }
        }
        (Truth::True, _) => step(COND, "ok", "the text is there".to_string()),
        (_, _) => step(COND, "failed", "the text is not there".to_string()),
    };

    let would_fire = ev.condition == Truth::True;
    let action = if would_fire {
        match preview_message(
            &rule.graph.action.message,
            rule.graph.action.substitute,
            ev.captures.as_ref(),
        ) {
            Ok(body) => step(
                ACTION,
                "ok",
                match &terminal_name {
                    Some(name) => format!("would type `{}` into {}", body, name),
                    None => format!("would type `{}`", body),
                },
            ),
            // §4.4: the same refusal `run_send` would make, reported rather than typed. The
            // verdict below still answers the CONDITION (it matched), and this row alone carries
            // that the send itself would be refused.
            Err(e) => step(
                ACTION,
                "failed",
                format!("nothing would be sent — `{}` had no value here", e),
            ),
        }
    } else {
        step(ACTION, "skipped", "nothing would be sent".to_string())
    };

    let verdict = if would_fire { WOULD_FIRE } else { WOULD_NOT_FIRE };
    finish(verdict, vec![monitor, parse, cond, action])
}

/// What the Test button says would be typed.
///
/// Delegates to `subst::substitute` rather than formatting the raw message, because the two
/// were independent implementations of one behaviour and a preview that disagrees with the send
/// is worse than no preview (§1.1).
pub fn preview_message(
    message: &str,
    substitute: bool,
    caps: Option<&eval::Captures>,
) -> Result<String, subst::SubstError> {
    if substitute { subst::substitute(message, caps) } else { Ok(message.to_string()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automation_engine::eval::{ArmState, Captures};
    use crate::automation_engine::test_host::*;
    use crate::automation_store::{CondStep, Finds, Keep, LogOrder, LogScope};

    fn kinds(report: &DryRunReport) -> Vec<&str> {
        report.steps.iter().map(|s| s.kind.as_str()).collect()
    }

    fn statuses(report: &DryRunReport) -> Vec<&str> {
        report.steps.iter().map(|s| s.status.as_str()).collect()
    }

    fn detail(report: &DryRunReport, kind: &str) -> String {
        report
            .steps
            .iter()
            .find(|s| s.kind == kind)
            .unwrap_or_else(|| panic!("no `{}` step in {:?}", kind, report.steps))
            .detail
            .clone()
    }

    fn log(store: &crate::automation_store::AutomationStore) -> Vec<(String, String)> {
        store
            .load_automation_log(&LogScope::All, LogOrder::Asc, 100)
            .unwrap()
            .into_iter()
            .map(|e| (format!("{:?}", e.kind), e.detail))
            .collect()
    }

    /// Every reader the runtime has, as one tuple. There is no serialisation to compare, so
    /// "byte-identical" is spelled as **every accessor**, which is the honest form of the claim: a
    /// dry run that wrote to a map this list forgot would still be caught by the list being complete.
    fn runtime_snapshot(
        engine: &AutomationEngine,
        rule_id: &str,
        tm: &str,
        pc: &str,
        now_ms: i64,
    ) -> (ArmState, Option<i64>, Option<(u32, i64)>, Vec<String>, bool, bool, usize) {
        (
            engine.runtime.arm_state(rule_id, tm),
            engine.runtime.last_eval(rule_id, tm),
            engine.runtime.fire_record(rule_id, tm),
            engine.runtime.echoes_for(tm, now_ms),
            engine.runtime.is_settling(tm, now_ms),
            engine.runtime.is_dirty(pc),
            engine.runtime.watched_for(rule_id).len(),
        )
    }

    // =============================================================================================
    // §10.17 — a dry run writes nothing
    // =============================================================================================

    /// **The rule is in `Fired` and its condition is true**, which is the state a working rule spends
    /// most of its life in and the one where a dry run that reused the live path would send a second
    /// message and advance the arm state. Nothing is typed and no map moves.
    #[test]
    fn a_dry_run_against_a_fired_rule_types_nothing_and_moves_no_state() {
        // **Every row is a state a LIVE evaluation would move.** The first version of this test used
        // only the last row — `Fired`, condition still true — and `next_state` returns that state
        // unchanged, so an implementation that wrote the arm state back was writing a no-op and the
        // mutant lived. A fixture that cannot distinguish the defect from correct behaviour is not a
        // test of it.
        let cases: &[(&str, ArmState, &str)] = &[
            ("ctx:63%\n", ArmState::Unseen, WOULD_FIRE),
            ("ctx:63%\n", ArmState::armed(), WOULD_FIRE),
            ("ctx:18%\n", ArmState::Fired { at_ms: 500 }, WOULD_NOT_FIRE),
            // Kept last, and it is the state a working rule spends its life in — the one the Test
            // button is actually pressed in, where a live evaluation would decide `held`.
            ("ctx:63%\n", ArmState::Fired { at_ms: 500 }, WOULD_FIRE),
        ];

        for (screen, prev, verdict) in cases {
            let (engine, fake, host) = wire(vec![ctx_rule("au-1")]);
            let rule = ctx_rule("au-1");
            engine.runtime.set_arm("au-1", "tm-1", *prev);
            engine.runtime.set_last_eval("au-1", "tm-1", 500);
            engine.runtime.record_fire("au-1", "tm-1", 500);
            engine.runtime.push_echo("tm-1", "an earlier message", 99_999);
            engine.runtime.mark_dirty("pc-1");
            fake.say("pc-1", screen);

            let before = runtime_snapshot(&engine, "au-1", "tm-1", "pc-1", 1_000);
            let report = evaluate_once(&engine, host.as_ref(), &rule, "tm-1", 1_000);

            assert_eq!(report.verdict, *verdict, "{}", screen);
            assert!(fake.written().is_empty(), "a dry run must type nothing: {:?}", fake.written());
            assert_eq!(
                runtime_snapshot(&engine, "au-1", "tm-1", "pc-1", 1_000),
                before,
                "{} from {:?}: a dry run must leave every runtime map exactly as it found it",
                screen,
                prev
            );

            // The one thing it DOES write, per decision 9.
            assert_eq!(
                log(&fake.store),
                vec![("TestRun".to_string(), format!("test run — {}", verdict))],
                "{}",
                screen
            );
        }
    }

    /// The verdict answers the CONDITION, not the arm machine — and this is where that shows. A live
    /// evaluation of this same pair decides `held`; reporting *would not fire* for a rule that is
    /// working perfectly is the most confusing answer the Test button could give, and an unsaved draft
    /// has no arm state to consult in the first place.
    #[test]
    fn the_verdict_is_about_the_condition_and_not_about_the_arm_state() {
        let (engine, fake, host) = wire(vec![ctx_rule("au-1")]);
        let rule = ctx_rule("au-1");
        fake.say("pc-1", "ctx:63%\n");

        for prev in [ArmState::Unseen, ArmState::armed(), ArmState::re_armed(), ArmState::Fired { at_ms: 5 }] {
            engine.runtime.set_arm("au-1", "tm-1", prev);
            let report = evaluate_once(&engine, host.as_ref(), &rule, "tm-1", 1_000);
            assert_eq!(report.verdict, WOULD_FIRE, "{:?}", prev);
            assert_eq!(engine.runtime.arm_state("au-1", "tm-1"), prev, "{:?} was moved", prev);
        }
    }

    /// An **unsaved draft** — an id that exists in no table — is testable, because the whole rule
    /// travels rather than an id. That is what makes it physically impossible for this path to load a
    /// live rule and touch its state.
    #[test]
    fn an_unsaved_draft_can_be_tested_and_touches_no_saved_rule() {
        let (engine, fake, host) = wire(vec![ctx_rule("au-saved")]);
        engine.runtime.set_arm("au-saved", "tm-1", ArmState::Fired { at_ms: 5 });
        fake.say("pc-1", "ctx:63%\n");

        let mut draft = ctx_rule("au-draft-never-saved");
        draft.graph.cond.threshold = Some(90.0);

        let report = evaluate_once(&engine, host.as_ref(), &draft, "tm-1", 1_000);

        assert_eq!(report.verdict, WOULD_NOT_FIRE, "63 is not above the draft's own threshold");
        assert_eq!(detail(&report, "cond"), "63 > 90 is false");
        assert_eq!(
            engine.runtime.arm_state("au-saved", "tm-1"),
            ArmState::Fired { at_ms: 5 },
            "testing a draft must not disturb the saved rule it was drafted from"
        );
        assert!(fake.store.list_rules().unwrap().iter().all(|r| r.id == "au-saved"));
    }

    // =============================================================================================
    // §10.17b — the failure validation cannot catch
    // =============================================================================================

    /// **`Unparsed` is the whole reason the Test button exists** (§2.2b): the pattern compiles, the
    /// capture is just the wrong span, so validation passes and the rule silently never fires. The
    /// parse step must fail and must say **what it saw**, because `63%` versus `63` is the entire
    /// difference and a bare "no match" sends the user off to rewrite a pattern that matched fine.
    #[test]
    fn a_dry_run_surfaces_a_capture_that_is_not_a_number() {
        let (engine, fake, host) = wire(vec![]);
        let mut rule = ctx_rule("au-1");
        rule.graph.parse.find = r"ctx:(\d+%)".into();
        fake.say("pc-1", "ctx:63%\n");

        let report = evaluate_once(&engine, host.as_ref(), &rule, "tm-1", 1_000);

        assert_eq!(report.verdict, WOULD_NOT_FIRE);
        assert_eq!(statuses(&report), vec!["ok", "failed", "skipped", "skipped"]);
        let parse = detail(&report, "parse");
        assert!(parse.contains("63%"), "it must say what it saw: {}", parse);
        assert!(parse.contains("not a number"), "{}", parse);
        assert!(fake.written().is_empty());
        assert_eq!(engine.runtime.arm_state("au-1", "tm-1"), ArmState::Unseen);
    }

    // =============================================================================================
    // The chain the panel draws
    // =============================================================================================

    /// **Always four steps, always in the graph's own order**, whatever happened — the panel draws the
    /// chain before it knows the answer, and a report that dropped the steps after a failure would
    /// leave it with three nodes and a gap.
    #[test]
    fn every_dry_run_reports_all_four_steps_in_the_graphs_own_order() {
        let (engine, fake, host) = wire(vec![]);
        let mut uncompilable = ctx_rule("au-1");
        uncompilable.graph.parse.find = r"ctx:(\d+%".into();
        let mut presence = ctx_rule("au-1");
        presence.graph.cond = CondStep { finds: Finds::Event, ..Default::default() };
        presence.graph.parse.find = "HANDOFF".into();
        presence.graph.parse.keep = Keep::Whole;

        // (what the terminal shows, the rule, the verdict, each step's status)
        let cases: Vec<(&str, AutomationRule, &str, Vec<&str>)> = vec![
            ("ctx:63%\n", ctx_rule("au-1"), WOULD_FIRE, vec!["ok", "ok", "ok", "ok"]),
            (
                "ctx:18%\n",
                ctx_rule("au-1"),
                WOULD_NOT_FIRE,
                vec!["ok", "ok", "failed", "skipped"],
            ),
            (
                "nothing here\n",
                ctx_rule("au-1"),
                WOULD_NOT_FIRE,
                // No value at all is `Unknown`, not false — there is nothing to compare, so the
                // condition step is `skipped` rather than claiming a comparison it never made.
                vec!["ok", "failed", "skipped", "skipped"],
            ),
            (
                "ctx:63%\n",
                uncompilable,
                WOULD_NOT_FIRE,
                vec!["ok", "failed", "skipped", "skipped"],
            ),
            ("HANDOFF\n", presence.clone(), WOULD_FIRE, vec!["ok", "ok", "ok", "ok"]),
            ("quiet\n", presence, WOULD_NOT_FIRE, vec!["ok", "failed", "failed", "skipped"]),
        ];

        for (screen, rule, verdict, want) in cases {
            fake.say("pc-1", screen);
            let report = evaluate_once(&engine, host.as_ref(), &rule, "tm-1", 1_000);
            assert_eq!(
                kinds(&report),
                vec!["monitor", "parse", "cond", "action"],
                "{:?}",
                report.steps
            );
            assert_eq!(report.verdict, verdict, "{:?}", report.steps);
            assert_eq!(statuses(&report), want, "{}: {:?}", screen, report.steps);
        }
    }

    /// A terminal that is not open is **`unreadable`, never `would-not-fire`**: the rule was never
    /// judged, and telling a user their pattern does not match would send them off to edit a pattern
    /// that is fine.
    #[test]
    fn a_terminal_that_is_not_open_is_unreadable_rather_than_a_pattern_failure() {
        let (engine, fake, host) = wire(vec![]);
        fake.leaves.lock().unwrap().clear();

        let report = evaluate_once(&engine, host.as_ref(), &ctx_rule("au-1"), "tm-1", 1_000);

        assert_eq!(report.verdict, UNREADABLE);
        assert_eq!(kinds(&report), vec!["monitor", "parse", "cond", "action"]);
        assert_eq!(statuses(&report), vec!["failed", "skipped", "skipped", "skipped"]);
        assert!(fake.written().is_empty());
        assert_eq!(log(&fake.store).len(), 1, "a test run is still a test run");
    }

    /// The row lands with **verbose logging off**, which is the point: `TestRun` is a Decision-class
    /// kind, so §3.3's gate cannot drop it. The user pressed a button and must see the line.
    #[test]
    fn the_test_run_is_logged_once_even_with_verbose_off() {
        let (engine, fake, host) = wire(vec![]);
        let rule = ctx_rule("au-1");
        assert_eq!(rule.verbose_until, None, "the gate is off, which is what makes this test able to fail");
        fake.say("pc-1", "ctx:18%\n");

        evaluate_once(&engine, host.as_ref(), &rule, "tm-1", 1_000);
        evaluate_once(&engine, host.as_ref(), &rule, "tm-1", 1_100);

        let rows = log(&fake.store);
        assert_eq!(rows.len(), 2, "one row per press, never rate-limited away: {:?}", rows);
        assert!(rows.iter().all(|(kind, _)| kind == "TestRun"), "{:?}", rows);
        assert!(rows[0].1.contains("would-not-fire"), "{:?}", rows);
    }

    /// The needles are stripped for a dry run too. Otherwise the Test button would report *would fire*
    /// on the engine's own message and send a user chasing a rule that is behaving correctly.
    #[test]
    fn a_dry_run_strips_this_terminals_echo_needles() {
        let (engine, fake, host) = wire(vec![]);
        let mut rule = ctx_rule("au-1");
        rule.graph.cond = CondStep { finds: Finds::Event, ..Default::default() };
        rule.graph.parse.find = "HANDOFF".into();
        rule.graph.parse.keep = Keep::Whole;
        fake.say("pc-1", "HANDOFF now\n");

        assert_eq!(
            evaluate_once(&engine, host.as_ref(), &rule, "tm-1", 1_000).verdict,
            WOULD_FIRE,
            "organic text must match"
        );

        engine.runtime.push_echo("tm-1", "HANDOFF now", 99_999);
        assert_eq!(
            evaluate_once(&engine, host.as_ref(), &rule, "tm-1", 1_000).verdict,
            WOULD_NOT_FIRE,
            "the same text, once it is known to be this engine's own echo"
        );
    }

    /// Every operator gets its symbol, and the value and threshold are both printed — the step a user
    /// reads to find out *why* `63` did not clear `90`.
    #[test]
    fn the_condition_step_prints_the_comparison_it_actually_made() {
        let (engine, fake, host) = wire(vec![]);
        fake.say("pc-1", "ctx:63%\n");
        let cases = [
            (CompareOp::Gt, 25.0, WOULD_FIRE, "63 > 25"),
            (CompareOp::Gte, 63.0, WOULD_FIRE, "63 >= 63"),
            (CompareOp::Lt, 25.0, WOULD_NOT_FIRE, "63 < 25 is false"),
            (CompareOp::Lte, 63.0, WOULD_FIRE, "63 <= 63"),
            (CompareOp::Eq, 63.0, WOULD_FIRE, "63 = 63"),
            (CompareOp::Neq, 63.0, WOULD_NOT_FIRE, "63 != 63 is false"),
        ];
        for (op, threshold, verdict, words) in cases {
            let mut rule = ctx_rule("au-1");
            rule.graph.cond.op = Some(op);
            rule.graph.cond.threshold = Some(threshold);
            let report = evaluate_once(&engine, host.as_ref(), &rule, "tm-1", 1_000);
            assert_eq!(report.verdict, verdict, "{:?}", op);
            assert_eq!(detail(&report, "cond"), words, "{:?}", op);
        }
    }

    /// The action step names the message and the terminal, and says it **would** type — it is the
    /// sentence a user checks before enabling a rule that types into a live agent.
    #[test]
    fn the_action_step_names_what_would_be_typed_and_where() {
        let (engine, fake, host) = wire(vec![]);
        fake.say("pc-1", "ctx:63%\n");

        let report = evaluate_once(&engine, host.as_ref(), &ctx_rule("au-1"), "tm-1", 1_000);

        assert_eq!(report.terminal_name.as_deref(), Some("codex · core"));
        assert_eq!(
            detail(&report, "action"),
            "would type `prepare to do context-hand-off` into codex · core"
        );
        assert_eq!(report.terminal_id, "tm-1");
    }

    // =============================================================================================
    // §1.1 — the preview must not disagree with the send
    // =============================================================================================

    /// The whole point of the shared module. This asserts the RELATION, not two hard-coded strings —
    /// a test that pins both to "Fix the 17 …" passes even if both are wrong in the same way.
    #[test]
    fn the_preview_and_the_send_resolve_identically() {
        let caps = Captures {
            groups: vec![
                Some("FAILED 17 tests in a.ts".into()),
                Some("17".into()),
                Some("a.ts".into()),
            ],
            named: Default::default(),
        };
        let msg = "Fix the $1 failing tests in $2";
        let sent = subst::substitute(msg, Some(&caps)).unwrap();
        let previewed = preview_message(msg, true, Some(&caps)).unwrap();
        assert_eq!(previewed, sent);
    }

    #[test]
    fn the_preview_says_it_would_send_nothing_when_a_token_is_unresolvable() {
        let caps = Captures { groups: vec![Some("x".into())], named: Default::default() };
        assert!(preview_message("Fix $3", true, Some(&caps)).is_err());
    }

    /// The call site, not just the helper: with substitution on and every token resolvable, the
    /// action row shows the RESOLVED text, exactly as `run_send` would type it — never the raw
    /// template with `$1` still in it.
    #[test]
    fn the_action_step_resolves_tokens_through_the_shared_helper() {
        let (engine, fake, host) = wire(vec![]);
        let mut rule = ctx_rule("au-1");
        rule.graph.parse.find = r"FAILED (\d+) tests in (\S+)".into();
        rule.graph.cond = CondStep { finds: Finds::Event, ..Default::default() };
        rule.graph.action.message = "Fix the $1 failing tests in $2".into();
        rule.graph.action.substitute = true;
        fake.say("pc-1", "FAILED 17 tests in a.ts");

        let report = evaluate_once(&engine, host.as_ref(), &rule, "tm-1", 1_000);

        assert_eq!(report.verdict, WOULD_FIRE);
        assert_eq!(
            detail(&report, "action"),
            "would type `Fix the 17 failing tests in a.ts` into codex · core"
        );
    }

    /// §4.4's refusal, reported by the Test button rather than typed. **The verdict still answers the
    /// CONDITION** (it matched — this is the row a user must see to press Enable in the first place),
    /// while the action row alone carries that the send itself would be refused, exactly as
    /// `run_send`'s own refusal is a log line rather than a change to whether the crossing fired.
    #[test]
    fn the_action_step_names_the_token_it_could_not_resolve() {
        let (engine, fake, host) = wire(vec![]);
        let mut rule = ctx_rule("au-1");
        rule.graph.parse.find = r"FAILED (\d+)".into();
        rule.graph.cond = CondStep { finds: Finds::Event, ..Default::default() };
        rule.graph.action.message = "Fix $3".into();
        rule.graph.action.substitute = true;
        fake.say("pc-1", "FAILED 17");

        let report = evaluate_once(&engine, host.as_ref(), &rule, "tm-1", 1_000);

        assert_eq!(report.verdict, WOULD_FIRE, "the condition still matched");
        assert_eq!(statuses(&report), vec!["ok", "ok", "ok", "failed"]);
        let action = detail(&report, "action");
        assert!(action.contains("$3"), "the failure row must name the token: {action}");
    }

    /// A `wire` with no rules keeps the engine's live set empty, so nothing here can accidentally be
    /// reading a loaded rule instead of the one it was handed.
    #[test]
    fn a_dry_run_never_consults_the_live_set() {
        let (engine, fake, host) = wire(vec![]);
        assert!(engine.snapshot_live().is_empty());
        fake.say("pc-1", "ctx:63%\n");

        let report = evaluate_once(&engine, host.as_ref(), &ctx_rule("au-1"), "tm-1", 1_000);
        assert_eq!(report.verdict, WOULD_FIRE, "a rule that is not live is still testable");
    }

    /// **Source-derived: this module cannot send.** "A dry run types nothing" is a claim about code
    /// that is NOT here, and a runtime assertion can only ever say "it did not this time" — the same
    /// gap §10.5's tap test closes the same way. Normalised for CRLF because `core.autocrlf` is on
    /// and there is no `.gitattributes`, so the file git checks out is not the file in a worktree that
    /// rewrote it.
    #[test]
    fn the_dry_run_module_contains_no_write_path() {
        // Comments stripped first: the module doc NAMES the mutations it does not perform, and a scan
        // that reads prose as code is a test of the writing rather than of the module. Through the
        // shared helper, which also normalises CRLF — `core.autocrlf` is on with no `.gitattributes`,
        // so the file git checks out is not the file a worktree rewrote.
        let source = crate::automation_engine::test_host::strip_comments(include_str!("dry.rs"));
        let end = source.find("#[cfg(test)]").expect("the test module must follow the code");
        let body = &source[..end];
        for forbidden in ["deliver(", "TerminalWriter", ".write(", "set_arm", "set_last_eval", "record_fire"] {
            assert!(
                !body.contains(forbidden),
                "`{}` in the dry run: it reads the runtime and writes nothing but the log",
                forbidden
            );
        }
        assert!(body.contains("eval::evaluate("), "and it must go through the SAME pure core");
    }

}
