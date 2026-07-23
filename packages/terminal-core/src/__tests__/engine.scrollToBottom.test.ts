import { TerminalEngine } from '../TerminalEngine';
import { terminalCache } from '../cache';
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

test('isScrolledToBottom is true before mount (no term yet)', () => {
  const engine = new TerminalEngine(makeBridge(), { cacheKey: 'sb1' });
  expect(engine.isScrolledToBottom()).toBe(true);
});

test('isScrolledToBottom reflects viewportY vs baseY after mount', () => {
  const engine = new TerminalEngine(makeBridge(), { cacheKey: 'sb2' });
  engine.mount(makeContainer());
  const term = mockTerm('sb2');
  term.buffer.active.baseY = 100;
  term.buffer.active.viewportY = 100;
  expect(engine.isScrolledToBottom()).toBe(true);

  term.emitScroll(40); // scrolled up, away from the tail
  expect(engine.isScrolledToBottom()).toBe(false);

  term.emitScroll(100); // back at the tail
  expect(engine.isScrolledToBottom()).toBe(true);
});

test('onScrollPosition delivers the at-bottom state on every scroll event', () => {
  const engine = new TerminalEngine(makeBridge(), { cacheKey: 'sb3' });
  engine.mount(makeContainer());
  const term = mockTerm('sb3');
  term.buffer.active.baseY = 50;
  term.buffer.active.viewportY = 50;

  const seen: boolean[] = [];
  const sub = engine.onScrollPosition((atBottom) => seen.push(atBottom));

  term.emitScroll(10);
  term.emitScroll(50);
  expect(seen).toEqual([false, true]);

  sub.dispose();
  term.emitScroll(10);
  expect(seen).toEqual([false, true]); // no further delivery after dispose
});

test('onScrollPosition is a safe no-op before mount', () => {
  const engine = new TerminalEngine(makeBridge(), { cacheKey: 'sb4' });
  const sub = engine.onScrollPosition(() => {
    throw new Error('should never be called');
  });
  expect(() => sub.dispose()).not.toThrow();
});

test('scrollToBottom delegates to the underlying terminal', () => {
  const engine = new TerminalEngine(makeBridge(), { cacheKey: 'sb5' });
  engine.mount(makeContainer());
  const term = mockTerm('sb5');
  term.buffer.active.baseY = 30;
  term.buffer.active.viewportY = 5;

  engine.scrollToBottom();

  expect(term.scrollToBottomCount).toBe(1);
  expect(term.buffer.active.viewportY).toBe(30);
});

test('scrollToBottom before mount does not throw', () => {
  const engine = new TerminalEngine(makeBridge(), { cacheKey: 'sb6' });
  expect(() => engine.scrollToBottom()).not.toThrow();
});
