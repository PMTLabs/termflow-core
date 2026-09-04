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

use dashmap::DashMap;

use crate::automation_engine::eval::ArmState;

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
    /// **`pc_id`** -> this terminal printed something since the last evaluation. The one `pc-`keyed
    /// map here, because `ChannelPayload.id` is a process id.
    dirty: DashMap<String, ()>,
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
    }

    /// Everything one rule owns: its arm keys, its evaluation stamps and its watched set. Called when
    /// a rule is disabled, saved with changes, or completes.
    pub fn forget_rule(&self, rule_id: &str) {
        self.arm.retain(|(r, _), _| r != rule_id);
        self.last_eval_ms.retain(|(r, _), _| r != rule_id);
        self.last_decision.retain(|(r, _), _| r != rule_id);
        self.fires.retain(|(r, _), _| r != rule_id);
        self.watched.remove(rule_id);
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
        self.dirty.insert(pc.to_string(), ());
    }

    /// Spend a terminal's dirty flag.
    ///
    /// The evaluator clears a `pc` only once EVERY due pair on it has run this tick (see
    /// `due::settled_processes`). Two rules can watch one terminal, and clearing after the first
    /// would make the second miss that output — permanently, if the terminal then goes quiet.
    pub fn clear_dirty(&self, pc: &str) {
        self.dirty.remove(pc);
    }

    pub fn is_dirty(&self, pc: &str) -> bool {
        self.dirty.contains_key(pc)
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
    pub fn push_echo(&self, tm: &str, text: &str, until_ms: i64) {
        let mut entry = self.echoes.entry(tm.to_string()).or_default();
        entry.push(EchoNeedle { text: text.to_string(), until_ms });
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
    pub fn echoes_for(&self, tm: &str, now_ms: i64) -> Vec<String> {
        let Some(mut entry) = self.echoes.get_mut(tm) else {
            return Vec::new();
        };
        entry.retain(|n| n.until_ms > now_ms);
        entry.iter().map(|n| n.text.clone()).collect()
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
        }
        // `dirty` is PROCESS-keyed; the two ids are deliberately different strings.
        rt.mark_dirty("pc-test-1");
        rt.mark_dirty("pc-test-2");
        rt
    }

    /// §10.4b — the local half of the restart guard.
    #[test]
    fn forget_terminal_purges_one_leaf_across_every_rule_and_nothing_else() {
        let rt = populated();
        rt.forget_terminal("tm-test-1");

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
        }
        assert!(rt.echoes_for("tm-test-1", 0).is_empty(), "echo needles survived");

        // The sibling leaf is untouched — every map, both rules.
        for rule in ["au-1", "au-2"] {
            assert_eq!(rt.arm_state(rule, "tm-test-2"), ArmState::Fired { at_ms: 10 });
            assert_eq!(rt.last_eval(rule, "tm-test-2"), Some(99));
            assert_eq!(rt.fire_record(rule, "tm-test-2"), Some((1, 10)));
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
            assert_eq!(rt.fire_record("au-1", tm), None, "every pair-keyed map, not just the two");
            assert_eq!(rt.arm_state("au-2", tm), ArmState::Fired { at_ms: 10 });
            assert_eq!(rt.last_eval("au-2", tm), Some(99));
            assert_eq!(rt.fire_record("au-2", tm), Some((1, 10)));
        }
        assert!(rt.watched_for("au-1").is_empty());
        assert_eq!(rt.watched_for("au-2").len(), 2);
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
        rt.push_echo("tm-1", "HANDOFF now", 5_000);
        rt.push_echo("tm-1", "later", 9_000);
        assert_eq!(rt.echoes_for("tm-1", 4_999).len(), 2);
        assert_eq!(rt.echoes_for("tm-1", 5_000), vec!["later".to_string()]);
        assert!(rt.echoes_for("tm-1", 9_000).is_empty());
    }
}
