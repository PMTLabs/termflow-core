//! Multi-host placement and lifecycle over real clients and fake host boundaries.
// Covers placement and lifecycle; the command layer is covered by
// host_adoption::routing_tests::spawn_routed_has_no_other_pty_host_clone (source census).
// The fake port does not supply the Tauri AppHandle needed by spawn_routed on Windows.
use super::fake_hosts::*;
use super::*;
use crate::state::host_lifecycle::{begin_offload, exit_hosts};
use crate::state::host_routing::{place, Placement};
use termflow_pty_protocol::{ArmDetachPurpose, SpawnSpec};

/// Candidates come from the real discovery and naming functions, not labels
/// assigned by this harness. Both naming modes run exactly the same machinery.
pub(crate) async fn exercise_generations(current: String, candidates: Vec<HostCandidate>) {
    let old = candidates.iter().find(|c| c.role == HostRole::Frozen).expect("frozen candidate").endpoint.clone();
    assert_ne!(old, current);
    for exiting in [false, true] {
        let world = World::new();
        let shell = SessionMeta { tab_id: "tm-old".into(), pid: 731, head_offset: 13, tail_offset: 97, alive: true };
        world.add_host(&old, HostSpec { sessions: vec![shell.clone()], ..HostSpec::default() });
        world.add_host(&current, HostSpec::default());
        let port = FakePort::new(&world, &current);
        port.set_candidates(candidates.clone());
        port.enable_retirement();
        rediscover_hosts(&port).await.unwrap();
        let frozen = port.frozen_hosts().into_iter().find(|h| h.endpoint == old).unwrap();
        let channel = HostChannel::Frozen(frozen.id);
        // These fake peers implement Shutdown; mirror the capability negotiation.
        frozen.client.set_shutdown_control(true);
        port.current_client().unwrap().set_shutdown_control(true);
        assert_eq!(port.table().keys().snapshot("tm-old").unwrap().channel, channel);

        let spec = SpawnSpec { shell: "test-shell".into(), args: vec![], env: vec![], env_remove: vec![], cwd: None, cols: 80, rows: 24, initial_cursor_row: None };
        let old_session_key = "tm-old";
        match place(&port, old_session_key, true).await.unwrap() {
            Placement::Attach { channel: target, client, pid, ticket, .. } => {
                assert_eq!(target, channel, "the old shell must attach on the frozen host");
                assert_eq!(pid, shell.pid, "attach retains the old process identity");
                assert_eq!(client.attach_confirmed(old_session_key, shell.tail_offset).await, Some(true));
                drop(ticket);
            }
            _ => panic!("a keyed old shell must attach, never spawn"),
        }
        assert_eq!(world.sessions(&old, "Attach"), ["tm-old"]);
        assert_eq!(world.count(&current, "Attach"), 0);
        let session_key = "tm-new";
        match place(&port, session_key, false).await.unwrap() {
            Placement::Spawn { channel, client, ticket, session_key } => {
                assert_eq!(channel, HostChannel::Primary);
                assert_eq!(client.spawn_session(&session_key, &spec).await.unwrap(), 4242);
                drop(ticket);
            }
            _ => panic!("a fresh create must spawn on the current host"),
        }
        let spawned = world.sessions(&current, "Spawn");
        assert_eq!(spawned.len(), 1);
        assert!(spawned[0].starts_with("tm-new~"));
        assert_eq!(world.count(&old, "Spawn"), 0);
        assert_eq!(frozen.client.list_sessions().await.unwrap().as_slice(), std::slice::from_ref(&shell), "old pid and ring unchanged");
        assert_eq!(*world.started_processes.lock().unwrap(), Vec::<String>::new(), "both hosts adopted, no duplicate process");

        if exiting {
            let report = exit_hosts(&port).await;
            assert_eq!(report.hosts.len(), 2);
            assert_eq!(report.problems().count(), 0);
            for endpoint in [&old, &current] {
                let frames = world.kinds(endpoint);
                let disarm = frames.iter().rposition(|k| *k == "Disarm").unwrap();
                let shutdown = frames.iter().position(|k| *k == "Shutdown").unwrap();
                let eof = frames.iter().position(|k| *k == "Eof").unwrap();
                assert!(disarm < shutdown && shutdown < eof, "{endpoint}: {frames:?}");
            }
        } else {
            let mut hold = begin_offload(&port).await.unwrap();
            hold.arm_detach(900, "tok", Some(ArmDetachPurpose::Local)).await.unwrap();
            for endpoint in [&old, &current] {
                assert_eq!(world.count(endpoint, "Arm"), 1, "offload reaches {endpoint}");
                assert_eq!(world.count(endpoint, "Shutdown") + world.count(endpoint, "Eof"), 0);
            }
            assert_eq!(frozen.client.list_sessions().await.unwrap(), [shell]);
            assert!(hold.release().await, "cancelled offload disarms and reopens admission");
            tokio::time::sleep(Duration::from_secs(20)).await;
            assert!(port.client_for(channel).is_some(), "a live old shell prevents retirement");
            world.end_session(&old, "tm-old");
            port.table().nudge_ticker(channel);
            tokio::time::sleep(Duration::from_secs(16)).await;
            assert!(port.frozen_hosts().is_empty(), "old host retired after its last shell ended");
            assert_eq!(port.table().admission(channel), Some(Admission::Retired));
            assert_eq!(world.count(&old, "Shutdown"), 1);
            assert_eq!(world.count(&old, "Eof"), 1, "retirement really closes the old transport");
            assert!(port.current_client().unwrap().is_alive());
            assert_eq!(world.count(&current, "Shutdown") + world.count(&current, "Eof"), 0);
            port.current_client().unwrap().close_transport().await;
        }
    }
}
