//! Persistent window registry — the list of OS windows to recreate at startup.
//!
//! Why this exists at all: session state (tabs, pane trees) lives in the
//! renderer's `localStorage`, which Rust cannot read, and which does not exist
//! until a webview has been created. Something has to know *how many windows to
//! create* before any webview exists, and that something has to be here.
//!
//! See plan 018. The division of labour is:
//!   * Rust (this module) owns the window LIST and geometry.
//!   * The renderer owns each window's tab/pane payload, keyed by the
//!     `windowId` recorded here.
//!
//! The file is profile-scoped through `app_config::dev_file`, like every other
//! mutable artifact, so `--profile work` never sees the default profile's
//! windows.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Bump only for a BREAKING shape change. An unknown version loads as empty
/// (see `load`), so an older build downgrading onto a newer file opens one
/// default window instead of misreading records.
pub const VERSION: u32 = 1;

/// The id of the window that owns the pre-existing, unsuffixed storage keys.
///
/// Slot 0 keeps today's key names so a single-window user's saved session loads
/// byte-identically after this feature ships — the same backward-compatibility
/// trick the profile scoping used for the default profile.
pub const SLOT_ZERO_ID: &str = "w0";

/// The label Tauri assigns the window declared in `tauri.conf.json`.
pub const MAIN_LABEL: &str = "main";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowRecord {
    /// Stable across restarts. The renderer keys its `localStorage` on this.
    pub id: String,
    /// The Tauri window label. Re-used when the window is recreated, so
    /// label-derived behaviour (e.g. the `detach-` prefix) stays consistent.
    /// NOT an identity: labels are minted per launch for windows this process
    /// creates, which is exactly why `id` exists separately.
    pub label: String,
    /// Outer position in physical pixels. Signed: a window on a monitor to the
    /// left of the primary has a negative `x`.
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub maximized: bool,
    /// Which window had focus at quit, so it is focused again on restore.
    #[serde(default)]
    pub focused: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Registry {
    pub version: u32,
    pub windows: Vec<WindowRecord>,
}

impl Default for Registry {
    fn default() -> Self {
        Self { version: VERSION, windows: Vec::new() }
    }
}

impl Registry {
    /// Replace the record with the same `id`, preserving its position in the
    /// list; append if it is new. Order is the restore order, so slot 0 must
    /// stay slot 0 across an update of its geometry.
    pub fn upsert(&mut self, record: WindowRecord) {
        match self.windows.iter_mut().find(|w| w.id == record.id) {
            Some(existing) => *existing = record,
            None => self.windows.push(record),
        }
    }

    pub fn remove(&mut self, id: &str) {
        self.windows.retain(|w| w.id != id);
    }

    pub fn find_by_label(&self, label: &str) -> Option<&WindowRecord> {
        self.windows.iter().find(|w| w.label == label)
    }

    /// Exactly one window may be focused. Callers set focus through this rather
    /// than mutating the flag, so a restore can never open two "focused"
    /// windows and leave the winner to the OS.
    pub fn set_focused(&mut self, id: &str) {
        for w in self.windows.iter_mut() {
            w.focused = w.id == id;
        }
    }
}

/// `~/.auto-terminal/window-registry[.dev][.profile].json`.
///
/// Mirrors the home-dir resolution every other artifact in this app uses
/// (`pty_manager::get_profiles_path`, `layout_manager`, `recording_service`).
pub fn registry_path() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    Path::new(&home)
        .join(".auto-terminal")
        .join(crate::app_config::dev_file("window-registry.json"))
}

/// Read the registry, or an EMPTY one for every failure mode.
///
/// A missing file is the first run. A corrupt or future-versioned file is a
/// hand-edited or downgraded install. None of these may block startup: the cost
/// of an empty registry is "you get one window", the cost of an error path is
/// "the app does not start".
pub fn load(path: &Path) -> Registry {
    let Ok(contents) = std::fs::read_to_string(path) else {
        return Registry::default();
    };
    match serde_json::from_str::<Registry>(&contents) {
        Ok(reg) if reg.version == VERSION => reg,
        Ok(reg) => {
            log::warn!(
                "window registry version {} is not {VERSION}; ignoring it and opening one window",
                reg.version
            );
            Registry::default()
        }
        Err(e) => {
            log::warn!("window registry at {} is unreadable ({e}); ignoring it", path.display());
            Registry::default()
        }
    }
}

