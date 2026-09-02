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
import { layoutUndoKey, sessionStateKey } from '../windowScope';
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

  /**
   * Regression (pre-review HIGH). The undo slot must be spent only once the
   * revert has actually COMMITTED.
   *
   * `takeUndo()` at method entry consumed it before the transaction, so a
   * revert that was superseded during its 100ms yield returned false having
   * already destroyed the only copy of the workspace the user asked to get
   * back — nothing restored, nothing left to retry with, and no error they
   * could act on. Uses the same overlap technique the loadLayout suite next to
   * this one uses for its own generation-token tests.
   */
  it('does NOT consume the undo slot when the revert is superseded mid-transaction', async () => {
    const store = makeStore();
    (window as any).__REDUX_STORE__ = store;

    store.dispatch({ type: 'tabs/addTab', payload: { id: 'tb-w0', title: 'W0' } });
    store.dispatch({
      type: 'panes/addTabTree',
      payload: { tabId: 'tb-w0', tree: { id: 'pn-w0', type: 'terminal', terminalId: 'tm-w0' } },
    });

    localStorage.setItem('auto-terminal-layouts', JSON.stringify([
      {
        id: 'layout-a', name: 'A',
        tabs: [{ id: 'tb-a', title: 'A' }],
        activeTabId: 'tb-a',
        paneTree: { id: 'pn-a', type: 'terminal', terminalId: 'tm-a' },
        activePaneId: 'pn-a',
        treesByTabId: { 'tb-a': { id: 'pn-a', type: 'terminal', terminalId: 'tm-a' } },
        createdAt: 1, updatedAt: 1,
      },
      {
        id: 'layout-b', name: 'B',
        tabs: [{ id: 'tb-b', title: 'B' }],
        activeTabId: 'tb-b',
        paneTree: { id: 'pn-b', type: 'terminal', terminalId: 'tm-b' },
        activePaneId: 'pn-b',
        treesByTabId: { 'tb-b': { id: 'pn-b', type: 'terminal', terminalId: 'tm-b' } },
        createdAt: 1, updatedAt: 1,
      },
    ]));

    // Load A, so W0 is in the undo slot.
    await StateManager.loadLayout('layout-a', store.dispatch);
    expect(peekUndo()?.tabs.map((t: any) => t.id)).toEqual(['tb-w0']);

    // Start a revert, then let a load of B take the generation while the
    // revert is still inside its yield.
    const revert = StateManager.revertWorkspace(store.dispatch);
    await new Promise(r => setTimeout(r, 30));
    const load = StateManager.loadLayout('layout-b', store.dispatch);

    const [reverted] = await Promise.all([revert, load]);

    expect(reverted).toBe(false);
    // The whole point: W0 is still recoverable. Before the fix this was null.
    expect(peekUndo()).not.toBeNull();
    expect(peekUndo()!.tabs.map((t: any) => t.id)).toEqual(['tb-w0']);
  });

  /**
   * Regression (pre-review MEDIUM). A structurally invalid snapshot must never
   * enter the replacement transaction.
   *
   * `layoutUndo` hydrates from localStorage, where a truncated or foreign write
   * parses fine as an object while carrying no `tabs`. `{}` is truthy, so a
   * bare null-check let it through: `clearCurrentState` wiped the live
   * workspace and `populateWorkspace` then no-opped on it (its body is entirely
   * inside `if (data.tabs?.length > 0)`), reporting success and leaving the
   * window empty.
   */
  it('refuses a malformed persisted snapshot instead of clearing the workspace into it', async () => {
    const store = makeStore();
    (window as any).__REDUX_STORE__ = store;
    store.dispatch({ type: 'tabs/addTab', payload: { id: 'tb-live', title: 'Live' } });
    store.dispatch({
      type: 'panes/addTabTree',
      payload: { tabId: 'tb-live', tree: { id: 'pn-live', type: 'terminal', terminalId: 'tm-live' } },
    });

    // A parseable but structurally empty blob, as a partial write would leave.
    localStorage.setItem(layoutUndoKey(), '{}');
    __resetLayoutUndoForTests(); // force a re-hydrate from storage

    const result = await StateManager.revertWorkspace(store.dispatch);

    expect(result).toBe(false);
    // The live workspace is untouched — this is the assertion that was false
    // before the fix (both of these were empty).
    expect(store.getState().tabs.tabs.map((t: any) => t.id)).toEqual(['tb-live']);
    expect(store.getState().panes.treesByTabId['tb-live']).toEqual({
      id: 'pn-live', type: 'terminal', terminalId: 'tm-live',
    });
    // ...and the unusable blob is discarded rather than left to be re-offered.
    expect(peekUndo()).toBeNull();
  });
});

