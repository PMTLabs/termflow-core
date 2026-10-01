//! Where a connected host's executable lives, relative to the Velopack install
//! root. `Update.exe apply --root` kills every process running from under that
//! root, so a host started from inside it cannot survive an update swap.
//!
//! The decision itself is [`classify_exe`], a pure function over paths. The
//! lookups feeding it (server pid of the live connection, that pid's image path,
//! the Velopack root) are the thin, platform-specific part.

use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

/// Facts about the host behind one connection, captured when it was wired.
#[derive(Default)]
pub(super) struct ExeOrigin {
    /// Server process id of the live connection (0 = unknown). Taken from the
    /// connection rather than a discovery record so it cannot drift from what
    /// we are actually talking to, and a record-less legacy host still has one.
    server_pid: AtomicU32,
    /// This app spawned the host itself from the bundled source path because the
    /// runtime-dir install failed. That copy runs from inside the payload.
    bundled_fallback: AtomicBool,
    /// This app started the host behind the connection, from its own resolved
    /// host binary, rather than finding one already running.
    spawned_here: AtomicBool,
    /// The build id the host advertised in its record, when there was one. Off
    /// Windows it names the host's generation (see `generation`).
    advertised_build_id: std::sync::Mutex<Option<String>>,
    /// What the OS lookup would have answered (tests, which have no real host
    /// behind a connection): the classification itself is not replaced.
    #[cfg(test)]
    #[cfg_attr(not(windows), allow(dead_code))]
    image_lookup: std::sync::Mutex<Option<Option<PathBuf>>>,
    /// A verdict decided by the test, for the rows that are about what an update
    /// does with a host in the payload or of unknown origin rather than about how
    /// that is told.
    #[cfg(test)]
    verdict: std::sync::Mutex<Option<Option<bool>>>,
}

impl ExeOrigin {
    #[cfg_attr(not(windows), allow(dead_code))]
    pub(super) fn set_server_pid(&self, pid: Option<u32>) {
        self.server_pid.store(pid.unwrap_or(0), Ordering::Release);
    }

    pub(super) fn set_bundled_fallback(&self, v: bool) {
        self.bundled_fallback.store(v, Ordering::Release);
    }

    pub(super) fn set_spawned_here(&self, v: bool) {
        self.spawned_here.store(v, Ordering::Release);
    }

    pub(super) fn spawned_here(&self) -> bool {
        self.spawned_here.load(Ordering::Acquire)
    }

    pub(super) fn set_advertised_build_id(&self, build_id: Option<String>) {
        *self.advertised_build_id.lock().unwrap_or_else(|e| e.into_inner()) = build_id;
    }

    #[cfg(test)]
    pub(super) fn inject_image_lookup(&self, image: Option<PathBuf>) {
        *self.image_lookup.lock().unwrap() = Some(image);
    }

    #[cfg(test)]
    pub(super) fn inject_verdict(&self, verdict: Option<bool>) {
        *self.verdict.lock().unwrap() = Some(verdict);
    }

    #[cfg_attr(not(windows), allow(dead_code))]
    pub(super) fn server_pid(&self) -> Option<u32> {
        Some(self.server_pid.load(Ordering::Acquire)).filter(|p| *p != 0)
    }

    /// `Some(true)` = inside the payload, `Some(false)` = outside, `None` =
    /// could not tell (callers must treat that as unsafe).
    pub(super) fn in_payload(
        &self,
        velopack_root: Option<&Path>,
        runtime_dir: Option<&Path>,
    ) -> Option<bool> {
        #[cfg(test)]
        if let Some(verdict) = *self.verdict.lock().unwrap() {
            return verdict;
        }
        if self.bundled_fallback.load(Ordering::Acquire) {
            return Some(true);
        }
        self.lookup_in_payload(velopack_root, runtime_dir)
    }

