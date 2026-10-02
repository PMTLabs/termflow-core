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
// test lets them claim the session. The first claim wins it and that create then keeps running
// (the host's attach or spawn request) until the test completes it; a later claim is refused as
// contended at once. Hand-offs behave like the backend's: an offer must name the terminal
// registered for the leaf, a take is single use, and with nothing on offer it says whether the
// winner's create is still running.
function makeGatedHost() {
  const parked = new Map<string, () => void>();
  const finishing = new Map<string, () => void>();
  const frames: Array<{ window: string; kind: string; leaf: string }> = [];
  let holder: string | undefined;
  let creating = false;
  let offered: string | undefined;
  const createFor = (windowId: string) => jest.fn((_profile, _name, _cwd, id) => new Promise<string>((resolve, reject) => {
    parked.set(windowId, () => {
      if (holder) {
        reject(new Error(`host-session-contended: host session ${id} is already registered`));
        return;
      }
      holder = 'pc-old-host';
      creating = true;
      frames.push({ window: windowId, kind: 'Attach', leaf: id });
      finishing.set(windowId, () => {
        creating = false;
        resolve(holder!);
      });
    });
  }));
  return {
    createFor,
    frames,
    isParked: (windowId: string) => parked.has(windowId),
    /** The window's create reaches the backend and takes the session (or is refused). */
    claim: (windowId: string) => parked.get(windowId)!(),
    /** The winner's host request finishes and its create returns. */
    complete: (windowId: string) => finishing.get(windowId)!(),
    pendingOffer: () => offered,
    /** A terminal shown by a window that is not part of the hand-off. */
    holdWithoutOffer: (processId: string) => { holder = processId; },
    offerSessionHandoff: jest.fn(async (_leaf: string, processId: string) => {
      if (!holder || processId !== holder) return false;
      offered = holder;
      return true;
    }),
    takeSessionHandoff: jest.fn(async (_leaf: string) => {
      if (offered && offered === holder) {
        const processId = offered;
        offered = undefined;
        return { status: 'taken' as const, processId };
      }
      return creating ? { status: 'inFlight' as const } : { status: 'none' as const };
    }),
  };
}

// The pane moves while its create is parked. The window that wins the session is not the window
// whose create returns first: the winner's host request takes `hostRequestMs` more, during which
// the loser has already been refused.
test.each([
  ['the window the pane left claims first; a 700 ms host request', 'source', 'destination', 700],
  ['the window the pane moved to claims first; a 700 ms host request', 'destination', 'source', 700],
  ['the window the pane left claims first; a 9 s host request', 'source', 'destination', 9_000],
] as const)('move_a_waiting_pane_to_another_window_while_its_create_is_in_flight: %s', async (_label, first, second, hostRequestMs) => {
  const sourceStore = makeStore();
  const destinationStore = makeStore();
  const tree = { id: 'pn-split', type: 'split' as const, direction: 'horizontal' as const,
    children: [leaf('tm-live'), leaf('tm-wait')] };
  sourceStore.dispatch(addTabTree({ tabId: 'tb-source', tree }));
  const host = makeGatedHost();
  const handoff = { offerSessionHandoff: host.offerSessionHandoff, takeSessionHandoff: host.takeSessionHandoff };
  const source = makeService(sourceStore, host.createFor('source'), handoff);
  const destination = makeService(destinationStore, host.createFor('destination'), handoff);
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

  // One window takes the session; the other is refused at once. Neither create has returned.
  host.claim(first);
  await flush();
  host.claim(second);
  await flush();
  // The winner's host request is slow. The destination has no shell yet and must not have given up.
  await jest.advanceTimersByTimeAsync(hostRequestMs);
  expect(destinationPane).toEqual({ processId: undefined, startupFailed: false });
  expect(destination.service.getProcessId('tm-wait')).toBeUndefined();

  host.complete(first);
  await flush();
  await jest.advanceTimersByTimeAsync(300); // the destination's next ask
  await destinationPromise;

  expect(await sourcePromise).toBe('');
  expect(destinationPane).toEqual({ processId: 'pc-old-host', startupFailed: false });
  expect(destination.service.getProcessId('tm-wait')).toBe('pc-old-host');
  expect(source.service.getProcessId('tm-wait')).toBeUndefined();
  // One shell, reachable from exactly one window, and never a second session for the leaf.
  const holders = [source, destination].filter(w => w.service.getTerminalIdForProcess('pc-old-host') === 'tm-wait');
  expect(holders).toEqual([destination]);
  expect(host.frames).toEqual([{ window: first, kind: 'Attach', leaf: 'tm-wait' }]);
  // The source offers (naming the process its create returned) only when it won; nothing is left on offer.
  expect(host.offerSessionHandoff.mock.calls).toEqual(first === 'source' ? [['tm-wait', 'pc-old-host']] : []);
  expect(host.pendingOffer()).toBeUndefined();
  expect(source.createTerminal).toHaveBeenCalledTimes(1);
  expect(destination.createTerminal).toHaveBeenCalledTimes(1);
  expect(source.service.getHostWaitState('tm-wait')).toBeUndefined();
  expect(destination.service.getHostWaitState('tm-wait')).toBeUndefined();
  expect(source.api.forgetRestoringLeaf).not.toHaveBeenCalled();
  expect(destination.api.forgetRestoringLeaf).not.toHaveBeenCalled();
});

