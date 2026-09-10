import { NODE_H, NODE_W, paintedNodeRect, Rect, worldToScreen, Z_MIN, zoomAt } from '../canvasGeometry';
import { drawnFrameRect, fitGroupFrame, GAP_X, GROUP_GAP, PAD, PAD_SCREEN_MAX, PAD_TOP } from '../canvasLayout';
import { CanvasGroupModel, CanvasModel, CanvasNodeModel } from '../canvasSelectors';
import {
  anchoredCamera, applySpacing, MIN_GAP_SCREEN_PX, spacingAnchorAt, spacingFactor, spacingOffsets,
  SPACING_Z_BASE,
  zoomAnchoredAt,
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

const rectsOverlap = (a: Rect, b: Rect) =>
  !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);

/** Deterministic inline PRNG for the randomized spacing property. */
const mulberry32 = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  };
};

const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

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

    it('translates each frame\'s only node rigidly along with it, on BOTH axes, for a frame that actually moved', () => {
      // Identifying the frame by "it is a frame" is too few fields: the first frame in a row is
      // the anchor and never moves, so an oracle that happens to pick it passes even if members
      // are not translated at all. Pin a frame with a NON-ZERO delta, and pin dy as well as dx —
      // mutating `y: r.y + dy` to `y: r.y` otherwise survives the whole suite, because every
      // multi-group fixture here is a single horizontal row where dy is zero anyway.
      const model = gridModel();
      const z = 3;
      const out = applySpacing(model, z, true);
      for (const tabId of ['tb-b', 'tb-c', 'tb-d']) {
        const raw = model.groups.find((g) => g.tabId === tabId)!.rect;
        const moved = out.groupRects[tabId];
        const node = out.nodeRects[`${tabId}-n`];
        const dx = moved.x - raw.x;
        const dy = moved.y - raw.y;
        // tb-b moves only in x, tb-c only in y, tb-d in both — between them every axis is
        // covered by a frame that genuinely moved.
        expect(Math.abs(dx) + Math.abs(dy)).toBeGreaterThan(0);
        expect(node.x - moved.x).toBeCloseTo(PAD, 9);
        expect(node.y - moved.y).toBeCloseTo(PAD_TOP, 9);
      }
      expect(out.groupRects['tb-c'].y - model.groups[2].rect.y).toBeLessThan(0);
      expect(out.nodeRects['tb-c-n'].y - model.nodes[2].rect.y).toBeLessThan(0);
    });

    it('tightens a column of sibling nodes vertically, not only a row horizontally', () => {
      // Replacing `tighten(painted, ...)` with a bare x-only sweep survives every other fixture
      // here, because they are all horizontal rows.
      const above = node('n1', 'tb-a', { x: PAD, y: PAD_TOP, w: NODE_W, h: NODE_H });
      const below = node('n2', 'tb-a', { x: PAD, y: PAD_TOP + NODE_H + 400, w: NODE_W, h: NODE_H });
      const model: CanvasModel = {
        nodes: [above, below],
        groups: [group('tb-a', { x: 0, y: 0, w: PAD * 2 + NODE_W, h: PAD_TOP + PAD + NODE_H * 2 + 400 }, ['n1', 'n2'])],
      };
      const z = 3;
      const out = applySpacing(model, z, true);
      const before = below.rect.y - (above.rect.y + above.rect.h);
      const after = out.nodeRects['n2'].y - (out.nodeRects['n1'].y + out.nodeRects['n1'].h);
      expect(after).toBeLessThan(before / 2);
      expect(out.nodeRects['n1'].x).toBe(above.rect.x);
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

    /** Four tabs, laid out the way `arrange()` wraps them: a 2x2 grid of single-node groups.
     *  This is Tam's actual canvas in the 2026-09-09 screenshots. */
    const gridModel = (): CanvasModel => {
      const cells = [
        singleNodeGroup('tb-a', 0, 0),
        singleNodeGroup('tb-b', FRAME_W + GROUP_GAP, 0),
        singleNodeGroup('tb-c', 0, FRAME_H + GROUP_GAP),
        singleNodeGroup('tb-d', FRAME_W + GROUP_GAP, FRAME_H + GROUP_GAP),
      ];
      return { nodes: cells.map((c) => c.node), groups: cells.map((c) => c.group) };
    };

    it('tightens a 2x2 GRID of groups on both axes — the layout an immediate-predecessor sweep silently skipped', () => {
      // The bug this pins: sorting a 2x2 grid by x interleaves the rows (A row1, C row2, B row1,
      // D row2), so a sweep that compares each rect only to its immediate predecessor in sort
      // order finds every consecutive pair in DIFFERENT rows, fails the lane test every time and
      // tightens NOTHING. Tam saw exactly zero movement on a four-tab canvas while every
      // single-row fixture in this file passed.
      const model = gridModel();
      const z = 3;
      const out = applySpacing(model, z, true);

      const colGap = gapBetween(drawnFrameRect(out.groupRects['tb-a'], z), drawnFrameRect(out.groupRects['tb-b'], z));
      const rowGap = gapBetween(drawnFrameRect(out.groupRects['tb-a'], z), drawnFrameRect(out.groupRects['tb-c'], z));
      const rawColGap = gapBetween(drawnFrameRect(model.groups[0].rect, z), drawnFrameRect(model.groups[1].rect, z));
      const rawRowGap = gapBetween(drawnFrameRect(model.groups[0].rect, z), drawnFrameRect(model.groups[2].rect, z));

      expect(colGap).toBeLessThan(rawColGap / 2);
      expect(rowGap).toBeLessThan(rawRowGap / 2);
      // The second row must compact onto the first the same way, not be left behind.
      const secondRowColGap = gapBetween(drawnFrameRect(out.groupRects['tb-c'], z), drawnFrameRect(out.groupRects['tb-d'], z));
      expect(secondRowColGap).toBeCloseTo(colGap, 6);
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

    it('does not slide a member across into an overlapping group\'s terminal', () => {
      // Step 1 skips frames that ALREADY overlap — there is no gap between them to shrink — which
      // leaves step 2 free to tighten one group's members straight across into the other group's
      // terminal, since its safety proof only covers one member set. Only a manual drag can
      // produce overlapping frames; the answer there is to leave those members alone.
      const a1 = node('a1', 'tb-a', { x: 0, y: 0, w: NODE_W, h: NODE_H });
      const a2 = node('a2', 'tb-a', { x: 1000, y: 0, w: NODE_W, h: NODE_H });
      const b1 = node('b1', 'tb-b', { x: 400, y: 0, w: NODE_W, h: NODE_H });
      const model: CanvasModel = {
        nodes: [a1, a2, b1],
        groups: [
          group('tb-a', { x: -PAD, y: -PAD_TOP, w: 1000 + NODE_W + PAD * 2, h: PAD_TOP + PAD + NODE_H }, ['a1', 'a2']),
          group('tb-b', { x: 400 - PAD, y: -PAD_TOP, w: NODE_W + PAD * 2, h: PAD_TOP + PAD + NODE_H }, ['b1']),
        ],
      };
      expect(noOverlap([a1.rect, a2.rect, b1.rect])).toBe(true);

      for (const z of [2, 3, 4, 6.35]) {
        const out = applySpacing(model, z, true);
        const rects = ['a1', 'a2', 'b1'].map((id) => out.nodeRects[id]);
        expect(noOverlap(rects)).toBe(true);
      }
    });

    it('translates overlapping frames as one component, so another frame cannot pull their clear terminals together', () => {
      // A and B's drawn frames overlap at z=3, but their terminals do not. C is clear of both.
      // Tightening A and B independently lets C impose a different leftward bound on each, which
      // used to drag a1 and b1 into each other. Their connected frame component must get one dx.
      const c1 = node('c1', 'tb-c', { x: -1000, y: 0, w: NODE_W, h: NODE_H });
      const a1 = node('a1', 'tb-a', { x: 0, y: 0, w: NODE_W, h: NODE_H });
      const a2 = node('a2', 'tb-a', { x: 1000, y: 0, w: NODE_W, h: NODE_H });
      const b1 = node('b1', 'tb-b', { x: 400, y: 0, w: NODE_W, h: NODE_H });
      const frameH = PAD_TOP + PAD + NODE_H;
      const model: CanvasModel = {
        nodes: [c1, a1, a2, b1],
        groups: [
          group('tb-c', { x: -1000 - PAD, y: -PAD_TOP, w: PAD * 2 + NODE_W, h: frameH }, ['c1']),
          group('tb-a', { x: -PAD, y: -PAD_TOP, w: PAD * 2 + 1000 + NODE_W, h: frameH }, ['a1', 'a2']),
          group('tb-b', { x: 400 - PAD, y: -PAD_TOP, w: PAD * 2 + NODE_W, h: frameH }, ['b1']),
        ],
      };
      const z = 3;
      expect(noOverlap([c1.rect, a1.rect, a2.rect, b1.rect])).toBe(true);
      expect(gapBetween(drawnFrameRect(model.groups[1].rect, z), drawnFrameRect(model.groups[2].rect, z))).toBe(-Infinity);

      const out = applySpacing(model, z, true);

      expect(noOverlap([out.nodeRects.a1, out.nodeRects.b1])).toBe(true);
      expect(out.groupRects['tb-a'].x - model.groups[1].rect.x)
        .toBeCloseTo(out.groupRects['tb-b'].x - model.groups[2].rect.x, 9);
    });

    it('still tightens a clear group beyond an overlapping component instead of chaining through union bounds', () => {
      // Real shrink-wrapped frames at z=3: A and B overlap, while C overlaps neither of them
      // but would overlap their union bounds; D would then overlap that expanded union too. A
      // union-bounds sweep turns all four into one anchored component and moves nothing. Sweeping
      // real frames leaves only A/B rigid, so D is still free to tighten against B.
      const a1 = node('a1', 'tb-a', { x: 0, y: 0, w: NODE_W, h: NODE_H });
      const a2 = node('a2', 'tb-a', { x: 1000, y: 1000, w: NODE_W, h: NODE_H });
      const b1 = node('b1', 'tb-b', { x: 600, y: 600, w: NODE_W, h: NODE_H });
      const b2 = node('b2', 'tb-b', { x: 1600, y: 1600, w: NODE_W, h: NODE_H });
      const c1 = node('c1', 'tb-c', { x: 1900, y: 0, w: NODE_W, h: NODE_H });
      const d1 = node('d1', 'tb-d', { x: 2100, y: 1300, w: NODE_W, h: NODE_H });
      const frameH = PAD_TOP + PAD + NODE_H;
      const model: CanvasModel = {
        nodes: [a1, a2, b1, b2, c1, d1],
        groups: [
          group('tb-a', { x: -PAD, y: -PAD_TOP, w: 1000 + NODE_W + PAD * 2, h: 1000 + frameH }, ['a1', 'a2']),
          group('tb-b', { x: 600 - PAD, y: 600 - PAD_TOP, w: 1000 + NODE_W + PAD * 2, h: 1000 + frameH }, ['b1', 'b2']),
          group('tb-c', { x: 1900 - PAD, y: -PAD_TOP, w: PAD * 2 + NODE_W, h: frameH }, ['c1']),
          group('tb-d', { x: 2100 - PAD, y: 1300 - PAD_TOP, w: PAD * 2 + NODE_W, h: frameH }, ['d1']),
        ],
      };
      const z = 3;
      expect(noOverlap(model.nodes.map((n) => n.rect))).toBe(true);
      expect(gapBetween(drawnFrameRect(model.groups[0].rect, z), drawnFrameRect(model.groups[1].rect, z))).toBe(-Infinity);

      const out = applySpacing(model, z, true);

      expect(Math.abs(out.groupRects['tb-d'].x - model.groups[3].rect.x)
        + Math.abs(out.groupRects['tb-d'].y - model.groups[3].rect.y)).toBeGreaterThan(0);
    });

    it('does not move an interleaved overlapping component across a later singleton', () => {
      // At z=2, only A/B and B/C overlap, making ABC an immovable component. C starts to the
      // right of D even though ABC leads before D. Ordering that whole component by A's start
      // used to move C left across D; seeding ABC as an obstacle keeps both frames and terminals
      // clear while D still tightens vertically toward B.
      const z = 2;
      const drawnOffset = drawnFrameRect({ x: 0, y: 0, w: 0, h: 0 }, z);
      const layoutForDrawn = (r: Rect): Rect => ({
        x: r.x - drawnOffset.x,
        y: r.y - drawnOffset.y,
        w: r.w - drawnOffset.w,
        h: r.h - drawnOffset.h,
      });
      const drawn = [
        { x: 0, y: 0, w: 1000, h: 1900 },
        { x: 2000, y: 0, w: 1000, h: 1000 },
        { x: 2800, y: 800, w: 3000, h: 1000 },
        { x: 5000, y: 1600, w: 1000, h: 1000 },
        { x: 4000, y: 2000, w: 500, h: 500 },
      ];
      const e = node('e', 'tb-e', { x: 12, y: 17.25, w: NODE_W, h: NODE_H });
      const a = node('a', 'tb-a', { x: 2012, y: 17.25, w: NODE_W, h: NODE_H });
      const b = node('b', 'tb-b', { x: 2812, y: 817.25, w: NODE_W, h: NODE_H });
      const c = node('c', 'tb-c', { x: 5012, y: 2017.25, w: NODE_W, h: NODE_H });
      const d = node('d', 'tb-d', { x: 4012, y: 2017.25, w: NODE_W, h: NODE_H });
      const model: CanvasModel = {
        nodes: [e, a, b, c, d],
        groups: [
          group('tb-e', layoutForDrawn(drawn[0]), ['e']),
          group('tb-a', layoutForDrawn(drawn[1]), ['a']),
          group('tb-b', layoutForDrawn(drawn[2]), ['b']),
          group('tb-c', layoutForDrawn(drawn[3]), ['c']),
          group('tb-d', layoutForDrawn(drawn[4]), ['d']),
        ],
      };
      const rawFrames = model.groups.map((g) => drawnFrameRect(g.rect, z));
      expect(noOverlap(model.nodes.map((n) => n.rect))).toBe(true);
      expect(gapBetween(rawFrames[1], rawFrames[2])).toBe(-Infinity);
      expect(gapBetween(rawFrames[2], rawFrames[3])).toBe(-Infinity);

      const out = applySpacing(model, z, true);
      const spacedFrames = model.groups.map((g) => drawnFrameRect(out.groupRects[g.tabId], z));

      for (let i = 0; i < rawFrames.length; i++) {
        for (let j = i + 1; j < rawFrames.length; j++) {
          if (noOverlap([rawFrames[i], rawFrames[j]])) expect(noOverlap([spacedFrames[i], spacedFrames[j]])).toBe(true);
        }
      }
      expect(noOverlap(model.nodes.map((n) => out.nodeRects[n.terminalId]))).toBe(true);
    });
  });

  describe('spacingOffsets — the displacement the drag camera compensates for', () => {
    /**
     * A drag removes the transform for the whole gesture, which would slide the grabbed thing out
     * from under the pointer by exactly this offset; `CanvasMode` pans by its negation instead.
     * So the compensation is only ever as right as this is: an offset reported with the wrong
     * sign, against the wrong id, or as a flat zero disables the pan SILENTLY — the canvas still
     * renders, nothing throws, and the grabbed node simply jumps. That is why this is asserted
     * against `applySpacing`'s own output rather than a hand-written number.
     */
    it('reports each rect displacement from stored to spaced, including vertical group motion and a sibling-only offset', () => {
      // tb-b moves vertically as a group; tb-a's lower sibling moves vertically again during
      // step 2. This prevents a zero-dy map or a node map copied from group offsets from passing.
      const a1 = node('a1', 'tb-a', { x: PAD, y: PAD_TOP, w: NODE_W, h: NODE_H });
      const a2 = node('a2', 'tb-a', { x: PAD, y: PAD_TOP + NODE_H + 400, w: NODE_W, h: NODE_H });
      const b1 = node('b1', 'tb-b', { x: PAD, y: 1400 + PAD_TOP, w: NODE_W, h: NODE_H });
      const model: CanvasModel = {
        nodes: [a1, a2, b1],
        groups: [
          group('tb-a', { x: 0, y: 0, w: PAD * 2 + NODE_W, h: PAD_TOP + PAD + NODE_H * 2 + 400 }, ['a1', 'a2']),
          group('tb-b', { x: 0, y: 1400, w: PAD * 2 + NODE_W, h: PAD_TOP + PAD + NODE_H }, ['b1']),
        ],
      };
      const z = 3;
      const live = applySpacing(model, z, true);
      const offsets = spacingOffsets(model, live);

      expect(offsets.groups['tb-b'].dy).not.toBeCloseTo(0, 6);
      expect(offsets.nodes.a2.dy).not.toBeCloseTo(offsets.groups['tb-a'].dy, 6);

      for (const n of model.nodes) {
        const d = offsets.nodes[n.terminalId];
        expect(n.rect.x + d.dx).toBeCloseTo(live.nodeRects[n.terminalId].x, 9);
        expect(n.rect.y + d.dy).toBeCloseTo(live.nodeRects[n.terminalId].y, 9);
      }
      for (const g of model.groups) {
        const d = offsets.groups[g.tabId];
        expect(g.rect.x + d.dx).toBeCloseTo(live.groupRects[g.tabId].x, 9);
        expect(g.rect.y + d.dy).toBeCloseTo(live.groupRects[g.tabId].y, 9);
      }
    });

    it('is all zeroes when spacing is not applying, so a drag at zoom 1 pans nothing', () => {
      const model = adjacentGroupsModel();
      const offsets = spacingOffsets(model, applySpacing(model, 3, false));
      for (const n of model.nodes) expect(offsets.nodes[n.terminalId]).toEqual({ dx: 0, dy: 0 });
      for (const g of model.groups) expect(offsets.groups[g.tabId]).toEqual({ dx: 0, dy: 0 });
    });
  });

  describe('randomized spacing properties', () => {
    const PROPERTY_CASES = 256;
    const PROPERTY_SEED = 0x5EED_A5;
    /** The widest ceiling `canvasMetrics` can hand out (see its own note) — the top of the range
     *  a user can actually reach, so the top of the range these properties sample. */
    const PROPERTY_Z_MAX = 6.35;
    // Two non-overlapping deterministic stretches give a broad sample without making the
    // focused suite slow; together they cover 512 generated models.
    const PROPERTY_BATCH_STARTS = [0, 4000];

    const generatedModel = (seed: number): CanvasModel => {
      const random = mulberry32(seed);
      const randomInt = (exclusive: number) => Math.floor(random() * exclusive);
      // Half the seeds deliberately generate a clear singleton lane pair, so conditional
      // liveness is exercised often; even seeds retain the broad, unconstrained corpus.
      if ((seed & 1) === 1) {
        const y = (randomInt(13) - 6) * 350;
        const leftX = (randomInt(7) - 6) * 500;
        const rightX = leftX + (2 + randomInt(5)) * 500;
        const left = node('property-g0-n0', 'property-g0', { x: leftX, y, w: NODE_W, h: NODE_H });
        const right = node('property-g1-n0', 'property-g1', { x: rightX, y, w: NODE_W, h: NODE_H });
        const leftFrame = fitGroupFrame([left.rect]);
        const rightFrame = fitGroupFrame([right.rect]);
        if (!leftFrame || !rightFrame) throw new Error('property generator created an empty group');
        return {
          nodes: [left, right],
          groups: [
            group('property-g0', leftFrame, [left.terminalId]),
            group('property-g1', rightFrame, [right.terminalId]),
          ],
        };
      }
      const groupCount = 1 + randomInt(6);
      const nodeCounts = Array.from({ length: groupCount }, () => 1 + randomInt(4));
      // Unique 500x350 grid cells keep terminals clear while random group membership creates
      // both compact and sprawling real shrink-wrapped frames that often overlap each other.
      const cells = Array.from({ length: 13 * 13 }, (_, i) => i);
      for (let i = cells.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [cells[i], cells[j]] = [cells[j], cells[i]];
      }

      let nextCell = 0;
      const nodes: CanvasNodeModel[] = [];
      const groups: CanvasGroupModel[] = [];
      for (let gi = 0; gi < groupCount; gi++) {
        const tabId = `property-g${gi}`;
        const members: CanvasNodeModel[] = [];
        for (let ni = 0; ni < nodeCounts[gi]; ni++) {
          const cell = cells[nextCell++];
          const x = ((cell % 13) - 6) * 500;
          const y = (Math.floor(cell / 13) - 6) * 350;
          const member = node(`${tabId}-n${ni}`, tabId, { x, y, w: NODE_W, h: NODE_H });
          nodes.push(member);
          members.push(member);
        }
        const frame = fitGroupFrame(members.map((member) => member.rect));
        if (!frame) throw new Error('property generator created an empty group');
        groups.push(group(tabId, frame, members.map((member) => member.terminalId)));
      }
      return { nodes, groups };
    };

    const propertyFailure = (seed: number, z: number, model: CanvasModel, detail: string): never => {
      const fixture = {
        nodes: model.nodes.map(({ terminalId, tabId, rect }) => ({ terminalId, tabId, rect })),
        groups: model.groups.map(({ tabId, rect, nodeIds }) => ({ tabId, rect, nodeIds })),
      };
      throw new Error(`applySpacing randomized property failed: ${detail}\nseed=${seed}\nz=${z}\nmodel=${JSON.stringify(fixture)}`);
    };

    const tightenableSingletonPair = (frames: Rect[], z: number): string | undefined => {
      const seen = new Array(frames.length).fill(false);
      const singleton = new Set<number>();
      for (let start = 0; start < frames.length; start++) {
        if (seen[start]) continue;
        const indexes: number[] = [];
        const pending = [start];
        seen[start] = true;
        while (pending.length > 0) {
          const index = pending.pop()!;
          indexes.push(index);
          for (let candidate = 0; candidate < frames.length; candidate++) {
            if (seen[candidate] || !rectsOverlap(frames[index], frames[candidate])) continue;
            seen[candidate] = true;
            pending.push(candidate);
          }
        }
        if (indexes.length === 1) singleton.add(indexes[0]);
      }

      for (let i = 0; i < frames.length; i++) {
        if (!singleton.has(i)) continue;
        for (let j = i + 1; j < frames.length; j++) {
          if (!singleton.has(j)) continue;
          for (const axis of ['x', 'y'] as const) {
            const otherAxis = axis === 'x' ? 'y' : 'x';
            const first = frames[i][axis] <= frames[j][axis] ? frames[i] : frames[j];
            const second = first === frames[i] ? frames[j] : frames[i];
            const laneOverlaps = first[otherAxis] < second[otherAxis] + second[otherAxis === 'x' ? 'w' : 'h']
              && second[otherAxis] < first[otherAxis] + first[otherAxis === 'x' ? 'w' : 'h'];
            const size = axis === 'x' ? 'w' : 'h';
            const gap = second[axis] - (first[axis] + first[size]);
            // `targetGap` shrinks strictly only when the base-zoom screen gap exceeds its floor.
            if (laneOverlaps && gap > MIN_GAP_SCREEN_PX + 1 && gap * z > MIN_GAP_SCREEN_PX + 1) {
              return `${i}/${j} along ${axis}, gap=${gap}`;
            }
          }
        }
      }
      return undefined;
    };

    it('preserves spatial safety, rect identity properties, and overlapping-frame rigidity across seeded shrink-wrapped models', () => {
      let livenessEligible = 0;
      for (const batchStart of PROPERTY_BATCH_STARTS) {
        const seeds = mulberry32(PROPERTY_SEED);
        for (let skipped = 0; skipped < batchStart; skipped++) seeds();
        for (let caseIndex = 0; caseIndex < PROPERTY_CASES; caseIndex++) {
          const seed = Math.floor(seeds() * 0x100000000) >>> 0;
        const zoomRandom = mulberry32(seed ^ 0xA5A5_A5A5);
        const z = SPACING_Z_BASE + zoomRandom() * (PROPERTY_Z_MAX - SPACING_Z_BASE);
        const model = generatedModel(seed);
        // Snapshot the stored geometry BEFORE any call, by value. Every "unchanged" assertion
        // below otherwise compares the result against the very object the transform was handed,
        // and `applySpacing` returns the input rect itself on its identity paths — so an
        // implementation that mutated a stored rect in place (`Object.assign(layout[i], …)`
        // instead of allocating a fresh one) would move the expected value in lockstep with the
        // actual one and pass. That is not a hypothetical oracle nicety: not mutating the stored
        // rects IS the feature's core invariant (plan/039 §2, render-time only), so the one
        // property most worth pinning was the one comparing against a baseline that could move.
        const storedNodeRects = new Map(model.nodes.map((n) => [n.terminalId, { ...n.rect }]));
        const storedGroupRects = new Map(model.groups.map((g) => [g.tabId, { ...g.rect }]));
        const disabled = applySpacing(model, z, false);
        const baseZoom = applySpacing(model, SPACING_Z_BASE, true);
        const spaced = applySpacing(model, z, true);
        const failIf = (condition: boolean, detail: string) => {
          if (condition) propertyFailure(seed, z, model, `batch=${batchStart}; case=${caseIndex}; ${detail}`);
        };

        for (const n of model.nodes) {
          const stored = storedNodeRects.get(n.terminalId)!;
          // The transform must not have touched the model it was handed.
          failIf(!sameRect(n.rect, stored), `applySpacing MUTATED stored node ${n.terminalId}`);
          failIf(!sameRect(disabled.nodeRects[n.terminalId], stored), `disabled changed node ${n.terminalId}`);
          failIf(!sameRect(baseZoom.nodeRects[n.terminalId], stored), `base zoom changed node ${n.terminalId}`);
          const out = spaced.nodeRects[n.terminalId];
          failIf(out.x > stored.x + 1e-9 || out.y > stored.y + 1e-9, `node moved later: ${n.terminalId}`);
          failIf(out.w !== stored.w || out.h !== stored.h, `node resized: ${n.terminalId}`);
        }
        for (const g of model.groups) {
          const stored = storedGroupRects.get(g.tabId)!;
          failIf(!sameRect(g.rect, stored), `applySpacing MUTATED stored group ${g.tabId}`);
          failIf(!sameRect(disabled.groupRects[g.tabId], stored), `disabled changed group ${g.tabId}`);
          failIf(!sameRect(baseZoom.groupRects[g.tabId], stored), `base zoom changed group ${g.tabId}`);
          const out = spaced.groupRects[g.tabId];
          failIf(out.x > stored.x + 1e-9 || out.y > stored.y + 1e-9, `group moved later: ${g.tabId}`);
          failIf(out.w !== stored.w || out.h !== stored.h, `group resized: ${g.tabId}`);
        }

        const rawFrames = model.groups.map((g) => drawnFrameRect(g.rect, z));
        const spacedFrames = model.groups.map((g) => drawnFrameRect(spaced.groupRects[g.tabId], z));
        const livenessPair = z > SPACING_Z_BASE ? tightenableSingletonPair(rawFrames, z) : undefined;
        if (livenessPair) {
          livenessEligible++;
          const totalGroupDisplacement = model.groups.reduce((total, g) => {
            const out = spaced.groupRects[g.tabId];
            return total + Math.abs(out.x - g.rect.x) + Math.abs(out.y - g.rect.y);
          }, 0);
          failIf(totalGroupDisplacement <= 1e-9, `tightenable singleton pair made no group progress: ${livenessPair}`);
        }
        for (let i = 0; i < model.groups.length; i++) {
          for (let j = i + 1; j < model.groups.length; j++) {
            if (!rectsOverlap(rawFrames[i], rawFrames[j])) {
              failIf(rectsOverlap(spacedFrames[i], spacedFrames[j]), `new drawn-frame overlap: ${model.groups[i].tabId}/${model.groups[j].tabId}`);
            } else {
              const a = model.groups[i];
              const b = model.groups[j];
              const adx = spaced.groupRects[a.tabId].x - a.rect.x;
              const ady = spaced.groupRects[a.tabId].y - a.rect.y;
              const bdx = spaced.groupRects[b.tabId].x - b.rect.x;
              const bdy = spaced.groupRects[b.tabId].y - b.rect.y;
              failIf(Math.abs(adx - bdx) > 1e-9 || Math.abs(ady - bdy) > 1e-9,
                `overlapping frames lost rigidity: ${a.tabId}/${b.tabId}`);
            }
          }
        }

          const rawNodes = model.nodes.map((n) => paintedNodeRect(n.rect, z, false));
          const spacedNodes = model.nodes.map((n) => paintedNodeRect(spaced.nodeRects[n.terminalId], z, false));
          for (let i = 0; i < model.nodes.length; i++) {
            for (let j = i + 1; j < model.nodes.length; j++) {
              if (!rectsOverlap(rawNodes[i], rawNodes[j])) {
                failIf(rectsOverlap(spacedNodes[i], spacedNodes[j]), `new painted-terminal overlap: ${model.nodes[i].terminalId}/${model.nodes[j].terminalId}`);
              }
            }
          }
        }
      }
      expect(livenessEligible).toBeGreaterThan(256);
    });

    /**
     * Every property above holds at ONE zoom, and a moving transform is only visible between
     * two. That blind spot is where the shipped feature was actually broken: the camera
     * anchored a RAW world point while the content over it was drawn at `raw + offset(z)`, so
     * each wheel step slid the target out from under the cursor — cumulatively by most of a
     * screen width by the top of the zoom range, which reads to a user as "the canvas will not
     * zoom in any further". No fixed-z oracle can see it, however many properties it asserts.
     */
    it('holds the content under the zoom anchor still across a zoom step', () => {
      const ANCHOR_X = 640, ANCHOR_Y = 360;
      let eligible = 0;
      const seeds = mulberry32(PROPERTY_SEED ^ 0x2C0F_FEE);
      for (let caseIndex = 0; caseIndex < PROPERTY_CASES; caseIndex++) {
        const seed = Math.floor(seeds() * 0x100000000) >>> 0;
        const random = mulberry32(seed ^ 0x51DE_51DE);
        const model = generatedModel(seed);
        // Kept off both stops so the step usually lands somewhere real: a case clamped at the
        // ceiling asserts only that a no-op is anchored, which is true but says nothing.
        const z0 = SPACING_Z_BASE + random() * (PROPERTY_Z_MAX * 0.7 - SPACING_Z_BASE);
        // Both directions: zooming out has exactly the same anchoring obligation as zooming in.
        const factor = 0.6 + random() * 1.2;

        const before = applySpacing(model, z0, true);
        // Aim at a node the transform actually displaces where one exists. Every node is a legal
        // anchor and any of them may be selected, but the sweep's own anchor node never
        // moves, so picking uniformly spends half the corpus on cases that would pass against a
        // `zoomAnchoredAt` that did nothing at all.
        const movable = model.nodes.filter((n) => {
          const r = before.nodeRects[n.terminalId];
          return r.x !== n.rect.x || r.y !== n.rect.y;
        });
        const pool = movable.length > 0 ? movable : model.nodes;
        const target = pool[Math.floor(random() * pool.length)];
        const rect0 = before.nodeRects[target.terminalId];
        // A random point on the terminal's PAINTED body, never its centre. Holding the centre is
        // a strictly weaker property: an implementation that resolves the right node and then
        // snaps that node's centre under the cursor satisfies a centre-only oracle completely,
        // while jerking every off-centre click to the middle of the terminal.
        const painted0 = paintedNodeRect(rect0, z0, false);
        const anchorWorld = {
          x: painted0.x + (0.1 + random() * 0.8) * painted0.w,
          y: painted0.y + (0.1 + random() * 0.8) * painted0.h,
        };
        const vp0 = {
          z: z0,
          x: ANCHOR_X - anchorWorld.x * z0,
          y: ANCHOR_Y - anchorWorld.y * z0,
        };

        const vp1 = zoomAnchoredAt(vp0, factor, ANCHOR_X, ANCHOR_Y, PROPERTY_Z_MAX, model, true);
        // The zoom itself is asserted independently, not read back from the subject — otherwise
        // an implementation free to choose its own zoom could satisfy the anchoring trivially.
        const expectedZ = Math.max(Z_MIN, Math.min(PROPERTY_Z_MAX, z0 * factor));
        if (vp1.z !== expectedZ) propertyFailure(seed, z0, model, `zoom landed at ${vp1.z}, expected ${expectedZ}`);
        const after = applySpacing(model, vp1.z, true);
        const rect1 = after.nodeRects[target.terminalId];
        // The held point travels with its terminal, so it is the anchor plus that terminal's own
        // displacement — not the node's centre, and not the raw world point either.
        const screen = worldToScreen(
          vp1,
          anchorWorld.x + (rect1.x - rect0.x),
          anchorWorld.y + (rect1.y - rect0.y),
        );

        // Non-vacuity: the zoom actually moved AND the transform actually moved this node.
        if (vp1.z !== z0 && (rect1.x !== rect0.x || rect1.y !== rect0.y)) eligible++;

        const drift = Math.max(Math.abs(screen.x - ANCHOR_X), Math.abs(screen.y - ANCHOR_Y));
        if (drift > 1e-6) {
          propertyFailure(
            seed, z0, model,
            `anchored content drifted ${drift.toFixed(2)}px (z ${z0} -> ${vp1.z}, node ${target.terminalId})`,
          );
        }
      }
      expect(eligible).toBeGreaterThan(PROPERTY_CASES / 2);
    });
  });
});

