use tauri::State;
use crate::state::AppState;
use crate::pty_manager;
use jsonwebtoken::{encode, Header, EncodingKey};
use serde::{Deserialize, Serialize};
use chrono::{Utc, Duration};
use std::collections::HashMap;
use std::io::Write;
use sysinfo::System;

#[tauri::command]
pub async fn get_shell_profiles() -> Result<Vec<pty_manager::ShellProfile>, String> {
    Ok(pty_manager::get_available_shells())
}

/// Filenames the [`read_legal_document`] command may resolve, bundled under `legal/` as
/// Tauri resources (see `bundle.resources` in `tauri.conf.json` / `tauri.pro.conf.json`).
/// A fixed whitelist so a caller can never resolve an arbitrary path.
pub const LEGAL_DOCUMENTS: &[&str] = &[
    "EULA.txt",
    "PRIVACY.txt",
    "LICENSE-apache-2.0.txt",
    "LICENSE-fabric-fsl.txt",
    "THIRD-PARTY-NOTICES.txt",
];

/// Read a bundled legal/agreement document shipped as a Tauri resource under `legal/`.
/// Drives the About & Legal panel and the first-run EULA modal. Only whitelisted names
/// resolve; a missing resource (e.g. the Pro-only FSL text in an OSS build) is a clear Err
/// the UI treats as "not included in this build".
#[tauri::command]
pub async fn read_legal_document(app: tauri::AppHandle, name: String) -> Result<String, String> {
    use tauri::Manager;
    if !LEGAL_DOCUMENTS.contains(&name.as_str()) {
        return Err(format!("unknown legal document: {name}"));
    }
    let path = app
        .path()
        .resolve(format!("legal/{name}"), tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("resolve {name}: {e}"))?;
    std::fs::read_to_string(&path).map_err(|e| format!("{name} is not available in this build: {e}"))
}

/// Windows OS build number (e.g. 26200) for xterm's `windowsPty.buildNumber`, so the
/// terminal's ConPTY wrapping/reflow heuristics match the real backend (builds >= 21376
/// disable the legacy heuristic that corrupts full-width TUIs like codex). Returns 0 on
/// non-Windows or if it can't be determined — the frontend then assumes a modern build.
#[cfg(windows)]
#[tauri::command]
pub fn get_os_build_number() -> u32 {
    // sysinfo reads the version via RtlGetVersion under the hood. The string format
    // varies ("10.0.26200", "26200", "11 (26200)"), so take the largest numeric token —
    // the build number always dwarfs the major/minor components.
    let combined = format!(
        "{} {}",
        sysinfo::System::os_version().unwrap_or_default(),
        sysinfo::System::kernel_version().unwrap_or_default()
    );
    combined
        .split(|c: char| !c.is_ascii_digit())
        .filter_map(|t| t.parse::<u32>().ok())
        .max()
        .unwrap_or(0)
}

#[cfg(not(windows))]
#[tauri::command]
pub fn get_os_build_number() -> u32 {
    0
}

/// Which owner, if any, this create must reserve before it spawns.
///
/// `Some(owner)` exactly when the spawn will register a terminal whose renderer
/// leaf IS a tab id — the only case that can collide with another creator, since
/// a `tm-*` leaf is freshly minted and unique by construction. Pure so the
/// decision can be tested without a `tauri::State`.
///
/// `tb-*` and `tm-*` are leaf-id FORMS, not tree shapes: `tb-*` is minted for a
/// renderer-created tab root (leaf == owner), `tm-*` for split panes AND for
/// every API-created terminal, including one that is the solo root of its tab.
/// Nothing here infers root/solo/split from a prefix — the reservation turns
/// only on whether the leaf equals its owner. The one prefix test below is a
/// best-effort tripwire for owner-less LEGACY payloads, not a shape or owner
/// derivation; see the comment on that arm.
fn root_leaf_owner_to_reserve(tab_id: Option<&str>, owning_tab_id: Option<&str>) -> Option<String> {
    // The LEAF, whatever its shape — a spawn is contested when two creates name the
    // same leaf, and that has nothing to do with which tab owns it.
    //
    // This used to reserve only when `leaf == owner`, or when an owner-less legacy
    // payload carried a `tb-` leaf. Design 014 made both conditions unsatisfiable —
    // every leaf is a minted `tm-` and no leaf is its tab — so the function returned
    // `None` for every real spawn and `RootLeafClaims` stopped claiming ANYTHING.
    // A tripwire that cannot trip is worse than none: it reads as active protection.
    // Design 014 §A2.1 says the reservation is keyed by the `tm-` leaf post-Part-A;
    // this is that.
    //
    // Keying on the leaf also RETIRES the false-reservation hazard the old second arm
    // documented. It reserved a `tb-` leaf that might have moved to another tab, so
    // the claim could name the wrong terminal; a leaf id names exactly one terminal,
    // so the claim is now always about the thing it is protecting. (The claim is
    // still non-enforcing — it logs. The real single-flight is renderer-side in
    // `TerminalService.createTerminal`, keyed by the same leaf.)
    let _ = owning_tab_id;
    tab_id.map(str::to_string)
}

#[tauri::command]
pub async fn create_terminal(
    state: State<'_, AppState>,
    cols: u16,
    rows: u16,
    profile_id: Option<String>,
    cwd: Option<String>,
    tab_id: Option<String>,
    // The tab that owns the pane `tab_id` names. Equal to `tab_id` for a
    // RENDERER-created root/solo pane (this command's own caller). NOT equal
    // for an API-created tab's root — its pane leaf is a `tm-*` minted by
    // `resolve_api_spawn_identity`, distinct from `owning_tab_id` (option A).
    // Optional so a renderer that predates P0-A still works.
    owning_tab_id: Option<String>,
    // The pty-host session key for a MIGRATED pane (design 014 §A2.1). `None`
    // means the host key follows the leaf, which is the case for every pane
    // created on this build. Threaded through so a pane whose leaf the migration
    // rewrote still reattaches to its already-armed session.
    session_key: Option<String>,
) -> Result<String, String> {
    let profiles = pty_manager::get_available_shells();
    let mut shell_name = "default".to_string();

    // Resolve the requested profile by id/name. The UI sends "default" as a
    // placeholder when no profile is chosen, which matches no real profile — so
    // when the id is missing OR unknown we fall back to the `is_default` profile
    // (e.g. zsh on macOS) rather than to a bare system shell (which on macOS is
    // the old /bin/bash, producing the "default interactive shell is now zsh" note).
    let chosen = match profile_id.as_deref() {
        Some(id) => profiles
            .iter()
            .find(|p| p.id == id || p.name.eq_ignore_ascii_case(id)),
        None => None,
    }
    .or_else(|| profiles.iter().find(|p| p.is_default));

    let (shell_path, shell_args, shell_cwd) = if let Some(profile) = chosen {
        shell_name = profile.id.clone();
        let effective_cwd = if cwd.is_some() { cwd } else { profile.cwd.clone() };
        (Some(profile.path.clone()), Some(profile.args.clone()), effective_cwd)
    } else {
        // No profiles at all — let spawn_terminal pick a system fallback.
        (None, None, cwd)
    };
    
    let terminal_name = format!("Terminal-{}", shell_name);

    // Reserve the owner across THIS spawn too (external review 101, F1).
    //
    // `6941b4c` put the reservation only in `api_server::create_terminal`, which
    // serialised the REST path against itself but left this path — the renderer's
    // own create — outside it entirely. A restart-in-place of a dead tab root
    // spawns with `renderer_terminal_id == owning_tab_id == tb-a`; a REST create
    // for `tb-a` landing in the window before `spawn_terminal`'s final
    // `terminals.insert` would scan the tab as empty and take `tb-a` as its leaf
    // too, registering the same live leaf twice. Taking the same claim here
    // closes the renderer-first ordering: the REST path's `try_claim` then
    // returns `None` and it correctly mints a `tm-` split leaf instead.
    //
    // We claim but never REFUSE on contention: this call is a user action on a
    // pane that already exists and owns its leaf, so it must not fail.
    //
    // The reverse ordering — a REST create winning the claim and committing to
    // `tb-a` before this spawn registers — used to be open, and is now CLOSED by
    // construction (design 011, option A): `resolve_api_spawn_identity` never takes
    // a caller-supplied tab's root leaf at all, it always mints a `tm-`. So this is
    // the only path that can ever claim a `tb-` root leaf, and there is nobody left
    // to contend with.
    //
    // The claim is NOT a lock: `try_claim` returning `None` on contention only
    // logs the warning below and this call still proceeds to spawn. It does not
    // serialise this path against itself, and a re-entrant renderer call (e.g. a
    // double Restart click) still reaches `spawn_terminal` twice. Review 109 H1:
    // the real fix for that is a single-flight guard on the RENDERER side, keyed
    // by leaf id (see `TerminalService.createTerminal`), which this call trusts
    // to have already prevented a second in-flight create for the same leaf from
    // reaching here. This claim remains a tripwire that turns a contested
    // ordering into an observable log line, not an enforcement mechanism.
    let root_leaf_owner = root_leaf_owner_to_reserve(tab_id.as_deref(), owning_tab_id.as_deref());
    // Held to the end of this command (and dropped on the sidecar path's early
    // return) — releasing it before `spawn_terminal` has registered would reopen
    // the very window it exists to cover.
    let _root_leaf_claim = root_leaf_owner.as_deref().and_then(|owner| {
        let claim = state.root_leaf_claims.try_claim(owner);
        if claim.is_none() {
            log::warn!(
                "create_terminal: root leaf {owner} is already claimed by an in-flight create; \
                 proceeding because a renderer create owns its pane, but this is the contested \
                 ordering external review 101 F1 describes"
            );
        }
        claim
    });

    // The routed spawn (sidecar when available, in-process otherwise) requires a
    // stable tab_id as the leaf / reattach key; without one we fall through to the
    // legacy in-process path below, which lets `spawn_terminal` mint an ephemeral
    // id. The `enabled()` gate now lives INSIDE `spawn_routed` so no caller can
    // spawn without making the decision (plan 019 §2.1).
    if let Some(tid) = tab_id.clone() {
        return spawn_routed(
            state.inner(),
            SpawnRequest {
                leaf_id: tid,
                session_key: session_key.clone(),
                owning_tab_id: owning_tab_id.clone(),
                cols,
                rows,
                shell_path,
                shell_name,
                shell_args,
                cwd: shell_cwd,
                // The renderer derives `Terminal-{shell}` itself; passing None
                // keeps that one definition in `terminal_display_name`.
                name: None,
            },
        )
        .await;
    }

    // Restore path: if this renderer id has scrollback persisted from a prior
    // session, seed it into the fresh parser (via spawn_terminal, before the
    // reader thread starts — see the ratchet note on stage_scrollback) and stage
    // it as a one-shot prefix. The /snapshot endpoint prepends it on this
    // terminal's first hydration, so the engine's existing reset()+write replay
    // shows "old scrollback → divider → fresh prompt" with no engine change.
    let history_prefix = tab_id.as_ref().and_then(|t| restore_prefix(state.inner(), t));

    let id = pty_manager::spawn_terminal(
        state.inner().clone(),
        cols,
        rows,
        shell_path,
        shell_args,
        shell_cwd,
        shell_name,
        terminal_name,
        // Registered with the Terminal BEFORE the reader thread starts — patching
        // it in after spawn returned raced a fast-exiting shell's exit persist,
        // which then filed history under the ephemeral pc- id (review 062 F-01).
        tab_id,
        owning_tab_id,
        history_prefix.clone(),
    )?;

    if let Some(prefix) = history_prefix {
        state.replay_prefix.insert(id.clone(), prefix);
    }

    Ok(id)
}

/// Give this shell's ConPTY pseudo-console window an owner: the window the pane
/// currently lives in. Without it, dialogs a console program parents to
/// `GetConsoleWindow()` (Azure CLI's WAM sign-in, credential prompts) open
/// behind TermFlow where they can't be seen or dismissed — see `console_window`.
///
/// The renderer calls this every time a terminal id is bound to a process, not
/// just on spawn, so a pane dragged to another window re-owns against its new
/// HWND rather than keeping a stale one.
#[tauri::command]
pub fn adopt_console_window(
    window: tauri::Window,
    state: State<'_, AppState>,
    terminal_id: String,
) -> Result<(), String> {
    // Not registered (yet, or already gone) — nothing to adopt, and not an error:
    // the renderer fires this optimistically off its own binding lifecycle.
    let Some(pid) = state.terminals.get(&terminal_id).map(|t| t.pid) else {
        return Ok(());
    };
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        crate::console_window::adopt(pid, hwnd.0 as isize);
    }
    #[cfg(not(windows))]
    {
        let _ = (window, pid);
    }
    Ok(())
}

/// Tell the backend that a pane moved into a different tab, so the owner stored
/// at spawn stops naming the tab the pane left (review 099 T2-F2).
///
/// The renderer is the authority here: tab ownership lives only in
/// `panes.treesByTabId`, and the backend cannot derive it. Fired from the pane
/// tree's own change subscription (`services/paneOwnership.ts`), which is why it
/// covers every reparent path — same-window drag, cross-window drop, detached
/// window boot — rather than only fresh process binding.
///
/// `renderer_terminal_id` is the LEAF, not the process id: the leaf is what the
/// pane tree holds and it is unique per live pane (design 011 §3, D7). It comes
/// in two id FORMS, describing who minted the leaf and NOT the pane's shape:
/// `tb-*` for a renderer-created tab root, `tm-*` for split panes AND for every
/// API-created terminal, including a solo root. Root/solo/split is determined
/// only by the pane-tree structure, never by the prefix — and a leaf keeps its
/// id when moved, which is exactly why this command exists. Best-effort like `adopt_console_window` — an
/// unmatched leaf is not an error, since the renderer fires this off its own
/// tree lifecycle and a pane's PTY may not exist (yet, or any more).
#[tauri::command]
pub fn set_terminal_owning_tab(
    state: State<'_, AppState>,
    renderer_terminal_id: String,
    owning_tab_id: String,
) -> Result<(), String> {
    if !crate::state::retarget_owning_tab(&state.terminals, &renderer_terminal_id, &owning_tab_id)? {
        log::debug!(
            "set_terminal_owning_tab: no live terminal carries leaf {renderer_terminal_id}"
        );
    }
    Ok(())
}

/// Push the renderer's tab/pane title down to a live terminal, keyed by the durable `tm-` LEAF.
///
/// Fired from `services/terminalLabelSync.ts`, which derives the answer from the store rather than
/// from a lifecycle hook — the same reasoning `paneOwnership.ts` states in its own header, and for the
/// same reason: a moved pane already has a mapping and never re-binds, so a hook misses it.
///
/// This writes `Terminal.display_label`, **never `Terminal.name`**: `name` is on the wire in
/// `/api/terminals` and is what MCP's `get_terminal_detail` returns, so changing what it holds would
/// change what agents see. Plan 028 §4.2.
///
/// Best-effort, like `set_terminal_owning_tab`: an unmatched leaf is not an error.
#[tauri::command]
pub fn set_terminal_display_label(
    state: State<'_, AppState>,
    renderer_terminal_id: String,
    label: Option<String>,
) -> Result<(), String> {
    if !crate::state::set_display_label(&state.terminals, &renderer_terminal_id, label.as_deref())? {
        log::debug!(
            "set_terminal_display_label: no live terminal carries leaf {renderer_terminal_id}"
        );
    }
    Ok(())
}

/// Everything a spawn needs, independent of WHO asked for it — the renderer
/// (`create_terminal`), the REST/MCP API (`api_server::create_terminal`), or the
/// fleet responder (`api_server::fleet_local_run`).
pub(crate) struct SpawnRequest {
    /// The renderer leaf id (`tm-`). DURABLE: it is the `terminal_history` primary
    /// key and the id MCP hands out, so it must survive a restart. Every caller
    /// must already own a stable leaf before it gets here (design 011 §3: "no
    /// create may take a root leaf it did not itself mint").
    ///
    /// Since design 014 this is NO LONGER the map key, the sidecar session id or
    /// the screen key — those are the process id and the session key below.
    pub leaf_id: String,
    /// What the pty-host knows this session as, when it differs from the leaf.
    ///
    /// `None` means "same as the leaf", which is the case for everything created
    /// on this build. It is `Some` only for a terminal migrated from a pre-014
    /// build, whose host session is still keyed by the old `tb-` id and would be
    /// orphaned by a rename — the protocol has no rename verb (design 014 §A2).
    pub session_key: Option<String>,
    pub owning_tab_id: Option<String>,
    pub cols: u16,
    pub rows: u16,
    pub shell_path: Option<String>,
    pub shell_name: String,
    pub shell_args: Option<Vec<String>>,
    pub cwd: Option<String>,
    /// Caller-supplied display name; `None` derives `Terminal-{shell_name}`.
    pub name: Option<String>,
}

