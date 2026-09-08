use super::*;
use crate::automation_store::{ActionStep, Cadence, CondStep, MonitorStep, ParsePreset, ParseStep, SendTo};
use std::cell::RefCell;

// -----------------------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------------------

/// The three input steps of a fixture graph, which every fixture here builds with all three.
///
/// The production callers ask `InputSteps::of` and branch on `None`; a fixture that HAS the
/// steps says so once, here, rather than at ninety call sites.
#[track_caller]
fn ins(g: &AutomationGraph) -> InputSteps<'_> {
    InputSteps::of(g).expect("every fixture graph in this module has all three input steps")
}

/// A rule exactly as `evaluate_text` meets it in production: **`fold_v1_clauses` applied**.
///
/// The fold is not a convenience here, it is the fixture's correctness. **Both** production
/// entry points into the pure core fold first — `reload` before it builds the `LiveRule`, and
/// `dry::evaluate_once` on its own copy — so a fixture that skipped it would hand
/// `evaluate_text` a shape production never produces: `Finds::Reading` with an EMPTY clause
/// list, which §5.5 step 4 reads as "the match is the whole condition". Calling the real fold
/// rather than hand-writing the clause also keeps this honest if §5.4's `keep` mapping ever
/// moves: there is one folding implementation and the tests use it.
fn graph(find: &str, finds: Finds, op: Option<CompareOp>, threshold: Option<f64>) -> AutomationGraph {
    let mut g = graph_unfolded(find, finds, op, threshold);
    if let Ok(re) = Regex::new(find) {
        crate::automation_engine::fold_v1_clauses(&mut g, &re);
    }
    g
}

/// The stored v1 row, before the load-time fold. Split out only so `graph` above can be the
/// two-line "and then load it" that every test wants; nothing else should call it.
fn graph_unfolded(
    find: &str,
    finds: Finds,
    op: Option<CompareOp>,
    threshold: Option<f64>,
) -> AutomationGraph {
    AutomationGraph {
        layout: None,
        timer: None,
        monitor: Some(MonitorStep { read: ReadMode::NewOutput, cadence: Cadence::OnOutput, every_ms: 0, skip_typed_line: false }),
        parse: Some(ParseStep {
            preset: ParsePreset::Custom,
            literal: None,
            find: find.to_string(),
            keep: Keep::Brackets,
        }),
        cond: Some(CondStep { finds, op, threshold, ..Default::default() }),
        action: Some(ActionStep {
            message: "prepare to do context-hand-off".to_string(),
            send_to: SendTo::Matched,
            submit: true,
            cli_type: "default".to_string(),
            substitute: false,
        }),
        webhook: None,
    }
}

/// A v2 graph: `finds` and a pattern, and the caller pushes whatever clauses it wants.
///
/// Deliberately separate from `graph` above rather than a defaulted argument on it: the v1
/// helper's whole job is to carry `op`/`threshold` through the fold, and a clause list is the
/// thing that replaces them.
fn graph_with(finds: Finds, find: &str) -> AutomationGraph {
    graph(find, finds, None, None)
}

fn ctx_rule() -> AutomationGraph {
    graph(r"ctx:(\d+)%", Finds::Reading, Some(CompareOp::Gt), Some(25.0))
}

fn failed_rule() -> AutomationGraph {
    graph(r"FAILED \d+ test", Finds::Event, None, None)
}

/// A `ScreenSource` over a REAL `vt100::Parser`, resolving the depth exactly as `AppState`'s own
/// impl does. Round 2 killed the previous design here because its oracle used static synthetic
/// blocks — every case it was meant to catch passed while failing in production. Driving a real
/// parser means "the line scrolled off the screen" is a fact about a terminal, not about a
/// fixture.
struct VtSource {
    parser: RefCell<vt100::Parser>,
    asked: RefCell<Vec<ReadDepth>>,
}

impl VtSource {
    fn new(rows: u16, cols: u16) -> Self {
        Self {
            parser: RefCell::new(vt100::Parser::new(rows, cols, crate::state::SCROLLBACK_LINES)),
            asked: RefCell::new(Vec::new()),
        }
    }
    fn feed(&self, line: &str) {
        self.parser.borrow_mut().process(format!("{}\r\n", line).as_bytes());
    }
    /// Text left sitting under the cursor: a command typed and NOT submitted. The only
    /// difference from `feed` is the missing newline, which is the whole of what separates a
    /// keystroke echo from output as far as any of this can tell.
    fn type_without_enter(&self, text: &str) {
        self.parser.borrow_mut().process(text.as_bytes());
    }
    fn depths(&self) -> Vec<ReadDepth> {
        self.asked.borrow().clone()
    }
    fn clear_depths(&self) {
        self.asked.borrow_mut().clear();
    }
}

impl ScreenSource for VtSource {
    fn tail(&self, _process_id: &str, depth: ReadDepth, skip_typed_line: bool) -> Option<String> {
        self.asked.borrow_mut().push(depth);
        let mut parser = self.parser.borrow_mut();
        let screen = parser.screen_mut();
        let max = match depth {
            ReadDepth::Window(n) => n,
            ReadDepth::VisibleScreen => screen.size().0 as usize,
        };
        // Passed THROUGH, not swallowed: the fake exists to resolve a depth exactly as
        // `AppState` does, and a fake that ignored the flag would let `evaluate` stop
        // forwarding it with every test here still green.
        Some(crate::state::render_tail_lines(screen, max, skip_typed_line))
    }
}

fn re(p: &str) -> Regex {
    Regex::new(p).unwrap()
}

/// Said out loud at every call site that is not about the echo guard, so a reader can see which
/// tests exercise §2.6 and which deliberately do not.
const NO_ECHOES: &[String] = &[];

// -----------------------------------------------------------------------------------------
// §10.3 — the arm machine
// -----------------------------------------------------------------------------------------

/// Every transition as a TABLE, asserting the next state AND the decision AND whether it sends.
/// Three facts per row, because an implementation that returns the right state with the wrong
/// decision is exactly the bug that makes a crossing silent.
///
/// The `Unknown` rows are the ones that make "once per crossing" true of a numeric rule whose
/// value scrolled out of the read depth: from EVERY state, a read that learned nothing leaves the
/// state exactly where it was. An implementation folding `Unknown` into `false` — which is what
/// this shipped as — passes all eight of the other rows.
#[test]
fn next_state_covers_every_transition() {
    let f = ArmState::Fired { at_ms: 100 };
    let cases: &[(ArmState, Truth, ArmState, Decision, bool)] = &[
        (ArmState::Unseen, Truth::True, ArmState::Fired { at_ms: 500 }, Decision::Armed, false),
        (ArmState::Unseen, Truth::False, ArmState::armed(), Decision::Armed, false),
        (ArmState::armed(), Truth::False, ArmState::armed(), Decision::Checked, false),
        (ArmState::armed(), Truth::True, ArmState::Fired { at_ms: 500 }, Decision::Sent, true),
        (f, Truth::True, ArmState::Fired { at_ms: 100 }, Decision::Held, false),
        (f, Truth::False, ArmState::re_armed(), Decision::ReArmed, false),
        // The `seen_fire` bit survives a check, in both directions.
        (ArmState::re_armed(), Truth::False, ArmState::re_armed(), Decision::Checked, false),
        (ArmState::re_armed(), Truth::True, ArmState::Fired { at_ms: 500 }, Decision::Sent, true),
        // A read that learned nothing moves nothing, from every state — in particular it does NOT
        // re-arm a `Fired` pair, which is the spurious second send.
        (ArmState::Unseen, Truth::Unknown, ArmState::Unseen, Decision::Checked, false),
        (ArmState::armed(), Truth::Unknown, ArmState::armed(), Decision::Checked, false),
        (ArmState::re_armed(), Truth::Unknown, ArmState::re_armed(), Decision::Checked, false),
        (f, Truth::Unknown, ArmState::Fired { at_ms: 100 }, Decision::Checked, false),
    ];
    for (prev, cond, want_next, want_decision, want_sends) in cases {
        let (next, decision) = next_state(*prev, *cond, 500);
        assert_eq!(next, *want_next, "state for {:?} + {:?}", prev, cond);
        assert_eq!(decision, *want_decision, "decision for {:?} + {:?}", prev, cond);
        assert_eq!(decision.sends(), *want_sends, "sends for {:?} + {:?}", prev, cond);
    }
}

/// `Unseen + true` is the settled decision that keeps this feature safe to launch: an app started
/// while a terminal already reads 63% must arm, not type.
#[test]
fn a_first_sight_above_the_threshold_arms_and_never_sends() {
    let (next, decision) = next_state(ArmState::Unseen, Truth::True, 7);
    assert_eq!(decision, Decision::Armed);
    assert!(!decision.sends(), "first sight must never send");
    assert_eq!(next, ArmState::Fired { at_ms: 7 });
}

