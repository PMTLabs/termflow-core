pub mod sibling_coord;
pub mod identity_index;
pub mod state;
pub mod console_window;
pub mod context_menu;
pub mod webview_power;
pub mod session_notify;
pub mod app_config;
pub mod profile;
pub mod instance_lock;
pub mod net_ports;
pub mod window_registry;
mod history_store;
pub mod canvas_store;
// Terminal Automations (plan 028). ONE `automation*` prefix for the whole feature, chosen so it
// cannot be confused with `spawn_pipeline_watchdog` below — that one watches the output PIPELINE for
// a stalled consumer and is unrelated.
pub mod automation;
pub mod automation_commands;
pub mod automation_engine;
pub mod automation_store;
pub mod automation_validation;
pub mod automation_webhook;
pub mod canvas_endpoints;
pub mod network_commands;
pub mod pty_manager;
pub mod pty_host_client;
pub mod commands;
#[cfg(feature = "velopack-updates")]
pub mod updater;
pub mod open_commands;
pub mod api_server;
pub mod event_bus;
pub mod recording_service;
pub mod recording_endpoints;
pub mod search_service;
pub mod search_endpoints;
pub mod layout_manager;
pub mod layout_endpoints;
pub mod tmux_manager;
pub mod fabric_manager;
pub mod peer_commands;
mod gpu_preference;
mod native_notify;
mod panic_hook;
mod shell_integration;
mod mcp_sidecar;
mod output_pipeline;
mod history_flush;
mod tray;
mod window_restore;

use tauri::{Manager, Emitter, RunEvent, WindowEvent};

use tokio::sync::broadcast;
use crate::state::{AppState, McpProcessHandle};
use std::io::Write;
use std::time::Duration;

use clap::Parser;

// Boot-path modules split out of this file (pure move, feature/lib-split): the mod
// bodies live in their own files, but callers throughout the crate still reach these
// as `crate::<name>` exactly as before the split.
pub(crate) use mcp_sidecar::mcp_respawn_needed;
pub use mcp_sidecar::respawn_mcp;
pub(crate) use output_pipeline::{spawn_output_consumer, spawn_pipeline_watchdog};
pub(crate) use history_flush::{flush_all_history, history_db_path, spawn_history_flush_task};
pub(crate) use tray::build_tray;
pub(crate) use window_restore::{restore_windows, show_or_focus_main_window};

/// Gracefully shutdown the MCP server process
/// Whether an MCP sidecar/legacy process is currently held.
///
/// Mirrors `fabric_manager::fabric_alive`. Needed so a restart that MOVES the API port does
/// not resurrect a sidecar the user deliberately stopped — "the API moved" is a reason to
/// re-point a running forwarder, never a reason to start one.
pub(crate) fn mcp_alive(state: &AppState) -> bool {
    state.mcp_process.lock().map(|g| g.is_some()).unwrap_or(false)
}

/// Private stdin line protocol understood only by our spawned MCP child. It is
/// intentionally not an HTTP/MCP method, so an MCP client cannot kill its host.
const MCP_SHUTDOWN_COMMAND: &[u8] = b"TERMFLOW_SHUTDOWN\n";
/// The Node/Bun sidecar allocates 750 ms to close transports and 750 ms to close
/// HTTP. Two seconds includes scheduler/pipe slack yet keeps UI exit bounded.
const MCP_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);

fn should_force_kill_after_graceful_wait(completed: bool) -> bool {
    !completed
}

pub(crate) fn shutdown_mcp_server(state: &AppState) {
    if let Ok(mut guard) = state.mcp_process.lock() {
        if let Some(child) = guard.take() {
            match child {
                McpProcessHandle::Legacy(mut handle) => {
                    log::info!("[MCP] Gracefully shutting down MCP Server (PID: {})...", handle.id());
                    let wrote = handle.stdin.as_mut().map(|stdin| stdin.write_all(MCP_SHUTDOWN_COMMAND)).transpose();
                    if let Err(e) = wrote {
                        log::warn!("[MCP] Failed to send legacy shutdown command: {}", e);
                    }
                    let deadline = std::time::Instant::now() + MCP_SHUTDOWN_TIMEOUT;
                    let mut completed = false;
                    while std::time::Instant::now() < deadline {
                        match handle.try_wait() {
                            Ok(Some(_)) => { completed = true; break; }
                            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
                            Err(e) => { log::warn!("[MCP] Failed to poll legacy MCP Server: {}", e); break; }
                        }
                    }
                    if should_force_kill_after_graceful_wait(completed) {
                        log::warn!("[MCP] Legacy shutdown exceeded {:?}; force-killing", MCP_SHUTDOWN_TIMEOUT);
                        if let Err(e) = handle.kill() {
                            log::warn!("[MCP] Failed to kill legacy MCP Server: {}", e);
                        }
                        if let Err(e) = handle.wait() {
                            log::warn!("[MCP] Failed to wait for legacy MCP Server: {}", e);
                        }
                    }
                }
                McpProcessHandle::Sidecar { mut child, terminated } => {
                    log::info!("[MCP] Gracefully shutting down MCP Server sidecar (PID: {})...", child.pid());
                    if let Err(e) = child.write(MCP_SHUTDOWN_COMMAND) {
                        log::warn!("[MCP] Failed to send sidecar shutdown command: {}", e);
                    }
                    let completed = terminated.recv_timeout(MCP_SHUTDOWN_TIMEOUT).is_ok();
                    if should_force_kill_after_graceful_wait(completed) {
                        log::warn!("[MCP] Sidecar shutdown exceeded {:?}; force-killing", MCP_SHUTDOWN_TIMEOUT);
                        if let Err(e) = child.kill() {
                            log::warn!("[MCP] Failed to kill sidecar MCP Server: {}", e);
                        }
                    }
                }
            }

            log::info!("[MCP] MCP Server terminated");
        }
    }
}

