import fs from 'fs';
import path from 'path';
import {
  findPaneIdByTerminalId, planRegroup, moveGroupBy, worldDelta, dropTargetTabId, regridGroup,
} from '../canvasMutations';
import { fitGroupFrame, PAD, PAD_TOP, GAP } from '../canvasLayout';
import panesReducer, {
  PaneNode, removePaneFromTab, insertPaneIntoTab,
} from '../../../store/slices/panesSlice';
import { NODE_W, NODE_H, Rect } from '../canvasGeometry';

const trees = (): Record<string, PaneNode> => ({
  'tb-a': {
    id: 'pn-1', type: 'split', direction: 'horizontal', size: 50, children: [
      { id: 'pn-2', type: 'terminal', terminalId: 'tb-a', name: 'zsh' },
      { id: 'pn-3', type: 'terminal', terminalId: 'tm-2', name: 'server' },
    ],
  },
  'tb-b': { id: 'pn-4', type: 'terminal', terminalId: 'tb-b', name: 'vite' },
});

describe('findPaneIdByTerminalId', () => {
  it('finds a nested leaf', () => {
    expect(findPaneIdByTerminalId(trees()['tb-a'], 'tm-2')).toBe('pn-3');
  });
  it('finds a root leaf', () => {
    expect(findPaneIdByTerminalId(trees()['tb-b'], 'tb-b')).toBe('pn-4');
  });
  it('returns null when absent', () => {
    expect(findPaneIdByTerminalId(trees()['tb-b'], 'tm-nope')).toBeNull();
  });
  it('returns null for a null tree', () => {
    expect(findPaneIdByTerminalId(null, 'tm-2')).toBeNull();
  });
});

describe('planRegroup', () => {
  it('removes the pane from the source tree', () => {
    const p = planRegroup(trees(), 'tm-2', 'tb-a', 'tb-b')!;
    expect(p.fromTree).not.toBeNull();
    expect(findPaneIdByTerminalId(p.fromTree, 'tm-2')).toBeNull();
    // the surviving sibling collapses up to the root
    expect(findPaneIdByTerminalId(p.fromTree, 'tb-a')).not.toBeNull();
  });

  it('inserts the pane into the destination tree', () => {
    const p = planRegroup(trees(), 'tm-2', 'tb-a', 'tb-b')!;
    expect(findPaneIdByTerminalId(p.toTree, 'tm-2')).not.toBeNull();
    expect(findPaneIdByTerminalId(p.toTree, 'tb-b')).not.toBeNull();
  });

  it('carries the pane name across', () => {
    const p = planRegroup(trees(), 'tm-2', 'tb-a', 'tb-b')!;
    expect(p.movedPane.name).toBe('server');
  });

  it('leaves the source tree null when its last terminal moves out', () => {
    const p = planRegroup(trees(), 'tb-b', 'tb-b', 'tb-a')!;
    expect(p.fromTree).toBeNull();
  });

  it('refuses a no-op move to the same tab', () => {
    expect(planRegroup(trees(), 'tm-2', 'tb-a', 'tb-a')).toBeNull();
  });

  it('returns null for an unknown terminal or tab', () => {
    expect(planRegroup(trees(), 'tm-nope', 'tb-a', 'tb-b')).toBeNull();
    expect(planRegroup(trees(), 'tm-2', 'tb-a', 'tb-nope')).toBeNull();
  });

  it('does not mutate the trees it was given', () => {
    const input = trees();
    const before = JSON.parse(JSON.stringify(input));
    planRegroup(input, 'tm-2', 'tb-a', 'tb-b');
    expect(input).toEqual(before);
  });

  // The plan asks for the ids so the WIRING can dispatch the existing reducers rather than
  // writing trees directly — see the equivalence suite below for why that matters.
  it('reports the pane to move and the pane to anchor it against', () => {
    const p = planRegroup(trees(), 'tm-2', 'tb-a', 'tb-b')!;
    expect(p.paneId).toBe('pn-3');
    expect(p.anchorPaneId).toBe('pn-4');
  });
});

