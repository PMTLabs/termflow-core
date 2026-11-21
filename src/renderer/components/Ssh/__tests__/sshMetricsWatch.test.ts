/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { configureStore } from '@reduxjs/toolkit';
import reducer, {
  selectSshMetricsPause, selectSshMetricsSample, selectSshMetricsUnavailable, sshOwnersChanged, sshSessionObserved,
} from '../../../store/slices/sshSessionSlice';
import { installSshMetricsWatch, refenceSshMetricsOnSystemResume, resumeSshMetrics, retainSshMetrics, useSshMetricsWatch } from '../../../services/sshMetricsWatch';
import type { SshMetricsAPI, SshMetricsControl, SshMetricsSample, SshSessionView, SshState } from '../../../types/ssh';

const A = 'tm-a', B = 'tm-b', pg = 17;
const TIMEOUT = "Metrics paused: host didn't answer in 5 s";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
let wall: number, mono: number;
let dispose: (() => void) | undefined;
const elapse = (ms: number) => { wall += ms; mono += ms; };
async function advance(ms: number) {
  while (ms > 0) {
    const step = Math.min(ms, 250);
    elapse(step);
    jest.advanceTimersByTime(step);
    await flush();
    ms -= step;
  }
}
beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['performance'] });
  wall = 100_000; mono = 0;
  jest.spyOn(Date, 'now').mockImplementation(() => wall);
  jest.spyOn(performance, 'now').mockImplementation(() => mono);
  jest.spyOn(document, 'hidden', 'get').mockReturnValue(false);
});
afterEach(async () => { dispose?.(); dispose = undefined; await flush(); jest.restoreAllMocks(); jest.useRealTimers(); });

const unavailable = { available: false, reason: 'unsupported' } as const;
function reading(sampledAt: number, percent: number | null, terminalId = A): SshMetricsSample {
  return { terminalId, sampledAt, metrics: {
    host: unavailable, cpu: { available: true, percent, cores: unavailable, load1: unavailable },
    ram: unavailable, netUp: { available: true, bytesPerSecond: percent === null ? null : 320 },
    netDown: { available: true, bytesPerSecond: percent === null ? null : 640 }, uptime: unavailable,
    users: unavailable, partitions: unavailable, nfs: unavailable,
  } };
}
function setup(override?: SshMetricsAPI, eventsReady = Promise.resolve()) {
  let deliveredSample: (s: SshMetricsSample) => void = () => {};
  let deliveredControl: (s: SshMetricsControl) => void = () => {};
  let stopPage: () => void = () => {};
  let generation = 1, revision = 0, pauseSeq = 0, pausedReason: string | null = null;
  const watch = jest.fn((_id: string, _uuid: string, _pg?: number): ReturnType<SshMetricsAPI['sshMetricsWatch']> =>
    Promise.resolve({ sampleFloor: wall, generation, pauseSeq, pausedReason }));
  const unwatch = jest.fn(async (_id: string, _uuid: string, _pg?: number) => {});
  const resume = jest.fn(async (_id: string, _uuid: string, _pg?: number) => { pausedReason = null; return { sampleFloor: wall, generation, pauseSeq: ++pauseSeq }; });
  const api: SshMetricsAPI = override ?? {
    sshMetricsWatch: watch, sshMetricsResume: resume, sshMetricsUnwatch: unwatch,
    onSshMetricsSample: async cb => { deliveredSample = cb; await eventsReady; return () => {}; },
    onSshMetricsControl: async cb => { deliveredControl = cb; return () => {}; },
  };
  const page = { ended: false, pageIdentity: async () => override ? undefined : { wi: 2, pg }, subscribe: (cb: () => void) => { stopPage = cb; return () => {}; } };
  const store = configureStore({ reducer: { sshSession: reducer } });
  store.dispatch(sshOwnersChanged({ [A]: 'c-a', [B]: 'c-b' }));
  const session = (state: SshState, gen = generation) => {
    generation = gen;
    store.dispatch(sshSessionObserved({ terminalId: A, connectionId: 'c-a', state, generation, revision: ++revision, gate: 'verified' }));
  };
  session('connected');
  dispose = installSshMetricsWatch(store, api, page);
  const state = () => store.getState().sshSession;
  return { watch, unwatch, resume, session, page, live: () => selectSshMetricsSample(state(), A), state,
    emit: (percent: number | null, stamp = wall, id = A) => deliveredSample(reading(stamp, percent, id)),
    pause: () => selectSshMetricsPause(state(), A),
    control: (seq: number, reason: string | null, gen = generation) => deliveredControl({ terminalId: A, generation: gen, pauseSeq: seq, pausedReason: reason }),
    nativePause: () => { pauseSeq++; pausedReason = TIMEOUT; deliveredControl({ terminalId: A, generation, pauseSeq, pausedReason }); },
    retirePage: () => { page.ended = true; stopPage(); },
  };
}

