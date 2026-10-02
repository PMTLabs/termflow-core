/** @jest-environment jsdom */
import { configureStore } from '@reduxjs/toolkit';
import panesReducer, { addTabTree, removeTabTree } from '../../store/slices/panesSlice';
import { TerminalServiceClass } from '../TerminalService';

const leaf = (terminalId: string) => ({ id: `pn-${terminalId}`, type: 'terminal' as const, terminalId });
const makeStore = () => configureStore({ reducer: { panes: panesReducer } });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function makeService(store: ReturnType<typeof makeStore>, createTerminal = jest.fn(), extraApi: Record<string, unknown> = {}) {
  const api = {
    createTerminal, forgetRestoringLeaf: jest.fn().mockResolvedValue(undefined),
    closeTerminal: jest.fn().mockResolvedValue(undefined),
    adoptConsoleWindow: jest.fn().mockResolvedValue(undefined),
    ...extraApi,
  };
  const service = new TerminalServiceClass(() => store.getState().panes.treesByTabId, () => api as any);
  return { service, api, createTerminal };
}

beforeEach(() => {
  jest.useFakeTimers();
  delete (window as any).electronAPI;
});
afterEach(() => { jest.useRealTimers(); });

test('split_a_waiting_solo_pane_does_not_spawn', async () => {
  const store = makeStore();
  store.dispatch(addTabTree({ tabId: 'tb-source', tree: leaf('tm-wait') }));
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
  const firstMount = service.createTerminal('tm-wait');
  await flush();
  expect(service.getHostWaitState('tm-wait')).toBe('waiting');
  await jest.advanceTimersByTimeAsync(500);
  store.dispatch(addTabTree({ tabId: 'tb-source', tree: {
    id: 'pn-split', type: 'split', direction: 'horizontal', children: [leaf('tm-wait'), leaf('tm-fresh')],
  } }));
  const remount = service.createTerminal('tm-wait');
  const fresh = service.createTerminal('tm-fresh');
  await flush();
  expect(create.mock.calls.filter(call => call[3] === 'tm-wait')).toHaveLength(1);
  resolved = true;
  await jest.advanceTimersByTimeAsync(500);
  expect(await firstMount).toBe('pc-old-host');
  expect(await remount).toBe('pc-old-host');
  expect(await fresh).toBe('pc-current-host');
  expect(frames).toEqual([{ kind: 'Spawn', leaf: 'tm-fresh' }, { kind: 'Attach', leaf: 'tm-wait' }]);
  expect(service.getHostWaitState('tm-wait')).toBeUndefined();
});

test('a contended create fails immediately without borrowing another window process', async () => {
  const storeB = makeStore();
  const storeMain = makeStore();
  storeB.dispatch(addTabTree({ tabId: 'tb-detached', tree: leaf('tm-x') }));
  storeMain.dispatch(addTabTree({ tabId: 'tb-loaded', tree: leaf('tm-x') }));
  const windowB = makeService(storeB);
  windowB.service.attachExistingTerminal('tm-x', 'pc-1');
  const refusal = new Error('host-session-contended: already registered');
  const main = makeService(storeMain, jest.fn().mockRejectedValue(refusal), {
    getProcessIdForLeaf: jest.fn(async () => 'pc-1'),
  });
  await expect(main.service.createTerminal('tm-x')).rejects.toBe(refusal);
  expect(main.createTerminal).toHaveBeenCalledTimes(1);
  expect(main.service.getProcessId('tm-x')).toBeUndefined();
  expect(main.service.getTerminalIdForProcess('pc-1')).toBeUndefined();
  expect(main.api.getProcessIdForLeaf).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
  expect(windowB.service.getProcessId('tm-x')).toBe('pc-1');
  expect(windowB.api.forgetRestoringLeaf).not.toHaveBeenCalled();
});

