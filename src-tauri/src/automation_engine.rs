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
    /// clock through `schedule::local_now`, the one conversion in the crate.
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
            let spent_day = self.runtime.last_fired_day(&id);
            let same_minute = schedule::same_target_minute(
                timer_was.as_ref(),
                store_timers.get(&id).and_then(|timer| timer.as_ref()),
            );
            self.runtime.forget_rule(&id);
            if same_minute {
                if let Some(day) = spent_day {
                    self.runtime.set_last_fired_day(&id, day);
                }
            }
        }

        // **After the forget loop, deliberately.** `forget_rule` drops everything a changed rule
        // owns, the day mark included, so a seed written before it would be wiped for exactly the
        // rules that need it most — a rule saved at 14:00 is re-seeded here and does not fire on
        // the next tick. Reading `next` rather than the live map keeps it one pass, before the swap.
        // `None`: a load has no last-observed instant. Nothing was watching this rule's clock before
        // the process started, or before this commit put the rule in the live set, so the whole of
        // today up to `now_local` is the unobserved window.
        if !self.seed_missed_schedules(next.values(), None, now_local, store, now_ms).is_empty() {
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
            if let Some(TimerStep { mode }) = &live.rule.graph.timer {
                if !schedule::target_missed_since(mode, since_local, now_local) {
                    continue;
                }
                let suppressing =
                    schedule::schedule_due(mode, self.runtime.last_fired_day(&live.rule.id), now_local);
                self.runtime.set_last_fired_day(&live.rule.id, now_local.day_ordinal);
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
            let watched = self.runtime.watched_for(id);
            let missing_for = missing.get(id).unwrap_or(&empty);
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
mod tests {
    use super::*;
    use crate::automation_engine::eval::ArmState;
    use crate::automation_store::{
        ActionStep, AutomationGraph, Cadence, Clause, CompareOp, CondStep, Criterion, Finds, Keep,
        LogOrder, LogScope, MonitorStep, ParsePreset, ParseStep, ReadMode, SendTo, Source,
        TargetMode, Test, TextOp, SUPPORTED_SCHEMA_VERSION,
    };

    fn rule(id: &str, find: &str) -> AutomationRule {
        AutomationRule {
            id: id.to_string(),
            name: format!("rule {}", id),
            enabled: true,
            runs_once: false,
            target_mode: TargetMode::Pinned,
            criterion: Criterion::AllTerminals,
            criterion_value: String::new(),
            follow_new: true,
            target_ids: vec!["tm-1".to_string()],
            completed_at: None,
            verbose_until: None,
            sort_order: 1,
            schema_version: SUPPORTED_SCHEMA_VERSION,
            graph: AutomationGraph {
                layout: None,
                timer: None,
                monitor: Some(MonitorStep {
                    read: ReadMode::NewOutput,
                    cadence: Cadence::OnOutput,
                    every_ms: 0,
                }),
                parse: Some(ParseStep {
                    preset: ParsePreset::Custom,
                    literal: None,
                    find: find.to_string(),
                    keep: Keep::Brackets,
                }),
                cond: Some(CondStep {
                    finds: Finds::Reading,
                    op: Some(CompareOp::Gt),
                    threshold: Some(25.0),
                    ..Default::default()
                }),
                action: ActionStep {
                    message: "prepare to do context-hand-off".to_string(),
                    send_to: SendTo::Matched,
                    submit: true,
                    cli_type: "default".to_string(),
                    substitute: false,
                },
            },
            created_at: 1_000,
            updated_at: 1_000,
        }
    }

    /// A v1 rule's graph: `op`/`threshold` set, `clauses` empty — built on the existing `rule()`
    /// fixture rather than a parallel one, varying only what the table test needs to vary.
    fn v1_graph(finds: Finds, keep: Keep, pattern: &str) -> AutomationGraph {
        let mut g = rule("au-v1", pattern).graph;
        g.cond_mut().finds = finds;
        g.parse_mut().keep = keep;
        g
    }

    /// A v2 rule that already has clauses — folding must leave it alone.
    fn v2_graph_with_two_clauses() -> AutomationGraph {
        let mut g = rule("au-v2", "x").graph;
        g.cond_mut().clauses = vec![
            Clause {
                source: Source::Whole,
                test: Test::Text { op: TextOp::Contains, value: "err".into() },
            },
            Clause { source: Source::Group(1), test: Test::Number { op: CompareOp::Gt, value: Some(1.0) } },
        ];
        g
    }

    // -----------------------------------------------------------------------------------------
    // §5.4 — folding a v1 rule into the clause list it always meant
    // -----------------------------------------------------------------------------------------

    /// The three branches of `extract()`'s `keep` handling, as a table — the mapping is the
    /// whole point, and testing one row would leave two silently wrong.
    #[test]
    fn v1_rules_fold_into_the_clause_list_exactly_as_extract_chose() {
        for (finds, keep, pattern, want) in [
            (Finds::Reading, Keep::Brackets, r"ctx:(?P<value>\d+)%", Some(Source::Named("value".into()))),
            (Finds::Reading, Keep::Brackets, r"ctx:(\d+)%", Some(Source::Group(1))),
            (Finds::Reading, Keep::Whole, r"ctx:\d+%", Some(Source::Whole)),
            (Finds::Event, Keep::Brackets, r"API error (\d+)", None),
        ] {
            let mut g = v1_graph(finds, keep, pattern);
            fold_v1_clauses(&mut g, &Regex::new(pattern).unwrap());
            match want {
                Some(src) => {
                    assert_eq!(g.cond_ref().clauses.len(), 1, "{pattern}");
                    assert_eq!(g.cond_ref().clauses[0].source, src, "{pattern}");
                }
                None => assert!(
                    g.cond_ref().clauses.is_empty(),
                    "a word rule folds to ZERO clauses — the empty list IS 'fire on the match'"
                ),
            }
        }
    }

    #[test]
    fn folding_does_not_touch_a_rule_that_already_has_clauses() {
        let mut g = v2_graph_with_two_clauses();
        let before = g.cond_ref().clauses.clone();
        fold_v1_clauses(&mut g, &Regex::new("x").unwrap());
        assert_eq!(g.cond_ref().clauses, before);
    }

    fn live_ids(engine: &AutomationEngine) -> Vec<String> {
        engine.snapshot_live().iter().map(|l| l.rule.id.clone()).collect()
    }

    fn log_rows(store: &AutomationStore) -> Vec<String> {
        store
            .load_automation_log(&LogScope::All, LogOrder::Asc, 100)
            .unwrap()
            .into_iter()
            .map(|e| e.detail)
            .collect()
    }

    // -----------------------------------------------------------------------------------------
    // §7.3 — the rule source
    // -----------------------------------------------------------------------------------------

    /// What reaches the live set, as a LIST: every reason a rule is refused, and the one reason it is
    /// refused SILENTLY. A filter tested with one rule cannot show which rules it kept.
    #[test]
    fn reload_runs_the_runnable_rules_and_says_why_it_refused_the_rest() {
        let store = AutomationStore::new_in_memory();
        store.save_rule(&rule("au-live", r"ctx:(\d+)%")).unwrap();

        let mut off = rule("au-off", r"ctx:(\d+)%");
        off.enabled = false;
        store.save_rule(&off).unwrap();

        let mut done = rule("au-done", r"ctx:(\d+)%");
        done.completed_at = Some(5);
        store.save_rule(&done).unwrap();

        let mut future = rule("au-future", r"ctx:(\d+)%");
        future.schema_version = SUPPORTED_SCHEMA_VERSION + 1;
        store.save_rule(&future).unwrap();

        store.save_rule(&rule("au-bad", r"ctx:(\d+%")).unwrap();

        let engine = AutomationEngine::new(0);
        let report = engine.reload(&store, 7_000).unwrap();

        assert_eq!(live_ids(&engine), vec!["au-live"]);
        assert_eq!(report.live, 1);
        assert!(report.emit, "a refusal the user must see is worth an activity event");

        // In `list_rules` order (`ORDER BY sort_order, id`), which is the order the log rows land in.
        let reasons: Vec<String> = report.skipped.iter().map(|(id, _)| id.clone()).collect();
        assert_eq!(reasons, vec!["au-bad", "au-future"], "and ONLY these two are reported");

        let rows = log_rows(&store);
        assert_eq!(rows.len(), 2, "a disabled or completed rule is normal, not a failure: {:?}", rows);
        assert!(rows[0].contains("could not be understood"), "{}", rows[0]);
        assert!(rows[1].contains("needs a newer version"), "{}", rows[1]);
    }

    /// **A schedule rule has no pattern, and no pattern is not a broken pattern** (plan 032 §6.4).
    ///
    /// `reload` used to ask `pattern_refused_at_load(&graph.parse.find)` of every rule, and a rule
    /// with no parse step at all has no `find` to ask about — the first version of task 19 skipped
    /// it with a refusal row, because `LiveRule.re` was a mandatory `Regex`. It is optional now, so
    /// the two pattern gates apply only to a rule that HAS a pattern, and this rule runs.
    #[test]
    fn a_schedule_rule_with_no_pattern_is_admitted() {
        let store = AutomationStore::new_in_memory();
        store.save_rule(&crate::automation_engine::test_host::schedule_only_rule("au-sched")).unwrap();

        let engine = AutomationEngine::new(0);
        // **`reload_at` at 08:00, not `reload` at epoch 0, and the seam is load-bearing here.**
        // `reload` derives the local day from `now_ms`, and epoch 0 is 19:00 the previous evening
        // west of UTC and midnight on it — so this rule's 09:00 target is "already past" on a
        // CI runner in one zone and not in another, and the seeding then writes the §7 suppression
        // row on exactly half the world's machines. The assertion below is about a PATTERN, so it
        // is pinned to a morning where nothing is suppressed. `reload_at`'s own doc says this is
        // what the seam is for.
        let report = engine.reload_at(&store, 0, at(monday_2026_09_07(), 8 * 60)).unwrap();

        assert_eq!(report.live, 1, "no pattern is not a broken pattern");
        assert!(report.skipped.is_empty(), "{:?}", report.skipped);
        assert!(log_rows(&store).is_empty(), "and nothing was written to the log about it");
        assert_eq!(live_ids(&engine), vec!["au-sched"]);

        // The absence reaches the live set as an ABSENCE, never as a defaulted match-everything
        // pattern — which is what an `unwrap_or_default()` anywhere on this path would produce.
        let live = engine.snapshot_live();
        assert!(live[0].re.is_none(), "a rule with no pattern must carry no compiled regex");
    }

    /// **A rule with nothing to watch and no schedule is refused at load, and says so** — it must
    /// not be live-and-inert.
    ///
    /// Since §3.1 made the monitor step optional this shape passed validation, saved *enabled*,
    /// counted in `report.live` and was walked four times a second only to fall out at the
    /// evaluator's monitor guard: running by every reading the user has, and unable to fire. The
    /// same is true of `AfterMatch` with no monitor — a delay is parked at a crossing and there is
    /// nothing here that can cross.
    ///
    /// **Three rules, and the third is the point.** A refusal keyed on "no monitor" alone would
    /// take the whole of milestone 4 out with it, so the schedule rule is in the fixture to say
    /// that a `DailyAt` timer IS something to run on. `au-live` is here for the same reason a
    /// filter tested with one rule cannot show which rules it kept.
    ///
    /// **`inert` and `delayed` plant via the enable-gate bypass (R7 review).** `automation_validation`
    /// now refuses to save either shape *enabled* at all (`timer.neverRuns`), which is R7 closing
    /// this exact gap in the right layer — but this test is about `reload_at`'s OWN skip, the
    /// second-line gate for a row that reached the shape some other way (an older build, or a
    /// direct write), and that row has to exist in the store for the test to exercise it.
    #[test]
    fn a_rule_with_nothing_to_watch_and_no_schedule_is_skipped_with_a_reason() {
        let store = AutomationStore::new_in_memory();
        store.save_rule(&rule("au-live", r"ctx:(\d+)%")).unwrap();
        store.save_rule(&crate::automation_engine::test_host::schedule_only_rule("au-sched")).unwrap();

        let mut inert = rule("au-inert", r"ctx:(\d+)%");
        inert.graph.monitor = None;
        store.save_rule_bypassing_the_enable_gate_for_tests(&inert).unwrap();

        let mut delayed = rule("au-delay", r"ctx:(\d+)%");
        delayed.graph.monitor = None;
        delayed.graph.timer = Some(TimerStep { mode: TimerMode::AfterMatch { delay_ms: 30_000 } });
        store.save_rule_bypassing_the_enable_gate_for_tests(&delayed).unwrap();

        let engine = AutomationEngine::new(0);
        // 08:00, for `a_schedule_rule_with_no_pattern_is_admitted`'s reason: `au-sched` is a 09:00
        // rule, and a row count is only an oracle for refusals while nothing else is writing rows.
        let report = engine.reload_at(&store, 7_000, at(monday_2026_09_07(), 8 * 60)).unwrap();

        assert_eq!(
            live_ids(&engine),
            vec!["au-live", "au-sched"],
            "a schedule rule has no monitor either, and runs on the clock"
        );
        assert_eq!(report.live, 2, "`report.live` counts what can actually run");

        // In `list_rules` order (`ORDER BY sort_order, id`), which is the order the log rows land in.
        let skipped: Vec<String> = report.skipped.iter().map(|(id, _)| id.clone()).collect();
        assert_eq!(skipped, vec!["au-delay", "au-inert"]);
        for (id, why) in &report.skipped {
            assert_eq!(
                why, "this rule has nothing to watch and no schedule, so it can never run",
                "{id}"
            );
        }
        assert_eq!(log_rows(&store).len(), 2, "one row per load, per refused rule");
    }

    /// A Monday, as a local ordinal day. `schedule_only_rule`'s mask is Mon–Fri, so the rule this
    /// module seeds is one that genuinely could fire on the day the test names.
    fn monday_2026_09_07() -> i32 {
        use chrono::Datelike;
        let date = chrono::NaiveDate::from_ymd_opt(2026, 9, 7).expect("a real date");
        assert_eq!(date.weekday(), chrono::Weekday::Mon);
        date.num_days_from_ce()
    }

    fn at(day_ordinal: i32, minute_of_day: i32) -> schedule::LocalTime {
        schedule::LocalTime { day_ordinal, minute_of_day }
    }

    /// **The 09:00 prompt must not arrive at 14:00 because the app started late** (§6.3, plan 028 Q3).
    ///
    /// `schedule_due` compares `now >= target` — which is what keeps a spring-forward 02:30 schedule
    /// alive on a day with no 02:30 — and an absent day mark plus a target three hours in the past is
    /// spelled exactly like a crossing. The seeding in `reload` is the only thing that tells the two
    /// apart, so this asserts the pair TOGETHER: what `reload` left behind, handed to the predicate.
    /// Asserting `last_fired_day == Some(day)` alone would pass a seed the predicate ignored.
    #[test]
    fn a_schedule_missed_while_the_app_was_closed_does_not_fire_on_launch() {
        let store = AutomationStore::new_in_memory();
        let sched = crate::automation_engine::test_host::schedule_only_rule("au-sched");
        let TimerStep { mode } = sched.graph.timer.clone().expect("a schedule rule has a timer");
        store.save_rule(&sched).unwrap();

        let engine = AutomationEngine::new(0);
        let launch = at(monday_2026_09_07(), 14 * 60);
        engine.reload_at(&store, 0, launch).unwrap();

        assert_eq!(
            engine.runtime.last_fired_day("au-sched"),
            Some(launch.day_ordinal),
            "a 09:00 schedule loaded at 14:00 has already missed today"
        );
        assert!(
            !schedule::schedule_due(&mode, engine.runtime.last_fired_day("au-sched"), launch),
            "the prompt arrived on launch, five hours late"
        );
        // Tomorrow is a different day, and the rule is not broken — only today is spent.
        let tuesday = at(launch.day_ordinal + 1, 9 * 60);
        assert!(schedule::schedule_due(&mode, engine.runtime.last_fired_day("au-sched"), tuesday));
    }

    /// The other direction, and it is the one the seeding must not break: a schedule whose minute is
    /// still ahead at launch is left unmarked, and fires when the tick reaches it.
    #[test]
    fn a_schedule_still_ahead_at_launch_fires_when_its_minute_arrives() {
        let store = AutomationStore::new_in_memory();
        let sched = crate::automation_engine::test_host::schedule_only_rule("au-sched");
        let TimerStep { mode } = sched.graph.timer.clone().expect("a schedule rule has a timer");
        store.save_rule(&sched).unwrap();

        let engine = AutomationEngine::new(0);
        let monday = monday_2026_09_07();
        engine.reload_at(&store, 0, at(monday, 8 * 60)).unwrap();

        assert_eq!(engine.runtime.last_fired_day("au-sched"), None, "09:00 has not happened yet");
        assert!(schedule::schedule_due(&mode, engine.runtime.last_fired_day("au-sched"), at(monday, 9 * 60)));
    }

    /// **The seeding runs AFTER the forget loop, and this is what says so.**
    ///
    /// Saving a rule moves its `updated_at`, and `reload` drops everything that rule owns — the day
    /// mark included. Seeded before that loop, the mark would be wiped for exactly the rules that
    /// need it, and a schedule edited at 14:00 would deliver its 09:00 message on the next tick.
    #[test]
    fn a_schedule_edited_after_its_minute_is_re_seeded_rather_than_unmarked() {
        let store = AutomationStore::new_in_memory();
        let mut sched = crate::automation_engine::test_host::schedule_only_rule("au-sched");
        let TimerStep { mode } = sched.graph.timer.clone().expect("a schedule rule has a timer");
        store.save_rule(&sched).unwrap();

        let engine = AutomationEngine::new(0);
        let afternoon = at(monday_2026_09_07(), 14 * 60);
        engine.reload_at(&store, 0, afternoon).unwrap();

        // The user edits the rule's message and saves: `updated_at` moves, so `forget_rule` runs.
        sched.name = "renamed".into();
        sched.updated_at += 1;
        store.save_rule(&sched).unwrap();
        engine.reload_at(&store, 1_000, afternoon).unwrap();

        assert_eq!(engine.runtime.last_fired_day("au-sched"), Some(afternoon.day_ordinal));
        assert!(
            !schedule::schedule_due(&mode, engine.runtime.last_fired_day("au-sched"), afternoon),
            "an edit at 14:00 delivered the 09:00 message on the next tick"
        );
    }

    /// **An edit made after the rule has already fired must not write "today's run was skipped"** —
    /// that row is a lie, and it is written into the record the user consults to find out what the
    /// rule did.
    ///
    /// `reload` purges a changed rule's `last_fired_day` (the store stamps `updated_at` on EVERY
    /// save) and then re-seeds. The re-seed cannot tell *never fired today* from *fired today, the
    /// mark was just deleted*, so it decided the day had been missed: the app runs across 09:00 and
    /// sends, the user renames the rule at 09:30, and a `Held` row lands thirty minutes after the
    /// `Sent` row for that same run saying nothing was watching the clock. Every subsequent save
    /// wrote another one, and `Held` is Decision-class — the verbose gate cannot drop it — so with
    /// `LOG_CAP` at 200 the duplicates evict the rule's real history.
    ///
    /// **This asserts the ROWS, and that is the whole point.**
    /// `a_schedule_edited_after_its_minute_is_re_seeded_rather_than_unmarked` above asserts only the
    /// mark, which is exactly how this got through: the re-seed restores the same mark the fire
    /// left, so the mark is right and the log is wrong.
    #[test]
    fn a_schedule_renamed_after_it_fired_writes_no_suppression_row() {
        let store = AutomationStore::new_in_memory();
        let mut sched = crate::automation_engine::test_host::schedule_only_rule("au-sched");
        store.save_rule(&sched).unwrap();

        let engine = AutomationEngine::new(0);
        let monday = monday_2026_09_07();
        // 08:00: the app is running BEFORE the minute, so nothing is seeded and nothing is said.
        engine.reload_at(&store, 0, at(monday, 8 * 60)).unwrap();
        assert_eq!(engine.runtime.last_fired_day("au-sched"), None, "premise: 09:00 is still ahead");

        // 09:00 arrives and the rule fires. `evaluate_tick` marks the day after the leaves and
        // `run_send` writes the `Sent` row; both are reproduced here rather than driven through the
        // loop, which needs a host this module has no business wiring for a `reload` test.
        engine.runtime.set_last_fired_day("au-sched", monday);
        store
            .append(&AutomationLogEntry {
                id: 0,
                rule_id: "au-sched".into(),
                terminal_id: Some("tm-1".into()),
                terminal_name: Some("shell".into()),
                kind: LogKind::Sent,
                detail: "sent to shell".into(),
                at: 1_000,
            })
            .unwrap();

        // 09:30, and the user only renames it: same minute, same days.
        sched.name = "morning stand-up".into();
        sched.updated_at += 1;
        store.save_rule(&sched).unwrap();
        let report = engine.reload_at(&store, 2_000, at(monday, 9 * 60 + 30)).unwrap();

        let rows = store
            .load_automation_log(&crate::automation_store::LogScope::All, LogOrder::Asc, 100)
            .unwrap();
        assert_eq!(rows.len(), 1, "the rename wrote a row about a run that happened: {rows:?}");
        assert_eq!(rows[0].kind, LogKind::Sent, "the `Sent` row is still the last word: {rows:?}");
        assert!(!report.emit, "no row was written, so no window has anything to refetch");
        assert_eq!(
            engine.runtime.last_fired_day("au-sched"),
            Some(monday),
            "and the day is still spent, so the rename cannot send a second message today"
        );
    }

    /// Disabling stops the live rule but does not un-spend the schedule instant it already ran.
    #[test]
    fn a_schedule_re_enabled_after_it_fired_writes_no_suppression_row_or_second_send() {
        let store = AutomationStore::new_in_memory();
        let sched = crate::automation_engine::test_host::schedule_only_rule("au-sched");
        let TimerStep { mode } = sched.graph.timer.clone().expect("a schedule rule has a timer");
        store.save_rule(&sched).unwrap();

        let engine = AutomationEngine::new(0);
        let monday = monday_2026_09_07();
        engine.reload_at(&store, 0, at(monday, 8 * 60)).unwrap();
        engine.runtime.set_last_fired_day("au-sched", monday);
        store
            .append(&AutomationLogEntry {
                id: 0,
                rule_id: "au-sched".into(),
                terminal_id: Some("tm-1".into()),
                terminal_name: Some("shell".into()),
                kind: LogKind::Sent,
                detail: "sent to shell".into(),
                at: 1_000,
            })
            .unwrap();

        store.set_enabled_checked("au-sched", false).unwrap();
        engine.reload_at(&store, 2_000, at(monday, 9 * 60 + 30)).unwrap();

        store.set_enabled_checked("au-sched", true).unwrap();
        let report = engine.reload_at(&store, 3_000, at(monday, 9 * 60 + 35)).unwrap();

        let rows = store
            .load_automation_log(&crate::automation_store::LogScope::All, LogOrder::Asc, 100)
            .unwrap();
        assert_eq!(rows.len(), 1, "re-enabling wrote a false suppression row: {rows:?}");
        assert_eq!(rows[0].kind, LogKind::Sent, "the sent row is still the last word: {rows:?}");
        assert!(!report.emit, "no row was written, so no window has anything to refetch");
        assert_eq!(engine.runtime.last_fired_day("au-sched"), Some(monday));
        assert!(
            !schedule::schedule_due(&mode, engine.runtime.last_fired_day("au-sched"), at(monday, 9 * 60 + 35)),
            "re-enabling allowed a second send today"
        );
    }

    #[test]
    fn a_deleted_schedule_loses_its_spent_day() {
        let store = AutomationStore::new_in_memory();
        let sched = crate::automation_engine::test_host::schedule_only_rule("au-sched");
        store.save_rule(&sched).unwrap();

        let engine = AutomationEngine::new(0);
        let monday = monday_2026_09_07();
        engine.reload_at(&store, 0, at(monday, 8 * 60)).unwrap();
        engine.runtime.set_last_fired_day("au-sched", monday);

        assert!(store.delete_rule("au-sched").unwrap());
        engine.reload_at(&store, 1_000, at(monday, 9 * 60 + 30)).unwrap();
        assert_eq!(engine.runtime.last_fired_day("au-sched"), None, "a deleted rule retained engine state");
    }

    /// **Moving the schedule to a different minute is a NEW schedule, and it may fire today.**
    ///
    /// The discriminator for keeping the day mark is *did the target minute move*, not *did the rule
    /// change*: a rename leaves today's target instant exactly where it was and therefore spent,
    /// while a move puts it somewhere the day has not been spent on. This is the direction
    /// "always preserve" gets wrong — a 09:00 rule moved to 17:00 at 09:30 must ring at 17:00.
    #[test]
    fn a_schedule_moved_to_a_later_minute_fires_at_the_new_time_today() {
        let store = AutomationStore::new_in_memory();
        let mut sched = crate::automation_engine::test_host::schedule_only_rule("au-sched");
        store.save_rule(&sched).unwrap();

        let engine = AutomationEngine::new(0);
        let monday = monday_2026_09_07();
        engine.reload_at(&store, 0, at(monday, 8 * 60)).unwrap();
        engine.runtime.set_last_fired_day("au-sched", monday);

        // 09:30: the user drags the time to 17:00.
        sched.graph.timer = Some(TimerStep {
            mode: TimerMode::DailyAt { minute_of_day: 17 * 60, days: 0b0001_1111 },
        });
        sched.updated_at += 1;
        store.save_rule(&sched).unwrap();
        engine.reload_at(&store, 2_000, at(monday, 9 * 60 + 30)).unwrap();

        assert_eq!(
            engine.runtime.last_fired_day("au-sched"),
            None,
            "17:00 has not gone by today, so nothing has spent it"
        );
        let TimerStep { mode } = sched.graph.timer.clone().expect("a schedule rule has a timer");
        assert!(
            schedule::schedule_due(
                &mode,
                engine.runtime.last_fired_day("au-sched"),
                at(monday, 17 * 60)
            ),
            "the rule was moved to 17:00 and then refused to ring at 17:00"
        );
    }

    /// **Changing only the WEEKDAYS keeps the day mark** — and this is where the ruling this branch
    /// shipped differs from the one it was handed.
    ///
    /// The brief's discriminator was *did the timer change*, which takes the mask with it. But
    /// today's target instant is the `minute_of_day` alone: a Monday 09:00 that has already run is
    /// spent whatever the mask is edited to at 09:30, so clearing the mark on a mask edit re-creates
    /// the exact false row this fix exists to remove — *"09:00 went by while nothing was watching"*,
    /// about a 09:00 that ran. The mask is consulted by `schedule_due` on every future day anyway,
    /// so keeping the mark costs it nothing.
    ///
    /// The price is named rather than hidden: a user who adds TODAY's weekday to the mask after the
    /// minute has passed gets silence rather than a row explaining it — the same silence a rule
    /// whose day was seeded on a masked-out morning already gets, and the direction the brief itself
    /// calls safe (a missed extra send beats a false row).
    #[test]
    fn a_schedule_whose_weekdays_changed_keeps_the_day_it_already_spent() {
        let store = AutomationStore::new_in_memory();
        let mut sched = crate::automation_engine::test_host::schedule_only_rule("au-sched");
        store.save_rule(&sched).unwrap();

        let engine = AutomationEngine::new(0);
        let monday = monday_2026_09_07();
        engine.reload_at(&store, 0, at(monday, 8 * 60)).unwrap();
        engine.runtime.set_last_fired_day("au-sched", monday);

        // 09:30: Mon-Fri becomes every day. Same minute; today has still run.
        sched.graph.timer = Some(TimerStep {
            mode: TimerMode::DailyAt { minute_of_day: 9 * 60, days: 0b0111_1111 },
        });
        sched.updated_at += 1;
        store.save_rule(&sched).unwrap();
        let report = engine.reload_at(&store, 2_000, at(monday, 9 * 60 + 30)).unwrap();

        assert_eq!(
            engine.runtime.last_fired_day("au-sched"),
            Some(monday),
            "adding a weekday does not un-run this morning"
        );
        assert!(!report.emit);
        assert!(
            log_rows(&store).is_empty(),
            "a mask edit said this morning was skipped: {:?}",
            log_rows(&store)
        );
    }

    /// **A spent day says so, once** (§7) — otherwise the suppression is a silent absence.
    ///
    /// The behaviour above is right and completely invisible: the user set a 09:00 reminder, it did
    /// not arrive, and until this row there was nothing anywhere that named the reason. That is the
    /// shape `absence-is-invisible-derive-the-check` is about, and the one this crate already
    /// refuses for a rule refused at load and for a crossing that declined to send.
    ///
    /// **Three loads, one row.** The bound is the assertion, not a comment: the row is gated on
    /// `schedule_due` against the mark as it stands, so once the day is spent the predicate is
    /// false and a second load writes nothing. Without that gate every launch, and every
    /// `reload_after_commit` a Settings edit makes, would add a row for the same spent day.
    #[test]
    fn a_schedule_missed_while_the_app_was_closed_says_so_in_the_log_exactly_once() {
        let store = AutomationStore::new_in_memory();
        store
            .save_rule(&crate::automation_engine::test_host::schedule_only_rule("au-sched"))
            .unwrap();

        let engine = AutomationEngine::new(0);
        let launch = at(monday_2026_09_07(), 14 * 60);
        let report = engine.reload_at(&store, 5_000, launch).unwrap();
        assert!(report.emit, "a row was written, so the windows must be told to refetch the log");

        let rows = store
            .load_automation_log(&crate::automation_store::LogScope::All, LogOrder::Asc, 100)
            .unwrap();
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!(rows[0].kind, LogKind::Held, "nothing failed — the rule declined: {rows:?}");
        assert_eq!(
            rows[0].detail,
            "09:00 went by while nothing was watching the clock, so today's run was skipped"
        );
        assert_eq!(rows[0].terminal_id, None, "a schedule's suppression names no terminal");
        assert_eq!(rows[0].at, 5_000);

        // Two more loads of the same spent day. `reload_after_commit` runs on every definition
        // write, so an ungated row would make one Settings session a wall of identical lines.
        engine.reload_at(&store, 6_000, launch).unwrap();
        let later = engine.reload_at(&store, 7_000, at(launch.day_ordinal, 23 * 60)).unwrap();
        assert!(!later.emit, "a day already spent was reported again");
        assert_eq!(
            store
                .load_automation_log(&crate::automation_store::LogScope::All, LogOrder::Asc, 100)
                .unwrap()
                .len(),
            1,
            "one row per suppression, not one per load"
        );
    }

    /// **The row is narrower than the seed, and this is the difference.**
    ///
    /// `target_already_past` ignores the weekday mask on purpose — marking a day the rule was never
    /// going to run on costs nothing and keeps the seed a fact about the CLOCK. A row does not have
    /// that freedom: *"09:00 went by, so today's run was skipped"* is simply false about a Sunday on
    /// a weekdays-only rule, which never had a run today to skip. Gating the row on `schedule_due`
    /// rather than on the seed's own predicate is what keeps the sentence true.
    #[test]
    fn a_day_the_schedule_never_ran_on_is_seeded_silently() {
        let store = AutomationStore::new_in_memory();
        store
            .save_rule(&crate::automation_engine::test_host::schedule_only_rule("au-sched"))
            .unwrap();

        let engine = AutomationEngine::new(0);
        // `schedule_only_rule` is Mon–Fri; 2026-09-07 is a Monday, so +6 is the Sunday after it.
        let sunday = at(monday_2026_09_07() + 6, 14 * 60);
        let report = engine.reload_at(&store, 5_000, sunday).unwrap();

        assert_eq!(
            engine.runtime.last_fired_day("au-sched"),
            Some(sunday.day_ordinal),
            "premise: the seed still runs — the row is what is narrower, not the mark"
        );
        assert!(!report.emit);
        assert!(
            store
                .load_automation_log(&crate::automation_store::LogScope::All, LogOrder::Asc, 100)
                .unwrap()
                .is_empty(),
            "a weekdays rule was told it had missed a Sunday"
        );
    }

    /// A schedule still ahead of the clock has missed nothing, and must not be told it has.
    #[test]
    fn a_schedule_still_ahead_at_launch_writes_no_row() {
        let store = AutomationStore::new_in_memory();
        store
            .save_rule(&crate::automation_engine::test_host::schedule_only_rule("au-sched"))
            .unwrap();

        let engine = AutomationEngine::new(0);
        engine.reload_at(&store, 5_000, at(monday_2026_09_07(), 8 * 60)).unwrap();

        assert!(
            store
                .load_automation_log(&crate::automation_store::LogScope::All, LogOrder::Asc, 100)
                .unwrap()
                .is_empty(),
            "09:00 has not happened yet, and the log said it had been missed"
        );
    }

    /// A delay rule has no day to seed: `AfterMatch` is parked at its crossing, not scheduled.
    #[test]
    fn an_after_match_rule_is_given_no_day() {
        let store = AutomationStore::new_in_memory();
        let mut delayed = rule("au-delay", r"ctx:(\d+)%");
        delayed.graph.timer =
            Some(TimerStep { mode: crate::automation_store::TimerMode::AfterMatch { delay_ms: 30_000 } });
        store.save_rule(&delayed).unwrap();

        let engine = AutomationEngine::new(0);
        engine.reload_at(&store, 0, at(monday_2026_09_07(), 23 * 60)).unwrap();

        assert_eq!(engine.runtime.last_fired_day("au-delay"), None);
    }

    /// §2.7: an uncompilable pattern is reported once per LOAD. The evaluator runs four times a second
    /// and this must not be a row each time — which is why compilation happens here at all.
    #[test]
    fn a_bad_pattern_is_reported_once_per_load_and_never_per_tick() {
        let store = AutomationStore::new_in_memory();
        store.save_rule(&rule("au-bad", r"ctx:(\d+%")).unwrap();
        let engine = AutomationEngine::new(0);

        engine.reload(&store, 1_000).unwrap();
        assert_eq!(log_rows(&store).len(), 1);

        // The rule is not live, and the live set is the only thing a tick walks — so nothing can
        // evaluate it and nothing else can write a row. `loops.rs` makes the same claim by running
        // eight REAL ticks over it, which is the half this test cannot reach from here.
        assert!(engine.snapshot_live().is_empty());
        assert_eq!(log_rows(&store).len(), 1, "still one row, and no tick can add another");

        // **An EMPTY pattern is refused here too, and that is not a widening — it is the defect.**
        // `compile("")` SUCCEEDS: an empty regex matches every position of every string. So a rule
        // stored with one used to be admitted, and a presence rule fired on the first byte any
        // terminal printed. "Uncompilable" was never the same set as "unusable"; the store's save gate
        // exempts exactly what this refuses, so the two cannot drift apart again.
        let store = AutomationStore::new_in_memory();
        store.save_rule(&rule("au-empty", "   ")).unwrap();
        let engine = AutomationEngine::new(0);

        let report = engine.reload(&store, 1_000).unwrap();

        assert!(engine.snapshot_live().is_empty(), "an empty pattern matches EVERYTHING and it ran");
        assert_eq!(report.skipped.len(), 1, "{:?}", report.skipped);
        assert!(report.skipped[0].1.contains("nothing to look for"), "{:?}", report.skipped);

        // A second LOAD does report it again — that is a new load, and the user asked for one.
        engine.reload(&store, 2_000).unwrap();
        assert_eq!(log_rows(&store).len(), 2);
    }

    /// §10.9b — **the reason this function is not "build a fresh map".**
    ///
    /// Two rules, both `Fired`. Disabling A must leave B exactly where it was. The easy implementation
    /// clears B's keys too, so every B pair becomes `Unseen`; settled decision 7 then makes an
    /// already-true condition count as a first sight, and **B goes silent until its next genuine
    /// crossing** — no log line, no state change, nothing on screen. And the other half, which is
    /// Q11: a rule the user EDITED does lose its keys, so an edit resets that rule's arm state.
    #[test]
    fn reload_preserves_the_arm_state_of_rules_it_did_not_change() {
        let store = AutomationStore::new_in_memory();
        store.save_rule(&rule("au-a", r"ctx:(\d+)%")).unwrap();
        store.save_rule(&rule("au-b", r"ctx:(\d+)%")).unwrap();
        let engine = AutomationEngine::new(0);
        engine.reload(&store, 1_000).unwrap();

        for id in ["au-a", "au-b"] {
            engine.runtime.set_arm(id, "tm-1", ArmState::Fired { at_ms: 500 });
            engine.runtime.set_last_eval(id, "tm-1", 500);
            engine.runtime.record_fire(id, "tm-1", 500);
            // All FOUR pair-keyed maps, arranged so the assertions below are not absence assertions
            // over keys that were never set. `last_decision` was added by a later round and purged at
            // all three sites without being asserted at any of them.
            engine.runtime.set_last_decision(id, "tm-1", crate::automation_engine::eval::Decision::Held);
        }

        // The user flips A off. B is untouched in the store.
        let mut off = rule("au-a", r"ctx:(\d+)%");
        off.enabled = false;
        off.updated_at = 2_000;
        store.save_rule(&off).unwrap();
        engine.reload(&store, 2_000).unwrap();

        assert_eq!(
            engine.runtime.arm_state("au-b", "tm-1"),
            ArmState::Fired { at_ms: 500 },
            "disabling one rule must not re-arm every other rule in the app"
        );
        assert_eq!(engine.runtime.last_eval("au-b", "tm-1"), Some(500));
        assert_eq!(engine.runtime.fire_record("au-b", "tm-1"), Some((1, 500)));
        assert_eq!(
            engine.runtime.last_decision("au-b", "tm-1"),
            Some(crate::automation_engine::eval::Decision::Held)
        );
        assert_eq!(
            engine.runtime.arm_state("au-a", "tm-1"),
            ArmState::Unseen,
            "and the rule that left the set does lose its keys"
        );
        assert_eq!(engine.runtime.last_eval("au-a", "tm-1"), None);
        assert_eq!(
            engine.runtime.fire_record("au-a", "tm-1"),
            None,
            "EVERY pair-keyed map, not just the one the assertion above happens to name"
        );
        assert_eq!(
            engine.runtime.last_decision("au-a", "tm-1"),
            None,
            "a stale decision makes the row that says the rule woke up read as a repeat, so the \
             verbose gate drops it"
        );

        // Q11: an EDIT to B resets B, and only B.
        engine.runtime.set_arm("au-b", "tm-1", ArmState::Fired { at_ms: 500 });
        let mut edited = rule("au-b", r"ctx:(\d+)%");
        edited.updated_at = 3_000;
        store.save_rule(&edited).unwrap();
        engine.reload(&store, 3_000).unwrap();
        assert_eq!(
            engine.runtime.arm_state("au-b", "tm-1"),
            ArmState::Unseen,
            "an edit resets that rule's arm state — Q11"
        );
    }

    /// A reload that changes nothing must change nothing. Without this the test above passes for an
    /// implementation that only preserves state when some OTHER rule changed.
    #[test]
    fn an_identical_reload_is_a_no_op_for_every_rule() {
        let store = AutomationStore::new_in_memory();
        store.save_rule(&rule("au-a", r"ctx:(\d+)%")).unwrap();
        let engine = AutomationEngine::new(0);
        engine.reload(&store, 1_000).unwrap();
        engine.runtime.set_arm("au-a", "tm-1", ArmState::Fired { at_ms: 500 });

        engine.reload(&store, 2_000).unwrap();
        assert_eq!(engine.runtime.arm_state("au-a", "tm-1"), ArmState::Fired { at_ms: 500 });
    }

    // -----------------------------------------------------------------------------------------
    // §7.8 — completion is an in-memory event first
    // -----------------------------------------------------------------------------------------

    /// The half of R6 that a reload-based test cannot see: a completed rule must leave the live set
    /// **in this session**, because `reload` runs from mutating store commands and completion is
    /// raised by the engine, which is not one.
    #[test]
    fn a_completed_rule_leaves_the_live_set_without_waiting_for_a_reload() {
        let store = AutomationStore::new_in_memory();
        store.save_rule(&rule("au-once", r"ctx:(\d+)%")).unwrap();
        store.save_rule(&rule("au-other", r"ctx:(\d+)%")).unwrap();
        let engine = AutomationEngine::new(0);
        engine.reload(&store, 1_000).unwrap();
        engine.runtime.set_arm("au-once", "tm-1", ArmState::Fired { at_ms: 5 });
        engine.runtime.set_arm("au-other", "tm-1", ArmState::Fired { at_ms: 5 });
        engine.runtime.set_watched("au-once", ["tm-1".to_string()].into());
        engine.runtime.push_echo("tm-1", "hand off now", 99_999);

        engine.complete_rule("au-once");

        assert_eq!(live_ids(&engine), vec!["au-other"]);
        assert!(!engine.is_live("au-once"));
        assert_eq!(engine.runtime.arm_state("au-once", "tm-1"), ArmState::Unseen);
        assert!(engine.runtime.watched_for("au-once").is_empty());
        assert_eq!(
            engine.runtime.arm_state("au-other", "tm-1"),
            ArmState::Fired { at_ms: 5 },
            "completing one rule must not disturb another"
        );
        assert_eq!(
            engine.runtime.echoes_for("tm-1", 0),
            vec!["hand off now".to_string()],
            "echo needles are the TERMINAL's, not the rule's — §2.6 keys them that way so overlapping              rules recognise each other's injections"
        );
    }

    // -----------------------------------------------------------------------------------------
    // §10.18d (local half) — the runtime object the row pills read
    // -----------------------------------------------------------------------------------------

    /// **Non-empty at first paint**, which is the whole point: `automationRowState` reads this, and an
    /// empty object paints *Armed · waiting, Never fired* for every row forever while nothing fails.
    #[test]
    fn the_state_payload_is_populated_before_anything_has_ever_fired() {
        let store = AutomationStore::new_in_memory();
        store.save_rule(&rule("au-a", r"ctx:(\d+)%")).unwrap();
        let engine = AutomationEngine::new(0);
        engine.reload(&store, 1_000).unwrap();
        engine
            .runtime
            .set_watched("au-a", ["tm-1".to_string(), "tm-2".to_string()].into());

        let payload = engine.state_payload(&HashMap::new());
        let pairs = payload.rules.get("au-a").expect("the live rule must appear");
        assert_eq!(pairs.len(), 2, "one entry per watched terminal, before any evaluation");
        let p = &pairs["tm-1"];
        assert_eq!(p.state, "unseen");
        assert_eq!(p.fired_count, 0);
        assert_eq!(p.last_fired_at, None);
        assert!(!p.missing);
    }

    /// Every field moves for the right reason — and `fired_count` survives a re-arm, which is what
    /// `arm` alone structurally cannot express.
    #[test]
    fn the_state_payload_reports_arm_state_fire_history_and_missing_separately() {
        let store = AutomationStore::new_in_memory();
        store.save_rule(&rule("au-a", r"ctx:(\d+)%")).unwrap();
        let engine = AutomationEngine::new(0);
        engine.reload(&store, 1_000).unwrap();
        engine
            .runtime
            .set_watched("au-a", ["tm-live".to_string(), "tm-gone".to_string()].into());

        engine.runtime.record_fire("au-a", "tm-live", 4_000);
        engine.runtime.record_fire("au-a", "tm-live", 9_000);
        engine.runtime.set_arm("au-a", "tm-live", ArmState::re_armed());

        let missing: HashMap<String, HashSet<String>> =
            [("au-a".to_string(), ["tm-gone".to_string()].into())].into();
        let payload = engine.state_payload(&missing);
        let pairs = &payload.rules["au-a"];

        let live = &pairs["tm-live"];
        assert_eq!(live.state, "armed", "re-armed is still `armed` to a row pill");
        assert_eq!(live.fired_count, 2, "the count must survive the re-arm that cleared `at_ms`");
        assert_eq!(live.last_fired_at, Some(9_000));
        assert!(!live.missing);

        let gone = &pairs["tm-gone"];
        assert!(gone.missing, "a pinned id that is not live is dormant, and says so");
        assert_eq!(gone.fired_count, 0);
    }

    /// **§7's `pending`: the parked deadline reaches the wire, per pair.**
    ///
    /// `parked_at` had exactly one reader before this — `runtime.rs`'s own tests — so a park was a
    /// fact the engine held and no window could see, and the row went on reading the ARM machine,
    /// which says `Fired` from the moment the crossing is decided and knows nothing about the wait
    /// that follows. That is the one-row-two-answers shape: *Fired · waiting to re-arm* over a
    /// message that has not been typed.
    ///
    /// Two terminals, because the field is pair-keyed and a one-terminal fixture cannot tell a
    /// per-pair deadline from a per-rule one.
    #[test]
    fn the_state_payload_carries_each_pair_s_parked_deadline() {
        let store = AutomationStore::new_in_memory();
        store.save_rule(&rule("au-a", r"ctx:(\d+)%")).unwrap();
        let engine = AutomationEngine::new(0);
        engine.reload(&store, 1_000).unwrap();
        engine
            .runtime
            .set_watched("au-a", ["tm-waiting".to_string(), "tm-idle".to_string()].into());

        engine.runtime.park(
            "au-a",
            "tm-waiting",
            crate::automation::runtime::ParkedSend {
                due_at_ms: 31_000,
                pc: "pc-1".to_string(),
                captures: None,
                prev: ArmState::Unseen,
                label: None,
            },
        );

        let pairs = &engine.state_payload(&HashMap::new()).rules["au-a"];
        assert_eq!(
            pairs["tm-waiting"].parked_at,
            Some(31_000),
            "the deadline the row counts down to never left the engine"
        );
        assert_eq!(
            pairs["tm-idle"].parked_at, None,
            "a pair with nothing parked must not inherit its sibling's countdown"
        );

        // And it goes away when the send is drained, rather than lingering as a countdown to a
        // moment that has passed.
        engine.runtime.take_parked_due("au-a", "tm-waiting", 31_000).expect("ripe");
        let after = &engine.state_payload(&HashMap::new()).rules["au-a"];
        assert_eq!(after["tm-waiting"].parked_at, None);
    }

    /// One function behind the event and behind first paint, so §10.18d's "they agree" is true by
    /// construction rather than by two implementations happening to match.
    #[test]
    fn the_event_payload_and_first_paint_are_the_same_function() {
        let store = AutomationStore::new_in_memory();
        store.save_rule(&rule("au-a", r"ctx:(\d+)%")).unwrap();
        let engine = AutomationEngine::new(0);
        engine.reload(&store, 1_000).unwrap();
        engine.runtime.set_watched("au-a", ["tm-1".to_string()].into());

        let a = engine.state_payload(&HashMap::new());
        let b = engine.state_payload(&HashMap::new());
        assert_eq!(
            serde_json::to_string(&a).unwrap(),
            serde_json::to_string(&b).unwrap()
        );
    }

    /// Launch must not look like shutdown, and `stop` must be the only thing that changes that.
    #[test]
    fn a_fresh_engine_is_not_stopping_until_it_is_stopped() {
        let engine = AutomationEngine::new(1_700_000_000_000);
        assert!(!engine.is_stopping(), "a fresh engine must not read as shutting down");
        engine.stop();
        assert!(engine.is_stopping());
        // Idempotent: `RunEvent::Exit` can fire more than once on some shutdown paths.
        engine.stop();
        assert!(engine.is_stopping());
    }

    /// The grace in §4.5 is measured from THIS process's engine start, so the value has to survive
    /// construction rather than being recomputed by whoever asks.
    #[test]
    fn the_engine_remembers_when_it_started() {
        assert_eq!(AutomationEngine::new(1_700_000_000_000).started_at_ms(), 1_700_000_000_000);
        assert_eq!(AutomationEngine::default().started_at_ms(), 0);
    }

    /// One runtime, reachable through the engine — `AppState` holds the engine, and
    /// `cleanup_terminal_state` reaches the maps through it. Two owners would be two lifetimes.
    #[test]
    fn the_engine_owns_the_one_runtime_every_caller_sees() {
        let engine = AutomationEngine::new(0);
        engine.runtime.set_arm("au-1", "tm-1", ArmState::Fired { at_ms: 5 });
        let shared = engine.runtime.clone();
        assert_eq!(shared.arm_state("au-1", "tm-1"), ArmState::Fired { at_ms: 5 });
        shared.forget_terminal("tm-1");
        assert_eq!(
            engine.runtime.arm_state("au-1", "tm-1"),
            ArmState::Unseen,
            "a clone of the Arc must be the same runtime, not a copy of it"
        );
    }
}
