/** @jest-environment jsdom */
jest.mock('@termflow/terminal-core', () => ({ DEFAULT_THEME: {}, terminalCache: new Map() }));
jest.mock('../../../TerminalContainer', () => ({ clearTabPanes: jest.fn() }));
import { store } from '../../../../store';
import { addTab, clearAllTabs, removeTab } from '../../../../store/slices/tabsSlice';
import { addTabTree, resetPanes, removeTabTree } from '../../../../store/slices/panesSlice';
import { terminalService, TerminalServiceClass } from '../../../../services/TerminalService';
import { PaneIncarnations, installPaneIncarnations, acceptsTransferNotice, type PaneBridge, type PaneRequest } from '../../../../services/paneIncarnations';
import { gatedBridge } from '../../../../__testFixtures__/gatedBridge';
import { detachTabToNewWindow, applyReattachByToken } from '../detach';
import type { DetachPayload } from '../types';

const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function harness(pg = 71) {
  const gates = gatedBridge();
  const op = gates.command('pane_op');
  const wait = gates.command('wait_transfer_taken');
  const host = gates.command('create_admitted_terminal');
  const requests: PaneRequest[] = [];
  const client = new PaneIncarnations((async (name: string, args: any) => {
    if (name === 'register_page') return { status: 'Registered', wi: 7, pg };
    if (name === 'wait_transfer_taken') return wait(args);
    if (name === 'create_admitted_terminal') return host(args);
    requests.push(args.request);
    return op(args);
  }) as PaneBridge);
  const ack = (index: number, result: any = { status: 'Ok' }) => gates.release('pane_op', index, { status: 'Ack', result });
  installPaneIncarnations(client);
  return { client, gates, requests, ack };
}
function seed(id: string, leaf: string) {
  store.dispatch(addTab({ id: `tb-${id}`, title: id, shellType: 'default' }));
  store.dispatch(addTabTree({ tabId: `tb-${id}`, tree: { id: `pn-${id}`, type: 'terminal', terminalId: leaf } }));
}
function cleanup(client: PaneIncarnations) {
  client.stop(); installPaneIncarnations(new PaneIncarnations());
  terminalService.detachTerminal('tm-move'); terminalService.detachTerminal('tm-control');
  store.dispatch(clearAllTabs()); store.dispatch(resetPanes());
  delete (window as any).electronAPI;
  expect(jest.getTimerCount()).toBe(0); jest.useRealTimers();
}
beforeEach(() => { jest.useFakeTimers(); store.dispatch(clearAllTabs()); store.dispatch(resetPanes()); });

