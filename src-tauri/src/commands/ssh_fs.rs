//! IPC-only remote browser filesystem commands.
use crate::{
    ssh::sftp::{FsError, RemoteFs, RemoteListing, RemoteStat},
    state::AppState,
};
use tauri::{Runtime, State};

#[tauri::command(rename_all = "camelCase")]
pub async fn ssh_fs_list<R: Runtime>(
    state: State<'_, AppState<R>>,
    terminal_id: String,
    path: String,
    expected_generation: u64,
) -> Result<RemoteListing, FsError> {
    RemoteFs::new(&state.ssh_sessions, &terminal_id, expected_generation)
        .list(&path)
        .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn ssh_fs_stat<R: Runtime>(
    state: State<'_, AppState<R>>,
    terminal_id: String,
    path: String,
    expected_generation: u64,
) -> Result<RemoteStat, FsError> {
    RemoteFs::new(&state.ssh_sessions, &terminal_id, expected_generation)
        .stat(&path)
        .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn ssh_fs_mkdir<R: Runtime>(
    state: State<'_, AppState<R>>,
    terminal_id: String,
    path: String,
    expected_generation: u64,
) -> Result<(), FsError> {
    RemoteFs::new(&state.ssh_sessions, &terminal_id, expected_generation)
        .mkdir(&path)
        .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn ssh_fs_create<R: Runtime>(
    state: State<'_, AppState<R>>,
    terminal_id: String,
    path: String,
    expected_generation: u64,
) -> Result<(), FsError> {
    RemoteFs::new(&state.ssh_sessions, &terminal_id, expected_generation)
        .create(&path)
        .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn ssh_fs_rename<R: Runtime>(
    state: State<'_, AppState<R>>,
    terminal_id: String,
    path: String,
    expected_generation: u64,
    new_path: String,
) -> Result<(), FsError> {
    RemoteFs::new(&state.ssh_sessions, &terminal_id, expected_generation)
        .rename(&path, &new_path)
        .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn ssh_fs_delete<R: Runtime>(
    state: State<'_, AppState<R>>,
    terminal_id: String,
    path: String,
    expected_generation: u64,
    recursive: bool,
    confirmed: bool,
) -> Result<(), FsError> {
    RemoteFs::new(&state.ssh_sessions, &terminal_id, expected_generation)
        .delete(&path, recursive, confirmed)
        .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn ssh_fs_chmod<R: Runtime>(
    state: State<'_, AppState<R>>,
    terminal_id: String,
    path: String,
    expected_generation: u64,
    mode: u32,
) -> Result<(), FsError> {
    RemoteFs::new(&state.ssh_sessions, &terminal_id, expected_generation)
        .chmod(&path, mode)
        .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn ssh_fs_chown<R: Runtime>(
    state: State<'_, AppState<R>>,
    terminal_id: String,
    path: String,
    expected_generation: u64,
    uid: Option<u32>,
    gid: Option<u32>,
) -> Result<(), FsError> {
    RemoteFs::new(&state.ssh_sessions, &terminal_id, expected_generation)
        .chown(&path, uid, gid)
        .await
}
