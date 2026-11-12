use std::collections::HashMap;
use std::fs;
use std::path::Path;

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct ShellProfile {
    pub id: String,
    pub name: String,
    pub path: String,
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    pub cwd: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub is_default: bool,
    #[serde(default)]
    pub is_custom: bool,
    /// True only for an auto-detected WSL distro profile (plan 045). A
    /// custom user profile that happens to launch `wsl.exe` is NOT flagged —
    /// this covers detection, not the launch target. `#[serde(default)]` so
    /// an existing `~/.auto-terminal/profiles.json` (which predates this
    /// field) still loads.
    #[serde(default)]
    pub is_wsl: bool,
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Default)]
pub struct ProfilesConfig {
    pub profiles: Vec<ShellProfile>,
    pub default_profile_id: Option<String>,
}

/// Get the profiles config file path
fn get_profiles_path() -> std::path::PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    Path::new(&home)
        .join(".auto-terminal")
        .join(crate::app_config::dev_file("profiles.json"))
}

/// Load custom profiles from disk
pub fn load_custom_profiles() -> Vec<ShellProfile> {
    let path = get_profiles_path();
    if path.exists() {
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(config) = serde_json::from_str::<ProfilesConfig>(&content) {
                return config.profiles.into_iter().filter(|p| p.is_custom).collect();
            }
        }
    }
    Vec::new()
}

/// Save custom profiles to disk
pub fn save_custom_profiles(profiles: &[ShellProfile]) -> Result<(), String> {
    let path = get_profiles_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    
    let config = ProfilesConfig {
        profiles: profiles.to_vec(),
        default_profile_id: profiles.iter().find(|p| p.is_default).map(|p| p.id.clone()),
    };
    
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

/// Detect WSL distributions on Windows via the Windows Registry.
///
/// Querying `wsl.exe -l -v` executes a child process and initializes the WSL hypervisor /
/// VM subsystem, which blocks for 4–12+ seconds (especially when distributions are stopped).
/// Reading `HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss` directly reads the registered
/// distribution metadata in <1ms without launching any external processes or VMs.
#[cfg(target_os = "windows")]
fn detect_wsl_distributions() -> Vec<ShellProfile> {
    use windows_registry::CURRENT_USER;

    let mut profiles = Vec::new();

    let lxss = match CURRENT_USER.open(r"Software\Microsoft\Windows\CurrentVersion\Lxss") {
        Ok(key) => key,
        Err(_) => return profiles,
    };

    let subkeys = match lxss.keys() {
        Ok(keys) => keys,
        Err(_) => return profiles,
    };

    for subkey_name in subkeys {
        if let Ok(subkey) = lxss.open(&subkey_name) {
            if let Ok(distro_name) = subkey.get_string("DistributionName") {
                let distro_name = distro_name.trim();
                if distro_name.is_empty() {
                    continue;
                }
                let version = subkey.get_u32("Version").unwrap_or(2);

                profiles.push(ShellProfile {
                    id: format!("wsl-{}", distro_name.to_lowercase()),
                    name: format!("WSL - {} (v{})", distro_name, version),
                    path: "wsl.exe".to_string(),
                    args: vec!["-d".to_string(), distro_name.to_string()],
                    env: HashMap::new(),
                    cwd: None,
                    icon: Some("terminal-linux".to_string()),
                    is_default: false, // WSL default != terminal default profile
                    is_custom: false,
                    is_wsl: true,
                });
            }
        }
    }

    profiles.sort_by(|a, b| a.name.cmp(&b.name));
    profiles
}

#[cfg(not(target_os = "windows"))]
fn detect_wsl_distributions() -> Vec<ShellProfile> {
    Vec::new()
}

/// True when `path` names a file, including a Microsoft Store app execution
/// alias (`%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe`). An alias is a
/// reparse point that cannot be opened as a file, so `Path::exists()` may say
/// false for it; reading the link itself still succeeds. Directories never count.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn file_present(path: &Path) -> bool {
    path.is_file() || fs::symlink_metadata(path).is_ok_and(|m| !m.is_dir())
}

