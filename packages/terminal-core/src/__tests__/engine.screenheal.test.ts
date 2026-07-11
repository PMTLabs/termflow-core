/**
 * engine.screenheal.test.ts
 *
 * Task 6 — Layer 3: opt-in alt-screen state reconcile (default OFF).
 *
 * Tests that maybeHealScreenState():
 *   (a) is a complete no-op when healScreenState is false (default)
 *   (b) repaints the alt-screen when enabled + settled + input-quiet + dims-agree + changed
 *   (c) skips when the active buffer is the normal (main) buffer
 *   (d) skips while the user is mid-keystroke (input not quiet)
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
  Object.defineProperty(el, 'offsetParent', { value: document.body, configurable: true });
  document.body.appendChild(el);
  return el;
}

interface FakeBridgeOptions {
  getSnapshot?: (processId: string, cols: number, rows: number) => Promise<{ snapshot: string; cols: number; rows: number }>;
}

function makeFakeBridge(opts: FakeBridgeOptions = {}): TerminalBridge {
  const noopDisposable: Disposable = { dispose() {} };
  return {
    onData: () => noopDisposable,
    onExit: () => noopDisposable,
    write: () => {},
    resize: () => {},
    getSnapshot: opts.getSnapshot,
  };
}

/**
 * Mount engine with xterm at 140x37 and return { engine, term }.
 * `term` is the raw mock Terminal so tests can call __setBufferType and spy on reset/write.
 */
function mountEngine(
  engineOpts: Record<string, unknown>,
  bridge: TerminalBridge,
  cacheKey = `screenheal-test-${Math.random()}`,
): { engine: TerminalEngine; term: any } {
  const engine = new TerminalEngine(bridge, { cacheKey, ...engineOpts } as any);
  engine.mount(makeContainer());

  const entry = terminalCache.get(cacheKey)!;
  // Resize mock xterm to 140x37 so dim-agree checks pass when snapshot returns 140x37.
  (entry.terminal as any).resize(140, 37);

  return { engine, term: entry.terminal as any };
}

/** Patch the cache entry directly (cacheKey captured via closure over the engine's cacheKey). */
function makeSetEntry(engine: TerminalEngine) {
  return function setEntry(overrides: Record<string, unknown>): void {
    const key = (engine as any).cacheKey as string;
    const entry = terminalCache.get(key)!;
    Object.assign(entry, overrides);
  };
}

function makeGetEntry(engine: TerminalEngine) {
  return function getEntry() {
    const key = (engine as any).cacheKey as string;
    return terminalCache.get(key)!;
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
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('screen heal is a no-op when healScreenState is false (default)', async () => {
  const bridge = makeFakeBridge({
    getSnapshot: async () => ({ snapshot: 'X', cols: 140, rows: 37 }),
  });
  const { engine, term } = mountEngine({}, bridge);
  term.__setBufferType('alternate');
  const resetSpy = jest.fn();
  term.reset = resetSpy;

  (engine as any).attachedProcessId = 'pid-1';
  const getEntry = makeGetEntry(engine);
  const setEntry = makeSetEntry(engine);
  setEntry({ lastDataAt: Date.now() - 1000, lastInputAt: Date.now() - 1000, lastSnapshot: 'OLD' });

  await (engine as any).maybeHealScreenState('pid-1', getEntry());

  expect(resetSpy).not.toHaveBeenCalled();
});

test('screen heal repaints alt-screen only when enabled, settled, input-quiet, dims agree, changed', async () => {
  const bridge = makeFakeBridge({
    getSnapshot: async () => ({ snapshot: 'NEW', cols: 140, rows: 37 }),
  });
  const { engine, term } = mountEngine({ healScreenState: true }, bridge);
  term.__setBufferType('alternate');
  const resetSpy = jest.spyOn(term, 'reset');
  const writeSpy = jest.spyOn(term, 'write');

  (engine as any).attachedProcessId = 'pid-1';
  const getEntry = makeGetEntry(engine);
  const setEntry = makeSetEntry(engine);
  setEntry({ lastDataAt: Date.now() - 1000, lastInputAt: Date.now() - 1000, lastSnapshot: 'OLD' });

  await (engine as any).maybeHealScreenState('pid-1', getEntry());

  expect(resetSpy).toHaveBeenCalled();
  expect(writeSpy).toHaveBeenCalledWith('NEW');
});

test('screen heal skips on the normal (main) buffer', async () => {
  const bridge = makeFakeBridge({
    getSnapshot: async () => ({ snapshot: 'NEW', cols: 140, rows: 37 }),
  });
  const { engine, term } = mountEngine({ healScreenState: true }, bridge);
  term.__setBufferType('normal');
  const resetSpy = jest.spyOn(term, 'reset');

  (engine as any).attachedProcessId = 'pid-1';
  const getEntry = makeGetEntry(engine);
  const setEntry = makeSetEntry(engine);
  setEntry({ lastDataAt: Date.now() - 1000, lastInputAt: Date.now() - 1000, lastSnapshot: 'OLD' });

  await (engine as any).maybeHealScreenState('pid-1', getEntry());

  expect(resetSpy).not.toHaveBeenCalled();
});

test('screen heal skips while the user is mid-keystroke (input not quiet)', async () => {
  const bridge = makeFakeBridge({
    getSnapshot: async () => ({ snapshot: 'NEW', cols: 140, rows: 37 }),
  });
  const { engine, term } = mountEngine({ healScreenState: true }, bridge);
  term.__setBufferType('alternate');
  const resetSpy = jest.spyOn(term, 'reset');

  (engine as any).attachedProcessId = 'pid-1';
  const getEntry = makeGetEntry(engine);
  const setEntry = makeSetEntry(engine);
  // lastInputAt = now → user is mid-keystroke, not settled
  setEntry({ lastDataAt: Date.now() - 1000, lastInputAt: Date.now(), lastSnapshot: 'OLD' });

  await (engine as any).maybeHealScreenState('pid-1', getEntry());

  expect(resetSpy).not.toHaveBeenCalled();
});
