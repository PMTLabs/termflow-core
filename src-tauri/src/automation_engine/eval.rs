//! The Automations engine's pure core — everything with a decision in it, over plain data.
//!
//! Extraction, coercion, comparison, the read-depth choice and the arm machine are ONE unit and land
//! together, because they are one sentence of behaviour split across four steps:
//!
//! ```text
//! [pick the depth from the previous arm state] -> window text
//!    -> strip live echo needles (§2.6) -> extract -> coerce -> compare
//!    -> Truth -> next_state
//! ```
//!
//! Echo stripping happens BEFORE extraction, never after: a needle removed afterwards could not
//! change which occurrence was "last", which is the whole point of the echo guard. It is a
//! **parameter of both entry points** rather than something the caller does first: a guard in the
//! caller lets the next call site opt out by forgetting, and §2.6 is the failure that looks exactly
//! like success. An empty slice says "no needles" out loud.
//!
//! Nothing here touches `AppState`. `AppState::new` takes an `AppHandle`, so anything reachable only
//! through it is testable only behind `--features integration-tests`, which `Cargo.toml` says breaks
//! the Windows test binary at loader time. The two things this module needs from the running app —
//! the terminal's text and its writer — arrive through ports (`ScreenSource` here,
//! `automation::send::TerminalWriter` there). Plan 028 §2.2b, §2.2c, §2.4, §7.10.

use regex::Regex;

use crate::automation_store::{
    AutomationGraph, Clause, CompareOp, CondStep, Finds, Join, Keep, MonitorStep, ParseStep,
    ReadMode, Source, Test, TextOp,
};

/// A rule's three INPUT steps, borrowed together, proved present once.
///
/// **This is what keeps a patternless rule out of the pure core.** Plan 032 §3.1 makes `monitor`,
/// `parse` and `cond` optional so that a *schedule* rule — one that fires at a wall-clock time
/// (§6.3) — can exist at all. Such a rule has nothing to read, nothing to match and nothing to
/// compare, so it is not something `evaluate` should be asked about and answer `None` to: `None`
/// already means *the terminal had no parser, nothing was read*, which the caller turns into
/// `Evaluated::Unread`, and overloading it a second way is the exact `Option<PendingSend>` collapse
/// the `Evaluated` enum was introduced to undo.
///
/// So the CALLER proves presence — `InputSteps::of(&graph)` once, at the top — and the core keeps
/// concrete references and its non-optional grammar (`depth_for` still takes a `ReadMode`,
/// `evaluate` still takes a `&Regex`). There is exactly one destructure, so a third entry point
/// cannot invent a different answer for an absent step.
#[derive(Debug, Clone, Copy)]
pub struct InputSteps<'a> {
    pub monitor: &'a MonitorStep,
    pub parse: &'a ParseStep,
    pub cond: &'a CondStep,
}

impl<'a> InputSteps<'a> {
    /// `None` when the rule is missing any of the three — a schedule rule, which reads nothing.
    ///
    /// All three or none is not merely how the editor writes them: a `monitor` with no `parse` has
    /// no pattern to look for, and a `cond` with no `parse` has nothing to compare, so a rule
    /// holding a strict subset cannot be evaluated either. One predicate, one answer.
    pub fn of(graph: &'a AutomationGraph) -> Option<Self> {
        Some(Self {
            monitor: graph.monitor.as_ref()?,
            parse: graph.parse.as_ref()?,
            cond: graph.cond.as_ref()?,
        })
    }
}

/// How many lines back a "new output as it appears" read looks.
///
/// Bounded deliberately: the walk holds the per-terminal parser mutex that the output consumer
/// contends on, and `state.rs`'s own note above `full_scrollback_snapshot` says holding it across an
/// O(scrollback) render stalls output delivery for EVERY terminal. 200 rows is ~24k cell reads.
pub const MATCH_WINDOW_LINES: usize = 200;

// ---------------------------------------------------------------------------------------------
// The screen port
// ---------------------------------------------------------------------------------------------

/// How much of a terminal's buffer to read.
///
/// **An enum rather than plan §7.10's literal `max_lines: usize`, and the reason is that a `usize`
/// cannot express "the visible screen".** The visible screen is the last `rows` rows at scrollback
/// offset 0, and `rows` is per-terminal state living on `AppState` — so a `usize` port would either
/// force the engine to learn every terminal's row count (`AppState` knowledge, in the one module that
/// must not have any) or reserve a sentinel value to mean "ask the terminal", which is the
/// delete-as-sentinel trap: a legitimate 0 or `usize::MAX` then means something else entirely.
///
/// Saying the INTENT also makes §10.2d's oracle able to fail. A fake recording `50` versus `200`
/// cannot tell a deliberate visible-screen read from a window read that coincidentally matched the
/// terminal's height; `VisibleScreen` versus `Window(200)` can.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadDepth {
    /// The last `n` lines of the buffer, scrollback included.
    Window(usize),
    /// The visible rows only, at scrollback offset 0.
    VisibleScreen,
}

