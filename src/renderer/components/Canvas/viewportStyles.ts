import type React from 'react';
import { Rect, Viewport, clampZoom, worldRaster } from './canvasGeometry';

/** World-space distance between dots at zoom 1. */
export const DOT_SPACING = 26;
/** Breathing room left around the content when fitting. */
export const FIT_MARGIN = 140;

/**
 * The pan-and-zoom transform, on `.canvas-world`.
 *
 * `scale(z / R)` rather than `scale(z)`, and the missing factor of R is put back by
 * `rasterStyle` on the element inside — see `worldRaster` for why the world is laid out large
 * and scaled down instead of laid out small and scaled up. The PRODUCT is `z`, so every other
 * number in the canvas is untouched: `worldPoint`'s inverse, `worldToScreen`, the counter-scales
 * and every `getBoundingClientRect` inside the world all still see `screen = world * z + pan`.
 *
 * The two halves must be read from the same `dpr` — split them and the world paints at a
 * different zoom from the one the pointer maths uses. That is what `viewportStyles.test.ts`
 * pins as a product, rather than asserting either half alone.
 */
export function worldStyle(vp: Viewport, dpr: number): React.CSSProperties {
  return {
    transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.z / worldRaster(vp.z, dpr)})`,
    transformOrigin: '0 0',
  };
}

/**
 * The supersample, on `.canvas-raster` — the element between `.canvas-world` and the nodes.
 *
 * `zoom` rather than a second `transform`, because a transform would only nest one raster
 * magnification inside another; `zoom` multiplies the USED VALUE of every length in the subtree,
 * so the content is laid out — and therefore rasterised — R times larger.
 *
 * It is deliberately on a child rather than on `.canvas-world` itself: `zoom` scales the
 * element's own transform lengths too, which would multiply the pan by R.
 *
 * **Why this is safe for a live terminal.** `plan/017`'s whole guarantee is that
 * `FitAddon.proposeDimensions()` reads the same host box on the canvas as it did in the pane, so
 * the fit finds nothing to do and no SIGWINCH reaches the PTY. `zoom` does not disturb it:
 * measured in this WebKit, an 800px box under `zoom: 3` reports `getComputedStyle().width` of
 * 800px (and `offsetWidth`/`clientWidth` of 800) while `getBoundingClientRect()` reports the
 * magnified 2400 — so the four things `proposeDimensions` reads are unchanged, and the screen
 * geometry every gesture measures is unchanged too.
 */
export function rasterStyle(vp: Viewport, dpr: number): React.CSSProperties {
  return { zoom: worldRaster(vp.z, dpr) };
}

/**
 * The dot matrix is one element painted with a repeating radial gradient — an
 * "infinite" grid for a single paint. Spacing scales with zoom so the grid also
 * reads as a ruler.
 *
 * The `Math.max(1, ...)` floor is load-bearing rather than cosmetic: a CSS
 * `background-size` of 0 stops the browser tiling altogether, so at deep zoom
 * the grid would vanish instead of getting denser.
 */
export function gridStyle(vp: Viewport): React.CSSProperties {
  const s = Math.max(1, DOT_SPACING * vp.z);
  const alpha = Math.min(0.11, 0.05 + vp.z * 0.05);
  return {
    backgroundImage: `radial-gradient(circle, rgba(255,255,255,${alpha.toFixed(3)}) 1px, transparent 1px)`,
    backgroundSize: `${s}px ${s}px`,
    backgroundPosition: `${vp.x}px ${vp.y}px`,
  };
}

export function boundsOf(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Zoom and pan so `bounds` sits centred and entirely visible. `zMax` is the SESSION ceiling
 *  (see `canvasMetrics`), passed rather than read, so this stays a pure function. */
export function fitViewport(bounds: Rect, vw: number, vh: number, zMax: number): Viewport {
  const z = clampZoom(Math.min(vw / (bounds.w + FIT_MARGIN), vh / (bounds.h + FIT_MARGIN)), zMax);
  return {
    z,
    x: vw / 2 - (bounds.x + bounds.w / 2) * z,
    y: vh / 2 - (bounds.y + bounds.h / 2) * z,
  };
}

/** Centre a target at a chosen zoom, without fitting it. The destination for every
 *  fly-to: sidebar row click, tab click, chip click, beacon click. */
export function centreOn(target: Rect, vw: number, vh: number, z: number, zMax: number): Viewport {
  const zz = clampZoom(z, zMax);
  return {
    z: zz,
    x: vw / 2 - (target.x + target.w / 2) * zz,
    y: vh / 2 - (target.y + target.h / 2) * zz,
  };
}

/** One shared duration so every fly-to in the app feels identical. */
export const FLY_MS = 300;

/** Decelerating ease for fly-to. Pulled out of the animation loop so the curve is
 *  testable — this repo has no component-test harness, so anything left inside a
 *  hook is unverifiable by construction. */
export function easeOutCubic(k: number): number {
  const t = Math.min(1, Math.max(0, k));
  return 1 - Math.pow(1 - t, 3);
}

/** Interpolate a viewport. `k` is the RAW progress 0..1; the easing is applied here
 *  so every caller gets the same curve. */
export function lerpViewport(from: Viewport, to: Viewport, k: number): Viewport {
  const e = easeOutCubic(k);
  return {
    x: from.x + (to.x - from.x) * e,
    y: from.y + (to.y - from.y) * e,
    z: from.z + (to.z - from.z) * e,
  };
}
