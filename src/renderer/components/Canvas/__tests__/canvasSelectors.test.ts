import {
  buildCanvasModel, counterScale, chipFontSize, chipLabelScreenPx, visibleNodeIds, allCollapsed,
  snapshotNodeIds, GROUP_CHIP_ZOOM, NODE_CHIP_ZOOM, CanvasNodeModel,
  labelScale, labelMaxWidth, MAX_LABEL_K, LABEL_LINE_H,
} from '../canvasSelectors';
import {
  NODE_W, NODE_H, CHIP_H, Z_MIN, T_CHIP, MIN_TITLE_PX, LodTier, Viewport, DEFAULT_METRICS,
  baseTier, clampZoom,
} from '../canvasGeometry';

import { PAD, PAD_TOP, GROUP_GAP, FRAME_ROW_MAX_W } from '../canvasLayout';

// Per-session now — these are an ordinary 1080p display's metrics.
const { zMax: Z_MAX } = DEFAULT_METRICS;

const stateWith = (overrides: any = {}) => ({
  tabs: {
    tabs: [
      { id: 'tb-a', title: 'api', shellType: 'zsh', isActive: true, isRunning: true },
      { id: 'tb-b', title: 'web', shellType: 'zsh', isActive: false },
    ],
    activeTabId: 'tb-a',
    // Per-terminal truth (Req 8, plan/020 §2): tb-a's tab-level isRunning above is true, but
    // only ONE of its two panes ('tm-2') is actually the busy one — the shape the acceptance
    // test below pins.
    runningTerminalIds: ['tm-2'],
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

  /**
   * ...and the other half of that pair (`plan/024` Req 5). `groupTitle` is the group's name, a
   * group is a tab, so it is `Tab.title` — the very value the case above proves `title` is NOT.
   *
   * `tm-2` is the one that makes this fail on a hard-coded chip: its pane is named "server"
   * inside a tab titled "api", so a `groupTitle` wired to the wrong source reads "server" here
   * and the assertion below catches it. A node whose pane is unnamed falls back to the tab
   * title, which is why that case cannot carry this test on its own.
   */
  it('takes groupTitle from Tab.title — the value the node title deliberately is not', () => {
    const m = buildCanvasModel(stateWith());
    const n = m.nodes.find((x) => x.terminalId === 'tm-2')!;
    expect(n.groupTitle).toBe('api');
    expect(n.groupTitle).not.toBe(n.title);
    // A second tab, so the field cannot be one constant that happens to match the first.
    expect(m.nodes.find((x) => x.tabId === 'tb-b')!.groupTitle).toBe('web');
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

  // Req 8 (plan/020 §2): anyRunning is now "any MEMBER TERMINAL is running", not a copy of
  // tab.isRunning — strictly more accurate, same field. In this fixture only 'tm-2' (one of
  // tb-a's two panes) is in runningTerminalIds, and that alone is enough to mark the group.
  it('marks a group as running when any member terminal is running', () => {
    const m = buildCanvasModel(stateWith());
    expect(m.groups.find((g) => g.tabId === 'tb-a')!.anyRunning).toBe(true);
    expect(m.groups.find((g) => g.tabId === 'tb-b')!.anyRunning).toBe(false);
  });

  /**
   * **The acceptance test for Req 8** (plan/020 §2.3). Busy state used to be a tab fact fanned
   * out onto every pane node — a two-pane tab with only one pane busy showed BOTH nodes busy.
   * `RunningActivityTracker` already buffers output per-processId (per-pane); this pins that
   * `runningTerminalIds` reaches `CanvasNodeModel.isRunning` per-terminal while `tab.isRunning`
   * keeps its own, genuinely independent, tab-wide meaning — both true in the SAME model.
   */
  it('a two-pane tab with one busy pane: node A running, node B not, tab still running', () => {
    const m = buildCanvasModel(stateWith()); // tb-a has panes 'tb-a' (idle) and 'tm-2' (busy)
    const nodeA = m.nodes.find((n) => n.terminalId === 'tb-a')!; // the idle pane
    const nodeB = m.nodes.find((n) => n.terminalId === 'tm-2')!; // the busy pane
    expect(nodeB.isRunning).toBe(true);
    expect(nodeA.isRunning).toBe(false);
    // The tab header's own fact is untouched and true at the same time.
    const s = stateWith();
    expect(s.tabs.tabs.find((t: any) => t.id === 'tb-a').isRunning).toBe(true);
  });

  /**
   * `exited` is PER-TERMINAL — `plan/024` Req 4, and the reason a new slice was needed.
   *
   * The tab-level fact that already existed (`Tab.exited`) only flips once EVERY pane in the tab
   * has exited, so the case below — one dead pane beside a live one — is exactly the one it
   * cannot express, and a canvas node is a pane. This is the same split `isRunning` went through
   * in `plan/020` Req 8, and deliberately NOT the one `hasUnseenOutput` is still on.
   */
  it('marks only the terminal whose session ended, not its live sibling', () => {
    const s = stateWith();
    s.sessionExit = { byTerminalId: { 'tm-2': { exitCode: 0 } } };
    const m = buildCanvasModel(s);
    expect(m.nodes.find((n) => n.terminalId === 'tm-2')!.exited).toBe(true);
    // Its sibling in the SAME tab is untouched — the assertion the tab-level flag fails.
    expect(m.nodes.find((n) => n.terminalId === 'tb-a')!.exited).toBe(false);
    expect(m.nodes.find((n) => n.terminalId === 'tb-b')!.exited).toBe(false);
  });

  // Exit code 0 is a real exit. A `!!info.exitCode` anywhere on this path would report a cleanly
  // finished shell as still running.
  it('treats a clean exit as exited', () => {
    const s = stateWith();
    s.sessionExit = { byTerminalId: { 'tb-b': { exitCode: 0 } } };
    expect(buildCanvasModel(s).nodes.find((n) => n.terminalId === 'tb-b')!.exited).toBe(true);
  });

  it('reports every node as live when nothing has exited', () => {
    expect(buildCanvasModel(stateWith()).nodes.every((n) => n.exited === false)).toBe(true);
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
    terminalId: id, tabId: 'tb-a', paneId: `pn-${id}`, title: id, shellType: 'zsh',
    rect: { x, y, w: NODE_W, h: NODE_H }, isRunning: false, hasUnseenOutput: false, groupTitle: 'Group', exited: false,
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
    terminalId: id, tabId: 'tb-a', paneId: `pn-${id}`, title: id, shellType: '',
    rect: { x: 0, y: 0, w: NODE_W, h: NODE_H }, isRunning: false, hasUnseenOutput: false, groupTitle: 'Group', exited: false,
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
    rect: { x: 0, y: 0, w: NODE_W, h: NODE_H }, isRunning: false, hasUnseenOutput: false, groupTitle: 'Group', exited: false,
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

/**
 * Frame seeding wraps into rows — `plan/024` Req 1, and the change that actually makes the
 * canvas denser.
 *
 * The cursor used to move only right, always at `y: 60`, so ten single-terminal tabs laid out as
 * a ~4600px strip one frame tall. Tightening the gutters moves that by a few percent; wrapping
 * it is what lets you zoom in far enough to read a terminal and still see its neighbours.
 */
describe('group frames wrap into rows', () => {
  /** N single-terminal tabs, nothing stored — the shape that produced the strip. */
  const manyTabs = (n: number) => {
    const tabs = Array.from({ length: n }, (_, i) => ({
      id: `tb-${i}`, title: `t${i}`, shellType: 'zsh', isActive: i === 0,
    }));
    const treesByTabId: Record<string, any> = {};
    for (let i = 0; i < n; i++) {
      treesByTabId[`tb-${i}`] = {
        id: `pn-${i}`, type: 'terminal', terminalId: `tb-${i}`, name: 'zsh', shellType: 'zsh',
      };
    }
    return {
      tabs: { tabs, activeTabId: 'tb-0', runningTerminalIds: [] },
      panes: { treesByTabId },
      canvas: { nodes: {}, groups: {} },
    } as any;
  };
  const framesOf = (state: any) => buildCanvasModel(state).groups
    .map((g) => ({ tabId: g.tabId, ...g.rect }));

  it('starts a second row instead of growing one endless strip', () => {
    const frames = framesOf(manyTabs(10));
    const rows = new Set(frames.map((f) => f.y));
    expect(rows.size).toBeGreaterThan(1);

    // ...and the strip is genuinely gone: the bounding box is no longer wildly wide.
    const right = Math.max(...frames.map((f) => f.x + f.w));
    const bottom = Math.max(...frames.map((f) => f.y + f.h));
    expect(right / bottom).toBeLessThan(4);
  });

  /**
   * Asserted as a CONCRETE row length, not against `FRAME_ROW_MAX_W`.
   *
   * Comparing `f.x - left <= FRAME_ROW_MAX_W` reads well and proves nothing: the constant is the
   * very thing under test, so widening it (to `Infinity`, say) moves the code and the assertion
   * together and the case stays green on a canvas that never wraps at all. The budget is four
   * default frames wide, so four is what a row of default frames must hold.
   */
  it('fits four default frames per row and no more', () => {
    const frames = framesOf(manyTabs(10));
    const perRow = new Map<number, number>();
    for (const f of frames) perRow.set(f.y, (perRow.get(f.y) ?? 0) + 1);
    for (const [, count] of perRow) expect(count).toBeLessThanOrEqual(4);
    // Paired positive: a budget so tight that every frame got its own row would satisfy the
    // ceiling above while being just as unusable as the strip it replaced.
    expect(Math.max(...perRow.values())).toBe(4);
    // And the constant really is the four-frame budget it claims to be.
    expect(FRAME_ROW_MAX_W).toBe(4 * (PAD * 2 + NODE_W) + 3 * GROUP_GAP);
  });

  /**
   * The property that ruled out `ceil(sqrt(n))` columns (`plan/024` D2). Frame rects are DERIVED
   * on every build, so a column count computed from the total would re-flow the whole canvas the
   * moment the tab count crossed a boundary. `design/010` §6.4 forbids that outright: a canvas
   * that rearranges itself while you are looking away destroys the spatial memory it exists for.
   *
   * Swept across the boundary rather than tested at one N, since a sqrt-grid is stable at most
   * counts and only jumps at the ones that change the column count.
   */
  it('never moves a frame already placed when a tab is appended', () => {
    for (let n = 1; n < 14; n++) {
      const before = framesOf(manyTabs(n));
      const after = framesOf(manyTabs(n + 1));
      for (const f of before) {
        const same = after.find((g) => g.tabId === f.tabId)!;
        expect({ tabId: same.tabId, x: same.x, y: same.y })
          .toEqual({ tabId: f.tabId, x: f.x, y: f.y });
      }
    }
  });

  /**
   * The row-height hazard. The cursor advances on the box a frame was SEEDED from, but the frame
   * that lands on screen is shrink-wrapped from its nodes — and a tab with several panes grids
   * taller than the single-node default. Advancing on the seed box let a tall frame reach
   * straight through the row beneath it.
   */
  it('does not let a multi-pane frame overlap the row below', () => {
    const state = manyTabs(12);
    // Give one tab in the first row four panes, so its frame is 2x2 and much taller.
    state.panes.treesByTabId['tb-1'] = {
      id: 'pn-x', type: 'split', direction: 'horizontal',
      children: Array.from({ length: 4 }, (_, i) => ({
        id: `pn-x${i}`, type: 'terminal', terminalId: `tm-x${i}`, name: 'p', shellType: 'zsh',
      })),
    };
    const frames = framesOf(state);
    const tall = frames.find((f) => f.tabId === 'tb-1')!;
    // Precondition: it really is taller than a default frame, or this proves nothing.
    expect(tall.h).toBeGreaterThan(frames.find((f) => f.tabId === 'tb-0')!.h);

    for (const a of frames) {
      for (const b of frames) {
        if (a.tabId === b.tabId) continue;
        const overlaps = !(a.x + a.w <= b.x || b.x + b.w <= a.x
          || a.y + a.h <= b.y || b.y + b.h <= a.y);
        expect({ pair: `${a.tabId}/${b.tabId}`, overlaps }).toEqual({ pair: `${a.tabId}/${b.tabId}`, overlaps: false });
      }
    }
  });

  // A dragged frame is somewhere the user chose. Seeding must go around it, exactly as the
  // single-row cursor did.
  it('honours a stored frame rect and seeds clear of it', () => {
    const state = manyTabs(3);
    state.canvas.groups = { 'tb-0': { x: 4000, y: 4000, w: 372, h: 249 } };
    const frames = framesOf(state);
    const stored = frames.find((f) => f.tabId === 'tb-0')!;
    // A single-node group shrink-wraps to its node, which was seeded inside the stored frame —
    // so the frame stays where the user dragged it rather than being re-seeded into a row.
    expect(stored.x).toBeGreaterThanOrEqual(4000);
    expect(stored.y).toBeGreaterThanOrEqual(4000);
    // What the seeded frames owe it is only that they do not land on top of it. Which SIDE they
    // end up on is `rowStartX`'s business (it clears stored frames to the right), and asserting
    // a side here would pin an implementation detail rather than the requirement.
    for (const f of frames) {
      if (f.tabId === 'tb-0') continue;
      const overlaps = !(f.x + f.w <= stored.x || stored.x + stored.w <= f.x
        || f.y + f.h <= stored.y || stored.y + stored.h <= f.y);
      expect({ tabId: f.tabId, overlaps }).toEqual({ tabId: f.tabId, overlaps: false });
    }
  });

  // A four-pane tab seeds as a grid, not the 1-wide column the fixed default box produced.
  it('seeds a multi-pane tab as a grid rather than a vertical column', () => {
    const state = manyTabs(1);
    state.panes.treesByTabId['tb-0'] = {
      id: 'pn-x', type: 'split', direction: 'horizontal',
      children: Array.from({ length: 4 }, (_, i) => ({
        id: `pn-x${i}`, type: 'terminal', terminalId: `tm-x${i}`, name: 'p', shellType: 'zsh',
      })),
    };
    const m = buildCanvasModel(state);
    const xs = new Set(m.nodes.map((n) => n.rect.x));
    const ys = new Set(m.nodes.map((n) => n.rect.y));
    expect(xs.size).toBe(2);
    expect(ys.size).toBe(2);
  });
});
