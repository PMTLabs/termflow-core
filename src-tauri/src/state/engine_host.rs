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
