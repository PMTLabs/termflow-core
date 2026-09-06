//! The Rust mirror of the editor's `automationValidation`.
//!
//! Two implementations of one rule set, sharing ONE case fixture so they cannot diverge silently. The
//! backend owns "is this rule allowed to run" and must not be talked into enabling an invalid rule by
//! a stale renderer: `set_automation_enabled` and any save with `enabled = true` re-check and refuse.
//! The boundary audit found the enable path bypassed entirely — the editor gated its own toggle, the
//! store validated nothing semantic, and the engine refused only an uncompilable pattern, so a rule
//! with no terminals and an empty message went live straight from the list row. Plan §7.8, R10.
//!
//! A `Problem` carries `severity`: only `blocks` gates the toggle. `warns` exists for the case a rule
//! whose own message text matches its own pattern (the echo failure of §2.6) and for a pattern with
//! more than one capture group (§2.2b) — unusual, not invalid, and losing work to a validation rule is
//! its own bug.
//!
//! **A save is gated only when the rule arrives enabled**, which is the same question as an enable
//! and is asked for the same reason: R10. A disabled draft with five problems is written exactly as
//! it was drawn. The editor never meets the refusal, because it saves a blocked draft with `enabled`
//! cleared rather than sending one the store would reject and stranding the user's work behind a
//! *Discard* button.
//!
//! **M2 lands `compile` and the PATTERN rules** — the ones §2.2b specifies and §10.2b gates, which are
//! about the parse step alone and need nothing but the graph. **M3 lands the whole-rule rules** (no
//! terminals, empty message, the echo warning) with the enable path, and **M5 the shared fixture**.

use regex::{Regex, RegexBuilder};

use crate::automation_engine::subst;
use crate::automation_store::{
    AutomationGraph, AutomationRule, Cadence, Criterion, Finds, Keep, Source, TargetMode, Test,
    TextOp,
};

/// Whether a problem stops the rule running, or merely tells the user something.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    Blocks,
    Warns,
}

/// One thing wrong with a draft, in the words the editor shows.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    pub severity: Severity,
    /// Which step owns it, so the editor can point at the right panel: `parse`, `cond`, `action`,
    /// `monitor`, `targets`.
    pub field: String,
    /// A stable identity for the RULE that fired, e.g. `parse.noBrackets`. **The shared fixture
    /// compares this, not the prose** (M5, §10.19b): one of these cases is an uncompilable pattern,
    /// whose message quotes the regex engine's own error text — and Rust's `regex` and the browser's
    /// `RegExp` word that differently, so a fixture keyed on the message could only be satisfied by
    /// weakening it to a prefix for every case. It is also what lets the editor pick a node badge
    /// per rule without sniffing the message for a substring.
    pub code: String,
    pub message: String,
}

impl Problem {
    pub fn blocks(&self) -> bool {
        self.severity == Severity::Blocks
    }

    fn new(severity: Severity, field: &str, code: &str, message: impl Into<String>) -> Self {
        Self {
            severity,
            field: field.to_string(),
            code: code.to_string(),
            message: message.into(),
        }
    }
}

/// Why the ENGINE refuses this pattern at load, or `None` if it will run it (§2.7).
///
/// **One function, two callers, and that is the point.** `AutomationEngine::reload` asks it before
/// admitting a rule, and `AutomationStore`'s save gate asks it to decide which pattern problem it may
/// let through — the save gate's whole justification is *"the engine re-checks this one"*, so the two
/// have to be the same question or the exemption is a hole.
///
/// It was a hole. The gate exempted every problem whose field is `parse`, and one of those is an
/// EMPTY pattern — which the regex crate compiles happily into an expression that matches every
/// position of every string. A presence rule saved enabled with `find = ""` was therefore admitted by
/// `reload`, matched the first byte any terminal printed, and typed into it. "Uncompilable" is not
/// the same set as "unusable", and only the first half was ever implemented.
pub fn pattern_refused_at_load(find: &str) -> Option<String> {
    if find.trim().is_empty() {
        return Some("this rule has nothing to look for".to_string());
    }
    match compile(find) {
        Ok(_) => None,
        Err(e) => Some(format!(
            "that pattern could not be understood: {}",
            e.lines().next().unwrap_or(&e).trim()
        )),
    }
}

