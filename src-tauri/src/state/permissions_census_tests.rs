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

fn check_unix_evidence(client: &str, host: &str) -> Result<(), String> {
    // The anchors below span a newline; a Windows checkout has CRLF (as `mutate` already allows for).
    let (client, host) = (client.replace("\r\n", "\n"), host.replace("\r\n", "\n"));
    let (client, host) = (client.as_str(), host.as_str());
    let unix_start = client.find("#[cfg(unix)]\npub async fn connect_or_spawn(").ok_or("missing Unix connect")?;
    let unix_end = client[unix_start..].find("/// Spawn the sidecar detached").ok_or("missing Unix connect end")? + unix_start;
    let unix = Src::production(&client[unix_start..unix_end]);
    let body = unix.try_function("pub async fn connect_or_spawn(")?;
    require_top_statement(&unix, &body, "let client = wire_unix_host_client(conn, deps);")?;
    let src = Src::production(client);
    let helper = src.try_function("pub(crate) fn wire_unix_host_client(")?;
    let normalized = src.norm(&(helper.open..helper.close + 1));
    let evidence = normalized.find("let(peer_pid,peer_token)=(macos_spawn::peer_pid(&conn),macos_spawn::peer_token(&conn));").ok_or("missing evidence")?;
    let split = normalized.find("let(rd,wr)=tokio::io::split(conn);").ok_or("missing split")?;
    let wire = normalized.find("letclient=wire_client(rd,wr,deps);").ok_or("missing wire")?;
    if !(evidence < split && split < wire) { return Err("evidence must precede split and wiring".into()); }
    if !normalized.contains("client.exe_origin.set_server_pid(peer_pid);") || !normalized.contains("*client.peer_token.lock().unwrap_or_else(|e|e.into_inner())=peer_token;") {
        return Err("helper must install both pieces of evidence".into());
    }
    let start = host.find("#[cfg(unix)]\npub(super) async fn connect_existing(").ok_or("missing Unix adoption")?;
    let end = host[start..].find("#[cfg(not(any(windows, unix)))]").ok_or("missing next platform")? + start;
    let host = Src::production(&host[start..end]);
    if !host.masked.contains("return Ok(wire_unix_host_client(conn, deps));") { return Err("adoption must use helper".into()); }
    Ok(())
}

#[test]
fn unix_host_evidence_census_and_mutations() {
    let client = include_str!("../pty_host_client.rs");
    let host = include_str!("host_connect.rs");
    check_unix_evidence(client, host).unwrap();
    for (c, h) in [
        (mutate(client, "let client = wire_unix_host_client(conn, deps);", "let client = other(conn, deps);"), host.to_owned()),
        (client.to_owned(), mutate(host, "return Ok(wire_unix_host_client(conn, deps));", "return Ok(other(conn, deps));")),
        (mutate(client, "macos_spawn::peer_token(&conn)", "None"), host.to_owned()),
        (mutate(client, "*client.peer_token.lock().unwrap_or_else(|e| e.into_inner()) = peer_token;", ""), host.to_owned()),
    ] { assert!(check_unix_evidence(&c, &h).is_err()); }
    let mut connects = Vec::new();
    let mut wires = Vec::new();
    for (path, text) in super::mcp_hold_census_tests::production_sources() {
        let src = Src::production(&text);
        for _ in find_calls(&src.masked, "UnixStream::connect(") {
            connects.push(path.file_name().unwrap().to_string_lossy().to_string());
        }
        for _ in find_calls(&src.masked, "wire_client(") {
            wires.push(path.file_name().unwrap().to_string_lossy().to_string());
        }
    }
    connects.sort();
    wires.sort();
    assert_eq!(connects, ["host_connect.rs", "pty_host_client.rs", "pty_host_client.rs"]);
    // Windows named-pipe client and elevated inbound pipe, plus the Unix helper.
    assert_eq!(wires, ["pty_host_client.rs", "pty_host_client.rs", "terminals.rs"]);
}

const COMMANDS: &str = include_str!("../commands/permissions.rs");
const STATE_PERMISSIONS: &str = include_str!("permissions.rs");

