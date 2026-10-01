use super::*;
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
    let claims: DashMap<String, HostSessionClaim> = DashMap::new();

    reserve_session(&claims, "tm-a", 4242, FROZEN_2);
    // A second reservation for the same key (another host reporting it) must not
    // move the claim to that host.
    reserve_session(&claims, "tm-a", 9999, PRIMARY);

    assert_eq!(
        claim_registration(&claims, "tm-a", PRIMARY),
        Ok(Some((4242, FROZEN_2))),
        "the claim must hand back the host that listed the session, not the create's own target"
    );
    assert_eq!(claims.get("tm-a").unwrap().state, HostSessionClaimState::RegistrationInProgress);
    assert!(
        claim_registration(&claims, "tm-a", PRIMARY).unwrap_err().starts_with(HOST_SESSION_CONTENDED),
        "a consumed reservation is claimed by another recovery"
    );

    // A vacant key is a fresh spawn: no pid to restore, and the claim remembers
    // where the spawn is headed.
    assert_eq!(claim_registration(&claims, "tm-fresh", FROZEN_1), Ok(None));
    assert_eq!(claims.get("tm-fresh").unwrap().channel, FROZEN_1);
}

// ---- pending closes ---------------------------------------------------------

/// Hosts A (primary) and B (a frozen host) each owe a close for their own
/// session. A's empty answer is authoritative for A only.
#[test]
fn pending_close_b_survives_empty_list_from_a() {
    let pending: DashMap<String, HostChannel> = DashMap::new();
    pending.insert("tm-a".into(), PRIMARY);
    pending.insert("tm-b".into(), FROZEN_1);

    // A reconnects and lists nothing.
    prune_pending_closes(&pending, PRIMARY);
    assert!(!pending.contains_key("tm-a"), "A's own tombstone is moot after A's empty answer");
    assert_eq!(
        pending.get("tm-b").map(|c| *c),
        Some(FROZEN_1),
        "B's tombstone must survive an answer that was never B's"
    );

    // A host that reports B's key without owing it the close must not consume it.
    assert!(!take_pending_close(&pending, "tm-b", PRIMARY));
    assert!(pending.contains_key("tm-b"));

    // B reconnects and lists the session: the close is delivered, once.
    assert!(take_pending_close(&pending, "tm-b", FROZEN_1));
    assert!(!take_pending_close(&pending, "tm-b", FROZEN_1));
}

#[test]
fn a_non_empty_list_prunes_only_its_own_leftover_tombstones() {
    let pending: DashMap<String, HostChannel> = DashMap::new();
    pending.insert("tm-listed".into(), FROZEN_1);
    pending.insert("tm-gone".into(), FROZEN_1);
    pending.insert("tm-other-host".into(), PRIMARY);

    // The listing names tm-listed: delivered. tm-gone is absent from the same
    // answer: moot. The other host's tombstone is not this answer's to settle.
    assert!(take_pending_close(&pending, "tm-listed", FROZEN_1));
    prune_pending_closes(&pending, FROZEN_1);

    assert!(!pending.contains_key("tm-gone"));
    assert!(pending.contains_key("tm-other-host"));
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
        id: FrozenId(id),
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
    let seq = AtomicU32::new(0);
    let a = next_frozen_id(&seq);
    let b = next_frozen_id(&seq);
    assert_ne!(a, b);
}

// ---- restore intent and unowned closes --------------------------------------

#[test]
fn restore_intent_skips_a_key_that_is_already_registered() {
    let t = tables(&[("pc-1", "tm-live", FROZEN_1)]);
    let restoring: DashMap<String, Instant> = DashMap::new();
    let now = Instant::now();

    assert!(!register_restoring_key(&restoring, &t.terminals, "tm-live", now));
    assert!(register_restoring_key(&restoring, &t.terminals, "tm-waiting", now));
    assert!(is_restoring_key(&restoring, "tm-waiting", now));
    assert!(!is_restoring_key(&restoring, "tm-live", now), "a live key would never be removed again");
}

