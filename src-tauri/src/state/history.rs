use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tauri::Runtime;
use super::types::*;

pub(crate) fn persist_registered_history(keys: &super::HostKeys, store: &crate::history_store::HistoryStore,
    leaf: &str, process: &str, now_ms: i64, snapshot: impl FnOnce() -> Option<Vec<u8>>) -> Option<()> {
    keys.write(leaf, process, || persist_snapshot(store, leaf, now_ms, snapshot()))
}

pub(crate) fn persist_snapshot(store: &crate::history_store::HistoryStore, leaf: &str, now_ms: i64, snapshot: Option<Vec<u8>>) {
    let Some(snapshot) = snapshot else { return };
    let blob = String::from_utf8_lossy(&snapshot).into_owned();
    store.upsert(leaf, std::slice::from_ref(&blob), now_ms);
}

impl<R: Runtime> AppState<R> {
    /// Persist one terminal's RENDERED scrollback under its renderer leaf id
    /// (`renderer_terminal_id` — `tb-*`/`tm-*`).
    /// Skips stale shells and terminals without a renderer leaf (legacy headless PTYs).
    ///
    /// We persist the authoritative vt100 parser's FULL buffer (scrollback + visible
    /// screen) rendered as styled lines — NOT the raw PTY byte stream. Raw replay is
    /// broken for full-screen TUIs (codex, vim, htop): they redraw in place with absolute
    /// cursor addressing + screen clears sized to the old terminal, so concatenating the
    /// raw chunks into a fresh, possibly resized xterm paints garbage. The parser has
    /// already resolved every chunk (fed unconditionally in the output consumer, before
    /// the history filter) into a flat grid plus scrollback; rendering each row as its own
    /// line (no screen-clear) reproduces the entire session history. 2J-cleared transient
    /// frames never enter scrollback, so this stays TUI-safe (see render_full_scrollback).
    ///
    /// Used by the periodic and graceful-shutdown flushes. Natural exit uses
    /// the snapshot helper inside the shared ending, before parser cleanup.
    pub fn persist_terminal_history(&self, id: &str, now_ms: i64) {
        let renderer_id = self
            .terminals
            .get(id)
            .and_then(|t| t.renderer_terminal_id.clone());
        let Some(key) = history_key(renderer_id.as_deref()) else { return };
        persist_registered_history(self.host_table.keys(), &self.history_store, key, id, now_ms,
            || self.persisted_scrollback_snapshot(id));
    }

    /// Called only inside the shared ending's stripe.
    pub(crate) fn persist_history_snapshot(&self, id: &str, key: &str, now_ms: i64) {
        // Skip when the parser is absent or the whole buffer is blank (brand-new or
        // already-cleared terminal) so we never persist a blank blob that would replay as
        // an empty "session restored" divider with nothing above it.
        persist_snapshot(&self.history_store, key, now_ms, self.persisted_scrollback_snapshot(id));
    }

    /// Get a terminal's history buffer handle. Clones the Arc and DROPS the
    /// DashMap shard guard before returning, so callers can lock the inner
    /// Mutex without holding any shard lock (see terminal_history field note).
    pub fn get_history(&self, id: &str) -> Option<Arc<Mutex<VecDeque<String>>>> {
        self.terminal_history.get(id).map(|entry| entry.value().clone())
    }
}
