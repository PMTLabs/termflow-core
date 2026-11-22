/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import fs from 'fs';
import path from 'path';

var activeStore: any;
var activeService: any;
jest.mock('@termflow/terminal-core', () => ({ DEFAULT_THEME: {}, terminalCache: new Map() }));
jest.mock('../../../store', () => {
  const actual = jest.requireActual('../../../store');
  return { ...actual, get store() { return activeStore ?? actual.store; } };
});
jest.mock('../../../services/TerminalService', () => {
  const actual = jest.requireActual('../../../services/TerminalService');
  return { ...actual, get terminalService() { return activeService ?? actual.terminalService; } };
});
jest.mock('../../../api/apiBase', () => ({ apiBase: async () => 'http://127.0.0.1:65535/api' }));
jest.mock('../../Terminal/TerminalDisplay', () => ({ TerminalDisplay: ({ processId }: any) => <div data-process-id={processId} /> }));
jest.mock('../../Terminal/AgentChip', () => ({ AgentChip: () => null }));
jest.mock('../dnd/usePaneDrag', () => ({ usePaneDrag: () => () => {} }));
jest.mock('../../TerminalContainer', () => ({ clearTabPanes: jest.fn() }));

import { TerminalPane } from '../TerminalPane';
import { TerminalServiceClass } from '../../../services/TerminalService';
import { StateManager } from '../../../services/StateManager';
import { PaneIncarnations, installPaneIncarnations, type PaneBridge, type PaneIncarnation, type PaneRequest, type PaneResult } from '../../../services/paneIncarnations';
import tabs, { addTab } from '../../../store/slices/tabsSlice';
import panes, { addTabTree } from '../../../store/slices/panesSlice';
import settings from '../../../store/slices/settingsSlice';
import zoom from '../../../store/slices/zoomSlice';
import canvas from '../../../store/slices/canvasSlice';
import sessionExit from '../../../store/slices/sessionExitSlice';
import ui from '../../../store/slices/uiSlice';

const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
const leaves = ['tm-first', 'tm-second'];
const makeStore = () => configureStore({ reducer: { tabs, panes, settings, zoom, canvas, sessionExit, ui } });

// This script models only page lifetime and registered-owner admission. The hosted
// backend suite drives these same transitions against actual ownership and wire keys.
function nativeScript() {
  let pg = 0;
  const requests: PaneRequest[] = [];
  const entries = new Map<string, string>();
  const rows = new Map<string, { pc: string; owner?: PaneIncarnation }>([
    ['tm-control', { pc: 'pc-control', owner: { pg: 900, seq: 1 } }],
  ]);
  const results = new Map<string, PaneResult>();
  const create = jest.fn(async (request: any) => {
    const pc = `pc-${request.leaf}`;
    expect(rows.get(request.leaf)?.owner?.pg).toBe(request.pg);
    rows.get(request.leaf)!.pc = pc;
    return pc;
  });
  const bridge: PaneBridge = (async (command: string, args: any) => {
    if (command === 'register_page') return { status: 'Registered', wi: 4, pg: ++pg };
    if (command === 'create_admitted_terminal') return create(args.request);
    if (command === 'close_process') throw new Error('unexpected reap');
    const request = args.request as PaneRequest;
    requests.push(request);
    const cacheKey = `${request.pg}:${request.seq}`;
    if (results.has(cacheKey)) return { status: 'Ack', result: results.get(cacheKey) };
    const op = request.op;
    let result: PaneResult = { status: 'Ok' };
    if (op.kind === 'replace_page' || op.kind === 'settle') {
      for (const row of rows.values()) if (row.owner && row.owner.pg < request.pg) row.owner = undefined;
    } else if (op.kind === 'enter') {
      for (const entry of op.panes) entries.set(`${entry.pi.pg}:${entry.pi.seq}`, entry.leaf);
    } else if (op.kind === 'bind' || op.kind === 'admit_create') {
      const leaf = entries.get(`${op.pi.pg}:${op.pi.seq}`)!;
      const row = rows.get(leaf);
      const same = row?.owner?.pg === op.pi.pg && row.owner.seq === op.pi.seq;
      if (row?.owner && !same) result = { status: 'Contended' };
      else if (op.kind === 'bind') {
        result = row?.pc === op.pc ? { status: 'Ok' } : { status: 'Retry' };
        if (result.status === 'Ok') row!.owner = op.pi;
      } else if (row?.pc) {
        result = { status: same ? 'AlreadyBound' : 'Existing', pc: row.pc };
        row.owner = op.pi;
      } else {
        rows.set(leaf, { pc: '', owner: op.pi });
        result = { status: 'Create', cg: op.pi.seq };
      }
    }
    results.set(cacheKey, result);
    return { status: 'Ack', result };
  }) as PaneBridge;
  return { bridge, rows, requests, create };
}

beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });

test.each(['reconcile', 'mount'])('four renderer reloads keep the same shells without startup failure via %s', async route => {
  jest.useFakeTimers();
  const script = nativeScript();
  const rawCreate = jest.fn().mockRejectedValue(new Error('unqualified create'));
  const api = { createTerminal: rawCreate, onTerminalData: jest.fn(), onTerminalExit: jest.fn(), adoptConsoleWindow: jest.fn().mockResolvedValue(undefined), updateTerminalName: jest.fn().mockResolvedValue(true) };
  (window as any).electronAPI = api;
  const oldFetch = global.fetch;
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => [...script.rows].map(([terminalId, row]) => ({ terminalId, id: row.pc })) })) as any;
  const container = document.createElement('div'); document.body.appendChild(container);
  let root: ReturnType<typeof createRoot> | undefined;
  let client: PaneIncarnations | undefined;
  try {
    for (let generation = 1; generation <= 5; generation++) {
      if (root) await act(async () => { root!.unmount(); client!.stop(); });
      activeStore = makeStore();
      (window as any).__REDUX_STORE__ = activeStore;
      client = new PaneIncarnations(script.bridge);
      installPaneIncarnations(client);
      // Native bootstrap queues this FIFO head before importing the store or App.
      await client.replacePage();
      activeService = new TerminalServiceClass(() => activeStore.getState().panes.treesByTabId, () => api as any);
      const tree = { id: 'pn-split', type: 'split' as const, direction: 'horizontal' as const, children: leaves.map(id => ({ id: `pn-${id}`, type: 'terminal' as const, terminalId: id })) };
      const appState = { tabs: [{ id: 'tb-owned', title: 'Owned' }], tabPanes: { 'tb-owned': tree } };
      if (route === 'reconcile' && generation > 1) await (StateManager as any).reconcileExistingTerminals(appState);
      activeStore.dispatch(addTab(appState.tabs[0]));
      activeStore.dispatch(addTabTree({ tabId: 'tb-owned', tree }));
      client.attachStore(activeStore);
      root = createRoot(container);
      await act(async () => {
        root!.render(<Provider store={activeStore}>{leaves.map(id => <TerminalPane key={id} paneId={`pn-${id}`} terminalId={id} isActive onSplit={() => {}} onClose={() => {}} onFocus={() => {}} />)}</Provider>);
        await flush();
      });
      expect(container.querySelector('.terminal-startup-status.failed')).toBeNull();
      expect([...container.querySelectorAll('[data-process-id]')].map(node => node.getAttribute('data-process-id'))).toEqual(leaves.map(id => `pc-${id}`));
      for (const leaf of leaves) {
        expect(activeService.getProcessId(leaf)).toBe(`pc-${leaf}`);
        expect(script.rows.get(leaf)?.owner?.pg).toBe(generation);
      }
      const thisPage = script.requests.filter(request => request.pg === generation);
      expect(thisPage[0].op).toEqual({ kind: 'replace_page' });
      await client.send({ kind: 'settle' });
      expect(script.rows.get('tm-control')).toEqual({ pc: 'pc-control', owner: { pg: 900, seq: 1 } });
      expect(script.create).toHaveBeenCalledTimes(2);
      expect(rawCreate).not.toHaveBeenCalled();
    }
    expect(script.requests.filter(request => request.op.kind === 'replace_page')).toHaveLength(5);
    expect(script.requests.filter(request => request.op.kind === 'admit_create').every(request => request.op.kind === 'admit_create' && request.op.mode === 'Mount')).toBe(true);
  } finally {
    await act(async () => { root?.unmount(); client?.stop(); });
    installPaneIncarnations(new PaneIncarnations());
    container.remove(); global.fetch = oldFetch;
    delete (window as any).electronAPI; delete (window as any).__REDUX_STORE__;
    activeService = undefined; activeStore = undefined;
    jest.useRealTimers();
  }
});

