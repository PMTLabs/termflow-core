import {
  buildCanvasModel, counterScale, chipFontSize, chipLabelScreenPx, visibleNodeIds, allCollapsed,
  snapshotNodeIds, GROUP_CHIP_ZOOM, NODE_CHIP_ZOOM, CanvasNodeModel,
  labelScale, labelMaxWidth, MAX_LABEL_K, LABEL_LINE_H,
} from '../canvasSelectors';
import {
  NODE_W, NODE_H, CHIP_H, Z_MIN, T_CHIP, MIN_TITLE_PX, LodTier, Viewport, DEFAULT_METRICS,
  baseTier, clampZoom,
} from '../canvasGeometry';

import { PAD, PAD_TOP } from '../canvasLayout';

// Per-session now — these are an ordinary 1080p display's metrics.
const { zMax: Z_MAX } = DEFAULT_METRICS;

const stateWith = (overrides: any = {}) => ({
  tabs: {
    tabs: [
      { id: 'tb-a', title: 'api', shellType: 'zsh', isActive: true, isRunning: true },
      { id: 'tb-b', title: 'web', shellType: 'zsh', isActive: false },
    ],
    activeTabId: 'tb-a',
  },
  panes: {
    treesByTabId: {
      'tb-a': {
        id: 'pn-1', type: 'split', direction: 'horizontal', children: [
          { id: 'pn-2', type: 'terminal', terminalId: 'tb-a', name: 'zsh', shellType: 'zsh' },
          { id: 'pn-3', type: 'terminal', terminalId: 'tm-2', name: 'server', shellType: 'zsh' },
        ],
      },
      'tb-b': { id: 'pn-4', type: 'terminal', terminalId: 'tb-b', name: 'vite', shellType: 'zsh' },
    },
  },
  canvas: { nodes: {}, groups: {}, ...overrides },
}) as any;

