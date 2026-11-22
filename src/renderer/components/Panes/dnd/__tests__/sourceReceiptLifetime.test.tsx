/** @jest-environment jsdom */
jest.mock('@termflow/terminal-core', () => ({ DEFAULT_THEME: {}, terminalCache: new Map() }));
jest.mock('../../../TerminalContainer', () => ({ clearTabPanes: jest.fn() }));
const handlers = new Map<string, (event: any) => void>();
jest.mock('@tauri-apps/api/event', () => ({ listen: jest.fn(async (name, handler) => { handlers.set(name, handler); return () => handlers.delete(name); }) }));
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { store } from '../../../../store';
import { addTab, clearAllTabs } from '../../../../store/slices/tabsSlice';
import { addTabTree, resetPanes, insertPaneIntoTab, removeTabTree } from '../../../../store/slices/panesSlice';
import { PaneIncarnations, installPaneIncarnations, type PaneBridge, type PaneRequest } from '../../../../services/paneIncarnations';
import { terminalService } from '../../../../services/TerminalService';
import { StateManager } from '../../../../services/StateManager';
import { captureWorkspace } from '../../../../services/workspaceReplacement';
import { PaneDragProvider, usePaneDragContext } from '../PaneDragController';
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const tree = (id: string) => ({ id: `pn-${id}`, type: 'terminal' as const, terminalId: `tm-${id}` });
const Press = () => {
  const { beginPress } = usePaneDragContext();
  return <button onPointerDown={event => beginPress(event, { sourceTabId: 'tb-source', sourcePaneId: 'pn-source', terminalId: 'tm-source', name: 'Source', shellType: 'default' })}>Press</button>;
};
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; (window as any).PointerEvent = MouseEvent; });

async function harness() {
  jest.useFakeTimers(); handlers.clear(); store.dispatch(clearAllTabs()); store.dispatch(resetPanes());
  const requests: PaneRequest[] = [];
  let outcome!: (taken: boolean) => void;
  const wait = jest.fn(() => new Promise<boolean>(resolve => { outcome = resolve; }));
  const client = new PaneIncarnations((async (command: string, args: any) => {
    if (command === 'register_page') return { status: 'Registered', wi: 6, pg: 60 };
    if (command === 'wait_transfer_taken') return wait(args);
    requests.push(args.request); return { status: 'Ack', result: { status: 'Ok' } };
  }) as PaneBridge);
  installPaneIncarnations(client); client.attachStore(store);
  for (const id of ['source', 'control']) {
    store.dispatch(addTab({ id: `tb-${id}`, title: id })); store.dispatch(addTabTree({ tabId: `tb-${id}`, tree: tree(id) }));
    terminalService.registerExistingTerminal(`tm-${id}`, `pc-${id}`);
  }
  const api = { beginGlobalPaneDrag: jest.fn().mockResolvedValue(undefined), cancelGlobalPaneDrag: jest.fn().mockResolvedValue(undefined), resolveOrphanGlobalDrag: jest.fn().mockResolvedValue(false), createDetachedWindow: jest.fn().mockResolvedValue(undefined), adoptConsoleWindow: jest.fn().mockResolvedValue(undefined) };
  (window as any).electronAPI = api; (window as any).__REDUX_STORE__ = store;
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
  document.elementFromPoint = () => null;
  await act(async () => { root.render(<Provider store={store}><PaneDragProvider><Press /></PaneDragProvider></Provider>); await flush(); });
  expect(handlers.size).toBe(3);
  const press = () => act(() => container.querySelector('button')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 20, clientY: 20 })));
  const outside = async () => act(async () => { window.dispatchEvent(new MouseEvent('pointermove', { clientX: -20, clientY: 20 })); await flush(); });
  const event = async (name: string, payload: unknown) => act(async () => { handlers.get(name)!({ payload }); await flush(); });
  const finish = async (taken: boolean) => act(async () => { outcome(taken); await flush(); });
  const cleanup = async () => {
    await act(async () => { root.unmount(); client.stop(); await flush(); }); container.remove();
    installPaneIncarnations(new PaneIncarnations());
    for (const id of ['source', 'control', 'sibling']) terminalService.detachTerminal(`tm-${id}`);
    delete (window as any).electronAPI; document.body.classList.remove('pane-dragging');
    await jest.advanceTimersByTimeAsync(0); expect(jest.getTimerCount()).toBe(0); jest.useRealTimers();
  };
  return { client, requests, wait, api, press, outside, event, finish, cleanup };
}

