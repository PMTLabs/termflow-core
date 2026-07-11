// Enhanced keyboard protocol encoding: Kitty keyboard protocol (flags 1+2) and
// XTerm modifyOtherKeys (fallback). xterm.js 6 implements neither, so modern TUIs
// (Antigravity `agy`, codex, claude) that enable these protocols ignore the legacy
// key encodings xterm sends. This module tracks what an app has enabled and encodes
// DOM key events into the bytes the app expects. See docs/037 + docs/038.
//
// Spec references: https://sw.kovidgoyal.net/kitty/keyboard-protocol/ and
// https://invisible-island.net/xterm/modified-keys.html

/** Kitty flags we implement: 1 (disambiguate escape codes) + 2 (report event types). */
export const SUPPORTED_KITTY_MASK = 0b11;

/** Kitty spec: bound the flag stack so untrusted app output can't grow it unbounded. */
const KITTY_STACK_LIMIT = 32;

export interface KittyKeySnapshot {
  /** Active Kitty flags (already masked to SUPPORTED_KITTY_MASK). */
  kittyFlags: number;
  /** XTerm modifyOtherKeys level. */
  modifyOtherKeys: 0 | 1 | 2;
}

/**
 * Tracks the keyboard protocols an application has enabled. Kitty flags use a
 * per-screen stack (the Kitty spec mandates independent main/alt-screen stacks);
 * modifyOtherKeys is a single per-terminal level. Pure state — no I/O.
 */
export class KeyboardProtocolState {
  private mainStack: number[] = [];
  private altStack: number[] = [];
  private modifyOtherKeysLevel: 0 | 1 | 2 = 0;

  /** Supplied by the engine; returns which screen buffer is active. */
  getScreen: () => 'main' | 'alt' = () => 'main';

  private stack(): number[] {
    return this.getScreen() === 'alt' ? this.altStack : this.mainStack;
  }

  pushFlags(flags: number): void {
    const s = this.stack();
    if (s.length >= KITTY_STACK_LIMIT) s.shift(); // evict oldest when full (Kitty spec)
    s.push(flags & SUPPORTED_KITTY_MASK);
  }

  popFlags(n = 1): void {
    const s = this.stack();
    for (let i = 0; i < n && s.length > 0; i++) s.pop();
  }

  setFlags(flags: number, mode: number): void {
    const s = this.stack();
    const cur = s.length > 0 ? s[s.length - 1] : 0;
    const masked = flags & SUPPORTED_KITTY_MASK;
    const next = mode === 2 ? cur | masked : mode === 3 ? cur & ~masked : masked;
    if (s.length > 0) s[s.length - 1] = next;
    else s.push(next);
  }

  activeFlags(): number {
    const s = this.stack();
    return s.length > 0 ? s[s.length - 1] : 0;
  }

  setModifyOtherKeys(level: number): void {
    this.modifyOtherKeysLevel = level === 1 || level === 2 ? level : 0;
  }

  /** Full reset (DECSTR / RIS): both Kitty stacks and modifyOtherKeys. TUIs that
   *  exit via a terminal soft-reset never pop their flags — without this the
   *  protocol state would stay stuck after the app is gone. */
  reset(): void {
    this.mainStack = [];
    this.altStack = [];
    this.modifyOtherKeysLevel = 0;
  }

  /** Kitty spec: the alternate screen's stack starts out empty when the alt
   *  screen is (re)entered and does not survive leaving it. Clearing on both
   *  transitions prevents a crashed alt-screen TUI from leaking flags into the
   *  next one. */
  clearAltStack(): void {
    this.altStack = [];
  }

  queryResponse(): string {
    return `\x1b[?${this.activeFlags()}u`;
  }

  snapshot(): KittyKeySnapshot {
    return { kittyFlags: this.activeFlags(), modifyOtherKeys: this.modifyOtherKeysLevel };
  }
}

// --- Encoding -------------------------------------------------------------

const MOD_SHIFT = 1;
const MOD_ALT = 2;
const MOD_CTRL = 4;
const MOD_SUPER = 8;

function modBitmask(e: KeyboardEvent): number {
  let m = 0;
  if (e.shiftKey) m |= MOD_SHIFT;
  if (e.altKey) m |= MOD_ALT;
  if (e.ctrlKey) m |= MOD_CTRL;
  if (e.metaKey) m |= MOD_SUPER;
  return m;
}

/**
 * The `;<mods>[:<event>]` field shared by the CSI u and functional encodings.
 * Returns '' when there are no modifiers and the event type is the default
 * (press) — callers treat '' as "no enhanced encoding needed".
 */
function modSuffix(mods: number, evt: number): string {
  const needEvt = evt !== 1;
  if (mods === 1 && !needEvt) return '';
  return needEvt ? `;${mods}:${evt}` : `;${mods}`;
}

function isSingleChar(key: string): boolean {
  return [...key].length === 1;
}

/**
 * The Kitty/modifyOtherKeys codepoint is the UNSHIFTED key. `toLowerCase` only
 * unshifts letters; for the digit row use `e.code` (DigitN -> N) so e.g.
 * Ctrl+Shift+2 reports '2' (50) not '@' (64). Other shifted punctuation falls back
 * to the shifted glyph — the DOM does not expose its unshifted form layout-independently.
 */
