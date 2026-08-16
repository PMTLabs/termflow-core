/**
 * @jest-environment jsdom
 *
 * design/012 §4.2.1 + §4.2.2 — §13 T15, T18, T19, T20, T21, T23.
 *
 * These drive the REAL hook with a fake engine. They cannot mount the real
 * TerminalDisplay: it imports two stylesheets (root Jest has no CSS transform),
 * @tauri-apps/api/event, the Redux store and getWindowsBuildNumber, and its engine
 * effect calls mount() -> real Terminal.open(), which needs a canvas 2D context
 * jsdom does not provide. That is why §4.2.2's effect is extracted into this hook
 * (plan ground-truth correction G4) — the hook IS the code under test.
 *
 * The harness reproduces TerminalDisplay's ENGINE effect (the passive one that
 * creates the engine, bumps the generation and relocates home in its cleanup)
 * because that effect stays in the component. Task 13 adds a source tripwire over
 * TerminalDisplay.tsx so the real one cannot drift from this shape.
 */
import React, { act, useEffect, useRef } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { useSurfaceRelocation, type RelocatableEngine } from '../useSurfaceRelocation';
import {
  setSurfaceHost,
  clearSurfaceHost,
  __resetSurfaceHostsForTest,
} from '../../../services/surfaceHosts';

type Call =
  | { kind: 'relocate'; engine: string; target: HTMLElement; paneChrome: boolean; connected: boolean }
  | { kind: 'unmount'; engine: string };

let calls: Call[] = [];

/** A fake engine that performs the same DOM move the real one does, so residence
 *  assertions mean something. `abort` makes relocateTo fail without moving. */
class FakeEngine implements RelocatableEngine {
  element = document.createElement('div');
  container: HTMLElement | null = null;
  abort = false;
  constructor(public name: string) {
    this.element.className = 'xterm';
  }
  relocateTo(container: HTMLElement, opts?: { paneChrome?: boolean }): 'relocated' | 'aborted' {
    calls.push({
      kind: 'relocate',
      engine: this.name,
      target: container,
      paneChrome: opts?.paneChrome ?? false,
      connected: container.isConnected,
    });
    if (this.abort) return 'aborted';
    if (container === this.container) return 'relocated';   // the R0 identity no-op
    container.appendChild(this.element);
    this.container = container;
    return 'relocated';
  }
  unmount(): void {
    calls.push({ kind: 'unmount', engine: this.name });
  }
}

const engines = new Map<string, FakeEngine>();
function engineFor(terminalId: string): FakeEngine {
  const existing = engines.get(terminalId);
  if (existing) return existing;
  const created = new FakeEngine(terminalId);
  engines.set(terminalId, created);
  return created;
}

interface HarnessProps {
  terminalId: string;
  /** Set to drop the pane ref before teardown — models React nulling an object ref
   *  during the deletion traversal (099 T1-F3). */
  nullPaneRefBeforeTeardown?: boolean;
  onAborted?: () => void;
  onRelocated?: (toCanvas: boolean) => void;
}

/** Reproduces TerminalDisplay's structure: the pane div, the engine effect, and
 *  the relocation hook. */
function Harness({
  terminalId,
  nullPaneRefBeforeTeardown,
  onAborted,
  onRelocated,
}: HarnessProps) {
  const paneRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<FakeEngine | null>(null);
  lastEngineRef = engineRef;

  const { engineMounted } = useSurfaceRelocation({
    terminalId,
    engineRef,
    paneRef,
    onRelocated: onRelocated ?? (() => {}),
    onAborted: onAborted ?? (() => {}),
  });

  // TerminalDisplay.tsx:178-328's engine effect, in the shape Task 13 gives it.
  useEffect(() => {
    const pane = paneRef.current;      // CAPTURED — 099 T1-F3
    if (!pane) return;
    const engine = engineFor(terminalId);
    engineRef.current = engine;
    // Stands in for engine.mount(pane). Mirrors mount()'s two DOM steps in order:
    // evict any OTHER engine's surface from this container (detachForeignSurfaces,
    // review 103 F2), then attach ours.
    //
    // …and its BOOLEAN, which the real mount() returns (rev 16, test audit `150` H2).
    // The refusal branch in TerminalDisplay.tsx was pinned only by a substring
    // tripwire asserting the `if` statement's opening line existed — it asserted
    // nothing about the body, so emptying the block, or dropping
    // `engineRef.current = null`, stayed green while production fell straight through
    // to attach() on a refused mount.
    if (refuseNextMount) {
      refuseNextMount = false;
      console.warn('TerminalDisplay: engine.mount refused; skipping attach/hydration');
      engineRef.current = null;
      return () => {};
    }
    for (const other of engines.values()) {
      if (other !== engine && other.element.parentElement === pane) other.element.remove();
    }
    pane.appendChild(engine.element);
    engine.container = pane;
    postMountRuns += 1;
    engineMounted();                   // ADDED — the relocation dep (§4.2.1)
    return () => {
      if (nullPaneRefBeforeTeardown) {
        (paneRef as { current: HTMLDivElement | null }).current = null;
      }
      engine.relocateTo(pane, { paneChrome: true });   // the ORDERED FALLBACK
      engine.unmount();
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId]);

  return (
    <div className="terminal-display-wrapper">
      <div ref={paneRef} className="terminal-display" data-terminal-id={terminalId} />
    </div>
  );
}

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  calls = [];
  engines.clear();
  __resetSurfaceHostsForTest();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  container.remove();
  document.body.innerHTML = '';
  __resetSurfaceHostsForTest();
});