/**
 * **The canvas drop and the pane drag must produce the same tree** (design 010 §6.3).
 *
 * `plan/013` Task 11 Step 5 says to apply the plan with `addTabTree({ tabId, tree })`, writing
 * both trees directly. Doing that would have been wrong three ways, and all three are silent:
 *
 *  - `addTabTree`'s payload is typed `tree: PaneNode`, **not nullable**, so the "source tab is
 *    now empty" case the very next paragraph insists on cannot be expressed by it at all.
 *  - It does not clear `maximizedPaneByTabId`. Moving a terminal out of a tab whose pane is
 *    maximized would leave a maximize pointing at a pane that is gone — the H1 invariant
 *    ("every pane-set-mutating reducer must clear the maximize flag").
 *  - It does not repair `activePaneId`/`paneTree` when the active tab's active pane is the one
 *    that left.
 *
 * `removePaneFromTab` + `insertPaneIntoTab` — the reducers the existing cross-window detach
 * already uses — handle all three. So the wiring dispatches those, and `planRegroup` stays a
 * pure PLANNER: it validates the move and names the panes.
 *
 * Which leaves one thing worth proving rather than assuming: that the planner's predicted trees
 * are exactly what those reducers produce. If they ever diverge, the canvas would show one
 * layout and the tab strip another.
 */
describe('planRegroup agrees with the reducers that actually apply it', () => {
  const state = (overrides: Partial<any> = {}) => ({
    paneTree: null,
    activePaneId: null,
    treesByTabId: trees(),
    activeTabId: null,
    activePaneByTabId: {},
    maximizedPaneByTabId: {},
    ...overrides,
  });

  const applyViaReducers = (init: any, terminalId: string, fromTabId: string, toTabId: string) => {
    const plan = planRegroup(init.treesByTabId, terminalId, fromTabId, toTabId)!;
    let s = panesReducer(init, removePaneFromTab({ tabId: fromTabId, paneId: plan.paneId }));
    s = panesReducer(s, insertPaneIntoTab({
      tabId: toTabId, targetPaneId: plan.anchorPaneId, zone: 'right', node: plan.movedPane,
    }));
    return { plan, s };
  };

  /**
   * Compare trees ignoring the ids `insertByZone` MINTS for the split wrappers it creates.
   *
   * The planner and the reducer each call `insertByZone` once, so each mints its own id and the
   * two can never be byte-equal — the first version of these two tests asserted `toEqual` and
   * failed on exactly that. What is being claimed is that the two produce the same SHAPE with
   * the same leaves in the same order, and that is what this normalises to.
   *
   * Leaf ids are deliberately NOT normalised: those are real identities carried across the move,
   * and a mismatch there would be the actual bug this suite exists to catch.
   */
  const shape = (t: PaneNode | null | undefined, path = 'r'): unknown => {
    if (!t) return null;
    if (t.type === 'terminal') {
      return { type: 'terminal', id: t.id, terminalId: t.terminalId, name: t.name };
    }
    return {
      type: 'split',
      id: path,                                  // positional, not the minted id
      direction: t.direction,
      children: (t.children ?? []).map((c, i) => shape(c, `${path}.${i}`)),
    };
  };

  it('produces the destination tree the planner predicted', () => {
    const { plan, s } = applyViaReducers(state(), 'tm-2', 'tb-a', 'tb-b');
    expect(shape(s.treesByTabId['tb-b'])).toEqual(shape(plan.toTree));
    // Guard the guard: `shape` must not be so lossy that it would match anything. The moved
    // terminal has to actually be in there, under its own leaf id.
    expect(findPaneIdByTerminalId(s.treesByTabId['tb-b'], 'tm-2')).toBe('pn-3');
  });

  it('produces the source tree the planner predicted', () => {
    const { plan, s } = applyViaReducers(state(), 'tm-2', 'tb-a', 'tb-b');
    expect(shape(s.treesByTabId['tb-a'])).toEqual(shape(plan.fromTree));
    expect(findPaneIdByTerminalId(s.treesByTabId['tb-a'], 'tm-2')).toBeNull();
  });

  // `shape` collapses split ids, so prove it still distinguishes trees that genuinely differ —
  // otherwise the two assertions above would pass against almost anything.
  it('the comparison is not vacuous', () => {
    expect(shape(trees()['tb-a'])).not.toEqual(shape(trees()['tb-b']));
    const swapped: PaneNode = {
      ...trees()['tb-a'],
      children: [...(trees()['tb-a'].children ?? [])].reverse(),
    };
    expect(shape(swapped)).not.toEqual(shape(trees()['tb-a']));
  });

  // The case `addTabTree` could not have expressed: an emptied source tab drops its tree
  // entry entirely rather than storing a null.
  it('drops the source tree entirely when the last terminal leaves', () => {
    const { plan, s } = applyViaReducers(state(), 'tb-b', 'tb-b', 'tb-a');
    expect(plan.fromTree).toBeNull();
    expect(s.treesByTabId['tb-b']).toBeUndefined();
  });

  // Design §6.3/§10: an emptied group keeps its frame and stays a drop target. The TAB must
  // therefore survive — nothing here may delete it, or a session the user only meant to move
  // would be killed.
  it('leaves the emptied tab itself in place', () => {
    const { s } = applyViaReducers(state(), 'tb-b', 'tb-b', 'tb-a');
    // Only the tree is gone; no reducer here touches the tab list, and the canvas still knows
    // the group because `buildCanvasModel` reads tabs, not trees.
    expect(Object.keys(s.treesByTabId)).toEqual(['tb-a']);
  });

  it('clears a maximize on the source tab when the maximized pane is the one that moves', () => {
    const init = state({ maximizedPaneByTabId: { 'tb-a': 'pn-3' } });
    const { s } = applyViaReducers(init, 'tm-2', 'tb-a', 'tb-b');
    expect(s.maximizedPaneByTabId['tb-a']).toBeUndefined();
  });

  it('clears a maximize on the destination tab, so the arrival is visible', () => {
    const init = state({ maximizedPaneByTabId: { 'tb-b': 'pn-4' } });
    const { s } = applyViaReducers(init, 'tm-2', 'tb-a', 'tb-b');
    expect(s.maximizedPaneByTabId['tb-b']).toBeUndefined();
  });

  it('repairs the active pane when the active tab loses the pane that was focused', () => {
    const init = state({
      activeTabId: 'tb-a', paneTree: trees()['tb-a'], activePaneId: 'pn-3',
    });
    const { s } = applyViaReducers(init, 'tm-2', 'tb-a', 'tb-b');
    expect(s.activePaneId).not.toBe('pn-3');
    expect(s.activePaneId).toBe('pn-2');
  });
});

