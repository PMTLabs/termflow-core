import { gridStyle, worldStyle, fitViewport, boundsOf, centreOn, FLY_MS, DOT_SPACING, easeOutCubic, lerpViewport } from '../viewportStyles';
import { Viewport, Rect, Z_MIN, Z_MAX, NODE_W, NODE_H } from '../canvasGeometry';

describe('worldStyle', () => {
  it('emits a translate-then-scale transform anchored at the origin', () => {
    const s = worldStyle({ x: 12, y: -8, z: 0.5 });
    expect(s.transform).toBe('translate(12px, -8px) scale(0.5)');
    expect(s.transformOrigin).toBe('0 0');
  });

  // The transform has to agree with canvasGeometry's own world->screen maths, or
  // hit-testing and painting disagree by a pan offset. translate-then-scale with
  // origin 0 0 means screen = world * z + pan, which is what worldToScreen does.
  it('agrees with the transform canvasGeometry uses for hit-testing', () => {
    const vp: Viewport = { x: 37, y: -14, z: 0.65 };
    const s = worldStyle(vp);
    expect(s.transform).toBe(`translate(${vp.x}px, ${vp.y}px) scale(${vp.z})`);
    expect(s.transformOrigin).toBe('0 0');
  });
});

describe('gridStyle', () => {
  it('scales the dot spacing with zoom and tracks the pan', () => {
    const s = gridStyle({ x: 30, y: 40, z: 2 });
    expect(s.backgroundSize).toBe(`${DOT_SPACING * 2}px ${DOT_SPACING * 2}px`);
    expect(s.backgroundPosition).toBe('30px 40px');
  });

  it('never emits a zero or negative spacing', () => {
    const s = gridStyle({ x: 0, y: 0, z: Z_MIN });
    const px = parseFloat(String(s.backgroundSize).split('px')[0]);
    expect(px).toBeGreaterThan(0);
  });

  // A CSS backgroundSize of 0 stops the browser tiling entirely — the grid
  // disappears rather than getting denser. Assert across the whole legal range,
  // not just the endpoints.
  it('stays positive at every legal zoom', () => {
    for (let z = Z_MIN; z <= Z_MAX; z += 0.05) {
      const px = parseFloat(String(gridStyle({ x: 0, y: 0, z }).backgroundSize).split('px')[0]);
      expect(px).toBeGreaterThan(0);
    }
  });
});

describe('boundsOf', () => {
  it('returns null for no rects', () => {
    expect(boundsOf([])).toBeNull();
  });
  it('spans every rect', () => {
    const b = boundsOf([
      { x: 10, y: 20, w: 100, h: 100 },
      { x: 200, y: 5, w: 50, h: 50 },
    ])!;
    expect(b).toEqual({ x: 10, y: 5, w: 240, h: 115 });
  });
  it('handles negative coordinates and a single rect', () => {
    expect(boundsOf([{ x: -50, y: -30, w: 10, h: 10 }])).toEqual({ x: -50, y: -30, w: 10, h: 10 });
  });
});

describe('centreOn', () => {
  it('puts the target rect dead centre at the requested zoom', () => {
    const vp = centreOn({ x: 500, y: 300, w: NODE_W, h: NODE_H }, 800, 600, 1.2);
    expect((500 + NODE_W / 2) * vp.z + vp.x).toBeCloseTo(400, 6);
    expect((300 + NODE_H / 2) * vp.z + vp.y).toBeCloseTo(300, 6);
    expect(vp.z).toBeCloseTo(1.2, 6);
  });
  it('clamps the requested zoom', () => {
    expect(centreOn({ x: 0, y: 0, w: 10, h: 10 }, 800, 600, 99).z).toBe(Z_MAX);
    expect(centreOn({ x: 0, y: 0, w: 10, h: 10 }, 800, 600, 0.0001).z).toBe(Z_MIN);
  });
  // Centring must still centre after the clamp bites, or a fly-to to a clamped
  // zoom lands off-target.
  it('still centres the target when the zoom was clamped', () => {
    const target: Rect = { x: 900, y: -400, w: NODE_W, h: NODE_H };
    const vp = centreOn(target, 800, 600, 99);
    expect((target.x + target.w / 2) * vp.z + vp.x).toBeCloseTo(400, 6);
    expect((target.y + target.h / 2) * vp.z + vp.y).toBeCloseTo(300, 6);
  });
});

