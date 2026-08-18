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

use dashmap::DashMap;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

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

/// A monitor's work area in the same physical-pixel space as `WindowRecord`.
#[derive(Debug, Clone, Copy)]
pub struct MonitorRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// How much of a restored window must remain visible on some monitor for the
/// user to be able to grab it. Roughly a title bar's worth.
pub const MIN_VISIBLE_PX: i32 = 80;

/// Can the user actually reach this window where it was last seen?
///
/// Monitors get unplugged and resolutions change between sessions. Restoring a
/// window onto coordinates that no longer exist puts it somewhere the user
/// cannot click, drag or close — worse than ignoring the saved position.
pub fn is_reachable(record: &WindowRecord, monitors: &[MonitorRect]) -> bool {
    // No monitors reported: we cannot prove it is unreachable, and refusing to
    // place every window would be a worse failure than trusting the record.
    if monitors.is_empty() {
        return true;
    }
    let (wx0, wy0) = (record.x, record.y);
    let wx1 = record.x + record.width as i32;
    let wy1 = record.y + record.height as i32;
    monitors.iter().any(|m| {
        let overlap_w = wx1.min(m.x + m.width as i32) - wx0.max(m.x);
        let overlap_h = wy1.min(m.y + m.height as i32) - wy0.max(m.y);
        overlap_w >= MIN_VISIBLE_PX && overlap_h >= MIN_VISIBLE_PX
    })
}

/// Minimum gap between geometry writes. Dragging a window emits a `Moved` event
/// per frame; without this the registry file would be rewritten ~60×/second for
/// the whole duration of the drag.
pub const GEOMETRY_DEBOUNCE: Duration = Duration::from_millis(500);

/// Is a debounced write due? Pure so the policy is testable without a clock.
///
/// `since` is the time elapsed since the last write, or `None` if nothing has
/// been written yet — which must always write, otherwise the FIRST geometry
/// change of a session is held indefinitely.
pub fn debounce_due(dirty: bool, since: Option<Duration>) -> bool {
    dirty && since.is_none_or(|d| d >= GEOMETRY_DEBOUNCE)
}

/// Live window bookkeeping: the registry, the `label → windowId` map the
/// renderer resolves through, and the geometry write debounce.
///
/// One struct rather than three `AppState` fields, so the invariant "the map and
/// the registry agree" has a single owner.
pub struct WindowTracker {
    path: PathBuf,
    registry: Mutex<Registry>,
    /// Tauri label → stable windowId. Rebuilt every launch; the registry is the
    /// durable half.
    ids: DashMap<String, String>,
    dirty: AtomicBool,
    last_write: Mutex<Option<Instant>>,
}

impl WindowTracker {
    pub fn new(path: PathBuf, registry: Registry) -> Self {
        Self {
            path,
            registry: Mutex::new(registry),
            ids: DashMap::new(),
            dirty: AtomicBool::new(false),
            last_write: Mutex::new(None),
        }
    }

    /// Load from the profile-scoped path.
    pub fn load_default() -> Self {
        let path = registry_path();
        let registry = load(&path);
        Self::new(path, registry)
    }

    pub fn snapshot(&self) -> Registry {
        self.registry.lock().clone()
    }

    /// Bind a live window's label to its stable id. Called for every window,
    /// whether recreated at boot or opened during the session.
    pub fn bind(&self, label: &str, id: &str) {
        self.ids.insert(label.to_string(), id.to_string());
    }

    /// The stable id for a live window, or `None` if the label was never bound.
    ///
    /// Deliberately NOT falling back to slot 0: a window that silently shared
    /// slot 0's id would share its storage key, which is the entire bug this
    /// module exists to fix. Callers must surface the miss.
    pub fn id_for_label(&self, label: &str) -> Option<String> {
        self.ids.get(label).map(|v| v.clone())
    }

    /// Register a window and persist immediately — a new window must survive a
    /// crash before its first geometry tick.
    pub fn register(&self, record: WindowRecord) {
        self.bind(&record.label, &record.id);
        self.registry.lock().upsert(record);
        self.persist_now();
    }

    /// Drop a record by id, for a window that never came to exist.
    ///
    /// `forget` cannot do this: it resolves through the `label → id` map, which
    /// only holds windows that were successfully built. A record left behind
    /// would be retried on every single start.
    pub fn drop_record(&self, id: &str) {
        self.registry.lock().remove(id);
        self.persist_now();
    }

    /// Drop a window. Persisted immediately: a closed window must not come back.
    pub fn forget(&self, label: &str) {
        let Some((_, id)) = self.ids.remove(label) else {
            // Never registered (e.g. `drag-preview`) — nothing to forget.
            return;
        };
        self.registry.lock().remove(&id);
        self.persist_now();
    }

