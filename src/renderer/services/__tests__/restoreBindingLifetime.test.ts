/** @jest-environment jsdom */
jest.mock('../../components/TerminalContainer', () => ({ clearTabPanes: jest.fn() }));
jest.mock('../../api/apiBase', () => ({ apiBase: jest.fn().mockResolvedValue('http://isolated.test/api') }));
import { configureStore } from '@reduxjs/toolkit';
import panesReducer, { addTabTree } from '../../store/slices/panesSlice';
import tabsReducer, { addTab } from '../../store/slices/tabsSlice';
import canvasReducer from '../../store/slices/canvasSlice';
import { StateManager } from '../StateManager';
import { terminalService } from '../TerminalService';
import { sessionStateKey } from '../windowScope';
import { pushUndo, __resetLayoutUndoForTests } from '../layoutUndo';
import { captureWorkspaceSnapshot } from '../workspaceSnapshot';
import { restoreTabPanesInPlace } from '../tabPanesStore';

beforeEach(() => { jest.useFakeTimers(); localStorage.clear(); __resetLayoutUndoForTests(); });
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

test.each(['restore', 'revert'])('%s protects the original run through a pre-install await longer than the sweep period', async operation => {
  const terminalId = `tm-${operation}-held`;
  const tabId = `tb-${operation}`;
  const processId = `pc-${operation}-p`;
  const tree = { id: 'pane', type: 'terminal' as const, terminalId };
  const store = configureStore({ reducer: { panes: panesReducer, tabs: tabsReducer, canvas: canvasReducer } });
  (window as any).__REDUX_STORE__ = store;
  (window as any).__TAB_PANES__ = {};
  (window as any).tabPanes = (window as any).__TAB_PANES__;
  const intents = new Set<string>();
  let restoreDepth = 0;
  let resume!: () => void;
  let registrations = 0;
  const gate = () => new Promise<void>(resolve => { resume = resolve; });
  const bindShell = jest.fn(async (leaf: string) => {
    intents.delete(leaf);
    return { status: 'bound', processId };
  });
  const api = {
    beginShellRestore: jest.fn(async () => { restoreDepth++; }),
    endShellRestore: jest.fn(async () => { restoreDepth--; }),
    registerRestoringLeaves: jest.fn(async (leaves: Array<{ leafId: string }>) => {
      leaves.forEach(leaf => intents.add(leaf.leafId));
      registrations++;
      if (operation === 'revert' && registrations === 2) await gate();
    }),
    listWindowSessionIds: jest.fn().mockResolvedValue(['w0']),
    pruneTerminalHistory: jest.fn(gate),
    bindShell,
    releaseShellBinding: jest.fn(async (leaf: string) => { intents.delete(leaf); }),
    createTerminal: jest.fn().mockRejectedValue(new Error('host-session-contended: already registered')),
    adoptConsoleWindow: jest.fn().mockResolvedValue(undefined),
  };
  (window as any).electronAPI = api;
  const originalFetch = global.fetch;
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ terminals: [{ terminalId, processId }] }) });
  if (operation === 'revert') {
    store.dispatch(addTab({ id: tabId, title: 'Saved' }));
    store.dispatch(addTabTree({ tabId, tree }));
    restoreTabPanesInPlace({ [tabId]: tree });
    pushUndo(captureWorkspaceSnapshot(store.getState() as any, 'Before'));
  } else {
    localStorage.setItem(sessionStateKey(), JSON.stringify({ timestamp: Date.now(), tabs: [{ id: tabId, title: 'Saved' }],
      activeTabId: tabId, tabPanes: { [tabId]: tree }, treesByTabId: { [tabId]: tree }, paneTree: tree }));
  }
  const restoring = operation === 'restore' ? StateManager.restoreState(store.dispatch) : StateManager.revertWorkspace(store.dispatch);
  await jest.advanceTimersByTimeAsync(100);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(typeof resume).toBe('function');
  expect(store.getState().panes.treesByTabId).toEqual({});
  expect(intents.has(terminalId)).toBe(true);
  expect(restoreDepth).toBe(1);
  await jest.advanceTimersByTimeAsync(61_000);
  expect(bindShell).not.toHaveBeenCalled();
  expect(api.releaseShellBinding).not.toHaveBeenCalled();
  expect(api.createTerminal).not.toHaveBeenCalled();
  expect(intents.has(terminalId)).toBe(true);
  expect(restoreDepth).toBe(1);
  resume();
  expect(await restoring).toBe(true);
  expect(restoreDepth).toBe(0);
  expect(store.getState().panes.treesByTabId[tabId]?.terminalId).toBe(terminalId);
  // The mounted pane uses the registered final run, not a replacement shell.
  expect(await terminalService.createTerminal(terminalId)).toBe(processId);
  expect(terminalService.getProcessId(terminalId)).toBe(processId);
  expect(bindShell).toHaveBeenCalledWith(terminalId);
  expect(api.releaseShellBinding).not.toHaveBeenCalled();
  global.fetch = originalFetch;
});
