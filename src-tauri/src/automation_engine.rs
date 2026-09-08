//! The Terminal Automations engine — plan `028`.
//!
//! One tap task, one evaluator task and one targeting tick for the whole engine — never one per rule.
//!
//! **The tap carries a signal, not data.** `state.terminal_screens` already holds a per-terminal
//! `vt100::Parser` fed every raw byte, unconditionally and losslessly, by the single authoritative
//! output consumer — before the lossy history filter runs. So the tap does exactly
//! `dirty.insert(payload.id, ())` and never reads `payload.data`, and the evaluator reads matchable
//! text from that parser. Three problems disappear together: a `ctx:5` | `0%` split across two chunks
//! is a non-issue because the parser is a state machine that spans `process()` calls; a
//! `RecvError::Lagged` costs a delayed evaluation rather than a missed match; and no new per-terminal
//! buffer exists, so there is nothing new to bound or leak. Plan §1.1.
//!
//! **Everything handed to `AppState` is a `pc-` process id; everything keyed here is the durable
//! `tm-` leaf**, converted at exactly one place. Never `state.resolve_ref` — it returns its input
//! unchanged when the leaf does not resolve, so it cannot double as an existence test and would hand a
//! `tm-` string to a `pc-`keyed map. Plan §7.4 holds the table.
//!
//! **M2 landed the pure core** (`eval`: extraction, comparison, the two-depth read, the arm machine)
//! **and this struct. M3 lands the three running loops.**

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};

pub mod due;
pub mod dry;
pub mod eval;
pub mod host;
pub mod loops;
pub mod schedule;
pub mod subst;
#[cfg(test)]
pub mod test_host;

use regex::Regex;

use crate::automation::events::{RuntimePairState, StatePayload};
use crate::automation::runtime::AutomationRuntime;
use crate::automation_engine::eval::ArmState;
use crate::automation_store::{
    AutomationGraph, AutomationLogEntry, AutomationRule, AutomationStore, AutomationStoreError,
    Clause, Finds, Keep, LogKind, Source, Test, TimerMode, TimerStep,
};

/// Start the engine: load the rules, then the three tasks (plan §2.1, §2.3, §4.4).
///
/// **Called once, from `.setup()`, immediately after `spawn_history_flush_task`** — the same place
/// and the same shape as every other long-lived task in this crate.
///
/// `reload` is attempted once and, on **any** error, once more after a short delay. `init` runs a few
/// lines earlier in the same closure, so the store is normally ready; the error worth retrying is
/// `Disabled` — the history DB path was unavailable — but a `SQLITE_BUSY` on `list_rules` deserves the
/// same second chance and telling them apart would buy nothing. The retry costs one wake-up against a
/// feature that would otherwise stay silently off for the whole session with nothing in the log to say
/// why.
///
/// Takes the concrete `AppState<R>` and hands the loops an `Arc<dyn EngineHost>`: everything with a
/// decision in it is on the far side of that port and is tested against a fake (§7.10).
pub fn spawn<R: tauri::Runtime>(state: crate::state::AppState<R>) {
    let engine = state.automations.clone();
    let rx = state.output_tx.subscribe();
    let host: Arc<dyn host::EngineHost> = Arc::new(state);

    // **`tauri::async_runtime::spawn`, never bare `tokio::spawn`.** `.setup()` runs on the main
    // thread from the tao event-loop callback, with no tokio runtime entered — a bare `tokio::spawn`
    // panics there and takes the whole app's startup with it. Tauri's own wrapper is
    // `let _guard = runtime.enter(); tokio::spawn(task)`, and it enters precisely because the bare
    // call would fail. Every other setup-time task in `lib.rs` uses it, including
    // `spawn_history_flush_task` — the function this call sits directly beneath. The three inner
    // spawns below are fine: by then we are inside an async task and a runtime IS entered.
    tauri::async_runtime::spawn({
        let engine = engine.clone();
        let host = host.clone();
        async move {
            for attempt in 0..2 {
                match engine.reload(host.store(), chrono::Utc::now().timestamp_millis()) {
                    Ok(report) => {
                        log::info!(
                            "automations: {} rule(s) running, {} refused",
                            report.live,
                            report.skipped.len()
                        );
                        if let Some(ids) = refusals_to_announce(&report) {
                            host.emit_activity(ids);
                        }
                        break;
                    }
                    Err(e) => {
                        if attempt == 0 {
                            log::warn!("automations: rules could not be loaded ({}), retrying", e);
                            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                        } else {
                            log::error!("automations: rules could not be loaded: {}", e);
                        }
                    }
                }
            }

            tokio::spawn(loops::run_tap(engine.clone(), host.clone(), rx));
            tokio::spawn(loops::run_evaluator(engine.clone(), host.clone()));
            tokio::spawn(loops::run_targeting(engine, host));
        }
    });
}

/// How often `automation:state` may be emitted (§7.2's “≤ 1/s”).
pub const STATE_EMIT_MIN_INTERVAL_MS: i64 = 1_000;

