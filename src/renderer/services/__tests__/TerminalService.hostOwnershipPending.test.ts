/** @jest-environment jsdom */
import { configureStore } from '@reduxjs/toolkit';
import panesReducer, { addTabTree, removeTabTree } from '../../store/slices/panesSlice';
import { TerminalServiceClass } from '../TerminalService';
import { makeBindingHost } from '../__testFixtures__/shellBindingHost';

const leaf = (terminalId: string) => ({ id: `pn-${terminalId}`, type: 'terminal' as const, terminalId });
const makeStore = () => configureStore({ reducer: { panes: panesReducer } });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function makeService(store: ReturnType<typeof makeStore>, createTerminal = jest.fn(), extraApi: Record<string, unknown> = {}) {
  const api = { createTerminal, forgetRestoringLeaf: jest.fn().mockResolvedValue(undefined),
    adoptConsoleWindow: jest.fn().mockResolvedValue(undefined), ...extraApi };
  const service = new TerminalServiceClass(() => store.getState().panes.treesByTabId, () => api as any);
  return { service, api, createTerminal };
}
const seed = (store: ReturnType<typeof makeStore>, id = 'tm-wait') => store.dispatch(addTabTree({ tabId: 'tb-wait', tree: leaf(id) }));
const contended = (id: string) => new Error(`host-session-contended: ${id} registered`);

beforeEach(() => { jest.useFakeTimers(); delete (window as any).electronAPI; });
afterEach(() => { jest.useRealTimers(); });

test('failed release retries while the source window remains alive and the leaf is absent', async () => {
  const host = makeBindingHost();
  const store = makeStore(); seed(store);
  const api = host.apiFor('source');
  host.seed('tm-wait', 'pc-p', 'source');
  host.seed('other', 'pc-q', 'other-window');
  const originalRelease = api.releaseShellBinding.getMockImplementation()!;
  api.releaseShellBinding.mockRejectedValueOnce(new Error('temporary IPC failure'));
  const { service } = makeService(store, api.createTerminal, api);
  service.registerExistingTerminal('tm-wait', 'pc-p');
  await flush();
  store.dispatch(removeTabTree('tb-wait'));
  service.detachTerminal('tm-wait');
  await flush();
  expect(host.holder('tm-wait')).toBe('source');
  api.releaseShellBinding.mockImplementation(originalRelease);
  await jest.advanceTimersByTimeAsync(250);
  expect(api.releaseShellBinding).toHaveBeenCalledTimes(2);
  expect(host.holder('tm-wait')).toBeUndefined();
  expect(host.holder('other')).toBe('other-window');
  expect(host.closed).toEqual([]);
});

test('release retry is bounded and does not send a late release after reinstall', async () => {
  const store = makeStore(); seed(store);
  const release = jest.fn().mockRejectedValue(new Error('IPC down'));
  const { service } = makeService(store, jest.fn(), { releaseShellBinding: release });
  store.dispatch(removeTabTree('tb-wait'));
  service.detachTerminal('tm-wait');
  await jest.advanceTimersByTimeAsync(1750);
  expect(release).toHaveBeenCalledTimes(4);
  service.detachTerminal('tm-wait');
  await flush();
  seed(store);
  await jest.advanceTimersByTimeAsync(2000);
  expect(release).toHaveBeenCalledTimes(5);
});

test('a refused duplicate pane closes without killing the process held by another window', async () => {
  const host = makeBindingHost();
  host.seed('tm-wait', 'pc-p', 'first');
  const store = makeStore(); seed(store);
  const api = host.apiFor('second');
  const { service } = makeService(store, api.createTerminal, api);
  await expect(service.createTerminal('tm-wait')).rejects.toThrow('host-session-contended');
  await service.closeTerminal('tm-wait');
  expect(host.closed).toEqual([]);
  expect(host.holder('tm-wait')).toBe('first');
});