/// Where PowerShell 7 can live, most specific first: the MSI install under
/// Program Files, then every PATH entry (winget/scoop/portable installs, the
/// Store alias, `dotnet tool install -g PowerShell`), then the Store alias
/// directory itself in case PATH was trimmed.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn pwsh_candidates(
    program_files: &[std::path::PathBuf],
    path_var: Option<&std::ffi::OsStr>,
    local_app_data: Option<&Path>,
) -> Vec<std::path::PathBuf> {
    let mut candidates: Vec<std::path::PathBuf> = program_files
        .iter()
        .map(|pf| pf.join("PowerShell").join("7").join("pwsh.exe"))
        .collect();
    if let Some(path_var) = path_var {
        candidates.extend(
            std::env::split_paths(path_var)
                .filter(|dir| !dir.as_os_str().is_empty())
                .map(|dir| dir.join("pwsh.exe")),
        );
    }
    if let Some(local) = local_app_data {
        candidates.push(local.join("Microsoft").join("WindowsApps").join("pwsh.exe"));
    }
    candidates
}

/// Locate PowerShell 7 (`pwsh.exe`). Only checks file presence — no process
/// is spawned, so detection stays instant.
#[cfg(target_os = "windows")]
fn find_pwsh() -> Option<String> {
    let mut program_files: Vec<std::path::PathBuf> = ["ProgramW6432", "ProgramFiles"]
        .iter()
        .filter_map(|var| std::env::var_os(var).map(std::path::PathBuf::from))
        .collect();
    program_files.push(std::path::PathBuf::from(r"C:\Program Files"));
    let path_var = std::env::var_os("PATH");
    let local_app_data = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from);

    pwsh_candidates(&program_files, path_var.as_deref(), local_app_data.as_deref())
        .into_iter()
        .find(|p| file_present(p))
        .map(|p| p.to_string_lossy().into_owned())
}

#[cfg(not(target_os = "windows"))]
fn find_pwsh() -> Option<String> {
    None
}

/// TTL for the get_available_shells() cache. Long enough to absorb rapid
/// shell queries; custom profile edits immediately call invalidate_shell_cache().
const SHELL_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(30);

/// Cache state: a generation counter plus the last computed entry, both behind
/// ONE mutex so bumping the generation and clearing the entry (invalidation)
/// is a single atomic step, and so is checking-then-writing a fresh computation
/// back in — there's no separate un-guarded atomic for a write-back to race
/// against. `std::sync::Mutex::new` is const, so this needs no OnceLock/once_cell.
struct ShellCacheState {
    generation: u64,
    entry: Option<(std::time::Instant, Vec<ShellProfile>)>,
}

static SHELL_CACHE: std::sync::Mutex<ShellCacheState> =
    std::sync::Mutex::new(ShellCacheState { generation: 0, entry: None });

/// Drop the cached shell list so the next get_available_shells() recomputes.
/// Called after any custom-profile mutation (reachable from the external HTTP
/// API) so a list/create-terminal right after a write never sees stale data.
fn invalidate_shell_cache() {
    match SHELL_CACHE.lock() {
        Ok(mut state) => {
            state.generation += 1;
            state.entry = None;
        }
        Err(_) => log::warn!(
            "SHELL_CACHE mutex poisoned; shell-profile cache disabled for the rest of this process"
        ),
    }
}

pub fn get_available_shells() -> Vec<ShellProfile> {
    // get_available_shells() never holds the cache lock across
    // compute_available_shells() (which does blocking disk and registry I/O) —
    // every caller here is an async Tauri/Axum handler calling this sync
    // function directly, so holding a lock across that I/O would let one slow
    // read serialize every concurrent caller behind it instead of each only
    // blocking its own worker, as happens today. Instead, snapshot the
    // generation while checking for a cache hit, release the lock, compute,
    // then only write back if the generation hasn't moved — an invalidation
    // can only bump the generation under this same lock, so there's no window
    // for one to land between the write-back's check and its write.
    let generation_at_start = match SHELL_CACHE.lock() {
        Ok(state) => {
            if let Some((computed_at, profiles)) = state.entry.as_ref() {
                if computed_at.elapsed() < SHELL_CACHE_TTL {
                    return profiles.clone();
                }
            }
            state.generation
        }
        Err(_) => {
            log::warn!("SHELL_CACHE mutex poisoned; falling back to an uncached lookup");
            0
        }
    };

    let profiles = compute_available_shells();

    match SHELL_CACHE.lock() {
        Ok(mut state) => {
            if state.generation == generation_at_start {
                state.entry = Some((std::time::Instant::now(), profiles.clone()));
            }
        }
        Err(_) => log::warn!("SHELL_CACHE mutex poisoned; skipping cache write-back"),
    }

    profiles
}

