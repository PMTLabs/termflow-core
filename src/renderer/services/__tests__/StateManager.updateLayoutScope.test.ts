/**
 * @jest-environment jsdom
 *
 * Two hand-fixed bugs, neither landed with a regression test:
 *
 * (a) `StateManager.updateLayout` used to re-capture the WHOLE workspace
 * regardless of the layout's own scope, while `scope: 'tab'` survived the
 * object spread — producing a layout that CLAIMS to be one tab (`scope:
 * 'tab'`) but CARRIES every tab (`tabs`/`treesByTabId` for the whole
 * workspace). The fix routes both `saveLayout` and `updateLayout` through the
 * shared `buildLayoutBody` (see its own comment in StateManager.ts for the
 * drift history).
 *
 * (b) `loadTabScopedLayout`'s collision guard re-mints a terminal id that is
 * live in a DIFFERENT tab (`findTabIdByTerminalId` only ever returns the
 * FIRST match), and the saved `terminalCwds` must be re-keyed onto that fresh
 * id — seeding it under the OLD id would strand the directory somewhere
 * nothing reads it from, or (worse, if the old id happens to already have a
 * live entry) silently pollute an unrelated terminal's cwd.
 *
 * Mocking/setup mirrors `StateManager.tabScopedLayout.test.ts`: only
 * `TerminalContainer` is mocked (it drags in a whole React tree for one
 * export); `cwdSnapshot` is left REAL so `getCwdSnapshot`/`__resetCwdSnapshots`
 * observe the same module the production code writes through.
 */
jest.mock('../../components/TerminalContainer', () => ({ clearTabPanes: jest.fn() }));

import { configureStore } from '@reduxjs/toolkit';
import tabsReducer from '../../store/slices/tabsSlice';
import panesReducer from '../../store/slices/panesSlice';
import canvasReducer from '../../store/slices/canvasSlice';
import { StateManager, SavedLayout } from '../StateManager';
import { getCwdSnapshot, __resetCwdSnapshots } from '../cwdSnapshot';

function makeStore() {
  return configureStore({
    reducer: { tabs: tabsReducer, panes: panesReducer, canvas: canvasReducer },
  });
}

function seedLayouts(layouts: SavedLayout[]) {
  localStorage.setItem('auto-terminal-layouts', JSON.stringify(layouts));
}

