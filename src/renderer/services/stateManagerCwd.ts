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

/** Re-key saved directories when sanitisation rewrites a pane's terminal id.
 *  Without this the cwd is orphaned under the old id and the restored pane
 *  starts in the profile default instead of where the user left it
 *  (design 011 §6, review 086 Q4). An entry that already exists under the NEW
 *  id is fresher and wins. */
export function remapCwds(
  all: Record<string, string>,
  mapping: Map<string, string>,
): Record<string, string> {
  if (mapping.size === 0) return { ...all };
  const out: Record<string, string> = {};
  for (const [terminalId, cwd] of Object.entries(all)) {
    const target = mapping.get(terminalId) ?? terminalId;
    if (mapping.has(terminalId) && Object.prototype.hasOwnProperty.call(all, target)) continue;
    out[target] = cwd;
  }
  return out;
}
