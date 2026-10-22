import { decideKeyBytes, deliverBroadcast, describe, setBroadcastSink, toEventLike } from '../broadcast';
import { terminalCache, pasteToTerminal } from '../cache';
import { encodeWin32Key } from '../win32InputMode';
import { makeEngine, event } from '../testSupport/broadcastHarness';

const plain = { kbSnapshot: { kittyFlags: 0, modifyOtherKeys: 0 as const }, protocolActive: false, win32Active: false, isWindows: true, isMac: false, applicationCursorKeys: false };
afterEach(() => { setBroadcastSink(null); for (const entry of terminalCache.values()) entry.disposables.forEach(fn => fn()); terminalCache.clear(); document.body.innerHTML = ''; });

test.each([['a', 'a'], ['Enter', '\r'], ['Backspace', '\x7f'], ['ArrowUp', '\x1b[A']])('Win32 source to Kitty flags 1 target does not drop %s', (key, bytes) => {
  const { write } = makeEngine('target');
  terminalCache.get('target')!.kbState!.pushFlags(1);
  deliverBroadcast('target', { kind: 'key', key: describe(event(key)), srcBytes: 'win32 record' });
  expect(write).toHaveBeenCalledWith('pid-target', bytes);
});
test('descriptor retains virtual key and lock state for Win32', () => {
  const key = describe(event('c', { ctrlKey: true }));
  expect(key.keyCode).toBe(67);
  expect(encodeWin32Key(toEventLike(key), true)).toMatch(/^\x1b\[67;/);
  // Ctrl+C must remain the engine's raw interrupt escape hatch, not a Win32 record.
  expect(decideKeyBytes(key, { ...plain, win32Active: true })).toBe('\x03');
});
test('Kitty Shift+Enter to plain yields LF; shell-specific word delete precedes Win32', () => {
  expect(decideKeyBytes(describe(event('Enter', { shiftKey: true })), plain)).toBe('\n');
  const key = describe(event('Backspace', { ctrlKey: true }));
  expect(decideKeyBytes(key, { ...plain, shellType: 'bash', win32Active: true })).toBe('\x1b\x7f');
  expect(decideKeyBytes(key, { ...plain, shellType: 'pwsh', win32Active: true })).toBe(encodeWin32Key(toEventLike(key), true));
});
test('keyup is omitted in plain, retained for negotiated Kitty event reporting and Win32', () => {
  const key = describe(event('ArrowUp', { type: 'keyup' }));
  expect(decideKeyBytes(key, plain)).toBeNull();
  expect(decideKeyBytes(key, { ...plain, protocolActive: true, kbSnapshot: { kittyFlags: 1, modifyOtherKeys: 0 } })).toBeNull();
  expect(decideKeyBytes(key, { ...plain, protocolActive: true, kbSnapshot: { kittyFlags: 3, modifyOtherKeys: 0 } })).not.toBeNull();
  expect(decideKeyBytes(key, { ...plain, win32Active: true })).toBe(encodeWin32Key(toEventLike(key), true));
});
test('missing cache uses fallback once with plain bytes; processless target is skipped', () => {
  const fallback = jest.fn();
  setBroadcastSink(jest.fn(), fallback);
  deliverBroadcast('missing', { kind: 'key', key: describe(event('Enter')), srcBytes: 'encoded' });
  expect(fallback).toHaveBeenCalledWith('missing', '\r');
  const { write } = makeEngine('target');
  terminalCache.get('target')!.processId = undefined;
  deliverBroadcast('target', { kind: 'text', data: 'x' });
  expect(write).not.toHaveBeenCalled();
  expect(fallback).toHaveBeenCalledTimes(1);
});
test('raw paste applies exactly one target bracket pair, or none', () => {
  const a = makeEngine('a'); const b = makeEngine('b');
  a.term.bracketedPasteMode = true;
  deliverBroadcast('a', { kind: 'paste', text: 'x\ny' });
  deliverBroadcast('b', { kind: 'paste', text: 'x\ny' });
  expect(a.write).toHaveBeenCalledWith('pid-a', '\x1b[200~x\ry\x1b[201~');
  expect(b.write).toHaveBeenCalledWith('pid-b', 'x\ry');
  expect(a.term.pasted).toEqual(['x\ny']);
});
test('target exit during a queued write does not abort the fan-out', async () => {
  const fallback = jest.fn().mockRejectedValue(new Error('exited'));
  setBroadcastSink(jest.fn(), fallback);
  expect(() => deliverBroadcast('missing', { kind: 'text', data: 'x' })).not.toThrow();
  await Promise.resolve();
  expect(fallback).toHaveBeenCalledTimes(1);
});

test('cache paste emits one raw unit and never the source bracketed data', () => {
  const { term } = makeEngine(); term.bracketedPasteMode = true;
  const sink = jest.fn(); setBroadcastSink(sink);
  pasteToTerminal('source', 'x\ny');
  expect(sink).toHaveBeenCalledTimes(1);
  expect(sink).toHaveBeenCalledWith('source', { kind: 'paste', text: 'x\ny' });
});
