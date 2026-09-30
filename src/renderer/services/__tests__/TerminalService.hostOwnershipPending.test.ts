/** @jest-environment jsdom */
import { configureStore } from '@reduxjs/toolkit';
import panesReducer, { addTabTree, removeTabTree } from '../../store/slices/panesSlice';
import { TerminalServiceClass } from '../TerminalService';

const leaf = (terminalId: string) => ({ id: `pn-${terminalId}`, type: 'terminal' as const, terminalId });
const makeStore = () => configureStore({ reducer: { panes: panesReducer } });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function makeService(store: ReturnType<typeof makeStore>, createTerminal = jest.fn()) {
  const api = {
    createTerminal, forgetRestoringLeaf: jest.fn().mockResolvedValue(undefined),
    adoptConsoleWindow: jest.fn().mockResolvedValue(undefined),
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

test('move_a_waiting_pane_to_another_window_does_not_spawn_and_binds_in_the_destination', async () => {
  const sourceStore = makeStore();
  const destinationStore = makeStore();
  const tree = { id: 'pn-split', type: 'split' as const, direction: 'horizontal' as const,
    children: [leaf('tm-live'), leaf('tm-wait')] };
  sourceStore.dispatch(addTabTree({ tabId: 'tb-source', tree }));
  let resolved = false;
  const frames: Array<{ window: string; kind: string; leaf: string }> = [];
  const createFor = (windowId: string) => jest.fn(async (_profile, _name, _cwd, id) => {
    if (!resolved) throw 'host-ownership-pending: old host listing delayed';
    frames.push({ window: windowId, kind: 'Attach', leaf: id });
    return 'pc-old-host';
  });
  const source = makeService(sourceStore, createFor('source'));
  const destination = makeService(destinationStore, createFor('destination'));
  source.service.registerExistingTerminal('tm-live', 'pc-live');
  const sourcePromise = source.service.createTerminal('tm-wait');
  await flush();
  await jest.advanceTimersByTimeAsync(500);
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
  resolved = true;
  await jest.advanceTimersByTimeAsync(1000);
  await destinationPromise;
  expect(await sourcePromise).toBe('');
  expect(source.createTerminal).toHaveBeenCalledTimes(1); // zero attempts after the move
  expect(destinationPane).toEqual({ processId: 'pc-old-host', startupFailed: false });
  expect(destination.service.getProcessId('tm-wait')).toBe('pc-old-host');
  expect(source.service.getProcessId('tm-wait')).toBeUndefined();
  expect(frames).toEqual([{ window: 'destination', kind: 'Attach', leaf: 'tm-wait' }]);
  expect(source.api.forgetRestoringLeaf).not.toHaveBeenCalled();
  expect(destination.api.forgetRestoringLeaf).not.toHaveBeenCalled();
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

test('an absent leaf cannot start even its first attempt', async () => {
  const { service, createTerminal } = makeService(makeStore());
  expect(await service.createTerminal('tm-absent')).toBe('');
  expect(createTerminal).not.toHaveBeenCalled();
});
