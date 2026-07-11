import { TerminalEngine } from '../TerminalEngine';
import { terminalCache } from '../cache';
import type { TerminalBridge, Disposable } from '../types';
import { Terminal as MockTerminal } from '../__mocks__/xterm';

// Regression: under a mouse-tracking CLI (Claude/Copilot) xterm clears the live
// selection on the very pty input — a mouse move, or the right-click that opens the
// context menu — that precedes a copy. The engine must retain the selection captured
// during the drag so right-click → Copy still works. See pickCopyText + onSelectionChange.

function makeBridge(): TerminalBridge {
  const noop: Disposable = { dispose() {} };
  return {
    onData: () => noop,
    onExit: () => noop,
    write: () => {},
    resize: () => {},
  };
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

test('retains the selection so context-menu Copy survives the right-click clear (mouse tracking)', () => {
  const copied: string[] = [];
  const engine = new TerminalEngine(makeBridge(), {
    cacheKey: 'sel1',
    writeClipboard: (t) => copied.push(t),
  });
  engine.mount(makeContainer());
  const term = mockTerm('sel1');

  // App turns on mouse tracking, then the user Shift+drags a selection.
  term.mouseTrackingMode = 'any';
  term.__setSelection('selected text');

  // xterm wipes the live selection on the right-click that opens the menu.
  term.__setSelection('');

  // Copy must still be enabled and copy exactly what was selected.
  expect(engine.hasCopyableSelection()).toBe(true);
  engine.getContextMenuActions().copy();
  expect(copied).toEqual(['selected text']);
});

test('does not retain a stale selection in a normal shell (no mouse tracking)', () => {
  const engine = new TerminalEngine(makeBridge(), { cacheKey: 'sel2' });
  engine.mount(makeContainer());
  const term = mockTerm('sel2');

  // Normal mode: a selection then a clear (e.g. the user typed) must leave Copy disabled —
  // the live selection is authoritative, so no stale retained value lingers.
  term.mouseTrackingMode = 'none';
  term.__setSelection('old selection');
  term.__setSelection('');

  expect(engine.hasCopyableSelection()).toBe(false);
});

test('prefers the live selection when one is present', () => {
  const engine = new TerminalEngine(makeBridge(), { cacheKey: 'sel3' });
  engine.mount(makeContainer());
  const term = mockTerm('sel3');

  term.mouseTrackingMode = 'any';
  term.__setSelection('live selection');

  expect(engine.hasCopyableSelection()).toBe(true);
});
