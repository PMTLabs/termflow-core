use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde_json::json;
use crate::state::AppState;
use tauri::Emitter;

/// The colour mirrored by the caller's renderer for a parent leaf, if that leaf is live.
/// This is a payload fallback only: the receiving renderer still prefers its local store lookup.
fn parent_title_color(
    terminals: &dashmap::DashMap<String, crate::state::Terminal>,
    parent_leaf: Option<&str>,
) -> Option<String> {
    let leaf = parent_leaf?;
    terminals.iter().find_map(|terminal| {
        (terminal.renderer_terminal_id.as_deref() == Some(leaf))
            .then_some(terminal.title_color.clone())
            .flatten()
    })
}

pub(crate) async fn health_check(State(state): State<AppState>) -> impl IntoResponse {
    Json(health_body(&state.instance_id))
}

/// The `/health` response body. Kept as a pure function (no runtime-typed
/// `AppState`, no axum) so the exact contract the startup smoke test depends on
/// — `status: "ok"` plus this process's identity — is directly unit-testable.
/// The identity lets a second instance probing this port tell "this is mine"
/// from "another instance owns it" (P0b conflict detection).
pub(crate) fn health_body(instance_id: &str) -> serde_json::Value {
    json!({
        "status": "ok",
        "app": "auto-terminal",
        "instanceId": instance_id,
    })
}

/// The identity + status block every terminal-shaped API response carries.
///
/// One function so `list_terminals`, `create_terminal` and `get_terminal`
/// cannot drift — they were three hand-copied `json!` literals that already
/// disagreed (`get_terminal` omitted `promptHook`, and used mode "default").
///
/// Key contract (design 011 §4), all of it load-bearing for existing clients:
///   `id` / `processId` — the PTY routing key. Unchanged.
///   `terminalId`       — the renderer LEAF, always `tm-*` since design 014,
///                        whoever minted it: tab root, split pane or API-created
///                        terminal alike. It is NEVER its tab's id (that equality
///                        is what 014 removed), and it never says anything about
///                        the pane's shape — root/solo/split is determined only by
///                        the pane-tree structure, never by the prefix.
///   `tabId`            — DEPRECATED alias of `terminalId`. Kept byte-identical
///                        so no existing API/MCP client breaks. Removing it is
///                        a major-version change, explicitly not done here.
///   `owningTabId`      — NEW: the tab that owns the leaf. `null` for a
///                        headless (no-renderer-pane) terminal.
/// Resolve any caller-supplied terminal reference to THIS RUN's process id.
///
/// Prefix-dispatched deliberately. Before design 014 the id spaces overlapped —
/// a renderer-created tab's root leaf *was* its tab id — so the only way to
/// reject a tab id passed where a terminal was meant was documentation
/// (`mcp-server/src/server.ts` spent 25 lines explaining it). Now the prefix IS
/// the type, and an agent holding a `tb-` for a two-pane tab gets told so.
///
/// Wrong SPACE is a 400: the caller has a bug we can name. Right space but
/// absent is a 404: the terminal is simply gone. Collapsing those would make a
/// stale `pc-` (per-run, so stale after any restart) look like a client bug.
pub fn resolve_terminal_ref(
    state: &AppState,
    id: &str,
) -> Result<String, (StatusCode, String)> {
    let resolved = match classify_terminal_ref(id)? {
        // `tm-` is the DURABLE id and the one MCP hands out, so it resolves
        // through the index rather than being a map key itself.
        TerminalRef::Leaf => state.identity.process_for_leaf(id),
        TerminalRef::Process => state.terminals.contains_key(id).then(|| id.to_string()),
    };
    resolved.ok_or_else(|| (StatusCode::NOT_FOUND, format!("no live terminal for `{id}`")))
}

/// Which id space a caller-supplied reference belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalRef {
    /// `tm-` — durable across restarts.
    Leaf,
    /// `pc-` (or a legacy id) — this run only.
    Process,
}

/// The SHAPE half of resolution, split out so it is testable without an
/// `AppState` (the `tauri::test` feature crashes the Windows test binary).
///
/// Rejection is by prefix, never by liveness: a tab id that happens to match no
/// live terminal must still be told it is a tab id, or the caller learns
/// nothing and retries the same mistake.
pub fn classify_terminal_ref(id: &str) -> Result<TerminalRef, (StatusCode, String)> {
    if id.starts_with("tb-") {
        return Err((
            StatusCode::BAD_REQUEST,
            format!(
                "`{id}` is a TAB id, not a terminal. Pass a terminal id (`tm-…`) or a process \
                 id (`pc-…`); to name a tab, use the `owningTabId` field."
            ),
        ));
    }
    if id.starts_with("pn-") {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("`{id}` is a PANE id, not a terminal. Pass a terminal id (`tm-…`)."),
        ));
    }
    Ok(if id.starts_with("tm-") { TerminalRef::Leaf } else { TerminalRef::Process })
}

