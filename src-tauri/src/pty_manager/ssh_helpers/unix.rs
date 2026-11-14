//! Descriptor-relative Unix operations: no pathname traversal after root admission.
use super::{component, denied, MAX_FILE};
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
    let expected = if directory { 0o700 } else { 0o600 };
    if meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o7777 != expected
        || (directory && !meta.is_dir())
        || (!directory && (!meta.is_file() || meta.nlink() != 1))
    {
        return Err(denied());
    }
    Ok(())
}

impl Dir {
    pub(super) fn path(&self) -> &Path {
        &self.path
    }

    pub(super) fn open_tree(path: &Path) -> io::Result<Self> {
        if !path.is_absolute() {
            return Err(denied());
        }
        let mut dir = Self {
            path: PathBuf::from("/"),
            file: fd_file(unsafe {
                libc::open(
                    c"/".as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
                )
            })?,
        };
        for part in path.components() {
            match part {
                Component::RootDir => {}
                Component::Normal(name) => {
                    let name = name.to_str().ok_or_else(denied)?;
                    // App-data ancestors may contain spaces/Unicode, unlike generated names.
                    let raw = CString::new(name).map_err(|_| denied())?;
                    match unsafe { libc::mkdirat(dir.file.as_raw_fd(), raw.as_ptr(), 0o700) } {
                        0 => {}
                        _ if io::Error::last_os_error().kind() == io::ErrorKind::AlreadyExists => {}
                        _ => return Err(io::Error::last_os_error()),
                    }
                    let file = fd_file(unsafe {
                        libc::openat(
                            dir.file.as_raw_fd(),
                            raw.as_ptr(),
                            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                        )
                    })?;
                    let meta = file.metadata()?;
                    // System-owned ancestors are fine, but a foreign-writable component can
                    // replace our app-data path. Sticky system temp dirs are allowed in tests;
                    // all generated data still lives below the explicitly supplied app-data dir.
                    let uid = unsafe { libc::geteuid() };
                    if (meta.uid() != uid && meta.uid() != 0)
                        || (meta.mode() & 0o022 != 0 && meta.mode() & STICKY_BIT == 0)
                    {
                        return Err(denied());
                    }
                    dir = Self {
                        path: dir.path.join(name),
                        file,
                    };
                }
                _ => return Err(denied()),
            }
        }
        Ok(dir)
    }

    pub(super) fn verify_private(&self) -> io::Result<()> {
        private(&self.file, true)
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