/// `at_ms` records when the condition BECAME true. A rule that has held for ten minutes must not
/// look like it just fired, so `held` carries the original stamp rather than refreshing it.
#[test]
fn holding_carries_the_original_fired_at_and_re_firing_takes_a_new_one() {
    let (held, _) = next_state(ArmState::Fired { at_ms: 100 }, Truth::True, 9_000);
    assert_eq!(held, ArmState::Fired { at_ms: 100 }, "held must not refresh at_ms");
    let (rearmed, _) = next_state(held, Truth::False, 9_500);
    assert_eq!(rearmed, ArmState::re_armed());
    let (refired, d) = next_state(rearmed, Truth::True, 10_000);
    assert_eq!(d, Decision::Sent);
    assert_eq!(refired, ArmState::Fired { at_ms: 10_000 }, "a new crossing takes a new stamp");
}

/// Mockup §08's ctx timeline, replayed as a sequence: start 18% -> armed; 27% -> fires; nine
/// checks above the threshold -> held; 22% -> re-arms; 27% -> fires again. Asserting the decision
/// at EVERY step, so an implementation that sends on every check above 25 fails on step 3.
#[test]
fn the_ctx_timeline_sends_exactly_once_per_crossing() {
    let values = [18.0, 27.0, 30.0, 33.0, 41.0, 44.0, 48.0, 52.0, 58.0, 61.0, 63.0, 22.0, 27.0];
    let expected = [
        Decision::Armed,   // 18 — first sight, below
        Decision::Sent,    // 27 — the crossing
        Decision::Held,    // 30
        Decision::Held,    // 33
        Decision::Held,    // 41
        Decision::Held,    // 44
        Decision::Held,    // 48
        Decision::Held,    // 52
        Decision::Held,    // 58
        Decision::Held,    // 61
        Decision::Held,    // 63
        Decision::ReArmed, // 22 — back under
        Decision::Sent,    // 27 — the second crossing
    ];
    let mut state = ArmState::Unseen;
    let mut sends = 0;
    for (i, (v, want)) in values.iter().zip(expected.iter()).enumerate() {
        let (next, decision) =
            next_state(state, Truth::from_compare(compare(CompareOp::Gt, *v, 25.0)), i as i64);
        assert_eq!(decision, *want, "step {} (ctx:{}%)", i, v);
        if decision.sends() {
            sends += 1;
        }
        state = next;
    }
    assert_eq!(sends, 2, "two crossings, two sends — never one per check");
}

// -----------------------------------------------------------------------------------------
// §10.2b — extraction
// -----------------------------------------------------------------------------------------

/// The single most likely wrong implementation is `captures()`, which takes the FIRST match.
///
/// The window is fed BOTH ascending and descending so "last" cannot be confused with "largest" —
/// an implementation taking the max passes the ascending case and fails the descending one.
#[test]
fn extraction_takes_the_last_match_not_the_first_and_not_the_largest() {
    let r = re(r"ctx:(\d+)%");
    let ascending = "ctx:18%\nnoise\nctx:41%\nnoise\nctx:63%\n";
    assert_eq!(extract(&r, Keep::Brackets, ascending).0, Read::Value(63.0));

    let descending = "ctx:63%\nnoise\nctx:41%\nnoise\nctx:18%\n";
    assert_eq!(
        extract(&r, Keep::Brackets, descending).0,
        Read::Value(18.0),
        "`last` must mean the newest occurrence, never the largest"
    );
}

/// `keep` names which span is the value, and a named `value` group outranks group 1.
#[test]
fn keep_selects_the_group_and_a_named_value_group_wins() {
    let plain = re(r"ctx:(\d+)%");
    assert_eq!(extract(&plain, Keep::Brackets, "ctx:63%").0, Read::Value(63.0));
    assert_eq!(
        extract(&plain, Keep::Whole, "ctx:63%").0,
        Read::Unparsed("ctx:63%".to_string()),
        "`whole` takes group 0, which here is not a number"
    );
    assert_eq!(extract(&re(r"(\d+)"), Keep::Whole, "63").0, Read::Value(63.0));

    let named = re(r"(?<first>c)tx:(?<value>\d+)%");
    let (read, caps) = extract(&named, Keep::Brackets, "ctx:63%");
    assert_eq!(read, Read::Value(63.0), "a group named `value` must win over group 1");
    // `keep` chooses which span is the VALUE; it never decides which groups are collected, so
    // the group `value` outranked is still reachable.
    assert_eq!(caps.expect("a match").group(1), Some("c"));
}

/// A group-less pattern with `keep: brackets` must NOT silently fall back to the whole match.
/// Validation blocks it before it can run; if one reaches here it reports what it saw.
#[test]
fn brackets_on_a_group_less_pattern_never_falls_back_to_the_whole_match() {
    let r = re(r"\d+");
    let (read, caps) = extract(&r, Keep::Brackets, "ctx:63%");
    assert_eq!(
        read,
        Read::Unparsed("63".to_string()),
        "no capture group means no value — never the whole match"
    );
    // It still MATCHED, so there is still a bag — with group 0 and nothing else.
    let c = caps.expect("a match with no groups still produces captures");
    assert_eq!(c.group(0), Some("63"));
    assert_eq!(c.count(), 0);
    // And the blocking half, so the two halves of the rule cannot drift apart.
    let mut g = ctx_rule();
    g.parse_mut().find = r"\d+".to_string();
    let problems = crate::automation_validation::pattern_problems(&g);
    assert!(
        problems.iter().any(|p| p.blocks()),
        "keep: brackets with no capture group must BLOCK enabling, got {:?}",
        problems
    );
}

// -----------------------------------------------------------------------------------------
// §4.1 — every group, not only the kept one
// -----------------------------------------------------------------------------------------

#[test]
fn extract_keeps_every_group_not_only_the_kept_one() {
    let re = Regex::new(r"FAILED (\d+) tests in (\S+)").unwrap();
    let (read, caps) = extract(&re, Keep::Brackets, "FAILED 17 tests in automationSteps.test.ts");
    assert_eq!(read, Read::Value(17.0), "the existing reduction is unchanged");
    let c = caps.expect("a match must produce captures");
    assert_eq!(c.group(0), Some("FAILED 17 tests in automationSteps.test.ts"));
    assert_eq!(c.group(1), Some("17"));
    assert_eq!(c.group(2), Some("automationSteps.test.ts"));
    assert_eq!(c.group(3), None, "out of range is None, never a panic");
    assert_eq!(c.count(), 2);
}

#[test]
fn a_group_that_did_not_participate_is_none_not_empty() {
    // The difference matters: §4.4 substitutes a non-participating group to "" but
    // §5.5 makes a NUMBER clause on it Unknown. Collapsing them here removes the
    // information both rules need.
    let re = Regex::new(r"code (\d+)(?: retry (\d+))?").unwrap();
    let (_, caps) = extract(&re, Keep::Brackets, "code 529");
    let c = caps.unwrap();
    assert_eq!(c.group(1), Some("529"));
    assert_eq!(c.group(2), None, "an optional group that did not match is None");

    // The other half of the same distinction, without which the assertion above also passes for
    // an implementation that collapses BOTH cases to `None`: a group that did participate and
    // matched no characters is `Some("")`.
    let empty = Regex::new(r"code (\d+)(\s*)").unwrap();
    let (_, caps) = extract(&empty, Keep::Brackets, "code 529");
    assert_eq!(
        caps.unwrap().group(2),
        Some(""),
        "an empty match is not a missing one"
    );
}

#[test]
fn named_groups_are_reachable_by_name() {
    let re = Regex::new(r"ctx:(?P<value>\d+)%").unwrap();
    let (read, caps) = extract(&re, Keep::Brackets, "ctx:63%");
    assert_eq!(read, Read::Value(63.0));
    let c = caps.unwrap();
    assert_eq!(c.name("value"), Some("63"));
    assert_eq!(c.name("nope"), None, "a name the pattern does not declare is None");

    // The same non-participation distinction as `group`, at the by-name surface: a declared
    // name that did not match reads `None`, so `${name}` cannot silently resolve to the wrong
    // thing.
    let optional = Regex::new(r"code (?P<value>\d+)(?: retry (?P<retry>\d+))?").unwrap();
    let (_, caps) = extract(&optional, Keep::Brackets, "code 529");
    let c = caps.unwrap();
    assert_eq!(c.name("value"), Some("529"));
    assert_eq!(c.name("retry"), None, "a named group that did not participate is None");
}

