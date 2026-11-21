use super::*;
use russh_sftp::protocol::FileType;

const MODE_BITS: u32 = 0o7777;
const TYPE_BITS: u32 = 0o170000;

struct DeleteNode {
    path: String,
    kind: FileType,
    children: Vec<DeleteNode>,
}

impl RemoteFs<'_> {
    pub async fn delete(&self, path: &str, recursive: bool, confirmed: bool) -> Result<(), FsError> {
        self.delete_with(path, recursive, confirmed, &|_| {}).await
    }

    // The callback runs only after an acknowledged removal, allowing tests to
    // advance the generation exactly between mutations without racing an ACK.
    pub(super) async fn delete_with(
        &self,
        path: &str,
        recursive: bool,
        confirmed: bool,
        after_remove: &(dyn Fn(&str) + Sync),
    ) -> Result<(), FsError> {
        let op = "delete";
        validate(op, path, true)?;
        if !confirmed {
            return Err(error(op, path, FsCode::InvalidPath, FsOutcome::Unchanged,
                "Delete requires confirmation."));
        }
        let a = self.admit(op, path).await?;
        let kind = a.delete_kind(path).await?;
        if kind == FileType::Dir && !recursive {
            return Err(error(op, path, FsCode::InvalidPath, FsOutcome::Unchanged,
                "Deleting a directory requires recursive confirmation."));
        }
        let mut remaining = MAX_ENTRIES;
        let tree = a.preflight_delete(path.into(), kind, &mut remaining).await?;
        let mut completed = Vec::new();
        a.remove_tree(&tree, &mut completed, after_remove).await.map_err(|mut err| {
            if !completed.is_empty() {
                if err.outcome == FsOutcome::Unchanged {
                    // Preserve the failing path and reason, but never say that
                    // nothing changed when earlier removals were acknowledged.
                    let detail = match err.code {
                        FsCode::Conflict => "A path is no longer a real directory.",
                        FsCode::PermissionDenied => "Permission denied.",
                        FsCode::Stale => "The SSH session has changed.",
                        _ => "A subsequent step failed.",
                    };
                    err = error(op, &err.path, err.code, FsOutcome::Partial, detail);
                }
                err.completed_paths = Some(completed);
            }
            err
        })
    }

    pub async fn chmod(&self, path: &str, mode: u32) -> Result<(), FsError> {
        let op = "chmod";
        validate(op, path, true)?;
        if mode > MODE_BITS {
            return Err(error(op, path, FsCode::InvalidPath, FsOutcome::Unchanged,
                "Mode must be between 0 and 07777 (octal)."));
        }
        self.set_permissions(op, path, |current| Ok(FileAttributes {
            permissions: Some((current.permissions.unwrap_or_default() & TYPE_BITS) | mode),
            ..FileAttributes::empty()
        })).await
    }

    pub async fn chown(&self, path: &str, uid: Option<u32>, gid: Option<u32>) -> Result<(), FsError> {
        let op = "chown";
        validate(op, path, true)?;
        if uid.is_none() && gid.is_none() {
            return Err(error(op, path, FsCode::InvalidPath, FsOutcome::Unchanged,
                "Specify a numeric UID or GID."));
        }
        self.set_permissions(op, path, |current| {
            // SFTP v3 encodes UID and GID as a pair. russh-sftp serializes
            // an omitted counterpart as zero, so supply its current value.
            let uid = uid.or(current.uid);
            let gid = gid.or(current.gid);
            if uid.is_none() || gid.is_none() {
                return Err(error(op, path, FsCode::Unsupported, FsOutcome::Unchanged,
                    "The server did not report the owner or group needed to preserve it."));
            }
            Ok(FileAttributes { uid, gid, ..FileAttributes::empty() })
        }).await
    }

    async fn set_permissions(
        &self,
        op: &'static str,
        path: &str,
        update: impl FnOnce(FileAttributes) -> Result<FileAttributes, FsError> + Send,
    ) -> Result<(), FsError> {
        let a = self.admit(op, path).await?;
        let initial = a.lstat(path).await?.file_type();
        if !matches!(initial, FileType::Dir | FileType::File) {
            return Err(error(op, path, FsCode::Unsupported, FsOutcome::Unchanged,
                "Only regular files and directories support this operation."));
        }
        let current = a.lstat(path).await?;
        if current.file_type() != initial {
            return Err(error(op, path, FsCode::Conflict, FsOutcome::Unchanged,
                "The target changed type."));
        }
        let attrs = update(current)?;
        a.request(path, true, |c| Box::pin(c.setstat(path, attrs))).await?
            .map(|_| ()).map_err(|err| wire_error(op, path, err, true))
    }
}