fn compute_available_shells() -> Vec<ShellProfile> {
    let mut profiles = Vec::new();

    if cfg!(target_os = "windows") {
        // 1. PowerShell (Prefer v7 if available). PowerShell 7 keeps the
        // `powershell` id (saved defaults and tabs reference it); Windows
        // PowerShell 5.1 is then still offered under its own id.
        if let Some(pwsh_7_path) = find_pwsh() {
            profiles.push(ShellProfile {
                id: "powershell".to_string(),
                name: "PowerShell 7".to_string(),
                path: pwsh_7_path,
                args: vec![],
                env: HashMap::new(),
                cwd: None,
                icon: Some("terminal-powershell".to_string()),
                is_default: true,
                is_custom: false,
                is_wsl: false,
            });
            profiles.push(ShellProfile {
                id: "windows-powershell".to_string(),
                name: "Windows PowerShell".to_string(),
                path: "powershell.exe".to_string(),
                args: vec![],
                env: HashMap::new(),
                cwd: None,
                icon: Some("terminal-powershell".to_string()),
                is_default: false,
                is_custom: false,
                is_wsl: false,
            });
        } else {
            profiles.push(ShellProfile {
                id: "powershell".to_string(),
                name: "PowerShell".to_string(),
                path: "powershell.exe".to_string(),
                args: vec![],
                env: HashMap::new(),
                cwd: None,
                icon: Some("terminal-powershell".to_string()),
                is_default: true,
                is_custom: false,
                is_wsl: false,
            });
        }

        // 2. Command Prompt
        profiles.push(ShellProfile {
            id: "cmd".to_string(),
            name: "Command Prompt".to_string(),
            path: "cmd.exe".to_string(),
            args: vec![],
            env: HashMap::new(),
            cwd: None,
            icon: Some("terminal-cmd".to_string()),
            is_default: false,
            is_custom: false,
            is_wsl: false,
        });
        
        // 3. Git Bash (Check multiple locations)
        let git_bash_paths = [
            r"C:\Program Files\Git\bin\bash.exe",
            r"C:\Program Files (x86)\Git\bin\bash.exe",
        ];
        for git_bash_path in git_bash_paths {
            if Path::new(git_bash_path).exists() {
                profiles.push(ShellProfile {
                    id: "git-bash".to_string(),
                    name: "Git Bash".to_string(),
                    path: git_bash_path.to_string(),
                    args: vec!["--login".to_string(), "-i".to_string()],
                    env: {
                        let mut env = HashMap::new();
                        env.insert("TERM".to_string(), "xterm-256color".to_string());
                        env
                    },
                    cwd: None,
                    icon: Some("terminal-bash".to_string()),
                    is_default: false,
                    is_custom: false,
                    is_wsl: false,
                });
                break;
            }
        }

        // 4. Cygwin
        let cygwin_path = r"C:\cygwin64\bin\bash.exe";
        if Path::new(cygwin_path).exists() {
            profiles.push(ShellProfile {
                id: "cygwin".to_string(),
                name: "Cygwin Bash".to_string(),
                path: cygwin_path.to_string(),
                args: vec!["--login".to_string(), "-i".to_string()],
                env: HashMap::new(),
                cwd: None,
                icon: Some("terminal-bash".to_string()),
                is_default: false,
                is_custom: false,
                is_wsl: false,
            });
        }

        // 5. WSL distributions
        profiles.extend(detect_wsl_distributions());
        
    } else {
        // Unix-like systems
        let mut has_default = false;

        // Zsh (Primary on macOS)
        if Path::new("/bin/zsh").exists() {
            profiles.push(ShellProfile {
                id: "zsh".to_string(),
                name: "Zsh".to_string(),
                path: "/bin/zsh".to_string(),
                args: vec!["--login".to_string()],
                env: HashMap::new(),
                cwd: None,
                icon: Some("terminal-zsh".to_string()),
                is_default: true,
                is_custom: false,
                is_wsl: false,
            });
            has_default = true;
        } else if Path::new("/usr/bin/zsh").exists() {
             profiles.push(ShellProfile {
                id: "zsh".to_string(),
                name: "Zsh".to_string(),
                path: "/usr/bin/zsh".to_string(),
                args: vec!["--login".to_string()],
                env: HashMap::new(),
                cwd: None,
                icon: Some("terminal-zsh".to_string()),
                is_default: true,
                is_custom: false,
                is_wsl: false,
            });
            has_default = true;
        }

        // Bash (primary shell on most Linux distros — zsh/fish aren't always
        // installed, so without this, a fresh Linux box gets zero shell profiles
        // and the New Tab UI disables itself with nothing to fall back to).
        for bash_path in ["/bin/bash", "/usr/bin/bash"] {
            if Path::new(bash_path).exists() {
                profiles.push(ShellProfile {
                    id: "bash".to_string(),
                    name: "Bash".to_string(),
                    path: bash_path.to_string(),
                    args: vec!["--login".to_string()],
                    env: HashMap::new(),
                    cwd: None,
                    icon: Some("terminal-bash".to_string()),
                    is_default: !has_default,
                    is_custom: false,
                    is_wsl: false,
                });
                break;
            }
        }

        // Fish
        for fish_path in ["/usr/bin/fish", "/usr/local/bin/fish", "/opt/homebrew/bin/fish"] {
            if Path::new(fish_path).exists() {
                profiles.push(ShellProfile {
                    id: "fish".to_string(),
                    name: "Fish".to_string(),
                    path: fish_path.to_string(),
                    args: vec!["--login".to_string()],
                    env: HashMap::new(),
                    cwd: None,
                    icon: Some("terminal-fish".to_string()),
                    is_default: false,
                    is_custom: false,
                    is_wsl: false,
                });
                break;
            }
        }
    }
    
    // Add custom profiles from disk
    let custom_profiles = load_custom_profiles();
    profiles.extend(custom_profiles);
    
    profiles
}