describe('StateManager.updateLayout scope (bug fix regression)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('scope "tab": re-captures ONLY the scoped tab, with its CURRENT tree, leaving an unrelated tab out entirely', async () => {
    const store = makeStore();
    (window as any).__REDUX_STORE__ = store;

    const treeAOld = { id: 'pn-a-old', type: 'terminal' as const, terminalId: 'tm-a-old' };
    store.dispatch({ type: 'tabs/addTab', payload: { id: 'tb-a', title: 'A' } });
    store.dispatch({ type: 'panes/addTabTree', payload: { tabId: 'tb-a', tree: treeAOld } });

    // An unrelated tab, present in the LIVE workspace but not part of this
    // tab-scoped layout — it must never appear in the re-captured body.
    const treeB = { id: 'pn-b', type: 'terminal' as const, terminalId: 'tm-b' };
    store.dispatch({ type: 'tabs/addTab', payload: { id: 'tb-b', title: 'B' } });
    store.dispatch({ type: 'panes/addTabTree', payload: { tabId: 'tb-b', tree: treeB } });

    seedLayouts([{
      id: 'layout-tab-a',
      name: 'Tab A',
      tabs: [{ id: 'tb-a', title: 'A' }],
      activeTabId: 'tb-a',
      paneTree: treeAOld,
      activePaneId: 'pn-a-old',
      treesByTabId: { 'tb-a': treeAOld },
      scope: 'tab',
      scopedTabId: 'tb-a',
      createdAt: 1,
      updatedAt: 1,
    } as SavedLayout]);

    // The tab's tree changes AFTER the save — proves "update" re-captures the
    // CURRENT tree rather than being a no-op that just bumps updatedAt.
    const treeANew = { id: 'pn-a-new', type: 'terminal' as const, terminalId: 'tm-a-new' };
    store.dispatch({ type: 'panes/addTabTree', payload: { tabId: 'tb-a', tree: treeANew } });

    const ok = await StateManager.updateLayout('layout-tab-a');
    expect(ok).toBe(true);

    const saved = StateManager.getSavedLayouts().find(l => l.id === 'layout-tab-a')!;
    expect(saved.scope).toBe('tab');
    expect(saved.scopedTabId).toBe('tb-a');
    // Exactly one tab, not the whole two-tab workspace.
    expect(saved.tabs.map((t: any) => t.id)).toEqual(['tb-a']);
    expect(Object.keys(saved.treesByTabId!)).toEqual(['tb-a']);
    // The CURRENT tree, not the stale one from the original save.
    expect(saved.treesByTabId!['tb-a']).toEqual(treeANew);
    expect(saved.paneTree).toEqual(treeANew);
    // The unrelated tab never leaks in.
    expect(saved.tabs.some((t: any) => t.id === 'tb-b')).toBe(false);
    expect(saved.treesByTabId).not.toHaveProperty('tb-b');
  });

  it('scope "workspace": still re-captures every tab currently open, including one added since the layout was last saved', async () => {
    const store = makeStore();
    (window as any).__REDUX_STORE__ = store;

    const treeA = { id: 'pn-a', type: 'terminal' as const, terminalId: 'tm-a' };
    store.dispatch({ type: 'tabs/addTab', payload: { id: 'tb-a', title: 'A' } });
    store.dispatch({ type: 'panes/addTabTree', payload: { tabId: 'tb-a', tree: treeA } });

    // Saved originally with only tb-a...
    seedLayouts([{
      id: 'layout-workspace',
      name: 'Workspace',
      tabs: [{ id: 'tb-a', title: 'A' }],
      activeTabId: 'tb-a',
      paneTree: treeA,
      activePaneId: 'pn-a',
      treesByTabId: { 'tb-a': treeA },
      scope: 'workspace',
      createdAt: 1,
      updatedAt: 1,
    } as SavedLayout]);

    // ...but tb-b was added to the LIVE workspace afterwards.
    const treeB = { id: 'pn-b', type: 'terminal' as const, terminalId: 'tm-b' };
    store.dispatch({ type: 'tabs/addTab', payload: { id: 'tb-b', title: 'B' } });
    store.dispatch({ type: 'panes/addTabTree', payload: { tabId: 'tb-b', tree: treeB } });

    const ok = await StateManager.updateLayout('layout-workspace');
    expect(ok).toBe(true);

    const saved = StateManager.getSavedLayouts().find(l => l.id === 'layout-workspace')!;
    expect(saved.tabs.map((t: any) => t.id).sort()).toEqual(['tb-a', 'tb-b']);
    expect(Object.keys(saved.treesByTabId!).sort()).toEqual(['tb-a', 'tb-b']);
  });

  it('legacy layout with NO scope field at all: updateLayout still treats it as workspace-scope and captures every tab', async () => {
    const store = makeStore();
    (window as any).__REDUX_STORE__ = store;

    const treeA = { id: 'pn-a', type: 'terminal' as const, terminalId: 'tm-a' };
    store.dispatch({ type: 'tabs/addTab', payload: { id: 'tb-a', title: 'A' } });
    store.dispatch({ type: 'panes/addTabTree', payload: { tabId: 'tb-a', tree: treeA } });
    const treeB = { id: 'pn-b', type: 'terminal' as const, terminalId: 'tm-b' };
    store.dispatch({ type: 'tabs/addTab', payload: { id: 'tb-b', title: 'B' } });
    store.dispatch({ type: 'panes/addTabTree', payload: { tabId: 'tb-b', tree: treeB } });

    // A layout saved before `scope` existed — the field is entirely absent,
    // not just `undefined`-valued.
    const legacyLayout: any = {
      id: 'layout-legacy',
      name: 'Legacy',
      tabs: [{ id: 'tb-a', title: 'A' }],
      activeTabId: 'tb-a',
      paneTree: treeA,
      activePaneId: 'pn-a',
      treesByTabId: { 'tb-a': treeA },
      createdAt: 1,
      updatedAt: 1,
    };
    expect('scope' in legacyLayout).toBe(false);
    seedLayouts([legacyLayout]);

    const ok = await StateManager.updateLayout('layout-legacy');
    expect(ok).toBe(true);

    const saved = StateManager.getSavedLayouts().find(l => l.id === 'layout-legacy')!;
    expect(saved.tabs.map((t: any) => t.id).sort()).toEqual(['tb-a', 'tb-b']);
    expect(Object.keys(saved.treesByTabId!).sort()).toEqual(['tb-a', 'tb-b']);
  });

  it('scope "tab" whose saved tab is no longer open REJECTS instead of silently re-pointing at another tab', async () => {
    const store = makeStore();
    (window as any).__REDUX_STORE__ = store;

    // tb-a (the layout's scoped tab) is NOT open — only an unrelated tb-b is.
    const treeB = { id: 'pn-b', type: 'terminal' as const, terminalId: 'tm-b' };
    store.dispatch({ type: 'tabs/addTab', payload: { id: 'tb-b', title: 'B' } });
    store.dispatch({ type: 'panes/addTabTree', payload: { tabId: 'tb-b', tree: treeB } });

    const treeAOld = { id: 'pn-a-old', type: 'terminal' as const, terminalId: 'tm-a-old' };
    seedLayouts([{
      id: 'layout-tab-gone',
      name: 'Gone tab',
      tabs: [{ id: 'tb-a', title: 'A' }],
      activeTabId: 'tb-a',
      paneTree: treeAOld,
      activePaneId: 'pn-a-old',
      treesByTabId: { 'tb-a': treeAOld },
      scope: 'tab',
      scopedTabId: 'tb-a',
      createdAt: 1,
      updatedAt: 1,
    } as SavedLayout]);

    await expect(StateManager.updateLayout('layout-tab-gone')).rejects.toThrow(/no longer open/);

    // The layout on disk is untouched — NOT silently re-pointed at tb-b.
    const saved = StateManager.getSavedLayouts().find(l => l.id === 'layout-tab-gone')!;
    expect(saved.scopedTabId).toBe('tb-a');
    expect(saved.tabs.map((t: any) => t.id)).toEqual(['tb-a']);
    expect(saved.updatedAt).toBe(1);
  });
});

