import panesReducer, {
  addTabTree, removePaneFromTab, insertPaneIntoTab, PaneNode,
} from '../../../store/slices/panesSlice';
import { seedTreeFor } from '../../../services/tabTreeSeed';
import { planRegroup, findPaneIdByTerminalId } from '../canvasMutations';
import { buildCanvasModel } from '../canvasSelectors';
import { arrangeTarget } from '../animateLayout';
import { fitGroupFrame } from '../canvasLayout';
import { NODE_W, NODE_H, Rect } from '../canvasGeometry';

/**
 * Dragging a group's LAST terminal into another group must not leave it in both.
 *
 * Tam reported this as "I click Arrange and the terminals and groups are messed up", with one
 * group frame stretched down the whole workspace and swallowing two others. Arrange was not
 * the fault — fed the dev instance's real 7-group shape it produces a tidy grid with no
 * overlaps at all. It was the amplifier. The state was already wrong:
 *
 *   1. re-homing the last terminal emptied the source tab, and `removePaneFromTab` DELETED
 *      the tab's tree entry;
 *   2. a deleted entry is indistinguishable from a tab that was never initialised, so
 *      `TerminalContainer`'s seed effect — which exists for the second — fired for the first
 *      and manufactured a root leaf carrying the tab's own id;
 *   3. that is exactly the id the move carried away, so the terminal was now a member of two
 *      groups;
 *   4. `arrange` keys node offsets in one flat map, so the duplicate lands in whichever group
 *      comes last, and `buildModel` shrink-wraps the OTHER group's frame across the canvas to
 *      reach it.
 *
 * Each numbered link is pinned below, so a regression at any one of them fails here rather
 * than only showing up as a screenshot nobody can reduce.
 */

const leaf = (paneId: string, terminalId: string): PaneNode => ({
  id: paneId, type: 'terminal', terminalId, name: terminalId,
});

const TABS = [
  { id: 'tb-a', title: 'Windows PowerShell', shellType: 'powershell' },
  { id: 'tb-b', title: 'PowerShell 7 4', shellType: 'powershell' },
];

/** `tb-a` holds a split; `tb-b` holds one terminal whose id IS the tab's — what a tab's root
 *  pane carries, and the shape that made the resurrection collide. */
const initialPanes = () => {
  let s = panesReducer(undefined, { type: '@@INIT' } as any);
  s = panesReducer(s, addTabTree({
    tabId: 'tb-a',
    tree: {
      id: 'pn-root', type: 'split', direction: 'horizontal', size: 50,
      children: [leaf('pn-a1', 'tb-a'), leaf('pn-a2', 'tm-right')],
    },
  }));
  return panesReducer(s, addTabTree({ tabId: 'tb-b', tree: leaf('pn-b1', 'tb-b') }));
};

/** Re-home `tb-b`'s only terminal into `tb-a`, exactly as `useCanvasDrag.applyRegroup` does. */
const regroup = (state: ReturnType<typeof initialPanes>) => {
  const plan = planRegroup(state.treesByTabId, 'tb-b', 'tb-b', 'tb-a')!;
  let s = panesReducer(state, removePaneFromTab({ tabId: 'tb-b', paneId: plan.paneId }));
  return panesReducer(s, insertPaneIntoTab({
    tabId: 'tb-a', targetPaneId: plan.anchorPaneId, zone: 'right', node: plan.movedPane,
  }));
};

/**
 * Stored group rects for BOTH tabs, which is what a canvas the user has actually arranged
 * looks like. It matters here: `buildModel` keeps an emptied tab's frame only when it has a
 * stored rect, so without one the emptied group vanishes from the model and every assertion
 * about it passes for the wrong reason.
 */
const STORED_GROUPS = {
  'tb-a': { x: 60, y: 60, w: 740, h: 249 },
  'tb-b': { x: 890, y: 60, w: 372, h: 249 },
};

const modelFor = (panes: ReturnType<typeof initialPanes>) => buildCanvasModel({
  tabs: { tabs: TABS },
  panes,
  canvas: { nodes: {}, groups: STORED_GROUPS },
} as any);

/** What the canvas DRAWS for each group: `buildModel` shrink-wraps the frame around wherever
 *  its members ended up, so a member in another group's cell drags the frame over there. */
const drawnFrames = (
  groups: { tabId: string; nodeIds: string[] }[],
  nodes: Record<string, { x: number; y: number }>,
) => groups.map((g) => ({
  tabId: g.tabId,
  rect: fitGroupFrame(
    g.nodeIds.map((id) => nodes[id]).filter(Boolean)
      .map((p) => ({ x: p.x, y: p.y, w: NODE_W, h: NODE_H })),
  ),
}));

