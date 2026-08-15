/**
 * engine.relocate-eligibility.test.ts
 *
 * design/012 §5.4 (R3), §5.3 (the FT rule + the PARK invariant), §7.3 —
 * §13 T2d, T10(b), T10c, T10d.
 *
 * T2d is the highest-priority regression in the whole list: an aborted outbound
 * relocation must leave geometryEligible() EXACTLY as it was, because the
 * alternative is a permanently disabled hidden-pane SIGWINCH park and a wiped
 * codex scrollback.
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

let prevRO: unknown;

beforeEach(() => {
  terminalCache.clear();
  TerminalEngine.suppressHealUntil = 0;
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
  TerminalEngine.suppressHealUntil = 0;
  if (prevRO === undefined) delete (globalThis as any).ResizeObserver;
  else (globalThis as any).ResizeObserver = prevRO;
});

async function mountAttached(cacheKey: string) {
  const resizeCalls: Array<[number, number]> = [];
  const engine = new TerminalEngine(
    makeFakeBridge({ resize: (_pid, c, r) => { resizeCalls.push([c, r]); } }),
    { cacheKey, isMac: false },
  );
  const pane = makeHost();
  engine.mount(pane);
  engine.attach('pid-1');
  await jest.runAllTimersAsync();
  const entry = terminalCache.get(cacheKey)!;
  resizeCalls.length = 0;
  return {
    engine, pane, entry,
    term: entry.terminal as any,
    fit: entry.fitAddon as any,
    resizeCalls,
  };
}

describe('design/012 §5.4 R3 — eligibility lives INSIDE relocateTo', () => {
  it('raises eligibility on the way out and lowers it on the way home', async () => {
    jest.useFakeTimers();
    const { engine, pane } = await mountAttached('rel-elig-basic');
    engine.setActive(false);
    expect((engine as any).surfaceDisplayed).toBe(false);

    const host = makeHost();
    engine.relocateTo(host, { paneChrome: false });
    expect((engine as any).surfaceDisplayed).toBe(true);
    expect((engine as any).geometryEligible()).toBe(true);

    engine.relocateTo(pane, { paneChrome: true });
    expect((engine as any).surfaceDisplayed).toBe(false);
    expect((engine as any).geometryEligible()).toBe(false);
  });

  // §13 T2d — reviews 093 B2 / 094 B4. An aborted outbound relocation must leave
  // the ED3 guard intact, and it does so because the GATE is restored, not because
  // any fit is cancelled.
  it('leaves geometryEligible() exactly as it was after an abort, and a hidden pane '
    + 'still parks', async () => {
    jest.useFakeTimers();
    const { engine, term, fit, resizeCalls } = await mountAttached('rel-elig-abort');
    engine.setActive(false);
    expect((engine as any).geometryEligible()).toBe(false);

    // Force R6 to throw: a host that is a descendant of the moved element.
    const illegal = document.createElement('div');
    term.element!.appendChild(illegal);
    expect(engine.relocateTo(illegal, { paneChrome: false })).toBe('aborted');

    expect((engine as any).surfaceDisplayed).toBe(false);
    expect((engine as any).geometryEligible()).toBe(false);

    // …and the park is still armed: zero bridge.resize calls on a hidden pane.
    fit.setNextFit(160, 24);
    fit.fit();
    await jest.runAllTimersAsync();
    expect(resizeCalls).toEqual([]);
  });

  // §13 T10(b) / H3's regression test. A resize parked while hidden is delivered
  // when the terminal is displayed on canvas, including when the relocation lands
  // inside the 50ms fitTimer window.
  it('delivers a resize parked while hidden once the surface is displayed on canvas',
    async () => {
      jest.useFakeTimers();
      const { engine, term, fit, resizeCalls } = await mountAttached('rel-elig-parked');

      engine.setActive(false);
      fit.setNextFit(160, 24);
      fit.fit();                        // xterm resizes; the backend resize parks
      await jest.runAllTimersAsync();
      expect(term.cols).toBe(160);
      expect(resizeCalls).toEqual([]);  // parked: pendingResize set, no timer

      const host = makeHost();
      engine.relocateTo(host, { paneChrome: false });
      await jest.runAllTimersAsync();   // R3's 50ms armActivationFit + 120ms debounce

      expect(resizeCalls).toEqual([[160, 24]]);
    });
});

describe('design/012 §5.3 — the FT rule and the PARK invariant under relocation', () => {
  // §13 T10c — review 099 T1-F1's counterexample, verbatim, as a regression test.
  // Fails against rev 5, which cancelled fitTimer in setSurfaceDisplayed(false).
  it('rapid canvas-enter/canvas-exit on an inactive pane keeps the armed fit', async () => {
    jest.useFakeTimers();
    const { engine, pane, fit, resizeCalls } = await mountAttached('rel-ft-t10c');

    // The parked state flushBackendResize leaves at :2584-2589: pendingResize set,
    // resizeTimer null.
    engine.setActive(false);
    fit.setNextFit(160, 24);
    fit.fit();
    await jest.runAllTimersAsync();
    expect((engine as any).pendingResize).not.toBeNull();
    expect((engine as any).resizeTimer).toBeNull();
    expect(resizeCalls).toEqual([]);

    const host = makeHost();
    engine.relocateTo(host, { paneChrome: false });   // R3 arms the 50ms fit
    expect((engine as any).fitTimer).not.toBeNull();

    // …and exit again INSIDE those 50ms.
    engine.relocateTo(pane, { paneChrome: true });

    // THE ASSERTION: the timer is still armed. setSurfaceDisplayed(false) did not
    // cancel it, in either direction (the FT rule).
    expect((engine as any).fitTimer).not.toBeNull();

    const fitsBefore = fit.fitCount;
    await jest.runAllTimersAsync();
    // It fired and measured the PANE…
    expect(fit.fitCount).toBeGreaterThan(fitsBefore);
    // …flushDeferredResizeOnActivation early-returned on geometryEligible()…
    expect(resizeCalls).toEqual([]);
    // …so the parked value is still there (the PARK invariant: a designed state,
    // not a strand).
    expect((engine as any).pendingResize).not.toBeNull();

    // And the next eligibility transition delivers exactly one resize.
    engine.setActive(true);
    await jest.runAllTimersAsync();
    expect(resizeCalls).toEqual([[160, 24]]);
  });

  // §13 T10d — the observable consequence of T10c, and the reason not-cancelling is
  // BETTER rather than merely safe. Cancelling leaves xterm at the canvas node's
  // grid while parked in the pane, until the tab is next activated.
  //
  // NOTE on the sequencing, which differs from plan 015 Task 9's draft: the
  // mechanism §7.3 names is "the SURVIVING fitTimer" — the one R3 armed on the way
  // OUT, which has NOT yet fired. The draft drained all timers between the two
  // legs, which fires and nulls exactly that timer; the return leg then arms
  // nothing (§7.2 row 4 records and returns), so no fit remains and the scenario
  // is unreachable by design rather than by a bug. The canvas node's grid is
  // therefore applied SYNCHRONOUSLY here — modelling the canvas host's own
  // ResizeObserver fit landing — so the outbound fitTimer is still pending when the
  // terminal comes home, which is precisely the state §7.3 describes.
  it('a background pane returning from a differently sized node ends at the PANE grid',
    async () => {
      jest.useFakeTimers();
      const { engine, pane, term, fit } = await mountAttached('rel-ft-t10d');
      engine.setActive(false);

      const host = makeHost();
      engine.relocateTo(host, { paneChrome: false });   // R3 arms the 50ms fit
      expect((engine as any).fitTimer).not.toBeNull();

      // The canvas node's own observer fit lands first, taking xterm to the NODE's
      // grid, while the fit R3 armed is still pending.
      fit.setNextFit(200, 50);                  // the canvas node's grid
      fit.fit();
      expect(term.cols).toBe(200);

      // Home again, with NO tab activation anywhere in this test.
      fit.setNextFit(80, 24);                   // what the pane measures
      engine.relocateTo(pane, { paneChrome: true });
      expect((engine as any).fitTimer).not.toBeNull();
      await jest.runAllTimersAsync();

      expect(term.cols).toBe(80);
    });
});
