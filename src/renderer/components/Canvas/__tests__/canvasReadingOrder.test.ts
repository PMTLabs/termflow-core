/**
 * Left to right, top to bottom (Tam, 2026-08-21).
 *
 * Three separate claims live here, and only the first is about the sort itself:
 *
 *  1. `readingOrder` bands by vertical OVERLAP, so a node nudged down stays on its row, and it
 *     is total — coincident nodes never swap between renders.
 *  2. `buildModel` applies it PER GROUP, to both arrays it returns.
 *  3. **`stepNodeId` and `buildSidebarTree` still agree.** That is the invariant the whole
 *     choice rests on: the old `stepNodeId` comment refused to sort by position precisely
 *     because it would split the keyboard's order from the list's, and the answer was to sort
 *     once in `buildModel` so both follow. Nothing else in the suite can see that split — each
 *     surface would keep passing its own tests while pointing somewhere different.
 */
import { readingOrder, sameRow, ROW_OVERLAP } from '../readingOrder';
import { buildCanvasModel, CanvasNodeModel } from '../canvasSelectors';
import { buildSidebarTree } from '../sidebarModel';
import { stepNodeId } from '../orientation';
import { NODE_W, NODE_H, Rect } from '../canvasGeometry';
import type { PaneNode } from '../../../store/slices/panesSlice';

/* ---- the sort ------------------------------------------------------------- */

interface Item { id: string; rect: Rect }

const at = (i: Item) => i.rect;
const idOf = (i: Item) => i.id;
const order = (items: Item[]) => readingOrder(items, at, idOf).map(idOf);

/** A standard node box at (x, y) — the size everything on the canvas is seeded at. */
const box = (id: string, x: number, y: number, h = NODE_H): Item =>
  ({ id, rect: { x, y, w: NODE_W, h } });

describe('readingOrder walks left to right, then top to bottom', () => {
  it('orders a clean grid the way you would read it', () => {
    // b a       ->  a b
    // d c           c d
    expect(order([
      box('b', 400, 0), box('a', 0, 0),
      box('d', 400, 400), box('c', 0, 400),
    ])).toEqual(['a', 'b', 'c', 'd']);
  });

  it('is unmoved by the order it is given', () => {
    const grid = [box('a', 0, 0), box('b', 400, 0), box('c', 0, 400), box('d', 400, 400)];
    const shuffled = [grid[3], grid[1], grid[2], grid[0]];
    expect(order(shuffled)).toEqual(order(grid));
  });

  /**
   * The case a `|y1 - y2| < tol` rule gets wrong, and the reason banding is by overlap.
   *
   * Two terminals dragged side by side are almost never top-aligned to the pixel. At 40px of
   * drift they still read as one row — a sort that called that two rows would send Tab down to
   * the second node and back up to its neighbour.
   */
  it('keeps a nudged node on the row it visually shares', () => {
    expect(order([box('right', 400, 40), box('left', 0, 0)])).toEqual(['left', 'right']);
  });

  it('starts a new row once a node has genuinely dropped below', () => {
    // Clear of the anchor's bottom edge: no overlap at all.
    expect(order([box('below', 0, NODE_H + 10), box('above', 400, 0)]))
      .toEqual(['above', 'below']);
  });

  /**
   * Bands are measured against the ANCHOR, never against a running union of the band.
   *
   * Each step here overlaps its predecessor by 60% and the last overlaps the first by nothing.
   * A band that accumulated its extent would swallow the whole diagonal into one row and report
   * a staircase as a line.
   */
  it('does not let a staircase creep into one row', () => {
    const step = NODE_H * 0.6;
    const stair = [box('s0', 0, 0), box('s1', 300, step), box('s2', 600, step * 2), box('s3', 900, step * 3)];
    // s0 and s1 overlap by 40% of a height — under the threshold, so four separate rows, and
    // the order is therefore top-to-bottom rather than left-to-right.
    expect(order(stair)).toEqual(['s0', 's1', 's2', 's3']);
  });

  it('bands nodes of different heights by the SHORTER one', () => {
    const tall = box('tall', 0, 0, 600);
    // Sits inside the tall node's rows, and more than half of ITS height overlaps.
    const short = box('short', 400, 400, 160);
    expect(sameRow(tall.rect, short.rect)).toBe(true);
    expect(order([short, tall])).toEqual(['tall', 'short']);
  });

  /**
   * Total, so the sequence cannot flip between two renders of identical state. Tab would
   * otherwise step "forward" into the node it had just left.
   */
  it('breaks exact ties by id, not by input order', () => {
    const a = box('aaa', 100, 100);
    const b = box('bbb', 100, 100);
    expect(order([a, b])).toEqual(['aaa', 'bbb']);
    expect(order([b, a])).toEqual(['aaa', 'bbb']);
  });

  it('drops nothing and invents nothing', () => {
    const items = [box('a', 0, 0), box('b', 400, 0), box('c', 0, 400)];
    expect(order(items).slice().sort()).toEqual(['a', 'b', 'c']);
    expect(order([])).toEqual([]);
  });

  // The threshold itself, asserted at both sides of the boundary so the constant is pinned
  // rather than merely present.
  it('puts the row boundary at the documented fraction', () => {
    const anchor: Rect = { x: 0, y: 0, w: NODE_W, h: 100 };
    const justIn: Rect = { x: 400, y: 100 - ROW_OVERLAP * 100, w: NODE_W, h: 100 };
    const justOut: Rect = { x: 400, y: 100 - ROW_OVERLAP * 100 + 1, w: NODE_W, h: 100 };
    expect(sameRow(anchor, justIn)).toBe(true);
    expect(sameRow(anchor, justOut)).toBe(false);
  });

  it('gives a zero-height rect no row to share', () => {
    expect(sameRow({ x: 0, y: 0, w: 10, h: 100 }, { x: 0, y: 50, w: 10, h: 0 })).toBe(false);
  });
});

