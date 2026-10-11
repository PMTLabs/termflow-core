//! Source censuses for the MCP hold handover (plan 055): the statements that must be live in
//! production code, proved on masked text by [`super::live_call_census`], each with the planted
//! mutations it has to kill. A negative case edits the real source text, asserts the edit took
//! effect, and requires the census to fail.

use super::live_call_census::{find_calls, require_live_call, require_top_statement, top_statement_starting, Src};

const HOST_PORT: &str = include_str!("host_port.rs");
const CLIENT: &str = include_str!("../pty_host_client.rs");

/// Replace the first occurrence of `from` in `source`, failing the test if it is not there: a
/// mutation that changed nothing would prove nothing.
pub(crate) fn mutate(source: &str, from: &str, to: &str) -> String {
    let source = source.replace("\r\n", "\n");
    assert!(source.contains(from), "the mutation target is gone: {from}");
    source.replacen(from, to, 1)
}

// ---- T1: the capability bit is installed through one canonical statement per connection site ---

const CURRENT_STATEMENT: &str = "client.set_mcp_hold(connection_mcp_hold(origin, flags.mcp_hold, candidate.pid, \
     client.server_pid(), || crate::pty_host_client::read_advertised_record()));";
const FROZEN_STATEMENT: &str = "client.set_mcp_hold(connection_mcp_hold(HostConnectionOrigin::Adopted, flags.mcp_hold, \
     candidate.pid, client.server_pid(), || None));";
const READ_RECORD_BODY: &str =
    "{ record_path().and_then(|p| termflow_pty_protocol::read_record(&p).ok().flatten()) }";

/// [`mutate`] restricted to the function whose text starts with `signature`, for a file where the
/// same statement appears in more than one function.
pub(crate) fn mutate_in(source: &str, signature: &str, from: &str, to: &str) -> String {
    let source = source.replace("\r\n", "\n");
    let src = Src::new(&source);
    let body = src.function(signature);
    let start = src.masked.find(signature).unwrap();
    let region = &source[start..=body.close];
    assert!(region.contains(from), "the mutation target is gone from {signature}: {from}");
    format!("{}{}{}", &source[..start], region.replacen(from, to, 1), &source[body.close + 1..])
}

pub(crate) fn norm(text: &str) -> String {
    text.chars().filter(|c| !c.is_whitespace()).collect()
}

/// Each connection site holds exactly its canonical installer statement, live: at the top level
/// of the function body, before the `Ok(Opened {` return.
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
    if find_calls(&src.masked, "set_mcp_hold(").len() != 2 {
        return Err("host_port.rs must contain exactly the two `.set_mcp_hold(` statements".into());
    }
    Ok(())
}

/// The shared record reader is today's expression, visible to the connection site, and the spawned
/// helper reads the record through it.
fn check_record_reader(client: &str) -> Result<(), String> {
    let src = Src::production(client);
    let reader = src.try_function("pub(crate) fn read_advertised_record(")?;
    let body = src.norm(&(reader.open..reader.close + 1));
    if body != norm(READ_RECORD_BODY) {
        return Err(format!("read_advertised_record's body changed: {body}"));
    }
    let spawned = src.try_function("pub fn spawned_host_advertises(")?;
    // The read must run: one live call, not one inside a closure, branch or after a return.
    let calls: Vec<usize> = find_calls(&src.masked[spawned.open..spawned.close], "read_advertised_record()")
        .into_iter()
        .map(|at| spawned.open + at)
        .collect();
    require_live_call(&spawned, &calls, "spawned_host_advertises' read_advertised_record()")?;
    let cursor = src.try_function("pub fn spawned_host_inherits_cursor(")?;
    let cursor_body = src.norm(&(cursor.open..cursor.close + 1));
    if cursor_body != "{spawned_host_advertises(server_pid,termflow_pty_protocol::CAP_INHERIT_CURSOR)}" {
        return Err(format!("spawned_host_inherits_cursor is no longer a thin wrapper over the resolver: {cursor_body}"));
    }
    Ok(())
}

