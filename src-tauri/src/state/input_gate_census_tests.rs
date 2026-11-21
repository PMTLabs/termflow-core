//! Source-derived stdin inventory, complementing the behavioral admission/real FIFO tests.
//! Unknown functions/files, new raw calls in known functions, and removed routing edges fail.
use super::sink_inventory_tests::production;
use super::source_scan::fn_spans;
use regex::Regex;
use std::{collections::BTreeMap, path::Path};

// Raw primitives include writer handles and map accesses, not only public route names. Non-PTY
// writes must be classified too, so a new production file cannot hide behind a filename filter.
const RAW: &str = r"\.\s*(?:write|write_all|write_vectored|write_fmt|write_stdin|host_write|host_write_admitted|write_registered|write_registered_admitted|enqueue_stdin|enqueue_hosted|local_writer)\s*\(|\.\s*(?:shell_writer_channels|writer)\b|\bData::Stdin\b|\bWrite::(?:write|write_all|write_vectored|write_fmt)\s*\(";
// file, function, maximum raw occurrences per body, authority/scope and behavioral gate.
const RAW_SINKS: &[(&str, &str, usize, &str)] = &[
    (
        "core/pty_manager/input_gate.rs",
        "write_input",
        4,
        "admit_input",
    ),
    (
        "core/pty_manager/input_gate.rs",
        "local_writer",
        1,
        "shell_writer_channels",
    ),
    (
        "core/pty_manager/input_gate.rs",
        "enqueue_hosted",
        1,
        "permit",
    ),
    (
        "core/commands/terminal.rs",
        "write_terminal",
        0,
        "write_input",
    ),
    (
        "core/api_server/exec.rs",
        "send_prompt_to_terminal",
        1,
        "input_lease",
    ),
    (
        "core/pty_manager/spawn.rs",
        "spawn_terminal",
        1,
        "publish_shell_projection",
    ),
    (
        "core/pty_host_client.rs",
        "write_registered",
        1,
        "admit_input",
    ),
    (
        "core/pty_host_client.rs",
        "write_registered_admitted",
        1,
        "with_registered_on",
    ),
    ("core/pty_host_client.rs", "enqueue_stdin", 1, "Data::Stdin"),
    (
        "core/state/host_registry.rs",
        "route_write",
        1,
        "write_registered",
    ),
    (
        "core/state/host_registry.rs",
        "route_write_admitted",
        1,
        "permit",
    ),
    (
        "core/state/terminals.rs",
        "cleanup_terminal_maps",
        1,
        "NON_PTY: exact-process writer removal, not input",
    ),
    (
        "core/state/types.rs",
        "clone",
        1,
        "NON_PTY: Arc cloning, not input",
    ),
    (
        "core/pty_manager/ssh_helpers/windows.rs",
        "publish_file",
        1,
        "NON_PTY: private helper file publication; ssh_helpers filesystem tests",
    ),
    (
        "core/pty_manager/ssh_helpers/unix.rs",
        "publish_file",
        1,
        "NON_PTY: private helper file publication; ssh_helpers filesystem tests",
    ),
    (
        "core/ssh/store.rs",
        "transact",
        1,
        "NON_PTY: saved SSH definition writer; ssh::store tests",
    ),
    (
        "core/ssh/store.rs",
        "transact_checked",
        1,
        "NON_PTY: saved SSH definition writer for a launch-checked edit; ssh::store tests",
    ),
    (
        "core/ssh/known_hosts.rs",
        "trust_transaction",
        1,
        "NON_PTY: locked known_hosts append; known_hosts trust tests",
    ),
    (
        "core/pty_manager/ssh_shell/argv_recorder.rs",
        "main",
        1,
        "NON_PTY: standalone fixture executable compiled by real-shell tests, not linked into the app",
    ),
    // The saved-launch typing turn: hosted enqueue, local writer lookup and its write,
    // all inside the fenced SSH admission (ticket + ready epoch + mounted owner).
    (
        "core/ssh/launch/drive.rs",
        "tick",
        3,
        "submit_ssh_input_fenced",
    ),
    (
        "core/net_ports.rs",
        "write_restricted",
        1,
        "NON_PTY: instance discovery file",
    ),
    (
        "core/output_pipeline.rs",
        "spawn_output_consumer",
        1,
        "NON_PTY: debug output file",
    ),
    ("core/automation/send.rs", "write_leased", 1, "self.write"),
    ("core/automation_engine/host.rs", "write", 1, "self.0.write"),
    (
        "core/automation_engine/host.rs",
        "write_leased",
        1,
        "self.write",
    ),
    (
        "core/state/history.rs",
        "persist_registered_history",
        1,
        "NON_PTY: ownership-qualified historical scrollback persistence",
    ),
    (
        "core/lib.rs",
        "shutdown_mcp_handle",
        2,
        "NON_PTY: MCP sidecar shutdown stdin, not a terminal",
    ),
    (
        "core/pty_host_client.rs",
        "write_token_owner_only",
        1,
        "NON_PTY: owner-only instance token file",
    ),
    ("host/transport/mod.rs", "run_connection", 2, "handle_stdin"),
    ("host/manager.rs", "handle_stdin", 1, "write_stdin"),
    ("host/session.rs", "write_stdin", 1, "write_reply"),
    ("host/session.rs", "run_reader", 1, "StartupReplies::new"),
    (
        "host/mcp_hold/http.rs",
        "write_deadline",
        1,
        "NON_PTY: MCP HTTP socket",
    ),
    ("protocol/da1.rs", "write_reply", 1, "writer.lock"),
    ("protocol/da1.rs", "send_with", 1, "pending"),
    (
        "protocol/bootstrap.rs",
        "write_hello",
        2,
        "NON_PTY: bootstrap framing socket",
    ),
    (
        "protocol/frame.rs",
        "write_frame",
        1,
        "NON_PTY: frame serialization; stdin admission occurs before FIFO acceptance",
    ),
    (
        "protocol/rendezvous.rs",
        "write_rendezvous_request",
        2,
        "NON_PTY: elevated rendezvous framing",
    ),
    (
        "protocol/rendezvous.rs",
        "write_rendezvous_response",
        2,
        "NON_PTY: elevated rendezvous framing",
    ),
];

