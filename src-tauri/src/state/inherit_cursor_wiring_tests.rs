//! Which host verdict a connection records for `CAP_INHERIT_CURSOR`.
//!
//! A wrong answer is the original defect again: the renderer anchors the restored replay on a row
//! ConPTY was never told, and the first keystroke lands on the history.

use crate::pty_host_client::{
    adopted_host_inherits_cursor, connected_host_inherits_cursor, host_inherits_cursor_served_by, HostConnectionOrigin,
};
use termflow_pty_protocol::{HostRecord, CAP_DRAIN, CAP_INHERIT_CURSOR};
use crate::state::source_scan::production;
use std::cell::Cell;

#[test]
fn a_host_launched_here_is_judged_by_its_own_record_alone() {
    // The plan said "capable" (the record of a host that has since died); the replacement that
    // was launched says no. The old bit must not survive.
    assert!(!connected_host_inherits_cursor(HostConnectionOrigin::SpawnedHere, true, || false));
    // And the converse: no record before the launch, the launched host says yes.
    assert!(connected_host_inherits_cursor(HostConnectionOrigin::SpawnedHere, false, || true));
}

#[test]
fn an_adopted_host_keeps_the_verdict_of_its_selected_record_and_reads_nothing_else() {
    let read = Cell::new(false);
    let ask = |answer: bool| {
        let read = &read;
        move || {
            read.set(true);
            answer
        }
    };
    assert!(connected_host_inherits_cursor(HostConnectionOrigin::Adopted, true, ask(false)));
    assert!(!connected_host_inherits_cursor(HostConnectionOrigin::Adopted, false, ask(true)));
    assert!(!read.get(), "an adopted host's verdict never comes from re-reading the record file");
}

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

/// The replacement could not publish its own record, so the DEAD host's is still readable: it
/// names another pid and must say nothing about the host that is actually serving the connection.
#[test]
fn a_readable_record_of_a_dead_host_does_not_speak_for_the_host_serving_the_connection() {
    let dead_but_capable = record(100, CAP_INHERIT_CURSOR | CAP_DRAIN);
    assert!(!host_inherits_cursor_served_by(Some(&dead_but_capable), Some(200)), "another process is serving");
    assert!(host_inherits_cursor_served_by(Some(&dead_but_capable), Some(100)), "the record names the server");
    assert!(!host_inherits_cursor_served_by(Some(&dead_but_capable), None), "an unknown server pid vouches for nothing");
    assert!(!host_inherits_cursor_served_by(Some(&record(100, CAP_DRAIN)), Some(100)), "the right host without the bit");
    assert!(!host_inherits_cursor_served_by(None, Some(100)), "no record");
    // The comparison is between the record's pid and the server's, whatever they are: a second
    // pair (neither number shared with the first, one above and one below its mate) keeps a
    // hard-coded pid from passing.
    let other_capable = record(4242, CAP_INHERIT_CURSOR);
    assert!(host_inherits_cursor_served_by(Some(&other_capable), Some(4242)), "a different host, also named by its record");
    assert!(!host_inherits_cursor_served_by(Some(&other_capable), Some(100)), "the first host's pid is not this record's");
    assert!(!host_inherits_cursor_served_by(Some(&dead_but_capable), Some(4242)), "and the converse");
    assert!(!host_inherits_cursor_served_by(Some(&other_capable), Some(7)), "a pid below the record's");
    // The whole pid is compared: pids above 16 bits, and two that differ only above the low 16 bits.
    let wide = record(70_000, CAP_INHERIT_CURSOR);
    assert!(host_inherits_cursor_served_by(Some(&wide), Some(70_000)), "a pid wider than 16 bits");
    assert!(!host_inherits_cursor_served_by(Some(&wide), Some(70_000 + 65_536)), "same low 16 bits, another process");
    let widest = record(u32::MAX, CAP_INHERIT_CURSOR);
    assert!(host_inherits_cursor_served_by(Some(&widest), Some(u32::MAX)), "the largest pid");
    assert!(!host_inherits_cursor_served_by(Some(&widest), Some(u32::MAX - 1)), "the neighbour of the largest pid");
}

