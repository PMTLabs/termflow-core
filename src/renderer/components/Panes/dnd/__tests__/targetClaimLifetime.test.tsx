/** @jest-environment jsdom */
jest.mock('@termflow/terminal-core', () => ({ DEFAULT_THEME: {}, terminalCache: new Map() }));
jest.mock('../../../TerminalContainer', () => ({ clearTabPanes: jest.fn() }));
const handlers = new Map<string, (event: any) => void>();
jest.mock('@tauri-apps/api/event', () => ({ listen: jest.fn(async (name, handler) => { handlers.set(name, handler); return () => handlers.delete(name); }) }));
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { store } from '../../../../store';
import { clearAllTabs, addTab } from '../../../../store/slices/tabsSlice';
import { resetPanes, addTabTree } from '../../../../store/slices/panesSlice';
import { PaneIncarnations, installPaneIncarnations, type PaneBridge, type PaneRequest } from '../../../../services/paneIncarnations';
import { replaceWorkspace } from '../../../../services/workspaceReplacement';
import { terminalService } from '../../../../services/TerminalService';
import { PaneDragProvider } from '../PaneDragController';
import type { DetachPayload } from '../types';
const flush = async () => { for (let i = 0; i < 45; i++) await Promise.resolve(); };
const payload: DetachPayload = { kind: 'pane', tabId: 'tb-moved', tabTitle: 'Moved', paneTree: { id: 'pn-moved', type: 'terminal', terminalId: 'tm-moved', sessionKey: 'tm-moved~exact' }, terminals: [{ terminalId: 'tm-moved', processId: 'pc-moved', shellType: 'default' }] };

beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
test.each(['before', 'after', 'workspace', 'newer-attempt'])('mounted target claim survives matching advertisement end with %s reply ordering', async ordering => {
  store.dispatch(clearAllTabs()); store.dispatch(resetPanes()); handlers.clear();
  const requests: PaneRequest[] = [];
  const client = new PaneIncarnations((async (command: string, args: any) => {
    if (command === 'register_page') return { status: 'Registered', wi: 8, pg: 80 };
    requests.push(args.request);
    return { status: 'Ack', result: args.request.op.kind === 'take' ? { status: 'Taken', payload: { panes: [{ paneId: 'pn-moved', leaf: 'tm-moved', override: 'tm-moved~exact' }], ui: payload } } : { status: 'Ok' } };
  }) as PaneBridge);
  installPaneIncarnations(client); client.attachStore(store);
  store.dispatch(addTab({ id: 'tb-control', title: 'Control' }));
  store.dispatch(addTabTree({ tabId: 'tb-control', tree: { id: 'pn-control', type: 'terminal', terminalId: 'tm-control' } }));
  terminalService.registerExistingTerminal('tm-control', 'pc-control');
  let release!: (value: DetachPayload | null) => void;
  const claim = jest.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValue(null);
  (window as any).electronAPI = { claimGlobalPaneDrag: claim, adoptConsoleWindow: jest.fn().mockResolvedValue(undefined) };
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
  const attach = jest.spyOn(terminalService, 'attachExistingTerminal');
  const target = () => container.querySelector('[data-pane-id]') as HTMLElement;
  document.elementFromPoint = () => target();
  const event = (name: string, payload: unknown) => handlers.get(name)!({ payload });
  const up = () => window.dispatchEvent(new MouseEvent('pointerup', { clientX: 20, clientY: 20 }));
  try {
    await act(async () => { root.render(<Provider store={store}><PaneDragProvider><div data-tab-id="tb-control"><div data-pane-id="pn-control" /></div></PaneDragProvider></Provider>); await flush(); });
    expect(handlers.size).toBe(3);
    await act(async () => { event('pane-drag:active', { token: 'claim-token' }); await flush(); });
    act(() => window.dispatchEvent(new MouseEvent('pointermove', { clientX: 20, clientY: 20 })));
    expect(document.querySelector('.pane-drop-overlay')).not.toBeNull();
    await act(async () => { up(); await flush(); });
    expect(claim).toHaveBeenCalledTimes(1);
    expect(requests.filter(request => request.op.kind === 'take')).toHaveLength(0);
    if (ordering !== 'after') await act(async () => { event('pane-drag:ended', 'claim-token'); await flush(); });
    if (ordering === 'workspace') replaceWorkspace();
    if (ordering === 'newer-attempt') {
      await act(async () => { event('pane-drag:active', { token: 'new-token' }); await flush(); });
      await act(async () => { up(); await flush(); });
      expect(claim).toHaveBeenCalledTimes(2);
    }
    await act(async () => { release(payload); await flush(); });
    if (ordering === 'after') await act(async () => { event('pane-drag:ended', 'claim-token'); await flush(); });
    const successful = ordering === 'before' || ordering === 'after';
    expect(requests.filter(request => request.op.kind === 'take')).toHaveLength(successful ? 1 : 0);
    expect(requests.filter(request => request.op.kind === 'adopt')).toHaveLength(successful ? 1 : 0);
    expect(attach).toHaveBeenCalledTimes(successful ? 1 : 0);
    if (successful) {
      expect(attach).toHaveBeenCalledWith('tm-moved', 'pc-moved', undefined);
      expect(requests.find(request => request.op.kind === 'bind')?.op).toMatchObject({ kind: 'bind', pc: 'pc-moved', via: 'transfer' });
    }
    expect(terminalService.getProcessId('tm-control')).toBe('pc-control');
    expect(document.querySelector('.pane-drop-overlay')).toBeNull();
    // No claim in flight: ending an advertisement still clears its overlay.
    await act(async () => { event('pane-drag:active', { token: 'idle-token' }); await flush(); });
    act(() => window.dispatchEvent(new MouseEvent('pointermove', { clientX: 20, clientY: 20 })));
    expect(document.querySelector('.pane-drop-overlay')).not.toBeNull();
    await act(async () => { event('pane-drag:ended', 'idle-token'); await flush(); });
    expect(document.querySelector('.pane-drop-overlay')).toBeNull();
  } finally {
    await act(async () => { root.unmount(); client.stop(); }); container.remove();
    installPaneIncarnations(new PaneIncarnations()); terminalService.detachTerminal('tm-moved'); terminalService.detachTerminal('tm-control');
    attach.mockRestore();
    delete (window as any).electronAPI;
  }
});
