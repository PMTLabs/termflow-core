use russh_sftp::protocol::{FileAttributes, FileType};
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RemoteKind {
    File,
    Directory,
    Symlink,
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub name: String,
    pub path: String,
    pub kind: RemoteKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtime: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub atime: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gid: Option<u32>,
}

impl RemoteEntry {
    pub(super) fn new(name: String, path: String, attrs: FileAttributes) -> Self {
        let kind = match attrs.file_type() {
            FileType::File => RemoteKind::File,
            FileType::Dir => RemoteKind::Directory,
            FileType::Symlink => RemoteKind::Symlink,
            FileType::Other => RemoteKind::Other,
        };
        Self {
            name,
            path,
            kind,
            size: attrs.size.map(|size| size.to_string()),
            mtime: attrs.mtime,
            atime: attrs.atime,
            mode: attrs.permissions,
            uid: attrs.uid,
            gid: attrs.gid,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStat {
    #[serde(flatten)]
    pub entry: RemoteEntry,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link_target: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteListing {
    pub path: String,
    pub entries: Vec<RemoteEntry>,
    pub session_generation: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FsCode {
    NotConnected,
    PermissionDenied,
    NotFound,
    Exists,
    Unsupported,
    InvalidPath,
    Conflict,
    Io,
    Cancelled,
    Stale,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FsOutcome {
    Unchanged,
    Partial,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsError {
    pub code: FsCode,
    pub operation: &'static str,
    pub path: String,
    pub message: String,
    pub outcome: FsOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_paths: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retained_local_path: Option<String>,
}
