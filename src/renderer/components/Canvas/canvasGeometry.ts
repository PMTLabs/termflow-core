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
/** Height of a node's title bar **at zoom 1 and below**. Shared with the stylesheet as a CSS
 *  variable: `BODY_H` is derived from it and `HOST_H` from that, so a second copy of this
 *  number in CSS would silently change the terminal's aspect. */
export const HEAD_H = 29;
/** The body's world height. CONSTANT at every zoom — see `headScale` for why that matters. */
export const BODY_H = NODE_H - HEAD_H;

/**
 * How much the title bar is scaled down at a given zoom, so it stops growing once it has
 * reached its natural size.
 *
 * The header and the body want opposite things. The body is a window onto a terminal, so it
 * should keep growing as you zoom in — that is the whole point of zooming in. The header is
 * a LABEL, and a label that keeps growing is just a label wasting space: at the old ceiling
 * the node title rendered at ~34 screen px and the shell badge with it, eating a fifth of the
 * node to say "PowerShell 7".
 *
 * So above zoom 1 the header counter-scales exactly, holding a constant on-screen size, and
 * every pixel the zoom adds goes to the terminal. Below zoom 1 it scales with the world like
 * everything else — at the snapshot and chip tiers the title has to shrink with its node or
 * it would swamp it.
 *
 * The node's world height follows this (`BODY_H + HEAD_H * headScale(z)`), which is what
 * keeps the body EXACTLY `NODE_W x BODY_H` at every zoom. That is load-bearing: the surface
 * scales into the body by width, so a body whose height varied with zoom would either
 * letterbox the terminal or clip its columns. The cost is that a node's drawn height falls
 * below its `rect.h` above zoom 1, so a group frame keeps the slack — invisible at the zooms
 * where this applies, and conservative (a frame never clips a node).
 */
export function headScale(z: number): number {
  return 1 / Math.max(1, z);
}

/**
 * The counter-scale for a node's FRAME — its outline, and its connector ports.
 *
 * Unclamped `1 / z`, unlike `headScale`. The title bar wants to grow with its node while the
 * node is small, because a 3px title on a 96px node is not a label. A hairline is a hairline
 * at every size: at the overview a `1px * z` border is a third of a pixel and the node has no
 * visible edge at all, and at the working zoom it is four pixels of picture frame around a
 * terminal. Both ends are the same mistake.
 *
 * Everything this scales is drawn with `outline` and `position: absolute`, so nothing it
 * returns can affect layout. That matters at the deep end: at `Z_MIN` this is 20, and a
 * 20-world-pixel BORDER would eat a tenth of the node's body and change the box the surface
 * scales into. An outline of the same width costs nothing and paints one screen pixel.
 */
export function chromeScale(z: number): number {
  return 1 / Math.max(z, Number.EPSILON);
}

/** How much of the canvas the full-screen overlay leaves as a margin, in screen px.
 *  Declared here rather than beside `overlayGeometry` because `canvasMetrics` sizes the host
 *  from it, and `DEFAULT_METRICS` runs at module load — a later declaration is a TDZ crash. */
export const OVERLAY_MARGIN = 28;

/** The host's aspect, fixed by the node body it scales into. A mismatch letterboxes every
 *  node, so `hostH` is always derived from `hostW` through this and never chosen. */
export const HOST_ASPECT = BODY_H / NODE_W;

/**
 * Bounds on the host box.
 *
 * The lower one keeps a small laptop from getting a terminal too narrow to work in. The upper
 * one is a MEMORY budget, and it is the reason this is clamped at all: every canvas node holds
 * a host for the whole session, and up to `MAX_GPU` of them back it with a WebGL canvas whose
 * backing store is four bytes a pixel. At 2400 x 1277 that is ~12 MB each; letting it track a
 * 3840-wide display unclamped would be ~30 MB each, ~360 MB of GPU memory for twelve nodes.
 */
export const MIN_HOST_W = 1100;
export const MAX_HOST_W = 2400;

/**
 * One terminal's host box, and the scale that fits it into a default-width node.
 *
 * Split out from `CanvasMetrics` by `plan/017`: the host box is now measured PER TERMINAL from
 * the pane it came from (`canvasHostBoxes.measureHostBox`) rather than being one number for the
 * session, because a host that matches the pane makes the relocation fit a provable no-op — no
 * `term.resize()`, no SIGWINCH, no TUI repaint, no duplicated content.
 *
 * `CanvasMetrics` still satisfies this interface, and is what a terminal with no rendered
 * element to measure falls back to.
 */
export interface SurfaceBox {
  /** The terminal host's CSS-pixel box — the grid the PTY actually has. */
  hostW: number;
  hostH: number;
  /** What the surface is scaled by to sit inside a DEFAULT-width node at zoom 1. */
  surfaceScale: number;
}

