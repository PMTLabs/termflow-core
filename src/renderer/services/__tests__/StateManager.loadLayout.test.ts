/**
 * @jest-environment jsdom
 *
 * Review 109 H2. Saved-layout loading used to add every tab immediately but
 * only ever persist/restore the ACTIVE tab's tree (`paneTree`), leaving every
 * OTHER tab — including a background API-created tab whose root leaf is
 * `tm-*` — with no authoritative tree until a 200ms timeout (active tab) or
 * never (background tabs). TerminalContainer's seed effects fill that gap
 * with a `terminalId: tab.id` root, silently replacing the real `tm-` leaf
 * and orphaning a PTY.
 *
 * These tests exercise `StateManager.loadLayout` against a real Redux store
 * (tabs + panes reducers) and assert that a tab's tree exists in
 * `treesByTabId` in the SAME synchronous pass as its `addTab` — i.e. before
 * TerminalContainer's effects could ever observe a tree-less tab.
 */
jest.mock('../../components/TerminalContainer', () => ({ clearTabPanes: jest.fn() }));
jest.mock('../tabPanesStore', () => ({ restoreTabPanesInPlace: jest.fn() }));

import { configureStore } from '@reduxjs/toolkit';
import tabsReducer from '../../store/slices/tabsSlice';
import panesReducer from '../../store/slices/panesSlice';
import { StateManager } from '../StateManager';

function makeStore() {
  return configureStore({ reducer: { tabs: tabsReducer, panes: panesReducer } });
}

describe('StateManager.loadLayout (review 109 H2)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('restores a background API tab with its real tm- root leaf intact, not a tb-<tabId> seed', async () => {
    const store = makeStore();
    (window as any).__REDUX_STORE__ = store;

    const apiTree = { id: 'pn-api1', type: 'terminal' as const, terminalId: 'tm-api-leaf-1' };
    const rendererTree = { id: 'pn-r1', type: 'terminal' as const, terminalId: 'tb-active1' };

    // Seed a saved layout directly (bypassing saveLayout's dependency on a live
    // store shaped like RootState) with the NEW per-tab format.
    const layout = {
      id: 'layout-1',
      name: 'test',
      tabs: [
        { id: 'tb-active1', title: 'Active' },
        { id: 'tb-api1', title: 'API tab' },
      ],
      activeTabId: 'tb-active1',
      paneTree: rendererTree,
      activePaneId: 'pn-r1',
      treesByTabId: {
        'tb-active1': rendererTree,
        'tb-api1': apiTree,
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    localStorage.setItem('auto-terminal-layouts', JSON.stringify([layout]));

    const ok = await StateManager.loadLayout('layout-1', store.dispatch);
    expect(ok).toBe(true);

    const state = store.getState() as any;
    // The background API tab's tree must be present with its tm- leaf intact —
    // not absent, and not replaced by a tb-tb-api1-style seed.
    expect(state.panes.treesByTabId['tb-api1']).toBeTruthy();
    expect(state.panes.treesByTabId['tb-api1'].terminalId).toBe('tm-api-leaf-1');
  });

  it('falls back to today\'s behavior for an OLD-format layout with only paneTree, without crashing or dropping tabs', async () => {
    const store = makeStore();
    (window as any).__REDUX_STORE__ = store;

    const oldLayout = {
      id: 'layout-old',
      name: 'old',
      tabs: [
        { id: 'tb-old1', title: 'Old tab 1' },
        { id: 'tb-old2', title: 'Old tab 2' },
      ],
      activeTabId: 'tb-old1',
      paneTree: { id: 'pn-old1', type: 'terminal' as const, terminalId: 'tb-old1' },
      activePaneId: 'pn-old1',
      // No treesByTabId at all — pre-review-109 format.
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    localStorage.setItem('auto-terminal-layouts', JSON.stringify([oldLayout]));

    await expect(StateManager.loadLayout('layout-old', store.dispatch)).resolves.toBe(true);

    const state = store.getState() as any;
    // Both tabs still exist — nothing dropped.
    expect(state.tabs.tabs.map((t: any) => t.id).sort()).toEqual(['tb-old1', 'tb-old2']);
  });
});

