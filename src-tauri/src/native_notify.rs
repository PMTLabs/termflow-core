#[cfg(windows)]
const APP_USER_MODEL_ID: &str = "app.termflow.desktop";

/// True when this process runs from a Velopack install (`<root>\current\
/// termflow.exe` with the updater stub at `<root>\Update.exe`). Dev builds run
/// from the repo target dir and portable unzips lack Update.exe → false.
#[cfg(windows)]
fn is_velopack_install() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|exe| {
            exe.parent()
                .and_then(|cur| cur.parent())
                .map(|root| root.join("Update.exe").exists())
        })
        .unwrap_or(false)
}

/// Shell identity for THIS instance: (AUMID, Start-menu .lnk name, display
/// name). The INSTALLED app owns the canonical identity; a dev/portable build
/// gets a separate ".dev" identity so its always-rewritten toast shortcut can
/// never hijack the installed app's Start-menu entry (which once left "TermFlow"
/// launching a repo `target\release` exe).
#[cfg(windows)]
fn shell_identity(installed: bool) -> (&'static str, &'static str, &'static str) {
    if installed {
        (APP_USER_MODEL_ID, "TermFlow.lnk", "TermFlow")
    } else {
        ("app.termflow.desktop.dev", "TermFlow Dev.lnk", "TermFlow Dev")
    }
}

#[cfg(all(test, windows))]
mod shell_identity_tests {
    use super::shell_identity;

    #[test]
    fn installed_owns_canonical_identity() {
        let (aumid, lnk, name) = shell_identity(true);
        assert_eq!(aumid, "app.termflow.desktop");
        assert_eq!(lnk, "TermFlow.lnk");
        assert_eq!(name, "TermFlow");
    }

    /// The hijack regression: a non-installed build must NEVER write the
    /// installed app's shortcut or share its AUMID.
    #[test]
    fn dev_identity_is_fully_separate() {
        let (aumid, lnk, name) = shell_identity(false);
        assert_ne!(aumid, "app.termflow.desktop");
        assert_ne!(lnk, "TermFlow.lnk");
        assert_ne!(name, "TermFlow");
    }
}