describe('moveGroupBy', () => {
  const frame: Rect = { x: 100, y: 100, w: 500, h: 400 };
  const nodes: Record<string, Rect> = {
    n1: { x: 130, y: 146, w: NODE_W, h: NODE_H },
    n2: { x: 130, y: 400, w: NODE_W, h: NODE_H },
    other: { x: 9999, y: 9999, w: NODE_W, h: NODE_H },
  };

  it('translates the frame and only its own members', () => {
    const r = moveGroupBy(frame, nodes, ['n1', 'n2'], 40, -25);
    expect(r.frame).toEqual({ x: 140, y: 75, w: 500, h: 400 });
    expect(r.nodes.n1).toEqual({ x: 170, y: 121, w: NODE_W, h: NODE_H });
    expect(r.nodes.n2).toEqual({ x: 170, y: 375, w: NODE_W, h: NODE_H });
    expect(r.nodes.other).toEqual(nodes.other);
  });

  it('preserves relative offsets exactly', () => {
    const r = moveGroupBy(frame, nodes, ['n1', 'n2'], 7, 13);
    expect(r.nodes.n1.x - r.frame.x).toBe(nodes.n1.x - frame.x);
    expect(r.nodes.n2.y - r.frame.y).toBe(nodes.n2.y - frame.y);
  });

  it('does not mutate its inputs', () => {
    const snapshot = JSON.parse(JSON.stringify(nodes));
    moveGroupBy(frame, nodes, ['n1'], 5, 5);
    expect(nodes).toEqual(snapshot);
  });

  it('ignores ids with no geometry rather than writing undefined', () => {
    const r = moveGroupBy(frame, nodes, ['n1', 'ghost'], 5, 5);
    expect('ghost' in r.nodes).toBe(false);
  });

  it('a zero delta is a faithful copy', () => {
    const r = moveGroupBy(frame, nodes, ['n1', 'n2'], 0, 0);
    expect(r.frame).toEqual(frame);
    expect(r.nodes).toEqual(nodes);
  });
});

/**
 * The screen→world conversion, which the task's own note flags as the easy thing to get wrong:
 * skip it and the drag lags the cursor at every zoom except 1 — and lags *proportionally*, so it
 * looks perfect while you are testing at 1:1 and is obviously broken as soon as you zoom.
 */
