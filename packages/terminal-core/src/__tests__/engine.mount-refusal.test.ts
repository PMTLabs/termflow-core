/**
 * engine.mount-refusal.test.ts
 *
 * design/013 §5 / rev 6 — what `mount()` is allowed to have done when it returns
 * `false`, and what it must survive on its way to returning `true`.
 *
 * Review 129 found three ways the round-5 shape still broke that contract:
 *
 *   1. the observer disconnect and the two disposer-array replacements happened
 *      BEFORE the fatal surface move, so a refusal half-dismantled a live mount;
 *   2. a `term.open()` that appended its element and then threw was abandoned
 *      un-disposed and un-removed, and — never having reached `terminalCache` —
 *      was invisible to `detachForeignSurfaces` on the retry;
 *   3. the two cached disposal sweeps were unguarded, so one throwing disposer
 *      escaped `mount()` entirely and left the surface moved but nothing wired;
 *      and `unmount()` consumed its arrays without emptying the ones the CACHE
 *      still points at, so a reattach ran every disposer a second time.
 *
 * The tests below are written against the ORIGINAL, live engine on purpose. The
 * round-5 regression in renderPolicy.test.ts used a fresh second engine, whose
 * observer and disposer arrays were empty before the refused call — so it could
 * not observe any of the teardown it was meant to forbid.
 */

import { TerminalEngine } from '../TerminalEngine';
import { terminalCache } from '../cache';
import { Terminal } from '@xterm/xterm';
import type { TerminalBridge, Disposable } from '../types';

function makeBridge(): TerminalBridge {
  const noop: Disposable = { dispose() {} };
  return { onData: () => noop, onExit: () => noop, write: () => {}, resize: () => {} };
}

function makeContainer(): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'offsetWidth', { value: 800, configurable: true });
  Object.defineProperty(el, 'offsetHeight', { value: 600, configurable: true });
  Object.defineProperty(el, 'offsetParent', { value: document.body, configurable: true });
  document.body.appendChild(el);
  return el;
}

/** Records `disconnect()` — the mutation finding 1 is about — and the observed node. */
class CapturingResizeObserver {
  static instances: CapturingResizeObserver[] = [];
  cb: ResizeObserverCallback;
  disconnected = false;
  observed: unknown = null;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
    CapturingResizeObserver.instances.push(this);
  }
  observe(el: unknown): void {
    this.observed = el;
  }
  disconnect(): void {
    this.disconnected = true;
  }
  unobserve(): void {}
  fire(): void {
    this.cb([] as unknown as ResizeObserverEntry[], this as unknown as ResizeObserver);
  }
}

let prevRO: unknown;
let prevRaf: unknown;

beforeEach(() => {
  terminalCache.clear();
  CapturingResizeObserver.instances = [];
  prevRO = (globalThis as any).ResizeObserver;
  (globalThis as any).ResizeObserver = CapturingResizeObserver;
  // The observer callback defers its fit through rAF; run it inline so a fired
  // observer is observable synchronously.
  prevRaf = (globalThis as any).requestAnimationFrame;
  (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  };
});

afterEach(() => {
  terminalCache.clear();
  document.body.innerHTML = '';
  if (prevRO === undefined) delete (globalThis as any).ResizeObserver;
  else (globalThis as any).ResizeObserver = prevRO;
  if (prevRaf === undefined) delete (globalThis as any).requestAnimationFrame;
  else (globalThis as any).requestAnimationFrame = prevRaf;
});

describe('review 129 finding 1 — a refused move must not dismantle the live mount', () => {
  it('leaves the ORIGINAL engine\'s observer, handlers and later mounts intact', () => {
    let focusCalls = 0;
    const engine = new TerminalEngine(makeBridge(), {
      cacheKey: 'refuse-live',
      isMac: false,
      onOpenSearch: () => { focusCalls += 1; },
    });
    const paneA = makeContainer();
    expect(engine.mount(paneA)).toBe(true);
    engine.setActive(true);

    const entry = terminalCache.get('refuse-live')!;
    const term = entry.terminal as unknown as { focusCount: number };
    const fit = entry.fitAddon as unknown as {
      fitCount: number;
      setNextFit(cols: number, rows: number): void;
    };
    const observer = CapturingResizeObserver.instances[
      CapturingResizeObserver.instances.length - 1
    ];
    expect((engine as any).resizeObserver).toBe(observer);
    expect(observer.observed).toBe(paneA);

    // Now refuse a move on THIS engine — the documented "pane moved to a new
    // container" path, with a container `appendChild` rejects.
    const bad = makeContainer();
    bad.appendChild = () => {
      throw new Error('test: HierarchyRequestError');
    };
    expect(engine.mount(bad)).toBe(false);

    // (a) The observer pane A depends on was never touched. Asserted as
    // `disconnect()` was NOT called rather than by firing the callback: the
    // captured callback closure keeps working after a disconnect, so a fire-only
    // assertion would pass even with the observer torn down.
    expect(observer.disconnected).toBe(false);
    expect((engine as any).resizeObserver).toBe(observer);
    // ...and it still drives a fit against pane A, not the container it refused.
    expect((engine as any).container).toBe(paneA);
    const fitsBefore = fit.fitCount;
    fit.setNextFit(80, 24);
    observer.fire();
    expect(fit.fitCount).toBe(fitsBefore + 1);

    // (b) The container handlers are still on pane A, and exactly once — a
    // duplicate wiring would double-count each event.
    const focusBefore = term.focusCount;
    paneA.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(term.focusCount).toBe(focusBefore + 1);
    paneA.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
    expect(focusCalls).toBe(1);
    // The engine still OWNS them, which is what makes (c) possible.
    expect((engine as any).containerDisposables.length).toBe(4);
    expect((engine as any).disposables.length).toBeGreaterThan(0);

    // (c) unmount() can still remove them. This is the assertion the round-5
    // regression could not make: with the arrays replaced by the refusal, the
    // listeners outlived every teardown path the engine has.
    engine.unmount();
    const focusAfterUnmount = term.focusCount;
    paneA.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    paneA.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
    expect(term.focusCount).toBe(focusAfterUnmount);
    expect(focusCalls).toBe(1);

    // (d) …and a later mount still succeeds on the same cache entry.
    const paneB = makeContainer();
    expect(engine.mount(paneB)).toBe(true);
    expect(engine.terminal).toBe(entry.terminal);
    expect(entry.terminal.element!.parentElement).toBe(paneB);
  });
});

