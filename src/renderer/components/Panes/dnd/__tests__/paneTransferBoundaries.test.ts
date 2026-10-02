/** @jest-environment jsdom */
jest.mock('@termflow/terminal-core', () => ({ DEFAULT_THEME: {}, terminalCache: new Map() }));
jest.mock('../../../TerminalContainer', () => ({ clearTabPanes: jest.fn() }));
import { store } from '../../../../store';
import { addTab, clearAllTabs, removeTab } from '../../../../store/slices/tabsSlice';
import { addTabTree, resetPanes, removeTabTree, insertPaneIntoTab } from '../../../../store/slices/panesSlice';
import { terminalService, TerminalServiceClass } from '../../../../services/TerminalService';
import { PaneIncarnations, installPaneIncarnations, acceptsTransferNotice, type PaneBridge, type PaneRequest } from '../../../../services/paneIncarnations';
import { gatedBridge } from '../../../../__testFixtures__/gatedBridge';
import { detachTabToNewWindow, detachPaneToNewWindow, dropTabAcrossWindows, applyReattachByToken } from '../detach';
import { StateManager } from '../../../../services/StateManager';
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
  const close = jest.fn();
  (window as any).electronAPI = { createDetachedWindow: jest.fn(build), closeTerminal: close,
    adoptConsoleWindow: jest.fn().mockResolvedValue(undefined) };
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
    expect(close).not.toHaveBeenCalled();
  } finally { cleanup(h.client); }
});

test.each(['tab', 'pane', 'drop'])('successful %s transfer removes staged members but retains a split added while take is held', async kind => {
  seed('move', 'tm-move'); seed('control', 'tm-control');
  const h = harness(); h.client.attachStore(store);
  const route = h.gates.command('route');
  (window as any).electronAPI = { createDetachedWindow: jest.fn(route), resolveTabDrop: jest.fn(route), adoptConsoleWindow: jest.fn().mockResolvedValue(undefined) };
  terminalService.registerExistingTerminal('tm-move', 'pc-original');
  terminalService.registerExistingTerminal('tm-control', 'pc-control');
  try {
    await flush(); h.ack(0); await flush(); h.ack(1); await flush();
    const original = h.client.capture('tm-move', 'pn-move')!;
    const control = h.client.capture('tm-control', 'pn-control')!;
    const transferring = kind === 'drop' ? dropTabAcrossWindows({ tabId: 'tb-move', tabTitle: 'Moved', clientX: 4, clientY: 5 })
      : kind === 'pane' ? detachPaneToNewWindow({ sourceTabId: 'tb-move', paneNode: store.getState().panes.treesByTabId['tb-move']! })
      : detachTabToNewWindow({ tabId: 'tb-move', tabTitle: 'Moved' });
    await flush();
    expect(h.requests[2].op).toMatchObject({ kind: 'stash', pairs: [{ leaf: 'tm-move', pi: await original }] });
    h.ack(2); await flush();
    expect(h.gates.calls('route')).toHaveLength(1);
    const token = h.gates.calls('route')[0][0];
    expect(h.gates.calls('wait_transfer_taken')).toEqual([[{ pg: 71, tx: token }]]);
    store.dispatch(insertPaneIntoTab({ tabId: 'tb-move', targetPaneId: 'pn-move', zone: 'right', node: { id: 'pn-new', type: 'terminal', terminalId: 'tm-new' } }));
    terminalService.registerExistingTerminal('tm-new', 'pc-new');
    await flush(); h.ack(3); await flush();
    const added = h.client.capture('tm-new', 'pn-new')!;
    expect(added).toBeDefined();
    h.gates.release('wait_transfer_taken', 0, true);
    h.gates.release('route', 0, true);
    await transferring; await flush();
    expect(store.getState().tabs.tabs.map(tab => tab.id)).toEqual(['tb-move', 'tb-control']);
    expect(store.getState().panes.treesByTabId['tb-move']).toMatchObject({ id: 'pn-new', terminalId: 'tm-new' });
    expect(h.client.capture('tm-new', 'pn-new')).toBe(added);
    expect(h.client.capture('tm-control', 'pn-control')).toBe(control);
    expect(terminalService.getProcessId('tm-new')).toBe('pc-new');
    expect(terminalService.getProcessId('tm-control')).toBe('pc-control');
    expect(terminalService.getProcessId('tm-move')).toBeUndefined();
    expect(h.requests.filter(request => request.op.kind === 'depart')).toHaveLength(0);
  } finally { terminalService.detachTerminal('tm-new'); cleanup(h.client); }
});

