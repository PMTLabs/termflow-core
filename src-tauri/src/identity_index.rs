//! Lookups from the two DURABLE terminal identities to this run's process id.
//!
//! Design 014 §A3. Before that design, one string was the map key, the renderer
//! leaf and the pty-host session key all at once, so no lookup was needed —
//! which is exactly why a tab id and a terminal id could not be told apart. Once
//! they are separate values, two lookups become necessary:
//!
//! - **leaf → process** (`tm-…`): the API resolves a caller-supplied *durable*
//!   id. `pc-` ids are per-run, so an agent that saved one across a restart gets
//!   a 404; `tm-` is what MCP hands out for that reason.
//! - **session → process**: the pty-host tags every inbound frame with its
//!   session key, and the output pipeline needs the map key. Without this,
//!   every frame routes to nothing and terminals render blank.
//!
//! Lives in its own file rather than on `AppState` so it can be unit-tested
//! without a Tauri `AppHandle` — the `tauri::test` feature crashes the test
//! binary on Windows, so every testable unit here has to stand alone.

use dashmap::DashMap;
use std::sync::Arc;

/// Both directions of terminal-identity lookup, with a single writer and a
/// single remover so the two maps cannot drift apart.
#[derive(Clone, Default)]
pub struct IdentityIndex {
    leaf_to_process: Arc<DashMap<String, String>>,
    session_to_process: Arc<DashMap<String, String>>,
}

impl IdentityIndex {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a terminal's identities. The ONLY writer.
    ///
    /// `leaf` is `None` for a headless API/fleet spawn — such a terminal has no
    /// renderer pane, and is deliberately kept out of the leaf index (and out of
    /// the history table, per design 011 §5).
    pub fn index(&self, process_id: &str, leaf: Option<&str>, session_key: &str) {
        if let Some(l) = leaf {
            self.leaf_to_process.insert(l.to_string(), process_id.to_string());
        }
        self.session_to_process.insert(session_key.to_string(), process_id.to_string());
    }

    /// Drop every entry pointing at `process_id`. The ONLY remover.
    ///
    /// Scans by VALUE rather than taking the leaf and session as parameters. A
    /// caller passing a stale leaf would silently leave an entry behind, and a
    /// leaked entry is worse than a missing one: it routes a later terminal's
    /// output at a process id that no longer exists.
    pub fn unindex(&self, process_id: &str) {
        self.leaf_to_process.retain(|_, v| v != process_id);
        self.session_to_process.retain(|_, v| v != process_id);
    }

    pub fn process_for_leaf(&self, leaf: &str) -> Option<String> {
        self.leaf_to_process.get(leaf).map(|e| e.value().clone())
    }

    pub fn process_for_session(&self, session_key: &str) -> Option<String> {
        self.session_to_process.get(session_key).map(|e| e.value().clone())
    }
}

#[cfg(test)]
mod tests {
    use super::IdentityIndex;

    #[test]
    fn resolves_both_directions() {
        let ix = IdentityIndex::new();
        ix.index("pc-1", Some("tm-leaf01"), "tb-sess01");
        assert_eq!(ix.process_for_leaf("tm-leaf01").as_deref(), Some("pc-1"));
        assert_eq!(ix.process_for_session("tb-sess01").as_deref(), Some("pc-1"));
    }

    #[test]
    fn unindex_clears_both_maps() {
        let ix = IdentityIndex::new();
        ix.index("pc-1", Some("tm-leaf01"), "tb-sess01");
        ix.unindex("pc-1");
        assert!(ix.process_for_leaf("tm-leaf01").is_none(), "leaf index leaked");
        assert!(ix.process_for_session("tb-sess01").is_none(), "session index leaked");
    }

    /// A migrated terminal's session key is its OLD `tb-` id while its leaf is a
    /// fresh `tm-`. Both must resolve to the same process (design 014 §A2).
    #[test]
    fn a_migrated_terminal_resolves_from_either_identity() {
        let ix = IdentityIndex::new();
        ix.index("pc-9", Some("tm-new00001"), "tb-old00001");
        assert_eq!(ix.process_for_leaf("tm-new00001").as_deref(), Some("pc-9"));
        assert_eq!(ix.process_for_session("tb-old00001").as_deref(), Some("pc-9"));
    }

    /// Headless API/fleet spawns have no renderer pane (011 §5).
    #[test]
    fn a_headless_terminal_indexes_its_session_but_not_a_leaf() {
        let ix = IdentityIndex::new();
        ix.index("pc-2", None, "pc-2");
        assert_eq!(ix.process_for_session("pc-2").as_deref(), Some("pc-2"));
        ix.unindex("pc-2");
        assert!(ix.process_for_session("pc-2").is_none());
    }

    /// Re-registration (the reattach path) must not leave the old leaf pointing
    /// at a live process. This is the case the value-scan in `unindex` exists for.
    #[test]
    fn reindexing_a_process_does_not_orphan_its_previous_leaf() {
        let ix = IdentityIndex::new();
        ix.index("pc-3", Some("tm-old"), "tb-s");
        ix.unindex("pc-3");
        ix.index("pc-3", Some("tm-new"), "tb-s");
        assert!(ix.process_for_leaf("tm-old").is_none(), "stale leaf survived");
        assert_eq!(ix.process_for_leaf("tm-new").as_deref(), Some("pc-3"));
    }

    /// Two live terminals must never collapse onto one entry — the invariant
    /// design 011 §3 established and 014 preserves.
    #[test]
    fn two_terminals_keep_separate_entries() {
        let ix = IdentityIndex::new();
        ix.index("pc-a", Some("tm-a"), "tm-a");
        ix.index("pc-b", Some("tm-b"), "tm-b");
        assert_eq!(ix.process_for_leaf("tm-a").as_deref(), Some("pc-a"));
        assert_eq!(ix.process_for_leaf("tm-b").as_deref(), Some("pc-b"));
        ix.unindex("pc-a");
        assert_eq!(ix.process_for_leaf("tm-b").as_deref(), Some("pc-b"),
            "closing one terminal must not unindex its sibling");
    }

    /// An unknown id resolves to None rather than echoing its own input — the
    /// fallback that design 014 §A2 exists to remove.
    #[test]
    fn an_unknown_id_resolves_to_none() {
        let ix = IdentityIndex::new();
        assert!(ix.process_for_leaf("tm-ghost").is_none());
        assert!(ix.process_for_session("tb-ghost").is_none());
    }
}
