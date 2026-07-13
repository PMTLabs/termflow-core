// Win32-Input-Mode: the protocol ConPTY itself requests (CSI ?9001h) at the start
// of every Windows session so native console apps (which read Win32 INPUT_RECORDs,
// not VT bytes) get full keyboard modifier fidelity. xterm.js implements neither
// side of this, so without it ConPTY falls back to a lossy byte->INPUT_RECORD
// guess that can't reliably represent chords like Shift+Enter or Ctrl+J. Windows
// Terminal implements this; TermFlow did not, until now. See docs/043 + docs/044.
//
// Spec: https://github.com/microsoft/terminal/blob/main/doc/specs/%234999%20-%20Improved%20keyboard%20handling%20in%20Conpty.md

import { isSingleChar, isAltGraph } from './keyboardProtocol';

/** Tracks whether ConPTY has asked us to use Win32-Input-Mode encoding. A single
 *  session-level flag — unlike Kitty's per-screen stack, ConPTY asserts this once
 *  per session and does not push/pop it. */
export class Win32InputModeState {
  private active = false;
  enable(): void { this.active = true; }
  disable(): void { this.active = false; }
  isActive(): boolean { return this.active; }
}

/**
 * Scan raw PTY output for `CSI ? … 9001 … h/l` (DECSET/DECRST of Win32-Input-Mode)
 * and report the net effect: 'enable' / 'disable' for the LAST occurrence in the
 * text, or null when mode 9001 never appears.
 *
 * Exists for exactly one caller: the hydration snapshot path drops buffered
 * chunks without ever feeding them to the xterm parser (their screen effects are
 * already in the snapshot — but a snapshot reproduces screen CONTENT, never mode
 * side-effects). ConPTY sends ?9001h once, as the FIRST chunk of every Windows
 * session, so it reliably lands in that dropped window and the handshake is
 * otherwise lost for the session's lifetime. Semantics mirror the engine's CSI
 * handler: any position in a combined param list counts, params match exactly
 * (no substrings), later occurrences override earlier ones.
 */
export function scanWin32ModeSequences(text: string): 'enable' | 'disable' | null {
  let verdict: 'enable' | 'disable' | null = null;
  const re = /\x1b\[\?([0-9;]+)([hl])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1].split(';').includes('9001')) {
      verdict = m[2] === 'h' ? 'enable' : 'disable';
    }
  }
  return verdict;
}

// Win32 KEY_EVENT_RECORD.dwControlKeyState bits we set. Right/Left Ctrl/Alt on a
// CHORD (not the modifier key's own event) always emit the LEFT_* bit — a
// deliberate, documented approximation, not a gap: crossterm (what Codex and
// effectively every other Rust console app on Windows uses to read INPUT_RECORDs)
// normalizes LEFT_CTRL_PRESSED/RIGHT_CTRL_PRESSED into a single unified
// KeyModifiers::CONTROL bit before the app ever sees it, so no real consumer
// observes the difference. See design 043 "Revisions after dual review".
const RIGHT_ALT_PRESSED = 0x0001;
const LEFT_ALT_PRESSED = 0x0002;
const RIGHT_CTRL_PRESSED = 0x0004;
const LEFT_CTRL_PRESSED = 0x0008;
const SHIFT_PRESSED = 0x0010;
const NUMLOCK_ON = 0x0020;
const SCROLLLOCK_ON = 0x0040;
const CAPSLOCK_ON = 0x0080;

// Named keys that have a real control-character Unicode value on a physical
// keyboard, distinct from their (empty) DOM `key` length. Everything else with
// `key.length !== 1` (arrows, F-keys, modifiers, Home/End/...) has no natural
// character -> Uc=0.
const NAMED_KEY_CHAR: Record<string, number> = {
  Enter: 13, Tab: 9, Backspace: 8, Escape: 27,
};

// Ctrl-modified keys whose real Windows-console Unicode value is NOT simply
// "the named key's own char" (Ctrl+Enter is LF=10, not CR=13) or isn't a letter
// (so the a-z regex below wouldn't catch it), but still has a defined legacy
// control-character value on a physical keyboard.
const CTRL_CHAR_OVERRIDE: Record<string, number> = {
  Enter: 10, Backspace: 127, ' ': 0, '[': 27, '\\': 28, ']': 29, '^': 30, '_': 31,
};

