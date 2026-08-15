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

    // THE ASSERTION: a fit is still armed. setSurfaceDisplayed(false) never leaves
    // the engine with none (the FT rule). Under rev 7 the return leg re-arms rather
    // than merely preserving — either way a fit remains, which is what the rule is
    // actually protecting; rev 5's cancel-and-leave-nothing is what it forbids.
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
  // NOTE on the sequencing: this covers the SHORT visit, where the mechanism rev 6's
  // §7.3 named — "the SURVIVING fitTimer", the one R3 armed on the way OUT — has not
  // yet fired. The canvas node's grid is therefore applied SYNCHRONOUSLY here,
  // modelling the canvas host's own ResizeObserver fit landing, so that timer is
  // still pending when the terminal comes home.
  //
  // An earlier revision of this comment called the drained-timer variant
  // "unreachable by design rather than by a bug". That was wrong, and external
  // review 103 finding 1 caught it: draining is what a canvas visit longer than 50ms
  // does, i.e. all of them. T10e directly below is that case, and rev 7's §7.2 row 4a
  // is what makes it pass. Keep BOTH — they exercise different arms of the same rule.
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

  // §13 T10e — external review 103 finding 1. T10d above covers the SHORT visit,
  // where the outbound fitTimer is still pending when the surface comes home. That
  // is the rare case. A real canvas session lasts longer than 50ms, so by the time
  // the user leaves the canvas the outbound timer has long since fired and nulled
  // itself, and there is no "surviving fitTimer" for §7.3 to lean on.
  //
  // Rev 6's §7.2 row 4 recorded and returned here, which left xterm at the CANVAS
  // node's grid — parked in a pane it had never measured — until the tab was next
  // activated. Rev 7 arms the settle fit on that return leg instead (row 4a).
  it('a background pane returning after the outbound fit has already fired still '
    + 'ends at the PANE grid', async () => {
      jest.useFakeTimers();
      const { engine, pane, term, fit, resizeCalls } = await mountAttached('rel-ft-t10e');
      engine.setActive(false);

      const host = makeHost();
      engine.relocateTo(host, { paneChrome: false });
      fit.setNextFit(200, 50);                  // the canvas node's grid
      await jest.runAllTimersAsync();           // the outbound fit fires AND NULLS
      expect(term.cols).toBe(200);
      expect((engine as any).fitTimer).toBeNull();   // nothing survives to fill the gap
      // While displayed on canvas the terminal IS eligible, so the node's grid
      // reaches the PTY — §6.1's normal case, not a park.
      expect(resizeCalls).toEqual([[200, 50]]);
      resizeCalls.length = 0;

      // Home again, with NO tab activation anywhere in this test.
      fit.setNextFit(80, 24);                   // what the pane measures
      engine.relocateTo(pane, { paneChrome: true });
      await jest.runAllTimersAsync();

      expect(term.cols).toBe(80);
      // …and the PARK invariant still holds: the pane is hidden, so the PTY is NOT
      // SIGWINCH'd. The pane-sized resize is parked for the next activation.
      expect(resizeCalls).toEqual([]);
      expect((engine as any).pendingResize).not.toBeNull();

      engine.setActive(true);
      await jest.runAllTimersAsync();
      expect(resizeCalls).toEqual([[80, 24]]);
    });

  // §13 T10f — external review 105 (the CRITICAL). T10e's return-leg fit creates a
  // parked pendingResize where rev 6 created none, and unmount()'s force bypass sent
  // it to the still-hidden PTY. That is the one SIGWINCH §6.2 exists to prevent, and
  // it is worse than an ordinary one: the ED3 detector that repairs a ESC[2J ESC[3J
  // wipe is a per-mount disposable, disposed immediately after the flush, while the
  // subscription that receives the wipe is cache-lifetime. So the answer lands with
  // nothing armed to repair it.
  //
  // The fix keys on the VALUE's provenance, not the engine's state at teardown —
  // the engine is ineligible at teardown in the shipped force case too.
  it('unmount does NOT force a resize that was measured while the pane was ineligible',
    async () => {
      jest.useFakeTimers();
      const { engine, pane, term, fit, resizeCalls } = await mountAttached('rel-ft-t10f');
      engine.setActive(false);

      const host = makeHost();
      engine.relocateTo(host, { paneChrome: false });
      fit.setNextFit(200, 50);
      await jest.runAllTimersAsync();
      resizeCalls.length = 0;

      // Home again, still hidden. The return-leg fit parks the pane's grid.
      fit.setNextFit(80, 24);
      engine.relocateTo(pane, { paneChrome: true });
      await jest.runAllTimersAsync();
      expect(term.cols).toBe(80);
      expect((engine as any).pendingResize).not.toBeNull();
      expect(resizeCalls).toEqual([]);

      // Teardown BEFORE any activation — a pane collapse, an in-place terminalId
      // swap, a tab close.
      engine.unmount();
      await jest.runAllTimersAsync();

      // THE ASSERTION: nothing reached the PTY.
      expect(resizeCalls).toEqual([]);

      // …and the geometry is DROPPED, not LOST. That distinction is the whole
      // justification for suppressing the force flush, so assert it rather than
      // asserting the drop alone: a new mount on the same cache key reattaches,
      // re-measures the same pane, and delivers the size — this time with the
      // per-mount ED3 detector armed to repair a ratatui/codex wipe.
      const engine2 = new TerminalEngine(
        makeFakeBridge({ resize: (_pid, c, r) => { resizeCalls.push([c, r]); } }),
        { cacheKey: 'rel-ft-t10f', isMac: false },
      );
      fit.setNextFit(80, 24);
      engine2.mount(pane);
      engine2.attach('pid-1');
      engine2.setActive(true);
      await jest.runAllTimersAsync();

      expect(resizeCalls).toEqual([[80, 24]]);
    });

  // The other half of that rule, so the fix cannot be "solved" by disabling the force
  // bypass altogether. This is the SHIPPED case the pane-collapse fix depends on:
  // the value was measured while the pane was VISIBLE and merely interrupted
  // mid-debounce by the hide + teardown. Teardown must still deliver it.
  it('unmount DOES still force a resize that was measured while the pane was visible',
    async () => {
      jest.useFakeTimers();
      const { engine, fit, resizeCalls } = await mountAttached('rel-ft-t10f-visible');

      fit.setNextFit(170, 40);
      fit.fit();                       // measured while ACTIVE and eligible
      jest.advanceTimersByTime(20);    // not yet past the 120ms debounce
      engine.setActive(false);
      engine.unmount();
      await jest.runAllTimersAsync();

      expect(resizeCalls).toEqual([[170, 40]]);
    });
});