    /// Record a geometry change. In-memory always; the disk write is debounced.
    pub fn note_geometry(&self, label: &str, x: i32, y: i32, width: u32, height: u32, maximized: bool) {
        let Some(id) = self.id_for_label(label) else { return };
        {
            let mut reg = self.registry.lock();
            let Some(rec) = reg.windows.iter_mut().find(|w| w.id == id) else { return };
            // A maximized window reports the maximized rect; keeping the
            // restored rect would make un-maximizing snap to fullscreen size.
            if !maximized {
                rec.x = x;
                rec.y = y;
                rec.width = width;
                rec.height = height;
            }
            rec.maximized = maximized;
        }
        self.dirty.store(true, Ordering::Relaxed);
    }

    pub fn note_focus(&self, label: &str) {
        let Some(id) = self.id_for_label(label) else { return };
        self.registry.lock().set_focused(&id);
        self.dirty.store(true, Ordering::Relaxed);
    }

    /// Write iff dirty and the debounce has elapsed. Call from a periodic tick.
    pub fn persist_if_due(&self) {
        let since = self.last_write.lock().map(|t| t.elapsed());
        if !debounce_due(self.dirty.load(Ordering::Relaxed), since) {
            return;
        }
        self.persist_now();
    }

    /// Write unconditionally. Used on register/forget and before exit, where a
    /// debounce would mean losing the very change we care about.
    pub fn persist_now(&self) {
        let registry = self.registry.lock().clone();
        if let Err(e) = save(&self.path, &registry) {
            log::warn!("failed to persist the window registry: {e}");
            return;
        }
        self.dirty.store(false, Ordering::Relaxed);
        *self.last_write.lock() = Some(Instant::now());
    }
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

    // --- WindowTracker ---

    fn tracker(name: &str) -> WindowTracker {
        let path = temp_dir(name).join("window-registry.json");
        WindowTracker::new(path, Registry::default())
    }

    #[test]
    fn an_unbound_label_resolves_to_none_never_to_slot_zero() {
        let t = tracker("unbound");
        t.register(rec("w0", "main"));
        assert_eq!(t.id_for_label("main").as_deref(), Some("w0"));
        // The whole defect being fixed is windows silently sharing one key.
        // A miss must be a miss, so the caller can surface it.
        assert_eq!(t.id_for_label("window-unknown"), None);
    }

    #[test]
    fn bind_resolves_an_id_before_any_record_exists() {
        // Load-bearing ordering: a window's webview resolves its session id as
        // its FIRST action, before the caller can read geometry off the built
        // window. If the id were only available after `register`, the losing
        // side of that race falls back to slot 0 and silently merges the new
        // window into the main window's session.
        let t = tracker("bind-first");
        t.bind("window-a", "w1");
        assert_eq!(t.id_for_label("window-a").as_deref(), Some("w1"));
        assert!(t.snapshot().windows.is_empty(), "no record yet — only the binding");

        // …and the later register must not mint a second id for that label.
        t.register(rec("w1", "window-a"));
        assert_eq!(t.id_for_label("window-a").as_deref(), Some("w1"));
        assert_eq!(t.snapshot().windows.len(), 1);
    }

    #[test]
    fn register_persists_immediately_so_a_new_window_survives_a_crash() {
        let t = tracker("register");
        t.register(rec("w1", "window-a"));
        assert_eq!(load(&t.path).windows.len(), 1);
    }

    #[test]
    fn forget_removes_the_record_and_the_binding_and_persists() {
        let t = tracker("forget");
        t.register(rec("w0", "main"));
        t.register(rec("w1", "window-a"));
        t.forget("main");
        assert_eq!(t.id_for_label("main"), None);
        let on_disk = load(&t.path);
        assert_eq!(on_disk.windows.len(), 1);
        assert_eq!(on_disk.windows[0].id, "w1");
    }

    #[test]
    fn drop_record_removes_a_window_that_was_never_built() {
        // The restore loop loads N records, then fails to build one. `forget`
        // is useless there (nothing was ever bound to a label), so without
        // drop_record the dead record is retried on every single start.
        let t = WindowTracker::new(
            temp_dir("drop-record").join("window-registry.json"),
            Registry { version: VERSION, windows: vec![rec("w0", "main"), rec("w1", "window-a")] },
        );
        assert_eq!(t.forget("window-a"), (), "no binding exists yet");
        assert_eq!(t.snapshot().windows.len(), 2, "forget cannot reach an unbuilt record");

        t.drop_record("w1");
        assert_eq!(t.snapshot().windows.len(), 1);
        assert_eq!(load(&t.path).windows.len(), 1, "and it is persisted");
    }

    #[test]
    fn forgetting_an_unregistered_label_is_a_noop() {
        let t = tracker("forget-unreg");
        t.register(rec("w0", "main"));
        // `Destroyed` fires for windows we never register, notably drag-preview.
        t.forget("drag-preview");
        assert_eq!(t.snapshot().windows.len(), 1);
    }

