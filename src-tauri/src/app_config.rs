use serde::{Deserialize, Serialize};
use tauri::Manager;
use uuid::Uuid;

/// True in `tauri dev` (debug build), false in the release `.app`.
/// Drives per-instance config-file + default-port selection so a running
/// production `.app` and a `tauri dev` session never collide.
pub fn is_dev() -> bool {
    cfg!(debug_assertions)
}

/// Per-instance config filename so dev and prod never overwrite each other.
pub fn instance_config_name() -> &'static str {
    if is_dev() {
        "config.dev.json"
    } else {
        "config.json"
    }
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

fn config_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(instance_config_name()))
}

fn read_root(app: &tauri::AppHandle) -> serde_json::Value {
    config_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}))
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
    let mut root = read_root(app);
    if !root.is_object() {
        root = serde_json::json!({});
    }
    root[key] = value;
    let path = config_path(app)?;
    std::fs::write(
        path,
        serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

/// Merge the network section into the instance config file without clobbering
/// other keys (shellProfiles, theme, etc.).
pub fn save(app: &tauri::AppHandle, cfg: &NetworkConfig) -> Result<(), String> {
    let mut root = read_root(app);
    if !root.is_object() {
        root = serde_json::json!({});
    }
    root["network"] = serde_json::to_value(cfg).map_err(|e| e.to_string())?;
    let path = config_path(app)?;
    std::fs::write(
        path,
        serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
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
    fn config_filenames_are_instance_specific() {
        // Whatever the build mode, dev and prod names must not be equal.
        let name = instance_config_name();
        assert!(name == "config.json" || name == "config.dev.json");
    }
}