/// The single-flight behaviour test drives a test inventory, so this pins the production links it
/// cannot see: the status command joins the flight, the request command does not, and the
/// AppState inventory reaches `StatusFlight::resolve`. Each body is compared whole, so a dead branch
/// or an early return cannot keep the expected call while another one runs.
fn check_status_flight_wiring(commands: &str, state: &str) -> Result<(), String> {
    fn body_is(src: &Src, signature: &str, expected: &str) -> Result<(), String> {
        let body = src.try_function(signature)?;
        let actual = src.norm(&(body.open..body.close + 1));
        let expected: String = expected.split_whitespace().collect();
        if actual != expected { return Err(format!("{signature} body is {actual}")); }
        Ok(())
    }
    let src = Src::production(commands);
    let guard = "let epoch = next_epoch()?; if !cfg!(target_os = \"macos\") { return Ok(unsupported(epoch, in_process_sessions(&state))); }";
    body_is(&src, "pub async fn macos_permission_status(", &format!("{{ {guard} Ok(execute(&SystemPort(&*state, true), None, epoch).await) }}"))?;
    body_is(&src, "pub async fn request_macos_permission(",
        &format!("{{ {guard} Ok(execute_expected(&SystemPort(&*state, false), Some(kind), epoch, expected).await) }}"))?;
    let start = commands.find("impl Inventory for AppState {").ok_or("missing AppState inventory")?;
    let end = commands[start..].find("// Only read-only status commands").ok_or("missing AppState inventory end")? + start;
    let app = Src::production(&commands[start..end]);
    body_is(&app, "async fn resolve_status(", "{ crate::state::permissions::permission_status_subject(self).await }")?;
    body_is(&Src::production(state), "pub(crate) async fn permission_status_subject(",
        "{ let owned = state.clone(); state.permission_status_flight.resolve(move || async move { permission_subject(&owned).await }).await }")
}

#[test]
fn status_flight_wiring_census_and_mutations() {
    check_status_flight_wiring(COMMANDS, STATE_PERMISSIONS).unwrap();
    for (c, s) in [
        (mutate(COMMANDS, "execute(&SystemPort(&*state, true), None, epoch)", "execute(&SystemPort(&*state, false), None, epoch)"), STATE_PERMISSIONS.to_owned()),
        (mutate(COMMANDS, "SystemPort(&*state, false), Some(kind)", "SystemPort(&*state, true), Some(kind)"), STATE_PERMISSIONS.to_owned()),
        (mutate(COMMANDS, "crate::state::permissions::permission_status_subject(self).await", "crate::state::permissions::permission_subject(self).await"), STATE_PERMISSIONS.to_owned()),
        (COMMANDS.to_owned(), mutate(STATE_PERMISSIONS, "state.permission_status_flight.resolve(move || async move { permission_subject(&owned).await }).await", "permission_subject(&owned).await")),
        // The expected call kept in a dead branch while a bypass actually runs (review r3, R3-02).
        (mutate(COMMANDS, "    Ok(execute(&SystemPort(&*state, true), None, epoch).await)\n",
            "    if false { return Ok(execute(&SystemPort(&*state, true), None, epoch).await); }\n    Ok(execute(&SystemPort(&*state, false), None, epoch).await)\n"), STATE_PERMISSIONS.to_owned()),
        (mutate(COMMANDS, "    Ok(execute_expected(&SystemPort(&*state, false), Some(kind), epoch, expected).await)\n",
            "    if false { return Ok(execute_expected(&SystemPort(&*state, false), Some(kind), epoch, expected).await); }\n    Ok(execute_expected(&SystemPort(&*state, true), Some(kind), epoch, expected).await)\n"), STATE_PERMISSIONS.to_owned()),
        (mutate(COMMANDS, "    let epoch = next_epoch()?;\n    if !cfg!(target_os = \"macos\") { return Ok(unsupported(epoch, in_process_sessions(&state))); }\n    Ok(execute(",
            "    let epoch = next_epoch()?;\n    return Ok(execute(&SystemPort(&*state, false), None, epoch).await);\n    Ok(execute("), STATE_PERMISSIONS.to_owned()),
    ] { assert!(check_status_flight_wiring(&c, &s).is_err()); }
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