/// One rule the engine is actually running: its definition, and its pattern compiled once at load.
///
/// Compiling per evaluation would recompile the same pattern four times a second per terminal, and
/// §2.7 wants an uncompilable pattern reported **once per load** rather than once per tick — which is
/// only expressible if compilation happens where "a load" is a thing that happens.
#[derive(Debug)]
pub struct LiveRule {
    pub rule: AutomationRule,
    /// `None` on a **schedule rule** (plan 032 §6.3, §6.4), which has no `parse` step and therefore
    /// no pattern to compile. Every consumer of this is on the OUTPUT path and already knows it is
    /// on the output path.
    ///
    /// **Not a `Regex::new("")` stand-in, and this is the whole point of the `Option`.** An empty
    /// pattern compiles and matches every position of every string — `pattern_refused_at_load`
    /// exists because of exactly that — so a "harmless" default here would make a rule that reads
    /// nothing fire on the first byte any watched terminal printed.
    pub re: Option<Regex>,
}

/// Fold a v1 `op`/`threshold`/`keep` rule into the clause list it means.
///
/// Runs at load, on the in-memory copy only — the row is not rewritten, which is what keeps a
/// merely-loaded v1 rule from being promoted to schema_version 2 (§3.2). Idempotent. Called from
/// `reload`, immediately after the pattern compiles and before the `LiveRule` is built — folding a
/// v1 comparison is meaningless without a pattern to have captured from.
///
/// **A schedule rule (§6.3) folds to nothing, and the guard is the first thing here rather than the
/// caller's job.** It has no `parse` step to source from and no `cond` step to fold into, so there
/// is no v1 pair to find; both call sites already sit inside their own pattern-present branch, and
/// this makes the third one safe too.
pub fn fold_v1_clauses(graph: &mut AutomationGraph, re: &Regex) {
    let Some(keep) = graph.parse.as_ref().map(|p| p.keep) else {
        return;
    };
    let Some(cond) = graph.cond.as_mut() else {
        return;
    };
    if !cond.clauses.is_empty() {
        return;
    }
    // A word rule folds to NOTHING. Today's text branch is `is_match`, and an empty clause list
    // means exactly that (§5.5 step 4) — so this is not a special case, it is the existing
    // behaviour written down.
    if cond.finds == Finds::Event {
        return;
    }
    let (Some(op), Some(threshold)) = (cond.op, cond.threshold) else {
        return; // a numeric rule with no comparator is a blocking validation problem already
    };
    let source = match keep {
        Keep::Whole => Source::Whole,
        Keep::Brackets if re.capture_names().flatten().any(|n| n == "value") => {
            Source::Named("value".into())
        }
        Keep::Brackets => Source::Group(1),
    };
    cond.clauses.push(Clause { source, test: Test::Number { op, value: Some(threshold) } });
}

/// The rule ids a `reload` should announce, or `None` if it wrote nothing worth announcing.
///
/// Extracted because it was written twice — once in `spawn`, once in `automation_commands`'
/// `reload_after_commit` — and both copies sat inside a function that takes an `AppState`, which §7.10
/// says is the one place a decision cannot be tested on Windows. `if report.emit` written as
/// `if false` changed nothing any test could see, in either copy.
///
/// **`emit` means a refusal row reached the log.** It is the store's answer rather than the engine's
/// — but not because the verbose gate might have swallowed it: that gate runs only for a `Check`-class
/// row (`class_of`), and the only kind `reload` writes is `LogKind::Failed`, which is `Decision`-class
/// and never gated. In `reload` the flag is set inside the loop that fills `skipped`, so `emit` is
/// true exactly when at least one refusal was written. Announcing when nothing was would make every
/// open Settings page re-query the log for nothing.
pub fn refusals_to_announce(report: &ReloadReport) -> Option<Vec<String>> {
    if !report.emit {
        return None;
    }
    Some(report.skipped.iter().map(|(id, _)| id.clone()).collect())
}

/// What one `reload` did, for the caller that owns the emit.
#[derive(Debug, Default, PartialEq)]
pub struct ReloadReport {
    /// How many rules the engine is now running.
    pub live: usize,
    /// `(rule_id, reason)` for every rule refused at load. One entry per rule **per load**, never per
    /// tick — the same discipline §2.7 applies to an uncompilable pattern.
    pub skipped: Vec<(String, String)>,
    /// A log row was actually written, so the caller emits `automation:activity`. The store's own
    /// verbose gate decides this; the engine does not second-guess it.
    pub emit: bool,
}

