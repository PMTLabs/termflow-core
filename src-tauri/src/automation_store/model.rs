/// The current graph schema. A rule written by a NEWER TermFlow carries a higher number and is
/// **skipped, never deleted and never coerced** — multi-instance profiles make a downgrade real, and
/// silently reinterpreting a graph we do not understand is how a rule starts typing the wrong thing
/// into a terminal. `reload` logs exactly one entry per skipped rule per load. Plan §7.3.
///
/// `3` as of the webhook milestone: a rule is stamped only for the newest feature it actually uses,
/// never merely because this build can write one.
pub const SUPPORTED_SCHEMA_VERSION: i64 = 3;

// ---------------------------------------------------------------------------------------------
// The DTO. These serde names are THE AUTHORITY for the whole feature (plan §7.7): the renderer's
// mirror in `types/electron.d.ts` follows them, and `draftFromRule`/`ruleFromDraft` in the editor is
// the only mapping between this and the editor's draft. The audit that produced §7 found a draft
// whose `runMode` was silently defaulted onto a column called `runsOnce`, producing a rule that
// reported success and did nothing.
// ---------------------------------------------------------------------------------------------

/// How a rule chooses which terminals to watch. Plan §4.4.
///
/// `Command contains` reads the deepest foreground descendant's full COMMAND LINE, not the process
/// name — an npm-installed agent is `node.exe`, which is exactly why `detect_agent` reads the cmdline
/// to disambiguate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Criterion {
    CommandContains,
    /// Matches `Terminal.display_label` — the pushed-down tab/pane title — and never `Terminal.name`,
    /// which is `Terminal-{shell}` for every renderer-created terminal. Plan §4.2.
    TabNameContains,
    /// Component-wise, normalised through `open_commands::to_native_path`. NOT a string prefix:
    /// `~/work/termflow` must not match `~/work/termflow-site`, and those two sit side by side in the
    /// approved mockup.
    WorkingFolderUnder,
    TerminalIdIs,
    AllTerminals,
}

/// Whether the pick set is a live query or frozen. Plan §7.8.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TargetMode {
    /// Exactly the ids the user ticked in the picker.
    Pinned,
    /// Whatever matches `criterion` right now, re-resolved by the targeting tick every 2 s.
    Rule,
}

/// Which text the rule matches against — the rule's own preference. The two modes differ by window
/// depth through one helper.
///
/// Orthogonal to it, a `Finds::Event` rule picks its depth per DIRECTION regardless of this setting:
/// the 200 lines to fire (do not miss an event a chatty build scrolled past) and the visible screen to
/// re-arm (it is only still happening if it is still on screen). Plan §2.2, §2.2c.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReadMode {
    /// The last `MATCH_WINDOW_LINES` (200) lines, scrollback included.
    NewOutput,
    /// The visible rows only, at scrollback offset 0 — the right choice for a full-screen TUI, which
    /// redraws in place rather than scrolling.
    OnScreen,
}

/// When a rule is due. Plan §2.3.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Cadence {
    /// The terminal is dirty AND at least `EVENT_MIN_INTERVAL_MS` since its last evaluation.
    OnOutput,
    /// Every `every_ms`, whether or not anything was printed. R7.
    Timer,
}

/// Which preset filled the pattern in. Remembered rather than re-derived: the user may hand-edit the
/// pattern afterwards and the preset must not spring back. Plan §6.4b.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ParsePreset {
    Percentage,
    Number,
    ErrorCode,
    /// The user's literal text, regex-escaped into `find`. `literal` keeps what they actually typed so
    /// re-opening the rule does not show them `Do you want to proceed\?` and invite them to "fix" it.
    ExactWords,
    Custom,
}

/// Which part of the match is the value. Plan §2.2b — the mockup's *Keep* radio.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Keep {
    /// Capture group 1, or a group named `value` when the pattern has one. A pattern with NO capture
    /// group is a blocking validation problem, never a silent fall-back to the whole match.
    Brackets,
    /// Group 0 — the whole match.
    Whole,
}

