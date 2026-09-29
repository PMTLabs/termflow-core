//! Sideloading Microsoft's modern ConPTY (`conpty.dll` + `OpenConsole.exe`).
//!
//! The inbox ConPTY (`kernel32!CreatePseudoConsole`) swallows `OSC 10/11 ; ?`
//! colour queries, so TUIs such as Codex CLI never learn the background colour.
//! `portable-pty` prefers a `conpty.dll` it can `LoadLibrary`, so all we do is
//! point the DLL search path at a directory holding the pair (plan 049).
//!
//! The pair lives in a `conpty/` SUBFOLDER, never beside the `.exe`: beside the
//! exe the default DLL search would load it unconditionally and
//! `TERMFLOW_DISABLE_BUNDLED_CONPTY=1` could not roll back.

use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};

pub const DISABLE_ENV: &str = "TERMFLOW_DISABLE_BUNDLED_CONPTY";
pub const DLL: &str = "conpty.dll";
pub const HOST: &str = "OpenConsole.exe";
/// Subfolder name for the staged pair, next to `termflow-pty-host.exe`.
pub const SUBDIR: &str = "conpty";

/// Directory name used for this build's target architecture.
pub fn arch_dir() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "x86_64"
    }
}

pub fn disabled() -> bool {
    std::env::var(DISABLE_ENV).map(|v| v == "1").unwrap_or(false)
}

fn has_pair(dir: &Path) -> bool {
    dir.join(DLL).is_file() && dir.join(HOST).is_file()
}

/// Where the *unstaged* pair ships: `<exe dir>/resources/binaries/conpty/<arch>`
/// (installed layout) or, in debug builds only, `src-tauri/binaries/conpty/<arch>`
/// found by walking up from the exe (`bun run dev`).
pub fn bundled_source(exe_dir: &Path) -> Option<PathBuf> {
    let installed = exe_dir
        .join("resources")
        .join("binaries")
        .join("conpty")
        .join(arch_dir());
    if has_pair(&installed) {
        return Some(installed);
    }
    if cfg!(debug_assertions) {
        for anc in exe_dir.ancestors().take(6) {
            let dev = anc.join("binaries").join("conpty").join(arch_dir());
            if has_pair(&dev) {
                return Some(dev);
            }
            let dev = anc
                .join("src-tauri")
                .join("binaries")
                .join("conpty")
                .join(arch_dir());
            if has_pair(&dev) {
                return Some(dev);
            }
        }
    }
    None
}

/// Dual lookup: the staged `conpty/` sibling first, then the bundled source.
pub fn locate(exe_dir: &Path) -> Option<PathBuf> {
    let staged = exe_dir.join(SUBDIR);
    if has_pair(&staged) {
        return Some(staged);
    }
    bundled_source(exe_dir)
}

/// True when `path` carries a valid Authenticode signature (offline: no
/// revocation lookup, no UI).
#[allow(unused_assignments)] // CLOSE state is read by WinVerifyTrust through `p`
pub fn is_signed(path: &Path) -> bool {
    use windows_sys::Win32::Security::WinTrust::*;

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut file = WINTRUST_FILE_INFO {
        cbStruct: std::mem::size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: wide.as_ptr(),
        hFile: std::ptr::null_mut(),
        pgKnownSubject: std::ptr::null_mut(),
    };
    // SAFETY: a zeroed WINTRUST_DATA is the documented starting state; every
    // field WinVerifyTrust reads is set below, and `file`/`wide` outlive the calls.
    let mut data: WINTRUST_DATA = unsafe { std::mem::zeroed() };
    data.cbStruct = std::mem::size_of::<WINTRUST_DATA>() as u32;
    data.dwUIChoice = WTD_UI_NONE;
    data.fdwRevocationChecks = WTD_REVOKE_NONE;
    data.dwUnionChoice = WTD_CHOICE_FILE;
    data.Anonymous.pFile = &mut file;
    data.dwStateAction = WTD_STATEACTION_VERIFY;
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    let p = &mut data as *mut WINTRUST_DATA as *mut core::ffi::c_void;
    // SAFETY: valid pointers as above; INVALID_HANDLE_VALUE = no parent window.
    let rc = unsafe { WinVerifyTrust(-1isize as _, &mut action, p) };
    data.dwStateAction = WTD_STATEACTION_CLOSE;
    // SAFETY: releases the state opened by the VERIFY call above.
    unsafe { WinVerifyTrust(-1isize as _, &mut action, p) };
    rc == 0
}