describe('FLY_MS', () => {
  it('is a single shared duration, so every fly-to feels the same', () => {
    expect(FLY_MS).toBeGreaterThan(150);
    expect(FLY_MS).toBeLessThan(600);
  });
});

describe('fitViewport', () => {
  const bounds: Rect = { x: 100, y: 100, w: 1000, h: 500 };

  it('centres the bounds in the viewport', () => {
    const vp = fitViewport(bounds, 800, 600);
    const cx = (bounds.x + bounds.w / 2) * vp.z + vp.x;
    const cy = (bounds.y + bounds.h / 2) * vp.z + vp.y;
    expect(cx).toBeCloseTo(400, 6);
    expect(cy).toBeCloseTo(300, 6);
  });

  it('fits entirely within the viewport', () => {
    const vp = fitViewport(bounds, 800, 600);
    expect(bounds.w * vp.z).toBeLessThanOrEqual(800);
    expect(bounds.h * vp.z).toBeLessThanOrEqual(600);
  });

  it('respects the zoom clamp for an enormous workspace', () => {
    const vp = fitViewport({ x: 0, y: 0, w: 500000, h: 500000 }, 800, 600);
    expect(vp.z).toBe(Z_MIN);
  });

  it('never zooms past the maximum for a tiny workspace', () => {
    const vp = fitViewport({ x: 0, y: 0, w: 10, h: 10 }, 800, 600);
    expect(vp.z).toBeLessThanOrEqual(Z_MAX);
  });

  // Fitting a tall-and-narrow set must be driven by the constraining axis. With
  // only the wide case tested, a fit that used width alone would pass.
  it('fits the constraining axis, whichever it is', () => {
    const tall = fitViewport({ x: 0, y: 0, w: 100, h: 4000 }, 800, 600);
    expect(4000 * tall.z).toBeLessThanOrEqual(600);
    const wide = fitViewport({ x: 0, y: 0, w: 4000, h: 100 }, 800, 600);
    expect(4000 * wide.z).toBeLessThanOrEqual(800);
  });

  // A canvas with a single node still has to be fittable — the margin must not
  // invert the arithmetic or push the zoom to the floor.
  it('produces a sane zoom for one node', () => {
    const vp = fitViewport({ x: 0, y: 0, w: NODE_W, h: NODE_H }, 1200, 800);
    expect(vp.z).toBeGreaterThan(Z_MIN);
    expect(vp.z).toBeLessThanOrEqual(Z_MAX);
  });
});

describe('easeOutCubic', () => {
  it('starts at 0, ends at 1, and decelerates', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5); // past halfway at the midpoint
  });

  // The animation loop computes progress from a clock, and a dropped frame or a
  // clock jump can hand it a value outside 0..1. Landing past the target and
  // springing back reads as a glitch.
  it('clamps out-of-range progress instead of overshooting', () => {
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
  });

  it('is monotonic', () => {
    let prev = -1;
    for (let k = 0; k <= 1.0001; k += 0.05) {
      const v = easeOutCubic(k);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe('lerpViewport', () => {
  const from: Viewport = { x: 0, y: 0, z: 1 };
  const to: Viewport = { x: 100, y: -200, z: 0.5 };

  it('returns the endpoints exactly', () => {
    expect(lerpViewport(from, to, 0)).toEqual(from);
    expect(lerpViewport(from, to, 1)).toEqual(to);
  });

  // A fly-to that ends anywhere but exactly `to` leaves the viewport a fraction
  // off target, and the error accumulates over repeated flights.
  it('lands exactly on the target even when progress overshoots', () => {
    expect(lerpViewport(from, to, 1.4)).toEqual(to);
  });

  it('interpolates all three axes together', () => {
    const mid = lerpViewport(from, to, 0.5);
    expect(mid.x).toBeGreaterThan(0);
    expect(mid.y).toBeLessThan(0);
    expect(mid.z).toBeLessThan(1);
    expect(mid.z).toBeGreaterThan(0.5);
  });
});
