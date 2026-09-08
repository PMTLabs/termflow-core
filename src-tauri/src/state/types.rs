use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::path::PathBuf;
use tokio::sync::broadcast;
use parking_lot::RwLock;
use crate::event_bus::{EventBus, ActivityTracker};
use crate::recording_service::RecordingService;
use crate::search_service::SearchService;
use crate::layout_manager::LayoutManager;
use crate::tmux_manager::{TmuxConfig, TmuxSession, TerminalBackend};
use tauri::{AppHandle, Runtime, Wry};
use super::render::FocusReportingTracker;

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
    /// The **stable renderer LEAF id** that owns this PTY. Unique per UI pane.
    /// It is the PRIMARY KEY of `terminal_history` (`history_store.rs:93-98`)
    /// and the `terminalId` of every API identity response.
    ///
    /// NOT always `tb-*` for a root/solo pane: that was true before option A
    /// (design 011). Since option A, `resolve_api_spawn_identity` never lets
    /// an API/MCP create take a tab's `tb-*` root leaf — it always mints a
    /// fresh `tm-*`, even for what becomes that tab's only pane. So a
    /// root/solo pane's leaf is `tb-*` (equal to its owning tab) ONLY when the
    /// pane was created by the renderer itself; an API-created tab's root
    /// pane carries a `tm-*` leaf that differs from its `owning_tab_id`.
    /// Cross-window pane detach can also leave a split's `tm-*` leaf as the
    /// sole pane in its new tab, same caveat. `tm-*` therefore does not imply
    /// "split pane" and `tb-*` does not imply "root pane" — only the pane
    /// TREE (renderer-side `panesSlice.treesByTabId`) knows which leaf is a
    /// tab's root.
    ///
    /// `None` when **no renderer pane owns this terminal** (a headless API or
    /// fleet spawn). Such a terminal is deliberately kept OUT of the history
    /// table — see `history_key`. Before P0-A this was never `None` at runtime;
    /// it fell back to the ephemeral `pc-*` process id, which cannot survive a
    /// restart (design 011 §5, corrected after review 086).
    ///
    /// `#[serde(rename)]`, NOT `alias`: `alias` accepts the old key inbound but
    /// EMITS the Rust field name, silently changing the wire contract. `rename`
    /// preserves `tab_id` in both directions (design 011 §6).
    #[serde(rename = "tab_id")]
    pub renderer_terminal_id: Option<String>,
    /// The **tab** that owns the pane above. This is a SEPARATE identity from
    /// `renderer_terminal_id` and must never be assumed equal to it: it happens
    /// to match only for a renderer-created tab whose root leaf reuses the tab
    /// id, and is different for every API-created tab (option A always mints a
    /// fresh `tm-*` leaf) and for a detached pane. Never resolve a terminal
    /// through `owning_tab_id` — only the renderer's pane TREE says which leaf
    /// a tab currently shows. `None` when unknown (a headless spawn, or a
    /// client that predates P0-A).
    ///
    /// NEW in P0-A: the backend had no notion of tab ownership at all before —
    /// it lived only in the renderer's `panesSlice.treesByTabId`.
    #[serde(default)]
    pub owning_tab_id: Option<String>,
    /// The **pty-host session key** — what `Control::Attach` must be given to find
    /// this terminal's session again after a hot-swap (`pty-host/src/manager.rs`,
    /// where the protocol calls it `tab_id`).
    ///
    /// Historically this was implicitly `Terminal.id`, which was itself the leaf:
    /// one string served as map key, sidecar session id, broadcast id and screen
    /// key all at once. Making it explicit is what lets the leaf become a `tm-`
    /// and the id become a `pc-` WITHOUT touching the pty-host — whose protocol
    /// has no rename verb, so a renamed leaf would orphan a live session
    /// (design 014 §A2).
    ///
    /// `== renderer_terminal_id` for anything created on this build. It differs
    /// ONLY for a terminal migrated from a pre-014 build, where it keeps the old
    /// `tb-` key so an already-armed session still reattaches after the upgrade.
    ///
    /// Empty when deserialising a pre-014 payload; callers treat empty as
    /// "fall back to the leaf".
    #[serde(default)]
    pub session_key: String,
    /// Source of the most recent PTY write: "user" (Tauri invoke = keystrokes/
    /// paste) or "api" (REST/MCP input/execute). Drives the per-agent color-scheme
    /// revert-vs-sticky decision (see docs/plan/007-agent-color-schemes-plan.md).
    #[serde(default)]
    pub last_input_source: Option<String>,
    /// Epoch ms of the most recent PTY write.
    #[serde(default)]
    pub last_input_at: Option<i64>,
    /// Whether this shell got the injected OSC 9;9 prompt-render hook (interactive
    /// PowerShell — see pty_manager::shell_emits_prompt_osc). Exposed to the
    /// renderer as `promptHook` so a reload-reattach can re-seed command-suggest's
    /// prompt gate and stop the history popup leaking into an agent CLI's input.
    #[serde(default)]
    pub prompt_hook: bool,
    /// The tab/pane title the RENDERER shows for this terminal, pushed down by
    /// `services/terminalLabelSync.ts` whenever it changes.
    ///
    /// An ADDITIVE field, deliberately not `Terminal.name`, for two reasons that
    /// hold at two different times. `name` is a published contract — it is on the
    /// wire in `/api/terminals` and is what MCP's `get_terminal_detail` returns —
    /// so changing what it HOLDS is a user-visible change to what agents see. And
    /// if `updateTerminalName`'s stub is ever repaired, `name` gains three writers
    /// of two different granularities (`renameTabProcesses` writes a TAB title to
    /// every leaf; `TerminalPane` writes a PANE name to one, from two call sites),
    /// and an auto-title writer beside them would let the shell's next OSC title
    /// silently undo a user's pane rename. The additive field avoids that by
    /// construction rather than by timing.
    ///
    /// `None` until the renderer's first push, and for a headless API/fleet spawn
    /// that has no pane at all. Plan 028 §4.2.
    #[serde(default)]
    pub display_label: Option<String>,
}