describe('StateManager.resetToDefaultLayout invalidates recovery bookkeeping (pre-review fix)', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetLayoutUndoForTests();
    clearLayoutBaseline();
    jest.useRealTimers();
  });

  /**
   * Rationale: after Switch then Reset, Revert would otherwise skip OVER the
   * reset and restore a workspace the user has since deliberately thrown
   * away. `resetToDefaultLayout` now calls `clearUndo()`/`clearLayoutBaseline()`
   * so neither piece of recovery bookkeeping still points at the discarded
   * pre-reset workspace.
   */
  it('clears the undo slot and the layout baseline', async () => {
    const store = makeStore();
    (window as any).__REDUX_STORE__ = store;
    store.dispatch({ type: 'tabs/addTab', payload: { id: 'tb-orig', title: 'Orig' } });

    localStorage.setItem('auto-terminal-layouts', JSON.stringify([{
      id: 'layout-x', name: 'X',
      tabs: [{ id: 'tb-x', title: 'X' }],
      activeTabId: 'tb-x',
      paneTree: null,
      activePaneId: null,
      treesByTabId: { 'tb-x': null },
      createdAt: 1, updatedAt: 1,
    }]));

    await StateManager.loadLayout('layout-x', store.dispatch);
    expect(peekUndo()).not.toBeNull();

    StateManager.resetToDefaultLayout(store.dispatch);

    expect(peekUndo()).toBeNull();
    expect(getLayoutBaseline()).toBeNull();
  });

  /**
   * `resetToDefaultLayout` is synchronous but checks `replacementInFlight`
   * the same way `loadTabScopedLayout` does — dispatched into another
   * replacement's clear-then-yield window it would layer exactly the same
   * way. Same non-awaited-load technique as the guard test above.
   */
  it('refuses while a replacement is in flight, leaving the in-flight load to finish and win', async () => {
    const store = makeStore();
    (window as any).__REDUX_STORE__ = store;

    localStorage.setItem('auto-terminal-layouts', JSON.stringify([{
      id: 'layout-x', name: 'X',
      tabs: [{ id: 'tb-x', title: 'X' }],
      activeTabId: 'tb-x',
      paneTree: null,
      activePaneId: null,
      treesByTabId: { 'tb-x': null },
      createdAt: 1, updatedAt: 1,
    }]));

    // Started, NOT awaited — still inside the clear-then-100ms-yield window.
    const loadPromise = StateManager.loadLayout('layout-x', store.dispatch);
    // The refusal is REPORTED, not just performed. `resetToDefaultLayout`
    // returned `void` until round-2 review, so its caller could not tell a
    // declined reset from a completed one and dispatched the Redux half of the
    // reset either way — tearing up the layout tracking for a workspace that
    // had not been reset.
    expect(StateManager.resetToDefaultLayout(store.dispatch)).toBe(false);

    const committed = await loadPromise;
    expect(committed).toBe(true);

    const state = store.getState() as any;
    // The workspace is the LOADED layout, not the single default 'Terminal'
    // tab a successful reset would have installed.
    expect(state.tabs.tabs.map((t: any) => t.id)).toEqual(['tb-x']);
    expect(state.tabs.tabs.some((t: any) => t.title === 'Terminal')).toBe(false);
  });

  it('returns true when it actually resets, so the caller can tell the two apart', async () => {
    // The paired positive. Without it, a `resetToDefaultLayout` that returned
    // `false` unconditionally would satisfy the refusal test above vacuously
    // and permanently disable the caller's Redux half.
    const store = makeStore();
    (window as any).__REDUX_STORE__ = store;
    store.dispatch({ type: 'tabs/addTab', payload: { id: 'tb-old', title: 'Old' } });

    expect(StateManager.resetToDefaultLayout(store.dispatch)).toBe(true);
    expect((store.getState() as any).tabs.tabs.map((t: any) => t.title)).toEqual(['Terminal']);
  });
});

