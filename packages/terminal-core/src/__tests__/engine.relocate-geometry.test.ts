/**
 * engine.relocate-geometry.test.ts
 *
 * design/012 §6.1-§6.4 — §13 T7(b), T8(a)-(e), T9, T-multi.
 *
 * The changing case is the DEFAULT: a canvas node is not the same pixel box as a
 * pane. Without the convergenceResizeAt stamp a ratatui/codex PTY answers the
 * SIGWINCH with ESC[2J ESC[3J and the scrollback is wiped with no repair armed
 * (D9 / H2 / §6.2) — silent data loss, and rev 3's §14 criterion 4 asserted the
 * opposite.
 */

import { TerminalEngine } from '../TerminalEngine';
import { terminalCache } from '../cache';
import type { TerminalBridge, Disposable } from '../types';

interface FakeBridgeOptions {
  resize?: (processId: string, cols: number, rows: number) => void | Promise<void>;
}

function makeFakeBridge(opts: FakeBridgeOptions = {}): TerminalBridge {
  const noopDisposable: Disposable = { dispose() {} };
  return {
    onData: () => noopDisposable,
    onExit: () => noopDisposable,
    write: () => {},
    resize: opts.resize ?? (() => {}),
  };
}

function makeHost(width = 800, height = 600): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-display-wrapper';
  const el = document.createElement('div');
  el.className = 'terminal-display';
  Object.defineProperty(el, 'offsetWidth', { value: width, configurable: true });
  Object.defineProperty(el, 'offsetHeight', { value: height, configurable: true });
  Object.defineProperty(el, 'offsetParent', { value: document.body, configurable: true });
  wrapper.appendChild(el);
  document.body.appendChild(wrapper);
  return el;
}

/** ResizeObserver stub whose callback tests fire, standing in for the initial
 *  observe() callback the real one delivers after R7 re-arms it. */
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

