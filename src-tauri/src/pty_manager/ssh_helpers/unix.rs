//! Descriptor-relative Unix operations: no pathname traversal after root admission.
use super::{component, denied, path_error, root_error, MAX_FILE, PATH_MODE};
use std::borrow::Cow;
use std::ffi::{CStr, CString, OsString};
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStringExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};

// MetadataExt::mode() is u32 on both OSes, but Darwin's libc::S_ISVTX uses u16.
const STICKY_BIT: u32 = 0o1000;

pub(super) struct Dir {
    path: PathBuf,
    file: File,
}

fn c_name(name: &str) -> io::Result<CString> {
    component(name)?;
    CString::new(name).map_err(|_| denied())
}

fn fd_file(fd: libc::c_int) -> io::Result<File> {
    if fd < 0 {
        Err(io::Error::last_os_error())
    } else {
        // SAFETY: a successful open/dup returns a newly owned descriptor.
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}

fn private(file: &File, directory: bool) -> io::Result<()> {
    let meta = file.metadata()?;
    // A published entry is sealed owner-read-only (see `Dir::set_sealed`).
    let mode = meta.mode() & 0o7777;
    let expected = if directory { mode == 0o700 || mode == 0o500 } else { mode == 0o600 };
    if meta.uid() != unsafe { libc::geteuid() }
        || !expected
        || (directory && !meta.is_dir())
        || (!directory && (!meta.is_file() || meta.nlink() != 1))
    {
        return Err(denied());
    }
    Ok(())
}

fn trusted_ancestor(meta: &std::fs::Metadata, uid: u32) -> bool {
    (meta.uid() == uid || meta.uid() == 0)
        && (meta.mode() & 0o022 == 0 || meta.mode() & STICKY_BIT != 0)
}

/// Resolve trusted app-data links before the strict walk. A link substituted
/// after resolution is still rejected by the descriptor-relative O_NOFOLLOW walk.
pub(super) fn resolve_app_data(path: &Path) -> io::Result<Cow<'_, Path>> {
    use std::fs::{canonicalize, metadata, symlink_metadata};

    if !path.is_absolute()
        || path.components().any(|part| !matches!(part, Component::RootDir | Component::Normal(_)))
    {
        return Err(path_error(path, denied(), PATH_MODE));
    }

    let uid = unsafe { libc::geteuid() };
    let mut prefix = PathBuf::from("/");
    let mut parts = path.components().skip(1).peekable();
    let mut tail = PathBuf::new();
    let mut linked = false;
    let mut unsafe_dir = None;
    while let Some(part) = parts.next() {
        let next = prefix.join(part);
        match symlink_metadata(&next) {
            Ok(meta) if meta.is_symlink() => {
                let parent = metadata(&prefix).map_err(|error| path_error(&prefix, error, PATH_MODE))?;
                if (meta.uid() != uid && meta.uid() != 0) || !trusted_ancestor(&parent, uid) {
                    return Err(root_error(
                        &next,
                        io::Error::new(io::ErrorKind::InvalidData, "untrusted app-data link"),
                        "a folder in its path is a link TermFlow can't trust",
                    ));
                }
                linked = true;
            }
            Ok(meta) if !trusted_ancestor(&meta, uid) && meta.is_dir() => {
                if unsafe_dir.is_none() {
                    unsafe_dir = Some(next.clone());
                }
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                tail.push(part);
                tail.extend(parts);
                break;
            }
            Err(error) => return Err(path_error(&next, error, PATH_MODE)),
        }
        prefix = next;
    }
    if !linked {
        return Ok(Cow::Borrowed(path));
    }
    // The canonical path must not hide an unsafe directory on the original walk.
    if let Some(dir) = unsafe_dir {
        return Err(path_error(&dir, denied(), PATH_MODE));
    }
    let mut resolved = canonicalize(&prefix).map_err(|error| path_error(&prefix, error, PATH_MODE))?;
    if !tail.as_os_str().is_empty() {
        resolved.push(tail);
    }
    Ok(Cow::Owned(resolved))
}

