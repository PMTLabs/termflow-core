/** @jest-environment jsdom */
jest.mock('../../components/TerminalContainer', () => ({ clearTabPanes: jest.fn() }));
jest.mock('../../api/apiBase', () => ({ apiBase: jest.fn().mockResolvedValue('http://owned-instance/api') }));
import { gatedBridge } from '../../__testFixtures__/gatedBridge';
import { PaneIncarnations, installPaneIncarnations, type PaneBridge, type PaneRequest } from '../paneIncarnations';
import { StateManager } from '../StateManager';
import { terminalService } from '../TerminalService';
import { currentProfile } from '../profileScope';

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const pane = (leaf: string) => ({ id: `pn-${leaf}`, type: 'terminal', terminalId: leaf });

test('reconcile binds the prepared copy and reaps only eligible duplicates; a contended leaf is untouched', async () => {
  jest.useFakeTimers();
  const gates = gatedBridge();
  const opGate = gates.command('pane_op');
  const reapGate = gates.command('close_process');
  const requests: PaneRequest[] = [];
  const client = new PaneIncarnations((async (command: string, args: any) => {
    if (command === 'register_page') return { status: 'Registered', wi: 9, pg: 66 };
    if (command === 'pane_op') { requests.push(args.request); return opGate(args); }
    return reapGate(args);
  }) as PaneBridge);
  installPaneIncarnations(client);
  const attach = jest.spyOn(terminalService, 'attachExistingTerminal').mockImplementation(() => {});
  const reattached = jest.spyOn(terminalService, 'markReattachedSession').mockImplementation(() => {});
  const legacyClose = jest.fn();
  (window as any).electronAPI = { closeTerminal: legacyClose };
  const originalFetch = global.fetch;
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({
    instance: currentProfile().key,
    terminals: [
      { id: 'pc-control-new', terminalId: 'tm-control', createdAt: 2 },
      { id: 'pc-control-old', terminalId: 'tm-control', createdAt: 1 },
      { id: 'pc-other-window', terminalId: 'tm-shared', createdAt: 4 },
      { id: 'pc-other-duplicate', terminalId: 'tm-shared', createdAt: 3 },
    ],
  }) });
  try {
    const reconciling = (StateManager as any).reconcileExistingTerminals({ tabs: [{ id: 'tb-control' }, { id: 'tb-shared' }], tabPanes: {
      'tb-control': pane('tm-control'), 'tb-shared': pane('tm-shared'),
    } });
    await flush();
    expect(requests[0].op).toMatchObject({ kind: 'enter', panes: [{ paneId: 'pn-tm-control', leaf: 'tm-control', restore: true, pi: { pg: 66, seq: 1 } }] });
    gates.release('pane_op', 0, { status: 'Ack', result: { status: 'Ok' } }); await flush();
    expect(requests[1].op).toMatchObject({ kind: 'enter', panes: [{ leaf: 'tm-shared', pi: { pg: 66, seq: 2 } }] });
    gates.release('pane_op', 1, { status: 'Ack', result: { status: 'Ok' } }); await flush();
    expect(requests[2].op).toEqual({ kind: 'bind', pi: { pg: 66, seq: 1 }, pc: 'pc-control-new', via: 'reconcile' });
    expect(attach).not.toHaveBeenCalled();
    gates.release('pane_op', 2, { status: 'Ack', result: { status: 'Ok' } }); await flush();
    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach.mock.calls[0].slice(0, 2)).toEqual(['tm-control', 'pc-control-new']);
    expect(requests[3].op).toEqual({ kind: 'bind', pi: { pg: 66, seq: 2 }, pc: 'pc-other-window', via: 'reconcile' });
    gates.release('pane_op', 3, { status: 'Ack', result: { status: 'Contended' } }); await flush();
    expect(gates.calls('close_process')).toEqual([[{ pc: 'pc-control-old', reap: true }]]);
    gates.release('close_process', 0, { status: 'Ok' });
    await reconciling;
    expect(requests).toHaveLength(4);
    expect(attach).toHaveBeenCalledTimes(1);
    expect(reattached).toHaveBeenCalledTimes(1);
    expect(legacyClose).not.toHaveBeenCalled();
    expect(gates.calls('close_process')).toHaveLength(1);
  } finally {
    client.stop(); installPaneIncarnations(new PaneIncarnations());
    attach.mockRestore(); reattached.mockRestore(); global.fetch = originalFetch;
    delete (window as any).electronAPI;
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  }
});
