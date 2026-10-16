//! Dial-out transport mode for the elevated sidecar (plan 045, updated plan 058).
//!
//! In every other mode this process is the pipe SERVER (`Listener::bind` /
//! `accept`). When launched with `--connect-pipe`, that direction is
//! reversed: the GUI already created and owns the listener, and this process
//! DIALS OUT to it as a client.
//!
//! Under plan 058 (Review 326):
//! - The elevated host supports `ArmDetach`, enabling offload and update survival.
//! - When disconnected after an ARMED offload, it enters a bounded Hold state (900 seconds of
//!   active time). A disconnect that was never armed (the GUI crashed or was killed) does not
//!   hold: the sessions are torn down and the host exits, since nothing is waiting to reconnect.
//! - During Hold, it binds a High-Integrity rendezvous pipe:
//!   `\\.\pipe\termflow-admin-rendezvous.<user-sid>.<host-pid>.<nonce>`
//!   (the nonce is chosen when the Hold begins; the pipe is created, by `Listener::bind`,
//!   before the name is published in the survivor record, so no one can claim it first)
//!   secured with SDDL `O:{sid}D:P(A;;GA;;;{sid})S:(ML;;NWNR;;;HI)`. The name is not a secret
//!   from this user's other processes, which can read the record: between two connections a
//!   same-user process can take the name and deny reconnects until the hold ends, but it cannot
//!   obtain a token (the reconnect helper checks the server's pid first).
//!   Holding requires an elevated token: with anything less the host tears down instead.
//! - It publishes an elevated survivor record to the update-stable path.
//! - Upon UAC reconnection, the High helper verifies server identity and sends
//!   a rendezvous request with target pipe, GUI pid, and fresh token.
//! - The held host verifies the target pipe is local, dials down to the GUI pipe,
//!   authenticates the GUI server process identity, and resumes session servicing.

use super::{ActiveClock, deadline_expired, run_connection, Endpoint, HoldDeadline, Listener, PendingDeadline, SystemActiveClock, CHAN_CAP};
use crate::manager::{Disposition, SessionManager};
use std::time::{Duration, Instant};
use termflow_pty_protocol::{
    read_rendezvous_request, write_rendezvous_response, Data,
    ElevatedRendezvousResponse, ElevatedRendezvousStatus, Response, ELEVATED_RENDEZVOUS_VERSION,
};

/// Total time budget to establish the dial-out connection, from the moment
/// dialing starts.
const CONNECT_WATCHDOG_BUDGET: Duration = Duration::from_secs(30);
const CONNECT_RETRY_INTERVAL: Duration = Duration::from_millis(100);

/// Check if a pipe path is strictly a local named pipe (no UNC remote host or directory traversal).
fn is_local_named_pipe(pipe: &str) -> bool {
    let prefix = r"\\.\pipe\";
    if !pipe.starts_with(prefix) {
        return false;
    }
    let rest = &pipe[prefix.len()..];
    !rest.is_empty() && !rest.contains('\\') && !rest.contains('/') && !rest.contains("..")
}

/// Dial the GUI-hosted pipe as a client, verifying server PID if specified.
async fn dial_and_verify(endpoint: &Endpoint, expected_server_pid: Option<u32>) -> std::io::Result<super::ClientStream> {
    let deadline = Instant::now() + CONNECT_WATCHDOG_BUDGET;
    loop {
        match super::connect(endpoint).await {
            Ok(stream) => {
                if let Some(expected) = expected_server_pid {
                    use std::os::windows::io::AsRawHandle;
                    let handle = stream.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE;
                    extern "system" {
                        fn GetNamedPipeServerProcessId(
                            pipe: windows_sys::Win32::Foundation::HANDLE,
                            server_process_id: *mut u32,
                        ) -> windows_sys::Win32::Foundation::BOOL;
                    }
                    let mut server_pid = 0u32;
                    let ok = unsafe { GetNamedPipeServerProcessId(handle, &mut server_pid) };
                    if ok == 0 || server_pid != expected {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::PermissionDenied,
                            format!("server pid mismatch: expected {expected}, got {server_pid}"),
                        ));
                    }
                }
                return Ok(stream);
            }
            Err(e) if Instant::now() >= deadline => return Err(e),
            Err(_) => tokio::time::sleep(CONNECT_RETRY_INTERVAL).await,
        }
    }
}