// Mutation: sshMetricsWatch.ts invokeFence readiness/receipt gate (and slice's !fence check).
test('sample_before_watch_reply_is_dropped', async () => {
  const subscribed = deferred<void>();
  const h = setup(undefined, subscribed.promise);
  const late = deferred<Awaited<ReturnType<SshMetricsAPI['sshMetricsWatch']>>>();
  const floor = wall;
  h.watch.mockReturnValueOnce(late.promise);
  retainSshMetrics(A); await flush();
  expect(h.watch).not.toHaveBeenCalled();
  subscribed.resolve(); await flush();
  expect(h.watch).toHaveBeenCalledTimes(1);
  elapse(10); h.emit(97);
  expect(h.live()).toBeUndefined();
  late.resolve({ sampleFloor: floor, generation: 1, pauseSeq: 0, pausedReason: null }); await flush();
  expect(h.live()).toBeUndefined(); // no replay
  elapse(1); h.emit(32);
  expect(h.live()).toEqual(reading(wall, 32));
});

// Mutation: slice sshMetricsSampled <= floor; coordinator sample fence-expiry check.
test('delayed_old_sample_after_reconnect_and_watch_reply_is_rejected', async () => {
  const h = setup(); retainSshMetrics(A); await flush();
  elapse(10); const old = wall; h.emit(90); expect(h.live()).toBeDefined();
  h.session('disconnected'); elapse(50); h.session('connected', 2); await flush();
  expect(h.watch.mock.calls[1]).toEqual(h.watch.mock.calls[0]);
  h.emit(99, old); expect(h.live()).toBeUndefined();
  const aboveFloor = wall + 1;
  elapse(30_000); h.emit(98, aboveFloor); expect(h.live()).toBeUndefined(); await flush();
  elapse(1); h.emit(4); expect(h.live()).toEqual(reading(wall, 4));
});

// Mutation: coordinator sample terminal routing, or slice <= metricsLastStamp.
test('sample_for_other_terminal_and_out_of_order_sample_do_not_replace', async () => {
  const h = setup(); retainSshMetrics(A); await flush();
  elapse(5); h.emit(5); const current = reading(wall, 5);
  elapse(1); h.emit(99, wall, B); h.emit(98, wall, 'tm-unknown'); h.emit(97, wall - 1); h.emit(96, wall - 2);
  expect(h.live()).toEqual(current);
  expect(h.state().byTerminal[B].metricsReading).toBeUndefined();
  h.emit(9); expect(h.live()).toEqual(reading(wall, 9));
});

// Mutation: slice sshSessionObserved non-connected disarm, or selector's connected gate.
test('disconnect_clears_immediately_even_if_cache_is_populated', async () => {
  const h = setup(); retainSshMetrics(A); await flush();
  const states: SshState[] = ['disconnected', 'error', 'connecting', 'needs-secret', 'needs-hostkey'];
  for (const [index, state] of states.entries()) {
    h.session('connected', index + 1); await flush(); elapse(1); h.emit(42);
    expect(h.live()).toEqual(reading(wall, 42));
    const populated = h.state().byTerminal[A];
    const before = populated.session as SshSessionView;
    const reduced = reducer(h.state(), sshSessionObserved({ ...before, revision: (before.revision ?? 0) + 1, state }));
    expect(reduced.byTerminal[A].metricsReading).toBeUndefined();
    expect(reduced.byTerminal[A].metricsFence).toBeUndefined();
    h.session(state);
    expect(h.state().byTerminal[A].metricsReading).toBeUndefined();
    expect(h.state().byTerminal[A].metricsFence).toBeUndefined();
    const poisoned = { byTerminal: { [A]: { ...populated, session: { ...populated.session as SshSessionView, state } } } };
    expect(selectSshMetricsSample(poisoned, A)).toBeUndefined();
  }
});