/// Matchable text for one terminal.
///
/// **Takes a `pc-` process id**, like every other reader of `terminal_screens`. The engine resolves
/// the leaf once per pair before calling it and never resolves inside — a function that silently
/// accepts either id space is how the next call site gets it wrong. Plan §7.4.
pub trait ScreenSource {
    /// `skip_typed_line` is the rule's `monitor.skip_typed_line`, carried here rather than folded
    /// into `ReadDepth` because it is not a depth: `depth_for` decides HOW FAR BACK to read, and
    /// this decides whether one line of what it finds counts as output at all. Widening the depth
    /// enum would put both answers in one table and double its rows for a dimension that does not
    /// interact with either of the other two.
    fn tail(&self, process_id: &str, depth: ReadDepth, skip_typed_line: bool) -> Option<String>;
}

// ---------------------------------------------------------------------------------------------
// The arm machine (§2.4)
// ---------------------------------------------------------------------------------------------

/// Where one `(rule, terminal)` pair sits in the once-per-crossing cycle.
///
/// In memory, never persisted (settled decision 8): launch starts the map empty, so every pair is
/// `Unseen`, and `Unseen + true` deliberately does NOT send (settled decision 7) — an app that starts
/// while a terminal is already at 63% must not immediately type into it.
///
/// A boolean cannot express this. It cannot distinguish "never observed" from "observed below the
/// threshold", which is the whole of decision 7.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ArmState {
    /// Never evaluated for this pair.
    Unseen,
    /// Observed, and the condition was false — the next crossing sends.
    ///
    /// `seen_fire` records whether this pair has ever observed its condition TRUE. It exists for one
    /// reason, and it is a defect the mockup's own seven-check walk caught: a presence rule re-arms
    /// when the match leaves the visible SCREEN, but the match is still in the 200-line WINDOW for
    /// another 200 lines — so an `Armed` that always read the window would re-fire on the very line it
    /// had just let go, on the next check, forever. See `depth_for`.
    Armed { seen_fire: bool },
    /// The condition is true and has already been acted on. `at_ms` is when it FIRST became true and
    /// does not move while it stays true.
    Fired { at_ms: i64 },
}

impl ArmState {
    /// Armed, having never seen this condition true — a fresh pair.
    pub fn armed() -> Self {
        ArmState::Armed { seen_fire: false }
    }

    /// Armed again, after the condition had been true.
    pub fn re_armed() -> Self {
        ArmState::Armed { seen_fire: true }
    }

    /// Has this pair ever observed its condition true?
    pub fn has_seen_fire(self) -> bool {
        matches!(self, ArmState::Armed { seen_fire: true } | ArmState::Fired { .. })
    }
}

/// What one evaluation decided. These are the mockup's own log words.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// First sight of this pair, or the condition went from unknown to true without a crossing.
    Armed,
    /// Armed and still false, **or a read that learned nothing, from any state**. The ordinary
    /// outcome, and the only one the verbose gate can drop.
    Checked,
    /// The crossing. **The only decision that sends.**
    Sent,
    /// Fired and still true.
    Held,
    /// Fired and no longer true — the next crossing sends again.
    ReArmed,
}

impl Decision {
    /// The one place "does this send?" is answered, so a caller cannot invent a second rule.
    pub fn sends(self) -> bool {
        matches!(self, Decision::Sent)
    }
}

/// What one read said about the condition.
///
/// **`Unknown` is not `false`.** A numeric read that found no value has learned nothing about that
/// value, and `ArmState::Unseen` exists precisely because "never observed" and "observed below the
/// threshold" are different facts (settled decision 7). Collapsing them one layer down re-introduces
/// the same conflation: a rule whose value merely scrolled out of the read depth would re-arm as
/// though it had dropped, and then send a second message the next time that same unchanged value is
/// printed. That is "once per line" wearing "once per crossing"'s clothes, and §2.2c's promise that
/// a numeric rule "re-arms when the newest PRINTED value drops" is only true with this distinction.
///
/// A PRESENCE read is never `Unknown`: the absence of the words IS the observation, which is the
/// asymmetry the whole of §2.2c is built on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Truth {
    True,
    False,
    /// The read carried no information: no match at all, or a match whose span is not a number.
    Unknown,
}

impl Truth {
    /// A comparison's answer. Only a real `Read::Value` ever reaches this.
    pub fn from_compare(held: bool) -> Self {
        if held {
            Truth::True
        } else {
            Truth::False
        }
    }
}