#[cfg(windows)]
fn ensure_start_menu_shortcut() -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::{Interface, PCWSTR, PWSTR};
    use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
    use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
    use windows::Win32::System::Com::StructuredStorage::{
        PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::System::Variant::VT_LPWSTR;
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

    let (aumid, lnk_name, description) = shell_identity(is_velopack_install());
    let app_data = std::env::var_os("APPDATA")
        .ok_or_else(|| "APPDATA is not set; cannot create notification shortcut".to_string())?;
    let shortcut_path = std::path::PathBuf::from(app_data)
        .join(r"Microsoft\Windows\Start Menu\Programs")
        .join(lnk_name);
    // Always (re)write OUR OWN shortcut rather than skip-if-exists. The process
    // sets an explicit AUMID, so the taskbar sources the window's icon from THIS
    // shortcut — and a stale target (e.g. the exe was renamed) leaves that icon
    // generic because it can no longer be resolved. Rewriting every launch keeps
    // the target + icon pointed at the CURRENT exe. `shell_identity` guarantees a
    // dev/portable build rewrites "TermFlow Dev.lnk", never the installed app's.

    if let Some(parent) = shortcut_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            format!(
                "failed to create Start Menu shortcut directory {}: {e}",
                parent.display()
            )
        })?;
    }

    let exe = std::env::current_exe()
        .map_err(|e| format!("failed to resolve executable for notification shortcut: {e}"))?;
    let exe_wide: Vec<u16> = exe.as_os_str().encode_wide().chain(Some(0)).collect();
    let description_wide: Vec<u16> = description.encode_utf16().chain(Some(0)).collect();
    let shortcut_wide: Vec<u16> = shortcut_path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let mut aumid_wide: Vec<u16> = aumid.encode_utf16().chain(Some(0)).collect();

    // CoInitializeEx returns S_FALSE when COM was already initialized in this
    // apartment; that still requires a matching CoUninitialize. If another
    // apartment model is already active (RPC_E_CHANGED_MODE), COM is usable and
    // must not be uninitialized by us.
    let init_result = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    let uninitialize = if init_result.is_ok() {
        true
    } else if init_result == RPC_E_CHANGED_MODE {
        false
    } else {
        return Err(format!(
            "failed to initialize COM for notification shortcut: {init_result:?}"
        ));
    };
    struct ComGuard(bool);
    impl Drop for ComGuard {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }
    let _com_guard = ComGuard(uninitialize);

    // SAFETY: COM is initialized on this thread, all PCWSTR values point to
    // NUL-terminated buffers that remain alive through the calls, and each cast
    // targets an interface implemented by the ShellLink COM object.
    unsafe {
        let shell_link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
            .map_err(|e| format!("failed to create ShellLink: {e}"))?;
        shell_link
            .SetPath(PCWSTR(exe_wide.as_ptr()))
            .map_err(|e| format!("failed to set notification shortcut target: {e}"))?;
        // Explicit icon = the exe itself (resource index 0). This is the source
        // of the AUMID-grouped taskbar icon; pinning it to the current exe keeps
        // it valid even if the target were ever a launcher/renamed.
        shell_link
            .SetIconLocation(PCWSTR(exe_wide.as_ptr()), 0)
            .map_err(|e| format!("failed to set notification shortcut icon: {e}"))?;
        shell_link
            .SetDescription(PCWSTR(description_wide.as_ptr()))
            .map_err(|e| format!("failed to set notification shortcut description: {e}"))?;

        let property_store: IPropertyStore = shell_link
            .cast()
            .map_err(|e| format!("failed to open notification shortcut properties: {e}"))?;
        // A scalar VT_LPWSTR whose pwszVal borrows our caller-owned `aumid_wide`
        // buffer. SetValue *copies* the value into the store (the store owns and
        // frees its copy), so the PROPVARIANT we hand it must NOT be cleared:
        // windows-rs implements `Drop for PROPVARIANT` as `PropVariantClear`, which
        // for VT_LPWSTR calls `CoTaskMemFree(pwszVal)` — that would free our Rust
        // `Vec<u16>` allocation through the COM allocator and then double-free it
        // when the Vec drops, corrupting the process heap. Wrapping the whole
        // PROPVARIANT in ManuallyDrop suppresses that Drop; `aumid_wide` stays the
        // sole owner and is freed exactly once, by Rust, at end of scope. (The inner
        // ManuallyDrop is just the union field's required layout, not a Drop guard.)
        let value = std::mem::ManuallyDrop::new(PROPVARIANT {
            Anonymous: PROPVARIANT_0 {
                Anonymous: std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
                    vt: VT_LPWSTR,
                    wReserved1: 0,
                    wReserved2: 0,
                    wReserved3: 0,
                    Anonymous: PROPVARIANT_0_0_0 {
                        pwszVal: PWSTR(aumid_wide.as_mut_ptr()),
                    },
                }),
            },
        });
        property_store
            .SetValue(&PKEY_AppUserModel_ID, &*value)
            .map_err(|e| format!("failed to set notification shortcut AUMID: {e}"))?;
        property_store
            .Commit()
            .map_err(|e| format!("failed to commit notification shortcut AUMID: {e}"))?;

        let persist_file: IPersistFile = shell_link
            .cast()
            .map_err(|e| format!("failed to access notification shortcut file: {e}"))?;
        persist_file
            .Save(PCWSTR(shortcut_wide.as_ptr()), true)
            .map_err(|e| format!("failed to save {}: {e}", shortcut_path.display()))?;
    }

    Ok(())
}

