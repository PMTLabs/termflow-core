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
import { StateManager } from '../../../services/StateManager';
import { PaneIncarnations, installPaneIncarnations, type PaneBridge, type PaneRequest } from '../../../services/paneIncarnations';
import { TabManager } from '../TabManager';
const flush = async () => { for (let i = 0; i < 45; i++) await Promise.resolve(); };
const tree = (id: string) => ({ id: `pn-${id}`, type: 'terminal' as const, terminalId: `tm-${id}` });
beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  (window as any).PointerEvent = MouseEvent;
  (globalThis as any).PointerEvent = MouseEvent;
  global.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} } as any;
});
test.each(['reorder', 'outside', 'live-reorder', 'live-outside'])('tab pointer gesture retains its original members across %s', async scenario => {
  jest.useFakeTimers(); store.dispatch(clearAllTabs()); store.dispatch(resetPanes());
  const requests: PaneRequest[] = [];
  const client = new PaneIncarnations((async (command: string, args: any) => {
    if (command === 'register_page') return { status: 'Registered', wi: 4, pg: 44 };
    if (command === 'wait_transfer_taken') return true;
    requests.push(args.request); return { status: 'Ack', result: { status: 'Ok' } };
  }) as PaneBridge);
  installPaneIncarnations(client); client.attachStore(store);
  for (const id of ['source', 'target']) { store.dispatch(addTab({ id: `tb-${id}`, title: id })); store.dispatch(addTabTree({ tabId: `tb-${id}`, tree: tree(id) })); }
  const route = jest.fn().mockResolvedValue(true);
  const hide = jest.fn().mockResolvedValue(undefined);
  (window as any).electronAPI = { showDragPreview: jest.fn().mockResolvedValue(undefined), hideDragPreview: hide, moveDragPreview: jest.fn().mockResolvedValue(undefined), resolveTabDrop: route, createDetachedWindow: route };
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
  const oldFetch = global.fetch; global.fetch = jest.fn().mockRejectedValue(new Error('offline'));
  try {
    await act(async () => { root.render(<Provider store={store}><TabManager /></Provider>); await flush(); });
    const source = () => container.querySelector('[data-tab-target="tb-source"]')!;
    const target = () => container.querySelector('[data-tab-target="tb-target"]') as HTMLElement;
    document.elementFromPoint = () => target();
    act(() => source().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 20, clientY: 10 })));
    // Arm without reordering yet, so invalidation has a live preview to clean up.
    document.elementFromPoint = () => null;
    act(() => window.dispatchEvent(new MouseEvent('pointermove', { clientX: 30, clientY: 10 })));
    expect(document.body.classList.contains('tab-dragging')).toBe(true);
    const original = client.capture('tm-source', 'pn-source');
    if (!scenario.startsWith('live')) {
      const trees = { 'tb-source': tree('source'), 'tb-target': tree('target') };
      localStorage.setItem('auto-terminal-layouts', JSON.stringify([{ id: 'repeat', name: 'repeat', tabs: [{ id: 'tb-source', title: 'Replacement' }, { id: 'tb-target', title: 'Target' }], activeTabId: 'tb-source', activePaneId: 'pn-source', paneTree: trees['tb-source'], treesByTabId: trees, createdAt: Date.now(), updatedAt: Date.now() }]));
      let loading!: Promise<boolean>;
      act(() => { loading = StateManager.loadLayout('repeat', store.dispatch); });
      await act(async () => { await jest.advanceTimersByTimeAsync(100); await flush(); });
      expect(await loading).toBe(true);
      expect(client.capture('tm-source', 'pn-source')).not.toBe(original);
      expect(document.body.classList.contains('tab-dragging')).toBe(false);
    }
    const replacement = client.capture('tm-source', 'pn-source');
    document.elementFromPoint = () => target();
    await act(async () => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 100, clientY: 10 }));
      window.dispatchEvent(new MouseEvent('pointerup', { clientX: scenario.endsWith('outside') ? -10 : 100, clientY: 10 }));
      await flush();
    });
    if (scenario === 'live-reorder') expect(store.getState().tabs.tabs.map(tab => tab.id)).toEqual(['tb-target', 'tb-source']);
    else if (scenario === 'live-outside') {
      expect(route).toHaveBeenCalledTimes(1);
      expect(requests.filter(request => request.op.kind === 'stash')).toHaveLength(1);
      expect(store.getState().tabs.tabs.map(tab => tab.id)).toEqual(['tb-target']);
    } else {
      expect(store.getState().tabs.tabs.map(tab => tab.id)).toEqual(['tb-source', 'tb-target']);
      expect(client.capture('tm-source', 'pn-source')).toBe(replacement);
      expect(route).not.toHaveBeenCalled();
      expect(requests.filter(request => request.op.kind === 'stash')).toHaveLength(0);
    }
    expect(document.body.classList.contains('tab-dragging')).toBe(false);
  } finally {
    await act(async () => { root.unmount(); client.stop(); }); container.remove();
    installPaneIncarnations(new PaneIncarnations()); global.fetch = oldFetch;
    delete (window as any).electronAPI;
    // React schedules its own microtasks under fake timers; flush them before counting.
    await jest.advanceTimersByTimeAsync(0);
    expect(jest.getTimerCount()).toBe(0); jest.useRealTimers();
  }
});