#[test]
fn an_adopted_hosts_record_is_trusted_unless_it_names_another_process() {
    // the record's verdict, no pid evidence either way
    assert!(adopted_host_inherits_cursor(true, Some(5), Some(5)));
    assert!(adopted_host_inherits_cursor(true, None, Some(6)), "a record without a pid cannot be contradicted");
    assert!(adopted_host_inherits_cursor(true, Some(5), None), "an unknown server pid cannot contradict it");
    assert!(!adopted_host_inherits_cursor(false, Some(5), Some(5)), "a negative record stays negative");
    // the record belongs to a different process than the one answering
    assert!(!adopted_host_inherits_cursor(true, Some(5), Some(6)));
    // other numbers, both orders: the rule is "the two differ", not a particular pair
    assert!(adopted_host_inherits_cursor(true, Some(9001), Some(9001)));
    assert!(!adopted_host_inherits_cursor(true, Some(9001), Some(12)));
    assert!(!adopted_host_inherits_cursor(true, Some(12), Some(9001)));
    // the whole pid: wider than 16 bits, and two that share their low 16 bits
    assert!(adopted_host_inherits_cursor(true, Some(70_000), Some(70_000)));
    assert!(!adopted_host_inherits_cursor(true, Some(70_000), Some(70_000 + 65_536)));
    assert!(!adopted_host_inherits_cursor(true, Some(u32::MAX), Some(u32::MAX - 1)));
}

/// The decisions above only matter if the connect paths use them: pin that the launch path asks
/// through them with its own origin (not OR-ing the plan's flag with a re-read) and that the
/// adopt-only path applies the same pid check to its selected record, each in its own function.
#[test]
fn the_connect_paths_record_the_verdict_through_that_one_decision() {
    let src: String = production(include_str!("host_port.rs")).chars().filter(|c| !c.is_whitespace()).collect();
    // Each function's region runs from its own declaration to the other's (the later one to the end
    // of the file), so the order they are declared in does not matter.
    let at = |declaration: &str| src.find(declaration).unwrap_or_else(|| panic!("{declaration} is declared"));
    let (current_at, frozen_at) = (at("asyncfnconnect_current("), at("asyncfnconnect_frozen("));
    let region = |from: usize, other: usize| if other > from { &src[from..other] } else { &src[from..] };
    let (current, frozen) = (region(current_at, frozen_at), region(frozen_at, current_at));
    assert!(
        current.contains(
            "client.set_inherit_cursor(crate::pty_host_client::connected_host_inherits_cursor(origin,crate::pty_host_client::adopted_host_inherits_cursor(flags.inherit_cursor,candidate.pid,client.server_pid()),||crate::pty_host_client::spawned_host_inherits_cursor(client.server_pid()),));"
        ),
        "the launch path must ask connected_host_inherits_cursor with its own origin and the connection's server pid"
    );
    assert!(
        frozen.contains(
            "client.set_inherit_cursor(crate::pty_host_client::adopted_host_inherits_cursor(flags.inherit_cursor,candidate.pid,client.server_pid(),));"
        ),
        "the adopt-only path must drop a record that names another process than the one answering"
    );
    assert_eq!(current.matches("set_inherit_cursor(").count(), 1, "one place records the verdict on the launch path");
    assert_eq!(frozen.matches("set_inherit_cursor(").count(), 1, "one place records the verdict on the adopt-only path");
    assert!(
        !src.contains("set_inherit_cursor(flags.inherit_cursor)"),
        "the selected record's bit taken as-is trusts a record that may belong to a process that has exited"
    );
    assert!(
        !src.contains("flags.inherit_cursor||"),
        "OR-ing the plan's bit with a re-read keeps a dead host's `capable` on its replacement"
    );
}
