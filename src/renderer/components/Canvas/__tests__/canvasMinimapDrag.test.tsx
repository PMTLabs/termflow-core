/**
 * @jest-environment jsdom
 *
 * Dragging the minimap's view rectangle — Tam, 2026-08-17: *"the blue rectangle is not
 * draggable"*.
 *
 * The gesture is worth mounting for rather than deriving from source, because what it promises
 * is a relationship between two things only the real component holds at once: the pointer's
 * travel and where the rectangle is drawn. So the assertions below drag, feed the reported pan
 * back through `panBy` exactly as `CanvasMode` does, re-render, and measure the rectangle's own
 * `style.left` — the number the user is actually looking at.
 *
 * Every case here fails silently in the other direction, too:
 *
 *  - a drag that also flies → the flight overwrites the pan a frame at a time and the map fights
 *    the hand holding it;
 *  - a press on the rectangle that no longer flies → click-to-fly disappears under the one
 *    element that covers most of the minimap when you are zoomed out, which is exactly when it
 *    is most useful;
 *  - a drag that never ends → the map follows the pointer with nothing held.
 *
 * Drives `react-dom/client` + `React.act` directly; the repo has no `@testing-library/react`.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { CanvasMinimap, MINIMAP_W, MINIMAP_H } from '../CanvasMinimap';
import { minimapTransform, minimapToWorld, minimapToScreen } from '../orientation';
import { boundsOf } from '../viewportStyles';
import { DRAG_SLOP } from '../canvasGestures';
import { Rect, Viewport, NODE_W, NODE_H, panBy, screenToWorld } from '../canvasGeometry';
import type { CanvasModel } from '../canvasSelectors';

const VW = 1200;
const VH = 800;

/**
 * A workspace far larger than the viewport, and a viewport parked well inside it.
 *
 * Deliberate: the view rect is part of the minimap's BOUNDS, so a viewport that reached past
 * the content would change `k` as it moved and the rectangle would no longer track the cursor
 * exactly. That is real behaviour (see `minimapToScreen`), but it is not what these tests are
 * about, and a harness that let it happen would make the exact assertions below flaky.
 */
const group = (tabId: string, x: number, y: number): CanvasModel['groups'][number] =>
  ({ tabId, title: tabId, rect: { x, y, w: 2400, h: 1800 }, nodeIds: [], anyRunning: false });

const MODEL: CanvasModel = {
  groups: [group('tb-a', 0, 0), group('tb-b', 3600, 2200)],
  nodes: [{
    terminalId: 'tm-1', tabId: 'tb-a', paneId: 'pn-1', title: 'tm-1', shellType: 'pwsh',
    rect: { x: 100, y: 100, w: NODE_W, h: NODE_H }, isRunning: false, hasUnseenOutput: false,
  }],
};

/** World top-left (750, 500); world size 3000x2000 — comfortably inside the 6000x4000 content. */
const VP: Viewport = { x: -300, y: -200, z: 0.4 };

/** The same projection the component derives, from the same helpers. */
const transformFor = (vp: Viewport) => {
  const a = screenToWorld(vp, 0, 0);
  const b = screenToWorld(vp, VW, VH);
  const view: Rect = { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
  return minimapTransform(boundsOf([...MODEL.groups.map((g) => g.rect), view])!, MINIMAP_W, MINIMAP_H);
};

let container: HTMLDivElement;
let root: Root;
let picks: Array<{ x: number; y: number }>;
let pans: Array<[number, number]>;

const render = (vp: Viewport, opts: { pannable?: boolean } = {}) => act(() => {
  root.render(
    <CanvasMinimap
      model={MODEL}
      vp={vp}
      vw={VW}
      vh={VH}
      onPick={(w) => { picks.push(w); }}
      onPan={opts.pannable === false ? undefined : (dx, dy) => { pans.push([dx, dy]); }}
    />,
  );
});

const box = () => container.querySelector<HTMLElement>('.canvas-minimap')!;
const viewRect = () => container.querySelector<HTMLElement>('.canvas-miniview')!;
/** Where the rectangle is DRAWN, in minimap pixels. */
const drawnAt = () => ({
  x: parseFloat(viewRect().style.left),
  y: parseFloat(viewRect().style.top),
});

const fire = (el: HTMLElement, type: string, x: number, y: number) => act(() => {
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
});
const down = (x: number, y: number) => fire(viewRect(), 'pointerdown', x, y);
const downOutside = (x: number, y: number) => fire(box(), 'pointerdown', x, y);
const move = (x: number, y: number) => fire(box(), 'pointermove', x, y);
const up = (x: number, y: number) => fire(box(), 'pointerup', x, y);

/** The total the drag asked the view to move, since `onPan` is called per move. */
const panned = () => pans.reduce(([x, y], [dx, dy]) => [x + dx, y + dy], [0, 0]);

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom ships neither, and a real gesture uses both. The shim carries only what the component
  // reads — `clientX/clientY` (from MouseEvent) and `pointerId`.
  if (!('PointerEvent' in window)) {
    class PointerEventShim extends MouseEvent {
      readonly pointerId: number;
      constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    }
    (window as unknown as Record<string, unknown>).PointerEvent = PointerEventShim;
    (globalThis as unknown as Record<string, unknown>).PointerEvent = PointerEventShim;
  }
  Element.prototype.setPointerCapture = function setPointerCapture() { /* no-op */ };
  Element.prototype.releasePointerCapture = function releasePointerCapture() { /* no-op */ };
});

