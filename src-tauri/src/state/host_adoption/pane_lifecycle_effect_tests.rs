use super::*;

#[tokio::test]
async fn ended_unclaimed_admission_retries_joiners_and_successor_spawns_once() {
    for transition in ["destroy", "settle", "depart", "close", "cancel", "abandon", "unnamed_adopt"] {
        let (world, port) = machine(HostSpec::default());
        let mut source = Page::new(&port, "source");
        let mut destination = Page::new(&port, "destination");
        let (_, control_pc) = create(&port, &mut destination, "tm-control").await;
        let control_key = session(&port, &control_pc);
        let entry = source.enter(&port, "tm-waiting");
        let cg = source.admit(&port, &entry);
        let CreateAdmission::Join(waiter) = port.table().keys().admit_create("tm-waiting", CreateMode::Mount).unwrap() else { panic!("join"); };
        let gate = Arc::new(EventGate::default());
        let delayed = tokio::spawn({ let port = port.clone(); let gate = gate.clone(); let pg = source.pg; async move {
            gate.hold().await;
            run(&port, "source", pg, "tm-waiting", cg).await
        }});
        gate.wait_reached(1).await;
        assert!(matches!(port.table().keys().owner_state("tm-waiting"), Some((actual, OwnerState::Placing { stage: None, .. })) if actual == cg));
        assert_eq!(port.table().keys().pane_owner("tm-waiting"), Some(Owner::Pane(entry.pi)));
        assert_eq!(world.count_everywhere("Spawn"), 1, "only the live control ran");
        match transition {
            "destroy" => { assert_eq!(port.table().keys().destroy_window(source.label, source.wi).len(), 1); }
            "settle" => {
                let crate::state::PageRegistration::Registered { pg, .. } = port.table().keys().register_page(source.label).unwrap() else { panic!("successor"); };
                let (reply, _) = port.table().keys().pane_op(source.label, PaneRequest { pg, seq: 1, op: PaneOp::Settle }).unwrap();
                assert_eq!(reply, PaneReply::Ack { result: PaneResult::Ok });
            }
            "depart" | "close" => {
                let op = if transition == "depart" { PaneOp::Depart { pi: entry.pi } } else { PaneOp::Close { pi: entry.pi } };
                assert_eq!(source.send(&port, op).0, PaneResult::Ok);
            }
            _ => {
                assert_eq!(source.send(&port, PaneOp::Stash { tx: "waiting".into(), pairs: vec![entry], ui: None }).0, PaneResult::Ok);
                if transition == "cancel" { assert_eq!(source.send(&port, PaneOp::Cancel { tx: "waiting".into() }).0, PaneResult::Ok); }
                else if transition == "abandon" { port.table().keys().expire_transfers(std::time::Instant::now() + crate::state::TRANSFER_DEADLINE); }
                else {
                    assert!(matches!(destination.send(&port, PaneOp::Take { tx: "waiting".into() }).0, PaneResult::Taken { .. }));
                    assert_eq!(destination.send(&port, PaneOp::Adopt { tx: "waiting".into(), pairs: vec![] }).0, PaneResult::Ok);
                }
            }
        }
        assert!(port.table().keys().owner_state("tm-waiting").is_none(), "{transition}");
        assert!(CreateAdmission::joined(waiter, Duration::from_secs(1)).await.unwrap_err().starts_with("host-ownership-pending:"));
        gate.release();
        let refused = delayed.await.unwrap().unwrap_err();
        assert!(refused == "page is no longer live" || refused.starts_with("host-ownership-pending:"), "{refused}");
        let replacement = destination.enter(&port, "tm-waiting");
        let next = destination.admit(&port, &replacement);
        assert_ne!(cg, next);
        let pc = run(&port, destination.label, destination.pg, "tm-waiting", next).await.unwrap();
        assert_eq!(destination.send(&port, PaneOp::AdmitCreate { pi: replacement.pi, mode: CreateMode::Mount }).0, PaneResult::AlreadyBound { pc: pc.clone() });
        let answer = port.current_client().unwrap().list_sessions_numbered().await.unwrap();
        assert!(answer.sessions.iter().any(|s| s.tab_id == session(&port, &pc) && s.pid == 4242));
        assert!(answer.sessions.iter().any(|s| s.tab_id == control_key && s.pid == 4242));
        assert_eq!(world.count_everywhere("Spawn"), 2, "one successor and one control");
        assert_eq!(world.count_everywhere("Close"), 0);
    }
}

