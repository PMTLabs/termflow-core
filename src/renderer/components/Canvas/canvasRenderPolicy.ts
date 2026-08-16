import type { RenderPolicy } from '@termflow/terminal-core';
import { LodTier, priorityOrder } from './canvasGeometry';

/**
 * The pure half of Canvas Mode's render-policy control (design/013 §5: tier ASSIGNMENT
 * lives in Canvas Mode, the reconciler maps tiers to policies and applies them).
 *
 * Everything here is arithmetic over plain values so it is testable — the effect that
 * actually calls `reconcileRenderPolicies` is a thin shell in `useCanvasRenderPolicy`,
 * and this repo has no harness that can test a hook.
 */

/**
 * Tier → policy. Only the `gpu` tier is worth a WebGL context; `live` paints through
 * the DOM renderer, and everything below it does not paint the terminal at all.
 *
 * `suppressed` is the CALLER-DROP set: ids whose promotion the renderer has already
 * refused. They are downgraded to `'dom'` here, BEFORE the reconciler sees them, so the
 * reconciler never allocates them a winner slot in the first place.
 */
export function desiredPolicies(
  tiers: Record<string, LodTier>,
  suppressed: ReadonlySet<string>,
): Record<string, RenderPolicy> {
  const out: Record<string, RenderPolicy> = {};
  for (const [id, tier] of Object.entries(tiers)) {
    out[id] = tier === 'gpu' && !suppressed.has(id) ? 'webgl' : 'dom';
  }
  return out;
}

/**
 * The `order` `reconcileRenderPolicies` requires — promotion priority, highest first.
 *
 * This is `assignTiers`' own ranking function, not a copy of it. `order` is REQUIRED by
 * the reconciler precisely because its fallback (`Object.keys`) returns integer-like keys
 * first in ascending numeric order, which would promote a numerically-large FOCUSED id
 * last and land it outside the budget.
 */
export function promotionOrder(
  ids: readonly string[],
  focusedId: string | null,
  recent: readonly string[],
): string[] {
  return priorityOrder(ids, focusedId, recent);
}

/**
 * CALLER-DROP (design/013 §5). Fold this pass's `failedPromotions` into the suppression
 * set, and forget ids that are no longer on the canvas.
 *
 * Keyed on `failedPromotions` and NOTHING else. `applied[id] === 'dom'` is returned for
 * three different situations — a refused promotion, an incumbent demoted to make room,
 * and a lower-ranked candidate whose slot was deliberately withheld — so suppressing on
 * it would drop all three and strand the slot indefinitely.
 *
 * Returns the SAME Set instance when nothing changed. That is not an optimisation: the
 * caller stores this and reconciles when it changes, so a fresh Set on every pass is a
 * render loop.
 *
 * `rearm` drops ids back out of suppression. Per §5 the legitimate re-arm signals are a
 * `Terminal` replacement, the global WebGL toggle being switched back on, and a
 * context-loss or visibility event for that terminal — never simply "time passed".
 */
export function nextSuppressed(
  prev: ReadonlySet<string>,
  failedPromotions: readonly string[],
  presentIds: readonly string[],
  rearm: readonly string[] = [],
): ReadonlySet<string> {
  const present = new Set(presentIds);
  const next = new Set<string>();
  for (const id of prev) if (present.has(id)) next.add(id);
  for (const id of failedPromotions) if (present.has(id)) next.add(id);
  for (const id of rearm) next.delete(id);

  if (next.size === prev.size) {
    let same = true;
    for (const id of next) if (!prev.has(id)) { same = false; break; }
    if (same) return prev;
  }
  return next;
}
