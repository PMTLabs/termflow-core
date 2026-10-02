use super::*;
use std::sync::mpsc::{channel, Receiver};
use std::time::Duration;

fn receive<T>(rx: &Receiver<T>) -> T {
    rx.recv_timeout(Duration::from_secs(5)).expect("event deadline expired")
}

fn live_window(keys: &HostKeys, label: &str) -> u64 {
    let guard = keys.reserve_window(label).unwrap();
    let wi = guard.identity().1;
    guard.commit().unwrap();
    wi
}

fn page(keys: &HostKeys, label: &str, wi: u64) -> PageIdentity {
    match keys.register_page(label).unwrap() {
        PageRegistration::Registered { wi: bound, pg } => {
            assert_eq!(bound, wi);
            PageIdentity { wi, pg }
        }
        PageRegistration::Retry => panic!("committed window should register"),
    }
}

fn is_live(keys: &HostKeys, page: PageIdentity) -> bool {
    keys.lock().window_pages.pages.get(&page.pg) == Some(&page.wi)
}

#[test]
fn registration_retries_during_gated_builds_and_other_windows_keep_progressing() {
    for success in [true, false] {
        let keys = HostKeys::default();
        let control_wi = live_window(&keys, "control");
        let control = page(&keys, "control", control_wi);
        let old_wi = live_window(&keys, "target");
        let old = page(&keys, "target", old_wi);
        assert_eq!(keys.lock().window_pages.committed.len(), 2);
        assert_eq!(keys.lock().window_pages.pages.len(), 2);
        let (reserved_tx, reserved_rx) = channel();
        let (release_tx, release_rx) = channel();
        let (finished_tx, finished_rx) = channel();
        let building_keys = keys.clone();
        let builder = std::thread::spawn(move || {
            let build = building_keys.reserve_window("target").unwrap();
            let wi = build.identity().1;
            reserved_tx.send(wi).unwrap();
            receive(&release_rx);
            let built: Result<(), &str> = if success { Ok(()) } else { Err("native build failed") };
            match built {
                Ok(()) => build.commit().unwrap(),
                Err(_) => drop(build),
            }
            finished_tx.send(wi).unwrap();
        });
        let reserved = receive(&reserved_rx);
        assert_ne!(reserved, old_wi);
        assert_eq!(keys.lock().window_pages.committed.get("target"), Some(&old_wi));

        // This must finish while the builder's gate is still closed, not merely
        // return Retry once the builder releases the ownership mutex.
        let (registered_tx, registered_rx) = channel();
        let registration_keys = keys.clone();
        let registrar = std::thread::spawn(move || {
            let retry = registration_keys.register_page("target").unwrap();
            let unrelated = page(&registration_keys, "control", control_wi);
            let ended = registration_keys.settle_page(unrelated).unwrap();
            registered_tx.send((retry, unrelated, ended)).unwrap();
        });
        let (retry, unrelated, ended) = receive(&registered_rx);
        assert_eq!(retry, PageRegistration::Retry);
        assert_eq!(ended, vec![control]);
        assert!(is_live(&keys, unrelated));
        assert!(!is_live(&keys, control));
        assert!(is_live(&keys, old));
        assert_eq!(keys.lock().window_pages.pages.len(), 2);
        release_tx.send(()).unwrap();
        assert_eq!(receive(&finished_rx), reserved);
        builder.join().unwrap();
        registrar.join().unwrap();
        let expected = if success { reserved } else { old_wi };
        let registered = page(&keys, "target", expected);
        assert!(registered.pg > old.pg);
        assert!(is_live(&keys, registered));
        // A successful build does not itself end pages; only destroy or settle does.
        assert!(is_live(&keys, old));
        assert!(keys.lock().window_pages.building.is_empty());
    }
}

