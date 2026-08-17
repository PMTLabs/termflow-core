/**
 * Orientation maths for Canvas Mode — `plan/013` Task 23, design 010 D9, §5.1 and §10.
 *
 * Three separate answers to "where am I, and where is the thing I cannot see":
 *
 *  - `nearestGroupToCentre` — which group you are looking at, for the tab strip's marker.
 *  - `minimapTransform` and friends — the whole workspace shrunk into a corner box.
 *  - `beaconFor` / `beaconLayout` — edge markers for running terminals that are off screen.
 *
 * Pure, like `canvasGeometry` and `canvasLayout`: no React and no DOM, so all of it is
 * unit-testable. The components that use it own only the wiring.
 */

import {
  Rect, Viewport, isVisible, screenToWorld, worldToScreen,
} from './canvasGeometry';
import type { CanvasGroupModel, CanvasNodeModel } from './canvasSelectors';

/* ---- Which group am I in? (D9) ------------------------------------------- */

/**
 * The group nearest the viewport CENTRE, in world space.
 *
 * `screenToWorld` is the whole function. Comparing group centres against the raw screen centre
 * `(vw/2, vh/2)` answers a different question — "which group is nearest the world origin" — and
 * the two agree exactly until the user pans, which is the only time anyone looks at the marker.
 */
export function nearestGroupToCentre(
  groups: CanvasGroupModel[], vp: Viewport, vw: number, vh: number,
): string | null {
  if (!groups.length) return null;
  const c = screenToWorld(vp, vw / 2, vh / 2);
  let best: string | null = null;
  let bestD = Infinity;
  for (const g of groups) {
    const dx = (g.rect.x + g.rect.w / 2) - c.x;
    const dy = (g.rect.y + g.rect.h / 2) - c.y;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = g.tabId; }
  }
  return best;
}

/* ---- Minimap ------------------------------------------------------------- */

/** How much of the minimap box the workspace fills, leaving a margin so edge nodes are not
 *  flush against the border. */
export const MINIMAP_FILL = 0.88;

/**
 * World → minimap mapping.
 *
 * **`bounds` is carried deliberately.** `ox`/`oy` are a CENTRING offset for a box of size
 * `w x h` sitting at the origin — they do not contain the world origin itself. A caller
 * computing `wx * k + ox` is correct for exactly one workspace: the one that starts at 0,0,
 * which is every workspace a test builds by hand and almost no real one. Keeping `bounds` here
 * lets `minimapPoint` own the subtraction, so no call site can skip it.
 */
export interface MinimapTransform {
  k: number;
  ox: number;
  oy: number;
  bounds: Rect;
}

export function minimapTransform(bounds: Rect, mw: number, mh: number): MinimapTransform {
  const w = Math.max(1, bounds.w);
  const h = Math.max(1, bounds.h);
  // Capped at 1: a minimap never MAGNIFIES. Without the ceiling a workspace smaller than the
  // box — including the degenerate empty one the floors above produce — gets a `k` in the tens,
  // and the viewport rectangle drawn through it swamps the whole minimap.
  const k = Math.min(1, Math.min(mw / w, mh / h) * MINIMAP_FILL);
  return { k, ox: (mw - w * k) / 2, oy: (mh - h * k) / 2, bounds };
}

export function minimapPoint(t: MinimapTransform, wx: number, wy: number): { x: number; y: number } {
  return { x: (wx - t.bounds.x) * t.k + t.ox, y: (wy - t.bounds.y) * t.k + t.oy };
}

/** The inverse. Clicking the minimap has to name the world point drawn under the cursor, or
 *  the fly-to lands somewhere other than where the user aimed. */
export function minimapToWorld(t: MinimapTransform, mx: number, my: number): { x: number; y: number } {
  return { x: (mx - t.ox) / t.k + t.bounds.x, y: (my - t.oy) / t.k + t.bounds.y };
}

/**
 * How far one arrow press moves the view when the MINIMAP has the keyboard, in minimap pixels
 * (Tam's item 3).
 *
 * The unit is the point. A step measured on the minimap is constant relative to the WHOLE
 * WORKSPACE — ~17 presses cross it end to end however far you are zoomed in — where the canvas's
 * own arrows move a constant number of SCREEN pixels (`PAN_STEP_PX`). That is what makes these
 * two different scales rather than one number copied twice: at any working zoom a minimap press
 * covers far more ground, and it keeps covering the same fraction of the workspace as the
 * workspace grows.
 */
export const MINIMAP_PAN_STEP = 10;

/**
 * A distance measured on the MINIMAP, as the SCREEN-space distance `panBy` takes.
 *
 * `t.k` is minimap-px per world-unit, so dividing by it converts back to world units, and `z`
 * takes those to the screen. Derived from the live transform rather than fixed, so the stride
 * grows with the workspace — the same reason the minimap's own scale is not fixed either.
 *
 * **Both of the minimap's pan gestures go through here**, and that is the point of the function
 * existing rather than the arithmetic sitting inline in `minimapPanStep`: an arrow press and a
 * drag of the view rectangle are the same conversion applied to different distances, and a drag
 * that used its own copy could disagree with the arrows about which way the view moves — the one
 * mistake in a pan control that looks like a working feature.
 */
export function minimapToScreen(t: MinimapTransform, z: number, dMinimap: number): number {
  return (dMinimap / t.k) * z;
}

/**
 * One arrow press, as that same SCREEN-space distance.
 *
 * **Where it stops leading, stated rather than left to be found.** This stride is constant in
 * WORLD units while the canvas's is constant in SCREEN pixels, so the canvas's grows without
 * bound in world terms as you zoom out and the two cross somewhere. That crossing lands below
 * `GROUP_CHIP_ZOOM` — the zoom clicking a collapsed group flies you to — so at every zoom you
 * actually work at the minimap is the coarser control, and below it you are looking at the whole
 * workspace anyway. `orientation.test.ts` pins the crossing rather than trusting that sentence.
 */
