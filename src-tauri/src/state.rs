use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::path::PathBuf;
use tokio::sync::broadcast;
use parking_lot::RwLock;
use crate::event_bus::{EventBus, ActivityTracker};
use crate::recording_service::RecordingService;
use crate::search_service::SearchService;
use crate::layout_manager::LayoutManager;
use crate::tmux_manager::{TmuxConfig, TmuxSession, TerminalBackend};
use tauri::{AppHandle, Runtime, Wry};

/// Divider written between a restored terminal's previous-session scrollback and
/// its fresh shell. Dim styling; trailing blank lines push it up into scrollback so
/// the screen snapshot that follows it doesn't paint over it.
pub const REPLAY_SEPARATOR: &str = "\r\n\x1b[2m──── session restored ──── \x1b[0m\r\n\r\n";

/// The boot window's label (Tauri's default when `tauri.conf.json` defines no
/// explicit `label`). Also the fallback target for API/MCP terminal routing.
pub const DEFAULT_ACTIVE_WINDOW: &str = "main";

/// Scrollback lines kept by each terminal's authoritative vt100 parser, so the full
/// session history (not just the visible screen) can be persisted and restored.
/// 2J-cleared frames never enter scrollback, so this stays TUI-safe.
pub const SCROLLBACK_LINES: usize = 5000;

#[derive(Clone, Serialize, Deserialize)]
pub struct Terminal {
    pub id: String,
    pub pid: u32,
    pub shell: String,
    pub name: String,
    pub created_at: String,
    #[serde(default = "default_terminal_cols")]
    pub cols: u16,
    #[serde(default = "default_terminal_rows")]
    pub rows: u16,
    #[serde(default)]
    pub backend: TerminalBackend,
    pub tab_id: Option<String>,
    /// Source of the most recent PTY write: "user" (Tauri invoke = keystrokes/
    /// paste) or "api" (REST/MCP input/execute). Drives the per-agent color-scheme
    /// revert-vs-sticky decision (see docs/plan/007-agent-color-schemes-plan.md).
    #[serde(default)]
    pub last_input_source: Option<String>,
    /// Epoch ms of the most recent PTY write.
    #[serde(default)]
    pub last_input_at: Option<i64>,
}

fn default_terminal_cols() -> u16 {
    80
}

fn default_terminal_rows() -> u16 {
    24
}

#[derive(Clone, Debug)]
pub struct ChannelPayload {
    pub id: String,
    pub data: Vec<u8>,
}

#[derive(Debug)]
pub enum McpProcessHandle {
    Legacy(std::process::Child),
    Sidecar(tauri_plugin_shell::process::CommandChild),
}

use std::sync::Mutex;
use std::collections::VecDeque;

/// An in-flight cross-window pane drag. The source window registers it; the
/// window the user releases over claims it (and the source removes its pane).
#[derive(Clone)]
pub struct GlobalDrag {
    pub token: String,
    pub source_label: String,
}

