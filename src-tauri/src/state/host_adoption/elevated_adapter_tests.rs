use super::*;
use crate::state::host_registry;
use super::fake_hosts::*;
use super::owner_tests::{machine, until};
use crate::state::host_routing::{prepare_elevated_process, place_elevated_process, Placement, RoutingPort};
use crate::state::{CreateAdmission, CreateMode, KeyState, OwnerState};

fn admit(port: &FakePort, leaf: &str) -> u64 {
    let CreateAdmission::Run(cg) = port.table().keys().admit_create(leaf, CreateMode::Mount).unwrap() else { panic!("admit") };
    cg
}
async fn elevated(port: &FakePort, world: &World) -> PtyHostClient {
    let channel = HostChannel::Elevated;
    let epoch = port.table().reserve_epoch().unwrap();
    assert!(port.table().publish(channel, epoch));
    let (rd, wr) = tokio::io::split(world.open("owner-host").unwrap());
    let client = crate::pty_host_client::wire_client(rd, wr, port.deps(channel, epoch, Arc::new(|| {})));
    client.bind_sessions(port.table().keys(), channel, epoch);
    client
}

#[tokio::test]
async fn non_elevated_place_owned_rejects_an_elevated_listed_key() {
    let (world, port) = machine(HostSpec { sessions: vec![meta("tm-admin", 7)], ..HostSpec::default() });
    let client = elevated(&port, &world).await;
    let listing = client.list_sessions_numbered().await.unwrap();
    port.apply_listing(HostChannel::Elevated, &client, Some(&listing));
    // Supply a primary client too: mutating Elevated => current_client would attach.
    port.publish_current(&client).unwrap();
    assert!(crate::state::host_routing::place_owned(&port, "tm-admin", Some("tm-admin"), None).await.is_err());
    assert_eq!(world.count_everywhere("Attach"), 0);
}

#[tokio::test]
async fn elevated_orphan_pass_waits_for_restore_closes_unowned_and_runs_once_after_placement() {
    let (world, port) = machine(HostSpec { sessions: ["tm-claimed", "tm-restoring", "tm-closed-unowned", "tm-orphan"].iter().enumerate().map(|(i,k)| meta(k, 10 + i as u32)).collect(), ..HostSpec::default() });
    let client = elevated(&port, &world).await;
    let channel = HostChannel::Elevated;
    let epoch = port.table().epoch(channel).unwrap();
    let now = std::time::Instant::now();
    let keys = port.table().keys();
    keys.reserve_window("pending").unwrap().commit().unwrap();
    keys.begin_restore_participation(["pending".into()]);
    assert!(host_registry::register_restoring_leaf(&port.intent_maps(), "closed", "tm-closed-unowned", None, now));
    host_registry::forget_restoring_leaf(&port.intent_maps(), "closed", "tm-closed-unowned", now);
    // Initial adoption precedes placement, just as survivor connection does.
    let listing = client.list_sessions_numbered().await.unwrap();
    port.apply_listing(channel, &client, Some(&listing));
    client.list_sessions_numbered().await.unwrap(); // adoption Close must precede orphan surfacing
    assert_eq!(world.sessions("owner-host", "Close"), vec!["tm-closed-unowned"]);
    let cg = admit(&port, "tm-trigger");
    let prepared = prepare_elevated_process(port.ids()).unwrap();
    let (_pc, placement) = place_elevated_process(&port, "tm-trigger", Some("tm-claimed"), client.clone(), cg, prepared).unwrap();
    assert!(matches!(placement, Placement::Attach { .. }));
    let manager = crate::elevated_host::ElevatedHost::new();
    manager.arm_orphan_pass(epoch);
    let mut runs = 0;
    for _ in 0..2 {
        if let Some(taken) = manager.take_pending_orphan_pass() {
            runs += 1;
            let p = port.clone(); let c = client.clone();
            let task = tokio::spawn(async move { super::elevated_orphans::run(&p, &c, taken).await; });
            tokio::time::sleep(Duration::from_millis(100)).await;
            keys.flush_deliveries();
            assert!(port.0.recovered.lock().unwrap().is_empty(), "window restore must settle before surfacing");
            assert!(host_registry::register_restoring_leaf(&port.intent_maps(), "restoring", "tm-restoring", None, now));
            keys.begin_restore_participation(Vec::new());
            task.await.unwrap();
        }
    }
    keys.flush_deliveries();
    client.list_sessions_numbered().await.unwrap(); // FIFO fence for Close
    assert_eq!(runs, 1);
    assert_eq!(*port.0.recovered.lock().unwrap(), vec!["tm-orphan"]);
    assert_eq!(keys.channel_of_key("tm-orphan"), Some(channel));
    assert_eq!(world.sessions("owner-host", "Close"), vec!["tm-closed-unowned"]);
    assert_eq!(world.count("owner-host", "List"), 4, "initial + adoption fence + one pass + fence");
    drop(placement);
}

