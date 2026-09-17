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

/// Restore normal CTRL+C processing for this process, so every hosted shell we
/// spawn (and everything under it) can actually be interrupted.
///
/// Whoever launched us may have used `CREATE_NEW_PROCESS_GROUP`, which Microsoft
/// documents as disabling CTRL+C for the whole descendant group — and that state
/// is inherited by children, so a raw `\x03` would reach ConPTY but conhost would
/// never raise `CTRL_C_EVENT` for the foreground program. Per `SetConsoleCtrlHandler`:
/// a NULL handler with `Add=FALSE` "restores normal processing of CTRL+C input",
/// and "this attribute of ignoring or processing CTRL+C is inherited by child
/// processes". The GUI no longer passes that flag; this is belt-and-braces so the
/// sidecar is correct however it was started. Best-effort: failure just leaves the
/// inherited state as-is.
#[cfg(windows)]
fn restore_ctrl_c_processing() {
    extern "system" {
        fn SetConsoleCtrlHandler(
            handler: Option<unsafe extern "system" fn(u32) -> i32>,
            add: i32,
        ) -> i32;
    }
    // SAFETY: plain Win32 call; NULL handler + FALSE is the documented
    // "stop ignoring CTRL+C" form and touches no memory we own.
    let ok = unsafe { SetConsoleCtrlHandler(None, 0) } != 0;
    if !ok {
        eprintln!(
            "termflow-pty-host: WARNING: could not restore CTRL+C processing \
             (os error {}); Ctrl+C may not interrupt hosted programs",
            std::io::Error::last_os_error()
        );
    }
}

#[cfg(not(windows))]
fn restore_ctrl_c_processing() {}

/// Arguments for the elevated dial-out mode (plan 045). Hand-parsed, like the
/// rest of this binary's configuration — `ShellExecuteExW` (the launcher for
/// this mode) has no environment-block parameter, so these cannot ride on
/// env vars the way `TERMFLOW_PTY_PIPE` et al. do for the normal path.
struct DialArgs {
    connect_pipe: String,
    token: Option<String>,
    log: Option<std::path::PathBuf>,
}

/// `None` when `--connect-pipe` is absent — every other flag is meaningless
/// without it, and a missing `--connect-pipe` must mean today's behaviour,
/// bit for bit (plan 045 §4.3).
fn parse_dial_args() -> Option<DialArgs> {
    let mut args = std::env::args().skip(1);
    let mut connect_pipe = None;
    let mut token = None;
    let mut log = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--connect-pipe" => connect_pipe = args.next(),
            "--token" => token = args.next(),
            "--log" => log = args.next().map(std::path::PathBuf::from),
            _ => {}
        }
    }
    connect_pipe.map(|connect_pipe| DialArgs {
        connect_pipe,
        token,
        log,
    })
}

/// Open `path` and redirect this process's OWN stdout/stderr to it, so every
/// existing `eprintln!`/`log::` call site keeps working unmodified.
/// `ShellExecuteExW` cannot redirect a child's stdio the way `Command::spawn`
/// does for the primary sidecar (`pty_host_client.rs`'s `host.log` capture) —
/// there is no stdio-handle parameter on `SHELLEXECUTEINFOW` — so an elevated
/// dial-out host must redirect itself, as early as possible, before anything
/// has written a line that would otherwise vanish into the void.
#[cfg(windows)]
fn redirect_stdio_to(path: &std::path::Path) -> std::io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::Console::{SetStdHandle, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE};

    let file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)?;
    let handle = file.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE;
    // SAFETY: `handle` is a valid, open file handle for the lifetime of this
    // process (leaked deliberately below — closing it would sever the
    // redirection every future `eprintln!`/`println!` relies on).
    let ok_out = unsafe { SetStdHandle(STD_OUTPUT_HANDLE, handle) } != 0;
    let ok_err = unsafe { SetStdHandle(STD_ERROR_HANDLE, handle) } != 0;
    // The OS now owns this handle via the std-handle table; leaking the Rust
    // `File` avoids a double-close when it would otherwise drop.
    std::mem::forget(file);
    if !ok_out || !ok_err {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(windows))]
fn redirect_stdio_to(_path: &std::path::Path) -> std::io::Result<()> {
    Ok(())
}

/// Dial-out mode entry point (plan 045): connect to the GUI-hosted pipe,
/// serve exactly that one connection, then return so the process exits —
/// never falls through to the normal listener path below.
#[cfg(windows)]
async fn run_dial_out_mode(args: DialArgs) {
    if let Some(log_path) = &args.log {
        if let Err(e) = redirect_stdio_to(log_path) {
            eprintln!(
                "termflow-pty-host: could not redirect output to {}: {e}",
                log_path.display()
            );
        }
    }
    eprintln!(
        "termflow-pty-host: [ADMIN] dial-out mode, connecting to {}",
        args.connect_pipe
    );
    let endpoint = transport::Endpoint(args.connect_pipe);
    match transport::dial::serve_dial(endpoint, args.token).await {
        Ok(()) => eprintln!("termflow-pty-host: [ADMIN] dial-out connection ended, exiting"),
        Err(e) => eprintln!("termflow-pty-host: [ADMIN] dial-out serve failed: {e}"),
    }
}

#[cfg(not(windows))]
async fn run_dial_out_mode(_args: DialArgs) {
    eprintln!("termflow-pty-host: --connect-pipe is only supported on Windows");
}

#[tokio::main]
async fn main() {
    // Must run BEFORE any session spawns: children inherit this process's
    // ignore-vs-process CTRL+C attribute at creation time.
    restore_ctrl_c_processing();

    if let Some(dial_args) = parse_dial_args() {
        run_dial_out_mode(dial_args).await;
        return;
    }

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
            capabilities: termflow_pty_protocol::CAP_ATTACH_ACK
                | termflow_pty_protocol::CAP_LIFECYCLE_CONTRACT,
            // The bound applies only to an authenticated, purpose-labelled
            // LOCAL hold. Legacy/unlabelled sibling holds remain indefinite.
            lifecycle: Some(termflow_pty_protocol::LifecycleContract {
                version: 1,
                retention: termflow_pty_protocol::RetentionPolicy::Bounded {
                    active_secs: termflow_pty_protocol::LOCAL_HOLD_ACTIVE_SECS,
                },
            }),
            // This is a launch-time label, not executable attestation: a symlink
            // can be retargeted or a file rewritten after the GUI hashes it.
            build_id: std::env::var("TERMFLOW_PTY_BUILD_ID").ok(),
        };
        if let Err(e) = termflow_pty_protocol::write_record(&path, &rec) {
            eprintln!("termflow-pty-host: could not write discovery record: {e}");
        }
        (path, rec)
    });

    if let Err(e) = transport::serve(endpoint, token, survivable, record.clone()).await {
        eprintln!("termflow-pty-host: serve ended: {e}");
    }

    // Clean shutdown: retract our advertisement (only if still ours — never
    // delete a newer host's record).
    if let Some((path, rec)) = record {
        let _ = termflow_pty_protocol::remove_record_if_owned(&path, rec.instance_id);
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