#[cfg(test)]
mod mcp_shutdown_tests {
    use super::should_force_kill_after_graceful_wait;

    #[test]
    fn only_an_incomplete_graceful_wait_requires_force_kill() {
        assert!(!should_force_kill_after_graceful_wait(true));
        assert!(should_force_kill_after_graceful_wait(false));
    }
}

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
   /// Run in headless mode (no GUI)
   #[arg(long, default_value_t = false)]
   headless: bool,
   /// Override the API server port for THIS run. Runtime-only; not persisted.
   /// This no longer bypasses single-instance (D6) — use `--profile` for a
   /// second instance, which picks free ports on its own.
   #[arg(long)]
   api_port: Option<u16>,
   /// Override the MCP server port for THIS run. Runtime-only; not persisted.
   #[arg(long)]
   mcp_port: Option<u16>,
   /// Run as a named instance with its own config, history, shells and ports.
   /// Launching the same profile twice focuses the existing window.
   #[arg(long, value_parser = crate::profile::sanitize_arg)]
   profile: Option<String>,
   /// Open a new terminal rooted at this folder.
   #[arg(long = "path")]
   path: Option<String>,
   /// Positional fallback used by file managers and command-line users.
   #[arg(value_name = "PATH")]
   positional_path: Option<String>,
}

#[cfg(test)]
mod cli_args_tests {
    use super::Args;
    use clap::Parser;

    #[test]
    fn parses_port_overrides() {
        let a = Args::try_parse_from(["app", "--api-port", "42041", "--mcp-port", "42042"]).unwrap();
        assert_eq!(a.api_port, Some(42041));
        assert_eq!(a.mcp_port, Some(42042));
    }

    #[test]
    fn ports_default_to_none() {
        let a = Args::try_parse_from(["app"]).unwrap();
        assert_eq!(a.api_port, None);
        assert_eq!(a.mcp_port, None);
        assert!(!a.headless);
    }

    #[test]
    fn rejects_an_unsafe_profile_at_parse_time() {
        // The value reaches Path::join, a pipe name and a mutex name, so a bad
        // one must never get as far as identity resolution.
        assert_eq!(
            Args::try_parse_from(["app", "--profile", "Work"]).unwrap().profile.as_deref(),
            Some("work")
        );
        assert!(Args::try_parse_from(["app", "--profile", "../etc"]).is_err());
        assert!(Args::try_parse_from(["app", "--profile", ""]).is_err());
        assert_eq!(Args::try_parse_from(["app"]).unwrap().profile, None);
    }