/** A canvas host div, mounted outside the harness so it can be torn down
 *  independently. */
function makeCanvasHost(): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-display-wrapper canvas-surface';
  const host = document.createElement('div');
  host.className = 'terminal-display';
  wrapper.appendChild(host);
  document.body.appendChild(wrapper);
  return host;
}

/** Set by the refusal test: makes the next stand-in mount() report refusal. */
let refuseNextMount = false;
/** The Harness's engineRef, exposed so the refusal test can read it after render. */
let lastEngineRef: { current: FakeEngine | null } = { current: null };
/** Counts how often the post-mount path ran — must stay 0 on a refusal. */
let postMountRuns = 0;

describe('design/012 §4.2 — the relocation effect', () => {
  // §13 T15. No registered host => the effect relocates to the PANE, which the
  // engine's own R0 identity no-op makes free.
  it('targets the pane when no host is registered', () => {
    act(() => { root.render(<Harness terminalId="tb-15" />); });

    const relocations = calls.filter((c) => c.kind === 'relocate');
    expect(relocations.length).toBeGreaterThan(0);
    for (const c of relocations) {
      if (c.kind !== 'relocate') continue;
      expect(c.paneChrome).toBe(true);
      expect(c.target).toBe(container.querySelector('.terminal-display'));
    }
    act(() => { root.unmount(); });
  });

  // §13 T19 / H12 — spike 004 Q1's V1 failure, as a regression test. The host is
  // registered BEFORE the harness mounts, so nothing about `host` ever changes.
  // Fails against a `[host]`-only dep list: the layout effect fires before the
  // passive engine effect, sees a null ref, and never re-runs.
  it('honours a host that was already registered when the component mounted', () => {
    const host = makeCanvasHost();
    setSurfaceHost('tb-19', host);

    act(() => { root.render(<Harness terminalId="tb-19" />); });

    const engine = engines.get('tb-19')!;
    expect(host.contains(engine.element)).toBe(true);
    expect(engine.container).toBe(host);
    act(() => { root.unmount(); });
  });

  it('relocates when a host is registered AFTER mount, and back when it is cleared', () => {
    act(() => { root.render(<Harness terminalId="tb-late" />); });
    const engine = engines.get('tb-late')!;
    const pane = container.querySelector('.terminal-display') as HTMLElement;
    expect(pane.contains(engine.element)).toBe(true);

    const host = makeCanvasHost();
    act(() => { setSurfaceHost('tb-late', host); });
    expect(host.contains(engine.element)).toBe(true);

    act(() => { clearSurfaceHost('tb-late', host); });
    expect(pane.contains(engine.element)).toBe(true);
    act(() => { root.unmount(); });
  });

  // §13 T18 / §5.1's recovery contract. An 'aborted' return raises the host's
  // error affordance and leaves the surface-host REGISTRATION untouched — the
  // canvas node shows an empty box while the terminal stays usable in its pane.
  it('reports an abort and leaves the host registration alone', () => {
    const host = makeCanvasHost();
    const aborts: number[] = [];
    const relocated: boolean[] = [];

    act(() => {
      root.render(
        <Harness
          terminalId="tb-18"
          onAborted={() => aborts.push(1)}
          onRelocated={(toCanvas) => relocated.push(toCanvas)}
        />,
      );
    });
    const engine = engines.get('tb-18')!;
    relocated.length = 0;

    engine.abort = true;
    act(() => { setSurfaceHost('tb-18', host); });

    expect(aborts.length).toBe(1);
    expect(relocated).toEqual([]);          // onRelocated must NOT fire on an abort
    expect(host.contains(engine.element)).toBe(false);
    act(() => { root.unmount(); });
  });

  it('tells the host which direction a successful relocation went', () => {
    const host = makeCanvasHost();
    const relocated: boolean[] = [];
    act(() => {
      root.render(
        <Harness terminalId="tb-dir" onRelocated={(toCanvas) => relocated.push(toCanvas)} />,
      );
    });
    relocated.length = 0;

    act(() => { setSurfaceHost('tb-dir', host); });
    expect(relocated).toEqual([true]);

    act(() => { clearSurfaceHost('tb-dir', host); });
    expect(relocated).toEqual([true, false]);
    act(() => { root.unmount(); });
  });
});

