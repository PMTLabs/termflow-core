use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Mutex;

use dashmap::DashMap;
use rusqlite::Connection;

use super::model::*;

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

const EXCLUDED_TARGET_IDS_SQL: &str = "SELECT terminal_id FROM automation_exclusions \
     WHERE rule_id = ?1 ORDER BY added_at, terminal_id";

const RULE_COLUMNS: &str ="id, name, enabled, runs_once, target_mode, criterion, criterion_value, \
     exclude_criterion, exclude_criterion_value, follow_new, completed_at, verbose_until, sort_order, \
     schema_version, graph, created_at, updated_at";

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
    exclude_criterion: Option<String>,
    exclude_criterion_value: Option<String>,
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
        exclude_criterion: r.get(7)?,
        exclude_criterion_value: r.get(8)?,
        follow_new: r.get(9)?,
        completed_at: r.get(10)?,
        verbose_until: r.get(11)?,
        sort_order: r.get(12)?,
        schema_version: r.get(13)?,
        graph: r.get(14)?,
        created_at: r.get(15)?,
        updated_at: r.get(16)?,
    })
}

fn hydrate_rule(raw: RawRule) -> Result<AutomationRule, AutomationStoreError> {
    Ok(AutomationRule {
        // Serde can quote the malformed value in its error, and a graph contains the webhook URL.
        // Keep the decode boundary opaque: list_rules turns this into a skipped-row reason and
        // reload persists that reason to the activity log.
        graph: serde_json::from_str(&raw.graph)
            .map_err(|_| AutomationStoreError::Invalid(format!("rule {}: bad graph blob", raw.id)))?,
        target_mode: enum_from_db(&raw.target_mode)?,
        criterion: enum_from_db(&raw.criterion)?,
        exclude_criterion: raw.exclude_criterion.as_deref().map(enum_from_db).transpose()?,
        id: raw.id,
        name: raw.name,
        enabled: raw.enabled,
        runs_once: raw.runs_once,
        criterion_value: raw.criterion_value,
        follow_new: raw.follow_new,
        target_ids: Vec::new(),
        excluded_ids: Vec::new(),
        exclude_criterion_value: raw.exclude_criterion_value.unwrap_or_default(),
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

    /// Insert a graph which could only have arrived from an older or corrupt store.
    ///
    /// This bypasses serialisation deliberately: tests need the real decode path to see whether a
    /// malformed value reaches a user-facing skipped-row reason.
    #[cfg(test)]
    pub(crate) fn insert_raw_graph_for_test(&self, id: &str, graph: &str) {
        let guard = self.conn.lock().unwrap();
        let conn = guard.as_ref().expect("in-memory store is connected");
        conn.execute(
            "INSERT INTO automation_rules
               (id, name, enabled, runs_once, target_mode, criterion, criterion_value,
                follow_new, completed_at, verbose_until, sort_order, schema_version,
                graph, created_at, updated_at)
             VALUES (?1, 'bad', 1, 0, 'rule', 'allTerminals', '', 1, NULL, NULL, 2, 1, ?2, 1000, 1000)",
            rusqlite::params![id, graph],
        )
        .expect("insert raw graph");
    }

    pub(super) fn schema(conn: &Connection) -> rusqlite::Result<()> {
        conn.execute(
            "CREATE TABLE IF NOT EXISTS automation_rules (
                id              TEXT PRIMARY KEY,
                name            TEXT NOT NULL,
                enabled         INTEGER NOT NULL,
                runs_once       INTEGER NOT NULL,
                target_mode     TEXT NOT NULL,
                criterion       TEXT NOT NULL,
                criterion_value TEXT NOT NULL,
                exclude_criterion TEXT,
                exclude_criterion_value TEXT,
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
        conn.execute(
            "CREATE TABLE IF NOT EXISTS automation_exclusions (
                rule_id     TEXT NOT NULL,
                terminal_id TEXT NOT NULL,
                added_at    INTEGER NOT NULL,
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
        Self::ensure_column(conn, "automation_rules", "exclude_criterion", "TEXT")?;
        Self::ensure_column(conn, "automation_rules", "exclude_criterion_value", "TEXT")?;
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

        let mut exclusions: HashMap<String, Vec<String>> = HashMap::new();
        {
            let mut stmt = conn.prepare(
                "SELECT rule_id, terminal_id FROM automation_exclusions ORDER BY added_at, terminal_id",
            )?;
            let rows =
                stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            for row in rows {
                let (rule_id, terminal_id) = row?;
                exclusions.entry(rule_id).or_default().push(terminal_id);
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
                    rule.excluded_ids = exclusions.remove(&rule.id).unwrap_or_default();
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
    pub(super) fn read_rule_on(
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
                let mut stmt = conn.prepare(EXCLUDED_TARGET_IDS_SQL)?;
                let rows = stmt.query_map([id], |r| r.get::<_, String>(0))?;
                let mut ids = Vec::new();
                for row in rows {
                    ids.push(row?);
                }
                rule.excluded_ids = ids;
                Ok(Some(rule))
            }
        }
    }
}

mod methods;

#[cfg(test)]
mod tests;
