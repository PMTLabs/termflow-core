/** @jest-environment jsdom */
jest.mock('@termflow/terminal-core', () => ({ DEFAULT_THEME: {}, terminalCache: new Map() }));
jest.mock('../../TerminalContainer', () => ({ clearTabPanes: jest.fn() }));
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { store } from '../../../store';
import { addTab, clearAllTabs } from '../../../store/slices/tabsSlice';
import { addTabTree, resetPanes } from '../../../store/slices/panesSlice';
import { setEdges, type CanvasEdge } from '../../../store/slices/canvasSlice';
import { PaneIncarnations, installPaneIncarnations, type PaneBridge } from '../../../services/paneIncarnations';
import { replaceWorkspace } from '../../../services/workspaceReplacement';
import { useWireDrag } from '../useWireDrag';
import { CanvasWireMenu } from '../CanvasWireMenu';
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const original: CanvasEdge = { id: 'old-edge', from: 'tm-a', to: 'tm-b', label: null, origin: 'user' };
const Harness = () => {
  const wire = useWireDrag(Object.fromEntries(['a', 'b', 'c'].map((id, i) => [`tm-${id}`, { x: i * 300, y: 0, w: 200, h: 150 }])));
  return <div className="canvas-viewport" onPointerDownCapture={wire.onPointerDownCapture}>
    {['a', 'b', 'c'].map(id => <div key={id} className="canvas-node" data-terminal-id={`tm-${id}`}><span className="canvas-port" data-port="e" /></div>)}
    <span className="canvas-wire-handle" data-edge-id="old-edge" data-end="to" />
  </div>;
};
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; (window as any).PointerEvent = MouseEvent; });
test.each(['create', 'reconnect', 'patch', 'delete'])('mounted wire %s qualifies its reply and preserves a replacement graph', async operation => {
  store.dispatch(clearAllTabs()); store.dispatch(resetPanes()); store.dispatch(setEdges([original]));
  const client = new PaneIncarnations((async (command: string) => command === 'register_page' ? { status: 'Registered', wi: 4, pg: 44 } : { status: 'Ack', result: { status: 'Ok' } }) as PaneBridge);
  installPaneIncarnations(client); client.attachStore(store);
  store.dispatch(addTab({ id: 'tb-nodes', title: 'Nodes' }));
  store.dispatch(addTabTree({ tabId: 'tb-nodes', tree: { id: 'split', type: 'split', children: ['a', 'b', 'c'].map(id => ({ id: `pn-${id}`, type: 'terminal', terminalId: `tm-${id}` })) } }));
  let release!: (result: any) => void;
  const send = jest.fn().mockImplementation(() => new Promise(resolve => { release = resolve; }));
  (window as any).electronAPI = { canvasApiRequest: send };
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
  const run = async () => {
    const edge = store.getState().canvas.edges[0];
    await act(async () => { root.render(<Provider store={store}>{operation === 'patch' || operation === 'delete'
      ? <CanvasWireMenu x={20} y={20} edge={edge} fromTitle="A" toTitle="B" onClose={() => {}} /> : <Harness />}</Provider>); await flush(); });
    if (operation === 'delete') act(() => { [...document.querySelectorAll<HTMLElement>('.canvas-wire-menu button, .canvas-wire-menu .context-menu-item')].find(el => el.textContent?.includes('Delete Connection'))!.click(); });
    else if (operation === 'patch') {
      act(() => { [...document.querySelectorAll<HTMLElement>('.canvas-wire-menu button, .canvas-wire-menu .context-menu-item')].find(el => el.textContent?.includes('Label Connection'))!.click(); });
      const input = document.querySelector('input.canvas-wire-label-input') as HTMLInputElement;
      act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Renamed'); input.dispatchEvent(new Event('input', { bubbles: true })); });
      act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    } else {
      const start = operation === 'reconnect' ? container.querySelector('.canvas-wire-handle')! : container.querySelector('[data-terminal-id="tm-a"] .canvas-port')!;
      document.elementFromPoint = () => container.querySelector('[data-terminal-id="tm-c"]');
      act(() => { start.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 })); window.dispatchEvent(new MouseEvent('pointermove', { clientX: 100, clientY: 100 })); window.dispatchEvent(new MouseEvent('pointerup', { clientX: 100, clientY: 100 })); });
    }
    await flush();
  };
  const response = operation === 'delete' ? true : { ...original, id: operation === 'patch' ? 'old-edge' : 'created-edge', to: 'tm-c', label: 'Renamed' };
  try {
    // Live control proves the mounted consumer actually observes a server result.
    await run(); expect(send).toHaveBeenCalledTimes(1);
    if (operation === 'reconnect') {
      await act(async () => { release(response); await flush(); });
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[1][1]).toEqual({ method: 'DELETE' });
    }
    await act(async () => { release(response); await flush(); });
    expect(store.getState().canvas.edges).toEqual(operation === 'delete' ? [] : operation === 'create' ? [original, response] : [response]);
    await act(async () => { root.render(null); store.dispatch(setEdges([original])); });
    send.mockClear();
    await run(); expect(send).toHaveBeenCalledTimes(1);
    const replacement = { ...original, label: 'Replacement' };
    act(() => { replaceWorkspace(); store.dispatch(setEdges([replacement])); });
    await act(async () => { release(response); await flush(); });
    expect(send).toHaveBeenCalledTimes(1); // reconnect must not send its old DELETE
    expect(store.getState().canvas.edges).toEqual([replacement]);
  } finally {
    await act(async () => { root.unmount(); client.stop(); }); container.remove();
    installPaneIncarnations(new PaneIncarnations()); delete (window as any).electronAPI;
  }
});