describe('buildCanvasModel', () => {
  it('produces one node per terminal across every tab', () => {
    const m = buildCanvasModel(stateWith());
    expect(m.nodes.map((n) => n.terminalId).sort()).toEqual(['tb-a', 'tb-b', 'tm-2']);
  });

  it('produces one group per tab, owning its terminals', () => {
    const m = buildCanvasModel(stateWith());
    const a = m.groups.find((g) => g.tabId === 'tb-a')!;
    expect(a.title).toBe('api');
    expect(a.nodeIds.sort()).toEqual(['tb-a', 'tm-2']);
  });

  it('takes the node title from PaneNode.name, not Tab.title', () => {
    const m = buildCanvasModel(stateWith());
    expect(m.nodes.find((n) => n.terminalId === 'tm-2')!.title).toBe('server');
    expect(m.nodes.find((n) => n.terminalId === 'tb-a')!.title).toBe('zsh');
  });

  it('seeds geometry for a terminal that has never been placed', () => {
    const m = buildCanvasModel(stateWith());
    for (const n of m.nodes) {
      expect(n.rect.w).toBe(NODE_W);
      expect(n.rect.h).toBe(NODE_H);
      expect(Number.isFinite(n.rect.x)).toBe(true);
      expect(Number.isFinite(n.rect.y)).toBe(true);
    }
  });

  it('is deterministic across two calls with the same state', () => {
    const s = stateWith();
    expect(buildCanvasModel(s)).toEqual(buildCanvasModel(s));
  });

  it('honours stored geometry over seeding', () => {
    const m = buildCanvasModel(stateWith({
      nodes: { 'tm-2': { x: 999, y: 777, w: NODE_W, h: NODE_H } },
    }));
    expect(m.nodes.find((n) => n.terminalId === 'tm-2')!.rect.x).toBe(999);
  });

  // Seeding runs in a SECOND pass, after every stored rect has been claimed. With a
  // single pass, the unplaced leaf at index 0 would be seeded against an empty
  // `taken` list and land exactly on top of the stored leaf at index 1 whenever that
  // one sits in the frame's first slot — the common case, since the first slot is
  // where the tab's original terminal was seeded.
  it('never seeds a new pane on top of a pane that already has geometry', () => {
    const first = { x: 60 + PAD, y: 60 + PAD_TOP, w: NODE_W, h: NODE_H };
    // 'tm-2' is the SECOND leaf but owns the first slot; 'tb-a' has to be seeded.
    const m = buildCanvasModel(stateWith({ nodes: { 'tm-2': first } }));
    const a = m.nodes.find((n) => n.terminalId === 'tb-a')!.rect;
    const overlaps =
      a.x < first.x + first.w && first.x < a.x + a.w &&
      a.y < first.y + first.h && first.y < a.y + a.h;
    expect(overlaps).toBe(false);
  });

  it('marks a group as running when any member tab is running', () => {
    const m = buildCanvasModel(stateWith());
    expect(m.groups.find((g) => g.tabId === 'tb-a')!.anyRunning).toBe(true);
    expect(m.groups.find((g) => g.tabId === 'tb-b')!.anyRunning).toBe(false);
  });

  it('ignores a tab with no pane tree and no stored frame instead of crashing', () => {
    const s = stateWith();
    s.tabs.tabs.push({ id: 'tb-ghost', title: 'ghost', shellType: 'zsh' });
    expect(() => buildCanvasModel(s)).not.toThrow();
    expect(buildCanvasModel(s).groups.find((g) => g.tabId === 'tb-ghost')).toBeUndefined();
  });

  it('keeps an emptied group as a drop target when it has a stored frame', () => {
    // Design §6.3/§10: dragging out the last terminal must not make the frame vanish.
    const s = stateWith({ groups: { 'tb-empty': { x: 10, y: 20, w: 400, h: 300 } } });
    s.tabs.tabs.push({ id: 'tb-empty', title: 'drained', shellType: 'zsh' });
    s.panes.treesByTabId['tb-empty'] = undefined;
    const g = buildCanvasModel(s).groups.find((x) => x.tabId === 'tb-empty')!;
    expect(g).toBeDefined();
    expect(g.nodeIds).toEqual([]);
    expect(g.rect).toEqual({ x: 10, y: 20, w: 400, h: 300 });
  });

  // A non-empty group's frame is derived, not stored. Pinning it here so the
  // asymmetry with the emptied-group case above is a documented decision rather
  // than a surprise for Task 12, which must move nodes rather than the frame.
  it('shrink-wraps a non-empty group rather than drawing its stored frame', () => {
    const s = stateWith({
      groups: { 'tb-b': { x: -5000, y: -5000, w: 12, h: 12 } },
      nodes: { 'tb-b': { x: 100, y: 200, w: NODE_W, h: NODE_H } },
    });
    const g = buildCanvasModel(s).groups.find((x) => x.tabId === 'tb-b')!;
    expect(g.rect).toEqual({
      x: 100 - PAD, y: 200 - PAD_TOP,
      w: NODE_W + PAD * 2, h: NODE_H + PAD_TOP + PAD,
    });
  });

  it('always encloses every one of its nodes', () => {
    const m = buildCanvasModel(stateWith({
      nodes: { 'tm-2': { x: 4000, y: -900, w: NODE_W, h: NODE_H } },
    }));
    const g = m.groups.find((x) => x.tabId === 'tb-a')!;
    for (const id of g.nodeIds) {
      const r = m.nodes.find((n) => n.terminalId === id)!.rect;
      expect(r.x).toBeGreaterThanOrEqual(g.rect.x);
      expect(r.y).toBeGreaterThanOrEqual(g.rect.y);
      expect(r.x + r.w).toBeLessThanOrEqual(g.rect.x + g.rect.w);
      expect(r.y + r.h).toBeLessThanOrEqual(g.rect.y + g.rect.h);
    }
  });

  it('gives two tabs without stored frames non-overlapping frames', () => {
    const m = buildCanvasModel(stateWith());
    const [a, b] = ['tb-a', 'tb-b'].map((id) => m.groups.find((g) => g.tabId === id)!.rect);
    const overlaps =
      a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    expect(overlaps).toBe(false);
  });
});