/// The whole of R3, R4, R5 and R8, as one total function.
///
/// | prev | condition | next | decision | sends? |
/// |---|---|---|---|---|
/// | *any* | **unknown** | *unchanged* | `checked` | no |
/// | `Unseen` | true | `Fired` | `armed` | **no** |
/// | `Unseen` | false | `Armed` | `armed` | no |
/// | `Armed` | false | `Armed` | `checked` | no |
/// | `Armed` | true | `Fired` | **`sent`** | **yes** |
/// | `Fired` | true | `Fired` | `held` | no |
/// | `Fired` | false | `Armed` | `re-armed` | no |
pub fn next_state(prev: ArmState, condition: Truth, now_ms: i64) -> (ArmState, Decision) {
    match (prev, condition) {
        // A read that learned nothing moves nothing. Answering `false` here is what made a numeric
        // rule re-arm on a value that had merely scrolled away and then send again on the next print
        // of that same unchanged value — see `Truth::Unknown`.
        (prev, Truth::Unknown) => (prev, Decision::Checked),
        (ArmState::Unseen, Truth::True) => (ArmState::Fired { at_ms: now_ms }, Decision::Armed),
        (ArmState::Unseen, Truth::False) => (ArmState::armed(), Decision::Armed),
        // The `seen_fire` bit is CARRIED across a check, never recomputed: it is a fact about this
        // pair's history, and losing it would put the rule back to reading the deep window.
        (prev @ ArmState::Armed { .. }, Truth::False) => (prev, Decision::Checked),
        (ArmState::Armed { .. }, Truth::True) => (ArmState::Fired { at_ms: now_ms }, Decision::Sent),
        // `at_ms` is carried, not refreshed: it records when the condition became true, and a rule
        // that has held for ten minutes must not look like it just fired.
        (ArmState::Fired { at_ms }, Truth::True) => (ArmState::Fired { at_ms }, Decision::Held),
        (ArmState::Fired { .. }, Truth::False) => (ArmState::re_armed(), Decision::ReArmed),
    }
}

// ---------------------------------------------------------------------------------------------
// Read depth (§2.2c)
// ---------------------------------------------------------------------------------------------

/// Which depth this evaluation reads, given what the rule asks for and where the pair sits.
///
/// **Only a presence rule gets two depths, and only because only it is about an EVENT.** A value
/// persists — `ctx:63%` is still the current usage even when nothing reprints it — so a numeric rule
/// reads its own configured depth in both directions and re-arms when the newest PRINTED value drops.
/// An event's continued presence in scrollback is not evidence it is still happening: against a
/// 200-line window, "the words stopped" would mean `FAILED 3 test` has been pushed out of the last 200
/// lines, which on a quiet terminal is never — so the rule would stick in `Fired` for the session.
///
/// So a presence rule reads the deep window to NOTICE the event and the visible screen to LET IT GO.
/// When its own `monitor.read` is already `OnScreen` both depths are the screen and it behaves
/// identically in both directions — no special case in the code, and the right behaviour for a
/// full-screen TUI, which removes the match by redrawing.
///
/// **The switch is `has_seen_fire`, not `Fired`, and that distinction is a defect the mockup's own
/// seven-check walk caught.** Re-arming means the match left the SCREEN; it is still in the 200-line
/// WINDOW for another 200 lines. A rule that went back to reading the window the moment it re-armed
/// would re-fire on the very line it had just let go — one spurious send per re-arm cycle, forever,
/// and the plan's own walk asserts check 6 is `checked`. So: the deep window answers *"has this
/// happened?"*, the screen answers *"is it happening now?"*, and a pair that has already answered
/// "ever" only ever asks about now.
///
/// The cost is stated rather than hidden: after a pair's first fire, an event that appears and scrolls
/// off the visible screen inside one check interval is missed. That is the same trade the re-arm rule
/// already makes in the other direction, and `Re-arm now` is the manual backstop for both.
pub fn depth_for(finds: Finds, read: ReadMode, prev: ArmState) -> ReadDepth {
    match (finds, prev) {
        (Finds::Event, p) if p.has_seen_fire() => ReadDepth::VisibleScreen,
        _ => match read {
            ReadMode::NewOutput => ReadDepth::Window(MATCH_WINDOW_LINES),
            ReadMode::OnScreen => ReadDepth::VisibleScreen,
        },
    }
}

// ---------------------------------------------------------------------------------------------
// Extraction and comparison (§2.2b)
// ---------------------------------------------------------------------------------------------

/// What a numeric rule's parse step actually produced.
///
/// Three-way, not two, because the log has to tell the three apart and the mockup's own failure line
/// already does. `Unparsed` carries what it actually saw.
#[derive(Debug, Clone, PartialEq)]
pub enum Read {
    Value(f64),
    NoMatch,
    Unparsed(String),
}

/// A numeric read, or a presence rule's plain bool.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Numeric(Read),
    Presence(bool),
}

/// Text -> number, deliberately narrow.
///
/// `trim`, then `f64::from_str`, then **reject anything not `is_finite()`**. No thousands separators,
/// no unit suffixes, no percent sign — in `ctx:(\d+)%` the `%` sits outside the group on purpose.
///
/// The finiteness check is not defensive tidying. `"NaN".parse::<f64>()` returns `Ok`, and `NaN`
/// poisons the comparison asymmetrically: `(NaN - t).abs() < 1e-9` is `false`, so `eq` is false and
/// **`neq` is true** — a terminal printing `NaN%` would fire a "not equal to" rule, once, and look
/// exactly like a real crossing.
///
/// *(Plan §2.2b also specified "strip one leading `+`". `f64::from_str` already accepts `+7`, so that
/// step changes nothing except to also accept `++7`; it is omitted and the plan corrected.)*
pub fn coerce(raw: &str) -> Option<f64> {
    raw.trim().parse::<f64>().ok().filter(|v| v.is_finite())
}