const contended = (leafId: string) => new Error(`host-session-contended: host session ${leafId} is already registered`);
const none = { status: 'none' as const };
const inFlight = { status: 'inFlight' as const };

test('a contended create with nothing in flight still fails after a few short asks', async () => {
  const store = makeStore();
  store.dispatch(addTabTree({ tabId: 'tb-lost', tree: leaf('tm-lost') }));
  const refusal = new Error('host-session-contended: claimed by another recovery');
  const times: number[] = [];
  const start = Date.now();
  const take = jest.fn(async () => { times.push(Date.now() - start); return none; });
  const { service } = makeService(store, jest.fn().mockRejectedValue(refusal), { takeSessionHandoff: take });
  let settled = false;
  const outcome = service.createTerminal('tm-lost').catch(error => error).finally(() => { settled = true; });
  await jest.advanceTimersByTimeAsync(399);
  expect(settled).toBe(false);
  await jest.advanceTimersByTimeAsync(1);
  expect(await outcome).toBe(refusal);
  expect(take.mock.calls).toEqual([['tm-lost'], ['tm-lost'], ['tm-lost']]);
  expect(times).toEqual([0, 200, 400]);
  expect(service.getProcessId('tm-lost')).toBeUndefined();
});

test('a process another window already shows is never adopted', async () => {
  // Window B shows tm-x on pc-1 (a detached tab). A saved layout containing tm-x is then
  // loaded in the main window: its create is refused as contended, and nobody offered pc-1.
  const storeB = makeStore();
  const storeMain = makeStore();
  storeB.dispatch(addTabTree({ tabId: 'tb-detached', tree: leaf('tm-x') }));
  storeMain.dispatch(addTabTree({ tabId: 'tb-loaded', tree: leaf('tm-x') }));
  const windowB = makeService(storeB);
  windowB.service.attachExistingTerminal('tm-x', 'pc-1');
  const refusal = contended('tm-x');
  const take = jest.fn().mockResolvedValue(none);
  const main = makeService(storeMain, jest.fn().mockRejectedValue(refusal), {
    takeSessionHandoff: take,
    getProcessIdForLeaf: jest.fn(async () => 'pc-1'), // what a lookup by leaf would answer
    offerSessionHandoff: jest.fn().mockResolvedValue(false),
  });
  const outcome = main.service.createTerminal('tm-x').catch(error => error);
  await jest.advanceTimersByTimeAsync(5_000);
  expect(await outcome).toBe(refusal);
  expect(main.service.getProcessId('tm-x')).toBeUndefined();
  expect(main.service.getTerminalIdForProcess('pc-1')).toBeUndefined();
  expect(main.api.getProcessIdForLeaf).not.toHaveBeenCalled();
  expect(main.api.offerSessionHandoff).not.toHaveBeenCalled(); // not even to re-offer a shell it never created
  expect(take).toHaveBeenCalledTimes(3); // bounded
  expect(windowB.service.getProcessId('tm-x')).toBe('pc-1');
  expect(windowB.api.forgetRestoringLeaf).not.toHaveBeenCalled();
});

