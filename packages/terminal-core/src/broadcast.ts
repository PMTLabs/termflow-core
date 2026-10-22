import type { Terminal } from '@xterm/xterm';
import { terminalCache, pasteToTerminal } from './cache';
import { encodeKey, type KittyKeySnapshot } from './keyboardProtocol';
import { encodeWin32Key } from './win32InputMode';
import { decideWordDeleteShim } from './TerminalEngine';

export type KeyDescriptor = Pick<KeyboardEvent,
  'key' | 'code' | 'keyCode' | 'location' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'repeat'> & {
  type: 'keydown' | 'keyup';
  locks: Record<string, boolean>;
};
export type BroadcastUnit =
  | { kind: 'key'; key: KeyDescriptor; srcBytes: string }
  | { kind: 'paste'; text: string }
  | { kind: 'text'; data: string };
export interface KeyCtx {
  kbSnapshot: KittyKeySnapshot;
  protocolActive: boolean;
  win32Active: boolean;
  shellType?: string;
  isMac: boolean;
  isWindows: boolean;
  macOptionIsMeta?: boolean;
  applicationCursorKeys: boolean;
  normalBuffer?: boolean;
}
export const describe = (event: KeyboardEvent): KeyDescriptor => ({
  type: event.type as KeyDescriptor['type'], key: event.key, code: event.code,
  keyCode: event.keyCode, location: event.location, ctrlKey: event.ctrlKey,
  altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey, repeat: event.repeat,
  locks: Object.fromEntries(['CapsLock', 'NumLock', 'ScrollLock', 'AltGraph']
    .map(name => [name, event.getModifierState?.(name) ?? false])),
});
export const toEventLike = (key: KeyDescriptor): KeyboardEvent => ({
  ...key, getModifierState: (name: string) => key.locks[name] ?? false,
} as unknown as KeyboardEvent);

export function plainEncode(k: KeyDescriptor, applicationCursorKeys = false): string | null {
  if (k.type !== 'keydown') return null;
  const singleChar = [...k.key].length === 1;
  if (singleChar && k.metaKey) return null;
  if (k.locks.AltGraph && singleChar) return k.key;
  const mod = 1 + Number(k.shiftKey) + 2 * Number(k.altKey) + 4 * Number(k.ctrlKey) + 8 * Number(k.metaKey);
  const nav: Record<string, string> = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D', Home: 'H', End: 'F' };
  if (k.metaKey && k.key.startsWith('Arrow')) return null;
  if (k.key === 'Insert') return k.ctrlKey || k.shiftKey ? null : '\x1b[2~';
  if (k.key === 'PageUp' || k.key === 'PageDown') {
    if (k.shiftKey) return null; // xterm scrolls the viewport, even on the alternate buffer.
    return `\x1b[${k.key === 'PageUp' ? 5 : 6}${k.ctrlKey ? `;${mod}` : ''}~`;
  }
  if (nav[k.key]) return mod > 1 ? `\x1b[1;${mod}${nav[k.key]}` : `\x1b${applicationCursorKeys ? 'O' : '['}${nav[k.key]}`;
  const tilde: Record<string, number> = { Insert: 2, Delete: 3, PageUp: 5, PageDown: 6, F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24 };
  if (tilde[k.key]) return `\x1b[${tilde[k.key]}${mod > 1 ? `;${mod}` : ''}~`;
  if (/^F[1-4]$/.test(k.key)) return mod > 1 ? `\x1b[1;${mod}${'PQRS'[Number(k.key.slice(1)) - 1]}` : `\x1bO${'PQRS'[Number(k.key.slice(1)) - 1]}`;
  let data: string | null = null;
  if (k.key === 'Enter') data = '\r';
  else if (k.key === 'Backspace') data = k.ctrlKey ? '\x08' : '\x7f';
  else if (k.key === 'Tab') return k.shiftKey ? '\x1b[Z' : '\t';
  else if (k.key === 'Escape') data = '\x1b';
  else if (singleChar) {
    data = k.key;
    if (k.ctrlKey) {
      const ch = k.key.toUpperCase().charCodeAt(0);
      data = ch >= 64 && ch <= 95 ? String.fromCharCode(ch - 64) : k.key === ' ' ? '\x00' : null;
    }
  }
  return data !== null && k.altKey ? `\x1b${data}` : data;
}

