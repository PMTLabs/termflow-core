use super::{host_build_disposition, plan_connection, ConnectPlan, HostBuildDisposition, HostConnectionOrigin, HostRetention};
use termflow_pty_protocol::{HostRecord, LifecycleContract, RetentionPolicy};

fn record(proto_min: u16, proto_max: u16) -> HostRecord {
    HostRecord {
        format: 1,
        instance_id: 99,
        pid: 1,
        proto_min,
        proto_max,
        endpoint: "ep-99".into(),
        capabilities: termflow_pty_protocol::CAP_DRAIN,
        lifecycle: None,
        build_id: None,
    }
}

#[test]
fn no_record_is_legacy_or_none() {
    assert_eq!(plan_connection(None), ConnectPlan::LegacyOrNone);
}

#[test]
fn old_record_json_without_lifecycle_yields_unknown() {
    let old = r#"{
        "instance_id": 99,
        "pid": 1,
        "proto_min": 1,
        "proto_max": 1,
        "endpoint": "ep-99"
    }"#;
    let record = HostRecord::from_json(old).unwrap();
    assert!(matches!(
        plan_connection(Some(record)),
        ConnectPlan::Bootstrap { lifecycle: HostRetention::Unknown, .. }
    ));
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
            lifecycle,
        } => {
            assert_eq!(version, 1);
            assert_eq!(endpoint, "ep-99");
            assert_eq!(instance_id, 99);
            assert_eq!(host_caps & termflow_pty_protocol::CAP_DRAIN, termflow_pty_protocol::CAP_DRAIN);
            assert_eq!(lifecycle, HostRetention::Unknown);
        }
        other => panic!("expected Bootstrap, got {other:?}"),
    }
}

#[test]
fn lifecycle_requires_both_capability_and_contract() {
    let mut rec = record(1, 1);
    rec.lifecycle = Some(LifecycleContract {
        version: 1,
        retention: RetentionPolicy::Indefinite,
    });
    assert!(matches!(
        plan_connection(Some(rec.clone())),
        ConnectPlan::Bootstrap { lifecycle: HostRetention::Unknown, .. }
    ));

    rec.capabilities |= termflow_pty_protocol::CAP_LIFECYCLE_CONTRACT;
    assert!(matches!(
        plan_connection(Some(rec)),
        ConnectPlan::Bootstrap { lifecycle: HostRetention::Indefinite, .. }
    ));
}

#[test]
fn bounded_lifecycle_carries_active_duration() {
    let mut rec = record(1, 1);
    rec.capabilities |= termflow_pty_protocol::CAP_LIFECYCLE_CONTRACT;
    rec.lifecycle = Some(LifecycleContract {
        version: 1,
        retention: RetentionPolicy::Bounded { active_secs: 900 },
    });
    assert!(matches!(
        plan_connection(Some(rec)),
        ConnectPlan::Bootstrap { lifecycle: HostRetention::Bounded { active_secs: 900 }, .. }
    ));
}

#[test]
fn disjoint_versions_are_incompatible_not_a_kill() {
    // Host only speaks 2..=3; we speak 1..=1 → no common version.
    assert_eq!(
        plan_connection(Some(record(2, 3))),
        ConnectPlan::Incompatible { instance_id: 99 }
    );
}

#[test]
fn bounded_record_is_retained_only_when_this_process_spawned_the_connected_host() {
    let mut rec = record(1, 1);
    rec.capabilities |= termflow_pty_protocol::CAP_LIFECYCLE_CONTRACT;
    rec.lifecycle = Some(LifecycleContract {
        version: 1,
        retention: RetentionPolicy::Bounded { active_secs: 900 },
    });
    let plan = plan_connection(Some(rec));
    assert_eq!(
        plan.retention_for(HostConnectionOrigin::SpawnedHere),
        HostRetention::Bounded { active_secs: 900 },
        "a host spawned in this app session is confirmed by construction"
    );
    assert_eq!(
        plan.retention_for(HostConnectionOrigin::Adopted),
        HostRetention::Unknown,
        "the identical discovery record cannot attest which host accepted an adopted pipe"
    );
}

#[test]
fn stale_host_is_adopted_but_reports_its_observed_digest() {
    let mut old = record(1, 1);
    old.build_id = Some("old-digest".into());
    assert_eq!(
        host_build_disposition(Some(&old), Some("new-digest")),
        HostBuildDisposition::Stale { observed: "old-digest".into(), expected: "new-digest".into() }
    );
    // Its usable capability remains the adoption gate; hash mismatch never asks
    // the app to kill this instance or its sessions.
    assert!(matches!(plan_connection(Some(old)), ConnectPlan::Bootstrap { .. }));
}

#[test]
fn old_record_without_build_id_is_explicitly_unknown() {
    assert_eq!(host_build_disposition(Some(&record(1, 1)), Some("new")), HostBuildDisposition::Unknown);
}

#[test]
fn launchable_host_with_unreadable_local_digest_does_not_reject_a_discovered_host() {
    let mut discovered_host = record(42, 7);
    discovered_host.build_id = Some("running-host-digest".into());
    assert_eq!(
        host_build_disposition(Some(&discovered_host), None),
        HostBuildDisposition::Unknown,
        "a missing parent-side digest is unverified, not evidence that the readable launch path mismatches the host"
    );
}