fn violations(file: &str, source: &str) -> Vec<String> {
    let code = production(source);
    let raw = Regex::new(RAW).unwrap();
    let option_flag = Regex::new(r"^(?:true|false)\s*\)").unwrap();
    fn_spans(&code)
        .into_iter()
        .filter_map(|(name, body)| {
            let body_code = &code[body.clone()];
            let hits = raw
                .find_iter(body_code)
                .filter(|hit| {
                    if !hit.as_str().trim_end().ends_with('(') {
                        return true;
                    }
                    let args = body_code[hit.end()..].trim_start();
                    // RwLock::write() and OpenOptions::write(bool) are not Write byte sinks.
                    !args.starts_with(')') && !option_flag.is_match(args)
                })
                .count();
            if hits == 0 {
                return None;
            }
            let row = RAW_SINKS
                .iter()
                .find(|(path, function, _, _)| *path == file && *function == name);
            match row {
                Some((_, _, max, scope))
                    if hits <= *max
                        && (scope.starts_with("NON_PTY:") || code[body].contains(scope)) =>
                {
                    None
                }
                _ => Some(format!(
                    "{file}:{name}: {hits} raw occurrences without classified gate routing"
                )),
            }
        })
        .collect()
}
fn sources(root: &Path, directory: &Path, prefix: &str, out: &mut BTreeMap<String, String>) {
    for entry in std::fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            if !path
                .file_name()
                .is_some_and(|n| n == "hold_tests" || n == "tests")
            {
                sources(root, &path, prefix, out);
            }
            continue;
        }
        let name = path.file_name().unwrap().to_string_lossy();
        if path.extension().is_none_or(|e| e != "rs")
            || name.ends_with("_tests.rs")
            || matches!(name.as_ref(), "tests.rs" | "fake_hosts.rs" | "test_host.rs")
        {
            continue;
        }
        let key = format!(
            "{prefix}/{}",
            path.strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/")
        );
        out.insert(key, std::fs::read_to_string(path).unwrap());
    }
}