test('desktop close acknowledgement prevents an unauthorized second process-close after transfer', async () => {
  const host = makeBindingHost();
  const store = makeStore(); seed(store);
  host.seed('tm-wait', 'pc-p', 'source');
  const api = host.apiFor('source');
  const { service } = makeService(store, api.createTerminal, api);
  service.registerExistingTerminal('tm-wait', 'pc-p');
  await flush();
  host.transfer('tm-wait', 'source', 'destination');
  const destinationApi = host.apiFor('destination');
  expect(await destinationApi.bindShell('tm-wait', 'pc-p')).toEqual({ status: 'bound', processId: 'pc-p' });
  await service.closeTerminal('tm-wait');
  expect(api.forgetRestoringLeaf).toHaveBeenCalledWith('tm-wait', 'pc-p');
  expect(api.closeTerminal).not.toHaveBeenCalled();
  expect(host.closed).toEqual([]);
  expect(host.holder('tm-wait')).toBe('destination');
});

test('backend transfer precedes source removal and its late reply never reacquires the holder', async () => {
  const host = makeBindingHost();
  const sourceStore = makeStore(); seed(sourceStore);
  const destinationStore = makeStore(); seed(destinationStore);
  const sourceApi = host.apiFor('source');
  const destinationApi = host.apiFor('destination');
  const source = makeService(sourceStore, sourceApi.createTerminal, sourceApi);
  const destination = makeService(destinationStore, destinationApi.createTerminal, destinationApi);
  const pendingSource = source.service.createTerminal('tm-wait');
  await flush();
  host.transfer('tm-wait', 'source', 'destination');
  const pendingDestination = destination.service.createTerminal('tm-wait');
  await flush();
  host.complete('tm-wait');
  await flush();
  expect(await pendingSource).toBe('');
  expect(source.service.getProcessId('tm-wait')).toBeUndefined();
  sourceStore.dispatch(removeTabTree('tb-wait'));
  source.service.detachTerminal('tm-wait');
  await jest.advanceTimersByTimeAsync(1000);
  expect(await pendingDestination).toBe('pc-old-host');
  expect(host.holder('tm-wait')).toBe('destination');
  expect(host.closed).toEqual([]);
});

test('split_a_waiting_solo_pane_does_not_spawn', async () => {
  const store = makeStore();
  seed(store);
  let resolved = false;
  const frames: Array<{ kind: string; leaf: string }> = [];
  const create = jest.fn(async (_profile, _name, _cwd, id) => {
    if (id === 'tm-wait') {
      if (!resolved) throw new Error('host-ownership-pending: listing delayed');
      frames.push({ kind: 'Attach', leaf: id });
      return 'pc-old-host';
    }
    frames.push({ kind: 'Spawn', leaf: id });
    return 'pc-current-host';
  });
  const { service } = makeService(store, create);
  const first = service.createTerminal('tm-wait');
  await flush();
  expect(service.getHostWaitState('tm-wait')).toBe('waiting');
  await jest.advanceTimersByTimeAsync(500);
  store.dispatch(addTabTree({ tabId: 'tb-wait', tree: { id: 'pn-split', type: 'split', direction: 'horizontal', children: [leaf('tm-wait'), leaf('tm-fresh')] } }));
  const remount = service.createTerminal('tm-wait');
  const fresh = service.createTerminal('tm-fresh');
  await flush();
  expect(create.mock.calls.filter(call => call[3] === 'tm-wait')).toHaveLength(1);
  resolved = true;
  await jest.advanceTimersByTimeAsync(500);
  expect(await first).toBe('pc-old-host');
  expect(await remount).toBe('pc-old-host');
  expect(await fresh).toBe('pc-current-host');
  expect(frames).toEqual([{ kind: 'Spawn', leaf: 'tm-fresh' }, { kind: 'Attach', leaf: 'tm-wait' }]);
});

