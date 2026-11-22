//! Which verdict a connection records for `CAP_MCP_HOLD`.
//!
//! A wrong answer sends `HoldMcp`/`ReleaseMcp` to a host that cannot decode them (it drops the
//! connection) or to a different process than the one the record describes. Every case goes
//! through the production installer, [`connection_mcp_hold`], with records passed directly: no
//! test writes the global discovery record.

use super::{
    adopted_host_advertises, connected_host_advertises, connection_mcp_hold, host_advertises,
    host_advertises_served_by, HostConnectionOrigin,
};
use std::cell::Cell;
use termflow_pty_protocol::{HostRecord, CAP_ATTACH_ACK, CAP_INHERIT_CURSOR, CAP_MCP_HOLD, CAP_SHUTDOWN_CONTROL};

fn record(pid: u32, capabilities: u32) -> HostRecord {
    HostRecord {
        format: 1,
        instance_id: 7,
        pid,
        proto_min: 1,
        proto_max: 1,
        endpoint: "ep".into(),
        capabilities,
        lifecycle: None,
        build_id: None,
    }
}

/// `connection_mcp_hold` for a host launched here: the re-read record is `record`.
fn spawned(record: Option<HostRecord>, server_pid: Option<u32>) -> bool {
    // `planned` is deliberately the opposite of the expected answer in the cases that matter: a
    // spawned host never inherits the pre-connect plan's verdict.
    connection_mcp_hold(HostConnectionOrigin::SpawnedHere, true, Some(1), server_pid, || record)
}

/// `connection_mcp_hold` for an adopted host; the reader must never be called.
fn adopted(planned: bool, candidate_pid: Option<u32>, server_pid: Option<u32>) -> bool {
    let read = Cell::new(false);
    let answer = connection_mcp_hold(HostConnectionOrigin::Adopted, planned, candidate_pid, server_pid, || {
        read.set(true);
        Some(record(1, CAP_MCP_HOLD))
    });
    assert!(!read.get(), "an adopted host's verdict never comes from re-reading the record file");
    answer
}

#[test]
fn a_spawned_host_is_judged_by_the_record_that_names_its_own_process() {
    let capable = || Some(record(500, CAP_MCP_HOLD | CAP_ATTACH_ACK));
    assert!(spawned(capable(), Some(500)), "its re-read record has the bit and names the server");
    assert!(!spawned(Some(record(500, CAP_ATTACH_ACK | CAP_SHUTDOWN_CONTROL)), Some(500)), "the right process without the bit");
    assert!(!spawned(capable(), Some(501)), "a record naming another process says nothing about this one");
    assert!(!spawned(capable(), None), "an unknown server pid vouches for no record");
    assert!(!spawned(None, Some(500)), "no record");
    // the whole pid is compared
    assert!(spawned(Some(record(70_000, CAP_MCP_HOLD)), Some(70_000)));
    assert!(!spawned(Some(record(70_000, CAP_MCP_HOLD)), Some(70_000 + 65_536)));
}

#[test]
fn a_spawned_host_does_not_inherit_the_pre_connect_plan() {
    // planned = true (the dead host's record said yes), the replacement's own record says no.
    assert!(!connection_mcp_hold(
        HostConnectionOrigin::SpawnedHere,
        true,
        Some(500),
        Some(500),
        || Some(record(500, CAP_ATTACH_ACK)),
    ));
    // planned = false (no record before the launch), the launched host's record says yes.
    assert!(connection_mcp_hold(
        HostConnectionOrigin::SpawnedHere,
        false,
        None,
        Some(500),
        || Some(record(500, CAP_MCP_HOLD)),
    ));
}

#[test]
fn an_adopted_host_keeps_its_selected_records_verdict_unless_the_pids_disagree() {
    assert!(!adopted(true, Some(5), Some(6)), "both pids known and different");
    assert!(!adopted(true, Some(6), Some(5)), "both orders");
    assert!(adopted(true, Some(5), Some(5)), "the same process");
    assert!(adopted(true, Some(5), None), "an unknown server pid cannot contradict the record");
    assert!(adopted(true, None, Some(6)), "a record without a pid cannot be contradicted");
    assert!(adopted(true, None, None));
    assert!(!adopted(false, Some(5), Some(5)), "a negative record stays negative");
    assert!(!adopted(false, None, None));
    assert!(!adopted(true, Some(u32::MAX), Some(u32::MAX - 1)), "the neighbour of the largest pid");
}

#[test]
fn the_installer_is_the_generic_resolver_with_this_bit() {
    // The same record, two bits: the verdict follows the bit asked for, not the record in general.
    let cursor_only = record(9, CAP_INHERIT_CURSOR);
    assert!(!host_advertises(Some(&cursor_only), CAP_MCP_HOLD));
    assert!(host_advertises(Some(&cursor_only), CAP_INHERIT_CURSOR));
    assert!(!host_advertises_served_by(Some(&cursor_only), Some(9), CAP_MCP_HOLD));
    assert!(host_advertises_served_by(Some(&cursor_only), Some(9), CAP_INHERIT_CURSOR));
    assert!(host_advertises(Some(&record(9, CAP_MCP_HOLD)), CAP_MCP_HOLD), "independent of every other capability");
    assert!(!host_advertises(None, CAP_MCP_HOLD), "no record is a legacy host");
    assert!(adopted_host_advertises(true, None, None));
    assert!(connected_host_advertises(HostConnectionOrigin::Adopted, true, || false));
    assert!(!connected_host_advertises(HostConnectionOrigin::SpawnedHere, true, || false));
}

/// A server pid the OS gives no answer for leaves an ADOPTED record's positive bit standing: the
/// identity is unverified, and that is the accepted rule it shares with `CAP_INHERIT_CURSOR`
/// (plan 055 AC9).
#[test]
fn an_adopted_host_with_an_unknown_server_pid_keeps_a_positive_bit_as_the_cursor_bit_does() {
    use super::adopted_host_inherits_cursor;
    for (planned, record_pid, server_pid) in [
        (true, Some(5), None),
        (true, None, Some(5)),
        (true, None, None),
        (true, Some(5), Some(5)),
        (true, Some(5), Some(6)),
        (false, Some(5), Some(5)),
        (false, None, None),
    ] {
        assert_eq!(
            adopted_host_advertises(planned, record_pid, server_pid),
            adopted_host_inherits_cursor(planned, record_pid, server_pid),
            "the two capability bits share one adoption rule ({planned}, {record_pid:?}, {server_pid:?})"
        );
    }
}