// Generic over the Tauri runtime `R` (defaults to `Wry`, the production runtime)
// so tests can construct an `AppState<MockRuntime>` via `tauri::test::mock_app()`
// and drive handlers that need a live `AppHandle` (e.g. the shell-writer
// concurrency regression test). Every non-test reference to `AppState` resolves
// to `AppState<Wry>` through the default type parameter.
//
// `Clone` is hand-written (below) rather than derived: `#[derive(Clone)]` would
// add a spurious `R: Clone` bound, but the runtime marker `Wry` is not `Clone`
// (only `AppHandle<R>` is, for any `R: Runtime`). Every field is an `Arc`/`String`/
// `PathBuf`/`AppHandle<R>`, all cheaply cloneable independent of `R: Clone`.
pub struct AppState<R: Runtime = Wry> {
    // Folder passed to the first GUI instance. The boot window already exists, so
    // the renderer consumes this once instead of the backend creating a second one.
    // Arc-shared like every sibling field so `Clone` shares (not snapshots) it — the
    // managed state and all task clones see the same value.
    pub pending_open_path: Arc<std::sync::Mutex<Option<String>>>,
    pub terminals: Arc<DashMap<String, Terminal>>,
    // Values are Arc'd so PTY write paths clone the Arc and DROP the DashMap
    // shard guard before locking the inner Mutex. Holding a shard guard across
    // the send/probe `.await` sleeps (up to ~48 s) blocked any insert/remove on
    // the same shard — i.e. creating or closing a colliding terminal stalled for
    // the full sleep. Mirrors the `terminal_history` Arc pattern below.
    pub shell_writer_channels: Arc<DashMap<String, Arc<Mutex<Box<dyn std::io::Write + Send>>>>>,
    pub ptys: Arc<DashMap<String, Mutex<Box<dyn portable_pty::MasterPty + Send>>>>,
    // Broadcast channel for PTY output
    pub output_tx: broadcast::Sender<ChannelPayload>,
    // Terminal output history buffer (raw chunks; used by the text/scrollback API).
    // Values are Arc'd so readers clone the Arc and DROP the DashMap shard guard
    // before locking the inner Mutex — holding a shard guard across the inner
    // lock is what let slow API readers starve the single PTY output consumer
    // (and with it every terminal's output delivery).
    pub terminal_history: Arc<DashMap<String, Arc<Mutex<VecDeque<String>>>>>,
    // --- Output pipeline health (auto-heal) ---
    // Chunks sent by PTY reader threads into output_tx (producer side).
    pub output_produced: Arc<AtomicU64>,
    // Loop iterations of the PTY output consumer (consumer heartbeat).
    pub output_consumed: Arc<AtomicU64>,
    // Generation of the current consumer task; bumped by the watchdog when it
    // respawns a stalled consumer so a superseded (un-wedged) task exits instead
    // of double-processing.
    pub consumer_generation: Arc<AtomicU64>,
    // Debounce stamp (ms since epoch) for repaint_all_terminals_debounced.
    pub last_repaint_ms: Arc<AtomicU64>,
    // Authoritative live screen per terminal: a vt100 parser fed every PTY chunk.
    // This is the single source of truth for the *visible* screen and is used to
    // produce faithful, styled snapshots when the WebView reconnects (hydration).
    pub terminal_screens: Arc<DashMap<String, Mutex<vt100::Parser>>>,
    // Focus-event-reporting (DECSET/DECRST 1004) per terminal. vt100 ignores mode
    // 1004, but a rehydrating client needs it: it is the only mode some agent CLIs
    // (claude, codex) set, and the renderer's command-suggest suppression keys off it.
    pub terminal_focus_reporting: Arc<DashMap<String, FocusReportingTracker>>,
    // Event system
    pub event_bus: Arc<EventBus>,
    pub activity_tracker: Arc<ActivityTracker>,
    pub recording_service: Arc<RecordingService>,
    pub search_service: Arc<SearchService>,
    pub layout_manager: Arc<LayoutManager>,
    // Directory for test capture files
    pub test_capture_dir: PathBuf,
    // Test capture state - atomic bool for thread-safe enable/disable (wrapped in Arc for Clone)
    pub test_capture_enabled: Arc<AtomicBool>,
    // Test capture ID - RwLock since it's read frequently but written rarely (wrapped in Arc for Clone)
    pub test_capture_id: Arc<RwLock<Option<String>>>,
    // tmux configuration and availability
    pub tmux_config: Arc<RwLock<TmuxConfig>>,
    // Active tmux sessions (terminal ID -> session)
    pub tmux_sessions: Arc<DashMap<String, Mutex<TmuxSession>>>,
    // MCP Server process handle for graceful shutdown
    pub mcp_process: Arc<Mutex<Option<McpProcessHandle>>>,
    // termflow-fabric peering sidecar handle for graceful shutdown. `None` when
    // the fabric binary is absent (open-core builds run fine without it).
    pub fabric_process: Arc<Mutex<Option<tauri_plugin_shell::process::CommandChild>>>,
    // Monotonic spawn generation for the fabric child. Each spawn bumps it; a child's drain
    // task captures its generation and only clears `fabric_process` on Terminated if it is
    // STILL the current one — so a respawn's old child dying can't null the new child's
    // handle (re-review: fabric respawn stale-child race).
    pub fabric_generation: Arc<AtomicU64>,
    // Loopback control port the fabric exposes its command/SSE API on. Dev/prod
    // isolated (see app_config::default_fabric_control_port), same as api/mcp ports.
    pub fabric_control_port: u16,
    // When true, closing the last window hides to the tray instead of exiting, so
    // peering keeps running in the background (wired by the tray/background task).
    pub keep_running_in_background: Arc<AtomicBool>,
    // Current resolved network settings (ports, expose flag, access token).
    pub network: Arc<RwLock<crate::app_config::NetworkConfig>>,
    // Shutdown trigger for the running Axum API server (for hot restart).
    pub api_shutdown: Arc<Mutex<Option<tokio::sync::oneshot::Sender<()>>>>,
    // Serializes network mutations (set_network_config / rotate_auth_token) so
    // two concurrent restarts can't race the single shutdown slot and orphan a
    // server or double-bind a port.
    pub network_op_lock: Arc<tokio::sync::Mutex<()>>,
    // JWT secret for API authentication
    pub jwt_secret: String,
    // Tauri AppHandle for emitting events
    pub app_handle: AppHandle<R>,
    // Single-use payloads handed off when detaching a tab/pane into a new window
    // (or dropping a pane onto another window). Keyed by a token passed via URL.
    pub detach_payloads: Arc<DashMap<String, serde_json::Value>>,
    // The in-flight cross-window pane drag, if any (Phase 4 target-claims broker).
    pub active_global_drag: Arc<Mutex<Option<GlobalDrag>>>,
    // Each window's display title (the active tab's title), keyed by window label.
    // The renderer reports this; the Window menu is built from it (race-free, vs.
    // reading back the freshly-set native title which may not have committed yet).
    pub window_titles: Arc<DashMap<String, String>>,
    // Latest shell-reported working directory per terminal, parsed from OSC 9;9 / OSC 7
    // in the PTY output stream (backlog 004). This is the source of truth for cwd on
    // shells whose process cwd is NOT live — notably PowerShell, which doesn't update
    // its PEB on Set-Location. Falls back to sysinfo when absent.
    pub terminal_cwds: Arc<DashMap<String, String>>,
    // Per-terminal scrollback persisted to disk, keyed by renderer id (tab_id).
    pub history_store: Arc<crate::history_store::HistoryStore>,
    // Terminal ids (processId) whose in-memory history changed since the last flush.
    // The 30s flush task drains this; idle terminals are never re-written.
    pub history_dirty: Arc<DashMap<String, ()>>,
    // One-shot restore prefix (previous-session scrollback) per processId, staged by
    // create_terminal and consumed by the /snapshot endpoint on first hydration.
    pub replay_prefix: Arc<DashMap<String, String>>,
    // Per-terminal serialization for history persistence (review 062): held across
    // snapshot→render→upsert so write order always matches snapshot order (a slow
    // periodic-flush render can't overwrite a newer exit snapshot), and taken by
    // close_terminal around cleanup+row-delete so an in-flight persist can't
    // resurrect an explicitly-deleted row.
    pub history_persist_locks: Arc<DashMap<String, Arc<Mutex<()>>>>,
    // The window label that API/MCP-created terminals route to. The create event is
    // BROADCAST with this label in its payload; each window ignores it unless it
    // matches its own label (the proven app:close-requested pattern — a bare emit_to
    // is documented as unreliable here). Defaults to the boot window ("main"); the
    // titlebar toggle (set_active_window) and the window-destroy fallback update it.
    pub active_window: Arc<RwLock<String>>,
    // Stable per-process identity, returned on /health so a second instance can tell
    // "this port is mine" from "another instance owns it" (P0b conflict detection).
    pub instance_id: String,
    // --- PTY-host sidecar (opt-in, Windows) ---
    // The connected sidecar client, when the pty-host flag is enabled and a
    // connection has been established. None otherwise (in-process spawn path).
    pub pty_host: Arc<Mutex<Option<crate::pty_host_client::PtyHostClient>>>,
    // Terminal ids (tab_id) whose PTY lives in the sidecar, not in `ptys`/
    // `shell_writer_channels`. write/resize/close/repaint route to the client
    // for these; everything else is unchanged.
    pub host_terminals: Arc<DashMap<String, ()>>,
    // Sessions the sidecar still held when we connected (survived a hot-swap),
    // mapped tab_id -> child pid. Populated once in `ensure_pty_host`;
    // `create_host_terminal` reattaches to (instead of respawning) any tab_id
    // present here, restoring the real pid.
    pub host_reattach_pending: Arc<DashMap<String, u32>>,
    // Monotonic generation bumped on each successful sidecar connect. A client's
    // on_disconnect only clears `pty_host` if its generation is still current,
    // so a dying old client can't null a freshly reconnected one.
    pub pty_host_gen: Arc<AtomicU64>,
    // Single-flight guard so concurrent pane creation connects the sidecar once.
    pub pty_host_connecting: Arc<tokio::sync::Mutex<()>>,
}

