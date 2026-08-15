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
