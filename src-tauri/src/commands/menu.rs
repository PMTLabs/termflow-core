//! The macOS application menu (including the per-window Window submenu) and
//! window-title plumbing. Split out of the former `commands.rs`.

use tauri::{Manager, State};
use crate::state::AppState;
// Only used inside `build_app_menu`, which is macOS-only (see its own doc
// comment) — gated so a non-macOS build doesn't warn on it.
#[cfg(target_os = "macos")]
use super::drag::PREVIEW_LABEL;

/// Build the full app menu, including a Window submenu that lists every open
/// window (so the user can jump to any of them). Built manually (rather than from
/// the platform default) so we can own the Window list and the File submenu.
///
/// macOS only: the menu lives in the global menu bar there. On Windows/Linux a
/// native menu renders as an in-window menu bar that duplicates our custom title
/// bar, so we never build or install one (see `refresh_menu`).
#[cfg(target_os = "macos")]
fn build_app_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};

    let app_menu = SubmenuBuilder::new(app, "TermFlow")
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let new_window = MenuItemBuilder::with_id("new_window", "New Window")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new_window)
        .separator()
        .close_window()
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    // Window submenu: standard items, then one entry per open window. The focused
    // window shows a checkmark; clicking an entry activates that window (handled in
    // lib.rs `on_menu_event`, id `focus:<label>`).
    let mut window_builder = SubmenuBuilder::new(app, "Window").minimize().separator();
    // Prefer the renderer-reported title (active tab) from AppState; fall back to
    // the native window title only if no report has arrived yet.
    let reported = app.try_state::<AppState>().map(|s| s.window_titles.clone());
    let mut entries: Vec<(String, String, bool)> = app
        .webview_windows()
        .iter()
        .filter(|(label, _)| label.as_str() != PREVIEW_LABEL)
        .map(|(label, w)| {
            let title = reported
                .as_ref()
                .and_then(|m| m.get(label).map(|r| r.value().clone()))
                .or_else(|| w.title().ok())
                .unwrap_or_else(|| label.clone());
            let focused = w.is_focused().unwrap_or(false);
            (label.clone(), title, focused)
        })
        .collect();
    entries.sort_by(|a, b| a.1.to_lowercase().cmp(&b.1.to_lowercase()));
    for (label, title, focused) in entries {
        let item = CheckMenuItemBuilder::with_id(format!("focus:{}", label), title)
            .checked(focused)
            .build(app)?;
        window_builder = window_builder.item(&item);
    }
    let window_menu = window_builder.build()?;

    MenuBuilder::new(app)
        .items(&[&app_menu, &file_menu, &edit_menu, &window_menu])
        .build()
}

/// Rebuild and apply the app menu. Call whenever the set of windows (or their
/// titles) changes so the Window submenu stays current.
pub fn refresh_menu(app: &tauri::AppHandle) {
    // macOS shows the app menu in the global menu bar. On Windows/Linux a native
    // menu becomes an in-window menu bar that duplicates the custom title bar, so
    // we install nothing there.
    #[cfg(target_os = "macos")]
    match build_app_menu(app) {
        Ok(menu) => {
            if let Err(e) = app.set_menu(menu) {
                log::error!("Failed to set menu: {}", e);
            }
        }
        Err(e) => log::error!("Failed to build menu: {}", e),
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Renderer-triggered menu refresh (e.g. after a window updates its title to the
/// active tab name) so the Window list shows meaningful names.
#[tauri::command]
pub fn refresh_window_menu(app_handle: tauri::AppHandle) {
    refresh_menu(&app_handle);
}

/// Set the calling window's display title (the active tab's title) and rebuild the
/// Window menu. The title is recorded in AppState first so the menu reads it
/// synchronously — no race against the not-yet-committed native title. We also set
/// the native title so macOS Mission Control / window lists stay in sync.
#[tauri::command]
pub fn set_window_title(
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    title: String,
) {
    // Decorate HERE, not once at startup: this fires on every tab change, so a
    // startup-only mark would vanish the first time the user switched tabs.
    let title = crate::profile::decorate_title(&title);
    state
        .window_titles
        .insert(window.label().to_string(), title.clone());
    let _ = window.set_title(&title);
    refresh_menu(window.app_handle());
}

// ----- Tab tear-off preview window ------------------------------------------
//
// A DOM ghost can't render outside its own window, so the live drag preview is a
// real, frameless, transparent, click-through, always-on-top window that follows
// the cursor across the whole desktop (and other monitors). It loads the app
// bundle with `?dragPreview=1`, which renders only a small window-shaped card.

