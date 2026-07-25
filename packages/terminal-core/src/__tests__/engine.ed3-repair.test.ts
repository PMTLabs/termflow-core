/**
 * engine.ed3-repair.test.ts
 *
 * ED3 resize-wipe auto-repair (docs/superpowers/specs/
 * 2026-07-24-protocol-state-and-resize-wipe-fixes-design.md).
 *
 * codex (ratatui) answers a real resize with ESC[2J ESC[3J (erase scrollback) then
 * re-emits its own retained transcript, capped at ~1000 lines — xterm.js honors 3J
 * and wipes everything the client accumulated beyond that cap. The backend's
 * independent vt100 parser does not (see state.rs's
 * full_scrollback_survives_2j_3j_for_already_scrolled_history), so the fix detects
 * a CSI-3J arriving shortly after OUR OWN background-reactivation convergence
 * resize and repairs the live view with a full reset+rewrite from the backend's
 * authoritative scrollback.
 */

import { TerminalEngine } from '../TerminalEngine';
import { terminalCache } from '../cache';
import type { TerminalBridge, Disposable } from '../types';

// ---------------------------------------------------------------------------
// Helpers (mirrors engine.hidden-pane-resize.test.ts)
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
  resize?: (processId: string, cols: number, rows: number) => void | Promise<void>;
  getFullScrollback?: (processId: string) => Promise<{ blob: string; rows: number; cols: number }>;
}

function makeFakeBridge(opts: FakeBridgeOptions = {}): TerminalBridge {
  const noopDisposable: Disposable = { dispose() {} };
  return {
    onData: () => noopDisposable,
    onExit: () => noopDisposable,
    write: () => {},
    resize: opts.resize ?? (() => {}),
    getFullScrollback: opts.getFullScrollback,
  };
}

class CapturingResizeObserver {
  static instances: CapturingResizeObserver[] = [];
  cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
    CapturingResizeObserver.instances.push(this);
  }
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

function fireResizeObserver(): void {
  const inst = CapturingResizeObserver.instances[CapturingResizeObserver.instances.length - 1];
  inst.cb([] as unknown as ResizeObserverEntry[], inst as unknown as ResizeObserver);
}

let prevRO: unknown;

beforeEach(() => {
  terminalCache.clear();
  TerminalEngine.suppressHealUntil = 0;
  CapturingResizeObserver.instances = [];
  prevRO = (globalThis as any).ResizeObserver;
  (globalThis as any).ResizeObserver = CapturingResizeObserver;
});

afterEach(() => {
  terminalCache.clear();
  document.body.innerHTML = '';
  jest.useRealTimers();
  TerminalEngine.suppressHealUntil = 0;
  if (prevRO === undefined) delete (globalThis as any).ResizeObserver;
  else (globalThis as any).ResizeObserver = prevRO;
});

async function mountAttached(cacheKey: string, opts: FakeBridgeOptions = {}) {
  const bridge = makeFakeBridge(opts);
  const engine = new TerminalEngine(bridge, { cacheKey });
  engine.mount(makeContainer());
  engine.attach('pid-1');
  await jest.runAllTimersAsync();

  const entry = terminalCache.get(cacheKey)!;
  const term = entry.terminal as any;
  const fit = entry.fitAddon as any;
  return { engine, term, fit };
}

/** Drive a hidden pane through a real background-reactivation convergence resize. */
async function converge(engine: TerminalEngine, fit: any) {
  engine.setActive(false);
  fit.setNextFit(160, 24);
  fireResizeObserver();
  await jest.runAllTimersAsync();
  engine.setActive(true); // stamps convergenceResizeAt + sends the real resize
  await jest.runAllTimersAsync();
}

// ---------------------------------------------------------------------------

test('CSI 3J within the expectation window after a convergence resize triggers repair', async () => {
  jest.useFakeTimers();
  const getFullScrollback = jest.fn().mockResolvedValue({ blob: 'RESTORED', rows: 24, cols: 80 });
  const { engine, term, fit } = await mountAttached(`ed3-${Math.random()}`, { getFullScrollback });

  await converge(engine, fit);
  term.csiHandlers['J']?.([3]); // codex's ED3, arriving right after our resize
  await jest.runAllTimersAsync(); // RESYNC_SETTLE_MS debounce + the getFullScrollback microtask

  expect(getFullScrollback).toHaveBeenCalledWith('pid-1');
  expect(term.resetCount).toBeGreaterThan(0);
  expect(term.written).toContain('RESTORED');
});

test('CSI 3J with no recent convergence resize does NOT trigger repair', async () => {
  jest.useFakeTimers();
  const getFullScrollback = jest.fn().mockResolvedValue({ blob: 'x', rows: 24, cols: 80 });
  const { term } = await mountAttached(`ed3-noconv-${Math.random()}`, { getFullScrollback });

  term.csiHandlers['J']?.([3]); // e.g. the user ran `clear` — no prior convergence resize
  await jest.runAllTimersAsync();

  expect(getFullScrollback).not.toHaveBeenCalled();
});