/// §4.4 gives two DIFFERENT answers to two cases `name()` alone collapses: a declared group that
/// did not participate substitutes to `""` and the send proceeds, while an undeclared token
/// refuses the send. `has_name` is what tells them apart, and it must be keyed on what the
/// PATTERN declares — a map built from the participating names cannot express row 1 at all.
#[test]
fn a_declared_name_that_did_not_participate_is_not_an_unknown_name() {
    let r = re(r"API error (?<code>\d+)(?: · retry in (?<retry>\d+)s)?");
    let (_, caps) = extract(&r, Keep::Brackets, "API error 529");
    let c = caps.expect("a match");

    assert_eq!(c.name("code"), Some("529"));
    assert!(c.has_name("code"));

    // Declared, did not participate: §4.4 substitutes "" and SENDS.
    assert!(c.has_name("retry"), "the pattern declares `retry`, so it is not an unknown token");
    assert_eq!(c.name("retry"), None, "…but it did not participate in this match");

    // Never declared: §4.4 REFUSES the send. Same `name()` answer, different `has_name()`.
    assert!(!c.has_name("typo"), "a token the pattern never declared is out of range");
    assert_eq!(c.name("typo"), None);

    // The two rows are only distinguishable because `has_name` disagrees where `name` agrees.
    assert_ne!(
        c.has_name("retry"),
        c.has_name("typo"),
        "a non-participating group and an undeclared token must not read the same"
    );

    // And the positional surface says the same thing the same way, so a caller writing the §4.4
    // rule twice writes it identically: within `count()` but `None`, versus beyond `count()`.
    assert_eq!(c.count(), 2);
    assert_eq!(c.group(2), None, "declared, did not participate");
    assert_eq!(c.group(3), None, "out of range — separated by `count()`, not by `group()`");
}

#[test]
fn no_match_produces_no_captures() {
    let re = Regex::new(r"ctx:(\d+)%").unwrap();
    let (read, caps) = extract(&re, Keep::Brackets, "nothing here");
    assert_eq!(read, Read::NoMatch);
    assert!(caps.is_none());
}

#[test]
fn captures_come_from_the_last_match_in_the_window_not_the_first() {
    // Same reason extract's own header gives for captures_iter().last(): over a
    // 200-line window the FIRST match is the OLDEST, so the value never rises.
    // The captures must agree with the Read, or $1 and the comparison describe
    // different lines.
    let re = Regex::new(r"ctx:(\d+)%").unwrap();
    let (read, caps) = extract(&re, Keep::Brackets, "ctx:11%\nctx:63%");
    assert_eq!(read, Read::Value(63.0));
    assert_eq!(caps.unwrap().group(1), Some("63"));
}

/// The numeric arm's half of the same handoff. `extract`'s own tests call `extract` directly, so
/// they say nothing about whether the bag it returns ever reaches `Evaluation` — and Tasks 4 and 5
/// read it there, on numeric rules. Without this the arm pair is a partial-class fix: the text arm
/// pinned, the identical wiring beside it not.
#[test]
fn a_numeric_rule_carries_its_captures_onto_the_evaluation() {
    let g = ctx_rule();
    let ev = evaluate_text(
        ins(&g),
        &re(&g.parse_ref().find),
        NO_ECHOES,
        ArmState::armed(),
        &|_| Some("ctx:63%".into()),
        0,
    )
    .expect("a live read");
    assert_eq!(ev.condition, Truth::True);
    assert_eq!(
        ev.captures.as_ref().and_then(|c| c.group(1)),
        Some("63"),
        "the bag `extract` returned must reach `Evaluation`, not stop at the call site"
    );
}

/// Before this task the text branch ran `is_match`, so this returned `None` and every `$1` in a
/// word rule resolved to nothing. It is the single most load-bearing test in M1: spec 032's own
/// two scenarios are both word rules.
#[test]
fn a_word_rule_captures_its_groups() {
    let g = graph(r"API error (\d+)", Finds::Event, None, None);
    let ev = evaluate_text(
        ins(&g),
        &re(&g.parse_ref().find),
        NO_ECHOES,
        ArmState::armed(),
        &|_| Some("API error 529".into()),
        0,
    )
    .expect("a live read");
    assert_eq!(ev.condition, Truth::True);
    assert_eq!(
        ev.captures.as_ref().and_then(|c| c.group(1)),
        Some("529"),
        "a word rule must collect groups, not just answer yes/no"
    );
}

/// The text branch's captures must come from the same occurrence its answer does, and a word
/// rule that does NOT match must produce no bag — `None` means "nothing matched", never "this
/// kind of rule does not collect".
#[test]
fn a_word_rules_captures_track_its_answer() {
    let g = graph(r"API error (\d+)", Finds::Event, None, None);
    let seen = evaluate_text(
        ins(&g),
        &re(&g.parse_ref().find),
        NO_ECHOES,
        ArmState::armed(),
        &|_| Some("API error 429\nAPI error 529".into()),
        0,
    )
    .expect("a live read");
    assert_eq!(
        seen.captures.as_ref().and_then(|c| c.group(1)),
        Some("529"),
        "the newest occurrence, for the same reason the numeric branch takes the last"
    );

    let unseen = evaluate_text(
        ins(&g),
        &re(&g.parse_ref().find),
        NO_ECHOES,
        ArmState::armed(),
        &|_| Some("all quiet".into()),
        0,
    )
    .expect("a live read");
    assert_eq!(unseen.condition, Truth::False, "absence of the words IS the observation");
    assert!(unseen.captures.is_none(), "no match, no bag");
}

// -----------------------------------------------------------------------------------------
// §10.2c — coercion and the six operators
// -----------------------------------------------------------------------------------------

#[test]
fn coercion_is_three_way_and_the_two_failures_read_differently() {
    let r = re(r"v:(\S+)");
    let cases: &[(&str, Read)] = &[
        ("v:63", Read::Value(63.0)),
        ("v:63.5", Read::Value(63.5)),
        ("v:+7", Read::Value(7.0)),
        ("v:-7", Read::Value(-7.0)),
        ("v:63%", Read::Unparsed("63%".to_string())),
        ("v:1,024", Read::Unparsed("1,024".to_string())),
        ("v:NaN", Read::Unparsed("NaN".to_string())),
        ("v:inf", Read::Unparsed("inf".to_string())),
        ("nothing here", Read::NoMatch),
    ];
    for (text, want) in cases {
        assert_eq!(&extract(&r, Keep::Brackets, text).0, want, "coercing {:?}", text);
    }

    // Both failures are `Truth::Unknown` — NOT false — and read DISTINCTLY.
    let depth = ReadDepth::Window(200);
    let d = Decision::Checked;
    let no_match = read_detail(&Outcome::Numeric(Read::NoMatch), "ctx:(\\d+)%", depth, d);
    let unparsed = read_detail(
        &Outcome::Numeric(Read::Unparsed("63%".to_string())),
        "ctx:(\\d+)%",
        depth,
        d,
    );
    assert_ne!(no_match, unparsed, "the two failure modes must not read the same");
    assert!(no_match.contains("nothing matching"), "{}", no_match);
    assert!(unparsed.contains("is not a number") && unparsed.contains("63%"), "{}", unparsed);
}

/// `NaN` is the reason coercion checks `is_finite`, and the proof is that it would make `neq`
/// TRUE — a terminal printing `NaN%` firing a "not equal to" rule looks exactly like a real
/// crossing.
#[test]
fn a_non_finite_read_cannot_satisfy_any_operator() {
    let g = graph(r"v:(\S+)", Finds::Reading, Some(CompareOp::Neq), Some(25.0));
    let ev = evaluate_text(ins(&g), &re(r"v:(\S+)"), NO_ECHOES, ArmState::armed(), &|_| Some("v:NaN".into()), 1)
        .expect("text was available");
    assert_eq!(ev.condition, Truth::Unknown, "a value that is not a number is not a reading");
    assert_eq!(ev.decision, Decision::Checked);
    // The premise the `is_finite` guard exists for: every comparison against `NaN` is false, so
    // the natural spelling of `neq` — "not equal" — reports TRUE for a value that is not a number.
    assert!(
        !((f64::NAN - 25.0f64).abs() < 1e-9),
        "premise: spelling neq as `!eq` would fire on a terminal printing NaN%"
    );
}

#[test]
fn the_six_operators_are_a_table() {
    use CompareOp::*;
    let cases: &[(CompareOp, f64, f64, bool)] = &[
        (Gt, 26.0, 25.0, true), (Gt, 25.0, 25.0, false), (Gt, 24.0, 25.0, false),
        (Gte, 26.0, 25.0, true), (Gte, 25.0, 25.0, true), (Gte, 24.0, 25.0, false),
        (Lt, 24.0, 25.0, true), (Lt, 25.0, 25.0, false), (Lt, 26.0, 25.0, false),
        (Lte, 24.0, 25.0, true), (Lte, 25.0, 25.0, true), (Lte, 26.0, 25.0, false),
        (Eq, 25.0, 25.0, true), (Eq, 25.5, 25.0, false),
        (Neq, 25.5, 25.0, true), (Neq, 25.0, 25.0, false),
    ];
    for (op, v, t, want) in cases {
        assert_eq!(compare(*op, *v, *t), *want, "{:?} {} vs {}", op, v, t);
    }
}

/// The epsilon is not decoration, but the reason is ARITHMETIC, not parsing: parsing the same
/// decimal literal twice yields the same `f64`. What this test shows is the real case — `0.1`
/// parsed and then multiplied by three lands a few ulps from the `0.3` a user would type, and
/// `==` says so.
#[test]
fn eq_uses_an_epsilon_for_independently_computed_or_rounded_values() {
    let from_text: f64 = "0.1".parse::<f64>().unwrap() * 3.0;
    let typed = 0.30000000000000004_f64;
    assert!(compare(CompareOp::Eq, from_text, 0.3), "0.1*3 must compare equal to 0.3");
    assert!(!(0.1f64 * 3.0 == 0.3), "premise: `==` fails here");
    assert!(compare(CompareOp::Eq, typed, 0.3));
    assert!(!compare(CompareOp::Neq, from_text, 0.3));
}

