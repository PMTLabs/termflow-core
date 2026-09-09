import { Rect } from './canvasGeometry';
import { CanvasModel } from './canvasSelectors';

/**
 * Dynamic Spacing — plan/039. A toolbar toggle that, above this zoom, shrinks the WORLD-SPACE
 * gap between nodes (toward their group's centre) and between groups (toward the canvas
 * centre), so a high zoom shows more readable terminals at once instead of more empty gutter.
 *
 * Deliberately a RENDER-TIME transform, never written to `canvasSlice`. Stored rects
 * (`arrange`, `seedNodePosition`, manual drag) stay the single source of spatial truth — see
 * `canvasLayout.ts`'s own split between layout and what a frame is DRAWN with
 * (`framePadScale`/`drawnFrameRect`) for the precedent this follows. That is what makes
 * toggling off (or zooming back to `SPACING_Z_BASE`) an exact, instant revert: `applySpacing`
 * is a pure function of the current stored rects and the current zoom, recomputed every render.
 */

/** The zoom at and below which spacing never applies — the layout a canvas was arranged at. */
export const SPACING_Z_BASE = 1;

/** However far past `SPACING_Z_BASE` the zoom goes, the pull factor never shrinks past this —
 *  spacing tightens gaps, it never lets nodes collapse onto their group's centre. */
export const SPACING_FLOOR = 0.35;

/**
 * How much of a rect's distance to its pull target survives at zoom `z`. `1` = untouched.
 *
 * `zBase / z` rather than a fixed curve, so a canvas arranged at a different baseline (none
 * exists yet, but nothing here assumes `1`) would scale the same way. Floored, never zero, so
 * `applySpacing`'s pull is always a fraction short of "on top of the target" — the overlap
 * clamp in `maxSafePull` is what actually stops two rects from touching, but this keeps the
 * INTENDED pull from ever asking for that either.
 */
export function spacingFactor(z: number, zBase: number = SPACING_Z_BASE): number {
  if (!(z > 0) || z <= zBase) return 1;
  return Math.max(SPACING_FLOOR, zBase / z);
}

/** The centre of a rect. */
function centerOf(r: Rect): { x: number; y: number } {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** The centroid of several rects' centres — unweighted, so a big frame does not out-pull a
 *  small one any more than one extra rect at the same spot would. */
function centroidOf(rects: Rect[]): { x: number; y: number } {
  const c = rects.reduce((acc, r) => {
    const p = centerOf(r);
    return { x: acc.x + p.x, y: acc.y + p.y };
  }, { x: 0, y: 0 });
  return { x: c.x / rects.length, y: c.y / rects.length };
}

/** `r` moved a fraction `p` of the way from its own centre toward `target`. Size is untouched —
 *  Dynamic Spacing only ever moves a rect, never resizes it (P0: grid dimensions and font size
 *  are not this feature's to change). */
function pulledRect(r: Rect, target: { x: number; y: number }, p: number): Rect {
  const c = centerOf(r);
  const cx = c.x + (target.x - c.x) * p;
  const cy = c.y + (target.y - c.y) * p;
  return { x: cx - r.w / 2, y: cy - r.h / 2, w: r.w, h: r.h };
}

/** O(n²) in `rects.length` — fine at canvas-sized groups, worth revisiting (e.g. a sweep line)
 *  if a single group's member count ever grows into the hundreds. */
function anyOverlap(rects: Rect[]): boolean {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      if (!(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y)) return true;
    }
  }
  return false;
}

/**
 * The largest pull fraction `p` in `[0, 1]` that moves every item toward `target` (see
 * `pulledRect`) without making any pair of them overlap.
 *
 * **Why a search, not a closed form.** Two rects converging on one shared point shrink their
 * centre-to-centre distance linearly and monotonically in `p` (distance at `p` is exactly
 * `(1 - p)` times distance at `0`), so "do any two overlap" flips at most once as `p` rises from
 * 0 to 1 — which is exactly what makes bisection valid here, and also what gives `applySpacing`
 * its monotonic-in-zoom guarantee for free (see its own note).
 *
 * Independent of zoom, deliberately: the target and the starting rects are the only inputs, so
 * a caller may compute this once per layout change and reuse it at every zoom instead of
 * re-searching every frame.
 *
 * Assumes the rects do NOT already overlap at `p = 0`. If they do — the only way that happens
 * is a manual drag that has already put two nodes on top of each other — this returns `0`
 * rather than search: Dynamic Spacing did not create that overlap and has no safe direction to
 * resolve it in, so the least surprising thing it can do is nothing.
 */
function maxSafePull(items: { rect: Rect }[], target: { x: number; y: number }): number {
  if (items.length <= 1) return 1;
  const rectsAt = (p: number) => items.map((it) => pulledRect(it.rect, target, p));
  if (anyOverlap(rectsAt(0))) return 0;
  let lo = 0, hi = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (anyOverlap(rectsAt(mid))) hi = mid; else lo = mid;
  }
  return lo;
}

export interface SpacingResult {
  nodeRects: Record<string, Rect>;
  groupRects: Record<string, Rect>;
}

export interface SpacingBudget {
  /** Max safe pull fraction for the group-level step (toward the canvas centroid). `1` when
   *  there is nothing to clamp (0 or 1 group). */
  groupPull: number;
  /** Max safe pull fraction for each group's own node-level step (toward its sibling centroid),
   *  keyed by `tabId`. `1` for a group with 0 or 1 member. */
  nodePullByGroup: Record<string, number>;
}

