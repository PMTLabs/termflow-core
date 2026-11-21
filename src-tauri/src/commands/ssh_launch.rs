//! Desktop-only launch registration IPC. Session opening remains in 067.
use crate::{
    ssh::launch::{LaunchAttemptRef, LaunchError, LaunchSnapshot, Operation},
    state::AppState,
};
use tauri::{Runtime, State, WebviewWindow};

#[tauri::command]
pub(crate) fn ssh_terminal_launch<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, AppState<R>>,
    terminal_id: String,
    connection_id: String,
    attempt: LaunchAttemptRef,
) -> Result<LaunchSnapshot, LaunchError> {
    access(&window, state.inner(), &terminal_id, attempt, Operation::Launch(&connection_id))
}

#[tauri::command]
pub(crate) fn ssh_terminal_cancel_launch<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, AppState<R>>,
    terminal_id: String,
    attempt: LaunchAttemptRef,
) -> Result<LaunchSnapshot, LaunchError> {
    access(&window, state.inner(), &terminal_id, attempt, Operation::Cancel)
}

#[tauri::command]
pub(crate) fn ssh_terminal_launch_state<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, AppState<R>>,
    terminal_id: String,
    attempt: LaunchAttemptRef,
) -> Result<LaunchSnapshot, LaunchError> {
    access(&window, state.inner(), &terminal_id, attempt, Operation::Query)
}

fn access<R: Runtime>(
    window: &WebviewWindow<R>,
    state: &AppState<R>,
    terminal_id: &str,
    attempt: LaunchAttemptRef,
    op: Operation<'_>,
) -> Result<LaunchSnapshot, LaunchError> {
    state.ssh_launches.access(
        state.host_table.keys(),
        &state.ssh_sessions,
        window.label(),
        terminal_id,
        attempt,
        op,
    )
}
