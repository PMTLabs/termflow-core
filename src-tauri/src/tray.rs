use crate::commands;
use crate::window_restore::show_or_focus_main_window;
use tauri::Emitter;

/// Build the system tray icon + menu (Plan 010). Reuses the app's default window
/// icon (no new asset). Left-click shows/focuses the main window; the context menu
/// offers Show TermFlow / Peers… / Quit. Tray failure is non-fatal (the app runs
/// without a tray), so background mode simply has no tray affordance in that case.
pub(crate) fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show = MenuItem::with_id(app, "tray_show", "Show TermFlow", true, None::<&str>)?;
    let peers = MenuItem::with_id(app, "tray_peers", "Peers…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray_quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &peers, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        // Left-click is handled by on_tray_icon_event (show window); the menu opens
        // on right-click only, so a left-click doesn't pop the menu instead.
        .show_menu_on_left_click(false)
        // Marked per profile: several instances mean several tray icons.
        .tooltip(crate::profile::decorate_title("TermFlow"))
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray_show" => show_or_focus_main_window(app),
            "tray_peers" => {
                show_or_focus_main_window(app);
                // Best-effort: ask the renderer to jump to Settings → Peers. If no
                // window is listening yet the user still lands on a visible window.
                let _ = app.emit("tray:open-peers", ());
            }
            // Give every window a chance to persist first (plan 018 Task 8):
            // a bare exit(0) fires no CloseRequested, so no renderer would save.
            "tray_quit" => commands::flush_then_exit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_or_focus_main_window(tray.app_handle());
            }
        });

    // Reuse the bundled window icon so no new asset is required.
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}
