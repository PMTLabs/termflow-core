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
use crate::automation_store::{AutomationLogEntry, Criterion, LogKind, TargetMode};
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

    let mut sends: Vec<PendingSend> = Vec::new();
    for i in &picked {
        if let Some(send) = evaluate_pair(engine, host, &due[*i], now_ms) {
            // **R6 is per RULE, not per pair.** A `runs_once` rule watching three terminals crosses
            // on all three in one tick, and the send lock is per LEAF — so three tasks take three
            // different locks, three messages go out, and `complete_rule` runs three times on a rule
            // the user asked to run once. The arm states are advanced either way; only the send is
            // dropped, so the pairs that did not send stay `Fired` and never send later.
            let already = send.pair.rule.rule.runs_once
                && sends.iter().any(|s| s.pair.rule.rule.id == send.pair.rule.rule.id);
            if !already {
                sends.push(send);
            }
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

    if engine.take_state_emit(now_ms) {
        host.emit_state();
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

    // §7.2: `automation:state` is an ARM TRANSITION event. It was emitted only from a successful
    // send, so arming, re-arming and every rollback were silent and a row's pill sat on whatever it
    // last painted. Coalesced inside the engine (§2.9), because a chatty terminal transitions four
    // times a second per pair.
    if ev.next != prev {
        engine.mark_state_dirty();
    }

    let repeat = engine.runtime.last_decision(&rule.id, &pair.tm) == Some(ev.decision);
    engine.runtime.set_last_decision(&rule.id, &pair.tm, ev.decision);

    if !ev.decision.sends() {
        // Live by construction: `evaluate_pair` only runs for a pair whose leaf just resolved.
        let name = host.label_for(&pair.tm);
        append(engine, host, &rule.id, Some(&pair.tm), name, kind_for(&ev, repeat), &ev.detail, now_ms);
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
fn kind_for(ev: &Evaluation, repeat: bool) -> LogKind {
    // **The log records TRANSITIONS.** A decision identical to this pair's previous one is a repeat,
    // and a repeat is a `Check` — which is the one class §3.3's gate can drop.
    //
    // Without this, `held` is the defect: it is a Decision-class kind, so it is never gated, and a
    // rule that is working sits `Fired` with its condition true and writes a row every 250 ms tick.
    // The 200-row per-rule cap then evicts that rule's own `sent` row inside a minute — the row
    // §7.9's end-to-end story and GUI 9 check survives a relaunch — while writing four INSERTs a
    // second into `history.db`. The plan's own §7.8 calls "logged `held` every tick" a symptom of a
    // bug when describing a different one.
    //
    // The class stays derived from the kind inside `append` (§3.3): the caller still cannot label its
    // own entry, it can only say which decision this was.
    if repeat {
        return LogKind::Check;
    }
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

    // And so can the RULE. The queue wait is up to ten seconds; a user who disables a rule, or a
    // `runs_once` rule that completed on another terminal in this same tick, must not still be typing
    // into a terminal afterwards. Checked in the same critical section as the terminal, because it is
    // the same question: is this crossing still something the user wants sent?
    if !engine.is_live(&rule.id) {
        return fail(&engine, &host, &send, "the rule was turned off before the message was sent");
    }

    // §2.1: checked before the FIRST write and never between the paste and the submit, so a quit
    // leaves the send either unstarted or complete — there is no half-typed line to reason about.
    if engine.stopping.load(Ordering::Relaxed) {
        engine.runtime.restore_arm(&rule.id, &tm, send.prev);
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

    let name = send.label.clone();
    append(&engine, &host, &rule.id, Some(&tm), name, LogKind::Sent, &sent_detail(&send), at);

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
    engine.mark_state_dirty();
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
    engine.runtime.restore_arm(rule_id, &send.pair.tm, send.prev);
    engine.mark_state_dirty();
    append(
        engine,
        host,
        rule_id,
        Some(&send.pair.tm),
        // The label resolved at DECIDE time. This is the whole reason `PendingSend` carries one:
        // `the terminal closed` is written when there is no name left to look up.
        send.label.clone(),
        LogKind::Failed,
        reason,
        send.at_ms,
    );
}

/// Append one row and emit if the store says one is due.
///
/// The store owns the cap, the verbose gate and the ≤ 1/s decision — all three inside `append`, so a
/// caller cannot re-implement any of them. This function only carries the emit the store cannot make.
///
/// **`name` is passed in, never resolved here.** §2.8 and R17 want the name the terminal had when the
/// entry was DECIDED, and the entry this matters most for is `failed — the terminal closed`, which is
/// written after the terminal is gone: a lookup at write time returns `None` for exactly the line the
/// Name column exists to serve. Resolving inside this function put that lookup back at the one site
/// that had already carried the right answer — `PendingSend.label` was resolved at decide time and then
/// dropped on the floor.
fn append(
    engine: &Arc<AutomationEngine>,
    host: &Arc<dyn EngineHost>,
    rule_id: &str,
    tm: Option<&str>,
    name: Option<String>,
    kind: LogKind,
    detail: &str,
    at: i64,
) {
    let entry = AutomationLogEntry {
        id: 0,
        rule_id: rule_id.to_string(),
        terminal_id: tm.map(str::to_string),
        terminal_name: name,
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
    // BOTH halves of what `state_payload` is built from. Diffing only `missing` meant opening a
    // second terminal — adopted into `watched`, a new row in the payload — emitted nothing, so the
    // Settings page showed the rule watching one terminal until something else happened to fire.
    let mut last: (HashMap<String, HashSet<String>>, HashMap<String, HashSet<String>>) =
        (HashMap::new(), HashMap::new());
    loop {
        if engine.stopping.load(Ordering::Relaxed) {
            return;
        }
        // `spawn_blocking`, because `AppState`'s roster may take a `System` snapshot:
        // `new_all()` is 50-200 ms, and `ProcSnapshot`'s own doc says this call belongs off a
        // tokio worker.
        let (e, h) = (engine.clone(), host.clone());
        let missing = tokio::task::spawn_blocking(move || targeting_tick(&e, &h, now_ms()))
            .await
            .unwrap_or_default();
        // Only when the answer CHANGED. A pill that says *not open* is state the UI shows, so a
        // change has to reach it — but emitting every 2 s regardless would repaint every open
        // Settings page for the life of the app to say nothing happened.
        let watched: HashMap<String, HashSet<String>> = engine
            .snapshot_live()
            .iter()
            .map(|l| (l.rule.id.clone(), engine.runtime.watched_for(&l.rule.id)))
            .collect();
        let now = (watched, missing);
        if now != last {
            last = now;
            // Marked, not emitted: one drain point means one rate limit, and the evaluator's 250 ms
            // tick is always sooner than this loop's 2 s one.
            engine.mark_state_dirty();
        }
        tokio::time::sleep(Duration::from_millis(TARGETING_TICK_MS)).await;
    }
}

/// One pass of the targeting tick. Returns which pinned ids are reportably missing, by rule, **and
/// parks the same answer on the engine** for the two consumers that have no roster of their own.
pub fn targeting_tick(
    engine: &Arc<AutomationEngine>,
    host: &Arc<dyn EngineHost>,
    now_ms: i64,
) -> HashMap<String, HashSet<String>> {
    // §10.13: only the criteria live RULE-mode rules actually resolve. A pinned rule answers from
    // its own id list, so it must not be the reason the machine's process table is enumerated.
    let criteria: Vec<Criterion> = engine
        .snapshot_live()
        .iter()
        .filter(|l| l.rule.target_mode == TargetMode::Rule)
        .map(|l| l.rule.criterion)
        .collect();
    let rows = host.roster(&criteria);
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

        // §2.4: *"keys are cleared when … a terminal leaves the watch set"*. Three of that
        // sentence's four events were implemented and this one was not. A `Command contains` rule
        // whose terminal finishes its build drops out of the matched set holding `Fired`, and when the
        // next build starts it rejoins with that stale key — so the rule never fires again until
        // something drives its condition false first.
        for gone in previous.difference(&next) {
            engine.runtime.forget_pair(id, gone);
        }

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
    engine.set_missing(missing.clone());
    missing
}


#[cfg(test)]
mod tests {
    use super::*;
    // The fake, the canonical rule and the wiring are shared with the dry run's tests so there can
    // only ever be one of each.
    use crate::automation_engine::test_host::*;
    use crate::automation::roster::RosterRow;

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
        fake.close("tm-1");

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
                |fake: &FakeHost| fake.close("tm-1"),
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
            // The decision is made while the terminal is OPEN, and only then does the thing that
            // breaks the send happen. Building the send after breaking it would resolve the label
            // against an already-dead terminal, which is not the sequence §2.8 is about.
            let send = pending(&engine, &host, "au-1", ArmState::armed(), 1_000);
            break_it(&fake);

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
            // R17 / §2.8. The `terminal closed` row is written when there is no name left to look
            // up, which is precisely why the decision carries one — and precisely the row the Name
            // column exists to serve. An oracle reading only `(kind, detail)` let a NULL through here.
            assert_eq!(
                log_rows(&fake.store)[0].2.as_deref(),
                Some("codex · core"),
                "{}: the log lost the terminal's name",
                what
            );
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

    // =============================================================================================
    // §10.18d (local half) — the missing map reaches first paint
    // =============================================================================================

    /// **The targeting tick is the only thing that can compute `missing`, and neither consumer has a
    /// roster.** So it parks its answer where they can read it — and the defect this pins is the
    /// obvious alternative: `emit_state` and `get_automation_runtime` each passing an empty map,
    /// which flickers every *not open* pill off the moment any rule fires and again on every repaint.
    #[tokio::test(start_paused = true)]
    async fn the_targeting_tick_parks_its_missing_map_where_first_paint_reads_it() {
        let mut pinned = ctx_rule("au-1");
        pinned.target_mode = TargetMode::Pinned;
        pinned.target_ids = vec!["tm-gone".into()];
        let (engine, _fake, host) = wire(vec![pinned]);

        // Before any tick, and inside the grace window, nothing is reported missing — §4.5: at t=0 the
        // live set is empty and session restore has not run.
        assert!(!is_missing(&engine, "au-1", "tm-gone"), "reported before the grace elapsed");
        targeting_tick(&engine, &host, 1_000);
        assert!(!is_missing(&engine, "au-1", "tm-gone"), "the grace window did not hold");

        // Past the grace, the pinned id is not in the roster and is reported — through the payload
        // first paint actually calls, not through the tick's return value.
        targeting_tick(&engine, &host, 120_000);
        assert!(is_missing(&engine, "au-1", "tm-gone"), "first paint cannot see what the tick found");

        // And it is retracted the moment the terminal comes back, rather than latching.
        _fake.leaves.lock().unwrap().insert("tm-gone".into(), "pc-9".into());
        _fake.roster.lock().unwrap().push(RosterRow {
            terminal_id: Some("tm-gone".into()),
            process_id: "pc-9".into(),
            name: "Terminal-powershell".into(),
            shell: "powershell".into(),
            pid: 101,
            display_label: None,
            cwd: None,
            command_line: None,
        });
        targeting_tick(&engine, &host, 130_000);
        assert!(!is_missing(&engine, "au-1", "tm-gone"), "dormant, never dead — it came back");
    }

    fn is_missing(engine: &Arc<AutomationEngine>, rule_id: &str, tm: &str) -> bool {
        engine
            .runtime_payload()
            .rules
            .get(rule_id)
            .and_then(|pairs| pairs.get(tm))
            .is_some_and(|p| p.missing)
    }

    // =============================================================================================
    // §10.9b — the half `reload`'s own test cannot make: no SECOND message
    // =============================================================================================

    /// **Disabling one rule must not make another one send again.**
    ///
    /// `automation_engine.rs` asserts that rule B's arm keys survive rule A's toggle. That is the
    /// mechanism; this is the requirement. The easy `reload` — build a fresh map, drop the old keys —
    /// makes every B pair `Unseen`, and settled decision 7 then counts an already-true condition as a
    /// first sight: B goes silent until its next genuine crossing, with no log line and nothing on
    /// screen. The visible half of that bug is the opposite one, and it is this test: a pair put back
    /// to `Armed` types a second message into the user's terminal on the very next tick.
    #[tokio::test(start_paused = true)]
    async fn disabling_one_rule_does_not_make_another_one_send_again() {
        let (engine, fake, host) = wire(vec![
            ctx_rule_saying("au-a", "alpha speaking", 1),
            ctx_rule_saying("au-b", "bravo speaking", 2),
        ]);
        for id in ["au-a", "au-b"] {
            engine.runtime.set_arm(id, "tm-1", ArmState::armed());
        }
        fake.say("pc-1", "ctx:63%\n");
        engine.runtime.mark_dirty("pc-1");

        evaluate_tick(&engine, &host, 0, 1_000).await;
        tokio::time::sleep(Duration::from_millis(2_000)).await;
        assert_eq!(times_sent(&fake, "bravo speaking"), 1, "the premise: B has fired once");

        // The user flips A off. Nothing about B changed.
        let mut off = ctx_rule_saying("au-a", "alpha speaking", 1);
        off.enabled = false;
        off.updated_at = 2_000;
        fake.store.save_rule(&off).unwrap();
        engine.reload(&fake.store, 2_000).unwrap();

        // The value is still above the threshold, and B is still watching.
        engine.runtime.mark_dirty("pc-1");
        evaluate_tick(&engine, &host, 0, 5_000).await;
        tokio::time::sleep(Duration::from_millis(2_000)).await;

        assert_eq!(
            times_sent(&fake, "bravo speaking"),
            1,
            "B sent a second message because the reload re-armed it: {:?}",
            fake.written()
        );
        assert_eq!(
            engine.runtime.arm_state("au-b", "tm-1"),
            ArmState::Fired { at_ms: 1_000 },
            "and it is still Fired, at the instant it FIRST became true"
        );
        assert!(
            log_kinds(&fake.store).contains(&"Held".to_string()),
            "the decision must be `held`, and be visible as one: {:?}",
            log_kinds(&fake.store)
        );
        assert!(!engine.is_live("au-a"), "the premise: A really did leave the live set");
    }

    // =============================================================================================
    // The M3 review's round 1
    // =============================================================================================

    /// **R17 / §2.8, on the row it was written for.** A crossing decides, the user closes the tab, and
    /// the send fails: the `failed` row must still carry the name the terminal had when the rule
    /// decided. Resolving it at write time returns `None` for exactly this row.
    #[tokio::test(start_paused = true)]
    async fn a_log_row_carries_the_name_the_terminal_had_when_the_rule_decided() {
        let (engine, fake, host) = wired();
        let send = pending(&engine, &host, "au-1", ArmState::armed(), 1_000);
        // The decision has been made and carried; NOW the terminal goes away completely.
        fake.close("tm-1");

        run_send(engine.clone(), host.clone(), send).await;

        let rows = log_rows(&fake.store);
        assert_eq!(rows.len(), 1, "{:?}", rows);
        assert_eq!(rows[0].2.as_deref(), Some("codex · core"), "{:?}", rows);
        assert!(
            host.label_for("tm-1").is_none(),
            "the premise: there is genuinely no name left to look up"
        );
    }

    /// The paired positive: a row written while the terminal is open carries its name too, so
    /// "carries the decide-time label" is not satisfied by hard-coding one.
    #[tokio::test(start_paused = true)]
    async fn a_sent_row_carries_the_name_as_well() {
        let (engine, fake, host) = wired();
        let send = pending(&engine, &host, "au-1", ArmState::armed(), 1_000);

        run_send(engine.clone(), host.clone(), send).await;
        tokio::time::sleep(Duration::from_millis(1_500)).await;

        let rows = log_rows(&fake.store);
        assert_eq!(rows.len(), 1, "{:?}", rows);
        assert_eq!(rows[0].0, "Sent");
        assert_eq!(rows[0].2.as_deref(), Some("codex · core"));
    }

    /// **§2.4: keys are cleared when a terminal leaves the watch set.** Three of that sentence's four
    /// events were implemented; this was the fourth.
    ///
    /// The failure it prevents is silent and permanent: a `Command contains` rule watching a build
    /// fires, the build ends, the terminal drops out of the matched set still holding `Fired` — and
    /// when the next build starts it rejoins with that stale key, so the rule never fires again until
    /// something drives its condition false first.
    #[tokio::test(start_paused = true)]
    async fn a_terminal_that_leaves_the_watch_set_loses_that_pairs_arm_state() {
        let (engine, fake, host) = wire(vec![ctx_rule("au-1")]);
        fake.roster.lock().unwrap().push(RosterRow {
            terminal_id: Some("tm-2".into()),
            process_id: "pc-2".into(),
            name: "Terminal-powershell".into(),
            shell: "powershell".into(),
            pid: 102,
            display_label: Some("second".into()),
            cwd: None,
            command_line: None,
        });
        fake.leaves.lock().unwrap().insert("tm-2".into(), "pc-2".into());

        // Both terminals match `All terminals`, and both have fired.
        targeting_tick(&engine, &host, 1_000);
        for tm in ["tm-1", "tm-2"] {
            engine.runtime.set_arm("au-1", tm, ArmState::Fired { at_ms: 500 });
            engine.runtime.set_last_eval("au-1", tm, 500);
            engine.runtime.record_fire("au-1", tm, 500);
        }

        // tm-2 stops matching.
        fake.close("tm-2");
        targeting_tick(&engine, &host, 3_000);

        assert_eq!(engine.runtime.arm_state("au-1", "tm-2"), ArmState::Unseen, "the stale key survived");
        assert_eq!(engine.runtime.last_eval("au-1", "tm-2"), None);
        assert_eq!(
            engine.runtime.fire_record("au-1", "tm-2"),
            Some((1, 500)),
            "the FIRE HISTORY is not the arm state: a terminal that left the set has not un-fired"
        );
        assert_eq!(
            engine.runtime.arm_state("au-1", "tm-1"),
            ArmState::Fired { at_ms: 500 },
            "and the terminal that stayed is untouched"
        );
    }

    /// **A rollback restores; it must never CREATE.** Both sites, as a table \u2014 the queue-timeout
    /// path and the quit path both write `prev` back, and one of them being guarded is not the class
    /// being fixed.
    ///
    /// A `tm-` leaf is REUSED: Ctrl+R restarts a terminal under the same id and session restore
    /// re-registers it. A key resurrected after `cleanup_terminal_state` purged it means the next
    /// terminal to carry that leaf starts `Armed` rather than `Unseen`, and settled decision 7 \u2014 a
    /// terminal already above the threshold when it spawns must not fire without a crossing \u2014 is
    /// broken on its first read.
    #[tokio::test(start_paused = true)]
    async fn a_rollback_never_resurrects_a_pair_the_teardown_already_purged() {
        for quitting in [false, true] {
            let (engine, fake, host) = wired();
            let send = pending(&engine, &host, "au-1", ArmState::armed(), 1_000);

            // The terminal closes mid-flight, and teardown purges every `tm-`keyed entry for it.
            fake.close("tm-1");
            engine.runtime.forget_terminal("tm-1");
            if quitting {
                engine.stop();
            }

            run_send(engine.clone(), host.clone(), send).await;

            assert_eq!(
                engine.runtime.arm_state("au-1", "tm-1"),
                ArmState::Unseen,
                "quitting={}: a dead pair came back as Armed",
                quitting
            );
        }
    }

    /// The paired positive, and it is what stops the fix above being "never roll back at all": a pair
    /// the teardown did NOT purge is restored to exactly `prev`.
    #[tokio::test(start_paused = true)]
    async fn a_rollback_still_restores_a_pair_that_is_still_there() {
        for quitting in [false, true] {
            let (engine, fake, host) = wired();
            let send = pending(&engine, &host, "au-1", ArmState::re_armed(), 1_000);
            if quitting {
                engine.stop();
            } else {
                *fake.write_err.lock().unwrap() = Some("no writer".into());
            }

            run_send(engine.clone(), host.clone(), send).await;

            assert_eq!(
                engine.runtime.arm_state("au-1", "tm-1"),
                ArmState::re_armed(),
                "quitting={}: the rollback lost seen_fire, or did not happen",
                quitting
            );
        }
    }

    /// **B-1, source-derived: the engine's `spawn` must use Tauri's runtime, not tokio's directly.**
    ///
    /// `.setup()` runs on the main thread from the tao event-loop callback with no tokio runtime
    /// entered, so a bare `tokio::spawn` panics and takes the app's startup with it. This cannot be a
    /// runtime assertion — a test binary always has a runtime, which is exactly why 700 green tests
    /// said nothing about it. Every other setup-time task in `lib.rs` uses the wrapper, including
    /// `spawn_history_flush_task`, the function this call sits directly beneath.
    #[test]
    fn the_engine_is_spawned_on_tauris_runtime_because_setup_has_none() {
        let source = include_str!("../automation_engine.rs").replace("\r\n", "\n");
        let start = source.find("pub fn spawn<R: tauri::Runtime>").expect("spawn must exist");
        let body = &source[start..start + 1_400];
        let outer = body.find("spawn({").expect("it must spawn something");
        assert!(
            body[..outer].contains("tauri::async_runtime::"),
            "the OUTER spawn runs from `.setup()`, where there is no entered runtime"
        );

        let lib = include_str!("../lib.rs").replace("\r\n", "\n");
        let setup_start = lib.find("spawn_history_flush_task(state.clone());").expect("the setup site");
        let setup = &lib[setup_start..setup_start + 400];
        assert!(
            !setup.contains("tokio::spawn"),
            "a bare tokio::spawn beside the setup call is the same panic by another name"
        );
    }

    /// **B-2: R6 is per RULE, not per pair.** A `runs_once` rule watching two terminals crosses on
    /// both in one tick, and the send lock is per LEAF — so two tasks take two different locks and two
    /// messages go out on a rule the user asked to run once.
    ///
    /// §10.14c could not see this: its fixture has one terminal. *A fixture that varies only the rule
    /// dimension cannot test a rule that reads the terminal dimension too* — the standing lesson, now
    /// at a fourth site.
    #[tokio::test(start_paused = true)]
    async fn a_runs_once_rule_sends_once_across_every_terminal_it_watches() {
        let mut once = ctx_rule_saying("au-once", "once only", 1);
        once.runs_once = true;
        let (engine, fake, host) = wire(vec![once]);
        fake.roster.lock().unwrap().push(RosterRow {
            terminal_id: Some("tm-2".into()),
            process_id: "pc-2".into(),
            name: "Terminal-powershell".into(),
            shell: "powershell".into(),
            pid: 102,
            display_label: Some("second".into()),
            cwd: None,
            command_line: None,
        });
        fake.leaves.lock().unwrap().insert("tm-2".into(), "pc-2".into());
        engine.runtime.set_watched("au-once", ["tm-1".to_string(), "tm-2".to_string()].into());
        for tm in ["tm-1", "tm-2"] {
            engine.runtime.set_arm("au-once", tm, ArmState::armed());
        }
        fake.say("pc-1", "ctx:63%\n");
        fake.say("pc-2", "ctx:63%\n");
        engine.runtime.mark_dirty("pc-1");
        engine.runtime.mark_dirty("pc-2");

        evaluate_tick(&engine, &host, 0, 1_000).await;
        tokio::time::sleep(Duration::from_millis(2_000)).await;

        assert_eq!(
            times_sent(&fake, "once only"),
            1,
            "a runs-once rule typed into every terminal it watches: {:?}",
            fake.written()
        );
        assert_eq!(
            log_rows(&fake.store).iter().filter(|(k, _, _)| k == "Sent").count(),
            1,
            "and it logged every one of them"
        );
        assert!(!engine.is_live("au-once"));
    }

    /// **B-3: the log records transitions.** A rule that is working sits `Fired` with its condition
    /// true and decides `held` on every 250 ms tick. `Held` is a Decision-class kind, so it is never
    /// gated — and the 200-row per-rule cap then evicts that rule's own `sent` row inside a minute,
    /// which is the row §7.9's end-to-end story and GUI 9 check survives a relaunch.
    #[tokio::test(start_paused = true)]
    async fn a_rule_that_stays_true_logs_held_once_and_not_once_per_tick() {
        let (engine, fake, host) = wire(vec![ctx_rule("au-1")]);
        engine.runtime.set_arm("au-1", "tm-1", ArmState::armed());
        fake.say("pc-1", "ctx:63%\n");

        // The crossing, then nine more ticks with the value still above the threshold.
        for t in 1..=10 {
            engine.runtime.mark_dirty("pc-1");
            evaluate_tick(&engine, &host, 0, t * 3_000).await;
            tokio::time::sleep(Duration::from_millis(2_000)).await;
        }

        let kinds: Vec<String> = log_rows(&fake.store).into_iter().map(|(k, _, _)| k).collect();
        assert_eq!(
            kinds.iter().filter(|k| *k == "Sent").count(),
            1,
            "the premise: it fired once: {:?}",
            kinds
        );
        assert_eq!(
            kinds.iter().filter(|k| *k == "Held").count(),
            1,
            "the first `held` is a transition and says something; the next nine are the same fact \
             again, and they evict the `sent` row: {:?}",
            kinds
        );
        assert_eq!(kinds.len(), 2, "and nothing else was written at all: {:?}", kinds);
    }

    /// **H-2: `automation:state` is an ARM TRANSITION event** (§7.2), and it fired only from a
    /// successful send — so arming, re-arming and every rollback were silent and a row's pill sat on
    /// whatever it last painted. Coalesced at ≤ 1/s, because a chatty terminal transitions four times
    /// a second per pair.
    #[tokio::test(start_paused = true)]
    async fn an_arm_transition_emits_state_and_a_repeat_does_not() {
        let (engine, fake, host) = wire(vec![ctx_rule("au-1")]);
        fake.say("pc-1", "ctx:18%\n");

        // Unseen -> Armed is a transition.
        engine.runtime.mark_dirty("pc-1");
        evaluate_tick(&engine, &host, 0, 1_000).await;
        assert_eq!(fake.states.load(Ordering::Relaxed), 1, "arming was silent");

        // Armed -> Fired IS a transition, but it lands 300 ms later and the coalescer holds it.
        fake.say("pc-1", "ctx:63%\n");
        engine.runtime.mark_dirty("pc-1");
        evaluate_tick(&engine, &host, 0, 1_300).await;
        tokio::time::sleep(Duration::from_millis(1_500)).await;
        assert_eq!(fake.states.load(Ordering::Relaxed), 1, "≤ 1/s, per §7.2");

        // Past the second, the held transition is announced — **deferred, not dropped**, which is the
        // whole reason this is a flag the tick drains rather than a "may I emit now?" question. This
        // tick evaluates nothing at all (the send's settle window still covers tm-1 until 2_800), and
        // the emit still lands.
        fake.say("pc-1", "ctx:18%\n");
        engine.runtime.mark_dirty("pc-1");
        evaluate_tick(&engine, &host, 0, 2_500).await;
        assert_eq!(fake.states.load(Ordering::Relaxed), 2, "a refused emit was dropped, not deferred");

        // Out of the settle window: Fired + false is a real transition, so it is announced.
        engine.runtime.mark_dirty("pc-1");
        evaluate_tick(&engine, &host, 0, 9_000).await;
        assert_eq!(engine.runtime.arm_state("au-1", "tm-1"), ArmState::re_armed());
        assert_eq!(fake.states.load(Ordering::Relaxed), 3);

        // And still 18%: no transition at all now, so nothing to say however long we wait.
        engine.runtime.mark_dirty("pc-1");
        evaluate_tick(&engine, &host, 0, 20_000).await;
        assert_eq!(fake.states.load(Ordering::Relaxed), 3, "a repeat is not a transition");
    }

    /// **H-6: the rule can go away during the queue wait too.** The wait is up to ten seconds; a user
    /// who turns a rule off must not still be typed at afterwards. Checked in the same critical section
    /// as the terminal, because it is the same question.
    #[tokio::test(start_paused = true)]
    async fn a_rule_turned_off_while_its_send_waits_never_types() {
        let (engine, fake, host) = wired();
        let send = pending(&engine, &host, "au-1", ArmState::armed(), 1_000);
        engine.complete_rule("au-1");

        run_send(engine.clone(), host.clone(), send).await;
        tokio::time::sleep(Duration::from_millis(1_500)).await;

        assert!(fake.written().is_empty(), "{:?}", fake.written());
        let rows = log_rows(&fake.store);
        assert_eq!(rows.len(), 1, "{:?}", rows);
        assert!(rows[0].1.contains("turned off"), "{:?}", rows);
    }

    /// **H-5: every write is addressed by `pc-`, never by `tm-`** (§7.4).
    ///
    /// The fixture's two ids are deliberately different strings, and the write log threw the id away —
    /// so `deliver(.., &tm, ..)` instead of `&pc` passed every send test while addressing a map keyed
    /// the other way. In production that is a send that silently goes nowhere.
    #[tokio::test(start_paused = true)]
    async fn every_write_is_addressed_by_the_process_id() {
        let (engine, fake, host) = wired();
        let send = pending(&engine, &host, "au-1", ArmState::armed(), 1_000);

        run_send(engine.clone(), host.clone(), send).await;
        tokio::time::sleep(Duration::from_millis(1_500)).await;

        let ids = fake.written_to();
        assert!(!ids.is_empty(), "the premise: something was written");
        assert!(ids.iter().all(|id| id == "pc-1"), "a write was addressed by leaf id: {:?}", ids);
    }

}