/// Compile a user pattern, once, at rule load.
///
/// `size_limit(1 << 20)` bounds the compiled program rather than the input. Rust's `regex` has no
/// backtracking and guarantees linear-time matching, so a pattern typed into the editor cannot hang
/// the 250 ms evaluation loop — a guarantee the renderer's `RegExp` preview cannot make, which is why
/// compilation is mandatory here rather than merely convenient: JS regex syntax is a superset, so a
/// pattern that previews fine can fail to build.
///
/// **Compiles the pattern AS TYPED.** Leading and trailing whitespace is part of a regex — `"ctx: "`
/// and `"ctx:"` match different text — so trimming here would validate one expression and run
/// another. Emptiness is the one question asked of the trimmed text, because a pattern of nothing but
/// spaces is not a pattern the user meant to write.
pub fn compile(find: &str) -> Result<Regex, String> {
    RegexBuilder::new(find)
        .size_limit(1 << 20)
        .build()
        .map_err(|e| e.to_string())
}

/// Whether a captured token — a clause's [`Source`], or a message's `$N`/`${name}` — is one
/// `compiled`'s groups can actually supply.
///
/// **Shared by `cond.unknownToken` and `action.unknownToken`**, so a clause and a message can
/// never disagree about what `$2` means (plan 032 §8) — two different answers to "does this
/// pattern have a group 2" is the drift this milestone keeps having to fix.
fn token_supplied(compiled: &Regex, group: Option<usize>, name: Option<&str>) -> bool {
    match (group, name) {
        (Some(n), _) => n <= compiled.captures_len().saturating_sub(1),
        (None, Some(name)) => compiled.capture_names().any(|cn| cn == Some(name)),
        (None, None) => true, // $0 / Source::Whole is always the whole match.
    }
}

/// `$0` / `$2` / `${name}`, for a clause's own problem message.
///
/// `pub(crate)` rather than a second copy: `dry.rs`'s Test-pane wording for a clause list needs the
/// same token spelling this validator's own messages use — `two-implementations-one-fix`.
pub(crate) fn source_text(source: &Source) -> String {
    match source {
        Source::Whole => "$0".to_string(),
        Source::Group(n) => format!("${n}"),
        Source::Named(name) => format!("${{{name}}}"),
    }
}

/// Whether this rule has a working PARSE step to source clause tokens from.
///
/// **`parse` is not yet `Option`** — every rule carries a [`crate::automation_store::ParseStep`]
/// — so today "no parse step" means the declared pattern is blank, exactly what `parse.empty`
/// already reports on the `parse` field. When `parse` becomes optional (a later milestone's
/// schedule rule, plan 032 §6.3), this becomes
/// `graph.parse.as_ref().is_some_and(|p| !p.find.trim().is_empty())`, and every caller stays
/// correct because there is only this one call site to update.
fn has_parse_step(graph: &AutomationGraph) -> bool {
    !graph.parse.find.trim().is_empty()
}