/// **What the pattern finds** — a reading that persists, or an event that happened.
///
/// This is a question about the PATTERN, and it selects the **read depth**, not the comparison.
/// `depth_for` (`automation_engine/eval.rs`) is the only consumer: a value persists — `ctx:63%` is
/// still the current usage even when nothing reprints it — while an event's continued presence in
/// scrollback is not evidence it is still happening, so an `Event` rule reads the deep window to
/// NOTICE it and the visible screen to LET IT GO.
///
/// **It cannot be derived from the clause types, and 032 §5.2 exists to say so.**
/// `API error 529 … retry in 60s` is an *event* that contains a *number*; a rule testing `$2 > 60`
/// on it is numerically compared and eventfully read. Inferring `Reading` from "there is a numeric
/// clause" would give that rule the deep window in both directions, so `API error` would stay
/// findable in 200 lines of scrollback on a quiet terminal, the condition would never go false, and
/// the rule would sit in `Fired` for the rest of the session.
///
/// **Stored, not inferred**, for the same reason it always was: deriving it from "is `op` set" would
/// let a data-entry accident change which text the rule sees.
///
/// The rename from `CondKind { Number, Text }` is **Rust, TS and UI copy only**. The serde name of
/// the field stays `kind` and these values stay `"number"` / `"text"`, so the wire is byte-identical
/// to v1 — which matters in both directions: a v1 rule must still load, and an OLDER build reading a
/// v2 rule must still decode it, because an unknown enum-variant string is a hard decode failure
/// (§3.3). Do **not** add a container-level `rename_all` here; the per-variant renames are the
/// contract and a container rule would fight them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Finds {
    /// A value that persists. Reads its configured depth in both directions.
    #[serde(rename = "number")]
    Reading,
    /// An event. Reads the deep window to notice it and the visible screen to let it go.
    #[serde(rename = "text")]
    Event,
}

/// Which captured token a clause reads — the **same token vocabulary as the message** (§4.3), so the
/// grammar is learned once and one validator serves both. `$0` · `$1..$n` · `${name}`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    /// `$0` — the whole match.
    Whole,
    /// `$1`..`$n` — a numbered capture group.
    Group(u8),
    /// `${name}` — a named capture group.
    Named(String),
}

/// The text comparators, in the order the operator drop-down draws them. Plan §5.3.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TextOp {
    Is,
    IsNot,
    Contains,
    NotContains,
    Matches,
    IsEmpty,
    IsNotEmpty,
}

/// How one clause compares its token. **The clause's type IS the operator's** — there is no separate
/// type control that could contradict it (§5.9). Not `Finds`: see that type for why the two come
/// apart.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Test {
    /// **`value` is `Option<f64>` because a numeric clause with no threshold is a real, authorable
    /// state** — §8 names it (`cond.clauseNeedsValue`: *"a numeric clause with no threshold"*), and
    /// `CondPanel` mints one every time a row is switched from a text operator to a numeric one, or
    /// a number is half-typed. A bare `f64` had no spelling for that: the panel used `f64::NAN`'s TS
    /// twin, `JSON.stringify` turned it into `null` on the way through `invoke`, and serde refused
    /// the whole rule — so the editor could not save, and its navigation guard would not let it
    /// close. `None` is the wire's own word for "nothing entered yet", and validation blocks it
    /// exactly as it blocks a text clause with no text.
    ///
    /// `#[serde(default)]` is for consistency with every other optional field here rather than the
    /// mechanism: serde already treats a literal `Option<T>` as implicitly optional on a MISSING key.
    /// It is `null` — a key that is present and empty — that needs `Option`, and that is what the
    /// wire actually carries.
    Number {
        op: CompareOp,
        #[serde(default)]
        value: Option<f64>,
    },
    Text { op: TextOp, value: String },
}

/// One comparison: a token, and what to ask of it. Plan §5.3.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Clause {
    pub source: Source,
    pub test: Test,
}

/// How the clause list is folded. **One join for the whole list, not mixed precedence** —
/// `$1 = "429" AND $2 > 60 OR $3 = "quota"` has two readings and no parentheses to choose between
/// them, and the acceptance criterion asks the relationship to be unambiguous (§5.7).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Join {
    #[default]
    And,
    Or,
}

