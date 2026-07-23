/**
 * engine.hidden-pane-resize.test.ts
 *
 * Hidden-pane resize deferral (codex ED3 scrollback-wipe fix).
 *
 * Background tabs hide via `visibility:hidden` (TerminalContainer.css), so their
 * panes keep full layout and their ResizeObservers keep firing on window resizes.
 * Each observer fit used to push a backend PTY resize; ratatui CLIs (codex) answer
 * any SIGWINCH with ESC[2J ESC[3J + a capped transcript re-emit, silently wiping
 * the hidden tab's accumulated scrollback.
 *
 * The fix: while the host reports the pane inactive (setActive(false)),
 *   (a) observer-driven fits are deferred — no xterm resize, no backend SIGWINCH;
 *   (b) setFontSize's debounced refit is deferred the same way;
 *   (c) the dimension-heal watchdog (healOnce) never fires;
 * and the existing setActive(true) 50ms fit is the single flush point, sending
 * ONE deduped backend resize on activation.
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
  // jsdom always returns null for offsetParent; stub it so visibility guards pass.
  Object.defineProperty(el, 'offsetParent', { value: document.body, configurable: true });
  document.body.appendChild(el);
  return el;
}

interface FakeBridgeOptions {
  resize?: (processId: string, cols: number, rows: number) => void | Promise<void>;
  getSize?: (processId: string) => Promise<{ cols: number; rows: number }>;
}

function makeFakeBridge(opts: FakeBridgeOptions = {}): TerminalBridge {
  const noopDisposable: Disposable = { dispose() {} };
  return {
    onData: () => noopDisposable,
    onExit: () => noopDisposable,
    write: () => {},
    resize: opts.resize ?? (() => {}),
    getSize: opts.getSize,
  };
}

/** ResizeObserver stub that captures each instance's callback so tests can fire it. */
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

/** Fire the most recently registered observer (the engine's, from mount()). */
function fireResizeObserver(): void {
  const inst = CapturingResizeObserver.instances[CapturingResizeObserver.instances.length - 1];
  inst.cb([] as unknown as ResizeObserverEntry[], inst as unknown as ResizeObserver);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

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

/**
 * Mount + attach an engine over a resize-recording bridge and settle all timers.
 * Returns handles the tests poke: the mock term, mock fit addon, and resizeCalls.
 */
async function mountAttached(cacheKey: string) {
  const resizeCalls: Array<[number, number]> = [];
  const bridge = makeFakeBridge({
    resize: (_pid, c, r) => {
      resizeCalls.push([c, r]);
    },
  });
  const engine = new TerminalEngine(bridge, { cacheKey });
  engine.mount(makeContainer());
  engine.attach('pid-1');
  await jest.runAllTimersAsync();

  const entry = terminalCache.get(cacheKey)!;
  const term = entry.terminal as any;
  const fit = entry.fitAddon as any;
  resizeCalls.length = 0; // drop mount/hydrate baseline sizing
  return { engine, term, fit, resizeCalls };
}

// ---------------------------------------------------------------------------
// (a) Observer-driven fits defer while hidden
// ---------------------------------------------------------------------------

test('a hidden pane ignores container resizes: no xterm resize, no backend SIGWINCH', async () => {
  jest.useFakeTimers();
  const { engine, term, fit, resizeCalls } = await mountAttached(`hidden-ro-${Math.random()}`);

  engine.setActive(false); // tab goes to the background
  fit.setNextFit(160, 24); // the window is resized: next measure reads 160x24
  fireResizeObserver();
  await jest.runAllTimersAsync(); // flush rAF + the 120ms backend-resize debounce

  expect(term.cols).toBe(80); // xterm untouched while hidden
  expect(resizeCalls).toEqual([]); // and the PTY got NO SIGWINCH
});

test('activation flushes exactly one deferred backend resize via the setActive fit', async () => {
  jest.useFakeTimers();
  const { engine, term, fit, resizeCalls } = await mountAttached(`hidden-flush-${Math.random()}`);

  engine.setActive(false);
  fit.setNextFit(160, 24);
  fireResizeObserver();
  await jest.runAllTimersAsync();
  expect(resizeCalls).toEqual([]); // deferred while hidden

  engine.setActive(true); // user activates the tab
  await jest.runAllTimersAsync(); // 50ms settle fit + 120ms debounce

  expect(term.cols).toBe(160);
  expect(resizeCalls).toEqual([[160, 24]]); // ONE SIGWINCH, at activation
});

// ---------------------------------------------------------------------------
// (b) setFontSize defers its refit while hidden
// ---------------------------------------------------------------------------

test('setFontSize while hidden applies the option but defers the refit', async () => {
  jest.useFakeTimers();
  const { engine, term, fit, resizeCalls } = await mountAttached(`hidden-font-${Math.random()}`);

  engine.setActive(false);
  fit.setNextFit(150, 24); // what a post-font-change measure would read
  engine.setFontSize(18);
  await jest.runAllTimersAsync();

  expect(term.options.fontSize).toBe(18); // render option still applied
  expect(term.cols).toBe(80); // but no geometry change while hidden
  expect(resizeCalls).toEqual([]);

  engine.setActive(true);
  await jest.runAllTimersAsync();

  expect(term.cols).toBe(150);
  expect(resizeCalls).toEqual([[150, 24]]);
});

// ---------------------------------------------------------------------------
// (c) healOnce never fires for a hidden pane
// ---------------------------------------------------------------------------

test('healOnce skips while the pane is hidden', async () => {
  const spy = jest.spyOn(TerminalEngine.prototype as any, 'scheduleBackendResize');

  const cacheKey = `hidden-heal-${Math.random()}`;
  const bridge = makeFakeBridge({ getSize: async () => ({ cols: 133, rows: 37 }) });
  const engine = new TerminalEngine(bridge, { cacheKey });
  engine.mount(makeContainer());
  const entry = terminalCache.get(cacheKey)!;
  (entry.terminal as any).resize(140, 37);
  (engine as any).attachedProcessId = 'pid-1';
  Object.assign(entry, { lastDataAt: Date.now() - 1000 }); // settled

  engine.setActive(false);
  await (engine as any).healOnce();

  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});

test('healOnce heals again once the pane is active', async () => {
  const spy = jest.spyOn(TerminalEngine.prototype as any, 'scheduleBackendResize');

  const cacheKey = `hidden-heal-back-${Math.random()}`;
  const bridge = makeFakeBridge({ getSize: async () => ({ cols: 133, rows: 37 }) });
  const engine = new TerminalEngine(bridge, { cacheKey });
  engine.mount(makeContainer());
  const entry = terminalCache.get(cacheKey)!;
  (entry.terminal as any).resize(140, 37);
  (engine as any).attachedProcessId = 'pid-1';
  Object.assign(entry, { lastDataAt: Date.now() - 1000 });

  engine.setActive(false);
  engine.setActive(true);
  await (engine as any).healOnce();

  expect(spy).toHaveBeenCalledWith(140, 37);
  spy.mockRestore();
});
