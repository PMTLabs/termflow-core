/**
 * lifecycle-timers.test.ts
 *
 * Tests that pending fit timers (setTimeout/rAF) are cancelled on unmount so
 * they cannot fire against a disposed/stale addon, and that a ResizeObserver
 * is properly disconnected when mount() is called a second time without a
 * preceding unmount() (legit "pane move" pattern).
 *
 * Regression guards: these tests protect against timer and observer lifecycle
 * bugs being re-introduced into TerminalEngine.ts.
 */

import { TerminalEngine } from '../TerminalEngine';
import { terminalCache } from '../cache';
import type { TerminalBridge, Disposable } from '../types';
import { FitAddon as MockFitAddon } from '../__mocks__/addon-fit';

// ---------------------------------------------------------------------------
// Helpers (copied from hydration.test.ts pattern)
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

// jsdom gives us a real element; force a usable size so the >50px guards pass.
function makeContainer(width = 800, height = 600): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'offsetWidth', { value: width, configurable: true });
  Object.defineProperty(el, 'offsetHeight', { value: height, configurable: true });
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  terminalCache.clear();
  // jsdom lacks ResizeObserver — provide a no-op so mount() doesn't throw.
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
// Test 1: pending fit timers (setActive + setFontSize) must NOT fire after
// unmount().
//
// Under the BUGGY code the 50ms timers from setActive/setFontSize fire after
// unmount because there is no cancel path. The test asserts the fitCount does
// NOT increase after unmount(), which fails on the current code.
// ---------------------------------------------------------------------------

it('cancels pending fit timers on unmount (no fit after teardown)', () => {
  jest.useFakeTimers();
  try {
    const engine = new TerminalEngine(makeFakeBridge(), { cacheKey: 'lt1' });
    engine.mount(makeContainer());

    // Advance past mount's own 100ms settle-fit and any rAF fits so the
    // baseline measurement reflects only mount-time activity.
    jest.advanceTimersByTime(200);

    const entry = terminalCache.get('lt1')!;
    const fitAddon = entry.fitAddon as unknown as MockFitAddon;
    const before = fitAddon.fitCount;

    // Both schedule a 50ms deferred fit.
    engine.setActive(true);
    engine.setFontSize(16);

    // Unmount BEFORE the timers fire.
    engine.unmount();

    // Advance far enough that both 50ms timers AND the 100ms settle timer
    // would have fired if not cancelled.
    jest.advanceTimersByTime(500);

    // Neither timer should have incremented fitCount after unmount.
    expect(fitAddon.fitCount).toBe(before);
  } finally {
    jest.useRealTimers();
  }
});

// ---------------------------------------------------------------------------
// Test 2: a second mount() WITHOUT a preceding unmount() (pane-move pattern)
// must disconnect the previous ResizeObserver so it stops firing fit() against
// the abandoned container.
//
// Under the BUGGY code, resizeObserver is overwritten without disconnecting
// the old one — so the orphaned observer keeps a reference to the abandoned
// container and keeps calling fit().
// ---------------------------------------------------------------------------

it('disconnects the previous ResizeObserver when mount() is called again without unmount()', () => {
  const disconnects: number[] = [];

  class CountingRO {
    constructor(_cb: ResizeObserverCallback) {}
    observe(_el: Element) {}
    unobserve(_el: Element) {}
    disconnect() {
      disconnects.push(1);
    }
  }

  const hadRO = 'ResizeObserver' in globalThis;
  const prevRO = (globalThis as any).ResizeObserver;
  (globalThis as any).ResizeObserver = CountingRO;

  try {
    const engine = new TerminalEngine(makeFakeBridge(), { cacheKey: 'lt2' });

    // First mount — creates a CountingRO.
    engine.mount(makeContainer());
    // Zero disconnects yet.
    expect(disconnects.length).toBe(0);

    // Second mount WITHOUT unmount (pane move scenario) — the OLD observer
    // MUST be disconnected before a new one is created.
    engine.mount(makeContainer());
    expect(disconnects.length).toBe(1);

    // Normal unmount disconnects the second observer.
    engine.unmount();
    expect(disconnects.length).toBe(2);
  } finally {
    if (hadRO) {
      (globalThis as any).ResizeObserver = prevRO;
    } else {
      delete (globalThis as any).ResizeObserver;
    }
  }
});

// ---------------------------------------------------------------------------
// Test 3: setActive ALONE (no subsequent setFontSize) schedules a 50ms fit;
// unmount() must cancel it so fitCount does not increase after teardown.
// ---------------------------------------------------------------------------

it('cancels the 50ms fit timer scheduled by setActive alone', () => {
  jest.useFakeTimers();
  try {
    const engine = new TerminalEngine(makeFakeBridge(), { cacheKey: 'lt3' });
    engine.mount(makeContainer());

    // Advance past mount's own 100ms settle-fit and any rAF fits so the
    // baseline measurement reflects only mount-time activity.
    jest.advanceTimersByTime(200);

    const entry = terminalCache.get('lt3')!;
    const fitAddon = entry.fitAddon as unknown as MockFitAddon;
    const before = fitAddon.fitCount;

    // setActive alone schedules a 50ms deferred fit.
    engine.setActive(true);

    // Unmount BEFORE the 50ms timer fires.
    engine.unmount();

    // Advance well past the 50ms window; the timer must not have fired.
    jest.advanceTimersByTime(500);

    expect(fitAddon.fitCount).toBe(before);
  } finally {
    jest.useRealTimers();
  }
});
