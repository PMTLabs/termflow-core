//! IPC-only remote browser filesystem commands.
use crate::{
    ssh::sftp::{DownloadPicker, DownloadResult, FsError, RemoteFs, RemoteListing, RemoteStat},
    state::AppState,
};
use tauri::{Runtime, State, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tokio_util::sync::CancellationToken;

#[tauri::command(rename_all = "camelCase")]
pub async fn ssh_fs_download<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, AppState<R>>,
    terminal_id: String,
    path: String,
    expected_generation: u64,
) -> Result<DownloadResult, FsError> {
    RemoteFs::new(&state.ssh_sessions, &terminal_id, expected_generation)
        .download_with_picker(&path, &CancellationToken::new(), |picker| async move {
            let dialog = window.dialog().file().set_parent(&window);
            let (send, receive) = tokio::sync::oneshot::channel::<Option<FilePath>>();
            let picked = move |path| {
                let _ = send.send(path);
            };
            match picker {
                DownloadPicker::Save { default_name } => {
                    let dialog = if let Some(name) = default_name { dialog.set_file_name(name) } else { dialog };
                    dialog.save_file(picked);
                }
                DownloadPicker::Folder => dialog.pick_folder(picked),
            }
            receive.await.map_err(|_| "Native download picker did not return a result.")?
                .map(|path| path.into_path().map_err(|_| "The native picker did not select a local path."))
                .transpose()
        })
        .await
}

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
