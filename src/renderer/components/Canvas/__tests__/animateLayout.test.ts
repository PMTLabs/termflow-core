import {
  easeOutCubic, interpolateArrange, currentLayout, arrangeTarget, ARRANGE_MS,
} from '../animateLayout';
import { ArrangeResult, arrange, fitGroupFrame } from '../canvasLayout';
import { NODE_W, NODE_H, Rect } from '../canvasGeometry';
import type { CanvasModel, CanvasNodeModel, CanvasGroupModel } from '../canvasSelectors';

const from: ArrangeResult = {
  groups: { 'tb-a': { x: 0, y: 0, w: 100, h: 100 } },
  nodes: { n1: { x: 0, y: 0 } },
};
const to: ArrangeResult = {
  groups: { 'tb-a': { x: 100, y: 200, w: 300, h: 400 } },
  nodes: { n1: { x: 50, y: 60 } },
};

describe('easeOutCubic', () => {
  it('is pinned at both ends', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
  });

  it('decelerates — past halfway by the midpoint', () => {
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });

  it('is monotonic and never leaves [0, 1]', () => {
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const v = easeOutCubic(i / 100);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      prev = v;
    }
  });
});

describe('interpolateArrange', () => {
  it('returns the start state at e=0', () => {
    expect(interpolateArrange(from, to, 0)).toEqual(from);
  });

  it('returns the end state at e=1', () => {
    expect(interpolateArrange(from, to, 1)).toEqual(to);
  });

  /**
   * The endpoint has to be EXACT, not merely close, and which lerp form is used decides it.
   *
   * `a + (b - a) * e` is the form everyone writes, and for some operands it is an ULP short of
   * `b` at e = 1. Arrange's whole point is that everything lands on a grid, so a final position
   * that depends on where it started from is the one thing it must not produce.
   * `(1 - e) * a + e * b` returns `b` by construction.
   *
   * The operands are `1/7` and `5/7` rather than anything rounder because most pairs — 0.1 and
   * 0.3 among them — happen to come out exact under both forms, and against those this test
   * would pass either way. The first assertion guards the guard: it fails if the constants are
   * ever changed to such a pair.
   */
  it('lands exactly on the target, not an ULP away from it', () => {
    const A = 1 / 7;
    const B = 5 / 7;
    expect(A + (B - A) * 1).not.toBe(B);

    const f: ArrangeResult = { groups: { g: { x: A, y: A, w: A, h: A } }, nodes: { n: { x: A, y: A } } };
    const t: ArrangeResult = { groups: { g: { x: B, y: B, w: B, h: B } }, nodes: { n: { x: B, y: B } } };
    const end = interpolateArrange(f, t, 1);
    expect(end.groups.g.x).toBe(B);
    expect(end.groups.g.w).toBe(B);
    expect(end.nodes.n.y).toBe(B);
  });

  // The other end. Both forms are exact here — `a + 0` and `1 * a + 0` alike — so this pins the
  // property rather than discriminating between implementations.
  it('starts exactly on the start state', () => {
    const A = 1 / 7;
    const B = 5 / 7;
    const f: ArrangeResult = { groups: {}, nodes: { n: { x: A, y: A } } };
    const t: ArrangeResult = { groups: {}, nodes: { n: { x: B, y: B } } };
    expect(interpolateArrange(f, t, 0).nodes.n.x).toBe(A);
  });

  it('interpolates position AND size at the midpoint', () => {
    const mid = interpolateArrange(from, to, 0.5);
    expect(mid.groups['tb-a']).toEqual({ x: 50, y: 100, w: 200, h: 250 });
    expect(mid.nodes.n1).toEqual({ x: 25, y: 30 });
  });

  it('passes through entries missing from the start state', () => {
    const partial: ArrangeResult = { groups: {}, nodes: {} };
    const mid = interpolateArrange(partial, to, 0.5);
    expect(mid.groups['tb-a']).toEqual(to.groups['tb-a']);
    expect(mid.nodes.n1).toEqual(to.nodes.n1);
  });

  // `to` is the authority on WHAT exists; `from` only says where it was. An id that has since
  // gone away must not be resurrected into the payload — `applyArrange` merges rather than
  // replaces, so a stale entry would be written straight back into the slice.
  it('carries exactly the ids the target has, no more and no fewer', () => {
    const f: ArrangeResult = {
      groups: { 'tb-a': { x: 0, y: 0, w: 1, h: 1 }, 'tb-gone': { x: 9, y: 9, w: 1, h: 1 } },
      nodes: { n1: { x: 0, y: 0 }, 'n-gone': { x: 9, y: 9 } },
    };
    const mid = interpolateArrange(f, to, 0.5);
    expect(Object.keys(mid.groups)).toEqual(Object.keys(to.groups));
    expect(Object.keys(mid.nodes)).toEqual(Object.keys(to.nodes));
  });

  // Dispatched ~26 times per Arrange, and RTK freezes an action payload it has seen. Handing
  // back an object owned by `to` would freeze `to` itself part-way through its own animation.
  it('does not alias or mutate either input', () => {
    const f = JSON.parse(JSON.stringify(from)) as ArrangeResult;
    const t = JSON.parse(JSON.stringify(to)) as ArrangeResult;
    const before = JSON.stringify({ f, t });
    const mid = interpolateArrange(f, t, 0.5);
    const end = interpolateArrange(f, t, 1);
    expect(JSON.stringify({ f, t })).toBe(before);
    expect(mid.groups['tb-a']).not.toBe(t.groups['tb-a']);
    expect(end.nodes.n1).not.toBe(t.nodes.n1);

    const passthrough = interpolateArrange({ groups: {}, nodes: {} }, t, 0.5);
    expect(passthrough.groups['tb-a']).not.toBe(t.groups['tb-a']);
  });

  it('uses a sane duration', () => {
    expect(ARRANGE_MS).toBeGreaterThan(200);
    expect(ARRANGE_MS).toBeLessThan(800);
  });
});

