//! Port selection for an instance that may not be the only one running.
//!
//! Two rules, both learned the hard way:
//!
//! 1. **Bind as you pick, and keep what you bound.** `bind_reuseaddr` sets
//!    `SO_REUSEADDR` (required for the hot-restart rebind), so a bind SUCCEEDS
//!    even when another process already holds the port — bind failure cannot
//!    detect a conflict. Probing then binding leaves a window in between, and
//!    with per-profile instances two apps starting together is normal rather
//!    than a freak race. So the picker returns the LISTENER, which the server
//!    then consumes; nothing re-binds the port afterwards.
//!
//! 2. **Configured is not effective.** A fallback port must never be written
//!    back to the config, or the user's chosen port silently drifts every time
//!    a sibling happens to hold it. `AppState` therefore carries both.

use crate::network_commands::{bind_reuseaddr, probe_port_owner, PortOwner};

/// How many consecutive ports to try before giving up.
pub const DEFAULT_SPAN: u16 = 20;

/// A port and whatever was acquired for it.
#[derive(Debug)]
pub struct Picked<T> {
    pub port: u16,
    pub bound: T,
}

/// The ports this instance ACTUALLY serves on, which may differ from the
/// configured ones when a sibling instance got there first. Settings shows both;
/// only the configured values are ever persisted.
#[derive(Debug, Clone, Copy, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveEndpoints {
    /// `None` until the API has actually bound, or when it is suppressed.
    pub api_port: Option<u16>,
    /// `None` until the MCP sidecar has been given a port, or when suppressed.
    pub mcp_port: Option<u16>,
}

/// The ports to try, in order. Stops at `u16::MAX` rather than wrapping.
pub fn candidates(start: u16, span: u16) -> impl Iterator<Item = u16> {
    (0..span).map_while(move |i| start.checked_add(i))
}

/// Take the first port `acquire` accepts. Pure, so the selection rule is
/// testable without a network.
pub fn pick_bound_with<T>(
    start: u16,
    span: u16,
    mut acquire: impl FnMut(u16) -> Option<T>,
) -> Option<Picked<T>> {
    for port in candidates(start, span) {
        if let Some(bound) = acquire(port) {
            return Some(Picked { port, bound });
        }
    }
    None
}

/// Bind the first free port at or after `start`, and RETURN the listener.
///
/// A port answering `/health` with someone else's instance id is skipped without
/// binding: `SO_REUSEADDR` would let us steal it, and stealing the API port
/// silently reroutes the other instance's MCP tool calls into this app.
pub async fn bind_api_listener(
    host: [u8; 4],
    start: u16,
    span: u16,
    own_id: &str,
) -> Option<Picked<tokio::net::TcpListener>> {
    for port in candidates(start, span) {
        if probe_port_owner(port, own_id).await == PortOwner::OwnedByOther {
            log::info!("[NET] port {port} is owned by another instance; trying the next");
            continue;
        }
        let addr = std::net::SocketAddr::from((host, port));
        match bind_reuseaddr(addr) {
            Ok(listener) => {
                if port != start {
                    log::warn!(
                        "[NET] configured API port {start} was unavailable; serving on {port} \
                         instead (the configured value is unchanged)"
                    );
                }
                return Some(Picked { port, bound: listener });
            }
            Err(e) => log::warn!("[NET] bind {addr} failed: {e}; trying the next port"),
        }
    }
    log::error!("[NET] no free API port in {start}..{}", start.saturating_add(span));
    None
}

/// Choose an MCP port. Unlike the API we cannot hold this socket — the sidecar
/// is a separate process that binds it itself — so this is a probe, and the
/// identity check in `wait_for_mcp_health` is what actually proves we got it.
pub async fn pick_mcp_port(start: u16, span: u16, own_id: &str) -> Option<u16> {
    for port in candidates(start, span) {
        if probe_port_owner(port, own_id).await != PortOwner::OwnedByOther {
            if port != start {
                log::warn!(
                    "[NET] configured MCP port {start} was unavailable; using {port} instead \
                     (the configured value is unchanged)"
                );
            }
            return Some(port);
        }
    }
    log::error!("[NET] no free MCP port in {start}..{}", start.saturating_add(span));
    None
}

// ---------------------------------------------------------------------------
// Instance discovery
// ---------------------------------------------------------------------------

/// What one running instance advertises to its siblings: which profile it is,
/// which ports it ended up on, and — for an elevated instance — the per-launch
/// token needed to talk to it.
///
/// Ports are OPTIONAL: an elevated instance serves neither unless asked, so
/// "running, no endpoints" must be representable.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct InstanceRecord {
    /// The full identity key (`rel`, `rel.work.high`).
    pub profile: String,
    pub pid: u32,
    #[serde(default)]
    pub api_port: Option<u16>,
    #[serde(default)]
    pub mcp_port: Option<u16>,
    #[serde(default)]
    pub token: Option<String>,
}

