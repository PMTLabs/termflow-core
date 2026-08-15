/**
 * engine.relocate-side-effects.test.ts
 *
 * design/012 §5.2 (R1), §5.9 (R8), §5.10 (R9), §5.11 (R10), §5.12 (R11) —
 * §13 T5, T6 (call-site half), T7(a), T12, T17e (relocation half), T22a.
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

function makeHost(width = 800, height = 600): { wrapper: HTMLElement; display: HTMLElement } {
  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-display-wrapper';
  const display = document.createElement('div');
  display.className = 'terminal-display';
  Object.defineProperty(display, 'offsetWidth', { value: width, configurable: true });
  Object.defineProperty(display, 'offsetHeight', { value: height, configurable: true });
  Object.defineProperty(display, 'offsetParent', { value: document.body, configurable: true });
  wrapper.appendChild(display);
  document.body.appendChild(wrapper);
  return { wrapper, display };
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

function mounted(cacheKey: string, opts: Record<string, unknown> = {}) {
  const engine = new TerminalEngine(makeFakeBridge(), { cacheKey, isMac: false, ...opts });
  const pane = makeHost();
  engine.mount(pane.display);
  const entry = terminalCache.get(cacheKey)!;
  return { engine, pane, entry, term: entry.terminal as any };
}

/** Drive the engine's real tracker path to produce ONE closed ended region:
 *  prompt (opens a span) -> a program ran -> prompt (closes it). Prompts arrive
 *  through the OSC 7 handler the engine registers at TerminalEngine.ts:1236,
 *  which calls endedRegions.onPrompt() at :1208. */
function plantRegion(engine: TerminalEngine, term: any, height = 5): void {
  engine.setEndedRegionColors('#2a2a2a', '#7aa2f7');
  term.__setCursorLine(0);
  term.oscHandlers[7]('');
  engine.markProgramActive();
  term.__setCursorLine(height);
  term.oscHandlers[7]('');
}

describe('design/012 §5.9 R8 — the ended-region rail follows the terminal', () => {
  // §13 T5. The CONTRAST with Task 1's characterization test: mount() constructs a
  // second tracker and strands the first; relocateTo constructs none.
  it('reuses the SAME tracker — no second instance, no extra onRender subscription', () => {
    const { engine, term } = mounted('rse-t5');
    plantRegion(engine, term);
    const trackerBefore = (engine as any).endedRegions;
    const subsBefore = term.renderCallbacks.length;
    const regionsBefore = trackerBefore.regionCount();

    const host = makeHost();
    expect(engine.relocateTo(host.display, { paneChrome: false })).toBe('relocated');

    expect((engine as any).endedRegions).toBe(trackerBefore);
    expect(term.renderCallbacks.length).toBe(subsBefore);
    expect(trackerBefore.regionCount()).toBe(regionsBefore);
  });

  // §13 T6, call-site half: the SAME .ended-rail-layer node ends up in the NEW
  // wrapper. Ordering is load-bearing — R8 must run AFTER R6, because wrapper
  // resolution walks UP from term.element.
  it('moves the same rail-layer node into the new wrapper', () => {
    const { engine, pane, term } = mounted('rse-t6');
    plantRegion(engine, term);

    const layer = pane.wrapper.querySelector('.ended-rail-layer');
    expect(layer).not.toBeNull();

    const host = makeHost();
    expect(engine.relocateTo(host.display, { paneChrome: false })).toBe('relocated');

    expect(host.wrapper.querySelector('.ended-rail-layer')).toBe(layer);
    expect(pane.wrapper.querySelector('.ended-rail-layer')).toBeNull();
  });
});

describe('design/012 §5.2 / §5.10 R1+R9 — focus is restored only if it was owned', () => {
  // §13 T12, first clause. Spike 004 Q3 measured that the blur is SYNCHRONOUS and
  // part of the move, and that a same-task .focus() restores activeElement before
  // any paint with exactly one focus/focusin pair.
  it('re-focuses the terminal when it owned focus, within the same call', () => {
    const { engine, term } = mounted('rse-t12-owned');
    // Model "focus lives inside term.element" the way real xterm does — its helper
    // textarea is a descendant of the element being moved.
    const textarea = document.createElement('textarea');
    term.element!.appendChild(textarea);
    textarea.focus();
    expect(term.element!.contains(document.activeElement)).toBe(true);

    const focusBefore = term.focusCount;
    const host = makeHost();
    expect(engine.relocateTo(host.display, { paneChrome: false })).toBe('relocated');

    expect(term.focusCount).toBe(focusBefore + 1);
  });

  // §13 T12, second clause. A background pane relocated onto canvas must not steal
  // focus — which is exactly what mount()'s autoFocus path (:1869-1871) would do,
  // and why §5.0 forbids THAT.
  it('does not focus a terminal that did not own focus', () => {
    const { engine, term } = mounted('rse-t12-unowned');
    const elsewhere = document.createElement('input');
    document.body.appendChild(elsewhere);
    elsewhere.focus();

    const focusBefore = term.focusCount;
    const host = makeHost();
    expect(engine.relocateTo(host.display, { paneChrome: false })).toBe('relocated');

    expect(term.focusCount).toBe(focusBefore);
    expect(document.activeElement).toBe(elsewhere);
  });
});

