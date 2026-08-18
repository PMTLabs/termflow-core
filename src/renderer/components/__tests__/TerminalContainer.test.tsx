/**
 * @jest-environment jsdom
 *
 * Task 2.2 (P0-A root-leaf revision, option A): an API-created tab's root pane
 * carries the backend-minted `tm-` leaf (App.tsx Mode 0), not `tab.id`. This
 * component's own default-seed effect below independently hardcodes
 * `terminalId: tab.id` for a tab with no tree yet — correct for a
 * renderer-originated tab, wrong for an API one. Today Mode 0 dispatches its
 * tree (and seeds `window.tabPanes`) SYNCHRONOUSLY before this component's
 * effects ever see the new tab, so the default-seed branch never fires for an
 * API tab. That ordering is load-bearing under option A: this pins it.
 *
 * Review 109 MEDIUM: the previous version of this test manually wrote
 * `window.tabPanes` and manually dispatched `addTabTree` BEFORE `addTab` —
 * the reverse of what App.tsx actually does — so it proved only its own
 * hand-assembled setup, not Mode 0 itself. It would still have passed if
 * Mode 0 regressed its tree or its registration key. This version drives the
 * REAL Mode 0 path via `runApiCreateMode0` (extracted from
 * `App.tsx handleAPICreateTerminalTab` for exactly this reason) and asserts
 * both the resulting tree AND that `registerExistingTerminal` was called with
 * the backend's `tm-` leaf.
 *
 * Mirrors the repo's RTL-free pattern (react-dom/client + React.act) used by
 * GlobalPeerRequests.test.tsx / SplitPane.test.tsx. PaneManager is mocked out —
 * this test is only about what TREE TerminalContainer hands it, not rendering.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import tabsReducer, { addTab, setActiveTab } from '../../store/slices/tabsSlice';
import panesReducer, {
  addTabTree, setActiveTabId, removePaneFromTab, insertPaneIntoTab,
} from '../../store/slices/panesSlice';
import { runApiCreateMode0 } from '../../services/apiCreatedTab';

jest.mock('../TerminalContainer.css', () => ({}));
jest.mock('../Settings/SettingsPage', () => ({
  SettingsPage: () => null,
}));
// Stubbed for the same reason as PaneManager: this file is about which SHELL
// TerminalContainer picks per tab, not about what the canvas draws. The stub records
// its own mount so the canvas-tab cases below can assert on it.
jest.mock('../Canvas/CanvasMode', () => ({
  CanvasMode: () => <div data-testid="canvas-mode" />,
}));
jest.mock('../Panes/PaneManager', () => ({
  PaneManager: (props: any) => (
    <div data-testid={`pane-manager-${props.tabId}`} data-terminal-id={props.paneTree?.terminalId} />
  ),
}));

// eslint-disable-next-line import/first
import { TerminalContainer } from '../TerminalContainer';

function makeStore() {
  return configureStore({ reducer: { tabs: tabsReducer, panes: panesReducer } });
}

describe('TerminalContainer — API-created tab keeps its backend tm- leaf', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    // TerminalContainer's module-scoped `tabPanes` is aliased onto
    // window.tabPanes at import time; each test starts from a clean map by
    // mutating that SAME object in place (never reassigning window.tabPanes —
    // reassigning would desync it from the component's closure, exactly the
    // bug tabPanesStore.ts exists to avoid).
    const existing = (window as any).tabPanes;
    if (existing) {
      Object.keys(existing).forEach((k) => delete existing[k]);
    } else {
      (window as any).tabPanes = {};
    }
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function mount(store: ReturnType<typeof makeStore>) {
    root = createRoot(container);
    await act(async () => {
      root.render(
        <Provider store={store}>
          <TerminalContainer />
        </Provider>,
      );
    });
  }

  it('renders the backend-minted tm- leaf, not tab.id, for an API-created tab — via the REAL Mode 0 path', async () => {
    const store = makeStore();
    const tabId = 'tb-apitab01';
    const processId = 'pc-proc0001';
    const leafId = 'tm-leaf0001';

    const registerExistingTerminal = jest.fn();

    // Drive App.tsx's actual Mode 0 handler (extracted as runApiCreateMode0),
    // with the SAME dependency shape and ordering App.tsx uses: window map
    // seeded via `deps.tabPanes`, `addTab` and `addTabTree` dispatched in the
    // same synchronous call, in that order.
    const result = runApiCreateMode0(
      {
        name: 'Terminal',
        profile: 'bash',
        processId,
        rendererTerminalId: leafId,
        owningTabId: tabId,
      },
      {
        dispatch: store.dispatch,
        generateId: (prefix: string) => `${prefix}-generated`,
        defaultProfile: 'default',
        registerExistingTerminal,
        tabPanes: (window as any).tabPanes,
        tabExists: () => false,
        activateOnApiCreate: false,
        tabCount: 1, // non-zero + activateOnApiCreate:false => background tab
        addTab,
        addTabTree,
        setActiveTab,
        setActiveTabId,
      },
    );

    expect(result.targetTabId).toBe(tabId);
    expect(result.leafId).toBe(leafId);
    // The registration App.tsx relies on for TerminalPane to reuse the PTY
    // instead of spawning a duplicate one.
    expect(registerExistingTerminal).toHaveBeenCalledWith(leafId, processId);

    await mount(store);

    const el = container.querySelector(`[data-testid="pane-manager-${tabId}"]`);
    expect(el).not.toBeNull();
    expect(el?.getAttribute('data-terminal-id')).toBe(leafId);
    expect(el?.getAttribute('data-terminal-id')).not.toBe(tabId);
  });

  it('contrast case: a plain renderer-created tab with no pre-seeded tree still defaults terminalId to tab.id', async () => {
    const store = makeStore();
    const tabId = 'tb-rendertab1';

    // No window.tabPanes / treesByTabId seed at all — this is the renderer
    // (Ctrl+T) path, where TerminalContainer's own default-seed effect is
    // expected to fire.
    store.dispatch(addTab({ id: tabId, title: 'Terminal', shellType: 'bash', icon: '🖥️' } as any));

    await mount(store);

    const el = container.querySelector(`[data-testid="pane-manager-${tabId}"]`);
    expect(el).not.toBeNull();
    expect(el?.getAttribute('data-terminal-id')).toBe(tabId);
  });
});

/**
 * Canvas Mode is a tab (`shellType: 'canvas'`, see services/openCanvas.ts). Two things
 * about that are load-bearing here, and neither is visible from the canvas directory:
 *
 *  1. It must never get a pane tree. TerminalContainer seeds one for every tab it renders,
 *     keyed on the tab's own id — and a pane tree named after the tab is what spawns a
 *     PTY. A canvas tab that reached that path would boot a shell called "Canvas".
 *  2. It must mount ONLY while active, unlike every other tab, which stays mounted in the
 *     background. Mounting CanvasMode relocates every terminal's `term.element` into a
 *     node host; a background canvas tab would hold the whole workspace's terminals inside
 *     an `opacity: 0` subtree while the user was reading a different tab, and every pane
 *     would render empty.
 */
