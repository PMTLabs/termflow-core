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

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

pub mod eval;

use crate::automation::runtime::AutomationRuntime;

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