pub(crate) fn terminal_identity_json(t: &crate::state::Terminal, mode: &str) -> serde_json::Value {
    json!({
        "id": t.id,
        "processId": t.id,
        "terminalId": t.renderer_terminal_id,
        "tabId": t.renderer_terminal_id,
        "owningTabId": t.owning_tab_id,
        // Diagnostic only — nothing addresses a terminal by this. It is the
        // pty-host's own key, equal to `terminalId` except for a terminal
        // migrated from a pre-014 build, where it is the legacy `tb-`
        // (design 014 §A5). Exposed so a support question about a terminal that
        // will not reattach is answerable without reading the host's state.
        "sessionKey": t.session_key,
        "name": t.name,
        "profile": t.shell,
        "status": "running",
        "pid": t.pid,
        "createdAt": t.created_at,
        "mode": mode,
        // Command-suggest reads this on reload-reattach to re-seed its prompt
        // gate DISARMED; the ARMED decision is sampled pre-mount via
        // probe_reattach_prompt_gate, NOT here (review 008 M-1).
        "promptHook": t.prompt_hook,
    })
}

pub(crate) async fn list_terminals(State(state): State<AppState>) -> impl IntoResponse {
    let terminals: Vec<_> = state.terminals.iter().map(|e| terminal_identity_json(e.value(), "ui")).collect();
    // Owner discriminator. Terminals live in this process's own AppState, so
    // every entry above belongs to this instance by construction — the useful
    // guarantee is therefore at the RESPONSE level: a client that reaches the
    // wrong instance's port (a stale configured port, a fallback bind) can see
    // that it did, and refuse to reattach to or reap terminals that are not its
    // own. Per-terminal tagging would say the same thing N times.
    Json(json!({
        "terminals": terminals,
        "instance": crate::profile::current().key(),
    }))
}


#[derive(serde::Deserialize)]
pub(crate) struct CreateTerminalReq {
    cols: Option<u16>,
    rows: Option<u16>,
    #[serde(alias = "profileId")]
    profile_id: Option<String>,
    profile: Option<String>, // monitor sends 'profile' instead of 'profile_id'
    shell_type: Option<String>,
    name: Option<String>,
    cwd: Option<String>,
    #[serde(alias = "tabId")]
    tab_id: Option<String>,
    /// The tab that should own the new pane. Preferred over `tab_id`, which is
    /// ambiguous for a split (a client reading `tabId` back off a split pane
    /// gets a `tm-` LEAF, not a tab).
    #[serde(alias = "owningTabId")]
    owning_tab_id: Option<String>,
    #[serde(alias = "paneId")]
    pane_id: Option<String>,
    direction: Option<String>,
    /// The terminal whose agent asked for this spawn, if any. Drives the canvas
    /// auto-connect (`plan/013` Task 20). Accepts either id space — it is resolved
    /// through `AppState::resolve_renderer_id` before it reaches the edge store.
    #[serde(alias = "parentTerminalId")]
    parent_terminal_id: Option<String>,
}

/// The two renderer identities an API-created terminal registers.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ApiSpawnIdentity {
    /// Unique per UI pane. The `terminal_history` PRIMARY KEY and the
    /// `terminalId` of every response.
    renderer_terminal_id: String,
    /// The tab the pane belongs to.
    owning_tab_id: String,
}

/// Mint a renderer id: `<prefix>-<9 hex chars of a v4 uuid>`, matching the
/// format the renderer's own generator produces (`utils/id.ts:1-8`).
pub(crate) fn mint_renderer_id(prefix: &str) -> String {
    let raw = uuid::Uuid::new_v4().to_string().replace('-', "");
    format!("{prefix}-{}", &raw[..9])
}

