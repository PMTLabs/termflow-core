/**
 * engine.boot-desync.test.ts
 *
 * Task 9 — Integration test: the boot font-desync reproducer.
 *
 * The bug: at boot, fit() runs before the real font is loaded, so the
 * fallback font's wider cell width yields fewer columns (e.g. 133 instead
 * of the correct 140). That wrong count is sent as the pre-hydration resize,
 * and the PTY is stuck at 133 cols, breaking full-width TUIs.
 *
 * Root-cause fixes:
 *   Task 3 (fix A): after mount, re-fit once document.fonts.ready resolves so
 *     the AUTHORITATIVE fit uses real font metrics → xterm resizes to 140.
 *   Task 4 (fix B): reconcilePendingBackendResize() flushes a DIFFERENT-size
 *     pending resize (140) instead of blindly cancelling it.
 *
 * These tests assert that the backend ENDS at the corrected width via those
 * fixes ALONE. The settle-gated watchdog (Task 5) is intentionally excluded
 * — it cannot help a streaming TUI that never settles, and its absence here
 * proves the root-cause path is the actual fix.
 */

import { TerminalEngine } from '../TerminalEngine';
import { terminalCache } from '../cache';
import type { TerminalBridge, Disposable } from '../types';
import { Terminal as MockTerminal } from '../__mocks__/xterm';
import { FitAddon as MockFitAddon } from '../__mocks__/addon-fit';

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
  // Intentionally NO getSize — omitting it disables the settle-gated watchdog
  // (engine.startHealWatchdog() no-ops when bridge.getSize is absent).
  // This ensures Test 1 passes via root-cause fixes alone, not the watchdog.
}

function makeFakeBridge(opts: FakeBridgeOptions = {}): TerminalBridge {
  const noopDisposable: Disposable = { dispose() {} };
  return {
    onData: () => noopDisposable,
    onExit: () => noopDisposable,
    write: () => {},
    resize: opts.resize ?? (() => {}),
    getSnapshot: opts.getSnapshot,
    // getSize deliberately omitted → watchdog never starts
  };
}

/**
 * Mount an engine and return the engine, the raw mock Terminal, the mock
 * FitAddon, and a helper to simulate a fit() + resize event at a specific
 * column width.
 *
 * fitToWidth(cols) is the test stand-in for a direct resize (NOT via
 * FitAddon.fit()): it directly resizes the mock terminal and fires onResize,
 * driving the real onResize → scheduleBackendResize chain.
 *
 * To simulate Fix A's path (ensureFontReady → fit.fit()), use
 * fitAddon.setNextFit(cols, rows) BEFORE resolving fonts.ready — the engine's
 * .then(() => fit.fit()) will call fit.fit(), which then applies the pending
 * size via term.resize + term.emitResize.
 */
function mountEngine(
  bridgeOpts: FakeBridgeOptions = {},
  cacheKey = `boot-desync-${Math.random()}`,
): {
  engine: TerminalEngine;
  term: MockTerminal;
  fitAddon: MockFitAddon;
  fitToWidth: (cols: number) => void;
} {
  const bridge = makeFakeBridge(bridgeOpts);
  const engine = new TerminalEngine(bridge, { cacheKey });
  engine.mount(makeContainer());

  const entry = terminalCache.get(cacheKey)!;
  const term = entry.terminal as unknown as MockTerminal;
  const fitAddon = entry.fitAddon as unknown as MockFitAddon;

  // Pre-size the terminal to a realistic row count (37) so assertions match
  // what a real FitAddon.fit() would produce for a typical pane height.
  // The mock Terminal starts at 24 rows; we set 37 before any fitToWidth call
  // so the onResize events carry the right geometry.
  term.resize(term.cols, 37);

  function fitToWidth(cols: number): void {
    // Mimic a direct resize (e.g. from test setup): resize the xterm canvas,
    // then fire onResize so the engine's onResize handler schedules a backend
    // resize. This does NOT go through FitAddon.fit().
    term.resize(cols, term.rows);
    term.emitResize(cols, term.rows);
  }

  return { engine, term, fitAddon, fitToWidth };
}

