import { Rect } from './canvasGeometry';
import { CanvasModel } from './canvasSelectors';

/**
 * Dynamic Spacing — plan/039. A toolbar toggle that, above this zoom, shrinks the WORLD-SPACE
 * gap between nodes (toward their siblings) and between groups (toward their neighbours), so a
 * high zoom shows more readable terminals at once instead of more empty gutter.
 *
 * Deliberately a RENDER-TIME transform, never written to `canvasSlice`. Stored rects
 * (`arrange`, `seedNodePosition`, manual drag) stay the single source of spatial truth — see
 * `canvasLayout.ts`'s own split between layout and what a frame is DRAWN with
 * (`framePadScale`/`drawnFrameRect`) for the precedent this follows. That is what makes
 * toggling off (or zooming back to `SPACING_Z_BASE`) an exact, instant revert: `applySpacing`
 * is a pure function of the current stored rects and the current zoom, recomputed every render.
 *
 * **Gap-shrink, not scale-toward-a-point.** An earlier version pulled every rect a fraction of
 * the way toward a shared centroid. That degenerates the moment rects are already packed
 * tightly relative to their own size — which is the DEFAULT canvas layout, not an edge case: a
 * single-node group frame is `~372` world units wide but only `GROUP_GAP` (28) apart from its
 * neighbour, and a node row is `340` wide but only `GAP_X` (10) apart from the next node. Scaling
 * distance-to-target by a fraction `p` shrinks a pair's gap by `(1-p)*(gap+size) - size`, which
 * is dominated by `size` the instant `size >> gap` — for those two real numbers, the largest safe
 * `p` before two rects violate `MIN_GAP` works out to about 5% and 1% respectively, regardless of
 * zoom. That is why gaps stayed visibly large at any real zoom even after the min-gap floor was
 * added: the pull itself could barely move anything. Shrinking the GAP directly has no such
 * floor — a rect's own size never enters the calculation — so it can tighten all the way to
 * `MIN_GAP` no matter how big the rects are.
 */

/** The zoom at and below which spacing never applies — the layout a canvas was arranged at. */
export const SPACING_Z_BASE = 1;

/** Smallest world-space gap Dynamic Spacing will ever leave between two rects: small and
 *  fixed, so adjacent terminals (or adjacent group frames) never visually touch however far
 *  the zoom pulls. */
export const MIN_GAP = 6;

/**
 * How much of a gap survives at zoom `z`, as a multiplier on the ORIGINAL gap. `1` = untouched.
 *
 * `zBase / z` rather than a fixed curve, so a canvas arranged at a different baseline (none
 * exists yet, but nothing here assumes `1`) would scale the same way. It keeps shrinking toward
 * zero as zoom rises; `sweepAxis`'s own `MIN_GAP` clamp is what stops a gap from disappearing.
 */
export function spacingFactor(z: number, zBase: number = SPACING_Z_BASE): number {
  if (!(z > 0) || z <= zBase) return 1;
  return zBase / z;
}

/** Whether two spans `[aStart, aStart+aSize)` and `[bStart, bStart+bSize)` overlap — the test
 *  used on the OTHER axis to decide two rects are actually side-by-side (share a "lane"), not
 *  stacked and merely incidental neighbours in sort order. */
function spansOverlap(aStart: number, aSize: number, bStart: number, bSize: number): boolean {
  return aStart < bStart + bSize && bStart < aStart + aSize;
}

/**
 * Shrinks the gap between every pair of rects that are adjacent along `axis` AND share a lane on
 * the other axis (their extents there overlap — e.g. two frames in the same row, for
 * `axis: 'x'`) toward `minGap`, scaled by `k`. Only ever moves a rect along `axis`; the other
 * axis, and every rect's size, are untouched.
 *
 * Walks rects in sorted order along `axis` and compares each one only to its immediate
 * predecessor in that order — not every lane-mate, just the nearest one. That misses shrinking a
 * gap between two lane-mates that have some unrelated, differently-laned rect sitting between
 * them in sort order (rare on a real canvas, which lays groups and nodes out in clean rows), but
 * it is never unsafe: a rect that is not a lane-mate of its immediate predecessor simply inherits
 * that predecessor's already-applied shift as a rigid translation, which preserves — never
 * shrinks past, never widens — whatever gap it already had to its actual neighbours. Since every
 * rect only ever moves earlier along `axis` (shift is monotonically non-increasing) and every
 * shrink stops at `minGap` (or preserves the original gap untouched if it started below
 * `minGap` already — this never pushes two rects apart), no pair can end up overlapping that did
 * not already overlap before this ran.
 */
