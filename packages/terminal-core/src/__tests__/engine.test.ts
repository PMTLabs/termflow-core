import { TerminalEngine } from '../TerminalEngine';
import { terminalCache } from '../cache';
import type { TerminalBridge, Disposable } from '../types';
// The jest moduleNameMapper points @xterm/xterm at our mock; importing the mock
// class directly lets us reach into the captured callbacks / recorded writes.
import { Terminal as MockTerminal } from '../__mocks__/xterm';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface BridgeCalls {
  write: Array<[string, string]>;
  resize: Array<[string, number, number]>;
}

function makeBridge(): { bridge: TerminalBridge; calls: BridgeCalls } {
  const calls: BridgeCalls = { write: [], resize: [] };
  const noopDisposable: Disposable = { dispose() {} };
  const bridge: TerminalBridge = {
    onData: () => noopDisposable,
    onExit: () => noopDisposable,
    write: (processId, data) => {
      calls.write.push([processId, data]);
    },
    resize: (processId, cols, rows) => {
      calls.resize.push([processId, cols, rows]);
    },
  };
  return { bridge, calls };
}

// jsdom gives us a real element; force a usable size so the >50px guards pass.
function makeContainer(width = 800, height = 600): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'offsetWidth', { value: width, configurable: true });
  Object.defineProperty(el, 'offsetHeight', { value: height, configurable: true });
  document.body.appendChild(el);
  return el;
}

// Reach the engine's live mock Terminal (the cache holds it).
function mockTerm(cacheKey: string): MockTerminal {
  const entry = terminalCache.get(cacheKey);
  if (!entry) throw new Error('no cache entry');
  return entry.terminal as unknown as MockTerminal;
}