/// Every group of one match, as text.
///
/// **Text, not `f64`.** `Read` is the numeric reduction and stays exactly as it was; this is the
/// raw material both §4 (message substitution) and §5 (clause comparison) need, and each coerces
/// for itself. Coercing here would throw away `$2 = "automationSteps.test.ts"`.
///
/// `groups[0]` is the whole match. `None` means the group did not participate — an optional group
/// that did not match. That is DIFFERENT from an empty string, and the two consumers treat it
/// differently on purpose (§4.4 substitutes `""`, §5.5 makes a numeric clause `Unknown`), so the
/// distinction is preserved here rather than flattened.
///
/// **Both surfaces hold every group the PATTERN declares, not every group that matched**, and the two
/// therefore read identically:
///
/// | positional | by name | means | §4.4 |
/// |---|---|---|---|
/// | `n <= count()`, slot `None` | `has_name(k)`, `name(k)` is `None` | declared, did not participate | substitute `""`, send proceeds |
/// | `n > count()` | `!has_name(k)` | the pattern has no such group | refuse the send, log the token |
///
/// A `named` map holding only the groups that PARTICIPATED cannot tell those two rows apart — a
/// legitimate `(?<retry>\d+)?` that did not match would look exactly like `${typo}`, and §4.4's row 3
/// forbids refusing the send on the first. So the map is keyed on the declared names and carries the
/// `Option` inside, exactly as `groups` does.
#[derive(Debug, Clone, PartialEq)]
pub struct Captures {
    pub groups: Vec<Option<String>>,
    pub named: std::collections::BTreeMap<String, Option<String>>,
}

impl Captures {
    /// The group's text. `None` for both "did not participate" and "out of range" — `count()`
    /// separates them.
    pub fn group(&self, n: usize) -> Option<&str> {
        self.groups.get(n).and_then(|g| g.as_deref())
    }
    /// The named group's text: declared AND participated. `None` for both "declared but did not
    /// participate" and "not declared at all" — `has_name` separates them, as `count` does positionally.
    pub fn name(&self, k: &str) -> Option<&str> {
        self.named.get(k).and_then(|v| v.as_deref())
    }
    /// Whether the PATTERN declares this name, whether or not it participated in this match.
    pub fn has_name(&self, k: &str) -> bool {
        self.named.contains_key(k)
    }
    /// Capture groups excluding group 0, which is the whole match and always present.
    pub fn count(&self) -> usize {
        self.groups.len().saturating_sub(1)
    }
}

/// One `regex::Captures` as a `Captures`.
///
/// Both branches of `evaluate_text` build this, so it is one function rather than two copies: two
/// implementations of the same thing drift, and the half that drifts here is the half a `$1` reads.
///
/// **`named` is keyed on `capture_names()` — what the PATTERN declares — not on which names matched.**
/// Keying it on the match would drop a declared-but-non-participating name from the map entirely, and
/// §4.4 needs that case to be distinguishable from an undeclared one. The `Option` in the value is
/// what carries participation, mirroring `groups` exactly.
fn bag_from(re: &Regex, c: &regex::Captures<'_>) -> Captures {
    Captures {
        groups: (0..c.len())
            .map(|i| c.get(i).map(|m| m.as_str().to_string()))
            .collect(),
        named: re
            .capture_names()
            .flatten()
            .map(|n| (n.to_string(), c.name(n).map(|m| m.as_str().to_string())))
            .collect(),
    }
}

/// The value a numeric rule compares, from the LAST occurrence in the window.
///
/// **`captures_iter(..).last()`, never `captures()`.** `captures()` returns the FIRST match, so over a
/// 200-line window the OLDEST `ctx:NN%` would win forever, the value would never rise, and the
/// canonical rule would never fire. This is the single most likely wrong implementation, and it is
/// silent.
///
/// `keep` names which part is the value: `Brackets` takes the group named `value` when the pattern has
/// one, else group 1; `Whole` takes group 0. A `Brackets` pattern with no capture group is refused by
/// validation before it can run — never a silent fall-back to the whole match — and if one reaches
/// here anyway it reports `Unparsed` carrying the whole match rather than quietly comparing the wrong
/// span.
///
/// The second return value is EVERY group of that same last match, for the consumers that need more
/// than the one span `keep` names. It is `None` only when nothing matched, so it always describes the
/// same occurrence the `Read` does — a `$1` disagreeing with the compared value would be describing a
/// different line.
pub fn extract(re: &Regex, keep: Keep, text: &str) -> (Read, Option<Captures>) {
    let Some(caps) = re.captures_iter(text).last() else {
        return (Read::NoMatch, None);
    };
    let read = read_kept(&caps, keep);
    let bag = bag_from(re, &caps);
    (read, Some(bag))
}

