//! Disposable, filesystem-backed SFTP server for the in-memory SSH fixtures.
use parking_lot::Mutex;
use russh_sftp::{protocol::*, server::{self, Handler, StatusReply}};
use std::{
    collections::HashMap,
    fs::{self, File as LocalFile, ReadDir},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

pub type BeforeRequest = Box<dyn Fn(&str, &str) + Send + Sync>;

#[derive(Default)]
pub struct SftpFaults {
    pub requests: Vec<(String, String)>,
    pub deny: Vec<(&'static str, String)>,
    pub omit_attrs: bool,
    pub omit_posix_rename: bool,
    pub reject_posix_rename: bool,
    pub hold_temp_close_ack: Option<Arc<tokio::sync::Semaphore>>,
    // One-shot wire names, including names the host filesystem cannot store.
    pub readdir_names: Option<Vec<String>>,
    pub delay_before_ack: Option<(&'static str, String, Duration)>,
    pub drop_connection_on: Option<(&'static str, String)>,
    pub before: Option<BeforeRequest>,
}

type Result<T> = std::result::Result<T, StatusReply>;

#[derive(Clone, Copy, Default)]
struct Overrides {
    mode: Option<u32>,
    uid: Option<u32>,
    gid: Option<u32>,
}

#[derive(Default)]
pub struct SftpStorage {
    pub root: Option<PathBuf>,
    resolved_root: OnceLock<Root>,
    filesystem: Mutex<()>,
    overrides: Mutex<HashMap<PathBuf, Overrides>>,
}

struct Root {
    path: PathBuf,
    temporary: Option<PathBuf>,
}

impl Drop for Root {
    fn drop(&mut self) {
        if let Some(path) = &self.temporary {
            let _ = fs::remove_dir_all(path);
        }
    }
}

enum Resource {
    File(LocalFile),
    Directory(ReadDir),
}

struct OpenResource {
    remote: String,
    resource: Resource,
}

struct TestSftp {
    storage: Arc<SftpStorage>,
    faults: Arc<Mutex<SftpFaults>>,
    disconnect: CancellationToken,
    handles: HashMap<String, OpenResource>,
    next_handle: usize,
}

pub async fn serve(
    channel: russh::Channel<russh::server::Msg>,
    ssh: russh::server::Handle,
    storage: Arc<SftpStorage>,
    faults: Arc<Mutex<SftpFaults>>,
) {
    let id = channel.id();
    storage.resolved_root.get_or_init(|| {
        let temporary = storage.root.is_none().then(|| {
            let path = std::env::temp_dir().join(format!("tf-sftp-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            path
        });
        let path = storage.root.as_ref().or(temporary.as_ref()).unwrap().canonicalize().unwrap();
        Root { path, temporary }
    });
    let disconnect = CancellationToken::new();
    let handler = TestSftp {
        storage,
        faults,
        disconnect: disconnect.clone(),
        handles: HashMap::new(),
        next_handle: 0,
    };
    // The biased bridge cuts the SSH channel before forwarding any faulted
    // response, even if the handler has already applied the operation.
    let (mut wire, sftp) = tokio::io::duplex(64 * 1024);
    let mut stream = channel.into_stream();
    server::run(sftp, handler).await;
    tokio::select! {
        biased;
        _ = disconnect.cancelled() => {},
        _ = tokio::io::copy_bidirectional(&mut stream, &mut wire) => {},
    }
    drop(wire);
    let _ = ssh.close(id).await;
}

fn io_status(err: io::Error) -> StatusReply {
    match err.kind() {
        io::ErrorKind::NotFound => StatusCode::NoSuchFile.into(),
        io::ErrorKind::PermissionDenied => StatusCode::PermissionDenied.into(),
        io::ErrorKind::AlreadyExists => StatusCode::Failure.with_message("File exists"),
        _ => StatusCode::Failure.into(),
    }
}

fn ok(id: u32) -> Status {
    Status { id, status_code: StatusCode::Ok, error_message: String::new(), language_tag: "en-US".into() }
}

impl TestSftp {
    async fn request<T: Send>(
        &mut self,
        op: &str,
        path: &str,
        apply: impl FnOnce(&mut Self) -> Result<T> + Send,
    ) -> Result<T> {
        let (denied, delay, disconnect, hold) = {
            let mut f = self.faults.lock();
            f.requests.push((op.to_owned(), path.to_owned()));
            if let Some(before) = &f.before {
                before(op, path);
            }
            let matches = |o: &str, p: &str| o == op && p == path;
            (
                f.deny.iter().any(|(o, p)| matches(o, p) || (*o == op && p == "*.tmp" && path.ends_with(".tmp"))),
                f.delay_before_ack.as_ref().filter(|(o, p, _)| matches(o, p)).map(|(_, _, d)| *d),
                f.drop_connection_on.as_ref().is_some_and(|(o, p)| matches(o, p)),
                f.hold_temp_close_ack.as_ref().filter(|_| op == "close" && path.ends_with(".tmp")).cloned(),
            )
        };
        let result = if denied {
            Err(StatusCode::PermissionDenied.into())
        } else {
            // In-fixture requests cannot race the destination check in RENAME.
            // Tests may mutate the tree directly at the explicit before hook.
            let storage = self.storage.clone();
            let _filesystem = storage.filesystem.lock();
            apply(self)
        };
        if let Some(hold) = hold {
            hold.acquire().await.unwrap().forget();
        }
        if let Some(delay) = delay {
            tokio::time::sleep(delay).await;
        }
        if disconnect {
            self.disconnect.cancel();
        }
        result
    }

    fn root(&self) -> &Path {
        &self.storage.resolved_root.get().unwrap().path
    }

    fn contained(&self, path: &Path) -> Result<PathBuf> {
        let resolved = path.canonicalize().map_err(io_status)?;
        if !resolved.starts_with(self.root()) {
            return Err(StatusCode::PermissionDenied.into());
        }
        Ok(resolved)
    }

    fn local(&self, remote: &str, follow: bool, allow_missing: bool) -> Result<PathBuf> {
        if remote == "." || remote == "/" {
            return Ok(self.root().to_owned());
        }
        let invalid = || StatusCode::PermissionDenied.into();
        let parts = remote.strip_prefix('/').ok_or_else(invalid)?;
        let mut path = self.root().to_owned();
        for name in parts.split('/') {
            if matches!(name, "" | "." | "..") || name.contains(['\0', '\u{fffd}']) {
                return Err(invalid());
            }
            #[cfg(windows)]
            if name.contains(['\\', ':', '<', '>', '"', '|', '?', '*']) || name.ends_with(['.', ' '])
                || matches!(name.split('.').next().unwrap().to_ascii_uppercase().as_str(),
                    "CON" | "PRN" | "AUX" | "NUL" | "COM1" | "COM2" | "COM3" | "COM4" | "COM5" | "COM6" | "COM7" | "COM8" | "COM9" |
                    "LPT1" | "LPT2" | "LPT3" | "LPT4" | "LPT5" | "LPT6" | "LPT7" | "LPT8" | "LPT9" |
                    "COM¹" | "COM²" | "COM³" | "LPT¹" | "LPT²" | "LPT³" | "CONIN$" | "CONOUT$") {
                return Err(invalid());
            }
            path.push(name);
        }
        let parent = self.contained(path.parent().unwrap())?;
        let leaf = parent.join(path.file_name().unwrap());
        if follow {
            match fs::symlink_metadata(&leaf) {
                Err(err) if err.kind() == io::ErrorKind::NotFound && allow_missing => Ok(leaf),
                Err(err) => Err(io_status(err)),
                Ok(_) => self.contained(&leaf),
            }
        } else {
            Ok(leaf)
        }
    }

    fn target(&self, remote: &str, follow: bool, allow_missing: bool) -> Result<PathBuf> {
        if matches!(remote, "." | "/") {
            return Err(StatusCode::PermissionDenied.into());
        }
        self.local(remote, follow, allow_missing)
    }

    fn remote(&self, path: &Path) -> Result<String> {
        let relative = path.strip_prefix(self.root()).map_err(|_| StatusCode::PermissionDenied)?;
        let mut wire = String::new();
        for c in relative.components() {
            let Component::Normal(c) = c else { return Err(StatusCode::PermissionDenied.into()); };
            wire.push('/');
            wire.push_str(&c.to_string_lossy());
        }
        Ok(if wire.is_empty() { "/".into() } else { wire })
    }

    fn attrs(&self, path: &Path) -> Result<FileAttributes> {
        let metadata = fs::symlink_metadata(path).map_err(io_status)?;
        let mut attrs = FileAttributes::from(&metadata);
        let kind = metadata.file_type();
        let mode = if kind.is_symlink() { 0o120000 } else if kind.is_dir() { 0o040000 }
            else if kind.is_file() { 0o100000 } else { 0 };
        let extra = self.storage.overrides.lock().get(path).copied().unwrap_or_default();
        attrs.permissions = Some(mode | extra.mode.unwrap_or(attrs.permissions.unwrap_or_default() & 0o7777));
        attrs.uid = extra.uid.or(attrs.uid);
        attrs.gid = extra.gid.or(attrs.gid);
        if self.faults.lock().omit_attrs {
            attrs.size = None;
            attrs.atime = None;
            attrs.mtime = None;
        }
        Ok(attrs)
    }

    fn set_mode_owner(&self, path: &Path, attrs: FileAttributes) -> Result<()> {
        #[cfg(unix)]
        if let Some(mode) = attrs.permissions {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(mode & 0o7777)).map_err(io_status)?;
        }
        let mut overrides = self.storage.overrides.lock();
        let extra = overrides.entry(path.to_owned()).or_default();
        #[cfg(not(unix))]
        if let Some(mode) = attrs.permissions {
            // Emulate POSIX bits without changing the host's Windows ACLs.
            extra.mode = Some(mode & 0o7777);
        }
        extra.uid = attrs.uid.or(extra.uid);
        extra.gid = attrs.gid.or(extra.gid);
        Ok(())
    }

    fn handle(&mut self, id: u32, remote: String, resource: Resource) -> Handle {
        self.next_handle += 1;
        let handle = self.next_handle.to_string();
        self.handles.insert(handle.clone(), OpenResource { remote, resource });
        Handle { id, handle }
    }

    fn handle_path(&self, handle: &str) -> Result<String> {
        self.handles.get(handle).map(|entry| entry.remote.clone()).ok_or_else(|| StatusCode::Failure.into())
    }

    fn file(&mut self, handle: &str) -> Result<&mut LocalFile> {
        match self.handles.get_mut(handle).map(|entry| &mut entry.resource) {
            Some(Resource::File(file)) => Ok(file),
            _ => Err(StatusCode::Failure.into()),
        }
    }

    fn rename_local(&self, old: &str, new: &str, overwrite: bool) -> Result<()> {
        let source = self.target(old, false, false)?;
        let dest = self.target(new, false, false)?;
        let mut overrides = self.storage.overrides.lock();
        if !overwrite {
            match fs::symlink_metadata(&dest) {
                Ok(_) => return Err(StatusCode::Failure.with_message("File exists")),
                Err(err) if err.kind() == io::ErrorKind::NotFound => {},
                Err(err) => return Err(io_status(err)),
            }
        }
        fs::rename(&source, &dest).map_err(io_status)?;
        if source != dest {
            let moved: Vec<_> = overrides.iter().filter_map(|(path, value)| {
                path.strip_prefix(&source).ok().map(|suffix| {
                    let next = if suffix.as_os_str().is_empty() { dest.clone() } else { dest.join(suffix) };
                    (next, *value)
                })
            }).collect();
            overrides.retain(|path, _| !path.starts_with(&source) && !path.starts_with(&dest));
            overrides.extend(moved);
        }
        Ok(())
    }
}

impl Handler for TestSftp {
    type Error = StatusReply;

    fn unimplemented(&self) -> Self::Error { StatusCode::OpUnsupported.into() }

    async fn init(&mut self, version: u32, _: HashMap<String, String>) -> Result<Version> {
        self.request("init", "", |s| {
            assert_eq!(version, VERSION);
            let mut reply = Version::new();
            if !s.faults.lock().omit_posix_rename {
                reply.extensions.insert("posix-rename@openssh.com".into(), "1".into());
            }
            Ok(reply)
        }).await
    }

    async fn realpath(&mut self, id: u32, path: String) -> Result<Name> {
        self.request("realpath", &path, |s| {
            let local = s.local(&path, true, false)?;
            Ok(Name { id, files: vec![File::dummy(s.remote(&local)?)] })
        }).await
    }

    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle> {
        self.request("opendir", &path, |s| {
            let dir = fs::read_dir(s.local(&path, true, false)?).map_err(io_status)?;
            Ok(s.handle(id, path.clone(), Resource::Directory(dir)))
        }).await
    }

    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name> {
        let path = self.handle_path(&handle)?;
        self.request("readdir", &path, |s| {
            if let Some(names) = s.faults.lock().readdir_names.take() {
                return Ok(Name { id, files: names.into_iter().map(File::dummy).collect() });
            }
            let Resource::Directory(dir) = &mut s.handles.get_mut(&handle).unwrap().resource else {
                return Err(StatusCode::Failure.into());
            };
            let batch = dir.take(32).collect::<io::Result<Vec<_>>>().map_err(io_status)?;
            if batch.is_empty() { return Err(StatusCode::Eof.into()); }
            let files = batch.into_iter().map(|entry| {
                Ok(File::new(entry.file_name().to_string_lossy(), s.attrs(&entry.path())?))
            }).collect::<Result<_>>()?;
            Ok(Name { id, files })
        }).await
    }

    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs> {
        self.request("lstat", &path, |s| Ok(Attrs { id, attrs: s.attrs(&s.local(&path, false, false)?)? })).await
    }

    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs> {
        self.request("stat", &path, |s| Ok(Attrs { id, attrs: s.attrs(&s.local(&path, true, false)?)? })).await
    }

    async fn readlink(&mut self, id: u32, path: String) -> Result<Name> {
        self.request("readlink", &path, |s| {
            let target = fs::read_link(s.local(&path, false, false)?).map_err(io_status)?;
            let target = if target.is_absolute() { s.remote(&target)? } else { target.to_string_lossy().into_owned() };
            Ok(Name { id, files: vec![File::dummy(target)] })
        }).await
    }

    async fn mkdir(&mut self, id: u32, path: String, attrs: FileAttributes) -> Result<Status> {
        self.request("mkdir", &path, |s| {
            let local = s.target(&path, false, true)?;
            fs::create_dir(&local).map_err(io_status)?;
            s.set_mode_owner(&local, attrs)?;
            Ok(ok(id))
        }).await
    }

    async fn rmdir(&mut self, id: u32, path: String) -> Result<Status> {
        self.request("rmdir", &path, |s| {
            let local = s.target(&path, false, false)?;
            if !fs::symlink_metadata(&local).map_err(io_status)?.is_dir() { return Err(StatusCode::Failure.into()); }
            fs::remove_dir(&local).map_err(io_status)?;
            s.storage.overrides.lock().remove(&local);
            Ok(ok(id))
        }).await
    }

    async fn open(&mut self, id: u32, path: String, flags: OpenFlags, _: FileAttributes) -> Result<Handle> {
        self.request("open", &path, |s| {
            let create = flags.contains(OpenFlags::CREATE);
            let exclusive = create && flags.contains(OpenFlags::EXCLUDE);
            let local = s.target(&path, !exclusive, create)?;
            let file = fs::OpenOptions::from(flags).open(local).map_err(io_status)?;
            Ok(s.handle(id, path.clone(), Resource::File(file)))
        }).await
    }

    async fn read(&mut self, id: u32, handle: String, offset: u64, len: u32) -> Result<Data> {
        let path = self.handle_path(&handle)?;
        self.request("read", &path, |s| {
            let file = s.file(&handle)?;
            file.seek(SeekFrom::Start(offset)).map_err(io_status)?;
            let mut data = vec![0; len.min(32 * 1024) as usize];
            let read = file.read(&mut data).map_err(io_status)?;
            if read == 0 && len != 0 { return Err(StatusCode::Eof.into()); }
            data.truncate(read);
            Ok(Data { id, data })
        }).await
    }

    async fn write(&mut self, id: u32, handle: String, offset: u64, data: Vec<u8>) -> Result<Status> {
        let path = self.handle_path(&handle)?;
        self.request("write", &path, |s| {
            let file = s.file(&handle)?;
            file.seek(SeekFrom::Start(offset)).map_err(io_status)?;
            file.write_all(&data).map_err(io_status)?;
            Ok(ok(id))
        }).await
    }

    async fn close(&mut self, id: u32, handle: String) -> Result<Status> {
        let path = self.handle_path(&handle)?;
        let reply = self.request("close", &path, |s| {
            s.handles.remove(&handle);
            Ok(ok(id))
        }).await;
        // Failing the CLOSE acknowledgement does not have to leak the handle.
        self.handles.remove(&handle);
        reply
    }

    async fn remove(&mut self, id: u32, path: String) -> Result<Status> {
        self.request("remove", &path, |s| {
            let local = s.target(&path, false, false)?;
            #[cfg(windows)]
            let directory_link = {
                use std::os::windows::fs::FileTypeExt;
                fs::symlink_metadata(&local).map_err(io_status)?.file_type().is_symlink_dir()
            };
            #[cfg(not(windows))]
            let directory_link = false;
            if directory_link { fs::remove_dir(&local) } else { fs::remove_file(&local) }.map_err(io_status)?;
            s.storage.overrides.lock().remove(&local);
            Ok(ok(id))
        }).await
    }

    async fn rename(&mut self, id: u32, old: String, new: String) -> Result<Status> {
        self.request("rename", &old, |s| {
            s.rename_local(&old, &new, false)?;
            Ok(ok(id))
        }).await
    }

    async fn setstat(&mut self, id: u32, path: String, attrs: FileAttributes) -> Result<Status> {
        self.request("setstat", &path, |s| {
            let local = s.target(&path, true, false)?;
            s.set_mode_owner(&local, attrs)?;
            Ok(ok(id))
        }).await
    }

    async fn extended(&mut self, id: u32, request: String, data: Vec<u8>) -> Result<Packet> {
        if request != "posix-rename@openssh.com" { return Err(self.unimplemented()); }
        fn string<'a>(data: &mut &'a [u8]) -> Option<&'a str> {
            let (len, rest) = data.split_at_checked(4)?;
            let (value, tail) = rest.split_at_checked(u32::from_be_bytes(len.try_into().ok()?) as usize)?;
            *data = tail;
            std::str::from_utf8(value).ok()
        }
        let mut data = data.as_slice();
        let old = string(&mut data).ok_or(StatusCode::BadMessage)?;
        let new = string(&mut data).ok_or(StatusCode::BadMessage)?;
        if !data.is_empty() { return Err(StatusCode::BadMessage.into()); }
        self.request(&request, old, |s| {
            if s.faults.lock().reject_posix_rename {
                return Err(StatusCode::OpUnsupported.into());
            }
            s.rename_local(old, new, true)?;
            Ok(ok(id).into())
        }).await
    }
}