/// Everything wrong with the COND step's clause list — §8's four `cond.*` codes (plan 032 §5.3,
/// §5.4).
///
/// **An empty list is legal and reports nothing.** It means "fire when the pattern matches",
/// exactly today's text rule — not a special case invented for this check, the existing
/// behaviour written down (§5.4).
fn clause_problems(graph: &AutomationGraph) -> Vec<Problem> {
    let mut out = Vec::new();
    let clauses = &graph.cond.clauses;
    if clauses.is_empty() {
        return out;
    }

    if !has_parse_step(graph) {
        out.push(Problem::new(
            Severity::Blocks,
            "cond",
            "cond.clauseWithoutParse",
            "This condition compares a captured value, but the rule has no pattern to capture it from.",
        ));
        return out;
    }

    // Only ask the pattern for its groups once it can compile — an uncompilable pattern is
    // already `parse.uncompilable`'s problem, not this one's, exactly like `action.unknownToken`.
    let compiled = compile(&graph.parse.find).ok();

    for clause in clauses {
        if let Some(re) = &compiled {
            let bad = match &clause.source {
                Source::Whole => false,
                Source::Group(n) => !token_supplied(re, Some(*n as usize), None),
                Source::Named(name) => !token_supplied(re, None, Some(name.as_str())),
            };
            if bad {
                let count = re.captures_len().saturating_sub(1);
                out.push(Problem::new(
                    Severity::Blocks,
                    "cond",
                    "cond.unknownToken",
                    format!(
                        "{} has nothing to stand for. The pattern in Read a value has {} bracketed \
                         group{}, so the highest you can use is ${}.",
                        source_text(&clause.source),
                        count,
                        if count == 1 { "" } else { "s" },
                        count
                    ),
                ));
            }
        }

        match &clause.test {
            Test::Number { value, .. } => {
                // **Reached by the ordinary path, not a defensive edge.** `value` is
                // `Option<f64>`, and `None` is what `CondPanel` writes the moment a row is
                // switched from a text operator to a numeric one, or a number is half-typed —
                // §8's *"a numeric clause with no threshold"* in the flesh. The finiteness half
                // stays for a value that arrives by computation rather than by typing: comparing
                // against NaN/Infinity is exactly the silent-failure shape `CompareOp::Neq`'s own
                // doc warns about for a COERCED token.
                if !value.is_some_and(f64::is_finite) {
                    out.push(Problem::new(
                        Severity::Blocks,
                        "cond",
                        "cond.clauseNeedsValue",
                        "Enter a number to compare this value with.",
                    ));
                }
            }
            Test::Text { op, value } => {
                let needs_value = !matches!(op, TextOp::IsEmpty | TextOp::IsNotEmpty);
                if needs_value && value.trim().is_empty() {
                    out.push(Problem::new(
                        Severity::Blocks,
                        "cond",
                        "cond.clauseNeedsValue",
                        "Enter some text to compare this value with.",
                    ));
                } else if *op == TextOp::Matches {
                    if let Err(e) = compile(value) {
                        out.push(Problem::new(
                            Severity::Blocks,
                            "cond",
                            "cond.badClausePattern",
                            format!(
                                "This clause's own pattern could not be understood: {}",
                                first_line(&e)
                            ),
                        ));
                    }
                }
            }
        }
    }

    out
}

