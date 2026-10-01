use super::*;
use crate::state::{KeyState, CloseState, StageMode};
use crate::pty_host_client::SessionListing;
use termflow_pty_protocol::SessionMeta;
use crate::pty_host_client::{wire_client, PtyHostDeps};
use std::sync::Arc;
use termflow_pty_protocol::{read_frame, Data, Frame};

const PRIMARY: HostChannel = HostChannel::Primary;
const FROZEN_1: HostChannel = HostChannel::Frozen(FrozenId(1));
const FROZEN_2: HostChannel = HostChannel::Frozen(FrozenId(2));

fn terminal(process_id: &str, session_key: &str) -> Terminal {
    Terminal {
        id: process_id.to_string(),
        pid: 0,
        shell: "test".to_string(),
        name: "Terminal-test".to_string(),
        created_at: String::new(),
        cols: 80,
        rows: 24,
        backend: crate::tmux_manager::TerminalBackend::PortablePty,
        renderer_terminal_id: Some(session_key.to_string()),
        owning_tab_id: None,
        session_key: session_key.to_string(),
        last_input_source: None,
        last_input_at: None,
        prompt_hook: false,
        display_label: None,
        title_color: None,
    }
}

/// In-memory ownership tables: each `(process_id, session_key, channel)` is a
/// registered host terminal.
struct Tables {
    host_terminals: DashMap<String, HostChannel>,
    terminals: DashMap<String, Terminal>,
}

fn tables(entries: &[(&str, &str, HostChannel)]) -> Tables {
    let t = Tables { host_terminals: DashMap::new(), terminals: DashMap::new() };
    for (process_id, key, channel) in entries {
        t.host_terminals.insert(process_id.to_string(), *channel);
        t.terminals.insert(process_id.to_string(), terminal(process_id, key));
    }
    t
}

impl Tables {
    fn registered_anywhere(&self, key: &str) -> bool {
        session_registered_on_any_channel(&self.host_terminals, &self.terminals, key)
    }
}

// ---- session-key maps -------------------------------------------------------

/// The surface-time re-check exists because a registration can land between a
/// listing and the recovery tab becoming visible. When that registration is on
/// a frozen host, a check that only reads the primary's map misses it and
/// surfaces a second owner for a live session.
#[test]
fn surface_time_recheck_sees_frozen_channel_registration() {
    let t = tables(&[("pc-1", "tm-orphan", FROZEN_1)]);

    assert!(
        t.registered_anywhere("tm-orphan"),
        "a registration on a frozen host must suppress the recovery tab"
    );
    assert!(
        !sessions_by_key(&t.host_terminals, &t.terminals, PRIMARY).contains_key("tm-orphan"),
        "the primary's map cannot see it: re-checking against it is the defect this guards"
    );
    assert!(!t.registered_anywhere("tm-someone-else"));
}

/// The wiring half: the function above is useless if orphan surfacing
/// re-checks through the primary-only map.
#[test]
fn surface_orphans_rechecks_through_the_all_channel_check() {
    let source = include_str!("../host_adoption/panes.rs").replace("\r\n", "\n");
    let start = source
        .find("\npub(in crate::state) fn surface_orphans<")
        .expect("surface_orphans moved or was renamed");
    let body = &source[start..];
    let body = &body[..body.find("\n}\n").expect("body end")];
    assert!(body.contains("registered_on_any_channel("));
    assert!(
        !body.contains("panes_on("),
        "the surface-time re-check must not read one channel's map"
    );
}

#[test]
fn primary_key_map_excludes_frozen() {
    let t = tables(&[
        ("pc-p", "tm-primary", PRIMARY),
        ("pc-f1", "tm-frozen-1", FROZEN_1),
        ("pc-f2", "tm-frozen-2", FROZEN_2),
        ("pc-e", "tm-elevated", HostChannel::Elevated),
    ]);

    let primary = sessions_by_key(&t.host_terminals, &t.terminals, PRIMARY);
    assert_eq!(primary.len(), 1, "only the primary's own session: {primary:?}");
    assert_eq!(primary.get("tm-primary").map(String::as_str), Some("pc-p"));

    let f1 = sessions_by_key(&t.host_terminals, &t.terminals, FROZEN_1);
    assert_eq!(f1.keys().collect::<Vec<_>>(), vec!["tm-frozen-1"], "a frozen host sees only its own");
    let f2 = sessions_by_key(&t.host_terminals, &t.terminals, FROZEN_2);
    assert_eq!(f2.keys().collect::<Vec<_>>(), vec!["tm-frozen-2"]);
}

