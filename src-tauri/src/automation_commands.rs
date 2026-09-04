//! The Tauri IPC surface for Terminal Automations (plan 028 §3.6, §7.10).
//!
//! **IPC for everything, including the dry run.** No `/api/automations` axum resource: the only
//! consumer is the Settings window in this same process, a REST surface would have to answer the auth
//! model, and it would expose rule editing to any API client. The editor draft proposed reaching the
//! dry run over REST; §3.6 ruled against it, and taking the whole draft as an argument satisfies the
//! editor's actual requirement identically.
//!
//! **Every body goes through `spawn_blocking`**, exactly as the history-store commands next door do:
//! these are SQLite calls on the UI's critical path, and §10.18 pins it in source rather than trusting
//! it. `State<'_, AppState>` is not `Send` into that closure, so each command clones the owned
//! `AppState` first — every field is an `Arc` or an `AppHandle`, so the clone is cheap.
//!
//! **Every command that changes a rule DEFINITION calls `reload_after_commit`**, and §10.18c derives
//! that requirement from the source rather than listing the commands: `reload` is what carries an edit
//! into the running engine, and a command added later without it leaves the engine running yesterday's
//! rules with nothing to say so. It also preserves the arm state of rules that did not change, which
//! is the reason it is not "build a fresh map" (§7.3).
//!
//! *(Plan §9 put these in `commands.rs`. That file is 3.6k lines — over the repo's own ~1500-line
//! guideline — and this crate already keeps per-feature command modules beside it, so they live
//! here. The registrations are still in `lib.rs`.)*

use tauri::{Emitter, State};

use crate::automation::events::{ChangedPayload, AUTOMATION_CHANGED};
use crate::automation::roster::{TargetSnapshot, WatchableTerminal};
use crate::automation_engine::dry::DryRunReport;
use crate::automation_engine::host::EngineHost;
use crate::automation_store::{
    AutomationLogEntry, AutomationRule, AutomationStoreError, Criterion, LogKind, LogOrder,
    LogScope,
};
use crate::state::AppState;

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Every store error reaches the renderer as its `Display`, which already distinguishes *disabled*
/// from *rejected* from *SQLite said no* — the three the panel renders differently.
fn to_string_err(e: AutomationStoreError) -> String {
    e.to_string()
}

/// One rule-level log row — no terminal, so no name to carry.
///
/// **The three definition kinds had no writer at all.** `Saved` is required by §3.5 and checked by GUI
/// step 19; `Enabled` and `Disabled` are in the vocabulary because the mockup's log shows them. A
/// variant nothing writes is indistinguishable from one nobody wanted, so all three land together
/// rather than leaving two more for the next round to find.
///
/// A failure to log is never a failure to save: the row is a record of something that already
/// happened, and returning `Err` here would tell the user their edit was lost.
fn note<R: tauri::Runtime>(state: &AppState<R>, rule_id: &str, kind: LogKind, detail: &str) {
    let entry = AutomationLogEntry {
        id: 0,
        rule_id: rule_id.to_string(),
        terminal_id: None,
        terminal_name: None,
        kind,
        detail: detail.to_string(),
        at: now_ms(),
    };
    match state.automation_store.append(&entry) {
        Ok(Some(outcome)) if outcome.emit => EngineHost::emit_activity(state, outcome.rule_ids),
        Ok(_) => {}
        Err(e) => log::warn!("automations: could not log {:?} for {}: {}", kind, rule_id, e),
    }
}

/// §3.5's own sentence: *"saved from window `main`, replacing the version saved from `main-2`"*.
///
/// The previous `updated_at` is a wall-clock ms from the row that was overwritten. It is rendered as a
/// plain instant rather than a window label because the SCHEMA has no field for who saved last — the
/// round-1 ruling that put this line in `detail` said so, and inventing a name here would be worse
/// than naming the time.
fn saved_detail(origin: &str, previous: Option<i64>) -> String {
    match previous {
        Some(at) => format!("saved from window {}, replacing the version saved at {}", origin, stamp(at)),
        None => format!("created from window {}", origin),
    }
}

fn stamp(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|t| t.format("%H:%M:%S").to_string())
        .unwrap_or_else(|| ms.to_string())
}