// -----------------------------------------------------------------------------------------
// §5.5 — one clause
// -----------------------------------------------------------------------------------------

#[test]
fn one_clause_against_every_row_of_the_table() {
    let caps = Captures {
        groups: vec![Some("code 529 x".into()), Some("529".into()), None],
        named: Default::default(),
    };
    let num = |n, op, v| Clause { source: Source::Group(n), test: Test::Number { op, value: Some(v) } };
    let txt = |n, op, v: &str| Clause { source: Source::Group(n), test: Test::Text { op, value: v.into() } };

    assert_eq!(test_clause(&num(1, CompareOp::Gt, 500.0), &caps), Truth::True);
    assert_eq!(test_clause(&num(1, CompareOp::Lt, 500.0), &caps), Truth::False);
    // group 2 did not participate: a NUMBER read learned nothing
    assert_eq!(test_clause(&num(2, CompareOp::Gt, 1.0), &caps), Truth::Unknown);
    // group 0 is text, not a number
    assert_eq!(test_clause(&num(0, CompareOp::Gt, 1.0), &caps), Truth::Unknown);
    // a TEXT test on a non-participating group sees "" — a known absence, §4.4's rule
    assert_eq!(test_clause(&txt(2, TextOp::IsEmpty, ""), &caps), Truth::True);
    assert_eq!(test_clause(&txt(2, TextOp::Contains, "x"), &caps), Truth::False);
    assert_eq!(test_clause(&txt(1, TextOp::Is, "529"), &caps), Truth::True);
    assert_eq!(test_clause(&txt(0, TextOp::Contains, "529"), &caps), Truth::True);
}

/// A numeric clause whose threshold has not been typed yet asks nothing, so it can be told
/// nothing. `Truth::Unknown` — never `False`, which would let an unfinished comparison decide
/// the rule, and never `True`, which would fire on it.
///
/// Reachable only from a hand-edited row: `cond.clauseNeedsValue` blocks it on both sides of
/// the wire. It is a state the panel can hold, though, and the whole reason `value` is
/// `Option<f64>` rather than `f64` — so what the engine does with it is pinned, not assumed.
#[test]
fn a_numeric_clause_with_no_threshold_is_unknown_whatever_the_token_holds() {
    let caps = Captures {
        groups: vec![Some("529".into()), Some("529".into())],
        named: Default::default(),
    };
    for op in [CompareOp::Gt, CompareOp::Lt, CompareOp::Eq, CompareOp::Neq] {
        let c = Clause { source: Source::Group(1), test: Test::Number { op, value: None } };
        assert_eq!(
            test_clause(&c, &caps),
            Truth::Unknown,
            "a readable token and no threshold is still nothing learned, op {op:?}"
        );
    }
    // The paired positive, over the same token: a threshold that IS there decides normally.
    let filled =
        Clause { source: Source::Group(1), test: Test::Number { op: CompareOp::Gt, value: Some(1.0) } };
    assert_eq!(test_clause(&filled, &caps), Truth::True);
}

#[test]
fn a_clause_pattern_that_will_not_compile_is_unknown_not_false() {
    let caps = Captures { groups: vec![Some("x".into())], named: Default::default() };
    let c = Clause { source: Source::Whole, test: Test::Text { op: TextOp::Matches, value: "(".into() } };
    assert_eq!(test_clause(&c, &caps), Truth::Unknown, "a broken clause must not read as 'no'");
}

/// **A clause pattern is refused at evaluation under the SAME limit it was validated under.**
///
/// "Will not compile" is not one question: `automation_validation::compile` bounds the compiled
/// program at 1 MB and is what the rule's own pattern is built through at load and what
/// `cond.badClausePattern` refuses a clause through at save, while bare `Regex::new` carries the
/// regex crate's own 10 MB ceiling. Between them sits a band of patterns the editor blocks and
/// the engine ran happily — accepted under one limit, evaluated under another.
///
/// Twenty-two characters is the whole of the fixture: what crosses the ceiling is the size of
/// the compiled program, not the length of what was typed, which is why a length check
/// somewhere else would not have been the same guard.
#[test]
fn a_clause_pattern_too_big_to_validate_is_too_big_to_evaluate() {
    let pattern = "(?:[0-9a-z]{200}){200}";
    assert!(
        regex::Regex::new(pattern).is_ok(),
        "premise: the bare constructor takes it, so this is a limit question and not a syntax one"
    );

    // Validation's answer, through the validator itself rather than through the function it
    // happens to call: the editor blocks this clause and names it.
    let mut rule = crate::automation_engine::test_host::ctx_rule("au-1");
    rule.graph.cond_mut().clauses = vec![Clause {
        source: Source::Whole,
        test: Test::Text { op: TextOp::Matches, value: pattern.into() },
    }];
    assert!(
        crate::automation_validation::problems(&rule)
            .iter()
            .any(|p| p.code == "cond.badClausePattern"),
        "premise: this is a clause the user cannot save"
    );

    // The engine's answer, which must be the same one. `Unknown` and not `False`: a clause that
    // could not be read teaches nothing, exactly as an uncompilable one does above.
    let caps = Captures { groups: vec![Some("x".into())], named: Default::default() };
    let c = Clause {
        source: Source::Whole,
        test: Test::Text { op: TextOp::Matches, value: pattern.into() },
    };
    assert_eq!(
        test_clause(&c, &caps),
        Truth::Unknown,
        "a clause the editor refuses to save decided a rule at evaluation"
    );
}

// -----------------------------------------------------------------------------------------
// §5.6 — the Kleene fold
// -----------------------------------------------------------------------------------------

#[test]
fn kleene_and_or_over_two() {
    use Truth::{False as F, True as T, Unknown as U};
    for (a, b, and, or) in [
        (T, T, T, T), (T, F, F, T), (F, F, F, F),
        (U, F, F, U),   // AND short-circuits on a known False
        (U, T, U, T),   // OR short-circuits on a known True
        (U, U, U, U),
    ] {
        assert_eq!(fold_clauses(&[a, b], Join::And), and, "AND {a:?} {b:?}");
        assert_eq!(fold_clauses(&[b, a], Join::And), and, "AND is commutative");
        assert_eq!(fold_clauses(&[a, b], Join::Or), or, "OR {a:?} {b:?}");
        assert_eq!(fold_clauses(&[b, a], Join::Or), or, "OR is commutative");
    }
}

#[test]
fn kleene_folds_over_three_not_only_pairs() {
    use Truth::{False as F, True as T, Unknown as U};
    assert_eq!(fold_clauses(&[T, U, F], Join::And), F);
    assert_eq!(fold_clauses(&[T, U, T], Join::And), U);
    assert_eq!(fold_clauses(&[F, U, T], Join::Or), T);
    assert_eq!(fold_clauses(&[F, U, F], Join::Or), U);
}

#[test]
fn an_empty_clause_list_is_true() {
    // §5.5 step 4: the match itself is the condition. Reached only when there WAS a match.
    assert_eq!(fold_clauses(&[], Join::And), Truth::True);
    assert_eq!(fold_clauses(&[], Join::Or), Truth::True);
}

// -----------------------------------------------------------------------------------------
// §5.5 — the five steps, wired
// -----------------------------------------------------------------------------------------

/// §10.8c. §5.2's whole argument, as a test. If someone later "simplifies" by deriving `finds`
/// from the clause types, this rule gets the deep window in both directions, `API error` stays
/// findable in scrollback, and it never re-arms.
#[test]
fn an_event_rule_with_a_numeric_clause_still_reads_the_visible_screen_after_firing() {
    let mut g = graph_with(Finds::Event, r"API error (\d+)");
    g.cond_mut().clauses.push(Clause {
        source: Source::Group(1),
        test: Test::Number { op: CompareOp::Gt, value: Some(1.0) },
    });
    let fired = ArmState::Fired { at_ms: 0 };
    assert_eq!(depth_for(g.cond_ref().finds, g.monitor_ref().read, fired), ReadDepth::VisibleScreen);
}