test.each([700, 2000, 9000])('move while create is running binds only the destination after a %i ms host request', async delay => {
  const host = makeBindingHost();
  const sourceStore = makeStore();
  const destStore = makeStore();
  const tree = { id: 'split', type: 'split' as const, direction: 'horizontal' as const, children: [leaf('tm-live'), leaf('tm-wait')] };
  sourceStore.dispatch(addTabTree({ tabId: 'tb-wait', tree }));
  host.seed('tm-live', 'pc-live', 'source');
  const sourceApi = host.apiFor('source');
  const destApi = host.apiFor('destination');
  const source = makeService(sourceStore, sourceApi.createTerminal, sourceApi);
  const dest = makeService(destStore, destApi.createTerminal, destApi);
  source.service.registerExistingTerminal('tm-live', 'pc-live');
  const sourcePromise = source.service.createTerminal('tm-wait');
  await flush();
  expect(host.isCreating('tm-wait')).toBe(true);
  sourceStore.dispatch(removeTabTree('tb-wait'));
  source.service.detachTerminal('tm-wait');
  source.service.detachTerminal('tm-live');
  destStore.dispatch(addTabTree({ tabId: 'tb-wait', tree }));
  dest.service.attachExistingTerminal('tm-live', 'pc-live');
  const destPromise = dest.service.createTerminal('tm-wait');
  await flush();
  await jest.advanceTimersByTimeAsync(delay);
  expect(dest.service.getProcessId('tm-wait')).toBeUndefined();
  host.complete('tm-wait');
  await jest.advanceTimersByTimeAsync(8000);
  expect(await sourcePromise).toBe('');
  expect(await destPromise).toBe('pc-old-host');
  expect(host.holder('tm-wait')).toBe('destination');
  expect(source.service.getProcessId('tm-wait')).toBeUndefined();
  expect(dest.service.getProcessId('tm-wait')).toBe('pc-old-host');
  expect(host.frames).toEqual([{ window: 'source', kind: 'Attach', leaf: 'tm-wait' }]);
  expect(sourceApi.createTerminal).toHaveBeenCalledTimes(1);
  expect(sourceApi.forgetRestoringLeaf).not.toHaveBeenCalled();
  expect(destApi.forgetRestoringLeaf).not.toHaveBeenCalled();
  expect(host.closed).toEqual([]);
});

test('a contended create with no shell still fails immediately', async () => {
  const store = makeStore(); seed(store);
  const refusal = contended('tm-wait');
  const bind = jest.fn().mockResolvedValue({ status: 'none' });
  const { service } = makeService(store, jest.fn().mockRejectedValue(refusal), { bindShell: bind });
  await expect(service.createTerminal('tm-wait')).rejects.toBe(refusal);
  expect(bind.mock.calls).toEqual([['tm-wait']]);
  expect(service.getHostWaitState('tm-wait')).toBeUndefined();
});

test('a process another window already shows is never adopted', async () => {
  const host = makeBindingHost(); host.seed('tm-wait', 'pc-1', 'window-B');
  const store = makeStore(); seed(store);
  const api = host.apiFor('main');
  const { service } = makeService(store, api.createTerminal, api);
  await expect(service.createTerminal('tm-wait')).rejects.toThrow('host-session-contended:');
  expect(host.holder('tm-wait')).toBe('window-B');
  expect(service.getProcessId('tm-wait')).toBeUndefined();
  expect(api.releaseShellBinding).not.toHaveBeenCalled();
  expect(api.forgetRestoringLeaf).not.toHaveBeenCalled();
});

test('a refused binding cannot be made takeable by the losing window', async () => {
  const store = makeStore(); seed(store);
  const refusal = contended('tm-wait');
  const bind = jest.fn().mockResolvedValue({ status: 'refused' });
  const release = jest.fn();
  const { service } = makeService(store, jest.fn().mockRejectedValue(refusal), { bindShell: bind, releaseShellBinding: release });
  await expect(service.createTerminal('tm-wait')).rejects.toBe(refusal);
  expect(release).not.toHaveBeenCalled();
  expect(service.getProcessId('tm-wait')).toBeUndefined();
});