    /// The host's image path: asked of the OS from the connection's server pid.
    /// Only Windows can ask; elsewhere there is no answer.
    fn image(&self) -> Option<PathBuf> {
        #[cfg(test)]
        if let Some(image) = self.image_lookup.lock().unwrap().clone() {
            return image;
        }
        #[cfg(windows)]
        {
            self.server_pid().and_then(image_path_of)
        }
        #[cfg(not(windows))]
        {
            None
        }
    }

    /// The generation of the host behind this connection, when it can be shown.
    /// `None` is "cannot be shown", which callers must not read as any particular
    /// generation.
    ///
    /// Where the host runs from says it: the image sits in its generation's
    /// install directory. Only Windows can look the image up. Elsewhere there is no
    /// ConPTY pair, so the generation is the host file's digest alone, whose first
    /// 16 hex digits the host's record advertises as its build id. On Windows the
    /// pair is part of the generation and the build id proves nothing about it, so
    /// there it is never consulted.
    pub(super) fn generation(&self, install_base: Option<&Path>) -> Option<String> {
        if let Some(image) = self.image() {
            return generation_of_image(image.as_path(), install_base?, cfg!(windows));
        }
        self.generation_from_build_id()
    }

    #[cfg(windows)]
    fn generation_from_build_id(&self) -> Option<String> {
        None
    }

    #[cfg(not(windows))]
    fn generation_from_build_id(&self) -> Option<String> {
        generation_of_build_id(self.advertised_build_id.lock().unwrap_or_else(|e| e.into_inner()).as_deref()?)
    }

    #[cfg(windows)]
    fn lookup_in_payload(
        &self,
        velopack_root: Option<&Path>,
        runtime_dir: Option<&Path>,
    ) -> Option<bool> {
        let image = self.image();
        classify_exe(image.as_deref(), velopack_root, runtime_dir, false, true)
    }

    /// There is no image-path lookup here yet. Answering `None` would force a
    /// full restart for every user, so an adopted host of unknown origin is
    /// reported as outside the payload, with one logged exception.
    #[cfg(not(windows))]
    fn lookup_in_payload(&self, _: Option<&Path>, _: Option<&Path>) -> Option<bool> {
        static LOGGED: AtomicBool = AtomicBool::new(false);
        if first_time(&LOGGED) {
            log::warn!(
                "pty-host: no image-path lookup on this platform; treating an adopted host as \
                 outside the update payload"
            );
        }
        Some(false)
    }
}

#[cfg(any(not(windows), test))]
pub(super) fn first_time(flag: &AtomicBool) -> bool {
    !flag.swap(true, Ordering::AcqRel)
}

/// Did the app spawn this host from the bundled source path? True only for a
/// host we launched ourselves whose executable is not under the runtime dir the
/// install step writes to (or there is no runtime dir at all).
pub(super) fn spawned_from_bundled_fallback(
    spawned_here: bool,
    sidecar: &Path,
    runtime_dir: Option<&Path>,
    case_insensitive: bool,
) -> bool {
    spawned_here
        && !runtime_dir.is_some_and(|dir| path_within(sidecar, dir, case_insensitive))
}

/// Pure classification of a host image path.
///
/// - `bundled_src`: the host was launched from the bundled source path, which
///   lives in the payload whatever the lookup says.
/// - `image == None` (lookup failed) fails closed as `None`.
/// - the runtime dir is explicitly safe, and is checked first so it stays safe
///   even if an unusual layout put it under the root;
/// - no Velopack root means this is not an installed build, so nothing swaps.
#[cfg_attr(not(windows), allow(dead_code))]
pub(super) fn classify_exe(
    image: Option<&Path>,
    velopack_root: Option<&Path>,
    runtime_dir: Option<&Path>,
    bundled_src: bool,
    case_insensitive: bool,
) -> Option<bool> {
    if bundled_src {
        return Some(true);
    }
    let image = image?;
    if runtime_dir.is_some_and(|dir| path_within(image, dir, case_insensitive)) {
        return Some(false);
    }
    Some(velopack_root.is_some_and(|root| path_within(image, root, case_insensitive)))
}

