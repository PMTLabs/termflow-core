/**
 * @jest-environment jsdom
 *
 * The Arrange animation's lifecycle — `plan/013` Task 13.
 *
 * The layout maths is pinned in `animateLayout.test.ts`. What is left here is the part that has
 * no pure form: a requestAnimationFrame loop with three ways to go wrong, none of which shows up
 * as a wrong number.
 *
 *  - it stops short of the target, leaving the workspace on a fractional frame;
 *  - two presses leave two loops interpolating from different starts, which reads as jitter;
 *  - it outlives the canvas tab and dispatches into an unmounted tree.
 *
 * Driven against the REAL `canvasSlice` reducer rather than a dispatch spy alone, so "it ended
 * on the target" is a claim about the resulting state and not just about the last action.
 *
 * `react-dom/client` + `React.act` directly; the repo has no `@testing-library/react`.
 */
import path from 'path';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore, EnhancedStore } from '@reduxjs/toolkit';
import canvasReducer from '../../../store/slices/canvasSlice';
import { useArrange } from '../useArrange';
import { arrangeTarget, ARRANGE_MS } from '../animateLayout';
import { NODE_W, NODE_H, Rect } from '../canvasGeometry';
import type { CanvasModel, CanvasNodeModel, CanvasGroupModel } from '../canvasSelectors';
import { readSource } from '../../../utils/readSource';

const node = (terminalId: string, tabId: string, rect: Rect): CanvasNodeModel => ({
  terminalId, tabId, paneId: `pn-${terminalId}`, title: terminalId, shellType: 'zsh',
  rect, isRunning: false, hasUnseenOutput: false, groupTitle: 'Group', exited: false,
});
const group = (tabId: string, rect: Rect, nodeIds: string[]): CanvasGroupModel =>
  ({ tabId, title: tabId, rect, nodeIds, anyRunning: false });

/**
 * **The start positions are deliberately fractional, and that is load-bearing.**
 *
 * The obvious fixture — round hundreds — is exactly representable in binary, and every lerp form
 * agrees to the last bit on values like those. A whole class of defect (an animation that
 * settles an ULP short of its target) would then be invisible to every test in this file, no
 * matter how precisely they asserted the endpoint.
 *
 * Fractional is also what production actually holds: a dragged node's position is
 * `origin + screenDelta / zoom` (see `worldDelta`), which is a non-terminating binary fraction at
 * every zoom but 1. So these are the realistic values and the round ones were the artificial
 * ones, which is the usual way round for this mistake.
 */
const model: CanvasModel = {
  nodes: [
    node('tm-1', 'tb-a', { x: 1000 / 3, y: 1000 / 7, w: NODE_W, h: NODE_H }),
    node('tm-2', 'tb-a', { x: 1900 / 7, y: 1400 / 3, w: NODE_W, h: NODE_H }),
    node('tm-3', 'tb-b', { x: -700 / 3, y: 2200 / 7, w: NODE_W, h: NODE_H }),
  ],
  groups: [
    group('tb-a', { x: 980 / 3, y: 980 / 7, w: 1300 / 3, h: 700 / 7 }, ['tm-1', 'tm-2']),
    group('tb-b', { x: -720 / 7, y: 2180 / 3, w: 400 / 7, h: 300 / 3 }, ['tm-3']),
  ],
};

// ---- A hand-driven clock and frame queue -----------------------------------------------
//
// The loop reads `performance.now()` once for its start and then trusts the timestamp rAF hands
// it, so both have to be under test control or "did it reach the end" is a race.

let frames: Map<number, (t: number) => void>;
let nextFrameId: number;
let cancelled: number[];
let clock: number;

/** Run every frame currently queued, at time `t`. Callbacks queued BY those callbacks are left
 *  for the next flush, exactly as a real frame boundary would. */
const flush = (t: number) => {
  const due = Array.from(frames.entries());
  frames = new Map();
  act(() => { for (const [, cb] of due) cb(t); });
};

/** Advance until the loop stops queueing, or fail loudly. A loop that never terminates is one of
 *  the failures this file exists to catch, so it must not hang the suite instead. */
const runToCompletion = (start: number, stepMs = 16) => {
  let t = start;
  for (let i = 0; i < 200 && frames.size; i++) {
    t += stepMs;
    flush(t);
  }
  expect(frames.size).toBe(0);
};

let container: HTMLDivElement;
let root: Root;
let store: EnhancedStore;
let arrange: () => void;

const Harness: React.FC<{ model: CanvasModel }> = ({ model: m }) => {
  arrange = useArrange(m);
  return null;
};

const mount = (m: CanvasModel = model) => {
  act(() => {
    root.render(<Provider store={store}><Harness model={m} /></Provider>);
  });
};

/** jsdom implements `matchMedia` but always answers `false`; every test states which world it is
 *  in rather than relying on that. */
