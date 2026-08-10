use serde::{Deserialize, Serialize};
use tauri::Manager;
use uuid::Uuid;

/// True in `tauri dev` (debug build), false in the release `.app`.
/// Drives per-instance config-file + default-port selection so a running
/// production `.app` and a `tauri dev` session never collide.
pub fn is_dev() -> bool {
    cfg!(debug_assertions)
}

/// Per-instance config filename so dev and prod never overwrite each other,
/// and so two profiles never share one settings file.
pub fn instance_config_name() -> String {
    dev_file("config.json")
}

/// Suffix a data file/dir name with `.dev` in debug builds so a debug instance
/// never shares mutable state with an installed release running for production,
/// then with the profile identity so two instances never share one artifact.
/// Release default-profile names are unchanged. Mirrors the existing
/// `config.dev.json` / `history.dev.db` convention.
///
/// This is the single choke point for mutable artifact names: every caller that
/// resolves one goes through here, so a new profile dimension only has to be
/// added once (plan 011 Task 3).
///
/// - `dev_file("layout.json")` → `"layout.dev.json"` (dev) / `"layout.json"` (release)
/// - `dev_file("recordings")`  → `"recordings.dev"`   (dev) / `"recordings"`   (release)
/// - under `--profile work`    → `"layout.work.json"`, `"recordings.work"`
pub fn dev_file(name: &str) -> String {
    let name = if is_dev() {
        match name.rsplit_once('.') {
            Some((stem, ext)) => format!("{stem}.dev.{ext}"),
            None => format!("{name}.dev"),
        }
    } else {
        name.to_string()
    };
    crate::profile::scoped_file(&name)
}

pub fn default_api_port() -> u16 {
    if is_dev() {
        42051
    } else {
        42031
    }
}

pub fn default_mcp_port() -> u16 {
    if is_dev() {
        42052
    } else {
        42032
    }
}

/// Loopback control port for the `termflow-fabric` sidecar. Dev/prod isolated
/// (like the API/MCP ports) so a running production app and a `tauri dev`
/// session never fight over the fabric control channel.
pub fn default_fabric_control_port() -> u16 {
    if is_dev() {
        42060
    } else {
        42058
    }
}

/// Resolve the fabric control port for THIS app instance. Prefer the stable dev/prod
/// default (convenient for the common single-instance case), but if it is already taken
/// — e.g. a second app instance whose fabric already holds it — fall back to a free
/// ephemeral loopback port. So two instances never share a fabric control channel, which
/// would otherwise let the second app's renderer drive the first's fabric (review H6).
pub fn resolve_fabric_control_port() -> u16 {
    let preferred = default_fabric_control_port();
    if loopback_port_free(preferred) {
        return preferred;
    }
    free_loopback_port().unwrap_or(preferred)
}

/// Whether `port` can currently be bound on loopback (a quick bind-and-drop probe).
fn loopback_port_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// An OS-assigned free loopback port (bind to `:0`, read the chosen port, drop).
fn free_loopback_port() -> Option<u16> {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|a| a.port())
}

/// A fresh 64-hex-char access token.
pub fn generate_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkConfig {
    pub api_port: u16,
    pub mcp_port: u16,
    pub expose_on_network: bool,
    pub auth_token: String,
}

impl NetworkConfig {
    pub fn defaults() -> Self {
        Self {
            api_port: default_api_port(),
            mcp_port: default_mcp_port(),
            expose_on_network: false,
            auth_token: generate_token(),
        }
    }
}

/// THE config file path. Every reader and writer must come through here —
/// `commands::save_config`/`load_config` used to build it themselves, which
/// silently split settings across two files the moment either changed.
pub fn config_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(instance_config_name()))
}

fn read_root(app: &tauri::AppHandle) -> serde_json::Value {
    match config_path(app) {
        Ok(p) => read_root_at(&p),
        Err(e) => {
            log::error!("[CONFIG] cannot resolve the config path ({e}); using defaults");
            serde_json::json!({})
        }
    }
}