#[tokio::test]
async fn elevated_orphan_pass_discards_a_superseded_epoch() {
    let gate = Arc::new(ListGate::default());
    let (world, port) = machine(HostSpec { sessions: vec![meta("tm-orphan", 8)], list: ListBehavior::GatedAfter { answered: 0, gate: gate.clone() }, ..HostSpec::default() });
    let client = elevated(&port, &world).await;
    let old = port.table().epoch(HostChannel::Elevated).unwrap();
    let p = port.clone(); let c = client.clone();
    let task = tokio::spawn(async move { super::elevated_orphans::run(&p, &c, old).await; });
    tokio::time::timeout(Duration::from_secs(2), gate.reached.notified()).await.unwrap();
    let new = port.table().reserve_epoch().unwrap();
    assert!(port.table().publish(HostChannel::Elevated, new));
    gate.release.notify_one();
    task.await.unwrap();
    assert!(port.0.listings.lock().unwrap().is_empty(), "superseded answers must not enter adoption");
    port.table().keys().flush_deliveries();
    assert!(port.0.recovered.lock().unwrap().is_empty());
    assert!(port.table().keys().channel_of_key("tm-orphan").is_none());
    let manager = crate::elevated_host::ElevatedHost::new();
    manager.arm_orphan_pass(old);
    assert_eq!(manager.take_pending_orphan_pass(), Some(old));
    assert_eq!(manager.take_pending_orphan_pass(), None);
    manager.arm_orphan_pass(new);
    assert_eq!(manager.take_pending_orphan_pass(), Some(new));
}

#[test]
fn elevated_orphan_pass_is_taken_only_after_placement_and_uses_normal_adoption() {
    let source = include_str!("../../commands/terminal.rs");
    let body = crate::state::source_scan::fn_body(source, "pub(super) async fn run_create(");
    assert!(body.find("place_elevated_create(").unwrap() < body.find("take_pending_orphan_pass(").unwrap());
    let source = include_str!("../terminals.rs");
    let body = crate::state::source_scan::fn_body(source, "async fn ensure_elevated_host_inner(");
    assert!(body.contains("AdoptionPort::apply_listing(self, HostChannel::Elevated, &client, Some(&listing))"));
    assert!(!body.contains("|_| false"));
}

