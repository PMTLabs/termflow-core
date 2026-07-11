import { KeyboardProtocolState, encodeKey, SUPPORTED_KITTY_MASK } from '../keyboardProtocol';

describe('KeyboardProtocolState', () => {
  test('push/pop/active on main stack', () => {
    const s = new KeyboardProtocolState();
    expect(s.activeFlags()).toBe(0);
    s.pushFlags(1);
    expect(s.activeFlags()).toBe(1);
    s.pushFlags(3);
    expect(s.activeFlags()).toBe(3);
    s.popFlags();
    expect(s.activeFlags()).toBe(1);
    s.popFlags(5); // over-pop is safe
    expect(s.activeFlags()).toBe(0);
  });

  test('masks unsupported flag bits', () => {
    const s = new KeyboardProtocolState();
    s.pushFlags(31); // 1|2|4|8|16
    expect(s.activeFlags()).toBe(SUPPORTED_KITTY_MASK); // 3
  });

  test('setFlags modes: 1=set, 2=or, 3=clear', () => {
    const s = new KeyboardProtocolState();
    s.setFlags(1, 1);
    expect(s.activeFlags()).toBe(1);
    s.setFlags(2, 2);
    expect(s.activeFlags()).toBe(3);
    s.setFlags(1, 3);
    expect(s.activeFlags()).toBe(2);
  });

  test('main and alt stacks are independent', () => {
    const s = new KeyboardProtocolState();
    let screen: 'main' | 'alt' = 'main';
    s.getScreen = () => screen;
    s.pushFlags(1);
    screen = 'alt';
    expect(s.activeFlags()).toBe(0); // alt stack empty
    s.pushFlags(3);
    expect(s.activeFlags()).toBe(3);
    screen = 'main';
    expect(s.activeFlags()).toBe(1); // main preserved
  });

  test('modifyOtherKeys level set/reset + query response', () => {
    const s = new KeyboardProtocolState();
    s.setModifyOtherKeys(2);
    expect(s.snapshot().modifyOtherKeys).toBe(2);
    s.setModifyOtherKeys(0);
    expect(s.snapshot().modifyOtherKeys).toBe(0);
    s.setModifyOtherKeys(9 as never);
    expect(s.snapshot().modifyOtherKeys).toBe(0); // invalid -> 0
    s.pushFlags(3);
    expect(s.queryResponse()).toBe('\x1b[?3u');
  });

  test('reset() clears both stacks and modifyOtherKeys (DECSTR/RIS heal)', () => {
    const s = new KeyboardProtocolState();
    let screen: 'main' | 'alt' = 'main';
    s.getScreen = () => screen;
    s.pushFlags(1);
    screen = 'alt';
    s.pushFlags(3);
    s.setModifyOtherKeys(2);
    s.reset();
    expect(s.activeFlags()).toBe(0); // alt cleared
    screen = 'main';
    expect(s.activeFlags()).toBe(0); // main cleared
    expect(s.snapshot().modifyOtherKeys).toBe(0);
  });

  test('clearAltStack() empties only the alt stack (kitty screen-switch rule)', () => {
    const s = new KeyboardProtocolState();
    let screen: 'main' | 'alt' = 'main';
    s.getScreen = () => screen;
    s.pushFlags(1);
    screen = 'alt';
    s.pushFlags(3); // crashed alt-screen TUI left this behind
    s.clearAltStack();
    expect(s.activeFlags()).toBe(0); // alt emptied
    screen = 'main';
    expect(s.activeFlags()).toBe(1); // main untouched
  });
});

const KITTY1 = { kittyFlags: 1, modifyOtherKeys: 0 } as const;
const KITTY12 = { kittyFlags: 3, modifyOtherKeys: 0 } as const;
const MOK2 = { kittyFlags: 0, modifyOtherKeys: 2 } as const;
const BOTH = { kittyFlags: 1, modifyOtherKeys: 2 } as const;
const OFF = { kittyFlags: 0, modifyOtherKeys: 0 } as const;

function key(over: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    type: 'keydown',
    key: 'a',
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    repeat: false,
    ...over,
  } as KeyboardEvent;
}