// ---- claims -----------------------------------------------------------------

#[test]
fn claim_keeps_channel() {
    let keys = HostKeys::default();
    keys.listing(FROZEN_2, &answer(1, vec![listed("tm-a", true)]), |_| false);
    keys.listing(PRIMARY, &answer(1, vec![listed("tm-a", true)]), |_| false);
    let (stage, pid) = keys.stage(FROZEN_2, "tm-a", StageMode::Attach).unwrap();
    assert_eq!((pid, stage.channel), (7, FROZEN_2));
    assert_eq!(keys.state(FROZEN_2, "tm-a"), Some(KeyState::Held(stage.cg)));
    assert!(keys.stage(FROZEN_2, "tm-a", StageMode::Attach).unwrap_err().starts_with("host-session-contended:"));
    assert!(keys.eligible(PRIMARY, "tm-a"), "another host's identical key is independent");
    let (fresh, pid) = keys.stage(FROZEN_1, "tm-fresh", StageMode::Spawn).unwrap();
    assert_eq!(pid, 0);
    assert_eq!(keys.state(FROZEN_1, "tm-fresh"), Some(KeyState::Held(fresh.cg)));
}

// ---- pending closes ---------------------------------------------------------

/// Hosts A (primary) and B (a frozen host) each owe a close for their own
/// session. A's empty answer is authoritative for A only.
#[test]
fn pending_close_b_survives_empty_list_from_a() {
    let keys = HostKeys::default();
    keys.close(PRIMARY, "tm-a");
    keys.close(FROZEN_1, "tm-b");
    let pending = Some(KeyState::Ending { close: CloseState::Pending, stamp: None });
    assert_eq!(keys.state(PRIMARY, "tm-a"), pending);
    assert_eq!(keys.state(FROZEN_1, "tm-b"), pending);
    keys.listing(PRIMARY, &answer(1, vec![]), |_| false);
    assert_eq!(keys.state(PRIMARY, "tm-a"), pending, "undelivered effects cannot be released");
    assert_eq!(keys.state(FROZEN_1, "tm-b"), pending);
    keys.listing(PRIMARY, &answer(2, vec![listed("tm-b", true)]), |_| false);
    assert!(keys.eligible(PRIMARY, "tm-b"), "same text on another channel has no outstanding effect");
    assert_eq!(keys.state(FROZEN_1, "tm-b"), pending);
}

#[test]
fn a_non_empty_list_prunes_only_its_own_leftover_tombstones() {
    let keys = HostKeys::default();
    for (channel, key) in [(FROZEN_1, "tm-listed"), (FROZEN_1, "tm-gone"), (PRIMARY, "tm-other-host")] { keys.close(channel, key); }
    keys.listing(FROZEN_1, &answer(1, vec![listed("tm-listed", true)]), |_| false);
    for (channel, key) in [(FROZEN_1, "tm-listed"), (FROZEN_1, "tm-gone"), (PRIMARY, "tm-other-host")] {
        assert_eq!(keys.state(channel, key), Some(KeyState::Ending { close: CloseState::Pending, stamp: None }));
    }
}

// ---- frozen registry --------------------------------------------------------

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

/// A real client wired to an in-memory fake host; the returned reader yields the
/// frames that host receives.
fn fake_host() -> (PtyHostClient, tokio::io::ReadHalf<tokio::io::DuplexStream>) {
    let (client_side, host_side) = tokio::io::duplex(4096);
    let (rd, wr) = tokio::io::split(client_side);
    let (host_rd, _host_wr) = tokio::io::split(host_side);
    (wire_client(rd, wr, deps()), host_rd)
}

