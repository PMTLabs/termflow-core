use super::super::host_adoption::adopt_survivors;
use super::super::host_lifecycle::begin_offload;
use super::super::mcp_handover::{handover, handover_txn, Cleanup, HandoverInputs, SentState};
use super::handover::gap;
use super::*;
use std::sync::Arc;

#[tokio::test]
async fn downgrade_disarm_before_claim_stops_holder_and_preserves_shell() {
    let Some(mut rig) = Rig::new(false).await else {
        return;
    };
    let gap = gap(&mut rig, "127.0.0.1").await;
    let mut stream = gap.agent.sse().await;
    let client = rig.hosts[gap.host].connect().await;
    // Legacy shape is pinned by the real client's DisarmAck matcher, plus 054 compat oracle.
    assert!(client.disarm().await);
    let disarmed = Instant::now();
    assert_eq!(
        client.claim_mcp(&rig.token).await.unwrap(),
        McpClaimOutcome::Held(None)
    );
    same_shell(&client, &gap.session_key, gap.pid).await;
    refuses(gap.port, STOP_BOUND.saturating_sub(disarmed.elapsed())).await;
    stream
        .eof(
            STOP_BOUND
                .saturating_sub(disarmed.elapsed())
                .max(Duration::from_millis(1)),
        )
        .await;
    shell_usable(&client, &gap.session_key).await;
    client.close(&gap.session_key);
    client.list_sessions().await.unwrap();
    assert!(client.close_transport().await);
}

