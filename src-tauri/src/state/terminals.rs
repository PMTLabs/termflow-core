use dashmap::DashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::path::PathBuf;
use tokio::sync::broadcast;
use parking_lot::RwLock;
use crate::event_bus::{EventBus, ActivityTracker};
use crate::recording_service::RecordingService;
use crate::search_service::SearchService;
use crate::layout_manager::LayoutManager;
use crate::tmux_manager::TerminalBackend;
use tauri::{AppHandle, Runtime};
use std::sync::Mutex;
use super::render::{FocusReportingTracker, render_full_scrollback, render_tail_lines, tail_text_with};
use super::reattach::plan_reattach;
use super::types::*;
use super::host_registry;
use crate::elevated_host::{FrozenId, HostChannel};

fn restore_sweep_may_release(pending_windows: usize, already_released: bool) -> bool {
    pending_windows == 0 && !already_released
}

/// What the 60 s sweep does at a tick. The sweep is the periodic retry for hosts
/// and sessions that were not reachable at start-up (the router retries creates
/// on its own), so it must outlive anything that is merely *trying* to exit: an
/// update that backs out clears the `exiting` mark its own flush set. A Quit never
/// clears the mark; only the sticky exit quiesce means the process is going away
/// for good.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SweepTick {
    Run,
    /// An exit may be under way: leave this tick alone, look again at the next.
    Skip,
    Stop,
}

pub(super) fn sweep_tick(exiting: bool, lifecycle: Option<super::host_table::QuiesceReason>) -> SweepTick {
    if lifecycle == Some(super::host_table::QuiesceReason::Exit) {
        SweepTick::Stop
    } else if exiting {
        SweepTick::Skip
    } else {
        SweepTick::Run
    }
}

/// May a claimed sweep KEEP the one-shot flag? Only a sweep that actually ran
/// to completion. Claiming the flag and then failing — no host, no client, an
/// unanswered listing — used to consume the only sweep there will ever be: the
/// 60s backstop tests this same flag, so it could not rescue it either, and a
/// live session no restored tab claims stayed invisible for the whole GUI
/// lifetime. That is precisely the leak the sweep exists to close.
fn sweep_claim_survives(completed: bool) -> bool {
    completed
}

/// Reconcile a host answer with the ownership that existed before asking for it.
/// Ownership observed after the answer was built can suppress recovery of an
/// orphan, but cannot prove that the older answer killed that new terminal.
pub(super) fn plan_reconnect(
    teardown_tabs: &[String],
    sessions: &[termflow_pty_protocol::SessionMeta],
    saved_offsets: &std::collections::HashMap<String, u64>,
    current_owned_sessions: impl IntoIterator<Item = String>,
) -> super::reattach::ReattachPlan {
    let current_owned_sessions = current_owned_sessions.into_iter().collect::<std::collections::HashSet<_>>();
    let mut plan = plan_reattach(teardown_tabs, sessions, saved_offsets);
    plan.orphans.retain(|orphan| !current_owned_sessions.contains(&orphan.tab_id));
    plan
}

#[cfg(test)]
pub(super) fn session_needs_surface(is_registered: bool) -> bool { !is_registered }

pub const HOST_SESSION_CONTENDED: &str = "host-session-contended";

#[cfg(test)]
mod restore_sweep_gate_tests {
    use super::restore_sweep_may_release;

    #[test]
    fn waits_for_every_window_then_releases_when_last_is_destroyed() {
        assert!(!restore_sweep_may_release(1, false));
        assert!(restore_sweep_may_release(0, false));
    }

    #[test]
    fn the_sweep_survives_an_exit_that_is_only_being_attempted() {
        use super::{sweep_tick, SweepTick};
        use crate::state::QuiesceReason;
        assert_eq!(sweep_tick(false, None), SweepTick::Run);
        // A flush that may yet be abandoned (an update that backs out) or a quit in
        // progress: this tick is skipped, the next one looks again.
        assert_eq!(sweep_tick(true, None), SweepTick::Skip);
        assert_eq!(sweep_tick(true, Some(QuiesceReason::Update)), SweepTick::Skip);
        assert_eq!(sweep_tick(false, Some(QuiesceReason::Update)), SweepTick::Run);
        // Only the sticky exit quiesce ends it, whatever the flag says.
        assert_eq!(sweep_tick(false, Some(QuiesceReason::Exit)), SweepTick::Stop);
        assert_eq!(sweep_tick(true, Some(QuiesceReason::Exit)), SweepTick::Stop);
    }

    #[test]
    fn a_released_sweep_never_releases_twice() {
        assert!(!restore_sweep_may_release(0, true));
    }

    #[test]
    fn only_a_completed_sweep_consumes_the_one_shot() {
        assert!(super::sweep_claim_survives(true));
        assert!(
            !super::sweep_claim_survives(false),
            "an incomplete sweep must hand the flag back: the backstop reads it too, \
             so consuming it here strands an unclaimed live session for good"
        );
    }