/// `And` is the default, so it is not written. Keeps a v1 rule's blob byte-identical — see `CondStep`.
fn is_default_join(join: &Join) -> bool {
    matches!(join, Join::And)
}

/// The six comparators the mockup's drop-down draws, in its order. Plan §2.2b.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CompareOp {
    Gt,
    Gte,
    Lt,
    Lte,
    /// `eq`/`neq` compare with an epsilon, never `==`. It tolerates small differences from
    /// independent computation or rounding; parsing the same decimal literal yields the same `f64`.
    ///
    /// This is also why coercion rejects non-finite values: `"NaN"` parses to `Ok(f64::NAN)`, and
    /// `(NaN - t).abs() < 1e-9` is `false`, so `Neq` would be **true** — a terminal printing `NaN%`
    /// would fire a "not equal to" rule and look exactly like a real crossing. Plan §2.2b.
    Eq,
    Neq,
}

/// Who receives the message when a rule fires. Plan Q2.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SendTo {
    /// The terminal whose output crossed. The default, and what every template uses.
    Matched,
    /// Every terminal the rule watches. Q2: a recipient's arm state does **not** change — re-arm
    /// belongs to the observation, so terminal B still fires on its own crossing.
    All,
}

/// Step 1 of the graph. The *targeting* half of the mockup's monitor step lives in columns, not here —
/// see the module-level note on `AutomationRule`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorStep {
    pub read: ReadMode,
    pub cadence: Cadence,
    /// Only meaningful for `Cadence::Timer`.
    pub every_ms: i64,
    /// Drop the logical line the cursor sits on, so a command still being TYPED cannot fire the
    /// rule. Reported: a rule matching `deploy` fired the moment the word appeared under the
    /// user's fingers, before Enter — the screen genuinely contains the text either way, and the
    /// engine has no other signal that separates an echoed keystroke from output.
    ///
    /// **Opt-in, and it has to be.** The cursor's line is real output for plenty of terminals — a
    /// full-screen TUI parks the cursor wherever it likes, and a rule reading the row it happens
    /// to rest on would silently lose its match. Off is what every rule written before this field
    /// did, and what every rule that never ticks the box keeps doing.
    ///
    /// **Only that one logical line**, never "the cursor's line and everything below": the
    /// reported use is an agentic CLI whose status line sits UNDER the input box, which is the
    /// text the rule is watching for. Dropping the tail of the screen would take the value with
    /// the noise.
    #[serde(default, skip_serializing_if = "is_off")]
    pub skip_typed_line: bool,
}

/// Off is the default, so it is not written — a rule that never ticks the box keeps a blob an
/// older build decodes byte for byte. Same reason as `is_default_join`.
fn is_off(flag: &bool) -> bool {
    !*flag
}

/// Step 2 — "Read a value". Plan §2.2b, §6.4b.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseStep {
    pub preset: ParsePreset,
    /// `ExactWords` only: what the user typed, before escaping.
    #[serde(default)]
    pub literal: Option<String>,
    /// The pattern that actually runs. Compiled backend-side once at rule load with
    /// `RegexBuilder::size_limit` — Rust's `regex` has no backtracking, so a user pattern cannot hang
    /// the evaluation loop, which the renderer's JS `RegExp` preview cannot promise.
    pub find: String,
    pub keep: Keep,
}