test('an unbound shell has a single binding winner', async () => {
  const host = makeBindingHost(); host.seed('tm-wait', 'pc-old-host');
  const services = ['one', 'two'].map(label => {
    const store = makeStore(); seed(store);
    const api = host.apiFor(label);
    return makeService(store, api.createTerminal, api).service;
  });
  const outcomes = await Promise.all(services.map(s => s.createTerminal('tm-wait').catch(e => e)));
  expect(outcomes.filter(v => v === 'pc-old-host')).toHaveLength(1);
  expect(outcomes.filter(v => v instanceof Error)).toHaveLength(1);
  expect(host.holder('tm-wait')).toBe('one');
});

function pendingDestination(answers: Array<{ status: string; processId?: string }>) {
  const store = makeStore(); seed(store);
  const refusal = contended('tm-wait');
  const bind = jest.fn();
  for (const answer of answers) bind.mockResolvedValueOnce(answer);
  bind.mockResolvedValue(answers.at(-1));
  const create = jest.fn().mockRejectedValue(refusal);
  const made = makeService(store, create, { bindShell: bind });
  const outcome = made.service.createTerminal('tm-wait').catch(error => error);
  return { ...made, store, refusal, bind, outcome };
}

test('a pending binding uses the leaf retry loop and eventually binds', async () => {
  const dest = pendingDestination([{ status: 'pending' }, { status: 'bound', processId: 'pc-late' }]);
  await flush();
  expect(dest.service.getHostWaitState('tm-wait')).toBe('waiting');
  await jest.advanceTimersByTimeAsync(1000);
  expect(await dest.outcome).toBe('pc-late');
  expect(dest.service.getProcessId('tm-wait')).toBe('pc-late');
  expect(dest.bind).toHaveBeenCalledTimes(2);
});

test('pending forever ends at the host retry budget, not a handoff delivery deadline', async () => {
  const dest = pendingDestination([{ status: 'pending' }]);
  await jest.advanceTimersByTimeAsync(90_000);
  expect((await dest.outcome).message).toMatch(/^host-ownership-pending:/);
  expect(dest.service.getHostWaitState('tm-wait')).toBe('retry');
  expect(dest.service.getProcessId('tm-wait')).toBeUndefined();
});

test('pending followed by no shell fails without an idle polling grace', async () => {
  const dest = pendingDestination([{ status: 'pending' }, { status: 'none' }]);
  await jest.advanceTimersByTimeAsync(1000);
  expect(await dest.outcome).toBe(dest.refusal);
  expect(dest.bind).toHaveBeenCalledTimes(2);
});

test('a late ready binding is still acquired after several host backoffs', async () => {
  const dest = pendingDestination([{ status: 'pending' }, { status: 'pending' }, { status: 'bound', processId: 'pc-late' }]);
  await jest.advanceTimersByTimeAsync(3000);
  expect(await dest.outcome).toBe('pc-late');
  expect(dest.bind).toHaveBeenCalledTimes(3);
});

test('a pane that leaves during binding wait stops silently', async () => {
  const dest = pendingDestination([{ status: 'pending' }]);
  await flush(); dest.store.dispatch(removeTabTree('tb-wait'));
  await jest.advanceTimersByTimeAsync(20_000);
  expect(await dest.outcome).toBe('');
  expect(dest.bind).toHaveBeenCalledTimes(1);
});

test('a failed bind preserves the original contention error', async () => {
  const store = makeStore(); seed(store);
  const refusal = contended('tm-wait');
  const { service } = makeService(store, jest.fn().mockRejectedValue(refusal), { bindShell: jest.fn().mockRejectedValue(new Error('ipc down')) });
  await expect(service.createTerminal('tm-wait')).rejects.toBe(refusal);
});