/// The pty-host session key for `t`, applying the documented empty-string fallback.
///
/// `Terminal.session_key` is `#[serde(default)]`, so a payload written by a
/// pre-014 build deserialises with `""`. The field's contract says callers treat
/// empty as "fall back to the leaf" — but a fallback that is only DOCUMENTED is
/// not a fallback. Sending `""` to the pty-host does not error: the host simply
/// has no session by that name, so the write, resize or close is silently
/// dropped and the terminal appears frozen.
///
/// Falls back to the leaf, then to the process id — the same order the pre-014
/// code used when all three were one string, so a legacy record resolves to
/// exactly the key the host already knows it by.
pub fn session_key_of(t: &Terminal) -> String {
    if !t.session_key.is_empty() {
        return t.session_key.clone();
    }
    t.renderer_terminal_id.clone().unwrap_or_else(|| t.id.clone())
}

/// Mint a process id: `pc-` + 9 chars, matching the renderer's `utils/id.ts`
/// shape so every id space looks alike apart from its prefix.
///
/// PER RUN, deliberately. A process id identifies one PTY run and must not
/// survive a restart — that is exactly what makes `tm-` (the durable leaf) the
/// id MCP hands out to agents instead (design 014 §A3).
pub fn mint_process_id() -> String {
    format!("pc-{}", &uuid::Uuid::new_v4().to_string().replace('-', "")[..9])
}

fn default_terminal_cols() -> u16 {
    80
}

fn default_terminal_rows() -> u16 {
    24
}

/// Owners (`tb-*` tab ids) with an **in-flight root-leaf claim**.
///
/// ORPHANED RATIONALE (review 109 LOW): this type predates option A, when an
/// API create could decide to take a tab id AS its pane leaf and needed to
/// reserve that decision before registering. Since option A,
/// `resolve_api_spawn_identity` never does that — an API/MCP create always
/// mints a fresh `tm-*` leaf, so there is no API-side root-leaf decision left
/// for this to protect.
///
/// What actually still uses it: `commands::create_terminal`, the RENDERER's
/// own create/restart path, claims its own tab's root leaf before spawning —
/// covering the renderer-vs-renderer re-entrant-restart ordering (review 109
/// H1), not a renderer-vs-API race (option A already closed that by
/// construction). And the claim is NOT an enforcement lock: `try_claim`
/// returning `None` on contention only logs a warning; the caller proceeds
/// anyway (see the comment at `commands.rs`'s `create_terminal`). It is a
/// tripwire, not the H1 fix — the real fix is the renderer-side single-flight
/// guard in `TerminalService.createTerminal`.
#[derive(Default)]
pub struct RootLeafClaims(DashMap<String, ()>);

impl RootLeafClaims {
    /// Record that a create is in flight for `owner`, or return `None` because
    /// one already is.
    ///
    /// NON-ENFORCING: `None` does not block, redirect, or change the shape of
    /// the create. The only caller (the RENDERER path in
    /// `commands::create_terminal`) logs a warning and proceeds. Nothing here
    /// decides root-vs-split — that is purely the renderer pane tree's
    /// structure — and there is no accompanying `terminals` scan any more.
    /// Treat this as a diagnostic tripwire for concurrent renderer creates into
    /// one tab; the actual serialization is the renderer-side single-flight
    /// guard in `TerminalService.createTerminal`.
    pub fn try_claim(self: &Arc<Self>, owner: &str) -> Option<RootLeafClaim> {
        // `insert` returns the PREVIOUS value: `None` means we are the ones who
        // put it there. One atomic shard operation — a `contains_key` followed
        // by an `insert` would reintroduce the very race this closes.
        self.0.insert(owner.to_string(), ()).is_none().then(|| RootLeafClaim {
            owner: owner.to_string(),
            claims: Arc::clone(self),
        })
    }

    #[cfg(test)]
    pub fn is_claimed(&self, owner: &str) -> bool {
        self.0.contains_key(owner)
    }
}

/// RAII release for a `RootLeafClaims` reservation.
///
/// Drop, not an explicit release call, so an early `return`/`?` on any spawn
/// failure path cannot leak the claim. A leaked claim is harmless — the claim
/// never gates anything, so the worst case is a spurious contention warning on
/// the next create into that tab. Held until `spawn_terminal` has returned so
/// the tripwire covers the whole in-flight window.
pub struct RootLeafClaim {
    owner: String,
    claims: Arc<RootLeafClaims>,
}

impl Drop for RootLeafClaim {
    fn drop(&mut self) {
        self.claims.0.remove(&self.owner);
    }
}

#[derive(Clone, Debug)]
pub struct ChannelPayload {
    pub id: String,
    pub data: Vec<u8>,
}

#[derive(Debug)]
pub enum McpProcessHandle {
    Legacy(std::process::Child),
    Sidecar {
        child: tauri_plugin_shell::process::CommandChild,
        /// The shell event drain sends once on `CommandEvent::Terminated`.
        terminated: std::sync::mpsc::Receiver<()>,
    },
}

use std::sync::Mutex;
use std::collections::VecDeque;

/// A process handle coupled to the generation that owns it. The counter and
/// current handle are protected by one mutex so stale lifecycle work cannot
/// select a replacement child between checking and removing it.
pub struct GenerationSlot<T> {
    next_generation: u64,
    current: Option<(u64, T)>,
}

#[cfg(test)]
mod generation_slot_tests {
    use super::GenerationSlot;

    #[test]
    fn a_stale_spawn_cannot_replace_a_newer_slot_or_clear_it() {
        let mut slot = GenerationSlot::new();
        let old = slot.claim_generation();
        let new = slot.claim_generation();
        assert_eq!(slot.install_if_current(old, "old"), Err("old"));
        assert_eq!(slot.install_if_current(new, "new"), Ok(()));
        assert!(!slot.clear_if_current(old));
        assert!(slot.is_present());
        assert_eq!(slot.take_if_current(new), Some("new"));
    }
}

impl<T> GenerationSlot<T> {
    pub fn new() -> Self {
        Self {
            next_generation: 0,
            current: None,
        }
    }

    pub fn claim_generation(&mut self) -> u64 {
        self.next_generation = self.next_generation.wrapping_add(1);
        self.next_generation
    }

    /// Installs a spawned child only if no later spawn has claimed the slot.
    /// The caller must terminate the returned stale child itself.
    pub fn install_if_current(&mut self, generation: u64, handle: T) -> Result<(), T> {
        if self.next_generation == generation {
            self.current = Some((generation, handle));
            Ok(())
        } else {
            Err(handle)
        }
    }