/**
 * The camera has to be corrected every time the spacing FIELD changes underneath it, and zoom is
 * one of the four things that change it. The others are a drag (which swaps the whole transform
 * out for the gesture, `spacingTransitionPan`), the toolbar toggle, and a change in which nodes
 * PARTICIPATE — hiding a terminal re-shrink-wraps its frame and re-sweeps the canvas without a
 * single stored rect moving. A change to a STORED rect is deliberately not on that list: content
 * genuinely moved, and the fly-to targets already aim in display space (`targetRectAt`).
 */
describe('zoom anchoring', () => {
  const PROPERTY_Z_MAX_LOCAL = 6.35;
  // Three shrink-wrapped frames in a row, the layout `arrange()` actually produces.
  const built = [0, 1, 2].map((i) => singleNodeGroup(`t${i}`, i * (FRAME_W + GROUP_GAP), 0));
  const model: CanvasModel = {
    nodes: built.map((b) => b.node),
    groups: built.map((b) => b.group),
  };
  const FAR = built[2].node.terminalId;

  /** The camera that puts `rect`'s centre under (cx, cy) at zoom `z`. */
  const cameraOn = (rect: Rect, z: number, cx: number, cy: number) => ({
    z, x: cx - (rect.x + rect.w / 2) * z, y: cy - (rect.y + rect.h / 2) * z,
  });

  const screenCentreOf = (vp: { x: number; y: number; z: number }, rect: Rect) =>
    worldToScreen(vp, rect.x + rect.w / 2, rect.y + rect.h / 2);

  it('is exactly plain zoomAt when Dynamic Spacing is off', () => {
    const vp = { x: -100, y: -50, z: 2 };
    for (const factor of [0.5, 1.2, 3]) {
      expect(zoomAnchoredAt(vp, factor, 640, 360, PROPERTY_Z_MAX_LOCAL, model, false))
        .toEqual(zoomAt(vp, factor, 640, 360, PROPERTY_Z_MAX_LOCAL));
    }
  });

  it('is exactly plain zoomAt at and below the base zoom, where the transform is the identity', () => {
    const vp = { x: -100, y: -50, z: SPACING_Z_BASE };
    expect(zoomAnchoredAt(vp, 1.0001, 640, 360, PROPERTY_Z_MAX_LOCAL, model, true))
      .toEqual(zoomAt(vp, 1.0001, 640, 360, PROPERTY_Z_MAX_LOCAL));
  });

  it('is exactly plain zoomAt over empty canvas — nothing there to hold still', () => {
    const vp = { x: 0, y: 0, z: 3 };
    // A point far below every frame, so the anchor resolver finds neither node nor group.
    const cy = worldToScreen(vp, 0, 100_000).y;
    expect(zoomAnchoredAt(vp, 1.3, 640, cy, PROPERTY_Z_MAX_LOCAL, model, true))
      .toEqual(zoomAt(vp, 1.3, 640, cy, PROPERTY_Z_MAX_LOCAL));
  });

  it('holds the terminal under the cursor still, where plain zoomAt loses it off screen', () => {
    const z0 = 3;
    const spacedBefore = applySpacing(model, z0, true);
    const rect0 = spacedBefore.nodeRects[FAR];
    const vp0 = cameraOn(rect0, z0, 640, 360);

    const anchored = zoomAnchoredAt(vp0, 1.55, 640, 360, PROPERTY_Z_MAX_LOCAL, model, true);
    const rectAfter = applySpacing(model, anchored.z, true).nodeRects[FAR];
    const held = screenCentreOf(anchored, rectAfter);
    expect(held.x).toBeCloseTo(640, 6);
    expect(held.y).toBeCloseTo(360, 6);

    // NEGATIVE CONTROL — the same step through the shipped `zoomAt` misses by enough to matter.
    // Without this the assertion above could pass on a scenario where the transform never moved.
    const plain = zoomAt(vp0, 1.55, 640, 360, PROPERTY_Z_MAX_LOCAL);
    const lost = screenCentreOf(plain, applySpacing(model, plain.z, true).nodeRects[FAR]);
    expect(Math.abs(lost.x - 640)).toBeGreaterThan(30);
  });

  it('accumulates no drift over a wheel gesture of many small steps', () => {
    let vp = { z: 1, x: 0, y: 0 };
    const start = applySpacing(model, vp.z, true).nodeRects[FAR];
    vp = cameraOn(start, vp.z, 640, 360);
    // Enough steps to run into the ceiling, so the tail of the gesture also exercises the
    // clamped no-op path — a wheel gesture does not stop when the zoom does.
    for (let step = 0; step < 70; step++) {
      vp = zoomAnchoredAt(vp, 1.03, 640, 360, PROPERTY_Z_MAX_LOCAL, model, true);
    }
    expect(vp.z).toBe(PROPERTY_Z_MAX_LOCAL);
    const end = screenCentreOf(vp, applySpacing(model, vp.z, true).nodeRects[FAR]);
    expect(end.x).toBeCloseTo(640, 6);
    expect(end.y).toBeCloseTo(360, 6);
  });

  describe('spacingAnchorAt', () => {
    const spaced = applySpacing(model, 3, true);

    it('picks the node under the point, not the frame that contains it', () => {
      const r = spaced.nodeRects[FAR];
      expect(spacingAnchorAt(model, spaced, r.x + r.w / 2, r.y + r.h / 2, 3))
        .toEqual({ kind: 'node', id: FAR });
    });

    it('falls back to the frame for a point inside it but on no node', () => {
      const g = spaced.groupRects.t2;
      expect(spacingAnchorAt(model, spaced, g.x + 1, g.y + 1, 3)).toEqual({ kind: 'group', id: 't2' });
    });

    it('is null over empty canvas', () => {
      expect(spacingAnchorAt(model, spaced, 0, 100_000, 3)).toBeNull();
    });

    /**
     * A node paints `paintedNodeRect`, which is SHORTER than its layout rect by a head slack that
     * grows with zoom. Resolving by layout rect alone lets a later node's invisible slack out-rank
     * an earlier node's visible body — and two siblings tightened by step 2 carry different
     * offsets, so the camera then compensates by the wrong one.
     */
    it('prefers a painted body over a different node that only reserves layout slack there', () => {
      const z = 3;
      const rects = [
        { x: -1000, y: 0, w: NODE_W, h: NODE_H },
        { x: 0, y: 100, w: NODE_W, h: NODE_H },
        { x: 100, y: 0, w: NODE_W, h: NODE_H },
      ];
      const nodes = rects.map((r, i) => node(`s${i}`, 'tb-s', r));
      const frame = fitGroupFrame(rects)!;
      const stacked: CanvasModel = { nodes, groups: [group('tb-s', frame, nodes.map((n) => n.terminalId))] };
      const out = applySpacing(stacked, z, true);

      const a = out.nodeRects['s1'];
      const b = out.nodeRects['s2'];
      const paintedB = paintedNodeRect(b, z, false);
      // A point on s1's painted body, below where s2 still paints but inside s2's layout rect.
      const px = Math.max(a.x, b.x) + 5;
      const py = paintedB.y + paintedB.h + 1;
      expect(py).toBeLessThanOrEqual(b.y + b.h);
      expect(py).toBeGreaterThan(paintedB.y + paintedB.h);
      expect(paintedNodeRect(a, z, false).y + paintedNodeRect(a, z, false).h).toBeGreaterThan(py);

      expect(spacingAnchorAt(stacked, out, px, py, z)).toEqual({ kind: 'node', id: 's1' });
      // The two really do carry different offsets, so picking the wrong one is not free.
      expect(a.x - stacked.nodes[1].rect.x).not.toBeCloseTo(b.x - stacked.nodes[2].rect.x, 6);
    });
  });

  /**
   * A zoom that corrects only its DESTINATION is still wrong at every frame of an animation:
   * `offset(z)` is not affine in `z`, so interpolating two correct cameras does not give a
   * correct one in between. The toolbar and keyboard zooms animate, so they need the whole path.
   */
  describe('anchoredCamera', () => {
    const z0 = 4.75;
    const spacedStart = applySpacing(model, z0, true);
    const rect0 = spacedStart.nodeRects[FAR];
    const hold = { x: rect0.x + 40, y: rect0.y + 30 };
    const vp0 = { z: z0, x: 640 - hold.x * z0, y: 360 - hold.y * z0 };
    const path = anchoredCamera(vp0, 640, 360, model, true);

    it('holds the anchor at every zoom along the way, not only at the ends', () => {
      for (let z = z0; z >= 1; z -= 0.25) {
        const vp = path(z);
        const at = applySpacing(model, z, true).nodeRects[FAR];
        const screen = worldToScreen(vp, hold.x + (at.x - rect0.x), hold.y + (at.y - rect0.y));
        expect({ z, x: Math.round(screen.x), y: Math.round(screen.y) })
          .toEqual({ z, x: 640, y: 360 });
      }
    });

    /**
     * The negative control for the test above, and the reason the flight is handed a path at all:
     * interpolating between the two CORRECT endpoint cameras — which is what a plain `flyTo` did —
     * does not hold the anchor in between. On these three adjacent frames it is ~11px off at the
     * midpoint; the gap grows with the layout, since the offset it fails to track is the one that
     * reaches most of a screen at the extremes.
     */
    it('is not what interpolating its two endpoints would give — which is why it exists', () => {
      const end = path(1);
      const midZ = (z0 + 1) / 2;
      const at = applySpacing(model, midZ, true).nodeRects[FAR];
      const held = { x: hold.x + (at.x - rect0.x), y: hold.y + (at.y - rect0.y) };

      const lerped = { z: midZ, x: (vp0.x + end.x) / 2, y: (vp0.y + end.y) / 2 };
      expect(Math.abs(worldToScreen(lerped, held.x, held.y).x - 640)).toBeGreaterThan(5);
      expect(Math.abs(worldToScreen(path(midZ), held.x, held.y).x - 640)).toBeLessThan(1e-6);
    });

    it('agrees exactly with the single-step zoom at the destination', () => {
      const stepped = zoomAnchoredAt(vp0, 1 / z0, 640, 360, PROPERTY_Z_MAX_LOCAL, model, true);
      expect(path(stepped.z)).toEqual(stepped);
    });

    it('is bit-identical to plain zoomAt when the transform is off', () => {
      const off = anchoredCamera(vp0, 640, 360, model, false);
      for (const factor of [0.3, 0.8, 1.4]) {
        // The helper is handed a zoom, `zoomAt` a factor, so the clamp has to be applied here or
        // the two are being asked for different zooms rather than compared at the same one.
        const z = Math.max(Z_MIN, Math.min(PROPERTY_Z_MAX_LOCAL, z0 * factor));
        expect(off(z)).toEqual(zoomAt(vp0, factor, 640, 360, PROPERTY_Z_MAX_LOCAL));
      }
    });
  });
});
