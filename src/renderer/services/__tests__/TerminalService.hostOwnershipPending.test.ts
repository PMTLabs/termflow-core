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
  await jest.advanceTimersByTimeAsync(500); // Split INSIDE the first backoff sleep.
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

// A host whose keyed creates park in flight (as the backend does at its barrier) until the
// test releases them. The first release takes the session; a later one is refused as contended.
function makeGatedHost() {
  const parked = new Map<string, () => void>();
  const frames: Array<{ window: string; kind: string; leaf: string }> = [];
  let holder: string | undefined;
  const createFor = (windowId: string) => jest.fn((_profile, _name, _cwd, id) => new Promise<string>((resolve, reject) => {
    parked.set(windowId, () => {
      if (holder) {
        reject(new Error(`host-session-contended: host session ${id} is already registered`));
        return;
      }
      holder = 'pc-old-host';
      frames.push({ window: windowId, kind: 'Attach', leaf: id });
      resolve(holder);
    });
  }));
  return {
    createFor,
    frames,
    isParked: (windowId: string) => parked.has(windowId),
    release: (windowId: string) => parked.get(windowId)!(),
    processIdForLeaf: jest.fn(async () => holder ?? null),
  };
}

test.each([
  ['the window the pane left', 'source', 'destination'],
  ['the window the pane moved to', 'destination', 'source'],
] as const)('move_a_waiting_pane_to_another_window_while_its_create_is_in_flight: %s wins the session', async (_label, first, second) => {
  const sourceStore = makeStore();
  const destinationStore = makeStore();
  const tree = { id: 'pn-split', type: 'split' as const, direction: 'horizontal' as const,
    children: [leaf('tm-live'), leaf('tm-wait')] };
  sourceStore.dispatch(addTabTree({ tabId: 'tb-source', tree }));
  const host = makeGatedHost();
  const source = makeService(sourceStore, host.createFor('source'), { getProcessIdForLeaf: host.processIdForLeaf });
  const destination = makeService(destinationStore, host.createFor('destination'), { getProcessIdForLeaf: host.processIdForLeaf });
  source.service.registerExistingTerminal('tm-live', 'pc-live');
  const sourcePromise = source.service.createTerminal('tm-wait');
  await flush();
  expect(host.isParked('source')).toBe(true); // in the backend's barrier, not in a backoff sleep
  // A tab with a live pane can move while its sibling is waiting for an owner.
  sourceStore.dispatch(removeTabTree('tb-source'));
  source.service.detachTerminal('tm-live');
  source.service.detachTerminal('tm-wait');
  destinationStore.dispatch(addTabTree({ tabId: 'tb-destination', tree }));
  destination.service.attachExistingTerminal('tm-live', 'pc-live');
  const destinationPane = { processId: undefined as string | undefined, startupFailed: false };
  const destinationPromise = destination.service.createTerminal('tm-wait').then(pid => {
    destinationPane.processId = pid;
  }, () => { destinationPane.startupFailed = true; });
  await flush();
  expect(host.isParked('destination')).toBe(true);

  host.release(first);
  await flush();
  host.release(second);
  await flush();
  await destinationPromise;

  expect(await sourcePromise).toBe('');
  expect(destinationPane).toEqual({ processId: 'pc-old-host', startupFailed: false });
  expect(destination.service.getProcessId('tm-wait')).toBe('pc-old-host');
  expect(source.service.getProcessId('tm-wait')).toBeUndefined();
  // One shell, reachable from exactly one window, and never a second session for the leaf.
  const holders = [source, destination].filter(w => w.service.getTerminalIdForProcess('pc-old-host') === 'tm-wait');
  expect(holders).toEqual([destination]);
  expect(host.frames).toEqual([{ window: first, kind: 'Attach', leaf: 'tm-wait' }]);
  expect(source.createTerminal).toHaveBeenCalledTimes(1);
  expect(destination.createTerminal).toHaveBeenCalledTimes(1);
  expect(source.service.getHostWaitState('tm-wait')).toBeUndefined();
  expect(destination.service.getHostWaitState('tm-wait')).toBeUndefined();
  expect(source.api.forgetRestoringLeaf).not.toHaveBeenCalled();
  expect(destination.api.forgetRestoringLeaf).not.toHaveBeenCalled();
});

test('a contended create for a leaf that no registered session carries still fails', async () => {
  const store = makeStore();
  store.dispatch(addTabTree({ tabId: 'tb-lost', tree: leaf('tm-lost') }));
  const refusal = new Error('host-session-contended: claimed by another recovery');
  const { service, api } = makeService(store, jest.fn().mockRejectedValue(refusal), {
    getProcessIdForLeaf: jest.fn().mockResolvedValue(null),
  });
  await expect(service.createTerminal('tm-lost')).rejects.toBe(refusal);
  expect(api.getProcessIdForLeaf).toHaveBeenCalledWith('tm-lost');
  expect(service.getProcessId('tm-lost')).toBeUndefined();
});

test('a failed lookup of the registered session leaves the contention error intact', async () => {
  const store = makeStore();
  store.dispatch(addTabTree({ tabId: 'tb-lost', tree: leaf('tm-lost') }));
  const refusal = new Error('host-session-contended: host session tm-lost is already registered');
  const { service } = makeService(store, jest.fn().mockRejectedValue(refusal), {
    getProcessIdForLeaf: jest.fn().mockRejectedValue(new Error('ipc down')),
  });
  await expect(service.createTerminal('tm-lost')).rejects.toBe(refusal);
});

test('a pane that leaves while it looks up its registered session binds nothing', async () => {
  const store = makeStore();
  store.dispatch(addTabTree({ tabId: 'tb-moving', tree: leaf('tm-moving') }));
  let answer!: (processId: string) => void;
  const lookup = jest.fn(() => new Promise<string>(resolve => { answer = resolve; }));
  const { service } = makeService(
    store,
    jest.fn().mockRejectedValue(new Error('host-session-contended: host session tm-moving is already registered')),
    { getProcessIdForLeaf: lookup },
  );
  const promise = service.createTerminal('tm-moving');
  await flush();
  expect(lookup).toHaveBeenCalledTimes(1);
  store.dispatch(removeTabTree('tb-moving'));
  answer('pc-old-host');
  expect(await promise).toBe('');
  expect(service.getProcessId('tm-moving')).toBeUndefined();
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
  expect(api.forgetRestoringLeaf.mock.calls).toEqual(reason === 'close' ? [['tm-wait']] : []);
});

test('closeTerminal no-process branch forgets restore intent', async () => {
  const { service, api } = makeService(makeStore());
  await service.closeTerminal('tm-never-bound');
  expect(api.forgetRestoringLeaf).toHaveBeenCalledWith('tm-never-bound');
});

test('closeTerminal still clears the wait state and resolves when forgetting the restore intent fails', async () => {
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
