import { gridStyle, worldStyle, rasterStyle, fitViewport, boundsOf, centreOn, FLY_MS, DOT_SPACING, easeOutCubic, lerpViewport } from '../viewportStyles';
import { Viewport, Rect, Z_MIN, NODE_W, NODE_H, DEFAULT_METRICS, MAX_WORLD_R, worldRaster } from '../canvasGeometry';

// Per-session now — an ordinary 1080p display's ceiling.
const { zMax: Z_MAX } = DEFAULT_METRICS;

/** The scale factor out of a `translate(...) scale(k)` transform. */
const scaleOf = (transform: string | undefined): number =>
  Number(/scale\(([-\d.e]+)\)/.exec(transform ?? '')?.[1]);

describe('worldStyle', () => {
  it('emits a translate-then-scale transform anchored at the origin', () => {
    const s = worldStyle({ x: 12, y: -8, z: 0.5 }, 1);
    expect(s.transform).toBe('translate(12px, -8px) scale(0.5)');
    expect(s.transformOrigin).toBe('0 0');
  });

  // The transform has to agree with canvasGeometry's own world->screen maths, or
  // hit-testing and painting disagree by a pan offset. translate-then-scale with
  // origin 0 0 means screen = world * z + pan, which is what worldToScreen does.
  it('agrees with the transform canvasGeometry uses for hit-testing', () => {
    const vp: Viewport = { x: 37, y: -14, z: 0.65 };
    const s = worldStyle(vp, 1);
    expect(s.transform).toBe(`translate(${vp.x}px, ${vp.y}px) scale(${vp.z})`);
    expect(s.transformOrigin).toBe('0 0');
  });

  // Below zoom 1 there is nothing to supersample: the world is already being drawn smaller
  // than it is laid out, so R stays 1 and this is the transform it has always emitted.
  it('leaves the transform alone while the world is being shrunk', () => {
    expect(scaleOf(worldStyle({ x: 0, y: 0, z: Z_MIN }, 1).transform)).toBe(Z_MIN);
    expect(rasterStyle({ x: 0, y: 0, z: Z_MIN }, 1).zoom).toBe(1);
  });

  // The pan is NOT divided by R. It is applied outside the `zoom`ed element, in screen pixels,
  // which is the whole reason the zoom sits on a child — dividing it here would be the same bug
  // in the other direction, and it is exact at pan (0, 0), where it is easiest to test.
  it('keeps the pan in screen pixels when the world is supersampled', () => {
    const s = worldStyle({ x: 40, y: -25, z: 2.5 }, 1);
    expect(s.transform).toContain('translate(40px, -25px)');
  });
});