/// Decide both renderer identities for `POST /api/terminals`.
///
/// `mint` supplies the id so the decision is deterministically testable;
/// production passes `mint_renderer_id`.
///
/// Rules (design 011 §5 "The corrected write", as amended by option A — see
/// below):
///   * An explicit `owningTabId`, else `tabId`, is the OWNER — accepted verbatim
///     when it starts with `tb-`, exactly as `api_server.rs:494` did before.
///   * A `tm-` value in either field is a PANE id, not a tab id. Before P0-A it
///     was silently discarded and replaced with an unrelated fresh `tb-`
///     (ground-truth correction C3), so the pane appeared in the wrong tab. Fail
///     closed with a message naming the right field. The spec's §5 snippet does
///     not cover this case; this is a GAP FILL, flagged in the plan header.
///   * The leaf is ALWAYS a fresh `tm-`, unconditionally — see the comment at
///     the mint site below for why an API create may never claim a tab's root
///     (`tb-`) leaf, even for a brand-new, empty tab.
pub(crate) fn resolve_api_spawn_identity(
    tab_id: Option<&str>,
    owning_tab_id: Option<&str>,
    mut mint: impl FnMut(&str) -> String,
) -> Result<ApiSpawnIdentity, String> {
    let owner_hint = owning_tab_id
        .or(tab_id)
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let owning_tab_id = match owner_hint {
        Some(id) if id.starts_with("tb-") => id.to_string(),
        Some(id) if id.starts_with("tm-") => {
            return Err(format!(
                "'{id}' is a TERMINAL (leaf) id, not a tab id — pass the owning tab id \
                 (the `owningTabId` field of GET /api/terminals/{{id}})"
            ))
        }
        // A PANE id. Rejected explicitly rather than falling through to the mint
        // below: silently minting a tab put the caller's terminal in a brand-new
        // tab instead of the one they named, which reads as "the API ignored me"
        // and gives no clue why. Design 014 gave each space its own prefix so the
        // wrong one can be NAMED — saying which it is IS the fix.
        Some(id) if id.starts_with("pn-") => {
            return Err(format!(
                "'{id}' is a PANE id, not a tab id — pass the owning tab id (the \
                 `owningTabId` field of GET /api/terminals/{{id}}), or use `paneId` \
                 to split a specific pane"
            ))
        }
        // Absent, blank, or an unrecognised format: mint one, as before.
        _ => mint("tb"),
    };

    // OPTION A (design 011, root-leaf revision): an API/MCP create NEVER takes
    // a tab's root (`tb-`) leaf — it always mints a fresh `tm-`, even for a
    // brand-new, currently-empty tab.
    //
    // This used to be conditional: a create landing in an empty tab claimed the
    // tab id itself as its leaf (leaf == owner), guarded by `RootLeafClaims` +
    // an `owner_has_live_terminal` scan against the TOCTOU window between that
    // decision and `spawn_terminal` registering its `Terminal`
    // (`pty_manager.rs:862-871`). That guard closed the race between two API
    // creates, but not the race this path can never see: `commands::create_terminal`
    // (the renderer path) *must* be able to reclaim a tab's root leaf when the
    // user restarts an exited root pane — it cannot be refused. So the REST-first
    // ordering (API create claims `tb-a` and commits to it, then the renderer's
    // restart of the same tab also registers `tb-a`) produced two live terminals
    // on one `terminal_history` PRIMARY KEY regardless of how tight the API-side
    // claim was, because the claim only ever covered API-vs-API contention, not
    // API-vs-renderer.
    //
    // The API path cannot distinguish "this is a genuinely new tab" from "this
    // tab's root pane just exited and is about to be restarted by the renderer"
    // — both look identical from here (an owner with no live terminal). Guessing
    // wrong is exactly what produced the duplicate-leaf bug. Rather than narrow
    // that window further, this removes the contention: only
    // `commands::create_terminal` may ever claim a `tb-` root leaf now, so there
    // is nobody left to race it. `RootLeafClaims` (`state.rs`) still exists and
    // is still used there — see `commands.rs`.
    let renderer_terminal_id = mint("tm");

    Ok(ApiSpawnIdentity { renderer_terminal_id, owning_tab_id })
}