/// THE spawn decision, for every caller.
///
/// Host-owned when the PTY-host sidecar is enabled and reachable, in-process
/// otherwise. The app terminalId IS the stable leaf (the reattach key), so the
/// sidecar session, the output broadcast id, and the vt100 screen key all align —
/// live routing works with no change to the output pipeline, and reattach-by-leaf
/// after a hot-swap is consistent.
///
/// **This function is the only place that makes that choice.** The
/// `pty_host_client::enabled()` gate used to sit in the *caller*
/// (`create_terminal`), which is exactly why the two API spawn sites could skip it
/// and leave every agent-created terminal in-process — blocking Offload & Close
/// for as long as one was alive (plan 019). A new spawn site must call this, not
/// `pty_manager::spawn_terminal`; `api_spawn_routing_tests` enforces that.
pub(crate) async fn spawn_routed(state: &AppState, req: SpawnRequest) -> Result<String, String> {
    let SpawnRequest {
        leaf_id: id,
        session_key,
        owning_tab_id,
        cols,
        rows,
        shell_path,
        shell_name,
        shell_args,
        cwd,
        name,
    } = req;

    // Deliberately off (Unix default, or the `TERMFLOW_PTY_HOST=0` kill-switch):
    // in-process is the intended behaviour here, not a degraded one.
    if !crate::pty_host_client::enabled() {
        return host_fallback(state, &id, owning_tab_id.as_deref(), cols, rows, shell_path, shell_name, shell_args, cwd, name.as_deref(), "sidecar not enabled");
    }
    // Ensure the sidecar is up FIRST (single-flight). If unavailable, fall back
    // to the in-process path immediately — no host state is registered.
    if let Err(e) = state.ensure_pty_host().await {
        return host_fallback(state, &id, owning_tab_id.as_deref(), cols, rows, shell_path, shell_name, shell_args, cwd, name.as_deref(), &e);
    }
    let client = match state.pty_host_clone() {
        Some(c) => c,
        None => {
            return host_fallback(
                state, &id, owning_tab_id.as_deref(), cols, rows, shell_path, shell_name, shell_args, cwd,
                name.as_deref(),
                "pty-host not connected",
            )
        }
    };

    // The injected-hook decision (interactive PowerShell). Command-suggest's
    // renderer-side prompt gate reads this back over the API to re-arm on reload.
    let prompt_hook = pty_manager::shell_emits_prompt_osc(
        shell_path.as_deref(),
        &shell_name,
        shell_args.as_deref(),
    );

    // Reattach path: the sidecar still holds this session (survived a hot-swap).
    // Restore the real pid, register routing BEFORE attach releases replay
    // bytes, then nudge a repaint so a live TUI redraws.
    // The host addresses this terminal by its SESSION key, which is the leaf for
    // anything created on this build and the old `tb-` id for a migrated one.
    let session_key = session_key.unwrap_or_else(|| id.clone());

    if let Some((_, pid)) = state.host_reattach_pending.remove(&session_key) {
        let ident = host_identity(&session_key, Some(&id), owning_tab_id.as_deref());
        let process_id = ident.process_id.clone();
        register_host_terminal(state, &ident, pid, &shell_name, name.as_deref(), cols, rows, prompt_hook);
        // Backlog 011: this is the core-restart hot-swap reattach, which reconcile
        // (empty terminal list) could not seed. Stash the hook so the renderer can
        // re-arm the command-suggest prompt gate once createTerminal resolves.
        state.reattach_prompt_hooks.insert(process_id.clone(), prompt_hook);
        // Seed + stage BEFORE attach releases the replay ring, so restored
        // history precedes the ring bytes in the parser (see stage_scrollback).
        // History is keyed by the LEAF; the parser it seeds is keyed by the
        // PROCESS id — the two are no longer the same string.
        stage_scrollback(state, &id, &process_id);
        // RP-3: transactional when the host supports it (AttachAck), silently
        // legacy otherwise. A confirmed-dead session still completes reattach —
        // the replayed ring + Exit tombstone render the final state honestly.
        match client.attach_confirmed(&session_key, 0).await {
            Some(true) => log::info!("[HOTSWAP] reattached {session_key} (pid {pid}, host-confirmed alive)"),
            Some(false) => log::warn!("[HOTSWAP] reattached {session_key} but host reports it not alive"),
            None => log::info!("[HOTSWAP] reattached {session_key} (pid {pid}, legacy attach)"),
        }
        client.nudge_repaint(&session_key, cols, rows);
        return Ok(process_id);
    }

    // Fresh spawn: register routing state (screen + terminal + host ownership)
    // BEFORE spawning, so early output (shell banner / first prompt / OSC cwd)
    // has a registered screen to land in instead of being dropped by the
    // consumer's "unknown id" gate.
    let ident = host_identity(&session_key, Some(&id), owning_tab_id.as_deref());
    let process_id = ident.process_id.clone();
    register_host_terminal(state, &ident, 0, &shell_name, name.as_deref(), cols, rows, prompt_hook);
    // Seed + stage BEFORE the spawn so restored history precedes the shell's
    // first output in the parser. On spawn failure, cleanup_terminal_state
    // removes both the parser and the staged prefix; host_fallback restages.
    stage_scrollback(state, &id, &process_id);
    let spec = pty_manager::build_spawn_spec(
        &session_key,
        // The LEAF, not the session key: this is what the child shell reads as
        // TERMFLOW_TERMINAL_ID to identify itself to MCP (design 014 A6.1).
        Some(&id),
        shell_path.as_deref(),
        &shell_name,
        shell_args.as_deref(),
        cwd.as_deref(),
        cols,
        rows,
    );
    // Timed because this round trip is the user-visible "how long until my new
    // tab appears": the sidecar answers `Spawn` from ONE sequential frame loop,
    // so any slow inline work in another frame's handler (notably a `Close`'s
    // process-tree kill) shows up here as latency and nowhere else.
    let spawn_started = std::time::Instant::now();
    let spawned = client.spawn_session(&session_key, &spec).await;
    let spawn_ms = spawn_started.elapsed().as_millis();
    if spawn_ms >= 250 {
        log::warn!("[SPAWN] host spawn for {session_key} took {spawn_ms}ms");
    } else {
        log::info!("[SPAWN] host spawn for {session_key} took {spawn_ms}ms");
    }
    match spawned {
        Ok(pid) => {
            if let Some(mut t) = state.terminals.get_mut(&process_id) {
                t.pid = pid;
            }
            Ok(process_id)
        }
        Err(e) => {
            // Undo the provisional registration, then fall back in-process. Clean
            // up by the PROCESS id — that is what was registered.
            state.cleanup_terminal_state(&process_id);
            host_fallback(state, &id, owning_tab_id.as_deref(), cols, rows, shell_path, shell_name, shell_args, cwd, name.as_deref(), &e)
        }
    }
}

/// Every identity a hosted terminal carries.
///
/// Replaces the old `(map_key_and_leaf, owner)` tuple, whose very shape encoded
/// the collapse design 014 removes: one string served as DashMap key, sidecar
/// session id, output-broadcast id and vt100 screen key simultaneously, which is
/// why a "Terminal ID" and a "Process ID" displayed the same `tb-` value.
pub(crate) struct HostIdentity {
    /// `pc-` — the key for every per-terminal `AppState` map. Minted PER RUN and
    /// never persisted or handed to the pty-host.
    pub process_id: String,
    /// `tm-` — durable, and the `terminal_history` primary key. `None` for a
    /// headless spawn with no renderer pane (design 011 §5).
    pub leaf: Option<String>,
    /// `tb-` — the owning tab, or `None` when the caller did not supply one.
    ///
    /// **Never derived.** It used to fall back to the leaf, on the design 011 rule
    /// that "a root/solo pane owns itself" — true only while a renderer-created root
    /// leaf WAS its tab id. After design 014 every leaf is a `tm-`, so that fallback
    /// filed a TERMINAL id as an owning TAB id for any spawn whose pane tree had not
    /// been committed yet. `reassertOwnerAfterSpawn` corrects it a moment later, but
    /// until then activity routes at a tab that does not exist and
    /// `get_terminal_detail` reports a leaf as `owningTabId`. `None` is the honest
    /// answer and the renderer supplies the real one.
    pub owner: Option<String>,
    /// What the pty-host knows this session as. NEVER minted here: only the
    /// caller knows whether this is a migrated pre-014 session whose key must
    /// not move (design 014 §A2).
    pub session_key: String,
}

/// Derive the four identities for a hosted terminal.
///
/// `session_key` is the host's; `leaf` is the renderer's. They are equal for
/// anything created on this build and differ only after a migration.
fn host_identity(
    session_key: &str,
    leaf: Option<&str>,
    owning_tab_id: Option<&str>,
) -> HostIdentity {
    HostIdentity {
        process_id: crate::state::mint_process_id(),
        leaf: leaf.map(str::to_string),
        owner: resolve_owner(session_key, leaf, owning_tab_id),
        session_key: session_key.to_string(),
    }
}

/// The owning tab for a spawn: the caller's, or nothing.
///
/// Split out because the in-process fallback needs the owner WITHOUT minting a
/// process id (`pty_manager::spawn_terminal` mints its own). One definition, so
/// the two paths cannot drift — they did before, which is how a caller-supplied
/// name got dropped on every fallback (plan 019 §4).
///
/// Takes `session_key` and `leaf` still, because both were once fallbacks here and
/// a reader needs to see that their absence is deliberate: neither is a tab, so
/// neither can stand in for one (design 014 §A3).
fn resolve_owner(_session_key: &str, _leaf: Option<&str>, owning_tab_id: Option<&str>) -> Option<String> {
    owning_tab_id.map(str::to_string)
}

/// The display name a spawn registers: the caller's, or the derived default.
///
/// Only the API/MCP path supplies one (`payload.name`, e.g. an agent labelling its
/// own terminal); the renderer derives the same `Terminal-{shell}` string this
/// falls back to. Both in-process and host-owned spawns route through here so a
/// caller-supplied name cannot be dropped by taking one path rather than the other
/// — it used to be, on every fallback (plan 019 §4).
fn terminal_display_name(name: Option<&str>, shell_name: &str) -> String {
    match name.map(str::trim).filter(|n| !n.is_empty()) {
        Some(n) => n.to_string(),
        None => format!("Terminal-{}", shell_name),
    }
}

/// Register a host-owned terminal's routing state: authoritative screen, host
/// ownership, and the Terminal record.
///
/// Keyed by the PROCESS id (`pc-`), not the leaf. Before design 014 these were
/// the same string; splitting them is what lets a terminal id and a process id
/// be told apart by an MCP caller.
#[allow(clippy::too_many_arguments)]
fn register_host_terminal(
    state: &AppState,
    ident: &HostIdentity,
    pid: u32,
    shell_name: &str,
    name: Option<&str>,
    cols: u16,
    rows: u16,
    prompt_hook: bool,
) {
    let id = ident.process_id.as_str();
    let leaf = ident.leaf.clone();
    let owner = ident.owner.clone();
    state.init_screen(id, rows, cols);
    state.host_terminals.insert(id.to_string(), ());
    // Index BEFORE the terminal becomes observable: the pty-host translates every
    // inbound frame through `process_for_session`, so a frame arriving between the
    // spawn and this call would be dropped as an unknown session.
    state.identity.index(id, leaf.as_deref(), &ident.session_key);
    state.terminals.insert(
        id.to_string(),
        crate::state::Terminal {
            id: id.to_string(),
            pid,
            shell: shell_name.to_string(),
            name: terminal_display_name(name, shell_name),
            created_at: chrono::Local::now().to_rfc3339(),
            cols,
            rows,
            backend: crate::tmux_manager::TerminalBackend::PortablePty,
            renderer_terminal_id: leaf,
            owning_tab_id: owner,
            session_key: ident.session_key.clone(),
            last_input_source: None,
            last_input_at: None,
            prompt_hook,
            display_label: None,
        },
    );
}

/// Persisted scrollback for `history_key` rendered as a replay prefix (blob +
/// "session restored" divider), or None when nothing usable is stored.
fn restore_prefix<R: tauri::Runtime>(state: &AppState<R>, history_key: &str) -> Option<String> {
    let chunks = state.history_store.get(history_key)?;
    if chunks.is_empty() {
        return None;
    }
    let mut prefix = chunks.concat();
    prefix.push_str(crate::state::REPLAY_SEPARATOR);
    Some(prefix)
}

/// Stage persisted scrollback (keyed by `history_key`) for `target_id`, twice:
/// seed the freshly-initialized authoritative parser with it — so the next
/// history flush preserves it instead of overwriting the stored row with only
/// post-restart content (the scrollback-persistence "ratchet" bug) — and stage
/// the same bytes as a one-shot replay prefix that the /snapshot endpoint
/// prepends on the renderer's first hydration.
///
/// MUST run after init_screen and BEFORE any live output can reach the parser
/// (host attach releases replay bytes; spawn starts the shell), or the seed
/// would land after newer bytes and disorder the persisted history.
fn stage_scrollback<R: tauri::Runtime>(state: &AppState<R>, history_key: &str, target_id: &str) {
    let Some(prefix) = restore_prefix(state, history_key) else { return };
    state.feed_screen(target_id, prefix.as_bytes());
    state.replay_prefix.insert(target_id.to_string(), prefix);
}

/// Spawn in-process when the sidecar is unavailable. Preserves the tab_id and
/// stages scrollback (both of which the earlier fallback dropped).
#[allow(clippy::too_many_arguments)]
fn host_fallback(
    state: &AppState,
    tab_id: &str,
    owning_tab_id: Option<&str>,
    cols: u16,
    rows: u16,
    shell_path: Option<String>,
    shell_name: String,
    shell_args: Option<Vec<String>>,
    cwd: Option<String>,
    name: Option<&str>,
    reason: &str,
) -> Result<String, String> {
    // A sidecar that is switched OFF is not a failure — on Unix that is still the
    // default, so warning here would fire on every single spawn.
    if crate::pty_host_client::enabled() {
        log::warn!("pty-host unavailable ({reason}); falling back to in-process");
    } else {
        log::debug!("spawning {tab_id} in-process ({reason})");
    }
    let name = terminal_display_name(name, &shell_name);
    // Seed + register the tab_id via spawn_terminal (both land before the reader
    // thread starts), then stage the renderer's one-shot prefix under the new id.
    let history_prefix = restore_prefix(state, tab_id);
    // In-process fallback: `spawn_terminal` mints its own `pc-` id, so only the
    // leaf and the owner are needed here — see `resolve_owner`.
    let leaf = tab_id.to_string();
    let owner = resolve_owner(tab_id, Some(tab_id), owning_tab_id);
    let fallback_id = pty_manager::spawn_terminal(
        state.clone(),
        cols,
        rows,
        shell_path,
        shell_args,
        cwd,
        shell_name,
        name,
        Some(leaf),
        owner,
        history_prefix.clone(),
    )?;
    if let Some(prefix) = history_prefix {
        state.replay_prefix.insert(fallback_id.clone(), prefix);
    }
    Ok(fallback_id)
}

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
    Ok(Some(ReattachPromptGateSeed { prompt_hook: hook, at_prompt }))
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
    Ok(Some(ReattachPromptGateSeed { prompt_hook: hook, at_prompt }))
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
    client.arm_detach(600, &token).await?;
    log::info!("pty-host: armed hot-swap hold; exiting to release the .exe lock");
    state.app_handle.exit(0);
    Ok(())
}

/// The window label that API/MCP-created terminals currently route to (normalized to
/// a live window). The titlebar indicator reads this to show its ◉/○ state.
#[tauri::command]
pub fn get_active_window(state: State<'_, AppState>) -> String {
    state.resolve_active_window_label()
}

/// Make `label` the window that receives API/MCP-created terminals. Normalizes to a
/// live window, then broadcasts `active-window:changed` so every window's indicator
/// updates. Only one window is the target at a time.
#[tauri::command]
pub fn set_active_window(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    label: String,
) -> Result<(), String> {
    use tauri::Emitter;
    *state.active_window.write() = label;
    let resolved = state.resolve_active_window_label();
    *state.active_window.write() = resolved.clone();
    let _ = app.emit("active-window:changed", resolved);
    Ok(())
}

