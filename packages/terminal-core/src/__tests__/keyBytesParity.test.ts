import { decideKeyBytes, describe as describeKey, type KeyCtx } from '../broadcast';
import { terminalCache } from '../cache';
import { makeEngine, event } from '../testSupport/broadcastHarness';

// Independent legacy oracle for xterm's return-true path, NOT plainEncode.
const cases: Array<[string, KeyboardEventInit, string | null]> = [
  ...'abcdefghijklmnopqrstuvwxyz0123456789'.split('').map(key => [key, {}, key] as [string, KeyboardEventInit, string]),
  ['Enter', {}, '\r'], ['Enter', { shiftKey: true }, '\r'],
  ['Backspace', {}, '\x7f'], ['Tab', {}, '\t'], ['Tab', { shiftKey: true }, '\x1b[Z'],
  ['Escape', {}, '\x1b'], ['ArrowUp', {}, '\x1b[A'], ['ArrowDown', {}, '\x1b[B'],
  ['ArrowRight', {}, '\x1b[C'], ['ArrowLeft', {}, '\x1b[D'],
  ['Home', {}, '\x1b[H'], ['End', {}, '\x1b[F'], ['PageUp', {}, '\x1b[5~'],
  ['PageDown', {}, '\x1b[6~'], ['Insert', {}, '\x1b[2~'], ['Delete', {}, '\x1b[3~'],
  ['F1', {}, '\x1bOP'], ['F2', {}, '\x1bOQ'], ['F3', {}, '\x1bOR'], ['F4', {}, '\x1bOS'],
  ['F5', {}, '\x1b[15~'], ['F6', {}, '\x1b[17~'], ['F7', {}, '\x1b[18~'],
  ['F8', {}, '\x1b[19~'], ['F9', {}, '\x1b[20~'], ['F10', {}, '\x1b[21~'],
  ['F11', {}, '\x1b[23~'], ['F12', {}, '\x1b[24~'],
  ['c', { ctrlKey: true }, '\x03'], ['j', { ctrlKey: true }, '\n'],
  ['[', { ctrlKey: true }, '\x1b'], ['\\', { ctrlKey: true }, '\x1c'],
  [']', { ctrlKey: true }, '\x1d'], ['^', { ctrlKey: true }, '\x1e'],
  ['x', { altKey: true }, '\x1bx'],
  ['Backspace', { ctrlKey: true }, '\x08'], ['Delete', { ctrlKey: true }, '\x1b[3;5~'],
];
afterEach(() => { for (const entry of terminalCache.values()) entry.disposables.forEach(fn => fn()); terminalCache.clear(); document.body.innerHTML = ''; });

describe.each(['pwsh', 'bash'])('%s engine parity', shell => {
  test.each(['plain', 'kitty1', 'kitty3', 'win32'])('%s real handler matches target decision across 73 key press/release pairs', mode => {
    const { term, write, engine } = makeEngine('parity', shell);
    if (mode.startsWith('kitty')) {
      term.csiHandlers['>u']([mode === 'kitty1' ? 1 : 3]);
      term.__setBufferType('alternate');
      term.csiHandlers['>u']([mode === 'kitty1' ? 1 : 3]);
      term.__setBufferType('normal');
    }
    if (mode === 'win32') term.csiHandlers['?h']([9001]);
    const ctx: KeyCtx = {
      kbSnapshot: terminalCache.get('parity')!.kbState!.snapshot(), protocolActive: mode.startsWith('kitty'),
      win32Active: mode === 'win32', isMac: false, isWindows: true, shellType: shell,
      applicationCursorKeys: false, normalBuffer: true,
    };
    for (const [key, options, oracle] of cases) {
      write.mockClear();
      (engine as any).uiClaimedKeydownKeys.clear();
      (engine as any).ctrlCTimestamps = [];
      // Viewport scrolling is a UI action, not a byte decision. Exercise page keys in a TUI.
      const normal = !['PageUp', 'PageDown'].includes(key);
      term.__setBufferType(normal ? 'normal' : 'alternate');
      const e = event(key, options);
      const passthrough = term.keyHandler!(e);
      const source = write.mock.calls.length ? write.mock.calls[0][1] : passthrough ? oracle : null;
      expect({ key, options, bytes: decideKeyBytes(describeKey(e), { ...ctx, normalBuffer: normal }) })
        .toEqual({ key, options, bytes: source });
      write.mockClear();
      const up = event(key, { ...options, type: 'keyup' });
      term.keyHandler!(up);
      expect({ key, options, release: decideKeyBytes(describeKey(up), { ...ctx, normalBuffer: normal }) })
        .toEqual({ key, options, release: write.mock.calls.length ? write.mock.calls[0][1] : null });
    }
  });
});
test('mac Cmd/Option shims match the real handler in normal and alternate buffers', () => {
  const { term, write } = makeEngine('mac', 'zsh', true);
  for (const normal of [true, false]) for (const meta of [true, false]) for (const key of ['ArrowLeft', 'ArrowRight']) {
    term.__setBufferType(normal ? 'normal' : 'alternate'); write.mockClear();
    const e = event(key, { metaKey: meta, altKey: !meta });
    term.keyHandler!(e);
    expect(decideKeyBytes(describeKey(e), { kbSnapshot: { kittyFlags: 0, modifyOtherKeys: 0 }, protocolActive: false,
      win32Active: false, isMac: true, isWindows: false, applicationCursorKeys: false, normalBuffer: normal }))
      .toBe(write.mock.calls[0][1]);
  }
});
