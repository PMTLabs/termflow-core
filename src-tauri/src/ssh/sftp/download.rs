//! Fenced SFTP downloads into exclusively staged local files.
use super::{
    budget, child_path, error,
    local_target::{create_child_dir_exclusive, display_path, validate_local_name, FileTarget, LocalError, LocalNameError, PlannedNames, StagedFile},
    session_error, status, validate, wire_error, Admission, BoxFuture, FileAttributes, FsCode,
    FsError, FsOutcome, OpenFlags, RemoteFs, SessionError, StatusCode, WireError, MAX_ENTRIES,
};
use russh_sftp::protocol::FileType;
use serde::Serialize;
use std::{future::Future, io, path::{Path, PathBuf}};
use tokio_util::sync::CancellationToken;

const OP: &str = "download";
const READ_SIZE: u32 = 32 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDownloadOutcome {
    pub local_path: PathBuf,
    pub bytes_written: u64,
}

#[derive(Debug)]
pub struct DownloadOutcome {
    pub local_path: PathBuf,
    pub files: usize,
    /// Includes the newly created root directory.
    pub dirs: usize,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DownloadResult {
    Cancelled,
    Done { local_path: PathBuf, files: usize, dirs: usize },
}

pub enum DownloadPicker {
    Save { default_name: Option<String> },
    Folder,
}

struct DownloadNode {
    path: String,
    // Some (including an empty vec) means a directory; None is a regular file.
    children: Option<Vec<DownloadNode>>,
}

impl RemoteFs<'_> {
    pub async fn download_with_picker<F, Fut>(
        &self,
        path: &str,
        cancel: &CancellationToken,
        pick: F,
    ) -> Result<DownloadResult, FsError>
    where
        F: FnOnce(DownloadPicker) -> Fut + Send,
        Fut: Future<Output = Result<Option<PathBuf>, &'static str>> + Send,
    {
        validate(OP, path, false)?;
        let a = admit(self, path, cancel).await?;
        check_remote_parents(&a, path, cancel).await?;
        let kind = remote_type(&a, path, cancel).await?;
        let picker = match kind {
            FileType::File => {
                let name = basename(path);
                DownloadPicker::Save { default_name: validate_local_name(name).ok().map(|_| name.to_owned()) }
            }
            FileType::Dir => DownloadPicker::Folder,
            _ => return Err(unsupported_type(path)),
        };
        let picked = match pick(picker).await {
            Ok(None) => return Ok(DownloadResult::Cancelled),
            picked => picked,
        };
        check_fence(&a, path, cancel)?;
        drop(a);
        let picked = picked.map_err(|detail| failure(path, FsCode::Io, detail))?
            .expect("cancelled picker handled above");
        // Resolve only the user-selected base, not the Save leaf or anything
        // subsequently created below it. Snapshot Save immediately afterward.
        let base = if kind == FileType::File {
            picked.parent().ok_or_else(|| local_error(path, &picked, LocalError::Conflict))?
        } else {
            picked.as_path()
        };
        let base = base.canonicalize().map_err(|err| local_error(path, base, LocalError::Io(err)))?;
        let result = if kind == FileType::File {
            let name = picked.file_name().ok_or_else(|| local_error(path, &picked, LocalError::InvalidName))?;
            let destination = base.join(name);
            let target = FileTarget::from_save_dialog(destination.clone())
                .map_err(|err| local_error(path, &destination, err))?;
            let file = self.download_file(path, target, cancel).await?;
            DownloadOutcome { local_path: file.local_path, files: 1, dirs: 0 }
        } else {
            self.download_dir(path, &base, cancel).await?
        };
        Ok(DownloadResult::Done {
            local_path: display_path(result.local_path), files: result.files, dirs: result.dirs,
        })
    }