test.each(['host-ownership-pending: listing delayed', 'LIFECYCLE_BUSY: updating', 'spawn failed: no such shell'])('a failed create never borrows a process by leaf: %s', async message => {
  const store = makeStore();
  store.dispatch(addTabTree({ tabId: 'tb-other', tree: leaf('tm-other') }));
  const { service, api } = makeService(store, jest.fn().mockRejectedValue(new Error(message)), {
    getProcessIdForLeaf: jest.fn().mockResolvedValue('pc-other-window'),
  });
  const outcome = service.createTerminal('tm-other').catch(error => error);
  await jest.advanceTimersByTimeAsync(2_000);
  expect(api.getProcessIdForLeaf).not.toHaveBeenCalled();
  expect(service.getProcessId('tm-other')).toBeUndefined();
  store.dispatch(removeTabTree('tb-other'));
  await jest.advanceTimersByTimeAsync(10_000);
  await outcome;
  expect(api.getProcessIdForLeaf).not.toHaveBeenCalled();
});

test('host retry backoff is 1, 2, 4, 8, 8 seconds and ends with Retry at 90 seconds', async () => {
  const store = makeStore();
  store.dispatch(addTabTree({ tabId: 'tb-wait', tree: leaf('tm-wait') }));
  const times: number[] = [];
  const start = Date.now();
  const create = jest.fn(async () => {
    times.push(Date.now() - start);
    throw new Error('host-ownership-pending: unanswered');
  });
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
  const store = makeStore();
  store.dispatch(addTabTree({ tabId: 'tb-wait', tree: leaf('tm-wait') }));
  const create = jest.fn().mockRejectedValue('LIFECYCLE_BUSY: updating');
  const { service } = makeService(store, create);
  const promise = service.createTerminal('tm-wait').catch(error => error);
  await jest.advanceTimersByTimeAsync(10_000);
  expect(await promise).toBe('LIFECYCLE_BUSY: updating');
  expect(create).toHaveBeenCalledTimes(21);
  expect(service.getHostWaitState('tm-wait')).toBeUndefined();
  create.mockRejectedValueOnce('LIFECYCLE_BUSY: updating').mockResolvedValueOnce('pc-reopened');
  const retry = service.createTerminal('tm-wait');
  await jest.advanceTimersByTimeAsync(500);
  expect(await retry).toBe('pc-reopened');
});

test.each(['close', 'clear', 'detach'])('presence cancellation on %s stops silently without further creates', async reason => {
  const store = makeStore();
  store.dispatch(addTabTree({ tabId: 'tb-wait', tree: leaf('tm-wait') }));
  const create = jest.fn().mockRejectedValue('host-ownership-pending: unanswered');
  const { service, api } = makeService(store, create);
  const promise = service.createTerminal('tm-wait');
  await flush();
  store.dispatch(removeTabTree('tb-wait'));
  if (reason === 'close') await service.closeTerminal('tm-wait');
  if (reason === 'detach') service.detachTerminal('tm-wait');
  await jest.advanceTimersByTimeAsync(30_000);
  expect(await promise).toBe('');
  expect(create).toHaveBeenCalledTimes(1);
  expect(api.forgetRestoringLeaf).not.toHaveBeenCalled();
});

test('browser no-process close has no label-keyed holder side channel', async () => {
  const { service, api } = makeService(makeStore());
  await service.closeTerminal('tm-never-bound');
  expect(api.forgetRestoringLeaf).not.toHaveBeenCalled();
  expect(api.closeTerminal).not.toHaveBeenCalled();
});

test('browser no-process close clears wait state without invoking a holder side channel', async () => {
  const store = makeStore();
  store.dispatch(addTabTree({ tabId: 'tb-wait', tree: leaf('tm-wait') }));
  const { service, api } = makeService(store, jest.fn().mockRejectedValue('host-ownership-pending: unanswered'));
  const waiting = service.createTerminal('tm-wait');
  await flush();
  expect(service.getHostWaitState('tm-wait')).toBe('waiting');
  api.forgetRestoringLeaf.mockRejectedValueOnce(new Error('ipc down'));
  await expect(service.closeTerminal('tm-wait')).resolves.toBeUndefined();
  expect(service.getHostWaitState('tm-wait')).toBeUndefined();
  store.dispatch(removeTabTree('tb-wait'));
  await jest.advanceTimersByTimeAsync(1000);
  expect(await waiting).toBe('');
});

test('an absent leaf cannot start even its first attempt', async () => {
  const { service, createTerminal } = makeService(makeStore());
  expect(await service.createTerminal('tm-absent')).toBe('');
  expect(createTerminal).not.toHaveBeenCalled();
});
