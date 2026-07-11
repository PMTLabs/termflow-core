/**
 * engine.hydrate-resize.test.ts
 *
 * Task 4 — Layer 1B: size-aware hydrate cancel (root-cause fix B).
 *
 * The bug: hydrate() read xterm size (80x24), awaited bridge.resize +
 * getSnapshot, then unconditionally cancelPendingBackendResize() — discarding
 * a corrected resize (e.g. 140 cols after font load) that the onResize handler
 * scheduled DURING the await.
 *
 * Fix: replace the blind cancel with reconcilePendingBackendResize():
 *   A) a DIFFERENT-size resize scheduled during the bridge.resize await is
 *      FLUSHED immediately (not dropped and not waiting for debounce)
 *   B) a redundant SAME-size pending resize is dropped (no duplicate ConPTY repaint)
 *   C) a refit during getSnapshot that changes term size triggers a follow-up resize
 *      via the second-await-window check after commit
 */

import { TerminalEngine } from '../TerminalEngine';
import { terminalCache } from '../cache';
import type { TerminalBridge, Disposable } from '../types';
import { Terminal as MockTerminal } from '../__mocks__/xterm';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContainer(width = 800, height = 600): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'offsetWidth', { value: width, configurable: true });
  Object.defineProperty(el, 'offsetHeight', { value: height, configurable: true });
  document.body.appendChild(el);
  return el;
}

interface FakeBridgeOptions {
  resize?: (processId: string, cols: number, rows: number) => void | Promise<void>;
  getSnapshot?: (processId: string, cols: number, rows: number) => Promise<{ snapshot: string; cols: number; rows: number }>;
}

function makeFakeBridge(opts: FakeBridgeOptions = {}): TerminalBridge {
  const noopDisposable: Disposable = { dispose() {} };
  return {
    onData: () => noopDisposable,
    onExit: () => noopDisposable,
    write: () => {},
    resize: opts.resize ?? (() => {}),
    getSnapshot: opts.getSnapshot,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  terminalCache.clear();
  if (typeof (global as any).ResizeObserver === 'undefined') {
    (global as any).ResizeObserver = class {
      observe() {}
      disconnect() {}
      unobserve() {}
    };
  }
});

