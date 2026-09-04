/**
 * The three events the Automations feature emits, and the payloads they carry.
 *
 * **These names are normative and nothing may spell one inline.** Before a line of this feature was
 * written they were already broken four ways: the engine was to emit `workflow:activity` /
 * `workflow:state`, the store `automations:changed` / `automations:activity`, the settings UI listened for
 * `automation:changed` / `automation:activity`, and the handoff proposed `automation:changed` again by
 * another route. **No emitter overlapped the only listener.** No window would ever have repainted, the
 * live log would never have appended — and every area's unit tests would still have passed, because a
 * string literal that nobody else imports cannot disagree with anything. This module exists so that it
 * can. Plan 028 §7.2, M0.2.
 *
 * The Rust side of the same contract is `src-tauri/src/automation/events.rs`; the constants and the
 * field names must match it exactly.
 */

/**
 * A rule definition changed: created, edited, enabled, disabled, duplicated, reset or deleted.
 * Emitted by the command layer after every definition mutation, uncoalesced — a user edit is one
 * event. `useAutomations()` refetches the list.
 *
 * **The command layer is no longer the only emitter.** The engine raises this too, on exactly one
 * occasion: a `runs_once` rule completing. Nothing else can carry `completedAt` to an open window —
 * `automation:state` drops the rule from its payload at that very moment, because completing removes
 * it from the live set — so without this event every open list goes on drawing the row as armed.
 */
export const AUTOMATION_CHANGED = 'automation:changed';

/**
 * A row was appended to the activity log. The store decides whether one is due (at most one per
 * second, inside `append`, so the rate limit cannot be re-implemented per caller) and its caller
 * performs the emit — the store holds no `AppHandle`.
 */
export const AUTOMATION_ACTIVITY = 'automation:activity';

/**
 * An arm-state transition, coalesced to at most one per second by the engine.
 *
 * This event existed in no area's design: `automationRowState(rule, runtime)` consumed a `runtime`
 * object **nobody produced**, so every row would have painted *Armed · waiting* and *Never fired*
 * regardless of reality. `get_automation_runtime()` supplies first paint — an event-only design leaves a
 * freshly opened Settings page blank until the next transition.
 */
export const AUTOMATION_STATE = 'automation:state';

export interface AutomationChangedPayload {
  ruleIds: string[];
  deleted: string[];
  /**
   * Which window's Settings page made the change, so the log can read *"saved from window `main`,
   * replacing the version saved from `main-2`"*. Two windows may hold one rule open and the later save
   * wins whole — the log entry is the requirement, not concurrency control.
   *
   * **Not always a window.** An engine-raised change carries `"engine"`, whose definition of record
   * is `ENGINE_ORIGIN` in `src-tauri/src/automation/events.rs` — deliberately not mirrored as a
   * constant here, because no consumer branches on this field: `useAutomations` refetches on the
   * event and ignores the payload entirely. Mirror it when something branches, and not before.
   */
  origin: string;
  at: number;
}

/**
 * Deliberately just the affected rule ids: the log view refetches or merges by entry id, so a
 * coalesced event never has to carry the rows it stands for.
 */
export interface AutomationActivityPayload {
  ruleIds: string[];
}

export interface AutomationRuntimePairState {
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
export interface AutomationStatePayload {
  rules: Record<string, Record<string, AutomationRuntimePairState>>;
}