const overlappingPairs = (frames: { tabId: string; rect: Rect | null }[]) => {
  const out: string[] = [];
  for (let i = 0; i < frames.length; i++) {
    for (let j = i + 1; j < frames.length; j++) {
      const a = frames[i].rect;
      const b = frames[j].rect;
      if (!a || !b) continue;
      const hit = !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
      if (hit) out.push(`${frames[i].tabId}<->${frames[j].tabId}`);
    }
  }
  return out;
};

describe('re-homing a group\'s last terminal', () => {
  // Link 1: the emptied tab keeps its entry, holding null.
  it('empties the source tab without deleting its entry', () => {
    const s = regroup(initialPanes());
    expect('tb-b' in s.treesByTabId).toBe(true);
    expect(s.treesByTabId['tb-b']).toBeNull();
  });

  // Link 2: the seed effect must read that null as "initialised" and leave the tab alone.
  it('the seed effect refuses to refill the emptied tab', () => {
    const s = regroup(initialPanes());
    expect(seedTreeFor(TABS[1], s.treesByTabId, {})).toBeNull();
  });

  // Link 2, the other route in: even with no entry at all — a layout restored from the
  // window-global mirror arrives that way — a seed that would name a terminal another tab
  // already owns is refused.
  it('refuses a seed naming a terminal another tab already owns', () => {
    const s = regroup(initialPanes());
    const withoutEntry = { ...s.treesByTabId };
    delete withoutEntry['tb-b'];
    expect(seedTreeFor(TABS[1], withoutEntry, {})).toBeNull();

    // ...and the stale mirror is refused for the same reason, not merely the manufactured leaf.
    expect(seedTreeFor(TABS[1], withoutEntry, { 'tb-b': leaf('pn-stale', 'tb-b') })).toBeNull();
  });

  // A tab that genuinely has never been initialised still gets its tree, or every new tab
  // would come up blank. Without this the rule above could be satisfied by refusing always.
  it('still seeds a tab that has never been initialised', () => {
    const s = regroup(initialPanes());
    const seed = seedTreeFor({ id: 'tb-new', title: 'New', shellType: 'powershell' },
      s.treesByTabId, {});
    expect(seed).not.toBeNull();
    expect(seed!.terminalId).toBe('tb-new');
  });

  // The emptied group is still a DROP TARGET (design 010 §6.3), so a terminal has to be able
  // to come back. Making the empty state reachable is what put this on the hook: while the
  // tab was being silently refilled, a drop here never had to work.
  it('accepts a terminal dropped back into the emptied group', () => {
    const emptied = regroup(initialPanes());
    const plan = planRegroup(emptied.treesByTabId, 'tm-right', 'tb-a', 'tb-b');
    expect(plan).not.toBeNull();
    expect(plan!.anchorPaneId).toBeNull();          // nothing to insert against — it is empty

    let s = panesReducer(emptied, removePaneFromTab({ tabId: 'tb-a', paneId: plan!.paneId }));
    s = panesReducer(s, insertPaneIntoTab({
      tabId: 'tb-b', targetPaneId: plan!.anchorPaneId, zone: 'right', node: plan!.movedPane,
    }));

    expect(findPaneIdByTerminalId(s.treesByTabId['tb-b'], 'tm-right')).toBe('pn-a2');
    // ...and it did not stay behind in the tab it came from.
    expect(findPaneIdByTerminalId(s.treesByTabId['tb-a'], 'tm-right')).toBeNull();
  });

  // Link 3: the model the whole canvas reads — sidebar, wires, frames, Arrange.
  it('leaves every terminal in exactly one group', () => {
    const model = modelFor(regroup(initialPanes()));
    const homes = new Map<string, string[]>();
    for (const g of model.groups) {
      for (const id of g.nodeIds) homes.set(id, [...(homes.get(id) ?? []), g.tabId]);
    }
    for (const [terminalId, groups] of homes) {
      expect({ terminalId, groups }).toEqual({ terminalId, groups: [groups[0]] });
    }
    expect(homes.get('tb-b')).toEqual(['tb-a']);
  });

  // Link 4: the visible symptom. Frames may touch, never overlap.
  it('arranges into frames that do not overlap', () => {
    const model = modelFor(regroup(initialPanes()));
    const target = arrangeTarget(model, []);
    expect(overlappingPairs(drawnFrames(model.groups, target.nodes))).toEqual([]);
  });

  // Guard the guard. The overlap check above must actually be able to FAIL — an empty group
  // list or a frame-less model would pass it silently. Re-introduce the duplicate the bug
  // produced and the same assertion has to fire.
  it('the overlap check catches a terminal that is in two groups', () => {
    const model = modelFor(regroup(initialPanes()));
    const duped = {
      ...model,
      groups: model.groups.map((g) =>
        g.tabId === 'tb-b' ? { ...g, nodeIds: ['tb-b'] } : g),
    };
    const target = arrangeTarget(duped, []);
    expect(overlappingPairs(drawnFrames(duped.groups, target.nodes)).length).toBeGreaterThan(0);
  });
});