/// Query this process's creation time for the survivor record identity.
fn current_process_creation_time() -> u64 {
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    extern "system" {
        fn GetProcessTimes(
            hprocess: HANDLE,
            lpcreationtime: *mut windows_sys::Win32::Foundation::FILETIME,
            lpexittime: *mut windows_sys::Win32::Foundation::FILETIME,
            lpkerneltime: *mut windows_sys::Win32::Foundation::FILETIME,
            lpusertime: *mut windows_sys::Win32::Foundation::FILETIME,
        ) -> windows_sys::Win32::Foundation::BOOL;
    }
    unsafe {
        let mut creation = std::mem::zeroed();
        let mut exit = std::mem::zeroed();
        let mut kernel = std::mem::zeroed();
        let mut user = std::mem::zeroed();
        if GetProcessTimes(GetCurrentProcess(), &mut creation, &mut exit, &mut kernel, &mut user) != 0 {
            ((creation.dwHighDateTime as u64) << 32) | (creation.dwLowDateTime as u64)
        } else {
            0
        }
    }
}

/// 128 bits that another process cannot predict: each `RandomState` is keyed from the OS RNG, so
/// the digest of a fresh one is unknown to anyone who cannot read this process's memory.
fn unpredictable_nonce() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::with_capacity(32);
    for round in 0u32..2 {
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u32(std::process::id());
        hasher.write_u32(round);
        out.push_str(&format!("{:016x}", hasher.finish()));
    }
    out
}

fn host_instance_id() -> u128 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    ((std::process::id() as u128) << 96) | (nanos & ((1u128 << 96) - 1))
}

fn elevated_caps(inherit_cursor: bool) -> u32 {
    termflow_pty_protocol::CAP_ATTACH_ACK
        | termflow_pty_protocol::CAP_LIFECYCLE_CONTRACT
        | termflow_pty_protocol::CAP_SHUTDOWN_CONTROL
        | if inherit_cursor { termflow_pty_protocol::CAP_INHERIT_CURSOR } else { 0 }
}

struct ReconnectInfo {
    gui_pid: u32,
    target_pipe: String,
    auth_token: String,
    deadline: Option<PendingDeadline>,
}

enum RendezvousWaitResult {
    Reconnected(ReconnectInfo),
    Empty,
    Expired(crate::manager::LocalHold),
    StandDown,
}