/// A shell running in this process (the fallback when no host is usable) is a live
/// terminal too: a renderer reload binds it without a create, so nothing would
/// ever remove a restore intent recorded for its key.
#[test]
fn restore_intent_skips_a_key_held_by_an_in_process_terminal() {
    let t = tables(&[("pc-host", "tm-hosted", FROZEN_1)]);
    t.terminals.insert("pc-local".into(), terminal("pc-local", "tm-local"));
    let restoring: DashMap<String, Instant> = DashMap::new();
    let now = Instant::now();

    assert!(!t.registered_anywhere("tm-local"), "no host owns it");
    assert!(!register_restoring_key(&restoring, &t.terminals, "tm-local", now));
    assert!(!register_restoring_key(&restoring, &t.terminals, "tm-hosted", now));
    assert!(restoring.is_empty(), "nothing would ever remove these");
    assert!(register_restoring_key(&restoring, &t.terminals, "tm-waiting", now));
}

#[test]
fn the_leaf_entry_point_skips_an_in_process_terminal_too() {
    let i = Intent::new(&[]);
    i.tables.terminals.insert("pc-local".into(), terminal("pc-local", "tm-local"));
    assert!(!register_restoring_leaf(&i.maps(), "tm-local", None, Instant::now()));
    assert!(i.restoring.is_empty());
}

#[test]
fn a_close_that_cannot_reach_the_elevated_host_is_dropped_not_owed() {
    let pending: DashMap<String, HostChannel> = DashMap::new();
    route_close(&pending, HostChannel::Elevated, "tm-e", None);
    assert!(pending.is_empty(), "the elevated host is never reconnected, so there is nothing to deliver to");
    route_close(&pending, FROZEN_1, "tm-f", None);
    assert_eq!(pending.get("tm-f").map(|c| *c.value()), Some(FROZEN_1), "an older host is owed it, by name");
}

#[test]
fn restore_intent_expires_unless_refreshed_and_a_reap_cannot_drop_a_refreshed_one() {
    let restoring: DashMap<String, Instant> = DashMap::new();
    let t0 = Instant::now();
    restoring.insert("tm-idle".into(), t0);
    restoring.insert("tm-retried".into(), t0);

    let later = t0 + RESTORE_INTENT_TTL + Duration::from_secs(1);
    refresh_restoring_key(&restoring, "tm-retried", later);
    assert!(!is_restoring_key(&restoring, "tm-idle", later));
    assert!(is_restoring_key(&restoring, "tm-retried", later));

    // The remover re-checks expiry itself: a stale reap decision cannot discard
    // an intent refreshed after it was made.
    assert!(!forget_restoring_key(&restoring, "tm-retried", Some(later)));
    reap_expired_restoring_keys(&restoring, later);
    assert!(!restoring.contains_key("tm-idle"));
    assert!(restoring.contains_key("tm-retried"));

    refresh_restoring_key(&restoring, "tm-never-registered", later);
    assert!(!restoring.contains_key("tm-never-registered"), "a refresh never creates an intent");
    assert!(forget_restoring_key(&restoring, "tm-retried", None));
}