/// Everything wrong with a rule's PARSE step. Ordered blocks-first, so a caller showing one shows the
/// one that matters.
pub fn pattern_problems(graph: &AutomationGraph) -> Vec<Problem> {
    let mut out = Vec::new();

    if graph.parse.find.trim().is_empty() {
        out.push(Problem::new(Severity::Blocks, "parse", "parse.empty", "Enter something to look for."));
        return out;
    }

    // The pattern AS TYPED, which is the one `reload` compiles and the engine runs. This used to
    // validate `find.trim()` and derive `captures_len` from it, so a pattern with edge whitespace was
    // checked as one expression and executed as another — three treatments of one field, across
    // `pattern_problems`, `reload` and `pattern_refused_at_load`. Now there is one: trimmed for the
    // emptiness question, verbatim for every other.
    let compiled = match compile(&graph.parse.find) {
        Ok(re) => re,
        Err(e) => {
            out.push(Problem::new(
                Severity::Blocks,
                "parse",
                "parse.uncompilable",
                format!("That pattern could not be understood: {}", first_line(&e)),
            ));
            return out;
        }
    };

    // `captures_len()` counts group 0, so a pattern with no capture group reports 1.
    let groups = compiled.captures_len().saturating_sub(1);
    let has_named_value = compiled.capture_names().any(|n| n == Some("value"));

    // `keep` is a NUMERIC-only concern. §2.2b's presence branch is `re.is_match(text)` — "no group,
    // no coercion, no `keep`" — and `Keep::Brackets` is the struct default a text rule carries around
    // without ever consulting it. Blocking on it refuses R8's own canonical rule
    // (`FAILED \d+ test`), so the entire word-matching half of the feature was un-enableable while
    // every test stayed green, because no test ran this against a text rule at all. That is the
    // `validation-rule-strands-a-scoped-default` class: a rule written for the step that READS a
    // field, applied to every rule that merely HAS it.
    let numeric = graph.cond.finds == Finds::Reading;

    if numeric && graph.parse.keep == Keep::Brackets && groups == 0 {
        // Never a silent fall-back to the whole match: the user asked for the bracketed part, and
        // comparing something else is how a rule types the wrong thing into a terminal.
        out.push(Problem::new(
            Severity::Blocks,
            "parse",
            "parse.noBrackets",
            "This pattern has no brackets, so there is no value to keep. \
             Put brackets around the part you want, or keep the whole match instead.",
        ));
    }

    if numeric && graph.parse.keep == Keep::Brackets && groups > 1 && !has_named_value {
        out.push(Problem::new(
            Severity::Warns,
            "parse",
            "parse.manyGroups",
            "This pattern has more than one bracketed group. The comparison uses the first one; \
name one of them `value` to use a different one instead. The rest are still available \
in the message, as $2, $3 and so on.",
        ));
    }

    out
}

/// The floor on a timer rule's interval.
///
/// `due_now` clamps anything faster to [`EVENT_MIN_INTERVAL_MS`], so a rule asking for 100 ms would
/// silently get 250 — and a validation rule that lets a user type a number the engine then ignores is
/// worse than one that says so.
pub const MIN_TIMER_MS: i64 = crate::automation_engine::due::EVENT_MIN_INTERVAL_MS;