// THE invariant of the split: whatever R is, the world must still paint at exactly `z`.
// Asserted as the PRODUCT, never as either half, because either half alone passes while the
// two disagree — and a world painting at a different zoom from the one `worldPoint` inverts
// puts every node under the cursor somewhere it is not.
describe('worldStyle x rasterStyle', () => {
  it('multiplies back to the zoom at every zoom and device scale', () => {
    for (const dpr of [1, 1.5, 2, 3]) {
      for (const z of [Z_MIN, 0.3, 0.99, 1, 1.01, 1.35, 2, 2.5, 3, Z_MAX, MAX_WORLD_R + 1]) {
        const vp: Viewport = { x: 7, y: 9, z };
        const net = scaleOf(worldStyle(vp, dpr).transform) * (rasterStyle(vp, dpr).zoom as number);
        expect(net).toBeCloseTo(z, 10);
      }
    }
  });

  // The criterion the whole change exists to satisfy: `R * dpr >= z` — never fewer device
  // pixels in the backing store than the CSS pixels being painted from it. Asserted as that
  // inequality rather than as `scale <= 1`, which is the DPR-1 special case and passes a
  // Retina panel that is quietly two device pixels short.
  it('keeps at least one backing device pixel per painted CSS pixel', () => {
    for (const dpr of [1, 1.5, 2, 3]) {
      for (const z of [Z_MIN, 0.99, 1, 1.01, 1.35, 2, 2.5, 3, Z_MAX]) {
        expect(worldRaster(z, dpr) * dpr).toBeGreaterThanOrEqual(z);
      }
    }
  });

  // At DPR 1 that criterion means the raster is never stretched AT ALL — a magnified raster is
  // what macOS WebKit gives back blurred, and DPR 1 is the display the bug was reported on.
  it('never stretches the raster on a non-Retina display', () => {
    for (const z of [1, 1.01, 1.35, 2, 2.5, 3, Z_MAX]) {
      expect(scaleOf(worldStyle({ x: 0, y: 0, z }, 1).transform)).toBeLessThanOrEqual(1);
    }
    // Past `MAX_WORLD_R` the clamp bites and it degrades to what it always did, rather than
    // eating memory. `zMax` never reaches there — this pins where the boundary is.
    expect(Z_MAX).toBeLessThan(MAX_WORLD_R);
    expect(scaleOf(worldStyle({ x: 0, y: 0, z: MAX_WORLD_R + 5 }, 1).transform)).toBeGreaterThan(1);
  });

  // The device scale is divided out, not ignored: a Retina panel meets the same criterion with
  // a quarter of the backing store, so it must not buy supersampling it cannot resolve.
  it('does not supersample what the device scale already covers', () => {
    expect(worldRaster(1.35, 2)).toBe(1);
    expect(worldRaster(1.35, 1)).toBe(2);
    expect(rasterStyle({ x: 0, y: 0, z: 1.35 }, 2).zoom).toBe(1);
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
    const vp = centreOn({ x: 500, y: 300, w: NODE_W, h: NODE_H }, 800, 600, 1.2, Z_MAX);
    expect((500 + NODE_W / 2) * vp.z + vp.x).toBeCloseTo(400, 6);
    expect((300 + NODE_H / 2) * vp.z + vp.y).toBeCloseTo(300, 6);
    expect(vp.z).toBeCloseTo(1.2, 6);
  });
  it('clamps the requested zoom', () => {
    expect(centreOn({ x: 0, y: 0, w: 10, h: 10 }, 800, 600, 99, Z_MAX).z).toBe(Z_MAX);
    expect(centreOn({ x: 0, y: 0, w: 10, h: 10 }, 800, 600, 0.0001, Z_MAX).z).toBe(Z_MIN);
  });
  // Centring must still centre after the clamp bites, or a fly-to to a clamped
  // zoom lands off-target.
  it('still centres the target when the zoom was clamped', () => {
    const target: Rect = { x: 900, y: -400, w: NODE_W, h: NODE_H };
    const vp = centreOn(target, 800, 600, 99, Z_MAX);
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
    const vp = fitViewport(bounds, 800, 600, Z_MAX);
    const cx = (bounds.x + bounds.w / 2) * vp.z + vp.x;
    const cy = (bounds.y + bounds.h / 2) * vp.z + vp.y;
    expect(cx).toBeCloseTo(400, 6);
    expect(cy).toBeCloseTo(300, 6);
  });

  it('fits entirely within the viewport', () => {
    const vp = fitViewport(bounds, 800, 600, Z_MAX);
    expect(bounds.w * vp.z).toBeLessThanOrEqual(800);
    expect(bounds.h * vp.z).toBeLessThanOrEqual(600);
  });

  it('respects the zoom clamp for an enormous workspace', () => {
    const vp = fitViewport({ x: 0, y: 0, w: 500000, h: 500000 }, 800, 600, Z_MAX);
    expect(vp.z).toBe(Z_MIN);
  });

  it('never zooms past the maximum for a tiny workspace', () => {
    const vp = fitViewport({ x: 0, y: 0, w: 10, h: 10 }, 800, 600, Z_MAX);
    expect(vp.z).toBeLessThanOrEqual(Z_MAX);
  });

  // Fitting a tall-and-narrow set must be driven by the constraining axis. With
  // only the wide case tested, a fit that used width alone would pass.
  it('fits the constraining axis, whichever it is', () => {
    const tall = fitViewport({ x: 0, y: 0, w: 100, h: 4000 }, 800, 600, Z_MAX);
    expect(4000 * tall.z).toBeLessThanOrEqual(600);
    const wide = fitViewport({ x: 0, y: 0, w: 4000, h: 100 }, 800, 600, Z_MAX);
    expect(4000 * wide.z).toBeLessThanOrEqual(800);
  });

  // A canvas with a single node still has to be fittable — the margin must not
  // invert the arithmetic or push the zoom to the floor.
  it('produces a sane zoom for one node', () => {
    const vp = fitViewport({ x: 0, y: 0, w: NODE_W, h: NODE_H }, 1200, 800, Z_MAX);
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
