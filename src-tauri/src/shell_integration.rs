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

/// The exe named by a registered `"<exe>" --path "%V"` command, or "" when there is none.
#[cfg_attr(not(windows), allow(dead_code))]
fn command_exe(command: &str) -> &str {
    command.trim_start_matches('"').split('"').next().unwrap_or("")
}

/// True when `command` names no exe, or one that `exists` rejects.
#[cfg_attr(not(windows), allow(dead_code))]
fn command_is_stale(command: &str, exists: impl Fn(&std::path::Path) -> bool) -> bool {
    let exe = command_exe(command);
    exe.is_empty() || !exists(std::path::Path::new(exe))
}

/// Re-point an enabled integration at the running exe when an exe it names is gone. On
/// Windows the entry stores the exe's path at toggle time, so a move or reinstall elsewhere
/// would otherwise leave it dangling until the user toggled it off and on; Linux scripts embed
/// the path the same way but are not checked (see that platform's `is_stale`). A live entry is
/// left alone: nightly and release share the same keys, and neither may take over the other's.
pub fn refresh_if_installed() {
    match platform::is_installed().map(|on| on && platform::is_stale()) {
        Ok(true) => {
            if let Err(error) = platform::install() {
                log::warn!("Failed to refresh file manager integration: {error}");
            }
        }
        Ok(false) => {}
        Err(error) => log::warn!("Failed to check file manager integration: {error}"),
    }
}

#[cfg(any(windows, target_os = "linux"))]
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

    /// True when EITHER registered command (folder or folder background) names an exe that no
    /// longer exists, or cannot be read.
    pub fn is_stale() -> bool {
        [DIRECTORY_KEY, BACKGROUND_KEY].into_iter().any(|key_path| {
            let command = CURRENT_USER
                .open(format!(r"{key_path}\command"))
                .and_then(|key| key.get_string(""))
                .unwrap_or_default();
            super::command_is_stale(&command, |exe| exe.exists())
        })
    }

    pub fn is_installed() -> Result<bool, String> {
        // install() creates BOTH the Directory and Background command keys — report
        // installed only when both are present, so a partial/failed install reads false.
        let directory = CURRENT_USER.open(format!(r"{DIRECTORY_KEY}\command")).is_ok();
        let background = CURRENT_USER.open(format!(r"{BACKGROUND_KEY}\command")).is_ok();
        Ok(directory && background)
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

        // When something is selected, use the first selected path; when nothing is
        // selected (right-click on empty space — the "background" case), fall back to the
        // current folder ($PWD, which Nautilus sets to the viewed directory) so the
        // window is still rooted correctly instead of opening path-less.
        let nautilus_script = format!(
            "#!/bin/sh\ndir=$(printf '%s\\n' \"$NAUTILUS_SCRIPT_SELECTED_FILE_PATHS\" | head -n 1)\n[ -z \"$dir\" ] && dir=\"$PWD\"\nexec \"{quoted_exe}\" --path \"$dir\"\n"
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

    /// Not detected on Linux: the exe is embedded in a script, so only a toggle rewrites it.
    pub fn is_stale() -> bool {
        false
    }

    pub fn is_installed() -> Result<bool, String> {
        let (nautilus_path, kio_path) = integration_paths()?;
        Ok(nautilus_path.exists() || kio_path.exists())
    }
}

#[cfg(target_os = "macos")]
mod platform {
    // A Finder folder action on macOS needs an NSServices/Quick Action declaration in the
    // app bundle's Info.plist plus a service handler — not yet implemented. Report honestly
    // as "not installed / unavailable" so the toggle doesn't claim a feature that isn't
    // wired up. TODO: NSServices Info.plist Quick Action.
    pub fn install() -> Result<(), String> {
        Err("'Open in TermFlow' isn't available on macOS yet".to_string())
    }

    pub fn uninstall() -> Result<(), String> {
        Ok(())
    }

    pub fn is_stale() -> bool {
        false
    }

    pub fn is_installed() -> Result<bool, String> {
        Ok(false)
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

    pub fn is_stale() -> bool {
        false
    }

    pub fn is_installed() -> Result<bool, String> {
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::{command_exe, command_is_stale};
    use std::path::Path;

    const QUOTED: &str = r#""C:\Program Files\TermFlow\termflow.exe" --path "%V""#;

    #[test]
    fn extracts_a_quoted_exe_with_spaces() {
        assert_eq!(command_exe(QUOTED), r"C:\Program Files\TermFlow\termflow.exe");
    }

    #[test]
    fn a_live_exe_is_not_stale_and_a_missing_one_is() {
        assert!(!command_is_stale(QUOTED, |_| true));
        assert!(command_is_stale(QUOTED, |_| false));
    }

    #[test]
    fn the_exe_is_what_gets_checked_not_the_arguments() {
        let seen = std::cell::RefCell::new(String::new());
        command_is_stale(QUOTED, |p: &Path| {
            *seen.borrow_mut() = p.to_string_lossy().into_owned();
            true
        });
        assert_eq!(*seen.borrow(), r"C:\Program Files\TermFlow\termflow.exe");
    }

    #[test]
    fn an_empty_or_unreadable_command_is_stale_without_asking_the_filesystem() {
        assert!(command_is_stale("", |_| panic!("must not be consulted")));
    }
}
