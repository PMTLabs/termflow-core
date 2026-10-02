/** @jest-environment jsdom */
jest.mock('@termflow/terminal-core', () => ({ DEFAULT_THEME: {}, terminalCache: new Map() }));
jest.mock('../../../TerminalContainer', () => ({ clearTabPanes: jest.fn() }));
import { store } from '../../../../store';
import { clearAllTabs } from '../../../../store/slices/tabsSlice';
import { resetPanes } from '../../../../store/slices/panesSlice';
import { terminalService } from '../../../../services/TerminalService';
import { PaneIncarnations, installPaneIncarnations, type PaneBridge, type PaneRequest } from '../../../../services/paneIncarnations';
import { gatedBridge } from '../../../../__testFixtures__/gatedBridge';
import { applyReattachByToken } from '../detach';
import type { DetachPayload } from '../types';
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const payload: DetachPayload = { kind: 'tab', tabId: 'tb-move', tabTitle: 'Moved',
  paneTree: { id: 'pn-move', type: 'terminal', terminalId: 'tm-move' },
  terminals: [{ terminalId: 'tm-move', processId: 'pc-source', shellType: 'default' }],
};

test('the real detach installer waits for a retried adopt acknowledgment and attaches once without admitting another shell', async () => {
  jest.useFakeTimers(); store.dispatch(clearAllTabs()); store.dispatch(resetPanes());
  const gates = gatedBridge(); const opGate = gates.command('pane_op');
  const requests: PaneRequest[] = [];
  let applies = 0, next = 1;
  const client = new PaneIncarnations((async (name: string, args: any) => {
    if (name === 'register_page') return { status: 'Registered', wi: 3, pg: 31 };
    requests.push(args.request);
    if (args.request.seq === next) { applies++; next++; }
    return opGate(args);
  }) as PaneBridge);
  installPaneIncarnations(client); client.attachStore(store);
  const attach = jest.spyOn(terminalService, 'attachExistingTerminal');
  const create = jest.spyOn(terminalService, 'createTerminal');
  (window as any).electronAPI = { takeDetachPayload: jest.fn().mockResolvedValue(payload), adoptConsoleWindow: jest.fn().mockResolvedValue(undefined) };
  try {
    const installing = applyReattachByToken('tx-exact'); await flush();
    expect(requests[0].op).toEqual({ kind: 'take', tx: 'tx-exact' });
    gates.release('pane_op', 0, { status: 'Ack', result: { status: 'Taken', payload: { panes: [{ paneId: 'pn-move', leaf: 'tm-move', restore: true }] } } });
    await flush();
    expect(requests[1].op).toMatchObject({ kind: 'adopt', tx: 'tx-exact', pairs: [{ paneId: 'pn-move', leaf: 'tm-move', restore: true, pi: { pg: 31, seq: 1 } }] });
    expect(applies).toBe(2);
    expect(store.getState().tabs.tabs).toHaveLength(0);
    expect(attach).not.toHaveBeenCalled();
    gates.fail('pane_op', 1, 'adopt reply lost'); await flush(); await jest.advanceTimersByTimeAsync(50);
    expect(requests[2]).toEqual(requests[1]); expect(applies).toBe(2);
    expect(attach).not.toHaveBeenCalled();
    gates.release('pane_op', 2, { status: 'Ack', result: { status: 'Ok' } }); await flush();
    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledWith('tm-move', 'pc-source', undefined);
    expect(store.getState().panes.treesByTabId['tb-move']).toMatchObject({ terminalId: 'tm-move' });
    expect(requests[3].op).toEqual({ kind: 'bind', pi: { pg: 31, seq: 1 }, pc: 'pc-source', via: 'transfer' });
    gates.release('pane_op', 3, { status: 'Ack', result: { status: 'Ok' } }); await installing;
    expect(applies).toBe(3);
    expect(requests).toHaveLength(4);
    expect(create).not.toHaveBeenCalled();
  } finally {
    attach.mockRestore(); create.mockRestore(); terminalService.detachTerminal('tm-move');
    client.stop(); installPaneIncarnations(new PaneIncarnations()); delete (window as any).electronAPI;
    store.dispatch(clearAllTabs()); store.dispatch(resetPanes());
    expect(jest.getTimerCount()).toBe(0); jest.useRealTimers();
  }
});