/**
 * Re-review of the H2 fix (report 111, agy). The H2 fix taught `saveLayout` to
 * persist `treesByTabId`, but `updateLayout` — the OTHER writer, used by the
 * Layout Manager's "Update" button — kept spreading the stored layout and so
 * carried the STALE trees forward (or `undefined`, for a layout first saved
 * before the field existed). A tab created since the last save then has no
 * entry, `loadLayout` skips its `addTabTree`, and the seed effect replaces an
 * API tab's `tm-*` root leaf exactly as in H2.
 *
 * The invariant under test is about the WRITERS, not one call site: every path
 * that persists a layout must persist the per-tab trees with it.
 */
describe('StateManager.updateLayout (re-review 111 finding 1)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('persists treesByTabId, so a tab added since the last save survives a later load', async () => {
    const store = makeStore();
    (window as any).__REDUX_STORE__ = store;

    // A layout saved BEFORE tab C existed — and before treesByTabId existed at
    // all, which is the worst case: the spread would carry `undefined`.
    const staleLayout = {
      id: 'layout-2',
      name: 'stale',
      tabs: [{ id: 'tb-a', title: 'A' }],
      activeTabId: 'tb-a',
      paneTree: { id: 'pn-a', type: 'terminal' as const, terminalId: 'tb-a' },
      activePaneId: 'pn-a',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    localStorage.setItem('auto-terminal-layouts', JSON.stringify([staleLayout]));

    // Current live state has since gained an API-created tab whose root leaf is
    // `tm-*` — the identity that must not be lost.
    const apiTree = { id: 'pn-c', type: 'terminal' as const, terminalId: 'tm-api-leaf-2' };
    store.dispatch({ type: 'tabs/addTab', payload: { id: 'tb-a', title: 'A' } });
    store.dispatch({ type: 'tabs/addTab', payload: { id: 'tb-c', title: 'C' } });
    store.dispatch({
      type: 'panes/addTabTree',
      payload: { tabId: 'tb-a', tree: staleLayout.paneTree },
    });
    store.dispatch({ type: 'panes/addTabTree', payload: { tabId: 'tb-c', tree: apiTree } });

    const ok = await StateManager.updateLayout('layout-2');
    expect(ok).toBe(true);

    const stored = JSON.parse(localStorage.getItem('auto-terminal-layouts') || '[]');
    const updated = stored.find((l: any) => l.id === 'layout-2');

    // The whole point: the updated layout carries tab C's tree, with its real
    // tm- leaf. Before the fix this was `undefined`.
    expect(updated.treesByTabId).toBeTruthy();
    expect(updated.treesByTabId['tb-c']).toBeTruthy();
    expect(updated.treesByTabId['tb-c'].terminalId).toBe('tm-api-leaf-2');
  });
});

/**
 * Re-review 111 finding 2. `loadLayout` used to schedule `setActiveTab(A)` at
 * 100ms and an UNTARGETED `setPaneTree(A-tree)` at 200ms. `setPaneTree` runs
 * `syncActive`, which writes its payload into `treesByTabId[activeTabId]` as of
 * CALLBACK time — so selecting tab B in between wrote A's tree into B,
 * replacing B's panes and orphaning its PTYs (two overlapping loads corrupt each
 * other the same way). The fix: no timers, and every tree write keyed by its
 * real owner via `addTabTree`.
 */
