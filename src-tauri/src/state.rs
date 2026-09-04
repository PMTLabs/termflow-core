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
    // --- PTY-host sidecar (opt-in, Windows) ---
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
            fabric_generation: self.fabric_generation.clone(),
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
fn pick_window_label(chosen: &str, exclude: &str, live_labels: &[&str]) -> String {
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

impl<R: Runtime> AppState<R> {
    /// Resolve either a PTY process id (`pc-*`) or a renderer leaf (`tb-*` / `tm-*`)
    /// to the renderer leaf used by persisted canvas edges. Owning tab ids are not
    /// identities here: a tab can contain more than one live leaf.
    pub fn resolve_renderer_id(&self, incoming_id: &str) -> Option<String> {
        let incoming_id = incoming_id.trim();
        if incoming_id.is_empty() { return None; }
        if let Some(terminal) = self.terminals.get(incoming_id) {
            if let Some(leaf) = terminal.renderer_terminal_id.clone() { return Some(leaf); }
        }
        self.terminals.iter().find_map(|entry| {
            (entry.renderer_terminal_id.as_deref() == Some(incoming_id)).then(|| incoming_id.to_string())
        })
    }

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
            root_leaf_claims: Arc::new(RootLeafClaims::default()),
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
            effective_endpoints: Arc::new(RwLock::new(Default::default())),
            api_shutdown: Arc::new(Mutex::new(None)),
            network_op_lock: Arc::new(tokio::sync::Mutex::new(())),
            jwt_secret,
            app_handle,
            detach_payloads: Arc::new(DashMap::new()),
            active_global_drag: Arc::new(Mutex::new(None)),
            window_titles: Arc::new(DashMap::new()),
            windows: Arc::new(crate::window_registry::WindowTracker::load_default()),
            flush_acks: Arc::new(DashMap::new()),
            exiting: Arc::new(AtomicBool::new(false)),
            terminal_cwds: Arc::new(DashMap::new()),
            history_store: Arc::new(crate::history_store::HistoryStore::new()),
            canvas_store: Arc::new(crate::canvas_store::CanvasStore::new()),
            automation_store: Arc::new(crate::automation_store::AutomationStore::new()),
            automations: Arc::new(crate::automation_engine::AutomationEngine::new(
                chrono::Utc::now().timestamp_millis(),
            )),
            canvas_nodes: Arc::new(RwLock::new(std::collections::HashMap::new())),
            history_dirty: Arc::new(DashMap::new()),
            replay_prefix: Arc::new(DashMap::new()),
            history_persist_locks: Arc::new(DashMap::new()),
            active_window: Arc::new(RwLock::new(DEFAULT_ACTIVE_WINDOW.to_string())),
            main_window: Arc::new(RwLock::new(DEFAULT_ACTIVE_WINDOW.to_string())),
            instance_id: uuid::Uuid::new_v4().to_string(),
            pty_host: Arc::new(Mutex::new(None)),
            host_terminals: Arc::new(DashMap::new()),
            identity: crate::identity_index::IdentityIndex::new(),
            host_reattach_pending: Arc::new(DashMap::new()),
            reattach_prompt_hooks: Arc::new(DashMap::new()),
            pty_host_gen: Arc::new(AtomicU64::new(0)),
            pty_host_connecting: Arc::new(tokio::sync::Mutex::new(())),
            host_stream_offsets: Arc::new(DashMap::new()),
            host_recovering: Arc::new(tokio::sync::Mutex::new(())),
            host_close_pending: Arc::new(DashMap::new()),
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
        let chosen = self.active_window.read().clone();
        self.resolve_window_label_excluding(&chosen, exclude)
    }

    /// The window Settings should open/activate in — see `main_window`'s doc comment.
    pub fn resolve_main_window_label(&self) -> String {
        self.resolve_main_window_label_excluding("")
    }

    /// Like `resolve_main_window_label`, but treats `exclude` as already gone (used
    /// from the window-destroyed handler).
    pub fn resolve_main_window_label_excluding(&self, exclude: &str) -> String {
        let chosen = self.main_window.read().clone();
        self.resolve_window_label_excluding(&chosen, exclude)
    }

    /// Shared normalizer behind both `resolve_active_window_label_excluding` and
    /// `resolve_main_window_label_excluding`: fetches the currently-live window
    /// labels from the real `AppHandle` and hands off to `pick_window_label`, the
    /// pure selection algorithm (kept separate so it's unit-testable without a
    /// live/mock `AppHandle` — see that function's doc comment).
    fn resolve_window_label_excluding(&self, chosen: &str, exclude: &str) -> String {
        use tauri::Manager;
        let windows = self.app_handle.webview_windows();
        let live_labels: Vec<&str> = windows.keys().map(|k| k.as_str()).collect();
        pick_window_label(chosen, exclude, &live_labels)
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

    /// Render the terminal's current visible screen as PLAIN TEXT — the same grid
    /// `screen_snapshot` returns, minus every escape sequence.
    ///
    /// This is the read-for-comprehension counterpart to `screen_snapshot`, for
    /// API/MCP callers that display the screen to a human or an agent rather than
    /// replaying it into a terminal. Note this is NOT equivalent to stripping
    /// escapes from the formatted blob: that blob encodes runs of blanks as cursor
    /// ops (`CUF`/`ECH`), so stripping collapses the column layout. The parser has
    /// already applied those ops to the grid, so rendering from the grid keeps
    /// alignment intact.
    pub fn screen_text(&self, id: &str) -> Option<String> {
        let screen = self.terminal_screens.get(id)?;
        let parser = match screen.lock() {
            Ok(parser) => parser,
            Err(_) => {
                log::warn!("screen_text: screen parser mutex poisoned for {}", id);
                return None;
            }
        };
        Some(parser.screen().contents())
    }

    /// Matchable PLAIN TEXT from the tail of a terminal's buffer — the Automations engine's read.
    ///
    /// **Takes a `pc-` process id**, like every other reader of `terminal_screens`, and does NOT
    /// resolve internally: the engine converts the leaf once per pair before calling. A function that
    /// silently accepted either id space is how the next call site gets it wrong.
    ///
    /// This is the `AppState` impl of the `ScreenSource` port and contains no decision of its own —
    /// look the parser up, lock it, resolve the depth, call the pure walk. Everything with a branch in
    /// it lives in `render_tail_lines`/`tail_text_with`, which take a `&mut Screen` and therefore need
    /// no `AppHandle` to test. Plan 028 §2.2, §7.10.
    ///
    /// Why not the existing routes: `/output` is lossy twice over and `render_terminal_history`
    /// returns the VISIBLE rows only, so it cannot return 200 lines at all; `/snapshot` returns an
    /// escape-sequence blob; `screen_text` is the visible screen with no scrolled-off lines.
    pub fn screen_tail_text(
        &self,
        process_id: &str,
        depth: crate::automation_engine::eval::ReadDepth,
    ) -> Option<String> {
        use crate::automation_engine::eval::ReadDepth;
        let entry = self.terminal_screens.get(process_id)?;
        let mut parser = match entry.lock() {
            Ok(parser) => parser,
            Err(_) => {
                log::warn!("screen_tail_text: screen parser mutex poisoned for {}", process_id);
                return None;
            }
        };
        let screen = parser.screen_mut();
        let max_lines = match depth {
            ReadDepth::Window(n) => n,
            ReadDepth::VisibleScreen => screen.size().0 as usize,
        };
        tail_text_with(screen, |sc| render_tail_lines(sc, max_lines))
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
        let mut blob = render_full_scrollback(&mut screen)?;
        // render_full_scrollback replays plain rows with no position tracking, so a
        // client that resets and writes this blob (the ED3 resize-wipe repair path)
        // would otherwise leave the cursor wherever the last line's newline landed —
        // not the program's actual cursor position. Append the crate's own
        // purpose-built cursor-restore sequence (see its doc: "useful in the case of
        // drawing additional things on top of a terminal output ... without the
        // terminal contents necessarily being the same" — exactly this case), plus
        // an attribute reset since restoring cursor position can itself redraw cells
        // and alter the active drawing attributes (same doc note).
        blob.extend_from_slice(&screen.cursor_state_formatted());
        blob.extend_from_slice(&screen.attributes_formatted());
        Some(blob)
    }

    /// Persist one terminal's RENDERED scrollback under its renderer leaf id
    /// (`renderer_terminal_id` — `tb-*`/`tm-*`).
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
        let renderer_id = self
            .terminals
            .get(id)
            .and_then(|t| t.renderer_terminal_id.clone());
        let Some(key) = history_key(renderer_id.as_deref()) else { return };
        // Skip when the parser is absent or the whole buffer is blank (brand-new or
        // already-cleared terminal) so we never persist a blank blob that would replay as
        // an empty "session restored" divider with nothing above it.
        let Some(snapshot) = self.full_scrollback_snapshot(id) else { return };
        let blob = String::from_utf8_lossy(&snapshot).into_owned();
        self.history_store.upsert(key, std::slice::from_ref(&blob), now_ms);
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
    ///
    /// Boxed: the on_disconnect closure built inside spawns a task that
    /// re-enters this function (reconnect_after_pipe_drop), which with an
    /// opaque `async fn` future is an infinite type cycle the compiler cannot
    /// prove `Send`. The erased (nominal) future breaks the cycle.
    pub fn ensure_pty_host(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + '_>>
    {
        Box::pin(self.ensure_pty_host_inner())
    }

    async fn ensure_pty_host_inner(&self) -> Result<(), String> {
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
        // Advertised host pid (if any): connect_or_spawn refuses to spawn a
        // duplicate host while this pid is alive (sleep/wake duplicate-host bug).
        let record_pid = record.as_ref().map(|r| r.pid);
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
            on_exit: Arc::new(move |process_id: String, session_key: String, exit_cwd: Option<String>| {
                use tauri::Emitter;
                // Mirror the in-process reader's exit path: capture cwd (from the
                // sidecar or our own OSC tracking), clean up, notify the UI.
                let cwd = exit_cwd
                    .or_else(|| st_exit.terminal_cwds.get(&process_id).map(|r| r.value().clone()));
                // Persist the final parser state BEFORE cleanup discards it — the
                // periodic flush only runs every 30s, so without this the session's
                // last moments never reach the history store. Takes the PROCESS id
                // and derives the history key from the terminal's leaf itself.
                st_exit.persist_terminal_history(&process_id, chrono::Utc::now().timestamp_millis());
                st_exit.host_terminals.remove(&process_id);
                // Ring bookkeeping is keyed by the SESSION, not the process: it is
                // the host's own offset and lives in the host's id space.
                st_exit.host_stream_offsets.remove(&session_key);
                // Drop the identity lookups LAST among the removals but before the
                // emit — a leaked entry would route a later terminal's output at a
                // process id that no longer exists.
                st_exit.identity.unindex(&process_id);
                st_exit.cleanup_terminal_state(&process_id);
                let _ = st_exit.app_handle.emit(
                    "terminal:exit",
                    serde_json::json!({ "id": process_id, "exitCode": 0, "cwd": cwd }),
                );
                // Same as the in-process path: release the app window if a dialog
                // this shell owned took it down with it (see console_window).
                crate::console_window::unstick_all(&st_exit.app_handle);
            }),
            on_gap: Arc::new(move |process_id: String| {
                st_gap.host_repaint(&process_id);
            }),
            // Session key -> process id. The host speaks its own id space; every
            // inbound frame is translated here before it reaches our maps
            // (design 014 §A3). An unknown session is DROPPED, never echoed.
            resolve_process: {
                let st = self.clone();
                Arc::new(move |k: &str| st.identity.process_for_session(k))
            },
            on_disconnect: Arc::new(move || {
                // Only act if THIS connection is still the current one — a stale
                // old client's disconnect must not clobber a reconnected client.
                if st_disc.pty_host_gen.load(std::sync::atomic::Ordering::Acquire) != my_gen {
                    return;
                }
                // Pipe died (sleep/wake, sidecar crash, …). Do NOT tear the
                // sessions down here: the host may be alive and holding every
                // shell (it Holds while armed / children live). Drop the dead
                // client, then reconnect-first; only sessions the host no longer
                // has — or a failed reconnect — are torn down.
                log::warn!(
                    "[HOTSWAP] pty-host pipe dropped (gen {my_gen}); trying in-place reconnect"
                );
                *st_disc.pty_host.lock().unwrap_or_else(|e| e.into_inner()) = None;
                let st = st_disc.clone();
                tauri::async_runtime::spawn(async move {
                    st.reconnect_after_pipe_drop().await;
                });
            }),
            stream_offsets: self.host_stream_offsets.clone(),
        };

        let client =
            crate::pty_host_client::connect_or_spawn(&sidecar, &pipe, &token, record_pid, deps)
                .await
                .map_err(|e| e.to_string())?;
        client.set_attach_acks(attach_acks);
        // Record sessions that survived a hot-swap (tab_id -> pid) so
        // create_host_terminal reattaches instead of respawning. `None` means
        // the host did not answer — treat as unknown, never as empty.
        match client.list_sessions().await {
            None => log::warn!(
                "[HOTSWAP] host did not answer ListSessions during connect; \
                 adoption queue left unchanged"
            ),
            Some(surviving) if surviving.is_empty() => {
                log::info!("[HOTSWAP] host reports no surviving sessions (fresh host or clean start)");
                self.host_close_pending.clear(); // authoritative: nothing left to close
            }
            Some(surviving) => {
                log::info!(
                    "[HOTSWAP] host holds {} surviving session(s): {}",
                    surviving.len(),
                    surviving
                        .iter()
                        .map(|m| format!("{}(pid {}, alive={})", m.tab_id, m.pid, m.alive))
                        .collect::<Vec<_>>()
                        .join(", ")
                );
                // Same translation as the recovery pass: `meta.tab_id` is a
                // SESSION key and `host_terminals` is keyed by process id, so the
                // ownership test below must go through this map. Comparing them
                // directly makes every live pane look unowned, which queues it for
                // adoption and lets a concurrent create re-adopt a LIVE session at
                // offset 0 straight into its parser (review 007 F-1).
                let owned_sessions = self.host_sessions_by_key();
                for meta in &surviving {
                    // A close that couldn't reach the host while the pipe was
                    // down: deliver it now instead of re-adopting the session.
                    if self.host_close_pending.remove(&meta.tab_id).is_some() {
                        log::info!(
                            "[HOTSWAP] delivering deferred close for {} (closed while disconnected)",
                            meta.tab_id
                        );
                        client.close(&meta.tab_id);
                        continue;
                    }
                    // Only sessions the GUI does NOT already own belong in the
                    // adoption queue. During an in-place pipe-drop recovery the
                    // live tabs are still registered; queueing them would let a
                    // concurrent create re-adopt one at offset 0 straight into
                    // its live parser (review 007 F-1).
                    if !owned_sessions.contains_key(&meta.tab_id) {
                        self.host_reattach_pending.insert(meta.tab_id.clone(), meta.pid);
                    }
                }
                // Any remaining tombstone names a session this (authoritative)
                // list doesn't have — moot, drop them.
                self.host_close_pending.clear();
            }
        }
        // Never leave a client published whose pipe dropped during setup — its
        // on_disconnect fired while `pty_host` was still None, so nothing else
        // would ever null it and every caller would hold a dead client forever
        // (review 007 C-1b). Publish FIRST, then re-check: if the drop raced
        // in between, we null our own publication; if it fires later, the
        // normal generation-guarded on_disconnect nulls it.
        *self.pty_host.lock().unwrap_or_else(|e| e.into_inner()) = Some(client.clone());
        if !client.is_alive() {
            *self.pty_host.lock().unwrap_or_else(|e| e.into_inner()) = None;
            return Err("pty-host connection lost during setup".to_string());
        }
        // A host reaches here armed for one of two reasons: our OWN prior
        // launch armed it before an update/offload exit (`updater.rs`), or a
        // SIBLING's update armed it as a precaution (`hotswap_arm`). Either
        // way, the reason to stay armed while GUI-less ends the moment a live
        // GUI is connected and has adopted whatever it holds — nothing else
        // ever clears `armed_deadline` on the success path, so without this a
        // later completely normal quit sees the stale arm and Holds instead
        // of tearing down, and the NEXT launch reattaches a session the user
        // already asked to end. Idempotent: a no-op against an unarmed host.
        if !client.disarm().await {
            // Not fatal: the sidecar now also spends the arm on our first frame,
            // and the quit path disarms again. Worth saying out loud, because a
            // silent failure here used to be the whole defect.
            log::warn!("[HOTSWAP] adopted host did not acknowledge the disarm");
        }
        Ok(())
    }

    /// Tear down one previously host-owned terminal that did NOT survive a pipe
    /// drop: persist its final parser state, clean up, and surface the closed-
    /// session banner. (Split out of the formerly-destructive on_disconnect.)
    pub fn teardown_host_terminal(&self, id: &str) {
        use tauri::Emitter;
        self.persist_terminal_history(id, chrono::Utc::now().timestamp_millis());
        // Resolve the session key BEFORE `cleanup_terminal_state` drops the record
        // it lives on. `host_stream_offsets` is the HOST's ring bookkeeping and is
        // keyed by the session, not by our process id — removing it by `id` leaks
        // the entry (design 014 §A2).
        let session_key = self.session_key_for(id);
        self.host_terminals.remove(id);
        if let Some(key) = session_key {
            self.host_stream_offsets.remove(&key);
        }
        self.cleanup_terminal_state(id);
        let _ = self.app_handle.emit(
            "terminal:exit",
            serde_json::json!({ "id": id, "exitCode": -1, "cwd": serde_json::Value::Null }),
        );
    }

    /// Reconnect-first recovery after a pty-host pipe drop (sleep/wake resume,
    /// transient I/O error): bounded-backoff reconnect to the SURVIVING host,
    /// then reattach every still-held session in place from its saved ring
    /// offset (the ring replays exactly the bytes missed while disconnected).
    /// Only sessions the reconnected host no longer holds — or a fully failed
    /// reconnect — get the old destructive teardown. Safe to run concurrently:
    /// ensure_pty_host is single-flight and a duplicate pass replays ~nothing
    /// (offsets have advanced past what the first pass consumed).
    pub async fn reconnect_after_pipe_drop(&self) {
        // Single-flight (see host_recovering): a second flap queues here and
        // re-snapshots offsets once the first pass is done.
        let _recover_guard = self.host_recovering.lock().await;
        // This whole pass runs in the HOST's id space: `plan_reattach` matches
        // against `SessionMeta.tab_id` and `host_stream_offsets` is keyed the
        // same way. `host_terminals` is keyed by our `pc-` process id since
        // design 014, so comparing the two directly matches NOTHING and sends
        // every live terminal to teardown — i.e. a transient pipe drop
        // (sleep/wake) would destroy every shell. Translate once, here.
        let by_session = self.host_sessions_by_key();
        let tabs: Vec<String> = by_session.keys().cloned().collect();
        if tabs.is_empty() {
            return;
        }
        const BACKOFF_MS: &[u64] = &[500, 1000, 2000, 4000, 8000, 8000, 8000];
        let mut connected = false;
        for (i, ms) in BACKOFF_MS.iter().enumerate() {
            // A concurrent terminal-create may already have reconnected
            // (ensure_pty_host is single-flight); otherwise try ourselves.
            if self.pty_host_clone().is_some() || self.ensure_pty_host().await.is_ok() {
                connected = true;
                break;
            }
            log::warn!(
                "[HOTSWAP] reconnect attempt {}/{} failed; retrying in {ms}ms",
                i + 1,
                BACKOFF_MS.len()
            );
            tokio::time::sleep(std::time::Duration::from_millis(*ms)).await;
        }
        let client = if connected { self.pty_host_clone() } else { None };
        let Some(client) = client else {
            log::error!(
                "[HOTSWAP] could not reconnect to any pty-host; closing {} host pane(s)",
                tabs.len()
            );
            for t in &tabs {
                self.teardown_host_terminal(t);
            }
            return;
        };
        // The generation this pass is allowed to act on. If the pipe drops (or
        // a newer connection lands) mid-pass, a NEWER recovery owns the state —
        // this pass must stop before any attach/teardown (review 007 C-1).
        let my_gen = self.pty_host_gen.load(std::sync::atomic::Ordering::Acquire);
        let still_current = || {
            self.pty_host_gen.load(std::sync::atomic::Ordering::Acquire) == my_gen
                && self.pty_host_clone().is_some()
        };
        // Only an ANSWERED ListSessions is authority. A timeout/dead pipe must
        // never read as "the host has no sessions" — that would tear down every
        // live pane on a transport failure (review 007 C-1).
        let mut sessions: Option<Vec<termflow_pty_protocol::SessionMeta>> = None;
        for i in 0..3 {
            if let Some(s) = client.list_sessions().await {
                sessions = Some(s);
                break;
            }
            if i < 2 {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
        }
        let Some(sessions) = sessions else {
            log::error!(
                "[HOTSWAP] host never answered ListSessions during recovery; \
                 leaving {} pane(s) untouched (a later drop or create retries)",
                tabs.len()
            );
            return;
        };
        if !still_current() {
            log::warn!("[HOTSWAP] recovery superseded (gen {my_gen} stale); aborting pass");
            return;
        }
        let saved: std::collections::HashMap<String, u64> = self
            .host_stream_offsets
            .iter()
            .map(|e| (e.key().clone(), *e.value()))
            .collect();
        let (reattach, teardown) = plan_reattach(&tabs, &sessions, &saved);
        log::info!(
            "[HOTSWAP] in-place reconnect: {} session(s) to reattach, {} lost",
            reattach.len(),
            teardown.len()
        );
        for a in reattach {
            if !still_current() {
                log::warn!("[HOTSWAP] recovery superseded mid-reattach; aborting pass");
                return;
            }
            // The pane may have been closed while the pipe was down (host_close
            // couldn't deliver Close then). Finish the close now instead of
            // reattaching a session nobody owns — else it lingers as a zombie.
            // `a.tab_id` is a SESSION key; ownership lives under the process id.
            let Some(process_id) = by_session.get(&a.tab_id).cloned() else {
                log::info!(
                    "[HOTSWAP] {} was closed while disconnected; closing its host session",
                    a.tab_id
                );
                client.close(&a.tab_id);
                continue;
            };
            if !self.host_terminals.contains_key(&process_id) {
                log::info!(
                    "[HOTSWAP] {} was closed while disconnected; closing its host session",
                    a.tab_id
                );
                client.close(&a.tab_id);
                continue;
            }
            match client.attach_confirmed(&a.tab_id, a.from_offset).await {
                Some(true) => log::info!(
                    "[HOTSWAP] reattached {} in place from offset {} (host-confirmed alive)",
                    a.tab_id,
                    a.from_offset
                ),
                Some(false) => log::warn!(
                    "[HOTSWAP] reattached {} but host reports it not alive",
                    a.tab_id
                ),
                None => log::info!(
                    "[HOTSWAP] reattached {} in place from offset {} (legacy attach)",
                    a.tab_id,
                    a.from_offset
                ),
            }
            // Dimensions live under the PROCESS id; the nudge goes to the host,
            // so it stays addressed by the session key.
            let (cols, rows) = self
                .terminals
                .get(&process_id)
                .map(|t| (t.cols, t.rows))
                .unwrap_or((80, 24));
            client.nudge_repaint(&a.tab_id, cols, rows);
            // ensure_pty_host re-listed this session into host_reattach_pending;
            // it is attached in place now, so a later createTerminal for the same
            // id must not re-adopt it.
            self.host_reattach_pending.remove(&a.tab_id);
        }
        for t in teardown {
            if !still_current() {
                log::warn!("[HOTSWAP] recovery superseded mid-teardown; aborting pass");
                return;
            }
            // `t` is a SESSION key; teardown operates on the process id.
            let Some(process_id) = by_session.get(&t).cloned() else {
                continue; // pane already closed while disconnected — nothing to tear down
            };
            if !self.host_terminals.contains_key(&process_id) {
                continue; // pane already closed while disconnected — nothing to tear down
            }
            log::warn!(
                "[HOTSWAP] session {t} not held by the reconnected host; closing its pane"
            );
            self.teardown_host_terminal(&process_id);
        }
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

    /// Every host-owned terminal as `session_key -> process_id`.
    ///
    /// **The pty-host speaks only session keys.** `host_terminals`,
    /// `terminals` and the screens are keyed by our per-run `pc-` id since
    /// design 014, while `SessionMeta.tab_id` and `host_stream_offsets` are in
    /// the host's space. Anything that compares a host answer against our
    /// registrations must go through this map, or every comparison silently
    /// fails and the terminal looks dead to us while being perfectly alive.
    pub fn host_sessions_by_key(&self) -> std::collections::HashMap<String, String> {
        self.host_terminals
            .iter()
            .filter_map(|e| {
                let process_id = e.key().clone();
                self.terminals
                    .get(&process_id)
                    .map(|t| (session_key_of(&t), process_id))
            })
            .collect()
    }

    /// Normalise any caller-supplied terminal reference to this run's map key.
    ///
    /// A `tm-` leaf is resolved through the identity index; anything else is
    /// returned unchanged and looked up directly.
    ///
    /// **Why every terminal lookup must go through this.** Design 014 re-keyed
    /// the per-terminal maps from the leaf to a minted `pc-`, but the API keeps
    /// reporting the leaf as `terminalId` — it is the DURABLE id, and the one
    /// MCP hands agents precisely because a `pc-` does not survive a restart. So
    /// a client that reads `terminalId` back and addresses it — the documented
    /// round trip — would hit a map keyed by something else and 404.
    ///
    /// Tolerant rather than strict on purpose: both id spaces resolve here, and
    /// the "that is a tab id, use `owningTabId`" rejection lives at the MCP
    /// layer, where the agent that made the mistake actually reads the message.
    pub fn resolve_ref(&self, id: &str) -> String {
        if id.starts_with("tm-") {
            if let Some(process_id) = self.identity.process_for_leaf(id) {
                return process_id;
            }
        }
        id.to_string()
    }

    /// The pty-host session key for one of OUR process ids.
    ///
    /// Every call that crosses into the host must go through this: the host knows
    /// a terminal only by its session key, which since design 014 is a different
    /// string from the process id our maps are keyed by. Addressing the host with
    /// a process id silently does nothing — the host has never heard of it.
    ///
    /// Reads the key off the terminal record rather than the index, so it stays
    /// correct for a migrated terminal whose key is its old `tb-` id.
    fn session_key_for(&self, id: &str) -> Option<String> {
        self.terminals.get(id).map(|t| session_key_of(&t))
    }

    /// If `id` is host-owned AND the client is connected, forward the write and
    /// return true. Returns false when disconnected so the caller surfaces the
    /// failure instead of reporting a false success for dropped input.
    pub fn host_write(&self, id: &str, bytes: &[u8]) -> bool {
        if !self.is_host_owned(id) {
            return false;
        }
        let Some(session_key) = self.session_key_for(id) else { return false };
        match self.pty_host_client().as_ref() {
            Some(c) => {
                c.write_stdin(&session_key, bytes);
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
        let Some(session_key) = self.session_key_for(id) else { return false };
        match self.pty_host_client().as_ref() {
            Some(c) => {
                c.resize(&session_key, cols, rows);
                true
            }
            None => false,
        }
    }

    /// If `id` is host-owned, forget it and (if connected) tell the sidecar to
    /// close the session. Returns true if it was host-owned (so the caller skips
    /// the local kill) even when the client is gone — there is no local process.
    /// A close that cannot reach the host (pipe down / dead client) is recorded
    /// in `host_close_pending` and delivered on the next successful connect, so
    /// the session can't linger in the host as an adoptable zombie.
    pub fn host_close(&self, id: &str) -> bool {
        use tauri::Emitter;
        if !self.is_host_owned(id) {
            return false;
        }
        // Resolve BEFORE the removals below drop the record we read it from.
        let session_key = self.session_key_for(id).unwrap_or_else(|| id.to_string());
        // ...and the cwd for the same reason, one step further out: every caller runs
        // `cleanup_terminal_state` the moment this returns, and that drops `terminal_cwds`.
        // It is the directory the shell died in, which is what a restart-in-place resumes in
        // (spec 045 §3.3) — the pane survives an API close, so this is not dead weight.
        let exit_cwd = crate::pty_manager::exit_cwd_for(&self.terminal_cwds, id);
        match self.pty_host_client().as_ref() {
            Some(c) if c.is_alive() => c.close(&session_key),
            _ => {
                // Pending closes are replayed against the HOST later, so they
                // must be recorded in the host id space.
                self.host_close_pending.insert(session_key.clone(), ());
            }
        }
        self.host_terminals.remove(id);
        self.host_stream_offsets.remove(&session_key);

        // Announce the end HERE, because nothing downstream will.
        //
        // The sidecar does send an `Exit` frame for a session it closes — but it arrives
        // ~a second later, over the pipe, and by then the caller has already run
        // `cleanup_terminal_state`, which calls `identity.unindex`. `route_inbound` then
        // fails to resolve the session key and DROPS the frame
        // (`pty_host_client.rs`, "dropping Exit for unknown session"). So a host-owned
        // close emitted nothing at all: the renderer never saw `pty:exit`, and an
        // API/MCP-closed pane sat there with a dead shell, no session-closed banner, no
        // ended tint and no `markTabExited`. The in-process twin has always announced —
        // `kill_process_tree` EOFs the reader thread, which emits from `pty_manager.rs` —
        // so this makes the two paths indistinguishable to the renderer, which is the
        // point: it is the same event, and only the plumbing under it differs.
        //
        // Regression from `3eb571d` (design 014). Before it the `Exit` frame was passed
        // straight through with no lookup, so this close DID reach the UI.
        //
        // `exitCode: 0` and the payload shape are copied from that in-process emit rather
        // than invented, for the same reason: a deliberate close produces no status either
        // way, and a second spelling of "closed" is a second thing to keep in agreement.
        //
        // Emitting unconditionally — including on the pipe-down branch above, where the
        // close is only QUEUED. The terminal is over as far as this GUI is concerned the
        // moment its state is torn down, and a deferred delivery to the host does not
        // change that. Harmless if a future caller skips `cleanup_terminal_state` and the
        // host's own `Exit` therefore does resolve: `markSessionClosed` is idempotent by
        // construction, so the duplicate lands on the state it already produced.
        let _ = self
            .app_handle
            .emit("terminal:exit", host_exit_payload(id, exit_cwd));
        true
    }

    /// If `id` is host-owned, force a repaint via a sidecar resize-nudge (the
    /// local jiggle can't — there is no local master). Returns true if handled.
    pub fn host_repaint(&self, id: &str) -> bool {
        if !self.is_host_owned(id) {
            return false;
        }
        // `id` is the PROCESS id (our map key); the host only knows this terminal
        // by its session key, so the nudge must be addressed in the host's id
        // space (design 014 §A2). Reading both from the same record keeps them
        // consistent even for a migrated terminal, where they differ.
        let info = self
            .terminals
            .get(id)
            .map(|t| (t.cols, t.rows, t.session_key.clone()));
        if let Some((cols, rows, session_key)) = info {
            if let Some(c) = self.pty_host_client().as_ref() {
                c.nudge_repaint(&session_key, cols, rows);
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
        // FIRST STATEMENT, before anything is removed: the Automations engine keys its per-terminal
        // state by the durable `tm-` LEAF, and `terminals[id]` is the ONLY place that mapping lives.
        // `IdentityIndex` maps leaf -> process and never the reverse, and the sidecar exit path has
        // already called `identity.unindex(id)` before it reaches here — so there is no second route
        // to fall back on. Reading the leaf after `terminals.remove` yields `None` and the purge
        // silently does nothing, which is invisible: the symptom is a restarted terminal that is
        // never nagged again rather than an error. Plan 028 §2.4, §10.4c.
        let leaf = self
            .terminals
            .get(id)
            .and_then(|t| t.renderer_terminal_id.clone());
        if let Some(leaf) = leaf {
            self.automations.runtime.forget_terminal(&leaf);
        }
        // `dirty` is keyed by the PROCESS id (`ChannelPayload.id` is a process id), so it is purged
        // with the id this function was given, never with the leaf. Plan 028 §7.4's table.
        self.automations.runtime.forget_process(id);

        // ORDER MATTERS: `terminals` must be removed FIRST — the PTY output
        // listener's history guard (lib.rs) double-checks `terminals` after
        // inserting into `terminal_history`, and that check only closes the
        // TOCTOU window if this method removes `terminals` before
        // `terminal_history`.
        self.terminals.remove(id);
        // Alongside `terminals`, and for the same reason: the identity lookups are
        // an index OF that map, so an entry outliving its terminal would resolve a
        // durable id to a process that no longer exists. One remover, at the same
        // choke point every other per-terminal map is torn down from.
        self.identity.unindex(id);
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

/// The `terminal:exit` payload for a terminal that ENDED — the one shape the renderer's
/// `onTerminalExit` bridge accepts.
///
/// A free function, and taking the resolved cwd rather than `&AppState`, so it can be unit
/// tested without a real `AppHandle<Wry>` — the same constraint (and the same answer)
/// `pty_manager::exit_cwd_for` documents.
///
/// **`id` is the PROCESS id (`pc-`), never the session key.** That is the whole of design
/// 014's inbound rule restated on the outbound side: the renderer's `TerminalService` maps
/// this back to a terminal id by scanning its `terminalId -> process` table, so a session key
/// here resolves to nothing and the exit silently reaches no pane — which is exactly the
/// failure this payload exists to end.
pub(crate) fn host_exit_payload(process_id: &str, exit_cwd: Option<String>) -> serde_json::Value {
    serde_json::json!({
        // Matches `pty_manager`'s in-process emit: portable-pty gives no status there, and a
        // deliberate close has none here, so both report 0 rather than two different
        // stand-ins for "we don't know".
        "id": process_id,
        "exitCode": 0,
        "cwd": exit_cwd,
    })
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

/// The paging plan for a tail read: one `(scrollback offset, rows to skip, rows to take)` per window.
///
/// Pure, and separate from the walk, because §10.1's real requirement — *never read more than
/// `max_lines + rows` rows regardless of buffer depth* — is a claim about the PLAN. `vt100::Screen`
/// cannot be instrumented to count what a walk touched, so a test that tried to assert it against the
/// walk would have to measure time, which is not an oracle. Against the plan it is arithmetic.
///
/// The offsets follow `render_full_scrollback`'s own idiom: at offset `total_sb - emitted` the
/// window's first visible row is logical index `emitted`, so stepping `emitted` by the rows actually
/// consumed tiles the buffer with no overlap or gap. While `emitted <= total_sb` the offset has not
/// saturated, so `window_first == emitted` and the skip is identically zero; only the LAST window —
/// the one whose offset is pinned at 0 — can need a non-zero skip, and it takes every remaining row.
/// That is what bounds the total at `max_lines + rows`.
pub(crate) fn tail_windows(
    total_sb: usize,
    rows: usize,
    max_lines: usize,
) -> Vec<(usize, usize, usize)> {
    let mut plan = Vec::new();
    if rows == 0 || max_lines == 0 {
        return plan;
    }
    let total = total_sb.saturating_add(rows);
    let want = max_lines.min(total);
    let mut emitted = total - want;
    while emitted < total {
        let offset = total_sb.saturating_sub(emitted);
        // The logical index of the first row visible at this offset.
        let window_first = total.saturating_sub(rows + offset);
        let skip = emitted.saturating_sub(window_first);
        let take = (total - emitted).min(rows.saturating_sub(skip));
        if take == 0 {
            // Unreachable while `rows > 0`, and a `break` rather than an assert because this runs on
            // the evaluation loop's hot path: a bad plan must cost a short read, never a panic that
            // poisons the parser mutex.
            break;
        }
        plan.push((offset, skip, take));
        emitted += take;
    }
    plan
}

/// The last `max_lines` rows of a screen's buffer as PLAIN TEXT, soft-wrapped rows joined.
///
/// **Joining wrapped rows is not optional**: a `ctx:63%` straddling column 120 otherwise never
/// matches. Trailing blank rows — the unused bottom of the visible screen — are dropped, so a mostly
/// empty terminal does not return a wall of newlines.
///
/// Two hard constraints, both from review:
///
/// 1. **Never `screen.clone()`.** `vt100::Cell` is 32 bytes, so a 5000x120 buffer is ~19 MB PER
///    EVALUATION. The clone-then-walk shape `full_scrollback_snapshot` uses is fine at the 30 s
///    persist cadence and is not fine at 250 ms.
/// 2. **No indexing, no slicing, no `unwrap`.** A panic inside this walk would poison
///    `terminal_screens[id]`, and `feed_screen` responds to a poisoned lock by logging a warning and
///    DROPPING THE BYTES — that terminal's authoritative parser would be dead for the life of the
///    process: no snapshot, no scrollback persist, no hydration. A read-only feature would have
///    silently destroyed the terminal it was watching. `tail_text_with` is the second half of that
///    guard.
///
/// Bounded at `max_lines` because the walk holds the per-terminal parser mutex that `feed_screen`
/// contends on, and this file's own note above `full_scrollback_snapshot` says holding it across an
/// O(scrollback) render stalls output delivery for EVERY terminal.
pub fn render_tail_lines(screen: &mut vt100::Screen, max_lines: usize) -> String {
    let (rows, cols) = screen.size();
    let saved = screen.scrollback();

    screen.set_scrollback(usize::MAX);
    let total_sb = screen.scrollback();

    // One record per physical row: (plain text, soft-wraps-to-next).
    let mut recs: Vec<(String, bool)> = Vec::new();
    for (offset, skip, take) in tail_windows(total_sb, rows as usize, max_lines) {
        screen.set_scrollback(offset);
        for (i, text) in screen.rows(0, cols).skip(skip).take(take).enumerate() {
            let row_index = skip.saturating_add(i).min(u16::MAX as usize) as u16;
            let wrapped = screen.row_wrapped(row_index);
            recs.push((text, wrapped));
        }
    }

    // Unconditional, with no `?` between the set and the restore: reading must never move the user's
    // own scrollback view.
    screen.set_scrollback(saved);

    while recs.last().is_some_and(|(t, _)| t.trim().is_empty()) {
        recs.pop();
    }

    let mut out = String::new();
    let mut line = String::new();
    for (text, wrapped) in recs {
        line.push_str(&text);
        if !wrapped {
            out.push_str(line.trim_end());
            out.push('\n');
            line.clear();
        }
    }
    if !line.trim().is_empty() {
        out.push_str(line.trim_end());
        out.push('\n');
    }
    out
}

/// Run a screen walk with the parser mutex held, without letting a panic in the walk poison it.
///
/// The guard lives in the CALLER's frame and the unwind is caught here, so the guard drops normally
/// and the mutex is never poisoned. The scrollback offset is restored in **both** arms — a walk that
/// panicked half-way through paging would otherwise leave the user's view scrolled to an arbitrary
/// position, which is visible and permanent.
///
/// Returns `None` when the walk panicked: no text is not the same as empty text, and the engine
/// treats it the way it treats a terminal that is not live — no evaluation, no log line.
pub fn tail_text_with<F>(screen: &mut vt100::Screen, walk: F) -> Option<String>
where
    F: FnOnce(&mut vt100::Screen) -> String,
{
    let saved = screen.scrollback();
    let walked = {
        let reborrow = &mut *screen;
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || walk(reborrow)))
    };
    screen.set_scrollback(saved);
    match walked {
        Ok(text) => Some(text),
        Err(_) => {
            log::warn!("render_tail_lines panicked; the terminal's parser is intact and the read is skipped");
            None
        }
    }
}

impl<R: tauri::Runtime> crate::automation_engine::eval::ScreenSource for AppState<R> {
    fn tail(
        &self,
        process_id: &str,
        depth: crate::automation_engine::eval::ReadDepth,
    ) -> Option<String> {
        self.screen_tail_text(process_id, depth)
    }
}

#[cfg(test)]
mod tail_read_tests {
    use super::{render_tail_lines, tail_text_with, tail_windows};
    use std::sync::Mutex;

    fn parser(rows: u16, cols: u16) -> vt100::Parser {
        vt100::Parser::new(rows, cols, super::SCROLLBACK_LINES)
    }

    /// §10.1 — the last `max_lines` lines, in order, as plain text.
    ///
    /// Fed WITHOUT a trailing newline so the bottom row holds `line 500` and the buffer has no unused
    /// rows: "exactly the last 200" is then literally checkable rather than approximately.
    #[test]
    fn render_tail_lines_returns_exactly_the_last_lines_in_order() {
        let mut p = parser(24, 80);
        let body: Vec<String> = (1..=500).map(|i| format!("line {}", i)).collect();
        p.process(body.join("\r\n").as_bytes());

        let text = render_tail_lines(p.screen_mut(), 200);
        let got: Vec<&str> = text.lines().collect();
        assert_eq!(got.len(), 200, "exactly `max_lines` rows");
        assert_eq!(got.first().copied(), Some("line 301"));
        assert_eq!(got.last().copied(), Some("line 500"));
        for (i, line) in got.iter().enumerate() {
            assert_eq!(*line, format!("line {}", 301 + i), "out of order at {}", i);
        }
    }

    /// A buffer shorter than the window returns everything it has, not a padded 200.
    #[test]
    fn a_short_buffer_returns_only_what_it_holds() {
        let mut p = parser(24, 80);
        p.process(b"alpha\r\nbeta\r\ngamma");
        let text = render_tail_lines(p.screen_mut(), 200);
        assert_eq!(text.lines().collect::<Vec<_>>(), vec!["alpha", "beta", "gamma"]);
    }

    /// The unused bottom of the visible screen is not 20 empty lines of "output".
    #[test]
    fn trailing_blank_rows_are_dropped() {
        let mut p = parser(24, 80);
        p.process(b"only line\r\n");
        let text = render_tail_lines(p.screen_mut(), 200);
        assert_eq!(text, "only line\n");
    }

    /// §10.2 — soft-wrap join. A value straddling the last column matches only when the rows are
    /// joined, which is the entire reason `row_wrapped` is consulted.
    #[test]
    fn a_soft_wrapped_value_is_joined_and_matches() {
        let mut p = parser(10, 20);
        // 18 characters, then `ctx:63%` - the value straddles column 20.
        p.process(b"..................ctx:63%");
        let joined = render_tail_lines(p.screen_mut(), 200);
        assert!(joined.contains("ctx:63%"), "wrapped rows must be joined: {:?}", joined);
        assert_eq!(joined.lines().count(), 1, "one logical line, not two physical rows");
    }

    /// The counterpart: a HARD line break at the same place must NOT be joined, or every rule would
    /// match across unrelated lines.
    #[test]
    fn a_hard_line_break_is_not_joined() {
        let mut p = parser(10, 20);
        p.process(b"..................ct\r\nx:63%");
        let text = render_tail_lines(p.screen_mut(), 200);
        assert!(!text.contains("ctx:63%"), "a hard break is a real line end: {:?}", text);
        assert_eq!(text.lines().count(), 2);
    }

    /// The user's own scrollback position is not a thing a background read may move.
    #[test]
    fn the_scrollback_offset_is_restored() {
        let mut p = parser(10, 40);
        for i in 0..200 {
            p.process(format!("line {}\r\n", i).as_bytes());
        }
        p.screen_mut().set_scrollback(37);
        let before = p.screen().scrollback();
        assert_eq!(before, 37, "premise: the view is scrolled");
        let _ = render_tail_lines(p.screen_mut(), 50);
        assert_eq!(p.screen().scrollback(), 37, "the walk moved the user's view");
    }

    /// §2.2's ruling, second half: a panicking walk must leave the parser USABLE. Without the catch,
    /// the mutex is poisoned and `feed_screen` then drops that terminal's bytes for the life of the
    /// process - no snapshot, no persist, no hydration.
    #[test]
    fn a_panicking_walk_neither_poisons_the_mutex_nor_moves_the_view() {
        let cell = Mutex::new(parser(10, 40));
        {
            let mut guard = cell.lock().expect("fresh mutex");
            // Enough lines to HAVE a scrollback: `set_scrollback` clamps to what exists, so a short
            // buffer would leave the offset at 0 and the restore assertion below could not fail.
            for i in 0..40 {
                guard.process(format!("before {}\r\n", i).as_bytes());
            }
            guard.screen_mut().set_scrollback(3);
            assert_eq!(guard.screen().scrollback(), 3, "premise: the view is genuinely scrolled");
            let out = tail_text_with(guard.screen_mut(), |screen| {
                // Move the view, THEN fail - the state a naive walk would leave behind.
                screen.set_scrollback(9);
                panic!("stub walk");
            });
            assert_eq!(out, None, "a panicked walk yields no text, never empty text");
            assert_eq!(guard.screen().scrollback(), 3, "the view was restored on the error path");
        }
        // The guard dropped normally because the unwind was caught in the inner frame.
        let mut guard = cell.lock().expect("the parser mutex must not be poisoned");
        guard.process(b"after\r\n");
        // The view is still parked three rows back — which is the point of the restore above — so
        // look at the LIVE screen to see whether the bytes actually landed.
        guard.screen_mut().set_scrollback(0);
        assert!(
            guard.screen().contents().contains("after"),
            "the parser must still accept feed_screen"
        );
    }

    /// §10.1's third clause, checked against the plan rather than the clock: whatever the buffer
    /// depth, a tail read visits at most `max_lines + rows` rows.
    #[test]
    fn a_tail_read_never_visits_more_than_max_lines_plus_one_screen() {
        for total_sb in [0usize, 1, 23, 199, 200, 201, 5_000, 50_000] {
            for rows in [1usize, 2, 24, 50] {
                for max_lines in [1usize, 200] {
                    let plan = tail_windows(total_sb, rows, max_lines);
                    let visited: usize = plan.iter().map(|(_, skip, take)| skip + take).sum();
                    let taken: usize = plan.iter().map(|(_, _, take)| take).sum();
                    assert!(
                        visited <= max_lines + rows,
                        "sb={} rows={} max={} visited {} rows",
                        total_sb, rows, max_lines, visited
                    );
                    assert_eq!(
                        taken,
                        max_lines.min(total_sb + rows),
                        "sb={} rows={} max={}",
                        total_sb, rows, max_lines
                    );
                }
            }
        }
    }

    /// The plan tiles the buffer with no overlap and no gap - the property that keeps the returned
    /// lines contiguous and in order.
    #[test]
    fn the_paging_plan_tiles_the_tail_exactly_once() {
        let (total_sb, rows, max_lines) = (500usize, 24usize, 200usize);
        let total = total_sb + rows;
        let mut expected = total - max_lines;
        for (offset, skip, take) in tail_windows(total_sb, rows, max_lines) {
            let window_first = total - rows - offset;
            assert_eq!(window_first + skip, expected, "gap or overlap at offset {}", offset);
            assert!(skip + take <= rows, "a window cannot yield more rows than it has");
            expected += take;
        }
        assert_eq!(expected, total, "the plan must reach the end of the buffer");
    }

    /// A zero-row screen cannot be paged, and must not loop forever trying.
    #[test]
    fn a_degenerate_screen_yields_an_empty_plan() {
        assert!(tail_windows(0, 0, 200).is_empty());
        assert!(tail_windows(500, 24, 0).is_empty());
    }
}

/// §10.4c — the half of the restart guard that only a Linux CI run could otherwise check.
///
/// `cleanup_terminal_state` takes a PROCESS id and the engine keys its state by the durable LEAF, so
/// the leaf has to be read out of `terminals` before this function removes it and before `identity`
/// is unindexed. Get that order wrong and the purge silently does nothing — invisibly, because the
/// symptom is a restarted terminal that is never nagged again rather than an error. §10.4 proves it
/// at runtime and needs an `AppHandle`; asserting it in source keeps it honest on Windows too.
#[cfg(test)]
mod automation_teardown_source_tests {
    /// The body of `cleanup_terminal_state`, from its signature to the first line that closes a block
    /// at method indentation.
    ///
    /// **Normalised, because a Windows checkout is CRLF** (`core.autocrlf=true`, no `.gitattributes`)
    /// and every slice below is newline delimited. Without it `find("\n    }\n")` returns `None` on
    /// the file git actually checks out and this whole module panics — so the only Windows-runnable
    /// pin on the `tm-`/`pc-` teardown order would be dead exactly where it is needed, §10.4 being
    /// `[int]`/Linux-only. This file's own `source()` below carries the same line, as do three sites
    /// in `canvas_endpoints.rs`; this was the one place in that class still missing it, and it read
    /// green only because M2 rewrote this file in the working tree.
    fn cleanup_body() -> String {
        let source = include_str!("state.rs").replace("\r\n", "\n");
        let start = source
            .find("pub fn cleanup_terminal_state(&self, id: &str) {")
            .expect("cleanup_terminal_state must exist");
        let rest = &source[start..];
        let end = rest.find("\n    }\n").expect("its body must be closed at method indentation");
        let body = rest[..end].to_string();
        // Vacuity guard: if that marker ever moved, the slice would swallow the rest of the file and
        // every ordering assertion below would pass against unrelated code.
        assert!(
            !body.contains("\n    pub fn "),
            "cleanup_body over-ran the end of the method — the assertions below would be vacuous"
        );
        body
    }

    #[test]
    fn the_leaf_is_captured_before_terminals_and_identity_are_torn_down() {
        let body = cleanup_body();
        let capture = body
            .find("renderer_terminal_id")
            .expect("the leaf must be read out of `terminals` here");
        let forget = body
            .find("forget_terminal")
            .expect("a closing terminal must purge the engine's per-leaf state");
        let unindex = body
            .find("self.identity.unindex(id)")
            .expect("identity is unindexed here");
        let remove = body
            .find("self.terminals.remove(id)")
            .expect("the terminal is removed here");

        assert!(capture < remove, "the leaf must be read BEFORE `terminals.remove`");
        assert!(capture < unindex, "the leaf must be read BEFORE `identity.unindex`");
        assert!(forget < remove, "and spent before the maps it came from are gone");
        assert!(forget < unindex);
    }

    /// The `test-arrange-right-assert-blind` guard: ordering says nothing about WHICH id was passed,
    /// and forwarding the process id is the mistake this whole arrangement exists to prevent.
    #[test]
    fn forget_terminal_is_given_the_leaf_and_forget_process_is_given_the_process_id() {
        let body = cleanup_body();
        assert!(
            body.contains("forget_terminal(&leaf)"),
            "`forget_terminal` is `tm-`keyed and must be handed the captured leaf"
        );
        for wrong in ["forget_terminal(id)", "forget_terminal(&id)", "forget_terminal(process_id)"] {
            assert!(
                !body.contains(wrong),
                "`{}` hands a `pc-` id to a `tm-`keyed map — it would purge nothing",
                wrong
            );
        }
        assert!(
            body.contains("forget_process(id)"),
            "`dirty` is `pc-`keyed and must be purged with the id this function was given"
        );
        assert!(
            !body.contains("forget_process(&leaf)"),
            "handing the leaf to the `pc-`keyed purge would leave the terminal permanently dirty"
        );
    }
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
    use super::pick_window_label;

    #[test]
    fn default_active_window_is_main() {
        assert_eq!(super::DEFAULT_ACTIVE_WINDOW, "main");
    }

    #[test]
    fn prefers_the_chosen_label_when_it_is_still_live() {
        let live = ["main", "window-2"];
        assert_eq!(pick_window_label("window-2", "", &live), "window-2");
    }

    #[test]
    fn falls_back_to_the_boot_window_when_chosen_is_excluded() {
        // The window mid-close is passed as `exclude` because it can still appear
        // in the live set when this runs from its own destroy handler.
        let live = ["main", "window-2"];
        assert_eq!(pick_window_label("window-2", "window-2", &live), "main");
    }

    #[test]
    fn promotes_the_first_other_live_window_when_the_boot_window_is_also_gone() {
        // The exact edge case reported by the user: open a second window, close
        // the first (the boot window) — the survivor becomes the new choice.
        let live = ["window-2"];
        assert_eq!(pick_window_label("main", "main", &live), "window-2");
    }

    #[test]
    fn drag_preview_is_never_a_candidate() {
        let live = ["drag-preview"];
        assert_eq!(pick_window_label("main", "main", &live), "main");
    }

    #[test]
    fn defaults_to_the_boot_window_label_when_nothing_is_live() {
        let live: [&str; 0] = [];
        assert_eq!(pick_window_label("window-2", "window-2", &live), "main");
    }

    #[test]
    fn a_chosen_label_that_matches_exclude_falls_through_even_when_the_map_still_lists_it() {
        // Mirrors the real destroy-handler race this function exists for: the
        // closing window can still be present in `webview_windows()` when this
        // runs, so `exclude` — not map membership — must be what disqualifies it.
        let live = ["main", "window-2"];
        assert_eq!(pick_window_label("main", "main", &live), "window-2");
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

    /// Load-bearing for the ED3 resize-wipe repair fix (docs/superpowers/specs/
    /// 2026-07-24-protocol-state-and-resize-wipe-fixes-design.md): codex answers a
    /// resize with `ESC[2J ESC[3J` then re-emits its own retained transcript
    /// (capped at ~1000 lines). xterm.js treats `3J` as "erase scrollback buffer"
    /// and wipes everything the client accumulated beyond that cap. This proves
    /// the Rust-side vt100 parser does NOT: content that already scrolled into
    /// genuine history before the clear survives `2J`/`3J` (standard ED2
    /// semantics — erase only touches the currently visible grid); only the last
    /// visible page at the moment of the clear is lost, identically on both
    /// sides, which is expected/unavoidable and not part of this bug.
    #[test]
    fn full_scrollback_survives_2j_3j_for_already_scrolled_history() {
        let mut p = vt100::Parser::new(24, 80, 1000);
        for i in 0..100 {
            p.process(format!("line-{:04}\r\n", i).as_bytes());
        }
        // codex's exact resize-response sequence, then a short re-emit.
        p.process(b"\x1b[2J\x1b[3J");
        p.process(b"codex reprint\r\n");

        let blob = render_full_scrollback(p.screen_mut()).expect("nonblank");
        let text = String::from_utf8_lossy(&blob);

        assert!(
            text.contains("line-0001"),
            "already-scrolled-off history must survive codex's 2J/3J, got:\n{text}"
        );
        assert!(
            text.contains("codex reprint"),
            "codex's post-clear re-emit must be present, got:\n{text}"
        );
        // line-0099 was still on the visible screen at the moment of the 2J — its
        // loss is the standard, unavoidable "clear the current page" behavior,
        // not the bug this fix targets. Pinned here so a future vt100 upgrade
        // that changed this wouldn't silently invalidate the assumption above.
        assert!(
            !text.contains("line-0099"),
            "the last visible page at clear-time is expected to be lost, got:\n{text}"
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

/// One in-place reattach decision produced by [`plan_reattach`].
#[derive(Debug, PartialEq, Eq)]
pub struct ReattachAction {
    pub tab_id: String,
    pub from_offset: u64,
}

/// Decide, per previously host-owned tab, whether to reattach in place (session
/// still held by the reconnected host) and from which ring offset, or tear down
/// (session gone). Pure so the sleep/wake recovery policy is unit-testable.
pub fn plan_reattach(
    tabs: &[String],
    sessions: &[termflow_pty_protocol::SessionMeta],
    saved_offsets: &std::collections::HashMap<String, u64>,
) -> (Vec<ReattachAction>, Vec<String>) {
    let mut reattach = Vec::new();
    let mut teardown = Vec::new();
    for tab in tabs {
        match sessions.iter().find(|m| &m.tab_id == tab) {
            Some(meta) => {
                // No saved offset (never saw a byte this app-lifetime) ⇒ replay
                // the whole ring. A saved offset PAST the ring tail can only
                // mean the saved value belongs to a different session identity
                // (stale entry for a reused id) — resuming from the tail would
                // silently skip everything the real session produced, so treat
                // it as a discontinuity and replay from zero instead.
                let saved = saved_offsets.get(tab).copied().unwrap_or(0);
                let from = if saved > meta.tail_offset { 0 } else { saved };
                reattach.push(ReattachAction {
                    tab_id: tab.clone(),
                    from_offset: from,
                });
            }
            None => teardown.push(tab.clone()),
        }
    }
    (reattach, teardown)
}

/// The reported bug: `armed_deadline` (pty-host/src/manager.rs) is set once
/// before an update/offload exit and nothing on the success path ever clears
/// it, so a completely normal quit LATER — after the user reopened, saw a
/// correct reattach, and simply chose Exit — still Holds instead of tearing
/// down, and the next launch reattaches a session the user already ended.
/// Asserted from source: `ensure_pty_host_inner` needs a live pty-host over a
/// real pipe/socket to exercise for real, which a unit-test process can't
/// stand up (the `integration-tests` feature `mock_app` needs breaks the
/// Windows test binary).
#[cfg(test)]
mod arm_lifecycle_wiring_tests {
    /// The body of `fn <name>`, found by counting braces from its opening `{`.
    fn fn_body(src: &str, signature: &str) -> String {
        let start = src
            .find(signature)
            .unwrap_or_else(|| panic!("`{signature}` not found — this guard must fail loudly, not pass vacuously"));
        let rest = &src[start..];
        let open = rest.find('{').expect("no body");
        let mut depth = 0usize;
        for (i, c) in rest[open..].char_indices() {
            match c {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return rest[open..open + i + 1].to_string();
                    }
                }
                _ => {}
            }
        }
        panic!("unbalanced braces after `{signature}`");
    }

    fn source() -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("state.rs");
        std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("cannot read {} ({e})", path.display()))
            .replace("\r\n", "\n")
    }

    /// Every successful (re)connect must release whatever armed this host —
    /// our own prior exit, or a sibling's update — because a live GUI just
    /// adopted its sessions and the GUI-less hold is no longer needed.
    #[test]
    fn a_successful_connect_disarms_the_host_it_adopted() {
        let body = fn_body(&source(), "async fn ensure_pty_host_inner");
        assert!(
            body.contains("client.disarm()"),
            "ensure_pty_host_inner must disarm the host once connected — \
             otherwise an arm from a past update/offload outlives the update \
             it was for. Body:\n{body}"
        );
    }
}

#[cfg(test)]
mod reattach_plan_tests {
    use super::{plan_reattach, ReattachAction};
    use std::collections::HashMap;
    use termflow_pty_protocol::SessionMeta;

    fn meta(tab: &str, head: u64, tail: u64) -> SessionMeta {
        SessionMeta {
            tab_id: tab.into(),
            pid: 1234,
            head_offset: head,
            tail_offset: tail,
            alive: true,
        }
    }

    #[test]
    fn held_session_reattaches_from_saved_offset() {
        let tabs = vec!["t1".to_string()];
        let sessions = vec![meta("t1", 0, 500)];
        let saved = HashMap::from([("t1".to_string(), 320u64)]);
        let (reattach, teardown) = plan_reattach(&tabs, &sessions, &saved);
        assert_eq!(
            reattach,
            vec![ReattachAction { tab_id: "t1".into(), from_offset: 320 }]
        );
        assert!(teardown.is_empty());
    }

    #[test]
    fn missing_session_is_torn_down() {
        let tabs = vec!["t1".to_string(), "t2".to_string()];
        let sessions = vec![meta("t2", 0, 10)];
        let (reattach, teardown) = plan_reattach(&tabs, &sessions, &HashMap::new());
        assert_eq!(reattach.len(), 1, "t2 survives");
        assert_eq!(teardown, vec!["t1".to_string()], "t1 is gone from the host");
    }

    #[test]
    fn no_saved_offset_replays_whole_ring() {
        let tabs = vec!["t1".to_string()];
        let sessions = vec![meta("t1", 100, 900)];
        let (reattach, _) = plan_reattach(&tabs, &sessions, &HashMap::new());
        assert_eq!(reattach[0].from_offset, 0, "full replay (host gaps if evicted)");
    }

    /// A saved offset beyond the ring tail is a stale-identity signal (reused
    /// id), NOT a resume point — clamping to tail would silently drop all of
    /// the real session's output, so it must replay from zero.
    #[test]
    fn future_offset_is_a_discontinuity_and_replays_from_zero() {
        let tabs = vec!["t1".to_string()];
        let sessions = vec![meta("t1", 0, 50)];
        let saved = HashMap::from([("t1".to_string(), 5000u64)]);
        let (reattach, _) = plan_reattach(&tabs, &sessions, &saved);
        assert_eq!(reattach[0].from_offset, 0);
    }

    #[test]
    fn saved_offset_at_or_below_tail_is_used_as_is() {
        let tabs = vec!["t1".to_string()];
        let sessions = vec![meta("t1", 0, 50)];
        let saved = HashMap::from([("t1".to_string(), 50u64)]);
        let (reattach, _) = plan_reattach(&tabs, &sessions, &saved);
        assert_eq!(reattach[0].from_offset, 50, "exactly-at-tail resumes with no replay");
    }

    #[test]
    fn zombie_sessions_unknown_to_the_gui_are_left_untouched() {
        // Sessions the host holds but no tab owns must appear in NEITHER list —
        // adoption/pending handles them, not the pipe-drop recovery.
        let tabs = vec!["t1".to_string()];
        let sessions = vec![meta("t1", 0, 10), meta("zombie", 0, 10)];
        let (reattach, teardown) = plan_reattach(&tabs, &sessions, &HashMap::new());
        assert_eq!(reattach.len(), 1);
        assert!(teardown.is_empty());
    }
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

/* ---- A host-owned close must ANNOUNCE itself ------------------------------
 *
 * Reported from live use: a terminal closed over the API/MCP left its pane sitting there
 * with a dead shell — no "Session closed" banner, no ended tint, no tab-exit mark.
 *
 * The sidecar does report the close, but its `Exit` frame lands ~a second later, after the
 * caller's `cleanup_terminal_state` has run `identity.unindex`; `route_inbound` then cannot
 * resolve the session key and drops it. So the ONLY announcement is the one `host_close`
 * makes itself. Nothing else in the chain can be asserted from here — `host_close` takes
 * `&AppState`, which needs a real `AppHandle<Wry>` under the unit-test binary (see the
 * `integration-tests` gate) — so the wiring is read from the source text, exactly as
 * `canvas_endpoints`' liveness-filter guard does, and the payload itself is a free function
 * precisely so it can be tested for real.
 */
#[cfg(test)]
mod host_close_announces_tests {
    use super::host_exit_payload;

    #[test]
    fn payload_is_keyed_by_the_process_id_not_the_session_key() {
        let p = host_exit_payload("pc-abc123", None);
        assert_eq!(p["id"], "pc-abc123");
    }

    /// The renderer's `TerminalService` maps this id back through its
    /// `terminalId -> process` table. A session key resolves to nothing there, so the exit
    /// would reach no pane — a silent no-op indistinguishable from the bug being fixed.
    #[test]
    fn a_session_key_is_never_substituted_for_the_process_id() {
        let p = host_exit_payload("pc-abc123", None);
        assert_ne!(p["id"], "tm-abc123", "a leaf/session key here reaches no pane");
    }

    /// Spec 045 §3.3: the directory the shell died in is what a restart-in-place resumes in,
    /// and the pane SURVIVES an API close — so unlike the UI close path this is not
    /// throwaway. `null` when unknown, which `setCwdSnapshot` ignores rather than erasing.
    #[test]
    fn the_cwd_travels_and_is_null_when_unknown() {
        assert_eq!(host_exit_payload("pc-1", Some("D:\\work".into()))["cwd"], "D:\\work");
        assert!(host_exit_payload("pc-1", None)["cwd"].is_null());
    }

    /// Parity with `pty_manager`'s in-process emit is the point of the whole fix: the two
    /// paths must be the same event to the renderer. `0` also keeps `TabManager`'s
    /// "already exited cleanly, skip the confirm" check working on an API-closed tab.
    #[test]
    fn the_exit_code_matches_the_in_process_emit() {
        assert_eq!(host_exit_payload("pc-1", None)["exitCode"], 0);
    }

    /// Normalised: this checkout is CRLF and every slice below is newline delimited.
    fn source() -> String {
        include_str!("state.rs").replace("\r\n", "\n")
    }

    /// One method body, from its signature to the `}` that closes it at impl indent.
    fn body_of(name: &str) -> String {
        let src = source();
        let sig = format!("pub fn {name}(");
        let at = src
            .find(&sig)
            .unwrap_or_else(|| panic!("no fn {name} — it moved or was renamed"));
        let rest = &src[at..];
        let end = rest.find("\n    }\n").map(|i| i + 7).unwrap_or(rest.len());
        rest[..end].to_string()
    }

    /// Or every assertion below is about an empty string.
    #[test]
    fn found_the_method_it_is_reading() {
        assert!(body_of("host_close").contains("host_close_pending"));
    }

    /// An over-long slice makes "host_close emits" a statement about the rest of the file —
    /// `teardown_host_terminal` emits `terminal:exit` too, so this would pass with the call
    /// deleted.
    #[test]
    fn the_slice_is_one_method_and_not_the_rest_of_the_file() {
        let body = body_of("host_close");
        assert!(!body.contains("pub fn host_repaint"), "slice ran past host_close");
        assert!(body.len() < 4000, "slice is suspiciously long: {} bytes", body.len());
    }

    /// THE regression. Without this line an API/MCP close is silent.
    #[test]
    fn host_close_emits_terminal_exit() {
        let body = body_of("host_close");
        assert!(
            body.contains("\"terminal:exit\""),
            "host_close must announce the close — the sidecar's own Exit frame is dropped \
             by route_inbound once the caller unindexes the session"
        );
        assert!(body.contains("host_exit_payload("), "must use the shared payload shape");
    }

    /// On BOTH branches. A close that could not reach the host is still a close as far as
    /// this GUI is concerned — its state is torn down either way — so an emit tucked inside
    /// the live-client arm would leave the pipe-down case silent.
    #[test]
    fn the_emit_is_after_the_match_so_a_queued_close_announces_too() {
        let body = body_of("host_close");
        let queued = body.find("host_close_pending.insert").expect("pipe-down arm gone");
        let emit = body.find("\"terminal:exit\"").expect("emit gone");
        assert!(emit > queued, "the emit sits inside the live-client arm; a queued close would be silent");
    }
}