    pub fn clear_if_current(&mut self, generation: u64) -> bool {
        if self.current.as_ref().is_some_and(|(current, _)| *current == generation) {
            self.current = None;
            true
        } else {
            false
        }
    }

    pub fn is_current(&self, generation: u64) -> bool {
        self.current
            .as_ref()
            .is_some_and(|(current, _)| *current == generation)
    }

    pub fn take_if_current(&mut self, generation: u64) -> Option<T> {
        if self.current.as_ref().is_some_and(|(current, _)| *current == generation) {
            self.current.take().map(|(_, handle)| handle)
        } else {
            None
        }
    }

    pub fn take(&mut self) -> Option<T> {
        self.current.take().map(|(_, handle)| handle)
    }

    pub fn is_present(&self) -> bool {
        self.current.is_some()
    }
}

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
    // Tabs whose root leaf is claimed by a RENDERER create/restart that has not
    // registered its `Terminal` yet — a tripwire against a re-entrant renderer
    // restart double-registering one leaf (review 109 H1), not an API-side
    // reservation: option A means an API/MCP create never takes a tab's root
    // leaf at all, so there is nothing left for this to protect on that side.
    // See `RootLeafClaims`.
    pub root_leaf_claims: Arc<RootLeafClaims>,
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
    // MCP process handle and generation are one atomic ownership slot. A stale
    // lifecycle operation may only take the generation it installed.
    pub mcp_process: Arc<Mutex<GenerationSlot<McpProcessHandle>>>,
    // termflow-fabric peering sidecar handle for graceful shutdown. `None` when
    // the fabric binary is absent (open-core builds run fine without it).
    pub fabric_process: Arc<Mutex<GenerationSlot<tauri_plugin_shell::process::CommandChild>>>,
    // Loopback control port the fabric exposes its command/SSE API on. Dev/prod
    // isolated (see app_config::default_fabric_control_port), same as api/mcp ports.
    pub fabric_control_port: u16,
    // When true, closing the last window hides to the tray instead of exiting, so
    // peering keeps running in the background (wired by the tray/background task).
    pub keep_running_in_background: Arc<AtomicBool>,
    // Current resolved network settings (ports, expose flag, access token).
    pub network: Arc<RwLock<crate::app_config::NetworkConfig>>,
    // The ports this instance ACTUALLY serves on. Distinct from `network`, which
    // holds what the user CONFIGURED: a sibling profile may already hold the
    // configured port, and persisting the fallback would silently move the
    // user's setting. Published before the MCP env is built, the fabric starts,
    // or the renderer boots — all of which need the real port.
    pub effective_endpoints: Arc<RwLock<crate::net_ports::EffectiveEndpoints>>,
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
    // Plan 018: the durable list of OS windows to recreate at startup, plus the
    // live `label -> windowId` map the renderer resolves its storage key through.
    // Rust owns this because it must know how many windows to create BEFORE any
    // webview (and therefore any localStorage) exists.
    pub windows: Arc<crate::window_registry::WindowTracker>,
    // Plan 018 Task 8: labels that have acknowledged `app:flush-session`. A
    // programmatic exit bypasses every window's CloseRequested handler, so the
    // renderers are asked to persist their sessions and answer here first.
    pub flush_acks: Arc<DashMap<String, ()>>,
    // Set once a flush-then-exit is underway, so a second Quit does not restart
    // the wait — it exits immediately.
    pub exiting: Arc<AtomicBool>,
    // Latest shell-reported working directory per terminal, parsed from OSC 9;9 / OSC 7
    // in the PTY output stream (backlog 004). This is the source of truth for cwd on
    // shells whose process cwd is NOT live — notably PowerShell, which doesn't update
    // its PEB on Set-Location. Falls back to sysinfo when absent.
    pub terminal_cwds: Arc<DashMap<String, String>>,
    // Per-terminal scrollback persisted to disk, keyed by renderer id (tab_id).
    pub history_store: Arc<crate::history_store::HistoryStore>,
    // Canvas connection graph. Its OWN connection to the same `history.db` rather than a
    // share of the one above: SQLite allows several connections to one file, and a
    // standalone store can be tested against an in-memory database with no AppHandle.
    pub canvas_store: Arc<crate::canvas_store::CanvasStore>,
    // Terminal Automations (plan 028): rules, their pinned terminals and the activity log.
    // Its OWN connection to the same `history.db`, for the same reason as the line above — and
    // it holds no AppHandle, so `append` reports whether an `automation:activity` emit is due
    // and its caller performs the emit.
    pub automation_store: Arc<crate::automation_store::AutomationStore>,
    // The Automations engine: the per-terminal arm/echo/lock/cadence state it drives, and the one
    // flag that stops its loops. Constructed inert like `CanvasStore::new()`; `automation_engine::
    // spawn` starts the loops. Held here so `cleanup_terminal_state` can purge a closing terminal —
    // a restarted terminal REUSES its `tm-` id, and `Unseen` protection engages only when the key is
    // absent, so a stale `Fired` would silently never nag that pane again. Plan 028 §2.1, §7.10.
    pub automations: Arc<crate::automation_engine::AutomationEngine>,
    /// The one `System` snapshot the roster shares, TTL 2 s (plan §4.3).
    ///
    /// On `AppState` rather than inside the engine because it is a projection of the MACHINE, not of
    /// the rules: `list_watchable_terminals` and the targeting tick both read it, arriving from
    /// different threads within the same window, and `System::new_all()` is 50-200 ms.
    pub proc_snapshot: Arc<crate::automation::proc_snapshot::SystemSnapshot>,
    // Renderer-published canvas metadata, partitioned by window so one window's
    // local model cannot erase another's. This is a boot-time projection, never
    // persisted; canvas_endpoints owns the payload types and merge policy.
    pub canvas_nodes: Arc<RwLock<std::collections::HashMap<String, crate::canvas_endpoints::WindowRegistry>>>,
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
    // The window Settings always opens/activates in, regardless of which window the
    // user triggered "Open Settings" from. Same shape and promotion rule as
    // `active_window` (default boot window, reassigned by the window-destroy
    // handler when it closes) but tracked separately: `active_window` is a
    // user-toggleable API/MCP routing target (titlebar control), and coupling
    // Settings' location to that toggle would relocate Settings as a surprising
    // side effect of an unrelated setting.
    pub main_window: Arc<RwLock<String>>,
    // Stable per-process identity, returned on /health so a second instance can tell
    // "this port is mine" from "another instance owns it" (P0b conflict detection).
    pub instance_id: String,
    // --- PTY-host sidecar (default-on, all OSes; `TERMFLOW_PTY_HOST=0` opts out) ---
    // The connected sidecar client, when the pty-host flag is enabled and a
    // connection has been established. None otherwise (in-process spawn path).
    pub pty_host: Arc<Mutex<Option<crate::pty_host_client::PtyHostClient>>>,
    // Terminal ids (tab_id) whose PTY lives in the sidecar, not in `ptys`/
    // `shell_writer_channels`. write/resize/close/repaint route to the client
    // for these; everything else is unchanged.
    pub host_terminals: Arc<DashMap<String, ()>>,
    /// Durable-identity → process-id lookups (design 014 §A3). Kept in its own
    /// type so it is unit-testable without a Tauri AppHandle.
    pub identity: crate::identity_index::IdentityIndex,
    // Sessions the sidecar still held when we connected (survived a hot-swap),
    // mapped tab_id -> child pid. Populated once in `ensure_pty_host`;
    // `create_host_terminal` reattaches to (instead of respawning) any tab_id
    // present here, restoring the real pid.
    pub host_reattach_pending: Arc<DashMap<String, u32>>,
    pub host_restore_pending_windows: Arc<DashMap<String, ()>>,
    pub host_restore_claims: Arc<DashMap<String, ()>>,
    pub host_restore_released: Arc<AtomicBool>,
    pub host_recovery_surfaced: Arc<DashMap<String, ()>>,
    // Backlog 011: PROCESS id (`pc-`) -> prompt_hook, for sessions REATTACHED after a
    // hot-swap (core restart). Set by spawn_routed's reattach branch, drained once by the
    // renderer (take_reattach_prompt_hook) after createTerminal resolves, so it can re-seed
    // the command-suggest prompt gate that its wiped in-memory cache lost. Absent for a
    // fresh spawn — a new shell starts armed at a prompt and must NOT be gated. (Renderer
    // reloads with a live core seed via reconcile instead; the empty terminal list on a core
    // restart is why this path exists.)
    //
    // KEYED BY PROCESS ID, like `state.terminals` beside it — not by the leaf. This comment
    // said "tab_id ->" until design 014 re-keyed the map and left the text behind, and that
    // stale line was the visible fingerprint of a real bug: the renderer went on draining by
    // leaf id, missed every time, and every reattached session lost BOTH the prompt gate and
    // the Win32-Input-Mode re-seed that rides on the same drained value.
    pub reattach_prompt_hooks: Arc<DashMap<String, bool>>,
    // Monotonic generation bumped on each successful sidecar connect. A client's
    // on_disconnect only clears `pty_host` if its generation is still current,
    // so a dying old client can't null a freshly reconnected one.
    pub pty_host_gen: Arc<AtomicU64>,
    // Single-flight guard so concurrent pane creation connects the sidecar once.
    pub pty_host_connecting: Arc<tokio::sync::Mutex<()>>,
    // tab_id → next expected sidecar ring offset (last Stdout.offset + len).
    // Owned here (not by the client) so it survives a client generation: after
    // a pipe drop, reconnect_after_pipe_drop reattaches each session from this
    // offset and the host ring replays exactly the bytes missed while the pipe
    // was down — no duplicate scrollback, no gap.
    pub host_stream_offsets: Arc<DashMap<String, u64>>,
    // Single-flight for reconnect_after_pipe_drop: two quick pipe flaps must not
    // interleave two recovery passes that snapshot the SAME offsets and attach
    // every session twice (duplicate replay into live parsers). A queued pass
    // re-snapshots after the first finishes, so its replay is ~empty.
    pub host_recovering: Arc<tokio::sync::Mutex<()>>,
    // Closes that could not reach the host (pipe was down): host_close records
    // the tab here and the next successful connect delivers the deferred Close
    // — otherwise the session lingers alive in the host as an adoptable zombie
    // the user explicitly closed (review 007 C-2).
    pub host_close_pending: Arc<DashMap<String, ()>>,
}