fn frozen(id: u32, client: PtyHostClient) -> FrozenHost {
    FrozenHost {
        id: FrozenId(id.into()),
        generation: Some(format!("gen{id}")),
        endpoint: format!("endpoint-{id}"),
        client,
        epoch: 1,
        build_id: None,
        advertised: std::time::SystemTime::UNIX_EPOCH,
        exe_in_payload: None,
    }
}

#[tokio::test]
async fn a_frozen_channel_resolves_to_its_own_hosts_client() {
    let (client_1, mut host_1) = fake_host();
    let (client_2, mut host_2) = fake_host();
    let hosts = Mutex::new(vec![frozen(1, client_1), frozen(2, client_2)]);

    frozen_client(&hosts, FrozenId(2)).expect("registered").write_stdin("tm-x", b"to-2");

    // Host 2 receives the frame, host 1 receives nothing.
    match read_frame(&mut host_2).await.unwrap() {
        Some(Frame::Data(Data::Stdin { tab_id, bytes })) => {
            assert_eq!((tab_id.as_str(), bytes.as_slice()), ("tm-x", b"to-2".as_slice()));
        }
        other => panic!("host 2 expected the stdin frame, got {other:?}"),
    }
    let quiet = tokio::time::timeout(std::time::Duration::from_millis(100), read_frame(&mut host_1)).await;
    assert!(quiet.is_err(), "host 1 must not see a frame addressed to host 2");

    // A retired (absent) id resolves to no client rather than to some other host.
    assert!(frozen_client(&hosts, FrozenId(3)).is_none());
    hosts.lock().unwrap().retain(|h| h.id != FrozenId(2));
    assert!(frozen_client(&hosts, FrozenId(2)).is_none());
}

#[test]
fn frozen_ids_are_never_reused() {
    let seq = AtomicU64::new(0);
    let a = next_frozen_id(&seq).unwrap();
    let b = next_frozen_id(&seq).unwrap();
    assert_eq!(a, FrozenId(0));
    assert_eq!(b, FrozenId(1));
    seq.store(u64::MAX - 1, Ordering::Release);
    assert_eq!(next_frozen_id(&seq).unwrap(), FrozenId(u64::MAX - 1));
    assert!(next_frozen_id(&seq).is_err());
    assert_eq!(seq.load(Ordering::Acquire), u64::MAX);
}

// ---- restore intent and unowned closes --------------------------------------

#[test]
fn restore_intent_skips_a_key_that_is_already_registered() {
    let t = tables(&[("pc-1", "tm-live", FROZEN_1)]);
    let keys = HostKeys::default();
    let maps = IntentMaps { keys: &keys, terminals: &t.terminals };
    let now = Instant::now();

    assert!(!register_restoring_leaf(&maps, "main", "tm-live", None, now));
    assert!(register_restoring_leaf(&maps, "main", "tm-waiting", None, now));
    assert!(keys.is_restoring_key("tm-waiting", now));
    assert!(!keys.is_restoring_key("tm-live", now), "a live key would never be removed again");
}

/// A shell running in this process (the fallback when no host is usable) is a live
/// terminal too: a renderer reload binds it without a create, so nothing would
/// ever remove a restore intent recorded for its key.
#[test]
fn restore_intent_skips_a_key_held_by_an_in_process_terminal() {
    let t = tables(&[("pc-host", "tm-hosted", FROZEN_1)]);
    t.terminals.insert("pc-local".into(), terminal("pc-local", "tm-local"));
    let keys = HostKeys::default();
    let maps = IntentMaps { keys: &keys, terminals: &t.terminals };
    let now = Instant::now();

    assert!(!t.registered_anywhere("tm-local"), "no host owns it");
    assert!(!register_restoring_leaf(&maps, "main", "tm-local", None, now));
    assert!(!register_restoring_leaf(&maps, "main", "tm-hosted", None, now));
    assert_eq!(keys.holder_count(), 0, "nothing would ever remove these");
    assert!(register_restoring_leaf(&maps, "main", "tm-waiting", None, now));
}

#[test]
fn the_leaf_entry_point_skips_an_in_process_terminal_too() {
    let i = Intent::new(&[]);
    i.tables.terminals.insert("pc-local".into(), terminal("pc-local", "tm-local"));
    assert!(!register_restoring_leaf(&i.maps(), "main", "tm-local", None, Instant::now()));
    assert_eq!(i.keys.holder_count(), 0);
}