/// §10.8c at the **wiring**, which the test above does not reach.
///
/// That one hands `depth_for` `g.cond_ref().finds` itself, so it pins `depth_for`'s table — already
/// covered — and not the call `evaluate_text` makes. A "simplification" that derived `finds`
/// from the clause types *inside* `evaluate_text` would leave it green. This one asks the SOURCE
/// which depth it was read at, which is the fact a user feels.
///
/// The existing word-rule re-arm tests cannot stand in for it: `failed_rule` has NO clauses, so
/// a derivation keyed on "any numeric clause" leaves them untouched. The numeric clause is the
/// whole point — `API error 529 . retry in 60s` is an event that contains a number.
#[test]
fn an_event_rule_with_a_numeric_clause_is_read_at_the_screen_after_firing() {
    let mut g = graph_with(Finds::Event, r"API error (\d+)");
    g.cond_mut().clauses.push(Clause {
        source: Source::Group(1),
        test: Test::Number { op: CompareOp::Gt, value: Some(1.0) },
    });
    let r = re(&g.parse_ref().find);
    let src = VtSource::new(4, 80);

    src.feed("API error 529");
    let fired = evaluate(ins(&g), &r, NO_ECHOES, ArmState::armed(), &src, "pc-1", 1).unwrap();
    assert_eq!(fired.decision, Decision::Sent, "premise: the clause passes and the rule fires");

    // Off the visible SCREEN, still well inside the 200-line WINDOW — the gap the two depths
    // exist to tell apart, and the one a derived `Finds::Reading` would collapse.
    for i in 0..10 {
        src.feed(&format!("build step {}", i));
    }
    src.clear_depths();
    let ev = evaluate(ins(&g), &r, NO_ECHOES, fired.next, &src, "pc-1", 2).unwrap();
    assert_eq!(
        src.depths(),
        vec![ReadDepth::VisibleScreen],
        "a fired EVENT re-arms off the screen, whatever its clauses happen to compare"
    );
    assert_eq!(
        ev.decision,
        Decision::ReArmed,
        "so it lets the event go — the deep window would leave it in `Fired` for the session"
    );
}

/// §10.8e, §5.5 step 3. An event that did not appear genuinely did not happen; a reading that
/// produced no value taught nothing. One branch for both is the mutation this kills.
#[test]
fn no_match_is_false_for_an_event_and_unknown_for_a_reading() {
    for (finds, want) in [(Finds::Event, Truth::False), (Finds::Reading, Truth::Unknown)] {
        let g = graph_with(finds, r"nothing");
        let re = Regex::new(&g.parse_ref().find).unwrap();
        let ev = evaluate_text(ins(&g), &re, &[], ArmState::armed(), &|_| Some("quiet".into()), 0).unwrap();
        assert_eq!(ev.condition, want, "{finds:?}");
    }
}

/// §5.5 step 5 reaching the arm machine: two clauses of DIFFERENT types over DIFFERENT tokens,
/// folded under one AND. Both failure rows are asserted, so an implementation that reads only
/// the first clause — or only the last — fails on one of them.
#[test]
fn two_clauses_under_and_need_both() {
    let mut g = graph_with(Finds::Event, r"API error (\d+) . retry in (\d+)s");
    g.cond_mut().clauses = vec![
        Clause { source: Source::Group(1), test: Test::Text { op: TextOp::Is, value: "529".into() } },
        Clause { source: Source::Group(2), test: Test::Number { op: CompareOp::Gt, value: Some(30.0) } },
    ];
    g.cond_mut().join = Join::And;
    let re = Regex::new(&g.parse_ref().find).unwrap();
    let run = |line: &str| {
        evaluate_text(ins(&g), &re, &[], ArmState::armed(), &|_| Some(line.into()), 0).unwrap().condition
    };
    assert_eq!(run("API error 529 . retry in 60s"), Truth::True);
    assert_eq!(run("API error 429 . retry in 60s"), Truth::False, "first clause fails");
    assert_eq!(run("API error 529 . retry in 10s"), Truth::False, "second clause fails");
}

// -----------------------------------------------------------------------------------------
// §10.2d — two depths
// -----------------------------------------------------------------------------------------

/// The SELECTION first, as a full table over all three dimensions — finds x read mode x prev.
///
/// Varying only one dimension is how a wrong key survives a suite: an implementation that ignores
/// `prev` passes any test whose rows all share one arm state, and one that ignores `read` passes
/// any test whose rows all use `NewOutput`.
#[test]
fn depth_for_is_a_table_over_kind_read_mode_and_arm_state() {
    let w = ReadDepth::Window(200);
    let s = ReadDepth::VisibleScreen;
    let fired = ArmState::Fired { at_ms: 0 };
    let cases: &[(Finds, ReadMode, ArmState, ReadDepth)] = &[
        // Presence: the deep window while "has this happened?" is still open...
        (Finds::Event, ReadMode::NewOutput, ArmState::Unseen, w),
        (Finds::Event, ReadMode::NewOutput, ArmState::armed(), w),
        // ...and the screen once it has been answered — INCLUDING after a re-arm, which is the
        // case that re-fires on a stale scrollback line if it reads the window.
        (Finds::Event, ReadMode::NewOutput, fired, s),
        (Finds::Event, ReadMode::NewOutput, ArmState::re_armed(), s),
        // Presence already reading on-screen: both directions are the screen, no special case.
        (Finds::Event, ReadMode::OnScreen, ArmState::Unseen, s),
        (Finds::Event, ReadMode::OnScreen, ArmState::armed(), s),
        (Finds::Event, ReadMode::OnScreen, fired, s),
        (Finds::Event, ReadMode::OnScreen, ArmState::re_armed(), s),
        // Numeric: a value persists, so the rule's own depth in BOTH directions and after a fire.
        (Finds::Reading, ReadMode::NewOutput, ArmState::Unseen, w),
        (Finds::Reading, ReadMode::NewOutput, ArmState::armed(), w),
        (Finds::Reading, ReadMode::NewOutput, fired, w),
        (Finds::Reading, ReadMode::NewOutput, ArmState::re_armed(), w),
        (Finds::Reading, ReadMode::OnScreen, ArmState::Unseen, s),
        (Finds::Reading, ReadMode::OnScreen, ArmState::armed(), s),
        (Finds::Reading, ReadMode::OnScreen, fired, s),
        (Finds::Reading, ReadMode::OnScreen, ArmState::re_armed(), s),
    ];
    for (finds, read, prev, want) in cases {
        assert_eq!(depth_for(*finds, *read, *prev), *want, "{:?} {:?} {:?}", finds, read, prev);
    }
}

/// The mockup's seven-check word-matching walk, end to end, against a REAL terminal.
///
/// Check 5 is the one that matters: the next run has pushed both `FAILED` lines off the visible
/// screen while they are still in scrollback, and the rule must RE-ARM. A one-depth
/// implementation reads the 200-line window there, still sees `FAILED`, and holds forever.
#[test]
fn the_seven_check_word_walk_re_arms_at_check_five() {
    let rows = 6u16;
    let src = VtSource::new(rows, 80);
    let g = failed_rule();
    let r = re(&g.parse_ref().find);
    let mut state = ArmState::Unseen;
    let step = |src: &VtSource, state: &mut ArmState, at: i64| -> Decision {
        let ev = evaluate(ins(&g), &r, NO_ECHOES, *state, src, "pc-1", at).expect("terminal is live");
        *state = ev.next;
        ev.decision
    };

    // 1 — nothing yet.
    src.feed("running tests");
    assert_eq!(step(&src, &mut state, 1), Decision::Armed);
    // 2 — the failure appears.
    src.feed("FAILED 3 test");
    assert_eq!(step(&src, &mut state, 2), Decision::Sent);
    // 3 — same line, still on screen.
    assert_eq!(step(&src, &mut state, 3), Decision::Held);
    // 4 — a second failure, also on screen.
    src.feed("FAILED 1 test");
    assert_eq!(step(&src, &mut state, 4), Decision::Held);
    // 5 — the next run pushes both off the VISIBLE screen. They are still in scrollback.
    for i in 0..rows + 2 {
        src.feed(&format!("run 2 line {}", i));
    }
    assert_eq!(
        step(&src, &mut state, 5),
        Decision::ReArmed,
        "check 5 must re-arm: `FAILED` has left the screen even though scrollback still holds it"
    );
    // The proof that this was a DEPTH decision and not an empty terminal.
    let deep = src.tail("pc-1", ReadDepth::Window(200), false).unwrap();
    assert!(deep.contains("FAILED 3 test"), "scrollback must still hold the line");
    // 6 — nothing matching.
    assert_eq!(step(&src, &mut state, 6), Decision::Checked);
    // 7 — a third failure fires again.
    src.feed("FAILED 2 test");
    assert_eq!(step(&src, &mut state, 7), Decision::Sent);
}

