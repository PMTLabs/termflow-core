//! Suppresses the WebView2 right-click context menu everywhere the renderer does
//! not draw its own (Windows only).
//!
//! The default Edge/WebView2 menu (Back, Reload, Save as, Print, More tools,
//! Inspect, …) appears wherever the renderer does NOT handle its own
//! `contextmenu` event — e.g. the in-app title bar, the tab strip, the canvas
//! background. It was previously trimmed to Print + Inspect; those two are
//! browser chrome, not TermFlow features, so the menu is now cancelled outright
//! and right-click only ever opens one of the app's own React menus. DevTools
//! moved to Settings → Updates ("Open developer tools").
//!
//! The terminal area calls `preventDefault`, so WebView2 never raises
//! `ContextMenuRequested` there and this filter leaves the terminal's own React
//! menu untouched.

/// Install the context-menu filter on a window's WebView2 instance. No-op on
/// non-Windows platforms (the default menu issue is WebView2-specific).
#[cfg(windows)]
pub fn install(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2ContextMenuRequestedEventArgs, ICoreWebView2_11,
    };
    use webview2_com::ContextMenuRequestedEventHandler;
    use windows::core::Interface;

    let label = window.label().to_string();
    let result = window.with_webview(move |webview| unsafe {
        let core = match webview.controller().CoreWebView2() {
            Ok(c) => c,
            Err(e) => {
                log::warn!("context-menu: CoreWebView2() unavailable: {e}");
                return;
            }
        };
        let core11: ICoreWebView2_11 = match core.cast() {
            Ok(c) => c,
            Err(e) => {
                log::warn!("context-menu: ICoreWebView2_11 unavailable: {e}");
                return;
            }
        };

        let handler = ContextMenuRequestedEventHandler::create(Box::new(
            |_wv, args: Option<ICoreWebView2ContextMenuRequestedEventArgs>| {
                let Some(args) = args else { return Ok(()) };
                // Over an editable target (text input / textarea — e.g. the Settings
                // "Default editor" field) keep the full native menu so Cut / Copy /
                // Paste / Undo / Select all stay available. Trimming to print+inspect
                // there left users unable to right-click → Paste. We only cancel the
                // browser-chrome menu on NON-editable areas.
                if let Ok(target) = args.ContextMenuTarget() {
                    let mut editable = windows_core::BOOL(0);
                    if target.IsEditable(&mut editable).is_ok() && editable.as_bool() {
                        return Ok(());
                    }
                }
                // `Handled = true` tells WebView2 the app owns this menu, so it
                // displays nothing. Removing every item instead would still pop an
                // empty frame.
                args.SetHandled(true)?;
                Ok(())
            },
        ));

        let mut token: i64 = 0;
        if let Err(e) = core11.add_ContextMenuRequested(&handler, &mut token) {
            log::warn!("context-menu: add_ContextMenuRequested failed: {e}");
        }
    });

    if let Err(e) = result {
        log::warn!("context-menu: with_webview failed for '{label}': {e}");
    }
}

#[cfg(not(windows))]
pub fn install(_window: &tauri::WebviewWindow) {}
