//! The three tasks that make the engine run, and the send they dispatch (plan §2.1, §2.3, §2.5).
//!
//! **One tap task, one evaluator task and one targeting tick for the whole engine — never one per
//! rule.** A `tokio::time::interval` per rule would be N un-cancellable forever-loops in a crate
//! whose only `interval` is deliberately a singleton, and evaluating inline in the tap would let a
//! chatty build evaluate thousands of times a second *while blocking the broadcast receiver*.
//!
//! Every decision here reads plain data and reaches the app through [`EngineHost`], so all three
//! loops and the send run under a plain `cargo test` on Windows. §7.10 is the reason: nine of §10's
//! items originally named `AppState` targets while §12 listed them as the local gates for the two
//! milestones that contain the entire engine.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::broadcast::error::RecvError;

use crate::automation::runtime::{ECHO_SETTLE_MS, ECHO_TTL_MS};
use crate::automation::targeting::watched_set;
use crate::automation_engine::due::{
    due_now, select_due, settled_processes, BASE_TICK_MS, MAX_EVALS_PER_TICK, TARGETING_TICK_MS,
};
use crate::automation_engine::eval::{self, ArmState, Decision, Evaluation, Outcome, Read};
use crate::automation_engine::host::{EngineHost, HostPort};
use crate::automation_engine::{AutomationEngine, LiveRule};
use crate::automation_store::{AutomationLogEntry, LogKind};
use crate::state::ChannelPayload;

/// How long a send waits for the terminal's queue before giving up and rolling back (§2.5).
pub const SEND_QUEUE_TIMEOUT_MS: u64 = 10_000;

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

// =================================================================================================
// The tap (§1.1)
// =================================================================================================

/// Mark terminals dirty. **Carries a signal, never data.**
///
/// `state.terminal_screens` already holds a per-terminal `vt100::Parser` fed every raw byte,
/// unconditionally and losslessly, by the single authoritative output consumer — before the lossy
/// history filter runs. So this does exactly `mark_dirty(payload.id)` and never reads `payload.data`,
/// and three problems disappear together: a `ctx:5` | `0%` split across two chunks is a non-issue
/// because the parser spans `process()` calls; a `Lagged` costs a delayed evaluation rather than a
/// missed match; and no new per-terminal buffer exists, so there is nothing to bound or leak.
///
/// **The `recv` is behind a timeout**, and that is not a performance choice: a bare `recv().await`
/// parks forever on a quiet machine, and a loop parked in `recv` cannot observe `stopping` at all.
/// The timeout is what makes §2.1's "checked at the top of every iteration" a true statement.
pub async fn run_tap(
    engine: Arc<AutomationEngine>,
    host: Arc<dyn EngineHost>,
    mut rx: tokio::sync::broadcast::Receiver<ChannelPayload>,
) {
    loop {
        if engine.stopping.load(Ordering::Relaxed) {
            return;
        }
        match tokio::time::timeout(Duration::from_millis(BASE_TICK_MS), rx.recv()).await {
            // Nothing printed this window. Round the loop and re-check the flag.
            Err(_elapsed) => continue,
            Ok(Ok(payload)) => engine.runtime.mark_dirty(&payload.id),
            // The consumer outran us. Every live terminal MAY have printed, and the cost of assuming
            // so is one extra evaluation each; the cost of dropping it is a missed match with no
            // symptom. `Lagged` is exactly why the tap carries a signal instead of the bytes.
            Ok(Err(RecvError::Lagged(n))) => {
                log::warn!("automations: tap lagged {} messages, marking every terminal dirty", n);
                for pc in host.live_processes() {
                    engine.runtime.mark_dirty(&pc);
                }
            }
            Ok(Err(RecvError::Closed)) => return,
        }
    }
}

// =================================================================================================
// The evaluator (§2.3)
// =================================================================================================

/// One `(rule, terminal)` pair that is due this tick, with its leaf already resolved.
#[derive(Clone)]
pub struct Pair {
    pub rule: Arc<LiveRule>,
    pub tm: String,
    pub pc: String,
}

