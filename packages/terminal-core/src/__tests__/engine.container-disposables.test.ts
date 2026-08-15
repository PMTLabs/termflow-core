/**
 * engine.container-disposables.test.ts
 *
 * design/012 D6 + §5.5 + §5.8 — §13 T3, T4, T13 (the mount()-side halves; the
 * relocateTo halves land in Task 7).
 *
 * The split: `disposables` holds everything bound to something that SURVIVES a
 * relocation (the same `boundTerm`, the reused SearchAddon, one-shot mount-time
 * timers). `containerDisposables` holds exactly the four listeners bound to the
 * `container` ARGUMENT: click-to-focus (TerminalEngine.ts:1785-1792),
 * capture-phase zoom keydown (:1804-1831), Ctrl/Cmd+F (:1837-1849) and
 * modifier+wheel (:1854-1864). The ResizeObserver is deliberately NOT one of
 * them (D7) — it has exactly one owner, `this.resizeObserver`.
 *
 * Why the split matters: because the xterm subscriptions are never torn down by
 * relocation, `boundTerm.onResize` (:1101-1120) stays live across the whole
 * operation. That is what retires the orphaned-resize class documented by
 * engine.remount-resize.test.ts:12-20 — a bug that exists precisely because
 * mount() disposes onResize at :742 BEFORE fitting at :749 and re-wires it ~350
 * lines later at :1101.
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
  if (prevRO === undefined) delete (globalThis as any).ResizeObserver;
  else (globalThis as any).ResizeObserver = prevRO;
});

describe('design/012 D6 — the container/local disposables split', () => {
  // §13 T13, first clause. The array must actually be POPULATED — an empty
  // `containerDisposables` is the exact defect review 094 B6 found in rev 4.
  it('puts the four container listeners in containerDisposables and nowhere else', () => {
    const engine = new TerminalEngine(makeFakeBridge(), { cacheKey: 'cd-membership' });
    const localsBefore = (engine as any).disposables.length;
    engine.mount(makeContainer());

    expect((engine as any).containerDisposables.length).toBe(4);
    // The entry mirrors the engine's LIVE array by reference, not by copy —
    // exactly how `disposables: this.disposables` already works (:1753).
    expect(terminalCache.get('cd-membership')!.containerDisposables)
      .toBe((engine as any).containerDisposables);
    // And they are not ALSO in `disposables`, or relocation would tear down the
    // xterm subscriptions with them.
    expect((engine as any).disposables.length).toBeGreaterThan(localsBefore);
    expect((engine as any).disposables)
      .not.toEqual(expect.arrayContaining((engine as any).containerDisposables));
  });

  // §13 T3, mount() half: with paneChrome:true (what mount() always passes)
  // every listener behaves byte-for-byte as it does today.
  it('wires all four listeners on the container mount() was given', () => {
    let openSearchCalls = 0;
    let zoomCalls = 0;
    const engine = new TerminalEngine(makeFakeBridge(), {
      cacheKey: 'cd-wired',
      isMac: false,
      onOpenSearch: () => { openSearchCalls += 1; },
      onZoom: () => { zoomCalls += 1; },
    });
    const container = makeContainer();
    engine.mount(container);
    const term = terminalCache.get('cd-wired')!.terminal as any;

    const focusBefore = term.focusCount;
    container.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(term.focusCount).toBe(focusBefore + 1);

    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }),
    );
    expect(openSearchCalls).toBe(1);

    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: '=', ctrlKey: true, bubbles: true }),
    );
    expect(zoomCalls).toBe(1);

    container.dispatchEvent(
      new WheelEvent('wheel', { deltaY: -1, ctrlKey: true, bubbles: true }),
    );
    expect(zoomCalls).toBe(2);
  });

  // §13 T13, last clause / §5.5 site 4. Without the new dispose line at :742 a
  // remount leaves the PREVIOUS container's four listeners attached to the
  // abandoned node — they would keep focusing a terminal from a dead pane.
  it('disposes the previous mount\'s container listeners on a mount() without unmount()', () => {
    let openSearchCalls = 0;
    const engine = new TerminalEngine(makeFakeBridge(), {
      cacheKey: 'cd-remount',
      isMac: false,
      onOpenSearch: () => { openSearchCalls += 1; },
    });
    const a = makeContainer();
    engine.mount(a);
    const term = terminalCache.get('cd-remount')!.terminal as any;

    const b = makeContainer();
    engine.mount(b);

    const focusBefore = term.focusCount;
    a.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    a.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
    expect(term.focusCount).toBe(focusBefore);
    expect(openSearchCalls).toBe(0);

    // …and the NEW container is fully wired.
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(term.focusCount).toBe(focusBefore + 1);
    expect((engine as any).containerDisposables.length).toBe(4);
  });

  // §13 T13, second clause: unmount() must run BOTH arrays. Before the split it
  // ran one; if it kept running only `disposables` the four listeners would
  // outlive the engine.
  it('runs both arrays on unmount()', () => {
    const engine = new TerminalEngine(makeFakeBridge(), { cacheKey: 'cd-unmount' });
    const container = makeContainer();
    engine.mount(container);
    const term = terminalCache.get('cd-unmount')!.terminal as any;

    engine.unmount();
    expect((engine as any).containerDisposables).toEqual([]);

    const focusBefore = term.focusCount;
    container.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(term.focusCount).toBe(focusBefore);
  });

  // §13 T4, mount() half / D7: the observer is NOT a containerDisposable. It has
  // exactly one owner and one explicit disconnect, which lifecycle-timers.test.ts
  // :109-148 already pins for the mount()/unmount() paths.
  it('keeps the ResizeObserver out of containerDisposables', () => {
    const engine = new TerminalEngine(makeFakeBridge(), { cacheKey: 'cd-ro' });
    engine.mount(makeContainer());
    expect((engine as any).containerDisposables.length).toBe(4);
    expect((engine as any).resizeObserver).not.toBeNull();
  });
});
