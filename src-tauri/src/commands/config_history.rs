//! Settings (save/merge/load) and command-history (add/rename/delete/load/prune,
//! dir usage) commands. Split out of the former `commands.rs`.

use tauri::State;
use crate::state::AppState;

/// Replace the whole settings blob. Prefer [`merge_config`]: this clobbers keys
/// written by anyone else since the caller read the file.
#[tauri::command]
pub async fn save_config(app_handle: tauri::AppHandle, config: String) -> Result<(), String> {
    // Through app_config::config_path, never a hand-built one: this used to
    // resolve the filename itself, so any change to the naming rule split
    // settings across two files.
    let path = crate::app_config::config_path(&app_handle)?;
    crate::app_config::write_atomic(&path, &config)
}

/// Merge top-level settings keys, leaving every other key alone. The renderer
/// used to read the whole config, merge in JS and save it back — a lost update
/// whenever the backend (or another instance) wrote in between.
///
/// Also broadcasts the merged keys as `config:changed` to every window — but
/// ONLY when `merge_many_locked` reports the write actually changed something.
/// TermFlow supports multiple windows, each with its own Redux store, so without
/// the broadcast a setting changed in one window (font, color schema, ...) only
/// ever took effect in that window's own terminals. The "actually changed" gate
/// is load-bearing, not an optimization: every window that receives
/// `config:changed` re-applies it through the same settings reducers that
/// persist on every dispatch, so each window's echo calls back into this exact
/// command — without the gate, every echo would broadcast again, forever.
#[tauri::command]
pub async fn merge_config(
    app_handle: tauri::AppHandle,
    updates: serde_json::Value,
) -> Result<(), String> {
    let updates = updates
        .as_object()
        .ok_or_else(|| "merge_config expects a JSON object".to_string())?
        .clone();
    let path = crate::app_config::config_path(&app_handle)?;
    let changed = crate::app_config::merge_many_locked(&path, &updates)?;
    if changed {
        use tauri::Emitter;
        let _ = app_handle.emit("config:changed", serde_json::Value::Object(updates));
    }
    Ok(())
}

/// Backlog 011: record one submitted command into the global command history.
/// Length/emptiness guards live here too (defense in depth vs the frontend).
/// The SQLite write runs on a blocking worker (codebase precedent: line 172) so
/// it never contends on the async runtime with the 30s scrollback flush, which
/// holds the same HistoryStore mutex while writing multi-MB blobs.
#[tauri::command]
pub async fn add_command_history(
    state: State<'_, AppState>,
    command: String,
) -> Result<(), String> {
    let trimmed = command.trim().to_string();
    if trimmed.is_empty() || trimmed.chars().count() > 500 {
        return Ok(()); // silently drop garbage; never an error the UI must handle
    }
    let store = state.history_store.clone();
    tokio::task::spawn_blocking(move || {
        store.add_command(&trimmed, chrono::Utc::now().timestamp_millis());
    })
    .await
    .map_err(|e| e.to_string())
}

/// Move persisted scrollback from a pre-014 `tb-` root leaf to its new `tm-`.
///
/// Called by `StateManager`'s restore-time migration, once per renamed leaf and
/// **before any reattach**, so a pane finds its history under the id it will
/// actually use. Without it a migrated pane comes back blank — silently, because
/// a missing row reads as "nothing saved yet" rather than as an error.
///
/// Blocking worker for the same contention reason as `add_command_history`: the
/// 30s scrollback flush holds this same mutex while writing multi-MB blobs.
///
/// Never fails the caller. A history row that will not move is a cosmetic loss
/// for one pane; aborting the migration would leave the pane tree half-renamed,
/// which is worse.
#[tauri::command]
pub async fn rename_terminal_history(
    state: State<'_, AppState>,
    from: String,
    to: String,
) -> Result<(), String> {
    let store = state.history_store.clone();
    tokio::task::spawn_blocking(move || store.rename_renderer_id(&from, &to))
        .await
        .map_err(|e| e.to_string())
}

/// Backlog 011: remove one command from the history (Shift+Delete on a
/// suggestion). Blocking worker for the same contention reason as add.
#[tauri::command]
pub async fn delete_command_history(
    state: State<'_, AppState>,
    command: String,
) -> Result<(), String> {
    let store = state.history_store.clone();
    tokio::task::spawn_blocking(move || store.delete_command(&command))
        .await
        .map_err(|e| e.to_string())
}

/// Backlog 011: most-recent-first command history for the suggestion popup.
#[tauri::command]
pub async fn load_command_history(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> Result<Vec<String>, String> {
    let store = state.history_store.clone();
    tokio::task::spawn_blocking(move || store.load_commands(limit.unwrap_or(2000).min(5000)))
        .await
        .map_err(|e| e.to_string())
}

/// Stream 4: record that a command was run in a directory (cwd-relevant ranking).
/// `dir` must already be normalized by the caller (forward-slash; lowercased on
/// Windows). Blocking worker for the same contention reason as add_command_history.
#[tauri::command]
pub async fn add_command_dir_usage(
    state: State<'_, AppState>,
    command: String,
    dir: String,
) -> Result<(), String> {
    let trimmed = command.trim().to_string();
    let dir = dir.trim().to_string();
    if trimmed.is_empty() || trimmed.chars().count() > 500 || dir.is_empty() {
        return Ok(()); // silently drop garbage / unknown-cwd (global history still records)
    }
    let store = state.history_store.clone();
    tokio::task::spawn_blocking(move || {
        store.add_command_dir(&trimmed, &dir, chrono::Utc::now().timestamp_millis());
    })
    .await
    .map_err(|e| e.to_string())
}

/// Stream 4: usage rows relevant to the current directory (exact + ancestors +
/// descendants) for the renderer to rank suggestions by cwd affinity.
#[tauri::command]
pub async fn load_command_dir_usage(
    state: State<'_, AppState>,
    cwd: String,
) -> Result<Vec<crate::history_store::DirUsageRow>, String> {
    let store = state.history_store.clone();
    tokio::task::spawn_blocking(move || store.load_dir_usage(&cwd))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn load_config(app_handle: tauri::AppHandle) -> Result<String, String> {
    let path = crate::app_config::config_path(&app_handle)?;
    if path.exists() {
        std::fs::read_to_string(path).map_err(|e| e.to_string())
    } else {
        Ok("{}".to_string())
    }
}

/// Delete persisted scrollback for every renderer id NOT in `keep_ids` — the startup
/// orphan sweep. The renderer passes the full set of ids its restored layout will use
/// (tab roots + split panes); everything else (closed tabs, crashed sessions) is reaped.
#[tauri::command]
pub async fn prune_terminal_history(
    state: State<'_, AppState>,
    keep_ids: Vec<String>,
) -> Result<(), String> {
    let keep: std::collections::HashSet<String> = keep_ids.into_iter().collect();
    state.history_store.prune(&keep);
    Ok(())
}

