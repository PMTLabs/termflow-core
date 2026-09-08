use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde_json::json;
use crate::state::AppState;

/// How long a sibling holds its detach window after being armed for our update.
///
/// Matches the value `update_and_restart` arms ITSELF with. A shorter window
/// would expire while the apply is still running and lose the very shells this
/// exists to save.
pub(crate) const SIBLING_ARM_SECS: u64 = 600;

/// Arm this instance's pty-host so its shells survive a sibling's update.
///
/// Called BY another instance, not by this one's UI. Velopack's apply kills our
/// GUI along with the updating instance; arming is what lets our shells outlive
/// it and reattach on the next launch (design 014 §B1).
///
/// Idempotent: a duplicate arm re-arms the same window, which is harmless and
/// keeps the caller's retry logic simple.
pub(crate) async fn hotswap_arm(State(state): State<AppState>) -> impl IntoResponse {
    let Some(client) = state.pty_host_clone() else {
        // No host means no shells to save; say so rather than claiming success,
        // so the caller can tell "prepared" from "nothing to prepare".
        return (StatusCode::SERVICE_UNAVAILABLE, "pty-host not connected").into_response();
    };
    let token = crate::pty_host_client::resolve_token();
    match client.arm_detach(SIBLING_ARM_SECS, &token, None).await {
        Ok(_) => {
            log::info!("[HOTSWAP] armed at a sibling's request ({SIBLING_ARM_SECS}s)");
            (StatusCode::OK, "armed").into_response()
        }
        Err(e) => {
            log::warn!("[HOTSWAP] refused a sibling's arm request: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, e).into_response()
        }
    }
}

/// Release a detach window armed by `hotswap_arm`.
///
/// The other half of the obligation: an update that arms siblings and then FAILS
/// must put them back, or every sibling holds a 600s window it never asked for.
/// Idempotent — disarming an unarmed host is a no-op.
pub(crate) async fn hotswap_disarm(State(state): State<AppState>) -> impl IntoResponse {
    let Some(client) = state.pty_host_clone() else {
        return (StatusCode::OK, "nothing to disarm").into_response();
    };
    // Report the sidecar's actual answer. `disarm_siblings` logs a non-2xx as
    // "its window will expire" — answering 200 unconditionally made that
    // diagnostic unreachable, so a sibling still holding an armed 600s window
    // looked exactly like one that had released it.
    if client.disarm().await {
        (StatusCode::OK, "disarmed").into_response()
    } else {
        log::warn!("[HOTSWAP] sibling disarm request got no DisarmAck; still armed");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "pty-host did not acknowledge the disarm",
        )
            .into_response()
    }
}

pub(crate) async fn get_system_info() -> impl IntoResponse {
    Json(json!({
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "version": env!("CARGO_PKG_VERSION"),
        "hostname": std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_else(|_| "unknown".to_string()),
        "uptime": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }))
}

pub(crate) async fn get_system_metrics() -> impl IntoResponse {
    // Basic metrics - could be enhanced with sysinfo crate
    Json(json!({
        "timestamp": chrono::Utc::now().to_rfc3339(),
        "cpu": {
            "usage": 0.0 // Would need sysinfo crate
        },
        "memory": {
            "total": 0,
            "used": 0,
            "free": 0
        }
    }))
}

pub(crate) async fn get_active_processes(State(state): State<AppState>) -> impl IntoResponse {
    use sysinfo::System;
    // System::new_all() enumerates every OS process (50-200ms, blocking) — run
    // it on the blocking pool so it doesn't stall the async executor.
    let sys = match tokio::task::spawn_blocking(System::new_all).await {
        Ok(sys) => sys,
        Err(e) => {
            log::warn!("get_active_processes: sysinfo snapshot task failed: {}", e);
            return Json(json!({ "processes": [], "count": 0 }));
        }
    };

    let processes: Vec<_> = state.terminals.iter().map(|entry| {
        let t = entry.value();
        
        // Get the actual foreground process info using the shared system snapshot
        let (actual_pid, actual_name) = crate::pty_manager::get_foreground_process_info(t.pid, Some(&sys));
        // Friendly coding-agent label (codex/claude/gemini/...) derived from the
        // foreground process's command line, plus that process's executable path
        // (for icon extraction). Both null when no agent is recognized; agentExe
        // alone is null when the OS won't report the path.
        let (agent, agent_exe) = match crate::pty_manager::get_foreground_agent_with_exe(t.pid, &sys) {
            Some((a, exe)) => (Some(a), exe),
            None => (None, None),
        };

        json!({
            "id": t.id,
            "pid": t.pid,
            "shell": t.shell,
            "name": t.name,
            "currentApp": {
                "pid": actual_pid,
                "name": actual_name
            },
            "agent": agent,
            "agentExe": agent_exe,
            "lastInputSource": t.last_input_source,
            "lastInputAt": t.last_input_at,
            "createdAt": t.created_at,
            "isAlive": true
        })
    }).collect();
    
    Json(json!({ "processes": processes, "count": processes.len() }))
}

pub(crate) async fn get_process_metrics(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    // Normalise the caller-supplied reference to this run's map key. The API
    // reports the DURABLE tm- leaf as `terminalId`, but the per-terminal maps
    // are keyed by the per-run pc- id (design 014 A3). Without this, the
    // documented round trip - read `terminalId`, then address it - 404s.
    let id = state.resolve_ref(&id);
    // Copy the pid out so the DashMap guard drops before any await.
    let Some(pid) = state.terminals.get(&id).map(|t| t.pid) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Process not found" })));
    };

    // sysinfo enumeration is blocking — keep it off the async executor.
    let (cpu, memory) = match tokio::task::spawn_blocking(move || {
        use sysinfo::{Pid, System};
        let sys = System::new_all();
        sys.process(Pid::from(pid as usize))
            .map(|p| (p.cpu_usage(), p.memory()))
            .unwrap_or((0.0, 0))
    })
    .await
    {
        Ok(v) => v,
        Err(e) => {
            log::warn!("get_process_metrics: sysinfo task failed: {}", e);
            (0.0, 0)
        }
    };

    (StatusCode::OK, Json(json!({
        "id": id,
        "cpu": cpu,
        "memory": memory,
        "timestamp": chrono::Utc::now().to_rfc3339()
    })))
}

