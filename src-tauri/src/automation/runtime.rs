//! The Automations engine's per-terminal and per-rule state.
//!
//! **A standalone struct rather than fields on `AppState`, and that is a testability decision, not a
//! tidiness one.** `AppState::new` takes an `AppHandle`, so anything reachable only through it can be
//! unit-tested only behind `--features integration-tests`, which `Cargo.toml` says breaks the test
//! binary at loader time on Windows. `identity_index.rs` states the same rule in its own module doc:
//! it "lives in its own file rather than on `AppState` so it can be unit-tested without a Tauri
//! `AppHandle`". Round 1's review found nine planned tests that would have compiled only on Linux
//! while two milestone gates named them — gates that could not go red. Plan §7.10.
//!
//! Holds: `arm`, `echoes`, `send_locks`, `last_eval_ms`, `dirty`, `watched`. Keyed by the durable `tm-`
//! leaf, except `dirty`, which is keyed by the `pc-` process id because that is what
//! `ChannelPayload.id` carries. Plan §7.4's table is the authority — and it is why there are **two**
//! forget methods: `forget_terminal` takes the leaf and cannot reach a `pc-`keyed map, so
//! `cleanup_terminal_state` calls `forget_process` for `dirty` with the id it already has.
//! *(Plan §2.4 listed `dirty` among what `forget_terminal` purges, which §7.4's own table makes
//! impossible. Corrected in the plan.)*
//!
//! Deliberately no per-pair "what did I see last time" state: an earlier design reconstructed a
//! since-last-check delta from hashed line anchors, and it broke on the most ordinary thing a terminal
//! does — the bottom line is the prompt, typing rewrites it, the anchor vanishes, and the fallback
//! re-read the whole 200-line window on every keystroke. §2.2c replaced it with a second window depth.

use std::collections::HashSet;
use std::sync::Arc;

use dashmap::{DashMap, DashSet};

use crate::automation_engine::eval::{ArmState, Captures};

/// How many echo needles one terminal may carry at once (§2.6).
pub const ECHO_CAP: usize = 4;

/// How long a needle stays live. Long enough that a slow CLI echoing late is still recognised,
/// short enough that a needle cannot outlive the scrollback it was typed into.
pub const ECHO_TTL_MS: i64 = 10 * 60 * 1_000;

/// How long after a send no rule evaluates that terminal.
pub const ECHO_SETTLE_MS: i64 = 1_500;

/// One live echo needle: text this feature itself typed into a terminal, which must be stripped from
/// that terminal's window before any rule extracts from it.
///
/// Keyed per TERMINAL rather than per rule, because the failure is per terminal: rule A's message
/// echoed into a pane is read by rule B watching the same pane, and B has no idea A wrote it. Plan
/// §2.6 (the guard itself lands with M3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EchoNeedle {
    pub text: String,
    /// Wall-clock ms after which the needle is stale and stops being stripped. A needle that never
    /// expired would blind the rule to the user typing the same words themselves.
    pub until_ms: i64,
}

/// One crossing whose message is waiting out a `TimerMode::AfterMatch` delay (§6.2).
///
/// **Not persisted, deliberately** (§12): a parked send does not survive quitting the app. The
/// whole feature is *"recover from the error that just happened"*, and a queue that replayed
/// yesterday's `resume` into today's shell is the "nagging on arrival" behaviour plan 028 Q3 already
/// ruled against for arm state.
///
/// It carries **exactly what `PendingSend` would have carried** had the crossing dispatched
/// immediately, and for the same reasons:
///
/// - `captures` are the groups of the match that actually crossed. By the time the delay expires the
///   terminal has scrolled on, so re-reading it at send time would resolve `$1` against whatever
///   happens to be on screen then — or against nothing at all.
/// - `prev` is the arm state this pair held BEFORE the crossing, so a send that fails 30 s later
///   rolls back to exactly where it was rather than to a fresh `Armed`; the `seen_fire` bit is a
///   fact about this pair's history (§2.2c).
/// - `label` is resolved at decide time, because `failed — the terminal closed` is written when
///   there is no name left to look up (§2.8).
#[derive(Debug, Clone, PartialEq)]
pub struct ParkedSend {
    /// Wall-clock ms at or after which the tick may take this. `now_ms + delay_ms`, computed once
    /// at the crossing so no reader has to know the delay.
    pub due_at_ms: i64,
    /// The process this crossing was READ from, carried for the whole of the wait.
    ///
    /// `run_send`'s restart guard compares the leaf's process at lock time against
    /// `PendingSend.pair.pc`. Built at the DRAIN from a fresh `process_for_leaf`, that comparison
    /// is a value against itself and covers only the queue wait — never the 30 s to 10 min park.
    /// `forget_terminal` covers Ctrl+R, because a restart is offered only after the shell exits and
    /// that path runs `cleanup_terminal_state` → `forget_terminal` → purge; it does NOT cover a
    /// spawn that re-indexes a LIVE leaf, and `IdentityIndex::index` overwrites `leaf_to_process`
    /// unconditionally with no purge. That is the hazard `Pair::pc` was added for, and the failure
    /// is a message decided from a dead run typed into a live shell — with `submit: true`,
    /// executed there.
    pub pc: String,
    pub captures: Option<Captures>,
    pub prev: ArmState,
    pub label: Option<String>,
}