#[cfg(windows)]
pub fn register_app_for_notifications(_app: &tauri::AppHandle) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
    use windows_registry::CURRENT_USER;

    let (aumid, _lnk, display_name) = shell_identity(is_velopack_install());
    let key = CURRENT_USER
        .create(format!(r"SOFTWARE\Classes\AppUserModelId\{aumid}"))
        .map_err(|e| e.to_string())?;
    key.set_string("DisplayName", display_name)
        .map_err(|e| e.to_string())?;
    key.set_string("IconBackgroundColor", "0")
        .map_err(|e| e.to_string())?;

    if let Ok(exe) = std::env::current_exe() {
        if let Err(e) = key.set_hstring("IconUri", &exe.as_path().into()) {
            log::warn!("Failed to set notification IconUri: {}", e);
        }
    }

    // SAFETY: the HSTRING supplies a valid, NUL-terminated immutable string for
    // the duration of the call. This sets process shell identity only.
    unsafe { SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(aumid)) }
        .map_err(|e| e.to_string())?;

    ensure_start_menu_shortcut()
}

/// Claim the notification identity at startup, before any other path can consume the
/// crate's process-global one-shot. See [`ensure_application_set`].
#[cfg(target_os = "macos")]
pub fn register_app_for_notifications(app: &tauri::AppHandle) -> Result<(), String> {
    ensure_application_set(app)
}

/// Linux needs no identity registration — the notification daemon attributes by the
/// `desktop-entry` hint / process name.
#[cfg(all(unix, not(target_os = "macos")))]
pub fn register_app_for_notifications(_app: &tauri::AppHandle) -> Result<(), String> {
    Ok(())
}

/// Focus the window that owns a notification and tell the renderer to open the tab the
/// notification came from.
///
/// This is the ONLY signal permitted to change the active tab. Returning to the app by
/// any other route — clicking the window, alt-tab, restoring from the taskbar — must
/// leave the user on whatever tab they were working in. A focus-regain heuristic once
/// stood in for this and was removed precisely because focus is not consent; do not
/// reintroduce one.
///
/// Shared by every platform's activation path so the three can never drift on what a
/// click means. Best-effort throughout: a missing window still emits, since another
/// window in the same process may be able to serve the route.
pub(crate) fn emit_activation(app: &tauri::AppHandle, window_label: &str, tab_id: &str) {
    use tauri::{Emitter, Manager};

    log::info!("[NOTIFY] click received: window={window_label} tab={tab_id}");
    match app.get_webview_window(window_label) {
        Some(window) => {
            // `set_focus()` alone is NOT enough, and this is the state notifications
            // exist for: with "keep running in the background" the last window is
            // *hidden* on close (see the close handler in lib.rs), and a hidden or
            // minimized window cannot take focus. Without the show/unminimize the click
            // would switch tabs inside a window the user cannot see. Same ordering as
            // `show_or_focus_main_window` in lib.rs, which is the established pattern
            // for surfacing the app from the tray.
            let _ = window.unminimize();
            let _ = window.show();
            if let Err(e) = window.set_focus() {
                log::warn!("[NOTIFY] failed to focus window {window_label}: {e}");
            }
        }
        None => log::warn!("[NOTIFY] activation for missing window label: {window_label}"),
    }

    match app.emit(
        "notification:activated",
        serde_json::json!({ "windowLabel": window_label, "tabId": tab_id }),
    ) {
        Ok(()) => log::info!("[NOTIFY] activation emitted for tab {tab_id}"),
        Err(e) => log::warn!("[NOTIFY] failed to emit activation: {e}"),
    }
}