const setReducedMotion = (reduce: boolean) => {
  (window as unknown as { matchMedia: (q: string) => { matches: boolean } }).matchMedia =
    (q: string) => ({ matches: reduce && q.includes('prefers-reduced-motion') });
};

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  frames = new Map();
  nextFrameId = 1;
  cancelled = [];
  clock = 5000;

  window.requestAnimationFrame = ((cb: (t: number) => void) => {
    const id = nextFrameId++;
    frames.set(id, cb);
    return id;
  }) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = ((id: number) => {
    cancelled.push(id);
    frames.delete(id);
  }) as typeof window.cancelAnimationFrame;
  jest.spyOn(performance, 'now').mockImplementation(() => clock);

  setReducedMotion(false);

  store = configureStore({ reducer: { canvas: canvasReducer } });
  jest.spyOn(store, 'dispatch');

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  jest.restoreAllMocks();
});

const canvasState = () => (store.getState() as { canvas: { nodes: Record<string, Rect>; groups: Record<string, Rect> } }).canvas;

describe('useArrange — reduced motion', () => {
  // Design 010 §9: fly-to and Arrange must both resolve instantly under it.
  it('applies the target in a single dispatch and never asks for a frame', () => {
    setReducedMotion(true);
    mount();
    act(() => arrange());

    expect(frames.size).toBe(0);
    expect(store.dispatch).toHaveBeenCalledTimes(1);
    const target = arrangeTarget(model);
    expect(canvasState().groups['tb-a']).toEqual(target.groups['tb-a']);
    expect(canvasState().nodes['tm-3']).toEqual({ ...target.nodes['tm-3'], w: NODE_W, h: NODE_H });
  });

  // The query has to be the reduced-motion one specifically. Reading `.matches` off whatever
  // `matchMedia` is handed would make Arrange snap under any media query the environment
  // happens to answer true.
  it('animates when the media query is something else', () => {
    (window as unknown as { matchMedia: (q: string) => { matches: boolean } }).matchMedia =
      (q: string) => ({ matches: !q.includes('prefers-reduced-motion') });
    mount();
    act(() => arrange());
    expect(frames.size).toBe(1);
  });
});

describe('useArrange — the animation', () => {
  it('comes to rest exactly on the target', () => {
    mount();
    act(() => arrange());
    runToCompletion(clock);

    const target = arrangeTarget(model);
    for (const [id, r] of Object.entries(target.groups)) {
      expect(canvasState().groups[id]).toEqual(r);
    }
    for (const [id, p] of Object.entries(target.nodes)) {
      expect(canvasState().nodes[id]).toEqual({ ...p, w: NODE_W, h: NODE_H });
    }
  });

  // Guard the guard for the test above: if the model were already arranged, "ends on the target"
  // would hold for an implementation that did nothing at all. Derived from the model rather than
  // written out, or editing the fixture would silently turn this into a comparison against
  // coordinates nothing is at.
  it('the model under test is genuinely out of position to begin with', () => {
    const target = arrangeTarget(model);
    for (const n of model.nodes) {
      expect(target.nodes[n.terminalId]).not.toEqual({ x: n.rect.x, y: n.rect.y });
    }
  });

  /**
   * It has to ANIMATE, not jump.
   *
   * "Ends on the target" is also true of an implementation that dispatches the target once and
   * skips every frame in between, so the intermediate states are asserted separately: a frame
   * part-way through must be at neither end.
   */
  it('passes through positions that are neither the start nor the target', () => {
    mount();
    act(() => arrange());

    flush(clock + ARRANGE_MS * 0.4);
    const start = model.nodes.find((n) => n.terminalId === 'tm-3')!.rect;
    const mid = canvasState().nodes['tm-3'];
    expect(mid).not.toEqual({ x: start.x, y: start.y, w: NODE_W, h: NODE_H });
    expect(mid).not.toEqual({ ...arrangeTarget(model).nodes['tm-3'], w: NODE_W, h: NODE_H });

    runToCompletion(clock + ARRANGE_MS * 0.4);
    expect((store.dispatch as jest.Mock).mock.calls.length).toBeGreaterThan(2);
  });

  // A frame that arrives late — a stalled tab, a long GC — must finish the animation, not
  // extrapolate past the target. `Math.min(1, ...)` is what does it, and without the clamp the
  // eased value would overshoot and the loop would never see `k >= 1`.
  it('finishes on the target when the clock jumps far past the duration', () => {
    mount();
    act(() => arrange());
    flush(clock + ARRANGE_MS * 40);

    expect(frames.size).toBe(0);
    const target = arrangeTarget(model);
    expect(canvasState().nodes['tm-1']).toEqual({ ...target.nodes['tm-1'], w: NODE_W, h: NODE_H });
  });

  it('stops queueing frames once it has arrived', () => {
    mount();
    act(() => arrange());
    runToCompletion(clock);
    const after = (store.dispatch as jest.Mock).mock.calls.length;
    flush(clock + ARRANGE_MS * 10);
    expect((store.dispatch as jest.Mock).mock.calls.length).toBe(after);
  });
});

