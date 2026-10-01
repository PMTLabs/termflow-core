//! Durable renderer leaf -> this run's process id. Host keys are routed by the
//! channel and connection epoch in HostRoutes, not by this durable-id index.

use dashmap::DashMap;
use std::sync::Arc;

#[derive(Clone, Default)]
pub struct IdentityIndex {
    leaf_to_process: Arc<DashMap<String, String>>,
}

impl IdentityIndex {
    pub fn new() -> Self {
        Self::default()
    }

    /// A headless shell has no leaf to index. The session argument is retained
    /// for callers registering a complete identity; it is not a routing key.
    pub fn index(&self, process_id: &str, leaf: Option<&str>, _session_key: &str) {
        if let Some(leaf) = leaf {
            self.leaf_to_process.insert(leaf.to_string(), process_id.to_string());
        }
    }

    /// Remove by value so a stale leaf supplied by a caller cannot leak a lookup.
    pub fn unindex(&self, process_id: &str) {
        self.leaf_to_process.retain(|_, process| process != process_id);
    }

    pub fn process_for_leaf(&self, leaf: &str) -> Option<String> {
        self.leaf_to_process.get(leaf).map(|entry| entry.value().clone())
    }
}

#[cfg(test)]
mod tests {
    use super::IdentityIndex;

    #[test]
    fn resolves_leaf_and_removes_it_by_process() {
        let ix = IdentityIndex::new();
        ix.index("pc-1", Some("tm-leaf01"), "tb-sess01");
        assert_eq!(ix.process_for_leaf("tm-leaf01").as_deref(), Some("pc-1"));
        ix.unindex("pc-1");
        assert!(ix.process_for_leaf("tm-leaf01").is_none());
    }

    #[test]
    fn migrated_session_does_not_replace_the_leaf_identity() {
        let ix = IdentityIndex::new();
        ix.index("pc-9", Some("tm-new00001"), "tb-old00001");
        assert_eq!(ix.process_for_leaf("tm-new00001").as_deref(), Some("pc-9"));
        assert!(ix.process_for_leaf("tb-old00001").is_none());
    }

    #[test]
    fn headless_registration_does_not_create_a_leaf() {
        let ix = IdentityIndex::new();
        ix.index("pc-2", None, "pc-2");
        assert!(ix.process_for_leaf("pc-2").is_none());
        ix.unindex("pc-2");
    }

    #[test]
    fn reindexing_a_process_does_not_orphan_its_previous_leaf() {
        let ix = IdentityIndex::new();
        ix.index("pc-3", Some("tm-old"), "tb-s");
        ix.unindex("pc-3");
        ix.index("pc-3", Some("tm-new"), "tb-s");
        assert!(ix.process_for_leaf("tm-old").is_none());
        assert_eq!(ix.process_for_leaf("tm-new").as_deref(), Some("pc-3"));
    }

    #[test]
    fn closing_one_terminal_does_not_unindex_its_sibling() {
        let ix = IdentityIndex::new();
        ix.index("pc-a", Some("tm-a"), "tm-a");
        ix.index("pc-b", Some("tm-b"), "tm-b");
        assert_eq!(ix.process_for_leaf("tm-a").as_deref(), Some("pc-a"));
        assert_eq!(ix.process_for_leaf("tm-b").as_deref(), Some("pc-b"));
        ix.unindex("pc-a");
        assert_eq!(ix.process_for_leaf("tm-b").as_deref(), Some("pc-b"));
    }

    #[test]
    fn unknown_leaf_is_not_echoed() {
        assert!(IdentityIndex::new().process_for_leaf("tm-ghost").is_none());
    }
}
