use super::*;
use crate::state::{HostKeys, HostTable, CreateAdmission, CreateMode, Completion, EndKind, CloseStorage, ShellStage, StageMode, StagedShell};
use crate::elevated_host::{HostChannel, ElevatedHost};
use termflow_pty_protocol::{read_frame, write_frame};
use tokio::io::{DuplexStream, AsyncReadExt};
use std::time::Duration;
const CHANNEL: HostChannel = HostChannel::Primary;
const BOUND: Duration = Duration::from_secs(3);

fn wire(keys: &HostKeys, channel: HostChannel, epoch: u64, offsets: Arc<dashmap::DashMap<String, u64>>) -> (PtyHostClient, DuplexStream, broadcast::Receiver<ChannelPayload>) {
    let (mut deps, _) = super::conn_tests::deps();
    let output = deps.output_tx.subscribe();
    let routes = keys.clone();
    deps.resolve_process = Arc::new(move |key| routes.session_identity(channel, key, "pc-live").map(|i| i.process));
    deps.stream_offsets = offsets;
    let (local, peer) = tokio::io::duplex(65536);
    let (rd, wr) = tokio::io::split(local);
    let client = wire_client(rd, wr, deps);
    client.bind_sessions(keys, channel, epoch);
    (client, peer, output)
}
fn stage(keys: &HostKeys, channel: HostChannel, pc: &str, key: &str) -> (u64, StagedShell) {
    let CreateAdmission::Run(cg) = keys.admit_create("tm-leaf", CreateMode::Mount).unwrap() else { panic!("admission") };
    let (h, _, _) = keys.stage_shell("tm-leaf", cg, pc, Some((channel, key, StageMode::Spawn))).unwrap();
    (cg, StagedShell { process: pc.into(), stage: ShellStage::Hosted(h.unwrap()) })
}
async fn frame(peer: &mut DuplexStream) -> Frame {
    tokio::time::timeout(BOUND, read_frame(peer)).await.unwrap().unwrap().unwrap()
}
async fn stdout(peer: &mut DuplexStream, offset: u64, bytes: &[u8]) {
    write_frame(peer, &Frame::Data(Data::Stdout { tab_id: "shared".into(), offset, bytes: bytes.into() })).await.unwrap();
}
async fn reader_fence(client: &PtyHostClient, peer: &mut DuplexStream) {
    let task = tokio::spawn({ let client = client.clone(); async move { client.disarm().await } });
    let Frame::Ctrl(Control::Disarm { req }) = frame(peer).await else { panic!("fence frame") };
    write_frame(peer, &Frame::Resp(Response::DisarmAck { req })).await.unwrap();
    assert!(task.await.unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_resolved_old_reader_cannot_overwrite_the_current_offset() {
    let keys = HostKeys::default();
    let offsets = Arc::new(dashmap::DashMap::new());
    let (old, mut old_peer, mut output) = wire(&keys, CHANNEL, 1, offsets.clone());
    let (cg, shell) = stage(&keys, CHANNEL, "pc-live", "shared");
    let ShellStage::Hosted(h) = &shell.stage else { unreachable!() };
    assert!(keys.publish(h, "pc-live", 1));
    assert!(matches!(keys.complete_shell("tm-leaf", cg, &shell), Completion::Registered));
    stdout(&mut old_peer, 10, b"old-control").await;
    assert_eq!(tokio::time::timeout(BOUND, output.recv()).await.unwrap().unwrap().data, b"old-control");
    assert_eq!(offsets.get("shared").map(|v| *v), Some(21));
    let (reached_tx, reached) = std::sync::mpsc::channel();
    let (release, released) = std::sync::mpsc::channel();
    let released = Mutex::new(released);
    *old.before_stdout.lock().unwrap() = Some(Arc::new(move || {
        reached_tx.send(()).unwrap();
        released.lock().unwrap().recv_timeout(BOUND).unwrap();
    }));
    stdout(&mut old_peer, 30, b"stale").await;
    reached.recv_timeout(BOUND).unwrap();
    let (current, mut current_peer, mut current_output) = wire(&keys, CHANNEL, 2, offsets.clone());
    assert!(keys.restore_route(CHANNEL, "shared", "pc-live", 2));
    stdout(&mut current_peer, 230, b"current-Q").await;
    let payload = tokio::time::timeout(BOUND, current_output.recv()).await.unwrap().unwrap();
    assert_eq!((payload.id.as_str(), payload.data.as_slice()), ("pc-live", b"current-Q".as_slice()));
    assert_eq!(offsets.get("shared").map(|v| *v), Some(239));
    release.send(()).unwrap();
    reader_fence(&old, &mut old_peer).await;
    assert_eq!(offsets.get("shared").map(|v| *v), Some(239));
    assert!(output.try_recv().is_err());
    stdout(&mut current_peer, 239, b"live").await;
    assert_eq!(tokio::time::timeout(BOUND, current_output.recv()).await.unwrap().unwrap().data, b"live");
    assert_eq!(offsets.get("shared").map(|v| *v), Some(243));
    assert!(old.close_transport().await);
    assert!(keys.restore_route(CHANNEL, "shared", "pc-live", 2));
    assert!(current.close_transport().await);
}

#[tokio::test]
async fn denied_owned_attach_returns_error_without_registering_or_enqueuing() {
    for ack in [false, true] {
        for stale_epoch in [false, true] {
            let keys = HostKeys::default();
            let (client, mut peer, _) = wire(&keys, CHANNEL, 1, Arc::default());
            client.set_attach_acks(ack);
            let (cg, shell) = stage(&keys, CHANNEL, "pc-P", "shared");
            let identity = keys.session_identity(CHANNEL, "shared", "pc-P").unwrap();
            let replacement = if stale_epoch {
                let (new, new_peer, _) = wire(&keys, CHANNEL, 2, Arc::default());
                Some((new, new_peer))
            } else {
                assert!(keys.abort_create("tm-leaf", cg).is_some());
                // Abort of this Spawn stage legitimately owes its exact Close.
                assert_eq!(frame(&mut peer).await, Frame::Ctrl(Control::Close { tab_id: "shared".into() }));
                None
            };
            // This is the create continuation: denial must stop before completion.
            let result: Result<(), String> = async {
                client.attach_owned(&identity, 17).await?;
                assert!(matches!(keys.complete_shell("tm-leaf", cg, &shell), Completion::Registered));
                Ok(())
            }.await;
            assert!(result.unwrap_err().starts_with("host-ownership-pending:"));
            assert!(!matches!(keys.owner_state("tm-leaf"), Some((_, crate::state::OwnerState::Registered(_)))));
            assert_eq!(client.pending_requests(), 0);
            let session_key_control = "control";
            client.resize(session_key_control, 93, 37);
            assert_eq!(frame(&mut peer).await, Frame::Ctrl(Control::Resize { tab_id: "control".into(), cols: 93, rows: 37 }));
            assert!(client.close_transport().await);
            if let Some((new, _peer)) = replacement { assert!(new.close_transport().await); }
        }
        let keys = HostKeys::default();
        let (client, mut peer, _) = wire(&keys, CHANNEL, 1, Arc::default());
        client.set_attach_acks(ack);
        let (cg, shell) = stage(&keys, CHANNEL, "pc-control", "shared");
        let identity = keys.session_identity(CHANNEL, "shared", "pc-control").unwrap();
        let attached = tokio::spawn({ let client = client.clone(); async move { client.attach_owned(&identity, 23).await } });
        let received = frame(&mut peer).await;
        if ack {
            let Frame::Ctrl(Control::AttachAcked { req, tab_id, from_offset: 23 }) = received else { panic!("acked attach") };
            assert_eq!(tab_id, "shared");
            write_frame(&mut peer, &Frame::Resp(Response::AttachAck { req, tab_id, alive: true, tail_offset: 31 })).await.unwrap();
        } else { assert!(matches!(received, Frame::Ctrl(Control::Attach { tab_id, from_offset: 23, .. }) if tab_id == "shared")); }
        assert_eq!(attached.await.unwrap().unwrap(), if ack { Some(true) } else { None });
        assert!(matches!(keys.complete_shell("tm-leaf", cg, &shell), Completion::Registered));
        assert!(client.close_transport().await);
    }
    let command = include_str!("../commands/terminal.rs");
    assert!(crate::state::source_scan::fn_body(command, "async fn run_create(").contains("client.attach_owned(&identity, 0).await?"));
}

#[tokio::test]
async fn idle_elevated_shutdown_cancels_the_bound_transport_but_preserves_new_owners_and_epochs() {
    let channel = HostChannel::Elevated;
    let table = HostTable::new();
    assert!(table.publish(channel, 1));
    let keys = table.keys();
    let (client, mut peer, _) = wire(keys, channel, 1, Arc::default());
    let manager = ElevatedHost::new();
    manager.install_client(client.clone());
    let (cg, p) = stage(keys, channel, "pc-P", "p-key");
    assert!(matches!(keys.complete_shell("tm-leaf", cg, &p), Completion::Registered));
    assert!(matches!(keys.close_process("pc-P", CloseStorage::Preserve), crate::state::CloseAction::End { .. }));
    assert!(keys.end_process("pc-P", EndKind::Close(CloseStorage::Preserve), |_| {}).is_some());
    assert_eq!(frame(&mut peer).await, Frame::Ctrl(Control::Close { tab_id: "p-key".into() }));
    // Hold the actual scheduled cleanup before it acquires lifecycle authority.
    let manager = Arc::new(manager);
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (resume_tx, resume_rx) = tokio::sync::oneshot::channel();
    let queued = tokio::spawn({ let manager = manager.clone(); let table = table.clone(); async move {
        entered_tx.send(()).unwrap();
        resume_rx.await.unwrap();
        manager.shutdown_idle(&table, 1).await
    }});
    tokio::time::timeout(BOUND, entered_rx).await.unwrap().unwrap();
    let (q_cg, q) = stage(keys, channel, "pc-Q", "q-key");
    assert!(matches!(keys.complete_shell("tm-leaf", q_cg, &q), Completion::Registered));
    resume_tx.send(()).unwrap();
    assert!(!tokio::time::timeout(BOUND, queued).await.unwrap().unwrap());
    assert!(manager.client_clone().unwrap().write_registered(keys, "pc-Q", channel, "q-key", b"Q"));
    assert!(manager.client_clone().unwrap().resize_registered(keys, "pc-Q", channel, "q-key", 93, 41));
    assert_eq!(frame(&mut peer).await, Frame::Data(Data::Stdin { tab_id: "q-key".into(), bytes: b"Q".to_vec() }));
    assert_eq!(frame(&mut peer).await, Frame::Ctrl(Control::Resize { tab_id: "q-key".into(), cols: 93, rows: 41 }));
    // Tickets protect even a connection with no staged owner yet.
    assert!(keys.end_process("pc-Q", EndKind::Exit, |_| {}).is_some());
    let ticket = table.begin(channel).unwrap();
    assert!(!manager.shutdown_idle(&table, 1).await);
    assert!(client.is_alive());
    drop(ticket);
    let idle = tokio::spawn({ let manager = manager.clone(); let table = table.clone(); async move {
        manager.shutdown_idle(&table, 1).await
    }});
    assert!(tokio::time::timeout(BOUND, idle).await.unwrap().unwrap());
    assert!(manager.client_clone().is_none());
    assert!(!client.is_alive());
    let mut byte = [0];
    assert_eq!(tokio::time::timeout(BOUND, peer.read(&mut byte)).await.unwrap().unwrap(), 0);
    assert!(matches!(keys.state(channel, "p-key"), Some(crate::state::KeyState::Ending { close: crate::state::CloseState::Pending, .. })));
    // Installing a replacement leaves it live when the old eligible epoch runs.
    assert!(table.publish(channel, 2));
    let (new, mut new_peer, _) = wire(keys, channel, 2, Arc::default());
    manager.install_client(new.clone());
    assert_eq!(frame(&mut new_peer).await, Frame::Ctrl(Control::Close { tab_id: "p-key".into() }));
    assert!(!manager.shutdown_idle(&table, 1).await);
    assert!(client.close_transport().await);
    assert_eq!(new.session_epoch(channel), Some(2));
    assert!(new.is_alive());
    new.resize("replacement-control", 81, 25);
    assert_eq!(frame(&mut new_peer).await, Frame::Ctrl(Control::Resize { tab_id: "replacement-control".into(), cols: 81, rows: 25 }));
    assert!(manager.shutdown_idle(&table, 2).await);
    assert_eq!(tokio::time::timeout(BOUND, new_peer.read(&mut byte)).await.unwrap().unwrap(), 0);
}

#[tokio::test]
async fn stale_listing_enqueue_and_answer_cannot_mutate_a_new_connection() {
    let keys = HostKeys::default();
    let (old, mut peer, _) = wire(&keys, CHANNEL, 1, Arc::default());
    let listing_task = tokio::spawn({ let old = old.clone(); async move { old.list_sessions_numbered().await } });
    let Frame::Ctrl(Control::ListSessions { req, .. }) = frame(&mut peer).await else { panic!("listing control") };
    let (new, mut new_peer, _) = wire(&keys, CHANNEL, 2, Arc::default());
    write_frame(&mut peer, &Frame::Resp(Response::SessionList { req, sessions: vec![] })).await.unwrap();
    let old_answer = listing_task.await.unwrap().unwrap();
    assert!(!old.apply_listing_on(&keys, CHANNEL, &old_answer, std::time::Instant::now(), |_| false));
    assert!(old.list_sessions_numbered().await.is_none());
    old.resize("fence", 81, 25);
    assert!(matches!(frame(&mut peer).await, Frame::Ctrl(Control::Resize { .. })));
    let task = tokio::spawn({ let new = new.clone(); async move { new.list_sessions_numbered().await } });
    let Frame::Ctrl(Control::ListSessions { req, .. }) = frame(&mut new_peer).await else { panic!("current listing") };
    write_frame(&mut new_peer, &Frame::Resp(Response::SessionList { req, sessions: vec![SessionMeta { tab_id: "current".into(), pid: 42, head_offset: 0, tail_offset: 0, alive: true }] })).await.unwrap();
    let answer = task.await.unwrap().unwrap();
    assert!(new.apply_listing_on(&keys, CHANNEL, &answer, std::time::Instant::now(), |_| false));
    assert_eq!(keys.state(CHANNEL, "current"), Some(crate::state::KeyState::Listed));
    assert!(old.close_transport().await);
    assert!(new.close_transport().await);
}