/// Await a connection on the High rendezvous pipe, enforcing active-time deadline.
async fn wait_for_rendezvous(
    listener: &mut Listener,
    mgr: &SessionManager,
    stand_down_path: Option<&std::path::Path>,
    instance_id: u128,
    mut deadline: Option<PendingDeadline>,
    clock: &SystemActiveClock,
) -> RendezvousWaitResult {
    const RECHECK: Duration = Duration::from_millis(250);
    loop {
        if stand_down_path.is_some_and(|path| {
            termflow_pty_protocol::read_elevated_stand_down(path) == Some(instance_id)
        }) {
            return RendezvousWaitResult::StandDown;
        }
        if mgr.live_session_count() == 0 {
            return RendezvousWaitResult::Empty;
        }
        if let Some(hold) = deadline_expired(mgr, &mut deadline, clock) {
            return RendezvousWaitResult::Expired(hold);
        }

        tokio::select! {
            r = listener.accept() => match r {
                Ok(mut stream) => {
                    match read_rendezvous_request(&mut stream).await {
                        Ok(req) => {
                            if req.version != ELEVATED_RENDEZVOUS_VERSION {
                                let resp = ElevatedRendezvousResponse {
                                    status: ElevatedRendezvousStatus::Rejected(format!("unsupported version {}", req.version)),
                                    capabilities: elevated_caps(false),
                                    protocol_version: termflow_pty_protocol::PROTOCOL_VERSION,
                                };
                                let _ = write_rendezvous_response(&mut stream, &resp).await;
                                continue;
                            }
                            if !is_local_named_pipe(&req.target_pipe) {
                                let resp = ElevatedRendezvousResponse {
                                    status: ElevatedRendezvousStatus::Rejected("target pipe must be a local named pipe".into()),
                                    capabilities: elevated_caps(false),
                                    protocol_version: termflow_pty_protocol::PROTOCOL_VERSION,
                                };
                                let _ = write_rendezvous_response(&mut stream, &resp).await;
                                continue;
                            }

                            let resp = ElevatedRendezvousResponse {
                                status: ElevatedRendezvousStatus::Ok,
                                capabilities: elevated_caps(termflow_pty_protocol::da1::inherit_cursor_supported()),
                                protocol_version: termflow_pty_protocol::PROTOCOL_VERSION,
                            };
                            if write_rendezvous_response(&mut stream, &resp).await.is_err() {
                                continue;
                            }

                            return RendezvousWaitResult::Reconnected(ReconnectInfo {
                                gui_pid: req.gui_pid,
                                target_pipe: req.target_pipe,
                                auth_token: req.auth_token,
                                deadline,
                            });
                        }
                        Err(e) => {
                            log::warn!("rendezvous request read error: {e}");
                            continue;
                        }
                    }
                }
                Err(_) => {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    continue;
                }
            },
            _ = tokio::time::sleep(RECHECK) => continue,
        }
    }
}

