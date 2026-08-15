/**
 * engine.surface-displayed.test.ts
 *
 * design/012 §7 (gates AND transitions) + §5.3's FT rule — §13 T10(a), T11.
 *
 * `paneActive` means "the owning TAB is visible" (TerminalDisplay.tsx:207,
 * :374-376) — it is NOT focus. A canvas-displayed terminal from a BACKGROUND tab
 * has paneActive === false but is genuinely visible, so all six geometry gates
 * must run. `geometryEligible()` is `paneActive || surfaceDisplayed`.
 *
 * Gates alone are insufficient: setActive is not just a setter. setActive(false)
 * cancels fitTimer and returns without flushing (:2345-2350), and only
 * setActive(true) arms the 50ms settle fit that then calls
 * flushDeferredResizeOnActivation() (:2356-2369). Without an equivalent, a resize
 * parked while the tab was hidden stays parked forever when the terminal becomes
 * visible only through canvas.
 */

import { TerminalEngine } from '../TerminalEngine';
import { terminalCache } from '../cache';
import type { TerminalBridge, Disposable } from '../types';

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

describe('design/012 §7 — surfaceDisplayed gates every geometry path paneActive gated', () => {
  // §13 T10(a), gates. A hidden tab whose terminal is displayed on canvas must do
  // ALL its geometry work: observer fit, xterm resize, and the PTY SIGWINCH.
  it('runs the observer fit and the backend resize on a hidden pane that is surface-displayed',
    async () => {
      jest.useFakeTimers();
      const { engine, term, fit, resizeCalls } = await mountAttached('sd-gates');

      engine.setActive(false);            // the owning TAB goes to the background
      engine.setSurfaceDisplayed(true);   // …but the surface is live on a canvas node
      fit.setNextFit(160, 24);
      fireResizeObserver();
      await jest.runAllTimersAsync();

      expect(term.cols).toBe(160);
      expect(resizeCalls).toEqual([[160, 24]]);
    });

  // The mirror image, unchanged from today: hidden AND not surface-displayed
  // still parks. This is the ED3 scrollback-wipe guard; it must not regress.
  it('still parks a hidden pane that is NOT surface-displayed', async () => {
    jest.useFakeTimers();
    const { engine, term, fit, resizeCalls } = await mountAttached('sd-park');

    engine.setActive(false);
    fit.setNextFit(160, 24);
    fireResizeObserver();
    await jest.runAllTimersAsync();

    expect(term.cols).toBe(80);
    expect(resizeCalls).toEqual([]);
  });

  // §12 §7.2 row 2: a false->true eligibility transition arms the SAME 50ms
  // settle fit setActive(true) arms, so a resize parked while hidden is delivered
  // when the terminal becomes visible ONLY through canvas.
  it('flushes a parked resize when the surface becomes displayed', async () => {
    jest.useFakeTimers();
    const { engine, term, fit, resizeCalls } = await mountAttached('sd-flush');

    engine.setActive(false);
    fit.setNextFit(160, 24);
    fireResizeObserver();
    await jest.runAllTimersAsync();
    expect(resizeCalls).toEqual([]);          // parked

    engine.setSurfaceDisplayed(true);
    await jest.runAllTimersAsync();           // 50ms settle fit + 120ms debounce

    expect(term.cols).toBe(160);
    expect(resizeCalls).toEqual([[160, 24]]);
  });

  // §7.2 row 1: already eligible => record and return. A second settle fit is churn.
  it('does not arm a second settle fit when the pane was already eligible', async () => {
    jest.useFakeTimers();
    const { engine, fit } = await mountAttached('sd-idempotent');

    engine.setActive(true);
    await jest.runAllTimersAsync();
    const before = fit.fitCount;

    engine.setSurfaceDisplayed(true);
    await jest.runAllTimersAsync();

    expect(fit.fitCount).toBe(before);
  });

  // §7.2 row 5 / the FT rule: hiding the TAB must not kill the canvas's settle fit.
  it('setActive(false) does NOT cancel fitTimer while surface-displayed', async () => {
    jest.useFakeTimers();
    const { engine, fit } = await mountAttached('sd-ft-keep');

    engine.setActive(false);
    engine.setSurfaceDisplayed(true);   // arms the 50ms fit (false->true transition)
    expect((engine as any).fitTimer).not.toBeNull();

    engine.setActive(false);            // tab hidden again — must NOT cancel
    expect((engine as any).fitTimer).not.toBeNull();

    const before = fit.fitCount;
    await jest.runAllTimersAsync();
    expect(fit.fitCount).toBeGreaterThan(before);
  });

  // §7.2 row 6 / the FT rule: THE ONE CANCEL. Unchanged shipped behaviour, with
  // its own stated reason at TerminalEngine.ts:2343-2344 — an activation fit
  // scheduled 50ms before a quick tab switch away must not resize a hidden pane.
  it('setActive(false) DOES cancel fitTimer when not surface-displayed', async () => {
    jest.useFakeTimers();
    const { engine } = await mountAttached('sd-ft-cancel');

    engine.setActive(true);
    expect((engine as any).fitTimer).not.toBeNull();

    engine.setActive(false);
    expect((engine as any).fitTimer).toBeNull();
  });

  // §7.2 rows 3 AND 4 / the FT rule: setSurfaceDisplayed(false) never cancels, in
  // either direction. Rev 5 cancelled in row 4 "to mirror setActive(false)", which
  // contradicted D10 outright (review 099 T1-F1 + 098 B1, found independently).
  // The FT rule as rev 7 states it: a property of the END STATE, not a prohibition
  // on clearTimeout. setSurfaceDisplayed(false) must never leave the engine with no
  // pending fit — by preserving one (visible pane) or by arming a fresh one
  // (background pane, §7.2 row 4a). Rev 6 phrased this as "never cancels", which a
  // bare record-and-return satisfies while producing exactly the state the rule
  // forbids; that phrasing is what let review 103 finding 1 through.
  it('setSurfaceDisplayed(false) always leaves a fit pending, visible tab or not', async () => {
    jest.useFakeTimers();

    const visible = await mountAttached('sd-ft-nocancel-visible');
    visible.engine.setActive(true);
    expect((visible.engine as any).fitTimer).not.toBeNull();
    visible.engine.setSurfaceDisplayed(false);
    expect((visible.engine as any).fitTimer).not.toBeNull();

    const hidden = await mountAttached('sd-ft-nocancel-hidden');
    hidden.engine.setActive(false);
    hidden.engine.setSurfaceDisplayed(true);       // arms the fit
    expect((hidden.engine as any).fitTimer).not.toBeNull();
    hidden.engine.setSurfaceDisplayed(false);      // paneActive false — row 4a re-arms
    expect((hidden.engine as any).fitTimer).not.toBeNull();

    // …and it is still armed after the outbound one would have expired, which is
    // the half rev 6 could not deliver.
    await jest.advanceTimersByTimeAsync(200);
    hidden.engine.setSurfaceDisplayed(true);
    await jest.advanceTimersByTimeAsync(200);
    expect((hidden.engine as any).fitTimer).toBeNull();   // fired and cleared itself
    hidden.engine.setSurfaceDisplayed(false);
    expect((hidden.engine as any).fitTimer).not.toBeNull();
  });
});