/// A crossing that has been decided and not yet written.
///
/// `prev` travels with it because every failure path rolls the arm state back to **exactly** where it
/// was, not to a fresh `Armed`: the `seen_fire` bit is a fact about this pair's history and losing it
/// would put a presence rule back to reading the deep window (§2.2c).
pub struct PendingSend {
    pub pair: Pair,
    pub prev: ArmState,
    pub label: Option<String>,
    pub at_ms: i64,
}

pub async fn run_evaluator(engine: Arc<AutomationEngine>, host: Arc<dyn EngineHost>) {
    let mut cursor = 0usize;
    loop {
        if engine.stopping.load(Ordering::Relaxed) {
            return;
        }
        cursor = evaluate_tick(&engine, &host, cursor, now_ms()).await;
        tokio::time::sleep(Duration::from_millis(BASE_TICK_MS)).await;
    }
}

/// One pass: work out what is due, run at most [`MAX_EVALS_PER_TICK`] of it, spend the dirty flags
/// that are fully consumed. Returns the cursor for the next tick.
pub async fn evaluate_tick(
    engine: &Arc<AutomationEngine>,
    host: &Arc<dyn EngineHost>,
    cursor: usize,
    now_ms: i64,
) -> usize {
    let mut due: Vec<Pair> = Vec::new();
    for live in engine.snapshot_live() {
        // Sorted, so which pairs the cap holds over is a property of the rule and not of hash order.
        let mut leaves: Vec<String> = engine.runtime.watched_for(&live.rule.id).into_iter().collect();
        leaves.sort();
        for tm in leaves {
            // §2.6 layer 2: this terminal is still settling after a send, so nothing reads it.
            if engine.runtime.is_settling(&tm, now_ms) {
                continue;
            }
            // The ONE tm -> pc conversion. `None` is dormant (§4.5), not dead: no evaluation, no log
            // line, arm state untouched.
            let Some(pc) = host.process_for_leaf(&tm) else {
                continue;
            };
            let monitor = &live.rule.graph.monitor;
            if due_now(
                monitor.cadence,
                monitor.every_ms,
                engine.runtime.is_dirty(&pc),
                engine.runtime.last_eval(&live.rule.id, &tm),
                now_ms,
            ) {
                due.push(Pair { rule: live.clone(), tm, pc });
            }
        }
    }

    let due_pcs: Vec<String> = due.iter().map(|p| p.pc.clone()).collect();
    let (picked, next_cursor) = select_due(due.len(), cursor, MAX_EVALS_PER_TICK);
    if due.len() > picked.len() {
        log::warn!(
            "automations: {} pairs due, running {} this tick; the rest run next tick",
            due.len(),
            picked.len()
        );
    }

    let mut sends = Vec::new();
    for i in &picked {
        if let Some(send) = evaluate_pair(engine, host, &due[*i], now_ms) {
            sends.push(send);
        }
    }

    // Only now, and only for terminals whose every due pair ran.
    for pc in settled_processes(&due_pcs, &picked) {
        engine.runtime.clear_dirty(&pc);
    }

    // §2.5: a crossing dispatches its write OFF the tick. Route A's send holds a load-bearing 500 ms
    // sleep, and awaiting it inline would stall every rule on every terminal for the duration — four
    // sends in one tick would freeze evaluation for two seconds. Serialisation is unaffected: it was
    // never the tick that provided it, it was the per-terminal lock.
    for send in sends {
        let engine = engine.clone();
        let host = host.clone();
        tokio::spawn(async move { run_send(engine, host, send).await });
    }

    next_cursor
}

