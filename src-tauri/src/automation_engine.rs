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
pub mod eval;
pub mod host;
pub mod loops;

use regex::Regex;

use crate::automation::events::{RuntimePairState, StatePayload};
use crate::automation::runtime::AutomationRuntime;
use crate::automation_engine::eval::ArmState;
use crate::automation_store::{
    AutomationLogEntry, AutomationRule, AutomationStore, AutomationStoreError, LogKind,
};

/// One rule the engine is actually running: its definition, and its pattern compiled once at load.
///
/// Compiling per evaluation would recompile the same pattern four times a second per terminal, and
/// §2.7 wants an uncompilable pattern reported **once per load** rather than once per tick — which is
/// only expressible if compilation happens where "a load" is a thing that happens.
#[derive(Debug)]
pub struct LiveRule {
    pub rule: AutomationRule,
    pub re: Regex,
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
/// can set `stopping` before the synchronous log flush.
pub struct AutomationEngine {
    /// Standalone and `Arc`-shared, so every unit test targets it directly without an `AppHandle`
    /// (plan §7.10). `AppState` reaches it through this struct rather than holding a second `Arc`,
    /// which would be two owners of one lifetime.
    pub runtime: Arc<AutomationRuntime>,
    /// **The only stop signal.** The store has none and `state.exiting` is not read — that field's
    /// only reader is the `.swap()` inside `flush_then_exit`, making it a re-entrancy guard for one
    /// function rather than a general "shutting down" flag.
    ///
    /// Its **only writer is `lib.rs`'s `RunEvent::Exit`** (M3), which sets it and then performs the
    /// synchronous log flush. The three loops check it at the top of every iteration, and a send
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
}

impl AutomationEngine {
    pub fn new(started_at_ms: i64) -> Self {
        Self {
            runtime: Arc::new(AutomationRuntime::new()),
            stopping: Arc::new(AtomicBool::new(false)),
            live: RwLock::new(HashMap::new()),
            started_at_ms,
        }
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
        let rules = store.list_rules()?;
        let mut next: HashMap<String, Arc<LiveRule>> = HashMap::new();
        let mut report = ReloadReport::default();

        for rule in rules {
            if !rule.enabled || rule.completed_at.is_some() {
                continue;
            }
            if !rule.is_runnable() {
                report
                    .skipped
                    .push((rule.id.clone(), "this rule needs a newer version of TermFlow".into()));
                continue;
            }
            match crate::automation_validation::compile(&rule.graph.parse.find) {
                Ok(re) => {
                    next.insert(rule.id.clone(), Arc::new(LiveRule { rule, re }));
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
        // comparison and not a guess.
        let previous: Vec<(String, i64)> = {
            let guard = self.live.read().unwrap_or_else(|e| e.into_inner());
            guard.iter().map(|(id, l)| (id.clone(), l.rule.updated_at)).collect()
        };
        for (id, was) in previous {
            let unchanged = next.get(&id).is_some_and(|l| l.rule.updated_at == was);
            if !unchanged {
                self.runtime.forget_rule(&id);
            }
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
        ActionStep, AutomationGraph, Cadence, CompareOp, CondKind, CondStep, Criterion, Keep,
        LogOrder, LogScope, MonitorStep, ParsePreset, ParseStep, ReadMode, SendTo, TargetMode,
        SUPPORTED_SCHEMA_VERSION,
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
                monitor: MonitorStep {
                    read: ReadMode::NewOutput,
                    cadence: Cadence::OnOutput,
                    every_ms: 0,
                },
                parse: ParseStep {
                    preset: ParsePreset::Custom,
                    literal: None,
                    find: find.to_string(),
                    keep: Keep::Brackets,
                },
                cond: CondStep {
                    kind: CondKind::Number,
                    op: Some(CompareOp::Gt),
                    threshold: Some(25.0),
                },
                action: ActionStep {
                    message: "prepare to do context-hand-off".to_string(),
                    send_to: SendTo::Matched,
                    submit: true,
                    cli_type: "default".to_string(),
                },
            },
            created_at: 1_000,
            updated_at: 1_000,
        }
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

    /// §2.7: an uncompilable pattern is reported once per LOAD. The evaluator runs four times a second
    /// and this must not be a row each time — which is why compilation happens here at all.
    #[test]
    fn a_bad_pattern_is_reported_once_per_load_and_never_per_tick() {
        let store = AutomationStore::new_in_memory();
        store.save_rule(&rule("au-bad", r"ctx:(\d+%")).unwrap();
        let engine = AutomationEngine::new(0);

        engine.reload(&store, 1_000).unwrap();
        assert_eq!(log_rows(&store).len(), 1);

        // A thousand evaluator ticks pass. The rule is not live, so nothing evaluates it and nothing
        // else can write a row: the live set is the only thing the tick walks.
        assert!(engine.snapshot_live().is_empty());
        assert_eq!(log_rows(&store).len(), 1, "still one row after the ticks that never ran it");

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
            engine.runtime.arm_state("au-a", "tm-1"),
            ArmState::Unseen,
            "and the rule that left the set does lose its keys"
        );
        assert_eq!(
            engine.runtime.fire_record("au-a", "tm-1"),
            None,
            "EVERY pair-keyed map, not just the two the assertion above happens to name"
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
