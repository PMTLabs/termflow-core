//! The elevated admin-tab feature (plan 045): a second, UAC-elevated
//! `termflow-pty-host.exe` sidecar reached over a reversed-direction pipe
//! this process hosts. See `docs/plan/045-open-admin-tab.md` for the design.
//!
//! This module owns the elevated connection's STATE (the client, the
//! launched process handle, single-flight and generation guards) and its
//! teardown. The actual connect SEQUENCE — `pipe_server::create` →
//! `launch::run_as` → `pipe_server::accept_verified` → `wire_client` — lives
//! on `AppState` (`state/terminals.rs::ensure_elevated_host_inner`),
//! mirroring where the primary sidecar's own connect sequence already lives:
//! it needs the same `PtyHostDeps` wiring (`output_tx`, cleanup closures,
//! …) that only `AppState` can build.

#[cfg(windows)]
pub mod launch;
#[cfg(windows)]
pub mod pipe_server;

use crate::pty_host_client::PtyHostClient;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

/// Returned verbatim (never wrapped in a longer message) by
/// `AppState::ensure_elevated_host` when the user denies the UAC prompt, so
/// the renderer can recognise it exactly and stay silent (plan 045 AC6) —
/// both the OS and the user already treated this as a normal choice, not an
/// error worth a toast.
pub const ADMIN_UAC_CANCELLED: &str = "ADMIN_UAC_CANCELLED";

/// Which pty-host sidecar owns a `host_terminals` entry. `Primary` is the
/// existing, always-on sidecar; `Elevated` is the UAC-elevated one this
/// feature adds. The elevated sidecar's lifetime (plan 045 §4.1) is DERIVED
/// from counting `Elevated` entries — never hand-maintained — see
/// `AppState::forget_host_terminal`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostChannel {
    Primary,
    Elevated,
}

/// Manager for the elevated sidecar's connection lifecycle: lazy connect
/// (triggers one UAC prompt), single-flight, and teardown. Lazily created
/// once per `AppState` and lives for the process's lifetime; "no elevated
/// tab open" is simply `client` being `None`, not the manager itself being
/// absent.
pub struct ElevatedHost {
    client: Mutex<Option<PtyHostClient>>,
    /// Single-flight guard so two concurrent "Open admin Tab" clicks produce
    /// exactly one UAC prompt, mirroring `AppState::pty_host_connecting`.
    pub connecting: tokio::sync::Mutex<()>,
    #[cfg(windows)]
    proc: Mutex<Option<launch::LaunchedProcess>>,
    /// Bumped on each successful connect. `on_disconnect` only acts if its
    /// generation is still current, mirroring `AppState::pty_host_gen` — a
    /// dying old client can't clobber a freshly reconnected one.
    gen: AtomicU64,
}

impl Default for ElevatedHost {
    fn default() -> Self {
        Self::new()
    }
}

impl ElevatedHost {
    pub fn new() -> Self {
        Self {
            client: Mutex::new(None),
            connecting: tokio::sync::Mutex::new(()),
            #[cfg(windows)]
            proc: Mutex::new(None),
            gen: AtomicU64::new(0),
        }
    }