/// Evaluate one pair and record what it decided. Returns the send, if this was a crossing.
pub fn evaluate_pair(
    engine: &Arc<AutomationEngine>,
    host: &Arc<dyn EngineHost>,
    pair: &Pair,
    now_ms: i64,
) -> Option<PendingSend> {
    let rule = &pair.rule.rule;
    let prev = engine.runtime.arm_state(&rule.id, &pair.tm);
    let echoes = engine.runtime.echoes_for(&pair.tm, now_ms);
    let port = HostPort(host.as_ref());

    let ev: Evaluation = eval::evaluate(
        &rule.graph,
        &pair.rule.re,
        &echoes,
        prev,
        &port,
        &pair.pc,
        now_ms,
    )?;

    engine.runtime.set_last_eval(&rule.id, &pair.tm, now_ms);
    // Advanced BEFORE the send is dispatched, so a second tick arriving while the first write is
    // still in flight sees `Fired` and decides `held` rather than queueing a duplicate.
    engine.runtime.set_arm(&rule.id, &pair.tm, ev.next);

    if !ev.decision.sends() {
        append(engine, host, &rule.id, Some(&pair.tm), kind_for(&ev), &ev.detail, now_ms);
        return None;
    }

    Some(PendingSend {
        pair: pair.clone(),
        prev,
        // Resolved at DECIDE time and carried, per §2.8: the `failed — the terminal closed` entry is
        // written after the terminal is gone, when there is no name left to look up.
        label: host.label_for(&pair.tm),
        at_ms: now_ms,
    })
}

/// Which log kind one evaluation is.
///
/// `NoMatch` is its own kind rather than a `Check` with different words, because §3.3's gate classes
/// them together but the log view distinguishes them — and the store derives the class from the kind,
/// so the caller cannot get the gating wrong by choosing a kind.
fn kind_for(ev: &Evaluation) -> LogKind {
    match ev.decision {
        Decision::Sent => LogKind::Sent,
        Decision::Held => LogKind::Held,
        Decision::ReArmed => LogKind::ReArmed,
        Decision::Armed | Decision::Checked => match &ev.outcome {
            Outcome::Numeric(Read::NoMatch) | Outcome::Presence(false) => LogKind::NoMatch,
            _ => LogKind::Check,
        },
    }
}

// =================================================================================================
// The send (§2.5, §2.6)
// =================================================================================================

/// Take the terminal's queue, re-check it is still there, write, and record what happened.
///
/// **Every failure path rolls the arm state back and writes exactly one log line** — the queue timed
/// out, the terminal closed between the decision and the write, the write itself failed. Never left
/// `Fired`, because a crossing that produced no message must still be able to fire.
pub async fn run_send(
    engine: Arc<AutomationEngine>,
    host: Arc<dyn EngineHost>,
    send: PendingSend,
) {
    let rule = &send.pair.rule.rule;
    let tm = send.pair.tm.clone();
    let lock = engine.runtime.send_lock(&tm);

    let _guard = match tokio::time::timeout(
        Duration::from_millis(SEND_QUEUE_TIMEOUT_MS),
        lock.lock(),
    )
    .await
    {
        Ok(guard) => guard,
        Err(_) => {
            return fail(&engine, &host, &send, "another rule was still sending");
        }
    };

    // Inside the lock, because the terminal can close between the decision and our turn at the queue.
    let Some(pc) = host.process_for_leaf(&tm) else {
        return fail(&engine, &host, &send, "the terminal closed before the message was sent");
    };

    // §2.1: checked before the FIRST write and never between the paste and the submit, so a quit
    // leaves the send either unstarted or complete — there is no half-typed line to reason about.
    if engine.stopping.load(Ordering::Relaxed) {
        engine.runtime.set_arm(&rule.id, &tm, send.prev);
        return;
    }

    let action = &rule.graph.action;
    let (separator, end_indicator) =
        crate::api_server::get_cli_pattern(&action.cli_type).unwrap_or(("", "\r"));
    let outcome = crate::automation::send::deliver(
        &HostPort(host.as_ref()),
        &pc,
        &action.cli_type,
        crate::automation::send::SubmitPattern { separator, end_indicator },
        &action.message,
        action.submit,
    )
    .await;

    if let Err(e) = outcome {
        return fail(&engine, &host, &send, &format!("the message could not be sent: {}", e));
    }

    let at = send.at_ms;
    // §2.6 layer 1, then layer 2: the needle first, so a tick that slips through the settle window
    // still strips it.
    engine.runtime.push_echo(&tm, &crate::automation::send::normalise(&action.message), at + ECHO_TTL_MS);
    engine.runtime.settle_until(&tm, at + ECHO_SETTLE_MS);
    engine.runtime.record_fire(&rule.id, &tm, at);

    append(&engine, &host, &rule.id, Some(&tm), LogKind::Sent, &sent_detail(&send), at);

    // §7.8 — completion is an in-memory event FIRST and a row second, in this same critical section.
    // `reload` runs from mutating store commands and this is the engine, which is not one: without
    // the in-memory removal the rule stays live in `Fired`, re-arms the moment its value drops, and
    // sends a SECOND message in the same session from a row the UI already shows as Completed.
    if rule.runs_once {
        if let Err(e) = host.store().mark_completed(&rule.id, at) {
            log::warn!("automations: could not mark {} completed: {}", rule.id, e);
        }
        engine.complete_rule(&rule.id);
    }
    host.emit_state();
}

