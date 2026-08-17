import {
  baseTier, clampZoom, zoomAt, screenToWorld, worldToScreen, isVisible, isFullyVisible, assignTiers,
  NODE_W, NODE_H, T_GPU, T_LIVE, T_SNAP, T_CHIP, MAX_GPU, MAX_INTERACTIVE,
  Z_MIN, Viewport, Rect,
  HEAD_H, BODY_H, headScale, overlayGeometry, OVERLAY_MARGIN,
  headFontSize, HEAD_FONT, MIN_TITLE_PX, MAX_HEAD_K, HEAD_GROWTH_PX,
  canvasMetrics, DEFAULT_METRICS, MIN_HOST_W, MAX_HOST_W, HOST_ASPECT,
} from '../canvasGeometry';
import { PAD } from '../canvasLayout';

// The host box is per-session now (see `canvasMetrics`), so these are the metrics of an
// ordinary maximised window on an ordinary 1080p display — not global constants.
const { hostW: HOST_W, hostH: HOST_H, surfaceScale: SURFACE_SCALE, focusZoom: FOCUS_ZOOM, zMax: Z_MAX } = DEFAULT_METRICS;

const rectFor = (x: number, y: number): Rect => ({ x, y, w: NODE_W, h: NODE_H });

describe('baseTier', () => {
  it('maps each threshold to its tier, inclusive at the boundary', () => {
    expect(baseTier(T_GPU)).toBe('gpu');
    expect(baseTier(T_GPU - 1)).toBe('live');
    expect(baseTier(T_LIVE)).toBe('live');
    expect(baseTier(T_LIVE - 1)).toBe('snapshot');
    expect(baseTier(T_SNAP)).toBe('snapshot');
    expect(baseTier(T_SNAP - 1)).toBe('chip');
    expect(baseTier(T_CHIP)).toBe('chip');
    expect(baseTier(T_CHIP - 1)).toBe('group');
    expect(baseTier(0)).toBe('group');
  });
});

describe('clampZoom', () => {
  it('clamps to the configured range', () => {
    expect(clampZoom(0.001, Z_MAX)).toBe(Z_MIN);
    expect(clampZoom(99, Z_MAX)).toBe(Z_MAX);
    expect(clampZoom(1, Z_MAX)).toBe(1);
  });
});

describe('threshold invariant', () => {
  it('leaves the group tier reachable at the minimum legal zoom', () => {
    // Without this the ladder silently loses its top rung: at Z_MIN=0.08 the
    // smallest legal node width was 27.2px, never below T_CHIP=26.
    expect(NODE_W * Z_MIN).toBeLessThan(T_CHIP);
  });

  it('keeps every tier band non-empty and correctly ordered', () => {
    expect(T_GPU).toBeGreaterThan(T_LIVE);
    expect(T_LIVE).toBeGreaterThan(T_SNAP);
    expect(T_SNAP).toBeGreaterThan(T_CHIP);
    expect(NODE_W * Z_MAX).toBeGreaterThan(T_GPU);
  });
});

describe('terminal host box', () => {
  // The host is scaled into the node body, so a different aspect would letterbox every
  // node — visible as dead bars, and as a terminal that is not the size it claims.
  it('has the same aspect as the node body it scales into', () => {
    expect(HOST_H / HOST_W).toBeCloseTo((NODE_H - HEAD_H) / NODE_W, 2);
  });

  it('scales down to exactly the node body at zoom 1', () => {
    expect(HOST_W * SURFACE_SCALE).toBeCloseTo(NODE_W, 6);
    expect(HOST_H * SURFACE_SCALE).toBeCloseTo(NODE_H - HEAD_H, 0);
  });

  // The reason FOCUS_ZOOM exists. xterm 6 does not divide pointer deltas by an ancestor
  // transform, so input is correct at exactly ONE zoom — the one where these cancel.
  it('renders the terminal 1:1 at FOCUS_ZOOM', () => {
    expect(FOCUS_ZOOM * SURFACE_SCALE).toBeCloseTo(1, 9);
  });

  // FOCUS_ZOOM is deliberately OUTSIDE the legal range. The canvas is a preview and stops
  // short of 1:1 so the overlay is always the bigger rung — see the ladder suite below.
  it('keeps the canvas ceiling below the 1:1 zoom', () => {
    expect(Z_MAX).toBeLessThan(FOCUS_ZOOM);
    expect(clampZoom(FOCUS_ZOOM, Z_MAX)).toBe(Z_MAX);
    expect(Z_MAX).toBeGreaterThan(Z_MIN);
  });

  // The size complaint this whole box exists to fix. At the old 340px the grid was ~40
  // columns, which is what made the font look oversized and the scrollback narrow.
  it('is wide enough to be a real terminal, not a preview', () => {
    expect(HOST_W).toBeGreaterThanOrEqual(720); // ~85 columns at a default font
    expect(HOST_W).toBeGreaterThan(NODE_W * 2);
  });
});

