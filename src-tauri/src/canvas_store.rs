use rusqlite::Connection;
use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;

/// A relationship between two terminals, keyed by RENDERER ids (`tb-`/`tm-`).
/// Callers must normalise through `AppState::resolve_renderer_id` first — the
/// two PTY spawn paths inject different id spaces into `TERMFLOW_TERMINAL_ID`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasEdge {
    pub id: String,
    // Wire names are `from`/`to`, matching the renderer's CanvasEdge exactly.
    // Without these renames camelCase would emit `fromId`/`toId` and the renderer
    // would silently read undefined for every edge endpoint.
    #[serde(rename = "from")]
    pub from_id: String,
    #[serde(rename = "to")]
    pub to_id: String,
    pub label: Option<String>,
    /// "user" | "agent"
    pub origin: String,
    pub created_at: i64,
}

impl CanvasEdge {
    /// Mint a new edge with a fresh id and the current timestamp.
    ///
    /// Both places that create edges go through this — the user's drag
    /// (`POST /api/canvas/edges`) and an agent's spawn (`POST /api/terminals` with a
    /// `parentTerminalId`). `plan/013` Task 20 spelled the id out again as a nine-character
    /// truncation of a UUID, which would have put two different id shapes in one table for no
    /// reason and given the auto-connect path its own collision odds.
    ///
    /// Endpoints must already be RENDERER ids — resolve through
    /// `AppState::resolve_renderer_id` before calling.
    pub fn new(from_id: String, to_id: String, label: Option<String>, origin: &str) -> Self {
        Self {
            id: format!("ce-{}", uuid::Uuid::new_v4()),
            from_id,
            to_id,
            label,
            origin: origin.to_string(),
            created_at: chrono::Utc::now().timestamp_millis(),
        }
    }
}

/// Why every method returns `Result`: a bare bool collapses "duplicate pair",
/// "store disabled" and "SQLite is locked" into one `false`, so an auto-created
/// edge would vanish silently and `/graph` would report an empty workspace during
/// a lock. Handlers map `Err` to 503 and a confirmed absence to 404.
#[derive(Debug)]
pub enum CanvasStoreError {
    /// The DB could not be opened at startup, so the store is inert.
    Disabled,
    Sqlite(rusqlite::Error),
}

impl std::fmt::Display for CanvasStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Disabled => write!(f, "canvas edge store is disabled"),
            Self::Sqlite(e) => write!(f, "canvas edge store sqlite error: {e}"),
        }
    }
}

impl std::error::Error for CanvasStoreError {}

impl From<rusqlite::Error> for CanvasStoreError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Sqlite(e)
    }
}

/// The result of an insert. `Existing` carries the row that is actually stored,
/// because a retrying agent must get the authoritative id back, not a rejection.
#[derive(Debug)]
pub enum InsertOutcome {
    Inserted(CanvasEdge),
    Existing(CanvasEdge),
}

/// Canvas connection graph, stored beside scrollback in `history.db`.
///
/// Its own `Connection` to the same file rather than a share of `HistoryStore`'s:
/// SQLite permits several connections to one database, and a standalone struct can
/// be tested against `Connection::open_in_memory()` — which is what makes the real
/// SQL verifiable without a live `AppHandle`.
///
/// Follows `HistoryStore`'s degradation model — a DB that cannot be opened leaves
/// the store inert rather than crashing the app — but reports that state as
/// `Err(Disabled)` instead of an indistinguishable `false`.
pub struct CanvasStore {
    conn: Mutex<Option<Connection>>,
}

impl Default for CanvasStore {
    fn default() -> Self {
        Self::new()
    }
}

impl CanvasStore {
    /// A disabled store. `init` upgrades it in place.
    pub fn new() -> Self {
        Self {
            conn: Mutex::new(None),
        }
    }

    pub fn init(&self, path: &Path) {
        let mut guard = self.conn.lock().unwrap();
        if guard.is_some() {
            log::warn!("[CANVAS] init called more than once — ignoring");
            return;
        }
        match Connection::open(path).and_then(|c| {
            Self::schema(&c)?;
            Ok(c)
        }) {
            Ok(conn) => {
                *guard = Some(conn);
                log::info!("[CANVAS] edge store initialized at {}", path.display());
            }
            Err(e) => log::warn!("[CANVAS] edge store disabled (open failed): {}", e),
        }
    }