describe('TerminalContainer — the canvas tab', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    const existing = (window as any).tabPanes;
    if (existing) Object.keys(existing).forEach((k) => delete existing[k]);
    else (window as any).tabPanes = {};
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function mountWith(store: ReturnType<typeof makeStore>) {
    root = createRoot(container);
    await act(async () => {
      root.render(
        <Provider store={store}>
          <TerminalContainer />
        </Provider>,
      );
    });
  }

  const canvasTab = { id: 'tb-canvas01', title: 'Canvas', shellType: 'canvas' } as any;
  const shellTab = { id: 'tb-shell01', title: 'Terminal', shellType: 'bash' } as any;

  it('renders CanvasMode, and no pane tree, when the canvas tab is active', async () => {
    const store = makeStore();
    store.dispatch(addTab(shellTab));
    store.dispatch(addTab(canvasTab)); // addTab activates by default

    await mountWith(store);

    expect(container.querySelector('[data-testid="canvas-mode"]')).not.toBeNull();
    // The seeding effects run for every tab, not just the active one, so this covers
    // point 1 above for both the window map and the authoritative Redux copy.
    expect((window as any).tabPanes[canvasTab.id]).toBeUndefined();
    expect(store.getState().panes.treesByTabId[canvasTab.id]).toBeUndefined();
    // ...and the ordinary tab beside it is unaffected: it keeps its tree and stays
    // mounted in the background, which is what makes handing terminals back possible.
    expect(store.getState().panes.treesByTabId[shellTab.id]).toBeDefined();
    expect(container.querySelector(`[data-testid="pane-manager-${shellTab.id}"]`)).not.toBeNull();
  });

  it('unmounts CanvasMode when another tab is activated', async () => {
    const store = makeStore();
    store.dispatch(addTab(shellTab));
    store.dispatch(addTab(canvasTab));

    await mountWith(store);
    expect(container.querySelector('[data-testid="canvas-mode"]')).not.toBeNull();

    await act(async () => { store.dispatch(setActiveTab(shellTab.id)); });

    // Gone from the tree entirely — not merely hidden. Hiding it would leave the surface
    // registry pointing at node hosts and the terminals stranded there.
    expect(container.querySelector('[data-testid="canvas-mode"]')).toBeNull();
    expect(container.querySelector(`[data-testid="pane-manager-${shellTab.id}"]`)).not.toBeNull();
  });

  it('does not mount CanvasMode for a background canvas tab', async () => {
    const store = makeStore();
    store.dispatch(addTab(canvasTab));
    store.dispatch(addTab(shellTab)); // activates the shell tab, backgrounding the canvas

    await mountWith(store);

    expect(store.getState().tabs.activeTabId).toBe(shellTab.id);
    expect(container.querySelector('[data-testid="canvas-mode"]')).toBeNull();
  });
});