    pub async fn download_dir(
        &self,
        remote_dir: &str,
        picked_parent: &Path,
        cancel: &CancellationToken,
    ) -> Result<DownloadOutcome, FsError> {
        validate(OP, remote_dir, true)?;
        let a = admit(self, remote_dir, cancel).await?;
        check_remote_parents(&a, remote_dir, cancel).await?;
        let kind = remote_type(&a, remote_dir, cancel).await?;
        if kind != FileType::Dir {
            return Err(failure(remote_dir, FsCode::Unsupported, "Only real remote directories can be downloaded as folders."));
        }
        check_name(remote_dir, basename(remote_dir))?;
        let mut remaining = MAX_ENTRIES;
        let root = preflight(&a, remote_dir.into(), kind, &mut remaining, cancel).await?;

        check_remote_parents(&a, remote_dir, cancel).await?;
        require_directory(&a, remote_dir, cancel).await?;
        let local_path = make_directory(&a, remote_dir, picked_parent, cancel)?;
        let mut completed = Vec::new();
        let mut dirs = 1;
        copy_children(&a, &root, &local_path, cancel, &mut completed, &mut dirs)
            .await.map_err(|err| {
                // The exclusive root already exists, even if the first file
                // failed. Only committed files are listed, not directories.
                let detail = err.message.trim_end_matches(" Destination unchanged.")
                    .trim_end_matches(" Nothing was changed.");
                let mut partial = error(OP, &err.path, err.code, FsOutcome::Partial, detail);
                partial.completed_paths = Some(completed.iter().map(|path| {
                    display_path(path.clone()).to_string_lossy().into_owned()
                }).collect());
                partial
            })?;
        Ok(DownloadOutcome { local_path, files: completed.len(), dirs })
    }

    pub async fn download_file(
        &self,
        remote_path: &str,
        target: FileTarget,
        cancel: &CancellationToken,
    ) -> Result<FileDownloadOutcome, FsError> {
        self.download_with(remote_path, target, cancel, || {}).await
    }

    async fn download_with(
        &self,
        path: &str,
        target: FileTarget,
        cancel: &CancellationToken,
        before_commit: impl FnOnce() + Send,
    ) -> Result<FileDownloadOutcome, FsError> {
        validate(OP, path, true)?;
        let a = admit(self, path, cancel).await?;
        check_remote_parents(&a, path, cancel).await?;
        transfer_file(&a, path, target, cancel, before_commit).await
    }
}

async fn transfer_file(
    a: &Admission<'_>,
    path: &str,
    target: FileTarget,
    cancel: &CancellationToken,
    before_commit: impl FnOnce() + Send,
) -> Result<FileDownloadOutcome, FsError> {
    if remote_type(a, path, cancel).await? != FileType::File {
        return Err(failure(path, FsCode::Unsupported, "Only regular remote files can be downloaded."));
    }

    check_fence(a, path, cancel)?;
    let local = |err| local_error(path, target.path(), err);
    let mut part = target.stage().map_err(local)?;
    check_fence(a, path, cancel)?;
    // Let OPEN finish within the lease timeout: discarding a late handle
    // on user cancellation would leave it open on the shared SFTP channel.
    let handle = request_result(path, a.request(path, false, |c| {
        Box::pin(c.open(path, OpenFlags::READ, FileAttributes::default()))
    }).await)?.handle;
    let bytes_written = match stream(a, path, &handle, &mut part, cancel, local).await {
        Ok(bytes) => bytes,
        Err(err) => {
            // Clean the staging file before waiting on best-effort remote close.
            drop(part);
            let _ = a.request(path, false, |c| Box::pin(c.close(handle))).await;
            return Err(err);
        }
    };
    let closed = a.request(path, false, |c| Box::pin(c.close(handle))).await;
    if cancel.is_cancelled() {
        return Err(cancelled(path));
    }
    request_result(path, closed)?;

    before_commit();
    // No await between the final session fence and the local commit.
    check_fence(a, path, cancel).map_err(|err| {
        if err.code == FsCode::NotConnected { unconfirmed(path) } else { err }
    })?;
    let destination = target.path().to_owned();
    let local_path = target.commit(part).map_err(|err| local_error(path, &destination, err))?;
    Ok(FileDownloadOutcome { local_path, bytes_written })
}

async fn admit<'a>(fs: &'a RemoteFs<'a>, path: &str, cancel: &CancellationToken) -> Result<Admission<'a>, FsError> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(cancelled(path)),
        result = fs.admit(OP, path) => result,
    }
}

fn check_fence(a: &Admission<'_>, path: &str, cancel: &CancellationToken) -> Result<(), FsError> {
    a.recheck().map_err(|err| session_error(OP, path, err, false))?;
    if cancel.is_cancelled() || a.session.cancellation().is_cancelled() {
        return Err(cancelled(path));
    }
    Ok(())
}

fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or_default()
}

fn check_name(path: &str, name: &str) -> Result<(), FsError> {
    validate_local_name(name).map_err(|_| failure(path, FsCode::InvalidPath, "Invalid local name."))
}

fn unsupported_type(path: &str) -> FsError {
    failure(path, FsCode::Unsupported, "Only regular files and real directories can be downloaded.")
}

async fn remote_type(a: &Admission<'_>, path: &str, cancel: &CancellationToken) -> Result<FileType, FsError> {
    let attrs = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(cancelled(path)),
        result = a.request(path, false, |c| Box::pin(c.lstat(path))) => request_result(path, result)?,
    }.attrs;
    Ok(attrs.file_type())
}

async fn require_directory(a: &Admission<'_>, path: &str, cancel: &CancellationToken) -> Result<(), FsError> {
    if remote_type(a, path, cancel).await? != FileType::Dir {
        return Err(failure(path, FsCode::Unsupported, "Remote path is not a real directory."));
    }
    Ok(())
}

async fn check_remote_parents(a: &Admission<'_>, path: &str, cancel: &CancellationToken) -> Result<(), FsError> {
    for (end, _) in path.match_indices('/').skip(1) {
        require_directory(a, &path[..end], cancel).await?;
    }
    Ok(())
}

async fn directory_children(
    a: &Admission<'_>, path: &str, remaining: &mut usize, cancel: &CancellationToken,
) -> Result<Vec<String>, FsError> {
    // Like file OPEN, await the bounded OPENDIR response so we can close the
    // handle even if cancellation arrives before it is acknowledged.
    check_fence(a, path, cancel)?;
    let handle = request_result(path, a.request(path, false, |c| Box::pin(c.opendir(path))).await)?.handle;
    let listed = async {
        let mut children = Vec::new();
        let mut names = PlannedNames::default();
        loop {
            let reply = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(cancelled(path)),
                reply = a.request(path, false, |c| Box::pin(c.readdir(handle.as_str()))) => reply,
            };
            if matches!(&reply, Ok(Err(err)) if status(err) == Some(StatusCode::Eof)) {
                break;
            }
            let batch = request_result(path, reply)?;
            if batch.files.is_empty() {
                return Err(failure(path, FsCode::Io, "Empty READDIR packet without EOF."));
            }
            *remaining = remaining.checked_sub(batch.files.len()).ok_or_else(|| budget(OP, path))?;
            for file in batch.files {
                let name = file.filename;
                if matches!(name.as_str(), "." | "..") {
                    continue; // SFTP directory pseudo-entries, not children.
                }
                let child = child_path(path, &name).ok_or_else(|| {
                    failure(&format!("{path}/{name}"), FsCode::InvalidPath, "Invalid remote child name.")
                })?;
                names.insert(&name).map_err(|err| match err {
                    LocalNameError::Invalid => failure(&child, FsCode::InvalidPath, "Invalid local name."),
                    LocalNameError::Collision => failure(&child, FsCode::Conflict, "Case-insensitive local name collision."),
                })?;
                validate(OP, &child, true)?;
                children.push(child);
            }
        }
        children.sort_unstable();
        Ok(children)
    }.await;
    let closed = a.request(path, false, |c| Box::pin(c.close(handle))).await;
    let children = listed?;
    request_result(path, closed)?;
    check_fence(a, path, cancel)?;
    Ok(children)
}

fn preflight<'a>(
    a: &'a Admission<'_>, path: String, kind: FileType, remaining: &'a mut usize,
    cancel: &'a CancellationToken,
) -> BoxFuture<'a, Result<DownloadNode, FsError>> {
    Box::pin(async move {
        let children = match kind {
            FileType::File => None,
            FileType::Dir => {
                let mut children = Vec::new();
                for child in directory_children(a, &path, remaining, cancel).await? {
                    check_remote_parents(a, &child, cancel).await?;
                    let kind = remote_type(a, &child, cancel).await?;
                    children.push(preflight(a, child, kind, remaining, cancel).await?);
                }
                Some(children)
            }
            _ => return Err(unsupported_type(&path)),
        };
        Ok(DownloadNode { path, children })
    })
}