/// Payload for the `settings:open` broadcast — every window listens, but only the
/// one whose label matches `target` actually opens/activates the Settings tab.
#[derive(serde::Serialize, Clone)]
struct SettingsOpenPayload {
    target: String,
    category: Option<String>,
}

/// Open (or activate) the single Settings tab, always in the current main window —
/// regardless of which window this was invoked from. TermFlow supports multiple
/// windows, each with its own Redux store, so without routing through one
/// designated window, Settings opened from window B would only ever exist there.
/// Broadcasts `settings:open`; the targeted window's `installSettingsRouting`
/// listener does the actual tab creation/activation, and this also focuses that
/// window so the user actually sees it land.
#[tauri::command]
pub fn open_settings_in_main_window(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    category: Option<String>,
) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    let target = state.resolve_main_window_label();
    app_handle
        .emit("settings:open", SettingsOpenPayload { target: target.clone(), category })
        .map_err(|e| e.to_string())?;
    if let Some(w) = app_handle.get_webview_window(&target) {
        // Unlike the drag-reattach path, the user didn't just interact with the
        // target window — it may be minimized or on another desktop — so this is
        // a full restore, not just a focus.
        crate::webview_power::restore_and_focus(&w);
    }
    Ok(())
}

/// Best-effort current working directory of a terminal (backlog 004). Prefers the
/// shell-reported cwd parsed from OSC sequences (authoritative for PowerShell, whose
/// process cwd is not live), then falls back to the OS process cwd (cmd / Unix
/// shells keep that current). Returns `Ok(None)` for an unknown terminal or when
/// neither source has a value, so the renderer falls back to the app default.
///
/// The OSC hit is a cheap map lookup and stays on the async worker. The FALLBACK is
/// not: `get_process_cwd` runs a full `System::new_all()` scan (every process, plus a
/// re-scan per descendant generation), so it runs on a blocking worker — exactly as
/// `resolve_terminal_path` below does, and for the same reason. This command is fanned
/// out ONE INVOKE PER LIVE TERMINAL by the renderer's 30s cwd refresh, and every
/// non-PowerShell shell (cmd/WSL/bash/zsh — the OSC injection is PowerShell-only) takes
/// the fallback EVERY time. Left on the async pool, N concurrent scans would starve the
/// shared tokio workers that `write_terminal`/`resize_terminal` need, stalling
/// keystrokes and resizes.
#[tauri::command]
pub async fn get_terminal_cwd(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<String>, String> {
    if let Some(cwd) = state.terminal_cwds.get(&id) {
        return Ok(Some(cwd.value().clone()));
    }
    // Read the pid off `state` BEFORE the closure: `State` is not Send into it.
    let pid = match state.terminals.get(&id) {
        Some(t) => t.pid,
        None => return Ok(None),
    };
    tokio::task::spawn_blocking(move || pty_manager::get_process_cwd(pid))
        .await
        .map_err(|e| e.to_string())
}

/// [`get_terminal_cwd`] for MANY terminals, in ONE process scan.
///
/// The renderer's session-save refresh needs every live terminal's directory at once.
/// Per-terminal invokes meant N × `System::new_all()` — sysinfo's heaviest constructor
/// (every process, plus cpu / mem / disks / networks, 50-200ms) — because the OSC fast
/// path is only ever populated for PowerShell (pty_manager.rs injects PS_CWD_INTEGRATION),
/// so cmd / WSL / bash / zsh terminals — i.e. EVERY terminal on Linux — take the process
/// fallback on every single refresh.
///
/// Here the OSC hits are resolved first as cheap map lookups, and the scan happens ONCE
/// on a blocking worker (same reason as `get_terminal_cwd`: N concurrent scans on the
/// async pool would starve the workers `write_terminal` / `resize_terminal` need) and
/// only if at least one terminal actually needs it. Unknown terminals and unresolvable
/// directories map to `None`, so the renderer keeps its previous value.
#[tauri::command]
pub async fn get_terminal_cwds(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> Result<HashMap<String, Option<String>>, String> {
    let mut out: HashMap<String, Option<String>> = HashMap::new();
    // Read everything off `state` BEFORE the closure: `State` is not Send into it.
    let mut needs_scan: Vec<(String, u32)> = Vec::new();
    for id in ids {
        if let Some(cwd) = state.terminal_cwds.get(&id) {
            out.insert(id, Some(cwd.value().clone()));
            continue;
        }
        match state.terminals.get(&id) {
            Some(t) => needs_scan.push((id, t.pid)),
            None => {
                out.insert(id, None);
            }
        }
    }
    if needs_scan.is_empty() {
        return Ok(out);
    }

    let scanned = tokio::task::spawn_blocking(move || {
        let sys = System::new_all();
        needs_scan
            .into_iter()
            .map(|(id, pid)| (id, pid, pty_manager::get_process_cwd_with(&sys, pid)))
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| e.to_string())?;

    for (id, pid, cwd) in scanned {
        // Discard a result whose terminal died while we were scanning. The scan can
        // take 50-200ms, and a shell that exits inside that window frees its pid —
        // which Windows recycles aggressively, so `cwd` may belong to an unrelated
        // process that inherited the number. Attributing that to this terminal would
        // silently restart the user in a stranger's directory. `cleanup_terminal_state`
        // removes the entry on exit, so a still-matching pid means the shell we asked
        // about is the shell we measured. (The renderer closes the remaining sliver:
        // an exit invalidates any refresh that was in flight — see cwdSnapshot.ts.)
        let still_same_process = state.terminals.get(&id).map(|t| t.pid) == Some(pid);
        out.insert(id, if still_same_process { cwd } else { None });
    }
    Ok(out)
}

/// Resolve a relative path the terminal printed into the actual file(s) on disk
/// (backlog 003 follow-up). A coding agent that `cd`s into a subfolder prints paths
/// relative to ITS cwd, not the shell's — so the shell's OSC cwd misses them. We try,
/// in order: (1) the OSC-reported shell cwd, (2) the live foreground-process cwd (the
/// agent's real `chdir`), then (3) a bounded descendant search of the shell cwd. The
/// first base whose direct join exists wins (one result); otherwise the search may
/// return zero / one / many candidates (the renderer shows a picker for many).
///
/// The whole resolution — including the heavy `System::new_all()` process scan and the
/// fs walk — runs on a blocking worker so the UI thread / terminal output is never
/// stalled. Triggered only on a modifier+click, never per output line.
#[tauri::command]
pub async fn resolve_terminal_path(
    state: State<'_, AppState>,
    id: String,
    rel: String,
) -> Result<Vec<String>, String> {
    let osc_cwd = state.terminal_cwds.get(&id).map(|c| c.value().clone());
    let pid = state.terminals.get(&id).map(|t| t.pid);
    tokio::task::spawn_blocking(move || {
        let proc_cwd = pid.and_then(pty_manager::get_process_cwd);
        crate::open_commands::resolve_blocking(&[osc_cwd, proc_cwd], &rel)
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn write_terminal(
    state: State<'_, AppState>,
    id: String,
    data: String,
) -> Result<(), String> {
    // Host-owned terminals: forward keystrokes to the sidecar (still tag the
    // user-input source below).
    if !state.host_write(&id, data.as_bytes()) {
        // Clone the Arc, dropping the DashMap shard guard before locking.
        let writer_mutex = match state.shell_writer_channels.get(&id) {
            Some(r) => r.clone(),
            None => return Err("Terminal not found".to_string()),
        };
        {
            let mut writer = writer_mutex.lock().map_err(|_| "Failed to lock writer".to_string())?;
            writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        }
    }
    // Tag this terminal's last-write as user-driven (keystrokes/paste flow through
    // this invoke command, never the REST API). Drives the agent color-scheme
    // revert-on-user-exit behavior. Writer guard dropped above so we never nest the
    // DashMap shard guard under the writer mutex.
    if let Some(mut t) = state.terminals.get_mut(&id) {
        t.last_input_source = Some("user".to_string());
        t.last_input_at = Some(chrono::Utc::now().timestamp_millis());
    }
    Ok(())
}

#[tauri::command]
pub async fn resize_terminal(
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    // Host-owned terminals: forward the resize to the sidecar, update dims, and
    // keep the authoritative vt100 parser in sync (else /snapshot hydration
    // reports new dims against an old-sized screen).
    if state.host_resize(&id, cols, rows) {
        if let Some(mut terminal) = state.terminals.get_mut(&id) {
            terminal.cols = cols;
            terminal.rows = rows;
        }
        state.resize_screen(&id, rows, cols);
        return Ok(());
    }
    if let Some(master_mutex) = state.ptys.get(&id) {
        let master = master_mutex.lock().map_err(|_| "Failed to lock PTY master".to_string())?;
        master.resize(portable_pty::PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        }).map_err(|e| e.to_string())?;

        if let Some(mut terminal) = state.terminals.get_mut(&id) {
            terminal.cols = cols;
            terminal.rows = rows;
        }

        // Keep the authoritative screen parser in sync so snapshots reflow correctly.
        state.resize_screen(&id, rows, cols);

        Ok(())
    } else {
        Err("Terminal not found".to_string())
    }
}

#[derive(serde::Serialize)]
pub struct TerminalSize {
    pub cols: u16,
    pub rows: u16,
}

/// Read the backend's authoritative PTY size for a terminal. Cheap: reads the
/// stored size only (no parser render). The dimension auto-heal uses this to
/// detect UI<->backend column drift. Returns the last size the UI pushed via
/// resize_terminal (the backend has no independent notion of geometry).
#[tauri::command]
pub fn get_terminal_size(state: State<'_, AppState>, id: String) -> Result<TerminalSize, String> {
    if let Some(terminal) = state.terminals.get(&id) {
        Ok(TerminalSize { cols: terminal.cols, rows: terminal.rows })
    } else {
        Err("Terminal not found".to_string())
    }
}

/// Which profile this instance is. The renderer scopes its localStorage keys on
/// the returned `scope` — two instances share one WebView2 user-data folder, so
/// without it a named profile would overwrite the default profile's tabs.
#[tauri::command]
pub fn get_profile() -> crate::profile::ProfileInfo {
    crate::profile::current().info()
}

/// Replace the whole settings blob. Prefer [`merge_config`]: this clobbers keys
/// written by anyone else since the caller read the file.
#[tauri::command]
pub async fn save_config(app_handle: tauri::AppHandle, config: String) -> Result<(), String> {
    // Through app_config::config_path, never a hand-built one: this used to
    // resolve the filename itself, so any change to the naming rule split
    // settings across two files.
    let path = crate::app_config::config_path(&app_handle)?;
    crate::app_config::write_atomic(&path, &config)
}

/// Merge top-level settings keys, leaving every other key alone. The renderer
/// used to read the whole config, merge in JS and save it back — a lost update
/// whenever the backend (or another instance) wrote in between.
///
/// Also broadcasts the merged keys as `config:changed` to every window — but
/// ONLY when `merge_many_locked` reports the write actually changed something.
/// TermFlow supports multiple windows, each with its own Redux store, so without
/// the broadcast a setting changed in one window (font, color schema, ...) only
/// ever took effect in that window's own terminals. The "actually changed" gate
/// is load-bearing, not an optimization: every window that receives
/// `config:changed` re-applies it through the same settings reducers that
/// persist on every dispatch, so each window's echo calls back into this exact
/// command — without the gate, every echo would broadcast again, forever.
#[tauri::command]
pub async fn merge_config(
    app_handle: tauri::AppHandle,
    updates: serde_json::Value,
) -> Result<(), String> {
    let updates = updates
        .as_object()
        .ok_or_else(|| "merge_config expects a JSON object".to_string())?
        .clone();
    let path = crate::app_config::config_path(&app_handle)?;
    let changed = crate::app_config::merge_many_locked(&path, &updates)?;
    if changed {
        use tauri::Emitter;
        let _ = app_handle.emit("config:changed", serde_json::Value::Object(updates));
    }
    Ok(())
}

/// Backlog 011: record one submitted command into the global command history.
/// Length/emptiness guards live here too (defense in depth vs the frontend).
/// The SQLite write runs on a blocking worker (codebase precedent: line 172) so
/// it never contends on the async runtime with the 30s scrollback flush, which
/// holds the same HistoryStore mutex while writing multi-MB blobs.
#[tauri::command]
pub async fn add_command_history(
    state: State<'_, AppState>,
    command: String,
) -> Result<(), String> {
    let trimmed = command.trim().to_string();
    if trimmed.is_empty() || trimmed.chars().count() > 500 {
        return Ok(()); // silently drop garbage; never an error the UI must handle
    }
    let store = state.history_store.clone();
    tokio::task::spawn_blocking(move || {
        store.add_command(&trimmed, chrono::Utc::now().timestamp_millis());
    })
    .await
    .map_err(|e| e.to_string())
}

/// Move persisted scrollback from a pre-014 `tb-` root leaf to its new `tm-`.
///
/// Called by `StateManager`'s restore-time migration, once per renamed leaf and
/// **before any reattach**, so a pane finds its history under the id it will
/// actually use. Without it a migrated pane comes back blank — silently, because
/// a missing row reads as "nothing saved yet" rather than as an error.
///
/// Blocking worker for the same contention reason as `add_command_history`: the
/// 30s scrollback flush holds this same mutex while writing multi-MB blobs.
///
/// Never fails the caller. A history row that will not move is a cosmetic loss
/// for one pane; aborting the migration would leave the pane tree half-renamed,
/// which is worse.
#[tauri::command]
pub async fn rename_terminal_history(
    state: State<'_, AppState>,
    from: String,
    to: String,
) -> Result<(), String> {
    let store = state.history_store.clone();
    tokio::task::spawn_blocking(move || store.rename_renderer_id(&from, &to))
        .await
        .map_err(|e| e.to_string())
}

/// Backlog 011: remove one command from the history (Shift+Delete on a
/// suggestion). Blocking worker for the same contention reason as add.
#[tauri::command]
pub async fn delete_command_history(
    state: State<'_, AppState>,
    command: String,
) -> Result<(), String> {
    let store = state.history_store.clone();
    tokio::task::spawn_blocking(move || store.delete_command(&command))
        .await
        .map_err(|e| e.to_string())
}

/// Backlog 011: most-recent-first command history for the suggestion popup.
#[tauri::command]
pub async fn load_command_history(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> Result<Vec<String>, String> {
    let store = state.history_store.clone();
    tokio::task::spawn_blocking(move || store.load_commands(limit.unwrap_or(2000).min(5000)))
        .await
        .map_err(|e| e.to_string())
}

/// Stream 4: record that a command was run in a directory (cwd-relevant ranking).
/// `dir` must already be normalized by the caller (forward-slash; lowercased on
/// Windows). Blocking worker for the same contention reason as add_command_history.
#[tauri::command]
pub async fn add_command_dir_usage(
    state: State<'_, AppState>,
    command: String,
    dir: String,
) -> Result<(), String> {
    let trimmed = command.trim().to_string();
    let dir = dir.trim().to_string();
    if trimmed.is_empty() || trimmed.chars().count() > 500 || dir.is_empty() {
        return Ok(()); // silently drop garbage / unknown-cwd (global history still records)
    }
    let store = state.history_store.clone();
    tokio::task::spawn_blocking(move || {
        store.add_command_dir(&trimmed, &dir, chrono::Utc::now().timestamp_millis());
    })
    .await
    .map_err(|e| e.to_string())
}

/// Stream 4: usage rows relevant to the current directory (exact + ancestors +
/// descendants) for the renderer to rank suggestions by cwd affinity.
#[tauri::command]
pub async fn load_command_dir_usage(
    state: State<'_, AppState>,
    cwd: String,
) -> Result<Vec<crate::history_store::DirUsageRow>, String> {
    let store = state.history_store.clone();
    tokio::task::spawn_blocking(move || store.load_dir_usage(&cwd))
        .await
        .map_err(|e| e.to_string())
}

/// Stream 1: show an OS notification for background-tab activity, but ONLY when no
/// TermFlow window is focused (app-wide check — a focused window already gets the
/// in-app sound/toast, so notifying there too would be noisy/duplicate). `window_label`
/// + `tab_id` identify the exact destination when the notification is clicked.
/// Best-effort; failures are non-fatal.
///
/// Returns `false` when suppressed because a window was focused, and `true` when a
/// notification was *attempted*. `true` deliberately does NOT mean "the user saw a
/// toast": no platform here can promise that. The plugin fallback in particular spawns
/// an async task and discards the delivery result before returning
/// (tauri-plugin-notification desktop.rs), and macOS delivery happens on a background
/// thread. Do not build logic on `true` meaning "delivered".
///
/// Only a real click on the notification navigates (it emits `notification:activated`
/// with this `tab_id`); re-focusing a window never switches tabs.
#[tauri::command]
pub fn show_activity_notification(
    app: tauri::AppHandle,
    window_label: String,
    tab_id: String,
    title: String,
) -> Result<bool, String> {
    use tauri::Manager;
    let any_focused = app
        .webview_windows()
        .iter()
        .filter(|(label, _)| label.as_str() != "drag-preview")
        .any(|(_, w)| w.is_focused().unwrap_or(false));
    if any_focused {
        // app is focused → in-app channels cover it; don't double-notify
        log::info!("show_activity_notification: a window is focused; suppressing OS toast for tab {tab_id}");
        return Ok(false);
    }
    log::info!("show_activity_notification: no window focused; showing OS toast for tab {tab_id} (window {window_label})");
    let body = if title.trim().is_empty() {
        "New terminal activity".to_string()
    } else {
        title
    };
    // One seam, three platform implementations (native_notify.rs). Each delivers the
    // notification AND wires up click activation; only the mechanism differs.
    match crate::native_notify::show_activity_notification(&app, &window_label, &tab_id, &body) {
        Ok(()) => log::info!("[NOTIFY] native notification accepted for tab {tab_id}"),
        Err(native_error) => {
            // Keep notifications best-effort even where the native path is unavailable
            // (WinRT disabled by policy, no D-Bus session, etc). The plugin toast has no
            // click callback, but is still preferable to silently dropping the activity
            // notification. Note the plugin returns Ok before it has actually tried to
            // deliver, so the map_err below only catches *scheduling* failures — this
            // logs "scheduled", never "shown".
            log::warn!("[NOTIFY] native notification failed: {native_error}; scheduling plugin fallback");
            use tauri_plugin_notification::NotificationExt;
            app.notification()
                .builder()
                .title("TermFlow")
                .body(body)
                .show()
                .map_err(|e| format!("native toast failed ({native_error}); plugin fallback failed: {e}"))?;
        }
    }
    Ok(true)
}

#[tauri::command]
pub async fn load_config(app_handle: tauri::AppHandle) -> Result<String, String> {
    let path = crate::app_config::config_path(&app_handle)?;
    if path.exists() {
        std::fs::read_to_string(path).map_err(|e| e.to_string())
    } else {
        Ok("{}".to_string())
    }
}

#[tauri::command]
pub async fn close_terminal(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    // Timed alongside `[SPAWN]` so a close/open pair can be read as one sequence:
    // whether the cost sits in this command or in the sidecar's answer to the
    // NEXT spawn tells you which side to look at.
    let close_started = std::time::Instant::now();

    // Get the terminal info to retrieve the PID + renderer id.
    let (pid, tab_id) = if let Some(terminal) = state.terminals.get(&id) {
        (terminal.pid, terminal.renderer_terminal_id.clone())
    } else {
        return Err("Terminal not found".to_string());
    };

    // Host-owned: tell the sidecar to close the session (it kills the child);
    // otherwise kill the local process tree.
    if !state.host_close(&id) {
        // Kill the process tree (parent and all children)
        crate::pty_manager::kill_process_tree(pid);
    }

    // Clean up ALL state entries (incl. terminal_history/tmux_sessions, which
    // the old inline cleanup leaked). Dropping the pty also EOFs the reader.
    //
    // Explicit user close: drop this terminal's persisted scrollback so a closed
    // tab never reappears on the next restart (shell-exit keeps it — see
    // cleanup_terminal_state). Both run under the per-terminal persist guard
    // (review 062): the kill above EOFs the reader, whose exit-path persist could
    // otherwise clone the screen, render for milliseconds, and re-upsert the row
    // AFTER this delete. With the guard, either the persist finishes first (row
    // recreated, then deleted here) or it starts after cleanup and no-ops on the
    // missing terminal — delete semantics hold in both orders.
    {
        let guard_arc = state.history_persist_guard(&id);
        let _guard = guard_arc.lock().unwrap_or_else(|e| e.into_inner());
        state.cleanup_terminal_state(&id);
        if let Some(tab_id) = tab_id {
            state.history_store.delete(&tab_id);
            // ...and the canvas wires that named it. Nothing else ever deleted an edge on
            // a terminal's death, so `canvas_edges` grew for the life of the profile and
            // every `get_graph` deserialised the accumulated history.
            //
            // Keyed on the RENDERER id, which is the id space edges use — the same one
            // `history_store` is keyed by, and deliberately not `id` (the backend handle).
            // Targeted deletion rather than `prune_edges`: pruning takes a liveness set and
            // would reap a restored-but-unspawned peer's edges, which is precisely the bug
            // `get_graph` stopped filtering to avoid.
            match state.canvas_store.delete_edges_for(&tab_id) {
                Ok(0) => {}
                Ok(n) => log::info!("Deleted {} canvas edge(s) for terminal {}", n, tab_id),
                // Non-fatal: the terminal is closing either way, and a canvas store that
                // cannot answer must not fail the close.
                Err(e) => log::warn!("Failed to delete canvas edges for {}: {}", tab_id, e),
            }
        }
    }

    log::info!(
        "Closed terminal {} with PID {} in {}ms",
        id,
        pid,
        close_started.elapsed().as_millis()
    );
    Ok(())
}

/// Delete persisted scrollback for every renderer id NOT in `keep_ids` — the startup
/// orphan sweep. The renderer passes the full set of ids its restored layout will use
/// (tab roots + split panes); everything else (closed tabs, crashed sessions) is reaped.
#[tauri::command]
pub async fn prune_terminal_history(
    state: State<'_, AppState>,
    keep_ids: Vec<String>,
) -> Result<(), String> {
    let keep: std::collections::HashSet<String> = keep_ids.into_iter().collect();
    state.history_store.prune(&keep);
    Ok(())
}

/// Background mode (Plan 010): persist the "keep running in background" setting and
/// mirror it into the live `AppState` atomic that the window-close/exit guard reads.
///
/// When true, closing the last window hides it to the tray and keeps the process
/// alive (so peering keeps running) instead of exiting; when false, the last window
/// close exits the app as before. Persisted to the shared instance config file so it
/// survives restarts and seeds the atomic at startup (see `run()` in lib.rs).
#[tauri::command]
pub fn set_keep_running_in_background(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    state.keep_running_in_background.store(enabled, Ordering::Relaxed);
    crate::app_config::merge_root_value(
        &app_handle,
        "keepRunningInBackground",
        serde_json::Value::Bool(enabled),
    )
}

/// Diagnostic logging bridge: lets the renderer mirror terminal diagnostics to
/// the Rust logger (and thus the `tauri dev` terminal stdout) without DevTools.
/// Gated on the frontend (disabled by default); see the renderer's diag util and
/// docs/024-terminal-diagnostics-logging.md.
#[tauri::command]
pub fn diag_log(msg: String) {
    log::info!("{}", msg);
}

/// Quit the whole app immediately. Used by the first-run EULA "Decline" action — if the
/// user won't accept the agreement, the app must not proceed.
#[tauri::command]
pub fn quit_app(app_handle: tauri::AppHandle) {
    log::info!("quit_app: exiting (EULA declined or explicit quit).");
    flush_then_exit(&app_handle);
}

/// Exit the app after the user confirms the close in the in-app dialog.
/// Uses exit() (not window.close()) so it doesn't re-trigger CloseRequested.
#[tauri::command]
pub fn confirm_close_app(app_handle: tauri::AppHandle, window: tauri::Window) {
    // Only the last remaining window quits the whole app; closing any other
    // window just destroys that window (its panes/PTYs are confirmed per-window).
    // The hidden tab tear-off preview window doesn't count as a real window.
    let count = app_handle
        .webview_windows()
        .keys()
        .filter(|label| label.as_str() != "drag-preview")
        .count();
    if count <= 1 {
        log::info!("Last window confirmed close; exiting app.");
        // This window has already saved (the renderer awaits saveStateWithCwds
        // before invoking us), but any OTHER window still alive — a hidden one,
        // or one mid-teardown — has not, and exit() would skip its unload.
        flush_then_exit(&app_handle);
    } else {
        log::info!("Closing window '{}' ({} window(s) remain).", window.label(), count - 1);
        if let Err(e) = window.destroy() {
            log::warn!("Failed to destroy window '{}': {}", window.label(), e);
        }
    }
}

#[derive(Serialize)]
pub struct ConnectionHealth {
    pub name: String,
    pub url: String,
    pub healthy: bool,
    pub active_clients: Option<u32>,
    /// True when the port is reachable but owned by ANOTHER instance (cross-instance
    /// conflict / hijack). The UI shows a "pick another port" message instead of a
    /// healthy badge. Mutually exclusive with `healthy`.
    #[serde(default)]
    pub conflict: bool,
}

#[tauri::command]
pub async fn check_connection_health(state: State<'_, AppState>) -> Result<Vec<ConnectionHealth>, String> {
    // Probe the ports we are ACTUALLY serving on, not the ones we were configured for.
    //
    // Under a second instance those differ (every release profile is configured for 42031;
    // only the first to start binds it), and probing the configured port asked the wrong
    // question in both directions: a healthy sibling on 42031 came back as a permanent
    // "conflict" badge for an instance whose own API on 42035 was fine, and once our own
    // server was stopped the same probe would have reported the sibling as OUR healthy one.
    //
    // `None` means we hold no port — stopped, or suppressed for an elevated profile — so
    // there is nothing of OURS to probe and "offline" is the answer without asking anyone.
    // The displayed URL still falls back to the configured port in that case: it is the
    // number in Settings and the one a restart would try first.
    let (effective_api, effective_mcp) = {
        let eff = state.effective_endpoints.read();
        (eff.api_port, eff.mcp_port)
    };
    let (api_port, mcp_port) = {
        let net = state.network.read();
        (
            effective_api.unwrap_or(net.api_port),
            effective_mcp.unwrap_or(net.mcp_port),
        )
    };
    let mut results = Vec::new();

    // Both the API and MCP /health echo this process's instanceId; a reachable port
    // reporting a DIFFERENT id is owned by another instance (cold-start race / hijack
    // for the API, a foreign sidecar for MCP), so it reads as a conflict rather than
    // healthy. classify_health_owner encodes that rule for both (P0b).
    let our_id = state.instance_id.clone();
    // Bounded-timeout client so a blackholed localhost port (accepts the connection
    // but never answers) can't hang this UI-polled command for the OS default ~20s.
    let client = crate::network_commands::localhost_client(1500)
        .ok_or_else(|| "failed to build HTTP client".to_string())?;

    // Check API Server. `effective_api == None` short-circuits to offline rather than
    // probing the configured port — whatever answers there while we hold nothing is by
    // definition somebody else's server, and reporting it as ours would be a false green.
    let api_reported: Option<String> = match effective_api {
        None => None,
        Some(port) => match client.get(format!("http://localhost:{}/health", port)).send().await {
            Ok(r) if r.status().is_success() => {
                let j = r.json::<serde_json::Value>().await.unwrap_or_else(|_| serde_json::json!({}));
                Some(j.get("instanceId").and_then(|v| v.as_str()).unwrap_or("").to_string())
            }
            _ => None,
        },
    };
    let (api_healthy, api_conflict) =
        crate::network_commands::classify_health_owner(api_reported.as_deref(), &our_id);

    results.push(ConnectionHealth {
        name: "API Server".to_string(),
        url: format!("http://localhost:{}", api_port),
        healthy: api_healthy,
        active_clients: None,
        conflict: api_conflict,
    });

    // Check MCP Server — same ownership rule, plus activeSessions for the client count.
    let (mcp_reported, mcp_clients): (Option<String>, Option<u32>) = match effective_mcp {
        None => (None, None),
        Some(port) => match client.get(format!("http://localhost:{}/health", port)).send().await {
            Ok(r) if r.status().is_success() => {
                let j = r.json::<serde_json::Value>().await.unwrap_or_else(|_| serde_json::json!({}));
                let id = j.get("instanceId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let sessions = j.get("activeSessions").and_then(|v| v.as_u64()).map(|v| v as u32);
                (Some(id), sessions)
            }
            _ => (None, None),
        },
    };
    let (mcp_healthy, mcp_conflict) =
        crate::network_commands::classify_health_owner(mcp_reported.as_deref(), &our_id);

    results.push(ConnectionHealth {
        name: "MCP Server".to_string(),
        url: format!("http://localhost:{}/mcp", mcp_port),
        healthy: mcp_healthy,
        active_clients: mcp_clients,
        conflict: mcp_conflict,
    });

    // WebSocket inherits API health (same server)
    results.push(ConnectionHealth {
        name: "WebSocket".to_string(),
        url: format!("ws://localhost:{}/ws", api_port),
        healthy: api_healthy,
        active_clients: None,
        conflict: api_conflict,
    });

    Ok(results)
}

#[derive(Debug, Serialize, Deserialize)]
struct Claims {
    sub: String,
    permissions: Vec<String>,
    exp: usize,
    iat: usize,
}

#[tauri::command]
pub async fn generate_api_token(
    state: State<'_, AppState>,
    client_id: String, 
    permissions: Vec<String>
) -> Result<String, String> {
    let exp = Utc::now() + Duration::hours(24);
    let claims = Claims {
        sub: client_id,
        permissions,
        exp: exp.timestamp() as usize,
        iat: Utc::now().timestamp() as usize,
    };

    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(state.jwt_secret.as_bytes()),
    ).map_err(|e| e.to_string())?;

    Ok(token)
}

/// Reserve a stable session id for a window that is ABOUT to be built
/// (plan 018 Task 2).
///
/// Must run BEFORE `builder.build()`. The webview begins loading the moment it
/// is built, and its very first act is to resolve this id — a binding published
/// afterwards is a race whose losing side falls back to slot 0, silently merging
/// the new window into the main window's session. That is precisely the defect
/// this feature exists to remove, so the ordering is load-bearing, not a
/// micro-optimisation.
pub fn reserve_window_id(app: &tauri::AppHandle, label: &str) -> Option<String> {
    use tauri::Manager as _;
    let state = app.try_state::<AppState>()?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    state.windows.bind(label, &id);
    Some(id)
}

/// Record a just-built window's real geometry under its reserved id.
///
/// Best-effort on geometry: a window that cannot report its position is still
/// recorded, using the builder's defaults. An unrecorded window is one that
/// silently never restores — strictly worse than one restored at the wrong
/// coordinates.
pub fn record_new_window(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    id: String,
    fallback_size: (u32, u32),
) {
    use tauri::Manager as _;
    let Some(state) = app.try_state::<AppState>() else { return };
    let pos = window.outer_position().ok();
    let size = window.inner_size().ok();
    state.windows.register(crate::window_registry::WindowRecord {
        id,
        label: window.label().to_string(),
        x: pos.map(|p| p.x).unwrap_or(0),
        y: pos.map(|p| p.y).unwrap_or(0),
        width: size.map(|s| s.width).unwrap_or(fallback_size.0),
        height: size.map(|s| s.height).unwrap_or(fallback_size.1),
        maximized: window.is_maximized().unwrap_or(false),
        focused: false,
    });
    // A newly opened window takes focus; set it through the tracker so exactly
    // one record carries the flag.
    state.windows.note_focus(window.label());
}

/// The stable session id for the calling window (plan 018 Task 3).
///
/// The renderer resolves this BEFORE the bridge or `App` loads and derives its
/// `localStorage` keys from it, so every window persists its own tabs instead
/// of clobbering one shared key.
///
/// Returns `Err` for an unknown label rather than defaulting to slot 0. A silent
/// fallback would put two windows back on one key — the exact defect this
/// exists to fix — and would do it invisibly.
#[tauri::command]
pub fn get_window_session_id(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<String, String> {
    state
        .windows
        .id_for_label(window.label())
        .ok_or_else(|| format!("no window session id registered for label '{}'", window.label()))
}

/// Every window id the registry currently holds. The renderer sweeps orphaned
/// session blobs against this list (plan 018 Task 9).
#[tauri::command]
pub fn list_window_session_ids(state: State<'_, AppState>) -> Vec<String> {
    state.windows.snapshot().windows.into_iter().map(|w| w.id).collect()
}

// ----- Quit: give every window a chance to persist first ---------------------
//
// `AppHandle::exit` tears the process down without firing `CloseRequested` for
// any window, so no renderer gets its `beforeunload`. That was survivable while
// one shared key held the whole session — some window had almost certainly
// written it recently. With per-window sessions (plan 018) each window owns data
// only IT can write, so an unflushed window loses its tabs outright.

/// How long a quit will wait for windows to persist. A quit that hangs is worse
/// than a stale tab, so this is a hard ceiling, not a target.
const FLUSH_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(1500);

/// Ask every window to persist its session, then exit — or exit anyway once
/// `FLUSH_TIMEOUT` elapses.
/// The ONLY route from a user-initiated quit to `exit(0)`.
///
/// Releases the pty-host's detach arm before exiting. An armed host that loses
/// its GUI *holds* its sessions instead of tearing them down (see the sidecar's
/// `on_gui_disconnect`), so exiting while armed leaves the user's shells — and
/// any agent CLI running under them — alive with no window and no tray to reach
/// them. Users read "Exit" as "exit everything", so a quit must never leave that
/// behind.
///
/// Deliberately NOT used by `restart_for_update` or the updater: those arm on
/// purpose and exit so terminals survive the swap.
pub fn disarm_then_exit(app: &tauri::AppHandle) {
    use tauri::Manager as _;

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Resolve the client and drop the `State` borrow before awaiting.
        let client = app.try_state::<AppState>().and_then(|s| s.pty_host_clone());
        if let Some(client) = client {
            if !client.disarm().await {
                log::error!(
                    "quit: pty-host never acknowledged the disarm; it may keep \
                     holding sessions after we exit"
                );
            }
        }
        app.exit(0);
    });
}

pub fn flush_then_exit(app: &tauri::AppHandle) {
    use tauri::{Emitter, Manager as _};

    let Some(state) = app.try_state::<AppState>() else {
        disarm_then_exit(app);
        return;
    };

    // A second Quit while a flush is in flight means "I am done waiting" — but
    // it still goes through the disarm, which is a local round trip and normally
    // costs milliseconds. Skipping it is what strands terminals.
    if state.exiting.swap(true, std::sync::atomic::Ordering::SeqCst) {
        log::info!("flush_then_exit: already flushing; exiting now.");
        disarm_then_exit(app);
        return;
    }

    let expected: Vec<String> = app
        .webview_windows()
        .keys()
        .filter(|l| l.as_str() != "drag-preview")
        .cloned()
        .collect();
    if expected.is_empty() {
        disarm_then_exit(app);
        return;
    }

    state.flush_acks.clear();
    if let Err(e) = app.emit("app:flush-session", ()) {
        // Nothing will ack, so do not make the user wait out the timeout.
        log::warn!("flush_then_exit: could not ask windows to flush ({e}); exiting now.");
        disarm_then_exit(app);
        return;
    }

    let acks = state.flush_acks.clone();
    let app = app.clone();
    let want = expected.len();
    tauri::async_runtime::spawn(async move {
        let all_acked = wait_for_acks(&acks, want, FLUSH_TIMEOUT).await;
        if all_acked {
            log::info!("flush_then_exit: all {want} window(s) persisted; exiting.");
        } else {
            log::warn!(
                "flush_then_exit: {}/{} window(s) persisted before the {}ms deadline; exiting anyway.",
                acks.len(),
                want,
                FLUSH_TIMEOUT.as_millis()
            );
        }
        disarm_then_exit(&app);
    });
}

/// Wait until `want` windows have acked, or `timeout` elapses. Returns whether
/// every window acked.
///
/// Split out from `flush_then_exit` so the TIMEOUT path is testable: it is the
/// branch that matters (a renderer that never answers must not wedge the quit)
/// and the one a happy-path test would never reach.
async fn wait_for_acks(
    acks: &dashmap::DashMap<String, ()>,
    want: usize,
    timeout: std::time::Duration,
) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if acks.len() >= want {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}

#[cfg(test)]
mod flush_tests {
    use super::*;
    use dashmap::DashMap;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    #[tokio::test]
    async fn a_window_that_never_acks_does_not_wedge_the_quit() {
        let acks: Arc<DashMap<String, ()>> = Arc::new(DashMap::new());
        acks.insert("main".into(), ());
        let started = Instant::now();
        // Two windows expected, one silent.
        let all = wait_for_acks(&acks, 2, Duration::from_millis(120)).await;
        assert!(!all, "must report the flush as incomplete");
        assert!(
            started.elapsed() >= Duration::from_millis(100),
            "must actually have waited for the deadline"
        );
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "and must not wait past it — a quit that hangs is worse than a stale tab"
        );
    }

    #[tokio::test]
    async fn all_acks_release_the_wait_early() {
        let acks: Arc<DashMap<String, ()>> = Arc::new(DashMap::new());
        let bg = acks.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(30)).await;
            bg.insert("main".into(), ());
            bg.insert("window-a".into(), ());
        });
        let started = Instant::now();
        assert!(wait_for_acks(&acks, 2, Duration::from_secs(30)).await);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "the wait must end on the acks, not on the timeout"
        );
    }

    #[tokio::test]
    async fn expecting_nobody_returns_immediately() {
        let acks: Arc<DashMap<String, ()>> = Arc::new(DashMap::new());
        assert!(wait_for_acks(&acks, 0, Duration::from_secs(30)).await);
    }
}

