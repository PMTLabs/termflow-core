import { paintedNodeRect, Rect } from './canvasGeometry';
import { drawnFrameRect } from './canvasLayout';
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
 * `p` before two rects violate a minimum gap works out to about 5% and 1% respectively,
 * regardless of zoom. That is why gaps stayed visibly large at any real zoom even after a
 * min-gap floor was added: the pull itself could barely move anything. Shrinking the GAP
 * directly has no such floor — a rect's own size never enters the calculation — so it can
 * tighten however far the floor below allows, no matter how big the rects are.
 *
 * **The floor is anchored in SCREEN pixels, not world units.** On-screen size is world size ×
 * `z`, so a floor fixed in WORLD units looks fine at the zoom it was tuned for and then grows
 * without bound on screen as `z` keeps rising — precisely "still big at max zoom": every world
 * unit of floor gap costs `z` more screen pixels the further in you go. `targetGap` instead
 * blends the desired gap in SCREEN space, from the pair's own on-screen gap at `SPACING_Z_BASE`
 * (untouched) down toward `MIN_GAP_SCREEN_PX` as `z → ∞`, then converts back to world units for
 * `sweepAxis` to apply. The screen-space gap this produces is bounded by
 * `max(originalScreenGap, MIN_GAP_SCREEN_PX)` for every `z` and strictly decreases toward
 * `MIN_GAP_SCREEN_PX` — it can shrink further, it can never grow.
 */

/** The zoom at and below which spacing never applies — the layout a canvas was arranged at. */
export const SPACING_Z_BASE = 1;

/** Smallest on-screen gap Dynamic Spacing will ever leave between two rects, in SCREEN pixels —
 *  small, fixed, and zoom-invariant, so adjacent terminals (or adjacent group frames) never
 *  visually touch, and never balloon back open, however far the zoom goes. See `targetGap`. */
export const MIN_GAP_SCREEN_PX = 6;

/**
 * The world-space gap Dynamic Spacing leaves for a pair whose ORIGINAL world gap was
 * `originalGap`, at zoom `z`.
 *
 * `originalGap * zBase` is that pair's own on-screen gap at the base zoom (untouched — spacing
 * never applies at or below `zBase`). The target on-screen gap blends linearly, in `zBase / z`,
 * from that value down toward `minGapScreenPx` as `z` grows — reaching it only in the limit, so
 * the shrink is smooth, not a snap. Dividing back by `z` gives the world-space gap that produces
 * exactly that screen size at the current zoom.
 *
 * Never returns MORE than `originalGap`: a pair whose on-screen gap was already at or under
 * `minGapScreenPx` at `zBase` is left exactly as-is rather than pushed apart to reach the floor —
 * this function only ever shrinks a gap, the same guarantee the old WORLD-unit floor made, just
 * expressed in screen terms now.
 */
function targetGap(originalGap: number, z: number, zBase: number, minGapScreenPx: number): number {
  const originalScreenGap = originalGap * zBase;
  if (originalScreenGap <= minGapScreenPx) return originalGap;
  const screenGap = minGapScreenPx + (originalScreenGap - minGapScreenPx) * (zBase / z);
  return screenGap / z;
}

/**
 * `1` at or below `SPACING_Z_BASE` (or for a zoom that cannot happen), `zBase / z` above it.
 * `applySpacing` only uses this as an identity GATE (`>= 1` means "do nothing") — the actual
 * shrink math lives in `targetGap`, not here. Kept as its own function because "is spacing a
 * no-op at this zoom" is asked from more than one place and the `z <= zBase` edge case is easy
 * to get backwards.
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
 * Shrinks the gap between rects that are adjacent along `axis` AND share a lane on the other
 * axis (their extents there overlap — e.g. two frames in the same row, for `axis: 'x'`) toward
 * `targetGap(gap, z, zBase, minGapScreenPx)`. Only ever moves a rect along `axis`; the other
 * axis, and every rect's size, are untouched.
 *
 * Walks rects in sorted order along `axis` and, for each, takes the tightest bound imposed by
 * EVERY already-placed lane-mate — not merely its immediate predecessor in sort order.
 *
 * **That distinction is the whole correctness of this function, not a refinement.** A canvas of
 * four tabs is a 2×2 grid, and sorting a 2×2 grid by x interleaves the rows — `A(row1)`,
 * `C(row2)`, `B(row1)`, `D(row2)` — so every consecutive PAIR straddles two rows and fails the
 * lane test. An immediate-predecessor sweep therefore tightens nothing at all on the most
 * ordinary multi-row canvas there is, while looking perfectly correct on the single-row fixtures
 * a test suite reaches for first. Comparing against all placed lane-mates makes each row compact
 * along its own chain, which is what a grid needs.
 *
 * Safe by construction: a lane-mate `j` placed earlier contributes the lower bound
 * `end(out[j]) + targetGap(originalGap)`, and since `out[j]` only ever moved earlier and
 * `targetGap` never exceeds the gap it was given, that bound never pushes a rect LATER than
 * where it started. So every rect only moves earlier, and no pair that was clear before can end
 * up overlapping.
 */
