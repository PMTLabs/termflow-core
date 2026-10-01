use super::fake_hosts::*;
use super::*;
use crate::state::host_registry::{self, ListingMaps, OrphanVerdict, RESTORE_INTENT_TTL};
use crate::state::host_routing::{place_owned, Placement};
use crate::state::{CloseState, KeyState, CreateAdmission, CreateMode, Completion, ShellStage, StagedShell};
use std::time::Instant as Clock;
use termflow_pty_protocol::{Frame, Control};

const HOST: &str = "restore-holder-host";
const CHANNEL: HostChannel = HostChannel::Primary;
const K: &str = "tm-old~00000000000040008000000000000001";
const L1: &str = "tm-leaf~00000000000040008000000000000001";
const L2: &str = "tm-leaf~00000000000040008000000000000002";

async fn machine(keys: &[&str]) -> (Arc<World>, FakePort) {
    let world = World::new();
    world.add_host(HOST, HostSpec { sessions: keys.iter().enumerate().map(|(i, k)| meta(k, 100 + i as u32)).collect(), ..HostSpec::default() });
    let port = FakePort::new(&world, HOST);
    port.set_candidates(vec![candidate(HOST, HostRole::Current)]);
    ensure_hosts(&port).await.unwrap();
    assert_eq!(world.count(HOST, "List"), 1);
    for key in keys { assert!(port.table().keys().eligible(CHANNEL, key)); }
    (world, port)
}
fn register(port: &FakePort, window: &str, leaf: &str, key: Option<&str>, now: Clock) {
    assert!(host_registry::register_restoring_leaf(&port.intent_maps(), window, leaf, key, now));
    assert_eq!(port.table().keys().holder_stamp(window, leaf), Some(now));
}
fn forget(port: &FakePort, window: &str, leaf: &str, now: Clock) {
    host_registry::forget_restoring_leaf(&port.intent_maps(), window, leaf, now);
    assert!(port.table().keys().holder_stamp(window, leaf).is_none());
}
async fn listing(port: &FakePort, now: Clock) -> crate::pty_host_client::SessionListing {
    let client = port.current_client().unwrap();
    let answer = client.list_sessions_numbered().await.unwrap();
    host_registry::apply_answered_listing(&ListingMaps {
        host_terminals: &port.0.host_terminals, terminals: &port.0.terminals, keys: port.table().keys(),
    }, CHANNEL, &answer, now);
    answer
}
async fn fence(port: &FakePort) -> crate::pty_host_client::SessionListing {
    // A response from this following request witnesses all preceding Closes on
    // the same FIFO without a sleep or a guessed absence deadline.
    port.current_client().unwrap().list_sessions_numbered().await.unwrap()
}
fn closes(world: &World) -> Vec<String> {
    world.frames_of(HOST).into_iter().filter_map(|f| match f {
        Frame::Ctrl(Control::Close { tab_id }) => Some(tab_id), _ => None,
    }).collect()
}

#[tokio::test]
async fn shared_override_remains_live_until_both_restoring_holders_forget() {
    let (world, port) = machine(&[K, "tm-control", "tm-stray"]).await;
    let now = Clock::now();
    register(&port, "left", "tm-a", Some(K), now);
    register(&port, "right", "tm-b", Some(K), now);
    register(&port, "left", "tm-control", None, now);
    assert_eq!(port.table().keys().holder_count(), 3);
    forget(&port, "left", "tm-control", now);
    forget(&port, "left", "tm-a", now);
    assert_eq!(port.table().keys().marker_count(), 2);
    assert_eq!(port.table().keys().holder_count(), 1);
    let answer = listing(&port, now).await;
    assert_eq!(answer.sessions.iter().map(|s| s.tab_id.as_str()).collect::<Vec<_>>(), vec![K, "tm-control", "tm-stray"]);
    let after = fence(&port).await;
    assert_eq!(closes(&world), vec!["tm-control"]);
    assert!(after.sessions.iter().any(|s| s.tab_id == K && s.pid == 100));
    assert!(port.table().keys().eligible(CHANNEL, K));
    assert_eq!(host_registry::orphan_verdict(port.table().keys(), K, now), OrphanVerdict::Restoring);
    super::panes::surface_orphans(&port, answer.sessions, CHANNEL);
    assert_eq!(*port.0.recovered.lock().unwrap(), vec!["tm-stray"], "shared restoring key must not be recovered either");
    assert_eq!(closes(&world), vec!["tm-control"]);

    forget(&port, "right", "tm-b", now);
    listing(&port, now).await;
    let after = fence(&port).await;
    assert_eq!(closes(&world), vec!["tm-control", K]);
    assert!(!after.sessions.iter().any(|s| s.tab_id == K));
    assert!(after.sessions.iter().any(|s| s.tab_id == "tm-stray" && s.pid == 102));
    assert!(matches!(port.table().keys().state(CHANNEL, K), Some(KeyState::Ending { close: CloseState::Sent(_), .. })));
    listing(&port, now).await;
    fence(&port).await;
    assert_eq!(closes(&world), vec!["tm-control", K], "a consumed Listed cell owes only one Close");
}

