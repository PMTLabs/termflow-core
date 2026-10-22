import { decideKeyBytes, deliverBroadcast, describe as describeKey, type KeyCtx } from '../broadcast';
import { terminalCache } from '../cache';
import { makeEngine, event } from '../testSupport/broadcastHarness';
import { realXtermKeyboard } from '../testSupport/realXtermKeyboard';

// The legacy oracle executes the shipped xterm bundle, never plainEncode.
const navigation = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete', ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`)];
const cases: Array<[string, KeyboardEventInit]> = [
  ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('').map(key => [key, { shiftKey: /^[A-Z]$/.test(key) }] as [string, KeyboardEventInit]),
  ...['Enter', 'Backspace', 'Tab', 'Escape', ...navigation].map(key => [key, {}] as [string, KeyboardEventInit]),
  ...'abcdefghijklmnopqrstuvwxyz '.split('').map(key => [key, { ctrlKey: true }] as [string, KeyboardEventInit]),
  ...['[', '\\', ']', '^'].map(key => [key, { ctrlKey: true }] as [string, KeyboardEventInit]),
  ['Enter', { shiftKey: true }], ['Enter', { ctrlKey: true }], ['Enter', { altKey: true }],
  ['Tab', { shiftKey: true }], ['Tab', { altKey: true, shiftKey: true }],
  ['Backspace', { ctrlKey: true }], ['Backspace', { altKey: true }],
  ['a', { metaKey: true }], ['x', { altKey: true }],
  ...navigation.flatMap(key => Array.from({ length: 15 }, (_, index): [string, KeyboardEventInit] => {
    const mask = index + 1;
    return [key, { shiftKey: !!(mask & 1), altKey: !!(mask & 2), ctrlKey: !!(mask & 4), metaKey: !!(mask & 8) }];
  })),
];
const modes = ['plain', 'kitty1', 'kitty3', 'win32', 'modify1', 'modify2'];
test('R1.10 parity inventory is 458 cases with every nonzero modifier mask for all 22 navigation/function keys', () => {
  expect(cases).toHaveLength(458);
  expect(navigation).toHaveLength(22);
  for (const key of navigation) {
    const masks = cases.filter(([name]) => name === key).map(([, mods]) =>
      Number(!!mods.shiftKey) + 2 * Number(!!mods.altKey) + 4 * Number(!!mods.ctrlKey) + 8 * Number(!!mods.metaKey));
    expect([...new Set(masks)].sort((a, b) => a - b)).toEqual(Array.from({ length: 16 }, (_, i) => i));
  }
});
afterEach(() => { for (const entry of terminalCache.values()) entry.disposables.forEach(fn => fn()); terminalCache.clear(); document.body.innerHTML = ''; });

describe.each(['pwsh', 'bash'])('%s engine parity', shell => {
  describe.each([false, true])('isMac=%s', isMac => {
    test.each(modes)(`%s: ${cases.length} press/release pairs × both buffers × both cursor modes`, mode => {
      const { term, write, engine } = makeEngine('parity', shell, isMac);
      const real = realXtermKeyboard(isMac);
      if (mode.startsWith('kitty')) {
        term.csiHandlers['>u']([mode === 'kitty1' ? 1 : 3]);
        term.__setBufferType('alternate'); term.csiHandlers['>u']([mode === 'kitty1' ? 1 : 3]);
        term.__setBufferType('normal');
      }
      if (mode.startsWith('modify')) term.csiHandlers['>m']([4, Number(mode.slice(-1))]);
      if (mode === 'win32') term.csiHandlers['?h']([9001]);
      try {
        for (const normal of [true, false]) for (const cursor of [false, true]) for (const [key, options] of cases) {
          term.__setBufferType(normal ? 'normal' : 'alternate'); term.applicationCursorKeysMode = cursor;
          write.mockClear(); (engine as any).uiClaimedKeydownKeys.clear(); (engine as any).ctrlCTimestamps = [];
          const snapshot = terminalCache.get('parity')!.kbState!.snapshot();
          const ctx: KeyCtx = { kbSnapshot: snapshot, protocolActive: !!(snapshot.kittyFlags || snapshot.modifyOtherKeys),
            win32Active: mode === 'win32' && !isMac, isMac, isWindows: !isMac, shellType: shell,
            applicationCursorKeys: cursor, normalBuffer: normal };
          const down = event(key, options);
          const passthrough = term.keyHandler!(down);
          const source = write.mock.calls.length ? write.mock.calls[0][1] : passthrough ? real.bytes(down, cursor) : null;
          const identity = { key, options, normal, cursor, mode, isMac, shell };
          expect({ ...identity, bytes: decideKeyBytes(describeKey(down), ctx) }).toEqual({ ...identity, bytes: source });
          write.mockClear();
          deliverBroadcast('parity', { kind: 'key', key: describeKey(down), srcBytes: source ?? '' });
          expect({ ...identity, delivered: write.mock.calls.length ? write.mock.calls[0][1] : null }).toEqual({ ...identity, delivered: source });
          write.mockClear();
          const up = event(key, { ...options, type: 'keyup' }); term.keyHandler!(up);
          expect({ ...identity, release: decideKeyBytes(describeKey(up), ctx) })
            .toEqual({ ...identity, release: write.mock.calls.length ? write.mock.calls[0][1] : null });
        }
      } finally { real.dispose(); }
    });
  });
});
