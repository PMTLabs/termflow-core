//! Velopack auto-update integration for the GitHub distribution channel.
//!
//! Entirely behind the `velopack-updates` cargo feature (OFF by default). The
//! store flavors (MS Store / Apple App Store) omit the feature so no updater
//! code ships there. Design 003 §10; review 056 C2/C5.
//!
//! Runtime notes:
//! - `run_startup_hook` disables Velopack's startup auto-apply (C2): a pending
//!   package is applied ONLY by our explicit, arm-first transaction.
//! - Network/package work is synchronous, so it runs on a blocking worker, never
//!   a Tokio async thread (review 056 M1).
//! - The apply uses `wait_exit_then_apply_updates` + a graceful Tauri exit
//!   (NOT `process::exit`), so tab/session state is flushed before we quit and
//!   the relaunched app can reattach by `tab_id` (C5).
#![cfg(feature = "velopack-updates")]

use velopack::{sources::GithubSource, UpdateCheck, UpdateInfo, UpdateManager, VelopackApp};

/// The GitHub repository the Velopack release feed is published to.
/// Confirmed: releases are published on the public open-core repo.
const REPO_URL: &str = "https://github.com/PMTLabs/termflow-core";

/// Velopack startup hook — MUST be the first thing `main()` runs. Startup
/// auto-apply is disabled so only our transactional path applies an update.
pub fn run_startup_hook() {
    VelopackApp::build()
        .set_auto_apply_on_startup(false)
        .run();
}

/// Build an `UpdateManager` for the GitHub source. `new` returns an error when
/// the app is NOT a Velopack install (dev, store, `cargo run`) — the caller maps
/// that to `NotInstalled` and no-ops.
fn manager() -> Result<UpdateManager, String> {
    let source = GithubSource::new(REPO_URL, None, false);
    UpdateManager::new(source, None, None).map_err(|e| e.to_string())
}

/// Non-blocking availability check for the "Check for updates" UI.
pub fn check_status() -> crate::commands::UpdateStatus {
    let um = match manager() {
        Ok(um) => um,
        Err(_) => return crate::commands::UpdateStatus::NotInstalled,
    };
    match um.check_for_updates() {
        Ok(UpdateCheck::UpdateAvailable(info)) => crate::commands::UpdateStatus::Available {
            version: info.TargetFullRelease.Version.clone(),
        },
        Ok(_) => crate::commands::UpdateStatus::UpToDate,
        Err(_) => crate::commands::UpdateStatus::NotInstalled,
    }
}

/// Check + download in one blocking step. `Ok(Some(info))` if an update was
/// fetched and is ready to apply; `Ok(None)` if already up to date.
fn check_and_download() -> Result<Option<UpdateInfo>, String> {
    let um = manager()?;
    match um.check_for_updates().map_err(|e| e.to_string())? {
        UpdateCheck::UpdateAvailable(info) => {
            um.download_updates(&info, None).map_err(|e| e.to_string())?;
            Ok(Some(*info))
        }
        _ => Ok(None),
    }
}

/// Launch the updater and let THIS process exit gracefully (bounded wait), then
/// relaunch. Graceful exit (vs `process::exit`) lets Tauri flush state first.
fn apply(info: UpdateInfo) -> Result<(), String> {
    let um = manager()?;
    um.wait_exit_then_apply_updates(&info, false, true, Vec::<String>::new())
        .map_err(|e| e.to_string())
}

/// Full transactional update: preflight → download → arm the PTY host → apply →
/// graceful exit. Refuses (without arming) if a hot-swap can't keep terminals
/// alive, so nothing is lost.
pub async fn update_and_restart(state: &crate::state::AppState) -> Result<(), String> {
    // Fresh survivability preflight immediately before we commit (H1): if any
    // terminal is in-process / the sidecar can't survive, refuse now.
    crate::commands::hotswap_preflight(state)?;

    // Check + download off the async runtime.
    let info = tokio::task::spawn_blocking(check_and_download)
        .await
        .map_err(|e| e.to_string())??;
    let info = match info {
        Some(i) => i,
        None => return Err("no update available".to_string()),
    };

    // Arm the host so shells survive, and wait for the ack BEFORE applying.
    let client = state
        .pty_host_clone()
        .ok_or_else(|| "pty-host not connected — nothing to keep alive".to_string())?;
    let token = crate::pty_host_client::resolve_token();
    client.arm_detach(600, &token).await?;

    // Launch the updater (it waits for our exit), then quit gracefully so Tauri
    // flushes tab/session state the relaunched app reattaches by `tab_id`. If the
    // updater fails to launch AFTER we armed, DISARM synchronously — otherwise
    // the host stays armed and a later normal quit would orphan sessions instead
    // of tearing down (design §10.5 "updater-launch failure → synchronous Disarm").
    if let Err(e) = tokio::task::spawn_blocking(move || apply(info))
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r)
    {
        client.disarm().await;
        return Err(e);
    }
    state.app_handle.exit(0);
    Ok(())
}
