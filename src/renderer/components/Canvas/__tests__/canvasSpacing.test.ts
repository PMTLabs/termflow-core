import { NODE_H, NODE_W, paintedNodeRect, Rect } from '../canvasGeometry';
import { drawnFrameRect, GAP_X, GROUP_GAP, PAD, PAD_SCREEN_MAX, PAD_TOP } from '../canvasLayout';
import { CanvasGroupModel, CanvasModel, CanvasNodeModel } from '../canvasSelectors';
import { applySpacing, MIN_GAP_SCREEN_PX, spacingFactor, SPACING_Z_BASE } from '../canvasSpacing';

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

  describe('realistic layout, measured as DRAWN (the shape three earlier attempts got wrong)', () => {
    /** What the eye actually sees between two group frames: the gap between the boxes
     *  `CanvasGroupFrame` paints (`drawnFrameRect`), in SCREEN pixels. Not the layout rect —
     *  above z≈1.5 the drawn border is inset from it by a margin that GROWS with zoom, which is
     *  why tightening layout rects looked correct in tests and did nothing on screen. */
    const drawnFrameGapPx = (out: ReturnType<typeof applySpacing>, a: string, b: string, z: number) =>
      gapBetween(drawnFrameRect(out.groupRects[a], z), drawnFrameRect(out.groupRects[b], z)) * z;

    /** The whitespace between two terminals in adjacent groups, in SCREEN pixels — the thing
     *  Tam is pointing at in the screenshot. */
    const terminalGapPx = (out: ReturnType<typeof applySpacing>, a: string, b: string, z: number) =>
      gapBetween(out.nodeRects[a], out.nodeRects[b]) * z;

    it('brings the DRAWN borders of adjacent frames closer on screen the further you zoom in', () => {
      const model = adjacentGroupsModel();
      // The bug this pins, measured before the fix: drawn gap went 28px (z=1) -> 33px (z=2) ->
      // 61px (z=3). Zooming in pushed the frames APART on screen, the exact opposite of the
      // feature's purpose, because only the invisible layout rect was being tightened.
      const at2 = drawnFrameGapPx(applySpacing(model, 2, true), 'tb-a', 'tb-b', 2);
      const at3 = drawnFrameGapPx(applySpacing(model, 3, true), 'tb-a', 'tb-b', 3);
      const at5 = drawnFrameGapPx(applySpacing(model, 5, true), 'tb-a', 'tb-b', 5);
      expect(at3).toBeLessThan(at2);
      expect(at5).toBeLessThan(at3);
      expect(at5).toBeGreaterThanOrEqual(MIN_GAP_SCREEN_PX - 1e-9);
    });

    it('never pushes two terminals further apart on screen as you zoom in, once the pad clamp is engaged', () => {
      // THE regression test for this whole class: before the fix this ran 81px (z=2) -> 109px
      // (z=3), i.e. zooming in pushed the terminals apart. It must never do that again.
      //
      // Measured from z=2, where `framePadScale`'s clamp is fully engaged. Between z=1.5 and
      // z=1.75 there is a real 0.5px bump, and it is not this feature's to remove: the terminal
      // sits `PAD` inside its own frame, so `2 x PAD x z` of the whitespace is layout padding
      // that grows on screen until the clamp catches up. Spacing owns the gap BETWEEN frames,
      // not the padding inside one. The second assertion bounds that bump rather than hiding it.
      const model = adjacentGroupsModel();
      const at15 = terminalGapPx(applySpacing(model, 1.5, true), 'tb-a-n', 'tb-b-n', 1.5);
      let last = Infinity;
      for (let z = 2; z <= 6.35; z += 0.25) {
        const gap = terminalGapPx(applySpacing(model, z, true), 'tb-a-n', 'tb-b-n', z);
        expect(gap).toBeLessThanOrEqual(last + 1e-9);
        expect(gap).toBeGreaterThan(0);
        expect(gap).toBeLessThan(at15 + 1);
        last = gap;
      }
    });

    it('leaves terminals in adjacent groups far closer than with spacing off, at every real zoom', () => {
      const model = adjacentGroupsModel();
      for (const z of [2, 3, 4, 5, 6.35]) {
        const on = terminalGapPx(applySpacing(model, z, true), 'tb-a-n', 'tb-b-n', z);
        const off = terminalGapPx(applySpacing(model, z, false), 'tb-a-n', 'tb-b-n', z);
        expect(on).toBeLessThan(off);
        // The remaining whitespace is two clamped frame paddings plus a small gap, and it must
        // not scale with zoom the way the untouched layout does.
        expect(on).toBeLessThan(2 * PAD_SCREEN_MAX + MIN_GAP_SCREEN_PX + 25);
      }
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
      // only ever close ~1% of the gap before two nodes got too close — i.e. afterGap would
      // stay above ~9.9. The gap-shrink sweep gets much closer to MIN_GAP_SCREEN_PX instead.
      expect(afterGap).toBeLessThan(GAP_X - 1);
      expect(noOverlap([out.nodeRects['n1'], out.nodeRects['n2']])).toBe(true);
    });

    it('tightens two adjacent nodes in one row to a small, non-growing SCREEN gap', () => {
      const model = adjacentNodesModel();
      let last = Infinity;
      for (let z = 1.5; z <= 6.35; z += 0.25) {
        const out = applySpacing(model, z, true);
        const screenGap = gapBetween(out.nodeRects['n1'], out.nodeRects['n2']) * z;
        expect(screenGap).toBeGreaterThanOrEqual(MIN_GAP_SCREEN_PX - 1e-9);
        expect(screenGap).toBeLessThanOrEqual(last + 1e-9);
        last = screenGap;
      }
    });

    it('never lets what is DRAWN overlap across a realistic multi-group row and zoom sweep', () => {
      // Checked on the painted boxes, not the layout rects: above z≈1.5 a tightened layout rect
      // legitimately overlaps its neighbour, because each frame is DRAWN well inside it. What
      // must never collide is what the user sees — the frames and the terminals.
      const groups = ['tb-a', 'tb-b', 'tb-c', 'tb-d'].map((id, i) => singleNodeGroup(id, i * (FRAME_W + GROUP_GAP), 0));
      const model: CanvasModel = { nodes: groups.map((g) => g.node), groups: groups.map((g) => g.group) };
      for (let z = 1; z <= 6.35; z += 0.25) {
        const out = applySpacing(model, z, true);
        const frames = groups.map((g) => drawnFrameRect(out.groupRects[g.group.tabId], z));
        const nodes = groups.map((g) => paintedNodeRect(out.nodeRects[g.node.terminalId], z, false));
        expect(noOverlap(frames)).toBe(true);
        expect(noOverlap(nodes)).toBe(true);
      }
    });
  });
});
