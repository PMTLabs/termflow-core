/**
 * Spec 045 §3.3b — persistence half of the cwd restore. Kept out of
 * StateManager.ts so the rules stay unit-testable without localStorage or the
 * Redux store.
 */
import { getCwdSnapshot, setCwdSnapshot } from './cwdSnapshot';

/** Drop directories for terminals that no longer exist. Without this the map
 *  grows forever in localStorage and a recycled terminal id would inherit a
 *  stale directory. (StateManager sweeps orphaned pane trees the same way.) */
export function pruneCwds(all: Record<string, string>, keep: Set<string>): Record<string, string> {
  return Object.fromEntries(Object.entries(all).filter(([terminalId]) => keep.has(terminalId)));
}

/** Seed saved directories back into the snapshot module on restore, so the
 *  normal spawn path resolves them. Tolerates legacy state that predates the
 *  field, skips malformed entries, and never overwrites a fresher live value. */
export function seedRestoredCwds(saved: Record<string, string> | undefined): void {
  if (!saved || typeof saved !== 'object') return;
  for (const [terminalId, cwd] of Object.entries(saved)) {
    if (typeof cwd === 'string' && cwd && !getCwdSnapshot(terminalId)) {
      setCwdSnapshot(terminalId, cwd);
    }
  }
}
