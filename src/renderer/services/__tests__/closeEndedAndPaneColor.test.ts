/**
 * @jest-environment jsdom
 */
import { configureStore } from '@reduxjs/toolkit';
import tabsReducer, { addTab, setTabTitleColor } from '../../store/slices/tabsSlice';
import panesReducer, {
  addTabTree,
  setPaneTree,
  setPaneTitleColor,
  splitPaneInTab,
  splitPaneWithTab,
  PaneNode,
} from '../../store/slices/panesSlice';
import sessionExitReducer, { markSessionClosed } from '../../store/slices/sessionExitSlice';
import {
  collectEndedNodes,
  closeAllEndedTerminals,
} from '../closeEnded';
import {
  tabEffectiveTitleColors,
  titleColorStyle,
  terminalTitleColor,
} from '../../store/titleColor';
import { terminalService } from '../TerminalService';

jest.mock('../../api/tauri-bridge', () => ({ __esModule: true, default: {} }));
jest.mock('@tauri-apps/api/core', () => ({
  invoke: jest.fn().mockResolvedValue(undefined),
  transformCallback: jest.fn((cb) => cb),
}));
jest.mock('@tauri-apps/api/event', () => ({
  listen: () => Promise.resolve(() => {}),
}));

jest.mock('../TerminalService', () => ({
  terminalService: {
    getProcessIdForTerminal: jest.fn(),
  },
}));

describe('closeEnded service', () => {
  const setupStore = () =>
    configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        sessionExit: sessionExitReducer,
      },
    });

  it('collectEndedNodes finds all ended leaves matching sessionExit', () => {
    const store = setupStore();
    store.dispatch(addTab({ id: 'tb-1', title: 'Tab 1', shellType: 'bash' }));
    store.dispatch(addTab({ id: 'tb-2', title: 'Tab 2', shellType: 'bash' }));

    const tree1: PaneNode = {
      id: 'pn-1',
      type: 'terminal',
      terminalId: 'tm-1',
      name: 'Pane 1',
    };
    const tree2: PaneNode = {
      id: 'pn-split',
      type: 'split',
      direction: 'horizontal',
      children: [
        { id: 'pn-2a', type: 'terminal', terminalId: 'tm-2a', name: 'Pane 2A' },
        { id: 'pn-2b', type: 'terminal', terminalId: 'tm-2b', name: 'Pane 2B' },
      ],
    };

    store.dispatch(addTabTree({ tabId: 'tb-1', tree: tree1 }));
    store.dispatch(addTabTree({ tabId: 'tb-2', tree: tree2 }));

    expect(collectEndedNodes(store.getState() as any)).toEqual([]);

    // Mark tm-1 and tm-2a as exited
    store.dispatch(markSessionClosed({ terminalId: 'tm-1', exitCode: 0 }));
    store.dispatch(markSessionClosed({ terminalId: 'tm-2a', exitCode: 1 }));

    const ended = collectEndedNodes(store.getState() as any);
    expect(ended).toHaveLength(2);
    expect(ended).toContainEqual({
      terminalId: 'tm-1',
      tabId: 'tb-1',
      paneId: 'pn-1',
    });
    expect(ended).toContainEqual({
      terminalId: 'tm-2a',
      tabId: 'tb-2',
      paneId: 'pn-2a',
    });
  });

  it('closeAllEndedTerminals dispatches close events for ended terminals', () => {
    // Mock window.dispatchEvent
    const dispatched: { type: string; detail: any }[] = [];
    const originalDispatch = window.dispatchEvent;
    window.dispatchEvent = jest.fn((e: Event) => {
      dispatched.push({ type: e.type, detail: (e as CustomEvent).detail });
      return true;
    });

    (terminalService.getProcessIdForTerminal as jest.Mock).mockReturnValue(undefined);

    const store = setupStore();
    store.dispatch(addTab({ id: 'tb-1', title: 'Tab 1', shellType: 'bash' }));
    store.dispatch(addTab({ id: 'tb-2', title: 'Tab 2', shellType: 'bash' }));

    const tree1: PaneNode = {
      id: 'pn-1',
      type: 'terminal',
      terminalId: 'tm-1',
      name: 'Pane 1',
    };
    const tree2: PaneNode = {
      id: 'pn-split',
      type: 'split',
      direction: 'horizontal',
      children: [
        { id: 'pn-2a', type: 'terminal', terminalId: 'tm-2a', name: 'Pane 2A' },
        { id: 'pn-2b', type: 'terminal', terminalId: 'tm-2b', name: 'Pane 2B' },
      ],
    };

    store.dispatch(addTabTree({ tabId: 'tb-1', tree: tree1 }));
    store.dispatch(addTabTree({ tabId: 'tb-2', tree: tree2 }));

    // Mark tm-1 and tm-2a as exited
    store.dispatch(markSessionClosed({ terminalId: 'tm-1', exitCode: 0 }));
    store.dispatch(markSessionClosed({ terminalId: 'tm-2a', exitCode: 1 }));

    // Mock store.getState in the service by replacing real store state or importing real store
    // Let's test with the real store from '../../store'
    const realStore = require('../../store').store;
    realStore.dispatch(addTab({ id: 'tb-real-1', title: 'Tab 1', shellType: 'bash' }));
    realStore.dispatch(addTab({ id: 'tb-real-2', title: 'Tab 2', shellType: 'bash' }));
    realStore.dispatch(addTabTree({ tabId: 'tb-real-1', tree: { id: 'pn-r1', type: 'terminal', terminalId: 'tm-r1' } }));
    realStore.dispatch(addTabTree({
      tabId: 'tb-real-2',
      tree: {
        id: 'pn-rsplit',
        type: 'split',
        direction: 'vertical',
        children: [
          { id: 'pn-r2a', type: 'terminal', terminalId: 'tm-r2a' },
          { id: 'pn-r2b', type: 'terminal', terminalId: 'tm-r2b' },
        ],
      },
    }));

    realStore.dispatch(markSessionClosed({ terminalId: 'tm-r1', exitCode: 0 }));
    realStore.dispatch(markSessionClosed({ terminalId: 'tm-r2a', exitCode: 0 }));

    closeAllEndedTerminals();

    // tm-r1 was the only pane in tb-real-1 -> dispatches ui:forceTabClose
    // tm-r2a was one of two panes in tb-real-2 -> dispatches ui:forcePaneClose
    expect(dispatched).toContainEqual({
      type: 'ui:forceTabClose',
      detail: { tabId: 'tb-real-1' },
    });
    expect(dispatched).toContainEqual({
      type: 'ui:forcePaneClose',
      detail: { paneId: 'pn-r2a' },
    });

    window.dispatchEvent = originalDispatch;
  });
});