describe('design/012 §4.2.2 — the teardown orderings (H11)', () => {
  // §13 T20, interleaving 1: the canvas host unmounts while the pane stays. The
  // LAYOUT cleanup runs in the same commit and appendChilds the element back into
  // the live pane node. appendChild moves a node out of an already-detached parent
  // just as well as an attached one, so correctness does not depend on whether
  // React has already removed the host div — only on the cleanup running in the
  // same synchronous flush, which a layout cleanup does.
  it('canvas host unmounts, pane stays: the element comes home CONNECTED', () => {
    const host = makeCanvasHost();
    act(() => { root.render(<Harness terminalId="tb-20a" />); });
    const engine = engines.get('tb-20a')!;
    const pane = container.querySelector('.terminal-display') as HTMLElement;

    act(() => { setSurfaceHost('tb-20a', host); });
    expect(host.contains(engine.element)).toBe(true);

    act(() => {
      clearSurfaceHost('tb-20a', host);
      host.parentElement!.remove();          // the node really leaves the document
    });

    expect(pane.contains(engine.element)).toBe(true);
    expect(engine.element.isConnected).toBe(true);
    act(() => { root.unmount(); });
  });

  // §13 T21(a) — the PRIMARY cover. TerminalDisplay unmounting while displayed on
  // canvas must return the surface to a CONNECTED pane node BEFORE engine.unmount()
  // runs. Without it, unmount() leaves the element in the canvas host — it disposes
  // every subscription, removes the rail layer and nulls this.container, but it
  // NEVER removes term.element from the DOM (TerminalEngine.ts:3218-3276) — still
  // painting live output and dead to input, with nothing to reclaim it.
  it('unmounting while on canvas relocates home BEFORE unmount(), to a connected node', () => {
    const host = makeCanvasHost();
    act(() => { root.render(<Harness terminalId="tb-21a" />); });
    act(() => { setSurfaceHost('tb-21a', host); });
    const engine = engines.get('tb-21a')!;
    const pane = container.querySelector('.terminal-display') as HTMLElement;
    calls = [];

    act(() => { root.unmount(); });

    const firstRelocate = calls.find((c) => c.kind === 'relocate');
    const unmountAt = calls.findIndex((c) => c.kind === 'unmount');
    const firstRelocateAt = calls.findIndex((c) => c.kind === 'relocate');
    expect(firstRelocate).toBeDefined();
    expect(firstRelocateAt).toBeLessThan(unmountAt);
    if (firstRelocate && firstRelocate.kind === 'relocate') {
      expect(firstRelocate.target).toBe(pane);
      expect(firstRelocate.connected).toBe(true);   // the PRIMARY cover keeps it connected
      expect(firstRelocate.paneChrome).toBe(true);
    }
    expect(pane.contains(engine.element)).toBe(true);
  });

  // §13 T21(b) / 099 T1-F3 — the ordered FALLBACK, and the exact defect rev 5
  // shipped. On a whole-component deletion React detaches host refs
  // (ref.current = null) during the deletion traversal, BEFORE passive deletion
  // cleanup. Rev 5's cleanup read `terminalRef.current` and its
  // `if (terminalRef.current)` guard was therefore FALSE — the second cover
  // relocated nothing. Capturing `pane` in the effect body is what makes it real.
  it('the engine-effect cleanup uses the CAPTURED pane, not the ref React has nulled', () => {
    act(() => { root.render(<Harness terminalId="tb-21b" nullPaneRefBeforeTeardown />); });
    const pane = container.querySelector('.terminal-display') as HTMLElement;
    calls = [];

    act(() => { root.unmount(); });

    // The engine effect's cleanup still relocated, and to the CAPTURED element.
    const relocations = calls.filter((c) => c.kind === 'relocate');
    expect(relocations.length).toBeGreaterThan(0);
    expect(relocations.every((c) => c.kind === 'relocate' && c.target === pane)).toBe(true);
    const unmountAt = calls.findIndex((c) => c.kind === 'unmount');
    expect(calls.findIndex((c) => c.kind === 'relocate')).toBeLessThan(unmountAt);
  });

  // §13 T20, interleaving 3: both unmount in one commit. The element ends detached
  // in the old pane div — EXACTLY where today's every remount already leaves it,
  // and where mount()'s reattach branch (:748) picks it up. No new state.
  it('both unmount in one commit: the element ends where a remount already leaves it', () => {
    const host = makeCanvasHost();
    act(() => { root.render(<Harness terminalId="tb-20c" />); });
    act(() => { setSurfaceHost('tb-20c', host); });
    const engine = engines.get('tb-20c')!;
    const pane = container.querySelector('.terminal-display') as HTMLElement;

    act(() => {
      root.unmount();
      clearSurfaceHost('tb-20c', host);
      host.parentElement!.remove();
    });

    expect(pane.contains(engine.element)).toBe(true);
    expect(host.contains(engine.element)).toBe(false);
  });
});

