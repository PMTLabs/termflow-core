//! Windows: pin every directory component without FILE_SHARE_DELETE, reject all reparse
//! points, and create/verify protected, current-user-only owner/DACLs (not inherited ACLs).
use super::{component, denied, MAX_FILE};
use std::ffi::c_void;
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::path::{Component, Path, PathBuf};
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::{
    CloseHandle, LocalFree, ERROR_INVALID_PARAMETER, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo,
    SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    GetAce, GetSecurityDescriptorControl, GetTokenInformation, IsValidSid, TokenUser,
    ACCESS_ALLOWED_ACE, ACL, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION,
    SECURITY_ATTRIBUTES, SE_DACL_PROTECTED, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::*;
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetExitCodeProcess, OpenProcess, OpenProcessToken,
    PROCESS_QUERY_LIMITED_INFORMATION,
};

pub(super) struct Dir {
    path: PathBuf,
    file: File,
    // Ancestors must remain pinned too: no junction or directory replacement between
    // verification and a subsequent absolute Win32 path operation.
    parents: Vec<File>,
}

fn wide(path: &Path) -> io::Result<Vec<u16>> {
    let mut value: Vec<u16> = path.as_os_str().encode_wide().collect();
    if value.contains(&0) {
        return Err(denied());
    }
    value.push(0);
    Ok(value)
}

struct LocalMemory(*mut c_void);
impl Drop for LocalMemory {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}

fn sid_string(sid: *mut c_void) -> io::Result<String> {
    if sid.is_null() || unsafe { IsValidSid(sid) } == 0 {
        return Err(denied());
    }
    let mut raw = null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut raw) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let _memory = LocalMemory(raw.cast());
    let len = unsafe { (0..).take_while(|&i| *raw.add(i) != 0).count() };
    Ok(String::from_utf16_lossy(unsafe {
        std::slice::from_raw_parts(raw, len)
    }))
}

fn user_sid() -> io::Result<String> {
    let mut token = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let result = (|| {
        let mut size = 0;
        unsafe {
            GetTokenInformation(token, TokenUser, null_mut(), 0, &mut size);
        }
        // usize storage satisfies TOKEN_USER/SID alignment.
        let mut buffer = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
        if size == 0
            || unsafe {
                GetTokenInformation(
                    token,
                    TokenUser,
                    buffer.as_mut_ptr().cast(),
                    size,
                    &mut size,
                )
            } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
        sid_string(user.User.Sid)
    })();
    unsafe {
        CloseHandle(token);
    }
    result
}

fn descriptor() -> io::Result<LocalMemory> {
    let sid = user_sid()?;
    let sddl: Vec<u16> = format!("O:{sid}D:P(A;;FA;;;{sid})")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut sd = null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), 1, &mut sd, null_mut())
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(LocalMemory(sd))
}

fn attributes(sd: &LocalMemory) -> SECURITY_ATTRIBUTES {
    SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd.0,
        bInheritHandle: 0,
    }
}

fn verify_acl(file: &File) -> io::Result<()> {
    let mut owner = null_mut();
    let mut acl: *mut ACL = null_mut();
    let mut sd = null_mut();
    let error = unsafe {
        GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut acl,
            null_mut(),
            &mut sd,
        )
    };
    if error != 0 {
        return Err(io::Error::from_raw_os_error(error as i32));
    }
    let _memory = LocalMemory(sd);
    let sid = user_sid()?;
    let mut control = 0;
    let mut revision = 0;
    if unsafe { GetSecurityDescriptorControl(sd, &mut control, &mut revision) } == 0
        || control & SE_DACL_PROTECTED == 0
        || sid_string(owner)? != sid
        || acl.is_null()
        || unsafe { (*acl).AceCount } != 1
    {
        return Err(denied());
    }
    let mut ace = null_mut();
    if unsafe { GetAce(acl, 0, &mut ace) } == 0 {
        return Err(denied());
    }
    // GetAce returns an OS-validated ACE within the allocated security descriptor.
    let allowed = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
    if allowed.Header.AceType != 0 // ACCESS_ALLOWED_ACE_TYPE
        || allowed.Header.AceFlags != 0
        || allowed.Mask != FILE_ALL_ACCESS
        || sid_string(std::ptr::addr_of!(allowed.SidStart).cast_mut().cast())? != sid
    {
        return Err(denied());
    }
    Ok(())
}

