use super::*;
use crate::elevated_host::HostChannel;
use crate::state::{HostTable, KeyState, CloseState, StageMode, mint_process_id, mint_session_key};
use std::sync::{Arc, Mutex, atomic::AtomicU64};
use termflow_pty_protocol::{read_frame, write_frame, Data, Frame, Response, SpawnSpec};

type HeldFrame = (Frame, tokio::sync::oneshot::Sender<()>);

async fn held(receiver: &mut tokio::sync::mpsc::UnboundedReceiver<HeldFrame>) -> HeldFrame {
    tokio::time::timeout(Duration::from_secs(5), receiver.recv()).await.unwrap().unwrap()
}

async fn ending(table: &HostTable, key: &str, stamp: u64) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while table.keys().state(HostChannel::Primary, key) != Some(KeyState::Ending { close: CloseState::None, stamp: Some(stamp) }) {
            tokio::task::yield_now().await;
        }
    }).await.expect("real Exit did not advance the ending stamp");
}

#[tokio::test]
async fn real_reader_and_attach_exits_each_prevent_their_older_listing_from_releasing_the_key() {
    let Some(host) = start_host() else { return };
    let (mut host_read, mut host_write) = tokio::io::split(raw_identity_connection(&host).await);
    let (gui, relay) = tokio::io::duplex(65536);
    let (mut gui_read, gui_write) = tokio::io::split(relay);
    let gui_write = Arc::new(tokio::sync::Mutex::new(gui_write));
    let (exit_tx, mut exits) = tokio::sync::mpsc::unbounded_channel::<HeldFrame>();
    let (list_tx, mut listings) = tokio::sync::mpsc::unbounded_channel::<HeldFrame>();
    let session_key = mint_session_key("tm-real-exit").unwrap();
    let process = mint_process_id().unwrap();
    let relay_key = session_key.clone();
    let reader = tokio::spawn(async move {
        let mut held_tasks = tokio::task::JoinSet::new();
        while let Ok(Some(frame)) = read_frame(&mut host_read).await {
            let gate = match &frame {
                Frame::Data(Data::Exit { tab_id, .. }) if tab_id == &relay_key => Some(&exit_tx),
                Frame::Resp(Response::SessionList { .. }) => Some(&list_tx),
                _ => None,
            };
            if let Some(gate) = gate {
                let (release_tx, release_rx) = tokio::sync::oneshot::channel();
                gate.send((frame.clone(), release_tx)).unwrap();
                let writer = gui_write.clone();
                held_tasks.spawn(async move {
                    if release_rx.await.is_ok() { write_frame(&mut *writer.lock().await, &frame).await.unwrap(); }
                });
            } else {
                write_frame(&mut *gui_write.lock().await, &frame).await.unwrap();
            }
        }
    });
    let writer = tokio::spawn(async move {
        while let Ok(Some(frame)) = read_frame(&mut gui_read).await {
            write_frame(&mut host_write, &frame).await.unwrap();
        }
    });
    let table = HostTable::new();
    let epoch = table.reserve_epoch();
    assert!(table.publish(HostChannel::Primary, epoch));
    let observed = Arc::new(Mutex::new(Vec::new()));
    let (output_tx, _) = tokio::sync::broadcast::channel(128);
    let deps = PtyHostDeps {
        lifecycle_token: "tok".into(), output_tx,
        output_produced: Arc::new(AtomicU64::new(0)), stream_offsets: Arc::new(dashmap::DashMap::new()),
        resolve_process: { let table = table.clone(); Arc::new(move |key| table.routes().resolve(HostChannel::Primary, key, epoch, table.is_current(HostChannel::Primary, epoch))) },
        on_exit: { let observed = observed.clone(); Arc::new(move |pc, _, _| observed.lock().unwrap().push(pc)) },
        on_gap: Arc::new(|_| {}), on_disconnect: Arc::new(|| {}),
    };
    let (read, write) = tokio::io::split(gui);
    let client = wire_client(read, write, deps);
    client.bind_sessions(table.keys(), HostChannel::Primary, epoch);
    client.set_attach_acks(true);
    let (stage, _) = table.keys().stage(HostChannel::Primary, &session_key, StageMode::Spawn).unwrap();
    assert!(table.keys().publish(&stage, &process, epoch));
    let spec = SpawnSpec {
        shell: if cfg!(windows) { "cmd.exe" } else { "/bin/sh" }.into(),
        args: if cfg!(windows) { vec!["/D".into(), "/Q".into()] } else { vec!["-i".into()] },
        env: vec![], env_remove: vec![], cwd: None, cols: 80, rows: 24,
    };
    assert!(client.spawn_session(&session_key, &spec).await.unwrap() > 0);
    assert!(table.keys().complete(&stage, &process));
    client.write_stdin(&session_key, b"exit\r\n");
    let (first_exit, release_exit) = held(&mut exits).await;
    assert!(matches!(first_exit, Frame::Data(Data::Exit { tab_id, .. }) if tab_id == session_key));
    assert_eq!(table.keys().state(HostChannel::Primary, &session_key), Some(KeyState::Bound(process.clone())));
    let before = tokio::spawn({ let client = client.clone(); async move { client.list_sessions_numbered().await.unwrap() } });
    let (frame, release_listing) = held(&mut listings).await;
    assert!(matches!(&frame, Frame::Resp(Response::SessionList { sessions, .. }) if sessions.iter().any(|s| s.tab_id == session_key && !s.alive)));
    release_exit.send(()).unwrap();
    ending(&table, &session_key, 1).await;
    tokio::time::timeout(Duration::from_secs(5), async {
        while observed.lock().unwrap().is_empty() { tokio::task::yield_now().await; }
    }).await.unwrap();
    assert_eq!(observed.lock().unwrap().as_slice(), std::slice::from_ref(&process));
    release_listing.send(()).unwrap();
    let before = before.await.unwrap();
    assert_eq!(before.request_no, 1);
    table.keys().listing(HostChannel::Primary, &before, |_| false);
    ending(&table, &session_key, 1).await;

    // The actual host's Attach emits another Exit from its dead session ring.
    assert_eq!(client.attach_confirmed(&session_key, 0).await, Some(false));
    let (second_exit, release_exit) = held(&mut exits).await;
    assert!(matches!(second_exit, Frame::Data(Data::Exit { tab_id, .. }) if tab_id == session_key));
    let between = tokio::spawn({ let client = client.clone(); async move { client.list_sessions_numbered().await.unwrap() } });
    let (frame, release_listing) = held(&mut listings).await;
    assert!(matches!(&frame, Frame::Resp(Response::SessionList { sessions, .. }) if sessions.iter().any(|s| s.tab_id == session_key && !s.alive)));
    release_exit.send(()).unwrap();
    ending(&table, &session_key, 2).await;
    release_listing.send(()).unwrap();
    let between = between.await.unwrap();
    assert_eq!(between.request_no, 2);
    table.keys().listing(HostChannel::Primary, &between, |_| false);
    ending(&table, &session_key, 2).await;
    assert_eq!(observed.lock().unwrap().as_slice(), &[process], "the duplicate is a key event, not another owner exit");
    assert!(table.routes().dropped_frames() > 0);
    let after = tokio::spawn({ let client = client.clone(); async move { client.list_sessions_numbered().await.unwrap() } });
    let (_, release_listing) = held(&mut listings).await;
    release_listing.send(()).unwrap();
    let after = after.await.unwrap();
    assert_eq!(after.request_no, 3);
    table.keys().listing(HostChannel::Primary, &after, |_| false);
    assert_eq!(table.keys().state(HostChannel::Primary, &session_key), None);
    assert_eq!(exits.try_recv().err(), Some(tokio::sync::mpsc::error::TryRecvError::Empty));
    assert!(client.close_transport().await);
    reader.abort();
    writer.abort();
    // RealHost owns and reaps only this isolated child.
    assert!(host.child.id() > 0);
}