describe('design/012 §13 T11 — the paneActive tripwire', () => {
  // A TRIPWIRE, not a correctness test: it asserts a SOURCE-TEXT property so a
  // future edit cannot quietly reintroduce a bare `paneActive` gate at one of the
  // six sites §7.1 enumerates. Reworded per review 096: count gate READS, not
  // total occurrences — the predicate's own declaration and setActive's
  // precondition read are legitimate extra occurrences.
  it('has no bare paneActive gate left at any of the six geometry sites', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path') as typeof import('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'TerminalEngine.ts'),
      'utf8',
    );

    // The six gates now read through the predicate.
    const eligibleReads = (src.match(/this\.geometryEligible\(\)/g) ?? []).length;
    expect(eligibleReads).toBeGreaterThanOrEqual(6);

    // Count gate reads in CODE only. §13 T11 is explicit — "count gate READS, or
    // drop the count" — because a raw substring count over the whole file also
    // counts prose. That version of this test made a doc comment able to fail the
    // suite, and the first thing it did was make someone reword a comment to
    // satisfy a test, which is the tail wagging the dog. Comments are stripped
    // first so the assertion tracks the thing it is actually guarding.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')  // block comments, including JSDoc
      .replace(/(^|[^:])\/\/.*$/gm, '$1'); // line comments, but not the // in a URL
    // `this.paneActive` survives in code ONLY as: the constructor seed, its write
    // in `setActive`, and `geometryEligible()`'s own read. Everything else must
    // have moved to the predicate.
    const paneActiveReads = (code.match(/this\.paneActive/g) ?? []).length;
    expect(paneActiveReads).toBeLessThanOrEqual(4);

    // And specifically: no `!this.paneActive` early-return survives anywhere.
    expect(src).not.toContain('if (!this.paneActive) return');
  });
});

/**
 * External review 103, finding 3 — the two 50ms timers share one slot.
 *
 * `armActivationFit` and `setFontSize` both write `this.fitTimer`, so whichever
 * arms second replaces the first. Before the fix `setFontSize` installed a
 * FIT-ONLY callback, which silently dropped the deferred-resize flush that the
 * activation callback carries — stranding a parked `pendingResize` with no
 * remaining path to deliver it, because `healOnce` also refuses to run while
 * `pendingResize` is set.
 *
 * Reachable only on this branch: §7.1 row 3 widened setFontSize's gate from
 * `paneActive` to `geometryEligible()`, so a canvas-displayed terminal on a
 * BACKGROUND tab now gets past the early return for the first time.
 */
describe('design/012 §7 — setFontSize must not replace the flush-bearing timer', () => {
  it('flushes a resize parked while hidden, even when a font change lands inside the 50ms window',
    async () => {
      jest.useFakeTimers();
      const { engine, resizeCalls, fit } = await mountAttached('ft-fontsize-strand');

      // A background tab: not active, so a resize parks rather than sending.
      engine.setActive(false);
      resizeCalls.length = 0;
      fit.setNextFit(160, 24);
      fit.fit();
      await jest.runAllTimersAsync();
      expect(resizeCalls).toEqual([]);            // parked, as designed

      // Displayed on canvas: eligibility goes false->true and arms the ONLY
      // callback that will flush that parked value.
      engine.setSurfaceDisplayed(true);
      expect((engine as any).fitTimer).not.toBeNull();

      // A font change inside the 50ms window. It re-arms the shared slot.
      engine.setFontSize(15);

      // The parked resize must still be delivered.
      await jest.runAllTimersAsync();
      expect(resizeCalls).toEqual([[160, 24]]);
    });
});