#[tokio::test]
async fn accepted_pending_transaction_rollback_cannot_start_a_holder() {
    let Some(mut rig) = Rig::new(false).await else {
        return;
    };
    let h = rig.host();
    let initial = rig.hosts[h].connect().await;
    let session_key = "rollback-shell";
    let pid = shell(&initial, session_key).await;
    initial
        .arm_detach(600, &rig.token, Some(ArmDetachPurpose::Local))
        .await
        .unwrap();
    // Close the armed setup connection; real adoption now owns the only connection.
    assert!(initial.close_transport().await);
    let port = RealPort::new(&[&rig.hosts[h]], 0);
    adopt_survivors(&port).await.unwrap();
    let p = free_port("127.0.0.1");
    let mut s = rig.sidecar(p, "127.0.0.1", "rollback-057").await;
    let p = s.port;
    let mut hold = begin_offload(&port).await.unwrap();
    hold.arm_detach(600, &rig.token, Some(ArmDetachPurpose::Local))
        .await
        .unwrap();
    let io = HandoverIo {
        port: port.clone(),
        lock: Arc::new(tokio::sync::Mutex::new(())),
        inputs: HandoverInputs {
            launch: Some(McpLaunch {
                port: p,
                bind_host: "127.0.0.1".into(),
                auth_token: Some(rig.bearer.clone()),
            }),
            configured_port: p,
        },
    };
    let handed = handover_txn(&io, hold, McpHoldReason::Offload).await;
    assert_eq!(handed.sent(), SentState::Accepted);
    assert_eq!(
        handed.release().await,
        (Cleanup::Released { was_holding: false }, true)
    );
    s.shutdown();
    assert!(s.child.wait(Duration::from_secs(5)).await);
    port.disconnect().await;
    // Before reconnect (which would mask a Pending cleanup bug): monitor the entire retry window.
    let until = Instant::now() + Duration::from_millis(1200);
    while Instant::now() < until {
        assert!(
            tokio::net::TcpStream::connect(("127.0.0.1", p))
                .await
                .is_err(),
            "rollback left a holder"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let client = rig.hosts[h].connect().await;
    same_shell(&client, session_key, pid).await;
    shell_usable(&client, session_key).await;
    let new_session_key = "usable";
    assert!(
        client
            .spawn_session(
                new_session_key,
                &SpawnSpec {
                    shell: if cfg!(windows) { "cmd.exe" } else { "/bin/sh" }.into(),
                    args: vec![],
                    env: vec![],
                    env_remove: vec![],
                    cwd: None,
                    cols: 80,
                    rows: 24,
                    initial_cursor_row: None
                }
            )
            .await
            .unwrap()
            > 0
    );
    client.close(new_session_key);
    client.close(session_key);
    client.list_sessions().await.unwrap();
    assert!(client.close_transport().await);
}

async fn generations(empty_holder: bool) {
    let Some(mut rig) = Rig::new(false).await else {
        return;
    };
    // A is CURRENT at the handover. B does not exist yet: choose_holder is not hand-filtered.
    let gap = gap(&mut rig, "127.0.0.1").await;
    if empty_holder {
        // Kill the owned shell via its input, without adopting (which would spend the holder).
        // A's shell was closed before relaunch using an owned shell process handle.
        owned_shell_exit(gap.pid);
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert!(gap
            .agent
            .call()
            .await
            .unwrap()
            .text()
            .contains("restarting"));
    }
    let b = rig.host();
    let b_client = rig.hosts[b].connect().await;
    assert!(b_client.list_sessions().await.unwrap().is_empty());
    let port = RealPort::new(&[&rig.hosts[gap.host], &rig.hosts[b]], 1);
    // An empty host cannot survive a disconnect without a holder. B is the new boot's
    // already-connected current host, while A is the survivor; don't fabricate a B linger.
    assert!(port.table().publish(HostChannel::Primary, 0));
    b_client.bind_sessions(port.table().keys(), HostChannel::Primary, 0);
    port.publish_current(&b_client).unwrap();
    let io = E2eBootIo::new(&rig, port.clone());
    let prepared = prepare_reclaim(&io, io.inputs(rig.config(gap.configured, "127.0.0.1"))).await;
    assert_eq!(prepared.decision(), &Decision::Use(gap.port));
    io.completed().await;
    assert_eq!(port.frozen_hosts().len(), 1);
    let a = port.frozen_hosts()[0].client.clone();
    assert!(matches!(
        a.claim_mcp(&rig.token).await.unwrap(),
        McpClaimOutcome::Held(Some(_))
    ));
    assert_eq!(
        port.current_client()
            .unwrap()
            .claim_mcp(&rig.token)
            .await
            .unwrap(),
        McpClaimOutcome::Held(None)
    );
    if !empty_holder {
        same_shell(&a, &gap.session_key, gap.pid).await;
    }
    assert_eq!(start_mcp(prepared, rig.api_port, &io).await, Some(gap.port));
    a.close(&gap.session_key);
    assert!(a.list_sessions().await.unwrap().is_empty());
    // Release alone did not kill A: it can still spawn/list/close a shell.
    let pid = shell(&a, "after-release").await;
    same_shell(&a, "after-release", pid).await;
    shell_usable(&a, "after-release").await;
    a.close("after-release");
    assert!(a.list_sessions().await.unwrap().is_empty());
    assert!(a.close_transport().await);
    assert!(
        rig.hosts[gap.host]
            .child
            .wait(Duration::from_secs(15))
            .await,
        "empty unarmed A exits only after transport close"
    );
    io.stop();
    port.close().await;
}
#[tokio::test]
async fn frozen_shell_less_holder_reclaimed_with_empty_current() {
    generations(true).await;
}
#[tokio::test]
async fn empty_current_does_not_hide_live_frozen_holder() {
    generations(false).await;
}

// This PID came from our owned host's Spawned reply. Never accepts arbitrary/user PIDs.
fn owned_shell_exit(pid: u32) {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, TerminateProcess, PROCESS_TERMINATE,
        };
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        assert!(!handle.is_null());
        assert_ne!(TerminateProcess(handle, 0), 0);
        CloseHandle(handle);
    }
    #[cfg(unix)]
    unsafe {
        assert_eq!(libc::kill(pid as libc::pid_t, libc::SIGTERM), 0);
    }
}

