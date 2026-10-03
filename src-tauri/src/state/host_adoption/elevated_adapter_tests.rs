use super::*;
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
