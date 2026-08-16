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
  /**
   * Injection seams for tests; production omits ALL THREE — `setPolicy`, `count` and
   * `getPolicy` (design/013 §5).
   *
   * Back to three (rev 10). A fourth, `drain`, was added in rev 7 because this
   * function called `drainWebGLQuarantine()` unconditionally, so a caller faking the
   * other three still had a REAL quarantined addon disposed underneath it. The drain
   * itself is now gone — a retried dispose() cannot prove release — so there is
   * nothing left to inject and no module state left for this function to reach past
   * its seams. Keep this count honest: it was stale at "three" once before, and a
   * caller following it supplied the advertised three and still mutated real state.
   */
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

  // NO QUARANTINE DRAIN HERE (rev 10, pre-review `138`). Earlier revisions retried
  // the quarantine before the budget arithmetic, so a transient driver failure would
  // not tax a slot for the rest of the session. That retry could never work: an addon
  // xterm has wrapped latches `isDisposed` before its real dispose runs, so a retried
  // dispose() returns silently whether or not the context was freed — and the drain
  // then RELEASED it, converting a safe over-count into the under-count the quarantine
  // exists to prevent. A quarantined addon is now released only by its own
  // onContextLoss. The `drain` seam (review 129 LOW) went with the drain: there is
  // nothing left to inject.


  // `ids` is Object.keys order. Note it is NOT insertion order for integer-like
  // keys — that is precisely why `order` exists and is required (§5).
  const ids = Object.keys(input.desired);

  // Promotion priority. Array.prototype.sort is stable (ES2019+), so ids absent
  // from `order` compare equal to each other and keep their `ids` (Object.keys)
  // order behind every listed id — the tie-break §5 specifies.
  // FIRST occurrence wins. `new Map(order.map(...))` would let a later duplicate
  // overwrite the earlier rank, so `['focused', 'other', 'focused']` ranks `other`
  // above `focused` and hands it the last context — contradicting the
  // highest-priority-first contract and design/010 D8's unconditional focused
  // promotion. The contract does not require `order` to be duplicate-free, so the
  // reconciler must tolerate duplicates rather than assume them away (review 124).
  const priority = new Map<string, number>();
  input.order.forEach((id, i) => {
    if (!priority.has(id)) priority.set(id, i);
  });
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
  // `wantWebgl` is in promotion priority.
  const wantWebgl = ordered.filter(id => input.desired[id] === 'webgl');

  /** Holding a context right now. `null` (uncached) is NOT holding. */
  const holdsContext = (id: string): boolean => getPolicy(id) === 'webgl';

  // The count is GLOBAL (§5.1): terminals ABSENT from `desired` still hold addons
  // and still consume budget. They are not ours to demote, so they reduce the slots
  // available to this request rather than being reallocated. If they alone exceed
  // the budget, `slots` clamps to 0: every request-owned context is demoted and
  // none is promoted. That is the correct conservative outcome — `webglCount` then
  // stays above budget and exposes the external over-allocation to the caller
  // rather than hiding it by demoting terminals this request does not own.
  const liveOutside = Math.max(0, count() - ids.filter(holdsContext).length);
  const slots = Math.max(0, input.budget - liveOutside);

  // PROVISIONAL winners, used ONLY to decide which live candidates must be freed.
  // It is deliberately not used to gate promotion: see the promotion pass below.
  //
  // FILTERED to ids that can actually hold a context (rev 12, pre-review `142`).
  // An id absent from the cache — production `getPolicy` returns `null` and
  // `setTerminalRenderPolicy` returns 'dom' — can never consume a slot, so letting
  // it occupy one here makes a REAL, currently-holding, lower-priority terminal a
  // "loser" and demotes it. The promotion pass below then finds the slot still free
  // and re-promotes that terminal, which per D9/FA builds a BRAND-NEW WebglAddon.
  // Net: `applied` and `webglCount` are correct — which is why the existing tests
  // pass — but a live GPU context was disposed and rebuilt for nothing, with the
  // glyph-atlas rebuild and visible flicker that implies. That is exactly the
  // thrash the steady-state contract forbids.
  //
  // The comment on the promotion pass already identified this hazard and closed it
  // for promotion only; `provisionalWinners` still gated the DEMOTE decision and
  // was never revisited. Same hole, other side.
  const provisionalWinners = new Set(
    wantWebgl.filter((id) => getPolicy(id) !== null).slice(0, slots),
  );

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
    const isLoser = input.desired[id] === 'webgl' && !provisionalWinners.has(id);
    if (!wantsDom && !isLoser) continue;
    // Nothing to free: record the end state without a call. This applies to an
    // explicit-DOM entry as much as to a loser — calling setPolicy(id, 'dom') on a
    // terminal already on DOM made every repeat pass emit calls, so reconciling the
    // same mixed input twice was not call-idempotent (review 122 MEDIUM).
    if (!holdsContext(id)) {
      applied[id] = 'dom';
      continue;
    }
    applied[id] = setPolicy(id, 'dom');
  }

  // RULE 2/3: promote in priority order, over ALL WebGL candidates — not over a
  // fixed winners set.
  //
  // Gating on `provisionalWinners` here would strand a slot: if a winner's
  // promotion FAILS (RULE 3 / D7 — it returns 'dom'), the next candidate must be
  // able to take the freed capacity, but a preselected set skips it forever. Same
  // hole for an id absent from the cache, where production `getPolicy` returns
  // `null` and `setTerminalRenderPolicy` returns 'dom' — it would reserve a slot it
  // can never use (review 122 HIGH).
  //
  // Re-reading `count()` each iteration is what makes the cascade correct: a failed
  // promotion does not increment it, so the capacity really is still there for the
  // next candidate. It is also the honest budget basis per §5.1.
  for (const id of wantWebgl) {
    // Idempotent: an already-WebGL candidate keeps its context untouched. Calling
    // setPolicy anyway would be a no-op by design, but recording the end state
    // without the call keeps a full-budget steady state free of churn.
    if (holdsContext(id)) {
      applied[id] = 'webgl';
      continue;
    }
    if (count() >= input.budget) {
      applied[id] = 'dom';           // RULE 4: report what happened, not the request
      continue;
    }
    // RULE 3: a failed promotion records 'dom' and the pass continues (D7).
    applied[id] = setPolicy(id, 'webgl');
  }

  return { applied, webglCount: count() };
}

