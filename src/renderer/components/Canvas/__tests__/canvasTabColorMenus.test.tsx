/**
 * @jest-environment jsdom
 *
 * The tab colour on the canvas's TRANSIENT surfaces — the three right-click menus.
 *
 * These are a different class from the node and frame labels (`canvasTabColor.test.tsx`): they
 * appear only while you are acting on a terminal, and each one had its own colour rule already, so
 * the question is not "does the model carry a colour" but "does the surface that names the thing
 * you are about to act on agree with the thing itself".
 *
 * Every coloured case drives TWO different colours. One colour is satisfied by a hard-coded
 * constant, which is the cheapest wrong implementation of a feature whose entire content is
 * "which colour".
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore, EnhancedStore } from '@reduxjs/toolkit';
import canvasReducer from '../../../store/slices/canvasSlice';
import panesReducer from '../../../store/slices/panesSlice';
import tabsReducer from '../../../store/slices/tabsSlice';
import { CanvasNodeMenu } from '../CanvasNodeMenu';
import { CanvasGroupMenu } from '../CanvasGroupMenu';
import { CanvasWireMenu } from '../CanvasWireMenu';

jest.mock('../../../services/canvasGraph', () => ({
  deleteEdge: jest.fn().mockResolvedValue(true),
  patchEdgeLabel: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../../services/renameTab', () => ({ renameTab: jest.fn().mockResolvedValue(true) }));
// The automations section polls the backend for this terminal's rules; irrelevant here.
jest.mock('../../Automation/AutomationMenuSection', () => ({
  AutomationMenuSection: () => null,
}));

const RED = '#ff5f56';
const GREEN = '#27c93f';

const asCss = (hex: string) => {
  const probe = document.createElement('div');
  probe.style.color = hex;
  return probe.style.color;
};

let container: HTMLDivElement;
let root: Root;
let store: EnhancedStore;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  store = configureStore({
    reducer: { canvas: canvasReducer, panes: panesReducer, tabs: tabsReducer },
    preloadedState: {
      tabs: {
        tabs: [
          { id: 'tb-a', title: 'api', shellType: 'zsh', isActive: false, titleColor: RED },
          { id: 'tb-b', title: 'web', shellType: 'zsh', isActive: false, titleColor: GREEN },
        ],
        activeTabId: 'tb-a',
      },
      panes: {
        paneTree: null,
        activePaneId: null,
        treesByTabId: {
          'tb-a': { id: 'pn-1', type: 'terminal', terminalId: 'tm-1', name: 'server' },
          'tb-b': { id: 'pn-2', type: 'terminal', terminalId: 'tm-2', name: 'vite' },
        },
        activeTabId: 'tb-a',
        activePaneByTabId: {},
        maximizedPaneByTabId: {},
      },
    } as never,
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (ui: React.ReactNode) => {
  act(() => { root.render(<Provider store={store}>{ui}</Provider>); });
};

/** Menus portal to `document.body`, so query there rather than in the mount container. */
const colourOf = (sel: string) =>
  (document.body.querySelector(sel) as HTMLElement | null)?.style.color ?? null;
const colours = (sel: string) =>
  Array.from(document.body.querySelectorAll<HTMLElement>(sel)).map((e) => e.style.color);

const noop = () => {};

describe('CanvasNodeMenu header colour', () => {
  const menu = (titleColor?: string) => (
    <CanvasNodeMenu
      x={10} y={10} title="server" titleColor={titleColor} terminalId="tm-1"
      overlaid={false} hidden={false}
      onToggleHide={noop} onToggleOverlay={noop} onOpenAsTab={noop}
      onCloseTerminal={noop} onDismiss={noop}
    />
  );

  it('names the terminal in its owning tab\'s colour, whatever the colour', () => {
    render(menu(RED));
    expect(colourOf('.context-menu-header')).toBe(asCss(RED));
    render(menu(GREEN));
    expect(colourOf('.context-menu-header')).toBe(asCss(GREEN));
  });

  it('leaves the header bare for an uncoloured tab', () => {
    render(menu(undefined));
    expect(colourOf('.context-menu-header')).toBe('');
  });
});

describe('CanvasGroupMenu colour', () => {
  const menu = (titleColor?: string) => (
    <CanvasGroupMenu x={10} y={10} tabId="tb-a" title="api" titleColor={titleColor} onClose={noop} />
  );

  it('colours the header, and the rename box that REPLACES it', () => {
    render(menu(RED));
    expect(colourOf('.context-menu-header')).toBe(asCss(RED));
    // Open the rename box — the input has its own CSS colour, so this is the case that would
    // silently lose the colour mid-edit.
    const renameItem = [...document.body.querySelectorAll<HTMLElement>('.context-menu-item')]
      .find((el) => /rename/i.test(el.textContent ?? ''));
    expect(renameItem).toBeTruthy();
    act(() => { renameItem!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(colourOf('.canvas-group-name-input')).toBe(asCss(RED));
  });

  it('uses the tab\'s own colour rather than a constant', () => {
    render(menu(GREEN));
    expect(colourOf('.context-menu-header')).toBe(asCss(GREEN));
  });

  it('keeps GREEN on the rename box that REPLACES the group header', () => {
    render(menu(GREEN));
    const renameItem = [...document.body.querySelectorAll<HTMLElement>('.context-menu-item')]
      .find((el) => /rename/i.test(el.textContent ?? ''));
    expect(renameItem).toBeTruthy();
    act(() => { renameItem!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(colourOf('.canvas-group-name-input')).toBe(asCss(GREEN));
  });

  it('leaves header and box bare for an uncoloured tab', () => {
    render(menu(undefined));
    expect(colourOf('.context-menu-header')).toBe('');
    const renameItem = [...document.body.querySelectorAll<HTMLElement>('.context-menu-item')]
      .find((el) => /rename/i.test(el.textContent ?? ''));
    act(() => { renameItem!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(colourOf('.canvas-group-name-input')).toBe('');
  });
});

describe('CanvasWireMenu endpoint colours', () => {
  const edge = { id: 'ed-1', from: 'tm-1', to: 'tm-2', label: null } as never;

  /**
   * The endpoints are coloured INDEPENDENTLY, and this is the case that proves it matters: a wire
   * exists to join terminals in different tabs, so one colour for the whole header would assert
   * that both ends belong to whichever group won.
   */
  it('gives each endpoint its own tab colour', () => {
    render(<CanvasWireMenu x={10} y={10} edge={edge} fromTitle="server" toTitle="vite" onClose={noop} />);
    expect(colours('.canvas-wire-endpoint')).toEqual([asCss(RED), asCss(GREEN)]);
  });

  it('leaves an endpoint bare when its tab has no colour', () => {
    act(() => {
      store.dispatch({ type: 'tabs/setTabTitleColor', payload: { id: 'tb-b', titleColor: undefined } });
    });
    render(<CanvasWireMenu x={10} y={10} edge={edge} fromTitle="server" toTitle="vite" onClose={noop} />);
    // The FIRST is still coloured: this is a per-endpoint decision, not an all-or-nothing one.
    expect(colours('.canvas-wire-endpoint')).toEqual([asCss(RED), '']);
  });
});