#[test]
fn builder_unwind_clears_only_its_reservation_and_preserves_committed_window() {
    let keys = HostKeys::default();
    let control_wi = live_window(&keys, "control");
    let control = page(&keys, "control", control_wi);
    let old_wi = live_window(&keys, "target");
    let old = page(&keys, "target", old_wi);
    assert_eq!(keys.lock().window_pages.pages.len(), 2);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _build = keys.reserve_window("target").unwrap();
        assert_eq!(keys.register_page("target").unwrap(), PageRegistration::Retry);
        let builder = || -> Result<(), String> { panic!("builder unwound") };
        builder()
    }));
    assert!(result.is_err());
    assert!(keys.lock().window_pages.building.is_empty());
    let successor_page = page(&keys, "target", old_wi);
    assert!(successor_page.pg > old.pg);
    assert!(is_live(&keys, old));
    assert!(is_live(&keys, control));
    assert_eq!(keys.lock().window_pages.committed.len(), 2);
}

#[test]
fn old_build_guard_cannot_clear_a_successor_reservation() {
    let keys = HostKeys::default();
    let control_wi = live_window(&keys, "control");
    let control = page(&keys, "control", control_wi);
    let old = keys.reserve_window("target").unwrap();
    let old_wi = old.identity().1;
    assert_eq!(keys.lock().window_pages.building.len(), 1);
    assert!(keys.destroy_window("target", old_wi).is_empty());
    let successor = keys.reserve_window("target").unwrap();
    let new_wi = successor.identity().1;
    assert!(new_wi > old_wi);
    drop(old);
    assert_eq!(keys.register_page("target").unwrap(), PageRegistration::Retry);
    assert_eq!(keys.lock().window_pages.building.get("target"), Some(&new_wi));
    successor.commit().unwrap();
    let new_page = page(&keys, "target", new_wi);
    assert!(is_live(&keys, new_page));
    assert!(is_live(&keys, control));
}

#[test]
fn observed_destruction_before_commit_refuses_the_dead_build() {
    let keys = HostKeys::default();
    let control_wi = live_window(&keys, "control");
    let control = page(&keys, "control", control_wi);
    let old_wi = live_window(&keys, "target");
    let old_page = page(&keys, "target", old_wi);
    let build = keys.reserve_window("target").unwrap();
    let dead_wi = build.identity().1;
    assert_eq!(keys.lock().window_pages.building.len(), 1);
    keys.destroy_window("target", dead_wi);
    assert!(build.commit().is_err());
    assert!(keys.lock().window_pages.building.is_empty());
    let registered = page(&keys, "target", old_wi);
    assert!(is_live(&keys, old_page));
    assert!(is_live(&keys, registered));
    assert!(is_live(&keys, control));
    assert_ne!(dead_wi, registered.wi);
}

#[test]
fn delayed_destroy_cannot_remove_a_reused_labels_successor() {
    let keys = HostKeys::default();
    let control_wi = live_window(&keys, "control");
    let control = page(&keys, "control", control_wi);
    let old_wi = live_window(&keys, "target");
    let old_page = page(&keys, "target", old_wi);
    assert_eq!(keys.lock().window_pages.pages.len(), 2);
    let (ready_tx, ready_rx) = channel();
    let (release_tx, release_rx) = channel();
    let (ended_tx, ended_rx) = channel();
    let event_keys = keys.clone();
    let late_event = std::thread::spawn(move || {
        ready_tx.send(()).unwrap();
        receive(&release_rx);
        ended_tx.send(event_keys.destroy_window("target", old_wi)).unwrap();
    });
    receive(&ready_rx);
    assert_eq!(keys.destroy_window("target", old_wi), vec![old_page]);
    assert_eq!(keys.register_page("target").unwrap(), PageRegistration::Retry);
    let new_wi = live_window(&keys, "target");
    let new_page = page(&keys, "target", new_wi);
    assert!(new_wi > old_wi);
    release_tx.send(()).unwrap();
    assert!(receive(&ended_rx).is_empty());
    late_event.join().unwrap();
    assert!(is_live(&keys, new_page));
    assert!(is_live(&keys, control));
    let after_late = page(&keys, "target", new_wi);
    assert_eq!(keys.destroy_window("target", new_wi), vec![new_page, after_late]);
    assert!(is_live(&keys, control));
    assert!(!is_live(&keys, old_page));
}