describe('counterScale', () => {
  // The whole point of a counter-scale is that the label's REAL size never changes.
  // Assert that product across the legal range instead of probing two zooms near 1,
  // which is what a clamp too tight to cover the range would sail through.
  it('holds a constant on-screen size at every legal zoom', () => {
    for (let z = Z_MIN; z <= Z_MAX; z += 0.017) {
      expect(counterScale(z, Z_MAX) * z).toBeCloseTo(1, 9);
    }
    expect(counterScale(Z_MAX, Z_MAX) * Z_MAX).toBeCloseTo(1, 9);
  });

  // Both probes must be zooms `clampZoom` can actually produce. z = 2 is NOT one —
  // it is above Z_MAX, so asserting counterScale(2, Z_MAX) === 0.5 only measures the guard.
  it('inverts the zoom at concrete legal values', () => {
    expect(counterScale(0.5, Z_MAX)).toBeCloseTo(2, 6);
    expect(counterScale(1.6, Z_MAX)).toBeCloseTo(0.625, 6);
  });

  // The clamp guards a degenerate zoom, so it must only bite OUTSIDE the range
  // `clampZoom` can produce — never inside it.
  it('clamps only what the viewport can never reach', () => {
    expect(counterScale(0, Z_MAX)).toBe(1 / Z_MIN);
    expect(counterScale(0.001, Z_MAX)).toBe(counterScale(Z_MIN, Z_MAX));
    expect(counterScale(1000, Z_MAX)).toBe(counterScale(Z_MAX, Z_MAX));
    expect(counterScale(clampZoom(0.001, Z_MAX), Z_MAX)).toBe(1 / Z_MIN);
  });
});

describe('chipFontSize', () => {
  it('never outgrows the chip box it has to fit inside', () => {
    for (let z = Z_MIN; z <= Z_MAX; z += 0.017) {
      expect(chipFontSize(z)).toBeLessThanOrEqual(CHIP_H);
    }
  });

  it('never collapses to nothing at high zoom', () => {
    expect(chipFontSize(Z_MAX)).toBeGreaterThanOrEqual(11);
    expect(chipFontSize(100)).toBeGreaterThanOrEqual(11);
  });

  it('grows as the canvas zooms out, until the chip box stops it', () => {
    expect(chipFontSize(0.9)).toBeGreaterThan(chipFontSize(1.4));
  });
});

describe('chip fly-to zooms', () => {
  // A cursor that promises an interaction has to deliver one. If either target
  // landed in the tier it flew FROM, clicking a chip would leave it a chip.
  it('lands a group chip\'s terminals in the snapshot tier', () => {
    expect(clampZoom(GROUP_CHIP_ZOOM, Z_MAX)).toBe(GROUP_CHIP_ZOOM);
    expect(baseTier(NODE_W * GROUP_CHIP_ZOOM)).toBe('snapshot');
  });

  it('lands a node chip in the gpu tier', () => {
    expect(clampZoom(NODE_CHIP_ZOOM, Z_MAX)).toBe(NODE_CHIP_ZOOM);
    expect(baseTier(NODE_W * NODE_CHIP_ZOOM)).toBe('gpu');
  });

  it('flies OUT of the chip tier in both cases', () => {
    expect(NODE_W * GROUP_CHIP_ZOOM).toBeGreaterThan(T_CHIP);
    expect(NODE_W * NODE_CHIP_ZOOM).toBeGreaterThan(T_CHIP);
  });
});

describe('visibleNodeIds', () => {
  const mk = (id: string, x: number, y: number): CanvasNodeModel => ({
    terminalId: id, tabId: 'tb-a', title: id, shellType: 'zsh',
    rect: { x, y, w: NODE_W, h: NODE_H }, isRunning: false, hasUnseenOutput: false,
  });
  const vp: Viewport = { x: 0, y: 0, z: 1 };

  it('keeps on-screen nodes and drops far-off ones', () => {
    const ids = visibleNodeIds([mk('a', 10, 10), mk('b', 9000, 9000)], vp, 800, 600);
    expect(ids.has('a')).toBe(true);
    expect(ids.has('b')).toBe(false);
  });

  it('returns nothing for an empty workspace rather than throwing', () => {
    expect(visibleNodeIds([], vp, 800, 600).size).toBe(0);
  });
});

/**
 * The group LABEL's counter-scale, capped.
 *
 * A label is a world-space element, so an uncapped counter-scale gives it an unbounded WORLD
 * footprint: at z=0.1 an "11px" label measures 110x900 world units against a frame 372 wide
 * with a 23-unit top band. That is the overlap reported on 2026-08-17 — the label of one group
 * printed across the frame of another. Nothing in a world layout can reserve space for it,
 * because the space it needs depends on the zoom.
 */