pub fn save(path: &Path, registry: &Registry) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(registry).map_err(|e| e.to_string())?;
    crate::app_config::write_atomic(path, &json)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(id: &str, label: &str) -> WindowRecord {
        WindowRecord {
            id: id.to_string(),
            label: label.to_string(),
            x: 100,
            y: 200,
            width: 1280,
            height: 800,
            maximized: false,
            focused: false,
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tf-winreg-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_missing_file_loads_as_empty_not_an_error() {
        let path = temp_dir("missing").join("window-registry.json");
        let reg = load(&path);
        assert_eq!(reg.version, VERSION);
        assert!(reg.windows.is_empty());
    }

    #[test]
    fn corrupt_json_loads_as_empty_and_does_not_panic() {
        let dir = temp_dir("corrupt");
        let path = dir.join("window-registry.json");
        std::fs::write(&path, "{ this is not json ").unwrap();
        assert!(load(&path).windows.is_empty());
    }

    #[test]
    fn an_unknown_future_version_loads_as_empty() {
        let dir = temp_dir("version");
        let path = dir.join("window-registry.json");
        std::fs::write(
            &path,
            r#"{"version":99,"windows":[{"id":"w0","label":"main","x":0,"y":0,"width":1,"height":1}]}"#,
        )
        .unwrap();
        let reg = load(&path);
        assert!(
            reg.windows.is_empty(),
            "a future version must not be half-parsed into records this build cannot honour"
        );
    }

    #[test]
    fn save_then_load_round_trips_every_field() {
        let dir = temp_dir("roundtrip");
        let path = dir.join("window-registry.json");
        let mut reg = Registry::default();
        reg.windows.push(WindowRecord {
            id: "w0".into(),
            label: "main".into(),
            // A monitor to the LEFT of the primary gives negative coordinates.
            // Serialising these as unsigned would silently teleport the window.
            x: -1920,
            y: -37,
            width: 1600,
            height: 900,
            maximized: true,
            focused: true,
        });
        save(&path, &reg).unwrap();

        let loaded = load(&path);
        assert_eq!(loaded, reg);
        assert_eq!(loaded.windows[0].x, -1920);
        assert_eq!(loaded.windows[0].y, -37);
        assert!(loaded.windows[0].maximized);
        assert!(loaded.windows[0].focused);
    }

    #[test]
    fn upsert_replaces_by_id_and_preserves_order() {
        let mut reg = Registry::default();
        reg.upsert(rec("w0", "main"));
        reg.upsert(rec("w1", "window-a"));
        reg.upsert(rec("w2", "window-b"));

        let mut moved = rec("w1", "window-a");
        moved.x = 4242;
        reg.upsert(moved);

        assert_eq!(reg.windows.len(), 3, "upsert of an existing id must not append");
        assert_eq!(
            reg.windows.iter().map(|w| w.id.as_str()).collect::<Vec<_>>(),
            vec!["w0", "w1", "w2"],
            "restore order is the list order; an update must not reshuffle it"
        );
        assert_eq!(reg.windows[1].x, 4242);
    }

    #[test]
    fn remove_drops_only_the_named_window() {
        let mut reg = Registry::default();
        reg.upsert(rec("w0", "main"));
        reg.upsert(rec("w1", "window-a"));
        reg.remove("w0");
        assert_eq!(reg.windows.len(), 1);
        assert_eq!(reg.windows[0].id, "w1");
        // Removing an id that was never there is a no-op, not a panic: the
        // Destroyed handler fires for windows we never registered (drag-preview).
        reg.remove("nope");
        assert_eq!(reg.windows.len(), 1);
    }

    #[test]
    fn set_focused_leaves_exactly_one_focused_window() {
        let mut reg = Registry::default();
        reg.upsert(rec("w0", "main"));
        reg.upsert(rec("w1", "window-a"));
        reg.upsert(rec("w2", "window-b"));
        reg.set_focused("w1");
        reg.set_focused("w2");
        assert_eq!(
            reg.windows.iter().filter(|w| w.focused).count(),
            1,
            "focus is exclusive; two focused records would race on restore"
        );
        assert!(reg.find_by_label("window-b").unwrap().focused);
    }

    #[test]
    fn find_by_label_resolves_the_id_the_renderer_will_key_on() {
        let mut reg = Registry::default();
        reg.upsert(rec("w0", "main"));
        reg.upsert(rec("w7", "detach-abc"));
        assert_eq!(reg.find_by_label("detach-abc").unwrap().id, "w7");
        assert!(reg.find_by_label("window-nope").is_none());
    }

    #[test]
    fn the_registry_path_is_profile_scoped() {
        // The exact filename depends on dev/release and the active profile; the
        // invariant under test is that it goes through the ONE choke point that
        // adds both dimensions, not that it equals a hardcoded string.
        let path = registry_path();
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        assert_eq!(name, crate::app_config::dev_file("window-registry.json"));
        assert!(path.to_string_lossy().contains(".auto-terminal"));
    }
}