/// A window reporting that it has persisted its session (plan 018 Task 8).
#[tauri::command]
pub fn flush_session_ack(state: State<'_, AppState>, window: tauri::WebviewWindow) {
    state.flush_acks.insert(window.label().to_string(), ());
}

// ----- Detach / cross-window pane handoff -----------------------------------
//
// The PTY processes live in this shared backend (AppState), so moving a pane to
// a new window does NOT restart the shell. The source window serializes the
// moving unit into a single-use payload stashed here under a token; the new
// window fetches it and reattaches to the same live processes by id.

#[tauri::command]
pub fn stash_detach_payload(
    state: State<'_, AppState>,
    token: String,
    payload: serde_json::Value,
) -> Result<(), String> {
    state.detach_payloads.insert(token, payload);
    Ok(())
}

#[tauri::command]
pub fn take_detach_payload(
    state: State<'_, AppState>,
    token: String,
) -> Result<Option<serde_json::Value>, String> {
    Ok(state.detach_payloads.remove(&token).map(|(_, v)| v))
}

/// Open a new app window that will reconstruct the detached tab/pane. The token
/// is carried in the window label (`detach-<token>`) so the new window can read
/// it from its own label and call `take_detach_payload` on boot.
#[tauri::command]
pub async fn create_detached_window(
    app_handle: tauri::AppHandle,
    window: tauri::WebviewWindow,
    token: String,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<String, String> {
    let label = format!("detach-{}", token);
    // Match the main window (tauri.conf): empty/hidden title + Overlay title bar
    // so the custom in-app tab bar is the only header (no native "TermFlow"
    // text row, no doubled-up title bar).
    let mut builder = tauri::WebviewWindowBuilder::new(
        &app_handle,
        &label,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title(crate::profile::decorate_title("TermFlow"))
    .inner_size(900.0, 600.0)
    .resizable(true)
    // Frameless on Windows/Linux (the custom in-app title bar owns the chrome);
    // decorated on macOS so the Overlay title bar provides native traffic lights.
    .decorations(cfg!(target_os = "macos"));

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }

    // Must match every other webview's arguments exactly -- see gpu_preference.
    #[cfg(windows)]
    {
        builder = builder.additional_browser_args(crate::gpu_preference::browser_args());
    }

    // Position the new window under the cursor. We ask the OS for the actual
    // global cursor position rather than computing it from the source window +
    // client coords: that manual math breaks across monitors with different DPI
    // scale factors (and this webview zeroes screen coords on events anyway).
    // `cursor_position()` returns physical px in the global space, which is
    // exactly what `builder.position` expects in Tauri v2. The `x`/`y` client
    // coords are kept only as a fallback if the cursor query fails.
    // Nudge up/left so the cursor lands over the tab strip, not the corner.
    const OFFSET_X: f64 = 60.0;
    const OFFSET_Y: f64 = 16.0;
    let placed = if let Ok(p) = app_handle.cursor_position() {
        let scale = app_handle
            .monitor_from_point(p.x, p.y)
            .ok()
            .flatten()
            .map(|m| m.scale_factor())
            .unwrap_or(1.0);
        builder = builder.position(p.x - OFFSET_X * scale, p.y - OFFSET_Y * scale);
        true
    } else {
        false
    };
    if !placed {
        if let (Some(cx), Some(cy)) = (x, y) {
            if let (Ok(origin), Ok(scale)) = (window.inner_position(), window.scale_factor()) {
                let px = origin.x as f64 + (cx - OFFSET_X) * scale;
                let py = origin.y as f64 + (cy - OFFSET_Y) * scale;
                builder = builder.position(px, py);
            }
        }
    }

    // Reserve BEFORE build (see reserve_window_id): a detached window saves its
    // own session from the moment it mounts, so it must know its id by then.
    let reserved = reserve_window_id(&app_handle, &label);
    let window = builder.build().map_err(|e| e.to_string())?;
    crate::context_menu::install(&window);
    if let Some(id) = reserved {
        record_new_window(&app_handle, &window, id, (900, 600));
    }
    refresh_menu(&app_handle);
    Ok(label)
}

/// Open a fresh, empty app window (File > New Window). Unlike a detached window,
/// it carries no payload: it boots with `?newWindow=1` and opens a single
/// default terminal tab.
///
/// `?newWindow=1` no longer means "skip session restore" (plan 018 Task 5). The
/// window gets its own session id, finds nothing saved under it, and the normal
/// post-restore decision opens the default tab. It still saves under that id, so
/// this window is restored like any other on the next start.
pub fn open_new_window(app: &tauri::AppHandle, path: Option<String>) -> Result<String, String> {
    let label = format!("window-{}", uuid::Uuid::new_v4().simple());
    let mut url = "index.html?newWindow=1".to_string();
    if let Some(path) = path {
        url.push_str("&path=");
        url.push_str(&percent_encode_url_component(&path));
    }
    // `mut` is only used by the macOS-only (Overlay title bar) and Windows-only
    // (GPU browser args) blocks below.
    #[cfg_attr(not(any(target_os = "macos", windows)), allow(unused_mut))]
    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        &label,
        tauri::WebviewUrl::App(url.into()),
    )
    .title(crate::profile::decorate_title("TermFlow"))
    .inner_size(1280.0, 800.0)
    // Center like the main window (the tauri.conf `center` flag only applies to
    // the boot-time window, not builder-spawned ones).
    .center()
    .resizable(true)
    // Frameless on Windows/Linux (the custom in-app title bar owns the chrome);
    // decorated on macOS so the Overlay title bar provides native traffic lights.
    .decorations(cfg!(target_os = "macos"));

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }

    // Must match every other webview's arguments exactly -- see gpu_preference.
    #[cfg(windows)]
    {
        builder = builder.additional_browser_args(crate::gpu_preference::browser_args());
    }

    // Reserve BEFORE build: the webview resolves its id as its first action.
    let reserved = reserve_window_id(app, &label);
    let window = builder.build().map_err(|e| e.to_string())?;
    crate::context_menu::install(&window);
    if let Some(id) = reserved {
        record_new_window(app, &window, id, (1280, 800));
    }
    Ok(label)
}

