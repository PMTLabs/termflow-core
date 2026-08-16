import {
  baseTier, clampZoom, zoomAt, screenToWorld, worldToScreen, isVisible, assignTiers,
  NODE_W, NODE_H, T_GPU, T_LIVE, T_SNAP, T_CHIP, MAX_GPU, MAX_INTERACTIVE,
  Z_MIN, Z_MAX, Viewport, Rect,
} from '../canvasGeometry';

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
    expect(clampZoom(0.001)).toBe(Z_MIN);
    expect(clampZoom(99)).toBe(Z_MAX);
    expect(clampZoom(1)).toBe(1);
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

describe('zoomAt', () => {
  it('keeps the point under the cursor fixed', () => {
    const vp: Viewport = { x: 40, y: -25, z: 0.7 };
    const cx = 320, cy = 180;
    const before = screenToWorld(vp, cx, cy);
    const after = screenToWorld(zoomAt(vp, 1.4, cx, cy), cx, cy);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it('does not move the viewport when the zoom is already clamped', () => {
    const vp: Viewport = { x: 10, y: 10, z: Z_MAX };
    expect(zoomAt(vp, 2, 100, 100)).toEqual(vp);
  });

  // A factor that overshoots the clamp must still land ON the clamp, not be
  // rejected as "already clamped" — otherwise a fast wheel gesture from 1.5x
  // would refuse to reach Z_MAX at all.
  it('lands exactly on the clamp when the factor overshoots it', () => {
    const vp: Viewport = { x: 10, y: 10, z: 1.5 };
    expect(zoomAt(vp, 100, 100, 100).z).toBe(Z_MAX);
    expect(zoomAt(vp, 0.0001, 100, 100).z).toBe(Z_MIN);
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