test('a shell another window shows stays unadoptable against a backend that honours offer then take', async () => {
  // pc-1 was registered long ago and bound by window B; no create is running. The main
  // window's contended create must end with its refusal even though a backend lookup by
  // leaf would find pc-1, and nothing it does may make pc-1 takeable.
  const host = makeGatedHost();
  host.holdWithoutOffer('pc-1');
  const store = makeStore();
  store.dispatch(addTabTree({ tabId: 'tb-loaded', tree: leaf('tm-x') }));
  const refusal = contended('tm-x');
  const main = makeService(store, jest.fn().mockRejectedValue(refusal), {
    offerSessionHandoff: host.offerSessionHandoff, takeSessionHandoff: host.takeSessionHandoff,
  });
  const outcome = main.service.createTerminal('tm-x').catch(error => error);
  await jest.advanceTimersByTimeAsync(5_000);
  expect(await outcome).toBe(refusal);
  expect(host.offerSessionHandoff).not.toHaveBeenCalled();
  expect(host.pendingOffer()).toBeUndefined();
  expect(main.service.getProcessId('tm-x')).toBeUndefined();
  // And the backend itself refuses an offer for a process the offerer did not create.
  expect(await host.offerSessionHandoff('tm-x', 'pc-not-mine')).toBe(false);
  expect(await host.takeSessionHandoff('tm-x')).toEqual(none);
});

test('an offer is single-use', async () => {
  const host = makeGatedHost();
  host.createFor('winner')('default', undefined, undefined, 'tm-wait');
  host.claim('winner'); // registers pc-old-host
  host.complete('winner');
  await host.offerSessionHandoff('tm-wait', 'pc-old-host');
  const refuseAll = () => jest.fn().mockRejectedValue(contended('tm-wait'));
  const storeOne = makeStore();
  const storeTwo = makeStore();
  storeOne.dispatch(addTabTree({ tabId: 'tb-one', tree: leaf('tm-wait') }));
  storeTwo.dispatch(addTabTree({ tabId: 'tb-two', tree: leaf('tm-wait') }));
  const handoff = { takeSessionHandoff: host.takeSessionHandoff };
  const one = makeService(storeOne, refuseAll(), handoff);
  const two = makeService(storeTwo, refuseAll(), handoff);
  const outcomes = Promise.all([
    one.service.createTerminal('tm-wait').catch(error => error),
    two.service.createTerminal('tm-wait').catch(error => error),
  ]);
  await jest.advanceTimersByTimeAsync(400);
  const results = await outcomes;
  expect(results.filter(result => result === 'pc-old-host')).toHaveLength(1);
  expect(results.filter(result => result instanceof Error)).toHaveLength(1);
  const holders = [one, two].filter(w => w.service.getProcessId('tm-wait') === 'pc-old-host');
  expect(holders).toHaveLength(1);
});