/// The engine's own handle: the per-terminal state it drives, and the one signal that stops it.
///
/// Constructed inert (the `CanvasStore::new()` precedent) and held on `AppState` so
/// `cleanup_terminal_state` can purge a closing terminal's state and, from M3, so `RunEvent::Exit`
/// can set `stopping` before the runtime is torn down.
pub struct AutomationEngine {
    /// Standalone and `Arc`-shared, so every unit test targets it directly without an `AppHandle`
    /// (plan §7.10). `AppState` reaches it through this struct rather than holding a second `Arc`,
    /// which would be two owners of one lifetime.
    pub runtime: Arc<AutomationRuntime>,
    /// **The only stop signal.** The store has none and `state.exiting` is not read — that field's
    /// only reader is the `.swap()` inside `flush_then_exit`, making it a re-entrancy guard for one
    /// function rather than a general "shutting down" flag.
    ///
    /// Its **only writer is `lib.rs`'s `RunEvent::Exit`** (M3), which sets it first, before the
    /// scrollback flush and the two sidecar shutdowns that follow — the loops must stop deciding
    /// before the runtime they run on goes away. The three loops check it at the top of every
    /// iteration, and a send
    /// checks it before its first write and never between the paste and the submit — so a send has
    /// either not started or runs to completion, and the whole in-flight problem disappears.
    ///
    /// *(Plan §2.1 assigned "the flag and the three loop checks" to M2. A check cannot exist without
    /// its loop, and the loops are M3 tasks whose gate — §10.6b — is the only test of those checks;
    /// the flag lands here, the checks land with the loops. Corrected in the plan.)*
    stopping: Arc<AtomicBool>,
    /// The rules the engine is running, by id.
    ///
    /// Replaced wholesale by `reload` and only ever read through `snapshot_live`, which copies the
    /// `Arc`s out under a short lock. Nothing holds this guard across an `.await`: the evaluator's
    /// tick takes a snapshot and drops it before it touches a terminal.
    live: RwLock<HashMap<String, Arc<LiveRule>>>,
    /// When this process's engine came up, in wall-clock ms.
    ///
    /// Read only by the missing-target grace (§4.5): at t=0 the live set is empty and session restore
    /// has not run, so reporting an absent pinned id immediately writes a "1 id not open" line on
    /// every normal restart and then silently retracts it.
    started_at_ms: i64,
    /// Which pinned ids are reportably missing, by rule — **the targeting tick's answer, parked**.
    ///
    /// The tick is the only thing that can compute this (it holds the roster), and it runs every 2 s;
    /// but the two consumers are the `automation:state` emit, which fires on a crossing, and
    /// `get_automation_runtime()`, which fires when a Settings page paints. Neither has a roster. So
    /// the tick's answer is stored where they can read it, rather than each of them either inventing
    /// an empty map — which flickers every *not open* pill off the moment any rule fires — or growing
    /// its own roster walk, which is the second implementation.
    ///
    /// One writer (`loops::targeting_tick`), two readers, exactly like `watched`.
    missing: RwLock<HashMap<String, HashSet<String>>>,
    /// When `automation:state` was last emitted, for the ≤ 1/s coalescer (§2.9, §7.2).
    ///
    /// **Inside the thing that emits the event**, per §2.9's ruling that a coalescer belongs to its
    /// emitter rather than to `AppState`. The engine decides arm transitions, so the engine owns the
    /// rate at which it announces them: a chatty terminal produces four transitions a second per
    /// pair, and an un-coalesced emit repaints every open Settings page at that rate.
    last_state_emit_ms: std::sync::Mutex<Option<i64>>,
    /// Something the payload shows has changed since the last emit.
    state_dirty: AtomicBool,
}

/// Whether this reload can have missed part of this daily target's window. The target's being past
/// is a separate question owned by `seed_missed_schedules`.
fn has_unobserved_daily_window(
    newly_live: bool,
    target_changed: bool,
    invalidated_mark: bool,
    last_fired_day: Option<i32>,
    now_day: i32,
) -> bool {
    (newly_live || target_changed || invalidated_mark) && last_fired_day != Some(now_day)
}

impl AutomationEngine {
    pub fn new(started_at_ms: i64) -> Self {
        Self {
            runtime: Arc::new(AutomationRuntime::new()),
            stopping: Arc::new(AtomicBool::new(false)),
            live: RwLock::new(HashMap::new()),
            started_at_ms,
            missing: RwLock::new(HashMap::new()),
            last_state_emit_ms: std::sync::Mutex::new(None),
            state_dirty: AtomicBool::new(false),
        }
    }

    /// Something the state payload shows has changed. **Records it; does not emit.**
    ///
    /// A coalescer that answers *"may I emit right now?"* DROPS what it refuses, and the refused
    /// event is not re-offered: the next tick's decision is `held`, which is not a transition, so a
    /// pill would sit stale until something else happened. A flag the tick drains defers instead —
    /// no transition is lost and the rate is still bounded.
    pub fn mark_state_dirty(&self) {
        self.state_dirty.store(true, Ordering::Relaxed);
    }

    /// Should the caller emit `automation:state` now? Spends the flag and the slot when it says yes.
    ///
    /// ≤ 1/s (§7.2), coalesced inside the engine (§2.9). A backwards wall clock resyncs rather than
    /// parking the emit until real time catches up — the same correction `append`'s own limiter
    /// carries, for the same reason: an NTP step or a resume would otherwise stop the panel repainting
    /// for the length of the jump.
    pub fn take_state_emit(&self, now_ms: i64) -> bool {
        if !self.state_dirty.load(Ordering::Relaxed) {
            return false;
        }
        let mut last = self.last_state_emit_ms.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(at) = *last {
            if now_ms >= at && now_ms - at < STATE_EMIT_MIN_INTERVAL_MS {
                return false;
            }
        }
        *last = Some(now_ms);
        self.state_dirty.store(false, Ordering::Relaxed);
        true
    }