impl Dir {
    pub(super) fn path(&self) -> &Path {
        &self.path
    }

    pub(super) fn open_tree(path: &Path) -> io::Result<Self> {
        if !path.is_absolute() {
            return Err(path_error(path, denied(), PATH_MODE));
        }
        let mut dir = Self {
            path: PathBuf::from("/"),
            file: fd_file(unsafe {
                libc::open(
                    c"/".as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
                )
            }).map_err(|error| path_error(Path::new("/"), error, PATH_MODE))?,
        };
        for part in path.components() {
            match part {
                Component::RootDir => {}
                Component::Normal(name) => {
                    let full = dir.path.join(name);
                    let reject = |error| path_error(&full, error, PATH_MODE);
                    let name = name.to_str().ok_or_else(denied).map_err(reject)?;
                    // App-data ancestors may contain spaces/Unicode, unlike generated names.
                    let raw = CString::new(name).map_err(|_| reject(denied()))?;
                    match unsafe { libc::mkdirat(dir.file.as_raw_fd(), raw.as_ptr(), 0o700) } {
                        0 => {}
                        _ if io::Error::last_os_error().kind() == io::ErrorKind::AlreadyExists => {}
                        _ => return Err(reject(io::Error::last_os_error())),
                    }
                    let file = fd_file(unsafe {
                        libc::openat(
                            dir.file.as_raw_fd(),
                            raw.as_ptr(),
                            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                        )
                    }).map_err(reject)?;
                    let meta = file.metadata().map_err(reject)?;
                    // System-owned ancestors are fine, but a foreign-writable component can
                    // replace our app-data path. Sticky system temp dirs are allowed in tests;
                    // all generated data still lives below the explicitly supplied app-data dir.
                    let uid = unsafe { libc::geteuid() };
                    if !trusted_ancestor(&meta, uid) {
                        return Err(reject(denied()));
                    }
                    dir = Self { path: full, file };
                }
                _ => return Err(path_error(path, denied(), PATH_MODE)),
            }
        }
        Ok(dir)
    }

    pub(super) fn verify_private(&self) -> io::Result<()> {
        private(&self.file, true)
    }

