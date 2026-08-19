/**
 * @jest-environment jsdom
 *
 * The group's right-click menu — the canvas half of "rename a group".
 *
 * A group is a tab, so this renames a tab, and it does it through the same `renameTab` service
 * the tab strip and the sidebar use. What is specific to the menu is the shape of the gesture:
 * the rename is an INLINE input rather than a `window.prompt`, for the reason `CanvasWireMenu`
 * already documents — a modal dialog blocks the event loop and would strand the pointer capture
 * a group drag may still hold.
 *
 * The menu portals to `document.body` (see `CanvasMenu`), so every query here is rooted there
 * rather than at the render container.
 */
jest.mock('../../../services/StateManager', () => ({
  StateManager: { saveState: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../../services/TerminalService', () => ({
  terminalService: { getProcessIdForTerminal: (terminalId: string) => `proc-${terminalId}` },
}));
/** The real service against a real store — see the note in `canvasSidebar.test.tsx`. */
jest.mock('../../../store', () => ({
  get store() { return store; },
}));

import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { configureStore, EnhancedStore } from '@reduxjs/toolkit';
import panesReducer, { PaneNode } from '../../../store/slices/panesSlice';
import tabsReducer from '../../../store/slices/tabsSlice';
// eslint-disable-next-line import/first
import { CanvasGroupMenu } from '../CanvasGroupMenu';

let container: HTMLDivElement;
let root: Root;
let store: EnhancedStore;
let onClose: jest.Mock;
let updateTerminalName: jest.Mock;

const leaf = (id: string, terminalId: string): PaneNode => ({ id, type: 'terminal', terminalId });

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  store = configureStore({
    reducer: { panes: panesReducer, tabs: tabsReducer },
    preloadedState: {
      panes: {
        paneTree: null,
        activePaneId: null,
        treesByTabId: {
          'tb-a': {
            id: 'pn-1', type: 'split', direction: 'horizontal', size: 50,
            children: [leaf('pn-2', 'tm-1'), leaf('pn-3', 'tm-2')],
          },
        },
        activeTabId: 'tb-canvas',
        activePaneByTabId: {},
        maximizedPaneByTabId: {},
      },
      tabs: {
        tabs: [{ id: 'tb-a', title: 'api', shellType: 'zsh', isActive: false }],
        activeTabId: 'tb-canvas',
      },
    } as never,
  });

  onClose = jest.fn();
  updateTerminalName = jest.fn().mockResolvedValue(true);
  (window as unknown as { electronAPI: unknown }).electronAPI = { updateTerminalName };

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (title = 'api') => {
  act(() => {
    root.render(<CanvasGroupMenu x={40} y={60} tabId="tb-a" title={title} onClose={onClose} />);
  });
};

const menu = () => document.querySelector('.canvas-menu') as HTMLElement;
const items = () => Array.from(document.querySelectorAll('.context-menu-item')) as HTMLElement[];
const item = (label: string) => items().find((b) => (b.textContent ?? '').includes(label))!;
const input = () => document.querySelector('.canvas-group-name-input') as HTMLInputElement;

const openRename = () => {
  act(() => { item('Rename Group').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  return input();
};
const typeInto = (el: HTMLInputElement, value: string) => {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const press = (el: HTMLElement, key: string) => {
  act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); });
};
const tabTitle = () =>
  (store.getState() as { tabs: { tabs: { id: string; title: string }[] } })
    .tabs.tabs.find((t) => t.id === 'tb-a')?.title;

describe('CanvasGroupMenu — the menu', () => {
  it('names the group it is acting on', () => {
    render();
    expect(menu().querySelector('.context-menu-header')?.textContent).toBe('api');
  });

  it('offers a rename', () => {
    render();
    expect(item('Rename Group')).toBeDefined();
  });

  /** Portalled, not rendered in place: `.canvas-world` sets `will-change: transform` and is
   *  therefore a stacking context, so a menu inside it cannot paint above an overlaid node. */
  it('portals out of the canvas', () => {
    render();
    expect(container.contains(menu())).toBe(false);
    expect(document.body.contains(menu())).toBe(true);
  });
});

describe('CanvasGroupMenu — renaming', () => {
  it('seeds the box with the name the group already has', () => {
    render();
    expect(openRename().value).toBe('api');
  });

  it('replaces the menu item with the box rather than showing both', () => {
    render();
    openRename();
    expect(items().some((b) => (b.textContent ?? '').includes('Rename Group'))).toBe(false);
  });

  it('renames the tab on Enter', async () => {
    render();
    const box = openRename();
    typeInto(box, 'gateway');
    press(box, 'Enter');
    await act(async () => { await Promise.resolve(); });

    expect(tabTitle()).toBe('gateway');
  });

  /** Tab-level, so every live pane of the split is renamed too — the same rule the tab strip
   *  follows, reached through the same service. */
  it('names every live backend process of the tab', async () => {
    render();
    const box = openRename();
    typeInto(box, 'gateway');
    press(box, 'Enter');
    await act(async () => { await Promise.resolve(); });

    expect(updateTerminalName.mock.calls).toEqual([
      ['proc-tm-1', 'gateway'],
      ['proc-tm-2', 'gateway'],
    ]);
  });

  it('closes itself once the rename is committed', () => {
    render();
    const box = openRename();
    typeInto(box, 'gateway');
    press(box, 'Enter');

    expect(onClose).toHaveBeenCalled();
  });

  /**
   * Escape discards. It is also stopped from propagating: the canvas has its own Escape handler
   * behind this one, and it unfocuses the terminal — so a cancelled rename would quietly do a
   * second, unrelated thing.
   */
  it('discards the draft on Escape', () => {
    render();
    const box = openRename();
    typeInto(box, 'discarded');
    press(box, 'Escape');

    expect(tabTitle()).toBe('api');
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps Escape away from the canvas handler behind it', () => {
    render();
    const box = openRename();
    const seen = jest.fn();
    window.addEventListener('keydown', seen);
    try {
      typeInto(box, 'discarded');
      press(box, 'Escape');
      expect(seen).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', seen);
    }
  });

  /** Clicking away commits, matching the sidebar's rename box and the wire menu's label box. */
  it('commits on blur', async () => {
    render();
    const box = openRename();
    typeInto(box, 'gateway');
    act(() => { box.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); });

    expect(tabTitle()).toBe('gateway');
  });

  it('refuses a blank name rather than leaving the group unnameable', async () => {
    render();
    const box = openRename();
    typeInto(box, '   ');
    press(box, 'Enter');
    await act(async () => { await Promise.resolve(); });

    expect(tabTitle()).toBe('api');
    expect(updateTerminalName).not.toHaveBeenCalled();
  });
});
