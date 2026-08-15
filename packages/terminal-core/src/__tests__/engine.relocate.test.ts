/**
 * engine.relocate.test.ts
 *
 * design/012 §5 R0-R7 — §13 T1, T2, T2b, T2c, T3 (canvas half), T4, T8f, T13
 * (relocation half).
 *
 * The central invariant: relocateTo moves ONLY xterm's own `term.element`, in one
 * synchronous `appendChild`, and is NOT mount(). Per the DOM spec, appendChild of
 * an already-parented node is remove-then-insert inside ONE synchronous algorithm;
 * spike 004 Q2 measured that no observer of any kind (MutationObserver,
 * ResizeObserver, a microtask queued immediately before the call, a synchronous
 * read) ever sees isConnected === false.
 *
 * H1 is the worst failure mode in the file and it is what §5.0 exists to avoid:
 * mount()'s reattach catch-all (TerminalEngine.ts:757-763) deletes the cache entry
 * on ANY thrown error and falls through to CREATE at :767 — a brand-new blank
 * Terminal, the entire scrollback gone, silently. relocateTo never deletes and
 * never creates: it returns 'aborted' and re-wires the previous container WITH ITS
 * RECORDED CHROME MODE.
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

/** A wrapper > display pair, matching TerminalDisplay's real structure and the
 *  host contract design 012 D17 requires of a canvas node. */
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

class CountingResizeObserver {
  static instances: CountingResizeObserver[] = [];
  static disconnects = 0;
  static observed: Element[] = [];
  constructor(public cb: ResizeObserverCallback) {
    CountingResizeObserver.instances.push(this);
  }
  observe(el: Element): void { CountingResizeObserver.observed.push(el); }
  disconnect(): void { CountingResizeObserver.disconnects += 1; }
  unobserve(): void {}
}

let prevRO: unknown;

beforeEach(() => {
  terminalCache.clear();
  CountingResizeObserver.instances = [];
  CountingResizeObserver.disconnects = 0;
  CountingResizeObserver.observed = [];
  prevRO = (globalThis as any).ResizeObserver;
  (globalThis as any).ResizeObserver = CountingResizeObserver;
});

afterEach(() => {
  terminalCache.clear();
  document.body.innerHTML = '';
  if (prevRO === undefined) delete (globalThis as any).ResizeObserver;
  else (globalThis as any).ResizeObserver = prevRO;
});

function mounted(cacheKey: string, opts: Record<string, unknown> = {}) {
  const engine = new TerminalEngine(makeFakeBridge(), {
    cacheKey,
    isMac: false,
    ...opts,
  });
  const pane = makeHost();
  engine.mount(pane);
  const entry = terminalCache.get(cacheKey)!;
  return { engine, pane, entry, term: entry.terminal as any };
}