/// Is this record left over from a dead instance?
///
/// A live PID is not enough — PIDs are reused, and adopting a stranger's PID as
/// "TermFlow is running" would block updates forever. `name_of` returns the
/// process name for a PID (None if there is no such process); the same rigour
/// the pty-host probe already applies (`pty_host_client.rs:431-467`).
pub fn is_stale(rec: &InstanceRecord, mut name_of: impl FnMut(u32) -> Option<String>) -> bool {
    match name_of(rec.pid) {
        None => true,
        Some(name) => {
            let name = name.to_ascii_lowercase();
            !(name.starts_with("termflow") || name.starts_with("app.exe"))
        }
    }
}

/// The shared directory every instance advertises into. The DIRECTORY is common
/// so siblings can enumerate each other; the FILENAME carries the identity.
pub fn instances_dir() -> Option<std::path::PathBuf> {
    let base = if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from)
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME")
            .map(|h| std::path::PathBuf::from(h).join("Library").join("Application Support"))
    } else {
        std::env::var_os("XDG_RUNTIME_DIR")
            .map(std::path::PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".local").join("share")))
    }?;
    let dir = base.join("app.termflow.desktop").join("instances");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir)
}

pub fn record_file_name(key: &str) -> String {
    format!("instance.{key}.json")
}

pub fn record_path_for(key: &str) -> Option<std::path::PathBuf> {
    instances_dir().map(|d| d.join(record_file_name(key)))
}

/// Publish this instance's record. Written to a uniquely-named temp file with
/// the right security applied at CREATION (never widened afterwards), then
/// renamed into place so a sibling can never read a half-written record.
pub fn publish(rec: &InstanceRecord, elevated: bool) -> Result<(), String> {
    let path = record_path_for(&rec.profile).ok_or("cannot resolve the instances directory")?;
    let body = serde_json::to_string_pretty(rec).map_err(|e| e.to_string())?;
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    write_restricted(&tmp, &body, elevated)?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Retract this instance's advertisement. Best-effort: a crash leaves the file,
/// and `is_stale` is what makes that harmless.
pub fn retract(key: &str) {
    if let Some(p) = record_path_for(key) {
        let _ = std::fs::remove_file(p);
    }
}

/// Every OTHER instance currently advertising itself, stale records skipped.
pub fn live_siblings(
    own_key: &str,
    mut name_of: impl FnMut(u32) -> Option<String>,
) -> Vec<InstanceRecord> {
    let Some(dir) = instances_dir() else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };
    entries
        .filter_map(|e| e.ok())
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .filter_map(|s| serde_json::from_str::<InstanceRecord>(&s).ok())
        .filter(|r| r.profile != own_key && r.pid != std::process::id())
        .filter(|r| !is_stale(r, |pid| name_of(pid)))
        .collect()
}

/// Live sibling lookup using the real process table.
pub fn live_siblings_now(own_key: &str) -> Vec<InstanceRecord> {
    use sysinfo::{Pid, ProcessesToUpdate, System};
    let mut sys = System::new();
    live_siblings(own_key, |pid| {
        let target = Pid::from_u32(pid);
        sys.refresh_processes(ProcessesToUpdate::Some(&[target]), true);
        sys.process(target).map(|p| p.name().to_string_lossy().to_string())
    })
}