pub(crate) async fn create_terminal(
    State(state): State<AppState>,
    Json(payload): Json<CreateTerminalReq>,
) -> impl IntoResponse {
    // Resolve profile if provided (handle multiple field names for compatibility)
    let profile_to_use = payload.profile_id.clone()
        .or(payload.profile.clone())
        .or(payload.shell_type.clone());

    let profiles = crate::pty_manager::get_available_shells();

    // Find the profile to use: 
    // 1. Try to match by ID
    // 2. Try to match by name (case-insensitive)
    // 3. Fall back to default profile
    let profile = if let Some(id_or_name) = profile_to_use.as_ref() {
        profiles.iter().find(|p| p.id == *id_or_name)
            .or_else(|| profiles.iter().find(|p| p.name.to_lowercase() == id_or_name.to_lowercase()))
            // Unknown/placeholder profile (e.g. "default") falls back to the default
            // profile rather than None, which would spawn a bare /bin/bash.
            .or_else(|| profiles.iter().find(|p| p.is_default))
    } else {
        profiles.iter().find(|p| p.is_default)
    };

    let mut shell_name = "default".to_string();
    let (shell_path, shell_args, shell_cwd) = if let Some(profile) = profile {
        shell_name = profile.id.clone();
        // Priority: payload.cwd > profile.cwd
        let effective_cwd = if payload.cwd.is_some() { payload.cwd } else { profile.cwd.clone() };
        (Some(profile.path.clone()), Some(profile.args.clone()), effective_cwd)
    } else {
        // Fallback if no profiles found at all
        (None, None, payload.cwd)
    };

    let terminal_name = payload.name.unwrap_or_else(|| format!("Terminal-{}", shell_name));

    let cols = payload.cols.unwrap_or(80);
    let rows = payload.rows.unwrap_or(24);
    log::info!("Creating terminal with size {}x{}, profile: {}", cols, rows, shell_name);

    // Resolve BOTH renderer identities BEFORE the spawn, so the Terminal
    // registers with them up front (review 062 F-01: patching an id in after
    // spawn returns races a fast-exiting shell's exit-path persist, which then
    // files the final scrollback under the ephemeral pc- id).
    let identity = match resolve_api_spawn_identity(
        payload.tab_id.as_deref(),
        payload.owning_tab_id.as_deref(),
        mint_renderer_id,
    ) {
        Ok(i) => i,
        Err(e) => {
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))).into_response()
        }
    };

    // Routed like the renderer's own create: sidecar-hosted when the PTY host is
    // available, in-process only as a fallback. Spawning DIRECTLY in-process here
    // is what made every agent/MCP-created terminal un-offloadable — one of them
    // alive was enough for `hotswap_preflight` to refuse Offload & Close, because
    // a hot-swap really would have killed it (plan 019).
    //
    // No restored scrollback, as before: `resolve_api_spawn_identity` always mints
    // a FRESH `tm-*` leaf, so the `stage_scrollback` inside the routed spawn can
    // never find a stored row for it.
    let spawned = crate::commands::spawn_routed(
        &state,
        crate::commands::SpawnRequest {
            leaf_id: identity.renderer_terminal_id.clone(),
            // Freshly minted leaf, so nothing legacy to preserve.
            session_key: None,
            owning_tab_id: Some(identity.owning_tab_id.clone()),
            cols,
            rows,
            shell_path,
            shell_name: shell_name.clone(),
            shell_args,
            cwd: shell_cwd,
            name: Some(terminal_name.clone()),
        },
    )
    .await;
    match spawned {
        Ok(id) => {
            // Auto-connect: record that the calling agent spawned this terminal
            // (`plan/013` Task 20, design 010 §7.1). Written HERE rather than in the
            // renderer so the graph is correct even when no window is focused, or when
            // Canvas Mode has never been opened.
            //
            // Both endpoints are renderer LEAF ids. `identity.renderer_terminal_id` is the
            // leaf minted for this create — always a `tm-*` since design 014, whether or not
            // the owning tab already held a live terminal (011 D7's tab-id case is gone).
            // Using `owning_tab_id` would point every split's edge at its tab's root pane,
            // and would then be dropped as a self-edge whenever the caller IS that root pane.
            //
            // The resolved leaf is kept for the EVENT below as well, not just for the edge.
            // The renderer's `planAgentPlacement` looks the parent up in the canvas model,
            // which is keyed by leaves — so emitting `payload.parent_terminal_id` verbatim
            // meant a caller that named itself by PROCESS id got its edge (resolved here) and
            // lost its placement (unresolvable there), which reads as "the new terminal
            // appeared far away with a wire stretching back to me". One id space at the
            // boundary, resolved once.
            let mut parent_leaf: Option<String> = None;
            if let Some(parent_raw) = payload.parent_terminal_id.as_deref() {
                match state.resolve_renderer_id(parent_raw) {
                    Some(parent_id) if parent_id != identity.renderer_terminal_id => {
                        parent_leaf = Some(parent_id.clone());
                        let edge = crate::canvas_store::CanvasEdge::new(
                            parent_id,
                            identity.renderer_terminal_id.clone(),
                            None,
                            "agent",
                        );
                        // Never fail the spawn for a graph write. Task 16 returns `Result`
                        // precisely so this is a LOGGED failure rather than a silent one.
                        if let Err(e) = state.canvas_store.insert_edge(&edge) {
                            log::warn!("[CANVAS] auto-connect edge not stored: {}", e);
                        }
                    }
                    Some(_) => log::debug!(
                        "[CANVAS] auto-connect skipped: {} spawned itself",
                        parent_raw
                    ),
                    None => log::warn!(
                        "[CANVAS] auto-connect skipped: unknown parent {}",
                        parent_raw
                    ),
                }
            }

            // Notify the UI to create a tab for this new terminal. We BROADCAST (a
            // bare emit_to is documented as not reaching the JS listener here — see
            // commands.rs resolve_tab_drop) and carry the routing target in the
            // payload: every window receives it, but only the one whose label equals
            // `targetWindow` acts on it (the same pattern as app:close-requested).
            let target_window = state.resolve_active_window_label();
            let parent_title_color = parent_title_color(&state.terminals, parent_leaf.as_deref());
            if let Err(e) = state.app_handle.emit("api:createTerminalTab", serde_json::json!({
                "name": terminal_name,
                "profile": shell_name,
                // This key carries the backend PROCESS id (Mode 0 in App.tsx reads
                // it as one), unlike a REST response where `terminalId` is the leaf.
                // Since plan 019 the two COINCIDE for a sidecar-hosted terminal —
                // the map key IS the leaf — and differ only on a fallback spawn, so
                // read the key you need by NAME here, never by "the one that looks
                // different from the others".
                "terminalId": id,
                "tabId": Some(identity.owning_tab_id.clone()),
                // NEW, unambiguous names — see App.tsx Modes 0/1.
                "processId": id,
                "rendererTerminalId": identity.renderer_terminal_id.clone(),
                "owningTabId": identity.owning_tab_id.clone(),
                "paneId": payload.pane_id,
                "direction": payload.direction,
                // PLACEMENT ONLY. The edge is already in the store by this point; the
                // renderer needs this to fan the new node out from its caller, not to
                // decide whether a connection exists.
                //
                // The RESOLVED leaf, and null whenever the edge was not written — the two
                // must agree, since a placement without a wire fans a node out from a
                // terminal it has no visible relationship to.
                "parentTerminalId": parent_leaf,
                "parentTitleColor": parent_title_color,
                "targetWindow": target_window
            })) {
                log::warn!("Failed to emit api:createTerminalTab: {}", e);
            }

            if let Some(t) = state.terminals.get(&id) {
                (StatusCode::OK, Json(terminal_identity_json(t.value(), "ui"))).into_response()
            } else {
                (StatusCode::OK, Json(json!({ "id": id, "status": "running" }))).into_response()
            }
        },
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e }))).into_response(),
    }
}

pub(crate) async fn delete_terminal(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    // Normalise the caller-supplied reference to this run's map key. The API
    // reports the DURABLE tm- leaf as `terminalId`, but the per-terminal maps
    // are keyed by the per-run pc- id (design 014 A3). Without this, the
    // documented round trip - read `terminalId`, then address it - 404s.
    let id = state.resolve_ref(&id);
    // Take the pid first (guard drops at end of statement, before cleanup).
    let Some(pid) = state.terminals.get(&id).map(|t| t.pid) else {
        return Json(json!({ "error": "Terminal not found" }));
    };
    // Parity with the UI close path: host-owned → tell the sidecar to close the
    // session; otherwise kill the local shell tree. Then clean up every map.
    if !state.host_close(&id) {
        crate::pty_manager::kill_process_tree(pid);
    }
    state.cleanup_terminal_state(&id);
    Json(json!({ "status": "ok" }))
}

