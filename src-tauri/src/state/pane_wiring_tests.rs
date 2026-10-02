use super::source_scan::{fn_body, production};

#[test]
fn native_ownership_handlers_validate_sender_and_keep_host_work_outside_stream() {
    let commands = production(include_str!("../commands/panes.rs"));
    let op = fn_body(&commands, "fn pane_op(");
    assert!(commands.contains("fn pane_op(window: WebviewWindow"));
    assert!(op.contains("keys().pane_op(window.label(), request)?"));
    assert!(op.contains("dispatch_closes(state.inner(), effects.closes)"));
    assert!(!op.contains(".await") && !op.contains("run_create"));
    assert!(op.contains("if effects.wake_transfers"));
    let dispatch = fn_body(&commands, "fn dispatch_closes(");
    assert!(dispatch.contains("spawn_blocking"));
    assert!(dispatch.contains("state.end_shell(&pc, EndKind::Close(CloseStorage::Delete))"));
    let create = fn_body(&commands, "fn create_admitted_terminal(");
    assert!(commands.contains("fn create_admitted_terminal(window: WebviewWindow"));
    let claim = create.find("admitted_work(window.label(), request.pg, &request.leaf, request.cg)").unwrap();
    assert!(claim < create.find("run_create(").unwrap());
    assert!(create.contains("CreateAdmission::Join(waiter) => CreateAdmission::joined(waiter, crate::state::JOIN_DEADLINE).await"));
    assert!(create.contains("CreateGuard::new(state.inner(), &request.leaf, cg)"));
    assert!(!create.contains("spawn_routed(") && !create.contains("admit_mount("));
    let close = fn_body(&commands, "fn close_process(");
    assert!(close.contains("keys().close_process_reap(&pc, reap)"));
    assert!(close.contains("dispatch_closes(state.inner(), effects)"));
    let lib = production(include_str!("../lib.rs"));
    for name in ["pane_op", "create_admitted_terminal", "close_process", "register_page", "create_terminal", "close_terminal"] {
        assert!(lib.contains(&format!("commands::{name},")), "missing handler {name}");
    }
    let terminal = production(include_str!("../commands/terminal.rs"));
    assert!(fn_body(&terminal, "fn create_terminal(").contains("resolve_profile(profile_id.as_deref(), cwd)"));
    assert!(fn_body(&terminal, "fn spawn_routed(").contains("run_create(state, req, cg).await"));
}

#[test]
fn page_sender_and_original_window_end_remain_qualified_at_mutation() {
    let pages = production(include_str!("host_keys/pages.rs"));
    let sender = fn_body(&pages, "fn sender(");
    assert!(sender.contains("self.window_of(pg)"));
    assert!(sender.contains("self.committed.get(label) != Some(&wi)"));
    let destroy = fn_body(&pages, "fn destroy(");
    assert!(destroy.contains("self.committed.get(label) == Some(&wi)"));
    assert!(destroy.contains("self.end_matching(wi, None)"));
    for name in ["destroy_window", "settle_page"] {
        let body = fn_body(&pages, &format!("fn {name}("));
        assert!(body.contains("let mut inner = self.lock()"));
        assert!(body.contains("Self::end_pages_locked(&mut inner, &ended)"));
    }
    assert!(fn_body(&pages, "fn end_pages_locked(").contains("Self::end_pane_pages(inner, ended)"));
    let stream = production(include_str!("host_keys/panes.rs"));
    let op = fn_body(&stream, "fn pane_op_at(");
    assert!(op.find("window_pages.sender(label, request.pg)?").unwrap() < op.find("Self::apply_pane_op(").unwrap());
    assert!(op.contains("stream.next.checked_add(1)"));
    assert!(!op.contains(".await"));
    let end = production(include_str!("host_keys/pane_transfers.rs"));
    let end = fn_body(&end, "fn end_pane_pages(");
    assert!(end.contains("pages.contains(&pi.pg)") && end.contains("pages.contains(&pg)"));
    assert!(end.contains("Self::remove_held(inner, &leaf)"));
    assert!(!end.contains("close_process") && !end.contains("kill_process") && !end.contains("emit("));
}

#[test]
fn admitted_create_json_accepts_optional_renderer_fields_without_renaming() {
    let request: crate::commands::AdmittedCreateRequest = serde_json::from_value(serde_json::json!({
        "pg": 7, "cg": 12, "leaf": "tm-json", "profile": "pwsh", "name": "named", "cwd": "directory",
        "cols": 100, "rows": 40, "owningTabId": "tb-json", "sessionKey": "legacy-json", "elevated": true,
    })).unwrap();
    assert_eq!((request.pg, request.cg), (7, 12));
    assert_eq!((request.leaf.as_str(), request.profile.as_str()), ("tm-json", "pwsh"));
    assert_eq!(request.owning_tab_id.as_deref(), Some("tb-json"));
    assert_eq!(request.session_key.as_deref(), Some("legacy-json"));
    assert_eq!((request.cols, request.rows, request.elevated), (Some(100), Some(40), Some(true)));
    assert_eq!(request.name.as_deref(), Some("named"));
    assert_eq!(request.cwd.as_deref(), Some("directory"));
    let control: crate::commands::AdmittedCreateRequest = serde_json::from_value(serde_json::json!({ "pg": 8, "cg": 13, "leaf": "tm-control", "profile": "default" })).unwrap();
    assert_eq!((control.cols, control.rows, control.elevated), (None, None, None));
    assert!(control.owning_tab_id.is_none() && control.session_key.is_none());
}
