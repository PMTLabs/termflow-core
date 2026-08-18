import { createContext, useContext } from 'react';
import type { CanvasMetrics } from './canvasGeometry';

/**
 * The metrics of the CURRENT canvas session — the host box the display got, and the zoom
 * ceiling derived from it (see `canvasMetrics`).
 *
 * Context rather than props because these are read at three unrelated depths — the viewport's
 * wheel handler, every node, every group frame — and threading one frozen object through all
 * of them as a prop would be noise at every level between.
 *
 * **The default is `null`, not `DEFAULT_METRICS`.** A component that renders outside the
 * provider is a bug, and a plausible-looking fallback would hide it: the canvas would come up
 * sized for a 1080p display on a 4K panel, which reads as a design choice rather than a missing
 * provider. `012` §6.5 RC2 makes this worse than cosmetic — the host box is the box a live
 * terminal is fitted to, so a second, disagreeing value is a `term.resize()` and a SIGWINCH.
 */
export const CanvasMetricsContext = createContext<CanvasMetrics | null>(null);

export function useCanvasMetrics(): CanvasMetrics {
  const m = useContext(CanvasMetricsContext);
  if (!m) throw new Error('useCanvasMetrics: no CanvasMetricsContext — render inside CanvasMode');
  return m;
}