    #[test]
    fn terminal_registered_after_list_snapshot_is_neither_torn_down_nor_an_orphan() {
        let old_tab = "present-when-list-was-issued".to_string();
        let new_tab = "registered-after-host-captured-list".to_string();
        let listed_orphan = termflow_pty_protocol::SessionMeta {
            tab_id: "unowned-host-session".into(), pid: 17, head_offset: 0, tail_offset: 4, alive: true,
        };
        let plan = super::plan_reconnect(
            &[old_tab.clone()],
            &[listed_orphan.clone()],
            &std::collections::HashMap::new(),
            [old_tab, new_tab.clone()],
        );
        assert_eq!(plan.teardown, vec!["present-when-list-was-issued"], "only pre-request ownership can be destructively reconciled");
        assert_eq!(plan.orphans, vec![listed_orphan], "the fresh snapshot only suppresses already-owned host sessions");
        assert!(!plan.teardown.contains(&new_tab), "a terminal absent from the older host answer was created too late to be declared dead");
        assert!(!plan.orphans.iter().any(|session| session.tab_id == new_tab), "the newly registered terminal is not surfaced as an orphan");
    }


    #[test]
    fn each_sweep_restates_unowned_sessions_but_never_registered_ones() {
        assert!(super::session_needs_surface(false), "rejects already-surfaced suppression: a dropped create event must be stated again on the next sweep");
        assert!(!super::session_needs_surface(true), "rejects a sweep that spams duplicate creates after registration wins");
    }

    #[test]
    fn surfaced_orphans_are_reserved_before_the_recovery_event_is_emitted() {
        let source = include_str!("host_adoption/panes.rs").replace("\r\n", "\n");
        let body = source
            .find("\npub(in crate::state) fn surface_orphans")
            .map(|start| &source[start..])
            .and_then(|rest| rest.split("/// Reconcile").next())
            .expect("surface_orphans body");
        let eligible = body.find(".keys().recover_listed(channel, &orphan.tab_id").expect("orphan must use the atomic listed-key recovery decision");
        let emit = body.find("port.announce_recovered(").expect("orphan must emit recovery event");
        assert!(eligible < emit, "listed-key qualification must precede recovery emission");
        let authority = crate::state::source_scan::production(include_str!("host_keys/effects.rs"));
        let decision = crate::state::source_scan::fn_body(&authority, "fn recover_listed(");
        let coalesce = decision.find("pending_deliveries.insert(").unwrap();
        assert!(decision.find("Some(&KeyState::Listed)").unwrap() < coalesce);
        assert!(coalesce < decision.find("delivery.send(Box::new(move ||").unwrap());
        assert!(decision.contains("let mut inner = self.lock()"));
    }

    #[test]
    fn host_claim_retirement_uses_atomic_owner_guard_at_every_site() {
        let source = include_str!("terminals.rs").replace("\r\n", "\n");
        let retirement = crate::state::source_scan::fn_body(&source, "pub fn retire_host_process(");
        assert!(retirement.contains("self.host_table.keys().exit_process(process_id)"));
        let keys = include_str!("host_keys.rs");
        let end = crate::state::source_scan::fn_body(keys, "pub fn exit_process(");
        assert!(end.contains("self.lock()") && end.contains("KeyState::Bound(process.to_string())"),
            "ending must check the stored process under the key mutex");
        let teardown = source
            .rfind("\n    pub fn teardown_host_terminal")
            .map(|start| &source[start..])
            .and_then(|rest| rest.split("    /// Reconnect to an already-running").next())
            .expect("teardown_host_terminal body");
        assert!(!teardown.contains("forget_host_session_claim("), "teardown must not bypass the owner guard");
        // An absence assertion alone goes vacuous the moment the call is deleted
        // outright — which would leak the claim and bring back the exit-then-Restart
        // refusal this retirement exists to prevent. Pin the presence too.
        assert!(
            teardown.contains("retire_host_process(id)"),
            "teardown must still retire the claim it owns"
        );
    }
}

