//! Cross-window tab tear-off: the drag preview window and the target-claim
//! broker for dropping a pane into another window. Split out of the former
//! `commands.rs`.

use tauri::State;
use crate::state::AppState;

// pub(crate): the app menu's Window submenu (menu.rs) filters this label out
// too, so it needs to name the same constant rather than a second copy that
// could drift.
pub(crate) const PREVIEW_LABEL: &str = "drag-preview";
const PREVIEW_W: f64 = 300.0;
const PREVIEW_H: f64 = 195.0;
// Place the card so the cursor sits over its title bar, not the corner.
const PREVIEW_OFFSET_X: f64 = 46.0;
const PREVIEW_OFFSET_Y: f64 = 18.0;

/// Convert a CLIENT (content-relative, logical CSS px) point in `window` to a
/// physical screen position, offset so the preview card sits under the cursor.
/// We use the source window's content origin + scale (reliable, top-left origin)
/// rather than `cursor_position()`, which errors in this app's webview.
fn preview_position(
    window: &tauri::WebviewWindow,
    cx: f64,
    cy: f64,
) -> Option<tauri::PhysicalPosition<f64>> {
    let origin = window.inner_position().ok()?;
    let scale = window.scale_factor().unwrap_or(1.0);
    Some(tauri::PhysicalPosition::new(
        origin.x as f64 + (cx - PREVIEW_OFFSET_X) * scale,
        origin.y as f64 + (cy - PREVIEW_OFFSET_Y) * scale,
    ))
}

/// Percent-encode a string for use as a URL query value (dependency-free).
fn encode_query(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{:02X}", b),
        })
        .collect()
}

/// The tab identity the preview card draws: its name, and the user-set colour that name wears
/// everywhere else. Sent as one payload so the two can never disagree.
#[derive(Clone, serde::Serialize)]
struct PreviewTitle {
    title: String,
    color: Option<String>,
}

/// Show (creating on first use) the tear-off preview at the cursor with `title`.
/// `x`/`y` are CLIENT coords in the calling (source) window.
///
/// `color` travels by BOTH routes below on purpose: the query string when this window is created,
/// and the event when an existing one is reused for another tab. Wiring one alone would colour
/// either the session's first drag or all the others, depending on drag order.
#[tauri::command]
pub async fn show_drag_preview(
    app_handle: tauri::AppHandle,
    window: tauri::WebviewWindow,
    title: String,
    color: Option<String>,
    x: f64,
    y: f64,
) -> Result<(), String> {
    let win = if let Some(w) = app_handle.get_webview_window(PREVIEW_LABEL) {
        // Reuse the existing preview window; just refresh its title and colour.
        let _ = w.emit(
            "drag-preview:title",
            PreviewTitle { title: title.clone(), color: color.clone() },
        );
        w
    } else {
        let url = match color.as_deref() {
            Some(c) => format!(
                "index.html?dragPreview=1&title={}&color={}",
                encode_query(&title),
                encode_query(c),
            ),
            None => format!("index.html?dragPreview=1&title={}", encode_query(&title)),
        };
        #[cfg_attr(not(windows), allow(unused_mut))]
        let mut builder = tauri::WebviewWindowBuilder::new(
            &app_handle,
            PREVIEW_LABEL,
            tauri::WebviewUrl::App(url.into()),
        )
        .inner_size(PREVIEW_W, PREVIEW_H)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .focused(false)
        .visible(false);

        // Must match every other webview's arguments exactly -- see gpu_preference.
        #[cfg(windows)]
        {
            builder = builder.additional_browser_args(crate::gpu_preference::browser_args());
        }

        let w = builder.build().map_err(|e| e.to_string())?;
        // Click-through so it never steals the in-flight drag's pointer events.
        let _ = w.set_ignore_cursor_events(true);
        w
    };

    if let Some(pos) = preview_position(&window, x, y) {
        let _ = win.set_position(pos);
    }
    let _ = win.show();
    Ok(())
}

