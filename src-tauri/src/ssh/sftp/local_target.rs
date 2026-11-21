//! Local-only destination checks and commit primitives shared by downloads.
use std::{
    collections::HashSet,
    fs::{self, File, Metadata, OpenOptions},
    io::{self, Write},
    path::{Component, Path, PathBuf},
    time::SystemTime,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LocalNameError {
    Invalid,
    Collision,
}

pub fn validate_local_name(name: &str) -> Result<(), LocalNameError> {
    // Apply Windows rules on every OS: the resulting folder may later be
    // copied to Windows. Reject device names even with an extension.
    let stem = name.split('.').next().unwrap_or_default().trim_end_matches(' ').to_ascii_uppercase();
    let device = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || stem.strip_prefix("COM").or_else(|| stem.strip_prefix("LPT"))
            .is_some_and(|suffix| matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"));
    if device || matches!(name, "" | "." | "..") || name.ends_with(['.', ' '])
        || name.chars().any(|c| matches!(c, '\0'..='\x1f' | '\x7f' | ':' | '\\' | '/' | '<' | '>' | '"' | '|' | '?' | '*'))
    {
        return Err(LocalNameError::Invalid);
    }
    Ok(())
}

/// Keep one set per planned folder; reject case collisions on every OS.
#[derive(Default)]
pub struct PlannedNames(HashSet<String>);

impl PlannedNames {
    pub fn insert(&mut self, name: &str) -> Result<(), LocalNameError> {
        validate_local_name(name)?;
        // Uppercase then lowercase to include, e.g., final and ordinary sigma.
        if !self.0.insert(name.to_uppercase().to_lowercase()) {
            return Err(LocalNameError::Collision);
        }
        Ok(())
    }
}

#[derive(Debug)]
pub enum LocalError {
    InvalidName,
    Conflict,
    Unsupported,
    Io(io::Error),
}

fn is_link(meta: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    meta.is_symlink()
}

/// LSTAT each component: checking only the leaf would miss a redirected ancestor.
/// Callers pass a resolved absolute local path, not a remote path.
pub fn ensure_real_dir(path: &Path) -> Result<(), LocalError> {
    if !path.is_absolute() || path.components().any(|component| component == Component::ParentDir) {
        return Err(LocalError::Conflict);
    }
    let ancestors: Vec<_> = path.ancestors().collect();
    for prefix in ancestors.into_iter().rev() {
        let meta = fs::symlink_metadata(prefix).map_err(|_| LocalError::Conflict)?;
        if !meta.is_dir() || is_link(&meta) {
            return Err(LocalError::Conflict);
        }
    }
    Ok(())
}

pub fn create_child_dir_exclusive(parent: &Path, name: &str) -> Result<PathBuf, LocalError> {
    validate_local_name(name).map_err(|_| LocalError::InvalidName)?;
    ensure_real_dir(parent)?;
    let child = parent.join(name);
    fs::create_dir(&child).map_err(destination_error)?;
    Ok(child)
}

#[derive(Debug, PartialEq, Eq)]
enum Snapshot {
    Absent,
    RegularFile {
        len: u64,
        modified: Option<SystemTime>,
        created: Option<SystemTime>,
        #[cfg(unix)]
        identity: (u64, u64, i64, i64),
    },
}

fn snapshot(path: &Path) -> Result<Snapshot, LocalError> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() && !is_link(&meta) => {
            #[cfg(unix)]
            use std::os::unix::fs::MetadataExt;
            Ok(Snapshot::RegularFile {
                len: meta.len(),
                modified: meta.modified().ok(),
                created: meta.created().ok(),
                #[cfg(unix)]
                identity: (meta.dev(), meta.ino(), meta.ctime(), meta.ctime_nsec()),
            })
        }
        Ok(_) => Err(LocalError::Conflict),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(Snapshot::Absent),
        Err(err) => Err(LocalError::Io(err)),
    }
}

/// Capture immediately when the Save dialog returns, not when the transfer finishes.
/// Only this constructor authorizes replacing the unchanged regular file.
#[derive(Debug)]
pub struct FileTarget {
    path: PathBuf,
    snapshot: Snapshot,
}

