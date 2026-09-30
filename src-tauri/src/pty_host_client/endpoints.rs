use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Naming is opt-in; discovery of surviving hosts is never gated.
fn generations_enabled(value: Option<&str>) -> bool {
    value == Some("1")
}

pub(super) fn named_generation(generation: Option<&str>, enabled: bool) -> Option<&str> {
    generation.filter(|_| enabled)
}

#[cfg(any(windows, test))]
pub(super) fn qualified_pipe_for(
    user: &str,
    id: &crate::profile::ProfileIdentity,
    generation: Option<&str>,
) -> String {
    let legacy = format!(r"\\.\pipe\termflow-pty-host.{user}.{}", id.key());
    match generation {
        Some(g) => format!("{legacy}.{g}"),
        None => legacy,
    }
}

#[cfg(any(unix, test))]
pub(super) fn qualified_socket_for(
    dir: &str,
    id: &crate::profile::ProfileIdentity,
    generation: Option<&str>,
    uid: u32,
) -> String {
    match generation {
        None => format!("{dir}/termflow-pty-host.{}.sock", id.key()),
        Some(g) => {
            let name = format!("tfh.{}.{g}.sock", id.key());
            let path = format!("{dir}/{name}");
            if path.len() + 1 <= 103 {
                path
            } else {
                format!("/tmp/tf-{uid}/{name}")
            }
        }
    }
}

pub(super) fn host_file_for(dir: &Path, generation: Option<&str>, name: &str) -> PathBuf {
    match generation {
        Some(g) => dir.join(g).join(name),
        None => dir.join(name),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostPaths {
    pub endpoint: String,
    pub record: Option<PathBuf>,
    pub log: Option<PathBuf>,
}

static CURRENT_PATHS: OnceLock<HostPaths> = OnceLock::new();

pub(super) fn endpoint_for_generation(generation: Option<&str>) -> String {
    #[cfg(windows)]
    {
        let user = std::env::var("USERNAME")
            .or_else(|_| std::env::var("USER"))
            .unwrap_or_else(|_| "user".to_string());
        qualified_pipe_for(&user, crate::profile::current(), generation)
    }
    #[cfg(unix)]
    {
        qualified_socket_for(
            &super::unix_runtime_dir(),
            crate::profile::current(),
            generation,
            unsafe { libc::geteuid() },
        )
    }
}

fn paths_for(generation: Option<&str>) -> HostPaths {
    let dir = super::runtime_host_dir();
    HostPaths {
        endpoint: endpoint_for_generation(generation),
        record: dir
            .as_ref()
            .map(|d| host_file_for(d, generation, "host-record.json")),
        // Preserve the legacy Unix null-output contract when naming is off.
        log: dir
            .as_ref()
            .filter(|_| cfg!(windows) || generation.is_some())
            .map(|d| host_file_for(d, generation, "host.log")),
    }
}

/// Pin endpoint and companion paths at the first successful launch resolution.
/// A transient later install failure cannot turn an existing current host frozen.
pub fn current_host_paths() -> HostPaths {
    pinned_or_legacy(&CURRENT_PATHS, || super::resolve_host_launch().is_some())
}

/// What `cell` holds once `resolve_launch` has had the chance to pin it; the
/// legacy paths when it never pinned anything.
fn pinned_or_legacy(cell: &OnceLock<HostPaths>, resolve_launch: impl FnOnce() -> bool) -> HostPaths {
    if let Some(paths) = cell.get() {
        return paths.clone();
    }
    if resolve_launch() {
        if let Some(paths) = cell.get() {
            return paths.clone();
        }
    }
    paths_for(None)
}

pub(super) fn pin_current_paths(generation: Option<&str>) {
    pin_generation_paths(
        &CURRENT_PATHS,
        generation,
        generations_enabled(std::env::var("TERMFLOW_PTY_GENERATIONS").ok().as_deref()),
    );
}

/// Pin the paths a launch with `generation` runs on; `naming_enabled` is the
/// naming gate, which decides whether the generation appears in them at all.
fn pin_generation_paths(cell: &OnceLock<HostPaths>, generation: Option<&str>, naming_enabled: bool) {
    pin_paths(cell, || paths_for(named_generation(generation, naming_enabled)));
}

fn pin_paths(cell: &OnceLock<HostPaths>, resolve: impl FnOnce() -> HostPaths) -> &HostPaths {
    cell.get_or_init(resolve)
}

#[cfg(unix)]
pub(super) fn ensure_socket_parent(endpoint: &str) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let dir = Path::new(endpoint).parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "socket has no parent")
    })?;
    match std::fs::symlink_metadata(dir) {
        Ok(meta) => validate_socket_dir(&meta, unsafe { libc::geteuid() })?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(dir)?;
            validate_socket_dir(&std::fs::symlink_metadata(dir)?, unsafe { libc::geteuid() })?;
        }
        Err(e) => return Err(e),
    }
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(unix)]
pub(super) fn validate_socket_dir(meta: &std::fs::Metadata, uid: u32) -> std::io::Result<()> {
    use std::os::unix::fs::MetadataExt;
    if !meta.is_dir() || meta.file_type().is_symlink() || meta.uid() != uid {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "socket directory is not owner-controlled",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn e_cur_pinned_transient_install_failure_does_not_rerole() {
        let cell = OnceLock::new();
        let first = HostPaths {
            endpoint: "qualified".into(),
            record: Some("gen/host-record.json".into()),
            log: Some("gen/host.log".into()),
        };
        assert_eq!(pin_paths(&cell, || first.clone()), &first);
        let fallback = HostPaths {
            endpoint: "legacy".into(),
            record: Some("host-record.json".into()),
            log: None,
        };
        assert_eq!(pin_paths(&cell, || fallback), &first);
        assert_eq!(cell.get().unwrap().endpoint, "qualified");
    }

    const GEN: &str = "12345678aaaaaaaa";

    /// Pin a launch that has a generation, then read the paths back the way the
    /// rest of the client does.
    fn paths_after_pinning(naming_enabled: bool) -> HostPaths {
        let cell = OnceLock::new();
        pin_generation_paths(&cell, Some(GEN), naming_enabled);
        pinned_or_legacy(&cell, || false)
    }

    fn mentions_generation(paths: &HostPaths) -> bool {
        paths.endpoint.contains(GEN)
            || paths.record.iter().chain(paths.log.iter()).any(|p| p.to_string_lossy().contains(GEN))
    }

    #[test]
    fn gate_off_pins_exactly_the_legacy_names_even_with_a_generation() {
        let pinned = paths_after_pinning(false);
        assert_eq!(pinned, paths_for(None));
        assert!(!mentions_generation(&pinned), "{pinned:?}");
    }

    #[test]
    fn gate_on_pins_the_generation_qualified_names() {
        let pinned = paths_after_pinning(true);
        assert_eq!(pinned, paths_for(Some(GEN)));
        assert!(pinned.endpoint.contains(GEN), "{pinned:?}");
        assert_ne!(pinned.endpoint, paths_for(None).endpoint);
        if let Some(record) = &pinned.record {
            assert!(record.to_string_lossy().contains(GEN), "{record:?}");
        }
    }

    #[test]
    fn nothing_pinned_reads_back_as_legacy() {
        assert_eq!(pinned_or_legacy(&OnceLock::new(), || true), paths_for(None));
    }

    #[test]
    fn gate_defaults_off() {
        for value in [None, Some("0"), Some("true"), Some("")] {
            assert!(!super::generations_enabled(value));
        }
        assert!(super::generations_enabled(Some("1")));
    }
}
