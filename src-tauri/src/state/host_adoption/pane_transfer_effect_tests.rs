use super::*;
use std::time::{Duration, Instant};

fn member(page: &mut Page, leaf: &str) -> PaneEntry {
    page.incarnation += 1;
    PaneEntry { pi: PaneIdentity { pg: page.pg, seq: page.incarnation }, descriptor: PaneDescriptor {
        pane_id: format!("destination-{}-{}", page.pg, page.incarnation), leaf: leaf.into(), restore: false, override_key: None,
    } }
}
fn stash(port: &FakePort, page: &mut Page, entry: PaneEntry, tx: &str) {
    let ui = serde_json::json!({ "tabTitle": "carried", "geometry": [19, 31], "processId": "not-an-authority" });
    let (result, effects) = page.send(port, PaneOp::Stash { tx: tx.into(), pairs: vec![entry], ui: Some(ui) });
    assert_eq!(result, PaneResult::Ok);
    assert!(effects.closes.is_empty());
}
fn take(port: &FakePort, page: &mut Page, tx: &str) {
    let (result, effects) = page.send(port, PaneOp::Take { tx: tx.into() });
    let PaneResult::Taken { payload } = result else { panic!("taken"); };
    assert_eq!(payload.ui.unwrap()["geometry"], serde_json::json!([19, 31]));
    assert!(effects.closes.is_empty());
}
async fn live_fence(world: &World, port: &FakePort, pcs: &[String], spawns: usize) {
    assert_eq!(world.count_everywhere("Spawn"), spawns);
    let listing = port.current_client().unwrap().list_sessions_numbered().await.unwrap();
    for pc in pcs {
        let key = session(port, pc);
        assert!(listing.sessions.iter().any(|s| s.tab_id == key && s.alive), "missing {pc} / {key}");
    }
    assert_eq!(world.count_everywhere("Close"), 0);
}

#[tokio::test]
async fn source_end_in_staged_and_taken_preserves_exact_shell_and_control() {
    for taken in [false, true] {
        let (world, port) = machine(HostSpec::default());
        let mut source = Page::new(&port, "source");
        let mut destination = Page::new(&port, "destination");
        let (entry, pc) = create(&port, &mut source, "tm-moving").await;
        let (control, control_pc) = create(&port, &mut destination, "tm-control").await;
        stash(&port, &mut source, entry, "source-end");
        if taken { take(&port, &mut destination, "source-end"); }
        assert_eq!(world.count_everywhere("Spawn"), 2);
        assert_eq!(port.table().keys().destroy_window(source.label, source.wi).len(), 1);
        assert_eq!(port.table().keys().pane_owner("tm-moving"), Some(Owner::Transfer { tx: "source-end".into(), taken }));
        assert_eq!(port.table().keys().pane_owner("tm-control"), Some(Owner::Pane(control.pi)));
        if taken {
            assert_eq!(port.table().keys().destroy_window(destination.label, destination.wi).len(), 1);
        } else {
            port.table().keys().expire_transfers(Instant::now() + Duration::from_secs(60));
        }
        assert_eq!(port.table().keys().pane_owner("tm-moving"), Some(Owner::Orphaned));
        live_fence(&world, &port, &[pc, control_pc], 2).await;
    }
}

#[tokio::test]
async fn destination_end_on_each_side_of_adopt_cannot_close_or_reinstall_shell() {
    for applied in [false, true] {
        let (world, port) = machine(HostSpec::default());
        let mut source = Page::new(&port, "source");
        let mut destination = Page::new(&port, "destination");
        let (entry, pc) = create(&port, &mut source, "tm-moving").await;
        let (control, control_pc) = create(&port, &mut source, "tm-control").await;
        stash(&port, &mut source, entry, "destination-end");
        take(&port, &mut destination, "destination-end");
        let adopted = member(&mut destination, "tm-moving");
        destination.seq += 1;
        let request = PaneRequest { pg: destination.pg, seq: destination.seq, op: PaneOp::Adopt { tx: "destination-end".into(), pairs: vec![adopted.clone()] } };
        let gate = Arc::new(EventGate::default());
        let task = tokio::spawn({ let port = port.clone(); let gate = gate.clone(); let request = request.clone(); async move {
            if !applied { gate.hold().await; }
            let result = port.table().keys().pane_op("destination", request);
            if applied { gate.hold().await; }
            result
        } });
        gate.wait_reached(1).await;
        assert_eq!(port.table().keys().pane_owner("tm-moving"), Some(if applied { Owner::Pane(adopted.pi) } else { Owner::Transfer { tx: "destination-end".into(), taken: true } }));
        assert_eq!(port.table().keys().destroy_window(destination.label, destination.wi).len(), 1);
        assert_eq!(port.table().keys().pane_owner("tm-moving"), Some(Owner::Orphaned));
        gate.release();
        let reply = task.await.unwrap();
        if applied {
            let (reply, effects) = reply.unwrap();
            assert_eq!(reply, PaneReply::Ack { result: PaneResult::Ok });
            assert!(effects.closes.is_empty());
        } else { assert!(reply.is_err()); }
        assert!(port.table().keys().pane_op(destination.label, request).is_err());
        assert_eq!(port.table().keys().pane_owner("tm-control"), Some(Owner::Pane(control.pi)));
        live_fence(&world, &port, &[pc, control_pc], 2).await;
    }
}

