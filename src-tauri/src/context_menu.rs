//! Trims the WebView2 right-click context menu to only "Print" and "Inspect"
//! (Windows only).
//!
//! The default Edge/WebView2 menu (Back, Reload, Save as, Print, More tools,
//! Inspect, …) appears wherever the renderer does NOT handle its own
//! `contextmenu` event — e.g. the in-app title bar. The terminal area calls
//! `preventDefault`, so WebView2 never raises `ContextMenuRequested` there and
//! this filter leaves the terminal's own React menu untouched.

/// Item `Name`s of the WebView2 default menu we keep. These are the stable
/// command names exposed by WebView2 (not the localized labels). See
/// https://learn.microsoft.com/microsoft-edge/webview2/concepts/context-menus
#[cfg(windows)]
const KEEP: [&str; 2] = ["print", "inspectElement"];

/// Install the context-menu filter on a window's WebView2 instance. No-op on
/// non-Windows platforms (the default menu issue is WebView2-specific).
#[cfg(windows)]
pub fn install(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2ContextMenuRequestedEventArgs, ICoreWebView2_11,
    };
    use webview2_com::ContextMenuRequestedEventHandler;
    use windows::core::{Interface, PWSTR};
    use windows::Win32::System::Com::CoTaskMemFree;

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
                // there left users unable to right-click → Paste. We only trim the
                // browser-navigation noise on NON-editable areas.
                if let Ok(target) = args.ContextMenuTarget() {
                    let mut editable = windows_core::BOOL(0);
                    if target.IsEditable(&mut editable).is_ok() && editable.as_bool() {
                        return Ok(());
                    }
                }
                let items = args.MenuItems()?;
                let mut count: u32 = 0;
                items.Count(&mut count)?;
                // Walk backward so RemoveValueAtIndex doesn't shift indices we
                // haven't visited yet.
                for i in (0..count).rev() {
                    let item = items.GetValueAtIndex(i)?;
                    let mut name_ptr = PWSTR::null();
                    item.Name(&mut name_ptr)?;
                    let name = if name_ptr.is_null() {
                        String::new()
                    } else {
                        let s = name_ptr.to_string().unwrap_or_default();
                        // WebView2 allocates the string with CoTaskMemAlloc; free it.
                        CoTaskMemFree(Some(name_ptr.0 as *const core::ffi::c_void));
                        s
                    };
                    if !KEEP.contains(&name.as_str()) {
                        items.RemoveValueAtIndex(i)?;
                    }
                }
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