// Mutation: slice selector deadline or coordinator Resume invalidation/floor replacement.
test('stale_after_five_seconds_and_resume_cannot_render_old_values', async () => {
  const h = setup(); retainSshMetrics(A); await flush();
  await advance(1); const sample = wall; h.emit(92);
  await advance(4998); expect(h.live()).toEqual(reading(sample, 92));
  await advance(2); expect(h.live()).toBeUndefined();
  const resumeReply = deferred<{ sampleFloor: number; generation: number; pauseSeq: number }>();
  h.resume.mockReturnValueOnce(resumeReply.promise);
  elapse(1); h.emit(15); expect(h.live()).toBeDefined();
  const resumed = resumeSshMetrics(A); await flush();
  h.emit(99); expect(h.live()).toBeUndefined();
  resumeReply.resolve({ sampleFloor: wall, generation: 1, pauseSeq: 1 }); expect(await resumed).toBe(true);
  h.emit(92, sample); expect(h.live()).toBeUndefined();
  const queued = wall + 1; elapse(30_000); h.emit(98, queued); expect(h.live()).toBeUndefined(); await flush();
  elapse(1); h.emit(13); expect(h.live()).toEqual(reading(wall, 13));
});

// Mutation: retire must compensate the original UUID/pg after pending watch; ended must dispose.
// Native complement: commands::ssh_metrics::invoke_tests::retired_page_cannot_watch_or_keep_worker.
test('strictmode_and_late_watch_reply_do_not_leak_consumers', async () => {
  const h = setup();
  const old = deferred<Awaited<ReturnType<SshMetricsAPI['sshMetricsWatch']>>>();
  h.watch.mockReturnValueOnce(old.promise);
  const previousActEnvironment = (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement('div'));
  function BarInterest() { useSshMetricsWatch(A); return null; }
  try {
    await act(async () => { root.render(React.createElement(React.StrictMode, null, React.createElement(BarInterest))); });
    await flush();
    expect(h.watch).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => { root.unmount(); });
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
  const second = retainSshMetrics(A); const overlapping = retainSshMetrics(A); await flush();
  expect(h.watch.mock.calls).toHaveLength(2);
  const [abandoned, replacement] = h.watch.mock.calls;
  const v4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  expect(abandoned).toEqual([A, expect.stringMatching(v4), pg]);
  expect(replacement).toEqual([A, expect.stringMatching(v4), pg]);
  expect(abandoned[1]).not.toBe(replacement[1]);
  old.resolve({ sampleFloor: wall + 200, pauseSeq: 100, generation: 1, pausedReason: TIMEOUT }); await flush();
  expect(h.unwatch.mock.calls).toEqual([abandoned]);
  expect(h.pause()).toBeNull(); elapse(1); h.emit(7); expect(h.live()).toBeDefined();
  second(); expect(h.unwatch.mock.calls).toEqual([abandoned]);
  h.retirePage(); // overlapping bar never unmounted
  h.emit(99); await flush();
  expect(h.live()).toBeUndefined(); expect(h.unwatch.mock.calls).toEqual([abandoned, replacement]);
  overlapping(); await flush(); expect(h.unwatch.mock.calls).toEqual([abandoned, replacement]);
});

// Mutation: collection-age deadline based on receipt, missing monotonic fence, or missing clock/resume invalidation.
test('same_generation_above_floor_delayed_sample_and_burst_never_revive', async () => {
  const h = setup(); retainSshMetrics(A); await flush();
  await advance(1); const old = wall;
  await advance(4900); h.emit(21, old); expect(h.live()).toEqual(reading(old, 21));
  // Even before the timer runs, the action-time selector must refuse Copy.
  elapse(100); expect(h.live()).toBeUndefined();
  const late = deferred<Awaited<ReturnType<SshMetricsAPI['sshMetricsWatch']>>>();
  h.watch.mockReturnValueOnce(late.promise);
  elapse(30_000); for (let i = 0; i < 3; i++) { h.emit(99, old + i); expect(h.live()).toBeUndefined(); }
  await flush(); expect(h.watch).toHaveBeenCalledTimes(2);
  const newFloor = wall;
  late.resolve({ sampleFloor: newFloor, generation: 1, pauseSeq: 0, pausedReason: null }); await flush();
  elapse(1); h.emit(22); expect(h.live()).toEqual(reading(wall, 22));
  wall -= 60_000; // the native monotonic stamp allocator can stay ahead of Date.now()
  h.watch.mockResolvedValueOnce({ sampleFloor: newFloor + 2, generation: 1, pauseSeq: 0, pausedReason: null });
  h.emit(99, newFloor + 1); expect(h.live()).toBeUndefined(); await flush();
  h.emit(23, newFloor + 3); expect(h.live()).toEqual(reading(newFloor + 3, 23));
  wall += 90_000;
  expect(h.live()).toBeUndefined(); h.emit(98, newFloor + 4); await flush();
  elapse(1); h.emit(24); expect(h.live()).toEqual(reading(wall, 24));
  refenceSshMetricsOnSystemResume(); h.emit(100); expect(h.live()).toBeUndefined(); await flush();
  elapse(1); h.emit(25); expect(h.live()).toEqual(reading(wall, 25));
  h.retirePage(); h.emit(101); expect(h.live()).toBeUndefined();
});

