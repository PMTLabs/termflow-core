/** @jest-environment jsdom */
import { gatedBridge } from '../../__testFixtures__/gatedBridge';
import { PaneIncarnations, installPaneIncarnations, type PaneBridge, type PaneRequest, type PaneResult } from '../paneIncarnations';
import { closePaneNonBlocking } from '../paneClose';
import { TerminalServiceClass } from '../TerminalService';
import { configureStore } from '@reduxjs/toolkit';
import tabsReducer, { addTab, removeTab } from '../../store/slices/tabsSlice';
import panesReducer, { addTabTree, removePaneFromTab } from '../../store/slices/panesSlice';

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const a = { paneId: 'pn-a', leaf: 'tm-a' };
const b = { paneId: 'pn-b', leaf: 'tm-a' };
const clients: PaneIncarnations[] = [];
function harness() {
  const gates = gatedBridge();
  const command = gates.command('pane_op');
  const applied: PaneRequest[] = [];
  let next = 1;
  const cached = new Map<number, PaneResult>();
  const bridge = jest.fn(async (name: string, args: any) => {
    if (name === 'register_page') return { status: 'Registered', wi: 7, pg: 41 };
    if (name === 'pane_op') {
      const req: PaneRequest = args.request;
      if (req.seq === next) { applied.push(req); next++; }
      return command(args);
    }
    return gates.command(name)(args);
  }) as unknown as PaneBridge;
  const client = new PaneIncarnations(bridge);
  clients.push(client);
  const calls = () => gates.calls('pane_op').map(args => (args[0] as { request: PaneRequest }).request);
  const ack = (index: number, result: PaneResult = { status: 'Ok' }) => {
    const seq = calls()[index].seq;
    if (!cached.has(seq)) cached.set(seq, result);
    gates.release('pane_op', index, { status: 'Ack', result: cached.get(seq) });
  };
  return { client, gates, calls, applied, ack, bridge };
}
beforeEach(() => { jest.useFakeTimers(); delete (window as any).electronAPI; });
afterEach(() => {
  clients.splice(0).forEach(client => client.stop());
  installPaneIncarnations(new PaneIncarnations());
  expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
});

test('a lost reply retries the same head sequence and applies it once before later ops', async () => {
  const h = harness();
  const first = h.client.send({ kind: 'enter', panes: [] });
  const second = h.client.send({ kind: 'settle' });
  await flush();
  expect(h.calls().map(call => call.seq)).toEqual([1]);
  expect(h.applied).toHaveLength(1);
  h.gates.fail('pane_op', 0, 'reply lost');
  await flush();
  await jest.advanceTimersByTimeAsync(50);
  expect(h.calls().map(call => call.seq)).toEqual([1, 1]);
  expect(h.applied).toHaveLength(1);
  h.ack(1);
  await first;
  await flush();
  expect(h.calls().map(call => call.seq)).toEqual([1, 1, 2]);
  h.ack(2);
  await second;
  expect(h.applied.map(call => call.op.kind)).toEqual(['enter', 'settle']);
});

test('resync and a withheld reply retry the head without accepting a stale attempt', async () => {
  const h = harness();
  const result = h.client.send({ kind: 'settle' });
  await flush();
  expect(h.applied).toHaveLength(1);
  h.gates.release('pane_op', 0, { status: 'Resync', nextSeq: 1 });
  await flush();
  h.client.resync();
  await flush();
  expect(h.calls().map(call => call.seq)).toEqual([1, 1]);
  await jest.advanceTimersByTimeAsync(1000);
  expect(h.calls().map(call => call.seq)).toEqual([1, 1, 1]);
  h.ack(1); // Too late to acknowledge the current attempt.
  await flush();
  expect(jest.getTimerCount()).toBe(1);
  h.ack(2);
  expect(await result).toEqual({ status: 'Ok' });
  expect(h.applied).toHaveLength(1);
});

