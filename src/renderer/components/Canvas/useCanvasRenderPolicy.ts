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
import {
  desiredPolicies, promotionOrder, nextSuppressed, policySignature,
} from './canvasRenderPolicy';

/**
 * How long the viewport must be still before policies are reconciled.
 *
 * A pan dispatches a viewport update per pointer-move, and nodes cross the cull boundary
 * continuously while it does — so reconciling immediately would create and dispose real
 * WebGL contexts at pointer-move rate. This is the GPU-side counterpart of RC4's rule
 * that culling must never relocate: a gesture must not drive expensive, tearable work.
 */
const SETTLE_MS = 120;

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
  const lastSignature = useRef<string | null>(null);

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
      // Or re-entering Canvas Mode would compare against the last session's signature
      // and skip the first reconciliation entirely.
      lastSignature.current = null;
    };
    // Entry/exit only. `tiers` is read through a ref so a tier change cannot re-arm the
    // budget or re-take the snapshot — a second snapshot would capture policies THIS hook
    // had already changed, and restore them as if they were the user's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const ids = Object.keys(tiers);
    if (!ids.length) return;

    const desired = desiredPolicies(tiers, suppressed.current);
    // Nothing to do: this frame wants exactly the policies already applied. The common
    // case during a pan, and skipping it here keeps the settle timer from being armed
    // and re-armed for the whole gesture.
    const signature = policySignature(desired);
    if (signature === lastSignature.current) return;

    const timer = setTimeout(() => {
      lastSignature.current = signature;
      const result = reconcileRenderPolicies({
        desired,
        budget: MAX_GPU,
        order: promotionOrder(ids, focusedId, recent),
      });
      // CALLER-DROP. Held in a ref rather than state on purpose: this runs inside the
      // effect that produces it, so writing it to state would schedule a render whose
      // effect reconciles again — a loop. The updated set applies on the next pass, which
      // is the next tier, focus or recency change, and that is soon enough: the
      // reconciler is stateless, so nothing accumulates in the meantime.
      const before = suppressed.current;
      suppressed.current = nextSuppressed(before, result.failedPromotions, ids);
      // A new suppression means the signature just recorded is stale — the ids that
      // failed must now be asked for as 'dom'. Clearing it lets the NEXT run of this
      // effect reconcile instead of matching the signature and declining; without it the
      // failed ids would keep requesting WebGL for the rest of the session.
      if (suppressed.current !== before) lastSignature.current = null;
    }, SETTLE_MS);

    return () => clearTimeout(timer);
  }, [tiers, focusedId, recent]);
}