#[tokio::test]
async fn leaf_holder_protects_both_incarnations_and_legacy_and_new_holder_consumes_the_alias_marker() {
    let (world, port) = machine(&[L1, L2, "tm-leaf", "tm-control"]).await;
    let now = Clock::now();
    register(&port, "left", "tm-other", None, now);
    for key in [L1, L2, "tm-leaf"] { assert!(!port.table().keys().is_restoring_key(key, now)); }
    register(&port, "right", "tm-leaf", None, now);
    for key in [L1, L2, "tm-leaf"] { assert!(port.table().keys().is_restoring_key(key, now)); }
    forget(&port, "right", "tm-leaf", now);
    assert_eq!(port.table().keys().marker_count(), 1);
    for key in [L1, L2, "tm-leaf"] { assert!(port.table().keys().unowned_close_due(false, key, now)); }
    register(&port, "successor", "tm-leaf", None, now);
    assert_eq!(port.table().keys().marker_count(), 0);
    forget(&port, "left", "tm-control", now);
    listing(&port, now).await;
    let after = fence(&port).await;
    assert_eq!(closes(&world), vec!["tm-control"]);
    for key in [L1, L2, "tm-leaf"] {
        assert!(after.sessions.iter().any(|s| s.tab_id == key));
        assert!(port.table().keys().eligible(CHANNEL, key));
    }
    // Remove the new holder without creating a marker: marker consumption,
    // rather than protection alone, must be responsible for the quiet listing.
    let cg = match port.table().keys().admit_create("tm-leaf", CreateMode::Mount).unwrap() {
        CreateAdmission::Run(cg) => cg, _ => panic!("admission"),
    };
    port.table().keys().stage_shell("tm-leaf", cg, "pc-local", None).unwrap();
    assert_eq!(port.table().keys().holder_count(), 1);
    assert_eq!(port.table().keys().marker_count(), 1, "only unrelated control marker remains");
    listing(&port, now).await;
    fence(&port).await;
    assert_eq!(closes(&world), vec!["tm-control"]);
}

#[tokio::test]
async fn override_protection_uses_the_exact_key_even_when_its_owner_leaf_differs() {
    let (world, port) = machine(&[K, "tm-old~00000000000040008000000000000002", "tm-old", "tm-control"]).await;
    let now = Clock::now();
    register(&port, "left", "tm-source", Some(K), now);
    register(&port, "right", "tm-new", Some(K), now);
    forget(&port, "left", "tm-source", now);
    forget(&port, "left", "tm-control", now);
    assert!(port.table().keys().is_restoring_key(K, now));
    for key in ["tm-old~00000000000040008000000000000002", "tm-old"] {
        assert!(!port.table().keys().is_restoring_key(key, now));
        assert!(!port.table().keys().unowned_close_due(false, key, now), "override is exact, not its owner's alias family");
    }
    listing(&port, now).await;
    fence(&port).await;
    assert_eq!(closes(&world), vec!["tm-control"]);
    assert!(port.table().keys().eligible(CHANNEL, K));
    forget(&port, "right", "tm-new", now);
    listing(&port, now).await;
    let after = fence(&port).await;
    assert_eq!(closes(&world), vec!["tm-control", K]);
    assert_eq!(after.sessions.len(), 2);
}

