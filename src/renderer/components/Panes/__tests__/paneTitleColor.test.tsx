/**
 * @jest-environment jsdom
 *
 * A pane title wears its owning TAB's colour.
 *
 * The point of the feature is that every terminal in a tab is identifiable as part of that group,
 * so this is the surface the user looks at most — the tab strip only ever names the tab itself.
 *
 * Driven through a real `TerminalPane` against the real store, because the interesting part is
 * precisely the lookup the component already does: a pane knows its `terminalId`, and the colour
 * lives on a `Tab`, so the two are joined by walking the pane tree
 * (`findTabIdByTerminalId`). A test that handed the component a colour prop would prove the span
 * can be styled while proving nothing about whether the right tab was found.
 *
 * That same live lookup is what makes an MCP-created pane inherit for free: opening a terminal in
 * an existing tab only appends a leaf to that tab's tree, so the pane resolves the tab's CURRENT
 * colour on its first render, with nothing to copy. The `splitPaneInTab` case below drives that
 * through the real reducer the API path dispatches.
 *
 * What that case does NOT reach, stated so it is not read as more than it is: the Rust endpoint
 * (`src-tauri/src/api_server/terminals/mod.rs`) and the `App.tsx` branch that selects the reducer
 * and its arguments. Those need the API stack; this file covers the reducer onwards.
 *
 * Harness (mocks, real store, `react-dom/client` + `act`) mirrors `paneMenuTabScope.test.tsx`.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider } from 'react-redux';

jest.mock('../TerminalPane.css', () => ({}));
jest.mock('../SessionClosedBanner.css', () => ({}));

jest.mock('../../Terminal/TerminalDisplay', () => ({
  __esModule: true,
  default: () => <div data-testid="terminal-display" />,
  TerminalDisplay: () => <div data-testid="terminal-display" />,
  cleanupTerminalCache: () => {},
}));

jest.mock('../dnd/usePaneDrag', () => ({ usePaneDrag: () => () => {} }));

jest.mock('../../../services/TerminalService', () => ({
  terminalService: {
    getProcessId: () => 'pc-1',
    getProcessIdForTerminal: () => 'pc-1',
    createTerminal: jest.fn(),
    writeToTerminal: jest.fn().mockResolvedValue(undefined),
    resizeTerminal: jest.fn().mockResolvedValue(undefined),
    closeTerminal: jest.fn().mockResolvedValue(undefined),
    stashPromptGate: jest.fn(),
  },
}));

jest.mock('../../../services/AgentSchemeTracker', () => ({
  agentSchemeTracker: {
    getAgentForTerminal: () => null,
    getDetectedAgentForTerminal: () => null,
    getDetectedAgentExeForTerminal: () => null,
    refreshNow: () => Promise.resolve(),
    subscribe: () => () => {},
    start: () => {},
    stop: () => {},
  },
}));

import { TerminalPane } from '../TerminalPane';
import { PaneDragLayer } from '../dnd/PaneDragLayer';
import { store } from '../../../store';
import { addTab, setTabTitleColor } from '../../../store/slices/tabsSlice';
import { addTabTree, splitPaneInTab } from '../../../store/slices/panesSlice';
import type { PaneNode } from '../../../store/slices/panesSlice';
import { findTabIdByTerminalId } from '../../../store/slices/paneTreeOps';

const RED = '#ff5f56';
// A SECOND colour, in a second tab. Without it, `style={{ color: '#ff5f56' }}` — a component
// that ignores the tab and paints a constant — passes every coloured case in this file.
const GREEN = '#27c93f';

/** jsdom normalises an inline hex to `rgb(...)`; derive the expectation rather than hard-code it. */
const asCss = (hex: string) => {
  const probe = document.createElement('div');
  probe.style.color = hex;
  return probe.style.color;
};

