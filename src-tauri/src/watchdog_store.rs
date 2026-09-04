//! Persistence for Terminal Watchdog Workflows — rules, their pinned terminals, and the activity log.
//!
//! Not to be confused with `spawn_pipeline_watchdog` in `lib.rs`, which watches the OUTPUT PIPELINE
//! for a stalled consumer. This module is the user-facing "Watchdogs" feature: rules that watch what
//! a terminal prints and type into it. Plan `028`.
//!
//! Modelled line for line on `canvas_store.rs`: its **own** `rusqlite::Connection` to the same
//! per-profile `history.db`, its own `CREATE TABLE IF NOT EXISTS`, degrade-to-inert on open failure,
//! and `Result` on every method. Its own connection matters — watchdog writes then contend with
//! watchdog writes, not with the 30 s scrollback flush that holds `HistoryStore`'s mutex while it
//! writes multi-MB blobs.
//!
//! It deliberately holds **no `AppHandle`**. `append` decides whether a `watchdog:activity` event is
//! due and says so in its return value; the caller — the engine or the command layer, both of which
//! already have a handle — performs the emit. An `AppHandle<R>` field here would make the whole struct
//! generic over the Tauri runtime and drag its unit tests behind `--features integration-tests`, which
//! is Linux-only (`Cargo.toml`). Plan §7.5, §7.10.
//!
//! **M0 (contracts) landed the types below. The store itself lands in M1.**

use std::sync::Mutex;

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
/// see the module-level note on `WatchdogRule`.
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

/// The four steps, stored whole as a JSON blob in `watchdog_rules.graph`.
///
/// Blob rather than normalised because it is never queried and never written at a different cadence
/// from the rest of the rule: read and written whole by exactly two consumers (the editor and the
/// evaluator), and nobody asks "which rules compare against > 25". Normalising four fixed steps buys a
/// join per load plus a schema change every time a step gains a field, in a crate with no migration
/// machinery at all. Plan §3.1.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchdogGraph {
    pub monitor: MonitorStep,
    pub parse: ParseStep,
    pub cond: CondStep,
    pub action: ActionStep,
}

/// One rule, as it crosses the wire and as it sits in `watchdog_rules`.
///
/// **Targeting is columns, not blob.** `target_mode`, `criterion`, `criterion_value` and `follow_new`
/// are queried, and `touch_target` writes the targets table on a completely different cadence from
/// user edits — in the blob, every label refresh would become a read-modify-write of the whole rule,
/// and a touch landing between a window's load and its save would either clobber the user or be
/// clobbered by them. `target_ids` is filled from `watchdog_targets` on read and replaced wholesale by
/// `save_rule`. Plan §3.1, §7.7.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchdogRule {
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

    pub graph: WatchdogGraph,
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
pub struct WatchdogLogEntry {
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
/// one `watchdog:activity` per second at most — so the rate limit cannot be re-implemented per caller.
/// Plan §7.5.
#[derive(Debug, Clone, PartialEq)]
pub struct AppendOutcome {
    pub entry_id: i64,
    /// The caller emits `watchdog:activity` when this is true, and does nothing when it is false.
    pub emit: bool,
    pub rule_ids: Vec<String>,
}

/// Which rows `load_watchdog_log` returns and in what order.
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
pub enum WatchdogStoreError {
    /// The DB could not be opened at startup, so the store is inert.
    Disabled,
    Sqlite(rusqlite::Error),
    /// The `graph` blob failed to parse, or a rule was rejected by validation on the enable path.
    Invalid(String),
}

impl std::fmt::Display for WatchdogStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Disabled => write!(f, "watchdog store is disabled"),
            Self::Sqlite(e) => write!(f, "watchdog store sqlite error: {e}"),
            Self::Invalid(m) => write!(f, "watchdog store rejected the value: {m}"),
        }
    }
}

impl std::error::Error for WatchdogStoreError {}

impl From<rusqlite::Error> for WatchdogStoreError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Sqlite(e)
    }
}

/// Rules, their pinned terminals and the activity log, stored beside scrollback in `history.db`.
///
/// **M1 fills this in.** M0 lands only the shape, so no area discovers it later.
pub struct WatchdogStore {
    #[allow(dead_code)] // M1 opens it; M0 only claims the field.
    conn: Mutex<Option<Connection>>,
}

impl Default for WatchdogStore {
    fn default() -> Self {
        Self::new()
    }
}

impl WatchdogStore {
    /// A disabled store. `init` upgrades it in place, exactly as `CanvasStore::new` does.
    pub fn new() -> Self {
        Self {
            conn: Mutex::new(None),
        }
    }
}