describe('labelScale', () => {
  it('is the plain counter-scale while that is small enough', () => {
    // Zoomed in, nothing is capped and the label holds its constant on-screen size.
    for (const z of [1.0, 0.8, 0.5]) {
      expect(labelScale(z, Z_MAX)).toBeCloseTo(counterScale(z, Z_MAX), 9);
      expect(labelScale(z, Z_MAX) * z).toBeCloseTo(1, 9);
    }
  });

  it('stops growing once the label fills the band it straddles', () => {
    // The cap is derived from the frame's top padding, not picked: the label may grow until
    // it spans that band above and below the border it sits on, and no further.
    expect(MAX_LABEL_K).toBeCloseTo((PAD_TOP * 2) / LABEL_LINE_H, 9);
    expect(labelScale(Z_MIN, Z_MAX)).toBe(MAX_LABEL_K);
    expect(labelScale(0.05, Z_MAX)).toBeLessThan(counterScale(0.05, Z_MAX));
  });

  /** The property the fix is FOR, asserted as a bound on world size rather than on the scale —
   *  the scale is the mechanism, the footprint is the promise. */
  it('keeps the label inside its own frame at every legal zoom', () => {
    for (let z = Z_MIN; z <= Z_MAX; z += 0.013) {
      const worldH = LABEL_LINE_H * labelScale(z, Z_MAX);
      expect(worldH).toBeLessThanOrEqual(PAD_TOP * 2 + 1e-9);
    }
  });

  it('never inverts — a lower zoom is never a smaller label', () => {
    let prev = 0;
    for (let z = Z_MAX; z >= Z_MIN; z -= 0.05) {
      const k = labelScale(z, Z_MAX);
      expect(k).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = k;
    }
  });
});

/**
 * The other axis. A scale ceiling cannot bound WIDTH — the text length does that — so a long
 * tab name would still reach the frame beside it however tightly the scale were capped.
 */
describe('labelMaxWidth', () => {
  it('renders no wider than the frame, whatever the scale', () => {
    for (const frameW of [200, 372, 900]) {
      for (const z of [Z_MIN, 0.1, 0.3, 1.0]) {
        const k = labelScale(z, Z_MAX);
        expect(labelMaxWidth(frameW, k) * k).toBeLessThanOrEqual(frameW);
      }
    }
  });

  it('leaves room for the inset rather than filling the frame edge to edge', () => {
    expect(labelMaxWidth(372, 1)).toBeLessThan(372);
  });

  it('never returns a negative width for a frame narrower than the inset', () => {
    // A frame can be dragged very small; a negative max-width is a CSS error, not a clamp.
    expect(labelMaxWidth(10, 1)).toBeGreaterThanOrEqual(0);
    expect(labelMaxWidth(0, 3)).toBeGreaterThanOrEqual(0);
  });
});