test.each([false, true])('failed build rollback reenters exactly once and binds the same shell with expiry=%s', async expired => {
  seed('move', 'tm-move'); seed('control', 'tm-control');
  const h = harness();
  const build = h.gates.command('build');
  const close = jest.fn(); const offer = jest.fn(); const take = jest.fn();
  (window as any).electronAPI = { createDetachedWindow: jest.fn(build), stashDetachPayload: jest.fn(), closeTerminal: close,
    offerSessionHandoff: offer, takeSessionHandoff: take, adoptConsoleWindow: jest.fn().mockResolvedValue(undefined) };
  terminalService.registerExistingTerminal('tm-move', 'pc-original');
  terminalService.registerExistingTerminal('tm-control', 'pc-control');
  h.client.attachStore(store);
  try {
    await flush(); h.ack(0); await flush(); h.ack(1); await flush();
    const original = await h.client.capture('tm-move', 'pn-move')!;
    const control = await h.client.capture('tm-control', 'pn-control')!;
    const result = detachTabToNewWindow({ tabId: 'tb-move', tabTitle: 'Carried' }).catch(error => error.message);
    await flush();
    expect(h.requests[2].op).toMatchObject({ kind: 'stash', pairs: [{ leaf: 'tm-move', pi: original }], ui: { tabTitle: 'Carried', terminals: [{ processId: 'pc-original' }] } });
    h.ack(2); await flush();
    expect(h.gates.calls('build')).toHaveLength(1);
    expect(h.gates.calls('wait_transfer_taken')).toHaveLength(1);
    expect(h.client.isSuppressed(h.client.capture('tm-move', 'pn-move')!)).toBe(true);
    expect((window as any).electronAPI.stashDetachPayload).not.toHaveBeenCalled();
    if (expired) {
      await jest.advanceTimersByTimeAsync(60_000);
      h.gates.release('wait_transfer_taken', 0, false); await flush();
    }
    h.gates.fail('build', 0, new Error('build refused')); await flush();
    expect(h.requests[3].op).toMatchObject({ kind: 'cancel' });
    h.ack(3, expired ? { status: 'Rejected', message: 'transfer has ended' } : { status: 'Ok' }); await flush();
    if (!expired) { h.gates.release('wait_transfer_taken', 0, false); await flush(); }
    expect(h.requests[4].op).toMatchObject({ kind: 'enter', panes: [{ paneId: 'pn-move', leaf: 'tm-move', pi: { pg: 71, seq: 3 } }] });
    h.ack(4); await flush();
    expect(h.requests[5].op).toEqual({ kind: 'bind', pi: { pg: 71, seq: 3 }, pc: 'pc-original', via: expired ? 'restore' : 'transfer' });
    h.ack(5); expect(await result).toBe('build refused');
    expect(h.requests).toHaveLength(6);
    expect(await h.client.capture('tm-control', 'pn-control')!).toEqual(control);
    expect(await h.client.capture('tm-move', 'pn-move')!).not.toEqual(original);
    expect(terminalService.getProcessId('tm-move')).toBe('pc-original');
    expect(store.getState().tabs.tabs.map(tab => tab.id)).toEqual(['tb-move', 'tb-control']);
    expect(close).not.toHaveBeenCalled(); expect(offer).not.toHaveBeenCalled(); expect(take).not.toHaveBeenCalled();
  } finally { cleanup(h.client); }
});

test('untaken expiry and build failure cannot reenter a source copy already removed from the live store', async () => {
  seed('move', 'tm-move'); seed('control', 'tm-control');
  const h = harness(); h.client.attachStore(store);
  (window as any).electronAPI = { createDetachedWindow: jest.fn(h.gates.command('build')), stashDetachPayload: jest.fn() };
  try {
    await flush(); h.ack(0); await flush(); h.ack(1); await flush();
    const control = await h.client.capture('tm-control', 'pn-control')!;
    const outcome = detachTabToNewWindow({ tabId: 'tb-move', tabTitle: 'Moved' }).catch(error => error.message);
    await flush(); h.ack(2); await flush();
    expect(h.gates.calls('build')).toHaveLength(1); expect(h.gates.calls('wait_transfer_taken')).toHaveLength(1);
    store.dispatch(removeTabTree('tb-move')); store.dispatch(removeTab('tb-move'));
    h.gates.release('wait_transfer_taken', 0, false); h.gates.fail('build', 0, new Error('build refused')); await flush();
    expect(h.requests[3].op).toMatchObject({ kind: 'cancel' }); h.ack(3); expect(await outcome).toBe('build refused');
    expect(h.requests).toHaveLength(4);
    expect(h.client.capture('tm-move', 'pn-move')).toBeUndefined();
    expect(await h.client.capture('tm-control', 'pn-control')!).toEqual(control);
    expect(store.getState().tabs.tabs.map(tab => tab.id)).toEqual(['tb-control']);
  } finally { cleanup(h.client); }
});

