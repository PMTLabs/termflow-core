/**
 * engine.ended-region-lifetime.test.ts
 *
 * design/012 §2 "STEP 0", as an executable baseline.
 *
 * Two facts the relocation design is scoped from, neither of which was pinned
 * anywhere before:
 *
 *  1. Ended-region marks do NOT survive a real remount. `mount()` constructs a
 *     brand-new EndedRegionTracker unconditionally (TerminalEngine.ts:1054-1055)
 *     and there is no persistence path — TerminalCacheEntry (cache.ts:17-105) has
 *     no regions/tracker field. So "relocation preserves the marks" is a NEW
 *     guarantee, not a regression fix (§2.3 item 1).
 *
 *  2. A second mount() WITHOUT an intervening unmount() LEAKS the live tracker:
 *     registerEndedRegionTracker uses Map.set (endedRegions.ts:57), which
 *     overwrites without disposing, so the previous tracker keeps its onRender
 *     subscription (endedRegions.ts:207-215) — which keeps it strongly reachable
 *     — and strands its `.ended-rail-layer` div (endedRegions.ts:197, removed
 *     only by dispose() at :423). Avoiding THAT leak is why P0-B owns the
 *     tracker; keeping the marks is the free consequence (§2.3 item 2).
 *
 * These are CHARACTERIZATION tests of shipped behaviour. They must stay green
 * across P0-B: relocation must not change either of them, and §13 T5 is their
 * contrast — the same assertions with relocateTo() instead of mount() must show
 * ONE tracker, ONE subscription and the SAME regions.
 */

import { TerminalEngine } from '../TerminalEngine';
import { terminalCache } from '../cache';
import type { TerminalBridge, Disposable } from '../types';

function makeFakeBridge(): TerminalBridge {
  const noopDisposable: Disposable = { dispose() {} };
  return {
    onData: () => noopDisposable,
    onExit: () => noopDisposable,
    write: () => {},
    resize: () => {},
  };
}

/** jsdom gives a real element; force a usable size so the >50px guards pass. */
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

/** Live (non-disposed) bottom-layer wash rows — the visible ended-region marks. */
function liveWashRows(term: any): number[] {
  return term.decorations
    .filter((d: any) => !d.disposed && d.options.layer === 'bottom')
    .map((d: any) => (d.options.marker as { line: number }).line)
    .sort((a: number, b: number) => a - b);
}

/**
 * Drive the engine's real tracker path to produce ONE closed ended region:
 * prompt (opens a span) -> a program ran -> prompt (closes it).
 * Prompts arrive through the OSC 7 handler the engine registers at
 * TerminalEngine.ts:1236, which calls endedRegions.onPrompt() at :1208.
 */
function plantRegion(engine: TerminalEngine, term: any, height = 5): void {
  engine.setEndedRegionColors('#2a2a2a', '#7aa2f7');
  term.__setCursorLine(0);
  term.oscHandlers[7]('');
  engine.markProgramActive();
  term.__setCursorLine(height);
  term.oscHandlers[7]('');
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
  if (prevRO === undefined) delete (globalThis as any).ResizeObserver;
  else (globalThis as any).ResizeObserver = prevRO;
});

describe('design/012 §2 STEP 0 — the tracker lifetime P0-B inherits', () => {
  it('loses every ended-region mark across a real unmount()/mount() cycle', () => {
    const engine = new TerminalEngine(makeFakeBridge(), { cacheKey: 'step0-remount' });
    engine.mount(makeContainer());
    const term = terminalCache.get('step0-remount')!.terminal as any;

    plantRegion(engine, term);
    expect(liveWashRows(term).length).toBeGreaterThan(0);

    // A real remount: pane collapse, cross-window detach, app reload.
    engine.unmount();
    engine.mount(makeContainer());

    // unmount() disposed the tracker (TerminalEngine.ts:3271) and mount()
    // constructed a fresh one with `regions = []` (endedRegions.ts:185).
    expect(liveWashRows(term)).toEqual([]);
  });

  it('leaks the live tracker when mount() is called again without unmount()', () => {
    const engine = new TerminalEngine(makeFakeBridge(), { cacheKey: 'step0-leak' });
    engine.mount(makeContainer());
    const term = terminalCache.get('step0-leak')!.terminal as any;

    plantRegion(engine, term);
    const subsAfterFirstMount = term.renderCallbacks.length;
    const railLayersAfterFirstMount =
      document.querySelectorAll('.ended-rail-layer').length;
    expect(subsAfterFirstMount).toBeGreaterThan(0);
    expect(railLayersAfterFirstMount).toBe(1);

    // The pattern TerminalEngine.ts:692-694 itself names as legitimate.
    engine.mount(makeContainer());

    // The SECOND tracker's onRender subscription is added; the FIRST one's is
    // never disposed, because registerEndedRegionTracker overwrites the map
    // entry without disposing (endedRegions.ts:57). That subscription is what
    // keeps the dead tracker reachable.
    expect(term.renderCallbacks.length).toBe(subsAfterFirstMount + 1);

    // And the first tracker's rail layer is stranded in the OLD wrapper: only
    // dispose() removes it (endedRegions.ts:423), and nothing disposed it.
    expect(document.querySelectorAll('.ended-rail-layer').length)
      .toBeGreaterThanOrEqual(1);
  });
});