/// (a) The bottom line is a prompt rewritten on every keystroke while `FAILED 1 test` sits in
/// scrollback. This is what killed round 2's delta design: the anchor vanished on every keystroke
/// and the fallback re-matched the scrollback forever.
#[test]
fn typing_at_the_prompt_neither_re_fires_nor_re_arms() {
    let rows = 5u16;
    let src = VtSource::new(rows, 80);
    let g = failed_rule();
    let r = re(&g.parse_ref().find);
    let mut state = ArmState::Unseen;

    src.feed("FAILED 1 test");
    let ev = evaluate(ins(&g), &r, NO_ECHOES, state, &src, "pc-1", 1).unwrap();
    assert_eq!(ev.decision, Decision::Armed, "first sight arms, never sends");
    state = ev.next;

    // Type into the prompt, one character at a time, rewriting the bottom line each time.
    for i in 0..12 {
        src.parser.borrow_mut().process(format!("\r$ {}", "x".repeat(i)).as_bytes());
        let ev = evaluate(ins(&g), &r, NO_ECHOES, state, &src, "pc-1", 10 + i as i64).unwrap();
        assert_eq!(
            ev.decision,
            Decision::Held,
            "keystroke {} must not re-fire — nothing about the world changed",
            i
        );
        state = ev.next;
    }

    // Now push it off the visible screen, and it re-arms EXACTLY once.
    src.parser.borrow_mut().process(b"\r\n");
    for i in 0..rows + 2 {
        src.feed(&format!("later {}", i));
    }
    let ev = evaluate(ins(&g), &r, NO_ECHOES, state, &src, "pc-1", 100).unwrap();
    assert_eq!(ev.decision, Decision::ReArmed);
    state = ev.next;
    let ev = evaluate(ins(&g), &r, NO_ECHOES, state, &src, "pc-1", 101).unwrap();
    assert_eq!(ev.decision, Decision::Checked, "re-arming happens once, not every tick");
}

/// (b) Ten identical spinner lines followed by two new lines. A diff-based implementation lands
/// its anchor at the very end, computes an empty delta and drops the new output entirely.
#[test]
fn identical_spinner_lines_do_not_hide_the_output_that_follows() {
    let src = VtSource::new(24, 80);
    let g = failed_rule();
    let r = re(&g.parse_ref().find);
    for _ in 0..10 {
        src.feed("working... | working... | working...");
    }
    let mut state = ArmState::Unseen;
    let ev = evaluate(ins(&g), &r, NO_ECHOES, state, &src, "pc-1", 1).unwrap();
    assert_eq!(ev.decision, Decision::Armed);
    state = ev.next;

    src.feed("FAILED 4 test");
    src.feed("done");
    let ev = evaluate(ins(&g), &r, NO_ECHOES, state, &src, "pc-1", 2).unwrap();
    assert_eq!(ev.decision, Decision::Sent, "new lines after identical ones must be seen");
}

/// (c) A terminal holding two lines total — too few to form round 2's eight-line anchor.
#[test]
fn a_two_line_terminal_behaves_like_any_other() {
    let src = VtSource::new(2, 40);
    let g = failed_rule();
    let r = re(&g.parse_ref().find);
    let mut state = ArmState::Unseen;
    src.feed("hello");
    let ev = evaluate(ins(&g), &r, NO_ECHOES, state, &src, "pc-1", 1).unwrap();
    assert_eq!(ev.decision, Decision::Armed);
    state = ev.next;
    src.feed("FAILED 9 test");
    let ev = evaluate(ins(&g), &r, NO_ECHOES, state, &src, "pc-1", 2).unwrap();
    assert_eq!(ev.decision, Decision::Sent);
    state = ev.next;
    // Push it off a two-row screen.
    src.feed("a");
    src.feed("b");
    let ev = evaluate(ins(&g), &r, NO_ECHOES, state, &src, "pc-1", 3).unwrap();
    assert_eq!(ev.decision, Decision::ReArmed);
}

/// A numeric rule reads its own depth in BOTH directions, so a value that simply stops being
/// reprinted does not re-arm. The depth log is the oracle: every read is `Window(200)`.
#[test]
fn a_numeric_rule_reads_one_depth_in_both_directions() {
    let src = VtSource::new(5, 80);
    let g = ctx_rule();
    let r = re(&g.parse_ref().find);
    let mut state = ArmState::Unseen;

    src.feed("ctx:18%");
    state = evaluate(ins(&g), &r, NO_ECHOES, state, &src, "pc-1", 1).unwrap().next;
    src.feed("ctx:63%");
    let ev = evaluate(ins(&g), &r, NO_ECHOES, state, &src, "pc-1", 2).unwrap();
    assert_eq!(ev.decision, Decision::Sent);
    state = ev.next;

    // Out of the 200-line WINDOW entirely, not merely off the visible screen, and no new value
    // printed. Twenty lines proves nothing here: the value is still inside the window, so an
    // implementation that re-arms the moment it stops seeing a value passes anyway. This fixture
    // varied only "off screen" and that is exactly why it could not see the defect.
    for i in 0..260 {
        src.feed(&format!("build step {}", i));
    }
    src.clear_depths();
    let ev = evaluate(ins(&g), &r, NO_ECHOES, state, &src, "pc-1", 3).unwrap();
    assert_eq!(
        ev.outcome,
        Outcome::Numeric(Read::NoMatch),
        "premise: the fixture must really have lost the value, or this asserts nothing"
    );
    assert_eq!(
        ev.decision,
        Decision::Checked,
        "a value persists — losing sight of it is not the same as watching it drop, so this is             an ordinary check and NOT a re-arm"
    );
    assert_eq!(
        ev.next,
        state,
        "and the arm state must not move on a read that learned nothing"
    );
    assert_eq!(
        src.depths(),
        vec![ReadDepth::Window(200)],
        "a numeric rule must never switch to the visible screen"
    );

    // The other half of the same sentence, so "never re-arms" cannot be how this passes: a value
    // that is actually PRINTED below the threshold re-arms on the spot.
    src.feed("ctx:10%");
    let ev = evaluate(ins(&g), &r, NO_ECHOES, ev.next, &src, "pc-1", 4).unwrap();
    assert_eq!(ev.decision, Decision::ReArmed);
    src.feed("ctx:63%");
    assert_eq!(
        evaluate(ins(&g), &r, NO_ECHOES, ev.next, &src, "pc-1", 5).unwrap().decision,
        Decision::Sent,
        "and the next genuine crossing sends exactly once"
    );
}

/// §2.6's needle removal, on BOTH entry points — which is the whole reason it is a parameter.
///
/// A presence rule re-arms off the visible screen, so the rule's own echoed message sitting there
/// keeps the condition true and the rule never re-arms again: silent, and indistinguishable from
/// working. The oracle is the DECISION, not the text, because that is the symptom a user meets.
#[test]
fn both_entry_points_strip_the_terminals_live_echo_needles() {
    let g = failed_rule();
    let r = re(&g.parse_ref().find);
    let echo = "FAILED 3 test — see the log".to_string();

    for entry in ["evaluate", "evaluate_text"] {
        let src = VtSource::new(4, 80);
        src.feed("FAILED 3 test");
        let fired = evaluate(ins(&g), &r, NO_ECHOES, ArmState::armed(), &src, "pc-1", 1).unwrap();
        assert_eq!(fired.decision, Decision::Sent, "{}: setup", entry);

        // The engine's own message is echoed at the prompt, and the original match scrolls off.
        for i in 0..6 {
            src.feed(&format!("line {}", i));
        }
        src.feed(&echo);

        let needles = [echo.clone()];
        let guarded = if entry == "evaluate" {
            evaluate(ins(&g), &r, &needles, fired.next, &src, "pc-1", 2).unwrap()
        } else {
            evaluate_text(ins(&g), &r, &needles, fired.next, &|d| src.tail("pc-1", d, false), 2).unwrap()
        };
        assert_eq!(
            guarded.decision,
            Decision::ReArmed,
            "{}: the rule must not read its own echo as a live match",
            entry
        );

        // The paired positive: WITHOUT the needle the same text holds, so the assertion above is
        // about stripping and not about the fixture having lost the line anyway.
        let unguarded = if entry == "evaluate" {
            evaluate(ins(&g), &r, NO_ECHOES, fired.next, &src, "pc-1", 2).unwrap()
        } else {
            evaluate_text(ins(&g), &r, NO_ECHOES, fired.next, &|d| src.tail("pc-1", d, false), 2).unwrap()
        };
        assert_eq!(unguarded.decision, Decision::Held, "{}: premise", entry);
    }
}

/// Last occurrence, not every occurrence: an identical line the USER typed earlier is genuine
/// output and must survive.
#[test]
fn stripping_removes_the_last_occurrence_of_each_needle_only() {
    let needles = ["hand off now".to_string()];
    assert_eq!(
        strip_echoes("hand off now\nwork\nhand off now\n", &needles),
        "hand off now\nwork\n\n"
    );
    assert_eq!(strip_echoes("nothing here", &needles), "nothing here");
    assert_eq!(strip_echoes("keep me", &[]), "keep me", "no needles changes nothing");
    assert_eq!(
        strip_echoes("keep me", &["".to_string()]),
        "keep me",
        "an empty needle must not match everywhere"
    );
}