/// Every map the engine keys by a terminal or a rule.
#[derive(Default)]
pub struct AutomationRuntime {
    /// `(rule_id, tm_id)` -> where that pair sits in the once-per-crossing cycle. In memory, never
    /// persisted: launch starts empty, so every pair is `Unseen` and nothing fires on a value that
    /// was already true when the app started.
    arm: DashMap<(String, String), ArmState>,
    /// `tm_id` -> needles this feature typed into that terminal.
    echoes: DashMap<String, Vec<EchoNeedle>>,
    /// `tm_id` -> the lock that serialises sends to it, so two rules firing in one tick cannot
    /// interleave a paste with another rule's submit.
    send_locks: DashMap<String, Arc<tokio::sync::Mutex<()>>>,
    /// `(rule_id, tm_id)` -> when that pair last evaluated, for both cadences.
    last_eval_ms: DashMap<(String, String), i64>,
    /// **`pc_id`** -> how many times this terminal has printed. The one `pc-`keyed map here, because
    /// `ChannelPayload.id` is a process id.
    ///
    /// **A generation, not a flag.** The tap runs on another worker while the evaluator is reading:
    /// output that arrives after `host.tail()` and before the clear would be thrown away by a blind
    /// `remove`, and if that was the last line the terminal printed, thrown away permanently. The
    /// evaluator carries the generation it read at and the clear only removes what it has not moved.
    dirty: DashMap<String, u64>,
    /// `rule_id` -> a crossing of that single-run rule is already on its way out.
    ///
    /// **R6 is claimed where the crossing is DECIDED, not where it is sent.** The first version
    /// deduped inside one tick's `sends` vector and left the rest to `is_live` — but `is_live` goes
    /// false only when `complete_rule` runs, and that is after `deliver` returns: one
    /// `PASTE_SUBMIT_GAP_MS`, two evaluator ticks, plus any queue wait after the crossing was
    /// decided. Two terminals crossing 250 ms apart is not an edge case, it is what `AllTerminals`
    /// and `follow_new` are for, and both of them sent. Released by `forget_rule` — which is the
    /// path both completion and *Reset* go through — and by a send that did not happen.
    claimed_once: DashSet<String>,
    /// How often each pair has fired, and when it last did.
    ///
    /// `arm` cannot answer either question: its `at_ms` is overwritten on every crossing and gone
    /// the moment the pair re-arms, while `RuntimePairState` shows a **count** and a last-fired
    /// stamp that must survive a re-arm — *“fired 3 times, last 10 minutes ago”* on a row that is
    /// currently armed. Keyed like `arm`, and purged by both teardowns for the same reason.
    fires: DashMap<(String, String), (u32, i64)>,
    /// `tm_id` -> no rule evaluates this terminal until then (§2.6 layer 2).
    ///
    /// Per TERMINAL and not per rule, for the same reason `echoes` is: the settle window exists to
    /// let one rule's own message land and scroll, and a second rule reading that terminal in the
    /// meantime sees the same injected text.
    settled_until: DashMap<String, i64>,
    /// `rule_id` -> the leaves it watches. The targeting tick is its only writer.
    watched: DashMap<String, HashSet<String>>,
    /// `(rule_id, tm_id)` -> what this pair decided last time.
    ///
    /// The activity log records TRANSITIONS: a decision identical to the previous one is a repeat and
    /// is written as a `Check`, which is the one class the verbose gate can drop. Without it a working
    /// rule writes a `held` row four times a second and the 200-row per-rule cap evicts that rule's own
    /// `sent` row inside a minute.
    last_decision: DashMap<(String, String), crate::automation_engine::eval::Decision>,
    /// `(rule_id, tm_id)` -> a crossing whose message is waiting out its `AfterMatch` delay (§6.2).
    ///
    /// **One more map, and no new clock.** `loops.rs`'s header rules out a `tokio::time::interval`
    /// per rule, and this is what replaces it: the send sits here and the evaluator's existing
    /// 250 ms tick takes it when it is ripe. Keyed like `arm`, so the pair is the unit — one rule
    /// crossing on three terminals parks three sends, exactly as it would have dispatched three.
    ///
    /// Purged by all three teardowns. That is hygiene rather than the fire gate — the gate is
    /// `snapshot_live()`, which the drain runs inside (§6.1) — but a map with no purge is a leak,
    /// and this one holds a `Captures` per entry.
    parked: DashMap<(String, String), ParkedSend>,
    /// `rule_id` -> the local ordinal day this schedule rule last fired on (§6.3).
    ///
    /// **Keyed by the RULE alone, and that is the difference between this and every map above it.**
    /// A schedule rule reads no terminal: `schedule_due` asks a clock, and the answer is the same
    /// for all of the rule's targets, so "09:00 has happened today" is one fact and not one per
    /// pair. Keyed per pair it would also be the *wrong* fact — a terminal that joins the watched
    /// set at 10:00 has no entry for today, so a per-pair guard would deliver the 09:00 prompt to it
    /// on arrival, which is exactly the behaviour §6.3 and plan 028 Q3 rule against. The walk marks
    /// the day once, after it has pushed a send for every leaf it is going to.
    ///
    /// **Seeded by `reload`, not only written by the tick.** `>=` on the minute means an absent
    /// entry and a target already past are indistinguishable from a crossing, so at load every
    /// schedule whose minute has gone by is marked as today — an app started at 14:00 does not
    /// deliver a 09:00 prompt on arrival, while an app running across 09:00 still does.
    ///
    /// Purged by `forget_rule` alone: it is a fact about the rule's own day, which a terminal
    /// closing or leaving a watched set does not undo. In memory only, like `parked` — launch
    /// starts empty, and `reload` runs at launch, which is what puts the seed there.
    ///
    /// **`reload` carries it ACROSS that purge when the rule's target minute has not moved**
    /// (`schedule::same_target_minute`), and this map is the only one it does that for. Every save
    /// moves `updated_at`, so `forget_rule` runs on a rename — and the re-seed that follows cannot
    /// tell *never fired today* from *fired today, the mark was just deleted*. It decided the day had
    /// been missed and wrote *"09:00 went by while nothing was watching the clock"* into the log
    /// half an hour after the `sent` row for that same run. The other maps here want the purge: an
    /// edit resetting a rule's arm state is Q11, and settled decision 7 wants the next crossing to be
    /// a real one. A day that was spent stays spent.
    last_fired_day: DashMap<String, i32>,
}

