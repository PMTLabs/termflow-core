//! Terminal lifecycle: create/adopt/close/write/resize, cwd resolution, terminal
//! size, owning-tab and display-label setters, and the host-routing spawn path
//! (`spawn_routed`/`host_identity`/`register_host_terminal`/`host_fallback`/
//! `restore_prefix`/`stage_scrollback`/`root_leaf_owner_to_reserve`/`resolve_owner`/
//! `terminal_display_name`). Split out of the former `commands.rs`.

use tauri::State;
use crate::state::AppState;
use crate::pty_manager;
use std::collections::HashMap;
use std::io::Write;
use sysinfo::System;

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

#[tauri::command]
pub async fn report_host_restore_settled(
    state: State<'_, AppState>,
    window_label: String,
    claimed_session_keys: Vec<String>,
) -> Result<(), String> {
    state.report_host_restore_settled(window_label, claimed_session_keys).await;
    Ok(())
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
    /// Present only for a recovery create delivered by the backend claim path.
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

    // Deliberately off (the `TERMFLOW_PTY_HOST=0` kill-switch — the only way to
    // land here now that every supported OS is default-on): in-process is the
    // intended behaviour, not a degraded one.
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

    let claimed_pid = state.claim_host_registration(&session_key)?;
    if let Some(pid) = claimed_pid {
        let ident = host_identity(&session_key, Some(&id), owning_tab_id.as_deref());
        let process_id = ident.process_id.clone();
        register_host_terminal(state, &ident, pid, &shell_name, name.as_deref(), cols, rows, prompt_hook);
        state.host_session_registered(&session_key, &process_id);
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
    state.host_session_registered(&session_key, &process_id);
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
    // A sidecar that is switched OFF is not a failure but an explicit
    // `TERMFLOW_PTY_HOST=0`, so warning here would fire on every single spawn
    // for someone who asked for exactly this.
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

    #[test]
    fn surfacing_an_orphan_reserves_the_listed_pid_for_reattach() {
        let (_app, state) = mock_state();
        state.surface_host_orphans(vec![termflow_pty_protocol::SessionMeta {
            tab_id: "S".into(), pid: 4242, head_offset: 0, tail_offset: 0, alive: true,
        }]);

        assert_eq!(state.claim_host_registration("S"), Ok(Some(4242)));
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
    /// Folded onto the shared, crate-wide `crate::automation_engine::test_host::crate_sources()`
    /// walker (external review of this split): it subsumes this module's own former
    /// walker in every way that matters here — it walks recursively (so a file moved
    /// into a subdirectory, like this one after the `commands.rs` split, stays covered
    /// without the audit needing to remember a new path), returns `/`-separated paths
    /// relative to `src/` instead of bare filenames, and has a HIGHER loud-failure floor
    /// (>= 50 files vs. this module's old > 20). The one behavioural difference — the
    /// shared walker strips `//`-comment LINES from each file's text before returning it
    /// — does not change either test below: `every_host_addressed_call_uses_the_host_id_space`
    /// and `no_module_outside_the_router_spawns_a_terminal_in_process` already skip
    /// comment lines themselves (`code.starts_with("//")`) while scanning line-by-line, so
    /// stripping them earlier is redundant, not different.
    use crate::automation_engine::test_host::crate_sources;

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
        // `commands/terminal.rs` IS the router: it owns `spawn_routed` and the in-process
        // `host_fallback`, and those two are the spawn sites this exempts. Every other
        // module must go through `spawn_routed`.
        //
        // `pty_manager.rs` used to sit here too, on the grounds that it "declares the
        // function". It was removed for two reasons: that file is `pty_manager/spawn.rs`
        // now, so the name could never match anything the walk produces — and the
        // declaration was never a hit in the first place, because `calls_spawn_terminal`
        // rejects a preceding `fn`. It exempted nothing, and read as a considered decision
        // while doing it. The loop below is what stops that happening again.
        const ALLOWED: [&str; 1] = ["commands/terminal.rs"];

        let sources = crate_sources();

        // **An exemption that cannot match is invisible.** It never fails, never appears in
        // any diff, and silently widens the moment its file is renamed or split — which is
        // exactly how the entry above rotted. So each one must name a file that still
        // exists AND still contains the thing it is excusing.
        for name in ALLOWED {
            let (_, text) = sources
                .iter()
                .find(|(n, _)| n == name)
                .unwrap_or_else(|| panic!("`{name}` is exempted but no longer exists"));
            assert!(
                text.lines().any(|l| calls_spawn_terminal(l)),
                "`{name}` is exempted but has no spawn site left: the exemption covers \
                 nothing and should be deleted rather than carried"
            );
        }

        let offenders: Vec<String> = sources
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