function fireLatestObserver(): void {
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

async function mountAttached(cacheKey: string, resize?: FakeBridgeOptions['resize']) {
  const resizeCalls: Array<[number, number]> = [];
  const engine = new TerminalEngine(
    makeFakeBridge({
      resize: resize ?? ((_pid, c, r) => { resizeCalls.push([c, r]); }),
    }),
    { cacheKey, isMac: false },
  );
  const pane = makeHost();
  engine.mount(pane);
  engine.attach('pid-1');
  await jest.runAllTimersAsync();
  const entry = terminalCache.get(cacheKey)!;
  resizeCalls.length = 0;
  entry.convergenceResizeAt = undefined;
  return {
    engine, pane, entry,
    term: entry.terminal as any,
    fit: entry.fitAddon as any,
    resizeCalls,
  };
}

describe('design/012 §6 — geometry across a relocation', () => {
  // §13 T8(a) + §6.3. The unchanged case: proposeDimensions() matches, so fit()
  // does not call term.resize(); no onResize, no scheduleBackendResize, no
  // SIGWINCH, no stamp.
  it('unchanged geometry sends nothing to the PTY and never stamps', async () => {
    jest.useFakeTimers();
    const { engine, entry, resizeCalls } = await mountAttached('geo-t8a');

    const host = makeHost();
    engine.relocateTo(host, { paneChrome: false });
    fireLatestObserver();                 // the observer's initial callback
    await jest.runAllTimersAsync();

    expect(resizeCalls).toEqual([]);
    expect(entry.convergenceResizeAt).toBeUndefined();
  });

  // §13 T8(b) + T8(d). The changing case: exactly ONE resize, at the NEW dims, and
  // it is STAMPED so the ED3 detector at :1261-1274 opens its 1500ms repair window.
  it('changed geometry sends exactly one stamped resize at the new dimensions', async () => {
    jest.useFakeTimers();
    const { engine, term, fit, entry, resizeCalls } = await mountAttached('geo-t8b');

    const host = makeHost();
    engine.relocateTo(host, { paneChrome: false });
    fit.setNextFit(140, 36);              // the canvas node's grid
    fireLatestObserver();
    await jest.runAllTimersAsync();

    expect(term.cols).toBe(140);
    expect(resizeCalls).toEqual([[140, 36]]);
    expect(typeof entry.convergenceResizeAt).toBe('number');
  });

  // §13 T7(b). A geometry-CHANGING relocation runs the live onResize handler,
  // which cancels the capture mark and sets suppressUntilSubmit (:1112-1116). That
  // is the existing, correct reflow behaviour — an absolute row/col mark is
  // untranslatable after reflow — and relocation must not defeat it.
  it('cancels the capture mark on a geometry-changing relocation', async () => {
    jest.useFakeTimers();
    const { engine, term, fit } = await mountAttached('geo-t7b');
    term.__setCursor(4, 0);
    (engine as any).capture.noteUserKey();
    expect((engine as any).capture.hasMark()).toBe(true);

    const host = makeHost();
    engine.relocateTo(host, { paneChrome: false });
    fit.setNextFit(140, 36);
    fireLatestObserver();
    await jest.runAllTimersAsync();

    expect((engine as any).capture.hasMark()).toBe(false);
    expect((engine as any).suppressUntilSubmit).toBe(true);
  });

  // §13 T8(c) / H7. mount() would fail this: unmount()'s forced
  // flushBackendResize(true) sets resizeInFlight synchronously (:2593) and clears
  // it only in a .finally() (:2603), which always defers at least one microtask, so
  // the flag is GUARANTEED still true through an immediately following synchronous
  // mount() — whose reconcile is gated on `&& !this.resizeInFlight &&
  // !this.pendingResize` (:1963-1964). relocateTo never steps in it because it
  // never calls unmount() and never uses that reconcile (§6.4).
  it('still delivers the new size with a resize already in flight', async () => {
    jest.useFakeTimers();
    let release: () => void = () => {};
    const resizeCalls: Array<[number, number]> = [];
    const { engine, term, fit } = await mountAttached('geo-t8c', (_pid, c, r) => {
      resizeCalls.push([c, r]);
      return new Promise<void>((res) => { release = res; });
    });

    // Put a real bridge.resize in flight: fit -> onResize -> debounce -> flush.
    fit.setNextFit(100, 30);
    fit.fit();
    jest.advanceTimersByTime(200);
    expect((engine as any).resizeInFlight).toBe(true);
    resizeCalls.length = 0;

    const host = makeHost();
    engine.relocateTo(host, { paneChrome: false });
    fit.setNextFit(140, 36);
    fireLatestObserver();
    release();
    await jest.runAllTimersAsync();

    expect(term.cols).toBe(140);
    expect(resizeCalls).toEqual([[140, 36]]);
  });

  // §13 T8(e) / review 096. stampConvergenceIfArmed consumes the arm on its FIRST
  // call, so a hydrate() at :2181 landing early in the 500ms window consumes it and
  // the relocation's own scheduleBackendResize does NOT re-stamp. Harmless — the
  // relocation resize lands at most ~620ms later (500ms arm + 120ms debounce),
  // comfortably inside ED3_EXPECT_WINDOW_MS = 1500 — but "consumes it once" alone
  // does not prove it, so assert the WINDOW, not just the consumption.
  it('a hydrate inside the arm window stamps once, and the relocation SIGWINCH still '
    + 'falls inside that window', async () => {
    jest.useFakeTimers();
    const { engine, entry, fit, resizeCalls } = await mountAttached('geo-t8e');

    const host = makeHost();
    engine.relocateTo(host, { paneChrome: false });          // arms 500ms
    engine.attach('pid-hydrate-2');                          // hydrate -> :2181 -> stamp
    await jest.runAllTimersAsync();
    const stampedAt = entry.convergenceResizeAt as number;
    expect(typeof stampedAt).toBe('number');
    expect((engine as any).convergenceArmUntil).toBe(0);

    // The relocation's own resize now lands WITHOUT re-stamping…
    resizeCalls.length = 0;
    fit.setNextFit(140, 36);
    fireLatestObserver();
    await jest.runAllTimersAsync();
    expect(resizeCalls).toEqual([[140, 36]]);
    expect(entry.convergenceResizeAt).toBe(stampedAt);
    // …and it is still inside the window the earlier stamp opened.
    expect(Date.now() - stampedAt).toBeLessThan(1500);
  });

  // §13 T9 — the judgement call (§15.1 / D12). A pendingResize armed BEFORE the
  // move is neither cancelled nor duplicated: all five scheduleBackendResize
  // callers pass xterm's OWN live dims, which are host-independent, so delivering a
  // surviving pending value after the move is correct rather than stale.
  it('neither cancels nor duplicates a resize pending across the move', async () => {
    jest.useFakeTimers();
    const { engine, fit, resizeCalls } = await mountAttached('geo-t9');

    fit.setNextFit(150, 40);
    fit.fit();                                   // arms pendingResize + the 120ms timer
    expect((engine as any).pendingResize).toEqual({ cols: 150, rows: 40 });

    const host = makeHost();
    engine.relocateTo(host, { paneChrome: false });
    await jest.runAllTimersAsync();

    expect(resizeCalls).toEqual([[150, 40]]);    // exactly one, at xterm's live dims
  });

  // §13 T-multi / H9. Two engines relocating in the same synchronous block do not
  // interfere: the operation is per-engine with no shared mutable state, and the one
  // shared structure it touches (terminalCache) is read and mutated per key.
  // Entering Canvas Mode does this for EVERY terminal in the workspace at once —
  // O(all terminals), not O(visible), because RC4 forbids culling from relocating.
  // The N-large case stays a manual gate (§13).
  it('two engines relocate in the same synchronous block without interfering', async () => {
    jest.useFakeTimers();
    const a = await mountAttached('geo-multi-a');
    const b = await mountAttached('geo-multi-b');
    const hostA = makeHost();
    const hostB = makeHost();

    expect(a.engine.relocateTo(hostA, { paneChrome: false })).toBe('relocated');
    expect(b.engine.relocateTo(hostB, { paneChrome: false })).toBe('relocated');

    expect(hostA.contains(a.term.element!)).toBe(true);
    expect(hostB.contains(b.term.element!)).toBe(true);
    expect(a.term.element!.isConnected).toBe(true);
    expect(b.term.element!.isConnected).toBe(true);
    expect(terminalCache.get('geo-multi-a')!.terminal).toBe(a.term);
    expect(terminalCache.get('geo-multi-b')!.terminal).toBe(b.term);

    // b's observer is the most recently created one.
    b.fit.setNextFit(90, 20);
    fireLatestObserver();
    await jest.runAllTimersAsync();

    expect(b.resizeCalls).toEqual([[90, 20]]);
    expect(a.resizeCalls).toEqual([]);           // a is untouched by b's fit
    expect(a.term.cols).toBe(80);
  });
});