/// Run the dial-out mode: connect, serve the connection, and support bounded
/// hold across offload and update if armed.
pub async fn serve_dial(
    endpoint: Endpoint,
    token: Option<String>,
    survivor_record: Option<std::path::PathBuf>,
) -> std::io::Result<()> {
    let (events_tx, mut events_rx) = tokio::sync::mpsc::channel::<Data>(CHAN_CAP);
    let (resp_tx, mut resp_rx) = tokio::sync::mpsc::channel::<Response>(CHAN_CAP);
    let survivable = cfg!(test) || crate::detach::assert_survivable().is_ok();
    let mut mgr = SessionManager::new(events_tx.clone(), resp_tx.clone(), token, survivable);
    let clock = SystemActiveClock::new();

    let mut stream = dial_and_verify(&endpoint, None).await?;
    let mut pending_deadline: Option<PendingDeadline> = None;

    loop {
        let (erx, rrx, connection) =
            run_connection(&mut mgr, stream, events_rx, resp_rx, pending_deadline, &clock).await;
        events_rx = erx;
        resp_rx = rrx;

        if let super::ConnectionResult::Expired(hold) = connection {
            mgr.expire_local_hold(hold);
            return Ok(());
        }

        let armed = mgr.is_armed();
        match mgr.on_gui_disconnect() {
            Disposition::TearDown => return Ok(()),
            Disposition::Hold if !armed => {
                // Never armed: the GUI went away without handing these sessions to anyone.
                // `on_gui_disconnect` only parked them, and this process is about to exit, so end
                // them here rather than leave children to a kill thread that dies with us.
                log::warn!("elevated host: GUI disconnected without an arm; tearing down");
                mgr.tear_down_sessions();
                return Ok(());
            }
            Disposition::Hold => {
                while events_rx.try_recv().is_ok() {}
                while resp_rx.try_recv().is_ok() {}

                let deadline = mgr.begin_local_absence().map(|hold| match clock.now() {
                    Some(now) => PendingDeadline::Established(HoldDeadline {
                        hold,
                        at: now + Duration::from_secs(termflow_pty_protocol::LOCAL_HOLD_ACTIVE_SECS),
                    }),
                    None => PendingDeadline::AwaitingClock(hold),
                });

                // Fail closed. The mandatory label on the rendezvous pipe is chosen from this
                // process's token; if it is not elevated the pipe would be Medium-labelled and any
                // same-user process could talk to a privileged host.
                if !cfg!(test) && !super::pipe_windows::is_elevated() {
                    log::error!("elevated host: token is not elevated; refusing to hold, tearing down");
                    mgr.tear_down_sessions();
                    return Ok(());
                }
                let sid = match super::pipe_windows::current_user_sid_string() {
                    Some(sid) => sid,
                    None => {
                        log::error!("cannot resolve user SID for elevated rendezvous pipe; tearing down");
                        mgr.tear_down_sessions();
                        return Ok(());
                    }
                };
                let pid = std::process::id();
                let rendezvous_name =
                    termflow_pty_protocol::rendezvous_pipe_name(&sid, pid, &unpredictable_nonce());
                let mut rendezvous_listener = match Listener::bind(&Endpoint(rendezvous_name.clone())) {
                    Ok(l) => l,
                    Err(e) => {
                        log::error!("cannot bind rendezvous listener {rendezvous_name}: {e}; tearing down");
                        mgr.tear_down_sessions();
                        return Ok(());
                    }
                };

                let instance_id = host_instance_id();
                let stand_down_path = survivor_record
                    .as_deref()
                    .and_then(termflow_pty_protocol::elevated_stand_down_path_for_survivor);
                let remove_record = || {
                    if let Some(record_path) = &survivor_record {
                        let _ = termflow_pty_protocol::remove_elevated_survivor_if_owned(record_path, instance_id);
                    }
                    if let Some(path) = &stand_down_path {
                        let _ = termflow_pty_protocol::remove_elevated_stand_down_if_owned(path, instance_id);
                    }
                };
                if let Some(record_path) = &survivor_record {
                    let rec = termflow_pty_protocol::ElevatedSurvivorRecord {
                        format: 1,
                        user_sid: sid.clone(),
                        host_pid: pid,
                        host_creation_time: current_process_creation_time(),
                        instance_id,
                        rendezvous_pipe: rendezvous_name.clone(),
                        proto_min: termflow_pty_protocol::PROTOCOL_MIN,
                        proto_max: termflow_pty_protocol::PROTOCOL_MAX,
                        capabilities: elevated_caps(termflow_pty_protocol::da1::inherit_cursor_supported()),
                    };
                    let _ = termflow_pty_protocol::publish_elevated_survivor(record_path, &rec);
                }

                // Stay reachable until the deadline: one failed reconnect attempt (the GUI pipe
                // went away, a stray request) must not end a host that is still holding sessions.
                let wait_deadline = deadline;
                let reconnected = loop {
                    match wait_for_rendezvous(
                        &mut rendezvous_listener,
                        &mgr,
                        stand_down_path.as_deref(),
                        instance_id,
                        wait_deadline,
                        &clock,
                    )
                    .await
                    {
                        RendezvousWaitResult::Reconnected(info) => {
                            match dial_and_verify(&Endpoint(info.target_pipe), Some(info.gui_pid)).await {
                                Ok(new_stream) => {
                                    // Only a reconnect that was verified changes what the host
                                    // expects or how long it holds.
                                    mgr.update_expected_token(info.auth_token);
                                    break Some((new_stream, info.deadline));
                                }
                                Err(e) => {
                                    log::error!("failed to dial reconnecting GUI pipe: {e}; still holding");
                                    continue;
                                }
                            }
                        }
                        RendezvousWaitResult::Empty => break None,
                        RendezvousWaitResult::StandDown => {
                            log::info!("elevated host: received stand-down for this survivor; tearing down");
                            mgr.tear_down_sessions();
                            break None;
                        }
                        RendezvousWaitResult::Expired(hold) => {
                            log::warn!("elevated host: hold expired waiting for rendezvous; tearing down");
                            mgr.expire_local_hold(hold);
                            break None;
                        }
                    }
                };

                drop(rendezvous_listener);
                remove_record();
                match reconnected {
                    Some((new_stream, resumed_deadline)) => {
                        stream = new_stream;
                        pending_deadline = resumed_deadline;
                        continue;
                    }
                    None => return Ok(()),
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "dial_tests.rs"]
mod dial_tests;