// Mutation: reverse compareMetricsControl in the bridge subscriber or receipt reconciliation;
// drop Resume's new floor. Native timeout/no-telemetry/rate complements: sampler/tests/scheduler.rs.
test.each([false, true])('r2_2_ordered_pause_resume_and_rates_with_pending_renewal_%s', async renewal => {
  const h = setup(); const release = retainSshMetrics(A); await flush();
  elapse(1); h.emit(30); expect(h.live()).toBeDefined();
  const late = deferred<Awaited<ReturnType<SshMetricsAPI['sshMetricsWatch']>>>();
  if (renewal) { h.watch.mockReturnValueOnce(late.promise); refenceSshMetricsOnSystemResume(); await flush(); }
  h.nativePause(); expect(h.pause()).toBe(TIMEOUT); expect(h.live()).toBeUndefined();
  if (renewal) late.resolve({ sampleFloor: wall, generation: 1, pauseSeq: 0, pausedReason: null });
  await flush();
  release(); retainSshMetrics(A); await flush(); // remount obtains durable pause from the receipt
  expect(h.pause()).toBe(TIMEOUT);
  const retiredStamp = wall; elapse(1);
  expect(await resumeSshMetrics(A)).toBe(true);
  h.control(1, TIMEOUT); h.control(99, TIMEOUT, 0); h.emit(99, retiredStamp);
  expect(h.pause()).toBeNull(); expect(h.live()).toBeUndefined();
  elapse(1); h.emit(null); expect(h.live()).toEqual(reading(wall, null));
  elapse(1); h.emit(25); expect(h.live()).toEqual(reading(wall, 25));
});

// Mutation: a delayed lower-pair watch receipt arms an obsolete floor or re-pauses after a Resume elsewhere.
test.each([false, true])('r2_2_consumers_converge_with_receipt_first_%s', async receiptFirst => {
  const h = setup();
  const old = deferred<Awaited<ReturnType<SshMetricsAPI['sshMetricsWatch']>>>();
  const stamp = wall;
  h.watch.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ sampleFloor: stamp + 1, generation: 1, pauseSeq: 2, pausedReason: null });
  retainSshMetrics(A); await flush();
  const releaseOldReceipt = () => old.resolve({ sampleFloor: stamp, generation: 1, pauseSeq: 1, pausedReason: TIMEOUT });
  if (receiptFirst) { releaseOldReceipt(); await flush(); expect(h.pause()).toBe(TIMEOUT); }
  h.control(2, null);
  if (!receiptFirst) releaseOldReceipt();
  await flush();
  elapse(2); h.control(1, TIMEOUT); h.emit(91, stamp + 1);
  expect(h.pause()).toBeNull(); expect(h.live()).toBeUndefined();
  h.emit(25); expect(h.live()).toEqual(reading(wall, 25));
});

// Mutation: browser fake success or coordinator starts/cleans up an admitted desktop consumer.
test('browser_watch_rejection_is_caught_without_fake_success', async () => {
  const send = jest.fn();
  jest.spyOn(globalThis, 'WebSocket').mockImplementation(() => ({ send }) as unknown as WebSocket);
  const browser = (await import('../../../api/browser-bridge')).default;
  const watch = jest.spyOn(browser, 'sshMetricsWatch');
  const unwatch = jest.spyOn(browser, 'sshMetricsUnwatch');
  const resume = jest.spyOn(browser, 'sshMetricsResume');
  const timers = jest.getTimerCount();
  const h = setup(browser); const release = retainSshMetrics(A); await flush();
  expect(watch).toHaveBeenCalledTimes(1);
  expect(selectSshMetricsUnavailable(h.state(), A)).toBe('SSH host metrics are desktop-only');
  expect(h.state().byTerminal[A].metricsFence).toBeUndefined(); expect(h.live()).toBeUndefined();
  expect(await resumeSshMetrics(A)).toBe(false);
  release(); await flush();
  expect(resume).not.toHaveBeenCalled(); expect(unwatch).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(jest.getTimerCount()).toBe(timers);
});
