import { TerminalEngine } from '../TerminalEngine';
import { terminalCache } from '../cache';
import type { TerminalBridge, Disposable } from '../types';
// The jest moduleNameMapper points @xterm/xterm at our mock; importing the mock
// class directly lets us reach into the captured callbacks / recorded writes.
import { Terminal as MockTerminal } from '../__mocks__/xterm';

// ---------------------------------------------------------------------------
// Backlog 011 — command capture + suggest popup engine integration
// ---------------------------------------------------------------------------

function makeBridge(): { bridge: TerminalBridge; writes: Array<[string, string]> } {
  const writes: Array<[string, string]> = [];
  const noopDisposable: Disposable = { dispose() {} };
  const bridge: TerminalBridge = {
    onData: () => noopDisposable,
    onExit: () => noopDisposable,
    write: (processId, data) => {
      writes.push([processId, data]);
    },
    resize: () => {},
  };
  return { bridge, writes };
}

function makeContainer(width = 800, height = 600): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'offsetWidth', { value: width, configurable: true });
  Object.defineProperty(el, 'offsetHeight', { value: height, configurable: true });
  document.body.appendChild(el);
  return el;
}

let seq = 0;

function makeEngine(optOverrides: Record<string, unknown> = {}) {
  const { bridge, writes } = makeBridge();
  const inputLines: string[] = [];
  const submitted: string[] = [];
  const actions: string[] = [];
  const cacheKey = (optOverrides.cacheKey as string | undefined) ?? `suggest-${seq++}`;
  const engine = new TerminalEngine(bridge, {
    cacheKey,
    commandSuggestions: () => true,
    onInputLineChanged: (t: string) => inputLines.push(t),
    onCommandSubmitted: (c: string) => submitted.push(c),
    onSuggestAction: (a: string) => actions.push(a),
    ...optOverrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  engine.mount(makeContainer());
  engine.attach('pid-1');
  const entry = terminalCache.get(cacheKey);
  if (!entry) throw new Error('no cache entry');
  const term = entry.terminal as unknown as MockTerminal;
  return { engine, term, writes, inputLines, submitted, actions };
}

function key(k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: k, ...init });
}