describe('worldDelta', () => {
  it('is the identity at 1:1', () => {
    expect(worldDelta(10, -4, 1)).toEqual({ dx: 10, dy: -4 });
  });

  it('a zoomed-OUT canvas covers more world per pixel', () => {
    expect(worldDelta(10, 20, 0.5)).toEqual({ dx: 20, dy: 40 });
  });

  it('a zoomed-IN canvas covers less', () => {
    expect(worldDelta(10, 20, 4)).toEqual({ dx: 2.5, dy: 5 });
  });

  // The direction is the half that is easy to invert, and inverting it still "works" at z=1.
  it('scales inversely with zoom, never with it', () => {
    expect(worldDelta(10, 0, 0.25).dx).toBeGreaterThan(worldDelta(10, 0, 4).dx);
  });

  it('survives a degenerate zoom instead of returning Infinity', () => {
    expect(Number.isFinite(worldDelta(10, 10, 0).dx)).toBe(true);
  });
});

describe('dropTargetTabId', () => {
  const groups = [
    { tabId: 'tb-a', rect: { x: 0, y: 0, w: 400, h: 300 } },
    { tabId: 'tb-b', rect: { x: 500, y: 0, w: 400, h: 300 } },
  ];

  it('names the frame under the point', () => {
    expect(dropTargetTabId(groups, 200, 150, 'tb-b')).toBe('tb-a');
  });

  // Dropping a node back in its own frame is a MOVE, not a re-home. Returning the tab would
  // both highlight a frame that is not going to change and drive a no-op regroup.
  it('is null over the node\'s own frame', () => {
    expect(dropTargetTabId(groups, 200, 150, 'tb-a')).toBeNull();
  });

  it('is null over open canvas', () => {
    expect(dropTargetTabId(groups, 450, 150, 'tb-a')).toBeNull();
  });

  it('is inclusive on the edges, like groupAt', () => {
    expect(dropTargetTabId(groups, 0, 0, 'tb-b')).toBe('tb-a');
    expect(dropTargetTabId(groups, 400, 300, 'tb-b')).toBe('tb-a');
    expect(dropTargetTabId(groups, 401, 300, 'tb-b')).toBeNull();
  });

  it('prefers the last frame when frames overlap, matching paint order', () => {
    const overlapping = [
      { tabId: 'tb-under', rect: { x: 0, y: 0, w: 400, h: 300 } },
      { tabId: 'tb-over', rect: { x: 100, y: 100, w: 400, h: 300 } },
    ];
    expect(dropTargetTabId(overlapping, 200, 150, 'tb-x')).toBe('tb-over');
    // ...and the topmost frame being the node's own means null, NOT a fall-through to the one
    // underneath. A fall-through would silently re-home into a frame the user cannot see.
    expect(dropTargetTabId(overlapping, 200, 150, 'tb-over')).toBeNull();
  });

  it('is null when there are no frames at all', () => {
    expect(dropTargetTabId([], 10, 10, 'tb-a')).toBeNull();
  });
});

/**
 * `regridGroup` — the sidebar drop path (`plan/013` Task 15).
 *
 * A list drag carries no position, so the arriving terminal is slotted into the destination's
 * grid rather than dropped somewhere arbitrary (design 010 §6.3). This is the ONE real
 * difference between the two re-homing entry points, and the canvas drop deliberately does not
 * call it.
 */
