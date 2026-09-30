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

const GENERATIONS_GATE_VAR: &str = "TERMFLOW_PTY_GENERATIONS";

pub(super) fn pin_current_paths(generation: Option<&str>) {
    pin_from_env(&CURRENT_PATHS, generation, |name| std::env::var(name).ok());
}

/// Pin `cell` for a launch with `generation`, reading the naming gate from `env`.
/// The whole of `pin_current_paths` but the process-wide cell and the real
/// environment, so the gate can be exercised without touching either.
fn pin_from_env(cell: &OnceLock<HostPaths>, generation: Option<&str>, env: impl Fn(&str) -> Option<String>) {
    pin_generation_paths(cell, generation, generations_enabled(env(GENERATIONS_GATE_VAR).as_deref()));
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

    /// What the process-wide pin would hold for a launch with a generation, given
    /// the environment `vars` (only the named variables exist).
    fn paths_pinned_from_env(vars: &[(&str, &str)]) -> HostPaths {
        let cell = OnceLock::new();
        pin_from_env(&cell, Some(GEN), |name| {
            vars.iter().find(|(key, _)| *key == name).map(|(_, value)| value.to_string())
        });
        pinned_or_legacy(&cell, || false)
    }

    #[test]
    fn the_production_pin_reads_the_gate_from_the_environment() {
        let on = paths_pinned_from_env(&[("TERMFLOW_PTY_GENERATIONS", "1")]);
        assert_eq!(on, paths_for(Some(GEN)));
        for off in [
            paths_pinned_from_env(&[]),
            paths_pinned_from_env(&[("TERMFLOW_PTY_GENERATIONS", "0")]),
            paths_pinned_from_env(&[("TERMFLOW_PTY_GENERATIONS", "true")]),
            paths_pinned_from_env(&[("TERMFLOW_PTY_GENERATION", "1")]),
        ] {
            assert_eq!(off, paths_for(None));
        }
    }

    /// `pin_current_paths` must do nothing but hand the process-wide cell and the
    /// real environment to `pin_from_env`: any gate logic of its own would be
    /// untested by the cases above.
    #[test]
    fn the_production_pin_is_only_the_delegation_the_gate_tests_drive() {
        let source = include_str!("endpoints.rs");
        let start = source.find("pub(super) fn pin_current_paths(").expect("pin_current_paths");
        let end = source[start..].find("\n}").expect("end of pin_current_paths");
        let body = &source[start..start + end];
        let squeezed: String = body.split_whitespace().collect();
        assert_eq!(
            squeezed,
            "pub(super)fnpin_current_paths(generation:Option<&str>){pin_from_env(&CURRENT_PATHS,generation,|name|std::env::var(name).ok());",
        );
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
