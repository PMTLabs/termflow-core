/**
 * engine.mount-foreign-surface.test.ts
 *
 * design/012 §5.7 / §14 criterion 7 — external review 103 finding 2.
 *
 * `mount()` is append-only and `unmount()` deliberately leaves `term.element` in
 * the DOM (the cache still owns the live Terminal, and a later mount reattaches
 * it). Those two facts are individually correct and jointly leave a hole: when a
 * pane node is REUSED for a different terminal id, the outgoing engine's surface
 * is never removed, so the pane ends up hosting two `.xterm` elements — both
 * full-height, the old one still painting backend output through its
 * cache-lifetime subscription, and its cache entry pinned against eviction
 * because `cache.ts:142` skips any entry whose element is still `isConnected`.
 *
 * P0-B makes this reachable on a supported path: the relocation cleanup returns
 * engine A to the captured pane before engine B is installed in it. It is not
 * caused by P0-B though — the bare mount/unmount/mount sequence below reproduces
 * it on `develop` with no canvas involved, which is why the fix belongs in
 * `mount()` rather than in the relocation cleanup.
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

function makeHost(width = 800, height = 600): HTMLElement {
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
  TerminalEngine.suppressHealUntil = 0;
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
  jest.useRealTimers();
  TerminalEngine.suppressHealUntil = 0;
  if (prevRO === undefined) delete (globalThis as any).ResizeObserver;
  else (globalThis as any).ResizeObserver = prevRO;
});

function newEngine(cacheKey: string) {
  return new TerminalEngine(makeFakeBridge(), { cacheKey, isMac: false });
}

const xtermsIn = (host: HTMLElement) => Array.from(host.querySelectorAll('.xterm'));

describe('design/012 §14 criterion 7 — one engine\'s surface never lands in another\'s pane', () => {
  it('drops a foreign surface when a pane node is reused for a different terminal id',
    async () => {
      jest.useFakeTimers();
      const pane = makeHost();

      // Engine A takes the pane.
      const a = newEngine('mount-foreign-a');
      a.mount(pane);
      a.attach('pid-a');
      await jest.runAllTimersAsync();
      const aElement = terminalCache.get('mount-foreign-a')!.terminal.element!;
      expect(xtermsIn(pane)).toEqual([aElement]);

      // A goes away, but unmount() deliberately leaves its element in the DOM.
      a.unmount();
      expect(aElement.isConnected).toBe(true);

      // The SAME pane node is now reused for a different terminal id.
      const b = newEngine('mount-foreign-b');
      b.mount(pane);
      b.attach('pid-b');
      await jest.runAllTimersAsync();
      const bElement = terminalCache.get('mount-foreign-b')!.terminal.element!;

      // THE ASSERTION: exactly one surface in the pane, and it is B's.
      expect(xtermsIn(pane)).toEqual([bElement]);
      // …and A's is detached, which is what makes its cache entry eligible for
      // the cap eviction at cache.ts:142 again.
      expect(aElement.isConnected).toBe(false);
    });

  it('does not disturb its own surface when the same engine remounts into the same pane',
    async () => {
      jest.useFakeTimers();
      const pane = makeHost();

      const a = newEngine('mount-foreign-same');
      a.mount(pane);
      a.attach('pid-a');
      await jest.runAllTimersAsync();
      const aElement = terminalCache.get('mount-foreign-same')!.terminal.element!;

      a.unmount();
      // A tab switch back: same cache key, same pane node, reattach path.
      const a2 = newEngine('mount-foreign-same');
      a2.mount(pane);
      await jest.runAllTimersAsync();

      // The cached Terminal is reused, so the very same element must still be
      // there — the guard must key on identity, not on "is an .xterm".
      expect(terminalCache.get('mount-foreign-same')!.terminal.element).toBe(aElement);
      expect(xtermsIn(pane)).toEqual([aElement]);
      expect(aElement.isConnected).toBe(true);
    });

  it('leaves non-terminal siblings in the pane alone', async () => {
    jest.useFakeTimers();
    const pane = makeHost();
    const overlay = document.createElement('div');
    overlay.className = 'terminal-overlay';
    pane.appendChild(overlay);

    const a = newEngine('mount-foreign-siblings');
    a.mount(pane);
    await jest.runAllTimersAsync();

    expect(overlay.isConnected).toBe(true);
    expect(pane.contains(overlay)).toBe(true);
  });
});