/// The generation of a host with no ConPTY pair, from its advertised build id: the
/// install directory is named by the first 8 bytes of the host file's digest, and
/// the build id is that digest in full.
#[cfg_attr(windows, allow(dead_code))]
pub(super) fn generation_of_build_id(build_id: &str) -> Option<String> {
    let prefix = build_id.get(..16)?.to_ascii_lowercase();
    super::discovery::valid_generation(&prefix).then_some(prefix)
}

/// The generation a host image belongs to: `<install_base>/<generation>/<exe>`,
/// where the directory name is a generation (16 lowercase hex digits) and
/// `install_base` is where the app installs hosts. An image anywhere else (the
/// bundled copy, another profile's directory) names no generation.
pub(super) fn generation_of_image(
    image: &Path,
    install_base: &Path,
    case_insensitive: bool,
) -> Option<String> {
    let dir = image.parent()?;
    let name = dir.file_name()?.to_str()?.to_ascii_lowercase();
    let parent = dir.parent()?;
    let same_base = path_within(parent, install_base, case_insensitive)
        && path_within(install_base, parent, case_insensitive);
    (same_base && super::discovery::valid_generation(&name)).then_some(name)
}

/// Component-aware containment (`TermFlowOther` is not inside `TermFlow`) over
/// canonicalised paths, case-insensitive when asked.
pub(super) fn path_within(child: &Path, base: &Path, case_insensitive: bool) -> bool {
    normalise(child, case_insensitive).starts_with(normalise(base, case_insensitive))
}

fn normalise(path: &Path, case_insensitive: bool) -> PathBuf {
    let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| lexically_clean(path));
    // Canonical Windows paths are verbatim (`\\?\C:\…`); strip that so a
    // canonicalised path and one that could not be compared equal.
    let text = resolved.to_string_lossy().into_owned();
    let text = if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        text
    };
    if case_insensitive {
        PathBuf::from(text.to_lowercase())
    } else {
        PathBuf::from(text)
    }
}

/// Resolve `.` and `..` without touching the filesystem, for paths that do not
/// exist (or cannot be canonicalised).
fn lexically_clean(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push(component);
                }
            }
            other => out.push(other),
        }
    }
    out
}

/// Server process id behind a client-side named-pipe handle.
#[cfg(windows)]
pub(super) fn server_pid_of_pipe(handle: std::os::windows::io::RawHandle) -> Option<u32> {
    use windows_sys::Win32::System::Pipes::GetNamedPipeServerProcessId;
    let mut pid = 0u32;
    // SAFETY: `handle` is a live pipe handle owned by the caller for this call.
    let ok = unsafe { GetNamedPipeServerProcessId(handle as _, &mut pid) };
    (ok != 0 && pid != 0).then_some(pid)
}

/// Full image path of a process, or `None` when it cannot be opened or read.
#[cfg(windows)]
pub(super) fn image_path_of(pid: u32) -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // SAFETY: plain Win32 calls; the handle is closed on every path below.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return None;
        }
        let mut buf = vec![0u16; 32768];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(process, 0, buf.as_mut_ptr(), &mut len);
        CloseHandle(process);
        (ok != 0).then(|| PathBuf::from(std::ffi::OsString::from_wide(&buf[..len as usize])))
    }
}

/// Root of the Velopack install this app runs from, located through Velopack.
/// `None` when this is not a Velopack install (dev, store) or off Windows,
/// where the classifier is not implemented.
pub(super) fn velopack_root() -> Option<PathBuf> {
    #[cfg(all(windows, feature = "velopack-updates"))]
    {
        use velopack::locator::{auto_locate_app_manifest, LocationContext};
        static ROOT: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();
        ROOT.get_or_init(|| {
            auto_locate_app_manifest(LocationContext::FromCurrentExe)
                .ok()
                .map(|locator| locator.get_root_dir())
        })
        .clone()
    }
    #[cfg(not(all(windows, feature = "velopack-updates")))]
    None
}
