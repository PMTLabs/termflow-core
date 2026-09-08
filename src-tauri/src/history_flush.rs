use crate::state::AppState;
use tauri::Manager;

/// Resolve this instance's history DB path under the app data dir (dev/prod split,
/// mirroring app_config's instance filenames). Creates the dir. None on failure.
pub(crate) fn history_db_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join(crate::app_config::dev_file("history.db")))
}

// NOTE: the per-terminal persist logic lives in `AppState::persist_terminal_history`
// (state.rs) so the session-exit paths there can flush a dying terminal's final
// output before `cleanup_terminal_state` discards its parser.

/// Drain the dirty set, writing each changed terminal once (called every 30s).
fn flush_dirty_history(state: &AppState) {
    let now = chrono::Utc::now().timestamp_millis();
    let ids: Vec<String> = state.history_dirty.iter().map(|e| e.key().clone()).collect();
    for id in ids {
        state.history_dirty.remove(&id);
        state.persist_terminal_history(&id, now);
    }
}

/// Flush EVERY live terminal (called once on graceful exit so the last <30s of
/// output survives even if it never tripped the interval).
pub(crate) fn flush_all_history(state: &AppState) {
    let now = chrono::Utc::now().timestamp_millis();
    let ids: Vec<String> = state.terminals.iter().map(|e| e.key().clone()).collect();
    for id in ids {
        state.persist_terminal_history(&id, now);
    }
}

/// Background task: flush dirty terminals' scrollback to disk every 30s. Throttled
/// (dirty-set driven) so idle terminals are never rewritten.
pub(crate) fn spawn_history_flush_task(state: AppState) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(30));
        loop {
            ticker.tick().await;
            flush_dirty_history(&state);
        }
    });
}
