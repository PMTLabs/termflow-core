/**
 * engine.mount-refusal.test.ts
 *
 * design/013 §5 / rev 7 — what `mount()` is allowed to have done when it returns
 * `false`, and what it must survive on its way to returning `true`.
 *
 * Review 132 then found that "left the engine exactly as it was" was still not true
 * of the code: the cached terminal's font sync ran before the fatal move (reverting
 * a live zoom), a malformed cache entry was refused only AFTER both commit points,
 * and `unmount()`'s own sweeps were still unguarded. Those are the last three tests
 * in this file.
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

  it('continues unmount() past a throwing disposer in EITHER array', () => {
    // Review 132 MEDIUM 3. unmount() splices the SHARED cache arrays before running
    // them, so a thrower that escapes strands every later disposer FOREVER: the
    // entry is already empty, and the reattach sweeps have nothing left to retry.
    // The pre-existing no-double-dispose test uses only non-throwing callbacks and
    // cannot reach this.
    const engine = new TerminalEngine(makeBridge(), { cacheKey: 'unmount-throws' });
    expect(engine.mount(makeContainer())).toBe(true);
    const entry = terminalCache.get('unmount-throws')!;

    let localSentinel = 0;
    let containerSentinel = 0;
    // Each sentinel sits AFTER a thrower in its own array, so it runs only if that
    // array's sweep isolated the failure; the CONTAINER sentinel additionally proves
    // the second sweep ran at all after the first array threw.
    entry.disposables.push(() => { throw new Error('test: local disposer'); });
    entry.disposables.push(() => { localSentinel += 1; });
    entry.containerDisposables.push(() => { throw new Error('test: container disposer'); });
    entry.containerDisposables.push(() => { containerSentinel += 1; });

    expect(() => engine.unmount()).not.toThrow();

    expect(localSentinel).toBe(1);
    expect(containerSentinel).toBe(1);
    expect(entry.disposables).toHaveLength(0);
    expect(entry.containerDisposables).toHaveLength(0);
    // …and the teardown AFTER the sweeps completed too — the throw used to exit
    // unmount() before any of this.
    expect((engine as any).container).toBeNull();
    expect((engine as any).endedRegions).toBeUndefined();
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

describe('review 132 — a refusal must not mutate the cached terminal either', () => {
  it('keeps a live zoom when the move is refused (MEDIUM 1)', () => {
    // The font sync used to run BEFORE the fatal appendChild, reading
    // `opts.fontSize` — which setFontSize() never updates. A refused move therefore
    // silently reverted a user's zoom on a terminal that stayed exactly where it was.
    const engine = new TerminalEngine(makeBridge(), { cacheKey: 'refuse-font', fontSize: 14 });
    const paneA = makeContainer();
    expect(engine.mount(paneA)).toBe(true);
    const entry = terminalCache.get('refuse-font')!;
    expect(entry.terminal.options.fontSize).toBe(14);

    engine.setFontSize(20);
    expect(entry.terminal.options.fontSize).toBe(20);

    const bad = makeContainer();
    bad.appendChild = () => { throw new Error('test: HierarchyRequestError'); };
    expect(engine.mount(bad)).toBe(false);

    // The visible terminal never moved, so it must not have been re-sized either.
    expect(entry.terminal.options.fontSize).toBe(20);
    expect(entry.terminal.element!.parentElement).toBe(paneA);
  });

  it('refuses a malformed cache entry BEFORE moving the surface (MEDIUM 2)', () => {
    // A cached entry with a render element but no fitAddon reached the surface move,
    // the observer disconnect, the array replacement and both cached disposal sweeps
    // — and only THEN returned false, restoring nothing but `this.container`.
    const engine = new TerminalEngine(makeBridge(), { cacheKey: 'malformed' });
    const paneA = makeContainer();
    expect(engine.mount(paneA)).toBe(true);
    const entry = terminalCache.get('malformed')!;
    const observer = CapturingResizeObserver.instances[
      CapturingResizeObserver.instances.length - 1
    ];

    let sweptLocal = 0;
    let sweptContainer = 0;
    entry.disposables.push(() => { sweptLocal += 1; });
    entry.containerDisposables.push(() => { sweptContainer += 1; });
    const localsBefore = entry.disposables.length;
    const containersBefore = entry.containerDisposables.length;

    // The skew this models: a cache entry written by another runtime/version.
    (entry as unknown as { fitAddon: unknown }).fitAddon = undefined;

    const paneB = makeContainer();
    expect(engine.mount(paneB)).toBe(false);

    // DOM placement, observer identity and disposer ownership are all untouched.
    expect(entry.terminal.element!.parentElement).toBe(paneA);
    expect(paneB.querySelectorAll('.xterm')).toHaveLength(0);
    expect(observer.disconnected).toBe(false);
    expect((engine as any).resizeObserver).toBe(observer);
    expect((engine as any).container).toBe(paneA);
    expect(sweptLocal).toBe(0);
    expect(sweptContainer).toBe(0);
    expect(entry.disposables).toHaveLength(localsBefore);
    expect(entry.containerDisposables).toHaveLength(containersBefore);
  });
});

describe('review 134 — a refusal must not evict ANOTHER engine\'s surface', () => {
  // The third uncatalogued pre-commit mutation, and the only one restoring
  // `this.container` could never have covered: `detachForeignSurfaces()` ran
  // unconditionally at the very top of mount(), ahead of EVERY refusal check, and
  // called `element.remove()` on a different engine's live surface while recording
  // nothing. A refused mount therefore blanked a pane belonging to an engine that
  // still believed it was mounted, and the refusing caller — which sees only
  // `false` — could neither detect nor repair it.
  //
  // Both tests also assert that a SUCCEEDING mount still evicts. Without that half
  // they would pass just as well with detachForeignSurfaces deleted outright, which
  // would reopen the two-`.xterm` pane leak of design/012 §14 criterion 7.

  it('leaves a foreign surface alone when the REATTACH is refused', () => {
    const pane = makeContainer();

    // X is live in the pane.
    const x = new TerminalEngine(makeBridge(), { cacheKey: 'foreign-refuse-x' });
    expect(x.mount(pane)).toBe(true);
    const xElement = terminalCache.get('foreign-refuse-x')!.terminal.element!;
    expect(xElement.parentElement).toBe(pane);

    // Y is live somewhere else, so its move into the pane takes the reattach path.
    const y = new TerminalEngine(makeBridge(), { cacheKey: 'foreign-refuse-y' });
    const elsewhere = makeContainer();
    expect(y.mount(elsewhere)).toBe(true);
    const yElement = terminalCache.get('foreign-refuse-y')!.terminal.element!;

    // Refuse Y's move into X's pane. Note `remove()` does not go through
    // `appendChild`, so the eviction still fires while the move cannot.
    (pane as unknown as { appendChild: unknown }).appendChild = () => {
      throw new Error('test: HierarchyRequestError');
    };
    expect(y.mount(pane)).toBe(false);
    delete (pane as unknown as { appendChild?: unknown }).appendChild;

    // THE ASSERTION: X is untouched — still placed, still connected, still usable.
    expect(xElement.parentElement).toBe(pane);
    expect(xElement.isConnected).toBe(true);
    expect(x.terminal).toBe(terminalCache.get('foreign-refuse-x')!.terminal);
    expect((x as unknown as { container: unknown }).container).toBe(pane);
    // …and Y really did refuse, rather than quietly succeeding.
    expect(yElement.parentElement).toBe(elsewhere);

    // The eviction is not disabled: a mount that COMMITS still takes the pane over.
    expect(y.mount(pane)).toBe(true);
    expect(yElement.parentElement).toBe(pane);
    expect(xElement.isConnected).toBe(false);
    expect(pane.querySelectorAll('.xterm')).toHaveLength(1);
  });

  it('leaves a foreign surface alone when a CREATE is refused', () => {
    const pane = makeContainer();

    const x = new TerminalEngine(makeBridge(), { cacheKey: 'foreign-create-x' });
    expect(x.mount(pane)).toBe(true);
    const xElement = terminalCache.get('foreign-create-x')!.terminal.element!;

    const proto = Terminal.prototype as unknown as { open(container: HTMLElement): void };
    const realOpen = proto.open;
    let failNextOpen = true;
    proto.open = function patchedOpen(container: HTMLElement) {
      realOpen.call(this, container);
      if (failNextOpen) {
        failNextOpen = false;
        throw new Error('test: renderer initialization failed after append');
      }
    };

    try {
      // Y has no cache entry, so this is the CREATE path.
      const y = new TerminalEngine(makeBridge(), { cacheKey: 'foreign-create-y' });
      expect(y.mount(pane)).toBe(false);

      // X survived the refusal, and the abandoned surface took itself with it.
      expect(xElement.parentElement).toBe(pane);
      // Identity, not throwiness (rev 16, test audit `150` L1): a reassignment to a
      // truthy-but-wrong Terminal keeps `not.toThrow()` green. This site had no
      // container check either, so it was the weakest of the three.
      expect(x.terminal).toBe(terminalCache.get('foreign-create-x')!.terminal);
      expect(pane.querySelectorAll('.xterm')).toHaveLength(1);

      // The retry commits, and NOW X is evicted.
      const y2 = new TerminalEngine(makeBridge(), { cacheKey: 'foreign-create-y' });
      expect(y2.mount(pane)).toBe(true);
      expect(xElement.isConnected).toBe(false);
      expect(pane.querySelectorAll('.xterm')).toHaveLength(1);
      expect(terminalCache.get('foreign-create-y')!.terminal.element!.parentElement).toBe(pane);
    } finally {
      proto.open = realOpen;
    }
  });
});

/**
 * rev 16 (test audit `150` C1) — the refused-create teardown must survive a THROWING
 * `term.dispose()`.
 *
 * This could not be written before: the xterm mock's `dispose()` was `{}`, so nothing
 * could throw, and DELETING the production `try/catch` around it failed no test. The
 * mock now cascades to the loaded addons and re-throws their errors, as the real
 * `Terminal.dispose()` does via `AddonManager` + the lifecycle helper.
 *
 * What the guard protects: if the throw escapes, `orphanElement.remove()` and the
 * `this.container` restore are both skipped — leaving a dead surface in the pane AND
 * the engine pointing at a container it never committed to.
 */
