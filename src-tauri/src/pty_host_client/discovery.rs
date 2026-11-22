use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use termflow_pty_protocol::HostRecord;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostRole {
    Current,
    Frozen,
}

#[derive(Debug, Clone)]
pub struct HostCandidate {
    pub generation: Option<String>,
    pub endpoint: String,
    pub record: Option<HostRecord>,
    pub record_path: Option<PathBuf>,
    pub pid: Option<u32>,
    pub mtime: SystemTime,
    pub role: HostRole,
}

impl HostCandidate {
    pub fn compatible(&self) -> bool {
        !matches!(
            super::plan_connection(self.record.clone()),
            super::ConnectPlan::Incompatible { .. }
        )
    }
}

/// Enumerate survivors regardless of the naming gate. Probes only test endpoint
/// existence: opening and dropping a transport here could tear down live shells.
/// The connection path still probes with grace before it may spawn.
pub fn discover_hosts() -> Vec<HostCandidate> {
    let current = super::current_host_paths();
    discover_hosts_in(
        super::runtime_host_dir().as_deref(),
        &current.endpoint,
        &super::endpoints::endpoint_for_generation(None),
        super::endpoints::endpoint_for_generation,
        |pid| super::live_host_probe(Some(pid))(),
        endpoint_exists,
    )
}

pub(super) fn discover_hosts_in(
    dir: Option<&Path>,
    current: &str,
    legacy: &str,
    endpoint_for: impl Fn(Option<&str>) -> String,
    mut alive: impl FnMut(u32) -> bool,
    mut probe: impl FnMut(&str) -> bool,
) -> Vec<HostCandidate> {
    let mut records = Vec::new();
    if let Some(dir) = dir {
        records.push((None, dir.join("host-record.json")));
        match std::fs::read_dir(dir) {
            Ok(entries) => {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if valid_generation(&name)
                        && entry.file_type().map(|t| t.is_dir()).unwrap_or(false)
                    {
                        records.push((Some(name), entry.path().join("host-record.json")));
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => log::warn!(
                "[GEN] cannot enumerate host records in {}: {e}",
                dir.display()
            ),
        }
    }
    let mut found = HashMap::new();
    for (generation, path) in records {
        let record = match termflow_pty_protocol::read_record(&path) {
            Ok(Some(record)) => record,
            Ok(None) => continue,
            Err(e) => {
                log::warn!(
                    "[GEN] ignoring unreadable host record {}: {e}",
                    path.display()
                );
                continue;
            }
        };
        let expected = endpoint_for(generation.as_deref());
        if physical_endpoint(&record.endpoint) != physical_endpoint(&expected) {
            log::warn!(
                "[GEN] ignoring host record with unexpected endpoint at {}",
                path.display()
            );
            continue;
        }
        if !alive(record.pid) {
            continue;
        }
        let endpoint = record.endpoint.clone();
        let candidate = HostCandidate {
            generation,
            role: role_for(&endpoint, current),
            endpoint,
            pid: Some(record.pid),
            record: Some(record),
            mtime: std::fs::metadata(&path)
                .and_then(|m| m.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH),
            record_path: Some(path),
        };
        if !candidate.compatible() {
            log::warn!(
                "[GEN] incompatible host on {}; leaving it untouched",
                candidate.endpoint
            );
        }
        found.insert(physical_endpoint(&candidate.endpoint), candidate);
    }
    // Both well-known and current endpoints must be considered even when their
    // records are missing, corrupt, or stale. A busy endpoint still exists.
    for endpoint in [legacy, current] {
        let key = physical_endpoint(endpoint);
        if !found.contains_key(&key) && probe(endpoint) {
            found.insert(
                key,
                HostCandidate {
                    generation: if physical_endpoint(endpoint) == physical_endpoint(legacy) {
                        None
                    } else {
                        endpoint_generation(endpoint)
                    },
                    endpoint: endpoint.to_owned(),
                    record: None,
                    record_path: None,
                    pid: None,
                    mtime: SystemTime::UNIX_EPOCH,
                    role: role_for(endpoint, current),
                },
            );
        }
    }
    let mut candidates: Vec<_> = found.into_values().collect();
    // Most recently advertised is a fallback heuristic, NOT build chronology:
    // a healed old record legitimately moves ahead of a newer generation.
    candidates.sort_by(|a, b| {
        b.mtime
            .cmp(&a.mtime)
            .then_with(|| a.generation.cmp(&b.generation))
            .then_with(|| a.endpoint.cmp(&b.endpoint))
    });
    for candidate in &candidates {
        log::info!("[GEN] discovered {:?} host {} (generation {:?}, compatible={})",
            candidate.role, candidate.endpoint, candidate.generation, candidate.compatible());
    }
    candidates
}

/// The generation a host endpoint is named after; `None` for the legacy
/// endpoint, which names none.
pub fn generation_of_endpoint(endpoint: &str) -> Option<String> {
    generation_of_endpoint_in(endpoint, &super::endpoints::endpoint_for_generation(None))
}

pub fn generation_of_endpoint_in(endpoint: &str, legacy: &str) -> Option<String> {
    if physical_endpoint(endpoint) == physical_endpoint(legacy) {
        return None;
    }
    endpoint_generation(endpoint)
}

fn endpoint_generation(endpoint: &str) -> Option<String> {
    let stem = endpoint.strip_suffix(".sock").unwrap_or(endpoint);
    stem.rsplit('.')
        .next()
        .filter(|g| valid_generation(g))
        .map(str::to_owned)
}

pub(super) fn valid_generation(name: &str) -> bool {
    name.len() == 16
        && name
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn role_for(endpoint: &str, current: &str) -> HostRole {
    if physical_endpoint(endpoint) == physical_endpoint(current) {
        HostRole::Current
    } else {
        HostRole::Frozen
    }
}

fn physical_endpoint(endpoint: &str) -> String {
    if endpoint
        .get(..9)
        .map(|prefix| prefix.eq_ignore_ascii_case(r"\\.\pipe\"))
        .unwrap_or(false)
    {
        // Named-pipe names are case-insensitive, including when tests run on Unix.
        endpoint.to_lowercase()
    } else {
        endpoint.to_owned()
    }
}

#[cfg(windows)]
fn endpoint_exists(endpoint: &str) -> bool {
    #[link(name = "kernel32")]
    extern "system" {
        fn WaitNamedPipeW(name: *const u16, timeout: u32) -> i32;
    }
    let wide: Vec<u16> = endpoint.encode_utf16().chain(Some(0)).collect();
    if unsafe { WaitNamedPipeW(wide.as_ptr(), 1) } != 0 {
        return true;
    }
    // A connected/busy pipe must not disappear from discovery.
    matches!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(121) | Some(231)
    )
}

#[cfg(unix)]
fn endpoint_exists(endpoint: &str) -> bool {
    use std::os::unix::fs::FileTypeExt;
    std::fs::symlink_metadata(endpoint)
        .map(|m| m.file_type().is_socket())
        .unwrap_or(false)
}