fn sent_detail(send: &PendingSend) -> String {
    match &send.label {
        Some(name) => format!("sent to {}", name),
        None => "sent".to_string(),
    }
}

/// One failure: roll the arm state back to exactly where it was, and say so once.
fn fail(
    engine: &Arc<AutomationEngine>,
    host: &Arc<dyn EngineHost>,
    send: &PendingSend,
    reason: &str,
) {
    let rule_id = &send.pair.rule.rule.id;
    engine.runtime.set_arm(rule_id, &send.pair.tm, send.prev);
    append(
        engine,
        host,
        rule_id,
        Some(&send.pair.tm),
        LogKind::Failed,
        reason,
        send.at_ms,
    );
}

/// Append one row and emit if the store says one is due.
///
/// The store owns the cap, the verbose gate and the ≤ 1/s decision — all three inside `append`, so a
/// caller cannot re-implement any of them. This function only carries the emit the store cannot make.
fn append(
    engine: &Arc<AutomationEngine>,
    host: &Arc<dyn EngineHost>,
    rule_id: &str,
    tm: Option<&str>,
    kind: LogKind,
    detail: &str,
    at: i64,
) {
    let entry = AutomationLogEntry {
        id: 0,
        rule_id: rule_id.to_string(),
        terminal_id: tm.map(str::to_string),
        terminal_name: tm.and_then(|t| host.label_for(t)),
        kind,
        detail: detail.to_string(),
        at,
    };
    let _ = engine;
    match host.store().append(&entry) {
        Ok(Some(outcome)) if outcome.emit => host.emit_activity(outcome.rule_ids),
        Ok(_) => {}
        Err(e) => log::warn!("automations: could not write a log row for {}: {}", rule_id, e),
    }
}

// =================================================================================================
// The targeting tick (§4.4, §4.5)
// =================================================================================================

/// Re-resolve every rule's matched set, every [`TARGETING_TICK_MS`].
///
/// **There is no spawn hook, deliberately.** There are two registration sites today
/// (`pty_manager` in-process and `register_host_terminal` for the sidecar) and a third the next time
/// a spawn path is added; the tick covers every path, every window and session restore by
/// construction, and the mockup already promises "refreshed every few seconds".
pub async fn run_targeting(engine: Arc<AutomationEngine>, host: Arc<dyn EngineHost>) {
    loop {
        if engine.stopping.load(Ordering::Relaxed) {
            return;
        }
        targeting_tick(&engine, &host, now_ms());
        tokio::time::sleep(Duration::from_millis(TARGETING_TICK_MS)).await;
    }
}

