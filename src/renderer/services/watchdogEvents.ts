/**
 * The three events the Watchdogs feature emits, and the payloads they carry.
 *
 * **These names are normative and nothing may spell one inline.** Before a line of this feature was
 * written they were already broken four ways: the engine was to emit `workflow:activity` /
 * `workflow:state`, the store `watchdogs:changed` / `watchdogs:activity`, the settings UI listened for
 * `watchdog:changed` / `watchdog:activity`, and the handoff proposed `watchdog:changed` again by
 * another route. **No emitter overlapped the only listener.** No window would ever have repainted, the
 * live log would never have appended — and every area's unit tests would still have passed, because a
 * string literal that nobody else imports cannot disagree with anything. This module exists so that it
 * can. Plan 028 §7.2, M0.2.
 *
 * The Rust side of the same contract is `src-tauri/src/watchdog/events.rs`; the constants and the
 * field names must match it exactly.
 */

/**
 * A rule definition changed: created, edited, enabled, disabled, duplicated, reset or deleted.
 * Emitted by the command layer after every definition mutation, uncoalesced — a user edit is one
 * event. `useWatchdogs()` refetches the list.
 */
export const WATCHDOG_CHANGED = 'watchdog:changed';

/**
 * A row was appended to the activity log. The store decides whether one is due (at most one per
 * second, inside `append`, so the rate limit cannot be re-implemented per caller) and its caller
 * performs the emit — the store holds no `AppHandle`.
 */
export const WATCHDOG_ACTIVITY = 'watchdog:activity';

/**
 * An arm-state transition, coalesced to at most one per second by the engine.
 *
 * This event existed in no area's design: `watchdogRowState(rule, runtime)` consumed a `runtime`
 * object **nobody produced**, so every row would have painted *Armed · waiting* and *Never fired*
 * regardless of reality. `get_watchdog_runtime()` supplies first paint — an event-only design leaves a
 * freshly opened Settings page blank until the next transition.
 */
export const WATCHDOG_STATE = 'watchdog:state';

export interface WatchdogChangedPayload {
  ruleIds: string[];
  deleted: string[];
  /**
   * Which window's Settings page made the change, so the log can read *"saved from window `main`,
   * replacing the version saved from `main-2`"*. Two windows may hold one rule open and the later save
   * wins whole — the log entry is the requirement, not concurrency control.
   */
  origin: string;
  at: number;
}

/**
 * Deliberately just the affected rule ids: the log view refetches or merges by entry id, so a
 * coalesced event never has to carry the rows it stands for.
 */
export interface WatchdogActivityPayload {
  ruleIds: string[];
}

export interface WatchdogRuntimePairState {
  /** `'unseen' | 'armed' | 'fired'` — the arm machine's own three states, lowercased. */
  state: 'unseen' | 'armed' | 'fired';
  lastFiredAt: number | null;
  firedCount: number;
  /**
   * A pinned id that is not currently live. **Dormant, never dropped** — session restore re-registers
   * the same `tm-` under a new `pc-`, so absence is not death. Only reported once it has been absent
   * continuously AND the engine has been up longer than the missing grace period, because at t=0 the
   * live set is empty and restore has not run.
   */
  missing: boolean;
}

/** `rules[ruleId][terminalId]`. */
export interface WatchdogStatePayload {
  rules: Record<string, Record<string, WatchdogRuntimePairState>>;
}