export function minimapPanStep(t: MinimapTransform, z: number): number {
  return minimapToScreen(t, z, MINIMAP_PAN_STEP);
}

/** A world rect as a minimap box. Positioned through `minimapPoint` and scaled by the same `k`,
 *  so a group frame and the nodes inside it cannot drift apart. */
export function minimapRect(t: MinimapTransform, r: Rect): Rect {
  const p = minimapPoint(t, r.x, r.y);
  return { x: p.x, y: p.y, w: r.w * t.k, h: r.h * t.k };
}

/**
 * The next terminal in reading order — <kbd>Tab</kbd> / <kbd>Shift</kbd>+<kbd>Tab</kbd>.
 *
 * `ids` is `model.nodes` in its natural order, which is tab order and then pane order inside
 * each tab. That is not an arbitrary choice made here: it is the SAME order the sidebar lists,
 * because the sidebar is built from the same array. Sorting by position instead — left to right,
 * say — would give the keyboard one order and the list another, and neither would be wrong
 * enough to notice until you tried to follow one with the other.
 *
 * Wraps, because a list you can fall off the end of makes the last press do nothing and look
 * broken. Starting from no selection enters at the end you are heading towards, so the first
 * Shift+Tab picks the LAST terminal rather than jumping to the first and going backwards.
 */
export function stepNodeId(
  ids: readonly string[],
  current: string | null,
  dir: 1 | -1,
): string | null {
  if (!ids.length) return null;
  const at = current ? ids.indexOf(current) : -1;
  // Also covers a selection that has been closed since — `indexOf` returns -1 and this enters
  // from the near end rather than throwing the step away.
  if (at < 0) return dir > 0 ? ids[0] : ids[ids.length - 1];
  return ids[(at + dir + ids.length) % ids.length];
}

/* ---- Beacons ------------------------------------------------------------- */

/**
 * The marker's diameter, and how far inside the viewport edge its CENTRE sits.
 *
 * The two are related, not independent: the beacon is centred on the clamped point, so it
 * overhangs by `BEACON_SIZE / 2` and the inset has to cover that or a marker pinned to an edge
 * is drawn half outside the viewport — clipped on one side, and with half its click target gone.
 * `orientation.test.ts` asserts the relation rather than trusting these two numbers to be
 * changed together.
 *
 * Exported so `CanvasBeacons` sizes the element from THIS constant instead of a copy in the
 * stylesheet; a stylesheet copy is a size the geometry here would not know about.
 */
export const BEACON_SIZE = 22;
export const BEACON_INSET = 12;

/**
 * Where to pin an edge marker for a node outside the viewport; `null` if it is on screen.
 *
 * **`isVisible` is the whole point of this function.** The canvas answers "is this on screen?"
 * in exactly one place — `isVisible` and its shared `CULL_MARGIN` — and `visibleNodeIds`' doc
 * comment names this task as one of the three consumers that have to agree. A centre-point test
 * (`0 <= cx <= vw`) is a fourth answer, and it disagrees visibly: a node whose centre has left
 * the viewport but whose body is still inside the cull margin PAINTS, and would also get an
 * edge beacon pointing at a node the user can already see.
 */
export function beaconFor(
  vp: Viewport, r: Rect, vw: number, vh: number,
): { x: number; y: number } | null {
  if (isVisible(vp, r, vw, vh)) return null;
  const c = worldToScreen(vp, r.x + r.w / 2, r.y + r.h / 2);
  return {
    x: Math.max(BEACON_INSET, Math.min(vw - BEACON_INSET, c.x)),
    y: Math.max(BEACON_INSET, Math.min(vh - BEACON_INSET, c.y)),
  };
}

export interface Beacon {
  terminalId: string;
  title: string;
  x: number;
  y: number;
  /** How many off-screen running nodes this marker stands for — 1 unless several clamped to
   *  the same spot. Reported rather than dropped: see `beaconLayout`. */
  count: number;
}

/** Beacons closer together than this are the same marker. Sized so two markers never overlap,
 *  since an overlapped one is unclickable rather than merely untidy. */
export const BEACON_BUCKET = 26;

/**
 * Edge markers for the running terminals you cannot see (design §10).
 *
 * **Co-located beacons collapse.** `isRunning` is a TAB-level fact — see `CanvasNodeModel`, where
 * every node in a running tab inherits it — so a four-pane tab panned off one edge produces four
 * beacons that clamp to within a few pixels of each other, three of them permanently covered and
 * unclickable. The survivor carries a `count` rather than the others being discarded silently: a
 * single marker standing for four terminals, with nothing saying so, is a cap pretending to be a
 * result.
 *
 * Model order decides the survivor, so the set is stable across renders and does not reshuffle
 * as the user pans.
 */
export function beaconLayout(
  nodes: CanvasNodeModel[], vp: Viewport, vw: number, vh: number,
): Beacon[] {
  const out: Beacon[] = [];
  const byBucket = new Map<string, Beacon>();
  for (const n of nodes) {
    if (!n.isRunning) continue;
    const p = beaconFor(vp, n.rect, vw, vh);
    if (!p) continue;
    const key = `${Math.round(p.x / BEACON_BUCKET)},${Math.round(p.y / BEACON_BUCKET)}`;
    const existing = byBucket.get(key);
    if (existing) { existing.count += 1; continue; }
    const beacon: Beacon = { terminalId: n.terminalId, title: n.title, x: p.x, y: p.y, count: 1 };
    byBucket.set(key, beacon);
    out.push(beacon);
  }
  return out;
}
