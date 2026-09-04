//! Everything the running engine needs from the app it lives in — as one port, so the loops can be
//! driven by a fake (plan §7.10).
//!
//! **Every method is a projection with no decision in it.** That is the whole rule: `AppState::new`
//! takes an `AppHandle<R>`, and `--features integration-tests` breaks the Windows test binary at
//! loader time, so anything with a branch that is only reachable through `AppState` is a gate that
//! cannot fail on the platform this is developed on. The three loops contain every decision the
//! engine makes; this trait is what keeps them out of `AppState`.
//!
//! One trait rather than five separate ports because the three loops need overlapping subsets of it
//! and a fake would otherwise have to be assembled from five pieces at every call site. The two
//! ports that already existed — `ScreenSource` and `TerminalWriter` — are re-declared here rather
//! than made supertraits, so `Arc<dyn EngineHost>` needs no trait upcasting; `HostPort` below is the
//! four-line adapter that hands a host to code written against either of them.

use std::sync::Arc;

use crate::automation::roster::RosterRow;
use crate::automation_store::Criterion;
use crate::automation::send::TerminalWriter;
use crate::automation_engine::eval::{ReadDepth, ScreenSource};
use crate::automation_store::AutomationStore;

/// The running engine's view of the app.
pub trait EngineHost: Send + Sync {
    /// The **only** `tm-` → `pc-` conversion in the engine (plan §7.4).
    ///
    /// `None` means the terminal is not live, which §4.5 defines as **dormant, never dead**: session
    /// restore re-registers the same `tm-` under a new `pc-`. Never `state.resolve_ref` — it returns
    /// its input unchanged when the leaf does not resolve, so it cannot double as an existence test
    /// and would hand a `tm-` string to a `pc-`keyed map.
    fn process_for_leaf(&self, tm: &str) -> Option<String>;

    /// Every live terminal, as the targeting tick resolves criteria against it.
    ///
    /// `criteria` is what the live rules actually ask about, and it is an argument rather than
    /// something the implementation works out because of §10.13: `Command contains` is the only
    /// criterion that needs the machine's process table, and a profile whose rules never use it must
    /// never enumerate one. The caller is the only place that knows.
    fn roster(&self, criteria: &[Criterion]) -> Vec<RosterRow>;

    /// Every live `pc-`, for the tap's `Lagged` recovery.
    fn live_processes(&self) -> Vec<String>;

    /// Matchable text for one terminal — the `ScreenSource` port, by another name.
    fn tail(&self, pc: &str, depth: ReadDepth) -> Option<String>;

    /// One terminal-bound write — the `TerminalWriter` port, by another name.
    fn write(&self, pc: &str, bytes: &[u8]) -> Result<(), String>;

    /// The terminal's name for a log line, resolved through `label_at` at DECIDE time (§2.8, §4.5).
    /// `None` is stored as NULL and rendered as an empty column — **never invented**.
    fn label_for(&self, tm: &str) -> Option<String>;

    /// The activity log and the rule definitions. The engine writes rows; it never emits from here.
    fn store(&self) -> &Arc<AutomationStore>;

    /// `automation:activity` — a row was appended and the store said one was due.
    fn emit_activity(&self, rule_ids: Vec<String>);

    /// `automation:state` — an arm-state transition.
    fn emit_state(&self);
}

/// Hands an `EngineHost` to the two ports that predate it.
///
/// A newtype rather than `EngineHost: ScreenSource + TerminalWriter`, because reaching the supertrait
/// object from an `Arc<dyn EngineHost>` is a trait upcast, and this is four lines with no version
/// question attached to it.
pub struct HostPort<'a>(pub &'a dyn EngineHost);

impl ScreenSource for HostPort<'_> {
    fn tail(&self, process_id: &str, depth: ReadDepth) -> Option<String> {
        self.0.tail(process_id, depth)
    }
}

impl TerminalWriter for HostPort<'_> {
    fn write(&self, pc: &str, bytes: &[u8]) -> Result<(), String> {
        self.0.write(pc, bytes)
    }
}