test('mounted panes wait behind replayed page replacement while ownership warnings remain visible', async () => {
  jest.useFakeTimers();
  const script = nativeScript();
  for (const leaf of leaves) script.rows.set(leaf, { pc: `pc-${leaf}`, owner: { pg: 0, seq: 1 } });
  const releases: (() => void)[] = [];
  const bridge: PaneBridge = (async (command: string, args: any) => {
    const answer = await script.bridge(command as any, args);
    if (command === 'pane_op' && args.request.op.kind === 'replace_page') {
      return new Promise(resolve => releases.push(() => resolve(answer)));
    }
    return answer;
  }) as PaneBridge;
  const warn = jest.fn();
  const client = new PaneIncarnations(bridge, warn);
  installPaneIncarnations(client);
  const replacing = client.replacePage();
  activeStore = makeStore(); (window as any).__REDUX_STORE__ = activeStore;
  const rawCreate = jest.fn();
  const api = { createTerminal: rawCreate, onTerminalData: jest.fn(), onTerminalExit: jest.fn(), adoptConsoleWindow: jest.fn().mockResolvedValue(undefined) };
  (window as any).electronAPI = api;
  activeService = new TerminalServiceClass(() => activeStore.getState().panes.treesByTabId, () => api as any);
  activeStore.dispatch(addTab({ id: 'tb-owned', title: 'Owned' }));
  activeStore.dispatch(addTabTree({ tabId: 'tb-owned', tree: { id: 'pn-split', type: 'split', direction: 'horizontal', children: leaves.map(leaf => ({ id: `pn-${leaf}`, type: 'terminal', terminalId: leaf })) } }));
  client.attachStore(activeStore);
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<Provider store={activeStore}>{leaves.map(leaf => <TerminalPane key={leaf} paneId={`pn-${leaf}`} terminalId={leaf} isActive onSplit={() => {}} onClose={() => {}} onFocus={() => {}} />)}</Provider>);
      await flush();
      await jest.advanceTimersByTimeAsync(3000);
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(script.requests.length).toBeGreaterThan(1);
    expect(script.requests.every(request => request.pg === 1 && request.seq === 1 && request.op.kind === 'replace_page')).toBe(true);
    expect(container.querySelector('[data-process-id]')).toBeNull();
    expect(container.querySelector('.terminal-startup-status.failed')).toBeNull();
    await act(async () => { releases[releases.length - 1](); await replacing; await flush(); });
    expect([...container.querySelectorAll('[data-process-id]')].map(node => node.getAttribute('data-process-id'))).toEqual(leaves.map(leaf => `pc-${leaf}`));
    expect(container.querySelector('.terminal-startup-status.failed')).toBeNull();
    expect(script.create).not.toHaveBeenCalled(); expect(rawCreate).not.toHaveBeenCalled();
  } finally {
    await act(async () => { root.unmount(); client.stop(); });
    installPaneIncarnations(new PaneIncarnations()); container.remove();
    delete (window as any).electronAPI; delete (window as any).__REDUX_STORE__;
    activeService = undefined; activeStore = undefined; jest.useRealTimers();
  }
});

test('native bootstrap queues predecessor replacement before application imports', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../../index.tsx'), 'utf8');
  const replacement = source.indexOf('void incarnations.replacePage()');
  expect(replacement).toBeGreaterThan(source.indexOf('installPaneIncarnations(incarnations)'));
  expect(replacement).toBeLessThan(source.indexOf("require('./services/adminTabActions')"));
  expect(replacement).toBeLessThan(source.indexOf("require('./store')"));
  expect(replacement).toBeLessThan(source.indexOf("require('./App')"));
});