describe('useArrange — two presses', () => {
  it('cancels the first loop rather than running both', () => {
    mount();
    act(() => arrange());
    const firstId = Array.from(frames.keys())[0];

    flush(clock + ARRANGE_MS * 0.3);
    const pendingAfterFirstFrame = Array.from(frames.keys())[0];

    act(() => arrange());
    expect(cancelled).toContain(pendingAfterFirstFrame);
    // Exactly one loop is live, not two.
    expect(frames.size).toBe(1);
    expect(Array.from(frames.keys())[0]).not.toBe(firstId);
  });

  it('still comes to rest exactly on the target', () => {
    mount();
    act(() => arrange());
    flush(clock + ARRANGE_MS * 0.3);

    clock += ARRANGE_MS * 0.3;
    act(() => arrange());
    runToCompletion(clock);

    const target = arrangeTarget(model);
    expect(canvasState().nodes['tm-2']).toEqual({ ...target.nodes['tm-2'], w: NODE_W, h: NODE_H });
  });
});

describe('useArrange — unmount', () => {
  it('cancels an in-flight loop and dispatches nothing more', () => {
    mount();
    act(() => arrange());
    flush(clock + ARRANGE_MS * 0.2);
    const pending = Array.from(frames.keys())[0];
    const before = (store.dispatch as jest.Mock).mock.calls.length;

    act(() => root.unmount());
    expect(cancelled).toContain(pending);
    expect(frames.size).toBe(0);

    flush(clock + ARRANGE_MS);
    expect((store.dispatch as jest.Mock).mock.calls.length).toBe(before);

    // The afterEach unmount would otherwise run against an already-unmounted root.
    root = createRoot(container);
  });
});

/**
 * The button itself, derived from source — `CanvasMode` cannot be mounted under the root Jest
 * config, and each of these is a placement decision that would look fine in a diff and be wrong
 * on screen.
 */
describe('Arrange button wiring', () => {
  const src = (f: string) => readSource(path.resolve(__dirname, f));
  const MODE = src('../CanvasMode.tsx');
  const CSS = src('../Canvas.css');

  it('is screen space, not world space', () => {
    // Anything passed to `CanvasViewport` as a child is rendered inside `.canvas-world`, which is
    // pan/zoom transformed — the toolbar would slide off the screen on the first pan. Asserted as
    // source ORDER rather than by matching a string, so it survives the JSX being reformatted.
    //
    // Matched on the `className` attribute, not on the bare class name: `CanvasMode` now names
    // `.canvas-toolbar` in a comment ABOVE this point (explaining why Task 23's chrome went into
    // the viewport's own slot instead), and a bare `indexOf` finds the prose first. That made
    // this fail while the placement it polices was still correct.
    const closeViewport = MODE.indexOf('</CanvasViewport>');
    const toolbar = MODE.indexOf('className="canvas-toolbar"');
    expect(closeViewport).toBeGreaterThan(-1);
    expect(toolbar).toBeGreaterThan(closeViewport);
  });

  it('hides while a node is overlaid', () => {
    // The overlay backdrop is in world space and this is not, so the button paints over it —
    // becoming the one place a click fails to dismiss the overlay.
    expect(MODE).toContain('{!overlayId && model.groups.length > 0 && (');
  });

  it('calls the hook, rather than a second copy of the animation', () => {
    // `edges` as well as `model` since the seventh round: the wires decide the ORDER Arrange
    // fills its slots in (`optimiseArrangeOrder`). Passing only the model compiles and runs, and
    // silently gives back the un-optimised grid.
    expect(MODE).toContain('useArrange(model, edges)');
    expect(MODE).toContain('onClick={arrange}');
    expect(MODE).not.toContain('requestAnimationFrame(step');
  });

  /**
   * ...and the hook has to forward them, which is a separate failure from not being given them.
   *
   * A mutant dropping the second argument here survived a whole mutation pass: everything about
   * the optimiser stayed green, `CanvasMode` still passed its edges in, and Arrange quietly laid
   * out the un-optimised grid. Both halves of the handoff need their own assertion.
   */
  it('forwards those edges into the layout target', () => {
    const HOOK = readSource(path.resolve(__dirname, '../useArrange.ts'));
    expect(HOOK).toContain('arrangeTarget(latest.current, latestEdges.current)');
    // Through a ref like the model, so the callback keeps the stable identity the toolbar needs.
    expect(HOOK).toContain('latestEdges.current = edges;');
  });

  it('has styles to render with', () => {
    // A class that exists only in the JSX is an unstyled button in the top-left corner.
    expect(CSS).toMatch(/^\.canvas-toolbar\s*\{/m);
    expect(CSS).toMatch(/^\.canvas-tbtn\s*\{/m);
    expect(CSS).toContain('.canvas-tbtn:focus-visible');
  });
});

describe('useArrange — identity', () => {
  // The model object changes on every dispatch in the app, including the ~26 this animation
  // makes. A callback that changed with it would re-render the toolbar on each of its own frames.
  it('is stable across model changes', () => {
    mount();
    const first = arrange;
    mount({ ...model, nodes: [...model.nodes] });
    expect(arrange).toBe(first);
  });

  it('arranges the model as of the press, not the one it was created with', () => {
    mount({ nodes: [], groups: [] });
    mount();
    act(() => arrange());
    runToCompletion(clock);
    expect(Object.keys(canvasState().nodes).sort()).toEqual(['tm-1', 'tm-2', 'tm-3']);
  });
});