const COLOURED_TAB = 'tb-colour-1';
const GREEN_TAB = 'tb-colour-2';
const PLAIN_TAB = 'tb-plain-1';
const TM_COLOURED = 'tm-colour-1';
const TM_SIBLING = 'tm-colour-2';
const TM_GREEN = 'tm-green-1';
const TM_PLAIN = 'tm-plain-1';
const TM_MCP = 'tm-colour-mcp';

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  // A coloured tab holding TWO panes: the second is what proves the colour reaches every pane in
  // the group rather than just the one that happens to share the tab's name.
  const split: PaneNode = {
    id: 'pn-root', type: 'split', direction: 'horizontal', children: [
      { id: 'pn-a', type: 'terminal', terminalId: TM_COLOURED, name: 'server' },
      { id: 'pn-b', type: 'terminal', terminalId: TM_SIBLING, name: 'worker' },
    ],
  } as PaneNode;

  store.dispatch(addTab({ id: COLOURED_TAB, title: 'api', shellType: 'zsh' } as never));
  store.dispatch(addTabTree({ tabId: COLOURED_TAB, tree: split }));
  store.dispatch(setTabTitleColor({ id: COLOURED_TAB, titleColor: RED }));

  // A second COLOURED tab, in a different colour — the control that separates "reads its tab"
  // from "paints red whenever a colour exists".
  store.dispatch(addTab({ id: GREEN_TAB, title: 'docs', shellType: 'zsh' } as never));
  store.dispatch(addTabTree({
    tabId: GREEN_TAB,
    tree: { id: 'pn-green', type: 'terminal', terminalId: TM_GREEN, name: 'docs' } as PaneNode,
  }));
  store.dispatch(setTabTitleColor({ id: GREEN_TAB, titleColor: GREEN }));

  // The negative control lives in a DIFFERENT tab, uncoloured — so "every pane title is red"
  // cannot pass this file.
  store.dispatch(addTab({ id: PLAIN_TAB, title: 'web', shellType: 'zsh' } as never));
  store.dispatch(addTabTree({
    tabId: PLAIN_TAB,
    tree: { id: 'pn-plain', type: 'terminal', terminalId: TM_PLAIN, name: 'vite' } as PaneNode,
  }));
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(terminalId: string) {
  act(() => {
    root.render(
      <Provider store={store}>
        <TerminalPane
          paneId="pane-1"
          terminalId={terminalId}
          isActive
          isTabActive
          onSplit={() => {}}
          onClose={() => {}}
          onFocus={() => {}}
        />
      </Provider>,
    );
  });
}

const paneNameColour = () =>
  (container.querySelector('.pane-name') as HTMLElement | null)?.style.color ?? null;

describe('pane title colour', () => {
  it('takes the owning tab colour, on every pane in that tab, whatever the colour', () => {
    render(TM_COLOURED);
    expect(paneNameColour()).toBe(asCss(RED));
    render(TM_SIBLING);
    expect(paneNameColour()).toBe(asCss(RED));
    // A pane in a differently-coloured tab. This is the assertion a hard-coded colour fails.
    render(TM_GREEN);
    expect(paneNameColour()).toBe(asCss(GREEN));
  });

  it('leaves a pane in an uncoloured tab on its default styling', () => {
    render(TM_PLAIN);
    expect(paneNameColour()).toBe('');
  });

  /**
   * The MCP acceptance criterion at the surface the user actually reads it on, driven through
   * the REAL reducer the API path dispatches rather than by handing the store a finished tree.
   *
   * `App.tsx`'s Mode 1 branch dispatches `splitPaneInTab` when the REST/MCP endpoint opens a
   * terminal in an existing tab. Replacing the tree wholesale would assert only that a pane in a
   * coloured tab is coloured — true already — and would keep passing if `splitPaneInTab` began
   * clearing tab metadata.
   *
   * Not covered here, and said rather than implied: the Rust endpoint and the `App.tsx` branch
   * that picks this reducer and its arguments.
   */
  it('gives a pane appended by the real splitPaneInTab reducer the tab colour', () => {
    act(() => {
      store.dispatch(splitPaneInTab({
        tabId: COLOURED_TAB, direction: 'horizontal', name: 'mcp', terminalId: TM_MCP,
      }));
    });
    // The reducer really appended the leaf; without this the colour assertion could be reporting
    // on a pane that was never added.
    expect(findTabIdByTerminalId(store.getState().panes.treesByTabId, TM_MCP)).toBe(COLOURED_TAB);
    render(TM_MCP);
    expect(paneNameColour()).toBe(asCss(RED));
  });

  // Reset is its own case because it is a DELETE of the field, not a write of a new value —
  // `setTabTitleColor` with no colour removes the key, and a component reading a stale prop
  // rather than the tab would keep painting.
  it('drops back to default styling when the tab colour is reset', () => {
    render(TM_COLOURED);
    expect(paneNameColour()).toBe(asCss(RED));
    act(() => { store.dispatch(setTabTitleColor({ id: COLOURED_TAB, titleColor: undefined })); });
    expect(paneNameColour()).toBe('');
  });
});