#[test]
fn a_close_that_cannot_reach_a_host_stays_owed_on_its_exact_channel() {
    let keys = HostKeys::default();
    route_close(&keys, HostChannel::Elevated, "tm-e");
    route_close(&keys, FROZEN_1, "tm-f");
    for (channel, key) in [(HostChannel::Elevated, "tm-e"), (FROZEN_1, "tm-f")] {
        assert_eq!(keys.state(channel, key), Some(KeyState::Ending { close: CloseState::Pending, stamp: None }));
    }
}

#[test]
fn restore_intent_expires_unless_refreshed_and_a_reap_cannot_drop_a_refreshed_one() {
    let i = Intent::new(&[]);
    let t0 = Instant::now();
    for leaf in ["tm-idle", "tm-retried"] { assert!(register_restoring_leaf(&i.maps(), "main", leaf, None, t0)); }
    assert_eq!(i.keys.holder_count(), 2);
    let later = t0 + RESTORE_INTENT_TTL + Duration::from_secs(1);
    i.keys.refresh_restoring_key("tm-retried", later);
    assert!(!i.keys.is_restoring_key("tm-idle", later));
    assert!(i.keys.is_restoring_key("tm-retried", later));
    i.keys.reap_expired_restore_intents(later);
    assert_eq!(i.keys.holder_count(), 1);
    assert!(i.keys.is_restoring_key("tm-retried", later));
    i.keys.refresh_restoring_key("tm-never-registered", later);
    assert!(!i.keys.is_restoring_key("tm-never-registered", later), "a refresh never creates an intent");
    i.keys.settle_restoring_leaf("tm-retried", None);
    assert_eq!(i.keys.holder_count(), 0);
}

/// Whichever host reports the key, the answer is the same: the verdict has no
/// host input, and a report from the primary and from a frozen host both close.
#[test]
fn closed_unowned_key_is_closed_when_any_host_reports_it() {
    let t = tables(&[]);
    let keys = HostKeys::default();
    let maps = IntentMaps { keys: &keys, terminals: &t.terminals };
    let now = Instant::now();
    assert!(register_restoring_leaf(&maps, "main", "tm-closed", None, now));
    forget_restoring_leaf(&maps, "main", "tm-closed", now);
    assert!(!keys.is_restoring_key("tm-closed", now), "the pane is gone: nothing waits for the key any more");

    for reporting_host in [PRIMARY, FROZEN_1, FROZEN_2] {
        assert!(
            keys.unowned_close_due(t.registered_anywhere("tm-closed"), "tm-closed", now),
            "a listing from {reporting_host:?} must close the session"
        );
    }
    assert!(!keys.unowned_close_due(false, "tm-unrelated", now));
    assert_eq!(keys.marker_count(), 1);
    assert!(!keys.unowned_close_due(false, "tm-closed", now + RESTORE_INTENT_TTL + Duration::from_secs(1)));
    keys.settle_restoring_leaf("tm-closed", None);
    assert_eq!(keys.marker_count(), 0);
    assert!(!keys.unowned_close_due(false, "tm-closed", now));
}

/// A saved layout reloaded after the close registers a NEW session under the
/// same key. Closing it because the key is in `closed_unowned` would kill a
/// terminal the user just opened.
#[test]
fn closed_unowned_never_closes_a_registered_session() {
    let keys = HostKeys::default();
    let now = Instant::now();
    keys.forget_restoring_leaf("main", "tm-reused", now);

    for owner in [PRIMARY, FROZEN_1] {
        let t = tables(&[("pc-new", "tm-reused", owner)]);
        assert!(
            !keys.unowned_close_due(t.registered_anywhere("tm-reused"), "tm-reused", now),
            "a session registered on {owner:?} must not be closed"
        );
    }
    let unregistered = tables(&[]);
    assert!(keys.unowned_close_due(unregistered.registered_anywhere("tm-reused"), "tm-reused", now));
}

// ---- single-authority census ------------------------------------------------

