/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import tabs, { addTab } from '../../../store/slices/tabsSlice';
import panes, { addTabTree, removeTabTree } from '../../../store/slices/panesSlice';
import canvas from '../../../store/slices/canvasSlice';
import { useCanvasDrag } from '../useCanvasDrag';
import { useSidebarDrag } from '../useSidebarDrag';
import { PaneIncarnations, installPaneIncarnations, type PaneBridge } from '../../../services/paneIncarnations';
import { describePanes } from '../../../services/paneIncarnations';
import type { CanvasModel } from '../canvasSelectors';

const source = { id: 'pn-source', type: 'terminal' as const, terminalId: 'tm-source' };
const target = { id: 'pn-target', type: 'terminal' as const, terminalId: 'tm-target' };
const model = {
  nodes: [source, target].map((pane, i) => ({ terminalId: pane.terminalId, paneId: pane.id, tabId: i ? 'tb-target' : 'tb-source', rect: { x: i * 200, y: 0, w: 100, h: 100 } })),
  groups: [{ tabId: 'tb-source', nodeIds: ['tm-source'], rect: { x: 0, y: 0, w: 100, h: 100 } }, { tabId: 'tb-target', nodeIds: ['tm-target'], rect: { x: 200, y: 0, w: 100, h: 100 } }],
} as CanvasModel;
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; (window as any).PointerEvent = MouseEvent; });
test.each(['canvas', 'sidebar'])('%s regroup refuses a replacement incarnation during a pointer gesture but moves a live control', async kind => {
  const store = configureStore({ reducer: { tabs, panes, canvas } });
  store.dispatch(addTab({ id: 'tb-source', title: 'Source' }));
  store.dispatch(addTab({ id: 'tb-target', title: 'Target' }));
  store.dispatch(addTabTree({ tabId: 'tb-source', tree: source }));
  store.dispatch(addTabTree({ tabId: 'tb-target', tree: target }));
  const client = new PaneIncarnations((async (command: string) => command === 'register_page'
    ? { status: 'Registered', wi: 1, pg: 11 } : { status: 'Ack', result: { status: 'Ok' } }) as PaneBridge);
  installPaneIncarnations(client); client.attachStore(store); await flush();
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  const Harness = () => {
    const drag = useCanvasDrag(model);
    const sidebar = useSidebarDrag(model);
    return <><button onPointerDown={kind === 'canvas' ? drag.onNodeHeaderPointerDown('tm-source', 'tb-source', model.nodes[0].rect) : sidebar.onRowPointerDown('tm-source', 'tb-source', 'Source')}>Drag</button><section className="canvas-sgroup" data-tab-id="tb-target" /></>;
  };
  const oldElementFromPoint = document.elementFromPoint;
  document.elementFromPoint = () => container.querySelector('section');
  const event = (name: string, x: number) => new MouseEvent(name, { bubbles: true, clientX: x, clientY: 10 });
  const gestureStart = () => {
    act(() => container.querySelector('button')!.dispatchEvent(event('pointerdown', 0)));
    act(() => window.dispatchEvent(event('pointermove', 220)));
  };
  try {
    act(() => root.render(<Provider store={store}><Harness /></Provider>));
    gestureStart();
    act(() => window.dispatchEvent(event('pointerup', 220)));
    expect(describePanes(store.getState().panes.treesByTabId['tb-target']).map(pane => pane.leaf)).toEqual(expect.arrayContaining(['tm-source', 'tm-target']));
    expect(describePanes(store.getState().panes.treesByTabId['tb-source'])).toEqual([]);
    act(() => {
      store.dispatch(addTabTree({ tabId: 'tb-source', tree: source }));
      store.dispatch(addTabTree({ tabId: 'tb-target', tree: target }));
    }); await flush();
    const original = client.capture('tm-source', 'pn-source');
    const control = client.capture('tm-target', 'pn-target');
    gestureStart();
    act(() => {
      store.dispatch(removeTabTree('tb-source'));
      store.dispatch(addTabTree({ tabId: 'tb-source', tree: { ...source, name: 'Replacement' } }));
    }); await flush();
    const replacement = client.capture('tm-source', 'pn-source');
    expect(replacement).toBeDefined(); expect(replacement).not.toBe(original);
    act(() => window.dispatchEvent(event('pointerup', 220)));
    expect(store.getState().panes.treesByTabId['tb-source']).toMatchObject({ ...source, name: 'Replacement' });
    expect(store.getState().panes.treesByTabId['tb-target']).toEqual(target);
    expect(client.capture('tm-target', 'pn-target')).toBe(control);
    expect(client.capture('tm-source', 'pn-source')).toBe(replacement);
  } finally {
    act(() => { root.unmount(); client.stop(); }); container.remove();
    document.elementFromPoint = oldElementFromPoint; installPaneIncarnations(new PaneIncarnations());
  }
});
