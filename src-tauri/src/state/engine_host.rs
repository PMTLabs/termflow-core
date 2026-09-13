use super::types::AppState;

/// The running engine's view of this app (plan 028 §7.10).
///
/// **Every method here is a projection with no decision in it**, which is the rule the whole port
/// exists to enforce: `AppState::new` takes an `AppHandle`, and `--features integration-tests` breaks
/// the Windows test binary at loader time, so anything with a branch reachable only through
/// `AppState` is a gate that cannot fail on the platform this is developed on. The engine's decisions
/// all live in `automation_engine::loops`, against a fake.
impl<R: tauri::Runtime> crate::automation_engine::host::EngineHost for AppState<R> {
    fn process_for_leaf(&self, tm: &str) -> Option<String> {
        // The ONE conversion (§7.4). Never `resolve_ref`: it returns its input unchanged when the
        // leaf does not resolve, so it cannot double as an existence test and would hand a `tm-`
        // string to a `pc-`keyed map.
        self.identity.process_for_leaf(tm)
    }

    fn roster(&self, criteria: &[crate::automation_store::Criterion]) -> Vec<crate::automation::roster::RosterRow> {
        let mut rows: Vec<crate::automation::roster::RosterRow> = self
            .terminals
            .iter()
            .map(|entry| {
                let t = entry.value();
                crate::automation::roster::RosterRow {
                    terminal_id: t.renderer_terminal_id.clone(),
                    process_id: t.id.clone(),
                    name: t.name.clone(),
                    shell: t.shell.clone(),
                    pid: t.pid,
                    display_label: t.display_label.clone(),
                    cwd: self.terminal_cwds.get(&t.id).map(|c| c.value().clone()),
                    command_lines: Vec::new(),
                }
            })
            .collect();

        // §10.13. The process table is enumerated ONLY when a live rule actually asks a question that
        // needs it — `Command contains` always, `Working folder is under` only when some terminal has
        // not reported a cwd. A profile whose only rule is `Terminal ID is` never scans.
        if crate::automation::proc_snapshot::scan_needed_for(criteria.iter().copied(), &rows) {
            let now = chrono::Utc::now().timestamp_millis();
            self.proc_snapshot.with(now, sysinfo::System::new_all, |sys| {
                for row in rows.iter_mut() {
                    row.command_lines = crate::pty_manager::foreground_command_lines(row.pid, sys);
                }
            });
        }
        rows
    }

    fn live_processes(&self) -> Vec<String> {
        self.terminals.iter().map(|e| e.key().clone()).collect()
    }

    fn tail(
        &self,
        pc: &str,
        depth: crate::automation_engine::eval::ReadDepth,
        skip_typed_line: bool,
    ) -> Option<String> {
        self.screen_tail_text(pc, depth, skip_typed_line)
    }

    fn write(&self, pc: &str, bytes: &[u8]) -> Result<(), String> {
        <Self as crate::automation::send::TerminalWriter>::write(self, pc, bytes)
    }

    fn label_for(&self, tm: &str) -> Option<String> {
        // `label_at` is the ONLY resolver (§2.8). The rule's stored snapshot is not reachable from
        // here — it is per `(rule, terminal)` and this port is per terminal — so a name for a
        // terminal that is already gone comes from the pending send's carried label, resolved at
        // DECIDE time, which is exactly why `PendingSend` carries one.
        let pc = self.identity.process_for_leaf(tm)?;
        let terminal = self.terminals.get(&pc)?;
        crate::automation::labels::label_at(&crate::automation::labels::LabelInputs {
            display_label: terminal.display_label.as_deref(),
            name: Some(terminal.name.as_str()),
            shell: Some(terminal.shell.as_str()),
            snapshot: None,
        })
    }

    fn cwd_for(&self, pc: &str) -> Option<String> {
        // The same two sources, in the same order, as `commands::get_terminal_cwd`: the
        // shell-reported OSC cwd is instant; the process scan is not, and goes through the roster's
        // own `proc_snapshot` so a schedule rule with N targets naming `${terminal.cwd}` costs one
        // `System::new_all()` per TTL, not N — `proc_snapshot.rs`'s whole point is that Automations
        // is not a fourth independent enumerator. A ≤ TTL-stale directory is fine for a message.
        if let Some(cwd) = self.terminal_cwds.get(pc) {
            return Some(cwd.value().clone());
        }
        let pid = self.terminals.get(pc)?.pid;
        let now = chrono::Utc::now().timestamp_millis();
        self.proc_snapshot.with(now, sysinfo::System::new_all, |sys| {
            crate::pty_manager::get_process_cwd_with(sys, pid)
        })
    }

    fn store(&self) -> &std::sync::Arc<crate::automation_store::AutomationStore> {
        &self.automation_store
    }