function sweepAxis(rects: Rect[], axis: 'x' | 'y', z: number, zBase: number, minGapScreenPx: number): Rect[] {
  const startOf = (r: Rect) => (axis === 'x' ? r.x : r.y);
  const sizeOf = (r: Rect) => (axis === 'x' ? r.w : r.h);
  const laneOf = (r: Rect) => (axis === 'x' ? { start: r.y, size: r.h } : { start: r.x, size: r.w });

  const order = rects.map((_, i) => i).sort((i, j) => startOf(rects[i]) - startOf(rects[j]));
  const out = rects.map((r) => ({ ...r }));
  const placed: number[] = [];

  for (const idx of order) {
    const r = rects[idx];
    const start = startOf(r);
    const lane = laneOf(r);
    // The tightest lower bound any already-placed lane-mate imposes. A rect with none is the
    // first in its lane and simply stays where it is; the rest of its lane compacts onto it.
    let bound = Number.NEGATIVE_INFINITY;

    for (const j of placed) {
      const other = rects[j];
      const otherLane = laneOf(other);
      if (!spansOverlap(lane.start, lane.size, otherLane.start, otherLane.size)) continue;
      // Only rects genuinely BEFORE this one along `axis` constrain it. A negative gap means
      // they already overlap on this axis, which spacing did not cause and will not resolve.
      const originalGap = start - (startOf(other) + sizeOf(other));
      if (originalGap < 0) continue;
      const b = startOf(out[j]) + sizeOf(out[j]) + targetGap(originalGap, z, zBase, minGapScreenPx);
      if (b > bound) bound = b;
    }

    const newStart = bound === Number.NEGATIVE_INFINITY ? start : Math.min(start, bound);
    out[idx] = axis === 'x' ? { ...out[idx], x: newStart } : { ...out[idx], y: newStart };
    placed.push(idx);
  }
  return out;
}

/** `rects` after one gap-shrink pass along X, then one along Y — see `sweepAxis`. Sequential,
 *  not simultaneous: the Y pass's lane test reads the X positions the X pass already produced. */
function tighten(rects: Rect[], z: number, zBase: number, minGapScreenPx: number): Rect[] {
  return sweepAxis(sweepAxis(rects, 'x', z, zBase, minGapScreenPx), 'y', z, zBase, minGapScreenPx);
}

export interface SpacingResult {
  nodeRects: Record<string, Rect>;
  groupRects: Record<string, Rect>;
}

/**
 * The spacing-adjusted position of every node and group in `model`, at zoom `z`.
 *
 * **Sweeps DRAWN geometry, not layout rects — this is the whole ballgame.** A group frame is
 * not painted on its layout rect: `drawnFrameRect` rescales its padding into a screen band, so
 * above z≈1.5 each border is inset by `PAD - PAD_SCREEN_MAX/z` world units per side, and that
 * inset GROWS with zoom. A node likewise paints `headSlack(z)` shorter than its rect above zoom
 * 1 (`paintedNodeRect`). Tightening the layout rects therefore fixed a box nobody can see: the
 * layout gap fell 28 → 13 screen px from z=1 to z=3 while the gap between the DRAWN borders rose
 * 28 → 61, and terminal-to-terminal went 60 → 109. Zooming in pushed things APART, which is the
 * exact opposite of the feature's purpose. So each level sweeps the rects as PAINTED and applies
 * the resulting translation back to the layout rect — legitimate because both `drawnFrameRect`
 * and `paintedNodeRect` are rigid functions of the layout rect at a fixed `z`, so translating
 * the layout rect by `d` translates the painted one by exactly `d`.
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

  if (!enabled || spacingFactor(z) >= 1) return { nodeRects, groupRects };

  if (model.groups.length > 1) {
    const layout = model.groups.map((g) => g.rect);
    const drawn = layout.map((r) => drawnFrameRect(r, z));
    const tightened = tighten(drawn, z, SPACING_Z_BASE, MIN_GAP_SCREEN_PX);
    model.groups.forEach((g, i) => {
      const dx = tightened[i].x - drawn[i].x;
      const dy = tightened[i].y - drawn[i].y;
      groupRects[g.tabId] = { ...layout[i], x: layout[i].x + dx, y: layout[i].y + dy };
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
    const layout = members.map((n) => nodeRects[n.terminalId]);
    const painted = layout.map((r) => paintedNodeRect(r, z, false));
    const tightened = tighten(painted, z, SPACING_Z_BASE, MIN_GAP_SCREEN_PX);
    members.forEach((n, i) => {
      nodeRects[n.terminalId] = {
        ...layout[i],
        x: layout[i].x + (tightened[i].x - painted[i].x),
        y: layout[i].y + (tightened[i].y - painted[i].y),
      };
    });
  }

  return { nodeRects, groupRects };
}