#[test]
fn late_registration_does_not_settle_or_end_the_current_page() {
    let keys = HostKeys::default();
    let control_wi = live_window(&keys, "control");
    let control = page(&keys, "control", control_wi);
    let wi = live_window(&keys, "target");
    let dead = page(&keys, "target", wi);
    let current = page(&keys, "target", wi);
    assert_eq!(keys.settle_page(current).unwrap(), vec![dead]);
    assert!(!is_live(&keys, dead));
    let late = page(&keys, "target", wi);
    assert!(late.pg > current.pg);
    assert_eq!(keys.lock().window_pages.pages.len(), 3);
    assert!(is_live(&keys, current), "registration is not a settle");
    assert!(keys.settle_page(dead).is_err(), "an ended page cannot end its successor");
    assert!(keys.settle_page(PageIdentity { wi: control_wi, pg: late.pg }).is_err());
    assert!(is_live(&keys, control));
    assert!(is_live(&keys, current));
    assert!(is_live(&keys, late));
    assert_eq!(keys.destroy_window("target", wi), vec![current, late]);
    assert_eq!(keys.lock().window_pages.pages.len(), 1);
    assert!(is_live(&keys, control));
}

#[test]
fn settle_ends_exactly_lower_pages_of_the_same_window() {
    let keys = HostKeys::default();
    let wi = live_window(&keys, "target");
    let oldest = page(&keys, "target", wi);
    let control_wi = live_window(&keys, "control");
    let control_old = page(&keys, "control", control_wi);
    let lower = page(&keys, "target", wi);
    let settled = page(&keys, "target", wi);
    let control_new = page(&keys, "control", control_wi);
    let higher = page(&keys, "target", wi);
    assert_eq!(keys.lock().window_pages.pages.len(), 6);
    assert_eq!(keys.settle_page(settled).unwrap(), vec![oldest, lower]);
    assert_eq!(keys.lock().window_pages.pages.len(), 4);
    for page in [settled, control_old, control_new, higher] { assert!(is_live(&keys, page)); }
    assert!(keys.settle_page(settled).unwrap().is_empty(), "repeat settle is idempotent");
    assert_eq!(keys.settle_page(control_new).unwrap(), vec![control_old]);
    assert_eq!(keys.settle_page(higher).unwrap(), vec![settled]);
    assert_eq!(keys.lock().window_pages.pages.len(), 2);
    assert!(is_live(&keys, control_new));
    assert!(is_live(&keys, higher));
}

#[test]
fn registration_payload_is_minimal_and_counters_refuse_overflow() {
    let keys = HostKeys::default();
    assert_eq!(serde_json::to_value(keys.register_page("absent").unwrap()).unwrap(),
        serde_json::json!({"status": "Retry"}));
    let wi = live_window(&keys, "control");
    let control = page(&keys, "control", wi);
    assert_eq!(serde_json::to_value(PageRegistration::Registered { wi, pg: control.pg }).unwrap(),
        serde_json::json!({"status": "Registered", "wi": wi, "pg": control.pg}));
    keys.lock().window_pages.window_sequence = u64::MAX;
    assert!(keys.reserve_window("overflow").is_err());
    assert!(keys.lock().window_pages.building.is_empty());
    keys.lock().window_pages.page_sequence = u64::MAX;
    assert!(keys.register_page("control").is_err());
    assert_eq!(keys.lock().window_pages.pages.len(), 1);
    assert!(is_live(&keys, control));
    assert!(keys.settle_page(control).unwrap().is_empty());
}

#[test]
fn concurrent_build_of_the_same_label_is_refused_without_overwriting_the_guard() {
    let keys = HostKeys::default();
    let wi = live_window(&keys, "control");
    let control = page(&keys, "control", wi);
    let build = keys.reserve_window("target").unwrap();
    let target_wi = build.identity().1;
    assert_eq!(keys.lock().window_pages.building.get("target"), Some(&target_wi));
    assert!(keys.reserve_window("target").is_err());
    build.commit().unwrap();
    let target = page(&keys, "target", target_wi);
    assert!(is_live(&keys, target));
    assert!(is_live(&keys, control));
}