    /// The targeting tick's only write to the missing map.
    pub fn set_missing(&self, missing: HashMap<String, HashSet<String>>) {
        *self.missing.write().unwrap_or_else(|e| e.into_inner()) = missing;
    }

    /// The missing map as the targeting tick last resolved it.
    pub fn missing_snapshot(&self) -> HashMap<String, HashSet<String>> {
        self.missing.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// The runtime object every row's pill reads, with the missing map the targeting tick last
    /// resolved. **This is what both the event and `get_automation_runtime()` call**, so §10.18d's
    /// "they agree" is true by construction rather than by two call sites being kept in step.
    pub fn runtime_payload(&self) -> StatePayload {
        let missing = self.missing.read().unwrap_or_else(|e| e.into_inner()).clone();
        self.state_payload(&missing)
    }

    pub fn started_at_ms(&self) -> i64 {
        self.started_at_ms
    }

    pub fn is_stopping(&self) -> bool {
        self.stopping.load(Ordering::Relaxed)
    }

    /// Called by `RunEvent::Exit` only.
    pub fn stop(&self) {
        self.stopping.store(true, Ordering::Relaxed);
    }

    // ---------------------------------------------------------------------------------------------
    // The rule source (§7.3)
    // ---------------------------------------------------------------------------------------------

    /// Every rule the engine is running, in the user's own order.
    ///
    /// Sorted, because the evaluator's per-tick cap round-robins over this list and an unordered walk
    /// would make which rules get held over depend on hash iteration order — different every run, and
    /// impossible to reason about from a log.
    pub fn snapshot_live(&self) -> Vec<Arc<LiveRule>> {
        let guard = self.live.read().unwrap_or_else(|e| e.into_inner());
        let mut out: Vec<Arc<LiveRule>> = guard.values().cloned().collect();
        drop(guard);
        out.sort_by(|a, b| {
            (a.rule.sort_order, a.rule.id.as_str()).cmp(&(b.rule.sort_order, b.rule.id.as_str()))
        });
        out
    }

    pub fn is_live(&self, rule_id: &str) -> bool {
        self.live.read().unwrap_or_else(|e| e.into_inner()).contains_key(rule_id)
    }

    /// Rebuild the live set from the store.
    ///
    /// **Takes the store, not `&AppState`** (§7.3, round-2 review): the engine needs rules, not an
    /// app, and `reload(&AppState)` would put this function's own gates behind `integration-tests`,
    /// which cannot run on Windows.
    ///
    /// **Runtime state is PRESERVED for every rule that did not change.** The obvious implementation
    /// — build a fresh map and drop the old keys — mutes every *other* rule in the app: flipping rule
    /// A's toggle would clear rule B's keys, every B pair would become `Unseen`, and settled decision
    /// 7 makes an already-matching condition count as fired — so **B goes silent until its next
    /// genuine crossing**, with no log line and nothing on screen. Keys are dropped only for rules
    /// that disappeared or whose `updated_at` moved, which is Q11 (*an edit resets that rule's arm
    /// state*) falling out for free. `a-toggle-is-not-a-restore`,
    /// `re-keying-a-map-orphans-its-readers`.
    ///
    /// A rule is refused, with exactly one log row per load, when its `schema_version` is newer than
    /// this build understands or its pattern will not compile. A **completed** rule is filtered
    /// silently — that is a normal end state, not a failure, and §7.8 makes the in-memory removal the
    /// mechanism anyway; this filter is the second line of defence for the next launch.
    pub fn reload(
        &self,
        store: &AutomationStore,
        now_ms: i64,
    ) -> Result<ReloadReport, AutomationStoreError> {
        self.reload_at(store, now_ms, schedule::local_now(now_ms))
    }

    /// `reload`, with the local wall-clock day handed in rather than read.
    ///
    /// **The seam exists for the seeding below and for nothing else.** What that seeding does
    /// depends on the machine's time zone — "is 09:00 already past" has no answer without one — so a
    /// test that could only pass `now_ms` would be asserting against wherever the runner happens to
    /// be, and would be a coin flip near midnight. `reload` is the whole of production: it reads the
    /// clock through `schedule::local_now`, automation's one conversion. (Not the crate's:
    /// `commands.rs` and `pty_manager.rs` call `chrono::Local::now()` themselves. Same
    /// narrowing as `schedule::local_now`'s own header, which is where the claim belongs.)
    ///
    /// **Private, because nothing binds `now_local` to `now_ms`.** They are one instant in two
    /// spellings and the compiler cannot say so, so a caller that passed an inconsistent pair would
    /// seed one day and log another with nothing to stop it. `reload` derives the second from the
    /// first and is the only production caller; the tests that need the seam are in this module.
    /// The resume path does not want this function — it wants [`Self::seed_missed_schedules`],
    /// which takes the rules it is already holding.
    fn reload_at(
        &self,
        store: &AutomationStore,
        now_ms: i64,
        now_local: schedule::LocalTime,
    ) -> Result<ReloadReport, AutomationStoreError> {
        let rules = store.list_rules()?;
        // Keep the store's current timer before disabled and completed rows are filtered from the
        // live generation. A disabled rule is still the same saved schedule, while a deleted one
        // has no entry here and must lose everything it owned.
        let store_timers: HashMap<String, Option<TimerMode>> = rules
            .iter()
            .map(|rule| {
                (
                    rule.id.clone(),
                    rule.graph.timer.as_ref().map(|timer| timer.mode.clone()),
                )
            })
            .collect();
        // A spent day belongs to a target minute, not to the live generation that happened to
        // contain that rule. Disabled rules are deliberately absent from `next`, so validate every
        // retained mark against the store before the live-set teardown can make it invisible.
        let mut invalidated_marks = HashSet::new();
        for (id, _, marked_minute) in self.runtime.last_fired_marks() {
            let still_targets_marked_minute = matches!(
                store_timers.get(&id).and_then(|timer| timer.as_ref()),
                Some(TimerMode::DailyAt { minute_of_day, .. }) if *minute_of_day == marked_minute
            );
            if !still_targets_marked_minute {
                self.runtime.forget_last_fired_day(&id);
                invalidated_marks.insert(id);
            }
        }
        let mut next: HashMap<String, Arc<LiveRule>> = HashMap::new();
        let mut report = ReloadReport::default();
        // §3.3: rows the store could not decode. They never became `AutomationRule`s, so the
        // loop below cannot see them — they are reported here or nowhere.
        report.skipped.extend(store.take_skipped_rows());

        for mut rule in rules {
            if !rule.enabled || rule.completed_at.is_some() {
                continue;
            }
            if !rule.is_runnable() {
                report
                    .skipped
                    .push((rule.id.clone(), "this rule needs a newer version of TermFlow".into()));
                continue;
            }
            // **A rule with nothing to watch and no schedule can never fire, so it is skipped with
            // a reason** — beside the pattern refusal below, and for the same reasons.
            //
            // Since §3.1 made the monitor step optional, such a row could pass validation (nothing
            // checked it), save *enabled*, count in `report.live`, and be walked four times a
            // second only to fall out at the evaluator's monitor guard — live by every reading the
            // user has, and unable to do anything at all. `AfterMatch` with no monitor is the same
            // shape: a delay is parked at a crossing, and there is nothing here that can cross.
            //
            // **Corrected (R7): this is now ALSO a validation blocker, `timer.neverRuns`
            // (`automation_validation::problems`), not merely a skip.** This paragraph used to say
            // "the editor cannot produce this shape, so a blocker would only punish the API and the
            // importer at write time" — false on both counts. It IS a property of a saved rule, and
            // the editor CAN produce it: switching a saved schedule rule's Wait back to a delay
            // reaches exactly this shape without touching `monitor`/`parse`/`cond` at all (the
            // mode-switch path fixed alongside this comment). A validation rule holds for every
            // producer — the editor, the REST API, an import, an older build — so the guard lives in
            // `automation_validation.rs`, once, rather than in whichever producer happened to be
            // caught reasoning about this shape.
            //
            // **This skip stays anyway**, as the second-line, at-load gate `is_runnable` and
            // `pattern_refused_at_load` are beside it: it is what still catches a row that reached
            // this shape before the guard existed, or by writing to the database directly, and it is
            // what makes `report.live` an honest count for such a row. `watches` deliberately checks
            // only `monitor` rather than the wider `InputSteps::of`-shaped predicate validation now
            // uses — the editor writes the three input steps as one all-or-nothing group, so a
            // monitor without a parse or a cond is not a shape either producer can leave enabled once
            // §8's guard is in place, and widening this skip to match would be re-deriving a check
            // validation already owns.
            let watches = rule.graph.monitor.is_some();
            let scheduled =
                matches!(rule.graph.timer, Some(TimerStep { mode: TimerMode::DailyAt { .. } }));
            if !watches && !scheduled {
                report.skipped.push((
                    rule.id.clone(),
                    "this rule has nothing to watch and no schedule, so it can never run".into(),
                ));
                continue;
            }
            // **Both pattern gates apply only to a rule that HAS a pattern** (§6.4). A schedule
            // rule (§6.3) has no `parse` step at all — no pattern is not a broken pattern, and
            // refusing it here would make the whole of milestone 4 unreachable.
            //
            // It is admitted with `re: None`, never with a compiled `""`. `compile("")` SUCCEEDS
            // into an expression that matches every position of every string, which is why
            // `pattern_refused_at_load` refuses a blank pattern rather than merely an uncompilable
            // one — and the same reasoning forbids defaulting the absence here.
            let Some(pattern) = rule.graph.parse.as_ref().map(|p| p.find.clone()) else {
                next.insert(rule.id.clone(), Arc::new(LiveRule { rule, re: None }));
                continue;
            };
            // §2.7, and it is the SAME predicate the store's save gate exempts — see
            // `pattern_refused_at_load`. An empty pattern compiles and matches everything, so
            // "did it compile" was never the question this needed to ask.
            if let Some(why) = crate::automation_validation::pattern_refused_at_load(&pattern) {
                report.skipped.push((rule.id.clone(), why));
                continue;
            }
            match crate::automation_validation::compile(&pattern) {
                Ok(re) => {
                    fold_v1_clauses(&mut rule.graph, &re);
                    next.insert(rule.id.clone(), Arc::new(LiveRule { rule, re: Some(re) }));
                }
                Err(e) => {
                    report.skipped.push((
                        rule.id.clone(),
                        format!("that pattern could not be understood: {}", e.lines().next().unwrap_or(&e).trim()),
                    ));
                }
            }
        }

        // Whose keys survive. Read the previous generation BEFORE swapping, so "unchanged" is a
        // comparison and not a guess. The previous timer comes with it, for the day mark below.
        let previous: Vec<(String, i64, Option<TimerMode>)> = {
            let guard = self.live.read().unwrap_or_else(|e| e.into_inner());
            guard
                .iter()
                .map(|(id, l)| {
                    (id.clone(), l.rule.updated_at, l.rule.graph.timer.as_ref().map(|t| t.mode.clone()))
                })
                .collect()
        };
        let previously_live: HashSet<String> = previous.iter().map(|(id, _, _)| id.clone()).collect();
        let mut target_changed = HashSet::new();
        for (id, was, timer_was) in previous {
            let after = next.get(&id);
            if after.is_some_and(|l| l.rule.updated_at == was) {
                continue;
            }
            // **Captured before the purge, because the purge is what destroys it** — and the
            // re-seed below cannot reconstruct it: an absent mark and a target three hours past are
            // spelled identically, so it would decide the day had been missed and write *"09:00 went
            // by while nothing was watching the clock"* thirty minutes after the `Sent` row for that
            // same run. `Held` is Decision-class, so the verbose gate cannot drop that row, and with
            // `LOG_CAP` at 200 one editing session's worth of them evicts the rule's real history.
            //
            // Only for a rule that is still in the STORE with the same target minute: disabled and
            // completed rules still own their spent day, but a deleted rule has no store entry and
            // loses everything it owned. A moved minute is an instant today has not been spent on.
            // `schedule::same_target_minute` owns that judgement, mask included.
            let spent_mark = self.runtime.last_fired_mark(&id);
            let same_minute = schedule::same_target_minute(
                timer_was.as_ref(),
                store_timers.get(&id).and_then(|timer| timer.as_ref()),
            );
            // The changed target belongs to the new daily schedule, whether or not the old one
            // happened to have left a day mark. `same_target_minute` returns false for non-daily
            // modes too, but `seed_missed_schedules` can only act on a new `DailyAt` target.
            if !same_minute
                && after.is_some_and(|live| {
                    matches!(
                        live.rule.graph.timer.as_ref().map(|timer| &timer.mode),
                        Some(TimerMode::DailyAt { .. })
                    )
                })
            {
                target_changed.insert(id.clone());
            }
            self.runtime.forget_rule(&id);
            if same_minute {
                if let Some((day, minute)) = spent_mark {
                    self.runtime.set_last_fired_day(&id, day, minute);
                }
            }
        }

        // **After the forget loop, deliberately.** `forget_rule` drops everything a changed rule
        // owns, the day mark included, so a seed written before it would be wiped for a newly live
        // schedule or one whose target minute just changed. `None` means this eligible rule has no
        // last-observed instant: it joined the live set, so the whole of today up to `now_local` is
        // the unobserved window. A rule live on both sides of this reload was already observed and
        // must keep its pending occurrence for the evaluator tick.
        let seedable: Vec<&Arc<LiveRule>> = next
            .values()
            .filter(|live| {
                let id = &live.rule.id;
                // A reload only has an unobserved clock window for a schedule entering the live
                // set, for a changed daily target, or for a mark reconciliation that invalidated
                // its target. A mark spends only its own day: an older mark is deliberately kept
                // for the same minute, but cannot spend today's occurrence.
                has_unobserved_daily_window(
                    !previously_live.contains(id),
                    target_changed.contains(id),
                    invalidated_marks.contains(id),
                    self.runtime.last_fired_day(id),
                    now_local.day_ordinal,
                )
            })
            .collect();
        if !self.seed_missed_schedules(seedable, None, now_local, store, now_ms).is_empty() {
            report.emit = true;
        }

        report.live = next.len();
        *self.live.write().unwrap_or_else(|e| e.into_inner()) = next;

        for (rule_id, reason) in &report.skipped {
            let entry = AutomationLogEntry {
                id: 0,
                rule_id: rule_id.clone(),
                terminal_id: None,
                terminal_name: None,
                kind: LogKind::Failed,
                detail: reason.clone(),
                at: now_ms,
            };
            if let Ok(Some(_)) = store.append(&entry) {
                report.emit = true;
            }
        }
        Ok(report)
    }

    /// **A schedule whose minute has already passed is marked as fired today** (§6.3) — for every
    /// rule handed in, and it is deliberately ONE function with two callers.
    ///
    /// `schedule_due` compares `now >= target`, so an absent day mark and a target three hours in
    /// the past are *the process was not watching when the minute went by* and *the minute is going
    /// by right now*, spelled identically. This seeding is the only thing that tells them apart:
    /// an app STARTED at 14:00 does not deliver a 09:00 prompt on arrival, while an app RUNNING
    /// across 09:00 has no seed for today and fires. Firing a missed prompt late is the "nagging on
    /// arrival" behaviour plan 028 Q3 already ruled against for arm state, and without this the
    /// `>=` that keeps a spring-forward schedule alive would also deliver every schedule the app
    /// was closed for.
    ///
    /// **Two callers, one implementation.** `reload_at` runs it over the map it has just built, at
    /// process start and after every store commit; [`loops::evaluator_step`] runs it over
    /// `snapshot_live()` when the wall clock jumps, which is what a laptop lid closing at 18:00 and
    /// opening at 10:00 the next morning looks like from inside the tick. Those are the same
    /// premise — *nothing was observing the tick while the minute passed* — so a second copy of
    /// "is this rule's target already past" would be two answers to one question.
    ///
    /// **`since_local` is what the two callers do NOT share, and it is why the question is
    /// [`schedule::target_missed_since`] rather than "is the target in the past".** A load has no
    /// last-observed instant — `None`, and the whole day up to now is unobserved. A resume has one,
    /// exactly: `prev_tick_ms`, the iteration before the gap. A target that arrives at or after that
    /// resume instant was missed by nobody, and suppressing it spends the day at the very instant the
    /// rule came due.
    ///
    /// **It writes a log row for every day it actually spends** (§7). Suppressing the prompt is the
    /// right behaviour and it is also completely invisible: the user set a 09:00 reminder, it did
    /// not arrive, and until this row there was nothing anywhere that said why — the shape
    /// `absence-is-invisible-derive-the-check` names, and the shape this crate already refuses for
    /// a rule refused at load (`report.skipped`, a row each) and for a crossing that decided not to
    /// send (`held`).
    ///
    /// **The row is narrower than the seed, and deliberately.** `target_already_past` ignores the
    /// weekday mask, because seeding a day the rule was never going to run on costs nothing; saying
    /// *"today's 09:00 went by"* about a Sunday on a weekdays-only rule would be a false sentence.
    /// So the row is gated on [`schedule::schedule_due`] against the mark as it stands — *would
    /// this rule have fired, right now, if nothing had spent the day* — which also bounds it:
    /// once the mark is today the predicate is false, so a second pass over the same rule on the
    /// same day writes nothing. At most one row per rule per suppression, and `seed_missed_schedules`
    /// is never on the tick's own path — only a load, a commit, and a wake.
    ///
    /// Returns the ids `automation:activity` is due for; the caller emits, because this type holds
    /// no `AppHandle` (the same split `append` makes in `loops.rs`).
    pub(crate) fn seed_missed_schedules<'a>(
        &self,
        rules: impl IntoIterator<Item = &'a Arc<LiveRule>>,
        since_local: Option<schedule::LocalTime>,
        now_local: schedule::LocalTime,
        store: &AutomationStore,
        now_ms: i64,
    ) -> Vec<String> {
        let mut emit_for: Vec<String> = Vec::new();
        for live in rules {
            if let Some(TimerStep { mode: mode @ TimerMode::DailyAt { minute_of_day, .. } }) =
                &live.rule.graph.timer
            {
                if !schedule::target_missed_since(mode, since_local, now_local) {
                    continue;
                }
                let suppressing =
                    schedule::schedule_due(mode, self.runtime.last_fired_day(&live.rule.id), now_local);
                self.runtime.set_last_fired_day(&live.rule.id, now_local.day_ordinal, *minute_of_day);
                if !suppressing {
                    continue;
                }
                // `Held` and not `Failed`: nothing went wrong. This is the same class of answer as
                // *"`FAILED` is still on screen"* — the rule was asked, and the rule declined —
                // which is also what keeps it out of the verbose gate (`Held` is Decision-class), so
                // the one row explaining a missing prompt cannot be dropped by a setting.
                //
                // Rule-level, so no `terminal_id` and no name: `schedule_due` takes no terminal, and
                // a schedule's suppression is a fact about the clock rather than about any pane.
                let entry = AutomationLogEntry {
                    id: 0,
                    rule_id: live.rule.id.clone(),
                    terminal_id: None,
                    terminal_name: None,
                    kind: LogKind::Held,
                    // **Neither "while TermFlow was closed" nor "next runs tomorrow".** The first
                    // is false on the wake path — the app was running, the machine was not — and
                    // the second is a claim this function cannot support: a weekdays rule
                    // suppressed on a Friday next runs on Monday, and nothing here consults the
                    // mask. What both callers share is exactly the premise the seeding is built
                    // on, so that is what it says.
                    detail: format!(
                        "{} went by while nothing was watching the clock, so today's run was skipped",
                        Self::schedule_target_words(mode)
                    ),
                    at: now_ms,
                };
                if let Ok(Some(outcome)) = store.append(&entry) {
                    if outcome.emit {
                        emit_for.extend(outcome.rule_ids);
                    }
                }
            }
        }
        emit_for
    }

