import { decideKeyBytes, describe, deliverBroadcast, plainEncode, setBroadcastSink, toEventLike } from '../broadcast';
import { terminalCache, pasteToTerminal } from '../cache';
import { makeEngine, event } from '../testSupport/broadcastHarness';
import { realXtermKeyboard } from '../testSupport/realXtermKeyboard';
import { encodeWin32Key } from '../win32InputMode';

const plain = { kbSnapshot: { kittyFlags: 0, modifyOtherKeys: 0 as const }, protocolActive: false,
  win32Active: false, isMac: false, isWindows: true, applicationCursorKeys: false, normalBuffer: true };
afterEach(() => { setBroadcastSink(null); for (const entry of terminalCache.values()) entry.disposables.forEach(fn => fn()); terminalCache.clear(); document.body.innerHTML = ''; });

test('R1.1 Meta printable, astral code points and Alt+Shift+Tab use the legacy rules', () => {
  const real = realXtermKeyboard(true);
  try {
    for (const e of [event('a', { metaKey: true }), event('Tab', { altKey: true, shiftKey: true })]) {
      expect(plainEncode(describe(e))).toBe(real.bytes(e, false));
    }
    expect(plainEncode(describe(event('😀')))).toBe('😀');
    const altGraph = describe(event('😀', { ctrlKey: true, altKey: true }));
    altGraph.locks.AltGraph = true;
    expect(plainEncode(altGraph)).toBe('😀');
  } finally { real.dispose(); }
});
test('R1.2 mock keypress restores only a matching last keydown after a microtask', async () => {
  const { term } = makeEngine(); const sink = jest.fn(); setBroadcastSink(sink);
  term.keyHandler!(event('A', { shiftKey: true })); await Promise.resolve();
  term.keyHandler!(event('A', { type: 'keypress', shiftKey: true }));
  term._core.coreService.triggerDataEvent('A', true);
  expect(sink.mock.calls[0][1]).toMatchObject({ kind: 'key', key: { key: 'A', shiftKey: true } });
  term.keyHandler!(event('B', { type: 'keypress', shiftKey: true }));
  term._core.coreService.triggerDataEvent('B', true);
  expect(sink.mock.calls[1][1]).toEqual({ kind: 'text', data: 'B' });
});

test('R1.2 AltGr deferred keypress remains a key unit and reaches a Win32 target', async () => {
  const source = makeEngine(); const target = makeEngine('target');
  target.term.csiHandlers['?h']([9001]);
  const sink = jest.fn((id, unit) => deliverBroadcast('target', unit)); setBroadcastSink(sink);
  const down = event('@', { keyCode: 50, ctrlKey: true, altKey: true, modifierAltGraph: true });
  source.term.keyHandler!(down); await Promise.resolve();
  source.term.keyHandler!(event('@', { type: 'keypress', ctrlKey: true, altKey: true }));
  source.term._core.coreService.triggerDataEvent('@', true);
  expect(sink.mock.calls[0][1]).toMatchObject({ kind: 'key', key: { key: '@', locks: { AltGraph: true } } });
  expect(target.write).toHaveBeenCalledWith('pid-target', '@');
});

test('R1.3 source submit consumes the prompt even while suggestions are blocked', () => {
  const { engine, term } = makeEngine();
  (engine as any).opts.broadcastActive = () => true;
  (engine as any).setPromptGate(true, true);
  term._core.coreService.triggerDataEvent('\r', true);
  expect(terminalCache.get('source')!.promptGate).toEqual({ seen: true, armed: false });
  expect((engine as any).promptArmed).toBe(false);
});
test('R1.3 delivered Enter, multiline paste/text disarm mounted and unmounted targets, not Shift+Enter', () => {
  const { engine } = makeEngine('target');
  const entry = terminalCache.get('target')!;
  for (const mounted of [true, false]) {
    if (!mounted) engine.unmount();
    for (const unit of [
      { kind: 'key' as const, key: describe(event('Enter')), srcBytes: '\r' },
      { kind: 'paste' as const, text: 'one\ntwo' }, { kind: 'text' as const, data: 'one\rtwo' },
    ]) {
      (engine as any).setPromptGate(true, true);
      deliverBroadcast('target', unit);
      expect(entry.promptGate).toEqual({ seen: true, armed: false });
      if (mounted) expect((engine as any).promptArmed).toBe(false);
    }
  }
  entry.promptGate = { seen: true, armed: true };
  deliverBroadcast('target', { kind: 'key', key: describe(event('Enter', { shiftKey: true })), srcBytes: '\n' });
  expect(entry.promptGate.armed).toBe(true);
});
test('R1.4 normal-buffer viewport page keys produce no target bytes on press or release', () => {
  for (const key of ['PageUp', 'PageDown']) for (const type of ['keydown', 'keyup']) {
    expect(decideKeyBytes(describe(event(key, { type })), { ...plain, win32Active: true })).toBeNull();
  }
});
test('R1.5 cache and engine paste never broadcast empty text or a processless source', () => {
  const { engine } = makeEngine(); const sink = jest.fn(); setBroadcastSink(sink);
  engine.paste(''); pasteToTerminal('source', '');
  expect(sink).not.toHaveBeenCalled();
  terminalCache.get('source')!.processId = undefined;
  engine.paste('x'); pasteToTerminal('source', 'x');
  expect(sink).not.toHaveBeenCalled();
});
test('R1.5 engine paste without an attachment cannot broadcast a stale cached process', () => {
  const { engine } = makeEngine(); const sink = jest.fn(); setBroadcastSink(sink);
  (engine as any).attachedProcessId = null;
  engine.paste('x');
  expect(sink).not.toHaveBeenCalled();
});

