//! Update / hot-swap / offload preflight checks, and the reattach prompt-gate
//! seed. Split out of the former `commands.rs`.

use super::window::flush_all_windows;
use crate::state::AppState;
use tauri::State;

/// Arm the sidecar hot-swap hold and quit the app so its `.exe` unlocks for a
/// rebuild. The sidecar keeps every PTY (and its CLI) alive; the next launch
/// reattaches. Refuses if the sidecar isn't connected or couldn't break away
/// from a kill-on-close job (survival not guaranteed).
/// Check whether an offload / hot-swap could currently keep every terminal
/// alive, WITHOUT performing it. `Ok(())` ⇒ the offload would proceed; `Err`
/// carries the reason it would be refused. Used by the Settings preflight so the
/// UI only warns when the action is actually blocked.
/// Could **Offload & Close** run right now, keeping every terminal alive?
///
/// This instance's terminals ONLY. A sibling profile is deliberately not
/// consulted: offload arms our own pty-host and calls `app_handle.exit(0)`, so
/// it cannot reach another instance at all. It used to run the sibling check
/// too, which is why running `rel` while `rel.alt` was alive refused with
/// "Updating would close it and lose its terminals" — a message about an update
/// this command does not perform (design 014 §B1.2).
pub fn offload_preflight(state: &AppState) -> Result<(), String> {
    hotswap_preflight(state)
}

/// Could an **update** run right now without losing anyone's terminals?
///
/// Ours, plus every sibling — because Velopack's apply kills every process under
/// the install root, and a sibling that has not armed its pty-host loses its
/// shells with its GUI. Unlike offload, that reach is real, so the check is real.
pub fn update_preflight(state: &AppState) -> Result<(), String> {
    hotswap_preflight(state)?;
    let own = crate::profile::current().key();
    let siblings = crate::net_ports::live_siblings_now(&own);
    crate::sibling_coord::describe_unarmable(&siblings).map_or(Ok(()), Err)
}

/// The Settings preflight for Offload & Close.
///
/// Both this and `restart_for_update` call `offload_preflight`, so the verdict
/// the panel SHOWS cannot disagree with the one the button ENFORCES. They did
/// disagree: this command ran only `hotswap_preflight` while the button ran the
/// sibling check as well, so the panel green-lit an action that then refused as
/// a toast after the click (design 014 §B4).
#[tauri::command]
pub fn update_available(state: State<'_, AppState>) -> Result<(), String> {
    update_preflight(&state)
}

pub fn hotswap_preflight(state: &AppState) -> Result<(), String> {
    let client = state
        .pty_host_clone()
        .ok_or_else(|| "pty-host not connected — nothing to keep alive".to_string())?;
    if !client.survives_hotswap() {
        return Err(
            "hot-swap unavailable: the sidecar could not break away from a kill-on-close job"
                .to_string(),
        );
    }
    // Refuse if ANY live terminal is in-process (not host-owned) — a hot-swap
    // would kill those shells. Only proceed when every terminal will survive.
    let has_local = state
        .terminals
        .iter()
        .any(|e| !state.host_terminals.contains_key(e.key()));
    if has_local {
        return Err(
            "cannot hot-swap: some terminals are in-process (not sidecar-hosted) and would be lost"
                .to_string(),
        );
    }
    Ok(())
}

/// Preflight query for the Settings "Offload & Close" affordance. Returns Ok
/// when the offload would keep all terminals alive; Err with the reason if not.
#[tauri::command]
pub fn hotswap_available(state: State<'_, AppState>) -> Result<(), String> {
    offload_preflight(&state)
}

/// What the core-restart hot-swap drain hands the renderer to re-seed the
/// command-suggest prompt gate (backlog 011 + design 006): whether the shell
/// has the injected prompt hook, and whether it is sitting at a BARE prompt
/// right now (zero live children — sampled fresh at drain time, when the
/// renderer has just mounted, so staleness is minimal).
#[derive(serde::Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReattachPromptGateSeed {
    pub prompt_hook: bool,
    pub at_prompt: bool,
}