function unshiftedCodepoint(e: KeyboardEvent): number {
  const code = e.code;
  if (code && /^Digit[0-9]$/.test(code)) return code.charCodeAt(5); // 'Digit2'[5] === '2'
  return e.key.toLowerCase().codePointAt(0) as number;
}

/** AltGr (reported as Ctrl+Alt on Windows/Chromium) produces a printable char that
 *  must flow through as text, not be re-encoded as a chord (constraint #1). */
function isAltGraph(e: KeyboardEvent): boolean {
  return typeof e.getModifierState === 'function' && e.getModifierState('AltGraph');
}

interface FuncKey {
  letter?: string;
  tilde?: number;
}

/** Functional / navigation keys and their CSI letter (1;mod X) or tilde (n;mod ~) forms. */
const FUNCTIONAL: Record<string, FuncKey> = {
  ArrowUp: { letter: 'A' },
  ArrowDown: { letter: 'B' },
  ArrowRight: { letter: 'C' },
  ArrowLeft: { letter: 'D' },
  Home: { letter: 'H' },
  End: { letter: 'F' },
  Insert: { tilde: 2 },
  Delete: { tilde: 3 },
  PageUp: { tilde: 5 },
  PageDown: { tilde: 6 },
  F1: { letter: 'P' },
  F2: { letter: 'Q' },
  F3: { letter: 'R' },
  F4: { letter: 'S' },
  F5: { tilde: 15 },
  F6: { tilde: 17 },
  F7: { tilde: 18 },
  F8: { tilde: 19 },
  F9: { tilde: 20 },
  F10: { tilde: 21 },
  F11: { tilde: 23 },
  F12: { tilde: 24 },
};

/**
 * Pure: DOM key event + protocol snapshot -> bytes to send, or null meaning
 * "not ours — let xterm handle it" (plain text, IME, dead keys, unhandled keys,
 * and everything when no protocol is active).
 */
export function encodeKey(e: KeyboardEvent, snap: KittyKeySnapshot): string | null {
  // IME/composition always flows through xterm's text path untouched (constraint #1).
  if (e.isComposing) return null;
  const kittyActive = (snap.kittyFlags & SUPPORTED_KITTY_MASK) !== 0;
  const kittyEvents = (snap.kittyFlags & 2) !== 0;

  if (e.type === 'keyup') {
    if (!kittyEvents) return null; // release events only under flag 2
    return encodeKitty(e, snap, true);
  }
  if (e.type !== 'keydown') return null; // ignore keypress

  if (kittyActive) return encodeKitty(e, snap, false);
  if (snap.modifyOtherKeys >= 1) return encodeModifyOtherKeys(e);
  return null;
}

function encodeKitty(e: KeyboardEvent, snap: KittyKeySnapshot, release: boolean): string | null {
  const mods = modBitmask(e) + 1;
  const evt = (snap.kittyFlags & 2) === 0 ? 1 : release ? 3 : e.repeat ? 2 : 1;
  const suf = modSuffix(mods, evt);

  // Named keys (CSI u number forms).
  if (e.key === 'Escape') return `\x1b[27${suf}u`; // always disambiguated under flag 1
  // Enter/Tab/Backspace stay legacy when unmodified, and per the Kitty spec NEVER emit
  // release events (only with flag 8, which we don't implement). So encode only a
  // modified press/repeat; otherwise null (legacy 0x0d/0x09/0x7f), keeping press and
  // release/repeat symmetric.
  if (e.key === 'Enter' || e.key === 'Tab' || e.key === 'Backspace') {
    if (release) return null;
    if (modBitmask(e) === 0) return null;
    const code = e.key === 'Enter' ? 13 : e.key === 'Tab' ? 9 : 127;
    return `\x1b[${code}${suf}u`;
  }

  // Functional / navigation keys.
  const f = FUNCTIONAL[e.key];
  if (f) {
    if (!suf) return null; // unmodified press, no event -> xterm legacy form
    if (f.letter) return `\x1b[1${suf}${f.letter}`;
    return `\x1b[${f.tilde}${suf}~`;
  }

  // Text keys with Ctrl and/or Alt -> CSI <codepoint>;<mods> u (unshifted).
  if (isSingleChar(e.key) && (e.ctrlKey || e.altKey)) {
    if (isAltGraph(e)) return null; // AltGr-produced char -> text path
    return `\x1b[${unshiftedCodepoint(e)}${suf}u`;
  }

  return null; // bare modifier keys, plain/shift-only text -> null
}

function encodeModifyOtherKeys(e: KeyboardEvent): string | null {
  const mask = modBitmask(e);
  if (mask === 0) return null; // unmodified -> legacy
  const mods = mask + 1;
  let code: number | null = null;
  if (e.key === 'Enter') code = 13;
  else if (e.key === 'Tab') code = 9;
  else if (e.key === 'Backspace') code = 127;
  else if (e.key === 'Escape') code = 27;
  else if (isSingleChar(e.key)) {
    if (!(e.ctrlKey || e.altKey)) return null; // shift-only text stays text
    if (isAltGraph(e)) return null; // AltGr-produced char -> text path
    code = unshiftedCodepoint(e);
  } else {
    return null; // functional keys: leave to xterm legacy under modifyOtherKeys
  }
  return `\x1b[27;${mods};${code}~`;
}