/// Restore holders and their markers must share the session authority rather
/// than leave a parallel key-only protection map behind.
///
/// The files scanned are every production source under `src/state` and
/// `src/commands`, found by walking the directories, so a new file that grows a
/// removal is covered without anyone remembering to list it.
#[test]
fn registry_maps_are_only_shrunk_by_their_chokepoints() {
    use crate::state::source_scan::without_test_modules;

    /// Production text only, with a method chain split over lines rejoined so
    /// `map\n    .remove(` is seen as `map.remove(`.
    fn production(source: &str) -> String {
        let normalised = without_test_modules(&source.replace("\r\n", "\n"));
        let mut out = String::new();
        for line in normalised.lines() {
            if line.trim_start().starts_with('.') {
                out.push_str(line.trim_start());
            } else {
                out.push('\n');
                out.push_str(line);
            }
        }
        out.push('\n');
        out
    }
    /// Production sources below `dir` (relative to `src`): test files, which build
    /// their own maps, are not part of the application.
    fn sources_under(dir: &std::path::Path, out: &mut Vec<(String, String)>) {
        let mut entries: Vec<_> = std::fs::read_dir(dir)
            .unwrap_or_else(|e| panic!("cannot read {} ({e})", dir.display()))
            .map(|e| e.unwrap().path())
            .collect();
        entries.sort();
        for path in entries {
            if path.is_dir() {
                sources_under(&path, out);
                continue;
            }
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            let is_test_file = name.ends_with("_tests.rs") || name == "tests.rs" || name == "fake_hosts.rs";
            if name.ends_with(".rs") && !is_test_file {
                let src_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
                let relative = path.strip_prefix(&src_root).unwrap().to_string_lossy().replace('\\', "/");
                out.push((relative, production(&std::fs::read_to_string(&path).unwrap())));
            }
        }
    }

    let src_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut sources = Vec::new();
    for dir in ["state", "commands"] {
        sources_under(&src_root.join(dir), &mut sources);
    }
    // The census must have found the files that matter, or it proves nothing.
    for expected in [
        "state/host_registry.rs",
        "state/terminals.rs",
        "state/host_routing.rs",
        "state/host_adoption.rs",
        "state/host_port.rs",
        "commands/terminal.rs",
    ] {
        assert!(
            sources.iter().any(|(name, _)| name == expected),
            "{expected} was not scanned: the census would be vacuous"
        );
    }
    for obsolete in ["host_close_pending", "host_session_claims"] {
        assert!(sources.iter().all(|(_, text)| !text.contains(obsolete)), "{obsolete} must not remain a parallel key authority");
    }
    let obsolete = ["restoring_keys", "restoring_leaf_keys"];
    let hits = |text: &str| obsolete.iter().filter(|name| text.contains(**name)).count();
    assert_eq!(hits(&production("pub restoring_keys: DashMap<String, Instant>;")), 1, "planted authority must be found");
    assert_eq!(hits(&production("#[cfg(test)]\nmod tests { pub restoring_keys: DashMap<String, Instant>; }")), 0);
    for (name, source) in &sources { assert_eq!(hits(source), 0, "parallel restore authority in {name}"); }
    let keys = &sources.iter().find(|(name, _)| name == "state/host_keys.rs").unwrap().1;
    assert_eq!(keys.matches("restore_holders: HashMap<").count(), 1);
    assert_eq!(keys.matches("closed_unowned: HashMap<").count(), 1);
    for (name, text) in &sources {
        if name != "state/host_keys.rs" && name != "state/host_keys/restore.rs" {
            assert!(!text.contains("restore_holders") && !text.contains("closed_unowned"), "restore facts outside ownership in {name}");
        }
    }
}

// ---- restore intent by pane ---------------------------------------------------

struct Intent {
    keys: HostKeys,
    tables: Tables,
}

impl Intent {
    fn new(entries: &[(&str, &str, HostChannel)]) -> Self {
        Self {
            keys: HostKeys::default(),
            tables: tables(entries),
        }
    }

    fn maps(&self) -> IntentMaps<'_> {
        IntentMaps {
            keys: &self.keys,
            terminals: &self.tables.terminals,
        }
    }
}