impl AutomationRuntime {
    pub fn new() -> Self {
        Self::default()
    }

    // --- arm state -----------------------------------------------------------------------------

    /// A pair with no entry is `Unseen`, which is what makes in-memory-only arm state safe.
    pub fn arm_state(&self, rule_id: &str, tm: &str) -> ArmState {
        self.arm
            .get(&(rule_id.to_string(), tm.to_string()))
            .map(|e| *e.value())
            .unwrap_or(ArmState::Unseen)
    }

    pub fn set_arm(&self, rule_id: &str, tm: &str, state: ArmState) {
        self.arm.insert((rule_id.to_string(), tm.to_string()), state);
    }

    /// Roll one pair's arm state back — **and only if that pair still has one**.
    ///
    /// A rollback restores; it must never CREATE. Between a crossing being decided and its send
    /// failing, the terminal can close, and `cleanup_terminal_state` purges every `tm-`keyed entry for
    /// it. Writing `prev` back afterwards resurrects a key for a terminal that is gone — and a `tm-`
    /// leaf is REUSED (Ctrl+R restarts a terminal under the same id, and session restore
    /// re-registers it), so the next terminal to carry that leaf starts `Armed` instead of `Unseen`.
    /// Settled decision 7 says a terminal already above the threshold when it spawns must not fire
    /// without a genuine crossing; an inherited `Armed` fires on its first read.
    ///
    /// `Unseen` protection engages only when the key is ABSENT, which is exactly what
    /// `forget_terminal`'s own doc says — so the guard is "is there something to roll back", not "is
    /// the terminal still open". A terminal-liveness check would race the close it is trying to
    /// notice; the presence of the key is the fact that was actually established.
    pub fn restore_arm(&self, rule_id: &str, tm: &str, state: ArmState) {
        let key = (rule_id.to_string(), tm.to_string());
        if let Some(mut entry) = self.arm.get_mut(&key) {
            *entry.value_mut() = state;
        }
    }

    /// Drop one pair's arm state and evaluation stamp, for a terminal that has left a rule's watched
    /// set (§2.4: *"keys are cleared when … a terminal leaves the watch set"*).
    ///
    /// **`fires` is deliberately kept.** §2.4's table is the ARM machine's, and the fire history is
    /// what a row means by *"fired 3 times, last 10 minutes ago"*: a terminal that drops out of a
    /// criterion's matched set for a minute and comes back has not un-fired. `forget_rule` and
    /// `forget_terminal` do purge it, because there the pairing itself is over.
    pub fn forget_pair(&self, rule_id: &str, tm: &str) {
        let key = (rule_id.to_string(), tm.to_string());
        self.arm.remove(&key);
        self.last_eval_ms.remove(&key);
        self.last_decision.remove(&key);
        // A leaf that has left this rule's watched set is a leaf the walk in `evaluate_tick` no
        // longer visits, so its parked send would sit here until the process exited. `fires` is the
        // one map kept across this teardown, and for a reason that does not apply to a pending
        // write: a fire COUNT survives a terminal dropping out and coming back, an unsent message
        // decided from output the rule is no longer watching does not.
        self.parked.remove(&key);
    }

    /// Everything one rule owns: its arm keys, its evaluation stamps and its watched set. Called when
    /// a rule is disabled, saved with changes, or completes.
    pub fn forget_rule(&self, rule_id: &str) {
        self.arm.retain(|(r, _), _| r != rule_id);
        self.last_eval_ms.retain(|(r, _), _| r != rule_id);
        self.last_decision.retain(|(r, _), _| r != rule_id);
        self.fires.retain(|(r, _), _| r != rule_id);
        self.parked.retain(|(r, _), _| r != rule_id);
        self.last_fired_day.remove(rule_id);
        self.watched.remove(rule_id);
        // Completion and *Reset* both arrive here, and they want opposite things from the claim —
        // completion no longer needs it (the rule has left the live set), and a reset must not
        // inherit it or the rule the user just put back on the board can never send again.
        self.claimed_once.remove(rule_id);
    }

    // --- the single-run claim (R6) ---------------------------------------------------------------

    /// Claim this single-run rule's one send: `true` for the first caller, `false` for every other.
    ///
    /// Asked at decide time, so a second terminal crossing on a *later* tick is refused before a task
    /// is spawned for it — which the in-tick dedupe it replaced could not see and `is_live` was 500 ms
    /// too late to.
    pub fn claim_once(&self, rule_id: &str) -> bool {
        self.claimed_once.insert(rule_id.to_string())
    }

    /// Give the claim back, because the send did not happen. A rollback restores; it never creates.
    pub fn release_once(&self, rule_id: &str) {
        self.claimed_once.remove(rule_id);
    }

    pub fn is_claimed_once(&self, rule_id: &str) -> bool {
        self.claimed_once.contains(rule_id)
    }

    // --- per-terminal teardown -----------------------------------------------------------------

    /// Purge every `tm-`keyed map for one leaf — **across every rule**, and nothing else.
    ///
    /// Restarting a terminal (Ctrl+R) reuses the same `tm-` id for a brand-new PTY and a fresh vt100
    /// parser. `Unseen` protection engages only when the key is ABSENT; a stale `Fired` left behind
    /// means a restarted shell inherits the dead one's state and is silently never nagged again. That
    /// is the re-minted-id class, and the codebase's own fix pattern sits two lines away in
    /// `cleanup_terminal_state` (`history_persist_locks.remove`).
    ///
    /// It deliberately does NOT touch `watched`: the targeting tick re-resolves the whole set every
    /// 2 s, and a stale leaf there costs at most one tick in which the evaluator finds it not live and
    /// skips it — whereas editing MEMBERSHIP here would give that the second writer. (Whole-rule
    /// removal is a different thing and already has two: `forget_rule` drops the entry, which §7.8
    /// requires on completion. What must stay single-writer is which leaves a live rule watches.)
    pub fn forget_terminal(&self, tm: &str) {
        self.arm.retain(|(_, t), _| t != tm);
        self.last_eval_ms.retain(|(_, t), _| t != tm);
        self.last_decision.retain(|(_, t), _| t != tm);
        self.fires.retain(|(_, t), _| t != tm);
        // Ctrl+R reuses the leaf for a brand-new PTY. A parked send decided from the DEAD shell's
        // output must not be typed into the live one — with `submit: true` it would also run there.
        self.parked.retain(|(_, t), _| t != tm);
        self.echoes.remove(tm);
        self.send_locks.remove(tm);
        self.settled_until.remove(tm);
    }