describe('review 129 finding 2 — a term.open() that throws must not leave a surface behind', () => {
  it('disposes the half-opened terminal, empties the host, and retries to ONE surface', () => {
    const proto = Terminal.prototype as unknown as {
      open(container: HTMLElement): void;
      dispose(): void;
    };
    const realOpen = proto.open;
    const realDispose = proto.dispose;
    let disposeCalls = 0;
    let failNextOpen = true;
    proto.open = function patchedOpen(container: HTMLElement) {
      // Real xterm appends its element and initializes browser services before a
      // late renderer/DOM step can throw. Model exactly that.
      realOpen.call(this, container);
      if (failNextOpen) {
        failNextOpen = false;
        throw new Error('test: renderer initialization failed after append');
      }
    };
    proto.dispose = function patchedDispose(this: unknown) {
      disposeCalls += 1;
      realDispose.call(this);
    };

    try {
      const pane = makeContainer();
      const engine = new TerminalEngine(makeBridge(), { cacheKey: 'open-throws' });
      expect(engine.mount(pane)).toBe(false);

      // The abandoned Terminal was torn down, not merely dropped...
      expect(disposeCalls).toBe(1);
      // ...and its element is gone from the pane. Nothing reached terminalCache,
      // so detachForeignSurfaces could never have cleaned this up later.
      expect(terminalCache.has('open-throws')).toBe(false);
      expect(pane.querySelectorAll('.xterm')).toHaveLength(0);

      // The retry — production builds a fresh engine per React mount — leaves the
      // pane with exactly one surface.
      const engine2 = new TerminalEngine(makeBridge(), { cacheKey: 'open-throws' });
      expect(engine2.mount(pane)).toBe(true);
      expect(pane.querySelectorAll('.xterm')).toHaveLength(1);
      expect(terminalCache.get('open-throws')!.terminal.element!.parentElement).toBe(pane);
    } finally {
      proto.open = realOpen;
      proto.dispose = realDispose;
    }
  });
});

describe('review 129 finding 3 — a throwing cached disposer must not abort the reattach', () => {
  it('isolates the failure, runs the rest, and completes the mount', () => {
    const engine = new TerminalEngine(makeBridge(), { cacheKey: 'disposer-throws' });
    const paneA = makeContainer();
    expect(engine.mount(paneA)).toBe(true);
    const entry = terminalCache.get('disposer-throws')!;

    let localSentinel = 0;
    let containerSentinel = 0;
    entry.disposables.push(() => {
      throw new Error('test: a non-idempotent local disposer');
    });
    entry.disposables.push(() => { localSentinel += 1; });
    entry.containerDisposables.push(() => {
      throw new Error('test: a non-idempotent container disposer');
    });
    entry.containerDisposables.push(() => { containerSentinel += 1; });

    const paneB = makeContainer();
    // Production builds a fresh engine per React mount; the cached arrays are the
    // previous mount's, which is exactly the shape the finding describes.
    const engine2 = new TerminalEngine(makeBridge(), { cacheKey: 'disposer-throws' });
    expect(engine2.mount(paneB)).toBe(true);

    // Each sentinel sits AFTER a thrower, so it only runs if the sweep isolated it.
    expect(localSentinel).toBe(1);
    expect(containerSentinel).toBe(1);
    // The new mount is fully wired, not half-mounted.
    expect(() => engine2.terminal).not.toThrow();
    const after = terminalCache.get('disposer-throws')!;
    expect(after.terminal).toBe(entry.terminal);
    expect(after.terminal.element!.parentElement).toBe(paneB);
    expect((engine2 as any).containerDisposables.length).toBe(4);
    expect((engine2 as any).resizeObserver).not.toBeNull();
  });

  it('does not run a disposer twice when unmount() already consumed it', () => {
    const engine = new TerminalEngine(makeBridge(), { cacheKey: 'disposer-twice' });
    expect(engine.mount(makeContainer())).toBe(true);
    const entry = terminalCache.get('disposer-twice')!;

    let localRuns = 0;
    let containerRuns = 0;
    entry.disposables.push(() => { localRuns += 1; });
    entry.containerDisposables.push(() => { containerRuns += 1; });

    engine.unmount();
    expect(localRuns).toBe(1);
    expect(containerRuns).toBe(1);
    // unmount() must empty the arrays the CACHE still points at, not just swap the
    // engine's own references — the reattach sweeps read the cache entry.
    expect(entry.disposables).toHaveLength(0);
    expect(entry.containerDisposables).toHaveLength(0);

    const engine2 = new TerminalEngine(makeBridge(), { cacheKey: 'disposer-twice' });
    expect(engine2.mount(makeContainer())).toBe(true);
    expect(localRuns).toBe(1);
    expect(containerRuns).toBe(1);
  });
});