/// One `automation:changed`, after the definition has actually changed.
///
/// Not coalesced: a user edit is one event, and `useAutomations()` refetches the list on it.
fn announce<R: tauri::Runtime>(
    state: &AppState<R>,
    rule_ids: Vec<String>,
    deleted: Vec<String>,
    origin: String,
) {
    let _ = state.app_handle.emit(
        AUTOMATION_CHANGED,
        ChangedPayload { rule_ids, deleted, origin, at: now_ms() },
    );
}

// =================================================================================================
// Reads
// =================================================================================================

#[tauri::command]
pub async fn list_automations(state: State<'_, AppState>) -> Result<Vec<AutomationRule>, String> {
    let store = state.automation_store.clone();
    tokio::task::spawn_blocking(move || store.list_rules().map_err(to_string_err))
        .await
        .map_err(|e| e.to_string())?
}

/// The runtime object every row's pill reads (§7.2), for first paint.
///
/// **The same function `automation:state` emits**, so the event and first paint cannot disagree
/// — §10.18d asserts they agree, and the cheapest way to make that true is to give them nothing to
/// disagree with.
#[tauri::command]
pub async fn get_automation_runtime(
    state: State<'_, AppState>,
) -> Result<crate::automation::events::StatePayload, String> {
    let engine = state.automations.clone();
    tokio::task::spawn_blocking(move || engine.runtime_payload())
        .await
        .map_err(|e| e.to_string())
}