/// Move the preview to follow the cursor (called per animation frame while
/// dragging). `x`/`y` are CLIENT coords in the calling (source) window.
#[tauri::command]
pub async fn move_drag_preview(
    app_handle: tauri::AppHandle,
    window: tauri::WebviewWindow,
    x: f64,
    y: f64,
) -> Result<(), String> {
    if let Some(win) = app_handle.get_webview_window(PREVIEW_LABEL) {
        if let Some(pos) = preview_position(&window, x, y) {
            let _ = win.set_position(pos);
        }
    }
    Ok(())
}

/// Hide the preview window (kept alive for reuse on the next drag).
#[tauri::command]
pub async fn hide_drag_preview(app_handle: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app_handle.get_webview_window(PREVIEW_LABEL) {
        let _ = win.hide();
    }
    Ok(())
}

/// Source-driven cross-window tab drop. macOS routes a button-drag's events to
/// the SOURCE window, so the destination window can't detect the release itself.
/// Instead the source reports the release point (CLIENT coords in the source
/// window) and we hit-test it against every other window's screen rect. If it
/// lands on one, we tell that window to reattach the tab (it takes the stashed
/// payload by `token`) and return true; otherwise return false so the caller
/// opens a new window. The payload must already be stashed under `token`.
#[tauri::command]
pub fn resolve_tab_drop(
    app_handle: tauri::AppHandle,
    window: tauri::WebviewWindow,
    token: String,
    x: f64,
    y: f64,
) -> Result<bool, String> {
    // Global physical point of the drop, from the source window's content origin.
    let (px, py) = match (window.inner_position(), window.scale_factor()) {
        (Ok(origin), Ok(scale)) => (origin.x as f64 + x * scale, origin.y as f64 + y * scale),
        _ => return Ok(false),
    };
    let source_label = window.label().to_string();
    log::info!(
        "resolve_tab_drop: drop=({:.0},{:.0}) source={} client=({:.0},{:.0})",
        px, py, source_label, x, y
    );
    for (label, w) in app_handle.webview_windows() {
        if label == source_label || label == PREVIEW_LABEL {
            continue;
        }
        if let (Ok(pos), Ok(size)) = (w.outer_position(), w.outer_size()) {
            let hit = point_in_rect(px, py, pos.x as f64, pos.y as f64, size.width as f64, size.height as f64);
            log::info!(
                "  candidate {} rect=({},{} {}x{}) hit={}",
                label, pos.x, pos.y, size.width, size.height, hit
            );
            if hit {
                // Broadcast with the target label in the payload; every window's
                // listener acts only if it IS the target. (Same proven pattern as
                // `app:close-requested`. A bare emit_to wasn't reaching the JS
                // listener, and w.emit would let the source steal its own payload.)
                let _ = app_handle.emit(
                    "tab-drag:reattach",
                    serde_json::json!({ "token": token, "target": label }),
                );
                let _ = w.set_focus(); // bring the receiving window to the front
                // Deliberately NOT restore_and_focus: this path only raises the window, and
                // unminimizing a window the user left minimized would be a behaviour change.
                // But `set_focus` on Windows CAN restore a minimized window, so the webview's
                // visibility has to be re-derived from the window's actual state either way —
                // otherwise a tab dropped into a minimized window reveals a blank one.
                crate::webview_power::sync(&w);
                log::info!("resolve_tab_drop: reattaching into {}", label);
                return Ok(true);
            }
        } else {
            log::info!("  candidate {} position/size unavailable", label);
        }
    }
    log::info!("resolve_tab_drop: no window under drop point -> new window");
    Ok(false)
}

// ----- Cross-window drag broker (Phase 4, target-claims) --------------------
//
// Pointer events don't cross OS windows, so we don't try to guess coordinates
// from the source. Instead: the source registers an active drag and broadcasts
// it; whichever window the user releases over CLAIMS the pane using its own
// accurate local coordinates, then the source is told to remove its pane. If no
// window claims it (released over empty desktop), the source resolves it as an
// orphan and opens a new window.