/// The renderer names a closed pane by its leaf alone. A migrated pane waited
/// under its old key, so the close has to land on that key: closing the leaf's
/// own name would leave the real session to be surfaced as a recovered tab once
/// the intent expires.
#[test]
fn closing_a_migrated_waiting_pane_marks_the_key_it_waited_under() {
    let i = Intent::new(&[]);
    let now = Instant::now();

    assert!(register_restoring_leaf(&i.maps(), "main", "tm-new", Some("tb-old"), now));
    assert!(i.keys.is_restoring_key("tb-old", now) && i.keys.is_restoring_key("tm-new", now));
    forget_restoring_leaf(&i.maps(), "main", "tm-new", now);
    assert!(i.keys.unowned_close_due(false, "tb-old", now), "the session it waited for is one to close");
    assert!(i.keys.unowned_close_due(false, "tm-new", now), "the marker carries the whole alias set");
    assert_eq!(i.keys.holder_count(), 0);
    assert!(register_restoring_leaf(&i.maps(), "main", "tm-plain", None, now));
    forget_restoring_leaf(&i.maps(), "main", "tm-plain", now);
    assert!(i.keys.unowned_close_due(false, "tm-plain", now));
    assert_eq!(i.keys.holder_count(), 0);
}

/// Restoring a pane again supersedes an earlier close of it: otherwise the host
/// resolving between registration and the pane's create would close the very
/// session the pane is about to take.
#[test]
fn restoring_a_pane_again_supersedes_its_earlier_close() {
    let i = Intent::new(&[]);
    let now = Instant::now();
    forget_restoring_leaf(&i.maps(), "main", "tm-back", now);
    assert!(i.keys.unowned_close_due(false, "tm-back", now));
    assert!(register_restoring_leaf(&i.maps(), "main", "tm-back", None, now));
    assert!(!i.keys.unowned_close_due(false, "tm-back", now));
    assert!(i.keys.is_restoring_key("tm-back", now));

    // A key that is live was never restored, so an earlier close of it stands.
    let live = Intent::new(&[("pc-1", "tm-live", PRIMARY)]);
    forget_restoring_leaf(&live.maps(), "main", "tm-live", now);
    assert!(!register_restoring_leaf(&live.maps(), "main", "tm-live", None, now));
    assert_eq!(live.keys.marker_count(), 1);
}

#[test]
fn registration_settles_only_its_leafs_holder() {
    let i = Intent::new(&[]);
    let now = Instant::now();
    assert!(register_restoring_leaf(&i.maps(), "main", "tm-a", Some("tb-a"), now));
    assert!(register_restoring_leaf(&i.maps(), "main", "tm-b", Some("tb-b"), now));
    assert_eq!(i.keys.holder_count(), 2);
    i.keys.settle_restoring_leaf("tm-a", Some("tb-a"));
    assert_eq!(i.keys.holder_count(), 1);
    assert!(i.keys.holder_stamp("main", "tm-a").is_none());
    assert!(i.keys.holder_stamp("main", "tm-b").is_some());
}

#[test]
fn a_pane_is_known_by_its_override_key_else_its_leaf() {
    assert_eq!(effective_session_key("tm-leaf", None), "tm-leaf");
    assert_eq!(effective_session_key("tm-leaf", Some("tb-old")), "tb-old");
}

#[test]
fn orphan_verdict_separates_restoring_closed_and_stray_sessions() {
    let i = Intent::new(&[]);
    let now = Instant::now();
    assert!(register_restoring_leaf(&i.maps(), "main", "tm-wait", None, now));
    forget_restoring_leaf(&i.maps(), "main", "tm-gone", now);

    assert_eq!(orphan_verdict(&i.keys, "tm-wait", now), OrphanVerdict::Restoring);
    assert_eq!(orphan_verdict(&i.keys, "tm-gone", now), OrphanVerdict::CloseUnowned);
    assert_eq!(orphan_verdict(&i.keys, "tm-stray", now), OrphanVerdict::Surface);
    // An intent nobody refreshed no longer hides a session.
    let later = now + RESTORE_INTENT_TTL + Duration::from_secs(1);
    assert_eq!(orphan_verdict(&i.keys, "tm-wait", later), OrphanVerdict::Surface);
}

