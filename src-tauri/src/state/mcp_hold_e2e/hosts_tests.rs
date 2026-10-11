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
    // Both stop observations start at once, against the one Disarm-relative deadline.
    tokio::join!(
        refuses(gap.port, "127.0.0.1", disarmed + STOP_BOUND),
        stream.eof_by(disarmed + STOP_BOUND)
    );
    assert_eq!(
        client.claim_mcp(&rig.token).await.unwrap(),
        McpClaimOutcome::Held(None)
    );
    same_shell(&client, &gap.session_key, gap.pid).await;
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
    // Negative control uses the exact loopback bind host, like this holder.
    let control = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    assert!(
        std::net::TcpListener::bind(("127.0.0.1", control.local_addr().unwrap().port())).is_err()
    );
    drop(control);
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
        #[cfg(unix)]
        assert!(
            tokio::time::timeout_at(until, tokio::net::TcpStream::connect(("127.0.0.1", p)))
                .await
                .expect("rollback connect timed out: not evidence of refusal")
                .is_err(),
            "rollback left a holder"
        );
        #[cfg(windows)]
        {
            // Windows refusal delivery exceeds this window. Use the validated exact
            // loopback bind instead, dropped before every yield so it never spans a holder
            // retry interval (100 ms). A holder bind landing inside that instant is only
            // delayed to its next retry; the omitted-release mutation shows the probe still
            // catches a real would-be holder, which is evidence, not a scheduling guarantee.
            let listener = std::net::TcpListener::bind(("127.0.0.1", p))
                .expect("rollback left a conflicting listener");
            drop(listener);
        }
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
        // End only the fixture's returned shell PID, without adopting/spending the holder.
        owned_shell_exit(gap.pid).await;
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
    if empty_holder {
        // Before ReleaseMcp or any Close: this must really be a shell-less holder.
        assert!(!a.list_sessions().await.unwrap().iter().any(|s| s.alive));
        assert!(port
            .0
            .listings
            .lock()
            .unwrap()
            .iter()
            .filter(|(channel, _)| matches!(channel, HostChannel::Frozen(_)))
            .all(|(_, sessions)| !sessions.iter().any(|s| s.alive)));
    } else {
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
async fn owned_shell_exit(pid: u32) {
    let deadline = Instant::now() + Duration::from_secs(3);
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_TERMINATE,
        };
        // SYNCHRONIZE allows a PID-specific exit check on this owned process handle.
        let handle = OpenProcess(PROCESS_TERMINATE | 0x0010_0000, 0, pid);
        assert!(!handle.is_null());
        let terminated = TerminateProcess(handle, 0);
        let exited = WaitForSingleObject(
            handle,
            deadline
                .saturating_duration_since(Instant::now())
                .as_millis() as u32,
        );
        CloseHandle(handle);
        assert_ne!(terminated, 0);
        assert_eq!(exited, 0, "owned shell must exit within bound");
    }
    #[cfg(unix)]
    unsafe {
        // Interactive /bin/sh may ignore SIGTERM; SIGKILL cannot be ignored.
        assert_eq!(libc::kill(pid as libc::pid_t, libc::SIGKILL), 0);
        loop {
            if libc::kill(pid as libc::pid_t, 0) == -1 {
                assert_eq!(
                    std::io::Error::last_os_error().raw_os_error(),
                    Some(libc::ESRCH)
                );
                break;
            }
            assert!(Instant::now() < deadline, "owned shell PID still exists");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
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
    // Probe as soon as the wire ACK is observed, not after unrelated survivor work.
    let observation_deadline = Instant::now() + Duration::from_secs(20);
    let (claimed_at, held) = loop {
        let claim = port
            .0
            .claims
            .lock()
            .unwrap()
            .iter()
            .find(|(_, held)| held.is_some())
            .cloned();
        if let Some(claim) = claim {
            break claim;
        }
        assert!(
            Instant::now() < observation_deadline,
            "late non-None claim missing"
        );
        tokio::time::sleep(Duration::from_millis(1)).await;
    };
    assert_eq!(held.unwrap().port, gap.port);
    refuses(gap.port, "127.0.0.1", claimed_at + STOP_BOUND).await;
    eprintln!(
        "MEASURE late-claim ack-to-rebind={:?}",
        claimed_at.elapsed()
    );
    io.completed().await;
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