function sweepAxis(rects: Rect[], axis: 'x' | 'y', k: number, minGap: number): Rect[] {
  const order = rects.map((_, i) => i).sort((i, j) => (
    axis === 'x' ? rects[i].x - rects[j].x : rects[i].y - rects[j].y
  ));
  const out = rects.map((r) => ({ ...r }));
  let shift = 0;
  let prevIdx = -1;
  for (const idx of order) {
    const r = rects[idx];
    let newStart = (axis === 'x' ? r.x : r.y) + shift;
    if (prevIdx >= 0) {
      const prev = rects[prevIdx];
      const otherA = axis === 'x' ? { start: r.y, size: r.h } : { start: r.x, size: r.w };
      const otherB = axis === 'x' ? { start: prev.y, size: prev.h } : { start: prev.x, size: prev.w };
      if (spansOverlap(otherA.start, otherA.size, otherB.start, otherB.size)) {
        const prevOut = out[prevIdx];
        const prevEnd = axis === 'x' ? prevOut.x + prevOut.w : prevOut.y + prevOut.h;
        const currentGap = newStart - prevEnd;
        const desiredGap = currentGap < minGap ? currentGap : Math.max(minGap, currentGap * k);
        const reduction = currentGap - desiredGap;
        shift -= reduction;
        newStart -= reduction;
      }
    }
    out[idx] = axis === 'x' ? { ...out[idx], x: newStart } : { ...out[idx], y: newStart };
    prevIdx = idx;
  }
  return out;
}

/** `rects` after one gap-shrink pass along X, then one along Y — see `sweepAxis`. Sequential,
 *  not simultaneous: the Y pass's lane test reads the X positions the X pass already produced. */
function tighten(rects: Rect[], k: number, minGap: number): Rect[] {
  return sweepAxis(sweepAxis(rects, 'x', k, minGap), 'y', k, minGap);
}

export interface SpacingResult {
  nodeRects: Record<string, Rect>;
  groupRects: Record<string, Rect>;
}

/**
 * The spacing-adjusted position of every node and group in `model`, at zoom `z`.
 *
 * Hierarchical, matching the approved design (plan/039 §4): group frames tighten toward each
 * other first, TRANSLATING every member node by the same delta as its frame — a group frame's
 * own centre is not its members' centre (`fitGroupFrame` pads the top and bottom differently, for
 * the label — see `canvasLayout.ts`), so pulling a node independently toward its frame's new
 * position would drift it even in a single-node group. Translating instead keeps every node
 * rigidly attached to its moving frame, exactly like a manual group drag (`moveGroupBy`) already
 * does. Each group's own nodes then get a second, independent tighten toward their siblings, on
 * top of whatever step 1 already moved them by.
 *
 * Returns the ORIGINAL rects, unchanged, when `enabled` is false or `z` is at or below
 * `SPACING_Z_BASE` — the identity fast path that makes toggling off (or zooming back down) an
 * exact revert rather than an animated one, because there is nothing left to un-apply.
 */
export function applySpacing(model: CanvasModel, z: number, enabled: boolean): SpacingResult {
  const nodeRects: Record<string, Rect> = {};
  const groupRects: Record<string, Rect> = {};
  for (const n of model.nodes) nodeRects[n.terminalId] = n.rect;
  for (const g of model.groups) groupRects[g.tabId] = g.rect;

  const k = enabled ? spacingFactor(z) : 1;
  if (k >= 1) return { nodeRects, groupRects };

  if (model.groups.length > 1) {
    const before = model.groups.map((g) => g.rect);
    const after = tighten(before, k, MIN_GAP);
    model.groups.forEach((g, i) => {
      groupRects[g.tabId] = after[i];
      const dx = after[i].x - before[i].x;
      const dy = after[i].y - before[i].y;
      if (dx === 0 && dy === 0) return;
      for (const id of g.nodeIds) {
        const r = nodeRects[id];
        if (r) nodeRects[id] = { ...r, x: r.x + dx, y: r.y + dy };
      }
    });
  }

  for (const g of model.groups) {
    const members = model.nodes.filter((n) => g.nodeIds.includes(n.terminalId));
    if (members.length <= 1) continue;
    const before = members.map((n) => nodeRects[n.terminalId]);
    const after = tighten(before, k, MIN_GAP);
    members.forEach((n, i) => { nodeRects[n.terminalId] = after[i]; });
  }

  return { nodeRects, groupRects };
}
