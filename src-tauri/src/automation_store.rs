//! Persistence for Terminal Automations — rules, their pinned terminals, and the activity log.
//!
//! Plan `028`.
//!
//! Modelled line for line on `canvas_store.rs`: its **own** `rusqlite::Connection` to the same
//! per-profile `history.db`, its own `CREATE TABLE IF NOT EXISTS`, degrade-to-inert on open failure,
//! and `Result` on every method. Its own connection matters — automation writes then contend with
//! automation writes, not with the 30 s scrollback flush that holds `HistoryStore`'s mutex while it
//! writes multi-MB blobs.
//!
//! It deliberately holds **no `AppHandle`**. `append` decides whether a `automation:activity` event is
//! due and says so in its return value; the caller — the engine or the command layer, both of which
//! already have a handle — performs the emit. An `AppHandle<R>` field here would make the whole struct
//! generic over the Tauri runtime and drag its unit tests behind `--features integration-tests`, which
//! is Linux-only (`Cargo.toml`). Plan §7.5, §7.10.
//!
//! **M0 landed the types below; M1 landed the store.**

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Mutex;

use dashmap::DashMap;
use rusqlite::Connection;

/// The current graph schema. A rule written by a NEWER TermFlow carries a higher number and is
/// **skipped, never deleted and never coerced** — multi-instance profiles make a downgrade real, and
/// silently reinterpreting a graph we do not understand is how a rule starts typing the wrong thing
/// into a terminal. `reload` logs exactly one entry per skipped rule per load. Plan §7.3.
pub const SUPPORTED_SCHEMA_VERSION: i64 = 1;

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
/// Orthogonal to it, a `CondKind::Text` rule picks its depth per DIRECTION regardless of this setting:
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

/// Whether the rule compares a number or just asks whether some text appeared.
///
/// **Stored, not inferred**, and these are the mockup's own two values verbatim (`cond:{ kind:'number',
/// … }` and template 4's `cond:{ kind:'text' }`). Plan §2.2c makes this select a genuinely different
/// READ DEPTH — a value persists, so a numeric rule reads the 200-line window in both directions; an
/// event does not, so a text rule fires off the window but re-arms off the visible screen. Deriving the
/// kind from "is `op` set" would let a data-entry accident change which text the rule sees.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CondKind {
    Number,
    Text,
}

/// The six comparators the mockup's drop-down draws, in its order. Plan §2.2b.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CompareOp {
    Gt,
    Gte,
    Lt,
    Lte,
    /// `eq`/`neq` compare with an epsilon, never `==`. A threshold of `0.1` typed by a user and a
    /// `0.1` parsed out of terminal text are two different `f64`s, and an exact float comparison that
    /// is almost always false is the worst kind of silent failure.
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

/// Step 3 — "Compare it". Plan §2.2b.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CondStep {
    pub kind: CondKind,
    /// `None` when `kind == Text`.
    #[serde(default)]
    pub op: Option<CompareOp>,
    /// `None` when `kind == Text`.
    #[serde(default)]
    pub threshold: Option<f64>,
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

fn default_send_to() -> SendTo {
    SendTo::Matched
}
fn default_true() -> bool {
    true
}
fn default_cli_type() -> String {
    "default".to_string()
}

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
    pub monitor: MonitorStep,
    pub parse: ParseStep,
    pub cond: CondStep,
    pub action: ActionStep,
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

/// How many entries a rule's log keeps.
const LOG_CAP: i64 = 200;
/// How far past the cap the counter may drift before one watermark DELETE runs. Trimming at exactly
/// `LOG_CAP` would run a DELETE on every write once a busy rule reached it.
const LOG_SLACK: i64 = 50;
/// The verbose gate's floor, per `(rule, terminal)`. Keyed by the pair and not the terminal alone:
/// with a terminal-only key one chatty rule consumes the whole budget and a second rule watching the
/// same terminal writes nothing — its log empty, which reads as "the rule isn't running". Plan §3.3.
const VERBOSE_MIN_INTERVAL_MS: i64 = 1000;
/// At most one `automation:activity` per second. The store owns this DECISION even though its caller
/// performs the emit, so it cannot be re-implemented per caller. Plan §7.5.
const EMIT_MIN_INTERVAL_MS: i64 = 1000;
/// `last_seen_at` is refreshed at most this often. A CHANGED label or folder is always written
/// immediately regardless — the throttle skips a write when nothing else changed; it does not delay
/// the snapshot the picker's "not open" row draws. Plan §7.6.
const LAST_SEEN_THROTTLE_MS: i64 = 5 * 60 * 1000;

/// One rule's pinned target ids, in the list's own order. `list_rules` runs the same predicate and
/// order as one bulk query across every rule; this is the single-rule shape.
const PINNED_TARGET_IDS_SQL: &str = "SELECT terminal_id FROM automation_targets \
     WHERE rule_id = ?1 AND source = 'pinned' ORDER BY added_at, terminal_id";

const RULE_COLUMNS: &str ="id, name, enabled, runs_once, target_mode, criterion, criterion_value, \
     follow_new, completed_at, verbose_until, sort_order, schema_version, graph, created_at, updated_at";

/// Whether an entry is subject to the verbose gate. **Derived from `kind` inside `append`, never
/// passed in.** A caller that could label its own entry could gate a `Sent` behind the verbose flag
/// and lose the one line the log exists for — `gate-in-the-caller-lets-new-callers-opt-out` wearing a
/// store's clothes. Plan §3.3.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LogClass {
    Decision,
    Check,
}

fn class_of(kind: LogKind) -> LogClass {
    match kind {
        LogKind::Check | LogKind::NoMatch => LogClass::Check,
        _ => LogClass::Decision,
    }
}

/// Enum ⇄ TEXT through serde, so a column can never spell a variant differently from the wire.
/// A hand-written `as_db_str`/`from_db_str` pair would be a second spelling of one mapping, and
/// `two-implementations-one-fix` says what happens next.
fn enum_to_db<T: serde::Serialize>(v: &T) -> Result<String, AutomationStoreError> {
    match serde_json::to_value(v) {
        Ok(serde_json::Value::String(s)) => Ok(s),
        other => Err(AutomationStoreError::Invalid(format!(
            "expected a string-valued enum, got {other:?}"
        ))),
    }
}

fn enum_from_db<T: serde::de::DeserializeOwned>(s: &str) -> Result<T, AutomationStoreError> {
    serde_json::from_value(serde_json::Value::String(s.to_string()))
        .map_err(|e| AutomationStoreError::Invalid(format!("unknown stored value {s:?}: {e}")))
}

/// "No such row" from a single-row query, **without** flattening every other failure into it.
///
/// `query_row(..).ok()` is the trap this exists to close: it turns `SQLITE_BUSY` — which the 30 s
/// scrollback flush makes a routine event on this file — into a confident "that rule does not exist".
/// `get_rule` would answer `Ok(None)` to a caller holding the rule in front of the user, `save_rule`
/// would report an existing rule as new and log the wrong loser of a two-window race, `touch_target`
/// would follow up with an INSERT and fail on the primary key, and the verbose gate would silently
/// drop a Check entry. That is the exact collapse the module doc says returning `Result` prevents, so
/// the doc was only true of the methods that did this. One helper, every site.
fn optional_row<T>(r: rusqlite::Result<T>) -> Result<Option<T>, AutomationStoreError> {
    match r {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(AutomationStoreError::Sqlite(e)),
    }
}

/// A rule row exactly as SQLite hands it over, before any JSON is parsed.
///
/// The two decodings are separated because their errors are: `rusqlite::Error` for a column that is
/// missing or the wrong type, `AutomationStoreError::Invalid` for a graph blob or enum spelling this
/// build does not understand. Flattening them would report a corrupt rule as a database failure and
/// send the panel to its `Disabled` state, which says something false to the user.
struct RawRule {
    id: String,
    name: String,
    enabled: bool,
    runs_once: bool,
    target_mode: String,
    criterion: String,
    criterion_value: String,
    follow_new: bool,
    completed_at: Option<i64>,
    verbose_until: Option<i64>,
    sort_order: i64,
    schema_version: i64,
    graph: String,
    created_at: i64,
    updated_at: i64,
}

fn read_rule_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<RawRule> {
    Ok(RawRule {
        id: r.get(0)?,
        name: r.get(1)?,
        enabled: r.get(2)?,
        runs_once: r.get(3)?,
        target_mode: r.get(4)?,
        criterion: r.get(5)?,
        criterion_value: r.get(6)?,
        follow_new: r.get(7)?,
        completed_at: r.get(8)?,
        verbose_until: r.get(9)?,
        sort_order: r.get(10)?,
        schema_version: r.get(11)?,
        graph: r.get(12)?,
        created_at: r.get(13)?,
        updated_at: r.get(14)?,
    })
}

fn hydrate_rule(raw: RawRule) -> Result<AutomationRule, AutomationStoreError> {
    Ok(AutomationRule {
        graph: serde_json::from_str(&raw.graph).map_err(|e| {
            AutomationStoreError::Invalid(format!("rule {}: bad graph blob: {e}", raw.id))
        })?,
        target_mode: enum_from_db(&raw.target_mode)?,
        criterion: enum_from_db(&raw.criterion)?,
        id: raw.id,
        name: raw.name,
        enabled: raw.enabled,
        runs_once: raw.runs_once,
        criterion_value: raw.criterion_value,
        follow_new: raw.follow_new,
        target_ids: Vec::new(),
        completed_at: raw.completed_at,
        verbose_until: raw.verbose_until,
        sort_order: raw.sort_order,
        schema_version: raw.schema_version,
        created_at: raw.created_at,
        updated_at: raw.updated_at,
    })
}

/// The activity event's coalescing state: when one was last due, and which rules have written since.
///
/// `pending` is why `AppendOutcome.rule_ids` is a list. Entries keep landing while the 1 s window is
/// shut, and the one emit that follows has to name every rule they belonged to — otherwise a rule
/// whose only entry fell inside a shut window never repaints.
#[derive(Default)]
struct EmitState {
    last_ms: i64,
    pending: Vec<String>,
}

/// Rules, their pinned terminals and the activity log, stored beside scrollback in `history.db`.
pub struct AutomationStore {
    conn: Mutex<Option<Connection>>,
    /// Rows per rule, for the cap. Lazily seeded once per rule per process by one indexed
    /// `SELECT COUNT(*)`. Its accuracy decides only WHEN the trim runs, never whether it is correct.
    log_counts: DashMap<String, i64>,
    /// `(rule_id, terminal_id)` → the `at` of the last `Check` entry written for that pair.
    last_verbose: DashMap<(String, Option<String>), i64>,
    /// `rule_id` → its `verbose_until`, so the gate does not hit SQLite on the evaluator's hot path.
    ///
    /// `class_of` sends **`NoMatch`** to the gate as well as `Check`, and `NoMatch` is the ordinary
    /// outcome of a rule whose pattern did not match — most evaluations of most pairs. Without this
    /// cache every one of them costs a lock plus a `SELECT verbose_until` against `history.db`;
    /// at §2.3's `MAX_EVALS_PER_TICK` of 400 and a 4/s cadence that is ~1600 discarded SELECTs a
    /// second, contending with the same 30 s multi-MB flush `busy_timeout` exists because of.
    /// Written through by `save_rule` and the sweep, dropped by `delete_rule`.
    verbose_cache: DashMap<String, Option<i64>>,
    /// `(rule_id, terminal_id)` → the `(label, folder, last_seen_at)` this process last stored.
    ///
    /// The targeting tick asks `touch_target` about every terminal every live rule watches, every
    /// 2 s, and the answer is almost always *nothing changed* — which cost a `SELECT` per question on
    /// the same mutex `append` needs, and §3.4 says `SQLITE_BUSY` on this file is routine. Five rules
    /// and ten terminals is 25 statements a second of pure polling. The cache answers the "nothing
    /// changed" case with no lock at all; every other case still goes to the row.
    target_cache: DashMap<(String, String), (Option<String>, Option<String>, i64)>,
    emit: Mutex<EmitState>,
    /// Rows this build could not decode, drained by the caller that logs them.
    ///
    /// A `Mutex<Vec<_>>` rather than a return-value change: `list_rules` has several
    /// callers and threading a second value through all of them to serve one of them
    /// is churn for no gain. Drained rather than read, so a reload logs a bad row
    /// once and not on every subsequent load.
    skipped_rows: std::sync::Mutex<Vec<(String, String)>>,
}

impl Default for AutomationStore {
    fn default() -> Self {
        Self::new()
    }
}

impl AutomationStore {
    /// A disabled store. `init` upgrades it in place, exactly as `CanvasStore::new` does.
    pub fn new() -> Self {
        Self {
            conn: Mutex::new(None),
            log_counts: DashMap::new(),
            last_verbose: DashMap::new(),
            verbose_cache: DashMap::new(),
            target_cache: DashMap::new(),
            emit: Mutex::new(EmitState::default()),
            skipped_rows: std::sync::Mutex::new(Vec::new()),
        }
    }

    pub fn init(&self, path: &Path) {
        let mut guard = self.conn.lock().unwrap();
        if guard.is_some() {
            log::warn!("[AUTOMATION] init called more than once — ignoring");
            return;
        }
        match Connection::open(path).and_then(|c| {
            // Three connections now write this one file, and the 30 s scrollback flush holds the write
            // lock while writing multi-MB blobs. SQLite's default busy handler is NONE, so without this
            // an append landing in that window fails instantly with SQLITE_BUSY — an invisible dropped
            // log line at exactly the interesting moment. Do NOT touch journal_mode/WAL. Plan §3.4.
            c.busy_timeout(std::time::Duration::from_secs(5))?;
            Self::schema(&c)?;
            Ok(c)
        }) {
            Ok(conn) => {
                *guard = Some(conn);
                log::info!("[AUTOMATION] store initialized at {}", path.display());
            }
            Err(e) => log::warn!("[AUTOMATION] store disabled (open failed): {}", e),
        }
        drop(guard);
        // §3.3's startup sweep. The GATE does not need it — it is a comparison and a past deadline
        // already fails — but the column is user-visible, and without this the editor renders
        // "verbose until 10:17" for a deadline three days old.
        if let Err(e) = self.sweep_expired_verbose(chrono::Utc::now().timestamp_millis()) {
            log::warn!("[AUTOMATION] verbose sweep failed: {}", e);
        }
    }

    /// NULL every `verbose_until` that is already in the past. Takes `now` so it is testable; `init`
    /// supplies the wall clock, which is the right clock here for the same reason §3.3 gives for the
    /// column itself — the deadline is user-visible in wall-clock terms and must survive a restart.
    pub fn sweep_expired_verbose(&self, now: i64) -> Result<usize, AutomationStoreError> {
        let swept = {
            let guard = self.conn.lock().unwrap();
            let conn = guard.as_ref().ok_or(AutomationStoreError::Disabled)?;
            conn.execute(
                "UPDATE automation_rules SET verbose_until = NULL WHERE verbose_until <= ?1",
                [now],
            )?
        };
        self.verbose_cache.clear();
        Ok(swept)
    }

    #[cfg(test)]
    pub fn new_in_memory() -> Self {
        let conn = Connection::open_in_memory().expect("in-memory sqlite");
        Self::schema(&conn).expect("schema");
        let store = Self::new();
        *store.conn.lock().unwrap() = Some(conn);
        store
    }

