//! Which terminals are marked as running on an older host. Everything here is
//! decided over generations and channels, so the matrix runs over in-memory
//! connections with no host process behind them.
use super::*;
use crate::elevated_host::FrozenId;
use crate::pty_host_client::{wire_client, PtyHostDeps};
use std::sync::Arc;

const RUNNING: &str = "aaaaaaaaaaaaaaaa";
const OLDER: &str = "bbbbbbbbbbbbbbbb";
/// A host file's full digest as a record advertises it: its first 16 hex digits are the
/// generation of a host with no ConPTY pair.
const RUNNING_BUILD_ID: &str = "aaaaaaaaaaaaaaaa00000000000000000000000000000000ffffffffffffffff";
const OLDER_BUILD_ID: &str = "bbbbbbbbbbbbbbbb00000000000000000000000000000000ffffffffffffffff";
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

/// A client wired to an in-memory host, as production wires one: nothing about where
/// the host runs from is known except what a connection records. `spawned_here` and
/// the advertised build id are what a connect sets; nothing else is injected.
fn client(spawned_here: bool, advertised_build_id: Option<&str>) -> PtyHostClient {
    let (client_side, _host_side) = tokio::io::duplex(4096);
    let (rd, wr) = tokio::io::split(client_side);
    let client = wire_client(rd, wr, deps());
    client.inject_spawned_here(spawned_here);
    client.set_advertised_build_id(advertised_build_id.map(str::to_owned));
    client
}

/// A client whose host the OS reports as running from `image`. Only Windows can ask
/// the OS, so only Windows rows may use this.
#[cfg(windows)]
fn client_running_from(image: Option<std::path::PathBuf>, advertised_build_id: Option<&str>) -> PtyHostClient {
    let client = client(false, advertised_build_id);
    client.inject_exe_image(image);
    client
}

#[cfg(windows)]
fn installed_as(generation: &str) -> Option<std::path::PathBuf> {
    let base = crate::pty_host_client::runtime_host_dir().expect("a per-user runtime dir");
    Some(base.join(generation).join("termflow-pty-host"))
}