/**
 * A tab emptied by canvas re-homing must render as EMPTY and stay that way.
 *
 * Tam's report — "I click Arrange and the terminals and groups are messed up" — traced to a
 * terminal that had been dragged into another group coming back to life in the one it left,
 * so it was a member of both. Two things here resurrected it, and each is pinned separately
 * because either alone reproduces the bug:
 *
 *  - the seed effect, which could not tell an emptied tab from an uninitialised one; and
 *  - this render, which fell through on a null tree to `window.tabPanes` — a mirror that is
 *    upsert-only and so still held the tree the terminal had already left.
 */
describe('TerminalContainer — a tab emptied by canvas re-homing', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    const existing = (window as any).tabPanes;
    if (existing) Object.keys(existing).forEach((k) => delete existing[k]);
    else (window as any).tabPanes = {};
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const setup = async () => {
    const store = makeStore();
    store.dispatch(addTab({ id: 'tb-keep', title: 'Windows PowerShell', shellType: 'bash' } as any));
    store.dispatch(addTab({ id: 'tb-empty', title: 'PowerShell 7 4', shellType: 'bash' } as any));
    store.dispatch(addTabTree({
      tabId: 'tb-keep', tree: { id: 'pn-k', type: 'terminal', terminalId: 'tb-keep' },
    }));
    store.dispatch(addTabTree({
      tabId: 'tb-empty', tree: { id: 'pn-e', type: 'terminal', terminalId: 'tb-empty' },
    }));
    // The mirror now holds tb-empty's tree, exactly as the store subscription leaves it.
    (window as any).tabPanes['tb-empty'] = { id: 'pn-e', type: 'terminal', terminalId: 'tb-empty' };

    // Re-home tb-empty's only terminal into tb-keep — the canvas drag, via its reducers.
    store.dispatch(removePaneFromTab({ tabId: 'tb-empty', paneId: 'pn-e' }));
    store.dispatch(insertPaneIntoTab({
      tabId: 'tb-keep', targetPaneId: 'pn-k', zone: 'right',
      node: { id: 'pn-e', type: 'terminal', terminalId: 'tb-empty' },
    }));

    root = createRoot(container);
    await act(async () => {
      root.render(
        <Provider store={store}>
          <TerminalContainer />
        </Provider>,
      );
    });
    return store;
  };

  it('renders no pane for the emptied tab, and does not refill it', async () => {
    const store = await setup();
    expect(container.querySelector('[data-testid="pane-manager-tb-empty"]')).toBeNull();
    // The seed effect had a full render to fire in; the entry must still be null.
    expect(store.getState().panes.treesByTabId['tb-empty']).toBeNull();
  });

  it('says the tab is empty rather than claiming a terminal is on its way', async () => {
    await setup();
    const tab = container.querySelector('[data-tab-id="tb-empty"]');
    expect(tab?.querySelector('.empty-state')).not.toBeNull();
    expect(tab?.querySelector('.loading-state')).toBeNull();
  });

  it('leaves the moved terminal mounted exactly once, in its new tab', async () => {
    await setup();
    const mounted = [...container.querySelectorAll('[data-terminal-id]')]
      .map((el) => el.getAttribute('data-terminal-id'))
      .filter((id) => id === 'tb-empty');
    expect(mounted).toEqual([]);           // the mock reports the ROOT leaf of each tab...
    const keep = container.querySelector('[data-testid="pane-manager-tb-keep"]');
    expect(keep).not.toBeNull();           // ...and tb-keep is now a split, so its root has none
    expect(container.querySelectorAll('[data-testid^="pane-manager-"]').length).toBe(1);
  });
});
