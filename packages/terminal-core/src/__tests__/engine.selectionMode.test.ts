import { TerminalEngine, MOUSE_DISABLE_SEQ, mouseModeEnableSeq } from '../TerminalEngine';
import { terminalCache } from '../cache';
import type { TerminalBridge, Disposable } from '../types';
import { Terminal as MockTerminal } from '../__mocks__/xterm';

// Selection mode pauses the app's mouse capture (writes mouse-tracking DECRST to xterm)
// so a plain drag selects locally — the reliable copy path under mouse-tracking CLIs
// (Claude/Copilot), where Shift+drag does not force a local selection in the WebView.

describe('mouseModeEnableSeq', () => {
  it('restores any-event tracking + SGR encoding', () => {
    expect(mouseModeEnableSeq('any')).toBe('\x1b[?1003h\x1b[?1006h');
  });
  it('restores button-drag tracking', () => {
    expect(mouseModeEnableSeq('drag')).toBe('\x1b[?1002h\x1b[?1006h');
  });
  it('restores vt200 tracking', () => {
    expect(mouseModeEnableSeq('vt200')).toBe('\x1b[?1000h\x1b[?1006h');
  });
  it('returns nothing when no tracking was active', () => {
    expect(mouseModeEnableSeq('none')).toBe('');
  });
});

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

test('toggling selection mode on suspends, off restores, the app mouse tracking', () => {
  const engine = new TerminalEngine(makeBridge(), { cacheKey: 'sm1' });
  engine.mount(makeContainer());
  const term = mockTerm('sm1');
  term.mouseTrackingMode = 'any';

  expect(engine.isSelectionMode()).toBe(false);

  engine.setSelectionMode(true);
  expect(engine.isSelectionMode()).toBe(true);
  expect(term.written).toContain(MOUSE_DISABLE_SEQ);

  // After the DECRST, xterm reports no tracking; restore uses the SAVED mode ('any').
  term.mouseTrackingMode = 'none';
  term.written = [];
  engine.setSelectionMode(false);
  expect(engine.isSelectionMode()).toBe(false);
  expect(term.written).toContain('\x1b[?1003h\x1b[?1006h');
});

test('selection mode writes no DECRST when no app mouse tracking is active', () => {
  const engine = new TerminalEngine(makeBridge(), { cacheKey: 'sm2' });
  engine.mount(makeContainer());
  const term = mockTerm('sm2');
  term.mouseTrackingMode = 'none';
  term.written = [];

  engine.setSelectionMode(true);
  expect(term.written).toEqual([]);
  expect(engine.isSelectionMode()).toBe(true);
});

test('isMouseTrackingActive reflects the live xterm mode', () => {
  const engine = new TerminalEngine(makeBridge(), { cacheKey: 'sm3' });
  engine.mount(makeContainer());
  const term = mockTerm('sm3');

  term.mouseTrackingMode = 'none';
  expect(engine.isMouseTrackingActive()).toBe(false);
  term.mouseTrackingMode = 'any';
  expect(engine.isMouseTrackingActive()).toBe(true);
});

test('restores mouse tracking on unmount if selection mode was on', () => {
  const engine = new TerminalEngine(makeBridge(), { cacheKey: 'sm4' });
  engine.mount(makeContainer());
  const term = mockTerm('sm4');
  term.mouseTrackingMode = 'any';

  engine.setSelectionMode(true);
  expect(engine.isSelectionMode()).toBe(true);
  term.written = [];

  engine.unmount();
  expect(engine.isSelectionMode()).toBe(false);
  expect(term.written).toContain('\x1b[?1003h\x1b[?1006h');
});

test('resets selection mode state on process retarget', () => {
  const engine = new TerminalEngine(makeBridge(), { cacheKey: 'sm5' });
  engine.mount(makeContainer());
  const term = mockTerm('sm5');
  term.mouseTrackingMode = 'any';

  engine.attach('p1');
  engine.setSelectionMode(true);
  expect(engine.isSelectionMode()).toBe(true);

  // Retargeting to a new process should reset selection mode state
  engine.attach('p2');
  expect(engine.isSelectionMode()).toBe(false);
});

test('self-corrects selection mode if app re-asserts mouse tracking', () => {
  const engine = new TerminalEngine(makeBridge(), { cacheKey: 'sm6' });
  engine.mount(makeContainer());
  const term = mockTerm('sm6');
  term.mouseTrackingMode = 'any';

  engine.setSelectionMode(true);
  expect(engine.isSelectionMode()).toBe(true);

  // Simulate CLI app writing to term to re-assert mouse tracking
  term.mouseTrackingMode = 'drag';

  expect(engine.isSelectionMode()).toBe(false);
});

