/**
 * @jest-environment jsdom
 *
 * The pane-title menu's submenus (Pane Color, Open admin Tab, the agent Color scheme) are hover
 * FLYOUTS like the tab menu's and the terminal menu's, not inline accordions that push the rows
 * below them down. Same harness as `paneContextMenuFind.test.tsx`.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import tabsReducer, { addTab } from '../../../store/slices/tabsSlice';
import panesReducer, { addTabTree } from '../../../store/slices/panesSlice';
import settingsReducer from '../../../store/slices/settingsSlice';
import { findLeaf } from '../../../store/slices/paneTreeOps';
import { TAB_NAME_COLORS } from '../../../store/titleColor';
import { HOVER_CLOSE_DELAY_MS, SUBMENU_HOVER_OPEN_DELAY_MS } from '../../Terminal/ContextMenu';
import { PaneContextMenu } from '../PaneContextMenu';

jest.mock('../../../api/tauri-bridge', () => ({ __esModule: true, default: {} }));
jest.mock('../../../services/AgentSchemeTracker', () => ({
  agentSchemeTracker: {
    getDetectedAgentForTerminal: () => null,
    refreshNow: () => Promise.resolve(),
    subscribe: () => () => {},
  },
}));
jest.mock('../../../services/paneActions', () => ({
  openNewTabWithDefaultProfile: jest.fn(),
  openNewWindow: jest.fn(),
  splitPaneById: jest.fn(),
}));

let container: HTMLDivElement;
let root: Root;
let onClose: jest.Mock;
let store: ReturnType<typeof makeStore>;
let paneId: string;
let tabId: string;

function makeStore() {
  return configureStore({
    reducer: { tabs: tabsReducer, panes: panesReducer, settings: settingsReducer },
  });
}

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  jest.useFakeTimers();
  store = makeStore();
  act(() => {
    store.dispatch(addTab({ id: 'tb-1', title: 'Tab 1', shellType: 'default' }));
    store.dispatch(addTabTree({
      tabId: 'tb-1',
      tree: { id: 'pn-1', type: 'terminal', terminalId: 'tm-1' },
    }));
  });
  tabId = 'tb-1';
  paneId = 'pn-1';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  onClose = jest.fn();
  act(() => {
    root.render(
      <Provider store={store}>
        <PaneContextMenu
          x={10}
          y={20}
          paneId={paneId}
          paneName="Pane 1"
          terminalId="tm-1"
          owningTabId={tabId}
          onClose={onClose}
        />
      </Provider>,
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  jest.useRealTimers();
});

const paneColorItem = () =>
  [...document.querySelectorAll<HTMLButtonElement>('.pane-context-menu .context-menu-item')]
    .find((b) => b.textContent?.includes('Pane Color'))!;
const flyout = () => document.querySelector('.pane-context-menu .submenu-flyout-panel');
const advance = (ms: number) => act(() => { jest.advanceTimersByTime(ms); });

describe('PaneContextMenu submenu flyouts', () => {
  it('renders Pane Color as a flyout host, closed by default, with no inline subpanel', () => {
    expect(paneColorItem().closest('.submenu-flyout-host')).not.toBeNull();
    expect(flyout()).toBeNull();
    expect(document.querySelector('.pane-context-menu > .context-menu-subpanel')).toBeNull();
  });

  it('opens on a click immediately and never toggles shut on a second click', () => {
    act(() => { paneColorItem().click(); });
    expect(flyout()).not.toBeNull();
    act(() => { paneColorItem().click(); });
    expect(flyout()).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('opens on hover only after the debounce, so a quick sweep does not pop it', () => {
    act(() => {
      paneColorItem().dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      paneColorItem().dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    });
    advance(SUBMENU_HOVER_OPEN_DELAY_MS - 1);
    expect(flyout()).toBeNull();
    advance(1);
    expect(flyout()).not.toBeNull();
  });

  it('shows every palette colour in the flyout and marks the pane\'s current one active', () => {
    act(() => { paneColorItem().click(); });
    const dots = [...document.querySelectorAll<HTMLButtonElement>('.submenu-flyout-panel .tab-color-dot')];
    expect(dots).toHaveLength(TAB_NAME_COLORS.length);
    act(() => { dots[2].click(); });
    const leaf = findLeaf(store.getState().panes.treesByTabId[tabId], paneId) as { titleColor?: string };
    expect(leaf.titleColor).toBe(TAB_NAME_COLORS[2].hex);
    expect(
      document.querySelectorAll('.submenu-flyout-panel .tab-color-dot.active'),
    ).toHaveLength(1);
    // Picking a swatch keeps the menu open so the header preview can be watched.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes the flyout on Escape first, and the whole menu on the next Escape', () => {
    act(() => { paneColorItem().click(); });
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(flyout()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders Automation as a flyout, with "Add to an existing automation" nested inside it', () => {
    const automationItem = () =>
      [...document.querySelectorAll<HTMLButtonElement>('.pane-context-menu .submenu-flyout-host > .context-menu-item')]
        .find((b) => /utomation/.test(b.textContent ?? '') && !/existing/.test(b.textContent ?? ''))!;
    expect(automationItem()).toBeDefined();
    // Closed: no inline accordion panel anywhere in the menu.
    expect(document.querySelector('.pane-context-menu .context-menu-subpanel')).toBeNull();
    act(() => { automationItem().click(); });
    const panel = document.querySelector('.pane-context-menu .submenu-flyout-panel--automation')!;
    expect(panel).not.toBeNull();
    const nestedTrigger = [...panel.querySelectorAll<HTMLButtonElement>('.submenu-flyout-host > .context-menu-item')]
      .find((b) => /existing/.test(b.textContent ?? ''))!;
    expect(nestedTrigger).toBeDefined();
    expect(panel.querySelector('.submenu-flyout-panel')).toBeNull();
    act(() => { nestedTrigger.click(); });
    expect(panel.querySelector('.submenu-flyout-panel')).not.toBeNull();
    expect(document.querySelector('.pane-context-menu .context-menu-subpanel')).toBeNull();
    // One slot: opening Pane Color retires the Automation flyout.
    act(() => { paneColorItem().click(); });
    expect(document.querySelector('.pane-context-menu .submenu-flyout-panel--automation')).toBeNull();
  });

  it('closes the flyout once the pointer leaves it for the grace period', () => {
    act(() => { paneColorItem().click(); });
    const host = paneColorItem().closest('.submenu-flyout-host')!;
    act(() => { host.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })); });
    act(() => { host.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false })); });
    advance(HOVER_CLOSE_DELAY_MS);
    expect(flyout()).toBeNull();
  });
});