beforeEach(() => {
  terminalCache.clear();
  // jsdom lacks ResizeObserver — provide a no-op so mount() doesn't throw.
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

// ---------------------------------------------------------------------------
// Construction / options (R6)
// ---------------------------------------------------------------------------

test('mount creates a terminal preserving the load-bearing xterm options (R6)', () => {
  const { bridge } = makeBridge();
  const engine = new TerminalEngine(bridge, { cacheKey: 't1' });
  engine.mount(makeContainer());

  const term = mockTerm('t1');
  expect(term.options.allowProposedApi).toBe(true);
  // Windows-Terminal-style cursor: slim blinking bar (user request; replaces the
  // earlier steady-block default — DECSCUSR blink-phase restarts under codex are
  // the same behavior Windows Terminal itself exhibits).
  expect(term.options.cursorBlink).toBe(true);
  expect(term.options.cursorStyle).toBe('bar');
  expect(term.options.convertEol).toBe(false);
  expect(term.options.scrollback).toBe(10000);
  expect(term.options.lineHeight).toBe(1.1);
  // default font size
  expect(term.options.fontSize).toBe(14);
});

// Codex/ratatui rendering fix: on Windows the engine must configure xterm's ConPTY
// compatibility via `windowsPty` (backend + real build number) and must NOT use the
// legacy `windowsMode` flag. A build >= 21376 is what makes xterm disable the wrapping
// heuristic that corrupts full-width TUIs (broken borders / invisible input bg / cursor
// jump). See TerminalEngine FALLBACK_WINDOWS_BUILD.
test('Windows: sets windowsPty {conpty, real build} and never the legacy windowsMode', () => {
  const { bridge } = makeBridge();
  const engine = new TerminalEngine(bridge, { cacheKey: 'wp1', isWindows: true, windowsBuildNumber: 26200 });
  engine.mount(makeContainer());

  const term = mockTerm('wp1');
  expect(term.options.windowsMode).toBeUndefined();
  expect(term.options.windowsPty).toEqual({ backend: 'conpty', buildNumber: 26200 });
});

test('Windows: falls back to a modern build (>= 21376, heuristic off) when none/0 is supplied', () => {
  const { bridge } = makeBridge();
  // 0 models the startup race before the OS-build fetch resolves.
  const engine = new TerminalEngine(bridge, { cacheKey: 'wp2', isWindows: true, windowsBuildNumber: 0 });
  engine.mount(makeContainer());

  const term = mockTerm('wp2');
  const pty = term.options.windowsPty as { backend: string; buildNumber: number };
  expect(pty.backend).toBe('conpty');
  expect(pty.buildNumber).toBeGreaterThanOrEqual(21376);
});

test('non-Windows: does not set windowsPty or windowsMode', () => {
  const { bridge } = makeBridge();
  const engine = new TerminalEngine(bridge, { cacheKey: 'wp3', isWindows: false, windowsBuildNumber: 26200 });
  engine.mount(makeContainer());

  const term = mockTerm('wp3');
  expect(term.options.windowsPty).toBeUndefined();
  expect(term.options.windowsMode).toBeUndefined();
});

test('mount loads Fit/WebLinks/Unicode11 addons and activates unicode v11', () => {
  const { bridge } = makeBridge();
  const engine = new TerminalEngine(bridge, { cacheKey: 't2' });
  engine.mount(makeContainer());

  const term = mockTerm('t2');
  const names = term.loadedAddons.map((a) => (a as object).constructor.name);
  expect(names).toContain('FitAddon');
  expect(names).toContain('WebLinksAddon');
  expect(names).toContain('Unicode11Addon');
  // load order: Fit before WebLinks before Unicode11
  expect(names.indexOf('FitAddon')).toBeLessThan(names.indexOf('WebLinksAddon'));
  expect(names.indexOf('WebLinksAddon')).toBeLessThan(names.indexOf('Unicode11Addon'));
  expect(term.unicode.activeVersion).toBe('11');
});

// ---------------------------------------------------------------------------
// setFontSize
// ---------------------------------------------------------------------------

test('setFontSize updates terminal.options.fontSize', () => {
  const { bridge } = makeBridge();
  const engine = new TerminalEngine(bridge, { cacheKey: 't3' });
  engine.mount(makeContainer());

  engine.setFontSize(20);
  expect(engine.terminal.options.fontSize).toBe(20);
});

// ---------------------------------------------------------------------------
// Context menu actions + WebGL toggle
// ---------------------------------------------------------------------------

test('getContextMenuActions returns all six actions', () => {
  const { bridge } = makeBridge();
  const engine = new TerminalEngine(bridge, { cacheKey: 't4' });
  engine.mount(makeContainer());

  const actions = engine.getContextMenuActions();
  for (const name of [
    'copy',
    'paste',
    'clear',
    'selectAll',
    'resetRendering',
    'toggleWebGL',
  ] as const) {
    expect(typeof actions[name]).toBe('function');
  }
});

test('toggleWebGL flips isWebGLGloballyDisabled()', () => {
  const { bridge } = makeBridge();
  const engine = new TerminalEngine(bridge, { cacheKey: 't5' });
  engine.mount(makeContainer());

  const before = engine.isWebGLGloballyDisabled();
  engine.getContextMenuActions().toggleWebGL();
  expect(engine.isWebGLGloballyDisabled()).toBe(!before);
  // flip back so global state doesn't leak across tests
  engine.getContextMenuActions().toggleWebGL();
  expect(engine.isWebGLGloballyDisabled()).toBe(before);
});

// ---------------------------------------------------------------------------
// attach() — input routing
// ---------------------------------------------------------------------------

test('before attach(), term.onData does NOT call bridge.write', () => {
  const { bridge, calls } = makeBridge();
  const engine = new TerminalEngine(bridge, { cacheKey: 't6' });
  engine.mount(makeContainer());

  mockTerm('t6').emitData('x');
  expect(calls.write).toEqual([]);
});

test('after attach("p1"), term.onData routes input to bridge.write("p1", data)', () => {
  const { bridge, calls } = makeBridge();
  const engine = new TerminalEngine(bridge, { cacheKey: 't7' });
  engine.mount(makeContainer());

  engine.attach('p1');
  mockTerm('t7').emitData('x');
  expect(calls.write).toEqual([['p1', 'x']]);
});

// ---------------------------------------------------------------------------
// Enhanced keyboard protocols (Kitty + modifyOtherKeys) — engine wiring
// ---------------------------------------------------------------------------

function keyEvent(over: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    type: 'keydown', key: 'a', ctrlKey: false, altKey: false,
    shiftKey: false, metaKey: false, repeat: false,
    preventDefault() {}, stopPropagation() {},
  } as unknown as KeyboardEvent;
}
function withKey(over: Partial<KeyboardEvent>): KeyboardEvent {
  return { ...keyEvent({}), ...over } as KeyboardEvent;
}

test('app enables kitty (CSI >1u) -> Ctrl+C is sent as CSI 99;5u', () => {
  const { bridge, calls } = makeBridge();
  const engine = new TerminalEngine(bridge, { cacheKey: 'kb1' });
  engine.mount(makeContainer());
  engine.attach('p1');
  const term = mockTerm('kb1');

  term.csiHandlers['>u']([1]); // app pushes kitty flag 1
  const handled = term.keyHandler!(withKey({ key: 'c', ctrlKey: true }));

  expect(handled).toBe(false); // suppress xterm's legacy emission
  expect(calls.write).toEqual([['p1', '\x1b[99;5u']]);
});

test('without a protocol enabled, Ctrl+C falls through to legacy (no protocol write)', () => {
  const { bridge, calls } = makeBridge();
  const engine = new TerminalEngine(bridge, { cacheKey: 'kb2' });
  engine.mount(makeContainer());
  engine.attach('p1');
  const term = mockTerm('kb2');

  const handled = term.keyHandler!(withKey({ key: 'c', ctrlKey: true }));

  expect(handled).toBe(true); // xterm emits legacy \x03
  expect(calls.write).toEqual([]);
});

test('kitty active: plain letter is NOT intercepted (text path preserved)', () => {
  const { bridge, calls } = makeBridge();
  const engine = new TerminalEngine(bridge, { cacheKey: 'kb3' });
  engine.mount(makeContainer());
  engine.attach('p1');
  const term = mockTerm('kb3');

  term.csiHandlers['>u']([1]);
  const handled = term.keyHandler!(withKey({ key: 'a' }));

  expect(handled).toBe(true); // let xterm handle plain text
  expect(calls.write).toEqual([]);
});

test('CSI ?u query is answered with the active flags', () => {
  const { bridge, calls } = makeBridge();
  const engine = new TerminalEngine(bridge, { cacheKey: 'kb4' });
  engine.mount(makeContainer());
  engine.attach('p1');
  const term = mockTerm('kb4');

  term.csiHandlers['>u']([3]); // flags 1+2
  term.csiHandlers['?u']([]);

  expect(calls.write).toEqual([['p1', '\x1b[?3u']]);
});

test('kill-switch off: enable sequence is ignored and keys stay legacy', () => {
  const { bridge, calls } = makeBridge();
  const engine = new TerminalEngine(bridge, {
    cacheKey: 'kb5',
    enhancedKeyboard: () => false,
  });
  engine.mount(makeContainer());
  engine.attach('p1');
  const term = mockTerm('kb5');

  const consumed = term.csiHandlers['>u']([1]); // handler should no-op
  expect(consumed).toBe(false); // not consumed -> xterm ignores it too
  const handled = term.keyHandler!(withKey({ key: 'c', ctrlKey: true }));
  expect(handled).toBe(true);
  expect(calls.write).toEqual([]);
});

test('Ctrl+C keyup under kitty flag 2 emits a release event (not swallowed)', () => {
  const { bridge, calls } = makeBridge();
  const engine = new TerminalEngine(bridge, { cacheKey: 'kb7' });
  engine.mount(makeContainer());
  engine.attach('p1');
  const term = mockTerm('kb7');

  term.csiHandlers['>u']([3]); // flags 1+2
  const handled = term.keyHandler!(withKey({ key: 'c', ctrlKey: true, type: 'keyup' }));

  expect(handled).toBe(false);
  expect(calls.write).toEqual([['p1', '\x1b[99;5:3u']]);
});

test('3-press Ctrl+C burst forces raw SIGINT even under an active protocol', () => {
  const { bridge, calls } = makeBridge();
  const engine = new TerminalEngine(bridge, { cacheKey: 'kb6' });
  engine.mount(makeContainer());
  engine.attach('p1');
  const term = mockTerm('kb6');
  term.csiHandlers['>u']([1]);

  // First two presses encode; the third within the burst window forces legacy \x03.
  term.keyHandler!(withKey({ key: 'c', ctrlKey: true }));
  term.keyHandler!(withKey({ key: 'c', ctrlKey: true }));
  const third = term.keyHandler!(withKey({ key: 'c', ctrlKey: true }));

  expect(third).toBe(true); // burst -> raw \x03 escape hatch (xterm emits it)
  // Only the first two encoded sends reached the bridge; the burst press did not.
  expect(calls.write).toEqual([['p1', '\x1b[99;5u'], ['p1', '\x1b[99;5u']]);
});

// ---------------------------------------------------------------------------
// Win32-Input-Mode + kbState persistence across remounts (review 046/047)
// ---------------------------------------------------------------------------

test('kbState and win32State survive a remount (same cacheKey, new TerminalEngine instance)', () => {
  const { bridge, calls } = makeBridge();
  const engine1 = new TerminalEngine(bridge, { cacheKey: 'remount1', isWindows: true });
  engine1.mount(makeContainer());
  engine1.attach('p1');
  const term = mockTerm('remount1');
  term.csiHandlers['?h']([9001]); // ConPTY's session-start offer
  engine1.unmount();

  const engine2 = new TerminalEngine(bridge, { cacheKey: 'remount1', isWindows: true });
  engine2.mount(makeContainer()); // same cacheKey -> adopts the cached win32State
  engine2.attach('p1');
  const handled = term.keyHandler!(withKey({ key: 'a', keyCode: 65 }));

  expect(handled).toBe(false); // encoded via Win32-Input-Mode, not legacy passthrough
  expect(calls.write).toEqual([['p1', '\x1b[65;30;97;1;0;1_']]);
});

test('attach() to a NEW processId resets win32State (new PTY session, own handshake)', () => {
  const { bridge, calls } = makeBridge();
  const engine = new TerminalEngine(bridge, { cacheKey: 'reattach1', isWindows: true });
  engine.mount(makeContainer());
  engine.attach('p1');
  const term = mockTerm('reattach1');
  term.csiHandlers['?h']([9001]);

  engine.attach('p2'); // simulates the old shell exiting, a new one spawned in the same pane
  const handled = term.keyHandler!(withKey({ key: 'a', keyCode: 65 }));

  expect(handled).toBe(true); // legacy path — p2's own ?9001h hasn't arrived yet
  expect(calls.write).toEqual([]); // nothing written via the protocol path
});

// Internal workflow review (docs/review/052) found and verified this live:
// win32InputModeActive() alone is not enough to gate the Win32 block. Kitty's
// encodeKey deliberately returns null (defer to legacy) for bare/unmodified
// keys even while Kitty is active — without an explicit !protocolActive()
// check, the Win32 block hijacked every one of those keys into a Win32-encoded
// record instead of true legacy passthrough, breaking basic typing for any
// Windows console app that pushes ANY Kitty flag.
test('an app with Kitty active still gets true legacy passthrough for keys Kitty defers, even with Win32-Input-Mode also active', () => {
  const { bridge, calls } = makeBridge();
  const engine = new TerminalEngine(bridge, { cacheKey: 'kitty-win32-1', isWindows: true });
  engine.mount(makeContainer());
  engine.attach('p1');
  const term = mockTerm('kitty-win32-1');

  term.csiHandlers['?h']([9001]); // ConPTY's session-start offer
  term.csiHandlers['>u']([1]); // the app ALSO pushes Kitty flag 1

  // Kitty deliberately defers a bare, unmodified letter to legacy (see
  // keyboardProtocol.ts's encodeKitty: "bare modifier keys, plain/shift-only
  // text -> null"). It must reach the app as true legacy passthrough, not get
  // reinterpreted as a Win32-Input-Mode record.
  const handled = term.keyHandler!(withKey({ key: 'a', keyCode: 65 }));

  expect(handled).toBe(true); // true legacy passthrough — xterm's own default handling
  expect(calls.write).toEqual([]); // nothing written via either protocol path
});

test('Ctrl+C still gets real Kitty encoding when Kitty is active, even with Win32-Input-Mode also active', () => {
  const { bridge, calls } = makeBridge();
  const engine = new TerminalEngine(bridge, { cacheKey: 'kitty-win32-2', isWindows: true });
  engine.mount(makeContainer());
  engine.attach('p1');
  const term = mockTerm('kitty-win32-2');

  term.csiHandlers['?h']([9001]);
  term.csiHandlers['>u']([1]);

  const handled = term.keyHandler!(withKey({ key: 'c', ctrlKey: true }));

  expect(handled).toBe(false);
  expect(calls.write).toEqual([['p1', '\x1b[99;5u']]); // real Kitty encoding, not a Win32 record
});

// Internal workflow review (docs/review/052): the ?9001l disable path and the
// DECSTR-on-Windows disable path both had zero test coverage — only the
// enable side was ever exercised, so a regression in either `if` condition
// would have gone undetected by the full existing suite.
test('CSI ?9001l disables win32State (the enable side is well-tested; the disable side was not)', () => {
  const { bridge, calls } = makeBridge();
  const engine = new TerminalEngine(bridge, { cacheKey: 'w5', isWindows: true });
  engine.mount(makeContainer());
  engine.attach('p1');
  const term = mockTerm('w5');

  term.csiHandlers['?h']([9001]);
  term.csiHandlers['?l']([9001]); // app/ConPTY turns it back off

  const handled = term.keyHandler!(withKey({ key: 'a', keyCode: 65 }));
  expect(handled).toBe(true); // back to legacy passthrough
  expect(calls.write).toEqual([]);
});

test('DECSTR soft reset disables win32State on Windows (only the Kitty-flags variant was tested before)', () => {
  const { bridge, calls } = makeBridge();
  const engine = new TerminalEngine(bridge, { cacheKey: 'w6', isWindows: true });
  engine.mount(makeContainer());
  engine.attach('p1');
  const term = mockTerm('w6');

  term.csiHandlers['?h']([9001]);
  term.csiHandlers['p']([]); // DECSTR (intermediates '!', final 'p')

  const handled = term.keyHandler!(withKey({ key: 'a', keyCode: 65 }));
  expect(handled).toBe(true);
  expect(calls.write).toEqual([]);
});

// ---------------------------------------------------------------------------
// Scroll keys: plain PageUp/PageDown scroll the viewport; End jumps to bottom
// ---------------------------------------------------------------------------

function scrollEngine(cacheKey: string, opts: { isWindows?: boolean } = {}) {
  const { bridge, calls } = makeBridge();
  const engine = new TerminalEngine(bridge, { cacheKey, ...opts });
  engine.mount(makeContainer());
  engine.attach('p1');
  const term = mockTerm(cacheKey);
  // A tab with scrollback: viewport pinned to the live bottom.
  term.buffer.active.baseY = 100;
  term.buffer.active.viewportY = 100;
  return { engine, term, calls };
}

test('plain PageUp/PageDown scroll the viewport by a page and never reach the PTY', () => {
  const { term, calls } = scrollEngine('sc1');

  expect(term.keyHandler!(withKey({ key: 'PageUp' }))).toBe(false);
  expect(term.scrollPagesCalls).toEqual([-1]);
  expect(term.keyHandler!(withKey({ key: 'PageDown' }))).toBe(false);
  expect(term.scrollPagesCalls).toEqual([-1, 1]);
  expect(calls.write).toEqual([]);
});

test('PageUp/PageDown pass through on the alternate screen (vim/less own the keys)', () => {
  const { term, calls } = scrollEngine('sc2');
  term.__setBufferType('alternate');

  expect(term.keyHandler!(withKey({ key: 'PageUp' }))).toBe(true);
  expect(term.keyHandler!(withKey({ key: 'PageDown' }))).toBe(true);
  expect(term.scrollPagesCalls).toEqual([]);
  expect(calls.write).toEqual([]);
});

test('modified PageUp (Shift) is not claimed — xterm keeps its own Shift+PageUp scroll', () => {
  const { term } = scrollEngine('sc3');

  expect(term.keyHandler!(withKey({ key: 'PageUp', shiftKey: true }))).toBe(true);
  expect(term.scrollPagesCalls).toEqual([]);
});

test('End while scrolled up jumps to the bottom and is consumed', () => {
  const { term, calls } = scrollEngine('sc4');
  term.buffer.active.viewportY = 40; // user scrolled up

  expect(term.keyHandler!(withKey({ key: 'End' }))).toBe(false);
  expect(term.scrollToBottomCount).toBe(1);
  expect(calls.write).toEqual([]);
});

test('End at the bottom passes through to the shell (readline end-of-line)', () => {
  const { term, calls } = scrollEngine('sc5');

  expect(term.keyHandler!(withKey({ key: 'End' }))).toBe(true);
  expect(term.scrollToBottomCount).toBe(0);
  expect(calls.write).toEqual([]);
});

test('win32 input mode active: PageUp still scrolls instead of being encoded, and its keyup is swallowed', () => {
  const { term, calls } = scrollEngine('sc6', { isWindows: true });
  term.csiHandlers['?h']([9001]); // ConPTY's session-start offer

  expect(term.keyHandler!(withKey({ key: 'PageUp' }))).toBe(false);
  expect(term.scrollPagesCalls).toEqual([-1]);
  // The matching keyup must not leak a stray Win32 release record to the PTY.
  expect(term.keyHandler!(withKey({ key: 'PageUp', type: 'keyup' }))).toBe(false);
  expect(calls.write).toEqual([]);
});

test('End auto-repeat after the claimed first press stays swallowed until keyup (review 053 F1)', () => {
  const { term, calls } = scrollEngine('sc8', { isWindows: true });
  term.csiHandlers['?h']([9001]); // win32 input mode: encoders would forward leaks
  term.buffer.active.viewportY = 40; // scrolled up

  // First press: claims the key and synchronously scrolls to the bottom.
  expect(term.keyHandler!(withKey({ key: 'End' }))).toBe(false);
  expect(term.scrollToBottomCount).toBe(1);
  // Auto-repeat keydowns now see scrolledUp=false — they must STILL be
  // swallowed while the claim is held, not fall through to the Win32 encoder
  // (the eventual keyup is swallowed by the claim, so a leaked repeat keydown
  // would leave the PTY with a press and no release).
  expect(term.keyHandler!(withKey({ key: 'End', repeat: true }))).toBe(false);
  expect(term.keyHandler!(withKey({ key: 'End', repeat: true }))).toBe(false);
  // Release clears the claim and is swallowed.
  expect(term.keyHandler!(withKey({ key: 'End', type: 'keyup' }))).toBe(false);
  expect(calls.write).toEqual([]);

  // Claim cleared: a fresh End at the bottom reaches the PTY again — under
  // active win32 input mode that means the encoder consumes it and WRITES a
  // record (handled=false + write), not xterm legacy passthrough.
  expect(term.keyHandler!(withKey({ key: 'End' }))).toBe(false);
  expect(calls.write.length).toBe(1);
});

test('kitty protocol active: scroll keys defer to the app (e.g. Claude Code input editor)', () => {
  const { term, calls } = scrollEngine('sc7');
  term.csiHandlers['>u']([1]); // app pushes kitty flag 1
  term.buffer.active.viewportY = 40;

  // Bare functional keys under flag 1 defer to xterm's legacy emission — the
  // app receives \x1b[5~ / \x1b[F; we must not hijack them for scrolling.
  expect(term.keyHandler!(withKey({ key: 'PageUp' }))).toBe(true);
  expect(term.keyHandler!(withKey({ key: 'End' }))).toBe(true);
  expect(term.scrollPagesCalls).toEqual([]);
  expect(term.scrollToBottomCount).toBe(0);
  expect(calls.write).toEqual([]);
});

test('isWindows: false never activates Win32-Input-Mode even if ?9001h somehow arrives', () => {
  const { bridge, calls } = makeBridge();
  const engine = new TerminalEngine(bridge, { cacheKey: 'w4', isWindows: false });
  engine.mount(makeContainer());
  engine.attach('p1');
  const term = mockTerm('w4');

  term.csiHandlers['?h']([9001]); // must be a no-op off-Windows
  const handled = term.keyHandler!(withKey({ key: 'a', keyCode: 65 }));

  expect(handled).toBe(true); // falls through to xterm's own default handling
  expect(calls.write).toEqual([]); // nothing written via the protocol path
});

test('after attach("p1"), term.onResize debounces then routes to bridge.resize("p1", cols, rows)', () => {
  jest.useFakeTimers();
  try {
    const { bridge, calls } = makeBridge();
    const engine = new TerminalEngine(bridge, { cacheKey: 't8' });
    engine.mount(makeContainer());

    engine.attach('p1');
    mockTerm('t8').emitResize(120, 40);
    // Backend resize is debounced — not sent synchronously (avoids ConPTY
    // repaint spam / duplicated lines during a window drag).
    expect(calls.resize).not.toContainEqual(['p1', 120, 40]);

    jest.advanceTimersByTime(150);
    expect(calls.resize).toContainEqual(['p1', 120, 40]);
  } finally {
    jest.useRealTimers();
  }
});

test('rapid term.onResize events coalesce into a single backend resize (final size)', () => {
  jest.useFakeTimers();
  try {
    const { bridge, calls } = makeBridge();
    const engine = new TerminalEngine(bridge, { cacheKey: 't8b' });
    engine.mount(makeContainer());
    engine.attach('p1');

    // Simulate a drag: many resizes in quick succession.
    const term = mockTerm('t8b');
    term.emitResize(100, 30);
    term.emitResize(90, 28);
    term.emitResize(80, 24);
    jest.advanceTimersByTime(150);

    // The final size reaches the backend; the intermediate sizes are coalesced away.
    const p1Resizes = calls.resize.filter(([pid]) => pid === 'p1');
    expect(p1Resizes).toContainEqual(['p1', 80, 24]);
    expect(p1Resizes).not.toContainEqual(['p1', 100, 30]);
    expect(p1Resizes).not.toContainEqual(['p1', 90, 28]);
  } finally {
    jest.useRealTimers();
  }
});

test('unmount flushes a pending debounced resize (PTY not left at a stale size)', () => {
  jest.useFakeTimers();
  try {
    const { bridge, calls } = makeBridge();
    const engine = new TerminalEngine(bridge, { cacheKey: 't8c' });
    engine.mount(makeContainer());
    engine.attach('p1');

    mockTerm('t8c').emitResize(70, 20);
    // Debounced — not sent yet.
    expect(calls.resize).not.toContainEqual(['p1', 70, 20]);

    // Unmount before the 120ms debounce fires: it must flush, not drop, so the
    // backend PTY reflects the final size (otherwise remount won't re-fit).
    engine.unmount();
    expect(calls.resize).toContainEqual(['p1', 70, 20]);
  } finally {
    jest.useRealTimers();
  }
});

// ---------------------------------------------------------------------------
// Shift+Enter → soft newline (LF) instead of submit (CR)
// ---------------------------------------------------------------------------

function pressKey(
  term: MockTerminal,
  init: Partial<KeyboardEvent> & { key: string },
): boolean {
  const event = {
    type: 'keydown',
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    preventDefault() {},
    stopPropagation() {},
    ...init,
  } as unknown as KeyboardEvent;
  // keyHandler is the engine's attachCustomKeyEventHandler callback.
  return term.keyHandler ? term.keyHandler(event) : true;
}

test('Shift+Enter writes LF (\\n) to the PTY and is swallowed by xterm', () => {
  const { bridge, calls } = makeBridge();
  const engine = new TerminalEngine(bridge, { cacheKey: 'se1' });
  engine.mount(makeContainer());
  engine.attach('p1');

  const handled = pressKey(mockTerm('se1'), { key: 'Enter', shiftKey: true });

  expect(calls.write).toEqual([['p1', '\n']]);
  // returning false tells xterm NOT to also emit CR for this keypress
  expect(handled).toBe(false);
});

test('plain Enter is left to xterm (no direct LF write)', () => {
  const { bridge, calls } = makeBridge();
  const engine = new TerminalEngine(bridge, { cacheKey: 'se2' });
  engine.mount(makeContainer());
  engine.attach('p1');

  const handled = pressKey(mockTerm('se2'), { key: 'Enter', shiftKey: false });

  expect(calls.write).toEqual([]); // engine doesn't intercept; xterm sends CR itself
  expect(handled).toBe(true);
});

test('Ctrl+Shift+Enter is NOT treated as soft newline', () => {
  const { bridge, calls } = makeBridge();
  const engine = new TerminalEngine(bridge, { cacheKey: 'se3' });
  engine.mount(makeContainer());
  engine.attach('p1');

  pressKey(mockTerm('se3'), { key: 'Enter', shiftKey: true, ctrlKey: true });

  expect(calls.write).toEqual([]);
});

// ---------------------------------------------------------------------------
// paste() — routes through xterm (bracketed paste) → onData → bridge.write
// ---------------------------------------------------------------------------

test('engine.paste() routes through xterm.paste and reaches bridge.write', () => {
  const { bridge, calls } = makeBridge();
  const engine = new TerminalEngine(bridge, { cacheKey: 'pa1' });
  engine.mount(makeContainer());
  engine.attach('p1');

  engine.paste('line1\nline2');

  const term = mockTerm('pa1');
  expect(term.pasted).toEqual(['line1\nline2']); // went THROUGH xterm.paste
  expect(calls.write).toEqual([['p1', 'line1\nline2']]); // emitted via onData
});

test('pasteToTerminal(cacheKey) pastes via the cached terminal; false when unmounted', () => {
  const { bridge, calls } = makeBridge();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { pasteToTerminal } = require('../cache') as typeof import('../cache');
  const engine = new TerminalEngine(bridge, { cacheKey: 'pa2' });
  engine.mount(makeContainer());
  engine.attach('p1');

  expect(pasteToTerminal('pa2', 'hi')).toBe(true);
  expect(calls.write).toEqual([['p1', 'hi']]);
  // unknown key → no terminal mounted → false (caller falls back to a raw write)
  expect(pasteToTerminal('nope', 'x')).toBe(false);
});

// ---------------------------------------------------------------------------
// onTitleChange wiring
// ---------------------------------------------------------------------------

test('term.onTitleChange forwards to opts.onTitleChange', () => {
  const { bridge } = makeBridge();
  const titles: string[] = [];
  const engine = new TerminalEngine(bridge, {
    cacheKey: 't9',
    onTitleChange: (t) => titles.push(t),
  });
  engine.mount(makeContainer());

  mockTerm('t9').emitTitle('hello');
  expect(titles).toEqual(['hello']);
});

// ---------------------------------------------------------------------------
// onDiag — incoming PTY chunk emits a [TERM-OUT] diagnostic (restores §11 gate g)
// ---------------------------------------------------------------------------

test('onDiag fires with a [TERM-OUT] line when an incoming chunk arrives', () => {
  // A bridge that captures the engine's cache-lifetime onData callback so the
  // test can drive an incoming PTY chunk through it.
  let emitData: ((data: string) => void) | undefined;
  const noopDisposable: Disposable = { dispose() {} };
  const bridge: TerminalBridge = {
    onData: (_processId, cb) => {
      emitData = cb;
      return noopDisposable;
    },
    onExit: () => noopDisposable,
    write: () => {},
    resize: () => {},
  };

  const diagLines: string[] = [];
  const engine = new TerminalEngine(bridge, {
    cacheKey: 't-diag',
    onDiag: (build) => diagLines.push(build()),
  });
  engine.mount(makeContainer());
  engine.attach('p1'); // wires the cache-lifetime onData subscription

  expect(typeof emitData).toBe('function');
  emitData!('hello');

  const termOut = diagLines.find((l) => l.startsWith('[TERM-OUT]'));
  expect(termOut).toBeDefined();
  expect(termOut).toContain('hello');
});

// ---------------------------------------------------------------------------
// unmount must NOT dispose the terminal (preserved via cacheKey)
// ---------------------------------------------------------------------------

test('unmount runs local disposables (input stops routing) but keeps the terminal in the cache', () => {
  const { bridge, calls } = makeBridge();
  const engine = new TerminalEngine(bridge, { cacheKey: 't10' });
  engine.mount(makeContainer());

  engine.attach('p1');
  const term = mockTerm('t10');

  // Sanity: input routes while mounted.
  term.emitData('a');
  expect(calls.write).toEqual([['p1', 'a']]);

  engine.unmount();

  // Cache entry (and its terminal) survives unmount — NOT disposed.
  expect(terminalCache.has('t10')).toBe(true);
  expect(terminalCache.get('t10')!.terminal).toBe(term as unknown as object);

  // The local onData disposable was run, so further input no longer routes.
  term.emitData('b');
  expect(calls.write).toEqual([['p1', 'a']]);
});

// ---------------------------------------------------------------------------
// autoFocus — mount focuses by default; autoFocus:false suppresses focus-on-mount
// (grid focus-stealing fix). Click-to-focus is unaffected (not exercised here).
// ---------------------------------------------------------------------------

test('mount focuses the terminal by default (autoFocus omitted)', () => {
  const { bridge } = makeBridge();
  const engine = new TerminalEngine(bridge, { cacheKey: 't-focus-default' });
  engine.mount(makeContainer());

  expect(mockTerm('t-focus-default').focusCount).toBeGreaterThanOrEqual(1);
});

test('mount does NOT focus the terminal when autoFocus is false', () => {
  const { bridge } = makeBridge();
  const engine = new TerminalEngine(bridge, {
    cacheKey: 't-focus-off',
    autoFocus: false,
  });
  engine.mount(makeContainer());

  expect(mockTerm('t-focus-off').focusCount).toBe(0);
});

// ---------------------------------------------------------------------------
// keyboard zoom — dual path semantics (exactly +1 via capture, custom returns false)
// ---------------------------------------------------------------------------

test('Ctrl+= via custom key handler calls onFontSizeChange(+1) and returns false', () => {
  const { bridge } = makeBridge();
  const sizes: number[] = [];
  const engine = new TerminalEngine(bridge, {
    cacheKey: 't11',
    fontSize: 14,
    onFontSizeChange: (px) => sizes.push(px),
  });
  engine.mount(makeContainer());

  const term = mockTerm('t11');
  const handler = term.keyHandler!;
  const evt = {
    ctrlKey: true,
    shiftKey: false,
    type: 'keydown',
    key: '=',
    code: 'Equal',
    preventDefault() {},
    stopPropagation() {},
  } as unknown as KeyboardEvent;

  const result = handler(evt);
  expect(result).toBe(false);
  expect(sizes).toEqual([15]);
});

test('capture-phase zoom listener stops propagation so the custom handler does not double-fire', () => {
  const { bridge } = makeBridge();
  const sizes: number[] = [];
  const container = makeContainer();
  const engine = new TerminalEngine(bridge, {
    cacheKey: 't12',
    fontSize: 14,
    onFontSizeChange: (px) => sizes.push(px),
  });
  engine.mount(container);

  // Dispatch a real bubbling, cancelable Ctrl+= keydown on the container; assert
  // the capture-phase zoom listener fires exactly once with the right +1 value.
  const evt = new KeyboardEvent('keydown', {
    key: '=',
    code: 'Equal',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  container.dispatchEvent(evt);

  expect(sizes).toEqual([15]);
});