/// The `keep` reduction of ONE match: which span is the value, and that span as a number.
///
/// Split out of `extract` so `evaluate_text` can populate `Outcome::Numeric` from the match §5.5
/// step 2 already took, rather than scanning the window a second time. Two copies of this choice is
/// exactly the drift `bag_from`'s own header refuses: the half that drifted here would be the half
/// the activity log prints, standing beside a condition decided from the other one.
fn read_kept(caps: &regex::Captures<'_>, keep: Keep) -> Read {
    let whole = caps.get(0).map(|m| m.as_str()).unwrap_or_default();
    let raw = match keep {
        Keep::Whole => Some(whole),
        Keep::Brackets => caps
            .name("value")
            .or_else(|| caps.get(1))
            .map(|m| m.as_str()),
    };
    match raw {
        None => Read::Unparsed(whole.to_string()),
        Some(s) => match coerce(s) {
            Some(v) => Read::Value(v),
            None => Read::Unparsed(s.to_string()),
        },
    }
}

/// The six comparators the mockup's drop-down draws.
///
/// `Eq`/`Neq` use an epsilon, never `==`, to tolerate small differences from independent computation
/// or rounding. Parsing the same decimal literal yields the same `f64`.
pub fn compare(op: CompareOp, value: f64, threshold: f64) -> bool {
    const EPS: f64 = 1e-9;
    match op {
        CompareOp::Gt => value > threshold,
        CompareOp::Gte => value >= threshold,
        CompareOp::Lt => value < threshold,
        CompareOp::Lte => value <= threshold,
        CompareOp::Eq => (value - threshold).abs() < EPS,
        CompareOp::Neq => (value - threshold).abs() >= EPS,
    }
}

// ---------------------------------------------------------------------------------------------
// Clause evaluation (§5.5, §5.6)
// ---------------------------------------------------------------------------------------------

/// One clause's answer, per §5.5's table.
///
/// **A `Number` test cannot be answered from thin air.** A token that did not participate, or one
/// that participated but is not a number, taught the read nothing — `Unknown`, never `False` — the
/// same asymmetry `Truth`'s own doc comment states for the whole rule. **A `Text` test sees a
/// non-participating token as `""`** — a known absence per §4.4, not a failed read — so
/// `IsEmpty`/`Contains`/etc. get a real, known answer from the same slot a number test could not
/// read at all.
///
/// A `Matches` clause whose own pattern will not compile is `Unknown` too: a broken clause must not
/// read as "no".
///
/// `Source::Named` is resolved with `caps.name(k)` alone, deliberately not `has_name(k)` first —
/// mirroring the positional branch, which reads `caps.group(n)` directly rather than checking
/// `n <= caps.count()`. §4.4's declared-vs-undeclared distinction exists for message substitution,
/// where an undeclared token must refuse the send rather than silently substitute `""`. §5.5's
/// table draws no such row: a clause naming a group the pattern does not declare is a validation
/// problem (§8), not a case this function is asked to tell apart from "declared but did not
/// participate" — both read as `None`/`""` here, exactly as an out-of-range `Group(n)` does.
pub fn test_clause(c: &Clause, caps: &Captures) -> Truth {
    match &c.test {
        Test::Number { op, value } => {
            let token = match &c.source {
                Source::Whole => caps.group(0),
                Source::Group(n) => caps.group(*n as usize),
                Source::Named(k) => caps.name(k),
            };
            // A clause with no threshold yet asks nothing, so it can be told nothing — `Unknown`,
            // the same answer an unreadable token gets, and for the same reason. It is a blocking
            // validation problem (`cond.clauseNeedsValue`), so only a hand-edited row reaches here;
            // reading it as `False` would make an unfinished comparison decide the rule.
            match (token.and_then(coerce), value) {
                (Some(v), Some(t)) => Truth::from_compare(compare(*op, v, *t)),
                _ => Truth::Unknown,
            }
        }
        Test::Text { op, value } => {
            // A text operator that needs text but has none is the same unfinished comparison as a
            // numeric clause with no threshold above. Dry runs deliberately evaluate drafts past
            // save-time validation, so return `Unknown` before `contains("")` can answer `True`.
            // `IsEmpty` and `IsNotEmpty` are different: their empty value is not an operand at all.
            if !matches!(op, TextOp::IsEmpty | TextOp::IsNotEmpty) && value.trim().is_empty() {
                return Truth::Unknown;
            }
            let token = match &c.source {
                Source::Whole => caps.group(0).unwrap_or_default(),
                Source::Group(n) => caps.group(*n as usize).unwrap_or_default(),
                Source::Named(k) => caps.name(k).unwrap_or_default(),
            };
            test_text(*op, token, value)
        }
    }
}