describe('encodeKey — kitty flag 1', () => {
  test('Ctrl+C -> CSI 99;5 u', () => {
    expect(encodeKey(key({ key: 'c', ctrlKey: true }), KITTY1)).toBe('\x1b[99;5u');
  });
  test('Ctrl+D -> CSI 100;5 u', () => {
    expect(encodeKey(key({ key: 'd', ctrlKey: true }), KITTY1)).toBe('\x1b[100;5u');
  });
  test('Ctrl+Shift+C -> CSI 99;6 u (codepoint stays lowercase)', () => {
    expect(encodeKey(key({ key: 'C', ctrlKey: true, shiftKey: true }), KITTY1)).toBe('\x1b[99;6u');
  });
  test('Alt+a -> CSI 97;3 u', () => {
    expect(encodeKey(key({ key: 'a', altKey: true }), KITTY1)).toBe('\x1b[97;3u');
  });
  test('Escape always -> CSI 27 u', () => {
    expect(encodeKey(key({ key: 'Escape' }), KITTY1)).toBe('\x1b[27u');
  });
  test('Shift+Enter -> CSI 13;2 u', () => {
    expect(encodeKey(key({ key: 'Enter', shiftKey: true }), KITTY1)).toBe('\x1b[13;2u');
  });
  test('Shift+Tab -> CSI 9;2 u', () => {
    expect(encodeKey(key({ key: 'Tab', shiftKey: true }), KITTY1)).toBe('\x1b[9;2u');
  });
  test('Ctrl+Backspace -> CSI 127;5 u', () => {
    expect(encodeKey(key({ key: 'Backspace', ctrlKey: true }), KITTY1)).toBe('\x1b[127;5u');
  });

  // Regression guards (Global Constraints 1 & 2):
  test('plain letter -> null (text path)', () => {
    expect(encodeKey(key({ key: 'a' }), KITTY1)).toBeNull();
  });
  test('Shift+letter -> null (still text)', () => {
    expect(encodeKey(key({ key: 'A', shiftKey: true }), KITTY1)).toBeNull();
  });
  test('unmodified Enter/Tab/Backspace -> null (legacy)', () => {
    expect(encodeKey(key({ key: 'Enter' }), KITTY1)).toBeNull();
    expect(encodeKey(key({ key: 'Tab' }), KITTY1)).toBeNull();
    expect(encodeKey(key({ key: 'Backspace' }), KITTY1)).toBeNull();
  });
  test('protocol off -> null for everything', () => {
    expect(encodeKey(key({ key: 'c', ctrlKey: true }), OFF)).toBeNull();
    expect(encodeKey(key({ key: 'Escape' }), OFF)).toBeNull();
  });
  test('keypress events ignored', () => {
    expect(encodeKey(key({ key: 'c', ctrlKey: true, type: 'keypress' }), KITTY1)).toBeNull();
  });
});

describe('encodeKey — functional keys + event types', () => {
  test('unmodified arrow -> null (xterm legacy) when flag 2 off', () => {
    expect(encodeKey(key({ key: 'ArrowUp' }), KITTY1)).toBeNull();
  });
  test('Ctrl+ArrowRight -> CSI 1;5 C', () => {
    expect(encodeKey(key({ key: 'ArrowRight', ctrlKey: true }), KITTY1)).toBe('\x1b[1;5C');
  });
  test('Shift+Home -> CSI 1;2 H', () => {
    expect(encodeKey(key({ key: 'Home', shiftKey: true }), KITTY1)).toBe('\x1b[1;2H');
  });
  test('Ctrl+Delete -> CSI 3;5 ~', () => {
    expect(encodeKey(key({ key: 'Delete', ctrlKey: true }), KITTY1)).toBe('\x1b[3;5~');
  });
  test('Shift+F5 -> CSI 15;2 ~', () => {
    expect(encodeKey(key({ key: 'F5', shiftKey: true }), KITTY1)).toBe('\x1b[15;2~');
  });
  test('Ctrl+F1 -> CSI 1;5 P', () => {
    expect(encodeKey(key({ key: 'F1', ctrlKey: true }), KITTY1)).toBe('\x1b[1;5P');
  });

  // Flag 2 event types:
  test('flag2: repeat press of Ctrl+C -> CSI 99;5:2 u', () => {
    expect(encodeKey(key({ key: 'c', ctrlKey: true, repeat: true }), KITTY12)).toBe('\x1b[99;5:2u');
  });
  test('flag2: keyup release of Ctrl+C -> CSI 99;5:3 u', () => {
    expect(encodeKey(key({ key: 'c', ctrlKey: true, type: 'keyup' }), KITTY12)).toBe('\x1b[99;5:3u');
  });
  test('flag2: keyup of plain Escape -> CSI 27;1:3 u', () => {
    expect(encodeKey(key({ key: 'Escape', type: 'keyup' }), KITTY12)).toBe('\x1b[27;1:3u');
  });
  test('flag2 off: keyup -> null', () => {
    expect(encodeKey(key({ key: 'c', ctrlKey: true, type: 'keyup' }), KITTY1)).toBeNull();
  });
  test('bare modifier key -> null', () => {
    expect(encodeKey(key({ key: 'Shift', shiftKey: true }), KITTY1)).toBeNull();
    expect(encodeKey(key({ key: 'Control', ctrlKey: true }), KITTY1)).toBeNull();
  });
});

