import { Win32InputModeState, encodeWin32Key } from '../win32InputMode';

function key(over: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    type: 'keydown', key: 'a', keyCode: 65, location: 0,
    ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
    repeat: false, isComposing: false,
    getModifierState: () => false,
    ...over,
  } as unknown as KeyboardEvent;
}

describe('Win32InputModeState', () => {
  test('starts inactive, enable/disable/isActive', () => {
    const s = new Win32InputModeState();
    expect(s.isActive()).toBe(false);
    s.enable();
    expect(s.isActive()).toBe(true);
    s.disable();
    expect(s.isActive()).toBe(false);
  });
  test('disable is idempotent', () => {
    const s = new Win32InputModeState();
    s.disable();
    expect(s.isActive()).toBe(false);
  });
});

describe('encodeWin32Key — printable + named keys', () => {
  test('inactive -> null for everything', () => {
    expect(encodeWin32Key(key({ key: 'a', keyCode: 65 }), false)).toBeNull();
  });
  test('plain letter a -> CSI 65;30;97;1;0;1 _', () => {
    expect(encodeWin32Key(key({ key: 'a', keyCode: 65 }), true)).toBe('\x1b[65;30;97;1;0;1_');
  });
  test('Shift+A -> CSI 65;30;65;1;16;1 _ (uppercase char, shift bit set)', () => {
    expect(encodeWin32Key(key({ key: 'A', keyCode: 65, shiftKey: true }), true)).toBe('\x1b[65;30;65;1;16;1_');
  });
  test('digit 1 -> CSI 49;2;49;1;0;1 _', () => {
    expect(encodeWin32Key(key({ key: '1', keyCode: 49 }), true)).toBe('\x1b[49;2;49;1;0;1_');
  });
  test('Enter -> CSI 13;28;13;1;0;1 _ (named key has its own char)', () => {
    expect(encodeWin32Key(key({ key: 'Enter', keyCode: 13 }), true)).toBe('\x1b[13;28;13;1;0;1_');
  });
  test('Tab -> CSI 9;15;9;1;0;1 _', () => {
    expect(encodeWin32Key(key({ key: 'Tab', keyCode: 9 }), true)).toBe('\x1b[9;15;9;1;0;1_');
  });
  test('Escape -> CSI 27;1;27;1;0;1 _', () => {
    expect(encodeWin32Key(key({ key: 'Escape', keyCode: 27 }), true)).toBe('\x1b[27;1;27;1;0;1_');
  });
  test('unmapped scan code falls back to 0, still encodes', () => {
    expect(encodeWin32Key(key({ key: 'Meta', keyCode: 91 }), true)).toBe('\x1b[91;0;0;1;0;1_');
  });
  test('Ctrl+Enter -> Uc=10 (LF), not 13 (named-key rule does not apply under ctrl)', () => {
    expect(encodeWin32Key(key({ key: 'Enter', keyCode: 13, ctrlKey: true }), true)).toBe('\x1b[13;28;10;1;8;1_');
  });
  test('Ctrl+Backspace -> Uc=127 (DEL)', () => {
    expect(encodeWin32Key(key({ key: 'Backspace', keyCode: 8, ctrlKey: true }), true)).toBe('\x1b[8;14;127;1;8;1_');
  });
  test('Ctrl+Space -> Uc=0', () => {
    expect(encodeWin32Key(key({ key: ' ', keyCode: 32, ctrlKey: true }), true)).toBe('\x1b[32;57;0;1;8;1_');
  });
  test('CapsLock on -> CAPSLOCK_ON bit (0x80) set via getModifierState', () => {
    expect(encodeWin32Key(key({ key: 'a', keyCode: 65, getModifierState: (m: string) => m === 'CapsLock' }), true)).toBe('\x1b[65;30;97;1;128;1_');
  });
  test('IME composition -> null', () => {
    expect(encodeWin32Key(key({ key: 'a', isComposing: true }), true)).toBeNull();
  });
  test('AltGr-produced char -> null', () => {
    expect(encodeWin32Key(key({ key: '@', getModifierState: (m: string) => m === 'AltGraph' }), true)).toBeNull();
  });
  test('keypress type ignored', () => {
    expect(encodeWin32Key(key({ key: 'a', type: 'keypress' }), true)).toBeNull();
  });
});