    /// The `pc-`keyed half of the same teardown. Separate because `dirty` is keyed by the process id
    /// and `forget_terminal` only ever holds a leaf.
    pub fn forget_process(&self, pc: &str) {
        self.dirty.remove(pc);
    }

    // --- the dirty signal ----------------------------------------------------------------------

    /// The tap's ONLY write. Takes a `pc-` process id.
    pub fn mark_dirty(&self, pc: &str) {
        *self.dirty.entry(pc.to_string()).or_insert(0) += 1;
    }

    /// Spend a terminal's dirty signal, **unless it has moved since `seen`**.
    ///
    /// Two guards, and they are guarding the same thing from two sides. The evaluator clears a `pc`
    /// only once every pair that wanted this output has run (see `due::settled_processes`) — two
    /// rules watch one terminal and clearing after the first would make the second miss it. And the
    /// tap writes concurrently, so output arriving between the read and the clear is output no pair
    /// has seen at all; `seen` is the generation the tick read at, and a clear that does not match
    /// it is a clear of somebody else's signal. Both losses are permanent if the terminal then goes
    /// quiet, which is the normal end of a build.
    pub fn clear_dirty(&self, pc: &str, seen: u64) {
        self.dirty.remove_if(pc, |_, at| *at == seen);
    }

    pub fn is_dirty(&self, pc: &str) -> bool {
        self.dirty.contains_key(pc)
    }

    /// How many times this terminal has printed, or `None` if it has not since its last clear.
    ///
    /// `Some` is the dirty signal; the number is only ever compared with itself.
    pub fn dirty_seq(&self, pc: &str) -> Option<u64> {
        self.dirty.get(pc).map(|e| *e.value())
    }

    // --- send serialisation --------------------------------------------------------------------