/**
 * The pane's TRANSIENT title surfaces: the rename box that replaces the header name, the context
 * menu that names the pane it acts on, and the drag ghost that is the title in flight.
 *
 * Each had its own colour rule already (`.pane-name-input` sets one; the ghost is fixed
 * `#e6e6e6`), so each is a place where an inline colour has to be added deliberately — the title
 * does not simply inherit.
 */
describe('pane transient title surfaces', () => {
  // The reset case above CLEARS this tab's colour and the store is shared across the file, so
  // re-establish it rather than depending on which tests ran first. Without this the whole block
  // passes or fails on declaration order, which is not a property of the code under test.
  beforeEach(() => {
    store.dispatch(setTabTitleColor({ id: COLOURED_TAB, titleColor: RED }));
  });

  const q = (sel: string) =>
    (document.body.querySelector(sel) as HTMLElement | null)?.style.color ?? null;

  it('keeps the colour in the rename box that REPLACES the pane name', () => {
    render(TM_COLOURED);
    const name = container.querySelector('.pane-name')!;
    act(() => { name.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    expect(container.querySelector('.pane-name-input')).not.toBeNull();
    expect((container.querySelector('.pane-name-input') as HTMLElement).style.color).toBe(asCss(RED));
  });

  it('keeps the GREEN tab colour in the rename box that REPLACES the pane name', () => {
    render(TM_GREEN);
    const name = container.querySelector('.pane-name')!;
    act(() => { name.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    expect((container.querySelector('.pane-name-input') as HTMLElement).style.color).toBe(asCss(GREEN));
  });

  it('leaves the rename box bare for an uncoloured tab', () => {
    render(TM_PLAIN);
    const name = container.querySelector('.pane-name')!;
    act(() => { name.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    expect((container.querySelector('.pane-name-input') as HTMLElement).style.color).toBe('');
  });

  it('names the pane in its own tab colour in the context menu', () => {
    render(TM_COLOURED);
    const header = container.querySelector('.terminal-pane-header')!;
    act(() => {
      header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }));
    });
    // The menu portals to document.body — see `paneMenuTabScope.test.tsx`.
    expect(q('.pane-context-menu .context-menu-header strong')).toBe(asCss(RED));
  });

  it('names a GREEN pane in its own tab colour in the context menu', () => {
    render(TM_GREEN);
    const header = container.querySelector('.terminal-pane-header')!;
    act(() => {
      header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }));
    });
    expect(q('.pane-context-menu .context-menu-header strong')).toBe(asCss(GREEN));
  });

  it('leaves an uncoloured pane bare in the context menu', () => {
    render(TM_PLAIN);
    const header = container.querySelector('.terminal-pane-header')!;
    act(() => {
      header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }));
    });
    expect(q('.pane-context-menu .context-menu-header strong')).toBe('');
  });

  /**
   * The ghost takes the SOURCE tab's colour. Two tabs with different colours, so a ghost wired to
   * "the active tab" or to a constant fails: the pane still belongs to the tab it left until the
   * drop commits.
   */
  it('carries the source tab colour on the drag ghost', () => {
    const drag = (sourceTabId: string) => ({
      source: { terminalId: 'tm-x', sourcePaneId: 'pn-x', sourceTabId, name: 'server' },
      pointer: { x: 10, y: 10 },
      target: null,
      outsideWindow: false,
    }) as never;
    act(() => { root.render(<Provider store={store}><PaneDragLayer drag={drag(COLOURED_TAB)} /></Provider>); });
    expect((container.querySelector('.pane-drag-ghost') as HTMLElement).style.color).toBe(asCss(RED));
    act(() => { root.render(<Provider store={store}><PaneDragLayer drag={drag(GREEN_TAB)} /></Provider>); });
    expect((container.querySelector('.pane-drag-ghost') as HTMLElement).style.color).toBe(asCss(GREEN));
    act(() => { root.render(<Provider store={store}><PaneDragLayer drag={drag(PLAIN_TAB)} /></Provider>); });
    expect((container.querySelector('.pane-drag-ghost') as HTMLElement).style.color).toBe('');
  });
});
