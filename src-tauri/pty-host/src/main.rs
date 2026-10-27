//! `termflow-pty-host` — the detached PTY-host sidecar.
//!
//! Owns ConPTY children over a per-user Windows named pipe, keeps a bounded
//! per-session replay ring, and survives a GUI hot-swap so shells reattach.
//! See docs/plan/002 for the full design.

mod detach;
mod logging;
mod manager;
mod mcp_hold;
mod permissions;
mod ring;
mod session;
mod tcc_child;
mod tcc_runner;
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

/// Arguments for the elevated dial-out mode (plan 045) or reconnect helper mode (plan 058).
/// Hand-parsed, like the rest of this binary's configuration — `ShellExecuteExW`
/// has no environment-block parameter.
struct DialArgs {
    connect_pipe: String,
    token: Option<String>,
    log: Option<std::path::PathBuf>,
    survivor_record: Option<std::path::PathBuf>,
    reconnect_target: Option<u32>,
    rendezvous_pipe: Option<String>,
    gui_pipe: Option<String>,
    gui_pid: Option<u32>,
}

/// `None` when neither `--connect-pipe` nor `--reconnect-target` is present.
fn parse_dial_args() -> Option<DialArgs> {
    let mut args = std::env::args().skip(1);
    let mut connect_pipe = None;
    let mut token = None;
    let mut log = None;
    let mut survivor_record = None;
    let mut reconnect_target = None;
    let mut rendezvous_pipe = None;
    let mut gui_pipe = None;
    let mut gui_pid = None;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--connect-pipe" => connect_pipe = args.next(),
            "--token" => token = args.next(),
            "--log" => log = args.next().map(std::path::PathBuf::from),
            "--survivor-record" => survivor_record = args.next().map(std::path::PathBuf::from),
            "--reconnect-target" => reconnect_target = args.next().and_then(|s| s.parse::<u32>().ok()),
            "--rendezvous-pipe" => rendezvous_pipe = args.next(),
            "--gui-pipe" => gui_pipe = args.next(),
            "--gui-pid" => gui_pid = args.next().and_then(|s| s.parse::<u32>().ok()),
            _ => {}
        }
    }

    if connect_pipe.is_none() && reconnect_target.is_none() {
        return None;
    }

    Some(DialArgs {
        connect_pipe: connect_pipe.unwrap_or_default(),
        token,
        log,
        survivor_record,
        reconnect_target,
        rendezvous_pipe,
        gui_pipe,
        gui_pid,
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

#[cfg(windows)]
async fn run_reconnect_helper(
    reconnect_target: u32,
    rendezvous_pipe: String,
    gui_pipe: String,
    gui_pid: u32,
    token: String,
) -> std::io::Result<()> {
    use tokio::net::windows::named_pipe::ClientOptions;
    let stream = ClientOptions::new().open(&rendezvous_pipe)?;

    let mut server_pid = 0u32;
    use std::os::windows::io::AsRawHandle;
    let handle = stream.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE;
    extern "system" {
        fn GetNamedPipeServerProcessId(
            pipe: windows_sys::Win32::Foundation::HANDLE,
            server_process_id: *mut u32,
        ) -> windows_sys::Win32::Foundation::BOOL;
    }
    let ok = unsafe { GetNamedPipeServerProcessId(handle, &mut server_pid) };
    if ok == 0 || server_pid != reconnect_target {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!("rendezvous server pid mismatch: expected {reconnect_target}, got {server_pid}"),
        ));
    }

    let req = termflow_pty_protocol::ElevatedRendezvousRequest {
        version: termflow_pty_protocol::ELEVATED_RENDEZVOUS_VERSION,
        gui_pid,
        target_pipe: gui_pipe,
        auth_token: token,
    };
    let mut stream = stream;
    termflow_pty_protocol::write_rendezvous_request(&mut stream, &req).await?;

    let resp = termflow_pty_protocol::read_rendezvous_response(&mut stream).await?;
    match resp.status {
        termflow_pty_protocol::ElevatedRendezvousStatus::Ok => Ok(()),
        termflow_pty_protocol::ElevatedRendezvousStatus::Rejected(reason) => Err(std::io::Error::new(
            std::io::ErrorKind::ConnectionRefused,
            format!("held host rejected rendezvous: {reason}"),
        )),
    }
}

