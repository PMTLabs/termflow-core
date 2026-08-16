/**
 * Pure geometry for Canvas Mode. No React, no DOM — everything here is arithmetic
 * so it can be unit-tested without a browser.
 *
 * The level-of-detail ladder is driven by a node's width in REAL SCREEN PIXELS
 * (w * z), not by zoom alone, so the thresholds keep their meaning if nodes are
 * ever resizable. See design 010 §4.2.
 */

export type LodTier = 'gpu' | 'live' | 'snapshot' | 'chip' | 'group';

export interface Viewport { x: number; y: number; z: number }
export interface Rect { x: number; y: number; w: number; h: number }

export const NODE_W = 340;
export const NODE_H = 210;
export const CHIP_H = 58;
/** Height of a node's title bar. Shared with the stylesheet as a CSS variable, because
 *  the terminal host's box is `NODE_W × (NODE_H - HEAD_H)` and that box must be a
 *  CONSTANT for the whole canvas session (`012` §6.5 RC2) — two independent copies of
 *  this number would let a style tweak silently resize a live PTY. */
export const HEAD_H = 29;

export const T_GPU = 190;
export const T_LIVE = 105;
export const T_SNAP = 64;
export const T_CHIP = 26;

/** Chromium caps a page near 16 WebGL contexts; stay well under it. */
export const MAX_GPU = 12;

/** How many nodes may PAINT the live terminal at once. Read this before assuming
 *  it caps engines.
 *
 *  Under `012` §6.5 RC4 every canvas node keeps its host mounted, holding a live
 *  `TerminalEngine`, for the whole canvas session — so this number can no longer mean
 *  "how many terminals are alive". It survives as a PAINT budget, which is still real
 *  work and still worth capping, and which `assignTiers` below can actually enforce by
 *  counting the nodes it labels `gpu`/`live`.
 *
 *  `010`'s tier table also calls this 48 "total interactive", meaning "accepts input" via
 *  D19's pointer gate. That is the SAME set, not a second one, so no `MAX_ACCEPTS_INPUT`
 *  is needed:
 *
 *    - A node can only be focused by double-clicking `.canvas-node-body` into the live
 *      xterm surface. Below `gpu`/`live` that surface is `visibility:hidden` (`012` §6.5
 *      RC3) and the body renders `NodeSnapshot`/a chip — there is nothing to click into.
 *      So "eligible to accept input" IS "paints".
 *    - The focus branch below forces `focusedId` into `gpu` before any size-based early
 *      return (D8), so the one node actually gated open is always inside this budget.
 *    - "Gate is open right now" is not a second budget at all: `canvasSlice.focusedId` is
 *      `string | null`, so at most ONE node is ever in that state — bounded by the data
 *      model, not by this constant.
 *
 *  `MAX_GPU = 12` is unaffected — `013` D4's `countActiveWebGLAddons()` counts it directly. */
export const MAX_INTERACTIVE = 48;

/** Z_MIN must leave the group tier reachable: NODE_W * Z_MIN has to fall below
 *  T_CHIP. At the old 0.08 the smallest legal width was 27.2px — above T_CHIP —
 *  so whole-group collapse could never happen through normal zooming. */
export const Z_MIN = 0.05;
export const Z_MAX = 1.9;

export function baseTier(effectiveWidth: number): LodTier {
  if (effectiveWidth >= T_GPU) return 'gpu';
  if (effectiveWidth >= T_LIVE) return 'live';
  if (effectiveWidth >= T_SNAP) return 'snapshot';
  if (effectiveWidth >= T_CHIP) return 'chip';
  return 'group';
}

export function clampZoom(z: number): number {
  return Math.max(Z_MIN, Math.min(Z_MAX, z));
}

/** Zoom about a screen point, keeping the world point under it fixed. */
export function zoomAt(vp: Viewport, factor: number, cx: number, cy: number): Viewport {
  const z = clampZoom(vp.z * factor);
  if (z === vp.z) return vp;
  const k = z / vp.z;
  return { x: cx - (cx - vp.x) * k, y: cy - (cy - vp.y) * k, z };
}

export function screenToWorld(vp: Viewport, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - vp.x) / vp.z, y: (sy - vp.y) / vp.z };
}

