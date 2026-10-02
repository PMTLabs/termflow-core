use super::*;
use std::sync::Arc;
use crate::window_registry::{WindowRecord, WindowTracker};

pub(super) fn tracker() -> (Arc<WindowTracker>, std::path::PathBuf) {
    let path = std::env::temp_dir().join(format!("tf-binding-{}.json", uuid::Uuid::new_v4()));
    (Arc::new(WindowTracker::new(path.clone(), Default::default())), path)
}
fn record(label: &str, id: &str) -> WindowRecord {
    WindowRecord { id: id.into(), label: label.into(), x: 0, y: 0, width: 900, height: 600, maximized: false, focused: false }
}

#[test]
fn failed_or_unwound_window_build_rolls_back_binding_and_preserves_prior_live_window() {
    for kind in ["new", "detached", "restored"] {
        for prior_live in [false, true] {
            for unwind in [false, true] {
                let keys = HostKeys::default();
                let (tracker, path) = tracker();
                tracker.bind("control", "control-id");
                let control_wi = live_window(&keys, "control");
                let control = page(&keys, "control", control_wi);
                let old_wi = prior_live.then(|| live_window(&keys, "target"));
                if prior_live { tracker.register(record("target", "live-id")); }
                let original = tracker.snapshot();
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let build = keys.reserve_window("target").unwrap().with_stable_id(tracker.clone(), format!("{kind}-reserved"));
                    assert_eq!(build.stable_id(), Some(format!("{kind}-reserved").as_str()));
                    assert_eq!(tracker.id_for_label("target"), Some(format!("{kind}-reserved")));
                    assert_eq!(keys.register_page("target").unwrap(), PageRegistration::Retry);
                    assert!(is_live(&keys, control));
                    if unwind { panic!("native build unwound"); }
                    // The fallible native builder returns before guard commit.
                    drop(build);
                }));
                assert_eq!(result.is_err(), unwind);
                assert_eq!(tracker.id_for_label("target"), prior_live.then(|| "live-id".into()));
                assert_eq!(tracker.id_for_label("control").as_deref(), Some("control-id"));
                assert_eq!(tracker.snapshot(), original);
                assert!(keys.lock().window_pages.building.is_empty());
                if let Some(wi) = old_wi { assert_eq!(keys.register_page("target").unwrap(), PageRegistration::Registered { wi, pg: control.pg + 1 }); }
                else { assert_eq!(keys.register_page("target").unwrap(), PageRegistration::Retry); }
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

#[test]
fn window_commit_keeps_binding_destroy_removes_it_and_stale_rollback_preserves_replacement() {
    let keys = HostKeys::default();
    let (tracker, path) = tracker();
    tracker.bind("control", "control-id");
    let build = keys.reserve_window("target").unwrap().with_stable_id(tracker.clone(), "committed-id".into());
    let wi = build.identity().1;
    assert_eq!(tracker.id_for_label("target").as_deref(), Some("committed-id"));
    build.commit().unwrap();
    tracker.register(record("target", "committed-id"));
    let target = page(&keys, "target", wi);
    assert_eq!(keys.destroy_window("target", wi), vec![target]);
    tracker.forget("target");
    assert_eq!(tracker.id_for_label("target"), None);
    assert!(tracker.snapshot().windows.is_empty());
    assert_eq!(tracker.id_for_label("control").as_deref(), Some("control-id"));

    tracker.bind("target", "prior-id");
    let old = keys.reserve_window("target").unwrap().with_stable_id(tracker.clone(), "old-reservation".into());
    let old_wi = old.identity().1;
    keys.destroy_window("target", old_wi);
    let successor = keys.reserve_window("target").unwrap().with_stable_id(tracker.clone(), "successor-id".into());
    let next_wi = successor.identity().1;
    successor.commit().unwrap();
    assert!(old.commit().is_err());
    assert_eq!(tracker.id_for_label("target").as_deref(), Some("successor-id"));
    assert_eq!(keys.lock().window_pages.committed.get("target"), Some(&next_wi));
    assert_eq!(tracker.id_for_label("control").as_deref(), Some("control-id"));
    let _ = std::fs::remove_file(path);
}

#[test]
fn native_session_builders_couple_prebind_to_commit_instead_of_binding_independently() {
    use crate::state::source_scan::{production, fn_body};
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let commands = production(&std::fs::read_to_string(root.join("commands/window.rs")).unwrap());
    for function in ["pub async fn create_detached_window(", "pub fn open_new_window("] {
        let body = fn_body(&commands, function);
        let prebind = body.find("let build = reserve_window_id(").unwrap();
        let build = body.find("builder.build()").unwrap();
        let commit = body.find("window_lifetime::commit(build, &window)").unwrap();
        assert!(prebind < build && build < commit);
        assert!(body.contains("build.stable_id()"));
    }
    assert!(fn_body(&commands, "pub(crate) fn reserve_window_id(").contains("build.with_stable_id(state.windows.clone(), id)"));
    let restore = production(&std::fs::read_to_string(root.join("window_restore.rs")).unwrap());
    let body = fn_body(&restore, "fn build_restored_window(");
    assert!(body.find(".with_stable_id(state.windows.clone(), record.id.clone())").unwrap() < body.find("builder.build()").unwrap());
    assert!(!fn_body(&restore, "pub(crate) fn restore_windows(").contains("tracker.bind(&label"));
    let pages = production(&std::fs::read_to_string(root.join("state/host_keys/pages.rs")).unwrap());
    let rollback = fn_body(&pages, "fn drop(");
    assert!(rollback.find("drop(self.stable_id.take())").unwrap() < rollback.find("window_pages.cancel").unwrap());
}
