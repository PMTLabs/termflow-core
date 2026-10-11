//! Plan 057 Layer A: real detached hosts + real source sidecars; production 055/056 code.
#[path = "mcp_hold_e2e/handover_tests.rs"]
mod handover;
#[path = "mcp_hold_e2e/hosts_tests.rs"]
mod hosts;
#[path = "mcp_hold_e2e/ports_tests.rs"]
mod ports;
#[path = "mcp_hold_e2e/reclaim_tests.rs"]
mod reclaim;
#[path = "mcp_hold_e2e/rig_tests.rs"]
mod rig;
use super::host_adoption::AdoptionPort;
use super::mcp_reclaim::{prepare_reclaim, start_mcp, BootInputs, Decision, McpBootIo};
use super::{Barrier, FrozenHost, HostTable, McpLaunch, McpReclaim};
use crate::app_config::NetworkConfig;
use crate::elevated_host::{FrozenId, HostChannel};
use crate::pty_host_client::{McpClaimOutcome, PtyHostClient};
use ports::*;
use rig::*;
use serde_json::{json, Value};
use std::time::Duration;
use termflow_pty_protocol::{ArmDetachPurpose, McpHoldReason, SpawnSpec};
use tokio::time::Instant;
const STOP_BOUND: Duration = Duration::from_secs(1);

async fn shell(client: &PtyHostClient, session_key: &str) -> u32 {
    let spec = SpawnSpec {
        shell: if cfg!(windows) { "cmd.exe" } else { "/bin/sh" }.into(),
        args: if cfg!(windows) {
            vec!["/D".into(), "/Q".into()]
        } else {
            vec!["-i".into()]
        },
        env: vec![],
        env_remove: vec![],
        cwd: None,
        cols: 80,
        rows: 24,
        initial_cursor_row: None,
    };
    client.spawn_session(session_key, &spec).await.unwrap()
}
async fn shell_usable(client: &PtyHostClient, session_key: &str) {
    let output = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let captured = output.clone();
    let wanted = session_key.to_owned();
    client.observe_stdout(move |key, bytes| {
        if key == wanted {
            captured.lock().unwrap().extend_from_slice(bytes);
        }
    });
    client.attach(session_key, 0);
    let input: &[u8] = if cfg!(windows) {
        b"set /a 4000+2\r\n"
    } else {
        b"echo $((4000+2))\n"
    };
    assert!(client.write_stdin(session_key, input));
    let until = Instant::now() + Duration::from_secs(5);
    while !String::from_utf8_lossy(&output.lock().unwrap()).contains("4002") {
        assert!(
            Instant::now() < until,
            "original shell did not compute probe result"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}
async fn same_shell(client: &PtyHostClient, key: &str, pid: u32) {
    let listed = client.list_sessions().await.unwrap();
    assert!(
        listed
            .iter()
            .any(|s| s.tab_id == key && s.pid == pid && s.alive),
        "original shell identity missing: {listed:?}"
    );
}