/// `rule_id: None` = every rule. `newest_first` is passed explicitly by both callers (Q8): the drawer
/// is a recent-activity peek, the full log is a timeline you read forward.
#[tauri::command]
pub async fn load_automation_log(
    state: State<'_, AppState>,
    rule_id: Option<String>,
    newest_first: bool,
    limit: i64,
) -> Result<Vec<AutomationLogEntry>, String> {
    let store = state.automation_store.clone();
    tokio::task::spawn_blocking(move || {
        let scope = match rule_id {
            Some(id) => LogScope::Rule(id),
            None => LogScope::All,
        };
        let order = if newest_first { LogOrder::Desc } else { LogOrder::Asc };
        store.load_automation_log(&scope, order, limit).map_err(to_string_err)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The picker's rows: every live terminal, then one row per requested id that is not live — carrying
/// the label and folder the targets table remembered for it (§4.5, R14).
#[tauri::command]
pub async fn list_watchable_terminals(
    state: State<'_, AppState>,
    rule_id: Option<String>,
    include_ids: Option<Vec<String>>,
) -> Result<Vec<WatchableTerminal>, String> {
    let owned = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let store = owned.automation_store.clone();
        // Only the criterion of the rule being edited, so opening the picker on a `Terminal ID is`
        // rule never enumerates the machine's processes (§10.13).
        let criteria: Vec<Criterion> = match rule_id.as_deref() {
            Some(id) => store
                .get_rule(id)
                .map_err(to_string_err)?
                .map(|r| vec![r.criterion])
                .unwrap_or_default(),
            None => Vec::new(),
        };
        let live = EngineHost::roster(&owned, &criteria);

        // §4.3: scoped to the rule when the caller names one — the editor always knows which rule it
        // is editing — else the NEWEST row for that id across rules. An empty list here made every
        // closed terminal in a fresh draft's picker render as a bare id, which is the one row the
        // snapshot exists for: the mockup draws it as `tm-e4d0a77e1 · node · ~/work/termflow-docs ·
        // not open`.
        let snapshots: Vec<TargetSnapshot> = match rule_id.as_deref() {
            Some(id) => store
                .targets_for(id)
                .map_err(to_string_err)?
                .into_iter()
                .map(|(terminal_id, _source, label, folder, _last_seen)| TargetSnapshot {
                    terminal_id,
                    label,
                    folder,
                })
                .collect(),
            None => store.newest_snapshots().map_err(to_string_err)?,
        };
        Ok(crate::automation::roster::build(
            &live,
            &include_ids.unwrap_or_default(),
            &snapshots,
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Which pairs `Re-arm now` touches: one named leaf, or every leaf the rule watches.
///
/// **A named leaf is filtered through the watch set too.** It arrives from a renderer that may be
/// holding a row this build has already stopped watching, and an unfiltered `vec![tm]` mints an arm
/// key for a pair nothing evaluates, nothing renders, and only `forget_terminal` ever reclaims.
///
/// Out here rather than inside the command because the command takes an `AppState` (§7.10), and a
/// branch inside one of those is a branch no test on Windows can reach — `vec![tm]` survived the whole
/// suite.
fn leaves_to_rearm(watched: &std::collections::HashSet<String>, named: Option<String>) -> Vec<String> {
    match named {
        Some(tm) => watched.contains(&tm).then_some(tm).into_iter().collect(),
        None => watched.iter().cloned().collect(),
    }
}

/// The reload that follows a store write which has **already committed**.
///
/// Never `?`-ed inside the blocking closure. `save_rule` and its four siblings commit before this
/// runs, so a `reload` that fails — `Disabled`, or a `SQLITE_BUSY` on `list_rules` while the 30 s
/// scrollback flush holds the file, which §3.4 calls routine — must not be allowed to skip
/// `announce`. The rule IS changed on disk; every other window would go on showing the old definition
/// until it was remounted, with nothing in the log to say why. The error still reaches the caller,
/// after the windows have been told.
/// It also **says what the reload refused**, which `spawn` does at launch and no command did. That
/// matters more since §7.8's save gate stopped judging the pattern: a rule saved enabled with one the
/// engine cannot compile is skipped right here, and without this the user is told nothing at all.
fn reload_after_commit(owned: &AppState, at: i64) -> Result<(), String> {
    let report = owned.automations.reload(&owned.automation_store, at).map_err(to_string_err)?;
    if let Some(ids) = crate::automation_engine::refusals_to_announce(&report) {
        EngineHost::emit_activity(owned, ids);
    }
    Ok(())
}

/// The Test button (decision 9). Takes the **unsaved draft**, not an id — which is what lets a
/// template be tested before it exists on disk, and what makes it physically impossible for this path
/// to load and touch a live rule's arm state.
#[tauri::command]
pub async fn dry_run_automation(
    state: State<'_, AppState>,
    rule: AutomationRule,
    terminal_id: String,
) -> Result<DryRunReport, String> {
    let owned = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let engine = owned.automations.clone();
        crate::automation_engine::dry::evaluate_once(&engine, &owned, &rule, &terminal_id, now_ms())
    })
    .await
    .map_err(|e| e.to_string())
}

// =================================================================================================
// Definition mutations — every one of these reloads
// =================================================================================================

/// What a save produced. **`id` is the authority**, because a save can MINT one.
///
/// This used to be a bare `Option<i64>` — the previous `updated_at`, for the log line — and the
/// command wrote whatever id the caller sent. `save_rule` `INSERT`s `rule.id` verbatim, so an editor
/// saving a new draft (`id: ""`) created a row whose primary key is the empty string, and the
/// **second** new rule then `ON CONFLICT`-overwrote the first: two rules created, one row, no error,
/// and the user's first automation simply gone. Nothing in M1–M4 saves a new rule, so nothing could
/// hit it; the editor hits it on its first Save.
///
/// The mint belongs here rather than in the renderer because "what does a new rule's id look like"
/// is the store's question — a renderer that minted one would be the second id vocabulary §9 exists
/// to prevent. And it has to be *returned*, because the editor stays open on the rule it just saved:
/// without the id back, the next Save mints a second id and the same draft becomes two rows.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationSaveResult {
    /// The row's id — minted here when the caller sent an empty one, echoed back otherwise.
    pub id: String,
    /// The `updated_at` the row held before this write, or `None` when this was an insert.
    pub previous_updated_at: Option<i64>,
}

#[tauri::command]
pub async fn save_automation(
    state: State<'_, AppState>,
    rule: AutomationRule,
    origin: String,
) -> Result<AutomationSaveResult, String> {
    let owned = state.inner().clone();
    let mut rule = rule;
    let inserting = rule.id.trim().is_empty();
    if inserting {
        // The same shape `duplicate_automation` mints, and deliberately the same prefix: one id
        // vocabulary, minted in one crate.
        rule.id = format!("au-{}", uuid::Uuid::new_v4());
    }
    let id = rule.id.clone();
    let origin_for_log = origin.clone();
    let (previous, reloaded) = tokio::task::spawn_blocking(move || {
        if inserting {
            // Where a new rule lands is the store's decision too — `blankDraft()` sends `sortOrder: 0`
            // precisely because the renderer must not invent a fact about a row that does not exist
            // yet, and 0 would file every new rule ABOVE every existing one, tie-broken by a uuid.
            // Ties are benign rather than prevented: `ORDER BY sort_order, id` is total, and
            // `duplicate_automation` renumbers the whole list when it needs an exact slot.
            rule.sort_order = owned.automation_store.next_sort_order().map_err(to_string_err)?;
        }
        let previous = owned.automation_store.save_rule(&rule).map_err(to_string_err)?;
        // §3.5: the `saved` entry's detail carries the origin window, and `save_rule` returns the
        // previous `updated_at` from INSIDE its own transaction so the line can name what it replaced.
        // Two windows may hold one rule open and the later save wins whole; the log entry IS the
        // requirement, not concurrency control. GUI step 19 checks this line.
        note(&owned, &rule.id, LogKind::Saved, &saved_detail(&origin_for_log, previous));
        let reloaded = reload_after_commit(&owned, now_ms());
        Ok::<_, String>((previous, reloaded))
    })
    .await
    .map_err(|e| e.to_string())??;
    announce(&state, vec![id.clone()], vec![], origin);
    reloaded?;
    Ok(AutomationSaveResult { id, previous_updated_at: previous })
}

#[tauri::command]
pub async fn delete_automation(
    state: State<'_, AppState>,
    id: String,
    origin: String,
) -> Result<bool, String> {
    let owned = state.inner().clone();
    let rule_id = id.clone();
    let (removed, reloaded) = tokio::task::spawn_blocking(move || {
        let removed = owned.automation_store.delete_rule(&rule_id).map_err(to_string_err)?;
        let reloaded = reload_after_commit(&owned, now_ms());
        Ok::<_, String>((removed, reloaded))
    })
    .await
    .map_err(|e| e.to_string())??;
    announce(&state, vec![], vec![id], origin);
    reloaded?;
    Ok(removed)
}

#[tauri::command]
pub async fn duplicate_automation(
    state: State<'_, AppState>,
    id: String,
    origin: String,
) -> Result<AutomationRule, String> {
    let owned = state.inner().clone();
    let (copy, reloaded) = tokio::task::spawn_blocking(move || {
        let copy =
            owned.automation_store.duplicate_automation(&id, now_ms()).map_err(to_string_err)?;
        let reloaded = reload_after_commit(&owned, now_ms());
        Ok::<_, String>((copy, reloaded))
    })
    .await
    .map_err(|e| e.to_string())??;
    announce(&state, vec![copy.id.clone()], vec![], origin);
    reloaded?;
    Ok(copy)
}

/// A two-line wrapper over `set_enabled_checked`, per §7.10: the CHECK is the thing worth testing and
/// it needs no `AppHandle`, so it lives in the store where §10.18b can reach it on Windows.
#[tauri::command]
pub async fn set_automation_enabled(
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
    origin: String,
) -> Result<(), String> {
    let owned = state.inner().clone();
    let rule_id = id.clone();
    let origin_for_log = origin.clone();
    let reloaded = tokio::task::spawn_blocking(move || {
        owned.automation_store.set_enabled_checked(&rule_id, enabled).map_err(to_string_err)?;
        // Only after the check passed, so a refused enable never claims in the log to have happened.
        let kind = if enabled { LogKind::Enabled } else { LogKind::Disabled };
        note(&owned, &rule_id, kind, &format!("from window {}", origin_for_log));
        Ok::<_, String>(reload_after_commit(&owned, now_ms()))
    })
    .await
    .map_err(|e| e.to_string())??;
    announce(&state, vec![id], vec![], origin);
    reloaded?;
    Ok(())
}

/// *Reset* — **one** command doing the store write **and** the engine purge (§7.8).
///
/// Clearing `completed_at` without dropping the rule's arm keys would put a runs-once rule back on the
/// board still holding the `Fired` state that completed it, so it would re-arm on its next false read
/// and fire again with no crossing. Two commands could be called in either order, or one of them
/// forgotten; one command cannot.
#[tauri::command]
pub async fn reset_automation(
    state: State<'_, AppState>,
    id: String,
    origin: String,
) -> Result<(), String> {
    let owned = state.inner().clone();
    let rule_id = id.clone();
    let reloaded = tokio::task::spawn_blocking(move || {
        owned.automation_store.clear_completed(&rule_id).map_err(to_string_err)?;
        owned.automations.runtime.forget_rule(&rule_id);
        Ok::<_, String>(reload_after_commit(&owned, now_ms()))
    })
    .await
    .map_err(|e| e.to_string())??;
    announce(&state, vec![id], vec![], origin);
    EngineHost::emit_state(state.inner());
    reloaded?;
    Ok(())
}

// =================================================================================================
// Runtime-only mutations — no definition changed, so no reload
// =================================================================================================

/// *Re-arm now* — the manual backstop §2.6 admits the echo guard cannot fully replace.
///
/// `terminal_id: None` means every pair this rule watches. Deliberately NOT a `reload`: no definition
/// changed, and `reload` would preserve exactly the keys this is meant to drop.
#[tauri::command]
pub async fn rearm_automation(
    state: State<'_, AppState>,
    rule_id: String,
    terminal_id: Option<String>,
) -> Result<(), String> {
    let owned = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let runtime = &owned.automations.runtime;
        let leaves = leaves_to_rearm(&runtime.watched_for(&rule_id), terminal_id);
        for tm in leaves {
            // `seen_fire` is CARRIED, not asserted. It is a fact about this pair's history and it
            // selects the read depth (§2.2c): claiming `true` on a pair that has never fired narrows a
            // presence rule to the visible screen, so a match already sitting in scrollback is missed;
            // claiming `false` on one that HAS fired widens it back to the window and it re-fires on
            // the very line it just let go. The first version of this loop asserted `true` for every
            // leaf, which is wrong in exactly the first way.
            let seen_fire = runtime.arm_state(&rule_id, &tm).has_seen_fire();
            runtime.set_arm(
                &rule_id,
                &tm,
                crate::automation_engine::eval::ArmState::Armed { seen_fire },
            );
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    EngineHost::emit_state(state.inner());
    Ok(())
}

#[cfg(test)]
mod source_tests {
    use super::leaves_to_rearm;

    /// `Re-arm now` reaches only pairs the rule actually watches.
    ///
    /// `vec![tm]` for the named case survived the whole suite, because the branch lived inside a
    /// command that takes an `AppState`. A stale renderer naming a leaf the rule has stopped watching
    /// would mint an arm key nothing evaluates and nothing renders, reclaimed only when that terminal
    /// closes.
    #[test]
    fn re_arm_reaches_only_the_pairs_the_rule_watches() {
        let watched: std::collections::HashSet<String> =
            ["tm-1".to_string(), "tm-2".to_string()].into_iter().collect();

        assert_eq!(leaves_to_rearm(&watched, Some("tm-1".into())), vec!["tm-1".to_string()]);
        assert!(
            leaves_to_rearm(&watched, Some("tm-9".into())).is_empty(),
            "a leaf this rule does not watch is not a pair to re-arm"
        );

        let mut every = leaves_to_rearm(&watched, None);
        every.sort();
        assert_eq!(every, vec!["tm-1".to_string(), "tm-2".to_string()]);
        assert!(leaves_to_rearm(&std::collections::HashSet::new(), None).is_empty());
    }

    /// Every `#[tauri::command]` body in this module, as `(name, body)`.
    ///
    /// Source-derived because these are claims about code that must be true of commands **not yet
    /// written**: a runtime assertion can only ever cover the ones a test remembered to call, and the
    /// defect both items describe is a command added later that forgot. Normalised for CRLF —
    /// `core.autocrlf` is on and there is no `.gitattributes`, so the file git checks out is not the
    /// file in a worktree that rewrote it.
    fn command_bodies() -> Vec<(String, String)> {
        let source =
            crate::automation_engine::test_host::strip_comments(include_str!("automation_commands.rs"));
        let code = &source[..source.find("#[cfg(test)]").expect("the tests must follow the code")];
        let mut out = Vec::new();
        for chunk in code.split("#[tauri::command]").skip(1) {
            let name = chunk
                .split("pub async fn ")
                .nth(1)
                .and_then(|s| s.split('(').next())
                .expect("a command must be a `pub async fn`")
                .trim()
                .to_string();
            // Up to the next command, or the end of the file.
            out.push((name, chunk.to_string()));
        }
        out
    }

    /// §10.18 — **every** automation command goes through `spawn_blocking`.
    ///
    /// These are SQLite calls on the UI's critical path, and the history-store commands next door set
    /// the precedent. A command that runs its query inline blocks a tokio worker for as long as the
    /// database takes, which on a locked `history.db` is unbounded.
    #[test]
    fn every_automation_command_runs_its_work_off_the_async_executor() {
        let bodies = command_bodies();
        assert!(bodies.len() >= 11, "the commands moved: only found {:?}", bodies);
        for (name, body) in &bodies {
            assert!(
                body.contains("spawn_blocking"),
                "`{}` does its work on a tokio worker",
                name
            );
        }
    }

    /// §10.18c — **every command that changes a rule definition calls `reload`.**
    ///
    /// Derived from what the body actually does rather than from a list of command names, because a
    /// list is exactly what the next command will not be on. §7.3 calls this a blocker and then
    /// trusted it: without the reload the engine keeps running yesterday's rules, silently, with a
    /// Settings page that shows the new ones.
    #[test]
    fn every_command_that_changes_a_definition_reloads_the_engine() {
        // The store calls that change what a rule IS. `mark_completed` is not here: the engine raises
        // completion itself and drops the rule from its live set in the same critical section (§7.8).
        let mutators = [
            "save_rule(",
            "delete_rule(",
            "duplicate_automation(",
            "set_enabled_checked(",
            "clear_completed(",
        ];
        let mut checked = 0;
        for (name, body) in command_bodies() {
            if !mutators.iter().any(|m| body.contains(m)) {
                continue;
            }
            checked += 1;
            assert!(
                body.contains("reload_after_commit("),
                "`{}` changes a rule definition and never tells the engine",
                name
            );
            // And it must not `?` the reload inside the closure. The store write has already
            // COMMITTED by then, so propagating there skips `announce` and leaves every other window
            // showing a definition that is no longer on disk, with nothing in the log to say why.
            assert!(
                !body.contains("reload_after_commit(&owned, now_ms())?"),
                "`{}` lets a failed reload swallow the announce for a write that already happened",
                name
            );
            // And the ORDER, which is the actual requirement. The negative above pins one spelling of
            // one wrong implementation; the cheapest wrong implementation is not a spelling at all —
            // it is moving `reloaded?;` one line up, above the `announce(…)`, which contains no `?` on
            // the helper and passed.
            let announced = body.find("announce(").unwrap_or_else(|| {
                panic!("`{}` changes a definition and tells no other window", name)
            });
            let propagated = body
                .find("reloaded?")
                .unwrap_or_else(|| panic!("`{}` never propagates the reload's error", name));
            assert!(
                announced < propagated,
                "`{}` propagates the reload before announcing a write that already committed",
                name
            );
        }
        assert_eq!(checked, 5, "the mutating commands moved; this test was checking nothing");

        // ONE call site, so the announce cannot be skipped by not using the helper. Counted over the
        // PRODUCTION half only — this assertion's own needle lives in the test half, and a source
        // test that matches itself is the trap this feature has now walked into three times.
        let module =
            crate::automation_engine::test_host::strip_comments(include_str!("automation_commands.rs"));
        let code = &module[..module.find("#[cfg(test)]").expect("the tests must follow the code")];
        assert_eq!(
            code.matches("automations.reload(").count(),
            1,
            "`reload` is called somewhere other than `reload_after_commit`"
        );
    }

    /// **These tests read one file, and §9 does not oblige anyone to put the next command in it.**
    ///
    /// `command_bodies` scans `automation_commands.rs`. An automation command added anywhere else
    /// would pass `every_automation_command_runs_its_work_off_the_async_executor` and
    /// `every_command_that_changes_a_definition_reloads_the_engine` while being covered by neither.
    /// So the assumption those two rest on is pinned here rather than assumed: automation commands
    /// live in the automation module.
    ///
    /// **Every file in this crate that declares a `#[tauri::command]`**, which the first version was
    /// not: it read `commands.rs` and `lib.rs`, and `lib.rs` declares **none** — that half could not
    /// produce a hit under any implementation — while five files that do declare commands were never
    /// scanned. The floor below is the same check applied to this test itself: an instrument whose
    /// clean result has never been shown to be capable of being dirty is not a census.
    #[test]
    fn no_automation_command_lives_outside_this_module() {
        let mut scanned = 0;
        for (path, source) in [
            ("commands.rs", include_str!("commands.rs")),
            ("peer_commands.rs", include_str!("peer_commands.rs")),
            ("network_commands.rs", include_str!("network_commands.rs")),
            ("open_commands.rs", include_str!("open_commands.rs")),
            ("shell_integration.rs", include_str!("shell_integration.rs")),
            ("native_notify.rs", include_str!("native_notify.rs")),
        ] {
            let code = crate::automation_engine::test_host::strip_comments(source);
            for body in code.split("#[tauri::command]").skip(1) {
                scanned += 1;
                let name = body.split("fn ").nth(1).and_then(|s| s.split('(').next()).unwrap_or("?");
                assert!(
                    !body.contains("automation_store") && !body.contains("automations."),
                    "{}'s `{}` is an automation command living where this feature's source tests \
                     cannot see it: move it to automation_commands.rs",
                    path,
                    name.trim()
                );
            }
        }
        assert!(
            scanned >= 80,
            "this scan reached {} command bodies: the files it names have moved and it is now \
             asserting a `never` over almost nothing",
            scanned
        );
    }

    /// Every command in this module is REGISTERED, and the count the other tests assert is that list.
    ///
    /// `bodies.len() >= 11` is only a floor over whatever happens to be in the file; an unregistered
    /// command satisfies it while being unreachable from the UI, and a registered one that was
    /// deleted satisfies it while breaking the app at startup.
    #[test]
    fn every_command_in_this_module_is_registered_in_lib() {
        let lib = crate::automation_engine::test_host::strip_comments(include_str!("lib.rs"));
        let names: Vec<String> = command_bodies().into_iter().map(|(n, _)| n).collect();
        assert_eq!(names.len(), 11, "the command list changed: {:?}", names);
        for name in &names {
            assert!(
                lib.contains(&format!("automation_commands::{},", name)),
                "`{}` is a command nothing can invoke",
                name
            );
        }
    }

    /// §7.8 — *Reset* is **one** command doing the store write **and** the engine purge.
    ///
    /// Clearing `completed_at` without dropping the rule's arm keys puts a runs-once rule back on the
    /// board still holding the `Fired` state that completed it, so it re-arms on its next false read
    /// and fires with no crossing at all. Two commands could be called in either order, or one of them
    /// forgotten; one command cannot — and this is what keeps them one.
    #[test]
    fn reset_clears_the_row_and_purges_the_engine_in_the_same_command() {
        let resetters: Vec<(String, String)> = command_bodies()
            .into_iter()
            .filter(|(_, body)| body.contains("clear_completed("))
            .collect();
        assert_eq!(resetters.len(), 1, "reset must be exactly one command: {:?}", resetters);
        assert!(
            resetters[0].1.contains("forget_rule("),
            "`{}` un-completes a rule and leaves its arm keys behind",
            resetters[0].0
        );
    }

    /// §10.18's other half — the `pc-`/`tm-` boundary, pinned rather than trusted.
    ///
    /// `state.resolve_ref` returns its **input unchanged** when the leaf does not resolve, so it can
    /// never double as an existence test and would hand a `tm-` string to a `pc-`keyed map. The engine
    /// converts through `identity.process_for_leaf` and nowhere else (§7.4).
    #[test]
    fn the_engine_never_reaches_for_the_lenient_resolver() {
        for (path, source) in [
            ("automation_engine.rs", include_str!("automation_engine.rs")),
            ("automation_engine/loops.rs", include_str!("automation_engine/loops.rs")),
            ("automation_engine/dry.rs", include_str!("automation_engine/dry.rs")),
            ("automation_engine/host.rs", include_str!("automation_engine/host.rs")),
            ("automation_commands.rs", include_str!("automation_commands.rs")),
        ] {
            let body = crate::automation_engine::test_host::strip_comments(source);
            // The needle is ASSEMBLED, and that is not decoration: this file is one of the files
            // scanned, so a literal `"resolve_ref("` in the assertion is itself a match and the test
            // fails against its own source. Slicing the test module off instead would not work here —
            // `automation_engine.rs` declares a `#[cfg(test)]` module near the top, so cutting at the
            // first one cuts the whole file.
            let needle = format!("{}(", "resolve_ref");
            assert!(
                !body.contains(&needle),
                "{} reaches for that resolver: the one conversion is identity.process_for_leaf",
                path
            );
        }
    }

    /// **§3.5's own sentence, and both arms of it.** *"saved from window `main`, replacing the
    /// version saved from `main-2`"* — GUI step 19 reads this line.
    ///
    /// `saved_detail` is a free function in this module and `leaves_to_rearm` is unit-tested three
    /// blocks above, so §7.10 was never the reason this had none: it simply was not written. Flipping
    /// the `match` arms is invisible without it.
    #[test]
    fn a_saved_row_says_which_window_saved_it_and_what_it_replaced() {
        assert_eq!(super::saved_detail("main", None), "created from window main");

        let replacing = super::saved_detail("main", Some(3_600_000));
        assert!(
            replacing.starts_with("saved from window main, replacing the version saved at "),
            "{}",
            replacing
        );
        // A wall-clock instant, not the raw ms: the SCHEMA has no field for who saved last, and the
        // round-1 ruling that put this line in `detail` said naming the time is better than inventing
        // a window name.
        assert!(!replacing.contains("3600000"), "{}", replacing);
        assert_ne!(replacing, super::saved_detail("main-2", Some(3_600_000)));
    }

    /// **The three round-1 fixes that landed inside `AppState` commands**, where §7.10 says no
    /// Windows test can reach them — so they are pinned in source instead of not at all.
    ///
    /// Each one is a whole round-1 finding whose deletion passes the suite: `newest_snapshots()`
    /// reverted to an empty list is the picker's bare-id row (external Finding 5), and a missing
    /// `note(…)` is the `Saved` / `Enabled` / `Disabled` log row (external Finding 4, §3.5).
    #[test]
    fn the_commands_that_own_a_decision_still_make_it() {
        let bodies = command_bodies();
        let body = |name: &str| {
            bodies
                .iter()
                .find(|(n, _)| n == name)
                .unwrap_or_else(|| panic!("`{}` is gone", name))
                .1
                .clone()
        };

        assert!(
            body("list_watchable_terminals").contains("newest_snapshots()"),
            "§4.3's fallback: with no rule to scope to, every closed terminal draws as a bare id"
        );
        // M5's P0. `save_rule` INSERTs `rule.id` verbatim, so a draft saved with `id: ""` becomes a
        // row keyed on the empty string — and the SECOND new rule ON CONFLICT-overwrites the first.
        // Two rules created, one row, no error. Nothing in M1–M4 saves a new rule, so nothing could
        // reach it; the editor reaches it on its first Save. Pinned in source because minting lives
        // inside a command, where §7.10 says no Windows test can call it.
        let saving = body("save_automation");
        assert!(
            saving.contains("rule.id.trim().is_empty()") && saving.contains("format!(\"au-{}\""),
            "save_automation mints no id for a new rule, so two new rules collide on the empty string"
        );
        assert!(
            saving.contains("next_sort_order()"),
            "a minted rule keeps sortOrder 0 and files itself above every existing rule"
        );
        assert!(
            body("save_automation").contains("note(") && body("save_automation").contains("Saved"),
            "§3.5: a save writes no row saying it happened"
        );
        let enabled = body("set_automation_enabled");
        assert!(enabled.contains("note("), "§3.5: a toggle writes no row saying it happened");
        assert!(
            enabled.contains("LogKind::Enabled") && enabled.contains("LogKind::Disabled"),
            "both arms, or the log says the same thing whichever way the toggle went"
        );
    }

    /// §10.18d's local half — the event and first paint are **one function**, in source.
    ///
    /// `automation_engine.rs` already asserts the two payloads are equal at runtime. This asserts they
    /// cannot drift, which is the claim that survives someone adding a field to one of them: there is
    /// only one builder and both call it.
    #[test]
    fn first_paint_and_the_state_event_call_the_same_builder() {
        // Stripped: both needles are POSITIVE `contains`, which a comment mentioning either call
        // would satisfy on its own. **And sliced**: this test lives in `automation_commands.rs` and
        // reads it, so the needle on the assertion's own line is itself a match — deleting
        // `engine.runtime_payload()` from `get_automation_runtime` left this half green. The sibling
        // test two blocks down assembles its needle for the same reason; this one takes the
        // production half, which is what `command_bodies` and the reload count already do.
        let module =
            crate::automation_engine::test_host::strip_comments(include_str!("automation_commands.rs"));
        let commands =
            &module[..module.find("#[cfg(test)]").expect("the tests must follow the code")];
        let state = crate::automation_engine::test_host::strip_comments(include_str!("state.rs"));
        assert!(
            commands.contains("engine.runtime_payload()"),
            "get_automation_runtime must return the same object the event carries"
        );
        assert!(
            state.contains("self.automations.runtime_payload()"),
            "the automation:state emit must carry the same object first paint reads"
        );
    }
}