const node = (terminalId: string, tabId: string, rect: Rect): CanvasNodeModel => ({
  terminalId, tabId, paneId: `pn-${terminalId}`, title: terminalId, shellType: 'zsh',
  rect, isRunning: false, hasUnseenOutput: false, groupTitle: 'Group',
});
const group = (tabId: string, rect: Rect, nodeIds: string[]): CanvasGroupModel =>
  ({ tabId, title: tabId, rect, nodeIds, anyRunning: false });

const model: CanvasModel = {
  nodes: [
    node('tm-1', 'tb-a', { x: 10, y: 20, w: NODE_W, h: NODE_H }),
    node('tm-2', 'tb-a', { x: 400, y: 20, w: NODE_W, h: NODE_H }),
    node('tm-3', 'tb-b', { x: 900, y: 700, w: NODE_W, h: NODE_H }),
  ],
  groups: [
    group('tb-a', { x: 0, y: 0, w: 800, h: 300 }, ['tm-1', 'tm-2']),
    group('tb-b', { x: 880, y: 680, w: 400, h: 300 }, ['tm-3']),
    // An emptied group keeps its frame as a drop target (design 010 §6.3) — and it is the ONE
    // kind of group whose stored rect is what gets drawn, so Arrange has to place it.
    group('tb-empty', { x: 2000, y: 2000, w: 400, h: 300 }, []),
  ],
};