impl<R: Runtime> Clone for AppState<R> {
    fn clone(&self) -> Self {
        Self {
            pending_open_path: self.pending_open_path.clone(),
            terminals: self.terminals.clone(),
            root_leaf_claims: self.root_leaf_claims.clone(),
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
            fabric_control_port: self.fabric_control_port,
            keep_running_in_background: self.keep_running_in_background.clone(),
            network: self.network.clone(),
            effective_endpoints: self.effective_endpoints.clone(),
            api_shutdown: self.api_shutdown.clone(),
            network_op_lock: self.network_op_lock.clone(),
            jwt_secret: self.jwt_secret.clone(),
            app_handle: self.app_handle.clone(),
            detach_payloads: self.detach_payloads.clone(),
            active_global_drag: self.active_global_drag.clone(),
            window_titles: self.window_titles.clone(),
            windows: self.windows.clone(),
            flush_acks: self.flush_acks.clone(),
            exiting: self.exiting.clone(),
            terminal_cwds: self.terminal_cwds.clone(),
            history_store: self.history_store.clone(),
            canvas_store: self.canvas_store.clone(),
            automation_store: self.automation_store.clone(),
            automations: self.automations.clone(),
            proc_snapshot: self.proc_snapshot.clone(),
            canvas_nodes: self.canvas_nodes.clone(),
            history_dirty: self.history_dirty.clone(),
            replay_prefix: self.replay_prefix.clone(),
            history_persist_locks: self.history_persist_locks.clone(),
            active_window: self.active_window.clone(),
            main_window: self.main_window.clone(),
            instance_id: self.instance_id.clone(),
            pty_host: self.pty_host.clone(),
            host_terminals: self.host_terminals.clone(),
            identity: self.identity.clone(),
            host_reattach_pending: self.host_reattach_pending.clone(),
            host_restore_pending_windows: self.host_restore_pending_windows.clone(),
            host_restore_claims: self.host_restore_claims.clone(),
            host_restore_released: self.host_restore_released.clone(),
            host_recovery_surfaced: self.host_recovery_surfaced.clone(),
            reattach_prompt_hooks: self.reattach_prompt_hooks.clone(),
            pty_host_gen: self.pty_host_gen.clone(),
            pty_host_connecting: self.pty_host_connecting.clone(),
            host_stream_offsets: self.host_stream_offsets.clone(),
            host_recovering: self.host_recovering.clone(),
            host_close_pending: self.host_close_pending.clone(),
        }
    }
}