// VK_* -> PC/AT Set-1 scan code (make code), approximate: covers letters, digits,
// common punctuation, Enter/Tab/Backspace/Escape/Space, F1-F12, and the nav
// cluster. Unmapped keys fall back to Sc=0 — real consumers (crossterm included)
// weight Vk/Uc/Cs far more heavily than Sc.
const SCAN_CODE_TABLE: Record<number, number> = {
  0x08: 0x0e, 0x09: 0x0f, 0x0d: 0x1c, 0x1b: 0x01, 0x20: 0x39, // Back/Tab/Enter/Esc/Space
  0x10: 0x2a, 0x11: 0x1d, 0x12: 0x38, // Shift/Control/Alt (bare modifier press)
  0x21: 0x49, 0x22: 0x51, 0x23: 0x4f, 0x24: 0x47, // PageUp/PageDown/End/Home
  0x25: 0x4b, 0x26: 0x48, 0x27: 0x4d, 0x28: 0x50, // Left/Up/Right/Down
  0x2d: 0x52, 0x2e: 0x53, // Insert/Delete
  0x30: 0x0b, 0x31: 0x02, 0x32: 0x03, 0x33: 0x04, 0x34: 0x05, // '0'-'4'
  0x35: 0x06, 0x36: 0x07, 0x37: 0x08, 0x38: 0x09, 0x39: 0x0a, // '5'-'9'
  0x41: 0x1e, 0x42: 0x30, 0x43: 0x2e, 0x44: 0x20, 0x45: 0x12, 0x46: 0x21, // A-F
  0x47: 0x22, 0x48: 0x23, 0x49: 0x17, 0x4a: 0x24, 0x4b: 0x25, 0x4c: 0x26, // G-L
  0x4d: 0x32, 0x4e: 0x31, 0x4f: 0x18, 0x50: 0x19, 0x51: 0x10, 0x52: 0x13, // M-R
  0x53: 0x1f, 0x54: 0x14, 0x55: 0x16, 0x56: 0x2f, 0x57: 0x11, 0x58: 0x2d, // S-X
  0x59: 0x15, 0x5a: 0x2c, // Y-Z
  0x70: 0x3b, 0x71: 0x3c, 0x72: 0x3d, 0x73: 0x3e, 0x74: 0x3f, 0x75: 0x40, // F1-F6
  0x76: 0x41, 0x77: 0x42, 0x78: 0x43, 0x79: 0x44, 0x7a: 0x57, 0x7b: 0x58, // F7-F12
  0xba: 0x27, 0xbb: 0x0d, 0xbc: 0x33, 0xbd: 0x0c, 0xbe: 0x34, 0xbf: 0x35, // ; = , - . /
  0xc0: 0x29, 0xdb: 0x1a, 0xdc: 0x2b, 0xdd: 0x1b, 0xde: 0x28, // ` [ \ ] '
};

/** Ctrl+letter's real Windows console Unicode value is the legacy control
 *  character (Ctrl+A=1 .. Ctrl+Z=26), not the plain letter. */
function controlTranslatedChar(key: string): number {
  return key.toUpperCase().charCodeAt(0) - 64;
}

// Shift+Enter's Uc is LF (10), not the named key's CR (13). The two consumer
// types see different halves of the record: INPUT_RECORD readers (codex — every
// crossterm app) key off Vk=VK_RETURN + SHIFT_PRESSED and ignore Uc, while
// VT-byte readers (claude, gemini — Node/Bun stdin) never see Vk or Cs at all;
// ConPTY hands them only its translation of Uc. With Uc=13 that translation is a
// bare CR — indistinguishable from plain Enter, so Shift+Enter submits instead of
// inserting a newline. Uc=10 preserves the LF-shim semantics those CLIs rely on
// (their Windows Terminal story is a user keybinding that sends "\n") without
// costing INPUT_RECORD readers anything. Shift-only: Ctrl+Enter already maps to
// 10 via CTRL_CHAR_OVERRIDE, and Alt chords keep the canonical 13.
function shiftEnterLf(e: KeyboardEvent): boolean {
  return e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
}

function unicodeChar(e: KeyboardEvent): number {
  if (e.ctrlKey && e.key in CTRL_CHAR_OVERRIDE) return CTRL_CHAR_OVERRIDE[e.key];
  if (shiftEnterLf(e)) return 10;
  if (e.key in NAMED_KEY_CHAR) return NAMED_KEY_CHAR[e.key];
  if (!isSingleChar(e.key)) return 0;
  if (e.ctrlKey && /^[a-zA-Z]$/.test(e.key)) return controlTranslatedChar(e.key);
  return e.key.codePointAt(0) as number;
}

function controlKeyState(e: KeyboardEvent): number {
  let cs = 0;
  if (e.shiftKey) cs |= SHIFT_PRESSED;
  if (e.ctrlKey) cs |= e.location === 2 ? RIGHT_CTRL_PRESSED : LEFT_CTRL_PRESSED;
  if (e.altKey) cs |= e.location === 2 ? RIGHT_ALT_PRESSED : LEFT_ALT_PRESSED;
  if (typeof e.getModifierState === 'function') {
    if (e.getModifierState('CapsLock')) cs |= CAPSLOCK_ON;
    if (e.getModifierState('NumLock')) cs |= NUMLOCK_ON;
    if (e.getModifierState('ScrollLock')) cs |= SCROLLLOCK_ON;
  }
  return cs;
}

/**
 * Pure: DOM key event + whether Win32-Input-Mode is active -> a
 * `CSI Vk;Sc;Uc;Kd;Cs;Rc_` record, or null meaning "not ours — let xterm handle
 * it" (inactive, IME composition, AltGr-produced text, or a non-key event type).
 */
export function encodeWin32Key(e: KeyboardEvent, active: boolean): string | null {
  if (!active) return null;
  if (e.isComposing) return null;
  if (e.type !== 'keydown' && e.type !== 'keyup') return null;
  if (isAltGraph(e)) return null;

  const vk = e.keyCode;
  const sc = SCAN_CODE_TABLE[vk] ?? 0;
  const uc = unicodeChar(e);
  const kd = e.type === 'keydown' ? 1 : 0;
  const cs = controlKeyState(e);
  return `\x1b[${vk};${sc};${uc};${kd};${cs};1_`;
}