describe('allCollapsed', () => {
  const n = (id: string): CanvasNodeModel => ({
    terminalId: id, tabId: 'tb-a', title: id, shellType: '',
    rect: { x: 0, y: 0, w: NODE_W, h: NODE_H }, isRunning: false, hasUnseenOutput: false,
  });
  const tiers = (m: Record<string, LodTier>) => m;

  /** A zoom where a node chip's own label is comfortably legible, and one where it is not.
   *  Derived from the function itself, so moving `chipFontSize` or `MIN_TITLE_PX` moves these
   *  with it instead of leaving two hard-coded numbers to rot. */
  const Z_LEGIBLE = 0.28;
  const Z_TINY = 0.14;

  it('found zooms that actually straddle the legibility floor', () => {
    // Without this the whole describe can pass vacuously with both constants on one side.
    expect(chipLabelScreenPx(Z_LEGIBLE)).toBeGreaterThanOrEqual(MIN_TITLE_PX);
    expect(chipLabelScreenPx(Z_TINY)).toBeLessThan(MIN_TITLE_PX);
  });

  it('is true when every node is at group tier, at any zoom', () => {
    expect(allCollapsed([n('a'), n('b')], tiers({ a: 'group', b: 'group' }), Z_LEGIBLE)).toBe(true);
    expect(allCollapsed([n('a'), n('b')], tiers({ a: 'group', b: 'group' }), Z_TINY)).toBe(true);
  });

  /**
   * The band that had no readable rendering at all — reported 2026-08-17 as "in the ladder of
   * zooming, it is too small".
   *
   * A node CHIP's label is bounded by the chip box, which does not counter-scale, so across
   * the lower chip band it lands at 6.5–11 screen pixels. The group chip is the documented
   * readable alternative and it was only shown one tier further out, so between those two
   * points nothing on screen could be read. Collapsing on the legibility floor rather than on
   * the tier name closes it: above the floor a node names itself, below it its group does.
   */
  it('collapses a chip-tier workspace only once node labels stop being legible', () => {
    expect(allCollapsed([n('a'), n('b')], tiers({ a: 'chip', b: 'chip' }), Z_TINY)).toBe(true);
    expect(allCollapsed([n('a'), n('b')], tiers({ a: 'chip', b: 'chip' }), Z_LEGIBLE)).toBe(false);
  });

  it('collapses a mixed group/chip workspace on the same rule', () => {
    expect(allCollapsed([n('a'), n('b')], tiers({ a: 'group', b: 'chip' }), Z_TINY)).toBe(true);
    expect(allCollapsed([n('a'), n('b')], tiers({ a: 'group', b: 'chip' }), Z_LEGIBLE)).toBe(false);
  });

  // D8 forces a focused node to `gpu` at any zoom, so a focused workspace is never
  // fully collapsed — collapsing it anyway would hide the one node taking keystrokes.
  // Unchanged by the legibility rule, and that is the point of asserting it at BOTH zooms:
  // an interactive node is exempt because of what it is, not because of how big it is.
  it('is false while one node is held interactive', () => {
    expect(allCollapsed([n('a'), n('b')], tiers({ a: 'group', b: 'gpu' }), Z_LEGIBLE)).toBe(false);
    expect(allCollapsed([n('a'), n('b')], tiers({ a: 'group', b: 'gpu' }), Z_TINY)).toBe(false);
    expect(allCollapsed([n('a'), n('b')], tiers({ a: 'chip', b: 'live' }), Z_TINY)).toBe(false);
  });

  it('is false for an empty workspace', () => {
    expect(allCollapsed([], tiers({}), Z_TINY)).toBe(false);
  });
});

/**
 * The legibility number the collapse rule is built on.
 *
 * Split out because it is the bridge between two things that must not drift: what a node chip
 * actually renders, and the floor every other tier is held to by `headFontSize`.
 */
describe('chipLabelScreenPx', () => {
  it('reports what the chip label really lands at, in screen pixels', () => {
    // The chip box does NOT counter-scale, so this shrinks with the zoom — which is the whole
    // reason the tier can become unreadable while everything else holds 11px.
    expect(chipLabelScreenPx(0.14)).toBeCloseTo(chipFontSize(0.14) * 0.14, 6);
    expect(chipLabelScreenPx(0.14)).toBeLessThan(chipLabelScreenPx(0.28));
  });

  it('measured: the lower chip band really is below the floor', () => {
    // The evidence behind the report. If these ever come out above MIN_TITLE_PX, the collapse
    // rule has become dead code and should be revisited rather than left in.
    expect(chipLabelScreenPx(0.14)).toBeLessThan(MIN_TITLE_PX);
    expect(chipLabelScreenPx(0.20)).toBeLessThan(MIN_TITLE_PX);
    expect(chipLabelScreenPx(0.28)).toBeGreaterThanOrEqual(MIN_TITLE_PX);
  });
});

/**
 * `snapshotNodeIds` — the culling rule for the snapshot tier (`plan/013` Task 10).
 *
 * Extracted from `CanvasMode`'s JSX precisely so it can be tested: `CanvasMode` cannot be
 * mounted under the root Jest config, so a rule expressed only there is a rule nothing checks.
 * What it protects is a resource leak rather than a wrong pixel — every id this returns mounts a
 * component owning a 500 ms timer, for as long as it keeps returning it.
 */