// Lexical census: mutable access to the owners map counts as a sink even
// before a field assignment. Follow Self:: calls through locked helpers so
// moving the write to an inner: &mut Inner function cannot hide the entry point.
fn owner_mutation_violations(corpus: &BTreeMap<String, String>) -> Vec<String> {
    let sink = Regex::new(
        r"\.\s*owners\s*\.\s*(?:insert|remove(?:_entry)?|retain|clear|entry|get_mut|values_mut|iter_mut|drain|extract_if|append)\s*\(|&\s*mut\s+\w+\s*\.\s*owners\b|\.\s*(?:cg|owner|state|ssh_reserved)\s*=[^=]",
    ).unwrap();
    let helper_call = Regex::new(r"\b(?:Self\s*::|self\s*\.)\s*(\w+)\s*\(").unwrap();
    let receiver = Regex::new(r"\(\s*&\s*(?:mut\s+)?self\b").unwrap();
    // `inner: &mut Inner` means the caller already holds the HostKeys lock, so such a
    // method is a locked helper like an associated fn: its callers are checked instead.
    let locked = Regex::new(r":\s*&\s*mut\s+Inner\b").unwrap();
    let barrier = Regex::new(r"\blet\s+\w+\s*=\s*self\.input_owner_change\(\)\s*;").unwrap();
    let lock = Regex::new(r"\bself\.lock\(\)").unwrap();
    let mut methods = Vec::new();
    for (file, source) in corpus {
        let code = production(source);
        for (name, body) in fn_spans(&code) {
            let header = &code[..body.start];
            let declaration = format!("fn {name}");
            let at = header.rfind(declaration.as_str()).unwrap();
            let signature = &header[at..];
            let entry_point = receiver.is_match(signature) && !locked.is_match(signature);
            methods.push((file, name, entry_point, code[body].to_owned()));
        }
    }
    let mut helpers = std::collections::BTreeSet::new();
    loop {
        let count = helpers.len();
        for (_, name, takes_self, body) in &methods {
            if !takes_self && (sink.is_match(body) || helper_call.captures_iter(body)
                .any(|call| helpers.contains(&call[1]))) {
                helpers.insert(name.as_str());
            }
        }
        if count == helpers.len() {
            break;
        }
    }
    let mut errors = Vec::new();
    for (file, name, takes_self, body) in &methods {
        if !takes_self {
            continue;
        }
        let writes = sink.find_iter(body).map(|hit| hit.start()).chain(
            helper_call.captures_iter(body).filter(|call| helpers.contains(&call[1]))
                .map(|call| call.get(0).unwrap().start()),
        );
        for at in writes {
            let prior = &body[..at];
            let ordered = barrier.find_iter(prior).last()
                .is_some_and(|guard| lock.is_match(&prior[guard.end()..]));
            if !ordered {
                errors.push(format!("{file}:{name}: owner mutation without input barrier before HostKeys lock"));
                break;
            }
        }
    }
    errors
}

#[test]
fn owner_mutations_take_the_input_barrier_census() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/state/host_keys");
    let mut corpus = BTreeMap::new();
    sources(&root, &root, "host_keys", &mut corpus);
    assert!(corpus.contains_key("host_keys/panes.rs"));
    let errors = owner_mutation_violations(&corpus);
    assert!(errors.is_empty(), "{}", errors.join("\n"));

    let panes = corpus.get_mut("host_keys/panes.rs").unwrap();
    panes.push_str("\nimpl HostKeys {\n\
        fn planted(&self, leaf: &str) {\n\
            let mut inner = self.lock();\n\
            let _too_late = self.input_owner_change();\n\
            inner.owners.get_mut(leaf).unwrap().cg = 42;\n\
        }\n\
    }\n");
    assert_eq!(owner_mutation_violations(&corpus), vec![
        "host_keys/panes.rs:planted: owner mutation without input barrier before HostKeys lock"
    ]);

    // A `&self` helper that receives the locked `&mut Inner` is checked at its
    // callers: a caller with no barrier is reported, the helper itself is not.
    let panes = corpus.get_mut("host_keys/panes.rs").unwrap();
    panes.push_str("\nimpl HostKeys {\n\
        fn planted_locked(&self, inner: &mut Inner, leaf: &str) {\n\
            inner.owners.remove(leaf);\n\
        }\n\
        fn planted_caller(&self, leaf: &str) {\n\
            let mut inner = self.lock();\n\
            self.planted_locked(&mut inner, leaf);\n\
        }\n\
    }\n");
    assert_eq!(owner_mutation_violations(&corpus), vec![
        "host_keys/panes.rs:planted: owner mutation without input barrier before HostKeys lock",
        "host_keys/panes.rs:planted_caller: owner mutation without input barrier before HostKeys lock",
    ]);
}

