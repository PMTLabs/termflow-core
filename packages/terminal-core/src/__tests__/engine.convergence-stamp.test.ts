/**
 * engine.convergence-stamp.test.ts
 *
 * design/012 §6.2 / hazard H2 — the groundwork half of §13 T8d and T8e.
 * (The relocation-driven halves land in Task 10, once relocateTo exists to arm
 * the window; this task pins the ARM/CONSUME machinery on its own.)
 *
 * The stamp is ARMED, not unconditional, on purpose. The code's own comment at
 * TerminalEngine.ts:2386-2388 explains why stamping unconditionally is avoided:
 * a reactivation that resizes nothing would otherwise misattribute an unrelated
 * `clear` days later. The armed form keeps that property exactly — an
 * unchanged-geometry relocation produces no resize at all, so it never stamps.
 */

import { TerminalEngine } from '../TerminalEngine';
import { terminalCache } from '../cache';
import type { TerminalBridge, Disposable } from '../types';

function makeFakeBridge(
  onResize?: (processId: string, cols: number, rows: number) => void,
): TerminalBridge {
  const noopDisposable: Disposable = { dispose() {} };
  return {
    onData: () => noopDisposable,
    onExit: () => noopDisposable,
    write: () => {},
    resize: onResize ?? (() => {}),
  };
}

function makeContainer(width = 800, height = 600): HTMLElement {
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

let prevRO: unknown;

beforeEach(() => {
  terminalCache.clear();
  prevRO = (globalThis as any).ResizeObserver;
  (globalThis as any).ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  };
});

afterEach(() => {
  terminalCache.clear();
  document.body.innerHTML = '';
  jest.useRealTimers();
  if (prevRO === undefined) delete (globalThis as any).ResizeObserver;
  else (globalThis as any).ResizeObserver = prevRO;
});

