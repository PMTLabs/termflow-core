/**
 * plan/025 §2.2 — a one-deep undo slot for the immediately previous workspace.
 *
 * Module singleton, not Redux: there is exactly one slot, nothing needs to
 * subscribe to it via `useSelector`, and — unlike `layoutBaseline.ts` — this
 * one DOES need to survive a reload, so it is mirrored to localStorage under
 * `layoutUndoKey()` (per-window, alongside `sessionStateKey()` — see that
 * module's header). A revert after reload restores tabs/panes into an empty
 * `TerminalService.processes`, so the caller (`StateManager.revertWorkspace`)
 * must run `reconcileExistingTerminals` to rebind against the backend before
 * trusting the restored ids point at anything live.
 *
 * Every localStorage access is guarded — a private/blocked storage context
 * must degrade to "nothing to undo", never throw.
 */
import { WorkspaceSnapshot, isWorkspaceEmpty } from './workspaceSnapshot';
import { layoutUndoKey } from './windowScope';

/** The in-memory slot. `undefined` means "not yet read from localStorage this
 *  page life"; `null` means "read, and there was nothing (or nothing valid)". */
let slot: WorkspaceSnapshot | null | undefined;

const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

/** Lazily hydrate `slot` from localStorage, once per page life. Not called from
 *  `pushUndo`, which is about to overwrite the slot unconditionally anyway. */
function hydrate(): void {
  if (slot !== undefined) return;
  slot = null;
  try {
    const raw = localStorage.getItem(layoutUndoKey());
    if (raw) slot = JSON.parse(raw) as WorkspaceSnapshot;
  } catch {
    // Corrupt entry or inaccessible storage — behave as if nothing was saved.
    slot = null;
  }
}

/** Replace the slot with `s`. Refuses an empty workspace — offering "revert to
 *  nothing" is worse than offering no revert (plan/025 §2.2). Defense in depth:
 *  callers are expected to check `isWorkspaceEmpty` themselves before calling
 *  this (see `StateManager.loadLayout`), but the slot enforces it either way. */
export function pushUndo(s: WorkspaceSnapshot): void {
  if (isWorkspaceEmpty(s)) return;
  slot = s;
  try {
    localStorage.setItem(layoutUndoKey(), JSON.stringify(s));
  } catch {
    // Best-effort mirror; the in-memory slot for THIS page life is still correct.
  }
  notify();
}

/** Read the slot without consuming it — e.g. to enable/label a "Revert" button. */
export function peekUndo(): WorkspaceSnapshot | null {
  hydrate();
  // `hydrate` guarantees `slot` is no longer `undefined`; the `?? null` is only
  // to satisfy the type checker, which cannot see that across the call.
  return slot ?? null;
}

/** Read and clear the slot in one step, for an actual revert. */
export function takeUndo(): WorkspaceSnapshot | null {
  hydrate();
  const s = slot ?? null;
  slot = null;
  try {
    localStorage.removeItem(layoutUndoKey());
  } catch {
    // Best-effort; the in-memory slot is already cleared for this page life.
  }
  notify();
  return s;
}

/** Discard the slot without returning it — e.g. after a fresh reset makes the
 *  previous workspace no longer a meaningful revert target. */
export function clearUndo(): void {
  slot = null;
  try {
    localStorage.removeItem(layoutUndoKey());
  } catch {
    // Best-effort.
  }
  notify();
}

/** Subscribe to slot changes (push/take/clear), so a React component (the
 *  Layout Manager's Revert button) can re-render. Returns an unsubscribe fn. */
export function subscribeUndo(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Test-only: reset module state between cases, INCLUDING the hydration flag —
 *  back to `undefined` rather than `null`, so the next `peekUndo`/`takeUndo`
 *  re-reads localStorage exactly as it would on a fresh page load. Same
 *  convention as `cwdSnapshot.ts`'s `__resetCwdSnapshots`. */
export function __resetLayoutUndoForTests(): void {
  slot = undefined;
  listeners.clear();
}
