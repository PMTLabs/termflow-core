/** @jest-environment jsdom */
jest.mock('../../components/TerminalContainer', () => ({ clearTabPanes: jest.fn() }));
jest.mock('../../api/apiBase', () => ({ apiBase: async () => 'http://127.0.0.1:65535/api' }));
jest.mock('../hiddenAgentTerminals', () => ({
  ...jest.requireActual('../hiddenAgentTerminals'),
  fetchLiveTerminalRows: jest.fn(), refreshHiddenAgentTerminals: jest.fn().mockResolvedValue(undefined),
}));
import { configureStore } from '@reduxjs/toolkit';
import tabs, { addTab } from '../../store/slices/tabsSlice';
import panes, { addTabTree } from '../../store/slices/panesSlice';
import canvas from '../../store/slices/canvasSlice';
import settings from '../../store/slices/settingsSlice';
import sessionExit from '../../store/slices/sessionExitSlice';
import { PaneIncarnations, installPaneIncarnations, type PaneBridge, type PaneRequest } from '../paneIncarnations';
import { StateManager } from '../StateManager';
import { terminalService } from '../TerminalService';
import { restoreHiddenAgentTerminals } from '../restoreHiddenAgentTerminals';
import { fetchLiveTerminalRows } from '../hiddenAgentTerminals';
import { captureWorkspaceSnapshot } from '../workspaceSnapshot';
import { restoreTabPanesInPlace } from '../tabPanesStore';
import { pushUndo, __resetLayoutUndoForTests } from '../layoutUndo';

const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const leaf = (id: string) => ({ id: `pn-${id}`, type: 'terminal' as const, terminalId: `tm-${id}` });
const candidate = (id: string) => ({ terminalId: `tm-${id}`, processId: `pc-old-${id}`, agent: 'claude', name: id });

beforeEach(() => { jest.useFakeTimers(); localStorage.clear(); __resetLayoutUndoForTests(); });
afterEach(() => { installPaneIncarnations(new PaneIncarnations()); jest.useRealTimers(); delete (window as any).electronAPI; });

test.each(['load', 'revert', 'visible'])('hidden restore requalifies its acknowledged pi before installation across %s', async change => {
  const store = configureStore({ reducer: { tabs, panes, canvas, settings, sessionExit } });
  (window as any).__REDUX_STORE__ = store;
  (window as any).electronAPI = { adoptConsoleWindow: jest.fn().mockResolvedValue(undefined) };
  const requests: PaneRequest[] = [];
  let release!: (reply: any) => void;
  const client = new PaneIncarnations((async (command: string, args: any) => {
    if (command === 'register_page') return { status: 'Registered', wi: 5, pg: 51 };
    const request = args.request as PaneRequest;
    requests.push(request);
    if (request.op.kind === 'bind' && request.op.pc === 'pc-hidden') return new Promise(resolve => { release = resolve; });
    return { status: 'Ack', result: { status: 'Ok' } };
  }) as PaneBridge);
  installPaneIncarnations(client); client.attachStore(store);
  (fetchLiveTerminalRows as jest.Mock).mockResolvedValue({
    processes: [{ id: 'pc-control', agent: 'claude' }, { id: 'pc-hidden', agent: 'claude' }],
    identities: [{ processId: 'pc-control', terminalId: 'tm-control' }, { processId: 'pc-hidden', terminalId: 'tm-hidden' }],
  });
  const attach = jest.spyOn(terminalService, 'attachExistingTerminal');
  const oldFetch = global.fetch; global.fetch = jest.fn().mockRejectedValue(new Error('offline'));
  try {
    const controlResult = await restoreHiddenAgentTerminals([candidate('control')], store.dispatch);
    expect(controlResult.restored).toEqual([candidate('control')]);
    expect(terminalService.getProcessId('tm-control')).toBe('pc-control');
    expect(attach).toHaveBeenCalledTimes(1);
    const controlTabId = store.getState().tabs.tabs[0].id;
    const pending = restoreHiddenAgentTerminals([candidate('hidden')], store.dispatch);
    await flush();
    const hiddenBind = requests.find(request => request.op.kind === 'bind' && request.op.pc === 'pc-hidden')!;
    expect(hiddenBind.op).toMatchObject({ kind: 'bind', pi: { pg: 51, seq: 2 }, pc: 'pc-hidden' });
    const hiddenPi = client.capture('tm-hidden')!;
    let replacing: Promise<boolean> | undefined;
    if (change === 'visible') {
      store.dispatch(addTab({ id: 'tb-visible', title: 'Visible' }));
      store.dispatch(addTabTree({ tabId: 'tb-visible', tree: leaf('hidden') }));
      terminalService.registerExistingTerminal('tm-hidden', 'pc-visible');
    } else {
      const tree = leaf('replacement');
      if (change === 'revert') {
        store.dispatch(addTab({ id: 'tb-replacement', title: 'Replacement' }));
        store.dispatch(addTabTree({ tabId: 'tb-replacement', tree }));
        restoreTabPanesInPlace({ 'tb-replacement': tree });
        pushUndo(captureWorkspaceSnapshot(store.getState() as any, 'Replacement'));
        replacing = StateManager.revertWorkspace(store.dispatch);
      } else {
        localStorage.setItem('auto-terminal-layouts', JSON.stringify([{ id: 'replacement', name: 'Replacement', tabs: [{ id: 'tb-replacement', title: 'Replacement' }], activeTabId: 'tb-replacement', activePaneId: tree.id, paneTree: tree, treesByTabId: { 'tb-replacement': tree }, createdAt: Date.now(), updatedAt: Date.now() }]));
        replacing = StateManager.loadLayout('replacement', store.dispatch);
      }
      await jest.advanceTimersByTimeAsync(100);
      expect(store.getState().tabs.tabs).toHaveLength(0);
    }
    release({ status: 'Ack', result: { status: 'Ok' } });
    expect((await pending).restored).toEqual([]);
    if (replacing) expect(await replacing).toBe(true);
    expect(requests).toEqual(expect.arrayContaining([expect.objectContaining({ op: { kind: 'depart', pi: await hiddenPi } })]));
    expect(attach).toHaveBeenCalledTimes(1);
    const ids = store.getState().tabs.tabs.map(tab => tab.id);
    if (change === 'visible') {
      expect(ids).toHaveLength(2);
      expect(ids).toContain('tb-visible');
      expect(terminalService.getProcessId('tm-hidden')).toBe('pc-visible');
      expect(client.capture('tm-hidden', 'pn-hidden')).toBeDefined();
    } else {
      expect(ids).toEqual(change === 'load' ? ['tb-replacement'] : [controlTabId, 'tb-replacement']);
      expect(Object.values(store.getState().panes.treesByTabId).some(tree => tree?.terminalId === 'tm-hidden')).toBe(false);
    }
  } finally {
    attach.mockRestore(); global.fetch = oldFetch;
    terminalService.detachTerminal('tm-control'); terminalService.detachTerminal('tm-hidden');
    client.stop(); expect(jest.getTimerCount()).toBe(0);
  }
});