/// Whichever host reports the key, the answer is the same: the verdict has no
/// host input, and a report from the primary and from a frozen host both close.
#[test]
fn closed_unowned_key_is_closed_when_any_host_reports_it() {
    let t = tables(&[]);
    let restoring: DashMap<String, Instant> = DashMap::new();
    let closed: DashMap<String, Instant> = DashMap::new();
    let now = Instant::now();
    restoring.insert("tm-closed".into(), now);

    mark_closed_unowned(&restoring, &closed, "tm-closed", now);
    assert!(!restoring.contains_key("tm-closed"), "the pane is gone: nothing waits for the key any more");

    for reporting_host in [PRIMARY, FROZEN_1, FROZEN_2] {
        assert!(
            unowned_close_due(&closed, t.registered_anywhere("tm-closed"), "tm-closed", now),
            "a listing from {reporting_host:?} must close the session"
        );
    }
    assert!(!unowned_close_due(&closed, false, "tm-unrelated", now));

    // Consumed by a fresh keyed spawn/attach, or by the TTL — not by the verdict.
    assert!(closed.contains_key("tm-closed"));
    assert!(!unowned_close_due(&closed, false, "tm-closed", now + RESTORE_INTENT_TTL + Duration::from_secs(1)));
    assert!(forget_closed_unowned(&closed, "tm-closed", None));
    assert!(!unowned_close_due(&closed, false, "tm-closed", now));
}

/// A saved layout reloaded after the close registers a NEW session under the
/// same key. Closing it because the key is in `closed_unowned` would kill a
/// terminal the user just opened.
#[test]
fn closed_unowned_never_closes_a_registered_session() {
    let closed: DashMap<String, Instant> = DashMap::new();
    let now = Instant::now();
    closed.insert("tm-reused".into(), now);

    for owner in [PRIMARY, FROZEN_1] {
        let t = tables(&[("pc-new", "tm-reused", owner)]);
        assert!(
            !unowned_close_due(&closed, t.registered_anywhere("tm-reused"), "tm-reused", now),
            "a session registered on {owner:?} must not be closed"
        );
    }
    let unregistered = tables(&[]);
    assert!(unowned_close_due(&closed, unregistered.registered_anywhere("tm-reused"), "tm-reused", now));
}

// ---- single-remover census --------------------------------------------------

/// Each of these maps is written from many places but may only be shrunk by one
/// function (two for `host_close_pending` and `restoring_leaf_keys`, whose two
/// shapes of removal are the two halves of an answered listing, and of a close
/// plus the expiry sweep): a removal anywhere else bypasses the host scoping or
/// the expiry re-check and is invisible at runtime.
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
    fn fn_span(src: &str, signature: &str) -> std::ops::Range<usize> {
        let start = src.find(signature).unwrap_or_else(|| panic!("`{signature}` not found"));
        let end = src[start..].find("\n}\n").expect("fn end at column 0") + start;
        start..end
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
    let registry = &sources.iter().find(|(name, _)| name == "state/host_registry.rs").unwrap().1;

    // (needle, the only functions whose body may contain it)
    let rules: &[(&[&str], &[&str])] = &[
        (
            &["restoring_keys.remove(", "restoring_keys.remove_if(", "restoring_keys.retain(", "restoring_keys.clear("],
            &["pub(super) fn forget_restoring_key("],
        ),
        (
            &[
                "restoring_leaf_keys.remove(",
                "restoring_leaf_keys.remove_if(",
                "restoring_leaf_keys.retain(",
                "restoring_leaf_keys.clear(",
            ],
            &["pub(super) fn forget_restoring_leaf(", "pub(super) fn prune_restoring_leaf_keys("],
        ),
        (
            &["closed_unowned.remove(", "closed_unowned.remove_if(", "closed_unowned.retain(", "closed_unowned.clear("],
            &["pub(super) fn forget_closed_unowned("],
        ),
        (
            &["host_close_pending.remove(", "host_close_pending.remove_if(", "host_close_pending.retain(", "host_close_pending.clear("],
            &["pub(super) fn take_pending_close(", "pub(super) fn prune_pending_closes("],
        ),
        (
            // Claims listed by a host that is gone for good, or that its answered
            // listing shows to be moot, are dropped as a set; every other claim
            // leaves through its owner-guarded or transaction-guarded path.
            &["host_session_claims.retain(", "host_session_claims.clear("],
            &["pub(super) fn forget_reserved_claims_on(", "pub(super) fn drop_stale_reserved_claims("],
        ),
    ];

    for (needles, allowed) in rules {
        let allowed_spans: Vec<_> = allowed.iter().map(|sig| fn_span(registry, sig)).collect();
        for needle in *needles {
            let mut offset = 0;
            while let Some(rel) = registry[offset..].find(needle) {
                let at = offset + rel;
                assert!(
                    allowed_spans.iter().any(|s| s.contains(&at)),
                    "`{needle}` outside its chokepoint in host_registry.rs at byte {at}"
                );
                offset = at + needle.len();
            }
            for (name, src) in sources.iter().filter(|(name, _)| name != "state/host_registry.rs") {
                assert!(
                    !src.contains(needle),
                    "`{needle}` found in {name}: route it through the chokepoint in host_registry.rs"
                );
            }
        }
        for sig in *allowed {
            let body = &registry[fn_span(registry, sig)];
            assert!(
                needles.iter().any(|n| body.contains(n)),
                "chokepoint `{sig}` no longer removes anything — the census above is vacuous"
            );
        }
    }
}

