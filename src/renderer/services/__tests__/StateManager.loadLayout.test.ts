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
