use super::*;
use crate::ssh::{session::*, tests::*};
use serde_json::{json, Value};
use tauri::Manager;

#[tokio::test]
async fn ssh_session_invoke_real_appstate_exit_reconnect_close() {
    use crate::state::{PaneReply, PaneRequest, PaneResult, ShellStage, StagedShell};
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
    let (tx, _) = tokio::sync::broadcast::channel(16);
    let mut state = AppState::new(
        tx,
        app.handle().clone(),
        crate::app_config::NetworkConfig::defaults(),
    );
    state.ssh_sessions = f.registry.clone();
    app.manage(state);
    let state = app.state::<AppState<tauri::test::MockRuntime>>();
    let keys = state.host_table.keys();
    keys.reserve_window("ssh-owner").unwrap().commit().unwrap();
    let crate::state::PageRegistration::Registered { pg, .. } =
        keys.register_page("ssh-owner").unwrap()
    else {
        panic!("page");
    };
    let op = |seq, value: Value| {
        let request: PaneRequest =
            serde_json::from_value(json!({"pg":pg,"seq":seq,"op":value})).unwrap();
        let (reply, effects) = keys.pane_op("ssh-owner", request).unwrap();
        for (leaf, receipt) in effects.ssh_retired {
            f.registry.retire_owner(&leaf, receipt);
        }
        state.reconcile_ssh_owners();
        let PaneReply::Ack { result } = reply else {
            panic!("ack");
        };
        result
    };
    op(
        1,
        json!({"kind":"enter","panes":[{"pi":{"pg":pg,"seq":1},"paneId":"pane-a","leaf":"tm-a","restore":false}]}),
    );
    let opened = ssh_session_open(
        app.handle().clone(),
        app.state(),
        "tm-a".into(),
        "c-a".into(),
    )
    .unwrap();
    let PaneResult::Create { cg } = op(
        2,
        json!({"kind":"admit_create","pi":{"pg":pg,"seq":1},"mode":"Mount"}),
    ) else {
        panic!("create");
    };
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
        .on_launch_lifecycle("tm-a", opened.generation, 1, LaunchState::Running, None)
        .unwrap();
    wait_state(&f.registry, "tm-a", false, SessionState::Connected).await;
    assert!(state.exit_process("pc-a"));
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let v = ssh_session_state(app.handle().clone(), app.state(), "tm-a".into()).unwrap();
    assert_eq!(v.state, SessionState::Disconnected);
    assert_eq!(v.reason.as_deref(), Some("Local shell ended"));
    let next = ssh_session_reconnect(app.handle().clone(), app.state(), "tm-a".into()).unwrap();
    assert!(next.generation > opened.generation);
    state.reconcile_ssh_owners();
    assert_eq!(
        ssh_session_state(app.handle().clone(), app.state(), "tm-a".into())
            .unwrap()
            .generation,
        next.generation
    );
    op(3, json!({"kind":"close","pi":{"pg":pg,"seq":1}}));
    assert_eq!(
        ssh_session_state(app.handle().clone(), app.state(), "tm-a".into()),
        Err(SessionError::NotFound)
    );
    f.registry.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_session_invoke() {
    let app = tauri::test::mock_builder()
        .invoke_handler(crate::ssh_handlers![])
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "ssh-test", Default::default())
        .build()
        .unwrap();
    let fixture = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
    let (tx, _) = tokio::sync::broadcast::channel(16);
    let mut state = AppState::new(
        tx,
        app.handle().clone(),
        crate::app_config::NetworkConfig::defaults(),
    );
    state.ssh_sessions = fixture.registry.clone();
    app.manage(state);
    let invoke = |cmd: &str, body: Value| -> Result<Value, Value> {
        tauri::test::get_ipc_response(
            &webview,
            tauri::webview::InvokeRequest {
                cmd: cmd.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.into(),
            },
        )
        .map(|b| b.deserialize::<Value>().unwrap())
    };
    assert_eq!(
        invoke(
            "ssh_session_open",
            json!({"terminalId":"tm-missing", "connectionId":"c-a"})
        )
        .unwrap_err()["code"],
        "owner-retired"
    );
    assert_eq!(
        invoke("ssh_session_state", json!({"terminalId":"tm-missing"})).unwrap_err()["code"],
        "not-found"
    );
    assert_eq!(
        invoke("ssh_session_close", json!({"terminalId":"tm-missing"})),
        Ok(Value::Null)
    );
    assert_eq!(
        invoke("ssh_session_reconnect", json!({"terminalId":"tm-missing"})).unwrap_err()["code"],
        "not-found"
    );
    assert_eq!(invoke("ssh_session_submit_secret", json!({"terminalId":"tm-missing", "secret":"sentinel-password", "remember":true, "promptId":"old", "generation":1})).unwrap_err()["code"], "not-found");
    assert_eq!(
        invoke(
            "ssh_session_trust_host",
            json!({"terminalId":"tm-missing", "accept":true})
        )
        .unwrap_err()["code"],
        "not-found"
    );
    // Incorrect snake_case input must not deserialize as the binding camelCase contract.
    assert!(invoke("ssh_test_connection", json!({"connection_id":"c-a"})).is_err());
    let probe = invoke("ssh_test_connection", json!({"connectionId":"c-a"})).unwrap()["probeId"]
        .as_str()
        .unwrap()
        .to_string();
    let view = wait_state(&fixture.registry, &probe, true, SessionState::NeedsSecret).await;
    let serialized = invoke("ssh_test_state", json!({"probeId":probe})).unwrap();
    assert!(serialized.get("terminalId").is_none());
    assert!(serialized.get("promptId").is_some());
    assert_eq!(
        invoke(
            "ssh_test_trust_host",
            json!({"probeId":probe, "accept":true, "promptId":view.prompt_id})
        )
        .unwrap_err()["code"],
        "stale-attempt"
    );
    let bad = invoke(
        "ssh_test_submit_secret",
        json!({"probeId":probe, "secret":"sentinel-password", "remember":false, "promptId":"old"}),
    )
    .unwrap_err();
    assert_eq!(bad["code"], "stale-attempt");
    assert!(!bad.to_string().contains("sentinel-password"));
    invoke("ssh_test_submit_secret", json!({"probeId":probe, "secret":"password-alice", "remember":false, "promptId":view.prompt_id, "generation":view.generation})).unwrap();
    wait_state(&fixture.registry, &probe, true, SessionState::Connected).await;
    invoke("ssh_test_close", json!({"probeId":probe})).unwrap();
    assert!(fixture.registry.owner_map().is_empty());
    fixture.registry.shutdown().await;
}