export type RenderPolicySnapshot = Map<
  string,
  { terminal: Terminal; policy: RenderPolicy; generation: number }
>;

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
    snap.set(id, {
      terminal: entry.terminal,
      policy: entry.webglAddon ? 'webgl' : 'dom',
      // Terminal identity alone cannot detect Reset Rendering, the global toggle,
      // or a context loss — all three mutate the policy of the SAME Terminal
      // (review 124). Each bumps this generation; canvas reconciliation does not.
      generation: entry.nonCanvasPolicyGeneration ?? 0,
    });
  }
  return snap;
}

/**
 * Reinstate what `snapshotRenderPolicies` captured. Returns only the ids actually
 * restored — an id absent from the result was deliberately left alone.
 *
 * A snapshot is DISCARDED rather than applied when EITHER check fails
 * (§5.1 "Snapshot conflicts"):
 *
 *   1. the Terminal no longer matches — the id now addresses a different session,
 *      or the entry is dead;
 *   2. `nonCanvasPolicyGeneration` has moved — Reset Rendering, the global WebGL
 *      toggle, or a context loss changed the policy while canvas was active.
 *
 * Check 2 is not redundant (review 124). All three of those events mutate the
 * policy of the SAME Terminal object, so they sailed through the identity check
 * and canvas exit promoted the terminal straight back to WebGL — undoing the
 * explicit action this contract says must win, or re-promoting onto a context the
 * GPU had just taken away.
 */
export function restoreRenderPolicies(snap: RenderPolicySnapshot): Record<string, RenderPolicy> {
  const restored: Record<string, RenderPolicy> = {};
  for (const [id, want] of snap) {
    const entry = terminalCache.get(id);
    if (!entry || entry.terminal !== want.terminal) continue;
    if ((entry.nonCanvasPolicyGeneration ?? 0) !== want.generation) continue;
    if (getTerminalRenderPolicy(id) === want.policy) {
      restored[id] = want.policy;
      continue;
    }
    restored[id] = setTerminalRenderPolicy(id, want.policy);
  }
  return restored;
}
