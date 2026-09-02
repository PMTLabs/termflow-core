/**
 * plan/025 §2.6 — the handler side of a `Toast.action`.
 *
 * A toast's `action` field is `{ label, actionId }` only — Redux state must stay
 * serialisable for RTK's `serializableCheck`, so it cannot carry a callback directly.
 * The real handler lives here instead, in a plain module-scope registry keyed by
 * `actionId`. Whoever dispatches an action-bearing toast registers its handler here
 * first (and unregisters it once the toast it belongs to is no longer reachable), and
 * `ToastContainer` looks the handler up by id when the action button is clicked.
 *
 * A missing id is always a silent no-op — the toast may already have been dismissed,
 * or its one-shot handler may already have run, by the time the click is processed.
 */

type ToastActionHandler = () => void;

const handlers = new Map<string, ToastActionHandler>();

/** Register `handler` under `actionId`. Overwrites any existing handler for the same
 *  id — callers are expected to mint a fresh id per toast (see `makeToastActionId`),
 *  so a collision would only ever mean a caller reused an id itself. */
export function registerToastAction(actionId: string, handler: ToastActionHandler): void {
  handlers.set(actionId, handler);
}

/** Remove `actionId`'s handler. Call this once the toast it belonged to is gone
 *  (dismissed, or its action already ran) — otherwise the registry only ever grows. */
export function unregisterToastAction(actionId: string): void {
  handlers.delete(actionId);
}

/** Run the handler registered for `actionId`, if any. */
export function runToastAction(actionId: string): void {
  handlers.get(actionId)?.();
}

// Not `generateId` (`utils/id.ts`) — that helper's prefix union is closed over the
// app's own entity kinds (tabs/panes/terminals) and isn't meant to grow for every
// unrelated caller that needs a unique string.
let counter = 0;

/** A unique id for a toast action, e.g. `toast-action-<ts>-<n>`. */
export function makeToastActionId(prefix = 'toast-action'): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

/** Test-only: reset module state between cases. */
export function __resetToastActionsForTests(): void {
  handlers.clear();
  counter = 0;
}