describe('currentLayout', () => {
  it('reads every group frame and every node position off the model', () => {
    const l = currentLayout(model);
    expect(l.groups['tb-a']).toEqual({ x: 0, y: 0, w: 800, h: 300 });
    expect(l.groups['tb-empty']).toEqual({ x: 2000, y: 2000, w: 400, h: 300 });
    expect(l.nodes['tm-3']).toEqual({ x: 900, y: 700 });
    expect(Object.keys(l.nodes)).toHaveLength(3);
  });

  /**
   * Read from the MODEL rather than from `canvasSlice`, and that is not interchangeable.
   *
   * `buildCanvasModel` DERIVES a non-empty group's frame by shrink-wrapping its terminals and
   * SEEDS a position for any node that has never been placed — so the slice is missing entries
   * for exactly the things a first Arrange is most likely to move. Animating those from a
   * default would make them jump before they slide.
   */
  it('is complete for a model whose geometry has never been stored', () => {
    const l = currentLayout(model);
    for (const g of model.groups) expect(l.groups[g.tabId]).toBeDefined();
    for (const n of model.nodes) expect(l.nodes[n.terminalId]).toBeDefined();
  });

  it('does not alias the model rects', () => {
    const l = currentLayout(model);
    expect(l.groups['tb-a']).not.toBe(model.groups[0].rect);
  });
});

describe('arrangeTarget', () => {
  it('covers every group and every node', () => {
    const t = arrangeTarget(model);
    expect(Object.keys(t.groups).sort()).toEqual(['tb-a', 'tb-b', 'tb-empty']);
    expect(Object.keys(t.nodes).sort()).toEqual(['tm-1', 'tm-2', 'tm-3']);
  });

  it('actually moves things — it is not the identity on a scattered layout', () => {
    const t = arrangeTarget(model);
    expect(t.nodes['tm-3']).not.toEqual({ x: 900, y: 700 });
  });

  /**
   * Deterministic in the group MEMBERSHIP alone — no current position feeds in.
   *
   * That is what makes pressing Arrange twice mid-flight safe: the second press re-aims at the
   * identical target from wherever the first had got to, so the two cannot fight. If this ever
   * became position-dependent, a double press would chase a moving target.
   */
  it('ignores where everything currently is', () => {
    const scattered: CanvasModel = {
      groups: model.groups,
      nodes: model.nodes.map((n) => ({ ...n, rect: { ...n.rect, x: n.rect.x + 5000, y: -n.rect.y } })),
    };
    expect(arrangeTarget(scattered)).toEqual(arrangeTarget(model));
  });
});

/**
 * **The precondition Arrange rests on**, asserted here rather than assumed.
 *
 * `buildModel` draws a non-empty group's frame as `fitGroupFrame` of its nodes and ignores the
 * stored rect entirely (see its comment). So `applyArrange` writing `arrange`'s group rects is
 * only meaningful if those rects ARE that shrink-wrap. If the two ever drift, Arrange would
 * appear to work — the nodes would grid correctly — while every frame settled somewhere the
 * next render silently overrode, and nothing in either module's own tests would notice.
 *
 * Checked across counts that exercise partial last rows, since that is where a naive
 * `c * NODE_W` width would part company with the real bounds.
 */
describe('arrange agrees with fitGroupFrame, which is what actually draws the frame', () => {
  for (const n of [1, 2, 3, 4, 5, 6, 7, 9, 10, 17]) {
    it(`for a group of ${n}`, () => {
      const ids = Array.from({ length: n }, (_, i) => `tm-${i}`);
      const out = arrange({ groups: [{ id: 'tb-a', nodeIds: ids }] });
      const rects: Rect[] = ids.map((id) => ({ ...out.nodes[id], w: NODE_W, h: NODE_H }));
      expect(fitGroupFrame(rects)).toEqual(out.groups['tb-a']);
    });
  }

  // Multiple groups, so the per-cell centring offset is in play as well as the sizing.
  it('for several groups laid out in the frame grid', () => {
    const input = {
      groups: [
        { id: 'g1', nodeIds: ['a1'] },
        { id: 'g2', nodeIds: ['b1', 'b2', 'b3', 'b4', 'b5'] },
        { id: 'g3', nodeIds: ['c1', 'c2'] },
      ],
    };
    const out = arrange(input);
    for (const g of input.groups) {
      const rects: Rect[] = g.nodeIds.map((id) => ({ ...out.nodes[id], w: NODE_W, h: NODE_H }));
      expect(fitGroupFrame(rects)).toEqual(out.groups[g.id]);
    }
  });
});
