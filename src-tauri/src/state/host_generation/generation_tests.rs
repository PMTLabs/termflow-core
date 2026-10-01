//! Which terminals are marked as running on an older host. Everything here is
//! decided over generations and channels, so the matrix runs over in-memory
//! connections with no host process behind them.
use super::*;
use crate::elevated_host::FrozenId;
use crate::pty_host_client::{wire_client, PtyHostDeps};
use std::sync::Arc;

const RUNNING: &str = "aaaaaaaaaaaaaaaa";
const OLDER: &str = "bbbbbbbbbbbbbbbb";
const FROZEN_1: HostChannel = HostChannel::Frozen(FrozenId(1));

fn deps() -> PtyHostDeps {
    let (output_tx, _rx) = tokio::sync::broadcast::channel(4);
    PtyHostDeps {
        lifecycle_token: "tok".into(),
        output_tx,
        output_produced: Arc::new(Default::default()),
        on_exit: Arc::new(|_, _, _| {}),
        on_gap: Arc::new(|_| {}),
        resolve_process: Arc::new(|_| None),
        on_disconnect: Arc::new(|| {}),
        stream_offsets: Arc::new(DashMap::new()),
    }
}

/// A client wired to an in-memory host. Its image path is whatever the test says;
/// `installed_as` is a host image in the install directory of that generation.
fn client(image: Option<std::path::PathBuf>, spawned_here: bool) -> PtyHostClient {
    let (client_side, _host_side) = tokio::io::duplex(4096);
    let (rd, wr) = tokio::io::split(client_side);
    let client = wire_client(rd, wr, deps());
    client.inject_exe_image(image);
    client.inject_spawned_here(spawned_here);
    client
}

fn installed_as(generation: &str) -> Option<std::path::PathBuf> {
    let base = crate::pty_host_client::runtime_host_dir().expect("a per-user runtime dir");
    Some(base.join(generation).join("termflow-pty-host"))
}

fn frozen(id: u32, generation: Option<&str>, build_id: Option<&str>, client: PtyHostClient) -> FrozenHost {
    FrozenHost {
        id: FrozenId(id),
        generation: generation.map(str::to_owned),
        endpoint: format!("endpoint-{id}"),
        client,
        epoch: 1,
        build_id: build_id.map(str::to_owned),
        advertised: std::time::SystemTime::UNIX_EPOCH,
        exe_in_payload: None,
    }
}

fn hosts(primary: Option<PtyHostClient>, primary_generation: Option<&str>, frozen: Vec<FrozenHost>) -> ServingHosts {
    ServingHosts { primary, primary_generation: primary_generation.map(str::to_owned), frozen }
}

fn marker(hosts: &ServingHosts, channel: Option<HostChannel>, running: Option<&str>) -> Marker {
    hosts.marker(channel, running)
}

// ---- the comparison ---------------------------------------------------------

#[test]
fn a_generation_is_current_only_when_both_sides_are_known_and_equal() {
    for (host, running, expected) in [
        (Some(RUNNING), Some(RUNNING), Marker::Current),
        (Some(OLDER), Some(RUNNING), Marker::Previous),
        (None, Some(RUNNING), Marker::Previous),
        (Some(RUNNING), None, Marker::Previous),
        // Two unknowns are not equal: nothing shows they are the same generation.
        (None, None, Marker::Previous),
    ] {
        assert_eq!(generation_marker(host, running), expected, "host {host:?} vs running {running:?}");
    }
}

#[test]
fn a_marker_serialises_as_the_word_the_renderer_matches() {
    assert_eq!(serde_json::to_string(&Marker::Current).unwrap(), "\"current\"");
    assert_eq!(serde_json::to_string(&Marker::Previous).unwrap(), "\"previous\"");
    assert_eq!((Marker::Current.as_str(), Marker::Previous.as_str()), ("current", "previous"));
}

// ---- older hosts, by channel ------------------------------------------------

/// The host file is the same, only the ConPTY pair beside it differs: the build id
/// the host reports is identical to the running build's, and the generation is
/// not. The other row has the same generation and a different build id. A
/// comparison of build ids gets both rows wrong.
#[tokio::test]
async fn a_qualified_host_is_compared_by_generation_not_by_build_id() {
    let same_file_other_pair = frozen(1, Some(OLDER), Some("host-file-digest"), client(None, false));
    let same_pair_other_file = frozen(2, Some(RUNNING), Some("some-older-digest"), client(None, false));
    let all = hosts(None, None, vec![same_file_other_pair, same_pair_other_file]);

    assert_eq!(marker(&all, Some(HostChannel::Frozen(FrozenId(1))), Some(RUNNING)), Marker::Previous);
    assert_eq!(
        marker(&all, Some(HostChannel::Frozen(FrozenId(2))), Some(RUNNING)),
        Marker::Current,
        "a qualified host of the running generation, found again after a gate-off relaunch"
    );
}

