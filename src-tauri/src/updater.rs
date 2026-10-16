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
//! - A release whose notes ask for it (or a host that cannot outlive the swap)
//!   makes the update close every terminal instead; that transaction is
//!   `state::update_full`, and this file only supplies the download and the
//!   updater launch it is given.
#![cfg(feature = "velopack-updates")]

use crate::commands::UpdateRestart;
use crate::state::{send_mcp_hold, ConfirmToken, FullRun, Target};
use termflow_pty_protocol::McpHoldReason;
use velopack::{sources::GithubSource, UpdateCheck, UpdateInfo, UpdateManager, VelopackApp};

/// The GitHub repository the Velopack release feed is published to.
/// Confirmed: releases are published on the public open-core repo.
const REPO_URL: &str = "https://github.com/PMTLabs/termflow-core";

/// Velopack startup hook — MUST be the first thing `main()` runs. Startup
/// auto-apply is disabled so only our transactional path applies an update.
pub fn run_startup_hook() {
    VelopackApp::build().set_auto_apply_on_startup(false).run();
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
        // The mode rides on the answer; the download that follows may find a
        // different release and decides.
        Ok(UpdateCheck::UpdateAvailable(info)) => crate::commands::UpdateStatus::Available {
            version: info.TargetFullRelease.Version.clone(),
            marker_mode: release_mode(&um, &info),
        },
        Ok(_) => crate::commands::UpdateStatus::UpToDate,
        Err(_) => crate::commands::UpdateStatus::NotInstalled,
    }
}

/// What the release's own notes ask of an update from the running version.
fn release_mode(um: &UpdateManager, info: &UpdateInfo) -> crate::update_policy::UpdateMode {
    crate::update_policy::update_mode(
        &um.get_current_version_as_string(),
        Some(&info.TargetFullRelease.NotesMarkdown),
    )
}

/// The file the update crate starts to apply an update, when this is an install.
pub fn update_exe_path() -> Option<std::path::PathBuf> {
    velopack::locator::auto_locate_app_manifest(velopack::locator::LocationContext::FromCurrentExe)
        .ok()
        .map(|locator| locator.get_update_path())
}

/// A release that is available and the mode its notes ask for, or `None` if
/// already up to date. Nothing is downloaded.
fn check() -> Result<Option<(UpdateInfo, crate::update_policy::UpdateMode)>, String> {
    let um = manager()?;
    match um.check_for_updates().map_err(|e| e.to_string())? {
        UpdateCheck::UpdateAvailable(info) => {
            let mode = release_mode(&um, &info);
            Ok(Some((*info, mode)))
        }
        _ => Ok(None),
    }
}

/// Fetch the package for `info`; blocking.
fn download(info: &UpdateInfo) -> Result<(), String> {
    manager()?.download_updates(info, None).map_err(|e| e.to_string())
}

