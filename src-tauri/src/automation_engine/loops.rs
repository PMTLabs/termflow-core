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
    // The fake, the canonical rule and the wiring are shared with the dry run's tests so there can
    // only ever be one of each.
    use crate::automation_engine::test_host::*;

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

    // =============================================================================================
    // The send's own fixtures (§10.7 – §10.9, §10.14c)
    // =============================================================================================

    /// A crossing that has been decided and not yet written — built exactly the way `evaluate_pair`
    /// builds one, **including advancing the arm state first**, so a test of the rollback is a test of
    /// the real starting position rather than of a state the engine never produces.
    fn pending(
        engine: &Arc<AutomationEngine>,
        host: &Arc<dyn EngineHost>,
        rule_id: &str,
        prev: ArmState,
        at_ms: i64,
    ) -> PendingSend {
        let rule = engine
            .snapshot_live()
            .into_iter()
            .find(|l| l.rule.id == rule_id)
            .expect("the rule must be live for a send to have been decided");
        engine.runtime.set_arm(rule_id, "tm-1", ArmState::Fired { at_ms });
        PendingSend {
            pair: Pair { rule, tm: "tm-1".into(), pc: "pc-1".into() },
            prev,
            label: host.label_for("tm-1"),
            at_ms,
        }
    }

    /// Where each bracketed paste sits in the write log. One send is three writes — paste, focus-in,
    /// submit — so two serialised sends put their pastes at 0 and 3, and two interleaved ones put them
    /// side by side.
    fn paste_positions(writes: &[String]) -> Vec<usize> {
        writes
            .iter()
            .enumerate()
            .filter(|(_, w)| w.starts_with("\x1b[200~"))
            .map(|(i, _)| i)
            .collect()
    }

    // =============================================================================================
    // §10.7 — send serialisation
    // =============================================================================================

    /// **Two sends into one terminal, decided in one tick.** Route A is paste → 500 ms → focus-in →
    /// submit, and without the per-leaf lock both tasks write their paste, both sleep, and the second
    /// rule's text lands *inside* the first rule's composer line — which then submits both as one
    /// message. That is not a lost automation, it is a wrong command typed at an agent.
    ///
    /// The oracle is the POSITION of the two pastes, not the presence of the two messages: a lock-free
    /// implementation satisfies "both messages appear somewhere" perfectly.
    #[tokio::test(start_paused = true)]
    async fn two_sends_to_one_terminal_never_interleave() {
        let (engine, fake, host) = wire(vec![
            ctx_rule_saying("au-1", "alpha speaking", 1),
            ctx_rule_saying("au-2", "bravo speaking", 2),
        ]);
        for id in ["au-1", "au-2"] {
            engine.runtime.set_arm(id, "tm-1", ArmState::armed());
        }
        engine.runtime.mark_dirty("pc-1");
        fake.say("pc-1", "ctx:63%\n");

        evaluate_tick(&engine, &host, 0, 1_000).await;
        tokio::time::sleep(Duration::from_millis(2_000)).await;

        let writes = fake.written();
        assert_eq!(writes.len(), 6, "two sends of three writes each: {:?}", writes);
        assert_eq!(
            paste_positions(&writes),
            vec![0, 3],
            "a paste landed inside another send: {:?}",
            writes
        );

        // Order between the two is the scheduler's business; carrying ONE WHOLE message each is not.
        let mut carried: Vec<&str> = Vec::new();
        for i in [0usize, 3] {
            let alpha = writes[i].contains("alpha speaking");
            let bravo = writes[i].contains("bravo speaking");
            assert_ne!(alpha, bravo, "one paste carried both messages: {:?}", writes);
            carried.push(if alpha { "alpha" } else { "bravo" });
        }
        carried.sort_unstable();
        assert_eq!(carried, vec!["alpha", "bravo"], "both rules must have sent: {:?}", writes);
    }

    /// A send that cannot take the terminal's queue within [`SEND_QUEUE_TIMEOUT_MS`] gives up: one
    /// `failed` row, nothing typed, and the arm state back at **exactly** where it was.
    ///
    /// `prev` is a RE-armed state here rather than a fresh `armed()`, and that is the point of the
    /// test: rolling back to `ArmState::armed()` loses `seen_fire`, which puts a presence rule back to
    /// reading the deep window and makes it re-fire on the very line it just let go (§2.2c). A
    /// rollback that looks right and is not.
    #[tokio::test(start_paused = true)]
    async fn a_send_that_cannot_take_the_queue_fails_once_and_rolls_back_exactly() {
        let (engine, fake, host) = wired();
        let lock = engine.runtime.send_lock("tm-1");
        let _held = lock.lock().await;

        let send = pending(&engine, &host, "au-1", ArmState::re_armed(), 1_000);
        run_send(engine.clone(), host.clone(), send).await;

        assert!(fake.written().is_empty(), "a send that never got the queue must type nothing");
        assert_eq!(
            engine.runtime.arm_state("au-1", "tm-1"),
            ArmState::re_armed(),
            "rolled back to a fresh Armed, losing seen_fire"
        );
        let rows = log_details(&fake.store);
        assert_eq!(rows.len(), 1, "exactly one row: {:?}", rows);
        assert_eq!(rows[0].0, "Failed");
        assert!(rows[0].1.contains("another rule was still sending"), "{:?}", rows);
        assert_eq!(engine.runtime.fire_record("au-1", "tm-1"), None, "a failed send never fired");
    }

    // =============================================================================================
    // §10.8 — the failure paths
    // =============================================================================================

    /// **Both delivery failures, as a table**, because they are one class: the message did not go out.
    /// Each writes exactly one row, leaves the arm state where the decision found it, records no fire,
    /// and leaves neither an echo needle nor a settle window behind — a send that half-happened is the
    /// one outcome the log must never imply.
    #[tokio::test(start_paused = true)]
    async fn a_send_that_cannot_be_delivered_fails_once_and_leaves_the_pair_armed() {
        // (what breaks it, how to break it, what the row must say, writes actually attempted)
        let cases: Vec<(&str, fn(&FakeHost), &str, usize)> = vec![
            (
                "the terminal closed between the decision and our turn at the queue",
                |fake: &FakeHost| {
                    fake.leaves.lock().unwrap().clear();
                },
                "the terminal closed before the message was sent",
                0,
            ),
            (
                "the write itself was refused",
                |fake: &FakeHost| {
                    *fake.write_err.lock().unwrap() = Some("terminal pc-1 has no writer".into());
                },
                "the message could not be sent",
                1,
            ),
        ];

        for (what, break_it, says, attempted) in cases {
            let (engine, fake, host) = wired();
            break_it(&fake);
            let send = pending(&engine, &host, "au-1", ArmState::armed(), 1_000);

            run_send(engine.clone(), host.clone(), send).await;
            tokio::time::sleep(Duration::from_millis(1_500)).await;

            assert_eq!(
                fake.written().len(),
                attempted,
                "{}: a refused paste must not be followed by a submit — {:?}",
                what,
                fake.written()
            );
            assert_eq!(engine.runtime.arm_state("au-1", "tm-1"), ArmState::armed(), "{}", what);
            let rows = log_details(&fake.store);
            assert_eq!(rows.len(), 1, "{}: exactly one row, got {:?}", what, rows);
            assert_eq!(rows[0].0, "Failed", "{}: {:?}", what, rows);
            assert!(rows[0].1.contains(says), "{}: {:?}", what, rows);
            assert_eq!(engine.runtime.fire_record("au-1", "tm-1"), None, "{}", what);
            assert!(
                engine.runtime.echoes_for("tm-1", 1_000).is_empty(),
                "{}: nothing was typed, so there is no echo to strip",
                what
            );
            assert!(
                !engine.runtime.is_settling("tm-1", 1_000),
                "{}: and no message is landing, so nothing must be held off this terminal",
                what
            );
        }
    }

    /// §10.8's third failure, and the only one that happens at LOAD rather than at send: an
    /// uncompilable pattern is reported once per load and never per tick.
    ///
    /// `automation_engine.rs` asserts the same thing from the live set's side, where "nothing
    /// evaluates it" could only be argued. Here eight real ticks run over it — which is the claim that
    /// matters, and until M3b there was no evaluator to make it against.
    #[tokio::test(start_paused = true)]
    async fn an_uncompilable_pattern_is_reported_once_at_load_and_never_by_a_tick() {
        let mut bad = ctx_rule("au-bad");
        bad.graph.parse.find = r"ctx:(\d+%".into();
        let (engine, fake, host) = wire(vec![bad]);

        assert_eq!(log_kinds(&fake.store), vec!["Failed".to_string()], "one row, written at load");
        assert!(engine.snapshot_live().is_empty(), "and the rule is not running");

        fake.say("pc-1", "ctx:63%\n");
        let mut cursor = 0;
        for t in 1..=8 {
            engine.runtime.mark_dirty("pc-1");
            cursor = evaluate_tick(&engine, &host, cursor, t * 1_000).await;
        }

        assert_eq!(log_kinds(&fake.store), vec!["Failed".to_string()], "a tick wrote a second row");
        assert!(fake.written().is_empty(), "and an uncompilable rule must never send");
    }

    // =============================================================================================
    // §10.8b — the stop flag, at the one place a half-executed step is visible to a user
    // =============================================================================================

    #[tokio::test(start_paused = true)]
    async fn a_quit_stops_a_queued_send_and_never_splits_one_already_typing() {
        // Queued: the flag is set before the first write, so nothing is typed at all.
        {
            let (engine, fake, host) = wired();
            let send = pending(&engine, &host, "au-1", ArmState::armed(), 1_000);
            engine.stop();

            run_send(engine.clone(), host.clone(), send).await;

            assert!(fake.written().is_empty(), "a send that started after the quit must type nothing");
            assert_eq!(
                engine.runtime.arm_state("au-1", "tm-1"),
                ArmState::armed(),
                "and the crossing must still be able to fire next launch"
            );
            // No `failed` row, deliberately: `RunEvent::Exit` sets this flag and then performs the
            // SYNCHRONOUS log flush, so a row appended here is a row nobody ever reads.
            assert!(log_kinds(&fake.store).is_empty(), "{:?}", log_details(&fake.store));
        }

        // Already typing: the flag is set during the paste-to-submit gap and the submit still goes
        // out. A check between the two leaves the user's composer holding an unsent line.
        {
            let (engine, fake, host) = wired();
            let send = pending(&engine, &host, "au-1", ArmState::armed(), 1_000);
            let task = tokio::spawn(run_send(engine.clone(), host.clone(), send));

            tokio::time::sleep(Duration::from_millis(100)).await;
            assert_eq!(fake.written().len(), 1, "the paste must be out and the gap running");
            engine.stop();
            tokio::time::sleep(Duration::from_millis(1_000)).await;
            assert!(task.is_finished(), "the send must not park on the flag");

            let writes = fake.written();
            assert_eq!(writes.len(), 3, "paste, focus-in, submit: {:?}", writes);
            assert_eq!(writes[2], "\x1b\r\r", "the submit itself: {:?}", writes);
            assert_eq!(
                engine.runtime.arm_state("au-1", "tm-1"),
                ArmState::Fired { at_ms: 1_000 },
                "a completed send is not rolled back"
            );
            assert!(log_kinds(&fake.store).contains(&"Sent".to_string()));
        }
    }

    // =============================================================================================
    // §10.9 — the echo guard, end to end
    // =============================================================================================

    /// **§2.6 in the canonical rule's own shape.** Pattern `HANDOFF`, message `HANDOFF now`: a rule
    /// whose message contains its own pattern is what breaks without the guard, and the rule this
    /// whole feature was designed around is exactly that shape.
    ///
    /// The needle is stripped, so once the real line has scrolled away the rule sees nothing and
    /// **re-arms**. Without the strip it sits in `Fired` forever reading its own message — which is
    /// indistinguishable from working until the day the condition happens again.
    #[tokio::test(start_paused = true)]
    async fn a_rule_re_arms_when_the_only_thing_left_on_screen_is_its_own_echo() {
        let (engine, fake, host) = wire(vec![presence_rule("au-1", "HANDOFF", "HANDOFF now", 1)]);
        engine.runtime.set_arm("au-1", "tm-1", ArmState::armed());
        engine.runtime.mark_dirty("pc-1");
        fake.say("pc-1", "building\nHANDOFF\n");

        evaluate_tick(&engine, &host, 0, 1_000).await;
        tokio::time::sleep(Duration::from_millis(1_500)).await;
        assert_eq!(fake.written().len(), 3, "the crossing must send: {:?}", fake.written());
        assert_eq!(engine.runtime.echoes_for("tm-1", 1_000), vec!["HANDOFF now".to_string()]);

        // The real line has scrolled off. All that is left is what this rule typed.
        fake.say("pc-1", "HANDOFF now\n");
        engine.runtime.mark_dirty("pc-1");
        evaluate_tick(&engine, &host, 0, 4_000).await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        assert_eq!(
            engine.runtime.arm_state("au-1", "tm-1"),
            ArmState::re_armed(),
            "the rule read its own message and stayed Fired"
        );
        assert_eq!(fake.written().len(), 3, "and it must not have sent again");
        assert!(log_kinds(&fake.store).contains(&"ReArmed".to_string()));

        // The positive half. The strip removes the NEEDLE, not the window: a genuine match arriving
        // while the echo is still live is still seen — otherwise "never fires again" is how this test
        // passes.
        fake.say("pc-1", "HANDOFF now\nHANDOFF\n");
        engine.runtime.mark_dirty("pc-1");
        evaluate_tick(&engine, &host, 0, 7_000).await;
        tokio::time::sleep(Duration::from_millis(1_500)).await;
        assert_eq!(
            fake.written().len(),
            6,
            "a real match beside the echo must still send: {:?}",
            fake.written()
        );
    }

    /// The **per-terminal** half of §2.6, and the reason the needle map is keyed by terminal rather
    /// than by rule: rule A's message is echoed into a pane rule B is also watching, and B has no idea
    /// A wrote it. A per-rule map hands B an empty needle list and B fires on A's message.
    #[tokio::test(start_paused = true)]
    async fn a_needle_one_rule_recorded_is_stripped_before_another_rule_reads_that_terminal() {
        let (engine, fake, host) = wire(vec![
            presence_rule("au-a", "HANDOFF", "HANDOFF now", 1),
            presence_rule("au-b", "now", "bravo saw it", 2),
        ]);
        for id in ["au-a", "au-b"] {
            engine.runtime.set_arm(id, "tm-1", ArmState::armed());
        }
        engine.runtime.mark_dirty("pc-1");
        fake.say("pc-1", "building\nHANDOFF\n");

        // A crosses. B sees no `now` at all and stays armed.
        evaluate_tick(&engine, &host, 0, 1_000).await;
        tokio::time::sleep(Duration::from_millis(1_500)).await;
        assert_eq!(engine.runtime.arm_state("au-b", "tm-1"), ArmState::armed());
        assert_eq!(times_sent(&fake, "HANDOFF now"), 1);

        // A's message lands in the pane B is watching.
        fake.say("pc-1", "HANDOFF now\n");
        engine.runtime.mark_dirty("pc-1");
        evaluate_tick(&engine, &host, 0, 4_000).await;
        tokio::time::sleep(Duration::from_millis(1_500)).await;

        assert_eq!(
            engine.runtime.arm_state("au-b", "tm-1"),
            ArmState::armed(),
            "B fired on a message this feature typed itself"
        );
        assert_eq!(
            times_sent(&fake, "bravo saw it"),
            0,
            "B must not have sent: {:?}",
            fake.written()
        );

        // Paired positive: the same word arriving organically beside the echo DOES reach B.
        fake.say("pc-1", "HANDOFF now\nfinishing now\n");
        engine.runtime.mark_dirty("pc-1");
        evaluate_tick(&engine, &host, 0, 7_000).await;
        tokio::time::sleep(Duration::from_millis(1_500)).await;
        assert_eq!(
            times_sent(&fake, "bravo saw it"),
            1,
            "the strip removes the needle, not the window: {:?}",
            fake.written()
        );
    }

    // =============================================================================================
    // §10.14c — a runs-once rule
    // =============================================================================================

    /// **R6, both halves.** A `runs_once` rule fires exactly once *in this session* — driven below its
    /// threshold and back above it with no reload anywhere — and stays completed across one.
    ///
    /// The second rule is the control, and it is what makes the first assertion mean anything: the
    /// identical drive makes `au-many` fire twice, so "no second send" cannot pass because the fixture
    /// never re-armed anything in the first place.
    #[tokio::test(start_paused = true)]
    async fn a_runs_once_rule_fires_once_in_the_same_session_and_stays_completed_across_a_reload() {
        let mut once = ctx_rule_saying("au-once", "once only", 1);
        once.runs_once = true;
        let (engine, fake, host) = wire(vec![once, ctx_rule_saying("au-many", "every time", 2)]);
        for id in ["au-once", "au-many"] {
            engine.runtime.set_arm(id, "tm-1", ArmState::armed());
        }

        // The crossing.
        fake.say("pc-1", "ctx:63%\n");
        engine.runtime.mark_dirty("pc-1");
        evaluate_tick(&engine, &host, 0, 1_000).await;
        tokio::time::sleep(Duration::from_millis(2_000)).await;

        assert!(!engine.is_live("au-once"), "§7.8: completion is an in-memory event FIRST");
        assert_eq!(
            engine.runtime.arm_state("au-once", "tm-1"),
            ArmState::Unseen,
            "and it takes the rule's arm keys with it"
        );
        assert_eq!(
            fake.store
                .list_rules()
                .unwrap()
                .into_iter()
                .find(|r| r.id == "au-once")
                .unwrap()
                .completed_at,
            Some(1_000),
            "the row is written second, with the decision's own stamp"
        );

        // Below the threshold and back above it, with no reload at all — the drive that re-arms a rule
        // and fires it again.
        for (t, screen) in [(3_000i64, "ctx:18%\n"), (5_000, "ctx:63%\n")] {
            fake.say("pc-1", screen);
            engine.runtime.mark_dirty("pc-1");
            evaluate_tick(&engine, &host, 0, t).await;
            tokio::time::sleep(Duration::from_millis(2_000)).await;
        }

        assert_eq!(times_sent(&fake, "once only"), 1, "a runs-once rule fired twice in one session");
        assert_eq!(
            times_sent(&fake, "every time"),
            2,
            "the control never re-armed, so the assertion above proves nothing"
        );

        // (b) The next launch: a fresh engine loads the same store and must not run it at all.
        let next = Arc::new(AutomationEngine::new(0));
        next.reload(&fake.store, 6_000).unwrap();
        assert!(!next.is_live("au-once"), "the reload filter is the second line of defence");
        assert!(next.is_live("au-many"), "and only the completed rule is filtered");

        next.runtime.set_watched("au-once", ["tm-1".to_string()].into());
        next.runtime.set_arm("au-once", "tm-1", ArmState::armed());
        fake.say("pc-1", "ctx:77%\n");
        next.runtime.mark_dirty("pc-1");
        evaluate_tick(&next, &host, 0, 7_000).await;
        tokio::time::sleep(Duration::from_millis(2_000)).await;
        assert_eq!(times_sent(&fake, "once only"), 1, "a completed rule ran after a reload");
    }

}