// ---- restore intent by pane ---------------------------------------------------

struct Intent {
    restoring: DashMap<String, Instant>,
    leaf_keys: DashMap<String, String>,
    closed: DashMap<String, Instant>,
    tables: Tables,
}

impl Intent {
    fn new(entries: &[(&str, &str, HostChannel)]) -> Self {
        Self {
            restoring: DashMap::new(),
            leaf_keys: DashMap::new(),
            closed: DashMap::new(),
            tables: tables(entries),
        }
    }

    fn maps(&self) -> IntentMaps<'_> {
        IntentMaps {
            restoring_keys: &self.restoring,
            restoring_leaf_keys: &self.leaf_keys,
            closed_unowned: &self.closed,
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

    assert!(register_restoring_leaf(&i.maps(), "tm-new", Some("tb-old"), now));
    assert!(i.restoring.contains_key("tb-old") && !i.restoring.contains_key("tm-new"));

    forget_restoring_leaf(&i.maps(), "tm-new", now);
    assert!(i.closed.contains_key("tb-old"), "the session it waited for is the one to close");
    assert!(!i.closed.contains_key("tm-new"));
    assert!(i.restoring.is_empty() && i.leaf_keys.is_empty());

    // A pane that waited under its own leaf is closed by that leaf.
    assert!(register_restoring_leaf(&i.maps(), "tm-plain", None, now));
    forget_restoring_leaf(&i.maps(), "tm-plain", now);
    assert!(i.closed.contains_key("tm-plain") && i.restoring.is_empty());
}

/// Restoring a pane again supersedes an earlier close of it: otherwise the host
/// resolving between registration and the pane's create would close the very
/// session the pane is about to take.
#[test]
fn restoring_a_pane_again_supersedes_its_earlier_close() {
    let i = Intent::new(&[]);
    let now = Instant::now();
    forget_restoring_leaf(&i.maps(), "tm-back", now);
    assert!(unowned_close_due(&i.closed, false, "tm-back", now));

    assert!(register_restoring_leaf(&i.maps(), "tm-back", None, now));
    assert!(!unowned_close_due(&i.closed, false, "tm-back", now));
    assert!(i.restoring.contains_key("tm-back"));

    // A key that is live was never restored, so an earlier close of it stands.
    let live = Intent::new(&[("pc-1", "tm-live", PRIMARY)]);
    forget_restoring_leaf(&live.maps(), "tm-live", now);
    assert!(!register_restoring_leaf(&live.maps(), "tm-live", None, now));
    assert!(live.closed.contains_key("tm-live"));
}

#[test]
fn leaf_keys_of_keys_nobody_waits_for_are_pruned() {
    let i = Intent::new(&[]);
    let now = Instant::now();
    register_restoring_leaf(&i.maps(), "tm-a", Some("tb-a"), now);
    register_restoring_leaf(&i.maps(), "tm-b", Some("tb-b"), now);
    forget_restoring_key(&i.restoring, "tb-a", None); // bound

    prune_restoring_leaf_keys(&i.leaf_keys, &i.restoring);
    assert!(!i.leaf_keys.contains_key("tm-a"));
    assert!(i.leaf_keys.contains_key("tm-b"));
}

#[test]
fn closing_one_window_keeps_the_other_copy_keyed_and_hidden_from_orphan_surfacing() {
    let i = Intent::new(&[]);
    let bindings = crate::session_bindings::SessionBindings::default();
    let identity = crate::identity_index::IdentityIndex::new();
    let now = Instant::now();
    for window in ["source", "other"] {
        bindings.register_intent_with("tm-leaf", "tb-old", window, now, || {
            assert!(register_restoring_leaf(&i.maps(), "tm-leaf", Some("tb-old"), now));
        });
    }
    let creating = bindings.begin_create("tm-leaf", "source", now).unwrap();
    bindings.stage_process("tm-leaf", "pc-source");
    identity.index("pc-source", Some("tm-leaf"), "tb-old");
    assert_eq!(close_leaf_for_window(&i.maps(), &bindings, &identity, "tm-leaf", "source", now), None);
    assert!(i.restoring.contains_key("tb-old"));
    assert!(i.leaf_keys.contains_key("tm-leaf"));
    assert!(!i.closed.contains_key("tb-old"));
    assert_eq!(orphan_verdict(&i.restoring, &i.closed, "tb-old", now), OrphanVerdict::Restoring);
    assert!(!creating.complete("pc-source", now), "the source's actual shell must be closed");
    bindings.forget_process("pc-source");
    identity.unindex("pc-source");
    assert_eq!(close_leaf_for_window(&i.maps(), &bindings, &identity, "tm-leaf", "other", now), None);
    assert!(!i.restoring.contains_key("tb-old"));
    assert!(i.closed.contains_key("tb-old"));
}

#[test]
fn moved_destinations_close_does_not_close_a_provisional_registration_before_spawn_returns() {
    let i = Intent::new(&[]);
    let bindings = crate::session_bindings::SessionBindings::default();
    let identity = crate::identity_index::IdentityIndex::new();
    let now = Instant::now();
    register_restoring_leaf(&i.maps(), "tm-leaf", None, now);
    let creating = bindings.begin_create("tm-leaf", "source", now).unwrap();
    bindings.stage_process("tm-leaf", "pc-provisional");
    identity.index("pc-provisional", Some("tm-leaf"), "tm-leaf");
    bindings.transfer_tree(&serde_json::json!({"terminalId": "tm-leaf"}), "source", "destination", now);
    assert_eq!(close_leaf_for_window(&i.maps(), &bindings, &identity, "tm-leaf", "destination", now), None);
    assert!(i.closed.contains_key("tm-leaf"));
    assert!(!creating.complete("pc-final-fallback", now), "close the final shell, not a provisional identity");
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
    i.restoring.insert("tm-wait".into(), now);
    i.closed.insert("tm-gone".into(), now);

    assert_eq!(orphan_verdict(&i.restoring, &i.closed, "tm-wait", now), OrphanVerdict::Restoring);
    assert_eq!(orphan_verdict(&i.restoring, &i.closed, "tm-gone", now), OrphanVerdict::CloseUnowned);
    assert_eq!(orphan_verdict(&i.restoring, &i.closed, "tm-stray", now), OrphanVerdict::Surface);
    // An intent nobody refreshed no longer hides a session.
    let later = now + RESTORE_INTENT_TTL + Duration::from_secs(1);
    assert_eq!(orphan_verdict(&i.restoring, &i.closed, "tm-wait", later), OrphanVerdict::Surface);
}

#[test]
fn a_duplicate_session_is_announced_once() {
    let flag = AtomicBool::new(false);
    assert!(first_report(&flag));
    assert!(!first_report(&flag));
}

#[test]
fn only_a_reserved_claim_names_the_host_holding_a_session() {
    let claims: DashMap<String, HostSessionClaim> = DashMap::new();
    assert_eq!(reserved_channel(&claims, "tm-a"), None);
    reserve_session(&claims, "tm-a", 4, FROZEN_2);
    assert_eq!(reserved_channel(&claims, "tm-a"), Some(FROZEN_2));
    claim_registration(&claims, "tm-a", PRIMARY).unwrap();
    assert_eq!(reserved_channel(&claims, "tm-a"), None, "a session already being taken over is not waiting");
}

// ---- claims a host's listing shows to be moot ---------------------------------

fn claim_in(state: HostSessionClaimState, channel: HostChannel) -> HostSessionClaim {
    HostSessionClaim { state, pid: 7, process_id: None, channel }
}

fn listed(key: &str, alive: bool) -> SessionMeta {
    SessionMeta { tab_id: key.into(), pid: 7, head_offset: 0, tail_offset: 0, alive }
}

#[test]
fn an_answered_listing_drops_a_reserved_claim_for_a_session_that_is_absent_or_dead() {
    let claims: DashMap<String, HostSessionClaim> = DashMap::new();
    for key in ["live", "absent", "dead"] {
        claims.insert(key.into(), claim_in(HostSessionClaimState::Reserved, FROZEN_1));
    }
    drop_stale_reserved_claims(&claims, FROZEN_1, &[listed("live", true), listed("dead", false)]);

    assert!(claims.contains_key("live"), "its session is still running");
    assert!(!claims.contains_key("absent"), "a session the host no longer has");
    assert!(!claims.contains_key("dead"), "a session the host lists as ended");
}

#[test]
fn a_listing_never_drops_a_claim_that_is_being_registered_or_is_registered() {
    let claims: DashMap<String, HostSessionClaim> = DashMap::new();
    claims.insert("taking".into(), claim_in(HostSessionClaimState::RegistrationInProgress, FROZEN_1));
    claims.insert("held".into(), claim_in(HostSessionClaimState::Registered, FROZEN_1));
    drop_stale_reserved_claims(&claims, FROZEN_1, &[]);

    assert!(claims.contains_key("taking"), "a create is taking this session right now");
    assert!(claims.contains_key("held"), "its pane retires it when the session exits");
}

#[test]
fn a_hosts_listing_only_settles_the_claims_of_that_host() {
    let claims: DashMap<String, HostSessionClaim> = DashMap::new();
    claims.insert("on-1".into(), claim_in(HostSessionClaimState::Reserved, FROZEN_1));
    claims.insert("on-2".into(), claim_in(HostSessionClaimState::Reserved, FROZEN_2));
    claims.insert("on-primary".into(), claim_in(HostSessionClaimState::Reserved, PRIMARY));
    drop_stale_reserved_claims(&claims, FROZEN_1, &[]);

    assert!(!claims.contains_key("on-1"));
    assert!(claims.contains_key("on-2"), "another older host's session is not in this answer");
    assert!(claims.contains_key("on-primary"));
}

#[test]
fn unfinished_claims_are_counted_per_host_and_exclude_registered_ones() {
    let claims: DashMap<String, HostSessionClaim> = DashMap::new();
    claims.insert("reserved".into(), claim_in(HostSessionClaimState::Reserved, FROZEN_1));
    claims.insert("taking".into(), claim_in(HostSessionClaimState::RegistrationInProgress, FROZEN_1));
    claims.insert("registered".into(), claim_in(HostSessionClaimState::Registered, FROZEN_1));
    claims.insert("elsewhere".into(), claim_in(HostSessionClaimState::Reserved, FROZEN_2));

    assert_eq!(unfinished_claims_on(&claims, FROZEN_1), 2);
    assert_eq!(unfinished_claims_on(&claims, FROZEN_2), 1);
    assert_eq!(unfinished_claims_on(&claims, PRIMARY), 0);
}