impl<R: Runtime> Clone for AppState<R> {
    fn clone(&self) -> Self {
        Self {
            pending_open_path: self.pending_open_path.clone(),
            terminals: self.terminals.clone(),
            shell_writer_channels: self.shell_writer_channels.clone(),
            ptys: self.ptys.clone(),
            output_tx: self.output_tx.clone(),
            terminal_history: self.terminal_history.clone(),
            output_produced: self.output_produced.clone(),
            output_consumed: self.output_consumed.clone(),
            consumer_generation: self.consumer_generation.clone(),
            last_repaint_ms: self.last_repaint_ms.clone(),
            terminal_screens: self.terminal_screens.clone(),
            terminal_focus_reporting: self.terminal_focus_reporting.clone(),
            event_bus: self.event_bus.clone(),
            activity_tracker: self.activity_tracker.clone(),
            recording_service: self.recording_service.clone(),
            search_service: self.search_service.clone(),
            layout_manager: self.layout_manager.clone(),
            test_capture_dir: self.test_capture_dir.clone(),
            test_capture_enabled: self.test_capture_enabled.clone(),
            test_capture_id: self.test_capture_id.clone(),
            tmux_config: self.tmux_config.clone(),
            tmux_sessions: self.tmux_sessions.clone(),
            mcp_process: self.mcp_process.clone(),
            fabric_process: self.fabric_process.clone(),
            fabric_generation: self.fabric_generation.clone(),
            fabric_control_port: self.fabric_control_port,
            keep_running_in_background: self.keep_running_in_background.clone(),
            network: self.network.clone(),
            api_shutdown: self.api_shutdown.clone(),
            network_op_lock: self.network_op_lock.clone(),
            jwt_secret: self.jwt_secret.clone(),
            app_handle: self.app_handle.clone(),
            detach_payloads: self.detach_payloads.clone(),
            active_global_drag: self.active_global_drag.clone(),
            window_titles: self.window_titles.clone(),
            terminal_cwds: self.terminal_cwds.clone(),
            history_store: self.history_store.clone(),
            history_dirty: self.history_dirty.clone(),
            replay_prefix: self.replay_prefix.clone(),
            history_persist_locks: self.history_persist_locks.clone(),
            active_window: self.active_window.clone(),
            instance_id: self.instance_id.clone(),
            pty_host: self.pty_host.clone(),
            host_terminals: self.host_terminals.clone(),
            host_reattach_pending: self.host_reattach_pending.clone(),
            pty_host_gen: self.pty_host_gen.clone(),
            pty_host_connecting: self.pty_host_connecting.clone(),
        }
    }
}