#[cfg(windows)]
pub fn show_activity_notification(
    app: &tauri::AppHandle,
    window_label: &str,
    tab_id: &str,
    body: &str,
) -> Result<(), String> {
    use windows::core::{IInspectable, Interface, HSTRING};
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::TypedEventHandler;
    use windows::UI::Notifications::{
        ToastActivatedEventArgs, ToastFailedEventArgs, ToastNotification, ToastNotificationManager,
    };

    let launch = serde_json::json!({
        "windowLabel": window_label,
        "tabId": tab_id,
    })
    .to_string();
    let xml = format!(
        r#"<toast launch="{}"><visual><binding template="ToastGeneric"><text>TermFlow</text><text>{}</text></binding></visual></toast>"#,
        escape_xml_attribute(&launch),
        escape_xml_text(body),
    );

    let document = XmlDocument::new().map_err(|e| e.to_string())?;
    document
        .LoadXml(&HSTRING::from(xml))
        .map_err(|e| e.to_string())?;
    let toast = ToastNotification::CreateToastNotification(&document).map_err(|e| e.to_string())?;

    let app = app.clone();
    let fallback_window_label = window_label.to_owned();
    let fallback_tab_id = tab_id.to_owned();
    let activated =
        TypedEventHandler::<ToastNotification, IInspectable>::new(move |_, inspectable| {
            let route = inspectable
                .as_ref()
                .and_then(|value| value.cast::<ToastActivatedEventArgs>().ok())
                .and_then(|args| args.Arguments().ok())
                .and_then(|args| serde_json::from_str::<serde_json::Value>(&args.to_string()).ok());

            let activated_window_label = route
                .as_ref()
                .and_then(|value| value.get("windowLabel"))
                .and_then(|value| value.as_str())
                .unwrap_or(&fallback_window_label);
            let activated_tab_id = route
                .as_ref()
                .and_then(|value| value.get("tabId"))
                .and_then(|value| value.as_str())
                .unwrap_or(&fallback_tab_id);

            emit_activation(&app, activated_window_label, activated_tab_id);
            Ok(())
        });
    toast.Activated(&activated).map_err(|e| e.to_string())?;

    let failed =
        TypedEventHandler::<ToastNotification, ToastFailedEventArgs>::new(move |_, args| {
            match args.as_ref().and_then(|args| args.ErrorCode().ok()) {
                Some(error_code) => {
                    log::error!("Windows toast delivery failed: {error_code:?}")
                }
                None => log::error!("Windows toast delivery failed without an error code"),
            }
            Ok(())
        });
    toast.Failed(&failed).map_err(|e| e.to_string())?;

    // Show only queues delivery. The Failed handler observes asynchronous WinRT
    // failures, but Windows can still suppress a toast without reporting one.
    let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(
        shell_identity(is_velopack_install()).0,
    ))
    .map_err(|e| e.to_string())?;
    notifier.Show(&toast).map_err(|e| e.to_string())
}

/// Bounds how many OS threads may sit parked waiting for a notification click.
///
/// macOS and Linux both surface the click by *blocking* a thread for the notification's
/// lifetime. Linux threads normally end on their own (a close arrives as the pseudo-action
/// `"__closed"`), but a daemon that never sends one — and a macOS notification the user
/// simply ignores — parks its thread indefinitely. The cap keeps that bounded; past it we
/// still deliver the notification and only give up the click routing.
#[cfg(not(windows))]
mod waiter {
    use std::sync::atomic::{AtomicUsize, Ordering};

    pub const MAX_WAITERS: usize = 8;
    static ACTIVE: AtomicUsize = AtomicUsize::new(0);

    /// Reserve a slot, or `None` once `MAX_WAITERS` are outstanding.
    ///
    /// `fetch_update` rather than load-then-add: two notifications arriving together
    /// would both observe `n < MAX` and both increment, overshooting the cap.
    pub fn acquire() -> Option<Guard> {
        ACTIVE
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < MAX_WAITERS).then_some(n + 1)
            })
            .ok()
            .map(|_| Guard)
    }

    /// Releases the slot on *every* exit path, panics included — a manual decrement at
    /// the end of the thread body would leak the slot on unwind, and eight leaked slots
    /// disable click routing permanently.
    pub struct Guard;

    impl Drop for Guard {
        fn drop(&mut self) {
            ACTIVE.fetch_sub(1, Ordering::AcqRel);
        }
    }
}