/// The key a terminal's scrollback is filed under in `terminal_history`, or
/// `None` to skip persistence entirely.
///
/// Pure so the "a process id is never a history key" rule (design 011 §5) is
/// unit-testable without a live PTY or a Tauri `AppHandle` — inline
/// `#[cfg(test)]` only; the `integration-tests` feature breaks the Windows test
/// binary.
pub(crate) fn history_key(renderer_terminal_id: Option<&str>) -> Option<&str> {
    match renderer_terminal_id {
        // A `pc-` id is a PTY process id: it is regenerated on every spawn, so a
        // row keyed by one is orphaned the moment the app restarts and can never
        // be matched to a pane again.
        Some(id) if id.starts_with("pc-") => None,
        other => other,
    }
}

/// Repoint a live terminal's OWNING TAB after its pane was moved into a
/// different tab.
///
/// `owning_tab_id` is written once, at spawn (`pty_manager::spawn_terminal`),
/// but the pane it names moves: a same-window drag dispatches `movePaneToTab`
/// and a cross-window drop re-parents the leaf into another window's tab. The
/// terminal's IDENTITY does not change — the leaf travels with the pane — so
/// nothing else in the system notices, and the stored owner keeps naming a tab
/// the pane has left.
///
/// That is not cosmetic (external review 099, T2-F2). The stale owner is echoed
/// by `terminal_identity_json` to `get_terminal_detail` / `get_my_terminal`, and
/// the MCP tool descriptions tell an agent to pass that `owningTabId` straight
/// back when it creates a sibling pane — so the agent's next pane is created in
/// the wrong tab. It is also emitted on `terminal:external-activity`, lighting
/// the wrong tab. Silently dropping a split's indicator (the pre-P0-A behaviour)
/// is not equivalent to actively routing new work somewhere wrong.
///
/// Keyed by the renderer LEAF rather than by the `terminals` map key, because
/// the leaf is what the renderer's pane tree — the authority on ownership —
/// actually holds; P0-A's uniqueness invariant (design 011 §3, D7) makes it
/// unambiguous, and it is the one identity that means the same thing on both
/// spawn paths (the sidecar path registers under the leaf, the in-process path
/// under a `pc-` id).
///
/// Returns whether a terminal matched. A miss is NOT an error: panes are moved
/// freely, and a leaf can belong to a pane whose PTY has not spawned yet, has
/// already exited, or lives in another instance.
///
/// Takes the map rather than `AppState` so the guard rules stay unit-testable in
/// an inline `#[cfg(test)]` module — the `integration-tests` feature that
/// `mock_app` needs breaks the Windows test binary.
pub(crate) fn retarget_owning_tab(
    terminals: &DashMap<String, Terminal>,
    renderer_terminal_id: &str,
    owning_tab_id: &str,
) -> Result<bool, String> {
    let leaf = renderer_terminal_id.trim();
    let owner = owning_tab_id.trim();
    if leaf.is_empty() || owner.is_empty() {
        return Err("both a renderer terminal (leaf) id and an owning tab id are required".to_string());
    }
    // Fail closed on the one value that is definitely NOT a tab, exactly as the
    // API create path does (`api_server::resolve_api_spawn_identity`). Anything
    // else is accepted verbatim: there is nothing to mint on an update path, and
    // a layout restored from before the `tb-` convention still has to be able to
    // correct its own ownership.
    if owner.starts_with("tm-") {
        return Err(format!(
            "'{owner}' is a pane (leaf) id, not a tab id — pass the owning tab id"
        ));
    }
    // `iter_mut`, not scan-then-`get_mut`: the match and the write happen under
    // the same shard guard, so a concurrent writer cannot slip between them.
    // Nothing inside takes another lock, so this cannot deadlock against the
    // read-only occupancy scan in `create_terminal`.
    for mut entry in terminals.iter_mut() {
        if entry.renderer_terminal_id.as_deref() != Some(leaf) {
            continue;
        }
        if entry.owning_tab_id.as_deref() != Some(owner) {
            let previous = entry.owning_tab_id.clone();
            entry.owning_tab_id = Some(owner.to_string());
            log::info!(
                "Terminal {} (leaf {leaf}) re-parented: owning tab {:?} -> {owner}",
                entry.id,
                previous
            );
        }
        return Ok(true);
    }
    Ok(false)
}

/// Write a terminal's renderer-side tab/pane title, keyed by the durable `tm-` LEAF.
///
/// A free function taking the map rather than a method on `AppState`, exactly like
/// `retarget_owning_tab` above and for the same reason: it can then be unit-tested without an
/// `AppHandle`.
///
/// **Best-effort, like `set_terminal_owning_tab`.** An unmatched leaf is `Ok(false)`, not an error:
/// the renderer fires this off its own store subscription and a pane's PTY may legitimately not exist
/// yet, or any more. `Ok(false)` is what tells the caller a re-assert after spawn is worth making.
///
/// An empty or whitespace label stores `None` rather than `Some("")`, so `label_at` sees an absence
/// and falls through to the next step instead of resolving a blank name. Plan 028 §4.2.
pub(crate) fn set_display_label(
    terminals: &DashMap<String, Terminal>,
    renderer_terminal_id: &str,
    label: Option<&str>,
) -> Result<bool, String> {
    let leaf = renderer_terminal_id.trim();
    if leaf.is_empty() {
        return Err("a renderer terminal (leaf) id is required".to_string());
    }
    let next = label
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string);
    // `iter_mut`, not scan-then-`get_mut`: the match and the write happen under the same shard guard.
    for mut entry in terminals.iter_mut() {
        if entry.renderer_terminal_id.as_deref() != Some(leaf) {
            continue;
        }
        if entry.display_label != next {
            entry.display_label = next.clone();
        }
        return Ok(true);
    }
    Ok(false)
}

