#[tauri::command]
pub fn install_file_manager_integration() -> Result<(), String> {
    platform::install().map_err(|error| {
        log::error!("Failed to install file manager integration: {error}");
        error
    })
}

#[tauri::command]
pub fn uninstall_file_manager_integration() -> Result<(), String> {
    platform::uninstall().map_err(|error| {
        log::error!("Failed to uninstall file manager integration: {error}");
        error
    })
}

#[tauri::command]
pub fn is_file_manager_integration_installed() -> Result<bool, String> {
    platform::is_installed().map_err(|error| {
        log::error!("Failed to check file manager integration: {error}");
        error
    })
}

fn current_exe() -> Result<std::path::PathBuf, String> {
    std::env::current_exe()
        .map_err(|error| format!("failed to resolve current executable: {error}"))
}

#[cfg(windows)]
mod platform {
    use windows_registry::CURRENT_USER;

    use super::current_exe;

    const DIRECTORY_KEY: &str = r"Software\Classes\Directory\shell\OpenInTermFlow";
    const BACKGROUND_KEY: &str = r"Software\Classes\Directory\Background\shell\OpenInTermFlow";

    pub fn install() -> Result<(), String> {
        let exe = current_exe()?;
        let exe = exe.to_string_lossy();
        let command = format!(r#""{exe}" --path "%V""#);

        for key_path in [DIRECTORY_KEY, BACKGROUND_KEY] {
            let key = CURRENT_USER
                .create(key_path)
                .map_err(|error| format!("failed to create registry key {key_path}: {error}"))?;
            key.set_string("", "Open in TermFlow")
                .map_err(|error| format!("failed to set label on {key_path}: {error}"))?;
            key.set_string("Icon", exe.as_ref())
                .map_err(|error| format!("failed to set icon on {key_path}: {error}"))?;

            let command_path = format!(r"{key_path}\command");
            let command_key = CURRENT_USER.create(&command_path).map_err(|error| {
                format!("failed to create registry key {command_path}: {error}")
            })?;
            command_key
                .set_string("", &command)
                .map_err(|error| format!("failed to set command on {command_path}: {error}"))?;
        }

        log::info!("Installed Windows file manager integration");
        Ok(())
    }

    pub fn uninstall() -> Result<(), String> {
        for key_path in [DIRECTORY_KEY, BACKGROUND_KEY] {
            if CURRENT_USER.open(key_path).is_ok() {
                CURRENT_USER.remove_tree(key_path).map_err(|error| {
                    format!("failed to remove registry key {key_path}: {error}")
                })?;
            }
        }

        log::info!("Uninstalled Windows file manager integration");
        Ok(())
    }

    pub fn is_installed() -> Result<bool, String> {
        let command_path = format!(r"{DIRECTORY_KEY}\command");
        Ok(CURRENT_USER.open(command_path).is_ok())
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};

    use super::current_exe;

    fn integration_paths() -> Result<(PathBuf, PathBuf), String> {
        let home = std::env::var_os("HOME")
            .filter(|home| !home.is_empty())
            .ok_or_else(|| "HOME is not set".to_string())?;
        let home = PathBuf::from(home);
        Ok((
            home.join(".local/share/nautilus/scripts/Open in TermFlow"),
            home.join(".local/share/kio/servicemenus/termflow-open.desktop"),
        ))
    }

    fn shell_double_quoted(path: &Path) -> String {
        path.to_string_lossy()
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('$', "\\$")
            .replace('`', "\\`")
    }

    pub fn install() -> Result<(), String> {
        let exe = current_exe()?;
        let quoted_exe = shell_double_quoted(&exe);
        let (nautilus_path, kio_path) = integration_paths()?;

        let nautilus_script = format!(
            "#!/bin/sh\ndir=$(printf '%s\\n' \"$NAUTILUS_SCRIPT_SELECTED_FILE_PATHS\" | head -n 1)\nexec \"{quoted_exe}\" --path \"$dir\"\n"
        );
        write_file(&nautilus_path, &nautilus_script)?;
        fs::set_permissions(&nautilus_path, fs::Permissions::from_mode(0o755)).map_err(
            |error| {
                format!(
                    "failed to make {} executable: {error}",
                    nautilus_path.display()
                )
            },
        )?;

        let desktop_entry = format!(
            "[Desktop Entry]\nType=Service\nMimeType=inode/directory;\nActions=OpenInTermFlow;\n\n[Desktop Action OpenInTermFlow]\nName=Open in TermFlow\nExec=\"{quoted_exe}\" --path %f\n"
        );
        write_file(&kio_path, &desktop_entry)?;

        log::info!("Installed Linux file manager integration");
        Ok(())
    }

    fn write_file(path: &Path, contents: &str) -> Result<(), String> {
        let parent = path
            .parent()
            .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
        fs::write(path, contents)
            .map_err(|error| format!("failed to write {}: {error}", path.display()))
    }

    pub fn uninstall() -> Result<(), String> {
        let (nautilus_path, kio_path) = integration_paths()?;
        for path in [nautilus_path, kio_path] {
            if path.exists() {
                fs::remove_file(&path)
                    .map_err(|error| format!("failed to remove {}: {error}", path.display()))?;
            }
        }
        log::info!("Uninstalled Linux file manager integration");
        Ok(())
    }

    pub fn is_installed() -> Result<bool, String> {
        let (nautilus_path, kio_path) = integration_paths()?;
        Ok(nautilus_path.exists() || kio_path.exists())
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::current_exe;

    // TODO: NSServices Info.plist Quick Action
    pub fn install() -> Result<(), String> {
        log::info!("macOS file manager integration is best-effort for app bundles");
        Ok(())
    }

    pub fn uninstall() -> Result<(), String> {
        Ok(())
    }

    pub fn is_installed() -> Result<bool, String> {
        let exe = current_exe()?;
        Ok(exe.to_string_lossy().contains(".app/Contents/MacOS"))
    }
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
mod platform {
    pub fn install() -> Result<(), String> {
        Err("file manager integration is not supported on this platform".to_string())
    }

    pub fn uninstall() -> Result<(), String> {
        Err("file manager integration is not supported on this platform".to_string())
    }

    pub fn is_installed() -> Result<bool, String> {
        Ok(false)
    }
}
