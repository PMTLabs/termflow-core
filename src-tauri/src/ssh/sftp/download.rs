//! Single-file SFTP download; picker and recursive orchestration live outside this module.
use super::{
    error, local_target::{FileTarget, LocalError, StagedFile}, session_error, status, validate,
    wire_error, Admission, FileAttributes, FsCode, FsError, FsOutcome, OpenFlags, RemoteFs,
    SessionError, StatusCode, WireError,
};
use russh_sftp::protocol::FileType;
use serde::Serialize;
use std::{io, path::PathBuf};
use tokio_util::sync::CancellationToken;

const OP: &str = "download";
const READ_SIZE: u32 = 32 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadOutcome {
    pub local_path: PathBuf,
    pub bytes_written: u64,
}

impl RemoteFs<'_> {
    pub async fn download_file(
        &self,
        remote_path: &str,
        target: FileTarget,
        cancel: &CancellationToken,
    ) -> Result<DownloadOutcome, FsError> {
        self.download_with(remote_path, target, cancel, || {}).await
    }

    async fn download_with(
        &self,
        path: &str,
        target: FileTarget,
        cancel: &CancellationToken,
        before_commit: impl FnOnce() + Send,
    ) -> Result<DownloadOutcome, FsError> {
        validate(OP, path, true)?;
        let a = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(cancelled(path)),
            result = self.admit(OP, path) => result?,
        };
        let lease_cancel = a.session.cancellation();
        let attrs = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(cancelled(path)),
            result = a.request(path, false, |c| Box::pin(c.lstat(path))) => request_result(path, result)?,
        }.attrs;
        if attrs.file_type() != FileType::File {
            return Err(failure(path, FsCode::Unsupported, "Only regular remote files can be downloaded."));
        }

        let local = |err| local_error(path, target.path(), err);
        let mut part = target.stage().map_err(local)?;
        if cancel.is_cancelled() {
            return Err(cancelled(path));
        }
        // Let OPEN finish within the lease timeout: discarding a late handle
        // on user cancellation would leave it open on the shared SFTP channel.
        let handle = request_result(path, a.request(path, false, |c| {
            Box::pin(c.open(path, OpenFlags::READ, FileAttributes::default()))
        }).await)?.handle;
        let bytes_written = match stream(&a, path, &handle, &mut part, cancel, local).await {
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
        a.recheck().map_err(|err| match err {
            SessionError::NotConnected => unconfirmed(path),
            err => session_error(OP, path, err, false),
        })?;
        if cancel.is_cancelled() || lease_cancel.is_cancelled() {
            return Err(cancelled(path));
        }
        let destination = target.path().to_owned();
        let local_path = target.commit(part).map_err(|err| local_error(path, &destination, err))?;
        Ok(DownloadOutcome { local_path, bytes_written })
    }
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
        LocalError::Unsupported => (FsCode::Unsupported, "Local filesystem does not support the no-replace hard-link commit"),
        LocalError::Io(err) if err.kind() == io::ErrorKind::PermissionDenied => (FsCode::PermissionDenied, "Local access was denied"),
        LocalError::Io(_) => (FsCode::Io, "Local write failed"),
    };
    let mut err = failure(path, code, detail);
    err.message = format!("{OP} on {path}: {detail} ({}). Destination unchanged.", destination.display());
    err
}

fn failure(path: &str, code: FsCode, detail: &str) -> FsError {
    error(OP, path, code, FsOutcome::Unchanged, detail)
}

fn unconfirmed(path: &str) -> FsError {
    failure(path, FsCode::Unknown, "Could not confirm the SFTP transfer; destination unchanged.")
}

fn cancelled(path: &str) -> FsError {
    failure(path, FsCode::Cancelled, "Download cancelled; destination unchanged.")
}

#[cfg(test)]
#[path = "download_tests.rs"]
mod tests;