/// Launch the updater and let THIS process exit gracefully (bounded wait), then
/// relaunch. Graceful exit (vs `process::exit`) lets Tauri flush state first.
fn apply(info: UpdateInfo) -> Result<(), String> {
    let um = manager()?;
    // Carry the instance identity through the restart. This
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

/// Full transactional update: download → either close every terminal (when the
/// release or a host that cannot survive the swap demands it, and the user has
/// agreed) or arm the PTY host → apply → graceful exit. An offload refuses
/// (without arming) if a hot-swap can't keep terminals alive, so nothing is lost.
pub async fn update_and_restart(
    state: &crate::state::AppState,
    confirm: Option<ConfirmToken>,
) -> Result<UpdateRestart, String> {
    // Check off the async runtime. The release's own notes decide which way it is
    // applied, and whether the checks that only an offload needs come first.
    let checked = tokio::task::spawn_blocking(check)
        .await
        .map_err(|e| e.to_string())??;
    let (info, marker_mode) = match checked {
        Some(checked) => checked,
        None => return Err("no update available".to_string()),
    };
    let target = Target { version: info.TargetFullRelease.Version.clone(), marker_mode };

    // An offload refuses before it costs a download. Skipped when the release or a
    // host that cannot outlive the swap makes this a full update: that is not
    // subject to these, and has its own checks once it is downloaded.
    let offload = marker_mode == crate::update_policy::UpdateMode::Offload
        && crate::state::update_refusal(&state.owned_hosts_now()).is_ok();
    // Fresh survivability preflight (H1): if any terminal is in-process / the
    // sidecar can't survive, refuse now.
    if offload {
        log::info!("[UPDATE] update_and_restart: running survivability preflight");
        crate::commands::hotswap_preflight(state)?;
    }
    // Siblings are CHECKED here but not armed until after the download. Velopack
    // kills every process under the install root, so a sibling loses its GUI to
    // our apply — but its pty-host lives outside that root and survives, so its
    // shells only die if it never armed. Refusing outright (the old behaviour)
    // was a coordination gap, not a safety floor (design 014 §B1).
    let own = crate::profile::current().key();
    if offload {
        let siblings = crate::net_ports::live_siblings_now(&own)
            .map_err(|e| format!("cannot enumerate sibling instances: {e}"))?;
        if let Some(reason) = crate::sibling_coord::describe_unarmable(&siblings) {
            log::warn!("[UPDATE] refused: {reason}");
            return Err(reason);
        }
    }

    // Download off the async runtime.
    let package = info.clone();
    tokio::task::spawn_blocking(move || download(&package))
        .await
        .map_err(|e| e.to_string())??;
    log::info!("[UPDATE] downloaded {}", target.version);

    let info = match state
        .run_full_update(&target, confirm, info, |info| async move {
            tokio::task::spawn_blocking(move || apply(info))
                .await
                .map_err(|e| e.to_string())
                .and_then(|r| r)
        })
        .await?
    {
        FullRun::Offload(info) => info,
        FullRun::NeedsConfirmation(needed) => return Ok(UpdateRestart::NeedsConfirmation(needed)),
        FullRun::Exited => return Ok(UpdateRestart::Started),
    };

    // The download can take minutes: look again at this instance's terminals now
    // that it is done, in case one was opened in-process meanwhile.
    crate::commands::hotswap_preflight(state)?;
    log::info!("[UPDATE] arming host before apply");

    // Close admission to the hosts and look again at every one this instance owns,
    // now that the download is done: a host that dropped, or a create still in
    // flight, while it ran must not be armed over. Nothing is armed yet, so
    // returning on any refusal below just drops the hold, which reopens admission.
    let mut hold = state.begin_update().await?;
    // An update that would have to close terminals is not an offload: refuse
    // rather than lose them.
    if let Err(reason) = hold.update_refusal() {
        log::warn!("[UPDATE] refused: {reason}");
        return Err(reason);
    }

    // Arm the SIBLINGS first, then ourselves.
    //
    // Deliberately AFTER the download: a failed or unavailable download must
    // never leave a stranger armed. `arm_siblings` is itself all-or-nothing and
    // rolls back what it armed, so reaching the next line means every sibling is
    // prepared.
    // RE-ENUMERATE. The check above ran before a download that can take minutes,
    // and a profile launched during it would not be in that snapshot — so it
    // would never be armed, and the apply would kill its GUI with an unarmed
    // host, destroying exactly the shells this mechanism exists to save. The
    // earlier list is a fail-fast courtesy; THIS one is the one we act on —
    // and it fails closed the same way: the download is left unapplied rather
    // than applied over a sibling nobody could read.
    let siblings = crate::net_ports::live_siblings_now(&own)
        .map_err(|e| format!("cannot enumerate sibling instances: {e}"))?;
    let armed_siblings =
        crate::sibling_coord::arm_siblings(&siblings, crate::sibling_coord::http_call).await?;
    if !armed_siblings.is_empty() {
        log::info!(
            "[UPDATE] armed {} sibling(s): {armed_siblings:?}",
            armed_siblings.len()
        );
    }

    // Arm every host this instance owns so shells survive, and wait for the acks
    // BEFORE applying. All or none: a host that refuses has the others put back.
    let token = crate::pty_host_client::resolve_token();
    if let Err(e) = hold
        .arm_detach(
            termflow_pty_protocol::LOCAL_HOLD_ACTIVE_SECS,
            &token,
            Some(termflow_pty_protocol::ArmDetachPurpose::Local),
        )
        .await
    {
        // We armed strangers for an update that cannot now proceed. Put them
        // back before returning, or each holds a 600s window it never asked for.
        let _ = crate::sibling_coord::disarm_siblings(
            &siblings,
            &armed_siblings,
            &crate::sibling_coord::http_call,
        )
        .await;
        return Err(e);
    }

    // Hand the MCP port to a pty-host so agents get a timed wait while the update applies. Best
    // effort; the failure arm below takes it back.
    let handed = send_mcp_hold(state, hold, McpHoldReason::OffloadUpdate).await;

    // Launch the updater (it waits for our exit), then quit — the relaunched app
    // reattaches sessions by `tab_id`. If the updater fails to launch AFTER we
    // armed, DISARM synchronously — otherwise the host stays armed and a later
    // normal quit would orphan sessions instead of tearing down (an updater that
    // fails to launch must disarm synchronously).
    if let Err(e) = tokio::task::spawn_blocking(move || apply(info))
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r)
    {
        log::warn!("[UPDATE] updater failed to launch after arming ({e}); disarming");
        // Every host that was armed is disarmed again; one that does not
        // acknowledge is logged by name and may still hold its detach window until
        // a later quit releases it.
        handed.release().await;
        // Same obligation for the siblings we armed. Disarming ourselves and
        // leaving them armed would be the asymmetry this rollback exists to
        // avoid — they armed for OUR update, and it is not happening.
        let _ = crate::sibling_coord::disarm_siblings(
            &siblings,
            &armed_siblings,
            &crate::sibling_coord::http_call,
        )
        .await;
        return Err(e);
    }
    // `apply` only started the updater: it waits for this process to exit before
    // it swaps anything, so no sibling has been touched yet. Release the siblings
    // now, best-effort like the rollback paths above, so one whose app the swap
    // never reaches is not left holding a 600s window it will never use. One that
    // cannot be reached expires its own window, and self-disarms on its own next
    // reconnect (state.rs `ensure_pty_host_inner`) — the two paths cover each other.
    let _ = crate::sibling_coord::disarm_siblings(
        &siblings,
        &armed_siblings,
        &crate::sibling_coord::http_call,
    )
    .await;
    // Let every window persist its state (cwd snapshot included) before we drop
    // it. `app_handle.exit(0)` is a hard process termination — the comment above
    // used to assume Tauri would still "flush tab/session state" on the way out,
    // but nothing actually asked the windows to; see `commands::flush_all_windows`.
    crate::commands::flush_all_windows(&state.app_handle).await;
    log::info!("[UPDATE] updater launched; exiting gracefully — host holds the sessions");
    // Admission stays closed until the process is gone.
    handed.commit();
    state.app_handle.exit(0);
    Ok(UpdateRestart::Started)
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
    /// The body of `fn <name>`, found by counting braces from its opening `{`,
    /// with `//` line comments stripped. Without stripping, prose that
    /// mentions real code tokens out of order (e.g. explaining what a fix
    /// changed) reads as if it WERE the code, to a naive substring search.
    fn fn_body(src: &str, signature: &str) -> String {
        let start = src.find(signature).unwrap_or_else(|| {
            panic!("`{signature}` not found — this guard must fail loudly, not pass vacuously")
        });
        let rest = &src[start..];
        let open = rest.find('{').expect("no body");
        let mut depth = 0usize;
        for (i, c) in rest[open..].char_indices() {
            match c {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return strip_line_comments(&rest[open..open + i + 1]);
                    }
                }
                _ => {}
            }
        }
        panic!("unbalanced braces after `{signature}`");
    }

    fn strip_line_comments(src: &str) -> String {
        src.lines()
            .map(|line| line.find("//").map_or(line, |i| &line[..i]))
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn source() -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("updater.rs");
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
        assert_eq!(
            occurrences, 2,
            "expected exactly the arm_detach and apply failure returns: {body}"
        );
        let success_tail = body
            .rsplit("return Err(e);")
            .next()
            .expect("split is never empty");
        assert!(
            success_tail.contains("disarm_siblings"),
            "a successful update must disarm the siblings it armed, on the \
             success path — not only on failure. Tail after the last failure return:\n{success_tail}"
        );
    }

    /// The reported bug's twin in the real Velopack path: `update_and_restart`
    /// armed and exited with no chance for the renderer to persist a just-`cd`'d
    /// tab's cwd — the comment above the exit even claimed "Tauri flushes
    /// tab/session state" on a hard `app_handle.exit(0)`, which nothing actually
    /// did. Pins that it now runs `commands::flush_all_windows` before exiting,
    /// same as `restart_for_update` (see
    /// `commands::the_offload_path_flushes_cwd_state_before_exiting`).
    #[test]
    fn update_and_restart_flushes_cwd_state_before_exiting() {
        let body = fn_body(&source(), "pub async fn update_and_restart");
        assert!(
            body.contains("flush_all_windows"),
            "update_and_restart must flush every window's state (cwd snapshot \
             included) before exiting. Body:\n{body}"
        );
        let flush_at = body.find("flush_all_windows").expect("checked above");
        let exit_at = body
            .find(".exit(")
            .expect("update_and_restart must still exit");
        assert!(
            flush_at < exit_at,
            "flush_all_windows must be awaited BEFORE exit(0) — after would persist \
             nothing, the process is already gone. Body:\n{body}"
        );
    }

    /// Plan 045 AC9: admin tabs are never restored elevated across a real
    /// Plan 058 AC1 / AC2: in-app update arms the elevated sidecar to survive the
    /// update in runtime_host_dir(), so it is NOT shut down before exiting.
    #[test]
    fn update_and_restart_arms_and_does_not_shut_down_elevated_host() {
        let body = fn_body(&source(), "pub async fn update_and_restart");
        let stripped = strip_line_comments(&body);
        assert!(
            !stripped.contains("state.elevated_host.shutdown"),
            "update_and_restart must NOT tear down state.elevated_host (must hold across update). Body:\n{body}"
        );
        assert!(
            stripped.contains("hold\n        .arm_detach") || stripped.contains("hold.arm_detach"),
            "update_and_restart must arm via hold.arm_detach. Body:\n{body}"
        );
    }
}

