use super::discovery::discover_hosts_in;
use super::test_dirs as tempfile;
use super::{HostCandidate, HostRole};
use std::path::Path;
use std::time::{Duration, SystemTime};
use termflow_pty_protocol::HostRecord;

const A: &str = "12345678aaaaaaaa";
const B: &str = "12345678bbbbbbbb";
fn endpoint(g: Option<&str>) -> String {
    super::endpoints::qualified_pipe_for(
        "u",
        &crate::profile::ProfileIdentity {
            channel: "rel",
            name: "default".into(),
            integrity: crate::profile::Integrity::Medium,
        },
        g,
    )
}
fn record(dir: &Path, g: Option<&str>, pid: u32) -> std::path::PathBuf {
    let path = super::endpoints::host_file_for(dir, g, "host-record.json");
    termflow_pty_protocol::write_record(
        &path,
        &HostRecord {
            format: 1,
            instance_id: pid as u128,
            pid,
            proto_min: 1,
            proto_max: 1,
            endpoint: endpoint(g),
            capabilities: 0,
            lifecycle: None,
            build_id: None,
        },
    )
    .unwrap();
    path
}
fn discover(dir: &Path, current: &str) -> Vec<HostCandidate> {
    discover_hosts_in(
        Some(dir),
        current,
        &endpoint(None),
        endpoint,
        |_| true,
        |_| false,
    )
}

#[test]
fn legacy_frozen_when_gate_on() {
    let dir = tempfile::tempdir().unwrap();
    record(dir.path(), None, 1);
    record(dir.path(), Some(A), 2);
    let found = discover(dir.path(), &endpoint(Some(A)));
    assert_eq!(found.len(), 2);
    assert_eq!(
        found.iter().find(|c| c.pid == Some(1)).unwrap().role,
        HostRole::Frozen
    );
    assert_eq!(
        found.iter().find(|c| c.pid == Some(2)).unwrap().role,
        HostRole::Current
    );
}

#[test]
fn legacy_current_when_gate_off_or_no_generation() {
    let dir = tempfile::tempdir().unwrap();
    record(dir.path(), None, 1);
    record(dir.path(), Some(A), 2);
    for g in [
        super::endpoints::named_generation(Some(A), false),
        super::endpoints::named_generation(None, true),
    ] {
        let found = discover(dir.path(), &endpoint(g));
        assert_eq!(found.len(), 2, "gate must not disable discovery");
        assert_eq!(
            found.iter().find(|c| c.pid == Some(1)).unwrap().role,
            HostRole::Current
        );
        assert_eq!(
            found.iter().find(|c| c.pid == Some(2)).unwrap().role,
            HostRole::Frozen
        );
    }
}

#[test]
fn alias_probe_and_record_dedupe() {
    let dir = tempfile::tempdir().unwrap();
    record(dir.path(), None, 1);
    let current = endpoint(None).to_uppercase();
    let found = discover_hosts_in(
        Some(dir.path()),
        &current,
        &endpoint(None),
        endpoint,
        |_| true,
        |_| true,
    );
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].pid, Some(1));
    assert_eq!(found[0].role, HostRole::Current);
    assert!(
        found[0].record.is_some(),
        "probe must not replace record identity"
    );
}

#[test]
fn missing_current_record_probes_before_spawn() {
    let dir = tempfile::tempdir().unwrap();
    let current = endpoint(Some(A));
    for corrupt in [false, true] {
        if corrupt {
            let p = super::endpoints::host_file_for(dir.path(), Some(A), "host-record.json");
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, "not json").unwrap();
        }
        let mut probes = Vec::new();
        let found = discover_hosts_in(
            Some(dir.path()),
            &current,
            &endpoint(None),
            endpoint,
            |_| false,
            |ep| {
                probes.push(ep.to_owned());
                ep == current
            },
        );
        assert_eq!(probes, vec![endpoint(None), current.clone()]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].endpoint, current);
        assert_eq!(found[0].role, HostRole::Current);
        assert_eq!(found[0].generation.as_deref(), Some(A));
        assert!(found[0].record.is_none());
    }
}

#[test]
fn dead_pid_ignored() {
    let dir = tempfile::tempdir().unwrap();
    record(dir.path(), Some(A), 1);
    record(dir.path(), Some(B), 2);
    let found = discover_hosts_in(
        Some(dir.path()),
        &endpoint(None),
        &endpoint(None),
        endpoint,
        |pid| pid == 2,
        |_| false,
    );
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].pid, Some(2));
}

#[test]
fn healed_old_record_orders_by_mtime_documented() {
    let dir = tempfile::tempdir().unwrap();
    let old = record(dir.path(), Some(A), 1);
    let new = record(dir.path(), Some(B), 2);
    let set_time = |path: &Path, seconds| {
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_times(
                std::fs::FileTimes::new()
                    .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(seconds)),
            )
            .unwrap();
    };
    set_time(&old, 10);
    set_time(&new, 20);
    assert_eq!(
        discover(dir.path(), &endpoint(None))
            .iter()
            .map(|c| c.pid)
            .collect::<Vec<_>>(),
        vec![Some(2), Some(1)]
    );
    // Healing an old advertisement wins; this is deliberately not build chronology.
    set_time(&old, 30);
    assert_eq!(
        discover(dir.path(), &endpoint(None))
            .iter()
            .map(|c| c.pid)
            .collect::<Vec<_>>(),
        vec![Some(1), Some(2)]
    );
    set_time(&new, 30);
    assert_eq!(
        discover(dir.path(), &endpoint(None))[0]
            .generation
            .as_deref(),
        Some(A)
    );
}

#[test]
fn record_endpoint_must_match_directory_and_incompatible_is_listed() {
    let dir = tempfile::tempdir().unwrap();
    let path = record(dir.path(), Some(A), 1);
    let mut rec = termflow_pty_protocol::read_record(&path).unwrap().unwrap();
    rec.endpoint = endpoint(Some(B));
    termflow_pty_protocol::write_record(&path, &rec).unwrap();
    assert!(discover(dir.path(), &endpoint(None)).is_empty());
    rec.endpoint = endpoint(Some(A));
    rec.proto_min = 99;
    rec.proto_max = 99;
    termflow_pty_protocol::write_record(&path, &rec).unwrap();
    let found = discover(dir.path(), &endpoint(None));
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].pid, Some(1));
    assert!(!found[0].compatible());
}

/// A legacy endpoint names no generation, even when the profile it is scoped to
/// is called something that looks like one; a qualified endpoint names its own.
#[test]
fn an_endpoint_names_a_generation_only_when_it_is_qualified() {
    use super::discovery::generation_of_endpoint_in;
    let legacy = endpoint(None);
    assert_eq!(generation_of_endpoint_in(&legacy, &legacy), None);
    assert_eq!(generation_of_endpoint_in(&legacy.to_uppercase(), &legacy), None, "pipe names ignore case");
    assert_eq!(generation_of_endpoint_in(&endpoint(Some(A)), &legacy).as_deref(), Some(A));

    let lookalike = super::endpoints::qualified_pipe_for(
        "u",
        &crate::profile::ProfileIdentity {
            channel: "dev",
            name: A.into(),
            integrity: crate::profile::Integrity::Medium,
        },
        None,
    );
    assert_eq!(
        generation_of_endpoint_in(&lookalike, &lookalike),
        None,
        "a profile named like a generation does not give the legacy endpoint one"
    );
}