/**
 * The overlap-safety budget for `model`'s CURRENT layout — the expensive half of `applySpacing`,
 * split out because `maxSafePull` does not depend on zoom (its own note: pairwise distance
 * shrinks by the same `(1 - p)` factor for ANY shared target, so the target's exact location —
 * and therefore how far `z` has pulled toward it — never enters the overlap search).
 *
 * A caller may compute this once per LAYOUT change and reuse it at every zoom tick instead of
 * re-running the bisection on every wheel event — which matters, because `applySpacing` used to
 * do exactly that: a full O(groups² + Σ members²) × 30-iteration search on every `vp.z` change,
 * i.e. every tick of a live pinch/wheel zoom. `CanvasMode` memoises this on the model alone.
 */
export function computeSpacingBudget(model: CanvasModel): SpacingBudget {
  const groupPull = model.groups.length > 0
    ? maxSafePull(
      model.groups.map((g) => ({ rect: g.rect })),
      centroidOf(model.groups.map((g) => g.rect)),
    )
    : 1;

  const nodePullByGroup: Record<string, number> = {};
  for (const g of model.groups) {
    const members = model.nodes.filter((n) => g.nodeIds.includes(n.terminalId));
    if (members.length <= 1) { nodePullByGroup[g.tabId] = 1; continue; }
    nodePullByGroup[g.tabId] = maxSafePull(
      members.map((n) => ({ rect: n.rect })),
      centroidOf(members.map((n) => n.rect)),
    );
  }
  return { groupPull, nodePullByGroup };
}

/**
 * The spacing-adjusted position of every node and group in `model`, at zoom `z`.
 *
 * Hierarchical, matching the approved design (plan/039 §4): groups are pulled toward the whole
 * canvas's centroid first, then each group's own nodes are pulled toward that group's
 * (already-moved) centre. Both levels clamp against their own overlap via `budget` — never
 * against `GAP_X`/`GAP_Y`/`GROUP_GAP`, which are layout constants this deliberately never reads
 * (see the module note: spacing is a rendering rule, not a second layout).
 *
 * `budget` is optional and computed on the fly when omitted, so this stays correct on its own —
 * only slower under a rapid zoom, which is exactly the case `computeSpacingBudget` exists to let
 * a caller avoid by passing one in.
 *
 * Returns the ORIGINAL rects, unchanged, when `enabled` is false or `z` is at or below
 * `SPACING_Z_BASE` — the identity fast path that makes toggling off (or zooming back down) an
 * exact revert rather than an animated one, because there is nothing left to un-apply.
 */
export function applySpacing(
  model: CanvasModel,
  z: number,
  enabled: boolean,
  budget?: SpacingBudget,
): SpacingResult {
  const nodeRects: Record<string, Rect> = {};
  const groupRects: Record<string, Rect> = {};
  for (const n of model.nodes) nodeRects[n.terminalId] = n.rect;
  for (const g of model.groups) groupRects[g.tabId] = g.rect;

  const k = enabled ? spacingFactor(z) : 1;
  if (k >= 1) return { nodeRects, groupRects };
  const pWant = 1 - k;
  const b = budget ?? computeSpacingBudget(model);

  // Step 1 — groups toward the canvas centroid, TRANSLATING every member node by the same
  // delta as its frame. A group frame's own centre is not its members' centre (`fitGroupFrame`
  // pads the top and bottom differently, for the label — see `canvasLayout.ts`), so pulling a
  // node toward its FRAME's centre would drift it even in a single-node group, forever, above
  // zoom 1. Translating instead keeps every node rigidly attached to its moving frame, exactly
  // like a manual group drag (`moveGroupBy`) already does — spacing only ever adds a second,
  // independent tightening on top (step 2), never a second way to reposition inside a group.
  if (model.groups.length > 0) {
    const canvasCentre = centroidOf(model.groups.map((g) => g.rect));
    const p = Math.min(pWant, b.groupPull);
    for (const g of model.groups) {
      const moved = pulledRect(g.rect, canvasCentre, p);
      groupRects[g.tabId] = moved;
      const before = centerOf(g.rect);
      const after = centerOf(moved);
      const dx = after.x - before.x;
      const dy = after.y - before.y;
      if (dx === 0 && dy === 0) continue;
      for (const id of g.nodeIds) {
        const r = nodeRects[id];
        if (r) nodeRects[id] = { ...r, x: r.x + dx, y: r.y + dy };
      }
    }
  }

  // Step 2 — each group's own nodes tighten toward THEIR OWN shared centroid (not the frame's),
  // on top of whatever step 1 already moved them by. `b.nodePullByGroup` was computed against
  // the ORIGINAL (untranslated) members, which is safe: step 1 moves every member of one group
  // by the same rigid delta, and a uniform translation changes no pairwise distance — the exact
  // property `maxSafePull`'s own note relies on to be target-independent in the first place.
  //
  // `g.nodeIds` is membership, not visibility — a member the user has individually hidden still
  // counts toward its siblings' centroid. Deliberate: whether that member is even in `model` at
  // all is `CanvasMode`'s call (this module never reads `hidden`/`revealHidden`), and a member
  // that is merely paint-culled or invisible right now can become visible again without this
  // recomputing anything — it would be strange for the same input to answer differently.
  for (const g of model.groups) {
    const members = model.nodes.filter((n) => g.nodeIds.includes(n.terminalId));
    if (members.length <= 1) continue;
    const translated = members.map((n) => nodeRects[n.terminalId]);
    const siblingCentre = centroidOf(translated);
    const p = Math.min(pWant, b.nodePullByGroup[g.tabId] ?? 1);
    members.forEach((n, i) => {
      nodeRects[n.terminalId] = pulledRect(translated[i], siblingCentre, p);
    });
  }

  return { nodeRects, groupRects };
}
