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
    emit: Mutex<EmitState>,
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
            emit: Mutex::new(EmitState::default()),
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
            let mut rule = hydrate_rule(raw?)?;
            rule.target_ids = targets.remove(&rule.id).unwrap_or_default();
            out.push(rule);
        }
        Ok(out)
    }

    pub fn get_rule(&self, id: &str) -> Result<Option<AutomationRule>, AutomationStoreError> {
        let guard = self.conn.lock().unwrap();
        let conn = guard.as_ref().ok_or(AutomationStoreError::Disabled)?;
        let raw = optional_row(conn.query_row(
            &format!("SELECT {RULE_COLUMNS} FROM automation_rules WHERE id = ?1"),
            [id],
            read_rule_row,
        ))?;
        match raw {
            None => Ok(None),
            Some(raw) => {
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
    pub fn save_rule(&self, rule: &AutomationRule) -> Result<Option<i64>, AutomationStoreError> {
        let mut guard = self.conn.lock().unwrap();
        let conn = guard.as_mut().ok_or(AutomationStoreError::Disabled)?;
        let tx = conn.transaction()?;
        let previous = Self::write_rule(&tx, rule)?;
        tx.commit()?;
        drop(guard);
        // Write through rather than invalidate: the new value is right here, and a rule saved with
        // verbose just switched on must not wait for a cache miss to start logging.
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
        Ok(n > 0)
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

    /// Copy a rule to a fresh id, directly beneath the original. R12 — Tam's first request.
    ///
    /// Deliberately not a bare clone-with-a-new-id: an enabled duplicate starts firing the moment it
    /// is created, and a copied `completed_at` makes it Completed before it has ever run.
    pub fn duplicate_automation(
        &self,
        id: &str,
        at: i64,
    ) -> Result<AutomationRule, AutomationStoreError> {
        let original = self
            .get_rule(id)?
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

        let mut guard = self.conn.lock().unwrap();
        let conn = guard.as_mut().ok_or(AutomationStoreError::Disabled)?;
        let tx = conn.transaction()?;

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
            return Ok(());
        };

        // `None` means "I have no new value for this", never "clear the stored one". `label_at`
        // returns `None` once a terminal is gone, and that is exactly when the snapshot has to
        // survive — clearing it there empties the picker's "not open" row of the label it exists to
        // draw, which is the one case §7.6 was written for.
        let label = label.or(old_label.as_deref());
        let folder = folder.or(old_folder.as_deref());

        if old_label.as_deref() != label || old_folder.as_deref() != folder {
            conn.execute(
                "UPDATE automation_targets
                    SET label = ?3, folder = ?4, label_at = ?5, last_seen_at = ?5
                  WHERE rule_id = ?1 AND terminal_id = ?2",
                rusqlite::params![rule_id, terminal_id, label, folder, at],
            )?;
        } else if at - last_seen.unwrap_or(0) >= LAST_SEEN_THROTTLE_MS {
            conn.execute(
                "UPDATE automation_targets SET last_seen_at = ?3
                  WHERE rule_id = ?1 AND terminal_id = ?2",
                rusqlite::params![rule_id, terminal_id, at],
            )?;
        }
        Ok(())
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
            target_ids: vec![],
            completed_at: None,
            verbose_until: None,
            sort_order: 1,
            schema_version: SUPPORTED_SCHEMA_VERSION,
            graph: graph(),
            created_at: 1_000,
            updated_at: 1_000,
        }
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
        let row = |s: &AutomationStore| s.targets_for("au-1").unwrap().into_iter().next().unwrap();
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

    /// `None` means "no new value", never "clear the stored one". `label_at` returns `None` once a
    /// terminal is gone — exactly when the picker's "not open" row needs the snapshot most.
    #[test]
    fn touch_target_never_clears_a_stored_label_with_none() {
        let store = AutomationStore::new_in_memory();
        store.save_rule(&rule("au-1")).unwrap();
        store.touch_target("au-1", "tm-m", Some("codex"), Some("D:/a"), 1_000).unwrap();

        // The terminal closed: the resolver has no label to offer any more.
        store.touch_target("au-1", "tm-m", None, None, 2_000).unwrap();

        let row = store.targets_for("au-1").unwrap().into_iter().next().unwrap();
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
}
