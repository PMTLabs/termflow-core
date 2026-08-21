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
    // Carry the instance identity through the restart (plan 018 Task 10). This
    // was `Vec::new()`, so `--profile work` came back as the DEFAULT profile —
    // a different config file, a different window registry and an empty storage
    // scope. The user reads that as the update having eaten their session.
    let restart_args = crate::profile::relaunch_args(crate::profile::current());
    if !restart_args.is_empty() {
        log::info!("[UPDATE] relaunching with {restart_args:?}");
    }
    um.wait_exit_then_apply_updates(&info, false, true, restart_args)
        .map_err(|e| e.to_string())
}

/// Full transactional update: preflight → download → arm the PTY host → apply →
/// graceful exit. Refuses (without arming) if a hot-swap can't keep terminals
/// alive, so nothing is lost.
pub async fn update_and_restart(state: &crate::state::AppState) -> Result<(), String> {
    // Fresh survivability preflight immediately before we commit (H1): if any
    // terminal is in-process / the sidecar can't survive, refuse now.
    log::info!("[UPDATE] update_and_restart: running survivability preflight");
    crate::commands::hotswap_preflight(state)?;
    // Siblings are CHECKED here but not armed until after the download. Velopack
    // kills every process under the install root, so a sibling loses its GUI to
    // our apply — but its pty-host lives outside that root and survives, so its
    // shells only die if it never armed. Refusing outright (the old behaviour)
    // was a coordination gap, not a safety floor (design 014 §B1).
    let own = crate::profile::current().key();
    let siblings = crate::net_ports::live_siblings_now(&own);
    if let Some(reason) = crate::sibling_coord::describe_unarmable(&siblings) {
        log::warn!("[UPDATE] refused: {reason}");
        return Err(reason);
    }

    // Check + download off the async runtime.
    let info = tokio::task::spawn_blocking(check_and_download)
        .await
        .map_err(|e| e.to_string())??;
    let info = match info {
        Some(i) => i,
        None => return Err("no update available".to_string()),
    };
    log::info!(
        "[UPDATE] downloaded {}; arming host before apply",
        info.TargetFullRelease.Version
    );

    // Arm the SIBLINGS first, then ourselves.
    //
    // Deliberately AFTER the download: a failed or unavailable download must
    // never leave a stranger armed. `arm_siblings` is itself all-or-nothing and
    // rolls back what it armed, so reaching the next line means every sibling is
    // prepared (design 014 §B3).
    // RE-ENUMERATE. The check above ran before a download that can take minutes,
    // and a profile launched during it would not be in that snapshot — so it
    // would never be armed, and the apply would kill its GUI with an unarmed
    // host, destroying exactly the shells this mechanism exists to save. The
    // earlier list is a fail-fast courtesy; THIS one is the one we act on.
    let siblings = crate::net_ports::live_siblings_now(&own);
    let armed_siblings =
        crate::sibling_coord::arm_siblings(&siblings, crate::sibling_coord::http_call).await?;
    if !armed_siblings.is_empty() {
        log::info!("[UPDATE] armed {} sibling(s): {armed_siblings:?}", armed_siblings.len());
    }

    // Arm our own host so shells survive, and wait for the ack BEFORE applying.
    let client = match state.pty_host_clone() {
        Some(c) => c,
        None => {
            // We armed strangers for an update that cannot now proceed. Put them
            // back before returning, or each holds a 600s window it never asked for.
            let _ = crate::sibling_coord::disarm_siblings(
                &siblings, &armed_siblings, &crate::sibling_coord::http_call,
            ).await;
            return Err("pty-host not connected — nothing to keep alive".to_string());
        }
    };
    let token = crate::pty_host_client::resolve_token();
    if let Err(e) = client.arm_detach(600, &token).await {
        let _ = crate::sibling_coord::disarm_siblings(
            &siblings, &armed_siblings, &crate::sibling_coord::http_call,
        ).await;
        return Err(e);
    }

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
        log::warn!("[UPDATE] updater failed to launch after arming ({e}); disarming");
        client.disarm().await;
        // Same obligation for the siblings we armed. Disarming ourselves and
        // leaving them armed would be the asymmetry this rollback exists to
        // avoid — they armed for OUR update, and it is not happening.
        let _ = crate::sibling_coord::disarm_siblings(
            &siblings, &armed_siblings, &crate::sibling_coord::http_call,
        ).await;
        return Err(e);
    }
    // Apply succeeded, so Velopack's kill-and-swap (if it reached a sibling at
    // all) has already happened — any sibling still standing was never touched
    // and must not be left holding a 600s window it will never use. A sibling
    // that WAS killed is unreachable here (best-effort, same as the rollback
    // paths above) but self-disarms on its own next reconnect (state.rs
    // `ensure_pty_host_inner`) — the two paths cover each other.
    let _ = crate::sibling_coord::disarm_siblings(
        &siblings, &armed_siblings, &crate::sibling_coord::http_call,
    ).await;
    log::info!("[UPDATE] updater launched; exiting gracefully — host holds the sessions");
    state.app_handle.exit(0);
    Ok(())
}

/// The success path used to arm siblings and then just exit — nothing ever
/// disarmed a sibling whose GUI survived the apply untouched, so it stayed
/// armed (and therefore Held-not-TornDown on its own later normal quit) for
/// no reason for up to 24h (`pty-host/src/manager.rs` MAX_ARM_SECS). Only the
/// failure/refusal branches disarmed. Asserted from source: exercising the
/// real function needs a live Velopack install + a real pty-host + a live
/// sibling instance, none of which exist in a unit-test process.
#[cfg(test)]
mod arm_lifecycle_wiring_tests {
    /// The body of `fn <name>`, found by counting braces from its opening `{`.
    fn fn_body(src: &str, signature: &str) -> String {
        let start = src
            .find(signature)
            .unwrap_or_else(|| panic!("`{signature}` not found — this guard must fail loudly, not pass vacuously"));
        let rest = &src[start..];
        let open = rest.find('{').expect("no body");
        let mut depth = 0usize;
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
        panic!("unbalanced braces after `{signature}`");
    }

    fn source() -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("updater.rs");
        std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("cannot read {} ({e})", path.display()))
            .replace("\r\n", "\n")
    }

    /// The reported bug's sibling twin: a sibling armed for our update but
    /// never touched by the apply must be released on the SAME success path
    /// that armed it, not left to expire a deadline nothing ever checks.
    #[test]
    fn a_successful_apply_disarms_the_siblings_it_armed() {
        let body = fn_body(&source(), "pub async fn update_and_restart");
        // `return Err(e);` (that exact binding name) closes both the
        // `arm_detach` failure branch AND the `apply` failure branch, in that
        // order, and nothing else in this function. Splitting on it and
        // taking the LAST piece leaves exactly the SUCCESS tail — past both
        // failure branches' own `disarm_siblings` calls — so a disarm found
        // only in those earlier branches does not satisfy this.
        let occurrences = body.matches("return Err(e);").count();
        assert_eq!(occurrences, 2, "expected exactly the arm_detach and apply failure returns: {body}");
        let success_tail = body.rsplit("return Err(e);").next().expect("split is never empty");
        assert!(
            success_tail.contains("disarm_siblings"),
            "a successful update must disarm the siblings it armed, on the \
             success path — not only on failure. Tail after the last failure return:\n{success_tail}"
        );
    }
}
