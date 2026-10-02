/** @jest-environment jsdom */
jest.mock('@termflow/terminal-core', () => ({ DEFAULT_THEME: {}, terminalCache: new Map() }));
jest.mock('../../Terminal/TerminalDisplay', () => ({ cleanupTerminalCache: jest.fn() }));
jest.mock('../../TerminalContainer', () => ({ clearTabPanes: jest.fn() }));
jest.mock('../TerminalPane', () => ({ TerminalPane: () => null }));
jest.mock('../../NewTabDropdown', () => ({ NewTabDropdown: () => null }));
jest.mock('../../UI/ConfirmDialog', () => ({ ConfirmDialog: ({ isOpen, onConfirm }: any) => isOpen ? <button data-confirm onClick={onConfirm}>Confirm</button> : null }));
jest.mock('../../Automation/AutomationArmedBadge', () => ({ AutomationArmedForTerminals: () => null }));
jest.mock('../../Canvas/CanvasHiddenBadge', () => ({ CanvasHiddenForTerminals: () => null }));
jest.mock('../../Tabs/HostGenerationMarker', () => ({ PreviousHostForTerminals: () => null }));
jest.mock('../../Terminal/ShellProfileIcon', () => ({ ShellProfileIcon: () => null }));
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider, useSelector } from 'react-redux';
import { store, type RootState } from '../../../store';
import { addTab, clearAllTabs } from '../../../store/slices/tabsSlice';
import { addTabTree, removeTabTree, resetPanes } from '../../../store/slices/panesSlice';
import { TabManager } from '../../Tabs/TabManager';
import { PaneManager } from '../PaneManager';
import { PaneIncarnations, installPaneIncarnations, type PaneBridge, type PaneRequest } from '../../../services/paneIncarnations';
import { terminalService } from '../../../services/TerminalService';
const tree = { id: 'pn-source', type: 'terminal' as const, terminalId: 'tm-source' };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
test.each(['pane', 'tab'])('%s confirmation preserves a replacement copy and closes an unchanged control', async kind => {
  const previousResizeObserver = global.ResizeObserver;
  global.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} } as any;
  store.dispatch(clearAllTabs()); store.dispatch(resetPanes());
  const requests: PaneRequest[] = [];
  const client = new PaneIncarnations((async (command: string, args: any) => {
    if (command === 'register_page') return { status: 'Registered', wi: 4, pg: 44 };
    requests.push(args.request);
    return { status: 'Ack', result: { status: 'Ok' } };
  }) as PaneBridge);
  installPaneIncarnations(client); client.attachStore(store);
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
  const Harness = () => {
    const current = useSelector((state: RootState) => state.panes.treesByTabId['tb-source']);
    return kind === 'tab' ? <TabManager /> : <PaneManager tabId="tb-source" paneTree={current} />;
  };
  const seed = () => { store.dispatch(addTab({ id: 'tb-source', title: 'Source' })); store.dispatch(addTabTree({ tabId: 'tb-source', tree })); };
  const request = async () => { await act(async () => { window.dispatchEvent(new CustomEvent(kind === 'tab' ? 'ui:requestTabClose' : 'ui:requestPaneClose', { detail: kind === 'tab' ? { tabId: 'tb-source' } : { paneId: 'pn-source' } })); await flush(); }); };
  try {
    seed(); await flush(); await act(async () => root.render(<Provider store={store}><Harness /></Provider>));
    await request(); expect(container.querySelector('[data-confirm]')).not.toBeNull();
    await act(async () => { (container.querySelector('[data-confirm]') as HTMLButtonElement).click(); await flush(); });
    expect(requests.filter(request => request.op.kind === 'close')).toHaveLength(1);
    expect(client.capture('tm-source', 'pn-source')).toBeUndefined();
    act(() => seed()); await flush();
    const original = client.capture('tm-source', 'pn-source');
    await request();
    act(() => { store.dispatch(removeTabTree('tb-source')); store.dispatch(addTabTree({ tabId: 'tb-source', tree: { ...tree, name: 'Replacement' } })); }); await flush();
    const replacement = client.capture('tm-source', 'pn-source');
    expect(replacement).toBeDefined(); expect(replacement).not.toBe(original);
    terminalService.registerExistingTerminal('tm-source', 'pc-replacement');
    await act(async () => { (container.querySelector('[data-confirm]') as HTMLButtonElement).click(); await flush(); });
    expect(requests.filter(request => request.op.kind === 'close')).toHaveLength(1);
    expect(store.getState().panes.treesByTabId['tb-source']).toMatchObject({ ...tree, name: 'Replacement' });
    expect(store.getState().tabs.tabs.map(tab => tab.id)).toContain('tb-source');
    expect(client.capture('tm-source', 'pn-source')).toBe(replacement);
    expect(terminalService.getProcessId('tm-source')).toBe('pc-replacement');
  } finally {
    await act(async () => { root.unmount(); client.stop(); }); container.remove();
    terminalService.detachTerminal('tm-source'); installPaneIncarnations(new PaneIncarnations());
    store.dispatch(clearAllTabs()); store.dispatch(resetPanes()); global.ResizeObserver = previousResizeObserver;
  }
});