describe('StateManager.loadLayout deferred-write safety (re-review 111 finding 2)', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.useRealTimers();
  });

  it("never writes the loaded active tab's tree into a tab the user switched to", async () => {
    const store = makeStore();
    (window as any).__REDUX_STORE__ = store;

    const treeA = { id: 'pn-a', type: 'terminal' as const, terminalId: 'tb-a' };
    const treeB = { id: 'pn-b', type: 'terminal' as const, terminalId: 'tm-b-leaf' };

    localStorage.setItem('auto-terminal-layouts', JSON.stringify([{
      id: 'layout-x',
      name: 'x',
      tabs: [{ id: 'tb-a', title: 'A' }, { id: 'tb-b', title: 'B' }],
      activeTabId: 'tb-a',
      paneTree: treeA,
      activePaneId: 'pn-a',
      treesByTabId: { 'tb-a': treeA, 'tb-b': treeB },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }]));

    await StateManager.loadLayout('layout-x', store.dispatch);

    // The user switches to B immediately after the load resolves — under the old
    // code the 200ms setPaneTree callback had not fired yet.
    store.dispatch({ type: 'panes/setActiveTabId', payload: 'tb-b' });
    await new Promise(resolve => setTimeout(resolve, 300));

    const state = store.getState() as any;
    expect(state.panes.treesByTabId['tb-b'].terminalId).toBe('tm-b-leaf');
    expect(state.panes.treesByTabId['tb-a'].terminalId).toBe('tb-a');
  });

  it('installs an OLD-format layout tree under the saved active tab id, not through the mirror', async () => {
    const store = makeStore();
    (window as any).__REDUX_STORE__ = store;

    localStorage.setItem('auto-terminal-layouts', JSON.stringify([{
      id: 'layout-old2',
      name: 'old2',
      tabs: [{ id: 'tb-old-a', title: 'A' }, { id: 'tb-old-b', title: 'B' }],
      activeTabId: 'tb-old-a',
      paneTree: { id: 'pn-old-a', type: 'terminal' as const, terminalId: 'tb-old-a' },
      activePaneId: 'pn-old-a',
      // No treesByTabId — pre-review-109 format.
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }]));

    await StateManager.loadLayout('layout-old2', store.dispatch);
    store.dispatch({ type: 'panes/setActiveTabId', payload: 'tb-old-b' });
    await new Promise(resolve => setTimeout(resolve, 300));

    const state = store.getState() as any;
    expect(state.panes.treesByTabId['tb-old-a']).toBeTruthy();
    expect(state.panes.treesByTabId['tb-old-a'].terminalId).toBe('tb-old-a');
    // And it was never leaked into the tab the user switched to.
    expect(state.panes.treesByTabId['tb-old-b']).toBeUndefined();
  });
});

/**
 * Re-review 111 finding 4. Layout teardown dispatched `setPaneTree(null)`,
 * which deletes only the ACTIVE tab's tree; background trees stayed in Redux
 * forever (the window map was already cleared, so TerminalContainer's cleanup
 * effect had no keys to enumerate).
 */
describe('StateManager teardown clears background trees (re-review 111 finding 4)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("drops a background tab's tree when a new layout is loaded", async () => {
    const store = makeStore();
    (window as any).__REDUX_STORE__ = store;

    // Live state: active tab A plus a BACKGROUND API tab B with a tm- leaf.
    store.dispatch({ type: 'tabs/addTab', payload: { id: 'tb-live-a', title: 'A' } });
    store.dispatch({ type: 'tabs/addTab', payload: { id: 'tb-live-b', title: 'B' } });
    store.dispatch({
      type: 'panes/addTabTree',
      payload: { tabId: 'tb-live-a', tree: { id: 'pn-la', type: 'terminal', terminalId: 'tb-live-a' } },
    });
    store.dispatch({
      type: 'panes/addTabTree',
      payload: { tabId: 'tb-live-b', tree: { id: 'pn-lb', type: 'terminal', terminalId: 'tm-live-b' } },
    });
    store.dispatch({ type: 'panes/setActiveTabId', payload: 'tb-live-a' });

    const treeN = { id: 'pn-n', type: 'terminal' as const, terminalId: 'tb-new' };
    localStorage.setItem('auto-terminal-layouts', JSON.stringify([{
      id: 'layout-n',
      name: 'n',
      tabs: [{ id: 'tb-new', title: 'New' }],
      activeTabId: 'tb-new',
      paneTree: treeN,
      activePaneId: 'pn-n',
      treesByTabId: { 'tb-new': treeN },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }]));

    await StateManager.loadLayout('layout-n', store.dispatch);

    const state = store.getState() as any;
    expect(state.panes.treesByTabId['tb-live-b']).toBeUndefined();
    expect(state.panes.treesByTabId['tb-live-a']).toBeUndefined();
    expect(state.panes.treesByTabId['tb-new']).toBeTruthy();
  });
});
