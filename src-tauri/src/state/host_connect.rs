//! Connecting to a pty-host that is already running.
//!
//! `connect_or_spawn` is for the current generation's host: when nothing answers
//! it starts one. Doing that for an older host would put a new-build host on the
//! older endpoint, so a surviving host is only ever connected to, never started.

use crate::pty_host_client::{PtyHostClient, PtyHostDeps};
use std::time::Duration;

/// How long to keep retrying a host whose advertised process is alive: between
/// accepting one connection and the next a host briefly has no free instance.
pub(super) const GRACE_LIVE_HOST: Duration = Duration::from_secs(10);
/// How long to retry an endpoint that merely exists.
pub(super) const GRACE_ENDPOINT_ONLY: Duration = Duration::from_secs(2);
const RETRY_STEP: Duration = Duration::from_millis(200);

/// Did this connect fail because nothing listens on the endpoint at all (no such
/// socket file or pipe, connection refused), rather than because the host is busy
/// or slow? Only the former says the host behind it is gone.
pub(super) fn endpoint_is_gone(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
    )
}

#[cfg(windows)]
pub(super) async fn connect_existing(
    endpoint: &str,
    grace: Duration,
    deps: PtyHostDeps,
) -> std::io::Result<PtyHostClient> {
    use crate::pty_host_client::wire_pipe_client;
    use tokio::net::windows::named_pipe::ClientOptions;
    let start = tokio::time::Instant::now();
    loop {
        match ClientOptions::new().open(endpoint) {
            Ok(conn) => {
                return Ok(wire_pipe_client(conn, deps));
            }
            Err(e) if start.elapsed() >= grace => return Err(e),
            Err(_) => tokio::time::sleep(RETRY_STEP).await,
        }
    }
}

#[cfg(unix)]
pub(super) async fn connect_existing(
    endpoint: &str,
    grace: Duration,
    deps: PtyHostDeps,
) -> std::io::Result<PtyHostClient> {
    use crate::pty_host_client::wire_client;
    use tokio::net::UnixStream;
    let start = tokio::time::Instant::now();
    loop {
        match UnixStream::connect(endpoint).await {
            Ok(conn) => {
                let (rd, wr) = tokio::io::split(conn);
                return Ok(wire_client(rd, wr, deps));
            }
            Err(e) if start.elapsed() >= grace => return Err(e),
            Err(_) => tokio::time::sleep(RETRY_STEP).await,
        }
    }
}

#[cfg(not(any(windows, unix)))]
pub(super) async fn connect_existing(
    _endpoint: &str,
    _grace: Duration,
    _deps: PtyHostDeps,
) -> std::io::Result<PtyHostClient> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "pty-host sidecar is unsupported on this target",
    ))
}

#[cfg(test)]
mod connect_tests;
