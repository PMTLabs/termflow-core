//! IPC-only SSH commands. Never added to REST/MCP, and never write PTY input.
use crate::{
    ssh::session::{EventSink, SessionError, SessionView},
    state::AppState,
};
use std::sync::Arc;
use tauri::{Emitter, Runtime, State};

pub struct TauriSshEvents<R: Runtime>(pub tauri::AppHandle<R>);
impl<R: Runtime> EventSink for TauriSshEvents<R> {
    fn emit(&self, event: &'static str, view: &SessionView) {
        let _ = self.0.emit(event, view);
    }
}
pub(crate) fn native_registry<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Arc<crate::ssh::session::SessionRegistry> {
    Arc::new(crate::ssh::session::SessionRegistry::new(
        crate::ssh::session::Dependencies::native(Arc::new(TauriSshEvents(app))),
    ))
}
fn admitted<R: Runtime>(state: &AppState<R>, terminal_id: &str) -> bool {
    state
        .host_table
        .keys()
        .ssh_owner_receipt(terminal_id)
        .is_some()
}
#[tauri::command]
pub fn ssh_session_open<R: Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, AppState<R>>,
    terminal_id: String,
    connection_id: String,
) -> Result<SessionView, SessionError> {
    let receipt = state
        .host_table
        .keys()
        .ssh_owner_receipt(&terminal_id)
        .ok_or(SessionError::OwnerRetired)?;
    state
        .ssh_sessions
        .open_owned(&terminal_id, &connection_id, false, Some(receipt), || {
            state.host_table.keys().ssh_owner_receipt(&terminal_id) == Some(receipt)
        })
}
#[tauri::command]
pub fn ssh_session_state<R: Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, AppState<R>>,
    terminal_id: String,
) -> Result<SessionView, SessionError> {
    state.ssh_sessions.state(&terminal_id, false)
}
#[tauri::command]
pub fn ssh_session_close<R: Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, AppState<R>>,
    terminal_id: String,
    generation: Option<u64>,
) -> Result<(), SessionError> {
    state.ssh_sessions.close(&terminal_id, false, generation)
}
#[tauri::command]
pub fn ssh_session_reconnect<R: Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, AppState<R>>,
    terminal_id: String,
) -> Result<SessionView, SessionError> {
    state
        .ssh_sessions
        .reconnect(&terminal_id, || admitted(&state, &terminal_id))
}
#[tauri::command]
pub fn ssh_session_submit_secret<R: Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, AppState<R>>,
    terminal_id: String,
    secret: String,
    remember: bool,
    generation: Option<u64>,
    prompt_id: Option<String>,
) -> Result<(), SessionError> {
    state.ssh_sessions.submit_secret(
        &terminal_id,
        false,
        generation,
        prompt_id.as_deref(),
        secret,
        remember,
    )
}
#[tauri::command]
pub fn ssh_session_trust_host<R: Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, AppState<R>>,
    terminal_id: String,
    accept: bool,
    generation: Option<u64>,
    prompt_id: Option<String>,
) -> Result<(), SessionError> {
    state.ssh_sessions.trust_host(
        &terminal_id,
        false,
        generation,
        prompt_id.as_deref(),
        accept,
    )
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeReply {
    pub probe_id: String,
}
#[tauri::command]
pub fn ssh_test_connection<R: Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, AppState<R>>,
    connection_id: String,
) -> Result<ProbeReply, SessionError> {
    Ok(ProbeReply {
        probe_id: state.ssh_sessions.probe(&connection_id)?,
    })
}
#[tauri::command]
pub fn ssh_test_state<R: Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, AppState<R>>,
    probe_id: String,
) -> Result<SessionView, SessionError> {
    state.ssh_sessions.state(&probe_id, true)
}
#[tauri::command]
pub fn ssh_test_close<R: Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, AppState<R>>,
    probe_id: String,
) -> Result<(), SessionError> {
    state.ssh_sessions.close(&probe_id, true, None)
}
#[tauri::command]
pub fn ssh_test_submit_secret<R: Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, AppState<R>>,
    probe_id: String,
    secret: String,
    remember: bool,
    generation: Option<u64>,
    prompt_id: Option<String>,
) -> Result<(), SessionError> {
    state.ssh_sessions.submit_secret(
        &probe_id,
        true,
        generation,
        prompt_id.as_deref(),
        secret,
        remember,
    )
}
#[tauri::command]
pub fn ssh_test_trust_host<R: Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, AppState<R>>,
    probe_id: String,
    accept: bool,
    generation: Option<u64>,
    prompt_id: Option<String>,
) -> Result<(), SessionError> {
    state
        .ssh_sessions
        .trust_host(&probe_id, true, generation, prompt_id.as_deref(), accept)
}

#[cfg(all(test, feature = "integration-tests"))]
#[path = "ssh_session_invoke_tests.rs"]
mod invoke_tests;

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn commands_drive_real_engine_and_emit_only_authoritative_states() {
        use crate::ssh::{session::*, tests::*};
        let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
        f.connected().await;
        let events = f.events.0.lock().clone();
        assert!(!events.is_empty());
        assert!(events
            .iter()
            .all(|v| v.terminal_id.as_deref() == Some("tm-a") && v.connection_id == "c-a"));
        assert_eq!(events.last().unwrap().state, SessionState::Connected);
        f.registry.shutdown().await;
    }
    #[test]
    fn ssh_commands_registered_and_bridged() {
        let lib = include_str!("../lib.rs");
        let bridge = include_str!("../../../src/renderer/api/tauri-bridge.ts");
        let browser = include_str!("../../../src/renderer/api/browser-bridge.ts");
        let contract = include_str!("../../../src/renderer/types/electron.d.ts");
        let names = [
            "ssh_session_open",
            "ssh_session_state",
            "ssh_session_close",
            "ssh_session_reconnect",
            "ssh_session_submit_secret",
            "ssh_session_trust_host",
            "ssh_test_connection",
            "ssh_test_state",
            "ssh_test_close",
            "ssh_test_submit_secret",
            "ssh_test_trust_host",
        ];
        let registry = lib
            .split(".invoke_handler(tauri::generate_handler![")
            .nth(1)
            .unwrap()
            .split("])")
            .next()
            .unwrap();
        for name in names {
            assert!(
                registry.contains(&format!("commands::{name},")),
                "unregistered {name}"
            );
            assert!(bridge.contains(name), "unbridged {name}");
            assert!(browser.contains(name), "browser {name}");
            assert!(contract.contains(name), "contract {name}");
        }
    }
}
