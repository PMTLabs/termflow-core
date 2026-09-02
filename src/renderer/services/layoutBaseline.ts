/**
 * plan/025 §2.5 — the "clean" reference point for workspace dirty-tracking.
 *
 * Module scope, not Redux: a `workspaceIdentity()` string can run into tens of
 * KB for a large workspace (`workspaceSnapshot.ts`), and nothing renders the
 * baseline itself — only the boolean derived from comparing against it does
 * (`layoutsSlice.isDirty`, set by whichever caller recomputes it). Putting a
 * value that large in Redux would mean every dispatch's devtools diff carries
 * it for no reader.
 *
 * Deliberately NOT auto-recomputed on every store tick — the plan calls for
 * recomputing "when the Layout Manager opens and on demand", so this module
 * only ever stores/compares whatever identity string its caller hands it.
 */

let baseline: string | null = null;

/** Record `identity` as the workspace's current "clean" reference point.
 *  Called after `saveCurrentLayout.fulfilled` (workspace scope only),
 *  `updateLayout.fulfilled`, `loadLayout.fulfilled`, and after
 *  `revertWorkspace` — see plan/025 §2.5. */
export function setLayoutBaseline(identity: string): void {
  baseline = identity;
}

/** The current baseline, or `null` if nothing has set one yet (or it was
 *  explicitly cleared) — distinct from `activeLayoutId === null`, which is the
 *  caller's OWN signal for "always dirty" (see `isWorkspaceDirty` below). */
export function getLayoutBaseline(): string | null {
  return baseline;
}

/** Forget the baseline — e.g. `resetToDefaultLayout`, where there is no longer
 *  a saved layout for the workspace to be clean AGAINST. */
export function clearLayoutBaseline(): void {
  baseline = null;
}

/**
 * Is the workspace dirty relative to the baseline?
 *
 * `activeLayoutId === null` means the workspace has never been saved/loaded
 * this session — there is nothing to be clean against, so the answer is always
 * `true` regardless of `currentIdentity` (plan/025 §2.5). Otherwise, dirty
 * means the current identity has drifted from the last-recorded baseline.
 */
export function isWorkspaceDirty(currentIdentity: string, activeLayoutId: string | null): boolean {
  if (activeLayoutId === null) return true;
  return currentIdentity !== baseline;
}
