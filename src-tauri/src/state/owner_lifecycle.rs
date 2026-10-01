//! Storage and process effects of owner transitions. No ownership guard is
//! held while persisting, deleting canvas edges, or killing a local child.

use super::{AppState, CloseAction, CloseStorage, Completion, CreateAdmission, CreateMode, EndKind, ShellStage, StagedShell, HostKeys};
use tauri::Runtime;

pub(crate) struct CreateGuard<R: Runtime> { state: AppState<R>, leaf: String, cg: u64 }
impl<R: Runtime> CreateGuard<R> {
    pub(crate) fn new(state: &AppState<R>, leaf: &str, cg: u64) -> Self {
        Self { state: state.clone(), leaf: leaf.into(), cg }
    }
}
impl<R: Runtime> Drop for CreateGuard<R> {
    fn drop(&mut self) {
        if let Some(shell) = self.state.host_table.keys().abort_create(&self.leaf, self.cg) {
            self.state.dispose_staged(&shell);
        }
    }
}

pub(super) fn finish_create(keys: &HostKeys, leaf: &str, cg: u64, shell: &StagedShell,
    dispose: impl FnOnce(&StagedShell), end: impl FnOnce(EndKind)) -> Completion {
    let result = keys.complete_shell(leaf, cg, shell);
    match result {
        Completion::Cancel(policy) => end(EndKind::Close(policy)),
        Completion::Stale => dispose(shell),
        Completion::Exited | Completion::Registered => {}
    }
    result
}

impl<R: Runtime> AppState<R> {
    pub(crate) fn metadata_leaf(&self, reference: &str) -> Result<Option<String>, String> {
        if reference.trim().is_empty() { return Err("a renderer terminal (leaf) id is required".into()); }
        let target = self.host_table.keys().resolve_process(reference.trim(), true);
        if target.is_none() && reference.starts_with("pc-") { return Err("Terminal not found".into()); }
        Ok(target)
    }

    pub(crate) fn dispose_staged(&self, shell: &StagedShell) {
        let pid = self.terminals.get(&shell.process).map_or(0, |t| t.pid);
        self.cleanup_terminal_maps(&shell.process);
        self.forget_host_terminal(&shell.process);
        if matches!(shell.stage, ShellStage::Local) { crate::pty_manager::kill_process_tree(pid); }
    }

    pub(crate) fn complete_create(&self, leaf: &str, cg: u64, shell: &StagedShell) {
        let process = &shell.process;
        let cwd = crate::pty_manager::exit_cwd_for(&self.terminal_cwds, process);
        let result = finish_create(self.host_table.keys(), leaf, cg, shell,
            |s| self.dispose_staged(s), |kind| { self.end_shell(process, kind); });
        if matches!(result, Completion::Exited) {
            self.cleanup_terminal_maps(process);
            self.forget_host_terminal(process);
            use tauri::Emitter;
            let _ = self.app_handle.emit("terminal:exit", super::terminals::host_exit_payload(process, cwd));
        }
    }

    /// Resolves a leaf on arrival; an explicit process id is never redirected.
    pub fn close_process(&self, reference: &str, policy: CloseStorage) -> bool {
        match self.host_table.keys().close_process(reference, policy) {
            CloseAction::Cancelled => true,
            CloseAction::End { process, .. } => { self.end_shell(&process, EndKind::Close(policy)); true }
            CloseAction::Missing => false,
        }
    }

    pub fn exit_process(&self, process: &str) -> bool {
        if !self.host_table.keys().note_exit(process) { return false }
        self.end_shell(process, EndKind::Exit)
    }

    /// Keep storage ahead of removal; a successor cannot admit during this work.
    pub(crate) fn end_shell(&self, process: &str, kind: EndKind) -> bool {
        let pid = self.terminals.get(process).map_or(0, |t| t.pid);
        let exit_cwd = crate::pty_manager::exit_cwd_for(&self.terminal_cwds, process);
        let ended = self.host_table.keys().end_process(process, kind, |leaf| {
            match kind {
                EndKind::Exit => {
                    if super::history_key(Some(leaf)).is_some() {
                        self.persist_history_snapshot(process, leaf, chrono::Utc::now().timestamp_millis());
                    }
                }
                EndKind::Close(CloseStorage::Delete) => {
                    self.history_store.delete(leaf);
                    if let Err(e) = self.canvas_store.delete_edges_for(leaf) {
                        log::warn!("Failed to delete canvas edges for {leaf}: {e}");
                    }
                    self.cleanup_terminal_maps(process);
                    return;
                }
                EndKind::Close(CloseStorage::Preserve) => {}
            }
            self.cleanup_terminal_maps(process);
        });
        let Some(ended) = ended else { return false };
        self.forget_host_terminal(process);
        if matches!(kind, EndKind::Close(_)) {
            if matches!(ended.shell.stage, ShellStage::Local) { crate::pty_manager::kill_process_tree(pid); }
            use tauri::Emitter;
            let _ = self.app_handle.emit("terminal:exit", super::terminals::host_exit_payload(process, exit_cwd));
        }
        true
    }

    pub(crate) async fn admit_mount(&self, leaf: &str) -> Result<Result<u64, String>, String> {
        match self.host_table.keys().admit_create(leaf, CreateMode::Mount)? {
            CreateAdmission::Run(cg) => Ok(Ok(cg)),
            CreateAdmission::Existing(process) => Ok(Err(process)),
            CreateAdmission::Join(receiver) => Ok(Err(CreateAdmission::joined(receiver, super::JOIN_DEADLINE).await?)),
        }
    }
}