test('throwing real UI install departs every adopted copy but keeps the control pane', async () => {
  seed('control', 'tm-control');
  const h = harness(); h.client.attachStore(store);
  const payload: DetachPayload = { kind: 'tab', tabId: 'tb-new', tabTitle: 'Moved', paneTree: { id: 'split', type: 'split', children: [
    { id: 'pn-a', type: 'terminal', terminalId: 'tm-a' }, { id: 'pn-b', type: 'terminal', terminalId: 'tm-b' },
  ] }, terminals: [{ terminalId: 'tm-a', processId: 'pc-a', shellType: 'default' }, { terminalId: 'tm-b', processId: 'pc-b', shellType: 'default' }] };
  const oldMetadata = jest.fn();
  (window as any).electronAPI = { takeDetachPayload: oldMetadata };
  const attach = jest.spyOn(terminalService, 'attachExistingTerminal').mockImplementation(leaf => { if (leaf === 'tm-b') throw new Error('install failed'); });
  try {
    await flush(); h.ack(0); await flush();
    const control = await h.client.capture('tm-control', 'pn-control')!;
    const result = applyReattachByToken('broken').catch(error => error.message); await flush();
    h.ack(1, { status: 'Taken', payload: { ui: payload, panes: [{ paneId: 'pn-a', leaf: 'tm-a' }, { paneId: 'pn-b', leaf: 'tm-b' }] } }); await flush();
    expect(h.requests[2].op).toMatchObject({ kind: 'adopt', pairs: [{ pi: { pg: 71, seq: 2 } }, { pi: { pg: 71, seq: 3 } }] });
    expect(attach).not.toHaveBeenCalled();
    h.ack(2); await flush();
    expect(attach.mock.calls.map(call => call[0])).toEqual(['tm-a', 'tm-b']);
    expect(h.requests[3].op).toEqual({ kind: 'depart', pi: { pg: 71, seq: 2 } });
    h.ack(3); await flush();
    expect(h.requests[4].op).toEqual({ kind: 'depart', pi: { pg: 71, seq: 3 } });
    h.ack(4); expect(await result).toBe('install failed');
    expect(h.client.capture('tm-a')).toBeUndefined(); expect(h.client.capture('tm-b')).toBeUndefined();
    expect(await h.client.capture('tm-control', 'pn-control')!).toEqual(control);
    expect(h.requests).toHaveLength(5); expect(oldMetadata).not.toHaveBeenCalled();
  } finally { attach.mockRestore(); cleanup(h.client); }
});

test('a waiting pane installs once after lost adopt reply then joins the original placement instead of legacy handoff', async () => {
  seed('control', 'tm-control');
  const h = harness(); h.client.attachStore(store);
  const payload: DetachPayload = { kind: 'pane', tabId: 'tb-wait', tabTitle: 'Waiting', paneTree: { id: 'pn-wait', type: 'terminal', terminalId: 'tm-wait' }, terminals: [] };
  const api = { createTerminal: jest.fn(), closeTerminal: jest.fn(), offerSessionHandoff: jest.fn(), takeSessionHandoff: jest.fn(),
    onTerminalData: jest.fn(), onTerminalExit: jest.fn() };
  (window as any).electronAPI = api;
  const service = new TerminalServiceClass(() => store.getState().panes.treesByTabId, () => api as any, () => h.client);
  const installCount = jest.spyOn(store, 'dispatch');
  try {
    await flush(); h.ack(0); await flush();
    const control = await h.client.capture('tm-control', 'pn-control')!;
    const installing = applyReattachByToken('waiting'); await flush();
    h.ack(1, { status: 'Taken', payload: { ui: payload, panes: [{ paneId: 'pn-wait', leaf: 'tm-wait' }] } }); await flush();
    const adopt = h.requests[2];
    h.gates.fail('pane_op', 2, 'reply dropped'); await flush(); await jest.advanceTimersByTimeAsync(50);
    expect(h.requests[3]).toEqual(adopt);
    expect(store.getState().tabs.tabs.map(tab => tab.id)).toEqual(['tb-control']);
    h.ack(3); await installing;
    expect(installCount.mock.calls.filter(([action]) => action.type === 'panes/addTabTree')).toHaveLength(1);
    const creation = service.createTerminal('tm-wait', 'default', undefined, undefined, undefined, undefined, 'tb-wait', undefined, false, 'Mount', 'pn-wait');
    await flush(); expect(h.requests[4].op).toMatchObject({ kind: 'admit_create', pi: { pg: 71, seq: 2 } });
    h.ack(4, { status: 'Join', cg: 44 }); await flush();
    expect(h.gates.calls('create_admitted_terminal')).toEqual([[{ request: { pg: 71, cg: 44, leaf: 'tm-wait', profile: 'default', name: undefined, cwd: undefined, cols: undefined, rows: undefined, owningTabId: 'tb-wait', sessionKey: undefined, elevated: false } }]]);
    h.gates.release('create_admitted_terminal', 0, 'pc-original'); expect(await creation).toBe('pc-original');
    expect(service.getProcessId('tm-wait')).toBe('pc-original');
    expect(await h.client.capture('tm-control', 'pn-control')!).toEqual(control);
    expect(api.createTerminal).not.toHaveBeenCalled(); expect(api.closeTerminal).not.toHaveBeenCalled();
    expect(api.offerSessionHandoff).not.toHaveBeenCalled(); expect(api.takeSessionHandoff).not.toHaveBeenCalled();
    expect(h.requests).toHaveLength(5);
  } finally { installCount.mockRestore(); cleanup(h.client); }
});