afterEach(() => {
  terminalCache.clear();
  document.body.innerHTML = '';
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// Test A: a DIFFERENT-size resize scheduled during the bridge.resize await
// (the FIRST await window) is FLUSHED immediately by reconcilePendingBackendResize.
//
// Setup: the bridge.resize is deferred so we can emit an xterm resize WHILE
// hydrate is awaiting it. When bridge.resize resolves, reconcile sees pending
// {140,24} ≠ {80,24} → flushBackendResize() → bridge gets [140,24].
// ---------------------------------------------------------------------------

test('hydrate flushes a DIFFERENT-size resize scheduled during the bridge.resize await', async () => {
  jest.useFakeTimers();

  const resizeCalls: Array<[number, number]> = [];

  // Deferred bridge resize so we can inject an xterm resize while hydrate awaits it.
  let resolveBridgeResize!: () => void;
  const bridgeResizePromise = new Promise<void>((res) => { resolveBridgeResize = res; });

  const bridge = makeFakeBridge({
    resize: (_pid, c, r) => {
      resizeCalls.push([c, r]);
      return bridgeResizePromise;
    },
    getSnapshot: async (_pid, _c, _r) => ({ snapshot: '', cols: 80, rows: 24 }),
  });

  const cacheKey = 'hr-test-a';
  const engine = new TerminalEngine(bridge, { cacheKey });
  engine.mount(makeContainer());

  const entry = terminalCache.get(cacheKey)!;
  const mockTerm = entry.terminal as unknown as MockTerminal;
  expect(mockTerm.cols).toBe(80);

  engine.attach('pid-1');

  // hydrate is now awaiting bridgeResizePromise (bridge.resize was called for 80x24).
  // Simulate a font-load refit: xterm grows to 140 cols → scheduleBackendResize(140,24).
  mockTerm.resize(140, 24);
  mockTerm.emitResize(140, 24);

  // Resolve bridge.resize: hydrate continues → reconcilePendingBackendResize(80,24)
  // sees pending={140,24} ≠ {80,24} → flushBackendResize() → bridge.resize(140,24).
  resolveBridgeResize();

  // Drain all timers and microtasks so flushBackendResize and getSnapshot settle.
  await jest.runAllTimersAsync();

  // The corrected size 140x24 MUST have reached the bridge.
  expect(resizeCalls).toContainEqual([140, 24]);
});

// ---------------------------------------------------------------------------
// Test B: a redundant SAME-size resize scheduled during the bridge.resize await
// is DROPPED — no duplicate ConPTY repaint.
//
// Setup: xterm emitResize at the same 80x24 size while hydrate awaits bridge.resize.
// reconcilePendingBackendResize(80,24) sees pending={80,24} = same → cancel.
// Bridge should only receive one resize at 80x24.
// ---------------------------------------------------------------------------

test('hydrate drops a redundant SAME-size resize scheduled during the bridge.resize await', async () => {
  jest.useFakeTimers();

  const resizeCalls: Array<[number, number]> = [];

  let resolveBridgeResize!: () => void;
  const bridgeResizePromise = new Promise<void>((res) => { resolveBridgeResize = res; });

  const bridge = makeFakeBridge({
    resize: (_pid, c, r) => {
      resizeCalls.push([c, r]);
      return bridgeResizePromise;
    },
    getSnapshot: async (_pid, _c, _r) => ({ snapshot: '', cols: 80, rows: 24 }),
  });

  const cacheKey = 'hr-test-b';
  const engine = new TerminalEngine(bridge, { cacheKey });
  engine.mount(makeContainer());

  const entry = terminalCache.get(cacheKey)!;
  const mockTerm = entry.terminal as unknown as MockTerminal;
  const initialCols = mockTerm.cols; // 80
  const initialRows = mockTerm.rows; // 24

  engine.attach('pid-1');

  // Simulate a SAME-size xterm resize event → redundant scheduleBackendResize(80,24).
  mockTerm.emitResize(initialCols, initialRows);

  resolveBridgeResize();
  await jest.runAllTimersAsync();

  // After reconcile drops the same-size pending, the second-await-window check runs:
  // term.cols=80 == lastSentSize.cols=80 → no extra scheduleBackendResize.
  // Exactly ONE resize at 80x24 (the pre-hydration one).
  const sameResizes = resizeCalls.filter(([c, r]) => c === initialCols && r === initialRows);
  expect(sameResizes.length).toBe(1);
});

// ---------------------------------------------------------------------------
// Test C: second-await window — a refit during getSnapshot that changes term.cols
// AFTER reconcile already ran must still reach the bridge via the post-commit
// second-await-window check.
//
// Setup: bridge.resize is sync (immediate). After the pre-resize settles,
// reconcilePendingBackendResize runs with no pending (no xterm resize yet).
// Then getSnapshot is awaited; DURING that await, emitResize(140) fires, setting
// pendingResize={140,24}. When getSnapshot resolves and the commit runs, the
// second-await-window check sees term.cols=140 != lastSentSize.cols=80 →
// scheduleBackendResize(140,24) is called (or the existing pending is flushed
// by the debounce timer).
// ---------------------------------------------------------------------------

test('hydrate schedules a follow-up resize when term size changes during getSnapshot await', async () => {
  jest.useFakeTimers();

  const resizeCalls: Array<[number, number]> = [];

  let resolveSnap!: (v: { snapshot: string; cols: number; rows: number }) => void;
  const snapPromise = new Promise<{ snapshot: string; cols: number; rows: number }>((res) => {
    resolveSnap = res;
  });

  const bridge = makeFakeBridge({
    resize: (_pid, c, r) => {
      resizeCalls.push([c, r]);
      // Sync (no deferred promise) — pre-resize settles immediately.
    },
    getSnapshot: (_pid, _c, _r) => snapPromise,
  });

  const cacheKey = 'hr-test-c';
  const engine = new TerminalEngine(bridge, { cacheKey });
  engine.mount(makeContainer());

  const entry = terminalCache.get(cacheKey)!;
  const mockTerm = entry.terminal as unknown as MockTerminal;

  engine.attach('pid-1');

  // Let the sync bridge.resize and reconcile settle (one microtask tick).
  // hydrate is now awaiting snapPromise.
  await Promise.resolve();
  await Promise.resolve();

  // Simulate xterm resize to 140 cols DURING getSnapshot await.
  // This schedules a debounced backend resize via scheduleBackendResize(140,24).
  mockTerm.resize(140, 24);
  mockTerm.emitResize(140, 24);

  // Resolve the snapshot. After commit the second-await-window check fires:
  // term.cols=140 != lastSentSize.cols=80 → scheduleBackendResize(140,24) is called.
  // (It cancels the existing debounce timer and re-arms one, so the net result is
  // one debounced resize at 140x24.)
  resolveSnap({ snapshot: '', cols: 80, rows: 24 });

  // Drain all timers so the 120ms debounce fires and bridge.resize(140,24) is called.
  await jest.runAllTimersAsync();

  // At least one resize call at 140 cols must reach the bridge.
  expect(resizeCalls.some(([c]) => c === 140)).toBe(true);
});

// ---------------------------------------------------------------------------
// Test D: second-await-window DOUBLE-SEND guard.
//
// The race: reconcilePendingBackendResize takes the FLUSH branch (different size
// 140) → flushBackendResize() sends 140 and stamps lastSentSize in a .then()
// that resolves AFTER hydrate's synchronous commit. The second-await-window
// check then sees term.cols(140) !== lastSentSize(still 80) → schedules a
// SECOND 140 resize.
//
// Fix: guard the second-await-window check with
//   !this.resizeInFlight && !this.pendingResize
// so it is skipped when a resize is already on the wire or queued.
//
// Without the guard, bridge receives 140 twice. With it, exactly once.
// ---------------------------------------------------------------------------

test('hydrate does NOT double-send a resize when resizeInFlight covers the second-await-window', async () => {
  jest.useFakeTimers();

  const resizeCalls: Array<[number, number]> = [];

  // Two separate deferred promises so we can independently control when the
  // pre-hydration resize and the corrected-140-resize settle.
  let resolvePreResize!: () => void;
  const preResizePromise = new Promise<void>((res) => { resolvePreResize = res; });

  // The 140-resize stays UNRESOLVED through the whole test — it never stamps
  // lastSentSize — simulating the race where the second-await-window check fires
  // before the flush's .then() has run.
  let resolve140Resize!: () => void;
  const resize140Promise = new Promise<void>((res) => { resolve140Resize = res; });

  let callIndex = 0;
  const bridge = makeFakeBridge({
    resize: (_pid, c, r) => {
      resizeCalls.push([c, r]);
      // First call: pre-hydration (80x24) — deferred by preResizePromise.
      // Second call: corrected flush (140x24) — deferred by resize140Promise
      //   (stays unresolved, so .then(stamp lastSentSize) never runs during the test).
      const idx = callIndex++;
      return idx === 0 ? preResizePromise : resize140Promise;
    },
    // getSnapshot resolves synchronously (empty snapshot path) so hydrate's
    // commit block and second-await-window check run while resize140Promise is
    // still pending — i.e. while resizeInFlight=true for the 140 flush.
    getSnapshot: (_pid, _c, _r) => Promise.resolve({ snapshot: '', cols: 80, rows: 24 }),
  });

  const cacheKey = 'hr-test-d';
  const engine = new TerminalEngine(bridge, { cacheKey });
  engine.mount(makeContainer());

  const entry = terminalCache.get(cacheKey)!;
  const mockTerm = entry.terminal as unknown as MockTerminal;
  expect(mockTerm.cols).toBe(80);

  engine.attach('pid-1');

  // hydrate is now awaiting the pre-hydration bridge.resize (80x24).
  // Simulate a font-load refit DURING that await: xterm grows to 140.
  // → scheduleBackendResize(140,24) arms a 120ms debounce timer.
  mockTerm.resize(140, 24);
  mockTerm.emitResize(140, 24);

  // Resolve the pre-hydration resize: reconcilePendingBackendResize(80,24) sees
  // pending={140,24} ≠ {80,24} → flushBackendResize() → bridge.resize(140,24)
  // (resizeCalls gets [140,24]), resizeInFlight=true, resize140Promise is pending
  // so .then(stamp lastSentSize) has NOT run. lastSentSize is still {80,24}.
  resolvePreResize();

  // Drain microtasks & timers so the second-await-window check runs.
  // At this point resizeInFlight=true (resize140Promise unresolved).
  // Without the guard the check fires: lastSentSize={80,24} ≠ term.cols=140
  // → scheduleBackendResize(140,24) again → bridge gets 140 a second time.
  // With the guard: resizeInFlight=true → check is skipped → only one 140.
  await jest.runAllTimersAsync();

  // Allow the 140 promise to settle (cleanup).
  resolve140Resize();
  await jest.runAllTimersAsync();

  // Exactly ONE resize at 140x24 must have reached the bridge.
  const calls140 = resizeCalls.filter(([c]) => c === 140);
  expect(calls140.length).toBe(1);
});