describe('pane color and multi-color tab text', () => {
  const setupStore = () =>
    configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        sessionExit: sessionExitReducer,
      },
    });

  it('setPaneTitleColor sets and clears titleColor on PaneNode', () => {
    const store = setupStore();
    store.dispatch(addTab({ id: 'tb-1', title: 'Tab 1', shellType: 'bash' }));
    const tree: PaneNode = {
      id: 'pn-1',
      type: 'terminal',
      terminalId: 'tm-1',
      name: 'Pane 1',
    };
    store.dispatch(addTabTree({ tabId: 'tb-1', tree }));

    store.dispatch(setPaneTitleColor({ paneId: 'pn-1', titleColor: '#FF3B3B' }));
    const leaf = store.getState().panes.treesByTabId['tb-1'] as PaneNode;
    expect(leaf.titleColor).toBe('#FF3B3B');

    store.dispatch(setPaneTitleColor({ paneId: 'pn-1', titleColor: undefined }));
    const cleared = store.getState().panes.treesByTabId['tb-1'] as PaneNode;
    expect(cleared.titleColor).toBeUndefined();
  });

  it('splitPaneInTab carries over the source pane titleColor', () => {
    const store = setupStore();
    store.dispatch(addTab({ id: 'tb-1', title: 'Tab 1', shellType: 'bash' }));
    const tree: PaneNode = {
      id: 'pn-1',
      type: 'terminal',
      terminalId: 'tm-1',
      name: 'Pane 1',
      titleColor: '#3F6DFF',
    };
    store.dispatch(addTabTree({ tabId: 'tb-1', tree }));

    store.dispatch(
      splitPaneInTab({
        tabId: 'tb-1',
        paneId: 'pn-1',
        direction: 'horizontal',
        name: 'New Pane',
        terminalId: 'tm-new',
      }),
    );

    const splitRoot = store.getState().panes.treesByTabId['tb-1'] as PaneNode;
    expect(splitRoot.type).toBe('split');
    const [orig, fresh] = splitRoot.children!;
    expect(orig.titleColor).toBe('#3F6DFF');
    expect(fresh.titleColor).toBe('#3F6DFF');
  });

  it('splitPaneWithTab.fulfilled carries over titleColor', () => {
    const store = setupStore();
    store.dispatch(addTab({ id: 'tb-1', title: 'Tab 1', shellType: 'bash' }));
    const tree: PaneNode = {
      id: 'pn-1',
      type: 'terminal',
      terminalId: 'tm-1',
      name: 'Pane 1',
      titleColor: '#22C94E',
    };
    store.dispatch(addTabTree({ tabId: 'tb-1', tree }));
    store.dispatch(setPaneTree(tree));

    // Simulate splitPaneWithTab.fulfilled action
    store.dispatch({
      type: splitPaneWithTab.fulfilled.type,
      payload: {
        paneId: 'pn-1',
        direction: 'vertical',
        position: 'after',
        shellType: 'bash',
        newTerminalId: 'tm-new-2',
        uniqueTitle: 'Terminal Right',
        uniqueOriginalTitle: 'Terminal Left',
      },
    });

    const splitRoot = store.getState().panes.paneTree as PaneNode;
    expect(splitRoot.type).toBe('split');
    expect(splitRoot.titleColor).toBeUndefined();
    const [orig, fresh] = splitRoot.children!;
    expect(orig.titleColor).toBe('#22C94E');
    expect(fresh.titleColor).toBe('#22C94E');
  });

  it('terminalTitleColor prefers pane titleColor over tab titleColor', () => {
    const store = setupStore();
    store.dispatch(addTab({ id: 'tb-1', title: 'Tab 1', shellType: 'bash', titleColor: '#FF8C1A' }));
    const tree: PaneNode = {
      id: 'pn-1',
      type: 'terminal',
      terminalId: 'tm-1',
      titleColor: '#22E5FF',
    };
    store.dispatch(addTabTree({ tabId: 'tb-1', tree }));

    // Pane has explicit color -> uses pane color
    expect(terminalTitleColor(store.getState() as any, 'tm-1')).toBe('#22E5FF');

    // Remove pane color -> falls back to tab color
    store.dispatch(setPaneTitleColor({ paneId: 'pn-1', titleColor: undefined }));
    expect(terminalTitleColor(store.getState() as any, 'tm-1')).toBe('#FF8C1A');
  });

  it('tabEffectiveTitleColors returns single color when all panes have the same color', () => {
    const store = setupStore();
    store.dispatch(addTab({ id: 'tb-1', title: 'Tab 1', shellType: 'bash', titleColor: '#FF3B3B' }));
    const tree: PaneNode = {
      id: 'pn-split',
      type: 'split',
      direction: 'horizontal',
      children: [
        { id: 'pn-1', type: 'terminal', terminalId: 'tm-1' },
        { id: 'pn-2', type: 'terminal', terminalId: 'tm-2' },
      ],
    };
    store.dispatch(addTabTree({ tabId: 'tb-1', tree }));

    // Both inherit tab color #FF3B3B -> single color
    expect(tabEffectiveTitleColors(store.getState() as any, 'tb-1')).toBe('#FF3B3B');
  });

  it('tabEffectiveTitleColors returns multi-color array when panes have multiple colors', () => {
    const store = setupStore();
    store.dispatch(addTab({ id: 'tb-1', title: 'Tab 1', shellType: 'bash' }));
    const tree: PaneNode = {
      id: 'pn-split',
      type: 'split',
      direction: 'horizontal',
      children: [
        { id: 'pn-1', type: 'terminal', terminalId: 'tm-1', titleColor: '#FF3B3B' },
        { id: 'pn-2', type: 'terminal', terminalId: 'tm-2', titleColor: '#3F6DFF' },
      ],
    };
    store.dispatch(addTabTree({ tabId: 'tb-1', tree }));

    const colors = tabEffectiveTitleColors(store.getState() as any, 'tb-1');
    expect(colors).toEqual(['#FF3B3B', '#3F6DFF']);

    // titleColorStyle converts array into linear-gradient
    const style = titleColorStyle(colors);
    expect(style).toEqual({
      backgroundImage: 'linear-gradient(90deg, #FF3B3B, #3F6DFF)',
      WebkitBackgroundClip: 'text',
      backgroundClip: 'text',
      WebkitTextFillColor: 'transparent',
      color: 'transparent',
      width: 'fit-content',
      maxWidth: '100%',
    });
  });

  it('titleColorStyle handles single string and undefined', () => {
    expect(titleColorStyle('#FF3B3B')).toEqual({ color: '#FF3B3B' });
    expect(titleColorStyle(undefined)).toBeUndefined();
    expect(titleColorStyle([])).toBeUndefined();
    expect(titleColorStyle(['#FF3B3B'])).toEqual({ color: '#FF3B3B' });
  });
});