/// Pure selection behind `active_window`/`main_window` promotion: given a
/// preferred label, a label to treat as already gone (the window mid-close, which
/// may still appear in `webview_windows()` when this runs from its own destroy
/// handler), and the set of currently-live window labels, pick which one to use.
/// Order: `chosen` → boot window (`DEFAULT_ACTIVE_WINDOW`) → first other live
/// window → boot window.
///
/// Split out from `resolve_window_label_excluding` (a method on `AppState<R>`, which
/// needs a real `AppHandle` to call `webview_windows()`) specifically so the
/// decision logic itself is reachable from a plain unit test — `AppState`'s own
/// Tauri `test` feature crashes the Windows test binary (see
/// termflow-fabric/docs/agentic/review-rounds-ledger.md, PR #59), so a test that
/// needed a live/mock `AppHandle` here wasn't a realistic option.
pub(crate) fn pick_window_label(chosen: &str, exclude: &str, live_labels: &[&str]) -> String {
    let live = |l: &str| l != exclude && l != "drag-preview" && live_labels.contains(&l);
    if live(chosen) {
        return chosen.to_string();
    }
    if live(DEFAULT_ACTIVE_WINDOW) {
        return DEFAULT_ACTIVE_WINDOW.to_string();
    }
    for l in live_labels {
        if *l != exclude && *l != "drag-preview" {
            return l.to_string();
        }
    }
    DEFAULT_ACTIVE_WINDOW.to_string()
}


#[cfg(test)]
mod terminal_identity_serde_tests {
    use super::{Terminal, TerminalBackend};

    fn sample() -> Terminal {
        Terminal {
            id: "pc-abc123def".into(),
            pid: 4242,
            shell: "pwsh".into(),
            name: "Terminal-pwsh".into(),
            created_at: "2026-08-14T10:00:00+07:00".into(),
            cols: 120,
            rows: 40,
            backend: TerminalBackend::PortablePty,
            renderer_terminal_id: Some("tm-9f2c1a4b7".into()),
            owning_tab_id: Some("tb-4e8d0c2f1".into()),
            session_key: "tm-9f2c1a4b7".into(),
            last_input_source: None,
            last_input_at: None,
            prompt_hook: false,
            display_label: None,
        }
    }

    /// Design 014 §A2: the four spaces must be simultaneously representable and
    /// must survive a round trip. `session_key` differs from the leaf ONLY for a
    /// terminal migrated from a pre-014 build, which is the case pinned here.
    #[test]
    fn every_identity_round_trips_including_a_migrated_session_key() {
        let mut t = sample();
        t.session_key = "tb-4e8d0c2f1".into(); // migrated: host still knows the old key

        let v = serde_json::to_value(&t).expect("serialize");
        assert_eq!(v["id"], "pc-abc123def");
        assert_eq!(v["tab_id"], "tm-9f2c1a4b7", "leaf must still emit as `tab_id`");
        assert_eq!(v["owning_tab_id"], "tb-4e8d0c2f1");
        assert_eq!(v["session_key"], "tb-4e8d0c2f1");

        let back: Terminal = serde_json::from_value(v).expect("deserialize");
        assert_eq!(back.renderer_terminal_id.as_deref(), Some("tm-9f2c1a4b7"));
        assert_eq!(back.session_key, "tb-4e8d0c2f1");
        assert_eq!(back.id, "pc-abc123def");
    }

    /// A `Terminal` serialised by the PREVIOUS build has no `session_key` at all.
    /// It must deserialise rather than panic — otherwise a persisted payload from
    /// an older version bricks startup.
    #[test]
    fn a_pre_014_payload_without_session_key_still_deserialises() {
        let json = serde_json::json!({
            "id": "tb-old00000",
            "pid": 7,
            "shell": "pwsh",
            "name": "n",
            "created_at": "2026-01-01T00:00:00+00:00",
            "cols": 80,
            "rows": 24,
            "tab_id": "tb-old00000"
        });
        let t: Terminal = serde_json::from_value(json).expect("legacy payload must deserialise");
        assert_eq!(t.session_key, "", "missing session_key defaults; callers fall back to the leaf");
        assert_eq!(t.renderer_terminal_id.as_deref(), Some("tb-old00000"));
    }

    #[test]
    fn mint_process_id_is_prefixed_and_unique() {
        let a = super::mint_process_id();
        let b = super::mint_process_id();
        assert!(a.starts_with("pc-"), "got {a}");
        assert_ne!(a, b, "two mints must not collide");
        assert_eq!(a.len(), "pc-".len() + 9, "9 chars after the prefix, matching utils/id.ts");
    }

    /// The EMITTED key must stay `tab_id`. `#[serde(alias = "tab_id")]` would
    /// accept the old key inbound but emit `renderer_terminal_id`, silently
    /// changing the output contract — `rename` preserves the key in BOTH
    /// directions (design 011 §6). This repo has already shipped one silent
    /// serde-key misroute (fleet MCP `targetOS`), so assert the emitted key
    /// itself, not merely that a round-trip survives.
    #[test]
    fn the_emitted_renderer_id_key_is_still_tab_id() {
        let v = serde_json::to_value(sample()).expect("serialize");
        let obj = v.as_object().expect("object");
        assert!(
            obj.contains_key("tab_id"),
            "emitted keys were {:?}",
            obj.keys().collect::<Vec<_>>()
        );
        assert!(
            !obj.contains_key("renderer_terminal_id"),
            "the Rust field name must NOT leak onto the wire"
        );
        assert_eq!(obj["tab_id"], serde_json::json!("tm-9f2c1a4b7"));
    }

    /// The new field is additive and emits under its own key.
    #[test]
    fn owning_tab_id_is_emitted_alongside() {
        let v = serde_json::to_value(sample()).expect("serialize");
        assert_eq!(v["owning_tab_id"], serde_json::json!("tb-4e8d0c2f1"));
    }

    /// A payload written by a build that predates P0-A has `tab_id` and no
    /// owner. It must still deserialise (success criterion 6).
    #[test]
    fn a_legacy_payload_without_an_owner_still_deserialises() {
        let legacy = serde_json::json!({
            "id": "pc-abc123def",
            "pid": 4242,
            "shell": "pwsh",
            "name": "Terminal-pwsh",
            "created_at": "2026-08-14T10:00:00+07:00",
            "tab_id": "tb-4e8d0c2f1"
        });
        let t: Terminal = serde_json::from_value(legacy).expect("legacy payload");
        assert_eq!(t.renderer_terminal_id.as_deref(), Some("tb-4e8d0c2f1"));
        assert_eq!(t.owning_tab_id, None);
    }