pub(crate) async fn reset_terminal(
    State(_state): State<AppState>,
    Path(_id): Path<String>,
) -> impl IntoResponse {
    // Mock reset for now
    Json(json!({ "status": "ok" }))
}

#[derive(serde::Deserialize)]
pub(crate) struct ResizeReq {
    cols: u16,
    rows: u16,
}

pub(crate) async fn resize_terminal(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(payload): Json<ResizeReq>,
) -> impl IntoResponse {
    // Normalise the caller-supplied reference to this run's map key. The API
    // reports the DURABLE tm- leaf as `terminalId`, but the per-terminal maps
    // are keyed by the per-run pc- id (design 014 A3). Without this, the
    // documented round trip - read `terminalId`, then address it - 404s.
    let id = state.resolve_ref(&id);
    log::info!("Resize request for terminal {}: {}x{}", id, payload.cols, payload.rows);

    // Host-owned terminals resize via the sidecar.
    if state.host_resize(&id, payload.cols, payload.rows) {
        if let Some(mut terminal) = state.terminals.get_mut(&id) {
            terminal.cols = payload.cols;
            terminal.rows = payload.rows;
        }
        state.resize_screen(&id, payload.rows, payload.cols);
        return Json(json!({ "status": "ok", "cols": payload.cols, "rows": payload.rows })).into_response();
    }

    if let Some(master_mutex) = state.ptys.get(&id) {
        let master = match master_mutex.lock() {
            Ok(m) => m,
            Err(_) => {
                return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "terminal pty mutex poisoned" }))).into_response();
            }
        };
        let new_size = portable_pty::PtySize {
            rows: payload.rows,
            cols: payload.cols,
            pixel_width: 0,
            pixel_height: 0,
        };

        match master.resize(new_size) {
            Ok(_) => {
                if let Some(mut terminal) = state.terminals.get_mut(&id) {
                    terminal.cols = payload.cols;
                    terminal.rows = payload.rows;
                }
                // Keep the authoritative screen parser in sync for faithful snapshots.
                state.resize_screen(&id, payload.rows, payload.cols);
                log::info!("Terminal {} resized successfully to {}x{}", id, payload.cols, payload.rows);
                Json(json!({ "status": "ok", "cols": payload.cols, "rows": payload.rows })).into_response()
            }
            Err(e) => {
                log::error!("Failed to resize terminal {}: {}", id, e);
                Json(json!({ "error": e.to_string() })).into_response()
            }
        }
    } else {
        log::warn!("Terminal {} not found for resize", id);
        Json(json!({ "error": "Terminal not found" })).into_response()
    }
}

/// The `terminal:external-activity` event body. Pure so the routing contract —
/// which id the renderer is supposed to flash a tab with — is unit-testable.
///
/// `terminal_id`/`processId` is the DashMap KEY (a `pc-*` id on the in-process
/// path, the renderer leaf on the sidecar path). It is deliberately NOT the
/// same thing `terminalId` means in a REST response; `rendererTerminalId` is
/// the new, unambiguous name for the leaf.
pub(crate) fn external_activity_payload(
    process_id: &str,
    renderer_terminal_id: Option<&str>,
    owning_tab_id: Option<&str>,
) -> serde_json::Value {
    json!({
        // Unchanged for existing consumers.
        "terminalId": process_id,
        "tabId": renderer_terminal_id,
        // NEW, unambiguous names.
        "processId": process_id,
        "rendererTerminalId": renderer_terminal_id,
        // NEW: what `flagTabActivity` actually needs. A `tm-*` leaf resolves
        // against nothing in `state.tabs`, so before P0-A a split pane's
        // activity indicator was silently dropped (design 011 §1.1 item 4).
        "owningTabId": owning_tab_id,
    })
}

/// Emit a one-shot "external interaction" signal so the UI can flash the owning
/// tab. Fired only from the external-only REST handlers (write input / execute
/// prompt) — user keystrokes go through a Tauri invoke command and never reach
/// here. Best-effort; never fails the request.
pub(crate) fn emit_external_activity<R: tauri::Runtime>(state: &AppState<R>, terminal_id: &str) {
    // This is the single chokepoint for API/MCP-driven writes, so tag the
    // terminal's last-write source here. It lets the renderer keep an agent's
    // color scheme "sticky" when API/MCP (not the user) ended the agent.
    if let Some(mut t) = state.terminals.get_mut(terminal_id) {
        t.last_input_source = Some("api".to_string());
        t.last_input_at = Some(chrono::Utc::now().timestamp_millis());
    }
    let (renderer_terminal_id, owning_tab_id) = state
        .terminals
        .get(terminal_id)
        .map(|t| (t.renderer_terminal_id.clone(), t.owning_tab_id.clone()))
        .unwrap_or((None, None));
    if let Err(e) = state.app_handle.emit(
        "terminal:external-activity",
        external_activity_payload(
            terminal_id,
            renderer_terminal_id.as_deref(),
            owning_tab_id.as_deref(),
        ),
    ) {
        log::trace!("Failed to emit terminal:external-activity: {}", e);
    }
}

