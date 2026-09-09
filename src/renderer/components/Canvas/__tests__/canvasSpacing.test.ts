import { Rect } from '../canvasGeometry';
import { CanvasGroupModel, CanvasModel, CanvasNodeModel } from '../canvasSelectors';
import {
  applySpacing, computeSpacingBudget, spacingFactor, MIN_GAP, SPACING_Z_BASE,
} from '../canvasSpacing';

const node = (id: string, tabId: string, rect: Rect): CanvasNodeModel => ({
  terminalId: id,
  tabId,
  paneId: id,
  title: id,
  groupTitle: tabId,
  shellType: 'pwsh',
  rect,
  isRunning: false,
  hasUnseenOutput: false,
  exited: false,
  hidden: false,
});

const group = (tabId: string, rect: Rect, nodeIds: string[]): CanvasGroupModel => ({
  tabId,
  title: tabId,
  rect,
  nodeIds,
  anyRunning: false,
  allHidden: false,
});

const noOverlap = (rects: Rect[]) => {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      const overlaps = !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
      if (overlaps) return false;
    }
  }
  return true;
};

/** The gap two AABBs actually leave along whichever axis separates them, or a negative number
 *  if they overlap. Mirrors the clearance `tooClose` in `canvasSpacing.ts` checks. */
const gapBetween = (a: Rect, b: Rect) => Math.max(
  a.x + a.w <= b.x ? b.x - (a.x + a.w) : b.x + b.w <= a.x ? a.x - (b.x + b.w) : -Infinity,
  a.y + a.h <= b.y ? b.y - (a.y + a.h) : b.y + b.h <= a.y ? a.y - (b.y + b.h) : -Infinity,
);

describe('spacingFactor', () => {
  it('is the identity at and below the base zoom', () => {
    expect(spacingFactor(SPACING_Z_BASE)).toBe(1);
    expect(spacingFactor(0.5)).toBe(1);
  });

  it('shrinks smoothly above the base zoom', () => {
    const a = spacingFactor(1.5);
    const b = spacingFactor(2);
    const c = spacingFactor(3);
    expect(a).toBeLessThan(1);
    expect(b).toBeLessThan(a);
    expect(c).toBeLessThan(b);
  });

  it('keeps shrinking toward zero at extreme zoom — no fixed floor of its own', () => {
    // A fixed fraction-of-original floor (there used to be one at 0.35) caps the pull at the
    // same 65% no matter how far past it you zoom, which is exactly why gaps between groups
    // stayed visibly large at high zoom (Tam, 2026-09-09). The only floor left is the geometric
    // minimum-gap clamp in `applySpacing`/`maxSafePull`, not this function.
    expect(spacingFactor(1000)).toBeGreaterThan(0);
    expect(spacingFactor(1000)).toBeLessThan(0.01);
    expect(spacingFactor(100)).toBeLessThan(spacingFactor(10));
  });

  it('is a no-op for a zoom that cannot happen', () => {
    for (const z of [0, -1, Number.NaN]) expect(spacingFactor(z)).toBe(1);
  });
});

