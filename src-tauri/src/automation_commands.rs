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
//! **Every command that changes a rule DEFINITION calls `automations.reload(`**, and §10.18c derives
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

#[tauri::command]
pub async fn save_automation(
    state: State<'_, AppState>,
    rule: AutomationRule,
    origin: String,
) -> Result<Option<i64>, String> {
    let owned = state.inner().clone();
    let id = rule.id.clone();
    let origin_for_log = origin.clone();
    let previous = tokio::task::spawn_blocking(move || {
        let previous = owned.automation_store.save_rule(&rule).map_err(to_string_err)?;
        // §3.5: the `saved` entry's detail carries the origin window, and `save_rule` returns the
        // previous `updated_at` from INSIDE its own transaction so the line can name what it replaced.
        // Two windows may hold one rule open and the later save wins whole; the log entry IS the
        // requirement, not concurrency control. GUI step 19 checks this line.
        note(&owned, &rule.id, LogKind::Saved, &saved_detail(&origin_for_log, previous));
        owned.automations.reload(&owned.automation_store, now_ms()).map_err(to_string_err)?;
        Ok::<_, String>(previous)
    })
    .await
    .map_err(|e| e.to_string())??;
    announce(&state, vec![id], vec![], origin);
    Ok(previous)
}

#[tauri::command]
pub async fn delete_automation(
    state: State<'_, AppState>,
    id: String,
    origin: String,
) -> Result<bool, String> {
    let owned = state.inner().clone();
    let rule_id = id.clone();
    let removed = tokio::task::spawn_blocking(move || {
        let removed = owned.automation_store.delete_rule(&rule_id).map_err(to_string_err)?;
        owned.automations.reload(&owned.automation_store, now_ms()).map_err(to_string_err)?;
        Ok::<_, String>(removed)
    })
    .await
    .map_err(|e| e.to_string())??;
    announce(&state, vec![], vec![id], origin);
    Ok(removed)
}

#[tauri::command]
pub async fn duplicate_automation(
    state: State<'_, AppState>,
    id: String,
    origin: String,
) -> Result<AutomationRule, String> {
    let owned = state.inner().clone();
    let copy = tokio::task::spawn_blocking(move || {
        let copy =
            owned.automation_store.duplicate_automation(&id, now_ms()).map_err(to_string_err)?;
        owned.automations.reload(&owned.automation_store, now_ms()).map_err(to_string_err)?;
        Ok::<_, String>(copy)
    })
    .await
    .map_err(|e| e.to_string())??;
    announce(&state, vec![copy.id.clone()], vec![], origin);
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
    tokio::task::spawn_blocking(move || {
        owned.automation_store.set_enabled_checked(&rule_id, enabled).map_err(to_string_err)?;
        // Only after the check passed, so a refused enable never claims in the log to have happened.
        let kind = if enabled { LogKind::Enabled } else { LogKind::Disabled };
        note(&owned, &rule_id, kind, &format!("from window {}", origin_for_log));
        owned.automations.reload(&owned.automation_store, now_ms()).map_err(to_string_err)?;
        Ok::<_, String>(())
    })
    .await
    .map_err(|e| e.to_string())??;
    announce(&state, vec![id], vec![], origin);
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
    tokio::task::spawn_blocking(move || {
        owned.automation_store.clear_completed(&rule_id).map_err(to_string_err)?;
        owned.automations.runtime.forget_rule(&rule_id);
        owned.automations.reload(&owned.automation_store, now_ms()).map_err(to_string_err)?;
        Ok::<_, String>(())
    })
    .await
    .map_err(|e| e.to_string())??;
    announce(&state, vec![id], vec![], origin);
    EngineHost::emit_state(state.inner());
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
        let leaves: Vec<String> = match terminal_id {
            Some(tm) => vec![tm],
            None => runtime.watched_for(&rule_id).into_iter().collect(),
        };
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
    /// Every `#[tauri::command]` body in this module, as `(name, body)`.
    ///
    /// Source-derived because these are claims about code that must be true of commands **not yet
    /// written**: a runtime assertion can only ever cover the ones a test remembered to call, and the
    /// defect both items describe is a command added later that forgot. Normalised for CRLF —
    /// `core.autocrlf` is on and there is no `.gitattributes`, so the file git checks out is not the
    /// file in a worktree that rewrote it.
    fn command_bodies() -> Vec<(String, String)> {
        let source = include_str!("automation_commands.rs").replace("\r\n", "\n");
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
                body.contains("automations.reload("),
                "`{}` changes a rule definition and never tells the engine",
                name
            );
        }
        assert_eq!(checked, 5, "the mutating commands moved; this test was checking nothing");
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
            let body: String = source
                .replace("\r\n", "\n")
                .lines()
                .filter(|l| !l.trim_start().starts_with("//"))
                .collect::<Vec<_>>()
                .join("\n");
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

    /// §10.18d's local half — the event and first paint are **one function**, in source.
    ///
    /// `automation_engine.rs` already asserts the two payloads are equal at runtime. This asserts they
    /// cannot drift, which is the claim that survives someone adding a field to one of them: there is
    /// only one builder and both call it.
    #[test]
    fn first_paint_and_the_state_event_call_the_same_builder() {
        let commands = include_str!("automation_commands.rs").replace("\r\n", "\n");
        let state = include_str!("state.rs").replace("\r\n", "\n");
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
