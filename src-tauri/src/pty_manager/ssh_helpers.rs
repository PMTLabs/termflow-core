//! Private, immutable SSH hook/payload storage. No TMP/TEMP lookup and no shell invocation.
//!
//! Callers supply generated code with fixed absolute executable paths, never credentials.
//! Hooks belong to the shell process, not a launch attempt. Payload use must be leased BEFORE
//! handing its path to a shell, and the lease retained until execution is known to be quiescent.
//! A persistent in-flight marker makes crash cleanup conservative: an uncertain execution leaks
//! a private file rather than deleting code that a surviving child might still need.

#[cfg(unix)]
#[path = "ssh_helpers/unix.rs"]
mod platform;
#[cfg(windows)]
#[path = "ssh_helpers/windows.rs"]
mod platform;
#[cfg(test)]
#[path = "ssh_helpers/tests.rs"]
mod tests;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use uuid::Uuid;

const FEATURE: &str = "termflow-ssh-helpers-v1";
const MANIFEST: &str = "manifest.json";
const IN_FLIGHT: &str = "in-flight";
const ROOT_LOCK: &str = "root.lock";

struct RootLock(std::fs::File);

impl Drop for RootLock {
    fn drop(&mut self) {
        let _ = fs4::FileExt::unlock(&self.0);
    }
}

fn lock_root(dir: &platform::Dir) -> io::Result<RootLock> {
    dir.verify_private()?;
    let file = dir.open_file(ROOT_LOCK)?;
    fs4::FileExt::lock(&file)?;
    Ok(RootLock(file))
}
const MAX_FILE: u64 = 1024 * 1024;

fn denied() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "untrusted SSH helper entry",
    )
}