describe('design/012 §5.11 R10 — the suggest gate flips with the chrome mode', () => {
  // §13 T17e, relocation half.
  it('closes the popup state and stops emitting on the way out', () => {
    const emitted: string[] = [];
    const { engine } = mounted('rse-r10-out', {
      onInputLineChanged: (t: string) => emitted.push(t),
    });
    engine.setSuggestPopupState('passive');
    expect((engine as any).suggestState).toBe('passive');

    const host = makeHost();
    expect(engine.relocateTo(host.display, { paneChrome: false })).toBe('relocated');

    expect((engine as any).paneChromeActive).toBe(false);
    expect((engine as any).suggestState).toBe('closed');
    (engine as any).emitInputLine('git st');
    expect(emitted).toEqual([]);
  });

  // The dedup at :2930 must not swallow the first line after the return trip, so
  // R10 resets lastEmittedInput UNCONDITIONALLY — in both directions.
  it('resets the emit dedup so the first line after the return trip is not swallowed', () => {
    const emitted: string[] = [];
    const { engine, pane } = mounted('rse-r10-back', {
      onInputLineChanged: (t: string) => emitted.push(t),
    });
    (engine as any).emitInputLine('git status');
    expect(emitted).toEqual(['git status']);

    const host = makeHost();
    engine.relocateTo(host.display, { paneChrome: false });
    engine.relocateTo(pane.display, { paneChrome: true });

    expect((engine as any).paneChromeActive).toBe(true);
    expect((engine as any).lastEmittedInput).toBe('');
    (engine as any).emitInputLine('git status');
    expect(emitted).toEqual(['git status', 'git status']);
  });
});

describe('design/012 §5.12 R11 — the capture instance is reused outright', () => {
  // §13 T7(a). HeuristicCapture holds `private mark` and a `readonly term`
  // (commandCapture.ts:58-65) — ZERO DOM references, no listeners, no timers.
  // Nothing binds it to a container, so an unchanged-geometry relocation preserves
  // both the instance and its mark. (The geometry-CHANGING case, where the live
  // onResize handler cancels the mark, is Task 10's T7(b).)
  it('preserves the capture instance and its mark across a relocation', () => {
    const { engine, term } = mounted('rse-r11');
    term.__setCursor(4, 0);
    (engine as any).capture.noteUserKey();
    const captureBefore = (engine as any).capture;
    const markBefore = captureBefore.getMark();
    expect(markBefore).not.toBeNull();

    const host = makeHost();
    expect(engine.relocateTo(host.display, { paneChrome: false })).toBe('relocated');

    expect((engine as any).capture).toBe(captureBefore);
    expect((engine as any).capture.getMark()).toEqual(markBefore);
  });
});

describe('design/012 D19 / H14 — §13 T22a: why the pointer gate is necessary', () => {
  /**
   * The half of T22 that IS implementable. jsdom has no layout engine and no hit
   * testing, so `pointer-events: none` cannot be asserted here at all — that half
   * stays the manual gate §13 already lists (plan ground-truth correction G3).
   *
   * What this test proves instead is the NON-CIRCULAR claim D19 rests on: xterm
   * binds its own "always on" mousedown to term.element itself
   * (CoreBrowserTerminal.ts:602-604 bindMouse / :779-781 `ev.preventDefault();
   * this.focus();`), that listener TRAVELS WITH THE ELEMENT, and relocateTo cannot
   * touch it. So declining to wire the ENGINE's container click listener removes
   * only the 4px-padding supplement — it does NOT deliver design 012 §8's
   * "click-to-focus: Absent" row. Only the host's pointer gate can, and that gate
   * lives in design/010 (§12).
   *
   * terminal-core's xterm mock does not reproduce bindMouse, so the listener is
   * installed explicitly and labelled as a model of it.
   */
  it('cannot remove a listener bound to term.element, even with paneChrome false', () => {
    const { engine, term } = mounted('rse-t22a');
    let elementMouseDowns = 0;
    // MODELS @xterm/xterm CoreBrowserTerminal.ts:779-781, which the mock omits.
    term.element!.addEventListener('mousedown', () => {
      elementMouseDowns += 1;
      term.focus();
    });

    const host = makeHost();
    expect(engine.relocateTo(host.display, { paneChrome: false })).toBe('relocated');

    const focusBefore = term.focusCount;
    term.element!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(elementMouseDowns).toBe(1);
    expect(term.focusCount).toBe(focusBefore + 1);
    // …while the engine's OWN container listener is correctly absent.
    host.display.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(term.focusCount).toBe(focusBefore + 1);
  });
});