/// One pass of the targeting tick. Returns which pinned ids are reportably missing, by rule.
pub fn targeting_tick(
    engine: &Arc<AutomationEngine>,
    host: &Arc<dyn EngineHost>,
    now_ms: i64,
) -> HashMap<String, HashSet<String>> {
    let rows = host.roster();
    let live_leaves: HashSet<&str> = rows.iter().filter_map(|r| r.terminal_id.as_deref()).collect();
    let grace_over = crate::automation::roster::grace_elapsed(now_ms, engine.started_at_ms());
    let mut missing = HashMap::new();

    for live in engine.snapshot_live() {
        let id = &live.rule.id;
        // `watched_for` cannot say "never resolved", and does not need to: `watched_set` re-resolves
        // an EMPTY frozen set rather than treating it as a decision, so an empty previous and no
        // previous behave identically. (M2's dual review; the alternative was a distinction with no
        // consumer.)
        let previous: BTreeSet<String> = engine.runtime.watched_for(id).into_iter().collect();
        let next = watched_set(&live.rule, &rows, Some(&previous));
        engine.runtime.set_watched(id, next.iter().cloned().collect());

        if grace_over {
            let absent: HashSet<String> = next
                .iter()
                .filter(|tm| !live_leaves.contains(tm.as_str()))
                .cloned()
                .collect();
            if !absent.is_empty() {
                missing.insert(id.clone(), absent);
            }
        }
    }
    missing
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::automation::roster::RosterRow;
    use crate::automation_store::{
        ActionStep, AutomationGraph, AutomationRule, AutomationStore, Cadence, CompareOp, CondKind,
        CondStep, Criterion, Keep, LogOrder, LogScope, MonitorStep, ParsePreset, ParseStep, ReadMode,
        SendTo, TargetMode, SUPPORTED_SCHEMA_VERSION,
    };
    use std::sync::atomic::AtomicUsize;
    use std::sync::Mutex;

    /// One fake for all three loops and the send.
    ///
    /// Every method is a projection, which is what makes one fake enough: the loops hold every
    /// decision, so a test can drive them with plain data and never construct an `AppState`.
    /// `leaves` maps `tm-` to `pc-` with **deliberately different strings**, so any code path that
    /// passes the wrong id fails instead of coincidentally working.
    struct FakeHost {
        store: Arc<AutomationStore>,
        leaves: Mutex<HashMap<String, String>>,
        roster: Mutex<Vec<RosterRow>>,
        text: Mutex<HashMap<String, String>>,
        writes: Mutex<Vec<(String, Vec<u8>)>>,
        write_err: Mutex<Option<String>>,
        activity: AtomicUsize,
        states: AtomicUsize,
    }

    impl FakeHost {
        fn new() -> Self {
            Self {
                store: Arc::new(AutomationStore::new_in_memory()),
                leaves: Mutex::new(HashMap::new()),
                roster: Mutex::new(Vec::new()),
                text: Mutex::new(HashMap::new()),
                writes: Mutex::new(Vec::new()),
                write_err: Mutex::new(None),
                activity: AtomicUsize::new(0),
                states: AtomicUsize::new(0),
            }
        }

        fn with_terminal(self, tm: &str, pc: &str, label: &str) -> Self {
            self.leaves.lock().unwrap().insert(tm.into(), pc.into());
            self.roster.lock().unwrap().push(RosterRow {
                terminal_id: Some(tm.into()),
                process_id: pc.into(),
                name: "Terminal-powershell".into(),
                shell: "powershell".into(),
                pid: 100,
                display_label: Some(label.into()),
                cwd: None,
                command_line: None,
            });
            self
        }

        fn say(&self, pc: &str, text: &str) {
            self.text.lock().unwrap().insert(pc.into(), text.into());
        }

        fn written(&self) -> Vec<String> {
            self.writes
                .lock()
                .unwrap()
                .iter()
                .map(|(_, b)| String::from_utf8_lossy(b).to_string())
                .collect()
        }
    }

    impl EngineHost for FakeHost {
        fn process_for_leaf(&self, tm: &str) -> Option<String> {
            self.leaves.lock().unwrap().get(tm).cloned()
        }
        fn roster(&self) -> Vec<RosterRow> {
            self.roster.lock().unwrap().clone()
        }
        fn live_processes(&self) -> Vec<String> {
            self.leaves.lock().unwrap().values().cloned().collect()
        }
        fn tail(&self, pc: &str, _depth: crate::automation_engine::eval::ReadDepth) -> Option<String> {
            self.text.lock().unwrap().get(pc).cloned()
        }
        fn write(&self, pc: &str, bytes: &[u8]) -> Result<(), String> {
            self.writes.lock().unwrap().push((pc.to_string(), bytes.to_vec()));
            match self.write_err.lock().unwrap().clone() {
                Some(e) => Err(e),
                None => Ok(()),
            }
        }
        fn label_for(&self, tm: &str) -> Option<String> {
            self.roster
                .lock()
                .unwrap()
                .iter()
                .find(|r| r.terminal_id.as_deref() == Some(tm))
                .and_then(|r| r.display_label.clone())
        }
        fn store(&self) -> &Arc<AutomationStore> {
            &self.store
        }
        fn emit_activity(&self, _rule_ids: Vec<String>) {
            self.activity.fetch_add(1, Ordering::Relaxed);
        }
        fn emit_state(&self) {
            self.states.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn ctx_rule(id: &str) -> AutomationRule {
        AutomationRule {
            id: id.into(),
            name: format!("rule {}", id),
            enabled: true,
            runs_once: false,
            target_mode: TargetMode::Rule,
            criterion: Criterion::AllTerminals,
            criterion_value: String::new(),
            follow_new: true,
            target_ids: vec![],
            completed_at: None,
            verbose_until: None,
            sort_order: 1,
            schema_version: SUPPORTED_SCHEMA_VERSION,
            graph: AutomationGraph {
                monitor: MonitorStep { read: ReadMode::NewOutput, cadence: Cadence::OnOutput, every_ms: 0 },
                parse: ParseStep {
                    preset: ParsePreset::Custom,
                    literal: None,
                    find: r"ctx:(\d+)%".into(),
                    keep: Keep::Brackets,
                },
                cond: CondStep { kind: CondKind::Number, op: Some(CompareOp::Gt), threshold: Some(25.0) },
                action: ActionStep {
                    message: "prepare to do context-hand-off".into(),
                    send_to: SendTo::Matched,
                    submit: true,
                    cli_type: "claude".into(),
                },
            },
            created_at: 1_000,
            updated_at: 1_000,
        }
    }

    /// Engine + host, with one rule live and one terminal watched.
    fn wired() -> (Arc<AutomationEngine>, Arc<FakeHost>, Arc<dyn EngineHost>) {
        let fake = Arc::new(FakeHost::new().with_terminal("tm-1", "pc-1", "codex · core"));
        fake.store.save_rule(&ctx_rule("au-1")).unwrap();
        let engine = Arc::new(AutomationEngine::new(0));
        engine.reload(&fake.store, 0).unwrap();
        engine.runtime.set_watched("au-1", ["tm-1".to_string()].into());
        let host: Arc<dyn EngineHost> = fake.clone();
        (engine, fake, host)
    }

    fn log_kinds(store: &AutomationStore) -> Vec<String> {
        store
            .load_automation_log(&LogScope::All, LogOrder::Asc, 100)
            .unwrap()
            .into_iter()
            .map(|e| format!("{:?}", e.kind))
            .collect()
    }

    // =============================================================================================
    // §10.5 — the tap
    // =============================================================================================

    /// Twenty payloads over a channel of four: every id ends up dirty, and the `Lagged` the small
    /// channel forces marks every live terminal rather than dropping the window.
    #[tokio::test(start_paused = true)]
    async fn the_tap_marks_every_terminal_and_recovers_from_a_lagged_window() {
        let fake = Arc::new(
            FakeHost::new()
                .with_terminal("tm-1", "pc-1", "a")
                .with_terminal("tm-2", "pc-2", "b"),
        );
        let host: Arc<dyn EngineHost> = fake.clone();
        let engine = Arc::new(AutomationEngine::new(0));
        let (tx, rx) = tokio::sync::broadcast::channel::<ChannelPayload>(4);

        // Twenty into a channel of four, before the tap has read any of them: the receiver is
        // guaranteed to see `Lagged`, which is the case that must not silently drop terminals.
        for i in 0..20 {
            let _ = tx.send(ChannelPayload { id: format!("pc-{}", i % 2 + 1), data: vec![b'x'] });
        }
        let tap = tokio::spawn(run_tap(engine.clone(), host.clone(), rx));
        tokio::time::sleep(Duration::from_millis(50)).await;

        assert!(engine.runtime.is_dirty("pc-1"), "pc-1 never marked");
        assert!(engine.runtime.is_dirty("pc-2"), "a lagged window must mark every live terminal");

        engine.stop();
        tokio::time::sleep(Duration::from_millis(BASE_TICK_MS * 3)).await;
        assert!(tap.is_finished(), "the tap must return once `stopping` is set");
        drop(tx);
    }

    /// The "never reads `payload.data`" half, source-derived — it is not observable from outside the
    /// tap, so a runtime assertion could not make the claim at all.
    #[test]
    fn the_tap_body_never_reads_the_payload_bytes() {
        let source = include_str!("loops.rs").replace("\r\n", "\n");
        let start = source.find("pub async fn run_tap(").expect("run_tap must exist");
        let rest = &source[start..];
        let end = rest.find("\n}\n").expect("its body must be closed at column zero");
        let body = &rest[..end];
        assert!(
            !body.contains(".data"),
            "the tap carries a SIGNAL, not data: the parser already has every byte, losslessly"
        );
        assert!(body.contains("mark_dirty"), "and it must actually mark something");
    }

    // =============================================================================================
    // §10.6b — all three loops
    // =============================================================================================

    /// **Both halves are required.** "Returns when `stopping` is set" is satisfied completely by a
    /// loop body of `return`, which is the one implementation that must not pass — so each loop is
    /// first shown doing observable work with the flag clear.
    #[tokio::test(start_paused = true)]
    async fn all_three_loops_work_first_and_then_return_when_stopping_is_set() {
        let (engine, fake, host) = wired();
        engine.runtime.set_watched("au-1", HashSet::new());
        fake.say("pc-1", "ctx:18%\n");
        let (tx, rx) = tokio::sync::broadcast::channel::<ChannelPayload>(16);

        let tap = tokio::spawn(run_tap(engine.clone(), host.clone(), rx));
        let evaluator = tokio::spawn(run_evaluator(engine.clone(), host.clone()));
        let targeting = tokio::spawn(run_targeting(engine.clone(), host.clone()));

        // The tap does work.
        let _ = tx.send(ChannelPayload { id: "pc-1".into(), data: vec![b'x'] });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(engine.runtime.is_dirty("pc-1"), "the tap did nothing");

        // The targeting tick does work: it re-resolves `All terminals` and adopts tm-1.
        tokio::time::sleep(Duration::from_millis(TARGETING_TICK_MS)).await;
        assert!(engine.runtime.watches("au-1", "tm-1"), "the targeting tick did nothing");

        // And the evaluator does work: with a terminal watched and dirty, the pair evaluates.
        tokio::time::sleep(Duration::from_millis(BASE_TICK_MS * 4)).await;
        assert!(
            engine.runtime.last_eval("au-1", "tm-1").is_some(),
            "the evaluator did nothing"
        );

        engine.stop();
        tokio::time::sleep(Duration::from_millis(TARGETING_TICK_MS * 2)).await;
        assert!(tap.is_finished(), "tap");
        assert!(evaluator.is_finished(), "evaluator");
        assert!(targeting.is_finished(), "targeting");
        drop(tx);
    }

    // =============================================================================================
    // The tick, end to end
    // =============================================================================================

    /// A first sight ARMS and never sends, and the crossing that follows sends exactly once — driven
    /// through the real tick, so the arm machine, the depth read, the log and the write are all in
    /// the same story rather than three separate ones.
    #[tokio::test(start_paused = true)]
    async fn a_crossing_sends_once_through_the_real_tick() {
        let (engine, fake, host) = wired();
        engine.runtime.mark_dirty("pc-1");
        fake.say("pc-1", "ctx:18%\n");

        let cursor = evaluate_tick(&engine, &host, 0, 1_000).await;
        assert_eq!(cursor, 0);
        assert!(fake.written().is_empty(), "a first sight must arm, never type");
        assert_eq!(engine.runtime.arm_state("au-1", "tm-1"), ArmState::armed());
        // Nothing in the log, and that is the verbose gate doing its job: an ordinary check is the
        // outcome of most evaluations and would otherwise write four rows a second per pair.
        assert!(log_kinds(&fake.store).is_empty(), "an ungated check would flood the log");
        assert!(!engine.runtime.is_dirty("pc-1"), "the only pair on pc-1 ran, so its flag is spent");

        // The crossing. `dirty` again, and past the 250 ms floor.
        engine.runtime.mark_dirty("pc-1");
        fake.say("pc-1", "ctx:18%\nctx:63%\n");
        evaluate_tick(&engine, &host, cursor, 2_000).await;
        // The send is dispatched off the tick, and route A holds a 500 ms paste-to-submit gap.
        tokio::time::sleep(Duration::from_millis(1_500)).await;

        let writes = fake.written();
        assert!(
            writes.iter().any(|w| w.contains("prepare to do context-hand-off")),
            "the message was never typed: {:?}",
            writes
        );
        assert_eq!(engine.runtime.fire_record("au-1", "tm-1"), Some((1, 2_000)));
        assert!(log_kinds(&fake.store).contains(&"Sent".to_string()));

        // §2.6: the needle is recorded against the TERMINAL, and the terminal is settling.
        assert_eq!(
            engine.runtime.echoes_for("tm-1", 2_000),
            vec!["prepare to do context-hand-off".to_string()]
        );
        assert!(engine.runtime.is_settling("tm-1", 2_100));
        assert!(!engine.runtime.is_settling("tm-1", 2_000 + ECHO_SETTLE_MS + 1));
    }

    /// A terminal that is not live is DORMANT, not dead: no evaluation, no log line, no state change.
    /// The natural wrong implementation — treating an absent terminal as "condition false" — re-arms
    /// every rule on every terminal that is merely closed for a moment.
    #[tokio::test(start_paused = true)]
    async fn a_dormant_terminal_produces_no_evaluation_and_no_log_line() {
        let (engine, fake, host) = wired();
        engine.runtime.set_arm("au-1", "tm-1", ArmState::Fired { at_ms: 5 });
        engine.runtime.mark_dirty("pc-1");
        // Watched, but the leaf resolves to nothing: session restore has not re-registered it.
        fake.leaves.lock().unwrap().clear();

        evaluate_tick(&engine, &host, 0, 1_000).await;

        assert_eq!(engine.runtime.arm_state("au-1", "tm-1"), ArmState::Fired { at_ms: 5 });
        assert_eq!(engine.runtime.last_eval("au-1", "tm-1"), None);
        assert!(log_kinds(&fake.store).is_empty());
    }

    /// §2.6 layer 2: nothing reads a terminal while it is settling after a send — which is what stops
    /// the burst on the `OnOutput` cadence, where the echo chunk itself marks the terminal dirty.
    #[tokio::test(start_paused = true)]
    async fn a_settling_terminal_is_not_evaluated_by_any_rule() {
        let (engine, fake, host) = wired();
        engine.runtime.mark_dirty("pc-1");
        fake.say("pc-1", "ctx:63%\n");
        engine.runtime.settle_until("tm-1", 5_000);

        evaluate_tick(&engine, &host, 0, 1_000).await;
        assert_eq!(engine.runtime.last_eval("au-1", "tm-1"), None, "settling means untouched");

        // And once the window closes it evaluates normally again.
        evaluate_tick(&engine, &host, 0, 5_001).await;
        assert_eq!(engine.runtime.last_eval("au-1", "tm-1"), Some(5_001));
    }
}