/// Claim this process's macOS notification identity.
///
/// `mac-notification-sys` guards `set_application` with a process-global `Once`, so the
/// FIRST caller in the process wins and every later call returns `AlreadySet`. Two things
/// follow:
///
/// 1. This must run at startup, before anything else notifies. `tauri-plugin-notification`
///    calls `set_application` itself on its first desktop notification, and TermFlow
///    already has such a path (`fabric_manager::maybe_notify_pairing`). Losing that race
///    is not fatal — the plugin sets the same identity we would — but leaving it to chance
///    is how the notification ends up attributed to Finder: with no explicit call at all,
///    the crate's internal fallback resolves `"use_default"` to `com.apple.Finder`.
/// 2. `AlreadySet` is success, not failure. Treating it as an error would send every
///    notification after the first down the no-click plugin fallback.
///
/// The dev-vs-release identifier split mirrors `tauri-plugin-notification` exactly: in a
/// dev build `app.termflow.desktop` does not resolve to an installed bundle, and Launch
/// Services rejects it.
#[cfg(target_os = "macos")]
fn ensure_application_set(app: &tauri::AppHandle) -> Result<(), String> {
    use mac_notification_sys::error::{ApplicationError, Error as MacError};
    use std::sync::OnceLock;

    // OnceLock<Result>, not a bare Once: a bare Once discards the outcome, so a failed
    // first attempt would look like success to every later caller.
    static RESULT: OnceLock<Result<(), String>> = OnceLock::new();

    RESULT
        .get_or_init(|| {
            let identifier = if tauri::is_dev() {
                "com.apple.Terminal".to_string()
            } else {
                app.config().identifier.clone()
            };
            match mac_notification_sys::set_application(&identifier) {
                Ok(()) => {
                    log::info!("[NOTIFY] macOS notification identity set to {identifier}");
                    Ok(())
                }
                // NB: the crate builds this error from the identifier WE just passed,
                // not from whoever won, so it tells us nothing about which identity is
                // actually installed — do not log it as if it did. It is still success:
                // an explicit setter ran, which is all we need to avoid the Finder
                // fallback.
                Err(MacError::Application(ApplicationError::AlreadySet(_))) => {
                    log::info!(
                        "[NOTIFY] macOS notification identity was already claimed by an \
                         earlier caller (wanted {identifier}); leaving it as-is"
                    );
                    Ok(())
                }
                Err(e) => Err(format!("failed to set macOS notification identity: {e}")),
            }
        })
        .clone()
}