describe('snapshotNodeIds', () => {
  const n = (id: string): CanvasNodeModel => ({
    terminalId: id, tabId: 'tb-a', paneId: `pn-${id}`, title: id, shellType: '',
    rect: { x: 0, y: 0, w: NODE_W, h: NODE_H }, isRunning: false, hasUnseenOutput: false,
  });
  const nodes = [n('a'), n('b'), n('c')];
  const all = new Set(['a', 'b', 'c']);

  it('picks the nodes at the snapshot tier', () => {
    const got = snapshotNodeIds(nodes, { a: 'snapshot', b: 'gpu', c: 'snapshot' }, all, false);
    expect([...got].sort()).toEqual(['a', 'c']);
  });

  // THE one that matters. `assignTiers` labels an OFF-SCREEN node `snapshot` rather than
  // omitting it, so tier alone would mount a polling loop for every terminal in the workspace
  // for the whole session -- and `evictAllBut` cannot undo it, because a mounted component
  // refills the cache on its next tick.
  it('excludes off-screen nodes, even though their tier says snapshot', () => {
    const visible = new Set(['a']);
    const got = snapshotNodeIds(nodes, { a: 'snapshot', b: 'snapshot', c: 'snapshot' }, visible, false);
    expect([...got]).toEqual(['a']);
  });

  it('returns nothing when the whole workspace has collapsed to chips', () => {
    expect(snapshotNodeIds(nodes, { a: 'snapshot', b: 'snapshot', c: 'snapshot' }, all, true).size)
      .toBe(0);
  });

  // The paired positive for each negative above: without these, a function that returned the
  // empty set unconditionally would satisfy every exclusion test here.
  it('does return something when nothing excludes it', () => {
    expect(snapshotNodeIds(nodes, { a: 'snapshot', b: 'snapshot', c: 'snapshot' }, all, false).size)
      .toBe(3);
  });

  it('excludes every tier that is not snapshot', () => {
    for (const tier of ['gpu', 'live', 'chip', 'group'] as LodTier[]) {
      expect(snapshotNodeIds([n('a')], { a: tier }, new Set(['a']), false).size).toBe(0);
    }
    expect(snapshotNodeIds([n('a')], { a: 'snapshot' }, new Set(['a']), false).size).toBe(1);
  });

  it('tolerates a node with no tier assigned', () => {
    expect(snapshotNodeIds([n('a')], {}, new Set(['a']), false).size).toBe(0);
  });

  it('returns nothing for an empty workspace rather than throwing', () => {
    expect(snapshotNodeIds([], {}, new Set(), false).size).toBe(0);
  });
});

/**
 * The canvas projects TABS into group frames, and not every tab is a workspace. Settings
 * and the canvas tab itself are screens: they own no pane tree, so they fall into the
 * leaf-less branch — and that branch keeps drawing a frame for anything with a stored
 * rect, so a stale geometry entry puts an empty group on the canvas and the canvas draws
 * a frame for itself.
 */
describe('buildCanvasModel — virtual tabs are not workspaces', () => {
  const withScreens = () => {
    const s = stateWith();
    s.tabs.tabs.push(
      { id: 'tb-settings', title: 'Settings', shellType: 'settings', isActive: false },
      { id: 'tb-canvas', title: 'Canvas', shellType: 'canvas', isActive: false },
    );
    return s;
  };

  it('draws no group for a settings or canvas tab', () => {
    const m = buildCanvasModel(withScreens());
    expect(m.groups.map((g) => g.tabId).sort()).toEqual(['tb-a', 'tb-b']);
    expect(m.nodes.map((n) => n.tabId)).not.toContain('tb-canvas');
  });

  // The teeth: a stored rect is exactly what the leaf-less branch acts on, so without the
  // skip this is the case that puts a phantom frame on the canvas. Asserted separately
  // from the case above, which would pass on the "no tree" accident alone.
  it('draws no group even when one has a stored rect from an earlier session', () => {
    const s = withScreens();
    s.canvas.groups = {
      'tb-canvas': { x: 0, y: 0, w: 400, h: 300 },
      'tb-settings': { x: 500, y: 0, w: 400, h: 300 },
    };
    const m = buildCanvasModel(s);
    expect(m.groups.map((g) => g.tabId).sort()).toEqual(['tb-a', 'tb-b']);
  });
});

/**
 * `paneId` is what "open in its tab" puts the cursor on. A node knows its TAB from the
 * projection loop, but a split tab has several panes and landing on the wrong one is
 * invisible until you type into it.
 */
describe('buildCanvasModel — every node carries its pane', () => {
  it('carries the pane leaf id, distinct per node within one tab', () => {
    const m = buildCanvasModel(stateWith());
    const byTerminal = Object.fromEntries(m.nodes.map((n) => [n.terminalId, n.paneId]));
    expect(byTerminal).toEqual({ 'tb-a': 'pn-2', 'tm-2': 'pn-3', 'tb-b': 'pn-4' });
    // Not the terminalId under another name, and not the tab's id: on the solo-root tab
    // 'tb-b' those two are equal to each other but must both differ from the pane.
    expect(byTerminal['tb-b']).not.toBe('tb-b');
  });
});
