/**
 * @jest-environment jsdom
 *
 * plan/025 Task A5 — tab-scoped layouts. `loadTabScopedLayout` is deliberately
 * NOT a replacement transaction (no `clearCurrentState`, no generation token,
 * no yield): it must touch ONLY the one tab it targets, leaving every other
 * tab's entry in `panes.treesByTabId` untouched. The collision guard (§2.4
 * step 2) is load-bearing: `findTabIdByTerminalId` returns the FIRST match, so
 * without the re-mint a terminal id already live in a different tab would be
 * silently claimed by two tabs at once.
 */
// Only TerminalContainer is mocked (it drags in a whole React component tree
// for one export). `tabPanesStore` is left REAL: `loadTabScopedLayout` pushes
// an undo snapshot via `captureWorkspaceSnapshot`, which reads the live
// `window.__TAB_PANES__` via `getTabPanesGlobal()` — a stub missing that
// export would make the capture throw (caught and logged) and no snapshot
// would ever land in the undo slot.
jest.mock('../../components/TerminalContainer', () => ({ clearTabPanes: jest.fn() }));

import { configureStore } from '@reduxjs/toolkit';
import tabsReducer from '../../store/slices/tabsSlice';
import panesReducer from '../../store/slices/panesSlice';
import canvasReducer from '../../store/slices/canvasSlice';
import { StateManager, SavedLayout } from '../StateManager';
import { peekUndo, __resetLayoutUndoForTests } from '../layoutUndo';

function makeStore() {
  return configureStore({
    reducer: { tabs: tabsReducer, panes: panesReducer, canvas: canvasReducer },
  });
}

function seedLayouts(layouts: SavedLayout[]) {
  localStorage.setItem('auto-terminal-layouts', JSON.stringify(layouts));
}

