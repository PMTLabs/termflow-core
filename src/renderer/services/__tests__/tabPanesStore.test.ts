import { clearTabPanesInPlace, restoreTabPanesInPlace, getTabPanesGlobal } from '../tabPanesStore';

// Regression coverage for the "scrollback never recovers after restart" bug.
// TerminalContainer.tsx holds a module-scoped binding to window.__TAB_PANES__ and
// reads/writes it directly. The old restore path REPLACED that object
// (`window.__TAB_PANES__ = {}`), diverging the references so restored pane trees
// became invisible and every restored terminal spawned under a fresh id (history
// key miss). These helpers must mutate the SAME object in place.
describe('tabPanesStore (reference-preserving pane map)', () => {
  let savedWindow: any;
  beforeEach(() => {
    savedWindow = (globalThis as any).window;
    (globalThis as any).window = {};
  });
  afterEach(() => {
    (globalThis as any).window = savedWindow;
  });

  test('getTabPanesGlobal creates and aliases __TAB_PANES__ and tabPanes to one object', () => {
    const t = getTabPanesGlobal();
    const w = (globalThis as any).window;
    expect(w.__TAB_PANES__).toBe(t);
    expect(w.tabPanes).toBe(t);
  });

  test('restoreTabPanesInPlace preserves the existing reference and merges saved trees', () => {
    const w = (globalThis as any).window;
    const shared: any = {};
    w.__TAB_PANES__ = shared;
    w.tabPanes = shared;
    restoreTabPanesInPlace({ 'tb-1': { id: 'pn-1', type: 'terminal', terminalId: 'tb-1' } });
    expect(w.__TAB_PANES__).toBe(shared); // SAME reference — the bug was replacing it
    expect(w.tabPanes).toBe(shared);
    expect(shared['tb-1']).toEqual({ id: 'pn-1', type: 'terminal', terminalId: 'tb-1' });
  });

  test('restore drops stale entries before merging', () => {
    const w = (globalThis as any).window;
    const shared: any = { stale: { id: 'old' } };
    w.__TAB_PANES__ = shared;
    w.tabPanes = shared;
    restoreTabPanesInPlace({ fresh: { id: 'new' } });
    expect(w.__TAB_PANES__).toBe(shared);
    expect(Object.keys(shared)).toEqual(['fresh']);
  });

  test('clearTabPanesInPlace empties without replacing the reference', () => {
    const w = (globalThis as any).window;
    const shared: any = { a: {}, b: {} };
    w.__TAB_PANES__ = shared;
    w.tabPanes = shared;
    clearTabPanesInPlace();
    expect(w.__TAB_PANES__).toBe(shared);
    expect(Object.keys(shared)).toEqual([]);
  });
});
