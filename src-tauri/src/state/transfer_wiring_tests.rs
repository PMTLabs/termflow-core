use super::source_scan::{fn_body, production};

#[test]
fn admitted_creation_is_qualified_by_the_calling_page() {
    let admitted = production(include_str!("../commands/panes.rs"));
    assert!(fn_body(&admitted, "fn create_admitted_terminal(").contains("admitted_work(window.label(), request.pg"));
}

#[test]
fn native_broker_build_and_wait_wrappers_require_page_qualification_outside_the_stream() {
    let drag = production(include_str!("../commands/drag.rs"));
    for (function, sink) in [
        ("begin_global_pane_drag", "begin_pane_drag(window.label(), pg"),
        ("claim_global_pane_drag", "claim_pane_drag(window.label(), pg"),
        ("resolve_orphan_global_drag", "end_pane_drag(window.label(), pg"),
        ("cancel_global_pane_drag", "end_pane_drag(window.label(), pg"),
        ("resolve_tab_drop", "route_pane_transfer(window.label(), pg"),
    ] {
        let signature = &drag[drag.find(&format!("fn {function}(")).unwrap()..];
        let signature = &signature[..signature.find('{').unwrap()];
        assert!(signature.contains("pg: u64"), "{function}");
        assert!(!signature.contains("Option<u64>"), "{function}");
        let body = fn_body(&drag, &format!("fn {function}("));
        assert!(body.contains(sink), "{function}");
        assert!(!body.contains("if let Some(pg)"), "{function}");
    }
    let window = production(include_str!("../commands/window.rs"));
    let build = fn_body(&window, "fn create_detached_window(");
    assert!(build.find("verify_transfer_source(window.label(), pg, &token)").unwrap() < build.find("builder.build()").unwrap());
    let native_probe = build
        .find(".is_visible()")
        .expect("verify the async native build result");
    let build_call = build.find("builder.build()").unwrap();
    let commit = build.find("window_lifetime::commit(build, &window)").unwrap();
    assert!(build_call < native_probe && native_probe < commit);
    // The probe must ask the window `build()` just returned, not another handle
    // (a clone of the source window would answer for a destination that failed).
    let receiver = build[..native_probe].trim_end();
    assert!(
        receiver.ends_with("window")
            && receiver[..receiver.len() - "window".len()].ends_with(char::is_whitespace),
        "the native probe must be called on `window` itself"
    );
    assert!(
        build[native_probe..commit].contains(
            ".map_err(|e| format!(\"detached window webview failed to initialize: {e}\"))?;"
        )
    );
    assert!(build.contains("watch_transfer(window.label(), pg, &token)"));
    assert!(build.contains("transfer_taken(taken).await"));
    assert!(!build.contains("if let Some(pg)"));
    let commands = production(include_str!("../commands/panes.rs"));
    let wait = fn_body(&commands, "fn wait_transfer_taken(");
    assert!(wait.contains("watch_transfer(window.label(), pg, &tx)?"));
    assert!(wait.contains("transfer_taken(receiver).await"));
    assert!(production(include_str!("../lib.rs")).contains("commands::wait_transfer_taken,"));
    let stream = fn_body(&commands, "fn pane_op(");
    assert!(!stream.contains("transfer_taken") && !stream.contains(".await"));
}
