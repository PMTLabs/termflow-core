//! Dial-out transport mode for the elevated sidecar (plan 045).
//!
//! In every other mode this process is the pipe SERVER (`Listener::bind` /
//! `accept`). When launched with `--connect-pipe`, that direction is
//! reversed: the GUI already created and owns the listener, and this process
//! DIALS OUT to it as a client, then serves exactly that one connection and
//! exits. See `docs/plan/045-open-admin-tab.md` §4.1 for why: a medium-
//! integrity GUI cannot open a High-integrity pipe (`NWNR` mandatory-label
//! policy, `pipe_windows.rs`), so the elevated side must be the one that
//! reaches out, over a pipe the GUI secures instead.
//!
//! Consequences that make this mode simpler than the normal listener loop,
//! not just inverted:
//! - No Hold / reconnect semantics. `SessionManager` is constructed with
//!   `survivable: false`, which makes `ArmDetach` a rejected no-op, so
//!   `on_gui_disconnect` can only ever return `TearDown`.
//! - No discovery record. This host must never advertise itself — advertising
//!   would let `ensure_pty_host_inner` (GUI side) mistake it for the primary.
//! - Exactly one connection, ever. EOF — for any reason, including the GUI
//!   process crashing — means exit. That is the whole orphan-prevention story
//!   for the elevated process (plan 045 §4.1): nothing else has to notice.

use super::{run_connection, Endpoint, SystemActiveClock, CHAN_CAP};
use crate::manager::SessionManager;
use std::time::{Duration, Instant};
use termflow_pty_protocol::{Data, Response};

/// Total time budget to establish the dial-out connection, from the moment
/// dialing starts. Covers two things at once: the ordinary race against the
/// GUI's listener not being bound yet the instant we're launched, and the
/// "UAC was approved but the GUI died immediately after" case — after this
/// many seconds with nothing to talk to, this process has no reason to exist.
const CONNECT_WATCHDOG_BUDGET: Duration = Duration::from_secs(30);
const CONNECT_RETRY_INTERVAL: Duration = Duration::from_millis(100);

/// Dial the GUI-hosted pipe as a client, retrying while the server side is
/// not yet listening or momentarily busy accepting another instance. Any
/// error is retried blindly (mirroring the existing `connect_with_retry` test
/// helper) until the watchdog budget is spent, at which point the last error
/// is returned.
async fn dial(endpoint: &Endpoint) -> std::io::Result<super::ClientStream> {
    let deadline = Instant::now() + CONNECT_WATCHDOG_BUDGET;
    loop {
        match super::connect(endpoint).await {
            Ok(stream) => return Ok(stream),
            Err(e) if Instant::now() >= deadline => return Err(e),
            Err(_) => tokio::time::sleep(CONNECT_RETRY_INTERVAL).await,
        }
    }
}

/// Run the dial-out mode to completion: connect, serve the one connection
/// through the same frame loop the listener mode uses, then return. The
/// caller (`main`) exits the process right after — there is no loop back to
/// re-dial.
pub async fn serve_dial(endpoint: Endpoint, token: Option<String>) -> std::io::Result<()> {
    let (events_tx, events_rx) = tokio::sync::mpsc::channel::<Data>(CHAN_CAP);
    let (resp_tx, resp_rx) = tokio::sync::mpsc::channel::<Response>(CHAN_CAP);
    // `survivable: false` — see module doc: this is what makes teardown
    // unconditional below, with no Hold path to fall into.
    let mut mgr = SessionManager::new(events_tx, resp_tx, token, false);
    let clock = SystemActiveClock::new();

    let stream = dial(&endpoint).await?;
    let (_events_rx, _resp_rx, _result) =
        run_connection(&mut mgr, stream, events_rx, resp_rx, None, &clock).await;

    // Whatever ended the connection — the GUI closing it on purpose (last
    // admin tab closed) or the GUI/pipe dying unexpectedly — tear the live
    // sessions down and exit. `survivable: false` guarantees this is the only
    // reachable disposition; asserted by `dial_tests`.
    mgr.on_gui_disconnect();
    Ok(())
}

#[cfg(test)]
#[path = "dial_tests.rs"]
mod dial_tests;
