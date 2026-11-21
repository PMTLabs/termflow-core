//! IPC-only SSH commands. Never added to REST/MCP, and never write PTY input.
use crate::{
    ssh::session::{EventSink, SessionError, SessionView},
    state::AppState,
};
use std::sync::Arc;
use tauri::{Emitter, Manager, Runtime, State};

pub struct TauriSshEvents<R: Runtime>(pub tauri::AppHandle<R>);
impl<R: Runtime> EventSink for TauriSshEvents<R> {
    fn emit(&self, event: &'static str, view: &SessionView) {
        let _ = self.0.emit(event, view);
    }
}
pub(crate) fn native_registry<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Arc<crate::ssh::session::SessionRegistry> {
    // Managed before setup; lazy test fallback creates no files or keyring access.
    let store = app
        .try_state::<crate::ssh::store::Store>()
        .map(|s| s.inner().clone())
        .unwrap_or_else(|| crate::ssh::store::Store::new(crate::ssh::store::store_path()));
    let emitter = app.clone();
    Arc::new(crate::ssh::session::SessionRegistry::new(
        crate::ssh::session::Dependencies::native(
            Arc::new(TauriSshEvents(app)),
            store,
            Arc::new(move |reply| {
                let _ = emitter.emit(crate::commands::ssh_store::CHANGED, reply);
            }),
        ),
    ))
}
pub(crate) fn open_core(
    keys: &crate::state::HostKeys,
    registry: &Arc<crate::ssh::session::SessionRegistry>,
    terminal_id: &str,
    connection_id: &str,
) -> Result<SessionView, SessionError> {
    let receipt = keys
        .ssh_owner_receipt(terminal_id)
        .ok_or(SessionError::OwnerRetired)?;
    registry.open_owned(terminal_id, connection_id, false, Some(receipt), || {
        keys.ssh_owner_receipt(terminal_id) == Some(receipt)
    })
}
pub(crate) fn reconnect_core(
    keys: &crate::state::HostKeys,
    registry: &Arc<crate::ssh::session::SessionRegistry>,
    terminal_id: &str,
) -> Result<SessionView, SessionError> {
    registry.state(terminal_id, false)?;
    let receipt = keys
        .ssh_owner_receipt(terminal_id)
        .ok_or(SessionError::OwnerRetired)?;
    registry.reconnect_owned(terminal_id, Some(receipt), || {
        keys.ssh_owner_receipt(terminal_id) == Some(receipt)
    })
}
#[tauri::command]
pub fn ssh_session_open<R: Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, AppState<R>>,
    terminal_id: String,
    connection_id: String,
) -> Result<SessionView, SessionError> {
    open_core(
        state.host_table.keys(),
        &state.ssh_sessions,
        &terminal_id,
        &connection_id,
    )
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
    reconnect_core(state.host_table.keys(), &state.ssh_sessions, &terminal_id)
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
        use crate::state::{
            CreateMode, EndKind, HostKeys, PaneReply, PaneRequest, PaneResult, ShellStage,
            StagedShell,
        };
        let keys = HostKeys::default();
        keys.reserve_window("owner").unwrap().commit().unwrap();
        let crate::state::PageRegistration::Registered { pg, .. } =
            keys.register_page("owner").unwrap()
        else {
            panic!("page");
        };
        let op = |seq, value: serde_json::Value| {
            let request: PaneRequest =
                serde_json::from_value(serde_json::json!({"pg":pg,"seq":seq,"op":value})).unwrap();
            let (reply, effects) = keys.pane_op("owner", request).unwrap();
            for (leaf, receipt) in effects.ssh_retired {
                f.registry.retire_owner(&leaf, receipt);
            }
            let PaneReply::Ack { result } = reply else {
                panic!("ack");
            };
            result
        };
        op(
            1,
            serde_json::json!({"kind":"enter","panes":[{"pi":{"pg":pg,"seq":1},"paneId":"pane-a","leaf":"tm-a","restore":false}]}),
        );
        let opened = super::open_core(&keys, &f.registry, "tm-a", "c-a").unwrap();
        let receipt = keys.ssh_owner_receipt("tm-a").unwrap();
        let PaneResult::Create { cg } = op(
            2,
            serde_json::json!({"kind":"admit_create","pi":{"pg":pg,"seq":1},"mode":"Mount"}),
        ) else {
            panic!("admission");
        };
        assert_eq!(
            cg, receipt,
            "pre-admit receipt must survive Held -> Placing"
        );
        keys.stage_shell("tm-a", cg, "pc-a", None).unwrap();
        keys.complete_shell(
            "tm-a",
            cg,
            &StagedShell {
                process: "pc-a".into(),
                stage: ShellStage::Local,
            },
        );
        let v = wait_state(&f.registry, "tm-a", false, SessionState::NeedsSecret).await;
        f.registry
            .submit_secret(
                "tm-a",
                false,
                None,
                v.prompt_id.as_deref(),
                "password-alice".into(),
                false,
            )
            .unwrap();
        f.registry
            .on_launch_lifecycle("tm-a", v.generation, 1, LaunchState::Running, None)
            .unwrap();
        wait_state(&f.registry, "tm-a", false, SessionState::Connected).await;
        assert!(keys.end_process("pc-a", EndKind::Exit, |_| {}).is_some());
        f.registry
            .disconnect_generation("tm-a", opened.generation, "Local shell ended");
        f.registry
            .reconcile_owners(|leaf, receipt| keys.ssh_owner_receipt(leaf) == receipt);
        let exited = f.registry.state("tm-a", false).unwrap();
        assert_eq!(exited.reason.as_deref(), Some("Local shell ended"));
        let reconnected = super::reconnect_core(&keys, &f.registry, "tm-a").unwrap();
        assert!(reconnected.generation > opened.generation);
        // A failed spawn is not a genuine close: retry and reconnect must
        // retain the current live SSH ownership receipt.
        let PaneResult::Create { cg } = op(
            3,
            serde_json::json!({"kind":"admit_create","pi":{"pg":pg,"seq":1},"mode":"Restart"}),
        ) else {
            panic!("restart");
        };
        keys.abort_create("tm-a", cg);
        let PaneResult::Create { cg: new_cg } = op(
            4,
            serde_json::json!({"kind":"admit_create","pi":{"pg":pg,"seq":1},"mode":"Restart"}),
        ) else {
            panic!("restart again");
        };
        assert_eq!(
            new_cg, cg,
            "abort with the pane present must preserve SSH ownership"
        );
        let latest = super::reconnect_core(&keys, &f.registry, "tm-a").unwrap();
        f.registry
            .reconcile_owners(|leaf, receipt| keys.ssh_owner_receipt(leaf) == receipt);
        assert_eq!(
            f.registry.state("tm-a", false).unwrap().generation,
            latest.generation
        );
        assert!(matches!(
            keys.admit_create("control", CreateMode::Mount),
            Ok(_)
        ));
        let events = f.events.0.lock().clone();
        assert!(!events.is_empty());
        assert!(events
            .iter()
            .all(|v| v.terminal_id.as_deref() == Some("tm-a") && v.connection_id == "c-a"));
        assert!(events.iter().any(|v| v.state == SessionState::Connected));
        op(
            5,
            serde_json::json!({"kind":"close","pi":{"pg":pg,"seq":1}}),
        );
        f.registry
            .reconcile_owners(|leaf, receipt| keys.ssh_owner_receipt(leaf) == receipt);
        assert_eq!(f.registry.state("tm-a", false), Err(SessionError::NotFound));
        f.registry.shutdown().await;
    }
    #[test]
    fn ssh_commands_registered_and_bridged() {
        let lib = include_str!("ssh_store.rs");
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
            .split("macro_rules! ssh_handlers")
            .nth(1)
            .unwrap()
            .split("pub trait StoreEmitter")
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