test.each(['ended-first', 'claimed-first', 'pointerup-claimed', 'rollback', 'orphan'])('mounted source consumes its staged receipt once with %s', async ordering => {
  const h = await harness();
  const detach = jest.spyOn(terminalService, 'detachTerminal');
  const dispatch = jest.spyOn(store, 'dispatch');
  try {
    const original = h.client.capture('tm-source', 'pn-source')!;
    const control = h.client.capture('tm-control', 'pn-control');
    h.press(); await h.outside();
    expect(h.api.beginGlobalPaneDrag).toHaveBeenCalledTimes(1);
    const token = h.api.beginGlobalPaneDrag.mock.calls[0][0];
    expect(h.requests.filter(request => request.op.kind === 'stash').map(request => request.op)).toEqual([
      expect.objectContaining({ kind: 'stash', tx: token, pairs: [expect.objectContaining({ leaf: 'tm-source', paneId: 'pn-source', pi: await original })] }),
    ]);
    expect(h.wait).toHaveBeenCalledTimes(1);
    expect(h.client.isSuppressed(original)).toBe(true);
    expect(document.body.classList.contains('pane-dragging')).toBe(true);
    await act(async () => {
      store.dispatch(insertPaneIntoTab({ tabId: 'tb-source', targetPaneId: 'pn-source', zone: 'right', node: tree('sibling') }));
      terminalService.registerExistingTerminal('tm-sibling', 'pc-sibling'); await flush();
    });
    const sibling = h.client.capture('tm-sibling', 'pn-sibling'); expect(sibling).toBeDefined();
    if (ordering === 'pointerup-claimed' || ordering === 'orphan') act(() => window.dispatchEvent(new MouseEvent('pointerup', { clientX: -20, clientY: 20 })));
    if (ordering === 'orphan') h.api.resolveOrphanGlobalDrag.mockResolvedValue(true);
    else {
      if (ordering === 'claimed-first') await h.event('pane-drag:claimed', { token, wi: 6, pg: 60 });
      await h.event('pane-drag:ended', token);
      if (ordering !== 'claimed-first' && ordering !== 'rollback') await h.event('pane-drag:claimed', { token, wi: 6, pg: 60 });
    }
    expect(terminalService.getProcessId('tm-source')).toBe('pc-source');
    expect(h.requests.filter(request => request.op.kind === 'cancel')).toHaveLength(0);
    if (ordering === 'pointerup-claimed' || ordering === 'orphan') await act(async () => { await jest.advanceTimersByTimeAsync(160); await flush(); });
    expect(h.api.resolveOrphanGlobalDrag).toHaveBeenCalledTimes(ordering === 'pointerup-claimed' || ordering === 'orphan' ? 1 : 0);
    expect(h.api.createDetachedWindow).toHaveBeenCalledTimes(ordering === 'orphan' ? 1 : 0);
    await h.finish(ordering !== 'rollback');
    const removals = (dispatch as jest.Mock).mock.calls.filter(([action]) => action.type === 'panes/removePaneFromTab');
    expect(removals.map(([action]) => action.payload)).toEqual(ordering === 'rollback' ? [] : [{ tabId: 'tb-source', paneId: 'pn-source' }]);
    if (ordering === 'rollback') {
      expect(h.requests.filter(request => request.op.kind === 'cancel').map(request => request.op)).toEqual([{ kind: 'cancel', tx: token }]);
      expect(h.client.capture('tm-source', 'pn-source')).not.toBe(original);
      expect(h.requests.filter(request => request.op.kind === 'bind').map(request => request.op)).toEqual([{ kind: 'bind', pi: await h.client.capture('tm-source', 'pn-source'), pc: 'pc-source', via: 'transfer' }]);
      expect(terminalService.getProcessId('tm-source')).toBe('pc-source');
    } else {
      expect(store.getState().panes.treesByTabId['tb-source']).toMatchObject(tree('sibling'));
      expect(terminalService.getProcessId('tm-source')).toBeUndefined();
      expect(detach.mock.calls.filter(([leaf]) => leaf === 'tm-source')).toHaveLength(1);
      await h.event('pane-drag:claimed', { token, wi: 6, pg: 60 }); await h.event('pane-drag:ended', token);
      expect((dispatch as jest.Mock).mock.calls.filter(([action]) => action.type === 'panes/removePaneFromTab')).toHaveLength(1);
    }
    expect(h.client.capture('tm-control', 'pn-control')).toBe(control);
    expect(h.client.capture('tm-sibling', 'pn-sibling')).toBe(sibling);
    expect(terminalService.getProcessId('tm-control')).toBe('pc-control');
    expect(terminalService.getProcessId('tm-sibling')).toBe('pc-sibling');
    expect(document.body.classList.contains('pane-dragging')).toBe(false);
  } finally { dispatch.mockRestore(); detach.mockRestore(); await h.cleanup(); }
});