/// Step 3 — "Compare it". Plan §2.2b, 032 §5.3.
///
/// **Every field here is `skip_serializing_if`, and that is load-bearing.** A rule that uses no v2
/// feature must not GAIN a key on the way out, which is what makes §3.2's "only stamp
/// `schema_version` 2 when a v2 feature is actually used" implementable — and what keeps such a rule
/// loadable on an older build. A v1 numeric rule round-trips byte for byte; the one difference in
/// the other direction is that an absent `op`/`threshold` is now omitted rather than written as
/// `null`, which every build decodes identically because both carry `#[serde(default)]`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CondStep {
    /// The serde name stays `kind`; only the Rust/TS/UI name moved. See `Finds`.
    #[serde(rename = "kind")]
    pub finds: Finds,
    /// In order. **Empty means "fire when the pattern matches"** — exactly today's text rule, which
    /// is why the empty list is not a special case invented here (§5.4).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub clauses: Vec<Clause>,
    /// One join for the whole list. `And` unless said otherwise.
    #[serde(default, skip_serializing_if = "is_default_join")]
    pub join: Join,
    /// v1 only. Read at load, folded into `clauses`, never written again (§5.4).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub op: Option<CompareOp>,
    /// v1 only. Read at load, folded into `clauses`, never written again (§5.4).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub threshold: Option<f64>,
}

/// Written by hand rather than derived so that `Finds` keeps NO `Default`: which text a rule reads is
/// always an explicit choice, never something a struct-update expression can fill in behind the
/// author's back. `Reading` here is only the residue of `..Default::default()`, and every caller
/// names `finds` itself.
impl Default for CondStep {
    fn default() -> Self {
        Self {
            finds: Finds::Reading,
            clauses: Vec::new(),
            join: Join::And,
            op: None,
            threshold: None,
        }
    }
}

/// Step 4 — "Send to terminal". Plan §2.5, Q1.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionStep {
    pub message: String,
    #[serde(default = "default_send_to")]
    pub send_to: SendTo,
    /// Whether to press Enter after the text. `false` leaves the message sitting in the composer,
    /// which is a legitimate "draft it for me" rule.
    #[serde(default = "default_true")]
    pub submit: bool,
    /// Q1's hybrid: route A's paste / settle / submit with an explicit CLI type rather than route A's
    /// own default of `"copilot"` (Down-Arrow + CR), which navigates history in a plain shell.
    #[serde(default = "default_cli_type")]
    pub cli_type: String,
    /// Whether `$1`, `$2`, `${name}` in `message` are replaced with the pattern's captures.
    ///
    /// **Defaults to `false`, and that is a correctness decision, not caution.** `$` is a legal
    /// literal today — `awk '{print $1}'` and `echo $PATH` are messages people have already
    /// written — so substituting by default would silently rewrite them with no error. Every
    /// rule written before this field loads with it off and sends exactly what it sent
    /// yesterday. Plan 032 §4.2.
    #[serde(default)]
    pub substitute: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WebhookProvider { Discord, Teams, Slack, Custom }

/// An optional destination outside the terminal. Its URL is persisted and sent over IPC in the
/// clear by design, but is never displayed, logged, exported, or put in an error.
#[derive(Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookStep {
    pub provider: WebhookProvider,
    pub url: String,
    pub body: String,
    #[serde(default)]
    pub substitute: bool,
}

impl std::fmt::Debug for WebhookStep {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebhookStep").field("provider", &self.provider).field("url", &"<redacted>")
            .field("body", &self.body).field("substitute", &self.substitute).finish()
    }
}

fn default_send_to() -> SendTo {
    SendTo::Matched
}
fn default_true() -> bool {
    true
}
fn default_cli_type() -> String {
    "default".to_string()
}

/// Step 5 (optional) — "Wait" in the panel and every other user-facing string. **Never call this
/// "Timer" where a user reads it**: `Cadence::Timer` already owns that word and means the monitor's
/// poll interval, a different thing entirely. `TimerStep`/`TimerMode` and the `timer` field are the
/// spec's own Rust names (§3.1) and stay as-is — the constraint is on UI copy, not identifiers.
///
/// `AfterMatch` parks a send for `delay_ms` (§6.2), and `DailyAt` uses `schedule_due` (§6.3).
/// This type is the persisted schema for those implemented modes.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimerStep {
    pub mode: TimerMode,
}