test('source placement completing while staged neither binds locally nor offers the shell, but its close capture retains the original identity', async () => {
  seed('move', 'tm-move'); seed('control', 'tm-control');
  const h = harness(); h.client.attachStore(store);
  const api = { createTerminal: jest.fn(), closeTerminal: jest.fn(), offerSessionHandoff: jest.fn(), takeSessionHandoff: jest.fn(),
    onTerminalData: jest.fn(), onTerminalExit: jest.fn() };
  (window as any).electronAPI = api;
  const service = new TerminalServiceClass(() => store.getState().panes.treesByTabId, () => api as any, () => h.client);
  try {
    await flush(); h.ack(0); await flush(); h.ack(1); await flush();
    const original = h.client.capture('tm-move', 'pn-move')!;
    const control = await h.client.capture('tm-control', 'pn-control')!;
    const creation = service.createTerminal('tm-move', 'default', undefined, undefined, undefined, undefined, 'tb-move', undefined, false, 'Mount', 'pn-move');
    await flush(); h.ack(2, { status: 'Create', cg: 44 }); await flush();
    expect(h.gates.calls('create_admitted_terminal')).toHaveLength(1);
    const staged = h.client.stash('move', [{ paneId: 'pn-move', leaf: 'tm-move' }]); await flush();
    expect(h.requests[3].op).toMatchObject({ kind: 'stash', pairs: [{ pi: await original }] });
    h.ack(3); expect((await staged).status).toBe('Ok');
    h.gates.release('create_admitted_terminal', 0, 'pc-original');
    expect(await creation).toBe('');
    expect(service.getProcessId('tm-move')).toBeUndefined();
    expect(h.client.captureClose('tm-move', 'pn-move')).toBe(original);
    expect(await h.client.capture('tm-control', 'pn-control')!).toEqual(control);
    expect(api.offerSessionHandoff).not.toHaveBeenCalled(); expect(api.takeSessionHandoff).not.toHaveBeenCalled();
    expect(api.createTerminal).not.toHaveBeenCalled(); expect(api.closeTerminal).not.toHaveBeenCalled();
    expect(h.requests).toHaveLength(4);
  } finally { cleanup(h.client); }
});

test('original page receipts cannot select a successor after a label is reused', async () => {
  seed('control', 'tm-control');
  const h = harness(72); h.client.attachStore(store);
  try {
    await flush(); h.ack(0); await flush();
    const control = await h.client.capture('tm-control', 'pn-control')!;
    expect(await acceptsTransferNotice({ wi: 7, pg: 72 })).toBe(true);
    expect(await acceptsTransferNotice({ wi: 6, pg: 72 })).toBe(false);
    expect(await acceptsTransferNotice({ wi: 7, pg: 71 })).toBe(false);
    expect(await acceptsTransferNotice({})).toBe(false);
    expect(await h.client.capture('tm-control', 'pn-control')!).toEqual(control);
    expect(h.requests).toHaveLength(1);
  } finally { cleanup(h.client); }
});
