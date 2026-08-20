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

/**
 * `plan/020` §5 — the Canvas overlay draws the popup, so it may open there.
 *
 * The gate's premise is "nobody is rendering this terminal's chrome", and until now that was
 * decided entirely by the last relocation. The overlay falsifies the premise without relocating
 * anything: `plan/017` decision C makes an overlaid node the SAME host at 1:1, so there is no
 * move to carry the change, and the renderer renders the popup itself from `surfaceChrome`.
 *
 * Every assertion above still stands — a plain canvas node has no chrome and stays gated. These
 * only add the case where a host says otherwise.
 */
describe('plan/020 §5 — a host that DOES draw the chrome', () => {
  it('restores emission on a chromeless host when the overlay opens', () => {
    const emitted: string[] = [];
    const engine = new TerminalEngine(makeFakeBridge(), {
      cacheKey: 'ch-on',
      onInputLineChanged: (t) => emitted.push(t),
    });
    engine.mount(makeContainer());
    (engine as any).paneChromeActive = false;       // relocated onto a canvas node

    (engine as any).emitInputLine('git st');
    expect(emitted).toEqual([]);                    // still gated: a node draws nothing

    engine.setChromeHostActive(true);               // the overlay opens
    (engine as any).emitInputLine('git st');
    expect(emitted).toEqual(['git st']);
  });

  /**
   * The dedup is the trap. `emitInputLine` returns early when the text matches the last line it
   * sent, and the gated call above does NOT update that record — but a line sent BEFORE the
   * canvas trip does. Without the reset, opening an overlay on a terminal whose input line has
   * not changed since leaves the popup shut until the user edits it, which reads as the feature
   * being broken exactly where it was just added.
   */
  it('re-emits the current line, so the popup can open on an unchanged input', () => {
    const emitted: string[] = [];
    const engine = new TerminalEngine(makeFakeBridge(), {
      cacheKey: 'ch-dedup',
      onInputLineChanged: (t) => emitted.push(t),
    });
    engine.mount(makeContainer());

    (engine as any).emitInputLine('git st');        // in the pane
    (engine as any).paneChromeActive = false;       // onto the canvas
    engine.setChromeHostActive(true);               // overlay opens; same input line
    (engine as any).emitInputLine('git st');

    expect(emitted).toEqual(['git st', 'git st']);
  });

  it('closes the popup and re-gates when the overlay closes', () => {
    const emitted: string[] = [];
    const engine = new TerminalEngine(makeFakeBridge(), {
      cacheKey: 'ch-off',
      onInputLineChanged: (t) => emitted.push(t),
    });
    engine.mount(makeContainer());
    (engine as any).paneChromeActive = false;
    engine.setChromeHostActive(true);
    engine.setSuggestPopupState('passive');
    expect((engine as any).suggestState).toBe('passive');

    engine.setChromeHostActive(false);              // overlay closes; node draws nothing again
    // The state must not outlive the surface that was showing it, or the engine keeps claiming
    // Up/Down/Tab/Enter for a popup that is no longer on screen.
    expect((engine as any).suggestState).toBe('closed');
    (engine as any).emitInputLine('git status');
    expect(emitted).toEqual([]);
  });

  // A no-op call must stay a no-op: it is driven by a React effect, so it runs on renders that
  // changed nothing. Clearing the popup on one of those would close it under the user's hands.
  it('leaves an open popup alone when the value has not changed', () => {
    const engine = new TerminalEngine(makeFakeBridge(), { cacheKey: 'ch-noop' });
    engine.mount(makeContainer());
    (engine as any).paneChromeActive = false;
    engine.setChromeHostActive(true);
    engine.setSuggestPopupState('passive');

    engine.setChromeHostActive(true);
    expect((engine as any).suggestState).toBe('passive');
  });

  // The gate is still the gate. A relocation states where the surface went, and that answer
  // wins over any overlay the previous host had declared — leaving the canvas ends the overlay.
  it('is overwritten by the next relocation', () => {
    const engine = new TerminalEngine(makeFakeBridge(), { cacheKey: 'ch-reloc' });
    engine.mount(makeContainer());
    (engine as any).paneChromeActive = false;
    engine.setChromeHostActive(true);

    engine.relocateTo(makeContainer(), { paneChrome: false });
    expect((engine as any).paneChromeActive).toBe(false);
  });
});