/// The production sources of the app, minus the test-only files, so a third setter anywhere is seen.
pub(super) fn production_sources() -> Vec<(std::path::PathBuf, String)> {
    fn walk(dir: &std::path::Path, out: &mut Vec<(std::path::PathBuf, String)>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(&path, out);
                continue;
            }
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            let test_only = name.ends_with("_tests.rs")
                || matches!(name.as_str(), "fake_hosts.rs" | "test_dirs.rs" | "live_call_census.rs")
                || !name.ends_with(".rs");
            if !test_only {
                let text = std::fs::read_to_string(&path).unwrap();
                out.push((path, text));
            }
        }
    }
    let mut out = Vec::new();
    walk(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut out);
    out
}

#[test]
fn both_connection_sites_install_the_bit_through_their_canonical_live_statement() {
    check_connection_sites(HOST_PORT).unwrap();
}

#[test]
fn the_record_reader_and_its_callers_are_the_canonical_ones() {
    check_record_reader(CLIENT).unwrap();
}

#[test]
fn no_third_setter_of_the_bit_exists_in_production_code() {
    let mut setters = Vec::new();
    for (path, text) in production_sources() {
        let src = Src::production(&text);
        for _ in find_calls(&src.masked, "set_mcp_hold(") {
            setters.push(path.file_name().unwrap().to_string_lossy().to_string());
        }
    }
    setters.sort();
    assert_eq!(setters, ["host_port.rs", "host_port.rs", "pty_host_client.rs"], "two calls and the definition");
}