test.each(['load', 'revert', 'slot', 'live'])('pane press qualifies the original gesture before outside stash after %s', async replacement => {
  const h = await harness(); const oldFetch = global.fetch; global.fetch = jest.fn().mockRejectedValue(new Error('offline'));
  try {
    const original = h.client.capture('tm-source', 'pn-source'); const workspace = captureWorkspace();
    h.press();
    if (replacement === 'slot') {
      await act(async () => { store.dispatch(removeTabTree('tb-source')); store.dispatch(addTabTree({ tabId: 'tb-source', tree: tree('source') })); await flush(); });
      expect(captureWorkspace()).toBe(workspace);
    } else if (replacement !== 'live') {
      const trees = { 'tb-source': tree('source'), 'tb-control': tree('control') };
      localStorage.setItem('auto-terminal-layouts', JSON.stringify([{ id: 'repeat-source', name: 'Repeated', tabs: [{ id: 'tb-source', title: 'Replacement' }, { id: 'tb-control', title: 'Control' }], activeTabId: 'tb-source', activePaneId: 'pn-source', paneTree: trees['tb-source'], treesByTabId: trees, createdAt: Date.now(), updatedAt: Date.now() }]));
      let loading!: Promise<boolean>;
      act(() => { loading = StateManager.loadLayout('repeat-source', store.dispatch); });
      await act(async () => { await jest.advanceTimersByTimeAsync(100); await flush(); }); expect(await loading).toBe(true);
      if (replacement === 'revert') {
        act(() => { loading = StateManager.revertWorkspace(store.dispatch); });
        await act(async () => { await jest.advanceTimersByTimeAsync(100); await flush(); }); expect(await loading).toBe(true);
      }
    }
    const current = h.client.capture('tm-source', 'pn-source'); expect(current).toBeDefined();
    if (replacement !== 'live') expect(current).not.toBe(original);
    const count = h.requests.length;
    await h.outside();
    expect(h.requests.filter(request => request.op.kind === 'stash')).toHaveLength(replacement === 'live' ? 1 : 0);
    expect(h.api.beginGlobalPaneDrag).toHaveBeenCalledTimes(replacement === 'live' ? 1 : 0);
    if (replacement === 'live') await h.finish(false);
    else {
      expect(h.requests).toHaveLength(count);
      expect(h.client.capture('tm-source', 'pn-source')).toBe(current);
      expect(h.client.isSuppressed(current!)).toBe(false);
      expect(store.getState().panes.treesByTabId['tb-source']).toMatchObject(tree('source'));
      expect(document.body.classList.contains('pane-dragging')).toBe(false);
    }
  } finally { global.fetch = oldFetch; await h.cleanup(); }
});