    fn emit_activity(&self, rule_ids: Vec<String>) {
        use tauri::Emitter as _;
        let _ = self.app_handle.emit(
            crate::automation::events::AUTOMATION_ACTIVITY,
            crate::automation::events::ActivityPayload { rule_ids },
        );
    }

    fn emit_state(&self) {
        use tauri::Emitter as _;
        // `runtime_payload` is the SAME function `get_automation_runtime()` calls, so the event and
        // first paint cannot disagree (§10.18d).
        let _ = self
            .app_handle
            .emit(crate::automation::events::AUTOMATION_STATE, self.automations.runtime_payload());
    }

    fn emit_changed(&self, rule_ids: Vec<String>) {
        use tauri::Emitter as _;
        // App-wide, like the other two and like the command layer's `announce`: every open window's
        // Settings page wants it, and it only makes a window refetch — it never makes one act.
        let _ = self.app_handle.emit(
            crate::automation::events::AUTOMATION_CHANGED,
            crate::automation::events::ChangedPayload {
                rule_ids,
                deleted: Vec::new(),
                origin: crate::automation::events::ENGINE_ORIGIN.to_string(),
                at: chrono::Utc::now().timestamp_millis(),
            },
        );
    }
}

impl<R: tauri::Runtime> crate::automation_engine::eval::ScreenSource for AppState<R> {
    fn tail(
        &self,
        process_id: &str,
        depth: crate::automation_engine::eval::ReadDepth,
        skip_typed_line: bool,
    ) -> Option<String> {
        self.screen_tail_text(process_id, depth, skip_typed_line)
    }
}

/// The real `cwd_for`, not `FakeHost`'s: the engine tests stub the host, so this is the only
/// place the two sources and their order are pinned for `AppState` — the OSC-reported directory
/// first (instant), the process scan through the shared `proc_snapshot` only when the shell has
/// not said, and nothing at all for a process the roster does not know.
///
/// Gated like every `mock_app()` test: tauri's `test` feature breaks the Windows test binary at
/// loader time, so these run under `cargo test --features integration-tests` (Linux/macOS CI).
#[cfg(all(test, feature = "integration-tests"))]
mod cwd_for_tests {
    use crate::automation_engine::host::EngineHost;
    use crate::state::AppState;

    fn mock_state() -> (tauri::App<tauri::test::MockRuntime>, AppState<tauri::test::MockRuntime>) {
        let app = tauri::test::mock_app();
        let (tx, _rx) = tokio::sync::broadcast::channel(16);
        let state = AppState::new(tx, app.handle().clone(), crate::app_config::NetworkConfig::defaults());
        (app, state)
    }

    fn register(state: &AppState<tauri::test::MockRuntime>, pc: &str, pid: u32) {
        state.terminals.insert(
            pc.to_string(),
            crate::state::Terminal {
                id: pc.to_string(),
                pid,
                shell: "test".to_string(),
                name: "Terminal-test".to_string(),
                created_at: chrono::Local::now().to_rfc3339(),
                cols: 80,
                rows: 24,
                backend: crate::tmux_manager::TerminalBackend::PortablePty,
                renderer_terminal_id: Some(pc.to_string()),
                owning_tab_id: Some(pc.to_string()),
                session_key: pc.to_string(),
                last_input_source: None,
                last_input_at: None,
                prompt_hook: false,
                display_label: None,
                title_color: None,
            },
        );
    }

    /// The shell-reported directory wins, and no scan is needed to find it: the terminal is
    /// registered with pid 0, which no snapshot resolves, so a `cwd_for` that skipped the OSC map
    /// would return `None` here.
    #[test]
    fn the_osc_reported_directory_is_answered_without_a_scan() {
        let (_app, state) = mock_state();
        register(&state, "pc-osc", 0);
        state.terminal_cwds.insert("pc-osc".to_string(), "/from/osc".to_string());

        assert_eq!(state.cwd_for("pc-osc").as_deref(), Some("/from/osc"));
    }

    /// With nothing reported, the process scan runs — against this very process, whose
    /// directory (or a child's) any snapshot can read. A `cwd_for` that stopped at the OSC map
    /// would return `None`.
    #[test]
    fn a_silent_shell_falls_back_to_the_process_scan() {
        let (_app, state) = mock_state();
        register(&state, "pc-scan", std::process::id());

        assert!(state.cwd_for("pc-scan").is_some(), "the scan path did not run");
    }

    /// A process the roster does not know is `None` — not a scan of pid 0.
    #[test]
    fn an_unknown_process_has_no_directory() {
        let (_app, state) = mock_state();

        assert_eq!(state.cwd_for("pc-never"), None);
    }
}
