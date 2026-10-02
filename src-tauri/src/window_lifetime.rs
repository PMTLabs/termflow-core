//! Bind successful native builds to process-local window incarnations.

use tauri::Manager;
use crate::state::WindowBuildGuard;

pub(crate) fn reserve(app: &tauri::AppHandle, label: &str) -> Result<WindowBuildGuard, String> {
    let state = app.try_state::<crate::state::AppState>().ok_or("window state not ready")?;
    state.host_table.keys().reserve_window(label)
}

pub(crate) fn commit(build: WindowBuildGuard, window: &tauri::WebviewWindow) -> Result<(), String> {
    let (label, wi) = build.identity();
    let label = label.to_string();
    let keys = build.keys();
    let app = window.app_handle().clone();
    // Queue the listener before publishing the window. If it observes destruction
    // before commit, it invalidates this exact reservation. The runtime may still
    // drop the queued listener if destruction precedes its installation.
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            keys.destroy_window(&label, wi);
            if let Some(state) = app.try_state::<crate::state::AppState>() { state.schedule_host_restore_release(); }
        }
    });
    build.commit()
}