    #[test]
    fn a_round_trip_preserves_all_three_identities() {
        let json = serde_json::to_string(&sample()).expect("serialize");
        let back: Terminal = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.id, "pc-abc123def");
        assert_eq!(back.renderer_terminal_id.as_deref(), Some("tm-9f2c1a4b7"));
        assert_eq!(back.owning_tab_id.as_deref(), Some("tb-4e8d0c2f1"));
    }
}

/// §4.2's write end. The doc on `set_display_label` says it is a free function so it can be tested
/// without an `AppHandle`, and until this module existed that sentence was a claim the file did not
/// support — the label chain was pinned at the renderer end (`terminalLabelSync.test.ts`) and at the
/// read end (`label_at`) with nothing in the middle.
#[cfg(test)]
mod set_display_label_tests {
    use super::{set_display_label, Terminal, TerminalBackend};
    use dashmap::DashMap;

    /// Two live terminals, so every assertion can show the OTHER one was left alone — a writer that
    /// labels every row passes a one-row fixture.
    fn two_panes() -> DashMap<String, Terminal> {
        let map = DashMap::new();
        for (pc, tm, label) in [("pc-1", "tm-x", Some("codex · core")), ("pc-2", "tm-y", None)] {
            map.insert(
                pc.to_string(),
                Terminal {
                    id: pc.into(),
                    pid: 4242,
                    shell: "pwsh".into(),
                    name: "Terminal-pwsh".into(),
                    created_at: "2026-09-04T00:00:00+07:00".into(),
                    session_key: tm.into(),
                    cols: 80,
                    rows: 24,
                    backend: TerminalBackend::PortablePty,
                    renderer_terminal_id: Some(tm.into()),
                    owning_tab_id: Some("tb-a".into()),
                    last_input_source: None,
                    last_input_at: None,
                    prompt_hook: false,
                    display_label: label.map(str::to_string),
                },
            );
        }
        map
    }

    fn label_of(map: &DashMap<String, Terminal>, pc: &str) -> Option<String> {
        map.get(pc).and_then(|t| t.display_label.clone())
    }

    /// Keyed by the `tm-` LEAF, and it writes exactly the row that owns it.
    #[test]
    fn it_writes_the_row_that_owns_the_leaf_and_no_other() {
        let terminals = two_panes();
        assert_eq!(set_display_label(&terminals, "tm-y", Some("build")), Ok(true));
        assert_eq!(label_of(&terminals, "pc-2").as_deref(), Some("build"));
        assert_eq!(
            label_of(&terminals, "pc-1").as_deref(),
            Some("codex · core"),
            "the sibling must be untouched"
        );
    }

    /// A blank label stores `None`, never `Some("")`. `label_at` treats an absence as "try the next
    /// source"; an empty string stored as a label would beat the snapshot that exists for it and
    /// render the Name column blank for good.
    #[test]
    fn a_blank_label_clears_rather_than_storing_an_empty_string() {
        for blank in [Some(""), Some("   "), None] {
            let terminals = two_panes();
            assert_eq!(set_display_label(&terminals, "tm-x", blank), Ok(true));
            assert_eq!(label_of(&terminals, "pc-1"), None, "clearing with {:?}", blank);
        }
    }

    /// Trimmed on the way in, so a label the renderer padded matches one an operator typed.
    #[test]
    fn the_label_is_trimmed() {
        let terminals = two_panes();
        assert_eq!(set_display_label(&terminals, "  tm-y  ", Some("  build  ")), Ok(true));
        assert_eq!(label_of(&terminals, "pc-2").as_deref(), Some("build"), "both sides trimmed");
    }

    /// An unmatched leaf is `Ok(false)`, NOT an error: the renderer fires this off its own store
    /// subscription and a pane's PTY may legitimately not exist yet. `false` is what tells the caller
    /// a re-assert after spawn is worth making — an `Err` here would turn a normal race into a
    /// console warning on every startup.
    #[test]
    fn an_unmatched_leaf_is_a_successful_no_op_and_an_empty_one_is_an_error() {
        let terminals = two_panes();
        assert_eq!(set_display_label(&terminals, "tm-gone", Some("x")), Ok(false));
        assert!(set_display_label(&terminals, "   ", Some("x")).is_err());
        assert_eq!(label_of(&terminals, "pc-1").as_deref(), Some("codex · core"));
    }
}

/// Review 099 T2-F2: the owner recorded at spawn goes stale the moment a pane is
/// dragged into another tab, and it is what `get_terminal_detail` hands an agent
/// to create a sibling pane with.
#[cfg(test)]
mod retarget_owning_tab_tests {
    use super::{retarget_owning_tab, Terminal, TerminalBackend};
    use dashmap::DashMap;

    /// One live terminal: process `pc-1`, pane leaf `tm-x`, owned by tab `tb-a`.
    fn one_split_pane() -> DashMap<String, Terminal> {
        let map = DashMap::new();
        map.insert(
            "pc-1".to_string(),
            Terminal {
                id: "pc-1".into(),
                pid: 4242,
                shell: "pwsh".into(),
                name: "Terminal-pwsh".into(),
                created_at: "2026-08-15T10:00:00+07:00".into(),
                session_key: "tm-x".into(),
                cols: 80,
                rows: 24,
                backend: TerminalBackend::PortablePty,
                renderer_terminal_id: Some("tm-x".into()),
                owning_tab_id: Some("tb-a".into()),
                last_input_source: None,
                last_input_at: None,
                prompt_hook: false,
                display_label: None,
            },
        );
        map
    }

    /// THE regression: after the pane moves from tab A to tab B, the backend
    /// owner must be tab B — otherwise activity lights A and an agent asking for
    /// `owningTabId` creates its next pane in A.
    #[test]
    fn a_moved_pane_updates_the_stored_owner() {
        let terminals = one_split_pane();
        assert_eq!(retarget_owning_tab(&terminals, "tm-x", "tb-b"), Ok(true));
        let t = terminals.get("pc-1").expect("terminal");
        assert_eq!(t.owning_tab_id.as_deref(), Some("tb-b"));
        // The leaf is the pane's identity and travels WITH it — a move must not
        // touch it (that is what makes history/reattach survive the move).
        assert_eq!(t.renderer_terminal_id.as_deref(), Some("tm-x"));
    }