/** Everything about a canvas session that depends on the display it opened on.
 *
 *  Since `plan/017` its host box is the FALLBACK — used for a terminal that has never been
 *  rendered, so has no pane box worth copying — while `zMax` remains what it always was: the
 *  canvas zoom ceiling, which is a property of the display and not of any one terminal. */
export interface CanvasMetrics extends SurfaceBox {
  /** The zoom at which the FALLBACK box would render 1:1. The canvas stops short of it. */
  focusZoom: number;
  /** The canvas zoom ceiling. */
  zMax: number;
}

/**
 * Size the host box, and the zoom ceiling with it, for the display the canvas opened on.
 *
 * **Why this is not a constant.** The host box is also the box the full-screen overlay renders
 * at 1:1, because `012` §6.5 RC2 allows a session exactly ONE host size. So one number has to
 * serve a 1366-wide laptop and a 4K panel at once, and it cannot: sized for the 4K, the overlay
 * renders at half the configured font size on the laptop; sized for the laptop, it uses a
 * quarter of the 4K and the zoom ceiling with it. A fixed 1600 left 2240 pixels unused on a
 * 3840-wide display, and broke the size ladder outright below about 1500.
 *
 * **RC2 still holds**, because "constant" there means constant for the SESSION. This is
 * evaluated once, before any host is registered, and never again while terminals are relocated
 * in. Calling it mid-session would change a live terminal's CSS box — a fit, a `term.resize()`
 * and a SIGWINCH into every ratatui/codex PTY on the canvas. `CanvasMode` freezes it in a
 * `useState` initialiser for exactly that reason.
 *
 * **The ladder falls out rather than being tuned.** `zMax` is 90 % of the zoom at which a node
 * would render 1:1, and it is derived from what the overlay can ACTUALLY show at scale 1
 * (`fitW`), not from `hostW` — so when the clamps bite, the ceiling follows the overlay down
 * and `max canvas zoom < overlay` stays true on every display rather than only on the one this
 * was tuned for.
 */
export function canvasMetrics(vw: number, vh: number): CanvasMetrics {
  // The largest host that the overlay could show at EXACTLY scale 1 on this display, fitting
  // both axes — the header is capped at HEAD_H screen pixels up at those zooms.
  const fitW = Math.max(
    1,
    Math.min(vw - OVERLAY_MARGIN * 2, (vh - OVERLAY_MARGIN * 2 - HEAD_H) / HOST_ASPECT),
  );
  const hostW = Math.round(Math.min(MAX_HOST_W, Math.max(MIN_HOST_W, fitW)));
  const hostH = Math.round(hostW * HOST_ASPECT);

  // Derived from the overlay's REAL width, so a clamped host cannot lift the ceiling above
  // what the overlay can show.
  const overlayW = Math.min(hostW, fitW);
  // Floored at 1 so a node can always be reached at its natural world size. `CanvasMode`
  // evaluates this during its FIRST render, before layout, so it can legitimately be handed a
  // viewport of nothing — and an unfloored ceiling rounds to 0 there, which does not fail
  // loudly: `clampZoom` simply returns `Z_MIN` forever and the canvas is frozen at the
  // overview with no way to zoom in.
  return {
    hostW,
    hostH,
    surfaceScale: NODE_W / hostW,
    focusZoom: hostW / NODE_W,
    zMax: Math.max(1, Math.round((overlayW / NODE_W) * 0.9 * 100) / 100),
  };
}

/**
 * The metrics for an ordinary maximised window on an ordinary 1080p display.
 *
 * Exists so pure tests and non-React callers have something to reason about — NOT as a
 * fallback for a component that forgot to read the session's own metrics. Nothing in the
 * render path may import this.
 */
export const DEFAULT_METRICS = canvasMetrics(1920, 1040);

/* Tier thresholds, in real screen pixels of node width. Raised from 190/105/64/26 after the
   first manual run: the chip tier in particular was small enough to be unreadable. */
export const T_GPU = 240;
export const T_LIVE = 150;
export const T_SNAP = 96;
export const T_CHIP = 40;

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
export function baseTier(effectiveWidth: number): LodTier {
  if (effectiveWidth >= T_GPU) return 'gpu';
  if (effectiveWidth >= T_LIVE) return 'live';
  if (effectiveWidth >= T_SNAP) return 'snapshot';
  if (effectiveWidth >= T_CHIP) return 'chip';
  return 'group';
}

/**
 * `zMax` is REQUIRED, deliberately.
 *
 * It used to be a module constant, and became per-session when the host box started being
 * sized for the display (see `canvasMetrics`). A default here would let any call site keep
 * compiling while silently clamping to some other display's ceiling — the failure would be a
 * zoom that stops early on a 4K panel, which looks like a preference rather than a bug. Making
 * it required means the compiler names every site that has to be told.
 */