describe('the destination of a moved pane while the other window\'s create is still running', () => {
  function refusedDestination(answers: Array<() => unknown>) {
    const store = makeStore();
    store.dispatch(addTabTree({ tabId: 'tb-dest', tree: leaf('tm-wait') }));
    const refusal = contended('tm-wait');
    const times: number[] = [];
    const start = Date.now();
    let call = 0;
    const take = jest.fn(async () => {
      times.push(Date.now() - start);
      return answers[Math.min(call++, answers.length - 1)]();
    });
    const made = makeService(store, jest.fn().mockRejectedValue(refusal), { takeSessionHandoff: take });
    let settled = false;
    const outcome = made.service.createTerminal('tm-wait').then(
      pid => ({ pid }), error => ({ error }),
    ).finally(() => { settled = true; });
    return { store, ...made, refusal, take, times, outcome, isSettled: () => settled };
  }

  test('keeps asking every 250 ms and binds the offer when it arrives', async () => {
    const dest = refusedDestination([() => inFlight, () => inFlight, () => inFlight, () => ({ status: 'taken', processId: 'pc-late' })]);
    await jest.advanceTimersByTimeAsync(749);
    expect(dest.isSettled()).toBe(false);
    expect(dest.take).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(1);
    expect(await dest.outcome).toEqual({ pid: 'pc-late' });
    expect(dest.times).toEqual([0, 250, 500, 750]);
    expect(dest.service.getProcessId('tm-wait')).toBe('pc-late');
  });

  test('an answer of in-flight forever fails only after fifteen seconds, with the original error', async () => {
    const dest = refusedDestination([() => inFlight]);
    await jest.advanceTimersByTimeAsync(14_999);
    expect(dest.isSettled()).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    const result = await dest.outcome;
    expect('error' in result && result.error).toBe(dest.refusal);
    expect(dest.times.slice(0, 3)).toEqual([0, 250, 500]);
    expect(dest.times.at(-1)).toBe(15_000);
    expect(dest.service.getProcessId('tm-wait')).toBeUndefined();
  });

  test('the short grace counts from the last in-flight answer', async () => {
    // In flight at 0 and 250, then the create returned without offering: three more asks, 200 ms apart.
    const dest = refusedDestination([() => inFlight, () => inFlight, () => none]);
    await jest.advanceTimersByTimeAsync(899);
    expect(dest.isSettled()).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    const result = await dest.outcome;
    expect('error' in result && result.error).toBe(dest.refusal);
    expect(dest.times).toEqual([0, 250, 500, 700, 900]);
  });

  test('an offer that arrives during the short grace is still taken', async () => {
    const dest = refusedDestination([() => inFlight, () => none, () => ({ status: 'taken', processId: 'pc-late' })]);
    await jest.advanceTimersByTimeAsync(450);
    expect(await dest.outcome).toEqual({ pid: 'pc-late' });
    expect(dest.times).toEqual([0, 250, 450]);
  });

  test('a pane that leaves while it waits stops asking and fails silently', async () => {
    const dest = refusedDestination([() => inFlight]);
    await jest.advanceTimersByTimeAsync(600);
    expect(dest.take).toHaveBeenCalledTimes(3);
    dest.store.dispatch(removeTabTree('tb-dest'));
    await jest.advanceTimersByTimeAsync(20_000);
    expect(await dest.outcome).toEqual({ pid: '' });
    expect(dest.take).toHaveBeenCalledTimes(3);
    expect(dest.service.getProcessId('tm-wait')).toBeUndefined();
  });
});

test('a failed take leaves the contention error intact', async () => {
  const store = makeStore();
  store.dispatch(addTabTree({ tabId: 'tb-lost', tree: leaf('tm-lost') }));
  const refusal = contended('tm-lost');
  const { service } = makeService(store, jest.fn().mockRejectedValue(refusal), {
    takeSessionHandoff: jest.fn().mockRejectedValue(new Error('ipc down')),
  });
  await expect(service.createTerminal('tm-lost')).rejects.toBe(refusal);
});

test.each([
  ['host-ownership-pending: listing delayed'],
  ['LIFECYCLE_BUSY: updating'],
  ['spawn failed: no such shell'],
])('only a host-session-contended refusal asks for an offered session: %s', async message => {
  const store = makeStore();
  store.dispatch(addTabTree({ tabId: 'tb-other', tree: leaf('tm-other') }));
  const take = jest.fn().mockResolvedValue({ status: 'taken', processId: 'pc-offered' });
  const { service } = makeService(store, jest.fn().mockRejectedValue(new Error(message)), { takeSessionHandoff: take });
  const outcome = service.createTerminal('tm-other').catch(error => error);
  await jest.advanceTimersByTimeAsync(2_000);
  expect(take).not.toHaveBeenCalled();
  expect(service.getProcessId('tm-other')).toBeUndefined();
  store.dispatch(removeTabTree('tb-other')); // ends a retry loop, if one is running
  await jest.advanceTimersByTimeAsync(10_000);
  await outcome;
  expect(take).not.toHaveBeenCalled();
});