fn component(name: &str) -> io::Result<()> {
    if name.is_empty()
        || name.len() > 128
        || name == "."
        || name == ".."
        || !name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
    {
        return Err(denied());
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub start_time: u64,
}

impl ProcessIdentity {
    pub fn capture(pid: u32) -> io::Result<Self> {
        let mut sys = sysinfo::System::new();
        sys.refresh_processes(
            sysinfo::ProcessesToUpdate::Some(&[sysinfo::Pid::from_u32(pid)]),
            true,
        );
        let process = sys
            .process(sysinfo::Pid::from_u32(pid))
            .ok_or_else(denied)?;
        let identity = Self {
            pid,
            start_time: process.start_time(),
        };
        identity.validate()?;
        Ok(identity)
    }

    fn validate(&self) -> io::Result<()> {
        if self.pid == 0 || self.start_time == 0 {
            return Err(denied());
        }
        Ok(())
    }

    pub(super) fn pid_quiescent(pid: u32) -> bool {
        pid != 0 && platform::process_absent(pid)
    }

    // Only positive OS evidence of absence permits deletion. A reused PID, access denial or
    // unavailable process metadata retains the entry, even if its start time differs.
    fn definitely_dead(&self) -> bool {
        platform::process_absent(self.pid)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum HelperKind {
    ShellHook,
    AttemptPayload,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    feature: String,
    entry: Uuid,
    process: ProcessIdentity,
    kind: HelperKind,
    file: String,
    sha256: String,
}

/// `app_data` must come from Tauri's per-user app-data resolver. All path components are
/// opened without following links and pinned for this root's lifetime. Existing unsafe
/// permissions are rejected, never silently repaired.
#[derive(Clone)]
pub struct HelperRoot {
    dir: Arc<platform::Dir>,
}

impl HelperRoot {
    pub fn for_app<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> io::Result<Self> {
        use tauri::Manager;
        let app_data = app.path().app_data_dir().map_err(io::Error::other)?;
        Self::open_app_data(&app_data)
    }

    pub fn open_app_data(app_data: &Path) -> io::Result<Self> {
        let parent = platform::Dir::open_tree(app_data)?;
        let dir = parent.child(FEATURE, true)?;
        dir.verify_private()?;
        match dir.publish_file(ROOT_LOCK, FEATURE.as_bytes()) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
        if dir.read_file(ROOT_LOCK)? != FEATURE.as_bytes() {
            return Err(denied());
        }
        Ok(Self { dir: Arc::new(dir) })
    }

    pub fn path(&self) -> &Path {
        self.dir.path()
    }

    pub fn publish(
        &self,
        process: ProcessIdentity,
        kind: HelperKind,
        extension: &str,
        content: &[u8],
    ) -> io::Result<Helper> {
        self.publish_id(Uuid::new_v4(), process, kind, extension, content)
    }

    fn publish_id(
        &self,
        entry: Uuid,
        process: ProcessIdentity,
        kind: HelperKind,
        extension: &str,
        content: &[u8],
    ) -> io::Result<Helper> {
        let _lock = lock_root(&self.dir)?;
        process.validate()?;
        let file = match extension {
            "ps1" | "cmd" | "sh" | "fish" | "json" => format!("helper.{extension}"),
            "txt" if kind == HelperKind::ShellHook => "helper.txt".into(),
            ".zshenv" | ".zprofile" | ".zshrc" | ".zlogin" if kind == HelperKind::ShellHook => extension.into(),
            _ => return Err(denied()),
        };
        if content.len() as u64 > MAX_FILE {
            return Err(denied());
        }
        let name = entry.to_string();
        // Exclusive directory reservation. A collision is an error, never reuse/rewrite.
        let dir = self.dir.create_child(&name)?;
        let manifest = Manifest {
            feature: FEATURE.into(),
            entry,
            process,
            kind,
            file: file.clone(),
            sha256: digest(content),
        };
        // Each file is exclusively staged, fsynced, and atomically published WITHOUT replace.
        // The manifest is the commit record; an incomplete publication is never executable.
        dir.publish_file(&file, content)?;
        dir.publish_file(MANIFEST, &serde_json::to_vec(&manifest)?)?;
        let helper = Helper {
            inner: Arc::new(Entry {
                root: self.dir.clone(),
                name,
                manifest,
                state: Mutex::new(Lifetime {
                    dir: Some(dir),
                    users: 0,
                    retired: false,
                }),
            }),
        };
        Ok(helper)
    }

    /// Sweep only committed, verified entries whose shell is positively dead and which have
    /// no persistent in-flight marker. Unknown files, malformed manifests, links, changed
    /// payloads and uncertain process/child liveness are left untouched. No recursive delete.
    pub fn sweep_abandoned(&self) -> io::Result<usize> {
        let _lock = lock_root(&self.dir)?;
        let mut removed = 0;
        for name in self.dir.names()? {
            let Ok(id) = Uuid::parse_str(&name) else {
                continue;
            };
            if id.to_string() != name {
                continue;
            }
            let Ok(dir) = self.dir.child(&name, false) else {
                continue;
            };
            let Ok(manifest) = verified_manifest(&dir, id) else {
                continue;
            };
            if !manifest.process.definitely_dead() || !quiescent_names(&dir, &manifest)? {
                continue;
            }
            remove_contents(&dir, &manifest)?;
            drop(dir);
            self.dir.remove_dir(&name)?;
            removed += 1;
        }
        Ok(removed)
    }
}

fn digest(content: &[u8]) -> String {
    format!("{:x}", Sha256::digest(content))
}

fn verified_manifest(dir: &platform::Dir, id: Uuid) -> io::Result<Manifest> {
    dir.verify_private()?;
    let manifest: Manifest = serde_json::from_slice(&dir.read_file(MANIFEST)?)?;
    manifest.process.validate()?;
    if manifest.feature != FEATURE || manifest.entry != id {
        return Err(denied());
    }
    component(&manifest.file)?;
    let valid_name = matches!(manifest.file.as_str(), "helper.ps1" | "helper.cmd" | "helper.sh" | "helper.fish" | "helper.json")
        || (manifest.kind == HelperKind::ShellHook
            && matches!(manifest.file.as_str(), "helper.txt" | ".zshenv" | ".zprofile" | ".zshrc" | ".zlogin"));
    if !valid_name || digest(&dir.read_file(&manifest.file)?) != manifest.sha256
    {
        return Err(denied());
    }
    Ok(manifest)
}

fn quiescent_names(dir: &platform::Dir, manifest: &Manifest) -> io::Result<bool> {
    let mut names = dir.names()?;
    names.sort();
    let mut expected = vec![MANIFEST.to_string(), manifest.file.clone()];
    expected.sort();
    Ok(names == expected)
}

fn remove_contents(dir: &platform::Dir, manifest: &Manifest) -> io::Result<()> {
    // Revalidate before unlink. Never follow a link, traverse another directory or delete
    // unknown files, even if someone manually placed them inside a feature-owned entry.
    verified_manifest(dir, manifest.entry)?;
    if !quiescent_names(dir, manifest)? {
        return Err(denied());
    }
    dir.remove_file(&manifest.file)?;
    dir.remove_file(MANIFEST)
}

struct Lifetime {
    dir: Option<platform::Dir>,
    users: usize,
    retired: bool,
}

struct Entry {
    root: Arc<platform::Dir>,
    name: String,
    manifest: Manifest,
    state: Mutex<Lifetime>,
}

/// Cloning a handle never rewrites a file. Reconnect publishes a new entry, not this one.
#[derive(Clone)]
pub struct Helper {
    inner: Arc<Entry>,
}

impl Helper {
    pub fn path(&self) -> PathBuf {
        self.inner
            .root
            .path()
            .join(&self.inner.name)
            .join(&self.inner.manifest.file)
    }

    pub fn verify(&self) -> io::Result<()> {
        let _lock = lock_root(&self.inner.root)?;
        let state = self.inner.state.lock();
        verified_manifest(
            state.dir.as_ref().ok_or_else(denied)?,
            self.inner.manifest.entry,
        )?;
        Ok(())
    }

    /// Acquire before submitting a path. Keep until the shell/child has consumed and finished
    /// with the payload, NOT merely until stdin queue acceptance. Explicitly finish after
    /// quiescence; cancellation/panic/drop without finish retains the persistent marker.
    pub fn acquire(&self) -> io::Result<HelperUse> {
        let _lock = lock_root(&self.inner.root)?;
        let mut state = self.inner.state.lock();
        if state.retired {
            return Err(denied());
        }
        let dir = state.dir.as_ref().ok_or_else(denied)?;
        verified_manifest(dir, self.inner.manifest.entry)?;
        if state.users == 0 {
            dir.publish_file(IN_FLIGHT, b"execution not yet known quiescent\n")?;
        }
        state.users += 1;
        Ok(HelperUse {
            helper: self.clone(),
        })
    }

    /// Cancellation retires only attempt payloads. Shell-lifetime hooks survive Cancel and
    /// Reconnect. In-use payloads are removed only when their final execution lease ends.
    pub fn cancel_attempt(&self) -> io::Result<bool> {
        if self.inner.manifest.kind != HelperKind::AttemptPayload {
            return Ok(false);
        }
        self.retire()
    }

    /// Hooks can retire only after positive evidence that their shell process ended.
    pub fn retire_after_process_end(&self) -> io::Result<bool> {
        if !self.inner.manifest.process.definitely_dead() {
            return Ok(false);
        }
        self.retire()
    }

    /// Pre-spawn hooks have a supervisor in the manifest because the child does not
    /// yet have a PID. Its holder must prove the shell never started or has exited.
    pub(crate) fn retire_quiescent_shell_hook(&self) -> io::Result<bool> {
        if self.inner.manifest.kind != HelperKind::ShellHook {
            return Err(denied());
        }
        self.retire()
    }

    fn retire(&self) -> io::Result<bool> {
        let _lock = lock_root(&self.inner.root)?;
        let mut state = self.inner.state.lock();
        state.retired = true;
        self.inner.clean_if_quiescent(&mut state)
    }
}

impl Entry {
    fn clean_if_quiescent(&self, state: &mut Lifetime) -> io::Result<bool> {
        if !state.retired || state.users != 0 {
            return Ok(false);
        }
        let Some(dir) = state.dir.as_ref() else {
            return Ok(true);
        };
        remove_contents(dir, &self.manifest)?;
        // Windows directories are pinned against replacement/deletion while open.
        drop(state.dir.take());
        self.root.remove_dir(&self.name)?;
        Ok(true)
    }
}

/// Dropping an execution lease is NOT proof that its child stopped. Only explicit `finish`
/// asserts quiescence. Cancellation, unwinding or crash leaves a persistent marker and keeps
/// the payload (conservative retention, including a child that outlives its shell).
pub struct HelperUse {
    helper: Helper,
}

impl HelperUse {
    pub fn path(&self) -> PathBuf {
        self.helper.path()
    }

    /// Call only after positive evidence that this execution has finished using the file.
    /// Queue acceptance, a cancelled future, or a shell exit with unknown child status is
    /// insufficient. Returns true only if a retired helper was actually removed.
    pub fn finish(self) -> io::Result<bool> {
        let _lock = lock_root(&self.helper.inner.root)?;
        let mut state = self.helper.inner.state.lock();
        state.users -= 1;
        if state.users == 0 {
            state
                .dir
                .as_ref()
                .ok_or_else(denied)?
                .remove_file(IN_FLIGHT)?;
        }
        self.helper.inner.clean_if_quiescent(&mut state)
    }
}
