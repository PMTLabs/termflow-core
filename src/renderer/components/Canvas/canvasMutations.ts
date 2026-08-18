import { PaneNode } from '../../store/slices/panesSlice';
import { removeLeaf, insertByZone, firstLeafId } from '../../store/slices/paneTreeOps';
import { Rect } from './canvasGeometry';
import { arrange } from './canvasLayout';

/** The pane leaf hosting a terminal, or null. Depth-first, first match wins. */
export function findPaneIdByTerminalId(
  tree: PaneNode | null | undefined,
  terminalId: string,
): string | null {
  if (!tree) return null;
  if (tree.type === 'terminal') return tree.terminalId === terminalId ? tree.id : null;
  for (const child of tree.children ?? []) {
    const hit = findPaneIdByTerminalId(child, terminalId);
    if (hit) return hit;
  }
  return null;
}

export interface RegroupPlan {
  fromTabId: string;
  toTabId: string;
  /** The leaf to move, in the SOURCE tree. */
  paneId: string;
  /** The leaf in the DESTINATION tree to insert against. Null when the destination is an
   *  open, empty tab — the moved pane becomes its whole tree. */
  anchorPaneId: string | null;
  /** What the source tree becomes. Null when the tab has no terminals left. */
  fromTree: PaneNode | null;
  /** What the destination tree becomes. */
  toTree: PaneNode;
  movedPane: PaneNode;
}

/**
 * Plan moving a terminal from one tab's pane tree to another's.
 *
 * A **planner**, not an applier, and that split is deliberate. `plan/013` Task 11 Step 5 says to
 * apply the result with `addTabTree({ tabId, tree })`, writing both trees straight into the
 * store. That would have been wrong in three ways, each of them silent:
 *
 *  - `addTabTree`'s payload is typed `tree: PaneNode`, **not nullable** — so the "source tab is
 *    now empty" case, which the very next paragraph of the task insists on supporting, cannot be
 *    expressed through it at all.
 *  - It never clears `maximizedPaneByTabId`. Move a terminal out of a tab whose pane is
 *    maximized and the maximize points at a pane that no longer exists — the invariant that
 *    every pane-set-mutating reducer must clear that flag.
 *  - It never repairs `activePaneId`/`paneTree` when the active tab loses its focused pane.
 *
 * `removePaneFromTab` + `insertPaneIntoTab` — the pair the existing cross-window detach already
 * dispatches — handle all three. So the caller dispatches THOSE, using `paneId` and
 * `anchorPaneId` from here, and canvas re-homing goes through the same machinery as pane-drag
 * re-homing rather than a parallel one (design 010 §6.3).
 *
 * The predicted `fromTree`/`toTree` are still returned, and are what the tests pin the reducers
 * against: if the two ever diverge the canvas would show one layout and the tab strip another.
 *
 * `removeLeaf`/`insertByZone` both clone, so the caller's trees are never mutated.
 */
export function planRegroup(
  trees: Record<string, PaneNode | null>,
  terminalId: string,
  fromTabId: string,
  toTabId: string,
): RegroupPlan | null {
  if (fromTabId === toTabId) return null;
  const from = trees[fromTabId];
  // `undefined` is a tab with no layout at all; `null` is an open tab that has been emptied,
  // and design 010 §6.3 keeps its frame as a drop target — so it is a legal DESTINATION,
  // just never a source.
  const to = trees[toTabId];
  if (!from || to === undefined) return null;

  const paneId = findPaneIdByTerminalId(from, terminalId);
  if (!paneId) return null;

  const { tree: fromTree, removed } = removeLeaf(from, paneId);
  if (!removed) return null;

  const anchorPaneId = to && firstLeafId(to);
  // A tree that exists but has no leaf to aim at is malformed, not empty.
  if (to && !anchorPaneId) return null;
  const toTree = to && anchorPaneId ? insertByZone(to, anchorPaneId, removed, 'right') : removed;

  return { fromTabId, toTabId, paneId, anchorPaneId, fromTree, toTree, movedPane: removed };
}

/**
 * Convert a pointer delta in SCREEN pixels to one in WORLD units.
 *
 * Dividing by the zoom is not optional and getting it wrong is not subtle: at z = 0.5 a 10px
 * pointer move is 20 world units, so a drag that skips this lags the cursor at every zoom but 1
 * — and lags it *proportionally*, so it looks fine while you are testing at 1:1.
 *
 * Guarded against a zero/negative z, which `clampZoom` should prevent but which would otherwise
 * produce Infinity and throw the node off the canvas with no way back.
 */
