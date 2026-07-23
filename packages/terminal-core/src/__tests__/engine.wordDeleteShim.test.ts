import { TerminalEngine } from '../TerminalEngine';
import { terminalCache } from '../cache';
import type { TerminalBridge, Disposable } from '../types';
import { Terminal as MockTerminal } from '../__mocks__/xterm';

interface BridgeCalls {
  write: Array<[string, string]>;
}

function makeBridge(): { bridge: TerminalBridge; calls: BridgeCalls } {
  const calls: BridgeCalls = { write: [] };
  const noopDisposable: Disposable = { dispose() {} };
  const bridge: TerminalBridge = {
    onData: () => noopDisposable,
    onExit: () => noopDisposable,
    write: (processId, data) => {
      calls.write.push([processId, data]);
    },
    resize: () => {},
  };
  return { bridge, calls };
}

function makeContainer(width = 800, height = 600): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'offsetWidth', { value: width, configurable: true });
  Object.defineProperty(el, 'offsetHeight', { value: height, configurable: true });
  document.body.appendChild(el);
  return el;
}

function mockTerm(cacheKey: string): MockTerminal {
  const entry = terminalCache.get(cacheKey);
  if (!entry) throw new Error('no cache entry');
  return entry.terminal as unknown as MockTerminal;
}

function keyEvent(over: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    type: 'keydown', key: 'a', ctrlKey: false, altKey: false,
    shiftKey: false, metaKey: false, repeat: false,
    preventDefault() {}, stopPropagation() {},
    ...over,
  } as unknown as KeyboardEvent;
}

function wordDeleteEngine(cacheKey: string, shellType: string | undefined) {
  const { bridge, calls } = makeBridge();
  const engine = new TerminalEngine(bridge, { cacheKey, isWindows: true, shellType: () => shellType });
  engine.mount(makeContainer());
  engine.attach('p1');
  const term = mockTerm(cacheKey);
  term.csiHandlers['?h']([9001]); // ConPTY's session-start Win32-Input-Mode offer
  return { engine, term, calls };
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

afterEach(() => {
  terminalCache.clear();
});

test('Ctrl+Backspace on a POSIX shell sends ESC DEL and its keyup is swallowed (no stray Win32 release record)', () => {
  const { term, calls } = wordDeleteEngine('wd1', 'bash');

  expect(term.keyHandler!(keyEvent({ key: 'Backspace', ctrlKey: true }))).toBe(false);
  expect(calls.write).toEqual([['p1', '\x1b\x7f']]);

  // The matching keyup must not leak a stray Win32-Input-Mode release record —
  // Win32-Input-Mode stays active for the whole Windows session regardless of
  // shellType, so without swallowing this keyup it would fall through to that
  // encoder below and write a second, unsolicited record to the PTY.
  expect(term.keyHandler!(keyEvent({ key: 'Backspace', ctrlKey: true, type: 'keyup' }))).toBe(false);
  expect(calls.write).toEqual([['p1', '\x1b\x7f']]);
});

test('Ctrl+Delete on a POSIX shell sends ESC d and its keyup is swallowed', () => {
  const { term, calls } = wordDeleteEngine('wd2', 'git-bash');

  expect(term.keyHandler!(keyEvent({ key: 'Delete', ctrlKey: true }))).toBe(false);
  expect(calls.write).toEqual([['p1', '\x1bd']]);

  expect(term.keyHandler!(keyEvent({ key: 'Delete', ctrlKey: true, type: 'keyup' }))).toBe(false);
  expect(calls.write).toEqual([['p1', '\x1bd']]);
});

test('Ctrl+Backspace on PowerShell is left to Win32-Input-Mode (press AND release both encoded, unchanged from before this shim)', () => {
  const { term, calls } = wordDeleteEngine('wd3', 'powershell');

  expect(term.keyHandler!(keyEvent({ key: 'Backspace', keyCode: 8, ctrlKey: true }))).toBe(false);
  expect(term.keyHandler!(keyEvent({ key: 'Backspace', keyCode: 8, ctrlKey: true, type: 'keyup' }))).toBe(false);
  // Both the press and the release reach the PTY via the Win32-Input-Mode encoder
  // (not the shim) — exactly the pre-existing behavior, now just also verified
  // for Ctrl+Delete's PowerShell path stays untouched by this feature.
  expect(calls.write.length).toBe(2);
});

test("Ctrl+Backspace with the ambiguous 'default' shellType is left to Win32-Input-Mode, not shimmed", () => {
  const { term, calls } = wordDeleteEngine('wd4', 'default');

  expect(term.keyHandler!(keyEvent({ key: 'Backspace', keyCode: 8, ctrlKey: true }))).toBe(false);
  // Falls through to the Win32-Input-Mode encoder (Uc=127 override), not the ESC
  // DEL shim — see isPosixShell's doc comment for why 'default' must not be
  // treated as POSIX.
  expect(calls.write).toEqual([['p1', '\x1b[8;14;127;1;8;1_']]);
});