    /// The time of day a schedule aims at, in the words the suppression row uses.
    ///
    /// A `DailyAt` is the only mode that reaches the row — `target_already_past` is false for
    /// `AfterMatch` — so the other arm is unreachable rather than meaningful, and it answers with
    /// the neutral noun rather than inventing a clock time for a mode that has none.
    fn schedule_target_words(mode: &TimerMode) -> String {
        match mode {
            TimerMode::DailyAt { minute_of_day, .. } => schedule::clock_time(*minute_of_day),
            TimerMode::AfterMatch { .. } => "this rule's time".to_string(),
        }
    }

    /// R6, as an in-memory event first and a row second (§7.8).
    ///
    /// A `runs_once` rule that has fired must never reach `next_state` again — **in this session**,
    /// not merely after the next reload. `reload` runs from mutating store COMMANDS, and completion
    /// is raised by the engine, which is not a command: without this the rule stayed live with arm
    /// state `Fired`, and the moment its value dropped it re-armed and the next crossing sent a
    /// SECOND message from a row the UI already showed as *Completed*.
    ///
    /// It deliberately does not purge `echoes`: those are keyed by terminal alone, by §2.6's ruling,
    /// precisely so overlapping rules recognise each other's injections — so they are not this rule's
    /// to drop. (§7.8's list says "arm / echoes / last_eval_ms", which predates that ruling.)
    pub fn complete_rule(&self, rule_id: &str) {
        self.live.write().unwrap_or_else(|e| e.into_inner()).remove(rule_id);
        self.runtime.forget_rule(rule_id);
    }