test.each(['host-ownership-pending: delayed', 'LIFECYCLE_BUSY: updating', 'spawn failed: no shell'])('only contention asks to bind a registered leaf: %s', async message => {
  const store = makeStore(); seed(store);
  const bind = jest.fn().mockResolvedValue({ status: 'bound', processId: 'not-mine' });
  const { service } = makeService(store, jest.fn().mockRejectedValue(new Error(message)), { bindShell: bind });
  const outcome = service.createTerminal('tm-wait').catch(e => e);
  await jest.advanceTimersByTimeAsync(2000);
  expect(bind).not.toHaveBeenCalled();
  store.dispatch(removeTabTree('tb-wait'));
  await jest.advanceTimersByTimeAsync(10_000);
  await outcome;
  expect(bind).not.toHaveBeenCalled();
});

test('a pane that leaves during a bind reply releases the backend holder', async () => {
  const store = makeStore(); seed(store);
  let answer!: (value: unknown) => void;
  const bind = jest.fn(() => new Promise(resolve => { answer = resolve; }));
  const release = jest.fn().mockResolvedValue(undefined);
  const { service } = makeService(store, jest.fn().mockRejectedValue(contended('tm-wait')), { bindShell: bind, releaseShellBinding: release });
  const promise = service.createTerminal('tm-wait');
  await flush(); store.dispatch(removeTabTree('tb-wait'));
  answer({ status: 'bound', processId: 'pc-old-host' });
  expect(await promise).toBe('');
  expect(release).toHaveBeenCalledWith('tm-wait');
  expect(service.getProcessId('tm-wait')).toBeUndefined();
});

test.each(['source', 'destination'])('close in %s while source creates closes the exact shell in the backend', async closer => {
  const host = makeBindingHost(); const sourceStore = makeStore(); seed(sourceStore);
  const sourceApi = host.apiFor('source'); const destApi = host.apiFor('destination');
  const source = makeService(sourceStore, sourceApi.createTerminal, sourceApi);
  const destination = makeService(makeStore(), destApi.createTerminal, destApi);
  const promise = source.service.createTerminal('tm-wait');
  await flush(); sourceStore.dispatch(removeTabTree('tb-wait'));
  source.service.detachTerminal('tm-wait');
  await (closer === 'source' ? source : destination).service.closeTerminal('tm-wait');
  host.complete('tm-wait');
  expect(await promise).toBe('');
  expect(host.closed).toEqual(['pc-old-host']);
  expect(host.holder('tm-wait')).toBeUndefined();
});

test('a moved create releases ownership without closing the shell', async () => {
  const host = makeBindingHost(); const store = makeStore(); seed(store);
  const api = host.apiFor('source'); const { service } = makeService(store, api.createTerminal, api);
  const promise = service.createTerminal('tm-wait');
  await flush(); store.dispatch(removeTabTree('tb-wait')); service.detachTerminal('tm-wait');
  host.complete('tm-wait');
  expect(await promise).toBe('');
  expect(host.holder('tm-wait')).toBeUndefined();
  expect(host.closed).toEqual([]);
  expect(api.forgetRestoringLeaf).not.toHaveBeenCalled();
});

test('a close during one create does not turn a later move into a close', async () => {
  const host = makeBindingHost(); const store = makeStore(); seed(store);
  const api = host.apiFor('source'); const { service } = makeService(store, api.createTerminal, api);
  const first = service.createTerminal('tm-wait');
  await flush(); store.dispatch(removeTabTree('tb-wait')); await service.closeTerminal('tm-wait');
  host.complete('tm-wait'); expect(await first).toBe('');
  seed(store);
  const second = service.createTerminal('tm-wait');
  await flush(); store.dispatch(removeTabTree('tb-wait')); service.detachTerminal('tm-wait');
  host.complete('tm-wait'); expect(await second).toBe('');
  expect(host.closed).toEqual(['pc-old-host']);
  expect(host.holder('tm-wait')).toBeUndefined();
});