#[test]
fn the_connection_site_census_kills_each_planted_mutation() {
    let wrapped = |statement: &str| format!("if false {{ {statement} }}");
    let after_return = |source: &str, statement: &str, tail: &str| {
        let cut = mutate(source, statement, "");
        mutate(&cut, tail, &format!("{tail};
        {statement}"))
    };
    let current_tail = "Ok(Opened { client, epoch: my_gen, build_id: launch.build_id })";
    let frozen_tail = "Ok(Opened { client, epoch, build_id })";
    let cases: Vec<(&str, String)> = vec![
        ("shutdown_control for the bit", mutate(HOST_PORT, "origin, flags.mcp_hold, candidate.pid", "origin, flags.shutdown_control, candidate.pid")),
        ("a fixed Adopted in connect_current", mutate(HOST_PORT, "connection_mcp_hold(origin, flags.mcp_hold", "connection_mcp_hold(HostConnectionOrigin::Adopted, flags.mcp_hold")),
        ("candidate.pid swapped with the server pid", mutate(HOST_PORT, "flags.mcp_hold, candidate.pid, client.server_pid(), || crate", "flags.mcp_hold, client.server_pid(), candidate.pid, || crate")),
        ("a `|| None` reader in connect_current", mutate(HOST_PORT, "|| crate::pty_host_client::read_advertised_record()))", "|| None))")),
        ("a literal true", mutate(HOST_PORT, CURRENT_STATEMENT, "client.set_mcp_hold(true);")),
        ("the statement wrapped in `if false`", mutate(HOST_PORT, CURRENT_STATEMENT, &wrapped(CURRENT_STATEMENT))),
        ("the statement placed after the Ok(Opened) return", after_return(HOST_PORT, CURRENT_STATEMENT, current_tail)),
        ("the frozen statement placed after the Ok(Opened) return", after_return(HOST_PORT, FROZEN_STATEMENT, frozen_tail)),
        ("a SpawnedHere origin at the frozen site", mutate(HOST_PORT, "connection_mcp_hold(HostConnectionOrigin::Adopted", "connection_mcp_hold(HostConnectionOrigin::SpawnedHere")),
        ("a reader at the frozen site", mutate(HOST_PORT, "candidate.pid, client.server_pid(), || None));", "candidate.pid, client.server_pid(), || crate::pty_host_client::read_advertised_record()));")),
        ("the frozen statement wrapped in `if false`", mutate(HOST_PORT, FROZEN_STATEMENT, &wrapped(FROZEN_STATEMENT))),
        ("the bit set from the plan alone at the frozen site", mutate(HOST_PORT, FROZEN_STATEMENT, "client.set_mcp_hold(flags.mcp_hold);")),
        ("the current statement inside a comment", mutate(HOST_PORT, CURRENT_STATEMENT, &format!("/* {CURRENT_STATEMENT} */"))),
        ("the current statement inside a string", mutate(HOST_PORT, CURRENT_STATEMENT, &format!("let _s = \"{}\";", CURRENT_STATEMENT.replace('"', "'")))),
        ("the current statement inside a closure", mutate(HOST_PORT, CURRENT_STATEMENT, &format!("let _f = || {{ {CURRENT_STATEMENT} }};"))),
        ("an early return before the current statement", mutate(HOST_PORT, CURRENT_STATEMENT, &format!("return Err(String::new());\n        {CURRENT_STATEMENT}"))),
        ("an early return before the frozen statement", mutate(HOST_PORT, FROZEN_STATEMENT, &format!("return Err(String::new());\n        {FROZEN_STATEMENT}"))),
    ];
    for (name, source) in cases {
        assert!(check_connection_sites(&source).is_err(), "the census let this mutation through: {name}");
    }
}

#[test]
fn the_record_reader_census_kills_its_mutations() {
    let cases = [
        ("a reader that always finds nothing", mutate(CLIENT, "record_path().and_then(|p| termflow_pty_protocol::read_record(&p).ok().flatten())", "None")),
        ("a reader that is no longer visible to the connection site", mutate(CLIENT, "pub(crate) fn read_advertised_record(", "fn read_advertised_record(")),
        ("a spawned helper that no longer re-reads the record", mutate(CLIENT, "host_advertises_served_by(read_advertised_record().as_ref(), server_pid, bit)", "host_advertises_served_by(None, server_pid, bit)")),
        ("a cursor wrapper that stops sharing the resolver", mutate(CLIENT, "spawned_host_advertises(server_pid, termflow_pty_protocol::CAP_INHERIT_CURSOR)", "true")),
        ("a return before the spawned helper's read", mutate(CLIENT, "    host_advertises_served_by(read_advertised_record().as_ref(), server_pid, bit)", "    return false;\n    host_advertises_served_by(read_advertised_record().as_ref(), server_pid, bit)")),
        ("the read only inside a closure nobody calls", mutate(CLIENT, "    host_advertises_served_by(read_advertised_record().as_ref(), server_pid, bit)", "    let _f = || read_advertised_record();\n    host_advertises_served_by(None, server_pid, bit)")),
        ("the read only in a closure held by an array", mutate(CLIENT, "    host_advertises_served_by(read_advertised_record().as_ref(), server_pid, bit)", "    let _readers = [|| read_advertised_record()];\n    host_advertises_served_by(None, server_pid, bit)")),
        ("the read only in an async closure held by an array", mutate(CLIENT, "    host_advertises_served_by(read_advertised_record().as_ref(), server_pid, bit)", "    let _readers = [async || read_advertised_record()];\n    host_advertises_served_by(None, server_pid, bit)")),
        ("the read only in an array closure held by a struct field",mutate(CLIENT, "    host_advertises_served_by(read_advertised_record().as_ref(), server_pid, bit)", "    struct Reader<F> { read: [F; 1] }\n    let _reader = Reader { read: [|| read_advertised_record()] };\n    host_advertises_served_by(None, server_pid, bit)")),
        ("the read only in a closure held by a struct field",mutate(CLIENT, "    host_advertises_served_by(read_advertised_record().as_ref(), server_pid, bit)", "    struct Reader<F> { read: F }\n    let _reader = Reader { read: || read_advertised_record() };\n    host_advertises_served_by(None, server_pid, bit)")),
    ];
    for (name, source) in cases {
        assert!(check_record_reader(&source).is_err(), "the census let this mutation through: {name}");
    }
}
