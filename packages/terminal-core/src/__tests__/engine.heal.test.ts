/**
 * engine.heal.test.ts
 *
 * Task 5 — Layer 2: idle UI-authoritative dimension watchdog.
 *
 * The watchdog reads the backend size via bridge.getSize and re-pushes xterm's
 * size through the existing 120ms scheduleBackendResize debounce ONLY on a real
 * getSize≠xterm mismatch. Guards: settle-gate, resizeInFlight, epoch re-validation.
 */

import { TerminalEngine } from '../TerminalEngine';
import { terminalCache } from '../cache';
import type { TerminalBridge, Disposable } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContainer(width = 800, height = 600): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'offsetWidth', { value: width, configurable: true });
  Object.defineProperty(el, 'offsetHeight', { value: height, configurable: true });
  // jsdom always returns null for offsetParent; stub it to document.body so the
  // "pane visible" guard (offsetParent !== null) passes.
  Object.defineProperty(el, 'offsetParent', { value: document.body, configurable: true });
  document.body.appendChild(el);
  return el;
}

interface FakeBridgeOptions {
  getSize?: (processId: string) => Promise<{ cols: number; rows: number }>;
}

function makeFakeBridge(opts: FakeBridgeOptions = {}): TerminalBridge {
  const noopDisposable: Disposable = { dispose() {} };
  return {
    onData: () => noopDisposable,
    onExit: () => noopDisposable,
    write: () => {},
    resize: () => {},
    getSize: opts.getSize,
  };
}

/**
 * Mount engine with xterm at 140x37, attach a pid, and return engine + entry.
 * The mock terminal starts at 80x24 then we resize to 140x37 to simulate a fit.
 */
function mountEngine(
  bridgeOpts: FakeBridgeOptions = {},
  cacheKey = `heal-test-${Math.random()}`,
): { engine: TerminalEngine; cacheKey: string } {
  const bridge = makeFakeBridge(bridgeOpts);
  const engine = new TerminalEngine(bridge, { cacheKey });
  engine.mount(makeContainer());

  // Resize the mock xterm to 140x37 so tests can detect a heal call with those dims.
  const entry = terminalCache.get(cacheKey)!;
  (entry.terminal as any).resize(140, 37);

  return { engine, cacheKey };
}

