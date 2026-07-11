/**
 * engine.fonts.test.ts
 *
 * Tests for Layer 1A: font-ready first fit (root-cause fix A).
 *
 * The initial xterm fit() after open() uses whatever font metrics are
 * available — if the web font (MesloLGS NF) hasn't loaded yet, the
 * fallback font's wider cell width produces a wrong column count, and the
 * PTY is sized to that wrong count.
 *
 * Fix: after the synchronous provisional fit, schedule an AUTHORITATIVE
 * re-fit that waits for document.fonts.ready (+ the specific font face
 * load), or a hard timeout so a slow/missing font never blocks creation.
 *
 * These tests verify:
 *   1. The authoritative re-fit fires AFTER fonts.ready resolves.
 *   2. ensureFontReady() resolves on its own timeout when fonts.ready
 *      never settles.
 */

import { TerminalEngine } from '../TerminalEngine';
import { terminalCache } from '../cache';
import type { TerminalBridge, Disposable } from '../types';
import { FitAddon as MockFitAddon } from '../__mocks__/addon-fit';

// ---------------------------------------------------------------------------
// Helpers (mirror the pattern from lifecycle-timers.test.ts / engine.test.ts)
// ---------------------------------------------------------------------------

function makeFakeBridge(): TerminalBridge {
  const noopDisposable: Disposable = { dispose() {} };
  return {
    onData: () => noopDisposable,
    onExit: () => noopDisposable,
    write: () => {},
    resize: () => {},
  };
}

function makeContainer(width = 800, height = 600): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'offsetWidth', { value: width, configurable: true });
  Object.defineProperty(el, 'offsetHeight', { value: height, configurable: true });
  document.body.appendChild(el);
  return el;
}

/**
 * Mount a TerminalEngine and return the engine plus a jest.SpyOn spy that
 * wraps FitAddon.fit() — so tests can count calls without reaching into
 * internal cache state.
 *
 * Returns the fitAddon mock directly (from the cache entry) so callers can
 * read fitCount; and a jest.fn() spy that also counts calls via .mock.calls.
 */
function mountEngine(opts: {
  isWindows?: boolean;
  windowsBuildNumber?: number;
  cacheKey?: string;
}): { engine: TerminalEngine; fitSpy: jest.SpyInstance } {
  const cacheKey = opts.cacheKey ?? `fonts-test-${Math.random()}`;
  const engine = new TerminalEngine(makeFakeBridge(), {
    cacheKey,
    isWindows: opts.isWindows,
    windowsBuildNumber: opts.windowsBuildNumber,
  });
  engine.mount(makeContainer());

  // Reach the FitAddon mock stored in the cache entry and spy on its fit().
  const entry = terminalCache.get(cacheKey);
  if (!entry) throw new Error(`No cache entry for ${cacheKey}`);
  const fitAddon = entry.fitAddon as unknown as MockFitAddon;
  const fitSpy = jest.spyOn(fitAddon, 'fit');

  return { engine, fitSpy };
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
// Test 1: authoritative re-fit fires after document.fonts.ready resolves
// ---------------------------------------------------------------------------

test('initial measuring fit is deferred until document.fonts.ready resolves', async () => {
  let resolveFonts!: () => void;
  (document as any).fonts = {
    ready: new Promise<void>((r) => {
      resolveFonts = r;
    }),
    load: () => Promise.resolve([]),
  };

  const { fitSpy } = mountEngine({ isWindows: true, windowsBuildNumber: 26200 });

  // Synchronous provisional fit happened during mount() — record how many
  // fit() calls have been made so far (before fonts.ready resolves).
  const fitsBefore = fitSpy.mock.calls.length;

  // Resolve the font-ready promise, then flush the microtask queue.
  // The chain is: fonts.ready resolves → Promise.all resolves → .then() fires →
  // Promise.race resolves → ensureFontReady().then(cb) fires → fit.fit() called.
  // That's ~4 microtask hops; flush generously.
  resolveFonts();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  // The authoritative re-fit must have fired AFTER fonts.ready resolved.
  expect(fitSpy.mock.calls.length).toBeGreaterThan(fitsBefore);
});

// ---------------------------------------------------------------------------
// Test 2: ensureFontReady() resolves via timeout when fonts.ready never settles
// ---------------------------------------------------------------------------

test('ensureFontReady resolves on timeout when fonts.ready never settles', async () => {
  jest.useFakeTimers();

  (document as any).fonts = {
    ready: new Promise<void>(() => {
      /* never resolves */
    }),
    load: () => Promise.resolve([]),
  };

  const { engine } = mountEngine({});

  // Call the private method directly to assert it resolves on its own timeout.
  const p = (engine as any).ensureFontReady();

  // Advance time past FONT_READY_TIMEOUT_MS (1500 ms).
  jest.advanceTimersByTime(1500);

  await expect(p).resolves.toBeUndefined();

  jest.useRealTimers();
});
