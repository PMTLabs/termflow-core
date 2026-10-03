//! Which host verdict a connection records for `CAP_INHERIT_CURSOR`.
//!
//! A wrong answer is the original defect again: the renderer anchors the restored replay on a row
//! ConPTY was never told, and the first keystroke lands on the history.

use crate::pty_host_client::{connected_host_inherits_cursor, HostConnectionOrigin};
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

/// The decision above only matters if the connect paths use it: pin that the launch path asks
/// through it with its own origin (not OR-ing the plan's flag with a re-read) and that the
/// adopt-only path still takes the selected record's flag.
#[test]
fn the_connect_paths_record_the_verdict_through_that_one_decision() {
    let src: String = production(include_str!("host_port.rs")).chars().filter(|c| !c.is_whitespace()).collect();
    assert!(
        src.contains(
            "client.set_inherit_cursor(crate::pty_host_client::connected_host_inherits_cursor(origin,flags.inherit_cursor,crate::pty_host_client::spawned_host_inherits_cursor,));"
        ),
        "the launch path must ask connected_host_inherits_cursor with its own origin"
    );
    assert!(src.contains("client.set_inherit_cursor(flags.inherit_cursor);"), "the adopt-only path keeps its selected record's flag");
    assert_eq!(src.matches("set_inherit_cursor(").count(), 2, "every place that records the verdict is covered above");
    assert!(
        !src.contains("flags.inherit_cursor||"),
        "OR-ing the plan's bit with a re-read keeps a dead host's `capable` on its replacement"
    );
}