#[tokio::test]
async fn elevated_create_uses_the_prepared_allocator_identity_and_refuses_rng_failure() {
    let (world, port) = machine(HostSpec::default());
    let process_uuid = uuid::Uuid::parse_str("01234567-89ab-4cde-8fab-0123456789ab").unwrap();
    let key_uuid = uuid::Uuid::parse_str("fedcba98-7654-4321-8fed-cba987654321").unwrap();
    let draws = std::sync::atomic::AtomicUsize::new(0);
    let port = port.with_ids(crate::state::IdAllocator::new(move || match draws.fetch_add(1, std::sync::atomic::Ordering::SeqCst) {
        0 => Ok(process_uuid), 1 => Ok(key_uuid), _ => Err("injected entropy failure".into()),
    }));
    let prepared = prepare_elevated_process(port.ids()).unwrap();
    assert!(port.0.terminals.is_empty());
    let client = elevated(&port, &world).await;
    let cg = admit(&port, "tm-elevated");
    let (pc, placement) = place_elevated_process(&port, "tm-elevated", None, client.clone(), cg, prepared).unwrap();
    assert_eq!(pc, "pc-0123456789ab4cde8fab0123456789ab");
    let Placement::Spawn { channel, ticket, session_key, .. } = placement else { panic!("spawn") };
    assert_eq!(channel, HostChannel::Elevated);
    assert_eq!(session_key, "tm-elevated~fedcba98765443218fedcba987654321");
    assert_eq!(port.table().keys().state(channel, &session_key), Some(KeyState::Held(cg)));
    assert!(ticket.publish_key(&pc));
    port.register_terminal(&pc, &session_key, channel);
    let identity = port.table().keys().session_identity(channel, &session_key, &pc).unwrap();
    let spec = termflow_pty_protocol::SpawnSpec { shell: "fake".into(), args: vec![], env: vec![], env_remove: vec![], cwd: None, cols: 83, rows: 29, initial_cursor_row: None };
    assert_eq!(client.spawn_owned(&identity, &spec).await.unwrap(), 4242);
    assert_eq!(world.sessions("owner-host", "Spawn"), vec![session_key.clone()]);
    assert_eq!(port.table().routes().resolve(channel, &session_key, port.table().epoch(channel).unwrap(), true), Some(pc.clone()));
    assert_eq!(prepare_elevated_process(port.ids()).err().unwrap(), "injected entropy failure");
    assert_eq!(port.0.terminals.len(), 1);
    assert_eq!(world.count_everywhere("Spawn"), 1);
    assert!(matches!(port.table().keys().owner_state("tm-elevated"), Some((_, OwnerState::Placing { stage: Some(s), .. })) if s.process == pc));
    port.table().keys().abort_create("tm-elevated", cg);
    drop(ticket);
    client.list_sessions_numbered().await.unwrap();
}

#[tokio::test]
async fn elevated_admission_cap_refuses_new_stages_without_publishing_or_sending() {
    let (world, port) = machine(HostSpec::default());
    let channel = HostChannel::Elevated;
    port.table().keys().set_cap(1);
    port.table().keys().seed_pending(channel, "owed");
    let client = elevated(&port, &world).await;
    until(|| world.count("owner-host", "Close") == 1).await;
    assert_eq!(world.sessions("owner-host", "Close"), vec!["owed"]);
    let cg = admit(&port, "tm-refused");
    let prepared = prepare_elevated_process(port.ids()).unwrap();
    let refusal = place_elevated_process(&port, "tm-refused", None, client.clone(), cg, prepared).err().unwrap();
    assert!(refusal.starts_with("host-ownership-pending:"));
    assert!(matches!(port.table().keys().owner_state("tm-refused"), Some((_, OwnerState::Placing { stage: None, .. }))));
    assert!(port.0.terminals.is_empty());
    assert_eq!(world.count_everywhere("Spawn"), 0);
    assert_eq!(port.table().inflight(channel), 0);
    let listing = client.list_sessions_numbered().await.unwrap();
    port.apply_listing(channel, &client, Some(&listing));
    assert!(port.table().keys().state(channel, "owed").is_none());
    let prepared = prepare_elevated_process(port.ids()).unwrap();
    let (pc, placement) = place_elevated_process(&port, "tm-refused", None, client, cg, prepared).unwrap();
    let Placement::Spawn { ticket, session_key, .. } = placement else { panic!("spawn control") };
    assert!(ticket.publish_key(&pc));
    assert_eq!(port.table().keys().state(channel, &session_key), Some(KeyState::Held(cg)));
    assert_eq!(port.table().inflight(channel), 1);
    port.table().keys().abort_create("tm-refused", cg);
    drop(ticket);
}
