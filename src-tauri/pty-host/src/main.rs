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
    // so the GUI's arm can fail rather than silently lose sessions.
    if let Err(e) = detach::assert_survivable() {
        eprintln!("termflow-pty-host: WARNING: {e}");
    }

    let endpoint = resolve_endpoint();
    let token = std::env::var("TERMFLOW_PTY_TOKEN").ok();

    if let Err(e) = transport::serve(endpoint, token).await {
        eprintln!("termflow-pty-host: serve ended: {e}");
    }
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