describe('design/012 §5 — relocateTo, the move', () => {
  // §13 T1 + §5.0's exclusion table, as executable assertions.
  it('keeps the same Terminal, the same cache entry, and touches none of mount()\'s eight things',
    () => {
      const { engine, pane, entry, term } = mounted('rel-t1', { fontSize: 14 });
      const host = makeHost();

      const terminalBefore = entry.terminal;
      const entryBefore = terminalCache.get('rel-t1');
      const trackerBefore = (engine as any).endedRegions;
      const captureBefore = (engine as any).capture;
      const fontBefore = term.options.fontSize;
      const focusBefore = term.focusCount;
      const cacheSizeBefore = terminalCache.size;

      expect(term.element!.isConnected).toBe(true);
      expect(engine.relocateTo(host, { paneChrome: false })).toBe('relocated');
      expect(term.element!.isConnected).toBe(true);

      expect(host.contains(term.element!)).toBe(true);
      expect(pane.contains(term.element!)).toBe(false);

      // Same session, same objects — no mount(), no unmount(), no dispose().
      expect(terminalCache.get('rel-t1')).toBe(entryBefore);
      expect(terminalCache.get('rel-t1')!.terminal).toBe(terminalBefore);
      expect(terminalCache.size).toBe(cacheSizeBefore);
      // No second EndedRegionTracker, no second HeuristicCapture (§5.0 rows 1-2).
      expect((engine as any).endedRegions).toBe(trackerBefore);
      expect((engine as any).capture).toBe(captureBefore);
      // fontSize untouched (§5.0 row 3 / H4): re-applying it would revert every
      // zoom since engine creation, because `opts` is frozen at :678.
      expect(term.options.fontSize).toBe(fontBefore);
      // No unconditional focus (§5.0 row 4): a background pane relocated onto
      // canvas must not steal focus.
      expect(term.focusCount).toBe(focusBefore);
    });

  // §13 T2 / H1. `entry.terminal !== this.term` is the precondition that keeps
  // relocation away from mount()'s catch-all, which deletes the entry and creates
  // a blank Terminal.
  it('aborts and mutates nothing when the preconditions fail', () => {
    const { engine, pane, term } = mounted('rel-t2');
    const host = makeHost();
    const entry = terminalCache.get('rel-t2')!;

    // A foreign Terminal in the entry: the cache no longer describes this engine.
    const foreign = { element: document.createElement('div') } as any;
    entry.terminal = foreign;

    expect(engine.relocateTo(host, { paneChrome: false })).toBe('aborted');

    // Nothing moved, nothing was deleted, and no new Terminal was constructed.
    expect(pane.contains(term.element!)).toBe(true);
    expect(terminalCache.get('rel-t2')).toBe(entry);
    expect(terminalCache.get('rel-t2')!.terminal).toBe(foreign);
    expect(CountingResizeObserver.disconnects).toBe(0);
  });

  it('aborts when the cache entry is missing', () => {
    const { engine, pane, term } = mounted('rel-t2-missing');
    const host = makeHost();
    terminalCache.delete('rel-t2-missing');

    expect(engine.relocateTo(host, { paneChrome: false })).toBe('aborted');
    expect(pane.contains(term.element!)).toBe(true);
  });

  it('aborts for a mirror engine before doing anything at all', () => {
    const { engine, pane, term } = mounted('rel-mirror', { mirror: true });
    const host = makeHost();

    expect(engine.relocateTo(host, { paneChrome: false })).toBe('aborted');
    expect(pane.contains(term.element!)).toBe(true);
  });

  // §13 T2b — the identity no-op. Both §4.2.2 cleanups call this redundantly BY
  // DESIGN, so it must be free.
  it('is a free no-op when the container is already the current one', () => {
    const { engine, pane, entry } = mounted('rel-t2b');
    const disposablesBefore = (engine as any).containerDisposables;
    const epochBefore = (engine as any).resizeEpoch;
    const armBefore = (engine as any).convergenceArmUntil;
    const eligibleBefore = (engine as any).surfaceDisplayed;
    const observerBefore = (engine as any).resizeObserver;
    const disconnectsBefore = CountingResizeObserver.disconnects;

    expect(engine.relocateTo(pane, { paneChrome: true })).toBe('relocated');

    expect((engine as any).containerDisposables).toBe(disposablesBefore);
    expect((engine as any).resizeEpoch).toBe(epochBefore);
    expect((engine as any).convergenceArmUntil).toBe(armBefore);
    expect((engine as any).surfaceDisplayed).toBe(eligibleBefore);
    expect((engine as any).resizeObserver).toBe(observerBefore);
    expect(CountingResizeObserver.disconnects).toBe(disconnectsBefore);
    expect(entry.containerDisposables).toBe(disposablesBefore);
  });

  // The documented call shape. Rev 5 read `opts.paneChrome` bare in R3, which
  // threw TypeError here (reviews 098 C1 + 096, independently).
  it('accepts the no-options call and defaults paneChrome to false', () => {
    const { engine, term } = mounted('rel-optional');
    const host = makeHost();

    expect(engine.relocateTo(host)).toBe('relocated');
    expect(host.contains(term.element!)).toBe(true);
    expect((engine as any).paneChromeActive).toBe(false);
  });

  // §13 T2c / review 094 B5. appendChild throws HierarchyRequestError if the
  // target is INSIDE term.element — reachable if a canvas node ever registers a
  // host that is a descendant of the terminal. appendChild leaves the tree
  // unchanged when it throws, so the element is still in snap.container, and R4/R5
  // have already run: the abort must re-wire, WITH THE RECORDED CHROME MODE.
  it('restores the previous container AND its chrome mode when appendChild throws', () => {
    let openSearchCalls = 0;
    const { engine, pane, term } = mounted('rel-t2c', {
      onOpenSearch: () => { openSearchCalls += 1; },
    });

    // A host that is a descendant of the element we are trying to move.
    const illegal = document.createElement('div');
    term.element!.appendChild(illegal);

    expect(engine.relocateTo(illegal, { paneChrome: false })).toBe('aborted');

    // The element never left.
    expect(pane.contains(term.element!)).toBe(true);
    // And the PANE's four listeners work again, at the chrome mode it had.
    const focusBefore = term.focusCount;
    pane.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(term.focusCount).toBe(focusBefore + 1);
    pane.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
    expect(openSearchCalls).toBe(1);
    expect((engine as any).containerDisposables.length).toBe(4);
    expect((engine as any).paneChromeActive).toBe(true);
  });

  // The direction review 094 B5 caught rev 4 getting WRONG: on an aborted
  // canvas -> pane move, snap.container IS the canvas host, and re-wiring it with a
  // hardcoded `paneChrome: true` would install Ctrl/Cmd+F on it — so ^F would call
  // onOpenSearch, render the bar in the off-screen pane and autofocus its input
  // (TerminalSearchBar.tsx:39-41), pulling focus out of the canvas.
  it('restores a CANVAS container without pane chrome after a failed return trip', () => {
    let openSearchCalls = 0;
    const { engine, term } = mounted('rel-t2c-canvas', {
      onOpenSearch: () => { openSearchCalls += 1; },
    });
    const host = makeHost();
    expect(engine.relocateTo(host, { paneChrome: false })).toBe('relocated');
    expect((engine as any).paneChromeActive).toBe(false);

    const illegal = document.createElement('div');
    term.element!.appendChild(illegal);
    expect(engine.relocateTo(illegal, { paneChrome: true })).toBe('aborted');

    expect((engine as any).paneChromeActive).toBe(false);
    const focusBefore = term.focusCount;
    host.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
    expect(term.focusCount).toBe(focusBefore);   // no click-to-focus on a canvas host
    expect(openSearchCalls).toBe(0);             // and no Ctrl/Cmd+F
  });

  // §13 T8f / review 096. Without the restore, an abort leaves a <=500ms arm on an
  // engine that never moved, so an unrelated scheduleBackendResize stamps
  // convergenceResizeAt and opens a spurious 1500ms ED3 repair window — exactly the
  // misattribution TerminalEngine.ts:2386-2388 avoids.
  it('restores convergenceArmUntil on abort', () => {
    const { engine, term, entry } = mounted('rel-t8f');
    expect((engine as any).convergenceArmUntil).toBe(0);

    const illegal = document.createElement('div');
    term.element!.appendChild(illegal);
    expect(engine.relocateTo(illegal, { paneChrome: false })).toBe('aborted');

    expect((engine as any).convergenceArmUntil).toBe(0);
    entry.convergenceResizeAt = undefined;
    (engine as any).scheduleBackendResize(100, 30);
    expect(entry.convergenceResizeAt).toBeUndefined();
  });

  // §13 T3, canvas half + T13, relocation half. The four listeners follow the
  // move; on a chromeless host only the two zoom bindings are wired, because
  // 010:376 keeps zoom as "existing behaviour, unchanged" while D16 removes
  // click-to-focus and Ctrl/Cmd+F.
  it('re-wires the container listeners on the new host, gated by paneChrome', () => {
    let openSearchCalls = 0;
    let zoomCalls = 0;
    const { engine, pane, term } = mounted('rel-t3', {
      onOpenSearch: () => { openSearchCalls += 1; },
      onZoom: () => { zoomCalls += 1; },
    });
    const host = makeHost();

    expect(engine.relocateTo(host, { paneChrome: false })).toBe('relocated');
    expect((engine as any).containerDisposables.length).toBe(2);

    // The OLD container is inert.
    const focusAfterMove = term.focusCount;
    pane.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    pane.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
    pane.dispatchEvent(new KeyboardEvent('keydown', { key: '=', ctrlKey: true, bubbles: true }));
    expect(term.focusCount).toBe(focusAfterMove);
    expect(openSearchCalls).toBe(0);
    expect(zoomCalls).toBe(0);

    // The NEW host: zoom in BOTH modes, chrome in neither.
    host.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(term.focusCount).toBe(focusAfterMove);          // D16: no click-to-focus
    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
    expect(openSearchCalls).toBe(0);                       // D16: no Ctrl/Cmd+F
    host.dispatchEvent(new KeyboardEvent('keydown', { key: '=', ctrlKey: true, bubbles: true }));
    expect(zoomCalls).toBe(1);                             // zoom keys: present
    host.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, ctrlKey: true, bubbles: true }));
    expect(zoomCalls).toBe(2);                             // modifier+wheel: present

    // …and the return trip restores full pane chrome.
    expect(engine.relocateTo(pane, { paneChrome: true })).toBe('relocated');
    expect((engine as any).containerDisposables.length).toBe(4);
    pane.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(term.focusCount).toBe(focusAfterMove + 1);
  });

  // §13 T4 / D7. Exactly one disconnect, and the new one observes the new host.
  it('disconnects the previous ResizeObserver exactly once and observes the new host', () => {
    const { engine } = mounted('rel-t4');
    const host = makeHost();
    const disconnectsBefore = CountingResizeObserver.disconnects;
    CountingResizeObserver.observed = [];

    expect(engine.relocateTo(host, { paneChrome: false })).toBe('relocated');

    expect(CountingResizeObserver.disconnects).toBe(disconnectsBefore + 1);
    expect(CountingResizeObserver.observed).toEqual([host]);
    expect((engine as any).resizeObserver).not.toBeNull();
  });

  // The xterm/addon subscriptions are bound to the SURVIVING Terminal and must be
  // untouched — that is the whole point of the D6 split, and it is what keeps
  // boundTerm.onResize (:1101-1120) alive across the operation.
  it('leaves every xterm subscription intact across the move', () => {
    const { engine, term } = mounted('rel-subs');
    const host = makeHost();

    const dataSubs = term.dataCallbacks.length;
    const resizeSubs = term.resizeCallbacks.length;
    const renderSubs = term.renderCallbacks.length;

    expect(engine.relocateTo(host, { paneChrome: false })).toBe('relocated');

    expect(term.dataCallbacks.length).toBe(dataSubs);
    expect(term.resizeCallbacks.length).toBe(resizeSubs);
    expect(term.renderCallbacks.length).toBe(renderSubs);
  });
});