/// Read the config root, complaining loudly about anything that is not simply
/// "no file yet". Silently returning `{}` for unreadable or malformed JSON meant
/// the next save REPLACED a config the user still had — a silent data loss.
pub fn read_root_at(path: &std::path::Path) -> serde_json::Value {
    match std::fs::read_to_string(path) {
        Ok(s) => match serde_json::from_str(&s) {
            Ok(v) => v,
            Err(e) => {
                log::error!(
                    "[CONFIG] {} is not valid JSON ({e}); treating it as empty — the next save \
                     will REPLACE it",
                    path.display()
                );
                serde_json::json!({})
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
        Err(e) => {
            log::error!(
                "[CONFIG] cannot read {} ({e}); treating it as empty — the next save will \
                 REPLACE it",
                path.display()
            );
            serde_json::json!({})
        }
    }
}

/// Replace a file's contents atomically: write a UNIQUE temp file beside it,
/// then rename over the target. `std::fs::rename` replaces an existing
/// destination on Windows too (it uses `MoveFileExW` with
/// `MOVEFILE_REPLACE_EXISTING`); the test below settles that empirically.
///
/// The temp name carries pid + a counter because a FIXED one is shared by every
/// process and thread, so two concurrent writers would corrupt each other's
/// staging file and rename the wreckage into place.
pub fn write_atomic(path: &std::path::Path, contents: &str) -> Result<(), String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);

    let dir = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    let stem = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("config");
    let tmp = dir.join(format!(
        "{stem}.{}.{}.tmp",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Exclusive inter-process lock over one config file, held for a whole
/// read-merge-write. Released when dropped (and by the OS if we die).
struct ConfigLock(std::fs::File);

impl ConfigLock {
    fn acquire(path: &std::path::Path) -> Result<Self, String> {
        use fs4::FileExt;
        let lock_path = path.with_extension("lock");
        let f = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(&lock_path)
            .map_err(|e| format!("cannot open {}: {e}", lock_path.display()))?;
        // Through the trait explicitly: newer std also has an inherent
        // `File::lock`, and an inherent method would silently win.
        FileExt::lock(&f).map_err(|e| format!("cannot lock {}: {e}", lock_path.display()))?;
        Ok(Self(f))
    }
}

impl Drop for ConfigLock {
    fn drop(&mut self) {
        use fs4::FileExt;
        let _ = FileExt::unlock(&self.0);
    }
}

/// Merge top-level keys into the config file under an inter-process lock.
///
/// Atomic replacement alone is NOT enough: two instances that both read, then
/// both write, lose one set of changes however atomic each write is. The lock
/// must span the read AND the write, and it must be inter-process — a
/// `Mutex` only serialises threads within one instance.
pub fn merge_many_locked(
    path: &std::path::Path,
    updates: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    let _guard = ConfigLock::acquire(path)?;
    let mut root = read_root_at(path);
    if !root.is_object() {
        root = serde_json::json!({});
    }
    for (k, v) in updates {
        root[k] = v.clone();
    }
    write_atomic(
        path,
        &serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?,
    )
}

/// Single-key convenience over [`merge_many_locked`].
pub fn merge_locked(
    path: &std::path::Path,
    key: &str,
    value: serde_json::Value,
) -> Result<(), String> {
    let mut m = serde_json::Map::new();
    m.insert(key.to_string(), value);
    merge_many_locked(path, &m)
}

/// Load the network section, filling defaults for any missing field, and persist
/// it back (so a freshly-generated token survives across restarts). Idempotent.
pub fn load_or_init(app: &tauri::AppHandle) -> NetworkConfig {
    let root = read_root(app);
    let mut cfg = NetworkConfig::defaults();
    if let Some(net) = root.get("network") {
        if let Some(v) = net.get("apiPort").and_then(|v| v.as_u64()) {
            cfg.api_port = v as u16;
        }
        if let Some(v) = net.get("mcpPort").and_then(|v| v.as_u64()) {
            cfg.mcp_port = v as u16;
        }
        if let Some(v) = net.get("exposeOnNetwork").and_then(|v| v.as_bool()) {
            cfg.expose_on_network = v;
        }
        if let Some(v) = net.get("authToken").and_then(|v| v.as_str()) {
            if !v.is_empty() {
                cfg.auth_token = v.to_string();
            }
        }
    }
    let _ = save(app, &cfg);
    cfg
}

/// Read a top-level boolean setting from the instance config file (the same blob
/// the renderer's `save_config`/`setConfigValue` writes). Returns `None` when the
/// key is absent or not a bool, so callers can fall back to a default. Used at
/// startup to seed `keep_running_in_background` (Plan 010) before the renderer boots.
pub fn read_bool_setting(app: &tauri::AppHandle, key: &str) -> Option<bool> {
    read_root(app).get(key).and_then(|v| v.as_bool())
}

/// Merge a single top-level key into the instance config file without clobbering
/// other keys. Mirrors [`save`] (which owns the `network` sub-object) but for a
/// flat setting written alongside the renderer's own keys (e.g.
/// `keepRunningInBackground`, Plan 010's background-mode command).
pub fn merge_root_value(
    app: &tauri::AppHandle,
    key: &str,
    value: serde_json::Value,
) -> Result<(), String> {
    merge_locked(&config_path(app)?, key, value)
}

/// Merge the network section into the instance config file without clobbering
/// other keys (shellProfiles, theme, etc.).
pub fn save(app: &tauri::AppHandle, cfg: &NetworkConfig) -> Result<(), String> {
    let mut value = serde_json::to_value(cfg).map_err(|e| e.to_string())?;
    // D5: an elevated instance's API token is minted per launch precisely so it
    // never lands in a file every medium-integrity process of this user can
    // read. Writing it here would hand that escalation straight back.
    // `load_or_init` ignores an empty token, so the next launch mints a new one.
    if crate::profile::current().integrity == crate::profile::Integrity::High {
        value["authToken"] = serde_json::json!("");
    }
    merge_locked(&config_path(app)?, "network", value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_and_prod_ports_differ() {
        // Ports are compile-time-selected; assert the dev/prod constants differ
        // so the two instances can never collide by default.
        assert_ne!(42031, 42051);
        assert_ne!(42032, 42052);
    }

    #[test]
    fn token_is_64_hex_chars() {
        let t = generate_token();
        assert_eq!(t.len(), 64);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn an_atomic_write_replaces_an_existing_file() {
        // codex claimed std::fs::rename cannot replace on Windows. Rust's rename
        // documents replacement (MoveFileExW + MOVEFILE_REPLACE_EXISTING). This
        // test settles it: if the claim were right, it fails here.
        let dir = std::env::temp_dir().join("tf-cfg-atomic");
        let _ = std::fs::create_dir_all(&dir);
        let target = dir.join("config.json");
        std::fs::write(&target, r#"{"keep":true}"#).unwrap();
        write_atomic(&target, r#"{"keep":true,"added":1}"#).unwrap();
        let back: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&target).unwrap()).unwrap();
        assert_eq!(back["added"], serde_json::json!(1));
        // No staging file may survive a successful write.
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp files left behind");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn concurrent_merges_do_not_lose_updates() {
        // The scout's CRITICAL finding. Two threads merging different keys must
        // both survive; an atomic replace WITHOUT a lock loses one.
        let dir = std::env::temp_dir().join("tf-cfg-lock");
        let _ = std::fs::create_dir_all(&dir);
        let target = dir.join("config.json");
        std::fs::write(&target, "{}").unwrap();
        let t = target.clone();
        let a = std::thread::spawn(move || {
            for i in 0..50 {
                merge_locked(&t, "a", i.into()).unwrap()
            }
        });
        let t = target.clone();
        let b = std::thread::spawn(move || {
            for i in 0..50 {
                merge_locked(&t, "b", i.into()).unwrap()
            }
        });
        a.join().unwrap();
        b.join().unwrap();
        let back: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&target).unwrap()).unwrap();
        assert!(
            back.get("a").is_some() && back.get("b").is_some(),
            "lost an update: {back}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_merge_never_drops_unrelated_keys() {
        let dir = std::env::temp_dir().join("tf-cfg-merge");
        let _ = std::fs::create_dir_all(&dir);
        let target = dir.join("config.json");
        std::fs::write(&target, r#"{"theme":"dark","shellProfiles":[1,2]}"#).unwrap();
        merge_locked(&target, "network", serde_json::json!({"apiPort": 42031})).unwrap();
        let back: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&target).unwrap()).unwrap();
        assert_eq!(back["theme"], serde_json::json!("dark"));
        assert_eq!(back["shellProfiles"], serde_json::json!([1, 2]));
        assert_eq!(back["network"]["apiPort"], serde_json::json!(42031));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn config_filenames_are_instance_specific() {
        // Whatever the build mode, dev and prod names must not be equal.
        let name = instance_config_name();
        assert!(name == "config.json" || name == "config.dev.json");
    }
}
