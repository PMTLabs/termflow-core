//! Revisioned, profile-scoped SSH definitions. Never expose persisted secrets over IPC.
use crate::app_config::{write_atomic, ConfigLock};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Mutex,
};

const STRING_BOUNDS: &[(&str, usize)] = &[
    ("name", 80),
    ("host", 255),
    ("user", 128),
    ("identityFile", 4096),
    ("extraOptions", 1024),
    ("id", 64),
    ("parentId", 64),
    ("folderId", 64),
    ("jumpConnectionId", 64),
    ("lastUsedAt", 64),
    ("secret", 16384),
];
pub const ICONS: &[&str] = &[
    "folder",
    "server",
    "cloud",
    "database",
    "globe",
    "home",
    "flask",
    "briefcase",
    "lock",
    "shield",
    "terminal",
    "container",
    "code",
    "chip",
    "team",
];
pub const COLORS: &[&str] = &["amber", "sky", "green", "violet", "orange", "grey"];
const ALLOWED_OPTIONS: &[&str] = &[
    "ServerAliveInterval",
    "ServerAliveCountMax",
    "TCPKeepAlive",
    "ConnectTimeout",
    "ConnectionAttempts",
    "Compression",
    "AddressFamily",
    "IPQoS",
    "LogLevel",
    "RekeyLimit",
    "LocalForward",
    "RemoteForward",
    "DynamicForward",
    "ExitOnForwardFailure",
    "ForwardAgent",
    "SendEnv",
    "SetEnv",
];
fn option_key_allowed(key: &str) -> Result<()> {
    if key.is_empty() || !key.bytes().all(|b| b.is_ascii_alphabetic()) {
        return Err(StoreError::field("extraOptions", "invalid-key"));
    }
    if !ALLOWED_OPTIONS
        .iter()
        .any(|allowed| key.eq_ignore_ascii_case(allowed))
    {
        return Err(StoreError::field("extraOptions", "option-not-allowed"));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoreError {
    pub field: Option<String>,
    pub code: String,
    pub message: String,
}
impl StoreError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            field: None,
            code: code.into(),
            message: message.into(),
        }
    }
    fn field(field: &str, code: &str) -> Self {
        Self {
            field: Some(field.into()),
            code: code.into(),
            message: format!("Invalid {field}: {code}"),
        }
    }
}
type Result<T> = std::result::Result<T, StoreError>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Auth {
    KeyFile,
    Agent,
    Password,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub icon: String,
    pub color: String,
    pub order: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: String,
    pub folder_id: Option<String>,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: Auth,
    pub identity_file: Option<String>,
    pub jump_connection_id: Option<String>,
    pub extra_options: Vec<(String, String)>,
    pub bookmarked: bool,
    pub order: usize,
    pub last_used_at: Option<String>,
    pub secret: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FolderInput {
    pub id: Option<String>,
    pub parent_id: Option<String>,
    pub name: String,
    pub icon: String,
    pub color: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionInput {
    pub id: Option<String>,
    pub folder_id: Option<String>,
    pub name: String,
    pub host: String,
    pub port: i64,
    pub user: String,
    pub auth: Auth,
    pub identity_file: Option<String>,
    pub jump_connection_id: Option<String>,
    pub extra_options: Vec<(String, String)>,
    pub bookmarked: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Persisted {
    pub version: u32,
    pub revision: u64,
    pub folders: Vec<Folder>,
    pub connections: Vec<Connection>,
}
impl Default for Persisted {
    fn default() -> Self {
        Self {
            version: 1,
            revision: 0,
            folders: vec![],
            connections: vec![],
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionView {
    pub id: String,
    pub folder_id: Option<String>,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: Auth,
    pub identity_file: Option<String>,
    pub jump_connection_id: Option<String>,
    pub extra_options: Vec<(String, String)>,
    pub bookmarked: bool,
    pub order: usize,
    pub last_used_at: Option<String>,
    pub has_saved_secret: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub revision: u64,
    pub folders: Vec<Folder>,
    pub connections: Vec<ConnectionView>,
    pub load_error: Option<StoreError>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    pub revision: u64,
    pub view: View,
}
impl Persisted {
    pub fn view(&self, load_error: Option<StoreError>) -> Reply {
        Reply {
            revision: self.revision,
            view: View {
                revision: self.revision,
                folders: self.folders.clone(),
                load_error,
                connections: self
                    .connections
                    .iter()
                    .map(|c| ConnectionView {
                        id: c.id.clone(),
                        folder_id: c.folder_id.clone(),
                        name: c.name.clone(),
                        host: c.host.clone(),
                        port: c.port,
                        user: c.user.clone(),
                        auth: c.auth.clone(),
                        identity_file: c.identity_file.clone(),
                        jump_connection_id: c.jump_connection_id.clone(),
                        extra_options: c.extra_options.clone(),
                        bookmarked: c.bookmarked,
                        order: c.order,
                        last_used_at: c.last_used_at.clone(),
                        has_saved_secret: c.secret.is_some(),
                    })
                    .collect(),
            },
        }
    }
    fn normalize(&mut self) {
        // Hand-edited valid bracketed IPv6 is served in the same bare form as IPC input.
        for connection in &mut self.connections {
            connection.host = bare_host(&connection.host).into();
        }
        self.folders.sort_by_key(|f| f.order);
        self.connections.sort_by_key(|c| c.order);
        let parents: HashSet<_> = self
            .folders
            .iter()
            .map(|f| f.parent_id.clone())
            .chain(self.connections.iter().map(|c| c.folder_id.clone()))
            .collect();
        for parent in parents {
            let mut rows: Vec<_> = self
                .folders
                .iter()
                .filter(|f| f.parent_id == parent)
                .map(|f| (f.order, f.id.clone()))
                .chain(
                    self.connections
                        .iter()
                        .filter(|c| c.folder_id == parent)
                        .map(|c| (c.order, c.id.clone())),
                )
                .collect();
            rows.sort_by_key(|r| r.0);
            for (order, (_, id)) in rows.into_iter().enumerate() {
                if let Some(f) = self.folders.iter_mut().find(|f| f.id == id) {
                    f.order = order;
                }
                if let Some(c) = self.connections.iter_mut().find(|c| c.id == id) {
                    c.order = order;
                }
            }
        }
    }
    fn depth(&self, id: &str) -> Result<usize> {
        let mut seen = HashSet::new();
        let mut current = Some(id);
        let mut depth = 0;
        while let Some(id) = current {
            if !seen.insert(id) {
                return Err(StoreError::field("parentId", "cycle"));
            }
            let folder = self
                .folders
                .iter()
                .find(|f| f.id == id)
                .ok_or_else(|| StoreError::field("parentId", "not-found"))?;
            depth += 1;
            if depth > 8 {
                return Err(StoreError::field("parentId", "depth"));
            }
            current = folder.parent_id.as_deref();
        }
        Ok(depth)
    }
    pub fn validate(&self) -> Result<()> {
        if self.version != 1 {
            return Err(StoreError::new(
                "unsupported-version",
                "Unsupported SSH store version",
            ));
        }
        let mut ids = HashSet::new();
        for id in self
            .folders
            .iter()
            .map(|f| &f.id)
            .chain(self.connections.iter().map(|c| &c.id))
        {
            if !ids.insert(id) {
                return Err(StoreError::new("duplicate-id", "Duplicate SSH store id"));
            }
        }
        for f in &self.folders {
            identifier(&f.id, "id")?;
            if let Some(id) = &f.parent_id {
                identifier(id, "parentId")?;
            }
            name(&f.name)?;
            if !ICONS.contains(&f.icon.as_str()) {
                return Err(StoreError::field("icon", "invalid"));
            }
            if !COLORS.contains(&f.color.as_str()) {
                return Err(StoreError::field("color", "invalid"));
            }
            self.depth(&f.id)?;
        }
        for c in &self.connections {
            identifier(&c.id, "id")?;
            for (field, value) in [
                ("folderId", &c.folder_id),
                ("jumpConnectionId", &c.jump_connection_id),
            ] {
                if let Some(id) = value {
                    identifier(id, field)?;
                }
            }
            for (field, value) in [("lastUsedAt", &c.last_used_at), ("secret", &c.secret)] {
                if let Some(value) = value {
                    text(value, field)?;
                }
            }
            name(&c.name)?;
            if c.host.is_empty() {
                return Err(StoreError::field("host", "required"));
            }
            if c.host.starts_with('-') {
                return Err(StoreError::field("host", "leading-dash"));
            }
            if !valid_host(&c.host) {
                return Err(StoreError::field("host", "invalid"));
            }
            text(&c.host, "host")?;
            text(&c.user, "user")?;
            if c.port == 0 {
                return Err(StoreError::field("port", "range"));
            }
            if c.user.starts_with('-') {
                return Err(StoreError::field("user", "leading-dash"));
            }
            if c.user
                .chars()
                .any(|c| c.is_whitespace() || c.is_control() || c == '@')
            {
                return Err(StoreError::field("user", "invalid"));
            }
            if c.auth == Auth::KeyFile
                && c.identity_file.as_ref().is_none_or(|s| s.trim().is_empty())
            {
                return Err(StoreError::field("identityFile", "required"));
            }
            if let Some(path) = &c.identity_file {
                text(path, "identityFile")?;
            }
            if c.auth != Auth::KeyFile && c.identity_file.is_some() {
                return Err(StoreError::field("identityFile", "not-applicable"));
            }
            if let Some(id) = &c.folder_id {
                if !self.folders.iter().any(|f| &f.id == id) {
                    return Err(StoreError::field("folderId", "not-found"));
                }
            }
            if let Some(id) = &c.jump_connection_id {
                if id == &c.id {
                    return Err(StoreError::field("jumpConnectionId", "self"));
                }
                let jump = self
                    .connections
                    .iter()
                    .find(|j| &j.id == id)
                    .ok_or_else(|| StoreError::field("jumpConnectionId", "not-found"))?;
                if jump.jump_connection_id.is_some() {
                    return Err(StoreError::field("jumpConnectionId", "nested"));
                }
            }
            if c.extra_options.len() > 32 {
                return Err(StoreError::field("extraOptions", "too-many"));
            }
            for (key, value) in &c.extra_options {
                option_key_allowed(key)?;
                bounded(value, "extraOptions")?;
                if value.chars().any(char::is_control) {
                    return Err(StoreError::field("extraOptions", "invalid-value"));
                }
            }
        }
        Ok(())
    }
    pub fn upsert_folder(&mut self, input: FolderInput) -> Result<()> {
        let id = match input.id {
            Some(id) => {
                if !self.folders.iter().any(|f| f.id == id) {
                    return Err(StoreError::new("not-found", "Folder not found"));
                }
                id
            }
            None => new_id("f"),
        };
        let order = self
            .folders
            .iter()
            .find(|f| f.id == id && f.parent_id == input.parent_id)
            .map_or(self.next_order(&input.parent_id), |f| f.order);
        let folder = Folder {
            id: id.clone(),
            parent_id: input.parent_id,
            name: input.name.trim().into(),
            icon: input.icon,
            color: input.color,
            order,
        };
        self.folders.retain(|f| f.id != id);
        self.folders.push(folder);
        Ok(())
    }
    pub fn upsert_connection(&mut self, input: ConnectionInput) -> Result<()> {
        if !(1..=65535).contains(&input.port) {
            return Err(StoreError::field("port", "range"));
        }
        let existing = match &input.id {
            Some(id) => Some(
                self.connections
                    .iter()
                    .find(|c| &c.id == id)
                    .ok_or_else(|| StoreError::new("not-found", "Connection not found"))?
                    .clone(),
            ),
            None => None,
        };
        let connection = Connection {
            id: existing
                .as_ref()
                .map_or_else(|| new_id("c"), |c| c.id.clone()),
            folder_id: input.folder_id.clone(),
            name: input.name.trim().into(),
            host: bare_host(&input.host).into(),
            port: input.port as u16,
            user: input.user,
            auth: input.auth,
            identity_file: input.identity_file,
            jump_connection_id: input.jump_connection_id,
            extra_options: input.extra_options,
            bookmarked: input.bookmarked,
            order: existing
                .as_ref()
                .filter(|c| c.folder_id == input.folder_id)
                .map_or(self.next_order(&input.folder_id), |c| c.order),
            last_used_at: existing.as_ref().and_then(|c| c.last_used_at.clone()),
            secret: existing.and_then(|c| c.secret),
        };
        self.connections.retain(|c| c.id != connection.id);
        self.connections.push(connection);
        Ok(())
    }
    fn next_order(&self, parent: &Option<String>) -> usize {
        self.folders
            .iter()
            .filter(|f| &f.parent_id == parent)
            .count()
            + self
                .connections
                .iter()
                .filter(|c| &c.folder_id == parent)
                .count()
    }
    fn check_referrers(&self, deleted: &HashSet<String>) -> Result<()> {
        let refs: Vec<_> = self
            .connections
            .iter()
            .filter(|c| {
                !deleted.contains(&c.id)
                    && c.jump_connection_id
                        .as_ref()
                        .is_some_and(|id| deleted.contains(id))
            })
            .map(|c| format!("{} ({})", c.name, c.id))
            .collect();
        if refs.is_empty() {
            Ok(())
        } else {
            Err(StoreError::new(
                "in-use-as-jump",
                format!("Cannot delete: used as jump host by {}", refs.join(", ")),
            ))
        }
    }
    pub fn delete_connection(&mut self, id: &str) -> Result<()> {
        if !self.connections.iter().any(|c| c.id == id) {
            return Err(StoreError::new("not-found", "Connection not found"));
        }
        self.check_referrers(&HashSet::from([id.into()]))?;
        self.connections.retain(|c| c.id != id);
        Ok(())
    }
    pub fn delete_folder(&mut self, id: &str, recursive: bool) -> Result<()> {
        if !self.folders.iter().any(|f| f.id == id) {
            return Err(StoreError::new("not-found", "Folder not found"));
        }
        let mut folders = HashSet::from([id.to_owned()]);
        loop {
            let before = folders.len();
            for f in &self.folders {
                if f.parent_id.as_ref().is_some_and(|p| folders.contains(p)) {
                    folders.insert(f.id.clone());
                }
            }
            if before == folders.len() {
                break;
            }
        }
        let connections: HashSet<_> = self
            .connections
            .iter()
            .filter(|c| c.folder_id.as_ref().is_some_and(|p| folders.contains(p)))
            .map(|c| c.id.clone())
            .collect();
        if !recursive && (folders.len() > 1 || !connections.is_empty()) {
            return Err(StoreError::new("not-empty", "Folder is not empty"));
        }
        self.check_referrers(&connections)?;
        self.folders.retain(|f| !folders.contains(&f.id));
        self.connections.retain(|c| !connections.contains(&c.id));
        Ok(())
    }
    pub fn set_bookmark(&mut self, id: &str, bookmarked: bool) -> Result<()> {
        self.connections
            .iter_mut()
            .find(|c| c.id == id)
            .ok_or_else(|| StoreError::new("not-found", "Connection not found"))?
            .bookmarked = bookmarked;
        Ok(())
    }
    pub fn move_row(
        &mut self,
        kind: &str,
        id: &str,
        parent: Option<String>,
        index: usize,
    ) -> Result<()> {
        match kind {
            "folder" => {
                self.folders
                    .iter_mut()
                    .find(|f| f.id == id)
                    .ok_or_else(|| StoreError::new("not-found", "Folder not found"))?
                    .parent_id = parent.clone()
            }
            "connection" => {
                self.connections
                    .iter_mut()
                    .find(|c| c.id == id)
                    .ok_or_else(|| StoreError::new("not-found", "Connection not found"))?
                    .folder_id = parent.clone()
            }
            _ => return Err(StoreError::field("kind", "invalid")),
        }
        let mut rows: Vec<_> = self
            .folders
            .iter()
            .filter(|f| f.parent_id == parent && f.id != id)
            .map(|f| (f.order, f.id.clone()))
            .chain(
                self.connections
                    .iter()
                    .filter(|c| c.folder_id == parent && c.id != id)
                    .map(|c| (c.order, c.id.clone())),
            )
            .collect();
        rows.sort_by_key(|r| r.0);
        rows.insert(index.min(rows.len()), (0, id.into()));
        for (order, (_, id)) in rows.into_iter().enumerate() {
            if let Some(f) = self.folders.iter_mut().find(|f| f.id == id) {
                f.order = order;
            }
            if let Some(c) = self.connections.iter_mut().find(|c| c.id == id) {
                c.order = order;
            }
        }
        Ok(())
    }
}
fn bracketed_host(host: &str) -> bool {
    host.strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .is_some_and(|s| s.parse::<std::net::Ipv6Addr>().is_ok())
}
fn valid_host(host: &str) -> bool {
    bracketed_host(host)
        || host.parse::<std::net::Ipv6Addr>().is_ok()
        || (!host.starts_with(['-', '.'])
            && host
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".-_".contains(&b)))
}
pub(super) fn bare_host(host: &str) -> &str {
    if bracketed_host(host) {
        &host[1..host.len() - 1]
    } else {
        host
    }
}
fn bounded(value: &str, field: &str) -> Result<()> {
    let max = STRING_BOUNDS
        .iter()
        .find(|(name, _)| *name == field)
        .expect("string bound")
        .1;
    if value.chars().count() > max {
        Err(StoreError::field(field, "length"))
    } else {
        Ok(())
    }
}
fn text(value: &str, field: &str) -> Result<()> {
    bounded(value, field)?;
    if value.chars().any(char::is_control) {
        Err(StoreError::field(field, "invalid"))
    } else {
        Ok(())
    }
}
fn identifier(value: &str, field: &str) -> Result<()> {
    text(value, field)?;
    if value.is_empty()
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        Err(StoreError::field(field, "invalid"))
    } else {
        Ok(())
    }
}
fn name(value: &str) -> Result<()> {
    text(value, "name")?;
    if value.trim().is_empty() {
        Err(StoreError::field("name", "length"))
    } else {
        Ok(())
    }
}
fn new_id(prefix: &str) -> String {
    format!(
        "{prefix}-{}",
        &uuid::Uuid::new_v4().simple().to_string()[..16]
    )
}
pub fn store_path() -> PathBuf {
    PathBuf::from(
        std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| ".".into()),
    )
    .join(".auto-terminal")
    .join(crate::app_config::dev_file("ssh_connections.json"))
}

type Writer = dyn Fn(&Path, &str) -> std::result::Result<(), String> + Send + Sync;
/// Disk is reloaded under the cross-process lock before every transaction. A
/// failed write never publishes the candidate or advances the committed cache.
pub struct Store {
    path: PathBuf,
    cache: Mutex<Option<(std::time::SystemTime, u64, Persisted)>>,
    // Reload recovery revisions are served immediately but only persisted on a write.
    served: Mutex<Option<Reply>>,
    writer: Box<Writer>,
}
impl Store {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            cache: Mutex::new(None),
            served: Mutex::new(None),
            writer: Box::new(write_atomic),
        }
    }
    fn load(&self) -> Result<Persisted> {
        match std::fs::read(&self.path) {
            Ok(bytes) => {
                let mut data: Persisted = serde_json::from_slice(&bytes).map_err(|_| {
                    StoreError::new("invalid-json", "Invalid SSH store JSON or UTF-8")
                })?;
                data.validate()?;
                data.normalize();
                Ok(data)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Persisted::default()),
            Err(e) => Err(StoreError::new(
                "read-error",
                format!("{}: {e}", self.path.display()),
            )),
        }
    }
    fn lock(&self) -> Result<ConfigLock> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| StoreError::new("io", format!("{}: {e}", parent.display())))?;
        }
        ConfigLock::acquire(&self.path).map_err(|e| StoreError::new("io", e))
    }
    fn stamp(&self) -> Option<(std::time::SystemTime, u64)> {
        let metadata = std::fs::metadata(&self.path).ok()?;
        if !metadata.is_file() {
            return None;
        }
        Some((metadata.modified().ok()?, metadata.len()))
    }
    fn remember(&self, data: Persisted) {
        *self.cache.lock().unwrap() = self.stamp().map(|(mtime, len)| (mtime, len, data));
    }
    pub fn get(&self) -> Result<Reply> {
        self.read(false, |_| {})
    }
    pub fn reload(&self, emit: impl FnOnce(&Reply)) -> Result<Reply> {
        self.read(true, emit)
    }
    fn read(&self, force: bool, emit: impl FnOnce(&Reply)) -> Result<Reply> {
        let _lock = self.lock()?;
        if !force {
            if let (Some((mtime, len)), Some((cached_mtime, cached_len, data))) =
                (self.stamp(), self.cache.lock().unwrap().as_ref())
            {
                if mtime == *cached_mtime && len == *cached_len {
                    return Ok(data.view(None));
                }
            }
        }
        let (mut reply, data) = match self.load() {
            Ok(data) => {
                log::info!(
                    "SSH store loaded: revision={}, folders={}, connections={}",
                    data.revision,
                    data.folders.len(),
                    data.connections.len()
                );
                (data.view(None), Some(data))
            }
            Err(mut error) => {
                *self.cache.lock().unwrap() = None;
                log::warn!("SSH store load failed: {}", error.code);
                error.message = format!("{}: {}", self.path.display(), error.message);
                (Persisted::default().view(Some(error)), None)
            }
        };
        let mut served = self.served.lock().unwrap();
        if let Some(previous) = served.as_ref() {
            let mut previous_content = previous.view.clone();
            let mut next_content = reply.view.clone();
            previous_content.revision = 0;
            next_content.revision = 0;
            let revision = if previous_content != next_content {
                reply.revision.max(
                    previous
                        .revision
                        .checked_add(1)
                        .ok_or_else(|| StoreError::new("revision-overflow", "Revision overflow"))?,
                )
            } else {
                // Disk may still have the pre-recovery revision. An unchanged Reload
                // must not keep manufacturing revisions while awaiting the next write.
                reply.revision.max(previous.revision)
            };
            reply.revision = revision;
            reply.view.revision = revision;
        }
        let changed = served.as_ref() != Some(&reply);
        if let Some(mut data) = data {
            data.revision = reply.revision;
            self.remember(data);
        }
        *served = Some(reply.clone());
        drop(served);
        if force && changed {
            emit(&reply);
        }
        Ok(reply)
    }
    pub fn transact(
        &self,
        mutation: impl FnOnce(&mut Persisted) -> Result<()>,
        emit: impl FnOnce(&Reply),
    ) -> Result<Reply> {
        let _lock = self.lock()?;
        let mut candidate = self.load().map_err(|e| {
            StoreError::new(
                "store-read-only",
                format!("{}: {}", self.path.display(), e.message),
            )
        })?;
        mutation(&mut candidate)?;
        candidate.validate()?;
        candidate.normalize();
        let served_revision = self
            .served
            .lock()
            .unwrap()
            .as_ref()
            .map_or(0, |reply| reply.revision);
        candidate.revision = candidate
            .revision
            .max(served_revision)
            .checked_add(1)
            .ok_or_else(|| StoreError::new("revision-overflow", "Revision overflow"))?;
        let contents = serde_json::to_string_pretty(&candidate)
            .map_err(|e| StoreError::new("serialize", e.to_string()))?;
        (self.writer)(&self.path, &contents)
            .map_err(|e| StoreError::new("io", format!("{}: {e}", self.path.display())))?;
        let reply = candidate.view(None);
        self.remember(candidate);
        *self.served.lock().unwrap() = Some(reply.clone());
        emit(&reply);
        Ok(reply)
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod enum_census {
    use super::*;
    #[test]
    fn icons_and_colors_match_renderer() {
        let ts = include_str!(
            "../../../src/renderer/components/Settings/SshConnections/sshFolderIcons.ts"
        )
        .replace("\r\n", "\n");
        for (name, expected) in [("SSH_FOLDER_ICONS", ICONS), ("SSH_FOLDER_COLORS", COLORS)] {
            let tail = ts.split_once(name).unwrap().1;
            let array = tail.split_once('[').unwrap().1.split_once(']').unwrap().0;
            let mut actual: Vec<_> = array
                .split(',')
                .map(|s| s.trim().trim_matches('\''))
                .filter(|s| !s.is_empty())
                .collect();
            let mut expected = expected.to_vec();
            assert!(!actual.is_empty());
            actual.sort();
            expected.sort();
            assert_eq!(actual, expected);
        }
    }
}