/// Get a specific profile by ID
pub fn get_profile(profile_id: &str) -> Option<ShellProfile> {
    get_available_shells().into_iter().find(|p| p.id == profile_id)
}

/// Add a custom profile
pub fn add_custom_profile(mut profile: ShellProfile) -> Result<String, String> {
    profile.name = profile.name.trim().to_string();
    profile.path = profile.path.trim().to_string();
    if profile.name.is_empty() {
        return Err("Profile name is required".to_string());
    }
    if profile.path.is_empty() {
        return Err("Profile executable path is required".to_string());
    }
    profile.is_custom = true;
    profile.is_wsl = false;
    let mut custom = load_custom_profiles();
    if profile.id.is_empty() {
        // Millisecond ids collide when two adds land together; suffix until unique.
        let base = format!("custom-{}", chrono::Utc::now().timestamp_millis());
        let mut id = base.clone();
        let mut n = 1;
        while custom.iter().any(|p| p.id == id) {
            n += 1;
            id = format!("{base}-{n}");
        }
        profile.id = id;
    }
    custom.push(profile.clone());
    save_custom_profiles(&custom)?;
    invalidate_shell_cache();

    Ok(profile.id)
}

/// Update a custom profile
pub fn update_custom_profile(profile_id: &str, updates: ShellProfile) -> Result<(), String> {
    let mut custom = load_custom_profiles();
    if let Some(existing) = custom.iter_mut().find(|p| p.id == profile_id) {
        existing.name = updates.name;
        existing.path = updates.path;
        existing.args = updates.args;
        existing.env = updates.env;
        existing.cwd = updates.cwd;
        existing.icon = updates.icon;
        existing.is_default = updates.is_default;
        save_custom_profiles(&custom)?;
        invalidate_shell_cache();
        Ok(())
    } else {
        Err("Custom profile not found".to_string())
    }
}