test('a pane that leaves while it takes an offered session binds nothing and passes the offer on', async () => {
  const store = makeStore();
  store.dispatch(addTabTree({ tabId: 'tb-moving', tree: leaf('tm-moving') }));
  let answer!: (take: { status: 'taken'; processId: string }) => void;
  const take = jest.fn(() => new Promise<{ status: 'taken'; processId: string }>(resolve => { answer = resolve; }));
  const offer = jest.fn().mockResolvedValue(true);
  const { service } = makeService(store, jest.fn().mockRejectedValue(contended('tm-moving')), {
    takeSessionHandoff: take, offerSessionHandoff: offer,
  });
  const promise = service.createTerminal('tm-moving');
  await flush();
  expect(take).toHaveBeenCalledTimes(1);
  store.dispatch(removeTabTree('tb-moving'));
  answer({ status: 'taken', processId: 'pc-old-host' });
  expect(await promise).toBe('');
  expect(service.getProcessId('tm-moving')).toBeUndefined();
  expect(offer).toHaveBeenCalledWith('tm-moving', 'pc-old-host'); // the taken offer is spent, so it is offered again
});

describe('a pane that leaves this window while its create is in flight', () => {
  function parkedCreate() {
    const store = makeStore();
    store.dispatch(addTabTree({ tabId: 'tb-w', tree: leaf('tm-w') }));
    let land!: (processId: string) => void;
    const create = jest.fn(() => new Promise<string>(resolve => { land = resolve; }));
    const closeTerminal = jest.fn().mockResolvedValue(undefined);
    const offerSessionHandoff = jest.fn().mockResolvedValue(true);
    const made = makeService(store, create, { closeTerminal, offerSessionHandoff });
    return { store, ...made, closeTerminal, offerSessionHandoff, land: (pid: string) => land(pid) };
  }

  test('closed: the shell the create produced is closed, not offered', async () => {
    const { store, service, closeTerminal, offerSessionHandoff, land } = parkedCreate();
    const promise = service.createTerminal('tm-w');
    await flush();
    store.dispatch(removeTabTree('tb-w'));
    await service.closeTerminal('tm-w');
    land('pc-new');
    expect(await promise).toBe('');
    expect(closeTerminal.mock.calls).toEqual([['pc-new']]);
    expect(offerSessionHandoff).not.toHaveBeenCalled();
    expect(service.getProcessId('tm-w')).toBeUndefined();
  });

  test('moved: the shell is offered to the window that has the pane, not closed', async () => {
    const { store, service, closeTerminal, offerSessionHandoff, land } = parkedCreate();
    const promise = service.createTerminal('tm-w');
    await flush();
    store.dispatch(removeTabTree('tb-w'));
    service.detachTerminal('tm-w');
    land('pc-new');
    expect(await promise).toBe('');
    expect(offerSessionHandoff.mock.calls).toEqual([['tm-w', 'pc-new']]);
    expect(closeTerminal).not.toHaveBeenCalled();
    expect(service.getProcessId('tm-w')).toBeUndefined();
  });

  test('a close during one create does not turn a later move into a close', async () => {
    const { store, service, closeTerminal, offerSessionHandoff, land } = parkedCreate();
    const first = service.createTerminal('tm-w');
    await flush();
    store.dispatch(removeTabTree('tb-w'));
    await service.closeTerminal('tm-w');
    land('pc-first');
    expect(await first).toBe('');
    store.dispatch(addTabTree({ tabId: 'tb-w2', tree: leaf('tm-w') }));
    const second = service.createTerminal('tm-w');
    await flush();
    store.dispatch(removeTabTree('tb-w2'));
    service.detachTerminal('tm-w');
    land('pc-second');
    expect(await second).toBe('');
    expect(closeTerminal.mock.calls).toEqual([['pc-first']]);
    expect(offerSessionHandoff.mock.calls).toEqual([['tm-w', 'pc-second']]);
  });
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

test('legacy no-process close has no label-keyed holder side channel', async () => {
  const { service, api } = makeService(makeStore());
  await service.closeTerminal('tm-never-bound');
  expect(api.forgetRestoringLeaf).not.toHaveBeenCalled();
  expect(api.closeTerminal).not.toHaveBeenCalled();
});

test('legacy no-process close clears wait state without invoking a holder side channel', async () => {
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
