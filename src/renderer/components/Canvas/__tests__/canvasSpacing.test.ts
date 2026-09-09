import { NODE_H, NODE_W, Rect } from '../canvasGeometry';
import { GAP_X, GROUP_GAP, PAD, PAD_TOP } from '../canvasLayout';
import { CanvasGroupModel, CanvasModel, CanvasNodeModel } from '../canvasSelectors';
import { applySpacing, MIN_GAP, spacingFactor, SPACING_Z_BASE } from '../canvasSpacing';

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
 *  if they overlap. */
const gapBetween = (a: Rect, b: Rect) => Math.max(
  a.x + a.w <= b.x ? b.x - (a.x + a.w) : b.x + b.w <= a.x ? a.x - (b.x + b.w) : -Infinity,
  a.y + a.h <= b.y ? b.y - (a.y + a.h) : b.y + b.h <= a.y ? a.y - (b.y + b.h) : -Infinity,
);

/** A single-node group frame, sized and padded exactly like `arrange()`/`fitGroupFrame` would —
 *  the real proportions (a frame far wider than the gap between two of them) are the whole point
 *  of these tests: an earlier version of Dynamic Spacing only worked on artificially wide gaps. */
const FRAME_W = PAD * 2 + NODE_W;
const FRAME_H = PAD_TOP + PAD + NODE_H;
const singleNodeGroup = (tabId: string, frameX: number, frameY: number): { group: CanvasGroupModel; node: CanvasNodeModel } => {
  const nodeId = `${tabId}-n`;
  const rect = { x: frameX, y: frameY, w: FRAME_W, h: FRAME_H };
  return {
    group: group(tabId, rect, [nodeId]),
    node: node(nodeId, tabId, { x: frameX + PAD, y: frameY + PAD_TOP, w: NODE_W, h: NODE_H }),
  };
};

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

  /** Two adjacent single-node groups laid out exactly like `arrange()`'s row cursor — this is
   *  the layout that exposed the old scale-toward-centroid bug: a ~372-wide frame only
   *  `GROUP_GAP` (28) away from its neighbour. */
  const adjacentGroupsModel = (): CanvasModel => {
    const a = singleNodeGroup('tb-a', 0, 0);
    const b = singleNodeGroup('tb-b', FRAME_W + GROUP_GAP, 0);
    return { nodes: [a.node, b.node], groups: [a.group, b.group] };
  };

  /** Two nodes in one row of one group, `GAP_X` (10) apart, `NODE_W` (340) wide — the same
   *  size-dominates-the-gap shape as the group case, one level down. */
  const adjacentNodesModel = (): CanvasModel => {
    const n1 = node('n1', 'tb-a', { x: PAD, y: PAD_TOP, w: NODE_W, h: NODE_H });
    const n2 = node('n2', 'tb-a', { x: PAD + NODE_W + GAP_X, y: PAD_TOP, w: NODE_W, h: NODE_H });
    const frameW = PAD * 2 + 2 * NODE_W + GAP_X;
    return { nodes: [n1, n2], groups: [group('tb-a', { x: 0, y: 0, w: frameW, h: FRAME_H }, ['n1', 'n2'])] };
  };

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
    expect(gapBetween(model.nodes[0].rect, model.nodes[1].rect)).toBe(0);
    const out = applySpacing(model, 6, true);
    expect(out.nodeRects['n1']).toEqual(model.nodes[0].rect);
    expect(out.nodeRects['n2']).toEqual(model.nodes[1].rect);
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

  it('leaves two purely diagonal groups untouched — neither shares a lane with the other', () => {
    // Different row AND different column: already fully clear on both axes, so there is no
    // gap for either sweep to touch.
    const model: CanvasModel = {
      nodes: [node('n1', 'tb-a', { x: 0, y: 0, w: 340, h: 210 }), node('n2', 'tb-b', { x: 1000, y: 1000, w: 340, h: 210 })],
      groups: [
        group('tb-a', { x: 0, y: 0, w: 340, h: 210 }, ['n1']),
        group('tb-b', { x: 1000, y: 1000, w: 340, h: 210 }, ['n2']),
      ],
    };
    const out = applySpacing(model, 20, true);
    expect(out.groupRects['tb-a']).toEqual(model.groups[0].rect);
    expect(out.groupRects['tb-b']).toEqual(model.groups[1].rect);
  });

  describe('realistic layout (the shape that exposed the scale-toward-centroid bug)', () => {
    it('tightens adjacent group frames well past the ~5% a scale-toward-centroid pull could manage', () => {
      const model = adjacentGroupsModel();
      const beforeGap = GROUP_GAP;
      const out = applySpacing(model, 4, true);
      const afterGap = gapBetween(out.groupRects['tb-a'], out.groupRects['tb-b']);
      // A scale-toward-centroid pull on this exact shape (372-wide frame, 28-wide gap) could
      // only ever close ~5% of the gap before a frame violated MIN_GAP — i.e. afterGap would
      // stay above ~26.5. The gap-shrink sweep has no such floor.
      expect(afterGap).toBeLessThan(beforeGap * 0.5);
      expect(noOverlap([out.groupRects['tb-a'], out.groupRects['tb-b']])).toBe(true);
    });

    it('tightens adjacent group frames all the way to MIN_GAP at high zoom', () => {
      const model = adjacentGroupsModel();
      const out = applySpacing(model, 50, true);
      const afterGap = gapBetween(out.groupRects['tb-a'], out.groupRects['tb-b']);
      expect(afterGap).toBeGreaterThanOrEqual(MIN_GAP - 1e-6);
      expect(afterGap).toBeLessThan(MIN_GAP + 2);
    });

    it('translates each frame\'s only node rigidly along with it', () => {
      const model = adjacentGroupsModel();
      const out = applySpacing(model, 8, true);
      const frameA = out.groupRects['tb-a'];
      const nodeA = out.nodeRects['tb-a-n'];
      expect(nodeA.x - frameA.x).toBe(PAD);
      expect(nodeA.y - frameA.y).toBe(PAD_TOP);
    });

    it('tightens two adjacent nodes in one row well past the ~1% a scale-toward-centroid pull could manage', () => {
      const model = adjacentNodesModel();
      const out = applySpacing(model, 4, true);
      const afterGap = gapBetween(out.nodeRects['n1'], out.nodeRects['n2']);
      // A scale-toward-centroid pull on this exact shape (340-wide node, 10-wide gap) could
      // only ever close ~1% of the gap before a node violated MIN_GAP — i.e. afterGap would
      // stay above ~9.9. The gap-shrink sweep reaches the MIN_GAP floor itself instead.
      expect(afterGap).toBeLessThan(GAP_X - 1);
      expect(noOverlap([out.nodeRects['n1'], out.nodeRects['n2']])).toBe(true);
    });

    it('tightens two adjacent nodes in one row all the way to MIN_GAP at high zoom', () => {
      const model = adjacentNodesModel();
      const out = applySpacing(model, 50, true);
      const afterGap = gapBetween(out.nodeRects['n1'], out.nodeRects['n2']);
      expect(afterGap).toBeGreaterThanOrEqual(MIN_GAP - 1e-6);
      expect(afterGap).toBeLessThan(MIN_GAP + 2);
    });

    it('keeps tightening monotonically through a realistic zoom sweep, never below MIN_GAP', () => {
      const groupModel = adjacentGroupsModel();
      const nodeModel = adjacentNodesModel();
      let lastGroupGap = Infinity;
      let lastNodeGap = Infinity;
      for (let z = 1; z <= 40; z += 1) {
        const groupOut = applySpacing(groupModel, z, true);
        const nodeOut = applySpacing(nodeModel, z, true);
        const groupGap = gapBetween(groupOut.groupRects['tb-a'], groupOut.groupRects['tb-b']);
        const nodeGap = gapBetween(nodeOut.nodeRects['n1'], nodeOut.nodeRects['n2']);
        expect(groupGap).toBeGreaterThanOrEqual(MIN_GAP - 1e-9);
        expect(nodeGap).toBeGreaterThanOrEqual(MIN_GAP - 1e-9);
        expect(groupGap).toBeLessThanOrEqual(lastGroupGap + 1e-9);
        expect(nodeGap).toBeLessThanOrEqual(lastNodeGap + 1e-9);
        lastGroupGap = groupGap;
        lastNodeGap = nodeGap;
      }
    });

    it('never overlaps a realistic multi-group row across a zoom sweep', () => {
      const groups = ['tb-a', 'tb-b', 'tb-c', 'tb-d'].map((id, i) => singleNodeGroup(id, i * (FRAME_W + GROUP_GAP), 0));
      const model: CanvasModel = { nodes: groups.map((g) => g.node), groups: groups.map((g) => g.group) };
      for (let z = 1; z <= 30; z += 2) {
        const out = applySpacing(model, z, true);
        const rects = groups.map((g) => out.groupRects[g.group.tabId]);
        expect(noOverlap(rects)).toBe(true);
      }
    });
  });
});
