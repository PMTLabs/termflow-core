use super::{plan_connection, ConnectPlan};
use termflow_pty_protocol::HostRecord;

fn record(proto_min: u16, proto_max: u16) -> HostRecord {
    HostRecord {
        format: 1,
        instance_id: 99,
        pid: 1,
        proto_min,
        proto_max,
        endpoint: "ep-99".into(),
        capabilities: termflow_pty_protocol::CAP_DRAIN,
    }
}

#[test]
fn no_record_is_legacy_or_none() {
    assert_eq!(plan_connection(None), ConnectPlan::LegacyOrNone);
}

#[test]
fn compatible_record_plans_bootstrap_at_negotiated_version() {
    // We speak 1..=1; host advertises 1..=5 → common max is 1.
    match plan_connection(Some(record(1, 5))) {
        ConnectPlan::Bootstrap {
            endpoint,
            version,
            instance_id,
            host_caps,
        } => {
            assert_eq!(version, 1);
            assert_eq!(endpoint, "ep-99");
            assert_eq!(instance_id, 99);
            assert_eq!(host_caps & termflow_pty_protocol::CAP_DRAIN, termflow_pty_protocol::CAP_DRAIN);
        }
        other => panic!("expected Bootstrap, got {other:?}"),
    }
}

#[test]
fn disjoint_versions_are_incompatible_not_a_kill() {
    // Host only speaks 2..=3; we speak 1..=1 → no common version.
    assert_eq!(
        plan_connection(Some(record(2, 3))),
        ConnectPlan::Incompatible { instance_id: 99 }
    );
}
