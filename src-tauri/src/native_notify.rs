#[cfg(windows)]
const APP_USER_MODEL_ID: &str = "app.termflow.desktop";

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

    let app_data = std::env::var_os("APPDATA")
        .ok_or_else(|| "APPDATA is not set; cannot create notification shortcut".to_string())?;
    let shortcut_path = std::path::PathBuf::from(app_data)
        .join(r"Microsoft\Windows\Start Menu\Programs\TermFlow.lnk");
    // Always (re)write the shortcut rather than skip-if-exists. The process sets
    // an explicit AUMID, so the taskbar sources the window's icon from THIS
    // shortcut — and a stale target (e.g. the exe was renamed) leaves that icon
    // generic because it can no longer be resolved. Rewriting every launch keeps
    // the target + icon pointed at the CURRENT exe.

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
    let description_wide: Vec<u16> = "TermFlow".encode_utf16().chain(Some(0)).collect();
    let shortcut_wide: Vec<u16> = shortcut_path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let mut aumid_wide: Vec<u16> = APP_USER_MODEL_ID.encode_utf16().chain(Some(0)).collect();

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
        // A scalar VT_LPWSTR is required here; the property store copies the
        // pointed-to value during SetValue, so the backing Vec remains caller-owned.
        let value = PROPVARIANT {
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
        };
        property_store
            .SetValue(&PKEY_AppUserModel_ID, &value)
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
pub fn register_app_for_notifications() -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
    use windows_registry::CURRENT_USER;

    let key = CURRENT_USER
        .create(format!(
            r"SOFTWARE\Classes\AppUserModelId\{APP_USER_MODEL_ID}"
        ))
        .map_err(|e| e.to_string())?;
    key.set_string("DisplayName", "TermFlow")
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
    unsafe { SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(APP_USER_MODEL_ID)) }
        .map_err(|e| e.to_string())?;

    ensure_start_menu_shortcut()
}

#[cfg(not(windows))]
pub fn register_app_for_notifications() -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
pub fn show_activity_notification(
    app: &tauri::AppHandle,
    window_label: &str,
    tab_id: &str,
    body: &str,
) -> Result<(), String> {
    use tauri::{Emitter, Manager};
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

            if let Some(window) = app.get_webview_window(activated_window_label) {
                if let Err(e) = window.set_focus() {
                    log::warn!("Failed to focus notification window: {}", e);
                }
            } else {
                log::warn!(
                    "Notification activated for missing window label: {}",
                    activated_window_label
                );
            }

            if let Err(e) = app.emit(
                "notification:activated",
                serde_json::json!({
                    "windowLabel": activated_window_label,
                    "tabId": activated_tab_id,
                }),
            ) {
                log::warn!("Failed to emit notification activation: {}", e);
            }
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
    let notifier =
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(APP_USER_MODEL_ID))
            .map_err(|e| e.to_string())?;
    notifier.Show(&toast).map_err(|e| e.to_string())
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