/// Command wrapper so a new window can also be opened from the renderer.
#[tauri::command]
pub async fn create_new_window(app_handle: tauri::AppHandle) -> Result<String, String> {
    let label = open_new_window(&app_handle, None)?;
    refresh_menu(&app_handle);
    Ok(label)
}

fn percent_encode_url_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(byte as char);
        } else {
            use std::fmt::Write;
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
}

/// Return the cold-launch folder once. Subsequent renderer calls receive `None`.
#[tauri::command]
pub fn take_pending_open_path(state: tauri::State<'_, AppState>) -> Option<String> {
    state
        .pending_open_path
        .lock()
        .ok()
        .and_then(|mut path| path.take())
}

/// Destroy the calling window directly (no close-confirm). Used when a window is
/// emptied by dragging its last tab elsewhere. Done in the backend so it doesn't
/// require the `core:window:allow-destroy` capability on the renderer side.
#[tauri::command]
pub fn close_self_window(window: tauri::WebviewWindow) -> Result<(), String> {
    let label = window.label().to_string();
    window.destroy().map_err(|e| e.to_string())?;
    log::info!("close_self_window: destroyed '{}' (emptied)", label);
    Ok(())
}

/// Resolve a possibly-bare executable name (e.g. "cmd.exe", "wsl.exe") to a full
/// path by searching PATH, so the icon can be read from the real binary.
#[cfg(windows)]
fn resolve_executable(path: &str) -> Option<std::path::PathBuf> {
    let p = std::path::Path::new(path);
    if p.is_absolute() && p.exists() {
        return Some(p.to_path_buf());
    }
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join(path);
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    if p.exists() { Some(p.to_path_buf()) } else { None }
}

/// Pick the best binary to read an icon from. Most shells carry their own icon,
/// but Git Bash's profile points at `…\Git\bin\bash.exe`, which only has a
/// generic icon — the real Git Bash logo lives on the launcher `git-bash.exe`
/// in the Git root (what the Start Menu shortcut uses).
#[cfg(windows)]
fn icon_source_for(exe: &std::path::Path) -> std::path::PathBuf {
    let file = exe
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or("")
        .to_lowercase();
    if file == "bash.exe" {
        if let Some(git_root) = exe.parent().and_then(|p| p.parent()) {
            let launcher = git_root.join("git-bash.exe");
            if launcher.exists() {
                return launcher;
            }
        }
    }
    exe.to_path_buf()
}

/// Session cache of resolved icon data URLs, keyed by the raw `path` argument.
/// The per-OS helper (PowerShell/osascript) or filesystem scan runs at most once
/// per unique path per session. Only `Ok` results are cached — a transient failure
/// must stay retryable.
static ICON_CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, String>>> =
    std::sync::OnceLock::new();

/// Extract an executable's icon as a base64 image data URL, so the New Tab profile
/// list and the running-agent chip can show the real binary icon. Returns a
/// `data:image/png;base64,…` (or `image/svg+xml` for a Linux themed SVG) URL, or an
/// `Err` when no icon is available — callers fall back to a glyph/dot.
///
/// Extraction shells out to an OS-native helper rather than a native icon crate:
/// the available crates pull in `gtk-sys`, which conflicts with Tauri's native libs
/// on Windows. The per-OS work lives in `extract_executable_icon`; this wrapper only
/// memoizes.
#[tauri::command]
pub fn get_executable_icon(path: String) -> Result<String, String> {
    let cache = ICON_CACHE.get_or_init(Default::default);
    if let Some(hit) = cache.lock().ok().and_then(|m| m.get(&path).cloned()) {
        return Ok(hit);
    }
    let res = extract_executable_icon(&path);
    if let Ok(ref url) = res {
        if let Ok(mut m) = cache.lock() {
            m.insert(path.clone(), url.clone());
        }
    }
    res
}

/// Windows: read the embedded icon via the OS's built-in .NET `System.Drawing`
/// through PowerShell. `CREATE_NO_WINDOW` keeps the helper from flashing a console.
#[cfg(windows)]
fn extract_executable_icon(path: &str) -> Result<String, String> {
    let resolved = resolve_executable(path)
        .ok_or_else(|| format!("executable not found: {}", path))?;
    let icon_src = icon_source_for(&resolved);
    // PowerShell single-quoted strings escape a quote by doubling it.
    let escaped = icon_src.to_string_lossy().replace('\'', "''");
    let script = format!(
        "Add-Type -AssemblyName System.Drawing; \
         $i = [System.Drawing.Icon]::ExtractAssociatedIcon('{}'); \
         $ms = New-Object System.IO.MemoryStream; \
         $i.ToBitmap().Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); \
         [Convert]::ToBase64String($ms.ToArray())",
        escaped
    );

    let mut cmd = std::process::Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd.output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "icon extraction failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let b64 = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if b64.is_empty() {
        return Err("icon extraction returned no data".to_string());
    }
    Ok(format!("data:image/png;base64,{}", b64))
}