/// Plan §3.1, §6.
///
/// **The container's `rename_all` does not reach a struct variant's own fields** — only the variant
/// NAME (`AfterMatch` → `afterMatch`). Confirmed by writing the failing wire-shape test first: it
/// serialised `{"mode":{"afterMatch":{"delay_ms":30000}}}`, snake_case field intact. Each struct
/// variant repeats `rename_all` for its fields.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TimerMode {
    /// Scenario 2 (§6.2). Parked when the condition crosses; fires `delay_ms` later.
    #[serde(rename_all = "camelCase")]
    AfterMatch { delay_ms: i64 },
    /// Scenario 1 (§6.3). Local wall-clock. `days` is a weekday bitmask, Mon = bit 0.
    #[serde(rename_all = "camelCase")]
    DailyAt { minute_of_day: i32, days: u8 },
}

/// The bits of `TimerMode::DailyAt::days` that name a weekday — 0–6, Mon..Sun (§3.1).
///
/// `u8` has an 8th bit (0x80) that names no day at all, so a hand-crafted or corrupted mask with
/// only that bit set selects nothing. **Lives here, beside the field it describes, so validation
/// and evaluation cannot disagree about it**: `automation_validation`'s `timer.noDays` asks whether
/// a rule can ever fire, and §6.3's `schedule_due` asks whether it fires now — two answers to one
/// question, and a mask re-declared in the engine is how they drift apart.
pub const WEEKDAY_BITS_MASK: u8 = 0b0111_1111;

/// The exclusive upper bound on `TimerMode::DailyAt::minute_of_day` — `0..1440`, midnight inclusive.
///
/// **Here for the same reason `WEEKDAY_BITS_MASK` is**, and it is the same defect one field over:
/// `minute_of_day` is a bare `i32`, so `-5` and `5000` both decode, and neither is a time of day.
/// `-5` makes `now >= target` true from midnight onwards — a rule that fires the moment the app
/// starts, every day — and `5000` makes it true never. `automation_validation`'s `timer.badMinute`
/// asks whether the rule can ever fire *sensibly* and §6.3's `schedule_due` asks whether it fires
/// now; both read this bound, so a hand-crafted or corrupted row is refused by both or by neither.
pub const MINUTES_PER_DAY: i32 = 24 * 60;

/// The four steps, stored whole as a JSON blob in `automation_rules.graph`.
///
/// Blob rather than normalised because it is never queried and never written at a different cadence
/// from the rest of the rule: read and written whole by exactly two consumers (the editor and the
/// evaluator), and nobody asks "which rules compare against > 25". Normalising four fixed steps buys a
/// join per load plus a schema change every time a step gains a field, in a crate with no migration
/// machinery at all. Plan §3.1.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationGraph {
    /// `None` on a **schedule rule** (§3.1, §6.3) — one that fires at a wall-clock time and reads
    /// nothing at all. The first three steps are the rule's INPUT: they exist together or not at
    /// all, which is what [`crate::automation_engine::eval::InputSteps`] names.
    ///
    /// **Targeting is unaffected by this being absent** (§3.1): `target_mode`, `criterion`,
    /// `criterion_value`, `follow_new` and `target_ids` are columns on `AutomationRule`, not fields
    /// of `MonitorStep`, so a schedule rule still has its terminals and `watched_for` still works.
    ///
    /// **`skip_serializing_if`, matching `timer` and `layout` below, and it is load-bearing**: an
    /// absent step must produce no key at all, never `"monitor": null`. A `null` makes an older
    /// build fail the row at DECODE — §3.3's whole-list loss — instead of at the friendlier
    /// `is_runnable()` gate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub monitor: Option<MonitorStep>,
    /// `None` on a schedule rule — there is no pattern, which is a different thing from a pattern
    /// that is blank. See `monitor` above for why the key is omitted rather than written `null`.
    ///
    /// **Never `unwrap_or_default()` this.** `ParseStep::default()` would give an EMPTY pattern, and
    /// an empty pattern compiles and matches everything (see `reload`), so a defaulted schedule rule
    /// would fire on every tick against every terminal it watches and type into live agents.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parse: Option<ParseStep>,
    /// `None` on a schedule rule — nothing was read, so there is nothing to compare.
    ///
    /// **Never `unwrap_or_default()` this either.** `CondStep::default()` is `Finds::Reading` with
    /// an empty clause list, which `evaluate_text` answers `Truth::Unknown` for on purpose (the
    /// incomplete-v1 guard) — so a defaulted condition is a rule that can never fire, silently.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cond: Option<CondStep>,
    /// Optional fifth step — "Wait" (§6). `None` on every rule saved before this milestone and on
    /// every rule that does not use it.
    ///
    /// **`#[serde(default)]` is redundant here today** — serde's derive already treats a field
    /// whose type is syntactically `Option<…>` as absent-ok, decoding a missing key to `None` with
    /// or without this attribute (`a_graph_with_no_timer_key_still_decodes_as_none`'s mutation
    /// check: removing it left the test green). Kept anyway, matching `literal`/`layout` above: it
    /// documents intent, and it is the only thing that keeps this field optional the day someone
    /// hides `Option<TimerStep>` behind a type alias, at which point serde stops recognising the
    /// shape and this attribute becomes load-bearing rather than decorative.
    #[serde(default)]
    pub timer: Option<TimerStep>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<ActionStep>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub webhook: Option<WebhookStep>,
    /// Where the editor's four cards sit on its canvas.
    ///
    /// **View state, deliberately inside the rule's blob.** The plan originally kept the layout out
    /// of here on the grounds that it would be "a schema field that nothing reads back" — true while
    /// dragging a card was a comfort that evaporated on close. It is not true now: a rearrangement is
    /// a change the user expects to keep, which makes the *Leave without saving?* prompt's promise
    /// ("Saving keeps them") either honest or a lie depending on this field existing.
    ///
    /// The engine never reads it. It rides along because the alternative — a second persistence path
    /// beside `save_rule`, with its own dirty baseline — is two ways to save one document.
    ///
    /// `BTreeMap`, not `HashMap`: this is re-serialised on every save and compared as a STRING by the
    /// editor's dirty check, so a map that shuffles its key order would make a rule read dirty at
    /// random. `Option` + `serde(default)` so every row written before this field still loads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<std::collections::BTreeMap<String, NodePos>>,
}

