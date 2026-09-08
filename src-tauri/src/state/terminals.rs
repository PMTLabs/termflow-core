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

fn restore_sweep_may_release(pending_windows: usize, already_released: bool) -> bool {
    pending_windows == 0 && !already_released
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

/// A restore report is historical: a terminal can be created after its window
/// snapshot but before another window releases the sweep.  Reconcile that
/// snapshot with ownership observed immediately before planning recovery.
fn restore_claims_with_current_ownership(
    claims: impl IntoIterator<Item = String>,
    owned_session_keys: impl IntoIterator<Item = String>,
) -> Vec<String> {
    claims
        .into_iter()
        .chain(owned_session_keys)
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect()
}

/// Reconcile a host answer with the ownership that existed before asking for it.
/// Ownership observed after the answer was built can suppress recovery of an
/// orphan, but cannot prove that the older answer killed that new terminal.
fn plan_reconnect(
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
mod restore_sweep_gate_tests {
    use super::restore_sweep_may_release;

    #[test]
    fn waits_for_every_window_then_releases_when_last_is_destroyed() {
        assert!(!restore_sweep_may_release(1, false));
        assert!(restore_sweep_may_release(0, false));
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
    fn current_ownership_augments_stale_restore_claims() {
        let claims = super::restore_claims_with_current_ownership(
            ["restored-before-snapshot".into()],
            ["created-after-snapshot".into()],
        );
        let sessions = [termflow_pty_protocol::SessionMeta {
            tab_id: "created-after-snapshot".into(),
            pid: 73,
            head_offset: 0,
            tail_offset: 0,
            alive: true,
        }];
        let plan = super::plan_reattach(&claims, &sessions, &std::collections::HashMap::new());
        assert!(
            plan.orphans.is_empty(),
            "a session currently owned by another restored window must never become a recovered duplicate"
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
            mcp_process: Arc::new(Mutex::new(crate::state::GenerationSlot::new())),
            fabric_process: Arc::new(Mutex::new(crate::state::GenerationSlot::new())),
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
            proc_snapshot: Arc::new(crate::automation::proc_snapshot::ProcSnapshot::new(
                crate::automation::proc_snapshot::SNAPSHOT_TTL_MS,
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
            host_restore_pending_windows: Arc::new(DashMap::new()),
            host_restore_claims: Arc::new(DashMap::new()),
            host_restore_released: Arc::new(AtomicBool::new(false)),
            host_recovery_surfaced: Arc::new(DashMap::new()),
            reattach_prompt_hooks: Arc::new(DashMap::new()),
            pty_host_gen: Arc::new(AtomicU64::new(0)),
            pty_host_connecting: Arc::new(tokio::sync::Mutex::new(())),
            host_stream_offsets: Arc::new(DashMap::new()),
            host_recovering: Arc::new(tokio::sync::Mutex::new(())),
            host_close_pending: Arc::new(DashMap::new()),
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
        let launch = crate::pty_host_client::resolve_host_launch().ok_or_else(|| {
            "pty-host sidecar binary not found (set TERMFLOW_PTY_HOST_BIN)".to_string()
        })?;
        let sidecar = launch.path;
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
        match crate::pty_host_client::host_build_disposition(record.as_ref(), &launch.build_id) {
            crate::pty_host_client::HostBuildDisposition::Current => {}
            crate::pty_host_client::HostBuildDisposition::Stale { observed, expected } => log::warn!(
                "[HOTSWAP] adopting stale pty-host build {observed} (expected {expected}); close these terminals, then restart TermFlow"
            ),
            crate::pty_host_client::HostBuildDisposition::Unknown => log::warn!(
                "[HOTSWAP] adopting pty-host with no build identity; close these terminals, then restart TermFlow"
            ),
        }
        let (pipe, attach_acks, lifecycle) = match crate::pty_host_client::plan_connection(record) {
            crate::pty_host_client::ConnectPlan::LegacyOrNone => {
                log::info!("[HOTSWAP] no host discovery record — legacy/none; using well-known pipe");
                (pipe, false, crate::pty_host_client::HostRetention::Unknown)
            }
            crate::pty_host_client::ConnectPlan::Bootstrap {
                endpoint,
                version,
                instance_id,
                host_caps,
                lifecycle,
            } => {
                let acks = host_caps & termflow_pty_protocol::CAP_ATTACH_ACK != 0;
                log::info!(
                    "[HOTSWAP] discovered host instance={instance_id:x} proto=v{version} \
                     caps={host_caps:#x} endpoint={endpoint} (attach_acks={acks})"
                );
                (endpoint, acks, lifecycle)
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
            lifecycle_token: token.clone(),
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

        let mut client =
            crate::pty_host_client::connect_or_spawn(&sidecar, &launch.build_id, &pipe, &token, record_pid, deps)
                .await
                .map_err(|e| e.to_string())?;
        client.set_attach_acks(attach_acks);
        client.set_lifecycle(lifecycle);
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
                    if meta.alive && !owned_sessions.contains_key(&meta.tab_id) {
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
        let initial_by_session = self.host_sessions_by_key();
        let tabs: Vec<String> = initial_by_session.keys().cloned().collect();
        // Do not return when the app currently owns no tabs: the host can still
        // hold live sessions which must be recovered into visible terminals.
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
        // `tabs` is the pre-request snapshot and is the sole destructive
        // authority. A terminal registered after the host built this answer is
        // absent from `sessions`, but that is not evidence it has died.
        // Fresh ownership is useful only to suppress orphan recovery.
        let by_session = self.host_sessions_by_key();
        let saved: std::collections::HashMap<String, u64> = self
            .host_stream_offsets
            .iter()
            .map(|e| (e.key().clone(), *e.value()))
            .collect();
        let plan = plan_reconnect(&tabs, &sessions, &saved, by_session.keys().cloned());
        log::info!(
            "[HOTSWAP] in-place reconnect: {} session(s) to reattach, {} lost, {} orphan(s) to recover",
            plan.reattach.len(),
            plan.teardown.len(),
            plan.orphans.len()
        );
        self.surface_host_orphans(plan.orphans);
        for a in plan.reattach {
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
        for t in plan.teardown {
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

    pub fn begin_host_restore_sweep(&self, windows: impl IntoIterator<Item = String>) {
        self.host_restore_pending_windows.clear();
        self.host_restore_claims.clear();
        self.host_restore_released.store(false, Ordering::Release);
        for label in windows {
            self.host_restore_pending_windows.insert(label, ());
        }
        let state = self.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            let pending: Vec<String> = state.host_restore_pending_windows.iter().map(|e| e.key().clone()).collect();
            if !pending.is_empty() {
                log::warn!("[HOTSWAP] host restore sweep proceeding after 60s without acknowledgements from: {}", pending.join(", "));
                state.release_host_restore_sweep(true).await;
            }
        });
    }

    pub async fn report_host_restore_settled(&self, window_label: String, claims: Vec<String>) {
        for claim in claims {
            self.host_restore_claims.insert(claim, ());
        }
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
        // release AND the backstop would then both return early here and the
        // sweep would never run — silently. Today's callers pre-check, but that
        // guard belongs at this choke point, not in each caller.
        if !forced && !restore_sweep_may_release(self.host_restore_pending_windows.len(), false) { return; }
        if self.host_restore_released.swap(true, Ordering::AcqRel) { return; }
        if !sweep_claim_survives(self.run_host_restore_sweep().await) {
            // Hand the one-shot back so the backstop — or a later report — can
            // retry. Consuming it on a transient failure is indistinguishable
            // from a completed sweep and permanently strands the sessions.
            self.host_restore_released.store(false, Ordering::Release);
            log::warn!("[HOTSWAP] restore sweep could not complete; leaving it retryable");
        }
    }

    /// Runs the sweep. `false` means it did NOT complete and must stay retryable.
    async fn run_host_restore_sweep(&self) -> bool {
        if self.ensure_pty_host().await.is_err() {
            return false;
        }
        let Some(client) = self.pty_host_clone() else { return false };
        // An unanswered listing is unknown, never empty: do not surface or tear down.
        let Some(sessions) = client.list_sessions().await else { return false };
        let claims = restore_claims_with_current_ownership(
            self.host_restore_claims.iter().map(|e| e.key().clone()),
            self.host_sessions_by_key().into_keys(),
        );
        let plan = plan_reattach(&claims, &sessions, &std::collections::HashMap::new());
        self.surface_host_orphans(plan.orphans);
        true
    }

    /// The sole UI emission path for live host sessions that no known tab claims.
    fn surface_host_orphans(&self, orphans: Vec<termflow_pty_protocol::SessionMeta>) {
        use tauri::Emitter;
        for orphan in orphans {
            // A terminal can be created between a listing and this UI pass.
            // The current ownership map, rather than a restore snapshot, is
            // authoritative at the point recovery would become visible.
            if self.host_sessions_by_key().contains_key(&orphan.tab_id) {
                continue;
            }
            if self.host_recovery_surfaced.insert(orphan.tab_id.clone(), ()).is_some() {
                continue;
            }
            self.host_reattach_pending.insert(orphan.tab_id.clone(), orphan.pid);
            let leaf_id = format!("tm-{}", uuid::Uuid::new_v4().simple());
            if let Err(e) = self.app_handle.emit("api:createTerminalTab", serde_json::json!({
                "name": "Recovered terminal", "profile": "default", "processId": leaf_id,
                "rendererTerminalId": leaf_id, "sessionKey": orphan.tab_id,
                "targetWindow": self.resolve_active_window_label(),
            })) {
                self.host_recovery_surfaced.remove(&orphan.tab_id);
                log::warn!("[HOTSWAP] failed to surface recovered session {}: {e}", orphan.tab_id);
            }
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
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("state").join("terminals.rs");
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