use tauri::{Manager, Emitter};
use crate::state::GlobalDrag;

/// Pure point-in-rect test. Retained (unit-tested) for any future hit-testing.
pub fn point_in_rect(px: f64, py: f64, rx: f64, ry: f64, rw: f64, rh: f64) -> bool {
    px >= rx && px < rx + rw && py >= ry && py < ry + rh
}

/// Source registers an in-flight cross-window drag and stashes its payload. The
/// `pane-drag:active` broadcast lets every window know it may become a drop target.
#[tauri::command]
pub fn begin_global_pane_drag(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    window: tauri::Window,
    token: String,
    payload: serde_json::Value,
) -> Result<(), String> {
    state.detach_payloads.insert(token.clone(), payload);
    *state.active_global_drag.lock().map_err(|e| e.to_string())? = Some(GlobalDrag {
        token: token.clone(),
        source_label: window.label().to_string(),
    });
    let _ = app_handle.emit("pane-drag:active", token);
    Ok(())
}

/// A window the cursor was released over claims the active drag. Returns the
/// payload (so the claimer can insert the pane) and notifies the source to drop
/// its copy. Single-use: returns None if already claimed/cancelled.
#[tauri::command]
pub fn claim_global_pane_drag(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    token: String,
) -> Result<Option<serde_json::Value>, String> {
    let mut guard = state.active_global_drag.lock().map_err(|e| e.to_string())?;
    match guard.as_ref() {
        Some(g) if g.token == token => {
            let source_label = g.source_label.clone();
            *guard = None;
            drop(guard);
            let payload = state.detach_payloads.remove(&token).map(|(_, v)| v);
            if let Some(src) = app_handle.get_webview_window(&source_label) {
                let _ = src.emit("pane-drag:claimed", token.clone());
            }
            let _ = app_handle.emit("pane-drag:ended", ());
            Ok(payload)
        }
        _ => Ok(None),
    }
}

/// The SOURCE resolves a drag that no window claimed (released over empty desktop)
/// -> it should open a new window. Returns true if this caller still owns the
/// active drag (payload is left stashed for create_detached_window to consume).
#[tauri::command]
pub fn resolve_orphan_global_drag(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    window: tauri::Window,
    token: String,
) -> Result<bool, String> {
    let mut guard = state.active_global_drag.lock().map_err(|e| e.to_string())?;
    match guard.as_ref() {
        Some(g) if g.token == token && g.source_label == window.label() => {
            *guard = None;
            drop(guard);
            let _ = app_handle.emit("pane-drag:ended", ());
            Ok(true)
        }
        _ => Ok(false),
    }
}

/// Cancel an in-flight drag (cursor returned inside the source, or Escape).
#[tauri::command]
pub fn cancel_global_pane_drag(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    token: String,
) -> Result<(), String> {
    let mut guard = state.active_global_drag.lock().map_err(|e| e.to_string())?;
    let owns = matches!(guard.as_ref(), Some(g) if g.token == token);
    if owns {
        *guard = None;
    }
    drop(guard);
    state.detach_payloads.remove(&token);
    let _ = app_handle.emit("pane-drag:ended", ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::point_in_rect;

    #[test]
    fn point_inside_rect() {
        assert!(point_in_rect(50.0, 50.0, 0.0, 0.0, 100.0, 100.0));
        assert!(point_in_rect(0.0, 0.0, 0.0, 0.0, 100.0, 100.0)); // top-left inclusive
    }

    #[test]
    fn point_outside_rect() {
        assert!(!point_in_rect(150.0, 50.0, 0.0, 0.0, 100.0, 100.0));
        assert!(!point_in_rect(100.0, 50.0, 0.0, 0.0, 100.0, 100.0)); // right edge exclusive
        assert!(!point_in_rect(-1.0, 50.0, 0.0, 0.0, 100.0, 100.0));
    }
}