/**
 * Round-2 external review (report 179). A replacement clears the workspace,
 * yields ~100ms, and only then repopulates. `saveState` is called from a 30s
 * autosave tick, a pane teardown, a visibility change and `beforeunload` —
 * none of which know a swap is underway — so one landing inside that window
 * serialised `tabs: []` over the user's real session and the next launch
 * restored nothing.
 *
 * The window PREDATES this branch (`loadLayout` has cleared-then-yielded since
 * long before it), so this is not a defect the branch introduced; it is one
 * the branch's own guard finally makes expressible, and `revertWorkspace` adds
 * a third path through it.
 */
describe('StateManager.saveState does not persist a mid-replacement workspace (round-2 review)', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetLayoutUndoForTests();
    clearLayoutBaseline();
    jest.useRealTimers();
  });

  it('skips the write while a replacement owns the workspace, leaving the last real session intact', async () => {
    // `saveState` reads `settings.shellProfiles`/`defaultProfile`, which
    // `makeStore` above does not carry — without them the write throws into
    // StateManager's own try/catch and this test would pass against a
    // saveState that never wrote anything at all.
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        canvas: canvasReducer,
        settings: () => ({ shellProfiles: [], defaultProfile: 'default' }),
      },
    });
    (window as any).__REDUX_STORE__ = store;
    (window as any).__TAB_PANES__ = {};

    localStorage.setItem('auto-terminal-layouts', JSON.stringify([{
      id: 'layout-x', name: 'X',
      tabs: [{ id: 'tb-x', title: 'X' }],
      activeTabId: 'tb-x',
      paneTree: null,
      activePaneId: null,
      treesByTabId: { 'tb-x': null },
      createdAt: 1, updatedAt: 1,
    }]));

    // A real session on disk, written the ordinary way.
    store.dispatch({ type: 'tabs/addTab', payload: { id: 'tb-real', title: 'Real work' } });
    await StateManager.saveState();
    const beforeSwap = localStorage.getItem(sessionStateKey());
    expect(JSON.parse(beforeSwap!).tabs.map((t: any) => t.id)).toEqual(['tb-real']);

    // Mid-replacement: cleared, yielded, not yet repopulated.
    const loadPromise = StateManager.loadLayout('layout-x', store.dispatch);
    expect((store.getState() as any).tabs.tabs).toEqual([]);
    // This is the autosave tick firing at the worst possible moment.
    await StateManager.saveState();

    // Byte-identical to the pre-swap write: not an empty `tabs: []`, and not a
    // rewrite with a fresher timestamp either.
    expect(localStorage.getItem(sessionStateKey())).toBe(beforeSwap);

    expect(await loadPromise).toBe(true);

    // ...and saving is not permanently disabled: once the replacement releases,
    // the next tick writes the real post-swap workspace.
    await StateManager.saveState();
    const afterSwap = JSON.parse(localStorage.getItem(sessionStateKey())!);
    expect(afterSwap.tabs.map((t: any) => t.id)).toEqual(['tb-x']);
  });
});