/// macOS: ask AppKit's `NSWorkspace` for the file's icon and encode it as PNG, via
/// JXA (`osascript -l JavaScript`) — available on a stock macOS with no Xcode. A real
/// `.app` bundle returns its own icon; a plain binary or script with no icon resource
/// (most coding-agent CLIs — `codex`, `opencode`, `aider`, a `node`/`python` shim, …)
/// gets macOS's *generic* icon: a blank document or a unix-executable glyph. We reject
/// that generic icon (return `Err`) so callers fall back to a glyph/dot rather than
/// showing the meaningless blank document. Detection compares the file's icon bytes
/// against the generic `public.unix-executable` and `public.data` icons — unlike
/// Windows/`ExtractAssociatedIcon`, `NSWorkspace.iconForFile` never returns null, so
/// the comparison is what stands in for "no icon".
#[cfg(target_os = "macos")]
fn extract_executable_icon(path: &str) -> Result<String, String> {
    // `{:?}` emits a quoted, escaped JS string literal for the path. Literal JS braces
    // are doubled ({{ }}) to survive `format!`.
    let script = format!(
        "ObjC.import('AppKit');\
         var ws = $.NSWorkspace.sharedWorkspace;\
         function enc(image) {{\
           if (!image) return '';\
           var rep = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);\
           return rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $()).base64EncodedStringWithOptions(0).js;\
         }}\
         var p = {:?};\
         var img = ws.iconForFile(p);\
         if (!img) throw new Error('no icon');\
         var actual = enc(img);\
         if (actual === enc(ws.iconForFileType('public.unix-executable')) || actual === enc(ws.iconForFileType('public.data'))) throw new Error('generic icon');\
         actual",
        path
    );
    let output = std::process::Command::new("osascript")
        .args(["-l", "JavaScript", "-e", &script])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "icon extraction failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let b64 = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if b64.is_empty() {
        return Err("icon extraction returned no data".to_string());
    }
    Ok(format!("data:image/png;base64,{}", b64))
}

/// Linux / other unix: ELF binaries carry no embedded icon, so resolve the
/// freedesktop **icon theme** by the executable's basename. Returns a PNG (or SVG)
/// data URL, or `Err` when no themed icon exists (most CLI agents) → chip shows the dot.
#[cfg(all(unix, not(target_os = "macos")))]
fn extract_executable_icon(path: &str) -> Result<String, String> {
    use base64::Engine as _;
    let stem = std::path::Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "no basename".to_string())?
        .to_string();
    let found = find_freedesktop_icon(&stem, &xdg_data_dirs())
        .ok_or_else(|| format!("no themed icon for {}", stem))?;
    let bytes = std::fs::read(&found).map_err(|e| e.to_string())?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let mime = if found.extension().and_then(|e| e.to_str()) == Some("svg") {
        "image/svg+xml"
    } else {
        "image/png"
    };
    Ok(format!("data:{};base64,{}", mime, b64))
}

/// freedesktop icon search roots: `$XDG_DATA_HOME` (or `~/.local/share`) first, then
/// `$XDG_DATA_DIRS` (default `/usr/local/share:/usr/share`).
#[cfg(all(unix, not(target_os = "macos")))]
fn xdg_data_dirs() -> Vec<std::path::PathBuf> {
    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    match std::env::var("XDG_DATA_HOME") {
        Ok(h) if !h.is_empty() => roots.push(h.into()),
        _ => {
            if let Ok(home) = std::env::var("HOME") {
                roots.push(std::path::Path::new(&home).join(".local/share"));
            }
        }
    }
    let dirs = std::env::var("XDG_DATA_DIRS")
        .unwrap_or_else(|_| "/usr/local/share:/usr/share".to_string());
    for d in dirs.split(':').filter(|s| !s.is_empty()) {
        roots.push(d.into());
    }
    roots
}

/// Look for `<name>.png|svg` under each root's `icons/hicolor/<size>/apps/` (largest
/// size first, then `scalable`) and `pixmaps/`. Returns the first match, PNG before
/// SVG at a given size.
#[cfg(all(unix, not(target_os = "macos")))]
fn find_freedesktop_icon(name: &str, roots: &[std::path::PathBuf]) -> Option<std::path::PathBuf> {
    const SIZES: &[&str] = &[
        "512x512", "256x256", "128x128", "96x96", "64x64", "48x48", "32x32", "24x24", "16x16",
        "scalable",
    ];
    for root in roots {
        for size in SIZES {
            let apps = root.join("icons/hicolor").join(size).join("apps");
            for ext in ["png", "svg"] {
                let c = apps.join(format!("{}.{}", name, ext));
                if c.is_file() {
                    return Some(c);
                }
            }
        }
        for ext in ["png", "svg"] {
            let c = root.join("pixmaps").join(format!("{}.{}", name, ext));
            if c.is_file() {
                return Some(c);
            }
        }
    }
    None
}

// ----- Application menu ------------------------------------------------------

/// Build the full app menu, including a Window submenu that lists every open
/// window (so the user can jump to any of them). Built manually (rather than from
/// the platform default) so we can own the Window list and the File submenu.
///
/// macOS only: the menu lives in the global menu bar there. On Windows/Linux a
/// native menu renders as an in-window menu bar that duplicates our custom title
/// bar, so we never build or install one (see `refresh_menu`).
#[cfg(target_os = "macos")]
fn build_app_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};

    let app_menu = SubmenuBuilder::new(app, "TermFlow")
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let new_window = MenuItemBuilder::with_id("new_window", "New Window")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new_window)
        .separator()
        .close_window()
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    // Window submenu: standard items, then one entry per open window. The focused
    // window shows a checkmark; clicking an entry activates that window (handled in
    // lib.rs `on_menu_event`, id `focus:<label>`).
    let mut window_builder = SubmenuBuilder::new(app, "Window").minimize().separator();
    // Prefer the renderer-reported title (active tab) from AppState; fall back to
    // the native window title only if no report has arrived yet.
    let reported = app.try_state::<AppState>().map(|s| s.window_titles.clone());
    let mut entries: Vec<(String, String, bool)> = app
        .webview_windows()
        .iter()
        .filter(|(label, _)| label.as_str() != PREVIEW_LABEL)
        .map(|(label, w)| {
            let title = reported
                .as_ref()
                .and_then(|m| m.get(label).map(|r| r.value().clone()))
                .or_else(|| w.title().ok())
                .unwrap_or_else(|| label.clone());
            let focused = w.is_focused().unwrap_or(false);
            (label.clone(), title, focused)
        })
        .collect();
    entries.sort_by(|a, b| a.1.to_lowercase().cmp(&b.1.to_lowercase()));
    for (label, title, focused) in entries {
        let item = CheckMenuItemBuilder::with_id(format!("focus:{}", label), title)
            .checked(focused)
            .build(app)?;
        window_builder = window_builder.item(&item);
    }
    let window_menu = window_builder.build()?;

    MenuBuilder::new(app)
        .items(&[&app_menu, &file_menu, &edit_menu, &window_menu])
        .build()
}