/** Flush the microtask queue (one level of pending .then() chains). */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
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
// Test 1: boot with delayed font + immediate streaming → backend ends at
// corrected width, proven by root-cause fixes ALONE (no watchdog).
//
// This test is LOAD-BEARING for fix A (ensureFontReady re-fit):
//   - The FitAddon mock's fit() applies a configurable "pending fit size" by
//     calling term.resize(cols,rows) + term.emitResize(cols,rows), driving the
//     real onResize → scheduleBackendResize chain — exactly what the real FitAddon
//     does in production.
//   - fitAddon.setNextFit(140,37) is set BEFORE resolveFonts(), but NOT consumed
//     by any explicit test call. The ONLY way fit() can be called with that pending
//     size is through fix A's ensureFontReady().then(() => fit.fit()).
//   - Reverting fix A → fit.fit() is never called → setNextFit is never consumed
//     → term stays at 133 cols → last bridge resize stays [133,37] → TEST FAILS.
//
// Sequence:
//   1. mount() → provisional fit at 133 cols (fallback-font measurement)
//      → scheduleBackendResize(133,37) debounce armed
//   2. attach('pid-1') → hydrate() starts, awaits bridge.resize(133,37)
//      (pre-hydration resize), which we keep deferred
//   3. While hydrate awaits: setNextFit(140,37) primes the FitAddon.
//      resolveFonts() → Fix A: ensureFontReady().then(() => fit.fit()) fires
//      → fit.fit() applies setNextFit → term resizes to 140 → onResize fires
//      → scheduleBackendResize(140,37) (new pending)
//   4. bridge.resize(133) resolves → reconcilePendingBackendResize(133,37)
//      sees pending={140,37} ≠ {133,37} → flushBackendResize() → bridge gets 140
//   5. Assert: LAST bridge resize is [140,37].
//
// The watchdog is excluded because bridge.getSize is absent (it only starts
// when getSize is present). This proves root-cause fixes A + B are sufficient.
// ---------------------------------------------------------------------------

test('boot with delayed font + immediate streaming → PTY ends at corrected width (root-cause fixes only, no watchdog)', async () => {
  jest.useFakeTimers();

  // Controllable fonts.ready (simulates real-font load completing after boot).
  let resolveFonts!: () => void;
  (document as any).fonts = {
    ready: new Promise<void>((r) => { resolveFonts = r; }),
    load: () => Promise.resolve([]),
  };

  // Capture every bridge.resize call.
  const resizes: Array<[number, number]> = [];

  // Deferred bridge resize: hydrate awaits this, letting us inject a font-load
  // refit DURING the await window (the race that the root-cause fix must handle).
  let resolveBridgeResize!: () => void;
  const bridgeResizePromise = new Promise<void>((res) => { resolveBridgeResize = res; });

  const cacheKey = `boot-desync-t1-${Math.random()}`;
  const { engine, fitAddon, fitToWidth } = mountEngine(
    {
      resize: (_pid, c, r) => {
        resizes.push([c, r]);
        return bridgeResizePromise;
      },
      getSnapshot: async () => ({ snapshot: '', cols: 0, rows: 0 }),
      // getSize absent → watchdog never starts → assertion proves root-cause only
    },
    cacheKey,
  );

  // Fire all mount-internal timers (100ms settle-fit, RAF settle-fit) BEFORE
  // setting setNextFit so they fire as no-ops. This ensures the ONLY fit() call
  // that can consume setNextFit(140,37) below is Fix A's font-ready .then().
  jest.advanceTimersByTime(200);
  await flushMicrotasks();

  // Step 1: provisional (fallback-font) fit at 133 cols.
  // fitToWidth(133) simulates the initial mount fit result: it directly resizes
  // the xterm canvas and fires onResize → scheduleBackendResize(133,37).
  fitToWidth(133);

  // Step 2: attach → hydrate begins, fires bridge.resize(133,37), then awaits.
  engine.attach('pid-1');

  // Drain microtasks so hydrate has reached the bridge.resize await point.
  await flushMicrotasks();

  // Step 3: prime the FitAddon with the corrected size, then resolve fonts.
  // CRITICAL: we do NOT call fitToWidth(140) or any other direct resize.
  // setNextFit(140,37) is consumed ONLY when fit.fit() is explicitly called.
  // After firing all mount timers in the preamble, the ONLY remaining path that
  // calls fit.fit() is Fix A: ensureFontReady().then(() => fit.fit()).
  // Reverting Fix A → fit.fit() is never called → setNextFit is never consumed
  // → term stays at 133 cols → last bridge resize stays [133,37] → TEST FAILS.
  fitAddon.setNextFit(140, 37);
  resolveFonts();
  // Drain microtasks so Fix A's .then() runs → fit.fit() → term resizes to 140
  // → onResize → scheduleBackendResize(140,37).
  await flushMicrotasks();

  // Step 4: bridge.resize(133) resolves → reconcilePendingBackendResize sees
  // pending={140} ≠ sent={133} → flushBackendResize() → bridge gets (140,37).
  resolveBridgeResize();

  // Drain the debounce timer (120ms) + follow-up microtasks.
  await jest.runAllTimersAsync();
  await flushMicrotasks();

  // Step 5: the LAST resize the bridge received must be the corrected 140 cols.
  // Root-cause fix A ensured the re-fit ran; fix B ensured it wasn't discarded.
  // Reverting EITHER fix causes the last resize to remain [133,37] → FAIL.
  expect(resizes.length).toBeGreaterThan(0);
  expect(resizes[resizes.length - 1]).toEqual([140, 37]);
});

