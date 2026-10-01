use super::*;
use crate::pty_host_client::{wire_client, PtyHostDeps};
use crate::state::host_table::HostTable;
use std::sync::{atomic::AtomicU64, Arc};
use termflow_pty_protocol::{read_frame, write_frame, Control, Data, Frame, Response};

#[tokio::test]
async fn two_hosts_route_output_offsets_gap_and_exit_only_to_the_owning_current_connection() {
    let table = HostTable::new();
    let channels = [HostChannel::Primary, HostChannel::Frozen(FrozenId(7))];
    let owners = Arc::new(DashMap::new());
    for (_key, process, channel) in [("tm-new", "pc-new", channels[0]), ("tm-old", "pc-old", channels[1])] {
        owners.insert(process.to_string(), channel);
    }
    let offsets = Arc::new(DashMap::new());
    let events = Arc::new(Mutex::new(Vec::new()));
    let (output_tx, mut output) = tokio::sync::broadcast::channel(16);
    let mut connections = Vec::new();
    for channel in channels {
        let epoch = table.reserve_epoch();
        assert!(table.publish(channel, epoch));
        let (stream, server) = tokio::io::duplex(4096);
        let (rd, wr) = tokio::io::split(stream);
        let (key, process) = if channel == channels[0] { ("tm-new", "pc-new") } else { ("tm-old", "pc-old") };
        table.routes().register(channel, key, process, epoch);
        let (hosts, admission) = (owners.clone(), table.clone());
        let (gaps, exits) = (events.clone(), events.clone());
        let deps = PtyHostDeps {
            lifecycle_token: "test".into(), output_tx: output_tx.clone(),
            output_produced: Arc::new(AtomicU64::new(0)), stream_offsets: offsets.clone(),
            resolve_process: Arc::new(move |key| resolve_inbound(&hosts, &admission, channel, epoch, key)),
            on_gap: Arc::new(move |process| gaps.lock().unwrap().push(("gap", process))),
            on_exit: Arc::new(move |process, _, _| exits.lock().unwrap().push(("exit", process))),
            on_disconnect: Arc::new(|| {}),
        };
        connections.push((wire_client(rd, wr, deps), server));
    }
    for (n, key) in ["tm-new", "tm-old"].iter().enumerate() {
        write_frame(&mut connections[n].1, &Frame::Data(Data::Stdout {
            tab_id: key.to_string(), offset: (n as u64 + 1) * 100, bytes: vec![n as u8],
        })).await.unwrap();
        let payload = tokio::time::timeout(Duration::from_secs(2), output.recv()).await.unwrap().unwrap();
        assert_eq!(payload.id, if n == 0 { "pc-new" } else { "pc-old" });
        assert_eq!(payload.data, vec![n as u8]);
    }
    assert_eq!(*offsets.get("tm-new").unwrap(), 101);
    assert_eq!(*offsets.get("tm-old").unwrap(), 201);

    // Positive controls: both owners must receive Gap and Exit, not merely
    // reject frames addressed to someone else. These callbacks do not clean up.
    for (n, key) in ["tm-new", "tm-old"].iter().enumerate() {
        let (client, server) = &mut connections[n];
        for data in [Data::Gap { tab_id: key.to_string(), at_offset: 1 }, Data::Exit { tab_id: key.to_string(), exit_cwd: None }] {
            write_frame(server, &Frame::Data(data)).await.unwrap();
        }
        let listing = tokio::spawn({ let client = client.clone(); async move { client.list_sessions().await } });
        let req = match read_frame(server).await.unwrap().unwrap() {
            Frame::Ctrl(Control::ListSessions { req, .. }) => req,
            other => panic!("unexpected {other:?}"),
        };
        write_frame(server, &Frame::Resp(Response::SessionList { req, sessions: vec![] })).await.unwrap();
        assert!(listing.await.unwrap().is_some());
    }
    assert_eq!(*events.lock().unwrap(), vec![
        ("gap", "pc-new".to_string()), ("exit", "pc-new".to_string()),
        ("gap", "pc-old".to_string()), ("exit", "pc-old".to_string()),
    ]);
    events.lock().unwrap().clear();

    // A duplicate key on the wrong host, then a stale connection to the right host.
    for stale in [false, true] {
        let (client, server) = &mut connections[1];
        let key = if stale { "tm-old" } else { "tm-new" };
        if stale {
            assert!(table.publish(channels[1], table.reserve_epoch()));
        }
        for data in [
            Data::Stdout { tab_id: key.into(), offset: 9000, bytes: b"wrong-host".to_vec() },
            Data::Gap { tab_id: key.into(), at_offset: 1 },
            Data::Exit { tab_id: key.into(), exit_cwd: None },
        ] {
            write_frame(server, &Frame::Data(data)).await.unwrap();
        }
        // A response following those frames proves the reader processed all of them.
        let listing = tokio::spawn({ let client = client.clone(); async move { client.list_sessions().await } });
        let req = match read_frame(server).await.unwrap().unwrap() {
            Frame::Ctrl(Control::ListSessions { req, .. }) => req,
            other => panic!("unexpected {other:?}"),
        };
        write_frame(server, &Frame::Resp(Response::SessionList { req, sessions: vec![] })).await.unwrap();
        assert!(listing.await.unwrap().is_some());
        assert!(output.try_recv().is_err(), "wrong host or stale connection must not feed another pane");
        assert!(events.lock().unwrap().is_empty(), "nor repaint or end it");
        assert_eq!(*offsets.get("tm-new").unwrap(), 101);
        assert_eq!(*offsets.get("tm-old").unwrap(), 201, "replay offsets must not be advanced by rejected output");
    }
    for (client, _) in connections { assert!(client.close_transport().await); }
}

#[test]
fn real_host_dependencies_scope_inbound_resolution_to_channel_and_epoch() {
    use crate::state::source_scan::{fn_body, production};
    let port = production(include_str!("../host_port.rs"));
    assert!(fn_body(&port, "fn host_deps(").contains("host_registry::resolve_inbound(&st.host_terminals, &st.host_table, channel, epoch, k)"));
    assert!(fn_body(&port, "async fn connect_current(").contains("HostChannel::Primary, my_gen"));
    let frozen = fn_body(&port, "async fn connect_frozen(");
    assert!(frozen.contains("HostChannel::Frozen(id),") && frozen.contains("epoch,"));
}