export function decideKeyBytes(k: KeyDescriptor, ctx: KeyCtx): string | null {
  if ((k.key === 'PageUp' || k.key === 'PageDown') && !k.ctrlKey && !k.altKey && !k.shiftKey && !k.metaKey
    && ctx.normalBuffer !== false && !ctx.protocolActive) return null;
  if (k.type === 'keyup' && !ctx.protocolActive) {
    if (k.ctrlKey && !k.shiftKey && k.key === 'c') return null;
    if (decideWordDeleteShim(k.key, k, ctx.normalBuffer !== false, false, ctx.shellType) !== null) return null;
  }
  if (k.type === 'keydown') {
    if (k.key === 'Enter' && k.shiftKey && !k.ctrlKey && !k.altKey && !k.metaKey && !ctx.protocolActive && !ctx.win32Active) return '\n';
    if (ctx.isMac && !k.ctrlKey && !k.shiftKey && (k.key === 'ArrowLeft' || k.key === 'ArrowRight')) {
      const home = k.key === 'ArrowLeft';
      if (k.metaKey && !k.altKey) return ctx.normalBuffer !== false && !ctx.protocolActive
        ? home ? '\x01' : '\x05'
        : `\x1b${ctx.applicationCursorKeys ? 'O' : '['}${home ? 'H' : 'F'}`;
      if (k.altKey && !k.metaKey && !ctx.protocolActive) return home ? '\x1bb' : '\x1bf';
    }
    const shim = decideWordDeleteShim(k.key, k, ctx.normalBuffer !== false, ctx.protocolActive, ctx.shellType);
    if (shim !== null) return shim;
    // Match the engine's deliberate ConPTY interrupt escape hatch.
    if (k.ctrlKey && !k.shiftKey && k.key === 'c' && !ctx.protocolActive) return '\x03';
  }
  const event = toEventLike(k);
  if (ctx.protocolActive) {
    const seq = encodeKey(event, ctx.kbSnapshot);
    if (seq !== null) return seq;
  }
  if (ctx.win32Active && !ctx.protocolActive) {
    const seq = encodeWin32Key(event, true);
    if (seq !== null) return seq; // AltGr defers to xterm's text/keypress path.
  }
  if (k.type === 'keydown' && !k.metaKey && (!k.keyCode || k.keyCode > 47)) {
    const thirdLevel = (ctx.isMac && !ctx.macOptionIsMeta && k.altKey && !k.ctrlKey)
      || (ctx.isWindows && ((k.altKey && k.ctrlKey) || k.locks.AltGraph));
    if (thirdLevel) return [...k.key].length === 1 ? k.key : null;
  }
  return plainEncode(k, ctx.applicationCursorKeys);
}

type Sink = (source: string, unit: BroadcastUnit) => void;
type Fallback = (target: string, data: string) => void | Promise<void>;
let sink: Sink | null = null;
let fallback: Fallback | null = null;
let delivering = 0;
export const isDeliveringBroadcast = (): boolean => delivering > 0;
export const hasBroadcastSink = (): boolean => sink !== null;
export function setBroadcastSink(next: Sink | null, writer: Fallback | null = null): void {
  sink = next;
  fallback = writer;
}
export function emitBroadcast(source: string, unit: BroadcastUnit): void {
  if (!delivering && terminalCache.get(source)?.broadcastAvailable === true) sink?.(source, unit);
}