describe('regridGroup', () => {
  it('slots nodes into a tidy grid anchored at the frame origin', () => {
    const r = regridGroup({ x: 500, y: 300, w: 0, h: 0 }, ['a', 'b']);
    expect(r.nodes.a).toEqual({ x: 500 + PAD, y: 300 + PAD_TOP });
    expect(r.nodes.b).toEqual({ x: 500 + PAD + NODE_W + GAP, y: 300 + PAD_TOP });
  });

  it('resizes the frame to fit exactly', () => {
    const r = regridGroup({ x: 0, y: 0, w: 0, h: 0 }, ['a', 'b']);
    expect(r.frame.w).toBe(PAD * 2 + NODE_W * 2 + GAP);
    expect(r.frame.h).toBe(PAD_TOP + PAD + NODE_H);
  });

  it('preserves the frame origin so the group does not jump', () => {
    const r = regridGroup({ x: 123, y: 456, w: 10, h: 10 }, ['a']);
    expect(r.frame.x).toBe(123);
    expect(r.frame.y).toBe(456);
  });

  it('handles an empty group', () => {
    const r = regridGroup({ x: 0, y: 0, w: 400, h: 300 }, []);
    expect(Object.keys(r.nodes)).toHaveLength(0);
  });

  // ...and keeps its size rather than shrinking to a one-node box. An emptied group stays a
  // visible drop target (design §6.3/§10) — the same reason `fitGroupFrame` returns null for one
  // instead of an empty rect.
  it('leaves an empty group at the size it already had', () => {
    expect(regridGroup({ x: 7, y: 9, w: 400, h: 300 }, []).frame).toEqual({ x: 7, y: 9, w: 400, h: 300 });
  });

  it('wraps every id it was given, in grid order', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const r = regridGroup({ x: 0, y: 0, w: 0, h: 0 }, ids);
    expect(Object.keys(r.nodes).sort()).toEqual(ids);
    // 5 nodes → 3 columns, so the fourth starts a second row.
    expect(r.nodes.d.y).toBeGreaterThan(r.nodes.a.y);
    expect(r.nodes.d.x).toBe(r.nodes.a.x);
  });

  /**
   * The frame it returns has to BE the shrink-wrap of the nodes it just placed.
   *
   * `buildModel` draws a non-empty group's frame as `fitGroupFrame` of its terminals and ignores
   * the stored rect, so a frame that disagreed would be overridden on the next render — while
   * still being the box `seedNodePosition` places the NEXT new pane against. The disagreement
   * would show up only as a split landing in the wrong place, one gesture later.
   */
  it('agrees with the shrink-wrap that will actually be drawn', () => {
    for (const n of [1, 2, 3, 5, 8]) {
      const ids = Array.from({ length: n }, (_, i) => `n${i}`);
      const r = regridGroup({ x: 640, y: 480, w: 0, h: 0 }, ids);
      const rects: Rect[] = ids.map((id) => ({ ...r.nodes[id], w: NODE_W, h: NODE_H }));
      expect(fitGroupFrame(rects)).toEqual(r.frame);
    }
  });

  it('does not mutate the frame it was given', () => {
    const frame: Rect = { x: 1, y: 2, w: 3, h: 4 };
    regridGroup(frame, ['a', 'b']);
    expect(frame).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  });
});

/**
 * The drag wiring, derived from source. `useCanvasDrag` registers window listeners and
 * dispatches into a real store; `CanvasMode` cannot be mounted under the root Jest config. These
 * pin the handful of choices that would silently undo the pure logic above.
 */
describe('drag wiring', () => {
  const src = (f: string) => fs.readFileSync(path.resolve(__dirname, f), 'utf8');
  const DRAG = src('../useCanvasDrag.ts');
  const MODE = src('../CanvasMode.tsx');

  it('applies a re-home through the existing reducers, not by writing trees', () => {
    // `addTabTree` cannot express an emptied source tab, does not clear either maximize flag,
    // and does not repair the active pane. See `planRegroup`'s note.
    expect(DRAG).toContain('removePaneFromTab(');
    expect(DRAG).toContain('insertPaneIntoTab(');
    expect(DRAG).not.toContain('addTabTree');
  });

  it('converts the pointer delta to world units', () => {
    // Skipping this lags the drag at every zoom but 1 — and proportionally, so it looks correct
    // while testing at 1:1.
    expect(DRAG).toContain('worldDelta(');
  });

  it('measures the delta from the press, not from the previous frame', () => {
    // Accumulating per-frame deltas drifts under rounding over a long drag.
    expect(DRAG).toContain('e.clientX - nd.startX');
    expect(DRAG).toContain('e.clientX - gd.startX');
  });

  it('does not re-fit an emptied group, so it keeps its frame as a drop target', () => {
    // Design §6.3/§10. `fitGroupFrame` returns null for an empty group and the dispatch is
    // skipped — the skip is the behaviour, not an oversight.
    expect(DRAG).toContain('if (fitted) dispatch(setGroupGeom');
  });

  it('never closes the emptied source tab', () => {
    // Closing it would kill a session the user only meant to move.
    expect(DRAG).not.toContain('closeTab');
    expect(DRAG).not.toContain('removeTabTree');
  });

  it('drags a node by its ORIGINAL rect, never the overlay rect', () => {
    // An overlaid node's rect is a screen-filling box in world units; starting a drag from it
    // would fling the node across the workspace.
    expect(MODE).toContain('isOverlaid ? undefined : drag.onNodeHeaderPointerDown(n.terminalId, n.tabId, n.rect)');
  });

  it('highlights the frame under the drag', () => {
    expect(MODE).toContain('dropTarget={drag.dropTabId === g.tabId}');
    expect(MODE).toContain('onLabelPointerDown={drag.onGroupLabelPointerDown(g.tabId)}');
  });
});