/// Backlog 011: drain the reattach prompt-gate seed for `id`. `Some` exactly
/// once when this terminal was REATTACHED after a core-restart hot-swap (whose
/// empty terminal list reconcile couldn't seed from), else `None` for a fresh
/// spawn or an already-drained id. The renderer calls this right after
/// `createTerminal` resolves and, on `Some`, re-seeds the command-suggest gate
/// `{seen: promptHook, armed: promptHook && atPrompt}` (design 006), so the
/// history popup can't leak into an agent CLI that survived the update but a
/// session idle at a bare prompt keeps suggestions for its FIRST command.
/// Idempotent: a second call returns `None`.
#[tauri::command]
pub async fn take_reattach_prompt_hook(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<ReattachPromptGateSeed>, String> {
    let Some((_, hook)) = state.reattach_prompt_hooks.remove(&id) else {
        return Ok(None);
    };
    let pid = state.terminals.get(&id).map(|t| t.pid).unwrap_or(0);
    let at_prompt = sample_at_prompt(hook, pid).await;
    Ok(Some(ReattachPromptGateSeed {
        prompt_hook: hook,
        at_prompt,
    }))
}

/// Design 006 pre-mount probe: NON-consuming "would the gate arm right now?"
/// answer for a terminal, by backend process id. The reconcile (renderer
/// reload) path seeds `{seen, armed:false}` as the safe baseline and calls
/// this immediately before the engine mounts — sampling at fetch time raced
/// buffered input that could start a child between the reconcile fetch and the
/// mount (review 008 M-1); the pre-mount sample closes that window to the same
/// shape the hot-swap drain already has. Unknown id ⇒ `None` (no seed change).
#[tauri::command]
pub async fn probe_reattach_prompt_gate(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<ReattachPromptGateSeed>, String> {
    let Some((hook, pid)) = state.terminals.get(&id).map(|t| (t.prompt_hook, t.pid)) else {
        return Ok(None);
    };
    let at_prompt = sample_at_prompt(hook, pid).await;
    Ok(Some(ReattachPromptGateSeed {
        prompt_hook: hook,
        at_prompt,
    }))
}

/// Strict at-prompt sample shared by the drain and the pre-mount probe
/// (design 006): only a hooked shell with a live, childless pwsh process arms;
/// pid 0 / dead pid / wrong identity / any child ⇒ false (safe direction).
/// The process-table snapshot is blocking — taken off the async executor.
async fn sample_at_prompt(hook: bool, pid: u32) -> bool {
    if !hook || pid == 0 {
        return false;
    }
    tokio::task::spawn_blocking(move || {
        let sys = sysinfo::System::new_all();
        crate::pty_manager::session_at_bare_prompt(pid, &sys)
    })
    .await
    .unwrap_or(false)
}

/// Update availability, surfaced to the "Check for updates" UI. `Unavailable`
/// means this build has no updater compiled in (store flavor / feature off).
#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum UpdateStatus {
    NotInstalled,
    UpToDate,
    Available { version: String },
    Unavailable,
}

/// Check for a Velopack update (GitHub channel). Always registered; returns
/// `Unavailable` when the `velopack-updates` feature is not compiled in.
#[tauri::command]
pub async fn check_for_updates() -> UpdateStatus {
    #[cfg(feature = "velopack-updates")]
    {
        tokio::task::spawn_blocking(crate::updater::check_status)
            .await
            .unwrap_or(UpdateStatus::NotInstalled)
    }
    #[cfg(not(feature = "velopack-updates"))]
    {
        UpdateStatus::Unavailable
    }
}

/// Download + arm + apply a Velopack update, keeping terminals alive. Always
/// registered; a store/no-updater build returns a stable "not available" error.
#[tauri::command]
pub async fn update_and_restart(state: State<'_, AppState>) -> Result<(), String> {
    #[cfg(feature = "velopack-updates")]
    {
        crate::updater::update_and_restart(&state).await
    }
    #[cfg(not(feature = "velopack-updates"))]
    {
        let _ = state;
        Err("in-app updates aren't available in this build (managed by the store)".to_string())
    }
}

#[tauri::command]
pub async fn restart_for_update(state: State<'_, AppState>) -> Result<(), String> {
    // Offload ONLY. No sibling check: this command arms our own pty-host and
    // exits this process — it performs no payload swap and cannot reach another
    // instance. The check that used to be here justified itself with "whatever
    // swaps the binary", which is a rebuild this command does not perform, and
    // it is what made a live `rel.alt` refuse `rel`'s offload (design 014 §B1.2).
    offload_preflight(&state)?;
    let client = state
        .pty_host_clone()
        .ok_or_else(|| "pty-host not connected — nothing to keep alive".to_string())?;
    let token = crate::pty_host_client::resolve_token();
    // Arm and WAIT for the ack so we know the sidecar durably armed BEFORE we
    // exit and drop the pipe (10-minute safety window).
    client
        .arm_detach(
            termflow_pty_protocol::LOCAL_HOLD_ACTIVE_SECS,
            &token,
            Some(termflow_pty_protocol::ArmDetachPurpose::Local),
        )
        .await?;
    // Let every window persist its state (cwd snapshot included) before we drop
    // it — an offload that skipped this came back with no persisted cwd for a
    // just-created/just-`cd`'d tab (see `flush_all_windows`).
    flush_all_windows(&state.app_handle).await;
    log::info!("pty-host: armed hot-swap hold; exiting to release the .exe lock");
    state.app_handle.exit(0);
    Ok(())
}

/// The offload/update preflight split (design 014 §B4).
///
/// `AppState` needs a Tauri `AppHandle`, and the `tauri::test` feature crashes
/// the test binary on Windows, so these assert the WIRING from source. That is
/// the right level anyway: the bug was never in what a preflight computed, it
/// was in which preflight each caller ran.
#[cfg(test)]
mod preflight_wiring_tests {
    /// The body of `fn <name>`, found by counting braces from its opening `{`.
    ///
    /// Brace counting rather than "the next N lines": a body that grows would
    /// silently fall out of a line-window and the assertion would pass by
    /// measuring nothing.
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
                        return rest[open..open + i + 1].to_string();
                    }
                }
                _ => {}
            }
        }
        panic!("unbalanced braces after `{signature}`");
    }

    fn source() -> String {
        // Every function this module scans (restart_for_update, hotswap_available,
        // update_preflight, offload_preflight) lives in this same file post-split.
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("commands")
            .join("update.rs");
        std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("cannot read {} ({e})", path.display()))
            .replace("\r\n", "\n")
    }

    /// THE reported bug. Offload arms our own host and exits this process; it
    /// cannot reach a sibling, so a live `rel.alt` must never refuse `rel`'s
    /// offload.
    #[test]
    fn offload_does_not_consult_siblings() {
        let body = fn_body(&source(), "pub async fn restart_for_update");
        // Named against the LIVE sibling APIs, not the removed
        // `sibling_instance_preflight`: a guard that watches for a function
        // nobody can call any more is trivially true and guards nothing.
        for api in [
            "live_siblings_now",
            "describe_unarmable",
            "arm_siblings",
            "update_preflight",
        ] {
            assert!(
                !body.contains(api),
                "Offload & Close must not consult siblings (`{api}` found) — it performs no \
                 payload swap and cannot reach another instance (design 014 §B1.2). Body:\n{body}"
            );
        }
        assert!(
            body.contains("offload_preflight"),
            "Offload must still guard THIS instance's terminals. Body:\n{body}"
        );
    }

    /// The argument list of every `arm_detach` call in a file, excluding this
    /// test module. Scoping to the call site is load-bearing: a whole-file
    /// `contains` matched the assertion literals BELOW, in this very file, so
    /// the offload site passed even when it was mutated to send `None`.
    fn arm_detach_args(src: &str) -> Vec<String> {
        let production = src
            .split("mod preflight_wiring_tests")
            .next()
            .unwrap_or(src);
        let mut out = Vec::new();
        for (open, _) in production.match_indices(".arm_detach(") {
            let start = open + ".arm_detach(".len();
            let mut depth = 1usize;
            for (off, ch) in production[start..].char_indices() {
                match ch {
                    '(' => depth += 1,
                    ')' => {
                        depth -= 1;
                        if depth == 0 {
                            out.push(production[start..start + off].to_string());
                            break;
                        }
                    }
                    _ => {}
                }
            }
        }
        out
    }

    #[test]
    fn all_arm_call_sites_send_the_intended_purpose() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let read = |rel: &str| {
            let args = arm_detach_args(&std::fs::read_to_string(root.join(rel)).unwrap());
            assert_eq!(args.len(), 1, "{rel}: expected exactly one arm_detach call");
            args.into_iter().next().unwrap()
        };

        // Both LOCAL sites label the arm, so a future deadline can apply to them.
        for local in ["commands/update.rs", "updater.rs"] {
            let args = read(local);
            assert!(
                args.contains("Some(termflow_pty_protocol::ArmDetachPurpose::Local)"),
                "{local}: a local arm must be labelled Local, got: {args}"
            );
        }

        // The sibling site must stay UNLABELLED — a different profile's update
        // must never install a deadline on terminals its user never touched.
        let sibling = read("api_server/system.rs");
        assert!(
            !sibling.contains("ArmDetachPurpose"),
            "a sibling-armed hold must carry no purpose, got: {sibling}"
        );
        assert!(
            sibling.contains("None"),
            "sibling arm must pass an explicit None, got: {sibling}"
        );
    }

    /// The asymmetry that produced the report: the panel showed offload as
    /// available while the button ran a stricter check, so the refusal arrived
    /// as a toast after the click. One shared function, so they cannot diverge.
    #[test]
    fn the_settings_preflight_runs_the_same_check_the_button_enforces() {
        let src = source();
        let shown = fn_body(&src, "pub fn hotswap_available");
        let enforced = fn_body(&src, "pub async fn restart_for_update");
        assert!(
            shown.contains("offload_preflight"),
            "panel must use the shared check: {shown}"
        );
        assert!(
            enforced.contains("offload_preflight"),
            "button must use the shared check"
        );
    }

    /// Update's reach IS real — Velopack kills every process under the install
    /// root — so it must still consider siblings, unlike offload.
    #[test]
    fn update_still_considers_siblings() {
        let body = fn_body(&source(), "pub fn update_preflight");
        assert!(
            body.contains("live_siblings_now"),
            "update must enumerate siblings: {body}"
        );
        assert!(
            body.contains("hotswap_preflight"),
            "update must also guard our own terminals"
        );
    }

    /// The two preflights must stay DIFFERENT functions. Collapsing them back
    /// into one is how the sibling check would silently return to offload.
    #[test]
    fn the_two_preflights_are_distinct() {
        let src = source();
        let offload = fn_body(&src, "pub fn offload_preflight");
        assert!(
            !offload.contains("live_siblings_now") && !offload.contains("sibling"),
            "offload_preflight must not consult siblings at all: {offload}"
        );
    }
}
