/**
 * engine.suggest-gate.test.ts
 *
 * design/012 §5.11 + §8.1 — §13 T17e.
 *
 * Why a GATE and not a one-shot close (review 093 B3). Without it:
 * emitInputLine -> opts.onInputLineChanged -> useCommandSuggest's
 * onInputLineChanged (useCommandSuggest.ts:40-58) re-opens on the next matching
 * input line, calling setSuggestPopupState('passive') (:57) and
 * setState({ open: true … anchor }) (:58). From that moment the engine intercepts
 * the popup key set instead of forwarding it, because the interception is gated
 * ONLY on `this.suggestState !== 'closed'` (TerminalEngine.ts:1346). So after the
 * user submits one command on a canvas node, arrow keys, Tab and Enter stop
 * reaching the shell — while the popup is drawn inside the OFF-SCREEN pane,
 * anchored by getCursorPixelPosition() (:2963-2976) which reads `this.container`
 * (:2965), now the canvas host. Doubly wrong, and a broken terminal.
 *
 * The gate makes design 012 §8's "Suggest popup: cannot open" true BY
 * CONSTRUCTION: while paneChromeActive is false the engine emits no input lines,
 * so the hook never re-opens, so suggestState never leaves 'closed', so no key is
 * ever claimed.
 */

import { TerminalEngine } from '../TerminalEngine';
import { terminalCache } from '../cache';
import type { TerminalBridge, Disposable } from '../types';

function makeFakeBridge(): TerminalBridge {
  const noopDisposable: Disposable = { dispose() {} };
  return {
    onData: () => noopDisposable,
    onExit: () => noopDisposable,
    write: () => {},
    resize: () => {},
  };
}

function makeContainer(width = 800, height = 600): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-display-wrapper';
  const el = document.createElement('div');
  el.className = 'terminal-display';
  Object.defineProperty(el, 'offsetWidth', { value: width, configurable: true });
  Object.defineProperty(el, 'offsetHeight', { value: height, configurable: true });
  Object.defineProperty(el, 'offsetParent', { value: document.body, configurable: true });
  wrapper.appendChild(el);
  document.body.appendChild(wrapper);
  return el;
}

let prevRO: unknown;

beforeEach(() => {
  terminalCache.clear();
  prevRO = (globalThis as any).ResizeObserver;
  (globalThis as any).ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  };
});

afterEach(() => {
  terminalCache.clear();
  document.body.innerHTML = '';
  if (prevRO === undefined) delete (globalThis as any).ResizeObserver;
  else (globalThis as any).ResizeObserver = prevRO;
});

describe('design/012 §8.1 — the suggest gate', () => {
  it('emits input lines normally while pane chrome is active', () => {
    const emitted: string[] = [];
    const engine = new TerminalEngine(makeFakeBridge(), {
      cacheKey: 'sg-on',
      onInputLineChanged: (t) => emitted.push(t),
    });
    engine.mount(makeContainer());

    (engine as any).emitInputLine('git st');
    expect(emitted).toEqual(['git st']);
  });

  it('emits nothing at all while pane chrome is inactive', () => {
    const emitted: string[] = [];
    const engine = new TerminalEngine(makeFakeBridge(), {
      cacheKey: 'sg-off',
      onInputLineChanged: (t) => emitted.push(t),
    });
    engine.mount(makeContainer());
    (engine as any).paneChromeActive = false;

    (engine as any).emitInputLine('git st');
    (engine as any).emitInputLine('git status');
    expect(emitted).toEqual([]);
  });

  // Belt-and-braces for any future caller: even a direct setSuggestPopupState
  // cannot raise the state on a chromeless host.
  it('refuses to leave the closed state while pane chrome is inactive', () => {
    const engine = new TerminalEngine(makeFakeBridge(), { cacheKey: 'sg-state' });
    engine.mount(makeContainer());
    (engine as any).paneChromeActive = false;

    engine.setSuggestPopupState('passive');
    expect((engine as any).suggestState).toBe('closed');

    (engine as any).paneChromeActive = true;
    engine.setSuggestPopupState('passive');
    expect((engine as any).suggestState).toBe('passive');
  });

  // The consequence that makes the terminal usable: with the popup unable to open,
  // the key interception at :1346 never claims Up/Down/Tab/Enter.
  it('never claims a popup key while pane chrome is inactive', () => {
    const actions: unknown[] = [];
    const engine = new TerminalEngine(makeFakeBridge(), {
      cacheKey: 'sg-keys',
      onSuggestAction: (a) => actions.push(a),
    });
    engine.mount(makeContainer());
    const term = terminalCache.get('sg-keys')!.terminal as any;

    (engine as any).paneChromeActive = false;
    engine.setSuggestPopupState('passive');   // guarded to 'closed'

    for (const key of ['ArrowUp', 'ArrowDown', 'Tab', 'Enter']) {
      const handled = term.keyHandler(
        new KeyboardEvent('keydown', { key, bubbles: true }),
      );
      // `true` means "xterm, you handle it" — i.e. the engine did NOT claim it.
      expect(handled).not.toBe(false);
    }
    expect(actions).toEqual([]);
  });

  // The dedup at :2930 must not swallow the first line after the return trip.
  // R10 resets lastEmittedInput unconditionally for exactly this reason (Task 8).
  it('emits again once pane chrome is restored', () => {
    const emitted: string[] = [];
    const engine = new TerminalEngine(makeFakeBridge(), {
      cacheKey: 'sg-return',
      onInputLineChanged: (t) => emitted.push(t),
    });
    engine.mount(makeContainer());

    (engine as any).emitInputLine('git st');
    (engine as any).paneChromeActive = false;
    (engine as any).emitInputLine('git status');   // swallowed by the gate
    (engine as any).paneChromeActive = true;
    (engine as any).lastEmittedInput = '';          // what R10 does on the way home
    (engine as any).emitInputLine('git status');

    expect(emitted).toEqual(['git st', 'git status']);
  });
});
