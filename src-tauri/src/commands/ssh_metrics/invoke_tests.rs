use super::*;
use crate::{
    ssh::{session::{LaunchState, SessionState}, tests::{hop, wait_state, Fixture, Server}},
    state::{AppState, PaneReply, PaneResult, ShellStage, StagedShell},
};
use serde_json::{json, Value};
use tauri::{Manager, test::MockRuntime};

fn invoke(window: &WebviewWindow<MockRuntime>, cmd: &str, page: Option<&str>, id: Uuid) -> Result<Value, Value> {
    let mut headers = tauri::http::HeaderMap::new();
    if let Some(page) = page { headers.insert(PAGE_HEADER, page.parse().unwrap()); }
    tauri::test::get_ipc_response(window, tauri::webview::InvokeRequest {
        cmd: cmd.into(), callback: tauri::ipc::CallbackFn(0), error: tauri::ipc::CallbackFn(1),
        url: "tauri://localhost".parse().unwrap(),
        body: tauri::ipc::InvokeBody::Json(json!({"terminalId":"tm-a","consumerId":id})),
        headers, invoke_key: tauri::test::INVOKE_KEY.into(),
    }).map(|body| body.deserialize::<Value>().unwrap())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retired_page_cannot_watch_or_keep_worker() {
    let app = tauri::test::mock_builder()
        .invoke_handler(crate::ssh_handlers![
            crate::commands::ssh_metrics::ssh_metrics_watch,
            crate::commands::ssh_metrics::ssh_metrics_unwatch,
            crate::commands::ssh_metrics::ssh_metrics_resume,
        ])
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let label = "metrics-owner";
    let window = tauri::WebviewWindowBuilder::new(&app, label, Default::default()).build().unwrap();
    let other = tauri::WebviewWindowBuilder::new(&app, "other", Default::default()).build().unwrap();
    let wire = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
    let (tx, _) = tokio::sync::broadcast::channel(16);
    let mut state = AppState::new(tx, app.handle().clone(), crate::app_config::NetworkConfig::defaults());
    state.ssh_sessions = wire.registry.clone();
    let keys = state.host_table.keys().clone();
    app.manage(WatchRegistry::native(keys.clone(), wire.registry.clone(), app.handle().clone()));
    app.manage(state);

    keys.reserve_window(label).unwrap().commit().unwrap();
    keys.reserve_window(other.label()).unwrap().commit().unwrap();
    let page = || {
        let crate::state::PageRegistration::Registered { wi, pg } = keys.register_page(label).unwrap() else { panic!("register") };
        (wi, pg)
    };
    let op = |pg, seq, op| {
        let (reply, effects) = keys.pane_op(label, serde_json::from_value(json!({"pg":pg,"seq":seq,"op":op})).unwrap()).unwrap();
        for (leaf, receipt) in effects.ssh_retired { wire.registry.retire_owner(&leaf, receipt); }
        app.state::<AppState<MockRuntime>>().reconcile_ssh_owners();
        let PaneReply::Ack { result } = reply else { panic!("ack") };
        result
    };
    let enter = |pg, seq| op(pg, seq, json!({"kind":"enter","panes":[{"pi":{"pg":pg,"seq":1},"paneId":"pane-a","leaf":"tm-a"}]}));
    let admit = |pg, seq| op(pg, seq, json!({"kind":"admit_create","mode":"Mount","pi":{"pg":pg,"seq":1}}));
    let connect = || async {
        let opened = crate::commands::ssh_session::open_core(&keys, &wire.registry, "tm-a", "c-a").unwrap();
        let prompt = wait_state(&wire.registry, "tm-a", false, SessionState::NeedsSecret).await;
        wire.registry.submit_secret("tm-a", false, Some(opened.generation), prompt.prompt_id.as_deref(), wire.server.password.clone(), false).unwrap();
        wire.registry.on_launch_lifecycle("tm-a", opened.generation, 1, LaunchState::Running, None).unwrap();
        wait_state(&wire.registry, "tm-a", false, SessionState::Connected).await;
        opened.generation
    };

    let (wi, old) = page();
    assert_eq!(enter(old, 1), PaneResult::Ok);
    let generation = connect().await;
    let PaneResult::Create { cg } = admit(old, 2) else { panic!("create") };
    keys.stage_shell("tm-a", cg, "pc-a", None).unwrap();
    keys.complete_shell("tm-a", cg, &StagedShell { process: "pc-a".into(), stage: ShellStage::Local });
    let old_header = old.to_string();
    let reused_id = Uuid::new_v4();
    for invalid in [None, Some(""), Some("not-a-page"), Some("0"), Some("+1"), Some("18446744073709551616")] {
        assert_eq!(invoke(&window, "ssh_metrics_watch", invalid, reused_id).unwrap_err()["code"], "invalid-page");
    }
    assert_eq!(invoke(&other, "ssh_metrics_watch", Some(&old_header), reused_id).unwrap_err()["code"], "owner-retired");
    let (_, next) = page();  // Old page remains authoritative until ReplacePage/Settle.
    let next_header = next.to_string();
    let old_watch = invoke(&window, "ssh_metrics_watch", Some(&old_header), reused_id).unwrap();
    assert_eq!(old_watch, json!({"sampleFloor":old_watch["sampleFloor"],"generation":generation,"pauseSeq":0,"pausedReason":null}));
    assert!(old_watch["sampleFloor"].as_u64().unwrap() > 0);
    let metrics = app.state::<Arc<WatchRegistry>>();
    assert_eq!(metrics.invoke_census("tm-a").0, vec![(label.to_owned(), old, reused_id)]);
    assert_eq!(invoke(&window, "ssh_metrics_watch", Some(&next_header), reused_id).unwrap_err()["code"], "owner-retired");
    assert_eq!(op(next, 1, json!({"kind":"replace_page"})), PaneResult::Ok);
    assert_eq!(metrics.invoke_census("tm-a"), (Vec::new(), false));
    assert_eq!(enter(next, 2), PaneResult::Ok);
    assert!(matches!(admit(next, 3), PaneResult::Existing { .. }));
    assert_eq!(op(next, 4, json!({"kind":"settle"})), PaneResult::Ok);

    // A delayed FIRST watch with an unseen UUID cannot be fixed by tombstoning
    // known consumer IDs. Mutating sender to latest_page incorrectly admits it.
    assert_eq!(invoke(&window, "ssh_metrics_watch", Some(&old_header), Uuid::new_v4()).unwrap_err()["code"], "owner-retired");
    let fresh = invoke(&window, "ssh_metrics_watch", Some(&next_header), reused_id).unwrap();
    assert_eq!(metrics.invoke_census("tm-a").0, vec![(label.to_owned(), next, reused_id)]);
    assert!(fresh["sampleFloor"].as_u64().unwrap() > old_watch["sampleFloor"].as_u64().unwrap());
    for cmd in ["ssh_metrics_resume", "ssh_metrics_unwatch"] {
        assert_eq!(invoke(&window, cmd, Some(&old_header), reused_id).unwrap_err()["code"], "owner-retired");
    }
    let resumed = invoke(&window, "ssh_metrics_resume", Some(&next_header), reused_id).unwrap();
    assert_eq!(resumed, json!({"sampleFloor":resumed["sampleFloor"],"generation":generation,"pauseSeq":1}));
    assert!(resumed["sampleFloor"].as_u64().unwrap() > fresh["sampleFloor"].as_u64().unwrap());
    assert_eq!(invoke(&window, "ssh_metrics_unwatch", Some(&next_header), reused_id), Ok(Value::Null));
    assert_eq!(invoke(&window, "ssh_metrics_unwatch", Some(&next_header), reused_id), Ok(Value::Null));
    assert_eq!(invoke(&window, "ssh_metrics_resume", Some(&next_header), reused_id).unwrap_err()["code"], "owner-retired");
    keys.destroy_window(label, wi);
    app.state::<AppState<MockRuntime>>().reconcile_ssh_owners();
    assert!(wire.registry.owner_map().is_empty());
    assert_eq!(invoke(&window, "ssh_metrics_watch", Some(&next_header), Uuid::new_v4()).unwrap_err()["code"], "owner-retired");
    wire.registry.shutdown().await;
}
