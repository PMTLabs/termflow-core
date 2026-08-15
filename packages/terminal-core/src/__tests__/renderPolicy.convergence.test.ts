/**
 * renderPolicy.convergence.test.ts
 *
 * design/013 (rev 2) §5.4 — invariant CV. A render-policy fit may consume 012's
 * one-shot relocation convergence arm. That is BENIGN: the stamp opens a 1500ms
 * wall-clock repair window (ED3_EXPECT_WINDOW_MS) which strictly exceeds the 500ms
 * arm (RELOCATION_CONVERGENCE_ARM_MS), so the relocation's own SIGWINCH — landing
 * at the latest at armStart+500 — is still inside it. CV-C: that inequality is
 * load-bearing for the render-policy layer, and this file is what fails if someone
 * narrows it.
 *
 * These tests prove ARITHMETIC over the two constants, nothing more. §6.1 routes
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

function makeFakeBridge(getFullScrollback?: jest.Mock): TerminalBridge {
  const noop: Disposable = { dispose() {} };
  return {
    onData: () => noop,
    onExit: () => noop,
    write: () => {},
    resize: () => {},
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

async function mountAttached(cacheKey: string, getFullScrollback?: jest.Mock) {
  const engine = new TerminalEngine(makeFakeBridge(getFullScrollback), { cacheKey });
  engine.mount(makeContainer());
  engine.attach('pid-1');
  await jest.runAllTimersAsync();
  const entry = terminalCache.get(cacheKey)!;
  // hasLayoutBox reads term.element, which jsdom reports as 0x0 — the policy fit
  // would otherwise be skipped by LB and this test would prove nothing.
  Object.defineProperty(entry.terminal.element!, 'offsetWidth', { value: 800, configurable: true });
  Object.defineProperty(entry.terminal.element!, 'offsetHeight', { value: 600, configurable: true });
  return {
    engine: engine as unknown as { convergenceArmUntil: number },
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

  // The relocation's OWN convergence resize now lands at the worst case the 500ms
  // arm was sized for, with the arm already gone — so it does NOT re-stamp.
  jest.advanceTimersByTime(500);
  fit.setNextFit(150, 24);
  fit.fit();
  await jest.runAllTimersAsync();
  expect(entry.convergenceResizeAt).toBe(stampedAt); // no second stamp

  // CV: codex answers that SIGWINCH with ED3, and the repair still arms — the
  // earlier stamp's 1500ms window is still open at armStart+500.
  term.csiHandlers['J']?.([3]);
  await jest.runAllTimersAsync();

  expect(getFullScrollback).toHaveBeenCalledWith('pid-1');
  expect(term.written).toContain('RESTORED');
});

// CV-C, stated as the failure it guards: if ED3_EXPECT_WINDOW_MS were narrowed to
// or below RELOCATION_CONVERGENCE_ARM_MS, the worst-case relocation resize would
// fall outside the window a policy fit's stamp opened, and this test would fail.
test('the ED3 window still covers the LATEST resize the arm window permits', async () => {
  jest.useFakeTimers();
  const getFullScrollback = jest.fn().mockResolvedValue({ blob: 'RESTORED', rows: 24, cols: 80 });
  const { engine, entry, term, fit } = await mountAttached('cv-margin', getFullScrollback);
  entry.convergenceResizeAt = undefined;

  // Stamp at the very START of the arm — the earliest a policy fit can spend it,
  // and therefore the case with the least margin left at armStart+500.
  engine.convergenceArmUntil = Date.now() + 500;
  entry.webglAddon = { dispose() {} } as never;
  fit.setNextFit(160, 24);
  setTerminalRenderPolicy('cv-margin', 'dom');
  expect(typeof entry.convergenceResizeAt).toBe('number');

  jest.advanceTimersByTime(500); // relocation converges at the arm's deadline
  term.csiHandlers['J']?.([3]); // codex's wipe answers it
  await jest.runAllTimersAsync();

  expect(getFullScrollback).toHaveBeenCalledTimes(1); // >=1000ms of margin remained
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