#[derive(serde::Deserialize)]
pub(crate) struct WriteReq {
    data: String,
}

/// Write raw bytes to a single terminal's PTY. Shared by the single-id
/// `/input` handler and the batch `/batch/input` handler.
pub(crate) fn write_data_to_terminal(
    state: &AppState,
    id: &str,
    data: &str,
) -> Result<(), (StatusCode, String)> {
    use std::io::Write;
    // Host-owned terminals: forward to the sidecar.
    if state.host_write(id, data.as_bytes()) {
        emit_external_activity(state, id);
        return Ok(());
    }
    // Clone the writer Arc out of the map, dropping the DashMap shard guard
    // before locking the inner Mutex.
    let writer_mutex = match state.shell_writer_channels.get(id) {
        Some(r) => r.clone(),
        None => return Err((StatusCode::NOT_FOUND, "Terminal not found".to_string())),
    };
    {
        let mut writer = writer_mutex
            .lock()
            .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "terminal writer mutex poisoned".to_string()))?;
        writer
            .write_all(data.as_bytes())
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    }
    emit_external_activity(state, id);
    Ok(())
}

pub(crate) async fn write_terminal(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(payload): Json<WriteReq>,
) -> impl IntoResponse {
    // Normalise the caller-supplied reference to this run's map key. The API
    // reports the DURABLE tm- leaf as `terminalId`, but the per-terminal maps
    // are keyed by the per-run pc- id (design 014 A3). Without this, the
    // documented round trip - read `terminalId`, then address it - 404s.
    let id = state.resolve_ref(&id);
    match write_data_to_terminal(&state, &id, &payload.data) {
        Ok(()) => Json(json!({ "status": "ok" })).into_response(),
        // Preserve the original handler's exact behavior: "not found" returned
        // HTTP 200 with an error body (implicit default status), not 404.
        Err((StatusCode::NOT_FOUND, _)) => Json(json!({ "error": "Terminal not found" })).into_response(),
        Err((code, msg)) => (code, Json(json!({ "error": msg }))).into_response(),
    }
}

#[derive(serde::Deserialize)]
pub(crate) struct OutputQuery {
    last_lines: Option<usize>,
    lines: Option<usize>,  // Number of lines to return (most recent if offset=0)
    offset: Option<usize>, // Line offset for pagination (0 = return last N lines)
    #[allow(dead_code)]
    clean: Option<String>, // Kept for backwards compat, ANSI is now always stripped
}

pub(crate) fn render_terminal_history(
    history: &std::collections::VecDeque<String>,
    rows: u16,
    cols: u16,
) -> String {
    let mut parser = vt100::Parser::new(rows.max(1), cols.max(1), 10_000);

    for chunk in history.iter() {
        parser.process(chunk.as_bytes());
    }

    parser.screen().contents()
}

pub(crate) fn terminal_size_for_output(state: &AppState, id: &str) -> (u16, u16) {
    state
        .terminals
        .get(id)
        .map(|terminal| (terminal.rows.max(1), terminal.cols.max(1)))
        .unwrap_or((24, 80))
}

pub(crate) async fn get_terminal_size(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    // Normalise the caller-supplied reference to this run's map key. The API
    // reports the DURABLE tm- leaf as `terminalId`, but the per-terminal maps
    // are keyed by the per-run pc- id (design 014 A3). Without this, the
    // documented round trip - read `terminalId`, then address it - 404s.
    let id = state.resolve_ref(&id);
    if let Some(terminal) = state.terminals.get(&id) {
        Json(json!({ "cols": terminal.cols, "rows": terminal.rows })).into_response()
    } else {
        (StatusCode::NOT_FOUND,
         Json(json!({ "error": "Terminal not found" }))).into_response()
    }
}

