import { Win32InputModeState, encodeWin32Key, scanWin32ModeSequences } from '../win32InputMode';

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

// Scanner for one-shot mode sequences inside raw text the hydration snapshot
// path is about to DROP (the bytes never transit the xterm parser, so the CSI
// handler can't see them — the scan is the only chance to observe the
// handshake). Semantics must match the CSI handler exactly: any param position
// counts, param-exact match (no substrings), last occurrence wins.
describe('scanWin32ModeSequences', () => {
  test('plain text -> null', () => {
    expect(scanWin32ModeSequences('PS D:\\> dir')).toBeNull();
  });
  test('empty string -> null', () => {
    expect(scanWin32ModeSequences('')).toBeNull();
  });
  test('?9001h -> enable', () => {
    expect(scanWin32ModeSequences('\x1b[?9001h')).toBe('enable');
  });
  test('?9001l -> disable', () => {
    expect(scanWin32ModeSequences('\x1b[?9001l')).toBe('disable');
  });
  test('ConPTY real first chunk (handshake embedded among other modes) -> enable', () => {
    expect(scanWin32ModeSequences('\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J\x1b[m\x1b[H')).toBe('enable');
  });
  test('enable then disable -> disable (last wins)', () => {
    expect(scanWin32ModeSequences('\x1b[?9001h...\x1b[?9001l')).toBe('disable');
  });
  test('disable then enable -> enable (last wins)', () => {
    expect(scanWin32ModeSequences('\x1b[?9001l...\x1b[?9001h')).toBe('enable');
  });
  test('9001 in a combined param list -> enable (matches CSI-handler semantics)', () => {
    expect(scanWin32ModeSequences('\x1b[?9001;1004h')).toBe('enable');
  });
  test('other private modes only -> null (no false positive on 1004/25)', () => {
    expect(scanWin32ModeSequences('\x1b[?1004h\x1b[?25l')).toBeNull();
  });
  test('param containing 9001 as a substring (19001) -> null (param-exact match)', () => {
    expect(scanWin32ModeSequences('\x1b[?19001h')).toBeNull();
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

describe('encodeWin32Key — chords, keyup, repeat, functional keys', () => {
  test('Ctrl+C -> Uc is the control-translated char (3), Cs has LEFT_CTRL', () => {
    expect(encodeWin32Key(key({ key: 'c', keyCode: 67, ctrlKey: true }), true)).toBe('\x1b[67;46;3;1;8;1_');
  });
  test('Ctrl+J -> Uc=10 (same byte as bare LF, but Cs carries the chord)', () => {
    expect(encodeWin32Key(key({ key: 'j', keyCode: 74, ctrlKey: true }), true)).toBe('\x1b[74;36;10;1;8;1_');
  });
  // Shift+Enter carries Uc=10 (LF), not 13: INPUT_RECORD readers (codex/crossterm)
  // key off Vk+SHIFT and ignore Uc, while VT-byte readers (claude, gemini) only ever
  // see ConPTY's translation OF Uc — 13 would collapse to a plain-Enter submit.
  // Verified live against both consumer types; see the SHIFT_ENTER rationale in
  // win32InputMode.ts.
  test('Shift+Enter -> CSI 13;28;10;1;16;1 _ (SHIFT_PRESSED set, Uc=LF)', () => {
    expect(encodeWin32Key(key({ key: 'Enter', keyCode: 13, shiftKey: true }), true)).toBe('\x1b[13;28;10;1;16;1_');
  });
  test('Shift+Enter keyup keeps Uc=10 (symmetric with the press)', () => {
    expect(encodeWin32Key(key({ key: 'Enter', keyCode: 13, shiftKey: true, type: 'keyup' }), true)).toBe('\x1b[13;28;10;0;16;1_');
  });
  test('Ctrl+Shift+Enter -> Uc=10 via the ctrl override (unchanged by the shift rule)', () => {
    expect(encodeWin32Key(key({ key: 'Enter', keyCode: 13, ctrlKey: true, shiftKey: true }), true)).toBe('\x1b[13;28;10;1;24;1_');
  });
  test('Alt+Shift+Enter keeps the named-key Uc=13 (LF rule is shift-only)', () => {
    expect(encodeWin32Key(key({ key: 'Enter', keyCode: 13, altKey: true, shiftKey: true }), true)).toBe('\x1b[13;28;13;1;18;1_');
  });
  test('right Ctrl (location=2) sets RIGHT_CTRL_PRESSED', () => {
    expect(encodeWin32Key(key({ key: 'Control', keyCode: 17, ctrlKey: true, location: 2 }), true)).toBe('\x1b[17;29;0;1;4;1_');
  });
  // Internal workflow review (docs/review/052): the Alt bits had zero coverage
  // — a swapped LEFT_ALT_PRESSED/RIGHT_ALT_PRESSED assignment would have gone
  // undetected by the full existing suite.
  test('left Alt+a sets LEFT_ALT_PRESSED (0x02)', () => {
    expect(encodeWin32Key(key({ key: 'a', keyCode: 65, altKey: true }), true)).toBe('\x1b[65;30;97;1;2;1_');
  });
  test('right Alt (location=2) sets RIGHT_ALT_PRESSED (0x01)', () => {
    expect(encodeWin32Key(key({ key: 'a', keyCode: 65, altKey: true, location: 2 }), true)).toBe('\x1b[65;30;97;1;1;1_');
  });
  test('ArrowUp unmodified -> CSI 38;72;0;1;0;1 _', () => {
    expect(encodeWin32Key(key({ key: 'ArrowUp', keyCode: 38 }), true)).toBe('\x1b[38;72;0;1;0;1_');
  });
  test('Ctrl+ArrowRight -> Cs carries ctrl, Uc stays 0 (no natural char)', () => {
    expect(encodeWin32Key(key({ key: 'ArrowRight', keyCode: 39, ctrlKey: true }), true)).toBe('\x1b[39;77;0;1;8;1_');
  });
  test('F5 -> CSI 116;63;0;1;0;1 _', () => {
    expect(encodeWin32Key(key({ key: 'F5', keyCode: 116 }), true)).toBe('\x1b[116;63;0;1;0;1_');
  });
  test('keyup -> Kd=0, same fields otherwise', () => {
    expect(encodeWin32Key(key({ key: 'a', keyCode: 65, type: 'keyup' }), true)).toBe('\x1b[65;30;97;0;0;1_');
  });
  test('repeat=true still encodes Rc=1 (browsers deliver repeat as separate events)', () => {
    expect(encodeWin32Key(key({ key: 'a', keyCode: 65, repeat: true }), true)).toBe('\x1b[65;30;97;1;0;1_');
  });
});