    /// The runtime object every row's pill reads (§7.2), for both the event and first paint.
    ///
    /// One function behind both, so `automation:state` and `get_automation_runtime()` cannot disagree
    /// — §10.18d asserts they agree, and the cheapest way to make that true is to give them nothing
    /// to disagree with.
    pub fn state_payload(&self, missing: &HashMap<String, HashSet<String>>) -> StatePayload {
        let empty = HashSet::new();
        let mut rules = HashMap::new();
        for live in self.snapshot_live() {
            let id = &live.rule.id;
            let missing_for = missing.get(id).unwrap_or(&empty);
            // **A rule that has never been resolved is absent, not a rule watching nothing.**
            //
            // The row treats these as opposite: an absent rule is `waiting` ("the engine has not
            // reported this rule"), an empty one is the *Nothing to watch* error ("running, and
            // nothing matches"). Every live rule was reported here from the moment it went live,
            // and `watched_for` returns an empty set for a rule the targeting loop has not reached
            // yet — so between a reload and the next targeting pass, up to `TARGETING_TICK_MS`,
            // every rule-mode rule claimed nothing matched it.
            //
            // That window opens on the two occasions a user is most likely to be looking: app
            // start, and the reload that follows their own save. Saving a `Command contains` rule
            // with a matching terminal already open showed *"No open terminal matches ..."* for two
            // seconds, and the pill was `Error` while it did.
            //
            // `missing` is parked by the same pass, so it cannot be present while `watched` is
            // absent — but reporting the rule when it somehow is loses nothing, and hiding a known
            // missing terminal would.
            if !self.runtime.has_resolved(id) && missing_for.is_empty() {
                continue;
            }
            let watched = self.runtime.watched_for(id);
            let mut pairs = HashMap::new();
            for tm in watched.iter().chain(missing_for.iter()) {
                let (fired_count, last_fired_at) = match self.runtime.fire_record(id, tm) {
                    Some((n, at)) => (n, Some(at)),
                    None => (0, None),
                };
                pairs.insert(
                    tm.clone(),
                    RuntimePairState {
                        state: arm_word(self.runtime.arm_state(id, tm)).to_string(),
                        last_fired_at,
                        fired_count,
                        missing: missing_for.contains(tm),
                        // §7's `pending`. Read for EVERY pair rather than only for a rule whose
                        // timer is `AfterMatch`: the map is the authority on what is parked, and a
                        // second reading of the graph here would be a rule the drain does not make.
                        parked_at: self.runtime.parked_at(id, tm),
                    },
                );
            }
            rules.insert(id.clone(), pairs);
        }
        StatePayload { rules }
    }
}

/// The arm machine's own three states, lowercased, as §7.2's DTO spells them.
///
/// `Armed { seen_fire }` collapses to one word on purpose: `seen_fire` is a read-depth detail
/// (§2.2c), not something a row pill has any business showing.
fn arm_word(state: ArmState) -> &'static str {
    match state {
        ArmState::Unseen => "unseen",
        ArmState::Armed { .. } => "armed",
        ArmState::Fired { .. } => "fired",
    }
}

impl Default for AutomationEngine {
    fn default() -> Self {
        Self::new(0)
    }
}

#[cfg(test)]
mod tests;
