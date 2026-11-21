//! Launch only a trusted editor or an explicitly chosen application; never
//! dispatch the downloaded copy through its default file association.
use super::{
    edit::EditRegistry, error, session_error, validate, BoxFuture, FsCode, FsError, FsOutcome, RemoteFs,
};
use crate::open_commands::launch_editor;
use serde::Serialize;
use std::{path::{Path, PathBuf}, sync::Arc};
use tauri::{Runtime, WebviewWindow};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum LaunchOutcome {
    Launched,
    Cancelled,
}

type LaunchResult = Result<LaunchOutcome, String>;

pub(crate) trait EditorLauncher: Sync {
    fn text(&self, editor: Option<&str>, path: &Path) -> LaunchResult;
    fn open_with<'a>(&'a self, path: &'a Path, fence: &'a CancellationToken) -> BoxFuture<'a, LaunchResult>;
}

pub(crate) struct NativeEditor<R: Runtime>(pub WebviewWindow<R>);

impl<R: Runtime> EditorLauncher for NativeEditor<R> {
    fn text(&self, editor: Option<&str>, path: &Path) -> LaunchResult {
        if let Some(editor) = editor {
            launch_editor(editor, &crate::open_commands::path_to_string(path.to_owned()))?;
        } else {
            #[cfg(any(windows, target_os = "macos"))]
            crate::open_commands::open_in_text_editor(&crate::open_commands::path_to_string(path.to_owned()))?;
            #[cfg(not(any(windows, target_os = "macos")))]
            return Err("Choose a text editor first.".into());
        }
        Ok(LaunchOutcome::Launched)
    }

    fn open_with<'a>(&'a self, path: &'a Path, fence: &'a CancellationToken) -> BoxFuture<'a, LaunchResult> {
        #[cfg(windows)]
        return Box::pin(with_windows_owner(self.0.clone(), path.to_owned(), fence.clone(), windows_chooser));
        #[cfg(not(windows))]
        Box::pin(pick_application(&self.0, path, fence))
    }
}

#[cfg(windows)]
async fn with_windows_owner<R: Runtime>(
    window: WebviewWindow<R>, path: PathBuf, fence: CancellationToken,
    chooser: impl FnOnce(windows::Win32::Foundation::HWND, &Path) -> LaunchResult + Send + 'static,
) -> LaunchResult {
    use tauri::Manager;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let app = window.app_handle().clone();
    app.run_on_main_thread(move || {
        let result = (|| {
            if fence.is_cancelled() { return Ok(LaunchOutcome::Cancelled); }
            let hwnd = window.hwnd().map_err(|e| e.to_string())?;
            if hwnd.0.is_null() { return Err("Missing Open with owner window.".into()); }
            chooser(hwnd, &path)
        })();
        let _ = tx.send(result);
    }).map_err(|e| e.to_string())?;
    rx.await.map_err(|_| "Open with did not return a result.".to_owned())?
}

#[cfg(windows)]
fn windows_chooser(hwnd: windows::Win32::Foundation::HWND, path: &Path) -> LaunchResult {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::{HRESULT, PCWSTR},
        Win32::{Foundation::ERROR_CANCELLED, UI::Shell::{SHOpenWithDialog, OAIF_EXEC, OPENASINFO}},
    };
    let path = crate::open_commands::path_to_string(path.to_owned());
    let wide: Vec<u16> = std::ffi::OsStr::new(&path).encode_wide().chain(Some(0)).collect();
    let info = OPENASINFO { pcszFile: PCWSTR(wide.as_ptr()), pcszClass: PCWSTR::null(), oaifInFlags: OAIF_EXEC };
    // The owning Tao window initialized OLE on this UI/STA thread. Neither
    // OAIF_ALLOW_REGISTRATION nor OAIF_REGISTER_EXT is requested.
    match unsafe { SHOpenWithDialog(Some(hwnd), &info) } {
        Ok(()) => Ok(LaunchOutcome::Launched),
        Err(e) if e.code() == HRESULT::from_win32(ERROR_CANCELLED.0) => Ok(LaunchOutcome::Cancelled),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(not(windows))]
