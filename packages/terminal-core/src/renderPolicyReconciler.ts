import type { Terminal } from '@xterm/xterm';
import {
  countActiveWebGLAddons,
  getTerminalRenderPolicy,
  setTerminalRenderPolicy,
  type RenderPolicy,
} from './renderPolicy';
import { terminalCache } from './cache';

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
  /** Injection seams for tests; production omits all three. */
  setPolicy?: (id: string, want: RenderPolicy) => RenderPolicy;
  count?: () => number;
  /**
   * A terminal's CURRENT policy. Required for allocation: the budget is spent on
   * what is already live, so winners cannot be chosen — nor losers demoted — without
   * it. `null` (id not cached) is treated as not holding a context.
   */
  getPolicy?: (id: string) => RenderPolicy | null;
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
  const getPolicy = input.getPolicy ?? getTerminalRenderPolicy;
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

  // WINNER SELECTION, before any mutation.
  //
  // The budget must be allocated against what is ALREADY live, not against free
  // slots. Checking `count() >= budget` inside the promotion loop — without first
  // knowing each terminal's CURRENT policy — fails three ways:
  //   - an already-WebGL terminal at a full budget is reported 'dom' while it stays
  //     WebGL, so `applied` lies about the end state (breaks RULE 4);
  //   - a low-priority terminal holding the last slot is never demoted, so a
  //     higher-priority (focused) terminal can never take it (breaks RULE 2 and
  //     design/010 D8's unconditional focused promotion);
  //   - an over-budget starting set (20 live, budget 12) makes NO calls at all and
  //     reports webglCount 20 — the budget is not enforced (breaks criterion 5).
  // None of those states are reachable when every candidate starts on DOM, which is
  // why an implementation that only ever saw that case looked correct.
  //
  // `wantWebgl` is in promotion priority; the first `slots` of it are the winners.
  const wantWebgl = ordered.filter(id => input.desired[id] === 'webgl');

  // The count is GLOBAL (§5.1): terminals ABSENT from `desired` still hold addons
  // and still consume budget. They are not ours to demote, so they reduce the slots
  // available to this request rather than being reallocated.
  const liveOutside = Math.max(0, count() - ids.filter(id => getPolicy(id) === 'webgl').length);
  const slots = Math.max(0, input.budget - liveOutside);

  const winners = new Set(wantWebgl.slice(0, slots));

  // RULE 1: demote first — every requested demotion, PLUS every priority loser that
  // is currently holding a context. Freeing before requesting is what makes the
  // budget reachable at all: reversed, a swap at the boundary fails because the
  // context being freed is still held when the promotion asks for one.
  //
  // Iterates `ids`, NOT `ordered`: `order` is PROMOTION priority (§5), and every
  // demotion here runs unconditionally, so sorting this pass would imply a contract
  // the spec does not grant while changing nothing observable.
  for (const id of ids) {
    const wantsDom = input.desired[id] === 'dom';
    const isLoser = input.desired[id] === 'webgl' && !winners.has(id);
    if (!wantsDom && !isLoser) continue;
    // A loser already on DOM needs no call; record the end state and move on.
    if (isLoser && getPolicy(id) !== 'webgl') {
      applied[id] = 'dom';
      continue;
    }
    applied[id] = setPolicy(id, 'dom');
  }

  // RULE 2: promote the winners, in `order`.
  for (const id of wantWebgl) {
    if (!winners.has(id)) continue;
    // Idempotent: an already-WebGL winner keeps its context untouched. Calling
    // setPolicy anyway would be a no-op by design, but recording the end state
    // without the call keeps a full-budget steady state free of churn.
    if (getPolicy(id) === 'webgl') {
      applied[id] = 'webgl';
      continue;
    }
    // RULE 3: a failed promotion records 'dom' and the pass continues (D7).
    applied[id] = setPolicy(id, 'webgl');
  }

  return { applied, webglCount: count() };
}

export type RenderPolicySnapshot = Map<string, { terminal: Terminal; policy: RenderPolicy }>;

/**
 * design/013 D6 — capture the pre-canvas policy so leaving canvas mode does not
 * leave every terminal it demoted permanently on the DOM renderer.
 *
 * Keyed by `entry.terminal`, NOT the cache entry (§5.1 / design/012 §9 C1): the
 * Terminal is stable across relocation AND remount, whereas the entry is stable
 * across relocation only — and mount()'s entry rebuild carries webglAddon/useWebGL
 * forward, so an entry swap alone is not evidence the render policy changed.
 *
 * Reads the addon reference directly rather than through getTerminalRenderPolicy,
 * because it already holds the entry it would look up again (D8 keeps both on the
 * same source of truth).
 */
export function snapshotRenderPolicies(ids: string[]): RenderPolicySnapshot {
  const snap: RenderPolicySnapshot = new Map();
  for (const id of ids) {
    const entry = terminalCache.get(id);
    if (!entry) continue;
    snap.set(id, { terminal: entry.terminal, policy: entry.webglAddon ? 'webgl' : 'dom' });
  }
  return snap;
}

/**
 * Reinstate what `snapshotRenderPolicies` captured. Returns only the ids actually
 * restored — an id absent from the result was deliberately left alone.
 *
 * A snapshot is DISCARDED rather than applied when its Terminal no longer matches
 * (§5.1 "Snapshot conflicts"): the id may now address a different session, and
 * restoring blindly would undo an explicit user action — a context-menu "Reset
 * Rendering", a global WebGL toggle, or a context loss — or address a dead entry.
 */
export function restoreRenderPolicies(snap: RenderPolicySnapshot): Record<string, RenderPolicy> {
  const restored: Record<string, RenderPolicy> = {};
  for (const [id, want] of snap) {
    const entry = terminalCache.get(id);
    if (!entry || entry.terminal !== want.terminal) continue;
    if (getTerminalRenderPolicy(id) === want.policy) {
      restored[id] = want.policy;
      continue;
    }
    restored[id] = setTerminalRenderPolicy(id, want.policy);
  }
  return restored;
}