describe('StateManager.loadTabScopedLayout (plan/025 Task A5)', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetLayoutUndoForTests();
  });

  it('installs into a NEW tab, leaving an unrelated tab\'s tree byte-identical', async () => {
    const store = makeStore();
    (window as any).__REDUX_STORE__ = store;

    // An unrelated live tab, present before and expected to be untouched after.
    const unrelatedTree = { id: 'pn-unrelated', type: 'terminal' as const, terminalId: 'tm-unrelated' };
    store.dispatch({ type: 'tabs/addTab', payload: { id: 'tb-unrelated', title: 'Unrelated' } });
    store.dispatch({ type: 'panes/addTabTree', payload: { tabId: 'tb-unrelated', tree: unrelatedTree } });
    const unrelatedBefore = JSON.parse(JSON.stringify(
      (store.getState() as any).panes.treesByTabId['tb-unrelated'],
    ));

    const newTree = { id: 'pn-new', type: 'terminal' as const, terminalId: 'tm-new' };
    seedLayouts([{
      id: 'layout-tab-new',
      name: 'Build tab',
      tabs: [{ id: 'tb-new', title: 'Build' }],
      activeTabId: 'tb-new',
      paneTree: newTree,
      activePaneId: 'pn-new',
      treesByTabId: { 'tb-new': newTree },
      scope: 'tab',
      scopedTabId: 'tb-new',
      activePaneByTabId: { 'tb-new': 'pn-new' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as SavedLayout]);

    const ok = await StateManager.loadTabScopedLayout('layout-tab-new', store.dispatch);
    expect(ok).toBe(true);

    const state = store.getState() as any;
    // The new tab landed with its tree intact.
    expect(state.tabs.tabs.map((t: any) => t.id).sort()).toEqual(['tb-new', 'tb-unrelated']);
    expect(state.panes.treesByTabId['tb-new'].terminalId).toBe('tm-new');
    expect(state.panes.activePaneByTabId['tb-new']).toBe('pn-new');
    // It became the active tab (plan/025 §2.4 step 4).
    expect(state.panes.activeTabId).toBe('tb-new');

    // The STRONG assertion: the unrelated tab's tree is deep-equal before and after.
    expect(state.panes.treesByTabId['tb-unrelated']).toEqual(unrelatedBefore);

    // §2.4 step 5: "reverting a tab load is the same gesture" — an undo
    // snapshot was pushed.
    expect(peekUndo()).not.toBeNull();
  });

  it('installs onto an EXISTING tab via updateTabMeta + addTabTree (not removeTab+addTab), leaving other tabs alone', async () => {
    const store = makeStore();
    (window as any).__REDUX_STORE__ = store;

    // The tab the layout targets already exists, with its own live tree.
    const liveTree = { id: 'pn-live', type: 'terminal' as const, terminalId: 'tm-live' };
    store.dispatch({ type: 'tabs/addTab', payload: { id: 'tb-target', title: 'Old title', shellType: 'default' } });
    store.dispatch({ type: 'panes/addTabTree', payload: { tabId: 'tb-target', tree: liveTree } });

    // A second, unrelated tab that must stay untouched.
    const otherTree = { id: 'pn-other', type: 'terminal' as const, terminalId: 'tm-other' };
    store.dispatch({ type: 'tabs/addTab', payload: { id: 'tb-other', title: 'Other' } });
    store.dispatch({ type: 'panes/addTabTree', payload: { tabId: 'tb-other', tree: otherTree } });
    const otherBefore = JSON.parse(JSON.stringify((store.getState() as any).panes.treesByTabId['tb-other']));

    const savedTree = { id: 'pn-saved', type: 'terminal' as const, terminalId: 'tm-saved' };
    seedLayouts([{
      id: 'layout-tab-existing',
      name: 'Saved title',
      tabs: [{ id: 'tb-target', title: 'Saved title', shellType: 'ssh' }],
      activeTabId: 'tb-target',
      paneTree: savedTree,
      activePaneId: 'pn-saved',
      treesByTabId: { 'tb-target': savedTree },
      scope: 'tab',
      scopedTabId: 'tb-target',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as SavedLayout]);

    const ok = await StateManager.loadTabScopedLayout('layout-tab-existing', store.dispatch);
    expect(ok).toBe(true);

    const state = store.getState() as any;
    // Same tab id — not removed and re-created.
    expect(state.tabs.tabs.map((t: any) => t.id).sort()).toEqual(['tb-other', 'tb-target']);
    // Durable fields patched from the saved layout.
    const targetTab = state.tabs.tabs.find((t: any) => t.id === 'tb-target');
    expect(targetTab.title).toBe('Saved title');
    expect(targetTab.shellType).toBe('ssh');
    // Its tree replaced with the saved one.
    expect(state.panes.treesByTabId['tb-target'].terminalId).toBe('tm-saved');
    // The unrelated tab is untouched.
    expect(state.panes.treesByTabId['tb-other']).toEqual(otherBefore);
  });

  it('re-mints a terminal id that is currently live in a DIFFERENT tab, carrying the old id into sessionKey', async () => {
    const store = makeStore();
    (window as any).__REDUX_STORE__ = store;

    // tb-owner currently holds the live terminal tm-shared.
    const ownerTree = { id: 'pn-owner', type: 'terminal' as const, terminalId: 'tm-shared' };
    store.dispatch({ type: 'tabs/addTab', payload: { id: 'tb-owner', title: 'Owner' } });
    store.dispatch({ type: 'panes/addTabTree', payload: { tabId: 'tb-owner', tree: ownerTree } });
    const ownerBefore = JSON.parse(JSON.stringify((store.getState() as any).panes.treesByTabId['tb-owner']));

    // A tab-scoped layout being loaded as a NEW tab whose saved tree names the
    // SAME terminal id — a collision that must not let the two tabs share it.
    const collidingTree = { id: 'pn-colliding', type: 'terminal' as const, terminalId: 'tm-shared' };
    seedLayouts([{
      id: 'layout-tab-collide',
      name: 'Colliding',
      tabs: [{ id: 'tb-new', title: 'New' }],
      activeTabId: 'tb-new',
      paneTree: collidingTree,
      activePaneId: 'pn-colliding',
      treesByTabId: { 'tb-new': collidingTree },
      scope: 'tab',
      scopedTabId: 'tb-new',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as SavedLayout]);

    const ok = await StateManager.loadTabScopedLayout('layout-tab-collide', store.dispatch);
    expect(ok).toBe(true);

    const state = store.getState() as any;
    // tb-owner's terminal is completely untouched — still the same id, no sessionKey added.
    expect(state.panes.treesByTabId['tb-owner']).toEqual(ownerBefore);

    // tb-new's leaf was re-minted: a FRESH id, not tm-shared, with the old id
    // preserved as sessionKey (the pty-host protocol has no rename verb).
    const newLeaf = state.panes.treesByTabId['tb-new'];
    expect(newLeaf.terminalId).not.toBe('tm-shared');
    expect(newLeaf.terminalId).toMatch(/^tm-/);
    expect(newLeaf.sessionKey).toBe('tm-shared');
  });

  it('does not re-mint when the terminal id is already owned by the TARGET tab itself', async () => {
    const store = makeStore();
    (window as any).__REDUX_STORE__ = store;

    // tb-target already owns tm-keep (e.g. re-loading the same tab layout onto itself).
    const existingTree = { id: 'pn-keep', type: 'terminal' as const, terminalId: 'tm-keep' };
    store.dispatch({ type: 'tabs/addTab', payload: { id: 'tb-target', title: 'Target' } });
    store.dispatch({ type: 'panes/addTabTree', payload: { tabId: 'tb-target', tree: existingTree } });

    const savedTree = { id: 'pn-keep', type: 'terminal' as const, terminalId: 'tm-keep' };
    seedLayouts([{
      id: 'layout-self',
      name: 'Self',
      tabs: [{ id: 'tb-target', title: 'Target' }],
      activeTabId: 'tb-target',
      paneTree: savedTree,
      activePaneId: 'pn-keep',
      treesByTabId: { 'tb-target': savedTree },
      scope: 'tab',
      scopedTabId: 'tb-target',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as SavedLayout]);

    const ok = await StateManager.loadTabScopedLayout('layout-self', store.dispatch);
    expect(ok).toBe(true);

    const state = store.getState() as any;
    expect(state.panes.treesByTabId['tb-target'].terminalId).toBe('tm-keep');
    expect(state.panes.treesByTabId['tb-target'].sessionKey).toBeUndefined();
  });

  /**
   * Regression: the restore must SET the tab's maximized pane, not toggle it.
   *
   * `loadTabScopedLayout` never runs `resetPanes`, so it has no known-empty
   * starting state — the property `populateWorkspace` relies on. A toggle
   * therefore DELETES the entry whenever the target pane is already the
   * maximized one, i.e. loading a layout that says "pn-zoom is maximized" onto
   * a tab where pn-zoom is already maximized un-maximizes it.
   */
  it('SETS the maximized pane, so re-loading onto an already-maximized tab keeps it maximized', async () => {
    const store = makeStore();
    (window as any).__REDUX_STORE__ = store;

    const tree = { id: 'pn-zoom', type: 'terminal' as const, terminalId: 'tm-zoom' };
    store.dispatch({ type: 'tabs/addTab', payload: { id: 'tb-target', title: 'Target' } });
    store.dispatch({ type: 'panes/addTabTree', payload: { tabId: 'tb-target', tree } });
    // The tab is ALREADY maximized on the very pane the layout describes.
    store.dispatch({ type: 'panes/setMaximizedPane', payload: { tabId: 'tb-target', paneId: 'pn-zoom' } });

    seedLayouts([{
      id: 'layout-zoom',
      name: 'Zoomed',
      tabs: [{ id: 'tb-target', title: 'Target' }],
      activeTabId: 'tb-target',
      paneTree: tree,
      activePaneId: 'pn-zoom',
      treesByTabId: { 'tb-target': tree },
      maximizedPaneByTabId: { 'tb-target': 'pn-zoom' },
      scope: 'tab',
      scopedTabId: 'tb-target',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as SavedLayout]);

    expect(await StateManager.loadTabScopedLayout('layout-zoom', store.dispatch)).toBe(true);
    expect((store.getState() as any).panes.maximizedPaneByTabId['tb-target']).toBe('pn-zoom');
  });

  /**
   * The paired positive for the rule above: a layout that describes NO
   * maximized pane must CLEAR whatever the tab currently has, or the restored
   * tab keeps a zoomed pane the layout never mentioned. This is why the
   * dispatch is unconditional rather than guarded on the saved value.
   */
  it('CLEARS an existing maximize when the layout describes none', async () => {
    const store = makeStore();
    (window as any).__REDUX_STORE__ = store;

    const tree = { id: 'pn-a', type: 'terminal' as const, terminalId: 'tm-a' };
    store.dispatch({ type: 'tabs/addTab', payload: { id: 'tb-target', title: 'Target' } });
    store.dispatch({ type: 'panes/addTabTree', payload: { tabId: 'tb-target', tree } });
    store.dispatch({ type: 'panes/setMaximizedPane', payload: { tabId: 'tb-target', paneId: 'pn-a' } });

    seedLayouts([{
      id: 'layout-flat',
      name: 'Flat',
      tabs: [{ id: 'tb-target', title: 'Target' }],
      activeTabId: 'tb-target',
      paneTree: tree,
      activePaneId: 'pn-a',
      treesByTabId: { 'tb-target': tree },
      // no maximizedPaneByTabId
      scope: 'tab',
      scopedTabId: 'tb-target',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as SavedLayout]);

    expect(await StateManager.loadTabScopedLayout('layout-flat', store.dispatch)).toBe(true);
    expect((store.getState() as any).panes.maximizedPaneByTabId['tb-target']).toBeUndefined();
  });
});

describe('StateManager.saveLayout scope (plan/025 Task A5)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to scope "workspace" and omits scope when opts is not passed — every layout saved before this feature loads unchanged', async () => {
    const store = makeStore();
    (window as any).__REDUX_STORE__ = store;
    store.dispatch({ type: 'tabs/addTab', payload: { id: 'tb-1', title: 'A' } });

    await StateManager.saveLayout('Whole workspace');

    const saved = StateManager.getSavedLayouts()[0];
    expect(saved.scope).toBeUndefined();
    expect(saved.tabs.map((t: any) => t.id)).toEqual(['tb-1']);
  });

  it('scope "tab" saves exactly one tab and its own per-tab entries, not the whole workspace', async () => {
    const store = makeStore();
    (window as any).__REDUX_STORE__ = store;

    const treeA = { id: 'pn-a', type: 'terminal' as const, terminalId: 'tm-a' };
    const treeB = { id: 'pn-b', type: 'terminal' as const, terminalId: 'tm-b' };
    store.dispatch({ type: 'tabs/addTab', payload: { id: 'tb-a', title: 'A' } });
    store.dispatch({ type: 'panes/addTabTree', payload: { tabId: 'tb-a', tree: treeA } });
    store.dispatch({ type: 'tabs/addTab', payload: { id: 'tb-b', title: 'B' } });
    store.dispatch({ type: 'panes/addTabTree', payload: { tabId: 'tb-b', tree: treeB } });
    store.dispatch({ type: 'panes/toggleMaximizePane', payload: { tabId: 'tb-b', paneId: 'pn-b' } });

    const layoutId = await StateManager.saveLayout('Just B', undefined, { scope: 'tab', tabId: 'tb-b' });

    const saved = StateManager.getSavedLayouts().find(l => l.id === layoutId)!;
    expect(saved.scope).toBe('tab');
    expect(saved.scopedTabId).toBe('tb-b');
    expect(saved.tabs.map((t: any) => t.id)).toEqual(['tb-b']);
    expect(Object.keys(saved.treesByTabId!)).toEqual(['tb-b']);
    expect(saved.treesByTabId!['tb-b'].terminalId).toBe('tm-b');
    expect(saved.maximizedPaneByTabId).toEqual({ 'tb-b': 'pn-b' });
  });
});