    #[cfg(test)]
    pub fn new_in_memory() -> Self {
        let conn = Connection::open_in_memory().expect("in-memory sqlite");
        Self::schema(&conn).expect("schema");
        Self {
            conn: Mutex::new(Some(conn)),
        }
    }

    fn schema(conn: &Connection) -> rusqlite::Result<()> {
        conn.execute(
            "CREATE TABLE IF NOT EXISTS canvas_edges (
                id         TEXT PRIMARY KEY,
                from_id    TEXT NOT NULL,
                to_id      TEXT NOT NULL,
                label      TEXT,
                origin     TEXT NOT NULL,
                created_at INTEGER NOT NULL
            )",
            [],
        )?;
        // Ordered pair: A→B and B→A are distinct, but A→B twice is one edge.
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS canvas_edges_pair ON canvas_edges(from_id, to_id)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS canvas_edges_from ON canvas_edges(from_id)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS canvas_edges_to ON canvas_edges(to_id)",
            [],
        )?;
        Ok(())
    }

    /// `Inserted` when a row was written; `Existing` when the unique (from,to) index
    /// rejected it — a repeat POST from a retrying agent, which must get back the row
    /// that is actually stored so its id is the authoritative one.
    pub fn insert_edge(&self, e: &CanvasEdge) -> Result<InsertOutcome, CanvasStoreError> {
        {
            // Scoped so the guard is dropped before `get_by_pair`, which takes the
            // same mutex — `std::sync::Mutex` is not reentrant, so holding it across
            // that call would deadlock rather than fail.
            let guard = self.conn.lock().unwrap();
            let conn = guard.as_ref().ok_or(CanvasStoreError::Disabled)?;
            let n = conn.execute(
                "INSERT OR IGNORE INTO canvas_edges (id, from_id, to_id, label, origin, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![e.id, e.from_id, e.to_id, e.label, e.origin, e.created_at],
            )?;
            if n > 0 {
                return Ok(InsertOutcome::Inserted(e.clone()));
            }
        }
        match self.get_by_pair(&e.from_id, &e.to_id)? {
            Some(existing) => Ok(InsertOutcome::Existing(existing)),
            // The pair was deleted between the INSERT and this SELECT — or the id
            // collided with a row under a different pair. Report it rather than
            // inventing an outcome; the caller may retry.
            None => Err(CanvasStoreError::Sqlite(
                rusqlite::Error::QueryReturnedNoRows,
            )),
        }
    }

    /// `Ok(false)` means the row was already absent. `Err` means the store could not
    /// answer — the distinction the handler needs for 404 versus 503.
    pub fn delete_edge(&self, id: &str) -> Result<bool, CanvasStoreError> {
        let guard = self.conn.lock().unwrap();
        let conn = guard.as_ref().ok_or(CanvasStoreError::Disabled)?;
        Ok(conn.execute("DELETE FROM canvas_edges WHERE id = ?1", [id])? > 0)
    }

    /// Update one edge label in place. `None` deliberately writes SQL NULL so a
    /// client can clear an existing label; it is not a "leave unchanged" sentinel.
    /// `Ok(false)` means the id was absent, while `Err` means the store could not
    /// answer and must not be collapsed into a missing-edge response.
    pub fn update_label(&self, id: &str, label: Option<&str>) -> Result<bool, CanvasStoreError> {
        let guard = self.conn.lock().unwrap();
        let conn = guard.as_ref().ok_or(CanvasStoreError::Disabled)?;
        Ok(conn.execute(
            "UPDATE canvas_edges SET label = ?1 WHERE id = ?2",
            rusqlite::params![label, id],
        )? > 0)
    }

    fn query(
        &self,
        sql: &str,
        params: &[&dyn rusqlite::ToSql],
    ) -> Result<Vec<CanvasEdge>, CanvasStoreError> {
        let guard = self.conn.lock().unwrap();
        let conn = guard.as_ref().ok_or(CanvasStoreError::Disabled)?;
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(params, |r| {
            Ok(CanvasEdge {
                id: r.get(0)?,
                from_id: r.get(1)?,
                to_id: r.get(2)?,
                label: r.get(3)?,
                origin: r.get(4)?,
                created_at: r.get(5)?,
            })
        })?;
        // Collect through `?` rather than `filter_map(Result::ok)`: a row that fails
        // to decode is a real error, not an edge that does not exist.
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn all_edges(&self) -> Result<Vec<CanvasEdge>, CanvasStoreError> {
        self.query(
            "SELECT id, from_id, to_id, label, origin, created_at FROM canvas_edges",
            &[],
        )
    }

    /// The stored row for one directed pair, if any. `Ok(None)` is "no such edge".
    pub fn get_by_pair(
        &self,
        from: &str,
        to: &str,
    ) -> Result<Option<CanvasEdge>, CanvasStoreError> {
        Ok(self
            .query(
                "SELECT id, from_id, to_id, label, origin, created_at
                 FROM canvas_edges WHERE from_id = ?1 AND to_id = ?2",
                &[&from, &to],
            )?
            .into_iter()
            .next())
    }

    /// Both directions for one node. `Ok(vec![])` is a valid answer, never an error.
    ///
    /// Equality, never `LIKE`: renderer ids share a prefix space (`tm-a`, `tm-ab`),
    /// so a pattern match would quietly return a neighbour's edges as this node's.
    pub fn edges_for(&self, renderer_id: &str) -> Result<Vec<CanvasEdge>, CanvasStoreError> {
        self.query(
            "SELECT id, from_id, to_id, label, origin, created_at
             FROM canvas_edges WHERE from_id = ?1 OR to_id = ?1",
            &[&renderer_id],
        )
    }

    /// Housekeeping only — correctness comes from filtering reads by liveness.
    /// Deletes at most `limit` edges older than `older_than` whose endpoints are
    /// all dead, so startup is never blocked.
    pub fn prune_edges(
        &self,
        older_than: i64,
        live: &HashSet<String>,
        limit: usize,
    ) -> Result<usize, CanvasStoreError> {
        let candidates: Vec<CanvasEdge> = self
            .query(
                "SELECT id, from_id, to_id, label, origin, created_at
                 FROM canvas_edges WHERE created_at < ?1",
                &[&older_than],
            )?
            .into_iter()
            .filter(|e| !live.contains(&e.from_id) && !live.contains(&e.to_id))
            .take(limit)
            .collect();

        let mut removed = 0usize;
        for e in &candidates {
            if self.delete_edge(&e.id)? {
                removed += 1;
            }
        }
        Ok(removed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn edge(id: &str, from: &str, to: &str, origin: &str, created_at: i64) -> CanvasEdge {
        CanvasEdge {
            id: id.into(),
            from_id: from.into(),
            to_id: to.into(),
            label: None,
            origin: origin.into(),
            created_at,
        }
    }

    #[test]
    fn inserts_and_reads_back_an_edge() {
        let s = CanvasStore::new_in_memory();
        assert!(matches!(
            s.insert_edge(&edge("ce-1", "tm-a", "tm-b", "user", 100)),
            Ok(InsertOutcome::Inserted(_))
        ));
        let all = s.all_edges().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].from_id, "tm-a");
        assert_eq!(all[0].origin, "user");
    }

    #[test]
    fn round_trips_every_field_including_the_label() {
        let s = CanvasStore::new_in_memory();
        let mut e = edge("ce-1", "tm-a", "tm-b", "agent", 1234);
        e.label = Some("deploys".into());
        s.insert_edge(&e).unwrap();
        let got = s.all_edges().unwrap().remove(0);
        assert_eq!(got.id, "ce-1");
        assert_eq!(got.to_id, "tm-b");
        assert_eq!(got.label.as_deref(), Some("deploys"));
        assert_eq!(got.created_at, 1234);
    }

    /// The wire names the renderer reads, asserted rather than assumed.
    ///
    /// `rename_all = "camelCase"` alone would emit `fromId`/`toId`, and the renderer's
    /// `CanvasEdge` reads `from`/`to` — so every endpoint would be `undefined`, every
    /// edge would render between nowhere and nowhere, and nothing would throw. The two
    /// field renames are the only thing standing between here and that, so they get a
    /// test rather than a comment.
    #[test]
    fn serialises_under_the_names_the_renderer_reads() {
        let mut e = edge("ce-1", "tm-a", "tm-b", "user", 77);
        e.label = Some("x".into());
        let v: serde_json::Value = serde_json::to_value(&e).unwrap();
        assert_eq!(v["from"], "tm-a");
        assert_eq!(v["to"], "tm-b");
        assert_eq!(v["createdAt"], 77);
        assert!(v.get("fromId").is_none(), "the snake/camel name must not leak");
        assert!(v.get("toId").is_none());
        assert!(v.get("created_at").is_none());
    }

    #[test]
    fn deserialises_what_it_serialises() {
        let e = edge("ce-1", "tm-a", "tm-b", "user", 77);
        let back: CanvasEdge = serde_json::from_str(&serde_json::to_string(&e).unwrap()).unwrap();
        assert_eq!(back.from_id, "tm-a");
        assert_eq!(back.to_id, "tm-b");
        assert_eq!(back.created_at, 77);
    }

    #[test]
    fn the_same_directed_pair_is_idempotent_and_returns_the_existing_row() {
        // A bare bool cannot distinguish "duplicate" from "disabled store" from
        // "SQLite error", and Task 17 must return the EXISTING edge on a repeat
        // POST — which it cannot do if all it gets back is false.
        let s = CanvasStore::new_in_memory();
        assert!(matches!(
            s.insert_edge(&edge("ce-1", "tm-a", "tm-b", "agent", 100)),
            Ok(InsertOutcome::Inserted(_))
        ));
        match s.insert_edge(&edge("ce-2", "tm-a", "tm-b", "agent", 200)) {
            Ok(InsertOutcome::Existing(e)) => assert_eq!(e.id, "ce-1"),
            other => panic!("expected the existing row, got {other:?}"),
        }
        assert_eq!(
            s.all_edges().unwrap().len(),
            1,
            "an agent retry must not duplicate the edge"
        );
    }

    #[test]
    fn a_disabled_store_reports_an_error_rather_than_a_silent_false() {
        let s = CanvasStore::new();
        assert!(s
            .insert_edge(&edge("ce-1", "tm-a", "tm-b", "user", 100))
            .is_err());
        assert!(s.all_edges().is_err());
    }

    /// Every read path, not just the two above — a method that forgot the guard would
    /// return `Ok(vec![])` from a store that cannot answer, and `/graph` would report
    /// an empty workspace as though the user had drawn nothing.
    #[test]
    fn every_method_on_a_disabled_store_is_an_error() {
        let s = CanvasStore::new();
        let live = HashSet::new();
        assert!(s.edges_for("tm-a").is_err());
        assert!(s.get_by_pair("tm-a", "tm-b").is_err());
        assert!(s.delete_edge("ce-1").is_err());
        assert!(s.prune_edges(1, &live, 10).is_err());
    }

    #[test]
    fn the_reverse_pair_is_a_distinct_edge() {
        let s = CanvasStore::new_in_memory();
        s.insert_edge(&edge("ce-1", "tm-a", "tm-b", "user", 100))
            .unwrap();
        s.insert_edge(&edge("ce-2", "tm-b", "tm-a", "user", 100))
            .unwrap();
        assert_eq!(s.all_edges().unwrap().len(), 2);
    }

    #[test]
    fn edges_for_returns_both_directions() {
        let s = CanvasStore::new_in_memory();
        s.insert_edge(&edge("ce-1", "tm-a", "tm-b", "user", 100))
            .unwrap();
        s.insert_edge(&edge("ce-2", "tm-c", "tm-a", "agent", 100))
            .unwrap();
        s.insert_edge(&edge("ce-3", "tm-x", "tm-y", "user", 100))
            .unwrap();
        let mut ids: Vec<String> = s
            .edges_for("tm-a")
            .unwrap()
            .into_iter()
            .map(|e| e.id)
            .collect();
        ids.sort();
        assert_eq!(ids, vec!["ce-1", "ce-2"]);
    }

    /// Renderer ids share a prefix space, so `tm-a` is a prefix of `tm-ab`. A `LIKE`
    /// or a `substr` here would hand one terminal its neighbour's connections, and
    /// every test above would still pass because none of their ids overlap.
    #[test]
    fn edges_for_matches_the_whole_id_not_a_prefix_of_it() {
        let s = CanvasStore::new_in_memory();
        s.insert_edge(&edge("ce-1", "tm-ab", "tm-cd", "user", 100))
            .unwrap();
        assert!(s.edges_for("tm-a").unwrap().is_empty());
        assert_eq!(s.edges_for("tm-ab").unwrap().len(), 1);
    }

    #[test]
    fn edges_for_an_unconnected_terminal_is_empty_not_an_error() {
        let s = CanvasStore::new_in_memory();
        // Ok(vec![]) — "nothing is connected" is an answer, not a failure.
        assert!(s.edges_for("tm-lonely").unwrap().is_empty());
    }

    #[test]
    fn get_by_pair_is_directed_and_absent_is_ok_none() {
        let s = CanvasStore::new_in_memory();
        s.insert_edge(&edge("ce-1", "tm-a", "tm-b", "user", 100))
            .unwrap();
        assert_eq!(
            s.get_by_pair("tm-a", "tm-b").unwrap().map(|e| e.id),
            Some("ce-1".to_string())
        );
        assert!(
            s.get_by_pair("tm-b", "tm-a").unwrap().is_none(),
            "the reverse pair is a different edge, not this one"
        );
        assert!(s.get_by_pair("tm-x", "tm-y").unwrap().is_none());
    }

    #[test]
    fn deletes_an_edge_by_id() {
        let s = CanvasStore::new_in_memory();
        s.insert_edge(&edge("ce-1", "tm-a", "tm-b", "user", 100))
            .unwrap();
        assert!(s.delete_edge("ce-1").unwrap());
        assert!(s.all_edges().unwrap().is_empty());
        assert!(
            !s.delete_edge("ce-1").unwrap(),
            "deleting twice reports no rows removed"
        );
    }

    #[test]
    fn delete_distinguishes_absent_from_failure() {
        let s = CanvasStore::new_in_memory();
        s.insert_edge(&edge("ce-1", "tm-a", "tm-b", "user", 100))
            .unwrap();
        assert!(s.delete_edge("ce-1").unwrap());
        assert!(
            !s.delete_edge("ce-1").unwrap(),
            "absent is Ok(false), not Err"
        );
        assert!(
            CanvasStore::new().delete_edge("ce-1").is_err(),
            "a dead store is Err"
        );
    }

    #[test]
    fn updates_an_existing_edge_label_in_place() {
        let s = CanvasStore::new_in_memory();
        s.insert_edge(&edge("ce-1", "tm-a", "tm-b", "user", 100)).unwrap();
        assert!(s.update_label("ce-1", Some("deploys")).unwrap());
        assert_eq!(s.get_by_pair("tm-a", "tm-b").unwrap().unwrap().label.as_deref(), Some("deploys"));
    }

    #[test]
    fn clearing_a_label_with_none_writes_null() {
        let s = CanvasStore::new_in_memory();
        let mut e = edge("ce-1", "tm-a", "tm-b", "user", 100);
        e.label = Some("deploys".into());
        s.insert_edge(&e).unwrap();
        assert!(s.update_label("ce-1", None).unwrap());
        assert!(s.get_by_pair("tm-a", "tm-b").unwrap().unwrap().label.is_none());
    }

    #[test]
    fn updating_an_unknown_id_is_a_confirmed_miss() {
        assert!(!CanvasStore::new_in_memory().update_label("ce-gone", Some("x")).unwrap());
    }

    #[test]
    fn updating_a_disabled_store_is_an_error() {
        assert!(CanvasStore::new().update_label("ce-1", Some("x")).is_err());
    }

    #[test]
    fn updating_a_label_preserves_all_other_edge_fields_and_pair_index() {
        let s = CanvasStore::new_in_memory();
        let mut e = edge("ce-1", "tm-a", "tm-b", "agent", 1234);
        e.label = Some("before".into());
        s.insert_edge(&e).unwrap();
        assert!(s.update_label("ce-1", Some("after")).unwrap());
        let updated = s.get_by_pair("tm-a", "tm-b").unwrap().unwrap();
        assert_eq!(updated.id, "ce-1");
        assert_eq!(updated.from_id, "tm-a");
        assert_eq!(updated.to_id, "tm-b");
        assert_eq!(updated.origin, "agent");
        assert_eq!(updated.created_at, 1234);
        assert_eq!(updated.label.as_deref(), Some("after"));
        assert!(matches!(
            s.insert_edge(&edge("ce-2", "tm-a", "tm-b", "user", 9)),
            Ok(InsertOutcome::Existing(existing)) if existing.id == "ce-1"
        ));
    }

    /// Deleting a pair must free it, or a re-drawn connection would come back as
    /// `Existing` pointing at a row that is gone.
    #[test]
    fn the_pair_can_be_drawn_again_after_it_is_deleted() {
        let s = CanvasStore::new_in_memory();
        s.insert_edge(&edge("ce-1", "tm-a", "tm-b", "user", 100))
            .unwrap();
        s.delete_edge("ce-1").unwrap();
        assert!(matches!(
            s.insert_edge(&edge("ce-2", "tm-a", "tm-b", "user", 300)),
            Ok(InsertOutcome::Inserted(_))
        ));
    }

    #[test]
    fn prune_keeps_edges_with_a_live_endpoint_however_old() {
        let s = CanvasStore::new_in_memory();
        s.insert_edge(&edge("ce-old", "tm-a", "tm-b", "user", 1))
            .unwrap();
        let mut live = HashSet::new();
        live.insert("tm-a".to_string());
        assert_eq!(s.prune_edges(1_000_000, &live, 100).unwrap(), 0);
        assert_eq!(s.all_edges().unwrap().len(), 1);
    }

    /// ...and either endpoint is enough. Testing only `from` would leave a rule that
    /// deletes every edge pointing AT a live terminal.
    #[test]
    fn prune_keeps_an_edge_whose_live_endpoint_is_the_destination() {
        let s = CanvasStore::new_in_memory();
        s.insert_edge(&edge("ce-old", "tm-a", "tm-b", "user", 1))
            .unwrap();
        let mut live = HashSet::new();
        live.insert("tm-b".to_string());
        assert_eq!(s.prune_edges(1_000_000, &live, 100).unwrap(), 0);
    }

    #[test]
    fn prune_removes_old_edges_whose_endpoints_are_all_dead() {
        let s = CanvasStore::new_in_memory();
        s.insert_edge(&edge("ce-old", "tm-a", "tm-b", "user", 1))
            .unwrap();
        s.insert_edge(&edge("ce-new", "tm-c", "tm-d", "user", 9_999_999))
            .unwrap();
        let live = HashSet::new();
        assert_eq!(s.prune_edges(1_000_000, &live, 100).unwrap(), 1);
        let remaining: Vec<String> = s.all_edges().unwrap().into_iter().map(|e| e.id).collect();
        assert_eq!(remaining, vec!["ce-new"]);
    }

    #[test]
    fn prune_respects_its_limit_so_startup_is_never_blocked() {
        let s = CanvasStore::new_in_memory();
        for i in 0..10 {
            s.insert_edge(&edge(
                &format!("ce-{i}"),
                &format!("a{i}"),
                &format!("b{i}"),
                "user",
                1,
            ))
            .unwrap();
        }
        let live = HashSet::new();
        assert_eq!(s.prune_edges(1_000_000, &live, 3).unwrap(), 3);
        assert_eq!(s.all_edges().unwrap().len(), 7);
    }

    /// `older_than` is exclusive, and an edge created at exactly the cutoff is kept.
    /// Off by one here silently deletes the newest thing the sweep was meant to spare.
    #[test]
    fn prune_leaves_an_edge_created_exactly_at_the_cutoff() {
        let s = CanvasStore::new_in_memory();
        s.insert_edge(&edge("ce-1", "tm-a", "tm-b", "user", 1_000))
            .unwrap();
        let live = HashSet::new();
        assert_eq!(s.prune_edges(1_000, &live, 10).unwrap(), 0);
        assert_eq!(s.prune_edges(1_001, &live, 10).unwrap(), 1);
    }
}
