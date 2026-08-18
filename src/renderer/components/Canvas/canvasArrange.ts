import { NODE_W, NODE_H, Rect } from './canvasGeometry';
import { arrange, ArrangeInput, ArrangeResult } from './canvasLayout';
import { pickSides, portPoint } from './wireGeometry';

/**
 * Making Arrange a better GRAPH, not just a tidier grid (Tam's seventh round).
 *
 * Arrange fills its slots in the order the model happens to hold — left to right, then down —
 * and that order has nothing to do with which terminals are wired together. Two nodes that talk
 * to each other end up in opposite corners as readily as side by side, so the wires run right
 * across the workspace and over everything in between.
 *
 * **This module changes only the ASSIGNMENT, never the geometry.** `arrange` still decides every
 * position, spacing and frame size; all that happens here is choosing which node goes in which
 * slot, and which group goes in which cell. That is deliberate: the grid is what makes Arrange
 * predictable, and a layout that also moved things around would be a different feature. It also
 * means the score below is computed on the REAL output of `arrange` rather than on a model of
 * it — there is no second copy of the layout maths to drift.
 *
 * It is a heuristic and it says so. Minimising edge crossings is NP-hard even for a fixed grid,
 * so this is bounded hill-climbing from the order you already have: every move it accepts is a
 * strict improvement, which is what guarantees the result is never worse than doing nothing.
 */

export interface ArrangeEdge {
  from: string;
  to: string;
}

/**
 * How much worse a wire crossing a NODE is than two wires crossing each other.
 *
 * Not equal, because they are not equally bad to look at. Two wires crossing is what a graph
 * does; a wire drawn across a terminal hides the thing the terminal is for, and the wire itself
 * disappears into the content. Three, so that clearing one node is always worth accepting a
 * couple of extra wire crossings — the trade this exists to make.
 */
export const NODE_PENALTY = 3;

/**
 * Bounds on the search, and they are load-bearing rather than defensive.
 *
 * Arrange runs on a click and then animates for 260ms; anything that takes long enough to be
 * felt has already failed. Every accepted move strictly improves the score, so stopping early
 * costs quality and never correctness — which is exactly the right way round for a budget.
 */
export const MAX_PASSES = 4;
export const MAX_EVALS = 400;

export interface ArrangeScore {
  /** Wires drawn across a node that is not one of their own endpoints. */
  hits: number;
  /** Pairs of wires that cross. */
  crossings: number;
  /** Total wire length. A TIE-BREAK only — see `isBetter`. */
  length: number;
}

/* ---- Geometry ------------------------------------------------------------ */

/** Liang–Barsky: does the segment touch the box at all? */
function segmentHitsRect(x1: number, y1: number, x2: number, y2: number, r: Rect): boolean {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const p = [-dx, dx, -dy, dy];
  const q = [x1 - r.x, r.x + r.w - x1, y1 - r.y, r.y + r.h - y1];
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      // Parallel to this pair of edges: outside the slab means it can never enter.
      if (q[i] < 0) return false;
      continue;
    }
    const t = q[i] / p[i];
    if (p[i] < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
  }
  return true;
}

const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;

/**
 * Do the two segments properly cross?
 *
 * Strict sign tests, which is what makes two wires out of the SAME port free rather than needing
 * a guard: sharing an endpoint zeroes `d1` and `d3`, and the remaining pair `d2`/`d4` are
 * `cross(d, b)` and `cross(b, d)` — exact negations, so they can never both be positive. A
 * shared-endpoint skip was written here first, and removed once that made it unreachable; it was
 * also subtly wrong, because two wires leaving one node from DIFFERENT sides and then crossing is
 * a crossing the eye sees, and the skip would have hidden it.
 */
function segmentsCross(
  a: readonly [number, number], b: readonly [number, number],
  c: readonly [number, number], d: readonly [number, number],
): boolean {
  const d1 = cross(d[0] - c[0], d[1] - c[1], a[0] - c[0], a[1] - c[1]);
  const d2 = cross(d[0] - c[0], d[1] - c[1], b[0] - c[0], b[1] - c[1]);
  const d3 = cross(b[0] - a[0], b[1] - a[1], c[0] - a[0], c[1] - a[1]);
  const d4 = cross(b[0] - a[0], b[1] - a[1], d[0] - a[0], d[1] - a[1]);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

/**
 * Where a wire between these two nodes actually starts and ends.
 *
 * Through `pickSides`/`portPoint`, which is what `CanvasWires` draws with — so this scores the
 * wire the user will see rather than a centre-to-centre line that would be short by half a node
 * at each end and would sometimes pick the wrong side of the box entirely. The rendered wire is
 * a curve between these points; its chord is a faithful enough proxy for counting crossings, and
 * it is the line the eye follows anyway.
 */
function wireEnds(a: Rect, b: Rect): [readonly [number, number], readonly [number, number]] {
  const [sa, sb] = pickSides(a, b);
  return [portPoint(a, sa), portPoint(b, sb)];
}

/* ---- Scoring ------------------------------------------------------------- */

/** Node rects from an arrange result. `arrange` returns positions; every node is NODE_W×NODE_H. */
export function arrangedRects(res: ArrangeResult): Record<string, Rect> {
  const out: Record<string, Rect> = {};
  for (const [id, p] of Object.entries(res.nodes)) {
    out[id] = { x: p.x, y: p.y, w: NODE_W, h: NODE_H };
  }
  return out;
}

export function scoreArrange(rects: Record<string, Rect>, edges: readonly ArrangeEdge[]): ArrangeScore {
  // Only edges whose BOTH ends were placed. A wire to a terminal that is not in this layout
  // (closed since, or in a group with no stored frame) has no geometry to score.
  const live = edges.filter((e) => rects[e.from] && rects[e.to] && e.from !== e.to);
  const segs = live.map((e) => ({ e, ends: wireEnds(rects[e.from], rects[e.to]) }));

  let hits = 0;
  let length = 0;
  for (const { e, ends } of segs) {
    const [p, q] = ends;
    length += Math.hypot(q[0] - p[0], q[1] - p[1]);
    for (const [id, r] of Object.entries(rects)) {
      // Its own endpoints always "hit" — the wire starts on their border.
      if (id === e.from || id === e.to) continue;
      if (segmentHitsRect(p[0], p[1], q[0], q[1], r)) hits++;
    }
  }

  let crossings = 0;
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      if (segmentsCross(segs[i].ends[0], segs[i].ends[1], segs[j].ends[0], segs[j].ends[1])) {
        crossings++;
      }
    }
  }

  return { hits, crossings, length };
}

