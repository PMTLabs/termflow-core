/**
 * @jest-environment jsdom
 *
 * Blast-radius review 092 B1. `sanitizeLayoutData` calls `sanitizeNode` TWICE
 * over the same logical tree -- once inside the `tabPanes` loop (whose output
 * IS what `restoreTabPanesInPlace` actually restores), once standalone over
 * `paneTree` (whose output `restoreState` never dispatches). For a legacy leaf
 * id, each pass independently mints a DIFFERENT fresh `tm-*` id; without a
 * guard on `terminalIdMap`, whichever pass runs second overwrites the first
 * pass's (real, restored) mapping with its own throwaway one, and `remapCwds`
 * then re-keys the cwd onto an id no restored pane carries. This exercises
 * `sanitizeLayoutData` itself -- the pure `remapCwds` unit tests cannot see
 * this double-`sanitizeNode` collision.
 */
jest.mock('../../components/TerminalContainer', () => ({ clearTabPanes: jest.fn() }));
jest.mock('../../utils/id', () => {
  let n = 0;
  // Deterministic but DISTINCT per call — mirrors what real (random)
  // `generateId` also does across the two independent `sanitizeNode` passes,
  // without relying on randomness to prove the point.
  return { generateId: jest.fn((prefix: string) => `${prefix}-regen${++n}`) };
});

import { StateManager } from '../StateManager';

describe('sanitizeLayoutData (end-to-end, review 092 B1)', () => {
  it('keeps terminalCwds keyed by the id the RESTORED pane tree actually carries', () => {
    // A pre-P0-A collided leaf: neither tb- nor tm- prefixed, so sanitizeNode
    // regenerates it on both passes.
    const legacyLeaf = { type: 'terminal', id: 'pn-existing1', terminalId: 'legacy-collided-id' };
    const raw = {
      tabs: [{ id: 'tb-mytab001' }],
      activeTabId: 'tb-mytab001',
      activePaneId: 'pn-existing1',
      // Separate object copies, as they are after a JSON round-trip through
      // localStorage — same logical tree, exactly as saveState persists it.
      paneTree: JSON.parse(JSON.stringify(legacyLeaf)),
      tabPanes: { 'tb-mytab001': JSON.parse(JSON.stringify(legacyLeaf)) },
      terminalCwds: { 'legacy-collided-id': 'D:\\work' },
    };

    const result = (StateManager as any).sanitizeLayoutData(raw);

    // Whatever id restoreTabPanesInPlace will actually restore the pane
    // under — NOT the throwaway id the standalone paneTree pass produced.
    const restoredId = result.tabPanes['tb-mytab001'].terminalId;
    expect(Object.keys(result.terminalCwds)).toEqual([restoredId]);
    expect(result.terminalCwds[restoredId]).toBe('D:\\work');
  });
});

/**
 * Design 014 §A4 — migrating a pre-014 tab whose ROOT pane carried the tab's own
 * `tb-` id as its leaf. That equality is why a field labelled "Terminal ID"
 * showed a `tb-`, and why an agent in a two-pane tab could not say which
 * terminal it meant.
 */
describe('sanitizeLayoutData — pre-014 root leaf migration', () => {
  const legacyTab = () => ({
    tabs: [{ id: 'tb-mytab001' }],
    activeTabId: 'tb-mytab001',
    activePaneId: 'pn-root1',
    paneTree: null,
    tabPanes: {
      'tb-mytab001': { type: 'terminal', id: 'pn-root1', terminalId: 'tb-mytab001' },
    },
    terminalCwds: { 'tb-mytab001': 'D:\work' },
  });

  it('rewrites the root leaf to a fresh tm-', () => {
    const out = (StateManager as any).sanitizeLayoutData(legacyTab());
    const leaf = out.tabPanes['tb-mytab001'].terminalId;
    expect(leaf).toMatch(/^tm-/);
    expect(leaf).not.toBe('tb-mytab001');
  });

  // The pty-host still knows this session by the OLD id and its protocol has no
  // rename verb, so losing this orphans an already-armed session.
  it('keeps the old id as the sessionKey', () => {
    const out = (StateManager as any).sanitizeLayoutData(legacyTab());
    expect(out.tabPanes['tb-mytab001'].sessionKey).toBe('tb-mytab001');
  });

  // The ownership the id equality used to imply, which tabTreeSeed Rule 3 and
  // the duplicate-leaf tiebreak both depend on.
  it('records seededForTabId so ownership survives the rename', () => {
    const out = (StateManager as any).sanitizeLayoutData(legacyTab());
    expect(out.tabPanes['tb-mytab001'].seededForTabId).toBe('tb-mytab001');
  });

  it('re-keys terminalCwds onto the new leaf', () => {
    const out = (StateManager as any).sanitizeLayoutData(legacyTab());
    const leaf = out.tabPanes['tb-mytab001'].terminalId;
    expect(Object.keys(out.terminalCwds)).toEqual([leaf]);
    expect(out.terminalCwds[leaf]).toBe('D:\work');
  });

  it('reports the rename so the caller can move the scrollback row', () => {
    const renames = new Map<string, string>();
    const out = (StateManager as any).sanitizeLayoutData(legacyTab(), renames);
    const leaf = out.tabPanes['tb-mytab001'].terminalId;
    expect(renames.get('tb-mytab001')).toBe(leaf);
  });

  // A tm- leaf is already migrated. Re-minting it would orphan its history on
  // every single restore.
  it('leaves an already-migrated tm- leaf completely alone', () => {
    const raw = {
      tabs: [{ id: 'tb-mytab001' }],
      activeTabId: 'tb-mytab001',
      activePaneId: 'pn-root1',
      paneTree: null,
      tabPanes: {
        'tb-mytab001': {
          type: 'terminal', id: 'pn-root1', terminalId: 'tm-already01',
          sessionKey: 'tb-mytab001', seededForTabId: 'tb-mytab001',
        },
      },
      terminalCwds: { 'tm-already01': 'D:\work' },
    };
    const renames = new Map<string, string>();
    const out = (StateManager as any).sanitizeLayoutData(raw, renames);
    expect(out.tabPanes['tb-mytab001'].terminalId).toBe('tm-already01');
    expect(out.tabPanes['tb-mytab001'].sessionKey).toBe('tb-mytab001');
    expect(renames.size).toBe(0);
    expect(out.terminalCwds).toEqual({ 'tm-already01': 'D:\work' });
  });

  // A split pane's tm- sibling must not be disturbed by the root's migration.
  it('migrates only the root leaf of a split tab', () => {
    const raw = {
      tabs: [{ id: 'tb-split001' }],
      activeTabId: 'tb-split001',
      activePaneId: 'pn-a',
      paneTree: null,
      tabPanes: {
        'tb-split001': {
          type: 'split', id: 'pn-root', direction: 'horizontal', size: 50,
          children: [
            { type: 'terminal', id: 'pn-a', terminalId: 'tb-split001' },
            { type: 'terminal', id: 'pn-b', terminalId: 'tm-sibling1' },
          ],
        },
      },
      terminalCwds: {},
    };
    const renames = new Map<string, string>();
    const out = (StateManager as any).sanitizeLayoutData(raw, renames);
    const [rootPane, sibling] = out.tabPanes['tb-split001'].children;
    expect(rootPane.terminalId).toMatch(/^tm-/);
    expect(rootPane.sessionKey).toBe('tb-split001');
    expect(sibling.terminalId).toBe('tm-sibling1');
    expect(renames.size).toBe(1);
  });
});