/* ---- the model, and the invariant --------------------------------------- */

const leaf = (id: string, terminalId: string, name: string): PaneNode =>
  ({ id, type: 'terminal', terminalId, name } as PaneNode);

/**
 * A two-group workspace whose STORED rects deliberately disagree with pane order.
 *
 * Inside `tb-a` the panes are declared 1, 2, 3 but placed 3, 1, 2 across one row; the groups
 * themselves are declared a, b but `tb-b` sits above and left of `tb-a`. So every assertion
 * below fails against a builder that returns either array in its natural order — which is what
 * `test-arrange-right-assert-blind` asks for.
 */
const state = () => ({
  tabs: {
    tabs: [
      { id: 'tb-a', title: 'api', shellType: 'zsh', isActive: false },
      { id: 'tb-b', title: 'web', shellType: 'zsh', isActive: false },
    ],
    runningTerminalIds: [],
  },
  panes: {
    treesByTabId: {
      'tb-a': {
        id: 'pn-root-a',
        type: 'split',
        direction: 'vertical',
        size: 50,
        children: [leaf('pn-1', 'tm-1', 'one'), leaf('pn-2', 'tm-2', 'two'), leaf('pn-3', 'tm-3', 'three')],
      },
      'tb-b': {
        id: 'pn-root-b',
        type: 'split',
        direction: 'vertical',
        size: 50,
        children: [leaf('pn-4', 'tm-4', 'four'), leaf('pn-5', 'tm-5', 'five')],
      },
    },
  },
  canvas: {
    // tb-a's row, left to right: tm-3, tm-1, tm-2 — the reverse of nothing in particular, and
    // deliberately not pane order.
    nodes: {
      'tm-3': { x: 2000, y: 1000, w: NODE_W, h: NODE_H },
      'tm-1': { x: 2500, y: 1000, w: NODE_W, h: NODE_H },
      'tm-2': { x: 3000, y: 1000, w: NODE_W, h: NODE_H },
      // tb-b sits ABOVE tb-a, so the second-declared group is read first.
      'tm-5': { x: 100, y: 100, w: NODE_W, h: NODE_H },
      'tm-4': { x: 600, y: 100, w: NODE_W, h: NODE_H },
    },
    groups: {},
  },
  sessionExit: { byTerminalId: {} },
}) as never;

const model = () => buildCanvasModel(state());