test('admission acknowledgment releases the stream while joined host work is still gated', async () => {
  const h = harness();
  const [pi] = h.client.prepare([a]);
  await flush(); h.ack(0); await flush();
  const admitted = h.client.admit(pi, 'Mount');
  await flush(); h.ack(1, { status: 'Join', cg: 91 });
  const answer = await admitted;
  expect(answer).toEqual({ status: 'Join', cg: 91 });
  const host = h.client.create(91, { leaf: a.leaf, profile: 'default' });
  const closed = h.client.close(pi);
  await flush();
  expect(h.gates.calls('create_admitted_terminal')).toEqual([[{ request: { pg: 41, cg: 91, leaf: a.leaf, profile: 'default' } }]]);
  expect(h.calls().map(call => call.op.kind)).toEqual(['enter', 'admit_create', 'close']);
  h.ack(2);
  expect(await closed).toEqual({ status: 'Ok' });
  h.gates.release('create_admitted_terminal', 0, 'pc-exact');
  expect(await host).toBe('pc-exact');
});

test('registration doubles retry delay to its cap and unload cancels further registration', async () => {
  const control = harness();
  const settled = control.client.send({ kind: 'settle' });
  await flush(); control.ack(0);
  expect(await settled).toEqual({ status: 'Ok' });
  expect(control.applied).toHaveLength(1);
  const gates = gatedBridge();
  const client = new PaneIncarnations(((name: string) => gates.command(name)()) as PaneBridge);
  clients.push(client);
  client.start();
  expect(gates.calls('register_page')).toHaveLength(1);
  const delays = [50, 100, 200, 400, 800, 1000, 1000];
  for (let i = 0; i < delays.length; i++) {
    gates.release('register_page', i, { status: 'Retry' });
    await flush();
    await jest.advanceTimersByTimeAsync(delays[i] - 1);
    expect(gates.calls('register_page')).toHaveLength(i + 1);
    await jest.advanceTimersByTimeAsync(1);
    expect(gates.calls('register_page')).toHaveLength(i + 2);
  }
  gates.release('register_page', 7, { status: 'Retry' });
  await flush();
  expect(jest.getTimerCount()).toBe(1);
  window.dispatchEvent(new Event('beforeunload'));
  expect(jest.getTimerCount()).toBe(0);
  await jest.advanceTimersByTimeAsync(5000);
  expect(gates.calls('register_page')).toHaveLength(8);
});

test('the store differ enters distinct same-leaf copies and departs only the disappearing copy', async () => {
  const h = harness();
  const store = configureStore({ reducer: { tabs: tabsReducer, panes: panesReducer } });
  h.client.attachStore(store);
  store.dispatch(addTab({ id: 'tb-a', title: 'A' }));
  store.dispatch(addTabTree({ tabId: 'tb-a', tree: { id: a.paneId, type: 'terminal', terminalId: a.leaf } }));
  store.dispatch(addTab({ id: 'tb-b', title: 'B' }));
  store.dispatch(addTabTree({ tabId: 'tb-b', tree: { id: b.paneId, type: 'terminal', terminalId: b.leaf } }));
  await flush(); h.ack(0); await flush(); h.ack(1); await flush();
  const piA = await h.client.capture(a.leaf, a.paneId)!;
  const piB = await h.client.capture(b.leaf, b.paneId)!;
  expect(piA).toEqual({ pg: 41, seq: 1 });
  expect(piB).toEqual({ pg: 41, seq: 2 });
  expect(h.applied.map(call => call.op.kind)).toEqual(['enter', 'enter']);
  store.dispatch(removeTab('tb-b')); // tree deliberately still present until React cleanup
  await flush();
  expect(h.calls()[2].op).toEqual({ kind: 'depart', pi: piB });
  h.ack(2); await flush();
  expect(await h.client.capture(a.leaf, a.paneId)).toEqual(piA);
  expect(h.applied).toHaveLength(3);
});