/// Everything wrong with a WHOLE rule — §6.5's five categories: **target, interval, pattern,
/// threshold, message**.
///
/// Blocking problems come first, so a caller that shows one shows the one that matters (the row
/// toggle's `title` is exactly that caller). `pattern_problems` is delegated to rather than
/// re-derived: it is the half M2 landed and §10.2b gates, and two lists of pattern rules is the
/// `two-implementations-one-fix` shape this whole module exists to avoid.
///
/// **M5 mirrors this in TypeScript from a shared case fixture.** Until that fixture exists, the risk
/// is the documented one: a fixture written by the second implementation is a fixture shaped to make
/// the second implementation pass.
pub fn problems(rule: &AutomationRule) -> Vec<Problem> {
    let mut out = Vec::new();

    // --- target ---------------------------------------------------------------------------------
    // Only a PINNED rule can be empty in a way validation can see. A criterion rule that currently
    // matches nothing is not invalid — terminals open and close, and that is the entire point of
    // re-resolving every 2 s.
    match rule.target_mode {
        TargetMode::Pinned => {
            if rule.target_ids.is_empty() {
                out.push(Problem::new(
                    Severity::Blocks,
                    "targets",
                    "targets.empty",
                    "Pick at least one terminal for this rule to watch.",
                ));
            }
        }
        TargetMode::Rule => {
            let needs_value = !matches!(rule.criterion, Criterion::AllTerminals);
            if needs_value && rule.criterion_value.trim().is_empty() {
                out.push(Problem::new(
                    Severity::Blocks,
                    "targets",
                    "targets.criterion",
                    "Fill in what the terminals must match, or watch all terminals instead.",
                ));
            }
        }
    }

    // --- interval -------------------------------------------------------------------------------
    if rule.graph.monitor.cadence == Cadence::Timer && rule.graph.monitor.every_ms < MIN_TIMER_MS {
        out.push(Problem::new(
            Severity::Blocks,
            "monitor",
            "monitor.interval",
            format!("Check no more often than every {} ms.", MIN_TIMER_MS),
        ));
    }

    // --- pattern --------------------------------------------------------------------------------
    out.extend(pattern_problems(&rule.graph));

    // --- threshold ------------------------------------------------------------------------------
    // A numeric rule with no operator, no threshold, AND no clauses cannot be true of anything, and
    // `evaluate` reads it as `Truth::Unknown` forever — a rule that runs, logs, and can never fire.
    // `op` / `threshold` are v1-only (§5.3): a rule built in the clause-list editor leaves both
    // `None` and expresses its comparison as a clause instead, so an empty clause list is what
    // actually makes this incomplete, not a bare absence of `op`/`threshold`.
    if rule.graph.cond.finds == Finds::Reading
        && rule.graph.cond.clauses.is_empty()
        && (rule.graph.cond.op.is_none() || rule.graph.cond.threshold.is_none())
    {
        out.push(Problem::new(
            Severity::Blocks,
            "cond",
            "cond.incomplete",
            "Choose how to compare the value, and the number to compare it with.",
        ));
    }

    // --- clauses --------------------------------------------------------------------------------
    // §8's four `cond.*` codes: a clause sourcing a token the pattern cannot supply, a clause with
    // no value to compare, a `matches` clause whose own pattern will not compile, and any clause
    // at all on a rule with no pattern to read them from.
    out.extend(clause_problems(&rule.graph));

    // --- message --------------------------------------------------------------------------------
    if rule.graph.action.message.trim().is_empty() {
        out.push(Problem::new(
            Severity::Blocks,
            "action",
            "action.empty",
            "Enter the message this rule should type.",
        ));
    } else if !rule.graph.parse.find.trim().is_empty() {
        // §2.6's failure, told to the user before it happens: a rule whose own message matches its
        // own pattern reads its own echo. The needle guard handles it, which is why this WARNS —
        // but the guard has a TTL and a cap, and a user who can see the collision can avoid it.
        //
        // **The emptiness guard is load-bearing, not defensive.** An empty regex compiles into an
        // expression that matches every position of every string, so without it EVERY draft with a
        // message and no pattern yet — which is every draft in the seconds after it is created —
        // was told its message "matches the rule's own pattern". The one place the feature has to
        // be trusted with a warning about a subtle failure, spent on a rule that has no pattern at
        // all. Found by the M5 shared fixture: writing the expected list for the empty-pattern case
        // is what made it impossible not to see.
        // The pattern **as typed**, matching `pattern_problems` above and the engine below it. This
        // used to compile `find.trim()`, in a file whose own comment forbids exactly that: trimming
        // can only widen the match, so ` HANDOFF` — which the engine will never match against the
        // message `HANDOFF now` — was warned about as an echo of itself. Both mirrors had the same
        // bug, so the shared fixture agreed with itself and could not see it.
        if let Ok(re) = compile(&rule.graph.parse.find) {
            if re.is_match(&rule.graph.action.message) {
                out.push(Problem::new(
                    Severity::Warns,
                    "action",
                    "action.echo",
                    "This message matches the rule's own pattern, so the rule can see what it types. \
                     TermFlow ignores its own message, but a shorter pattern is safer.",
                ));
            }
        }
    }

    // --- token substitution -----------------------------------------------------------------
    // §4.4, opt-in via `ActionStep.substitute` (plan 032 §4.2). Without this, a message naming a
    // token the pattern cannot supply reaches `subst::substitute` only at SEND time, where §4.4's
    // own table refuses the send — silently, from the rule's own log, well after the user who
    // wrote "fix $3" believed they were done. This stops it at save/enable time instead.
    //
    // `subst::tokens_used` is the SAME scanner `substitute` reads (see that module's doc): a
    // second scanner here could recognise a different grammar and let a message pass that the
    // send then refuses anyway.
    if rule.graph.action.substitute {
        if rule.graph.parse.find.trim().is_empty() {
            // The toggle itself claims the message inserts a capture, which nothing can be true
            // of before a pattern exists — asked regardless of whether a token has actually been
            // typed yet, the same way the threshold check above is asked regardless of what a
            // clause would compare against.
            out.push(Problem::new(
                Severity::Blocks,
                "action",
                "action.tokenWithoutParse",
                "This message inserts captured values, but the rule has no pattern to capture them from.",
            ));
        } else if let Ok(compiled) = compile(&rule.graph.parse.find) {
            let count = compiled.captures_len().saturating_sub(1);
            for token in subst::tokens_used(&rule.graph.action.message) {
                let bad = match &token {
                    subst::Token::Whole => false,
                    subst::Token::Group(n) => !token_supplied(&compiled, Some(*n), None),
                    subst::Token::Named(name) => {
                        !token_supplied(&compiled, None, Some(name.as_str()))
                    }
                };
                if !bad {
                    continue;
                }
                out.push(Problem::new(
                    Severity::Blocks,
                    "action",
                    "action.unknownToken",
                    format!(
                        "{token} has nothing to stand for. The pattern in Read a value has \
                         {count} bracketed group{}, so the highest you can use is ${count}.",
                        if count == 1 { "" } else { "s" }
                    ),
                ));
            }
        }
    }

    // STABLE, so within each severity the problems stay in step order — targets, monitor, parse,
    // cond, action — which is the order the inspector's problem list draws them in.
    out.sort_by_key(|p| !p.blocks());
    out
}

