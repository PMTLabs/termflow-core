use super::handover::{gap, holder_oracles};
use super::*;
use std::sync::atomic::Ordering;

async fn full_chain(bind: &str) {
    let Some(mut rig) = Rig::new(false).await else {
        return;
    };
    let mut gap = gap(&mut rig, bind).await;
    holder_oracles(&rig, &gap).await;
    let port = RealPort::new(&[&rig.hosts[gap.host]], 0);
    let io = E2eBootIo::new(&rig, port.clone());
    let prepared = prepare_reclaim(&io, io.inputs(rig.config(gap.configured, bind))).await;
    assert_eq!(
        prepared.decision(),
        &Decision::Use(gap.port),
        "settle must claim BEFORE Disarm"
    );
    assert_eq!(prepared.reserved(), &[gap.port]);
    io.completed().await;
    let client = port.current_client().unwrap();
    same_shell(&client, &gap.session_key, gap.pid).await;
    let listings = port.0.listings.lock().unwrap().clone();
    assert!(listings.iter().any(|(_, s)| s
        .iter()
        .any(|s| s.tab_id == gap.session_key && s.pid == gap.pid && s.alive)));
    // Pin provenance returned by the real claim (also proves idempotent claim).
    let held = client.claim_mcp(&rig.token).await.unwrap();
    assert_eq!(
        held,
        McpClaimOutcome::Held(Some(termflow_pty_protocol::McpHeld {
            port: gap.port,
            configured_port: gap.configured,
            bind_host: bind.into()
        }))
    );
    let claimed = gap.agent.call().await.unwrap();
    assert!(claimed.text().contains("starting again"));
    tokio::time::sleep(STOP_BOUND + Duration::from_millis(100)).await;
    assert!(
        gap.agent
            .call()
            .await
            .unwrap()
            .text()
            .contains("starting again"),
        "holder survives Disarm past STOP_BOUND"
    );
    let mut stream = gap.agent.sse().await;
    let traffic = tokio::spawn({
        let a = gap.agent.clone();
        async move {
            let end = Instant::now() + Duration::from_secs(5);
            while Instant::now() < end {
                let _ = a.call().await;
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    });
    let release_call = Instant::now();
    // The old stream must end within STOP_BOUND of the release ACK, sampled while start_mcp runs.
    let (started, ()) = tokio::join!(start_mcp(prepared, rig.api_port, &io), async {
        let acked = port.release_ack(Duration::from_secs(20)).await;
        stream.eof_by(acked + STOP_BOUND).await;
    });
    assert_eq!(started, Some(gap.port));
    let identity = health(gap.port).await.unwrap();
    assert_eq!(identity["instanceId"], io.own_id);
    let listening = release_call.elapsed();
    assert!(listening <= Duration::from_secs(5));
    eprintln!("MEASURE bind={bind} release-call-to-listening={listening:?}");
    assert_eq!(
        gap.agent.call().await.unwrap().status,
        404,
        "old-session POST must reinitialize"
    );
    gap.agent.initialize().await;
    assert!(gap.agent.call().await.unwrap().text().contains(&rig.marker));
    traffic.abort();
    let _ = traffic.await;
    io.stop();
    client.close(&gap.session_key);
    assert!(client.list_sessions().await.unwrap().is_empty());
    port.close().await;
}
#[tokio::test]
async fn handover_and_reclaim_loopback() {
    full_chain("127.0.0.1").await;
}
#[tokio::test]
async fn handover_and_reclaim_wildcard() {
    full_chain("0.0.0.0").await;
}

#[tokio::test]
async fn foreign_identity_is_stopped_and_normal_search_runs() {
    let Some(mut rig) = Rig::new(false).await else {
        return;
    };
    let gap = gap(&mut rig, "127.0.0.1").await;
    let port = RealPort::new(&[&rig.hosts[gap.host]], 0);
    let io = E2eBootIo::new(&rig, port.clone());
    io.foreign_once.store(true, Ordering::SeqCst);
    let prepared = prepare_reclaim(&io, io.inputs(rig.config(gap.configured, "127.0.0.1"))).await;
    assert_eq!(prepared.decision(), &Decision::Use(gap.port));
    io.completed().await;
    // Keep the configured/search port distinct from the forced held port.
    // The held provenance remains unchanged; start_mcp's fallback uses this configuration.
    let result = start_mcp(prepared, rig.api_port, &io).await.unwrap();
    assert_eq!(
        io.stops.load(Ordering::SeqCst),
        1,
        "foreign listener must be stopped"
    );
    assert_eq!(
        io.spawns.load(Ordering::SeqCst),
        2,
        "identity failure must run normal search"
    );
    assert_eq!(
        io.searches.lock().unwrap().as_slice(),
        &[Some(result)],
        "normal search result must be returned"
    );
    assert_ne!(
        gap.configured, gap.port,
        "fixture search and held ports must differ"
    );
    assert_eq!(
        result, gap.configured,
        "search selected the configured port"
    );
    assert_ne!(
        result, gap.port,
        "fallback must not simply retry the held port"
    );
    assert_eq!(health(result).await.unwrap()["instanceId"], io.own_id);
    io.stop();
    port.close().await;
}
async fn changed(change_bind: bool) {
    let Some(mut rig) = Rig::new(false).await else {
        return;
    };
    let gap = gap(&mut rig, "127.0.0.1").await;
    let port = RealPort::new(&[&rig.hosts[gap.host]], 0);
    let io = E2eBootIo::new(&rig, port.clone());
    let configured = if change_bind {
        gap.configured
    } else {
        free_port("127.0.0.1")
    };
    let cfg = rig.config(
        configured,
        if change_bind { "0.0.0.0" } else { "127.0.0.1" },
    );
    // Production releases inside prepare_reclaim: probe from the wire ACK, concurrently, so a
    // listener that outlives the ACK cannot hide behind the rest of preparation.
    let (prepared, ()) = tokio::join!(prepare_reclaim(&io, io.inputs(cfg)), async {
        let acked = port.release_ack(Duration::from_secs(20)).await;
        refuses(gap.port, "127.0.0.1", acked + STOP_BOUND).await;
    });
    assert!(matches!(prepared.decision(), Decision::Changed(_)));
    assert!(prepared.reserved().is_empty());
    io.completed().await;
    assert_eq!(
        start_mcp(prepared, rig.api_port, &io).await,
        Some(configured)
    );
    assert_eq!(health(configured).await.unwrap()["instanceId"], io.own_id);
    io.stop();
    port.close().await;
}
#[tokio::test]
async fn changed_configured_port_releases_holder() {
    changed(false).await;
}
#[tokio::test]
async fn changed_bind_host_releases_holder() {
    changed(true).await;
}
