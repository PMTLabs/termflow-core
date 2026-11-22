//! IPC-only remote browser filesystem commands.
use crate::{
    ssh::sftp::{
        edit::{EditRegistry, EditStatus, EditStop},
        launch::{EditOpen, NativeEditor, OpenMode},
        DownloadPicker, DownloadResult, FsError, RemoteFs, RemoteListing, RemoteStat,
    },
    state::AppState,
};
use std::{io::Write, sync::Arc};
use tauri::{Manager, Runtime, State, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tokio_util::sync::CancellationToken;

#[derive(serde::Serialize)]
pub struct InsertPath {
    written: bool,
}

/// Success means the input was enqueued to the specific hosted process's writer,
/// or accepted by the synchronous local PTY writer, not that SSH consumed it.
/// Async only so it runs on the Tokio pool, never the UI thread; the fence and
/// write below stay one synchronous section with no `.await`.
#[tauri::command(rename_all = "camelCase")]
pub async fn ssh_fs_insert_path<R: Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, AppState<R>>,
    terminal_id: String,
    path: String,
    expected_generation: u64,
) -> Result<InsertPath, FsError> {
    let quoted = crate::ssh::sftp::insert::RemoteDialect::Posix.quote(&path)?;
    state.ssh_sessions.insert_path(&terminal_id, expected_generation, &path, &state.identity, |process_id| {
        if crate::state::ingress::registered_target(state.host_table.keys(), process_id).as_deref() != Some(process_id) {
            return Err("Terminal is no longer registered.".into());
        }
        // Through 066's input gate like every renderer keystroke: a locked or trust-blocked
        // terminal refuses the insertion instead of receiving bytes behind the gate's back.
        crate::pty_manager::input_gate::write_input(
            &*state,
            process_id,
            crate::pty_manager::input_gate::InputSource::Renderer,
            None,
            quoted.as_bytes(),
        )
        .map_err(|failure| failure.message)
    })?;
    Ok(InsertPath { written: true })
}

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
pub async fn ssh_fs_open<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, AppState<R>>,
    edits: State<'_, Arc<EditRegistry>>,
    terminal_id: String,
    path: String,
    expected_generation: u64,
) -> Result<EditOpen, FsError> {
    let editor = crate::app_config::default_editor(window.app_handle());
    let fs = RemoteFs::new(&state.ssh_sessions, &terminal_id, expected_generation);
    edits.inner().open(&fs, &path, OpenMode::Text(editor.as_deref()), &NativeEditor(window)).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn ssh_fs_open_with<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, AppState<R>>,
    edits: State<'_, Arc<EditRegistry>>,
    terminal_id: String,
    path: String,
    expected_generation: u64,
) -> Result<EditOpen, FsError> {
    let fs = RemoteFs::new(&state.ssh_sessions, &terminal_id, expected_generation);
    edits.inner().open(&fs, &path, OpenMode::With, &NativeEditor(window)).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn ssh_fs_edit_stop(
    edits: State<'_, Arc<EditRegistry>>,
    terminal_id: String,
    path: String,
    edit_id: uuid::Uuid,
) -> Result<EditStop, FsError> {
    edits.inner().stop_by_id(&terminal_id, &path, edit_id).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn ssh_fs_edit_dismiss(
    edits: State<'_, Arc<EditRegistry>>,
    terminal_id: String,
    path: String,
    edit_id: uuid::Uuid,
) -> Result<(), FsError> {
    edits.dismiss_retained(&terminal_id, &path, edit_id)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn ssh_fs_edit_list(
    edits: State<'_, Arc<EditRegistry>>,
    terminal_id: String,
    path: String,
) -> Result<Vec<EditStatus>, FsError> {
    edits.list(&terminal_id, &path).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn ssh_fs_list<R: Runtime>(
    _app: tauri::AppHandle<R>,
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
    _app: tauri::AppHandle<R>,
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
    _app: tauri::AppHandle<R>,
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
    _app: tauri::AppHandle<R>,
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
    _app: tauri::AppHandle<R>,
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
    _app: tauri::AppHandle<R>,
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
    _app: tauri::AppHandle<R>,
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
    _app: tauri::AppHandle<R>,
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