test('the real pane close captures before synchronous removal and never emits depart for that close', async () => {
  const h = harness(); installPaneIncarnations(h.client);
  const store = configureStore({ reducer: { tabs: tabsReducer, panes: panesReducer } });
  h.client.attachStore(store);
  store.dispatch(addTab({ id: 'tb-a', title: 'A' }));
  store.dispatch(addTabTree({ tabId: 'tb-a', tree: { id: a.paneId, type: 'terminal', terminalId: a.leaf } }));
  await flush(); h.ack(0); await flush();
  const captured = h.client.capture(a.leaf, a.paneId)!;
  const order: string[] = [];
  const originalCapture = h.client.captureClose.bind(h.client);
  const capture = jest.spyOn(h.client, 'captureClose').mockImplementation((leaf, id) => {
    order.push('capture');
    return originalCapture(leaf, id);
  });
  const service = new TerminalServiceClass(() => store.getState().panes.treesByTabId, () => ({} as any), () => h.client);
  const closeTerminal = jest.fn(async (leaf, pi) => {
    order.push('close'); expect(pi).toBe(captured);
    await service.closeTerminal(leaf, pi);
  });
  closePaneNonBlocking({ terminalId: a.leaf, paneId: a.paneId,
    removeFromUi: () => { order.push('remove'); store.dispatch(removePaneFromTab({ tabId: 'tb-a', paneId: a.paneId })); },
    closeTerminal, clearCwdSnapshot: jest.fn(), releaseSurface: jest.fn(), clearSessionExit: jest.fn(),
  });
  expect(order).toEqual(['capture', 'remove', 'close']);
  expect(capture).toHaveBeenCalledTimes(1);
  await flush();
  expect(h.calls().map(call => call.op.kind)).toEqual(['enter', 'close']);
  h.ack(1); await flush();
  expect(h.applied).toHaveLength(2);
});

test('adopt waits for its acknowledgment and a lost acknowledgment installs exactly once', async () => {
  const h = harness();
  const install = jest.fn();
  const installing = h.client.installTransfer('tx-move', [a, b], install);
  await flush(); expect(h.calls()[0].op).toEqual({ kind: 'take', tx: 'tx-move' });
  h.ack(0, { status: 'Taken', payload: { panes: [] } }); await flush();
  expect(h.calls()[1].op).toMatchObject({ kind: 'adopt', tx: 'tx-move', pairs: [{ ...a, pi: { pg: 41, seq: 1 } }, { ...b, pi: { pg: 41, seq: 2 } }] });
  expect(h.applied).toHaveLength(2);
  expect(install).not.toHaveBeenCalled();
  h.gates.fail('pane_op', 1, 'adopt reply lost'); await flush();
  await jest.advanceTimersByTimeAsync(50);
  expect(h.calls()[2]).toEqual(h.calls()[1]);
  expect(h.applied).toHaveLength(2);
  expect(install).not.toHaveBeenCalled();
  h.ack(2); await installing;
  expect(install).toHaveBeenCalledTimes(1);
  expect(h.calls().map(call => call.op.kind)).toEqual(['take', 'adopt', 'adopt']);
});

test('an installer that throws after adopt departs every entered copy', async () => {
  const h = harness();
  const install = jest.fn(() => { throw new Error('install failed'); });
  const result = h.client.installTransfer('tx-broken', [a, b], install).catch(error => error.message);
  await flush(); h.ack(0, { status: 'Taken', payload: { panes: [] } }); await flush(); h.ack(1); await flush();
  expect(install).toHaveBeenCalledTimes(1);
  expect(h.applied).toHaveLength(3);
  expect(h.calls()[2].op).toEqual({ kind: 'depart', pi: { pg: 41, seq: 1 } });
  h.ack(2); await flush();
  expect(h.calls()[3].op).toEqual({ kind: 'depart', pi: { pg: 41, seq: 2 } });
  h.ack(3); expect(await result).toBe('install failed');
  expect(h.applied).toHaveLength(4);
});

test('unknown backend commands drain the queue and keep real terminal creation and close on the legacy bridge', async () => {
  const h = harness();
  const trees = { 'tb-a': { id: a.paneId, type: 'terminal' as const, terminalId: a.leaf } };
  const api = { createTerminal: jest.fn().mockResolvedValue('pc-legacy'), closeTerminal: jest.fn().mockResolvedValue(undefined), forgetRestoringLeaf: jest.fn() };
  const service = new TerminalServiceClass(() => trees, () => api as any, () => h.client);
  const creating = service.createTerminal(a.leaf);
  await flush(); expect(h.applied).toHaveLength(1);
  expect(api.createTerminal).not.toHaveBeenCalled();
  h.gates.fail('pane_op', 0, 'unknown command pane_op');
  expect(await creating).toBe('pc-legacy');
  expect(api.createTerminal).toHaveBeenCalledTimes(1);
  expect(h.client.enabled).toBe(false);
  await service.closeTerminal(a.leaf);
  expect(api.closeTerminal.mock.calls).toEqual([['pc-legacy']]);
  const install = jest.fn();
  await h.client.installTransfer('tx-legacy', [b], install);
  expect(install).toHaveBeenCalledTimes(1);
  expect(h.calls()).toHaveLength(1);
});

