use crate::commands;
use crate::state::AppState;
use tauri::Manager;

/// Show + focus the app's primary window, unhiding/unminimizing it. If no real
/// window exists (e.g. the last one was torn off and destroyed while running in the
/// background), open a fresh one so the tray's Show/Peers actions always surface UI.
/// Recreate every window that was open at the last quit (plan 018 Task 3).
///
/// `tauri.conf.json` declares exactly one window, so slot 0 is bound to the
/// already-created `main` and slots 1..N are built here.
///
/// Labels are NOT reused from the registry. A saved `detach-*` label would make
/// the restored window take the detach boot path, look for a payload that no
/// process still holds (`detach_payloads` is in-memory and empty every launch)
/// and refuse to restore. The stable `windowId` carries the session, so the
/// label is free to be normalised.
pub(crate) fn restore_windows(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<AppState>() else { return };
    let tracker = state.windows.clone();
    let saved = tracker.snapshot();

    let monitors: Vec<crate::window_registry::MonitorRect> = app
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| crate::window_registry::MonitorRect {
            x: m.position().x,
            y: m.position().y,
            width: m.size().width,
            height: m.size().height,
        })
        .collect();

    // First run (or a registry we chose not to trust): adopt `main` as slot 0
    // under the reserved id, which is what keeps its storage key unsuffixed and
    // therefore byte-compatible with sessions saved before this feature.
    if saved.windows.is_empty() {
        if let Some(main) = app.get_webview_window(crate::window_registry::MAIN_LABEL) {
            let pos = main.outer_position().ok();
            let size = main.inner_size().ok();
            tracker.register(crate::window_registry::WindowRecord {
                id: crate::window_registry::SLOT_ZERO_ID.to_string(),
                label: crate::window_registry::MAIN_LABEL.to_string(),
                x: pos.map(|p| p.x).unwrap_or(0),
                y: pos.map(|p| p.y).unwrap_or(0),
                width: size.map(|s| s.width).unwrap_or(1280),
                height: size.map(|s| s.height).unwrap_or(800),
                maximized: main.is_maximized().unwrap_or(false),
                focused: true,
            });
        }
        return;
    }

    let mut records = saved.windows;
    let focused_id = records.iter().find(|w| w.focused).map(|w| w.id.clone());

    // --- slot 0 → the boot window ---
    let mut slot0 = records.remove(0);
    slot0.label = crate::window_registry::MAIN_LABEL.to_string();
    tracker.bind(crate::window_registry::MAIN_LABEL, &slot0.id);
    if let Some(main) = app.get_webview_window(crate::window_registry::MAIN_LABEL) {
        apply_geometry(&main, &slot0, &monitors);
    }
    tracker.register(slot0);

    // --- slots 1..N → fresh windows ---
    for mut record in records {
        let label = format!("window-{}", uuid::Uuid::new_v4().simple());
        record.label = label.clone();
        // Bind BEFORE building. The webview resolves its session id as its first
        // action, and a binding published afterwards is a race whose losing side
        // falls back to slot 0 — silently merging this window's tabs into the
        // main window's session, which is the defect being fixed.
        tracker.bind(&label, &record.id);
        match build_restored_window(app, &label, &record, &monitors) {
            Ok(window) => {
                crate::context_menu::install(&window);
                tracker.register(record);
            }
            Err(e) => {
                // Drop the record rather than keeping a window we cannot build:
                // it is still in the tracker's registry from load time, and a
                // permanently unbuildable entry would be retried on every start.
                // `forget` cannot do this — it resolves through the label map,
                // which only holds windows that were actually built.
                log::warn!("Failed to restore window {}: {e}", record.id);
                tracker.drop_record(&record.id);
            }
        }
    }

    // Restore focus last, once every window exists.
    if let Some(id) = focused_id {
        let snapshot = tracker.snapshot();
        if let Some(rec) = snapshot.windows.iter().find(|w| w.id == id) {
            if let Some(w) = app.get_webview_window(&rec.label) {
                let _ = w.set_focus();
            }
        }
    }

    commands::refresh_menu(app);
    log::info!("Restored {} window(s) from the registry.", tracker.snapshot().windows.len());
}

/// Put a restored window back where it was, unless that place no longer exists.
fn apply_geometry(
    window: &tauri::WebviewWindow,
    record: &crate::window_registry::WindowRecord,
    monitors: &[crate::window_registry::MonitorRect],
) {
    if !crate::window_registry::is_reachable(record, monitors) {
        log::info!(
            "Window {} was last seen at {},{} which is no longer on any monitor; centering it.",
            record.id,
            record.x,
            record.y
        );
        let _ = window.center();
        return;
    }
    let _ = window.set_position(tauri::PhysicalPosition::new(record.x, record.y));
    let _ = window.set_size(tauri::PhysicalSize::new(record.width, record.height));
    if record.maximized {
        let _ = window.maximize();
    }
}

/// Build a restored secondary window with exactly the configuration
/// `open_new_window` uses. Any divergence here (GPU args in particular — see
/// `gpu_preference`) makes restored windows behave unlike opened ones.
fn build_restored_window(
    app: &tauri::AppHandle,
    label: &str,
    record: &crate::window_registry::WindowRecord,
    monitors: &[crate::window_registry::MonitorRect],
) -> Result<tauri::WebviewWindow, String> {
    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        label,
        // No `?newWindow=1`: a restored window MUST restore its session.
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title(crate::profile::decorate_title("TermFlow"))
    .inner_size(record.width as f64, record.height as f64)
    .resizable(true)
    .decorations(cfg!(target_os = "macos"));

    if crate::window_registry::is_reachable(record, monitors) {
        builder = builder.position(record.x as f64, record.y as f64);
    } else {
        builder = builder.center();
    }

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }

    // Must match every other webview's arguments exactly -- see gpu_preference.
    #[cfg(windows)]
    {
        builder = builder.additional_browser_args(crate::gpu_preference::browser_args());
    }

    let window = builder.build().map_err(|e| e.to_string())?;
    if record.maximized {
        let _ = window.maximize();
    }
    Ok(window)
}

pub(crate) fn show_or_focus_main_window(app: &tauri::AppHandle) {
    let target = app.get_webview_window("main").or_else(|| {
        app.webview_windows()
            .into_iter()
            .find(|(label, _)| label.as_str() != "drag-preview")
            .map(|(_, w)| w)
    });
    if let Some(win) = target {
        // Restores AND makes the webview visible again. A tray click is the most likely way
        // to reach a window whose webview was hidden on minimize, so this is the path that
        // would show the blank window if the restore relied on an event arriving.
        crate::webview_power::restore_and_focus(&win);
    } else if let Err(e) = commands::open_new_window(app, None) {
        log::warn!("Tray show: failed to open a new window: {}", e);
    }
}