    #[test]
    fn geometry_updates_memory_but_defers_the_write() {
        let t = tracker("geometry");
        t.register(rec("w0", "main"));
        t.note_geometry("main", 11, 22, 640, 480, false);

        assert_eq!(t.snapshot().windows[0].x, 11, "memory updates immediately");
        // register() wrote once; the debounce must swallow this follow-up.
        t.persist_if_due();
        assert_eq!(
            load(&t.path).windows[0].x,
            100,
            "a geometry tick inside the debounce window must not hit the disk"
        );
        t.persist_now();
        assert_eq!(load(&t.path).windows[0].x, 11, "a forced write always lands");
    }

    #[test]
    fn a_maximized_window_keeps_its_restored_rect() {
        let t = tracker("maximized");
        t.register(rec("w0", "main"));
        t.note_geometry("main", 0, 0, 3840, 2160, true);
        let snap = t.snapshot();
        assert!(snap.windows[0].maximized);
        assert_eq!(
            (snap.windows[0].width, snap.windows[0].x),
            (1280, 100),
            "storing the maximized rect would make un-maximizing snap to fullscreen size"
        );
    }

    #[test]
    fn geometry_for_an_unbound_label_is_ignored() {
        let t = tracker("geometry-unbound");
        t.register(rec("w0", "main"));
        t.note_geometry("drag-preview", 1, 2, 3, 4, false);
        assert_eq!(t.snapshot().windows.len(), 1);
        assert_eq!(t.snapshot().windows[0].x, 100);
    }

    #[test]
    fn note_focus_is_exclusive_across_windows() {
        let t = tracker("focus");
        t.register(rec("w0", "main"));
        t.register(rec("w1", "window-a"));
        t.note_focus("main");
        t.note_focus("window-a");
        let snap = t.snapshot();
        assert_eq!(snap.windows.iter().filter(|w| w.focused).count(), 1);
        assert!(snap.find_by_label("window-a").unwrap().focused);
    }

    #[test]
    fn the_debounce_policy_always_allows_the_first_write() {
        // `None` = nothing written yet. Holding the first change would defer it
        // forever, since nothing else moves the clock forward.
        assert!(debounce_due(true, None));
        assert!(!debounce_due(false, None), "a clean registry is never written");
        assert!(!debounce_due(true, Some(Duration::from_millis(10))));
        assert!(debounce_due(true, Some(GEOMETRY_DEBOUNCE)));
        assert!(debounce_due(true, Some(Duration::from_secs(5))));
    }

    #[test]
    fn a_drag_burst_coalesces_into_a_single_write() {
        let t = tracker("burst");
        t.register(rec("w0", "main"));
        for i in 0..60 {
            t.note_geometry("main", i, i, 640, 480, false);
            t.persist_if_due();
        }
        assert_eq!(
            load(&t.path).windows[0].x,
            100,
            "60 move events inside one debounce window must produce zero extra writes"
        );
        assert_eq!(t.snapshot().windows[0].x, 59, "…while memory tracks the latest position");
    }

    // --- reachability ---

    fn mon(x: i32, y: i32, w: u32, h: u32) -> MonitorRect {
        MonitorRect { x, y, width: w, height: h }
    }

    fn at(x: i32, y: i32) -> WindowRecord {
        let mut r = rec("w0", "main");
        r.x = x;
        r.y = y;
        r.width = 1280;
        r.height = 800;
        r
    }

    #[test]
    fn a_window_on_the_primary_monitor_is_reachable() {
        assert!(is_reachable(&at(100, 100), &[mon(0, 0, 1920, 1080)]));
    }

    #[test]
    fn a_window_on_an_unplugged_second_monitor_is_not_reachable() {
        // Saved on a monitor to the right that is now gone.
        assert!(!is_reachable(&at(2400, 200), &[mon(0, 0, 1920, 1080)]));
    }

    #[test]
    fn a_window_on_a_monitor_left_of_the_primary_is_reachable() {
        // Negative coordinates are legitimate, not corruption.
        assert!(is_reachable(&at(-1800, 40), &[mon(0, 0, 1920, 1080), mon(-1920, 0, 1920, 1080)]));
    }

    #[test]
    fn a_barely_overlapping_window_is_not_reachable() {
        // 20px of the window pokes onto the monitor — not enough to grab.
        assert!(!is_reachable(&at(1900, 100), &[mon(0, 0, 1920, 1080)]));
        // Exactly the threshold is reachable.
        assert!(is_reachable(&at(1920 - MIN_VISIBLE_PX, 100), &[mon(0, 0, 1920, 1080)]));
    }

    #[test]
    fn with_no_monitors_reported_every_window_is_trusted() {
        // Failing to enumerate monitors must not relocate every window.
        assert!(is_reachable(&at(9999, 9999), &[]));
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