impl<R: Runtime> AppState<R> {
    /// Exit cleanup is qualified by the exact process, never by a reused leaf.
    pub fn retire_host_process(&self, process_id: &str) {
        self.host_table.keys().exit_process(process_id);
    }

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
            local_processes: Arc::new(DashMap::new()),
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
            mcp_process: Arc::new(Mutex::new(crate::state::GenerationSlot::new())),
            fabric_process: Arc::new(Mutex::new(crate::state::GenerationSlot::new())),
            fabric_control_port: crate::app_config::resolve_fabric_control_port(),
            keep_running_in_background: Arc::new(AtomicBool::new(false)),
            exempt_loopback_from_proxy: Arc::new(AtomicBool::new(true)),
            network: Arc::new(RwLock::new(network)),
            effective_endpoints: Arc::new(RwLock::new(Default::default())),
            api_shutdown: Arc::new(Mutex::new(None)),
            network_op_lock: Arc::new(tokio::sync::Mutex::new(())),
            jwt_secret,
            app_handle,
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
            proc_snapshot: Arc::new(crate::automation::proc_snapshot::ProcSnapshot::new(
                crate::automation::proc_snapshot::SNAPSHOT_TTL_MS,
            )),
            canvas_nodes: Arc::new(RwLock::new(std::collections::HashMap::new())),
            history_dirty: Arc::new(DashMap::new()),
            replay_prefix: Arc::new(DashMap::new()),
            active_window: Arc::new(RwLock::new(DEFAULT_ACTIVE_WINDOW.to_string())),
            main_window: Arc::new(RwLock::new(DEFAULT_ACTIVE_WINDOW.to_string())),
            instance_id: uuid::Uuid::new_v4().to_string(),
            pty_host: Arc::new(Mutex::new(None)),
            host_terminals: Arc::new(DashMap::new()),
            frozen_hosts: Arc::new(Mutex::new(Vec::new())),
            frozen_host_seq: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            host_table: super::host_table::HostTable::new(),
            host_barrier: super::host_adoption::Barrier::new(),
            sibling_hold: Arc::default(),
            elevated_host: Arc::new(crate::elevated_host::ElevatedHost::new()),
            identity: crate::identity_index::IdentityIndex::new(),
            ids: super::IdAllocator::default(),
            host_restore_pending_windows: Arc::new(DashMap::new()),
            host_restore_released: Arc::new(AtomicBool::new(false)),
            reattach_prompt_hooks: Arc::new(DashMap::new()),
            pty_host_gen: Arc::new(AtomicU64::new(0)),
            pty_host_connecting: Arc::new(tokio::sync::Mutex::new(())),
            host_stream_offsets: Arc::new(DashMap::new()),
            host_recovering: Arc::new(tokio::sync::Mutex::new(())),
            duplicate_session_noticed: Arc::new(AtomicBool::new(false)),
            recovering: Arc::new(AtomicBool::new(false)),
            restart_in_flight: Arc::new(AtomicBool::new(false)),
            started_at: Arc::new(std::time::Instant::now()),
        }
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
        skip_typed_line: bool,
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
        tail_text_with(screen, |sc| render_tail_lines(sc, max_lines, skip_typed_line))
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
    /// replayable byte stream for the live ED3 repair (`/full_scrollback`, which
    /// keeps the cursor tail; persistence uses `persisted_scrollback_snapshot`) —
    /// soft-wrapped rows joined, no
    /// screen-clear, so 2J-cleared transient frames (full-screen TUIs) are excluded by
    /// construction. Returns None when the whole buffer is blank.
    ///
    /// The heavy O(scrollback) render runs on an OWNED clone of the screen taken under
    /// the lock, NOT while holding it: the single PTY output consumer contends on this
    /// same parser mutex (feed_screen), and holding it across a 5000-row render would
    /// stall output delivery for every terminal (see output-pipeline-architecture).
    pub fn full_scrollback_snapshot(&self, id: &str) -> Option<Vec<u8>> {
        self.render_scrollback(id, true)
    }

    /// The same dump WITHOUT the cursor-restore tail, for persistence.
    ///
    /// The tail is an ABSOLUTE `CUP` into the visible screen of a still-running
    /// program, which is only meaningful to a client that replays the blob into a
    /// terminal that program is live in (the ED3 repair). A persisted blob is
    /// replayed into a NEW session's xterm, where that position points into the
    /// middle of the just-drawn history: the "session restored" divider and the
    /// fresh shell's prompt were then painted over the old TUI's rows, and the
    /// cursor sat mid-screen until Ctrl+L. Seen with Claude Code: its last cursor sat
    /// above rows that replay below it. Any stored cursor jump INTO already replayed
    /// content does the same.
    pub fn persisted_scrollback_snapshot(&self, id: &str) -> Option<Vec<u8>> {
        self.render_scrollback(id, false)
    }

    fn render_scrollback(&self, id: &str, with_cursor: bool) -> Option<Vec<u8>> {
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
        if !with_cursor {
            return Some(blob);
        }
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


    /// True if `id`'s PTY is hosted by a sidecar (not local `ptys`/writers) —
    /// either the primary or the elevated one.
    pub fn is_host_owned(&self, id: &str) -> bool {
        self.host_terminals.contains_key(id)
    }

    /// Which sidecar (if any) serves `id`'s PTY.
    fn host_channel_for(&self, id: &str) -> Option<HostChannel> {
        self.host_terminals.get(id).map(|e| *e.value())
    }

    /// The connected client actually serving `channel` — the primary sidecar
    /// for `Primary`, the elevated sidecar for `Elevated`, the registered
    /// frozen host for `Frozen`. `None` when that sidecar is not currently
    /// connected (or a frozen host has been retired) — caller must surface the
    /// failure, never silently fall back to another one (plan 045 R7).
    fn client_for_channel(&self, channel: HostChannel) -> Option<crate::pty_host_client::PtyHostClient> {
        match channel {
            HostChannel::Primary => self.pty_host_clone(),
            HostChannel::Elevated => self.elevated_host.client_clone(),
            HostChannel::Frozen(id) => self.frozen_client(id),
        }
    }

    /// The SINGLE place `host_terminals` entries are ever removed (plan 045
    /// T4). Beyond removing, it derives the elevated sidecar's refcount: if
    /// the removed entry was `Elevated` and none remain, it tears the
    /// elevated connection down. A fifth call site that bypasses this and
    /// removes directly would silently stop that teardown from ever firing —
    /// `state::source_tests::host_terminals_is_only_removed_through_forget_host_terminal`
    /// pins that nothing else does.
    pub fn forget_host_terminal(&self, id: &str) {
        self.host_table.routes().remove_process(id);
        let Some((_, channel)) = self.host_terminals.remove(id) else {
            return;
        };
        self.notify_terminal_generations();
        if matches!(channel, HostChannel::Frozen(_)) {
            // The last pane of an older host is gone: let its retirement ticker
            // look at the host now instead of at its next tick.
            if !self.host_terminals.iter().any(|e| *e.value() == channel) {
                self.host_table.nudge_ticker(channel);
            }
            return;
        }
        if channel != HostChannel::Elevated {
            return;
        }
        let still_elevated = self
            .host_terminals
            .iter()
            .any(|e| *e.value() == HostChannel::Elevated);
        if still_elevated {
            return;
        }
        let elevated_host = self.elevated_host.clone();
        let table = self.host_table.clone();
        let Some(epoch) = elevated_host.client_clone().and_then(|c| c.session_epoch(HostChannel::Elevated)) else { return; };
        tauri::async_runtime::spawn(async move {
            elevated_host.shutdown_idle(&table, epoch).await;
        });
    }

    /// Lazily connect (spawning if needed) the current PTY-host sidecar client,
    /// wiring its inbound Stdout into the existing output broadcast and its
    /// Exit/Gap into cleanup+emit / repaint, and adopt every surviving host of an
    /// older generation beside it (`host_adoption`). Idempotent.
    ///
    /// Boxed: the on_disconnect closure built inside spawns a task that
    /// re-enters this function (reconnect_after_pipe_drop), which with an
    /// opaque `async fn` future is an infinite type cycle the compiler cannot
    /// prove `Send`. The erased (nominal) future breaks the cycle.
    pub fn ensure_pty_host(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + '_>>
    {
        Box::pin(super::host_adoption::ensure_hosts(self))
    }

    /// Re-run adoption for surviving hosts that were skipped, busy or never
    /// answered, whether or not the current host is up. Boxed like
    /// `ensure_pty_host`, and for the same reason.
    pub fn rediscover_hosts(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + '_>>
    {
        Box::pin(super::host_adoption::rediscover_hosts(self))
    }

    /// Lazily connect the elevated sidecar (plan 045), launching it via UAC on
    /// first use. Idempotent and single-flighted so two concurrent "Open admin
    /// Tab" clicks produce exactly one UAC prompt (`ElevatedHost::connecting`
    /// mirrors `pty_host_connecting`). Deliberately far simpler than
    /// `ensure_pty_host`: no discovery record, no adoption, no
    /// `list_sessions` — the elevated sidecar is always freshly launched, never
    /// a survivor from a prior run.
    ///
    /// Boxed for the same reason as `ensure_pty_host`: kept as a plain async fn
    /// it would need to be `Send`, and nothing here builds a self-referential
    /// future cycle, so this is a simpler box than that one's — but the crate
    /// convention (`ensure_pty_host`) is to expose these as boxed futures, and
    /// consistency here costs nothing.
    pub fn ensure_elevated_host(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + '_>>
    {
        Box::pin(async {
            let _guard = self.ensure_elevated_host_for_placement().await?;
            Ok(())
        })
    }

    pub(crate) async fn ensure_elevated_host_for_placement(&self) -> Result<tokio::sync::MutexGuard<'_, ()>, String> {
        self.elevated_host.ensure_for_placement(|| self.ensure_elevated_host_inner()).await
    }

    #[cfg(windows)]
    async fn ensure_elevated_host_inner(&self) -> Result<(), String> {
        if self.elevated_host.is_connected() {
            return Ok(());
        }
        // The caller retains connecting through setup and placement.
        // Re-checked here (not just trusted from the renderer's cached
        // `get_admin_tab_support` answer) so a stale or tampered renderer can
        // never drive an elevated spawn past this gate.
        let support = crate::commands::get_admin_tab_support();
        if !support.supported {
            return Err(format!("elevated tabs are not available ({})", support.reason));
        }

        let profile_key = crate::profile::current().info().key;
        let listener = crate::elevated_host::pipe_server::AdminPipeListener::create(&profile_key)
            .map_err(|e| format!("could not create the admin pipe: {e}"))?;

        // Fresh per launch, never the persisted `%TEMP%` token
        // (`pty_host_client::resolve_token`) and never written to disk — this
        // is a separate credential scoped to exactly one elevated launch.
        let token = uuid::Uuid::new_v4().simple().to_string();
        let log_path = crate::pty_host_client::runtime_host_dir()
            .map(|d| d.join("host-admin.log"))
            .unwrap_or_else(|| std::env::temp_dir().join("termflow-host-admin.log"));
        let parameters = crate::elevated_host::launch::build_dial_out_parameters(
            &listener.name,
            &token,
            &log_path,
        );

        log::info!("[ADMIN] requesting elevation for the admin-tab sidecar");
        let launched = match crate::elevated_host::launch::run_as(parameters).await {
            crate::elevated_host::launch::LaunchOutcome::Cancelled => {
                log::info!("[ADMIN] UAC prompt was denied; no admin tab will open");
                return Err(crate::elevated_host::ADMIN_UAC_CANCELLED.to_string());
            }
            crate::elevated_host::launch::LaunchOutcome::Failed(code) => {
                return Err(format!("could not launch the elevated pty-host (code {code})"));
            }
            crate::elevated_host::launch::LaunchOutcome::Ok(proc) => proc,
        };
        log::info!("[ADMIN] elevated pty-host launched (pid {})", launched.pid);
        if self.elevated_host.is_shutting_down() {
            drop(listener);
            self.elevated_host.wait_owned_process(Some(launched)).await;
            return Err("elevated terminal host is shutting down".into());
        }

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        let stream = match listener.accept_verified(launched.pid, deadline).await {
            Ok(s) => s,
            Err(e) => return Err(format!("elevated pty-host did not connect: {e}")),
        };
        log::info!("[ADMIN] elevated pty-host connected and verified (pid {})", launched.pid);

        let my_gen = self.elevated_host.bump_gen()?;
        let epoch = self.host_table.reserve_epoch()?;
        if !self.host_table.publish(HostChannel::Elevated, epoch) {
            return Err("elevated terminal host is not admitting sessions".to_string());
        }
        let (rd, wr) = tokio::io::split(stream);

        let st_exit = self.clone();
        let st_gap = self.clone();
        let st_resolve = self.clone();
        let st_disc = self.clone();
        let deps = crate::pty_host_client::PtyHostDeps {
            lifecycle_token: token.clone(),
            output_tx: self.output_tx.clone(),
            output_produced: self.output_produced.clone(),
            // Structurally identical to the primary's on_exit (persist, forget,
            // unindex, cleanup, emit) — kept as its own closure rather than
            // shared, so a change to one sidecar's exit handling can never
            // silently move the other's (see also `on_disconnect` below, which
            // is NOT identical: elevated never reconnects).
            on_exit: Arc::new(move |process_id: String, session_key: String, exit_cwd: Option<String>| {
                use tauri::Emitter;
                let cwd = exit_cwd
                    .or_else(|| st_exit.terminal_cwds.get(&process_id).map(|r| r.value().clone()));
                let _ = session_key;
                if !st_exit.exit_process(&process_id) { return; }
                let _ = st_exit.app_handle.emit(
                    "terminal:exit",
                    serde_json::json!({ "id": process_id, "exitCode": 0, "cwd": cwd }),
                );
                crate::console_window::unstick_all(&st_exit.app_handle);
            }),
            on_gap: Arc::new(move |process_id: String| {
                st_gap.host_repaint(&process_id);
            }),
            resolve_process: Arc::new(move |k: &str| host_registry::resolve_inbound(
                &st_resolve.host_terminals, &st_resolve.host_table, HostChannel::Elevated, epoch, k,
            )),
            // Plan 045 §5 / R6: the elevated channel is NEVER reconnected — a
            // held session recovering into a re-prompted or nonexistent UAC
            // flow would be worse than just ending it. Every terminal still
            // registered as `Elevated` ends exactly like a normal pty exit.
            on_disconnect: Arc::new(move || {
                if st_disc.elevated_host.current_gen() != my_gen {
                    return;
                }
                log::warn!(
                    "[ADMIN] elevated pty-host pipe dropped; ending its session(s) \
                     (no auto-relaunch, no re-prompt)"
                );
                let Some(elevated_ids) = st_disc.elevated_host.clear_client_on(epoch, || st_disc
                    .host_terminals.iter()
                    .filter(|e| *e.value() == HostChannel::Elevated)
                    .map(|e| e.key().clone()).collect::<Vec<String>>()) else { return; };
                st_disc.host_table.routes().remove_epoch(HostChannel::Elevated, epoch);
                for id in elevated_ids {
                    st_disc.teardown_host_terminal(&id);
                }
            }),
            // Shared with the primary sidecar: session keys are globally unique
            // `tm-`/`tb-` ids, so there is no collision between the two hosts'
            // entries in this map (plan 045 §4.1).
            stream_offsets: self.host_stream_offsets.clone(),
        };

        let client = crate::pty_host_client::wire_client(rd, wr, deps);
        client.bind_sessions(self.host_table.keys(), HostChannel::Elevated, epoch);
        self.elevated_host.publish(client, launched).await
    }

    #[cfg(not(windows))]
    async fn ensure_elevated_host_inner(&self) -> Result<(), String> {
        Err("elevated tabs are only supported on Windows".to_string())
    }

    /// Tear down one previously host-owned terminal that did NOT survive a pipe
    /// drop: persist its final parser state, clean up, and surface the closed-
    /// session banner. (Split out of the formerly-destructive on_disconnect.)
    pub fn teardown_host_terminal(&self, id: &str) {
        use tauri::Emitter;
        if !self.exit_process(id) { return; }
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
    ///
    /// Primary-only by design: an older host recovers from its own drop
    /// (`reconnect_frozen`), and an elevated session is never reconnected.
    pub async fn reconnect_after_pipe_drop(&self) {
        // Single-flight (see host_recovering): a second flap queues here and
        // re-snapshots offsets once the first pass is done.
        let _recover_guard = self.host_recovering.lock().await;
        // The legacy 7-step backoff.
        super::host_adoption::reconnect_primary(self, super::host_adoption::RECONNECT_BACKOFF_MS).await;
    }

    pub fn begin_host_restore_sweep(&self, windows: impl IntoIterator<Item = String>) {
        self.host_restore_pending_windows.clear();
        self.host_restore_released.store(false, Ordering::Release);
        for label in windows {
            self.host_restore_pending_windows.insert(label, ());
        }
        let state = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                match sweep_tick(state.exiting.load(Ordering::Acquire), state.host_table.lifecycle_reason()) {
                    SweepTick::Stop => break,
                    SweepTick::Skip => continue,
                    SweepTick::Run => {}
                }
                state.host_restore_released.store(false, Ordering::Release);
                state.release_host_restore_sweep(true).await;
            }
        });
    }

    pub async fn report_host_restore_settled(&self, window_label: String) {
        self.host_restore_pending_windows.remove(&window_label);
        if !restore_sweep_may_release(self.host_restore_pending_windows.len(), self.host_restore_released.load(Ordering::Acquire)) { return; }
        self.release_host_restore_sweep(false).await;
    }

    pub async fn host_restore_window_destroyed(&self, window_label: &str) {
        self.host_restore_pending_windows.remove(window_label);
        if restore_sweep_may_release(self.host_restore_pending_windows.len(), self.host_restore_released.load(Ordering::Acquire)) {
            self.release_host_restore_sweep(false).await;
        }
    }

    async fn release_host_restore_sweep(&self, forced: bool) {
        // Validate BEFORE claiming the flag. `swap` marks the sweep released
        // unconditionally, so claiming first and validating second lets a caller
        // that arrives while windows are still pending poison the flag: the real
        // release would return early until the periodic worker resets the flag
        // and forces another pass. The guard belongs at this choke point, not
        // in each caller.
        if !forced && !restore_sweep_may_release(self.host_restore_pending_windows.len(), false) { return; }
        if self.host_restore_released.swap(true, Ordering::AcqRel) { return; }
        if !sweep_claim_survives(self.run_host_restore_sweep().await) {
            // Hand the one-shot back so the backstop — or a later report — can
            // retry. The periodic worker also resets this flag before forcing
            // another pass after a transient failure.
            self.host_restore_released.store(false, Ordering::Release);
            log::warn!("[HOTSWAP] restore sweep could not complete; leaving it retryable");
        }
    }

    /// Runs the sweep over every host. `false` means it did NOT complete and must
    /// stay retryable.
    async fn run_host_restore_sweep(&self) -> bool {
        super::host_adoption::sweep(self).await
    }

    /// Surface live host sessions that no known tab claims, as the recovery flows
    /// do (they call the shared function directly). Only the integration tests
    /// drive it through an `AppState`.
    /// `channel` is the host whose listing reported `orphans`.
    #[cfg(all(test, feature = "integration-tests"))]
    pub(crate) fn surface_host_orphans(&self, orphans: Vec<termflow_pty_protocol::SessionMeta>, channel: HostChannel) {
        super::host_adoption::surface_orphans(self, orphans, channel);
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

    /// Every terminal owned by the sidecar on `channel`, as `session_key ->
    /// process_id`. There is deliberately no channel-less form: each caller
    /// must say which host's listing it is reasoning about. Without the
    /// channel filter, an elevated tab would appear in a primary pipe drop's
    /// `tabs` but never in the primary's own `ListSessions` answer, so the
    /// drop would classify every open admin tab as "lost" and tear it down
    /// (plan 045 §5: an elevated session is never reconnected — the elevated
    /// host self-exits on EOF instead). A check that must hold whichever
    /// channel owns the key uses `session_registered_on_any_channel`.
    ///
    /// **The pty-host speaks only session keys.** `host_terminals`,
    /// `terminals` and the screens are keyed by our per-run `pc-` id since
    /// design 014, while `SessionMeta.tab_id` and `host_stream_offsets` are in
    /// the host's space. Anything that compares a host answer against our
    /// registrations must go through this map, or every comparison silently
    /// fails and the terminal looks dead to us while being perfectly alive.
    pub fn host_sessions_by_key(&self, channel: HostChannel) -> std::collections::HashMap<String, String> {
        host_registry::sessions_by_key(&self.host_terminals, &self.terminals, channel)
    }

    /// True if any channel — primary, elevated or frozen — has a live
    /// registration for this session key.
    pub fn session_registered_on_any_channel(&self, session_key: &str) -> bool {
        host_registry::session_registered_on_any_channel(&self.host_terminals, &self.terminals, session_key)
    }

    pub fn next_frozen_id(&self) -> Result<FrozenId, String> {
        host_registry::next_frozen_id(&self.frozen_host_seq)
    }

    /// Register a frozen host, or replace the entry of the same id: a reconnect
    /// puts a new connection under the host the panes already name.
    pub fn add_frozen_host(&self, host: FrozenHost) {
        let mut hosts = self.frozen_hosts.lock().unwrap_or_else(|e| e.into_inner());
        match hosts.iter_mut().find(|h| h.id == host.id) {
            Some(known) => *known = host,
            None => hosts.push(host),
        }
    }

    pub fn remove_frozen_host(&self, id: FrozenId) -> Option<FrozenHost> {
        let mut hosts = self.frozen_hosts.lock().unwrap_or_else(|e| e.into_inner());
        let at = hosts.iter().position(|h| h.id == id)?;
        Some(hosts.remove(at))
    }

    /// The client of a registered frozen host; `None` once it is retired.
    pub fn frozen_client(&self, id: FrozenId) -> Option<crate::pty_host_client::PtyHostClient> {
        host_registry::frozen_client(&self.frozen_hosts, id)
    }

    /// Log and announce, once, sessions that two hosts both claim to hold.
    pub(super) fn note_duplicate_sessions(&self, session_keys: &[String]) {
        use tauri::Emitter;
        if session_keys.is_empty() || !host_registry::first_report(&self.duplicate_session_noticed) {
            return;
        }
        let _ = self.app_handle.emit("pty-host:duplicate-session", serde_json::json!({ "sessionKeys": session_keys }));
    }

    /// Drop restore intents and unowned closes nobody refreshed within the TTL.
    pub fn reap_expired_restore_intents(&self) {
        self.host_table.keys().reap_expired_restore_intents(std::time::Instant::now());
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
        self.host_table.keys().resolve_process(id, false).unwrap_or_else(|| id.to_string())
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
        host_registry::route_write(self.host_table.keys(), &self.host_terminals, &self.terminals, id, bytes, &|c| self.client_for_channel(c))
    }

    /// If `id` is host-owned AND connected, forward the resize and return true.
    pub fn host_resize(&self, id: &str, cols: u16, rows: u16) -> bool {
        host_registry::route_resize(self.host_table.keys(), &self.host_terminals, &self.terminals, id, cols, rows, &|c| self.client_for_channel(c))
    }

    /// If `id` is host-owned, forget it and (if connected) tell the sidecar to
    /// close the session. Returns true if it was host-owned (so the caller skips
    /// the local kill) even when the client is gone — there is no local process.
    /// An ending that cannot reach the host stays pending and is delivered
    /// before the next connection lists sessions.
    pub fn host_close(&self, id: &str) -> bool {
        if self.host_channel_for(id).is_none() { return false; }
        self.close_process(id, super::CloseStorage::Preserve)
    }

    /// If `id` is host-owned, force a repaint via a sidecar resize-nudge (the
    /// local jiggle can't — there is no local master). Returns true if handled.
    pub fn host_repaint(&self, id: &str) -> bool {
        // `id` is the PROCESS id (our map key); the host only knows this terminal
        // by its session key, so the nudge is addressed in the host's id space.
        host_registry::route_repaint(self.host_table.keys(), &self.host_terminals, &self.terminals, id, &|c| self.client_for_channel(c))
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
        if self.host_table.keys().owns_process(id) {
            self.exit_process(id);
        } else {
            self.cleanup_terminal_maps(id);
            self.retire_host_process(id);
            self.forget_host_terminal(id);
        }
    }

    pub(crate) fn cleanup_terminal_maps(&self, id: &str) {
        // FIRST STATEMENT, before anything is removed: the Automations engine keys its per-terminal
        // state by the durable `tm-` LEAF, and `terminals[id]` is the ONLY place that mapping lives.
        // `IdentityIndex` maps leaf -> process and never the reverse, and the sidecar exit path has
        // already called `identity.unindex(id)` before it reaches here — so there is no second route
        // to fall back on. Reading the leaf after `terminals.remove` yields `None` and the purge
        // silently does nothing, which is invisible: the symptom is a restarted terminal that is
        // never nagged again rather than an error. Plan 028 §2.4, §10.4c.
        let leaf = self.terminals.get(id).and_then(|t| t.renderer_terminal_id.clone());
        if let Some(leaf) = leaf {
            let owns_leaf = matches!(self.host_table.keys().owner_state(&leaf),
                Some((_, super::OwnerState::Registered(s) | super::OwnerState::Closing(s))) if s.process == id);
            if owns_leaf { self.automations.runtime.forget_terminal(&leaf); }
        }
        // `dirty` is keyed by the PROCESS id (`ChannelPayload.id` is a process id), so it is purged
        // with the id this function was given, never with the leaf. Plan 028 §7.4's table.
        self.automations.runtime.forget_process(id);

        // ORDER MATTERS: `terminals` must be removed FIRST — the PTY output
        // listener's history guard (lib.rs) double-checks `terminals` after
        // inserting into `terminal_history`, and that check only closes the
        // TOCTOU window if this method removes `terminals` before
        // `terminal_history`.
        if let Some(key) = self.session_key_for(id) {
            if let Some(channel) = self.host_channel_for(id) {
                self.host_table.keys().cleanup_session_projection(channel, &key, id, || {
                    self.host_stream_offsets.remove(&key);
                });
            }
        }
        self.terminals.remove(id);
        // Alongside `terminals`, and for the same reason: the identity lookups are
        // an index OF that map, so an entry outliving its terminal would resolve a
        // durable id to a process that no longer exists. One remover, at the same
        // choke point every other per-terminal map is torn down from.
        self.identity.unindex(id);
        self.shell_writer_channels.remove(id);
        self.local_processes.remove(id);
        self.ptys.remove(id);
        self.terminal_screens.remove(id);
        self.terminal_focus_reporting.remove(id);
        self.terminal_history.remove(id);
        self.tmux_sessions.remove(id);
        self.terminal_cwds.remove(id);
        self.replay_prefix.remove(id);
        self.history_dirty.remove(id);
        // Host ownership is released by the ending's effects, after its exact
        // key has retired and any Close has entered the host FIFO.
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
        let source = include_str!("terminals.rs").replace("\r\n", "\n");
        let start = source
            .find("pub(crate) fn cleanup_terminal_maps(&self, id: &str) {")
            .expect("cleanup_terminal_maps must exist");
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

/// Plan 045 T4: `host_terminals`'s value now says WHICH sidecar owns an entry,
/// and the elevated sidecar's teardown is DERIVED from counting `Elevated`
/// entries — a removal that bypasses `forget_host_terminal` silently stops
/// that count (and therefore the teardown) from ever firing for that site,
/// with no runtime symptom until someone notices an orphaned elevated
/// process. Asserted from source, in the style of `automation_teardown_source_tests`
/// above, since there is no way to enumerate "every call site" at runtime.
#[cfg(test)]
mod host_terminal_removal_source_tests {
    /// Truncated to everything BEFORE this test module's own source: the
    /// scan below looks for the literal substring `host_terminals.remove(`,
    /// which this module's own assertions necessarily also contain — an
    /// untruncated scan would flag itself as a second call site.
    fn source() -> String {
        let full = include_str!("terminals.rs").replace("\r\n", "\n");
        let end = full
            .find("mod host_terminal_removal_source_tests")
            .unwrap_or(full.len());
        full[..end].to_string()
    }

    /// `forget_host_terminal`'s body span (start, end byte offsets into `source()`).
    fn forget_host_terminal_span() -> (usize, usize) {
        let src = source();
        let sig = "pub fn forget_host_terminal(&self, id: &str) {";
        let start = src.find(sig).expect("forget_host_terminal must exist");
        let rest = &src[start..];
        let end = rest
            .find("\n    }\n")
            .expect("its body must be closed at method indentation")
            + 7;
        (start, start + end)
    }

    #[test]
    fn host_terminals_is_only_removed_through_forget_host_terminal() {
        let src = source();
        let (body_start, body_end) = forget_host_terminal_span();
        let needle = "host_terminals.remove(";
        let mut offset = 0;
        let mut found_in_chokepoint = false;
        while let Some(rel) = src[offset..].find(needle) {
            let at = offset + rel;
            if (body_start..body_end).contains(&at) {
                found_in_chokepoint = true;
            } else {
                panic!(
                    "`host_terminals.remove(` found outside forget_host_terminal at byte {at} \
                     — route it through forget_host_terminal instead, or the elevated \
                     sidecar's derived refcount teardown silently stops firing for this site"
                );
            }
            offset = at + needle.len();
        }
        assert!(
            found_in_chokepoint,
            "forget_host_terminal must itself call host_terminals.remove( — this guard is \
             vacuous if that call was refactored away without updating this test"
        );
    }
}

/// The reported bug: `armed_deadline` (pty-host/src/manager.rs) is set once
/// before an update/offload exit and nothing on the success path ever clears
/// it, so a completely normal quit LATER — after the user reopened, saw a
/// correct reattach, and simply chose Exit — still Holds instead of tearing
/// down, and the next launch reattaches a session the user already ended.
/// Asserted from source: host adoption needs a live pty-host over a
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
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("state").join("host_adoption.rs");
        std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("cannot read {} ({e})", path.display()))
            .replace("\r\n", "\n")
    }

    /// Every successful (re)connect must release whatever armed this host —
    /// our own prior exit, or a sibling's update — because a live GUI just
    /// adopted its sessions and the GUI-less hold is no longer needed.
    #[test]
    fn a_successful_connect_disarms_the_host_it_adopted() {
        let source = source();
        let settle = fn_body(&source, "async fn settle");
        assert!(
            settle.contains("client.disarm()"),
            "adoption must disarm the host once connected — \
            otherwise an arm from a past update/offload outlives the update \
            it was for. Body:\n{settle}"
        );
        // Both ways a host reaches the application — newly connected, or already
        // connected and only re-listed — go through it.
        let adopt = fn_body(&source, "async fn adopt<");
        assert_eq!(
            adopt.matches("settle(&client, deadline)").count(),
            2,
            "adopt must disarm-then-list a host on both the connect and the re-list path"
        );
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
        include_str!("terminals.rs").replace("\r\n", "\n")
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
        assert!(body_of("host_close").contains("self.close_process(id, super::CloseStorage::Preserve)"));
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
        let owner = include_str!("owner_lifecycle.rs").replace("\r\n", "\n");
        assert!(body_of("host_close").contains("self.close_process("));
        assert!(crate::state::source_scan::fn_body(&owner, "pub fn close_process(").contains("self.end_shell("));
        let body = crate::state::source_scan::fn_body(&owner, "fn end_shell(");
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
        let owner = include_str!("owner_lifecycle.rs").replace("\r\n", "\n");
        let body = crate::state::source_scan::fn_body(&owner, "fn end_shell(");
        let queued = body.find("keys().end_process(").expect("the shared ending (which queues disconnected closes) is gone");
        let emit = body.find("\"terminal:exit\"").expect("emit gone");
        assert!(emit > queued, "the emit sits inside the live-client arm; a queued close would be silent");
    }
}