fn make_directory(a: &Admission<'_>, path: &str, parent: &Path, cancel: &CancellationToken) -> Result<PathBuf, FsError> {
    let name = basename(path);
    check_fence(a, path, cancel)?;
    create_child_dir_exclusive(parent, name).map_err(|err| local_error(path, &parent.join(name), err))
}

fn copy_children<'a>(
    a: &'a Admission<'_>, node: &'a DownloadNode, local: &'a Path, cancel: &'a CancellationToken,
    completed: &'a mut Vec<PathBuf>, dirs: &'a mut usize,
) -> BoxFuture<'a, Result<(), FsError>> {
    Box::pin(async move {
        for child in node.children.as_deref().unwrap_or_default() {
            // SFTP v3 has no handle-relative LSTAT/OPEN or O_NOFOLLOW;
            // these checks cannot make remote pathname lookup race-free.
            check_remote_parents(a, &child.path, cancel).await?;
            if child.children.is_some() {
                require_directory(a, &child.path, cancel).await?;
                let folder = make_directory(a, &child.path, local, cancel)?;
                *dirs += 1;
                copy_children(a, child, &folder, cancel, completed, dirs).await?;
            } else {
                let target = FileTarget::no_replace(local.join(basename(&child.path)));
                let result = transfer_file(a, &child.path, target, cancel, || {}).await?;
                completed.push(result.local_path);
            }
        }
        Ok(())
    })
}

async fn stream(
    a: &Admission<'_>,
    path: &str,
    handle: &str,
    part: &mut StagedFile,
    cancel: &CancellationToken,
    local: impl Fn(LocalError) -> FsError + Send,
) -> Result<u64, FsError> {
    let mut offset = 0u64;
    loop {
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(cancelled(path)),
            result = a.request(path, false, |c| Box::pin(c.read(handle, offset, READ_SIZE))) => result,
        };
        if matches!(&result, Ok(Err(err)) if status(err) == Some(StatusCode::Eof)) {
            return Ok(offset);
        }
        let data = request_result(path, result)?.data;
        if data.is_empty() || data.len() > READ_SIZE as usize {
            return Err(failure(path, FsCode::Io, "Invalid SFTP READ reply length."));
        }
        part.write_all(&data).map_err(&local)?;
        offset = offset.checked_add(data.len() as u64)
            .ok_or_else(|| failure(path, FsCode::Unsupported, "Remote file is too large."))?;
    }
}

fn request_result<T>(path: &str, result: Result<Result<T, WireError>, FsError>) -> Result<T, FsError> {
    match result {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(err)) => match status(&err) {
            Some(StatusCode::NoConnection | StatusCode::ConnectionLost) | None => Err(unconfirmed(path)),
            _ => Err(wire_error(OP, path, err, false)),
        },
        Err(err) if err.code == FsCode::Io => Err(unconfirmed(path)),
        Err(err) => Err(err),
    }
}

fn local_error(path: &str, destination: &std::path::Path, err: LocalError) -> FsError {
    let (code, detail) = match err {
        LocalError::InvalidName => (FsCode::InvalidPath, "Invalid local name"),
        LocalError::Conflict => (FsCode::Conflict, "Local destination exists, changed, or is not safe"),
        LocalError::Exists => (FsCode::Exists, "Local directory destination already exists; merging is not supported"),
        LocalError::Unsupported => (FsCode::Unsupported, "Local filesystem does not support the no-replace hard-link commit"),
        LocalError::Io(err) if err.kind() == io::ErrorKind::PermissionDenied => (FsCode::PermissionDenied, "Local access was denied"),
        LocalError::Io(_) => (FsCode::Io, "Local write failed"),
    };
    let mut err = failure(path, code, detail);
    let destination = display_path(destination.to_owned());
    err.message = format!("{OP} on {path}: {detail} ({}). Destination unchanged.", destination.display());
    err
}

fn failure(path: &str, code: FsCode, detail: &str) -> FsError {
    error(OP, path, code, FsOutcome::Unchanged, detail)
}

fn unconfirmed(path: &str) -> FsError {
    failure(path, FsCode::Io, "Could not confirm the SFTP transfer. Destination unchanged.")
}

fn cancelled(path: &str) -> FsError {
    failure(path, FsCode::Cancelled, "Download cancelled. Destination unchanged.")
}

#[cfg(test)]
#[path = "download_tests.rs"]
mod tests;