/**
 * GUI-pass follow-up: Update now takes an explicit scope, so a layout can be
 * WIDENED (tab -> workspace) or NARROWED (workspace -> tab) rather than being
 * stuck in whatever scope it was first saved with.
 *
 * That reopens the exact bug this file was written for. `buildLayoutBody`'s
 * workspace branch returns only the five workspace fields, so the old
 * `{ ...existing, ...body }` would have carried `scope: 'tab'`, `scopedTabId`
 * and the per-tab maps straight out of the previous record — a layout claiming
 * to be one tab while carrying every tab. It was unreachable while the scope
 * could not change; letting the caller change it is what makes it reachable.
 */
describe('StateManager.updateLayout with an explicit scope (GUI pass)', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetCwdSnapshots();
  });

  const seedTwoTabs = () => {
    const store = makeStore();
    (window as any).__REDUX_STORE__ = store;
    const treeA = { id: 'pn-a', type: 'terminal' as const, terminalId: 'tm-a' };
    const treeB = { id: 'pn-b', type: 'terminal' as const, terminalId: 'tm-b' };
    store.dispatch({ type: 'tabs/addTab', payload: { id: 'tb-a', title: 'A' } });
    store.dispatch({ type: 'panes/addTabTree', payload: { tabId: 'tb-a', tree: treeA } });
    store.dispatch({ type: 'tabs/addTab', payload: { id: 'tb-b', title: 'B' } });
    store.dispatch({ type: 'panes/addTabTree', payload: { tabId: 'tb-b', tree: treeB } });
    return store;
  };

  const tabScopedLayout = (): SavedLayout => ({
    id: 'layout-x',
    name: 'X',
    tabs: [{ id: 'tb-a', title: 'A' }],
    activeTabId: 'tb-a',
    paneTree: { id: 'pn-a', type: 'terminal', terminalId: 'tm-a' },
    activePaneId: 'pn-a',
    treesByTabId: { 'tb-a': { id: 'pn-a', type: 'terminal', terminalId: 'tm-a' } },
    scope: 'tab',
    scopedTabId: 'tb-a',
    // The tab-scope-only fields. These are what must NOT survive a widening.
    activePaneByTabId: { 'tb-a': 'pn-a' },
    maximizedPaneByTabId: { 'tb-a': 'pn-a' },
    terminalCwds: { 'tm-a': '/only/this/tab' },
    createdAt: 1,
    updatedAt: 1,
  } as SavedLayout);

  const stored = () => JSON.parse(localStorage.getItem('auto-terminal-layouts')!)[0];

  it('WIDENS a tab layout to the workspace, dropping every tab-scope-only field with it', async () => {
    seedTwoTabs();
    seedLayouts([tabScopedLayout()]);

    expect(await StateManager.updateLayout('layout-x', { scope: 'workspace' })).toBe(true);

    const after = stored();
    // It carries the whole workspace...
    expect(after.tabs.map((t: any) => t.id).sort()).toEqual(['tb-a', 'tb-b']);
    expect(Object.keys(after.treesByTabId).sort()).toEqual(['tb-a', 'tb-b']);
    // ...and it no longer CLAIMS to be one tab. This pair is the whole point:
    // asserting the tabs alone passes for the defect, because the defect is a
    // record that carries every tab while still saying `scope: 'tab'`.
    expect(after.scope ?? 'workspace').toBe('workspace');
    expect(after.scopedTabId).toBeUndefined();
    // The per-tab maps described ONE tab. Left behind, they would describe a
    // tab the layout no longer claims, and `loadLayout` would apply them.
    expect(after.activePaneByTabId).toBeUndefined();
    expect(after.maximizedPaneByTabId).toBeUndefined();
    expect(after.terminalCwds).toBeUndefined();
  });

  it('NARROWS a workspace layout to one tab, naming the tab it was given', async () => {
    seedTwoTabs();
    seedLayouts([{
      id: 'layout-x', name: 'X',
      tabs: [{ id: 'tb-a', title: 'A' }, { id: 'tb-b', title: 'B' }],
      activeTabId: 'tb-a', paneTree: null, activePaneId: null,
      treesByTabId: { 'tb-a': null, 'tb-b': null },
      createdAt: 1, updatedAt: 1,
    } as SavedLayout]);

    expect(await StateManager.updateLayout('layout-x', { scope: 'tab', tabId: 'tb-b' })).toBe(true);

    const after = stored();
    expect(after.scope).toBe('tab');
    expect(after.scopedTabId).toBe('tb-b');
    expect(after.tabs.map((t: any) => t.id)).toEqual(['tb-b']);
    expect(Object.keys(after.treesByTabId)).toEqual(['tb-b']);
  });

  it('RE-TARGETS a tab layout at a different tab when given one explicitly', async () => {
    // The old rule — re-capture the tab this layout has always described — is
    // what stops a SILENT re-point. An explicit tabId is the user having chosen
    // on the record (the dialog names the tab, and warns when it differs), so
    // it is honoured.
    seedTwoTabs();
    seedLayouts([tabScopedLayout()]);

    expect(await StateManager.updateLayout('layout-x', { scope: 'tab', tabId: 'tb-b' })).toBe(true);

    const after = stored();
    expect(after.scopedTabId).toBe('tb-b');
    expect(after.tabs.map((t: any) => t.id)).toEqual(['tb-b']);
  });

  it('still re-captures the layout OWN scope when no options are passed', async () => {
    // Backward compatibility, asserted rather than assumed: every existing
    // caller and every test above calls `updateLayout(id)` with no options.
    seedTwoTabs();
    seedLayouts([tabScopedLayout()]);

    expect(await StateManager.updateLayout('layout-x')).toBe(true);

    const after = stored();
    expect(after.scope).toBe('tab');
    expect(after.scopedTabId).toBe('tb-a');
    expect(after.tabs.map((t: any) => t.id)).toEqual(['tb-a']);
  });

  it('rejects an explicit tab target that is not open, rather than re-pointing at something else', async () => {
    seedTwoTabs();
    seedLayouts([tabScopedLayout()]);
    await expect(
      StateManager.updateLayout('layout-x', { scope: 'tab', tabId: 'tb-gone' }),
    ).rejects.toThrow(/no longer open/);
    // ...and the stored layout is untouched by the failed attempt.
    expect(stored().scopedTabId).toBe('tb-a');
  });
});