/// Rebuild and apply the app menu. Call whenever the set of windows (or their
/// titles) changes so the Window submenu stays current.
pub fn refresh_menu(app: &tauri::AppHandle) {
    // macOS shows the app menu in the global menu bar. On Windows/Linux a native
    // menu becomes an in-window menu bar that duplicates the custom title bar, so
    // we install nothing there.
    #[cfg(target_os = "macos")]
    match build_app_menu(app) {
        Ok(menu) => {
            if let Err(e) = app.set_menu(menu) {
                log::error!("Failed to set menu: {}", e);
            }
        }
        Err(e) => log::error!("Failed to build menu: {}", e),
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Renderer-triggered menu refresh (e.g. after a window updates its title to the
/// active tab name) so the Window list shows meaningful names.
#[tauri::command]
pub fn refresh_window_menu(app_handle: tauri::AppHandle) {
    refresh_menu(&app_handle);
}

/// Set the calling window's display title (the active tab's title) and rebuild the
/// Window menu. The title is recorded in AppState first so the menu reads it
/// synchronously — no race against the not-yet-committed native title. We also set
/// the native title so macOS Mission Control / window lists stay in sync.
#[tauri::command]
pub fn set_window_title(
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    title: String,
) {
    // Decorate HERE, not once at startup: this fires on every tab change, so a
    // startup-only mark would vanish the first time the user switched tabs.
    let title = crate::profile::decorate_title(&title);
    state
        .window_titles
        .insert(window.label().to_string(), title.clone());
    let _ = window.set_title(&title);
    refresh_menu(window.app_handle());
}

// ----- Tab tear-off preview window ------------------------------------------
//
// A DOM ghost can't render outside its own window, so the live drag preview is a
// real, frameless, transparent, click-through, always-on-top window that follows
// the cursor across the whole desktop (and other monitors). It loads the app
// bundle with `?dragPreview=1`, which renders only a small window-shaped card.

const PREVIEW_LABEL: &str = "drag-preview";
const PREVIEW_W: f64 = 300.0;
const PREVIEW_H: f64 = 195.0;
// Place the card so the cursor sits over its title bar, not the corner.
const PREVIEW_OFFSET_X: f64 = 46.0;
const PREVIEW_OFFSET_Y: f64 = 18.0;

/// Convert a CLIENT (content-relative, logical CSS px) point in `window` to a
/// physical screen position, offset so the preview card sits under the cursor.
/// We use the source window's content origin + scale (reliable, top-left origin)
/// rather than `cursor_position()`, which errors in this app's webview.
fn preview_position(
    window: &tauri::WebviewWindow,
    cx: f64,
    cy: f64,
) -> Option<tauri::PhysicalPosition<f64>> {
    let origin = window.inner_position().ok()?;
    let scale = window.scale_factor().unwrap_or(1.0);
    Some(tauri::PhysicalPosition::new(
        origin.x as f64 + (cx - PREVIEW_OFFSET_X) * scale,
        origin.y as f64 + (cy - PREVIEW_OFFSET_Y) * scale,
    ))
}

/// Percent-encode a string for use as a URL query value (dependency-free).
fn encode_query(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{:02X}", b),
        })
        .collect()
}

/// Show (creating on first use) the tear-off preview at the cursor with `title`.
/// `x`/`y` are CLIENT coords in the calling (source) window.
#[tauri::command]
pub async fn show_drag_preview(
    app_handle: tauri::AppHandle,
    window: tauri::WebviewWindow,
    title: String,
    x: f64,
    y: f64,
) -> Result<(), String> {
    let win = if let Some(w) = app_handle.get_webview_window(PREVIEW_LABEL) {
        // Reuse the existing preview window; just refresh its title.
        let _ = w.emit("drag-preview:title", title.clone());
        w
    } else {
        let url = format!("index.html?dragPreview=1&title={}", encode_query(&title));
        #[cfg_attr(not(windows), allow(unused_mut))]
        let mut builder = tauri::WebviewWindowBuilder::new(
            &app_handle,
            PREVIEW_LABEL,
            tauri::WebviewUrl::App(url.into()),
        )
        .inner_size(PREVIEW_W, PREVIEW_H)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .focused(false)
        .visible(false);

        // Must match every other webview's arguments exactly -- see gpu_preference.
        #[cfg(windows)]
        {
            builder = builder.additional_browser_args(crate::gpu_preference::browser_args());
        }

        let w = builder.build().map_err(|e| e.to_string())?;
        // Click-through so it never steals the in-flight drag's pointer events.
        let _ = w.set_ignore_cursor_events(true);
        w
    };

    if let Some(pos) = preview_position(&window, x, y) {
        let _ = win.set_position(pos);
    }
    let _ = win.show();
    Ok(())
}

/// Move the preview to follow the cursor (called per animation frame while
/// dragging). `x`/`y` are CLIENT coords in the calling (source) window.
#[tauri::command]
pub async fn move_drag_preview(
    app_handle: tauri::AppHandle,
    window: tauri::WebviewWindow,
    x: f64,
    y: f64,
) -> Result<(), String> {
    if let Some(win) = app_handle.get_webview_window(PREVIEW_LABEL) {
        if let Some(pos) = preview_position(&window, x, y) {
            let _ = win.set_position(pos);
        }
    }
    Ok(())
}

/// Hide the preview window (kept alive for reuse on the next drag).
#[tauri::command]
pub async fn hide_drag_preview(app_handle: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app_handle.get_webview_window(PREVIEW_LABEL) {
        let _ = win.hide();
    }
    Ok(())
}

/// Source-driven cross-window tab drop. macOS routes a button-drag's events to
/// the SOURCE window, so the destination window can't detect the release itself.
/// Instead the source reports the release point (CLIENT coords in the source
/// window) and we hit-test it against every other window's screen rect. If it
/// lands on one, we tell that window to reattach the tab (it takes the stashed
/// payload by `token`) and return true; otherwise return false so the caller
/// opens a new window. The payload must already be stashed under `token`.
#[tauri::command]
pub fn resolve_tab_drop(
    app_handle: tauri::AppHandle,
    window: tauri::WebviewWindow,
    token: String,
    x: f64,
    y: f64,
) -> Result<bool, String> {
    // Global physical point of the drop, from the source window's content origin.
    let (px, py) = match (window.inner_position(), window.scale_factor()) {
        (Ok(origin), Ok(scale)) => (origin.x as f64 + x * scale, origin.y as f64 + y * scale),
        _ => return Ok(false),
    };
    let source_label = window.label().to_string();
    log::info!(
        "resolve_tab_drop: drop=({:.0},{:.0}) source={} client=({:.0},{:.0})",
        px, py, source_label, x, y
    );
    for (label, w) in app_handle.webview_windows() {
        if label == source_label || label == PREVIEW_LABEL {
            continue;
        }
        if let (Ok(pos), Ok(size)) = (w.outer_position(), w.outer_size()) {
            let hit = point_in_rect(px, py, pos.x as f64, pos.y as f64, size.width as f64, size.height as f64);
            log::info!(
                "  candidate {} rect=({},{} {}x{}) hit={}",
                label, pos.x, pos.y, size.width, size.height, hit
            );
            if hit {
                // Broadcast with the target label in the payload; every window's
                // listener acts only if it IS the target. (Same proven pattern as
                // `app:close-requested`. A bare emit_to wasn't reaching the JS
                // listener, and w.emit would let the source steal its own payload.)
                let _ = app_handle.emit(
                    "tab-drag:reattach",
                    serde_json::json!({ "token": token, "target": label }),
                );
                let _ = w.set_focus(); // bring the receiving window to the front
                // Deliberately NOT restore_and_focus: this path only raises the window, and
                // unminimizing a window the user left minimized would be a behaviour change.
                // But `set_focus` on Windows CAN restore a minimized window, so the webview's
                // visibility has to be re-derived from the window's actual state either way —
                // otherwise a tab dropped into a minimized window reveals a blank one.
                crate::webview_power::sync(&w);
                log::info!("resolve_tab_drop: reattaching into {}", label);
                return Ok(true);
            }
        } else {
            log::info!("  candidate {} position/size unavailable", label);
        }
    }
    log::info!("resolve_tab_drop: no window under drop point -> new window");
    Ok(false)
}

// ----- Cross-window drag broker (Phase 4, target-claims) --------------------
//
// Pointer events don't cross OS windows, so we don't try to guess coordinates
// from the source. Instead: the source registers an active drag and broadcasts
// it; whichever window the user releases over CLAIMS the pane using its own
// accurate local coordinates, then the source is told to remove its pane. If no
// window claims it (released over empty desktop), the source resolves it as an
// orphan and opens a new window.

use tauri::{Manager, Emitter};
use crate::state::GlobalDrag;

/// Pure point-in-rect test. Retained (unit-tested) for any future hit-testing.
pub fn point_in_rect(px: f64, py: f64, rx: f64, ry: f64, rw: f64, rh: f64) -> bool {
    px >= rx && px < rx + rw && py >= ry && py < ry + rh
}

/// Source registers an in-flight cross-window drag and stashes its payload. The
/// `pane-drag:active` broadcast lets every window know it may become a drop target.
#[tauri::command]
pub fn begin_global_pane_drag(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    window: tauri::Window,
    token: String,
    payload: serde_json::Value,
) -> Result<(), String> {
    state.detach_payloads.insert(token.clone(), payload);
    *state.active_global_drag.lock().map_err(|e| e.to_string())? = Some(GlobalDrag {
        token: token.clone(),
        source_label: window.label().to_string(),
    });
    let _ = app_handle.emit("pane-drag:active", token);
    Ok(())
}

/// A window the cursor was released over claims the active drag. Returns the
/// payload (so the claimer can insert the pane) and notifies the source to drop
/// its copy. Single-use: returns None if already claimed/cancelled.
#[tauri::command]
pub fn claim_global_pane_drag(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    token: String,
) -> Result<Option<serde_json::Value>, String> {
    let mut guard = state.active_global_drag.lock().map_err(|e| e.to_string())?;
    match guard.as_ref() {
        Some(g) if g.token == token => {
            let source_label = g.source_label.clone();
            *guard = None;
            drop(guard);
            let payload = state.detach_payloads.remove(&token).map(|(_, v)| v);
            if let Some(src) = app_handle.get_webview_window(&source_label) {
                let _ = src.emit("pane-drag:claimed", token.clone());
            }
            let _ = app_handle.emit("pane-drag:ended", ());
            Ok(payload)
        }
        _ => Ok(None),
    }
}

/// The SOURCE resolves a drag that no window claimed (released over empty desktop)
/// -> it should open a new window. Returns true if this caller still owns the
/// active drag (payload is left stashed for create_detached_window to consume).
#[tauri::command]
pub fn resolve_orphan_global_drag(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    window: tauri::Window,
    token: String,
) -> Result<bool, String> {
    let mut guard = state.active_global_drag.lock().map_err(|e| e.to_string())?;
    match guard.as_ref() {
        Some(g) if g.token == token && g.source_label == window.label() => {
            *guard = None;
            drop(guard);
            let _ = app_handle.emit("pane-drag:ended", ());
            Ok(true)
        }
        _ => Ok(false),
    }
}

/// Cancel an in-flight drag (cursor returned inside the source, or Escape).
#[tauri::command]
pub fn cancel_global_pane_drag(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    token: String,
) -> Result<(), String> {
    let mut guard = state.active_global_drag.lock().map_err(|e| e.to_string())?;
    let owns = matches!(guard.as_ref(), Some(g) if g.token == token);
    if owns {
        *guard = None;
    }
    drop(guard);
    state.detach_payloads.remove(&token);
    let _ = app_handle.emit("pane-drag:ended", ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::point_in_rect;

    #[test]
    fn point_inside_rect() {
        assert!(point_in_rect(50.0, 50.0, 0.0, 0.0, 100.0, 100.0));
        assert!(point_in_rect(0.0, 0.0, 0.0, 0.0, 100.0, 100.0)); // top-left inclusive
    }

    #[test]
    fn point_outside_rect() {
        assert!(!point_in_rect(150.0, 50.0, 0.0, 0.0, 100.0, 100.0));
        assert!(!point_in_rect(100.0, 50.0, 0.0, 0.0, 100.0, 100.0)); // right edge exclusive
        assert!(!point_in_rect(-1.0, 50.0, 0.0, 0.0, 100.0, 100.0));
    }
}

// Scrollback-persistence ratchet regression tests (partial-scrollback bug):
// restored history must be seeded into the fresh authoritative parser, and a
// dying session's parser must be persisted before cleanup — otherwise every
// restart's first flush overwrites the stored history with only post-restart
// content. Gated: needs tauri's `test` feature (mock_app), which breaks the
// Windows test binary at loader time, so these run on Linux/macOS CI only:
//   cargo test --features integration-tests
// (see api_server.rs for the precedent).
#[cfg(all(test, feature = "integration-tests"))]
mod scrollback_restore_tests {
    use crate::state::AppState;

    fn temp_db(tag: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("termflow_ratchet_{}_{}.db", std::process::id(), tag));
        let _ = std::fs::remove_file(&p);
        p
    }

    fn mock_state() -> (tauri::App<tauri::test::MockRuntime>, AppState<tauri::test::MockRuntime>) {
        let app = tauri::test::mock_app();
        let (tx, _rx) = tokio::sync::broadcast::channel(16);
        let state = AppState::new(
            tx,
            app.handle().clone(),
            crate::app_config::NetworkConfig::defaults(),
        );
        (app, state)
    }

    fn register_terminal(state: &AppState<tauri::test::MockRuntime>, id: &str) {
        state.terminals.insert(
            id.to_string(),
            crate::state::Terminal {
                id: id.to_string(),
                pid: 0,
                shell: "test".to_string(),
                name: "Terminal-test".to_string(),
                created_at: chrono::Local::now().to_rfc3339(),
                cols: 80,
                rows: 24,
                backend: crate::tmux_manager::TerminalBackend::PortablePty,
                renderer_terminal_id: Some(id.to_string()),
                owning_tab_id: Some(id.to_string()),
                session_key: id.to_string(),
                last_input_source: None,
                last_input_at: None,
                prompt_hook: false,
                display_label: None,
            },
        );
    }

    /// The ratchet itself: stage_scrollback must seed the freshly-initialized
    /// parser with the persisted blob, so the next persist writes old + new
    /// content instead of clobbering the stored history with only new content.
    #[test]
    fn stage_scrollback_seeds_parser_so_flush_preserves_history() {
        let (_app, state) = mock_state();
        state.history_store.init(&temp_db("seed"));

        // A previous session's persisted scrollback.
        let mut p1 = vt100::Parser::new(24, 80, 5000);
        for i in 0..100 {
            p1.process(format!("old-line-{:04}\r\n", i).as_bytes());
        }
        let blob1 = String::from_utf8_lossy(
            &crate::state::render_full_scrollback(p1.screen_mut()).expect("dump"),
        )
        .into_owned();
        state.history_store.upsert("tb-hist", std::slice::from_ref(&blob1), 1);

        // App restart: fresh parser for the same tab, restore staged, new output.
        state.init_screen("tb-hist", 24, 80);
        register_terminal(&state, "tb-hist");
        super::stage_scrollback(&state, "tb-hist", "tb-hist");
        state.feed_screen("tb-hist", b"new-session output\r\n");

        // The next flush must preserve the restored history.
        state.persist_terminal_history("tb-hist", 2);
        let stored = state.history_store.get("tb-hist").expect("row").concat();
        assert!(
            stored.contains("old-line-0000"),
            "restored history must survive the next flush (ratchet regression)"
        );
        assert!(stored.contains("session restored"), "divider must be persisted");
        assert!(stored.contains("new-session output"), "new output must be persisted");
        // The renderer's one-shot replay prefix must still be staged unchanged.
        assert!(state.replay_prefix.get("tb-hist").is_some(), "renderer prefix must stay staged");
    }

    /// A dying session must persist its final parser state under its tab_id
    /// (exit paths call this before cleanup_terminal_state, which would other-
    /// wise discard the last <30s of output along with the parser).
    #[test]
    fn persist_terminal_history_writes_parser_dump_under_tab_id() {
        let (_app, state) = mock_state();
        state.history_store.init(&temp_db("exit"));
        state.init_screen("tb-exit", 24, 80);
        register_terminal(&state, "tb-exit");
        state.feed_screen("tb-exit", b"final words before exit\r\n");

        state.persist_terminal_history("tb-exit", 123);

        let stored = state.history_store.get("tb-exit").expect("row").concat();
        assert!(stored.contains("final words before exit"));

        // After cleanup (the exit path's next step) the row must remain intact.
        state.cleanup_terminal_state("tb-exit");
        assert!(state.history_store.get("tb-exit").is_some());
    }

    /// ED3 resize-wipe repair (review 27/codex): the repair path does
    /// `reset()` + `write(blob)` on the client, which is a raw content replay
    /// with no position tracking of its own. Without restoring the program's
    /// actual cursor position, a repaired pane's cursor would sit wherever the
    /// last replayed line's `\r\n` happened to land — not where the still-
    /// running program (and the backend's own live parser) believes it is.
    #[test]
    fn full_scrollback_snapshot_restores_cursor_position() {
        let (_app, state) = mock_state();
        state.init_screen("tb-cursor", 24, 80);
        register_terminal(&state, "tb-cursor");
        // Cursor ends up at row 1 (0-indexed), right after "second" — NOT at a
        // fresh line start, which is what a naive "just replay the rows" blob
        // would otherwise leave it at.
        state.feed_screen("tb-cursor", b"first line\r\nsecond");

        let blob = state.full_scrollback_snapshot("tb-cursor").expect("nonblank");
        let text = String::from_utf8_lossy(&blob);

        assert!(text.contains("second"), "content must still be present, got:\n{text}");
        // 1-indexed CUP targeting row 2, col 7 (0-indexed row 1, col 6 — right
        // after "second"). Confirmed against vt100 0.16.2's grid.rs: with no
        // prior position to diff against, write_cursor_position_formatted's
        // non-overflow branch always emits MoveTo (never MoveFromTo), and
        // MoveTo's BufWrite impl always uses the CUP `H` final, never `f`.
        assert!(
            text.contains("\x1b[2;7H"),
            "cursor position must be restored to match the live parser, got:\n{text:?}"
        );
    }
}

// Linux/other-unix freedesktop icon-theme lookup. Gated to unix (mirrors the
// `find_freedesktop_icon` cfg) so it validates on Linux CI without affecting the
// Windows/macOS build.
#[cfg(all(test, unix, not(target_os = "macos")))]
mod freedesktop_icon_tests {
    use super::find_freedesktop_icon;
    use std::fs;
    use std::path::PathBuf;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("agenticon_{}_{}", std::process::id(), tag));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn touch(path: &PathBuf) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"x").unwrap();
    }

    #[test]
    fn finds_app_png_in_hicolor() {
        let root = scratch("found");
        let icon = root.join("icons/hicolor/256x256/apps/mytool.png");
        touch(&icon);
        assert_eq!(
            find_freedesktop_icon("mytool", &[root.clone()]).as_deref(),
            Some(icon.as_path())
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn returns_none_when_absent() {
        let root = scratch("absent");
        fs::create_dir_all(root.join("icons/hicolor/256x256/apps")).unwrap();
        assert_eq!(find_freedesktop_icon("nope", &[root.clone()]), None);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn prefers_larger_size() {
        let root = scratch("size");
        let big = root.join("icons/hicolor/256x256/apps/dup.png");
        let small = root.join("icons/hicolor/48x48/apps/dup.png");
        touch(&big);
        touch(&small);
        assert_eq!(
            find_freedesktop_icon("dup", &[root.clone()]).as_deref(),
            Some(big.as_path())
        );
        let _ = fs::remove_dir_all(&root);
    }
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
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("commands.rs");
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
        for api in ["live_siblings_now", "describe_unarmable", "arm_siblings", "update_preflight"] {
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

    /// The asymmetry that produced the report: the panel showed offload as
    /// available while the button ran a stricter check, so the refusal arrived
    /// as a toast after the click. One shared function, so they cannot diverge.
    #[test]
    fn the_settings_preflight_runs_the_same_check_the_button_enforces() {
        let src = source();
        let shown = fn_body(&src, "pub fn hotswap_available");
        let enforced = fn_body(&src, "pub async fn restart_for_update");
        assert!(shown.contains("offload_preflight"), "panel must use the shared check: {shown}");
        assert!(enforced.contains("offload_preflight"), "button must use the shared check");
    }

    /// Update's reach IS real — Velopack kills every process under the install
    /// root — so it must still consider siblings, unlike offload.
    #[test]
    fn update_still_considers_siblings() {
        let body = fn_body(&source(), "pub fn update_preflight");
        assert!(body.contains("live_siblings_now"), "update must enumerate siblings: {body}");
        assert!(body.contains("hotswap_preflight"), "update must also guard our own terminals");
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

#[cfg(test)]
mod host_identity_tests {
    use super::host_identity;

    /// **AMENDED by design 014.** These tests previously asserted that the DashMap
    /// key *is* the renderer leaf — true before 014, and the exact collapse that
    /// made "Terminal ID" and "Process ID" display the same `tb-` value. The map
    /// key is now a minted `pc-`.
    ///
    /// What did NOT change, and is still asserted below: the **session key** stays
    /// the leaf. That is the hot-swap reattach key (ground-truth correction C2),
    /// and moving it would orphan every armed session — the pty-host protocol has
    /// no rename verb (design 014 §A2).
    #[test]
    fn the_map_key_is_a_minted_process_id_not_the_leaf() {
        let h = host_identity("tm-9f2c1a4b7", Some("tm-9f2c1a4b7"), Some("tb-4e8d0c2f1"));
        assert!(h.process_id.starts_with("pc-"), "map key must be pc-, got {}", h.process_id);
        assert_ne!(h.process_id, h.session_key, "the 014 §A1 separation");
        assert_ne!(Some(h.process_id.clone()), h.owner);
    }

    #[test]
    fn the_session_key_still_tracks_the_leaf_so_reattach_survives() {
        let h = host_identity("tm-9f2c1a4b7", Some("tm-9f2c1a4b7"), Some("tb-4e8d0c2f1"));
        assert_eq!(h.session_key, "tm-9f2c1a4b7", "the sidecar reattach key must not move");
        assert_eq!(h.leaf.as_deref(), Some("tm-9f2c1a4b7"));
        assert_eq!(h.owner.as_deref(), Some("tb-4e8d0c2f1"));
    }

    /// The upgrade case: the pane tree now says `tm-new`, but the host still
    /// knows this session as `tb-old`. Renaming it would lose the session.
    #[test]
    fn a_migrated_terminal_keeps_its_legacy_session_key_while_the_leaf_moves() {
        let h = host_identity("tb-old00001", Some("tm-new00001"), Some("tb-old00001"));
        assert_eq!(h.session_key, "tb-old00001", "reattach key MUST NOT move");
        assert_eq!(h.leaf.as_deref(), Some("tm-new00001"));
        assert!(h.process_id.starts_with("pc-"));
    }

    /// Two spawns must never collide on the map key.
    #[test]
    fn each_spawn_mints_a_distinct_process_id() {
        let a = host_identity("tm-a", Some("tm-a"), None);
        let b = host_identity("tm-b", Some("tm-b"), None);
        assert_ne!(a.process_id, b.process_id);
    }

    /// A missing owner stays missing. Design 011 §3 let it "degrade to the leaf" on
    /// the rule that a root/solo pane owns itself — which held only while a root leaf
    /// WAS its tab id. After 014 that fallback files a TERMINAL id as an owning TAB
    /// id, which is not a degraded answer but a wrong one: it names a tab that does
    /// not exist. The renderer sends the real owner (and re-sends it after the spawn
    /// when its pane tree lands), so `None` is the correct interim value.
    #[test]
    fn a_missing_owner_stays_none_rather_than_degrading_to_the_leaf() {
        let h = host_identity("tm-9f2c1a4b7", Some("tm-9f2c1a4b7"), None);
        assert_eq!(h.owner, None);
        assert_eq!(h.leaf.as_deref(), Some("tm-9f2c1a4b7"), "the leaf itself is unaffected");
    }

    /// A headless spawn has no renderer pane, so no leaf — and must not invent
    /// one (design 011 §5 keeps such terminals out of the history table). It has no
    /// tab either, so it must not invent an owner from its session key.
    #[test]
    fn a_headless_spawn_invents_neither_a_leaf_nor_an_owner() {
        let h = host_identity("pc-headless", None, None);
        assert!(h.leaf.is_none(), "must not invent a leaf");
        assert_eq!(h.owner, None, "a pc- session key is not a tab");
    }

    /// The caller's owner is still carried through untouched — the deletion above
    /// removed the INVENTED values, not the real one.
    #[test]
    fn a_supplied_owner_is_carried_through() {
        let h = host_identity("tm-9f2c1a4b7", Some("tm-9f2c1a4b7"), Some("tb-4e8d0c2f1"));
        assert_eq!(h.owner.as_deref(), Some("tb-4e8d0c2f1"));
    }
}

/// The offload guard `hotswap_preflight` refuses whenever ANY live terminal is
/// in-process, because a hot-swap would kill it. Two API spawn sites
/// (`api_server::create_terminal` and `api_server::fleet_local_run`) used to call
/// `pty_manager::spawn_terminal` directly, so every agent/MCP-created terminal was
/// in-process and permanently blocked "Offload & Close" — the reported symptom in
/// plan 019. The fix routes both through [`spawn_routed`].
///
/// These tests exist because the bug is a CLASS, not an instance: `spawn_routed`
/// is the only thing that makes the host-vs-in-process decision, and nothing in the
/// type system stops a FOURTH spawn site — in any module, including one that does
/// not exist yet — from bypassing it and silently re-arming the trap (plan 019
/// §2.1). Source lines are CRLF-normalised: a source-derived assertion that matches
/// a literal newline passes on a Linux runner and fails on a Windows checkout (the
/// Rust twin of the `utils/readSource` e2e fix).
#[cfg(test)]
mod api_spawn_routing_tests {
    /// The API is the ONLY caller that supplies a name (an agent labelling its own
    /// terminal, e.g. `bl108-external-review`). `register_host_terminal` used to
    /// hardcode `Terminal-{shell}`, so routing the API through the host path
    /// without this would silently rename every agent terminal — and that name is
    /// what `list_terminals` returns for agents to find themselves by
    /// (`api_server.rs` `terminal_identity_json`).
    #[test]
    fn a_caller_supplied_name_survives_the_routed_spawn() {
        assert_eq!(
            super::terminal_display_name(Some("bl108-external-review"), "powershell"),
            "bl108-external-review",
        );
    }

    /// The renderer passes `None` and expects the derived default — one definition
    /// for both spawn paths, so a fallback can no longer rename a terminal.
    #[test]
    fn no_name_derives_the_shell_default() {
        assert_eq!(super::terminal_display_name(None, "powershell"), "Terminal-powershell");
    }

    /// A blank/whitespace name is a missing name, not an empty title: an untitled
    /// terminal in the tab strip would otherwise be indistinguishable from a bug.
    #[test]
    fn a_blank_name_falls_back_to_the_default() {
        assert_eq!(super::terminal_display_name(Some("   "), "cmd"), "Terminal-cmd");
        assert_eq!(super::terminal_display_name(Some(""), "cmd"), "Terminal-cmd");
    }

    /// Does this line CALL `spawn_terminal`, however it was reached?
    ///
    /// Matches the fully-qualified form (`crate::pty_manager::spawn_terminal(`), the
    /// bare form a `use crate::pty_manager::spawn_terminal;` import enables, and a
    /// spaced `spawn_terminal (`. Rejects the definition itself, a longer identifier
    /// that merely ends in the name, and comment prose — so a doc comment may still
    /// say the word.
    fn calls_spawn_terminal(line: &str) -> bool {
        const NAME: &str = "spawn_terminal";
        let code = line.trim_start();
        if code.starts_with("//") || code.starts_with('*') {
            return false;
        }
        let Some(pos) = code.find(NAME) else { return false };
        let before = &code[..pos];
        // `my_spawn_terminal(` is a different function.
        if before.chars().last().is_some_and(|c| c.is_alphanumeric() || c == '_') {
            return false;
        }
        // `fn spawn_terminal(` is the declaration, not a call.
        if before.trim_end().ends_with("fn") {
            return false;
        }
        code[pos + NAME.len()..].trim_start().starts_with('(')
    }

    /// Every `.rs` file in the crate, read from the real source tree at test time.
    ///
    /// Deliberately NOT a hardcoded list, and deliberately not just `api_server.rs`:
    /// a brand-new module is the easiest way to walk past this guard (external review
    /// of PR #45, F-01), and a list maintained by hand cannot see a file nobody
    /// remembered to add to it. Reading the directory means the audit's coverage is
    /// derived from reality rather than asserted.
    fn crate_sources() -> Vec<(String, String)> {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let entries = std::fs::read_dir(&dir).unwrap_or_else(|e| {
            panic!(
                "cannot read {} to audit spawn sites ({e}) — this guard must FAIL loudly \
                 rather than pass vacuously",
                dir.display()
            )
        });
        let mut sources = Vec::new();
        for entry in entries {
            let path = entry.expect("unreadable source dir entry").path();
            if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                continue;
            }
            let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
            let text = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("cannot read {name} to audit spawn sites: {e}"))
                .replace("\r\n", "\n");
            sources.push((name, text));
        }
        assert!(
            sources.len() > 20,
            "found only {} source files — the audit is not seeing the real tree",
            sources.len()
        );
        sources
    }

    /// The pty-host methods that ADDRESS a specific session. Every one of them
    /// must be handed an id in the HOST's id space.
    const HOST_ADDRESSED: [&str; 6] = [
        "write_stdin",
        "resize",
        "close",
        "nudge_repaint",
        "attach_confirmed",
        "spawn_session",
    ];

    /// The first argument of `call`, with `&` and whitespace stripped.
    fn first_arg(code: &str, after: usize) -> String {
        let rest = &code[after..];
        let end = rest.find([',', ')']).unwrap_or(rest.len());
        rest[..end].trim().trim_start_matches('&').trim().to_string()
    }

    /// **Every call that crosses into the pty-host must be addressed in the host's
    /// id space**, never with one of our process ids.
    ///
    /// Since design 014 the process id (`pc-`) and the session key are different
    /// strings. Addressing the host with a process id does not error — the host
    /// has simply never heard of it, so the write, resize or close silently does
    /// nothing. That is invisible in every test that does not run a real host,
    /// which is why this is asserted from source.
    ///
    /// The rule is POSITIVE (the argument must name the host's space) rather than
    /// a blocklist of bad names: a blocklist cannot see a new variable someone
    /// invents. The host's space is named either `session_key` (ours) or `tab_id`
    /// (the protocol's own field name for the same thing).
    #[test]
    fn every_host_addressed_call_uses_the_host_id_space() {
        let mut checked = 0;
        for (name, text) in crate_sources() {
            // The client module DEFINES these methods; its parameters are the
            // host's space by construction.
            if name == "pty_host_client.rs" {
                continue;
            }
            for line in text.lines() {
                let code = line.trim_start();
                if code.starts_with("//") || code.starts_with('*') {
                    continue;
                }
                for method in HOST_ADDRESSED {
                    for prefix in ["c.", "client."] {
                        let pat = format!("{prefix}{method}(");
                        let Some(pos) = code.find(&pat) else { continue };
                        let arg = first_arg(code, pos + pat.len());
                        checked += 1;
                        assert!(
                            arg.contains("session_key") || arg.contains("tab_id"),
                            "{name}: `{prefix}{method}` is addressed with `{arg}`, which is not \
                             the host's id space. The host knows this terminal only by its \
                             session key; a process id silently does nothing (design 014 §A2).\n  \
                             line: {code}"
                        );
                    }
                }
            }
        }
        assert!(
            checked >= 5,
            "only {checked} host-addressed calls found — the guard is not seeing the real tree, \
             so it would pass vacuously"
        );
    }

    /// The matcher is the load-bearing part, so pin it directly: every evasion form
    /// must be caught, and every non-call must not be.
    #[test]
    fn the_matcher_catches_every_way_of_calling_it() {
        for call in [
            "    let x = crate::pty_manager::spawn_terminal(",
            "    let x = pty_manager::spawn_terminal(state, cols, rows);",
            "    let x = spawn_terminal(state, cols, rows);", // after a `use` import
            "    let x = spawn_terminal (state);",
        ] {
            assert!(calls_spawn_terminal(call), "missed a real call: {call}");
        }
        for not_a_call in [
            "pub fn spawn_terminal(",
            "    // spawn_terminal(state) is what this replaced",
            "    /// see spawn_terminal(…) for the in-process path",
            "    let x = my_spawn_terminal(state);",
            "    let spec = build_spawn_spec(&id);",
            "    // registers before spawn_terminal returns",
        ] {
            assert!(!calls_spawn_terminal(not_a_call), "false positive: {not_a_call}");
        }
    }

    #[test]
    fn no_module_outside_the_router_spawns_a_terminal_in_process() {
        // `commands.rs` IS the router (it owns `spawn_routed` and its in-process
        // `host_fallback`); `pty_manager.rs` declares the function. Every other
        // module must go through `spawn_routed`.
        const ALLOWED: [&str; 2] = ["commands.rs", "pty_manager.rs"];

        let offenders: Vec<String> = crate_sources()
            .iter()
            .filter(|(name, _)| !ALLOWED.contains(&name.as_str()))
            .flat_map(|(name, text)| {
                text.lines()
                    .enumerate()
                    .filter(|(_, line)| calls_spawn_terminal(line))
                    .map(move |(i, line)| format!("  {}:{}: {}", name, i + 1, line.trim()))
            })
            .collect();

        assert!(
            offenders.is_empty(),
            "a spawn site outside the router calls pty_manager::spawn_terminal directly \
             instead of commands::spawn_routed. Terminals it creates are in-process, so \
             they are lost by a hot-swap and `hotswap_preflight` refuses Offload & Close \
             for as long as one is alive (plan 019):\n{}",
            offenders.join("\n")
        );
    }
}

/// The renderer create path's own root-leaf reservation (external review 101, F1).
///
/// Plain `#[cfg(test)]` — nothing here needs tauri's `test` feature, which breaks
/// the Windows test binary at loader time (see the gate on
/// `scrollback_restore_tests` above).
#[cfg(test)]
mod root_leaf_reservation_tests {
    use super::root_leaf_owner_to_reserve;
    use crate::state::RootLeafClaims;
    use std::sync::Arc;

    #[test]
    fn every_spawn_with_a_leaf_reserves_that_leaf() {
        // The claim is about the LEAF — two creates naming the same leaf are the
        // contested case, and the owning tab is irrelevant to that. Shape of the
        // owner argument must not change the answer.
        assert_eq!(
            root_leaf_owner_to_reserve(Some("tm-9f2c1a4"), Some("tb-a1b2c3")),
            Some("tm-9f2c1a4".to_string()),
        );
        assert_eq!(
            root_leaf_owner_to_reserve(Some("tm-9f2c1a4"), None),
            Some("tm-9f2c1a4".to_string()),
        );
    }

    /// The regression this rewrite exists for. Both old arms required either
    /// `leaf == owner` or a `tb-` leaf, and design 014 made each unsatisfiable —
    /// so the tripwire silently stopped claiming anything at all while still
    /// reading like live protection.
    #[test]
    fn a_modern_tm_leaf_is_not_silently_unclaimed() {
        assert!(
            root_leaf_owner_to_reserve(Some("tm-9f2c1a4"), Some("tb-a1b2c3")).is_some(),
            "a tm- leaf is what EVERY spawn carries now; claiming nothing for it \
             disables the tripwire entirely",
        );
    }

    #[test]
    fn a_headless_spawn_with_no_leaf_reserves_nothing() {
        // Nothing to collide on, and nothing to name a claim with.
        assert_eq!(root_leaf_owner_to_reserve(None, None), None);
        assert_eq!(root_leaf_owner_to_reserve(None, Some("tb-a1b2c3")), None);
    }

    /// The old second arm reserved a `tb-` leaf that may have MOVED to another
    /// tab, so the claim could name a terminal other than the one being spawned —
    /// documented at the time as a tolerated false reservation. Keying on the leaf
    /// removes it: a leaf id names exactly one terminal, wherever its pane lives.
    #[test]
    fn the_claim_always_names_the_leaf_being_spawned() {
        assert_eq!(
            root_leaf_owner_to_reserve(Some("tm-moved001"), Some("tb-target007")),
            Some("tm-moved001".to_string()),
            "the claim follows the leaf, not the tab it currently sits in",
        );
    }

    #[test]
    fn a_second_claim_on_the_same_owner_is_refused_until_the_first_is_released() {
        // Review 109 LOW: this proves only what `RootLeafClaims` itself does —
        // the SECOND `try_claim` for a live owner returns `None` until the first
        // is dropped. It is NOT a proof that `commands::create_terminal` refuses
        // or coalesces a second spawn on `None` — it does not; see the comment
        // there. And since option A, the REST/API path never calls `try_claim`
        // at all (`resolve_api_spawn_identity` mints a fresh `tm-` unconditionally),
        // so this is exclusively a renderer-vs-renderer scenario now (e.g. two
        // re-entrant restarts of the same tab root — review 109 H1), not a
        // renderer-vs-REST one.
        let claims: Arc<RootLeafClaims> = Arc::new(RootLeafClaims::default());
        let renderer = claims.try_claim("tb-a1b2c3");
        assert!(renderer.is_some(), "the first creator reserves the owner");
        assert!(
            claims.try_claim("tb-a1b2c3").is_none(),
            "a concurrent claim on the same owner is refused",
        );
        drop(renderer);
        assert!(
            claims.try_claim("tb-a1b2c3").is_some(),
            "the owner is free again once the winning spawn has registered",
        );
    }
}

/// The quit path must leave nothing running. Asserted from source because the
/// real thing needs a live `AppHandle` plus a pty-host over a real pipe, which a
/// unit-test process cannot stand up (the `integration-tests` feature `mock_app`
/// needs breaks the Windows test binary).
///
/// These are CLASS guards, not instance guards: they pin that *no* exit in the
/// user-quit paths skips the disarm, so a future branch added to `flush_then_exit`
/// — or a new quit path in `lib.rs` — cannot quietly opt out and strand shells.
#[cfg(test)]
mod quit_teardown_wiring_tests {
    /// The body of `fn <name>` (or of a closure passed to `<name>`), found by
    /// counting braces from the first `{` after the signature.
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

    /// Drop `//` line comments. Without this the guards read our own prose: this
    /// module and the code it guards both *describe* exiting and disarming, and a
    /// sentence must never stand in for — or trip — an assertion about code.
    fn strip_line_comments(code: &str) -> String {
        code.lines()
            .map(|l| match l.find("//") {
                Some(i) => &l[..i],
                None => l,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Whether `code` terminates the process by ANY spelling used in this repo.
    ///
    /// Matching `.exit(0)` alone was not enough: `std::process::exit(0)` has no
    /// `.` at all and is an established pattern here (`instance_lock.rs`,
    /// `lib.rs`), so a future quit fix written that way would sail past a guard
    /// that only knew the method-call form. `disarm_then_exit` — the sanctioned
    /// route — is removed first so it is never mistaken for a bare exit.
    fn has_process_exit(code: &str) -> bool {
        strip_line_comments(code)
            .replace("disarm_then_exit", "")
            .contains("exit(")
    }

    /// The guard's own detector, pinned. A class guard that misses a spelling is
    /// worse than no guard: it reports safety it never checked.
    #[test]
    fn the_detector_catches_every_spelling_of_a_process_exit() {
        assert!(has_process_exit("app.exit(0);"), "method call on app");
        assert!(
            has_process_exit("std::process::exit(0);"),
            "std::process::exit has no `.` — the spelling that defeated the first guard"
        );
        assert!(has_process_exit("app_handle.exit(0);"), "another receiver");
        assert!(
            has_process_exit("window.app_handle().exit(0);"),
            "chained receiver"
        );
        assert!(has_process_exit("std::process::exit(1);"), "nonzero status");

        assert!(
            !has_process_exit("disarm_then_exit(app);"),
            "the sanctioned route must not read as a bare exit"
        );
        assert!(
            !has_process_exit("// a bare exit(0) here would strand terminals"),
            "prose about exiting must not trip the guard"
        );
    }

    fn source(file: &str) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join(file);
        std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("cannot read {} ({e})", path.display()))
            .replace("\r\n", "\n")
    }

    /// `flush_then_exit` has several early-exit branches (no state, nothing to
    /// flush, emit failed, a second impatient Quit). Every one of them must go
    /// through `disarm_then_exit`: an armed host that loses its GUI Holds, and a
    /// held host keeps the user's shells — and whatever agent CLIs run under
    /// them — alive with no window and no tray to reach them.
    #[test]
    fn every_flush_then_exit_branch_disarms_before_exiting() {
        let body = fn_body(&source("commands.rs"), "pub fn flush_then_exit");
        assert!(
            body.contains("disarm_then_exit"),
            "flush_then_exit must route its exits through disarm_then_exit. Body:\n{body}"
        );
        assert!(
            !has_process_exit(&body),
            "a branch of flush_then_exit still terminates the process directly, \
             skipping the disarm — that branch strands the user's terminals. Body:\n{body}"
        );
    }

    /// The quit path that does NOT go through `flush_then_exit`: destroying the
    /// last real window (tab tear-off, close_self_window) exits straight from the
    /// window-event handler. It is a user-initiated quit and needs the same
    /// guarantee — missing it was the whole reason to guard the class, not the
    /// single function.
    ///
    /// Scoped to the window-event closure, not the whole file: `lib.rs` also has
    /// a legitimate pre-builder `std::process::exit(2)` that runs before any
    /// `AppState` or pty-host exists, and a file-wide check would fail on it.
    #[test]
    fn the_last_window_destroyed_path_disarms_before_exiting() {
        let body = fn_body(&source("lib.rs"), ".on_window_event(");
        assert!(
            body.contains("disarm_then_exit"),
            "the last-window-destroyed exit must disarm the host first. Body:\n{body}"
        );
        assert!(
            !has_process_exit(&body),
            "the window-event handler still terminates the process directly, \
             skipping the disarm. Body:\n{body}"
        );
    }

    /// The other half of the contract. `restart_for_update` arms ON PURPOSE and
    /// exits so the shells survive the swap; disarming there would defeat the
    /// feature. Pins that the new choke point was not applied indiscriminately.
    #[test]
    fn the_offload_path_still_exits_while_armed() {
        let body = fn_body(&source("commands.rs"), "pub async fn restart_for_update");
        assert!(
            body.contains("arm_detach"),
            "restart_for_update must still arm. Body:\n{body}"
        );
        assert!(
            !strip_line_comments(&body).contains("disarm"),
            "restart_for_update must NOT disarm — it exits deliberately armed so \
             terminals survive the update. Body:\n{body}"
        );
    }
}