#[tokio::test]
async fn a_new_holder_consumes_intersecting_markers_across_different_leaves() {
    for (old_leaf, old_override, new_leaf, new_override) in [
        ("tm-source", Some(K), "tm-new", Some(K)),
        ("tm-old", None, "tm-new", Some(K)),
        ("tm-source", Some(K), "tm-old", None),
    ] {
        let (world, port) = machine(&[K, old_leaf, "tm-control"]).await;
        let now = Clock::now();
        register(&port, "left", old_leaf, old_override, now);
        forget(&port, "left", old_leaf, now);
        assert_eq!(port.table().keys().marker_count(), 1);
        assert!(port.table().keys().unowned_close_due(false, K, now));
        register(&port, "right", new_leaf, new_override, now);
        assert_eq!(port.table().keys().marker_count(), 0);
        let CreateAdmission::Run(cg) = port.table().keys().admit_create(new_leaf, CreateMode::Mount).unwrap() else { panic!("new admission") };
        port.table().keys().stage_shell(new_leaf, cg, "pc-local", None).unwrap();
        assert_eq!(port.table().keys().holder_count(), 0, "consumed marker must not merely be hidden by a holder");
        forget(&port, "left", "tm-control", now);
        listing(&port, now).await;
        let after = fence(&port).await;
        assert_eq!(closes(&world), vec!["tm-control"]);
        assert_eq!(after.sessions.len(), 2);
        assert!(port.table().keys().eligible(CHANNEL, K));
        assert!(port.table().keys().eligible(CHANNEL, old_leaf));
    }
}

#[tokio::test]
async fn window_scoped_forget_cannot_remove_another_windows_same_leaf_holder() {
    let (world, port) = machine(&[L1, "tm-control"]).await;
    let now = Clock::now();
    register(&port, "left", "tm-leaf", None, now);
    register(&port, "right", "tm-leaf", Some(L1), now);
    assert_eq!(port.table().keys().holder_count(), 2);
    forget(&port, "left", "tm-leaf", now);
    assert_eq!(port.table().keys().holder_stamp("right", "tm-leaf"), Some(now));
    forget(&port, "unknown", "tm-leaf", now);
    assert_eq!(port.table().keys().holder_count(), 1);
    forget(&port, "unknown", "tm-control", now);
    listing(&port, now).await;
    fence(&port).await;
    assert_eq!(closes(&world), vec!["tm-control"]);
    forget(&port, "right", "tm-leaf", now);
    listing(&port, now).await;
    fence(&port).await;
    assert_eq!(closes(&world), vec!["tm-control", L1]);
}

#[tokio::test]
async fn gate_off_marker_expiry_only_reduces_closes_and_unrefreshed_holder_expiry_ends_protection() {
    let (world, port) = machine(&[K, "tm-expired-marker", "tm-control"]).await;
    let t0 = Clock::now();
    register(&port, "left", "tm-a", Some(K), t0);
    register(&port, "right", "tm-b", Some(K), t0);
    forget(&port, "left", "tm-expired-marker", t0);
    let later = t0 + RESTORE_INTENT_TTL;
    // The first marker is still live while the unrefreshed second holder reaches
    // the inherited expiry boundary. No new timeout is involved.
    forget(&port, "left", "tm-a", t0 + Duration::from_secs(1));
    forget(&port, "left", "tm-control", later);
    assert!(port.table().keys().is_restoring_key(K, later - Duration::from_nanos(1)));
    assert!(!port.table().keys().is_restoring_key(K, later));
    assert_eq!(port.table().keys().marker_count(), 3);
    listing(&port, later).await;
    let after = fence(&port).await;
    let mut got = closes(&world); got.sort();
    let mut wanted = vec![K.to_string(), "tm-control".into()]; wanted.sort();
    assert_eq!(got, wanted);
    assert_eq!(after.sessions.len(), 1);
    assert_eq!(after.sessions[0].tab_id, "tm-expired-marker");
    port.table().keys().reap_expired_restore_intents(later);
    assert_eq!(port.table().keys().holder_count(), 0);
    assert_eq!(port.table().keys().marker_count(), 2);
}