#[tokio::test]
async fn a_genuinely_older_qualified_host_is_previous() {
    let all = hosts(None, None, vec![frozen(1, Some(OLDER), None, client(installed_as(RUNNING), false))]);
    // Its image sits in the running generation's directory, which a lookup of the
    // image would report; the record's generation is what counts for a qualified host.
    assert_eq!(marker(&all, Some(FROZEN_1), Some(RUNNING)), Marker::Previous);
}

#[tokio::test]
async fn a_legacy_host_is_placed_by_where_its_image_lives() {
    let identical = hosts(None, None, vec![frozen(1, None, None, client(installed_as(RUNNING), false))]);
    assert_eq!(marker(&identical, Some(FROZEN_1), Some(RUNNING)), Marker::Current);

    let older = hosts(None, None, vec![frozen(1, None, None, client(installed_as(OLDER), false))]);
    assert_eq!(marker(&older, Some(FROZEN_1), Some(RUNNING)), Marker::Previous);
}

#[tokio::test]
async fn a_legacy_host_whose_generation_cannot_be_shown_is_previous() {
    let outside = std::path::PathBuf::from("/opt/termflow/termflow-pty-host");
    for image in [None, Some(outside)] {
        let all = hosts(None, None, vec![frozen(1, None, None, client(image.clone(), false))]);
        assert_eq!(marker(&all, Some(FROZEN_1), Some(RUNNING)), Marker::Previous, "image {image:?}");
    }
}

/// A host the running build cannot name a generation for (its install failed and
/// it runs from the bundled path) is only shown to match a host this app started.
#[tokio::test]
async fn nothing_is_shown_equal_to_a_running_build_with_no_generation() {
    let older = hosts(None, None, vec![frozen(1, Some(RUNNING), None, client(installed_as(RUNNING), false))]);
    assert_eq!(marker(&older, Some(FROZEN_1), None), Marker::Previous);

    let none_either = hosts(None, None, vec![frozen(1, None, None, client(None, false))]);
    assert_eq!(marker(&none_either, Some(FROZEN_1), None), Marker::Previous);
}

#[tokio::test]
async fn a_frozen_host_that_has_been_retired_is_previous() {
    let all = hosts(None, None, vec![frozen(1, Some(RUNNING), None, client(None, false))]);
    assert_eq!(marker(&all, Some(HostChannel::Frozen(FrozenId(9))), Some(RUNNING)), Marker::Previous);
}

// ---- the current host -------------------------------------------------------

/// A host this app started from its own binary is the running build's whatever
/// the build can say about its own generation, including a bundled-fallback host
/// that has none.
#[tokio::test]
async fn a_host_started_here_is_current_even_with_no_generation_to_compare() {
    let all = hosts(Some(client(None, true)), None, vec![]);
    assert_eq!(marker(&all, Some(HostChannel::Primary), Some(RUNNING)), Marker::Current);
    assert_eq!(marker(&all, Some(HostChannel::Primary), None), Marker::Current);
}

#[tokio::test]
async fn an_adopted_current_host_on_a_qualified_endpoint_is_compared_by_the_endpoints_generation() {
    let adopted = hosts(Some(client(None, false)), Some(RUNNING), vec![]);
    assert_eq!(marker(&adopted, Some(HostChannel::Primary), Some(RUNNING)), Marker::Current);

    let other = hosts(Some(client(installed_as(RUNNING), false)), Some(OLDER), vec![]);
    assert_eq!(
        marker(&other, Some(HostChannel::Primary), Some(RUNNING)),
        Marker::Previous,
        "the endpoint's generation is not overridden by where an image happens to be"
    );
}