#[tokio::test]
async fn late_frozen_claim_is_released_by_registry_finalizer() {
    let Some(mut rig) = Rig::new(false).await else {
        return;
    };
    let gap = gap(&mut rig, "127.0.0.1").await;
    let b = rig.host();
    let client = rig.hosts[b].connect().await;
    let port = RealPort::new(&[&rig.hosts[gap.host], &rig.hosts[b]], 1);
    assert!(port.table().publish(HostChannel::Primary, 0));
    client.bind_sessions(port.table().keys(), HostChannel::Primary, 0);
    port.publish_current(&client).unwrap();
    *port.0.gate_endpoint.lock().unwrap() = Some(rig.hosts[gap.host].endpoint.clone());
    let io = E2eBootIo::new(&rig, port.clone());
    let prepared = prepare_reclaim(&io, io.inputs(rig.config(gap.configured, "127.0.0.1"))).await;
    assert_eq!(prepared.decision(), &Decision::NoClaim);
    assert!(
        gap.agent
            .call()
            .await
            .unwrap()
            .text()
            .contains("restarting"),
        "same holder is live at NoClaim"
    );
    port.0.late_gate.add_permits(1);
    io.completed().await;
    let (claimed_at, held) = port
        .0
        .claims
        .lock()
        .unwrap()
        .iter()
        .find(|(_, held)| held.is_some())
        .cloned()
        .expect("late non-None claim actually arrived on wire");
    assert_eq!(held.unwrap().port, gap.port);
    refuses(gap.port, STOP_BOUND.saturating_sub(claimed_at.elapsed())).await;
    eprintln!(
        "MEASURE late-claim ack-to-refusal={:?}",
        claimed_at.elapsed()
    );
    drop(prepared);
    port.close().await;
}

/// Build once: git worktree add .claude/worktrees/mcp-old-057 <PR128-merge>^1;
/// CARGO_INCREMENTAL=0 cargo build --manifest-path .claude/worktrees/mcp-old-057/src-tauri/pty-host/Cargo.toml
/// --target-dir src-tauri/target; copy the executable to src-tauri/target/debug/termflow-old-057[.exe],
/// rebuild the current host, then set TERMFLOW_E2E_OLD_HOST_BIN and run this test with --ignored.
#[tokio::test]
#[ignore = "requires explicitly built pre-PR128 host fixture"]
async fn new_app_old_host_uses_normal_search() {
    let Some(mut rig) = Rig::new(true).await else {
        return;
    };
    let h = rig.host();
    let c = rig.hosts[h].connect().await;
    shell(&c, "old-host").await;
    assert!(!c.mcp_hold(), "old host must not advertise CAP_MCP_HOLD");
    c.arm_detach(600, &rig.token, Some(ArmDetachPurpose::Local))
        .await
        .unwrap();
    let mut sent = SentState::None;
    let p = free_port("127.0.0.1");
    let result = handover(
        &[super::super::host_lifecycle::AckedHost {
            name: "old".into(),
            channel: Some(HostChannel::Primary),
            client: c.clone(),
        }],
        HandoverInputs {
            launch: Some(McpLaunch {
                port: p,
                bind_host: "127.0.0.1".into(),
                auth_token: None,
            }),
            configured_port: p,
        },
        McpHoldReason::Offload,
        &rig.token,
        &mut sent,
    )
    .await;
    assert!(result.is_none());
    assert_eq!(sent, SentState::None);
    assert!(c.close_transport().await);
    let port = RealPort::new(&[&rig.hosts[h]], 0);
    let io = E2eBootIo::new(&rig, port.clone());
    let prepared = prepare_reclaim(&io, io.inputs(rig.config(p, "127.0.0.1"))).await;
    assert_eq!(prepared.decision(), &Decision::NoClaim);
    io.completed().await;
    assert_eq!(start_mcp(prepared, rig.api_port, &io).await, Some(p));
    assert_eq!(health(p).await.unwrap()["instanceId"], io.own_id);
    io.stop();
    port.close().await;
}