/** Patch the cache entry with overrides (e.g. lastDataAt). */
function setEntry(cacheKey: string, overrides: Record<string, unknown>): void {
  const entry = terminalCache.get(cacheKey)!;
  Object.assign(entry, overrides);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  terminalCache.clear();
  TerminalEngine.suppressHealUntil = 0;
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
  TerminalEngine.suppressHealUntil = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('heals when backend size differs from xterm (re-pushes xterm size)', async () => {
  const spy = jest.spyOn(TerminalEngine.prototype as any, 'scheduleBackendResize');

  const { engine, cacheKey } = mountEngine({
    getSize: async () => ({ cols: 133, rows: 37 }),
  });
  (engine as any).attachedProcessId = 'pid-1';
  setEntry(cacheKey, { lastDataAt: Date.now() - 1000 }); // settled

  await (engine as any).healOnce();

  expect(spy).toHaveBeenCalledWith(140, 37);
  spy.mockRestore();
});

test('no heal when sizes already match', async () => {
  const spy = jest.spyOn(TerminalEngine.prototype as any, 'scheduleBackendResize');

  const { engine, cacheKey } = mountEngine({
    getSize: async () => ({ cols: 140, rows: 37 }),
  });
  (engine as any).attachedProcessId = 'pid-1';
  setEntry(cacheKey, { lastDataAt: Date.now() - 1000 });

  await (engine as any).healOnce();

  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});

test('skips while output is hot (settle-gate)', async () => {
  const spy = jest.spyOn(TerminalEngine.prototype as any, 'scheduleBackendResize');

  const { engine, cacheKey } = mountEngine({
    getSize: async () => ({ cols: 133, rows: 37 }),
  });
  (engine as any).attachedProcessId = 'pid-1';
  setEntry(cacheKey, { lastDataAt: Date.now() }); // hot — just arrived

  await (engine as any).healOnce();

  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});

test('skips when a resize is in flight', async () => {
  const spy = jest.spyOn(TerminalEngine.prototype as any, 'scheduleBackendResize');

  const { engine, cacheKey } = mountEngine({
    getSize: async () => ({ cols: 133, rows: 37 }),
  });
  (engine as any).attachedProcessId = 'pid-1';
  (engine as any).resizeInFlight = true;
  setEntry(cacheKey, { lastDataAt: Date.now() - 1000 });

  await (engine as any).healOnce();

  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});

test('aborts if resizeEpoch advanced during the getSize await', async () => {
  const spy = jest.spyOn(TerminalEngine.prototype as any, 'scheduleBackendResize');

  const { engine, cacheKey } = mountEngine({
    getSize: async () => {
      // Simulate a resize happening while getSize is in flight.
      (engine as any).resizeEpoch++;
      return { cols: 133, rows: 37 };
    },
  });
  (engine as any).attachedProcessId = 'pid-1';
  setEntry(cacheKey, { lastDataAt: Date.now() - 1000 });

  await (engine as any).healOnce();

  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});

test('healOnce skips while suppressHealUntil is in the future', async () => {
  const spy = jest.spyOn(TerminalEngine.prototype as any, 'scheduleBackendResize');

  const { engine, cacheKey } = mountEngine({
    getSize: async () => ({ cols: 133, rows: 37 }),
  });
  (engine as any).attachedProcessId = 'pid-1';
  setEntry(cacheKey, { lastDataAt: Date.now() - 1000 }); // settled
  TerminalEngine.suppressHealUntil = Date.now() + 5000;

  await (engine as any).healOnce();

  expect(spy).not.toHaveBeenCalled();
  TerminalEngine.suppressHealUntil = 0;
  spy.mockRestore();
});

// ---------------------------------------------------------------------------
// Fix 1: self-contained watchdog teardown (remount-safe, no orphaned listeners)
// ---------------------------------------------------------------------------

test('double-start watchdog does not leave duplicate focus listeners (add balanced by remove)', () => {
  // This test fails without Fix 1.
  // Before Fix 1, startHealWatchdog pushed the kick listener into this.disposables.
  // mount() resets this.disposables = [] at its start, orphaning the old listeners.
  // A mount()→mount() sequence (pane moved to new container) therefore leaks the
  // first pair of listeners (never removed) and registers a second pair → duplicate
  // healOnce calls on every focus event.
  //
  // After Fix 1, startHealWatchdog calls stopHealWatchdog() first, which removes
  // the old listeners before registering new ones → add count equals remove count.

  const addSpy = jest.spyOn(window, 'addEventListener');
  const removeSpy = jest.spyOn(window, 'removeEventListener');

  const key = `heal-double-start-${Math.random()}`;
  const bridge = makeFakeBridge({
    getSize: async () => ({ cols: 140, rows: 37 }),
  });
  const engine = new TerminalEngine(bridge, { cacheKey: key });

  // First mount — registers listeners.
  engine.mount(makeContainer());

  // Second mount WITHOUT unmount (legitimate "pane moved" pattern).
  // With old code: this.disposables reset → first listeners orphaned → second
  // addEventListener call stacks on top of the first (remove count < add count).
  // With Fix 1: stopHealWatchdog() removes the first listeners before re-registering.
  engine.mount(makeContainer());

  // Count how many times 'focus' was added vs removed up to this point.
  const focusAdds = addSpy.mock.calls.filter((c) => c[0] === 'focus').length;
  const focusRemoves = removeSpy.mock.calls.filter((c) => c[0] === 'focus').length;

  // After two mounts, the first set of listeners should have been removed (by
  // stopHealWatchdog inside the second startHealWatchdog). Net outstanding = 1.
  expect(focusRemoves).toBe(focusAdds - 1);

  // Now unmount: the remaining listener is removed → balance reaches zero.
  engine.unmount();

  const focusRemovesAfter = removeSpy.mock.calls.filter((c) => c[0] === 'focus').length;
  expect(focusRemovesAfter).toBe(focusAdds);

  addSpy.mockRestore();
  removeSpy.mockRestore();
});
