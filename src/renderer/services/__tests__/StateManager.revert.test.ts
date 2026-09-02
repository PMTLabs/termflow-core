/**
 * @jest-environment jsdom
 *
 * plan/025 Task A4. `revertWorkspace` restores the workspace exactly as it was
 * immediately before the last `loadLayout` — tabs, trees, and active ids —
 * using the SAME replacement-transaction shape `loadLayout` already has
 * (generation token, `clearCurrentState`, the 100ms yield, the generation
 * re-check). It also restores the two things a `SavedLayout` never carried
 * (plan/025 §0.2/§2.3): per-tab focus (`activePaneByTabId`) and per-tab
 * maximize (`maximizedPaneByTabId`).
 */
// Only TerminalContainer is mocked (it drags in a whole React component tree
// for one export). `tabPanesStore` is left REAL — unlike the loadLayout suite
// next to this one, these tests exercise `captureWorkspaceSnapshot`, which
// reads the live `window.__TAB_PANES__` via `getTabPanesGlobal()`; a stub
// missing that export would make every snapshot capture throw (caught,
// logged, and silently skipped by StateManager's best-effort try/catch) and
// no undo slot would ever get pushed.
jest.mock('../../components/TerminalContainer', () => ({ clearTabPanes: jest.fn() }));

import { configureStore } from '@reduxjs/toolkit';
import tabsReducer from '../../store/slices/tabsSlice';
import panesReducer from '../../store/slices/panesSlice';
import canvasReducer from '../../store/slices/canvasSlice';
import { StateManager } from '../StateManager';
import { peekUndo, __resetLayoutUndoForTests } from '../layoutUndo';
import { getLayoutBaseline, clearLayoutBaseline } from '../layoutBaseline';
import { captureWorkspaceSnapshot, workspaceIdentity } from '../workspaceSnapshot';

function makeStore() {
  return configureStore({
    reducer: { tabs: tabsReducer, panes: panesReducer, canvas: canvasReducer },
  });
}