fn frozen(id: u32, generation: Option<&str>, build_id: Option<&str>, client: PtyHostClient) -> FrozenHost {
    FrozenHost {
        id: FrozenId(id.into()),
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

/// Same host file, so the host advertises the running build's own digest, but a
/// different ConPTY pair beside it: the generation differs. The other row has the
/// running generation and a different digest. A comparison of build ids gets the
/// first row wrong, and one that ignores the generation gets the second wrong.
#[tokio::test]
async fn a_qualified_host_is_compared_by_generation_not_by_build_id() {
    let same_file_other_pair = frozen(1, Some(OLDER), Some(RUNNING_BUILD_ID), client(false, Some(RUNNING_BUILD_ID)));
    let same_pair_other_file = frozen(2, Some(RUNNING), Some(OLDER_BUILD_ID), client(false, Some(OLDER_BUILD_ID)));
    let all = hosts(None, None, vec![same_file_other_pair, same_pair_other_file]);

    assert_eq!(marker(&all, Some(HostChannel::Frozen(FrozenId(1))), Some(RUNNING)), Marker::Previous);
    assert_eq!(
        marker(&all, Some(HostChannel::Frozen(FrozenId(2))), Some(RUNNING)),
        Marker::Current,
        "a qualified host of the running generation, found again after a gate-off relaunch"
    );
}

/// What the record says is the generation for a qualified host, whatever its image
/// or advertised digest would suggest.
#[tokio::test]
async fn a_genuinely_older_qualified_host_is_previous() {
    let all = hosts(None, None, vec![frozen(1, Some(OLDER), None, client(false, Some(RUNNING_BUILD_ID)))]);
    assert_eq!(marker(&all, Some(FROZEN_1), Some(RUNNING)), Marker::Previous);
}

/// A legacy host the OS cannot place and that advertised nothing is not shown to be
/// anything.
#[tokio::test]
async fn a_legacy_host_whose_generation_cannot_be_shown_is_previous() {
    let all = hosts(None, None, vec![frozen(1, None, None, client(false, None))]);
    assert_eq!(marker(&all, Some(FROZEN_1), Some(RUNNING)), Marker::Previous);
}

/// A host the running build cannot name a generation for (its install failed and it
/// runs from the bundled path) is only shown to match a host this app started.
#[tokio::test]
async fn nothing_is_shown_equal_to_a_running_build_with_no_generation() {
    let older = hosts(None, None, vec![frozen(1, Some(RUNNING), None, client(false, None))]);
    assert_eq!(marker(&older, Some(FROZEN_1), None), Marker::Previous);

    let none_either = hosts(None, None, vec![frozen(1, None, None, client(false, None))]);
    assert_eq!(marker(&none_either, Some(FROZEN_1), None), Marker::Previous);
}

#[tokio::test]
async fn a_frozen_host_that_has_been_retired_is_previous() {
    let all = hosts(None, None, vec![frozen(1, Some(RUNNING), None, client(false, None))]);
    assert_eq!(marker(&all, Some(HostChannel::Frozen(FrozenId(9))), Some(RUNNING)), Marker::Previous);
}

// Windows places a legacy host by where its image lives: the ConPTY pair is part of the
// generation there, so the advertised build id never decides it.
#[cfg(windows)]
mod placed_by_image {
    use super::*;

    #[tokio::test]
    async fn a_legacy_host_is_placed_by_where_its_image_lives() {
        let identical = hosts(None, None, vec![frozen(1, None, None, client_running_from(installed_as(RUNNING), None))]);
        assert_eq!(marker(&identical, Some(FROZEN_1), Some(RUNNING)), Marker::Current);

        let older = hosts(None, None, vec![frozen(1, None, None, client_running_from(installed_as(OLDER), None))]);
        assert_eq!(marker(&older, Some(FROZEN_1), Some(RUNNING)), Marker::Previous);

        let outside = std::path::PathBuf::from("/opt/termflow/termflow-pty-host");
        let bundled = hosts(None, None, vec![frozen(1, None, None, client_running_from(Some(outside), None))]);
        assert_eq!(marker(&bundled, Some(FROZEN_1), Some(RUNNING)), Marker::Previous);
    }

    /// The same host file under another ConPTY pair advertises the running build's digest
    /// and runs from another generation's directory; with no image to read it is not shown
    /// to be anything. A build-id comparison would call both of these current.
    #[tokio::test]
    async fn the_build_id_does_not_decide_a_legacy_host_on_windows() {
        let other_pair = hosts(
            None,
            None,
            vec![frozen(1, None, None, client_running_from(installed_as(OLDER), Some(RUNNING_BUILD_ID)))],
        );
        assert_eq!(marker(&other_pair, Some(FROZEN_1), Some(RUNNING)), Marker::Previous);

        let unplaced = hosts(None, None, vec![frozen(1, None, None, client_running_from(None, Some(RUNNING_BUILD_ID)))]);
        assert_eq!(marker(&unplaced, Some(FROZEN_1), Some(RUNNING)), Marker::Previous);
        let unplaced_primary = hosts(Some(client_running_from(None, Some(RUNNING_BUILD_ID))), None, vec![]);
        assert_eq!(marker(&unplaced_primary, Some(HostChannel::Primary), Some(RUNNING)), Marker::Previous);
    }

    #[tokio::test]
    async fn an_adopted_current_host_on_the_legacy_endpoint_is_placed_by_its_image() {
        let identical = hosts(Some(client_running_from(installed_as(RUNNING), None)), None, vec![]);
        assert_eq!(marker(&identical, Some(HostChannel::Primary), Some(RUNNING)), Marker::Current);

        let older = hosts(Some(client_running_from(installed_as(OLDER), None)), None, vec![]);
        assert_eq!(marker(&older, Some(HostChannel::Primary), Some(RUNNING)), Marker::Previous);
    }

    #[tokio::test]
    async fn the_endpoints_generation_is_not_overridden_by_where_an_image_happens_to_be() {
        let other = hosts(Some(client_running_from(installed_as(RUNNING), None)), Some(OLDER), vec![]);
        assert_eq!(marker(&other, Some(HostChannel::Primary), Some(RUNNING)), Marker::Previous);
    }
}

// Elsewhere there is no ConPTY pair, so a host's generation is the first 16 hex digits of
// the digest its record advertises. Production has no image to read off Windows, so none
// is injected here.
#[cfg(not(windows))]
mod placed_by_build_id {
    use super::*;

    #[tokio::test]
    async fn an_adopted_legacy_host_of_the_running_build_is_current() {
        let adopted = hosts(Some(client(false, Some(RUNNING_BUILD_ID))), None, vec![]);
        assert_eq!(marker(&adopted, Some(HostChannel::Primary), Some(RUNNING)), Marker::Current);

        let frozen_legacy = hosts(None, None, vec![frozen(1, None, Some(RUNNING_BUILD_ID), client(false, Some(RUNNING_BUILD_ID)))]);
        assert_eq!(marker(&frozen_legacy, Some(FROZEN_1), Some(RUNNING)), Marker::Current);
    }

    #[tokio::test]
    async fn an_adopted_legacy_host_of_an_older_build_is_previous() {
        let adopted = hosts(Some(client(false, Some(OLDER_BUILD_ID))), None, vec![]);
        assert_eq!(marker(&adopted, Some(HostChannel::Primary), Some(RUNNING)), Marker::Previous);

        let frozen_legacy = hosts(None, None, vec![frozen(1, None, Some(OLDER_BUILD_ID), client(false, Some(OLDER_BUILD_ID)))]);
        assert_eq!(marker(&frozen_legacy, Some(FROZEN_1), Some(RUNNING)), Marker::Previous);
    }

    #[tokio::test]
    async fn an_adopted_legacy_host_that_advertised_nothing_usable_is_previous() {
        for advertised in [None, Some("short"), Some("not-hex-not-hex-not-hex-not-hex-not-hex")] {
            let adopted = hosts(Some(client(false, advertised)), None, vec![]);
            assert_eq!(marker(&adopted, Some(HostChannel::Primary), Some(RUNNING)), Marker::Previous, "{advertised:?}");
            let frozen_legacy = hosts(None, None, vec![frozen(1, None, None, client(false, advertised))]);
            assert_eq!(marker(&frozen_legacy, Some(FROZEN_1), Some(RUNNING)), Marker::Previous, "{advertised:?}");
        }
    }

    /// A running build with no generation of its own cannot be matched by a digest.
    #[tokio::test]
    async fn a_digest_does_not_match_a_running_build_with_no_generation() {
        let adopted = hosts(Some(client(false, Some(RUNNING_BUILD_ID))), None, vec![]);
        assert_eq!(marker(&adopted, Some(HostChannel::Primary), None), Marker::Previous);
    }
}

// ---- the current host -------------------------------------------------------

/// A host this app started from its own binary is the running build's whatever
/// the build can say about its own generation, including a bundled-fallback host
/// that has none.
#[tokio::test]
async fn a_host_started_here_is_current_even_with_no_generation_to_compare() {
    let all = hosts(Some(client(true, None)), None, vec![]);
    assert_eq!(marker(&all, Some(HostChannel::Primary), Some(RUNNING)), Marker::Current);
    assert_eq!(marker(&all, Some(HostChannel::Primary), None), Marker::Current);
}

#[tokio::test]
async fn an_adopted_current_host_on_a_qualified_endpoint_is_compared_by_the_endpoints_generation() {
    let adopted = hosts(Some(client(false, None)), Some(RUNNING), vec![]);
    assert_eq!(marker(&adopted, Some(HostChannel::Primary), Some(RUNNING)), Marker::Current);

    let other = hosts(Some(client(false, Some(RUNNING_BUILD_ID))), Some(OLDER), vec![]);
    assert_eq!(marker(&other, Some(HostChannel::Primary), Some(RUNNING)), Marker::Previous);
}

#[tokio::test]
async fn a_current_host_that_is_not_connected_and_names_no_generation_is_previous() {
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

// ---- how the hosts are assembled in production --------------------------------

const LEGACY_ENDPOINT: &str = r"\\.\pipe\termflow-pty-host.u.rel";

fn qualified_endpoint(generation: &str) -> String {
    format!("{LEGACY_ENDPOINT}.{generation}")
}

fn assembled(primary: Option<PtyHostClient>, primary_endpoint: Option<&str>) -> ServingHosts {
    ServingHosts::assemble(
        primary,
        primary_endpoint,
        |endpoint| crate::pty_host_client::generation_of_endpoint_in(endpoint, LEGACY_ENDPOINT),
        vec![],
    )
}

/// With the naming gate off the current host lives on the legacy endpoint, which names
/// no generation: an older host adopted there must not be taken for the running
/// build's just because it is the current host. With the gate on, the endpoint is named
/// after the generation and decides.
#[tokio::test]
async fn the_current_hosts_generation_comes_from_its_endpoint_not_from_the_running_build() {
    let legacy = assembled(Some(client(false, None)), Some(LEGACY_ENDPOINT));
    assert_eq!(legacy.primary_generation, None);
    assert_eq!(marker(&legacy, Some(HostChannel::Primary), Some(RUNNING)), Marker::Previous);

    let running = assembled(Some(client(false, None)), Some(&qualified_endpoint(RUNNING)));
    assert_eq!(marker(&running, Some(HostChannel::Primary), Some(RUNNING)), Marker::Current);

    let older = assembled(Some(client(false, None)), Some(&qualified_endpoint(OLDER)));
    assert_eq!(marker(&older, Some(HostChannel::Primary), Some(RUNNING)), Marker::Previous);

    // No terminal is on the current host, so there is nothing to name.
    assert_eq!(assembled(None, None).primary_generation, None);
}

/// The running build's generation is read in one place and handed to every caller: a
/// caller that passed nothing would mark everything not started here.
#[test]
fn every_marker_is_computed_against_the_running_generation() {
    let source = include_str!("../host_generation.rs").replace("\r\n", "\n");
    let production = &source[..source.find("#[cfg(test)]").expect("test module")];
    let body = |signature: &str| {
        let start = production.find(signature).unwrap_or_else(|| panic!("{signature}"));
        let rest = &production[start..];
        rest[..rest.find("\n    }\n").expect("end of method")].to_string()
    };
    assert!(body("fn markers_for(").contains("running_generation().as_deref()"));
    for caller in ["pub fn terminals_with_markers(", "pub fn terminal_marker("] {
        assert!(body(caller).contains("self.markers_for("), "{caller}");
    }
    assert_eq!(production.matches("markers_of(").count(), 2, "its definition and markers_for, nothing else");
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
    let all = hosts(Some(client(true, None)), None, vec![frozen(1, Some(OLDER), None, client(false, None))]);
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
    let all = hosts(Some(client(true, None)), None, vec![frozen(1, Some(OLDER), None, client(false, None))]);
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
