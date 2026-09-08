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
#[cfg(test)]
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::broadcast::error::RecvError;

use crate::automation::runtime::{ParkedSend, ECHO_SETTLE_MS};
use crate::automation::targeting::watched_set;
use crate::automation_engine::due::{
    due_now, select_due, settled_processes, BASE_TICK_MS, MAX_EVALS_PER_TICK, TARGETING_TICK_MS,
};
use crate::automation_engine::eval::{
    self, ArmState, Captures, Decision, Evaluation, Outcome, Read,
};
use crate::automation_engine::host::{EngineHost, HostPort};
use crate::automation_engine::schedule;
use crate::automation_engine::subst;
use crate::automation_engine::{AutomationEngine, LiveRule};
use crate::automation_store::{
    AutomationLogEntry, Cadence, Criterion, LogKind, TargetMode, TimerMode, TimerStep,
};
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
                log::warn!(
                    "automations: tap lagged {} messages, marking every terminal dirty",
                    n
                );
                for pc in host.live_processes() {
                    engine.runtime.mark_dirty(&pc);
                }
            }
            Ok(Err(RecvError::Closed)) => return,
        }
    }
}

#[cfg(test)]
mod task8_tests;

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
    /// This crossing's capture groups, for `run_send` to resolve `action.substitute` against.
    /// `Decision::Sent` only ever follows a `Truth::True`, and both `evaluate`'s branches only ever
    /// report that with a real match behind it — so `evaluate_pair` always hands this `Some`.
    ///
    /// `None` is §6.3's schedule send, which has no pattern and no match and therefore no groups,
    /// and the fixtures (`pending()`) that build a `PendingSend` directly for a test that is not
    /// about substitution at all; `subst::substitute` refuses a `None` the same way it refuses an
    /// empty `Captures` — only if the message actually names a token.
    pub captures: Option<Captures>,
}

/// How far the wall clock may jump between two iterations before the loop treats the gap as *this
/// process was not observing the tick* rather than as an ordinary slow tick.
///
/// 60 s against a [`BASE_TICK_MS`] of 250: two orders of magnitude of headroom over ordinary
/// jitter. Crossing it is a heuristic for a long evaluation gap, not proof of its cause: suspend,
/// clock adjustment, scheduler delay, or slow synchronous work can all produce such a gap. The cost
/// of treating an ordinary gap as a resume is one schedule that does not fire on the day it crossed.
pub const RESUME_GAP_MS: i64 = 60_000;

pub async fn run_evaluator(engine: Arc<AutomationEngine>, host: Arc<dyn EngineHost>) {
    let mut cursor = 0usize;
    // The previous iteration's `now_ms`, and the whole of the sleep/resume story. It is state
    // carried across iterations of the loop that already exists — no second task, no second timer,
    // no `interval`, and therefore nothing new to cancel at shutdown.
    let mut prev_tick_ms: Option<i64> = None;
    loop {
        if engine.stopping.load(Ordering::Relaxed) {
            return;
        }
        // Read ONCE and handed down, so the gap check and the walk cannot disagree about now.
        let now = now_ms();
        cursor = evaluator_step(&engine, &host, cursor, prev_tick_ms, now).await;
        prev_tick_ms = Some(now);
        tokio::time::sleep(Duration::from_millis(BASE_TICK_MS)).await;
    }
}