// The only private xterm input access. Missing/changed internals fail closed.
export function subscribeUserInput(term: Terminal, cb: () => void): { dispose(): void } | null {
  try {
    const service = (term as unknown as { _core?: { coreService?: { onUserInput?: (fn: () => void) => { dispose(): void } } } })._core?.coreService;
    return typeof service?.onUserInput === 'function' ? service.onUserInput(cb) : null;
  } catch { return null; }
}
export function isBroadcastAvailable(): boolean {
  const entries = [...terminalCache.values()];
  return entries.some(entry => entry.broadcastAvailable === true)
    && !entries.some(entry => entry.broadcastAvailable === false);
}
export function withBroadcastPaste(source: string, text: string, paste: () => void): void {
  const entry = terminalCache.get(source);
  if (text && entry?.processId) emitBroadcast(source, { kind: 'paste', text });
  if (entry) entry.inBroadcastPaste = true;
  try { paste(); } finally { if (entry) entry.inBroadcastPaste = false; }
}
// Serialize each PTY's broadcast writes, including paste's engine onData path.
// Start an idle writer synchronously; only pending asynchronous writes need a queue.
// Queues are keyed by terminal id (`queueKey`), never by process id: the fallback
// writer addresses an unmounted terminal by its terminal id, and a write in flight
// across that terminal's mount must stay in the same queue as the next one.
const targetQueues = new Map<string, Promise<void>>();
export function queueBroadcastTargetWrite(
  writer: Fallback | null | undefined, target: string, data: string, queueKey: string = target,
): void {
  const previous = targetQueues.get(queueKey);
  try {
    const result = previous ? previous.then(() => writer?.(target, data)) : writer?.(target, data);
    if (!result) return;
    const next = Promise.resolve(result).then(() => {}, () => {});
    targetQueues.set(queueKey, next);
    void next.then(() => { if (targetQueues.get(queueKey) === next) targetQueues.delete(queueKey); });
  } catch { /* target exited between membership resolution and write */ }
}
export function deliverBroadcast(target: string, unit: BroadcastUnit): void {
  const entry = terminalCache.get(target);
  if (entry && !entry.processId) return;
  const options = entry?.getBroadcastOptions?.();
  const enhanced = options?.enhancedKeyboard ?? true;
  const snapshot = entry?.kbState?.snapshot() ?? { kittyFlags: 0, modifyOtherKeys: 0 };
  const isWindows = options?.isWindows ?? /Win/.test(globalThis.navigator?.platform ?? '');
  const ctx: KeyCtx = {
    kbSnapshot: snapshot, protocolActive: enhanced && !!(snapshot.kittyFlags || snapshot.modifyOtherKeys),
    win32Active: enhanced && isWindows && (entry?.win32State?.isActive() ?? false), shellType: options?.shellType,
    isMac: options?.isMac ?? /Mac/.test(globalThis.navigator?.platform ?? ''),
    isWindows, macOptionIsMeta: options?.macOptionIsMeta,
    applicationCursorKeys: entry?.terminal.modes.applicationCursorKeysMode ?? false,
    normalBuffer: entry?.terminal.buffer.active.type !== 'alternate',
  };
  const submits = unit.kind === 'key'
    ? unit.key.type === 'keydown' && unit.key.key === 'Enter' && !unit.key.shiftKey
    : /[\r\n]/.test(unit.kind === 'paste' ? unit.text : unit.data);
  if (entry && submits) {
    if (entry.disarmBroadcastPrompt) entry.disarmBroadcastPrompt();
    else {
      // Unmounted: the remount restores both, so drop the pre-submit mark with the gate.
      if (entry.promptGate) entry.promptGate = { ...entry.promptGate, armed: false };
      entry.captureMark = null;
    }
  }
  delivering++;
  try {
    if (unit.kind === 'paste' && entry) {
      // Background cached terminals have no mounted onData listener.
      if (entry.broadcastWrite) pasteToTerminal(target, unit.text);
      else {
        const subscription = entry.terminal.onData(data => queueBroadcastTargetWrite(entry.broadcastRawWrite, entry.processId!, data, target));
        try { pasteToTerminal(target, unit.text); } finally { subscription.dispose(); }
      }
      return;
    }
    const data = unit.kind === 'key' ? decideKeyBytes(unit.key, ctx) : unit.kind === 'paste' ? unit.text : unit.data;
    if (data === null) return;
    if (entry?.broadcastRawWrite) queueBroadcastTargetWrite(entry.broadcastRawWrite, entry.processId!, data, target);
    else queueBroadcastTargetWrite(fallback, target, data);
  } finally { delivering--; }
}