    /// The per-leaf send lock, minted on first use. Two rules firing into one terminal in one tick
    /// take the same lock, so a paste can never land between another rule's paste and its submit.
    pub fn send_lock(&self, tm: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.send_locks
            .entry(tm.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .value()
            .clone()
    }

    // --- echoes --------------------------------------------------------------------------------

    /// Record a needle, keeping at most [`ECHO_CAP`] per terminal (§2.6).
    ///
    /// The cap is not decoration: this map is only ever pruned by expiry, and a rule on a 10 s timer
    /// that fires all day would otherwise grow an unbounded `Vec` that every evaluation of that
    /// terminal walks. The OLDEST needle is dropped, because the newest is the one still on screen.
    /// Record a needle this engine typed into `tm`, expiring `ECHO_TTL_MS` after `now_ms`.
    ///
    /// **`now_ms` is when the write LANDED, not a deadline.** It used to be the deadline itself; the
    /// type did not change with the meaning, so four existing call sites were silently reinterpreted
    /// rather than flagged by the compiler. All four were audited afterwards and all four are correct
    /// under the new reading — they pass a moment, not an expiry — but the audit is the only thing
    /// that established that, which is the argument for a newtype the next time a parameter's
    /// meaning moves underneath its type.
    pub fn push_echo(&self, tm: &str, text: &str, now_ms: i64) {
        let mut entry = self.echoes.entry(tm.to_string()).or_default();
        // The expiry `echoes_for` used to do. It belongs on the write side: a reader that prunes is a
        // reader that mutates, and the dry run's whole contract is that it does not.
        entry.retain(|n| n.until_ms > now_ms);
        entry.push(EchoNeedle { text: text.to_string(), until_ms: now_ms + ECHO_TTL_MS });
        let overflow = entry.len().saturating_sub(ECHO_CAP);
        if overflow > 0 {
            entry.drain(0..overflow);
        }
    }

    // --- the settle window (§2.6 layer 2) --------------------------------------------------------

    /// Hold every rule off this terminal until `until_ms`.
    ///
    /// Taken after a send, so the echo of the message this engine just typed is not read as organic
    /// output. It comfortably spans route A's 500 ms paste-to-submit gap, and it is what stops the
    /// burst on the `OnOutput` cadence, where the echo chunk itself immediately marks the terminal
    /// dirty.
    pub fn settle_until(&self, tm: &str, until_ms: i64) {
        self.settled_until.insert(tm.to_string(), until_ms);
    }

    pub fn is_settling(&self, tm: &str, now_ms: i64) -> bool {
        self.settled_until.get(tm).is_some_and(|e| *e.value() > now_ms)
    }

    /// The live needles for one terminal, dropping any that have expired.
    /// **A read, and only a read.** It used to `get_mut` and `retain` the expired needles away, which
    /// is benign — and made `dry.rs`'s claim to write nothing anywhere false, in a way its own
    /// before/after oracle structurally could not see, because that oracle reads through this same
    /// accessor. Expiry moved to `push_echo`, which is a write already.
    pub fn echoes_for(&self, tm: &str, now_ms: i64) -> Vec<String> {
        let Some(entry) = self.echoes.get(tm) else {
            return Vec::new();
        };
        entry.iter().filter(|n| n.until_ms > now_ms).map(|n| n.text.clone()).collect()
    }

    // --- cadence -------------------------------------------------------------------------------

    // --- fire history ---------------------------------------------------------------------------

    /// Record a crossing that actually sent. Called once per `sent`, inside the send's critical
    /// section, so the count cannot run ahead of the log.
    pub fn record_fire(&self, rule_id: &str, tm: &str, at_ms: i64) {
        let mut e = self
            .fires
            .entry((rule_id.to_string(), tm.to_string()))
            .or_insert((0, at_ms));
        e.0 += 1;
        e.1 = at_ms;
    }

    /// `(count, last_at)`, or `None` for a pair that has never fired.
    pub fn fire_record(&self, rule_id: &str, tm: &str) -> Option<(u32, i64)> {
        self.fires
            .get(&(rule_id.to_string(), tm.to_string()))
            .map(|e| *e.value())
    }

    // --- the parked send (§6.2) -------------------------------------------------------------------

    /// Hold this crossing's message until `p.due_at_ms`.
    ///
    /// **Overwrites**, and there is nothing to protect: `set_arm` writes `Fired` at decide time,
    /// before the park, so the pair cannot cross again while it waits. A second park for one pair
    /// therefore means the condition went false, re-armed and crossed again inside the delay — a
    /// genuinely newer crossing, whose captures are the ones the message should resolve against.
    pub fn park(&self, rule_id: &str, tm: &str, p: ParkedSend) {
        self.parked.insert((rule_id.to_string(), tm.to_string()), p);
    }

    /// Take this pair's parked send **only if it is ripe**, atomically.
    ///
    /// `remove_if` rather than a read-then-remove: the test and the removal are one operation, so a
    /// send that is not yet due is left exactly where it was rather than being taken out and put
    /// back — which is the shape that loses it if anything between the two returns early. The tick
    /// calls this for every watched pair on every pass, so "not due" is by far the common answer and
    /// it must be a pure read of the map.
    pub fn take_parked_due(&self, rule_id: &str, tm: &str, now_ms: i64) -> Option<ParkedSend> {
        self.parked
            .remove_if(&(rule_id.to_string(), tm.to_string()), |_, p| p.due_at_ms <= now_ms)
            .map(|(_, p)| p)
    }

    /// Drop any parked send whose wait has been stale for longer than `max_age_ms` (I3).
    ///
    /// **A suspend is not a quit, and `MAX_DELAY_MS` only promises the second one.** `parked` is
    /// in-memory only and not persisted, so §12's promise is "a wait cannot outlive the process" —
    /// but a laptop lid closing does not end the process, so a send parked at 17:59:50 with a 30 s
    /// delay is still in this map at 10:00 the next morning and, unguarded, fires on the first tick
    /// after wake into whatever is now in that terminal. This is the same premise as the schedule
    /// gap detector (`AutomationEngine::seed_missed_schedules`): *"nobody was observing the tick."*
    ///
    /// **Called only from the resume branch, alongside `seed_missed_schedules` — never on an
    /// ordinary tick.** Reusing that one gap detector is the point (`loops.rs`'s standing rule: one
    /// clock, `BASE_TICK_MS`, no second sweep, no new task) — this is not a second gap detector of
    /// its own, it is one more thing the existing one does once it has already decided nobody was
    /// watching.
    pub fn drop_stale_parked(&self, now_ms: i64, max_age_ms: i64) {
        self.parked.retain(|_, p| now_ms - p.due_at_ms <= max_age_ms);
    }

    /// When this pair's parked send comes due, or `None` if nothing is parked for it.
    ///
    /// A read, for the *"scheduled, counting down"* row state §7 threads through to the five armed
    /// surfaces. It never expires anything: a countdown that pruned what it was reporting would be
    /// the same defect `echoes_for` had.
    pub fn parked_at(&self, rule_id: &str, tm: &str) -> Option<i64> {
        self.parked
            .get(&(rule_id.to_string(), tm.to_string()))
            .map(|e| e.value().due_at_ms)
    }

    // --- the schedule's day (§6.3) ----------------------------------------------------------------

    /// The local ordinal day this schedule rule last fired on, or `None` if it has not fired since
    /// the rule was loaded. Handed straight to `schedule_due` as its double-fire guard.
    pub fn last_fired_day(&self, rule_id: &str) -> Option<i32> {
        self.last_fired_day.get(rule_id).map(|e| *e.value())
    }

    /// Mark this schedule rule as done for `day_ordinal`.
    ///
    /// Written from two places and they mean the same thing: the walk, when it has dispatched the
    /// day's sends, and `reload`, when the day's minute had already passed before the rule was
    /// loaded. Overwrites, because a later day always supersedes an earlier one and the only writer
    /// of an earlier one is a clock that moved backwards — which `schedule_due` reads as "not today"
    /// and fires once more, the same direction `due_now` takes for a negative age.
    pub fn set_last_fired_day(&self, rule_id: &str, day_ordinal: i32) {
        self.last_fired_day.insert(rule_id.to_string(), day_ordinal);
    }

    pub fn last_decision(&self, rule_id: &str, tm: &str) -> Option<crate::automation_engine::eval::Decision> {
        self.last_decision
            .get(&(rule_id.to_string(), tm.to_string()))
            .map(|e| *e.value())
    }

    pub fn set_last_decision(
        &self,
        rule_id: &str,
        tm: &str,
        decision: crate::automation_engine::eval::Decision,
    ) {
        self.last_decision.insert((rule_id.to_string(), tm.to_string()), decision);
    }

    pub fn last_eval(&self, rule_id: &str, tm: &str) -> Option<i64> {
        self.last_eval_ms
            .get(&(rule_id.to_string(), tm.to_string()))
            .map(|e| *e.value())
    }

    pub fn set_last_eval(&self, rule_id: &str, tm: &str, at_ms: i64) {
        self.last_eval_ms.insert((rule_id.to_string(), tm.to_string()), at_ms);
    }

    // --- the watched set -----------------------------------------------------------------------

    /// The targeting tick's only write.
    pub fn set_watched(&self, rule_id: &str, leaves: HashSet<String>) {
        self.watched.insert(rule_id.to_string(), leaves);
    }

    /// Deliberately NOT `Option`: nothing consumes the difference. `watched_set` re-resolves an
    /// empty frozen set rather than treating it as a decision, so "never resolved" and "resolved to
    /// nothing" produce the same behaviour, and a distinction no caller reads is the inert
    /// scaffolding §2.1's own review finding is about.
    pub fn watched_for(&self, rule_id: &str) -> HashSet<String> {
        self.watched.get(rule_id).map(|e| e.value().clone()).unwrap_or_default()
    }

    pub fn watches(&self, rule_id: &str, tm: &str) -> bool {
        self.watched.get(rule_id).map(|e| e.value().contains(tm)).unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two rules and two terminals, so a leaf-keyed purge cannot be confused with a rule-keyed one and
    /// an implementation that clears the whole map still fails.
    fn populated() -> AutomationRuntime {
        let rt = AutomationRuntime::new();
        for rule in ["au-1", "au-2"] {
            for tm in ["tm-test-1", "tm-test-2"] {
                rt.set_arm(rule, tm, ArmState::Fired { at_ms: 10 });
                rt.set_last_eval(rule, tm, 99);
                rt.record_fire(rule, tm, 10);
            }
            rt.set_watched(rule, ["tm-test-1".to_string(), "tm-test-2".to_string()].into());
        }
        for tm in ["tm-test-1", "tm-test-2"] {
            rt.push_echo(tm, "HANDOFF now", 60_000);
            let _ = rt.send_lock(tm);
            rt.settle_until(tm, 10_000);
        }
        // Every PAIR-keyed map, so a purge that misses one is visible. `last_decision` was added by
        // the round-1 response, purged at all three sites and asserted at none of them.
        for rule in ["au-1", "au-2"] {
            for tm in ["tm-test-1", "tm-test-2"] {
                rt.set_last_decision(rule, tm, crate::automation_engine::eval::Decision::Held);
                rt.park(rule, tm, a_parked_send(50_000));
            }
        }
        // The one RULE-keyed map with a value in it (§6.3): a schedule's day is a fact about the
        // rule, not about any pair, so it is populated here and asserted by `forget_rule`'s test.
        for rule in ["au-1", "au-2"] {
            rt.set_last_fired_day(rule, 739_866);
        }
        // `dirty` is PROCESS-keyed; the two ids are deliberately different strings.
        rt.mark_dirty("pc-test-1");
        rt.mark_dirty("pc-test-2");
        rt
    }

    fn a_parked_send(due_at_ms: i64) -> ParkedSend {
        ParkedSend {
            due_at_ms,
            pc: "pc-test-1".to_string(),
            captures: None,
            prev: ArmState::armed(),
            label: Some("codex · core".to_string()),
        }
    }

    /// §10.4b — the local half of the restart guard.
    #[test]
    fn forget_terminal_purges_one_leaf_across_every_rule_and_nothing_else() {
        let rt = populated();
        // Taken BEFORE the purge, because the oracle for `send_locks` is identity: `send_lock` mints
        // one on demand, so "is there a lock?" is always yes and only "is it the SAME lock?" can tell
        // a purge from a no-op. Deleting `send_locks.remove(tm)` left a restarted terminal
        // serialising against the dead PTY's queue.
        let lock = rt.send_lock("tm-test-1");
        let sibling_lock = rt.send_lock("tm-test-2");
        assert!(rt.is_settling("tm-test-1", 0), "the premise: it was settling");

        rt.forget_terminal("tm-test-1");

        assert!(!rt.is_settling("tm-test-1", 0), "a restarted leaf inherited the dead one's settle window");
        assert!(!Arc::ptr_eq(&lock, &rt.send_lock("tm-test-1")), "the send lock survived the restart");
        assert!(Arc::ptr_eq(&sibling_lock, &rt.send_lock("tm-test-2")), "the sibling's lock was re-minted");
        assert!(rt.is_settling("tm-test-2", 0), "the sibling's settle window was cleared");

        // Purged, for BOTH rules.
        for rule in ["au-1", "au-2"] {
            assert_eq!(
                rt.arm_state(rule, "tm-test-1"),
                ArmState::Unseen,
                "{} kept a stale arm state for the restarted leaf",
                rule
            );
            assert_eq!(rt.last_eval(rule, "tm-test-1"), None, "{} kept a stale eval stamp", rule);
            assert_eq!(rt.fire_record(rule, "tm-test-1"), None, "{} kept a stale fire count", rule);
            assert_eq!(
                rt.last_decision(rule, "tm-test-1"),
                None,
                "{} kept a stale decision: the row saying the rule woke up is downgraded to a gated \
                 Check and dropped",
                rule
            );
            assert_eq!(
                rt.parked_at(rule, "tm-test-1"),
                None,
                "{} kept a send parked against the DEAD shell: a leaf is reused, so it would be \
                 typed into the new one — and with `submit: true`, run there",
                rule
            );
        }
        assert!(rt.echoes_for("tm-test-1", 0).is_empty(), "echo needles survived");

        // The sibling leaf is untouched — every map, both rules.
        for rule in ["au-1", "au-2"] {
            assert_eq!(rt.arm_state(rule, "tm-test-2"), ArmState::Fired { at_ms: 10 });
            assert_eq!(rt.last_eval(rule, "tm-test-2"), Some(99));
            assert_eq!(rt.fire_record(rule, "tm-test-2"), Some((1, 10)));
            assert_eq!(
                rt.last_decision(rule, "tm-test-2"),
                Some(crate::automation_engine::eval::Decision::Held)
            );
            assert_eq!(rt.parked_at(rule, "tm-test-2"), Some(50_000));
        }
        assert_eq!(rt.echoes_for("tm-test-2", 0), vec!["HANDOFF now".to_string()]);

        // And nothing else: `dirty` is process-keyed, and a leaf's MEMBERSHIP of a watched set has
        // one writer — the targeting tick. (`forget_rule` removes whole entries; that is §7.8's
        // completion path, not a second writer of membership.)
        assert!(rt.is_dirty("pc-test-1"), "forget_terminal must not touch the pc-keyed dirty map");
        assert!(rt.watches("au-1", "tm-test-1"), "membership has ONE writer — the targeting tick");
    }

    /// The paired negative: a PROCESS id passed to the leaf-keyed purge must find nothing. This is
    /// what fails when a caller forwards `id` instead of extracting `renderer_terminal_id`.
    #[test]
    fn forget_terminal_given_a_process_id_purges_nothing() {
        let rt = populated();
        rt.forget_terminal("pc-test-1");
        assert_eq!(rt.arm_state("au-1", "tm-test-1"), ArmState::Fired { at_ms: 10 });
        assert_eq!(rt.arm_state("au-1", "tm-test-2"), ArmState::Fired { at_ms: 10 });
        assert_eq!(rt.last_eval("au-2", "tm-test-1"), Some(99));
        assert_eq!(rt.fire_record("au-1", "tm-test-1"), Some((1, 10)));
    }

    /// The tap runs on another worker while the evaluator reads. Output arriving between
    /// `host.tail()` and the clear belongs to nobody: no pair has seen it, and a blind `remove` throws
    /// it away — permanently, if that was the last line the terminal printed, which is the normal end
    /// of a build.
    #[test]
    fn a_clear_that_the_tap_overtook_leaves_the_terminal_dirty() {
        let rt = AutomationRuntime::new();
        rt.mark_dirty("pc-1");
        let seen = rt.dirty_seq("pc-1").expect("the premise: it is dirty");

        // The tap, between the evaluator's read and its clear.
        rt.mark_dirty("pc-1");

        rt.clear_dirty("pc-1", seen);
        assert!(rt.is_dirty("pc-1"), "the tick spent a signal it had never read");

        // And the ordinary case still clears: this is not "never clear".
        let seen = rt.dirty_seq("pc-1").unwrap();
        rt.clear_dirty("pc-1", seen);
        assert!(!rt.is_dirty("pc-1"));
    }

    #[test]
    fn forget_process_clears_only_the_dirty_flag_for_that_process() {
        let rt = populated();
        rt.forget_process("pc-test-1");
        assert!(!rt.is_dirty("pc-test-1"));
        assert!(rt.is_dirty("pc-test-2"), "the sibling process stayed dirty");
        assert_eq!(rt.arm_state("au-1", "tm-test-1"), ArmState::Fired { at_ms: 10 });
    }

    #[test]
    fn forget_rule_clears_that_rules_keys_across_terminals_and_leaves_the_other_rule() {
        let rt = populated();
        rt.forget_rule("au-1");
        for tm in ["tm-test-1", "tm-test-2"] {
            assert_eq!(rt.arm_state("au-1", tm), ArmState::Unseen);
            assert_eq!(rt.last_eval("au-1", tm), None);
            assert_eq!(rt.fire_record("au-1", tm), None, "every pair-keyed map");
            assert_eq!(rt.last_decision("au-1", tm), None);
            assert_eq!(
                rt.parked_at("au-1", tm),
                None,
                "a rule that was disabled, edited, deleted or completed left a send parked"
            );
            assert_eq!(rt.arm_state("au-2", tm), ArmState::Fired { at_ms: 10 });
            assert_eq!(rt.last_eval("au-2", tm), Some(99));
            assert_eq!(rt.fire_record("au-2", tm), Some((1, 10)));
            assert_eq!(
                rt.last_decision("au-2", tm),
                Some(crate::automation_engine::eval::Decision::Held)
            );
            assert_eq!(rt.parked_at("au-2", tm), Some(50_000));
        }
        assert!(rt.watched_for("au-1").is_empty());
        assert_eq!(rt.watched_for("au-2").len(), 2);
        // The rule-keyed map goes with the rest. A schedule left marked as fired-today across an
        // edit is a rule that cannot fire again until tomorrow — and `reload` re-seeds the mark
        // straight afterwards if the minute really has passed, so keeping it here would only make
        // the two writers disagree.
        assert_eq!(rt.last_fired_day("au-1"), None);
        assert_eq!(rt.last_fired_day("au-2"), Some(739_866), "the other rule's day is untouched");
    }

    /// §2.4's per-pair teardown, for a leaf that has left one rule's watched set.
    ///
    /// `fires` is the one map this deliberately KEEPS — a terminal that drops out of a matched set
    /// for a minute and comes back has not un-fired. A send still waiting out its delay is not in
    /// that class: the rule is no longer watching the terminal the crossing was read from.
    #[test]
    fn forget_pair_drops_that_pairs_keys_including_a_send_still_waiting() {
        let rt = populated();
        rt.forget_pair("au-1", "tm-test-1");

        assert_eq!(rt.arm_state("au-1", "tm-test-1"), ArmState::Unseen);
        assert_eq!(rt.last_eval("au-1", "tm-test-1"), None);
        assert_eq!(rt.last_decision("au-1", "tm-test-1"), None);
        assert_eq!(
            rt.parked_at("au-1", "tm-test-1"),
            None,
            "a send parked for a pairing that is over"
        );
        assert_eq!(
            rt.fire_record("au-1", "tm-test-1"),
            Some((1, 10)),
            "the fire history is deliberately kept — §2.4's table is the ARM machine's"
        );

        // The other pairs of the same rule, and the same pair of the other rule, are untouched.
        assert_eq!(rt.parked_at("au-1", "tm-test-2"), Some(50_000));
        assert_eq!(rt.parked_at("au-2", "tm-test-1"), Some(50_000));
    }

    /// **A send that is not yet due must be left exactly where it was.**
    ///
    /// `take_parked_due` is asked for every watched pair on every 250 ms tick, so "not ripe" is by
    /// far the common answer, and it has to be a pure read of the map: a read-then-remove that took
    /// the entry out to look at it loses the send on any early return between the two.
    #[test]
    fn a_parked_send_is_taken_only_once_it_is_ripe_and_only_once() {
        let rt = AutomationRuntime::new();
        rt.park("au-1", "tm-1", a_parked_send(1_000));

        assert!(rt.take_parked_due("au-1", "tm-1", 999).is_none(), "taken a millisecond early");
        assert_eq!(
            rt.parked_at("au-1", "tm-1"),
            Some(1_000),
            "a refusal must leave it parked, not consume it"
        );

        // `due_at_ms` is the moment it may go, not the moment after.
        let taken = rt.take_parked_due("au-1", "tm-1", 1_000).expect("due at its own deadline");
        assert_eq!(taken.prev, ArmState::armed(), "the crossing's arm state must ride along");
        assert_eq!(taken.label.as_deref(), Some("codex · core"), "and the name it resolved");
        assert_eq!(rt.parked_at("au-1", "tm-1"), None, "taking it must remove it");
        assert!(
            rt.take_parked_due("au-1", "tm-1", 9_999).is_none(),
            "the same send went out twice"
        );

        // And a pair nobody parked for has nothing parked.
        assert_eq!(rt.parked_at("au-ghost", "tm-ghost"), None);
    }

    /// **The single-run claim is taken once, and given back only by a purge.**
    ///
    /// The engine-level half is in `loops.rs`; this is the property that half rests on. `claim_once`
    /// returning `true` unconditionally is the bug B-1 named, and it is invisible from any fixture
    /// that drives one tick.
    #[test]
    fn a_single_run_claim_is_taken_once_and_returned_by_the_purge() {
        let rt = AutomationRuntime::new();
        assert!(rt.claim_once("au-once"), "the first crossing must be allowed to send");
        assert!(!rt.claim_once("au-once"), "a second crossing claimed the same rule's one send");
        assert!(!rt.claim_once("au-once"), "and a third");
        assert!(rt.claim_once("au-other"), "one rule's claim must not block another's");

        // A send that did not happen gives it back — the same rule can cross again.
        rt.release_once("au-once");
        assert!(!rt.is_claimed_once("au-once"));
        assert!(rt.claim_once("au-once"));

        // And so does the purge, which is the path both completion and *Reset* take. Without it a
        // rule the user has just Reset holds a claim from the session that completed it and can
        // never send again.
        rt.forget_rule("au-once");
        assert!(!rt.is_claimed_once("au-once"));
        assert!(rt.claim_once("au-once"));
        assert!(!rt.claim_once("au-other"), "the purge released a rule it was not given");
    }

    /// A pair with no entry is `Unseen` — the property that makes launch safe.
    #[test]
    fn an_unknown_pair_is_unseen() {
        let rt = AutomationRuntime::new();
        assert_eq!(rt.arm_state("au-ghost", "tm-ghost"), ArmState::Unseen);
        assert_eq!(rt.last_eval("au-ghost", "tm-ghost"), None);
    }

    /// Two rules firing into one terminal must take the SAME lock; two terminals must not.
    #[test]
    fn the_send_lock_is_per_terminal_and_shared_across_rules() {
        let rt = AutomationRuntime::new();
        let a = rt.send_lock("tm-1");
        let b = rt.send_lock("tm-1");
        let other = rt.send_lock("tm-2");
        assert!(Arc::ptr_eq(&a, &b), "one terminal, one lock");
        assert!(!Arc::ptr_eq(&a, &other), "two terminals must not serialise against each other");
    }

    /// A needle that never expired would blind the rule to the user typing the same words themselves.
    #[test]
    fn echo_needles_expire() {
        let rt = AutomationRuntime::new();
        // `push_echo` takes the moment the write LANDED and owns the TTL, so no caller can compute a
        // deadline differently from any other caller.
        rt.push_echo("tm-1", "HANDOFF now", 1_000);
        rt.push_echo("tm-1", "later", 5_000);
        assert_eq!(rt.echoes_for("tm-1", 1_000 + ECHO_TTL_MS - 1).len(), 2);
        assert_eq!(rt.echoes_for("tm-1", 1_000 + ECHO_TTL_MS), vec!["later".to_string()]);
        assert!(rt.echoes_for("tm-1", 5_000 + ECHO_TTL_MS).is_empty());
    }

    /// **`echoes_for` is a read.** It used to `retain` the expired needles away, which made the dry
    /// run's "writes nothing anywhere" false — and invisibly, because the before/after oracle that
    /// checks that claim reads through this very accessor, so the mutation was inside its own
    /// instrument. Expiry belongs to `push_echo`, which is a write already.
    #[test]
    fn reading_the_needles_never_prunes_them_and_pushing_does() {
        let rt = AutomationRuntime::new();
        rt.push_echo("tm-1", "stale", 1_000);
        let long_after = 1_000 + ECHO_TTL_MS + 1;

        // Read far past its deadline, twice: the needle is filtered out of the ANSWER both times …
        assert!(rt.echoes_for("tm-1", long_after).is_empty());
        assert!(rt.echoes_for("tm-1", long_after).is_empty());
        // … and is still in the map, because a read did not touch it.
        assert_eq!(rt.echoes_for("tm-1", 1_500), vec!["stale".to_string()]);

        // A push at that later moment is what actually drops it.
        rt.push_echo("tm-1", "fresh", long_after);
        assert_eq!(rt.echoes_for("tm-1", 1_500), vec!["fresh".to_string()]);
    }
}