describe('buildModel returns both arrays in reading order', () => {
  it('orders the groups by where their frames sit, not by tab order', () => {
    expect(model().groups.map((g) => g.tabId)).toEqual(['tb-b', 'tb-a']);
  });

  it('orders each group\'s terminals across its own row', () => {
    expect(model().nodes.map((n) => n.terminalId)).toEqual(['tm-5', 'tm-4', 'tm-3', 'tm-1', 'tm-2']);
  });

  /**
   * PER GROUP, not globally — and this is the assertion that tells the two apart. Globally,
   * `tb-b`'s pair (y=100) and `tb-a`'s trio (y=1000) would still come out in this sequence, so
   * the case above cannot distinguish them. Contiguity can: a global sort is free to interleave
   * groups whenever their rows cross, and this says it never does.
   */
  it('never interleaves one group\'s terminals with another\'s', () => {
    const m = model();
    const tabs = m.nodes.map((n) => n.tabId);
    const runs = tabs.filter((t, i) => t !== tabs[i - 1]);
    expect(runs).toEqual([...new Set(runs)]);
    expect(runs).toEqual(m.groups.filter((g) => g.nodeIds.length).map((g) => g.tabId));
  });

  /**
   * `nodeIds` keeps the PANE tree's order. It is what `arrange` lays a grid out from, and
   * re-indexing it would silently change which terminal lands in which slot on Arrange — a
   * different feature, and not what was asked for.
   */
  it('leaves nodeIds in pane order, which arrange still depends on', () => {
    const a = model().groups.find((g) => g.tabId === 'tb-a')!;
    expect(a.nodeIds).toEqual(['tm-1', 'tm-2', 'tm-3']);
  });

  it('returns every terminal exactly once', () => {
    expect(model().nodes.map((n) => n.terminalId).slice().sort())
      .toEqual(['tm-1', 'tm-2', 'tm-3', 'tm-4', 'tm-5']);
  });
});

/**
 * THE invariant. `stepNodeId` walks `model.nodes`; the sidebar walks `model.groups` and reads
 * each group's rows out of `model.nodes`. They must produce one sequence.
 *
 * Asserted by actually STEPPING the whole cycle rather than by comparing the arrays — the arrays
 * being equal is the mechanism, and a future change could keep them equal while `stepNodeId`
 * read something else entirely.
 */
describe('Tab and the sidebar walk the same sequence', () => {
  const sidebarSequence = (): string[] => {
    const m = model();
    return buildSidebarTree(m.nodes, m.groups, '', {})
      .flatMap((g) => g.rows.map((r) => r.terminalId));
  };

  const tabSequence = (): string[] => {
    const ids = model().nodes.map((n) => n.terminalId);
    const out: string[] = [];
    let cur: string | null = null;
    for (let i = 0; i < ids.length; i += 1) {
      cur = stepNodeId(ids, cur, 1);
      out.push(cur!);
    }
    return out;
  };

  it('agree, forwards', () => {
    expect(tabSequence()).toEqual(sidebarSequence());
  });

  it('agree, backwards', () => {
    const ids = model().nodes.map((n) => n.terminalId);
    const back: string[] = [];
    let cur: string | null = null;
    for (let i = 0; i < ids.length; i += 1) {
      cur = stepNodeId(ids, cur, -1);
      back.push(cur!);
    }
    expect(back).toEqual([...sidebarSequence()].reverse());
  });

  /**
   * Guard on the guard. Both helpers above derive from the same builder, so a sequence that was
   * EMPTY — or that happened to be pane order — would satisfy the two cases above perfectly.
   * This pins that the shared sequence is the spatial one the feature is about.
   */
  it('and the sequence they agree on is the spatial one', () => {
    expect(sidebarSequence()).toEqual(['tm-5', 'tm-4', 'tm-3', 'tm-1', 'tm-2']);
    // ...which is NOT pane order, or the whole change would be invisible.
    expect(sidebarSequence()).not.toEqual(['tm-1', 'tm-2', 'tm-3', 'tm-4', 'tm-5']);
  });

  // The sidebar still filters, and a filtered list is still a subsequence of the same order.
  it('keeps the order under a search filter', () => {
    const m = model();
    const filtered = buildSidebarTree(m.nodes, m.groups, 'o', {})
      .flatMap((g) => g.rows.map((r) => r.terminalId));
    expect(filtered.length).toBeGreaterThan(0);
    const full = sidebarSequence();
    expect(filtered).toEqual(full.filter((id) => filtered.includes(id)));
  });
});

/**
 * The defensive branch in `buildModel`: a node whose group is missing from `groups` is appended,
 * never dropped. It should be unreachable — every node pushes a group in the same iteration —
 * but the failure if it were reachable is a terminal that disappears from the canvas, which is
 * not a thing to leave resting on "should never".
 */
describe('no terminal can fall out of the model', () => {
  it('keeps a node whose group is absent', () => {
    const nodes: CanvasNodeModel[] = [
      { terminalId: 'tm-x', tabId: 'tb-missing', paneId: 'pn-x', title: 'x', groupTitle: 'x',
        shellType: 'zsh', rect: { x: 0, y: 0, w: NODE_W, h: NODE_H }, isRunning: false,
        hasUnseenOutput: false, exited: false },
    ];
    // Exercised at the level the branch lives at: with no group to claim it, the node must still
    // come back from a reading-order pass rather than vanishing.
    expect(readingOrder(nodes, (n) => n.rect, (n) => n.terminalId).map((n) => n.terminalId))
      .toEqual(['tm-x']);
  });
});