/// The schema version a graph's own shape requires — pure, and the only thing that decides the
/// stamp `write_rule` writes (plan 032 §3.2, task 27). Never trust a caller's existing
/// `schema_version` instead of this: a rule that gains a clause must not keep the `1` the renderer
/// echoed back, which is what would happen if the stamp were merely carried through.
///
/// **Wider than §3.2's literal text.** The spec's predicate is `monitor.is_none()`, written in
/// §3.1's world where all three input steps go optional together, so `monitor.is_none()` stood in
/// for the whole class. An older build's `AutomationGraph` has `monitor`, `parse` **and** `cond` as
/// required, non-`Option` fields — so any one of the three being absent is what actually breaks an
/// older build's decode, not the monitor specifically. This checks all three (task 27 ruling R1).
///
/// **Not sticky.** A rule that drops its last clause reads back `1` on its very next save — the
/// literal reading of "actually uses", chosen because it maximises downgrade compatibility. The
/// opposite (monotonic, "once v2 always v2") is the more obvious thing to write by accident, which
/// is why `schema_version_is_stamped_from_what_the_rule_actually_uses` pins the non-sticky case
/// explicitly rather than leaving it to be implied by the others (task 27 ruling R4).
pub fn schema_version_for(rule: &AutomationRule) -> i64 {
    let graph = &rule.graph;
    let uses_a_v2_feature = graph.timer.is_some()
        || graph.monitor.is_none()
        || graph.parse.is_none()
        || graph.cond.is_none()
        || graph.cond.as_ref().is_some_and(|c| !c.clauses.is_empty())
        || graph.action.as_ref().is_some_and(|action| action.substitute);
    let uses_a_v3_feature = graph.webhook.is_some() || graph.action.is_none()
        || !rule.excluded_ids.is_empty() || rule.exclude_criterion.is_some()
        || !rule.exclude_criterion_value.is_empty()
        // Ships in this same milestone. An older build decodes the rule fine and ignores the key,
        // which is the case the stamp exists to signal: it would read the line the user is still
        // typing and fire on it — the exact behaviour the box was ticked to stop.
        || graph.monitor.as_ref().is_some_and(|monitor| monitor.skip_typed_line);
    if uses_a_v3_feature { 3 } else if uses_a_v2_feature {
        2
    } else {
        1
    }
}