describe('a refused create survives a throwing term.dispose() (rev 16)', () => {
  it('still removes the orphan surface and restores the container', () => {
    const proto = Terminal.prototype as unknown as {
      open(container: HTMLElement): void;
      loadAddon(addon: unknown): void;
    };
    const realOpen = proto.open;
    const realLoad = proto.loadAddon;

    // Poison exactly one addon so the cascading dispose() throws, as the real
    // Terminal.dispose() would when an addon teardown fails.
    proto.loadAddon = function patchedLoad(this: unknown, addon: unknown) {
      realLoad.call(this, addon);
      realLoad.call(this, { dispose() { throw new Error('test: addon teardown failed'); } });
      proto.loadAddon = realLoad;
    };
    // open() appends its element and THEN throws — the documented refused-create shape.
    proto.open = function patchedOpen(this: unknown, container: HTMLElement) {
      realOpen.call(this, container);
      throw new Error('test: renderer initialization failed after append');
    };

    try {
      const previous = makeContainer();
      const pane = makeContainer();
      const engine = new TerminalEngine(makeBridge(), { cacheKey: 'dispose-throws' });
      (engine as unknown as { container: HTMLElement }).container = previous;

      // The refusal must not propagate, even though the cleanup's dispose() throws.
      expect(() => engine.mount(pane)).not.toThrow();

      // THE ASSERTIONS the escaping throw would have skipped.
      expect(pane.querySelectorAll('.xterm')).toHaveLength(0);
      expect((engine as unknown as { container: HTMLElement }).container).toBe(previous);
      expect(terminalCache.has('dispose-throws')).toBe(false);
    } finally {
      proto.open = realOpen;
      proto.loadAddon = realLoad;
    }
  });
});