/// Point the DLL search path at the verified pair so `portable-pty` sideloads it.
/// Must run before the first `openpty()` (its loader is a one-shot `lazy_static`).
/// Returns the directory in effect, or `None` when falling back to inbox ConPTY.
pub fn init_conpty(exe_dir: &Path) -> Option<PathBuf> {
    use windows_sys::Win32::System::LibraryLoader::SetDllDirectoryW;

    if disabled() {
        log::info!("[CONPTY] {DISABLE_ENV}=1; falling back to kernel32.dll");
        return None;
    }
    let Some(dir) = locate(exe_dir) else {
        log::info!("[CONPTY] no bundled ConPTY found; falling back to kernel32.dll");
        return None;
    };
    for f in [DLL, HOST] {
        if !is_signed(&dir.join(f)) {
            log::warn!(
                "[CONPTY] {} failed signature check; falling back to kernel32.dll",
                dir.join(f).display()
            );
            return None;
        }
    }
    let wide: Vec<u16> = dir.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: NUL-terminated wide string alive for the call.
    if unsafe { SetDllDirectoryW(wide.as_ptr()) } == 0 {
        log::warn!("[CONPTY] SetDllDirectoryW failed; falling back to kernel32.dll");
        return None;
    }
    log::info!("[CONPTY] loaded bundled modern ConPTY from {}", dir.display());
    Some(dir)
}

/// [`init_conpty`] anchored at the running executable's directory.
pub fn init_for_current_exe() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    init_conpty(exe.parent()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::System::LibraryLoader::{
        GetModuleFileNameW, GetModuleHandleW, LoadLibraryW,
    };

    fn wide(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s).encode_wide().chain(Some(0)).collect()
    }

    fn module_path(name: &str) -> Option<PathBuf> {
        let w = wide(name);
        // SAFETY: NUL-terminated name.
        let h = unsafe { GetModuleHandleW(w.as_ptr()) };
        if h.is_null() {
            return None;
        }
        let mut buf = [0u16; 1024];
        // SAFETY: buffer length passed matches the buffer.
        let n = unsafe { GetModuleFileNameW(h, buf.as_mut_ptr(), buf.len() as u32) } as usize;
        Some(PathBuf::from(String::from_utf16_lossy(&buf[..n])))
    }

    fn repo_pair() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("binaries")
            .join("conpty")
            .join(arch_dir())
    }

    #[test]
    fn shipped_pair_is_present_and_signed() {
        let d = repo_pair();
        assert!(has_pair(&d), "missing pinned ConPTY pair in {}", d.display());
        assert!(is_signed(&d.join(DLL)) && is_signed(&d.join(HOST)));
    }

    #[test]
    fn unsigned_file_is_rejected() {
        let f = std::env::temp_dir().join(format!("unsigned-{}.dll", std::process::id()));
        std::fs::write(&f, b"MZ not signed").unwrap();
        assert!(!is_signed(&f));
        let _ = std::fs::remove_file(&f);
    }

    /// One test (the DLL search dir and loaded modules are process-global):
    /// rollback first, then a real load, then a canonical-path check.
    #[test]
    fn rollback_leaves_conpty_unloaded_and_init_loads_from_subfolder() {
        let root = std::env::temp_dir().join(format!("conpty-t-{}", std::process::id()));
        let sub = root.join(SUBDIR);
        std::fs::create_dir_all(&sub).unwrap();
        for f in [DLL, HOST] {
            std::fs::copy(repo_pair().join(f), sub.join(f)).unwrap();
        }
        assert_eq!(locate(&root), Some(sub.clone()), "staged sibling wins");

        std::env::set_var(DISABLE_ENV, "1");
        assert!(init_conpty(&root).is_none());
        assert!(module_path(DLL).is_none(), "rollback must not load conpty.dll");
        std::env::remove_var(DISABLE_ENV);

        assert_eq!(init_conpty(&root), Some(sub.clone()));
        // Bare-name load is exactly what portable-pty does.
        let w = wide(DLL);
        // SAFETY: NUL-terminated name.
        assert!(!unsafe { LoadLibraryW(w.as_ptr()) }.is_null(), "bare-name load failed");
        assert_eq!(
            std::fs::canonicalize(module_path(DLL).unwrap()).unwrap(),
            std::fs::canonicalize(sub.join(DLL)).unwrap()
        );
    }
}