describe('encodeKey — modifyOtherKeys fallback', () => {
  test('Ctrl+C -> CSI 27;5;99 ~', () => {
    expect(encodeKey(key({ key: 'c', ctrlKey: true }), MOK2)).toBe('\x1b[27;5;99~');
  });
  test('Shift+Enter -> CSI 27;2;13 ~', () => {
    expect(encodeKey(key({ key: 'Enter', shiftKey: true }), MOK2)).toBe('\x1b[27;2;13~');
  });
  test('plain letter -> null', () => {
    expect(encodeKey(key({ key: 'a' }), MOK2)).toBeNull();
  });
  test('Shift+letter -> null (text, not an "other" key)', () => {
    expect(encodeKey(key({ key: 'A', shiftKey: true }), MOK2)).toBeNull();
  });
  test('unmodified Enter -> null (legacy)', () => {
    expect(encodeKey(key({ key: 'Enter' }), MOK2)).toBeNull();
  });
  test('kitty takes precedence over modifyOtherKeys', () => {
    expect(encodeKey(key({ key: 'c', ctrlKey: true }), BOTH)).toBe('\x1b[99;5u');
  });
});

describe('encodeKey — review fixes', () => {
  // Enter/Tab/Backspace: never release events; symmetric press/repeat with the legacy press.
  test('flag2: keyup of modified Enter/Tab/Backspace -> null (no release events)', () => {
    expect(encodeKey(key({ key: 'Enter', ctrlKey: true, type: 'keyup' }), KITTY12)).toBeNull();
    expect(encodeKey(key({ key: 'Tab', shiftKey: true, type: 'keyup' }), KITTY12)).toBeNull();
    expect(encodeKey(key({ key: 'Backspace', ctrlKey: true, type: 'keyup' }), KITTY12)).toBeNull();
  });
  test('flag2: keyup of unmodified Enter -> null', () => {
    expect(encodeKey(key({ key: 'Enter', type: 'keyup' }), KITTY12)).toBeNull();
  });
  test('flag2: repeat of unmodified Enter -> null (stays legacy, symmetric with press)', () => {
    expect(encodeKey(key({ key: 'Enter', repeat: true }), KITTY12)).toBeNull();
  });
  test('flag2: repeat of Shift+Enter -> CSI 13;2:2 u (modified repeat allowed)', () => {
    expect(encodeKey(key({ key: 'Enter', shiftKey: true, repeat: true }), KITTY12)).toBe('\x1b[13;2:2u');
  });

  // AltGr-produced char must flow through as text, not be re-encoded.
  test('AltGr (Ctrl+Alt + printable, AltGraph set) -> null', () => {
    const ev = key({ key: '@', ctrlKey: true, altKey: true });
    (ev as unknown as { getModifierState: (m: string) => boolean }).getModifierState = (m) => m === 'AltGraph';
    expect(encodeKey(ev, KITTY1)).toBeNull();
    expect(encodeKey(ev, MOK2)).toBeNull();
  });

  // IME composition always passes through.
  test('isComposing -> null even with ctrl', () => {
    expect(encodeKey(key({ key: 'a', ctrlKey: true, isComposing: true }), KITTY1)).toBeNull();
  });

  // Shifted digit uses the unshifted key code via e.code.
  test('Ctrl+Shift+2 (key "@", code Digit2) -> CSI 50;6 u (unshifted "2")', () => {
    expect(encodeKey(key({ key: '@', code: 'Digit2', ctrlKey: true, shiftKey: true }), KITTY1)).toBe('\x1b[50;6u');
  });
});

describe('KeyboardProtocolState — stack cap', () => {
  test('flag stack is bounded (oldest evicted), per Kitty spec', () => {
    const s = new KeyboardProtocolState();
    s.pushFlags(2); // sentinel at the bottom
    for (let i = 0; i < 32; i++) s.pushFlags(1); // 33 pushes total; cap is 32
    s.popFlags(32);
    // With the cap, only 32 entries ever existed and the sentinel was evicted, so
    // popping 32 empties the stack. Without a cap, the sentinel (2) would remain.
    expect(s.activeFlags()).toBe(0);
  });
});