/// One iteration of the evaluator loop: **catch up on a clock gap, then evaluate.**
///
/// **The wake path `reload` never had.** `reload` seeds `last_fired_day` for any schedule whose
/// minute has already passed, so an app started at 14:00 does not type a 09:00 prompt into a live
/// agent — but it runs only at spawn and from `reload_after_commit`. A laptop that slept at 18:00
/// on Monday and opened at 10:00 on Tuesday reaches this loop with Monday's mark against a Tuesday
/// `now`, and `10:00 >= 09:00` fires the prompt five hours after the fact, every morning. A cold
/// start at 10:00 was suppressed and a lid-open at 10:00 was not — two spellings of the same
/// situation, opposite behaviour.
///
/// The seeding's own premise is *the process was not observing the tick when the minute passed*,
/// and a suspend satisfies it exactly, so the fix is to re-run **that same seeding** ([`
/// AutomationEngine::seed_missed_schedules`], one function, two callers) when the gap between two
/// iterations says nobody was watching.
///
/// **Platform-independent on purpose.** Windows emits `system:resume` from `session_notify.rs` on
/// `PBT_APMRESUMEAUTOMATIC`, which is the more precise signal and is available on exactly one of
/// the three platforms this ships to; the gap covers all of them, including a hibernate that the
/// power broadcast misses and an NTP step forward, which is the same problem wearing a different
/// hat. If anyone ever wants the precision, `system:resume` is where to get it.
///
/// `None` is the first iteration, and it needs nothing: `reload` seeded moments earlier at spawn.
/// A gap that runs BACKWARDS is deliberately not a resume — nothing was missed, and re-seeding on a
/// clock stepped back would spend a day whose minute has not arrived.
pub async fn evaluator_step(
    engine: &Arc<AutomationEngine>,
    host: &Arc<dyn EngineHost>,
    cursor: usize,
    prev_tick_ms: Option<i64>,
    now_ms: i64,
) -> usize {
    if let Some(prev) = prev_tick_ms.filter(|prev| now_ms - prev > RESUME_GAP_MS) {
        // `local_now` is a pure function of `now_ms`, which was read once by the caller, so asking
        // it here and again inside the walk cannot produce two different days — the "exactly one
        // clock per tick" property is about the timestamp, and there is still exactly one.
        //
        // The seeding writes one `held` row per day it actually spends (§7) and hands back the ids
        // an `automation:activity` is due for, because it holds no `AppHandle`. Emitted here rather
        // than folded into the state emit at the end of `evaluate_tick`: that one announces ARM
        // transitions, and a suppressed schedule changes no arm state at all — it is a log row and
        // nothing else, so the log's own event is the one that has to carry it.
        // **`prev` is the last instant anything WAS observing the tick**, and handing it down is the
        // difference between *"is this target in the past"* and *"did it go by while nobody was
        // looking"*. Without it a suspend at 08:58:50 and a resume at 09:00:00 spent the day for a
        // 09:00 rule and wrote a row saying the minute had gone by unwatched — at the instant it
        // arrived. Both instants go through `local_now`, the one conversion, so the window and the
        // day it is measured in cannot come from two different clocks.
        let emit_for = engine.seed_missed_schedules(
            &engine.snapshot_live(),
            Some(schedule::local_now(prev)),
            schedule::local_now(now_ms),
            host.store(),
            now_ms,
        );
        if !emit_for.is_empty() {
            host.emit_activity(emit_for);
        }
        // I3, alongside the seeding above: the same premise ("nobody was observing the tick")
        // applies to a parked `AfterMatch` send. A suspend does not quit TermFlow, so a send parked
        // at 17:59:50 with a 30 s delay is still in `runtime.parked` at 10:00 the next morning and,
        // unguarded, fires on the first tick after wake into whatever is now in that terminal —
        // exactly the promise `MAX_DELAY_MS`'s own doc says a suspend breaks ("a parked send lives
        // only in memory ... an unbounded wait promises something the feature cannot keep"). Reusing
        // this branch rather than a second sweep is the point: one clock, `BASE_TICK_MS`, no
        // `interval`, no new task.
        //
        // **And say so**, which nothing else here does. The seeding beside this emits `activity` for
        // the rows it writes; a dropped park writes no row and moves no arm state, so without this
        // the pair's *"Waiting to send"* pill sits on a countdown that reached zero and stopped,
        // until something unrelated repaints it. Marked and not emitted: one drain point, one rate
        // limit, and `evaluate_tick` below is that point.
        if engine
            .runtime
            .drop_stale_parked(now_ms, crate::automation_validation::MAX_DELAY_MS)
            > 0
        {
            engine.mark_state_dirty();
        }
    }
    evaluate_tick(engine, host, cursor, now_ms).await
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
    // The generation each `pc` was read at, and the processes that still owe output to a pair which
    // will not run this tick. `due_pcs` cannot express the second: a pair held off by the 250 ms floor
    // never enters `due` at all, so a SIBLING rule on the same terminal that is due would spend the
    // flag on its behalf — and the held-off pair never reads that output, ever, if the terminal then
    // goes quiet.
    let mut seen_seq: HashMap<String, u64> = HashMap::new();
    let mut owed: HashSet<String> = HashSet::new();
    // Declared before the walk because the walk itself fills it: §6.2's parked sends come due
    // inside it, alongside the crossings decided further down.
    let mut sends: Vec<PendingSend> = Vec::new();
    // §6.3's clock, read ONCE for the whole tick and never per rule.
    //
    // Two rules asked on one tick must not see different minutes: a walk that straddled 08:59/09:00
    // would fire the rules it reached after the boundary and hold the rest until the next tick, and
    // near midnight the two halves would disagree about the DAY — which is `last_fired_day`'s key, so
    // one of them would re-fire something already sent. This is also the only impure line the
    // schedule path has; everything below it is a pure predicate over this value.
    //
    // Unconditional, including on the overwhelmingly common tick where no rule has a schedule at
    // all. It is one `DateTime` conversion per 250 ms, and making it lazy would buy nothing while
    // putting the "exactly one clock per tick" property behind a memo a future edit could break.
    let now_local = schedule::local_now(now_ms);
    for live in engine.snapshot_live() {
        // Sorted, so which pairs the cap holds over is a property of the rule and not of hash order.
        let mut leaves: Vec<String> = engine
            .runtime
            .watched_for(&live.rule.id)
            .into_iter()
            .collect();
        leaves.sort();
        // **§6.3's two rule-level facts, decided BEFORE the leaves.**
        //
        // `scheduled` is *"this rule is on the schedule path"* and `fires_now` is *"and its minute
        // has come"*. Both are properties of the RULE — `schedule_due` takes no terminal at all, and
        // `last_fired_day` is keyed by rule id — so asking them per leaf would be asking the same
        // question N times and, worse, would invite the mark that answers it to be written N times.
        //
        // **The day is marked after the leaves loop, never inside it.** `set_last_fired_day` makes
        // `schedule_due` answer false for the rest of the day; written on the first leaf it answers
        // false for leaves two and three of the very same tick, so a rule with three targets sends to
        // one and starves the others — with no log row, no arm change and nothing else in the engine
        // that records a target it skipped.
        //
        // **Decided by the TIMER, not by the absence of a monitor.** §6.3: a rule whose Timer is in
        // schedule mode *"takes a new evaluation path that never reads a screen"*. Nothing forbids a
        // row from carrying both a monitor and a `DailyAt` — validation constrains neither against
        // the other, and the API and the importer can both write one — and `monitor.is_none()` as the
        // gate would leave such a rule reading the window four times a second and sending on a
        // crossing as well as on the clock. `schedule_due` is deliberately false for `AfterMatch`, so
        // it cannot double as the "is this a schedule rule" question: that is what `scheduled` is.
        let scheduled = match &live.rule.graph.timer {
            Some(TimerStep {
                mode: mode @ TimerMode::DailyAt { .. },
            }) => Some(mode),
            _ => None,
        };
        let fires_now = scheduled.is_some_and(|mode| {
            schedule::schedule_due(
                mode,
                engine.runtime.last_fired_day(&live.rule.id),
                now_local,
            )
        });
        for tm in leaves {
            // The ONE tm -> pc conversion. `None` is dormant (§4.5), not dead: no evaluation, no log
            // line, arm state untouched. Resolved BEFORE the settle check, because a pair skipped for
            // settling is a pair that still wants this terminal's output.
            let Some(pc) = host.process_for_leaf(&tm) else {
                continue;
            };
            // §6.1: drained HERE, inside the walk over `snapshot_live()`, and never by a sweep
            // over the parked map. A separate sweep would have to re-derive the cancellation rules
            // itself and would rot silently the first time a fourth one is added.
            //
            // **The gate is `forget_rule`; this placement is a second one over part of the same
            // ground.** Read the three functions rather than this comment's previous versions —
            // two of them described a mechanism that is not there.
            //
            // - `AutomationRuntime::forget_rule` runs `parked.retain(|(r, _), _| r != rule_id)`, so
            //   it drops every parked send belonging to one rule.
            // - `AutomationEngine::reload` calls it for every rule that is absent from the map it
            //   just built or whose `updated_at` moved. **Disabled** and **deleted** are absent
            //   (the `!enabled || completed_at.is_some()` filter is `reload`'s own, applied while
            //   it BUILDS that map, and a deleted row never comes back from `list_rules` at all);
            //   an **edit** moves `updated_at`. `complete_rule` calls it directly for the fourth
            //   case, which is not a command and so never reaches `reload`.
            // - Every command that changes a definition reloads, through `reload_after_commit` —
            //   `automation_commands.rs` asserts that is the only call site.
            //
            // So all three cancellations are closed wherever the drain sits, which is why Task 17's
            // placement mutation killed none of the three tests. `snapshot_live()` filters NOTHING
            // of its own: it clones the whole `live` map and sorts it.
            //
            // What the placement adds is a second, independent gate for **disabled** and **deleted**
            // only — such a rule is not in `live`, so the walk never reaches any drain inside it —
            // and an `Arc<LiveRule>` already in hand, which a future drain that has to resolve one
            // to build its message would inherit. It does nothing for an edited rule, which is
            // still live and still walked.
            //
            // Ahead of the settle window and the cadence gate, and both are deliberate: neither is
            // about this. Settling means *nothing READS this terminal*, and a drain reads nothing.
            // The cadence gate asks whether the pair is due for an EVALUATION — and the terminal
            // this feature exists for is the one that printed `API error` and then went quiet, so
            // it is never due again and a drain behind that gate would never run at all.
            //
            // `at_ms` is NOW, not the crossing's stamp. `run_send` measures the echo needle and the
            // settle window forward from it (`landed = at + began.elapsed()`), so a stamp 30 s in
            // the past would open a window that had already closed and expire the needle for the
            // message it is about to type.
            if let Some(parked) = engine.runtime.take_parked_due(&live.rule.id, &tm, now_ms) {
                admit(
                    &mut sends,
                    PendingSend {
                        // **`parked.pc`, never the `pc` this tick just resolved.** The restart
                        // guard in `run_send` compares the leaf's process at lock time against
                        // this field; filled from the drain's own lookup it compares a value
                        // against itself and the whole park is unguarded.
                        pair: Pair {
                            rule: live.clone(),
                            tm: tm.clone(),
                            pc: parked.pc,
                        },
                        prev: parked.prev,
                        label: parked.label,
                        at_ms: now_ms,
                        captures: parked.captures,
                    },
                );
            }
            let seq = engine.runtime.dirty_seq(&pc);
            // The EARLIEST read wins: anything the tap adds later must survive this tick's clear.
            if let Some(seq) = seq {
                seen_seq.entry(pc.clone()).or_insert(seq);
            }
            // **§6.3's dispatch, and the end of the road for a schedule rule.** No `due_now`, no
            // `eval::evaluate`, no `host.tail`, no `set_last_eval` and no arm write: there is nothing
            // to read and therefore nothing that could have been read.
            //
            // **Above the settle gate, for the parked drain's own reason one screen up.** Settling
            // means *nothing READS this terminal*, and this reads nothing. Below it, a target that
            // happened to be inside another rule's `ECHO_SETTLE_MS` window at 09:00 would be skipped
            // — and because the day is marked after the leaves whether or not a leaf was reachable,
            // skipped for the whole day.
            //
            // **Below the dirty bookkeeping, deliberately.** A monitor-less rule already reached
            // `dirty_seq`/`seen_seq` before falling out at the monitor guard below, and keeping that
            // unchanged is the conservative direction: `seen_seq` holds the EARLIEST generation seen,
            // and an earliest that is too early can only refuse a clear (costing one re-read), while
            // a later one throws away output no pair has seen. It joins neither `due` nor `owed`,
            // which is what the monitor guard's own comment says of a pair that reads nothing.
            //
            // `process_for_leaf` returning `None` skipped this leaf several lines up (§4.5, dormant);
            // the day is still marked for it, so a terminal asleep at 09:00 is not nagged at 14:00.
            if scheduled.is_some() {
                if fires_now {
                    admit(
                        &mut sends,
                        PendingSend {
                            pair: Pair {
                                rule: live.clone(),
                                tm: tm.clone(),
                                pc,
                            },
                            // **Read, not assumed.** `prev` is what `run_send`'s three failure paths
                            // roll back to, and a schedule rule has no crossing to roll back to — so
                            // the only correct target is whatever is already there, which makes
                            // `restore_arm` write back the value it just read. A constant `Unseen`
                            // would be a no-op for a pure schedule rule and would DESTROY the arm
                            // state of a rule that also carries a monitor.
                            prev: engine.runtime.arm_state(&live.rule.id, &tm),
                            // Resolved at DECIDE time like every other route (§2.8, R17): the
                            // `failed — the terminal closed` row is written when there is no name
                            // left to look up, and a schedule send waits on the same queue as any
                            // other.
                            label: host.label_for(&tm),
                            // NOW, for the parked drain's reason: `run_send` measures the echo needle
                            // and the settle window forward from this stamp.
                            at_ms: now_ms,
                            // No pattern, no match, no groups. `subst::substitute` refuses a `None`
                            // only if the message actually names a token, so a schedule rule written
                            // with a `$1` in it fails honestly and logs why, rather than typing a raw
                            // template into a live agent.
                            captures: None,
                        },
                    );
                }
                continue;
            }
            // §2.6 layer 2: this terminal is still settling after a send, so nothing reads it. It does
            // not join `owed`: settling is keyed by the LEAF and a leaf has exactly one process, so
            // every pair on a settling terminal skips together and the process never reaches
            // `due_pcs` at all. There is nothing for a sibling to spend on its behalf.
            if engine.runtime.is_settling(&tm, now_ms) {
                continue;
            }
            // A rule with no monitor step has no cadence and is never due for a READ — there is
            // nothing for it to read. It joins neither `due` nor `owed`: a pair that reads nothing
            // cannot consume this terminal's dirty signal and must not hold its clear back either.
            //
            // A §6.3 schedule rule left the walk at the branch above and never reaches this line,
            // monitor or no monitor. What survives here is the shape this guard was written for: a
            // row with neither a monitor nor a schedule, which is not constructible through the
            // editor and does nothing if it arrives some other way.
            let Some(monitor) = live.rule.graph.monitor.as_ref() else {
                continue;
            };
            if due_now(
                monitor.cadence,
                monitor.every_ms,
                seq.is_some(),
                engine.runtime.last_eval(&live.rule.id, &tm),
                now_ms,
            ) {
                due.push(Pair {
                    rule: live.clone(),
                    tm,
                    pc,
                });
            } else if monitor.cadence == Cadence::OnOutput {
                // No `seq.is_some()` here, deliberately: a CLEAN process contributes no due pair, so
                // it never reaches `due_pcs` and `settled_processes` can never name it — the extra
                // condition cannot change an outcome, which is exactly why no test could hold it.
                // The cadence check CAN: without it a timer rule waiting out its interval would keep
                // its terminal permanently dirty, and every on-output rule on it would re-read the
                // same text every tick.
                owed.insert(pc.clone());
            }
        }
        // **After the leaves, and unconditional once `schedule_due` said yes** — including when not
        // one leaf was reachable and nothing was actually sent. The rule's turn for today has passed.
        //
        // The alternative, marking only when a send was pushed, means a 09:00 rule with no watched
        // terminal at 09:00 delivers its prompt the moment one appears at 14:00: nagging on arrival,
        // per terminal, which plan 028 Q3 ruled against for arm state and which §6.3's launch seeding
        // exists to prevent for exactly this rule kind. The cost is the opposite edge — an app that
        // starts at 08:59:59 with no leaf yet indexed silently skips that day — and a late prompt
        // typed into a live agent is the worse of the two.
        if fires_now {
            let Some(TimerMode::DailyAt { minute_of_day, .. }) = scheduled else {
                unreachable!("fires_now requires a daily schedule");
            };
            engine
                .runtime
                .set_last_fired_day(&live.rule.id, now_local.day_ordinal, *minute_of_day);
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

    for i in &picked {
        match evaluate_pair(engine, host, &due[*i], now_ms) {
            Evaluated::Read(Some(send)) => admit(&mut sends, send),
            // Read, decided, nothing to send: this pair has consumed the output and may spend it.
            Evaluated::Read(None) => {}
            // **The third door.** `settled_processes`'s enumeration named two and this was neither:
            // the pair was due, it was picked, it is not in `owed` — and it read nothing at all, so
            // clearing its process throws away output no pair has seen. It reaches `due_pcs` like any
            // other pair, which is exactly why no reasoning about `picked` can see it.
            Evaluated::Unread => {
                owed.insert(due[*i].pc.clone());
            }
        }
    }

    // Only now, only for terminals no pair is still owed, and only if the tap has not moved since.
    for pc in settled_processes(&due_pcs, &picked, &owed) {
        if let Some(seq) = seen_seq.get(&pc) {
            engine.runtime.clear_dirty(&pc, *seq);
        }
    }

    // §2.5: a crossing dispatches its write OFF the tick. Route A's send holds a load-bearing 500 ms
    // sleep, and awaiting it inline would stall every rule on every terminal for the duration — four
    // sends in one tick would freeze evaluation for two seconds. Serialisation is unaffected: it was
    // never the tick that provided it, it was the per-terminal lock.
    for send in sends {
        // A crossing owns its destinations and all of their shared bookkeeping. In particular, a
        // webhook-only rule has no terminal destination: never manufacture an ActionStep merely to
        // route it through `run_send`, because an empty action can submit a bare Enter.
        if send.pair.rule.rule.graph.action.is_none() && send.pair.rule.rule.graph.webhook.is_none()
        {
            continue;
        }
        let engine = engine.clone();
        let host = host.clone();
        tokio::spawn(async move { run_crossing(engine, host, send).await });
    }

    if engine.take_state_emit(now_ms) {
        host.emit_state();
    }

    next_cursor
}

/// Put one decided crossing on this tick's dispatch list.
///
/// Both immediate and parked crossings use this one dispatch seam. Admission, including the
/// runs-once claim, belongs to `run_crossing`: it is crossing-wide bookkeeping rather than a
/// property of either destination.
fn admit(sends: &mut Vec<PendingSend>, send: PendingSend) {
    sends.push(send);
}

/// What one pair's evaluation leaves for the tick to do.
///
/// The two arms answer **different questions**, and collapsing them into `Option<PendingSend>` is
/// what hid H-6: `None` meant both *"read the output and decided not to send"* and *"there was no
/// output to read"*, and only the first of those has consumed the terminal's dirty signal.
pub enum Evaluated {
    /// This pair read the terminal's output. A send, if the read was a crossing.
    Read(Option<PendingSend>),
    /// §4.5's dormant terminal: no screen, so no evaluation, no log row and no arm change. Nothing
    /// was read, so nothing may be spent on this pair's behalf.
    Unread,
}

/// Evaluate one pair and record what it decided.
pub fn evaluate_pair(
    engine: &Arc<AutomationEngine>,
    host: &Arc<dyn EngineHost>,
    pair: &Pair,
    now_ms: i64,
) -> Evaluated {
    let rule = &pair.rule.rule;
    let prev = engine.runtime.arm_state(&rule.id, &pair.tm);
    let echoes = engine.runtime.echoes_for(&pair.tm, now_ms);
    let port = HostPort(host.as_ref());

    // **§3.1's three input steps and the compiled pattern, proved present ONCE.** The pure core
    // keeps concrete references and never learns that either can be absent.
    //
    // `Unread` for a schedule rule (§6.3), and `Unread` is literally true of it: nothing was read,
    // so nothing may be spent — no arm move, no log row, no `set_last_eval`. It is deliberately not
    // `Read(None)`, which would mean *"read the output and decided not to send"* and would let this
    // pair spend a dirty flag another pair still needs.
    //
    // **The two halves are ONE condition, which is why they are one `let … else`.** `reload` gives
    // a rule `re: None` if and only if it has no `parse` step, and `InputSteps::of` refuses on
    // exactly that — so neither `Option` is ever the deciding one on its own. Measured, not
    // assumed: defaulting the regex here to a match-everything `""` leaves
    // `a_schedule_rule_reads_nothing_sends_nothing_and_logs_nothing` GREEN, and so does defaulting
    // the steps, because a third guard (the monitor-less pair never becoming due, in
    // `evaluate_tick` above) also stands in the way. All three had to be defaulted before that test
    // failed. Neither half is removable — `evaluate` needs a `&Regex` and a `&CondStep`, and these
    // are `Option`s — so this is not a redundant guard to delete but one decision written once.
    //
    // **A schedule rule no longer reaches this function at all**: `evaluate_tick`'s §6.3 branch
    // takes every rule whose timer is `DailyAt` out of the walk before a pair is ever built. This
    // guard stays because it is the one that makes the absence of the three input steps a fact the
    // pure core never learns, and because `dry.rs` reaches `eval::evaluate` by another door.
    let (Some(steps), Some(re)) = (eval::InputSteps::of(&rule.graph), pair.rule.re.as_ref()) else {
        return Evaluated::Unread;
    };

    let Some(ev): Option<Evaluation> =
        eval::evaluate(steps, re, &echoes, prev, &port, &pair.pc, now_ms)
    else {
        // `host.tail` found no parser for this process — it closed between this tick's leaf
        // resolution and the read. §4.5: no evaluation, no row, arm state untouched. `set_last_eval`
        // is deliberately not reached either, so the pair is due again immediately.
        return Evaluated::Unread;
    };

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
    engine
        .runtime
        .set_last_decision(&rule.id, &pair.tm, ev.decision);

    if !ev.decision.sends() {
        // Live by construction: `evaluate_pair` only runs for a pair whose leaf just resolved.
        let name = host.label_for(&pair.tm);
        append(
            host,
            &rule.id,
            Some(&pair.tm),
            name,
            kind_for(&ev, repeat),
            &ev.detail,
            now_ms,
        );
        return Evaluated::Read(None);
    }

    // §6.2: the Wait step. The crossing has HAPPENED — `set_arm` wrote `Fired` above, the decision
    // is `Sent` and the log will say so when the message goes out — but the message itself waits.
    // It is parked, not slept on: `run_send` is never spawned here, no task exists between now and
    // the drain, and the thing that eventually dispatches it is the same 250 ms tick that decided
    // it. `Read(None)` and not `Unread`, because this pair genuinely READ the terminal's output —
    // that read is how it found the match — so the dirty flag is spent exactly as it would have
    // been by a send.
    if let Some(TimerStep {
        mode: TimerMode::AfterMatch { delay_ms },
    }) = &rule.graph.timer
    {
        engine.runtime.park(
            &rule.id,
            &pair.tm,
            ParkedSend {
                due_at_ms: now_ms + delay_ms,
                // The crossing's own process, captures and `prev`, for the same reasons
                // `PendingSend` carries them — and more sharply here, because by the time this
                // fires the terminal has scrolled on and there is nothing left to re-read. `pc` is
                // what makes `run_send`'s restart guard cover the WAIT and not just the queue: see
                // `ParkedSend::pc`.
                pc: pair.pc.clone(),
                captures: ev.captures,
                prev,
                label: host.label_for(&pair.tm),
            },
        );
        return Evaluated::Read(None);
    }

    Evaluated::Read(Some(PendingSend {
        pair: pair.clone(),
        prev,
        // Resolved at DECIDE time and carried, per §2.8: the `failed — the terminal closed` entry is
        // written after the terminal is gone, when there is no name left to look up.
        label: host.label_for(&pair.tm),
        at_ms: now_ms,
        // This crossing's own captures, so `run_send` resolves `$1`/`$2` against the match that
        // actually fired rather than re-reading the terminal after the fact.
        captures: ev.captures,
    }))
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
// The crossing and its destinations (§2.5, §2.6, A8)
// =================================================================================================

/// The result of one destination, deliberately separate from the crossing's shared state.
enum DestinationOutcome {
    Sent,
    Failed(String),
    Stopped,
}

/// Dispatch both destinations for one already-decided crossing, then perform its bookkeeping once.
///
/// A terminal delivery and a webhook are independent side effects: one failure must not prevent the
/// other from running. Their common effects — the fire history, runs-once completion, and rollback —
/// are therefore deliberately below the join, where there is one answer for the crossing rather than
/// one answer per destination.
async fn run_crossing(engine: Arc<AutomationEngine>, host: Arc<dyn EngineHost>, send: PendingSend) {
    let rule = &send.pair.rule.rule;
    if engine.stopping.load(Ordering::Relaxed) {
        rollback_crossing(&engine, &send);
        return;
    }

    // R6 is per crossing, not per terminal destination. This task begins at the one shared
    // boundary before the concurrent sends, so a second crossing cannot send either destination
    // after the first one has claimed the rule.
    if rule.runs_once && !engine.runtime.claim_once(&rule.id) {
        append(
            &host,
            &rule.id,
            Some(&send.pair.tm),
            send.label.clone(),
            LogKind::Held,
            "not sent — this rule runs once, and another terminal had already claimed its one send",
            send.at_ms,
        );
        return;
    }

    let has_action = rule.graph.action.is_some();
    let has_webhook = rule.graph.webhook.is_some();
    let (terminal, webhook) = tokio::join!(
        async {
            if has_action {
                Some(run_send(&engine, &host, &send).await)
            } else {
                None
            }
        },
        async {
            if has_webhook {
                Some(run_webhook(&engine, &send).await)
            } else {
                None
            }
        },
    );

    let outcomes = [terminal, webhook];
    if outcomes
        .iter()
        .flatten()
        .any(|outcome| matches!(outcome, DestinationOutcome::Stopped))
    {
        rollback_crossing(&engine, &send);
        return;
    }

    let mut sent = false;
    if let Some(outcome) = outcomes[0].as_ref() {
        match outcome {
            DestinationOutcome::Sent => {
                sent = true;
                append(
                    &host,
                    &rule.id,
                    Some(&send.pair.tm),
                    send.label.clone(),
                    LogKind::Sent,
                    &sent_detail(&send),
                    send.at_ms,
                );
            }
            DestinationOutcome::Failed(reason) => append(
                &host,
                &rule.id,
                Some(&send.pair.tm),
                send.label.clone(),
                LogKind::Failed,
                reason,
                send.at_ms,
            ),
            DestinationOutcome::Stopped => unreachable!("stopped outcomes returned above"),
        }
    }
    if let Some(outcome) = outcomes[1].as_ref() {
        match outcome {
            DestinationOutcome::Sent => {
                sent = true;
                append(
                    &host,
                    &rule.id,
                    None,
                    None,
                    LogKind::Sent,
                    &webhook_sent_detail(&send),
                    send.at_ms,
                );
            }
            DestinationOutcome::Failed(reason) => append(
                &host,
                &rule.id,
                None,
                None,
                LogKind::Failed,
                reason,
                send.at_ms,
            ),
            DestinationOutcome::Stopped => unreachable!("stopped outcomes returned above"),
        }
    }

    if !sent {
        rollback_crossing(&engine, &send);
        return;
    }

    // One crossing records one fire however many destinations completed. A terminal echo/settle
    // remains owned by `run_send`, because only terminal bytes can be echoed back into a screen.
    engine
        .runtime
        .record_fire(&rule.id, &send.pair.tm, send.at_ms);
    complete_crossing(&engine, &host, &send);
    engine.mark_state_dirty();
}

/// Take the terminal's queue, re-check it is still there, and write its destination.
///
/// This function has no crossing bookkeeping: `run_crossing` aggregates its result with the webhook
/// before it records a fire, completes a runs-once rule, or rolls an arm back.
async fn run_send(
    engine: &Arc<AutomationEngine>,
    host: &Arc<dyn EngineHost>,
    send: &PendingSend,
) -> DestinationOutcome {
    let rule = &send.pair.rule.rule;
    let tm = send.pair.tm.clone();
    let Some(action) = rule.graph.action.as_ref() else {
        return DestinationOutcome::Failed("the rule has no terminal destination".into());
    };
    // **Before the queue.** §2.6 layer 2 runs for `ECHO_SETTLE_MS` after the WRITE, and the wait for
    // this terminal's lock is up to `SEND_QUEUE_TIMEOUT_MS` of the distance between the decision and
    // that write. Started after the lock, this measured only `deliver` — so the second and later
    // sends of a queue set a window that had already been running for the whole of their wait, which
    // is the same defect the round-1 fix was for, one step further back.
    let began = tokio::time::Instant::now();
    let lock = engine.runtime.send_lock(&tm);

    let _guard =
        match tokio::time::timeout(Duration::from_millis(SEND_QUEUE_TIMEOUT_MS), lock.lock()).await
        {
            Ok(guard) => guard,
            Err(_) => {
                return DestinationOutcome::Failed("another rule was still sending".into());
            }
        };

    // Inside the lock, because the terminal can close between the decision and our turn at the queue.
    let Some(pc) = host.process_for_leaf(&tm) else {
        return DestinationOutcome::Failed(
            "the terminal closed before the message was sent".into(),
        );
    };

    // **And it can close AND COME BACK, which resolving by leaf alone cannot see.** `tm-` is durable
    // across a restart and `IdentityIndex::index` overwrites `leaf_to_process[tm]` unconditionally on
    // every spawn, so a Ctrl+R inside the queue wait — up to `SEND_QUEUE_TIMEOUT_MS`, and any second
    // rule watching this terminal puts us in that wait — leaves the lookup above returning a `pc` for
    // a run that never printed the matched text. The closed-terminal guard cannot catch it, because
    // the question it asks ("does this leaf resolve?") has the same answer for a live terminal and a
    // replaced one. `Pair` already carries the `pc` this crossing was READ from, so ask the question
    // that does distinguish them: a message decided from one run must never be typed into the next,
    // which with `submit: true` also executes it there.
    //
    // **The window is the whole distance from the crossing, not just the queue.** §6.2's parked
    // send is decided up to `MAX_DELAY_MS` before it is drained, and `ParkedSend::pc` is what
    // carries the crossing's process across that wait — built from the drain's own lookup instead,
    // this comparison would be a value against itself for every delayed rule.
    if pc != send.pair.pc {
        return DestinationOutcome::Failed(
            "the terminal restarted before the message was sent".into(),
        );
    }

    // And so can the RULE. The queue wait is up to ten seconds, and a user who disables a rule inside
    // it must not still be typed into afterwards. Checked in the same critical section as the
    // terminal, because it is the same question: is this crossing still something the user wants?
    //
    // It no longer stands in for R6 — the single-run claim is taken where the crossing is decided —
    // and that is what makes the refusal's own words true. It used to be reached by a `runs_once` rule
    // that completed on another terminal, and told the user their rule had been turned off when
    // nobody had touched it.
    if !engine.is_live(&rule.id) {
        return DestinationOutcome::Failed(
            "the rule was turned off before the message was sent".into(),
        );
    }

    // §2.1: checked before the FIRST write and never between the paste and the submit, so a quit
    // leaves the send either unstarted or complete — there is no half-typed line to reason about.
    if engine.stopping.load(Ordering::Relaxed) {
        return DestinationOutcome::Stopped;
    }

    let body = if action.substitute {
        match subst::substitute(&action.message, send.captures.as_ref()) {
            Ok(s) => s,
            // §4.4: refuse. A message with a live `$3` still in it typed into a running agent is
            // the "unintended content" this whole feature exists to prevent, and a refusal that is
            // logged is the safe fallback it asks for instead.
            Err(e) => {
                return DestinationOutcome::Failed(format!(
                    "nothing sent — {e} had no value at the moment it fired"
                ));
            }
        }
    } else {
        action.message.clone()
    };
    let (separator, end_indicator) =
        crate::api_server::get_cli_pattern(&action.cli_type).unwrap_or(("", "\r"));
    let outcome = crate::automation::send::deliver(
        &HostPort(host.as_ref()),
        &pc,
        &action.cli_type,
        crate::automation::send::SubmitPattern {
            separator,
            end_indicator,
        },
        &body,
        action.submit,
    )
    .await;

    if let Err(e) = outcome {
        return DestinationOutcome::Failed(format!("the message could not be sent: {}", e));
    }

    let at = send.at_ms;
    // The moment the last byte went out: the decision's stamp plus everything that has happened
    // since this task started — the wait for the terminal's queue AND the paste-to-submit gap. `at`
    // stays the DECISION's stamp and keeps the log row, the fire history and `mark_completed`, which
    // record when the crossing happened and not when the typing finished.
    let landed = at + began.elapsed().as_millis() as i64;
    // §2.6 layer 1, then layer 2: the needle first, so a tick that slips through the settle window
    // still strips it. The needle is `body` — what actually reached the terminal — never
    // `action.message`: with substitution on, the terminal echoes the RESOLVED text, and a needle
    // still carrying `$1` would never match it.
    engine
        .runtime
        .push_echo(&tm, &crate::automation::send::normalise(&body), landed);
    engine.runtime.settle_until(&tm, landed + ECHO_SETTLE_MS);
    DestinationOutcome::Sent
}

/// Post the webhook destination for this crossing. It intentionally never reaches the terminal
/// queue lock: a slow endpoint must not serialise terminal writes, and a terminal failure must not
/// suppress an already-decided webhook.
async fn run_webhook(engine: &Arc<AutomationEngine>, send: &PendingSend) -> DestinationOutcome {
    let rule = &send.pair.rule.rule;
    let Some(webhook) = rule.graph.webhook.as_ref() else {
        return DestinationOutcome::Failed("the rule has no webhook destination".into());
    };
    if engine.stopping.load(Ordering::Relaxed) {
        return DestinationOutcome::Stopped;
    }
    if !engine.is_live(&rule.id) {
        return DestinationOutcome::Failed(
            "the rule was turned off before the webhook was sent".into(),
        );
    }
    let body = if webhook.substitute {
        match subst::substitute(&webhook.body, send.captures.as_ref()) {
            Ok(body) => body,
            Err(e) => {
                return DestinationOutcome::Failed(format!(
                    "webhook not sent — {e} had no value at the moment it fired"
                ))
            }
        }
    } else {
        webhook.body.clone()
    };
    match crate::automation_webhook::send_body(webhook, &body).await {
        Ok(()) => DestinationOutcome::Sent,
        Err(error) => DestinationOutcome::Failed(format!("webhook failed: {error}")),
    }
}

/// Complete a successful crossing once, after every destination has returned.
fn complete_crossing(
    engine: &Arc<AutomationEngine>,
    host: &Arc<dyn EngineHost>,
    send: &PendingSend,
) {
    let rule = &send.pair.rule.rule;
    let tm = &send.pair.tm;
    let at = send.at_ms;
    // §7.8 — completion is an in-memory event FIRST and a row second, after every destination.
    // `reload` runs from mutating store commands and this is the engine, which is not one: without
    // the in-memory removal the rule stays live in `Fired`, re-arms the moment its value drops, and
    // sends a SECOND message in the same session from a row the UI already shows as Completed.
    if rule.runs_once {
        // `Ok(false)` is "no row matched" — the rule was deleted from another window inside this very
        // crossing — and the completion has then reached disk exactly as little as it does on `Err`.
        // Reading only the `Err` arm let that case pass for a successful write.
        let persisted = match host.store().mark_completed(&rule.id, at) {
            Ok(stamped) => stamped,
            Err(e) => {
                log::warn!("automations: could not mark {} completed: {}", rule.id, e);
                false
            }
        };
        engine.complete_rule(&rule.id);
        if !persisted {
            // **The in-memory removal above stays, and that is the deliberate half.** It is what
            // stops this rule sending a SECOND message in this session, and dropping it to keep
            // memory and disk in step would reintroduce precisely the defect §7.8's ordering exists
            // to prevent: the rule re-arms on the next dip and fires again, on every crossing.
            //
            // What no ordering can save is the next launch. `reload` filters on `completed_at`, so a
            // completion that never reached disk lets the rule run again in a later session, and that
            // stamp is the only durable record there is. So the honest move is to make the divergence
            // VISIBLE rather than leave a `log::warn` nobody reads beside a row that will go on
            // describing the rule as armed. This append can fail for the same reason the stamp did —
            // it is the same database — and then the warning above is genuinely all that is left.
            append(
                &host,
                &rule.id,
                Some(tm),
                None,
                LogKind::Failed,
                "fired, but its completion could not be recorded — it may run again after a restart",
                at,
            );
        }
        // And TELL the windows, which nothing else does. `mark_state_dirty` below is not this: it
        // announces arm transitions, and `complete_rule` has just removed this rule from the live
        // set, so the next state payload omits it and every open row falls back to *Armed · waiting*
        // and *Not fired since it started running*. Only a refetch of the RULES carries
        // `completed_at`, and that is what makes the pill read *Completed*, the toggle go inert and
        // Reset appear.
        //
        // Announced whether or not the stamp persisted. On the success path that is the whole point;
        // on the failure path the rules refetch carries nothing new — the `failed` row above is what
        // the user sees, through `append`'s own activity emit — and one unconditional call beats a
        // branch whose only effect is to skip a cheap no-op.
        //
        // This is **not** the command layer's "a failed reload still announces" rule, which an
        // earlier version of this comment claimed it was. There the write has already committed and
        // only the re-read failed, so *refetch, disk is truth* is exactly right. Here the write is
        // the thing that failed, which makes disk stale rather than true.
        host.emit_changed(vec![rule.id.clone()]);
    }
}

fn sent_detail(send: &PendingSend) -> String {
    match &send.label {
        Some(name) => format!("sent to {}", name),
        None => "sent".to_string(),
    }
}

fn webhook_sent_detail(send: &PendingSend) -> String {
    let provider = send
        .pair
        .rule
        .rule
        .graph
        .webhook
        .as_ref()
        .expect("a webhook outcome requires a webhook step")
        .provider;
    format!("webhook sent via {provider:?}")
}

/// Roll one wholly failed crossing back to exactly the arm state it had when it was decided.
fn rollback_crossing(engine: &Arc<AutomationEngine>, send: &PendingSend) {
    let rule_id = &send.pair.rule.rule.id;
    engine
        .runtime
        .restore_arm(rule_id, &send.pair.tm, send.prev);
    // A rollback restores; it never creates. The claim was taken when this crossing was DECIDED, so a
    // crossing that produced no message must give it back — otherwise one queue timeout retires a
    // single-run rule that has never sent anything.
    if send.pair.rule.rule.runs_once {
        engine.runtime.release_once(rule_id);
    }
    engine.mark_state_dirty();
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
    match host.store().append(&entry) {
        Ok(Some(outcome)) if outcome.emit => host.emit_activity(outcome.rule_ids),
        Ok(_) => {}
        Err(e) => log::warn!(
            "automations: could not write a log row for {}: {}",
            rule_id,
            e
        ),
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
    let mut last: (
        HashMap<String, HashSet<String>>,
        HashMap<String, HashSet<String>>,
    ) = (HashMap::new(), HashMap::new());
    loop {
        if engine.stopping.load(Ordering::Relaxed) {
            return;
        }
        // `spawn_blocking`, because `AppState`'s roster may take a `System` snapshot:
        // `new_all()` is 50-200 ms, and `ProcSnapshot`'s own doc says this call belongs off a
        // tokio worker.
        let (e, h) = (engine.clone(), host.clone());
        let pass = match tokio::task::spawn_blocking(move || targeting_tick(&e, &h, now_ms())).await
        {
            Ok(pass) => pass,
            Err(e) => {
                // `unwrap_or_default()` here turned a panicked roster pass into an EMPTY one, which
                // is not the same thing: it reset the diff's `missing` to nothing while the engine's
                // parked copy stayed stale, so the next real pass announced a change that had not
                // happened — and said nothing about the panic. A pass that did not run produces no
                // diff at all.
                log::warn!("automations: the targeting pass panicked: {}", e);
                tokio::time::sleep(Duration::from_millis(TARGETING_TICK_MS)).await;
                continue;
            }
        };
        // Only when the answer CHANGED. A pill that says *not open* is state the UI shows, so a
        // change has to reach it — but emitting every 2 s regardless would repaint every open
        // Settings page for the life of the app to say nothing happened.
        //
        // Both halves come from the SAME pass. Re-deriving `watched` from a second `snapshot_live()`
        // let a `reload` land between them, so the rule list the diff was keyed on and the roster it
        // was computed from could disagree for one pass.
        let now = (pass.watched, pass.missing);
        if now != last {
            last = now;
            // Marked, not emitted: one drain point means one rate limit, and the evaluator's 250 ms
            // tick is always sooner than this loop's 2 s one.
            engine.mark_state_dirty();
        }
        tokio::time::sleep(Duration::from_millis(TARGETING_TICK_MS)).await;
    }
}

/// What one pass of the targeting tick resolved.
///
/// Both fields come from one `snapshot_live()`, which is the point: the caller diffs them against the
/// previous pass, and deriving either half from a second snapshot lets a `reload` in between make the
/// two disagree for a tick.
pub struct TargetingPass {
    /// Pinned ids that are reportably missing, by rule.
    pub missing: HashMap<String, HashSet<String>>,
    /// What each live rule watches, as this pass resolved it.
    pub watched: HashMap<String, HashSet<String>>,
}

/// One pass of the targeting tick. Returns what it resolved, **and parks `missing` on the engine**
/// for the two consumers that have no roster of their own.
pub fn targeting_tick(
    engine: &Arc<AutomationEngine>,
    host: &Arc<dyn EngineHost>,
    now_ms: i64,
) -> TargetingPass {
    // ONE snapshot for the whole pass. Taken twice, the criteria list and the rule list could come
    // from different `reload`s.
    let rules = engine.snapshot_live();
    // §10.13: only the criteria live RULE-mode rules actually resolve. A pinned rule answers from
    // its own id list, so it must not be the reason the machine's process table is enumerated.
    let criteria: Vec<Criterion> = rules
        .iter()
        .filter(|l| l.rule.target_mode == TargetMode::Rule)
        .flat_map(|l| std::iter::once(l.rule.criterion).chain(l.rule.exclude_criterion))
        .collect();
    let rows = host.roster(&criteria);
    // Indexed once, outside the rule loop: the snapshot walk below wants the row for a terminal it
    // already knows it watches, and scanning the whole roster per rule made that `rules × roster`.
    let by_id: HashMap<&str, &crate::automation::roster::RosterRow> = rows
        .iter()
        .filter_map(|r| r.terminal_id.as_deref().map(|t| (t, r)))
        .collect();
    let live_leaves: HashSet<&str> = rows
        .iter()
        .filter_map(|r| r.terminal_id.as_deref())
        .collect();
    let grace_over = crate::automation::roster::grace_elapsed(now_ms, engine.started_at_ms());
    let mut missing = HashMap::new();
    let mut watched: HashMap<String, HashSet<String>> = HashMap::new();

    for live in &rules {
        let id = &live.rule.id;
        // `watched_for` cannot say "never resolved", and does not need to: `watched_set` re-resolves
        // an EMPTY frozen set rather than treating it as a decision, so an empty previous and no
        // previous behave identically. (M2's dual review; the alternative was a distinction with no
        // consumer.)
        let previous: BTreeSet<String> = engine.runtime.watched_for(id).into_iter().collect();
        let next = watched_set(&live.rule, &rows, Some(&previous));
        engine
            .runtime
            .set_watched(id, next.iter().cloned().collect());

        // §2.4: *"keys are cleared when … a terminal leaves the watch set"*. Three of that
        // sentence's four events were implemented and this one was not. A `Command contains` rule
        // whose terminal finishes its build drops out of the matched set holding `Fired`, and when the
        // next build starts it rejoins with that stale key — so the rule never fires again until
        // something drives its condition false first.
        for gone in previous.difference(&next) {
            engine.runtime.forget_pair(id, gone);
        }

        // §7.6: the rule's own snapshot of what each watched terminal was called and where it was.
        // `touch_target` had no production caller, so `automation_targets` held rows only for PINNED
        // ids — which left `label_at`'s third step dead code in production, and left the picker's
        // *not open* row for a criterion-matched terminal drawing neither the label nor the folder it
        // exists to draw (§4.3, R14). The tick is the owner: it already holds the roster and already
        // runs every 2 s, and the throttle lives in the store, so there is no decision here.
        for tm in next.iter() {
            let Some(row) = by_id.get(tm.as_str()) else {
                continue;
            };
            let label =
                crate::automation::labels::label_at(&crate::automation::labels::LabelInputs {
                    display_label: row.display_label.as_deref(),
                    name: Some(row.name.as_str()),
                    shell: Some(row.shell.as_str()),
                    // Writing the snapshot, so the snapshot is not an input to it.
                    snapshot: None,
                });
            if let Err(e) =
                host.store()
                    .touch_target(id, tm, label.as_deref(), row.cwd.as_deref(), now_ms)
            {
                log::warn!(
                    "automations: could not record {}'s view of {}: {}",
                    id,
                    tm,
                    e
                );
            }
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

        watched.insert(id.clone(), next.into_iter().collect());
    }
    engine.set_missing(missing.clone());
    TargetingPass { missing, watched }
}

#[cfg(test)]
mod tests;