test('CSI 3J outside the expectation window (stale convergence) does NOT trigger repair', async () => {
  jest.useFakeTimers();
  const getFullScrollback = jest.fn().mockResolvedValue({ blob: 'x', rows: 24, cols: 80 });
  const { engine, term, fit } = await mountAttached(`ed3-stale-${Math.random()}`, { getFullScrollback });

  await converge(engine, fit);
  jest.advanceTimersByTime(5000); // well past ED3_EXPECT_WINDOW_MS
  term.csiHandlers['J']?.([3]); // an unrelated clear long after the resize settled
  await jest.runAllTimersAsync();

  expect(getFullScrollback).not.toHaveBeenCalled();
});

test('two ED3s in quick succession coalesce to one repair using the latest generation', async () => {
  jest.useFakeTimers();
  const getFullScrollback = jest.fn().mockResolvedValue({ blob: 'LATEST', rows: 24, cols: 80 });
  const { engine, term, fit } = await mountAttached(`ed3-coalesce-${Math.random()}`, { getFullScrollback });

  await converge(engine, fit);
  term.csiHandlers['J']?.([3]);
  jest.advanceTimersByTime(100); // before the 700ms debounce fires
  term.csiHandlers['J']?.([3]); // a second wipe arrives before the first repair ran
  await jest.runAllTimersAsync();

  expect(getFullScrollback).toHaveBeenCalledTimes(1);
  expect(term.written).toContain('LATEST');
});

test('endpoint failure leaves the view unchanged and does not throw', async () => {
  jest.useFakeTimers();
  const getFullScrollback = jest.fn().mockRejectedValue(new Error('network'));
  const { engine, term, fit } = await mountAttached(`ed3-fail-${Math.random()}`, { getFullScrollback });

  await converge(engine, fit);
  term.csiHandlers['J']?.([3]);
  await expect(jest.runAllTimersAsync()).resolves.not.toThrow();

  expect(term.resetCount).toBe(0);
});

test('a bridge without getFullScrollback is skipped silently (no crash)', async () => {
  jest.useFakeTimers();
  const { engine, term, fit } = await mountAttached(`ed3-nobridge-${Math.random()}`); // no getFullScrollback

  await converge(engine, fit);
  term.csiHandlers['J']?.([3]);
  await expect(jest.runAllTimersAsync()).resolves.not.toThrow();

  expect(term.resetCount).toBe(0);
});

test('a reactivation that resizes nothing does not stamp convergence (narrower than "every activation")', async () => {
  jest.useFakeTimers();
  const getFullScrollback = jest.fn().mockResolvedValue({ blob: 'x', rows: 24, cols: 80 });
  const cacheKey = `ed3-noresize-${Math.random()}`;
  const { engine, term } = await mountAttached(cacheKey, { getFullScrollback });

  // Deactivate/reactivate WITHOUT any size change in between (fit is a no-op).
  engine.setActive(false);
  engine.setActive(true);
  await jest.runAllTimersAsync();

  expect(terminalCache.get(cacheKey)?.convergenceResizeAt).toBeUndefined();

  term.csiHandlers['J']?.([3]); // e.g. an unrelated `clear` shortly after
  await jest.runAllTimersAsync();

  expect(getFullScrollback).not.toHaveBeenCalled();
});

test('unmount() cancels a scheduled repair so it never fires against an abandoned engine', async () => {
  jest.useFakeTimers();
  const getFullScrollback = jest.fn().mockResolvedValue({ blob: 'x', rows: 24, cols: 80 });
  const cacheKey = `ed3-unmount-${Math.random()}`;
  const { engine, term, fit } = await mountAttached(cacheKey, { getFullScrollback });

  await converge(engine, fit);
  term.csiHandlers['J']?.([3]); // detected — repair scheduled RESYNC_SETTLE_MS out
  engine.unmount(); // pane backgrounded again before the debounce fires
  await jest.runAllTimersAsync();

  expect(getFullScrollback).not.toHaveBeenCalled();
  expect(term.resetCount).toBe(0);
});

test('repair defers while output is still live, then commits once it settles', async () => {
  jest.useFakeTimers();
  const getFullScrollback = jest.fn().mockResolvedValue({ blob: 'SETTLED', rows: 24, cols: 80 });
  const cacheKey = `ed3-unsettled-${Math.random()}`;
  const { engine, term, fit } = await mountAttached(cacheKey, { getFullScrollback });

  await converge(engine, fit);
  term.csiHandlers['J']?.([3]); // schedules the repair check for +700ms
  jest.advanceTimersByTime(600); // not yet fired
  const entry = terminalCache.get(cacheKey)!;
  entry.lastDataAt = Date.now(); // codex's re-emit is still streaming right now
  jest.advanceTimersByTime(150); // crosses the original debounce -> finds it unsettled, re-arms
  expect(getFullScrollback).not.toHaveBeenCalled(); // deferred, not dropped

  // Output goes quiet; the re-armed check settles on its next pass.
  await jest.runAllTimersAsync();

  expect(getFullScrollback).toHaveBeenCalledWith('pid-1');
  expect(term.written).toContain('SETTLED');
});
