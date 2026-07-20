//! `termflow-pty-host` — the detached PTY-host sidecar.
//!
//! Owns ConPTY children over a per-user Windows named pipe, keeps a bounded
//! per-session replay ring, and survives a GUI hot-swap so shells reattach.
//! See docs/plan/002 for the full design.

mod manager;
mod ring;
mod session;
mod util;
mod winjob;

#[cfg(windows)]
mod pipe;

#[tokio::main]
async fn main() {
    // If we are trapped in a kill-on-close job (breakaway was not honored),
    // survival across GUI exit cannot be guaranteed. Log loudly so the GUI's
    // arm can fail rather than silently lose sessions.
    if let Err(e) = winjob::assert_not_kill_on_close_job() {
        eprintln!("termflow-pty-host: WARNING: {e}");
    }

    let pipe_name = std::env::var("TERMFLOW_PTY_PIPE")
        .unwrap_or_else(|_| r"\\.\pipe\termflow-pty-host".to_string());
    let token = std::env::var("TERMFLOW_PTY_TOKEN").ok();

    #[cfg(windows)]
    {
        if let Err(e) = pipe::serve(pipe_name, token).await {
            eprintln!("termflow-pty-host: serve ended: {e}");
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (pipe_name, token);
        eprintln!("termflow-pty-host: Windows-only in milestone A");
    }
}