describe('StateManager.revertWorkspace (plan/025 Task A4)', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetLayoutUndoForTests();
    clearLayoutBaseline();
    jest.useRealTimers();
  });

  it('restores the prior workspace — tabs, trees, per-tab focus and per-tab maximize — after a loadLayout', async () => {
    const store = makeStore();
    (window as any).__REDUX_STORE__ = store;

    // Live workspace BEFORE any layout load: two tabs. tb-a is a background
    // tab that is later maximized on its own pane; tb-b starts as the active
    // one, then the user switches back to tb-a — recording BOTH tabs' entries
    // in `activePaneByTabId`, which a `SavedLayout` never carries at all.
    const leafA = { id: 'pn-a', type: 'terminal' as const, terminalId: 'tm-a' };
    const leafB = { id: 'pn-b', type: 'terminal' as const, terminalId: 'tm-b' };
    store.dispatch({ type: 'tabs/addTab', payload: { id: 'tb-a', title: 'A' } });
    store.dispatch({ type: 'panes/addTabTree', payload: { tabId: 'tb-a', tree: leafA } });
    store.dispatch({ type: 'panes/setActiveTabId', payload: 'tb-a' });
    store.dispatch({ type: 'tabs/addTab', payload: { id: 'tb-b', title: 'B' } });
    store.dispatch({ type: 'panes/addTabTree', payload: { tabId: 'tb-b', tree: leafB } });
    store.dispatch({ type: 'panes/setActiveTabId', payload: 'tb-b' }); // records activePaneByTabId['tb-a']='pn-a'
    store.dispatch({ type: 'panes/toggleMaximizePane', payload: { tabId: 'tb-a', paneId: 'pn-a' } });
    store.dispatch({ type: 'panes/setActiveTabId', payload: 'tb-a' }); // records activePaneByTabId['tb-b']='pn-b'
    store.dispatch({ type: 'tabs/setActiveTab', payload: 'tb-a' });

    // Sanity on the fixture itself before touching StateManager.
    const before = store.getState() as any;
    expect(before.panes.activePaneByTabId).toEqual({ 'tb-a': 'pn-a', 'tb-b': 'pn-b' });
    expect(before.panes.maximizedPaneByTabId).toEqual({ 'tb-a': 'pn-a' });

    // A saved layout to load OVER the live workspace.
    const treeNew = { id: 'pn-new', type: 'terminal' as const, terminalId: 'tm-new' };
    localStorage.setItem('auto-terminal-layouts', JSON.stringify([{
      id: 'layout-new',
      name: 'New',
      tabs: [{ id: 'tb-new', title: 'New tab' }],
      activeTabId: 'tb-new',
      paneTree: treeNew,
      activePaneId: 'pn-new',
      treesByTabId: { 'tb-new': treeNew },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }]));

    const loaded = await StateManager.loadLayout('layout-new', store.dispatch);
    expect(loaded).toBe(true);
    expect(store.getState().tabs.tabs.map((t: any) => t.id)).toEqual(['tb-new']);

    // loadLayout must have pushed the PRIOR (two-tab) workspace as the undo target.
    const pending = peekUndo();
    expect(pending).not.toBeNull();
    expect(pending!.tabs.map(t => t.id).sort()).toEqual(['tb-a', 'tb-b']);

    const reverted = await StateManager.revertWorkspace(store.dispatch);
    expect(reverted).toBe(true);

    const state = store.getState() as any;
    expect(state.tabs.tabs.map((t: any) => t.id).sort()).toEqual(['tb-a', 'tb-b']);
    expect(state.panes.treesByTabId['tb-a'].terminalId).toBe('tm-a');
    expect(state.panes.treesByTabId['tb-b'].terminalId).toBe('tm-b');
    expect(state.panes.activeTabId).toBe('tb-a');
    expect(state.panes.activePaneId).toBe('pn-a');

    // The restores a SavedLayout never had: the BACKGROUND tab's remembered
    // pane, and the maximize flag on the tab that isn't even active.
    expect(state.panes.activePaneByTabId['tb-b']).toBe('pn-b');
    expect(state.panes.maximizedPaneByTabId['tb-a']).toBe('pn-a');

    // The reverted-to workspace becomes the new "clean" baseline (plan/025 §2.5).
    const finalSnapshot = captureWorkspaceSnapshot(state, 'x');
    expect(getLayoutBaseline()).toBe(workspaceIdentity(finalSnapshot));
  });

  it('consumes the undo slot — reverting twice in a row only restores once', async () => {
    const store = makeStore();
    (window as any).__REDUX_STORE__ = store;

    store.dispatch({ type: 'tabs/addTab', payload: { id: 'tb-orig', title: 'Orig' } });
    store.dispatch({
      type: 'panes/addTabTree',
      payload: { tabId: 'tb-orig', tree: { id: 'pn-orig', type: 'terminal', terminalId: 'tm-orig' } },
    });

    localStorage.setItem('auto-terminal-layouts', JSON.stringify([{
      id: 'layout-x',
      name: 'X',
      tabs: [{ id: 'tb-x', title: 'X' }],
      activeTabId: 'tb-x',
      paneTree: null,
      activePaneId: null,
      treesByTabId: { 'tb-x': null },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }]));

    await StateManager.loadLayout('layout-x', store.dispatch);
    expect(peekUndo()).not.toBeNull();

    expect(await StateManager.revertWorkspace(store.dispatch)).toBe(true);
    expect(peekUndo()).toBeNull();

    // Nothing left to revert to — a second call is a true no-op (false, and
    // the just-reverted workspace is untouched).
    const tabsBeforeSecondRevert = store.getState().tabs.tabs.map((t: any) => t.id);
    expect(await StateManager.revertWorkspace(store.dispatch)).toBe(false);
    expect(store.getState().tabs.tabs.map((t: any) => t.id)).toEqual(tabsBeforeSecondRevert);
  });

  it('returns false and touches nothing when there is no prior workspace to revert to', async () => {
    const store = makeStore();
    (window as any).__REDUX_STORE__ = store;
    store.dispatch({ type: 'tabs/addTab', payload: { id: 'tb-only', title: 'Only' } });

    const result = await StateManager.revertWorkspace(store.dispatch);

    expect(result).toBe(false);
    expect(store.getState().tabs.tabs.map((t: any) => t.id)).toEqual(['tb-only']);
  });
});