describe('design/012 §6.2 — the armed convergence stamp', () => {
  it('does not stamp when nothing armed it', () => {
    const engine = new TerminalEngine(makeFakeBridge(), { cacheKey: 'cs-unarmed' });
    engine.mount(makeContainer());
    const entry = terminalCache.get('cs-unarmed')!;
    entry.convergenceResizeAt = undefined;

    (engine as any).scheduleBackendResize(100, 30);

    expect(entry.convergenceResizeAt).toBeUndefined();
  });

  it('stamps a debounced resize that lands inside the arm window', () => {
    const engine = new TerminalEngine(makeFakeBridge(), { cacheKey: 'cs-armed' });
    engine.mount(makeContainer());
    const entry = terminalCache.get('cs-armed')!;
    entry.convergenceResizeAt = undefined;

    (engine as any).convergenceArmUntil = Date.now() + 500;
    (engine as any).scheduleBackendResize(100, 30);

    expect(typeof entry.convergenceResizeAt).toBe('number');
  });

  // §13 T8e, first clause: the arm is consumed ONCE. A hydrate() landing early in
  // the window consumes it, so the relocation's own scheduleBackendResize does not
  // re-stamp — harmless (the relocation resize lands at most ~620ms later: 500ms
  // arm + BACKEND_RESIZE_DEBOUNCE_MS 120, comfortably inside ED3_EXPECT_WINDOW_MS
  // 1500), but "consumes it once" must be asserted rather than assumed.
  it('consumes the arm exactly once', () => {
    const engine = new TerminalEngine(makeFakeBridge(), { cacheKey: 'cs-once' });
    engine.mount(makeContainer());
    const entry = terminalCache.get('cs-once')!;

    (engine as any).convergenceArmUntil = Date.now() + 500;
    (engine as any).scheduleBackendResize(100, 30);
    const first = entry.convergenceResizeAt as number;
    expect(typeof first).toBe('number');
    expect((engine as any).convergenceArmUntil).toBe(0);

    entry.convergenceResizeAt = undefined;
    (engine as any).scheduleBackendResize(101, 30);
    expect(entry.convergenceResizeAt).toBeUndefined();
  });

  it('does not stamp once the arm window has expired', () => {
    const engine = new TerminalEngine(makeFakeBridge(), { cacheKey: 'cs-expired' });
    engine.mount(makeContainer());
    const entry = terminalCache.get('cs-expired')!;
    entry.convergenceResizeAt = undefined;

    (engine as any).convergenceArmUntil = Date.now() - 1;
    (engine as any).scheduleBackendResize(100, 30);

    expect(entry.convergenceResizeAt).toBeUndefined();
  });

  // §13 T8e, second clause / review 093 B5: hydrate()'s pre-hydration resize
  // (:2181) is the ONE direct sender that bypasses scheduleBackendResize. A
  // relocation landing while an earlier attach()'s hydration is still awaiting
  // would otherwise SIGWINCH the PTY inside the arm window with no stamp.
  it('stamps from hydrate()\'s direct pre-hydration resize too', async () => {
    jest.useFakeTimers();
    const engine = new TerminalEngine(
      makeFakeBridge(),
      { cacheKey: 'cs-hydrate' },
    );
    engine.mount(makeContainer());
    const entry = terminalCache.get('cs-hydrate')!;
    entry.convergenceResizeAt = undefined;

    // Arm, then let attach() drive hydrate() -> :2181 bridge.resize -> :2183.
    (engine as any).convergenceArmUntil = Date.now() + 500;
    engine.attach('pid-hydrate');
    await jest.runAllTimersAsync();

    expect(typeof entry.convergenceResizeAt).toBe('number');
    expect((engine as any).convergenceArmUntil).toBe(0);
  });

  // The refactor is behaviour-preserving: flushDeferredResizeOnActivation still
  // stamps at BOTH of its existing sites (:2399 and :2407), unconditionally,
  // independent of the arm. Rev 4 wrote "its existing site", singular; review 093
  // is right that there are two (design 012 correction 0.3.1).
  it('keeps flushDeferredResizeOnActivation stamping at both of its sites', async () => {
    // attach() kicks off hydrate()'s pre-hydration resize (:2295) WITHOUT the
    // test awaiting it, which leaves resizeInFlight true and would otherwise
    // mask the assertions below behind flushDeferredResizeOnActivation's own
    // `|| this.resizeInFlight) return;` guard (:2553) — a guard this test does
    // not intend to exercise. Fake timers + runAllTimersAsync let that
    // in-flight hydration settle first, exactly as the hydrate test above does.
    jest.useFakeTimers();

    // Site A: a pending resize exists (parked at deactivation, timer cleared).
    const a = new TerminalEngine(makeFakeBridge(), { cacheKey: 'cs-site-a' });
    a.mount(makeContainer());
    a.attach('pid-a');
    await jest.runAllTimersAsync();
    const entryA = terminalCache.get('cs-site-a')!;
    entryA.convergenceResizeAt = undefined;
    (a as any).convergenceArmUntil = 0;          // the arm plays no part here
    (a as any).pendingResize = { cols: 120, rows: 40 };
    (a as any).flushDeferredResizeOnActivation();
    expect(typeof entryA.convergenceResizeAt).toBe('number');

    // Site B: nothing pending, but lastSentSize disagrees with xterm.
    const b = new TerminalEngine(makeFakeBridge(), { cacheKey: 'cs-site-b' });
    b.mount(makeContainer());
    b.attach('pid-b');
    await jest.runAllTimersAsync();
    const entryB = terminalCache.get('cs-site-b')!;
    entryB.convergenceResizeAt = undefined;
    (b as any).convergenceArmUntil = 0;
    (b as any).pendingResize = null;
    entryB.lastSentSize = { cols: 1, rows: 1 };
    (b as any).flushDeferredResizeOnActivation();
    expect(typeof entryB.convergenceResizeAt).toBe('number');
  });
});
