const APP_USER_MODEL_ID: &str = "app.termflow.desktop";

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
        key.set_hstring("IconUri", &exe.as_path().into())
            .map_err(|e| e.to_string())?;
    }

    // SAFETY: the HSTRING supplies a valid, NUL-terminated immutable string for
    // the duration of the call. This sets process shell identity only.
    unsafe { SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(APP_USER_MODEL_ID)) }
        .map_err(|e| e.to_string())
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
        ToastActivatedEventArgs, ToastNotification, ToastNotificationManager,
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
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
