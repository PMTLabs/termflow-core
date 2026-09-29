//! Sideloading Microsoft's modern ConPTY (`conpty.dll` + `OpenConsole.exe`).
//!
//! The inbox ConPTY (`kernel32!CreatePseudoConsole`) swallows `OSC 10/11 ; ?`
//! colour queries, so TUIs such as Codex CLI never learn the background colour.
//! `portable-pty` resolves ConPTY once, lazily, with `LoadLibrary("conpty.dll")`
//! (bare name). A bare-name load returns a module of that name that is ALREADY
//! loaded, so we load our verified copy by FULL path first and never widen the
//! DLL search path (plan 049).
//!
//! Trust model — only these exact bytes are ever loaded:
//! * both files are pinned by SHA-256 ([`PINS`]); a valid signature from any
//!   other publisher is rejected, and so is a tampered or stale staged copy;
//! * the files are opened deny-write/delete and the handles are kept for the
//!   life of the process, so they cannot be swapped between verification and
//!   the moment `conpty.dll` / `OpenConsole.exe` are mapped;
//! * `WinVerifyTrust` is kept as defence in depth.
//!
//! The pair is looked up in a `conpty/` SUBFOLDER next to the exe, never beside
//! the exe itself, so a stray file there is not part of what we ship.
//! `TERMFLOW_DISABLE_BUNDLED_CONPTY=1` skips the preload; ConPTY then resolves
//! `conpty.dll` by the normal search order, which finds nothing we ship, so
//! `portable-pty` uses `kernel32`.

use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Read;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const DISABLE_ENV: &str = "TERMFLOW_DISABLE_BUNDLED_CONPTY";
pub const DLL: &str = "conpty.dll";
pub const HOST: &str = "OpenConsole.exe";
/// Subfolder name for the staged pair, next to `termflow-pty-host.exe`.
pub const SUBDIR: &str = "conpty";

/// SHA-256 of the shipped pair (NuGet `Microsoft.Windows.Console.ConPTY`
/// 1.24.260303001). Bumping the binaries means bumping these; the
/// `shipped_pair_matches_pins` test fails until both are updated.
struct Pin {
    arch: &'static str,
    dll: &'static str,
    host: &'static str,
}
const PINS: [Pin; 2] = [
    Pin {
        arch: "x86_64",
        dll: "62524d4e62d6c2e487b1444ea661f5de2c5bb76b73e84aea8ee69053444851d0",
        host: "661bc2131fac6ec44afd438284bbfc0b719da3163ceebfc3bdab45e3dbeca7b2",
    },
    Pin {
        arch: "aarch64",
        dll: "781e3a1bef6ee319cbf571f8a23892ec785f04cb9496aeeefeb41b73cd0d3a3c",
        host: "18d81fabdc90c4d104581c23745125c30edba16edb90b9cc2c1164bfc7f365e4",
    },
];

/// Directory name used for this build's target architecture.
pub fn arch_dir() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "x86_64"
    }
}

fn pin() -> &'static Pin {
    PINS.iter().find(|p| p.arch == arch_dir()).expect("pin for target arch")
}

pub fn disabled() -> bool {
    std::env::var(DISABLE_ENV).map(|v| v == "1").unwrap_or(false)
}