describe('design/012 §4.2.2 — cleanup identity (H13)', () => {
  // §13 T23 / review 098 A1. TerminalDisplay is rendered WITHOUT a key
  // (TerminalPane.tsx:713-…) and TerminalPane's reuse path lets terminalId change
  // on the SAME component instance without an unmount (TerminalPane.tsx:174-201).
  // So a cleanup registered by generation G can run in a commit where
  // engineRef.current is a DIFFERENT engine. Capturing `engine` fixes the
  // wrong-target half; the `engineRef.current === engine` guard fixes the other —
  // without it the captured OLD engine (already unmounted, but still holding a live
  // term) would appendChild its element into the pane div the SUCCESSOR has already
  // mounted into, putting two xterm elements in one host.
  it('a cleanup registered against engine A does nothing once B is the live engine', () => {
    act(() => { root.render(<Harness terminalId="tb-A" />); });
    const a = engines.get('tb-A')!;
    calls = [];

    // The reuse path: terminalId changes IN PLACE, no remount.
    act(() => { root.render(<Harness terminalId="tb-B" />); });
    const b = engines.get('tb-B')!;
    const pane = container.querySelector('.terminal-display') as HTMLElement;

    // B owns the pane, B's element is the last thing appended to it, and it is the
    // ONLY surface there.
    //
    // HISTORY (015 Task 12). An earlier revision of this comment said the plan's
    // "exactly one `.xterm`, A's element gone" assertion was unreachable "in this
    // harness or in the real component", because `unmount()` never removes
    // `term.element` and `mount()` was append-only on both paths. That was an
    // accurate reading of the code and the wrong conclusion to draw from it: it
    // recorded a real defect as a fixed property of the world. External review 103
    // finding 2 pushed back, and `mount()` now evicts a foreign surface before
    // attaching its own (`detachForeignSurfaces`), so the plan's assertion is
    // reachable after all — restored below.
    //
    // The engines here are fakes, so what this pins is the CLEANUP GUARD; the DOM
    // hygiene itself is pinned against the real `mount()` in terminal-core's
    // engine.mount-foreign-surface.test.ts.
    expect(b.container).toBe(pane);
    expect(pane.contains(b.element)).toBe(true);
    expect(pane.lastElementChild).toBe(b.element);
    expect(pane.querySelectorAll('.xterm')).toHaveLength(1);
    expect(pane.contains(a.element)).toBe(false);

    // A's relocations all happened while A was still the live engine (its own
    // engine-effect cleanup, which runs BEFORE B is created). Nothing relocated A
    // after B took over.
    const aRelocationsAfterB = calls
      .slice(calls.findIndex((c) => c.kind === 'unmount' && c.engine === 'tb-A') + 1)
      .filter((c) => c.kind === 'relocate' && c.engine === 'tb-A');
    expect(aRelocationsAfterB).toEqual([]);
    act(() => { root.unmount(); });
  });
});

/**
 * rev 16 (test audit `150` H2) — the RENDERER half of the REFUSAL contract.
 *
 * `TerminalDisplay.tsx`'s refusal branch was covered only by a source-substring
 * tripwire in terminalDisplayRelocationWiring.test.ts, which asserts that the line
 * `if (!engine.mount(pane)) {` exists. It says nothing about the body: emptying the
 * block, or dropping `engineRef.current = null`, left it green while production fell
 * through to engineMounted()/attach() on a mount that wired nothing — the exact crash
 * the guard was added to prevent. A grep for `refus` across src/renderer hits only
 * TerminalDisplay.tsx itself, so nothing behavioural covered it.
 */
describe('a refused mount leaves the renderer with no engine (rev 16)', () => {
  it('nulls engineRef and never runs the post-mount path', () => {
    refuseNextMount = true;
    postMountRuns = 0;
    act(() => { root.render(<Harness terminalId="refused-1" />); });

    // The engine must NOT be left dangling for a later consumer to read
    // `engineRef.current!.terminal` from — that getter throws before a successful
    // mount ("terminal accessed before mount()").
    expect(lastEngineRef.current).toBeNull();
    // …and nothing downstream of the mount ran.
    expect(postMountRuns).toBe(0);
    act(() => { root.unmount(); });
    refuseNextMount = false;
  });
});