#[tokio::test]
async fn live_and_joining_moves_replay_adopt_once_without_an_extra_spawn() {
    for placing in [false, true] {
        let gate = Arc::new(EventGate::default());
        let (world, port) = machine(HostSpec { reply_gates: HashMap::from([("Spawn", gate.clone())]), ..HostSpec::default() });
        let mut source = Page::new(&port, "source");
        let mut destination = Page::new(&port, "destination");
        let control = source.enter(&port, "tm-control");
        let control_cg = source.admit(&port, &control);
        let control_task = tokio::spawn({ let port = port.clone(); let pg = source.pg; async move { run(&port, "source", pg, "tm-control", control_cg).await } });
        gate.wait_reached(1).await; gate.release();
        let control_pc = control_task.await.unwrap().unwrap();
        let entry = source.enter(&port, "tm-moving");
        let cg = source.admit(&port, &entry);
        let source_task = tokio::spawn({ let port = port.clone(); let pg = source.pg; async move { run(&port, "source", pg, "tm-moving", cg).await } });
        gate.wait_reached(2).await;
        let pc = port.table().keys().resolve_process("tm-moving", true).unwrap();
        if !placing { gate.release(); until(|| matches!(port.table().keys().owner_state("tm-moving"), Some((_, OwnerState::Registered(_))))).await; }
        stash(&port, &mut source, entry.clone(), "move");
        assert!(matches!(source.send(&port, PaneOp::Stash { tx: "move".into(), pairs: vec![entry.clone()], ui: None }).0, PaneResult::Rejected { .. }));
        take(&port, &mut destination, "move");
        let copy = destination.enter(&port, "tm-moving");
        assert_eq!(destination.send(&port, PaneOp::AdmitCreate { pi: copy.pi, mode: CreateMode::Mount }).0, PaneResult::Contended);
        assert_eq!(destination.send(&port, PaneOp::Close { pi: copy.pi }).0, PaneResult::Contended);
        let adopted = member(&mut destination, "tm-moving");
        destination.seq += 1;
        let request = PaneRequest { pg: destination.pg, seq: destination.seq, op: PaneOp::Adopt { tx: "move".into(), pairs: vec![adopted.clone()] } };
        let first = port.table().keys().pane_op(destination.label, request.clone()).unwrap();
        assert_eq!(first.0, PaneReply::Ack { result: PaneResult::Ok });
        let replay = port.table().keys().pane_op(destination.label, request).unwrap();
        assert_eq!(replay.0, first.0);
        assert!(first.1.closes.is_empty() && replay.1.closes.is_empty());
        assert_eq!(port.table().keys().pane_owner("tm-moving"), Some(Owner::Pane(adopted.pi)));
        assert!(matches!(source.send(&port, PaneOp::AdmitCreate { pi: entry.pi, mode: CreateMode::Mount }).0, PaneResult::Rejected { .. }));
        if placing {
            assert_eq!(destination.send(&port, PaneOp::AdmitCreate { pi: adopted.pi, mode: CreateMode::Mount }).0, PaneResult::Join { cg });
            let joined = tokio::spawn({ let port = port.clone(); let pg = destination.pg; async move { run(&port, "destination", pg, "tm-moving", cg).await } });
            gate.release();
            assert_eq!(joined.await.unwrap().unwrap(), pc);
        } else {
            assert_eq!(destination.send(&port, PaneOp::Bind { pi: adopted.pi, pc: pc.clone(), via: BindVia::Named("transfer".into()) }).0, PaneResult::Ok);
        }
        assert_eq!(source_task.await.unwrap().unwrap(), pc);
        assert_eq!(port.table().keys().pane_owner("tm-control"), Some(Owner::Pane(control.pi)));
        live_fence(&world, &port, &[pc, control_pc], 2).await;
    }
}

#[tokio::test]
async fn failed_build_before_and_after_expiry_reenters_without_transfer_authority_or_close() {
    for expired in [false, true] {
        let (world, port) = machine(HostSpec::default());
        let mut source = Page::new(&port, "source");
        let (entry, pc) = create(&port, &mut source, "tm-moving").await;
        let (control, control_pc) = create(&port, &mut source, "tm-control").await;
        let now = Instant::now();
        let (reply, effects) = port.table().keys().pane_op_at(source.label, PaneRequest { pg: source.pg, seq: source.seq + 1,
            op: PaneOp::Stash { tx: "failed-build".into(), pairs: vec![entry], ui: None } }, now).unwrap();
        source.seq += 1;
        assert_eq!(reply, PaneReply::Ack { result: PaneResult::Ok }); assert!(effects.closes.is_empty());
        let guard = port.table().keys().reserve_window("failed-destination").unwrap();
        let gate = Arc::new(EventGate::default());
        let build = tokio::spawn({ let gate = gate.clone(); async move { gate.hold().await; drop(guard); } });
        gate.wait_reached(1).await;
        if expired { port.table().keys().expire_transfers(now + Duration::from_secs(60)); }
        gate.release(); build.await.unwrap();
        let (cancel, effects) = source.send(&port, PaneOp::Cancel { tx: "failed-build".into() });
        assert!(effects.closes.is_empty());
        if expired { assert!(matches!(cancel, PaneResult::Rejected { .. })); } else { assert_eq!(cancel, PaneResult::Ok); }
        let replacement = source.enter(&port, "tm-moving");
        if expired {
            assert_eq!(source.send(&port, PaneOp::Bind { pi: replacement.pi, pc: pc.clone(), via: BindVia::Named("transfer".into()) }).0, PaneResult::Contended);
        }
        assert_eq!(source.send(&port, PaneOp::Bind { pi: replacement.pi, pc: pc.clone(), via: BindVia::Named(if expired { "restore" } else { "transfer" }.into()) }).0, PaneResult::Ok);
        assert_eq!(port.table().keys().pane_owner("tm-moving"), Some(Owner::Pane(replacement.pi)));
        assert_eq!(port.table().keys().pane_owner("tm-control"), Some(Owner::Pane(control.pi)));
        live_fence(&world, &port, &[pc, control_pc], 2).await;
    }
}