fn open(path: &Path, directory: bool, create: bool) -> io::Result<File> {
    let sd = if create { Some(descriptor()?) } else { None };
    let sa = sd.as_ref().map(attributes);
    let access = if directory {
        FILE_READ_ATTRIBUTES | READ_CONTROL
    } else {
        FILE_GENERIC_READ | FILE_GENERIC_WRITE
    };
    let file = unsafe {
        CreateFileW(
            wide(path)?.as_ptr(),
            access,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            sa.as_ref().map_or(null(), |a| a),
            if create { CREATE_NEW } else { OPEN_EXISTING },
            FILE_FLAG_OPEN_REPARSE_POINT
                | if directory {
                    FILE_FLAG_BACKUP_SEMANTICS
                } else {
                    FILE_ATTRIBUTE_NORMAL
                },
            null_mut(),
        )
    };
    if file == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let file = unsafe { File::from_raw_handle(file) };
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory
        || (!directory
            && (unsafe { GetFileType(file.as_raw_handle()) } != FILE_TYPE_DISK
                || info.nNumberOfLinks != 1))
    {
        return Err(denied());
    }
    Ok(file)
}

fn create_directory(path: &Path) -> io::Result<()> {
    let sd = descriptor()?;
    let sa = attributes(&sd);
    if unsafe { CreateDirectoryW(wide(path)?.as_ptr(), &sa) } == 0 {
        return Err(io::Error::last_os_error());
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
        let mut full = PathBuf::new();
        let mut parents = Vec::new();
        for part in path.components() {
            match part {
                Component::Prefix(p) => {
                    // Local drive paths only. UNC/device namespaces are not app-data roots.
                    if !matches!(
                        p.kind(),
                        std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_)
                    ) {
                        return Err(denied());
                    }
                    full.push(p.as_os_str());
                    // A verbatim drive prefix reports has_root(), but is not a directory
                    // until RootDir supplies the separator (\\?\C: is a volume device).
                    continue;
                }
                Component::RootDir => {
                    full.push(part.as_os_str());
                }
                Component::Normal(name) => {
                    full.push(name);
                    match create_directory(&full) {
                        Ok(()) => {}
                        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                        Err(e) => return Err(e),
                    }
                }
                _ => return Err(denied()),
            }
            if full.has_root() {
                parents.push(open(&full, true, false)?);
            }
        }
        let file = parents.pop().ok_or_else(denied)?;
        Ok(Self {
            path: full,
            file,
            parents,
        })
    }

    pub(super) fn verify_private(&self) -> io::Result<()> {
        verify_acl(&self.file)
    }

    pub(super) fn child(&self, name: &str, create: bool) -> io::Result<Self> {
        component(name)?;
        let path = self.path.join(name);
        if create {
            match create_directory(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e),
            }
        }
        let file = open(&path, true, false)?;
        verify_acl(&file)?;
        let mut parents = self
            .parents
            .iter()
            .map(File::try_clone)
            .collect::<io::Result<Vec<_>>>()?;
        parents.push(self.file.try_clone()?);
        Ok(Self {
            path,
            file,
            parents,
        })
    }

    pub(super) fn create_child(&self, name: &str) -> io::Result<Self> {
        self.verify_private()?;
        component(name)?;
        create_directory(&self.path.join(name))?;
        self.child(name, false)
    }

    pub(super) fn open_file(&self, name: &str) -> io::Result<File> {
        self.verify_private()?;
        component(name)?;
        let file = open(&self.path.join(name), false, false)?;
        verify_acl(&file)?;
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
        component(name)?;
        let stage = self.path.join(format!("stage-{}", uuid::Uuid::new_v4()));
        let mut file = open(&stage, false, true)?;
        let result = (|| {
            verify_acl(&file)?;
            file.write_all(bytes)?;
            file.sync_all()
        })();
        drop(file);
        let result = result.and_then(|_| std::fs::hard_link(&stage, self.path.join(name)));
        let cleanup = std::fs::remove_file(&stage);
        result?;
        cleanup
    }

    pub(super) fn remove_file(&self, name: &str) -> io::Result<()> {
        drop(self.open_file(name)?);
        std::fs::remove_file(self.path.join(name))
    }

    pub(super) fn remove_dir(&self, name: &str) -> io::Result<()> {
        self.verify_private()?;
        component(name)?;
        std::fs::remove_dir(self.path.join(name))
    }

    pub(super) fn names(&self) -> io::Result<Vec<String>> {
        self.verify_private()?;
        std::fs::read_dir(&self.path)?
            .map(|entry| Ok(entry?.file_name().to_string_lossy().into_owned()))
            .collect()
    }
}

pub(super) fn process_absent(pid: u32) -> bool {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return io::Error::last_os_error().raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32);
    }
    let mut code = 0;
    let ok = unsafe { GetExitCodeProcess(handle, &mut code) };
    unsafe {
        CloseHandle(handle);
    }
    ok != 0 && code != 259 // STILL_ACTIVE; uncertainty is never permission to delete.
}
