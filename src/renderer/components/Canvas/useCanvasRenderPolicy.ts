import { useEffect, useRef } from 'react';
import {
  reconcileRenderPolicies,
  snapshotRenderPolicies,
  restoreRenderPolicies,
  setCanvasWebGLBudget,
  releaseCanvasWebGLBudget,
  type RenderPolicySnapshot,
} from '@termflow/terminal-core';
import { LodTier, MAX_GPU } from './canvasGeometry';
import { desiredPolicies, promotionOrder, nextSuppressed } from './canvasRenderPolicy';

/**
 * Drives P0-C's render policy for the length of a canvas session.
 *
 * Deliberately a THIN SHELL — every decision it makes lives in `canvasRenderPolicy.ts`
 * as a pure function, because this repo has no harness that can test a hook, so anything
 * left in here is unverifiable by construction.
 *
 * Mount is canvas entry and unmount is canvas exit: `CanvasMode` is rendered as
 * `{canvasEnabled && <CanvasMode />}`.
 */
export function useCanvasRenderPolicy(
  tiers: Record<string, LodTier>,
  focusedId: string | null,
  recent: readonly string[],
): void {
  const suppressed = useRef<ReadonlySet<string>>(new Set());
  const snapshot = useRef<RenderPolicySnapshot | null>(null);
  const tiersRef = useRef(tiers);
  tiersRef.current = tiers;

  useEffect(() => {
    // Capture the pre-canvas policy BEFORE arming the budget, so leaving canvas mode does
    // not leave every terminal it demoted permanently on the DOM renderer (design/013 D6).
    snapshot.current = snapshotRenderPolicies(Object.keys(tiersRef.current));
    setCanvasWebGLBudget(MAX_GPU);

    return () => {
      // THE ORDER HERE IS LOAD-BEARING: restore, THEN release. `restoreRenderPolicies`
      // reads `getCanvasWebGLBudget()` as its only authority, so releasing first uncaps
      // the restore and lets it promote unconditionally — transiently exceeding MAX_GPU
      // at exactly the moment the browser is most likely to evict a context.
      if (snapshot.current) restoreRenderPolicies(snapshot.current);
      releaseCanvasWebGLBudget();
      snapshot.current = null;
      suppressed.current = new Set();
    };
    // Entry/exit only. `tiers` is read through a ref so a tier change cannot re-arm the
    // budget or re-take the snapshot — a second snapshot would capture policies THIS hook
    // had already changed, and restore them as if they were the user's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const ids = Object.keys(tiers);
    if (!ids.length) return;
    const result = reconcileRenderPolicies({
      desired: desiredPolicies(tiers, suppressed.current),
      budget: MAX_GPU,
      order: promotionOrder(ids, focusedId, recent),
    });
    // CALLER-DROP. Held in a ref rather than state on purpose: this runs inside the
    // effect that produces it, so writing it to state would schedule a render whose
    // effect reconciles again — a loop. The updated set applies on the next pass, which
    // is the next tier, focus or recency change, and that is soon enough: the reconciler
    // is stateless, so nothing accumulates in the meantime.
    suppressed.current = nextSuppressed(suppressed.current, result.failedPromotions, ids);
  }, [tiers, focusedId, recent]);
}