describe('StateManager.loadTabScopedLayout cwd re-keying on collision (bug fix regression)', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetCwdSnapshots();
  });

  it('re-keys a colliding terminal\'s saved cwd onto the FRESH id — readable under the new id, not stranded under the old one', async () => {
    const store = makeStore();
    (window as any).__REDUX_STORE__ = store;

    // tb-owner currently holds the live terminal tm-shared.
    const ownerTree = { id: 'pn-owner', type: 'terminal' as const, terminalId: 'tm-shared' };
    store.dispatch({ type: 'tabs/addTab', payload: { id: 'tb-owner', title: 'Owner' } });
    store.dispatch({ type: 'panes/addTabTree', payload: { tabId: 'tb-owner', tree: ownerTree } });

    // A tab-scoped layout being loaded as a NEW tab whose saved tree names the
    // SAME terminal id (a collision the guard must re-mint), with a saved cwd
    // keyed on that same colliding id.
    const collidingTree = { id: 'pn-colliding', type: 'terminal' as const, terminalId: 'tm-shared' };
    seedLayouts([{
      id: 'layout-collide-cwd',
      name: 'Colliding with cwd',
      tabs: [{ id: 'tb-new', title: 'New' }],
      activeTabId: 'tb-new',
      paneTree: collidingTree,
      activePaneId: 'pn-colliding',
      treesByTabId: { 'tb-new': collidingTree },
      scope: 'tab',
      scopedTabId: 'tb-new',
      terminalCwds: { 'tm-shared': '/saved/new-tab-dir' },
      createdAt: 1,
      updatedAt: 1,
    } as SavedLayout]);

    const ok = await StateManager.loadTabScopedLayout('layout-collide-cwd', store.dispatch);
    expect(ok).toBe(true);

    const state = store.getState() as any;
    const newLeaf = state.panes.treesByTabId['tb-new'];
    // Re-minted to a fresh id, as `StateManager.tabScopedLayout.test.ts` already pins.
    expect(newLeaf.terminalId).not.toBe('tm-shared');
    expect(newLeaf.terminalId).toMatch(/^tm-/);

    // The saved cwd followed the re-mint onto the NEW id...
    expect(getCwdSnapshot(newLeaf.terminalId)).toBe('/saved/new-tab-dir');
    // ...and was never written under the OLD id — no entry is stranded there,
    // and the currently-live owner terminal's (absent) snapshot is untouched
    // rather than being polluted with the new tab's directory.
    expect(getCwdSnapshot('tm-shared')).toBeUndefined();
  });
});
