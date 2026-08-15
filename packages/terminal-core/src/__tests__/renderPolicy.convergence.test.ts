/**
 * renderPolicy.convergence.test.ts
 *
 * design/013 (rev 3) §5.4 — invariant CV. A render-policy fit may consume 012's
 * one-shot relocation convergence arm. That is BENIGN: the stamp opens a 1500ms
 * wall-clock repair window (ED3_EXPECT_WINDOW_MS), and the relocation's own SIGWINCH
 * still lands inside it.
 *
 * The bound is NOT `1500 > 500`. A resize MEASURED at the arm deadline is not sent
 * at the arm deadline: scheduleBackendResize only stamps and then debounces, and
 * bridge.resize fires BACKEND_RESIZE_DEBOUNCE_MS (120) later. Worst case the PTY is
 * SIGWINCH'd at about armStart+620, and its ED3 answer arrives later still. CV-C is
 * therefore the SUFFICIENT condition
 *
 *     ED3_EXPECT_WINDOW_MS
 *        > RELOCATION_CONVERGENCE_ARM_MS + BACKEND_RESIZE_DEBOUNCE_MS
 *          + ED3_RESPONSE_ALLOWANCE_MS
 *     1500 > 500 + 120 + 250 = 870
 *
 * — true today with 630 ms of slack. The true worst-case headroom before any PTY
 * response latency is ~880 ms, NOT the ">=1000 ms" rev 2 claimed. This file is what
 * fails if someone widens the arm or the debounce, or narrows the ED3 window.
 *
 * These tests prove ARITHMETIC over those constants, nothing more. §6.1 routes
 * the real-browser half — a relocation plus a concurrent policy swap against a live
 * ratatui/codex pane, confirming the scrollback survives — to Canvas Mode's manual
 * pass in a develop instance. Nothing here can stand in for that.
 *
 * The harness mirrors engine.convergence-stamp.test.ts and engine.ed3-repair.test.ts.
 */

import { TerminalEngine } from '../TerminalEngine';
import { terminalCache } from '../cache';
import { setTerminalRenderPolicy } from '../renderPolicy';
import type { TerminalBridge, Disposable } from '../types';

/**
 * Spec-level allowance from design/013 rev 3 §5.4, NOT a constant in the source.
 * It budgets everything between `bridge.resize` being called and the PTY's ESC[3J
 * reaching our parser: the Tauri IPC hop, the kernel SIGWINCH, ratatui/codex
 * noticing and re-emitting, and the pty-host stream hop back.
 */
const ED3_RESPONSE_ALLOWANCE_MS = 250;

function makeFakeBridge(getFullScrollback?: jest.Mock, resize?: jest.Mock): TerminalBridge {
  const noop: Disposable = { dispose() {} };
  return {
    onData: () => noop,
    onExit: () => noop,
    write: () => {},
    resize: resize ?? (() => {}),
    getFullScrollback,
  };
}

function makeContainer(): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'offsetWidth', { value: 800, configurable: true });
  Object.defineProperty(el, 'offsetHeight', { value: 600, configurable: true });
  Object.defineProperty(el, 'offsetParent', { value: document.body, configurable: true });
  document.body.appendChild(el);
  return el;
}

let prevRO: unknown;

beforeEach(() => {
  terminalCache.clear();
  TerminalEngine.suppressHealUntil = 0;
  prevRO = (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  };
});