test('mount and restart use captured incarnations and never perform a hold-free spawn on contention', async () => {
  const h = harness();
  const trees = { 'tb-a': { id: a.paneId, type: 'terminal' as const, terminalId: a.leaf } };
  const api = { createTerminal: jest.fn() };
  const service = new TerminalServiceClass(() => trees, () => api as any, () => h.client);
  const creating = service.createTerminal(a.leaf);
  await flush(); h.ack(0); await flush();
  expect(h.calls()[1].op).toEqual({ kind: 'admit_create', pi: { pg: 41, seq: 1 }, mode: 'Mount' });
  h.ack(1, { status: 'Create', cg: 8 }); await flush();
  expect(h.gates.calls('create_admitted_terminal')).toHaveLength(1);
  h.gates.release('create_admitted_terminal', 0, 'pc-owned');
  expect(await creating).toBe('pc-owned');
  const restarting = service.createTerminal(a.leaf, 'default', undefined, undefined, undefined, undefined, undefined, undefined, false, 'Restart', a.paneId).catch(error => error.message);
  await flush();
  expect(h.calls()[2].op).toEqual({ kind: 'admit_create', pi: { pg: 41, seq: 1 }, mode: 'Restart' });
  h.ack(2, { status: 'Contended' });
  expect(await restarting).toMatch(/^host-session-contended:/);
  expect(h.applied).toHaveLength(3);
  expect(h.gates.calls('create_admitted_terminal')).toHaveLength(1);
  expect(api.createTerminal).not.toHaveBeenCalled();
});

test('staging a waiting pane suppresses depart and cancel reenters a fresh source incarnation', async () => {
  const h = harness();
  h.client.observe([a]); await flush(); h.ack(0); await flush();
  const before = await h.client.capture(a.leaf, a.paneId)!;
  const staging = h.client.stash('tx-wait', [a]); await flush(); h.ack(1); await staging;
  h.client.observe([]); await flush();
  expect(h.applied.map(call => call.op.kind)).toEqual(['enter', 'stash']);
  const cancel = h.client.cancel('tx-wait', [a], new Map());
  await flush(); h.ack(2); await cancel; await flush();
  expect(h.calls()[3].op).toMatchObject({ kind: 'enter', panes: [{ ...a, pi: { pg: 41, seq: 2 } }] });
  h.ack(3); await flush();
  expect(await h.client.capture(a.leaf, a.paneId)).not.toEqual(before);
  expect(h.applied.map(call => call.op.kind)).toEqual(['enter', 'stash', 'cancel', 'enter']);
});

test('a business pending admission advances the stream and retries admission without a hold-free spawn', async () => {
  const h = harness();
  const trees = { 'tb-a': { id: a.paneId, type: 'terminal' as const, terminalId: a.leaf } };
  const api = { createTerminal: jest.fn() };
  const service = new TerminalServiceClass(() => trees, () => api as any, () => h.client);
  const creating = service.createTerminal(a.leaf);
  await flush(); h.ack(0); await flush(); h.ack(1, { status: 'Pending' }); await flush();
  expect(h.applied).toHaveLength(2);
  expect(api.createTerminal).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(500);
  expect(h.calls()[2]).toEqual({ pg: 41, seq: 3, op: { kind: 'admit_create', pi: { pg: 41, seq: 1 }, mode: 'Mount' } });
  h.ack(2, { status: 'Create', cg: 9 }); await flush();
  expect(h.gates.calls('create_admitted_terminal')).toHaveLength(1);
  h.gates.release('create_admitted_terminal', 0, 'pc-retry');
  expect(await creating).toBe('pc-retry');
  expect(api.createTerminal).not.toHaveBeenCalled();
});

