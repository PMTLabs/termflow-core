//! The three events the Watchdogs feature emits — the user-facing rules engine, not
//! `spawn_pipeline_watchdog`.
//!
//! **These names are normative and nothing may spell one inline.** The boundary audit's sharpest
//! finding was that they were already broken four ways before a line was written: the engine emitted
//! `workflow:activity` / `workflow:state`, the store emitted `watchdogs:changed` /
//! `watchdogs:activity`, the settings UI listened for `watchdog:changed` / `watchdog:activity`, and
//! the handoff proposed `workflow:changed`. **No emitter overlapped the only listener.** No window
//! would ever have repainted, the live log would never have appended, and every area's unit tests
//! would still have passed — because a string constant that nobody else imports cannot disagree with
//! anything. Constants exist so that it can. Plan §7.2, M0.2.
//!
//! All three are **app-wide** `emit`, never `emit_to`: `.emit_to(` has zero call sites in this crate
//! and three separate comments calling it unreliable. That is safe here precisely because these events
//! only make a window *repaint* its Settings list — they never make it act — and every open window's
//! Settings page legitimately wants them, the same reason `terminal:data` is unfiltered. Plan §1, §2.9.

/// A rule definition changed: created, edited, enabled, disabled, duplicated, reset or deleted.
/// Emitted by the command layer after every definition mutation. Not coalesced — a user edit is one
/// event. Consumed by `useWatchdogs()`, which refetches the list.
pub const WATCHDOG_CHANGED: &str = "watchdog:changed";

/// A row was appended to the activity log. The **store** decides whether one is due (≤ 1/s, inside
/// `append`, so the rate limit cannot be re-implemented per caller); the caller performs the emit,
/// because the store holds no `AppHandle`. Plan §7.5, §7.10.
pub const WATCHDOG_ACTIVITY: &str = "watchdog:activity";

/// An arm-state transition. Emitted by the engine, coalesced ≤ 1/s.
///
/// This event did not exist in any area's design: `watchdogRowState(rule, runtime)` consumed a
/// `runtime` object **nobody produced**, so every row would have painted *Armed · waiting* and *Never
/// fired* regardless of reality. Its companion `get_watchdog_runtime()` command supplies first paint —
/// an event-only design leaves a freshly opened Settings page blank until the next transition.
pub const WATCHDOG_STATE: &str = "watchdog:state";

/// Payload of [`WATCHDOG_CHANGED`].
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedPayload {
    pub rule_ids: Vec<String>,
    pub deleted: Vec<String>,
    /// Which window's Settings page made the change, so the log can say *"saved from window `main`,
    /// replacing the version saved from `main-2`"*. Two windows may hold the same rule open and the
    /// later save wins whole — the log entry is the requirement, not concurrency control. Plan §3.5.
    pub origin: String,
    pub at: i64,
}

/// Payload of [`WATCHDOG_ACTIVITY`]. Deliberately just the affected rule ids: the log view refetches
/// or merges, so a coalesced event never has to carry the rows it stands for.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityPayload {
    pub rule_ids: Vec<String>,
}

/// One `(rule, terminal)` pair's runtime state, as the row pills and the `N of M` qualifier read it.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePairState {
    /// `unseen` | `armed` | `fired` — the arm machine's own three states (plan §2.4), lowercased.
    pub state: String,
    pub last_fired_at: Option<i64>,
    pub fired_count: u32,
    /// A pinned id that is not currently live. **Dormant, never dropped** — session restore
    /// re-registers the same `tm-` under a new `pc-`, so absence is not death. Only reported once it
    /// has been absent continuously AND the engine has been up longer than `MISSING_GRACE_MS`, because
    /// at t=0 the live set is empty and restore has not run. Plan §4.5.
    pub missing: bool,
}

/// Payload of [`WATCHDOG_STATE`]: `rules[ruleId][terminalId]`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatePayload {
    pub rules: std::collections::HashMap<String, std::collections::HashMap<String, RuntimePairState>>,
}