/// The text side of `test_clause`'s table, split out because `Number`'s match arm above has nothing
/// in common with it — a token, an operator, and a value to compare against.
fn test_text(op: TextOp, token: &str, value: &str) -> Truth {
    match op {
        TextOp::Is => Truth::from_compare(token == value),
        TextOp::IsNot => Truth::from_compare(token != value),
        TextOp::Contains => Truth::from_compare(token.contains(value)),
        TextOp::NotContains => Truth::from_compare(!token.contains(value)),
        TextOp::IsEmpty => Truth::from_compare(token.is_empty()),
        TextOp::IsNotEmpty => Truth::from_compare(!token.is_empty()),
        // A pattern that will not compile teaches nothing — `Unknown`, never `False` — the same
        // asymmetry a non-participating `Number` token gets above.
        //
        // **`automation_validation::compile`, never bare `Regex::new`.** The rule's OWN pattern is
        // compiled through that function at load, and `cond.badClausePattern` refuses a clause's
        // pattern through it at save; it bounds the compiled program at 1 MB, where the bare
        // constructor carries the regex crate's own 10 MB ceiling. Between the two sits a band of
        // patterns — `(?:[0-9a-z]{200}){200}` is twenty-two characters of it — that the editor
        // blocks and that this ran anyway: a pattern validated under one limit and then evaluated
        // under another. Two answers to one question, which is the drift §8 keeps having to fix.
        TextOp::Matches => match crate::automation_validation::compile(value) {
            Ok(re) => Truth::from_compare(re.is_match(token)),
            Err(_) => Truth::Unknown,
        },
    }
}

/// Fold N clause results into one under a single `Join`, in three-valued (Kleene) logic. §5.6.
///
/// Two-valued `&&`/`||` over `Unknown` treated as `false` would destroy the reason `Unknown` exists:
/// a rule with one broken clause and one satisfied one would silently read as "no" under AND and
/// "no" under OR-with-a-false-partner, either of which re-introduces the "once per line wearing once
/// per crossing's clothes" defect `Truth`'s doc comment warns about. Short-circuits are still real:
/// AND on a known `False` and OR on a known `True` decide the fold outright, `Unknown` partners or
/// not.
///
/// **An empty list is `Truth::True`**, for both joins — not the vacuous "no clause is False" AND
/// gets for free, and not the vacuous "no clause is True" OR would otherwise give. §5.5 step 4 only
/// reaches this function's caller when the pattern already matched, so an empty clause list means
/// the match itself is the whole condition — today's zero-clause word rule, unchanged.
pub fn fold_clauses(vals: &[Truth], join: Join) -> Truth {
    if vals.is_empty() {
        return Truth::True;
    }
    match join {
        Join::And => {
            if vals.iter().any(|v| *v == Truth::False) {
                Truth::False
            } else if vals.iter().any(|v| *v == Truth::Unknown) {
                Truth::Unknown
            } else {
                Truth::True
            }
        }
        Join::Or => {
            if vals.iter().any(|v| *v == Truth::True) {
                Truth::True
            } else if vals.iter().any(|v| *v == Truth::Unknown) {
                Truth::Unknown
            } else {
                Truth::False
            }
        }
    }
}

/// Print a value the way the log should read it: `63`, not `63.0`.
pub(crate) fn fmt_num(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        format!("{}", v)
    }
}

/// How deep the read went, in the log's own words.
pub(crate) fn depth_words(depth: ReadDepth) -> String {
    match depth {
        ReadDepth::Window(n) => format!("in the last {} lines", n),
        ReadDepth::VisibleScreen => "on screen".to_string(),
    }
}

/// The activity log's detail line for one evaluation.
///
/// The two failure outcomes must read DIFFERENTLY: `Unparsed` is the one failure validation cannot
/// catch — the pattern compiles, the capture is just the wrong span — so it is the dry run and this
/// line that a user meets it through.
pub fn read_detail(
    outcome: &Outcome,
    pattern: &str,
    depth: ReadDepth,
    decision: Decision,
) -> String {
    match outcome {
        Outcome::Numeric(Read::NoMatch) => {
            format!("nothing matching `{}` {}", pattern, depth_words(depth))
        }
        Outcome::Numeric(Read::Unparsed(saw)) => {
            format!("matched, but `{}` is not a number", saw)
        }
        Outcome::Numeric(Read::Value(v)) => format!("last value {}", fmt_num(*v)),
        // "still" is a claim about a match this pair had ALREADY acted on. On the crossing itself
        // the match is new, and a log line reading "still on screen" beside the message it just sent
        // describes an engine that had been watching it for a while — which is the one thing a user
        // reads that line to find out.
        Outcome::Presence(true) => match (depth, decision) {
            (ReadDepth::VisibleScreen, Decision::Held) => {
                format!("`{}` is still on screen", pattern)
            }
            (ReadDepth::VisibleScreen, _) => format!("`{}` matched on screen", pattern),
            (ReadDepth::Window(n), _) => format!("`{}` matched in the last {} lines", pattern, n),
        },
        Outcome::Presence(false) => match depth {
            ReadDepth::VisibleScreen => format!("`{}` is no longer on screen", pattern),
            ReadDepth::Window(n) => {
                format!("nothing matching `{}` in the last {} lines", pattern, n)
            }
        },
    }
}

