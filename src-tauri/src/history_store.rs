use rusqlite::Connection;
use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;

/// One (command, directory) usage row for cwd-relevant suggestion ranking (Stream 4).
/// Serialized to the renderer, which computes affinity (exact vs ancestor vs
/// descendant of the current cwd) from `dir`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirUsageRow {
    pub command: String,
    pub dir: String,
    pub use_count: i64,
    pub last_used_at: i64,
}

/// Escape SQLite LIKE metacharacters (`\`, `%`, `_`) so a directory path containing
/// them (e.g. `my_proj`) is matched literally, not as a wildcard. Pair with `ESCAPE '\'`.
fn escape_like(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 4);
    for c in s.chars() {
        if c == '\\' || c == '%' || c == '_' {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// All ancestor directories of a normalized (forward-slash) path, nearest first,
/// excluding the path itself. `c:/proj/a` → [`c:/proj`, `c:`].
fn ancestor_dirs(dir: &str) -> Vec<String> {
    let mut res = Vec::new();
    let mut cur = dir.trim_end_matches('/');
    while let Some(idx) = cur.rfind('/') {
        let parent = &cur[..idx];
        if parent.is_empty() {
            break;
        }
        res.push(parent.to_string());
        cur = parent;
    }
    res
}

/// SQLite-backed per-terminal scrollback store, keyed by the STABLE renderer id
/// (`tab_id` — `tb-`/`tm-`) which survives an app restart, unlike the processId.
/// Degrades to a silent no-op if the DB can't be opened, so persistence failures
/// never crash or block the app.
pub struct HistoryStore {
    conn: Mutex<Option<Connection>>,
}

impl Default for HistoryStore {
    fn default() -> Self {
        Self::new()
    }
}

impl HistoryStore {
    /// A disabled store (no DB connection). `init` upgrades it in place.
    pub fn new() -> Self {
        Self { conn: Mutex::new(None) }
    }

    /// Open (or create) the SQLite file at `path` and ensure the schema exists.
    /// Call once at startup. On any failure the store stays disabled.
    pub fn init(&self, path: &Path) {
        let mut guard = self.conn.lock().unwrap();
        // Guard the documented "call once" contract: a second init would silently
        // swap the live connection for a new one.
        if guard.is_some() {
            log::warn!("[HISTORY] init called more than once — ignoring");
            return;
        }
        match Self::open(path) {
            Ok(conn) => {
                *guard = Some(conn);
                log::info!("[HISTORY] store initialized at {}", path.display());
            }
            Err(e) => log::warn!("[HISTORY] store disabled (open failed): {}", e),
        }
    }

    fn open(path: &Path) -> rusqlite::Result<Connection> {
        let conn = Connection::open(path)?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS terminal_history (
                renderer_id TEXT PRIMARY KEY,
                data        TEXT NOT NULL,
                updated_at  INTEGER NOT NULL
            )",
            [],
        )?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS command_history (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                command      TEXT NOT NULL UNIQUE,
                use_count    INTEGER NOT NULL DEFAULT 1,
                last_used_at INTEGER NOT NULL
            )",
            [],
        )?;
        // Stream 4: per-directory command usage for cwd-relevant suggestion ranking.
        // Keyed by (command, dir); `command_history` above stays the global fallback.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS command_dir_usage (
                command      TEXT NOT NULL,
                dir          TEXT NOT NULL,
                use_count    INTEGER NOT NULL DEFAULT 1,
                last_used_at INTEGER NOT NULL,
                PRIMARY KEY (command, dir)
            )",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_cdu_dir ON command_dir_usage(dir)",
            [],
        )?;
        Ok(conn)
    }

    /// Upsert one terminal's scrollback (chunks serialized as a JSON array).
    pub fn upsert(&self, renderer_id: &str, chunks: &[String], updated_at: i64) {
        let guard = self.conn.lock().unwrap();
        let Some(conn) = guard.as_ref() else { return };
        let data = match serde_json::to_string(chunks) {
            Ok(d) => d,
            Err(e) => {
                log::warn!("[HISTORY] serialize failed for {}: {}", renderer_id, e);
                return;
            }
        };
        if let Err(e) = conn.execute(
            "INSERT INTO terminal_history (renderer_id, data, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(renderer_id) DO UPDATE SET data = ?2, updated_at = ?3",
            rusqlite::params![renderer_id, data, updated_at],
        ) {
            log::warn!("[HISTORY] upsert failed for {}: {}", renderer_id, e);
        }
    }

    /// Read one terminal's scrollback chunks, or None if absent/disabled/corrupt.
    pub fn get(&self, renderer_id: &str) -> Option<Vec<String>> {
        let guard = self.conn.lock().unwrap();
        let conn = guard.as_ref()?;
        let data: String = conn
            .query_row(
                "SELECT data FROM terminal_history WHERE renderer_id = ?1",
                rusqlite::params![renderer_id],
                |row| row.get(0),
            )
            .ok()?;
        serde_json::from_str(&data).ok()
    }

    /// Delete one terminal's row (explicit user close).
    pub fn delete(&self, renderer_id: &str) {
        let guard = self.conn.lock().unwrap();
        let Some(conn) = guard.as_ref() else { return };
        if let Err(e) = conn.execute(
            "DELETE FROM terminal_history WHERE renderer_id = ?1",
            rusqlite::params![renderer_id],
        ) {
            log::warn!("[HISTORY] delete failed for {}: {}", renderer_id, e);
        }
    }

    /// Delete every row whose renderer_id is NOT in `keep` (startup orphan sweep).
    pub fn prune(&self, keep: &HashSet<String>) {
        let guard = self.conn.lock().unwrap();
        let Some(conn) = guard.as_ref() else { return };
        // Single atomic DELETE rather than select-then-delete-per-row: no partial
        // state if it fails, and one round-trip. rusqlite has no array binding, so
        // build one positional placeholder per kept id.
        let result = if keep.is_empty() {
            conn.execute("DELETE FROM terminal_history", [])
        } else {
            let placeholders: String = (1..=keep.len())
                .map(|i| format!("?{}", i))
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!(
                "DELETE FROM terminal_history WHERE renderer_id NOT IN ({})",
                placeholders
            );
            let params: Vec<&dyn rusqlite::ToSql> =
                keep.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
            conn.execute(&sql, params.as_slice())
        };
        if let Err(e) = result {
            log::warn!("[HISTORY] prune failed: {}", e);
        }
    }

    /// Record one submitted command (backlog 011). UNIQUE on the text: re-running
    /// a command bumps use_count and freshness instead of inserting a duplicate.
    pub fn add_command(&self, command: &str, now_ms: i64) {
        let guard = self.conn.lock().unwrap();
        let Some(conn) = guard.as_ref() else { return };
        if let Err(e) = conn.execute(
            "INSERT INTO command_history (command, use_count, last_used_at)
             VALUES (?1, 1, ?2)
             ON CONFLICT(command) DO UPDATE SET use_count = use_count + 1, last_used_at = ?2",
            rusqlite::params![command, now_ms],
        ) {
            log::warn!("[HISTORY] add_command failed: {}", e);
        }
    }

    /// Most-recent-first command list for the renderer's in-memory match index.
    pub fn load_commands(&self, limit: u32) -> Vec<String> {
        let guard = self.conn.lock().unwrap();
        let Some(conn) = guard.as_ref() else { return Vec::new() };
        let mut stmt = match conn.prepare(
            "SELECT command FROM command_history ORDER BY last_used_at DESC, id DESC LIMIT ?1",
        ) {
            Ok(s) => s,
            Err(e) => {
                log::warn!("[HISTORY] load_commands prepare failed: {}", e);
                return Vec::new();
            }
        };
        let commands = match stmt.query_map(rusqlite::params![limit as i64], |row| row.get::<_, String>(0)) {
            Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
            Err(e) => {
                log::warn!("[HISTORY] load_commands failed: {}", e);
                Vec::new()
            }
        };
        commands
    }

    /// Remove one command from the history (user pressed Shift+Delete on a
    /// suggestion). Exact-text match; a miss is a no-op. Cascades to the per-directory
    /// usage table so a deleted command can't linger as a cwd-affinity ghost.
    pub fn delete_command(&self, command: &str) {
        let guard = self.conn.lock().unwrap();
        let Some(conn) = guard.as_ref() else { return };
        if let Err(e) = conn.execute(
            "DELETE FROM command_history WHERE command = ?1",
            rusqlite::params![command],
        ) {
            log::warn!("[HISTORY] delete_command failed: {}", e);
        }
        if let Err(e) = conn.execute(
            "DELETE FROM command_dir_usage WHERE command = ?1",
            rusqlite::params![command],
        ) {
            log::warn!("[HISTORY] delete_command dir-usage cascade failed: {}", e);
        }
    }

    /// Record that `command` was run in `dir` (Stream 4). `dir` must be normalized by
    /// the caller (forward-slash; lowercased on Windows). Upsert on (command, dir):
    /// re-running bumps use_count + freshness. Silent no-op when disabled/on error.
    pub fn add_command_dir(&self, command: &str, dir: &str, now_ms: i64) {
        if dir.is_empty() {
            return;
        }
        let guard = self.conn.lock().unwrap();
        let Some(conn) = guard.as_ref() else { return };
        if let Err(e) = conn.execute(
            "INSERT INTO command_dir_usage (command, dir, use_count, last_used_at)
             VALUES (?1, ?2, 1, ?3)
             ON CONFLICT(command, dir) DO UPDATE SET use_count = use_count + 1, last_used_at = ?3",
            rusqlite::params![command, dir, now_ms],
        ) {
            log::warn!("[HISTORY] add_command_dir failed: {}", e);
        }
    }

    /// Load usage rows relevant to `cwd`: the exact directory, its ancestors, and its
    /// descendants (so a command run in a parent or child dir can still rank above
    /// unrelated global history). The renderer computes the final affinity weight from
    /// each row's `dir`. Empty when disabled or cwd is empty.
    pub fn load_dir_usage(&self, cwd: &str) -> Vec<DirUsageRow> {
        if cwd.is_empty() {
            return Vec::new();
        }
        let guard = self.conn.lock().unwrap();
        let Some(conn) = guard.as_ref() else { return Vec::new() };
        // Exact + ancestors as an exact IN list (no wildcard risk); descendants via an
        // escaped LIKE `cwd/%` so path metacharacters (`_`) aren't treated as wildcards.
        let mut in_list: Vec<String> = vec![cwd.to_string()];
        in_list.extend(ancestor_dirs(cwd));
        let placeholders: String = (1..=in_list.len())
            .map(|i| format!("?{}", i))
            .collect::<Vec<_>>()
            .join(",");
        let like_idx = in_list.len() + 1;
        let sql = format!(
            "SELECT command, dir, use_count, last_used_at FROM command_dir_usage
             WHERE dir IN ({}) OR dir LIKE ?{} ESCAPE '\\'
             ORDER BY last_used_at DESC LIMIT 500",
            placeholders, like_idx
        );
        let like_pattern = format!("{}/%", escape_like(cwd));
        let mut params: Vec<&dyn rusqlite::ToSql> =
            in_list.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
        params.push(&like_pattern);
        let mut stmt = match conn.prepare(&sql) {
            Ok(s) => s,
            Err(e) => {
                log::warn!("[HISTORY] load_dir_usage prepare failed: {}", e);
                return Vec::new();
            }
        };
        let rows = match stmt.query_map(params.as_slice(), |row| {
            Ok(DirUsageRow {
                command: row.get(0)?,
                dir: row.get(1)?,
                use_count: row.get(2)?,
                last_used_at: row.get(3)?,
            })
        }) {
            Ok(mapped) => mapped.filter_map(|r| r.ok()).collect(),
            Err(e) => {
                log::warn!("[HISTORY] load_dir_usage failed: {}", e);
                Vec::new()
            }
        };
        rows
    }

    /// Remove all per-directory usage rows for a command (used by the delete cascade;
    /// exposed for completeness/testing).
    pub fn delete_command_dir(&self, command: &str) {
        let guard = self.conn.lock().unwrap();
        let Some(conn) = guard.as_ref() else { return };
        if let Err(e) = conn.execute(
            "DELETE FROM command_dir_usage WHERE command = ?1",
            rusqlite::params![command],
        ) {
            log::warn!("[HISTORY] delete_command_dir failed: {}", e);
        }
    }

    /// Keep only the newest `keep` per-directory usage rows (startup cap). The
    /// (command, dir) cardinality can far exceed the global command count, so this has
    /// its own, larger cap.
    pub fn prune_dir_usage(&self, keep: u32) {
        let guard = self.conn.lock().unwrap();
        let Some(conn) = guard.as_ref() else { return };
        if let Err(e) = conn.execute(
            "DELETE FROM command_dir_usage WHERE rowid NOT IN (
                SELECT rowid FROM command_dir_usage ORDER BY last_used_at DESC LIMIT ?1
             )",
            rusqlite::params![keep as i64],
        ) {
            log::warn!("[HISTORY] prune_dir_usage failed: {}", e);
        }
    }

    /// Keep only the newest `keep` commands (startup cap, mirrors terminal prune).
    pub fn prune_commands(&self, keep: u32) {
        let guard = self.conn.lock().unwrap();
        let Some(conn) = guard.as_ref() else { return };
        if let Err(e) = conn.execute(
            "DELETE FROM command_history WHERE id NOT IN (
                SELECT id FROM command_history ORDER BY last_used_at DESC, id DESC LIMIT ?1
             )",
            rusqlite::params![keep as i64],
        ) {
            log::warn!("[HISTORY] prune_commands failed: {}", e);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let mut p = std::env::temp_dir();
        // Date/rand-free uniqueness (those are unavailable in some harnesses).
        p.push(format!(
            "autoterm_hist_{}_{}.db",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_file(&p);
        p
    }

    #[test]
    fn upsert_and_get_roundtrip() {
        let store = HistoryStore::new();
        store.init(&temp_db());
        store.upsert("tb-1", &["hello ".into(), "world".into()], 1);
        assert_eq!(store.get("tb-1"), Some(vec!["hello ".into(), "world".into()]));
    }

    #[test]
    fn upsert_overwrites_existing() {
        let store = HistoryStore::new();
        store.init(&temp_db());
        store.upsert("tb-1", &["a".into()], 1);
        store.upsert("tb-1", &["b".into()], 2);
        assert_eq!(store.get("tb-1"), Some(vec!["b".into()]));
    }

    #[test]
    fn get_missing_is_none() {
        let store = HistoryStore::new();
        store.init(&temp_db());
        assert_eq!(store.get("nope"), None);
    }

    #[test]
    fn delete_removes_row() {
        let store = HistoryStore::new();
        store.init(&temp_db());
        store.upsert("tb-1", &["x".into()], 1);
        store.delete("tb-1");
        assert_eq!(store.get("tb-1"), None);
    }

    #[test]
    fn prune_keeps_only_listed() {
        let store = HistoryStore::new();
        store.init(&temp_db());
        store.upsert("keep-1", &["a".into()], 1);
        store.upsert("drop-1", &["b".into()], 1);
        store.upsert("keep-2", &["c".into()], 1);
        let keep: HashSet<String> = ["keep-1".into(), "keep-2".into()].into_iter().collect();
        store.prune(&keep);
        assert!(store.get("keep-1").is_some());
        assert!(store.get("keep-2").is_some());
        assert_eq!(store.get("drop-1"), None);
    }

    #[test]
    fn disabled_store_is_noop() {
        let store = HistoryStore::new(); // never init'd
        store.upsert("tb-1", &["a".into()], 1);
        assert_eq!(store.get("tb-1"), None); // no panic, no data
    }

    // --- Backlog 011: command_history ---

    #[test]
    fn add_and_load_commands_most_recent_first() {
        let store = HistoryStore::new();
        store.init(&temp_db());
        store.add_command("git status", 1);
        store.add_command("dotnet build", 2);
        store.add_command("bun run test", 3);
        assert_eq!(
            store.load_commands(10),
            vec!["bun run test".to_string(), "dotnet build".to_string(), "git status".to_string()]
        );
    }

    #[test]
    fn duplicate_command_bumps_recency_not_rows() {
        let store = HistoryStore::new();
        store.init(&temp_db());
        store.add_command("git status", 1);
        store.add_command("dotnet build", 2);
        store.add_command("git status", 3); // re-run: moves to front, no duplicate
        assert_eq!(
            store.load_commands(10),
            vec!["git status".to_string(), "dotnet build".to_string()]
        );
    }

    #[test]
    fn load_commands_respects_limit() {
        let store = HistoryStore::new();
        store.init(&temp_db());
        store.add_command("a", 1);
        store.add_command("b", 2);
        store.add_command("c", 3);
        assert_eq!(store.load_commands(2), vec!["c".to_string(), "b".to_string()]);
    }

    #[test]
    fn delete_command_removes_exact_match_only() {
        let store = HistoryStore::new();
        store.init(&temp_db());
        store.add_command("git status", 1);
        store.add_command("git status --short", 2);
        store.delete_command("git status");
        assert_eq!(store.load_commands(10), vec!["git status --short".to_string()]);
        store.delete_command("not-in-history"); // miss is a no-op
        assert_eq!(store.load_commands(10), vec!["git status --short".to_string()]);
    }

    #[test]
    fn prune_commands_keeps_newest() {
        let store = HistoryStore::new();
        store.init(&temp_db());
        store.add_command("old", 1);
        store.add_command("mid", 2);
        store.add_command("new", 3);
        store.prune_commands(2);
        assert_eq!(store.load_commands(10), vec!["new".to_string(), "mid".to_string()]);
    }

    #[test]
    fn disabled_store_commands_are_noop() {
        let store = HistoryStore::new(); // never init'd
        store.add_command("x", 1);
        assert!(store.load_commands(10).is_empty()); // no panic
        store.prune_commands(1); // no panic
    }

    // --- Stream 4: command_dir_usage (cwd-relevant ranking) ---

    #[test]
    fn dir_usage_upsert_load_prefixes_and_delete() {
        let store = HistoryStore::new();
        store.init(&temp_db());
        store.add_command_dir("cargo build", "c:/proj/a", 100);
        store.add_command_dir("cargo build", "c:/proj/a", 200); // upsert → use_count 2
        store.add_command_dir("ls", "c:/proj/a/sub", 150);      // descendant of cwd
        store.add_command_dir("git log", "c:/proj", 120);       // ancestor of cwd
        store.add_command_dir("who", "c:/other", 300);          // unrelated

        let rows = store.load_dir_usage("c:/proj/a");
        let cmds: Vec<String> = rows.iter().map(|r| r.command.clone()).collect();
        assert!(cmds.contains(&"cargo build".to_string()), "exact-dir cmd present");
        assert!(cmds.contains(&"ls".to_string()), "descendant-dir cmd present");
        assert!(cmds.contains(&"git log".to_string()), "ancestor-dir cmd present");
        assert!(!cmds.contains(&"who".to_string()), "unrelated dir excluded");

        let cb = rows.iter().find(|r| r.command == "cargo build").unwrap();
        assert_eq!(cb.use_count, 2, "upsert bumped use_count");
        assert_eq!(cb.dir, "c:/proj/a");

        store.delete_command_dir("cargo build");
        let after = store.load_dir_usage("c:/proj/a");
        assert!(!after.iter().any(|r| r.command == "cargo build"), "delete removed rows");
    }

    #[test]
    fn dir_usage_like_underscore_not_treated_as_wildcard() {
        let store = HistoryStore::new();
        store.init(&temp_db());
        // cwd contains '_'; a sibling dir differing only where the '_' is must NOT be
        // matched as a descendant (an unescaped LIKE '_' wildcard would wrongly match).
        store.add_command_dir("real", "c:/my_proj/sub", 10);  // true descendant
        store.add_command_dir("bogus", "c:/myxproj/sub", 20); // NOT under c:/my_proj
        let rows = store.load_dir_usage("c:/my_proj");
        let cmds: Vec<String> = rows.iter().map(|r| r.command.clone()).collect();
        assert!(cmds.contains(&"real".to_string()));
        assert!(!cmds.contains(&"bogus".to_string()), "underscore must be escaped in LIKE");
    }

    #[test]
    fn delete_command_cascades_to_dir_usage() {
        let store = HistoryStore::new();
        store.init(&temp_db());
        store.add_command("cargo build", 1);
        store.add_command_dir("cargo build", "c:/proj/a", 1);
        store.delete_command("cargo build"); // must remove from BOTH tables
        assert!(store.load_commands(10).is_empty());
        assert!(store.load_dir_usage("c:/proj/a").is_empty());
    }

    #[test]
    fn prune_dir_usage_keeps_newest() {
        let store = HistoryStore::new();
        store.init(&temp_db());
        store.add_command_dir("a", "c:/d", 1);
        store.add_command_dir("b", "c:/d", 2);
        store.add_command_dir("c", "c:/d", 3);
        store.prune_dir_usage(2);
        let cmds: Vec<String> = store.load_dir_usage("c:/d").iter().map(|r| r.command.clone()).collect();
        assert!(cmds.contains(&"c".to_string()) && cmds.contains(&"b".to_string()));
        assert!(!cmds.contains(&"a".to_string()));
    }

    #[test]
    fn disabled_store_dir_usage_is_noop() {
        let store = HistoryStore::new(); // never init'd
        store.add_command_dir("x", "c:/d", 1);
        assert!(store.load_dir_usage("c:/d").is_empty());
        store.delete_command_dir("x");
        store.prune_dir_usage(1);
    }

    /// Regression for the "empty terminal after restart" bug: we persist the vt100
    /// parser's RENDERED screen (`contents_formatted`), not the raw PTY byte stream.
    /// A full-screen TUI (codex) clears + redraws in place with absolute cursor
    /// addressing; replaying the raw stream into a fresh/resized terminal yields an
    /// empty or garbled screen. Persisting the rendered snapshot instead reproduces
    /// the terminal exactly as it looked at exit, independent of the new size.
    #[test]
    fn rendered_snapshot_round_trips_final_screen() {
        // Simulate: a stale pre-codex line, codex clears + draws UI with absolute
        // positioning, then exits (clears) and the shell prompt returns.
        let mut parser = vt100::Parser::new(24, 80, 0);
        parser.process(b"stale pre-codex line\r\n");
        parser.process(b"\x1b[2J\x1b[H"); // codex enters: clear + home
        parser.process(b"\x1b[10;5Htransient codex UI"); // absolute-positioned draw
        parser.process(b"\x1b[2J\x1b[H"); // codex exits: clear + home
        parser.process(b"PS D:\\sources> echo done\r\ndone\r\nPS D:\\sources> ");
        let blob = String::from_utf8_lossy(&parser.screen().contents_formatted()).into_owned();

        let store = HistoryStore::new();
        store.init(&temp_db());
        store.upsert("tb-codex", std::slice::from_ref(&blob), 1);

        // Restore path: concat the stored chunk(s) -> replay prefix.
        let prefix = store.get("tb-codex").expect("row present").concat();

        // Replay into a fresh terminal of a DIFFERENT size (proves size-independence).
        let mut replay = vt100::Parser::new(30, 100, 0);
        replay.process(prefix.as_bytes());
        let text = replay.screen().contents();

        assert!(
            text.contains("PS D:\\sources>"),
            "final shell prompt must survive restore, got:\n{text}"
        );
        assert!(
            !text.contains("transient codex UI"),
            "transient TUI frame must not linger after restore, got:\n{text}"
        );
        assert!(
            !text.contains("stale pre-codex line"),
            "content cleared before exit must not reappear, got:\n{text}"
        );
    }
}