    /// A sealed directory is owner read/search only. A shell started with a hook
    /// directory as its HOME/ZDOTDIR then cannot drop files there (e.g. a global
    /// zshrc's compinit dump), which would make the entry untrusted to retire.
    pub(super) fn set_sealed(&self, sealed: bool) -> io::Result<()> {
        self.verify_private()?;
        let mode = if sealed { 0o500 } else { 0o700 };
        if unsafe { libc::fchmod(self.file.as_raw_fd(), mode) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub(super) fn child(&self, name: &str, create: bool) -> io::Result<Self> {
        let raw = c_name(name)?;
        if create {
            let result = unsafe { libc::mkdirat(self.file.as_raw_fd(), raw.as_ptr(), 0o700) };
            if result != 0 && io::Error::last_os_error().kind() != io::ErrorKind::AlreadyExists {
                return Err(io::Error::last_os_error());
            }
        }
        self.open_child(name)
    }

    pub(super) fn create_child(&self, name: &str) -> io::Result<Self> {
        self.verify_private()?;
        let raw = c_name(name)?;
        if unsafe { libc::mkdirat(self.file.as_raw_fd(), raw.as_ptr(), 0o700) } != 0 {
            return Err(io::Error::last_os_error());
        }
        self.open_child(name)
    }

    fn open_child(&self, name: &str) -> io::Result<Self> {
        let raw = c_name(name)?;
        let file = fd_file(unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                raw.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        })?;
        private(&file, true)?;
        Ok(Self {
            path: self.path.join(name),
            file,
        })
    }

    pub(super) fn open_file(&self, name: &str) -> io::Result<File> {
        self.verify_private()?;
        let raw = c_name(name)?;
        let file = fd_file(unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                raw.as_ptr(),
                libc::O_RDWR | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
            )
        })?;
        private(&file, false)?;
        Ok(file)
    }

    pub(super) fn read_file(&self, name: &str) -> io::Result<Vec<u8>> {
        let file = self.open_file(name)?;
        if file.metadata()?.len() > MAX_FILE {
            return Err(denied());
        }
        let mut bytes = Vec::new();
        file.take(MAX_FILE + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_FILE {
            return Err(denied());
        }
        Ok(bytes)
    }

    pub(super) fn publish_file(&self, name: &str, bytes: &[u8]) -> io::Result<()> {
        self.verify_private()?;
        let final_name = c_name(name)?;
        let stage_name = format!("stage-{}", uuid::Uuid::new_v4());
        let stage = c_name(&stage_name)?;
        let mut file = fd_file(unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                stage.as_ptr(),
                libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        })?;
        let result = (|| {
            private(&file, false)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            // linkat atomically exposes all bytes and fails if the destination already exists.
            if unsafe {
                libc::linkat(
                    self.file.as_raw_fd(),
                    stage.as_ptr(),
                    self.file.as_raw_fd(),
                    final_name.as_ptr(),
                    0,
                )
            } != 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        })();
        let unlinked = unsafe { libc::unlinkat(self.file.as_raw_fd(), stage.as_ptr(), 0) };
        result?;
        if unlinked != 0 {
            return Err(io::Error::last_os_error());
        }
        self.file.sync_all()
    }

    pub(super) fn remove_file(&self, name: &str) -> io::Result<()> {
        let _file = self.open_file(name)?;
        let raw = c_name(name)?;
        if unsafe { libc::unlinkat(self.file.as_raw_fd(), raw.as_ptr(), 0) } != 0 {
            return Err(io::Error::last_os_error());
        }
        self.file.sync_all()
    }

    pub(super) fn remove_dir(&self, name: &str) -> io::Result<()> {
        self.verify_private()?;
        let raw = c_name(name)?;
        if unsafe { libc::unlinkat(self.file.as_raw_fd(), raw.as_ptr(), libc::AT_REMOVEDIR) } != 0 {
            return Err(io::Error::last_os_error());
        }
        self.file.sync_all()
    }

    pub(super) fn names(&self) -> io::Result<Vec<String>> {
        self.verify_private()?;
        // A new open file description, not dup(): duplicated directory offsets would make
        // subsequent sweeps miss entries. fdopendir owns the descriptor after success.
        let fd = unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                c".".as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let stream = unsafe { libc::fdopendir(fd) };
        if stream.is_null() {
            let error = io::Error::last_os_error();
            unsafe {
                libc::close(fd);
            }
            return Err(error);
        }
        let mut names = Vec::new();
        let result = loop {
            unsafe {
                *errno() = 0;
            }
            let entry = unsafe { libc::readdir(stream) };
            if entry.is_null() {
                break if unsafe { *errno() } == 0 {
                    Ok(())
                } else {
                    Err(io::Error::last_os_error())
                };
            }
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
            if name == b"." || name == b".." {
                continue;
            }
            // Non-UTF8 unknown names are not candidates, but must prevent entry deletion.
            names.push(
                OsString::from_vec(name.to_vec())
                    .to_string_lossy()
                    .into_owned(),
            );
        };
        unsafe {
            libc::closedir(stream);
        }
        result?;
        Ok(names)
    }
}

#[cfg(target_os = "macos")]
unsafe fn errno() -> *mut libc::c_int {
    libc::__error()
}
#[cfg(not(target_os = "macos"))]
unsafe fn errno() -> *mut libc::c_int {
    libc::__errno_location()
}

pub(super) fn process_absent(pid: u32) -> bool {
    // Never cast a large unsigned PID to kill's negative process-group namespace.
    if pid > i32::MAX as u32 {
        return true;
    }
    unsafe { libc::kill(pid as libc::pid_t, 0) != 0 && *errno() == libc::ESRCH }
}