describe('applySpacing', () => {
  const twoNodeModel = (): CanvasModel => ({
    nodes: [node('n1', 'tb-a', { x: 0, y: 0, w: 340, h: 210 }), node('n2', 'tb-a', { x: 1000, y: 0, w: 340, h: 210 })],
    groups: [group('tb-a', { x: -20, y: -30, w: 1360, h: 260 }, ['n1', 'n2'])],
  });

  const twoGroupModel = (): CanvasModel => ({
    nodes: [node('n1', 'tb-a', { x: 0, y: 0, w: 340, h: 210 }), node('n2', 'tb-b', { x: 2000, y: 0, w: 340, h: 210 })],
    groups: [
      group('tb-a', { x: -20, y: -30, w: 380, h: 260 }, ['n1']),
      group('tb-b', { x: 1980, y: -30, w: 380, h: 260 }, ['n2']),
    ],
  });

  it('leaves every rect exactly as stored when disabled', () => {
    const model = twoNodeModel();
    const out = applySpacing(model, 4, false);
    expect(out.nodeRects['n1']).toEqual(model.nodes[0].rect);
    expect(out.nodeRects['n2']).toEqual(model.nodes[1].rect);
    expect(out.groupRects['tb-a']).toEqual(model.groups[0].rect);
  });

  it('leaves every rect exactly as stored at or below the base zoom, even when enabled', () => {
    const model = twoNodeModel();
    const out = applySpacing(model, SPACING_Z_BASE, true);
    expect(out.nodeRects['n1']).toEqual(model.nodes[0].rect);
    expect(out.nodeRects['n2']).toEqual(model.nodes[1].rect);
  });

  it('is a no-op for a single node in a single group', () => {
    const model: CanvasModel = {
      nodes: [node('n1', 'tb-a', { x: 500, y: 500, w: 340, h: 210 })],
      groups: [group('tb-a', { x: 480, y: 470, w: 380, h: 260 }, ['n1'])],
    };
    const out = applySpacing(model, 5, true);
    expect(out.nodeRects['n1']).toEqual(model.nodes[0].rect);
    expect(out.groupRects['tb-a']).toEqual(model.groups[0].rect);
  });

  it('pulls two nodes in one group strictly closer together at high zoom, without overlap', () => {
    const model = twoNodeModel();
    const before = model.nodes.map((n) => n.rect);
    const beforeGap = before[1].x - (before[0].x + before[0].w);

    const out = applySpacing(model, 4, true);
    const after = [out.nodeRects['n1'], out.nodeRects['n2']];
    const afterGap = after[1].x - (after[0].x + after[0].w);

    expect(afterGap).toBeLessThan(beforeGap);
    expect(noOverlap(after)).toBe(true);
    // Size is untouched — only position may move.
    expect(after[0].w).toBe(before[0].w);
    expect(after[0].h).toBe(before[0].h);
  });

  it('pulls two groups closer together at high zoom, without overlap', () => {
    const model = twoGroupModel();
    const before = model.groups.map((g) => g.rect);
    const beforeGap = before[1].x - (before[0].x + before[0].w);

    const out = applySpacing(model, 4, true);
    const after = [out.groupRects['tb-a'], out.groupRects['tb-b']];
    const afterGap = after[1].x - (after[0].x + after[0].w);

    expect(afterGap).toBeLessThan(beforeGap);
    expect(noOverlap(after)).toBe(true);
  });

  it('leaves only MIN_GAP between well-separated nodes at extreme zoom', () => {
    const model = twoNodeModel();
    const out = applySpacing(model, 200, true);
    const gap = gapBetween(out.nodeRects['n1'], out.nodeRects['n2']);

    expect(gap).toBeGreaterThanOrEqual(MIN_GAP - 1e-6);
    expect(gap).toBeLessThan(MIN_GAP + 5);
  });

  it('preserves MIN_GAP while nodes and groups keep tightening through high zoom', () => {
    const nodeModel = twoNodeModel();
    const groupModel = twoGroupModel();
    let nodeGapAt2 = 0;
    let groupGapAt2 = 0;
    let nodeGapAt40 = 0;
    let groupGapAt40 = 0;

    for (let z = 1; z <= 40; z += 1) {
      const nodes = applySpacing(nodeModel, z, true).nodeRects;
      const groups = applySpacing(groupModel, z, true).groupRects;
      const nodeGap = gapBetween(nodes['n1'], nodes['n2']);
      const groupGap = gapBetween(groups['tb-a'], groups['tb-b']);
      expect(nodeGap).toBeGreaterThanOrEqual(MIN_GAP - 1e-9);
      expect(groupGap).toBeGreaterThanOrEqual(MIN_GAP - 1e-9);
      if (z === 2) {
        nodeGapAt2 = nodeGap;
        groupGapAt2 = groupGap;
      }
      if (z === 40) {
        nodeGapAt40 = nodeGap;
        groupGapAt40 = groupGap;
      }
    }

    expect(nodeGapAt40).toBeLessThan(nodeGapAt2);
    expect(groupGapAt40).toBeLessThan(groupGapAt2);
  });

  it('never introduces an overlap across a swept range of zoom', () => {
    const model = twoNodeModel();
    for (let z = 1; z <= 10; z += 0.5) {
      const out = applySpacing(model, z, true);
      expect(noOverlap([out.nodeRects['n1'], out.nodeRects['n2']])).toBe(true);
    }
  });

  it('never increases the gap as zoom increases (monotonic)', () => {
    const model = twoNodeModel();
    let lastGap = Infinity;
    for (let z = 1; z <= 8; z += 0.5) {
      const out = applySpacing(model, z, true);
      const gap = out.nodeRects['n2'].x - (out.nodeRects['n1'].x + out.nodeRects['n1'].w);
      expect(gap).toBeLessThanOrEqual(lastGap + 1e-9);
      lastGap = gap;
    }
  });

  it('does not move rects that are already touching — no room left to give', () => {
    const model: CanvasModel = {
      nodes: [node('n1', 'tb-a', { x: 0, y: 0, w: 340, h: 210 }), node('n2', 'tb-a', { x: 340, y: 0, w: 340, h: 210 })],
      groups: [group('tb-a', { x: -20, y: -30, w: 720, h: 260 }, ['n1', 'n2'])],
    };
    // A zero gap is already below MIN_GAP, so tooClose(..., MIN_GAP) gives this group no pull.
    expect(gapBetween(model.nodes[0].rect, model.nodes[1].rect)).toBe(0);
    const out = applySpacing(model, 6, true);
    expect(out.nodeRects['n1']).toEqual(model.nodes[0].rect);
    expect(out.nodeRects['n2']).toEqual(model.nodes[1].rect);
  });

  it('gives the same result whether the caller precomputes a budget or lets applySpacing compute one itself', () => {
    const model = twoNodeModel();
    const budget = computeSpacingBudget(model);
    for (const z of [1, 2, 4, 7]) {
      expect(applySpacing(model, z, true, budget)).toEqual(applySpacing(model, z, true));
    }
  });

  it('lets one budget be reused safely across every zoom — the whole point of splitting it out', () => {
    const model = twoNodeModel();
    const budget = computeSpacingBudget(model);
    let lastGap = Infinity;
    for (let z = 1; z <= 8; z += 0.5) {
      const out = applySpacing(model, z, true, budget);
      const gap = out.nodeRects['n2'].x - (out.nodeRects['n1'].x + out.nodeRects['n1'].w);
      expect(noOverlap([out.nodeRects['n1'], out.nodeRects['n2']])).toBe(true);
      expect(gap).toBeLessThanOrEqual(lastGap + 1e-9);
      lastGap = gap;
    }
  });

  it('budgets a group/single-member group at 1 — nothing to clamp, so nothing to search for', () => {
    const model: CanvasModel = {
      nodes: [node('n1', 'tb-a', { x: 500, y: 500, w: 340, h: 210 })],
      groups: [group('tb-a', { x: 480, y: 470, w: 380, h: 260 }, ['n1'])],
    };
    const budget = computeSpacingBudget(model);
    expect(budget.groupPull).toBe(1);
    expect(budget.nodePullByGroup['tb-a']).toBe(1);
  });

  it('does not resize a node or a group', () => {
    const model = twoNodeModel();
    const out = applySpacing(model, 5, true);
    for (const n of model.nodes) {
      expect(out.nodeRects[n.terminalId].w).toBe(n.rect.w);
      expect(out.nodeRects[n.terminalId].h).toBe(n.rect.h);
    }
    for (const g of model.groups) {
      expect(out.groupRects[g.tabId].w).toBe(g.rect.w);
      expect(out.groupRects[g.tabId].h).toBe(g.rect.h);
    }
  });
});