    #[test]
    fn parses_path_flag_and_positional() {
        // --path flag
        let a = Args::try_parse_from(["app", "--path", "C:/proj"]).unwrap();
        assert_eq!(a.path.as_deref(), Some("C:/proj"));
        assert_eq!(a.positional_path, None);
        // positional fallback (file managers pass the folder as a bare arg)
        let b = Args::try_parse_from(["app", "/home/user/proj"]).unwrap();
        assert_eq!(b.path, None);
        assert_eq!(b.positional_path.as_deref(), Some("/home/user/proj"));
        // `--path` wins when both are given (matches `args.path.or(positional_path)`)
        let c = Args::try_parse_from(["app", "--path", "A", "B"]).unwrap();
        assert_eq!(c.path.as_deref(), Some("A"));
        assert_eq!(c.positional_path.as_deref(), Some("B"));
        // absent
        let d = Args::try_parse_from(["app"]).unwrap();
        assert_eq!(d.path, None);
        assert_eq!(d.positional_path, None);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // Install FIRST, before anything that could panic, so a startup panic is
  // still written to the log (with a backtrace) instead of dying silently.
  panic_hook::install();

  let args = Args::parse();

  // Resolve the instance identity BEFORE anything resolves a path. Every mutable
  // artifact name flows from it (app_config::dev_file), so a late resolution
  // would silently write the wrong profile's files.
  let identity = match profile::ProfileIdentity::resolve(
    args.profile.as_deref(),
    profile::elevation(),
    app_config::is_dev(),
  ) {
    Ok(id) => id,
    Err(e) => {
      eprintln!("TermFlow: {e}");
      std::process::exit(2);
    }
  };
  profile::set_current(identity.clone());

  let is_headless = args.headless;
  // Runtime-only port overrides (B5): applied to the loaded config before binding,
  // never persisted — so a second instance can start on free ports without touching
  // the shared config.json.
  let cli_api_port = args.api_port;
  let cli_mcp_port = args.mcp_port;
  let initial_open_path = args.path.or(args.positional_path);

  // Hoisted so the log target can be named from the real product name rather
  // than a second hardcoded copy of it.
  let context = tauri::generate_context!();
  let log_file_name = identity.scoped_stem(&context.package_info().name);

  let mut builder = tauri::Builder::default();
  #[cfg(desktop)]
  {
    // Single-instance is enforced per PROFILE IDENTITY (channel, name, integrity),
    // and unconditionally for GUI processes — the `--api-port`/`--mcp-port` bypass
    // is gone (D6): it existed only as the pre-profile escape hatch for a second
    // instance, and letting two processes share one identity puts them back on one
    // pipe, lock and pair of ports.
    //
    // Two exemptions remain, both deliberate:
    //   * headless — no window to focus, so there is nothing to relay to;
    //   * dev builds — a debug build must be able to run beside the installed
    //     release used for production. Dev is isolated by its own channel
    //     ("dev"), so it never shares an artifact with release anyway.
    // In both cases two processes CAN share one identity and would contend for
    // its pipe; that is the accepted cost of each exemption.
    if !crate::app_config::is_dev() && !args.headless {
      let on_second_launch = |app: &tauri::AppHandle, argv: Vec<String>, _cwd: String| {
        let path = Args::try_parse_from(argv)
          .ok()
          .and_then(|args| args.path.or(args.positional_path));
        if let Some(path) = path {
          if let Err(e) = commands::open_new_window(app, Some(path)) {
            log::error!("Open in TermFlow failed: {}", e);
          } else {
            commands::refresh_menu(app);
          }
        } else {
          // No path → a plain relaunch while already running: focus/raise (or recreate)
          // a window. Reuse the robust helper, which falls back to any real window and
          // creates one if none exist (e.g. tray-only or the main window was detached).
          show_or_focus_main_window(app);
        }
      };

      #[cfg(windows)]
      {
        builder = builder.plugin(instance_lock::init(&identity, Box::new(on_second_launch)));
      }
      // Unix keeps the identifier-keyed plugin, which is exactly the previous
      // behaviour for the primary profile. A named profile there is unenforced
      // for now — see instance_lock.rs.
      #[cfg(not(windows))]
      if identity.is_primary() {
        builder = builder.plugin(tauri_plugin_single_instance::init(on_second_launch));
      }
    }
  }

  builder
    .plugin(
      tauri_plugin_log::Builder::default()
        // Same two targets the plugin defaults to, but with the log-dir file
        // named per profile so two instances never fight over one rotating
        // file. The default identity yields the product name unchanged.
        .targets([
          tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
          tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
            file_name: Some(log_file_name),
          }),
        ])
        .level(log::LevelFilter::Info)  // Only INFO and above
        .level_for("tokio_tungstenite", log::LevelFilter::Warn)
        .level_for("tungstenite", log::LevelFilter::Warn)
        .level_for("hyper", log::LevelFilter::Warn)
        .level_for("reqwest", log::LevelFilter::Warn)
        .level_for("tower_http", log::LevelFilter::Warn)
        .build()
    )
    // Required for app_handle.shell().sidecar(...) used to launch the MCP server.
    // Without this the shell plugin state is unmanaged and `.shell()` panics
    // ("state() called before manage()"), silently killing the MCP launch task.
    .plugin(tauri_plugin_shell::init())
    // Native clipboard access (read/write) used by the renderer's paste path so it
    // never calls navigator.clipboard — which prompts the WebView clipboard popup.
    .plugin(tauri_plugin_clipboard_manager::init())
    // Native file picker for the Settings "Default editor" Browse… button.
    .plugin(tauri_plugin_dialog::init())
    // OS notifications (Plan 010): a native toast when a pairing request arrives
    // while no window is focused (tray/background mode).
    .plugin(tauri_plugin_notification::init())
    // Launch-at-login (Settings → Startup & Integration). LaunchAgent on macOS; Run
    // key on Windows; autostart .desktop on Linux. No launch args — a login start is
    // a normal GUI launch. Enable/disable/isEnabled are driven from the renderer.
    .plugin(tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        None,
    ))
    .setup(move |app| {
        // Resolved before the builder ran, so it could not be logged then.
        gpu_preference::log_resolution();

        // Unpackaged Windows apps need an AUMID registered before WinRT can
        // attribute and deliver native toast notifications. On macOS this claims the
        // notification bundle identity, which MUST happen before anything else in the
        // process notifies (mac-notification-sys guards it with a one-shot). Idempotent
        // and deliberately non-fatal so a registry policy cannot prevent launch.
        if let Err(e) = crate::native_notify::register_app_for_notifications(app.handle()) {
            log::warn!("Failed to register native notification identity: {}", e);
        }

        // Handle headless mode
        if is_headless {
            if let Some(window) = app.get_webview_window("main") {
                if let Err(e) = window.hide() {
                    log::error!("Failed to hide window in headless mode: {}", e);
                }
            } else {
                 // Try get_webview_window for Tauri v2 if get_window fails/not found? 
                 // Actually get_window is generic method on Manager. 
                 // In v2 it returns WebviewWindow. In v1 Window.
            }
            println!("Starting in HEADLESS mode (GUI hidden)");
        }

        // Channel for PTY output, shared by ALL terminals. Capacity must absorb
        // multi-terminal output bursts: at 100 slots a single `cargo build` could
        // fill it in milliseconds and Lagged receivers silently drop chunks
        // (WS clients + the terminal:data emit). 2048 × ≤4KB chunks ≈ 8MB cap.
        let (tx, _rx) = broadcast::channel(2048);

        // Load this instance's persisted network config (dev vs prod isolated by
        // filename + default ports). A freshly-generated token is persisted here.
        let mut network = crate::app_config::load_or_init(&app.handle());
        // Apply runtime-only CLI port overrides (not persisted) so a second instance
        // can launch on free ports without editing the shared config.
        if let Some(p) = cli_api_port {
            log::info!("[CONFIG] --api-port override: {} -> {}", network.api_port, p);
            network.api_port = p;
        }
        if let Some(p) = cli_mcp_port {
            log::info!("[CONFIG] --mcp-port override: {} -> {}", network.mcp_port, p);
            network.mcp_port = p;
        }
        // D5: an elevated instance authenticates on loopback, with a token minted
        // for THIS launch and never written to disk. A persisted token would sit
        // in a file any medium-integrity process owned by this user can read,
        // which would defeat the whole point of requiring one.
        let elevated =
            crate::profile::current().integrity == crate::profile::Integrity::High;
        if elevated {
            network.auth_token = crate::app_config::generate_token();
            log::info!("[CONFIG] elevated instance: minted a per-launch API token");
        }
        log::info!(
            "[CONFIG] instance={} api_port={} mcp_port={} expose={}",
            crate::app_config::instance_config_name(),
            network.api_port, network.mcp_port, network.expose_on_network
        );

        // Initialize AppState with app handle + network config
        let state = AppState::new(tx, app.handle().clone(), network.clone());

        if let Some(path) = initial_open_path.clone() {
            match state.pending_open_path.lock() {
                Ok(mut pending) => *pending = Some(path),
                Err(e) => log::error!("Failed to store pending open path: {}", e),
            }
        }

        // Manage state in Tauri
        app.manage(state.clone());

        // Advertise this instance BEFORE the servers come up: an instance that
        // serves no endpoints at all (an elevated launch without a port flag) is
        // still a running sibling, and the updater must see it (Task 17).
        // Re-published with the real ports once they are bound.
        let publish_record = |api_port, mcp_port| {
            let id = crate::profile::current();
            let rec = crate::net_ports::InstanceRecord {
                profile: id.key(),
                pid: std::process::id(),
                api_port,
                mcp_port,
                // Only an elevated instance needs a token published, and the file
                // it goes into carries a HIGH integrity label so a medium process
                // of this user cannot read it back (D5).
                token: (id.integrity == crate::profile::Integrity::High)
                    .then(|| network.auth_token.clone()),
            };
            if let Err(e) = crate::net_ports::publish(&rec, elevated) {
                log::warn!("[NET] could not publish the instance record: {e}");
            }
        };
        publish_record(None, None);

        // Seed the background-mode flag from persisted settings (Plan 010) BEFORE any
        // window can close, so the exit guard reads the user's saved choice. The
        // renderer re-hydrates the same value into its toggle at boot.
        if let Some(keep) =
            crate::app_config::read_bool_setting(&app.handle(), "keepRunningInBackground")
        {
            state
                .keep_running_in_background
                .store(keep, std::sync::atomic::Ordering::Relaxed);
        }

        // System tray (Plan 010): reuse the app's window icon (no new asset). Left-
        // click shows/focuses the main window; the menu offers Show / Peers / Quit.
        // Failure is non-fatal — the app still runs without a tray.
        if let Err(e) = build_tray(app.handle()) {
            log::warn!("Failed to build system tray: {}", e);
        }

        // Build the app menu (File > New Window, Edit, and a Window submenu that
        // lists every open window). Rebuilt on window create/destroy/title-change.
        commands::refresh_menu(&app.handle());

        // Cancel the WebView2 right-click menu (Windows) on the primary window so
        // only TermFlow's own React menus appear. New windows install the same
        // filter at build time.
        if let Some(main) = app.get_webview_window("main") {
            // The main window's title comes from tauri.conf.json, so mark it here.
            // Every later update goes through set_window_title, which decorates too.
            let _ = main.set_title(&crate::profile::decorate_title("TermFlow"));
            crate::context_menu::install(&main);
            // Detect RDP/console session switches (Windows) and tell the renderer to
            // suppress the resulting ConPTY repaint burst — otherwise the activity
            // bell rings on every tab when you return to the machine. The DOM
            // visibilitychange path does NOT cover session connect/disconnect.
            crate::session_notify::install(&main, app.handle().clone());
        }

        // Plan 018: recreate every window that was open at the last quit.
        //
        // `tauri.conf.json` declares exactly one window, so slot 0 binds to the
        // already-created `main`; slots 1..N are built here. This must run
        // AFTER `app.manage(state)` (the tracker lives in AppState) and after
        // `main` is titled, so a restored window is configured identically to
        // one opened during the session.
        restore_windows(app.handle());
        state.begin_host_restore_sweep(app.webview_windows().keys().cloned());

        // Get app handle for emitting events
        let app_handle = app.handle().clone();
        
        // Spawn API Server (REST + WebSocket on one port) from the loaded config. The
        // MCP sidecar is started INSIDE this task, only after the API-ownership check
        // passes — see the conflict branch below for why.
        let api_state = state.clone();
        let api_net = network.clone();
        let mcp_app_handle = app_handle.clone();
        let mcp_net = network.clone();
        // App handle for the fabric peering sidecar, spawned alongside MCP once the
        // API port is confirmed ours (the fabric calls back into the local API).
        let fabric_app_handle = app_handle.clone();
        let (api_sd_tx, api_sd_rx) = tokio::sync::oneshot::channel();
        if let Ok(mut g) = api_state.api_shutdown.lock() {
            *g = Some(api_sd_tx);
        }
        // An elevated instance serves its API/MCP only when the user explicitly
        // asked for it with a port flag. Otherwise the safest surface is none at
        // all: the default is an admin terminal you drive by hand, not one any
        // local program can reach.
        let serve_endpoints =
            !elevated || cli_api_port.is_some() || cli_mcp_port.is_some();
        tauri::async_runtime::spawn(async move {
            if !serve_endpoints {
                log::info!(
                    "[API] Suppressed for the elevated profile: pass --api-port or --mcp-port \
                     to serve them (the token is minted per launch)"
                );
                return;
            }
            let host = if api_net.expose_on_network { [0, 0, 0, 0] } else { [127, 0, 0, 1] };
            // Bind-and-RETAIN, walking forward from the configured port. A probe
            // followed by a separate bind leaves a window in which a sibling can
            // take the port, and `SO_REUSEADDR` (needed for the hot-restart
            // rebind) means our bind would then SUCCEED and hijack it — silently
            // rerouting the other instance's MCP tool calls into this app. With
            // per-profile instances, two apps starting at once is normal.
            //
            // The fallback port is NEVER written back to the config: `network`
            // stays what the user configured, `effective_endpoints` records what
            // we actually got.
            let picked = crate::net_ports::bind_api_listener(
                host,
                api_net.api_port,
                crate::net_ports::DEFAULT_SPAN,
                &api_state.instance_id,
            )
            .await;
            match picked {
                Some(crate::net_ports::Picked { port: api_port, bound: listener }) => {
                    // Bound successfully → the API port is genuinely ours. Publish
                    // it BEFORE anything derived from it is built: `mcp_env` used to
                    // read a config clone captured before binding, so a fallback
                    // port left the MCP sidecar forwarding to the OTHER instance's
                    // API. Same for the fabric and the renderer.
                    let mcp_port = crate::net_ports::pick_mcp_port(
                        api_net.mcp_port,
                        crate::net_ports::DEFAULT_SPAN,
                        &api_state.instance_id,
                    )
                    .await;
                    {
                        let mut eff = api_state.effective_endpoints.write();
                        eff.api_port = Some(api_port);
                        eff.mcp_port = mcp_port;
                    }
                    log::info!(
                        "[NET] effective endpoints: api={api_port} (configured {}) mcp={:?} (configured {})",
                        api_net.api_port, mcp_port, api_net.mcp_port
                    );
                    // Re-advertise with the ports we actually got, so a sibling
                    // (or the user) can find this instance without guessing.
                    if let Err(e) = crate::net_ports::publish(
                        &crate::net_ports::InstanceRecord {
                            profile: crate::profile::current().key(),
                            pid: std::process::id(),
                            api_port: Some(api_port),
                            mcp_port,
                            token: (crate::profile::current().integrity
                                == crate::profile::Integrity::High)
                                .then(|| api_net.auth_token.clone()),
                        },
                        crate::profile::current().integrity == crate::profile::Integrity::High,
                    ) {
                        log::warn!("[NET] could not republish the instance record: {e}");
                    }
                    // Only NOW start the MCP sidecar (which forwards every tool call
                    // to this API), so a bind failure can never leave a sidecar
                    // advertising our instanceId while pointing at a port we don't
                    // own. It is launched with the EFFECTIVE ports.
                    let mut mcp_net = mcp_net;
                    mcp_net.api_port = api_port;
                    let mcp_state = api_state.clone();
                    match mcp_port {
                        Some(p) => {
                            mcp_net.mcp_port = p;
                            tauri::async_runtime::spawn(async move {
                                respawn_mcp(mcp_app_handle, mcp_state, &mcp_net).await;
                            });
                        }
                        None => log::error!(
                            "[MCP] no free MCP port near {} — the MCP server is NOT running",
                            api_net.mcp_port
                        ),
                    }
                    // Spawn the peering fabric sidecar. Spawn failure (binary absent /
                    // not bundled) is logged and NON-FATAL — the open-core app runs
                    // fine with peering "not installed".
                    //
                    // Only the primary instance runs it: the fabric owns machine-wide
                    // singletons (its identity keypair in the OS keychain and its peer
                    // listener port), which are not profile-scoped. A second profile
                    // starting one would contend for both.
                    if crate::profile::current().is_primary() {
                        let fabric_state = api_state.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(e) =
                                crate::fabric_manager::start_fabric(fabric_app_handle, fabric_state)
                                    .await
                            {
                                log::warn!(
                                    "[FABRIC] termflow-fabric not started (peering not installed): {}",
                                    e
                                );
                            }
                        });
                    } else {
                        log::info!(
                            "[FABRIC] Not started: profile '{}' is not the primary instance",
                            crate::profile::current().name
                        );
                    }
                    crate::api_server::start_api_server(
                        api_state,
                        listener,
                        api_net.expose_on_network,
                        api_sd_rx,
                    )
                    .await;
                }
                None => log::error!(
                    "API could not bind any port near {} — the REST/WebSocket API and MCP are \
                     NOT running. Change the port in Settings > Connections.",
                    api_net.api_port
                ),
            }
        });

        // Spawn the PTY Output Listener (consumer generation 0) and the stall
        // watchdog that auto-heals it (respawn + repaint) if it ever wedges.
        // The consumer subscribes to the broadcast channel via state.output_tx.
        spawn_output_consumer(state.clone(), 0);
        spawn_pipeline_watchdog(state.clone());

        // Open the scrollback DB and start the 30s throttled flush task.
        if let Some(db) = history_db_path(&app.handle()) {
            state.history_store.init(&db);
            // Same file, its own connection. Inside the `if let` because `history_db_path`
            // returns an Option — there is no path to hand it when the DB is unavailable,
            // and the store stays disabled, reporting Err rather than an empty graph.
            state.canvas_store.init(&db);
            state.automation_store.init(&db);
            // Backlog 011: cap the global command history at startup.
            state.history_store.prune_commands(5000);
            // Stream 4: per-directory usage has higher (command,dir) cardinality; cap larger.
            state.history_store.prune_dir_usage(20000);
        }
        spawn_history_flush_task(state.clone());
        // Terminal Automations (plan 028 §2.1): the tap, the evaluator and the targeting tick.
        automation_engine::spawn(state.clone());

        Ok(())
    })
    .invoke_handler(tauri::generate_handler![
        commands::create_terminal,
        commands::report_host_restore_settled,
        commands::adopt_console_window,
        commands::set_terminal_owning_tab,
        commands::set_terminal_display_label,
        automation_commands::list_automations,
        automation_commands::get_automation_runtime,
        automation_commands::load_automation_log,
        automation_commands::list_watchable_terminals,
        automation_commands::preview_automation_targets,
        automation_commands::dry_run_automation,
        automation_commands::save_automation,
        automation_commands::add_automation_target,
        automation_commands::remove_automation_target,
        automation_commands::set_automation_verbose,
        automation_commands::delete_automation,
        automation_commands::duplicate_automation,
        automation_commands::set_automation_enabled,
        automation_commands::reset_automation,
        automation_commands::rearm_automation,
        commands::restart_for_update,
        commands::hotswap_available,
        commands::update_available,
        commands::take_reattach_prompt_hook,
        commands::probe_reattach_prompt_gate,
        commands::check_for_updates,
        commands::update_and_restart,
        commands::get_active_window,
        commands::set_active_window,
        commands::open_settings_in_main_window,
        commands::get_terminal_cwd,
        commands::get_terminal_cwds,
        commands::resolve_terminal_path,
        commands::get_os_build_number,
        open_commands::open_external,
        open_commands::open_path,
        open_commands::open_in_editor,
        open_commands::open_legal_document,
        commands::write_terminal,
        commands::resize_terminal,
        commands::get_terminal_size,
        commands::get_shell_profiles,
        commands::read_legal_document,
        // Snippets import/export (plan/029 §8.3). Tauri IPC only by design (D10) —
        // see the note above the two functions in commands.rs before adding a route.
        commands::export_snippets_file,
        commands::import_snippets_file,
        commands::quit_app,
        commands::get_profile,
        commands::save_config,
        commands::merge_config,
        commands::load_config,
        commands::close_terminal,
        commands::prune_terminal_history,
        commands::add_command_history,
        commands::rename_terminal_history,
        commands::load_command_history,
        commands::delete_command_history,
        commands::add_command_dir_usage,
        commands::load_command_dir_usage,
        commands::show_activity_notification,
        commands::check_connection_health,
        commands::generate_api_token,
        network_commands::get_network_config,
        network_commands::get_effective_endpoints,
        network_commands::set_network_config,
        network_commands::rotate_auth_token,
        network_commands::list_network_interfaces,
        network_commands::stop_servers,
        network_commands::start_servers,
        commands::diag_log,
        commands::confirm_close_app,
        commands::get_window_session_id,
        commands::list_window_session_ids,
        commands::flush_session_ack,
        commands::stash_detach_payload,
        commands::take_detach_payload,
        commands::create_detached_window,
        commands::begin_global_pane_drag,
        commands::claim_global_pane_drag,
        commands::resolve_orphan_global_drag,
        commands::cancel_global_pane_drag,
        commands::show_drag_preview,
        commands::move_drag_preview,
        commands::hide_drag_preview,
        commands::resolve_tab_drop,
        commands::create_new_window,
        commands::take_pending_open_path,
        shell_integration::install_file_manager_integration,
        shell_integration::uninstall_file_manager_integration,
        shell_integration::is_file_manager_integration_installed,
        commands::get_executable_icon,
        commands::refresh_window_menu,
        commands::set_window_title,
        commands::close_self_window,
        commands::open_devtools,
        commands::set_keep_running_in_background,
        peer_commands::fabric_status,
        peer_commands::peers_list,
        peer_commands::pending_approvals_list,
        peer_commands::pairing_code_create,
        peer_commands::peer_add,
        peer_commands::peer_approve,
        peer_commands::peer_revoke,
        peer_commands::peer_set_grant,
        peer_commands::set_accept_peers,
        peer_commands::peer_set_fleet_exec
    ])
    .on_menu_event(|app, event| {
        let id = event.id().as_ref();
        if id == "new_window" {
            match commands::open_new_window(app, None) {
                Ok(_) => commands::refresh_menu(app),
                Err(e) => log::error!("New Window failed: {}", e),
            }
        } else if let Some(label) = id.strip_prefix("focus:") {
            // Window menu entry: bring that window to the front.
            if let Some(w) = app.get_webview_window(label) {
                crate::webview_power::restore_and_focus(&w);
            }
        }
    })
    .on_window_event(|window, event| {
        // Intercept the native window close so the frontend can show an in-app
        // confirmation dialog. The actual exit happens via confirm_close_app.
        if let WindowEvent::CloseRequested { api, .. } = event {
            let app = window.app_handle();
            // Background mode (Plan 010): when "keep running in background" is on and
            // this is the LAST real window, hide it to the tray instead of prompting
            // to quit — the process (and peering) stays alive and the tray brings it
            // back. Earlier windows still go through the normal confirm-close flow.
            // Gated on a tray existing so we never hide the only window with no way
            // to reopen it.
            if window.label() != "drag-preview" && app.tray_by_id("main-tray").is_some() {
                let keep = app
                    .try_state::<AppState>()
                    .map(|s| {
                        s.keep_running_in_background
                            .load(std::sync::atomic::Ordering::Relaxed)
                    })
                    .unwrap_or(false);
                if keep {
                    let real_windows = app
                        .webview_windows()
                        .keys()
                        .filter(|l| l.as_str() != "drag-preview")
                        .count();
                    if real_windows <= 1 {
                        api.prevent_close();
                        if let Err(e) = window.hide() {
                            log::warn!("Failed to hide window to tray: {}", e);
                        }
                        return;
                    }
                }
            }
            api.prevent_close();
            // The frontend's global `listen` receives this in EVERY window
            // regardless of emit target, so we carry the closing window's label in
            // the payload and each window ignores it unless it's the target.
            let label = window.label().to_string();
            if let Err(e) = window.emit("app:close-requested", label.clone()) {
                log::warn!("Failed to emit app:close-requested for {}: {}", label, e);
            }
        }
        // A window went away — drop its recorded title and refresh the Window menu
        // so it no longer lists it.
        if let WindowEvent::Destroyed = event {
            let app = window.app_handle();
            // Outside the AppState block on purpose: this cache is a plain module-level
            // call filter, and a label reused by a later window must not inherit this
            // one's "already hidden" and skip its first real put_IsVisible.
            crate::webview_power::forget(window.label());
            if let Some(state) = app.try_state::<AppState>() {
                let restore_state = (*state).clone();
                let destroyed_label = window.label().to_string();
                tauri::async_runtime::spawn(async move {
                    restore_state.host_restore_window_destroyed(&destroyed_label).await;
                });
                state.window_titles.remove(window.label());
                // Plan 018: a closed window must not be recreated at the next
                // start. Persisted immediately, not debounced — the process may
                // exit before any later tick.
                state.windows.forget(window.label());
                // Canvas node geometry is a per-window renderer projection, never
                // durable — unlike the window registry above, which IS the thing
                // that must survive to recreate this window's peers.
                state.canvas_nodes.write().remove(window.label());
                // If the window that just closed was the API/MCP target, re-point the
                // active window at a still-live window and notify every window so their
                // titlebar indicators don't strand on a dead label.
                if state.active_window.read().as_str() == window.label() {
                    let resolved = state.resolve_active_window_label_excluding(window.label());
                    *state.active_window.write() = resolved.clone();
                    use tauri::Emitter;
                    let _ = app.emit("active-window:changed", resolved);
                }
                // Same reassignment for the Settings host: if the window that just
                // closed was "main", promote another live window so the next
                // "Open Settings" (from anywhere) targets a window that still exists.
                if state.main_window.read().as_str() == window.label() {
                    let resolved = state.resolve_main_window_label_excluding(window.label());
                    *state.main_window.write() = resolved;
                }
            }
            commands::refresh_menu(app);
            // Quit the whole app once the last *real* window is gone. Without this,
            // closing the final window via the destroy path (or dragging out its
            // last tab) leaves the process alive — the hidden `drag-preview` window
            // keeps it running — which orphans the backend + MCP sidecar (lingering
            // processes, a held API port). Only the preview may remain → exit.
            if window.label() != "drag-preview" {
                let real_windows = app
                    .webview_windows()
                    .keys()
                    .filter(|l| l.as_str() != "drag-preview")
                    .count();
                if real_windows == 0 {
                    // Background mode (Plan 010): if "keep running in background" is on
                    // and a tray exists to bring the app back, stay alive (peering
                    // keeps running) instead of exiting. This covers destroy paths that
                    // bypass CloseRequested's hide (tab tear-off, close_self_window).
                    let keep = app
                        .try_state::<AppState>()
                        .map(|s| {
                            s.keep_running_in_background
                                .load(std::sync::atomic::Ordering::Relaxed)
                        })
                        .unwrap_or(false);
                    if keep && app.tray_by_id("main-tray").is_some() {
                        log::info!(
                            "Last window destroyed but keep-running-in-background is on; staying alive in the tray."
                        );
                    } else {
                        log::info!("Last window destroyed; exiting app to avoid orphaned processes.");
                        // Via the disarm choke point: an orphaned pty-host holding
                        // armed sessions is exactly the orphan this branch exists
                        // to prevent, and this path never touches flush_then_exit.
                        commands::disarm_then_exit(app);
                    }
                }
            }
        }
        // Focus changed — refresh so the active window's checkmark moves.
        if let WindowEvent::Focused(true) = event {
            commands::refresh_menu(window.app_handle());
            if let Some(state) = window.app_handle().try_state::<AppState>() {
                state.windows.note_focus(window.label());
            }
        }

        // Hand WebView2 the "not on screen" signal while minimized, which it does not work
        // out for itself the way a standalone Chromium window does (see `webview_power`).
        //
        // Tauri exposes no Minimized event, so this listens to every event that can mean
        // the minimized state just changed and asks the window itself. Deliberately MORE
        // triggers than strictly needed: a missed hide costs some CPU, a missed restore
        // shows a blank window, so the restore path must not depend on one event arriving.
        // `webview_power::sync` filters repeats, which matters because Moved/Resized fire
        // per frame during a drag.
        if matches!(
            event,
            WindowEvent::Focused(_) | WindowEvent::Moved(_) | WindowEvent::Resized(_)
        ) {
            if let Some(w) = window.app_handle().get_webview_window(window.label()) {
                crate::webview_power::sync(&w);
            }
        }
        // Plan 018: track geometry so windows come back where they were. Both
        // events fire per frame while dragging, so the write is debounced inside
        // the tracker — only the in-memory record updates here.
        if matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
            if let Some(state) = window.app_handle().try_state::<AppState>() {
                // A window the registry never registered is skipped BEFORE any geometry
                // is read. `note_geometry` already drops it (it resolves the label to an
                // id first and returns on a miss), but merely REACHING that guard costs
                // an `is_maximized()` — and on macOS that is a MUTATING query: to ask
                // AppKit whether a borderless window is zoomed, tao swaps its style mask
                // to Titled|Resizable and back, and each swap rebuilds the whole
                // NSThemeFrame (title bar, traffic lights, their SwiftUI layout).
                //
                // The `drag-preview` window is borderless and is moved once per frame for
                // the entire length of a tab drag, so paying that here pegged the main
                // thread at 100% and froze the app until it was force-quit — for a value
                // `note_geometry` then threw away. Cheap for a registered window, ruinous
                // for this one, so the label check comes first.
                if state.windows.id_for_label(window.label()).is_some() {
                    if let (Ok(pos), Ok(size)) = (window.outer_position(), window.inner_size()) {
                        state.windows.note_geometry(
                            window.label(),
                            pos.x,
                            pos.y,
                            size.width,
                            size.height,
                            window.is_maximized().unwrap_or(false),
                        );
                    }
                    state.windows.persist_if_due();
                }
            }
        }
    })
    .build(gpu_preference::apply_to_context(context))
    .expect("error while building tauri application")
    .run(|app_handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<AppState>() {
                // Plan 028 §2.1: the ONLY writer of the automation engine's stop flag, and it runs
                // FIRST. The three loops check it at the top of every iteration and a send checks it
                // before its first write, so a quit leaves every send either unstarted or complete —
                // but only for the sends that had not started when the flag was set. Below
                // `flush_all_history` (30 s of scrollback) and two sidecar shutdowns, the engine went
                // on evaluating and could START a send through the whole of them.
                //
                // There is no log flush to perform here. Plan §7.5's table planned an internal batch
                // buffer flushed every 2 s and synchronously on Exit; M1 shipped
                // `AutomationStore::append` as write-through — the INSERT happens inside the call —
                // and did not record the change. Write-through is the better end state (a row that
                // exists is already committed, and there is no 2 s window a crash can lose) and it
                // makes §7.5's actual requirement — each entry keeping its own decision timestamp
                // rather than a flush-time `now` — trivially true. Corrected in the plan.
                state.automations.stop();
                // Persist every terminal's scrollback before the process dies.
                flush_all_history(&state);
                // Gracefully shutdown MCP server on app exit
                shutdown_mcp_server(&state);
                // Gracefully shutdown the peering fabric sidecar on app exit.
                crate::fabric_manager::shutdown_fabric(&state);
            }
            // Stop advertising this instance. A crash leaves the record behind,
            // which is why readers treat a dead pid as stale rather than trusting
            // the file's existence.
            crate::net_ports::retract(&crate::profile::current().key());
        }
    });
}