// ---------------------------------------------------------------------------------------------
// One evaluation
// ---------------------------------------------------------------------------------------------

/// Remove this terminal's live echo needles from the text before anything reads it (§2.6, layer 1).
///
/// The **last** occurrence of each needle, not all of them: a needle is a message this engine typed,
/// and an earlier identical line the user typed themselves is genuine output. Needles are recorded
/// against the TERMINAL rather than the rule, so overlapping rules recognise each other's injections
/// — which is why this takes a flat slice and not a rule id.
///
/// **Whitespace-insensitive, and it has to be on BOTH sides.** The needle is recorded through
/// `send::normalise`, which collapses every run of whitespace to one space; this used to search the
/// RAW window text for that collapsed string with `rfind`. A single space never matches a newline, so
/// normalising only the needle could not make a match that a raw comparison would have missed — it
/// could only lose one, and it lost every multi-line message, which for an agent prompt is an
/// ordinary shape. The needle's non-space tokens are matched in order, separated by any run of
/// whitespace, which is a strict superset of what the raw comparison found.
///
/// It is still an approximation, and the direction is worth stating: it is sound when it *matches*
/// (those bytes really were this engine's message) and incomplete when it does not. A composer that
/// redraws the message behind a gutter — `│ `, a line number, a prompt — puts NON-whitespace between
/// the tokens, and no amount of whitespace tolerance sees through that. §2.6 layer 2's settle window
/// is the primary guard and *Re-arm now* is the manual backstop; this is the one that survives a tick
/// slipping through the window.
pub fn strip_echoes(text: &str, echoes: &[String]) -> String {
    let mut out = text.to_string();
    for needle in echoes {
        let Some(re) = echo_pattern(needle) else {
            continue;
        };
        let Some(at) = re.find_iter(out.as_str()).last().map(|m| m.range()) else {
            continue;
        };
        out.replace_range(at, "");
    }
    out
}

/// One needle as a pattern: its tokens, escaped, joined by "any whitespace".
///
/// `None` for a needle with no tokens at all, which is the empty needle the raw version skipped.
/// Every token goes through `regex::escape`, so a message containing regex metacharacters — which is
/// most messages, `?` and `.` alone — is matched literally.
fn echo_pattern(needle: &str) -> Option<Regex> {
    let mut tokens = needle.split_whitespace();
    let mut pattern = regex::escape(tokens.next()?);
    for token in tokens {
        pattern.push_str(r"\s+");
        pattern.push_str(&regex::escape(token));
    }
    Regex::new(&pattern).ok()
}

/// Everything one evaluation of one `(rule, terminal)` pair decided.
#[derive(Debug, Clone, PartialEq)]
pub struct Evaluation {
    pub depth: ReadDepth,
    pub outcome: Outcome,
    pub condition: Truth,
    pub next: ArmState,
    pub decision: Decision,
    pub detail: String,
    /// Every group of the match this evaluation read, on BOTH kinds of rule. `None` means nothing
    /// matched — never "this kind of rule does not collect groups", which is what the text branch's
    /// `is_match` used to mean and why every `$1` in a word rule resolved to nothing.
    pub captures: Option<Captures>,
}

/// Read, extract, compare, advance the arm state. The whole pure pipeline, in order.
///
/// `None` means the source had no text for that process id — the terminal is not live. Per §4.5 that
/// is DORMANT, not dead: no evaluation, no log line, and the arm state is left exactly as it was.
///
/// `echoes` is this TERMINAL's live needles (§2.6). It is a required argument rather than something
/// the caller strips first, because both entry points must honour the header's stated order and a
/// caller that forgets produces a rule stuck in `Fired` on its own message — indistinguishable from
/// working. Pass `&[]` when there are none.
pub fn evaluate(
    steps: InputSteps<'_>,
    re: &Regex,
    echoes: &[String],
    prev: ArmState,
    src: &dyn ScreenSource,
    process_id: &str,
    now_ms: i64,
) -> Option<Evaluation> {
    // The ONE place a `ScreenSource` becomes a reader, so the rule's opt-out is applied here rather
    // than inside `evaluate_text`: a caller that supplies its own reader is by definition holding
    // text that came from somewhere else, and a second gate there could only disagree with this one.
    let skip_typed_line = steps.monitor.skip_typed_line;
    evaluate_text(steps, re, echoes, prev, &|d| src.tail(process_id, d, skip_typed_line), now_ms)
}