test('a successful detach cannot remove a loaded replacement with the original durable pane and tab ids', async () => {
  seed('move', 'tm-move'); seed('control', 'tm-control');
  const h = harness(); h.client.attachStore(store);
  (window as any).__REDUX_STORE__ = store;
  (window as any).electronAPI = { createDetachedWindow: jest.fn(h.gates.command('build')), adoptConsoleWindow: jest.fn().mockResolvedValue(undefined) };
  terminalService.registerExistingTerminal('tm-move', 'pc-original');
  try {
    await flush(); h.ack(0); await flush(); h.ack(1); await flush();
    const original = h.client.capture('tm-move', 'pn-move');
    const transferring = detachTabToNewWindow({ tabId: 'tb-move', tabTitle: 'Moved' });
    await flush(); h.ack(2); await flush();
    const tree = { id: 'pn-move', type: 'terminal', terminalId: 'tm-move' };
    localStorage.setItem('auto-terminal-layouts', JSON.stringify([{ id: 'replacement', name: 'Replacement', tabs: [{ id: 'tb-move', title: 'Replacement' }], activeTabId: 'tb-move', activePaneId: tree.id, paneTree: tree, treesByTabId: { 'tb-move': tree }, createdAt: Date.now(), updatedAt: Date.now() }]));
    const replacing = StateManager.loadLayout('replacement', store.dispatch);
    await flush(); h.ack(3); await flush(); // control depart; the staged original does not depart
    await jest.advanceTimersByTimeAsync(100);
    expect(h.requests[4].op).toMatchObject({ kind: 'enter', panes: [{ leaf: 'tm-move' }] });
    h.ack(4); await flush(); h.ack(5); await flush();
    expect(await replacing).toBe(true);
    const replacement = h.client.capture('tm-move', 'pn-move');
    expect(replacement).not.toBe(original);
    terminalService.registerExistingTerminal('tm-move', 'pc-replacement');
    h.gates.release('wait_transfer_taken', 0, true); h.gates.release('build', 0, true);
    await transferring;
    expect(store.getState().tabs.tabs.map(tab => tab.title)).toEqual(['Replacement']);
    expect(store.getState().panes.treesByTabId['tb-move']).toMatchObject(tree);
    expect(h.client.capture('tm-move', 'pn-move')).toBe(replacement);
    expect(terminalService.getProcessId('tm-move')).toBe('pc-replacement');
  } finally { cleanup(h.client); }
});

test('untaken expiry and build failure cannot reenter a source copy already removed from the live store', async () => {
  seed('move', 'tm-move'); seed('control', 'tm-control');
  const h = harness(); h.client.attachStore(store);
  (window as any).electronAPI = { createDetachedWindow: jest.fn(h.gates.command('build')) };
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

test('a transfer adopt reply held across a real layout load cannot overwrite the replacement slot', async () => {
  seed('control', 'tm-control');
  const h = harness(); h.client.attachStore(store);
  (window as any).__REDUX_STORE__ = store;
  const payload: DetachPayload = { kind: 'tab', tabId: 'tb-move', tabTitle: 'Old transfer', paneTree: { id: 'pn-move', type: 'terminal', terminalId: 'tm-move' }, terminals: [{ terminalId: 'tm-move', processId: 'pc-transfer', shellType: 'default' }] };
  const attach = jest.spyOn(terminalService, 'attachExistingTerminal');
  try {
    await flush(); h.ack(0); await flush();
    const installing = applyReattachByToken('old-destination').catch(error => error.message);
    await flush(); h.ack(1, { status: 'Taken', payload: { ui: payload, panes: [{ paneId: 'pn-move', leaf: 'tm-move' }] } }); await flush();
    expect(h.requests[2].op).toMatchObject({ kind: 'adopt', pairs: [{ pi: { pg: 71, seq: 2 } }] });
    const tree = payload.paneTree;
    localStorage.setItem('auto-terminal-layouts', JSON.stringify([{ id: 'destination', name: 'Destination', tabs: [{ id: 'tb-move', title: 'Replacement' }], activeTabId: 'tb-move', activePaneId: tree.id, paneTree: tree, treesByTabId: { 'tb-move': tree }, createdAt: Date.now(), updatedAt: Date.now() }]));
    const replacing = StateManager.loadLayout('destination', store.dispatch);
    await jest.advanceTimersByTimeAsync(100);
    const replacement = h.client.capture('tm-move', 'pn-move');
    expect(replacement).toBeDefined();
    h.ack(2); await flush();
    expect(attach).not.toHaveBeenCalled();
    h.ack(3); await flush(); h.ack(4); await flush(); h.ack(5); await flush();
    expect(await replacing).toBe(true);
    expect(h.requests[6].op).toEqual({ kind: 'depart', pi: { pg: 71, seq: 2 } });
    h.ack(6); expect(await installing).toBe('transfer workspace replaced');
    expect(h.client.capture('tm-move', 'pn-move')).toBe(replacement);
    expect(store.getState().tabs.tabs.map(tab => tab.title)).toEqual(['Replacement']);
    expect(attach).not.toHaveBeenCalled();
  } finally { attach.mockRestore(); cleanup(h.client); }
});

test('throwing real UI install departs every adopted copy but keeps the control pane', async () => {
  seed('control', 'tm-control');
  const h = harness(); h.client.attachStore(store);
  const payload: DetachPayload = { kind: 'tab', tabId: 'tb-new', tabTitle: 'Moved', paneTree: { id: 'split', type: 'split', children: [
    { id: 'pn-a', type: 'terminal', terminalId: 'tm-a' }, { id: 'pn-b', type: 'terminal', terminalId: 'tm-b' },
  ] }, terminals: [{ terminalId: 'tm-a', processId: 'pc-a', shellType: 'default' }, { terminalId: 'tm-b', processId: 'pc-b', shellType: 'default' }] };
  (window as any).electronAPI = {};
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
    expect(h.requests).toHaveLength(5);
  } finally { attach.mockRestore(); cleanup(h.client); }
});

test('a waiting pane installs once after lost adopt reply then joins the original placement', async () => {
  seed('control', 'tm-control');
  const h = harness(); h.client.attachStore(store);
  const payload: DetachPayload = { kind: 'pane', tabId: 'tb-wait', tabTitle: 'Waiting', paneTree: { id: 'pn-wait', type: 'terminal', terminalId: 'tm-wait' }, terminals: [] };
  const api = { createTerminal: jest.fn(), closeTerminal: jest.fn(),
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
    expect(h.requests).toHaveLength(5);
  } finally { installCount.mockRestore(); cleanup(h.client); }
});

test('source placement completing while staged does not bind locally, but its close capture retains the original identity', async () => {
  seed('move', 'tm-move'); seed('control', 'tm-control');
  const h = harness(); h.client.attachStore(store);
  const api = { createTerminal: jest.fn(), closeTerminal: jest.fn(),
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
