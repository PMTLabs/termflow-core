use super::super::host_adoption::adopt_survivors;
use super::super::host_lifecycle::begin_offload;
use super::super::mcp_handover::{handover, HandoverInputs, SentState};
use super::*;

pub(super) struct Gap {
    pub port: u16,
    pub configured: u16,
    pub agent: Agent,
    pub session_key: String,
    pub pid: u32,
    pub host: usize,
    pub init: String,
    pub tools: String,
}
/// Runs the real exit handover; every host connection is explicitly closed before absence.
pub(super) async fn gap(rig: &mut Rig, bind: &str) -> Gap {
    let host = rig.host();
    let client = rig.hosts[host].connect().await;
    let session_key = format!("shell-{}", uuid::Uuid::new_v4());
    let pid = shell(&client, &session_key).await;
    let mut port = free_port(bind);
    // Effective-port fallback provenance: boot must compare configured, not effective.
    let configured = free_port(bind);
    let mut sidecar = rig.sidecar(port, bind, "before-057").await;
    port = sidecar.port;
    let mut agent = Agent::new(port, Some(&rig.bearer));
    let init = agent.initialize().await.result_bytes().to_owned();
    let tools = agent
        .post("tools/list", json!({}))
        .await
        .unwrap()
        .result_bytes()
        .to_owned();
    assert!(
        agent.call().await.unwrap().text().contains(&rig.marker),
        "sidecar must reach real backend"
    );
    let mut old_sse = agent.sse().await;
    assert!(client.mcp_hold(), "record advertised CAP_MCP_HOLD");
    let exit_port = RealPort::new(&[&rig.hosts[host]], 0);
    assert!(exit_port.table().publish(HostChannel::Primary, 0));
    client.bind_sessions(exit_port.table().keys(), HostChannel::Primary, 0);
    exit_port.publish_current(&client).unwrap();
    adopt_survivors(&exit_port).await.unwrap();
    let mut hold = begin_offload(&exit_port).await.unwrap();
    hold.arm_detach(600, &rig.token, Some(ArmDetachPurpose::Local))
        .await
        .expect("survivability arm must be acknowledged");
    let acked = hold.acked_hosts(); // The real owned list, not a hand-filtered choice.
    let mut sent = SentState::None;
    let selected = handover(
        &acked,
        HandoverInputs {
            launch: Some(McpLaunch {
                port,
                bind_host: bind.into(),
                auth_token: Some(rig.bearer.clone()),
            }),
            configured_port: configured,
        },
        McpHoldReason::Offload,
        &rig.token,
        &mut sent,
    )
    .await
    .expect("production handover accepted");
    assert_eq!(sent, SentState::Accepted);
    hold.commit();
    // Active agent POST traffic throughout shutdown; record drain replies and every refusal.
    let polling_agent = agent.clone();
    let traffic = tokio::spawn(async move {
        let mut refusals = vec![];
        let mut drains = 0;
        loop {
            match polling_agent.call().await {
                Ok(r) if r.value["result"]["isError"] == true => {
                    if r.text().contains("Offload & Close,") {
                        return (Instant::now(), refusals, drains, r);
                    }
                    drains += 1;
                }
                Ok(_) => {}
                Err(e) => {
                    eprintln!("transition refusal: {e}");
                    refusals.push(Instant::now());
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    });
    sidecar.shutdown();
    assert!(client.close_transport().await);
    assert!(selected.close_transport().await);
    for h in &acked {
        assert!(h.client.close_transport().await);
    }
    drop(selected);
    drop(acked);
    drop(client);
    assert!(
        sidecar.child.wait(Duration::from_secs(5)).await,
        "old sidecar exited"
    );
    let exited = Instant::now();
    let (answered, refusals, drains, reply) = tokio::time::timeout(Duration::from_secs(3), traffic)
        .await
        .expect("holder takeover within two seconds")
        .unwrap();
    let gap = answered.saturating_duration_since(exited);
    assert!(gap <= Duration::from_secs(2));
    if let Some(first) = refusals.first() {
        assert!(
            answered.duration_since(*first) <= Duration::from_secs(1),
            "recovered within first client retry"
        );
    }
    eprintln!(
        "MEASURE bind={bind} first-answer-after-exit={gap:?} refusals={} drains={drains}",
        refusals.len()
    );
    assert_eq!(reply.status, 200);
    // Live real-holder negative control for the exact bind-host rebind oracle.
    assert!(
        std::net::TcpListener::bind((bind, port)).is_err(),
        "exact bind-host probe must detect the live holder"
    );
    for text in [
        "restarting",
        "ago",
        "terminals are still running",
        "Wait",
        "retry",
    ] {
        assert!(reply.text().contains(text), "missing wait wording: {text}");
    }
    old_sse.eof(Duration::from_secs(2)).await;
    Gap {
        port,
        configured,
        agent,
        session_key,
        pid,
        host,
        init,
        tools,
    }
}

pub(super) async fn holder_oracles(rig: &Rig, gap: &Gap) {
    let mut stream = gap.agent.sse().await;
    stream.contains(": ping", Duration::from_secs(6)).await;
    let ping = gap.agent.post("ping", json!({})).await.unwrap();
    assert_eq!(ping.value["result"], json!({}));
    let mut fresh = Agent::new(gap.port, Some(&rig.bearer));
    assert_eq!(
        fresh.initialize().await.result_bytes(),
        gap.init,
        "initialize bytes must be verbatim"
    );
    assert_eq!(
        fresh
            .post("tools/list", json!({}))
            .await
            .unwrap()
            .result_bytes(),
        gap.tools,
        "tools/list bytes must be verbatim"
    );
    assert_eq!(fresh.call().await.unwrap().value["result"]["isError"], true);
    for (token, status) in [
        (None, 401),
        (Some("wrong-057"), 401),
        (Some(rig.bearer.as_str()), 200),
    ] {
        let mut a = Agent::new(gap.port, token);
        a.session = gap.agent.session.clone();
        assert_eq!(
            a.call().await.unwrap().status,
            status,
            "bearer enforced by real holder"
        );
    }
    let log = std::fs::read_to_string(&rig.hosts[gap.host].log).unwrap();
    for marker in ["[MCP-HOLD]", "holder started"] {
        assert!(
            log.contains(marker),
            "real lifecycle log must contain {marker} (raw log omitted)"
        );
    }
    assert!(!log.contains(&rig.bearer), "bearer never logged");
    assert!(!log.contains(&rig.token), "host token never logged");
}

#[tokio::test]
async fn smoke_real_host_and_sidecar() {
    let Some(mut rig) = Rig::new(false).await else {
        return;
    };
    let h = rig.host();
    let client = rig.hosts[h].connect().await;
    let session_key = "smoke";
    shell(&client, session_key).await;
    client
        .arm_detach(600, &rig.token, Some(ArmDetachPurpose::Local))
        .await
        .unwrap();
    let port = free_port("127.0.0.1");
    let mut sidecar = rig.sidecar(port, "127.0.0.1", "smoke-057").await;
    let mut agent = Agent::new(sidecar.port, Some(&rig.bearer));
    agent.initialize().await;
    assert!(agent.call().await.unwrap().text().contains(&rig.marker));
    sidecar.shutdown();
    assert!(sidecar.child.wait(Duration::from_secs(5)).await);
    assert!(client.disarm().await);
    client.close(session_key);
    assert!(client.list_sessions().await.unwrap().is_empty());
    assert!(client.close_transport().await);
}
