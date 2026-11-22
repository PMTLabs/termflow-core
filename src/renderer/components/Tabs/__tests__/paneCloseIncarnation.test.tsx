/** @jest-environment jsdom */
jest.mock('@termflow/terminal-core', () => ({ DEFAULT_THEME: {}, terminalCache: new Map() }));
jest.mock('../../Terminal/TerminalDisplay', () => ({ cleanupTerminalCache: jest.fn() }));
jest.mock('../../TerminalContainer', () => ({ clearTabPanes: jest.fn() }));
jest.mock('../../NewTabDropdown', () => ({ NewTabDropdown: () => null }));
jest.mock('../../Automation/AutomationArmedBadge', () => ({ AutomationArmedForTerminals: () => null }));
jest.mock('../../Canvas/CanvasHiddenBadge', () => ({ CanvasHiddenForTerminals: () => null }));
jest.mock('../HostGenerationMarker', () => ({ PreviousHostForTerminals: () => null }));
jest.mock('../../Terminal/ShellProfileIcon', () => ({ ShellProfileIcon: () => null }));
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { store } from '../../../store';
import { addTab, clearAllTabs } from '../../../store/slices/tabsSlice';
import { addTabTree, resetPanes } from '../../../store/slices/panesSlice';
import { PaneIncarnations, installPaneIncarnations, type PaneBridge, type PaneRequest } from '../../../services/paneIncarnations';
import { gatedBridge } from '../../../__testFixtures__/gatedBridge';
import { terminalService } from '../../../services/TerminalService';
import { TabManager } from '../TabManager';

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

test.each([1, 2])('the real tab close captures all %i copies before removal and preserves the same-leaf control', async copies => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  jest.useFakeTimers();
  const previousResizeObserver = global.ResizeObserver;
  global.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} } as any;
  store.dispatch(clearAllTabs()); store.dispatch(resetPanes());
  const gates = gatedBridge();
  const opGate = gates.command('pane_op');
  const requests: PaneRequest[] = [];
  const client = new PaneIncarnations((async (name: string, args: any) => {
    if (name === 'register_page') return { status: 'Registered', wi: 5, pg: 77 };
    requests.push(args.request); return opGate(args);
  }) as PaneBridge);
  installPaneIncarnations(client); client.attachStore(store);
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  const order: string[] = [];
  const originalCapture = client.captureClose.bind(client);
  const capture = jest.spyOn(client, 'captureClose').mockImplementation((leaf, id) => {
    expect(store.getState().tabs.tabs.map(tab => tab.id)).toContain('tb-target');
    order.push('capture'); return originalCapture(leaf, id);
  });
  const originalClose = terminalService.closeTerminal.bind(terminalService);
  const close = jest.spyOn(terminalService, 'closeTerminal').mockImplementation((leaf, pi) => {
    order.push('close'); return originalClose(leaf, pi);
  });
  let seenRemoved = false;
  const unsubscribe = store.subscribe(() => {
    if (!seenRemoved && !store.getState().tabs.tabs.some(tab => tab.id === 'tb-target')) {
      seenRemoved = true; order.push('remove');
    }
  });
  try {
    store.dispatch(addTab({ id: 'tb-control', title: 'Control' }));
    store.dispatch(addTabTree({ tabId: 'tb-control', tree: { id: 'pn-control', type: 'terminal', terminalId: 'tm-shared' } }));
    store.dispatch(addTab({ id: 'tb-target', title: 'Target' }));
    const targetIds = Array.from({ length: copies }, (_, i) => `pn-target-${i}`);
    const leaves = targetIds.map(id => ({ id, type: 'terminal' as const, terminalId: 'tm-shared' }));
    store.dispatch(addTabTree({ tabId: 'tb-target', tree: copies === 1 ? leaves[0] : { id: 'pn-split', type: 'split', children: leaves } }));
    seenRemoved = false; order.length = 0;
    for (let i = 0; i <= copies; i++) {
      await flush(); gates.release('pane_op', i, { status: 'Ack', result: { status: 'Ok' } });
    }
    await flush();
    expect(requests.map(req => req.op.kind)).toEqual(Array(copies + 1).fill('enter'));
    const controlPi = await client.capture('tm-shared', 'pn-control');
    const targetPis = targetIds.map(id => client.capture('tm-shared', id)!);
    await act(async () => { root.render(<Provider store={store}><TabManager /></Provider>); await flush(); });
    await act(async () => { window.dispatchEvent(new CustomEvent('ui:forceTabClose', { detail: { tabId: 'tb-target' } })); await flush(); });
    expect(order).toEqual([...Array(copies).fill('capture'), 'close', 'remove']);
    expect(capture.mock.calls).toEqual(targetIds.map(id => ['tm-shared', id]));
    expect(close).toHaveBeenCalledWith('tm-shared', copies === 1 ? targetPis[0] : targetPis);
    for (let i = 0; i < copies; i++) {
      expect(requests[copies + 1 + i].op).toEqual({ kind: 'close', pi: { pg: 77, seq: 2 + i } });
      gates.release('pane_op', copies + 1 + i, { status: 'Ack', result: { status: 'Ok' } }); await flush();
    }
    expect(requests.map(req => req.op.kind)).toEqual([...Array(copies + 1).fill('enter'), ...Array(copies).fill('close')]);
    expect(requests).toHaveLength(copies * 2 + 1);
    expect(await client.capture('tm-shared', 'pn-control')).toEqual(controlPi);
    expect(store.getState().tabs.tabs.map(tab => tab.id)).toEqual(['tb-control']);
  } finally {
    await act(async () => root.unmount()); container.remove(); unsubscribe();
    capture.mockRestore(); close.mockRestore(); client.stop(); installPaneIncarnations(new PaneIncarnations());
    store.dispatch(clearAllTabs()); store.dispatch(resetPanes());
    global.ResizeObserver = previousResizeObserver;
    await jest.runOnlyPendingTimersAsync();
    expect(jest.getTimerCount()).toBe(0); jest.useRealTimers();
  }
});