    fn schema(conn: &Connection) -> rusqlite::Result<()> {
        conn.execute(
            "CREATE TABLE IF NOT EXISTS automation_rules (
                id              TEXT PRIMARY KEY,
                name            TEXT NOT NULL,
                enabled         INTEGER NOT NULL,
                runs_once       INTEGER NOT NULL,
                target_mode     TEXT NOT NULL,
                criterion       TEXT NOT NULL,
                criterion_value TEXT NOT NULL,
                follow_new      INTEGER NOT NULL,
                completed_at    INTEGER,
                verbose_until   INTEGER,
                sort_order      INTEGER NOT NULL,
                schema_version  INTEGER NOT NULL,
                graph           TEXT NOT NULL,
                created_at      INTEGER NOT NULL,
                updated_at      INTEGER NOT NULL
            )",
            [],
        )?;
        // Normalised rather than folded into the rule blob, because the BACKEND refreshes `label` and
        // `folder` on a completely different cadence from user edits. In the blob every label refresh
        // becomes an unlocked read-modify-write of the whole rule, and a touch landing between a
        // window's load and its save either clobbers the user or is clobbered by them. Plan §3.1.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS automation_targets (
                rule_id      TEXT NOT NULL,
                terminal_id  TEXT NOT NULL,
                source       TEXT NOT NULL,
                label        TEXT,
                folder       TEXT,
                label_at     INTEGER,
                last_seen_at INTEGER,
                added_at     INTEGER NOT NULL,
                PRIMARY KEY (rule_id, terminal_id)
            )",
            [],
        )?;
        // Ordered by `id`, never by `at`: two entries can share a millisecond (verbose mode writes
        // several terminals per tick) and the wall clock can move backwards after an NTP correction or
        // a resume, which this app already handles as an event. AUTOINCREMENT rather than a bare
        // rowid, because deleting a rule's rows can free the max rowid and reuse would place a NEW
        // entry before old ones. Plan §3.1.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS automation_log (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                rule_id       TEXT NOT NULL,
                terminal_id   TEXT,
                terminal_name TEXT,
                kind          TEXT NOT NULL,
                detail        TEXT NOT NULL,
                at            INTEGER NOT NULL
            )",
            [],
        )?;
        // Both halves of the watermark DELETE are index range scans over one rule's partition.
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_automation_log_rule ON automation_log(rule_id, id)",
            [],
        )?;
        // Additive migrations, and this is where every future one goes. `CREATE TABLE IF NOT EXISTS`
        // does NOT add a column to a table it did not create, so a `history.db` written by an earlier
        // build of this branch keeps its old `automation_targets` and every SELECT naming `folder`
        // fails against it. Plan §3.4.
        Self::ensure_column(conn, "automation_targets", "folder", "TEXT")?;
        Ok(())
    }

    /// Additive-only migration: add `column` to `table` if it is not already there.
    ///
    /// This crate has **zero** migration machinery. Without this helper the first post-ship column
    /// addition makes every SELECT naming it fail on every existing install, and the whole feature
    /// reads as broken. Plan §3.4.
    pub(crate) fn ensure_column(
        conn: &Connection,
        table: &str,
        column: &str,
        decl: &str,
    ) -> rusqlite::Result<()> {
        // `table` and `column` are module constants, never user input — and PRAGMA cannot take a bound
        // parameter for an identifier.
        let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
        let existing: HashSet<String> = stmt
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<rusqlite::Result<_>>()?;
        if !existing.contains(column) {
            conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"), [])?;
        }
        Ok(())
    }

    // ------------------------------------------------------------------------------------------
    // Rules
    // ------------------------------------------------------------------------------------------

    /// Take the rows skipped since the last call. See `skipped_rows`.
    pub fn take_skipped_rows(&self) -> Vec<(String, String)> {
        std::mem::take(&mut *self.skipped_rows.lock().unwrap_or_else(|e| e.into_inner()))
    }

    /// Every rule, `ORDER BY sort_order, id`, each with its pinned `target_ids` filled in.
    ///
    /// Two queries and a group-by rather than one per rule: a rule list is drawn on every Settings
    /// open, and N+1 over a joined table is how that gets slow without anyone noticing.
    pub fn list_rules(&self) -> Result<Vec<AutomationRule>, AutomationStoreError> {
        let guard = self.conn.lock().unwrap();
        let conn = guard.as_ref().ok_or(AutomationStoreError::Disabled)?;

        // Only `pinned` rows: `target_ids` is the user's pick set. A `TargetMode::Rule` rule's matched
        // rows live in the same table (they carry the label snapshot) but are not the user's choice,
        // and echoing them back into `target_ids` would silently convert a live query into a frozen
        // list on the next save.
        let mut targets: HashMap<String, Vec<String>> = HashMap::new();
        {
            let mut stmt = conn.prepare(
                "SELECT rule_id, terminal_id FROM automation_targets
                  WHERE source = 'pinned' ORDER BY added_at, terminal_id",
            )?;
            let rows =
                stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            for row in rows {
                let (rule_id, terminal_id) = row?;
                targets.entry(rule_id).or_default().push(terminal_id);
            }
        }

        let mut stmt = conn.prepare(&format!(
            "SELECT {RULE_COLUMNS} FROM automation_rules ORDER BY sort_order, id"
        ))?;
        let raws = stmt.query_map([], read_rule_row)?;
        let mut out = Vec::new();
        for raw in raws {
            let raw = raw?; // a SQLite error is still fatal — the DB is gone
            let id = raw.id.clone();
            match hydrate_rule(raw) {
                Ok(mut rule) => {
                    rule.target_ids = targets.remove(&rule.id).unwrap_or_default();
                    out.push(rule);
                }
                // §3.3: a row this build cannot decode is ONE rule that does not run, never
                // the whole library. `reload` already promises exactly this for an
                // over-schema-version rule and says so in the user's words; a decode failure
                // is the same event one layer down, so it gets the same sentence.
                Err(e) => {
                    self.skipped_rows
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .push((id, format!("this rule needs a newer version of TermFlow ({e})")));
                }
            }
        }
        Ok(out)
    }

    /// A save from a **renderer**: the store owns the columns the renderer must not author.
    ///
    /// Four fields on `AutomationRule` are facts about the ROW rather than about the rule the user
    /// drew — `id`, `sort_order`, `created_at` and `updated_at` — and an editor has no way to know
    /// any of them for a rule it is creating. `blankDraft()` therefore sends `""` and three zeros,
    /// and every one of them would be written through verbatim by `save_rule`:
    ///
    ///  - **`sort_order`** — `list_rules` is `ORDER BY sort_order, id`, so `0` files a rule above
    ///    everything, tie-broken by a uuid. The command used to mint this only on the INSERT path,
    ///    which fixed the first save and left the second: the editor stays open, its draft still
    ///    holds `sortOrder: 0`, and one more keystroke plus Save sent the rule back to the top.
    ///  - **`created_at`** — `0` stamps every automation created through the editor 1970-01-01.
    ///  - **`updated_at`** — the one that changes behaviour. `reload` drops a rule's arm keys only
    ///    when this field MOVES (Q11: *"treat a save like a disable/enable — editing the pattern or
    ///    threshold makes the old crossing state meaningless"*), so a save that leaves it alone
    ///    leaves a fired rule latched at a threshold it no longer has.
    ///
    /// **One transaction, not a read followed by a write.** `get_rule(id)?; save_rule(new)?` is two
    /// locked calls with a race between them — the same race `save_rule`'s own doc refuses for the
    /// `previous` value it returns — so the lookup that decides these columns happens inside the
    /// transaction that writes them.
    ///
    /// `sort_order` is **not unique and not required to be**: two windows inserting at the same
    /// moment can land on the same slot, the ordering stays total because `id` breaks the tie, and
    /// `duplicate_automation` renumbers when it needs an exact position.
    pub fn save_rule_as_of(
        &self,
        rule: &AutomationRule,
        at: i64,
    ) -> Result<Option<i64>, AutomationStoreError> {
        // The same gate `save_rule` applies, applied before any row is read: a refused save must
        // not have looked at the database at all.
        if rule.enabled {
            Self::refuse_if_it_would_run_wrong(rule)?;
        }

        let mut guard = self.conn.lock().unwrap();
        let conn = guard.as_mut().ok_or(AutomationStoreError::Disabled)?;
        let tx = conn.transaction()?;

        let existing: Option<(i64, i64)> = optional_row(tx.query_row(
            "SELECT sort_order, created_at FROM automation_rules WHERE id = ?1",
            [&rule.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ))?;

        let mut owned = rule.clone();
        match existing {
            // A re-save KEEPS its slot and its birthday. This is the half that was missing.
            Some((sort_order, created_at)) => {
                owned.sort_order = sort_order;
                owned.created_at = created_at;
            }
            None => {
                owned.sort_order = tx.query_row(
                    "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM automation_rules",
                    [],
                    |r| r.get(0),
                )?;
                owned.created_at = at;
            }
        }
        owned.updated_at = at;

        let previous = Self::write_rule(&tx, &owned)?;
        tx.commit()?;
        drop(guard);
        // Write through rather than invalidate, for the reason `save_rule` gives.
        self.verbose_cache.insert(owned.id.clone(), owned.verbose_until);
        Ok(previous)
    }

    /// Append one terminal to a rule's pick set — **only if that rule is still there.**
    ///
    /// The terminal context menu's *Add to an existing automation* row cannot be built out of
    /// `save_automation`, and the attempt is what this method exists to replace. That row re-resolves
    /// the rule id against the renderer's cached rule list at click time and sends the whole rule
    /// object back through the save path — and `save_rule_as_of` is an UNCONDITIONAL upsert whose
    /// `None` arm INSERTs. So a rule another window had already deleted came back:
    ///
    ///  1. window B deletes rule R, and its transaction commits;
    ///  2. window A receives `automation:changed` and starts a refresh it does not await;
    ///  3. the user clicks the still-open *Add to R* row;
    ///  4. window A finds R in its stale cache and saves it;
    ///  5. no row matches the id, so the upsert INSERTs — R is back, as the cache remembered it.
    ///
    /// Re-reading that cache immediately before the click narrows the window; it cannot close it,
    /// because the delete may commit between the re-read and the write. Only a store-side conditional
    /// closes it, and the condition has to be evaluated inside the transaction that writes — which is
    /// exactly what `read_rule_on` exists for.
    ///
    /// `Ok(false)` means the rule is gone and **nothing was written**: no rule row, and no target row
    /// either. It is not an `Err`, because a rule deleted in another window while this menu was open
    /// is an ordinary race rather than a failure; the caller re-fetches and says so.
    ///
    /// `Ok(true)` also covers an id the rule ALREADY watches. That is a success from the caller's side
    /// — R watches this terminal, which is what the click asked for — and reporting it as `Ok(false)`
    /// would tell the user their automation had been deleted. That branch writes nothing at all,
    /// deliberately: `reload` drops a rule's arm keys whenever `updated_at` MOVES (Q11), so
    /// re-stamping the row for a click that changed nothing would silently re-arm a fired rule.
    ///
    /// **`sort_order` and `created_at` need no rescue here.** `save_rule_as_of` rescues them because
    /// its rule arrives from an editor that cannot know either; this one came back out of the very row
    /// it is about to overwrite, so it already carries that row's values. `updated_at` is the one
    /// column this write authors.
    ///
    /// **The write goes through `write_rule`, never hand-rolled target SQL.** That function owns the
    /// `automation_targets` rows, and it is what turns an existing `matched` row for this terminal into
    /// a `pinned` one **keeping its label and folder snapshot** — the snapshot the picker's "not open"
    /// row is drawn from.
    pub fn add_target_to_rule(
        &self,
        rule_id: &str,
        terminal_id: &str,
        at: i64,
    ) -> Result<bool, AutomationStoreError> {
        let mut guard = self.conn.lock().unwrap();
        let conn = guard.as_mut().ok_or(AutomationStoreError::Disabled)?;
        let tx = conn.transaction()?;

        // The existence check and the write, on ONE transaction. Every early return below drops `tx`
        // uncommitted, which rolls back — so "the rule is gone" and "the gate refused" both leave the
        // file exactly as they found it.
        let Some(mut rule) = Self::read_rule_on(&tx, rule_id)? else {
            return Ok(false);
        };
        if rule.target_ids.iter().any(|id| id.as_str() == terminal_id) {
            return Ok(true);
        }

        rule.target_ids.push(terminal_id.to_string());
        rule.updated_at = at;

        // The same gate the save path applies, on the row this is about to WRITE rather than the row
        // it read. Judging the pre-append value would refuse the one edit that repairs a pinned rule
        // stored enabled with an empty pick set: `targets.empty` is the only problem an append can
        // change, and it can only CLEAR it.
        //
        // Which makes this gate very nearly unreachable from here — and it is still not skipped. What
        // it catches is a row that was ALREADY enabled and already invalid for some other reason (an
        // empty message, a sub-minimum timer interval), written by a build older than §7.8's save gate
        // or arriving through a migration. Refusing and naming the problem is the honest answer there;
        // silently re-stamping a rule the editor itself could not save is not. The PATTERN is not one
        // of those reasons: this is `refuse_if_it_would_run_wrong`, which leaves the pattern to
        // `reload` for §2.7's reason.
        if rule.enabled {
            Self::refuse_if_it_would_run_wrong(&rule)?;
        }

        Self::write_rule(&tx, &rule)?;
        tx.commit()?;
        // No `verbose_cache` write-through: `verbose_until` is written back exactly as it was read, so
        // the cached value is still the row's value. Only a path that CHANGES it owes the cache a write.
        Ok(true)
    }

    /// Drop terminals from a rule's pick set — **only if that rule is still there.**
    ///
    /// `add_target_to_rule`'s MIRROR GESTURE, and the reason it exists is that closing that class at
    /// one site did not close it. The Settings list's *Forget it* button read its rule out of
    /// `useAutomations()`'s cached list, filtered `targetIds` in the renderer, and sent the whole
    /// object back through `save_automation` — which is `save_rule_as_of`, an unconditional upsert
    /// whose `None` arm INSERTs. Both of that path's failures were reachable from a button drawn on a
    /// list that refreshes asynchronously:
    ///
    ///  *Resurrection* — window B deletes rule R and commits; window A has not finished refetching;
    ///  the user clicks *Forget it* on R's row; no row matches the id, so the upsert INSERTs, and R is
    ///  back exactly as A's stale cache remembered it, minus the one terminal.
    ///
    ///  *Clobber* — window B edits R's message; window A's captured copy of R goes back over that
    ///  edit whole, silently reverting it, for a gesture that meant to change one column.
    ///
    /// Only IDS cross the wire now, and the read that decides the write happens on that write's own
    /// transaction. `Ok(false)` means the rule is gone and **nothing was written** — an ordinary race
    /// in a multi-window app rather than a failure, so the caller says so and refetches.
    ///
    /// **`Ok(true)` also covers ids this rule does not watch, and that arm writes nothing at all.**
    /// The button's list is the runtime's `missing` set intersected with `target_ids`, so a renderer
    /// one commit behind can name an id another window has already forgotten. Reporting that as
    /// `Ok(false)` would tell the user their automation had been deleted; re-stamping the row for it
    /// would re-arm the rule for a click that changed nothing.
    ///
    /// **`updated_at` moves whenever a pin is actually dropped.** `add_target_to_rule` gives the
    /// reason in the other direction and this is the same reason: the set of terminals a rule watches
    /// is part of what the rule IS, `reload` keys arm-state invalidation on `updated_at` moving
    /// (Q11), and the two halves of one gesture must not disagree about whether changing the pick set
    /// counts as an edit. It is also exactly what the `save_automation` path being replaced did, so
    /// the race fix carries no silent behaviour change beside it. The cost is real and accepted: the
    /// rule's OTHER pairs re-arm too, and settled decision 7 makes an already-true condition count as
    /// fired, so they go quiet until their next genuine crossing.
    ///
    /// **The save gate stays, and unlike the append's it can genuinely refuse here.** Emptying a
    /// PINNED rule's pick set is `targets.empty` — the one blocking problem a removal can CREATE
    /// rather than clear. Refusing is what `save_rule_as_of` already did for this button; the
    /// alternative is writing an enabled rule with nothing to watch, which the editor itself could not
    /// have saved.
    pub fn remove_target_from_rule(
        &self,
        rule_id: &str,
        terminal_ids: &[String],
        at: i64,
    ) -> Result<bool, AutomationStoreError> {
        let mut guard = self.conn.lock().unwrap();
        let conn = guard.as_mut().ok_or(AutomationStoreError::Disabled)?;
        let tx = conn.transaction()?;

        // The existence check and the write, on ONE transaction. Every early return below drops `tx`
        // uncommitted, which rolls back — so "the rule is gone", "it never watched that id" and "the
        // gate refused" all leave the file exactly as they found it.
        let Some(mut rule) = Self::read_rule_on(&tx, rule_id)? else {
            return Ok(false);
        };
        let kept: Vec<String> = rule
            .target_ids
            .iter()
            .filter(|id| !terminal_ids.iter().any(|gone| gone == *id))
            .cloned()
            .collect();
        if kept.len() == rule.target_ids.len() {
            return Ok(true);
        }

        rule.target_ids = kept;
        rule.updated_at = at;

        if rule.enabled {
            Self::refuse_if_it_would_run_wrong(&rule)?;
        }

        // Through `write_rule`, never hand-rolled target SQL: that function owns `automation_targets`,
        // and its `NOT IN (…)` delete is what actually removes the dropped rows. The empty-set arm it
        // documents is reachable from here — a DISABLED pinned rule may legally end up watching
        // nothing — and it is the arm that had the `'' NOT IN ('')` bug, so this path wants the fixed
        // one rather than a second copy.
        Self::write_rule(&tx, &rule)?;
        tx.commit()?;
        // No `verbose_cache` write-through, for the reason the append gives: `verbose_until` is
        // written back exactly as it was read, so the cached value is still the row's value.
        Ok(true)
    }

    /// Move a rule's *Log every check* deadline — **only if that rule is still there.**
    ///
    /// The third site of the class `add_target_to_rule` closed, and the least obvious of the three:
    /// the activity log's verbose toggle also read its rule out of the panel's cached list, set
    /// `verboseUntil` on that captured object, and sent the whole thing back through
    /// `save_automation`. Same unconditional upsert, so the same resurrection of a rule deleted in
    /// another window and the same clobber of every other column a concurrent edit had changed —
    /// from a switch whose entire job is to change one nullable integer. `Ok(false)` = the rule is
    /// gone and nothing was written.
    ///
    /// **A single-column `UPDATE` rather than `write_rule`**, following `set_enabled_checked`: this
    /// changes one column and must not rewrite fifteen, and going through `write_rule` would also
    /// replace `automation_targets` for a gesture that has nothing to do with targets.
    ///
    /// **No "the deadline is already that" early return**, unlike its two siblings, and for a reason
    /// that is theirs upside-down. Their no-op arm exists to stop a click that changed nothing from
    /// moving `updated_at` and re-arming the rule; this method never moves `updated_at` at all, so a
    /// redundant write and a skipped write are indistinguishable in the row, in the cache, and in the
    /// engine. A branch nothing can observe is a branch no test can pin — and an unpinnable guard is
    /// how the two hollow ones in `79c4b0b` got shipped — so the branch is not written.
    ///
    /// **It takes no `at`, because it stamps no `updated_at` — and that is a deliberate difference
    /// from its two siblings, not an omission.** `reload` drops a rule's arm keys whenever
    /// `updated_at` moves (Q11), and that invalidation exists because a rule whose definition changed
    /// may now evaluate differently. `verbose_until` cannot change any evaluation: no file in this
    /// crate outside this one reads the column in production code. The engine's `LiveRule` carries it
    /// and never consults it, because the gate is `check_passes_gate` — here, off the store's own
    /// cache. So stamping would buy nothing and would cost the one thing this switch is for: *Log
    /// every check* is what a user turns on to find out why a rule is not firing, and re-arming every
    /// pair of the rule under observation makes the receipt they are about to read a receipt of a
    /// different arm state. The observation must not disturb the observed. (The `save_automation`
    /// path this replaces DID stamp, because `save_rule_as_of` stamps every save — a side effect of
    /// the wrong command being used, not a decision anyone made about verbose.)
    ///
    /// **The `verbose_cache` write-through IS load-bearing here, and is not an optimisation.**
    /// `check_passes_gate` reads that cache and falls back to a `SELECT` only on a MISS, so a stale
    /// entry is never re-read from the row: any rule whose gate has been consulted once already has
    /// `None` cached, and without this line the switch would go on dropping every `Check` entry —
    /// verbose visibly on, the log staying empty — until a delete, a save or the startup sweep
    /// happened to clear it. `save_rule` and `save_rule_as_of` write through for the same reason;
    /// `add_target_to_rule` documents why it need not, and the difference between them is only which
    /// one CHANGES the column.
    pub fn set_verbose_until(
        &self,
        rule_id: &str,
        verbose_until: Option<i64>,
    ) -> Result<bool, AutomationStoreError> {
        let mut guard = self.conn.lock().unwrap();
        let conn = guard.as_mut().ok_or(AutomationStoreError::Disabled)?;
        let tx = conn.transaction()?;

        // Read and write on ONE transaction, as the two methods above do: `Ok(false)` is only a
        // promise that nothing was written if the existence check cannot be overtaken by a delete
        // between itself and the `UPDATE`.
        //
        // `read_rule_on` rather than a bare `SELECT 1`, which is all this branch needs. It costs one
        // extra indexed query for the rule's pinned ids, on a path that runs when a user flicks a
        // switch; what it buys is that this method reads a rule the same way every other conditional
        // writer in this file does, which is the property `every_read_that_decides_a_write_…` checks
        // in source. A hand-rolled existence query here would pass no test and fail that one.
        if Self::read_rule_on(&tx, rule_id)?.is_none() {
            return Ok(false);
        }

        tx.execute(
            "UPDATE automation_rules SET verbose_until = ?1 WHERE id = ?2",
            rusqlite::params![verbose_until, rule_id],
        )?;
        tx.commit()?;
        drop(guard);
        self.verbose_cache.insert(rule_id.to_string(), verbose_until);
        Ok(true)
    }

    pub fn get_rule(&self, id: &str) -> Result<Option<AutomationRule>, AutomationStoreError> {
        let guard = self.conn.lock().unwrap();
        let conn = guard.as_ref().ok_or(AutomationStoreError::Disabled)?;
        Self::read_rule_on(conn, id)
    }

    /// `get_rule`'s body with the locking taken out, so a caller that must **decide** something from
    /// a rule and then write that decision can do both inside ONE transaction.
    ///
    /// `Transaction` derefs to `Connection`, so one reader serves both the single-shot locked call
    /// above and the transactional call sites. It exists because `save_rule_as_of` fixed the
    /// read-then-write race for its own `previous` value and documented it there - and nothing swept
    /// the rest of the file, where `set_enabled_checked` and `duplicate_automation` had the identical
    /// shape. A fix applied at one site of a class is not a fix.
    fn read_rule_on(
        conn: &rusqlite::Connection,
        id: &str,
    ) -> Result<Option<AutomationRule>, AutomationStoreError> {
        let raw = optional_row(conn.query_row(
            &format!("SELECT {RULE_COLUMNS} FROM automation_rules WHERE id = ?1"),
            [id],
            read_rule_row,
        ))?;
        match raw {
            None => Ok(None),
            Some(raw) => {
                // Deliberately NOT the skip path §3.3 gives `list_rules`: a caller naming one rule
                // wants that rule, and `Ok(None)` would read as "deleted" for a row that is merely
                // undecodable by this build.
                let mut rule = hydrate_rule(raw)?;
                // The SAME predicate and order `list_rules` uses, in SQL, rather than reading every
                // source and filtering in Rust. The two shapes differ deliberately — `list_rules`
                // does one bulk query to avoid N+1 — but the definition of "this rule's pinned
                // targets" must not, or `two-implementations-one-fix` says how it ends.
                let mut stmt = conn.prepare(PINNED_TARGET_IDS_SQL)?;
                let rows = stmt.query_map([id], |r| r.get::<_, String>(0))?;
                let mut ids = Vec::new();
                for row in rows {
                    ids.push(row?);
                }
                rule.target_ids = ids;
                Ok(Some(rule))
            }
        }
    }

    /// Upsert one rule and replace its pinned target set, in one transaction.
    ///
    /// **Returns the previous `updated_at`, read inside that same transaction.** `let old =
    /// get_rule(id)?; save_rule(new)?;` is two locked calls with a race between them, and the `saved`
    /// log line — *"saved from window `main`, replacing the version saved at 20:14:07"* — would then
    /// name the wrong loser. Last-save-wins is the policy (§3.5); the log entry is the requirement, so
    /// it has to be true. `Ok(None)` means this rule is new.
    ///
    /// **A save that arrives with `enabled = true` is an enable, and §7.8 gates it** — otherwise a
    /// draft saved with its toggle already on goes live unjudged, which is R10's exact failure: an
    /// empty message makes `deliver` press a bare Enter into whatever is running.
    ///
    /// **The pattern is the one blocking problem this gate lets through**, and deliberately. §2.7
    /// gives `reload` its own refusal for an uncompilable pattern, reported once per load; a store
    /// that refused to write one would make that path dead code here while it stays genuinely
    /// reachable in production, because a rule saved by an older build, arriving through a migration,
    /// or written against a different regex version can still carry a pattern this build cannot
    /// compile. Nothing is exposed by the exception: a bad pattern is still refused by the ENABLE
    /// path (`set_enabled_checked`), and a rule saved enabled with one is skipped at the next
    /// `reload` with a log row rather than run.
    pub fn save_rule(&self, rule: &AutomationRule) -> Result<Option<i64>, AutomationStoreError> {
        if rule.enabled {
            Self::refuse_if_it_would_run_wrong(rule)?;
        }

        let previous = self.write_rule_committed(rule)?;
        // Write through rather than invalidate: the new value is right here, and a rule saved with
        // verbose just switched on must not wait for a cache miss to start logging.
        self.verbose_cache.insert(rule.id.clone(), rule.verbose_until);
        Ok(previous)
    }

    /// `write_rule`, opening and committing its own transaction. The half of `save_rule` that has
    /// nothing to do with the enable gate, so a caller that needs the write WITHOUT the gate (only
    /// `save_rule_bypassing_the_enable_gate_for_tests` does) has something to call that is not a
    /// second copy of the lock/transaction/commit dance.
    fn write_rule_committed(&self, rule: &AutomationRule) -> Result<Option<i64>, AutomationStoreError> {
        let mut guard = self.conn.lock().unwrap();
        let conn = guard.as_mut().ok_or(AutomationStoreError::Disabled)?;
        let tx = conn.transaction()?;
        let previous = Self::write_rule(&tx, rule)?;
        tx.commit()?;
        Ok(previous)
    }

    /// `save_rule`, without §7.8's enable gate.
    ///
    /// **Test-only, and deliberately so.** Every path a running app can reach — `save_rule` here,
    /// and `set_enabled_checked`'s own re-validation — now refuses to CREATE the row this writes.
    /// But `save_rule`'s own doc above already establishes that such a row is not hypothetical: a
    /// rule enabled by a build OLDER than a validation rule the current build has can still be
    /// sitting in `automation_rules`, is still loaded by `reload` (whose exemption is scoped to
    /// `parse.*`, on purpose — the ENABLE path is what re-checks the rest), and still reaches the
    /// engine's evaluate-and-send loop. This is the one way left to construct that row in a test,
    /// mirroring `write_raw_graph`'s reason for existing: an old build could still write it, so a
    /// test still has to be able to.
    #[cfg(test)]
    pub(crate) fn save_rule_bypassing_the_enable_gate_for_tests(
        &self,
        rule: &AutomationRule,
    ) -> Result<Option<i64>, AutomationStoreError> {
        let previous = self.write_rule_committed(rule)?;
        self.verbose_cache.insert(rule.id.clone(), rule.verbose_until);
        Ok(previous)
    }

    /// The upsert and the target-set replacement, on a caller-supplied transaction.
    ///
    /// Split out so `duplicate_automation` can put its reordering and this write in **one**
    /// transaction. It used to reorder in its own autocommit statement and then call `save_rule`; a
    /// failure in between left the order permanently mutated, with a gap where the copy should have
    /// been and nothing to notice it.
    fn write_rule(
        tx: &rusqlite::Transaction<'_>,
        rule: &AutomationRule,
    ) -> Result<Option<i64>, AutomationStoreError> {
        let graph = serde_json::to_string(&rule.graph)
            .map_err(|e| AutomationStoreError::Invalid(format!("graph is not serialisable: {e}")))?;
        let target_mode = enum_to_db(&rule.target_mode)?;
        let criterion = enum_to_db(&rule.criterion)?;

        let previous: Option<i64> = optional_row(tx.query_row(
            "SELECT updated_at FROM automation_rules WHERE id = ?1",
            [&rule.id],
            |r| r.get(0),
        ))?;

        tx.execute(
            "INSERT INTO automation_rules (
                 id, name, enabled, runs_once, target_mode, criterion, criterion_value, follow_new,
                 completed_at, verbose_until, sort_order, schema_version, graph, created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
             ON CONFLICT(id) DO UPDATE SET
                 name            = excluded.name,
                 enabled         = excluded.enabled,
                 runs_once       = excluded.runs_once,
                 target_mode     = excluded.target_mode,
                 criterion       = excluded.criterion,
                 criterion_value = excluded.criterion_value,
                 follow_new      = excluded.follow_new,
                 completed_at    = excluded.completed_at,
                 verbose_until   = excluded.verbose_until,
                 sort_order      = excluded.sort_order,
                 schema_version  = excluded.schema_version,
                 graph           = excluded.graph,
                 updated_at      = excluded.updated_at",
            rusqlite::params![
                rule.id,
                rule.name,
                rule.enabled,
                rule.runs_once,
                target_mode,
                criterion,
                rule.criterion_value,
                rule.follow_new,
                rule.completed_at,
                rule.verbose_until,
                rule.sort_order,
                rule.schema_version,
                graph,
                rule.created_at,
                rule.updated_at,
            ],
        )?;

        // REPLACE the pick set, never append to it. `INSERT OR IGNORE` + `UPDATE source` rather than
        // delete-all-then-insert: a re-save must KEEP an existing row's label/folder snapshot, which
        // the backend refreshes on its own cadence through `touch_target`. Deleting and reinserting
        // would throw away the label the picker's "not open" row draws — the one case it exists for.
        if rule.target_ids.is_empty() {
            // No `NOT IN (…)` clause at all. The previous spelling used the literal `''` to stand in
            // for an empty list, and `'' NOT IN ('')` is FALSE — so clearing a rule's targets spared
            // any row whose terminal id was itself the empty string, and the next `list_rules` read it
            // straight back into `target_ids`. An empty pick set means delete them all; say that.
            tx.execute(
                "DELETE FROM automation_targets WHERE rule_id = ?1 AND source = 'pinned'",
                [&rule.id],
            )?;
        } else {
            let placeholders = rule.target_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let mut params: Vec<&dyn rusqlite::ToSql> = vec![&rule.id];
            for id in &rule.target_ids {
                params.push(id);
            }
            tx.execute(
                &format!(
                    "DELETE FROM automation_targets
                      WHERE rule_id = ?1 AND source = 'pinned' AND terminal_id NOT IN ({placeholders})"
                ),
                params.as_slice(),
            )?;
        }
        for id in &rule.target_ids {
            tx.execute(
                "INSERT OR IGNORE INTO automation_targets
                     (rule_id, terminal_id, source, label, folder, label_at, last_seen_at, added_at)
                 VALUES (?1, ?2, 'pinned', NULL, NULL, NULL, NULL, ?3)",
                rusqlite::params![rule.id, id, rule.updated_at],
            )?;
            // A row that already existed as a criterion match becomes pinned once the user ticks it,
            // keeping its snapshot. Without this the id sits in `target_ids` with `source='matched'`,
            // and `list_rules` — which reads only pinned rows — drops it on the next load.
            tx.execute(
                "UPDATE automation_targets SET source = 'pinned'
                  WHERE rule_id = ?1 AND terminal_id = ?2",
                rusqlite::params![rule.id, id],
            )?;
        }
        Ok(previous)
    }

    /// Delete a rule and everything keyed to it, in one transaction. `Ok(false)` = already absent.
    pub fn delete_rule(&self, id: &str) -> Result<bool, AutomationStoreError> {
        let n = {
            let mut guard = self.conn.lock().unwrap();
            let conn = guard.as_mut().ok_or(AutomationStoreError::Disabled)?;
            let tx = conn.transaction()?;
            tx.execute("DELETE FROM automation_targets WHERE rule_id = ?1", [id])?;
            tx.execute("DELETE FROM automation_log WHERE rule_id = ?1", [id])?;
            let n = tx.execute("DELETE FROM automation_rules WHERE id = ?1", [id])?;
            tx.commit()?;
            n
        };
        self.log_counts.remove(id);
        self.last_verbose.retain(|(rule_id, _), _| rule_id != id);
        self.verbose_cache.remove(id);
        self.target_cache.retain(|(rule_id, _), _| rule_id != id);
        Ok(n > 0)
    }

    /// Flip a rule's `enabled` flag, **re-validating on the way in** (plan §7.8, R10).
    ///
    /// The boundary audit's finding was that the enable path had no gate at all: the editor validated
    /// its own toggle, the store validated nothing semantic, and the engine refused only an
    /// uncompilable pattern — so a rule with no terminals and an empty message went live straight from
    /// the list row, where the editor's validation never runs. The backend owns *"is this rule allowed
    /// to run"* and must not be talked into it by a stale renderer.
    ///
    /// Disabling is never refused. A rule the user wants stopped is stopped, whatever is wrong with
    /// it — refusing to turn off an invalid rule would trap it running.
    ///
    /// The Tauri command is a two-line wrapper over this, per §7.10: this is the thing worth testing,
    /// and it needs no `AppHandle`.
    pub fn set_enabled_checked(
        &self,
        rule_id: &str,
        enabled: bool,
    ) -> Result<(), AutomationStoreError> {
        let mut guard = self.conn.lock().unwrap();
        let conn = guard.as_mut().ok_or(AutomationStoreError::Disabled)?;
        let tx = conn.transaction()?;

        // **The row this validates is the row it flips.** `get_rule` takes and releases its own lock,
        // so a `get_rule` + `UPDATE` pair is two locked calls with a gap - and this gate is only worth
        // having if nothing can replace the rule inside that gap. A save may legally persist a
        // DISABLED rule with an empty message (the save gate's `refuse_if_it_would_run_wrong` runs
        // only `if rule.enabled`), so the losing interleaving is not exotic: window A saves that
        // draft while window B switches the rule on, B validates the pre-A row, A's write lands, and
        // B's `UPDATE` sets `enabled = 1` on it. `reload` never re-checks message content, so the
        // rule runs and `deliver` presses a bare Enter into the terminal - the exact R10 outcome this
        // gate exists to prevent.
        if enabled {
            let rule = Self::read_rule_on(&tx, rule_id)?
                .ok_or_else(|| AutomationStoreError::Invalid(format!("no rule {}", rule_id)))?;
            Self::refuse_if_invalid(&rule)?;
        }
        tx.execute(
            "UPDATE automation_rules SET enabled = ?1 WHERE id = ?2",
            rusqlite::params![enabled as i64, rule_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Stamp a runs-once rule as completed. `Ok(false)` = no such rule.
    ///
    /// This row is the SECOND line of defence, not the mechanism: the engine also drops the rule from
    /// its live set in the same critical section. A completed rule that stayed in memory kept logging
    /// `held`, and the next crossing sent a **second** message in the same session from a rule the UI
    /// already showed as Completed. Plan §7.8.
    pub fn mark_completed(&self, rule_id: &str, at: i64) -> Result<bool, AutomationStoreError> {
        let guard = self.conn.lock().unwrap();
        let conn = guard.as_ref().ok_or(AutomationStoreError::Disabled)?;
        Ok(conn.execute(
            "UPDATE automation_rules SET completed_at = ?1 WHERE id = ?2",
            rusqlite::params![at, rule_id],
        )? > 0)
    }

    /// The ENABLE gate (§7.8): every blocking problem, because after this the rule RUNS.
    ///
    /// §7.8's second call site — *"any save with `enabled = true`"* — is `refuse_if_it_would_run_wrong`
    /// below, wired since round 1's H-1. *(This paragraph used to say that gate was deferred, and it
    /// stood for three commits after the gate was written, one of which was about this very gate.)*
    fn refuse_if_invalid(rule: &AutomationRule) -> Result<(), AutomationStoreError> {
        Self::refuse(crate::automation_validation::problems(rule))
    }

    /// The SAVE gate (§7.8): everything the engine does not independently refuse.
    ///
    /// **The exemption is derived, not named.** It used to be `p.field != "parse"` — a whole FIELD,
    /// on the reasoning that the engine re-checks the pattern. The engine re-checked whether the
    /// pattern COMPILED, and `parse` also carries an empty pattern, which compiles into an expression
    /// matching every position of every string: a presence rule saved enabled with `find = ""` went
    /// live and typed into the first terminal that printed anything. `pattern_refused_at_load` is now
    /// the single answer to *"will the engine refuse this?"*, asked here and by `reload`, so the two
    /// cannot drift apart again.
    fn refuse_if_it_would_run_wrong(rule: &AutomationRule) -> Result<(), AutomationStoreError> {
        let engine_will_refuse =
            crate::automation_validation::pattern_refused_at_load(&rule.graph.parse.find).is_some();
        Self::refuse(
            crate::automation_validation::problems(rule)
                .into_iter()
                .filter(|p| !(engine_will_refuse && p.field == "parse"))
                .collect(),
        )
    }

    fn refuse(
        problems: Vec<crate::automation_validation::Problem>,
    ) -> Result<(), AutomationStoreError> {
        let blocking: Vec<String> = problems
            .into_iter()
            .filter(crate::automation_validation::Problem::blocks)
            .map(|p| p.message)
            .collect();
        if blocking.is_empty() {
            return Ok(());
        }
        Err(AutomationStoreError::Invalid(blocking.join(" ")))
    }

    /// Un-complete a runs-once rule, so it can run again. `Ok(false)` = no such rule.
    ///
    /// The engine purge is the caller's other half and they are one command (§7.8): a rule whose row
    /// says it may run again while its arm keys still say `Fired` re-arms on its next false read and
    /// fires with no crossing.
    pub fn clear_completed(&self, rule_id: &str) -> Result<bool, AutomationStoreError> {
        let guard = self.conn.lock().unwrap();
        let conn = guard.as_ref().ok_or(AutomationStoreError::Disabled)?;
        Ok(conn.execute(
            "UPDATE automation_rules SET completed_at = NULL WHERE id = ?1",
            [rule_id],
        )? > 0)
    }

    /// Copy a rule to a fresh id, directly beneath the original. R12 — Tam's first request.
    ///
    /// Deliberately not a bare clone-with-a-new-id: an enabled duplicate starts firing the moment it
    /// is created, and a copied `completed_at` makes it Completed before it has ever run.
    pub fn duplicate_automation(
        &self,
        id: &str,
        at: i64,
    ) -> Result<AutomationRule, AutomationStoreError> {
        let mut guard = self.conn.lock().unwrap();
        let conn = guard.as_mut().ok_or(AutomationStoreError::Disabled)?;
        let tx = conn.transaction()?;

        // **Read inside the transaction that writes the copy**, for `save_rule_as_of`'s reason. The
        // editor's Duplicate button is gated only on the draft HAVING an id - deliberately not on the
        // in-flight save that `disabled={saving}` guards for the Save button - so Save followed by
        // Duplicate before the round trip commits clones the version the save is replacing.
        let original = Self::read_rule_on(&tx, id)?
            .ok_or_else(|| AutomationStoreError::Invalid(format!("no such rule {id}")))?;
        let mut copy = original.clone();
        copy.id = format!("au-{}", uuid::Uuid::new_v4());
        copy.name = format!("{} (copy)", original.name);
        copy.enabled = false;
        copy.completed_at = None;
        copy.verbose_until = None;
        // A copy was created now, not when its original was. `at` is a parameter rather than a call to
        // the clock, so the store keeps taking time from its caller the way `mark_completed` and
        // `touch_target` already do — and so this is testable.
        copy.created_at = at;
        copy.updated_at = at;

        // Renumber the whole list densely rather than shifting the tail by one.
        //
        // A `sort_order + 1 WHERE sort_order > original` shift assumes sort orders are unique, and
        // nothing enforces that. With a second rule already sharing the original's slot, the shift
        // moves that rule into the copy's intended slot, the tie is broken by id, and the copy can
        // still land beneath a rule that is not its original — which is the whole requirement. There
        // is also no integer between `n` and `n+1` to escape to. Rewriting the order is deterministic,
        // self-healing for duplicate slots already stored, and this table holds tens of rows and is
        // renumbered only on an explicit duplicate.
        let existing: Vec<String> = {
            let mut stmt = tx.prepare("SELECT id FROM automation_rules ORDER BY sort_order, id")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            let mut v = Vec::new();
            for row in rows {
                v.push(row?);
            }
            v
        };
        Self::write_rule(&tx, &copy)?;

        let mut order = Vec::with_capacity(existing.len() + 1);
        for rule_id in existing {
            let is_original = rule_id == original.id;
            order.push(rule_id);
            if is_original {
                order.push(copy.id.clone());
            }
        }
        for (slot, rule_id) in order.iter().enumerate() {
            tx.execute(
                "UPDATE automation_rules SET sort_order = ?1 WHERE id = ?2",
                rusqlite::params![slot as i64, rule_id],
            )?;
        }
        tx.commit()?;

        copy.sort_order = order
            .iter()
            .position(|r| r == &copy.id)
            .map(|p| p as i64)
            .unwrap_or(copy.sort_order);
        Ok(copy)
    }

    // ------------------------------------------------------------------------------------------
    // Targets
    // ------------------------------------------------------------------------------------------

    /// Refresh one terminal's label/folder snapshot, inserting the row when this is a criterion match
    /// that was never pinned.
    ///
    /// **Upsert, not UPDATE-only.** The draft was UPDATE-only and throttled to one write per five
    /// minutes, so a criterion-matched id — for which `save_rule` never writes a row — had no row at
    /// all, and the picker's "not open" row had nothing to draw for exactly the closed-terminal case
    /// the snapshot exists for. A CHANGED label or folder is written immediately; only `last_seen_at`
    /// is throttled. `source` is never downgraded: a pinned row touched by the targeting tick stays
    /// pinned. Plan §7.6.
    pub fn touch_target(
        &self,
        rule_id: &str,
        terminal_id: &str,
        label: Option<&str>,
        folder: Option<&str>,
        at: i64,
    ) -> Result<(), AutomationStoreError> {
        let key = (rule_id.to_string(), terminal_id.to_string());
        // The whole question, answered without the lock: this row already says what we were about to
        // write, and its `last_seen_at` is inside the throttle. `None` means "no new value for this",
        // never "clear it", so a `None` argument agrees with whatever is stored.
        if let Some(cached) = self.target_cache.get(&key) {
            let (l, f, seen) = cached.value();
            let same = label.is_none_or(|new| Some(new) == l.as_deref())
                && folder.is_none_or(|new| Some(new) == f.as_deref());
            if same && at - seen < LAST_SEEN_THROTTLE_MS {
                return Ok(());
            }
        }
        let guard = self.conn.lock().unwrap();
        let conn = guard.as_ref().ok_or(AutomationStoreError::Disabled)?;
        let existing: Option<(Option<String>, Option<String>, Option<i64>)> =
            optional_row(conn.query_row(
                "SELECT label, folder, last_seen_at FROM automation_targets
                  WHERE rule_id = ?1 AND terminal_id = ?2",
                rusqlite::params![rule_id, terminal_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            ))?;

        let Some((old_label, old_folder, last_seen)) = existing else {
            conn.execute(
                "INSERT INTO automation_targets
                     (rule_id, terminal_id, source, label, folder, label_at, last_seen_at, added_at)
                 VALUES (?1, ?2, 'matched', ?3, ?4, ?5, ?5, ?5)",
                rusqlite::params![rule_id, terminal_id, label, folder, at],
            )?;
            self.target_cache.insert(
                key,
                (label.map(str::to_string), folder.map(str::to_string), at),
            );
            return Ok(());
        };

        // `None` means "I have no new value for this", never "clear the stored one". `label_at`
        // returns `None` once a terminal is gone, and that is exactly when the snapshot has to
        // survive — clearing it there empties the picker's "not open" row of the label it exists to
        // draw, which is the one case §7.6 was written for.
        let label = label.or(old_label.as_deref());
        let folder = folder.or(old_folder.as_deref());

        // `last_seen_at` as the ROW now holds it, which is not always `at`: the throttle branch
        // deliberately does not write, and a cache that recorded `at` anyway would extend the throttle
        // by one full period every time it was asked.
        let mut seen_now = last_seen.unwrap_or(0);
        if old_label.as_deref() != label || old_folder.as_deref() != folder {
            conn.execute(
                "UPDATE automation_targets
                    SET label = ?3, folder = ?4, label_at = ?5, last_seen_at = ?5
                  WHERE rule_id = ?1 AND terminal_id = ?2",
                rusqlite::params![rule_id, terminal_id, label, folder, at],
            )?;
            seen_now = at;
        } else if at - seen_now >= LAST_SEEN_THROTTLE_MS {
            conn.execute(
                "UPDATE automation_targets SET last_seen_at = ?3
                  WHERE rule_id = ?1 AND terminal_id = ?2",
                rusqlite::params![rule_id, terminal_id, at],
            )?;
            seen_now = at;
        }
        self.target_cache.insert(
            key,
            (label.map(str::to_string), folder.map(str::to_string), seen_now),
        );
        Ok(())
    }

    /// The newest snapshot for **every** terminal id, across all rules (plan §4.3).
    ///
    /// The picker's fallback when the caller has no rule to scope to — an unsaved draft, which is the
    /// case a template is tested in. §4.3: *"scoped to `rule_id` when the caller passes one … else the
    /// newest row for that id across rules. `rule_id: None` with an unknown id is the only case that
    /// yields `label: None, cwd: None`."* Without it every closed terminal in a fresh draft's picker
    /// renders as a bare id, which is the one row the snapshot exists for.
    ///
    /// "Newest" is `label_at`, not `last_seen_at`: the question is *when was this NAME true*, and a
    /// row touched every 30 s by `touch_target`'s throttle carries a recent `last_seen_at` beside a
    /// label from an hour ago.
    ///
    /// The `MAX()`-with-bare-columns form is SQLite's documented bare-column rule: in a query with a
    /// single `min()`/`max()` aggregate, the non-aggregated columns come from the row that produced
    /// it. That is the whole point here — a `GROUP BY` without it would return one rule's label beside
    /// another rule's folder. With every `label_at` NULL the row chosen is arbitrary, which is correct:
    /// there is nothing to prefer.
    pub fn newest_snapshots(
        &self,
    ) -> Result<Vec<crate::automation::roster::TargetSnapshot>, AutomationStoreError> {
        let guard = self.conn.lock().unwrap();
        let conn = guard.as_ref().ok_or(AutomationStoreError::Disabled)?;
        let mut stmt = conn.prepare(
            "SELECT terminal_id, label, folder, MAX(label_at) FROM automation_targets
              GROUP BY terminal_id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(crate::automation::roster::TargetSnapshot {
                terminal_id: r.get(0)?,
                label: r.get(1)?,
                folder: r.get(2)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// One rule's stored targets: `(terminal_id, source, label, folder, last_seen_at)`.
    #[allow(clippy::type_complexity)]
    pub fn targets_for(
        &self,
        rule_id: &str,
    ) -> Result<
        Vec<(String, String, Option<String>, Option<String>, Option<i64>)>,
        AutomationStoreError,
    > {
        let guard = self.conn.lock().unwrap();
        let conn = guard.as_ref().ok_or(AutomationStoreError::Disabled)?;
        let mut stmt = conn.prepare(
            "SELECT terminal_id, source, label, folder, last_seen_at FROM automation_targets
              WHERE rule_id = ?1 ORDER BY added_at, terminal_id",
        )?;
        let rows = stmt.query_map([rule_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    // ------------------------------------------------------------------------------------------
    // The activity log
    // ------------------------------------------------------------------------------------------

    /// The one activity-log writer, the one cap, and the one thing that decides whether
    /// `automation:activity` is due.
    ///
    /// `Ok(None)` means the verbose gate dropped the entry — a normal outcome, not a failure. The
    /// store performs no emit itself: it holds no `AppHandle`, deliberately (see the module doc), so
    /// the caller emits when `AppendOutcome.emit` is true.
    ///
    /// `entry.at` is the entry's own DECISION timestamp and drives both gates. One flush-time `now`
    /// for a whole batch would collapse ten distinct verbose entries into one, breaking the exact
    /// feature verbose logging exists for. Plan §7.5.
    pub fn append(
        &self,
        entry: &AutomationLogEntry,
    ) -> Result<Option<AppendOutcome>, AutomationStoreError> {
        let class = class_of(entry.kind);
        if class == LogClass::Check && !self.check_passes_gate(entry)? {
            return Ok(None);
        }

        let kind = enum_to_db(&entry.kind)?;
        let entry_id = {
            let guard = self.conn.lock().unwrap();
            let conn = guard.as_ref().ok_or(AutomationStoreError::Disabled)?;
            conn.execute(
                "INSERT INTO automation_log (rule_id, terminal_id, terminal_name, kind, detail, at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![
                    entry.rule_id,
                    entry.terminal_id,
                    entry.terminal_name,
                    kind,
                    entry.detail,
                    entry.at
                ],
            )?;
            conn.last_insert_rowid()
        };

        if class == LogClass::Check {
            self.last_verbose
                .insert((entry.rule_id.clone(), entry.terminal_id.clone()), entry.at);
        }
        if let Err(e) = self.bump_and_trim(&entry.rule_id) {
            // The row is already written. A failure to TRIM is not a failure to append, and returning
            // it as one would make the caller log a failed send that actually landed.
            log::warn!("[AUTOMATION] log trim failed for {}: {}", entry.rule_id, e);
        }

        let mut emit = self.emit.lock().unwrap();
        if !emit.pending.contains(&entry.rule_id) {
            emit.pending.push(entry.rule_id.clone());
        }
        if entry.at < emit.last_ms {
            // The wall clock moved backwards. Left alone, `last_ms` sits in the future and NO
            // `automation:activity` is emitted until real time catches up — the panel silently stops
            // repainting for the length of the correction. Resync instead of waiting it out.
            emit.last_ms = entry.at;
        }
        let due = entry.at - emit.last_ms >= EMIT_MIN_INTERVAL_MS;
        let rule_ids = if due {
            emit.last_ms = entry.at;
            std::mem::take(&mut emit.pending)
        } else {
            Vec::new()
        };
        Ok(Some(AppendOutcome {
            entry_id,
            emit: due,
            rule_ids,
        }))
    }

    /// A `Check` entry writes only while verbose is on for its rule AND its pair has been quiet for a
    /// second. `Decision` entries never reach here.
    fn check_passes_gate(&self, entry: &AutomationLogEntry) -> Result<bool, AutomationStoreError> {
        // Copied out so the shard guard drops before anything else takes a lock.
        let cached = self.verbose_cache.get(&entry.rule_id).map(|r| *r);
        let verbose_until: Option<i64> = match cached {
            Some(v) => v,
            None => {
                let v = {
                    let guard = self.conn.lock().unwrap();
                    let conn = guard.as_ref().ok_or(AutomationStoreError::Disabled)?;
                    optional_row(conn.query_row(
                        "SELECT verbose_until FROM automation_rules WHERE id = ?1",
                        [&entry.rule_id],
                        |r| r.get(0),
                    ))?
                    .flatten()
                };
                self.verbose_cache.insert(entry.rule_id.clone(), v);
                v
            }
        };
        if !matches!(verbose_until, Some(until) if entry.at < until) {
            return Ok(false);
        }
        let last = self
            .last_verbose
            .get(&(entry.rule_id.clone(), entry.terminal_id.clone()))
            .map(|r| *r);
        Ok(match last {
            // A stored instant in the FUTURE means the wall clock moved backwards — an NTP
            // correction, or a resume, which this app already handles as an event and which the
            // `automation_log` schema comment above names explicitly. Treat it as no history rather
            // than suppressing every Check until real time catches up: verbose mode is precisely the
            // state the user turned on in order to watch.
            Some(prev) if prev > entry.at => true,
            Some(prev) => entry.at - prev >= VERBOSE_MIN_INTERVAL_MS,
            None => true,
        })
    }

    /// Keep one rule's log at the cap without a scan per write.
    ///
    /// The watermark DELETE yields NULL when the rule has fewer than `LOG_CAP` rows, and `id <= NULL`
    /// is NULL, so it is a safe no-op — no separate guard needed. Plan §3.2.
    fn bump_and_trim(&self, rule_id: &str) -> Result<(), AutomationStoreError> {
        let seeded = self.log_counts.get(rule_id).map(|r| *r);
        let count = match seeded {
            // The seeded counter is the count BEFORE this append.
            Some(n) => n + 1,
            // The seeding query runs after the insert, so it already includes this row.
            None => {
                let guard = self.conn.lock().unwrap();
                let conn = guard.as_ref().ok_or(AutomationStoreError::Disabled)?;
                conn.query_row(
                    "SELECT COUNT(*) FROM automation_log WHERE rule_id = ?1",
                    [rule_id],
                    |r| r.get::<_, i64>(0),
                )?
            }
        };
        if count <= LOG_CAP + LOG_SLACK {
            self.log_counts.insert(rule_id.to_string(), count);
            return Ok(());
        }
        {
            let guard = self.conn.lock().unwrap();
            let conn = guard.as_ref().ok_or(AutomationStoreError::Disabled)?;
            conn.execute(
                "DELETE FROM automation_log
                  WHERE rule_id = ?1
                    AND id <= (SELECT id FROM automation_log WHERE rule_id = ?1
                                ORDER BY id DESC LIMIT 1 OFFSET ?2)",
                rusqlite::params![rule_id, LOG_CAP],
            )?;
        }
        self.log_counts.insert(rule_id.to_string(), LOG_CAP);
        Ok(())
    }

    /// Read the log. **Both callers pass scope, order and limit explicitly** — the drawer is a
    /// recent-activity peek (newest first) and the full log is a timeline read forward (oldest first),
    /// and round 0's audit found the two surfaces disagreeing with nothing to settle it.
    ///
    /// `limit` always takes the NEWEST rows, whichever direction they are then returned in: a
    /// forward-ordered page of the oldest 50 entries would show a busy rule's ancient history and
    /// never its current behaviour.
    pub fn load_automation_log(
        &self,
        scope: &LogScope,
        order: LogOrder,
        limit: i64,
    ) -> Result<Vec<AutomationLogEntry>, AutomationStoreError> {
        let guard = self.conn.lock().unwrap();
        let conn = guard.as_ref().ok_or(AutomationStoreError::Disabled)?;
        let where_clause = match scope {
            LogScope::Rule(_) => "WHERE rule_id = ?1",
            LogScope::All => "",
        };
        // `limit` is interpolated rather than bound purely so the optional `?1` above keeps index 1
        // in both scopes — SQLite binds parameters in LIMIT perfectly well, so this is a readability
        // choice, not a limitation. It is injection-safe because the value is an `i64`; it is clamped
        // because SQLite reads a NEGATIVE limit as *unlimited*, and this value reaches the store from
        // a Tauri command once M4 lands.
        let limit = limit.max(0);
        let sql = format!(
            "SELECT id, rule_id, terminal_id, terminal_name, kind, detail, at
               FROM (SELECT * FROM automation_log {where_clause} ORDER BY id DESC LIMIT {limit})
              ORDER BY id {}",
            match order {
                LogOrder::Asc => "ASC",
                LogOrder::Desc => "DESC",
            }
        );
        let mut stmt = conn.prepare(&sql)?;
        let read = |r: &rusqlite::Row<'_>| -> rusqlite::Result<(i64, String, Option<String>, Option<String>, String, String, i64)> {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?))
        };
        let rows: Vec<_> = match scope {
            LogScope::Rule(id) => stmt.query_map([id.as_str()], read)?.collect(),
            LogScope::All => stmt.query_map([], read)?.collect(),
        };
        let mut out = Vec::new();
        for row in rows {
            let (id, rule_id, terminal_id, terminal_name, kind, detail, at) = row?;
            out.push(AutomationLogEntry {
                id,
                rule_id,
                terminal_id,
                terminal_name,
                kind: enum_from_db(&kind)?,
                detail,
                at,
            });
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn graph() -> AutomationGraph {
        AutomationGraph {
            layout: None,
            monitor: MonitorStep {
                read: ReadMode::NewOutput,
                cadence: Cadence::OnOutput,
                every_ms: 30_000,
            },
            parse: ParseStep {
                preset: ParsePreset::Percentage,
                literal: Some("ctx:".to_string()),
                find: r"ctx:\s*(\d+)%".to_string(),
                keep: Keep::Brackets,
            },
            cond: CondStep {
                kind: CondKind::Number,
                op: Some(CompareOp::Gt),
                threshold: Some(25.0),
            },
            action: ActionStep {
                message: "prepare to do context-hand-off".to_string(),
                send_to: SendTo::Matched,
                submit: true,
                cli_type: "claude".to_string(),
                substitute: false,
            },
        }
    }

    fn rule(id: &str) -> AutomationRule {
        AutomationRule {
            id: id.to_string(),
            name: format!("rule {id}"),
            enabled: true,
            runs_once: false,
            target_mode: TargetMode::Pinned,
            criterion: Criterion::CommandContains,
            criterion_value: "claude".to_string(),
            follow_new: true,
            // A PINNED rule with no targets is one the enable gate refuses, so a fixture that had
            // none was every store test arranging a row the product cannot produce.
            target_ids: vec!["tm-1".to_string()],
            completed_at: None,
            verbose_until: None,
            sort_order: 1,
            schema_version: SUPPORTED_SCHEMA_VERSION,
            graph: graph(),
            created_at: 1_000,
            updated_at: 1_000,
        }
    }

    /// Insert a row whose `graph` column is arbitrary text, bypassing `save_rule`'s
    /// serialisation. There is no other way to author a row this build cannot decode.
    fn write_raw_graph(store: &AutomationStore, id: &str, graph: &str) {
        let guard = store.conn.lock().unwrap();
        let conn = guard.as_ref().unwrap();
        conn.execute(
            "INSERT INTO automation_rules
               (id, name, enabled, runs_once, target_mode, criterion, criterion_value,
                follow_new, completed_at, verbose_until, sort_order, schema_version,
                graph, created_at, updated_at)
             VALUES (?1, 'bad', 1, 0, 'rule', 'allTerminals', '', 1, NULL, NULL, 2, 1, ?2, 1000, 1000)",
            rusqlite::params![id, graph],
        )
        .unwrap();
    }

    fn rule_named(name: &str) -> AutomationRule {
        let mut r = rule(&format!("au-{name}")); // the existing fixture in this module
        r.name = name.to_string();
        r.sort_order = if name == "first" { 1 } else { 3 };
        r
    }

    fn entry(rule_id: &str, kind: LogKind, at: i64) -> AutomationLogEntry {
        AutomationLogEntry {
            id: 0,
            rule_id: rule_id.to_string(),
            terminal_id: Some("tm-1".to_string()),
            terminal_name: Some("claude".to_string()),
            kind,
            detail: "detail".to_string(),
            at,
        }
    }

    // -- §10.14 -------------------------------------------------------------------------------

    /// The second `init` names a **different** file, which is what makes this able to fail. Pointed at
    /// the same path, an implementation with no guard at all re-opens the same database, reads the
    /// same row back, and passes — the oracle could not tell "ignored" from "redone".
    #[test]
    fn init_twice_is_ignored() {
        let first = std::env::temp_dir().join(format!("automation-init-a-{}.db", uuid::Uuid::new_v4()));
        let second = std::env::temp_dir().join(format!("automation-init-b-{}.db", uuid::Uuid::new_v4()));
        let store = AutomationStore::new();
        store.init(&first);
        store.save_rule(&rule("au-1")).unwrap();

        store.init(&second);

        let listed = store.list_rules().unwrap();
        assert_eq!(
            listed.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            vec!["au-1"],
            "the store still reads the database it was initialised with"
        );
        let _ = std::fs::remove_file(&first);
        let _ = std::fs::remove_file(&second);
    }

    /// Clearing a rule's targets must clear ALL of them. The empty pick set used to be spelled as
    /// `terminal_id NOT IN ('')`, and `'' NOT IN ('')` is FALSE — so an empty-string terminal id
    /// survived, and the next `list_rules` put it straight back into `target_ids`.
    #[test]
    fn clearing_the_pick_set_deletes_every_pinned_row() {
        let store = AutomationStore::new_in_memory();
        let mut r = rule("au-1");
        r.target_ids = vec!["tm-a".into(), String::new()];
        store.save_rule(&r).unwrap();
        assert_eq!(store.targets_for("au-1").unwrap().len(), 2);

        // §7.8's save gate refuses a PINNED rule with no targets while it is enabled — which is
        // what the editor's own blocked Save button already told the user. Clearing the picks is
        // therefore something that happens to a rule that is off, and that is the save under test.
        r.enabled = false;
        r.target_ids = vec![];
        store.save_rule(&r).unwrap();

        assert_eq!(store.targets_for("au-1").unwrap(), vec![]);
        assert_eq!(store.get_rule("au-1").unwrap().unwrap().target_ids, Vec::<String>::new());
    }

    /// Every field, asserted by comparing the WHOLE struct. A field-by-field spot check is how a new
    /// column reaches the DTO, the UI and this test's fixture while never reaching the INSERT.
    #[test]
    fn every_rule_field_round_trips_including_the_graph_blob() {
        let store = AutomationStore::new_in_memory();
        let mut original = rule("au-1");
        original.enabled = false;
        original.runs_once = true;
        original.target_mode = TargetMode::Rule;
        original.criterion = Criterion::WorkingFolderUnder;
        original.criterion_value = "~/work/termflow".to_string();
        original.follow_new = false;
        original.completed_at = Some(9_999);
        original.verbose_until = Some(12_345);
        original.sort_order = 7;
        original.created_at = 111;
        original.updated_at = 222;

        store.save_rule(&original).unwrap();
        let loaded = store.get_rule("au-1").unwrap().expect("rule");
        assert_eq!(loaded, original);
        // And through the list path, which decodes the graph blob separately.
        assert_eq!(store.list_rules().unwrap(), vec![original]);
    }

    #[test]
    fn save_rule_replaces_the_pick_set_rather_than_appending() {
        let store = AutomationStore::new_in_memory();
        let mut r = rule("au-1");
        r.target_ids = vec!["tm-a".into(), "tm-b".into()];
        store.save_rule(&r).unwrap();

        r.target_ids = vec!["tm-b".into(), "tm-c".into()];
        store.save_rule(&r).unwrap();

        let loaded = store.get_rule("au-1").unwrap().unwrap();
        let mut ids = loaded.target_ids.clone();
        ids.sort();
        assert_eq!(ids, vec!["tm-b".to_string(), "tm-c".to_string()]);
    }

    /// The label is written by the BACKEND on its own cadence. A re-save that dropped and reinserted
    /// the target rows would throw away exactly the snapshot the picker's "not open" row draws.
    #[test]
    fn a_re_save_keeps_an_existing_label_snapshot() {
        let store = AutomationStore::new_in_memory();
        let mut r = rule("au-1");
        r.target_ids = vec!["tm-a".into()];
        store.save_rule(&r).unwrap();
        store
            .touch_target("au-1", "tm-a", Some("codex"), Some("D:/work"), 5_000)
            .unwrap();

        r.target_ids = vec!["tm-a".into(), "tm-b".into()];
        r.updated_at = 6_000;
        store.save_rule(&r).unwrap();

        let targets = store.targets_for("au-1").unwrap();
        let a = targets.iter().find(|(id, ..)| id == "tm-a").expect("tm-a row");
        assert_eq!(a.2.as_deref(), Some("codex"), "label snapshot survived the re-save");
        assert_eq!(a.3.as_deref(), Some("D:/work"), "folder snapshot survived the re-save");
    }

    #[test]
    fn ensure_column_adds_a_missing_column_to_an_older_table() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute("CREATE TABLE automation_targets (rule_id TEXT, terminal_id TEXT)", [])
            .unwrap();
        // The pre-`folder` shape: a SELECT naming it fails on every existing install without this.
        assert!(conn.query_row("SELECT folder FROM automation_targets", [], |_| Ok(())).is_err());

        AutomationStore::ensure_column(&conn, "automation_targets", "folder", "TEXT").unwrap();
        conn.query_row("SELECT COUNT(folder) FROM automation_targets", [], |r| {
            r.get::<_, i64>(0)
        })
        .expect("folder is queryable after the migration");

        // Idempotent: a second run on an already-migrated table must not fail with "duplicate column".
        AutomationStore::ensure_column(&conn, "automation_targets", "folder", "TEXT").unwrap();
    }

    /// A bare `bool` would collapse "disabled", "not found" and "SQLite is locked" into one `false`,
    /// and the panel would render an empty list where rules exist — inviting a user to recreate rules
    /// they already have.
    #[test]
    fn a_disabled_store_errs_on_every_method() {
        let store = AutomationStore::new();
        let is_disabled = |e: AutomationStoreError| matches!(e, AutomationStoreError::Disabled);

        assert!(is_disabled(store.list_rules().unwrap_err()));
        assert!(is_disabled(store.get_rule("au-1").unwrap_err()));
        assert!(is_disabled(store.save_rule(&rule("au-1")).unwrap_err()));
        assert!(is_disabled(store.delete_rule("au-1").unwrap_err()));
        assert!(is_disabled(store.mark_completed("au-1", 1).unwrap_err()));
        assert!(is_disabled(store.duplicate_automation("au-1", 1).unwrap_err()));
        assert!(is_disabled(store.touch_target("au-1", "tm-a", None, None, 1).unwrap_err()));
        assert!(is_disabled(store.targets_for("au-1").unwrap_err()));
        assert!(is_disabled(store.append(&entry("au-1", LogKind::Sent, 1)).unwrap_err()));
        assert!(is_disabled(
            store.load_automation_log(&LogScope::All, LogOrder::Desc, 10).unwrap_err()
        ));
    }

    /// Skipped, never deleted, and never coerced. A downgrade is real (multi-instance profiles), and
    /// a user whose rules silently vanished after one would have no way to know they still exist.
    #[test]
    fn a_future_schema_version_rule_is_skipped_not_deleted() {
        let store = AutomationStore::new_in_memory();
        let mut future = rule("au-future");
        future.schema_version = SUPPORTED_SCHEMA_VERSION + 1;
        store.save_rule(&future).unwrap();
        store.save_rule(&rule("au-ok")).unwrap();

        let listed = store.list_rules().unwrap();
        assert_eq!(listed.len(), 2, "the future rule is still listed");
        let loaded = listed.iter().find(|r| r.id == "au-future").unwrap();
        assert_eq!(loaded.schema_version, SUPPORTED_SCHEMA_VERSION + 1);
        assert!(!loaded.is_runnable(), "and the engine is told to skip it");
        assert!(listed.iter().find(|r| r.id == "au-ok").unwrap().is_runnable());
    }

    /// Plan 032 §4.2: a graph blob written by a build before `substitute` existed has no such key at
    /// all — decoding it must not fail, and must not turn substitution on behind the user's back.
    /// `awk '{print $1}'` is a message someone may already have saved, and this is the test that
    /// pins it keeps sending literally after the upgrade.
    ///
    /// A mutation that changes `#[serde(default)]` to a function returning `true` is exactly the
    /// regression this guards: only THIS test would catch it, because every fixture literal in this
    /// crate sets `substitute` explicitly and so never exercises serde's own default.
    #[test]
    fn a_graph_with_no_substitute_key_decodes_with_it_off() {
        let raw = r#"{
            "monitor": {"read": "newOutput", "cadence": "onOutput", "everyMs": 0},
            "parse": {"preset": "custom", "find": "FAILED (\\d+)", "keep": "brackets"},
            "cond": {"kind": "text"},
            "action": {"message": "awk '{print $1}'", "sendTo": "matched", "submit": true, "cliType": "default"}
        }"#;
        let decoded: AutomationGraph =
            serde_json::from_str(raw).expect("a graph missing only a newer optional field must still decode");
        assert!(!decoded.action.substitute, "a rule from before this field existed must load with it off");
    }

    // -- §10.14b ------------------------------------------------------------------------------

    /// Asserted as a LIST rather than a spot check: a faulty clone passes §10.14 today. R12, and Clone
    /// Rule was the first thing Tam asked for.
    #[test]
    fn duplicate_automation_produces_an_independent_copy() {
        let store = AutomationStore::new_in_memory();
        let mut original = rule("au-1");
        original.sort_order = 2;
        original.enabled = true;
        original.completed_at = Some(500);
        original.verbose_until = Some(600);
        original.target_ids = vec!["tm-a".into(), "tm-b".into()];
        store.save_rule(&original).unwrap();

        let mut tail = rule("au-tail");
        tail.sort_order = 3;
        store.save_rule(&tail).unwrap();

        store.append(&entry("au-1", LogKind::Sent, 1_000)).unwrap();

        let copy = store.duplicate_automation("au-1", 8_888).unwrap();

        assert!(!copy.enabled, "a copy must not start firing the moment it is created");
        assert_eq!(copy.completed_at, None);
        assert_eq!(copy.verbose_until, None);
        assert_ne!(copy.id, original.id);
        assert_eq!(copy.name, "rule au-1 (copy)");
        let mut copied_ids = copy.target_ids.clone();
        copied_ids.sort();
        assert_eq!(copied_ids, vec!["tm-a".to_string(), "tm-b".to_string()]);
        assert_eq!(
            store.load_automation_log(&LogScope::Rule(copy.id.clone()), LogOrder::Desc, 10).unwrap().len(),
            0,
            "a copy inherits no history"
        );
        // Created now, not when its original was.
        assert_eq!((copy.created_at, copy.updated_at), (8_888, 8_888));

        // The requirement is a POSITION, not an arithmetic relation: the copy sits directly beneath
        // its original in the list's own order.
        let order: Vec<String> =
            store.list_rules().unwrap().into_iter().map(|r| r.id).collect();
        assert_eq!(order, vec!["au-1".to_string(), copy.id.clone(), "au-tail".to_string()]);
        // And the stored slots agree with that order, so it survives a reload.
        assert_eq!(
            store.list_rules().unwrap().into_iter().map(|r| r.sort_order).collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
        assert_eq!(store.get_rule(&copy.id).unwrap().unwrap().sort_order, copy.sort_order);
    }

    /// Nothing enforces that `sort_order` is unique, and a shift by one cannot place the copy when a
    /// sibling already occupies the original's slot: the sibling moves into the copy's intended slot
    /// and the tie falls to whichever id sorts first. Asserted as the position, which is the actual
    /// requirement.
    #[test]
    fn duplicate_lands_beneath_its_original_even_when_a_sibling_shares_the_slot() {
        let store = AutomationStore::new_in_memory();
        let mut a = rule("au-a");
        a.sort_order = 2;
        store.save_rule(&a).unwrap();
        // Same slot, and an id that sorts AFTER the original — so it sorts between the original and
        // anything placed at `original.sort_order + 1`.
        let mut sibling = rule("au-b");
        sibling.sort_order = 2;
        store.save_rule(&sibling).unwrap();

        let copy = store.duplicate_automation("au-a", 1).unwrap();

        let order: Vec<String> = store.list_rules().unwrap().into_iter().map(|r| r.id).collect();
        assert_eq!(order, vec!["au-a".to_string(), copy.id, "au-b".to_string()]);
    }

    /// §10.14d's second half. Five rules, duplicate the MIDDLE one, and assert both the order and the
    /// absence of collisions — a tail shift that merely increments produces the right ORDER while
    /// leaving two rules sharing a slot, and the next duplicate then falls to whichever uuid sorts
    /// first. Asserting the order alone cannot see that.
    #[test]
    fn duplicating_the_middle_of_five_renumbers_densely_with_no_collisions() {
        let store = AutomationStore::new_in_memory();
        for (i, id) in ["au-1", "au-2", "au-3", "au-4", "au-5"].iter().enumerate() {
            let mut r = rule(id);
            r.sort_order = i as i64;
            r.name = id.to_string();
            store.save_rule(&r).unwrap();
        }

        let copy = store.duplicate_automation("au-3", 1).unwrap();

        let rules = store.list_rules().unwrap();
        let order: Vec<String> = rules.iter().map(|r| r.id.clone()).collect();
        assert_eq!(
            order,
            vec![
                "au-1".to_string(),
                "au-2".to_string(),
                "au-3".to_string(),
                copy.id.clone(),
                "au-4".to_string(),
                "au-5".to_string(),
            ],
            "the copy lands directly beneath its original, and the tail follows"
        );

        let slots: Vec<i64> = rules.iter().map(|r| r.sort_order).collect();
        assert_eq!(slots, vec![0, 1, 2, 3, 4, 5], "dense, and every slot distinct");
    }

    // -- §10.15 -------------------------------------------------------------------------------

    /// R17. The `failed — the terminal closed` line is written AFTER the terminal is gone, so a
    /// display-time lookup returns nothing for exactly the line the feature uses to prove itself —
    /// and a rename would rewrite the past.
    ///
    /// Both halves are asserted: asserting only the log half passes on a `touch_target` that no-ops,
    /// which is the exact defect §7.6 says the draft had.
    #[test]
    fn a_log_entry_keeps_the_name_it_was_written_with() {
        let store = AutomationStore::new_in_memory();
        let mut r = rule("au-1");
        r.target_ids = vec!["tm-1".into()];
        store.save_rule(&r).unwrap();
        store.append(&entry("au-1", LogKind::Sent, 1_000)).unwrap();

        store
            .touch_target("au-1", "tm-1", Some("renamed"), None, 2_000)
            .unwrap();

        let log = store
            .load_automation_log(&LogScope::Rule("au-1".into()), LogOrder::Desc, 10)
            .unwrap();
        assert_eq!(log[0].terminal_name.as_deref(), Some("claude"), "the entry keeps its snapshot");

        let targets = store.targets_for("au-1").unwrap();
        let row = targets.iter().find(|(id, ..)| id == "tm-1").expect("tm-1 row");
        assert_eq!(row.2.as_deref(), Some("renamed"), "and touch_target really did write");
    }

    #[test]
    fn a_decision_entry_is_never_rate_limited() {
        let store = AutomationStore::new_in_memory();
        store.save_rule(&rule("au-1")).unwrap();
        // Same millisecond, verbose off — three sends are three rows.
        for i in 0..3 {
            let mut e = entry("au-1", LogKind::Sent, 1_000);
            e.detail = format!("send {i}");
            assert!(store.append(&e).unwrap().is_some());
        }
        // By content, not by count: three rows of the wrong kind or the wrong rule would satisfy a
        // length assertion.
        let log = store.load_automation_log(&LogScope::All, LogOrder::Asc, 10).unwrap();
        assert_eq!(
            log.iter().map(|e| (e.rule_id.as_str(), e.kind, e.detail.as_str())).collect::<Vec<_>>(),
            vec![
                ("au-1", LogKind::Sent, "send 0"),
                ("au-1", LogKind::Sent, "send 1"),
                ("au-1", LogKind::Sent, "send 2"),
            ]
        );
    }

    #[test]
    fn check_entries_are_dropped_when_verbose_is_off() {
        let store = AutomationStore::new_in_memory();
        store.save_rule(&rule("au-1")).unwrap();

        assert!(store.append(&entry("au-1", LogKind::Check, 1_000)).unwrap().is_none());
        assert!(store.append(&entry("au-1", LogKind::NoMatch, 2_000)).unwrap().is_none());
        assert_eq!(
            store.load_automation_log(&LogScope::All, LogOrder::Desc, 10).unwrap(),
            vec![]
        );

        // Turn verbose on and the same entry lands — identified by its own kind and instant, so a row
        // written for some other reason cannot stand in for it.
        let mut r = rule("au-1");
        r.verbose_until = Some(60_000);
        store.save_rule(&r).unwrap();
        assert!(store.append(&entry("au-1", LogKind::Check, 3_000)).unwrap().is_some());
        let log = store.load_automation_log(&LogScope::All, LogOrder::Desc, 10).unwrap();
        assert_eq!(
            log.iter().map(|e| (e.kind, e.at)).collect::<Vec<_>>(),
            vec![(LogKind::Check, 3_000)]
        );
    }

    #[test]
    fn the_cap_trims_to_200_and_the_newest_survives() {
        let store = AutomationStore::new_in_memory();
        store.save_rule(&rule("au-1")).unwrap();
        // One past CAP + SLACK, which is where exactly one watermark DELETE runs.
        for i in 1..=(LOG_CAP + LOG_SLACK + 1) {
            let mut e = entry("au-1", LogKind::Sent, 1_000 + i);
            e.detail = format!("entry {i}");
            store.append(&e).unwrap();
        }
        let log = store
            .load_automation_log(&LogScope::Rule("au-1".into()), LogOrder::Desc, 1_000)
            .unwrap();
        assert_eq!(log.len() as i64, LOG_CAP);
        assert_eq!(log[0].detail, format!("entry {}", LOG_CAP + LOG_SLACK + 1));
    }

    // -- §10.15b ------------------------------------------------------------------------------

    /// The gate must read each entry's OWN decision timestamp, never one flush-time `now` for the
    /// batch — verbose logging exists precisely to show several distinct instants, and a shared `now`
    /// collapses them.
    ///
    /// The plan's three instants (`t`, `t+400`, `t+900`) do not on their own distinguish the two
    /// implementations: both write one row. **The fourth append past the 1 s boundary is what makes
    /// this test able to fail** — with per-entry instants it writes (2 rows), with a shared flush-time
    /// `now` it is still inside the same window and does not (1 row).
    #[test]
    fn the_verbose_limiter_sees_each_entrys_own_instant() {
        let store = AutomationStore::new_in_memory();
        let mut r = rule("au-1");
        r.verbose_until = Some(100_000);
        store.save_rule(&r).unwrap();

        let t = 10_000;
        let written: Vec<bool> = [t, t + 400, t + 900, t + 1_200]
            .iter()
            .map(|at| store.append(&entry("au-1", LogKind::Check, *at)).unwrap().is_some())
            .collect();

        assert_eq!(written, vec![true, false, false, true]);
        let log = store
            .load_automation_log(&LogScope::All, LogOrder::Asc, 10)
            .unwrap();
        assert_eq!(
            log.iter().map(|e| e.at).collect::<Vec<_>>(),
            vec![t, t + 1_200],
            "and each surviving row carries its own instant, not the batch's"
        );
    }

    // -- §10.16 -------------------------------------------------------------------------------

    /// Two windows can hold one rule open and the later save wins whole. The log line naming the
    /// loser is the requirement, so the previous `updated_at` has to be read inside the same
    /// transaction that overwrites it — a separate `get_rule` then `save_rule` is two locked calls
    /// with a race between them.
    #[test]
    fn save_rule_returns_the_previous_updated_at() {
        let store = AutomationStore::new_in_memory();
        let mut r = rule("au-1");
        r.updated_at = 1_000;
        assert_eq!(store.save_rule(&r).unwrap(), None, "a new rule has no previous version");

        r.updated_at = 2_000;
        assert_eq!(store.save_rule(&r).unwrap(), Some(1_000));

        r.updated_at = 3_000;
        assert_eq!(store.save_rule(&r).unwrap(), Some(2_000));
        assert_eq!(store.get_rule("au-1").unwrap().unwrap().updated_at, 3_000);
    }

    /// A new rule belongs AFTER every rule that already exists — **and stays where it landed**.
    ///
    /// `list_rules` is `ORDER BY sort_order, id`, and the renderer sends `sortOrder: 0` for a draft
    /// because where a new rule lands is not its decision. The first fix minted the slot on the
    /// INSERT path only, which is the half of the class that is easy to see: the editor stays open
    /// after that first Save, its draft still holds `sortOrder: 0`, and the second Save wrote that
    /// zero through and sent the rule back to the top. **The second save is the assertion.**
    #[test]
    fn a_renderer_save_takes_its_slot_from_the_store_every_time() {
        let store = AutomationStore::new_in_memory();

        let mut a = rule("au-1");
        a.sort_order = 0;
        store.save_rule(&a).unwrap();
        // A gap, which `duplicate_automation`'s renumbering can leave: the next slot is past the
        // HIGHEST, not one past the count.
        let mut b = rule("au-2");
        b.sort_order = 7;
        store.save_rule(&b).unwrap();

        // The renderer's draft: a placeholder zero in every column that is the row's own fact.
        let mut fresh = rule("au-3");
        fresh.sort_order = 0;
        fresh.created_at = 0;
        fresh.updated_at = 0;

        assert_eq!(store.save_rule_as_of(&fresh, 5_000).unwrap(), None, "this rule is new");
        let after_insert = store.get_rule("au-3").unwrap().unwrap();
        assert_eq!(after_insert.sort_order, 8, "a new rule files after the highest slot in use");
        assert_eq!(after_insert.created_at, 5_000);
        assert_eq!(after_insert.updated_at, 5_000);

        // The SECOND save, from the same still-open editor, whose draft never learned any of this.
        assert_eq!(
            store.save_rule_as_of(&fresh, 6_000).unwrap(),
            Some(5_000),
            "the previous `updated_at` names the version this one replaced"
        );
        let after_update = store.get_rule("au-3").unwrap().unwrap();
        assert_eq!(after_update.sort_order, 8, "a re-save must not move the rule in the list");
        assert_eq!(after_update.created_at, 5_000, "a re-save must not change when it was created");
        assert_eq!(
            after_update.updated_at, 6_000,
            "`reload` drops a rule's arm keys only when this moves — Q11 has no other path"
        );
    }

    /// The save gate applies on this path too, and **before anything is read**.
    ///
    /// `save_rule_as_of` is a second door to the same table, and a second door that skipped
    /// `refuse_if_it_would_run_wrong` would let a rule saved with its toggle already on go live
    /// unjudged — R10's exact failure, through the one path a renderer actually uses.
    #[test]
    fn a_renderer_save_is_gated_exactly_as_save_rule_is() {
        let store = AutomationStore::new_in_memory();
        let mut bad = rule("au-1");
        bad.enabled = true;
        bad.graph.action.message = String::new();

        assert!(store.save_rule_as_of(&bad, 1_000).is_err(), "an enabled rule with no message");
        assert!(store.get_rule("au-1").unwrap().is_none(), "and nothing was written");
    }

    /// `LogClass` is derived from `kind` inside `append` and is not a parameter, so a caller cannot
    /// gate a `Sent` entry behind the verbose flag and lose the one line the log exists for.
    #[test]
    fn a_sent_entry_cannot_be_gated_but_a_check_can() {
        let store = AutomationStore::new_in_memory();
        store.save_rule(&rule("au-1")).unwrap();
        // Verbose is off for both. Only the class derived from `kind` separates them.
        let sent = store.append(&entry("au-1", LogKind::Sent, 1_000)).unwrap();
        let check = store.append(&entry("au-1", LogKind::Check, 1_000)).unwrap();
        assert!(sent.is_some(), "a Sent entry always writes");
        assert!(check.is_none(), "a Check entry does not");
    }

    /// The store owns the DECISION to emit even though its caller performs the emit, so the 1/sec
    /// limit cannot be re-implemented per caller — and the rules that wrote inside a shut window are
    /// carried into the next emit rather than lost.
    #[test]
    fn the_activity_emit_is_coalesced_and_names_every_rule_that_wrote() {
        let store = AutomationStore::new_in_memory();
        store.save_rule(&rule("au-1")).unwrap();
        store.save_rule(&rule("au-2")).unwrap();

        let first = store.append(&entry("au-1", LogKind::Sent, 10_000)).unwrap().unwrap();
        assert!(first.emit);
        assert_eq!(first.rule_ids, vec!["au-1".to_string()]);

        // Inside the window: no emit, but the rule is remembered.
        let second = store.append(&entry("au-2", LogKind::Sent, 10_300)).unwrap().unwrap();
        assert!(!second.emit);
        assert!(second.rule_ids.is_empty());

        // The window reopens and the emit names BOTH rules — au-2's only entry fell inside the shut
        // window, and a payload that dropped it would leave that row's panel never repainting.
        let third = store.append(&entry("au-1", LogKind::Sent, 11_000)).unwrap().unwrap();
        assert!(third.emit);
        let mut named = third.rule_ids.clone();
        named.sort();
        assert_eq!(named, vec!["au-1".to_string(), "au-2".to_string()]);
    }

    // -- §10.16b ------------------------------------------------------------------------------

    /// Both callers pass scope, order and limit explicitly, so both directions are tested: the drawer
    /// is a newest-first peek and the full log is a timeline read forward.
    #[test]
    fn load_automation_log_honours_scope_order_and_limit() {
        let store = AutomationStore::new_in_memory();
        store.save_rule(&rule("au-1")).unwrap();
        store.save_rule(&rule("au-2")).unwrap();
        for (rule_id, at) in [("au-1", 1_000), ("au-2", 2_000), ("au-1", 3_000), ("au-2", 4_000)] {
            let mut e = entry(rule_id, LogKind::Sent, at);
            e.detail = format!("{rule_id}@{at}");
            store.append(&e).unwrap();
        }
        let details = |v: Vec<AutomationLogEntry>| {
            v.into_iter().map(|e| e.detail).collect::<Vec<_>>()
        };

        assert_eq!(
            details(store.load_automation_log(&LogScope::Rule("au-1".into()), LogOrder::Asc, 10).unwrap()),
            vec!["au-1@1000", "au-1@3000"]
        );
        assert_eq!(
            details(store.load_automation_log(&LogScope::Rule("au-1".into()), LogOrder::Desc, 10).unwrap()),
            vec!["au-1@3000", "au-1@1000"]
        );
        assert_eq!(
            details(store.load_automation_log(&LogScope::All, LogOrder::Asc, 10).unwrap()),
            vec!["au-1@1000", "au-2@2000", "au-1@3000", "au-2@4000"]
        );
        // A limit takes the NEWEST rows whichever direction they are then shown in. A forward page of
        // the OLDEST two would show a busy rule's ancient history and never its current behaviour.
        assert_eq!(
            details(store.load_automation_log(&LogScope::All, LogOrder::Asc, 2).unwrap()),
            vec!["au-1@3000", "au-2@4000"]
        );
        assert_eq!(
            details(store.load_automation_log(&LogScope::All, LogOrder::Desc, 2).unwrap()),
            vec!["au-2@4000", "au-1@3000"]
        );
    }

    #[test]
    fn deleting_a_rule_removes_its_targets_and_its_log() {
        let store = AutomationStore::new_in_memory();
        let mut r = rule("au-1");
        r.target_ids = vec!["tm-a".into()];
        store.save_rule(&r).unwrap();
        store.save_rule(&rule("au-2")).unwrap();
        store.append(&entry("au-1", LogKind::Sent, 1_000)).unwrap();
        store.append(&entry("au-2", LogKind::Sent, 2_000)).unwrap();

        assert!(store.delete_rule("au-1").unwrap());
        assert!(!store.delete_rule("au-1").unwrap(), "already absent is Ok(false), not an error");

        assert_eq!(store.get_rule("au-1").unwrap(), None, "the rule itself is gone");
        assert_eq!(store.targets_for("au-1").unwrap(), vec![]);
        // Asserted by IDENTITY, not by count: `DELETE … WHERE rule_id != ?1` also leaves one row.
        let surviving = store.load_automation_log(&LogScope::All, LogOrder::Asc, 10).unwrap();
        assert_eq!(
            surviving.iter().map(|e| e.rule_id.as_str()).collect::<Vec<_>>(),
            vec!["au-2"],
            "au-2's history is what survived"
        );
        assert!(store.get_rule("au-2").unwrap().is_some());
    }

    #[test]
    fn mark_completed_stamps_the_rule_and_reports_a_missing_one() {
        let store = AutomationStore::new_in_memory();
        store.save_rule(&rule("au-1")).unwrap();
        assert!(store.mark_completed("au-1", 7_777).unwrap());
        assert_eq!(store.get_rule("au-1").unwrap().unwrap().completed_at, Some(7_777));
        assert!(!store.mark_completed("au-nope", 1).unwrap());
    }

    /// A criterion-matched terminal is never pinned, so `save_rule` never writes its row. UPDATE-only
    /// left it with no row at all — empty for exactly the closed-terminal case the snapshot exists
    /// for. Plan §7.6.
    #[test]
    fn touch_target_upserts_a_matched_terminal_and_throttles_only_last_seen() {
        let store = AutomationStore::new_in_memory();
        store.save_rule(&rule("au-1")).unwrap();

        store.touch_target("au-1", "tm-m", Some("codex"), Some("D:/a"), 1_000).unwrap();
        // By ID, never by position: the rule also has a PINNED row, and a test that says "the
        // first row" is one ordering change away from asserting about the wrong terminal.
        let row = |s: &AutomationStore| matched_row(s, "au-1", "tm-m");
        let first = row(&store);
        assert_eq!(first.1, "matched", "a never-pinned match still gets a row");
        assert_eq!(first.2.as_deref(), Some("codex"));
        assert_eq!(first.4, Some(1_000));

        // Nothing changed and the throttle window is open: no write.
        store.touch_target("au-1", "tm-m", Some("codex"), Some("D:/a"), 2_000).unwrap();
        assert_eq!(row(&store).4, Some(1_000), "last_seen_at is throttled");

        // A CHANGED label is written immediately, throttle or no throttle.
        store.touch_target("au-1", "tm-m", Some("claude"), Some("D:/a"), 3_000).unwrap();
        let renamed = row(&store);
        assert_eq!(renamed.2.as_deref(), Some("claude"));
        assert_eq!(renamed.4, Some(3_000));

        // Past the throttle window with nothing else changed: last_seen_at alone moves.
        store
            .touch_target("au-1", "tm-m", Some("claude"), Some("D:/a"), 3_000 + LAST_SEEN_THROTTLE_MS)
            .unwrap();
        assert_eq!(row(&store).4, Some(3_000 + LAST_SEEN_THROTTLE_MS));
    }

    // -- Added after the M1 dual review: guards whose absence let a wrong implementation pass -----

    /// The rate-limit key is the PAIR, and until this test both single-field keys passed the whole
    /// suite. §3.3 spends a paragraph on the terminal-only variant: *"one chatty rule consumes the
    /// whole 1/sec budget and a second rule watching the same terminal writes nothing — its log
    /// empty, which reads as 'the rule isn't running'."* Nothing pinned it.
    #[test]
    fn the_verbose_rate_limit_is_keyed_by_rule_and_terminal_together() {
        let store = AutomationStore::new_in_memory();
        for id in ["au-1", "au-2"] {
            let mut r = rule(id);
            r.verbose_until = Some(100_000);
            store.save_rule(&r).unwrap();
        }
        let check = |rule_id: &str, terminal: &str, at: i64| {
            let mut e = entry(rule_id, LogKind::Check, at);
            e.terminal_id = Some(terminal.to_string());
            e
        };

        // Two RULES, one terminal, 10 ms apart. A terminal-only key drops the second.
        assert!(store.append(&check("au-1", "tm-1", 10_000)).unwrap().is_some());
        assert!(
            store.append(&check("au-2", "tm-1", 10_010)).unwrap().is_some(),
            "a second rule watching the same terminal has its own budget"
        );
        // One rule, two TERMINALS, 10 ms apart. A rule-only key drops the second.
        assert!(
            store.append(&check("au-1", "tm-2", 10_020)).unwrap().is_some(),
            "the same rule watching a second terminal has its own budget"
        );
        // …and the pair that really did just write is still limited.
        assert!(store.append(&check("au-1", "tm-1", 10_030)).unwrap().is_none());

        let written: Vec<(String, Option<String>)> = store
            .load_automation_log(&LogScope::All, LogOrder::Asc, 10)
            .unwrap()
            .into_iter()
            .map(|e| (e.rule_id, e.terminal_id))
            .collect();
        assert_eq!(
            written,
            vec![
                ("au-1".to_string(), Some("tm-1".to_string())),
                ("au-2".to_string(), Some("tm-1".to_string())),
                ("au-1".to_string(), Some("tm-2".to_string())),
            ]
        );
    }

    /// A `Decision` entry must not spend the pair's `Check` budget. The `if class == Check` around the
    /// `last_verbose` write is what stops a `Sent` suppressing the next second of verbose output, and
    /// removing it left every test green.
    #[test]
    fn a_decision_entry_does_not_consume_the_check_budget() {
        let store = AutomationStore::new_in_memory();
        let mut r = rule("au-1");
        r.verbose_until = Some(100_000);
        store.save_rule(&r).unwrap();

        store.append(&entry("au-1", LogKind::Sent, 10_000)).unwrap();
        assert!(
            store.append(&entry("au-1", LogKind::Check, 10_010)).unwrap().is_some(),
            "the Sent 10 ms earlier must not have spent the Check budget"
        );
    }

    /// §3.1 gives this its own paragraph — two entries can share a millisecond, and the wall clock can
    /// move backwards after an NTP correction or a resume. Swapping both `ORDER BY id` clauses to
    /// `ORDER BY at` left every other test green, because in all of them `at` rose with insertion.
    #[test]
    fn the_log_is_ordered_by_id_and_never_by_at() {
        let store = AutomationStore::new_in_memory();
        store.save_rule(&rule("au-1")).unwrap();
        for (detail, at) in [("first", 5_000), ("second", 5_000), ("third", 1_000)] {
            let mut e = entry("au-1", LogKind::Sent, at);
            e.detail = detail.to_string();
            store.append(&e).unwrap();
        }
        let details = |order| {
            store
                .load_automation_log(&LogScope::All, order, 10)
                .unwrap()
                .into_iter()
                .map(|e| e.detail)
                .collect::<Vec<_>>()
        };
        // Two share an instant and the third went backwards; insertion order still decides.
        assert_eq!(details(LogOrder::Asc), vec!["first", "second", "third"]);
        assert_eq!(details(LogOrder::Desc), vec!["third", "second", "first"]);
    }

    /// The `limit` takes the newest rows by `id` too, not by `at`.
    #[test]
    fn the_log_limit_takes_the_newest_by_id() {
        let store = AutomationStore::new_in_memory();
        store.save_rule(&rule("au-1")).unwrap();
        for (detail, at) in [("oldest", 9_000), ("middle", 1_000), ("newest", 5_000)] {
            let mut e = entry("au-1", LogKind::Sent, at);
            e.detail = detail.to_string();
            store.append(&e).unwrap();
        }
        assert_eq!(
            store
                .load_automation_log(&LogScope::All, LogOrder::Asc, 2)
                .unwrap()
                .into_iter()
                .map(|e| e.detail)
                .collect::<Vec<_>>(),
            vec!["middle", "newest"]
        );
    }

    /// `ensure_column` had a production caller and nothing proved it: deleting the call from
    /// `schema()` left all twenty tests green, while every existing install of this branch would fail
    /// on the first `SELECT … folder`. This opens a real file holding the PRE-`folder` table.
    #[test]
    fn init_migrates_a_pre_folder_targets_table() {
        let path = std::env::temp_dir().join(format!("automation-migrate-{}.db", uuid::Uuid::new_v4()));
        {
            let old = Connection::open(&path).unwrap();
            old.execute(
                "CREATE TABLE automation_targets (
                     rule_id TEXT NOT NULL, terminal_id TEXT NOT NULL, source TEXT NOT NULL,
                     label TEXT, label_at INTEGER, last_seen_at INTEGER, added_at INTEGER NOT NULL,
                     PRIMARY KEY (rule_id, terminal_id))",
                [],
            )
            .unwrap();
        }

        let store = AutomationStore::new();
        store.init(&path);

        // Every read of this table names `folder`; without the migration each one is a hard error.
        store.touch_target("au-1", "tm-a", Some("codex"), Some("D:/w"), 1_000).unwrap();
        let rows = store.targets_for("au-1").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].3.as_deref(), Some("D:/w"));
        let _ = std::fs::remove_file(&path);
    }

    /// The emit window must DRAIN its pending list. Replacing `mem::take` with `clone()` passed every
    /// assertion the suite had, while in production every later emit would name every rule that ever
    /// wrote — a payload that grows forever and repaints rows that did nothing.
    #[test]
    fn the_activity_emit_drains_its_pending_rules() {
        let store = AutomationStore::new_in_memory();
        store.save_rule(&rule("au-1")).unwrap();
        store.save_rule(&rule("au-2")).unwrap();

        store.append(&entry("au-1", LogKind::Sent, 10_000)).unwrap();
        store.append(&entry("au-2", LogKind::Sent, 10_300)).unwrap();
        let second_emit = store.append(&entry("au-1", LogKind::Sent, 11_000)).unwrap().unwrap();
        assert!(second_emit.emit);

        // A later window must name ONLY what wrote since the last emit.
        let third = store.append(&entry("au-1", LogKind::Sent, 12_200)).unwrap().unwrap();
        assert!(third.emit);
        assert_eq!(third.rule_ids, vec!["au-1".to_string()]);
    }

    /// Both rate limits do interval arithmetic on a wall clock that the schema comment three hundred
    /// lines above says moves backwards. Untreated, a correction of N ms silences every activity emit
    /// and drops every verbose entry for N ms — in the one mode the user turned on to watch.
    #[test]
    fn a_backwards_wall_clock_does_not_silence_either_gate() {
        let store = AutomationStore::new_in_memory();
        let mut r = rule("au-1");
        r.verbose_until = Some(1_000_000);
        store.save_rule(&r).unwrap();

        store.append(&entry("au-1", LogKind::Check, 500_000)).unwrap();
        // …and now the clock jumps back a minute.
        assert!(
            store.append(&entry("au-1", LogKind::Check, 440_000)).unwrap().is_some(),
            "a Check after a backwards correction still writes"
        );
        let outcome = store.append(&entry("au-1", LogKind::Sent, 441_000)).unwrap().unwrap();
        assert!(outcome.emit, "and the activity emit resyncs rather than waiting out the skew");
    }

    /// One rule's row for one terminal.
    #[allow(clippy::type_complexity)]
    fn matched_row(
        store: &AutomationStore,
        rule_id: &str,
        tm: &str,
    ) -> (String, String, Option<String>, Option<String>, Option<i64>) {
        store
            .targets_for(rule_id)
            .unwrap()
            .into_iter()
            .find(|r| r.0 == tm)
            .unwrap_or_else(|| panic!("no row for {}", tm))
    }

    /// `None` means "no new value", never "clear the stored one". `label_at` returns `None` once a
    /// terminal is gone — exactly when the picker's "not open" row needs the snapshot most.
    #[test]
    fn touch_target_never_clears_a_stored_label_with_none() {
        let store = AutomationStore::new_in_memory();
        store.save_rule(&rule("au-1")).unwrap();
        store.touch_target("au-1", "tm-m", Some("codex"), Some("D:/a"), 1_000).unwrap();

        // The terminal closed: the resolver has no label to offer any more.
        store.touch_target("au-1", "tm-m", None, None, 2_000).unwrap();

        let row = matched_row(&store, "au-1", "tm-m");
        assert_eq!(row.2.as_deref(), Some("codex"), "the label survived the terminal");
        assert_eq!(row.3.as_deref(), Some("D:/a"), "and so did the folder");
    }

    /// §3.3's startup sweep. The gate is a comparison and does not need it; the column is
    /// user-visible and does, or the editor renders "verbose until 10:17" for a deadline days past.
    #[test]
    fn the_startup_sweep_nulls_deadlines_already_past() {
        let store = AutomationStore::new_in_memory();
        let mut past = rule("au-past");
        past.verbose_until = Some(1_000);
        store.save_rule(&past).unwrap();
        let mut future = rule("au-future");
        future.verbose_until = Some(9_000);
        store.save_rule(&future).unwrap();

        assert_eq!(store.sweep_expired_verbose(5_000).unwrap(), 1);

        assert_eq!(store.get_rule("au-past").unwrap().unwrap().verbose_until, None);
        assert_eq!(store.get_rule("au-future").unwrap().unwrap().verbose_until, Some(9_000));
    }

    /// §3.2 leans on `id <= NULL` being a safe no-op — *"no separate guard needed"* — but the early
    /// return below the cap means the DELETE never ran with a short log, so the claim was untested.
    /// Counter drift makes that reachable in production, so drive it directly.
    #[test]
    fn the_watermark_delete_is_a_no_op_below_the_cap() {
        let store = AutomationStore::new_in_memory();
        store.save_rule(&rule("au-1")).unwrap();
        for i in 0..5 {
            let mut e = entry("au-1", LogKind::Sent, 1_000 + i);
            e.detail = format!("entry {i}");
            store.append(&e).unwrap();
        }
        // Pretend the lazily-seeded counter drifted far past the cap, which forces the trim to run
        // against a log of five rows.
        store.log_counts.insert("au-1".to_string(), LOG_CAP + LOG_SLACK + 100);
        let mut e = entry("au-1", LogKind::Sent, 2_000);
        e.detail = "entry 5".to_string();
        store.append(&e).unwrap();

        let details = store
            .load_automation_log(&LogScope::All, LogOrder::Asc, 100)
            .unwrap()
            .into_iter()
            .map(|e| e.detail)
            .collect::<Vec<_>>();
        assert_eq!(
            details,
            vec!["entry 0", "entry 1", "entry 2", "entry 3", "entry 4", "entry 5"],
            "a trim below the cap deletes nothing"
        );
    }
    /// The store's own `rule()` fixture has an EMPTY pick set, which `problems()` blocks on — so the
    /// enable-path tests need one that could legitimately run. That the base fixture is invalid is
    /// itself the point: nothing before now judged a rule at all.
    fn enableable(id: &str) -> AutomationRule {
        let mut r = rule(id);
        r.target_ids = vec!["tm-1".to_string()];
        r
    }

    // =============================================================================================
    // §10.18b — the enable path actually refuses (R10's only backend oracle)
    // =============================================================================================

    fn enabled_flag(store: &AutomationStore, id: &str) -> bool {
        store.get_rule(id).unwrap().expect("the rule must still be there").enabled
    }

    /// **The row toggle bypasses the editor entirely**, which is where the boundary audit found this:
    /// the editor gated its own toggle, the store validated nothing semantic, and the engine refused
    /// only an uncompilable pattern — so a rule with no terminals and an empty message went live
    /// straight from the list. The backend owns *"is this rule allowed to run"*.
    #[test]
    fn the_enable_path_refuses_an_invalid_rule_and_leaves_it_disabled() {
        let store = AutomationStore::new_in_memory();
        let mut rule = enableable("au-bad");
        rule.enabled = false;
        rule.target_ids.clear();
        rule.graph.action.message = String::new();
        store.save_rule(&rule).unwrap();

        let refused = store.set_enabled_checked("au-bad", true);

        assert!(matches!(refused, Err(AutomationStoreError::Invalid(_))), "{:?}", refused);
        assert!(!enabled_flag(&store, "au-bad"), "refused, and yet the row says enabled");

        // Paired positive: the same call on a rule with nothing wrong with it goes through, so
        // "refuses everything" cannot be how the assertion above passes.
        let good = enableable("au-good");
        store.save_rule(&good).unwrap();
        store.set_enabled_checked("au-good", true).unwrap();
        assert!(enabled_flag(&store, "au-good"));
    }

    /// **Disabling is never refused.** A rule the user wants stopped is stopped, whatever is wrong
    /// with it — refusing to turn off an invalid rule would trap it running, which is the opposite of
    /// what the gate is for.
    #[test]
    fn disabling_is_never_refused_however_broken_the_rule_is() {
        let store = AutomationStore::new_in_memory();

        // Enabled AND broken, through the one route §7.8's save gate still allows: the PATTERN, which
        // the engine re-checks at every load and this gate therefore leaves alone. That is not a
        // convenient loophole, it is the whole shape of the exemption — and a rule in exactly this
        // state is what a user meets after an upgrade changes what compiles.
        let mut bad = enableable("au-bad");
        bad.enabled = true;
        bad.graph.parse.find = "ctx:(\\d+".into();
        store.save_rule(&bad).unwrap();
        assert!(enabled_flag(&store, "au-bad"), "the premise: it is on, and it cannot run");

        store.set_enabled_checked("au-bad", false).unwrap();
        assert!(!enabled_flag(&store, "au-bad"));

        // And the other kind of broken, which can only be stored while it is off: turning a rule
        // that is already off further off is still never a validation question.
        let mut empty = enableable("au-empty");
        empty.enabled = false;
        empty.target_ids.clear();
        empty.graph.action.message = String::new();
        store.save_rule(&empty).unwrap();

        store.set_enabled_checked("au-empty", false).unwrap();
        assert!(!enabled_flag(&store, "au-empty"));
    }

    /// §7.8's SAVE gate, and the one field it lets through.
    ///
    /// The gate exists for R10: a draft saved with its toggle already on used to go live unjudged, and
    /// an empty message makes `deliver` press a bare Enter into whatever is running. The exemption
    /// exists for §2.7: `reload` compiles every pattern at load, refuses the ones it cannot, and
    /// reports them once per load — a store that refused to write one would make that path dead code
    /// here while it stays reachable in production through an older build, a migration, or a regex
    /// version that no longer accepts what it once did.
    #[test]
    fn the_save_gate_refuses_an_enabled_draft_but_never_the_pattern() {
        let store = AutomationStore::new_in_memory();

        let mut broken = enableable("au-1");
        broken.enabled = true;
        broken.graph.action.message = String::new();
        let refused = store.save_rule(&broken);
        assert!(matches!(refused, Err(AutomationStoreError::Invalid(_))), "{:?}", refused);
        assert!(store.get_rule("au-1").unwrap().is_none(), "refused, and yet the row was written");

        // The same rule with its toggle OFF is a draft, and a draft is allowed to be incomplete.
        broken.enabled = false;
        store.save_rule(&broken).unwrap();
        assert!(store.get_rule("au-1").unwrap().is_some());

        // A pattern this build cannot compile is the exemption, enabled or not.
        let mut bad_pattern = enableable("au-2");
        bad_pattern.enabled = true;
        bad_pattern.graph.parse.find = "ctx:(\\d+".into();
        store.save_rule(&bad_pattern).unwrap();
        assert!(enabled_flag(&store, "au-2"), "the engine refuses this one, at load, once");

        // **An EMPTY pattern is exempted too — because the ENGINE now refuses it.** That is the whole
        // shape of this gate: it lets through exactly the set `pattern_refused_at_load` names, and not
        // a field. The first version exempted the whole `parse` field on the reasoning that the engine
        // re-checks the pattern, and the engine re-checked only whether it COMPILED — an empty regex
        // compiles into an expression matching every position of every string, so the rule went live
        // and a presence rule fired on the first byte any terminal printed. Both halves moved: the
        // engine refuses an unusable pattern, and the exemption is derived from that same answer.
        let mut empty_pattern = enableable("au-3");
        empty_pattern.enabled = true;
        empty_pattern.graph.parse.find = "   ".into();
        store.save_rule(&empty_pattern).unwrap();
        assert!(
            crate::automation_validation::pattern_refused_at_load("   ").is_some(),
            "stored enabled, and the engine must be the thing that refuses to run it"
        );

        // **The case that separates a DERIVED exemption from a FIELD one**, and the only one: `parse`
        // carries three blocking problems, and `pattern_refused_at_load` answers `Some` for two of
        // them. A numeric rule keeping the bracketed value, with no brackets, compiles fine — so the
        // engine admits it, `extract` degrades to `Read::Unparsed`, and the rule runs forever without
        // firing. Under `p.field != "parse"` this rule stored ENABLED and the whole suite passed.
        let mut no_group = enableable("au-4");
        no_group.enabled = true;
        no_group.graph.parse.find = r"ctx:\d+%".into();
        assert!(
            crate::automation_validation::pattern_refused_at_load(&no_group.graph.parse.find)
                .is_none(),
            "the premise: the engine will happily run this pattern"
        );
        let refused = store.save_rule(&no_group);
        assert!(matches!(refused, Err(AutomationStoreError::Invalid(_))), "{:?}", refused);
        assert!(store.get_rule("au-4").unwrap().is_none());

        // The claim, narrowed to what is asserted: every pattern this gate lets through is one the
        // engine refuses at load. The converse is NOT claimed — `au-4` above is blocked here and the
        // engine would have run it, which is the entire reason this gate exists.
        for find in ["", "   ", "ctx:(\\d+"] {
            assert!(
                crate::automation_validation::pattern_refused_at_load(find).is_some(),
                "`{}` is exempted by the save gate and would then RUN",
                find
            );
        }
        assert!(crate::automation_validation::pattern_refused_at_load("ctx:(\\d+)%").is_none());

        // And the ENABLE gate still refuses it, so the exemption widens nothing: the only way an
        // uncompilable pattern is stored enabled is by being saved that way.
        store.set_enabled_checked("au-2", false).unwrap();
        let refused = store.set_enabled_checked("au-2", true);
        assert!(matches!(refused, Err(AutomationStoreError::Invalid(_))), "{:?}", refused);
    }

    /// **§4.3's fallback, which had no test at all.** `list_watchable_terminals` answers an unsaved
    /// draft's picker from this, and reverting it to `Ok(Vec::new())` — the exact round-1 defect,
    /// where every closed terminal drew as a bare id — passed the whole suite.
    ///
    /// The property under test is *newest by `label_at`, not by `last_seen_at`*: `touch_target`'s
    /// throttle refreshes `last_seen_at` on a row whose label is an hour old, so a query ordered the
    /// other way returns the stale name. Two rules holding different labels for one terminal is what
    /// makes the two orderings disagree; one rule cannot.
    #[test]
    fn the_newest_snapshot_across_rules_is_the_newest_label_not_the_newest_sighting() {
        let store = AutomationStore::new_in_memory();
        store.save_rule(&rule("au-1")).unwrap();
        store.save_rule(&rule("au-2")).unwrap();

        // au-1 saw it first, under its old name.
        store.touch_target("au-1", "tm-shared", Some("bash"), Some("D:/old"), 1_000).unwrap();
        // au-2 saw it later, renamed. This is the row a `label_at` ordering must return.
        store.touch_target("au-2", "tm-shared", Some("claude"), Some("D:/new"), 5_000).unwrap();
        // …and then au-1's row is touched again, which moves only `last_seen_at`. A query ordered by
        // sighting returns "bash" from here on.
        store
            .touch_target("au-1", "tm-shared", None, None, 5_000 + LAST_SEEN_THROTTLE_MS)
            .unwrap();

        let snaps = store.newest_snapshots().unwrap();
        let shared = snaps
            .iter()
            .find(|s| s.terminal_id == "tm-shared")
            .expect("the fallback returned nothing for a terminal two rules have seen");
        assert_eq!(shared.label.as_deref(), Some("claude"), "the stale label won");
        assert_eq!(shared.folder.as_deref(), Some("D:/new"));
        assert_eq!(snaps.iter().filter(|s| s.terminal_id == "tm-shared").count(), 1, "one row per id");
    }

    /// **The cache is not allowed to become the answer.** A changed label must reach the row even
    /// when the cache has an entry, and a repeat inside the throttle must not.
    #[test]
    fn touch_target_skips_the_row_only_while_nothing_has_changed() {
        let store = AutomationStore::new_in_memory();
        store.save_rule(&rule("au-1")).unwrap();
        store.touch_target("au-1", "tm-1", Some("bash"), Some("D:/a"), 1_000).unwrap();

        // The instrument, made dirty on purpose: change the row behind the cache's back. A second
        // identical touch inside the throttle must not read or write it, so the change survives.
        {
            let guard = store.conn.lock().unwrap();
            guard
                .as_ref()
                .unwrap()
                .execute(
                    "UPDATE automation_targets SET label = 'tampered' WHERE rule_id = 'au-1'",
                    [],
                )
                .unwrap();
        }
        store.touch_target("au-1", "tm-1", Some("bash"), Some("D:/a"), 2_000).unwrap();
        assert_eq!(
            store.targets_for("au-1").unwrap()[0].2.as_deref(),
            Some("tampered"),
            "the skip did not happen: this touch went to the row"
        );

        // A CHANGED label is never skipped, cache or no cache.
        store.touch_target("au-1", "tm-1", Some("claude"), Some("D:/a"), 3_000).unwrap();
        assert_eq!(store.targets_for("au-1").unwrap()[0].2.as_deref(), Some("claude"));
    }

    /// A rule that is not there is an error, not a silent no-op: the command's caller shows the
    /// message, and an `Ok(())` for a row that was deleted in another window looks like success.
    #[test]
    fn enabling_a_rule_that_is_not_there_says_so() {
        let store = AutomationStore::new_in_memory();
        assert!(matches!(
            store.set_enabled_checked("au-ghost", true),
            Err(AutomationStoreError::Invalid(_))
        ));
    }

    /// `clear_completed` is *Reset*'s store half. `Ok(false)` for a rule that is not there, and it
    /// touches nothing else on the row.
    #[test]
    fn clear_completed_un_completes_a_rule_and_leaves_the_rest_of_it_alone() {
        let store = AutomationStore::new_in_memory();
        let mut rule = enableable("au-1");
        rule.runs_once = true;
        store.save_rule(&rule).unwrap();
        store.mark_completed("au-1", 5_000).unwrap();
        assert_eq!(store.get_rule("au-1").unwrap().unwrap().completed_at, Some(5_000));

        assert!(store.clear_completed("au-1").unwrap());
        let after = store.get_rule("au-1").unwrap().unwrap();
        assert_eq!(after.completed_at, None);
        assert_eq!(after.runs_once, true, "reset must not un-tick `run once`");
        assert_eq!(after.enabled, rule.enabled);
        assert_eq!(after.updated_at, rule.updated_at, "and it is not an edit");

        assert!(!store.clear_completed("au-ghost").unwrap());
    }

    // =============================================================================================
    // The atomic target add — the context menu's *Add to an existing automation* row
    // =============================================================================================

    /// **A deleted rule is not resurrected.** The whole reason `add_target_to_rule` exists.
    ///
    /// The path it replaces re-resolved the rule id against the renderer's cached list and sent the
    /// whole rule back through `save_rule_as_of`, whose `None` arm INSERTs: window B's delete commits,
    /// window A's cache still holds R, the click saves it, and R is back. A re-read of that cache just
    /// before the click only narrows the window — the delete can commit between the re-read and the
    /// write — so the oracle here is the one no client-side check can satisfy: with the row already
    /// gone, the call writes NOTHING.
    #[test]
    fn adding_a_target_to_a_deleted_rule_writes_nothing_and_says_so() {
        let store = AutomationStore::new_in_memory();
        store.save_rule(&rule("au-1")).unwrap();
        // Another window's delete, already committed.
        assert!(store.delete_rule("au-1").unwrap());

        let added = store.add_target_to_rule("au-1", "tm-9", 9_000).unwrap();

        assert!(!added, "a rule that is gone cannot take a target");
        // `Ok(false)` on its own is satisfied by an implementation that writes the row and then
        // reports failure, which is exactly the resurrection this exists to stop — so the table is
        // asserted too, through both readers, because they read it through different predicates.
        assert!(store.get_rule("au-1").unwrap().is_none(), "the deleted rule came back");
        assert!(store.list_rules().unwrap().is_empty(), "…under the list's own reading of the table");
        assert_eq!(
            store.targets_for("au-1").unwrap(),
            vec![],
            "and no orphan target row keyed to a rule that does not exist"
        );
    }

    /// The append itself: the id lands, and **every other column is left where it was.**
    ///
    /// A whole-struct equality rather than a handful of named fields, because the failure worth
    /// catching is the one nobody thinks to assert: `sort_order` reset to 0. That is the column
    /// `save_rule_as_of` has to rescue from a renderer, and `write_rule`'s `ON CONFLICT DO UPDATE`
    /// overwrites it happily — `rule.sort_order = 0` before the write kills this test.
    ///
    /// `created_at` rides along in the same equality and **cannot fail today**: that same SET list
    /// names every column except `created_at`, so the update path leaves a rule's birthday alone
    /// whatever this method puts in the struct, and `rule.created_at = at` is a mutant this test
    /// survives. It is still asserted rather than assumed, because what makes it safe is a SQL
    /// statement two functions away: the day that SET list gains the column, this is what notices.
    ///
    /// `AutomationRule` is `PartialEq`, so the cheapest oracle available is also the widest.
    #[test]
    fn appending_a_target_adds_the_id_and_touches_nothing_else() {
        let store = AutomationStore::new_in_memory();
        let mut seed = rule("au-1");
        seed.target_ids = vec!["tm-1".into()];
        // Deliberately not the defaults: a write that re-derived either would otherwise land on the
        // value it was supposed to preserve and pass.
        seed.sort_order = 7;
        seed.created_at = 4_000;
        store.save_rule(&seed).unwrap();
        let before = store.get_rule("au-1").unwrap().unwrap();

        assert!(store.add_target_to_rule("au-1", "tm-2", 12_345).unwrap());

        let mut expected = before.clone();
        expected.target_ids.push("tm-2".into());
        // The one column this write authors. `reload` drops a rule's arm keys only when `updated_at`
        // MOVES (Q11), and the set of terminals this rule watches just changed — so it must move.
        expected.updated_at = 12_345;
        assert_eq!(store.get_rule("au-1").unwrap().unwrap(), expected);

        // And the new row is PINNED. `list_rules` reads only pinned rows, so a `matched` one would be
        // dropped from `target_ids` on the next load and the terminal would silently stop being
        // watched — with the rule still showing it in the window that added it.
        assert_eq!(
            store
                .targets_for("au-1")
                .unwrap()
                .into_iter()
                .map(|r| (r.0, r.1))
                .collect::<Vec<_>>(),
            vec![
                ("tm-1".to_string(), "pinned".to_string()),
                ("tm-2".to_string(), "pinned".to_string())
            ]
        );
    }

    /// An id the rule already watches is a no-op — and specifically one that does not move
    /// `updated_at`.
    ///
    /// Both halves matter, and only the first is obvious. `INSERT OR IGNORE` already stops the target
    /// row being duplicated; nothing stops the RULE being re-stamped. `reload` drops a rule's arm keys
    /// whenever `updated_at` moves (Q11), so a version of this method that appended and wrote
    /// unconditionally would silently re-arm a fired rule every time a user picked a menu row that
    /// changed nothing.
    ///
    /// It still answers `Ok(true)`: the rule is there and it watches that terminal, which is what the
    /// click asked for. `Ok(false)` is reserved for *the rule is gone*, and the caller renders it as
    /// exactly that.
    #[test]
    fn adding_a_target_the_rule_already_has_changes_nothing() {
        let store = AutomationStore::new_in_memory();
        let mut seed = rule("au-1");
        seed.target_ids = vec!["tm-1".into(), "tm-2".into()];
        store.save_rule(&seed).unwrap();
        let before = store.get_rule("au-1").unwrap().unwrap();

        assert!(
            store.add_target_to_rule("au-1", "tm-2", 99_000).unwrap(),
            "the rule is still there, and it watches that terminal"
        );

        assert_eq!(
            store.get_rule("au-1").unwrap().unwrap(),
            before,
            "nothing about the rule moved, `updated_at` least of all"
        );
        assert_eq!(
            store.targets_for("au-1").unwrap().iter().filter(|r| r.0 == "tm-2").count(),
            1,
            "and the terminal was not added a second time"
        );
    }

    /// The MIRROR of `adding_a_target_to_a_deleted_rule_writes_nothing_and_says_so`, and it is the
    /// finding this commit exists for: *Forget it* was still the old shape after the append was
    /// fixed, so the identical resurrection was still reachable from the Settings list. Same oracle,
    /// because a client-side re-read cannot satisfy it either — with the row already gone, the call
    /// writes NOTHING.
    #[test]
    fn removing_a_target_from_a_deleted_rule_writes_nothing_and_says_so() {
        let store = AutomationStore::new_in_memory();
        let mut seed = rule("au-1");
        seed.target_ids = vec!["tm-1".into(), "tm-2".into()];
        store.save_rule(&seed).unwrap();
        // Another window's delete, already committed.
        assert!(store.delete_rule("au-1").unwrap());

        let removed = store
            .remove_target_from_rule("au-1", &["tm-2".to_string()], 9_000)
            .unwrap();

        assert!(!removed, "a rule that is gone cannot forget a terminal");
        assert!(store.get_rule("au-1").unwrap().is_none(), "the deleted rule came back");
        assert!(store.list_rules().unwrap().is_empty(), "…under the list's own reading of the table");
        assert_eq!(
            store.targets_for("au-1").unwrap(),
            vec![],
            "and no orphan target row keyed to a rule that does not exist"
        );
    }

    /// The removal itself: the pin goes, **every other column stays**, and `updated_at` moves.
    ///
    /// A whole-struct equality for `appending_a_target_adds_the_id_and_touches_nothing_else`'s
    /// reason — the failure worth catching is `sort_order` reset to 0, which `write_rule`'s
    /// `ON CONFLICT DO UPDATE` would do happily and which no named-field assertion thinks to look at.
    ///
    /// The `targets_for` half is not a restatement of the `target_ids` half: they read different
    /// tables through different predicates, and the way to fail one but not the other is to drop the
    /// id from the rule's list while leaving its `automation_targets` row behind — which the next
    /// `list_rules` would read straight back in, so *Forget it* would appear to work and then undo
    /// itself on the next load.
    #[test]
    fn forgetting_one_pin_drops_it_and_touches_nothing_else() {
        let store = AutomationStore::new_in_memory();
        let mut seed = rule("au-1");
        seed.target_ids = vec!["tm-1".into(), "tm-2".into()];
        // Deliberately not the defaults, so a write that re-derived either would land on the value it
        // was supposed to preserve and pass.
        seed.sort_order = 7;
        seed.created_at = 4_000;
        store.save_rule(&seed).unwrap();
        let before = store.get_rule("au-1").unwrap().unwrap();

        assert!(store
            .remove_target_from_rule("au-1", &["tm-2".to_string()], 12_345)
            .unwrap());

        let mut expected = before.clone();
        expected.target_ids = vec!["tm-1".to_string()];
        // The one column this write authors. The set of terminals this rule watches just changed, and
        // `reload` drops a rule's arm keys only when `updated_at` MOVES (Q11) — the same sentence the
        // append's test makes, in the other direction.
        expected.updated_at = 12_345;
        assert_eq!(store.get_rule("au-1").unwrap().unwrap(), expected);

        assert_eq!(
            store
                .targets_for("au-1")
                .unwrap()
                .into_iter()
                .map(|r| (r.0, r.1))
                .collect::<Vec<_>>(),
            vec![("tm-1".to_string(), "pinned".to_string())],
            "the forgotten row is gone from the table, not just from the rule's list"
        );
    }

    /// An id this rule does not watch is a no-op — and specifically one that does not move
    /// `updated_at`.
    ///
    /// The button's list is `missing ∩ target_ids` computed in a renderer that may be a commit
    /// behind, so naming an id another window already forgot is an ordinary outcome rather than a
    /// bug. Answering `Ok(false)` would tell the user their automation had been deleted; writing
    /// would re-arm the rule for a click that changed nothing.
    #[test]
    fn forgetting_an_id_the_rule_never_watched_changes_nothing() {
        let store = AutomationStore::new_in_memory();
        store.save_rule(&rule("au-1")).unwrap();
        let before = store.get_rule("au-1").unwrap().unwrap();

        assert!(
            store
                .remove_target_from_rule("au-1", &["tm-9".to_string()], 99_000)
                .unwrap(),
            "the rule is still there, and it does not watch that terminal"
        );

        assert_eq!(
            store.get_rule("au-1").unwrap().unwrap(),
            before,
            "nothing about the rule moved, `updated_at` least of all"
        );
    }

    /// Emptying an ENABLED pinned rule's pick set is refused, and the refusal writes nothing.
    ///
    /// This is the one blocking problem a removal can CREATE rather than clear, which is why the gate
    /// is not the near-unreachable formality it is on the append. It is also the behaviour being
    /// preserved: the `save_automation` path this replaces ran the same gate, so a user who could not
    /// forget their last pinned terminal yesterday still cannot today — and is told why rather than
    /// left with an enabled rule watching nothing.
    #[test]
    fn forgetting_the_last_pin_of_an_enabled_rule_is_refused_and_writes_nothing() {
        let store = AutomationStore::new_in_memory();
        store.save_rule(&rule("au-1")).unwrap();
        let before = store.get_rule("au-1").unwrap().unwrap();
        assert_eq!(before.target_ids, vec!["tm-1".to_string()]);

        let err = store
            .remove_target_from_rule("au-1", &["tm-1".to_string()], 50_000)
            .unwrap_err();
        assert!(
            matches!(&err, AutomationStoreError::Invalid(m) if m.contains("at least one terminal")),
            "{err}"
        );

        // The transaction rolled back: the rule is whole, and its target row is still in the table.
        assert_eq!(store.get_rule("au-1").unwrap().unwrap(), before);
        assert_eq!(
            store.targets_for("au-1").unwrap().into_iter().map(|r| r.0).collect::<Vec<_>>(),
            vec!["tm-1".to_string()]
        );
    }

    /// The verbose switch's own copy of the same oracle: with the row already gone, nothing is
    /// written and the call says so.
    #[test]
    fn setting_the_verbose_deadline_on_a_deleted_rule_writes_nothing_and_says_so() {
        let store = AutomationStore::new_in_memory();
        store.save_rule(&rule("au-1")).unwrap();
        assert!(store.delete_rule("au-1").unwrap());

        assert!(!store.set_verbose_until("au-1", Some(60_000)).unwrap());
        assert!(store.get_rule("au-1").unwrap().is_none(), "the deleted rule came back");
        assert!(store.list_rules().unwrap().is_empty());
    }

    /// **The write-through is the feature, not a cache detail.**
    ///
    /// `check_passes_gate` falls back to a `SELECT` only on a cache MISS, so a stale entry is never
    /// re-read — and the arrangement below is the state that makes that fatal rather than
    /// theoretical: the rule's gate has already been consulted once, so `None` is cached, which is
    /// exactly what happens to any rule the engine has evaluated. An implementation that updates the
    /// row and forgets `verbose_cache` goes on dropping every `Check` entry after the switch is on —
    /// verbose visibly enabled, the log staying empty, until a delete, a save or the startup sweep
    /// happens to clear the cache.
    ///
    /// The row assertion is separate on purpose: it is what tells a missing write-through apart from
    /// a missing `UPDATE`, so the two mutants fail on different lines instead of on the same one.
    #[test]
    fn the_verbose_switch_reaches_the_gate_through_the_cache_it_writes() {
        let store = AutomationStore::new_in_memory();
        store.save_rule(&rule("au-1")).unwrap();

        // Seeds `verbose_cache` with the OFF value, the way any evaluated rule seeds it.
        assert!(store.append(&entry("au-1", LogKind::Check, 1_000)).unwrap().is_none());

        assert!(store.set_verbose_until("au-1", Some(60_000)).unwrap());
        assert_eq!(
            store.get_rule("au-1").unwrap().unwrap().verbose_until,
            Some(60_000),
            "the row did not take the deadline"
        );

        assert!(
            store.append(&entry("au-1", LogKind::Check, 3_000)).unwrap().is_some(),
            "the gate is still reading a cached `None` the switch never corrected"
        );
        assert_eq!(
            store
                .load_automation_log(&LogScope::All, LogOrder::Desc, 10)
                .unwrap()
                .iter()
                .map(|e| (e.kind, e.at))
                .collect::<Vec<_>>(),
            vec![(LogKind::Check, 3_000)],
            "identified by its own kind and instant, so no other row can stand in for it"
        );

        // And off again, through the same path — otherwise this test would pass an implementation
        // that hard-coded the cache to "on".
        assert!(store.set_verbose_until("au-1", None).unwrap());
        assert!(store.append(&entry("au-1", LogKind::Check, 5_000)).unwrap().is_none());
    }

    /// **Turning the log's detail up must not re-arm the rule you turned it up to watch.**
    ///
    /// `reload` drops a rule's arm keys whenever `updated_at` moves (Q11), and the path this replaces
    /// — `save_automation`, so `save_rule_as_of` — stamped it on every save. So *Log every check*,
    /// the switch a user reaches for when a rule is not firing, re-armed every pair of that rule as
    /// a side effect: the receipt they were about to read was produced by a different arm state than
    /// the one they were investigating.
    ///
    /// A whole-struct equality rather than an `updated_at` assertion, because it pins the other half
    /// too — this must change the one column and no other, and going through `write_rule` (which
    /// would also rewrite `sort_order` and replace the target rows) is the implementation that looks
    /// most obviously correct.
    #[test]
    fn switching_verbose_on_leaves_the_rest_of_the_rule_where_it_was() {
        let store = AutomationStore::new_in_memory();
        let mut seed = rule("au-1");
        seed.sort_order = 7;
        seed.created_at = 4_000;
        seed.updated_at = 4_500;
        store.save_rule(&seed).unwrap();
        let before = store.get_rule("au-1").unwrap().unwrap();

        assert!(store.set_verbose_until("au-1", Some(60_000)).unwrap());

        let mut expected = before.clone();
        expected.verbose_until = Some(60_000);
        assert_eq!(
            store.get_rule("au-1").unwrap().unwrap(),
            expected,
            "verbose is a logging gate: it changes this column and nothing else, `updated_at` included"
        );
    }

    /// **The row a gate validates must be the row that gate writes.**
    ///
    /// `save_rule_as_of` names this race in its own doc and folds its read into its transaction - and
    /// nothing swept the rest of the file, so `set_enabled_checked` and `duplicate_automation` kept
    /// the `get_rule(...)`-then-write shape. `get_rule` takes and releases its own lock, so another
    /// window fits between the two calls. A save may legally persist a DISABLED rule with an empty
    /// message (the save gate runs only `if rule.enabled`), so an enable that validated the row
    /// before that save lands then sets `enabled = 1` on the row after it; `reload` never re-checks
    /// message content, the rule runs, and `deliver` presses a bare Enter into the terminal - the
    /// R10 outcome the gate exists to prevent.
    ///
    /// **Asserted on the source, because the defect is an interleaving.** The two shapes are
    /// behaviourally identical on any single-threaded run, so a behavioural test cannot tell them
    /// apart, and a threaded one would pin one schedule rather than the property. What is pinned here
    /// is the structural claim the fix actually makes. Both halves are needed: deleting the read
    /// altogether would satisfy the negative on its own.
    ///
    /// `add_target_to_rule` joined the list in the same commit that introduced it rather than waiting
    /// to be swept in later, which is the entire lesson of the two that had to be — and
    /// `remove_target_from_rule` and `set_verbose_until` join it here for the same reason, in the
    /// commit that closes the two sites `add_target_to_rule` alone did not.
    #[test]
    fn every_read_that_decides_a_write_happens_on_that_write_s_own_transaction() {
        let module = crate::automation_engine::test_host::strip_comments(include_str!(
            "automation_store.rs"
        ));
        // The test MODULE, not the first `#[cfg(test)]` - `new_in_memory` carries one hundreds of
        // lines above these functions, and truncating there left `code` holding neither of them while
        // the test still reported success on two `assert!`s it never reached.
        let code = &module[..module
            .find("#[cfg(test)]\nmod tests")
            .expect("the test module must follow the code")];

        let mut checked = 0;
        // Every method that reads a rule in order to decide what to write about it. The last three
        // are the ones whose whole point IS the conditional: an `Ok(false)` arm is only a promise
        // that nothing was written while the read and the write share a transaction. All three of
        // those are one gesture from a Settings list or a context menu that may be a commit behind,
        // so all three are one delete away from resurrecting the rule they were called about.
        for name in [
            "set_enabled_checked",
            "duplicate_automation",
            "add_target_to_rule",
            "remove_target_from_rule",
            "set_verbose_until",
        ] {
            let start = code
                .find(&format!("fn {}(", name))
                .unwrap_or_else(|| panic!("`{}` moved; this test was checking nothing", name));
            let rest = &code[start + 4..];
            let end = rest.find("\n    pub fn ").unwrap_or(rest.len());
            let body = &rest[..end];
            assert!(
                !body.contains("self.get_rule("),
                "`{}` decides from a `get_rule` that takes its own lock: the row it validates is not \
                 guaranteed to be the row it writes",
                name
            );
            assert!(
                body.contains("read_rule_on(&tx"),
                "`{}` no longer reads on its own transaction",
                name
            );
            checked += 1;
        }
        assert_eq!(checked, 5, "every call site of the class must be checked");
    }

    #[test]
    fn one_undecodable_row_is_skipped_and_the_rest_of_the_list_survives() {
        let store = AutomationStore::new_in_memory();
        // Two good rules either side of one whose graph blob names a variant this
        // build does not know. That is exactly what an older build sees when it
        // reads a v2 rule (spec §3.3): serde has no #[serde(other)] anywhere, so
        // an unknown ENUM VARIANT fails the decode.
        store.save_rule(&rule_named("first")).unwrap();
        store.save_rule(&rule_named("third")).unwrap();
        write_raw_graph(&store, "au-bad", r#"{"monitor":{"read":"fromTheFuture","cadence":"onOutput","everyMs":0}}"#);

        let rules = store.list_rules().expect("a bad row must not fail the read");

        let names: Vec<&str> = rules.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["first", "third"], "the good rules must survive");

        let skipped = store.take_skipped_rows();
        assert_eq!(skipped.len(), 1, "the skip must be reported, not silent");
        assert_eq!(skipped[0].0, "au-bad");
        assert!(
            skipped[0].1.contains("newer version"),
            "the reason must be the user-facing one reload() already uses, got: {}",
            skipped[0].1
        );
    }

    #[test]
    fn a_skipped_row_is_reported_once_per_read_not_once_per_row_scanned() {
        let store = AutomationStore::new_in_memory();
        write_raw_graph(&store, "au-bad", r#"{"monitor":{"read":"fromTheFuture","cadence":"onOutput","everyMs":0}}"#);
        store.list_rules().unwrap();
        assert_eq!(store.take_skipped_rows().len(), 1);
        assert_eq!(
            store.take_skipped_rows().len(),
            0,
            "draining must clear — otherwise every reload re-logs the same row forever"
        );
    }
}