/// **The needle and the haystack, as a PAIR.** This is the property `normalise`'s own docstring
/// claims and the one no test drove: it asserted the collapsing in isolation, over six inputs, in
/// the one region where collapsing is the identity.
///
/// `run_send` records the needle through `send::normalise`, which turns every run of whitespace
/// into one space. Searched for with a raw `rfind`, that string cannot match a message the
/// terminal echoed across two rows — a single space is not a newline — so normalising the needle
/// could only ever LOSE a match, never make one, and it silently disabled layer 1 for every
/// multi-line message. An agent prompt is routinely multi-line.
#[test]
fn a_needle_matches_its_echo_however_the_terminal_broke_the_whitespace() {
    let needle = [crate::automation::send::normalise("prepare to do context-hand-off")];

    // Echoed verbatim: the case that already worked, and must keep working.
    assert_eq!(strip_echoes("a prepare to do context-hand-off b", &needle), "a  b");
    // Echoed across two rows. `deliver` writes an embedded newline as a carriage return and the
    // composer draws the rest on the next line, which `render_tail_lines` hands over joined by a
    // newline — the shape the raw comparison could never match.
    assert_eq!(strip_echoes("a prepare to do\ncontext-hand-off b", &needle), "a  b");
    // Re-indented, and re-spaced.
    assert_eq!(strip_echoes("a prepare  to\n   do context-hand-off b", &needle), "a  b");
    // Still the LAST occurrence only, with the tolerant match.
    assert_eq!(
        strip_echoes("prepare to do context-hand-off | prepare to\ndo context-hand-off", &needle),
        "prepare to do context-hand-off | "
    );
    // And it is not a wildcard: different words do not match.
    assert_eq!(
        strip_echoes("prepare to do something else", &needle),
        "prepare to do something else"
    );

    // A message whose text is regex metacharacters is matched LITERALLY.
    let meta = [crate::automation::send::normalise("did it work? (y/n)")];
    assert_eq!(strip_echoes("x did it work?\n(y/n) y", &meta), "x  y");
    assert_eq!(strip_echoes("x did it workZ (yZn) y", &meta), "x did it workZ (yZn) y");

    // The residual, stated so it is not mistaken for a guarantee: a composer that redraws the
    // message behind a NON-whitespace gutter is not seen through by any amount of whitespace
    // tolerance. §2.6 layer 2 and *Re-arm now* are what cover that.
    assert_eq!(
        strip_echoes("a prepare to do\n| context-hand-off b", &needle),
        "a prepare to do\n| context-hand-off b"
    );
}

/// §2.6 keys needles by the TERMINAL, so rule B recognises rule A's injection. Two needles, both
/// stripped, in one pass.
#[test]
fn every_needle_recorded_against_the_terminal_is_stripped_whichever_rule_recorded_it() {
    let needles = ["from rule A".to_string(), "from rule B".to_string()];
    assert_eq!(
        strip_echoes("x from rule A y from rule B z", &needles),
        "x  y  z"
    );
}

/// The depth log for a presence rule, asserted directly: a one-depth implementation fails HERE
/// rather than three tests later.
#[test]
fn a_presence_rule_asks_for_two_different_depths() {
    let src = VtSource::new(4, 80);
    let g = failed_rule();
    let r = re(&g.parse_ref().find);
    src.feed("FAILED 1 test");
    // Armed -> reads the window.
    let ev = evaluate(ins(&g), &r, NO_ECHOES, ArmState::armed(), &src, "pc-1", 1).unwrap();
    assert_eq!(src.depths(), vec![ReadDepth::Window(200)]);
    assert_eq!(ev.decision, Decision::Sent);
    // Fired -> reads the visible screen.
    src.clear_depths();
    let _ = evaluate(ins(&g), &r, NO_ECHOES, ev.next, &src, "pc-1", 2).unwrap();
    assert_eq!(src.depths(), vec![ReadDepth::VisibleScreen]);
}

/// The defect the seven-check walk caught, isolated: a re-armed presence rule must not fire again
/// on the match it just let go, which is still sitting in scrollback.
///
/// *Mutation check: make `depth_for` switch on `ArmState::Fired` instead of `has_seen_fire` and
/// this goes red — that is the plan's own design, and it sends a message the user never asked
/// for, once per re-arm cycle, forever.*
#[test]
fn a_re_armed_presence_rule_does_not_re_fire_on_the_line_it_just_let_go() {
    let rows = 5u16;
    let src = VtSource::new(rows, 80);
    let g = failed_rule();
    let r = re(&g.parse_ref().find);

    src.feed("FAILED 3 test");
    let mut state = evaluate(ins(&g), &r, NO_ECHOES, ArmState::armed(), &src, "pc-1", 1).unwrap();
    assert_eq!(state.decision, Decision::Sent);
    let mut arm = state.next;

    // A handful of new lines — enough to clear a 5-row screen, nowhere near 200.
    for i in 0..rows + 2 {
        src.feed(&format!("next {}", i));
    }
    state = evaluate(ins(&g), &r, NO_ECHOES, arm, &src, "pc-1", 2).unwrap();
    assert_eq!(state.decision, Decision::ReArmed);
    arm = state.next;

    // The line is still well inside the 200-line window.
    assert!(
        src.tail("pc-1", ReadDepth::Window(200), false).unwrap().contains("FAILED 3 test"),
        "premise: the match is still in scrollback"
    );

    src.clear_depths();
    state = evaluate(ins(&g), &r, NO_ECHOES, arm, &src, "pc-1", 3).unwrap();
    assert_eq!(
        state.decision,
        Decision::Checked,
        "a re-armed rule must ask about NOW, not about what is still in scrollback"
    );
    assert_eq!(
        src.depths(),
        vec![ReadDepth::VisibleScreen],
        "and it must ask the screen to do it"
    );
}

/// `monitor.skip_typed_line` reaches the read — the whole point of the field.
///
/// This is the DESTINATION check. The rendering half is pinned in `state.rs`'s own
/// `tail_read_tests`, and every one of those would stay green if `evaluate` quietly stopped
/// forwarding the flag: the failure of a plumbing bug is a feature that does nothing, which is
/// invisible from either end on its own. Driving a real `vt100::Parser` is what makes "the
/// command is only typed, not submitted" a fact about a terminal rather than about a fixture.
#[test]
fn a_rule_that_skips_the_typed_line_does_not_read_it() {
    let src = VtSource::new(6, 40);
    let mut g = failed_rule();
    let r = re(&g.parse_ref().find);
    src.feed("running tests");
    src.type_without_enter("$ grep 'FAILED 3 tests' log.txt");

    // Off — the reported bug, and the premise for the other half: the words ARE on the screen,
    // and nothing about them says the user has not pressed Enter yet.
    let read = evaluate(ins(&g), &r, NO_ECHOES, ArmState::Unseen, &src, "pc-1", 1).unwrap();
    assert_eq!(read.outcome, Outcome::Presence(true), "premise: it matches what was typed");

    g.monitor_mut().skip_typed_line = true;
    let skipped = evaluate(ins(&g), &r, NO_ECHOES, ArmState::Unseen, &src, "pc-1", 1).unwrap();
    assert_eq!(
        skipped.outcome,
        Outcome::Presence(false),
        "the rule opted out and the typed line was read anyway"
    );

    // And the opt-out costs it nothing once the command is actually submitted.
    src.feed("");
    src.feed("FAILED 3 tests in 2 files");
    let submitted = evaluate(ins(&g), &r, NO_ECHOES, ArmState::Unseen, &src, "pc-1", 2).unwrap();
    assert_eq!(submitted.outcome, Outcome::Presence(true), "real output must still match");
}

/// A terminal that is not live yields no evaluation, no log line and an untouched arm state.
#[test]
fn a_dormant_terminal_is_skipped_rather_than_re_armed() {
    let g = failed_rule();
    assert!(
        evaluate_text(ins(&g), &re(&g.parse_ref().find), NO_ECHOES, ArmState::Fired { at_ms: 1 }, &|_| None, 5)
            .is_none(),
        "no text means dormant, not false"
    );
}

