//! The renderer's page-qualified ownership interface. Stream acknowledgments do
//! not wait for PTY replies, storage, or joined placements.

use crate::state::{AppState, CloseStorage, CreateAdmission, CreateGuard, EndKind, PaneReply, PaneRequest, PaneResult};
use tauri::{State, WebviewWindow};

fn dispatch_closes(state: &AppState, processes: Vec<String>) {
    for pc in processes {
        let state = state.clone();
        tauri::async_runtime::spawn_blocking(move || {
            // The process ending rechecks Closing and the exact pc after taking
            // its leaf stripe. It cannot close a successor admitted meanwhile.
            state.end_shell(&pc, EndKind::Close(CloseStorage::Delete));
        });
    }
}

fn schedule_transfer_expiry(keys: crate::state::HostKeys) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(crate::state::TRANSFER_DEADLINE).await;
        keys.expire_transfers(std::time::Instant::now());
    });
}

#[tauri::command]
pub(crate) fn pane_op(window: WebviewWindow, state: State<'_, AppState>, request: PaneRequest) -> Result<PaneReply, String> {
    let (reply, effects) = state.host_table.keys().pane_op(window.label(), request)?;
    dispatch_closes(state.inner(), effects.closes);
    // A timer releases only abandoned ownership; it never closes a shell. Take
    // resets the stamp, so an earlier timer cannot expire a newer Taken state.
    if effects.wake_transfers {
        schedule_transfer_expiry(state.host_table.keys().clone());
    }
    Ok(reply)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AdmittedCreateRequest {
    pub pg: u64,
    pub cg: u64,
    pub leaf: String,
    pub profile: String,
    pub name: Option<String>,
    pub cwd: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    pub owning_tab_id: Option<String>,
    pub session_key: Option<String>,
    pub elevated: Option<bool>,
}

#[tauri::command]
pub(crate) async fn create_admitted_terminal(window: WebviewWindow, state: State<'_, AppState>, request: AdmittedCreateRequest) -> Result<String, String> {
    let admission = state.host_table.keys().admitted_work(window.label(), request.pg, &request.leaf, request.cg)?;
    match admission {
        CreateAdmission::Existing(pc) => Ok(pc),
        CreateAdmission::Join(waiter) => CreateAdmission::joined(waiter, crate::state::JOIN_DEADLINE).await,
        CreateAdmission::Run(cg) => {
            let _placement = CreateGuard::new(state.inner(), &request.leaf, cg);
            let (shell_name, shell_path, shell_args, cwd) = super::terminal::resolve_profile(Some(&request.profile), request.cwd);
            super::terminal::run_create(state.inner(), super::terminal::SpawnRequest {
                leaf_id: request.leaf, session_key: request.session_key, owning_tab_id: request.owning_tab_id,
                cols: request.cols.unwrap_or(80), rows: request.rows.unwrap_or(24),
                shell_name, shell_path, shell_args, cwd, name: request.name, elevated: request.elevated.unwrap_or(false),
            }, cg).await
        }
    }
}

#[tauri::command]
pub(crate) fn close_process(state: State<'_, AppState>, pc: String, reap: bool) -> Result<PaneResult, String> {
    let (result, effects) = state.host_table.keys().close_process_reap(&pc, reap);
    dispatch_closes(state.inner(), effects);
    Ok(result)
}
