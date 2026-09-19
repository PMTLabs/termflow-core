/**
 * engine.scrollbarArrows.test.ts — the app side of the scrollbar ▲/▼ buttons (plan 046).
 *
 * The patched xterm scrollbar (patches/xterm-scrollbar-arrows-patch.js) dispatches a bubbling
 * `xterm-scrollbar-arrow` event from a node INSIDE term.element; the engine must turn each
 * one into exactly `scrollLines(±1)`, for as long as — and only as long as — the mount lives.
 * The patch side (that the event is emitted, bubbles, and carries ±1) is pinned by
 * patches/__tests__/xterm-scrollbar-arrows-patch.test.ts; the two share the event name.
 */
import { TerminalEngine } from '../TerminalEngine';
import { terminalCache } from '../cache';
import { SCROLLBAR_ARROW_EVENT, wireScrollbarArrows } from '../scrollbarArrows';
import type { TerminalBridge, Disposable } from '../types';
import { Terminal as MockTerminal } from '../__mocks__/xterm';

function makeBridge(): TerminalBridge {
  const noop: Disposable = { dispose() {} };
  return { onData: () => noop, onExit: () => noop, write: () => {}, resize: () => {} };
}

function makeContainer(): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'offsetWidth', { value: 800, configurable: true });
  Object.defineProperty(el, 'offsetHeight', { value: 600, configurable: true });
  document.body.appendChild(el);
  return el;
}

function mockTerm(cacheKey: string): MockTerminal {
  const entry = terminalCache.get(cacheKey);
  if (!entry) throw new Error('no cache entry');
  return entry.terminal as unknown as MockTerminal;
}

/**
 * Fire the event the way the patch does: from a node NESTED inside term.element (the real
 * one comes from `.xterm-scrollable-element > .scrollbar.vertical`), bubbling. Dispatching on
 * term.element itself would pass even if the listener only worked for direct dispatch.
 */
function pressArrow(term: MockTerminal, detail: unknown): void {
  const el = term.element!;
  const scrollbar = document.createElement('div');
  el.appendChild(scrollbar);
  scrollbar.dispatchEvent(new CustomEvent(SCROLLBAR_ARROW_EVENT, { bubbles: true, detail }));
  scrollbar.remove();
}

beforeEach(() => {
  terminalCache.clear();
  if (typeof (global as any).ResizeObserver === 'undefined') {
    (global as any).ResizeObserver = class {
      observe() {}
      disconnect() {}
      unobserve() {}
    };
  }
});
afterEach(() => terminalCache.clear());

test('▲ scrolls one row up and ▼ one row down, through the public scrollLines', () => {
  const engine = new TerminalEngine(makeBridge(), { cacheKey: 'arrows-1' });
  engine.mount(makeContainer());
  const term = mockTerm('arrows-1');
  term.buffer.active.baseY = 100;
  term.buffer.active.viewportY = 100;

  pressArrow(term, -1);
  expect(term.scrollLinesCalls).toEqual([-1]);
  expect(term.buffer.active.viewportY).toBe(99);

  pressArrow(term, 1);
  expect(term.scrollLinesCalls).toEqual([-1, 1]);
  expect(term.buffer.active.viewportY).toBe(100);
});

test('a detail that is not ±1 is ignored — nothing scrolls by a stray amount', () => {
  const engine = new TerminalEngine(makeBridge(), { cacheKey: 'arrows-2' });
  engine.mount(makeContainer());
  const term = mockTerm('arrows-2');

  pressArrow(term, 3);
  pressArrow(term, '-1');
  pressArrow(term, undefined);
  pressArrow(term, { dir: -1 });
  expect(term.scrollLinesCalls).toEqual([]);
});

test('after unmount() the arrows are deaf; a remount from cache hears them again — once', () => {
  const cacheKey = 'arrows-3';
  const bridge = makeBridge();
  const engine1 = new TerminalEngine(bridge, { cacheKey });
  engine1.mount(makeContainer());
  const term = mockTerm(cacheKey);
  pressArrow(term, -1);
  expect(term.scrollLinesCalls).toEqual([-1]);

  // The listener lives in the per-mount disposables, so unmount() must remove it: a listener
  // that outlived its mount would scroll a terminal that is not on screen.
  engine1.unmount();
  pressArrow(term, -1);
  expect(term.scrollLinesCalls).toEqual([-1]);

  // The reattach path re-wires. Exactly ONE listener: a second engine mounting the cached
  // terminal must not stack a second subscription on the surviving element (each press would
  // then scroll two rows).
  const engine2 = new TerminalEngine(bridge, { cacheKey });
  engine2.mount(makeContainer());
  expect(mockTerm(cacheKey)).toBe(term); // same cached terminal, same element
  pressArrow(term, 1);
  expect(term.scrollLinesCalls).toEqual([-1, 1]);
  engine2.unmount();
});

/** A wrapper > display pair, the host contract design 012 D17 requires of a canvas node. */
function makeHost(): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-display-wrapper';
  const el = document.createElement('div');
  el.className = 'terminal-display';
  Object.defineProperty(el, 'offsetWidth', { value: 800, configurable: true });
  Object.defineProperty(el, 'offsetHeight', { value: 600, configurable: true });
  Object.defineProperty(el, 'offsetParent', { value: document.body, configurable: true });
  wrapper.appendChild(el);
  document.body.appendChild(wrapper);
  return el;
}

test('the listener survives relocateTo() — it is bound to term.element, not the container', () => {
  // Canvas Mode moves term.element into a node host (design 012 D6); container-bound listeners
  // are torn down then, but the arrows must keep working on the node. This is the case that
  // would pass with the listener in `containerDisposables` under mount/unmount alone.
  const engine = new TerminalEngine(makeBridge(), { cacheKey: 'arrows-4', isMac: false });
  engine.mount(makeHost());
  const term = mockTerm('arrows-4');
  const host = makeHost();
  expect(engine.relocateTo(host, { paneChrome: false })).toBe('relocated');
  expect(host.contains(term.element!)).toBe(true);

  pressArrow(term, -1);
  expect(term.scrollLinesCalls).toEqual([-1]);
  engine.unmount();
});

describe('wireScrollbarArrows on its own', () => {
  test('a terminal that has not been opened (no element) gets a no-op remover', () => {
    const calls: number[] = [];
    const remove = wireScrollbarArrows({ element: undefined, scrollLines: (n) => calls.push(n) });
    expect(typeof remove).toBe('function');
    expect(() => remove()).not.toThrow();
    expect(calls).toEqual([]);
  });

  test('the remover detaches the listener from the element', () => {
    const element = document.createElement('div');
    const calls: number[] = [];
    const remove = wireScrollbarArrows({ element, scrollLines: (n) => calls.push(n) });

    element.dispatchEvent(new CustomEvent(SCROLLBAR_ARROW_EVENT, { bubbles: true, detail: 1 }));
    expect(calls).toEqual([1]);

    remove();
    element.dispatchEvent(new CustomEvent(SCROLLBAR_ARROW_EVENT, { bubbles: true, detail: 1 }));
    expect(calls).toEqual([1]);
  });
});