#[test]
fn input_gate_sink_census_rejects_new_production_writers() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut corpus = BTreeMap::new();
    for (folder, prefix) in [
        ("src", "core"),
        ("pty-host/src", "host"),
        ("pty-protocol/src", "protocol"),
    ] {
        let tree = root.join(folder);
        sources(&tree, &tree, prefix, &mut corpus);
    }
    assert!(corpus.len() > 150, "wrong census root");
    let mut errors = Vec::new();
    for (file, source) in &corpus {
        errors.extend(violations(file, source));
    }
    assert!(errors.is_empty(), "{}", errors.join("\n"));
    // Calibration: new files/functions and extra sinks in an existing function must fail,
    // whether a writer is called via an alias, a route, a direct handle or a new wire frame.
    for body in [
        "writer.write(bytes);",
        "writer.write_all(bytes);",
        "writer.write_vectored(slices);",
        "writer.write_fmt(args);",
        "state.host_write(pc, bytes);",
        "client.write_stdin(session_key, bytes);",
        "queue.send(Frame::Data(Data::Stdin { tab_id: key, bytes }));",
        "let raw = state.shell_writer_channels.get(pc); raw.lock().write_all(bytes);",
    ] {
        assert!(!violations(
            "core/new_input.rs",
            &format!("fn newly_added() {{ {body} }}")
        )
        .is_empty());
    }
    assert!(!violations("core/pty_manager/input_gate.rs", "fn write_input() { backend.local_writer(pc); writer.write_all(a); writer.write_all(b); writer.write_all(c); writer.write_all(d); }").is_empty());
    // Actual high-level routing edges are checked in production text (comments/literals masked).
    for (file, function, required) in [
        ("core/commands/terminal.rs", "write_terminal", "write_input"),
        (
            "core/api_server/terminals/mod.rs",
            "write_data_to_terminal",
            "write_input",
        ),
        ("core/api_server/ws.rs", "handle_socket", "write_input"),
        ("core/automation/send.rs", "write_leased", "write_input"),
        (
            "core/api_server/exec.rs",
            "send_prompt_to_terminal",
            "write_leased",
        ),
        (
            "core/automation_engine/host.rs",
            "input_lease",
            "self.0.input_lease",
        ),
        (
            "core/automation_engine/host.rs",
            "write_leased",
            "self.0.write_leased",
        ),
        (
            "core/state/engine_host.rs",
            "input_lease",
            "TerminalWriter>::input_lease",
        ),
        (
            "core/state/engine_host.rs",
            "write_leased",
            "TerminalWriter>::write_leased",
        ),
        (
            "core/api_server/fleet.rs",
            "fleet_local_run",
            "send_prompt_to_terminal",
        ),
        ("host/transport/mod.rs", "run_connection", "handle_stdin"),
        ("host/session.rs", "write_stdin", "write_reply"),
    ] {
        let code = production(corpus.get(file).unwrap());
        assert!(
            fn_spans(&code)
                .into_iter()
                .any(|(name, body)| name == function && code[body].contains(required)),
            "missing gated route {file}:{function} -> {required}"
        );
    }
    // A dormant tmux path must not silently gain a new production caller.
    for (file, source) in &corpus {
        let code = production(source);
        for (name, body) in fn_spans(&code) {
            assert!(
                !code[body].contains("send_input("),
                "new tmux activation requires admission: {file}:{name}"
            );
        }
    }
}