/// Fixture accessors for the three input steps — **test-only, and deliberately so**.
///
/// The ~40 fixtures that tweak one field of one step (`rule.graph.parse_mut().find = …`) all know
/// their own rule has that step, because they built it. Spelling `.as_mut().unwrap()` at every one
/// of them would bury the field being set in noise.
///
/// It is `#[cfg(test)]` because the same convenience in production is exactly the escape hatch that
/// stops absence getting an explicit branch (§3.1) — and for `parse`/`cond` an `unwrap` is not the
/// worst of it: `unwrap_or_default()` would give a schedule rule an EMPTY pattern, which compiles
/// and matches everything.
#[cfg(test)]
impl AutomationGraph {
    #[track_caller]
    pub fn monitor_mut(&mut self) -> &mut MonitorStep {
        self.monitor.as_mut().expect("this fixture's rule has a monitor step")
    }
    #[track_caller]
    pub fn parse_mut(&mut self) -> &mut ParseStep {
        self.parse.as_mut().expect("this fixture's rule has a parse step")
    }
    #[track_caller]
    pub fn cond_mut(&mut self) -> &mut CondStep {
        self.cond.as_mut().expect("this fixture's rule has a cond step")
    }
    #[track_caller]
    pub fn action_mut(&mut self) -> &mut ActionStep {
        self.action.as_mut().expect("this fixture's rule has an action step")
    }
    #[track_caller]
    pub fn monitor_ref(&self) -> &MonitorStep {
        self.monitor.as_ref().expect("this fixture's rule has a monitor step")
    }
    #[track_caller]
    pub fn parse_ref(&self) -> &ParseStep {
        self.parse.as_ref().expect("this fixture's rule has a parse step")
    }
    #[track_caller]
    pub fn cond_ref(&self) -> &CondStep {
        self.cond.as_ref().expect("this fixture's rule has a cond step")
    }
}

/// One card's position on the editor canvas. Pure view data; see `AutomationGraph::layout`.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct NodePos {
    pub x: f64,
    pub y: f64,
}

/// One rule, as it crosses the wire and as it sits in `automation_rules`.
///
/// **Targeting is columns, not blob.** `target_mode`, `criterion`, `criterion_value` and `follow_new`
/// are queried, and `touch_target` writes the targets table on a completely different cadence from
/// user edits — in the blob, every label refresh would become a read-modify-write of the whole rule,
/// and a touch landing between a window's load and its save would either clobber the user or be
/// clobbered by them. `target_ids` is filled from `automation_targets` on read and replaced wholesale by
/// `save_rule`. Plan §3.1, §7.7.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRule {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    /// R6. A single-run rule that has fired never evaluates again — enforced in memory the moment it
    /// completes, not merely filtered at the next `reload`. Plan §7.8.
    pub runs_once: bool,

    // --- targeting (columns) ---
    pub target_mode: TargetMode,
    pub criterion: Criterion,
    pub criterion_value: String,
    /// `false` freezes the matched set at load/enable, so a terminal the user deliberately excluded
    /// cannot join later. Read by the targeting tick — round 0's audit found this written, drawn,
    /// printed, and read by nobody.
    pub follow_new: bool,
    /// The `tm-` leaves this rule watches. Durable ids, never `pc-` process ids: a `pc-` is per-run, so
    /// a rule saved across a restart would point at nothing. Plan §7.4.
    #[serde(default)]
    pub target_ids: Vec<String>,
    #[serde(default)]
    pub excluded_ids: Vec<String>,
    #[serde(default)]
    pub exclude_criterion: Option<Criterion>,
    #[serde(default)]
    pub exclude_criterion_value: String,

    // --- runtime flags that outlive a process ---
    /// Set when a `runs_once` rule fires. `None` means it can still run.
    #[serde(default)]
    pub completed_at: Option<i64>,
    /// "Log every check" is opt-in and expires; this is when it stops. Plan §3.3.
    #[serde(default)]
    pub verbose_until: Option<i64>,

    /// Explicit, because a duplicate must land **directly under** its original — which a `created_at`
    /// sort cannot express. `ORDER BY sort_order, id`.
    pub sort_order: i64,
    /// See `SUPPORTED_SCHEMA_VERSION`.
    pub schema_version: i64,

    pub graph: AutomationGraph,
    pub created_at: i64,
    pub updated_at: i64,
}