test('unload drains pending admissions without falling back to a spawn for a dead page', async () => {
  const h = harness();
  const trees = { 'tb-a': { id: a.paneId, type: 'terminal' as const, terminalId: a.leaf } };
  const api = { createTerminal: jest.fn() };
  const service = new TerminalServiceClass(() => trees, () => api as any, () => h.client);
  const creating = service.createTerminal(a.leaf);
  await flush(); h.ack(0); await flush();
  expect(h.applied.map(call => call.op.kind)).toEqual(['enter', 'admit_create']);
  window.dispatchEvent(new Event('beforeunload'));
  expect(await creating).toBe('');
  expect(jest.getTimerCount()).toBe(0);
  expect(api.createTerminal).not.toHaveBeenCalled();
  expect(h.gates.calls('create_admitted_terminal')).toHaveLength(0);
});

test('abandoned prepared copies depart by captured identity without departing an installed control or replacement', async () => {
  const h = harness();
  h.client.observe([a]); await flush(); h.ack(0); await flush();
  const [old] = h.client.prepare([b]); await flush(); h.ack(1); await flush();
  expect(h.applied).toHaveLength(2);
  h.client.discardPrepared([old]); await flush();
  expect(h.calls()[2].op).toEqual({ kind: 'depart', pi: { pg: 41, seq: 2 } });
  h.ack(2); await flush();
  const [replacement] = h.client.prepare([b]); await flush(); h.ack(3); await flush();
  expect(await replacement).toEqual({ pg: 41, seq: 3 });
  h.client.discardPrepared([old]); h.client.discardPrepared([h.client.capture(a.leaf, a.paneId)!]);
  await flush();
  expect(h.applied).toHaveLength(4);
  expect(await h.client.capture(a.leaf, a.paneId)).toEqual({ pg: 41, seq: 1 });
  expect(h.client.capture(b.leaf, b.paneId)).toBe(replacement);
});

test('missing registration is inert and a missing host-work command falls back without poisoning creation', async () => {
  const missing = new PaneIncarnations((async () => { throw 'Command register_page not found'; }) as PaneBridge);
  clients.push(missing);
  const entering = missing.send({ kind: 'enter', panes: [] });
  expect(await entering).toEqual({ status: 'Inert' });
  expect(missing.enabled).toBe(false);
  expect(await missing.send({ kind: 'settle' })).toEqual({ status: 'Inert' });
  const h = harness();
  const trees = { 'tb-a': { id: a.paneId, type: 'terminal' as const, terminalId: a.leaf } };
  const api = { createTerminal: jest.fn().mockResolvedValue('pc-compatible') };
  const service = new TerminalServiceClass(() => trees, () => api as any, () => h.client);
  const creating = service.createTerminal(a.leaf);
  await flush(); h.ack(0); await flush(); h.ack(1, { status: 'Create', cg: 17 }); await flush();
  expect(h.applied).toHaveLength(2);
  expect(h.gates.calls('create_admitted_terminal')).toHaveLength(1);
  h.gates.fail('create_admitted_terminal', 0, 'Command create_admitted_terminal not found');
  expect(await creating).toBe('pc-compatible');
  expect(api.createTerminal).toHaveBeenCalledTimes(1);
  expect(h.client.enabled).toBe(false);
});

test('a late creation cannot bind a different pane copy now displaying the same leaf', async () => {
  const h = harness();
  let tree = { id: a.paneId, type: 'terminal' as const, terminalId: a.leaf };
  const service = new TerminalServiceClass(() => ({ 'tb-a': tree }), () => ({} as any), () => h.client);
  service.registerExistingTerminal('tm-control', 'pc-control');
  h.client.observe([a]);
  const creating = service.createTerminal(a.leaf, 'default', undefined, undefined, undefined, undefined, undefined, undefined, false, 'Mount', a.paneId);
  await flush(); h.ack(0); await flush(); h.ack(1, { status: 'Create', cg: 6 }); await flush();
  expect(h.gates.calls('create_admitted_terminal')).toHaveLength(1);
  tree = { id: b.paneId, type: 'terminal', terminalId: b.leaf };
  h.client.observe([b]); await flush(); h.ack(2); await flush(); h.ack(3); await flush();
  expect(h.applied.map(call => call.op.kind)).toEqual(['enter', 'admit_create', 'depart', 'enter']);
  h.gates.release('create_admitted_terminal', 0, 'pc-old-copy');
  expect(await creating).toBe('');
  expect(service.getProcessId(a.leaf)).toBeUndefined();
  expect(service.getProcessId('tm-control')).toBe('pc-control');
  expect(await h.client.capture(b.leaf, b.paneId)).toEqual({ pg: 41, seq: 2 });
});