#[tokio::test]
async fn an_adopted_current_host_on_the_legacy_endpoint_is_placed_by_its_image() {
    let identical = hosts(Some(client(installed_as(RUNNING), false)), None, vec![]);
    assert_eq!(marker(&identical, Some(HostChannel::Primary), Some(RUNNING)), Marker::Current);

    let older = hosts(Some(client(installed_as(OLDER), false)), None, vec![]);
    assert_eq!(marker(&older, Some(HostChannel::Primary), Some(RUNNING)), Marker::Previous);

    let unplaced = hosts(Some(client(None, false)), None, vec![]);
    assert_eq!(marker(&unplaced, Some(HostChannel::Primary), Some(RUNNING)), Marker::Previous);

    let disconnected = hosts(None, None, vec![]);
    assert_eq!(marker(&disconnected, Some(HostChannel::Primary), Some(RUNNING)), Marker::Previous);
}

#[test]
fn a_shell_in_this_process_or_on_the_elevated_host_is_current() {
    let none = hosts(None, None, vec![]);
    assert_eq!(marker(&none, None, Some(RUNNING)), Marker::Current);
    assert_eq!(marker(&none, Some(HostChannel::Elevated), Some(RUNNING)), Marker::Current);
    assert_eq!(marker(&none, None, None), Marker::Current);
}

// ---- terminals and tabs -----------------------------------------------------

fn terminal(process_id: &str, leaf: Option<&str>) -> Terminal {
    Terminal {
        id: process_id.to_string(),
        pid: 0,
        shell: "test".to_string(),
        name: "Terminal-test".to_string(),
        created_at: String::new(),
        cols: 80,
        rows: 24,
        backend: crate::tmux_manager::TerminalBackend::PortablePty,
        renderer_terminal_id: leaf.map(str::to_owned),
        owning_tab_id: None,
        session_key: leaf.unwrap_or_default().to_string(),
        last_input_source: None,
        last_input_at: None,
        prompt_hook: false,
        display_label: None,
        title_color: None,
    }
}

fn leaf_markers(
    terminals: &[Terminal],
    host_terminals: &DashMap<String, HostChannel>,
    all: &ServingHosts,
) -> HashMap<String, Marker> {
    markers_by_leaf(terminals, &markers_of(terminals, host_terminals, all, Some(RUNNING)))
}

/// A pane's shell replaced on the current host is a new terminal on a different
/// channel under the same leaf, and the old terminal is gone: the leaf's marker
/// follows the shell that is there now.
#[tokio::test]
async fn replacing_the_shell_clears_the_marker() {
    let all = hosts(Some(client(None, true)), None, vec![frozen(1, Some(OLDER), None, client(None, false))]);
    let host_terminals: DashMap<String, HostChannel> = DashMap::new();
    host_terminals.insert("pc-old".into(), FROZEN_1);

    let before = [terminal("pc-old", Some("tm-pane"))];
    assert_eq!(leaf_markers(&before, &host_terminals, &all).get("tm-pane"), Some(&Marker::Previous));

    host_terminals.remove("pc-old");
    host_terminals.insert("pc-new".into(), HostChannel::Primary);
    let after = [terminal("pc-new", Some("tm-pane"))];
    assert_eq!(leaf_markers(&after, &host_terminals, &all).get("tm-pane"), Some(&Marker::Current));

    // A shell that has ended is no longer registered at all: nothing is marked.
    assert!(leaf_markers(&[], &host_terminals, &all).is_empty());
}

#[tokio::test]
async fn each_terminal_is_marked_by_its_own_hosts_generation() {
    let all = hosts(Some(client(None, true)), None, vec![frozen(1, Some(OLDER), None, client(None, false))]);
    let host_terminals: DashMap<String, HostChannel> = DashMap::new();
    host_terminals.insert("pc-a".into(), HostChannel::Primary);
    host_terminals.insert("pc-b".into(), FROZEN_1);
    host_terminals.insert("pc-c".into(), FROZEN_1);
    let terminals = [
        terminal("pc-a", Some("tm-a")),
        terminal("pc-b", Some("tm-b")),
        terminal("pc-c", Some("tm-c")),
        terminal("pc-local", Some("tm-local")),
        terminal("pc-headless", None),
    ];

    let markers = markers_of(&terminals, &host_terminals, &all, Some(RUNNING));
    assert_eq!(
        markers,
        vec![Marker::Current, Marker::Previous, Marker::Previous, Marker::Current, Marker::Current],
        "in the order of the terminals asked about"
    );
    let by_leaf = markers_by_leaf(&terminals, &markers);
    assert_eq!(by_leaf.len(), 4, "a terminal with no pane has no tab to mark");
    assert_eq!(by_leaf.get("tm-b"), Some(&Marker::Previous));
    assert_eq!(by_leaf.get("tm-local"), Some(&Marker::Current));
}