    pub fn client_clone(&self) -> Option<PtyHostClient> {
        self.client
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn is_connected(&self) -> bool {
        self.client_clone().is_some_and(|c| c.is_alive())
    }

    pub fn current_gen(&self) -> u64 {
        self.gen.load(Ordering::Acquire)
    }

    pub fn bump_gen(&self) -> u64 {
        self.gen.fetch_add(1, Ordering::AcqRel) + 1
    }

    /// Publish a freshly connected client and its launched process, becoming
    /// the current connection. Mirrors the primary's own "publish, then
    /// re-check is_alive" step in `ensure_pty_host_inner`.
    #[cfg(windows)]
    pub fn publish(&self, client: PtyHostClient, proc: launch::LaunchedProcess) {
        *self.client.lock().unwrap_or_else(|e| e.into_inner()) = Some(client);
        *self.proc.lock().unwrap_or_else(|e| e.into_inner()) = Some(proc);
    }

    /// Null the client without touching the process handle — used by
    /// `on_disconnect` (the pipe already dropped; `shutdown` below still owns
    /// waiting on the process and logging).
    pub fn clear_client(&self) {
        *self.client.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    /// Tear the elevated connection down: drop every clone of the client we
    /// hold (which drops the writer task's pipe handle, EOF-ing the elevated
    /// sidecar — see `pty-host`'s `transport::dial`), then wait up to 5s for
    /// the process to exit on its own. Idempotent: safe to call when already
    /// torn down (e.g. `on_disconnect` already cleared the client).
    #[cfg(windows)]
    pub async fn shutdown(&self) {
        let client = self.client.lock().unwrap_or_else(|e| e.into_inner()).take();
        // Dropping the last clone closes the outbound channel, which ends the
        // writer task and drops its pipe handle — the EOF the elevated
        // sidecar's dial-out mode exits on (plan 045 §4.1).
        drop(client);

        let Some(proc) = self.proc.lock().unwrap_or_else(|e| e.into_inner()).take() else {
            return;
        };
        let pid = proc.pid;
        let exited = tokio::task::spawn_blocking(move || wait_for_exit(proc, 5_000))
            .await
            .unwrap_or(false);
        if exited {
            log::info!("[ADMIN] elevated pty-host (pid {pid}) exited after teardown");
        } else {
            log::warn!(
                "[ADMIN] elevated pty-host (pid {pid}) did not exit within 5s of teardown"
            );
        }
    }

    #[cfg(not(windows))]
    pub async fn shutdown(&self) {}
}

#[cfg(windows)]
fn wait_for_exit(proc: launch::LaunchedProcess, timeout_ms: u32) -> bool {
    use windows::Win32::Foundation::WAIT_OBJECT_0;
    use windows::Win32::System::Threading::WaitForSingleObject;
    // SAFETY: `proc` owns a valid process handle for the duration of this call.
    let result = unsafe { WaitForSingleObject(proc.raw_handle(), timeout_ms) };
    result == WAIT_OBJECT_0
}

/// Plan 045 T15 / R6 — the elevated-host-crash policy, decided and pinned
/// here rather than left to whatever `on_disconnect` happens to do:
///
/// **An elevated host that dies mid-session is never reconnected to, and
/// never auto-relaunched.** The primary sidecar's `reconnect_after_pipe_drop`
/// (`state/terminals.rs`) exists because a surviving, still-advertised host
/// can be reattached to; a dead elevated host cannot — there is nothing to
/// reattach to, and "recovering" it would mean a fresh UAC prompt the user
/// never asked for, fired from a background disconnect handler with no user
/// gesture behind it. So every terminal still registered as `Elevated` when
/// the connection drops ends exactly like an ordinary pty exit (the same
/// `teardown_host_terminal` an API/UI close uses): the pane shows "session
/// ended", scrollback is preserved, and the NEXT "Open admin Tab" click
/// starts a brand-new consent cycle. Implemented in
/// `AppState::ensure_elevated_host_inner`'s `on_disconnect` closure
/// (Windows-only — see `state/terminals.rs`), generation-guarded the same
/// way the primary's own reconnect handler is, so a stale disconnect from an
/// already-superseded connection can't tear down a freshly opened one.
#[cfg(test)]
mod crash_tests {
    /// `on_disconnect`'s own closure body, extracted by brace-counting from
    /// its `Arc::new(move || {` opening — not a fixed line window, which
    /// would silently start matching the rest of the function once the
    /// closure grew or shrank.
    fn on_disconnect_body() -> String {
        let src = include_str!("../state/terminals.rs").replace("\r\n", "\n");
        let fn_at = src
            .find("async fn ensure_elevated_host_inner(&self)")
            .expect("ensure_elevated_host_inner not found — it moved or was renamed");
        // The Windows arm is the first (and only real) definition reached from
        // its own signature; the `#[cfg(not(windows))]` stub is a one-line
        // `Err(...)` with no `on_disconnect` at all, so searching forward from
        // here cannot cross into it.
        let rest = &src[fn_at..];
        let at = rest
            .find("on_disconnect: Arc::new(move || {")
            .expect("on_disconnect closure not found in ensure_elevated_host_inner");
        let open = at + rest[at..].find('{').expect("no `{` after on_disconnect");
        let mut depth = 0i32;
        for (i, c) in rest[open..].char_indices() {
            match c {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return rest[open..open + i + 1].to_string();
                    }
                }
                _ => {}
            }
        }
        panic!("unbalanced braces in on_disconnect closure");
    }

    /// Or every assertion below is about an empty string.
    #[test]
    fn found_the_closure_it_is_reading() {
        assert!(on_disconnect_body().contains("elevated_host"));
    }

    /// The half that matters most: a teardown-only assertion would still pass
    /// with an auto-relaunch bolted on beside it, so both halves are checked
    /// in the SAME test rather than split across two that could each go green
    /// independently while the policy as a whole regresses.
    #[test]
    fn a_dropped_elevated_connection_tears_down_its_sessions_and_does_not_relaunch() {
        let body = on_disconnect_body();
        assert!(
            body.contains("teardown_host_terminal"),
            "on_disconnect must end every still-registered Elevated session. Body:\n{body}"
        );
        assert!(
            body.contains("HostChannel::Elevated"),
            "on_disconnect must scope its teardown to Elevated entries, not every \
             host_terminals entry (that would also tear down the primary's tabs on an \
             unrelated elevated pipe drop). Body:\n{body}"
        );
        for forbidden in ["ensure_elevated_host", "run_as(", "ShellExecuteEx"] {
            assert!(
                !body.contains(forbidden),
                "on_disconnect must never relaunch or reconnect (found `{forbidden}`) — a \
                 background disconnect handler re-prompting UAC with no user gesture behind \
                 it is worse than just ending the session. Body:\n{body}"
            );
        }
    }
}