/// What kind of thing happened. Derived from `kind` inside `append`, never passed in — a caller that
/// could label its own entry could gate a `Sent` entry behind the verbose flag and lose the one line
/// the log exists for. Plan §3.3.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LogKind {
    Sent,
    Held,
    ReArmed,
    NoMatch,
    Failed,
    Enabled,
    Disabled,
    Saved,
    TestRun,
    /// Every-check logging. The only kind the verbose gate can drop.
    Check,
}

/// One activity-log row.
///
/// `terminal_name` is a **snapshot written with the entry**, never a lookup at display time (R17).
/// That distinction is the whole requirement: the `failed — the terminal closed` line is written after
/// the terminal is gone, so a display-time lookup returns nothing for exactly the line the feature
/// uses to prove itself, and a rename would rewrite the past.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationLogEntry {
    pub id: i64,
    pub rule_id: String,
    #[serde(default)]
    pub terminal_id: Option<String>,
    #[serde(default)]
    pub terminal_name: Option<String>,
    pub kind: LogKind,
    pub detail: String,
    pub at: i64,
}

/// What `append` did, and what its caller must do next.
///
/// The store has no `AppHandle` and cannot emit (see the module doc). It still owns the DECISION —
/// one `automation:activity` per second at most — so the rate limit cannot be re-implemented per caller.
/// Plan §7.5.
#[derive(Debug, Clone, PartialEq)]
pub struct AppendOutcome {
    pub entry_id: i64,
    /// The caller emits `automation:activity` when this is true, and does nothing when it is false.
    pub emit: bool,
    pub rule_ids: Vec<String>,
}

/// Which rows `load_automation_log` returns and in what order.
///
/// Both callers pass explicitly: the drawer is a recent-activity peek (newest first) and the full log
/// is a timeline you read forward (oldest first). Round 0's audit found the two surfaces disagreeing
/// with nothing in between to settle it. Plan §7.8, Q8.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LogScope {
    Rule(String),
    All,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogOrder {
    Asc,
    Desc,
}

/// Why every method returns `Result`, following `CanvasStoreError`: a bare bool collapses "disabled",
/// "not found" and "SQLite is locked" into one `false`. The panel, the log view and the editor each
/// render `Disabled` explicitly and differently from empty — an empty list where rules exist invites a
/// user to recreate rules they already have. Plan §7.8.
#[derive(Debug)]
pub enum AutomationStoreError {
    /// The DB could not be opened at startup, so the store is inert.
    Disabled,
    Sqlite(rusqlite::Error),
    /// The `graph` blob failed to parse, or a rule was rejected by validation on the enable path.
    Invalid(String),
}

impl std::fmt::Display for AutomationStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Disabled => write!(f, "automation store is disabled"),
            Self::Sqlite(e) => write!(f, "automation store sqlite error: {e}"),
            Self::Invalid(m) => write!(f, "automation store rejected the value: {m}"),
        }
    }
}

impl std::error::Error for AutomationStoreError {}

impl From<rusqlite::Error> for AutomationStoreError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Sqlite(e)
    }
}

impl AutomationRule {
    /// Whether this build can run the rule. A rule written by a NEWER TermFlow is **skipped, not
    /// deleted** — it keeps its row and the engine passes over it (plan §7.3). A predicate on the rule
    /// rather than a filter inside `list_rules`, deliberately: the Settings list must still SHOW it, or
    /// a user who downgrades watches their rules silently vanish.
    pub fn is_runnable(&self) -> bool {
        self.schema_version <= SUPPORTED_SCHEMA_VERSION
    }
}