#[tokio::test]
async fn gate_off_keyed_create_refreshes_matching_holders_and_staging_ends_only_its_own_leaf() {
    let (world, port) = machine(&[K, "tm-control"]).await;
    let old = Clock::now() - RESTORE_INTENT_TTL - Duration::from_secs(1);
    register(&port, "left", "tm-a", Some(K), old);
    register(&port, "right", "tm-b", Some(K), old);
    assert!(!port.table().keys().is_restoring_key(K, Clock::now()));
    let cg = match port.table().keys().admit_create("tm-a", CreateMode::Mount).unwrap() {
        CreateAdmission::Run(cg) => cg, _ => panic!("admission"),
    };
    assert_eq!(port.table().keys().holder_count(), 2, "unstaged placement must retain intent until the router reads it");
    let before = Clock::now();
    let Placement::Attach { client, ticket, session_key, .. } = place_owned(&port, "tm-a", Some(K), Some((cg, "pc-restored"))).await.unwrap() else { panic!("attach") };
    assert_eq!(session_key, K);
    assert!(port.table().keys().holder_stamp("left", "tm-a").is_none());
    assert!(port.table().keys().holder_stamp("right", "tm-b").unwrap() >= before);
    assert_eq!(port.table().keys().holder_count(), 1);
    assert!(ticket.publish_key("pc-restored"));
    assert_eq!(client.attach_confirmed(&session_key, 0).await, Some(true));
    assert_eq!(world.sessions(HOST, "Attach"), vec![K]);
    let shell = StagedShell { process: "pc-restored".into(), stage: ShellStage::Hosted(ticket.key_stage().unwrap()) };
    assert!(matches!(port.table().keys().complete_shell("tm-a", cg, &shell), Completion::Registered));
    forget(&port, "left", "tm-a", Clock::now());
    forget(&port, "left", "tm-control", Clock::now());
    listing(&port, Clock::now()).await;
    fence(&port).await;
    assert_eq!(closes(&world), vec!["tm-control"]);
    assert_eq!(port.table().keys().state(CHANNEL, K), Some(KeyState::Bound("pc-restored".into())));
    assert!(port.table().keys().is_restoring_key(K, Clock::now()));
    // Release the failed/ended owner's key without closing it, so holder refresh
    // is independently observable, not masked by the Bound cell.
    port.table().keys().end_process("pc-restored", crate::state::EndKind::Exit, |_| {}).unwrap();
    let answer = fence(&port).await;
    assert_eq!(answer.sessions[0].tab_id, K);
    let later = before + RESTORE_INTENT_TTL - Duration::from_secs(1);
    assert!(port.table().keys().is_restoring_key(K, later));
    assert!(!port.table().keys().unowned_close_due(false, K, later), "refreshed holder, not a Bound cell, protects the live marker");
    assert_eq!(closes(&world), vec!["tm-control"]);
}

#[test]
fn restore_commands_use_injected_window_labels_and_close_policy_reads_shared_ownership() {
    use crate::state::source_scan::fn_body;
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let commands = std::fs::read_to_string(root.join("commands/terminal.rs")).unwrap();
    for (name, call) in [("register_restoring_leaves", "state.register_restoring_leaf(window.label(),"), ("forget_restoring_leaf", "state.forget_restoring_leaf(window.label(),")] {
        let start = commands.find(&format!("pub fn {name}(")).unwrap();
        let signature = &commands[start..start + commands[start..].find(") -> Result").unwrap()];
        assert!(signature.contains("window: tauri::WebviewWindow"));
        assert!(fn_body(&commands, &format!("pub fn {name}(")).contains(call));
    }
    let keys = std::fs::read_to_string(root.join("state/host_keys.rs")).unwrap();
    for name in ["pub(crate) fn listing_at(", "pub fn close_listed("] {
        let body = fn_body(&keys, name);
        assert!(body.contains("let mut inner = self.lock()"));
        assert!(body.contains("Self::unowned_due(&inner,"));
        assert!(body.contains("KeyState::Listed"));
        assert!(body.contains("Self::end(&mut inner,"));
    }
    let restore = std::fs::read_to_string(root.join("state/host_keys/restore.rs")).unwrap();
    let policy = fn_body(&restore, "pub(super) fn unowned_due(");
    for needle in ["Self::protected(inner,", "inner.closed_unowned", "inner.keys", "KeyState::Held", "KeyState::Bound"] { assert!(policy.contains(needle)); }
    let renderer = std::fs::read_to_string(root.parent().unwrap().parent().unwrap().join("src/renderer/api/tauri-bridge.ts")).unwrap();
    assert!(renderer.contains("invoke<void>('register_restoring_leaves', { leaves })"));
    assert!(renderer.contains("invoke<void>('forget_restoring_leaf', { leafId })"));
}
