//! Pin every production host-access site to an explicit routing scope.
use super::source_scan::{callers_of, fn_body, production};
use std::path::{Path, PathBuf};

fn sources(dir: &Path, root: &Path, out: &mut Vec<(String, String)>) {
    for entry in std::fs::read_dir(dir).expect("source directory") {
        let path = entry.expect("source entry").path();
        if path.is_dir() {
            sources(&path, root, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            let name = path.file_name().unwrap().to_string_lossy();
            if name.ends_with("_tests.rs") || name.starts_with("test_")
                || matches!(name.as_ref(), "fake_hosts.rs" | "source_scan.rs" | "tests.rs") {
                continue;
            }
            out.push((path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/"),
                production(&std::fs::read_to_string(&path).expect("read source"))));
        }
    }
}

fn census(needle: &str, classified: &[(&str, &str)]) {
    assert!(!classified.is_empty(), "a census must classify at least one site");
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    sources(&root, &root, &mut files);
    let mut actual = Vec::new();
    for (file, text) in files {
        for caller in callers_of(&text, needle) {
            actual.push((file.clone(), caller.expect("host access must be in a function")));
        }
    }
    assert!(!actual.is_empty(), "`{needle}` disappeared: update the classification, never pass vacuously");
    actual.sort();
    let mut expected: Vec<_> = classified.iter().map(|(f, n)| (f.to_string(), n.to_string())).collect();
    expected.sort();
    assert_eq!(actual, expected, "every `{needle}` expression needs a routing classification");
}

/// Lexical inventory of listing call sites; fence efficacy is proven by the
/// behavioural regressions, not by this census.
#[test]
fn listing_side_effect_callers_share_post_await_validation() {
    census(".apply_listing(", &[("state/host_adoption.rs", "apply_validated_listing")]);
    census("host_registry::apply_answered_listing(", &[("state/host_port.rs", "apply_listing")]);
    census("apply_validated_listing(port,", &[
        ("state/host_adoption.rs", "adopt"),
        ("state/host_adoption.rs", "adopt"),
        ("state/host_adoption.rs", "adopt"),
    ]);
    let adoption = production(include_str!("host_adoption.rs"));
    let checked = fn_body(&adoption, "fn apply_validated_listing<");
    assert!(checked.contains("return Err(Failure::Superseded)"));
    assert!(checked.find("listing_is_current(").unwrap() < checked.find(".apply_listing(").unwrap());
    for (source, signature) in [
        (include_str!("host_adoption/reconnect.rs"), "async fn reconnect_primary<"),
        (include_str!("host_adoption/reconnect.rs"), "async fn reconnect_frozen_pass<"),
        (include_str!("host_adoption/sweep.rs"), "async fn sweep<"),
        (include_str!("host_retire.rs"), "async fn sample<"),
        (include_str!("update_full.rs"), "async fn scope_of<"),
    ] {
        assert!(fn_body(&production(source), signature).contains("listing_is_current("), "{signature} must validate its awaited answers");
    }
}

#[test]
fn every_primary_client_access_has_a_scope() {
    census(".pty_host_clone(", &[
        ("state/terminals.rs", "client_for_channel"), // routed: Primary arm only
        ("state/host_port.rs", "current_client"), // primary-only port; callers merge or route
        ("state/host_generation.rs", "serving_hosts"), // merged with frozen snapshot
    ]);
}

#[test]
fn every_host_listing_has_a_scope() {
    census(".list_sessions(", &[
        ("state/host_adoption/reconnect.rs", "list_with_retries"), // routed: listing host
        ("state/host_adoption/sweep.rs", "sweep"), // merged: every connected host
    ]);
    census(".list_sessions_within(", &[
        ("pty_host_client.rs", "list_sessions"), // routed: self, default deadline adapter
        ("state/host_adoption.rs", "settle"), // routed: each independent candidate
        ("state/host_retire.rs", "sample"), // routed: one frozen id + epoch
        ("state/update_full.rs", "scope_of"), // merged: all owned hosts
    ]);
}

#[test]
fn every_channel_key_map_access_has_a_scope() {
    census(".host_sessions_by_key(", &[("state/host_port.rs", "panes_on")]); // routed adapter
    census(".panes_on(", &[
        ("state/host_adoption/panes.rs", "reattach_listed"), // routed, fresh ownership
        ("state/host_adoption/reconnect.rs", "reconnect_primary"), // primary-only
        ("state/host_adoption/reconnect.rs", "reconnect_frozen_pass"), // routed, before
        ("state/host_adoption/reconnect.rs", "reconnect_frozen_pass"), // routed, after
        ("state/host_adoption/sweep.rs", "sweep"), // merged across hosts
        ("state/host_retire.rs", "facts"), // routed to frozen id
        ("state/host_retire.rs", "look"), // routed to frozen id
    ]);
}

#[test]
fn every_frozen_channel_expression_is_classified() {
    census("HostChannel::Frozen(", &[
        ("state/host_adoption.rs", "frozen_connection_lost"),
        ("state/host_adoption.rs", "adopt"),
        ("state/host_adoption.rs", "adopt"),
        ("state/host_adoption/panes.rs", "live_client"),
        ("state/host_adoption/reconnect.rs", "standing"),
        ("state/host_adoption/reconnect.rs", "reconnect_frozen"),
        ("state/host_adoption/reconnect.rs", "reconnect_frozen_pass"),
        ("state/host_adoption/reconnect.rs", "drop_dead_host"),
        ("state/host_adoption/reconnect.rs", "reconnect_disconnected"),
        ("state/host_adoption/sweep.rs", "connected_hosts"),
        ("state/host_generation.rs", "serving"),
        ("state/host_lifecycle.rs", "collect"),
        ("state/host_port.rs", "connect_frozen"),
        ("state/host_port.rs", "forget_host"),
        ("state/host_port.rs", "host_label"),
        ("state/host_retire.rs", "start_ticker"),
        ("state/host_retire.rs", "reachable"),
        ("state/host_retire.rs", "look"),
        ("state/host_routing.rs", "client_of"),
        ("state/host_routing.rs", "spawn_target"),
        ("state/host_routing.rs", "spawn_target"),
        ("state/terminals.rs", "client_for_channel"),
        ("state/terminals.rs", "forget_host_terminal"),
    ]);
}

#[test]
fn restoring_intent_producers_and_consumers_are_classified() {
    census(".register_restoring_leaf(", &[("commands/terminal.rs", "register_restoring_leaves")]);
    census(".forget_restoring_leaf(", &[("commands/terminal.rs", "forget_restoring_leaf")]);
    census(".restoring_keys()", &[
        ("state/host_routing.rs", "place_for_leaf"), // classification and TTL refresh
        ("state/host_routing.rs", "place_for_leaf"),
        ("state/host_routing.rs", "settle"), // successful placement consumes intent
        ("state/host_adoption/panes.rs", "surface_orphans"), // every orphan path skips waiting keys
    ]);
    census(".closed_unowned()", &[
        ("state/host_routing.rs", "settle"), // a wanted create supersedes a close
        ("state/host_adoption/panes.rs", "surface_orphans"), // close rather than surface
    ]);
    census("host_registry::apply_answered_listing(", &[("state/host_port.rs", "apply_listing")]);
}

#[test]
fn host_entry_points_have_generation_traces() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    for (file, signature) in [
        ("pty_host_client/discovery.rs", "fn discover_hosts_in("),
        ("pty_host_client.rs", "fn close_transport("),
        ("state/host_adoption.rs", "async fn adopt<"),
        ("state/host_routing.rs", "async fn place_for_leaf<"),
        ("state/host_adoption/sweep.rs", "async fn sweep<"),
        ("state/host_adoption/reconnect.rs", "async fn reconnect_primary<"),
        ("state/host_adoption/reconnect.rs", "async fn reconnect_frozen<"),
        ("state/host_lifecycle.rs", "async fn close_admission<"),
        ("state/host_lifecycle.rs", "async fn exit_hosts_within<"),
        ("state/host_lifecycle.rs", "async fn arm_hosts("),
        ("state/host_lifecycle.rs", "async fn disarm_hosts("),
        ("state/host_lifecycle.rs", "async fn release_host("),
        ("state/host_retire.rs", "fn start_ticker<"),
        ("state/host_generation.rs", "fn notify_terminal_generations("),
        ("state/update_full.rs", "async fn run_full<"),
        ("state/update_full.rs", "fn availability<"),
        ("commands/terminal.rs", "fn register_restoring_leaves("),
        ("commands/terminal.rs", "fn forget_restoring_leaf("),
    ] {
        let text = production(&std::fs::read_to_string(root.join(file)).unwrap());
        assert!(fn_body(&text, signature).contains("[GEN]"), "{file}: {signature} needs a generation trace");
    }
}