/// The census of the MCP handover on this path (plan 055 T6): the handover is live, awaited, carries
/// `OffloadUpdate`, comes after the Local arm's whole error block and before the apply, is released
/// on the apply-failure arm and committed before the exit. Each negative case edits the real text.
#[cfg(test)]
mod mcp_handover_census_tests {
    use crate::state::mcp_exit_census_tests::{check_exit_path, UPDATE_AND_RESTART};
    use crate::state::mcp_hold_census_tests::mutate;

    const SOURCE: &str = include_str!("updater.rs");
    const HANDOVER: &str = "let handed = send_mcp_hold(state, hold, McpHoldReason::OffloadUpdate).await;";

    #[test]
    fn update_and_restart_hands_over_releases_on_a_failed_apply_and_commits_before_it_exits() {
        // The full-update `apply(` that precedes the Local arm is valid and ignored.
        check_exit_path(SOURCE, &UPDATE_AND_RESTART).unwrap();
    }

    #[test]
    fn the_updater_census_kills_each_planted_mutation() {
        let cases: Vec<(&str, String)> = vec![
            ("an unawaited call bound to `_`", mutate(SOURCE, HANDOVER, "let _ = send_mcp_hold(state, hold, McpHoldReason::OffloadUpdate);")),
            ("the handover dropped at once", mutate(SOURCE, HANDOVER, "let _ = send_mcp_hold(state, hold, McpHoldReason::OffloadUpdate).await;")),
            ("a duplicated call", mutate(SOURCE, HANDOVER, &format!("{HANDOVER}
    {}", HANDOVER.replace("handed", "again")))),
            ("the wrong reason", mutate(SOURCE, "McpHoldReason::OffloadUpdate).await", "McpHoldReason::Offload).await")),
            ("a substituted state operand", mutate(SOURCE, "send_mcp_hold(state, hold", "send_mcp_hold(other, hold")),
            ("the call inside a block comment", mutate(SOURCE, HANDOVER, &format!("/* {HANDOVER} */"))),
            ("the call inside a string literal", mutate(SOURCE, HANDOVER, "let _s = \"send_mcp_hold(state, hold)\";")),
            ("the call inside `if false`", mutate(SOURCE, HANDOVER, &format!("if false {{ {HANDOVER} }}"))),
            ("the call inside a closure", mutate(SOURCE, HANDOVER, &format!("let _f = || {{ {HANDOVER} }};"))),
            ("the call inside the Local arm's own error block", {
                let cut = mutate(SOURCE, HANDOVER, "");
                mutate(&cut, "        return Err(e);
    }

    // Hand the MCP", &format!("        {HANDOVER}
        return Err(e);
    }}

    // Hand the MCP"))
            }),
            ("the call after the apply", {
                let cut = mutate(SOURCE, HANDOVER, "");
                mutate(&cut, "    // `apply` only started the updater", &format!("    {HANDOVER}
    // `apply` only started the updater"))
            }),
            ("the call after flush_all_windows", {
                let cut = mutate(SOURCE, HANDOVER, "");
                mutate(&cut, "crate::commands::flush_all_windows(&state.app_handle).await;", &format!("crate::commands::flush_all_windows(&state.app_handle).await;
    {HANDOVER}"))
            }),
            ("a hold still released after the handover", mutate(SOURCE, HANDOVER, &format!("{HANDOVER}
    hold.release().await;"))),
            ("an unawaited release", mutate(SOURCE, "handed.release().await;", "handed.release();")),
            ("the release inside `if false`", mutate(SOURCE, "handed.release().await;", "if false { handed.release().await; }")),
            ("the release in a closure", mutate(SOURCE, "handed.release().await;", "let _f = || { handed.release() };")),
            ("the release in an async block", mutate(SOURCE, "handed.release().await;", "let _f = async { handed.release().await; };")),
            ("the release after the arm's return", {
                let cut = mutate(SOURCE, "handed.release().await;", "");
                mutate(&cut, "        return Err(e);
    }
    // `apply` only started", "        return Err(e);
        handed.release().await;
    }
    // `apply` only started")
            }),
            ("the release on a different binding", mutate(SOURCE, "handed.release().await;", "other.release().await;")),
            ("a missing release", mutate(SOURCE, "handed.release().await;", "")),
            ("a missing commit", mutate(SOURCE, "handed.commit();", "")),
            ("the commit inside `if false`", mutate(SOURCE, "handed.commit();", "if false { handed.commit(); }")),
            ("the commit after the exit", {
                let cut = mutate(SOURCE, "handed.commit();", "");
                mutate(&cut, "state.app_handle.exit(0);", "state.app_handle.exit(0);
    handed.commit();")
            }),
            ("an early return before the handover", mutate(SOURCE, HANDOVER, &format!("return Ok(());\n    {HANDOVER}"))),
            ("an early return before the commit", mutate(SOURCE, "handed.commit();", "return Ok(());\n    handed.commit();")),
        ];
        for (name, source) in cases {
            let verdict = check_exit_path(&source, &UPDATE_AND_RESTART);
            eprintln!("{name} => {verdict:?}");
            assert!(verdict.is_err(), "the census let this mutation through: {name}");
        }
    }
}

/// Plan 055 T8 (I2), the parallel path on the updater: the full (non-offload) update returns before
/// the Local arm, so it never reaches the MCP handover. The census reads the real text of
/// `update_and_restart`; each negative case edits it and must fail.
#[cfg(test)]
mod mcp_parallel_path_census_tests {
    use crate::state::live_call_census::{find_calls, is_return, word_uses, Kind, Src, Sub};
    use crate::state::mcp_hold_census_tests::mutate;

    const SOURCE: &str = include_str!("updater.rs");
    const UPDATE_FULL: &str = include_str!("state/update_full.rs");
    const SIGNATURE: &str = "pub async fn update_and_restart(";
    const LOCAL: &str = "termflow_pty_protocol::ArmDetachPurpose::Local";

    fn check_full_update_branch(text: &str, update_full: &str) -> Result<(), String> {
        let src = Src::production(text);
        let body = src.try_function(SIGNATURE)?;
        let in_body = body.open..body.close + 1;

        let runs = find_calls(&src.masked[in_body.clone()], "run_full_update");
        if runs.len() != 1 {
            return Err(format!("expected exactly one `run_full_update` call in the function, found {}", runs.len()));
        }
        let run_at = in_body.start + runs[0];
        let index = body.top_index(run_at).ok_or("the full update is not a top-level statement")?;
        if body.constructs_at(run_at).iter().any(Kind::is_conditional) {
            return Err("the full update sits inside a conditional, closure or async construct".into());
        }
        let stmt = &body.stmts[index];

        // Every way out of the match that is not "carry on as an offload" must leave the function.
        let arms = stmt
            .subs
            .iter()
            .find_map(|sub| match sub {
                Sub::Match { arms, .. } => Some(arms),
                _ => None,
            })
            .ok_or("the full-update statement does not match on its result")?;
        if arms.len() != 3 {
            return Err(format!("the full-update match has {} arms, expected 3", arms.len()));
        }
        let mut offloads = 0;
        for arm in arms {
            let pattern: String = arm.pattern.chars().filter(|c| !c.is_whitespace()).collect();
            let text = src.norm(&arm.body);
            let text = text.trim_end_matches(',');
            if pattern.starts_with("FullRun::Offload(") {
                offloads += 1;
                if text != "info" {
                    return Err(format!("the offload arm is not `info` but `{text}`"));
                }
                continue;
            }
            // The keyword, on the masked text (`returned_info` is not a return), as the arm's
            // expression or as a statement that runs in the arm's block.
            let returns = match &arm.block {
                None => is_return(&src.masked[arm.body.clone()]),
                Some(b) => b.live_position(|s| is_return(&src.masked[s.span.clone()])).is_some(),
            };
            if !returns {
                return Err(format!("the `{pattern}` arm does not return from the function"));
            }
        }
        if offloads != 1 {
            return Err(format!("expected exactly one offload arm, found {offloads}"));
        }

        // Before the Local arm, and before every handover.
        let locals = find_calls(&src.masked[in_body.clone()], LOCAL);
        if locals.len() != 1 {
            return Err(format!("expected exactly one Local arm, found {}", locals.len()));
        }
        let anchor = body.top_index(in_body.start + locals[0]).ok_or("the Local arm is not a top-level statement")?;
        if index >= anchor {
            return Err("the full-update branch comes after the Local arm".into());
        }
        for at in find_calls(&src.masked[in_body.clone()], "send_mcp_hold") {
            let at = in_body.start + at;
            if at < stmt.span.end {
                return Err("a handover is sent at or before the full-update branch".into());
            }
        }

        // The full-update machinery itself never names the handover.
        let machinery = Src::production(update_full);
        for word in ["send_mcp_hold", "McpHoldReason", "HandedOver"] {
            if !word_uses(&machinery.masked, 0..machinery.masked.len(), word).is_empty() {
                return Err(format!("update_full.rs uses `{word}`"));
            }
        }
        Ok(())
    }

    /// The real statement of the full-update branch, from its `let` to its closing `};`.
    fn full_update_statement(source: &str) -> String {
        let source = source.replace("\r\n", "\n");
        let start = source.find("    let info = match state\n").expect("the full-update statement");
        let end_marker = "FullRun::Exited => return Ok(UpdateRestart::Started),\n    };\n";
        let end = source[start..].find(end_marker).expect("its end") + start + end_marker.len();
        source[start..end].to_string()
    }

    #[test]
    fn the_full_update_branch_returns_before_the_local_arm_and_sends_no_hold() {
        check_full_update_branch(SOURCE, UPDATE_FULL).unwrap();
    }

    #[test]
    fn the_full_update_census_kills_each_planted_mutation() {
        let statement = full_update_statement(SOURCE);
        let no_statement = mutate(SOURCE, &statement, "");
        let hand = "let _held = send_mcp_hold(state, hold, McpHoldReason::OffloadUpdate).await;";
        let cases: Vec<(&str, String, String)> = vec![
            (
                "the exited arm falls through",
                mutate(SOURCE, "FullRun::Exited => return Ok(UpdateRestart::Started),", "FullRun::Exited => info_placeholder,"),
                UPDATE_FULL.into(),
            ),
            (
                "the needs-confirmation arm falls through",
                mutate(SOURCE, "FullRun::NeedsConfirmation(needed) => return Ok(UpdateRestart::NeedsConfirmation(needed)),", "FullRun::NeedsConfirmation(needed) => { log::info!(\"x\"); }"),
                UPDATE_FULL.into(),
            ),
            (
                "an expression arm that names a `returned…` value instead of returning",
                mutate(SOURCE, "FullRun::NeedsConfirmation(needed) => return Ok(UpdateRestart::NeedsConfirmation(needed)),", "FullRun::NeedsConfirmation(_needed) => returned_info,"),
                UPDATE_FULL.into(),
            ),
            (
                "a block arm whose statement merely starts with `return…`",
                mutate(SOURCE, "FullRun::Exited => return Ok(UpdateRestart::Started),", "FullRun::Exited => { returned_count += 1; returned_info }"),
                UPDATE_FULL.into(),
            ),
            (
                "the exited arm only returns under a condition",
                mutate(SOURCE, "FullRun::Exited => return Ok(UpdateRestart::Started),", "FullRun::Exited => { if keep_going { return Ok(UpdateRestart::Started); } }"),
                UPDATE_FULL.into(),
            ),
            (
                "the offload arm yields something other than the info",
                mutate(SOURCE, "FullRun::Offload(info) => info,", "FullRun::Offload(_) => other_info,"),
                UPDATE_FULL.into(),
            ),
            (
                "an extra arm",
                mutate(SOURCE, "FullRun::Exited => return Ok(UpdateRestart::Started),", "FullRun::Exited => return Ok(UpdateRestart::Started),\n        FullRun::Other => info,"),
                UPDATE_FULL.into(),
            ),
            (
                "the branch moved after the Local arm",
                mutate(&no_statement, "    // Hand the MCP port to a pty-host so agents get a timed wait while the update applies.", &format!("{statement}    // Hand the MCP port to a pty-host so agents get a timed wait while the update applies.")),
                UPDATE_FULL.into(),
            ),
            (
                "the branch inside `if false`",
                mutate(SOURCE, &statement, &format!("if false {{\n{statement}}}\n")),
                UPDATE_FULL.into(),
            ),
            (
                "the branch inside a closure",
                mutate(SOURCE, &statement, &format!("let _f = || {{\n{statement}}};\n")),
                UPDATE_FULL.into(),
            ),
            ("the branch removed", no_statement.clone(), UPDATE_FULL.into()),
            (
                "the branch only in a comment",
                mutate(SOURCE, &statement, &format!("/*\n{statement}*/\n")),
                UPDATE_FULL.into(),
            ),
            (
                "a second full-update call",
                mutate(SOURCE, &statement, &format!("{statement}    let _again = state.run_full_update(&target, confirm, info.clone(), |i| async move {{ Ok(()) }}).await;\n")),
                UPDATE_FULL.into(),
            ),
            (
                "a handover sent from inside the full-update branch",
                mutate(SOURCE, "FullRun::Exited => return Ok(UpdateRestart::Started),", &format!("FullRun::Exited => {{ {hand} return Ok(UpdateRestart::Started) }}")),
                UPDATE_FULL.into(),
            ),
            (
                "a handover sent before the full-update branch",
                mutate(SOURCE, &statement, &format!("    {hand}\n{statement}")),
                UPDATE_FULL.into(),
            ),
            (
                "the full-update machinery sends the hold",
                SOURCE.into(),
                format!("{UPDATE_FULL}\nasync fn leak(state: &AppState, hold: Hold) {{ let _h = send_mcp_hold(state, hold, McpHoldReason::OffloadUpdate).await; }}\n"),
            ),
            (
                "the full-update machinery names the reason type",
                SOURCE.into(),
                format!("{UPDATE_FULL}\nfn leak() -> McpHoldReason {{ McpHoldReason::Offload }}\n"),
            ),
        ];
        for (name, updater, machinery) in cases {
            let verdict = check_full_update_branch(&updater, &machinery);
            eprintln!("{name} => {verdict:?}");
            assert!(verdict.is_err(), "the census let this mutation through: {name}");
        }
    }

    #[test]
    fn a_comment_naming_the_handover_in_the_full_update_machinery_is_fine() {
        let commented = format!("{UPDATE_FULL}\n// never calls send_mcp_hold: the full update returns before the Local arm\n");
        check_full_update_branch(SOURCE, &commented).unwrap();
    }
}