describe('zoomAt', () => {
  it('keeps the point under the cursor fixed', () => {
    const vp: Viewport = { x: 40, y: -25, z: 0.7 };
    const cx = 320, cy = 180;
    const before = screenToWorld(vp, cx, cy);
    const after = screenToWorld(zoomAt(vp, 1.4, cx, cy, Z_MAX), cx, cy);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it('does not move the viewport when the zoom is already clamped', () => {
    const vp: Viewport = { x: 10, y: 10, z: Z_MAX };
    expect(zoomAt(vp, 2, 100, 100, Z_MAX)).toEqual(vp);
  });

  // A factor that overshoots the clamp must still land ON the clamp, not be
  // rejected as "already clamped" — otherwise a fast wheel gesture from 1.5x
  // would refuse to reach Z_MAX at all.
  it('lands exactly on the clamp when the factor overshoots it', () => {
    const vp: Viewport = { x: 10, y: 10, z: 1.5 };
    expect(zoomAt(vp, 100, 100, 100, Z_MAX).z).toBe(Z_MAX);
    expect(zoomAt(vp, 0.0001, 100, 100, Z_MAX).z).toBe(Z_MIN);
  });
});

describe('isVisible', () => {
  const vp: Viewport = { x: 0, y: 0, z: 1 };
  it('accepts a node inside the viewport', () => {
    expect(isVisible(vp, rectFor(10, 10), 800, 600)).toBe(true);
  });
  it('rejects a node far off-screen', () => {
    expect(isVisible(vp, rectFor(5000, 5000), 800, 600)).toBe(false);
  });
  it('accepts a node just outside, within the margin', () => {
    expect(isVisible(vp, rectFor(-NODE_W - 40, 10), 800, 600, 80)).toBe(true);
  });
  it('rejects a node just beyond the margin', () => {
    expect(isVisible(vp, rectFor(-NODE_W - 120, 10), 800, 600, 80)).toBe(false);
  });
});

/**
 * Containment, the sibling of `isVisible`'s intersection — added when a terminal created from
 * the canvas had to be brought into view (2026-08-17).
 *
 * The distinction is the whole reason it exists: a node clipped by the right edge intersects
 * the viewport and is still not something you can read, so reusing `isVisible` to decide
 * "does this need flying to?" would decline to move and leave the new terminal half off screen.
 */
describe('isFullyVisible', () => {
  const vp: Viewport = { x: 0, y: 0, z: 1 };

  it('accepts a node comfortably inside', () => {
    expect(isFullyVisible(vp, rectFor(100, 100), 800, 600)).toBe(true);
  });

  it('rejects a node entirely off screen', () => {
    expect(isFullyVisible(vp, rectFor(5000, 5000), 800, 600)).toBe(false);
  });

  /** The case the two predicates answer differently, and the reason for the second one. */
  it('rejects a node the intersection test accepts', () => {
    const clipped = rectFor(800 - NODE_W / 2, 100);      // half past the right edge
    expect(isVisible(vp, clipped, 800, 600, 0)).toBe(true);
    expect(isFullyVisible(vp, clipped, 800, 600)).toBe(false);
  });

  it('checks all four edges', () => {
    expect(isFullyVisible(vp, rectFor(-1, 100), 800, 600)).toBe(false);          // left
    expect(isFullyVisible(vp, rectFor(100, -1), 800, 600)).toBe(false);          // top
    expect(isFullyVisible(vp, rectFor(800 - NODE_W + 1, 100), 800, 600)).toBe(false);  // right
    expect(isFullyVisible(vp, rectFor(100, 600 - NODE_H + 1), 800, 600)).toBe(false);  // bottom
  });

  it('counts a node flush against every edge as framed', () => {
    // The boundary itself is inside. An off-by-one the other way would fly the viewport for a
    // node that exactly fills it, which never settles.
    expect(isFullyVisible(vp, { x: 0, y: 0, w: 800, h: 600 }, 800, 600)).toBe(true);
  });

  /** `inset` keeps a node from counting as framed while it is under the toolbar, the minimap
   *  or a beacon — all of which paint inside the viewport's own edges. */
  it('shrinks the frame by the inset', () => {
    const corner = rectFor(800 - NODE_W - 10, 100);
    expect(isFullyVisible(vp, corner, 800, 600)).toBe(true);
    expect(isFullyVisible(vp, corner, 800, 600, 130)).toBe(false);
  });

  it('measures in SCREEN space, so the zoom changes the answer', () => {
    // A node that fits at 0.5x does not at 2x. Testing only at z=1 would pass with the zoom
    // term dropped entirely — the same shape of bug `worldDelta` documents.
    const r = rectFor(0, 0);
    expect(isFullyVisible({ x: 0, y: 0, z: 0.5 }, r, 400, 300)).toBe(true);
    expect(isFullyVisible({ x: 0, y: 0, z: 2 }, r, 400, 300)).toBe(false);
  });

  /**
   * Each dimension scaled INDEPENDENTLY, in a viewport where only that one can decide.
   *
   * The version above rejects at 2x on either axis, so it stays green with the zoom dropped
   * from the width alone — the height term carries the assertion and the width bug rides along
   * underneath it. A mutation survived exactly that way, which is the whole reason these two
   * exist: pick a box where the axis under test is the ONLY one that can fail.
   */
  it('scales the width by the zoom', () => {
    // 340×210 at 2x is 680×420. Height fits 600 with room; width does not fit 600.
    expect(isFullyVisible({ x: 0, y: 0, z: 2 }, rectFor(0, 0), 600, 600)).toBe(false);
    expect(isFullyVisible({ x: 0, y: 0, z: 2 }, rectFor(0, 0), 700, 600)).toBe(true);
  });

  it('scales the height by the zoom', () => {
    // The mirror: width fits 900, height does not fit 400.
    expect(isFullyVisible({ x: 0, y: 0, z: 2 }, rectFor(0, 0), 900, 400)).toBe(false);
    expect(isFullyVisible({ x: 0, y: 0, z: 2 }, rectFor(0, 0), 900, 500)).toBe(true);
  });

  it('accounts for the pan', () => {
    const r = rectFor(1000, 1000);
    expect(isFullyVisible({ x: 0, y: 0, z: 1 }, r, 800, 600)).toBe(false);
    expect(isFullyVisible({ x: -900, y: -950, z: 1 }, r, 800, 600)).toBe(true);
  });
});

describe('assignTiers', () => {
  const vp1: Viewport = { x: 0, y: 0, z: 1 };
  const many = (n: number) => {
    const ids: string[] = [], rects: Record<string, Rect> = {};
    for (let i = 0; i < n; i++) {
      const id = `tm-${i}`;
      ids.push(id);
      rects[id] = rectFor((i % 8) * 20, Math.floor(i / 8) * 20);
    }
    return { ids, rects };
  };

  it('caps GPU at MAX_GPU and keeps the rest interactive', () => {
    const { ids, rects } = many(30);
    const t = assignTiers({ ids, rects, vp: vp1, vw: 4000, vh: 4000, focusedId: null, recent: [] });
    expect(ids.filter((i) => t[i] === 'gpu')).toHaveLength(MAX_GPU);
    expect(ids.filter((i) => t[i] === 'gpu' || t[i] === 'live')).toHaveLength(30);
  });

  it('caps total interactive at MAX_INTERACTIVE and demotes the overflow to snapshot', () => {
    const { ids, rects } = many(60);
    const t = assignTiers({ ids, rects, vp: vp1, vw: 9000, vh: 9000, focusedId: null, recent: [] });
    expect(ids.filter((i) => t[i] === 'gpu' || t[i] === 'live')).toHaveLength(MAX_INTERACTIVE);
    expect(ids.filter((i) => t[i] === 'snapshot')).toHaveLength(60 - MAX_INTERACTIVE);
  });

  it('grants the focused node gpu even when the budget is full', () => {
    const { ids, rects } = many(30);
    const focusedId = ids[29];
    const t = assignTiers({ ids, rects, vp: vp1, vw: 4000, vh: 4000, focusedId, recent: ids.slice(0, MAX_GPU) });
    expect(t[focusedId]).toBe('gpu');
    expect(ids.filter((i) => t[i] === 'gpu')).toHaveLength(MAX_GPU);
  });

  it('prefers recently touched nodes for the gpu budget', () => {
    const { ids, rects } = many(30);
    const recent = [ids[25], ids[26]];
    const t = assignTiers({ ids, rects, vp: vp1, vw: 4000, vh: 4000, focusedId: null, recent });
    expect(t[ids[25]]).toBe('gpu');
    expect(t[ids[26]]).toBe('gpu');
  });

  it('never makes an off-screen node interactive', () => {
    const ids = ['tm-on', 'tm-off'];
    const rects = { 'tm-on': rectFor(0, 0), 'tm-off': rectFor(9000, 9000) };
    const t = assignTiers({ ids, rects, vp: vp1, vw: 800, vh: 600, focusedId: null, recent: [] });
    expect(t['tm-on']).toBe('gpu');
    expect(t['tm-off']).toBe('snapshot');
  });

  it('collapses everything to group tier at the LEGAL minimum zoom', () => {
    // Must use the Z_MIN constant, never a hardcoded number: clampZoom can
    // never produce a zoom below Z_MIN, so a test at an arbitrary smaller
    // value proves nothing about anything the app can actually reach. This
    // test only passes because NODE_W * Z_MIN < T_CHIP — see the invariant
    // test in the constants suite.
    const { ids, rects } = many(5);
    const t = assignTiers({ ids, rects, vp: { x: 0, y: 0, z: Z_MIN }, vw: 800, vh: 600, focusedId: null, recent: [] });
    ids.forEach((i) => expect(t[i]).toBe('group'));
  });

  it('grants the focused node gpu even at the minimum zoom', () => {
    // D8 is unconditional. A focused node must stay interactive at any zoom.
    const { ids, rects } = many(5);
    const t = assignTiers({ ids, rects, vp: { x: 0, y: 0, z: Z_MIN }, vw: 800, vh: 600, focusedId: ids[2], recent: [] });
    expect(t[ids[2]]).toBe('gpu');
    expect(t[ids[0]]).toBe('group');
  });

  // The priority list is built by filtering `recent`/`focusedId` against `ids`.
  // Both arrive from state that can lag behind the node set (a terminal closed
  // while it was focused), so a stale id must not appear in the output at all —
  // a component iterating the result would render a node that no longer exists.
  it('ignores a focused or recent id that is not in ids', () => {
    const { ids, rects } = many(3);
    const t = assignTiers({
      ids, rects, vp: vp1, vw: 800, vh: 600,
      focusedId: 'tm-closed', recent: ['tm-also-gone', ids[1]],
    });
    expect(Object.keys(t).sort()).toEqual([...ids].sort());
  });

  // Every id gets exactly one tier, and no id is processed twice — an id that
  // appears in `recent` AND in `ids` must not consume two budget slots.
  it('assigns every id exactly once, even when recent repeats ids', () => {
    const { ids, rects } = many(20);
    const t = assignTiers({
      ids, rects, vp: vp1, vw: 4000, vh: 4000,
      focusedId: ids[0], recent: [ids[0], ids[1], ids[1], ids[2]],
    });
    expect(Object.keys(t)).toHaveLength(20);
    expect(ids.filter((i) => t[i] === 'gpu')).toHaveLength(MAX_GPU);
  });

  it('gives a node with no rect the group tier rather than dropping it', () => {
    const t = assignTiers({
      ids: ['tm-a', 'tm-b'], rects: { 'tm-a': rectFor(0, 0) },
      vp: vp1, vw: 800, vh: 600, focusedId: null, recent: [],
    });
    expect(t['tm-b']).toBe('group');
  });

  // The interaction between the two rules above. D8 exempts the focused node from
  // the SIZE and BUDGET rules, not from existing: a node with no geometry has
  // nowhere to paint, so promoting it would spend one of MAX_GPU's twelve WebGL
  // contexts on nothing. `canvasSlice.focusNode` does not require geometry, so this
  // state is reachable rather than theoretical.
  it('does not promote a focused node that has no geometry', () => {
    const t = assignTiers({
      ids: ['ghost', 'real'], rects: { real: rectFor(0, 0) },
      vp: vp1, vw: 800, vh: 600, focusedId: 'ghost', recent: [],
    });
    expect(t['ghost']).toBe('group');
    expect(t['real']).toBe('gpu');
  });
});

// The gate noted worldToScreen had no coverage at all — it is the algebraic
// inverse of screenToWorld, and the pair is what keeps painting (worldStyle's
// transform) and hit-testing agreeing. A sign error in either is invisible until
// clicks land on the wrong node.
describe('screenToWorld / worldToScreen', () => {
  const viewports: Viewport[] = [
    { x: 0, y: 0, z: 1 },
    { x: 37, y: -14, z: 0.65 },
    { x: -220, y: 480, z: 1.9 },
    { x: 5, y: 5, z: Z_MIN },
  ];

  it('round-trips in both directions at every zoom', () => {
    for (const vp of viewports) {
      const w = screenToWorld(vp, 321, -47);
      const s = worldToScreen(vp, w.x, w.y);
      expect(s.x).toBeCloseTo(321, 6);
      expect(s.y).toBeCloseTo(-47, 6);
    }
  });

  it('matches the transform worldStyle emits: screen = world * z + pan', () => {
    const vp: Viewport = { x: 37, y: -14, z: 0.65 };
    expect(worldToScreen(vp, 100, 200)).toEqual({
      x: 100 * vp.z + vp.x,
      y: 200 * vp.z + vp.y,
    });
  });
});

/**
 * The title bar stops growing once it has reached its natural size.
 *
 * The property that matters is not "it gets smaller" — it is that the header holds a CONSTANT
 * on-screen size above zoom 1 while the body keeps growing, because that is what hands the
 * zoom to the terminal instead of to the word "PowerShell".
 */
describe('headScale — the capped title bar', () => {
  const screenHead = (z: number) => HEAD_H * headScale(z) * z;
  /** What `CanvasNode` renders: the body keeps its world height, the header gives up slack. */
  const nodeWorldH = (z: number) => (NODE_H - HEAD_H) + HEAD_H * headScale(z);

  /**
   * REPLACES "scales with the world at and below zoom 1, like every other node part".
   *
   * That was the shipped behaviour and it was wrong on screen: the title shrank linearly with
   * the world across the whole live/snapshot band — 3.6 screen px at z = 0.3 — and only became
   * legible again at the CHIP tier, where `chipFontSize` floors it at 13. The ladder ran
   * small, then smaller, then suddenly bigger. Reported from live testing, 2026-08-16.
   *
   * The bar now grows back below zoom 1 instead, capped by what the group frame can absorb.
   */
  it('grows the bar back below zoom 1 rather than letting it vanish', () => {
    expect(headScale(1)).toBe(1);
    // Strictly increasing as the world shrinks, until the cap.
    expect(headScale(0.75)).toBeGreaterThan(1);
    expect(headScale(0.5)).toBeGreaterThan(headScale(0.75));
    expect(headScale(Z_MIN)).toBe(MAX_HEAD_K);
  });

  /**
   * The floor, stated as the thing the user can actually see: a glyph's size in SCREEN pixels.
   *
   * Checked across the band where a node draws a real title bar — from the snapshot/chip
   * boundary up to the ceiling. Below `T_SNAP` a node is a chip and `chipFontSize` owns the
   * label instead, which is why the sweep starts there rather than at `Z_MIN`.
   */
  it('never renders the title below MIN_TITLE_PX, anywhere on the ladder', () => {
    const zChip = T_SNAP / NODE_W;
    for (let z = zChip; z <= Z_MAX; z += 0.01) {
      const onScreen = headFontSize(z) * headScale(z) * z;
      expect(onScreen).toBeGreaterThanOrEqual(MIN_TITLE_PX - 1e-9);
    }
  });

  it('does not inflate the title where the natural size is already big enough', () => {
    // The floor must be a floor, not a rescale. At and above zoom 1 the header already holds
    // a constant on-screen size, so nothing here may change.
    for (const z of [1, 1.5, FOCUS_ZOOM, Z_MAX]) {
      expect(headFontSize(z)).toBe(HEAD_FONT);
    }
  });

  it('keeps the floored glyph inside the bar that has to hold it', () => {
    // The two halves of this fix pull opposite ways: `headScale` is CAPPED by the frame's
    // padding, while `headFontSize` keeps growing to hold the floor. Past some zoom-out the
    // glyph would outgrow its own bar and be clipped by `.canvas-node-head { overflow: hidden }`
    // — silently, since the node still looks like a node. This proves it does not happen over
    // the band where a bar is drawn.
    //
    // Compared against a bare `HEAD_H`, and the units are the whole reason: the font is set on
    // `.canvas-node-head-inner`, which is `HEAD_H` tall in its OWN coordinate space and is then
    // scaled by `k` as one element. So the glyph competes with `HEAD_H`, not with the bar's
    // world height `HEAD_H * k` — that comparison is off by `k` and passes at every zoom below
    // 1 while failing above it for a reason that has nothing to do with legibility.
    const zChip = T_SNAP / NODE_W;
    for (let z = zChip; z <= Z_MAX; z += 0.01) {
      expect(headFontSize(z)).toBeLessThanOrEqual(HEAD_H);
    }
    // How much room is actually left at the tightest point, so a future change to
    // `MIN_TITLE_PX` or `MAX_HEAD_K` that eats it shows up here as a number rather than as
    // clipped descenders on a screenshot.
    expect(headFontSize(zChip) / HEAD_H).toBeCloseTo(0.866, 2);
  });

  it('may not grow the node past the slack its group frame leaves underneath', () => {
    // `HEAD_GROWTH_PX` is derived from `PAD`, in another file. Asserted rather than restated:
    // growing the bar grows the NODE (the body is fixed), and a node taller than its frame's
    // bottom padding draws through the frame's lower border.
    expect(HEAD_GROWTH_PX).toBeLessThanOrEqual(PAD);
    expect(nodeWorldH(Z_MIN) - NODE_H).toBeCloseTo(HEAD_GROWTH_PX, 9);
  });

  it('holds a constant HEAD_H on screen above zoom 1', () => {
    for (const z of [1.0001, 1.5, 2.6, FOCUS_ZOOM, Z_MAX]) {
      expect(screenHead(z)).toBeCloseTo(HEAD_H, 9);
    }
  });

  // The other half, and the one a "header gets smaller" test would miss entirely: the body
  // must NOT give anything up. The surface scales into it by width, so a body whose world
  // height moved with zoom would letterbox the terminal or clip its columns.
  it('never changes the body height, at any zoom', () => {
    for (const z of [Z_MIN, 0.5, 1, 2, FOCUS_ZOOM, Z_MAX]) {
      expect(nodeWorldH(z) - HEAD_H * headScale(z)).toBeCloseTo(BODY_H, 9);
    }
    expect(BODY_H).toBe(NODE_H - HEAD_H);
  });

  it('is continuous at zoom 1 — no jump as the cap engages', () => {
    expect(screenHead(0.999)).toBeCloseTo(screenHead(1.001), 1);
  });

  // At the old ceiling the title rendered at ~34 screen px. That is the complaint, stated as
  // a number so it cannot come back.
  it('keeps the header a small fraction of the node at working zoom', () => {
    expect(screenHead(FOCUS_ZOOM) / (BODY_H * FOCUS_ZOOM)).toBeLessThan(0.05);
  });
});

/**
 * The full-screen overlay.
 *
 * Its whole design claim is that it needs no second host: it is the same node given a world
 * rect big enough that `rect.w / HOST_W` puts the existing host at screen scale 1. So the
 * assertions here are about SCREEN geometry reconstructed from the world rect the way the DOM
 * reconstructs it — not about the numbers the function happens to return.
 */
describe('overlayGeometry', () => {
  const VW = 1920;
  const VH = 1040;
  /** Exactly what `CanvasNode` + `.canvas-surface` do with the rect, in screen pixels. */
  const rendered = (vp: Viewport, vw: number, vh: number) => {
    const g = overlayGeometry(vp, vw, vh, DEFAULT_METRICS);
    const surfaceScale = g.rect.w / HOST_W;              // --node-surface-scale
    const bodyWorldH = g.rect.h - HEAD_H;
    const headWorldH = HEAD_H * headScale(vp.z);
    return {
      g,
      terminalScale: surfaceScale * vp.z,                 // host px -> screen px
      w: g.rect.w * vp.z,
      h: (bodyWorldH + headWorldH) * vp.z,
      left: g.rect.x * vp.z + vp.x,
      top: g.rect.y * vp.z + vp.y,
    };
  };

  it('renders the terminal at exactly the scale it reports', () => {
    for (const z of [Z_MIN, 0.4, 1, 2.5, FOCUS_ZOOM, Z_MAX]) {
      const r = rendered({ x: 0, y: 0, z }, VW, VH);
      expect(r.terminalScale).toBeCloseTo(r.g.scale, 9);
    }
  });

  // The bug this file's author actually shipped: `h` was set to `screenH / z`, but CanvasNode
  // derives the body from `h - HEAD_H` and adds the CAPPED header back — so the node came out
  // ~11% shorter than the box the function had measured. Reconstructing the rendered height
  // is what catches it; comparing the returned numbers to themselves never would.
  it('renders at the size it measured, height included', () => {
    for (const z of [0.5, 1, 2.5, FOCUS_ZOOM, Z_MAX]) {
      const r = rendered({ x: 0, y: 0, z }, VW, VH);
      expect(r.w).toBeCloseTo(HOST_W * r.g.scale, 6);
      // Reconstructed through `headScale`, not through the closed form `Math.min(1, z)` it
      // used to use: that reduction was only valid while `headScale` was `1 / max(1, z)`, and
      // restating it here meant this test and the production code could disagree about the
      // header while both looked self-consistent.
      expect(r.h).toBeCloseTo(HOST_H * r.g.scale + HEAD_H * headScale(z) * z, 6);
    }
  });

  /**
   * The overlay must FIT, and this is the only assertion here that can tell.
   *
   * Everything else in this describe reconstructs the drawn box from the geometry the function
   * returned, so a change that moves `scale` and the reconstruction together passes them all —
   * which is exactly what happened when `headScreenH` was the hard-coded `HEAD_H * min(1, z)`.
   * That closed form was the correct reduction of `HEAD_H * headScale(z) * z` only while
   * `headScale` was `1 / max(1, z)`; once `headScale` gained its below-1 floor the overlay
   * started sizing itself against a header SHORTER than the one `CanvasNode` draws, and grew
   * past the margin it is supposed to leave.
   *
   * Compared against the viewport rather than against the function's own numbers, so there is
   * nothing for a consistent change to move in step.
   */
  it('fits inside the viewport margin at every zoom, header included', () => {
    // Swept over viewport HEIGHTS as well as zooms, and that is what makes it bite. On a tall
    // viewport the `Math.min(1, ...)` cap dominates and `scale` is 1 whatever the header
    // costs — so a wrong `headScreenH` is invisible there. It only shows up where the height
    // term is the binding one, which is any window shorter than `hostH + headScreenH`.
    for (const vh of [820, 900, 1000, VH]) {
      const availH = vh - OVERLAY_MARGIN * 2;
      const availW = VW - OVERLAY_MARGIN * 2;
      for (const z of [0.3, 0.5, 0.8, 1, 2.5, FOCUS_ZOOM, Z_MAX]) {
        const r = rendered({ x: 0, y: 0, z }, VW, vh);
        expect(r.h).toBeLessThanOrEqual(availH + 1e-6);
        expect(r.w).toBeLessThanOrEqual(availW + 1e-6);
      }
    }
  });

  it('never magnifies past the configured font size', () => {
    for (const vw of [800, 1280, 1920, 5120]) {
      expect(overlayGeometry({ x: 0, y: 0, z: 1 }, vw, 2880, DEFAULT_METRICS).scale).toBeLessThanOrEqual(1);
    }
  });

  it('reaches exactly 1:1 on a display with room for the host', () => {
    expect(overlayGeometry({ x: 0, y: 0, z: 1 }, VW, VH, DEFAULT_METRICS).scale).toBe(1);
  });

  it('shrinks to fit a viewport too small for the host, on either axis', () => {
    expect(overlayGeometry({ x: 0, y: 0, z: 1 }, 900, VH, DEFAULT_METRICS).scale).toBeLessThan(1);
    expect(overlayGeometry({ x: 0, y: 0, z: 1 }, VW, 420, DEFAULT_METRICS).scale).toBeLessThan(1);
    // Still positive — a degenerate viewport must not produce a negative or NaN box.
    const tiny = overlayGeometry({ x: 0, y: 0, z: 1 }, 10, 10, DEFAULT_METRICS);
    expect(Number.isFinite(tiny.scale)).toBe(true);
    expect(tiny.rect.w).toBeGreaterThan(0);
  });

  it('stays centred on screen', () => {
    for (const vp of [{ x: 0, y: 0, z: 1 }, { x: -4000, y: 900, z: 2.2 }]) {
      const r = rendered(vp, VW, VH);
      expect(r.left).toBeCloseTo((VW - r.w) / 2, 6);
      expect(r.top).toBeCloseTo((VH - r.h) / 2, 6);
    }
  });

  // The reason the rect is divided by `z` at all. Pan and zoom must slide the world underneath
  // the overlay, not drag the overlay around with it.
  it('lands on identical screen geometry at any pan or zoom', () => {
    const base = rendered({ x: 0, y: 0, z: 1 }, VW, VH);
    for (const vp of [{ x: 700, y: -300, z: 1 }, { x: 0, y: 0, z: Z_MAX }, { x: -50, y: 12, z: 0.2 }]) {
      const r = rendered(vp, VW, VH);
      expect(r.w).toBeCloseTo(base.w, 6);
      expect(r.left).toBeCloseTo(base.left, 6);
    }
  });

  it('leaves the requested margin', () => {
    const r = rendered({ x: 0, y: 0, z: 1 }, HOST_W, 4000);
    expect(r.left).toBeCloseTo(OVERLAY_MARGIN, 6);
  });

  it('covers the whole viewport with the backdrop', () => {
    const vp: Viewport = { x: 133, y: -71, z: 1.7 };
    const { backdrop } = overlayGeometry(vp, VW, VH, DEFAULT_METRICS);
    const x0 = backdrop.x * vp.z + vp.x;
    const y0 = backdrop.y * vp.z + vp.y;
    expect(x0).toBeLessThanOrEqual(0);
    expect(y0).toBeLessThanOrEqual(0);
    expect(x0 + backdrop.w * vp.z).toBeGreaterThanOrEqual(VW);
    expect(y0 + backdrop.h * vp.z).toBeGreaterThanOrEqual(VH);
  });
});

/**
 * The size ladder, in Tam's words: "small zoom -> max zoom -> overlay -> regular tab", each one
 * bigger than the last.
 *
 * It was broken in the obvious way and for an unobvious reason. `Z_MAX` sat just ABOVE
 * `FOCUS_ZOOM` so that a focused node could reach the one zoom where xterm's pointer maths is
 * correct — which meant zooming all the way in gave a terminal LARGER than opening the overlay,
 * because the overlay is capped at 1:1. Two rungs collapsed into one and the third fell below
 * the second.
 *
 * These assertions are about apparent SIZE, reconstructed the way the DOM reconstructs it, and
 * they are what stops the two constants drifting back into that arrangement.
 */
describe('the zoom ladder is monotonic', () => {
  // A 1920x1040 canvas viewport: an ordinary maximised window on an ordinary display.
  const VW = 1920;
  const VH = 1040;

  /** Screen width of a default node at the canvas ceiling. */
  const maxZoomWidth = NODE_W * Z_MAX;
  /** ...and the scale its terminal renders at, which is what "how big is the text" means. */
  const maxZoomScale = SURFACE_SCALE * Z_MAX;

  it('makes the overlay bigger than the canvas can zoom', () => {
    const overlay = overlayGeometry({ x: 0, y: 0, z: Z_MAX }, VW, VH, DEFAULT_METRICS);
    expect(HOST_W * overlay.scale).toBeGreaterThan(maxZoomWidth);
    expect(overlay.scale).toBeGreaterThan(maxZoomScale);
  });

  // The rung above the overlay is the terminal's own tab, which is the viewport minus the tab
  // strip — no margin, no frame. The overlay must stay under it or it is not a rung either.
  it('leaves the overlay smaller than a full tab', () => {
    const overlay = overlayGeometry({ x: 0, y: 0, z: 1 }, VW, VH, DEFAULT_METRICS);
    expect(HOST_W * overlay.scale).toBeLessThan(VW);
  });

  it('holds at every canvas zoom, not just the ceiling', () => {
    for (const z of [Z_MIN, 0.5, 1, 2.5, Z_MAX]) {
      const overlay = overlayGeometry({ x: 0, y: 0, z }, VW, VH, DEFAULT_METRICS);
      expect(overlay.scale).toBeGreaterThanOrEqual(SURFACE_SCALE * z);
    }
  });

  // The reason the ceiling is below 1:1 at all, stated so that raising `Z_MAX` back over
  // `FOCUS_ZOOM` fails here with the ladder rather than somewhere visual.
  it('never lets the canvas reach the configured font size', () => {
    expect(maxZoomScale).toBeLessThan(1);
    expect(maxZoomScale).toBeGreaterThan(0.8);   // ...but close enough to be a working preview
  });

  it('reaches exactly the configured font size in the overlay', () => {
    expect(overlayGeometry({ x: 0, y: 0, z: 1 }, VW, VH, DEFAULT_METRICS).scale).toBe(1);
  });
});

/**
 * The host box is sized for the display the canvas opened on.
 *
 * It could not stay a constant. The same number is the grid the PTY gets AND the box the
 * overlay renders at 1:1, because `012` §6.5 RC2 allows a session exactly one host size — so
 * one value has to serve a 1366-wide laptop and a 4K panel at once, and it cannot. A fixed
 * 1600 left 2240 pixels unused on a 3840-wide display and broke the size ladder outright below
 * about 1500.
 *
 * These cases are DISPLAYS, not numbers: each one is a machine someone actually uses, and the
 * properties asserted are the ones that have to hold on all of them at once.
 */
describe('canvasMetrics', () => {
  // Real machines. A viewport smaller than a single node is covered by the degenerate case at
  // the end instead: there the host floor and the zoom floor both collapse to `NODE_W`, so the
  // ladder's rungs coincide rather than invert, and asserting a strict `>` there would be
  // asserting something the geometry cannot mean.
  const DISPLAYS: Array<[string, number, number]> = [
    ['13" laptop', 1366, 700],
    ['1080p maximised', 1920, 1040],
    ['1440p', 2560, 1400],
    ['4K at 150%', 2560, 1400],
    ['4K at 100%', 3840, 2120],
    ['ultrawide', 3440, 1400],
    ['a small window', 900, 600],
  ];

  /** What the overlay actually shows at scale 1 on this display, reconstructed. */
  const overlayWidth = (vw: number, vh: number) => {
    const m = canvasMetrics(vw, vh);
    return m.hostW * overlayGeometry({ x: 0, y: 0, z: 1 }, vw, vh, m).scale;
  };

  it.each(DISPLAYS)('%s: the overlay is bigger than the canvas can zoom', (_label, vw, vh) => {
    const m = canvasMetrics(vw, vh);
    // The ladder, on every display rather than on the one the constants were tuned for.
    // This is the property a fixed host box could not hold: below ~1500 wide the old ceiling
    // let a node zoom PAST the overlay, so "max zoom -> overlay" ran backwards.
    expect(overlayWidth(vw, vh)).toBeGreaterThan(NODE_W * m.zMax);
  });

  it.each(DISPLAYS)('%s: never magnifies past the configured font size', (_label, vw, vh) => {
    const m = canvasMetrics(vw, vh);
    expect(overlayGeometry({ x: 0, y: 0, z: 1 }, vw, vh, m).scale).toBeLessThanOrEqual(1);
    // ...and the canvas itself stops short of it, so the overlay is a real rung.
    expect(m.surfaceScale * m.zMax).toBeLessThan(1);
  });

  it.each(DISPLAYS)('%s: keeps the host box within its bounds and its aspect', (_label, vw, vh) => {
    const m = canvasMetrics(vw, vh);
    expect(m.hostW).toBeGreaterThanOrEqual(MIN_HOST_W);
    expect(m.hostW).toBeLessThanOrEqual(MAX_HOST_W);
    // A different aspect letterboxes every node — the host scales into the body by width.
    expect(m.hostH / m.hostW).toBeCloseTo(HOST_ASPECT, 2);
    expect(m.surfaceScale * m.focusZoom).toBeCloseTo(1, 9);
  });

  // The point of the change, stated as the comparison that motivated it.
  it('gives a 4K display a materially bigger host than a laptop', () => {
    expect(canvasMetrics(3840, 2120).hostW).toBeGreaterThan(canvasMetrics(1366, 700).hostW * 1.5);
  });

  it('fills a 1080p display at exactly 1:1', () => {
    const m = canvasMetrics(1920, 1040);
    expect(overlayGeometry({ x: 0, y: 0, z: 1 }, 1920, 1040, m).scale).toBe(1);
  });

  // The upper bound is a MEMORY budget, not a taste call: every node holds a host for the
  // session and up to MAX_GPU of them back it with a 4-byte-per-pixel WebGL canvas.
  it('caps the host on a very large display', () => {
    expect(canvasMetrics(7680, 4000).hostW).toBe(MAX_HOST_W);
  });

  // Below the floor the ceiling has to follow the OVERLAY down, not the clamped host — this
  // is the case where deriving zMax from `hostW` would silently reintroduce the inversion.
  it('lowers the zoom ceiling when the host box is clamped UP on a small window', () => {
    const m = canvasMetrics(900, 600);
    expect(m.hostW).toBe(MIN_HOST_W);                     // clamped up...
    expect(NODE_W * m.zMax).toBeLessThan(m.hostW);        // ...but the ceiling did not follow
    expect(overlayWidth(900, 600)).toBeGreaterThan(NODE_W * m.zMax);
  });

  it('is deterministic — the same display always gives the same box', () => {
    expect(canvasMetrics(1920, 1040)).toEqual(canvasMetrics(1920, 1040));
    expect(canvasMetrics(1920, 1040)).toEqual(DEFAULT_METRICS);
  });

  // A degenerate viewport must not produce a negative or NaN box: CanvasMode evaluates this
  // during its first render, before layout, so it can legitimately see nonsense.
  it('survives a degenerate viewport', () => {
    for (const [w0, h0] of [[0, 0], [-100, -100], [1, 1], [200, 150]]) {
      const m = canvasMetrics(w0, h0);
      expect(Number.isFinite(m.hostW)).toBe(true);
      expect(m.hostW).toBeGreaterThan(0);
      // At least 1, so a node is always reachable at its natural world size. Rounded from the
      // fit alone this is 0, and a zero ceiling does not fail loudly — `clampZoom` just pins
      // the canvas at `Z_MIN` forever, with no way to zoom in.
      expect(m.zMax).toBeGreaterThanOrEqual(1);
      // The ladder cannot invert even here, though its rungs may coincide.
      const w = m.hostW * overlayGeometry({ x: 0, y: 0, z: 1 }, w0, h0, m).scale;
      expect(w).toBeGreaterThanOrEqual(NODE_W * m.zMax);
    }
  });
});