/** The primary cost. Length is deliberately NOT in here — see `isBetter`. */
const cost = (s: ArrangeScore) => s.hits * NODE_PENALTY + s.crossings;

/**
 * Strictly better, lexicographically: fewer obstructions and crossings first, and only among
 * layouts that tie on those, shorter wires.
 *
 * Length is a tie-break rather than a weighted term because the two are not commensurable — any
 * weight small enough not to outvote a crossing is arbitrary, and any weight large enough to
 * matter would start trading a readable graph for a slightly shorter one. As a tie-break it
 * does the one useful job it has: choosing between arrangements the primary cost cannot separate,
 * which on a sparse workspace is most of them.
 */
export function isBetter(a: ArrangeScore, b: ArrangeScore): boolean {
  const ca = cost(a);
  const cb = cost(b);
  if (ca !== cb) return ca < cb;
  return a.length < b.length;
}

/* ---- The search ---------------------------------------------------------- */

/** A deep-enough copy that swapping in a candidate cannot touch the caller's arrays. */
const cloneInput = (input: ArrangeInput): ArrangeInput => ({
  groups: input.groups.map((g) => ({ id: g.id, nodeIds: [...g.nodeIds] })),
});

/**
 * Reorder groups and the terminals inside them so the wires cross less.
 *
 * Returns a NEW input for `arrange`; the caller's is untouched. With no edges — or none that
 * connect two placed terminals — the input is returned unchanged, so a workspace with no
 * connections arranges exactly as it always did.
 *
 * First-improvement hill climbing over two kinds of swap: two groups trade grid cells, or two
 * terminals inside one group trade slots. Every accepted swap strictly improves the score, so
 * the result can never be worse than the order it started from, and the passes converge because
 * the cost is a non-negative integer that strictly decreases.
 *
 * A swap is a candidate when AT LEAST ONE side of it is wired — not when both are, which is the
 * tempting filter and the wrong one. The single most useful move here is swapping a connected
 * terminal with an unconnected one that happens to be sitting between it and its neighbour;
 * requiring both ends to be wired excludes exactly that, and the obstruction it is supposed to
 * clear survives. Two unwired nodes trading places cannot change any score, so that pair is the
 * only one worth skipping.
 */
export function optimiseArrangeOrder(
  input: ArrangeInput,
  edges: readonly ArrangeEdge[],
): ArrangeInput {
  const wired = new Set<string>();
  for (const e of edges) {
    if (e.from === e.to) continue;      // a self-link draws nothing (design 010 §7.1)
    wired.add(e.from);
    wired.add(e.to);
  }
  // Covers the no-edges case too, so there is ONE way out rather than an `edges.length` fast
  // path that says the same thing and can only ever be tested by proving it redundant.
  if (!wired.size) return input;

  let best = cloneInput(input);
  let bestScore = scoreArrange(arrangedRects(arrange(best)), edges);
  let evals = 0;

  /** Try a swap; keep it only if it strictly improves. */
  const attempt = (mutate: (draft: ArrangeInput) => void): boolean => {
    if (evals >= MAX_EVALS) return false;
    evals++;
    const draft = cloneInput(best);
    mutate(draft);
    const score = scoreArrange(arrangedRects(arrange(draft)), edges);
    if (!isBetter(score, bestScore)) return false;
    best = draft;
    bestScore = score;
    return true;
  };

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let improved = false;

    // Groups first. A group carries all its terminals, so this is the move that can change the
    // most crossings at once — and doing it before the fine-grained one stops the node passes
    // optimising an arrangement that is about to move wholesale.
    const hasWire = best.groups.map((g) => g.nodeIds.some((id) => wired.has(id)));
    for (let i = 0; i < best.groups.length; i++) {
      for (let j = i + 1; j < best.groups.length; j++) {
        if (!hasWire[i] && !hasWire[j]) continue;
        if (attempt((d) => { [d.groups[i], d.groups[j]] = [d.groups[j], d.groups[i]]; })) {
          improved = true;
        }
      }
    }

    // Then slots within each group. Indices are read from `best` each time because a group swap
    // above may have moved the group this loop is about.
    for (let g = 0; g < best.groups.length; g++) {
      const ids = best.groups[g].nodeIds;
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          if (!wired.has(ids[i]) && !wired.has(ids[j])) continue;
          if (attempt((d) => {
            const n = d.groups[g].nodeIds;
            [n[i], n[j]] = [n[j], n[i]];
          })) {
            improved = true;
          }
        }
      }
    }

    if (!improved || evals >= MAX_EVALS) break;
  }

  return best;
}
