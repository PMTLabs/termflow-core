import {
  countActiveWebGLAddons,
  setTerminalRenderPolicy,
  type RenderPolicy,
} from './renderPolicy';

export interface ReconcileInput {
  /** From the LOD tier map. */
  desired: Record<string, RenderPolicy>;
  /** MAX_GPU. Owned by design/010 §4.2 (value 12); this package never defaults it. */
  budget: number;
  /**
   * REQUIRED (design/013 §5). The caller's PROMOTION priority, highest first.
   * Ids in `desired` but absent here are promoted after every listed id, in
   * `Object.keys(desired)` order; ids here but absent from `desired` are ignored.
   * Required rather than optional because the fallback — `Object.keys(desired)` —
   * returns integer-like keys first in ascending numeric order, which would
   * silently promote a numerically-large FOCUSED id last and land it outside the
   * budget. design/010 D8 makes the focused node's promotion unconditional.
   */
  order: string[];
  /** Injection seams for tests; production omits both. */
  setPolicy?: (id: string, want: RenderPolicy) => RenderPolicy;
  count?: () => number;
}

/**
 * design/013 §5 / D5. Tier ASSIGNMENT stays pure and lives in Canvas Mode; this maps
 * tiers -> policies, applies them, and reports what it achieved. That split is what
 * lets the budget be asserted against counts rather than tier strings.
 */
export function reconcileRenderPolicies(
  input: ReconcileInput,
): { applied: Record<string, RenderPolicy>; webglCount: number } {
  const setPolicy = input.setPolicy ?? setTerminalRenderPolicy;
  const count = input.count ?? countActiveWebGLAddons;
  const applied: Record<string, RenderPolicy> = {};

  // `ids` is Object.keys order. Note it is NOT insertion order for integer-like
  // keys — that is precisely why `order` exists and is required (§5).
  const ids = Object.keys(input.desired);

  // Promotion priority. Array.prototype.sort is stable (ES2019+), so ids absent
  // from `order` compare equal to each other and keep their `ids` (Object.keys)
  // order behind every listed id — the tie-break §5 specifies.
  const priority = new Map(input.order.map((id, i) => [id, i]));
  const rank = (id: string): number => priority.get(id) ?? Number.MAX_SAFE_INTEGER;
  const ordered = [...ids].sort((a, b) => rank(a) - rank(b));

  // RULE 1: demote first. Freeing contexts before requesting them is what makes the
  // budget REACHABLE at all — reversed, a swap at the boundary fails because the
  // context being freed is still held when the promotion asks for one.
  //
  // Iterates `ids`, NOT `ordered`: `order` is PROMOTION priority (§5), and every
  // requested demotion runs unconditionally, so sorting this pass would imply a
  // contract the spec does not grant while changing nothing observable.
  for (const id of ids) {
    if (input.desired[id] === 'dom') applied[id] = setPolicy(id, 'dom');
  }

  // RULE 2: promote in `order` until the budget is reached. The count is
  // GLOBAL (§5.1) — terminals absent from `desired` still hold addons, so asking
  // the cache rather than tracking a local tally is what keeps the budget honest.
  for (const id of ordered) {
    if (input.desired[id] !== 'webgl') continue;
    if (count() >= input.budget) {
      applied[id] = 'dom';           // RULE 4: report what happened, not the request
      continue;
    }
    // RULE 3: a failed promotion records 'dom' and the pass continues (D7).
    applied[id] = setPolicy(id, 'webgl');
  }

  return { applied, webglCount: count() };
}
