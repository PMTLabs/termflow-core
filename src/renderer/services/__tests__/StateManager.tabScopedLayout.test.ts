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
    // Weak-oracle fix (pre-review): a distinctive title plus its own
    // activePaneByTabId/maximizedPaneByTabId entries, so an implementation that
    // corrupts the unrelated tab's TITLE or clobbers either per-tab map entry —
    // while still leaving its TREE alone — is caught too.
    const unrelatedTree = { id: 'pn-unrelated', type: 'terminal' as const, terminalId: 'tm-unrelated' };
    // isActive: false so this tab's OWN activation state is not perturbed by
    // the load below activating a different tab (setActiveTab flips isActive
    // on every tab, so starting active here would give a false-positive
    // "corrupted" diff that has nothing to do with the code under test).
    store.dispatch({ type: 'tabs/addTab', payload: { id: 'tb-unrelated', title: 'Distinctive Unrelated Title', isActive: false } });
    store.dispatch({ type: 'panes/addTabTree', payload: { tabId: 'tb-unrelated', tree: unrelatedTree } });
    store.dispatch({ type: 'panes/focusPaneInTab', payload: { tabId: 'tb-unrelated', paneId: 'pn-unrelated' } });
    store.dispatch({ type: 'panes/setMaximizedPane', payload: { tabId: 'tb-unrelated', paneId: 'pn-unrelated' } });
    const unrelatedBefore = JSON.parse(JSON.stringify(
      (store.getState() as any).panes.treesByTabId['tb-unrelated'],
    ));
    const unrelatedTabBefore = JSON.parse(JSON.stringify(
      (store.getState() as any).tabs.tabs.find((t: any) => t.id === 'tb-unrelated'),
    ));
    const unrelatedActivePaneBefore = (store.getState() as any).panes.activePaneByTabId['tb-unrelated'];
    const unrelatedMaximizedPaneBefore = (store.getState() as any).panes.maximizedPaneByTabId['tb-unrelated'];

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
    // The FULL unrelated-tab projection, deep-equal before and after
    // (pre-review weak-oracle finding): Tab object, tree (above), and both
    // per-tab map entries.
    expect(state.tabs.tabs.find((t: any) => t.id === 'tb-unrelated')).toEqual(unrelatedTabBefore);
    expect(state.panes.activePaneByTabId['tb-unrelated']).toBe(unrelatedActivePaneBefore);
    expect(state.panes.maximizedPaneByTabId['tb-unrelated']).toBe(unrelatedMaximizedPaneBefore);

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

    // A second, unrelated tab that must stay untouched. Weak-oracle fix
    // (pre-review): a distinctive title plus its own activePaneByTabId/
    // maximizedPaneByTabId entries, so an implementation that corrupts the
    // title or clobbers either per-tab map entry — while leaving the TREE
    // alone — is still caught.
    const otherTree = { id: 'pn-other', type: 'terminal' as const, terminalId: 'tm-other' };
    // isActive: false for the same reason as the sibling test above — this
    // tab's own activation state must not be perturbed by the load below
    // activating tb-target.
    store.dispatch({ type: 'tabs/addTab', payload: { id: 'tb-other', title: 'Distinctive Other Title', isActive: false } });
    store.dispatch({ type: 'panes/addTabTree', payload: { tabId: 'tb-other', tree: otherTree } });
    store.dispatch({ type: 'panes/focusPaneInTab', payload: { tabId: 'tb-other', paneId: 'pn-other' } });
    store.dispatch({ type: 'panes/setMaximizedPane', payload: { tabId: 'tb-other', paneId: 'pn-other' } });
    const otherBefore = JSON.parse(JSON.stringify((store.getState() as any).panes.treesByTabId['tb-other']));
    const otherTabBefore = JSON.parse(JSON.stringify(
      (store.getState() as any).tabs.tabs.find((t: any) => t.id === 'tb-other'),
    ));
    const otherActivePaneBefore = (store.getState() as any).panes.activePaneByTabId['tb-other'];
    const otherMaximizedPaneBefore = (store.getState() as any).panes.maximizedPaneByTabId['tb-other'];

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
    // The FULL unrelated-tab projection, deep-equal before and after
    // (pre-review weak-oracle finding).
    expect(state.tabs.tabs.find((t: any) => t.id === 'tb-other')).toEqual(otherTabBefore);
    expect(state.panes.activePaneByTabId['tb-other']).toBe(otherActivePaneBefore);
    expect(state.panes.maximizedPaneByTabId['tb-other']).toBe(otherMaximizedPaneBefore);
  });

  it('re-mints a terminal id that is currently live in a DIFFERENT tab, and drops the old id rather than claiming it', async () => {
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

    // tb-new's leaf was re-minted: a FRESH id, not tm-shared.
    //
    // EXPECTATION CHANGED (pre-review HIGH). This originally asserted
    // `sessionKey === 'tm-shared'`, reasoning by analogy with the pre-014
    // migration, where preserving the old key is right because the pty-host
    // has no rename verb and the session is OURS to keep. That analogy does not
    // hold here: the id is colliding precisely because ANOTHER TAB'S LIVE
    // TERMINAL is the session the host knows by it. Carrying it made the fresh
    // spawn overwrite `session_to_process[tm-shared]` in the backend index, so
    // the original terminal's output would be routed to this new process. The
    // assertion was pinning the defect, so it is inverted here rather than
    // deleted — see the sibling test above for the full mechanism.
    const newLeaf = state.panes.treesByTabId['tb-new'];
    expect(newLeaf.terminalId).not.toBe('tm-shared');
    expect(newLeaf.terminalId).toMatch(/^tm-/);
    expect('sessionKey' in newLeaf).toBe(false);
  });

  /**
   * Regression (pre-review HIGH). A re-minted leaf must NOT carry the colliding
   * id in `sessionKey`.
   *
   * `sessionKey` means "the pty-host already knows this session by this id" —
   * and the reason we are re-minting is that another tab's STILL-RUNNING
   * terminal is the one the host knows by it. The spawn path forwards
   * `sessionKey` into `create_terminal`, and the backend's
   * `register_host_terminal` indexes `session_to_process` with an unconditional
   * insert, so carrying it here made the fresh spawn take over the live
   * terminal's routing key: every inbound frame for the original, still-visible
   * terminal would then be delivered to this new process instead.
   */
  it('a re-minted leaf carries NO sessionKey, so it cannot hijack the live terminal it collided with', async () => {
    const store = makeStore();
    (window as any).__REDUX_STORE__ = store;

    // tm-shared is LIVE in another tab.
    store.dispatch({ type: 'tabs/addTab', payload: { id: 'tb-owner', title: 'Owner' } });
    store.dispatch({
      type: 'panes/addTabTree',
      payload: { tabId: 'tb-owner', tree: { id: 'pn-owner', type: 'terminal', terminalId: 'tm-shared' } },
    });

    const savedTree = { id: 'pn-saved', type: 'terminal' as const, terminalId: 'tm-shared' };
    seedLayouts([{
      id: 'layout-collide',
      name: 'Collide',
      tabs: [{ id: 'tb-new', title: 'New' }],
      activeTabId: 'tb-new',
      paneTree: savedTree,
      activePaneId: 'pn-saved',
      treesByTabId: { 'tb-new': savedTree },
      scope: 'tab',
      scopedTabId: 'tb-new',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as SavedLayout]);

    expect(await StateManager.loadTabScopedLayout('layout-collide', store.dispatch)).toBe(true);

    const state = store.getState() as any;
    const installed = state.panes.treesByTabId['tb-new'];
    // Re-minted away from the collision...
    expect(installed.terminalId).not.toBe('tm-shared');
    expect(installed.terminalId.startsWith('tm-')).toBe(true);
    // ...and claiming nothing. `sessionKey` must be absent, not just falsy:
    // the spawn path forwards any value it finds.
    expect('sessionKey' in installed).toBe(false);
    // The live owner is untouched and keeps the id the host knows it by.
    expect(state.panes.treesByTabId['tb-owner'].terminalId).toBe('tm-shared');
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

describe('StateManager.loadTabScopedLayout refuses during a replacement (pre-review fix)', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetLayoutUndoForTests();
  });

  /**
   * Blocker (pre-review). `loadLayout`/`revertWorkspace` are wrapped by
   * `asReplacement`, which sets `replacementInFlight` from before
   * `clearCurrentState` until the transaction finishes. A tab-scoped load is
   * NOT a replacement (no generation token, no clear, no yield) — dispatched
   * into a replacement's clear-then-100ms-yield window, it used to install its
   * tab into the emptied store, which the replacement's own populate then
   * layered on top of: a workspace that is neither of the two things the user
   * asked for. `loadTabScopedLayout` now returns `false` immediately instead.
   *
   * Pinned end-to-end (NOT by poking the private flag): `loadLayout` is
   * started but not awaited, landing this test inside its clear-then-yield
   * window; the tab load is issued during that window; then the original load
   * is awaited to completion.
   */
  it('returns false while a loadLayout replacement owns the workspace, and its tab is never layered into the replacement\'s result', async () => {
    const store = makeStore();
    (window as any).__REDUX_STORE__ = store;

    seedLayouts([
      {
        id: 'layout-x',
        name: 'Workspace X',
        tabs: [{ id: 'tb-x', title: 'X' }],
        activeTabId: 'tb-x',
        paneTree: null,
        activePaneId: null,
        treesByTabId: { 'tb-x': null },
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'layout-tab',
        name: 'Tab layout',
        tabs: [{ id: 'tb-tab', title: 'Tab' }],
        activeTabId: 'tb-tab',
        paneTree: null,
        activePaneId: null,
        treesByTabId: { 'tb-tab': null },
        scope: 'tab',
        scopedTabId: 'tb-tab',
        createdAt: 1,
        updatedAt: 1,
      },
    ] as SavedLayout[]);

    // Started, NOT awaited — synchronously clears and then yields ~100ms
    // before populating. `replacementInFlight` is true by the time this
    // statement returns.
    const loadPromise = StateManager.loadLayout('layout-x', store.dispatch);

    // Dispatched DURING that window.
    const tabResult = await StateManager.loadTabScopedLayout('layout-tab', store.dispatch);
    expect(tabResult).toBe(false);

    const committed = await loadPromise;
    expect(committed).toBe(true);

    // The final workspace is EXACTLY layout-x's tabs — the refused tab load's
    // tab must NOT be present, layered on top or otherwise.
    const state = store.getState() as any;
    expect(state.tabs.tabs.map((t: any) => t.id)).toEqual(['tb-x']);
    expect(state.panes.treesByTabId['tb-tab']).toBeUndefined();
  });

  /**
   * The paired positive. Without it, a `loadTabScopedLayout` that
   * unconditionally `return false`d at the top of the method would pass the
   * negative test above vacuously.
   */
  it('returns true and installs its tab when no replacement is in flight', async () => {
    const store = makeStore();
    (window as any).__REDUX_STORE__ = store;

    seedLayouts([{
      id: 'layout-tab',
      name: 'Tab layout',
      tabs: [{ id: 'tb-tab', title: 'Tab' }],
      activeTabId: 'tb-tab',
      paneTree: null,
      activePaneId: null,
      treesByTabId: { 'tb-tab': null },
      scope: 'tab',
      scopedTabId: 'tb-tab',
      createdAt: 1,
      updatedAt: 1,
    } as SavedLayout]);

    const tabResult = await StateManager.loadTabScopedLayout('layout-tab', store.dispatch);
    expect(tabResult).toBe(true);
    expect((store.getState() as any).tabs.tabs.map((t: any) => t.id)).toEqual(['tb-tab']);
  });
});