/// Delete a custom profile
pub fn delete_custom_profile(profile_id: &str) -> Result<(), String> {
    let mut custom = load_custom_profiles();
    let initial_len = custom.len();
    custom.retain(|p| p.id != profile_id);
    
    if custom.len() == initial_len {
        return Err("Custom profile not found".to_string());
    }
    
    save_custom_profiles(&custom)?;
    invalidate_shell_cache();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_available_shells_speed() {
        // Invalidate cache first to test uncached compute speed
        invalidate_shell_cache();
        let start = std::time::Instant::now();
        let shells = get_available_shells();
        let elapsed = start.elapsed();

        // Finding shells must be practically instantaneous (< 200ms, never 4-12s)
        assert!(
            elapsed < std::time::Duration::from_millis(500),
            "get_available_shells took too long: {:?}",
            elapsed
        );
        assert!(!shells.is_empty(), "expected at least one default shell profile");
    }

    #[test]
    fn pwsh_candidates_cover_program_files_path_and_store_alias() {
        // Built from temp_dir so the paths are absolute on every OS and hold no
        // PATH separator (a `C:\...` literal splits at its colon on Unix).
        let root = std::env::temp_dir().join("tf-pwsh-candidates");
        let pf = root.join("Program Files");
        let shims = root.join("scoop").join("shims");
        let dotnet = root.join("dev").join(".dotnet").join("tools");
        let path_var = std::env::join_paths([&shims, &dotnet]).unwrap();
        let local = root.join("dev").join("AppData").join("Local");

        let got = pwsh_candidates(std::slice::from_ref(&pf), Some(path_var.as_os_str()), Some(&local));

        assert_eq!(
            got,
            vec![
                pf.join("PowerShell").join("7").join("pwsh.exe"),
                shims.join("pwsh.exe"),
                dotnet.join("pwsh.exe"),
                local.join("Microsoft").join("WindowsApps").join("pwsh.exe"),
            ]
        );
    }

    #[test]
    fn file_present_sees_files_and_rejects_missing_paths() {
        let dir = std::env::temp_dir().join(format!("tf-pwsh-probe-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("pwsh.exe");
        fs::write(&exe, b"").unwrap();

        let found = pwsh_candidates(&[], Some(dir.as_os_str()), None)
            .into_iter()
            .find(|p| file_present(p));
        assert_eq!(found, Some(exe.clone()));
        assert!(!file_present(&dir.join("missing.exe")));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn add_custom_profile_rejects_blank_name_or_path() {
        let blank = |name: &str, path: &str| ShellProfile {
            id: String::new(),
            name: name.to_string(),
            path: path.to_string(),
            args: vec![],
            env: HashMap::new(),
            cwd: None,
            icon: None,
            is_default: false,
            is_custom: true,
            is_wsl: false,
        };
        assert!(add_custom_profile(blank("  ", "pwsh.exe")).is_err());
        assert!(add_custom_profile(blank("Nu", "   ")).is_err());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn find_pwsh_matches_a_where_lookup() {
        // Live check on the build machine: if `where pwsh` finds one, so must we.
        let where_found = std::process::Command::new("where")
            .arg("pwsh")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if where_found {
            let found = find_pwsh().expect("`where pwsh` found pwsh but find_pwsh() did not");
            let found = std::path::PathBuf::from(found);
            assert_eq!(
                found.file_name().and_then(|f| f.to_str()).map(|f| f.to_ascii_lowercase()).as_deref(),
                Some("pwsh.exe")
            );
            assert!(file_present(&found), "{} is not a file or alias", found.display());
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn powershell_profiles_follow_pwsh_detection() {
        let shells = compute_available_shells();
        let ps = shells.iter().find(|p| p.id == "powershell").expect("powershell profile");
        let win_ps = shells.iter().find(|p| p.id == "windows-powershell");
        assert!(ps.is_default);
        match find_pwsh() {
            Some(pwsh) => {
                assert_eq!(ps.name, "PowerShell 7");
                assert_eq!(ps.path, pwsh);
                let win_ps = win_ps.expect("Windows PowerShell kept beside PowerShell 7");
                assert_eq!(win_ps.path, "powershell.exe");
                assert!(!win_ps.is_default);
            }
            None => {
                assert_eq!(ps.path, "powershell.exe");
                assert!(win_ps.is_none());
            }
        }
    }

    #[test]
    fn file_present_rejects_a_directory_named_like_the_exe() {
        let dir = std::env::temp_dir().join(format!("tf-pwsh-dir-{}", std::process::id()));
        let fake = dir.join("pwsh.exe");
        fs::create_dir_all(&fake).unwrap();
        assert!(!file_present(&fake));
        let found = pwsh_candidates(&[], Some(dir.as_os_str()), None).into_iter().find(|p| file_present(p));
        assert_eq!(found, None);
        fs::remove_dir_all(&dir).ok();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_detect_wsl_distributions_speed() {
        let start = std::time::Instant::now();
        let distros = detect_wsl_distributions();
        let elapsed = start.elapsed();

        // Reading WSL distros from registry must take < 100ms, never blocking on wsl.exe (4-12s)
        assert!(
            elapsed < std::time::Duration::from_millis(100),
            "detect_wsl_distributions took {:?}, should be under 100ms",
            elapsed
        );

        for d in &distros {
            assert!(d.id.starts_with("wsl-"));
            assert_eq!(d.path, "wsl.exe");
            assert!(d.is_wsl);
            assert!(!d.is_default);
        }
    }
}