impl<R: Runtime> AppState<R> {
    pub fn new(
        output_tx: broadcast::Sender<ChannelPayload>,
        app_handle: AppHandle<R>,
        network: crate::app_config::NetworkConfig,
    ) -> Self {
        // Detect tmux availability at startup
        let tmux_config = crate::tmux_manager::detect_tmux_availability();

        // JWT secret - use environment variable or default
        let jwt_secret = std::env::var("JWT_SECRET")
            .unwrap_or_else(|_| "auto-terminal-default-secret-2025-fix".to_string());

        Self {
            pending_open_path: Arc::new(std::sync::Mutex::new(None)),
            terminals: Arc::new(DashMap::new()),
            shell_writer_channels: Arc::new(DashMap::new()),
            ptys: Arc::new(DashMap::new()),
            output_tx,
            terminal_history: Arc::new(DashMap::new()),
            output_produced: Arc::new(AtomicU64::new(0)),
            output_consumed: Arc::new(AtomicU64::new(0)),
            consumer_generation: Arc::new(AtomicU64::new(0)),
            last_repaint_ms: Arc::new(AtomicU64::new(0)),
            terminal_screens: Arc::new(DashMap::new()),
            terminal_focus_reporting: Arc::new(DashMap::new()),
            event_bus: Arc::new(EventBus::default()),
            activity_tracker: Arc::new(ActivityTracker::default()),
            recording_service: Arc::new(RecordingService::new()),
            search_service: Arc::new(SearchService::new()),
            layout_manager: Arc::new(LayoutManager::new()),
            test_capture_dir: PathBuf::from("../test-captures"),
            test_capture_enabled: Arc::new(AtomicBool::new(false)),
            test_capture_id: Arc::new(RwLock::new(None)),
            tmux_config: Arc::new(RwLock::new(tmux_config)),
            tmux_sessions: Arc::new(DashMap::new()),
            mcp_process: Arc::new(Mutex::new(None)),
            fabric_process: Arc::new(Mutex::new(None)),
            fabric_generation: Arc::new(AtomicU64::new(0)),
            fabric_control_port: crate::app_config::resolve_fabric_control_port(),
            keep_running_in_background: Arc::new(AtomicBool::new(false)),
            network: Arc::new(RwLock::new(network)),
            api_shutdown: Arc::new(Mutex::new(None)),
            network_op_lock: Arc::new(tokio::sync::Mutex::new(())),
            jwt_secret,
            app_handle,
            detach_payloads: Arc::new(DashMap::new()),
            active_global_drag: Arc::new(Mutex::new(None)),
            window_titles: Arc::new(DashMap::new()),
            terminal_cwds: Arc::new(DashMap::new()),
            history_store: Arc::new(crate::history_store::HistoryStore::new()),
            history_dirty: Arc::new(DashMap::new()),
            replay_prefix: Arc::new(DashMap::new()),
            history_persist_locks: Arc::new(DashMap::new()),
            active_window: Arc::new(RwLock::new(DEFAULT_ACTIVE_WINDOW.to_string())),
            instance_id: uuid::Uuid::new_v4().to_string(),
            pty_host: Arc::new(Mutex::new(None)),
            host_terminals: Arc::new(DashMap::new()),
            host_reattach_pending: Arc::new(DashMap::new()),
            pty_host_gen: Arc::new(AtomicU64::new(0)),
            pty_host_connecting: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    /// The window label API/MCP terminal events should target, normalized against
    /// currently-live windows so we never route to (or show as active) a dead label.
    pub fn resolve_active_window_label(&self) -> String {
        self.resolve_active_window_label_excluding("")
    }

    /// Like `resolve_active_window_label`, but treats `exclude` as already gone (used
    /// from the window-destroyed handler, where the closing window may still appear in
    /// `webview_windows()`). Order: current choice → boot window → first real window.
    pub fn resolve_active_window_label_excluding(&self, exclude: &str) -> String {
        use tauri::Manager;
        let windows = self.app_handle.webview_windows();
        let live = |l: &str| l != exclude && l != "drag-preview" && windows.contains_key(l);
        let chosen = self.active_window.read().clone();
        if live(&chosen) {
            return chosen;
        }
        if live(DEFAULT_ACTIVE_WINDOW) {
            return DEFAULT_ACTIVE_WINDOW.to_string();
        }
        for l in windows.keys() {
            if l.as_str() != exclude && l.as_str() != "drag-preview" {
                return l.to_string();
            }
        }
        DEFAULT_ACTIVE_WINDOW.to_string()
    }

    /// Check if tmux is available on the system
    pub fn is_tmux_available(&self) -> bool {
        self.tmux_config.read().available
    }

    /// Get the terminal backend type for a given terminal ID
    pub fn get_terminal_backend(&self, id: &str) -> Option<TerminalBackend> {
        self.terminals.get(id).map(|t| t.backend)
    }

    /// Create (or replace) the authoritative screen parser for a terminal at the
    /// given size. Called once at terminal creation; re-calling would discard any
    /// accumulated screen state, so it is NOT meant to be called repeatedly.
    pub fn init_screen(&self, id: &str, rows: u16, cols: u16) {
        self.terminal_screens.insert(
            id.to_string(),
            Mutex::new(vt100::Parser::new(rows.max(1), cols.max(1), SCROLLBACK_LINES)),
        );
        self.terminal_focus_reporting
            .insert(id.to_string(), FocusReportingTracker::default());
    }

    /// Feed raw PTY bytes into the terminal's authoritative screen parser.
    ///
    /// The parser is created by `init_screen` at spawn (before the reader thread
    /// starts), so it always exists for a live terminal. If it's missing here the
    /// terminal has already been torn down and this is a late broadcast chunk
    /// arriving after cleanup — we deliberately do NOT re-create it, which would
    /// resurrect a parser for a dead terminal and leak it forever.
    pub fn feed_screen(&self, id: &str, data: &[u8]) {
        // Track focus-event reporting in its own map/scope BEFORE taking the
        // parser guard — no guard is ever held across the two maps.
        if let Some(mut tracker) = self.terminal_focus_reporting.get_mut(id) {
            tracker.scan(data);
        }
        if let Some(screen) = self.terminal_screens.get(id) {
            match screen.lock() {
                Ok(mut parser) => parser.process(data),
                // A poisoned lock means a prior holder panicked; the screen would
                // silently go stale forever, so surface it rather than swallow it.
                Err(_) => log::warn!("feed_screen: screen parser mutex poisoned for {}", id),
            }
        }
    }

    /// Resize the terminal's authoritative screen parser to match the PTY/viewport.
    /// Like a real VT this clips content beyond the new bounds rather than rewrapping;
    /// the running program redraws on SIGWINCH, which re-feeds the parser correctly.
    pub fn resize_screen(&self, id: &str, rows: u16, cols: u16) {
        if let Some(screen) = self.terminal_screens.get(id) {
            match screen.lock() {
                Ok(mut parser) => parser.screen_mut().set_size(rows.max(1), cols.max(1)),
                Err(_) => log::warn!("resize_screen: screen parser mutex poisoned for {}", id),
            }
        }
    }

    /// Render the terminal's current visible screen as a styled escape-sequence
    /// blob that reproduces it exactly when written to a fresh terminal of the
    /// same size. Returns None if no parser exists for the terminal.
    ///
    /// The snapshot is taken at the parser's current size — callers that need a
    /// specific viewport must `resize_screen` first. We deliberately do NOT resize
    /// here: a read-side resize would let concurrent clients with different
    /// viewports fight over the single shared parser size.
    pub fn screen_snapshot(&self, id: &str) -> Option<Vec<u8>> {
        let screen = self.terminal_screens.get(id)?;
        let parser = match screen.lock() {
            Ok(parser) => parser,
            Err(_) => {
                log::warn!("screen_snapshot: screen parser mutex poisoned for {}", id);
                return None;
            }
        };
        Some(parser.screen().contents_formatted())
    }

    /// Escape sequences restoring the terminal's live input modes, appended to
    /// hydration snapshots by the /snapshot endpoint: the vt100 parser's tracked
    /// modes (mouse protocol + encoding, bracketed paste, application cursor /
    /// keypad) plus focus-event reporting (tracked separately — vt100 ignores
    /// DECSET 1004). `contents_formatted()` does not include input modes, so a
    /// rehydrating client (window reload, tab moved to another window) would
    /// otherwise lose the mode state a running TUI already asserted — e.g. the
    /// suggest-popup suppression signals for agent CLIs (backlog 011).
    pub fn input_modes_snapshot(&self, id: &str) -> Vec<u8> {
        let mut out = Vec::new();
        if let Some(screen) = self.terminal_screens.get(id) {
            if let Ok(parser) = screen.lock() {
                out.extend_from_slice(&parser.screen().input_mode_formatted());
            }
        }
        // Focus reporting is only a meaningful signal off Windows: ConPTY
        // asserts DECSET 1004 for EVERY session (even `cmd /c ping`), so
        // replaying it on Windows would set the mode at plain prompts and
        // suppress command suggestions there. Windows agent-CLI suppression is
        // handled by the renderer's prompt gate instead.
        #[cfg(not(windows))]
        if let Some(tracker) = self.terminal_focus_reporting.get(id) {
            if tracker.on {
                out.extend_from_slice(b"\x1b[?1004h");
            }
        }
        out
    }

    /// Like `screen_snapshot`, but returns `None` when the rendered screen has no
    /// visible text (only blanks). Used by history persistence so we never store a
    /// blank blob that would replay on restart as a bare "session restored" divider
    /// with nothing above it. Checks the plain `contents()` (no escape bytes) under
    /// the same single lock that produces the formatted snapshot.
    pub fn screen_snapshot_if_nonblank(&self, id: &str) -> Option<Vec<u8>> {
        let screen = self.terminal_screens.get(id)?;
        let parser = match screen.lock() {
            Ok(parser) => parser,
            Err(_) => {
                log::warn!("screen_snapshot_if_nonblank: screen parser mutex poisoned for {}", id);
                return None;
            }
        };
        if parser.screen().contents().trim().is_empty() {
            return None;
        }
        Some(parser.screen().contents_formatted())
    }

    /// Render this terminal's FULL buffer (scrollback + visible screen) as a styled,
    /// replayable byte stream for persistence — soft-wrapped rows joined, no
    /// screen-clear, so 2J-cleared transient frames (full-screen TUIs) are excluded by
    /// construction. Returns None when the whole buffer is blank.
    ///
    /// The heavy O(scrollback) render runs on an OWNED clone of the screen taken under
    /// the lock, NOT while holding it: the single PTY output consumer contends on this
    /// same parser mutex (feed_screen), and holding it across a 5000-row render would
    /// stall output delivery for every terminal (see output-pipeline-architecture).
    pub fn full_scrollback_snapshot(&self, id: &str) -> Option<Vec<u8>> {
        let mut screen = {
            let entry = self.terminal_screens.get(id)?;
            let parser = match entry.lock() {
                Ok(p) => p,
                Err(_) => {
                    log::warn!("full_scrollback_snapshot: screen parser mutex poisoned for {}", id);
                    return None;
                }
            };
            parser.screen().clone()
        };
        render_full_scrollback(&mut screen)
    }

    /// Persist one terminal's RENDERED scrollback under its renderer id (tab_id).
    /// Skips terminals that are gone or have no renderer id (e.g. API-created PTYs).
    ///
    /// We persist the authoritative vt100 parser's FULL buffer (scrollback + visible
    /// screen) rendered as styled lines — NOT the raw PTY byte stream. Raw replay is
    /// broken for full-screen TUIs (codex, vim, htop): they redraw in place with absolute
    /// cursor addressing + screen clears sized to the old terminal, so concatenating the
    /// raw chunks into a fresh, possibly resized xterm paints garbage. The parser has
    /// already resolved every chunk (fed unconditionally in the output consumer, before
    /// the history filter) into a flat grid plus scrollback; rendering each row as its own
    /// line (no screen-clear) reproduces the entire session history. 2J-cleared transient
    /// frames never enter scrollback, so this stays TUI-safe (see render_full_scrollback).
    ///
    /// Called from the periodic dirty flush (lib.rs) and from every session-exit
    /// path BEFORE `cleanup_terminal_state`, so a dying session's final output
    /// (since the last 30s flush) still reaches the store.
    pub fn persist_terminal_history(&self, id: &str, now_ms: i64) {
        // Serialize per-terminal across snapshot→render→upsert (review 062): without
        // this, a slow periodic-flush render could finish AFTER a newer exit-path
        // persist and overwrite the final row with older content — permanently,
        // since a dead terminal is never persisted again.
        let guard_arc = self.history_persist_guard(id);
        let _guard = guard_arc.lock().unwrap_or_else(|e| e.into_inner());
        let Some(tab_id) = self.terminals.get(id).and_then(|t| t.tab_id.clone()) else { return };
        // Skip when the parser is absent or the whole buffer is blank (brand-new or
        // already-cleared terminal) so we never persist a blank blob that would replay as
        // an empty "session restored" divider with nothing above it.
        let Some(snapshot) = self.full_scrollback_snapshot(id) else { return };
        let blob = String::from_utf8_lossy(&snapshot).into_owned();
        self.history_store.upsert(&tab_id, std::slice::from_ref(&blob), now_ms);
    }

    /// The per-terminal persistence lock (see `history_persist_locks`). The Arc is
    /// cloned and the DashMap shard guard dropped BEFORE the caller locks the inner
    /// mutex — never hold a shard guard across an inner lock (output-pipeline rule).
    pub fn history_persist_guard(&self, id: &str) -> Arc<Mutex<()>> {
        self.history_persist_locks
            .entry(id.to_string())
            .or_default()
            .clone()
    }

    /// Get a terminal's history buffer handle. Clones the Arc and DROPS the
    /// DashMap shard guard before returning, so callers can lock the inner
    /// Mutex without holding any shard lock (see terminal_history field note).
    pub fn get_history(&self, id: &str) -> Option<Arc<Mutex<VecDeque<String>>>> {
        self.terminal_history.get(id).map(|entry| entry.value().clone())
    }

    /// True if `id`'s PTY is hosted by the sidecar (not local `ptys`/writers).
    pub fn is_host_owned(&self, id: &str) -> bool {
        self.host_terminals.contains_key(id)
    }

    /// Lazily connect (spawning if needed) the PTY-host sidecar client, wiring
    /// its inbound Stdout into the existing output broadcast and its Exit/Gap
    /// into cleanup+emit / repaint. Idempotent.
    pub async fn ensure_pty_host(&self) -> Result<(), String> {
        {
            if self.pty_host_client().is_some() {
                return Ok(());
            }
        }
        // Single-flight: serialize concurrent connect attempts (multi-pane
        // startup) so the sidecar is connected exactly once.
        let _connect_guard = self.pty_host_connecting.lock().await;
        // Re-check under the guard — a prior holder may have connected already.
        {
            if self.pty_host_client().is_some() {
                return Ok(());
            }
        }
        // RP-1: install the host into the update-stable runtime dir and run it
        // from there (outside the swapped app payload) so it survives an update.
        let sidecar = crate::pty_host_client::resolve_host_path().ok_or_else(|| {
            "pty-host sidecar binary not found (set TERMFLOW_PTY_HOST_BIN)".to_string()
        })?;
        let pipe = crate::pty_host_client::resolve_pipe();
        let token = crate::pty_host_client::resolve_token();

        // RP-2 discovery: read a running host's advertisement (if any) BEFORE
        // touching the wire, so we never speak an incompatible protocol at it and
        // never force-kill sessions we can't control (design 003 §10.3, C3).
        // No record ⇒ legacy host (or none) on the well-known pipe — v1 as today.
        let record = crate::pty_host_client::record_path()
            .and_then(|p| match termflow_pty_protocol::read_record(&p) {
                Ok(r) => r,
                Err(e) => {
                    log::warn!("[HOTSWAP] unreadable host discovery record ({e}); treating as legacy");
                    None
                }
            });
        let (pipe, attach_acks) = match crate::pty_host_client::plan_connection(record) {
            crate::pty_host_client::ConnectPlan::LegacyOrNone => {
                log::info!("[HOTSWAP] no host discovery record — legacy/none; using well-known pipe");
                (pipe, false)
            }
            crate::pty_host_client::ConnectPlan::Bootstrap {
                endpoint,
                version,
                instance_id,
                host_caps,
            } => {
                let acks = host_caps & termflow_pty_protocol::CAP_ATTACH_ACK != 0;
                log::info!(
                    "[HOTSWAP] discovered host instance={instance_id:x} proto=v{version} \
                     caps={host_caps:#x} endpoint={endpoint} (attach_acks={acks})"
                );
                (endpoint, acks)
            }
            crate::pty_host_client::ConnectPlan::Incompatible { instance_id } => {
                // C3: NEVER kill or shadow sessions we can't speak to. Refuse the
                // sidecar path; panes fall back in-process and the running host
                // keeps serving its (old-app) sessions untouched.
                log::error!(
                    "[HOTSWAP] running host instance={instance_id:x} shares no protocol \
                     version with this app — leaving its sessions untouched"
                );
                return Err(
                    "a PTY host from another TermFlow version owns your terminals; \
                     close them there or wait for it to drain before new host-owned terminals"
                        .to_string(),
                );
            }
        };

        // Generation for this connection: on_disconnect only nulls `pty_host` if
        // its generation is still current (a dead old client can't clobber a new).
        let my_gen = self.pty_host_gen.fetch_add(1, std::sync::atomic::Ordering::AcqRel) + 1;

        let st_exit = self.clone();
        let st_gap = self.clone();
        let st_disc = self.clone();
        let deps = crate::pty_host_client::PtyHostDeps {
            output_tx: self.output_tx.clone(),
            output_produced: self.output_produced.clone(),
            on_exit: Arc::new(move |tab_id: String, exit_cwd: Option<String>| {
                use tauri::Emitter;
                // Mirror the in-process reader's exit path: capture cwd (from the
                // sidecar or our own OSC tracking), clean up, notify the UI.
                let cwd = exit_cwd
                    .or_else(|| st_exit.terminal_cwds.get(&tab_id).map(|r| r.value().clone()));
                // Persist the final parser state BEFORE cleanup discards it — the
                // periodic flush only runs every 30s, so without this the session's
                // last moments never reach the history store.
                st_exit.persist_terminal_history(&tab_id, chrono::Utc::now().timestamp_millis());
                st_exit.host_terminals.remove(&tab_id);
                st_exit.cleanup_terminal_state(&tab_id);
                let _ = st_exit.app_handle.emit(
                    "terminal:exit",
                    serde_json::json!({ "id": tab_id, "exitCode": 0, "cwd": cwd }),
                );
            }),
            on_gap: Arc::new(move |tab_id: String| {
                st_gap.host_repaint(&tab_id);
            }),
            on_disconnect: Arc::new(move || {
                use tauri::Emitter;
                // Only act if THIS connection is still the current one — a stale
                // old client's disconnect must not clobber a reconnected client.
                if st_disc.pty_host_gen.load(std::sync::atomic::Ordering::Acquire) != my_gen {
                    return;
                }
                // Sidecar/pipe died: surface a closed-session banner on every live
                // host-owned pane, fully clean up its state, and drop the dead
                // client so a later create reconnects.
                let ids: Vec<String> =
                    st_disc.host_terminals.iter().map(|e| e.key().clone()).collect();
                for id in ids {
                    // Same as on_exit: capture the final parser state before cleanup.
                    st_disc.persist_terminal_history(&id, chrono::Utc::now().timestamp_millis());
                    st_disc.host_terminals.remove(&id);
                    st_disc.cleanup_terminal_state(&id);
                    let _ = st_disc.app_handle.emit(
                        "terminal:exit",
                        serde_json::json!({ "id": id, "exitCode": -1, "cwd": serde_json::Value::Null }),
                    );
                }
                *st_disc.pty_host.lock().unwrap_or_else(|e| e.into_inner()) = None;
            }),
        };

        let client = crate::pty_host_client::connect_or_spawn(&sidecar, &pipe, &token, deps)
            .await
            .map_err(|e| e.to_string())?;
        client.set_attach_acks(attach_acks);
        // Record sessions that survived a hot-swap (tab_id -> pid) so
        // create_host_terminal reattaches instead of respawning.
        let surviving = client.list_sessions().await;
        if surviving.is_empty() {
            log::info!("[HOTSWAP] host reports no surviving sessions (fresh host or clean start)");
        } else {
            log::info!(
                "[HOTSWAP] host holds {} surviving session(s): {}",
                surviving.len(),
                surviving
                    .iter()
                    .map(|m| format!("{}(pid {}, alive={})", m.tab_id, m.pid, m.alive))
                    .collect::<Vec<_>>()
                    .join(", ")
            );
        }
        for meta in surviving {
            self.host_reattach_pending.insert(meta.tab_id, meta.pid);
        }
        *self.pty_host.lock().unwrap_or_else(|e| e.into_inner()) = Some(client);
        Ok(())
    }

    /// Clone out the connected client (if any) so callers can `.await` on it
    /// without holding the mutex across the await point.
    pub fn pty_host_clone(&self) -> Option<crate::pty_host_client::PtyHostClient> {
        self.pty_host_client().clone()
    }

    fn pty_host_client(
        &self,
    ) -> std::sync::MutexGuard<'_, Option<crate::pty_host_client::PtyHostClient>> {
        self.pty_host.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// If `id` is host-owned AND the client is connected, forward the write and
    /// return true. Returns false when disconnected so the caller surfaces the
    /// failure instead of reporting a false success for dropped input.
    pub fn host_write(&self, id: &str, bytes: &[u8]) -> bool {
        if !self.is_host_owned(id) {
            return false;
        }
        match self.pty_host_client().as_ref() {
            Some(c) => {
                c.write_stdin(id, bytes);
                true
            }
            None => false,
        }
    }

    /// If `id` is host-owned AND connected, forward the resize and return true.
    pub fn host_resize(&self, id: &str, cols: u16, rows: u16) -> bool {
        if !self.is_host_owned(id) {
            return false;
        }
        match self.pty_host_client().as_ref() {
            Some(c) => {
                c.resize(id, cols, rows);
                true
            }
            None => false,
        }
    }

    /// If `id` is host-owned, forget it and (if connected) tell the sidecar to
    /// close the session. Returns true if it was host-owned (so the caller skips
    /// the local kill) even when the client is gone — there is no local process.
    pub fn host_close(&self, id: &str) -> bool {
        if !self.is_host_owned(id) {
            return false;
        }
        if let Some(c) = self.pty_host_client().as_ref() {
            c.close(id);
        }
        self.host_terminals.remove(id);
        true
    }

    /// If `id` is host-owned, force a repaint via a sidecar resize-nudge (the
    /// local jiggle can't — there is no local master). Returns true if handled.
    pub fn host_repaint(&self, id: &str) -> bool {
        if !self.is_host_owned(id) {
            return false;
        }
        let dims = self.terminals.get(id).map(|t| (t.cols, t.rows));
        if let Some((cols, rows)) = dims {
            if let Some(c) = self.pty_host_client().as_ref() {
                c.nudge_repaint(id, cols, rows);
            }
        }
        true
    }

    /// Force every live PTY to repaint by jiggling its size (rows+1, then back).
    /// ConPTY/apps repaint fully on resize, so this visibly recovers terminals
    /// after output chunks were dropped (broadcast Lagged) or after the output
    /// consumer was respawned by the watchdog. Uses try_lock throughout — the
    /// heal path must never block or wedge itself.
    pub fn repaint_all_terminals(&self) {
        // Collect ids first: never hold the terminals iter guard across
        // PTY mutex acquisition.
        let targets: Vec<String> = self.terminals.iter().map(|e| e.key().clone()).collect();
        for id in targets {
            // Host-owned terminals have no local master — nudge via the sidecar.
            if self.is_host_owned(&id) {
                self.host_repaint(&id);
                continue;
            }
            let Some(master_ref) = self.ptys.get(&id) else { continue };
            let Ok(master) = master_ref.try_lock() else {
                log::warn!("[PIPELINE] repaint: PTY mutex busy for {}, skipping", id);
                continue;
            };
            // Read the size AFTER the PTY mutex is held: the resize handlers
            // update the terminals map while holding this same mutex, so this
            // read is ordered w.r.t. concurrent resizes. Restoring a size
            // snapshotted before the lock could undo a resize that landed in
            // between, leaving the PTY permanently mismatched with the renderer.
            let Some((cols, rows)) = self.terminals.get(&id).map(|t| (t.cols, t.rows)) else {
                continue;
            };
            let jiggle = portable_pty::PtySize {
                rows: rows.saturating_add(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            };
            let restore = portable_pty::PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            };
            if master.resize(jiggle).is_ok() {
                let _ = master.resize(restore);
                log::info!("[PIPELINE] repaint jiggle sent to {}", id);
            }
        }
    }

    /// Debounced repaint_all_terminals — Lagged events arrive in bursts and the
    /// repaint itself generates output, so heal at most once per interval.
    /// Pass 0 to always repaint while still stamping the debounce window
    /// (used by the watchdog so a Lagged right after a heal doesn't double-jiggle).
    pub fn repaint_all_terminals_debounced(&self, min_interval_ms: u64) {
        // Monotonic ms since process start — wall-clock (SystemTime) can jump
        // backwards and silently suppress repaints.
        let now = {
            use std::sync::OnceLock;
            use std::time::Instant;
            static START: OnceLock<Instant> = OnceLock::new();
            START.get_or_init(Instant::now).elapsed().as_millis() as u64
        };
        let last = self.last_repaint_ms.load(Ordering::Relaxed);
        if now.saturating_sub(last) < min_interval_ms {
            return;
        }
        // Single winner per window; losers skip (another thread is healing).
        if self
            .last_repaint_ms
            .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
            .is_err()
        {
            return;
        }
        // Run the jiggle on a detached thread: resize() is a blocking syscall
        // (2 per terminal) and this is called from async contexts — notably the
        // output consumer's Lagged arm, which must keep draining the channel
        // precisely when it is already behind. The debounce above bounds thread
        // spawn frequency.
        let state = self.clone();
        std::thread::spawn(move || state.repaint_all_terminals());
    }

    /// Remove every per-terminal map entry. The single cleanup path shared by the
    /// UI close command, the REST DELETE handler, and the PTY reader's exit
    /// cleanup — so no close path can forget a map (terminal_history and
    /// tmux_sessions were previously leaked by the two explicit close paths).
    ///
    /// Dropping the `ptys` entry drops the MasterPty, which closes the pty and
    /// EOFs the reader thread's cloned reader — that's what unblocks and ends
    /// the reader thread on an explicit close.
    pub fn cleanup_terminal_state(&self, id: &str) {
        // ORDER MATTERS: `terminals` must be removed FIRST — the PTY output
        // listener's history guard (lib.rs) double-checks `terminals` after
        // inserting into `terminal_history`, and that check only closes the
        // TOCTOU window if this method removes `terminals` before
        // `terminal_history`.
        self.terminals.remove(id);
        self.shell_writer_channels.remove(id);
        self.ptys.remove(id);
        self.terminal_screens.remove(id);
        self.terminal_focus_reporting.remove(id);
        self.terminal_history.remove(id);
        self.tmux_sessions.remove(id);
        self.terminal_cwds.remove(id);
        self.replay_prefix.remove(id);
        self.history_dirty.remove(id);
        // The persist guard entry too (a late persist may re-create it via
        // or_default; that's harmless — it then no-ops on the missing terminal).
        self.history_persist_locks.remove(id);
        // Forget host ownership too, so a sidecar-hosted terminal doesn't linger
        // in the routing set after its state is torn down.
        self.host_terminals.remove(id);
    }
}

/// Tracks focus-event reporting (DECSET/DECRST 1004) for one terminal by
/// scanning raw PTY output. Kept outside the vt100 parser because vt100 does
/// not model mode 1004. `carry` holds a bounded unterminated CSI tail so a
/// sequence split across two PTY chunks is still recognized.
#[derive(Default)]
pub struct FocusReportingTracker {
    pub on: bool,
    carry: Vec<u8>,
}

enum DecsetScan {
    /// Not `ESC [ ? … h/l` — advance one byte past the ESC and keep scanning.
    NotDecset,
    /// Chunk ended mid-sequence — carry the tail into the next scan.
    Incomplete,
    /// A complete private set/reset; `len` covers the whole sequence.
    Complete { len: usize, set: bool, has_1004: bool },
}

impl FocusReportingTracker {
    /// Scan a PTY chunk for `CSI ? … 1004 … h|l`. Params can be combined
    /// (`\x1b[?1002;1004h`), and the last occurrence in the stream wins.
    pub fn scan(&mut self, chunk: &[u8]) {
        // Longest real DECSET is far below this; anything longer is not a
        // sequence we care about, so an oversized tail is dropped rather than
        // letting hostile output grow the carry without bound.
        const CARRY_MAX: usize = 64;
        let mut buf = std::mem::take(&mut self.carry);
        buf.extend_from_slice(chunk);
        let mut i = 0;
        while i < buf.len() {
            if buf[i] != 0x1b {
                i += 1;
                continue;
            }
            match Self::parse_private_mode(&buf[i..]) {
                DecsetScan::NotDecset => i += 1,
                DecsetScan::Incomplete => break,
                DecsetScan::Complete { len, set, has_1004 } => {
                    if has_1004 {
                        self.on = set;
                    }
                    i += len;
                }
            }
        }
        if i < buf.len() && buf.len() - i <= CARRY_MAX {
            self.carry = buf[i..].to_vec();
        }
    }

    /// Parse `b` (starting at an ESC byte) as `ESC [ ? params h|l`.
    fn parse_private_mode(b: &[u8]) -> DecsetScan {
        if b.len() < 2 {
            return DecsetScan::Incomplete;
        }
        if b[1] != b'[' {
            return DecsetScan::NotDecset;
        }
        if b.len() < 3 {
            return DecsetScan::Incomplete;
        }
        if b[2] != b'?' {
            return DecsetScan::NotDecset;
        }
        let mut j = 3;
        while j < b.len() && (b[j].is_ascii_digit() || b[j] == b';') {
            j += 1;
        }
        if j >= b.len() {
            return DecsetScan::Incomplete;
        }
        let set = match b[j] {
            b'h' => true,
            b'l' => false,
            _ => return DecsetScan::NotDecset,
        };
        let has_1004 = b[3..j].split(|c| *c == b';').any(|p| p == b"1004");
        DecsetScan::Complete { len: j + 1, set, has_1004 }
    }
}

/// Collect the `take` visible rows at the screen's current scrollback offset as
/// `(styled bytes, plain text, soft-wraps-to-next)` records appended to `recs`.
fn collect_rows(screen: &vt100::Screen, cols: u16, take: usize, recs: &mut Vec<(Vec<u8>, String, bool)>) {
    let styled: Vec<Vec<u8>> = screen.rows_formatted(0, cols).take(take).collect();
    let plain: Vec<String> = screen.rows(0, cols).take(take).collect();
    for (i, (s, p)) in styled.into_iter().zip(plain).enumerate() {
        recs.push((s, p, screen.row_wrapped(i as u16)));
    }
}

/// Render a screen's full buffer (scrollback rows then visible-screen rows) as a
/// styled, replayable byte stream. Soft-wrapped rows are joined to their continuation
/// (no line break) so a logical line stays ONE line and reflows on replay/resize;
/// only hard line ends get a trailing SGR reset + CRLF. No screen-clear is emitted.
/// Mutates the screen's scrollback offset during extraction and restores it. Returns
/// None when every row is blank.
///
/// Takes an owned/cloned screen by `&mut` (see full_scrollback_snapshot) so the
/// O(scrollback) walk never runs while holding the parser mutex the output consumer
/// contends on.
///
/// TUI-safety: a full-screen redraw (codex) clears with `\x1b[2J`, which erases the
/// visible screen WITHOUT pushing those rows to scrollback, so transient frames never
/// appear here — only lines that genuinely scrolled off, plus the final screen.
pub fn render_full_scrollback(screen: &mut vt100::Screen) -> Option<Vec<u8>> {
    let (rows, cols) = screen.size();
    let rows_us = rows as usize;
    let saved = screen.scrollback();

    screen.set_scrollback(usize::MAX);
    let total_sb = screen.scrollback();

    // One record per physical row: (styled bytes, plain text, soft-wraps-to-next).
    let mut recs: Vec<(Vec<u8>, String, bool)> = Vec::new();

    // Scrollback rows, paged in screen-height windows. At offset `total_sb - emitted`
    // the window's first visible row is logical index `emitted`, so stepping `emitted`
    // by the rows actually consumed tiles the scrollback with no overlap or gap.
    let mut emitted = 0usize;
    while emitted < total_sb {
        let take = (total_sb - emitted).min(rows_us);
        screen.set_scrollback(total_sb - emitted);
        collect_rows(screen, cols, take, &mut recs);
        emitted += take;
    }
    // Visible screen rows (offset 0).
    screen.set_scrollback(0);
    collect_rows(screen, cols, rows_us, &mut recs);

    // Restore the caller-visible offset (snapshotting must not move the user's view).
    screen.set_scrollback(saved);

    // Drop trailing blank rows (the screen's unused bottom rows) so restore doesn't
    // replay a wall of empty lines.
    while recs.last().map_or(false, |(_, p, _)| p.trim().is_empty()) {
        recs.pop();
    }
    if recs.is_empty() {
        return None;
    }

    let mut out = Vec::new();
    for (styled, _plain, wrapped) in &recs {
        out.extend_from_slice(styled);
        if !wrapped {
            // Hard line end: reset attrs and break. Soft-wrapped rows are joined to
            // their continuation so the logical line reflows on replay/resize.
            out.extend_from_slice(b"\x1b[0m\r\n");
        }
    }
    Some(out)
}

#[cfg(test)]
mod focus_reporting_tests {
    use super::FocusReportingTracker;

    #[test]
    fn tracks_set_and_reset() {
        let mut t = FocusReportingTracker::default();
        t.scan(b"boot noise\x1b[?1004hui frame");
        assert!(t.on);
        t.scan(b"exit\x1b[?1004l");
        assert!(!t.on);
    }

    #[test]
    fn recognizes_combined_params() {
        let mut t = FocusReportingTracker::default();
        t.scan(b"\x1b[?1002;1004;1006h");
        assert!(t.on, "1004 inside a combined DECSET must be recognized");
        t.scan(b"\x1b[?1002;1006l");
        assert!(t.on, "a DECRST without 1004 must not clear it");
        t.scan(b"\x1b[?1049;1004l");
        assert!(!t.on);
    }

    #[test]
    fn sequence_split_across_chunks() {
        let mut t = FocusReportingTracker::default();
        t.scan(b"prompt\x1b[?10");
        assert!(!t.on, "must not fire on a partial sequence");
        t.scan(b"04h");
        assert!(t.on, "split DECSET must still be recognized via the carry");
    }

    #[test]
    fn ignores_lookalikes_and_wrong_finals() {
        let mut t = FocusReportingTracker::default();
        t.scan(b"\x1b[?1004n\x1b[1004h\x1b]0;title 1004h\x07plain 1004h text");
        assert!(!t.on);
        // Mode 11004 shares digits but is not 1004.
        t.scan(b"\x1b[?11004h");
        assert!(!t.on);
    }

    #[test]
    fn oversized_partial_tail_is_dropped_not_grown() {
        let mut t = FocusReportingTracker::default();
        // An unterminated CSI longer than the carry cap: dropped, and a 1004h in
        // a later chunk still tracks.
        let mut junk = b"\x1b[?".to_vec();
        junk.extend(std::iter::repeat(b'1').take(200));
        t.scan(&junk);
        t.scan(b"\x1b[?1004h");
        assert!(t.on);
    }
}

#[cfg(test)]
mod active_window_tests {
    #[test]
    fn default_active_window_is_main() {
        assert_eq!(super::DEFAULT_ACTIVE_WINDOW, "main");
    }
}

#[cfg(test)]
mod scrollback_tests {
    use super::render_full_scrollback;

    #[test]
    fn full_scrollback_recovers_offscreen_lines() {
        let mut p = vt100::Parser::new(24, 80, 1000);
        for i in 0..50 {
            p.process(format!("line-{:04}\r\n", i).as_bytes());
        }
        let blob = render_full_scrollback(p.screen_mut()).expect("nonblank");
        let text = String::from_utf8_lossy(&blob);
        // line-0001 scrolled off the 24-row screen but must be in the full dump.
        assert!(text.contains("line-0001"), "early off-screen line must be recovered:\n{text}");
        assert!(text.contains("line-0049"), "latest line must be present");
    }

    #[test]
    fn full_scrollback_excludes_2j_cleared_transient_frames() {
        // The codex regression pattern: main-buffer clears + an absolute-positioned
        // transient frame, then the final prompt. 2J-cleared content must NOT appear.
        let mut p = vt100::Parser::new(24, 80, 1000);
        p.process(b"stale pre-codex line\r\n");
        p.process(b"\x1b[2J\x1b[H");
        p.process(b"\x1b[10;5Htransient codex UI");
        p.process(b"\x1b[2J\x1b[H");
        p.process(b"PS D:\\sources> echo done\r\ndone\r\nPS D:\\sources> ");
        let blob = render_full_scrollback(p.screen_mut()).expect("nonblank");
        let text = String::from_utf8_lossy(&blob);
        assert!(text.contains("PS D:\\sources>"), "final prompt must survive, got:\n{text}");
        assert!(!text.contains("transient codex UI"), "2J-cleared transient must not appear, got:\n{text}");
        assert!(!text.contains("stale pre-codex line"), "2J-cleared content must not reappear, got:\n{text}");
    }

    #[test]
    fn full_scrollback_preserves_soft_wrap_for_reflow() {
        // A 120-char logical line in an 80-col terminal is ONE soft-wrapped line. The
        // dump must NOT hard-break it, so replaying into a wider terminal reflows it
        // back onto a single row (the previous code hard-wrapped at col 80).
        let mut p = vt100::Parser::new(24, 80, 1000);
        let long: String = (0..120).map(|i| char::from(b'a' + (i % 26) as u8)).collect();
        p.process(long.as_bytes());
        let blob = render_full_scrollback(p.screen_mut()).expect("nonblank");

        let mut r = vt100::Parser::new(24, 200, 1000);
        r.process(&blob);
        let row0 = r.screen().rows(0, 200).next().unwrap_or_default();
        assert!(
            row0.contains(&long),
            "soft-wrapped line must reflow onto one row when wider, got: {row0:?}"
        );
    }

    #[test]
    fn blank_terminal_snapshot_is_none() {
        let mut p = vt100::Parser::new(24, 80, 1000);
        assert!(render_full_scrollback(p.screen_mut()).is_none());
    }

    /// The scrollback-persistence ratchet regression (docs: partial-scrollback bug):
    /// a fresh parser seeded with the previous session's persisted dump plus the
    /// replay separator — exactly what stage_scrollback feeds it — must re-dump
    /// BOTH sessions, so the next flush preserves restored history instead of
    /// overwriting it with only post-restart content. Also pins that the separator
    /// itself never wipes the seed (e.g. if it ever grew a 2J).
    #[test]
    fn seeded_restore_prefix_survives_reflush() {
        // Session 1: 100 lines scroll off a 24-row screen, then get dumped.
        let mut p1 = vt100::Parser::new(24, 80, 5000);
        for i in 0..100 {
            p1.process(format!("old-line-{:04}\r\n", i).as_bytes());
        }
        let blob1 = render_full_scrollback(p1.screen_mut()).expect("session 1 dump");

        // App restart: fresh parser, seeded with dump + separator, then new output.
        let mut p2 = vt100::Parser::new(24, 80, 5000);
        p2.process(&blob1);
        p2.process(super::REPLAY_SEPARATOR.as_bytes());
        p2.process(b"new-session output\r\n");

        let blob2 = render_full_scrollback(p2.screen_mut()).expect("session 2 dump");
        let text = String::from_utf8_lossy(&blob2);
        assert!(text.contains("old-line-0000"), "oldest restored line must survive reflush:\n{text}");
        assert!(text.contains("old-line-0099"), "newest restored line must survive reflush:\n{text}");
        assert!(text.contains("session restored"), "divider must be part of the re-dump:\n{text}");
        assert!(text.contains("new-session output"), "new session's output must follow:\n{text}");
    }
}