#[cfg(target_os = "macos")]
pub fn show_activity_notification(
    app: &tauri::AppHandle,
    window_label: &str,
    tab_id: &str,
    body: &str,
) -> Result<(), String> {
    ensure_application_set(app)?;

    let app = app.clone();
    let window_label = window_label.to_owned();
    let tab_id = tab_id.to_owned();
    let body = body.to_owned();

    // Reserve the click-waiter slot on THIS thread so the cap decision is made before we
    // commit to a thread, and so the guard's lifetime covers the whole waiter.
    let slot = waiter::acquire();
    let wants_click = slot.is_some();
    if !wants_click {
        log::warn!(
            "[NOTIFY] waiter cap ({}) reached; delivering tab {tab_id} without click routing",
            waiter::MAX_WAITERS
        );
    }

    // Everything runs off-thread. `send()` blocks until the click when we are waiting for
    // one — but it also blocks for up to 2s waiting on delivery confirmation even when we
    // are NOT (objc/notify.m). This is a synchronous Tauri command, so doing either on the
    // caller's thread would stall the renderer's IPC.
    std::thread::Builder::new()
        .name("termflow-notify-macos".into())
        .spawn(move || {
            let _slot = slot; // released here on every path, including a panic
            log::info!("[NOTIFY] delivery requested for tab {tab_id} (click routing: {wants_click})");

            match mac_notification_sys::Notification::new()
                .title("TermFlow")
                .message(body.as_str())
                .wait_for_click(wants_click)
                .send()
            {
                Ok(mac_notification_sys::NotificationResponse::Click) => {
                    emit_activation(&app, &window_label, &tab_id);
                }
                Ok(other) => {
                    log::info!("[NOTIFY] notification for tab {tab_id} closed without a click: {other:?}");
                }
                Err(e) => log::warn!("[NOTIFY] macOS delivery failed for tab {tab_id}: {e}"),
            }
        })
        .map_err(|e| format!("failed to spawn macOS notification thread: {e}"))?;

    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn show_activity_notification(
    app: &tauri::AppHandle,
    window_label: &str,
    tab_id: &str,
    body: &str,
) -> Result<(), String> {
    // `show()` is synchronous, so a missing D-Bus session or a dead daemon surfaces HERE
    // and reaches the plugin fallback in commands.rs. Registering the action id "default"
    // asks for the freedesktop body-click activation; spec-compliant servers do not draw
    // it as a button, though presentation is ultimately the server's choice.
    let handle = notify_rust::Notification::new()
        .summary("TermFlow")
        .body(body)
        .action("default", "Open")
        .show()
        .map_err(|e| format!("failed to show notification: {e}"))?;

    log::info!("[NOTIFY] delivery accepted by the notification daemon for tab {tab_id}");

    let Some(slot) = waiter::acquire() else {
        log::warn!(
            "[NOTIFY] waiter cap ({}) reached; tab {tab_id} delivered without click routing",
            waiter::MAX_WAITERS
        );
        return Ok(());
    };

    let app = app.clone();
    let window_label = window_label.to_owned();
    let tab_id_for_thread = tab_id.to_owned();

    // Two known limits, neither of which can lose a notification:
    //
    // 1. The zbus backend only installs its signal match rules inside `wait_for_action`,
    //    so an action or close arriving in the gap between `show()` above and the thread
    //    starting can be missed. The cost is a lost click.
    // 2. On Wayland this does NOT guarantee the window is raised. The spec lets a server
    //    send an `ActivationToken` (an xdg-activation token) just before `ActionInvoked`;
    //    notify-rust never subscribes to it and hands us only the action string, so our
    //    `set_focus()` is an unsolicited request the compositor may refuse. Tab routing
    //    is reliable; surfacing the window is best-effort. Fixing it properly needs a
    //    lower-level D-Bus subscription than this API exposes.
    let spawned = std::thread::Builder::new()
        .name("termflow-notify-linux".into())
        .spawn(move || {
            let _slot = slot; // released on every path, including a panic
            handle.wait_for_action(|action: &str| {
                if action == "default" {
                    emit_activation(&app, &window_label, &tab_id_for_thread);
                }
            });
        });

    // The notification is already on screen, so a thread-spawn failure must NOT return
    // Err — that would make commands.rs deliver a second, duplicate toast via the plugin.
    if let Err(e) = spawned {
        log::warn!("[NOTIFY] could not spawn waiter for tab {tab_id}; no click routing: {e}");
    }

    Ok(())
}

#[cfg(windows)]
fn escape_xml_attribute(value: &str) -> String {
    escape_xml(value)
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(windows)]
fn escape_xml_text(value: &str) -> String {
    escape_xml(value)
}

#[cfg(windows)]
fn escape_xml(value: &str) -> String {
    value
        .chars()
        .map(|c| {
            if is_valid_xml_1_0_char(c) {
                c
            } else {
                '\u{fffd}'
            }
        })
        .collect::<String>()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(windows)]
fn is_valid_xml_1_0_char(c: char) -> bool {
    matches!(c, '\u{9}' | '\u{a}' | '\u{d}' | '\u{20}'..='\u{d7ff}' | '\u{e000}'..='\u{fffd}' | '\u{10000}'..='\u{10ffff}')
}
