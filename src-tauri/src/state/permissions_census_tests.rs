//! Source census for the permissions capability bit (plan 060): both connection sites install
//! `CAP_PERMISSIONS` through one canonical live statement, as the MCP-hold bit does (see
//! [`super::mcp_hold_census_tests`]). The capability table tests the decision function; this
//! census is what fails when a connection site stops calling it.

use super::live_call_census::{find_calls, require_top_statement, top_statement_starting, Src};
use super::mcp_hold_census_tests::mutate;

const HOST_PORT: &str = include_str!("host_port.rs");

const CURRENT_STATEMENT: &str = "client.set_permissions(crate::pty_host_client::connection_capability(origin, \
     flags.permissions, candidate.pid, client.server_pid(), termflow_pty_protocol::CAP_PERMISSIONS, \
     || crate::pty_host_client::read_advertised_record()));";
const FROZEN_STATEMENT: &str = "client.set_permissions(crate::pty_host_client::connection_capability(\
     HostConnectionOrigin::Adopted, flags.permissions, candidate.pid, client.server_pid(), \
     termflow_pty_protocol::CAP_PERMISSIONS, || None));";

fn check_connection_sites(host_port: &str) -> Result<(), String> {
    let src = Src::production(host_port);
    for (signature, statement) in
        [("async fn connect_current(", CURRENT_STATEMENT), ("async fn connect_frozen(", FROZEN_STATEMENT)]
    {
        let body = src.try_function(signature)?;
        let at = require_top_statement(&src, &body, statement).map_err(|e| format!("{signature} {e}"))?;
        let tail = top_statement_starting(&src, &body, "Ok(Opened{")
            .ok_or_else(|| format!("{signature} lost its `Ok(Opened {{` return"))?;
        if at >= tail {
            return Err(format!("{signature} installs the bit after the `Ok(Opened {{` return"));
        }
    }
    // host_port.rs has no `std::fs::set_permissions`, so every match here is the client setter.
    if find_calls(&src.masked, "set_permissions(").len() != 2 {
        return Err("host_port.rs must contain exactly the two `.set_permissions(` statements".into());
    }
    Ok(())
}

#[test]
fn both_connection_sites_install_the_permissions_bit() {
    check_connection_sites(HOST_PORT).unwrap();
}

#[test]
fn the_permissions_census_kills_each_planted_mutation() {
    let frozen_tail = "Ok(Opened { client, epoch, build_id })";
    let cases: Vec<(&str, String)> = vec![
        ("the frozen statement removed", mutate(HOST_PORT, FROZEN_STATEMENT, "")),
        ("the current statement removed", mutate(HOST_PORT, CURRENT_STATEMENT, "")),
        ("the wrong bit at the current site", mutate(HOST_PORT, "flags.permissions, candidate.pid, client.server_pid(), termflow_pty_protocol::CAP_PERMISSIONS, || crate", "flags.permissions, candidate.pid, client.server_pid(), termflow_pty_protocol::CAP_MCP_HOLD, || crate")),
        ("a SpawnedHere origin at the frozen site", mutate(HOST_PORT, "connection_capability(HostConnectionOrigin::Adopted", "connection_capability(HostConnectionOrigin::SpawnedHere")),
        ("the bit set from the plan alone at the frozen site", mutate(HOST_PORT, FROZEN_STATEMENT, "client.set_permissions(flags.permissions);")),
        ("the frozen statement wrapped in `if false`", mutate(HOST_PORT, FROZEN_STATEMENT, &format!("if false {{ {FROZEN_STATEMENT} }}"))),
        ("the frozen statement after the Ok(Opened) return", {
            let cut = mutate(HOST_PORT, FROZEN_STATEMENT, "");
            mutate(&cut, frozen_tail, &format!("{frozen_tail};\n        {FROZEN_STATEMENT}"))
        }),
    ];
    for (name, source) in cases {
        assert!(check_connection_sites(&source).is_err(), "the census let this mutation through: {name}");
    }
}
