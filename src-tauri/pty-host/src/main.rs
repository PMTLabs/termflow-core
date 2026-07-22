//! `termflow-pty-host` — the detached PTY-host sidecar.
//!
//! Owns ConPTY children over a per-user Windows named pipe, keeps a bounded
//! per-session replay ring, and survives a GUI hot-swap so shells reattach.
//! See docs/plan/002 for the full design.

mod detach;
mod manager;
mod ring;
mod session;
mod transport;
mod util;

#[tokio::main]
async fn main() {
    // If we cannot outlive the GUI (Windows kill-on-close job / not a Unix
    // session leader), survival across GUI exit is not guaranteed. Log loudly
    // AND carry the verdict into the serve loop so an arm is REFUSED rather than
    // acknowledged — the GUI must not exit believing sessions will persist.
    let survivable = match detach::assert_survivable() {
        Ok(()) => true,
        Err(e) => {
            eprintln!("termflow-pty-host: WARNING: {e}");
            false
        }
    };

    let endpoint = resolve_endpoint();
    let token = std::env::var("TERMFLOW_PTY_TOKEN").ok();

    // RP-2 discovery: advertise this host (identity, protocol range, endpoint,
    // capabilities) so a freshly-launched — possibly newer — app can pick a
    // compatible codec BEFORE connecting (design 003 §10.3). The record path is
    // passed by the GUI (update-stable dir); standalone runs simply skip it.
    // A legacy host never wrote this file, so its absence ⇒ "speak v1".
    let record = std::env::var("TERMFLOW_PTY_RECORD").ok().map(|p| {
        let path = std::path::PathBuf::from(p);
        let rec = termflow_pty_protocol::HostRecord {
            format: termflow_pty_protocol::HOST_RECORD_FORMAT,
            instance_id: host_instance_id(),
            pid: std::process::id(),
            proto_min: termflow_pty_protocol::PROTOCOL_MIN,
            proto_max: termflow_pty_protocol::PROTOCOL_MAX,
            endpoint: endpoint.0.clone(),
            // Drain/takeover is NOT implemented yet — do not advertise CAP_DRAIN.
            capabilities: termflow_pty_protocol::CAP_ATTACH_ACK,
        };
        if let Err(e) = termflow_pty_protocol::write_record(&path, &rec) {
            eprintln!("termflow-pty-host: could not write discovery record: {e}");
        }
        (path, rec.instance_id)
    });

    if let Err(e) = transport::serve(endpoint, token, survivable).await {
        eprintln!("termflow-pty-host: serve ended: {e}");
    }

    // Clean shutdown: retract our advertisement (only if still ours — never
    // delete a newer host's record).
    if let Some((path, instance_id)) = record {
        let _ = termflow_pty_protocol::remove_record_if_owned(&path, instance_id);
    }
}

/// Unique-enough identity for this host process (no uuid dep in the sidecar):
/// pid in the high bits, wall-clock nanos in the low bits.
fn host_instance_id() -> u128 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    ((std::process::id() as u128) << 96) | (nanos & ((1u128 << 96) - 1))
}

/// Resolve the transport endpoint. The GUI always passes `TERMFLOW_PTY_PIPE`
/// (a pipe name on Windows, a socket path on Unix); the defaults only apply to
/// standalone/manual runs of the sidecar.
fn resolve_endpoint() -> transport::Endpoint {
    if let Ok(v) = std::env::var("TERMFLOW_PTY_PIPE") {
        return transport::Endpoint(v);
    }
    #[cfg(windows)]
    {
        transport::Endpoint(r"\\.\pipe\termflow-pty-host".to_string())
    }
    #[cfg(unix)]
    {
        transport::default_endpoint(cfg!(debug_assertions))
    }
}
