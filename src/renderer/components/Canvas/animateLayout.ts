import { Rect } from './canvasGeometry';
import { arrange, ArrangeResult } from './canvasLayout';
import type { CanvasModel } from './canvasSelectors';

/**
 * Arrange's pure half — `plan/013` Task 13, design 010 §6.4 / D10.
 *
 * The layout itself is `arrange` in `canvasLayout`; this is only what is needed to get there
 * over time rather than instantly. Separated from `useArrange` for the same reason
 * `canvasMutations` is separated from `useCanvasDrag`: the decisions are testable, the
 * requestAnimationFrame wiring is not.
 */

/** Long enough to follow, short enough not to feel slow. */
export const ARRANGE_MS = 430;

export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * `(1 - e) * a + e * b`, deliberately NOT the usual `a + (b - a) * e`.
 *
 * The two agree mathematically and differ in floating point exactly where it matters here. The
 * usual form is inexact at the endpoints for values that are not representable in binary — with
 * a = 0.1 and b = 0.3 it settles on 0.29999999999999993 — so the final resting place of a layout
 * would depend on where it started from. Arrange exists to put everything on a grid, so this
 * form, which returns `a` at e = 0 and `b` at e = 1 by construction, is the right trade.
 */
const lerp = (a: number, b: number, e: number) => (1 - e) * a + e * b;

/**
 * Blend two layouts. `e` is the EASED progress, already in [0, 1] — no clamping here, because
 * the only caller clamps and `easeOutCubic` cannot leave the range.
 *
 * `to` is the authority on what exists: an id present only in `from` is dropped rather than
 * carried, since `applyArrange` merges into the slice and would write a stale entry straight
 * back. An id present only in `to` snaps to its target instead of animating from a guess.
 */
export function interpolateArrange(from: ArrangeResult, to: ArrangeResult, e: number): ArrangeResult {
  const groups: ArrangeResult['groups'] = {};
  for (const [id, t] of Object.entries(to.groups)) {
    const f = from.groups[id];
    groups[id] = f
      ? { x: lerp(f.x, t.x, e), y: lerp(f.y, t.y, e), w: lerp(f.w, t.w, e), h: lerp(f.h, t.h, e) }
      // Copied, never handed back by reference: this is dispatched ~26 times per Arrange and
      // RTK freezes payloads it has seen, which would freeze `to` part-way through its own
      // animation.
      : { ...t };
  }
  const nodes: ArrangeResult['nodes'] = {};
  for (const [id, t] of Object.entries(to.nodes)) {
    const f = from.nodes[id];
    nodes[id] = f ? { x: lerp(f.x, t.x, e), y: lerp(f.y, t.y, e) } : { ...t };
  }
  return { groups, nodes };
}

/**
 * The layout as it is on screen right now, in `ArrangeResult` shape so it can be blended.
 *
 * Read from the MODEL, never from `canvasSlice`. `buildModel` derives a non-empty group's frame
 * by shrink-wrapping its terminals and seeds a position for any node that has never been placed,
 * so the slice is missing entries for exactly the things a first Arrange is most likely to move —
 * and a missing `from` entry snaps instead of sliding.
 */
export function currentLayout(model: CanvasModel): ArrangeResult {
  const groups: Record<string, Rect> = {};
  for (const g of model.groups) groups[g.tabId] = { ...g.rect };
  const nodes: Record<string, { x: number; y: number }> = {};
  for (const n of model.nodes) nodes[n.terminalId] = { x: n.rect.x, y: n.rect.y };
  return { groups, nodes };
}

/**
 * Where Arrange is taking everything.
 *
 * Deterministic in the group MEMBERSHIP alone — no current position feeds in — which is what
 * makes a second press mid-flight safe: it re-aims at the identical target from wherever the
 * first press had got to, so the two cannot chase each other.
 */
export function arrangeTarget(model: CanvasModel): ArrangeResult {
  return arrange({ groups: model.groups.map((g) => ({ id: g.tabId, nodeIds: g.nodeIds })) });
}