#[test]
fn every_native_builder_reserves_and_commits_and_main_commits_after_state_management() {
    use crate::state::source_scan::{production, fn_body, fn_spans, without_test_modules};
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    fn walk(dir: &std::path::Path, root: &std::path::Path, hits: &mut Vec<(String, String)>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() { walk(&path, root, hits); continue; }
            let name = path.file_name().unwrap().to_string_lossy();
            if path.extension().is_none_or(|e| e != "rs") || name.ends_with("_tests.rs") || name == "tests.rs" { continue; }
            let raw = std::fs::read_to_string(&path).unwrap();
            let source = without_test_modules(&raw).lines()
                .filter(|line| !line.trim_start().starts_with("//"))
                .collect::<Vec<_>>().join("\n");
            let spans = std::panic::catch_unwind(|| fn_spans(&source))
                .unwrap_or_else(|_| panic!("cannot scan {}", path.display()));
            for (function, span) in spans {
                let body = &source[span];
                if body.contains("WebviewWindowBuilder::") || body.contains("WebviewWindow::builder(") {
                    hits.push((path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/"), function));
                    let reserve = body.find("window_lifetime::reserve(").expect("builder must reserve");
                    let build = body.find("builder.build().map_err(|e| e.to_string())?").expect("failed build propagates");
                    let commit = body.find("window_lifetime::commit(build, &").expect("built window must commit");
                    assert!(reserve < build && build < commit);
                }
            }
        }
    }
    let mut hits = Vec::new();
    walk(&root, &root, &mut hits);
    hits.sort();
    assert_eq!(hits, vec![
        ("commands/drag.rs".into(), "show_drag_preview".into()),
        ("commands/window.rs".into(), "create_detached_window".into()),
        ("commands/window.rs".into(), "open_new_window".into()),
        ("window_restore.rs".into(), "build_restored_window".into()),
    ]);
    let lib = production(&std::fs::read_to_string(root.join("lib.rs")).unwrap());
    let setup = fn_body(&lib, ".setup(move |app|");
    let manage = setup.find("app.manage(state.clone())").unwrap();
    let reserve = setup.find("window_lifetime::reserve(app.handle(), \"main\")?").unwrap();
    let commit = setup.find("window_lifetime::commit(build, &main)?").unwrap();
    assert!(manage < reserve && reserve < commit);
    assert!(lib.contains("commands::register_page,"));
}

#[test]
fn tauri_wrappers_bind_the_calling_label_and_capture_the_reserved_incarnation() {
    use crate::state::source_scan::{production, fn_body};
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let source = production(&std::fs::read_to_string(root.join("window_lifetime.rs")).unwrap());
    let reserve = fn_body(&source, "pub(crate) fn reserve(");
    assert!(reserve.contains("state.host_table.keys().reserve_window(label)"));
    let commit = fn_body(&source, "pub(crate) fn commit(");
    for needle in ["let (label, wi) = build.identity()", "let keys = build.keys()", "keys.destroy_window(&label, wi)", "tauri::WindowEvent::Destroyed"] {
        assert!(commit.contains(needle), "missing {needle}");
    }
    assert!(commit.find("window.on_window_event(").unwrap() < commit.find("build.commit()").unwrap());
    let commands = production(&std::fs::read_to_string(root.join("commands/window.rs")).unwrap());
    let register = fn_body(&commands, "pub(crate) fn register_page(");
    assert!(register.contains("app_handle.try_state::<AppState>()"));
    assert!(register.contains("return Ok(crate::state::PageRegistration::Retry)"));
    assert!(register.contains("state.host_table.keys().register_page(window.label())"));
    assert!(!register.contains("settle"));
    let pages = production(&std::fs::read_to_string(root.join("state/host_keys/pages.rs")).unwrap());
    for signature in ["pub(crate) fn destroy_window(", "pub(crate) fn settle_page("] {
        let body = fn_body(&pages, signature);
        assert!(body.contains("let mut inner = self.lock()"));
        assert!(body.contains("Self::end_pages_locked(&mut inner, &ended)"));
    }
}
