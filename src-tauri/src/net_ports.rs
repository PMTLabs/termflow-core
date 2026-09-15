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

/// What a read of the instance record found, before any ownership question
/// is asked. The four cases are deliberately kept apart because `publish`
/// and `retract` answer them differently (see `publish_gate` /
/// `retract_gate`): only `Record` carries an owner; `Corrupt` means bytes
/// were read but mean nothing (not JSON, not UTF-8, wrong shape); and
/// `Unreadable` means NO bytes were obtained — a permission or sharing
/// error — so nothing at all is known about what is there.
#[derive(Debug)]
pub enum RecordOnDisk {
    Absent,
    Corrupt(String),
    Record(InstanceRecord),
    Unreadable(String),
}

/// Classify the raw result of reading the record file. Pure, so the I/O
/// error classes can be exercised without a filesystem.
pub fn classify_read(read: std::io::Result<Vec<u8>>) -> RecordOnDisk {
    match read {
        Ok(bytes) => match serde_json::from_slice::<InstanceRecord>(&bytes) {
            Ok(rec) => RecordOnDisk::Record(rec),
            Err(e) => RecordOnDisk::Corrupt(e.to_string()),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => RecordOnDisk::Absent,
        Err(e) => RecordOnDisk::Unreadable(e.to_string()),
    }
}

/// May `publish` go ahead and write over what `classify_read` found?
///
/// `Absent` and `Corrupt`: yes — a corrupt leftover (a crash mid-write, a
/// build that wrote a shape this one cannot read) must self-heal at the next
/// boot or the profile could never advertise again. `Record`: only if
/// `may_overwrite` says the owner is us or dead. `Unreadable`: NO — no bytes
/// were obtained, so this may well be a live instance's record behind a
/// transient permission/sharing error, and "unreadable" must not decay into
/// "absent" on the one path that can overwrite it.
pub fn publish_gate(
    found: &RecordOnDisk,
    our_pid: u32,
    name_of: impl FnMut(u32) -> Option<String>,
) -> Result<(), String> {
    match found {
        RecordOnDisk::Absent => Ok(()),
        RecordOnDisk::Corrupt(e) => {
            log::warn!("[NET] instance record unparsable; replacing it: {e}");
            Ok(())
        }
        RecordOnDisk::Record(existing) => {
            if may_overwrite(Some(existing), our_pid, name_of) {
                Ok(())
            } else {
                Err(format!(
                    "record held by live pid {} ({}); not overwriting",
                    existing.pid, existing.profile
                ))
            }
        }
        RecordOnDisk::Unreadable(e) => Err(format!("instance record unreadable; not overwriting: {e}")),
    }
}

/// May `retract` delete what `classify_read` found? Only a `Record` that
/// `should_retract` confirms is ours. `Corrupt` and `Unreadable` both stay:
/// the two sides err in opposite directions on purpose — `publish` heals a
/// corrupt leftover because a profile that can never publish is a real
/// cost, while `retract` never deletes what it could not prove it owns,
/// because a leftover costs nothing (`live_siblings` skips a record it read
/// but cannot parse) and deleting the wrong one hides a running instance.
pub fn retract_gate(found: &RecordOnDisk, our_pid: u32) -> bool {
    match found {
        RecordOnDisk::Record(rec) => should_retract(Some(rec), our_pid),
        RecordOnDisk::Absent | RecordOnDisk::Corrupt(_) | RecordOnDisk::Unreadable(_) => false,
    }
}

/// May `our_pid` replace `existing`? Refused only when the record names a
/// DIFFERENT process that is still a live TermFlow — first writer wins, so a
/// headless/dev second launch cannot hide the GUI from sibling-arm.
pub fn may_overwrite(
    existing: Option<&InstanceRecord>,
    our_pid: u32,
    mut name_of: impl FnMut(u32) -> Option<String>,
) -> bool {
    match existing {
        None => true,
        Some(rec) if rec.pid == our_pid => true,
        Some(rec) => is_stale(rec, &mut name_of),
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
///
/// Refuses to overwrite a record that still names a DIFFERENT live TermFlow
/// process, or one it could not read at all (`publish_gate`): first writer
/// wins, so a headless/dev second launch can no longer clobber the GUI's
/// advertisement and hide it from sibling-arm. An unparsable or absent
/// existing record is treated as no record at all, and a process
/// re-publishing its OWN pid (real ports, once bound) is always allowed.
pub fn publish(rec: &InstanceRecord, elevated: bool) -> Result<(), String> {
    let path = record_path_for(&rec.profile).ok_or("cannot resolve the instances directory")?;
    let found = classify_read(std::fs::read(&path));
    publish_gate(&found, std::process::id(), name_of_now())?;
    let body = serde_json::to_string_pretty(rec).map_err(|e| e.to_string())?;
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    write_restricted(&tmp, &body, elevated)?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Should `our_pid` delete `existing` on its way out? Only a record that
/// PROVABLY names US. The other half of `may_overwrite`: a second same-profile
/// process whose publish was refused never owned the file, and deleting the
/// live GUI's advertisement on ITS exit would hide the GUI exactly as the
/// clobber did.
///
/// `None` (absent, unreadable, unparsable) is NOT ours: a transient read
/// error or a record written by a build whose shape this one cannot parse may
/// still belong to a live process. The two sides err in opposite directions
/// on purpose — `publish` treats an unparsable record as absent so a corrupt
/// leftover self-heals at the next boot, while `retract` never deletes what
/// it could not read, because leaving a file behind costs nothing
/// (`live_siblings` skips a record it read but cannot parse) and deleting the
/// wrong one hides a running instance.
pub fn should_retract(existing: Option<&InstanceRecord>, our_pid: u32) -> bool {
    existing.is_some_and(|rec| rec.pid == our_pid)
}

/// Retract this instance's advertisement — if it IS this instance's (see
/// `retract_gate` / `should_retract`). Best-effort: a crash leaves the file,
/// and `is_stale` is what makes that harmless.
pub fn retract(key: &str) {
    let Some(p) = record_path_for(key) else { return };
    let found = classify_read(std::fs::read(&p));
    if retract_gate(&found, std::process::id()) {
        let _ = std::fs::remove_file(p);
        return;
    }
    match found {
        RecordOnDisk::Absent => {}
        RecordOnDisk::Record(rec) => log::info!(
            "[NET] leaving the instance record in place: it names pid {}, not this process",
            rec.pid
        ),
        RecordOnDisk::Corrupt(e) => log::warn!("[NET] instance record unparsable at exit; leaving it: {e}"),
        RecordOnDisk::Unreadable(e) => log::warn!("[NET] instance record unreadable at exit; leaving it: {e}"),
    }
}

/// Is this directory entry an instance record (`instance.<key>.json`)? The
/// `.tmp` files `publish` renames into place are not records: a stale one a
/// crash left behind must not be able to block every future update.
pub fn is_record_file_name(name: &str) -> bool {
    name.starts_with("instance.") && name.ends_with(".json")
}

/// Every OTHER instance currently advertising itself, stale records skipped.
///
/// Fails CLOSED: this is the reader the UPDATE path acts on — Velopack's
/// apply kills every process under the install root, and a sibling this
/// list omits is a sibling that never gets armed and loses its shells. So a
/// directory that cannot be listed, an entry that cannot be read, or a record
/// file that yields no bytes (`RecordOnDisk::Unreadable` — an elevated
/// instance's record is deliberately no-read-up from a medium one) is an
/// error the caller must refuse on, never an empty list. A record that was
/// read but does not parse (`Corrupt`) is skipped as before: `publish` heals
/// those, and there is no live process behind bytes nobody could have
/// written whole. `Absent` is a record that vanished between the listing and
/// the read — a sibling that just exited — and is skipped too.
pub fn live_siblings(
    own_key: &str,
    name_of: impl FnMut(u32) -> Option<String>,
) -> Result<Vec<InstanceRecord>, String> {
    let dir = instances_dir().ok_or("cannot resolve the instances directory")?;
    live_siblings_in(&dir, own_key, name_of)
}

/// `live_siblings` over an explicit directory (the unit tests point it at a
/// temp dir instead of redirecting `LOCALAPPDATA` under a parallel test run).
pub fn live_siblings_in(
    dir: &std::path::Path,
    own_key: &str,
    mut name_of: impl FnMut(u32) -> Option<String>,
) -> Result<Vec<InstanceRecord>, String> {
    let entries =
        std::fs::read_dir(dir).map_err(|e| format!("cannot list {}: {e}", dir.display()))?;
    let mut out = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("cannot list {}: {e}", dir.display()))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !is_record_file_name(&name) {
            continue;
        }
        match classify_read(std::fs::read(entry.path())) {
            RecordOnDisk::Record(r) => {
                if r.profile != own_key
                    && r.pid != std::process::id()
                    && !is_stale(&r, &mut name_of)
                {
                    out.push(r);
                }
            }
            RecordOnDisk::Absent => {}
            RecordOnDisk::Corrupt(e) => log::warn!("[NET] skipping unparsable instance record {name}: {e}"),
            RecordOnDisk::Unreadable(e) => {
                return Err(format!("instance record {name} is unreadable ({e})"));
            }
        }
    }
    Ok(out)
}

/// One `sysinfo` process-table probe, shared by every live-pid check
/// (`live_siblings_now`, `publish`'s refusal check) so each call site doesn't
/// stand up its own `System`.
fn name_of_now() -> impl FnMut(u32) -> Option<String> {
    use sysinfo::{Pid, ProcessesToUpdate, System};
    let mut sys = System::new();
    move |pid| {
        let target = Pid::from_u32(pid);
        sys.refresh_processes(ProcessesToUpdate::Some(&[target]), true);
        sys.process(target).map(|p| p.name().to_string_lossy().to_string())
    }
}

/// Live sibling lookup using the real process table.
pub fn live_siblings_now(own_key: &str) -> Result<Vec<InstanceRecord>, String> {
    live_siblings(own_key, name_of_now())
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

    fn rec(pid: u32) -> InstanceRecord {
        InstanceRecord { profile: "rel".into(), pid, api_port: None, mcp_port: None, token: None }
    }

    fn io_err(kind: std::io::ErrorKind) -> std::io::Result<Vec<u8>> {
        Err(std::io::Error::new(kind, "simulated"))
    }

    /// Every consumer of `live_siblings_now` is an UPDATE decision; each must
    /// propagate the enumeration error with `?` — never `unwrap_or_default`,
    /// `.ok()` or a match that maps the error to an empty list, which would
    /// quietly restore the fail-open behaviour this round removed.
    #[test]
    fn every_sibling_enumeration_propagates_the_error() {
        for file in ["commands/update.rs", "updater.rs"] {
            let src = std::fs::read_to_string(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join(file),
            )
            .unwrap()
            .replace("\r\n", "\n");
            let src = src
                .lines()
                .map(|l| match l.find("//") {
                    Some(i) => &l[..i],
                    None => l,
                })
                .collect::<Vec<_>>()
                .join("\n");
            let mut seen = 0;
            let mut from = 0;
            while let Some(i) = src[from..].find("live_siblings_now(") {
                let at = from + i;
                let end = at + src[at..].find(';').expect("statement end");
                let stmt = src[at..end].trim_end();
                assert!(
                    stmt.ends_with('?'),
                    "{file}: `live_siblings_now` must be propagated with `?`, got: {stmt}"
                );
                assert!(
                    !stmt.contains("unwrap") && !stmt.contains(".ok()") && !stmt.contains("unwrap_or"),
                    "{file}: enumeration error must not be swallowed: {stmt}"
                );
                seen += 1;
                from = end;
            }
            assert!(seen >= 1, "{file}: expected at least one live_siblings_now call site");
        }
    }

    #[test]
    fn record_file_names_exclude_publish_tmp_files() {
        assert!(is_record_file_name("instance.rel.json"));
        assert!(is_record_file_name("instance.rel.alt.json"));
        assert!(!is_record_file_name("instance.rel.4242.tmp"), "a publish temp file is not a record");
        assert!(!is_record_file_name("notes.txt"));
        assert!(!is_record_file_name("rel.json"));
    }

    /// `live_siblings` must refuse — not return an empty list — when a record
    /// cannot be read, because the update path arms exactly the siblings it
    /// lists and Velopack kills the rest. Exercised against a real temp
    /// directory.
    #[test]
    fn live_siblings_fails_closed_on_an_unreadable_record() {
        let dir = std::env::temp_dir().join(format!("tf-siblings-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // A live sibling, a corrupt leftover, and a publish temp file.
        let live = InstanceRecord { profile: "other".into(), pid: 7, api_port: Some(1), mcp_port: None, token: None };
        std::fs::write(dir.join("instance.other.json"), serde_json::to_vec(&live).unwrap()).unwrap();
        std::fs::write(dir.join("instance.broken.json"), b"{not json").unwrap();
        std::fs::write(dir.join("instance.rel.4242.tmp"), b"{").unwrap();
        let alive = |_pid: u32| Some("termflow.exe".to_string());
        let got = live_siblings_in(&dir, "rel", alive).expect("corrupt and tmp entries are skipped, not errors");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].profile, "other");

        // Make one record unreadable: a directory of the same name cannot be
        // `fs::read` and is not NotFound — the shape of a permission error
        // without needing ACLs in a unit test.
        std::fs::create_dir(dir.join("instance.locked.json")).unwrap();
        let err = live_siblings_in(&dir, "rel", alive).expect_err("an unreadable record must fail the enumeration");
        assert!(err.contains("instance.locked.json"), "the error names the record: {err}");

        // A missing directory is not "no siblings" either.
        let _ = std::fs::remove_dir_all(&dir);
        assert!(live_siblings_in(&dir, "rel", alive).is_err(), "an unlistable directory must fail the enumeration");
    }

    #[test]
    fn classify_read_keeps_the_four_cases_apart() {
        assert!(matches!(classify_read(io_err(std::io::ErrorKind::NotFound)), RecordOnDisk::Absent));
        assert!(matches!(
            classify_read(io_err(std::io::ErrorKind::PermissionDenied)),
            RecordOnDisk::Unreadable(_)
        ));
        assert!(matches!(classify_read(Ok(b"not json".to_vec())), RecordOnDisk::Corrupt(_)));
        assert!(
            matches!(classify_read(Ok(vec![0xff, 0xfe, 0x00])), RecordOnDisk::Corrupt(_)),
            "non-UTF-8 bytes were READ, so they are corrupt (healable), not unreadable"
        );
        let json = serde_json::to_vec(&rec(42)).unwrap();
        assert!(matches!(classify_read(Ok(json)), RecordOnDisk::Record(r) if r.pid == 42));
    }

    /// `publish` may heal what it could parse as garbage, but must fail CLOSED
    /// on what it could not read at all: no bytes means no knowledge, and the
    /// one path that can overwrite a live instance's record must not treat
    /// "unreadable" as "absent".
    #[test]
    fn publish_gate_heals_corrupt_but_refuses_unreadable() {
        let live = |_pid: u32| Some("termflow.exe".to_string());
        assert!(publish_gate(&RecordOnDisk::Absent, 99, live).is_ok());
        assert!(publish_gate(&RecordOnDisk::Corrupt("x".into()), 99, live).is_ok());
        assert!(publish_gate(&RecordOnDisk::Record(rec(99)), 99, live).is_ok(), "our own record");
        assert!(
            publish_gate(&RecordOnDisk::Record(rec(7)), 99, live).is_err(),
            "another LIVE termflow's record"
        );
        assert!(
            publish_gate(&RecordOnDisk::Record(rec(7)), 99, |_| None).is_ok(),
            "a dead pid's record is stale and writable"
        );
        assert!(
            publish_gate(&RecordOnDisk::Unreadable("denied".into()), 99, live).is_err(),
            "an I/O error must fail closed"
        );
    }

    /// The mirror: `retract` deletes only a parsed record naming us — never a
    /// corrupt or unreadable one, whatever `publish` would have done with it.
    #[test]
    fn retract_gate_deletes_only_a_parsed_record_naming_us() {
        assert!(retract_gate(&RecordOnDisk::Record(rec(99)), 99));
        assert!(!retract_gate(&RecordOnDisk::Record(rec(7)), 99));
        assert!(!retract_gate(&RecordOnDisk::Absent, 99));
        assert!(!retract_gate(&RecordOnDisk::Corrupt("x".into()), 99), "corrupt stays (publish heals it)");
        assert!(!retract_gate(&RecordOnDisk::Unreadable("denied".into()), 99), "unreadable stays");
    }

    /// The gates are pure; this pins that the filesystem effects actually go
    /// through them: `publish` writes only after `publish_gate(...)?` and
    /// `retract` removes only inside the `retract_gate` branch. Source text,
    /// comments stripped — a gate that is called but whose verdict is ignored
    /// would pass the pure tests above and still clobber.
    #[test]
    fn publish_and_retract_effects_are_gated() {
        let src = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("net_ports.rs"),
        )
        .unwrap()
        .replace("\r\n", "\n");
        // Block comments, then line comments, then dead blocks: a gate that
        // exists only inside `/* */`, `if false { }` or `#[cfg(any())] { }`
        // must not satisfy the scan.
        let mut without_block = String::with_capacity(src.len());
        let mut rest = src.as_str();
        while let Some(start) = rest.find("/*") {
            without_block.push_str(&rest[..start]);
            match rest[start + 2..].find("*/") {
                Some(end) => rest = &rest[start + 2 + end + 2..],
                None => {
                    rest = "";
                    break;
                }
            }
        }
        without_block.push_str(rest);
        let mut src = without_block
            .lines()
            .map(|l| match l.find("//") {
                Some(i) => &l[..i],
                None => l,
            })
            .collect::<Vec<_>>()
            .join("\n");
        loop {
            let at = match (src.find("if false"), src.find("#[cfg(any())]")) {
                (Some(a), Some(b)) => Some(a.min(b)),
                (Some(a), None) => Some(a),
                (None, Some(b)) => Some(b),
                (None, None) => None,
            };
            let Some(at) = at else { break };
            let open = at + src[at..].find('{').expect("dead block has a body");
            let mut depth = 0i32;
            let mut end = open;
            for (i, c) in src[open..].char_indices() {
                match c {
                    '{' => depth += 1,
                    '}' => {
                        depth -= 1;
                        if depth == 0 {
                            end = open + i + 1;
                            break;
                        }
                    }
                    _ => {}
                }
            }
            src.replace_range(at..end, "");
        }
        fn fn_body<'a>(src: &'a str, sig: &str) -> &'a str {
            let at = src.find(sig).unwrap_or_else(|| panic!("`{sig}` not found"));
            let open = at + src[at..].find('{').unwrap();
            let mut depth = 0i32;
            for (i, c) in src[open..].char_indices() {
                match c {
                    '{' => depth += 1,
                    '}' => {
                        depth -= 1;
                        if depth == 0 {
                            return &src[open..open + i + 1];
                        }
                    }
                    _ => {}
                }
            }
            panic!("unbalanced braces after `{sig}`");
        }

        let publish = fn_body(&src, "pub fn publish(");
        let gate = publish.find("publish_gate(").expect("publish must call publish_gate");
        // The verdict must be propagated by the `?` RIGHT AFTER the call's own
        // closing paren — a later `)?;` on some other call does not count.
        let open = gate + "publish_gate".len();
        let mut depth = 0i32;
        let mut close = open;
        for (i, c) in publish[open..].char_indices() {
            match c {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        close = open + i + 1;
                        break;
                    }
                }
                _ => {}
            }
        }
        assert!(
            publish[close..].starts_with("?;"),
            "publish_gate's verdict must be propagated with `?` on the call itself. Body:\n{publish}"
        );
        let write = publish.find("write_restricted(").expect("publish must write");
        assert!(close < write, "the gate must decide BEFORE the write. Body:\n{publish}");
        assert!(
            !publish.contains(".ok()"),
            "publish must not flatten a read error into `None`; classify it. Body:\n{publish}"
        );

        let retract = fn_body(&src, "pub fn retract(");
        let cond = retract.find("if retract_gate(").expect("retract must branch on retract_gate");
        let open = cond + retract[cond..].find('{').unwrap();
        let mut depth = 0i32;
        let mut close = open;
        for (i, c) in retract[open..].char_indices() {
            match c {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        close = open + i + 1;
                        break;
                    }
                }
                _ => {}
            }
        }
        let branch = &retract[open..close];
        assert!(branch.contains("remove_file("), "the remove must sit inside the gate branch. Branch:\n{branch}");
        assert_eq!(
            retract.matches("remove_file(").count(),
            1,
            "exactly one remove, and it is the gated one. Body:\n{retract}"
        );
    }

    #[test]
    fn should_retract_only_a_record_that_names_us() {
        let ours = InstanceRecord { profile: "rel".into(), pid: 99, api_port: None, mcp_port: None, token: None };
        let theirs = InstanceRecord { profile: "rel".into(), pid: 7, api_port: None, mcp_port: None, token: None };
        assert!(should_retract(Some(&ours), 99));
        assert!(!should_retract(Some(&theirs), 99), "a refused second launch must not delete the GUI's record on exit");
        assert!(
            !should_retract(None, 99),
            "a record we could not read or parse may belong to a live process: never delete on a guess"
        );
    }

    #[test]
    fn may_overwrite_an_absent_record_is_always_writable() {
        assert!(may_overwrite(None, 99, |_| Some("termflow.exe".to_string())));
    }

    #[test]
    fn may_overwrite_the_same_pid_always_wins_even_when_reported_live() {
        // The re-publish-with-real-ports case: our own record, still live.
        let rec = InstanceRecord { profile: "rel".into(), pid: 99, api_port: None, mcp_port: None, token: None };
        assert!(may_overwrite(Some(&rec), 99, |_| Some("termflow.exe".to_string())));
    }

    #[test]
    fn may_overwrite_a_dead_pid_is_stale_and_writable() {
        let rec = InstanceRecord { profile: "rel".into(), pid: 7, api_port: None, mcp_port: None, token: None };
        assert!(may_overwrite(Some(&rec), 99, |_| None));
    }

    #[test]
    fn may_overwrite_a_reused_pid_naming_a_different_process_is_writable() {
        let rec = InstanceRecord { profile: "rel".into(), pid: 7, api_port: None, mcp_port: None, token: None };
        assert!(may_overwrite(Some(&rec), 99, |_| Some("notepad.exe".to_string())));
    }

    #[test]
    fn may_overwrite_refuses_a_different_live_termflow() {
        let rec = InstanceRecord { profile: "rel".into(), pid: 7, api_port: None, mcp_port: None, token: None };
        assert!(!may_overwrite(Some(&rec), 99, |_| Some("termflow.exe".to_string())));
    }

    #[test]
    fn may_overwrite_refuses_a_different_live_dev_binary_mixed_case() {
        // The dev binary is `termflow-app.exe`, and casing varies by platform.
        let rec = InstanceRecord { profile: "rel".into(), pid: 7, api_port: None, mcp_port: None, token: None };
        assert!(!may_overwrite(Some(&rec), 99, |_| Some("TermFlow-app.exe".to_string())));
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