describe('StateManager.loadTabScopedLayout re-mints colliding PANE ids (pre-review fix)', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetLayoutUndoForTests();
  });

  /**
   * Blocker (pre-review). Pane ids are assumed unique across tabs —
   * `setPaneMuted` and `paneActions.findLeafInAnyTree` both return at the
   * FIRST tab whose tree contains the id. Reachable: a saved tab layout's pane
   * id collides with a pane id currently LIVE in a DIFFERENT tab (e.g. the
   * pane was dragged between tabs after the layout was saved). `tb-other`
   * gets a DIFFERENT terminalId than the incoming layout's leaf, so this
   * isolates the PANE-id collision from the terminal-id collision the earlier
   * describe block in this file already covers.
   */
  it('re-mints a pane id that collides with a DIFFERENT tab\'s live pane, and remaps the activePaneByTabId/maximizedPaneByTabId references to it', async () => {
    const store = makeStore();
    (window as any).__REDUX_STORE__ = store;

    store.dispatch({ type: 'tabs/addTab', payload: { id: 'tb-other', title: 'Other' } });
    store.dispatch({
      type: 'panes/addTabTree',
      payload: { tabId: 'tb-other', tree: { id: 'pn-x', type: 'terminal', terminalId: 'tm-other' } },
    });

    const collidingTree = { id: 'pn-x', type: 'terminal' as const, terminalId: 'tm-new' };
    seedLayouts([{
      id: 'layout-pane-collide',
      name: 'Pane collide',
      tabs: [{ id: 'tb-new', title: 'New' }],
      activeTabId: 'tb-new',
      paneTree: collidingTree,
      activePaneId: 'pn-x',
      treesByTabId: { 'tb-new': collidingTree },
      activePaneByTabId: { 'tb-new': 'pn-x' },
      maximizedPaneByTabId: { 'tb-new': 'pn-x' },
      scope: 'tab',
      scopedTabId: 'tb-new',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as SavedLayout]);

    const ok = await StateManager.loadTabScopedLayout('layout-pane-collide', store.dispatch);
    expect(ok).toBe(true);

    const state = store.getState() as any;
    const installed = state.panes.treesByTabId['tb-new'];
    expect(installed.id).not.toBe('pn-x');
    expect(installed.id).toMatch(/^pn-/);
    // tb-other's leaf is untouched — still 'pn-x'.
    expect(state.panes.treesByTabId['tb-other'].id).toBe('pn-x');

    // These fields REFERENCE pane ids rather than containing them, so they
    // must be remapped along with the tree, not left pointing at the stale
    // 'pn-x' — which, after the load, names a DIFFERENT tab's pane.
    expect(state.panes.activePaneByTabId['tb-new']).toBe(installed.id);
    expect(state.panes.maximizedPaneByTabId['tb-new']).toBe(installed.id);
  });

  /**
   * The consequence that actually matters (pre-review HIGH). Before the fix,
   * both tabs held the pane id 'pn-x', and `setPaneMuted` — which walks
   * `treesByTabId` and acts on the FIRST tab whose tree contains the id — put
   * the mute on whichever tree happened to be walked first, not the one the
   * user actually targeted.
   */
  it('setPaneMuted after a pane-id collision mutes only the installed pane, not the tab it collided with', async () => {
    const store = makeStore();
    (window as any).__REDUX_STORE__ = store;

    store.dispatch({ type: 'tabs/addTab', payload: { id: 'tb-other', title: 'Other' } });
    store.dispatch({
      type: 'panes/addTabTree',
      payload: { tabId: 'tb-other', tree: { id: 'pn-x', type: 'terminal', terminalId: 'tm-other' } },
    });

    const collidingTree = { id: 'pn-x', type: 'terminal' as const, terminalId: 'tm-new' };
    seedLayouts([{
      id: 'layout-pane-collide-mute',
      name: 'Pane collide mute',
      tabs: [{ id: 'tb-new', title: 'New' }],
      activeTabId: 'tb-new',
      paneTree: collidingTree,
      activePaneId: 'pn-x',
      treesByTabId: { 'tb-new': collidingTree },
      scope: 'tab',
      scopedTabId: 'tb-new',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as SavedLayout]);

    expect(await StateManager.loadTabScopedLayout('layout-pane-collide-mute', store.dispatch)).toBe(true);
    const installedId = (store.getState() as any).panes.treesByTabId['tb-new'].id;

    store.dispatch({ type: 'panes/setPaneMuted', payload: { paneId: installedId, muted: true } });

    const state = store.getState() as any;
    expect(state.panes.treesByTabId['tb-other'].notifyMuted).toBeUndefined();
    expect(state.panes.treesByTabId['tb-new'].notifyMuted).toBe(true);
  });

  /**
   * The negative: a saved pane id that is NOT live in any other tab must be
   * preserved unchanged, so a reload of a tab layout onto the same tab still
   * reattaches to the pane it already has rather than being needlessly
   * re-minted every time.
   */
  it('does not re-mint a pane id that is NOT live in any other tab — a reload onto the same tab still reattaches', async () => {
    const store = makeStore();
    (window as any).__REDUX_STORE__ = store;

    store.dispatch({ type: 'tabs/addTab', payload: { id: 'tb-target', title: 'Target' } });
    store.dispatch({
      type: 'panes/addTabTree',
      payload: { tabId: 'tb-target', tree: { id: 'pn-x', type: 'terminal', terminalId: 'tm-target' } },
    });

    const savedTree = { id: 'pn-x', type: 'terminal' as const, terminalId: 'tm-target' };
    seedLayouts([{
      id: 'layout-pane-self',
      name: 'Pane self',
      tabs: [{ id: 'tb-target', title: 'Target' }],
      activeTabId: 'tb-target',
      paneTree: savedTree,
      activePaneId: 'pn-x',
      treesByTabId: { 'tb-target': savedTree },
      scope: 'tab',
      scopedTabId: 'tb-target',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as SavedLayout]);

    const ok = await StateManager.loadTabScopedLayout('layout-pane-self', store.dispatch);
    expect(ok).toBe(true);
    expect((store.getState() as any).panes.treesByTabId['tb-target'].id).toBe('pn-x');
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