impl Admission<'_> {
    async fn lstat(&self, path: &str) -> Result<FileAttributes, FsError> {
        Ok(self.read(path, |c| Box::pin(c.lstat(path))).await?.attrs)
    }

    async fn delete_kind(&self, path: &str) -> Result<FileType, FsError> {
        let attrs = self.lstat(path).await?;
        if attrs.permissions.unwrap_or_default() & TYPE_BITS == 0 {
            return Err(error(self.op, path, FsCode::Unsupported, FsOutcome::Unchanged,
                "The server did not report the target's file type."));
        }
        Ok(attrs.file_type())
    }

    async fn require_directory(&self, path: &str) -> Result<(), FsError> {
        self.recheck().map_err(|err| session_error(self.op, path, err, false))?;
        match self.lstat(path).await {
            Ok(attrs) if attrs.file_type() == FileType::Dir => return Ok(()),
            Err(err) if err.code != FsCode::NotFound => return Err(err),
            _ => {}
        }
        Err(error(self.op, path, FsCode::Conflict, FsOutcome::Unchanged,
            "The path is no longer a real directory."))
    }

    async fn delete_children(&self, path: &str, remaining: &mut usize) -> Result<Vec<String>, FsError> {
        // No REALPATH: unlike browser navigation, delete must not resolve links.
        self.require_directory(path).await?;
        let handle = self.read(path, |c| Box::pin(c.opendir(path))).await?.handle;
        let result = async {
            let mut paths = Vec::new();
            loop {
                let batch = match self.request(path, false, |c| Box::pin(c.readdir(handle.as_str()))).await? {
                    Ok(batch) => batch,
                    Err(err) if status(&err) == Some(StatusCode::Eof) => break,
                    Err(err) => return Err(wire_error(self.op, path, err, false)),
                };
                if batch.files.is_empty() {
                    return Err(error(self.op, path, FsCode::Io, FsOutcome::Unchanged,
                        "Empty READDIR packet without EOF."));
                }
                *remaining = remaining.checked_sub(batch.files.len()).ok_or_else(|| budget(self.op, path))?;
                for file in batch.files {
                    if matches!(file.filename.as_str(), "." | "..") {
                        continue;
                    }
                    let child = child_path(path, &file.filename).ok_or_else(|| {
                        error(self.op, path, FsCode::Unsupported, FsOutcome::Unchanged,
                            "Directory contains a non-actionable name.")
                    })?;
                    validate(self.op, &child, true)?;
                    paths.push(child);
                }
            }
            paths.sort_unstable();
            if paths.windows(2).any(|pair| pair[0] == pair[1]) {
                return Err(error(self.op, path, FsCode::Conflict, FsOutcome::Unchanged,
                    "Directory contains duplicate names in its listing."));
            }
            Ok(paths)
        }.await;
        let closed = self.read(path, |c| Box::pin(c.close(handle))).await;
        let paths = result?;
        closed?;
        Ok(paths)
    }

    fn preflight_delete<'a>(
        &'a self,
        path: String,
        kind: FileType,
        remaining: &'a mut usize,
    ) -> BoxFuture<'a, Result<DeleteNode, FsError>> {
        Box::pin(async move {
            let mut children = Vec::new();
            if kind == FileType::Dir {
                for child in self.delete_children(&path, remaining).await? {
                    let kind = self.delete_kind(&child).await?;
                    children.push(self.preflight_delete(child, kind, remaining).await?);
                }
            }
            Ok(DeleteNode { path, kind, children })
        })
    }

    fn remove_tree<'a>(
        &'a self,
        node: &'a DeleteNode,
        completed: &'a mut Vec<String>,
        after_remove: &'a (dyn Fn(&str) + Sync),
    ) -> BoxFuture<'a, Result<(), FsError>> {
        Box::pin(async move {
            let path = node.path.as_str();
            let result = if node.kind == FileType::Dir {
                // Check again before descending, including between siblings.
                // SFTP v3 has no handle-relative unlink/rmdir: the next
                // pathname request can still race a concurrent remote writer.
                for child in &node.children {
                    self.require_directory(path).await?;
                    self.remove_tree(child, completed, after_remove).await?;
                }
                self.require_directory(path).await?;
                self.request(path, true, |c| Box::pin(c.rmdir(path))).await?
            } else {
                // REMOVE unlinks the leaf, even if it is a symlink. It cannot
                // recurse into a newly appeared directory.
                self.request(path, true, |c| Box::pin(c.remove(path))).await?
            };
            result.map_err(|err| wire_error(self.op, path, err, true))?;
            completed.push(path.into());
            after_remove(path);
            Ok(())
        })
    }
}