/// Dial-out mode entry point (plan 045, updated plan 058).
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

    if let (Some(target), Some(rendezvous), Some(gui_pipe), Some(gui_pid), Some(token)) = (
        args.reconnect_target,
        args.rendezvous_pipe,
        args.gui_pipe,
        args.gui_pid,
        args.token.clone(),
    ) {
        match run_reconnect_helper(target, rendezvous, gui_pipe, gui_pid, token).await {
            Ok(()) => eprintln!("termflow-pty-host: [HELPER] rendezvous handshake succeeded"),
            Err(e) => {
                eprintln!("termflow-pty-host: [HELPER] rendezvous handshake failed: {e}");
                std::process::exit(1);
            }
        }
        return;
    }

    eprintln!(
        "termflow-pty-host: [ADMIN] dial-out mode, connecting to {}",
        args.connect_pipe
    );
    let endpoint = transport::Endpoint(args.connect_pipe);
    match transport::dial::serve_dial(endpoint, args.token, args.survivor_record).await {
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
    let args: Vec<String> = std::env::args().skip(1).collect();
    match tcc_child::entry(&args, &termflow_macos_tcc::SystemTcc, &mut std::io::stdout().lock()) {
        Ok(true) => return,
        Ok(false) => {},
        Err(error) => { eprintln!("termflow-pty-host: {error}"); std::process::exit(2); }
    }
    // First, so the `log::` lines of everything below (ConPTY preload, the MCP
    // hold, token rejections) are written rather than dropped (plan 054 review 295 F2).
    if let Err(e) = logging::init_logging() {
        eprintln!("termflow-pty-host: could not install the logger: {e}");
    }

    // Must run BEFORE any session spawns: children inherit this process's
    // ignore-vs-process CTRL+C attribute at creation time.
    restore_ctrl_c_processing();

    // Plan 049: sideload modern ConPTY (answers OSC 10/11 colour queries) before
    // any session opens a pseudoconsole — portable-pty resolves it once, lazily.
    #[cfg(windows)]
    let _ = termflow_pty_protocol::conpty::init_for_current_exe();

    if let Some(dial_args) = parse_dial_args() {
        run_dial_out_mode(dial_args).await;
        log::logger().flush();
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
            capabilities: host_capabilities(termflow_pty_protocol::da1::inherit_cursor_supported()),
            // The bound applies to an authenticated, purpose-labelled LOCAL
            // hold and to the crash hold an unannounced disconnect opens
            // (`SessionManager::on_gui_disconnect`). Legacy/unlabelled sibling
            // holds remain indefinite.
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
    // The writer thread is detached: give the lines queued so far their bounded chance.
    log::logger().flush();
}

/// The capability bits this host advertises in its discovery record.
///
/// Drain/takeover is NOT implemented yet — `CAP_DRAIN` is deliberately absent.
/// `inherit_cursor` is true only once the bundled ConPTY is loaded
/// (`init_for_current_exe`): the inbox one is not measured to honour an
/// inherited cursor. `CAP_MCP_HOLD` is the plan 054 rollback switch: drop that
/// one line and no GUI sends the MCP-hold frames.
///
/// The elevated dial-out host returns before the record is built, so it never
/// advertises any of these.
fn host_capabilities(inherit_cursor: bool) -> u32 {
    termflow_pty_protocol::CAP_ATTACH_ACK
        | termflow_pty_protocol::CAP_LIFECYCLE_CONTRACT
        | termflow_pty_protocol::CAP_SHUTDOWN_CONTROL
        | termflow_pty_protocol::CAP_MCP_HOLD
        | if cfg!(target_os = "macos") { termflow_pty_protocol::CAP_PERMISSIONS } else { 0 }
        | if inherit_cursor { termflow_pty_protocol::CAP_INHERIT_CURSOR } else { 0 }
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

#[cfg(test)]
mod dial_out_census;

#[cfg(test)]
mod tests {
    use super::*;
    use termflow_pty_protocol::{
        CAP_ATTACH_ACK, CAP_DRAIN, CAP_INHERIT_CURSOR, CAP_LIFECYCLE_CONTRACT, CAP_MCP_HOLD, CAP_SHUTDOWN_CONTROL,
    };

    #[test]
    fn host_capabilities_include_mcp_hold() {
        let base = CAP_ATTACH_ACK | CAP_LIFECYCLE_CONTRACT | CAP_SHUTDOWN_CONTROL | CAP_MCP_HOLD
            | if cfg!(target_os = "macos") { termflow_pty_protocol::CAP_PERMISSIONS } else { 0 };
        assert_eq!(host_capabilities(false), base);
        assert_eq!(host_capabilities(true), base | CAP_INHERIT_CURSOR);
        assert_eq!(host_capabilities(false) & CAP_DRAIN, 0);
        assert_eq!(host_capabilities(true) & CAP_DRAIN, 0);
    }

    #[test]
    fn permission_capability_is_advertised_only_on_macos() {
        let advertised = host_capabilities(false) & termflow_pty_protocol::CAP_PERMISSIONS != 0;
        #[cfg(target_os = "macos")]
        assert!(advertised);
        #[cfg(not(target_os = "macos"))]
        assert!(!advertised);
    }

    #[test]
    fn tcc_child_entry_precedes_logging_socket_and_record_setup() {
        let source = include_str!("main.rs").replace("\r\n", "\n");
        let body = source.split("async fn main() {").nth(1).unwrap();
        let child = body.find("tcc_child::entry(").unwrap();
        for later in ["logging::init_logging()", "resolve_endpoint()", "TERMFLOW_PTY_RECORD", "transport::serve("] {
            assert!(child < body.find(later).unwrap(), "{later}");
        }
    }

    /// `init_logging` is tested in `logging.rs`; this pins that `main` calls it,
    /// and before the first thing that can log (the ConPTY preload). Source-pinned,
    /// CRLF-normalised.
    #[test]
    fn main_installs_the_logger_before_anything_can_log() {
        let source = include_str!("main.rs").replace("\r\n", "\n");
        let body = source.split("async fn main() {").nth(1).expect("main()");
        let init = body.find("logging::init_logging()").expect("main must call logging::init_logging()");
        let first_log = body.find("init_for_current_exe").expect("the ConPTY preload in main()");
        assert!(init < first_log, "init_logging must run before the ConPTY preload logs");
        assert!(init < body.find("transport::serve(").expect("serve in main()"));
    }

    /// The record builder must take its bits from `host_capabilities`, or the
    /// tests above pin a function nobody calls. Source-pinned, CRLF-normalised.
    #[test]
    fn the_record_builder_calls_host_capabilities() {
        let source = include_str!("main.rs").replace("\r\n", "\n");
        let builder = source
            .split("let rec = termflow_pty_protocol::HostRecord {")
            .nth(1)
            .and_then(|rest| rest.split("build_id:").next())
            .expect("the record builder in main()");
        assert!(
            builder.contains("capabilities: host_capabilities(termflow_pty_protocol::da1::inherit_cursor_supported()),"),
            "the record's capabilities must come from host_capabilities: {builder}"
        );
    }
}