beforeEach(() => {
  picks = [];
  pans = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  render(VP);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('the view rectangle is draggable', () => {
  it('found the rectangle it is dragging', () => {
    // Or every press below lands on nothing and the whole file passes vacuously.
    expect(viewRect()).not.toBeNull();
    expect(Number.isFinite(drawnAt().x)).toBe(true);
  });

  /**
   * The promise, measured where the user sees it: drag 20 across and 10 down, and the rectangle
   * is drawn 20 across and 10 down. The pan goes through `panBy` first, exactly as `CanvasMode`
   * applies it — so a sign error anywhere between the pointer and the paint fails here.
   */
  it('moves the rectangle exactly as far as the pointer', () => {
    down(500, 500);
    move(520, 510);

    const before = drawnAt();
    const [dx, dy] = panned();
    render(panBy(VP, dx, dy));
    const after = drawnAt();

    expect(Number((after.x - before.x).toFixed(6))).toBe(20);
    expect(Number((after.y - before.y).toFixed(6))).toBe(10);
  });

  it('converts the pointer travel with the shared minimap scale', () => {
    down(500, 500);
    move(530, 500);
    const t = transformFor(VP);
    expect(panned()[0]).toBeCloseTo(minimapToScreen(t, VP.z, 30), 6);
  });

  it('keeps the grab offset — every move pans by its own step', () => {
    // Deltas measured from the LAST position, not from the press. Measuring from the press
    // would re-apply the whole travel on every move and the rectangle would accelerate away.
    down(500, 500);
    move(510, 500);
    move(520, 500);
    move(530, 500);
    const t = transformFor(VP);
    expect(pans).toHaveLength(3);
    for (const [dx, dy] of pans) {
      expect(dx).toBeCloseTo(minimapToScreen(t, VP.z, 10), 6);
      expect(dy).toBeCloseTo(0, 6);
    }
  });

  it('does not also fly there', () => {
    // `onPick` animates over FLY_MS from a viewport captured before the drag began, so a flight
    // running underneath a drag overwrites every pan it makes until the animation ends.
    down(500, 500);
    move(560, 540);
    up(560, 540);
    expect(picks).toHaveLength(0);
    expect(pans.length).toBeGreaterThan(0);
  });

  it('stops when the pointer is released', () => {
    down(500, 500);
    move(520, 500);
    up(520, 500);
    pans.length = 0;
    move(700, 700);
    expect(pans).toEqual([]);
  });

  it('stops when the gesture is cancelled, without flying', () => {
    down(500, 500);
    fire(box(), 'pointercancel', 500, 500);
    move(600, 600);
    expect(pans).toEqual([]);
    // A cancelled pointer is not a click: the gesture was taken away, not completed.
    expect(picks).toHaveLength(0);
  });
});

/**
 * The half that is easy to lose while adding the first half.
 *
 * The rectangle is part of the minimap's own bounds, so at a wide zoom-out it covers nearly the
 * whole box. A drag that swallowed every press on it would take click-to-fly away exactly where
 * the map shows the most to aim at — the same shape as the wire handles shadowing their nodes.
 */
describe('a press on the rectangle that never moves still flies', () => {
  it('flies to the point under the pointer', () => {
    down(420, 300);
    up(420, 300);
    const t = transformFor(VP);
    // jsdom has no layout, so `getBoundingClientRect()` is all zeros and client space IS
    // minimap space here.
    expect(picks).toHaveLength(1);
    expect(picks[0].x).toBeCloseTo(minimapToWorld(t, 420, 300).x, 6);
    expect(picks[0].y).toBeCloseTo(minimapToWorld(t, 420, 300).y, 6);
    expect(pans).toEqual([]);
  });

  it('tolerates the wobble in a real click', () => {
    // Same threshold as a port press, and for the same reason: a pointer is never perfectly
    // still, least of all a trackpad tap.
    down(420, 300);
    move(420 + DRAG_SLOP, 300);
    up(420 + DRAG_SLOP, 300);
    expect(picks).toHaveLength(1);
    expect(pans).toEqual([]);
  });

  it('is a drag once the pointer passes the threshold', () => {
    down(420, 300);
    move(420 + DRAG_SLOP + 1, 300);
    up(420 + DRAG_SLOP + 1, 300);
    expect(picks).toEqual([]);
    expect(pans).toHaveLength(1);
  });
});

describe('a press anywhere else on the minimap', () => {
  it('flies immediately, as it always has', () => {
    downOutside(60, 40);
    expect(picks).toHaveLength(1);
    up(60, 40);
    expect(picks).toHaveLength(1);            // and not twice, via the click fallback
    expect(pans).toEqual([]);
  });

  it('does not start a drag', () => {
    downOutside(60, 40);
    move(200, 200);
    expect(pans).toEqual([]);
  });
});

describe('without an onPan handler', () => {
  it('still flies from a press on the rectangle', () => {
    // The prop is optional, and a component that dropped into the drag branch regardless would
    // leave a press on the rectangle doing nothing at all.
    render(VP, { pannable: false });
    down(420, 300);
    expect(picks).toHaveLength(1);
  });
});