// ---------------------------------------------------------------------------
// Test 2: reconcilePendingBackendResize flushes a DIFFERENT-size pending resize
// rather than cancelling it (fix B correctness).
//
// This test is LOAD-BEARING for fix B:
//   - With fix B: reconcilePendingBackendResize(133,37) detects pending={140,37}
//     ≠ {133,37} → flushes it → bridge.resize(140,37) is sent SYNCHRONOUSLY as
//     part of the reconcile call, BEFORE getSnapshot is even awaited.
//   - Without fix B (always-cancel bug): pending is cancelled, bridge.resize(140)
//     is never called via reconcile → resizes only contains [133,37] at the
//     assertion point → TEST FAILS.
//
// Crucially, the assertion happens BEFORE resolving the getSnapshot promise, so
// the second-await-window guard (which could also deliver [140,37]) has NOT run
// yet. The test therefore targets fix B's reconcile behaviour exclusively.
//
// Sequence:
//   1. mount() + fitToWidth(133) → provisional size
//   2. attach('pid-1') → hydrate starts, pre-resize bridge.resize(133,37) deferred
//   3. During bridge.resize(133) await: fitToWidth(140) → scheduleBackendResize(140,37)
//   4. bridge.resize(133,37) resolves → reconcilePendingBackendResize(133,37):
//      Fix B: flushes pending → bridge.resize(140,37) IS sent.
//      Without fix B: cancels pending → bridge.resize(140,37) is NOT sent here.
//   5. ASSERT before getSnapshot resolves: resizes == [[133,37],[140,37]].
//   6. Resolve snapshot + drain → confirm snapshot written once.
// ---------------------------------------------------------------------------

test('reconcilePendingBackendResize flushes a different-size pending resize (fix B)', async () => {
  jest.useFakeTimers();

  const SNAPSHOT_CONTENT = 'snapshot-content-abc';

  // Deferred bridge.resize(133) — pre-hydration resize.
  let resolveBridgeResize133!: () => void;
  const bridgeResize133Promise = new Promise<void>((res) => { resolveBridgeResize133 = res; });

  // Deferred getSnapshot — we control exactly when it resolves.
  let resolveSnap!: (v: { snapshot: string; cols: number; rows: number }) => void;
  const snapPromise = new Promise<{ snapshot: string; cols: number; rows: number }>((res) => {
    resolveSnap = res;
  });

  // Capture all bridge.resize calls in order.
  const resizes: Array<[number, number]> = [];

  const cacheKey = `boot-desync-t2-${Math.random()}`;
  const { engine, term, fitToWidth } = mountEngine(
    {
      resize: (_pid, c, r) => {
        resizes.push([c, r]);
        if (c === 133) return bridgeResize133Promise;
        // bridge.resize(140,37) — synchronous (no deferred promise).
        // This means fix B's flush completes immediately, so we can assert
        // resizes synchronously after flushMicrotasks().
      },
      getSnapshot: () => snapPromise,
      // getSize absent → watchdog never starts
    },
    cacheKey,
  );

  // Spy on term.write to count snapshot deliveries.
  const writeSpy = jest.spyOn(term, 'write');

  // Step 1: provisional fit at 133 cols.
  fitToWidth(133);

  // Step 2: attach → hydrate → pre-resize bridge.resize(133,37) fires and waits.
  engine.attach('pid-1');
  await flushMicrotasks();

  // Step 3: DURING bridge.resize(133) await — fire a refit to 140 cols.
  // Drives onResize → scheduleBackendResize(140,37) (debounce timer armed, NOT yet fired).
  fitToWidth(140);

  // Step 4: bridge.resize(133,37) resolves → hydrate continuation:
  //   Fix B: reconcilePendingBackendResize(133,37) → pending={140,37}≠{133,37} → FLUSH
  //     → flushBackendResize() → bridge.resize(140,37) [synchronous] → resizes gets [140,37].
  //   Without fix B: pending cancelled → bridge.resize(140) NOT called here.
  resolveBridgeResize133();
  await flushMicrotasks();

  // Assert BEFORE getSnapshot resolves — so the second-await-window guard has
  // NOT run yet. The only way [140,37] can be in resizes at this point is via
  // fix B's reconcile flush.
  // Without fix B: resizes == [[133,37]] → assertion FAILS.
  expect(resizes).toEqual([[133, 37], [140, 37]]);

  // Now resolve the snapshot and drain everything to verify no duplicate snapshot write.
  resolveSnap({ snapshot: SNAPSHOT_CONTENT, cols: 133, rows: 37 });
  await jest.runAllTimersAsync();
  await flushMicrotasks();

  // Assert 2: snapshot written exactly once (no duplicate hydrate).
  const snapshotWrites = writeSpy.mock.calls.filter(([data]) => data === SNAPSHOT_CONTENT);
  expect(snapshotWrites.length).toBe(1);
});