impl FileTarget {
    pub fn from_save_dialog(path: PathBuf) -> Result<Self, LocalError> {
        let parent = path.parent().ok_or(LocalError::Conflict)?;
        check_basename(&path)?;
        ensure_real_dir(parent)?;
        let snapshot = snapshot(&path)?;
        Ok(Self { path, snapshot })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub(super) fn stage(&self) -> Result<StagedFile, LocalError> {
        stage_file(self.path.parent().ok_or(LocalError::Conflict)?)
    }

    pub(super) fn commit(self, part: StagedFile) -> Result<PathBuf, LocalError> {
        match self.snapshot {
            Snapshot::Absent => part.commit_no_replace(&self.path)?,
            ref expected => {
                part.check_parent(&self.path)?;
                if &snapshot(&self.path)? != expected {
                    return Err(LocalError::Conflict);
                }
                let mut part = part;
                drop(part.file.take());
                // No truncation; the completed sibling replaces the old name in one step.
                fs::rename(&part.path, &self.path).map_err(destination_error)?;
                part.cleanup = false;
            }
        }
        Ok(self.path)
    }
}

fn check_basename(path: &Path) -> Result<(), LocalError> {
    let name = path.file_name().and_then(|name| name.to_str()).ok_or(LocalError::InvalidName)?;
    validate_local_name(name).map_err(|_| LocalError::InvalidName)
}

pub struct StagedFile {
    path: PathBuf,
    file: Option<File>,
    cleanup: bool,
    #[cfg(unix)]
    directory: File,
}

pub fn stage_file(dir: &Path) -> Result<StagedFile, LocalError> {
    ensure_real_dir(dir)?;
    let path = dir.join(format!(".termflow-{}.part", uuid::Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    let directory = {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
        OpenOptions::new().read(true).custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open(dir).map_err(LocalError::Io)?
    };
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::{Foundation::GENERIC_WRITE, Storage::FileSystem::DELETE};
        options.access_mode(GENERIC_WRITE | DELETE);
    }
    let file = options.open(&path).map_err(LocalError::Io)?;
    Ok(StagedFile {
        path,
        file: Some(file),
        cleanup: true,
        #[cfg(unix)]
        directory,
    })
}

impl StagedFile {
    pub fn write_all(&mut self, bytes: &[u8]) -> Result<(), LocalError> {
        self.file.as_mut().expect("staging handle is open").write_all(bytes).map_err(LocalError::Io)
    }

    fn check_parent(&self, final_path: &Path) -> Result<(), LocalError> {
        check_basename(final_path)?;
        let parent = final_path.parent().ok_or(LocalError::Conflict)?;
        if self.path.parent() != Some(parent) {
            return Err(LocalError::Conflict);
        }
        ensure_real_dir(parent)?;
        let meta = fs::symlink_metadata(&self.path).map_err(|_| LocalError::Conflict)?;
        if !meta.is_file() || is_link(&meta) {
            return Err(LocalError::Conflict);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let open = self.file.as_ref().expect("staging handle is open").metadata().map_err(LocalError::Io)?;
            if (meta.dev(), meta.ino()) != (open.dev(), open.ino()) {
                return Err(LocalError::Conflict);
            }
        }
        Ok(())
    }

    pub fn commit_no_replace(self, final_path: &Path) -> Result<(), LocalError> {
        self.commit_with_link(final_path, |from, to| fs::hard_link(from, to))
    }

    fn commit_with_link(mut self, final_path: &Path, link: impl FnOnce(&Path, &Path) -> io::Result<()>) -> Result<(), LocalError> {
        self.check_parent(final_path)?;
        link(&self.path, final_path).map_err(link_error)?;
        drop(self.file.take());
        // Linking is the commit point. Cleanup must not turn an already
        // committed file into a reported failure with an unchanged outcome.
        self.remove_part();
        Ok(())
    }

    fn remove_part(&mut self) {
        if !self.cleanup {
            return;
        }
        #[cfg(unix)]
        let result = {
            use std::{ffi::CString, os::{fd::AsRawFd, unix::ffi::OsStrExt}};
            drop(self.file.take());
            let name = CString::new(self.path.file_name().unwrap().as_bytes()).unwrap();
            // SAFETY: the descriptor belongs to the open directory and name is
            // a live, NUL-terminated single component. A moved ancestor cannot
            // send cleanup through a link into a different directory.
            if unsafe { libc::unlinkat(self.directory.as_raw_fd(), name.as_ptr(), 0) } == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        };
        #[cfg(not(unix))]
        let result = {
            #[cfg(windows)]
            if let Some(file) = self.file.as_ref() {
                if mark_for_deletion(file) {
                    drop(self.file.take());
                    self.cleanup = false;
                    return;
                }
            }
            drop(self.file.take());
            match self.path.parent() {
                Some(dir) if ensure_real_dir(dir).is_ok() => fs::remove_file(&self.path),
                _ => Err(io::Error::other("Staging directory is no longer safe")),
            }
        };
        match result {
            Ok(()) => self.cleanup = false,
            Err(err) if err.kind() == io::ErrorKind::NotFound => self.cleanup = false,
            Err(err) => log::warn!("Could not remove download staging file: {:?}", err.kind()),
        }
    }
}

impl Drop for StagedFile {
    fn drop(&mut self) {
        self.remove_part();
    }
}

#[cfg(windows)]
fn mark_for_deletion(file: &File) -> bool {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FileDispositionInfo, SetFileInformationByHandle, FILE_DISPOSITION_INFO,
    };
    let info = FILE_DISPOSITION_INFO { DeleteFile: true };
    // SAFETY: handle is live and was opened with DELETE access; the buffer
    // layout and length are those of the selected information class.
    unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(), FileDispositionInfo,
            (&info as *const FILE_DISPOSITION_INFO).cast(),
            std::mem::size_of_val(&info) as u32,
        ) != 0
    }
}

fn destination_error(err: io::Error) -> LocalError {
    if err.kind() == io::ErrorKind::AlreadyExists { LocalError::Conflict } else { LocalError::Io(err) }
}

fn link_error(err: io::Error) -> LocalError {
    if err.kind() == io::ErrorKind::AlreadyExists {
        return LocalError::Conflict;
    }
    // link(2): EPERM (including filesystems without links), EXDEV, ENOTSUP.
    #[cfg(unix)]
    let unsupported = matches!(err.raw_os_error(), Some(libc::EPERM | libc::EXDEV | libc::ENOTSUP));
    // Win32 System Error Codes in the existing windows-sys bindings.
    #[cfg(windows)]
    let unsupported = {
        use windows_sys::Win32::Foundation::{ERROR_INVALID_FUNCTION, ERROR_NOT_SAME_DEVICE, ERROR_NOT_SUPPORTED};
        matches!(err.raw_os_error().map(|code| code as u32), Some(ERROR_INVALID_FUNCTION | ERROR_NOT_SAME_DEVICE | ERROR_NOT_SUPPORTED))
    };
    #[cfg(not(any(windows, unix)))]
    let unsupported = false;
    if unsupported || err.kind() == io::ErrorKind::Unsupported {
        LocalError::Unsupported
    } else {
        LocalError::Io(err)
    }
}

#[cfg(test)]
#[path = "local_target_tests.rs"]
mod tests;