/// Create a file only this user — and, when elevated, only a process at the same
/// integrity level — can read.
///
/// The DACL alone cannot protect an elevated instance's token: a medium process
/// of the SAME user passes it. Only the mandatory label (`NR` = no-read-up)
/// keeps the token out of reach, which is the whole point of D5.
#[cfg(windows)]
fn write_restricted(path: &std::path::Path, contents: &str, elevated: bool) -> Result<(), String> {
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::Foundation::{LocalFree, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
    };
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenUser, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    let sid = unsafe {
        let mut token = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err("cannot open the process token".into());
        }
        let mut size = 0u32;
        GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut size);
        let mut buf = vec![0u8; size.max(1) as usize];
        let ok = GetTokenInformation(
            token,
            TokenUser,
            buf.as_mut_ptr() as *mut std::ffi::c_void,
            size,
            &mut size,
        );
        windows_sys::Win32::Foundation::CloseHandle(token);
        if ok == 0 {
            return Err("cannot read the token user".into());
        }
        let user = &*(buf.as_ptr() as *const TOKEN_USER);
        let mut raw: *mut u16 = std::ptr::null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut raw) == 0 || raw.is_null() {
            return Err("cannot stringify the user SID".into());
        }
        let len = (0..).take_while(|&i| *raw.add(i) != 0).count();
        let s = String::from_utf16_lossy(std::slice::from_raw_parts(raw, len));
        LocalFree(raw as _);
        s
    };

    let label = if elevated { "HI" } else { "ME" };
    let sddl = wide(&format!("O:{sid}D:P(A;;GA;;;{sid})S:(ML;;NWNR;;;{label})"));
    let mut psd: *mut std::ffi::c_void = std::ptr::null_mut();
    let ok = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1, // SDDL_REVISION_1
            &mut psd,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 || psd.is_null() {
        return Err("cannot build the record security descriptor".into());
    }
    let mut sa = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: psd,
        bInheritHandle: 0,
    };
    let handle = unsafe {
        CreateFileW(
            wide(&path.to_string_lossy()).as_ptr(),
            FILE_GENERIC_READ | FILE_GENERIC_WRITE,
            0,
            &mut sa,
            CREATE_ALWAYS,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };
    unsafe { LocalFree(psd as _) };
    if handle == INVALID_HANDLE_VALUE || handle.is_null() {
        return Err(format!(
            "cannot create {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        ));
    }
    use std::io::Write;
    let mut f = unsafe { std::fs::File::from_raw_handle(handle as _) };
    f.write_all(contents.as_bytes()).map_err(|e| e.to_string())
}

#[cfg(not(windows))]
fn write_restricted(path: &std::path::Path, contents: &str, _elevated: bool) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| e.to_string())?;
    f.write_all(contents.as_bytes()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_configured_port_is_preferred_when_free() {
        let p = pick_bound_with(42031, 20, |_| Some(())).unwrap();
        assert_eq!(p.port, 42031);
    }

    #[test]
    fn a_taken_port_advances_to_the_next_free_one() {
        let p = pick_bound_with(42031, 20, |port| (port >= 42033).then_some(())).unwrap();
        assert_eq!(p.port, 42033);
    }

    #[test]
    fn an_exhausted_range_reports_failure_rather_than_binding_wildly() {
        assert!(pick_bound_with(42031, 3, |_| None::<()>).is_none());
    }

    #[test]
    fn the_range_is_exactly_span_ports_long() {
        // An off-by-one here means a sibling instance silently steals a port the
        // user configured for something else.
        assert_eq!(candidates(100, 3).collect::<Vec<_>>(), vec![100, 101, 102]);
        assert_eq!(candidates(100, 0).count(), 0);
    }

    #[test]
    fn the_range_stops_at_the_top_of_the_port_space() {
        // start + span overflows u16; wrapping would retry port 0 and below.
        assert_eq!(
            candidates(u16::MAX - 1, 5).collect::<Vec<_>>(),
            vec![u16::MAX - 1, u16::MAX]
        );
    }

    #[test]
    fn the_listener_is_carried_out_with_the_port() {
        // The whole point of bind-and-retain: the caller must receive the bound
        // resource, not just a number it has to bind again.
        let p = pick_bound_with(42031, 5, |port| Some(format!("socket-{port}"))).unwrap();
        assert_eq!(p.bound, "socket-42031");
    }

    #[test]
    fn unavailable_endpoints_are_representable() {
        // An elevated instance can suppress both servers, so ports are optional
        // and must survive a round trip as `null`.
        let r = InstanceRecord {
            profile: "rel.elevated.high".into(),
            pid: 42,
            api_port: None,
            mcp_port: None,
            token: None,
        };
        let back: InstanceRecord = serde_json::from_str(&serde_json::to_string(&r).unwrap()).unwrap();
        assert_eq!(back.api_port, None);
        assert_eq!(back, r);
    }

    #[test]
    fn a_record_written_by_an_older_build_still_parses() {
        // Missing optional fields must not make the record unreadable — an
        // unreadable sibling would look like "no sibling" and unblock an update.
        let back: InstanceRecord =
            serde_json::from_str(r#"{"profile":"rel","pid":7}"#).unwrap();
        assert_eq!(back.api_port, None);
        assert_eq!(back.token, None);
    }

    #[test]
    fn a_record_is_stale_unless_the_pid_is_live_and_the_name_matches() {
        // PID reuse: the pty-host probe validates the process NAME too
        // (pty_host_client.rs:431-467). Match that rigour.
        let r = InstanceRecord {
            profile: "x".into(),
            pid: 7,
            api_port: Some(1),
            mcp_port: None,
            token: None,
        };
        assert!(is_stale(&r, |_| None));
        assert!(is_stale(&r, |_| Some("notepad.exe".to_string())));
        assert!(!is_stale(&r, |_| Some("termflow.exe".to_string())));
        // The dev binary is `termflow-app.exe`, and casing varies by platform.
        assert!(!is_stale(&r, |_| Some("TermFlow-app.exe".to_string())));
    }

    #[test]
    fn the_record_filename_carries_the_identity_but_the_directory_is_shared() {
        // Shared directory so siblings can enumerate each other; scoped filename
        // so they never overwrite one another.
        assert_eq!(record_file_name("rel"), "instance.rel.json");
        assert_ne!(record_file_name("rel"), record_file_name("rel.work"));
        assert_ne!(record_file_name("rel.work"), record_file_name("rel.work.high"));
    }


    #[test]
    fn a_restricted_record_round_trips_through_the_filesystem() {
        // The Windows path creates the file through CreateFileW with a security
        // descriptor; a malformed SDDL would fail here rather than in production.
        let dir = std::env::temp_dir().join(format!("tf-instrec-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("instance.test.json");
        super::write_restricted(&path, r#"{"profile":"rel","pid":1}"#, false).unwrap();
        let back: InstanceRecord =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(back.profile, "rel");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn effective_endpoints_can_say_unavailable() {
        // An elevated instance may serve neither, so both must be optional.
        let e = EffectiveEndpoints::default();
        assert_eq!(e.api_port, None);
        assert_eq!(e.mcp_port, None);
    }
}