test('same-leaf copies ask for independent admission while repeated calls for one copy remain single flight', async () => {
  const h = harness();
  const trees = {
    'tb-a': { id: a.paneId, type: 'terminal' as const, terminalId: a.leaf },
    'tb-b': { id: b.paneId, type: 'terminal' as const, terminalId: b.leaf },
  };
  const service = new TerminalServiceClass(() => trees, () => ({} as any), () => h.client);
  h.client.observe([a, b]); await flush(); h.ack(0); await flush(); h.ack(1); await flush();
  const args = [a.leaf, 'default', undefined, undefined, undefined, undefined, undefined, undefined, false, 'Mount', a.paneId] as const;
  const first = service.createTerminal(...args);
  const repeated = service.createTerminal(...args);
  const other = service.createTerminal(b.leaf, 'default', undefined, undefined, undefined, undefined, undefined, undefined, false, 'Mount', b.paneId).catch(error => error.message);
  await flush();
  expect(h.calls()[2].op).toEqual({ kind: 'admit_create', pi: { pg: 41, seq: 1 }, mode: 'Mount' });
  h.ack(2, { status: 'Create', cg: 71 }); await flush();
  expect(h.calls()[3].op).toEqual({ kind: 'admit_create', pi: { pg: 41, seq: 2 }, mode: 'Mount' });
  h.ack(3, { status: 'Contended' });
  expect(await other).toMatch(/^host-session-contended:/);
  expect(h.applied).toHaveLength(4);
  expect(h.gates.calls('create_admitted_terminal')).toHaveLength(1);
  h.gates.release('create_admitted_terminal', 0, 'pc-one-copy');
  expect(await first).toBe('pc-one-copy');
  expect(await repeated).toBe('pc-one-copy');
  expect(h.calls()).toHaveLength(4);
});

test('a delayed close acknowledgment cannot clear a newer local process mapping', async () => {
  const h = harness();
  h.client.observe([a]); await flush(); h.ack(0); await flush();
  const service = new TerminalServiceClass(() => ({}), () => ({} as any), () => h.client);
  service.registerExistingTerminal(a.leaf, 'pc-original');
  service.registerExistingTerminal('tm-control', 'pc-control');
  expect(service.getProcessId(a.leaf)).toBe('pc-original');
  const closing = service.closeTerminal(a.leaf, h.client.captureClose(a.leaf, a.paneId));
  await flush();
  expect(h.calls()[1].op).toEqual({ kind: 'close', pi: { pg: 41, seq: 1 } });
  service.registerExistingTerminal(a.leaf, 'pc-replacement');
  h.ack(1); await closing;
  expect(h.applied).toHaveLength(2);
  expect(service.getProcessId(a.leaf)).toBe('pc-replacement');
  expect(service.getProcessId('tm-control')).toBe('pc-control');
});

test('a contended copy close cannot discard the locally displayed owner mapping', async () => {
  const h = harness(); h.client.observe([a, b]);
  await flush(); h.ack(0); await flush(); h.ack(1); await flush();
  const service = new TerminalServiceClass(() => ({}), () => ({} as any), () => h.client);
  service.registerExistingTerminal(a.leaf, 'pc-owner');
  expect(service.getProcessId(a.leaf)).toBe('pc-owner');
  const closing = service.closeTerminal(b.leaf, h.client.captureClose(b.leaf, b.paneId));
  await flush();
  expect(h.calls()[2].op).toEqual({ kind: 'close', pi: { pg: 41, seq: 2 } });
  h.ack(2, { status: 'Contended' }); await closing;
  expect(h.applied).toHaveLength(3);
  expect(service.getProcessId(a.leaf)).toBe('pc-owner');
  expect(await h.client.capture(a.leaf, a.paneId)).toEqual({ pg: 41, seq: 1 });
});
