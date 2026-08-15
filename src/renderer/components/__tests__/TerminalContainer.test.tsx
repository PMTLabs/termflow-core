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
import panesReducer, { addTabTree, setActiveTabId } from '../../store/slices/panesSlice';
import { runApiCreateMode0 } from '../../services/apiCreatedTab';

jest.mock('../TerminalContainer.css', () => ({}));
jest.mock('../Settings/SettingsPage', () => ({
  SettingsPage: () => null,
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