test('R1.5 native empty/file paste stays unclaimed and processless native paste does not broadcast', () => {
  const { term } = makeEngine(); const sink = jest.fn(); setBroadcastSink(sink);
  for (const text of ['', 'file-name']) {
    if (text) terminalCache.get('source')!.processId = undefined;
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { getData: () => text, types: text ? ['text/plain'] : ['Files'] } });
    term.element!.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(false);
    expect(terminalCache.get('source')!.inBroadcastPaste).not.toBe(true);
    expect(sink).not.toHaveBeenCalled();
  }
});
test('R1.5 empty native bracketed paste cannot leak bracket markers as a text unit', () => {
  const { term } = makeEngine(); term.bracketedPasteMode = true;
  const sink = jest.fn(); setBroadcastSink(sink);
  term.element!.addEventListener('paste', () => term.paste(''));
  const paste = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { getData: () => '' } });
  term.element!.dispatchEvent(paste);
  expect(paste.defaultPrevented).toBe(false);
  expect(sink).not.toHaveBeenCalled();
});

test('R1.7 target shell, enhanced-keyboard switch and platform are live, not mount snapshots', () => {
  const { engine, term, write } = makeEngine('target', 'pwsh');
  let shell = 'pwsh'; let enhanced = true;
  (engine as any).opts.shellType = () => shell;
  (engine as any).opts.enhancedKeyboard = () => enhanced;
  term.csiHandlers['?h']([9001]);
  shell = 'bash';
  deliverBroadcast('target', { kind: 'key', key: describe(event('Backspace', { ctrlKey: true })), srcBytes: '' });
  expect(write).toHaveBeenLastCalledWith('pid-target', '\x1b\x7f');
  enhanced = false; shell = 'pwsh'; write.mockClear();
  deliverBroadcast('target', { kind: 'key', key: describe(event('a')), srcBytes: '' });
  expect(write).toHaveBeenLastCalledWith('pid-target', 'a');
  enhanced = true; (engine as any).opts.isWindows = false; write.mockClear();
  deliverBroadcast('target', { kind: 'key', key: describe(event('a')), srcBytes: '' });
  expect(write).toHaveBeenLastCalledWith('pid-target', 'a');
  (engine as any).opts.isMac = true; write.mockClear();
  deliverBroadcast('target', { kind: 'key', key: describe(event('ArrowLeft', { metaKey: true })), srcBytes: '' });
  expect(write).toHaveBeenLastCalledWith('pid-target', '\x01');
  term.csiHandlers['>u']([3]); enhanced = false; write.mockClear();
  deliverBroadcast('target', { kind: 'key', key: describe(event('Enter', { shiftKey: true })), srcBytes: '' });
  expect(write).toHaveBeenLastCalledWith('pid-target', '\n');
});
test('R1.8 key then mounted paste then text preserve order across an in-flight write', async () => {
  const { term, write } = makeEngine('target'); term.bracketedPasteMode = true;
  let release!: () => void;
  write.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  deliverBroadcast('target', { kind: 'key', key: describe(event('a')), srcBytes: 'a' });
  deliverBroadcast('target', { kind: 'paste', text: 'b\nc' });
  deliverBroadcast('target', { kind: 'text', data: 'd' });
  expect(write.mock.calls).toEqual([['pid-target', 'a']]);
  release();
  for (let i = 0; i < 12; i++) await Promise.resolve();
  expect(write.mock.calls).toEqual([['pid-target', 'a'], ['pid-target', '\x1b[200~b\rc\x1b[201~'], ['pid-target', 'd']]);
});
test.each(['zero-buttons', 'blur'])('R1.9 lost mouseup resets pointer ownership via %s and listeners do not leak', async reset => {
  const { engine, term } = makeEngine(); const sink = jest.fn(); setBroadcastSink(sink);
  term.element!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, buttons: 1 }));
  await Promise.resolve();
  if (reset === 'blur') window.dispatchEvent(new Event('blur'));
  else document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 0 }));
  await Promise.resolve();
  document.addEventListener('mousemove', () => term._core.coreService.triggerDataEvent('input', true), { once: true });
  document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 1 }));
  expect(sink).toHaveBeenCalledWith('source', { kind: 'text', data: 'input' });
  const remove = jest.spyOn(window, 'removeEventListener');
  engine.unmount();
  for (const name of ['mousedown', 'mousemove', 'mouseup', 'wheel', 'blur']) {
    expect(remove).toHaveBeenCalledWith(name, expect.any(Function), true);
  }
  remove.mockRestore();
});

test('R1.6 modifier locks preserve full Win32 control-state bits, not just vk', () => {
  const e = event('c', { ctrlKey: true });
  Object.defineProperty(e, 'getModifierState', { value: (name: string) => ['CapsLock', 'NumLock'].includes(name) });
  const key = describe(e);
  expect(key.locks).toEqual({ CapsLock: true, NumLock: true, ScrollLock: false, AltGraph: false });
  expect(encodeWin32Key(toEventLike(key), true))
    .toBe('\x1b[67;46;3;1;168;1_');
});