beforeEach(() => {
  terminalCache.clear();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof (global as any).ResizeObserver === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

test('typing sets a mark and onWriteParsed emits the current input line (deduped)', () => {
  const { term, inputLines } = makeEngine();
  term.__setLine(0, 'PS> ');
  term.__setCursor(4, 0);
  term.emitData('d'); // keystroke -> mark at col 4
  term.__setLine(0, 'PS> dot'); // echo arrives
  term.__setCursor(7, 0);
  term.emitWriteParsed();
  expect(inputLines).toEqual(['dot']);
  term.emitWriteParsed(); // unchanged -> no duplicate emit
  expect(inputLines).toEqual(['dot']);
});

test('Enter (CR onData) submits the redacted command and clears the input line', () => {
  const { term, inputLines, submitted } = makeEngine();
  term.__setLine(0, 'PS> ');
  term.__setCursor(4, 0);
  term.emitData('g');
  term.__setLine(0, 'PS> git status');
  term.__setCursor(14, 0);
  term.emitWriteParsed();
  term.emitData('\r');
  expect(submitted).toEqual(['git status']);
  expect(inputLines[inputLines.length - 1]).toBe('');
});

test('Up-arrow history recall as FIRST key still captures the recalled command', () => {
  const { term, submitted } = makeEngine();
  term.__setLine(0, '$ ');
  term.__setCursor(2, 0);
  term.emitData('\x1b[A'); // Up: shell recalls "dotnet build" and echoes it
  term.__setLine(0, '$ dotnet build');
  term.__setCursor(14, 0);
  term.emitWriteParsed();
  term.emitData('\r');
  expect(submitted).toEqual(['dotnet build']);
});

test('multi-line paste (embedded newline) cancels capture instead of mis-capturing', () => {
  const { term, submitted } = makeEngine();
  term.__setLine(0, '$ ');
  term.__setCursor(2, 0);
  term.emitData('echo a\recho b'); // immediate-execute paste
  term.emitData('\r');
  expect(submitted).toEqual([]);
});

test('no capture on the alt screen', () => {
  const { term, inputLines, submitted } = makeEngine();
  term.__setBufferType('alternate');
  term.__setLine(0, 'some tui row');
  term.__setCursor(3, 0);
  term.emitData('x');
  term.emitWriteParsed();
  term.emitData('\r');
  expect(inputLines).toEqual([]);
  expect(submitted).toEqual([]);
});

test('no capture while a keyboard protocol is active (TUI/REPL owns keys)', () => {
  const { term, inputLines, submitted } = makeEngine();
  term.csiHandlers['>u']([1]); // app pushes Kitty flags
  term.__setLine(0, '> ');
  term.__setCursor(2, 0);
  term.emitData('x');
  term.emitWriteParsed();
  term.emitData('\r');
  expect(inputLines).toEqual([]);
  expect(submitted).toEqual([]);
});

test('no capture while an app holds mouse tracking (codex text area)', () => {
  const { term, inputLines, submitted } = makeEngine();
  term.write('\x1b[?1002h'); // app enables drag mouse tracking (mock parses this)
  term.__setLine(0, '> ');
  term.__setCursor(2, 0);
  term.emitData('x');
  term.emitWriteParsed();
  term.emitData('\r');
  expect(inputLines).toEqual([]);
  expect(submitted).toEqual([]);
  // App exits and releases the mouse — suggestions recover.
  term.write('\x1b[?1002l');
  term.__setLine(0, '$ ');
  term.__setCursor(2, 0);
  term.emitData('l');
  term.__setLine(0, '$ ls');
  term.__setCursor(4, 0);
  term.emitData('\r');
  expect(submitted).toEqual(['ls']);
});

test('param-less CSI > m (XTMODKEYS reset) heals stuck modifyOtherKeys suppression', () => {
  const { term, submitted } = makeEngine();
  term.csiHandlers['>m']([4, 2]); // app enables modifyOtherKeys level 2
  term.__setLine(0, '$ ');
  term.__setCursor(2, 0);
  term.emitData('x');
  term.emitData('\r');
  expect(submitted).toEqual([]); // suppressed while the protocol is active
  term.csiHandlers['>m']([]); // app exits via param-less reset (not `>4;0m`)
  term.__setLine(0, '$ ');
  term.__setCursor(2, 0);
  term.emitData('l');
  term.__setLine(0, '$ ls');
  term.__setCursor(4, 0);
  term.emitData('\r');
  expect(submitted).toEqual(['ls']); // suggestions recovered after app exit
});

test('DECSTR soft reset heals stuck Kitty flags (app exited without popping)', () => {
  const { term, submitted } = makeEngine();
  term.csiHandlers['>u']([1]); // app pushes Kitty flags on the main screen...
  term.__setLine(0, '$ ');
  term.__setCursor(2, 0);
  term.emitData('x');
  term.emitData('\r');
  expect(submitted).toEqual([]); // ...and suggestions are suppressed
  term.csiHandlers['p']([]); // app exits via DECSTR (never pops its flags)
  term.__setLine(0, '$ ');
  term.__setCursor(2, 0);
  term.emitData('g');
  term.__setLine(0, '$ git status');
  term.__setCursor(12, 0);
  term.emitData('\r');
  expect(submitted).toEqual(['git status']); // stuck flags healed
});

test('setting off disables capture', () => {
  const { term, submitted } = makeEngine({ commandSuggestions: () => false });
  term.__setLine(0, 'PS> ');
  term.__setCursor(4, 0);
  term.emitData('l');
  term.__setLine(0, 'PS> ls');
  term.__setCursor(6, 0);
  term.emitData('\r');
  expect(submitted).toEqual([]);
});

test('popup keys: closed intercepts nothing; passive maps Down/Shift+Enter/Esc; focused maps arrows/Enter', () => {
  const { engine, term, actions } = makeEngine();
  // closed: everything passes through (handler returns true).
  expect(term.keyHandler!(key('ArrowDown'))).toBe(true);
  expect(actions).toEqual([]);

  engine.setSuggestPopupState('passive');
  expect(term.keyHandler!(key('ArrowDown'))).toBe(false);
  expect(term.keyHandler!(key('Enter', { shiftKey: true }))).toBe(false);
  expect(term.keyHandler!(key('Escape'))).toBe(false);
  expect(term.keyHandler!(key('ArrowUp'))).toBe(true); // shell history untouched
  expect(term.keyHandler!(key('Enter'))).toBe(true); // plain Enter runs the command
  expect(actions).toEqual(['focus', 'accept', 'dismiss']);

  engine.setSuggestPopupState('focused');
  expect(term.keyHandler!(key('ArrowUp'))).toBe(false);
  expect(term.keyHandler!(key('Enter'))).toBe(false);
  expect(term.keyHandler!(key('Delete', { shiftKey: true }))).toBe(false); // remove entry
  expect(term.keyHandler!(key('Delete'))).toBe(true); // plain Delete -> shell
  expect(actions).toEqual(['focus', 'accept', 'dismiss', 'up', 'accept', 'delete']);
});

test('passive Shift+Enter is intercepted BEFORE the Shift+Enter->LF shim (no \\n write)', () => {
  const { engine, term, writes } = makeEngine();
  engine.setSuggestPopupState('passive');
  term.keyHandler!(key('Enter', { shiftKey: true }));
  expect(writes.find(([, data]) => data === '\n')).toBeUndefined();
});

test('Shift+Enter LF shim (popup closed) submits the capture like Enter', () => {
  const { term, submitted } = makeEngine();
  term.__setLine(0, '$ ');
  term.__setCursor(2, 0);
  term.emitData('l');
  term.__setLine(0, '$ ls -la');
  term.__setCursor(8, 0);
  term.emitWriteParsed();
  term.keyHandler!(key('Enter', { shiftKey: true }));
  expect(submitted).toEqual(['ls -la']);
});

test('insertCommand erases mark->cursor distance with DELs then writes the command', () => {
  const { engine, term, writes } = makeEngine();
  term.__setLine(0, 'PS> ');
  term.__setCursor(4, 0);
  term.emitData('d');
  term.__setLine(0, 'PS> dot');
  term.__setCursor(7, 0);
  engine.insertCommand('dotnet build');
  const last = writes[writes.length - 1];
  expect(last[1]).toBe('\x7f'.repeat(3) + 'dotnet build');
});

test('Ctrl+L (\\x0c) skips capturing the redrawn line; the NEXT command captures cleanly', () => {
  const { term, submitted } = makeEngine();
  term.__setLine(5, '$ ');
  term.__setCursor(2, 5);
  term.emitData('g'); // typed "git st", then Ctrl+L
  term.emitData('\x0c'); // readline redraws the prompt WITH "git st" intact
  term.__setLine(0, '$ git st');
  term.__setCursor(8, 0);
  term.emitData('a'); // must NOT re-mark mid-line (would capture "atus")
  term.__setLine(0, '$ git status');
  term.__setCursor(12, 0);
  term.emitData('\r'); // this command is SKIPPED (clean miss, not a fragment)
  expect(submitted).toEqual([]);
  // The next command captures normally again.
  term.__setLine(1, '$ ');
  term.__setCursor(2, 1);
  term.emitData('l');
  term.__setLine(1, '$ ls');
  term.__setCursor(4, 1);
  term.emitData('\r');
  expect(submitted).toEqual(['ls']);
});

test('stale mark self-heals with suppression: no fragment stored, next command captures', () => {
  const { term, inputLines, submitted } = makeEngine();
  term.__setLine(5, '$ ');
  term.__setCursor(2, 5);
  term.emitData('x'); // mark at row 5
  term.__setCursor(0, 0); // prompt redrawn above the mark (e.g. full clear from PTY)
  term.emitWriteParsed(); // read is invalid -> self-heal cancels + suppresses
  expect(inputLines).toEqual([]);
  term.__setLine(0, '$ x-still-pending');
  term.__setCursor(17, 0);
  term.emitData('\r'); // suppressed submit: nothing stored
  expect(submitted).toEqual([]);
  term.__setLine(1, '$ ');
  term.__setCursor(2, 1);
  term.emitData('g'); // fresh mark after the skipped submit
  term.__setLine(1, '$ git status');
  term.__setCursor(12, 1);
  term.emitData('\r');
  expect(submitted).toEqual(['git status']);
});

test('resize invalidates the mark and closes the popup (clean miss, then recovery)', () => {
  const { term, inputLines, submitted } = makeEngine();
  term.__setLine(0, '$ ');
  term.__setCursor(2, 0);
  term.emitData('g');
  term.__setLine(0, '$ git st');
  term.__setCursor(8, 0);
  term.emitWriteParsed();
  expect(inputLines).toEqual(['git st']);
  term.emitResize(100, 30); // reflow shifts absolute rows — mark untranslatable
  expect(inputLines).toEqual(['git st', '']); // popup closed
  term.emitData('\r'); // skipped (suppressed)
  expect(submitted).toEqual([]);
  term.__setLine(1, '$ ');
  term.__setCursor(2, 1);
  term.emitData('l');
  term.__setLine(1, '$ ls');
  term.__setCursor(4, 1);
  term.emitData('\r');
  expect(submitted).toEqual(['ls']);
});

test('no capture while an app has focus-event reporting on (claude inline REPL)', () => {
  const { term, inputLines, submitted } = makeEngine();
  // claude's inline REPL enables neither alt-screen, kitty, nor mouse tracking in
  // unrecognized terminals — DECSET 1004 is its only detectable signal.
  term.write('\x1b[?1004h');
  term.__setLine(0, '> ');
  term.__setCursor(2, 0);
  term.emitData('x');
  term.__setLine(0, '> x'); // claude echoes into its input box
  term.__setCursor(3, 0);
  term.emitWriteParsed();
  term.emitData('\r');
  expect(inputLines).toEqual([]);
  expect(submitted).toEqual([]);
  // App exits and turns focus reporting off — suggestions recover.
  term.write('\x1b[?1004l');
  term.__setLine(1, '$ ');
  term.__setCursor(2, 1);
  term.emitData('l');
  term.__setLine(1, '$ ls');
  term.__setCursor(4, 1);
  term.emitData('\r');
  expect(submitted).toEqual(['ls']);
});

// Startup signals per agent CLI (raw capture 2026-07-02; alt-screen omitted
// where enabled — fewer simulated signals = stronger test). CAVEAT: on Windows
// the 1004 in those captures came from ConPTY itself (it asserts focus
// reporting for EVERY session), so these entries model the macOS/Linux mode
// story, where sendFocusMode is honored. On Windows suppression comes from the
// prompt gate (tests below).
const AGENT_CLI_STARTUP: Array<[string, (t: MockTerminal) => void]> = [
  ['claude', (t) => t.write('\x1b[?1004h')],
  ['codex', (t) => t.write('\x1b[?1004h')],
  ['copilot', (t) => { t.write('\x1b[?1003h\x1b[?1004h'); t.csiHandlers['>m']([4, 2]); }],
  ['agy', (t) => { t.write('\x1b[?1004h'); t.csiHandlers['>m']([4, 2]); }],
  ['opencode', (t) => { t.write('\x1b[?1002h\x1b[?1004h'); t.csiHandlers['>m']([4, 2]); }],
];

test.each(AGENT_CLI_STARTUP)(
  '%s startup modes suppress capture and the popup (input never reaches history)',
  (_name, emitStartupModes) => {
    const { term, inputLines, submitted } = makeEngine();
    emitStartupModes(term);
    term.__setLine(0, '> ');
    term.__setCursor(2, 0);
    term.emitData('d'); // user types an instruction into the agent's input box
    term.__setLine(0, '> do the thing');
    term.__setCursor(14, 0);
    term.emitWriteParsed();
    term.emitData('\r');
    expect(inputLines).toEqual([]); // popup never fed
    expect(submitted).toEqual([]); // history never fed
  },
);

// --- Prompt gate: the load-bearing suppression on Windows, where mode
// sniffing fails (ConPTY asserts DECSET 1004 for every session and codex
// asserts no discriminating mode at its composer). The injected pwsh hook
// emits OSC 9;9 at every prompt render; while an agent CLI owns the pty no
// prompt renders, so capture stays disarmed. ---------------------------------

test('prompt gate: input typed into an agent CLI is never captured (codex composer)', () => {
  const { term, inputLines, submitted } = makeEngine();
  term.oscHandlers[9]('9;C:\\repo'); // shell prompt renders -> hook proves itself
  term.__setLine(0, 'PS> ');
  term.__setCursor(4, 0);
  term.emitData('c');
  term.__setLine(0, 'PS> codex');
  term.__setCursor(9, 0);
  term.emitWriteParsed();
  term.emitData('\r'); // launch codex — the command itself IS captured
  expect(submitted).toEqual(['codex']);
  // codex owns the pty now (no prompt OSC). Typing into its composer:
  term.__setLine(1, '> ');
  term.__setCursor(2, 1);
  term.emitData('c');
  term.__setLine(1, '> cd');
  term.__setCursor(4, 1);
  term.emitWriteParsed();
  term.emitData('\r');
  expect(submitted).toEqual(['codex']); // nothing captured
  expect(inputLines[inputLines.length - 1] ?? '').toBe(''); // popup never fed
  // codex exits -> shell prompt renders -> capture re-arms.
  term.oscHandlers[9]('9;C:\\repo');
  term.__setLine(2, 'PS> ');
  term.__setCursor(4, 2);
  term.emitData('l');
  term.__setLine(2, 'PS> ls');
  term.__setCursor(6, 2);
  term.emitData('\r');
  expect(submitted).toEqual(['codex', 'ls']);
});

test('prompt gate: disarmed type-ahead skips one command instead of a fragment', () => {
  const { term, submitted } = makeEngine();
  term.oscHandlers[9]('9;C:\\repo');
  term.__setLine(0, '$ ');
  term.__setCursor(2, 0);
  term.emitData('s');
  term.__setLine(0, '$ sleep 5');
  term.__setCursor(9, 0);
  term.emitData('\r');
  expect(submitted).toEqual(['sleep 5']);
  term.emitData('git st'); // type-ahead while the command still runs
  term.oscHandlers[9]('9;C:\\repo'); // prompt renders; PSReadLine echoes "git st"
  term.__setLine(1, '$ git st');
  term.__setCursor(8, 1);
  term.emitData('a'); // user finishes the word — a mark here would sit mid-line
  term.__setLine(1, '$ git sta');
  term.__setCursor(9, 1);
  term.emitData('\r');
  expect(submitted).toEqual(['sleep 5']); // clean miss, no "a" tail fragment
  term.oscHandlers[9]('9;C:\\repo');
  term.__setLine(2, '$ ');
  term.__setCursor(2, 2);
  term.emitData('l');
  term.__setLine(2, '$ ls');
  term.__setCursor(4, 2);
  term.emitData('\r');
  expect(submitted).toEqual(['sleep 5', 'ls']); // and capture resumes cleanly
});

test('Windows: ConPTY-noise focus reporting does NOT suppress capture at a prompt', () => {
  const { term, submitted } = makeEngine({ isWindows: true });
  term.oscHandlers[9]('9;C:\\repo'); // prompt rendered (armed)
  term.write('\x1b[?1004h'); // ConPTY asserts this for every session on Windows
  term.__setLine(0, 'PS> ');
  term.__setCursor(4, 0);
  term.emitData('g');
  term.__setLine(0, 'PS> git status');
  term.__setCursor(14, 0);
  term.emitData('\r');
  expect(submitted).toEqual(['git status']); // 1004 ignored on Windows
});

test('prompt-render OSC heals stuck focus-event mode after a CLI is killed', () => {
  const { term, submitted } = makeEngine();
  term.write('\x1b[?1004h'); // claude enables focus reporting...
  term.__setLine(0, '$ ');
  term.__setCursor(2, 0);
  term.emitData('x');
  term.emitData('\r');
  expect(submitted).toEqual([]); // ...and dies WITHOUT writing 1004l
  // Shell renders its prompt: the injected hook emits OSC 9;9 <cwd>.
  term.oscHandlers[9]('9;C:\\Users\\dev');
  expect(term.modes.sendFocusMode).toBe(false); // engine flipped the mode off
  term.__setLine(1, '$ ');
  term.__setCursor(2, 1);
  term.emitData('l');
  term.__setLine(1, '$ ls');
  term.__setCursor(4, 1);
  term.emitData('\r');
  expect(submitted).toEqual(['ls']);
});

test('prompt-render OSC heals stuck Kitty flags after a TUI exits uncleanly', () => {
  const { term, submitted } = makeEngine();
  term.csiHandlers['>u']([1]); // claude pushes Kitty flags on the main screen...
  term.__setLine(0, '$ ');
  term.__setCursor(2, 0);
  term.emitData('x');
  term.emitData('\r');
  expect(submitted).toEqual([]); // ...and exits WITHOUT popping (no CSI<u, no DECSTR)
  // Shell renders its prompt: pty_manager's PowerShell hook emits OSC 9;9 <cwd>.
  term.oscHandlers[9]('9;C:\\Users\\dev');
  term.__setLine(1, '$ ');
  term.__setCursor(2, 1);
  term.emitData('l');
  term.__setLine(1, '$ ls');
  term.__setCursor(4, 1);
  term.emitData('\r');
  expect(submitted).toEqual(['ls']); // suggestions recovered at the prompt
});

test('OSC 9 progress (9;4) from a LIVE TUI does not heal (only the cwd form is a prompt)', () => {
  const { term, submitted } = makeEngine();
  term.csiHandlers['>u']([1]); // TUI active with Kitty flags
  term.oscHandlers[9]('4;1;50'); // Windows Terminal progress, emitted mid-run
  term.__setLine(0, '> ');
  term.__setCursor(2, 0);
  term.emitData('x');
  term.emitData('\r');
  expect(submitted).toEqual([]); // still suppressed — the TUI is alive
});

test('cross-window detach: initialPromptGate suppresses agent-CLI input on first mount in a new window', () => {
  const cacheKey = 'detach-shared-key';
  // Window A: shell prompt renders, user launches claude while the gate is armed.
  const { term: termA, submitted: submittedA } = makeEngine({ cacheKey });
  termA.oscHandlers[9]('9;C:\\repo');
  termA.__setLine(0, 'PS> ');
  termA.__setCursor(4, 0);
  termA.emitData('c');
  termA.__setLine(0, 'PS> claude');
  termA.__setCursor(10, 0);
  termA.emitData('\r');
  expect(submittedA).toEqual(['claude']);
  // claude now owns the pty; Enter consumed the arm (seen stays true, armed false).
  const gate = terminalCache.get(cacheKey)?.promptGate;
  expect(gate).toEqual({ seen: true, armed: false });

  // Detach: a new window is a separate JS heap, so its terminalCache Map starts
  // empty for this cacheKey even though the same backend PTY (still running
  // claude) is reattached to it.
  terminalCache.delete(cacheKey);

  // Window B mounts fresh, carrying the captured gate through the detach payload
  // (the fix under test). No OSC has been seen in this window — without the
  // fix, the engine falls back to its false/false default and the "hookless
  // shell" ungated path captures every keystroke into the still-running claude
  // composer.
  const { term: termB, inputLines, submitted: submittedB } = makeEngine({
    cacheKey,
    initialPromptGate: gate,
  });
  // The handoff must land back in THIS window's cache entry too (not just this
  // engine instance's in-memory fields) — a second consecutive detach, before any
  // OSC/Enter event refreshes it, reads the gate from the cache, not from here.
  expect(terminalCache.get(cacheKey)?.promptGate).toEqual({ seen: true, armed: false });
  termB.__setLine(0, '> ');
  termB.__setCursor(2, 0);
  termB.emitData('f');
  termB.__setLine(0, '> f');
  termB.__setCursor(3, 0);
  termB.emitWriteParsed();
  termB.emitData('o');
  termB.__setLine(0, '> fo');
  termB.__setCursor(4, 0);
  termB.emitWriteParsed();
  termB.emitData('\r');
  expect(submittedB).toEqual([]); // claude's composer text must never be captured
  expect(inputLines[inputLines.length - 1] ?? '').toBe(''); // popup never fed
});

test('bare ESC does NOT cancel the mark (vi-mode command mode keeps the line)', () => {
  const { term, submitted } = makeEngine();
  term.__setLine(0, '$ ');
  term.__setCursor(2, 0);
  term.emitData('g');
  term.__setLine(0, '$ git status');
  term.__setCursor(12, 0);
  term.emitData('\x1b'); // vi-mode: enter command mode, line stays
  term.emitData('\r');
  expect(submitted).toEqual(['git status']);
});

test('submit includes wrapped rows BELOW the cursor (Home + Enter)', () => {
  const { term, submitted } = makeEngine();
  term.__setLine(0, '$ ');
  term.__setCursor(2, 0);
  term.emitData('g');
  // Echo: command wraps onto row 1; user pressed Home so the cursor is on row 0.
  term.__setLine(0, '$ git clone ');
  term.__setLine(1, 'https://x.git', true);
  term.__setCursor(2, 0);
  term.emitData('\r');
  expect(submitted).toEqual(['git clone https://x.git']);
});

test('accepting a suggestion does not reopen the popup from its own echo', () => {
  const { engine, term, inputLines } = makeEngine();
  term.__setLine(0, '$ ');
  term.__setCursor(2, 0);
  term.emitData('g');
  term.__setLine(0, '$ git');
  term.__setCursor(5, 0);
  term.emitWriteParsed();
  expect(inputLines).toEqual(['git']);
  engine.setSuggestPopupState('passive');
  engine.insertCommand('git status'); // accept; host closes the popup
  engine.setSuggestPopupState('closed');
  term.__setLine(0, '$ git status'); // the inserted command's echo lands
  term.__setCursor(12, 0);
  term.emitWriteParsed();
  // No new emission: the echo text equals the inserted command (deduped), so
  // the host never reopens the popup with e.g. "git status --short".
  expect(inputLines).toEqual(['git']);
});

test('Enter keydown auto-repeat right after an accept is swallowed (never runs the command)', () => {
  const { engine, term, writes } = makeEngine();
  term.__setLine(0, '$ ');
  term.__setCursor(2, 0);
  term.emitData('g');
  engine.setSuggestPopupState('passive');
  engine.insertCommand('git status'); // accept (sets the guard timestamp)
  engine.setSuggestPopupState('closed');
  const writesBefore = writes.length;
  // Held Shift+Enter's auto-repeat arrives with the popup already closed.
  expect(term.keyHandler!(key('Enter', { shiftKey: true }))).toBe(false);
  expect(term.keyHandler!(key('Enter'))).toBe(false);
  expect(writes.length).toBe(writesBefore); // no LF/CR reached the PTY
});

test('multi-byte ESC sequences (F-keys, Ctrl+Arrow) do NOT plant a mark', () => {
  const { term, inputLines, submitted } = makeEngine();
  term.__setLine(0, '$ ');
  term.__setCursor(2, 0);
  term.emitData('\x1b[1;5C'); // Ctrl+Right word-nav
  term.emitData('\x1b[15~'); // F5
  term.__setLine(0, '$ async output redrew this');
  term.emitWriteParsed(); // no mark -> nothing emitted
  expect(inputLines).toEqual([]);
  term.emitData('\r');
  expect(submitted).toEqual([]);
});

test('bracketed-paste chunk DOES plant a mark (single-line paste captures)', () => {
  const { term, submitted } = makeEngine();
  term.__setLine(0, '$ ');
  term.__setCursor(2, 0);
  term.emitData('\x1b[200~dotnet build\x1b[201~'); // paste without newline
  term.__setLine(0, '$ dotnet build');
  term.__setCursor(14, 0);
  term.emitWriteParsed();
  term.emitData('\r');
  expect(submitted).toEqual(['dotnet build']);
});

test('scrolling AWAY from the bottom dismisses an open popup (emits empty input line)', () => {
  const { engine, term, inputLines } = makeEngine();
  term.buffer.active.baseY = 10; // scrollback exists; bottom page starts at 10
  term.buffer.active.viewportY = 10;
  term.__setLine(10, '$ ');
  term.__setCursor(2, 0);
  term.emitData('d');
  term.__setLine(10, '$ dot');
  term.__setCursor(5, 0);
  term.emitWriteParsed();
  expect(inputLines).toEqual(['dot']);
  engine.setSuggestPopupState('passive'); // host opened the popup
  term.emitScroll(4); // user scrolls up: viewportY 4 < baseY 10
  expect(inputLines).toEqual(['dot', '']);
});

test('output autoscroll (viewport pinned to bottom) does NOT dismiss the popup', () => {
  const { engine, term, inputLines } = makeEngine();
  term.buffer.active.baseY = 10;
  term.buffer.active.viewportY = 10;
  term.__setLine(10, '$ ');
  term.__setCursor(2, 0);
  term.emitData('d');
  term.__setLine(10, '$ dot');
  term.__setCursor(5, 0);
  term.emitWriteParsed();
  engine.setSuggestPopupState('passive');
  term.buffer.active.baseY = 11; // a wrapped line / output pushed the buffer
  term.emitScroll(11); // viewport follows the bottom (pinned)
  expect(inputLines).toEqual(['dot']); // no dismissal — popup stays anchored
});

test('mid-line cursor: insertCommand moves to end then erases the WHOLE input', () => {
  const { engine, term, writes } = makeEngine();
  term.__setLine(0, 'PS> ');
  term.__setCursor(4, 0);
  term.emitData('g');
  term.__setLine(0, 'PS> git status');
  term.__setCursor(8, 0); // cursor mid-text: "git |status" (4 before, 6 after)
  engine.insertCommand('git stash');
  const last = writes[writes.length - 1];
  // Right x6 to reach the end, DEL x10 to erase "git status", then the command —
  // no right-of-cursor suffix may survive (was the `git stashstatus` corruption).
  expect(last[1]).toBe('\x1b[C'.repeat(6) + '\x7f'.repeat(10) + 'git stash');
});

test('remount then attach to a NEW process clears the cached mark (no cross-shell leak)', () => {
  const { engine, term, submitted } = makeEngine();
  term.__setLine(0, '$ ');
  term.__setCursor(2, 0);
  term.emitData('g'); // mark planted for pid-1
  engine.unmount(); // mark saved to the cache entry

  const engine2 = new (engine.constructor as typeof TerminalEngine)(
    {
      onData: () => ({ dispose() {} }),
      onExit: () => ({ dispose() {} }),
      write: () => {},
      resize: () => {},
    } as unknown as TerminalBridge,
    {
      cacheKey: (engine as unknown as { cacheKey: string }).cacheKey,
      commandSuggestions: () => true,
      onCommandSubmitted: (c: string) => submitted.push(c),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  );
  engine2.mount(makeContainer()); // restores the cached mark...
  engine2.attach('pid-2'); // ...but the process changed: mark must be cleared
  term.__setLine(0, '$ leftover-from-old-shell');
  term.__setCursor(25, 0);
  term.emitData('\r');
  expect(submitted).toEqual([]); // stale mark from pid-1 must not capture
});

test('mark survives unmount/remount via the cache entry (tab switch mid-typing)', () => {
  const { engine, term, submitted } = makeEngine();
  term.__setLine(0, '$ ');
  term.__setCursor(2, 0);
  term.emitData('g'); // mark at col 2
  term.__setLine(0, '$ git clone ');
  term.__setCursor(12, 0);
  engine.unmount(); // tab switch away — mark saved to the cache entry

  // Remount with a NEW engine instance on the SAME cacheKey (same cached Terminal).
  const engine2 = new (engine.constructor as typeof TerminalEngine)(
    {
      onData: () => ({ dispose() {} }),
      onExit: () => ({ dispose() {} }),
      write: () => {},
      resize: () => {},
    } as unknown as TerminalBridge,
    {
      cacheKey: (engine as unknown as { cacheKey: string }).cacheKey,
      commandSuggestions: () => true,
      onCommandSubmitted: (c: string) => submitted.push(c),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  );
  engine2.mount(makeContainer());
  engine2.attach('pid-1');
  term.__setLine(0, '$ git clone https://x.git');
  term.__setCursor(25, 0);
  term.emitData('\r'); // finish the command after switching back
  expect(submitted).toEqual(['git clone https://x.git']);
});

test('attach to a NEW process resets capture state (no stale mark)', () => {
  const { engine, term, submitted } = makeEngine();
  term.__setLine(0, '$ ');
  term.__setCursor(2, 0);
  term.emitData('x'); // mark planted for pid-1
  engine.attach('pid-2'); // shell restarted in place
  term.__setLine(0, '$ garbage-from-old-shell');
  term.__setCursor(24, 0);
  term.emitData('\r'); // Enter right after reattach
  expect(submitted).toEqual([]); // old mark must not produce a capture
});