#[tokio::test]
async fn adopted_unstarted_work_is_claimable_only_by_destination() {
    let (world, port) = machine(HostSpec::default());
    let mut source = Page::new(&port, "source");
    let mut destination = Page::new(&port, "destination");
    let entry = source.enter(&port, "tm-waiting");
    let cg = source.admit(&port, &entry);
    assert_eq!(source.send(&port, PaneOp::Stash { tx: "move".into(), pairs: vec![entry], ui: None }).0, PaneResult::Ok);
    assert!(port.table().keys().admitted_work(source.label, source.pg, "tm-waiting", cg).is_err());
    assert!(matches!(destination.send(&port, PaneOp::Take { tx: "move".into() }).0, PaneResult::Taken { .. }));
    destination.incarnation += 1;
    let entry = PaneEntry { pi: PaneIdentity { pg: destination.pg, seq: destination.incarnation }, descriptor: PaneDescriptor {
        pane_id: "destination-waiting".into(), leaf: "tm-waiting".into(), restore: false, override_key: None,
    } };
    assert_eq!(destination.send(&port, PaneOp::Adopt { tx: "move".into(), pairs: vec![entry.clone()] }).0, PaneResult::Ok);
    assert_eq!(destination.send(&port, PaneOp::AdmitCreate { pi: entry.pi, mode: CreateMode::Mount }).0, PaneResult::Join { cg });
    assert!(port.table().keys().admitted_work(source.label, source.pg, "tm-waiting", cg).is_err());
    assert_eq!(port.table().keys().destroy_window(source.label, source.wi).len(), 1);
    let pc = run(&port, destination.label, destination.pg, "tm-waiting", cg).await.unwrap();
    assert_eq!(port.table().keys().pane_owner("tm-waiting"), Some(Owner::Pane(entry.pi)));
    assert_eq!(world.count_everywhere("Spawn"), 1);
    let answer = port.current_client().unwrap().list_sessions_numbered().await.unwrap();
    assert!(answer.sessions.iter().any(|s| s.tab_id == session(&port, &pc) && s.pid == 4242));
    assert_eq!(world.count_everywhere("Close"), 0);
}

#[tokio::test]
async fn reap_protects_gated_pane_and_transfer_placements_but_cancels_parked_and_orphaned() {
    for owner in ["pane", "transfer", "parked", "orphaned"] {
        let gate = Arc::new(EventGate::default());
        let (world, port) = machine(HostSpec { reply_gates: HashMap::from([("Spawn", gate.clone())]), ..HostSpec::default() });
        let mut page = Page::new(&port, "owner");
        let entry = page.enter(&port, "tm-waiting");
        let cg = page.admit(&port, &entry);
        let work = tokio::spawn({ let port = port.clone(); let pg = page.pg; async move { run(&port, "owner", pg, "tm-waiting", cg).await } });
        gate.wait_reached(1).await;
        let pc = port.table().keys().resolve_process("tm-waiting", true).unwrap();
        let key = session(&port, &pc);
        assert_eq!(world.sessions("owner-host", "Spawn"), vec![key.clone()]);
        assert!(matches!(port.table().keys().owner_state("tm-waiting"), Some((actual, OwnerState::Placing { stage: Some(s), cancel: None, .. })) if actual == cg && s.process == pc));
        assert_eq!(port.table().keys().pane_owner("tm-waiting"), Some(Owner::Pane(entry.pi)));
        match owner {
            "transfer" => { assert_eq!(page.send(&port, PaneOp::Stash { tx: "protected".into(), pairs: vec![entry.clone()], ui: None }).0, PaneResult::Ok); }
            "parked" => { assert_eq!(page.send(&port, PaneOp::Depart { pi: entry.pi }).0, PaneResult::Ok); }
            "orphaned" => { assert_eq!(port.table().keys().destroy_window(page.label, page.wi).len(), 1); }
            _ => {}
        }
        let protected = owner == "pane" || owner == "transfer";
        assert_eq!(port.table().keys().close_process_reap(&pc, true), (if protected { PaneResult::Contended } else { PaneResult::Ok }, vec![]));
        assert!(matches!(port.table().keys().owner_state("tm-waiting"), Some((actual, OwnerState::Placing { cancel, .. })) if actual == cg && cancel == if protected { None } else { Some(CloseStorage::Delete) }));
        assert_eq!(world.count_everywhere("Close"), 0);
        assert!(port.0.deleted.lock().unwrap().is_empty());
        gate.release();
        assert_eq!(work.await.unwrap().unwrap(), pc);
        let answer = port.current_client().unwrap().list_sessions_numbered().await.unwrap();
        if protected {
            assert!(answer.sessions.iter().any(|s| s.tab_id == key && s.pid == 4242));
            assert_eq!(world.count_everywhere("Close"), 0);
            assert!(port.0.deleted.lock().unwrap().is_empty());
            assert!(matches!(port.table().keys().owner_state("tm-waiting"), Some((_, OwnerState::Registered(s))) if s.process == pc));
        } else {
            assert_eq!(world.sessions("owner-host", "Close"), vec![key]);
            assert_eq!(*port.0.deleted.lock().unwrap(), vec!["tm-waiting"]);
            assert!(port.table().keys().owner_state("tm-waiting").is_none());
        }
    }
}