export function worldToScreen(vp: Viewport, wx: number, wy: number): { x: number; y: number } {
  return { x: wx * vp.z + vp.x, y: wy * vp.z + vp.y };
}

/** How far outside the viewport a node still counts as visible. Shared so paint
 *  culling, snapshot polling (Task 10) and the edge mask (Task 18) all agree —
 *  three different answers to "is this on screen?" would flicker against each other. */
export const CULL_MARGIN = 80;

export function isVisible(vp: Viewport, r: Rect, vw: number, vh: number, margin = CULL_MARGIN): boolean {
  const sx = r.x * vp.z + vp.x;
  const sy = r.y * vp.z + vp.y;
  const sw = r.w * vp.z;
  const sh = r.h * vp.z;
  return !(sx + sw < -margin || sy + sh < -margin || sx > vw + margin || sy > vh + margin);
}

export interface TierInput {
  ids: string[];
  rects: Record<string, Rect>;
  vp: Viewport;
  vw: number;
  vh: number;
  /** Always granted 'gpu', budget regardless — design 010 D8. */
  focusedId: string | null;
  /** Most-recently-touched first. */
  recent: string[];
}

/**
 * Rank ids by claim on a scarce resource: focused first, then most-recently-touched,
 * then declaration order.
 *
 * Exported because TWO things must rank identically — this function's tier budget, and
 * the `order` that `reconcileRenderPolicies` promotes by. If they disagreed, a node
 * could be assigned the `gpu` tier here and then promoted last over there, landing
 * outside the GPU budget: design 010 D8 makes the focused node's promotion
 * unconditional, and that guarantee spans both. Sharing the function is what makes them
 * agree structurally rather than by a comment asking someone to keep them in step.
 *
 * `recent` and `focusedId` come from state that can lag behind the node set, so both are
 * filtered against `ids` — a stale id must not reach the output.
 *
 * Set-backed rather than `Array.includes`: this runs on every viewport change, and the
 * array form is O(n^2) in the node count.
 */
export function priorityOrder(
  ids: readonly string[],
  focusedId: string | null,
  recent: readonly string[],
): string[] {
  const known = new Set(ids);
  const seen = new Set<string>();
  const order: string[] = [];
  const push = (id: string) => {
    if (!known.has(id) || seen.has(id)) return;
    seen.add(id);
    order.push(id);
  };
  if (focusedId) push(focusedId);
  recent.forEach(push);
  ids.forEach(push);
  return order;
}

export function assignTiers(input: TierInput): Record<string, LodTier> {
  const { ids, rects, vp, vw, vh, focusedId, recent } = input;
  const out: Record<string, LodTier> = {};

  const order = priorityOrder(ids, focusedId, recent);

  let gpu = 0;
  let interactive = 0;

  for (const id of order) {
    // A node with no geometry is not ON the canvas, so no tier applies and it
    // cannot be painted. This is deliberately checked BEFORE the focus branch:
    // D8 exempts the focused node from the SIZE and BUDGET rules, not from
    // existing. Promoting it here would spend one of MAX_GPU's twelve WebGL
    // contexts on something with no position to paint at. `focusNode` does not
    // require geometry to exist, so this combination is reachable.
    const r = rects[id];
    if (!r) { out[id] = 'group'; continue; }

    // Focus wins BEFORE any size-based early return. Checking it after the
    // chip/group branch would make a focused node non-interactive at deep zoom,
    // violating D8's unconditional guarantee.
    if (id === focusedId) { out[id] = 'gpu'; gpu++; interactive++; continue; }

    const base = baseTier(r.w * vp.z);
    // Below the interactive tiers, screen size alone decides.
    if (base === 'chip' || base === 'group') { out[id] = base; continue; }

    if (!isVisible(vp, r, vw, vh)) { out[id] = 'snapshot'; continue; }

    if (base === 'gpu' && gpu < MAX_GPU) { out[id] = 'gpu'; gpu++; interactive++; continue; }
    if (interactive < MAX_INTERACTIVE) { out[id] = 'live'; interactive++; continue; }
    out[id] = 'snapshot';
  }

  return out;
}