/// **An incomplete v1 numeric rule runs, logs, and never fires — and this test is what holds
/// that.**
///
/// A `Finds::Reading` rule missing `op` or `threshold` cannot be true of anything. It used to
/// read `Truth::Unknown` here because `evaluate_text` compared `op`/`threshold` itself and had
/// a `_` arm for the incomplete pair. §5.3 made both fields load-only, `fold_v1_clauses` became
/// the one place they are consulted, and that fold deliberately REFUSES an incomplete pair
/// ("a numeric rule with no comparator is a blocking validation problem already") — which left
/// the clause list empty, and §5.5 step 4 reads an empty list on a match as *the match is the
/// whole condition*. The rule's behaviour flipped from "never fires" to "fires on every match":
/// it would type into a live terminal every time the pattern appeared.
///
/// The guard restoring it does not read `op`/`threshold` at all, because it does not need to.
/// **`Reading` + no clauses is ALWAYS this case**: §5.4's table gives "no clauses" to the
/// `Finds::Event` row only, a complete v1 pair folds to exactly one clause, and a `Reading`
/// rule authored with zero clauses is blocked by `cond.incomplete`.
///
/// Validation is not enough on its own: `reload`'s re-validation exemption is scoped to
/// `parse.*` and does not re-check `cond.*`, so a hand-edited row reaches evaluation.
#[test]
fn an_incomplete_v1_numeric_rule_never_fires() {
    let g = graph(r"ctx:(\d+)%", Finds::Reading, None, Some(25.0));
    assert!(
        g.cond_ref().clauses.is_empty(),
        "premise: the fold must not invent a comparison the stored rule never carried"
    );
    let ev = evaluate_text(ins(&g), &re(r"ctx:(\d+)%"), NO_ECHOES, ArmState::armed(), &|_| Some("ctx:99%".into()), 1)
        .unwrap();
    assert_eq!(
        ev.condition,
        Truth::Unknown,
        "an unfinished comparison learned nothing, so it must neither fire nor re-arm"
    );
    assert_ne!(ev.decision, Decision::Sent, "and above all it must not send");
    // The numeric OUTCOME is untouched by any of that: the log still says what was read.
    assert_eq!(ev.outcome, Outcome::Numeric(Read::Value(99.0)));

    // The other half of the incomplete pair, so the guard cannot be keyed on `op` alone.
    let no_threshold = graph(r"ctx:(\d+)%", Finds::Reading, Some(CompareOp::Gt), None);
    let ev = evaluate_text(
        ins(&no_threshold),
        &re(r"ctx:(\d+)%"),
        NO_ECHOES,
        ArmState::armed(),
        &|_| Some("ctx:99%".into()),
        1,
    )
    .unwrap();
    assert_eq!(ev.condition, Truth::Unknown);

    // **The paired positives, or the guard is just "a Reading rule never fires".** A COMPLETE
    // v1 pair folds to one clause and still crosses, and an `Event` rule with no clauses still
    // fires on the match — §5.4's last row, which the guard must not touch.
    let complete = graph(r"ctx:(\d+)%", Finds::Reading, Some(CompareOp::Gt), Some(25.0));
    assert_eq!(complete.cond_ref().clauses.len(), 1, "premise: a complete pair folds to one clause");
    let ev =
        evaluate_text(ins(&complete), &re(r"ctx:(\d+)%"), NO_ECHOES, ArmState::armed(), &|_| Some("ctx:99%".into()), 1)
            .unwrap();
    assert_eq!(ev.condition, Truth::True);

    let event = graph(r"FAILED", Finds::Event, None, None);
    assert!(event.cond_ref().clauses.is_empty(), "premise: a word rule folds to nothing");
    let ev = evaluate_text(ins(&event), &re("FAILED"), NO_ECHOES, ArmState::armed(), &|_| Some("FAILED\n".into()), 1)
        .unwrap();
    assert_eq!(ev.condition, Truth::True, "§5.4's last row: the match IS the whole condition");
}

/// "Still" is a claim about a match this pair had ALREADY acted on, so the crossing itself — the
/// log line sitting beside the message the rule just sent — must not use it. `read_detail` had no
/// way to tell the two apart, because it was not given the decision it was describing.
#[test]
fn the_crossing_does_not_describe_its_own_match_as_already_standing() {
    let screen = ReadDepth::VisibleScreen;
    let sent = read_detail(&Outcome::Presence(true), "FAILED", screen, Decision::Sent);
    let held = read_detail(&Outcome::Presence(true), "FAILED", screen, Decision::Held);
    assert_eq!(sent, "`FAILED` matched on screen");
    assert_eq!(held, "`FAILED` is still on screen");
    assert_ne!(sent, held, "the crossing and the hold must not read the same");
    // The deep window is about NOTICING an event, so it never says "still" whatever the decision.
    for d in [Decision::Sent, Decision::Held, Decision::Armed] {
        assert_eq!(
            read_detail(&Outcome::Presence(true), "FAILED", ReadDepth::Window(200), d),
            "`FAILED` matched in the last 200 lines",
            "window read, decision {:?}",
            d
        );
    }
}

/// The re-arm detail is the sentence Q13 approved, and it must not be the numeric one.
#[test]
fn the_two_read_modes_report_themselves_differently() {
    let window =
        read_detail(&Outcome::Presence(false), "FAILED", ReadDepth::Window(200), Decision::Checked);
    let screen = read_detail(
        &Outcome::Presence(false),
        "FAILED",
        ReadDepth::VisibleScreen,
        Decision::ReArmed,
    );
    assert_eq!(window, "nothing matching `FAILED` in the last 200 lines");
    assert_eq!(screen, "`FAILED` is no longer on screen");
}

#[test]
fn a_whole_number_reads_as_an_integer_in_the_log() {
    let d = Decision::Held;
    let w = ReadDepth::Window(200);
    assert_eq!(read_detail(&Outcome::Numeric(Read::Value(63.0)), "p", w, d), "last value 63");
    assert_eq!(read_detail(&Outcome::Numeric(Read::Value(63.5)), "p", w, d), "last value 63.5");
}
// -----------------------------------------------------------------------------------------
// The shared clause-truth fixture (task 28)
// -----------------------------------------------------------------------------------------

/// **The renderer's `automationClauseTruth.ts` answers the same cases, or one of us is red.**
///
/// `CondPanel` now draws a per-clause verdict beside each row (§5.9) and this function decides
/// whether the rule actually fires — two implementations of one three-valued rule set, which
/// diverge the first time only one of them is edited. The divergence is silent and it is the
/// worst kind: a green tick beside a comparison the engine reads as `Unknown` tells a user the
/// rule will fire when it will not. `two-implementations-one-fix`.
///
/// `caps` in the fixture is the RENDERER's shape — a flat `Record<string, string>`, what
/// `sampleFromPattern` returns — so this side rebuilds a `Captures` from it. Nothing is lost in
/// that rebuild: an absent key and a `None` slot both read as `None` through `Captures::group`
/// and `Captures::name`, which is exactly the participation fact the map carries by omission.
#[test]
fn the_shared_clause_fixture_agrees_case_for_case() {
    #[derive(serde::Deserialize)]
    struct Fixture {
        cases: Vec<Case>,
    }
    #[derive(serde::Deserialize)]
    struct Case {
        name: String,
        caps: std::collections::BTreeMap<String, String>,
        clause: Clause,
        expected: String,
    }

    /// The renderer's flat capture map as a `Captures`.
    ///
    /// A key that parses as a number is a positional group; anything else is a name. The
    /// positional vector is sized to the highest number present and the gaps are `None`, which
    /// is the same answer an out-of-range index gives — `test_clause`'s own doc says the two
    /// are deliberately not told apart.
    fn caps_from(map: &std::collections::BTreeMap<String, String>) -> Captures {
        let top = map.keys().filter_map(|k| k.parse::<usize>().ok()).max().unwrap_or(0);
        Captures {
            groups: (0..=top).map(|i| map.get(&i.to_string()).cloned()).collect(),
            named: map
                .iter()
                .filter(|(k, _)| k.parse::<usize>().is_err())
                .map(|(k, v)| (k.clone(), Some(v.clone())))
                .collect(),
        }
    }

    let raw = include_str!(
        "../../../../src/renderer/components/Automation/__fixtures__/automationClauseCases.json"
    );
    let fixture: Fixture = serde_json::from_str(raw).expect("the shared clause fixture parses");

    // A fixture that shrank to nothing would pass by having nothing to disagree about. A floor,
    // not the exact number, so adding a case is not a two-file edit.
    assert!(
        fixture.cases.len() >= 40,
        "the shared clause fixture has shrunk to {} cases",
        fixture.cases.len()
    );

    let mut seen_truths = std::collections::HashSet::new();
    let mut seen_ops = std::collections::HashSet::new();
    for case in &fixture.cases {
        let want = match case.expected.as_str() {
            "true" => Truth::True,
            "false" => Truth::False,
            "unknown" => Truth::Unknown,
            other => panic!("fixture case `{}` wants `{}`, which is not a Truth", case.name, other),
        };
        let got = test_clause(&case.clause, &caps_from(&case.caps));
        assert_eq!(got, want, "fixture case: {}", case.name);
        seen_truths.insert(case.expected.clone());
        seen_ops.insert(match &case.clause.test {
            Test::Number { op, .. } => format!("{:?}", op),
            Test::Text { op, .. } => format!("{:?}", op),
        });
    }

    // **Both lists are HAND-TYPED and this side cannot derive either**, exactly as
    // `automation_validation.rs`'s code list cannot: `CompareOp` and `TextOp` have no
    // enumeration a test can walk. The TypeScript mirror DOES derive its equivalent, from
    // `NUM_OP_LABELS`/`TEXT_OP_LABELS` (`Record<Op, string>`, which fails `tsc` on a missing
    // key), so a fourteenth operator added to both implementations with no fixture case stays
    // green HERE until someone adds it below and goes red THERE. Said out loud rather than left
    // to look symmetrical.
    for op in [
        "Gt", "Gte", "Lt", "Lte", "Eq", "Neq", "Is", "IsNot", "Contains", "NotContains",
        "Matches", "IsEmpty", "IsNotEmpty",
    ] {
        assert!(seen_ops.contains(op), "no fixture case uses `{op}`");
    }
    // `Unknown` is the answer a reader gets wrong, so a fixture with no `unknown` case would
    // pin the two implementations everywhere except where they differ.
    for t in ["true", "false", "unknown"] {
        assert!(seen_truths.contains(t), "no fixture case expects `{t}`");
    }
}