async fn pick_application<R: Runtime>(window: &WebviewWindow<R>, path: &Path, fence: &CancellationToken) -> LaunchResult {
    use tauri_plugin_dialog::DialogExt;
    let dialog = window.dialog().file().set_parent(window);
    #[cfg(target_os = "macos")]
    let dialog = dialog.set_title("Choose an application").add_filter("Applications", &["app"]);
    #[cfg(not(target_os = "macos"))]
    let dialog = dialog.set_title("Choose an editor executable");
    let (tx, rx) = tokio::sync::oneshot::channel();
    dialog.pick_file(move |picked| { let _ = tx.send(picked); });
    let picked = tokio::select! {
        biased;
        _ = fence.cancelled() => return Ok(LaunchOutcome::Cancelled),
        result = rx => result.map_err(|_| "Open with did not return a result.".to_owned())?,
    };
    let Some(picked) = picked else { return Ok(LaunchOutcome::Cancelled); };
    let exe = picked.into_path().map_err(|_| "Choose a local application.".to_owned())?;
    if fence.is_cancelled() { return Ok(LaunchOutcome::Cancelled); }
    #[cfg(target_os = "macos")]
    {
        if !exe.is_dir() || !exe.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("app")) {
            return Err("Choose a macOS application bundle.".into());
        }
        let path = path.to_owned();
        let fence = fence.clone();
        tokio::task::spawn_blocking(move || {
            if fence.is_cancelled() { return Ok(LaunchOutcome::Cancelled); }
            let status = crate::open_commands::mac_editor_command(&exe, &path).status().map_err(|e| e.to_string())?;
            if !status.success() { return Err(format!("open exited with {status}")); }
            Ok(LaunchOutcome::Launched)
        }).await.map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let resolved = exe.canonicalize().map_err(|e| e.to_string())?;
        if resolved == path.canonicalize().map_err(|e| e.to_string())? {
            return Err("Choose an editor, not the file being edited.".into());
        }
        if fence.is_cancelled() { return Ok(LaunchOutcome::Cancelled); }
        std::process::Command::new(exe).arg(path).spawn().map_err(|e| e.to_string())?;
        Ok(LaunchOutcome::Launched)
    }
}

pub(crate) enum OpenMode<'a> {
    Text(Option<&'a str>),
    With,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum EditOpen {
    Opened {
        #[serde(rename = "editId")]
        edit_id: Uuid,
        state: super::edit::EditState,
        #[serde(rename = "localPath")]
        local_path: PathBuf,
    },
    Other { state: OpenStatus },
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OpenStatus {
    NeedsEditor,
    Cancelled,
}

impl EditRegistry {
    pub(crate) async fn open(
        self: &Arc<Self>, fs: &RemoteFs<'_>, path: &str, mode: OpenMode<'_>, launcher: &impl EditorLauncher,
    ) -> Result<EditOpen, FsError> {
        let operation = if matches!(mode, OpenMode::With) { "openWith" } else { "open" };
        validate(operation, path, true)?;
        let check_session = || fs.registry.lease_at(fs.terminal_id, fs.generation)
            .map_err(|e| session_error(operation, path, e, false));
        check_session()?;
        if cfg!(not(any(windows, target_os = "macos"))) && matches!(mode, OpenMode::Text(None)) {
            return Ok(EditOpen::Other { state: OpenStatus::NeedsEditor });
        }
        let job = self.begin_edit(fs, path).await?;
        let _launch = job.launching.lock().await;
        let record = job.record().await;
        let stale = || error(operation, path, FsCode::Stale, FsOutcome::Unchanged, "The edit is no longer active.");
        if job.cancellation().is_cancelled() { return Err(stale()); }
        if let Err(err) = check_session() {
            self.stop(&job).await;
            return Err(err);
        }
        let outcome = match mode {
            OpenMode::Text(editor) => launcher.text(editor, &record.local_path),
            OpenMode::With => launcher.open_with(&record.local_path, job.cancellation()).await,
        };
        if job.cancellation().is_cancelled() { return Err(stale()); }
        match outcome {
            Ok(LaunchOutcome::Launched) => {
                if let Err(err) = check_session() {
                    self.stop(&job).await;
                    return Err(err);
                }
                Ok(EditOpen::Opened { edit_id: record.edit_id, state: job.record().await.state, local_path: record.local_path })
            }
            Ok(LaunchOutcome::Cancelled) => {
                self.stop(&job).await;
                Ok(EditOpen::Other { state: OpenStatus::Cancelled })
            }
            Err(_) => {
                const DETAIL: &str = "Could not launch the editor. The local copy was retained.";
                self.stop_failed_launch(&job, DETAIL).await;
                let mut err = error(operation, path, FsCode::Io, FsOutcome::Unchanged, DETAIL);
                err.retained_local_path = Some(record.local_path.to_string_lossy().into_owned());
                Err(err)
            }
        }
    }
}

#[cfg(test)]
#[path = "launch_tests.rs"]
mod tests;