fn has_pair(dir: &Path) -> bool {
    dir.join(DLL).is_file() && dir.join(HOST).is_file()
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes.iter().fold(String::with_capacity(64), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

fn hash_file(f: &mut File) -> std::io::Result<String> {
    let mut h = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex(&h.finalize()))
}

/// True when both files in `dir` are byte-identical to the pinned pair.
pub fn matches_pins(dir: &Path) -> bool {
    let p = pin();
    [(DLL, p.dll), (HOST, p.host)].iter().all(|(name, want)| {
        File::open(dir.join(name))
            .and_then(|mut f| hash_file(&mut f))
            .map(|got| got == *want)
            .unwrap_or(false)
    })
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

/// Dual lookup: the staged `conpty/` sibling first, then the bundled source. A
/// candidate that is not exactly the pinned pair is skipped, so a damaged or
/// substituted staged copy falls through to the next candidate.
pub fn locate(exe_dir: &Path) -> Option<PathBuf> {
    let staged = exe_dir.join(SUBDIR);
    if has_pair(&staged) && matches_pins(&staged) {
        return Some(staged);
    }
    bundled_source(exe_dir).filter(|d| matches_pins(d))
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

/// Handles pinned open for the life of the process: while they are held the
/// verified files cannot be written to or deleted.
struct Loaded {
    dir: PathBuf,
    _files: Vec<File>,
}
static LOADED: Mutex<Option<Loaded>> = Mutex::new(None);

fn module_path(name: &str) -> Option<PathBuf> {
    use windows_sys::Win32::System::LibraryLoader::{GetModuleFileNameW, GetModuleHandleW};
    let w: Vec<u16> = std::ffi::OsStr::new(name).encode_wide().chain(Some(0)).collect();
    // SAFETY: NUL-terminated name.
    let h = unsafe { GetModuleHandleW(w.as_ptr()) };
    if h.is_null() {
        return None;
    }
    let mut buf = [0u16; 1024];
    // SAFETY: the length passed is the buffer's length.
    let n = unsafe { GetModuleFileNameW(h, buf.as_mut_ptr(), buf.len() as u32) } as usize;
    (n > 0 && n < buf.len()).then(|| PathBuf::from(String::from_utf16_lossy(&buf[..n])))
}

/// Verify `dir`'s pair, lock it, and load `conpty.dll` from it by full path.
fn preload(dir: &Path) -> Result<Vec<File>, String> {
    use windows_sys::Win32::Foundation::FreeLibrary;
    use windows_sys::Win32::System::LibraryLoader::LoadLibraryExW;
    const FILE_SHARE_READ: u32 = 1;

    let p = pin();
    let mut files = Vec::new();
    for (name, want) in [(DLL, p.dll), (HOST, p.host)] {
        let path = dir.join(name);
        // Read access, share READ only: nobody can write or delete it from now on.
        let mut f = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .open(&path)
            .map_err(|e| format!("{}: {e}", path.display()))?;
        let got = hash_file(&mut f).map_err(|e| format!("{}: {e}", path.display()))?;
        if got != want {
            return Err(format!("{} is not the pinned build", path.display()));
        }
        if !is_signed(&path) {
            return Err(format!("{} failed signature check", path.display()));
        }
        files.push(f);
    }
    let dll = dir.join(DLL);
    let wide: Vec<u16> = dll.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: NUL-terminated absolute path; no reserved handle; default flags.
    let h = unsafe { LoadLibraryExW(wide.as_ptr(), std::ptr::null_mut(), 0) };
    if h.is_null() {
        return Err(format!("LoadLibrary {}: {}", dll.display(), std::io::Error::last_os_error()));
    }
    let same = module_path(DLL)
        .and_then(|m| Some((std::fs::canonicalize(m).ok()?, std::fs::canonicalize(&dll).ok()?)))
        .is_some_and(|(a, b)| a == b);
    if !same {
        // Some other conpty.dll was already in the process; do not claim ours.
        // SAFETY: `h` came from the LoadLibraryExW above.
        unsafe { FreeLibrary(h) };
        return Err("a different conpty.dll is already loaded".into());
    }
    Ok(files)
}

/// Preload the verified pair so `portable-pty`'s later bare-name load resolves to
/// it. Must run before the first `openpty()` (that loader is a one-shot
/// `lazy_static`). Returns the directory used, or `None` for inbox ConPTY.
pub fn init_conpty(exe_dir: &Path) -> Option<PathBuf> {
    init_conpty_with(exe_dir, disabled())
}

/// [`init_conpty`] with the rollback flag passed in, so tests need not mutate
/// the process environment.
pub fn init_conpty_with(exe_dir: &Path, disable: bool) -> Option<PathBuf> {
    if disable {
        log::info!("[CONPTY] {DISABLE_ENV}=1; not preloading bundled ConPTY");
        return None;
    }
    let mut slot = LOADED.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(l) = slot.as_ref() {
        return Some(l.dir.clone());
    }
    let Some(dir) = locate(exe_dir) else {
        log::info!("[CONPTY] no verified bundled ConPTY found; using inbox ConPTY");
        return None;
    };
    match preload(&dir) {
        Ok(files) => {
            log::info!("[CONPTY] preloaded verified conpty.dll from {}", dir.display());
            *slot = Some(Loaded { dir: dir.clone(), _files: files });
            Some(dir)
        }
        Err(e) => {
            log::warn!("[CONPTY] not using bundled ConPTY ({e}); using inbox ConPTY");
            None
        }
    }
}

/// [`init_conpty`] anchored at the running executable's directory.
pub fn init_for_current_exe() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    init_conpty(exe.parent()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::System::LibraryLoader::LoadLibraryW;

    fn wide(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s).encode_wide().chain(Some(0)).collect()
    }

    fn repo_pair() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("binaries")
            .join("conpty")
            .join(arch_dir())
    }

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("conpty-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join(SUBDIR)).unwrap();
        d
    }

    #[test]
    fn shipped_pair_matches_pins_and_is_signed() {
        let d = repo_pair();
        assert!(has_pair(&d), "missing pinned ConPTY pair in {}", d.display());
        assert!(matches_pins(&d), "shipped binaries differ from PINS — update both together");
        assert!(is_signed(&d.join(DLL)) && is_signed(&d.join(HOST)));
    }

    #[test]
    fn unsigned_file_is_rejected() {
        let f = std::env::temp_dir().join(format!("unsigned-{}.dll", std::process::id()));
        std::fs::write(&f, b"MZ not signed").unwrap();
        assert!(!is_signed(&f));
        let _ = std::fs::remove_file(&f);
    }

    /// A pair that is validly signed by someone else must NOT be accepted:
    /// signed system binaries stand in for "trusted publisher, wrong bytes".
    #[test]
    fn a_validly_signed_but_unpinned_pair_is_rejected() {
        let root = scratch("wrongsigned");
        let sys = Path::new(&std::env::var_os("SystemRoot").unwrap()).join("System32");
        std::fs::copy(sys.join("kernel32.dll"), root.join(SUBDIR).join(DLL)).unwrap();
        std::fs::copy(sys.join("notepad.exe"), root.join(SUBDIR).join(HOST)).unwrap();
        assert!(is_signed(&root.join(SUBDIR).join(DLL)), "precondition: signature is valid");
        assert_eq!(locate(&root), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// One test (loaded modules and the LOADED slot are process-global). Order:
    /// rollback, tampered copy, then the real load.
    #[test]
    fn rollback_and_tamper_leave_conpty_unloaded_then_init_preloads_by_full_path() {
        let root = scratch("load");
        let sub = root.join(SUBDIR);
        for f in [DLL, HOST] {
            std::fs::copy(repo_pair().join(f), sub.join(f)).unwrap();
        }
        assert_eq!(locate(&root), Some(sub.clone()), "staged sibling wins");

        assert!(init_conpty_with(&root, true).is_none());
        assert!(module_path(DLL).is_none(), "rollback must not load conpty.dll");

        // Tamper one byte: same signature-shaped file, different bytes.
        let dll = sub.join(DLL);
        let good = std::fs::read(&dll).unwrap();
        let mut bad = good.clone();
        *bad.last_mut().unwrap() ^= 1;
        std::fs::write(&dll, &bad).unwrap();
        assert_eq!(locate(&root), None, "tampered pair must not be selected");
        assert!(init_conpty_with(&root, false).is_none());
        assert!(module_path(DLL).is_none(), "tampered pair must not be loaded");
        std::fs::write(&dll, &good).unwrap();

        assert_eq!(init_conpty_with(&root, false), Some(sub.clone()));
        assert_eq!(
            std::fs::canonicalize(module_path(DLL).unwrap()).unwrap(),
            std::fs::canonicalize(&dll).unwrap()
        );
        // portable-pty's bare-name load must resolve to that same module.
        let w = wide(DLL);
        // SAFETY: NUL-terminated name.
        assert!(!unsafe { LoadLibraryW(w.as_ptr()) }.is_null());
        assert_eq!(
            std::fs::canonicalize(module_path(DLL).unwrap()).unwrap(),
            std::fs::canonicalize(&dll).unwrap()
        );
        // Deny-write/delete is held: the verified files cannot be swapped now.
        assert!(std::fs::write(&dll, b"x").is_err(), "verified DLL must be locked");
        assert!(std::fs::write(sub.join(HOST), b"x").is_err(), "verified EXE must be locked");
        // Idempotent.
        assert_eq!(init_conpty_with(&root, false), Some(sub));
    }
}