pub(crate) async fn get_terminal_output(
    State(state): State<AppState>,
    Path(id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<OutputQuery>,
) -> impl IntoResponse {
    // Normalise the caller-supplied reference to this run's map key. The API
    // reports the DURABLE tm- leaf as `terminalId`, but the per-terminal maps
    // are keyed by the per-run pc- id (design 014 A3). Without this, the
    // documented round trip - read `terminalId`, then address it - 404s.
    let id = state.resolve_ref(&id);
    // Clone the chunks under a brief inner lock (Arc cloned via get_history, so
    // no DashMap shard guard is held here), then render with NO locks held —
    // rendering replays up to ~1MB through a vt100 parser, and doing that under
    // the history lock starved the PTY output consumer (app-wide output stall).
    let chunks = state
        .get_history(&id)
        .map(|h| h.lock().unwrap_or_else(|p| p.into_inner()).clone());
    if let Some(history) = chunks {
        {
            let (rows, cols) = terminal_size_for_output(&state, &id);
            let cleaned = render_terminal_history(&history, rows, cols);

            // Split into individual lines
            let all_lines: Vec<String> = cleaned
                .lines()
                .map(|s| s.trim_end().to_string())
                .filter(|s| !s.is_empty())
                .collect();

            let total_lines = all_lines.len();

            // Apply offset and lines limit for pagination
            let offset = query.offset.unwrap_or(0);
            let requested = query.lines.or(query.last_lines).unwrap_or(50);

            // If offset=0, return the LAST N lines (most recent); otherwise paginate from offset
            let page_lines: Vec<String> = if offset == 0 {
                all_lines.iter().rev().take(requested).cloned().collect::<Vec<_>>().into_iter().rev().collect()
            } else {
                all_lines.into_iter().skip(offset).take(requested).collect()
            };

            // raw: the returned page joined into a single string (single source of truth)
            let raw_page = page_lines.join("\n");

            return Json(json!({
                "totalLines": total_lines,
                "offset": offset,
                "raw": raw_page
            }));
        }
    }

    // Return empty if not found or empty
    Json(json!({
        "totalLines": 0,
        "offset": 0,
        "raw": ""
    }))
}

/// Returns a styled escape-sequence snapshot of the terminal's current visible
/// screen, taken from the backend's authoritative vt100 parser. Written into a
/// freshly-reset xterm of the same size it reproduces the screen exactly (colors
/// + cursor position), so a reconnecting client stays in sync with what the
/// running TUI believes is on screen. This is the foundation of smooth hydration.
///
/// The snapshot is taken at the parser's current size; clients align the size by
/// calling resize first. Any `cols`/`rows` query params are accepted (for
/// forward-compatibility) but intentionally ignored to avoid read-side resizing.
pub(crate) async fn get_terminal_snapshot(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    // Normalise the caller-supplied reference to this run's map key. The API
    // reports the DURABLE tm- leaf as `terminalId`, but the per-terminal maps
    // are keyed by the per-run pc- id (design 014 A3). Without this, the
    // documented round trip - read `terminalId`, then address it - 404s.
    let id = state.resolve_ref(&id);
    // Restore replay (one-shot): when a previous-session scrollback prefix is staged,
    // serve it ALONE — do NOT append the freshly-spawned shell's current screen.
    // That screen comes from `contents_formatted()`, which BEGINS with an
    // erase-display (\x1b[2J); appended after the prefix it wipes the just-replayed
    // scrollback before it can scroll into xterm's scrollback (so a short restored
    // session — e.g. an `ls` that still fits on screen — vanished entirely). With
    // prefix-only, the fresh shell's own live output paints the current screen right
    // after the divider, pushing the restored content up into scrollback where the
    // user can scroll back to it.
    if let Some((_, prefix)) = state.replay_prefix.remove(&id) {
        log::info!("Restored {} bytes of prior-session scrollback for terminal {}", prefix.len(), id);
        let (rows, cols) = terminal_size_for_output(&state, &id);
        return Json(json!({ "snapshot": prefix, "rows": rows, "cols": cols }));
    }
    match state.screen_snapshot(&id) {
        Some(mut bytes) => {
            // Re-assert live input modes (mouse tracking, bracketed paste, focus
            // reporting, application cursor/keypad) after the screen content:
            // contents_formatted() does not include them, and a rehydrating xterm
            // (window reload, tab moved to another window) starts from a reset —
            // without this the mode state a running TUI already asserted is lost,
            // e.g. the suggest-popup suppression signals for agent CLIs.
            bytes.extend_from_slice(&state.input_modes_snapshot(&id));
            let snapshot = String::from_utf8_lossy(&bytes).to_string();
            let (rows, cols) = terminal_size_for_output(&state, &id);
            Json(json!({ "snapshot": snapshot, "rows": rows, "cols": cols }))
        }
        None => {
            log::warn!("Snapshot requested for {} but no screen parser exists", id);
            Json(json!({ "snapshot": "", "rows": 0, "cols": 0 }))
        }
    }
}

/// The `GET /api/terminals/:id/screen` response body, extracted so a unit test can pin
/// the contract (exact key names, the caller's own id echoed back) without an
/// `AppState`: the handler takes `AppState<Wry>`, `tauri::test::mock_app` only yields
/// `AppState<MockRuntime>`, and the `integration-tests` feature it needs breaks the
/// Windows test binary at loader time. Same reason `health_body` and
/// `terminal_identity_json` are free functions.
///
/// `terminal_id` is echoed back EXACTLY as the caller wrote it, never the resolved
/// `pc-` map key. Every terminal response reports the DURABLE `tm-` leaf as
/// `terminalId` (design 014 A3), and `fleet_screen` echoes its request's id for the
/// same reason: `pc-` ids are minted per run, so handing one back would give the caller
/// an identifier that silently stops resolving after the next restart.
pub(crate) fn screen_body(terminal_id: &str, screen: &str, rows: u16, cols: u16) -> serde_json::Value {
    json!({ "terminalId": terminal_id, "screen": screen, "rows": rows, "cols": cols })
}

/// Returns the terminal's current visible screen as PLAIN GRID TEXT, for callers that
/// READ it - a human, an agent, the automation rule editor's target-preview hover card -
/// rather than replay it into a terminal.
///
/// Neither neighbouring read can be post-processed into this, which is the whole reason
/// the route exists:
///
/// * `/snapshot` serves `contents_formatted()`, a REPLAY STREAM. Written into a fresh
///   xterm of the same size it reproduces the screen exactly, which is what hydration
///   needs - but it is not text. Runs of blanks are encoded as cursor motion (`CUF`,
///   absolute `CUP`) rather than as spaces, so stripping the escapes out of it in the
///   client COLLAPSES the column layout: `line 1 ESC[3;1H line 3` becomes
///   `line 1line 3`, not two rows, and a two-column status bar butts its columns
///   together. `AppState::screen_text` renders from the grid the parser has ALREADY
///   applied those cursor ops to, so the alignment survives - see its doc comment, and
///   `the_screen_route_body_keeps_columns_the_snapshot_blob_encodes_as_cursor_ops`.
/// * `/output` replays a lossy ring of raw PTY chunks through a FRESH parser
///   (`render_terminal_history`), so it can only show what is still in that ring; this
///   endpoint reads the authoritative parser that has consumed every byte of the
///   session.
///
/// `rows`/`cols` are read from the `Terminal` record rather than by taking a second lock
/// on the parser the PTY output consumer is already contending for. Every portable-pty
/// resize path writes the record and calls `resize_screen` in the same breath
/// (`resize_terminal`, the two non-tmux branches of the reflow endpoint,
/// `commands::resize_terminal`), so for those the record's size IS the parser's. The tmux
/// reflow branch is the one exception - it updates only the record, because tmux reflows
/// the content itself and hands the client a fresh capture - so on a tmux-backed terminal
/// read these as the pane's dimensions.
pub(crate) async fn get_terminal_screen(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    // Normalise the caller-supplied reference to this run's map key. The API
    // reports the DURABLE tm- leaf as `terminalId`, but the per-terminal maps
    // are keyed by the per-run pc- id (design 014 A3). Without this, the
    // documented round trip - read `terminalId`, then address it - 404s.
    // Bound to a NEW name instead of shadowing `id` as the neighbours do, because
    // the response echoes the caller's own reference back to them.
    let resolved = state.resolve_ref(&id);
    if !state.terminals.contains_key(&resolved) {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Terminal not found" }))).into_response();
    }
    // A registered terminal whose screen parser does not exist yet is an EMPTY screen,
    // not a 404 - the terminal is addressable and the caller's next poll will have
    // content. `/snapshot` and `fleet_screen` close the same gap the same way.
    let screen = state.screen_text(&resolved).unwrap_or_default();
    let (rows, cols) = terminal_size_for_output(&state, &resolved);
    (StatusCode::OK, Json(screen_body(&id, &screen, rows, cols))).into_response()
}

/// Returns the FULL rendered scrollback (not just the current visible screen)
/// from the backend's authoritative vt100 parser. Unlike `get_terminal_snapshot`
/// (current screen only, for reattach hydration), this reproduces the entire
/// session history — the parser's scrollback survives `2J`/`3J` clears for
/// content that already scrolled into history (see
/// `state.rs::full_scrollback_survives_2j_3j_for_already_scrolled_history`), so
/// this is also correct to call after a client-side wipe (e.g. codex's
/// resize-triggered ED3 erasing xterm's OWN accumulated scrollback) even though
/// the LIVE xterm view lost that content.
pub(crate) async fn get_terminal_full_scrollback(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    // Normalise the caller-supplied reference to this run's map key. The API
    // reports the DURABLE tm- leaf as `terminalId`, but the per-terminal maps
    // are keyed by the per-run pc- id (design 014 A3). Without this, the
    // documented round trip - read `terminalId`, then address it - 404s.
    let id = state.resolve_ref(&id);
    match state.full_scrollback_snapshot(&id) {
        Some(mut bytes) => {
            // Re-assert live input modes (mouse tracking, bracketed paste, focus
            // reporting, application cursor/keypad) after the content, same as
            // get_terminal_snapshot above: full_scrollback_snapshot's replay is a
            // reset()+write() on the client, which drops whatever modes the still-
            // running program already asserted (it won't re-send them mid-session).
            bytes.extend_from_slice(&state.input_modes_snapshot(&id));
            let blob = String::from_utf8_lossy(&bytes).to_string();
            let (rows, cols) = terminal_size_for_output(&state, &id);
            Json(json!({ "blob": blob, "rows": rows, "cols": cols }))
        }
        None => Json(json!({ "blob": "", "rows": 0, "cols": 0 })),
    }
}

pub(crate) async fn get_terminal(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    // Normalise the caller-supplied reference to this run's map key. The API
    // reports the DURABLE tm- leaf as `terminalId`, but the per-terminal maps
    // are keyed by the per-run pc- id (design 014 A3). Without this, the
    // documented round trip - read `terminalId`, then address it - 404s.
    let id = state.resolve_ref(&id);
    if let Some(terminal) = state.terminals.get(&id) {
        let mut body = terminal_identity_json(terminal.value(), "default");
        // Canvas identity, so an agent learns which node and group it is in one call
        // (`plan/013` Task 19). Merged HERE rather than inside `terminal_identity_json`,
        // which has three call sites: adding it there would put a canvas-registry lock and a
        // SQLite query on EVERY entry of `list_terminals`, for a field that endpoint was never
        // asked to carry.
        if let Some(object) = body.as_object_mut() {
            object.insert(
                "node".to_string(),
                crate::canvas_endpoints::canvas_node_json(&state, &id),
            );
        }
        (StatusCode::OK, Json(body))
    } else {
        (StatusCode::NOT_FOUND, Json(json!({ "error": "Terminal not found" })))
    }
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod create_terminal_req_tests;
/// Prefix-dispatched terminal resolution (design 014 §A3).
#[cfg(test)]
mod classify_terminal_ref_tests;
