import { Rect, NODE_W, NODE_H } from './canvasGeometry';
import { fanPlacement } from './agentPlacement';
import { buildNewTabFields, NewTabFields, ShellProfileLike } from '../../services/newTabActions';
import type { PaneNode } from '../../store/slices/panesSlice';
import { generateId } from '../../utils/id';

/**
 * Creating a terminal FROM the canvas — Tam's items 3 and 4 (right-click the background, or
 * click a port). Pure, so the two things that are easy to get wrong here are testable without
 * a store: where the node lands, and whether the new tab steals the screen.
 */

export interface CanvasSpawn {
  /** Ready for `addTab`. `isActive: false` is not a detail — see below. */
  tab: NewTabFields & { isActive: false };
  /**
   * The `tm-` leaf the new tab's root pane carries — and therefore the CANVAS NODE's id,
   * since `buildCanvasModel` keys a node by `leaf.terminalId`. Everything that addresses the
   * new node (`setNodeGeom`, `selectNode`, `connectWhenReady`) must use this, never `tab.id`.
   *
   * Minted here so it is knowable before the tab is added, which the geometry-first ordering
   * below requires. Until design 014 a renderer-created tab's root leaf WAS its tab id, so
   * `tab.id` served as the node id for free and this field did not need to exist.
   */
  leafId: string;
  /**
   * The root pane tree to install alongside `addTab`, so `tabTreeSeed.planSeeds` finds the tab
   * already initialised instead of manufacturing a second root under a leaf we never saw.
   */
  tree: PaneNode;
  /** Where the node goes, written through `setNodeGeom` BEFORE `addTab`. */
  rect: Rect;
}

/**
 * A node centred on a world point — "put a terminal HERE".
 *
 * Centred rather than anchored top-left, because the point the user aimed at is the middle of
 * where they want the thing, and a 340×210 node hung down-and-right of the cursor lands
 * somewhere they did not point at. It is also the only version that behaves at the edges of a
 * group frame, where an off-by-half-a-node reads as "it ignored me".
 */
export function spawnRectAt(at: { x: number; y: number }): Rect {
  return { x: at.x - NODE_W / 2, y: at.y - NODE_H / 2, w: NODE_W, h: NODE_H };
}

/**
 * A node fanned out from an existing one, for the port-click spawn.
 *
 * The same `fanPlacement` an agent-spawned terminal gets (Task 20), and deliberately so: a wire
 * out of a port and a wire the MCP tool drew are the same relationship, and two placements for
 * one relationship would put hand-made and agent-made children in visibly different places.
 * `index` is how many edges already leave this node, so a run of them fans instead of stacking.
 */
export function spawnRectNear(source: Rect, taken: readonly Rect[], index: number): Rect {
  const p = fanPlacement(source, [...taken], index);
  return { x: p.x, y: p.y, w: source.w, h: source.h };
}

/**
 * **`isActive: false` is the whole reason this is a function and not two inline object
 * literals.** `addTab` activates by default, and activating any tab deactivates the canvas —
 * which unmounts `CanvasMode`, hands every relocated terminal back to its pane, and drops the
 * user out of the canvas onto the terminal they just made. The gesture is "add a terminal to
 * this workspace", not "leave for it": the node appears where they pointed, and they are still
 * looking at the canvas when it does.
 *
 * The terminal still spawns while the tab is in the background — `TerminalContainer` renders a
 * `PaneManager` for every non-virtual tab, active or not.
 */
export function planCanvasSpawn(
  profile: ShellProfileLike,
  existingTitles: string[],
  rect: Rect,
): CanvasSpawn {
  const tab = { ...buildNewTabFields(profile, existingTitles), isActive: false as const };
  const leafId = generateId('tm');
  // Mirrors what `tabTreeSeed.candidateFor` would build for this tab, including
  // `seededForTabId` — the field that records ownership now that a root leaf no longer carries
  // its tab's id (design 014 §A6.0). Omitting it would leave `planSeeds` Rule 3 unable to tell
  // this tab from one whose only terminal was dragged away.
  const tree: PaneNode = {
    id: generateId('pn'),
    type: 'terminal',
    terminalId: leafId,
    seededForTabId: tab.id,
    name: tab.title,
    shellType: tab.shellType,
  };
  return { tab, leafId, tree, rect };
}
