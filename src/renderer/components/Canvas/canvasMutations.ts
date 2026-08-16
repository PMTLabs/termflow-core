import { PaneNode } from '../../store/slices/panesSlice';
import { removeLeaf, insertByZone, firstLeafId } from '../../store/slices/paneTreeOps';
import { Rect } from './canvasGeometry';

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
  /** The leaf in the DESTINATION tree to insert against. */
  anchorPaneId: string;
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
  trees: Record<string, PaneNode>,
  terminalId: string,
  fromTabId: string,
  toTabId: string,
): RegroupPlan | null {
  if (fromTabId === toTabId) return null;
  const from = trees[fromTabId];
  const to = trees[toTabId];
  if (!from || !to) return null;

  const paneId = findPaneIdByTerminalId(from, terminalId);
  if (!paneId) return null;

  const { tree: fromTree, removed } = removeLeaf(from, paneId);
  if (!removed) return null;

  const anchorPaneId = firstLeafId(to);
  if (!anchorPaneId) return null;
  const toTree = insertByZone(to, anchorPaneId, removed, 'right');

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