export function clampZoom(z: number, zMax: number): number {
  return Math.max(Z_MIN, Math.min(zMax, z));
}

/** Zoom about a screen point, keeping the world point under it fixed. */
export function zoomAt(vp: Viewport, factor: number, cx: number, cy: number, zMax: number): Viewport {
  const z = clampZoom(vp.z * factor, zMax);
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

export interface OverlayGeometry {
  /** World rect for the overlaid node. Its surface scale is `rect.w / HOST_W` like any
   *  node's, which is what puts the terminal at `scale` on screen. */
  rect: Rect;
  /** World rect covering the whole viewport, for the backdrop. */
  backdrop: Rect;
  /** Screen scale the terminal ends up rendering at. 1 means a real terminal at the user's
   *  configured font size; below 1 the viewport was too small to fit the host. */
  scale: number;
}

/**
 * Place a node as a near-full-screen overlay on the canvas.
 *
 * The overlay is **not a second surface**. It is the same node, given a world rect big enough
 * that `rect.w / m.hostW` puts its existing host at screen scale 1 — so nothing is mounted,
 * moved, re-registered or re-fitted to open it, and `012` §6.5 RC1-RC5 never come into play.
 * That is also why it cannot show a bigger grid than an ordinary node: the terminal has exactly
 * one grid, and the overlay is the zoom at which you see all of it at its true size.
 *
 * **`m` is now THAT TERMINAL's box, not the session's** (`plan/017`, decision C). So the
 * overlay is the terminal at actual size: an unsplit tab's terminal fills the screen, and a
 * quarter-split's fills a quarter. The alternative — enlarging past 1:1, or re-fitting on open —
 * would either exceed the configured font size or put back the very resize `017` removes.
 *
 * `scale` is capped at 1 rather than filling the viewport, because past 1 the terminal's font
 * grows beyond the user's configured size — the thing they explicitly asked not to happen.
 * On a viewport too narrow for `HOST_W` it drops below 1, and the caller should know: xterm 6
 * does not divide pointer deltas by an ancestor transform, so clicks land on the wrong cell
 * at any scale but 1. Typing is unaffected.
 *
 * The backdrop is in WORLD space, not screen space, because `.canvas-world` sets
 * `will-change: transform` and is therefore a stacking context — a backdrop outside it could
 * never sit between the ordinary nodes and the overlaid one.
 */
export function overlayGeometry(vp: Viewport, vw: number, vh: number, m: SurfaceBox): OverlayGeometry {
  const availW = Math.max(1, vw - OVERLAY_MARGIN * 2);
  const availH = Math.max(1, vh - OVERLAY_MARGIN * 2);
  // The header's SCREEN height, which is `HEAD_H` wherever the cap is in force and shrinks
  // with the world below zoom 1 — `HEAD_H * headScale(z) * z` reduced.
  const headScreenH = HEAD_H * Math.min(1, vp.z);
  // Floored at `SURFACE_SCALE`, which is the scale at which the host renders exactly `NODE_W`
  // wide — an "overlay" narrower than an ordinary node is not enlarged in any sense, and
  // without the floor a viewport shorter than the header alone drives the fit term NEGATIVE
  // and hands the node a negative width.
  const scale = Math.max(
    m.surfaceScale,
    Math.min(1, availW / m.hostW, (availH - headScreenH) / m.hostH),
  );

  const screenW = m.hostW * scale;
  const screenH = m.hostH * scale + headScreenH;
  const left = (vw - screenW) / 2;
  const top = (vh - screenH) / 2;

  // Screen -> world. The node lives inside `.canvas-world`, so everything it is given must be
  // in world units; dividing by `z` is what makes the result render at the screen size above.
  const toWorld = (sx: number, sy: number) => screenToWorld(vp, sx, sy);
  const origin = toWorld(left, top);
  const worldW = screenW / vp.z;

  return {
    // `h` is NOT `screenH / z`. `CanvasNode` derives the body from `h - HEAD_H` and then adds
    // the CAPPED header back, so the height it is given has to be expressed in those terms or
    // the node renders shorter than the box this function measured — the first version of
    // this did exactly that and the overlay came out ~11% short at high zoom.
    rect: { x: origin.x, y: origin.y, w: worldW, h: m.hostH * worldW / m.hostW + HEAD_H },
    backdrop: (() => {
      const a = toWorld(-CULL_MARGIN, -CULL_MARGIN);
      const b = toWorld(vw + CULL_MARGIN, vh + CULL_MARGIN);
      return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
    })(),
    scale,
  };
}

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