afterEach(() => {
  terminalCache.clear();
  document.body.innerHTML = '';
  jest.useRealTimers();
  TerminalEngine.suppressHealUntil = 0;
  if (prevRO === undefined) delete (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver;
  else (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = prevRO;
});

async function mountAttached(cacheKey: string, getFullScrollback?: jest.Mock, resize?: jest.Mock) {
  const engine = new TerminalEngine(makeFakeBridge(getFullScrollback, resize), { cacheKey });
  engine.mount(makeContainer());
  engine.attach('pid-1');
  await jest.runAllTimersAsync();
  const entry = terminalCache.get(cacheKey)!;
  // hasLayoutBox reads term.element, which jsdom reports as 0x0 — the policy fit
  // would otherwise be skipped by LB and this test would prove nothing.
  Object.defineProperty(entry.terminal.element!, 'offsetWidth', { value: 800, configurable: true });
  Object.defineProperty(entry.terminal.element!, 'offsetHeight', { value: 600, configurable: true });
  return {
    engine: engine as unknown as {
      convergenceArmUntil: number;
      relocateTo(container: HTMLElement): string;
    },
    entry,
    term: entry.terminal as unknown as {
      csiHandlers: Record<string, (p: (number | number[])[]) => boolean>;
      written: string[];
    },
    fit: entry.fitAddon as unknown as { setNextFit(cols: number, rows: number): void; fit(): void },
  };
}

test('a policy fit consumes the arm — and the relocation SIGWINCH is still covered', async () => {
  jest.useFakeTimers();
  const getFullScrollback = jest.fn().mockResolvedValue({ blob: 'RESTORED', rows: 24, cols: 80 });
  const { engine, entry, term, fit } = await mountAttached('cv-consume', getFullScrollback);
  entry.convergenceResizeAt = undefined;

  // A relocation arms the window (relocateTo R2).
  engine.convergenceArmUntil = Date.now() + 500;

  // The policy swap's own fit lands FIRST and spends the arm. Demotion routes
  // through resetTerminalRendering -> fitIfLaidOut; the armed next-fit makes it a
  // size CHANGE, which is what reaches scheduleBackendResize.
  entry.webglAddon = { dispose() {} } as never;
  entry.useWebGL = true;
  fit.setNextFit(160, 24);
  expect(setTerminalRenderPolicy('cv-consume', 'dom')).toBe('dom');

  // `as number | undefined`, not `as number`: the assignment above narrows the
  // field's static type to undefined, which a bare `as number` cannot cross.
  const stampedAt = entry.convergenceResizeAt as number | undefined;
  expect(typeof stampedAt).toBe('number'); // the policy fit stamped
  expect(engine.convergenceArmUntil).toBe(0); // ...and spent the arm

  // The relocation's OWN convergence resize is now MEASURED at the worst case the
  // 500ms arm was sized for, with the arm already gone — so it does NOT re-stamp.
  // `runAllTimersAsync` below also runs the 120ms BACKEND_RESIZE_DEBOUNCE_MS timer,
  // so the SIGWINCH is dispatched at ~armStart+620, not armStart+500. This test
  // does not measure that gap — the next one does; here it only must not be hidden.
  jest.advanceTimersByTime(500);
  fit.setNextFit(150, 24);
  fit.fit();
  await jest.runAllTimersAsync();
  expect(entry.convergenceResizeAt).toBe(stampedAt); // no second stamp

  // CV: codex answers that SIGWINCH with ED3, and the repair still arms — the
  // earlier stamp's 1500ms window is still open well past armStart+620.
  term.csiHandlers['J']?.([3]);
  await jest.runAllTimersAsync();

  expect(getFullScrollback).toHaveBeenCalledWith('pid-1');
  expect(term.written).toContain('RESTORED');
});

// CV-C, stated as the failure it guards. The worst-case ED3 arrives at
//   stamp + RELOCATION_CONVERGENCE_ARM_MS + BACKEND_RESIZE_DEBOUNCE_MS
//        + ED3_RESPONSE_ALLOWANCE_MS
// and must still be inside ED3_EXPECT_WINDOW_MS. This goes red if the ED3 window is
// narrowed, OR if the arm window or the backend debounce is WIDENED. (Narrowing the
// arm or the debounce moves the SIGWINCH earlier, which only adds margin — it is
// correctly not a failure, and this test does not pretend otherwise.)
//
// Both of the first two quantities are MEASURED from the engine rather than written
// as literals, so the constants cannot drift away from the test. In particular the
// debounce is measured by stepping the fake clock 1 ms at a time until bridge.resize
// actually fires — `runAllTimersAsync` would swallow it and was how rev 2's proof
// came to omit it entirely.
test('the ED3 window covers the LATEST SIGWINCH the arm PLUS the backend debounce permit', async () => {
  jest.useFakeTimers();
  const getFullScrollback = jest.fn().mockResolvedValue({ blob: 'RESTORED', rows: 24, cols: 80 });
  const resize = jest.fn();
  const { engine, entry, term, fit } = await mountAttached('cv-margin', getFullScrollback, resize);
  entry.convergenceResizeAt = undefined;

  // RELOCATION_CONVERGENCE_ARM_MS is not exported, so read the arm the engine
  // itself sets. relocateTo's R2 is the only writer.
  const armStart = Date.now();
  expect(engine.relocateTo(makeContainer())).toBe('relocated');
  const armMs = engine.convergenceArmUntil - armStart;
  expect(armMs).toBeGreaterThan(0);

  // Stamp at the very START of the arm — the earliest a policy fit can spend it,
  // and therefore the case with the least margin left at the deadline.
  entry.webglAddon = { dispose() {} } as never;
  entry.useWebGL = true;
  fit.setNextFit(160, 24);
  setTerminalRenderPolicy('cv-margin', 'dom');
  const stampedAt = entry.convergenceResizeAt as number | undefined;
  expect(typeof stampedAt).toBe('number');
  expect(engine.convergenceArmUntil).toBe(0); // the policy fit spent the arm
  await jest.runAllTimersAsync(); // let the policy fit's own debounced resize go
  resize.mockClear();

  // The relocation's own convergence resize is MEASURED at the arm's deadline.
  jest.advanceTimersByTime(armMs - (Date.now() - armStart));
  fit.setNextFit(150, 24);
  fit.fit();
  expect(resize).not.toHaveBeenCalled(); // measured, but NOT yet sent: debounce

  // It reaches the PTY only after BACKEND_RESIZE_DEBOUNCE_MS. Measure that.
  const dispatchProbeStart = Date.now();
  while (resize.mock.calls.length === 0 && Date.now() - dispatchProbeStart <= 5000) {
    jest.advanceTimersByTime(1);
  }
  expect(resize).toHaveBeenCalledTimes(1);
  const debounceMs = Date.now() - dispatchProbeStart;
  expect(debounceMs).toBeGreaterThan(0); // the SIGWINCH is strictly later than the fit

  // ...and codex's ED3 answer arrives an allowance after that.
  jest.advanceTimersByTime(ED3_RESPONSE_ALLOWANCE_MS);
  const elapsedSinceStamp = Date.now() - (stampedAt as number);
  expect(elapsedSinceStamp).toBe(armMs + debounceMs + ED3_RESPONSE_ALLOWANCE_MS);

  term.csiHandlers['J']?.([3]); // codex's wipe answers the SIGWINCH
  await jest.runAllTimersAsync();

  // CV-C holds: ED3_EXPECT_WINDOW_MS > armMs + debounceMs + ED3_RESPONSE_ALLOWANCE_MS
  // (1500 > 500 + 120 + 250 = 870).
  expect(getFullScrollback).toHaveBeenCalledTimes(1);
});

// The declined half of review 112 C2, pinned so it is not re-raised: a policy swap
// on a terminal that NEVER relocated cannot stamp at all. convergenceArmUntil is
// per-ENGINE state initialised to 0, so stampConvergenceIfArmed returns at its
// first line (`Date.now() >= 0`). There is no cross-terminal arm to be stale in.
test('a policy swap on a never-relocated terminal stamps nothing', async () => {
  jest.useFakeTimers();
  const getFullScrollback = jest.fn().mockResolvedValue({ blob: 'x', rows: 24, cols: 80 });
  const { entry, term, fit } = await mountAttached('cv-norelocate', getFullScrollback);
  entry.convergenceResizeAt = undefined;

  entry.webglAddon = { dispose() {} } as never;
  fit.setNextFit(160, 24);
  setTerminalRenderPolicy('cv-norelocate', 'dom');
  await jest.runAllTimersAsync();

  expect(entry.convergenceResizeAt).toBeUndefined();
  term.csiHandlers['J']?.([3]); // e.g. the user running `clear`
  await jest.runAllTimersAsync();
  expect(getFullScrollback).not.toHaveBeenCalled(); // no spurious repair window
});