fn first_line(s: &str) -> String {
    s.lines().next().unwrap_or(s).trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automation_store::{
        ActionStep, Cadence, Clause, CompareOp, CondStep, MonitorStep, ParsePreset, ParseStep,
        ReadMode, SendTo,
    };
    use crate::automation_store::{AutomationRule, Criterion, TargetMode};

    /// The same graph as a PRESENCE rule. `keep` is deliberately left at whatever the caller passed:
    /// the point is that a text rule carries the field and never reads it.
    fn text_graph(find: &str, keep: Keep) -> AutomationGraph {
        let mut g = graph(find, keep);
        g.cond = CondStep { finds: Finds::Event, ..Default::default() };
        g
    }

    fn graph(find: &str, keep: Keep) -> AutomationGraph {
        AutomationGraph {
            layout: None,
            timer: None,
            monitor: MonitorStep { read: ReadMode::NewOutput, cadence: Cadence::OnOutput, every_ms: 0 },
            parse: ParseStep { preset: ParsePreset::Custom, literal: None, find: find.into(), keep },
            cond: CondStep { finds: Finds::Reading, op: Some(CompareOp::Gt), threshold: Some(25.0), ..Default::default() },
            action: ActionStep {
                message: "m".into(),
                send_to: SendTo::Matched,
                submit: true,
                cli_type: "default".into(),
                substitute: false,
            },
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
                    r.graph.monitor.cadence = Cadence::Timer;
                    r.graph.monitor.every_ms = MIN_TIMER_MS - 1;
                }),
                "monitor",
            ),
            (
                "a pattern that will not compile",
                Box::new(|r: &mut AutomationRule| r.graph.parse.find = r"ctx:(\d+%".into()),
                "parse",
            ),
            (
                "a numeric rule with no threshold",
                Box::new(|r: &mut AutomationRule| r.graph.cond.threshold = None),
                "cond",
            ),
            (
                "a numeric rule with no operator",
                Box::new(|r: &mut AutomationRule| r.graph.cond.op = None),
                "cond",
            ),
            (
                "nothing to type",
                Box::new(|r: &mut AutomationRule| r.graph.action.message = "   ".into()),
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
        rule.graph.monitor.cadence = Cadence::Timer;
        rule.graph.monitor.every_ms = MIN_TIMER_MS;
        assert_eq!(problems(&rule), vec![]);

        // And `every_ms` is meaningless for an output-driven rule, so it must not be judged there —
        // the struct carries the field whatever the cadence says.
        let mut on_output = valid_rule();
        on_output.graph.monitor.cadence = Cadence::OnOutput;
        on_output.graph.monitor.every_ms = 0;
        assert_eq!(problems(&on_output), vec![], "a field is judged by the step that READS it");
    }

    /// §2.6, told to the user before it happens — and **only a warning**, because the needle guard
    /// handles it and losing work to a validation rule is its own bug.
    #[test]
    fn a_message_matching_its_own_pattern_warns_and_never_blocks() {
        let mut rule = valid_rule();
        rule.graph.parse.find = "HANDOFF".into();
        rule.graph.cond = CondStep { finds: Finds::Event, ..Default::default() };
        rule.graph.action.message = "HANDOFF now".into();

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
        rule.graph.parse.find = r"ctx:(\d+)(%)".into();
        rule.graph.action.message = String::new();

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
            "../../src/renderer/components/Automation/__fixtures__/automationValidationCases.json"
        );
        let fixture: Fixture = serde_json::from_str(raw).expect("the shared fixture parses");

        // A fixture that shrank to nothing would pass this test by having nothing to disagree
        // about. The count is a floor, not the exact number, so adding a case is not a two-file
        // edit.
        assert!(
            fixture.cases.len() >= 20,
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
        for code in [
            "targets.empty",
            "targets.criterion",
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
            "action.empty",
            "action.echo",
            "action.tokenWithoutParse",
            "action.unknownToken",
        ] {
            assert!(codes.contains(code), "no fixture case produces `{code}`");
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
            completed_at: None,
            verbose_until: None,
            sort_order: 0,
            schema_version: 1,
            graph: graph("", Keep::Whole),
            created_at: 0,
            updated_at: 0,
        };
        rule.graph.cond = CondStep { finds: Finds::Event, ..Default::default() };
        rule.graph.action.message = "anything at all".into();

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
        g.cond = CondStep {
            finds: Finds::Event,
            clauses: vec![Clause {
                source: Source::Whole,
                test: Test::Number { op: CompareOp::Gt, value: None },
            }],
            ..Default::default()
        };

        // The reachable one first: nothing entered yet.
        assert_eq!(
            clause_problems(&g).iter().map(|p| p.code.as_str()).collect::<Vec<_>>(),
            vec!["cond.clauseNeedsValue"],
            "a numeric clause with no threshold is §8's own wording for this code"
        );

        g.cond.clauses[0].test = Test::Number { op: CompareOp::Gt, value: Some(f64::NAN) };
        let found = clause_problems(&g);
        assert_eq!(
            found.iter().map(|p| p.code.as_str()).collect::<Vec<_>>(),
            vec!["cond.clauseNeedsValue"],
            "a non-finite clause value must report the same code as an empty text value: {found:?}"
        );

        // Paired: `f64::INFINITY` is also non-finite and must trip the same guard, not merely NaN.
        g.cond.clauses[0].test = Test::Number { op: CompareOp::Gt, value: Some(f64::INFINITY) };
        let found = clause_problems(&g);
        assert_eq!(found.iter().map(|p| p.code.as_str()).collect::<Vec<_>>(), vec!["cond.clauseNeedsValue"]);

        // And the paired positive: an ordinary finite value reports nothing at all.
        g.cond.clauses[0].test = Test::Number { op: CompareOp::Gt, value: Some(25.0) };
        assert!(clause_problems(&g).is_empty(), "a finite value must not be flagged");
    }
}