    /// The map is keyed by the PROCESS id; the renderer only ever knows the leaf.
    #[test]
    fn it_matches_on_the_leaf_not_on_the_map_key() {
        let terminals = one_split_pane();
        assert_eq!(
            retarget_owning_tab(&terminals, "pc-1", "tb-b"),
            Ok(false),
            "the map key is not a renderer identity"
        );
        assert_eq!(
            terminals.get("pc-1").expect("terminal").owning_tab_id.as_deref(),
            Some("tb-a"),
        );
    }

    /// Panes move freely; a leaf with no live PTY (never spawned, already exited,
    /// or another instance's) is an ordinary no-op, not a failure the renderer
    /// should surface.
    #[test]
    fn an_unknown_leaf_is_a_miss_not_an_error() {
        let terminals = one_split_pane();
        assert_eq!(retarget_owning_tab(&terminals, "tm-gone", "tb-b"), Ok(false));
    }

    #[test]
    fn a_no_op_move_back_to_the_same_tab_still_reports_a_match() {
        let terminals = one_split_pane();
        assert_eq!(retarget_owning_tab(&terminals, "tm-x", "tb-a"), Ok(true));
        assert_eq!(
            terminals.get("pc-1").expect("terminal").owning_tab_id.as_deref(),
            Some("tb-a"),
        );
    }

    /// Same fail-closed rule as the create path: a `tm-` value is a pane, and
    /// accepting it would file a terminal under an owner no tab can ever match.
    #[test]
    fn a_pane_id_is_rejected_as_an_owner() {
        let terminals = one_split_pane();
        let err = retarget_owning_tab(&terminals, "tm-x", "tm-sibling").expect_err("must reject");
        assert!(err.contains("not a tab id"), "unhelpful message: {err}");
        assert_eq!(
            terminals.get("pc-1").expect("terminal").owning_tab_id.as_deref(),
            Some("tb-a"),
            "a rejected call must not have written anything"
        );
    }

    #[test]
    fn blank_ids_are_rejected() {
        let terminals = one_split_pane();
        assert!(retarget_owning_tab(&terminals, "  ", "tb-b").is_err());
        assert!(retarget_owning_tab(&terminals, "tm-x", "  ").is_err());
    }

    /// A layout persisted before the `tb-` convention still has to be able to
    /// correct itself — there is nothing to mint on an update path.
    #[test]
    fn a_legacy_non_tb_tab_id_is_accepted_verbatim() {
        let terminals = one_split_pane();
        assert_eq!(retarget_owning_tab(&terminals, "tm-x", "tab-legacy-7"), Ok(true));
        assert_eq!(
            terminals.get("pc-1").expect("terminal").owning_tab_id.as_deref(),
            Some("tab-legacy-7"),
        );
    }
}

#[cfg(test)]
mod history_key_tests {
    use super::history_key;

    #[test]
    fn a_renderer_leaf_is_a_valid_history_key() {
        assert_eq!(history_key(Some("tb-4e8d0c2f1")), Some("tb-4e8d0c2f1"));
        assert_eq!(history_key(Some("tm-9f2c1a4b7")), Some("tm-9f2c1a4b7"));
    }

    /// Ground-truth correction C1: before P0-A this could not happen — every
    /// write site wrapped `Some(...)` and the `else { return }` guard at
    /// state.rs:636 was dead code. A headless API/fleet PTY now genuinely has no
    /// renderer id, and must simply not be persisted.
    #[test]
    fn no_renderer_id_means_no_history_row() {
        assert_eq!(history_key(None), None);
    }

    /// Defence in depth. `spawn_terminal`'s old `unwrap_or_else(|| id.clone())`
    /// produced `Some("pc-…")`, which `persist_terminal_history` upserted like
    /// any other key (state.rs:642) — a row keyed by an id that cannot survive a
    /// restart, orphaned forever. Even if someone reintroduces that fallback,
    /// the row must not be written.
    #[test]
    fn a_process_id_is_never_a_history_key() {
        assert_eq!(history_key(Some("pc-abc123def")), None);
    }
}

/// The empty-`session_key` fallback, and the host-id-space mapping.
///
/// Both were found by external review of PR #49 (fabric `docs/review/169`).
#[cfg(test)]
mod session_key_fallback_tests {
    use super::{session_key_of, Terminal};

    fn terminal(id: &str, leaf: Option<&str>, session_key: &str) -> Terminal {
        Terminal {
            id: id.into(),
            pid: 1,
            shell: "pwsh".into(),
            name: "n".into(),
            created_at: "2026-08-20T00:00:00+00:00".into(),
            cols: 80,
            rows: 24,
            backend: crate::tmux_manager::TerminalBackend::PortablePty,
            renderer_terminal_id: leaf.map(str::to_string),
            owning_tab_id: None,
            session_key: session_key.into(),
            last_input_source: None,
            last_input_at: None,
            prompt_hook: false,
            display_label: None,
        }
    }

    #[test]
    fn a_present_session_key_is_used_as_is() {
        assert_eq!(session_key_of(&terminal("pc-1", Some("tm-a"), "tb-legacy")), "tb-legacy");
    }

    /// A pre-014 payload deserialises with `session_key == ""`. Sending that to
    /// the pty-host does NOT error — the host simply has no session by that
    /// name, so writes/resizes/closes are silently dropped and the terminal
    /// looks frozen. The fallback must therefore be code, not a doc comment.
    #[test]
    fn an_empty_session_key_falls_back_to_the_leaf() {
        assert_eq!(session_key_of(&terminal("pc-1", Some("tm-a"), "")), "tm-a");
    }

    /// A headless pre-014 record has neither. Falling back to the process id
    /// matches what the host was given when all three were one string.
    #[test]
    fn an_empty_session_key_with_no_leaf_falls_back_to_the_process_id() {
        assert_eq!(session_key_of(&terminal("pc-1", None, "")), "pc-1");
    }

    /// The fallback must never produce an empty string — that is the value the
    /// host silently ignores, which is the whole failure mode.
    #[test]
    fn the_fallback_never_yields_an_empty_key() {
        for t in [
            terminal("pc-1", Some("tm-a"), ""),
            terminal("pc-1", None, ""),
            terminal("pc-1", Some("tm-a"), "tb-x"),
        ] {
            assert!(!session_key_of(&t).is_empty(), "an empty key is silently dropped by the host");
        }
    }
}