export function worldDelta(dxScreen: number, dyScreen: number, z: number): { dx: number; dy: number } {
  const k = 1 / Math.max(z, Number.EPSILON);
  return { dx: dxScreen * k, dy: dyScreen * k };
}

/**
 * Convert an absolute pointer POSITION to world coordinates.
 *
 * The inverse of `worldStyle`'s `translate(x, y) scale(z)` with `transform-origin: 0 0`, which
 * applies the scale first and then the translation — so the translation is in SCREEN units and
 * must come off before the divide, not after. Doing it the other way round is exact at pan
 * (0, 0) and wrong everywhere else, which is the same shape of bug as multiplying by the zoom
 * in `worldDelta`: correct in precisely the state you are most likely to test in.
 *
 * `viewportRect` is the box of `.canvas-viewport`, because `.canvas-world` is positioned at its
 * origin — the sidebar makes that differ from the window.
 */
export function worldPoint(
  clientX: number,
  clientY: number,
  viewportRect: { left: number; top: number },
  vp: { x: number; y: number; z: number },
): { x: number; y: number } {
  const k = 1 / Math.max(vp.z, Number.EPSILON);
  return {
    x: (clientX - viewportRect.left - vp.x) * k,
    y: (clientY - viewportRect.top - vp.y) * k,
  };
}

export interface DropCandidate { tabId: string; rect: Rect }

/**
 * Which group frame a dragged node would drop into, or null.
 *
 * Null for "its own group" as well as for open canvas: dropping a node back where it started is
 * a move, not a re-home, and highlighting the frame it is already in would promise a change that
 * is not going to happen. Later frames win on overlap, matching paint order and `groupAt`.
 */
export function dropTargetTabId(
  groups: DropCandidate[],
  cx: number,
  cy: number,
  currentTabId: string,
): string | null {
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    const r = g.rect;
    if (cx < r.x || cx > r.x + r.w || cy < r.y || cy > r.y + r.h) continue;
    return g.tabId === currentTabId ? null : g.tabId;
  }
  return null;
}

/**
 * Re-grid one group in place — `plan/013` Task 15.
 *
 * The sidebar drop path uses this: a list drag carries no position, so the arriving terminal is
 * slotted into the destination's grid rather than dropped at an arbitrary point (design 010
 * §6.3). That is the one real difference between the two re-homing entry points; a CANVAS drop
 * honours where you let go, and deliberately does not call this.
 *
 * The frame ORIGIN is preserved — only the size follows the contents — so a group that gains a
 * terminal grows in place instead of jumping to wherever `arrange`'s own grid would have put it.
 *
 * The frame it returns is still worth dispatching even though `buildModel` derives a non-empty
 * group's drawn frame from its nodes: the STORED rect is what `seedNodePosition` places the next
 * new pane against, so leaving it stale would seed the following split into the wrong box.
 */
export function regridGroup(
  frame: Rect,
  nodeIds: string[],
): { frame: Rect; nodes: Record<string, { x: number; y: number }> } {
  // Nothing to fit around, so the frame is left exactly as it was — an emptied group keeps its
  // last size and stays a drop target (design §6.3/§10). Shrinking it to a one-node box here
  // would be the same frame-vanishes bug `fitGroupFrame` returns null to avoid.
  if (!nodeIds.length) return { frame: { ...frame }, nodes: {} };

  const laid = arrange({ groups: [{ id: '__g', nodeIds }] });
  const src = laid.groups.__g;
  const dx = frame.x - src.x;
  const dy = frame.y - src.y;
  const nodes: Record<string, { x: number; y: number }> = {};
  for (const [id, p] of Object.entries(laid.nodes)) nodes[id] = { x: p.x + dx, y: p.y + dy };
  return { frame: { x: frame.x, y: frame.y, w: src.w, h: src.h }, nodes };
}

/** Translate a frame and its members together, preserving relative offsets exactly.
 *
 *  Ids with no geometry are skipped rather than written as `undefined` — a group's member list
 *  can name a node whose rect has not been seeded yet, and a `{x: NaN}` entry would place it
 *  off the canvas permanently. */
export function moveGroupBy(
  frame: Rect,
  nodes: Record<string, Rect>,
  ids: string[],
  dx: number,
  dy: number,
): { frame: Rect; nodes: Record<string, Rect> } {
  const out: Record<string, Rect> = { ...nodes };
  for (const id of ids) {
    const n = nodes[id];
    if (!n) continue;
    out[id] = { ...n, x: n.x + dx, y: n.y + dy };
  }
  return { frame: { ...frame, x: frame.x + dx, y: frame.y + dy }, nodes: out };
}