#[test]
fn a_duplicate_session_is_announced_once() {
    let flag = AtomicBool::new(false);
    assert!(first_report(&flag));
    assert!(!first_report(&flag));
}

#[test]
fn only_a_listed_key_is_a_restore_candidate() {
    let keys = HostKeys::default();
    assert_eq!(keys.candidate("tm-a", None), None);
    keys.listing(FROZEN_2, &answer(1, vec![listed("tm-a", true)]), |_| false);
    assert_eq!(keys.candidate("tm-a", None), Some((FROZEN_2, "tm-a".into())));
    keys.stage(FROZEN_2, "tm-a", StageMode::Attach).unwrap();
    assert_eq!(keys.candidate("tm-a", None), None);
}

fn answer(request_no: u64, sessions: Vec<SessionMeta>) -> SessionListing { SessionListing { request_no, sessions } }

fn listed(key: &str, alive: bool) -> SessionMeta {
    SessionMeta { tab_id: key.into(), pid: 7, head_offset: 0, tail_offset: 0, alive }
}

#[test]
fn an_answered_listing_removes_absent_keys_and_excludes_dead_keys_from_host_occupancy() {
    let keys = HostKeys::default();
    keys.listing(FROZEN_1, &answer(1, ["live", "absent", "dead"].map(|k| listed(k, true)).to_vec()), |_| false);
    assert_eq!(keys.unfinished_on(FROZEN_1), 3);
    keys.listing(FROZEN_1, &answer(2, vec![listed("live", true), listed("dead", false)]), |_| false);
    assert!(keys.eligible(FROZEN_1, "live"));
    assert_eq!(keys.state(FROZEN_1, "absent"), None);
    assert_eq!(keys.unfinished_on(FROZEN_1), 1, "dead listed sessions do not prevent empty-host retirement");
}

#[test]
fn a_listing_never_drops_a_key_that_is_held_or_bound() {
    let keys = HostKeys::default();
    let (taking, _) = keys.stage(FROZEN_1, "taking", StageMode::Spawn).unwrap();
    let (bound, _) = keys.stage(FROZEN_1, "held", StageMode::Spawn).unwrap();
    assert!(keys.complete(&bound, "pc-held"));
    keys.listing(FROZEN_1, &answer(1, vec![]), |_| false);
    assert_eq!(keys.state(FROZEN_1, "taking"), Some(KeyState::Held(taking.cg)));
    assert_eq!(keys.state(FROZEN_1, "held"), Some(KeyState::Bound("pc-held".into())));
}

#[test]
fn a_hosts_listing_only_settles_the_keys_of_that_host() {
    let keys = HostKeys::default();
    for (channel, key) in [(FROZEN_1, "on-1"), (FROZEN_2, "on-2"), (PRIMARY, "on-primary")] {
        keys.listing(channel, &answer(1, vec![listed(key, true)]), |_| false);
        assert!(keys.eligible(channel, key));
    }
    keys.listing(FROZEN_1, &answer(2, vec![]), |_| false);
    assert_eq!(keys.state(FROZEN_1, "on-1"), None);
    assert!(keys.eligible(FROZEN_2, "on-2"));
    assert!(keys.eligible(PRIMARY, "on-primary"));
}

#[test]
fn unfinished_keys_are_counted_per_host_and_exclude_bound_ones() {
    let keys = HostKeys::default();
    keys.listing(FROZEN_1, &answer(1, vec![listed("reserved", true)]), |_| false);
    keys.listing(FROZEN_2, &answer(1, vec![listed("elsewhere", true)]), |_| false);
    keys.stage(FROZEN_1, "taking", StageMode::Spawn).unwrap();
    let (registered, _) = keys.stage(FROZEN_1, "registered", StageMode::Spawn).unwrap();
    assert!(keys.complete(&registered, "pc-registered"));
    assert_eq!(keys.unfinished_on(FROZEN_1), 2);
    assert_eq!(keys.unfinished_on(FROZEN_2), 1);
    assert_eq!(keys.unfinished_on(PRIMARY), 0);
}