/**
 * Design 014 migration coverage — the three shapes the narrow branches missed.
 *
 * The rule is now "a live leaf is a `tm-`, so anything else is pre-014 and migrates".
 * Each case below was silently skipped when the migration was keyed on
 * `terminalId === tabId` plus a legacy-tab-id remap. Found by agy in review 170
 * (finding 4).
 */
describe('sanitizeLayoutData migrates every pre-014 leaf shape', () => {
  const treeOf = (out: any, tabId: string) => out.tabPanes[tabId];

  /**
   * Scenario B — a pre-014 ROOT leaf that was dragged into another tab before the save.
   * `tb-1 !== tb-2`, so the equality never matched and the leaf stayed a `tb-`: a live
   * terminal in the one id space design 014 cleared, which prefix-strict consumers reject.
   */
  it('migrates a tb- root leaf that now lives in a DIFFERENT tab', () => {
    const out = (StateManager as any).sanitizeLayoutData({
      tabs: [{ id: 'tb-2', title: 'Two' }],
      tabPanes: { 'tb-2': { id: 'pn-x', type: 'terminal', terminalId: 'tb-1' } },
    });
    const leaf = treeOf(out, 'tb-2');
    expect(leaf.terminalId).toMatch(/^tm-/);
    expect(leaf.sessionKey).toBe('tb-1');
    // Born in tb-1, not in the tab it was dropped into.
    expect(leaf.seededForTabId).toBe('tb-1');
  });

  /**
   * Scenario C — a non-prefixed split leaf. It minted without consulting
   * `terminalIdMap`, and `sanitizeNode` runs twice, so the two passes disagreed.
   */
  it('gives a non-prefixed split leaf ONE id across both sanitize passes', () => {
    const out = (StateManager as any).sanitizeLayoutData({
      tabs: [{ id: 'tb-1', title: 'One' }],
      tabPanes: { 'tb-1': { id: 'pn-a', type: 'terminal', terminalId: 'legacy-split-9' } },
      paneTree: { id: 'pn-a', type: 'terminal', terminalId: 'legacy-split-9' },
    });
    expect(treeOf(out, 'tb-1').terminalId).toMatch(/^tm-/);
    expect(out.paneTree.terminalId).toBe(treeOf(out, 'tb-1').terminalId);
  });

  /** ...and it must NOT claim to own a tab. Only a real root leaf did. */
  it('does not invent an owner for a leaf that was never a tab id', () => {
    const out = (StateManager as any).sanitizeLayoutData({
      tabs: [{ id: 'tb-1', title: 'One' }],
      tabPanes: { 'tb-1': { id: 'pn-a', type: 'terminal', terminalId: 'legacy-split-9' } },
    });
    expect(treeOf(out, 'tb-1').seededForTabId).toBeUndefined();
  });

  /** An id already in the modern space is left completely alone — idempotency. */
  it('leaves a tm- leaf untouched, so re-running is a no-op', () => {
    const out = (StateManager as any).sanitizeLayoutData({
      tabs: [{ id: 'tb-1', title: 'One' }],
      tabPanes: {
        'tb-1': { id: 'pn-a', type: 'terminal', terminalId: 'tm-already01', sessionKey: 'tb-old' },
      },
    });
    const leaf = treeOf(out, 'tb-1');
    expect(leaf.terminalId).toBe('tm-already01');
    expect(leaf.sessionKey).toBe('tb-old');
  });
});