/// `evaluate` over an already-resolved reader, for a caller that has the text by another route.
/// Strips the same needles, for the same reason.
pub fn evaluate_text(
    steps: InputSteps<'_>,
    re: &Regex,
    echoes: &[String],
    prev: ArmState,
    read: &dyn Fn(ReadDepth) -> Option<String>,
    now_ms: i64,
) -> Option<Evaluation> {
    let InputSteps { monitor, parse, cond } = steps;
    // §5.5 step 1. `finds` is READ here and passed through unchanged — it is derived from nothing,
    // least of all from the clause types. §5.2: `finds` answers "a reading, or an event?", which
    // selects the READ DEPTH; a clause's `Test` answers "number, or text?", which selects the
    // comparison. The two coincided only while there was exactly one comparison.
    // `API error 529 . retry in 60s` is an EVENT that contains a NUMBER: deriving `Finds::Reading`
    // from its numeric clause would hand it the deep window in both directions, `API error` would
    // stay findable in 200 lines of a quiet terminal's scrollback, the condition would never go
    // false, and the rule would sit in `Fired` for the rest of the session — the exact bug
    // `depth_for`'s own header was written to prevent.
    let depth = depth_for(cond.finds, monitor.read, prev);
    let text = strip_echoes(&read(depth)?, echoes);

    // §5.5 step 2 — ONE read of the window, feeding every consumer below, so the log line, the
    // condition and the message's `$1` all describe the SAME occurrence.
    //
    // `captures_iter(..).last()`, NOT `is_match` and NOT `.next()`. `is_match` is what made a word
    // rule produce no captures at all — not even group 1 — so every `$1` in spec 032's own scenarios
    // resolved to nothing. `.last()` because over a 200-line window the first match is the OLDEST,
    // so `captures()` would leave the canonical `ctx:NN%` rule reading a value that never rises.
    let hit = re.captures_iter(&text).last();

    // `Outcome` is UNCHANGED by the clause list, deliberately: it is what `read_detail`, `dry.rs`'s
    // parse step and `loops.rs`'s `LogKind::NoMatch` classification read, and all three describe
    // what the PATTERN read, not what the condition then decided from it. An event reports presence;
    // a reading reports the `keep`-named span reduced to a number, through the same `read_kept`
    // `extract` uses.
    let outcome = match cond.finds {
        Finds::Event => Outcome::Presence(hit.is_some()),
        Finds::Reading => Outcome::Numeric(match &hit {
            None => Read::NoMatch,
            Some(caps) => read_kept(caps, parse.keep),
        }),
    };
    let captures = hit.as_ref().map(|caps| bag_from(re, caps));

    let condition = match &captures {
        // §5.5 step 3 — the existing asymmetry, preserved verbatim, and NOT an inconsistency to
        // tidy. An event that did not appear genuinely did not happen, so its absence IS the
        // observation. A reading that produced no value learned nothing about that value — it may
        // merely have scrolled out of the depth — and `Truth::Unknown`'s own header is the authority
        // for why collapsing that to `false` re-introduces "once per line wearing once per
        // crossing's clothes".
        None => match cond.finds {
            Finds::Event => Truth::False,
            Finds::Reading => Truth::Unknown,
        },
        // §5.5 steps 4 and 5. Step 4 is not a branch of its own because `fold_clauses` already
        // answers `True` for an empty list, and it is reachable ONLY from this arm, where the
        // pattern HAS matched — so "no clauses" means the match itself is the whole condition
        // (§5.4's last row: today's word rule, written down). Step 5 is the Kleene fold of every
        // clause under the one join.
        //
        // A v1 `op`/`threshold` rule arrives here already folded into this list, which is why
        // neither field is read below: there is ONE folding implementation, `fold_v1_clauses`, and
        // it is not this one. Both callers of this core apply it — `reload` before it builds the
        // `LiveRule`, `dry::evaluate_once` on its own copy — and a third caller must too, or its
        // v1 rules will read every match as "the match is the whole condition".
        //
        // **`Reading` with no clauses is ALWAYS the incomplete v1 case, so it never fires.**
        // §5.4's table gives "no clauses" to the `Finds::Event` row only: a complete v1 pair folds
        // to exactly one clause, and a `Reading` rule authored with zero clauses is refused by
        // `cond.incomplete`. So the only shape that reaches here is a rule whose comparison was
        // never finished — and §5.5 step 4 would read its empty list as *the match is the whole
        // condition* and fire on EVERY match, flipping "runs, logs, never fires" into "types into
        // a live terminal every time the pattern appears".
        //
        // Validation gates both write paths, but `reload`'s re-validation exemption is scoped to
        // `parse.*` and deliberately does not re-check `cond.*`, so a hand-edited row reaches
        // evaluation. Neither `op` nor `threshold` is read to decide this, and the `Event` path
        // cannot be touched by it.
        Some(_) if cond.finds == Finds::Reading && cond.clauses.is_empty() => {
            Truth::Unknown
        }
        Some(caps) => fold_clauses(
            &cond.clauses.iter().map(|c| test_clause(c, caps)).collect::<Vec<_>>(),
            cond.join,
        ),
    };

    let (next, decision) = next_state(prev, condition, now_ms);
    Some(Evaluation {
        depth,
        detail: read_detail(&outcome, &parse.find, depth, decision),
        outcome,
        condition,
        next,
        decision,
        captures,
    })
}

#[cfg(test)]
mod tests;