test('host retry backoff is 1, 2, 4, 8, 8 seconds and ends with Retry at 90 seconds', async () => {
  const store = makeStore(); seed(store);
  const times: number[] = []; const start = Date.now();
  const create = jest.fn(async () => { times.push(Date.now() - start); throw new Error('host-ownership-pending: unanswered'); });
  const { service } = makeService(store, create);
  const promise = service.createTerminal('tm-wait').catch(error => error);
  await jest.advanceTimersByTimeAsync(90_000);
  expect((await promise).message).toMatch(/^host-ownership-pending:/);
  expect(times.slice(0, 6)).toEqual([0, 1000, 3000, 7000, 15000, 23000]);
  expect(times.at(-1)).toBe(90_000);
  expect(service.getHostWaitState('tm-wait')).toBe('retry');
  create.mockResolvedValueOnce('pc-retry' as never);
  expect(await service.createTerminal('tm-wait')).toBe('pc-retry');
  expect(service.getHostWaitState('tm-wait')).toBeUndefined();
});

test('LIFECYCLE_BUSY retries briefly and never exceeds ten seconds', async () => {
  const store = makeStore(); seed(store);
  const create = jest.fn().mockRejectedValue('LIFECYCLE_BUSY: updating');
  const { service } = makeService(store, create);
  const promise = service.createTerminal('tm-wait').catch(error => error);
  await jest.advanceTimersByTimeAsync(10_000);
  expect(await promise).toBe('LIFECYCLE_BUSY: updating'); expect(create).toHaveBeenCalledTimes(21);
  create.mockRejectedValueOnce('LIFECYCLE_BUSY: updating').mockResolvedValueOnce('pc-reopened');
  const retry = service.createTerminal('tm-wait'); await jest.advanceTimersByTimeAsync(500);
  expect(await retry).toBe('pc-reopened');
});

test.each(['close', 'clear', 'detach'])('presence cancellation on %s stops silently without further creates', async reason => {
  const store = makeStore(); seed(store);
  const create = jest.fn().mockRejectedValue('host-ownership-pending: unanswered');
  const { service, api } = makeService(store, create);
  const promise = service.createTerminal('tm-wait'); await flush();
  store.dispatch(removeTabTree('tb-wait'));
  if (reason === 'close') await service.closeTerminal('tm-wait');
  if (reason === 'detach') service.detachTerminal('tm-wait');
  await jest.advanceTimersByTimeAsync(30_000);
  expect(await promise).toBe(''); expect(create).toHaveBeenCalledTimes(1);
  expect(api.forgetRestoringLeaf.mock.calls).toEqual(reason === 'close' ? [['tm-wait']] : []);
});

test('closeTerminal no-process branch forgets restore intent', async () => {
  const { service, api } = makeService(makeStore()); await service.closeTerminal('tm-never-bound');
  expect(api.forgetRestoringLeaf).toHaveBeenCalledWith('tm-never-bound');
});

test('closeTerminal still clears wait state when forgetting restore intent fails', async () => {
  const store = makeStore(); seed(store);
  const { service, api } = makeService(store, jest.fn().mockRejectedValue('host-ownership-pending: unanswered'));
  const waiting = service.createTerminal('tm-wait'); await flush();
  expect(service.getHostWaitState('tm-wait')).toBe('waiting');
  api.forgetRestoringLeaf.mockRejectedValueOnce(new Error('ipc down'));
  await expect(service.closeTerminal('tm-wait')).resolves.toBeUndefined();
  expect(service.getHostWaitState('tm-wait')).toBeUndefined();
  store.dispatch(removeTabTree('tb-wait')); await jest.advanceTimersByTimeAsync(1000);
  expect(await waiting).toBe('');
});

test('an absent leaf cannot start even its first attempt', async () => {
  const { service, createTerminal } = makeService(makeStore());
  expect(await service.createTerminal('tm-absent')).toBe(''); expect(createTerminal).not.toHaveBeenCalled();
});
