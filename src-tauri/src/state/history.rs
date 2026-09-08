use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tauri::Runtime;
use super::types::*;

impl<R: Runtime> AppState<R> {
    /// Persist one terminal's RENDERED scrollback under its renderer leaf id
    /// (`renderer_terminal_id` — `tb-*`/`tm-*`).
    /// Skips terminals that are gone or have no renderer id (e.g. API-created PTYs).
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
    /// Called from the periodic dirty flush (lib.rs) and from every session-exit
    /// path BEFORE `cleanup_terminal_state`, so a dying session's final output
    /// (since the last 30s flush) still reaches the store.
    pub fn persist_terminal_history(&self, id: &str, now_ms: i64) {
        // Serialize per-terminal across snapshot→render→upsert (review 062): without
        // this, a slow periodic-flush render could finish AFTER a newer exit-path
        // persist and overwrite the final row with older content — permanently,
        // since a dead terminal is never persisted again.
        let guard_arc = self.history_persist_guard(id);
        let _guard = guard_arc.lock().unwrap_or_else(|e| e.into_inner());
        let renderer_id = self
            .terminals
            .get(id)
            .and_then(|t| t.renderer_terminal_id.clone());
        let Some(key) = history_key(renderer_id.as_deref()) else { return };
        // Skip when the parser is absent or the whole buffer is blank (brand-new or
        // already-cleared terminal) so we never persist a blank blob that would replay as
        // an empty "session restored" divider with nothing above it.
        let Some(snapshot) = self.full_scrollback_snapshot(id) else { return };
        let blob = String::from_utf8_lossy(&snapshot).into_owned();
        self.history_store.upsert(key, std::slice::from_ref(&blob), now_ms);
    }

    /// The per-terminal persistence lock (see `history_persist_locks`). The Arc is
    /// cloned and the DashMap shard guard dropped BEFORE the caller locks the inner
    /// mutex — never hold a shard guard across an inner lock (output-pipeline rule).
    pub fn history_persist_guard(&self, id: &str) -> Arc<Mutex<()>> {
        self.history_persist_locks
            .entry(id.to_string())
            .or_default()
            .clone()
    }

    /// Get a terminal's history buffer handle. Clones the Arc and DROPS the
    /// DashMap shard guard before returning, so callers can lock the inner
    /// Mutex without holding any shard lock (see terminal_history field note).
    pub fn get_history(&self, id: &str) -> Option<Arc<Mutex<VecDeque<String>>>> {
        self.terminal_history.get(id).map(|entry| entry.value().clone())
    }
}
