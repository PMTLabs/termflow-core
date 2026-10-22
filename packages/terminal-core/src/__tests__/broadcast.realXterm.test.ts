import { subscribeUserInput, setBroadcastSink, deliverBroadcast, describe, toEventLike } from '../broadcast';
import { terminalCache } from '../cache';
import { makeEngine, event } from '../testSupport/broadcastHarness';
import { realXtermKeyboard } from '../testSupport/realXtermKeyboard';
import { encodeWin32Key } from '../win32InputMode';
import { join } from 'path';

afterEach(() => { setBroadcastSink(null); for (const entry of terminalCache.values()) entry.disposables.forEach(fn => fn()); terminalCache.clear(); document.body.innerHTML = ''; });

test('R1.2 real xterm Shift+A survives keydown microtask keypress as one key unit and Win32 shifted vk65', async () => {
  const source = makeEngine('source'); const target = makeEngine('target');
  target.term.csiHandlers['?h']([9001]);
  const real = realXtermKeyboard();
  const sink = jest.fn((id, unit) => deliverBroadcast('target', unit)); setBroadcastSink(sink);
  // Run the shipped _keyDown/_keyPress with the engine's actual custom handler.
  real.terminal.attachCustomKeyEventHandler(source.term.keyHandler!);
  real.terminal.onData((data: string) => source.term._core.coreService.triggerDataEvent(data, true));
  const down = event('A', { shiftKey: true, keyCode: 65 });
  try {
    real.core._keyDown(down);
    expect(sink).not.toHaveBeenCalled();
    await Promise.resolve();
    real.core._keyPress(new KeyboardEvent('keypress', { key: 'A', charCode: 65, keyCode: 65, shiftKey: true }));
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][1]).toMatchObject({ kind: 'key', key: { key: 'A', keyCode: 65, shiftKey: true }, srcBytes: 'A' });
    expect(target.write).toHaveBeenCalledWith('pid-target', encodeWin32Key(toEventLike(describe(down)), true));
  } finally { real.dispose(); }
});

test('real xterm 6 user input fires before data, replies do not fire user input', () => {
  // Absolute bundle path deliberately bypasses the workspace's xterm mock mapper.
  const { Terminal } = require(join(process.cwd(), '../../node_modules/@xterm/xterm/lib/xterm.js'));
  const term = new Terminal();
  const order: string[] = [];
  const sub = subscribeUserInput(term, () => order.push('user'));
  expect(sub).not.toBeNull();
  term.onData(() => order.push('data'));
  term.input('x', true);
  expect(order).toEqual(['user', 'data']);
  order.length = 0;
  term.input('reply', false);
  expect(order).toEqual(['data']);
  sub!.dispose(); term.dispose();
});
